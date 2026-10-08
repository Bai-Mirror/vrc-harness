import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync, rmSync, statSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';
import { ApiClient } from '../api/client.ts';
import { loadConfig } from '../config.ts';
import { configBackups, configProblem, restoreNewestLoadableBackup, setAsideConfig } from '../config-recovery.ts';
import { ServiceManager } from '../service/manager.ts';
import { hostPlatform } from '../host-platform.ts';
import { configDocument, findProfiles, scanEnvironment } from '../tui/setup.ts';
import { bundledPackInfo, installBundledPack } from '../managed-pack.ts';
import { findUnityEditors, unityEditorProblem } from '../unity-editors.ts';
import { dependencyStatus, installPlan, runInstallPlanAsync } from '../environment.ts';
import { secretMethod } from '../providers/secrets.ts';
import { claudeLoginStatus, openSetupTokenWindow } from './claude-login.ts';
import { pickPathOnHost, pickRequest } from './picker.ts';
import { OPEN_TARGETS, openTarget, probeWindowsMachine, runWindowsSetup, setupChoices, windowsSetupPlan, type OpenTarget, type SetupJob } from '../windows-setup.ts';
import { piChoices } from '../shared/pi.ts';
import { GuiRuntimeConnection } from './runtime-connection.ts';

const TYPES: Record<string,string> = { '.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.json':'application/json' };
/**
 * The Runtime methods a GUI page may call through this server (setup.* are handled here).
 *
 * This list is the capability the interface actually reaches, not the Runtime's whole surface, so it names only methods
 * a page calls: the audit of methods without a consumer (docs/zh/工作区/证据/界面能力面审计.md) found entries here that
 * no page used, and an allow-list carrying them reads as "supported" beyond what the interface can do. Removing an
 * entry does not remove the Runtime method; a page that needs one again gets it back in a line. A method used only by
 * the terminal or the CLI is deliberately absent, and test/gui/methods.test.ts fails if an unconsumed entry returns.
 */
export const GUI_METHODS = new Set(['project.production.delivery','project.production.versions','project.production.continuation.resume','project.production.continuation.cancel','hello','service.status','service.pause','service.resume','config.reload','config.view','config.update','managed.list','managed.candidate.list','managed.candidate.evaluate','managed.candidate.authoring.list','managed.candidate.authoring.create','managed.candidate.trial.list','managed.candidate.trial.approve','managed.contribution.list','managed.contribution.preview','managed.contribution.authorize','managed.contribution.submit','managed.contribution.trace','sharing.state','sharing.notice','sharing.choose','sharing.flush','sharing.remoteStatus','sharing.revoke','managed.installBuiltin','managed.activate','doctor.run','provider.list','project.list','project.create','project.import','project.recovery.list','project.recovery.apply','project.recovery.adoptAssets','project.vpm.status','project.vpm.apply','project.upload.open','project.brief.get','project.brief.update','project.context','project.variant.list','project.variant.save','project.variant.remove','project.root.list','project.root.save','project.message.list','project.message.add','project.asset.list','project.asset.attach','project.asset.detach','asset.list','asset.save','asset.remove','booth.status','booth.session.clear','secret.status','secret.set','secret.clear','booth.sync','booth.catalog','booth.plan.create','booth.plan.materialize','project.variant.asset.list','project.variant.asset.attach','project.variant.asset.detach','workflow.show','workflow.context.preview','workflow.context.diff','context.telemetry','workflow.create','workflow.cancel','plan.show','task.list','task.show','task.redo','task.cancel','task.acceptChanges','task.recover','gate.list','gate.decide','events.recent','update.check','knowledge.check','knowledge.install','project.facts','project.fact.confirm','project.archive.refresh',
  'project.files.classify','project.share.preview','project.share.export','project.share.list','project.archive.job','project.restore.check','project.restore',
  'project.restore.report','project.restore.complete',
  'project.diagnostics.preview','project.diagnostics.export',
  'project.message.retry','project.intent.list','project.production.list','project.production.approve','project.production.reject','project.production.resume','project.production.cancel',
  'project.maintenance.show','project.maintenance.adopt',
  'asset.sources.list','asset.sources.grant','asset.sources.revoke','project.face.preview','project.face.preview.image','project.face.preview.images',
  'project.face.candidates.preview','project.face.candidates.preview.image','project.face.choose','project.face.accept',
  'project.recolor.preview','project.recolor.preview.images','project.delivery.photos','project.delivery.photos.images',
  'project.face.mode','project.face.manual.state','project.face.manual.open','project.face.manual.launch','project.face.manual.done',
  'project.face.manual.cancel','project.face.manual.resume','project.face.manual.rollback',
  'project.production.continuation.contracts','project.production.continuation.contract.view','project.production.continuation.contract.adopt','project.production.continuation.changes.resolve',
  // A warning reading the person accepts from the stage detail; it is not a Gate and never rewrites the Verdict.
  'warning.accept']);

