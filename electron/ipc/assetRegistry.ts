import path from 'node:path';
import { constants, promises as fs } from 'node:fs';

const authorizedAssetRoots = new Set<string>();
const authorizedAssetFiles = new Set<string>();
const authorizedSceneFiles = new Set<string>();

export function normalizeFilePath(filePath: string): string {
  return path.resolve(filePath);
}

export function authorizeAssetRoot(rootPath: string): void {
  authorizedAssetRoots.add(normalizeFilePath(rootPath));
}

export function authorizeAssetFile(filePath: string): void {
  authorizedAssetFiles.add(normalizeFilePath(filePath));
}

export function authorizeSceneFile(filePath: string): void {
  authorizedSceneFiles.add(normalizeFilePath(filePath));
}

export function isPathInsideAuthorizedAssetRoot(filePath: string): boolean {
  const normalizedPath = normalizeFilePath(filePath);

  for (const root of authorizedAssetRoots) {
    const relativePath = path.relative(root, normalizedPath);
    if (relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath))) {
      return true;
    }
  }

  return false;
}

export function isAuthorizedAssetFile(filePath: string): boolean {
  const normalizedPath = normalizeFilePath(filePath);
  return authorizedAssetFiles.has(normalizedPath) || isPathInsideAuthorizedAssetRoot(normalizedPath);
}

export function isAuthorizedSceneFile(filePath: string): boolean {
  const normalizedPath = normalizeFilePath(filePath);
  return authorizedSceneFiles.has(normalizedPath) || isPathInsideAuthorizedAssetRoot(normalizedPath);
}

function sameFilePath(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/** 拒绝链接/联接重定向，并把校验过的同一文件句柄交给响应流，避免再次按路径打开。 */
export async function openAuthorizedAssetFile(filePath: string) {
  const denied = () => Object.assign(new Error('资源真实路径未通过授权校验。'), { code: 'EACCES' });
  const normalized = normalizeFilePath(filePath);
  if (!isAuthorizedAssetFile(normalized)) throw denied();
  const realPath = await fs.realpath(normalized);
  if (!sameFilePath(realPath, normalized)) throw denied();
  const before = await fs.lstat(realPath);
  if (!before.isFile() || before.isSymbolicLink()) throw denied();
  const handle = await fs.open(realPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    const afterPath = await fs.realpath(normalized);
    const after = await fs.lstat(normalized);
    if (!sameFilePath(afterPath, realPath) || !after.isFile() || after.isSymbolicLink() || !stat.isFile()
      || stat.dev !== before.dev || stat.ino !== before.ino || stat.dev !== after.dev || stat.ino !== after.ino) throw denied();
    return { handle, stat };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export function encodeAssetUrl(filePath: string): string {
  return `editor-asset://local/${encodeURIComponent(normalizeFilePath(filePath))}`;
}

export function decodeAssetUrl(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol !== 'editor-asset:' || parsed.hostname !== 'local') {
    throw new Error('资产 URL 格式不正确。');
  }

  return normalizeFilePath(decodeURIComponent(parsed.pathname.slice(1)));
}
