import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import React from 'react';
import ts from 'typescript';
const source=readFileSync(new URL('../../gui/src/face-preview.tsx',import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,'').replace(/export function/g,'function');
const compiled=ts.transpileModule(source+'\nglobalThis.Component=FacePreviewView;',{compilerOptions:{jsx:ts.JsxEmit.React,target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
type Element={type:unknown;props:Record<string,any>};
function elements(value:any):Element[]{if(Array.isArray(value))return value.flatMap(elements);return value?.props?[value,...elements(value.props.children)]:[];}
const text=(value:any):string=>Array.isArray(value)?value.map(text).join(''):value?.props?text(value.props.children):typeof value==='string'?value:'';
test('the shipped eight-image appearance button enables only after all current pictures load and calls the real acceptance method',async()=>{
  const images=['front','side','eyes-half','eyes-full'].flatMap(view=>['before','after'].map(version=>({id:version+'-'+view,version,view,sha256:'image-'+version+'-'+view,width:768,height:768})));
  const preview={status:'ready',mode:'design',visuallyAccepted:false,previewSha256:'current-preview',faceArtifactHash:'current-output',images,candidates:[{id:'candidate',candidateId:'big-tareme-eyes',candidateNumber:2,imageIds:images.filter(i=>i.version==='after').map(i=>i.id)}]};
  let cursor=0,effects:Array<()=>any>=[],refreshes=0,fault='';const states:any[]=[],calls:any[]=[];
  const context={React,useState:(initial:any)=>{const slot=cursor++;if(states[slot]===undefined)states[slot]=initial;return[states[slot],(value:any)=>states[slot]=typeof value==='function'?value(states[slot]):value];},
    useEffect:(action:()=>any)=>effects.push(action),useLoad:()=>[preview,null],useAction:()=>({busy:'',run:async(_key:string,action:()=>Promise<void>)=>action()}),
    errorText:(e:Error)=>e.message,when:(iso:string)=>iso,Panel:'section',FaceQualityReviewView:'section',call:async(method:string,params:any)=>{calls.push({method,params});
      const reads=(params.ids??[params.id]).map((id:string)=>({id,previewSha256:params.previewSha256,sha256:images.find(i=>i.id===id)?.sha256,dataUrl:'data:image/png;base64,fixture'}));
      if(fault==='missing')reads.pop();
      if(fault==='duplicate')reads[1]=reads[0];
      if(fault==='sha')reads[0].sha256='changed';
      if(fault==='preview')reads[0].previewSha256='stale';
      if(fault==='data')reads[0].dataUrl='file:///private';
      return reads;},Component:undefined};
  runInNewContext(compiled,context);const render=()=>{cursor=0;return(context.Component as any)({projectId:'project',workflowId:'workflow',refresh:1,accept:{expectedHash:'current-output',changed:()=>refreshes++}});};
  const button=()=>elements(render()).find(e=>e.type==='button'&&text(e).includes('接受这个效果'))!;
  render();effects[0]!();await new Promise(resolve=>setImmediate(resolve));effects=[];
  assert.equal(button().props.disabled,true,'downloaded bytes are not browser image load confirmation');
  const rendered=elements(render()).filter(e=>e.type==='img');assert.equal(rendered.length,8);
  assert.equal(calls.length,1,'the Gate reads its pictures through one batch call, not one call per picture');
  assert.equal(calls[0].method,'project.face.preview.images');assert.deepEqual([...calls[0].params.ids],images.map(i=>i.id));
  assert.match(text(render()),/候选效果 2（big-tareme-eyes）/,'a single compensated column retains its selected candidate identity');
  assert.ok(rendered.filter(e=>e.props.alt.startsWith('候选 ')).every(e=>e.props.alt.startsWith('候选 2')),'accessible image labels use the selected number too');
  assert.doesNotMatch(text(render()),/候选效果 1/);
  preview.candidates[0]!.candidateNumber=undefined as any;
  assert.match(text(render()),/当前脸型效果/,'historical output without an ordinal must not invent candidate 1');
  preview.candidates[0]!.candidateNumber=2;
  for(const image of rendered.slice(0,7))image.props.onLoad();assert.equal(button().props.disabled,true);
  rendered[7]!.props.onLoad();assert.equal(button().props.disabled,false,'the native eight-picture Gate must be usable');
  button().props.onClick();await new Promise(resolve=>setImmediate(resolve));
  const accept=calls.find(c=>c.method==='project.face.accept');assert.deepEqual(JSON.parse(JSON.stringify(accept.params)),{projectId:'project',workflowId:'workflow',expectedHash:'current-output',previewSha256:'current-preview'});assert.equal(refreshes,1);
  preview.faceArtifactHash='new-output';assert.equal(button().props.disabled,true,'a different output cannot use this Gate');
});
test('the batched picture read revokes the actual display before acceptance for every integrity fault',async()=>{
  const images=['front','side','eyes-half','eyes-full'].flatMap(view=>['before','after'].map(version=>({id:version+'-'+view,version,view,sha256:'image-'+version+'-'+view,width:768,height:768})));
  const preview={status:'ready',mode:'design',visuallyAccepted:false,previewSha256:'current-preview',faceArtifactHash:'current-output',images,candidates:[{id:'candidate',candidateId:'big-tareme-eyes',candidateNumber:2,imageIds:images.filter(i=>i.version==='after').map(i=>i.id)}]};
  let cursor=0,effects:Array<()=>any>=[],fault='';const states:any[]=[],calls:any[]=[];
  const context={React,useState:(initial:any)=>{const slot=cursor++;if(states[slot]===undefined)states[slot]=initial;return[states[slot],(value:any)=>states[slot]=typeof value==='function'?value(states[slot]):value];},
    useEffect:(action:()=>any)=>effects.push(action),useLoad:()=>[preview,null],useAction:()=>({busy:'',run:async(_key:string,action:()=>Promise<void>)=>action()}),
    errorText:(e:Error)=>e.message,when:(iso:string)=>iso,Panel:'section',FaceQualityReviewView:'section',call:async(method:string,params:any)=>{calls.push({method,params});
      const reads=(params.ids??[params.id]).map((id:string)=>({id,previewSha256:params.previewSha256,sha256:images.find(i=>i.id===id)?.sha256,dataUrl:'data:image/png;base64,fixture'}));
      if(fault==='missing')reads.pop();
      if(fault==='duplicate')reads[1]=reads[0];
      if(fault==='sha')reads[0].sha256='changed';
      if(fault==='preview')reads[0].previewSha256='stale';
      if(fault==='data')reads[0].dataUrl='file:///private';
      return reads;},Component:undefined};
  runInNewContext(compiled,context);
  const render=()=>{cursor=0;return(context.Component as any)({projectId:'project',workflowId:'workflow',refresh:1,accept:{expectedHash:'current-output',changed:()=>{}}});};
  const button=()=>elements(render()).find(e=>e.type==='button'&&text(e).includes('接受这个效果'));
  render();effects[0]!();await new Promise(resolve=>setImmediate(resolve));
  assert.ok(button(),'a complete batch of real picture bytes reaches the Gate');
  for(const kind of ['missing','duplicate','sha','preview','data']){
    fault=kind;effects[0]!();await new Promise(resolve=>setImmediate(resolve));
    assert.equal(elements(render()).filter(e=>e.type==='img').length,0,kind+' must revoke the actual display');
    assert.equal(button(),undefined,kind+' must withdraw the appearance Gate');
    assert.match(text(render()),/清单不完整|版本不一致|无法显示/,kind+' must say why the pictures cannot be confirmed');
  }
});
