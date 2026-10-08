import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { accessSync, chmodSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import test from 'node:test';
import { boothCatalog, boothCounts, createSelectionPlan, isTransientNetworkError, materializeSelection, pinnedPlanFiles, selectionPlans,
  upsertBoothFile, upsertBoothItem, withoutUrls } from '../../src/booth/catalog.ts';
import { BoothSyncStopped } from '../../src/booth/remote.ts';
import { openDatabase } from '../../src/state/db.ts';
import { posixPath, removeTemp } from '../fixtures/platform.ts';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
function fixture(t:test.TestContext){
  const root=mkdtempSync(join(tmpdir(),'avh-booth-')),db=openDatabase(join(root,'state.sqlite'));
  db.prepare("INSERT INTO workspace(id,path) VALUES('w','/workspace')").run();
  for(const id of ['p','q'])db.prepare(`INSERT INTO project(id,workspace_id,kind,path,identity_json,lifecycle,harness_version,knowledge_version)
    VALUES(?,'w','client',?,'{}','active','test','test')`).run(id,`/workspace/${id}`);
  t.after(()=>{db.close();removeTemp(root);});
  upsertBoothItem(db,{itemId:'100',name:'衣装',owned:true,status:'available',category:'3D衣装'});
  upsertBoothFile(db,{downloadableId:'200',itemId:'100',filename:'dress.zip',status:'available'});
  return{root,db,materialized:join(root,'materialized')};
}
/**
 * A BOOTH double: /downloadables/<id> redirects to a signed file URL that answers GET only (HEAD is refused, as a
 * signature bound to GET does), a one-byte Range GET with the total, and a full GET with the bytes.
 */
function booth(files:Record<string,{name:string;body:string;etag?:string}|number>){
  const seen:string[]=[],sent:Array<{url:string;cookie:boolean}>=[];
  const fetcher=(async(input:URL|string,init?:RequestInit)=>{
    const url=String(input),method=init?.method??'GET',headers=(init?.headers??{}) as Record<string,string>;
    seen.push(`${method} ${url.replace(/\?.*/,'')}${headers.range?' [range]':''}`);sent.push({url,cookie:Boolean(headers.cookie)});
    const id=/booth\.pm\/downloadables\/(\d+)$/.exec(url)?.[1];
    if(id){const file=files[id];if(typeof file==='number')return new Response(null,{status:file});if(!file)return new Response(null,{status:404});
      return new Response(null,{status:302,headers:{location:`https://cdn.example/${id}/${encodeURIComponent(file.name)}?X-Amz-Signature=signed-secret`}});}
    const cdn=/cdn\.example\/(\d+)\//.exec(url)?.[1],file=cdn?files[cdn]:undefined;
    if(file&&typeof file!=='number'){
      const version: Record<string,string>=file.etag?{etag:file.etag}:{};
      if(method==='HEAD')return new Response(null,{status:403});
      if(headers.range)return new Response(null,{status:206,headers:{'content-range':`bytes 0-0/${Buffer.byteLength(file.body)}`,...version}});
      return new Response(file.body,{headers:{'content-type':'application/zip','content-length':String(Buffer.byteLength(file.body)),...version}});
    }
    throw new Error(`unexpected ${method} ${url}`);
  }) as typeof fetch;
  const full=()=>seen.filter(line=>line.startsWith('GET https://cdn.example')&&!line.endsWith('[range]'));
  return{fetcher,seen,sent,full};
}
const offline=(async()=>{throw new Error('BOOTH must not be asked');}) as unknown as typeof fetch;
const pins=(db:ReturnType<typeof openDatabase>)=>db.prepare('SELECT plan_id AS plan,sha256 FROM asset_selection_pin ORDER BY pinned_at,plan_id').all().map(row=>({...row}));
/** A body that delivers one chunk and then loses the connection, as a large transfer does mid-download. */
function brokenBody(partialDirectory:string,chunk:string,error:Error):ReadableStream<Uint8Array>{
  const bytes=new TextEncoder().encode(chunk);
  return new ReadableStream({start(controller){
    controller.enqueue(bytes);
    void (async()=>{
      for(;;){
        let written=false;
        try{written=readdirSync(partialDirectory).some(name=>statSync(join(partialDirectory,name)).size>0);}catch{/* receive has not opened the file yet */}
        if(written)break;
        await new Promise<void>(resolve=>setImmediate(resolve));
      }
      try{controller.error(error);}catch{/* the pipeline may have already closed the body */}
    })();
  }});
}
/** What undici reports when the file host closes a connection under a running download (sampled from Node 24). */
const lostConnection=()=>new TypeError('terminated',{cause:Object.assign(new Error('other side closed'),
  {name:'SocketError',code:'UND_ERR_SOCKET'})});
const noSleep=(slept:number[])=>(ms:number)=>{slept.push(ms);return Promise.resolve();};

test('BOOTH selection accepts only owned available files',t=>{
  const {db}=fixture(t);
  upsertBoothFile(db,{downloadableId:'200',itemId:'100',filename:'dress.zip',byteSize:3,status:'available'});
  const plan=createSelectionPlan(db,{projectId:'p',rationale:'仅需衣装主包',files:[{downloadableId:'200',purpose:'装配'}]});
  assert.equal((db.prepare('SELECT status FROM asset_selection_plan WHERE id=?').get(plan) as {status:string}).status,'validated');
  upsertBoothItem(db,{itemId:'101',name:'未购买',owned:false,status:'available'});
  upsertBoothFile(db,{downloadableId:'201',itemId:'101',filename:'other.zip',status:'available'});
  assert.throws(()=>createSelectionPlan(db,{projectId:'p',files:[{downloadableId:'201',purpose:'x'}]}),/未拥有/);
  assert.equal((db.prepare("SELECT count(*) AS count FROM asset_selection_plan WHERE rationale='' ").get() as {count:number}).count,0,'failed plan rolls back');
});

test('fetched bytes go into the pool once, by content and read-only; a second plan reuses them after checking BOOTH still serves them',async t=>{
  const {root,db,materialized}=fixture(t);const remote=booth({'200':{name:'dress.zip',body:'abc',etag:'"v1"'}});
  const first=createSelectionPlan(db,{projectId:'p',files:[{downloadableId:'200',purpose:'装配'}]});
  const [a]=await materializeSelection(db,first,materialized,'secret-session-value',{fetcher:remote.fetcher,intervalMs:0});
  assert.equal(a!.sha256,sha('abc'));assert.equal(a!.fetched,true);
  assert.equal(posixPath(relative(root,a!.path)),`materialized/pool/${sha('abc').slice(0,2)}/${sha('abc')}/dress.zip`);
  assert.equal(readFileSync(a!.path,'utf8'),'abc');
  assert.throws(()=>accessSync(a!.path,constants.W_OK),'pool bytes are read-only');
  // The index learns the measured size and the version clue of what was fetched.
  assert.deepEqual({...db.prepare("SELECT byte_size AS size,remote_version AS clue,probe_outcome AS probe FROM booth_file WHERE downloadable_id='200'").get()},
    {size:3,clue:'{"name":"dress.zip","size":3,"etag":"\\"v1\\""}',probe:'fetched'});
  remote.seen.length=0;
  const second=createSelectionPlan(db,{projectId:'q',files:[{downloadableId:'200',purpose:'另一个造型'}]});
  const [b]=await materializeSelection(db,second,materialized,'secret-session-value',{fetcher:remote.fetcher,intervalMs:0});
  assert.deepEqual([b!.path,b!.sha256,b!.fetched],[a!.path,a!.sha256,false]);
  // BOOTH was asked what it serves now (HEAD refused, then the Range GET), and the file was not downloaded again.
  assert.deepEqual(remote.seen,['GET https://booth.pm/downloadables/200','HEAD https://cdn.example/200/dress.zip','GET https://cdn.example/200/dress.zip [range]']);
  assert.deepEqual(pins(db),[{plan:first,sha256:sha('abc')},{plan:second,sha256:sha('abc')}]);
  assert.equal(db.prepare('SELECT count(*) AS n FROM pool_blob').get()!.n,1);
  // Readers written against migration 0015 see the pool through its views.
  assert.equal(db.prepare('SELECT count(*) AS n FROM materialized_ref').get()!.n,2);
  assert.deepEqual({...db.prepare('SELECT path,sha256,status FROM materialized_file').get()},{path:a!.path,sha256:sha('abc'),status:'ready'});
  // The session goes to BOOTH only, never to the file host, and the signed URL is stored nowhere.
  assert.ok(remote.sent.every(request=>request.cookie===request.url.startsWith('https://booth.pm/')));
  assert.doesNotMatch(JSON.stringify([db.prepare('SELECT * FROM booth_file').all(),db.prepare('SELECT * FROM booth_file_version').all(),
    db.prepare('SELECT * FROM pool_blob').all(),db.prepare('SELECT * FROM asset_selection_plan').all()]),/signed-secret|cdn\.example/);
  assert.deepEqual(boothCounts(db),{items:1,owned:1,files:1,materialized:1});
});

test('a file BOOTH changed becomes a new version; the plan that pinned the old one keeps it and needs no request',async t=>{
  const {db,materialized}=fixture(t);const files:Record<string,{name:string;body:string;etag?:string}>={'200':{name:'dress.zip',body:'abc',etag:'"v1"'}};
  const remote=booth(files);
  const old=createSelectionPlan(db,{projectId:'p',files:[{downloadableId:'200',purpose:'装配'}]});
  const [v1]=await materializeSelection(db,old,materialized,'secret-session-value',{fetcher:remote.fetcher,intervalMs:0});
  files['200']={name:'dress.zip',body:'abcd',etag:'"v2"'};
  const fresh=createSelectionPlan(db,{projectId:'q',files:[{downloadableId:'200',purpose:'新造型'}]});
  const [v2]=await materializeSelection(db,fresh,materialized,'secret-session-value',{fetcher:remote.fetcher,intervalMs:0});
  assert.equal(v2!.sha256,sha('abcd'));assert.notEqual(v2!.path,v1!.path);
  assert.equal(readFileSync(v1!.path,'utf8'),'abc','the old bytes are neither overwritten nor modified');
  assert.deepEqual(pins(db),[{plan:old,sha256:sha('abc')},{plan:fresh,sha256:sha('abcd')}]);
  assert.equal(db.prepare("SELECT count(*) AS n FROM booth_file_version WHERE downloadable_id='200'").get()!.n,2);
  // The pinned plan uses its version without asking BOOTH at all.
  const [again]=await materializeSelection(db,old,materialized,'secret-session-value',{fetcher:offline});
  assert.deepEqual([again!.path,again!.sha256,again!.fetched],[v1!.path,sha('abc'),false]);
  // Each project's Workflow reads the version its plan pinned.
  assert.deepEqual(pinnedPlanFiles(db,'p'),{files:[{path:v1!.path,name:'衣装',category:'3D衣装'}],missing:[]});
  assert.deepEqual(pinnedPlanFiles(db,'q').files.map(file=>file.path),[v2!.path]);
  const file=(boothCatalog(db)[0]!.files as Array<Record<string,unknown>>)[0]!;
  assert.deepEqual([file.cache,file.materialized,file.sha256,file.versions,file.byteSize],['current',true,sha('abcd'),2,4]);
  assert.deepEqual((selectionPlans(db,'p') as Array<{readyCount:number;pinnedCount:number}>).map(plan=>[plan.pinnedCount,plan.readyCount]),[[1,1]]);
});

test('same name and size is not enough: another ETag means asking for the bytes, and the same bytes stay one version',async t=>{
  const {db,materialized}=fixture(t);const files:Record<string,{name:string;body:string;etag?:string}>={'200':{name:'dress.zip',body:'abc',etag:'"v1"'}};
  const remote=booth(files);
  await materializeSelection(db,createSelectionPlan(db,{projectId:'p',files:[{downloadableId:'200',purpose:'a'}]}),materialized,'s'.repeat(16),{fetcher:remote.fetcher,intervalMs:0});
  files['200']={name:'dress.zip',body:'abc',etag:'"re-uploaded"'};
  remote.seen.length=0;
  const [again]=await materializeSelection(db,createSelectionPlan(db,{projectId:'q',files:[{downloadableId:'200',purpose:'b'}]}),materialized,'s'.repeat(16),
    {fetcher:remote.fetcher,intervalMs:0});
  assert.equal(remote.full().length,1,'the changed clue was not taken on trust');
  assert.equal(again!.sha256,sha('abc'));
  assert.equal(db.prepare("SELECT count(*) AS n FROM booth_file_version WHERE downloadable_id='200'").get()!.n,1);
  assert.equal(db.prepare("SELECT remote_version AS clue FROM booth_file_version").get()!.clue,'{"name":"dress.zip","size":3,"etag":"\\"re-uploaded\\""}');
  assert.deepEqual(readdirSync(join(materialized,'pool','.partial')),[],'the duplicate download was dropped');
  // Now the clue matches: a third plan reuses the bytes.
  remote.seen.length=0;
  await materializeSelection(db,createSelectionPlan(db,{projectId:'p',files:[{downloadableId:'200',purpose:'c'}]}),materialized,'s'.repeat(16),{fetcher:remote.fetcher,intervalMs:0});
  assert.equal(remote.full().length,0);
});

test('bytes that no longer hash to their sha256 are never reused, and a fetch repairs them in place',async t=>{
  const {db,materialized}=fixture(t);const remote=booth({'200':{name:'dress.zip',body:'abc'}});
  const [a]=await materializeSelection(db,createSelectionPlan(db,{projectId:'p',files:[{downloadableId:'200',purpose:'a'}]}),materialized,'s'.repeat(16),{fetcher:remote.fetcher,intervalMs:0});
  chmodSync(a!.path,0o600);writeFileSync(a!.path,'xyz');
  remote.seen.length=0;
  const [b]=await materializeSelection(db,createSelectionPlan(db,{projectId:'q',files:[{downloadableId:'200',purpose:'b'}]}),materialized,'s'.repeat(16),{fetcher:remote.fetcher,intervalMs:0});
  assert.equal(remote.full().length,1,'damaged bytes were fetched again although the clue matched');
  assert.deepEqual([b!.path,readFileSync(b!.path,'utf8')],[a!.path,'abc']);
  assert.equal(db.prepare('SELECT status FROM pool_blob').get()!.status,'ready');
});

test('a pinned version whose bytes are gone is restored only by the same bytes',async t=>{
  const {db,materialized}=fixture(t);const files:Record<string,{name:string;body:string}>={'200':{name:'dress.zip',body:'abc'}};
  const remote=booth(files),plan=createSelectionPlan(db,{projectId:'p',files:[{downloadableId:'200',purpose:'a'}]});
  const [a]=await materializeSelection(db,plan,materialized,'s'.repeat(16),{fetcher:remote.fetcher,intervalMs:0});
  rmSync(a!.path,{force:true});
  const [restored]=await materializeSelection(db,plan,materialized,'s'.repeat(16),{fetcher:remote.fetcher,intervalMs:0});
  assert.deepEqual([restored!.path,readFileSync(restored!.path,'utf8'),restored!.fetched],[a!.path,'abc',true]);
  rmSync(a!.path,{force:true});files['200']={name:'dress.zip',body:'changed'};
  await assert.rejects(materializeSelection(db,plan,materialized,'s'.repeat(16),{fetcher:remote.fetcher,intervalMs:0}),/计划锁定的版本 [0-9a-f]{12}（dress\.zip）已不在本机/);
  assert.equal(db.prepare('SELECT status FROM asset_selection_plan WHERE id=?').get(plan)!.status,'failed');
  assert.deepEqual(pins(db),[{plan,sha256:sha('abc')}],'the plan still pins its version');
  assert.equal(db.prepare("SELECT count(*) AS n FROM booth_file_version WHERE sha256=?").get(sha('changed'))!.n,1,'the new bytes are kept as a new version');
});

test('a plan can pin a pool version BOOTH no longer offers, and uses it without asking BOOTH',async t=>{
  const {db,materialized}=fixture(t);const files:Record<string,{name:string;body:string}|number>={'200':{name:'dress.zip',body:'abc'}};
  const remote=booth(files);
  await materializeSelection(db,createSelectionPlan(db,{projectId:'p',files:[{downloadableId:'200',purpose:'a'}]}),materialized,'s'.repeat(16),{fetcher:remote.fetcher,intervalMs:0});
  files['200']=410;
  await assert.rejects(materializeSelection(db,createSelectionPlan(db,{projectId:'q',files:[{downloadableId:'200',purpose:'b'}]}),materialized,'s'.repeat(16),
    {fetcher:remote.fetcher,intervalMs:0}),/BOOTH 已不提供这个文件（dress\.zip，下载项 200，返回 HTTP 410）；素材池里还有它的版本/);
  assert.deepEqual({...db.prepare("SELECT filename,status,probe_outcome AS probe FROM booth_file WHERE downloadable_id='200'").get()},
    {filename:'dress.zip',status:'unavailable',probe:'resolve:http-410'});
  assert.throws(()=>createSelectionPlan(db,{projectId:'q',files:[{downloadableId:'200',purpose:'b'}]}),/下载项不可用/);
  assert.throws(()=>createSelectionPlan(db,{projectId:'q',files:[{downloadableId:'200',purpose:'b',sha256:sha('other')}]}),/素材池里没有/);
  const pinned=createSelectionPlan(db,{projectId:'q',files:[{downloadableId:'200',purpose:'b',sha256:sha('abc')}]});
  const [used]=await materializeSelection(db,pinned,materialized,'s'.repeat(16),{fetcher:offline});
  assert.deepEqual([used!.sha256,used!.fetched],[sha('abc'),false]);
});

test('a transfer shorter than its Content-Length or a login page leaves nothing in the pool',async t=>{
  for(const answer of [()=>new Response('abc',{headers:{'content-length':'4'}}),
    ()=>new Response('<html>ログイン</html>',{headers:{'content-type':'text/html; charset=utf-8'}})]){
    const {db,materialized}=fixture(t);
    const plan=createSelectionPlan(db,{projectId:'p',files:[{downloadableId:'200',purpose:'装配'}]});
    const fetcher=(async(input:URL|string)=>String(input).includes('booth.pm')
      ?new Response(null,{status:302,headers:{location:'https://cdn.example/200/dress.zip'}}):answer()) as typeof fetch;
    await assert.rejects(materializeSelection(db,plan,materialized,'s'.repeat(16),{fetcher,intervalMs:0}),/大小不符|网页而不是文件/);
    assert.equal(db.prepare('SELECT status FROM asset_selection_plan WHERE id=?').get(plan)!.status,'failed');
    for(const table of ['pool_blob','booth_file_version','asset_selection_pin'])assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n,0,table);
    const partial=join(materialized,'pool','.partial');
    assert.deepEqual(existsSync(partial)?readdirSync(partial):[],[]);
  }
});

