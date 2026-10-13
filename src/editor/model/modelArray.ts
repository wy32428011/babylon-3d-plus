import type { Entity } from './Entity';
import type { Vector3Data } from './math';
import type { SceneDocument } from './SceneDocument';
import { createArrayAssetNumber, type ArrayAssetNumberResult } from './arrayAssetNumbering';

export const MODEL_ARRAY_COPY_COUNT_MAX = 1000;
export const COMPOSITION_ARRAY_ENTITY_COUNT_MAX = 10_000;
/** 单个源模型可关联的矩阵阵列实体上限；同时作为旧版隐藏阵列项迁移保护。 */
export const MODEL_ARRAY_ITEM_COUNT_MAX = 100_000;
export const MODEL_ARRAY_MIN_SPAN_METERS = 1e-6;
export const ENTITY_NAME_MAX_LENGTH = 80;

export type ShiftEntityArrayKind = 'model' | 'mesh' | 'locator' | 'cad-reference' | 'poi' | 'composition';
export type ShiftEntityArrayIdentityBehavior = 'asset-number' | 'name-only';

/** 返回实体可参与 Shift+Gizmo 阵列的运行时类型；组合根可参与；普通文件夹、灯光和模型生成器排除。 */
export function getShiftEntityArrayKind(entity: Entity | null | undefined): ShiftEntityArrayKind | null {
  if (entity?.isFolder && entity.composition) return 'composition';
  if (!entity || entity.isFolder || entity.components.modelGenerator || entity.components.light) return null;
  if (entity.components.modelAsset) return 'model';
  if (entity.components.meshRenderer) return 'mesh';
  if (entity.components.locator) return 'locator';
  if (entity.components.cadReference) return 'cad-reference';
  if (entity.components.poiEffect) return 'poi';
  return null;
}

/** 判断实体是否属于当前支持 Shift 单轴阵列的场景对象。 */
export function isShiftEntityArraySupported(entity: Entity | null | undefined): boolean {
  return getShiftEntityArrayKind(entity) !== null;
}

/** 返回 Shift 阵列弹框应采用的名称和资产编号行为。 */
export function getShiftEntityArrayIdentityBehavior(
  entity: Entity | null | undefined,
): ShiftEntityArrayIdentityBehavior | null {
  const kind = getShiftEntityArrayKind(entity);
  if (kind === 'model' || kind === 'locator') return 'asset-number';
  return kind ? 'name-only' : null;
}

export type EntityArrayNameResult =
  | { ok: true; name: string }
  | { ok: false; error: string };

export type ModelArrayIdentityResult =
  | { ok: true; name: string; assetCode: string }
  | { ok: false; error: string };

const ENTITY_ARRAY_NAME_TRAILING_DECIMAL_PATTERN = /^(.*?)(\d+)$/;

/**
 * 根据源实体名称生成阵列副本名称。
 * 末尾有数字时递增并保留前导零；只有字符串时直接追加从 1 开始的序号。
 */
export function createEntityArrayName(sourceName: string, copyIndex: number): EntityArrayNameResult {
  if (!Number.isSafeInteger(copyIndex) || copyIndex < 1) {
    return { ok: false, error: '阵列副本序号必须是从 1 开始的安全整数。' };
  }

  const normalizedSourceName = sourceName.trim() || '对象';
  const trailingNumberMatch = normalizedSourceName.match(ENTITY_ARRAY_NAME_TRAILING_DECIMAL_PATTERN);
  let name: string;
  if (trailingNumberMatch) {
    const trailingNumber = trailingNumberMatch[2];
    const seed = Number(trailingNumber);
    if (!Number.isSafeInteger(seed)) {
      return { ok: false, error: '源对象名称末尾数字必须是安全整数。' };
    }

    const nextSeed = seed + copyIndex;
    if (!Number.isSafeInteger(nextSeed)) {
      return { ok: false, error: '源对象名称末尾数字递增后超过安全整数范围。' };
    }
    name = trailingNumberMatch[1] + String(nextSeed).padStart(trailingNumber.length, '0');
  } else {
    name = normalizedSourceName + String(copyIndex);
  }

  if (name.length > ENTITY_NAME_MAX_LENGTH) {
    return { ok: false, error: `生成后的对象名称不能超过 ${ENTITY_NAME_MAX_LENGTH} 个字符。` };
  }
  return { ok: true, name };
}

/** 校验阵列副本数量和净间距，供共享弹框与原子提交复用。 */
export function getEntityArrayParameterError(copyCount: number, spacingMeters: number): string | null {
  if (!Number.isInteger(copyCount) || copyCount < 1 || copyCount > MODEL_ARRAY_COPY_COUNT_MAX) {
    return `副本数量必须是 1-${MODEL_ARRAY_COPY_COUNT_MAX} 的整数。`;
  }
  if (!Number.isFinite(spacingMeters) || spacingMeters < 0) {
    return '阵列净间距必须是大于等于 0 的有限数值。';
  }
  return null;
}

