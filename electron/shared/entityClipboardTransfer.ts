export const ENTITY_CLIPBOARD_SCHEMA_VERSION = 1;
export const ENTITY_CLIPBOARD_FORMAT = 'application/x-zending-3d-editor-entities+json';
export const MAX_ENTITY_CLIPBOARD_BYTES = 32 * 1024 * 1024;

export type CrossSceneClipboardSourceContext = {
  sceneSessionId: string;
  sceneFilePath: string | null;
  projectRoot: string | null;
  dataPlatformBaseUrl: string | null;
  dataPlatformProjectId: string | null;
};

export type CrossSceneEntityClipboardEntry = {
  rootId: string;
  entities: Record<string, unknown>[];
};

export type CrossSceneEntityClipboardPayload = {
  schemaVersion: 1;
  clipboardId: string;
  copiedAt: string;
  sourceContext: CrossSceneClipboardSourceContext;
  entries: CrossSceneEntityClipboardEntry[];
  lightingGroupRules?: Record<string, unknown>[];
};

export type ClipboardMissingResourceIssue = {
  entityName: string;
  sourcePath: string;
  reason: string;
};

export type WriteEntityClipboardRequest = {
  payload: CrossSceneEntityClipboardPayload;
};

export type WriteEntityClipboardResult = {
  ok: true;
  byteLength: number;
};

export type ReadEntityClipboardResult = {
  available: boolean;
  payload: CrossSceneEntityClipboardPayload | null;
  warnings: string[];
  missingResources: ClipboardMissingResourceIssue[];
  /** 为 true 时表示主进程已将跨项目模型包写入目标项目资产索引，渲染层可刷新项目资源库。 */
  projectAssetsUpdated?: boolean;
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function normalizeSourceContext(value: unknown): CrossSceneClipboardSourceContext | null {
  if (!isPlainRecord(value)) return null;
  if (typeof value.sceneSessionId !== 'string' || !value.sceneSessionId.trim()) return null;
  return {
    sceneSessionId: value.sceneSessionId,
    sceneFilePath: normalizeOptionalString(value.sceneFilePath),
    projectRoot: normalizeOptionalString(value.projectRoot),
    dataPlatformBaseUrl: normalizeOptionalString(value.dataPlatformBaseUrl),
    dataPlatformProjectId: normalizeOptionalString(value.dataPlatformProjectId),
  };
}

function normalizeClipboardEntries(value: unknown): CrossSceneEntityClipboardEntry[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const entries: CrossSceneEntityClipboardEntry[] = [];
  for (const item of value) {
    if (!isPlainRecord(item) || typeof item.rootId !== 'string' || !item.rootId.trim() || !Array.isArray(item.entities)) {
      return null;
    }
    const entities: Record<string, unknown>[] = [];
    for (const entity of item.entities) {
      if (!isPlainRecord(entity) || typeof entity.id !== 'string' || !entity.id.trim() || !isPlainRecord(entity.components)) {
        return null;
      }
      entities.push(entity);
    }
    if (entities.length === 0) return null;
    entries.push({ rootId: item.rootId, entities });
  }
  return entries;
}

/** 校验并反序列化系统剪贴板中的实体载荷；结构或版本无效时返回 null。 */
export function parseEntityClipboardPayload(raw: Buffer | string): CrossSceneEntityClipboardPayload | null {
  let text: string;
  if (typeof raw === 'string') {
    if (Buffer.byteLength(raw, 'utf8') > MAX_ENTITY_CLIPBOARD_BYTES) return null;
    text = raw;
  } else if (Buffer.isBuffer(raw)) {
    if (raw.byteLength === 0 || raw.byteLength > MAX_ENTITY_CLIPBOARD_BYTES) return null;
    text = raw.toString('utf8');
  } else {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  if (!isPlainRecord(parsed)) return null;
  if (parsed.schemaVersion !== ENTITY_CLIPBOARD_SCHEMA_VERSION) return null;
  if (typeof parsed.clipboardId !== 'string' || !parsed.clipboardId.trim()) return null;
  if (typeof parsed.copiedAt !== 'string' || !parsed.copiedAt.trim()) return null;

  const sourceContext = normalizeSourceContext(parsed.sourceContext);
  const entries = normalizeClipboardEntries(parsed.entries);
  if (!sourceContext || !entries) return null;

  let lightingGroupRules: Record<string, unknown>[] | undefined;
  if (parsed.lightingGroupRules !== undefined) {
    if (!Array.isArray(parsed.lightingGroupRules)) return null;
    lightingGroupRules = parsed.lightingGroupRules.filter(isPlainRecord);
  }

  return {
    schemaVersion: ENTITY_CLIPBOARD_SCHEMA_VERSION,
    clipboardId: parsed.clipboardId,
    copiedAt: parsed.copiedAt,
    sourceContext,
    entries,
    ...(lightingGroupRules && lightingGroupRules.length > 0 ? { lightingGroupRules } : {}),
  };
}

/** 校验并序列化剪贴板载荷为 UTF-8 Buffer，超限时拒绝写入。 */
export function serializeEntityClipboardPayload(payload: CrossSceneEntityClipboardPayload): Buffer {
  const normalized = parseEntityClipboardPayload(JSON.stringify(payload));
  if (!normalized) {
    throw new Error('跨场景剪贴板载荷格式无效，无法写入系统剪贴板。');
  }
  const buffer = Buffer.from(JSON.stringify(normalized), 'utf8');
  if (buffer.byteLength > MAX_ENTITY_CLIPBOARD_BYTES) {
    throw new Error(`复制内容超过 ${Math.round(MAX_ENTITY_CLIPBOARD_BYTES / (1024 * 1024))} MiB 剪贴板限制，请分批复制。`);
  }
  return buffer;
}
