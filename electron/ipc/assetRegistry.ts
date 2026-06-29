import path from 'node:path';

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