test('a download that loses its connection mid-transfer is tried again, and the plan still becomes ready',async t=>{
  const {db,materialized}=fixture(t);
  upsertBoothFile(db,{downloadableId:'201',itemId:'100',filename:'hat.zip',status:'available'});
  upsertBoothFile(db,{downloadableId:'202',itemId:'100',filename:'shoes.zip',status:'available'});
  const remote=booth({'200':{name:'dress.zip',body:'abc'},'201':{name:'hat.zip',body:'hat-bytes'},'202':{name:'shoes.zip',body:'shoe-bytes'}});
  // The second file's first transfer breaks after one chunk; every request after that reaches BOOTH normally.
  let tries=0;
  const flaky=(async(input:URL|string,init?:RequestInit)=>{
    const url=String(input),method=init?.method??'GET',headers=(init?.headers??{}) as Record<string,string>;
    if(method==='GET'&&!headers.range&&/cdn\.example\/201\//.test(url)&&++tries===1)
      return new Response(brokenBody(join(materialized,'pool','.partial'),'hat-',lostConnection()),{headers:{'content-type':'application/zip','content-length':'9'}});
    return remote.fetcher(input,init);
  }) as typeof fetch;
  const slept:number[]=[];
  const plan=createSelectionPlan(db,{projectId:'p',files:[{downloadableId:'200',purpose:'a'},
    {downloadableId:'201',purpose:'b'},{downloadableId:'202',purpose:'c'}]});
  const files=await materializeSelection(db,plan,materialized,'s'.repeat(16),{fetcher:flaky,intervalMs:0,sleep:noSleep(slept)});
  assert.equal(tries,2,'the file was downloaded twice: once broken, once whole');
  assert.deepEqual(slept,[500],'one growing pause before the retry');
  assert.equal(remote.seen.filter(line=>line.endsWith('/downloadables/201')).length,2,'the retry asked BOOTH for a fresh address');
  assert.equal(db.prepare('SELECT status FROM asset_selection_plan WHERE id=?').get(plan)!.status,'ready');
  assert.deepEqual(files.map(file=>[file.downloadableId,file.fetched]),[['200',true],['201',true],['202',true]]);
  assert.deepEqual(files.map(file=>readFileSync(file.path,'utf8')),['abc','hat-bytes','shoe-bytes']);
  const pinned=(db.prepare('SELECT sha256 FROM asset_selection_pin WHERE plan_id=?').all(plan) as Array<{sha256:string}>)
    .map(row=>row.sha256).sort();
  assert.deepEqual(pinned,files.map(file=>file.sha256).sort(),'all three files are pinned to what was stored');
  assert.equal(db.prepare('SELECT count(*) AS n FROM pool_blob').get()!.n,3,'the broken attempt left no bytes behind');
  const partial=join(materialized,'pool','.partial');
  assert.deepEqual(existsSync(partial)?readdirSync(partial):[],[]);
});

test('a download that never comes back stays failed, with its retries bounded and the underlying cause kept',async t=>{
  const {db,materialized}=fixture(t);
  const plan=createSelectionPlan(db,{projectId:'p',files:[{downloadableId:'200',purpose:'装配'}]});
  let downloads=0;
  const fetcher=(async(input:URL|string)=>{
    const url=String(input);
    if(url.includes('booth.pm'))return new Response(null,{status:302,
      headers:{location:'https://cdn.example/200/dress.zip?X-Amz-Signature=signed-secret'}});
    downloads++;
    throw new TypeError('fetch failed',{cause:Object.assign(
      new Error('read ECONNRESET (cookie _plaza_session_nktz7u=secret-session-value)'),{code:'ECONNRESET'})});
  }) as typeof fetch;
  const slept:number[]=[];
  await assert.rejects(materializeSelection(db,plan,materialized,'s'.repeat(16),{fetcher,intervalMs:0,sleep:noSleep(slept)}),
    /底层原因: .*ECONNRESET/);
  assert.equal(downloads,3,'the retries are bounded and every one was a lost connection');
  assert.deepEqual(slept,[500,1000],'the pause grows and there is no fourth attempt');
  const row=db.prepare('SELECT status,error FROM asset_selection_plan WHERE id=?').get(plan) as {status:string;error:string};
  assert.equal(row.status,'failed');
  assert.match(row.error,/底层原因: .*ECONNRESET/);
  assert.doesNotMatch(row.error,/https?:\/\//);
  assert.doesNotMatch(row.error,/signed-secret|secret-session-value|X-Amz-Signature/i);
  assert.equal(db.prepare('SELECT count(*) AS n FROM pool_blob').get()!.n,0);
  const partial=join(materialized,'pool','.partial');
  assert.deepEqual(existsSync(partial)?readdirSync(partial):[],[]);
});

test('a failed download does not clean a concurrent download partial',async t=>{
  const {db,materialized}=fixture(t);
  mkdirSync(join(materialized,'pool','.partial'),{recursive:true});
  upsertBoothFile(db,{downloadableId:'201',itemId:'100',filename:'hat.zip',status:'available'});
  let releaseBody!:()=>void;const bodyReady=new Promise<void>(resolve=>{releaseBody=resolve;});
  let partialReady!:()=>void;const partialSeen=new Promise<void>(resolve=>{partialReady=resolve;});
  let bodyStarted=false;
  const fetcher=(async(input:URL|string)=>{
    const url=String(input);
    if(url.includes('booth.pm')){
      const id=/downloadables\/(\d+)/.exec(url)?.[1];
      return new Response(null,{status:302,headers:{location:`https://cdn.example/${id}/${id==='201'?'hat.zip':'dress.zip'}`}});
    }
    if(url.includes('/201/')){
      const body=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new TextEncoder().encode('hat'));bodyStarted=true;void (async()=>{
        while(!readdirSync(join(materialized,'pool','.partial'),{encoding:'utf8'}).some(name=>name.endsWith('.part')))await new Promise<void>(resolve=>setImmediate(resolve));
        partialReady();await bodyReady;controller.close();})();}});
      return new Response(body,{headers:{'content-type':'application/zip','content-length':'3'}});
    }
    return new Response('abc',{headers:{'content-type':'application/zip','content-length':'4'}});
  }) as typeof fetch;
  const good=createSelectionPlan(db,{projectId:'q',files:[{downloadableId:'201',purpose:'并发'}]});
  const bad=createSelectionPlan(db,{projectId:'p',files:[{downloadableId:'200',purpose:'失败'}]});
  const goodRun=materializeSelection(db,good,materialized,'s'.repeat(16),{fetcher,intervalMs:0});
  await partialSeen;assert.equal(bodyStarted,true);
  await assert.rejects(materializeSelection(db,bad,materialized,'s'.repeat(16),{fetcher,intervalMs:0}),/大小不符/);
  assert.equal(readdirSync(join(materialized,'pool','.partial')).length,1,'the other download still owns its partial');
  releaseBody();await goodRun;
  assert.deepEqual(readdirSync(join(materialized,'pool','.partial')),[]);
  assert.equal(readFileSync((db.prepare('SELECT path FROM pool_blob WHERE sha256=?').get(sha('hat')) as {path:string}).path,'utf8'),'hat');
});