/** 将任意有限非零方向归一化为世界坐标单位向量。 */
export function normalizeModelArrayDirection(direction: Vector3Data): Vector3Data | null {
  if (!Number.isFinite(direction.x) || !Number.isFinite(direction.y) || !Number.isFinite(direction.z)) {
    return null;
  }

  const length = Math.hypot(direction.x, direction.y, direction.z);
  if (!Number.isFinite(length) || length <= MODEL_ARRAY_MIN_SPAN_METERS) return null;

  return {
    x: direction.x / length,
    y: direction.y / length,
    z: direction.z / length,
  };
}

/**
 * 将轴向拖动距离换算为带方向的副本数量。
 * 使用绝对值四舍五入，避免 JavaScript Math.round 对负数半值的不对称行为。
 */
export function calculateModelArraySignedCopyCount(
  projectedDistanceMeters: number,
  spanMeters: number,
  maximumCopyCount = MODEL_ARRAY_COPY_COUNT_MAX,
): number {
  if (
    !Number.isFinite(projectedDistanceMeters)
    || !Number.isFinite(spanMeters)
    || spanMeters <= MODEL_ARRAY_MIN_SPAN_METERS
  ) {
    return 0;
  }

  const normalizedMaximum = Math.max(0, Math.floor(maximumCopyCount));
  const magnitude = Math.min(
    normalizedMaximum,
    Math.round(Math.abs(projectedDistanceMeters) / spanMeters),
  );
  if (magnitude === 0) return 0;

  return projectedDistanceMeters < 0 ? -magnitude : magnitude;
}

/**
 * 分别根据源实体名称和模型资产编号生成导入模型阵列身份。
 * 自定义规则只影响 assetCode，副本名称始终按源实体名称递增。
 */
export function createModelArrayIdentity(
  sourceName: string,
  sourceAssetCode: string,
  copyIndex: number,
  assetNumberRule: string,
): ModelArrayIdentityResult {
  const nameResult = createEntityArrayName(sourceName, copyIndex);
  if (!nameResult.ok) return nameResult;

  const normalizedAssetCode = sourceAssetCode.trim();
  if (!normalizedAssetCode) return { ok: false, error: '模型资产编号为空，无法生成阵列编号。' };
  const assetCodeResult: ArrayAssetNumberResult = createArrayAssetNumber(
    normalizedAssetCode,
    copyIndex,
    assetNumberRule,
  );
  if (!assetCodeResult.ok) return assetCodeResult;

  return { ok: true, name: nameResult.name, assetCode: assetCodeResult.value };
}


/** 返回组合阵列完整范围；锁定、失效结构、混选和数量超限均原子拒绝。 */
export function getCompositionArrayInfo(scene: SceneDocument, sourceIds: string[], copyCount: number): { entityIds: string[]; createdEntityCount: number; error: string | null } | null {
  const ids = [...new Set(sourceIds)];
  if (!ids.some(id => scene.entities[id]?.composition)) return null;
  const entityIds: string[] = [];
  const result = (error: string | null) => ({ entityIds, createdEntityCount: entityIds.length * copyCount, error });
  const root = scene.entities[ids[0]];
  if (ids.length !== 1 || !root?.isFolder || !root.composition) return result('组合阵列仅支持单个组合根节点，不能混选。');
  const included = new Set<string>();
  const stack = [root.id];
  while (stack.length) {
    const id = stack.pop()!;
    const entity = scene.entities[id];
    if (!entity || included.has(id)) return result('组合成员结构已失效。');
    included.add(id); entityIds.push(id);
    for (const childId of entity.childrenIds) {
      if (!entity.isFolder || scene.entities[childId]?.parentId !== id) return result('组合成员结构已失效。');
      stack.push(childId);
    }
  }
  for (const entity of Object.values(scene.entities)) {
    const hostId = entity.components.locator?.builtInBinding?.hostEntityId;
    if (hostId && included.has(hostId) && !included.has(entity.id)) { included.add(entity.id); entityIds.push(entity.id); }
    if (entity.parentId && included.has(entity.parentId) && !included.has(entity.id)) return result('组合成员结构已失效。');
  }
  for (const id of entityIds) {
    // 旧隐藏项需先经反序列化展开，避免低估数量或漏算几何跨度。
    if (scene.entities[id].components.modelArray?.items.length) {
      return result('组合内存在旧版隐藏阵列，请保存并重新打开场景后再阵列。');
    }
    const ancestors = new Set<string>();
    let current: Entity | undefined = scene.entities[id];
    while (current) {
      if (ancestors.has(current.id)) return result('组合祖先结构已失效。');
      ancestors.add(current.id);
      if (current.locked) return result('组合根、祖先或成员已锁定，不能阵列。');
      if (!current.parentId) break;
      const parent: Entity | undefined = scene.entities[current.parentId];
      if (!parent?.isFolder || !parent.childrenIds.includes(current.id)) return result('组合成员或祖先结构已失效。');
      current = parent;
    }
    const hostId = scene.entities[id].components.locator?.builtInBinding?.hostEntityId;
    if (hostId && !scene.entities[hostId]?.components.modelAsset) return result('内置货格宿主已失效。');
    const renderIds = new Set<string>();
    let render: Entity | undefined = scene.entities[id];
    while (render?.components.modelArrayInstance) {
      if (renderIds.has(render.id)) return result('组合模型阵列源结构已失效。');
      renderIds.add(render.id);
      render = scene.entities[render.components.modelArrayInstance.sourceEntityId];
      if (!render?.components.modelAsset) return result('组合模型阵列源已失效。');
    }
  }
  const parameterError = getEntityArrayParameterError(copyCount, 0);
  if (parameterError) return result(parameterError);
  if (entityIds.length * copyCount > COMPOSITION_ARRAY_ENTITY_COUNT_MAX) return result('单次新增实体不能超过 10000 个。');
  if (!entityIds.some(id => !scene.entities[id].isFolder)) return result('组合没有可阵列的成员。');
  return result(null);
}

