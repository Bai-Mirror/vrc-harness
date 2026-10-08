// DATA/D7: run the shipped nginx API boundary acceptance (deploy/tests/nginx-api-boundary.py) from the repository.
// The Python driver was only reachable by copying its long command line out of deploy/README.md, so nothing in the
// product consumed it. This wrapper is that consumer: it resolves the configuration and the two images, and it is
// explicit about what it cannot prove.
//
// Usage: node scripts/nginx-boundary.mjs [--nginx-image <ref>] [--upstream-image <ref>] [--config <file>] [--output <file>]
//   Images may also come from AVH_NGINX_TEST_IMAGE and AVH_NODE_TEST_IMAGE, or be discovered among the local images.
//   Exit 0 the boundary passed; 1 it ran and failed; 3 it was skipped, which is NOT a pass.
// A skipped run means Docker (or openssl, or Python 3) is unavailable, or no image was found: start Docker or pass
// --nginx-image/--upstream-image and run it again. Nothing is fabricated and no report is written on a skip.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKIP_EXIT = 3;
const harnessRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = dirname(harnessRoot);
const args = process.argv.slice(2);
const option = name => { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1]; };

function probe(command, commandArgs) {
  return spawnSync(command, commandArgs, { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
}
function skip(reason) {
  console.log(`SKIPPED nginx api boundary: ${reason}`);
  console.log('A skipped deployment check is not evidence; run it again once the requirement is met.');
  process.exit(SKIP_EXIT);
}
/** The first local image whose repository equals, then contains, one of the wanted names. */
function discoverImage(wanted) {
  const listed = probe('docker', ['images', '--format', '{{.Repository}}:{{.Tag}}']);
  if (listed.status !== 0) return undefined;
  const names = listed.stdout.split('\n').map(line => line.trim()).filter(name => name && !name.startsWith('<none>'));
  const repository = name => name.slice(0, name.includes(':') ? name.lastIndexOf(':') : undefined).split('/').pop();
  for (const want of wanted) { const exact = names.find(name => repository(name) === want); if (exact) return exact; }
  for (const want of wanted) { const partial = names.find(name => repository(name).includes(want)); if (partial) return partial; }
  return undefined;
}
function python3() {
  for (const candidate of [process.env.AVH_PYTHON, 'python3', 'python'].filter(Boolean)) {
    const probed = probe(candidate, ['--version']);
    if (probed.status === 0 && /^Python 3/.test(`${probed.stdout}${probed.stderr}`.trim())) return candidate;
  }
  return undefined;
}

const docker = probe('docker', ['version', '--format', '{{.Server.Version}}']);
if (docker.status !== 0) skip(`the Docker daemon is not reachable: ${`${docker.stderr}${docker.stdout}`.trim().split('\n')[0]}`);
if (probe('openssl', ['version']).status !== 0) skip('openssl is not on PATH (the fixture generates its own certificate)');
const python = python3();
if (!python) skip('no Python 3 interpreter found (set AVH_PYTHON to name one)');

const nginxImage = option('--nginx-image') ?? process.env.AVH_NGINX_TEST_IMAGE ?? discoverImage(['nginx']);
if (!nginxImage) skip('no nginx image found (pass --nginx-image or set AVH_NGINX_TEST_IMAGE)');
const upstreamImage = option('--upstream-image') ?? process.env.AVH_NODE_TEST_IMAGE ?? discoverImage(['node', 'harness-server']);
if (!upstreamImage) skip('no Node image found (pass --upstream-image or set AVH_NODE_TEST_IMAGE)');

const config = resolve(option('--config') ?? join(repoRoot, 'deploy', 'nginx', 'harness.nymiro.moe.conf'));
if (!existsSync(config)) skip(`the shipped nginx configuration is missing: ${config}`);
const driver = join(repoRoot, 'deploy', 'tests', 'nginx-api-boundary.py');
const output = resolve(option('--output') ?? join(mkdtempSync(join(tmpdir(), 'avh-nginx-boundary-')), 'report.json'));

console.log(`nginx api boundary: ${config} with ${nginxImage} and ${upstreamImage}`);
const result = spawnSync(python, [driver, '--config', config, '--nginx-image', nginxImage,
  '--upstream-image', upstreamImage, '--output', output], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
process.stdout.write(result.stdout ?? '');
process.stderr.write(result.stderr ?? '');
if (result.status !== 0) {
  console.error(`FAILED nginx api boundary (exit ${result.status}); report: ${output}`);
  process.exit(1);
}
console.log(`ok nginx api boundary; report: ${output}`);
