// DevTools ownership and retry rules used by gui-demo.mjs.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** A failure on the browser transport, which is the only retryable demo failure. */
export class DemoTransportError extends Error {
  constructor(message) { super(message); this.name = 'DemoTransportError'; }
}

/** Whether a failed step may be attempted again. Page assertions and CDP protocol errors are not transport failures. */
export function isRetryableDemoError(error) { return error instanceof DemoTransportError; }

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/** One HTTP read of the DevTools endpoint, bounded by whatever the caller's deadline still allows. */
function read(cdpPort, path, remaining, init = {}, signal) {
  return fetch(`http://127.0.0.1:${cdpPort}${path}`, { ...init,
    signal: AbortSignal.any([AbortSignal.timeout(Math.max(1, Math.min(5_000, remaining))), ...(signal ? [signal] : [])]) });
}

/** Record child exit before discovery begins; aborting also interrupts discovery HTTP reads and the socket handshake. */
export function watchDemoBrowser(child) {
  const controller = new AbortController();
  const fail = message => { if (!controller.signal.aborted) controller.abort(new DemoTransportError(message)); };
  child.once('error', error => fail(`the browser did not start: ${error.message}`));
  child.once('exit', (code, signal) => fail(`the browser exited (code ${code}, signal ${signal})`));
  return controller.signal;
}

/** Discover only the endpoint written by this child in its fresh profile, then confirm its browser socket identity. */
export async function readOwnedEndpoint(profile, options) {
  const deadline = Date.now() + options.timeoutMs;
  let last = 'DevToolsActivePort was not written';
  for (;;) {
    options.signal?.throwIfAborted();
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    try {
      const [portLine, browserPath] = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).trim().split(/\r?\n/);
      const cdpPort = Number(portLine);
      if (!/^\d+$/.test(portLine) || cdpPort < 1 || cdpPort > 65535 || !/^\/devtools\/browser\/[^/]+$/.test(browserPath))
        throw new Error('the profile contains an invalid DevToolsActivePort');
      const response = await read(cdpPort, '/json/version', remaining, {}, options.signal);
      if (!response.ok) throw new Error(`the DevTools endpoint answered HTTP ${response.status}`);
      const version = await response.json();
      const expected = `ws://127.0.0.1:${cdpPort}${browserPath}`;
      if (version.webSocketDebuggerUrl !== expected)
        throw new Error('the DevTools endpoint does not match the browser socket written in this profile');
      options.signal?.throwIfAborted();
      return cdpPort;
    } catch (error) {
      options.signal?.throwIfAborted();
      last = error instanceof Error ? error.message : String(error);
    }
    await delay(Math.min(50, Math.max(0, deadline - Date.now())));
  }
  throw new DemoTransportError(`no owned DevTools endpoint within ${options.timeoutMs}ms: ${last}`);
}

/** Ask the browser for a page this run owns and keep the target id it answers with. */
export async function createOwnedTarget(cdpPort, options) {
  const deadline = Date.now() + options.timeoutMs;
  let last = 'the endpoint was never asked';
  for (;;) {
    options.signal?.throwIfAborted();
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    try {
      const response = await read(cdpPort, '/json/new?about:blank', remaining, { method: 'PUT' }, options.signal);
      if (!response.ok) throw new Error(`the DevTools endpoint answered HTTP ${response.status}`);
      const target = await response.json();
      if (target?.id && target.webSocketDebuggerUrl) return target;
      throw new Error(`the DevTools endpoint returned no usable target: ${JSON.stringify(target)}`);
    } catch (error) { options.signal?.throwIfAborted(); last = error instanceof Error ? error.message : String(error); }
    await delay(Math.min(250, Math.max(0, deadline - Date.now())));
  }
  throw new DemoTransportError(`no page target of this run was created within ${options.timeoutMs}ms: ${last}`);
}

/** Select only the page target whose id was returned by this run's own /json/new call. */
export function selectDemoTarget(targets, ownedId) {
  const pages = targets.filter(target => target.type === 'page');
  const target = pages.find(candidate => candidate.id === ownedId);
  if (!target) throw new DemoTransportError(`the browser lists ${pages.length} page target(s) and none is this run's own (${ownedId})`);
  if (!target.webSocketDebuggerUrl) throw new DemoTransportError(`this run's own page target (${ownedId}) has no DevTools socket`);
  return target;
}

