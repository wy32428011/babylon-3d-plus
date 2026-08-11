export type DataPlatformSkyboxRecord = {
  id: string;
  displayName: string;
  fileName: string;
  fileUrl: string;
  format: 'hdr' | 'exr';
  fileSizeBytes: number;
  sha256: string;
  revision: string;
  updatedAt: string | null;
};

export type DataPlatformSkyboxPage = {
  records: DataPlatformSkyboxRecord[];
  total: number;
  pageNum: number;
  pageSize: number;
};

type DecimalBound = number | bigint;

type BoundedDecimalOptions = {
  label: string;
  min: DecimalBound;
  max: DecimalBound;
};

const MAX_SKYBOX_FILE_SIZE_BYTES = 512 * 1024 * 1024;
const LOWERCASE_SHA256_PATTERN = /^[0-9a-f]{64}$/;
const POSITIVE_DECIMAL_PATTERN = /^[1-9]\d*$/;
const IDENTIFIER_PATTERN = /^[1-9]\d{0,63}$/;
const UPDATED_AT_PATTERN = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(?:(Z)|([+-])(\d{2}):(\d{2}))?)?$/;

export function parseBoundedDecimalString(value: unknown, options: BoundedDecimalOptions): number {
  if (typeof value !== 'string') {
    throw new Error(`${options.label}必须是十进制字符串。`);
  }

  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) {
    throw new Error(`${options.label}必须是十进制字符串。`);
  }

  const min = normalizeDecimalBound(options.min, `${options.label}最小值`);
  const max = normalizeDecimalBound(options.max, `${options.label}最大值`);
  if (min > max) throw new Error(`${options.label}范围配置无效。`);

  const parsed = BigInt(normalized);
  if (parsed < min || parsed > max) {
    throw new Error(`${options.label}必须在 ${min} 到 ${max} 之间。`);
  }

  const result = Number(parsed);
  if (!Number.isSafeInteger(result)) {
    throw new Error(`${options.label}超出 JavaScript 安全整数范围。`);
  }
  return result;
}

export function normalizePositiveIdentifier(value: unknown, label = '标识符'): string {
  if (typeof value === 'string') {
    const normalized = value.trim();
    if (IDENTIFIER_PATTERN.test(normalized)) return normalized;
  }
  throw new Error(`${label}必须是最多 64 位的正十进制字符串。`);
}

export function normalizeSkyboxQueryResponse(value: unknown): DataPlatformSkyboxPage {
  if (!isPlainObject(value)) {
    throw new Error('数据中台天空盒响应结构不正确。');
  }

  if (value.success !== true) {
    throw new Error(normalizeOptionalNonEmptyString(value.message) ?? '查询天空盒失败');
  }

  if (!isPlainObject(value.data) || !isPlainArray(value.data.records)) {
    throw new Error('数据中台天空盒响应缺少合法的 data.records。');
  }

  const records = value.data.records.map((record, index) => normalizeSkyboxRecord(record, index));
  assertUniqueSkyboxRecords(records);

  return {
    records,
    total: parseBoundedDecimalString(value.data.total, {
      label: 'data.total',
      min: 0,
      max: 100000,
    }),
    pageNum: parseBoundedDecimalString(value.data.pageNum, {
      label: 'data.pageNum',
      min: 1,
      max: 1000,
    }),
    pageSize: parseBoundedDecimalString(value.data.pageSize, {
      label: 'data.pageSize',
      min: 1,
      max: 100,
    }),
  };
}

export function assertUniqueSkyboxRecords(records: readonly DataPlatformSkyboxRecord[]): void {
  const ids = new Set<string>();
  const normalizedNames = new Set<string>();
  const hashes = new Set<string>();

  for (const record of records) {
    if (ids.has(record.id)) {
      throw new Error(`数据中台天空盒存在重复 ID：${record.id}`);
    }
    ids.add(record.id);

    const normalizedName = record.displayName.normalize('NFKC').trim().toLowerCase();
    if (normalizedNames.has(normalizedName)) {
      throw new Error(`数据中台天空盒存在重复名称：${record.displayName}`);
    }
    normalizedNames.add(normalizedName);

    if (hashes.has(record.sha256)) {
      throw new Error(`数据中台天空盒存在重复 SHA-256：${record.sha256}`);
    }
    hashes.add(record.sha256);
  }
}

