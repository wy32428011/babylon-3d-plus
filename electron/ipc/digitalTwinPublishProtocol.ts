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

export type DigitalTwinModelVersion = { modelId: string; versionId: string };

export type DigitalTwinResourceIds = {
  compositionVersions?: Array<{ id: string; revision: string; contentSha256: string }>;
  modelVersions?: DigitalTwinModelVersion[];
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
  const compositionVersions = new Map<string, { id: string; revision: string; contentSha256: string }>();
  const modelVersions = new Map<string, DigitalTwinModelVersion & { sourceKey: string; contentSha256: string }>();
  const modelIds = new Set<string>();
  const envModelIds = new Set<string>();
  const comboModelIds = new Set<string>();

  const visit = (value: unknown, fieldName: string | null = null, owner?: Record<string, unknown>, ownerField?: string | null): void => {
    if (fieldName === 'inspection' && owner && (ownerField === 'modelAsset' || ownerField === 'avatar'
      || 'sourcePath' in owner || 'sourceUrl' in owner)) {
      if (!isPlainObject(value) || value.schemaVersion !== 1 || !isPlainObject(value.model)
        || !isPlainObject(value.model.dataPlatformModel)) throw new Error('巡检高模固定版本绑定无效。');
      const model = value.model;
      const identity = model.dataPlatformModel as Record<string, unknown>;
      const modelId = identity.resourceId;
      const versionId = model.versionId;
      const sourceKey = identity.sourceKey;
      const contentSha256 = model.contentSha256;
      if (identity.kind !== 'model' || typeof modelId !== 'string' || !/^[1-9]\d{0,63}$/.test(modelId)
        || typeof versionId !== 'string' || !/^[1-9]\d{0,63}$/.test(versionId)
        || typeof sourceKey !== 'string' || !/^[a-f0-9]{64}$/.test(sourceKey)
        || typeof contentSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(contentSha256)) {
        throw new Error('巡检高模固定版本身份或内容摘要无效。');
      }
      const device = value.device;
      if (!isPlainObject(device) || ['namespace', 'deviceType', 'deviceNo'].some(
        field => typeof device[field] !== 'string' || !(device[field] as string).trim(),
      )) throw new Error('巡检高模缺少完整的设备映射，不能发布。');
      const key = `${modelId}:${versionId}`;
      const previous = modelVersions.get(key);
      if (previous && (previous.sourceKey !== sourceKey || previous.contentSha256 !== contentSha256)) {
        throw new Error('同一巡检高模版本的来源或内容摘要不一致。');
      }
      modelVersions.set(key, { modelId, versionId, sourceKey, contentSha256 });
      // 高模不是普通模型的最新版本，其路径不得参与 modelIds 收集。
      return;
    }
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
      for (const item of value) visit(item, fieldName, owner, ownerField);
      return;
    }
    if (isPlainObject(value)) {
      if (value.schemaVersion === 1 && ((fieldName === 'composition' && owner?.isFolder === true) || (fieldName === 'compositionResource' && owner?.composition === true))) {
        if (typeof value.resourceId !== 'string' || !/^[1-9]\d{0,19}$/.test(value.resourceId) || typeof value.revision !== 'string' || !/^[A-Za-z0-9-]{1,100}$/.test(value.revision)) throw new Error('组合尚未同步中台，请先同步组合库后发布。');
        const contentSha256 = fieldName === 'composition' ? value.contentSha256 : owner?.contentSha256;
        if (typeof contentSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(contentSha256)) throw new Error('组合缺少固定版本内容摘要，请重新保存组合。');
        const key = value.resourceId + ':' + value.revision, previous = compositionVersions.get(key);
        if (previous && previous.contentSha256 !== contentSha256) throw new Error('同一组合版本的内容摘要不一致。');
        compositionVersions.set(key, { id: value.resourceId, revision: value.revision, contentSha256 });
      }
      if (value.source === 'data-platform' && value.resourceType === 'ENV_MODEL') {
        const resourceId = typeof value.dataPlatformResourceId === 'string' ? value.dataPlatformResourceId.trim() : '';
        if (!/^[1-9]\d{0,63}$/.test(resourceId)) throw new Error('场景中的数据中台环境模型 ID 无效。');
        envModelIds.add(resourceId);
      }
      for (const [childKey, child] of Object.entries(value)) visit(child, childKey, value, fieldName);
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
    ...(compositionVersions.size ? { compositionVersions: [...compositionVersions.values()].sort((a,b) => (a.id + a.revision).localeCompare(b.id + b.revision)) } : {}),
    ...(modelVersions.size ? { modelVersions: [...modelVersions.values()]
      .sort((a, b) => compareDecimalStrings(a.modelId, b.modelId) || compareDecimalStrings(a.versionId, b.versionId))
      .map(({ modelId, versionId }) => ({ modelId, versionId })) } : {}),
    modelIds: sortIds(modelIds),
    envModelIds: sortIds(envModelIds),
    comboModelIds: sortIds(comboModelIds),
  };
}

