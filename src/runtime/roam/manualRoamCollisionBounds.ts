import {
  type AbstractMesh,
  Matrix,
  Mesh,
  Vector3,
} from '@babylonjs/core';
import type { SceneDocument } from '../../editor/model/SceneDocument';

export type ManualRoamPoint = { x: number; y: number; z: number };

export type ManualRoamCollisionBounds = {
  id: string;
  minimum: ManualRoamPoint;
  maximum: ManualRoamPoint;
};

type RuntimeWorldBounds = {
  center: ManualRoamPoint;
  sizeMeters: ManualRoamPoint;
  radiusMeters?: number;
  geometryReady: boolean;
  resolvedEntityCount: number;
};

export type ManualRoamBoundsRuntime = {
  getEntitiesWorldBounds: (entityIds: string[]) => RuntimeWorldBounds | null;
};

export type ManualRoamCollisionBoundsResolver = (
  position: Readonly<ManualRoamPoint>,
  radiusMeters: number,
) => readonly ManualRoamCollisionBounds[];

type Candidate = {
  entityId: string;
  position: ManualRoamPoint;
  scale?: ManualRoamPoint;
  sourceEntityId?: string;
  prefilterRadiusMeters?: number;
};

type RankedCandidate = Candidate & { distanceSquared: number; centerDistanceSquared: number };

type SourceBoundsProfile = {
  pivotRadiusMeters: number;
  scale: ManualRoamPoint;
};

export type ManualRoamCollisionBoundsResolverOptions = {
  getSceneDocument: () => Pick<SceneDocument, 'entities' | 'entityIds'>;
  getRuntime: () => ManualRoamBoundsRuntime | null;
  maxColliders?: number;
  centerPrefilterMarginMeters?: number;
};

export type ManualRoamThinInstanceCollisionBoundsResolverOptions = {
  getMeshes: () => readonly AbstractMesh[];
  excludeMesh?: (mesh: Mesh) => boolean;
  maxColliders?: number;
};

const DEFAULT_MAX_COLLIDERS = 128;
const DEFAULT_CENTER_PREFILTER_MARGIN_METERS = 40;
const CANDIDATE_MULTIPLIER = 4;
const MIN_COLLIDER_SIZE_METERS = 0.01;

export function combineManualRoamCollisionBoundsResolvers(
  resolvers: readonly ManualRoamCollisionBoundsResolver[],
  maxColliders = DEFAULT_MAX_COLLIDERS,
): ManualRoamCollisionBoundsResolver {
  const normalizedLimit = normalizePositiveInteger(maxColliders, DEFAULT_MAX_COLLIDERS);
  return (position, radiusMeters) => {
    const nearestById = new Map<string, { bounds: ManualRoamCollisionBounds; distanceSquared: number }>();
    for (const resolver of resolvers) {
      for (const bounds of resolver(position, radiusMeters)) {
        const distanceSquared = distanceSquaredToBounds(position, bounds.minimum, bounds.maximum);
        const existing = nearestById.get(bounds.id);
        if (!existing || distanceSquared < existing.distanceSquared) {
          nearestById.set(bounds.id, { bounds, distanceSquared });
        }
      }
    }
    return [...nearestById.values()]
      .sort(compareRankedCollisionBounds)
      .slice(0, normalizedLimit)
      .map(({ bounds }) => bounds);
  };
}

