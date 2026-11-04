import type { HistorySourceRole } from '../../../electron/shared/historyServiceContract';
export type { HistorySourceRole } from '../../../electron/shared/historyServiceContract';

export const HISTORY_REPLAY_SETTINGS_VERSION = 1 as const;
export const HISTORY_REPLAY_SPEEDS = [0.25, 0.5, 1, 2, 4, 8] as const;

export type HistoryReplaySpeed = (typeof HISTORY_REPLAY_SPEEDS)[number];
export type HistoryProviderKind = 'platform' | 'external-http';
export type HistorySourceReference = { sourceId: string; revision: string };
export type HistorySourceBindingReference = {
  bindingId: string;
  sourceRef: HistorySourceReference;
  roles: HistorySourceRole[];
};

/** 场景只保存稳定引用和展示偏好，连接参数与凭据保留在服务器。 */
export type HistoryReplaySettings = {
  version: typeof HISTORY_REPLAY_SETTINGS_VERSION;
  enabled: boolean;
  providerKind: HistoryProviderKind;
  historyProviderRef: HistorySourceReference | null;
  sourceBindingRefs: HistorySourceBindingReference[];
  baselineSourceRef: HistorySourceReference | null;
  requestedPolicy: { retentionDays: number };
  viewerDefaults: { speed: HistoryReplaySpeed; rangeMinutes: number; showEvents: boolean };
};

export type HistoryTimeRange = { from: number; to: number };
export type HistoryReplayUiStatus =
  | 'live' | 'loading' | 'paused' | 'playing' | 'seeking' | 'buffering'
  | 'ended' | 'gap' | 'error' | 'empty' | 'returning-live';
export type HistoryTimelineEvent = {
  id: string;
  time: number;
  kind: 'alarm' | 'transfer' | 'stock' | 'lifecycle' | 'other';
  label: string;
};
export type HistoryCoverageGap = HistoryTimeRange & { reason: string };
export type HistoryVersionBoundary = { time: number; versionLabel: string };
export type HistoryStateCursor = { projectionId: string; stateRevision: string };

export function createDefaultHistoryReplaySettings(): HistoryReplaySettings {
  return {
    version: HISTORY_REPLAY_SETTINGS_VERSION,
    enabled: false,
    providerKind: 'platform',
    historyProviderRef: null,
    sourceBindingRefs: [],
    baselineSourceRef: null,
    requestedPolicy: { retentionDays: 90 },
    viewerDefaults: { speed: 1, rangeMinutes: 60, showEvents: true },
  };
}

export function isHistoryReplaySpeed(value: unknown): value is HistoryReplaySpeed {
  return typeof value === 'number' && (HISTORY_REPLAY_SPEEDS as readonly number[]).includes(value);
}

export function isHistoryTimeRange(value: unknown): value is HistoryTimeRange {
  if (!isRecord(value)) return false;
  return Number.isSafeInteger(value.from) && Number.isSafeInteger(value.to)
    && typeof value.from === 'number' && typeof value.to === 'number'
    && value.from >= 0 && value.to > value.from && value.to <= 8_640_000_000_000_000;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function record(value: unknown, label: string, allowed: readonly string[]): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label}必须是对象。`);
  if (Reflect.ownKeys(value).some((key) => typeof key !== 'string' || !allowed.includes(key)
    || !Object.prototype.hasOwnProperty.call(Object.getOwnPropertyDescriptor(value, key), 'value'))) {
    throw new Error(`${label}包含不支持的字段或访问器；不得内嵌地址、请求头或凭据。`);
  }
  return value;
}

function dataArray(value: unknown, label: string, max: number): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > max
    || Reflect.ownKeys(value).some((key) => typeof key !== 'string'
      || (key !== 'length' && !/^(0|[1-9][0-9]*)$/u.test(key))
      || !Object.prototype.hasOwnProperty.call(Object.getOwnPropertyDescriptor(value, key), 'value'))) {
    throw new Error(`${label}须为不超过 ${max} 项的普通数据数组。`);
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) throw new Error(`${label}不能包含空缺项。`);
  }
  return value;
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 256 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${label}必须是非空、有界的字符串标识。`);
  }
  return value.trim();
}

