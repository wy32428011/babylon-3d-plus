import { VertexBuffer } from '@babylonjs/core/Buffers/buffer.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData.js';
import type { AbstractMesh, Geometry, Scene } from '@babylonjs/core';
import type { ManualRoamPoint } from './manualRoamCollisionBounds.ts';
import { resolveManualRoamCollisionStyle } from './manualRoamCollisionPolicy.ts';
import { acquireCollisionGeometryRevision } from './collisionGeometryRevision.ts';

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
  geometry: Geometry | null;
  geometryRevision: number;
  revisionObserver: ReturnType<typeof acquireCollisionGeometryRevision> | null;
  indices: ReturnType<AbstractMesh['getIndices']>;
  visible: boolean;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
  worldPositions: Float32Array;
  cells: Map<string, number[]>;
};

type NearbyCollisionCell = {
  key: string;
  distanceSquared: number;
  triangleCount: number;
  parts: Array<{ indexed: IndexedCollisionMesh; triangleIndexes: number[] }>;
};

const DEFAULT_CELL_SIZE_METERS = 4;
const DEFAULT_MAX_COLLIDER_MESHES = 64;
const DEFAULT_MAX_TRIANGLES = 24_576;
const DEFAULT_REFRESH_INTERVAL_MS = 180;
const DEFAULT_REFRESH_DISTANCE_METERS = 0.75;
const TRIANGLES_PER_MESH = 384;

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
  private contentRevision = 0;
  private lastQueryRevision = -1;
  private lastRadiusMeters = 0;
  private indexBuildCount = 0;
  private proxyUploadCount = 0;
  private lastNearbyCells: NearbyCollisionCell[] | null = null;

  /** 仅返回计数，供性能运行和回归验证；不采集模型名称或顶点内容。 */
  getPerformanceMetrics() {
    return { indexedMeshes: this.indexedMeshes.size, activeProxies: this.currentActiveCount,
      indexBuildCount: this.indexBuildCount, proxyUploadCount: this.proxyUploadCount };
  }

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
      if (!seen.has(uniqueId)) this.removeIndexedMesh(uniqueId);
    }
  }

  /** 按碰撞策略决定索引或移除单个网格。 */
  observe(mesh: AbstractMesh): void {
    if (resolveManualRoamCollisionStyle(mesh) !== 'local-triangle') {
      this.removeIndexedMesh(mesh.uniqueId);
      return;
    }
    this.indexMesh(mesh);
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
    if (!force && this.lastQueryRevision === this.contentRevision
      && this.lastRadiusMeters === radiusMeters && this.lastPosition
      && squaredDistance(position, this.lastPosition) === 0) {
      this.lastRefreshMs = nowMs;
      return false;
    }
    const cells = this.collectNearbyCells(position, radiusMeters);
    if (!force && haveSameCollisionCells(this.lastNearbyCells, cells)) {
      this.rememberQuery(position, radiusMeters, nowMs);
      return false;
    }
    let triangleBudget = this.maxTriangles;
    let meshIndex = 0;
    let currentPositions: number[] = [];

    const flush = (): void => {
      if (meshIndex >= this.maxColliderMeshes || currentPositions.length < 9) {
        currentPositions = [];
        return;
      }
      const proxy = this.getOrCreateProxy(meshIndex);
      if (applyWorldTriangles(proxy, currentPositions)) this.proxyUploadCount += 1;
      proxy.isVisible = this.debugVisible;
      proxy.visibility = this.debugVisible ? 0.22 : 0;
      proxy.setEnabled(true);
      proxy.computeWorldMatrix(true);
      meshIndex += 1;
      currentPositions = [];
    };

    for (const cell of cells) {
      const cellTriangles = cell.triangleCount;
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
      // 保留原有格子、网格和三角顺序；只有候选变化后才展开坐标，不缓存近似碰撞体。
      for (const part of cell.parts) {
        for (const triangleIndex of part.triangleIndexes) {
          const offset = triangleIndex * 9;
          for (let component = 0; component < 9; component += 1) {
            currentPositions.push(part.indexed.worldPositions[offset + component]);
          }
        }
      }
      triangleBudget -= cellTriangles;
      if (currentPositions.length / 9 >= TRIANGLES_PER_MESH) flush();
    }
    flush();

    for (let index = meshIndex; index < this.proxies.length; index += 1) {
      this.proxies[index].setEnabled(false);
    }
    this.currentActiveCount = meshIndex;
    this.lastNearbyCells = cells;
    this.rememberQuery(position, radiusMeters, nowMs);
    return true;
  }

  private rememberQuery(position: Readonly<ManualRoamPoint>, radiusMeters: number, nowMs: number): void {
    this.lastPosition = { ...position };
    this.lastRefreshMs = nowMs;
    this.lastQueryRevision = this.contentRevision;
    this.lastRadiusMeters = radiusMeters;
  }

  setDebugVisible(visible: boolean): void {
    this.debugVisible = visible;
    for (let index = 0; index < this.currentActiveCount; index += 1) {
      const proxy = this.proxies[index];
      proxy.isVisible = visible;
      proxy.visibility = visible ? 0.22 : 0;
    }
  }

  /**
   * 直接在世界坐标空间格子中求垂直向下射线的最高可行走交点，
   * 避免脚部贴地探测和步阶检测反复调用全场景 pickWithRay。
   */
  probeVerticalRay(
    x: number,
    z: number,
    originY: number,
    length: number,
    minNormalY: number,
  ): { y: number; normal: Vector3 } | null {
    if (
      this.indexedMeshes.size === 0
      || !Number.isFinite(x)
      || !Number.isFinite(z)
      || !Number.isFinite(originY)
      || !Number.isFinite(length)
      || length <= 0
    ) {
      return null;
    }
    const minRayY = originY - length;
    const cellSize = this.cellSizeMeters;
    const ix = Math.floor(x / cellSize);
    const iz = Math.floor(z / cellSize);
    const minIy = Math.floor(minRayY / cellSize);
    const maxIy = Math.floor(originY / cellSize);
    const rayTop = originY + 1e-5;
    const rayBottom = minRayY - 1e-5;

    let bestY = Number.NEGATIVE_INFINITY;
    let bestNx = 0;
    let bestNy = 1;
    let bestNz = 0;

    for (const indexed of this.indexedMeshes.values()) {
      if (
        indexed.mesh.isDisposed()
        || !indexed.mesh.isEnabled()
        || !indexed.mesh.isVisible
        || indexed.mesh.visibility <= 0
      ) continue;
      if (
        x < indexed.minX - 1e-5
        || x > indexed.maxX + 1e-5
        || z < indexed.minZ - 1e-5
        || z > indexed.maxZ + 1e-5
        || indexed.maxY < rayBottom
        || indexed.minY > rayTop
      ) continue;

      const worldPositions = indexed.worldPositions;
      for (let iy = maxIy; iy >= minIy; iy -= 1) {
        const triangleIndexes = indexed.cells.get(makeCellKey(ix, iy, iz));
        if (!triangleIndexes) continue;
        for (let i = 0; i < triangleIndexes.length; i += 1) {
          const offset = triangleIndexes[i] * 9;
          const ax = worldPositions[offset];
          const ay = worldPositions[offset + 1];
          const az = worldPositions[offset + 2];
          const bx = worldPositions[offset + 3];
          const by = worldPositions[offset + 4];
          const bz = worldPositions[offset + 5];
          const cx = worldPositions[offset + 6];
          const cy = worldPositions[offset + 7];
          const cz = worldPositions[offset + 8];

          const triMaxY = ay >= by ? (ay >= cy ? ay : cy) : (by >= cy ? by : cy);
          if (triMaxY < rayBottom || triMaxY <= bestY) continue;
          const triMinY = ay <= by ? (ay <= cy ? ay : cy) : (by <= cy ? by : cy);
          if (triMinY > rayTop) continue;

          const triMinX = ax <= bx ? (ax <= cx ? ax : cx) : (bx <= cx ? bx : cx);
          const triMaxX = ax >= bx ? (ax >= cx ? ax : cx) : (bx >= cx ? bx : cx);
          if (x < triMinX - 1e-5 || x > triMaxX + 1e-5) continue;
          const triMinZ = az <= bz ? (az <= cz ? az : cz) : (bz <= cz ? bz : cz);
          const triMaxZ = az >= bz ? (az >= cz ? az : cz) : (bz >= cz ? bz : cz);
          if (z < triMinZ - 1e-5 || z > triMaxZ + 1e-5) continue;

          const e1x = bx - ax;
          const e1y = by - ay;
          const e1z = bz - az;
          const e2x = cx - ax;
          const e2y = cy - ay;
          const e2z = cz - az;
          // Babylon 左手系正面法线为 cross(e2, e1)，垂直分量即 det。
          const det = e2z * e1x - e2x * e1z;
          if (det <= 1e-12) continue;

          const dx = x - ax;
          const dz = z - az;
          const uNum = dx * e2z - dz * e2x;
          const vNum = e1x * dz - e1z * dx;
          const eps = 1e-6 * det;
          if (uNum < -eps || vNum < -eps || uNum + vNum > det + eps) continue;

          const hitY = ay + (uNum * e1y + vNum * e2y) / det;
          if (hitY > rayTop || hitY < rayBottom || hitY <= bestY) continue;

          const nx = e2y * e1z - e2z * e1y;
          const nz = e2x * e1y - e2y * e1x;
          const normalLength = Math.hypot(nx, det, nz);
          if (normalLength <= 1e-12) continue;
          const invLen = 1 / normalLength;
          const nyNorm = det * invLen;
          if (nyNorm < minNormalY) continue;

          bestY = hitY;
          bestNx = nx * invLen;
          bestNy = nyNorm;
          bestNz = nz * invLen;
        }
      }
    }

    if (!Number.isFinite(bestY)) return null;
    return { y: bestY, normal: new Vector3(bestNx, bestNy, bestNz) };
  }

  deactivate(): void {
    for (const proxy of this.proxies) proxy.setEnabled(false);
    this.currentActiveCount = 0;
    this.lastPosition = null;
    this.lastNearbyCells = null;
    this.lastQueryRevision = -1;
    this.lastRefreshMs = Number.NEGATIVE_INFINITY;
  }

  dispose(): void {
    this.clearScene();
    for (const proxy of this.proxies) proxy.dispose(false, false);
    this.proxies.length = 0;
    this.proxySet.clear();
    this.material.dispose();
  }

  /** 场景代次变化立即释放旧环境索引，不等待用户在新场景再次开启漫游。 */
  clearScene(): void {
    this.deactivate();
    for (const uniqueId of this.indexedMeshes.keys()) this.removeIndexedMesh(uniqueId);
  }

  private refreshChangedIndexes(): void {
    for (const indexed of [...this.indexedMeshes.values()]) {
      const mesh = indexed.mesh;
      if (mesh.isDisposed() || resolveManualRoamCollisionStyle(mesh) !== 'local-triangle') {
        this.removeIndexedMesh(indexed.uniqueId);
        continue;
      }
      this.indexMesh(mesh);
    }
  }

  private removeIndexedMesh(uniqueId: number): void {
    const indexed = this.indexedMeshes.get(uniqueId);
    if (!indexed) return;
    indexed.revisionObserver?.release();
    this.indexedMeshes.delete(uniqueId);
    this.lastNearbyCells = null;
    this.contentRevision += 1;
  }

  private indexMesh(mesh: AbstractMesh): void {
    const existing = this.indexedMeshes.get(mesh.uniqueId);
    const matrix = mesh.computeWorldMatrix(!mesh.isSynchronized()).m;
    const vertexCount = mesh.getTotalVertices();
    const geometry = mesh.geometry;
    // Babylon updateIndices 的可更新路径不触发 onGeometryUpdated，但会替换 CPU 索引数组。
    const indices = mesh.getIndices();
    const geometryRevision = existing?.geometry === geometry ? existing.revisionObserver?.read() ?? -1 : -1;
    const visible = mesh.isEnabled() && mesh.isVisible && mesh.visibility > 0;
    if (existing && existing.visible !== visible) {
      existing.visible = visible;
      this.contentRevision += 1;
    }
    if (
      existing && geometry
      && existing.geometry === geometry && existing.geometryRevision === geometryRevision
      && existing.indices === indices
      && existing.vertexCount === vertexCount
      && !hasMatrixChanged(existing.worldMatrix, matrix)
    ) return;

    const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
    if (!positions || !indices || indices.length < 3) {
      this.removeIndexedMesh(mesh.uniqueId);
      return;
    }

    const worldMatrix = Float32Array.from(matrix);
    const revisionObserver = existing?.geometry === geometry
      ? existing.revisionObserver : geometry ? acquireCollisionGeometryRevision(geometry) : null;
    if (existing && existing.revisionObserver !== revisionObserver) existing.revisionObserver?.release();

    const triangleCount = Math.floor(indices.length / 3);
    const worldPositions = new Float32Array(triangleCount * 9);
    const cells = new Map<string, number[]>();
    const cellSize = this.cellSizeMeters;
    const m = worldMatrix;
    const determinant = m[0] * (m[5] * m[10] - m[6] * m[9])
      - m[1] * (m[4] * m[10] - m[6] * m[8])
      + m[2] * (m[4] * m[9] - m[5] * m[8]);
    const invertWinding = determinant < 0;
    let packedTriangleCount = 0;
    let meshMinX = Number.POSITIVE_INFINITY;
    let meshMaxX = Number.NEGATIVE_INFINITY;
    let meshMinY = Number.POSITIVE_INFINITY;
    let meshMaxY = Number.NEGATIVE_INFINITY;
    let meshMinZ = Number.POSITIVE_INFINITY;
    let meshMaxZ = Number.NEGATIVE_INFINITY;
    for (let index = 0; index + 2 < indices.length; index += 3) {
      const i0 = indices[index] * 3;
      const i1 = indices[invertWinding ? index + 2 : index + 1] * 3;
      const i2 = indices[invertWinding ? index + 1 : index + 2] * 3;
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
      const wax = ax * m[0] + ay * m[4] + az * m[8] + m[12];
      const way = ax * m[1] + ay * m[5] + az * m[9] + m[13];
      const waz = ax * m[2] + ay * m[6] + az * m[10] + m[14];
      const wbx = bx * m[0] + by * m[4] + bz * m[8] + m[12];
      const wby = bx * m[1] + by * m[5] + bz * m[9] + m[13];
      const wbz = bx * m[2] + by * m[6] + bz * m[10] + m[14];
      const wcx = cx * m[0] + cy * m[4] + cz * m[8] + m[12];
      const wcy = cx * m[1] + cy * m[5] + cz * m[9] + m[13];
      const wcz = cx * m[2] + cy * m[6] + cz * m[10] + m[14];
      worldPositions[packedIndex] = wax;
      worldPositions[packedIndex + 1] = way;
      worldPositions[packedIndex + 2] = waz;
      worldPositions[packedIndex + 3] = wbx;
      worldPositions[packedIndex + 4] = wby;
      worldPositions[packedIndex + 5] = wbz;
      worldPositions[packedIndex + 6] = wcx;
      worldPositions[packedIndex + 7] = wcy;
      worldPositions[packedIndex + 8] = wcz;
      if (wax < meshMinX) meshMinX = wax;
      if (wbx < meshMinX) meshMinX = wbx;
      if (wcx < meshMinX) meshMinX = wcx;
      if (wax > meshMaxX) meshMaxX = wax;
      if (wbx > meshMaxX) meshMaxX = wbx;
      if (wcx > meshMaxX) meshMaxX = wcx;
      if (way < meshMinY) meshMinY = way;
      if (wby < meshMinY) meshMinY = wby;
      if (wcy < meshMinY) meshMinY = wcy;
      if (way > meshMaxY) meshMaxY = way;
      if (wby > meshMaxY) meshMaxY = wby;
      if (wcy > meshMaxY) meshMaxY = wcy;
      if (waz < meshMinZ) meshMinZ = waz;
      if (wbz < meshMinZ) meshMinZ = wbz;
      if (wcz < meshMinZ) meshMinZ = wcz;
      if (waz > meshMaxZ) meshMaxZ = waz;
      if (wbz > meshMaxZ) meshMaxZ = wbz;
      if (wcz > meshMaxZ) meshMaxZ = wcz;
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
      geometry,
      geometryRevision: revisionObserver?.read() ?? -1,
      revisionObserver,
      indices,
      visible,
      minX: meshMinX,
      maxX: meshMaxX,
      minY: meshMinY,
      maxY: meshMaxY,
      minZ: meshMinZ,
      maxZ: meshMaxZ,
      worldPositions: packedTriangleCount === triangleCount
        ? worldPositions
        : worldPositions.slice(0, packedTriangleCount * 9),
      cells,
    });
    this.indexBuildCount += 1;
    this.contentRevision += 1;
  }

  private collectNearbyCells(
    position: Readonly<ManualRoamPoint>,
    radiusMeters: number,
  ): NearbyCollisionCell[] {
    const cellSize = this.cellSizeMeters;
    const minIx = Math.floor((position.x - radiusMeters) / cellSize);
    const maxIx = Math.floor((position.x + radiusMeters) / cellSize);
    const minIy = Math.floor((position.y - radiusMeters) / cellSize);
    const maxIy = Math.floor((position.y + radiusMeters) / cellSize);
    const minIz = Math.floor((position.z - radiusMeters) / cellSize);
    const maxIz = Math.floor((position.z + radiusMeters) / cellSize);
    const merged = new Map<string, NearbyCollisionCell>();
    // 通常为固定 24 米邻域，格子 key 只计算一次；异常大的查询仍沿用逐格遍历，避免无界数组。
    const queryCells: Array<{ key: string; ix: number; iy: number; iz: number }> | null =
      (maxIx - minIx + 1) * (maxIy - minIy + 1) * (maxIz - minIz + 1) <= 8192 ? [] : null;
    if (queryCells) {
      for (let ix = minIx; ix <= maxIx; ix += 1) {
        for (let iy = minIy; iy <= maxIy; iy += 1) {
          for (let iz = minIz; iz <= maxIz; iz += 1) queryCells.push({ key: makeCellKey(ix, iy, iz), ix, iy, iz });
        }
      }
    }
    const append = (indexed: IndexedCollisionMesh, key: string, ix: number, iy: number, iz: number) => {
      const triangleIndexes = indexed.cells.get(key);
      if (!triangleIndexes?.length) return;
      let cell = merged.get(key);
      if (!cell) {
        const dx = position.x - (ix + 0.5) * cellSize;
        const dy = position.y - (iy + 0.5) * cellSize;
        const dz = position.z - (iz + 0.5) * cellSize;
        cell = { key, distanceSquared: dx * dx + dy * dy + dz * dz, triangleCount: 0, parts: [] };
        merged.set(key, cell);
      }
      cell.parts.push({ indexed, triangleIndexes });
      cell.triangleCount += triangleIndexes.length;
    };

    const qMinX = position.x - radiusMeters;
    const qMaxX = position.x + radiusMeters;
    const qMinY = position.y - radiusMeters;
    const qMaxY = position.y + radiusMeters;
    const qMinZ = position.z - radiusMeters;
    const qMaxZ = position.z + radiusMeters;

    for (const indexed of this.indexedMeshes.values()) {
      if (
        indexed.mesh.isDisposed()
        || !indexed.mesh.isEnabled()
        || !indexed.mesh.isVisible
        || indexed.mesh.visibility <= 0
        || indexed.maxX < qMinX
        || indexed.minX > qMaxX
        || indexed.maxY < qMinY
        || indexed.minY > qMaxY
        || indexed.maxZ < qMinZ
        || indexed.minZ > qMaxZ
      ) continue;
      if (queryCells) {
        for (const cell of queryCells) append(indexed, cell.key, cell.ix, cell.iy, cell.iz);
        continue;
      }
      for (let ix = minIx; ix <= maxIx; ix += 1) {
        for (let iy = minIy; iy <= maxIy; iy += 1) {
          for (let iz = minIz; iz <= maxIz; iz += 1) {
            append(indexed, makeCellKey(ix, iy, iz), ix, iy, iz);
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
    proxy.isVisible = this.debugVisible;
    proxy.visibility = this.debugVisible ? 0.22 : 0;
    proxy.doNotSerialize = true;
    proxy.material = this.material;
    proxy.metadata = { manualRoamLocalTriangleCollider: true };
    this.proxies.push(proxy);
    this.proxySet.add(proxy);
    return proxy;
  }
}

function haveSameCollisionCells(previous: readonly NearbyCollisionCell[] | null, current: readonly NearbyCollisionCell[]): boolean {
  if (!previous || previous.length !== current.length) return false;
  return current.every((cell, index) => {
    const old = previous[index];
    return old.key === cell.key && old.parts.length === cell.parts.length
      && cell.parts.every((part, partIndex) => part.indexed === old.parts[partIndex].indexed
        && part.triangleIndexes === old.parts[partIndex].triangleIndexes);
  });
}

function applyWorldTriangles(mesh: Mesh, positions: number[]): boolean {
  const previous = mesh.getVerticesData(VertexBuffer.PositionKind);
  if (previous?.length === positions.length && positions.every((value, index) => value === previous[index])) return false;
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
  return true;
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

function hasMatrixChanged(left: Float32Array, right: ArrayLike<number>): boolean {
  for (let index = 0; index < 16; index += 1) {
    // 原索引使用 Float32 矩阵；精确比较同一表示，不通过额外容差省略碰撞变换。
    if (left[index] !== Math.fround(right[index])) return true;
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
