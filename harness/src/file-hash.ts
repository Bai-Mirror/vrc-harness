import { createHash } from 'node:crypto';
import { closeSync, openSync, readSync } from 'node:fs';

const CHUNK = 8 * 1024 * 1024;

/** SHA-256 of a file's content, read in chunks: a delivery package can be larger than one Buffer may hold (2 GiB). */
export function sha256File(path: string): string {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(CHUNK);
  const fd = openSync(path, 'r');
  try {
    for (let read = readSync(fd, buffer, 0, CHUNK, null); read > 0; read = readSync(fd, buffer, 0, CHUNK, null))
      hash.update(buffer.subarray(0, read));
  } finally { closeSync(fd); }
  return hash.digest('hex');
}
