import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js';
import type { AbstractMesh, Scene } from '@babylonjs/core';
import type {
  ManualRoamCollisionBounds,
  ManualRoamCollisionBoundsResolver,
  ManualRoamPoint,
} from './manualRoamCollisionBounds';

export const MANUAL_ROAM_COLLISION_PROXY_PREFIX = '__manual_roam_collision_proxy__';

type ManualRoamCollisionProxyPoolOptions = {
  maxColliders?: number;
  refreshIntervalMs?: number;
  refreshDistanceMeters?: number;
};

const DEFAULT_MAX_COLLIDERS = 128;
const DEFAULT_REFRESH_INTERVAL_MS = 180;
const DEFAULT_REFRESH_DISTANCE_METERS = 0.75;

/** 使用固定大小的 Mesh 池，将人物邻域内的实例世界包围盒交给 Babylon 碰撞系统。 */
export class ManualRoamCollisionProxyPool {
  private readonly scene: Scene;
  private readonly resolveBounds: ManualRoamCollisionBoundsResolver;
  private readonly proxies: Mesh[] = [];
  private readonly proxySet = new Set<AbstractMesh>();
  private readonly activeProxyById = new Map<string, Mesh>();
  private readonly material: StandardMaterial;
  private readonly maxColliders: number;
  private readonly refreshIntervalMs: number;
  private readonly refreshDistanceSquared: number;
  private activeBounds: ManualRoamCollisionBounds[] = [];
  private lastPosition: ManualRoamPoint | null = null;
  private lastRefreshMs = Number.NEGATIVE_INFINITY;
  private debugVisible = false;
  private currentActiveCount = 0;
  private lastSyncMutated = false;

  constructor(
    scene: Scene,
    resolveBounds: ManualRoamCollisionBoundsResolver,
    options: ManualRoamCollisionProxyPoolOptions = {},
  ) {
    this.scene = scene;
    this.resolveBounds = resolveBounds;
    this.maxColliders = normalizePositiveInteger(options.maxColliders, DEFAULT_MAX_COLLIDERS);
    this.refreshIntervalMs = normalizeNonNegativeFinite(
      options.refreshIntervalMs,
      DEFAULT_REFRESH_INTERVAL_MS,
    );
    const refreshDistance = normalizeNonNegativeFinite(
      options.refreshDistanceMeters,
      DEFAULT_REFRESH_DISTANCE_METERS,
    );
    this.refreshDistanceSquared = refreshDistance * refreshDistance;
    this.material = new StandardMaterial(`${MANUAL_ROAM_COLLISION_PROXY_PREFIX}_material`, scene);
    this.material.diffuseColor = new Color3(0.08, 0.75, 1);
    this.material.emissiveColor = new Color3(0.02, 0.24, 0.35);
    this.material.alpha = 0.25;
    this.material.wireframe = true;
    this.material.disableLighting = true;
  }

  get activeCount(): number {
    return this.currentActiveCount;
  }

  get lastSyncChanged(): boolean {
    return this.lastSyncMutated;
  }

  has(mesh: AbstractMesh): boolean {
    return this.proxySet.has(mesh);
  }

  /** 返回当前启用的 AABB 代理，供人物 surroundingMeshes 收窄碰撞扫描。 */
  getActiveMeshes(): readonly Mesh[] {
    return this.proxies.slice(0, this.currentActiveCount);
  }

  /** 返回当前激活的代理包围盒只读列表，供穿插检测与自动脱困使用。 */
  getActiveBounds(): readonly ManualRoamCollisionBounds[] {
    return this.activeBounds;
  }

  /** 按包围盒 ID 查找当前对应的代理 Mesh。 */
  getActiveProxyById(id: string): Mesh | null {
    return this.activeProxyById.get(id) ?? null;
  }

