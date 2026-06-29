import path from 'node:path';
const authorizedAssetRoots = new Set();
const authorizedAssetFiles = new Set();
const authorizedSceneFiles = new Set();
export function normalizeFilePath(filePath) {
    return path.resolve(filePath);
}
export function authorizeAssetRoot(rootPath) {
    authorizedAssetRoots.add(normalizeFilePath(rootPath));
}
export function authorizeAssetFile(filePath) {
    authorizedAssetFiles.add(normalizeFilePath(filePath));
}
export function authorizeSceneFile(filePath) {
    authorizedSceneFiles.add(normalizeFilePath(filePath));
}
export function isPathInsideAuthorizedAssetRoot(filePath) {
    const normalizedPath = normalizeFilePath(filePath);
    for (const root of authorizedAssetRoots) {
        const relativePath = path.relative(root, normalizedPath);
        if (relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath))) {
            return true;
        }
    }
    return false;
}
export function isAuthorizedAssetFile(filePath) {
    const normalizedPath = normalizeFilePath(filePath);
    return authorizedAssetFiles.has(normalizedPath) || isPathInsideAuthorizedAssetRoot(normalizedPath);
}
export function isAuthorizedSceneFile(filePath) {
    const normalizedPath = normalizeFilePath(filePath);
    return authorizedSceneFiles.has(normalizedPath) || isPathInsideAuthorizedAssetRoot(normalizedPath);
}
export function encodeAssetUrl(filePath) {
    return `editor-asset://local/${encodeURIComponent(normalizeFilePath(filePath))}`;
}
export function decodeAssetUrl(url) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'editor-asset:' || parsed.hostname !== 'local') {
        throw new Error('资产 URL 格式不正确。');
    }
    return normalizeFilePath(decodeURIComponent(parsed.pathname.slice(1)));
}
