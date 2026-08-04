const RESOURCE_SEGMENT_PATTERN = /(?:^|\/)(model|env|combo)-(\d{1,64})(?:-|\/|$)/i;
const RESOURCE_REFERENCE_KEYS = new Set([
  'sourcePath',
  'packagePath',
  'metadataPath',
  'thumbnailPath',
  'path',
  'sourceUrl',
  'thumbnailUrl',
  'activeVariantUrl',
  'scriptPaths',
]);

export type DigitalTwinResourceKey = {
  type: 'MODEL' | 'ENV_MODEL' | 'COMBO_MODEL';
  id: string;
};

export type DigitalTwinResourceIds = {
  modelIds: string[];
  envModelIds: string[];
  comboModelIds: string[];
};

/** 从本地资源路径或 editor-asset URL 提取稳定的“资源类型 + 业务 ID”。 */
export function parseDataPlatformResourceKey(value: string): DigitalTwinResourceKey | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  let normalized = value.trim();
  if (normalized.startsWith('editor-asset://local/')) {
    try {
      const url = new URL(normalized);
      normalized = decodeURIComponent(url.pathname.slice(1));
    } catch {
      return null;
    }
  }
  normalized = normalized.replace(/\\/g, '/');
  const match = RESOURCE_SEGMENT_PATTERN.exec(normalized);
  if (!match) return null;
  const type = match[1].toLowerCase() === 'model'
    ? 'MODEL'
    : match[1].toLowerCase() === 'env'
      ? 'ENV_MODEL'
      : 'COMBO_MODEL';
  return { type, id: match[2] };
}

/** 扫描一个或多个场景文件，收集发布接口所需的三类共享资源 ID。 */
export function collectDigitalTwinResourceIds(sceneContents: readonly string[]): DigitalTwinResourceIds {
  const modelIds = new Set<string>();
  const envModelIds = new Set<string>();
  const comboModelIds = new Set<string>();
  let visited = 0;

  const visit = (value: unknown, fieldName: string | null = null): void => {
    visited += 1;
    if (visited > 1_000_000) throw new Error('场景结构过大，无法完成资源引用扫描。');
    if (typeof value === 'string') {
      if (!fieldName || !RESOURCE_REFERENCE_KEYS.has(fieldName)) return;
      const key = parseDataPlatformResourceKey(value);
      if (!key) return;
      if (key.type === 'MODEL') modelIds.add(key.id);
      else if (key.type === 'ENV_MODEL') envModelIds.add(key.id);
      else comboModelIds.add(key.id);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, fieldName);
      return;
    }
    if (isPlainObject(value)) {
      for (const [childKey, child] of Object.entries(value)) visit(child, childKey);
    }
  };

  for (const content of sceneContents) {
    if (typeof content !== 'string' || !content) throw new Error('工程场景内容不能为空。');
    let parsed: unknown;
    try {
      parsed = JSON.parse(content) as unknown;
    } catch {
      throw new Error('工程场景文件不是有效 JSON。');
    }
    visit(parsed, null);
  }

  const sortIds = (values: Set<string>): string[] => [...values].sort(compareDecimalStrings);
  return {
    modelIds: sortIds(modelIds),
    envModelIds: sortIds(envModelIds),
    comboModelIds: sortIds(comboModelIds),
  };
}

/** 根据服务端会话状态生成待上传分片索引，用于断点续传。 */
export function createPendingChunkIndexes(
  fileSize: number,
  chunkSize: number,
  uploadedChunks: readonly number[],
): number[] {
  if (!Number.isSafeInteger(fileSize) || fileSize < 0) throw new Error('上传文件大小无效。');
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) throw new Error('上传分片大小无效。');
  const totalChunks = fileSize === 0 ? 0 : Math.ceil(fileSize / chunkSize);
  const uploaded = new Set(uploadedChunks.filter((index) => Number.isInteger(index) && index >= 0 && index < totalChunks));
  return Array.from({ length: totalChunks }, (_, index) => index).filter((index) => !uploaded.has(index));
}

function compareDecimalStrings(left: string, right: string): number {
  const normalizedLeft = left.replace(/^0+(?=\d)/, '');
  const normalizedRight = right.replace(/^0+(?=\d)/, '');
  return normalizedLeft.length - normalizedRight.length || normalizedLeft.localeCompare(normalizedRight, 'en');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
