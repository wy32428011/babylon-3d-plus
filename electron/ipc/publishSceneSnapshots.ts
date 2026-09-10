import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { getHeapStatistics } from 'node:v8';
import { getClickEventModelResourceKey } from '../shared/clickEventModelIdentity.js';

const MAX_SCENE_BYTES = 64 * 1024 * 1024;
function assertSnapshotMemoryAvailable(additionalBytes: number): void {
  // 不限制工程总大小，仅在进程已无法容纳当前场景的解析/序列化副本时报告可恢复错误。
  if (additionalBytes * 6 > getHeapStatistics().total_available_size) throw new Error('当前进程可用内存不足以准备此场景，请释放内存后重试。');
}
export type PublishSceneSnapshot = {
  sceneId: string; name: string; sceneContent: string; isEntry: boolean;
  sourcePath: string | null; diskHash: string | null;
};
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const RESOURCE_FIELDS = new Set(['id', 'name', 'displayName', 'sourceUrl', 'sourcePath', 'path', 'assetId', 'assetRevision',
  'dataPlatformModel', 'sourceSnapshot', 'packagePath', 'metadataPath', 'thumbnailPath', 'thumbnailUrl', 'scriptPaths', 'scriptAssets',
  'parameterConfig', 'parameterScriptMetadata', 'animationScriptMetadata', 'animationConfig', 'fileSizeBytes',
  'lengthUnit', 'unitScaleToMeters', 'dataDrivenConfig', 'builtInSlotBindingConfig']);

type ParameterTemplate = { parameterConfig?: unknown };
type ParameterConfig = { parameters?: Array<{ key?: string; type?: string; defaultValue?: unknown }> };
const canonicalValue = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);

/** 新增默认值必须取已对齐的中台模板；不以renderer自报的新config作为权威证据。 */
export function assertPublishSceneParameterTemplates(previousContent: string, preparedContent: string,
  templatesByUrl: ReadonlyMap<string, ParameterTemplate>): void {
  const visit = (previous: unknown, prepared: unknown): void => {
    if (!prepared || typeof prepared !== 'object') return;
    if (Array.isArray(prepared)) {
      prepared.forEach((item, index) => visit(Array.isArray(previous) ? previous[index] : undefined, item));
      return;
    }
    const next = prepared as Record<string, unknown>;
    const old = previous && typeof previous === 'object' ? previous as Record<string, unknown> : {};
    const template = typeof next.sourceUrl === 'string' && ('lengthUnit' in next || 'parameterConfig' in next)
      ? templatesByUrl.get(next.sourceUrl) : undefined;
    if (template) {
      const authoritative = template.parameterConfig as ParameterConfig | undefined;
      const oldConfig = old.parameterConfig as ParameterConfig | undefined;
      const nextConfig = next.parameterConfig as ParameterConfig | undefined;
      if (!nextConfig) {
        // 无效新版配置已由renderer记录提示并清理；真实模型版本和字节在调用前已验证。
        if (Object.keys((next.parameterValues as Record<string, unknown> | undefined) ?? {}).length) {
          throw new Error('发布场景参数配置已清理，但仍残留旧参数值。');
        }
      } else if ('lengthUnit' in next || authoritative?.parameters || oldConfig?.parameters || nextConfig?.parameters) {
        const definitions = authoritative?.parameters ?? [];
        const keys = definitions.map(definition => definition.key?.trim()).filter((key): key is string => !!key);
        const declared = (nextConfig?.parameters ?? []).map(definition => definition.key?.trim()).filter((key): key is string => !!key);
        if (canonicalValue([...keys].sort()) !== canonicalValue([...declared].sort())) throw new Error('发布场景参数定义未完整使用数据中台新版模板。');
        const oldValues = old.parameterValues as Record<string, unknown> | undefined;
        const values = next.parameterValues as Record<string, unknown> | undefined;
        if (Object.keys(values ?? {}).some(key => !keys.includes(key))) throw new Error('发布场景仍包含中台新版模板已删除的参数值。');
        for (const definition of definitions) {
          const key = definition.key!.trim();
          if (oldValues && Object.hasOwn(oldValues, key)) continue;
          // 与现有normalizer的默认值语义一致；字符串参数本身不trim，纹理仅规范分隔符。
          const rawDefault = definition.defaultValue;
          const expected = typeof rawDefault === 'string' && ['texture', 'enum', 'color'].includes(definition.type ?? '')
            ? definition.type === 'texture' ? rawDefault.trim().replace(/\\/g, '/') : rawDefault.trim() : rawDefault;
          if (!values || !Object.hasOwn(values, key) || canonicalValue(values[key]) !== canonicalValue(expected)) {
            throw new Error(`发布场景新增参数未使用权威中台默认值：${key}`);
          }
        }
      }
    }
    for (const [key, value] of Object.entries(next)) visit(old[key], value);
  };
  visit(JSON.parse(previousContent).scene, JSON.parse(preparedContent).scene);
}

