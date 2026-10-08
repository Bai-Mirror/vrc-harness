import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { stringify } from 'yaml';
import { loadConfig } from '../src/config.ts';
import { openDatabase } from '../src/state/db.ts';
import { createWorkflow } from '../src/workflow/runtime.ts';
import { TaskRouter, serveOnce } from '../src/task-cli.ts';
import { RuntimeService } from '../src/api/server.ts';
import { ApiClient } from '../src/api/client.ts';
import { productionHead } from '../src/production-face-continuation.ts';
import { sha256File } from '../src/file-hash.ts';
import { removeTemp } from './fixtures/platform.ts';
import { spawnUnityEditor } from './fixtures/unity-slot.ts';
import type { RunSpec, RunHandle, RunResult } from '../src/runtime/interfaces.ts';

const tools = fileURLToPath(new URL('../builtin/tools/', import.meta.url));
const blender = process.env.AVH_TEST_BLENDER ?? (process.platform === 'win32' ? 'C:/Program Files/Blender Foundation/Blender 5.2/blender.exe' : '/usr/bin/blender');
const editor = process.env.AVH_FACE_UNITY_EDITOR;
const python = process.platform === 'win32' ? 'python' : 'python3';

test('Runtime successor parents actually apply s1, s2 and rollback s1 through Blender and Unity',
  {skip:!editor || !process.env.AVH_FACE_UNITY_BASELINE || !existsSync(blender), timeout:3_600_000}, async t => {
    const root=mkdtempSync(join(tmpdir(),'avh-continuation-unity-')),home=join(root,'home'),workspace=join(root,'workspace'),project=join(workspace,'source'),knowledge=join(root,'knowledge');
    let api:ApiClient|undefined,service:RuntimeService|undefined,verified=false;
    for(const path of [project,knowledge,join(home,'config'),join(home,'state'),'Assets/_HarnessTools/Editor','Assets/Source','Assets/_Harness/Face/Candidates/revision-1','Packages','ProjectSettings'])
      mkdirSync(path.startsWith('Assets')||path==='Packages'||path==='ProjectSettings'?join(project,path):path,{recursive:true});
    const db=openDatabase(join(home,'state/harness.db'));
    t.after(async()=>{api?.close();await service?.stop();
      if(process.env.AVH_FACE_EVIDENCE_DIR){mkdirSync(process.env.AVH_FACE_EVIDENCE_DIR,{recursive:true});writeFileSync(join(process.env.AVH_FACE_EVIDENCE_DIR,'runtime-events.json'),JSON.stringify(db.prepare('SELECT * FROM event').all(),null,2));}
      db.close();
      if(process.env.AVH_FACE_EVIDENCE_DIR){mkdirSync(process.env.AVH_FACE_EVIDENCE_DIR,{recursive:true});
        if(existsSync(join(project,'unity-continuation.log')))copyFileSync(join(project,'unity-continuation.log'),join(process.env.AVH_FACE_EVIDENCE_DIR,'continuation-unity.log'));}
      if(verified)removeTemp(root);else writeFileSync(join(process.env.AVH_FACE_EVIDENCE_DIR??root,'retained-test-root.txt'),root);});
    execFileSync('git',['init','-q',project],{windowsHide:true});
    const preparation=fileURLToPath(new URL('./fixtures/continuation-unity-environment.py',import.meta.url));
    execFileSync(python,[preparation,join(tools,'harness'),project,process.env.AVH_FACE_UNITY_BASELINE!],{windowsHide:true,timeout:600_000,stdio:'pipe'});
    const cs=['FaceStage.cs','FaceGeometry.cs','FaceEyes.cs','FaceMapping.cs','AvhCommon.cs','LocalOperations.cs','OutfitStage.cs','SetupStage.cs','FacePreviewStage.cs'];
    const py=['blender_face.py','blender_face_observe.py','blender_face_common.py','blender_face_transfer.py','blender_face_mapping.py'];
    const sources=[...cs.map(name=>join(tools,'harness/unity/Editor',name)),...py.map(name=>join(tools,'harness',name))];
    execFileSync(blender,['--background','--factory-startup','--disable-autoexec','--python-exit-code','2','--python',fileURLToPath(new URL('./fixtures/continuation-face-seed.py',import.meta.url)),'--',project],{windowsHide:true,timeout:90_000,stdio:'pipe'});
    copyFileSync(join(project,'Assets/Source/source.fbx'),join(project,'Assets/_Harness/Face/Candidates/revision-1/candidate.fbx'));
    for(const name of ['FaceStageIntegration.cs','FaceContinuationReadback.cs'])copyFileSync(fileURLToPath(new URL(`./fixtures/unity/${name}`,import.meta.url)),join(project,'Assets/_HarnessTools/Editor',name));

    execFileSync(python,[join(tools,'harness/face.py'),'contract','--install','--project',project,'--sources',...sources],{windowsHide:true,timeout:60_000,stdio:'pipe'});
    const plan={body_prefab:'Assets/Source/avatar.prefab',face:{mode:'preserve'},outfits:[]};
    let unityAttempt=0;const evidence=process.env.AVH_FACE_EVIDENCE_DIR ?? join(root,'evidence');mkdirSync(evidence,{recursive:true});
    const unity=async(path:string,method:string,env:Record<string,string>={})=>{
      const cold=!existsSync(join(path,'Library'));
      const attempt=++unityAttempt,log=join(evidence,`${attempt}-${method.split('.').at(-1)}.log`),started=Date.now();
      const argv=['-batchmode','-nographics','-projectPath',path,'-executeMethod',method,'-logFile',log];
      const record=(phase:string,extra:Record<string,unknown>={})=>writeFileSync(join(evidence,`${attempt}-lifecycle.json`),JSON.stringify({phase,path,argv,cold,started,elapsed:Date.now()-started,...extra},null,2));
      record('spawned');
      // Through the fixture entry: this editor takes the machine-level slot and runs at Low integrity like a Runtime
      // step. Its log and lifecycle records live in the evidence directory, which is therefore a labelled root too.
      const result=spawnUnityEditor(editor!,argv,{encoding:'utf8',timeout:600_000,windowsHide:true,writableRoots:[evidence],
        env:{...process.env,AVH_PROJECT_DIR:path,AVH_PLAN:JSON.stringify(plan),AVH_MANIFEST:'{"assets":[{"item":"Fixture"}]}',...env}});
      const timedOut=(result.error as NodeJS.ErrnoException|undefined)?.code==='ETIMEDOUT';
      record('closed',{status:result.status,signal:result.signal,timedOut,stdout:result.stdout,stderr:result.stderr});
      if(result.status===0&&!timedOut)return;
      throw new Error(`Unity ${method} failed: status=${result.status} signal=${result.signal} timeout=${timedOut}; diagnostics ${log}`);
    };
    await unity(project,'AVH.Harness.FaceStageIntegration.Run',{AVH_FACE_SEED_SETUP:'1'});
    await unity(project,'AVH.Harness.FaceStage.PrepareSource',{AVH_PLAN:JSON.stringify({...plan,face:{mode:'design'}})});
    await unity(project,'AVH.Harness.FaceStage.Observe');
    rmSync(join(project,'Assets/_Harness/Face/Candidates'),{recursive:true});
    const target=JSON.parse(readFileSync(join(project,'_harness/face/observation.json'),'utf8')).targets[0];
    writeFileSync(join(project,'plan.json'),JSON.stringify(plan));writeFileSync(join(project,'setup.txt'),'actual Unity prepared source');
    writeFileSync(join(knowledge,'thresholds.yaml'),stringify({schema:'thresholds/0.1',version:'1',t:{}}));
    const definition={schema:'process/0.1',id:'continuation-unity',version:'1',applies_to:{},artifacts:['plan','face_input','setup','face'],
      stages:[{id:'setup',needs:[],produces:['setup'],requires:['setup_ok'],gates:[],invalidated_by:['plan'],source:'fixture'},
        {id:'face',needs:['setup'],produces:['face'],requires:['actual_vertices','actual_input'],gates:[],invalidated_by:['plan','face_input'],source:'fixture'}],
      checks:[{id:'setup_ok',observe:'setup.read',on:'setup',scope:'edit',rule:'ok == true',severity:'blocking',maturity:'accepted',source:'fixture'},
        {id:'actual_vertices',observe:'vertices.read',on:'face',scope:'edit',rule:'vertices_match == true',severity:'blocking',maturity:'accepted',source:'fixture'},
        {id:'actual_input',observe:'face.input',on:'face',scope:'edit',rule:'face_input_bound == true',severity:'blocking',maturity:'accepted',source:'fixture'}],gates:[],milestones:[]};
    const capabilities={schema:'capabilities/0.1',process:definition.id,version:'1',artifacts:{plan:{paths:['plan.json'],format:'json'},face_input:{source:{kind:'runtime',input:'face_input'}},setup:{paths:['setup.txt']},
      face:{paths:['Assets/_Harness/Face/design.json','_harness/face/output.json','_harness/face/continuation-readback.json']}},
      stages:{setup:{mode:'tool',command:['node','-e','process.exit(0)'],allowedWrites:[]},face:{mode:'tool',command:[python,'{toolRoot}/harness/face.py','execute','--project','{project}','--sources',...sources.map(path=>path.replace(tools,'{toolRoot}/'))],allowedWrites:['Assets/','_harness/']}},
      observers:{'setup.read':{command:['node','-e',"require('fs').writeFileSync(process.argv[1],JSON.stringify({schema:'observation/0.1',metrics:{ok:true}}))",'{out}']},
        'vertices.read':{command:['node','-e',"require('fs').copyFileSync(process.argv[1],process.argv[2])",'{project}/_harness/face/continuation-readback.json','{out}']},
        'face.input':{command:[python,'{toolRoot}/harness/face.py','input-check','--project','{project}','--out','{out}']}}};
    writeFileSync(join(knowledge,'process.yaml'),stringify(definition));writeFileSync(join(knowledge,'capabilities.yaml'),stringify(capabilities));
    writeFileSync(join(home,'config/harness.yaml'),stringify({workspaceRoot:workspace,toolRoot:tools,knowledgeRoot:knowledge,defaultProfile:definition.id,
      thresholdsFile:'thresholds.yaml',processDefinitions:{[definition.id]:{definition:'process.yaml',capabilities:'capabilities.yaml'}},providers:[],exportRoots:[],knownBodies:[],projectAliases:{},sampleNames:[]}));
    const config=loadConfig(home),workflow=createWorkflow(db,config,project,definition.id),projectId=String(db.prepare('SELECT project_id FROM workflow WHERE id=?').get(workflow)!.project_id);
    for(const [i,value] of [.25,.75].entries())db.prepare("INSERT INTO face_manual_session(id,project_id,project_path,target_id,state,version,accepted_json) VALUES(?,?,?,?,'accepted',?,?)")
      .run(`s${i+1}`,projectId,join(root,`manual-${i}`),target.targetId,i+1,JSON.stringify({schema:'manual-values/0.1',sourceSha256:target.mesh.sha256,rendererPath:target.rendererPath,meshName:target.meshSnapshot.name,
        values:{ContourWidth:value},rangeOverrides:{},submittedSha256:String(i+1).repeat(64)}));
    const starts:Array<{run:RunSpec;path:string}>=[];
    t.mock.method(TaskRouter.prototype,'canDispatch',()=>true);
    t.mock.method(TaskRouter.prototype,'start',async function(this:TaskRouter,run:RunSpec):Promise<RunHandle>{
      let phase='mkdir';
      try {
        t.signal.throwIfAborted();starts.push({run,path:this.row.project_path});mkdirSync(join(home,'runs',run.runId),{recursive:true});
        if(run.stageId==='face'){
          phase='frozen-input';const tool=this.spec.tool,input=run.inputSnapshot;
          assert.ok(tool,'Missing deterministic face tool');assert.ok(input?.plan.face,'Missing frozen face input');
          assert.deepEqual(JSON.parse(tool.env.AVH_PLAN!).face,input.plan.face,'Tool plan differs from the frozen Run input');
          phase='python';execFileSync(python,tool.argv.slice(1),{windowsHide:true,timeout:180_000,stdio:'pipe',env:{...process.env,...tool.env,AVH_BLENDER_BIN:blender}});
          phase='contour';const contour=input.plan.face.mode==='manual'?String(JSON.parse(input.manualValues!).values.ContourWidth):'0';
          phase='unity';await unity(this.row.project_path,'AVH.Harness.FaceContinuationReadback.Run',{...tool.env,AVH_EXPECTED_CONTOUR:contour});
        }
        phase='return';return{ref:`real-${run.runId}`};
      } catch(error) {
        const failure=error as Error&{stdout?:Buffer;stderr?:Buffer};
        try{writeFileSync(join(evidence,`${run.runId}-executor-error.log`),`${phase}\n${failure.stack}\n${failure.stdout}\n${failure.stderr}\n${JSON.stringify({run,tool:this.spec.tool},null,2)}`);}catch{}
        throw error;
      }
    });
    t.mock.method(TaskRouter.prototype,'observe',async()=>({state:'exited'}));
    t.mock.method(TaskRouter.prototype,'collect',async():Promise<RunResult>=>({exitStatus:0,outputs:{}}));
    await serveOnce(db,config);await serveOnce(db,config);
    assert.equal(db.prepare("SELECT status FROM task WHERE stage_id='face'").get()!.status,'PASSED');
    service=new RuntimeService({home,scheduler:false});await service.start();api=await ApiClient.connect(home);
    let revision=0;
    for(const sessionId of ['s1','s2','s1']){
      await api.call('project.face.manual.rollback',{projectId,sessionId,expectedRevision:revision++});await serveOnce(db,config);
      const head=productionHead(db,projectId)!,run=starts.find(start=>start.run.workflowId===head&&start.run.stageId==='face')!;
      assert.ok(run,JSON.stringify(db.prepare('SELECT state,error FROM production_continuation').all()));
      assert.equal(db.prepare('SELECT status FROM task WHERE id=?').get(run.run.taskId)!.status,'PASSED',JSON.stringify({runs:db.prepare('SELECT status,result_json FROM run WHERE task_id=?').all(run.run.taskId),events:db.prepare("SELECT action,reason FROM event WHERE entity_id=? OR entity_id=? ORDER BY seq").all(run.run.taskId,run.run.runId)}));
      const readback=JSON.parse(readFileSync(join(run.path,'_harness/face/continuation-readback.json'),'utf8'));
      assert.ok(Math.abs(readback.weight-(sessionId==='s2'?.75:.25))<1e-5,JSON.stringify(readback));assert.equal(readback.faceInputHash,run.run.inputSnapshot!.baseline.face_input);
      assert.equal(db.prepare('SELECT status FROM task WHERE id=?').get(run.run.taskId)!.status,'PASSED');
      assert.equal(sha256File(join(run.path,'Assets/Source/source.fbx')),target.mesh.sha256);
    }
    assert.equal(db.prepare('SELECT COUNT(*) n FROM production_continuation WHERE state=\'applied\'').get()!.n,3);
    verified=true;
  });
