import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import React from 'react';
import ts from 'typescript';
const source=readFileSync(new URL('../../gui/src/face-quality-review.tsx',import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,'').replace(/export function/g,'function').replace(/export type/g,'type');
const compiled=ts.transpileModule(source+'\nglobalThis.Component=FaceQualityReviewView;',{compilerOptions:{jsx:ts.JsxEmit.React,target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
type Element={type:unknown;props:Record<string,any>};
function elements(value:any):Element[]{if(Array.isArray(value))return value.flatMap(elements);return value?.props?[value,...elements(value.props.children)]:[];}
const text=(value:any):string=>Array.isArray(value)?value.map(text).join(''):value?.props?text(value.props.children):typeof value==='string'||typeof value==='number'?String(value):'';
test('shipped quality material uses Chinese aggregate and baseline labels, paginates states and reads only the chosen representative images',async()=>{
  const images=['front','side'].flatMap(view=>['before','after'].map(version=>({id:version+'-'+view,version,view,sha256:'sha-'+version+'-'+view,width:768,height:768,state:'Blink',weight:.5})));
  const row={id:'left-edge',region:'left-eye',kind:'near-degenerate edge became visible',baseline:'source-small-edge',rawCount:158376,uniqueCount:79188,stateCount:1335,maximumChangeMm:.001,maximumFootprintMm:.1,estimatedChangePixels:.02,representativeState:'Blink',representativeWeight:.5,imageIds:images.map(i=>i.id)};
  const review={rawFindingCount:158376,uniqueFindingCount:79188,stateCount:1335,groups:[row],states:Array.from({length:22},(_,index)=>({...row,state:'State'+index,weight:.5})),images,limitations:['表面遮挡和纹理 alpha 尚未测量。']};
  let cursor=0,fault='';const states:any[]=[],calls:any[]=[],effects:Array<()=>any>=[];
  const context={React,useState:(initial:any)=>{const slot=cursor++;if(states[slot]===undefined)states[slot]=initial;return[states[slot],(value:any)=>states[slot]=typeof value==='function'?value(states[slot]):value];},useEffect:(action:()=>any)=>effects.push(action),
    errorText:(e:Error)=>e.message,call:async(method:string,params:any)=>{calls.push({method,params});const reads=params.ids.map((id:string)=>({id,previewSha256:params.previewSha256,sha256:images.find(i=>i.id===id)?.sha256,dataUrl:'data:image/png;base64,fixture'})).reverse();
      if(fault==='missing')reads.pop();if(fault==='duplicate')reads[1]=reads[0];if(fault==='sha')reads[0].sha256='changed';if(fault==='preview')reads[0].previewSha256='stale';if(fault==='data')reads[0].dataUrl='file:///private';return reads;},Component:undefined};
  runInNewContext(compiled,context);const render=()=>{cursor=0;return(context.Component as any)({review,projectId:'project',workflowId:'workflow',previewSha256:'preview'});};
  render();effects[0]!();await new Promise(resolve=>setImmediate(resolve));
  const shown=text(render());assert.match(shown,/左眼区域/);assert.match(shown,/原版已有近退化边/);assert.match(shown,/标记数量不是肉眼可见缺陷数/);assert.match(shown,/0.0010 mm \/ 0.02 px/);assert.match(shown,/表面遮挡和纹理 alpha 尚未测量/);
  assert.equal(calls.length,1);assert.equal(calls[0].method,'project.face.preview.images');assert.deepEqual([...calls[0].params.ids],images.map(i=>i.id));
  assert.equal(elements(render()).filter(e=>e.type==='img').length,4);
  assert.doesNotMatch(shown,/State20/);elements(render()).find(e=>e.type==='button'&&text(e)==='下一页')!.props.onClick();assert.match(text(render()),/State20/);
  for(fault of ['missing','duplicate','sha','preview','data']){
    effects[0]!();await new Promise(resolve=>setImmediate(resolve));
    assert.equal(elements(render()).filter(e=>e.type==='img').length,0,fault+' must revoke the actual display');
    assert.match(text(render()),/清单不完整|版本已变化/);
  }
});