function reference(value: unknown, label: string): HistorySourceReference | null {
  if (value === null || value === undefined) return null;
  const item = record(value, label, ['sourceId', 'revision']);
  return { sourceId: identifier(item.sourceId, `${label} ID`), revision: identifier(item.revision, `${label}修订`) };
}

function integer(value: unknown, fallback: number, min: number, max: number, label: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${label}须为 ${min}–${max} 范围内的整数。`);
  }
  return value;
}

function boolean(value: unknown, fallback: boolean, label: string): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new Error(`${label}必须是布尔值。`);
  return value;
}

/** 允许保存尚未绑定来源的草稿，但不静默丢弃损坏字段或敏感配置。 */
export function normalizeHistoryReplaySettings(value: unknown): HistoryReplaySettings {
  const defaults = createDefaultHistoryReplaySettings();
  if (value === null || value === undefined) return defaults;
  const input = record(value, '时光回溯设置', [
    'version', 'enabled', 'providerKind', 'historyProviderRef', 'sourceBindingRefs',
    'baselineSourceRef', 'requestedPolicy', 'viewerDefaults',
  ]);
  if (input.version !== HISTORY_REPLAY_SETTINGS_VERSION) throw new Error('不支持的时光回溯设置版本。');
  const providerKind = input.providerKind ?? defaults.providerKind;
  if (providerKind !== 'platform' && providerKind !== 'external-http') throw new Error('不支持的历史提供方类型。');
  const policy = input.requestedPolicy === undefined ? {} : record(input.requestedPolicy, '历史留存申请', ['retentionDays']);
  const viewer = input.viewerDefaults === undefined ? {} : record(input.viewerDefaults, '回放偏好', ['speed', 'rangeMinutes', 'showEvents']);
  const speed = viewer.speed ?? defaults.viewerDefaults.speed;
  if (!isHistoryReplaySpeed(speed)) throw new Error('不支持的回放倍速。');
  const bindings = dataArray(input.sourceBindingRefs ?? [], '历史来源绑定', 128);
  const roles: readonly HistorySourceRole[] = ['telemetry', 'inventory', 'cargo', 'alarm', 'baseline', 'historical-events'];
  const seen = new Set<string>();
  const sourceBindingRefs = bindings.map((value): HistorySourceBindingReference => {
    const item = record(value, '历史来源绑定', ['bindingId', 'sourceRef', 'roles']);
    const bindingId = identifier(item.bindingId, '绑定 ID');
    if (seen.has(bindingId)) throw new Error('历史来源绑定 ID 不得重复。');
    seen.add(bindingId);
    const sourceRef = reference(item.sourceRef, '采集来源');
    if (!sourceRef) throw new Error('历史来源绑定缺少来源引用。');
    const selectedRoles = dataArray(item.roles, '历史来源用途', roles.length);
    if (selectedRoles.length === 0
      || selectedRoles.some((role) => typeof role !== 'string' || !roles.includes(role as HistorySourceRole))
      || new Set(selectedRoles).size !== selectedRoles.length) {
      throw new Error('历史来源用途为空、重复或不受支持。');
    }
    return { bindingId, sourceRef, roles: [...selectedRoles] as HistorySourceRole[] };
  });
  return {
    version: HISTORY_REPLAY_SETTINGS_VERSION,
    enabled: boolean(input.enabled, false, '回溯启用状态'),
    providerKind,
    historyProviderRef: reference(input.historyProviderRef, '历史提供方'),
    sourceBindingRefs,
    baselineSourceRef: reference(input.baselineSourceRef, '初态来源'),
    requestedPolicy: { retentionDays: integer(policy.retentionDays, 90, 1, 36_500, '申请留存天数') },
    viewerDefaults: {
      speed,
      rangeMinutes: integer(viewer.rangeMinutes, 60, 1, 525_600, '默认回放窗口分钟数'),
      showEvents: boolean(viewer.showEvents, true, '关键事件显示设置'),
    },
  };
}