/** 将非模型阵列的 thin instance 矩阵转为人物邻域 AABB，避免 GPU 实例穿透。 */
export function createManualRoamThinInstanceCollisionBoundsResolver(
  options: ManualRoamThinInstanceCollisionBoundsResolverOptions,
): ManualRoamCollisionBoundsResolver {
  const maxColliders = normalizePositiveInteger(options.maxColliders, DEFAULT_MAX_COLLIDERS);
  const instanceMatrix = Matrix.Identity();
  const worldMatrix = Matrix.Identity();
  return (position, radiusMeters) => {
    if (!isFinitePoint(position) || !Number.isFinite(radiusMeters) || radiusMeters <= 0) return [];
    const radiusSquared = radiusMeters * radiusMeters;
    const nearest: Array<{ bounds: ManualRoamCollisionBounds; distanceSquared: number }> = [];

    for (const abstractMesh of options.getMeshes()) {
      if (!(abstractMesh instanceof Mesh) || !shouldResolveThinInstanceMesh(abstractMesh, options.excludeMesh)) {
        continue;
      }
      // 查询阶段只更新 Mesh 世界变换，避免 Babylon 自动重扫整个 thin-instance 批次。
      const previousDoNotSyncBoundingInfo = abstractMesh.doNotSyncBoundingInfo;
      abstractMesh.doNotSyncBoundingInfo = true;
      try {
        abstractMesh.computeWorldMatrix();
      } finally {
        abstractMesh.doNotSyncBoundingInfo = previousDoNotSyncBoundingInfo;
      }
      const aggregateBounds = abstractMesh.getBoundingInfo().boundingBox;
      if (abstractMesh.rawBoundingInfo && distanceSquaredToBounds(
        position,
        aggregateBounds.minimumWorld,
        aggregateBounds.maximumWorld,
      ) > radiusSquared) continue;

      const matrixSource = resolveThinInstanceMatrixSource(abstractMesh);
      if (!matrixSource) continue;
      const instanceCount = Math.min(abstractMesh.thinInstanceCount, matrixSource.count);
      if (instanceCount <= 0) continue;
      const meshWorldMatrix = abstractMesh.getWorldMatrix();
      const applyMeshWorldMatrix = !meshWorldMatrix.isIdentity();
      const localBounds = (abstractMesh.rawBoundingInfo ?? abstractMesh.getBoundingInfo()).boundingBox;
      const localCenter = localBounds.center;
      const localExtents = localBounds.extendSize;

      for (let index = 0; index < instanceCount; index += 1) {
        let matrixValues: ArrayLike<number>;
        let matrixOffset: number;
        if (matrixSource.matrixData) {
          matrixValues = matrixSource.matrixData;
          matrixOffset = index * 16;
        } else {
          matrixValues = matrixSource.worldMatrices[index].m;
          matrixOffset = 0;
        }
        if (applyMeshWorldMatrix) {
          Matrix.FromArrayToRef(matrixValues, matrixOffset, instanceMatrix);
          instanceMatrix.multiplyToRef(meshWorldMatrix, worldMatrix);
          matrixValues = worldMatrix.m;
          matrixOffset = 0;
        }

        const m0 = matrixValues[matrixOffset];
        const m1 = matrixValues[matrixOffset + 1];
        const m2 = matrixValues[matrixOffset + 2];
        const m4 = matrixValues[matrixOffset + 4];
        const m5 = matrixValues[matrixOffset + 5];
        const m6 = matrixValues[matrixOffset + 6];
        const m8 = matrixValues[matrixOffset + 8];
        const m9 = matrixValues[matrixOffset + 9];
        const m10 = matrixValues[matrixOffset + 10];
        const centerX = localCenter.x * m0
          + localCenter.y * m4
          + localCenter.z * m8
          + matrixValues[matrixOffset + 12];
        const centerY = localCenter.x * m1
          + localCenter.y * m5
          + localCenter.z * m9
          + matrixValues[matrixOffset + 13];
        const centerZ = localCenter.x * m2
          + localCenter.y * m6
          + localCenter.z * m10
          + matrixValues[matrixOffset + 14];
        const extentX = Math.abs(m0) * localExtents.x
          + Math.abs(m4) * localExtents.y
          + Math.abs(m8) * localExtents.z;
        const extentY = Math.abs(m1) * localExtents.x
          + Math.abs(m5) * localExtents.y
          + Math.abs(m9) * localExtents.z;
        const extentZ = Math.abs(m2) * localExtents.x
          + Math.abs(m6) * localExtents.y
          + Math.abs(m10) * localExtents.z;
        const minimumX = centerX - extentX;
        const minimumY = centerY - extentY;
        const minimumZ = centerZ - extentZ;
        const maximumX = centerX + extentX;
        const maximumY = centerY + extentY;
        const maximumZ = centerZ + extentZ;
        const distanceSquared = distanceSquaredToBoundsComponents(
          position,
          minimumX,
          minimumY,
          minimumZ,
          maximumX,
          maximumY,
          maximumZ,
        );
        if (distanceSquared > radiusSquared) continue;
        keepNearestCollisionBounds(nearest, {
          bounds: {
            id: `thin:${abstractMesh.uniqueId}:${index}`,
            minimum: { x: minimumX, y: minimumY, z: minimumZ },
            maximum: { x: maximumX, y: maximumY, z: maximumZ },
          },
          distanceSquared,
        }, maxColliders);
      }
    }

    return nearest.sort(compareRankedCollisionBounds).map(({ bounds }) => bounds);
  };
}

