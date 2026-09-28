import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { authorizeAssetFile, encodeAssetUrl } from './assetRegistry.js';
import { assertTrustedPathWithinRoot } from './digitalTwinSourceEnvironmentRelink.js';
import { ensureOpeningDirectory } from './openingPackageDirectory.js';

const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);

function assertImageHeader(header: Buffer, extension: string): void {
  const valid = extension === '.png' ? header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : extension === '.jpg' || extension === '.jpeg' ? header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff
      : extension === '.webp' ? header.toString('ascii', 0, 4) === 'RIFF' && header.toString('ascii', 8, 12) === 'WEBP'
        : header.toString('ascii', 0, 6) === 'GIF87a' || header.toString('ascii', 0, 6) === 'GIF89a';
  if (!valid) throw new Error('开场图片内容与扩展名不一致。');
}

/** 场景覆盖素材使用内容地址存储，互相引用不会被重导覆盖。 */
export async function importOpeningImage(projectRoot: string, sourcePath: string): Promise<{ assetUrl: string; filePath: string; size: number; sha256: string }> {
  const extension = path.extname(sourcePath).toLowerCase();
  if (!EXTENSIONS.has(extension)) throw new Error('开场素材仅支持 PNG、JPG、WEBP、GIF 图片。');
  const before = await fs.stat(sourcePath);
  if (!before.isFile() || before.size < 12 || before.size > MAX_IMAGE_BYTES) throw new Error('开场图片为空或超过 32 MiB。');
  const bytes = await fs.readFile(sourcePath);
  if (bytes.length !== before.size) throw new Error('开场图片在导入期间发生变化，请重试。');
  assertImageHeader(bytes, extension);
  const hash = createHash('sha256').update(bytes).digest('hex');
  const root = path.join(projectRoot, 'Assets', 'OpeningAssets');
  await ensureOpeningDirectory(projectRoot, root);
  const target = path.join(root, `${hash}${extension}`), staging = path.join(root, `.import-${randomUUID()}`);
  try {
    try {
      await fs.access(target);
      await assertTrustedPathWithinRoot(root, target, '开场图片');
      await validateOpeningImageFile(root, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await fs.writeFile(staging, bytes, { flag: 'wx' });
      // link 以独占方式发布；并发导入同内容时保留已存在的完整文件。
      try { await fs.link(staging, target); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      await validateOpeningImageFile(root, target);
    }
  } finally { await fs.rm(staging, { force: true }); }
  authorizeAssetFile(target);
  return { assetUrl: encodeAssetUrl(target), filePath: target, size: bytes.length, sha256: hash };
}

/** 文件名绑定内容摘要，SOURCE 与 DIST 都会复核真实字节。 */
export async function validateOpeningImageFile(projectRoot: string, sourcePath: string, signal = new AbortController().signal) {
  await assertTrustedPathWithinRoot(projectRoot, sourcePath, '开场图片');
  const fileName = path.basename(sourcePath), extension = path.extname(fileName).toLowerCase();
  if (!/^[a-f0-9]{64}\.(?:png|jpe?g|webp|gif)$/.test(fileName)) throw new Error('开场图片不是有效的内容地址文件。');
  const before = await fs.lstat(sourcePath);
  if (!before.isFile() || before.size < 12 || before.size > MAX_IMAGE_BYTES) throw new Error('开场图片大小无效。');
  let size = 0; const hash = createHash('sha256'); let header = Buffer.alloc(0);
  for await (const chunk of createReadStream(sourcePath, { signal })) {
    size += chunk.length; if (size > before.size) throw new Error('开场图片在读取时发生变化。');
    if (header.length < 12) header = Buffer.concat([header, chunk]).subarray(0, 12);
    hash.update(chunk);
  }
  assertImageHeader(header, extension);
  const digest = hash.digest('hex'), after = await fs.lstat(sourcePath);
  if (digest !== fileName.slice(0, 64) || size !== before.size || after.size !== size || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino) throw new Error(`开场图片内容校验失败：${fileName}`);
  return { sourcePath, relativePath: fileName, size, mtimeMs: before.mtimeMs, sha256: digest };
}
