import { collectAlarmIndependentEntityIds } from './alarmManager';
import type { Entity } from './Entity';
import { createEntityHierarchyStateMap, type EntityHierarchyState } from './entityHierarchy';
import type { ModelAssetComponent } from './components';
import type { SceneDocument } from './SceneDocument';
import { hasModelDataDrivenMotionKey } from './telemetryBinding';

const EDIT_MODE_THIN_INSTANCE_MODEL_FILES_BY_SCRIPT = new Map<string, ReadonlySet<string>>([
  ['box.model.ts', new Set(['box.glb', 'box.gltf'])],
  ['chain-conveyor.model.ts', new Set(['链条机.glb', '链条机.gltf'])],
  ['newchain-conveyor.model.ts', new Set(['链条机新.glb', '链条机新.gltf'])],
  ['gd-motor-optimized.model.ts', new Set([
    'gd_有电机_optimized(1).glb',
    'gd_有电机_optimized(1).gltf',
    'gd_有电机_optimized.glb',
    'gd_有电机_optimized.gltf',
  ])],
  ['hcts.model.ts', new Set(['hcts.glb', 'hcts.gltf'])],
  ['shelf.model.ts', new Set(['shelf.glb', 'shelf.gltf'])],
  ['wlts.model.ts', new Set(['wlts.glb', 'wlts.gltf'])],
  ['yzj.model.ts', new Set(['yzj.glb', 'yzj.gltf'])],
]);

/** SceneDocument 采用不可变对象更新；复用未变化模板和实体的派生结果，避免 Gizmo 拖动时重复扫描大段脚本元数据。 */
const modelAssetGroupKeyCache = new WeakMap<ModelAssetComponent, string | null>();
const thinInstanceEntityCache = new WeakMap<Entity, Map<string, Entity>>();
const independentModelEntityCache = new WeakMap<Entity, Entity>();

type EntityOverrideRecordState = {
  base: SceneDocument['entities'];
  overrides: ReadonlyMap<string, Entity>;
};

/** 参数连续预览只覆盖少量实体；使用稀疏代理避免每次输入都复制 10k/50k entities 索引。 */
const entityOverrideRecordState = new WeakMap<SceneDocument['entities'], EntityOverrideRecordState>();

export type EditModeModelThinInstanceReason = 'no-external-script' | 'verified-parametric-script';

export type EditModeModelThinInstancePlan = {
  entities: SceneDocument['entities'];
  groupCount: number;
  sourceEntityIds: string[];
  thinInstanceEntityCount: number;
};

/**
 * 为保存、发布和离线导出生成稳定合批快照。
 * 只追加或归一 modelArrayInstance 关系，不修改参数、脚本、动画或其它逻辑实体字段。
 */
export function createPersistedModelThinInstanceScene(scene: SceneDocument): SceneDocument {
  const plan = createEditModeModelThinInstancePlan(scene);
  return plan.entities === scene.entities ? scene : { ...scene, entities: plan.entities };
}

/**
 * 编辑态只需要呈现参数化后的静态外观；运行预览仍必须为每个设备保留独立脚本和遥测状态。
 * 因此这里只允许 dataDriven 未声明 motion 的无外置脚本模型，
 * 或已经核对过编辑态行为的参数化脚本进入自动 thinInstance 分组。
 */
export function resolveEditModeModelThinInstanceReason(
  modelAsset: ModelAssetComponent,
): EditModeModelThinInstanceReason | null {
  if (hasModelDataDrivenMotionKey(modelAsset.dataDrivenConfig)) return null;

  const scriptAssets = modelAsset.scriptAssets ?? [];
  if (scriptAssets.length === 0) return 'no-external-script';

  return scriptAssets.every((scriptAsset) => isVerifiedParametricScript(modelAsset, scriptAsset))
    ? 'verified-parametric-script'
    : null;
}

/**
 * 识别 Store 两次原子发布之间唯一的模型参数值变化。
 * 参数编辑动作会保留场景其它顶层引用和选中实体的其它组件引用；
 * 其余实体只做引用比较，确认没有内置货格这类随参数同次原子更新的派生实体后才允许走单实体同步。
 */
