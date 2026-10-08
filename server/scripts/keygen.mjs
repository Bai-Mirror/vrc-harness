#!/usr/bin/env node
// Generates an Ed25519 release-signing key pair: <dir>/<keyId>.key (private, 0600) and <dir>/<keyId>.pub (public).
// Refuses any directory inside a Git work tree, so a private key cannot end up in a commit; never overwrites a key.
//
//   node server/scripts/keygen.mjs ~/.local/share/avh-release-keys harness-stable-1
import { generateKeyPairSync } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

function fail(message) {
  console.error(`keygen: ${message}`);
  process.exit(2);
}

const [dir, keyId, ...extra] = process.argv.slice(2);
if (!dir || !keyId || extra.length) fail('usage: keygen.mjs <directory> <keyId>');
if (!/^[a-zA-Z0-9._-]+$/.test(keyId)) fail('keyId may only use letters, digits, ".", "_" and "-"');

const target = resolve(dir);
let existing = target;
while (!existsSync(existing)) existing = dirname(existing);
for (let at = realpathSync(existing); ; at = dirname(at)) {
  if (existsSync(join(at, '.git'))) fail(`${target} is inside the Git work tree ${at}; keep signing keys outside any repository`);
  if (dirname(at) === at) break;
}

const privatePath = join(target, `${keyId}.key`), publicPath = join(target, `${keyId}.pub`);
for (const path of [privatePath, publicPath]) if (existsSync(path)) fail(`${path} already exists`);
mkdirSync(target, { recursive: true, mode: 0o700 });
// Windows has no POSIX private modes. Protect the named key directory before writing either key.
if (process.platform === 'win32') {
  try {
    const windowsEnv = { ...process.env, HARNESS_SIGNING_DIR: target };
    // A pwsh 7 parent's module paths are incompatible with Windows PowerShell 5.1's Security module.
    delete windowsEnv.PSModulePath;
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `
      $ErrorActionPreference = 'Stop'
      $owner = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
      $acl = [System.Security.AccessControl.DirectorySecurity]::new()
      $acl.SetOwner($owner)
      $acl.SetAccessRuleProtection($true, $false)
      $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($owner, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow')
      $acl.AddAccessRule($rule)
      Set-Acl -LiteralPath $env:HARNESS_SIGNING_DIR -AclObject $acl
    `], { env: windowsEnv, windowsHide: true, stdio: 'pipe' });
  } catch (error) { fail(`cannot secure the signing-key directory for this Windows user; no key was written: ${String(error.stderr ?? error.message).trim().slice(0, 1000)}`); }
}
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
writeFileSync(privatePath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { flag: 'wx', mode: 0o600 });
writeFileSync(publicPath, publicPem, { flag: 'wx', mode: 0o644 });
console.log(JSON.stringify({ keyId, privateKey: privatePath, publicKey: publicPath, trustedKeys: { [keyId]: publicPem } }, null, 2));
