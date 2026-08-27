import type { SceneEnvironmentSettings } from './SceneDocument';
import type { Vector3Data } from './math';

export type EnvironmentWorldBounds = {
  minimum: Vector3Data;
  maximum: Vector3Data;
  center: Vector3Data;
  sizeMeters: Vector3Data;
  radiusMeters: number;
};

export type EnvironmentModelStatistics = {
  meshCount: number;
  primitiveCount: number;
  vertexCount: number;
  triangleCount: number;
  materialCount: number;
  textureCount: number;
  fileSizeBytes: number | null;
};

export type EnvironmentRuntimeSnapshot = {
  phase: 'idle' | 'loading' | 'ready' | 'error';
  requestId: string | null;
  sourceUrl: string | null;
  message: string | null;
  bounds: EnvironmentWorldBounds | null;
  statistics: EnvironmentModelStatistics | null;
};

export type EnvironmentApplyRequest = {
  id: string;
  environment: SceneEnvironmentSettings;
  autoAlign: boolean;
  focusAfterLoad: boolean;
  commandLabel: string;
  successMessage: string;
  persistSceneChange: boolean;
  runtimeEnvironment?: SceneEnvironmentSettings;
};

export type EnvironmentApplyResult = {
  environment: SceneEnvironmentSettings;
  snapshot: EnvironmentRuntimeSnapshot;
};

export function createIdleEnvironmentRuntimeSnapshot(): EnvironmentRuntimeSnapshot {
  return {
    phase: 'idle',
    requestId: null,
    sourceUrl: null,
    message: null,
    bounds: null,
    statistics: null,
  };
}

export type ResolveEnvironmentRuntimeSettingsOptions = {
  deferManagedCacheLoad?: boolean;
};

const LOCAL_ASSET_URL_PREFIX = 'editor-asset://local/';
const MANAGED_ENVIRONMENT_CACHE_PATTERN = /(?:^|\/)\.babylon-editor\/data-platform-cache\/environments\/[0-9a-f]{64}\/[1-9]\d{0,63}\/[1-9]\d{0,63}(?:\/|$)/i;

/** 判断环境是否仍引用某个工作区中的数据中台受管缓存。 */
export function hasManagedEnvironmentCacheReference(
  environment: SceneEnvironmentSettings | null,
): boolean {
  if (!environment) return false;
  const references = [
    environment.packagePath,
    environment.activeVariantUrl,
    environment.thumbnailUrl,
    ...environment.variants.flatMap((variant) => [variant.sourcePath, variant.sourceUrl]),
  ];
  return references.some((reference) => {
    if (!reference) return false;
    let normalized = reference.trim();
    if (normalized.startsWith(LOCAL_ASSET_URL_PREFIX)) {
      try {
        normalized = decodeURIComponent(new URL(normalized).pathname.slice(1));
      } catch {
        return false;
      }
    }
    return MANAGED_ENVIRONMENT_CACHE_PATTERN.test(normalized.replace(/\\/g, '/'));
  });
}

/**
 * 数据中台环境缓存刷新只替换运行时资源来源；摆放、显隐和单位仍以场景文档为准。
 * 同源资源允许跟随 revision 更新；跨数据源时仍要求 revision 一致，避免误用同 ID 的其他资源。
 */
export function resolveEnvironmentRuntimeSettings(
  sceneEnvironment: SceneEnvironmentSettings | null,
  runtimeOverride: SceneEnvironmentSettings | null,
  options: ResolveEnvironmentRuntimeSettingsOptions = {},
): SceneEnvironmentSettings | null {
  if (!sceneEnvironment) return null;
  if (options.deferManagedCacheLoad && hasManagedEnvironmentCacheReference(sceneEnvironment)) return null;
  if (!runtimeOverride) return sceneEnvironment;
  const hasSameResourceId = Boolean(
    sceneEnvironment.dataPlatformResourceId
    && sceneEnvironment.dataPlatformResourceId === runtimeOverride.dataPlatformResourceId,
  );
  const hasSameSourceKey = Boolean(
    sceneEnvironment.dataPlatformSourceKey
    && sceneEnvironment.dataPlatformSourceKey === runtimeOverride.dataPlatformSourceKey,
  );
  const hasSameRevision = Boolean(
    sceneEnvironment.dataPlatformRevision
    && sceneEnvironment.dataPlatformRevision === runtimeOverride.dataPlatformRevision,
  );
  if (
    sceneEnvironment.source !== 'data-platform'
    || runtimeOverride.source !== 'data-platform'
    || !hasSameResourceId
    || (!hasSameSourceKey && !hasSameRevision)
  ) return sceneEnvironment;

  const activeVariantIndex = sceneEnvironment.variants.findIndex(
    (variant) => variant.sourceUrl === sceneEnvironment.activeVariantUrl,
  );
  const activeVariant = sceneEnvironment.variants[activeVariantIndex];
  const exactRuntimeVariant = activeVariant
    ? runtimeOverride.variants.find((variant) => variant.sourceUrl === activeVariant.sourceUrl)
    : undefined;
  const namedRuntimeVariants = activeVariant
    ? runtimeOverride.variants.filter((variant) => variant.name === activeVariant.name)
    : [];
  const runtimeVariant = exactRuntimeVariant
    ?? (namedRuntimeVariants.length === 1 ? namedRuntimeVariants[0] : undefined)
    ?? (activeVariantIndex >= 0 ? runtimeOverride.variants[activeVariantIndex] : undefined);

  return {
    ...runtimeOverride,
    lengthUnit: sceneEnvironment.lengthUnit,
    unitScaleToMeters: sceneEnvironment.unitScaleToMeters,
    placementMode: sceneEnvironment.placementMode,
    transform: sceneEnvironment.transform,
    visible: sceneEnvironment.visible,
    opacity: sceneEnvironment.opacity,
    activeVariantUrl: runtimeVariant?.sourceUrl ?? runtimeOverride.activeVariantUrl,
  };
}