export function resolveModelParameterOnlySceneChangeEntityId(
  previousScene: SceneDocument | null | undefined,
  nextScene: SceneDocument,
): string | null {
  if (
    !previousScene
    || previousScene === nextScene
    || previousScene.entities === nextScene.entities
    || previousScene.entityIds !== nextScene.entityIds
    || previousScene.id !== nextScene.id
    || previousScene.name !== nextScene.name
    || previousScene.selectedEntityId !== nextScene.selectedEntityId
    || previousScene.mqttConfig !== nextScene.mqttConfig
    || previousScene.sceneSettings !== nextScene.sceneSettings
    || previousScene.fetchConfig !== nextScene.fetchConfig
  ) {
    return null;
  }

  const entityId = nextScene.selectedEntityId;
  if (!entityId) return null;
  const previousEntity = previousScene.entities[entityId];
  const nextEntity = nextScene.entities[entityId];
  if (!isModelParameterOnlyEntityChange(previousEntity, nextEntity)) return null;

  // 内置货格维度会随宿主参数在同一次原子更新中改写；存在任何其它实体变化即放弃单实体快路径，退回完整同步。
  for (const otherEntityId of nextScene.entityIds) {
    if (otherEntityId !== entityId && previousScene.entities[otherEntityId] !== nextScene.entities[otherEntityId]) {
      return null;
    }
  }
  return entityId;
}

/**
 * 参数值由 SceneRuntime 的参数变体承载，不改变编辑态源/实例拓扑。
 * 只创建一个稀疏实体覆盖，避免高频预览重新扫描和复制完整场景实体表。
 */
export function patchEditModeModelThinInstancePlanForModelParameters(
  scene: Pick<SceneDocument, 'entityIds' | 'entities'>,
  previousPlan: EditModeModelThinInstancePlan,
  entityId: string,
): EditModeModelThinInstancePlan {
  const entity = scene.entities[entityId];
  const previousEntity = previousPlan.entities[entityId];
  if (!entity || !previousEntity) {
    return createEditModeModelThinInstancePlan(scene, previousPlan);
  }

  const sourceEntityId = previousEntity.components.modelArrayInstance?.sourceEntityId;
  const nextEntity = sourceEntityId
    ? getOrCreateThinInstanceEntity(entity, sourceEntityId)
    : entity;
  if (previousEntity === nextEntity) return previousPlan;

  return {
    ...previousPlan,
    entities: createEntityOverrideRecord(previousPlan.entities, entityId, nextEntity),
  };
}

/**
 * 为 Scene View 和持久化序列化构造不修改输入文档的实体覆盖层。
 * 重复模型追加 modelArrayInstance，已有多阵列源也会归一到同一个直接渲染源。
 */
