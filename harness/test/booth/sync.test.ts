import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openDatabase } from '../../src/state/db.ts';
import { BoothSyncStopped, parseLibraryPage, syncBoothLibrary, syncMessage } from '../../src/booth/sync.ts';
import { upsertBoothFile, upsertBoothItem } from '../../src/booth/catalog.ts';
import { removeTemp } from '../fixtures/platform.ts';

const page=`<nav><a href="?page=2">2</a></nav><article><a href="https://booth.pm/ja/items/123"><img></a>
  <a href="/items/123">春日衣装完整版</a><div class="js-download-button" data-href="https://booth.pm/downloadables/456">下载</div>
  <a href="/downloadables/457">差分</a></article>`;

test('library parser anchors on item and downloadable structure, including data-href',()=>{
  assert.deepEqual(parseLibraryPage(page),{lastPage:2,entries:[{itemId:'123',name:'春日衣装完整版',downloadableIds:['456','457'],gift:false}]});
  assert.throws(()=>parseLibraryPage('<main>/downloadables/999</main>'),/页面结构可能已变化/);
});

test('metadata-only sync reads purchases and gifts and probes files without downloading bodies',async t=>{
  const root=mkdtempSync(join(tmpdir(),'avh-sync-')),db=openDatabase(join(root,'state.sqlite'));t.after(()=>{db.close();removeTemp(root);});
  const seen:Array<[string,string]>=[];
  const fetcher=(async(input:URL|string,init?:RequestInit)=>{const url=String(input),method=init?.method??'GET';seen.push([method,url]);
    if(url.includes('accounts.booth.pm/library/gifts'))return new Response('<main></main>');
    if(url.includes('accounts.booth.pm/library?page=1'))return new Response(page);
    if(url.includes('accounts.booth.pm/library?page=2'))return new Response('<main></main>');
    if(url.endsWith('/items/123.json'))return Response.json({id:123,name:'春日衣装',url:'https://booth.pm/ja/items/123',shop:{name:'Example'},category:{name:'3D衣装'},tags:[{name:'Kaguya'}],images:[{original:'https://img/1.jpg'}]});
    if(url.endsWith('/downloadables/456'))return new Response(null,{status:302,headers:{location:'https://download.booth.pm/files/%E8%A1%A3%E8%A3%85.zip'}});
    if(url.endsWith('/downloadables/457'))return new Response(null,{status:302,headers:{location:'https://download.booth.pm/files/diff.zip'}});
    if(method==='HEAD')return new Response(null,{headers:{'content-length':'2048',etag:'"e-1"','last-modified':'Wed, 30 Sep 2026 01:00:00 GMT'}});
    throw new Error(`unexpected ${method} ${url}`);
  }) as typeof fetch;
  const result=await syncBoothLibrary(db,'secret-session-value',{fetcher,intervalMs:0});
  assert.deepEqual(result,{mode:'quick',items:1,files:2,pages:3,itemsRead:1,itemsUnchanged:0,unavailableItems:0,filesProbed:2,filesUnchanged:0,
    newFiles:2,unavailableFiles:0,unknownSizes:0,probes:{'head:ok':2},requests:8,truncated:false});
  assert.deepEqual({...db.prepare('SELECT item_id AS itemId,name,shop_name AS shop,owned,status FROM booth_item').get()},
    {itemId:'123',name:'春日衣装',shop:'Example',owned:1,status:'available'});
  // The remote version clue: the name BOOTH serves the file under, its size, ETag and Last-Modified.
  assert.deepEqual(db.prepare('SELECT downloadable_id AS id,filename,byte_size AS size,status,remote_version AS clue,probe_outcome AS probe FROM booth_file ORDER BY id').all().map(row=>({...row})),[
    {id:'456',filename:'衣装.zip',size:2048,status:'available',clue:'{"name":"衣装.zip","size":2048,"etag":"\\"e-1\\"","lastModified":"Wed, 30 Sep 2026 01:00:00 GMT"}',probe:'head:ok'},
    {id:'457',filename:'diff.zip',size:2048,status:'available',clue:'{"name":"diff.zip","size":2048,"etag":"\\"e-1\\"","lastModified":"Wed, 30 Sep 2026 01:00:00 GMT"}',probe:'head:ok'}]);
  assert.equal(seen.filter(([method])=>method==='GET').some(([,url])=>url.includes('download.booth.pm')),false,'sync never downloads heavy file bytes');
});

