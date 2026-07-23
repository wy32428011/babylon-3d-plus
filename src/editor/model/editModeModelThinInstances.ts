import type { Entity } from './Entity';
import type { ModelAssetComponent } from './components';
import type { SceneDocument } from './SceneDocument';

const EDIT_MODE_THIN_INSTANCE_MODEL_FILES_BY_SCRIPT = new Map<string, ReadonlySet<string>>([
  ['chain-conveyor.model.ts', new Set(['链条机.glb', '链条机.gltf'])],
  ['shelf.model.ts', new Set(['shelf.glb', 'shelf.gltf'])],
  ['yzj.model.ts', new Set(['yzj.glb', 'yzj.gltf'])],
]);

/** SceneDocument 采用不可变对象更新；复用未变化模板和实体的派生结果，避免 Gizmo 拖动时重复扫描大段脚本元数据。 */
const modelAssetGroupKeyCache = new WeakMap<ModelAssetComponent, string | null>();
const thinInstanceEntityCache = new WeakMap<Entity, Map<string, Entity>>();

export type EditModeModelThinInstanceReason = 'no-external-script' | 'verified-parametric-script';

export type EditModeModelThinInstancePlan = {
  entities: SceneDocument['entities'];
  groupCount: number;
  sourceEntityIds: string[];
  thinInstanceEntityCount: number;
};

/**
 * 编辑态只需要呈现参数化后的静态外观；运行预览仍必须为每个设备保留独立脚本和遥测状态。
 * 因此这里只允许无外置脚本模型，或已经核对过编辑态行为的参数化脚本进入自动 thinInstance 分组。
 */
export function resolveEditModeModelThinInstanceReason(
  modelAsset: ModelAssetComponent,
): EditModeModelThinInstanceReason | null {
  const scriptAssets = modelAsset.scriptAssets ?? [];
  if (scriptAssets.length === 0) return 'no-external-script';

  return scriptAssets.every((scriptAsset) => isVerifiedParametricScript(modelAsset, scriptAsset))
    ? 'verified-parametric-script'
    : null;
}

/**
 * 为 Scene View 构造只存在于内存中的编辑态实体覆盖层。
 * 原 SceneDocument 不会被修改或保存；重复模型只临时追加 modelArrayInstance，直接复用现有 thinInstance 运行时。
 */
export function createEditModeModelThinInstancePlan(
  scene: Pick<SceneDocument, 'entityIds' | 'entities'>,
  previousPlan?: EditModeModelThinInstancePlan,
): EditModeModelThinInstancePlan {
  const protectedSourceIds = collectProtectedModelArraySourceIds(scene);
  const groups = new Map<string, Entity[]>();

  for (const entityId of scene.entityIds) {
    const entity = scene.entities[entityId];
    const modelAsset = entity?.components.modelAsset;
    if (
      !entity
      || !modelAsset
      || entity.components.modelArrayInstance
      || entity.childrenIds.length > 0
    ) {
      continue;
    }

    const groupKey = getCachedModelAssetGroupKey(modelAsset);
    if (!groupKey) continue;

    const group = groups.get(groupKey) ?? [];
    group.push(entity);
    groups.set(groupKey, group);
  }

  let groupCount = 0;
  let thinInstanceEntityCount = 0;
  const sourceEntityIds: string[] = [];
  const sourceEntityIdByEntityId = new Map<string, string>();

  for (const group of groups.values()) {
    if (group.length < 2) continue;

    const source = chooseGroupSource(scene.entities, group, protectedSourceIds);
    let convertedInGroup = 0;

    for (const entity of group) {
      if (entity.id === source.id || protectedSourceIds.has(entity.id)) continue;
      sourceEntityIdByEntityId.set(entity.id, source.id);
      convertedInGroup += 1;
    }

    if (convertedInGroup === 0) continue;
    groupCount += 1;
    thinInstanceEntityCount += convertedInGroup;
    sourceEntityIds.push(source.id);
  }

  return {
    entities: materializeThinInstanceEntities(scene, sourceEntityIdByEntityId, previousPlan),
    groupCount,
    sourceEntityIds,
    thinInstanceEntityCount,
  };
}

/**
 * 在上一次覆盖层上只替换真正变化的实体。
 * Gizmo 每帧通常只产生一个新实体对象，因此无需重新复制 1817 个稳定派生实体。
 */
function materializeThinInstanceEntities(
  scene: Pick<SceneDocument, 'entityIds' | 'entities'>,
  sourceEntityIdByEntityId: ReadonlyMap<string, string>,
  previousPlan?: EditModeModelThinInstancePlan,
): SceneDocument['entities'] {
  if (!previousPlan) {
    if (sourceEntityIdByEntityId.size === 0) return scene.entities;
    const entities = { ...scene.entities };
    for (const [entityId, sourceEntityId] of sourceEntityIdByEntityId) {
      const entity = scene.entities[entityId];
      if (entity) entities[entityId] = getOrCreateThinInstanceEntity(entity, sourceEntityId);
    }
    return entities;
  }

  let entities = previousPlan.entities;
  let changed = false;
  const ensureMutable = (): SceneDocument['entities'] => {
    if (!changed) {
      entities = { ...entities };
      changed = true;
    }
    return entities;
  };

  for (const entityId of scene.entityIds) {
    const entity = scene.entities[entityId];
    if (!entity) continue;
    const sourceEntityId = sourceEntityIdByEntityId.get(entityId);
    const desiredEntity = sourceEntityId
      ? getOrCreateThinInstanceEntity(entity, sourceEntityId)
      : entity;
    if (entities[entityId] !== desiredEntity) ensureMutable()[entityId] = desiredEntity;
  }

  for (const entityId of Object.keys(entities)) {
    if (scene.entities[entityId]) continue;
    delete ensureMutable()[entityId];
  }

  return entities;
}

