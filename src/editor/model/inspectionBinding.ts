import { normalizeDataPlatformModelIdentity } from '../../../electron/shared/sceneModelUpdatePlan';
import type { DataPlatformModelIdentity } from '../../../electron/shared/sceneModelUpdatePlan';
import type { ModelParameterValue, ModelParameterValues } from './modelParameters';
import type { Vector3Data } from './math';

/** 固定高模引用与规则可复制；device 只属于具体设备实例。 */
export type InspectionBinding = {
  schemaVersion: 1;
  model: {
    dataPlatformModel: DataPlatformModelIdentity & { kind: 'model' };
    versionId: string;
    /** 完整资源包摘要，不能使用平台的单文件 SHA。 */
    contentSha256: string;
    sourcePath: string;
    sourceUrl: string;
    metaPath: string;
    metaUrl: string;
    unitScaleToMeters: number;
  };
  configuration: { id: string; parameters: ModelParameterValues };
  /** 缺省表示尚未为本实例绑定设备，运行时不能打开设备详情。 */
  device?: { namespace: string; deviceType: string; deviceNo: string };
  parts: Array<{
    partKey: string;
    name: string;
    nodePath: string;
    parentPartKey?: string;
    /** 世界坐标方向，距离以米为单位。 */
    axis: Vector3Data;
    distanceMeters: number;
    fixed: boolean;
  }>;
};

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) throw new Error(`${field} 必须是对象。`);
  return value as Record<string, unknown>;
}

function hasAsciiControl(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function text(value: unknown, field: string, max = 1024): string {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim()
    || value.length > max || hasAsciiControl(value)) {
    throw new Error(`${field} 必须是非空字符串，不能包含控制字符或首尾空格。`);
  }
  return value;
}

function vector(value: unknown, field: string): Vector3Data {
  const raw = object(value, field);
  if (typeof raw.x !== 'number' || !Number.isFinite(raw.x)
    || typeof raw.y !== 'number' || !Number.isFinite(raw.y)
    || typeof raw.z !== 'number' || !Number.isFinite(raw.z)) throw new Error(`${field} 必须包含有限的 x、y、z。`);
  return { x: raw.x, y: raw.y, z: raw.z };
}

function path(value: unknown, field: string): string {
  const result = text(value, field, 4096);
  if (result.replace(/\\/g, '/').split('/').some((part) => part === '.' || part === '..')) {
    throw new Error(`${field} 不能包含相对路径跳转。`);
  }
  return result;
}

function resourceUrl(value: unknown, expectedPath: string, field: string): string {
  const result = text(value, field, 8192);
  try {
    const url = new URL(result);
    const decoded = decodeURIComponent(url.pathname.slice(1)).replace(/\\/g, '/');
    if (url.protocol !== 'editor-asset:' || url.host !== 'local' || url.username || url.password
      || url.search || url.hash || decoded !== expectedPath.replace(/\\/g, '/')) throw new Error();
  } catch {
    throw new Error(`${field} 必须是与本地资源路径一致的 editor-asset://local/ 地址。`);
  }
  return result;
}

function parameters(value: unknown): ModelParameterValues {
  const raw = object(value, 'configuration.parameters');
  if (Object.keys(raw).length > 1024) throw new Error('参数快照过大。');
  return Object.fromEntries(Object.entries(raw).map(([key, item]) => {
    text(key, '参数名称', 128);
    let parsed: ModelParameterValue;
    if (typeof item === 'number' && Number.isFinite(item)) parsed = item;
    else if (typeof item === 'string' || typeof item === 'boolean') parsed = item;
    else parsed = vector(item, `参数 ${key}`);
    return [key, parsed];
  }));
}

