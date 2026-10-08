import { Box, Text, useInput } from 'ink';
import { useEffect } from 'react';
import { askText, choose } from '../actions.ts';
import { Cell, h, Loading, Title, useData, useListNav, useUi } from '../core.ts';

interface AssetRow { id: string; path: string; name: string; kind: string; status: string; license: string; tags: string[] }
interface BoothJob { kind:'sync'|'materialize';startedAt:string;progress?:{phase:'library'|'items';pages:number;items:number;itemsTotal:number;requests:number} }
interface BoothStatus { connected:boolean;items:number;owned:number;files:number;materialized:number;job?:BoothJob|null;
  last?:{kind:'sync'|'materialize';ok:boolean;message:string;finishedAt:string}|null }
interface BoothItem { itemId:string;name:string;shopName:string;category:string;fileCount:number;materializedCount:number;status:string }

async function addAsset(ui: ReturnType<typeof useUi>): Promise<void> {
  const name = await askText(ui, '素材名称：'); if (!name) return;
  const path = await askText(ui, '本地文件或目录的绝对路径：'); if (!path) return;
  const kind = await askText(ui, '类型（avatar/outfit/texture/animation/package/other）：', { initial: 'package' }); if (!kind) return;
  const license = await askText(ui, '许可或权益说明：', { initial: 'unknown' }); if (!license) return;
  const tags = await askText(ui, '标签（逗号分隔，可空）：', { allowEmpty: true }); if (tags === undefined) return;
  await ui.act('已加入素材索引', () => ui.api.call('asset.save', { name, path, kind, status: 'candidate', license,
    tags: tags.split(',').map(value => value.trim()).filter(Boolean) }));
}

function boothJobText(job:BoothJob):string{
  if(job.kind==='materialize')return'正在获取所选 BOOTH 文件…';
  const p=job.progress;
  return !p?'正在同步 BOOTH 索引…':p.phase==='library'?`正在读取 BOOTH 素材库：第 ${p.pages} 页`
    :`正在同步 BOOTH 索引：${p.items}/${p.itemsTotal} 个商品，已发 ${p.requests} 次请求`;
}

export function AssetsScreen(props: { active: boolean }): ReturnType<typeof h> {
  const ui = useUi();
  const assets = useData<AssetRow[]>('asset.list');
  const booth=useData<BoothStatus>('booth.status'),items=useData<BoothItem[]>('booth.catalog');
  const nav=useListNav(assets.data?.length??0,8);
  // A BOOTH job runs in the Runtime for minutes and emits no events until it ends: follow it while it runs.
  const running=Boolean(booth.data?.job);
  useEffect(()=>{if(!running)return;const timer=setInterval(()=>ui.refresh(),2000);return()=>clearInterval(timer);},[running]);
  useInput((input,key)=>{
    if(nav.handle(input,key))return;
    if(input==='n')void addAsset(ui);
    else if(input==='s'&&booth.data?.connected&&!booth.data.job)
      void ui.act('已开始同步 BOOTH 索引：每秒最多 1 次请求，进度显示在素材页',()=>ui.api.call('booth.sync'));
    else if((input==='x'||key.delete)&&assets.data?.[nav.index])void (async()=>{
      const asset=assets.data![nav.index]!;
      if(await choose(ui,'移除素材索引？',[`${asset.name}（${asset.path}）`,'只移除索引，不会删除磁盘文件。'],
        [{key:'y',label:'移除索引',tone:'bad'},{key:'n',label:'保留'}])==='y')
        await ui.act('已移除素材索引',()=>ui.api.call('asset.remove',{id:asset.id}));
    })();
  },{isActive:props.active});
  if (!assets.data||!booth.data||!items.data) return h(Loading, { what: '素材', error: assets.error??booth.error??items.error });
  const state = (value: string): [string, 'ok'|'warn'|'bad'|'muted'] => value === 'ready' ? ['可使用','ok'] : value === 'blocked'
    ? ['有问题','bad'] : value === 'archived' ? ['已归档','muted'] : ['待确认','warn'];
  return h(Box, { flexDirection: 'column' },
    h(Title, { text: '素材', hint: `n 登记本地素材 · x 移除索引${booth.data.connected&&!booth.data.job?' · s 同步 BOOTH 索引':''}` }),
    h(Box,{marginBottom:booth.data.job||booth.data.last?0:1},h(Text,{bold:true},`BOOTH ${booth.data.connected?'已连接':'未连接'}  `),h(Text,{dimColor:true},`云端索引 · ${booth.data.owned} 商品 / ${booth.data.files} 文件 · ${booth.data.materialized} 个文件已按需获取`)),
    booth.data.job?h(Box,{marginBottom:1},h(Text,{color:'yellow'},boothJobText(booth.data.job)))
      :booth.data.last?h(Box,{marginBottom:1},h(Text,{color:booth.data.last.ok?'green':'red'},`上次${booth.data.last.kind==='sync'?'同步':'获取'}：${booth.data.last.message}`)):null,
    ...items.data.slice(0,4).map(item=>h(Box,{key:item.itemId},h(Cell,{width:25,bold:true},item.name),h(Cell,{width:18,dim:true},item.shopName||'未知店铺'),
      h(Cell,{width:16},item.category||'未分类'),h(Text,{dimColor:true},`${item.fileCount} 文件 · ${item.materializedCount} 已获取`))),
    items.data.length>4?h(Text,{dimColor:true},`另有 ${items.data.length-4} 个 BOOTH 商品；按需挑选文件和内建登录仍在 GUI 完成。`):null,
    h(Box,{marginTop:1,marginBottom:1},h(Text,{bold:true},'本地零散素材')),
    assets.data.length ? h(Box, null, h(Cell, { width: 25, dim: true }, '名称'), h(Cell, { width: 12, dim: true }, '类型'),
      h(Cell, { width: 12, dim: true }, '状态'), h(Cell, { width: 16, dim: true }, '许可'), h(Text, { dimColor: true }, '路径 / 标签')) : null,
    ...assets.data.slice(nav.offset,nav.offset+8).map((asset,index) => { const [label,tone]=state(asset.status); return h(Box, { key: asset.id },
      h(Cell,{width:2,tone:'info'},nav.offset+index===nav.index?'›':' '),h(Cell, { width: 23, bold: true }, asset.name), h(Cell, { width: 12 }, asset.kind), h(Cell, { width: 12, tone }, label),
      h(Cell, { width: 16, dim: true }, asset.license), h(Text, { wrap: 'truncate-end', dimColor: true }, `${asset.path}${asset.tags.length?` · ${asset.tags.join('/')}`:''}`)); }),
    !assets.data.length ? h(Text, { dimColor: true }, '素材库为空。按 n 登记本地零散素材；文件不会被移动。') : null,
    h(Box, { marginTop: 1 }, h(Text, { dimColor: true }, 'BOOTH 只保存元数据与项目所需缓存；本地登记只建立索引，不移动或删除原文件。')));
}
