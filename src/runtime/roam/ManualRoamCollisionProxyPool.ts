import {
  type AbstractMesh,
  Color3,
  Mesh,
  MeshBuilder,
  type Scene,
  StandardMaterial,
} from '@babylonjs/core';
import type {
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
  private readonly material: StandardMaterial;
  private readonly maxColliders: number;
  private readonly refreshIntervalMs: number;
  private readonly refreshDistanceSquared: number;
  private lastPosition: ManualRoamPoint | null = null;
  private lastRefreshMs = Number.NEGATIVE_INFINITY;
  private debugVisible = false;
  private currentActiveCount = 0;

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

  has(mesh: AbstractMesh): boolean {
    return this.proxySet.has(mesh);
  }

  /** 返回当前启用的 AABB 代理，供人物 surroundingMeshes 收窄碰撞扫描。 */
  getActiveMeshes(): readonly Mesh[] {
    return this.proxies.slice(0, this.currentActiveCount);
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
      proxy.visibility = this.debugVisible ? 0.25 : 0;
      proxy.setEnabled(true);
      proxy.computeWorldMatrix(true);
    }
    for (let index = bounds.length; index < this.proxies.length; index += 1) {
      this.proxies[index].setEnabled(false);
    }
    this.currentActiveCount = bounds.length;
    this.lastPosition = { ...position };
    this.lastRefreshMs = nowMs;
    return true;
  }

  setDebugVisible(visible: boolean): void {
    this.debugVisible = visible;
    for (let index = 0; index < this.currentActiveCount; index += 1) {
      this.proxies[index].visibility = visible ? 0.25 : 0;
    }
  }

  deactivate(): void {
    for (const proxy of this.proxies) proxy.setEnabled(false);
    this.currentActiveCount = 0;
    this.lastPosition = null;
    this.lastRefreshMs = Number.NEGATIVE_INFINITY;
  }

  dispose(): void {
    for (const proxy of this.proxies) proxy.dispose(false, false);
    this.proxies.length = 0;
    this.proxySet.clear();
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
    proxy.visibility = 0;
    proxy.material = this.material;
    proxy.metadata = { manualRoamCollisionProxy: true };
    this.proxies.push(proxy);
    this.proxySet.add(proxy);
    return proxy;
  }
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
