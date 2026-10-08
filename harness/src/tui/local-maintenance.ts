import { randomUUID } from 'node:crypto';
import { askText, choose } from './actions.ts';
import type { Ui } from './core.ts';
import type { localMaintenanceView } from '../local-maintenance.ts';

export async function manageLocalMaintenance(ui:Ui,projectId:string):Promise<void> {
  const view=await ui.api.call<ReturnType<typeof localMaintenanceView>>('project.maintenance.show',{projectId});
  const action=await choose(ui,'记忆与 SOP · 本地修复',[
    view.current?.candidateId?`后继制作：本地版本 ${view.current.candidateId}`:'后继制作：正式版本',view.notice,...(view.currentProblem?[view.currentProblem]:[]),
  ],[{key:'n',label:'根据项目问题生成修复'},{key:'v',label:'查看、验证与采用候选'},
    {key:'r',label:'本项目回到正式版本'},{key:'d',label:'本机默认回到正式版本'},{key:'b',label:'返回'}]);
  if(!action||action==='b')return;
  if(action==='n'){
    const reason=await askText(ui,'希望 Harness 改进什么？');if(!reason?.trim())return;
    await ui.act('本地修复任务已建立',async()=>{
      const packs=await ui.api.call<Array<{id:string;active:boolean}>>('managed.list'),base=packs.find(pack=>pack.active);
      if(!base)throw new Error('请先选择正式能力版本');
      await ui.api.call('managed.candidate.authoring.create',{projectId,basePackId:base.id,reason});
    });return;
  }
  let candidate:typeof view.candidates[number]|undefined,scope:'project'|'local'=action==='d'?'local':'project';
  if(action==='v'){
    if(!view.candidates.length){ui.notify('还没有本地候选，可先根据项目问题生成修复','warn');return;}
    // Page one candidate at a time so keyboard selection works for any list length.
    let index=0;
    while(true){
      const item=view.candidates[index]!;
      const selected=await choose(ui,`本地版本 ${index+1}/${view.candidates.length} · ${item.version}`,
        [item.reason,item.verification,...(item.problem?[item.problem]:[])],[
          ...(index>0?[{key:'p',label:'上一项'}]:[]),...(index+1<view.candidates.length?[{key:'n',label:'下一项'}]:[]),
          {key:'e',label:'检查候选结构'},...(item.ready?[{key:'a',label:'本项目采用'}]:[]),
          ...(item.defaultReady?[{key:'d',label:'设为本机默认'}]:[]),{key:'b',label:'返回'}]);
      if(selected==='p'){index--;continue;}if(selected==='n'){index++;continue;}
      if(selected==='e'){await ui.act('结构检查已完成；实际工程效果仍需验证',()=>ui.api.call('managed.candidate.evaluate',{candidateId:item.id},120000));return;}
      if(selected!=='a'&&selected!=='d')return;
      candidate=item;scope=selected==='d'?'local':'project';break;
    }
  }
  const confirmed=await choose(ui,candidate?'采用本地版本':'回到正式版本',[
    scope==='local'?'明确设置本机后继制作的维护政策；保留项目单独选择。':'仅影响本项目的后继新制作。',
    ...(candidate?[candidate.verification]:[]),view.notice,'本地采用不需要上传，不取得官方发行身份。'],[{key:'y',label:'确认此选择'},{key:'b',label:'返回'}]);
  if(confirmed!=='y')return;
  await ui.act('后继制作的能力选择已更新',()=>ui.api.call('project.maintenance.adopt',{projectId,scope,candidateId:candidate?.id??null,
    expectedHash:candidate?.contentHash,expectedToken:view.token,commandId:randomUUID()}));
}