test('a transaction failure cleans only its own partial while another download is active',async t=>{
  const {db,materialized}=fixture(t);
  mkdirSync(join(materialized,'pool','.partial'),{recursive:true});
  upsertBoothFile(db,{downloadableId:'201',itemId:'100',filename:'hat.zip',status:'available'});
  db.exec(`CREATE TRIGGER fail_booth_store BEFORE INSERT ON booth_file_version WHEN NEW.downloadable_id='200'
    BEGIN SELECT RAISE(ABORT,'synthetic transaction failure'); END`);
  let releaseBody!:()=>void;const bodyReady=new Promise<void>(resolve=>{releaseBody=resolve;});
  let partialReady!:()=>void;const partialSeen=new Promise<void>(resolve=>{partialReady=resolve;});
  const fetcher=(async(input:URL|string)=>{
    const url=String(input),id=/downloadables\/(\d+)/.exec(url)?.[1]??/cdn\.example\/(\d+)\//.exec(url)?.[1];
    if(url.includes('booth.pm'))return new Response(null,{status:302,headers:{location:`https://cdn.example/${id}/${id==='201'?'hat.zip':'dress.zip'}`}});
    if(id==='201'){
      const body=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new TextEncoder().encode('hat'));void (async()=>{
        while(!readdirSync(join(materialized,'pool','.partial')).length)await new Promise<void>(resolve=>setImmediate(resolve));
        partialReady();await bodyReady;controller.close();})();}});
      return new Response(body,{headers:{'content-type':'application/zip','content-length':'3'}});
    }
    return new Response('abc',{headers:{'content-type':'application/zip','content-length':'3'}});
  }) as typeof fetch;
  const good=createSelectionPlan(db,{projectId:'q',files:[{downloadableId:'201',purpose:'并发'}]});
  const bad=createSelectionPlan(db,{projectId:'p',files:[{downloadableId:'200',purpose:'事务失败'}]});
  const goodRun=materializeSelection(db,good,materialized,'s'.repeat(16),{fetcher,intervalMs:0});
  await partialSeen;
  await assert.rejects(materializeSelection(db,bad,materialized,'s'.repeat(16),{fetcher,intervalMs:0}),/synthetic transaction failure/);
  assert.equal(readdirSync(join(materialized,'pool','.partial')).length,1,'the failed transaction removed only its own partial');
  releaseBody();await goodRun;
  assert.deepEqual(readdirSync(join(materialized,'pool','.partial')),[]);
});

