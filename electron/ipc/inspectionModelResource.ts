import path from 'node:path';
import type { InspectionModelVersionPreparationResult } from '../types.js';
import { readModelResourceDependencies } from './modelResourceDependencies.js';

/** 中台固定版本快照尚不包含外部 glTF 文件，因此只能使用自包含模型。 */
export async function assertInspectionModelSelfContained(modelPath: string, packageRoot: string, signal: AbortSignal): Promise<void> {
  const extension = path.extname(modelPath).toLowerCase();
  if (extension !== '.glb' && extension !== '.gltf') throw new Error('巡检高模必须是自包含的 GLB 或 glTF 模型。');
  let dependencies: string[];
  try {
    dependencies = await readModelResourceDependencies(modelPath, packageRoot, signal);
  } catch (error) {
    if (signal.aborted) throw error;
    throw new Error('巡检高模无法验证为自包含模型，请使用内嵌缓冲区和纹理的 GLB 或 glTF。', { cause: error });
  }
  if (dependencies.length) throw new Error('巡检高模暂不支持外部缓冲区或纹理，请使用自包含模型。');
}

type InspectionPart = NonNullable<InspectionModelVersionPreparationResult['parts']>[number];
type InspectionParameter = number | string | boolean | { x: number; y: number; z: number };

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${label}必须是对象。`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > max
    || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`${label}必须是有效的非空字符串。`);
  return value;
}

function vector(value: unknown, label: string): { x: number; y: number; z: number } {
  const item = object(value, label);
  if (typeof item.x !== 'number' || !Number.isFinite(item.x) || typeof item.y !== 'number' || !Number.isFinite(item.y)
    || typeof item.z !== 'number' || !Number.isFinite(item.z)) throw new Error(`${label}必须包含有限的 x、y、z。`);
  return { x: item.x, y: item.y, z: item.z };
}

/** 只返回经过结构校验的版本元数据，不从其他字段猜测零件或适用配置。 */
export function parseInspectionMetadata(metadata: unknown): {
  parts?: InspectionPart[]; configuration?: { id: string; parameters: Record<string, InspectionParameter> };
} {
  const root = object(metadata, '模型元数据');
  if (root.inspection === undefined) return {};
  const manifest = object(root.inspection, 'inspection');
  if (manifest.schemaVersion !== 1) throw new Error('inspection.schemaVersion 必须为 1。');
  if (!Array.isArray(manifest.parts) || manifest.parts.length === 0 || manifest.parts.length > 10000) {
    throw new Error('inspection.parts 必须包含 1 至 10000 个零件。');
  }
  const keys = new Set<string>();
  const paths = new Set<string>();
  const parts = manifest.parts.map((value, index): InspectionPart => {
    const item = object(value, `parts[${index}]`);
    const partKey = text(item.partKey, '零件标识', 256);
    const nodePath = text(item.nodePath, `零件 ${partKey} 的节点路径`, 2048);
    if (nodePath !== '.' && (/[;,]/.test(nodePath)
      || nodePath.split('/').some(segment => !segment || segment === '.' || segment === '..'))) {
      throw new Error(`零件 ${partKey} 的节点路径无效。`);
    }
    if (keys.has(partKey) || paths.has(nodePath)) throw new Error('巡检零件标识或节点路径重复。');
    keys.add(partKey); paths.add(nodePath);
    const axis = vector(item.axis, `零件 ${partKey} 的世界方向`);
    if (axis.x === 0 && axis.y === 0 && axis.z === 0) throw new Error(`零件 ${partKey} 的世界方向不能为零。`);
    if (typeof item.distanceMeters !== 'number' || !Number.isFinite(item.distanceMeters) || item.distanceMeters < 0
      || typeof item.fixed !== 'boolean') throw new Error(`零件 ${partKey} 的距离或固定状态无效。`);
    return { partKey, name: text(item.name, '零件名称', 256), nodePath,
      ...(item.parentPartKey === undefined ? {} : { parentPartKey: text(item.parentPartKey, '父零件标识', 256) }),
      axis, distanceMeters: item.distanceMeters, fixed: item.fixed };
  });
  const byKey = new Map(parts.map(part => [part.partKey, part]));
  const checked = new Set<string>();
  for (const part of parts) {
    const chain = new Set<string>();
    let key: string | undefined = part.partKey;
    while (key && !checked.has(key)) {
      const parent: InspectionPart | undefined = byKey.get(key);
      if (!parent) throw new Error(`零件 ${part.partKey} 的父零件不存在。`);
      if (chain.has(key)) throw new Error(`零件 ${part.partKey} 的父级关系存在循环。`);
      chain.add(key); key = parent.parentPartKey;
    }
    for (const visited of chain) checked.add(visited);
  }
  if (manifest.configuration === undefined) return { parts };
  const configuration = object(manifest.configuration, 'inspection.configuration');
  const rawParameters = object(configuration.parameters, 'inspection.configuration.parameters');
  const entries = Object.entries(rawParameters);
  if (entries.length > 1024) throw new Error('巡检配置参数过多。');
  const parameters = Object.fromEntries(entries.map(([key, value]): [string, InspectionParameter] => {
    text(key, '参数名称', 128);
    if ((typeof value === 'number' && Number.isFinite(value)) || typeof value === 'boolean'
      || (typeof value === 'string' && value.length <= 8192)) return [key, value];
    return [key, vector(value, `参数 ${key}`)];
  }));
  return { parts, configuration: { id: text(configuration.id, '巡检配置标识', 256), parameters } };
}
