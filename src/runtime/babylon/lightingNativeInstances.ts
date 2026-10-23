import { Matrix } from '@babylonjs/core/Maths/math.vector.js';
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import type { AbstractMesh } from '@babylonjs/core';

export type LightingInstance = { mesh: Mesh; sourceMesh: AbstractMesh; entityId: string; sourceIndex: number; worldMatrix: Matrix };
/** 仅依赖公开光照适配能力，普通阵列与脚本内原生 thin instances 共用同一接管协议。 */
export type LightingInstanceBatch = {
  getLightingInstances(): LightingInstance[];
  getLightingInstanceWorldMatrix(mesh: AbstractMesh, sourceIndex: number): Matrix | null;
  setLightingHiddenInstances(hidden: ReadonlyMap<number, ReadonlySet<number>>): void;
  isLightingInstanceVisible?(mesh: AbstractMesh, sourceIndex: number): boolean;
  isLightingInstancePickable?(mesh: AbstractMesh, sourceIndex: number): boolean;
  getLightingRevision?(): number;
};

/** 原生薄实例没有独立的可见前缀管理器，接管整叶片时只隐藏主绘制层，保留全部权威矩阵。 */
class NativeLightingInstances implements LightingInstanceBatch {
  private previousLayerMask: number | null = null;
  private readonly mesh: Mesh;
  private readonly entityId: string;
  constructor(mesh: Mesh, entityId: string) { this.mesh = mesh; this.entityId = entityId; }
  getLightingInstances(): LightingInstance[] {
    const values: LightingInstance[] = [];
    const data = this.mesh._thinInstanceDataStorage?.matrixData;
    if (!data || this.mesh.isDisposed()) return values;
    // 一次枚举只同步一次载体；强制逐实例计算会连带每次重算全部薄实例边界，形成平方开销。
    const carrierWorld = this.mesh.computeWorldMatrix(!this.mesh.isSynchronized());
    for (let index = 0; index < this.mesh.thinInstanceCount; index++) {
      if (data.length < (index + 1) * 16) break;
      const worldMatrix = Matrix.FromArray(data, index * 16).multiply(carrierWorld);
      values.push({ mesh: this.mesh, sourceMesh: this.mesh, entityId: this.entityId, sourceIndex: index, worldMatrix });
    }
    return values;
  }
  getLightingInstanceWorldMatrix(mesh: AbstractMesh, index: number): Matrix | null {
    if (mesh !== this.mesh || mesh.isDisposed() || !Number.isInteger(index) || index < 0 || index >= this.mesh.thinInstanceCount) return null;
    const data = this.mesh._thinInstanceDataStorage?.matrixData;
    if (!data || data.length < (index + 1) * 16) return null;
    // 不缓存实例 Matrix，也不依赖 frameId：同帧父变换与未清 Babylon 缓存的 raw buffer 改写立即可读。
    return Matrix.FromArray(data, index * 16).multiply(this.mesh.computeWorldMatrix(!this.mesh.isSynchronized()));
  }
  isLightingInstanceVisible(mesh: AbstractMesh, index: number): boolean {
    const data = this.mesh._thinInstanceDataStorage?.matrixData;
    return mesh === this.mesh && !mesh.isDisposed() && Number.isInteger(index) && index >= 0 && index < this.mesh.thinInstanceCount
      && Boolean(data && data.length >= (index + 1) * 16) && mesh.isEnabled() && mesh.isVisible && mesh.visibility > 0;
  }
  isLightingInstancePickable(mesh: AbstractMesh, index: number): boolean {
    return this.isLightingInstanceVisible(mesh, index) && mesh.isPickable;
  }
  setLightingHiddenInstances(hidden: ReadonlyMap<number, ReadonlySet<number>>): void {
    const indexes = hidden.get(this.mesh.uniqueId);
    if (indexes?.size) {
      if (indexes.size !== this.mesh.thinInstanceCount || [...indexes].some(index => index < 0 || index >= this.mesh.thinInstanceCount)) {
        throw new Error(`原生薄实例「${this.mesh.name}」需要完整接管每个实例，不能只隐藏部分源叶片。`);
      }
      this.previousLayerMask ??= this.mesh.layerMask;
      this.mesh.layerMask = 0;
    } else if (this.previousLayerMask !== null) {
      if (!this.mesh.isDisposed() && this.mesh.layerMask === 0) this.mesh.layerMask = this.previousLayerMask;
      this.previousLayerMask = null;
    }
  }
}
const adapters = new WeakMap<Mesh, NativeLightingInstances>();
export function getNativeLightingInstances(mesh: Mesh, entityId: string): LightingInstanceBatch {
  let adapter = adapters.get(mesh);
  if (!adapter) { adapter = new NativeLightingInstances(mesh, entityId); adapters.set(mesh, adapter); }
  return adapter;
}
