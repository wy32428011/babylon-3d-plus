import { registerGeometryUpdateDelegate } from './lightingGeometryUpdates.ts';
import { InstancedMesh } from '@babylonjs/core/Meshes/instancedMesh.js';
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData.js';
import { SubMesh } from '@babylonjs/core/Meshes/subMesh.js';
import type { AbstractMesh, Geometry, Scene } from '@babylonjs/core';
import { lightingContentHash } from '../../../electron/shared/sceneLightingBakeContract.ts';
import type { LightingRuntimeSource } from './lightingClassificationRuntime.ts';
import { lightingSourceVisible, sourceGeometryMesh } from './lightingRuntimeCapture.ts';

type InstanceBatch = NonNullable<LightingRuntimeSource['instance']>['batch'];
type ShadowInstanceRecord = { source: LightingRuntimeSource; mesh: Mesh; proxy: true };
type GeometryState = {
  geometry: Geometry;
  source: Geometry | null;
  previous: Geometry['onGeometryUpdated'] | null;
  listener: Geometry['onGeometryUpdated'] | null;
  dirty: boolean;
};

/** 无 GI 时只拆分规则冲突的实例族，不创建烘焙资源或改变业务权威矩阵。 */
export class LightingShadowInstanceRuntime {
  readonly records: ShadowInstanceRecord[] = [];
  readonly hiddenSources = new Map<AbstractMesh, number>();
  readonly hiddenInstances = new Map<InstanceBatch, Map<number, Set<number>>>();
  private readonly sourceLayerMasks = new Map<AbstractMesh, number>();
  private readonly sourcePickability = new Map<AbstractMesh, boolean>();
  private readonly geometries = new Map<Mesh, GeometryState>();
  private layoutKey = lightingContentHash([]);

  constructor(private readonly scene: Scene, private readonly beforeChange: () => void) {}

  getSourceLayerMask(mesh: AbstractMesh): number | undefined { return this.sourceLayerMasks.get(mesh); }
  getSourcePickability(mesh: AbstractMesh): boolean | undefined { return this.sourcePickability.get(mesh); }

  sync(sources: readonly LightingRuntimeSource[], enabled: boolean): boolean {
    const selected = enabled ? this.selectConflictingSources(sources) : [];
    const key = lightingContentHash(selected.map(source => [source.entry.key, source.mesh.uniqueId,
      source.instance?.sourceIndex, source.entry.mobility, source.entry.castShadows, source.entry.receiveShadows]));
    if (key === this.layoutKey) return false;
    this.beforeChange();
    this.clear();
    this.layoutKey = key;
    if (!selected.length) return true;
    try {
      for (const source of selected) {
        const original = sourceGeometryMesh(source.mesh);
        const proxy = new Mesh(`__LightingShadowInstance_${lightingContentHash(source.entry.key)}`, this.scene);
        proxy.setEnabled(false);
        this.records.push({ source, mesh: proxy, proxy: true });
        let geometry = this.geometries.get(original);
        if (!geometry) {
          VertexData.ExtractFromMesh(original, true, true).applyToMesh(proxy, false);
          if (!proxy.geometry) throw new Error(`实例「${source.entry.name}」缺少可绘制几何。`);
          geometry = { geometry: proxy.geometry, source: null, previous: null, listener: null, dirty: false };
          this.geometries.set(original, geometry);
          this.installGeometryHook(original, geometry);
        } else geometry.geometry.applyToMesh(proxy);
        this.copySubMeshes(original, proxy);
        proxy.metadata = { ...source.mesh.metadata, lightingDerived: true, lightingShadowOnly: true,
          lightingSourceKey: source.entry.key, entityId: source.entry.entityId, editorEntityId: source.entry.entityId };
        proxy.layerMask = source.mesh.layerMask;
        this.sourceLayerMasks.set(source.mesh, source.mesh.layerMask);
        proxy.isPickable = source.instance?.batch.isLightingInstancePickable?.(source.instance.mesh, source.instance.sourceIndex)
          ?? source.mesh.isPickable;
        this.sourcePickability.set(source.mesh, source.mesh.isPickable);
        proxy.overrideMaterialSideOrientation = original.overrideMaterialSideOrientation;
        if (source.instance) {
          const hidden = this.hiddenInstances.get(source.instance.batch) ?? new Map<number, Set<number>>();
          const indexes = hidden.get(source.instance.mesh.uniqueId) ?? new Set<number>();
          indexes.add(source.instance.sourceIndex); hidden.set(source.instance.mesh.uniqueId, indexes);
          this.hiddenInstances.set(source.instance.batch, hidden);
        } else this.hiddenSources.set(source.mesh, source.mesh.layerMask);
      }
      // 整个冲突薄实例分片一起接管，兼容只支持完整接管的原生 thin-instance 适配器。
      for (const [batch, hidden] of this.hiddenInstances) batch.setLightingHiddenInstances(hidden);
      for (const [source] of this.hiddenSources) source.layerMask = 0;
      this.update();
      return true;
    } catch (error) { this.clear(); throw error; }
  }

