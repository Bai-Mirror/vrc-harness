import React, { useEffect, useState } from 'react';
import { call } from './api';
import { errorText } from './model';

export type QualityReview={rawFindingCount:number;uniqueFindingCount:number;stateCount:number;groups:Array<Record<string,any>>;states:Array<Record<string,any>>;images:Array<Record<string,any>>;limitations:string[]};
const regionLabel=(value:string)=>({'left-eye':'左眼区域','right-eye':'右眼区域','lower-face':'脸部下方','upper-face':'脸部上方','face-center':'脸部中部'}[value]??value);
const kindLabel=(value:string)=>({'near-degenerate edge became visible':'原近退化边变长','edge distortion':'边长变化','newly degenerate triangle':'新增近退化三角形','triangle area distortion':'三角形面积变化','triangle flip':'三角形翻转','new dihedral crease':'折角增大','new non-adjacent self-intersections':'新增非相邻面相交'}[value]??value);
const baselineLabel=(value:string)=>({'source-small-edge':'原版已有近退化边','source-fold-increased':'原版已有折角，本轮增大',present:'原版同状态已有',new:'本轮新增相对变化',unmeasured:'原版同类标记未测'}[value]??value);
const stateLabel=(state:string,weight:unknown)=>state==='basis'?'默认状态':`${state} · ${Math.round(Number(weight)*100)}%`;
export function FaceQualityReviewView({review,projectId,workflowId,previewSha256}:{review:QualityReview;projectId:string;workflowId:string;previewSha256:string}) {
  const [selected,setSelected]=useState(''),[images,setImages]=useState<Record<string,string>>({}),[error,setError]=useState(''),[query,setQuery]=useState(''),[page,setPage]=useState(0);
  const current=review.groups.find(g=>g.id===selected)??review.groups[0];
  useEffect(()=>{let live=true;setImages({});setError('');if(!current)return;
    void (async()=>{try{const reads=await call<Array<{id:string;previewSha256:string;sha256:string;dataUrl:string}>>('project.face.preview.images',{projectId,workflowId,previewSha256,ids:current.imageIds},300_000);
      if(reads.length!==current.imageIds.length||new Set(reads.map(read=>read.id)).size!==reads.length)throw new Error('发现特写清单不完整，请重新查看。');
      const pairs=current.imageIds.map((id:string)=>{const image=review.images.find(i=>i.id===id),response=reads.find(read=>read.id===id);
      if(!response)throw new Error('发现特写清单不完整，请重新查看。');
      if(response.id!==id||response.previewSha256!==previewSha256||response.sha256!==image?.sha256||!response.dataUrl.startsWith('data:image/png;base64,'))throw new Error('发现特写版本已变化，请重新查看。');return[id,response.dataUrl];});
      if(live)setImages(Object.fromEntries(pairs));}catch(reason){if(live)setError(errorText(reason));}})();return()=>{live=false;};
  },[projectId,workflowId,previewSha256,current?.id]);
  const states=review.states.filter(r=>!query||`${r.state} ${regionLabel(r.region)} ${kindLabel(r.kind)}`.toLowerCase().includes(query.toLowerCase()));
  return <section className="stack"><h4>发现摘要与原版对照</h4>
    <p>已检查 {review.stateCount} 个状态。原始算法标记 {review.rawFindingCount.toLocaleString()} 条，去除同状态重复后 {review.uniqueFindingCount.toLocaleString()} 条，汇总为 {review.groups.length} 个区域与类型。标记数量不是肉眼可见缺陷数，质量发现留给你看图判断。</p>
    <div style={{overflowX:'auto'}}><table><thead><tr><th>区域 / 类型</th><th>原版情况</th><th>涉及状态 / 去重标记</th><th>最大位移 / 特写像素估计</th><th>特写</th></tr></thead><tbody>{review.groups.map(g=><tr key={g.id}>
      <td>{regionLabel(g.region)} · {kindLabel(g.kind)}</td><td>{baselineLabel(g.baseline)}</td><td>{g.stateCount} / {g.uniqueCount}</td>
      <td>{g.maximumChangeMm.toFixed(4)} mm / {g.estimatedChangePixels.toFixed(2)} px</td><td><button onClick={()=>setSelected(g.id)}>查看代表状态</button></td></tr>)}</tbody></table></div>
    {current?<><p>{regionLabel(current.region)} · {kindLabel(current.kind)}；特写代表状态：{stateLabel(current.representativeState,current.representativeWeight)}。局部几何最大范围约 {current.maximumFootprintMm.toFixed(3)} mm。</p>
      {error?<div className="banner warn">{error}</div>:<div style={{display:'grid',gridTemplateColumns:'repeat(2,minmax(0,1fr))',gap:12}}>{current.imageIds.map((id:string)=>{const image=review.images.find(i=>i.id===id);if(!image)return <p key={id}>发现特写清单不完整，请重新读取。</p>;return <figure key={id} style={{margin:0}}>
        {images[id]?<img src={images[id]} width={image.width} height={image.height} alt={`${image.version==='before'?'原版':'新版'}同状态区域特写`} onError={()=>setError('发现特写无法显示，请重新读取。')} style={{width:'100%',height:'auto'}}/>:<p>正在读取实际特写…</p>}
        <figcaption>{image.version==='before'?'原版':'新版'} · {String(image.view).endsWith('front')?'正面':'侧面'} · {stateLabel(image.state,image.weight)}</figcaption></figure>;})}</div>}</>:null}
    {review.limitations.map((note,index)=><p className="muted" key={index}>{note}</p>)}
    <details><summary>按状态、区域、类型查看汇总（原始标记保留为运行证据）</summary>
      <label>查找状态或区域 <input value={query} onChange={event=>{setQuery(event.target.value);setPage(0);}}/></label>
      <p>{states.length} 组；第 {page+1} 页</p><table><thead><tr><th>状态</th><th>区域 / 类型</th><th>原版情况</th><th>去重 / 原始</th></tr></thead><tbody>{states.slice(page*20,page*20+20).map((r,index)=><tr key={index}><td>{stateLabel(r.state,r.weight)}</td><td>{regionLabel(r.region)} · {kindLabel(r.kind)}</td><td>{baselineLabel(r.baseline)}</td><td>{r.uniqueCount} / {r.rawCount}</td></tr>)}</tbody></table>
      <div className="actions"><button disabled={page===0} onClick={()=>setPage(p=>p-1)}>上一页</button><button disabled={(page+1)*20>=states.length} onClick={()=>setPage(p=>p+1)}>下一页</button></div>
    </details></section>;
}
