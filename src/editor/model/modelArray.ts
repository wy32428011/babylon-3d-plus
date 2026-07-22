import type { Entity } from './Entity';
import type { Vector3Data } from './math';
import type { SceneDocument } from './SceneDocument';
import { createArrayAssetNumber, type ArrayAssetNumberResult } from './arrayAssetNumbering';

export const MODEL_ARRAY_COPY_COUNT_MAX = 100;
export const MODEL_ARRAY_MIN_SPAN_METERS = 1e-6;
export const ENTITY_NAME_MAX_LENGTH = 80;

export type ModelArrayIdentityResult =
  | { ok: true; name: string; assetCode: string }
  | { ok: false; error: string };

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
 * 生成导入模型阵列副本的同步名称与资产编号。
 * 自定义规则或默认递增结果会同时写入 entity.name 与 modelAsset.assetCode。
 */
export function createModelArrayIdentity(
  sourceAssetCode: string,
  copyIndex: number,
  assetNumberRule: string,
): ModelArrayIdentityResult {
  const result: ArrayAssetNumberResult = createArrayAssetNumber(sourceAssetCode, copyIndex, assetNumberRule);
  if (!result.ok) return result;
  if (result.value.length > ENTITY_NAME_MAX_LENGTH) {
    return { ok: false, error: `生成后的模型名称不能超过 ${ENTITY_NAME_MAX_LENGTH} 个字符。` };
  }

  return { ok: true, name: result.value, assetCode: result.value };
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
 * 校验阵列将生成的模型名称和资产编号。
 * 导入模型名称与 assetCode 使用同一个递增结果；任何已占用值都会阻止确认。
 */
export function getEntityArrayIdentifierError(
  scene: SceneDocument,
  sourceIds: string[],
  copyCount: number,
  assetNumberRule: string,
): string | null {
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

  const occupiedNames = new Set(Object.values(scene.entities).map((entity) => entity.name));
  const occupiedAssetNumbers = new Set(
    Object.values(scene.entities)
      .map(getArrayAssetNumberTarget)
      .map((target) => target?.value.trim() ?? '')
      .filter(Boolean),
  );

  for (let copyIndex = 1; copyIndex <= normalizedCopyCount; copyIndex += 1) {
    for (const source of sources) {
      const assetNumberTarget = getArrayAssetNumberTarget(source);
      if (source.components.modelAsset) {
        const sourceAssetCode = source.components.modelAsset.assetCode.trim();
        if (!sourceAssetCode) return `模型“${source.name}”的资产编号为空，无法生成同步名称。`;

        const identity = createModelArrayIdentity(sourceAssetCode, copyIndex, normalizedRule);
        if (!identity.ok) return identity.error;
        if (occupiedNames.has(identity.name)) {
          return `模型名称“${identity.name}”已存在，请修改源资产编号或冲突对象。`;
        }
        if (occupiedAssetNumbers.has(identity.assetCode)) {
          return `资产编号“${identity.assetCode}”已存在，请修改编号规则或冲突对象。`;
        }

        occupiedNames.add(identity.name);
        occupiedAssetNumbers.add(identity.assetCode);
        continue;
      }

      if (assetNumberTarget) {
        const result = createArrayAssetNumber(assetNumberTarget.value, copyIndex, normalizedRule);
        if (!result.ok) return result.error;
        if (occupiedAssetNumbers.has(result.value)) {
          return `资产编号“${result.value}”已存在，请修改编号规则或冲突对象。`;
        }
        occupiedAssetNumbers.add(result.value);
      }
    }
  }

  return null;
}
