import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { assertStaticOpeningSvg } from './openingPackageSvg.js';

const MAX_FILES = 4096;
const MAX_BYTES = 256 * 1024 * 1024;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const ROOT_FILES = new Set(['manifest.json', 'config.schema.json', 'ui.schema.json', 'defaults.json', 'timeline.json', 'preview.webp', 'preview.png', 'preview.jpg']);
const ASSET_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.svg', '.woff', '.woff2', '.ttf', '.otf']);
type ZipEntry = { path: string; type: string; flags: number; externalFileAttributes: number; uncompressedSize: number; stream(): Readable };
const unzipper = createRequire(import.meta.url)('unzipper') as { Open: { file(file: string): Promise<{ files: ZipEntry[] }> } };

export type OpeningPackageFile = { sourcePath: string; relativePath: string; size: number; mtimeMs: number; sha256: string };

/** 路径同时遵守 URL 与 Windows 文件规则；声明式包不接受可执行内容或外部入口。 */
export function assertOpeningPackageRelativePath(value: string, directory = false): string {
  const relative = directory && value.endsWith('/') ? value.slice(0, -1) : value;
  const segments = relative.split('/');
  if (!relative || relative.length > 240 || /[\\:%?#<>"|*\u0000-\u001f\u007f]/.test(relative)
    || segments.some(segment => !segment || segment === '.' || segment === '..' || /[. ]$/.test(segment)
      || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment))) {
    throw new Error(`开场包包含不安全路径：${value}`);
  }
  if (directory) {
    if (segments[0] !== 'assets') throw new Error(`开场包不支持目录：${value}`);
  } else if (!ROOT_FILES.has(relative)
    && !(segments[0] === 'assets' && segments.length > 1 && ASSET_EXTENSIONS.has(path.posix.extname(relative).toLowerCase()))) {
    throw new Error(`开场包不支持此文件，只允许声明式 JSON 和素材：${value}`);
  }
  return relative;
}

function assertFileSize(relative: string, size: number): void {
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_FILE_BYTES) throw new Error(`开场包文件大小无效或超过 64 MiB：${relative}`);
  if (/\.(?:json|geojson)$/i.test(relative) && size > MAX_JSON_BYTES) throw new Error(`开场包 JSON 超过 2 MiB：${relative}`);
  if (/\.svg$/i.test(relative) && size > MAX_JSON_BYTES) throw new Error(`开场包 SVG 超过 2 MiB：${relative}`);
}

/** 先完整预检，再流式展开到全新目录；取消或失败只回收本次创建的目录。 */
export async function extractOpeningPackageArchive(archivePath: string, destination: string, signal = new AbortController().signal): Promise<void> {
  signal.throwIfAborted();
  const archiveStat = await fs.stat(archivePath);
  if (!archiveStat.isFile() || archiveStat.size > MAX_BYTES) throw new Error('开场包 ZIP 无效或超过 256 MiB。');
  const archive = await unzipper.Open.file(archivePath);
  if (archive.files.length > MAX_FILES) throw new Error('开场包文件数量超过 4096 项。');
  const seen = new Set<string>(); let declaredBytes = 0;
  const entries = archive.files.map(entry => {
    const relativePath = assertOpeningPackageRelativePath(entry.path, entry.type === 'Directory');
    if (!['Directory', 'File'].includes(entry.type) || (entry.flags & 1)
      || ((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000) throw new Error(`开场包不能包含链接、加密或特殊文件：${relativePath}`);
    const key = relativePath.normalize('NFC').toLowerCase();
    if (seen.has(key)) throw new Error(`开场包文件路径重复：${relativePath}`);
    seen.add(key);
    assertFileSize(relativePath, entry.uncompressedSize);
    declaredBytes += entry.uncompressedSize;
    if (declaredBytes > MAX_BYTES) throw new Error('开场包展开后超过 256 MiB。');
    return { entry, relativePath };
  });
  signal.throwIfAborted();
  const root = path.resolve(destination);
  await fs.mkdir(root, { recursive: false });
  try {
    let totalBytes = 0;
    for (const { entry, relativePath } of entries) {
      signal.throwIfAborted();
      const target = path.resolve(root, ...relativePath.split('/'));
      if (!path.relative(root, target) || path.relative(root, target).startsWith('..') || path.isAbsolute(path.relative(root, target))) throw new Error('开场包路径越界。');
      if (entry.type === 'Directory') { await fs.mkdir(target, { recursive: true }); continue; }
      await fs.mkdir(path.dirname(target), { recursive: true });
      let bytes = 0;
      const limit = new Transform({ transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length; totalBytes += chunk.length;
        callback(bytes > entry.uncompressedSize || totalBytes > MAX_BYTES ? new Error(`开场包实际大小超过声明：${relativePath}`) : null, chunk);
      } });
      await pipeline(entry.stream(), limit, createWriteStream(target, { flags: 'wx' }), { signal });
      if (bytes !== entry.uncompressedSize) throw new Error(`开场包实际大小与声明不一致：${relativePath}`);
    }
  } catch (error) {
    await fs.rm(root, { recursive: true, force: true });
    throw error;
  }
}

/** 发布与重开再次校验磁盘内容，拒绝导入后新增的脚本、符号链接和被替换的资源。 */
export async function inspectOpeningPackageFiles(rootPath: string, signal = new AbortController().signal): Promise<OpeningPackageFile[]> {
  const root = path.resolve(rootPath), pending = [{ absolute: root, relative: '' }];
  const files: OpeningPackageFile[] = [], seen = new Set<string>(); let totalBytes = 0, count = 0;
  while (pending.length) {
    signal.throwIfAborted();
    const item = pending.pop()!, stat = await fs.lstat(item.absolute);
    if (stat.isSymbolicLink()) throw new Error(`开场包不允许符号链接或 Junction：${item.relative}`);
    if (++count > MAX_FILES) throw new Error('开场包文件数量超过 4096 项。');
    if (stat.isDirectory()) {
      if (item.relative) assertOpeningPackageRelativePath(item.relative, true);
      for (const name of await fs.readdir(item.absolute)) pending.push({ absolute: path.join(item.absolute, name), relative: item.relative ? `${item.relative}/${name}` : name });
      continue;
    }
    if (!stat.isFile()) throw new Error(`开场包含特殊文件：${item.relative}`);
    const relativePath = assertOpeningPackageRelativePath(item.relative), key = relativePath.normalize('NFC').toLowerCase();
    if (seen.has(key)) throw new Error(`开场包文件路径重复：${relativePath}`);
    seen.add(key); assertFileSize(relativePath, stat.size); totalBytes += stat.size;
    if (totalBytes > MAX_BYTES) throw new Error('开场包资源超过 256 MiB。');
    const hash = createHash('sha256'); let bytes = 0;
    const svgChunks: Buffer[] | null = /\.svg$/i.test(relativePath) ? [] : null;
    for await (const chunk of createReadStream(item.absolute, { signal })) {
      bytes += chunk.length; if (bytes > stat.size) throw new Error(`开场包文件读取时发生变化：${relativePath}`);
      hash.update(chunk); if (svgChunks) svgChunks.push(Buffer.from(chunk));
    }
    const after = await fs.lstat(item.absolute);
    if (!after.isFile() || after.isSymbolicLink() || stat.size !== bytes || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ino !== stat.ino) throw new Error(`开场包文件读取时发生变化：${relativePath}`);
    if (svgChunks) assertStaticOpeningSvg(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(svgChunks)));
    files.push({ sourcePath: item.absolute, relativePath, size: stat.size, mtimeMs: stat.mtimeMs, sha256: hash.digest('hex') });
  }
  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'en'));
}
