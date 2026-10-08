import React from "react";
import { call } from "./api";
import { Panel, useAction, useFeedback, useLoad } from "./ui";

type Candidate={id:string;version:string;reason:string;contentHash:string;ready:boolean;defaultReady:boolean;verification:string;problem:string|null};
export type MaintenanceView={token:string;current:{scope:string;candidateId:string|null}|null;currentProblem?:string|null;notice:string;
  candidates:Candidate[];history:Array<{id:string;scope:string;candidateId:string|null;status:string;reason:string}>};
export function LocalMaintenance({projectId,refresh,changed}:{projectId:string;refresh:number;changed:()=>void}) {
  const [view,error]=useLoad<MaintenanceView|null>("project.maintenance.show",refresh,null,{projectId});
  const feedback=useFeedback(),{busy,run}=useAction();
  async function select(candidate:Candidate|undefined,scope:"project"|"local") {
    if(!view)return;
    const accepted=await feedback.confirm({title:candidate?`采用本地修复 · ${candidate.version}`:"回到正式版本",
      body:<><p>{scope==="local"?"这是本机后继制作的明确维护政策；有项目单独选择时保留项目选择。":"仅本项目的后继新制作使用此选择。"}</p>
        <p>{candidate?.verification}</p><p>{view.notice}</p><p>本地采用无需上传，不取得官方身份。</p></>,confirm:candidate?"采用此版本":"回到正式版本"});
    if(!accepted)return;
    await run("adopt",async()=>{await call("project.maintenance.adopt",{projectId,scope,candidateId:candidate?.id??null,
      expectedHash:candidate?.contentHash,expectedToken:view.token,commandId:crypto.randomUUID()});changed();},"已更新后继制作的能力选择");
  }
  async function create() {
    const reason=await feedback.ask({title:"生成本地修复",label:"希望 Harness 改进什么？",confirm:"生成修复候选",required:true,multiline:true,
      body:<p>AI 在隔离候选里整理项目案例。完成后先验证，再由你决定采用范围；不会直接更改当前制作或正式能力。</p>});
    if(!reason)return;
    await run("create",async()=>{const packs=await call<Array<{id:string;active:boolean}>>("managed.list");
      const base=packs.find(pack=>pack.active);if(!base)throw new Error("请先在核心管理选择正式能力版本");
      await call("managed.candidate.authoring.create",{projectId,basePackId:base.id,reason});changed();},"本地修复任务已建立");
  }
  return <Panel title="记忆与 SOP · 本地修复">
    {error?<p role="alert">{error}</p>:null}
    {view?.currentProblem?<p className="banner warn" role="alert">{view.currentProblem}</p>:null}
    <p>{view?.current?.candidateId?`后继制作采用本地版本：${view.candidates.find(c=>c.id===view.current?.candidateId)?.version??view.current.candidateId}`:"后继制作采用正式版本"}</p>
    <p className="muted">{view?.notice??"正在读取本地维护状态…"}</p>
    <button disabled={Boolean(busy)||!view} onClick={()=>void create()}>根据项目问题生成修复</button>
    {view?<details><summary>查看版本、验证与回退</summary>
      {view.history.filter(item=>item.status==="disabled").map(item=><p className="banner warn" key={item.id}>本地修复已停用：{item.reason}。请生成新候选；失败工程仍需恢复。</p>)}
      {view.candidates.map(candidate=><div className="row" key={candidate.id}><div><b>{candidate.version} · 本地来源</b><p>{candidate.reason}</p>
        <p>{candidate.verification}{candidate.problem?`；${candidate.problem}`:""}</p></div>
        <button disabled={Boolean(busy)} onClick={()=>void run(`evaluate:${candidate.id}`,async()=>{await call("managed.candidate.evaluate",{candidateId:candidate.id},120000);changed();})}>检查候选结构</button>
        <button disabled={Boolean(busy)||!candidate.ready} onClick={()=>void select(candidate,"project")}>本项目采用</button>
        <button disabled={Boolean(busy)||!candidate.defaultReady} onClick={()=>void select(candidate,"local")}>设为本机默认</button></div>)}
      <button disabled={Boolean(busy)} onClick={()=>void select(undefined,"project")}>本项目回到正式版本</button>
      <button disabled={Boolean(busy)} onClick={()=>void select(undefined,"local")}>本机默认回到正式版本</button>
      <p className="muted">此前已验证的版本可重新采用。结构检查不足以设置本机默认；需要与修复相关的隔离对照验证。</p>
    </details>:null}
  </Panel>;
}
