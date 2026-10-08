import React, { useState } from 'react';
import { call, type Task } from './api';
import { Panel, useAction, useLoad } from './ui';
import { stageLabel } from './labels';

type Change = {seq:number;artifact:string;recordedAt:string;changes?:{added:string[];removed:string[];modified:string[];counts:number[]}};
type Detail = Task & {outOfBounds:Change[];reviewToken?:string};
export function TechnicalReview({project,workflowId,refresh,changed}:{project:string;workflowId:string;refresh:number;changed:()=>void}) {
  const [tasks,error]=useLoad<Task[]>('task.list',refresh,[],{project});
  const current=tasks.filter(t=>t.workflowId===workflowId&&['WAITING_HUMAN','BLOCKED','FAILED','CANCELLED','RECOVERY_REQUIRED'].includes(t.status));
  return <>{error?<div className="banner warn">技术审阅读取失败：{error}</div>:null}
    {current.map(task=><TechnicalReviewTask key={task.id} task={task} refresh={refresh} changed={changed}/>)}</>;
}
export function TechnicalReviewTask({task,refresh,changed}:{task:Task;refresh:number;changed:()=>void}) {
  const [detail,error]=useLoad<Detail|null>('task.show',refresh,null,{id:task.id});
  const [selected,setSelected]=useState<string[]>([]),[note,setNote]=useState('');
  const {busy,run}=useAction();
  if(error)return <div className="banner warn">技术审阅读取失败：{error}</div>;
  if(!detail?.outOfBounds.length)return null;
  const visible=detail.outOfBounds.filter(c=>selected.includes(c.artifact)).map(c=>c.artifact);
  return <Panel title={`技术审阅 · ${stageLabel(task.stage)}`}>
    <p>Harness 检测到制作范围之外的改动，需要你核对。确认这里只允许保留所选技术改动；脸型外观仍须另行看图接受。</p>
    {detail.outOfBounds.map(change=><div key={change.seq} className="stack">
      <label><input type="checkbox" checked={selected.includes(change.artifact)} onChange={event=>setSelected(old=>event.target.checked?[...old,change.artifact]:old.filter(p=>p!==change.artifact))}/>
        {change.artifact.startsWith('workspace:')?'工程文件：'+change.artifact.slice(10):'产物范围：'+change.artifact}</label>
      {change.changes?<dl>{(['added','modified','removed'] as const).map((kind,index)=><React.Fragment key={kind}>
        <dt>{kind==='added'?'新增':kind==='modified'?'修改':'删除'}（{change.changes!.counts[kind==='added'?0:kind==='removed'?1:2]}）</dt>
        <dd>{change.changes![kind].join('、')||'无'}{change.changes![kind].length<change.changes!.counts[kind==='added'?0:kind==='removed'?1:2]?'（其余记录保留在运行证据中）':''}</dd>
      </React.Fragment>)}</dl>:null}
    </div>)}
    <label className="stack">审阅说明<textarea value={note} onChange={event=>setNote(event.target.value)} placeholder="说明所选改动为什么可以保留"/></label>
    <div className="actions"><button className="primary" disabled={Boolean(busy)||!visible.length||!note.trim()||!detail.reviewToken} onClick={()=>void run('review',async()=>{
      await call('task.acceptChanges',{id:task.id,paths:visible,note:note.trim(),expectedReviewToken:detail.reviewToken},300_000);setSelected([]);setNote('');changed();
    },'已记录技术审阅，Harness 将继续独立检查')}>确认保留所选技术改动</button>
    <button disabled={Boolean(busy)} onClick={()=>void run('cancel',async()=>{await call('task.cancel',{id:task.id},300_000);changed();},'已停止制作并保留证据')}>停止这次制作</button></div>
  </Panel>;
}
