import type { CompositionResourceReference } from '../../../electron/shared/compositionTypes';
import type { ModelSourceSnapshot } from './components';

/** 工程包指纹只固定发布时的资源版本，不替代文件读取授权或内容校验。 */
export function normalizeModelSourceSnapshot(value: unknown): ModelSourceSnapshot | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const reference = raw.compositionResource as CompositionResourceReference | undefined;
  if (reference !== undefined && (!reference || reference.schemaVersion !== 1
    || typeof reference.libraryId !== 'string' || !reference.libraryId || reference.libraryId.length > 100
    || typeof reference.revision !== 'string' || !/^[A-Za-z0-9-]{1,100}$/.test(reference.revision)
    || typeof reference.packagePath !== 'string' || !reference.packagePath || reference.packagePath.length > 4096
    || (reference.resourceId !== undefined && !/^[1-9]\d{0,19}$/.test(reference.resourceId)))) return null;
  const contentSha256 = (value as Record<string, unknown>).contentSha256;
  return typeof contentSha256 === 'string' && /^[0-9a-f]{64}$/.test(contentSha256)
    ? { contentSha256, ...(raw.composition === true || reference ? { composition: true as const } : {}), ...(reference ? { compositionResource: { ...reference, resourceType: 'ENV_MODEL' as const } } : {}) }
    : null;
}
