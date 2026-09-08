import type { ModelSourceSnapshot } from './components';

/** 工程包指纹只固定发布时的资源版本，不替代文件读取授权或内容校验。 */
export function normalizeModelSourceSnapshot(value: unknown): ModelSourceSnapshot | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const contentSha256 = (value as Record<string, unknown>).contentSha256;
  return typeof contentSha256 === 'string' && /^[0-9a-f]{64}$/.test(contentSha256)
    ? { contentSha256 }
    : null;
}
