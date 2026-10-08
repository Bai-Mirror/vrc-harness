import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import React from 'react';
import ts from 'typescript';

// Execute the shipped component's real handlers without a browser or Runtime mutation. Dependencies are controlled
// so a request can remain pending, lose its response, or return a persistent Runtime result deterministically.
const project=readFileSync(new URL('../../gui/src/project.tsx',import.meta.url),'utf8');
const component=project.slice(project.indexOf('const productionRecoveryInFlight='),project.indexOf('\nfunction Chat('));
const compiled=ts.transpileModule(`${component}\nglobalThis.renderRecovery=ProductionRecovery;`,{
  compilerOptions:{jsx:ts.JsxEmit.React,target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None},
}).outputText;
type Element={type:unknown;props:Record<string,unknown>};
type Command={projectId:string;id:string;commandId:string;expectedToken:string};
type Recovery={commandId:string;status:'running'|'failed'|'succeeded'|'unknown';error?:string};
function elements(value:unknown):Element[] {
  if(Array.isArray(value))return value.flatMap(elements);
  if(!value||typeof value!=='object'||!('props' in value))return [];
  const element=value as Element;return [element,...elements(element.props.children)];
}
function text(value:unknown):string {
  if(Array.isArray(value))return value.map(text).join('');
  if(value&&typeof value==='object'&&'props' in value)return text((value as Element).props.children);
  return typeof value==='string'?value:'';
}
function harness(invoke:(method:string,command:Command,timeout?:number)=>Promise<unknown>,initial='',confirm=true) {
  let pending=initial,busy='',refreshes=0;
  const flight={current:false},ok:string[]=[],errors:string[]=[];
  const progress={state:'interrupted',reason:'原要求和工程仍保留。',token:'current-token',canResume:true,canCancel:true,
    recovery:undefined as Recovery|undefined};
  const proposal={id:'proposal',revision:1,request:'做一个头像',status:'working',workflowId:'workflow',inputs:[],progress};
  const context={React:{...React,useRef:()=>flight},crypto:{randomUUID},
    useSessionState:()=>[pending,(value:string)=>{pending=value;}],
    useFeedback:()=>({ok:(value:string)=>ok.push(value),confirm:async()=>confirm}),
    useAction:()=>({busy,run:async(key:string,action:()=>Promise<unknown>,success?:string)=>{
      busy=key;try{await action();if(success)ok.push(success);return true;}
      catch(error){errors.push(error instanceof Error?error.message:String(error));return false;}
      finally{busy='';}
    }}),call:invoke,renderRecovery:undefined as unknown};
  runInNewContext(compiled,context);
  const render=()=> (context.renderRecovery as (props:unknown)=>unknown)({projectId:'project',proposal,changed:()=>{refreshes++;}});
  const button=(label:string)=>elements(render()).find(element=>element.type==='button'&&text(element.props.children).includes(label))!;
  const click=(label:string)=> (button(label).props.onClick as ()=>Promise<unknown>|undefined)();
  return {render,button,click,progress,ok,errors,pending:()=>pending,refreshes:()=>refreshes};
}
const receipt=(commandId='original-command',token='current-token')=>JSON.stringify({action:'resume',phase:'uncertain',
  command:{projectId:'project',id:'proposal',commandId,expectedToken:token}});

test('production continuation waits fifteen minutes, keeps one command and blocks duplicate clicks while checking',async()=>{
  let finish!:(value:unknown)=>void;const calls:Array<[string,Command,number|undefined]>=[];
  const ui=harness((method,command,timeout)=>{calls.push([method,command,timeout]);return new Promise(resolve=>{finish=resolve;});});
  const handler=ui.button('核对并继续制作').props.onClick as ()=>Promise<unknown>|undefined;
  const first=handler(); await new Promise(resolve=>setImmediate(resolve)); handler();
  assert.equal(calls.length,1);
  assert.equal(calls[0]![0],'project.production.resume');
  assert.equal(calls[0]![2],15*60_000,'the actual API consumer overrides the default minute');
  assert.equal(JSON.parse(ui.pending()).command.commandId,calls[0]![1].commandId);
  assert.equal(calls[0]![1].expectedToken,'current-token');
  assert.match(text(ui.render()),/正在核对并保留工程，可能需要几分钟/);
  assert.equal(ui.button('正在核对工程').props.disabled,true);
  assert.equal(ui.button('取消这次制作').props.disabled,true);
  assert.deepEqual(ui.ok,[],'waiting is not success');
  finish({requested:true});await first;
  assert.equal(ui.pending(),'');assert.deepEqual(ui.ok,['已核对并请求继续制作']);
});