export function createEditModeModelThinInstancePlan(
  scene: Pick<SceneDocument, 'entityIds' | 'entities'>,
  previousPlan?: EditModeModelThinInstancePlan,
): EditModeModelThinInstancePlan {
  const referencedSourceIds = collectReferencedModelArraySourceIds(scene);
  const hierarchyStateByEntityId = createEntityHierarchyStateMap(scene.entityIds, scene.entities);
  const builtInSlotHostIds = collectBuiltInSlotHostIds(scene);
  const alarmIndependentIds = collectAlarmIndependentEntityIds(scene);
  const motionExcludedModelArrayEntityIds = new Set([...collectMotionExcludedModelArrayEntityIds(scene), ...alarmIndependentIds]);
  const groups = new Map<string, Entity[]>();

  for (const entityId of scene.entityIds) {
    const entity = scene.entities[entityId];
    const modelAsset = entity?.components.modelAsset;
    if (
      !entity
      || !modelAsset
      || entity.components.modelArrayInstance
      || entity.childrenIds.length > 0
      || alarmIndependentIds.has(entityId)
      || builtInSlotHostIds.has(entityId)
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

    const source = chooseGroupSource(group, referencedSourceIds, hierarchyStateByEntityId);
    let convertedInGroup = 0;

    for (const entity of group) {
      // 反序列化通常会先迁移旧 modelArray.items；若调用方仍传入旧内存结构，
      // 必须保留该真实源，否则挂在源上的隐藏阵列项会随源降级而丢失。
      if (entity.id === source.id || entity.components.modelArray) continue;
      sourceEntityIdByEntityId.set(entity.id, source.id);
      convertedInGroup += 1;
    }

    if (convertedInGroup === 0) continue;
    groupCount += 1;
    thinInstanceEntityCount += convertedInGroup;
    sourceEntityIds.push(source.id);
  }

  const desiredSourceEntityIdByEntityId = collectRemappedModelArraySources(
    scene,
    sourceEntityIdByEntityId,
    motionExcludedModelArrayEntityIds,
  );

  return {
    entities: materializeThinInstanceEntities(scene, desiredSourceEntityIdByEntityId, previousPlan),
    groupCount,
    sourceEntityIds,
    thinInstanceEntityCount,
  };
}

/**
 * 在上一次覆盖层上只替换真正变化的实体。
 * Gizmo 每帧通常只产生一个新实体对象，因此无需重新复制大批稳定派生实体。
 */
function materializeThinInstanceEntities(
  scene: Pick<SceneDocument, 'entityIds' | 'entities'>,
  sourceEntityIdByEntityId: ReadonlyMap<string, string | null>,
  previousPlan?: EditModeModelThinInstancePlan,
): SceneDocument['entities'] {
  if (!previousPlan) {
    if (sourceEntityIdByEntityId.size === 0) return scene.entities;
    const entities = { ...scene.entities };
    for (const [entityId, sourceEntityId] of sourceEntityIdByEntityId) {
      const entity = scene.entities[entityId];
      if (entity) {
        entities[entityId] = sourceEntityId
          ? getOrCreateThinInstanceEntity(entity, sourceEntityId)
          : getOrCreateIndependentModelEntity(entity);
      }
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
    const hasSourceOverride = sourceEntityIdByEntityId.has(entityId);
    const sourceEntityId = sourceEntityIdByEntityId.get(entityId);
    const desiredEntity = !hasSourceOverride
      ? entity
      : sourceEntityId
      ? getOrCreateThinInstanceEntity(entity, sourceEntityId)
      : getOrCreateIndependentModelEntity(entity);
    if (entities[entityId] !== desiredEntity) ensureMutable()[entityId] = desiredEntity;
  }

  for (const entityId of Object.keys(entities)) {
    if (scene.entities[entityId]) continue;
    delete ensureMutable()[entityId];
  }

  return entities;
}

/** 内置货格宿主必须保留独立脚本宿主与 contentRoot metadata，不得降级为合批实例或批次源。 */
function collectBuiltInSlotHostIds(
  scene: Pick<SceneDocument, 'entityIds' | 'entities'>,
): ReadonlySet<string> {
  const hostIds = new Set<string>();
  for (const entityId of scene.entityIds) {
    const hostEntityId = scene.entities[entityId]?.components.locator?.builtInBinding?.hostEntityId;
    if (hostEntityId) hostIds.add(hostEntityId);
  }
  return hostIds;
}

/** 收集已有阵列源；同模板分组时优先选择其中一个，减少重映射并保持源选择稳定。 */
function collectReferencedModelArraySourceIds(
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

/**
 * 旧场景可能已经把 motion 模型持久化为 modelArrayInstance。
 * 实例或源任一方声明 motion 时都解除关系，确保首次打开和下一次保存立即恢复独立渲染。
 */
function collectMotionExcludedModelArrayEntityIds(
  scene: Pick<SceneDocument, 'entityIds' | 'entities'>,
): ReadonlySet<string> {
  const entityIds = new Set<string>();
  for (const entityId of scene.entityIds) {
    const entity = scene.entities[entityId];
    const sourceEntityId = entity?.components.modelArrayInstance?.sourceEntityId;
    if (!entity || !sourceEntityId) continue;
    const sourceModelAsset = scene.entities[sourceEntityId]?.components.modelAsset;
    if (
      hasModelDataDrivenMotionKey(entity.components.modelAsset?.dataDrivenConfig)
      || hasModelDataDrivenMotionKey(sourceModelAsset?.dataDrivenConfig)
    ) {
      entityIds.add(entityId);
    }
  }
  return entityIds;
}

/**
 * 把被合并阵列源的已有实例改指向统一源。
 * 只修改返回的派生实体；编辑态和持久化快照共用直接源引用，避免形成链式关系。
 */
function collectRemappedModelArraySources(
  scene: Pick<SceneDocument, 'entityIds' | 'entities'>,
  sourceEntityIdByEntityId: ReadonlyMap<string, string>,
  motionExcludedModelArrayEntityIds: ReadonlySet<string>,
): Map<string, string | null> {
  const desiredSourceEntityIdByEntityId = new Map<string, string | null>(sourceEntityIdByEntityId);

  for (const entityId of motionExcludedModelArrayEntityIds) {
    desiredSourceEntityIdByEntityId.set(entityId, null);
  }

  for (const entityId of scene.entityIds) {
    if (motionExcludedModelArrayEntityIds.has(entityId)) continue;
    const currentSourceEntityId = scene.entities[entityId]?.components.modelArrayInstance?.sourceEntityId;
    if (!currentSourceEntityId) continue;
    const remappedSourceEntityId = sourceEntityIdByEntityId.get(currentSourceEntityId);
    if (remappedSourceEntityId && remappedSourceEntityId !== currentSourceEntityId) {
      desiredSourceEntityIdByEntityId.set(entityId, remappedSourceEntityId);
    }
  }

  return desiredSourceEntityIdByEntityId;
}

/** 优先选择已有阵列源，其次选择当前有效可见实体，避免隐藏源节点连带关闭整个批次。 */
function chooseGroupSource(
  group: readonly Entity[],
  referencedSourceIds: ReadonlySet<string>,
  hierarchyStateByEntityId: ReadonlyMap<string, EntityHierarchyState>,
): Entity {
  const referencedSources = group.filter((entity) => referencedSourceIds.has(entity.id));
  const candidates = referencedSources.length > 0 ? referencedSources : group;
  return candidates.find((entity) => hierarchyStateByEntityId.get(entity.id)?.visible !== false) ?? candidates[0];
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
  if (entity.components.modelArrayInstance?.sourceEntityId === sourceEntityId) return entity;

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

/** 删除派生快照中的合批关系，不修改输入实体及其参数、脚本、动画或其它组件。 */
function getOrCreateIndependentModelEntity(entity: Entity): Entity {
  if (!entity.components.modelArrayInstance) return entity;
  const cached = independentModelEntityCache.get(entity);
  if (cached) return cached;

  const { modelArrayInstance: _modelArrayInstance, ...components } = entity.components;
  const derivedEntity: Entity = {
    ...entity,
    components,
  };
  independentModelEntityCache.set(entity, derivedEntity);
  return derivedEntity;
}

/** 资产编号和参数值属于逻辑实例身份；参数差异由 SceneRuntime 变体承载，不得改变合批拓扑。 */
function createModelAssetTemplateSignature(modelAsset: ModelAssetComponent): string {
  const template: Record<string, unknown> = {};
  for (const key of Object.keys(modelAsset).sort()) {
    if (key === 'assetCode' || key === 'parameterValues') continue;
    const value = modelAsset[key as keyof ModelAssetComponent];
    if (value !== undefined) template[key] = value;
  }
  return stableSerialize(template);
}

/** 创建只覆盖少量实体的完整 Record 视图；Object.keys/展开操作仍保持普通对象语义。 */
function createEntityOverrideRecord(
  entities: SceneDocument['entities'],
  entityId: string,
  entity: Entity,
): SceneDocument['entities'] {
  const previousState = entityOverrideRecordState.get(entities);
  const base = previousState?.base ?? entities;
  const overrides = new Map(previousState?.overrides ?? []);
  overrides.set(entityId, entity);
  const target = Object.create(null) as SceneDocument['entities'];
  const proxy = new Proxy(target, {
    get: (_target, property) => (
      typeof property === 'string' && overrides.has(property)
        ? overrides.get(property)
        : Reflect.get(base, property)
    ),
    has: (_target, property) => (
      typeof property === 'string' && overrides.has(property)
        ? true
        : Reflect.has(base, property)
    ),
    ownKeys: () => {
      const keys = new Set<string | symbol>(Reflect.ownKeys(base));
      for (const key of overrides.keys()) keys.add(key);
      return [...keys];
    },
    getOwnPropertyDescriptor: (_target, property) => {
      if (typeof property === 'string' && overrides.has(property)) {
        return { configurable: true, enumerable: true, writable: false, value: overrides.get(property) };
      }
      const descriptor = Reflect.getOwnPropertyDescriptor(base, property);
      return descriptor ? { ...descriptor, configurable: true } : undefined;
    },
  });
  entityOverrideRecordState.set(proxy, { base, overrides });
  return proxy;
}

/** 参数动作除 modelAsset.parameterValues 外必须保持实体和组件的不可变引用。 */
function isModelParameterOnlyEntityChange(previousEntity: Entity | undefined, nextEntity: Entity | undefined): boolean {
  if (!previousEntity || !nextEntity || previousEntity === nextEntity) return false;
  if (
    previousEntity.id !== nextEntity.id
    || previousEntity.name !== nextEntity.name
    || previousEntity.isFolder !== nextEntity.isFolder
    || previousEntity.visible !== nextEntity.visible
    || previousEntity.locked !== nextEntity.locked
    || previousEntity.parentId !== nextEntity.parentId
    || previousEntity.childrenIds !== nextEntity.childrenIds
  ) {
    return false;
  }

  const previousComponents = previousEntity.components;
  const nextComponents = nextEntity.components;
  const componentKeys = new Set([...Object.keys(previousComponents), ...Object.keys(nextComponents)]);
  for (const key of componentKeys) {
    if (key === 'modelAsset') continue;
    if (
      previousComponents[key as keyof typeof previousComponents]
      !== nextComponents[key as keyof typeof nextComponents]
    ) {
      return false;
    }
  }

  const previousModelAsset = previousComponents.modelAsset;
  const nextModelAsset = nextComponents.modelAsset;
  if (!previousModelAsset || !nextModelAsset || previousModelAsset === nextModelAsset) return false;
  if (previousModelAsset.parameterValues === nextModelAsset.parameterValues) return false;

  const modelAssetKeys = new Set([...Object.keys(previousModelAsset), ...Object.keys(nextModelAsset)]);
  for (const key of modelAssetKeys) {
    if (key === 'parameterValues') continue;
    if (
      previousModelAsset[key as keyof ModelAssetComponent]
      !== nextModelAsset[key as keyof ModelAssetComponent]
    ) {
      return false;
    }
  }
  return true;
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