/**
 * Who answers a GUI call: the GUI host itself for first run and environment work (`setup.*`), the Runtime for the
 * versioned API methods. First run asks for AI credentials before a configuration exists, and the Runtime does not start
 * without one, so until then the credential methods are served here, on the same files (providers/secrets.ts).
 */
export function guiRoute(method: string, configured: boolean): 'setup' | 'secret' | 'runtime' | 'refused' {
  if (method.startsWith('setup.')) return 'setup';
  if (!GUI_METHODS.has(method)) return 'refused';
  return method.startsWith('secret.') && !configured ? 'secret' : 'runtime';
}
function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff' });
  response.end(JSON.stringify(body));
}
function authorized(value: string | string[] | undefined, token: string): boolean {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (!candidate) return false;
  const a=Buffer.from(candidate), b=Buffer.from(token); return a.length===b.length && timingSafeEqual(a,b);
}

/** A Chromium browser that can open the GUI as an app window on Windows: Edge, which Windows always has, then Chrome. */
export function windowsAppBrowser(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const roots = [env['ProgramFiles(x86)'], env.ProgramFiles, env.LOCALAPPDATA].filter((root): root is string => !!root);
  return [...roots.map(root => join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe')),
    ...roots.map(root => join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'))].find(path => existsSync(path));
}

/** Local GUI host: loopback only, random session token, and versioned Runtime API methods only. */
export async function runGui(home: string, options: { open?: boolean; port?: number; /** Test-only deterministic browser session. */ sessionToken?: string; nativeToken?: string;
  signal?:AbortSignal; onReady?:(url:string)=>void } = {}): Promise<void> {
  const manager = new ServiceManager(home);
  const streams=new Set<ServerResponse>();
  const connection = new GuiRuntimeConnection(async () => ApiClient.connect(home,1000), async () => {
    if (!(await manager.status()).running) await manager.start(1000);
  }, event => {for(const stream of streams)stream.write(`data: ${JSON.stringify(event)}\n\n`);});
  const connect = (): Promise<ApiClient> => connection.get();
  const configPath=join(home,'config','harness.yaml');
  // A configuration that no longer loads must not leave a blank window: the GUI still opens, says why, and offers a
  // backup or a fresh first run (config-recovery.ts).
  let broken=configProblem(home);
  // A service that does not start is not a broken configuration: the GUI opens anyway, and each call retries it.
  if (existsSync(configPath)&&!broken) { try { await connect(); } catch (error) { console.error(`Runtime 服务没有启动：${(error as Error).message}`); } }

  const token=options.sessionToken??randomBytes(24).toString('base64url');
  const nativeToken=options.nativeToken??randomBytes(24).toString('base64url');
  const moduleDir=dirname(fileURLToPath(import.meta.url));
  const builtRoot=join(moduleDir,'../gui-app');
  const root=existsSync(join(builtRoot,'index.html'))?builtRoot:join(moduleDir,'../../dist/gui-app');
  if (!existsSync(join(root,'index.html'))) throw new Error('GUI 静态文件不存在；请先运行 npm run build');
  // Windows machine setup runs here, in the person's session, where the UAC prompt can appear; the GUI follows it.
  let setupJob: SetupJob | undefined;
  const setup = async (method: string, params: Record<string,unknown>): Promise<unknown> => {
    if (method==='setup.config.restore') {
      if (!broken||!existsSync(configPath)) throw new Error('当前配置可以加载，不需要恢复');
      const restored=restoreNewestLoadableBackup(home);broken=undefined;await connect();return restored;
    }
    if (method==='setup.config.reset') {
      if (!broken||!existsSync(configPath)) throw new Error('当前配置可以加载，不会移开');
      const aside=setAsideConfig(home);broken=undefined;return {keptAs:aside};
    }
    if (method==='setup.status') { const configured=existsSync(configPath)&&!broken;
      const workspaceRoot=join(homedir(),'avatar-workspace');
      // Every editor found is offered as a choice (first run and settings); the first one is preselected.
      const unityEditors=findUnityEditors();
      return { configured, home, ...(broken?{broken,backups:configBackups(home)}:{}),
        defaults: { workspaceRoot, exportRoot: join(homedir(),'avatar-exports'),
          assetLibraryRoot: join(home,'materialized','assets'),
          templateProject: process.env.AVH_TEMPLATE_PROJECT??'',
          unityEditor: unityEditors[0]??'', unityEditors,
          managedPack: bundledPackInfo()??null },
        environment: configured ? [] : scanEnvironment() }; }
    // A browser has no file dialog of its own that yields a path: the host shows the system one (picker.ts).
    if (method==='setup.pickPath') return {path:await pickPathOnHost(pickRequest(params))};
    // Claude Code on Windows signs in with a token the person gets in a console window of its own (claude-login.ts).
    if (method==='setup.claude.status') return claudeLoginStatus();
    if (method==='setup.claude.setupToken') return openSetupTokenWindow();
    // Environment checks and installs run here, in the person's session: polkit can ask them for the password.
    if (method==='setup.environment.progress') return {job:setupJob??null};
    if (method==='setup.environment.open') {
      if (process.platform!=='win32') throw new Error('这个操作只在 Windows 上可用');
      if (!OPEN_TARGETS.includes(params.target as OpenTarget)) throw new Error('未知的操作');
      return openTarget(params.target as OpenTarget);
    }
    if (method==='setup.environment'||method==='setup.environment.install') {
      let config: ReturnType<typeof loadConfig>|undefined;
      try{if(existsSync(configPath))config=loadConfig(home);}catch{/* A broken configuration still lets dependencies be checked. */}
      if (process.platform==='win32') {
        const dependencies=dependencyStatus(config);
        const plan=windowsSetupPlan(dependencies,probeWindowsMachine(dependencies,config));
        if (method==='setup.environment.install') {
          if (setupJob?.state==='running') throw new Error('配置正在进行，请等它结束');
          // The job reports its first state before its first await, so the answer already carries it.
          void runWindowsSetup(plan,setupChoices(params.choices),{dryRun:params.dryRun===true,onUpdate:job=>{setupJob=job;}})
            .catch(error=>{if(setupJob)setupJob={...setupJob,state:'failed',phase:'done',note:(error as Error).message};});
        }
        return {dependencies,plan:installPlan(dependencies),windows:{plan,job:setupJob??null},unityEditor:findUnityEditors()[0]??''};
      }
      const results=method==='setup.environment.install'?await runInstallPlanAsync(installPlan(dependencyStatus(config))):undefined;
      const dependencies=dependencyStatus(config);
      return {dependencies,plan:installPlan(dependencies),...(results?{results}:{}),unityEditor:findUnityEditors()[0]??''};
    }
    if (method!=='setup.initialize') throw new Error('未知初始化方法');
    if (existsSync(configPath)) throw new Error('配置已经存在，不会从向导覆盖');
    const path = (key: string, create: boolean): string => { const value=params[key]; if(typeof value!=='string'||!value.trim())throw new Error(`${key} 不能为空`);const result=resolve(value);if(!isAbsolute(result))throw new Error(`${key} 必须是绝对路径`);if(!existsSync(result)){if(!create)throw new Error(`${key} 不存在：${result}`);hostPlatform.mkdirPrivate(result);}if(!statSync(result).isDirectory())throw new Error(`${key} 不是目录`);return result; };
    const workspaceRoot=path('workspaceRoot',true), exportRoot=path('exportRoot',true);
    // BOOTH is index-first and materializes only files selected for active work. This is Harness-owned cache,
    // never a user-maintained full archive. Local non-BOOTH assets are indexed by their individual paths.
    const assetLibraryRoot=join(home,'materialized','assets');hostPlatform.mkdirPrivate(assetLibraryRoot);
    // Advanced override only. The bundled production flow prepares its own pinned environment by default.
    const templateProject=typeof params.templateProject==='string'&&params.templateProject.trim()?path('templateProject',false):'';
    const unityEditor=typeof params.unityEditor==='string'?params.unityEditor.trim():'';
    if(unityEditor){const problem=unityEditorProblem(unityEditor);if(problem)throw new Error(problem);}
    const {knowledgeRoot,toolRoot}=installBundledPack(home);
    const found=findProfiles(knowledgeRoot); if(!found.profiles.length||!found.thresholds)throw new Error('知识层 process/ 中缺少 *.process.yaml 或 thresholds.yaml');
    const defaultProfile=found.profiles.find(profile=>profile.capabilities)?.id??found.profiles[0]!.id;
    for(const name of ['config','state','reports','runs'])hostPlatform.mkdirPrivate(join(home,name));
    const document=configDocument({workspaceRoot,knowledgeRoot,toolRoot,exportRoot,assetLibraryRoot,templateProject,
      profiles:found.profiles,thresholds:found.thresholds,defaultProfile,codex:params.codex===true,claude:params.claude===true,
      pi:piChoices(params.pi),
      contributorName:typeof params.contributorName==='string'?params.contributorName:'',
      unity:unityEditor?{editor:unityEditor}:undefined});
    hostPlatform.writePrivate(configPath,`# 由 Harness GUI 首次配置向导生成。\n${stringify(document)}`,{flag:'wx'});
    // A configuration the Runtime refuses must not stay behind: the wizard would never show again.
    try{loadConfig(home);}
    catch(error){rmSync(configPath,{force:true});throw new Error(`配置没有通过校验，已撤回，可以修改后重试：${(error as Error).message}`);}
    await connect(); return {ok:true,defaultProfile};
  };
  const server=createServer((request,response)=>{
    const url=new URL(request.url??'/', 'http://127.0.0.1');
    if (url.pathname==='/api/events') {
      if (!authorized(url.searchParams.get('token')??undefined,token)) { response.writeHead(403);response.end();return; }
      response.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-store','connection':'keep-alive'}); response.write(': connected\n\n');streams.add(response);request.on('close',()=>streams.delete(response));return;
    }
    if (url.pathname==='/api/native-call'&&request.method==='POST') {
      if (!authorized(request.headers['x-avh-native-token'],nativeToken)) {json(response,403,{error:'原生桥会话已失效'});return;}
      let raw=''; request.setEncoding('utf8'); request.on('data',chunk=>{raw+=chunk;if(raw.length>16_384)request.destroy();}); request.on('end',async()=>{
        try {const body=JSON.parse(raw) as {method?:string;params?:Record<string,unknown>};if(body.method!=='booth.session.set')throw new Error('原生桥不允许该方法');const result=await (await connect()).call(body.method,body.params??{});json(response,200,{result});}
        catch(error){json(response,400,{error:(error as Error).message});}
      });return;
    }
    if (url.pathname==='/api/call'&&request.method==='POST') {
      if (!authorized(request.headers['x-avh-token'],token)) {json(response,403,{error:'GUI 会话已失效'});return;}
      let raw=''; request.setEncoding('utf8'); request.on('data',chunk=>{raw+=chunk;if(raw.length>1_000_000)request.destroy();}); request.on('end',async()=>{
        try {const body=JSON.parse(raw) as {method?:string;params?:Record<string,unknown>;timeoutMs?:unknown};if(!body.method)throw new Error('缺少 GUI 方法');const params=body.params??{};
          // A caller may ask for longer than the default minute, up to half an hour.
          const timeout=typeof body.timeoutMs==='number'&&Number.isFinite(body.timeoutMs)?Math.min(Math.max(body.timeoutMs,1000),1_800_000):undefined;
          const route=guiRoute(body.method,existsSync(configPath));
          const result=route==='setup'?await setup(body.method,params):route==='secret'?secretMethod(home,body.method,params)
            :route==='runtime'?await (await connect()).call(body.method,params,timeout):(()=>{throw new Error('不允许的 GUI 方法')})();json(response,200,{result});}
        catch(error){json(response,400,{error:(error as Error).message});}
      });return;
    }
    const requested=url.pathname==='/'?'index.html':decodeURIComponent(url.pathname.slice(1));
    const path=join(root,requested);
    if (!path.startsWith(root)||!existsSync(path)||!statSync(path).isFile()) { createReadStream(join(root,'index.html')).pipe(response);return; }
    response.writeHead(200,{'content-type':TYPES[extname(path)]??'application/octet-stream','x-content-type-options':'nosniff'});createReadStream(path).pipe(response);
  });
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(options.port??0,'127.0.0.1',()=>resolve());});
  const address=server.address(); if(!address||typeof address==='string')throw new Error('GUI 地址无效');
  const url=`http://127.0.0.1:${address.port}/?token=${encodeURIComponent(token)}`;
  console.log(`Harness GUI: ${url.replace(token,'<session-token>')}`);
  options.onReady?.(url);
  if(options.open!==false){const browser=process.env.BROWSER||(process.platform==='win32'?windowsAppBrowser():['google-chrome','chromium','chromium-browser'].find(name=>existsSync(`/usr/bin/${name}`)));if(browser){const child=spawn(browser,[`--app=${url}`],{stdio:'ignore',detached:true});child.unref();}else console.log(`请在浏览器打开：${url}`);}
  const close=()=>{for(const stream of streams)stream.end();streams.clear();connection.close();server.close();};process.once('SIGINT',close);process.once('SIGTERM',close);
  options.signal?.addEventListener('abort',close,{once:true});
  try {await new Promise<void>(resolve=>{server.once('close',resolve);if(options.signal?.aborted)close();});}
  finally {process.removeListener('SIGINT',close);process.removeListener('SIGTERM',close);options.signal?.removeEventListener('abort',close);}
}
