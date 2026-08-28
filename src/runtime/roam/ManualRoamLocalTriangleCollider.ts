import {
  type AbstractMesh,
  Color3,
  Mesh,
  type Scene,
  StandardMaterial,
  VertexBuffer,
  VertexData,
} from '@babylonjs/core';
import type { ManualRoamPoint } from './manualRoamCollisionBounds.ts';
import { resolveManualRoamCollisionStyle } from './manualRoamCollisionPolicy.ts';

export const MANUAL_ROAM_LOCAL_TRIANGLE_COLLIDER_PREFIX = '__manual_roam_local_triangles__';

type ManualRoamLocalTriangleColliderOptions = {
  cellSizeMeters?: number;
  maxColliderMeshes?: number;
  maxTriangles?: number;
  refreshIntervalMs?: number;
  refreshDistanceMeters?: number;
};

type IndexedCollisionMesh = {
  uniqueId: number;
  mesh: AbstractMesh;
  worldMatrix: Float32Array;
  vertexCount: number;
  worldPositions: Float32Array;
  cells: Map<string, number[]>;
};

const DEFAULT_CELL_SIZE_METERS = 4;
const DEFAULT_MAX_COLLIDER_MESHES = 64;
const DEFAULT_MAX_TRIANGLES = 24_576;
const DEFAULT_REFRESH_INTERVAL_MS = 180;
const DEFAULT_REFRESH_DISTANCE_METERS = 0.75;
const TRIANGLES_PER_MESH = 384;
const MATRIX_CHANGE_EPSILON = 1e-5;

/**
 * 把厂区环境等高模三角切成空间格子，只把人物邻域内的三角提交给 Babylon 碰撞。
 * 原网格保持 checkCollisions=false，避免每帧对整份 GLB 做椭球-三角检测。
 */
export class ManualRoamLocalTriangleCollider {
  private readonly scene: Scene;
  private readonly cellSizeMeters: number;
  private readonly maxColliderMeshes: number;
  private readonly maxTriangles: number;
  private readonly refreshIntervalMs: number;
  private readonly refreshDistanceSquared: number;
  private readonly indexedMeshes = new Map<number, IndexedCollisionMesh>();
  private readonly proxies: Mesh[] = [];
  private readonly proxySet = new Set<AbstractMesh>();
  private readonly material: StandardMaterial;
  private lastPosition: ManualRoamPoint | null = null;
  private lastRefreshMs = Number.NEGATIVE_INFINITY;
  private debugVisible = false;
  private currentActiveCount = 0;

  constructor(scene: Scene, options: ManualRoamLocalTriangleColliderOptions = {}) {
    this.scene = scene;
    this.cellSizeMeters = normalizePositiveFinite(options.cellSizeMeters, DEFAULT_CELL_SIZE_METERS);
    this.maxColliderMeshes = normalizePositiveInteger(options.maxColliderMeshes, DEFAULT_MAX_COLLIDER_MESHES);
    this.maxTriangles = normalizePositiveInteger(options.maxTriangles, DEFAULT_MAX_TRIANGLES);
    this.refreshIntervalMs = normalizeNonNegativeFinite(
      options.refreshIntervalMs,
      DEFAULT_REFRESH_INTERVAL_MS,
    );
    const refreshDistance = normalizeNonNegativeFinite(
      options.refreshDistanceMeters,
      DEFAULT_REFRESH_DISTANCE_METERS,
    );
    this.refreshDistanceSquared = refreshDistance * refreshDistance;
    this.material = new StandardMaterial(`${MANUAL_ROAM_LOCAL_TRIANGLE_COLLIDER_PREFIX}_material`, scene);
    this.material.diffuseColor = new Color3(0.95, 0.45, 0.12);
    this.material.emissiveColor = new Color3(0.28, 0.12, 0.02);
    this.material.alpha = 0.22;
    this.material.wireframe = true;
    this.material.disableLighting = true;
  }

  get activeCount(): number {
    return this.currentActiveCount;
  }

  get indexedCount(): number {
    return this.indexedMeshes.size;
  }

  has(mesh: AbstractMesh): boolean {
    return this.proxySet.has(mesh);
  }

