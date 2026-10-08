import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join, win32 } from 'node:path';

/**
 * Local API v1: newline-delimited JSON over a stream socket owned by the user (Unix domain socket on Linux,
 * a named pipe on Windows later). The Runtime service is the only scheduler; interfaces (TUI, later GUI)
 * read views and submit commands through it and never open the state database themselves.
 *
 *   → {"id": 1, "method": "workflow.list", "params": {}}
 *   ← {"id": 1, "result": [...]}            or  {"id": 1, "error": {"code": "NOT_FOUND", "message": "..."}}
 *   ← {"event": "changed", "seq": 1234}      after "subscribe": state changed; refresh what is on screen
 */
export const API_VERSION = 2;
export const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
export const RESPONSE_CHUNK_BYTES = 256 * 1024;
export const MAX_RESPONSE_BYTES = 512 * 1024 * 1024;

export type ErrorCode = 'BAD_REQUEST' | 'UNKNOWN_METHOD' | 'NOT_FOUND' | 'STALE' | 'CONFLICT' | 'UNAVAILABLE' | 'FAILED';
export interface Request { id: number | string; method: string; params?: Record<string, unknown>; responseChunks?: 'sha256-v1' }
export interface Response { id: number | string; result?: unknown; error?: { code: ErrorCode; message: string } }
export interface ResponseChunk { id: number | string; chunk: { index: number; count: number; bytes: number; sha256: string; data: string } }

/** Chunk the complete response, preserving all evidence and its request identity. */
export function* responseFrames(response: Response, chunks = false): Generator<string> {
  const bytes = Buffer.from(JSON.stringify(response));
  if (bytes.length + 1 <= MAX_MESSAGE_BYTES) { yield bytes.toString('utf8') + '\n'; return; }
  if (!chunks || bytes.length > MAX_RESPONSE_BYTES) {
    yield JSON.stringify({id:response.id,error:{code:'UNAVAILABLE',message:chunks?'响应超过分块读取范围':'此响应需要支持分块的客户端，请更新界面'}})+'\n'; return;
  }
  const count = Math.ceil(bytes.length / RESPONSE_CHUNK_BYTES), sha256 = createHash('sha256').update(bytes).digest('hex');
  for (let index=0; index<count; index++) yield JSON.stringify({id:response.id,chunk:{index,count,bytes:bytes.length,sha256,
    data:bytes.subarray(index*RESPONSE_CHUNK_BYTES,(index+1)*RESPONSE_CHUNK_BYTES).toString('base64')}})+'\n';
}

/** One pending call owns one bounded, ordered response assembly. */
export class ResponseAssembly {
  private parts: Buffer[] = [];
  private identity?: {count:number;bytes:number;sha256:string};
  push(message: ResponseChunk): Response | undefined {
    const c=message.chunk, bad=()=>{throw new ApiError('BAD_REQUEST','响应分块身份或完整性无效');};
    if (!c || !Number.isSafeInteger(c.index) || !Number.isSafeInteger(c.count) || !Number.isSafeInteger(c.bytes) ||
      c.bytes<=MAX_MESSAGE_BYTES-1 || c.bytes>MAX_RESPONSE_BYTES || c.count!==Math.ceil(c.bytes/RESPONSE_CHUNK_BYTES) ||
      c.index!==this.parts.length || c.index>=c.count || typeof c.sha256!=='string' || !/^[a-f0-9]{64}$/.test(c.sha256) ||
      typeof c.data!=='string' || c.data.length>Math.ceil(RESPONSE_CHUNK_BYTES/3)*4) return bad();
    this.identity ??= {count:c.count,bytes:c.bytes,sha256:c.sha256};
    if (c.count!==this.identity.count || c.bytes!==this.identity.bytes || c.sha256!==this.identity.sha256) return bad();
    const part=Buffer.from(c.data,'base64'), expected=Math.min(RESPONSE_CHUNK_BYTES,c.bytes-c.index*RESPONSE_CHUNK_BYTES);
    if (part.length!==expected || part.toString('base64')!==c.data) return bad();
    this.parts.push(part);
    if (this.parts.length<c.count) return;
    const bytes=Buffer.concat(this.parts);this.parts=[];
    if (bytes.length!==c.bytes || createHash('sha256').update(bytes).digest('hex')!==c.sha256) return bad();
    const response=JSON.parse(bytes.toString('utf8')) as Response;
    if (!response || response.id!==message.id || (!Object.hasOwn(response,'result')&&!response.error)) return bad();
    return response;
  }
}
export interface EventMessage { event: 'changed' | 'service' | 'progress'; seq?: number; detail?: string }
export interface Hello { api: number; runtime: string; schema: number; pid: number; home: string; startedAt: string }

export class ApiError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) { super(message); this.code = code; }
}

/**
 * Where the service listens for this AVH_HOME. Linux keeps the socket inside the private state directory;
 * a named pipe has no directory, so its name is derived from the home path.
 */
export function apiEndpoint(home: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    const normalized=win32.normalize(home);
    const identity=(normalized===win32.parse(normalized).root?normalized:normalized.replace(/\\+$/,'')).toLowerCase();
    return `\\\\.\\pipe\\avh-${createHash('sha256').update(identity).digest('hex').slice(0, 16)}`;
  }
  return join(home, 'run', 'avh.sock');
}

/** Split a byte stream into complete lines; a partial line waits for more data. */
export class LineBuffer {
  private pending = '';
  push(chunk: string): string[] {
    this.pending += chunk;
    const lines = this.pending.split('\n');
    this.pending = lines.pop() ?? '';
    if ([...lines,this.pending].some(line=>Buffer.byteLength(line)+1>MAX_MESSAGE_BYTES)) throw new ApiError('BAD_REQUEST', '消息过大');
    return lines.filter(line => line.trim());
  }
}

/** True when something answers on the endpoint; a stale socket file with no listener is not a service. */
export function probeEndpoint(endpoint: string, timeoutMs = 1000): Promise<boolean> {
  if (process.platform !== 'win32' && !existsSync(endpoint)) return Promise.resolve(false);
  return new Promise(resolve => {
    const socket = createConnection(endpoint);
    const timer = setTimeout(() => { socket.destroy(); resolve(false); }, timeoutMs);
    socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolve(true); });
    socket.once('error', () => { clearTimeout(timer); resolve(false); });
  });
}
