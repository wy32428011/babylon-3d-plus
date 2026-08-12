export type DataPlatformEnvironmentFileStatus =
  | 'GLB_READY'
  | 'LEGACY_ENV'
  | 'MISSING_FILE'
  | 'INVALID_FILE'
  | 'VERIFYING';

export type DataPlatformEnvironmentRecord = {
  id: string;
  displayName: string;
  fileStatus: DataPlatformEnvironmentFileStatus;
  fileName: string | null;
  fileUrl: string | null;
  fileSizeBytes: number | null;
  fileSha256: string | null;
  lengthUnit: 'meter' | 'centimeter' | 'millimeter';
  fileRevision: string | null;
  runtimeRevision: string | null;
  updatedAt: string | null;
  warning: string | null;
};

export type DataPlatformEnvironmentManifestPage = {
  protocolVersion: string;
  manifestRevision: string;
  records: DataPlatformEnvironmentRecord[];
  nextCursorId: string | null;
  hasMore: boolean;
};

const MAX_ENVIRONMENT_FILE_BYTES = 512 * 1024 * 1024;
const MAX_MANIFEST_PAGE_SIZE = 200;
const RESOURCE_ID_PATTERN = /^[1-9]\d{0,63}$/;
const NON_NEGATIVE_DECIMAL_PATTERN = /^\d{1,64}$/;
const POSITIVE_DECIMAL_PATTERN = /^[1-9]\d{0,63}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SUPPORTED_FILE_STATUSES = new Set<DataPlatformEnvironmentFileStatus>([
  'GLB_READY',
  'LEGACY_ENV',
  'MISSING_FILE',
  'INVALID_FILE',
  'VERIFYING',
]);

export function normalizeDataPlatformSourceUrl(value: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('数据中台地址不能为空。');
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('数据中台地址格式无效。');
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
    throw new Error('数据中台地址仅支持不含凭据的 HTTP/HTTPS URL。');
  }
  if (url.search || url.hash) throw new Error('数据中台地址不能包含 query 或 fragment。');
  url.protocol = url.protocol.toLowerCase();
  url.hostname = url.hostname.toLowerCase();
  if ((url.protocol === 'http:' && url.port === '80') || (url.protocol === 'https:' && url.port === '443')) url.port = '';
  return url.toString().replace(/\/+$/, '');
}

export function normalizeEnvironmentManifestResponse(value: unknown): DataPlatformEnvironmentManifestPage {
  if (!isPlainObject(value)) throw new Error('环境模型同步清单响应结构不正确。');
  if (value.success !== true) {
    throw new Error(readOptionalString(value.message) ?? '查询环境模型同步清单失败。');
  }
  if (!isPlainObject(value.data)) throw new Error('环境模型同步清单响应缺少 data。');
  const data = value.data;
  if (!Array.isArray(data.records)) throw new Error('环境模型同步清单 data.records 不是数组。');
  if (data.records.length > MAX_MANIFEST_PAGE_SIZE) throw new Error('环境模型同步清单单页超过 200 项。');

  const protocolVersion = readRequiredString(data.protocolVersion, 'protocolVersion');
  const manifestRevision = readDecimalString(data.manifestRevision, 'manifestRevision', false);
  const records = data.records.map((record, index) => normalizeEnvironmentRecord(record, index));
  const seen = new Set<string>();
  for (const record of records) {
    if (seen.has(record.id)) throw new Error(`环境模型同步清单单页存在重复 ID：${record.id}`);
    seen.add(record.id);
  }
  const nextCursorId = data.nextCursorId === null || data.nextCursorId === undefined
    ? null
    : readResourceId(data.nextCursorId, 'nextCursorId');
  if (data.hasMore !== true && data.hasMore !== false) throw new Error('环境模型同步清单 hasMore 必须是布尔值。');
  if (data.hasMore && !nextCursorId) throw new Error('环境模型同步清单仍有下一页但缺少 nextCursorId。');
  return { protocolVersion, manifestRevision, records, nextCursorId, hasMore: data.hasMore };
}