/** 固定高模必须由中台明确声明能力，并完整回显请求的版本和原始文件摘要。 */
export function assertSnapshotModelVersions(
  requested: readonly DigitalTwinModelVersion[], snapshot: unknown, capturedSnapshot?: unknown,
): void {
  if (!requested.length) return;
  const inspect = (value: unknown): string[] => {
    if (!isPlainObject(value) || value.modelVersionsSupported !== true || !Array.isArray(value.resources)) {
      throw new Error('数据中台不支持巡检高模固定版本快照，请升级中台。');
    }
    const versions = value.resources.filter((item: unknown) => isPlainObject(item) && item.kind === 'modelVersion');
    const expected = new Set(requested.map(item => `${item.modelId}:${item.versionId}`));
    const received = new Set<string>();
    const fingerprints: string[] = [];
    for (const entry of versions) {
      const item = entry as Record<string, unknown>;
      const key = `${item.resourceId}:${item.versionId}`;
      if (typeof item.resourceId !== 'string' || typeof item.versionId !== 'string' || !expected.has(key)
        || received.has(key) || typeof item.revision !== 'string' || !item.revision || !Array.isArray(item.files)) {
        throw new Error('数据中台固定高模版本回显与请求不一致。');
      }
      received.add(key);
      const files: string[] = [];
      for (const file of item.files) {
        if (!isPlainObject(file) || typeof file.role !== 'string' || !file.role
          || typeof file.fileName !== 'string' || !file.fileName || typeof file.fileUrl !== 'string' || !file.fileUrl
          || typeof file.fileId !== 'string' || !file.fileId || typeof file.sha256 !== 'string'
          || !/^[a-f0-9]{64}$/i.test(file.sha256) || typeof file.size !== 'string' || !/^\d+$/.test(file.size)) {
          throw new Error('数据中台固定高模缺少有效的原始文件摘要。');
        }
        files.push(JSON.stringify([file.role, file.fileName, file.fileUrl, file.fileId, file.sha256.toLowerCase(), file.size]));
      }
      if (!item.files.some(file => isPlainObject(file) && file.role === 'model')
        || !item.files.some(file => isPlainObject(file) && file.role === 'metadata')) {
        throw new Error('数据中台固定高模快照缺少模型或元数据文件。');
      }
      fingerprints.push(JSON.stringify([key, item.revision, files.sort()]));
    }
    if (received.size !== expected.size || expected.size !== requested.length) {
      throw new Error('数据中台固定高模版本回显与请求不一致。');
    }
    return fingerprints.sort();
  };
  const actual = inspect(snapshot);
  if (capturedSnapshot && JSON.stringify(actual) !== JSON.stringify(inspect(capturedSnapshot))) {
    throw new Error('数据中台固定高模快照在发布准备期间发生变化。');
  }
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
