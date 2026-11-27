import { normalizeSkyboxEnvironmentResource } from '../shared/sceneSkyboxContract.ts';
import { isSupportedSceneFileVersion } from '../shared/sceneFileVersion.js';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { getHeapStatistics } from 'node:v8';
import { getClickEventModelResourceKey, matchesClickEventModelIdentity } from '../shared/clickEventModelIdentity.js';

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
  'parameterConfig', 'parameterScriptMetadata', 'animationScriptMetadata', 'animationConfig', 'fileSizeBytes', 'deviceType', 'runtimeCapabilities',
  'lengthUnit', 'unitScaleToMeters', 'dataDrivenConfig', 'builtInSlotBindingConfig', 'layerChangePlatformBindingConfig', 'cargoContactSupports',
  'metaExtensions']);

/** 只描述发布预检读取的 JSON 字段；解析边界与原有校验及拒绝顺序保持一致。 */
type PublishSubDeviceDeclaration = { role?: unknown; device?: { devType?: unknown } };
type PublishModelAssetReference = {
  sourceUrl?: unknown;
  dataDrivenConfig?: { subDevices?: PublishSubDeviceDeclaration[] };
};
type PublishModelTargetReference = { modelAsset?: PublishModelAssetReference };
type PublishReferenceEntity = {
  id?: unknown;
  isFolder?: unknown;
  parentId?: unknown;
  childrenIds?: unknown;
  components: {
    modelAsset?: PublishModelAssetReference;
    modelGenerator?: {
      defaultTarget?: PublishModelTargetReference;
      rules?: Array<{ target?: PublishModelTargetReference }>;
    };
    clickEventBinding?: { deviceSlots?: Array<{ deviceType?: PublishModelAssetReference }> };
    compositeDevice?: { hostEntityId?: unknown };
    devicePartBinding?: { hostEntityId?: unknown; role?: unknown };
    telemetryBinding?: { deviceType?: unknown; assetCode?: unknown };
    skybox?: Record<string, unknown>;
    transform?: { position?: Record<string, unknown>; rotation?: Record<string, unknown>; scale?: Record<string, unknown> };
    [component: string]: unknown;
  };
};

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
  const isIdentityTransform = (transform: PublishReferenceEntity['components']['transform']): boolean =>
    ['x', 'y', 'z'].every(axis => transform?.position?.[axis] === 0 && transform?.rotation?.[axis] === 0 && transform?.scale?.[axis] === 1);
  const clickReferences = (entities: Record<string, PublishReferenceEntity>) => {
    const targets: PublishModelAssetReference[] = [];
    const devices: PublishModelAssetReference[] = [];
    const addTarget = (asset: PublishModelAssetReference | null | undefined) => { if (asset) targets.push(asset); };
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
    if (!key) return [];
    const hasTarget = originalReferences.targets.some(
      target => getClickEventModelResourceKey(target.sourceUrl) === key || matchesClickEventModelIdentity(target, device),
    );
    return hasTarget ? [] : [key.split(':').slice(0, 2).join(':')];
  }));
  const nextDeviceKeys = new Set(clickReferences(afterEntities).devices.map(device => getClickEventModelResourceKey(device.sourceUrl)));
  const existingCompositeFolderByHostId = new Map<string, string>();
  const existingPartKeys = new Set<string>();
  for (const [id, entity] of Object.entries<PublishReferenceEntity>(beforeEntities)) {
    const compositeHostId = entity?.components?.compositeDevice?.hostEntityId;
    if (entity?.isFolder === true && typeof compositeHostId === 'string') {
      existingCompositeFolderByHostId.set(compositeHostId, id);
    }
    const partBinding = entity?.components?.devicePartBinding;
    if (typeof partBinding?.hostEntityId === 'string' && typeof partBinding?.role === 'string' && partBinding.role.trim()) {
      existingPartKeys.add(`${partBinding.hostEntityId}\0${partBinding.role.trim()}`);
    }
  }
  const declaredSubDevicesByHostId = new Map<string, Map<string, PublishSubDeviceDeclaration>>();
  const getDeclaredSubDevices = (hostId: string): Map<string, PublishSubDeviceDeclaration> => {
    const cached = declaredSubDevicesByHostId.get(hostId);
    if (cached) return cached;
    const map = new Map<string, PublishSubDeviceDeclaration>();
    const beforeHost = Object.hasOwn(beforeEntities, hostId) ? (beforeEntities[hostId] as PublishReferenceEntity) : undefined;
    const afterHost = Object.hasOwn(afterEntities, hostId) ? (afterEntities[hostId] as PublishReferenceEntity) : undefined;
    const subDevices = beforeHost?.components?.modelAsset ? afterHost?.components?.modelAsset?.dataDrivenConfig?.subDevices : undefined;
    if (Array.isArray(subDevices)) {
      for (const declaration of subDevices) {
        const role = typeof declaration?.role === 'string' ? declaration.role.trim() : '';
        if (role && !map.has(role)) map.set(role, declaration);
      }
    }
    declaredSubDevicesByHostId.set(hostId, map);
    return map;
  };
  const newCompositeFolderByHostId = new Map<string, string>();
  const authorizedNewEntityIds = new Set<string>();
  const rejectUnauthorizedNewEntity = (): never => {
    throw new Error('发布准备新增了未经原点击设备槽位授权的场景实体。');
  };
  // 第一遍：校验由新版 subDevices 复合设备协调新增的复合分组容器。
  for (const [id, entity] of Object.entries<PublishReferenceEntity>(afterEntities)) {
    if (Object.hasOwn(beforeEntities, id)) continue;
    if (entity?.components?.compositeDevice === undefined) continue;
    const componentKeys = Object.keys(entity.components ?? {});
    const hostId = entity.components.compositeDevice?.hostEntityId;
    const childrenIds = Array.isArray(entity.childrenIds) ? entity.childrenIds : null;
    if (entity.id !== id || entity.isFolder !== true
      || componentKeys.length !== 2 || !componentKeys.includes('transform') || !componentKeys.includes('compositeDevice')
      || !isIdentityTransform(entity.components.transform)
      || typeof hostId !== 'string' || !Object.hasOwn(beforeEntities, hostId)
      || getDeclaredSubDevices(hostId).size === 0
      || existingCompositeFolderByHostId.has(hostId) || newCompositeFolderByHostId.has(hostId)
      || (entity.parentId ?? null) !== ((beforeEntities[hostId] as PublishReferenceEntity).parentId ?? null)
      || (afterEntities[hostId] as PublishReferenceEntity)?.parentId !== id
      || !childrenIds || childrenIds.length < 2 || childrenIds[0] !== hostId
      || new Set(childrenIds).size !== childrenIds.length
      || childrenIds.slice(1).some(childId => typeof childId !== 'string' || !Object.hasOwn(afterEntities, childId)
        || (afterEntities[childId] as PublishReferenceEntity)?.components?.devicePartBinding?.hostEntityId !== hostId)) {
      rejectUnauthorizedNewEntity();
    }
    newCompositeFolderByHostId.set(hostId as string, id);
    authorizedNewEntityIds.add(id);
  }
  const addedPartKeys = new Set<string>();
  const addedPartsByFolderId = new Map<string, Set<string>>();
  const hasExistingSkyboxEntity = Object.values<PublishReferenceEntity>(beforeEntities).some(entity => entity?.components?.skybox !== undefined);
  const legacySkybox = previous.sceneSettings?.skybox && typeof previous.sceneSettings.skybox === 'object' && !Array.isArray(previous.sceneSettings.skybox)
    ? previous.sceneSettings.skybox as Record<string, unknown>
    : null;
  let migratedLegacySkyboxEntity: { id: string; skybox: Record<string, unknown> } | null = null;
  const restoredKeys = new Set<string>();
  // 第二遍：校验逻辑子设备、旧扁平天空盒迁移实体与原点击设备槽位恢复实体。
  for (const [id, entity] of Object.entries<PublishReferenceEntity>(afterEntities)) {
    if (Object.hasOwn(beforeEntities, id) || authorizedNewEntityIds.has(id)) continue;
    const components = entity?.components ?? {};
    const componentKeys = Object.keys(components);
    if (components.devicePartBinding !== undefined) {
      const hostId = components.devicePartBinding?.hostEntityId;
      const role = components.devicePartBinding?.role;
      const declaration = typeof hostId === 'string' && typeof role === 'string' && role.trim() === role && role.length > 0
        ? getDeclaredSubDevices(hostId).get(role)
        : undefined;
      const expectedFolderId = typeof hostId === 'string'
        ? (newCompositeFolderByHostId.get(hostId) ?? existingCompositeFolderByHostId.get(hostId))
        : undefined;
      const folder = expectedFolderId ? (afterEntities[expectedFolderId] as PublishReferenceEntity | undefined) : undefined;
      const folderChildren = Array.isArray(folder?.childrenIds) ? folder.childrenIds : null;
      const partKey = `${String(hostId)}\0${String(role)}`;
      const telemetry = components.telemetryBinding;
      const expectedDevType = typeof declaration?.device?.devType === 'string' && declaration.device.devType.trim()
        ? declaration.device.devType.trim()
        : 'conveyor';
      if (entity.id !== id || entity.isFolder === true
        || !componentKeys.includes('transform') || !componentKeys.includes('devicePartBinding')
        || componentKeys.some(component => !['transform', 'devicePartBinding', 'telemetryBinding'].includes(component))
        || !isIdentityTransform(components.transform)
        || !Array.isArray(entity.childrenIds) || entity.childrenIds.length !== 0
        || !declaration || !expectedFolderId || entity.parentId !== expectedFolderId
        || !folderChildren || !folderChildren.includes(id)
        || existingPartKeys.has(partKey) || addedPartKeys.has(partKey)
        || (telemetry !== undefined && (!telemetry || typeof telemetry !== 'object' || Array.isArray(telemetry)
          || telemetry.assetCode !== undefined || telemetry.deviceType !== expectedDevType))) {
        rejectUnauthorizedNewEntity();
      }
      addedPartKeys.add(partKey);
      const bucket = addedPartsByFolderId.get(expectedFolderId!) ?? new Set<string>();
      bucket.add(id);
      addedPartsByFolderId.set(expectedFolderId!, bucket);
      authorizedNewEntityIds.add(id);
      continue;
    }
    if (components.skybox !== undefined) {
      const transform = components.transform;
      const rotationY = transform?.rotation?.y;
      const rawRotationDegrees = legacySkybox?.rotationDegrees;
      const expectedRotationY = typeof rawRotationDegrees === 'number' && Number.isFinite(rawRotationDegrees)
        ? Math.min(360, Math.max(0, rawRotationDegrees)) * Math.PI / 180
        : null;
      if (!legacySkybox || hasExistingSkyboxEntity || next.sceneSettings?.skybox != null || migratedLegacySkyboxEntity
        || entity.id !== id || entity.isFolder === true || entity.parentId !== null
        || !Array.isArray(entity.childrenIds) || entity.childrenIds.length !== 0
        || componentKeys.length !== 2 || !componentKeys.includes('transform') || !componentKeys.includes('skybox')
        || !['x', 'y', 'z'].every(axis => transform?.position?.[axis] === 0 && transform?.scale?.[axis] === 1)
        || transform?.rotation?.x !== 0 || transform?.rotation?.z !== 0
        || typeof rotationY !== 'number' || !Number.isFinite(rotationY)
        || (expectedRotationY !== null && Math.abs(rotationY - expectedRotationY) > 1e-6)) {
        rejectUnauthorizedNewEntity();
      }
      migratedLegacySkyboxEntity = { id, skybox: components.skybox };
      authorizedNewEntityIds.add(id);
      continue;
    }
    const key = getClickEventModelResourceKey(components.modelAsset?.sourceUrl);
    if (!key || !missingResourceIds.has(key.split(':').slice(0, 2).join(':')) || !nextDeviceKeys.has(key) || restoredKeys.has(key)
      || entity.id !== id || entity.parentId !== null
      || !Array.isArray(entity.childrenIds) || entity.childrenIds.length !== 0
      || componentKeys.some(component => !['modelAsset', 'transform', 'telemetryBinding'].includes(component))
      || !isIdentityTransform(components.transform)) {
      throw new Error('发布准备新增了未经原点击设备槽位授权的场景实体。');
    }
    restoredKeys.add(key);
    authorizedNewEntityIds.add(id);
  }
  const reparentedExistingPartToFolder = new Map<string, string>();
  const removedReparentedPartIdsByParentId = new Map<string, Set<string>>();
  for (const [id, entity] of Object.entries<PublishReferenceEntity>(beforeEntities)) {
    const partBinding = entity?.components?.devicePartBinding;
    const hostId = partBinding?.hostEntityId;
    if (typeof hostId !== 'string') continue;
    const targetFolderId = newCompositeFolderByHostId.get(hostId);
    if (!targetFolderId || entity.parentId === targetFolderId) continue;
    if ((afterEntities[id] as PublishReferenceEntity)?.parentId === targetFolderId) {
      reparentedExistingPartToFolder.set(id, targetFolderId);
      if (typeof entity.parentId === 'string') {
        const removed = removedReparentedPartIdsByParentId.get(entity.parentId) ?? new Set<string>();
        removed.add(id);
        removedReparentedPartIdsByParentId.set(entity.parentId, removed);
      }
    }
  }
  const compare = (before: unknown, after: unknown, location: string, rootEntityId?: string): void => {
    if (location.endsWith('.components.skybox.environment') || location.endsWith('.sceneSettings.skybox.environment')) {
      // 产物可以随已验证的源升级重建；主发布流程仍逐文件核对源 SHA、recipe 和 ENV SHA。
      normalizeSkyboxEnvironmentResource(after);
      return;
    }
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
    const skyboxReference = location.endsWith('.components.skybox');
    const resourceReference = skyboxReference || typeof oldRecord.sourceUrl === 'string' || oldRecord.modelAsset !== undefined || oldRecord.assetId !== undefined;
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
      if (skyboxReference && ['dataPlatformResourceId', 'format'].includes(key)) continue;
      if ((resourceReference && RESOURCE_FIELDS.has(key)) || (key === 'modelArrayInstance' && location.endsWith('.components'))) continue;
      if (reconcileParameters && key === 'parameterValues') continue;
      if (rootEntityId !== undefined && key === 'parentId') {
        const expectedParent = newCompositeFolderByHostId.get(rootEntityId) ?? reparentedExistingPartToFolder.get(rootEntityId);
        if (expectedParent !== undefined && newRecord.parentId === expectedParent) continue;
      }
      if (rootEntityId !== undefined && key === 'childrenIds' && Array.isArray(value) && Array.isArray(newRecord.childrenIds)) {
        const nextChildren: unknown[] = newRecord.childrenIds;
        const removedParts = removedReparentedPartIdsByParentId.get(rootEntityId);
        const mappedBefore = value
          .filter(childId => !(typeof childId === 'string' && removedParts?.has(childId)))
          .map(childId => typeof childId === 'string' && (beforeEntities[childId] as PublishReferenceEntity | undefined)?.parentId === rootEntityId
            ? (newCompositeFolderByHostId.get(childId) ?? childId)
            : childId);
        const addedParts = addedPartsByFolderId.get(rootEntityId);
        if (addedParts?.size) {
          const appended = nextChildren.slice(mappedBefore.length);
          if (nextChildren.length === mappedBefore.length + addedParts.size
            && mappedBefore.every((childId, index) => nextChildren[index] === childId)
            && new Set(appended).size === appended.length
            && appended.every(childId => typeof childId === 'string' && addedParts.has(childId))) {
            continue;
          }
        } else if (nextChildren.length === mappedBefore.length
          && mappedBefore.every((childId, index) => nextChildren[index] === childId)) {
          continue;
        }
      }
      compare(value, newRecord[key], `${location}.${key}`);
    }
  };
  for (const [id, entity] of Object.entries(beforeEntities)) compare(entity, afterEntities[id], `entities.${id}`, id);
  if (migratedLegacySkyboxEntity && legacySkybox) {
    const { rotationDegrees: _rotationDegrees, ...legacySkyboxFields } = legacySkybox;
    compare(legacySkyboxFields, migratedLegacySkyboxEntity.skybox, `entities.${migratedLegacySkyboxEntity.id}.components.skybox`);
  }
  const environment = previous.sceneSettings?.environment;
  if (environment) for (const key of ['transform', 'visible', 'opacity', 'placementMode']) {
    if (environment[key] !== undefined) compare(environment[key], next.sceneSettings?.environment?.[key], `sceneSettings.environment.${key}`);
  }
}
function parseScene(content: string): { scene: { name?: string } } {
  if (typeof content !== 'string' || !content) throw new Error('发布准备场景内容不能为空。');
  const parsed = JSON.parse(content);
  if (!isSupportedSceneFileVersion(parsed?.version) || !parsed.scene || typeof parsed.scene !== 'object' || Array.isArray(parsed.scene)) throw new Error('发布准备场景格式无效。');
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
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('SOURCE 场景文件不安全。');
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