test('a pending Runtime receipt survives reload and exposes only a read refresh until its result is known',async()=>{
  const calls:Command[]=[];
  const ui=harness(async(_method,command)=>{calls.push(command);return {pending:true};});
  await ui.click('核对并继续制作');
  ui.progress.recovery={commandId:calls[0]!.commandId,status:'running'};
  assert.equal(ui.ok.length,0);assert.equal(JSON.parse(ui.pending()).phase,'waiting');
  assert.equal(ui.button('正在核对工程').props.disabled,true);
  ui.click('正在核对工程');assert.equal(calls.length,1);
  ui.click('查看最新进展');assert.equal(ui.refreshes(),2);assert.equal(calls.length,1);
  const reloaded=harness(async()=>{throw new Error('must not replay');},ui.pending());
  reloaded.progress.recovery=ui.progress.recovery;
  assert.equal(reloaded.button('正在核对工程').props.disabled,true);
  assert.match(text(reloaded.render()),/正在核对并保留工程/);
});

test('a lost response retains the original command and shows the actual error; unknown recovery needs an explicit recheck',async()=>{
  const calls:Command[]=[];let lose=true;
  const ui=harness(async(_method,command)=>{calls.push(command);if(lose)throw new Error('Runtime 连接中断');return {requested:true};});
  await ui.click('核对并继续制作');
  assert.deepEqual(ui.errors,['Runtime 连接中断']);assert.deepEqual(ui.ok,[]);
  const original=JSON.parse(ui.pending()).command as Command;
  ui.progress.canResume=false;
  assert.equal(ui.button('取消这次制作').props.disabled,true);
  ui.progress.recovery={commandId:original.commandId,status:'unknown'};
  ui.progress.canResume=true;
  assert.equal(calls.length,1,'a status refresh does not send a mutation');
  lose=false;await ui.click('重新核对并继续制作');
  assert.deepEqual(JSON.parse(JSON.stringify(calls[1])),original,'explicit safe recheck uses the persisted idempotent command');
  assert.equal(ui.pending(),'');
});

test('a changed state token creates a current command; a stale Runtime rejection never clears its receipt or claims success',async()=>{
  let command!:Command;
  const ui=harness(async(_method,value)=>{command=value;throw new Error('制作状态已更新，请查看最新进展');},receipt('old-command','old-token'));
  await ui.click('核对并继续制作');
  assert.notEqual(command.commandId,'old-command');assert.equal(command.expectedToken,'current-token');
  assert.equal(JSON.parse(ui.pending()).command.commandId,command.commandId);
  assert.deepEqual(ui.errors,['制作状态已更新，请查看最新进展']);assert.deepEqual(ui.ok,[]);
});

test('a persisted failed review shows its real error and a deliberate retry gets a new command',async()=>{
  let command!:Command;
  const ui=harness(async(_method,value)=>{command=value;return {requested:true};},receipt());
  ui.progress.recovery={commandId:'original-command',status:'failed',error:'工程核对未完成；已有成果保留。'};
  assert.match(text(ui.render()),/工程核对未完成；已有成果保留/);
  assert.equal(ui.button('核对并继续制作').props.disabled,false);
  await ui.click('核对并继续制作');
  assert.notEqual(command.commandId,'original-command');assert.equal(command.expectedToken,'current-token');
});

