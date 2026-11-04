import type { HistoryJson, HistorySourceKind } from './historyServiceContract.js';

export type HistoryHttpMapping = {
  itemsPath?: string;
  statePath?: string;
  snapshotRevisionPath?: string;
  nextCursorPath?: string;
  donePath?: string;
  fromPath?: string;
  toPath?: string;
  gapsPath?: string;
  completeThroughPath?: string;
  completenessPath?: string;
  baselineTimePath?: string;
  eventCursorPath?: string;
  eventIdPath?: string;
  eventTimePath?: string;
  eventTypePath?: string;
  sequencePath?: string;
  epochPath?: string;
  versionIntervalsPath?: string;
  /** 规范化字段指针到来源字段指针的映射，不执行脚本；最终语义由投影器校验。 */
  fieldMap?: Record<string, string>;
};
export type HistoryHttpOperation = {
  method: 'GET' | 'POST';
  path: string;
  readOnly: true;
  query?: Record<string, string>;
  headers?: { Accept?: string; 'Content-Type'?: string; 'Accept-Language'?: string };
  body?: HistoryJson;
  mapping: HistoryHttpMapping;
};
export type HistoryHttpSourceConfig = {
  version: 1;
  logicalSourceId: string;
  authorityScope: string;
  baseUrl: string;
  operations: Partial<Record<'latest' | 'coverage' | 'baseline' | 'events', HistoryHttpOperation>>;
  semantics: {
    timeUnit: 'ms' | 's';
    timeZone: 'UTC';
    timeBasis: 'observed' | 'source';
    interval: '[from,to)';
    order: 'time-sequence-eventId';
    emptyResult: 'empty' | 'unchanged';
  };
  pollIntervalSeconds?: number;
  limits?: { timeoutMs?: number; totalTimeoutMs?: number; maxResponseBytes?: number; maxPages?: number; maxItems?: number };
};
export type HistoryMqttParser = {
  /** EPV 是既有 e/p/v 遥测协议及 topic 身份解析，不是发布版本号。 */
  adapter: 'epv-v1' | 'json-v1';
  deviceType?: string;
  recordsPath?: string;
  deviceTypePath?: string;
  deviceIdPath?: string;
  statePath?: string;
  eventTimePath?: string;
  sequencePath?: string;
  epochPath?: string;
  eventIdPath?: string;
  mode: 'full' | 'delta';
  timeUnit: 'ms' | 's';
  timeZone: 'UTC';
  timeBasis: 'observed' | 'source';
  /** 设备序号纪元不得用网络连接纪元替代。 */
  epochMode: 'field' | 'none';
};
export type HistoryMqttSourceConfig = {
  version: 1;
  logicalSourceId: string;
  authorityScope: string;
  brokerUri: string;
  topics: { filter: string; qos: 0 | 1 | 2 }[];
  parser: HistoryMqttParser;
};
export type HistoryPlatformSourceConfig = { version: 1; provider: 'platform-v1' };
export type HistorySourceConfig = HistoryMqttSourceConfig | HistoryHttpSourceConfig | HistoryPlatformSourceConfig;
export type HistorySourceCredential =
  | { type: 'none' }
  | { type: 'bearer'; token: string }
  | { type: 'header'; name: string; value: string }
  | { type: 'mqtt'; username: string; password: string };

export function createHistorySourceConfig(kind: HistorySourceKind): HistorySourceConfig {
  if (kind === 'platform') return { version: 1, provider: 'platform-v1' };
  if (kind === 'mqtt') return {
    version: 1, logicalSourceId: 'default', authorityScope: '', brokerUri: '',
    topics: [{ filter: '', qos: 1 }],
    parser: { adapter: 'epv-v1', mode: 'full', timeUnit: 'ms', timeZone: 'UTC', timeBasis: 'observed', epochMode: 'none' },
  };
  return {
    version: 1, logicalSourceId: 'default', authorityScope: '', baseUrl: '',
    operations: kind === 'external-http'
      ? { coverage: { method: 'GET', path: '', readOnly: true, mapping: {} }, baseline: { method: 'GET', path: '', readOnly: true, mapping: {} }, events: { method: 'GET', path: '', readOnly: true, mapping: {} } }
      : { latest: { method: 'GET', path: '', readOnly: true, mapping: {} } },
    semantics: { timeUnit: 'ms', timeZone: 'UTC', timeBasis: kind === 'external-http' ? 'source' : 'observed', interval: '[from,to)', order: 'time-sequence-eventId', emptyResult: 'unchanged' },
    limits: {},
  };
}
