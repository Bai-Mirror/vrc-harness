import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import React from 'react';
import ts from 'typescript';
import { guiRoute } from '../../src/gui/server.ts';

const source=readFileSync(new URL('../../gui/src/local-maintenance.tsx',import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,'').replace(/export /g,'');
const compiled=ts.transpileModule(`${source}\nglobalThis.renderMaintenance=LocalMaintenance;`,{
  compilerOptions:{jsx:ts.JsxEmit.React,target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
type Element={type:unknown;props:Record<string,unknown>};
function elements(value:unknown):Element[]{
  if(Array.isArray(value))return value.flatMap(elements);
  if(!value||typeof value!=='object'||!('props' in value))return[];
  const element=value as Element;return[element,...elements(element.props.children)];
}
function text(value:unknown):string {
  if(Array.isArray(value))return value.map(text).join('');
  return value&&typeof value==='object'&&'props' in value?text((value as Element).props.children):typeof value==='string'?value:'';
}
test('GUI local adoption sends reviewed identity only after confirmation; stale errors never show success',async()=>{
  for(const scenario of ['cancel','adopt','stale']){
    const calls:Array<{method:string;params:Record<string,unknown>}>=[],success:string[]=[],errors:string[]=[];let refresh=0;
    const view={token:'shown-token',current:null,history:[],notice:'仅后继制作',candidates:[{id:'candidate',version:'1-local',reason:'修复',
      contentHash:'b'.repeat(64),ready:true,defaultReady:false,verification:'仅结构检查',problem:null}]};
    const context={React,crypto:{randomUUID},Panel:'section',useLoad:()=>[view,''],
      useFeedback:()=>({confirm:async()=>scenario!=='cancel'}),
      useAction:()=>({busy:'',run:async(_key:string,action:()=>Promise<void>,message?:string)=>{try{await action();if(message)success.push(message);}
        catch(error){errors.push(String(error));}}}),
      call:async(method:string,params:Record<string,unknown>)=>{calls.push({method,params});if(scenario==='stale')throw new Error('本地维护状态已变化');},
      renderMaintenance:undefined as unknown};
    runInNewContext(compiled,context);
    const tree=(context.renderMaintenance as (props:unknown)=>unknown)({projectId:'project',refresh:0,changed:()=>{refresh++;}});
    const buttons=elements(tree).filter(e=>e.type==='button');
    assert.equal(buttons.find(e=>text(e.props.children)==='设为本机默认')!.props.disabled,true,'smoke cannot select local policy');
    (buttons.find(e=>text(e.props.children)==='本项目采用')!.props.onClick as ()=>void)();
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(calls.length,scenario==='cancel'?0:1);
    if(calls.length){assert.equal(calls[0]!.method,'project.maintenance.adopt');assert.equal(calls[0]!.params.expectedToken,'shown-token');
      assert.equal(calls[0]!.params.expectedHash,'b'.repeat(64));assert.equal(calls[0]!.params.scope,'project');}
    assert.equal(refresh,scenario==='adopt'?1:0);assert.equal(success.length,scenario==='adopt'?1:0);assert.equal(errors.length,scenario==='stale'?1:0);
  }
});
test('GUI bridge admits exactly the implemented local maintenance methods',()=>{
  assert.equal(guiRoute('project.maintenance.show',true),'runtime');assert.equal(guiRoute('project.maintenance.adopt',true),'runtime');
  assert.equal(guiRoute('project.maintenance.grant',true),'refused');
});
