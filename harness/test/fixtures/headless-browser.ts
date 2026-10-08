import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { windowsAppBrowser } from '../../src/gui/server.ts';

export const testBrowser=process.env.AVH_GUI_BROWSER ?? (process.platform==='win32'?windowsAppBrowser():undefined);
/** Own a separate headless profile; never attach to a user's browser. */
export async function headlessBrowser(profile:string) {
  const child:ChildProcess=spawn(testBrowser!,['--headless=new',...(process.platform==='win32'&&/msedge\.exe$/i.test(testBrowser!)?['--edge-skip-compat-layer-relaunch']:[]),'--remote-debugging-port=0',`--user-data-dir=${profile}`,'--no-first-run','--no-default-browser-check','about:blank'],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  let stderr='';child.stderr?.setEncoding('utf8').on('data',chunk=>stderr+=chunk);
  let socket:WebSocket|undefined,next=0;
  const pending=new Map<number,{resolve:(value:any)=>void;reject:(error:Error)=>void}>();
  const close=async()=>{if(socket?.readyState===WebSocket.OPEN)try{await send('Browser.close');}catch{}socket?.close();if(child.exitCode===null){child.kill();await new Promise<void>(resolve=>{child.once('exit',()=>resolve());setTimeout(resolve,5000).unref();});}};
  const send=(method:string,params:Record<string,unknown>={})=>new Promise<any>((resolve,reject)=>{const id=++next;
    const timer=setTimeout(()=>{pending.delete(id);reject(new Error(`DevTools timed out: ${method}`));},15_000);
    pending.set(id,{resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);}});socket!.send(JSON.stringify({id,method,params}));});
  try {
    const active=join(profile,'DevToolsActivePort');
    let port=0;
    for(let i=0;i<150&&!port;i++){if(child.exitCode!==null)throw new Error(`Test browser exited before DevTools (${child.exitCode}): ${stderr}`);
      try{port=Number(readFileSync(active,'utf8').split('\n')[0]);}catch(error){if(!['ENOENT','EBUSY','EACCES'].includes((error as NodeJS.ErrnoException).code??''))throw error;}
      if(!port)await delay(100);}
    if(!port)throw new Error(`Test browser did not publish its DevTools port: ${stderr}`);
    const targets:any=await(await fetch(`http://127.0.0.1:${port}/json`)).json();
    socket=new WebSocket(targets.find((target:any)=>target.type==='page').webSocketDebuggerUrl);
    socket.addEventListener('message',event=>{const message=JSON.parse(String(event.data)),call=pending.get(message.id);if(call){pending.delete(message.id);message.error?call.reject(new Error(message.error.message)):call.resolve(message.result);}});
    socket.addEventListener('close',()=>{for(const call of pending.values())call.reject(new Error('DevTools closed'));pending.clear();});
    await new Promise<void>((resolve,reject)=>{socket!.addEventListener('open',()=>resolve(),{once:true});socket!.addEventListener('error',()=>reject(new Error('DevTools connect failed')),{once:true});});
    const evaluate=async(expression:string)=>{const value=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(value.exceptionDetails)throw new Error(JSON.stringify(value.exceptionDetails));return value.result.value;};
    const waitFor=async(expression:string,timeoutMs=15_000)=>{const deadline=Date.now()+timeoutMs;while(Date.now()<deadline){if(await evaluate(expression))return;await delay(100);}const body=await evaluate('document.body.innerText');if(process.env.AVH_GUI_EVIDENCE_DIR)writeFileSync(join(process.env.AVH_GUI_EVIDENCE_DIR,'gui-failure.txt'),`${expression}\n${body}`);throw new Error(`GUI condition timed out: ${expression}\n${body}`);};
    const click=async(label:string,selector='button,summary')=>{await waitFor(`(()=>{const b=[...document.querySelectorAll(${JSON.stringify(selector)})].find(x=>x.getClientRects().length&&!x.disabled&&x.textContent.includes(${JSON.stringify(label)}));if(!b||document.querySelector('.dialog-backdrop')&&!b.closest('.dialog-backdrop'))return false;b.click();return true;})()`);};
    return {send,evaluate,waitFor,click,close};
  } catch(error){await close();throw error;}
}
