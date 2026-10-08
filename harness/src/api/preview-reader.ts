import { Worker } from 'node:worker_threads';
import { extname } from 'node:path';
import { ApiError } from './protocol.ts';

/**
 * Reads one picture set per worker outside the Runtime event loop, for every picture the interface shows back: face
 * renders, recolour candidates and outfit photos. The worker has no database write authority, and the queue bounds how
 * many reads run at once so a slow picture never delays the Runtime's stop, handshake or status queries.
 */
export class PreviewReader {
  private active=new Set<Worker>();
  private queue: Array<{run:()=>void;reject:(error:Error)=>void}>=[];
  private closed=false;
  read(database:string,method:string,params:Record<string,unknown>):Promise<unknown> {
    return new Promise((resolve,reject)=>{
      const run=()=>{
        if(this.closed){reject(new ApiError('UNAVAILABLE','预览读取服务已停止'));return;}
        const worker=new Worker(new URL('./preview-worker'+extname(import.meta.url),import.meta.url),{workerData:{database,method,params}});
        this.active.add(worker);let settled=false;
        const finish=(error?:Error,result?:unknown)=>{if(settled)return;settled=true;clearTimeout(timer);this.active.delete(worker);void worker.terminate();
          if(error)reject(error);else resolve(result);this.queue.shift()?.run();};
        const timer=setTimeout(()=>finish(new ApiError('UNAVAILABLE','预览完整性校验超时')),300_000);
        worker.once('message',message=>finish(message.error?new Error(message.error.message):undefined,message.result));
        worker.once('error',error=>finish(error));
        worker.once('exit',()=>finish(new ApiError('UNAVAILABLE','预览读取进程提前退出')));
      };
      if(this.closed)reject(new ApiError('UNAVAILABLE','预览读取服务已停止'));
      else if(this.active.size<2)run();else this.queue.push({run,reject});
    });
  }
  close():void {
    this.closed=true;
    for(const job of this.queue.splice(0))job.reject(new ApiError('UNAVAILABLE','预览读取服务已停止'));
    for(const worker of this.active)void worker.terminate();
  }
}
