import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import React from 'react';
import ts from 'typescript';
const source=readFileSync(new URL('../../gui/src/technical-review.tsx',import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,'').replace(/export function/g,'function');
const compiled=ts.transpileModule(source+'\nglobalThis.Component=TechnicalReviewTask;', {compilerOptions:{jsx:ts.JsxEmit.React,target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
type Element={type:unknown;props:Record<string,any>};
function elements(value:any):Element[]{if(Array.isArray(value))return value.flatMap(elements);return value?.props?[value,...elements(value.props.children)]:[];}
const text=(value:any):string=>Array.isArray(value)?value.map(text).join(''):value?.props?text(value.props.children):typeof value==='string'||typeof value==='number'?String(value):'';
test('shipped technical review shows file changes and sends only checked paths with a Chinese explanation',async()=>{
  let selected:string[]=[],note='',cursor=0,refreshes=0;const calls:any[]=[];
  const detail={reviewToken:'current-review',outOfBounds:[{seq:1,artifact:'face',changes:{added:['Assets/_Harness/Face/new.meta'],removed:[],modified:[],counts:[1,0,0]}},{seq:2,artifact:'workspace:Assets/Other/file'}]};
  const context={React,useState:()=>cursor++===0?[selected,(x:any)=>selected=typeof x==='function'?x(selected):x]:[note,(x:string)=>note=x],
    useLoad:()=>[detail,null],useAction:()=>({busy:'',run:async(_key:string,action:()=>Promise<void>)=>action()}),
    stageLabel:()=> '脸型',Panel:'section',call:async(method:string,params:any)=>calls.push({method,params}),Component:undefined};
  runInNewContext(compiled,context);const render=()=>{cursor=0;return (context.Component as any)({task:{id:'task',stage:'face'},refresh:1,changed:()=>refreshes++});};
  const button=()=>elements(render()).find(e=>e.type==='button'&&text(e).includes('确认保留'))!;
  assert.match(render().props.title,/技术审阅/);assert.match(text(render()),/新增（1）/);assert.match(text(render()),/Assets\/_Harness\/Face\/new.meta/);
  assert.equal(button().props.disabled,true);
  elements(render()).find(e=>e.type==='input')!.props.onChange({target:{checked:true}});
  assert.equal(button().props.disabled,true,'review reason is required');
  elements(render()).find(e=>e.type==='textarea')!.props.onChange({target:{value:'仅确认受管 Unity 元数据生成。'}});
  assert.equal(button().props.disabled,false);button().props.onClick();await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(JSON.parse(JSON.stringify(calls)),[{method:'task.acceptChanges',params:{id:'task',paths:['face'],note:'仅确认受管 Unity 元数据生成。',expectedReviewToken:'current-review'}}]);assert.equal(refreshes,1);
  elements(render()).find(e=>e.type==='button'&&text(e).includes('停止'))!.props.onClick();await new Promise(resolve=>setImmediate(resolve));assert.equal(calls[1].method,'task.cancel');
});
test('technical review checks all unfinished stages so an unrelated blocker cannot hide review',()=>{
  const context={React,useState:()=>[],useLoad:()=>[[{id:'other',workflowId:'workflow',status:'BLOCKED'},{id:'review',workflowId:'workflow',status:'WAITING_HUMAN'},{id:'stopped',workflowId:'workflow',status:'CANCELLED'},{id:'uncertain',workflowId:'workflow',status:'RECOVERY_REQUIRED'},{id:'foreign',workflowId:'foreign',status:'BLOCKED'}],null],Component:undefined};
  const parent=ts.transpileModule(source+'\nglobalThis.Component=TechnicalReview;', {compilerOptions:{jsx:ts.JsxEmit.React,target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
  runInNewContext(parent,context);
  const tree=(context.Component as any)({project:'project',workflowId:'workflow',refresh:1,changed:()=>{}});
  assert.deepEqual(elements(tree).filter(e=>e.props.task).map(e=>e.props.task.id),['other','review','stopped','uncertain']);
});
