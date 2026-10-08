import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseImageInputs, snapshotReferenceImages, verifiedImageInputs } from '../src/image-inputs.ts';
import { providerCommand } from '../src/providers/adapter.ts';
import type { ProviderRequest } from '../src/providers/types.ts';
import { removeTemp } from './fixtures/platform.ts';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6AAAAAElFTkSuQmCC', 'base64');
test('manifest image records refuse outside paths and invalid digests',()=>{
  const valid={path:'_harness/references/input.png',sha256:'a'.repeat(64)};
  assert.deepEqual(parseImageInputs([valid]),[valid]);
  for(const path of ['../private.png','C:/private.png','/private.png','a\\b.png','a/./b.png'])
    assert.throws(()=>parseImageInputs([{...valid,path}]),/相对路径/);
  assert.throws(()=>parseImageInputs([{...valid,sha256:'invalid'}]),/摘要/);
  assert.throws(()=>parseImageInputs(Array(9).fill(valid)),/最多 8/);
});
function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'avh-image-input-')); t.after(() => removeTemp(root));
  const project = join(root, 'project'), source = join(root, 'reference.png'); mkdirSync(project); writeFileSync(source, png);
  return { root, project, source };
}
test('reference snapshots preserve exact bytes, exclude rejected inputs and reject changed snapshots', t => {
  const f = fixture(t);
  const images = snapshotReferenceImages(f.project, [{ path: f.source, role: 'source' }, { path: 'missing.png', role: 'rejected' }]);
  assert.equal(images.length, 1);
  const [image] = verifiedImageInputs(f.project, images);
  assert.deepEqual(readFileSync(image!.path), png);
  writeFileSync(f.source, 'source changed after submission');
  assert.deepEqual(readFileSync(image!.path), png, 'a submitted reference stays frozen');
  writeFileSync(image!.path, Buffer.concat([png, Buffer.from('tamper')]));
  assert.throws(() => verifiedImageInputs(f.project, images), /版本已改变/);
  assert.throws(() => verifiedImageInputs(f.project, [{ path: '../reference.png', sha256: images[0]!.sha256 }]), /越界/);
});

test('production textures are not silently treated as character references',t=>{
  const f=fixture(t),texture=join(f.root,'skin.png');writeFileSync(texture,Buffer.concat([png,Buffer.from('texture')]));
  const references=snapshotReferenceImages(f.project,[{path:f.source,role:'source',kind:'reference'},
    {path:texture,role:'candidate',kind:'texture'},{path:'missing.png',role:'source',kind:'texture'}]);
  assert.equal(references.length,1);
  assert.deepEqual(readFileSync(verifiedImageInputs(f.project,references)[0]!.path),png);
});
test('image requests attach real files and choose the same DeepSeek upstream visual model', t => {
  const f = fixture(t), images = verifiedImageInputs(f.project, snapshotReferenceImages(f.project, [{ path: f.source, role: 'source' }]));
  const request: ProviderRequest = { taskId: 'task', runId: 'run', workflowId: 'wf', projectId: 'project', stageId: 'work',
    attempt: 1, idempotencyKey: 'run', expectedOutputs: [], allowedWrites: [], prompt: '参考这张图做一个角色。', role: 'executor', inputImages: images,
    toolProfile: 'coordination' };
  const run = join(f.root, 'run'); mkdirSync(run);
  const command = providerCommand({ id: 'deepseek', adapter: 'pi-cli', upstream: 'deepseek', model: 'deepseek-v4-pro',
    executable: process.execPath, roles: ['executor'], secret: 'existing-deepseek' }, request, f.project, run);
  assert.equal(command.argv[command.argv.indexOf('--model') + 1], 'deepseek-flash');
  assert.equal(command.argv[command.argv.indexOf('--tools') + 1], 'write', 'coordination observes through Runtime receipts');
  assert.ok(command.argv.includes(`@${images[0]!.path}`), 'the CLI receives a real image attachment, not only its name');
  assert.deepEqual(command.secretEnv, { DEEPSEEK_API_KEY: 'existing-deepseek' });
  assert.equal(readFileSync(command.stdinFile!, 'utf8'), request.prompt, 'no synthetic image description is injected');
  const other = join(f.root, 'other'); mkdirSync(other);
  assert.throws(() => providerCommand({ id: 'legacy', adapter: 'agy-reviewer', executable: 'none', roles: ['reviewer'] },
    request, f.project, other), /图片传递/);
});
