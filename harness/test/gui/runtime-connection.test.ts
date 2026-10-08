import assert from 'node:assert/strict';
import { createServer, type Socket } from 'node:net';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ApiClient } from '../../src/api/client.ts';
import { apiEndpoint } from '../../src/api/protocol.ts';
import { GuiRuntimeConnection } from '../../src/gui/runtime-connection.ts';
import { removeTemp } from '../fixtures/platform.ts';

test('GUI reconnects the actual API socket without restarting a Runtime or replaying an uncertain mutation', async t => {
  const home = mkdtempSync(join(tmpdir(), 'avh-gui-reconnect-')); t.after(() => removeTemp(home));
  mkdirSync(join(home, 'run'), { mode: 0o700 });
  const sockets = new Set<Socket>(); let starts = 0, opens = 0, writes = 0, state = 'RUNNING';
  const endpoint = apiEndpoint(home);
  const server = createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); let input = '';
    socket.setEncoding('utf8'); socket.on('data', chunk => {
      input += chunk; let index: number;
      while ((index = input.indexOf('\n')) >= 0) {
        const request = JSON.parse(input.slice(0, index)); input = input.slice(index + 1);
        if (request.method === 'project.production.approve') { writes++; socket.destroy(); continue; }
        const result = request.method === 'hello' ? { api: 2 } : request.method === 'subscribe' ? { seq: 1 } : { state };
        socket.write(JSON.stringify({ id: request.id, result }) + '\n');
      }
    });
  });
  await new Promise<void>(resolve => server.listen(endpoint, resolve));
  const events: unknown[] = [];
  const proxy = new GuiRuntimeConnection(async () => { opens++; return ApiClient.connect(home); },
    async () => { starts++; }, event => events.push(event));
  t.after(async () => { proxy.close(); for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const [first, concurrent] = await Promise.all([proxy.get(), proxy.get()]);
  assert.equal(first, concurrent); assert.equal(opens, 1);
  assert.deepEqual(await first.call('project.list'), { state: 'RUNNING' });
  await assert.rejects(first.call('project.production.approve'), /连接已断开/);
  state = 'FAILED';
  const next = await proxy.get();
  assert.notEqual(next, first); assert.deepEqual(await next.call('project.list'), { state: 'FAILED' });
  assert.equal(starts, 1, 'reconnection never starts the Runtime or Scheduler');
  assert.equal(writes, 1, 'the lost mutation response is never replayed');
  assert.equal(opens, 2); assert.ok(events.some(event => (event as any).runtimeConnection === 'lost'));
});