test('a legacy browser receipt without a Runtime review permits only an explicit same-command recheck after current safety confirmation',async()=>{
  const calls:Command[]=[];
  const ui=harness(async(_method,command)=>{calls.push(command);return {requested:true};},receipt());
  assert.match(text(ui.render()),/未找到上次核对的回执，原工程仍保留/);
  assert.equal(ui.button('重新核对并继续制作').props.disabled,false);
  assert.equal(calls.length,0,'neither render nor fresh state confirmation automatically replays the command');
  ui.click('查看最新进展');assert.equal(calls.length,0);
  await ui.click('重新核对并继续制作');
  assert.equal(calls.length,1);assert.equal(calls[0]!.commandId,'original-command');
  assert.equal(calls[0]!.expectedToken,'current-token');assert.equal(ui.pending(),'');
});

test('legacy pending stays blocked when the Runtime cannot resume or when a real review is running',()=>{
  let calls=0;
  const ui=harness(async()=>{calls++;return {requested:true};},receipt());
  ui.progress.canResume=false;
  assert.equal(elements(ui.render()).some(element=>element.type==='button'&&text(element.props.children).includes('继续制作')),false);
  assert.equal(ui.button('取消这次制作').props.disabled,true);
  ui.click('取消这次制作');assert.equal(calls,0);
  ui.progress.canResume=true;ui.progress.recovery={commandId:'original-command',status:'running'};
  assert.equal(ui.button('正在核对工程').props.disabled,true);
  ui.click('正在核对工程');assert.equal(calls,0);
  assert.doesNotMatch(text(ui.render()),/未找到上次核对的回执/);
});

test('cancel and resume both require confirmation, and declining either sends no Runtime command', async()=>{
  let calls=0;
  const ui=harness(async()=>{calls++;return {confirmed:true};},'',false);
  await ui.click('取消这次制作');
  await ui.click('核对并继续制作');
  assert.equal(calls,0,'a declined confirmation does not reach the production Runtime');
});

// This executes the actual import recovery consumer. It does not manufacture a production result or a retry route.
const takeoverComponent=project.slice(project.indexOf('type Recovery ='),project.indexOf('/** Hand-over to the official uploader'));
const takeoverCompiled=ts.transpileModule(`${takeoverComponent}\nglobalThis.renderTakeover=RecoveryPanel;`,{
  compilerOptions:{jsx:ts.JsxEmit.React,target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None},
}).outputText;
function takeoverUi(status:string,busy='') {
  const calls:string[]=[],row={id:'recovery',sourceKind:'folder',sourcePath:'private-input',mode:'deep',distill:false,status,
    analysisTaskId:'analysis',applyTaskId:null,warnings:['facts[0].dependsOn is invalid']};
  const context={React,useLoad:()=>[[row],null],useAction:()=>({busy,run:async(_key:string,action:()=>Promise<unknown>)=>action()}),
    call:async(method:string)=>{calls.push(method);return {created:[]};},Panel:'panel',Status:'status',sourceKind:(s:string)=>s,
    takeoverMode:(s:string)=>s,recoveryState:(s:string)=>s,renderTakeover:undefined as unknown};
  runInNewContext(takeoverCompiled,context);
  const view=(context.renderTakeover as (p:unknown)=>unknown)({projectId:'project',refresh:0,changed:()=>calls.push('changed')});
  return {view,calls,button:(label:string)=>elements(view).find(x=>x.type==='button'&&text(x.props.children).includes(label))!};
}

test('actual takeover panel blocks failed and pending apply, keeps technical reasons in closed diagnostics and uses the existing ready API',async()=>{
  for(const state of ['failed','analysis_pending','apply_pending']) {
    const ui=takeoverUi(state);assert.equal(ui.button('分析通过后执行').props.disabled,true);
    assert.equal(ui.button('若判定为素材则登记').props.disabled,true);
    const diagnostic=elements(ui.view).find(x=>x.type==='details')!;
    assert(!diagnostic.props.open);assert.match(text(diagnostic),/dependsOn/);
    if(state==='failed')assert.match(text(ui.view),/暂不能继续改造；原工程未修改/);
    assert.deepEqual(ui.calls,[]);
  }
  const ready=takeoverUi('ready');assert.equal(ready.button('分析通过后执行').props.disabled,false);
  await (ready.button('分析通过后执行').props.onClick as ()=>Promise<unknown>)();
  assert.deepEqual(ready.calls,['project.recovery.apply','changed']);
  assert.equal(takeoverUi('ready','recovery').button('分析通过后执行').props.disabled,true);
});
