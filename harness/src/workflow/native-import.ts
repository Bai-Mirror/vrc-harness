import { existsSync, lstatSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { sha256File } from '../file-hash.ts';
import { hostPlatform } from '../host-platform.ts';

const INPUT = 'Assets/_Harness/Face/design.json';
const OBSERVATION = '_harness/face/observation.json';
const PENDING = '_harness/face/native-import-pending.json';
const AUTHORITY = 'native-import-authority.json';
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function plain(project: string, path: string): string {
  if (typeof path !== 'string' || /[\\:\x00-\x1f]/.test(path) || path.split('/').some(p => !p || p === '.' || p === '..')) throw new Error('临时导入路径无效');
  let current = project;
  for (const part of ['', ...path.split('/')]) {
    if (part) current = join(current, part);
    if (lstatSync(current).isSymbolicLink()) throw new Error('临时导入路径含链接');
  }
  if (!lstatSync(current).isFile()) throw new Error('临时导入文件无效');
  return current;
}
function json(path: string, limit = 128 * 1024 * 1024): any {
  if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new Error('临时导入记录无效');
  if (lstatSync(path).size > limit) throw new Error(`临时导入证据过大（当前读取上限 ${Math.floor(limit / 1024 / 1024)} MB）；工程和已完成证据保留，请更新 Harness 后核对并继续`);
  return JSON.parse(readFileSync(path, 'utf8'));
}
export interface NativeImportAuthority {
  schema: 'face-native-import-authority/0.1'; modelPath: string; originalSha256: string; metaSha256: string;
  candidatePath: string; candidateSha256: string; inputSha256: string; observationSha256: string;
}
/** Runtime freezes exact source and candidate bytes before a supervised Unity unit may substitute them. */
export function authorizeNativeImport(project: string, runDirectory: string): void {
  if (!existsSync(join(project, INPUT))) return;
  const inputPath = plain(project, INPUT), input = json(inputPath);
  if (input.route !== 'native-fbx/1' || input.mode !== 'design') return;
  const observedPath = plain(project, OBSERVATION), observed = json(observedPath);
  if (input.observationSha256 !== sha256File(observedPath)) throw new Error('临时导入观察版本已变化');
  const target = observed.targets?.find((t: any) => t.targetId === input.targetId), source = target?.mesh;
  const receiptPath = plain(project, input.candidateReceipt?.file);
  if (sha256File(receiptPath) !== input.candidateReceipt?.sha256) throw new Error('临时导入候选回执已变化');
  // A measured commercial receipt contains 312 MB of per-state compensation evidence.
  // This local, SHA-bound producer artifact is larger than the small transaction/authority records.
  const receipt = json(receiptPath, 512 * 1024 * 1024), fbx = receipt.outputs?.fbx;
  const candidatePath = input.candidateReceipt.file.split('/').slice(0, -1).join('/') + '/' + fbx?.file;
  if (receipt.route !== 'native-fbx/1' || receipt.productionAccepted !== false || !source?.path?.startsWith('Assets/') ||
      !digest(source.sha256) || !digest(source.metaSha256) || receipt.source?.sha256 !== source.sha256 || !digest(fbx?.sha256) ||
      sha256File(plain(project, source.path)) !== source.sha256 || sha256File(plain(project, source.path + '.meta')) !== source.metaSha256 ||
      sha256File(plain(project, candidatePath)) !== fbx.sha256) throw new Error('临时导入来源或候选未核清');
  const authority: NativeImportAuthority = { schema: 'face-native-import-authority/0.1', modelPath: source.path,
    originalSha256: source.sha256, metaSha256: source.metaSha256, candidatePath, candidateSha256: fbx.sha256,
    inputSha256: sha256File(inputPath), observationSha256: sha256File(observedPath) };
  const path = join(runDirectory, AUTHORITY), content = JSON.stringify(authority);
  if (existsSync(path)) { if (readFileSync(path, 'utf8') !== content) throw new Error('临时导入授权已有不同版本'); }
  else hostPlatform.writePrivate(path, content, { flag: 'wx' });
}
function authority(project: string, runDirectory: string): NativeImportAuthority | undefined {
  const path = join(runDirectory, AUTHORITY); if (!existsSync(path)) return;
  const saved = json(path, 16384) as NativeImportAuthority;
  if (saved.schema !== 'face-native-import-authority/0.1' || ![saved.originalSha256, saved.metaSha256, saved.candidateSha256, saved.inputSha256, saved.observationSha256].every(digest) ||
      !saved.modelPath?.startsWith('Assets/') || !saved.candidatePath?.startsWith('Assets/_Harness/Face/Candidates/') ||
      sha256File(plain(project, INPUT)) !== saved.inputSha256 || sha256File(plain(project, OBSERVATION)) !== saved.observationSha256 ||
      sha256File(plain(project, saved.candidatePath)) !== saved.candidateSha256 || sha256File(plain(project, saved.modelPath + '.meta')) !== saved.metaSha256) throw new Error('临时导入授权来源已变化');
  return saved;
}
/** A pending file alone grants nothing: it must match this Run's Runtime-owned authorization and backup. */
export function pendingNativeImport(project: string, runDirectory: string): (NativeImportAuthority & { backup: string }) | undefined {
  if (!existsSync(join(project, PENDING))) return;
  const saved = authority(project, runDirectory); if (!saved) return;
  const pending = json(plain(project, PENDING), 16384);
  if (pending.schema !== 'face-native-import-transaction/0.1' || pending.modelPath !== saved.modelPath ||
      pending.originalSha256 !== saved.originalSha256 || pending.candidateSha256 !== saved.candidateSha256 || pending.metaSha256 !== saved.metaSha256 ||
      !pending.backup?.startsWith('_harness/face/native-import/') || sha256File(plain(project, pending.backup)) !== saved.originalSha256 ||
      sha256File(plain(project, pending.backup + '.meta')) !== saved.metaSha256 ||
      ![saved.originalSha256, saved.candidateSha256].includes(sha256File(plain(project, saved.modelPath)))) throw new Error('临时导入事务无法核对；停止后保留工程并恢复审阅');
  return { ...saved, backup: pending.backup };
}
/** Only after the complete supervised process tree stopped. Preserve the interrupted transaction as evidence. */
export function recoverNativeImport(project: string, runDirectory: string): void {
  const pending = pendingNativeImport(project, runDirectory); if (!pending) return;
  const model = plain(project, pending.modelPath), temporary = join(dirname(model), '.avh-native-recovering');
  writeFileSync(temporary, readFileSync(plain(project, pending.backup)), { flag: 'wx' }); renameSync(temporary, model);
  if (sha256File(model) !== pending.originalSha256) throw new Error('临时导入恢复回读失败');
  const record = plain(project, PENDING);
  renameSync(record, join(dirname(plain(project, pending.backup)), 'recovered-' + sha256File(record) + '.json'));
}
export function restoredNativeImportPaths(project: string, runDirectory: string): string[] {
  const saved = authority(project, runDirectory);
  if (!saved || existsSync(join(project, PENDING)) || sha256File(plain(project, saved.modelPath)) !== saved.originalSha256) return [];
  return [saved.modelPath, saved.modelPath + '.meta'];
}
