import type { requestDataPlatformJson } from './dataPlatformTransfer.js';

const PAGE_SIZE = 100;
const MAX_PAGES = 1_000;
export const MAX_MODEL_RECORDS = 100_000;

/** 普通、组合和环境模型目录使用同一分页协议。目录在读取期间变化时保留原索引。 */
export async function queryDataPlatformModelPages(
  baseUrl: string,
  endpointPath: string,
  label: string,
  nameField: 'modelName' | 'comboModelName',
  signal: AbortSignal,
  requestJson: typeof requestDataPlatformJson,
  filters: { modelPurpose?: 'SCENE' } = {},
): Promise<unknown[]> {
  const records: unknown[] = [];
  let stableTotal: number | null = null;
  for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum += 1) {
    if (signal.aborted) throw new Error('数据中台模型同步已取消。');
    const response = await requestJson({
      baseUrl, endpointPath, signal, timeoutMs: 20_000, context: `查询数据中台${label}`,
      body: { pageNum, pageSize: PAGE_SIZE, [nameField]: '', excludeIds: [], ...filters },
    });
    if (!isRecord(response)) throw new Error(`数据中台${label}响应结构不正确。`);
    if (response.success !== true) {
      const message = typeof response.message === 'string' ? response.message.trim() : '';
      throw new Error(message || `数据中台${label}查询失败。`);
    }
    const page = response.data;
    if (!isRecord(page) || !Array.isArray(page.records)) {
      throw new Error(`数据中台${label}响应缺少 data.records。`);
    }
    const pageSize = pageInteger(page.pageSize, `${label} pageSize`, 1, PAGE_SIZE);
    if (page.records.length > pageSize) throw new Error(`数据中台${label}响应 records 数量超过 pageSize。`);
    const total = pageInteger(page.total, `${label} total`, 0, MAX_MODEL_RECORDS);
    const number = pageInteger(page.pageNum, `${label} pageNum`, 1, MAX_PAGES);
    if (number !== pageNum) {
      throw new Error(`数据中台${label}响应 pageNum 与请求不一致：请求 ${pageNum}，响应 ${number}。`);
    }
    if (pageSize !== PAGE_SIZE) {
      throw new Error(`数据中台${label}响应 pageSize 与请求不一致：请求 ${PAGE_SIZE}，响应 ${pageSize}。`);
    }
    if (stableTotal !== null && total !== stableTotal) throw new Error(`数据中台${label}分页 total 在查询过程中发生变化。`);
    stableTotal = total;
    records.push(...page.records);
    if (records.length === total) return records;
    if (!page.records.length) throw new Error(`数据中台${label}分页在未取完 total=${total} 时返回空页。`);
    if (records.length > total) {
      throw new Error(`数据中台${label}累计记录数超过 total=${total} 或 ${MAX_MODEL_RECORDS} 项上限。`);
    }
  }
  throw new Error(`数据中台${label}分页超过 ${MAX_PAGES} 页限制。`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pageInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  const number = typeof value === 'number' ? value
    : typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new Error(`数据中台${label}无效。`);
  }
  return number;
}
