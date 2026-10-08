export class DemoTransportError extends Error {}
export function isRetryableDemoError(error: unknown): boolean;
export function createOwnedTarget(cdpPort: number, options: { timeoutMs: number; signal?: AbortSignal }): Promise<{
  id: string; type: string; url?: string; webSocketDebuggerUrl?: string;
}>;
export function findOwnedTarget(cdpPort: number, ownedId: string, options: { timeoutMs: number; signal?: AbortSignal }): Promise<{
  id: string; type: string; url?: string; webSocketDebuggerUrl?: string;
}>;
export function retryTransport<T>(run: () => Promise<T>, options?: {
  attempts?: number; waitMs?: number; onRetry?: (error: Error, attempt: number) => void;
}): Promise<T>;
export function watchDemoBrowser(child: import('node:child_process').ChildProcess): AbortSignal;
export function readOwnedEndpoint(profile: string, options: { timeoutMs: number; signal?: AbortSignal }): Promise<number>;
export function connectDemoSocket(socket: WebSocket, options: {
  timeoutMs: number; handshakeMs: number; signal?: AbortSignal;
}): Promise<{ send(method: string, params?: object, timeoutMs?: number): Promise<any>; close(): void; readonly lost: Error | null }>;
