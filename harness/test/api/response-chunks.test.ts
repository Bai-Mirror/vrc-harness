import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ApiClient } from '../../src/api/client.ts';
import { API_VERSION, apiEndpoint, LineBuffer, MAX_MESSAGE_BYTES, MAX_RESPONSE_BYTES, responseFrames } from '../../src/api/protocol.ts';
import { removeTemp } from '../fixtures/platform.ts';

test('LineBuffer consumes coalesced bounded frames but rejects oversized complete and partial lines',()=>{
  const lines=Array.from({length:40},()=>JSON.stringify({data:'界'.repeat(80_000)}));
  const wire=lines.join('\n')+'\n';assert.ok(Buffer.byteLength(wire)>MAX_MESSAGE_BYTES);
  assert.deepEqual(new LineBuffer().push(wire),lines);
  for(const end of ['', '\n'])assert.throws(()=>new LineBuffer().push('x'.repeat(MAX_MESSAGE_BYTES)+end),/消息过大/);
  const partial=new LineBuffer();assert.deepEqual(partial.push('{"data":"界'),[]);
  assert.deepEqual(partial.push('"}\n'),['{"data":"界"}']);
});

for(const fault of ['none','data','order','metadata','identity','incomplete','limit','count','disconnect'])
test(`real ApiClient/LineBuffer ${fault==='none'?'restores complete Unicode evidence':'rejects '+fault+' chunks'} without losing concurrent calls`,async t=>{
  const home=mkdtempSync(join(tmpdir(),'avh-chunk-client-'));mkdirSync(join(home,'run'));
  const sockets=new Set<Socket>();
  const evidence={identity:'frozen-preview',groups:['完整证据😀'.repeat(600_000)]};
  const server=createServer(socket=>{
    sockets.add(socket);socket.setEncoding('utf8');const lines=new LineBuffer();
    socket.on('data',chunk=>{for(const line of lines.push(String(chunk))){if(socket.writableEnded)return;const request=JSON.parse(line);
      if(request.method!=='large'){socket.write(JSON.stringify({id:request.id,result:request.method==='hello'?{api:API_VERSION}:{ok:true}})+'\n');continue;}
      assert.equal(request.responseChunks,'sha256-v1');
      const frames=[...responseFrames({id:request.id,result:evidence},true)].map(line=>JSON.parse(line));
      assert.ok(frames.length>1);
      if(fault==='data'){const b=Buffer.from(frames[0].chunk.data,'base64');b[0]^=1;frames[0].chunk.data=b.toString('base64');}
      if(fault==='order')[frames[0],frames[1]]=[frames[1],frames[0]];
      if(fault==='metadata')frames[1].chunk.sha256='0'.repeat(64);
      if(fault==='identity'){
        const wrong=[...responseFrames({id:request.id+50,result:evidence},true)].map(line=>JSON.parse(line));
        frames.splice(0,frames.length,...wrong.map(frame=>({...frame,id:request.id})));
      }
      if(fault==='incomplete')frames.splice(1,frames.length-1,{id:request.id,result:evidence.identity});
      if(fault==='limit')frames[0].chunk.bytes=MAX_RESPONSE_BYTES+1;
      if(fault==='count')frames[0].chunk.count++;
      if(fault==='disconnect'){socket.end(JSON.stringify(frames[0])+'\n');return;}
      // Deliberately coalesce many frames into one write: stream reads are not frame boundaries.
      socket.write(frames.map(frame=>JSON.stringify(frame)+'\n').join(''));
    }});
  });
  await new Promise<void>(resolve=>server.listen(apiEndpoint(home),resolve));
  t.after(async()=>{for(const socket of sockets)socket.destroy();await new Promise<void>(resolve=>server.close(()=>resolve()));removeTemp(home);});
  const client=await ApiClient.connect(home);t.after(()=>client.close());
  const large=client.call('large',{},3000),small=client.call('small',{},3000);
  if(fault==='none'){assert.deepEqual(await large,evidence);assert.deepEqual(await small,{ok:true});}
  else {await assert.rejects(large,/分块|连接已断开/);if(fault==='disconnect')await assert.rejects(small,/连接已断开/);else assert.deepEqual(await small,{ok:true});}
});

test('an older client receives a bounded explicit error instead of an oversized frame',()=>{
  const frames=[...responseFrames({id:1,result:'x'.repeat(MAX_MESSAGE_BYTES)})];
  assert.equal(frames.length,1);assert.ok(Buffer.byteLength(frames[0]!)<MAX_MESSAGE_BYTES);
  assert.equal(JSON.parse(frames[0]!).error.code,'UNAVAILABLE');
});