test('a settled failure is not retried: a short body and a refused download each stop after one attempt',async t=>{
  const {db,materialized}=fixture(t);
  const spent:number[]=[];
  const plan=createSelectionPlan(db,{projectId:'p',files:[{downloadableId:'200',purpose:'a'}]});
  let short=0;
  const truncating=(async(input:URL|string)=>{
    const url=String(input);
    if(url.includes('booth.pm'))return new Response(null,{status:302,headers:{location:'https://cdn.example/200/dress.zip'}});
    short++;return new Response('abc',{headers:{'content-type':'application/zip','content-length':'4'}});
  }) as typeof fetch;
  await assert.rejects(materializeSelection(db,plan,materialized,'s'.repeat(16),{fetcher:truncating,intervalMs:0,sleep:noSleep(spent)}),
    /大小不符/);
  assert.equal(short,1,'bytes that are not the announced size are a settled answer, not a lost connection');
  assert.deepEqual(spent,[]);
  assert.equal(db.prepare('SELECT status FROM asset_selection_plan WHERE id=?').get(plan)!.status,'failed');
  const missing=createSelectionPlan(db,{projectId:'q',files:[{downloadableId:'200',purpose:'b'}]});
  let refused=0;
  const notFound=(async(input:URL|string)=>{
    const url=String(input);
    if(url.includes('booth.pm'))return new Response(null,{status:302,headers:{location:'https://cdn.example/200/dress.zip'}});
    refused++;return new Response(null,{status:404});
  }) as typeof fetch;
  await assert.rejects(materializeSelection(db,missing,materialized,'s'.repeat(16),{fetcher:notFound,intervalMs:0,sleep:noSleep(spent)}),
    /BOOTH 下载失败: HTTP 404/);
  assert.equal(refused,1,'an HTTP 4xx is a settled answer too');
  assert.deepEqual(spent,[]);
});

