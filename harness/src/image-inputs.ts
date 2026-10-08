import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { hostPlatform } from './host-platform.ts';

export interface ImageInput { path: string; sha256: string }
export function parseImageInputs(value: unknown): ImageInput[] {
  if (!Array.isArray(value) || value.length>8) throw new Error('图片输入须为最多 8 张的列表');
  return value.map(image=>{
    if (!image || typeof image!=='object' || Array.isArray(image) || Object.keys(image).some(k=>!['path','sha256'].includes(k)) ||
      typeof image.path!=='string' || /[\\:\x00-\x1f]/.test(image.path) || image.path.split('/').some((p:string)=>!p||p==='.'||p==='..') ||
      typeof image.sha256!=='string' || !/^[a-f0-9]{64}$/.test(image.sha256)) throw new Error('图片输入需要项目内相对路径和有效摘要');
    return {path:image.path,sha256:image.sha256};
  });
}
const MAX_BYTES = 10 * 1024 * 1024;
export function imageBytes(path: string): { bytes: Buffer; extension: string; sha256: string } {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) throw new Error('参考图须为不超过 10 MB 的普通图片文件');
  const bytes = readFileSync(path);
  if (bytes.length > MAX_BYTES) throw new Error('参考图超过 10 MB');
  const extension = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'png'
    : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'jpg'
    : bytes.subarray(0,4).toString() === 'RIFF' && bytes.subarray(8,12).toString() === 'WEBP' ? 'webp' : undefined;
  if (!extension) throw new Error('参考图内容须为 PNG、JPEG 或 WebP');
  return { bytes, extension, sha256: createHash('sha256').update(bytes).digest('hex') };
}

/** Runtime-owned snapshots. Only explicitly associated, non-rejected image assets enter model input. */
export function snapshotReferenceImages(project: string, assets: Array<{ path: string; role: string; kind?:string }>): ImageInput[] {
  const selected = assets.filter(a => a.role !== 'rejected' && a.kind!=='texture' && /\.(png|jpe?g|webp)$/i.test(a.path));
  if (selected.length > 8) throw new Error('一次最多使用 8 张参考图');
  return selected.map(asset => {
    const image = imageBytes(asset.path), dir = join(project, '_harness', 'references');
    const path = join(dir, `${image.sha256}.${image.extension}`);
    if (!hostPlatform.within(project, path)) throw new Error('参考图快照路径越出项目');
    mkdirSync(dir, { recursive: true });
    if (!existsSync(path)) writeFileSync(path, image.bytes, { flag: 'wx' });
    if (imageBytes(path).sha256 !== image.sha256) throw new Error('参考图快照内容已改变');
    return { path: relative(project, path).replaceAll('\\', '/'), sha256: image.sha256 };
  });
}

export function verifiedImageInputs(project: string, images: ImageInput[]): ImageInput[] {
  if (images.length > 8) throw new Error('一次最多使用 8 张参考图');
  return images.map(image => {
    const path = join(project, image.path);
    if (!hostPlatform.within(project, path) || !/^[a-f0-9]{64}$/.test(image.sha256) || imageBytes(path).sha256 !== image.sha256)
      throw new Error('参考图版本已改变或路径越界，请重新提交');
    return { path, sha256: image.sha256 };
  });
}