function normalizeSkyboxRecord(value: unknown, index: number): DataPlatformSkyboxRecord {
  const label = `数据中台天空盒第 ${index + 1} 项`;
  if (!isPlainObject(value)) throw new Error(`${label}不是 plain object。`);

  const fileName = normalizeRequiredString(value.fileName, `${label} fileName`);
  const format = normalizeFileFormat(value.fileFormat, `${label} fileFormat`);
  if (!fileName.toLowerCase().endsWith(`.${format}`)) {
    throw new Error(`${label}文件扩展名必须与 ${format.toUpperCase()} 格式一致。`);
  }

  return {
    id: normalizePositiveIdentifier(value.id, `${label} id`),
    displayName: normalizeRequiredString(value.skyboxName, `${label} skyboxName`),
    fileName,
    fileUrl: normalizeRequiredString(value.fileUrl, `${label} fileUrl`),
    format,
    fileSizeBytes: parseBoundedDecimalString(value.fileSize, {
      label: `${label} fileSize`,
      min: 1,
      max: MAX_SKYBOX_FILE_SIZE_BYTES,
    }),
    sha256: normalizeSha256(value.fileSha256, `${label} SHA-256`),
    revision: normalizePositiveRevision(value.revision, `${label} revision`),
    updatedAt: normalizeUpdatedAt(value.updatedAt, `${label} updatedAt`),
  };
}

function normalizeDecimalBound(value: DecimalBound, label: string): bigint {
  if (typeof value === 'bigint') return value;
  if (Number.isSafeInteger(value)) return BigInt(value);
  throw new Error(`${label}必须是安全整数。`);
}

function normalizeRequiredString(value: unknown, label: string): string {
  if (typeof value === 'string') {
    const normalized = value.trim();
    if (normalized) return normalized;
  }
  throw new Error(`${label}不能为空。`);
}

function normalizeOptionalNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeFileFormat(value: unknown, label: string): 'hdr' | 'exr' {
  if (typeof value === 'string') {
    const normalized = value.trim();
    if (normalized === 'HDR') return 'hdr';
    if (normalized === 'EXR') return 'exr';
  }
  throw new Error(`${label}仅支持 HDR 或 EXR。`);
}

function normalizeSha256(value: unknown, label: string): string {
  if (typeof value === 'string') {
    const normalized = value.trim();
    if (LOWERCASE_SHA256_PATTERN.test(normalized)) return normalized;
  }
  throw new Error(`${label}必须是 64 位小写十六进制字符串。`);
}

function normalizePositiveRevision(value: unknown, label: string): string {
  if (typeof value === 'string') {
    const normalized = value.trim();
    if (POSITIVE_DECIMAL_PATTERN.test(normalized)) return normalized;
  }
  throw new Error(`${label}必须是正十进制字符串。`);
}

function normalizeUpdatedAt(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') throw new Error(`${label}必须是有效时间字符串或 null。`);

  const normalized = value.trim();
  const match = UPDATED_AT_PATTERN.exec(normalized);
  if (!match) throw new Error(`${label}必须是有效时间字符串或 null。`);

  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , , , offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    throw new Error(`${label}必须是有效时间字符串或 null。`);
  }

  if (hourText !== undefined) {
    const hour = Number(hourText);
    const minute = Number(minuteText);
    const second = Number(secondText);
    if (hour > 23 || minute > 59 || second > 59) {
      throw new Error(`${label}必须是有效时间字符串或 null。`);
    }
  }

  if (offsetHourText !== undefined) {
    const offsetHour = Number(offsetHourText);
    const offsetMinute = Number(offsetMinuteText);
    if (offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)) {
      throw new Error(`${label}必须是有效时间字符串或 null。`);
    }
  }

  return normalized;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leapYear ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function isPlainArray(value: unknown): value is unknown[] {
  return Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype;
}
