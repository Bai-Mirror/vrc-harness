import React, { useEffect, useState } from 'react';
import { call } from './api';
import { when } from './labels';
import { errorText } from './model';
import { Panel, useAction, useLoad } from './ui';
import { FaceQualityReviewView, type QualityReview } from './face-quality-review';

type Image = { id: string; version: 'before' | 'after'; view: 'front' | 'side' | 'eyes-half' | 'eyes-full'; sha256: string; width: number; height: number };
type Preview = { status: 'ready'; previewSha256: string; visuallyAccepted: boolean; images: Image[]; mode: string;
  candidateSetSha256?:string;expectedHash?:string;faceArtifactHash?:string;qualityReview?:QualityReview;generatedAt?:string;
  candidates: Array<{ id: string; candidateId?:string; candidateNumber?:number; revisionSha256: string; outputSha256?: string; imageIds: string[] }> } | { status: 'missing'; reason: string };

/** Only actual version-bound PNGs from Runtime enter this view. No example image or generated placeholder is a result. */
export function FacePreviewView({ projectId, workflowId, refresh, candidateMode=false, choose, accept, onlyWhenReady=false, compact=false }: { projectId: string; workflowId: string; refresh: number;
  candidateMode?:boolean;choose?:{expectedHash:string;expectedInputs?:Record<string,string>;changed:()=>void};accept?:{expectedRevision?:number;expectedHash:string;expectedInputs?:Record<string,string>;changed:()=>void};onlyWhenReady?:boolean;compact?:boolean }) {
  const {busy,run}=useAction();
  const [preview, error] = useLoad<Preview | null>(candidateMode?'project.face.candidates.preview':'project.face.preview', refresh, null, { projectId, workflowId });
  const [images, setImages] = useState<Record<string, string>>({}), [imageError, setImageError] = useState('');
  const [loaded, setLoaded] = useState<Record<string, boolean>>({});
  const version = preview?.status === 'ready' ? preview.previewSha256 : '';
  useEffect(() => {
    let live = true; setImages({}); setLoaded({}); setImageError('');
    if (preview?.status === 'ready') {
      void (async()=>{
        type Read={ id: string; previewSha256: string; sha256: string; dataUrl: string };
        const reads=candidateMode?await Promise.all(preview.images.map(image=>call<Read>('project.face.candidates.preview.image',
          {projectId,workflowId,previewSha256:preview.previewSha256,id:image.id},300_000)))
          :await call<Read[]>('project.face.preview.images',{projectId,workflowId,previewSha256:preview.previewSha256,ids:preview.images.map(image=>image.id)},300_000);
        if(reads.length!==preview.images.length||new Set(reads.map(read=>read.id)).size!==reads.length)throw new Error('脸型图片清单不完整，请刷新。');
        return preview.images.map(image=>{const read=reads.find(read=>read.id===image.id);
        if(!read)throw new Error('脸型图片清单不完整，请刷新。');
        if (read.id !== image.id || read.previewSha256 !== preview.previewSha256 || read.sha256 !== image.sha256 || !read.dataUrl.startsWith('data:image/png;base64,'))
          throw new Error('脸型图片版本不一致，请刷新制作进度。');
        return [image.id, read.dataUrl] as const;
      });})().then(read => { if (live) setImages(Object.fromEntries(read)); }).catch(reason => { if (live) setImageError(errorText(reason)); });
    }
    return () => { live = false; };
  }, [projectId, workflowId, version, refresh,candidateMode]);
  const ready = preview?.status === 'ready' ? preview : null;
  const allLoaded = Boolean(ready && ready.images.every(image => loaded[image.id]));
  const revoke = (reason: unknown) => {setImages({});setLoaded({});setImageError(errorText(reason));};
  const chooseButton = (id:string,index:number) => choose&&candidateMode&&ready ? <div className="actions"><button className="primary"
    disabled={Boolean(busy)||!allLoaded||ready.expectedHash!==choose.expectedHash||!ready.candidateSetSha256}
    onClick={()=>void run(id,async()=>{
      if(!ready.candidateSetSha256||ready.expectedHash!==choose.expectedHash)throw new Error('候选版本已变化，请重新查看。');
      try {await call('project.face.choose',{projectId,workflowId,candidateId:id,candidateSetSha256:ready.candidateSetSha256,
        previewSha256:ready.previewSha256,expectedHash:choose.expectedHash,expectedInputs:choose.expectedInputs},300_000);choose.changed();}
      catch(reason){revoke(reason);choose.changed();throw reason;}
    },'已选择此目标，Harness 会继续计算表情补偿并生成工程候选')}>{busy===id?'正在记录选择…':`选择候选 ${index+1}`}</button></div> : null;
  if (onlyWhenReady && !ready && !error && !imageError) return null;
  if (compact && (!ready || error || imageError || !Object.keys(images).length)) return null;
  if (compact && ready) {
    const image = ready.images.find(item => item.view === 'front') ?? ready.images[0];
    return <section className="preview-strip" aria-label="脸型预览缩略条">
      {image && images[image.id] ? <img src={images[image.id]} alt="脸型预览缩略图" width={image.width} height={image.height} /> : null}
      <span><b>{candidateMode ? '脸型候选' : '当前脸型效果'}</b><small>来源：Unity 渲染{ready.generatedAt ? ` · ${when(ready.generatedAt)}` : ''}</small></span>
      <span className="muted">点击查看场景</span>
    </section>;
  }
  return <Panel title="脸型效果对照">
    <p className="reason">前后图使用同一相机、灯光、默认姿态和背景。真实预览便于核对效果，工程检查通过和图片出现都不代表审美接受。</p>
    {error || imageError ? <div className="banner warn">{error || imageError} 当前不能用这些图片确认脸型效果。</div>
      : preview?.status === 'missing' ? <p>{preview.reason}</p> : !ready || !Object.keys(images).length ? <p>正在读取实际脸型图片…</p> : <>
        <p>{candidateMode?'组合目标预览，尚未补偿烘焙':ready.visuallyAccepted?'已接受当前版本的外观效果':ready.mode==='preserve'?'保留原有脸型的实际工程对照':'尚未接受当前版本的外观效果'}</p>
        <p className="muted">来源：Unity 渲染{ready.generatedAt?` · 生成于 ${when(ready.generatedAt)}`:''}。</p>
        <div style={{display:'grid',gridTemplateColumns:`repeat(${Math.min(3,ready.candidates.length+1)}, minmax(0, 1fr))`,gap:12}}>
          {[{id:'source',candidateNumber:undefined,candidateId:undefined,imageIds:ready.images.filter(image=>image.version==='before').map(image=>image.id)},...ready.candidates].map((column,index)=><div key={column.id} className="stack">
            <p>{index===0?'原有脸型':column.candidateNumber?`候选效果 ${column.candidateNumber}${column.candidateId?`（${column.candidateId}）`:''}`:'当前脸型效果'}</p>
            {(['front','side','eyes-half','eyes-full'] as const).map(view=>{
              const image=ready.images.find(image=>image.view===view&&column.imageIds.includes(image.id));
              return image?<figure key={view} style={{margin:0}}><img src={images[image.id]}
                alt={`${index===0?'原有脸型':column.candidateNumber?`候选 ${column.candidateNumber}`:'当前脸型效果'}${view==='front'?'正面':view==='side'?'侧面':view==='eyes-half'?'半闭眼特写':'闭眼特写'}真实预览`}
                onLoad={()=>setLoaded(current=>({...current,[image.id]:true}))}
                onError={()=>revoke(new Error('实际脸型图片无法显示，请重新读取后确认。'))}
                style={{width:'100%',height:'auto'}} width={image.width} height={image.height}/>
                <figcaption>{view==='front'?'正面':view==='side'?'侧面':view==='eyes-half'?'半闭眼特写':'闭眼特写'}</figcaption></figure>:null;
            })}
            {index>0?chooseButton(column.id,index-1):null}
          </div>)}
        </div>
        {accept&&!candidateMode&&ready.mode==='design'&&!ready.visuallyAccepted ? <div className="actions"><button className="primary"
          disabled={Boolean(busy)||!allLoaded||![4,8].includes(ready.images.length)||ready.faceArtifactHash!==accept.expectedHash}
          onClick={()=>void run('accept',async()=>{
            try {await call('project.face.accept',{projectId,workflowId,expectedHash:accept.expectedHash,expectedInputs:accept.expectedInputs,expectedRevision:accept.expectedRevision,previewSha256:ready.previewSha256},300_000);accept.changed();}
            catch(reason){revoke(reason);accept.changed();throw reason;}
          },'已接受当前脸型效果，Harness 会继续制作工程')}>{busy==='accept'?'正在记录确认…':'接受这个效果'}</button></div>:null}
        <p className="muted">{candidateMode?'这些图片来自原模型的实际形态键组合。选择只确定目标；表情补偿、烘焙和破损检查仍需后续完成。':'当前为实际工程前后对照，不能代替多方案目标选择或表情补偿验证。'} 修改方向可直接写在项目对话中。</p>
        {!candidateMode&&ready.qualityReview?<FaceQualityReviewView review={ready.qualityReview} projectId={projectId} workflowId={workflowId} previewSha256={ready.previewSha256}/>:null}
        <details className="technical-details"><summary>预览版本与候选记录</summary><pre>{JSON.stringify({ previewSha256: ready.previewSha256, candidates: ready.candidates }, null, 2)}</pre></details>
      </>}
  </Panel>;
}
