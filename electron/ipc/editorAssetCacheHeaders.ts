import path from 'node:path';

const CACHEABLE_EDITOR_ASSET_EXTENSIONS = new Set([
  '.glb',
  '.gltf',
  '.bin',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.ktx2',
  '.hdr',
  '.exr',
]);

export type EditorAssetProtocolResponse = {
  status: 200 | 304;
  body: 'stream' | null;
  headers: Record<string, string>;
};

export type ResolveEditorAssetProtocolResponseInput = {
  filePath: string;
  size: number;
  mtimeMs: number;
  ifNoneMatch?: string | null;
};

/** 判断本地授权资源是否适合浏览器协商缓存。脚本和 JSON 仍禁止缓存。 */
export function resolveEditorAssetCacheControl(filePath: string): string {
  return isCacheableEditorAssetPath(filePath)
    ? 'private, max-age=0, must-revalidate'
    : 'no-store';
}

/** 用体积和修改时间生成弱内容指纹，文件替换后必须重新传输。 */
export function createEditorAssetEtag(size: number, mtimeMs: number): string {
  return `"${Math.trunc(size).toString(16)}-${Math.trunc(mtimeMs).toString(16)}"`;
}

/** 计算 editor-asset 协议响应：缓存命中返回 304，否则继续走文件流。 */
export function resolveEditorAssetProtocolResponse(
  input: ResolveEditorAssetProtocolResponseInput,
): EditorAssetProtocolResponse {
  const cacheControl = resolveEditorAssetCacheControl(input.filePath);
  const etag = createEditorAssetEtag(input.size, input.mtimeMs);
  const headers: Record<string, string> = {
    'Cache-Control': cacheControl,
    ETag: etag,
  };
  if (
    cacheControl !== 'no-store'
    && matchesIfNoneMatch(input.ifNoneMatch, etag)
  ) {
    return { status: 304, body: null, headers };
  }
  return {
    status: 200,
    body: 'stream',
    headers: {
      ...headers,
      'Content-Length': String(input.size),
    },
  };
}

function isCacheableEditorAssetPath(filePath: string): boolean {
  return CACHEABLE_EDITOR_ASSET_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function matchesIfNoneMatch(ifNoneMatch: string | null | undefined, etag: string): boolean {
  if (!ifNoneMatch) return false;
  const normalized = ifNoneMatch.trim();
  if (normalized === '*') return true;
  return normalized.split(',').some((candidate) => candidate.trim().replace(/^W\//, '') === etag);
}
