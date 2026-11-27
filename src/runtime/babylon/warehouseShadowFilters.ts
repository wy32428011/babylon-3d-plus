import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import type { AbstractMesh } from '@babylonjs/core';
import type { SceneLightingConfig } from '../../../electron/shared/sceneLightingConfig.ts';
import type { EntityLightingSettings } from '../../../electron/shared/sceneLightingBakeContract.ts';
import type { LightingRuntimeSource } from './lightingClassificationRuntime.ts';

const MOBILE_EQUIPMENT_EXACT_TYPES = new Set([
  'agv',
  'rgv',
  'rgv_nl',
  'shuttle',
  'forklift',
  'stacker',
  'lift',
  'hclift',
]);

export function isMobileEquipmentDeviceType(deviceType?: string | null): boolean {
  if (!deviceType) return false;
  const normalized = deviceType.trim().toLowerCase();
  return MOBILE_EQUIPMENT_EXACT_TYPES.has(normalized) || normalized.startsWith('agv_');
}

export function isEnvironmentShadowReceiverSource(source: LightingRuntimeSource): boolean {
  if (source.entry.entityId === '$environment' || source.entry.deviceType === 'environment') return true;
  const metadata = source.mesh.metadata as Record<string, unknown> | null | undefined;
  return metadata?.editorEnvironmentMesh === true || metadata?.editorShadowReceiver === true;
}

export function isGeneratedCargoSource(source: LightingRuntimeSource): boolean {
  const metadata = source.mesh.metadata as Record<string, unknown> | null | undefined;
  if (metadata?.generatedCargo === true || metadata?.modelGeneratorCargo === true) return true;
  if (source.entry.deviceType?.trim().toLowerCase() === 'cargo') return true;
  if (metadata?.deviceSpawnerSpawned === true) return false;
  const ownerId = source.entry.policyContext?.ownerEntityId;
  return Boolean(
    source.entry.parentDynamic
    && ownerId
    && source.entry.entityId !== ownerId
    && !isMobileEquipmentDeviceType(source.entry.deviceType),
  );
}

function getSourceMaxWorldDimension(source: LightingRuntimeSource): number | null {
  const target: AbstractMesh = source.logicalMesh ?? source.mesh;
  if (target.isDisposed?.()) return null;
  const boundingBox = target.getBoundingInfo?.()?.boundingBox;
  if (!boundingBox) return null;
  const localHalf = boundingBox.extendSize;
  const matrix = source.getWorldMatrix();
  if (localHalf && matrix) {
    const m = matrix.m;
    const sx = Math.hypot(m[0], m[1], m[2]);
    const sy = Math.hypot(m[4], m[5], m[6]);
    const sz = Math.hypot(m[8], m[9], m[10]);
    const maxDim = Math.max(localHalf.x * 2 * sx, localHalf.y * 2 * sy, localHalf.z * 2 * sz);
    return Number.isFinite(maxDim) ? maxDim : null;
  }
  const worldHalf: Vector3 | undefined = boundingBox.extendSizeWorld;
  if (!worldHalf) return null;
  const maxDim = Math.max(worldHalf.x, worldHalf.y, worldHalf.z) * 2;
  return Number.isFinite(maxDim) ? maxDim : null;
}

function readExplicitEntityShadowOverride(
  source: LightingRuntimeSource,
  field: 'castShadows' | 'receiveShadows',
): boolean | undefined {
  const fieldSource = source.entry.fieldSources?.[field];
  if (fieldSource && (fieldSource.kind === 'entity' || fieldSource.kind === 'node-override')) {
    return typeof fieldSource.value === 'boolean' ? fieldSource.value : undefined;
  }
  const entityLighting = source.entry.policyContext?.entityLighting as Partial<EntityLightingSettings> | undefined;
  if (!entityLighting || typeof entityLighting !== 'object') return undefined;
  const nodeKey = source.entry.policyContext?.partKey ?? source.entry.nodeKey;
  const nodeOverride = nodeKey ? entityLighting.nodeOverrides?.[nodeKey] : undefined;
  if (nodeOverride && typeof nodeOverride[field] === 'boolean' && !nodeOverride.inheritPolicy?.includes(field)) {
    return nodeOverride[field];
  }
  if (typeof entityLighting[field] === 'boolean' && !entityLighting.inheritPolicy?.includes(field)) {
    return entityLighting[field];
  }
  return undefined;
}

/**
 * 在全场景自动阴影模式下应用仓储性能分层与实体显式覆盖。
 * 当仓储过滤可选项均未启用时，与原有全自动阴影角色保持完全一致。
 */
export function resolveAutomaticShadowRole(
  source: LightingRuntimeSource,
  shadows: SceneLightingConfig['shadows'],
): { mobility: 'static' | 'dynamic'; castShadows: boolean; receiveShadows: boolean } {
  const mobility = source.automaticShadowMobility ?? 'dynamic';
  let castShadows = true;
  let receiveShadows = shadows.receiverScope === 'ground-only'
    ? isEnvironmentShadowReceiverSource(source)
    : true;

  if (shadows.skipGeneratedCargoCasters === true && isGeneratedCargoSource(source)) {
    castShadows = false;
  }

  const smallThreshold = shadows.skipSmallCastersMeters;
  if (
    castShadows
    && typeof smallThreshold === 'number'
    && Number.isFinite(smallThreshold)
    && smallThreshold > 0
    && !isEnvironmentShadowReceiverSource(source)
    && !isMobileEquipmentDeviceType(source.entry.deviceType)
  ) {
    const maxDim = getSourceMaxWorldDimension(source);
    if (maxDim !== null && maxDim > 0 && maxDim < smallThreshold) {
      castShadows = false;
    }
  }

  if (shadows.respectEntityShadowOverrides === true) {
    const explicitCast = readExplicitEntityShadowOverride(source, 'castShadows');
    if (explicitCast !== undefined) castShadows = explicitCast;
    const explicitReceive = readExplicitEntityShadowOverride(source, 'receiveShadows');
    if (explicitReceive !== undefined) receiveShadows = explicitReceive;
  }

  return { mobility, castShadows, receiveShadows };
}