  getActiveMeshes(): readonly Mesh[] {
    return this.proxies.slice(0, this.currentActiveCount);
  }

  /** 扫描当前场景，只为需要局部三角碰撞的高模建立或刷新空间索引。 */
  captureScene(meshes: readonly AbstractMesh[]): void {
    const seen = new Set<number>();
    for (const mesh of meshes) {
      this.observe(mesh);
      if (this.indexedMeshes.has(mesh.uniqueId)) seen.add(mesh.uniqueId);
    }
    for (const uniqueId of [...this.indexedMeshes.keys()]) {
      if (!seen.has(uniqueId)) this.indexedMeshes.delete(uniqueId);
    }
  }

  /** 按碰撞策略决定索引或移除单个网格。 */
  observe(mesh: AbstractMesh): void {
    if (resolveManualRoamCollisionStyle(mesh) !== 'local-triangle') {
      this.indexedMeshes.delete(mesh.uniqueId);
      return;
    }
    this.indexMesh(mesh, false);
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

    this.refreshChangedIndexes();
    const cells = this.collectNearbyCells(position, radiusMeters);
    let triangleBudget = this.maxTriangles;
    let meshIndex = 0;
    let currentPositions: number[] = [];

    const flush = (): void => {
      if (meshIndex >= this.maxColliderMeshes || currentPositions.length < 9) {
        currentPositions = [];
        return;
      }
      const proxy = this.getOrCreateProxy(meshIndex);
      applyWorldTriangles(proxy, currentPositions);
      proxy.visibility = this.debugVisible ? 0.22 : 0;
      proxy.setEnabled(true);
      proxy.computeWorldMatrix(true);
      meshIndex += 1;
      currentPositions = [];
    };

    for (const cell of cells) {
      const cellTriangles = cell.positions.length / 9;
      if (cellTriangles <= 0) continue;
      if (triangleBudget < cellTriangles && currentPositions.length === 0) break;
      if (triangleBudget < cellTriangles) {
        flush();
        break;
      }
      if (
        currentPositions.length > 0
        && (currentPositions.length / 9) + cellTriangles > TRIANGLES_PER_MESH
      ) {
        flush();
        if (meshIndex >= this.maxColliderMeshes) break;
      }
      currentPositions.push(...cell.positions);
      triangleBudget -= cellTriangles;
      if (currentPositions.length / 9 >= TRIANGLES_PER_MESH) flush();
    }
    flush();

    for (let index = meshIndex; index < this.proxies.length; index += 1) {
      this.proxies[index].setEnabled(false);
    }
    this.currentActiveCount = meshIndex;
    this.lastPosition = { ...position };
    this.lastRefreshMs = nowMs;
    return true;
  }

  setDebugVisible(visible: boolean): void {
    this.debugVisible = visible;
    for (let index = 0; index < this.currentActiveCount; index += 1) {
      this.proxies[index].visibility = visible ? 0.22 : 0;
    }
  }

  deactivate(): void {
    for (const proxy of this.proxies) proxy.setEnabled(false);
    this.currentActiveCount = 0;
    this.lastPosition = null;
    this.lastRefreshMs = Number.NEGATIVE_INFINITY;
  }

  dispose(): void {
    this.deactivate();
    for (const proxy of this.proxies) proxy.dispose(false, false);
    this.proxies.length = 0;
    this.proxySet.clear();
    this.indexedMeshes.clear();
    this.material.dispose();
  }

  private refreshChangedIndexes(): void {
    for (const indexed of [...this.indexedMeshes.values()]) {
      const mesh = indexed.mesh;
      if (mesh.isDisposed() || resolveManualRoamCollisionStyle(mesh) !== 'local-triangle') {
        this.indexedMeshes.delete(indexed.uniqueId);
        continue;
      }
      this.indexMesh(mesh, true);
    }
  }