export function isManualRoamModelArrayThinInstanceMesh(mesh: Mesh): boolean {
  const metadata = mesh.metadata as Record<string, unknown> | null;
  return typeof metadata?.modelArraySourceEntityId === 'string'
    || mesh.name.startsWith('__modelArrayThinInstance');
}

/**
 * SceneRuntime 仍保留每个模型阵列实体的权威世界包围盒；漫游只查询人物邻域，
 * 避免为大场景中的全部 thin instance 常驻创建 Babylon 碰撞 Mesh。
 */
export function createManualRoamModelArrayCollisionBoundsResolver(
  options: ManualRoamCollisionBoundsResolverOptions,
): ManualRoamCollisionBoundsResolver {
  const maxColliders = normalizePositiveInteger(options.maxColliders, DEFAULT_MAX_COLLIDERS);
  const centerPrefilterMarginMeters = normalizeNonNegativeFinite(
    options.centerPrefilterMarginMeters,
    DEFAULT_CENTER_PREFILTER_MARGIN_METERS,
  );
  let cachedEntities: SceneDocument['entities'] | null = null;
  let cachedEntityIds: SceneDocument['entityIds'] | null = null;
  let candidates: Candidate[] = [];
  let sourceBoundsProfiles = new Map<string, SourceBoundsProfile>();

  return (position, radiusMeters) => {
    const runtime = options.getRuntime();
    if (!runtime || !isFinitePoint(position) || !Number.isFinite(radiusMeters) || radiusMeters <= 0) return [];

    const scene = options.getSceneDocument();
    if (scene.entities !== cachedEntities || scene.entityIds !== cachedEntityIds) {
      cachedEntities = scene.entities;
      cachedEntityIds = scene.entityIds;
      sourceBoundsProfiles = new Map();
      const arraySourceIds = new Set(scene.entityIds.flatMap((entityId) => {
        const sourceEntityId = scene.entities[entityId]?.components.modelArrayInstance?.sourceEntityId;
        return sourceEntityId ? [sourceEntityId] : [];
      }));
      candidates = scene.entityIds.flatMap((entityId) => {
        const entity = scene.entities[entityId];
        if (
          !entity
          || entity.isFolder
          || (!entity.components.modelArrayInstance && !arraySourceIds.has(entityId))
          || !isEntityHierarchyVisible(entityId, scene.entities)
          || !isFinitePoint(entity.components.transform.position)
        ) return [];
        return [{
          entityId,
          position: { ...entity.components.transform.position },
          scale: { ...entity.components.transform.scale },
          sourceEntityId: entity.components.modelArrayInstance?.sourceEntityId ?? entityId,
        }];
      });
    }

    const attemptedSourceIds = new Set<string>();
    for (const candidate of candidates) {
      const sourceEntityId = candidate.sourceEntityId;
      if (!sourceEntityId) continue;
      let sourceProfile = sourceBoundsProfiles.get(sourceEntityId);
      if (!sourceProfile && !attemptedSourceIds.has(sourceEntityId)) {
        attemptedSourceIds.add(sourceEntityId);
        const sourceEntity = scene.entities[sourceEntityId];
        const sourceBounds = runtime.getEntitiesWorldBounds([sourceEntityId]);
        if (
          sourceEntity
          && sourceBounds?.geometryReady
          && sourceBounds.resolvedEntityCount > 0
          && isFinitePoint(sourceBounds.center)
          && isFinitePoint(sourceBounds.sizeMeters)
          && isFinitePoint(sourceEntity.components.transform.position)
          && isFinitePoint(sourceEntity.components.transform.scale)
        ) {
          const boundsRadius = Number.isFinite(sourceBounds.radiusMeters)
            ? Math.max(0, sourceBounds.radiusMeters ?? 0)
            : Math.hypot(
              sourceBounds.sizeMeters.x,
              sourceBounds.sizeMeters.y,
              sourceBounds.sizeMeters.z,
            ) / 2;
          sourceProfile = {
            // 以实体轴心为球心，额外计入模型几何中心相对轴心的偏移。
            pivotRadiusMeters: boundsRadius + Math.sqrt(squaredDistance(
              sourceBounds.center,
              sourceEntity.components.transform.position,
            )),
            scale: { ...sourceEntity.components.transform.scale },
          };
          sourceBoundsProfiles.set(sourceEntityId, sourceProfile);
        }
      }
      candidate.prefilterRadiusMeters = sourceProfile
        ? sourceProfile.pivotRadiusMeters * resolveMaximumScaleRatio(candidate.scale, sourceProfile.scale)
        : 0;
    }

    const prefilterRadius = radiusMeters + centerPrefilterMarginMeters;
    const nearby = selectNearestCandidates(
      candidates,
      position,
      prefilterRadius,
      maxColliders * CANDIDATE_MULTIPLIER,
    );
    const radiusSquared = radiusMeters * radiusMeters;
    const result: ManualRoamCollisionBounds[] = [];

    for (const candidate of nearby) {
      const bounds = runtime.getEntitiesWorldBounds([candidate.entityId]);
      if (
        !bounds?.geometryReady
        || bounds.resolvedEntityCount < 1
        || !isFinitePoint(bounds.center)
        || !isFinitePoint(bounds.sizeMeters)
      ) continue;

      const halfSize = {
        x: Math.max(MIN_COLLIDER_SIZE_METERS, Math.abs(bounds.sizeMeters.x)) / 2,
        y: Math.max(MIN_COLLIDER_SIZE_METERS, Math.abs(bounds.sizeMeters.y)) / 2,
        z: Math.max(MIN_COLLIDER_SIZE_METERS, Math.abs(bounds.sizeMeters.z)) / 2,
      };
      const minimum = {
        x: bounds.center.x - halfSize.x,
        y: bounds.center.y - halfSize.y,
        z: bounds.center.z - halfSize.z,
      };
      const maximum = {
        x: bounds.center.x + halfSize.x,
        y: bounds.center.y + halfSize.y,
        z: bounds.center.z + halfSize.z,
      };
      if (distanceSquaredToBounds(position, minimum, maximum) > radiusSquared) continue;

      result.push({ id: candidate.entityId, minimum, maximum });
      if (result.length >= maxColliders) break;
    }
    return result;
  };
}