function library(t:{after(fn:()=>void):void}){
  const root=mkdtempSync(join(tmpdir(),'avh-sync-')),db=openDatabase(join(root,'state.sqlite'));t.after(()=>{db.close();removeTemp(root);});
  return db;
}
const twoItems=`<article><a href="/items/1">一</a><a href="/downloadables/11">下载</a></article>
  <article><a href="/items/2">二</a><a href="/downloadables/21">下载</a><a href="/downloadables/22">下载</a></article>`;
type Override=(url:string,method:string,init:RequestInit|undefined)=>Response|undefined;
/** A BOOTH double: `override` answers first, then a plain two-item library whose file host sizes files by HEAD. */
function booth(override:Override=()=>undefined,listing=()=>twoItems){
  const seen:string[]=[],sent:Array<{url:string;cookie:boolean}>=[];
  const fetcher=(async(input:URL|string,init?:RequestInit)=>{const url=String(input),method=init?.method??'GET';
    const range=(init?.headers as Record<string,string>|undefined)?.range;
    seen.push(`${method} ${url}${range?` [${range}]`:''}`);sent.push({url,cookie:Boolean((init?.headers as Record<string,string>|undefined)?.cookie)});
    const answer=override(url,method,init);if(answer)return answer;
    if(url.includes('library/gifts'))return new Response('<main></main>');
    if(url.includes('library?page=1'))return new Response(listing());
    if(url.includes('library?page='))return new Response('<main></main>');
    if(/\/items\/\d+\.json$/.test(url))return Response.json({name:'商品',category:{name:'3D衣装'},tags:[{name:'Kaguya'}]});
    if(url.includes('/downloadables/'))return new Response(null,{status:302,headers:{location:`https://cdn.example/${url.split('/').pop()}/same.zip?X-Amz-Signature=signed-secret`}});
    if(method==='HEAD')return new Response(null,{headers:{'content-length':'100'}});
    if(range)return new Response(null,{status:206,headers:{'content-range':'bytes 0-0/100'}});
    throw new Error(`unexpected ${method} ${url}`);
  }) as typeof fetch;
  return{fetcher,seen,sent};
}
const itemJson=(lines:string[])=>lines.filter(line=>/\/items\/\d+\.json$/.test(line));
const resolves=(lines:string[])=>lines.filter(line=>line.includes('/downloadables/'));
const fileHost=(lines:string[])=>lines.filter(line=>line.includes('cdn.example'));

