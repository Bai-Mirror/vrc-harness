// Node preload: transport metadata only. Never record URLs, headers, bodies, keys or model text.
import { channel } from 'node:diagnostics_channel';
const requests = new WeakMap();
let sequence = 0;
const emit = (event, request, extra = {}) => {
  const state = requests.get(request);
  if (!state) return;
  process.stderr.write(`${JSON.stringify({ type: 'harness_pi_transport', event, request: state.id,
    at: new Date().toISOString(), elapsedMs: Date.now() - state.startedAt, ...extra })}\n`);
};
channel('undici:request:create').subscribe(({ request }) => {
  requests.set(request, { id: ++sequence, startedAt: Date.now() });
  emit('start', request);
});
channel('undici:request:headers').subscribe(({ request, response }) => {
  emit('headers', request, { status: response.statusCode });
});
channel('undici:request:trailers').subscribe(({ request }) => emit('complete', request));
channel('undici:request:error').subscribe(({ request, error }) => {
  const safeCode = value => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(value) ? value : undefined;
  emit('error', request, { code: safeCode(error?.code), causeCode: safeCode(error?.cause?.code) });
});