test('the retry rule tells a lost connection from a settled or local failure',()=>{
  assert.equal(isTransientNetworkError(new TypeError('fetch failed',
    {cause:Object.assign(new Error('read ECONNRESET'),{code:'ECONNRESET'})})),true,'a reset is a lost connection');
  assert.equal(isTransientNetworkError(lostConnection()),true);
  assert.equal(isTransientNetworkError(new TypeError('fetch failed')),false,'a wrapper message alone is not a retry reason');
  assert.equal(isTransientNetworkError(new TypeError('terminated',{cause:new Error('bad port')})),false,'bad port is deterministic');
  assert.equal(isTransientNetworkError(new TypeError('fetch failed',{cause:Object.assign(new Error('certificate expired'),{code:'CERT_HAS_EXPIRED'})})),false);
  assert.equal(isTransientNetworkError(new TypeError('fetch failed',{cause:Object.assign(new Error('self-signed certificate'),{code:'DEPTH_ZERO_SELF_SIGNED_CERT'})})),false);
  assert.equal(isTransientNetworkError(new TypeError('wrapper',{cause:Object.assign(new Error('unclassified network failure'),{code:'EPIPE'})})),true,
    'a code-only cause authorizes retry');
  assert.equal(isTransientNetworkError(new Error('BOOTH 下载失败: HTTP 404（dress.zip）')),false,'an HTTP 4xx is settled');
  assert.equal(isTransientNetworkError(new Error('BOOTH 文件大小不符: 200（应为 4 字节，收到 3 字节）')),false);
  assert.equal(isTransientNetworkError(new Error('BOOTH 返回了网页而不是文件，可能是会话失效，请重新连接: 200')),false);
  assert.equal(isTransientNetworkError(Object.assign(new Error('database is locked'),{code:'ERR_SQLITE_ERROR',errcode:5})),false,
    'a locked database is local contention, not a lost connection: the retry must not hide it');
  assert.equal(isTransientNetworkError(new BoothSyncStopped('BOOTH 会话已失效，请重新连接')),false,'a deliberate stop is never retried');
});