/** 已有持久化阵列的源模型不能被降级为另一组的逻辑实例，否则其原有实例会失去直接源。 */
function collectProtectedModelArraySourceIds(
  scene: Pick<SceneDocument, 'entityIds' | 'entities'>,
): Set<string> {
  const sourceIds = new Set<string>();
  for (const entityId of scene.entityIds) {
    const entity = scene.entities[entityId];
    const sourceEntityId = entity?.components.modelArrayInstance?.sourceEntityId;
    if (sourceEntityId) sourceIds.add(sourceEntityId);
    if (entity?.components.modelArray) sourceIds.add(entity.id);
  }
  return sourceIds;
}

/** 优先选择已有阵列源，其次选择当前有效可见实体，避免隐藏源节点连带关闭整个批次。 */
function chooseGroupSource(
  entities: SceneDocument['entities'],
  group: readonly Entity[],
  protectedSourceIds: ReadonlySet<string>,
): Entity {
  const protectedSources = group.filter((entity) => protectedSourceIds.has(entity.id));
  const candidates = protectedSources.length > 0 ? protectedSources : group;
  return candidates.find((entity) => isEffectivelyVisible(entities, entity)) ?? candidates[0];
}

/** SceneRuntime 当前只合并直属文件夹显隐，这里保持相同规则。 */
function isEffectivelyVisible(entities: SceneDocument['entities'], entity: Entity): boolean {
  const parent = entity.parentId ? entities[entity.parentId] : null;
  return entity.visible !== false && parent?.visible !== false;
}

/** 缓存完整分组键；Transform、显隐、锁定和选择变化不会让模型资产对象失效。 */
function getCachedModelAssetGroupKey(modelAsset: ModelAssetComponent): string | null {
  if (modelAssetGroupKeyCache.has(modelAsset)) {
    return modelAssetGroupKeyCache.get(modelAsset) ?? null;
  }

  const reason = resolveEditModeModelThinInstanceReason(modelAsset);
  const groupKey = reason ? `${reason}:${createModelAssetTemplateSignature(modelAsset)}` : null;
  modelAssetGroupKeyCache.set(modelAsset, groupKey);
  return groupKey;
}

/** 同一个不可变实体和源 ID 始终返回同一个派生对象，保持 SceneRuntime 增量同步命中。 */
function getOrCreateThinInstanceEntity(entity: Entity, sourceEntityId: string): Entity {
  const cachedBySource = thinInstanceEntityCache.get(entity) ?? new Map<string, Entity>();
  const cached = cachedBySource.get(sourceEntityId);
  if (cached) return cached;

  const derivedEntity: Entity = {
    ...entity,
    components: {
      ...entity.components,
      modelArrayInstance: { sourceEntityId },
    },
  };
  cachedBySource.set(sourceEntityId, derivedEntity);
  thinInstanceEntityCache.set(entity, cachedBySource);
  return derivedEntity;
}

/** 资产编号是实例身份，不参与几何/材质分组；其它模板字段必须完全一致。 */
function createModelAssetTemplateSignature(modelAsset: ModelAssetComponent): string {
  const template: Record<string, unknown> = {};
  for (const key of Object.keys(modelAsset).sort()) {
    if (key === 'assetCode') continue;
    const value = modelAsset[key as keyof ModelAssetComponent];
    if (value !== undefined) template[key] = value;
  }
  return stableSerialize(template);
}

/** 对 JSON 兼容值递归排序对象键，避免仅属性插入顺序不同导致错误拆组。 */
function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(',')}]`;
  }

  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .sort()
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`);
  return `{${entries.join(',')}}`;
}

/** 脚本文件名必须和已核对的模型包主文件同时匹配，避免仅靠伪装文件名误入合批。 */
function isVerifiedParametricScript(
  modelAsset: ModelAssetComponent,
  scriptAsset: NonNullable<ModelAssetComponent['scriptAssets']>[number],
): boolean {
  const scriptFileNames = [scriptAsset.name, scriptAsset.path, scriptAsset.sourceUrl]
    .map(readResourceFileName)
    .filter(Boolean);
  const scriptFileName = scriptFileNames.find((fileName) => (
    EDIT_MODE_THIN_INSTANCE_MODEL_FILES_BY_SCRIPT.has(fileName)
  ));
  if (!scriptFileName) return false;
  if (scriptFileNames.some((fileName) => fileName.endsWith('.ts') && fileName !== scriptFileName)) return false;

  const allowedModelFiles = EDIT_MODE_THIN_INSTANCE_MODEL_FILES_BY_SCRIPT.get(scriptFileName);
  return [modelAsset.sourcePath, modelAsset.sourceUrl]
    .map(readResourceFileName)
    .some((modelFileName) => allowedModelFiles?.has(modelFileName));
}

/** 从普通路径、Windows 路径或 editor-asset URL 中提取小写文件名。 */
function readResourceFileName(value: string): string {
  let normalized = value.trim();
  try {
    normalized = decodeURIComponent(normalized);
  } catch {
    // 非法百分号按原字符串继续处理，最终只会安全地判为不支持。
  }
  normalized = normalized.replace(/\\/g, '/').split(/[?#]/, 1)[0].toLowerCase();
  return normalized.slice(normalized.lastIndexOf('/') + 1);
}