export function selectNearestCandidates(
  candidates: readonly Candidate[],
  position: Readonly<ManualRoamPoint>,
  radiusMeters: number,
  limit: number,
): RankedCandidate[] {
  if (!isFinitePoint(position) || !Number.isFinite(radiusMeters) || radiusMeters <= 0 || limit <= 0) return [];
  const normalizedLimit = Math.max(1, Math.floor(limit));
  const radiusSquared = radiusMeters * radiusMeters;
  const heap: RankedCandidate[] = [];

  for (const candidate of candidates) {
    const centerDistanceSquared = squaredDistance(position, candidate.position);
    const prefilterRadius = normalizeNonNegativeFinite(candidate.prefilterRadiusMeters, 0);
    const surfaceDistance = Math.max(0, Math.sqrt(centerDistanceSquared) - prefilterRadius);
    const distanceSquared = surfaceDistance * surfaceDistance;
    if (!Number.isFinite(distanceSquared) || distanceSquared > radiusSquared) continue;
    const ranked = { ...candidate, distanceSquared, centerDistanceSquared };
    if (heap.length < normalizedLimit) {
      heap.push(ranked);
      siftMaxHeapUp(heap, heap.length - 1);
      continue;
    }
    if (compareRankedCandidates(ranked, heap[0]) >= 0) continue;
    heap[0] = ranked;
    siftMaxHeapDown(heap, 0);
  }

  return heap.sort(compareRankedCandidates);
}