test('credential redaction removes whole headers and quoted fields',()=>{
  const cases=[
    'GET https://cdn.example/file?X-Amz-Signature=url-secret Authorization: Bearer bearer-secret',
    'request headers cookie=a=equal-cookie; b=second-cookie',
    'Set-Cookie: a=first-cookie; Expires=Wed, 21 Oct 2015 07:28:00 GMT, auth=second-cookie; Path=/',
    '{"cookie":"a=json-cookie; b=\\"json-escaped-cookie\\""}',
  ];
  for(const raw of cases){
    const safe=withoutUrls(raw);
    assert.doesNotMatch(safe,/url-secret|bearer-secret|equal-cookie|second-cookie|first-cookie|json-cookie|json-escaped-cookie/i);
    assert.match(safe,/凭据已隐去/);
  }
});

test('a Workflow cannot start from a pinned file whose bytes are gone',async t=>{
  const {db,materialized}=fixture(t);const remote=booth({'200':{name:'dress.zip',body:'abc'}});
  const plan=createSelectionPlan(db,{projectId:'p',files:[{downloadableId:'200',purpose:'a'}]});
  const [a]=await materializeSelection(db,plan,materialized,'s'.repeat(16),{fetcher:remote.fetcher,intervalMs:0});
  assert.equal(pinnedPlanFiles(db,'p').files.length,1);
  rmSync(dirname(a!.path),{recursive:true,force:true});
  assert.deepEqual(pinnedPlanFiles(db,'p'),{files:[],missing:['dress.zip']});
});
