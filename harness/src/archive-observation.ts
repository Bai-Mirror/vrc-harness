import { execFileSync } from 'node:child_process';
import { hostPlatform } from './host-platform.ts';

/** Read one package member into bounded memory; never materialize vendor contents on disk. */
export function observeArchiveMember(path: string, member: string, offset: number, container = ''): unknown {
  const script = `import contextlib,hashlib,json,os,posixpath,stat,sys,tarfile,zipfile
p,wanted,start,container=sys.argv[1],sys.argv[2],int(sys.argv[3]),sys.argv[4]
limit=8*1024*1024
def safe(name):
 return bool(name) and not name.startswith('/') and '\\\\' not in name and ':' not in name and all(x not in ('','..','.') for x in name.split('/'))
def read(stream,size):
 if size>limit: raise ValueError('member exceeds text observation limit')
 data=stream.read(limit+1)
 if len(data)>limit: raise ValueError('member exceeds text observation limit')
 return data
if wanted and not safe(wanted): raise ValueError('unsafe member path')
if container and not safe(container): raise ValueError('unsafe container path')
def zip_member(z,name):
 matches=[m for m in z.infolist() if m.filename==name]
 if len(matches)!=1: raise ValueError('member missing or ambiguous')
 m=matches[0]
 if m.is_dir() or stat.S_ISLNK(m.external_attr>>16): raise ValueError('member is not a regular file')
 return m
@contextlib.contextmanager
def package():
 if container:
  with zipfile.ZipFile(p) as z:
   m=zip_member(z,container)
   if m.file_size>2*1024*1024*1024: raise ValueError('nested package size limit exceeded')
   with z.open(m) as raw,tarfile.open(fileobj=raw,mode='r|gz') as t: yield t
 else:
  with tarfile.open(p,'r|gz') as t: yield t
before=os.stat(p)
data=None
inventory=None
if not wanted:
 names=[];more=False
 with package() as t:
  for count,m in enumerate(t):
   if count>=10000: more=True;break
   if m.isfile() and m.name.endswith('/pathname') and m.size<=8192 and safe(m.name):
    names.append(t.extractfile(m).read(8192).decode('utf-8','strict').rstrip('\\r\\n'))
    if len(names)>=200: more=True;break
 inventory={'container':container,'paths':names,'truncated':more}
elif zipfile.is_zipfile(p) and not container:
 with zipfile.ZipFile(p) as z:
  m=zip_member(z,wanted)
  with z.open(m) as f: data=read(f,m.file_size)
else:
 # Unity packages map GUID/pathname to GUID/asset. Two streaming passes avoid extracting files.
 matches=[]
 with package() as t:
  for count,m in enumerate(t):
   if count>=10000: raise ValueError('archive scan limit exceeded')
   if m.isfile() and m.name.endswith('/pathname') and m.size<=8192 and safe(m.name):
    if t.extractfile(m).read(8192).decode('utf-8','strict').rstrip('\\r\\n')==wanted:
     matches.append(posixpath.dirname(m.name)+'/asset')
 if len(matches)!=1: raise ValueError('member missing or ambiguous')
 with package() as t:
  for count,m in enumerate(t):
   if count>=10000: raise ValueError('archive scan limit exceeded')
   if m.name==matches[0]:
    if data is not None or not m.isfile(): raise ValueError('member ambiguous or not a regular file')
    data=read(t.extractfile(m),m.size)
after=os.stat(p)
if (before.st_size,before.st_mtime_ns)!=(after.st_size,after.st_mtime_ns): raise ValueError('archive changed during observation')
if inventory is not None:
 print(json.dumps(inventory,ensure_ascii=False));sys.exit(0)
if data is None: raise ValueError('member content missing')
if b'\\x00' in data: raise ValueError('binary member requires a different observation tool')
text=data.decode('utf-8-sig','strict')
if start>len(text): raise ValueError('offset exceeds member text length')
end=min(start+32768,len(text))
print(json.dumps({'container':container or None,'member':wanted,'sha256':hashlib.sha256(data).hexdigest(),'bytes':len(data),'offset':start,'content':text[start:end],'nextOffset':end if end<len(text) else None,'truncated':end<len(text)},ensure_ascii=False))`;
  try {
    return JSON.parse(execFileSync(hostPlatform.toolCommand('python'), ['-c',script,path,member,String(offset),container],
      {encoding:'utf8',timeout:15000,maxBuffer:1024*1024,windowsHide:true,stdio:['ignore','pipe','pipe']}));
  } catch {
    throw new Error('包内文本观察失败：成员不存在、重复、非文本、超限或文件已变化；不能据此判断适配或素材损坏');
  }
}