  private indexMesh(mesh: AbstractMesh, onlyIfChanged: boolean): void {
    const existing = this.indexedMeshes.get(mesh.uniqueId);
    const worldMatrix = Float32Array.from(mesh.getWorldMatrix().m);
    const vertexCount = mesh.getTotalVertices();
    if (
      onlyIfChanged
      && existing
      && existing.vertexCount === vertexCount
      && !hasMatrixChanged(existing.worldMatrix, worldMatrix)
    ) return;

    const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
    const indices = mesh.getIndices();
    if (!positions || !indices || indices.length < 3) {
      this.indexedMeshes.delete(mesh.uniqueId);
      return;
    }

    const triangleCount = Math.floor(indices.length / 3);
    const worldPositions = new Float32Array(triangleCount * 9);
    const cells = new Map<string, number[]>();
    const cellSize = this.cellSizeMeters;
    const m = worldMatrix;
    let packedTriangleCount = 0;
    for (let index = 0; index + 2 < indices.length; index += 3) {
      const i0 = indices[index] * 3;
      const i1 = indices[index + 1] * 3;
      const i2 = indices[index + 2] * 3;
      const ax = positions[i0];
      const ay = positions[i0 + 1];
      const az = positions[i0 + 2];
      const bx = positions[i1];
      const by = positions[i1 + 1];
      const bz = positions[i1 + 2];
      const cx = positions[i2];
      const cy = positions[i2 + 1];
      const cz = positions[i2 + 2];
      if (![ax, ay, az, bx, by, bz, cx, cy, cz].every(Number.isFinite)) continue;
      const packedIndex = packedTriangleCount * 9;
      worldPositions[packedIndex] = ax * m[0] + ay * m[4] + az * m[8] + m[12];
      worldPositions[packedIndex + 1] = ax * m[1] + ay * m[5] + az * m[9] + m[13];
      worldPositions[packedIndex + 2] = ax * m[2] + ay * m[6] + az * m[10] + m[14];
      worldPositions[packedIndex + 3] = bx * m[0] + by * m[4] + bz * m[8] + m[12];
      worldPositions[packedIndex + 4] = bx * m[1] + by * m[5] + bz * m[9] + m[13];
      worldPositions[packedIndex + 5] = bx * m[2] + by * m[6] + bz * m[10] + m[14];
      worldPositions[packedIndex + 6] = cx * m[0] + cy * m[4] + cz * m[8] + m[12];
      worldPositions[packedIndex + 7] = cx * m[1] + cy * m[5] + cz * m[9] + m[13];
      worldPositions[packedIndex + 8] = cx * m[2] + cy * m[6] + cz * m[10] + m[14];
      const triangle = worldPositions.subarray(packedIndex, packedIndex + 9);
      for (const key of collectTriangleCellKeys(triangle, cellSize)) {
        const bucket = cells.get(key);
        if (bucket) bucket.push(packedTriangleCount);
        else cells.set(key, [packedTriangleCount]);
      }
      packedTriangleCount += 1;
    }

    this.indexedMeshes.set(mesh.uniqueId, {
      uniqueId: mesh.uniqueId,
      mesh,
      worldMatrix,
      vertexCount,
      worldPositions: packedTriangleCount === triangleCount
        ? worldPositions
        : worldPositions.slice(0, packedTriangleCount * 9),
      cells,
    });
  }

  private collectNearbyCells(
    position: Readonly<ManualRoamPoint>,
    radiusMeters: number,
  ): Array<{ distanceSquared: number; positions: number[] }> {
    const cellSize = this.cellSizeMeters;
    const minIx = Math.floor((position.x - radiusMeters) / cellSize);
    const maxIx = Math.floor((position.x + radiusMeters) / cellSize);
    const minIy = Math.floor((position.y - radiusMeters) / cellSize);
    const maxIy = Math.floor((position.y + radiusMeters) / cellSize);
    const minIz = Math.floor((position.z - radiusMeters) / cellSize);
    const maxIz = Math.floor((position.z + radiusMeters) / cellSize);
    const merged = new Map<string, { distanceSquared: number; positions: number[] }>();

    for (const indexed of this.indexedMeshes.values()) {
      if (
        indexed.mesh.isDisposed()
        || !indexed.mesh.isEnabled()
        || !indexed.mesh.isVisible
        || indexed.mesh.visibility <= 0
      ) continue;
      for (let ix = minIx; ix <= maxIx; ix += 1) {
        for (let iy = minIy; iy <= maxIy; iy += 1) {
          for (let iz = minIz; iz <= maxIz; iz += 1) {
            const key = makeCellKey(ix, iy, iz);
            const triangleIndexes = indexed.cells.get(key);
            if (!triangleIndexes || triangleIndexes.length === 0) continue;
            const centerX = (ix + 0.5) * cellSize;
            const centerY = (iy + 0.5) * cellSize;
            const centerZ = (iz + 0.5) * cellSize;
            const distanceSquared = squaredDistance(position, { x: centerX, y: centerY, z: centerZ });
            const existing = merged.get(key) ?? { distanceSquared, positions: [] as number[] };
            if (!merged.has(key)) merged.set(key, existing);
            for (const triangleIndex of triangleIndexes) {
              const offset = triangleIndex * 9;
              for (let component = 0; component < 9; component += 1) {
                existing.positions.push(indexed.worldPositions[offset + component]);
              }
            }
          }
        }
      }
    }

    return [...merged.values()].sort((left, right) => left.distanceSquared - right.distanceSquared);
  }