function siftMaxHeapUp(heap: RankedCandidate[], index: number): void {
  let child = index;
  while (child > 0) {
    const parent = Math.floor((child - 1) / 2);
    if (compareRankedCandidates(heap[parent], heap[child]) >= 0) return;
    [heap[parent], heap[child]] = [heap[child], heap[parent]];
    child = parent;
  }
}

function siftMaxHeapDown(heap: RankedCandidate[], index: number): void {
  let parent = index;
  while (true) {
    const left = parent * 2 + 1;
    const right = left + 1;
    let largest = parent;
    if (left < heap.length && compareRankedCandidates(heap[left], heap[largest]) > 0) largest = left;
    if (right < heap.length && compareRankedCandidates(heap[right], heap[largest]) > 0) largest = right;
    if (largest === parent) return;
    [heap[parent], heap[largest]] = [heap[largest], heap[parent]];
    parent = largest;
  }
}

function compareRankedCandidates(left: RankedCandidate, right: RankedCandidate): number {
  return left.distanceSquared - right.distanceSquared
    || left.centerDistanceSquared - right.centerDistanceSquared
    || left.entityId.localeCompare(right.entityId);
}

function distanceSquaredToBounds(
  point: Readonly<ManualRoamPoint>,
  minimum: Readonly<ManualRoamPoint>,
  maximum: Readonly<ManualRoamPoint>,
): number {
  const dx = Math.max(minimum.x - point.x, 0, point.x - maximum.x);
  const dy = Math.max(minimum.y - point.y, 0, point.y - maximum.y);
  const dz = Math.max(minimum.z - point.z, 0, point.z - maximum.z);
  return dx * dx + dy * dy + dz * dz;
}

function distanceSquaredToBoundsComponents(
  point: Readonly<ManualRoamPoint>,
  minimumX: number,
  minimumY: number,
  minimumZ: number,
  maximumX: number,
  maximumY: number,
  maximumZ: number,
): number {
  const dx = Math.max(minimumX - point.x, 0, point.x - maximumX);
  const dy = Math.max(minimumY - point.y, 0, point.y - maximumY);
  const dz = Math.max(minimumZ - point.z, 0, point.z - maximumZ);
  return dx * dx + dy * dy + dz * dz;
}

function shouldResolveThinInstanceMesh(
  mesh: Mesh,
  excludeMesh: ((mesh: Mesh) => boolean) | undefined,
): boolean {
  if (
    mesh.thinInstanceCount <= 0
    || mesh.isDisposed()
    || mesh.getClassName() === 'LinesMesh'
    || !mesh.isEnabled()
    || !mesh.isVisible
    || mesh.visibility <= 0
    || mesh.layerMask === 0
    || mesh.getTotalVertices() <= 0
    || mesh.infiniteDistance
    || excludeMesh?.(mesh)
  ) return false;
  const metadata = mesh.metadata as Record<string, unknown> | null;
  if (
    metadata?.manualRoamAvatar
    || metadata?.manualRoamCollider
    || metadata?.manualRoamCollisionProxy
    || metadata?.editorGroundGrid
    || metadata?.editorAutoPatrolMarker
    || metadata?.editorShadowCatcher
    || metadata?.editorSkyboxSphere
  ) return false;
  const name = mesh.name.toLowerCase();
  return !name.includes('skybox')
    && !name.includes('gizmo')
    && !name.includes('marker')
    && !name.includes('trajectory')
    && !name.includes('highlight');
}

function keepNearestCollisionBounds(
  nearest: Array<{ bounds: ManualRoamCollisionBounds; distanceSquared: number }>,
  candidate: { bounds: ManualRoamCollisionBounds; distanceSquared: number },
  limit: number,
): void {
  if (nearest.length < limit) {
    nearest.push(candidate);
    siftCollisionBoundsMaxHeapUp(nearest, nearest.length - 1);
    return;
  }
  if (compareRankedCollisionBounds(candidate, nearest[0]) >= 0) return;
  nearest[0] = candidate;
  siftCollisionBoundsMaxHeapDown(nearest, 0);
}