/** 资源字段可更新，但实例身份、已有参数值和资源引用之外的业务配置不可被准备过程清除。 */
export function assertPublishSceneInstanceStatePreserved(previousContent: string, nextContent: string): void {
  const previous = JSON.parse(previousContent).scene;
  const next = JSON.parse(nextContent).scene;
  const beforeEntities = previous.entities ?? {};
  const afterEntities = next.entities ?? {};
  if (Object.keys(beforeEntities).some(id => !Object.hasOwn(afterEntities, id))) throw new Error('发布准备删除了原场景实体。');
  if (Array.isArray(previous.entityIds)) {
    const previousIds = new Set(previous.entityIds);
    const nextIds = new Set(Array.isArray(next.entityIds) ? next.entityIds : []);
    if (!Array.isArray(next.entityIds) || nextIds.size !== next.entityIds.length
      || next.entityIds.some((id: unknown) => typeof id !== 'string' || !Object.hasOwn(afterEntities, id))
      || JSON.stringify(next.entityIds.filter((id: string) => previousIds.has(id))) !== JSON.stringify(previous.entityIds)
      || Object.keys(afterEntities).some(id => !Object.hasOwn(beforeEntities, id) && !nextIds.has(id))) {
      throw new Error('发布准备改变了原场景实体顺序或遗漏实体引用。');
    }
  }
  const clickReferences = (entities: Record<string, any>) => {
    const targets = new Set<string>();
    const devices: any[] = [];
    const addTarget = (asset: any) => { const key = getClickEventModelResourceKey(asset?.sourceUrl); if (key) targets.add(key); };
    for (const entity of Object.values(entities)) {
      const components = entity?.components;
      addTarget(components?.modelAsset);
      addTarget(components?.modelGenerator?.defaultTarget?.modelAsset);
      for (const rule of components?.modelGenerator?.rules ?? []) addTarget(rule?.target?.modelAsset);
      for (const slot of components?.clickEventBinding?.deviceSlots ?? []) if (slot?.deviceType) devices.push(slot.deviceType);
    }
    return { targets, devices };
  };
  const originalReferences = clickReferences(beforeEntities);
  const missingResourceIds = new Set(originalReferences.devices.flatMap(device => {
    const key = getClickEventModelResourceKey(device.sourceUrl);
    return key && !originalReferences.targets.has(key) ? [key.split(':').slice(0, 2).join(':')] : [];
  }));
  const nextDeviceKeys = new Set(clickReferences(afterEntities).devices.map(device => getClickEventModelResourceKey(device.sourceUrl)));
  const restoredKeys = new Set<string>();
  for (const [id, entity] of Object.entries(afterEntities) as Array<[string, any]>) {
    if (Object.hasOwn(beforeEntities, id)) continue;
    const key = getClickEventModelResourceKey(entity?.components?.modelAsset?.sourceUrl);
    const transform = entity?.components?.transform;
    if (!key || !missingResourceIds.has(key.split(':').slice(0, 2).join(':')) || !nextDeviceKeys.has(key) || restoredKeys.has(key)
      || entity.id !== id || entity.parentId !== null || entity.childrenIds?.length !== 0
      || Object.keys(entity.components).some(component => !['modelAsset', 'transform', 'telemetryBinding'].includes(component))
      || !['x', 'y', 'z'].every(axis => transform?.position?.[axis] === 0 && transform?.rotation?.[axis] === 0 && transform?.scale?.[axis] === 1)) {
      throw new Error('发布准备新增了未经原点击设备槽位授权的场景实体。');
    }
    restoredKeys.add(key);
  }
  const compare = (before: unknown, after: unknown, location: string): void => {
    if (before === null || typeof before !== 'object') {
      if (before !== after) throw new Error(`发布准备改变了实例参数或绑定：${location}`);
      return;
    }
    if (Array.isArray(before)) {
      if (!Array.isArray(after) || before.length !== after.length) throw new Error(`发布准备丢失了实例参数或绑定：${location}`);
      before.forEach((item, index) => compare(item, after[index], `${location}[${index}]`));
      return;
    }
    if (!after || typeof after !== 'object' || Array.isArray(after)) throw new Error(`发布准备丢失了实例参数或绑定：${location}`);
    const oldRecord = before as Record<string, unknown>;
    const newRecord = after as Record<string, unknown>;
    const resourceReference = typeof oldRecord.sourceUrl === 'string' || oldRecord.modelAsset !== undefined || oldRecord.assetId !== undefined;
    const oldConfig = oldRecord.parameterConfig as { parameters?: Array<{ key?: string }> } | undefined;
    const newConfig = newRecord.parameterConfig as { parameters?: Array<{ key?: string }> } | undefined;
    const resourceChanged = oldRecord.sourceUrl !== newRecord.sourceUrl || oldRecord.assetRevision !== newRecord.assetRevision;
    const reconcileParameters = resourceReference && (Array.isArray(oldConfig?.parameters) || Array.isArray(newConfig?.parameters)
      || ('lengthUnit' in newRecord && resourceChanged));
    if (reconcileParameters) {
      const newKeys = new Set((newConfig?.parameters ?? []).flatMap(definition => typeof definition.key === 'string' ? [definition.key.trim()] : []));
      const oldValues = oldRecord.parameterValues as Record<string, unknown> | undefined;
      const newValues = newRecord.parameterValues as Record<string, unknown> | undefined;
      for (const key of newKeys) if (oldValues && Object.hasOwn(oldValues, key)) {
        compare(oldValues[key], newValues?.[key], `${location}.parameterValues.${key}`);
      }
      for (const key of Object.keys(newValues ?? {})) if (!newKeys.has(key)) {
        throw new Error(`发布准备仍残留新版已删除的参数：${location}.parameterValues.${key}`);
      }
    }
    for (const [key, value] of Object.entries(oldRecord)) {
      if ((resourceReference && RESOURCE_FIELDS.has(key)) || (key === 'modelArrayInstance' && location.endsWith('.components'))) continue;
      if (reconcileParameters && key === 'parameterValues') continue;
      compare(value, newRecord[key], `${location}.${key}`);
    }
  };
  for (const [id, entity] of Object.entries(beforeEntities)) compare(entity, afterEntities[id], `entities.${id}`);
  const environment = previous.sceneSettings?.environment;
  if (environment) for (const key of ['transform', 'visible', 'opacity', 'placementMode']) {
    if (environment[key] !== undefined) compare(environment[key], next.sceneSettings?.environment?.[key], `sceneSettings.environment.${key}`);
  }
}
function parseScene(content: string): { scene: { name?: string } } {
  if (typeof content !== 'string' || !content || Buffer.byteLength(content) > MAX_SCENE_BYTES) throw new Error('发布准备场景大小无效或超过 64 MiB。');
  const parsed = JSON.parse(content);
  if (![1, 2, 3, 4, 5].includes(parsed?.version) || !parsed.scene || typeof parsed.scene !== 'object' || Array.isArray(parsed.scene)) throw new Error('发布准备场景格式无效。');
  if (parsed.scene.entities !== undefined && (!parsed.scene.entities || typeof parsed.scene.entities !== 'object' || Array.isArray(parsed.scene.entities))) throw new Error('发布准备场景实体集合无效。');
  return parsed;
}
async function listScenes(projectRoot: string, signal: AbortSignal): Promise<string[]> {
  const result: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    signal.throwIfAborted();
    const stat = await fs.lstat(directory).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (!stat) return;
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('SOURCE 场景目录不是安全目录。');
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      signal.throwIfAborted();
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('SOURCE 场景目录不能包含符号链接。');
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.scene.json')) {
        result.push(file);
        if (result.length > 1000) throw new Error('SOURCE 场景数量超过 1000。');
      }
    }
  };
  await visit(path.join(projectRoot, 'Scenes'));
  return result.sort();
}
async function readScene(file: string): Promise<string> {
  const stat = await fs.lstat(file);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_SCENE_BYTES) throw new Error('SOURCE 场景文件不安全或超过大小限制。');
  const content = new TextDecoder('utf-8', { fatal: true }).decode(await fs.readFile(file));
  parseScene(content);
  return content;
}