type ArrayAssetNumberTarget = {
  value: string;
};

/** 读取实体可参与阵列校验的资产编号。 */
function getArrayAssetNumberTarget(entity: Entity): ArrayAssetNumberTarget | null {
  if (entity.components.modelAsset) return { value: entity.components.modelAsset.assetCode };
  if (entity.components.locator) return { value: entity.components.locator.assetId };
  return null;
}

/**
 * 校验阵列将生成的对象名称和资产编号。
 * 名称始终按源实体名称递增，资产编号按各自源编号或一次性规则生成。
 */
export function getEntityArrayIdentifierError(
  scene: SceneDocument,
  sourceIds: string[],
  copyCount: number,
  assetNumberRule: string,
): string | null {
  const compositionInfo = getCompositionArrayInfo(scene, sourceIds, copyCount);
  if (compositionInfo) {
    if (compositionInfo.error) return compositionInfo.error;
    if (assetNumberRule.trim()) return '组合内部成员自动生成新编号，不支持自定义资产编号规则。';
    const names = new Set(Object.values(scene.entities).flatMap(entity => [entity.name, ...(entity.components.modelArray?.items.map(item => item.name) ?? [])]));
    for (let index = 1; index <= copyCount; index++) {
      const name = createEntityArrayName(scene.entities[sourceIds[0]].name, index);
      if (!name.ok) return name.error;
      if (names.has(name.name)) return '对象名称“' + name.name + '”已存在，请修改源对象名称或冲突对象。';
      names.add(name.name);
    }
    return null;
  }
  const normalizedRule = assetNumberRule.trim();
  const normalizedCopyCount = Math.min(
    MODEL_ARRAY_COPY_COUNT_MAX,
    Math.max(1, Math.floor(Number.isFinite(copyCount) ? copyCount : 1)),
  );
  const uniqueSourceIds = [...new Set(sourceIds)];
  const sources = uniqueSourceIds
    .map((sourceId) => scene.entities[sourceId])
    .filter((entity): entity is Entity => Boolean(entity && !entity.isFolder));
  if (sources.length !== uniqueSourceIds.length) return '阵列源对象已失效。';

  const assetNumberedSourceCount = sources.filter((source) => getArrayAssetNumberTarget(source) !== null).length;
  if (normalizedRule && assetNumberedSourceCount !== 1) {
    return '自定义资产编号规则仅支持一个带资产编号的源对象。';
  }

  const occupiedNames = new Set<string>();
  const occupiedAssetNumbers = new Set<string>();
  for (const entity of Object.values(scene.entities)) {
    occupiedNames.add(entity.name);
    const assetNumber = getArrayAssetNumberTarget(entity)?.value.trim();
    if (assetNumber) occupiedAssetNumbers.add(assetNumber);

    for (const item of entity.components.modelArray?.items ?? []) {
      occupiedNames.add(item.name);
      const itemAssetCode = item.assetCode.trim();
      if (itemAssetCode) occupiedAssetNumbers.add(itemAssetCode);
    }
  }

  for (let copyIndex = 1; copyIndex <= normalizedCopyCount; copyIndex += 1) {
    for (const source of sources) {
      const nameResult = createEntityArrayName(source.name, copyIndex);
      if (!nameResult.ok) return nameResult.error;
      if (occupiedNames.has(nameResult.name)) {
        return `对象名称“${nameResult.name}”已存在，请修改源对象名称或冲突对象。`;
      }
      occupiedNames.add(nameResult.name);

      const assetNumberTarget = getArrayAssetNumberTarget(source);
      if (!assetNumberTarget) continue;
      if (source.components.modelAsset && !assetNumberTarget.value.trim()) {
        return `模型“${source.name}”的资产编号为空，无法生成阵列编号。`;
      }

      const result = createArrayAssetNumber(assetNumberTarget.value, copyIndex, normalizedRule);
      if (!result.ok) return result.error;
      if (occupiedAssetNumbers.has(result.value)) {
        return `资产编号“${result.value}”已存在，请修改编号规则或冲突对象。`;
      }
      occupiedAssetNumbers.add(result.value);
    }
  }

  return null;
}