function siftCollisionBoundsMaxHeapUp(
  heap: Array<{ bounds: ManualRoamCollisionBounds; distanceSquared: number }>,
  index: number,
): void {
  let child = index;
  while (child > 0) {
    const parent = Math.floor((child - 1) / 2);
    if (compareRankedCollisionBounds(heap[parent], heap[child]) >= 0) return;
    [heap[parent], heap[child]] = [heap[child], heap[parent]];
    child = parent;
  }
}

function siftCollisionBoundsMaxHeapDown(
  heap: Array<{ bounds: ManualRoamCollisionBounds; distanceSquared: number }>,
  index: number,
): void {
  let parent = index;
  while (true) {
    const left = parent * 2 + 1;
    const right = left + 1;
    let largest = parent;
    if (left < heap.length && compareRankedCollisionBounds(heap[left], heap[largest]) > 0) largest = left;
    if (right < heap.length && compareRankedCollisionBounds(heap[right], heap[largest]) > 0) largest = right;
    if (largest === parent) return;
    [heap[parent], heap[largest]] = [heap[largest], heap[parent]];
    parent = largest;
  }
}

function compareRankedCollisionBounds(
  left: { bounds: ManualRoamCollisionBounds; distanceSquared: number },
  right: { bounds: ManualRoamCollisionBounds; distanceSquared: number },
): number {
  return left.distanceSquared - right.distanceSquared || left.bounds.id.localeCompare(right.bounds.id);
}

type ThinInstanceMatrixSource = {
  matrixData: Float32Array | null;
  worldMatrices: readonly Matrix[];
  count: number;
};

function resolveThinInstanceMatrixSource(mesh: Mesh): ThinInstanceMatrixSource | null {
  // Babylon 尚未提供读取原始 matrix buffer 的公共 API；集中隔离 @internal 访问，升级失败时回退到公共矩阵列表。
  const internalStorage = (mesh as Mesh & {
    _thinInstanceDataStorage?: { matrixData?: Float32Array | null };
  })._thinInstanceDataStorage;
  if (internalStorage?.matrixData) {
    return {
      matrixData: internalStorage.matrixData,
      worldMatrices: [],
      count: Math.floor(internalStorage.matrixData.length / 16),
    };
  }
  try {
    const worldMatrices = mesh.thinInstanceGetWorldMatrices();
    return worldMatrices.length > 0
      ? { matrixData: null, worldMatrices, count: worldMatrices.length }
      : null;
  } catch {
    return null;
  }
}

function squaredDistance(left: Readonly<ManualRoamPoint>, right: Readonly<ManualRoamPoint>): number {
  const dx = left.x - right.x;
  const dy = left.y - right.y;
  const dz = left.z - right.z;
  return dx * dx + dy * dy + dz * dz;
}

function resolveMaximumScaleRatio(
  candidateScale: Readonly<ManualRoamPoint> | undefined,
  sourceScale: Readonly<ManualRoamPoint>,
): number {
  if (!candidateScale || !isFinitePoint(candidateScale) || !isFinitePoint(sourceScale)) return 1;
  return Math.max(
    safeScaleRatio(candidateScale.x, sourceScale.x),
    safeScaleRatio(candidateScale.y, sourceScale.y),
    safeScaleRatio(candidateScale.z, sourceScale.z),
  );
}

function safeScaleRatio(candidate: number, source: number): number {
  const denominator = Math.abs(source);
  if (!Number.isFinite(candidate) || !Number.isFinite(denominator) || denominator <= 1e-6) return 1;
  return Math.max(0, Math.abs(candidate) / denominator);
}

function isEntityHierarchyVisible(
  entityId: string,
  entities: SceneDocument['entities'],
): boolean {
  const visited = new Set<string>();
  let current = entities[entityId];
  while (current) {
    if (current.visible === false) return false;
    if (!current.parentId || visited.has(current.parentId)) return true;
    visited.add(current.parentId);
    current = entities[current.parentId];
  }
  return true;
}

function isFinitePoint(value: Readonly<ManualRoamPoint>): boolean {
  return Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z);
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value !== undefined && value > 0 ? Math.floor(value) : fallback;
}

function normalizeNonNegativeFinite(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value !== undefined && value >= 0 ? value : fallback;
}