  sync(
    position: Readonly<ManualRoamPoint>,
    radiusMeters: number,
    nowMs: number,
    force = false,
  ): boolean {
    if (!isFinitePoint(position) || !Number.isFinite(radiusMeters) || radiusMeters <= 0) return false;
    const elapsed = nowMs - this.lastRefreshMs;
    const movedSquared = this.lastPosition ? squaredDistance(position, this.lastPosition) : Number.POSITIVE_INFINITY;
    if (!force && elapsed < this.refreshIntervalMs && movedSquared < this.refreshDistanceSquared) return false;

    const bounds = this.resolveBounds(position, radiusMeters).slice(0, this.maxColliders);
    if (!force && haveSameCollisionBounds(this.activeBounds, bounds)) {
      this.lastSyncMutated = false;
      this.lastPosition = { ...position };
      this.lastRefreshMs = nowMs;
      return true;
    }
    this.activeProxyById.clear();
    this.activeBounds = bounds.map((bound) => ({
      id: bound.id,
      minimum: { ...bound.minimum },
      maximum: { ...bound.maximum },
    }));
    for (let index = 0; index < bounds.length; index += 1) {
      const proxy = this.getOrCreateProxy(index);
      const bound = bounds[index];
      const sizeX = Math.max(0.01, bound.maximum.x - bound.minimum.x);
      const sizeY = Math.max(0.01, bound.maximum.y - bound.minimum.y);
      const sizeZ = Math.max(0.01, bound.maximum.z - bound.minimum.z);
      proxy.name = `${MANUAL_ROAM_COLLISION_PROXY_PREFIX}_${bound.id}`;
      proxy.position.copyFromFloats(
        (bound.minimum.x + bound.maximum.x) / 2,
        (bound.minimum.y + bound.maximum.y) / 2,
        (bound.minimum.z + bound.maximum.z) / 2,
      );
      proxy.scaling.copyFromFloats(sizeX, sizeY, sizeZ);
      proxy.isVisible = this.debugVisible;
      proxy.visibility = this.debugVisible ? 0.25 : 0;
      proxy.setEnabled(true);
      proxy.computeWorldMatrix(true);
      this.activeProxyById.set(bound.id, proxy);
    }
    for (let index = bounds.length; index < this.proxies.length; index += 1) {
      this.proxies[index].setEnabled(false);
    }
    this.currentActiveCount = bounds.length;
    this.lastSyncMutated = true;
    this.lastPosition = { ...position };
    this.lastRefreshMs = nowMs;
    return true;
  }

  setDebugVisible(visible: boolean): void {
    this.debugVisible = visible;
    for (let index = 0; index < this.currentActiveCount; index += 1) {
      const proxy = this.proxies[index];
      proxy.isVisible = visible;
      proxy.visibility = visible ? 0.25 : 0;
    }
  }

  deactivate(): void {
    for (const proxy of this.proxies) proxy.setEnabled(false);
    this.currentActiveCount = 0;
    this.lastSyncMutated = false;
    this.activeBounds = [];
    this.activeProxyById.clear();
    this.lastPosition = null;
    this.lastRefreshMs = Number.NEGATIVE_INFINITY;
  }

  dispose(): void {
    for (const proxy of this.proxies) proxy.dispose(false, false);
    this.proxies.length = 0;
    this.proxySet.clear();
    this.activeBounds = [];
    this.activeProxyById.clear();
    this.material.dispose();
    this.currentActiveCount = 0;
  }

  private getOrCreateProxy(index: number): Mesh {
    const existing = this.proxies[index];
    if (existing) return existing;
    const proxy = MeshBuilder.CreateBox(`${MANUAL_ROAM_COLLISION_PROXY_PREFIX}_${index}`, { size: 1 }, this.scene);
    proxy.checkCollisions = true;
    proxy.isPickable = true;
    proxy.doNotSerialize = true;
    proxy.isVisible = this.debugVisible;
    proxy.visibility = this.debugVisible ? 0.25 : 0;
    proxy.material = this.material;
    proxy.metadata = { manualRoamCollisionProxy: true };
    this.proxies.push(proxy);
    this.proxySet.add(proxy);
    return proxy;
  }
}

function haveSameCollisionBounds(
  left: readonly ManualRoamCollisionBounds[],
  right: readonly ManualRoamCollisionBounds[],
): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (
      a.id !== b.id
      || a.minimum.x !== b.minimum.x
      || a.minimum.y !== b.minimum.y
      || a.minimum.z !== b.minimum.z
      || a.maximum.x !== b.maximum.x
      || a.maximum.y !== b.maximum.y
      || a.maximum.z !== b.maximum.z
    ) {
      return false;
    }
  }
  return true;
}

function squaredDistance(left: Readonly<ManualRoamPoint>, right: Readonly<ManualRoamPoint>): number {
  const dx = left.x - right.x;
  const dy = left.y - right.y;
  const dz = left.z - right.z;
  return dx * dx + dy * dy + dz * dz;
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