test('sync spaces BOOTH requests and does not pace the file host',async t=>{
  const db=library(t),{fetcher,seen}=booth(),waits:number[]=[];
  await syncBoothLibrary(db,'secret-session-value',{fetcher,sleep:async ms=>{waits.push(ms);}});
  const boothRequests=seen.filter(line=>/^\S+ https:\/\/([a-z]+\.)?booth\.pm\//.test(line)).length;
  assert.equal(waits.length,boothRequests-1,seen.join('\n'));
  assert.ok(waits.every(ms=>ms>900&&ms<=1000),String(waits));
  assert.ok(seen.some(line=>line.startsWith('HEAD https://cdn.example/')),'sizes are still probed');
});

test('the signed file URL is only used: the session never goes to the file host and nothing stores the URL',async t=>{
  const db=library(t),{fetcher,sent}=booth();
  await syncBoothLibrary(db,'secret-session-value',{fetcher,intervalMs:0});
  assert.ok(sent.filter(request=>request.url.includes('booth.pm')).every(request=>request.cookie));
  assert.ok(sent.filter(request=>request.url.includes('cdn.example')).every(request=>!request.cookie));
  const stored=JSON.stringify([db.prepare('SELECT * FROM booth_file').all(),db.prepare('SELECT * FROM booth_item').all(),db.prepare('SELECT * FROM event').all()]);
  assert.doesNotMatch(stored,/signed-secret|cdn\.example/);
});

test('HTTP 429 or a BOOTH server error stops the sync at once without marking anything unavailable',async t=>{
  for(const [status,where] of [[429,'/items/2.json'],[503,'/downloadables/21']] as const){
    const db=library(t);
    upsertBoothItem(db,{itemId:'2',name:'旧二',owned:true,status:'available'});
    const {fetcher,seen}=booth(url=>url.endsWith(where)?new Response('busy',{status}):undefined);
    await assert.rejects(syncBoothLibrary(db,'secret-session-value',{fetcher,intervalMs:0}),
      (error:Error)=>error instanceof BoothSyncStopped&&error.message.includes(String(status)));
    assert.ok(seen.at(-1)!.endsWith(where),`no request after the stop: ${seen.at(-1)}`);
    assert.equal(db.prepare("SELECT count(*) AS n FROM booth_file WHERE status='unavailable'").get()!.n,0);
    assert.equal(db.prepare("SELECT owned FROM booth_item WHERE item_id='2'").get()!.owned,1,'a listed item keeps its ownership');
  }
});

test('an empty library while the index has owned items is a lost session, and the index stays as it was',async t=>{
  const db=library(t);
  upsertBoothItem(db,{itemId:'9',name:'已有',owned:true,status:'available'});
  const {fetcher}=booth(url=>url.includes('library')?new Response('<main>ログイン</main>'):undefined);
  await assert.rejects(syncBoothLibrary(db,'secret-session-value',{fetcher,intervalMs:0}),/素材库返回为空/);
  assert.deepEqual({...db.prepare("SELECT owned,status FROM booth_item WHERE item_id='9'").get()},{owned:1,status:'available'});
});

test('an item no longer in the library loses ownership only after the whole listing was read',async t=>{
  const db=library(t);
  upsertBoothItem(db,{itemId:'9',name:'已退',owned:true,status:'available'});
  const {fetcher}=booth();
  await syncBoothLibrary(db,'secret-session-value',{fetcher,intervalMs:0});
  assert.deepEqual(db.prepare('SELECT item_id AS id,owned FROM booth_item ORDER BY item_id').all().map(row=>({...row})),
    [{id:'1',owned:1},{id:'2',owned:1},{id:'9',owned:0}]);
});

test('a signed URL that refuses HEAD is sized by a one-byte Range GET; the body is never read and the reason is kept',async t=>{
  const db=library(t);let pulled=0,cancelled=0;
  const {fetcher,seen}=booth((url,method,init)=>{
    if(!url.includes('cdn.example'))return undefined;
    if(method==='HEAD')return new Response('<Error>SignatureDoesNotMatch</Error>',{status:403,headers:{'content-type':'application/xml'}});
    assert.equal((init?.headers as Record<string,string>).range,'bytes=0-0');
    const body=new ReadableStream<Uint8Array>({pull(controller){pulled++;controller.enqueue(new Uint8Array(1<<20));},cancel(){cancelled++;}},{highWaterMark:0});
    return new Response(body,{status:206,headers:{'content-range':'bytes 0-0/734003200'}});
  });
  const result=await syncBoothLibrary(db,'secret-session-value',{fetcher,intervalMs:0});
  assert.equal(result.unknownSizes,0);
  assert.deepEqual(result.probes,{'head:http-403 range:ok':3});
  assert.deepEqual(db.prepare('SELECT DISTINCT byte_size AS size,probe_outcome AS probe FROM booth_file').all().map(row=>({...row})),
    [{size:734003200,probe:'head:http-403 range:ok'}]);
  assert.equal(pulled,0,'no file body was read');assert.equal(cancelled,3,'each Range answer was cut off');
  assert.ok(fileHost(seen).every(line=>line.startsWith('HEAD ')||line.endsWith('[bytes=0-0]')),'never a GET without Range: '+fileHost(seen).join('\n'));
});

test('a size probe that fails both ways leaves the size unknown, says why, and same-named files of one item are told apart',async t=>{
  const db=library(t);
  // The file host refuses both the HEAD and the Range GET for file 21, with an error page that has a length of its own.
  const {fetcher}=booth(url=>url.includes('cdn.example/21/')?new Response('<html>denied</html>',{status:403,headers:{'content-length':'19'}}):undefined);
  const result=await syncBoothLibrary(db,'secret-session-value',{fetcher,intervalMs:0});
  assert.equal(result.unknownSizes,1);
  assert.deepEqual(result.probes,{'head:ok':2,'head:http-403 range:http-403':1});
  assert.match(syncMessage(result),/1 个大小未知（head:http-403 range:http-403 ×1）/);
  assert.deepEqual(db.prepare("SELECT downloadable_id AS id,filename,byte_size AS size,probe_outcome AS probe FROM booth_file WHERE item_id='2' ORDER BY id").all().map(row=>({...row})),
    [{id:'21',filename:'same.zip',size:null,probe:'head:http-403 range:http-403'},{id:'22',filename:'same (22).zip',size:100,probe:'head:ok'}]);
  upsertBoothFile(db,{downloadableId:'21',itemId:'2',filename:'same.zip',status:'available'});
  assert.equal(db.prepare("SELECT filename FROM booth_file WHERE downloadable_id='21'").get()!.filename,'same.zip','a file keeps its own name on re-sync');
});

test('a quick sync reads only what changed; a deep sync reads everything again',async t=>{
  const db=library(t);let listing=twoItems;
  const {fetcher,seen}=booth(undefined,()=>listing);
  const run=async(mode?:'quick'|'deep')=>{seen.length=0;return await syncBoothLibrary(db,'secret-session-value',{fetcher,intervalMs:0,...(mode?{mode}:{})});};
  const first=await run();
  assert.deepEqual([first.itemsRead,first.filesProbed,first.newFiles],[2,3,3]);
  // Nothing changed: only the library pages are read.
  const quiet=await run();
  assert.deepEqual([quiet.mode,quiet.itemsRead,quiet.itemsUnchanged,quiet.filesProbed,quiet.filesUnchanged],['quick',0,2,0,3]);
  assert.deepEqual([itemJson(seen),resolves(seen),fileHost(seen)],[[],[],[]]);
  assert.equal(quiet.requests,seen.length);assert.equal(quiet.requests,quiet.pages);
  // Deep: every item and file again.
  const deep=await run('deep');
  assert.deepEqual([deep.mode,deep.itemsRead,deep.filesProbed,deep.newFiles],['deep',2,3,0]);
  assert.equal(itemJson(seen).length,2);assert.equal(resolves(seen).length,3);
  // A new file in one item's listing: that item's JSON and that file only.
  listing=twoItems.replace('<a href="/downloadables/22">下载</a>','<a href="/downloadables/22">下载</a><a href="/downloadables/23">下载</a>');
  const grown=await run();
  assert.deepEqual([grown.itemsRead,grown.filesProbed,grown.newFiles],[1,1,1]);
  assert.deepEqual(itemJson(seen).map(line=>line.split(' ')[1]),['https://booth.pm/ja/items/2.json']);
  assert.deepEqual(resolves(seen).map(line=>line.split(' ')[1]),['https://booth.pm/downloadables/23']);
  // A file whose size is not known is probed again even in a quick sync.
  db.prepare("UPDATE booth_file SET byte_size=NULL WHERE downloadable_id='11'").run();
  const unknown=await run();
  assert.deepEqual([unknown.itemsRead,unknown.filesProbed],[0,1]);
  assert.deepEqual(resolves(seen).map(line=>line.split(' ')[1]),['https://booth.pm/downloadables/11']);
  assert.equal(db.prepare("SELECT byte_size AS size FROM booth_file WHERE downloadable_id='11'").get()!.size,100);
});

test('a file BOOTH no longer offers keeps its name, size and versions; it is checked again and comes back',async t=>{
  const db=library(t);let gone=404;
  const {fetcher}=booth(url=>url.endsWith('/downloadables/21')&&gone?new Response(null,{status:gone}):undefined);
  upsertBoothItem(db,{itemId:'2',name:'二',owned:true,status:'available'});
  upsertBoothFile(db,{downloadableId:'21',itemId:'2',filename:'same.zip',byteSize:100,remoteVersion:'{"name":"same.zip","size":100}',status:'available'});
  const sha='a'.repeat(64);
  db.prepare("INSERT INTO pool_blob(sha256,byte_size,path,source,retention) VALUES(?,100,'/pool/a','booth','cache')").run(sha);
  db.prepare("INSERT INTO booth_file_version(downloadable_id,sha256,filename,byte_size,remote_version) VALUES('21',?,'same.zip',100,'{\"name\":\"same.zip\",\"size\":100}')").run(sha);
  for(const status of [404,410]){
    gone=status;
    const result=await syncBoothLibrary(db,'secret-session-value',{fetcher,intervalMs:0,mode:'deep'});
    assert.equal(result.unavailableFiles,1);assert.equal(result.probes[`resolve:http-${status}`],1);
    assert.deepEqual({...db.prepare("SELECT filename,byte_size AS size,remote_version AS clue,status,probe_outcome AS probe FROM booth_file WHERE downloadable_id='21'").get()},
      {filename:'same.zip',size:100,clue:'{"name":"same.zip","size":100}',status:'unavailable',probe:`resolve:http-${status}`});
    assert.equal(db.prepare("SELECT count(*) AS n FROM booth_file_version WHERE downloadable_id='21'").get()!.n,1,'history stays');
  }
  // Not offered at the last look: a quick sync looks again.
  gone=0;
  const back=await syncBoothLibrary(db,'secret-session-value',{fetcher,intervalMs:0});
  assert.equal(back.filesProbed,1);
  assert.equal(db.prepare("SELECT status FROM booth_file WHERE downloadable_id='21'").get()!.status,'available');
});

test('a file gone from its item listing is marked unlisted; an item whose JSON fails keeps its metadata and is read again',async t=>{
  const db=library(t);let listing=twoItems,itemFails=false;
  const {fetcher}=booth(url=>url.endsWith('/items/2.json')&&itemFails?new Response('gone',{status:404}):undefined,()=>listing);
  await syncBoothLibrary(db,'secret-session-value',{fetcher,intervalMs:0});
  listing=twoItems.replace('<a href="/downloadables/22">下载</a>','');itemFails=true;
  const shrunk=await syncBoothLibrary(db,'secret-session-value',{fetcher,intervalMs:0});
  assert.deepEqual([shrunk.itemsRead,shrunk.unavailableItems,shrunk.unavailableFiles],[1,1,1]);
  assert.deepEqual({...db.prepare("SELECT filename,status,probe_outcome AS probe FROM booth_file WHERE downloadable_id='22'").get()},
    {filename:'same (22).zip',status:'unavailable',probe:'unlisted'});
  assert.deepEqual({...db.prepare("SELECT category,tags_json AS tags,owned FROM booth_item WHERE item_id='2'").get()},{category:'3D衣装',tags:'["Kaguya"]',owned:1});
  itemFails=false;
  const retried=await syncBoothLibrary(db,'secret-session-value',{fetcher,intervalMs:0});
  assert.deepEqual([retried.itemsRead,retried.unavailableItems],[1,0]);
  const settled=await syncBoothLibrary(db,'secret-session-value',{fetcher,intervalMs:0});
  assert.equal(settled.itemsRead,0);
});

test('a library longer than the page limit leaves the ownership of items it did not reach unchanged',async t=>{
  const db=library(t);
  upsertBoothItem(db,{itemId:'999999',name:'第 300 页上的商品',owned:true,status:'available'});
  // A known file of a listed item that this listing does not show: an incomplete listing proves nothing about it either.
  upsertBoothItem(db,{itemId:'1',name:'1',owned:true,status:'available'});
  upsertBoothFile(db,{downloadableId:'77',itemId:'1',filename:'old.zip',byteSize:1,status:'available'});
  const {fetcher,seen}=booth((url,method)=>{
    const page=/library\?page=(\d+)/.exec(url)?.[1];
    if(page)return new Response(`<nav><a href="?page=300">300</a></nav><article><a href="/items/${page}">${page}</a><a href="/downloadables/${page}0">下载</a></article>`);
    if(url.includes('library/gifts'))return new Response('<main></main>');
    return method==='HEAD'?new Response(null,{headers:{'content-length':'1'}}):undefined;
  });
  const result=await syncBoothLibrary(db,'secret-session-value',{fetcher,intervalMs:0});
  assert.equal(result.truncated,true);
  assert.equal(seen.filter(line=>/library\?page=/.test(line)).length,200,'reads no more than the page limit');
  assert.equal(db.prepare("SELECT owned FROM booth_item WHERE item_id='999999'").get()!.owned,1);
  assert.equal(db.prepare("SELECT status FROM booth_file WHERE downloadable_id='77'").get()!.status,'available');
});
