import path from 'node:path';
import { realpath, mkdir, writeFile, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export function inside(root: string, target: string) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}
export function imageExtension(data: Uint8Array): string | undefined {
  if (data.length >= 8 && Buffer.from(data.subarray(0, 8)).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return '.png';
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return '.jpg';
  if (/^GIF8[79]a$/.test(Buffer.from(data.subarray(0, 6)).toString())) return '.gif';
  if (Buffer.from(data.subarray(0,4)).toString() === 'RIFF' && Buffer.from(data.subarray(8,12)).toString() === 'WEBP') return '.webp';
}
export async function safeDirectory(root: string, target: string): Promise<string> {
  const realRoot = await realpath(root);
  if (!inside(root, target)) throw new Error('画像の保存先はワークスペース内に設定してください。');
  // Walk each ancestor before creating anything; a symlink cannot lead a write outside the workspace.
  let current = root;
  for (const part of path.relative(root, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { await mkdir(current); } catch (error: any) { if (error.code !== 'EEXIST') throw error; }
    const resolved = await realpath(current);
    if (!inside(realRoot, resolved)) throw new Error('保存先のシンボリックリンクがワークスペース外を指しています。');
  }
  return realpath(target);
}
export async function copyImage(root: string, articlePath: string, setting: string, bytes: Uint8Array): Promise<string> {
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error('画像は20MB以下にしてください。');
  const ext = imageExtension(bytes);
  if (!ext) throw new Error('PNG・JPEG・WebP・GIFのみ対応しています。');
  const folder = setting.replaceAll('{name}', path.basename(articlePath, path.extname(articlePath)));
  const target = path.resolve(path.dirname(articlePath), folder);
  const realDir = await safeDirectory(root, target);
  const name = randomUUID() + ext;
  await writeFile(path.join(realDir, name), bytes, { flag: 'wx' });
  const relative = path.relative(path.dirname(articlePath), path.join(target, name)).split(path.sep).join('/');
  return relative.startsWith('.') ? relative : './' + relative;
}
export async function readImage(file: string): Promise<Uint8Array> {
  const bytes = await readFile(file);
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error('画像は20MB以下にしてください。');
  return bytes;
}
