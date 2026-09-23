import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import {
  scanSafeSourceRoot,
  throwIfDeploymentExportAborted,
  toDeploymentPath,
  type SafeSourceFile,
} from './deploymentExportFileSystem.js';

export const RELEASE_CACHE_MANIFEST_PATH = 'release-cache-manifest.json';

export type DeploymentReleaseCacheFile = {
  path: string;
  size: number;
  sha256: string;
  contentType: string;
  storage: 'asset' | 'response';
};

export type DeploymentReleaseCacheManifest = {
  version: 1;
  cacheRevision: string;
  totalBytes: number;
  files: DeploymentReleaseCacheFile[];
};

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.ktx2': 'image/ktx2',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
};

/** 清单保存可直接相对发布根解析的 URL 路径，避免文件名中的 #、?、% 改变请求语义。 */
export function toReleaseCacheManifestUrlPath(relativePath: string): string {
  const segments = relativePath.split('/');
  if (/[\\:\u0000-\u001f\u007f]/.test(relativePath)
    || segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error('发布缓存文件相对路径无效。');
  }
  return segments.map((segment) => encodeURIComponent(segment)).join('/');
}

/** 在 DIST staging 完成后枚举实际字节；控制文件不进入清单，原资产清单格式保持不变。 */
export async function createDeploymentReleaseCacheManifest(
  stagingRoot: string,
  cacheRevision: string,
  signal: AbortSignal,
): Promise<DeploymentReleaseCacheManifest> {
  throwIfDeploymentExportAborted(signal);
  if (typeof cacheRevision !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(cacheRevision)) {
    throw new Error('发布缓存版本标识无效。');
  }
  const sourceFiles = await scanSafeSourceRoot(stagingRoot, null, [], signal);
  const files: DeploymentReleaseCacheFile[] = [];
  let totalBytes = 0;
  for (const file of sourceFiles) {
    throwIfDeploymentExportAborted(signal);
    const relativePath = toDeploymentPath(file.relativePath);
    if (isReleaseCacheControlFile(relativePath)) continue;
    const urlPath = toReleaseCacheManifestUrlPath(relativePath);
    const sha256 = await hashStagedFile(file, signal);
    totalBytes += file.size;
    if (!Number.isSafeInteger(totalBytes)) throw new Error('发布缓存资源总大小超过安全范围。');
    files.push({
      path: urlPath,
      size: file.size,
      sha256,
      contentType: CONTENT_TYPES[path.posix.extname(relativePath).toLowerCase()] ?? 'application/octet-stream',
      storage: relativePath === 'project/scene.json' || relativePath === 'project/asset-manifest.json'
        || relativePath.startsWith('project/assets/') ? 'asset' : 'response',
    });
  }
  throwIfDeploymentExportAborted(signal);
  return { version: 1, cacheRevision, totalBytes, files };
}

function isReleaseCacheControlFile(relativePath: string): boolean {
  const normalized = relativePath.toLowerCase();
  return normalized === 'runtime-config.json' || normalized === RELEASE_CACHE_MANIFEST_PATH
    || normalized === 'published-cache-worker.js' || /^readme(?:\.[^/]*)?$/.test(normalized);
}

async function hashStagedFile(file: SafeSourceFile, signal: AbortSignal): Promise<string> {
  throwIfDeploymentExportAborted(signal);
  const before = await fs.lstat(file.sourcePath);
  if (!before.isFile() || before.isSymbolicLink() || before.size !== file.size || before.mtimeMs !== file.mtimeMs) {
    throw new Error(`发布缓存文件在枚举后发生变化：${toDeploymentPath(file.relativePath)}`);
  }
  const hash = createHash('sha256');
  let readBytes = 0;
  // signal 直接交给流，使用户取消可以中断正在等待的磁盘读取。
  const stream = createReadStream(file.sourcePath, { signal });
  for await (const chunk of stream) {
    throwIfDeploymentExportAborted(signal);
    const bytes = chunk as Buffer;
    hash.update(bytes);
    readBytes += bytes.byteLength;
  }
  const after = await fs.lstat(file.sourcePath);
  if (!after.isFile() || after.isSymbolicLink() || after.size !== before.size || after.mtimeMs !== before.mtimeMs
    || after.ino !== before.ino || after.dev !== before.dev || readBytes !== file.size) {
    throw new Error(`发布缓存文件在计算摘要时发生变化：${toDeploymentPath(file.relativePath)}`);
  }
  return hash.digest('hex');
}
