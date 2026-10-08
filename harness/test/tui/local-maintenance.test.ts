import assert from 'node:assert/strict';
import test from 'node:test';
import { manageLocalMaintenance } from '../../src/tui/local-maintenance.ts';
import type { Ui } from '../../src/tui/core.ts';

test('TUI adopts the displayed immutable candidate only after an explicit scope decision',async()=>{
  for(const approve of [false,true]){
    const choices=['v','a',approve?'y':'b'],calls:Array<{method:string;params:Record<string,unknown>}>=[];
    const ui={api:{call:async(method:string,params:Record<string,unknown>)=>{
      calls.push({method,params});return{token:'view-token',current:null,notice:'仅后继制作',candidates:[
        {id:'candidate',version:'1-local',reason:'修复',verification:'相关隔离对照',contentHash:'a'.repeat(64),ready:true,defaultReady:false}]};}},
      openModal:(node:{props:{onChoose:(choice:string)=>void}})=>node.props.onChoose(choices.shift()!),closeModal:()=>{},rows:24,columns:80,
      act:async(_label:string,run:()=>Promise<unknown>)=>{await run();return true;},notify:()=>{}} as unknown as Ui;
    await manageLocalMaintenance(ui,'project');
    assert.equal(calls.length,approve?2:1);
    if(approve){const command=calls[1]!;assert.equal(command.method,'project.maintenance.adopt');
      assert.equal(command.params.scope,'project');assert.equal(command.params.expectedToken,'view-token');assert.equal(command.params.expectedHash,'a'.repeat(64));}
  }
});
