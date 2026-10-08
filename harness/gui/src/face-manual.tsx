import React, { useEffect, useState } from 'react';
import { call } from './api';
import { Panel, useAction, useLoad } from './ui';
import { FacePreviewView } from './face-preview';

type Application = {id:string;state:string;reason:string;needsContract?:boolean;rebuild?:{checkpoint:string;report:null|{hash:string;unknown:Array<{path:string;sha256:string;deleted?:boolean}>}}};
type ManualState = { production?: { workflowId: string | null; requirement?: {mode:string;manualVersion?:number}; making?:null|{mode:string;manualVersion?:number;preparing:boolean}; deliveries?: Array<{workflowId:string;projectId:string;packageHash:string;acceptedAt:string}>; missingInputs?:string[]; application: null | Application }; mode: 'preserve' | 'ai' | 'manual'; revision: number; acceptedSessionId: string | null;
  current: null | { id: string; workflowId: string; status: string; reason: string; expectedHash: string; viewProjectId: string; blendPath: string; projectPath: string;
    headAttachments?: { checkedMeshes: number; newNearContacts: number; limitations: string[] } };
  versions: Array<{ id: string; version: number }>; targets: Array<{ id: string; name: string }>;
  blender: { minimumVersion: string; downloadUrl: string } };
const labels: Record<string, string> = { preparing: '正在准备 Blender 副本', opened: '已打开 Blender · 等待“捏好了”', editing: '等待“捏好了”',
  processing: '处理中', awaiting: '待你接受', accepted: '已接受', warning: '有警告未采纳', cancelled: '已停止，可继续', stopping: '正在确认停止' };