  update(): void {
    for (const [original, state] of this.geometries) {
      if (original.isDisposed()) continue;
      if (original.geometry !== state.source) { this.installGeometryHook(original, state); state.dirty = true; }
      if (!state.dirty) continue;
      VertexData.ExtractFromMesh(original, true, true).applyToGeometry(state.geometry, true);
      for (const record of this.records) if (sourceGeometryMesh(record.source.mesh) === original) {
        this.copySubMeshes(original, record.mesh);
        record.mesh.refreshBoundingInfo();
      }
      state.dirty = false;
    }
    for (const { source, mesh } of this.records) {
      if (source.mesh.isDisposed()) { mesh.setEnabled(false); continue; }
      const world = source.getWorldMatrix();
      // 阵列载体在叶片全被接管后会禁用，业务显隐应读适配器的权威状态。
      mesh.setEnabled(Boolean(world));
      if (!world) continue;
      const original = sourceGeometryMesh(source.mesh);
      mesh.setPreTransformMatrix(world); mesh.computeWorldMatrix(true);
      mesh.isVisible = lightingSourceVisible(source); mesh.visibility = source.mesh.visibility;
      mesh.material = source.mesh.material;
      mesh.skeleton = original.skeleton; mesh.morphTargetManager = original.morphTargetManager;
      mesh.useVertexColors = original.useVertexColors; mesh.hasVertexAlpha = original.hasVertexAlpha;
      mesh.renderingGroupId = source.mesh.renderingGroupId; mesh.receiveShadows = source.entry.receiveShadows;
      mesh.alphaIndex = source.mesh.alphaIndex; mesh.applyFog = source.mesh.applyFog;
      mesh.isPickable = source.instance
        ? source.instance.batch.isLightingInstancePickable?.(source.instance.mesh, source.instance.sourceIndex)
          ?? this.sourcePickability.get(source.mesh) ?? source.mesh.isPickable
        : source.mesh.isPickable;
    }
  }

  clear(): void {
    for (const state of this.geometries.values()) this.removeGeometryHook(state);
    for (const [source, layerMask] of this.hiddenSources) if (!source.isDisposed() && source.layerMask === 0) source.layerMask = layerMask;
    for (const [batch] of this.hiddenInstances) batch.setLightingHiddenInstances(new Map());
    for (const record of this.records) record.mesh.dispose(false, false);
    this.records.length = 0; this.hiddenSources.clear(); this.hiddenInstances.clear(); this.sourceLayerMasks.clear(); this.sourcePickability.clear();
    this.geometries.clear(); this.layoutKey = lightingContentHash([]);
  }

  private selectConflictingSources(sources: readonly LightingRuntimeSource[]): LightingRuntimeSource[] {
    const thinGroups = new Map<AbstractMesh, LightingRuntimeSource[]>();
    const nativeGroups = new Map<Mesh, LightingRuntimeSource[]>();
    const byMesh = new Map(sources.map(source => [source.mesh, source]));
    for (const source of sources) {
      if (source.instance) {
        const group = thinGroups.get(source.mesh) ?? []; group.push(source); thinGroups.set(source.mesh, group);
      } else if (source.mesh instanceof InstancedMesh) {
        const group = nativeGroups.get(source.mesh.sourceMesh) ?? []; group.push(source); nativeGroups.set(source.mesh.sourceMesh, group);
      }
    }
    const selected: LightingRuntimeSource[] = [];
    const same = (a: LightingRuntimeSource['entry'], b: Pick<LightingRuntimeSource['entry'], 'castShadows' | 'receiveShadows'>) =>
      a.castShadows === b.castShadows && a.receiveShadows === b.receiveShadows;
    for (const group of thinGroups.values()) {
      if (group.some(source => !same(source.entry, group[0].entry))) selected.push(...group);
    }
    for (const [carrier, group] of nativeGroups) {
      const carrierRole = byMesh.get(carrier)?.entry ?? { castShadows: true, receiveShadows: true };
      if (group.some(source => !same(source.entry, carrierRole))) selected.push(...group);
    }
    return selected;
  }

  private copySubMeshes(original: Mesh, proxy: Mesh): void {
    proxy.releaseSubMeshes();
    for (const sub of original.subMeshes) new SubMesh(sub.materialIndex, sub.verticesStart, sub.verticesCount, sub.indexStart, sub.indexCount, proxy);
  }

  private removeGeometryHook(state: GeometryState): void {
    // listener 仍匹配时表示钩子已安装，previous 保存的是安装前的实际回调。
    if (state.source?.onGeometryUpdated === state.listener) state.source.onGeometryUpdated = state.previous!;
    state.source = null; state.previous = null; state.listener = null;
  }

  private installGeometryHook(original: Mesh, state: GeometryState): void {
    this.removeGeometryHook(state);
    const geometry = original.geometry;
    if (!geometry) return;
    const previous = geometry.onGeometryUpdated;
    const listener: Geometry['onGeometryUpdated'] = (value, kind) => {
      previous?.(value, kind);
      if (kind && ['world0', 'world1', 'world2', 'world3', 'instanceSelectionId'].includes(kind)) return;
      state.dirty = true;
    };
    registerGeometryUpdateDelegate(geometry, listener, previous);
    state.source = geometry; state.previous = previous; state.listener = listener; geometry.onGeometryUpdated = listener;
  }
}