function normalizeEnvironmentRecord(value: unknown, index: number): DataPlatformEnvironmentRecord {
  const label = `环境模型同步清单第 ${index + 1} 项`;
  if (!isPlainObject(value)) throw new Error(`${label}不是普通对象。`);
  const id = readResourceId(value.id, `${label} id`);
  const displayName = readRequiredString(value.modelName ?? value.displayName, `${label} modelName`);
  const fileStatus = readFileStatus(value.fileStatus, `${label} fileStatus`);
  const fileName = readOptionalString(value.fileName);
  const fileUrl = readOptionalString(value.downloadUrl ?? value.fileUrl);
  const fileRevision = readOptionalDecimalString(value.fileRevision, `${label} fileRevision`, true);
  const runtimeRevision = readOptionalDecimalString(value.runtimeRevision, `${label} runtimeRevision`, true);
  const fileSha256 = readOptionalSha256(value.fileSha256, `${label} fileSha256`);
  const fileSizeBytes = value.fileSizeBytes === undefined && value.fileSize === undefined
    ? null
    : readBoundedSize(value.fileSizeBytes ?? value.fileSize, `${label} fileSizeBytes`);
  const lengthUnit = readLengthUnit(value.lengthUnit, `${label} lengthUnit`);
  const updatedAt = readOptionalDateTime(value.updatedAt, `${label} updatedAt`);
  const warning = readOptionalString(value.warning ?? value.validationErrorSummary);

  if (fileStatus === 'GLB_READY') {
    if (!fileName?.toLowerCase().endsWith('.glb')) throw new Error(`${label} GLB_READY 文件名必须是 .glb。`);
    if (!fileUrl || !fileRevision || !runtimeRevision || !fileSha256 || fileSizeBytes === null) {
      throw new Error(`${label} GLB_READY 缺少下载、修订、摘要或大小字段。`);
    }
  }
  return {
    id,
    displayName,
    fileStatus,
    fileName,
    fileUrl,
    fileSizeBytes,
    fileSha256,
    lengthUnit,
    fileRevision,
    runtimeRevision,
    updatedAt,
    warning,
  };
}

function readResourceId(value: unknown, label: string): string {
  if (typeof value === 'string' && RESOURCE_ID_PATTERN.test(value.trim())) return value.trim();
  throw new Error(`${label}必须是最多 64 位的正十进制字符串。`);
}

function readRequiredString(value: unknown, label: string): string {
  const normalized = readOptionalString(value);
  if (!normalized) throw new Error(`${label}不能为空。`);
  return normalized;
}

function readOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readDecimalString(value: unknown, label: string, positive: boolean): string {
  const pattern = positive ? POSITIVE_DECIMAL_PATTERN : NON_NEGATIVE_DECIMAL_PATTERN;
  if (typeof value === 'string' && pattern.test(value.trim())) return value.trim().replace(/^0+(?=\d)/, '');
  throw new Error(`${label}必须是${positive ? '正' : '非负'}十进制字符串。`);
}

function readOptionalDecimalString(value: unknown, label: string, positive: boolean): string | null {
  return value === null || value === undefined ? null : readDecimalString(value, label, positive);
}

function readOptionalSha256(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && SHA256_PATTERN.test(value.trim())) return value.trim();
  throw new Error(`${label}必须是 64 位小写 SHA-256。`);
}

function readBoundedSize(value: unknown, label: string): number {
  const normalized = readDecimalString(value, label, true);
  const parsed = BigInt(normalized);
  if (parsed > BigInt(MAX_ENVIRONMENT_FILE_BYTES)) throw new Error(`${label}超过 512 MiB 上限。`);
  return Number(parsed);
}

function readLengthUnit(value: unknown, label: string): DataPlatformEnvironmentRecord['lengthUnit'] {
  if (value === 'meter' || value === 'centimeter' || value === 'millimeter') return value;
  throw new Error(`${label}仅支持 meter、centimeter 或 millimeter。`);
}

function readFileStatus(value: unknown, label: string): DataPlatformEnvironmentFileStatus {
  if (typeof value === 'string' && SUPPORTED_FILE_STATUSES.has(value as DataPlatformEnvironmentFileStatus)) {
    return value as DataPlatformEnvironmentFileStatus;
  }
  throw new Error(`${label}不受支持。`);
}

function readOptionalDateTime(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !value.trim() || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label}必须是有效日期时间字符串或 null。`);
  }
  return value.trim();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}