/** A persistent Runtime handoff; UI state never approves geometry or invents a face version. */
export function ManualFaceView({ projectId, refresh, changed }: { projectId: string; refresh: number; changed: () => void }) {
  const [state, error] = useLoad<ManualState | null>('project.face.manual.state', refresh, null, { projectId });
  const { busy, run } = useAction(), stop = useAction();
  const [target, setTarget] = useState('');
  const [deliveryFiles,setDeliveryFiles]=useState<{verified:boolean;paths:Array<{path:string;exists:boolean}>}|null>(null);
  const current = state?.current;
  useEffect(() => {
    if (state?.production?.application && ['requested', 'waiting', 'preparing'].includes(state.production.application.state) || busy || (current && ['preparing', 'processing', 'stopping'].includes(current.status))) {
      const timer = setInterval(changed, 2000); return () => clearInterval(timer);
    }
  }, [state?.production?.application?.state, busy, current?.id, current?.status, changed]);
  useEffect(() => {
    if (current?.status === 'editing') void run('launch', async () => {
      await call('project.face.manual.launch', { projectId, sessionId: current.id }, 300_000); changed();
    });
  }, [current?.id, current?.status]);
  const action = (method: string, extra: Record<string, unknown> = {}, key = method) => run(key, async () => {
    await call(method, { projectId, expectedRevision: state?.revision, ...(current ? { sessionId: current.id } : {}), ...extra }, 300_000); changed();
  });
  return <Panel title="脸型">
    <div className="segmented" role="group" aria-label="脸型制作方式">
      {([['preserve', '保留原脸'], ['ai', '让 AI 设计'], ['manual', '我自己来']] as const).map(([mode, label]) => <button key={mode}
        aria-pressed={state?.mode === mode} className={state?.mode === mode ? 'active' : ''}
        onClick={() => void stop.run('mode', async () => { await call('project.face.mode', { projectId, mode, expectedRevision: state?.revision }, 300_000); changed(); })}>{label}</button>)}
    </div>
    {error ? <p className="banner warn">{error}</p> : null}
    {state?.mode === 'manual' ? <p>{state.acceptedSessionId ? '制作使用已接受的手动脸型。继续修改会形成新版本。' : 'AI 不设计脸型。制作保留原脸，等你接受手动版本后再更新。'}</p> : null}
    {state?.production ? <div aria-label="制作版本">
      <p>当前要求：{state.production.requirement?.mode === 'manual' ? state.production.requirement.manualVersion ? `手动脸型版本 ${state.production.requirement.manualVersion}` : state.production.missingInputs?.length ? '手动脸型内容缺失' : '手动脸型尚待接受' : state.production.requirement?.mode === 'design' ? '由 AI 设计脸型' : '保留原脸'}</p>
      <p>正在制作的版本：{state.production.making ? `${state.production.making.preparing?'准备工程 · ':''}${state.production.making.mode==='manual'?`手动脸型版本 ${state.production.making.manualVersion??'待核对'}`:state.production.making.mode==='design'?'由 AI 设计脸型':state.production.making.mode==='preserve'?'保留原脸':'冻结输入缺失，等待恢复'}` : '当前没有正在制作的版本'}</p>
      <p role="status">{state.production.application?.reason ?? (state.production.workflowId ? '正在按当前要求制作。' : '尚未开始制作。')}</p>
      {state.production.application?.needsContract || state.production.application?.rebuild?.checkpoint==='reconcile' ? <ContinuationRecovery projectId={projectId} application={state.production.application} revision={state.revision} refresh={refresh} changed={changed}/> : null}
      {state.production.missingInputs?.length ? <p role="alert">生产输入缺失，Harness 需要先恢复内容，已有证据保留。</p> : null}
      {state.production.application && ['failed','cancelled'].includes(state.production.application.state) ? <button onClick={()=>void action('project.production.continuation.resume',{continuationId:state.production!.application!.id})}>继续准备此版本</button> : null}
      {state.production.application && ['requested','waiting','preparing'].includes(state.production.application.state) ? <button onClick={()=>void action('project.production.continuation.cancel',{continuationId:state.production!.application!.id})}>停止版本准备</button> : null}
      <details><summary>最后接受的交付物与历史版本</summary>
        {state.production.deliveries?.length ? state.production.deliveries.map((delivery,i)=><p key={delivery.workflowId}>{i===0?'最后接受的交付物':'历史交付物'} · {delivery.acceptedAt}<br/><code>{delivery.packageHash}</code>{' '}
          <button onClick={()=>void run('delivery',async()=>setDeliveryFiles(await call('project.production.delivery',{projectId,workflowId:delivery.workflowId})))}>查看交付文件</button></p>) : <p>尚无已接受的交付物。</p>}
        {deliveryFiles ? <div><p>{deliveryFiles.verified?'交付文件与接受时的内容一致。':'交付文件缺失或已变化，请先核对；原接受记录保留。'}</p>
          {deliveryFiles.paths.map(file=><p key={file.path}>{file.exists?'文件位置：':'文件缺失：'}<code>{file.path}</code></p>)}</div> : null}
      </details>
    </div> : null}
    {current ? <p role="status">{labels[current.status] ?? current.status}</p> : null}
    {current?.reason ? <p className="banner warn">{current.reason}</p> : null}
    {current?.headAttachments ? <details><summary>头发和饰品复核：{current.headAttachments.checkedMeshes} 个邻近网格，{current.headAttachments.newNearContacts} 个新增邻近点</summary>
      {current.headAttachments.limitations.map(line => <p key={line}>{line}</p>)}</details> : null}
    {busy==='project.face.manual.done'?<p role="status">正在读取已保存的脸型并确认停止 Blender…</p>:busy==='launch'?<p role="status">正在打开 Blender…</p>:null}
    <div className="actions" data-face-session={current?.id} data-face-revision={state?.revision}>
      {state && state.targets.length > 1 ? <label>调整部位<select aria-label="调整部位" value={target} onChange={event => setTarget(event.target.value)}>
        <option value="">自动定位脸部</option>{state.targets.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label> : null}
      <button disabled={Boolean(busy)} onClick={() => void (current && ['opened', 'editing'].includes(current.status)
        ? action('project.face.manual.launch') : action('project.face.manual.open', target ? { targetId: target } : {}))}>在 Blender 中打开</button>
      {current && ['opened', 'editing'].includes(current.status) ? <button className="primary" disabled={Boolean(busy)}
        onClick={() => void action('project.face.manual.done')}>捏好了</button> : null}
      {current && !['accepted', 'cancelled'].includes(current.status) ? <button
        onClick={() => void stop.run('stop', async () => { await call('project.face.manual.cancel', { projectId, sessionId: current.id }, 300_000); changed(); })}>取消 / 中断</button> : null}
      {current?.status === 'cancelled' ? <button onClick={() => void action('project.face.manual.resume')}>继续手动捏脸</button> : null}
    </div>
    <p className="muted">请保存 Blender 文件后点“捏好了”。仅采纳造型键数值及允许放宽的范围；网格和受保护表情键的改动会被拒绝。原件保留。</p>
    <details><summary>安装或重新检测 Blender</summary>
      <p>需要 Blender {state?.blender.minimumVersion ?? '4.2'} 或更新版本。安装 Windows 版本后点“重新检测并打开”。</p>
      <a href={state?.blender.downloadUrl ?? 'https://www.blender.org/download/'} target="_blank" rel="noreferrer">下载 Blender</a>{' '}
      <button onClick={() => void action('project.face.manual.open', target ? { targetId: target } : {})}>重新检测并打开</button>
    </details>
    {current && ['awaiting', 'accepted'].includes(current.status) ? <FacePreviewView projectId={current.viewProjectId} workflowId={current.workflowId} refresh={refresh}
      accept={current.status === 'awaiting' ? { expectedHash: current.expectedHash, expectedRevision: state?.revision, changed } : undefined} /> : null}
    {state?.versions.length ? <details><summary>已接受的脸型版本</summary>
      {state.versions.map(version => <p key={version.id}>脸型版本 {version.version}{state.acceptedSessionId === version.id ? ' · 当前使用' : ''}{' '}
        <button onClick={() => void action('project.face.manual.rollback', { sessionId: version.id })}>回退到此版本</button></p>)}
    </details> : null}
    {current ? <details className="technical-details"><summary>交接文件与工程位置</summary><p>{current.blendPath}</p><p>{current.projectPath}</p></details> : null}
  </Panel>;
}

function ContinuationRecovery({projectId,application,revision,refresh,changed}:{projectId:string;application:Application;revision:number;refresh:number;changed:()=>void}) {
  const [packs]=useLoad<Array<{id:string;version:string;description:string}>>('project.production.continuation.contracts',refresh,[],{projectId});
  const [pack,setPack]=useState(''),[view,setView]=useState<{token:string;changes:string[];contracts:unknown}|null>(null);
  const [note,setNote]=useState(''),[retain,setRetain]=useState(false);const {busy,run}=useAction();
  const report=application.rebuild?.report;
  return <div>
    {application.needsContract ? <><p>原制作版本不能采用新的脸型输入。请选择后继制作版本并核对变化，旧执行和交付会保留。</p>
      <label>后继制作版本<select aria-label="后继制作版本" value={pack} onChange={event=>{setPack(event.target.value);setView(null);}}>
        <option value="">请选择</option>{packs.map(p=><option key={p.id} value={p.id}>{p.description||'正式制作版本'} · {p.version}</option>)}</select></label>
      <button disabled={!pack||Boolean(busy)} onClick={()=>void run('view',async()=>setView(await call('project.production.continuation.contract.view',{projectId,continuationId:application.id,packId:pack})))}>核对版本变化</button>
      {view ? <><p>这些制作阶段的合同会变化：{view.changes.join('、')||'保持原合同'}。准备和脸型以下的制作将重新检查。</p>
        <details className="technical-details"><summary>完整制作合同变化</summary><pre>{JSON.stringify(view.contracts,null,2)}</pre></details>
        <label>采用说明<input aria-label="采用说明" value={note} onChange={event=>setNote(event.target.value)}/></label>
        <button disabled={!note.trim()||Boolean(busy)} onClick={()=>void run('adopt',async()=>{await call('project.production.continuation.contract.adopt',{projectId,continuationId:application.id,expectedRevision:revision,packId:pack,token:view.token,note});changed();})}>采用此版本并重建检查</button></> : null}</> : null}
    {application.rebuild?.checkpoint==='reconcile' && report?.unknown.length ? <><p>以下旧工程修改无法确认来源。已有内容完整保留；发布新交付前需要你逐项核对。</p>
      <ul>{report.unknown.map(file=><li key={file.path}>{file.path}{file.deleted?'（已删除）':''}</li>)}</ul>
      <label><input type="checkbox" checked={retain} onChange={event=>setRetain(event.target.checked)}/>这些修改仅保留在旧工程，不进入新交付</label>
      <label>对账说明<input aria-label="对账说明" value={note} onChange={event=>setNote(event.target.value)}/></label>
      <button disabled={!retain||!note.trim()||Boolean(busy)} onClick={()=>void run('resolve',async()=>{await call('project.production.continuation.changes.resolve',{projectId,continuationId:application.id,expectedRevision:revision,reportHash:report.hash,retainOnly:report.unknown.map(f=>f.path),note});changed();})}>记录对账并继续制作</button></> : null}
  </div>;
}
