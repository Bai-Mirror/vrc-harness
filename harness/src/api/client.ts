import { createConnection, type Socket } from 'node:net';
import { API_VERSION, ApiError, apiEndpoint, LineBuffer, ResponseAssembly, type ResponseChunk, type EventMessage, type Hello, type Response } from './protocol.ts';

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout; assembly?: ResponseAssembly };

/** Client of the local Runtime API. One connection; calls may overlap; events arrive after subscribe(). */
export class ApiClient {
  readonly endpoint: string;
  hello!: Hello;
  private socket!: Socket;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<(event: EventMessage) => void>();
  private readonly closeListeners = new Set<() => void>();
  private closedFlag = false;

  private constructor(endpoint: string) { this.endpoint = endpoint; }

  static async connect(home: string, timeoutMs = 3000): Promise<ApiClient> {
    const client = new ApiClient(apiEndpoint(home));
    await client.open(timeoutMs);
    const hello = await client.call<Hello>('hello');
    if (hello.api !== API_VERSION) {
      client.close();
      throw new ApiError('CONFLICT', `Runtime 服务的接口版本是 ${hello.api}，本界面需要 ${API_VERSION}；请重启服务或更新 Harness`);
    }
    client.hello = hello;
    return client;
  }

  private open(timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(this.endpoint);
      const timer = setTimeout(() => { socket.destroy(); reject(new ApiError('UNAVAILABLE', 'Runtime 服务没有响应')); }, timeoutMs);
      socket.once('connect', () => { clearTimeout(timer); resolve(); });
      socket.once('error', error => {
        clearTimeout(timer);
        reject(new ApiError('UNAVAILABLE', (error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ECONNREFUSED'
          ? 'Runtime 服务未运行' : `无法连接 Runtime 服务：${error.message}`));
      });
      const buffer = new LineBuffer();
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => {
        let lines: string[];
        try { lines = buffer.push(chunk); } catch { socket.destroy(); return; }
        for (const line of lines) this.receive(line);
      });
      socket.on('close', () => {
        this.closedFlag = true;
        for (const [, call] of this.pending) { clearTimeout(call.timer); call.reject(new ApiError('UNAVAILABLE', '与 Runtime 服务的连接已断开')); }
        this.pending.clear();
        for (const listener of this.closeListeners) listener();
      });
      this.socket = socket;
    });
  }
  private receive(line: string): void {
    let message: Response & Partial<EventMessage> & Partial<ResponseChunk>;
    try { message = JSON.parse(line); } catch { this.socket.destroy(); return; }
    if (message.event) { for (const listener of this.listeners) listener(message as EventMessage); return; }
    const call = typeof message.id==='number' ? this.pending.get(message.id) : undefined;
    if (!call) return;
    try {
      if (message.chunk) {
        call.assembly ??= new ResponseAssembly();
        const response=call.assembly.push(message as ResponseChunk);
        if (!response) return;
        message=response;
      } else if (call.assembly) throw new ApiError('BAD_REQUEST','响应分块未完成');
    } catch (error) {
      this.pending.delete(Number(message.id));clearTimeout(call.timer);call.reject(error as Error);return;
    }
    this.pending.delete(Number(message.id));
    clearTimeout(call.timer);
    if (message.error) call.reject(new ApiError(message.error.code, message.error.message));
    else call.resolve(message.result);
  }

  get closed(): boolean { return this.closedFlag; }
  call<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs = 60_000): Promise<T> {
    if (this.closedFlag) return Promise.reject(new ApiError('UNAVAILABLE', '与 Runtime 服务的连接已断开'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new ApiError('UNAVAILABLE', `${method} 超时`)); }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      this.socket.write(`${JSON.stringify({ id, method, params, responseChunks:'sha256-v1' })}\n`);
    });
  }
  async subscribe(listener: (event: EventMessage) => void): Promise<number> {
    this.listeners.add(listener);
    return (await this.call<{ seq: number }>('subscribe')).seq;
  }
  onClose(listener: () => void): void { this.closeListeners.add(listener); }
  close(): void { this.socket?.end(); this.socket?.destroy(); }
}