/** 校验并生成纯数据快照；未知字段不进入场景，尤其不持久化查看状态。 */
export function normalizeInspectionBinding(value: unknown): InspectionBinding {
  const raw = object(value, 'inspection');
  if (raw.schemaVersion !== 1) throw new Error('inspection.schemaVersion 必须为 1。');
  const model = object(raw.model, 'model');
  const identity = normalizeDataPlatformModelIdentity(model.dataPlatformModel);
  if (!identity || identity.kind !== 'model') throw new Error('高模来源必须是有效的 model 身份。');
  const sourcePath = path(model.sourcePath, 'model.sourcePath');
  const metaPath = path(model.metaPath, 'model.metaPath');
  const normalizedSource = sourcePath.replace(/\\/g, '/');
  const normalizedMeta = metaPath.replace(/\\/g, '/');
  if (normalizedSource !== identity.modelPath && !normalizedSource.endsWith(`/${identity.modelPath}`)) {
    throw new Error('高模路径与中台包内 modelPath 不匹配。');
  }
  const root = normalizedSource.slice(0, normalizedSource.length - identity.modelPath.length);
  if (root && !normalizedMeta.startsWith(root)) throw new Error('元数据与高模必须位于同一资源包。');
  const versionId = text(model.versionId, 'model.versionId', 64);
  if (!/^[1-9]\d{0,63}$/.test(versionId)) throw new Error('model.versionId 必须是正十进制字符串。');
  const contentSha256 = text(model.contentSha256, 'model.contentSha256', 64);
  if (!/^[0-9a-f]{64}$/.test(contentSha256)) throw new Error('完整资源包摘要必须是 64 位小写 SHA-256。');
  if (typeof model.unitScaleToMeters !== 'number' || !Number.isFinite(model.unitScaleToMeters)
    || model.unitScaleToMeters <= 0) throw new Error('model.unitScaleToMeters 必须是正有限数。');
  const configuration = object(raw.configuration, 'configuration');
  let device: InspectionBinding['device'];
  if (raw.device !== undefined) {
    const item = object(raw.device, 'device');
    device = {
      namespace: text(item.namespace, 'device.namespace', 256),
      deviceType: text(item.deviceType, 'device.deviceType', 256),
      deviceNo: text(item.deviceNo, 'device.deviceNo', 256),
    };
  }
  if (!Array.isArray(raw.parts) || raw.parts.length === 0 || raw.parts.length > 10000) {
    throw new Error('parts 必须包含 1 至 10000 个零件。');
  }
  const partKeys = new Set<string>();
  const nodePaths = new Set<string>();
  const parts = raw.parts.map((value, index) => {
    const item = object(value, `parts[${index}]`);
    const partKey = text(item.partKey, `parts[${index}].partKey`, 256);
    // 与查看器约定：点表示加载根，其他路径仅含逐级节点名，没有转义机制。
    const nodePath = text(item.nodePath, `parts[${index}].nodePath`, 2048);
    if (nodePath !== '.' && (/[;,]/.test(nodePath)
      || nodePath.split('/').some((segment) => !segment || segment === '.' || segment === '..'))) {
      throw new Error(`零件 ${partKey} 的节点路径必须是以 / 分隔的相对路径。`);
    }
    if (partKeys.has(partKey)) throw new Error(`零件 partKey 重复：${partKey}`);
    if (nodePaths.has(nodePath)) throw new Error(`零件节点路径重复：${nodePath}`);
    partKeys.add(partKey);
    nodePaths.add(nodePath);
    const axis = vector(item.axis, `零件 ${partKey} 的世界方向`);
    if (axis.x === 0 && axis.y === 0 && axis.z === 0) throw new Error(`零件 ${partKey} 的世界方向不能为零。`);
    if (typeof item.distanceMeters !== 'number' || !Number.isFinite(item.distanceMeters) || item.distanceMeters < 0) {
      throw new Error(`零件 ${partKey} 的距离必须是非负有限数。`);
    }
    if (typeof item.fixed !== 'boolean') throw new Error(`零件 ${partKey} 的 fixed 必须是布尔值。`);
    return {
      partKey, name: text(item.name, `parts[${index}].name`, 256), nodePath,
      ...(item.parentPartKey === undefined ? {} : { parentPartKey: text(item.parentPartKey, 'parentPartKey', 256) }),
      axis, distanceMeters: item.distanceMeters, fixed: item.fixed,
    };
  });
  const byKey = new Map(parts.map((part) => [part.partKey, part]));
  const checked = new Set<string>();
  for (const part of parts) {
    const chain = new Set<string>();
    let key: string | undefined = part.partKey;
    while (key && !checked.has(key)) {
      const current = byKey.get(key);
      if (!current) throw new Error(`零件 ${part.partKey} 的父零件不存在。`);
      if (chain.has(key)) throw new Error(`零件 ${part.partKey} 的父级关系存在循环。`);
      chain.add(key);
      key = current.parentPartKey;
    }
    for (const visited of chain) checked.add(visited);
  }
  return {
    schemaVersion: 1,
    model: {
      dataPlatformModel: { ...identity, kind: 'model' },
      versionId,
      contentSha256, sourcePath,
      sourceUrl: resourceUrl(model.sourceUrl, sourcePath, 'model.sourceUrl'),
      metaPath, metaUrl: resourceUrl(model.metaUrl, metaPath, 'model.metaUrl'),
      unitScaleToMeters: model.unitScaleToMeters,
    },
    configuration: { id: text(configuration.id, 'configuration.id', 256), parameters: parameters(configuration.parameters) },
    ...(device ? { device } : {}),
    parts,
  };
}

/** 设备参数变化后保留旧绑定并提示重新配置，不能悄悄改写固定快照。 */
export function inspectionConfigurationMatches(binding: InspectionBinding, current: ModelParameterValues | undefined): boolean {
  const left = binding.configuration.parameters;
  const right = current ?? {};
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((key) => {
    if (!Object.prototype.hasOwnProperty.call(right, key)) return false;
    const a = left[key];
    const b = right[key];
    if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) return a === b;
    return a.x === b.x && a.y === b.y && a.z === b.z;
  });
}

/** 复制设备时保留可复用配置，显式丢弃真实设备映射。 */
export function cloneInspectionWithoutDevice(binding: InspectionBinding): InspectionBinding {
  const copy = structuredClone(binding);
  delete copy.device;
  return copy;
}