  private getOrCreateProxy(index: number): Mesh {
    const existing = this.proxies[index];
    if (existing) return existing;
    const proxy = new Mesh(`${MANUAL_ROAM_LOCAL_TRIANGLE_COLLIDER_PREFIX}_${index}`, this.scene);
    proxy.checkCollisions = true;
    proxy.isPickable = true;
    proxy.isVisible = true;
    proxy.visibility = 0;
    proxy.doNotSerialize = true;
    proxy.material = this.material;
    proxy.metadata = { manualRoamLocalTriangleCollider: true };
    this.proxies.push(proxy);
    this.proxySet.add(proxy);
    return proxy;
  }
}

function applyWorldTriangles(mesh: Mesh, positions: number[]): void {
  const vertexCount = Math.floor(positions.length / 3);
  const packedPositions = new Float32Array(vertexCount * 3);
  for (let index = 0; index < packedPositions.length; index += 1) packedPositions[index] = positions[index];
  const indices = new Uint32Array(vertexCount);
  for (let index = 0; index < vertexCount; index += 1) indices[index] = index;
  const normals = new Float32Array(vertexCount * 3);
  VertexData.ComputeNormals(packedPositions, indices, normals);
  const vertexData = new VertexData();
  vertexData.positions = packedPositions;
  vertexData.indices = indices;
  vertexData.normals = normals;
  vertexData.applyToMesh(mesh, true);
  mesh.refreshBoundingInfo(true);
}

function collectTriangleCellKeys(triangle: ArrayLike<number>, cellSize: number): string[] {
  const minX = Math.min(triangle[0], triangle[3], triangle[6]);
  const minY = Math.min(triangle[1], triangle[4], triangle[7]);
  const minZ = Math.min(triangle[2], triangle[5], triangle[8]);
  const maxX = Math.max(triangle[0], triangle[3], triangle[6]);
  const maxY = Math.max(triangle[1], triangle[4], triangle[7]);
  const maxZ = Math.max(triangle[2], triangle[5], triangle[8]);
  const minIx = Math.floor(minX / cellSize);
  const maxIx = Math.floor(maxX / cellSize);
  const minIy = Math.floor(minY / cellSize);
  const maxIy = Math.floor(maxY / cellSize);
  const minIz = Math.floor(minZ / cellSize);
  const maxIz = Math.floor(maxZ / cellSize);
  const keys: string[] = [];
  for (let ix = minIx; ix <= maxIx; ix += 1) {
    for (let iy = minIy; iy <= maxIy; iy += 1) {
      for (let iz = minIz; iz <= maxIz; iz += 1) {
        keys.push(makeCellKey(ix, iy, iz));
      }
    }
  }
  return keys;
}

function makeCellKey(ix: number, iy: number, iz: number): string {
  return `${ix}:${iy}:${iz}`;
}

function hasMatrixChanged(left: Float32Array, right: Float32Array): boolean {
  for (let index = 0; index < 16; index += 1) {
    if (Math.abs(left[index] - right[index]) > MATRIX_CHANGE_EPSILON) return true;
  }
  return false;
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

function normalizePositiveFinite(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value !== undefined && value > 0 ? value : fallback;
}

function normalizeNonNegativeFinite(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value !== undefined && value >= 0 ? value : fallback;
}