/** 只返回已确认项目中的场景；renderer 使用随机 ID，不能指定写入路径。 */
export async function capturePublishSceneSnapshots(projectRoot: string, entryFile: string | null, currentContent: string,
  signal: AbortSignal): Promise<PublishSceneSnapshot[]> {
  parseScene(currentContent);
  const snapshots: PublishSceneSnapshot[] = [];
  for (const sourcePath of await listScenes(projectRoot, signal)) {
    const diskContent = await readScene(sourcePath);
    const isEntry = entryFile !== null && path.resolve(sourcePath) === path.resolve(entryFile);
    const sceneContent = isEntry ? currentContent : diskContent;
    assertSnapshotMemoryAvailable(Buffer.byteLength(sceneContent));
    snapshots.push({ sceneId: randomUUID(), name: parseScene(sceneContent).scene.name || path.basename(sourcePath),
      sceneContent, isEntry, sourcePath, diskHash: hash(diskContent) });
  }
  if (!snapshots.some(s => s.isEntry)) snapshots.unshift({ sceneId: randomUUID(), name: parseScene(currentContent).scene.name || '当前场景',
    sceneContent: currentContent, isEntry: true, sourcePath: null, diskHash: null });
  return snapshots;
}

/** 验证全部准备结果和并发磁盘编辑，输出仅供 SOURCE 暂存层使用的覆盖表。 */
export async function validatePreparedPublishScenes(snapshots: readonly PublishSceneSnapshot[],
  prepared: readonly { sceneId: string; sceneContent: string }[], projectRoot: string, entryFile: string,
  signal: AbortSignal): Promise<Map<string, string>> {
  if (!Array.isArray(prepared) || prepared.length !== snapshots.length) throw new Error('SOURCE 场景准备结果不完整。');
  const byId = new Map(prepared.map(item => [item.sceneId, item.sceneContent]));
  if (byId.size !== snapshots.length) throw new Error('SOURCE 场景准备结果重复或不完整。');
  const files = await listScenes(projectRoot, signal);
  const originalFiles = snapshots.flatMap(s => s.sourcePath ? [s.sourcePath] : []).sort();
  if (JSON.stringify(files) !== JSON.stringify(originalFiles)) throw new Error('准备期间 SOURCE 场景文件集合发生变化，请重试。');
  const result = new Map<string, string>();
  for (const snapshot of snapshots) {
    signal.throwIfAborted();
    const content = byId.get(snapshot.sceneId);
    if (content === undefined) throw new Error('SOURCE 场景准备结果不完整。');
    assertSnapshotMemoryAvailable(Buffer.byteLength(content));
    parseScene(content);
    assertPublishSceneInstanceStatePreserved(snapshot.sceneContent, content);
    if (snapshot.sourcePath && hash(await readScene(snapshot.sourcePath)) !== snapshot.diskHash) throw new Error(`准备期间场景「${snapshot.name}」发生变化，请重试。`);
    result.set(snapshot.isEntry ? entryFile : snapshot.sourcePath!, content);
  }
  return result;
}