/** Read the target list until this run's own page is in it. */
export async function findOwnedTarget(cdpPort, ownedId, options) {
  const deadline = Date.now() + options.timeoutMs;
  let last = 'the list was never read';
  for (;;) {
    options.signal?.throwIfAborted();
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    try {
      const list = await (await read(cdpPort, '/json', remaining, {}, options.signal)).json();
      return selectDemoTarget(list, ownedId);
    } catch (error) { options.signal?.throwIfAborted(); last = error instanceof Error ? error.message : String(error); }
    await delay(Math.min(250, Math.max(0, deadline - Date.now())));
  }
  throw new DemoTransportError(`the browser did not confirm this run's own page target (${ownedId}) within ${options.timeoutMs}ms: ${last}`);
}

/** The real send path: socket loss and screenshot timeouts are retryable, CDP refusals retain their protocol details. */
export async function connectDemoSocket(socket, options) {
  let lost = null, next = 0;
  const pending = new Map();
  const lose = reason => {
    lost ??= reason;
    for (const [id, call] of pending) { pending.delete(id); clearTimeout(call.timer); call.reject(lost); }
  };
  const onMessage = event => {
    const message = JSON.parse(event.data);
    const call = pending.get(message.id);
    if (!call) return;
    pending.delete(message.id); clearTimeout(call.timer);
    if (message.error) {
      const error = new Error(`${call.method}: ${message.error.message}`);
      Object.assign(error, { code: message.error.code, data: message.error.data });
      call.reject(error);
    } else call.resolve(message.result);
  };
  const onClose = () => lose(new DemoTransportError('the browser closed the DevTools socket'));
  const onError = () => lose(new DemoTransportError('the DevTools socket failed'));
  const onAbort = () => lose(options.signal.reason);
  socket.addEventListener('message', onMessage);
  socket.addEventListener('close', onClose);
  socket.addEventListener('error', onError);
  options.signal?.addEventListener('abort', onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  const close = () => {
    lose(new DemoTransportError('the demo connection was closed'));
    socket.removeEventListener('message', onMessage);
    socket.removeEventListener('close', onClose);
    socket.removeEventListener('error', onError);
    options.signal?.removeEventListener('abort', onAbort);
    try { socket.close(); } catch { /* already closed */ }
  };
  try {
    await new Promise((resolve, reject) => {
      const settle = error => {
        clearTimeout(timer);
        socket.removeEventListener('open', opened); socket.removeEventListener('close', failed);
        socket.removeEventListener('error', failed); options.signal?.removeEventListener('abort', failed);
        error ? reject(error) : resolve();
      };
      const opened = () => settle(lost);
      const failed = () => settle(lost ?? new DemoTransportError('the DevTools handshake failed'));
      const timer = setTimeout(() => settle(new DemoTransportError(`the DevTools socket did not open within ${options.handshakeMs}ms`)), options.handshakeMs);
      socket.addEventListener('open', opened); socket.addEventListener('close', failed); socket.addEventListener('error', failed);
      options.signal?.addEventListener('abort', failed, { once: true });
      if (lost) failed(); else if (socket.readyState === 1) opened();
    });
  } catch (error) { close(); throw error; }
  const send = (method, params = {}, timeoutMs = options.timeoutMs) => {
    if (lost) return Promise.reject(lost);
    return new Promise((resolve, reject) => {
      const id = ++next;
      const timer = setTimeout(() => {
        if (!pending.delete(id)) return;
        const ErrorType = method === 'Page.captureScreenshot' ? DemoTransportError : Error;
        reject(new ErrorType(`${method}: the browser did not answer within ${timeoutMs / 1000}s`));
      }, timeoutMs);
      pending.set(id, { method, timer, resolve, reject });
      try { socket.send(JSON.stringify({ id, method, params })); }
      catch (error) { lose(new DemoTransportError(`${method}: the DevTools socket refused the call (${error.message})`)); }
    });
  };
  return { send, close, get lost() { return lost; } };
}

/** Retry run only for transport failures, at most attempts times. */
export async function retryTransport(run, options = {}) {
  const attempts = options.attempts ?? 2;
  for (let attempt = 1; ; attempt++) {
    try { return await run(); }
    catch (error) {
      if (attempt >= attempts || !isRetryableDemoError(error)) throw error;
      options.onRetry?.(error, attempt);
      if (options.waitMs) await delay(options.waitMs);
    }
  }
}
