import { HybridShadowNumericSignature, legacyHybridShadowSignature } from './hybridShadowSignatures.ts';
import { registerGeometryUpdateDelegate } from './lightingGeometryUpdates.ts';
import {
  captureHybridShadowBounds, getHybridShadowSubMeshFallback,
  HybridShadowChangeHistory,
  type HybridShadowBoundsSnapshot, type HybridShadowChange, type HybridShadowFallbackReason,
  type HybridShadowInvalidationMetrics, type HybridShadowInvalidationMode, type HybridShadowProjection,
} from './hybridShadowInvalidation.ts';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight.js';
import { PointLight } from '@babylonjs/core/Lights/pointLight.js';
import { SpotLight } from '@babylonjs/core/Lights/spotLight.js';
import { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator.js';
import { RenderTargetTexture } from '@babylonjs/core/Materials/Textures/renderTargetTexture.js';
import { Texture } from '@babylonjs/core/Materials/Textures/texture.js';
import { CascadedShadowGenerator } from '@babylonjs/core/Lights/Shadows/cascadedShadowGenerator.js';
import { InstancedMesh } from '@babylonjs/core/Meshes/instancedMesh.js';
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { SmartArray } from '@babylonjs/core/Misc/smartArray.js';
import type { AbstractEngine, AbstractMesh, Geometry, Observer, Scene, SubMesh } from '@babylonjs/core';

export type HybridShadowMeshRole = {
  mobility: 'static' | 'dynamic';
  castShadows: boolean;
  receiveShadows: boolean;
};
export type HybridShadowOptions = { cacheStaticShadows?: boolean; dynamicShadows?: boolean };
export type NativeShadowRefreshPolicy = 'every-frame' | 'render-once';
export type NativeShadowCacheDiagnostics = {
  backend: 'babylon-native';
  cacheScope: 'whole-map';
  requestedInvalidationMode: HybridShadowInvalidationMode;
  localInvalidationApplied: false;
  /** 原生整图完成次数；立方图六个面合计一次，不含只读 readiness 预热。 */
  nativeMapRenders: number;
};
export type HybridShadowMetrics = HybridShadowInvalidationMetrics & NativeShadowCacheDiagnostics & {
  /** 原生 onAfterShadowMapRenderMeshObservable 的静态/动态提交次数，不再表示分阶段渲染。 */
  staticRenders: number;
  dynamicRenders: number;
  cacheInvalidations: number;
  staticCasterCount: number;
  dynamicCasterCount: number;
  /** 额外缓存显存；原生调度不分配副本，恒为 0。 */
  textureBytes: number;
  /** 每灯每帧最多一次的原生整图复用计数。 */
  cacheHits: number;
  cachedFaces: number;
  unsupportedCacheReason: string | null;
  validationErrors: string[];
};

type GeometryWatch = {
  previous: Geometry['onGeometryUpdated'];
  callback: Geometry['onGeometryUpdated'];
  version: number;
  boundsUncertain: boolean;
};

/**
 * 静态只描述可缓存的投射几何。带变形或动态实例的批次保守归入动态投射集合，
 * 不改变业务侧的静态接收/lightmap 身份，避免把动画姿态留在静态缓存中。
 */
export class HybridShadowMeshState {
  readonly staticMeshes = new Set<AbstractMesh>();
  readonly dynamicMeshes = new Set<AbstractMesh>();
  revision = 0;
  membershipRevision = 0;
  private candidates: AbstractMesh[] = [];
  private roles: ReadonlyMap<AbstractMesh, HybridShadowMeshRole> = new Map();
  private readonly staticRenderingMeshes = new Set<Mesh>();
  private readonly signatures = new Map<AbstractMesh, string>();
  private readonly numericSignatures = new Map<AbstractMesh, HybridShadowNumericSignature>();
  private signatureMode: 'numeric' | 'legacy' = 'numeric';
  private readonly geometrySignatures = new Map<AbstractMesh, { id: number | undefined; version: number }>();
  private readonly geometries = new Map<Geometry, GeometryWatch>();
  private refreshedFrame = -1;
  private readonly localConsumers = new Set<object>();
  private readonly localHistory = new HybridShadowChangeHistory();
  private readonly localBounds = new Map<AbstractMesh, HybridShadowBoundsSnapshot>();
  private readonly expectedStaticSubMeshes = new Set<SubMesh>();
  private readonly submittedStaticSubMeshes = new Set<SubMesh>();

  /** 局部诊断关闭时不维护 bounds/提交集合，默认路径保留原扫描开销。 */
  setLocalInvalidationConsumer(consumer: object, enabled: boolean): void {
    const wasTracking = this.localConsumers.size > 0;
    if (enabled) this.localConsumers.add(consumer);
    else this.localConsumers.delete(consumer);
    if (wasTracking === (this.localConsumers.size > 0)) return;
    this.localBounds.clear();
    this.expectedStaticSubMeshes.clear();
    this.submittedStaticSubMeshes.clear();
    this.localHistory.reset(this.revision);
    this.markStale();
  }

  evaluateLocalChanges(sinceRevision: number, projection: HybridShadowProjection) {
    return this.localHistory.evaluate(sinceRevision, projection);
  }

  /** 验证实际提交是已签名静态集合；只共用一份临时集合，不按灯/face 复制全场表。 */
  getLocalSubmissionFallback(groups: Iterable<readonly SmartArray<SubMesh>[]>): HybridShadowFallbackReason | null {
    const submitted = this.submittedStaticSubMeshes;
    submitted.clear();
    try {
      for (const lists of groups) for (const list of lists) for (let index = 0; index < list.length; index++) {
        const subMesh = list.data[index];
        if (!this.expectedStaticSubMeshes.has(subMesh)) return 'submission-mismatch';
        const snapshot = this.localBounds.get(subMesh.getEffectiveMesh());
        if (!snapshot?.bounds) return snapshot?.fallbackReason ?? 'unreliable-bounds';
        const reason = getHybridShadowSubMeshFallback(subMesh);
        if (reason) return reason;
        submitted.add(subMesh);
      }
      return submitted.size === this.expectedStaticSubMeshes.size ? null : 'submission-mismatch';
    } finally { submitted.clear(); }
  }

  private recordLocalChange(mesh: AbstractMesh, oldStatic: boolean, newStatic: boolean,
    snapshot: HybridShadowBoundsSnapshot | null, reason: HybridShadowChange['reason'], revision: number): void {
    const previous = this.localBounds.get(mesh);
    this.localHistory.record(revision, {
      meshId: mesh.uniqueId, reason, oldStatic, newStatic,
      oldBounds: oldStatic ? previous?.bounds ?? null : null,
      newBounds: newStatic ? snapshot?.bounds ?? null : null,
      fallbackReason: reason === 'rendering-group' ? 'rendering-group-change'
        : (oldStatic ? previous?.fallbackReason : null) ?? snapshot?.fallbackReason ?? null,
    });
    if (snapshot) this.localBounds.set(mesh, snapshot);
    else this.localBounds.delete(mesh);
  }

  setMeshes(meshes: Iterable<AbstractMesh>, roles: ReadonlyMap<AbstractMesh, HybridShadowMeshRole>): void {
    this.candidates = [...meshes];
    this.roles = roles;
    this.updateMembership();
    this.refreshedFrame = -1;
  }

  /** 运行期新增骨骼、morph、薄实例等也必须重新分类，不能依赖场景网格数量变化。 */
  private updateMembership(): void {
    const roles = this.roles;
    const candidates = this.candidates.filter(mesh => roles.get(mesh)?.castShadows !== false && !mesh.isDisposed());
    const batches = new Map<Mesh, AbstractMesh[]>();
    for (const mesh of candidates) {
      const source = mesh instanceof InstancedMesh ? mesh.sourceMesh : mesh instanceof Mesh ? mesh : null;
      if (source) {
        const batch = batches.get(source) ?? [];
        batch.push(mesh);
        batches.set(source, batch);
      }
    }
    // 每个实例源只判定一次，逐轮重分类不能对大批次退化为 N² 扫描。
    const staticBatches = new Set<Mesh>();
    for (const [source, batch] of batches) {
      const deformable = source.skeleton || source.morphTargetManager
        || source.bakedVertexAnimationManager?.isEnabled || source.hasThinInstances;
      if (!deformable && batch.every(member => roles.get(member)?.mobility === 'static')) staticBatches.add(source);
    }
    const nextStatic = new Set<AbstractMesh>(), nextDynamic = new Set<AbstractMesh>();
    for (const mesh of candidates) {
      const source = mesh instanceof InstancedMesh ? mesh.sourceMesh : mesh instanceof Mesh ? mesh : null;
      (source && staticBatches.has(source) ? nextStatic : nextDynamic).add(mesh);
    }
    const changed = nextStatic.size !== this.staticMeshes.size
      || [...nextStatic].some(mesh => !this.staticMeshes.has(mesh));
    if (changed && this.localConsumers.size) {
      const revision = this.revision + 1;
      for (const mesh of this.staticMeshes) if (!nextStatic.has(mesh)) {
        this.recordLocalChange(mesh, true, false, null, 'membership', revision);
      }
      for (const mesh of nextStatic) if (!this.staticMeshes.has(mesh)) {
        const source = mesh instanceof InstancedMesh ? mesh.sourceMesh : mesh instanceof Mesh ? mesh : null;
        const boundsUncertain = source?.geometry ? this.geometries.get(source.geometry)?.boundsUncertain ?? false : false;
        const snapshot = captureHybridShadowBounds(mesh, mesh.computeWorldMatrix(true), boundsUncertain);
        this.recordLocalChange(mesh, false, true, snapshot, 'membership', revision);
      }
      this.expectedStaticSubMeshes.clear();
    }
    const membershipChanged = changed || nextDynamic.size !== this.dynamicMeshes.size
      || [...nextDynamic].some(mesh => !this.dynamicMeshes.has(mesh));
    this.staticMeshes.clear();
    this.dynamicMeshes.clear();
    this.staticRenderingMeshes.clear();
    for (const mesh of nextStatic) {
      this.staticMeshes.add(mesh);
      const source = mesh instanceof InstancedMesh ? mesh.sourceMesh : mesh instanceof Mesh ? mesh : null;
      if (source) this.staticRenderingMeshes.add(source);
    }
    for (const mesh of nextDynamic) this.dynamicMeshes.add(mesh);
    for (const source of this.staticRenderingMeshes) {
      if (source.instances.some(instance => !instance.isDisposed() && !nextStatic.has(instance))) this.staticRenderingMeshes.delete(source);
    }
    for (const mesh of this.geometrySignatures.keys()) if (!nextStatic.has(mesh)) {
      this.signatures.delete(mesh);
      this.numericSignatures.delete(mesh);
      this.geometrySignatures.delete(mesh);
    }
    this.syncGeometryWatches();
    if (membershipChanged) { this.revision++; this.membershipRevision++; }
  }

  isStatic(mesh: AbstractMesh): boolean { return this.staticMeshes.has(mesh); }
  isStaticSubmission(mesh: Mesh): boolean { return this.staticRenderingMeshes.has(mesh); }

  /** 场景内容可能已变化；下一次原生 RTT 刷新判断前合并检查，不能等到绑定时才检测。 */
  markStale(): void { this.refreshedFrame = -1; }

  /** @internal 在等价性测试与诊断中切回旧签名；切换后的首帧重新建立快照。 */
  setSignatureMode(mode: 'numeric' | 'legacy'): void {
    if (this.signatureMode === mode) return;
    this.signatureMode = mode;
    this.signatures.clear();
    this.numericSignatures.clear();
    this.refreshedFrame = -1;
  }

  /** 每帧只读取静态网格的矩阵、几何版本及透明裁剪条件，不遍历顶点数据。 */
  refresh(): void {
    this.updateMembership();
    let changed = false;
    const trackLocal = this.localConsumers.size > 0;
    if (trackLocal) this.expectedStaticSubMeshes.clear();
    const currentGeometries = new Set<Geometry>();
    for (const mesh of this.staticMeshes) {
      const source = mesh instanceof InstancedMesh ? mesh.sourceMesh : mesh instanceof Mesh ? mesh : null;
      const geometry = source?.geometry;
      if (geometry) currentGeometries.add(geometry);
      if (geometry && !this.geometries.has(geometry)) this.watchGeometry(geometry);
      const watch = geometry && this.geometries.get(geometry);
      if (watch && geometry.onGeometryUpdated !== watch.callback) {
        this.watchGeometry(geometry, watch.version + 1, true);
      }
      const version = geometry ? this.geometries.get(geometry)?.version ?? 0 : 0;
      const previousGeometry = this.geometrySignatures.get(mesh);
      const geometryChanged = !previousGeometry || previousGeometry.id !== geometry?.uniqueId || previousGeometry.version !== version;
      if (geometryChanged) this.geometrySignatures.set(mesh, { id: geometry?.uniqueId, version });
      // 同一 renderId 内编辑变换/顶点时 Babylon 的快速返回会留下旧矩阵或世界包围盒。
      const world = mesh.computeWorldMatrix(geometryChanged || !mesh.isSynchronized());
      let meshChanged = false;
      if (this.signatureMode === 'legacy') {
        const signature = legacyHybridShadowSignature(mesh, source, geometry, version, world);
        if (signature !== this.signatures.get(mesh)) { this.signatures.set(mesh, signature); meshChanged = true; }
      } else {
        let signature = this.numericSignatures.get(mesh);
        if (!signature) { signature = new HybridShadowNumericSignature(); this.numericSignatures.set(mesh, signature); }
        meshChanged = signature.update(mesh, source, geometry, version, world);
      }
      if (meshChanged) changed = true;
      if (trackLocal) {
        if (meshChanged || !this.localBounds.has(mesh)) {
          const snapshot = captureHybridShadowBounds(mesh, world, geometry ? this.geometries.get(geometry)?.boundsUncertain ?? false : false);
          if (meshChanged) {
            const previous = this.localBounds.get(mesh);
            const reason = previous && previous.renderingGroupId !== mesh.renderingGroupId ? 'rendering-group'
              : geometryChanged ? 'geometry' : 'signature';
            this.recordLocalChange(mesh, true, true, snapshot, reason, this.revision + 1);
          } else this.localBounds.set(mesh, snapshot);
        }
        if (!mesh.isDisposed() && mesh.isEnabled() && mesh.isVisible) {
          for (const subMesh of mesh.subMeshes ?? []) this.expectedStaticSubMeshes.add(subMesh);
        }
      }
    }
    for (const [geometry, watch] of this.geometries) {
      if (!currentGeometries.has(geometry)) this.unwatchGeometry(geometry, watch);
    }
    if (changed) this.revision++;
  }

  /** 多灯共用同一个场景静态版本，避免每盏灯/每个 cube 面重新扫描全部静态网格。 */
  refreshForFrame(frame: number): void {
    if (this.refreshedFrame === frame) return;
    this.refreshedFrame = frame;
    this.refresh();
  }

  dispose(): void {
    for (const [geometry, watch] of this.geometries) this.unwatchGeometry(geometry, watch);
    this.signatures.clear();
    this.numericSignatures.clear();
    this.geometrySignatures.clear();
    this.staticMeshes.clear();
    this.dynamicMeshes.clear();
    this.staticRenderingMeshes.clear();
    this.candidates = [];
    this.roles = new Map();
    this.localConsumers.clear();
    this.localBounds.clear();
    this.expectedStaticSubMeshes.clear();
    this.submittedStaticSubMeshes.clear();
    this.localHistory.reset(this.revision);
  }

  private syncGeometryWatches(): void {
    for (const mesh of this.staticMeshes) {
      const source = mesh instanceof InstancedMesh ? mesh.sourceMesh : mesh instanceof Mesh ? mesh : null;
      if (source?.geometry && !this.geometries.has(source.geometry)) this.watchGeometry(source.geometry);
    }
  }

  private watchGeometry(geometry: Geometry, version = 0, boundsUncertain = false): void {
    const previous = geometry.onGeometryUpdated;
    const watch: GeometryWatch = {
      previous, version, boundsUncertain,
      callback: (updated, kind) => {
        watch.version++;
        // UV/normal 更新不越出原几何 bounds；position/未知写入不能假定同步了 bounds。
        if (!kind || kind === 'position') watch.boundsUncertain = true;
        previous?.(updated, kind);
      },
    };
    registerGeometryUpdateDelegate(geometry, watch.callback, previous);
    geometry.onGeometryUpdated = watch.callback;
    this.geometries.set(geometry, watch);
  }

  private unwatchGeometry(geometry: Geometry, watch: GeometryWatch): void {
    if (geometry.onGeometryUpdated === watch.callback) geometry.onGeometryUpdated = watch.previous;
    this.geometries.delete(geometry);
  }
}

/**
 * 保留旧名称供内部调用兼容；现在只调度 Babylon 原生阴影 RTT 的整图刷新。
 * 不替换 ShadowGenerator 的绘制函数，不分配、复制或合成任何深度/颜色缓冲。
 * 动态或无法证明稳定的投射集合每帧完整渲染，只有已知静态图使用原生 render-once。
 */
export class HybridShadowCache {
  readonly metrics = {
    staticRenders: 0, dynamicRenders: 0, nativeMapRenders: 0, cacheInvalidations: 0, cacheHits: 0,
    // 兼容旧诊断结构；原生整图调度不执行逐 face 局部失效。
    localInvalidations: 0, localCacheHits: 0, globalFallbacks: 0,
    globalFallbackReasons: {} as Partial<Record<HybridShadowFallbackReason, number>>,
    refreshPolicy: 'every-frame' as NativeShadowRefreshPolicy,
    unsupportedCacheReason: null as string | null,
  };
  private readonly scene: Scene;
  private readonly engine: AbstractEngine;
  private readonly prepareObserver: Observer<Scene>;
  private readonly frameObserver: Observer<Scene>;
  private readonly submissionObserver: Observer<Mesh>;
  private readonly lossObserver: Observer<AbstractEngine>;
  private readonly restoreObserver: Observer<AbstractEngine>;
  private shadowMap: RenderTargetTexture | null = null;
  private detachShadowMap: (() => void) | null = null;
  private targetHasCustomObservers: () => boolean = () => false;
  private nativeRender: RenderTargetTexture['customRenderFunction'] | null = null;
  private nativeReadiness: RenderTargetTexture['customIsReadyFunction'] | null = null;
  private enabled = true;
  private invalidationMode: HybridShadowInvalidationMode = 'global';
  private disposed = false;
  private contextLost = false;
  private revision = 0;
  private cachedSignature: string | null = null;
  private renderedFaces = 0;
  private lastRenderedFrame = -1;
  private preparedFrame = -1;
  private countedFrame = -1;
  private reusableFaces = 0;

  constructor(private readonly generator: ShadowGenerator, private readonly state: HybridShadowMeshState) {
    this.scene = generator.getLight().getScene();
    this.engine = this.scene.getEngine();
    this.bindShadowMap();
    // RTT 的 shouldRender 先于 onBeforeBind；失效检测必须在场景提交 render targets 前运行。
    this.prepareObserver = this.scene.onBeforeRenderTargetsRenderObservable.add(() => this.prepare());
    this.frameObserver = this.scene.onAfterRenderObservable.add(() => {
      const frame = this.scene.getFrameId(), light = this.generator.getLight();
      if (this.countedFrame === frame) return;
      this.countedFrame = frame;
      if (this.preparedFrame === frame && this.cachedSignature !== null && this.lastRenderedFrame !== frame
        && this.metrics.refreshPolicy === 'render-once' && this.scene.renderTargetsEnabled && this.scene.shadowsEnabled
        && light.isEnabled() && light.shadowEnabled && !this.contextLost) {
        this.metrics.cacheHits++;
        this.reusableFaces = light.needCube() ? 6 : 1;
      }
    });
    // 原生事件在实际提交 subMesh/实例批次后触发，不伪造静态/动态分阶段渲染次数。
    this.submissionObserver = generator.onAfterShadowMapRenderMeshObservable.add(mesh => {
      if (this.state.isStaticSubmission(mesh)) this.metrics.staticRenders++;
      else this.metrics.dynamicRenders++;
    });
    this.lossObserver = this.engine.onContextLostObservable.add(() => {
      this.contextLost = true;
      this.invalidate();
    });
    this.restoreObserver = this.engine.onContextRestoredObservable.add(() => {
      this.contextLost = false;
      this.bindShadowMap();
      this.invalidate();
    });
  }

  /** 保留 global/local 请求值；两者均执行原生全图失效，绝不启用旧局部 GPU 缓存。 */
  setInvalidationMode(mode: HybridShadowInvalidationMode): void { this.invalidationMode = mode; }
  getInvalidationMode(): HybridShadowInvalidationMode { return this.invalidationMode; }

  setEnabled(enabled: boolean): void {
    if (this.disposed || this.enabled === enabled) return;
    this.enabled = enabled;
    this.invalidate();
    // 开启缓存仍要先证明静态条件；关闭时立即恢复每帧整图，不能留下冻结旧姿态。
    this.setRefreshPolicy('every-frame');
  }

  invalidate(): void {
    if (this.disposed) return;
    this.revision++;
    this.clearCachedSignature();
  }

  /** 只是原生 RTT 中可复用的面数，不代表额外分配的缓存面。 */
  get cachedFaces(): number { return this.cachedSignature === null ? 0 : this.reusableFaces; }
  get textureBytes(): number { return 0; }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.scene.onBeforeRenderTargetsRenderObservable.remove(this.prepareObserver);
    this.scene.onAfterRenderObservable.remove(this.frameObserver);
    this.generator.onAfterShadowMapRenderMeshObservable.remove(this.submissionObserver);
    this.engine.onContextLostObservable.remove(this.lossObserver);
    this.engine.onContextRestoredObservable.remove(this.restoreObserver);
    this.detachShadowMap?.();
    this.detachShadowMap = null;
    this.shadowMap = null;
    this.cachedSignature = null;
    this.reusableFaces = 0;
    this.nativeRender = null;
    this.nativeReadiness = null;
    this.targetHasCustomObservers = () => false;
  }

  /** mapSize、光源类型或原生重建可能替换 RTT；观察者和原刷新率随目标成对归还。 */
  private bindShadowMap(): void {
    const map = this.generator.getShadowMap();
    if (map === this.shadowMap) return;
    this.detachShadowMap?.();
    this.detachShadowMap = null;
    this.shadowMap = map;
    this.cachedSignature = null;
    this.reusableFaces = 0;
    this.nativeRender = null;
    this.nativeReadiness = null;
    this.targetHasCustomObservers = () => false;
    this.renderedFaces = 0;
    if (!map) return;
    const originalRefreshRate = map.refreshRate;
    this.nativeRender = map.customRenderFunction;
    this.nativeReadiness = map.customIsReadyFunction;
    this.setRefreshPolicy('every-frame');
    const bindObserver = map.onBeforeBindObservable.add(() => { this.renderedFaces = 0; });
    // readiness 预热也会发 before/after render、bind/unbind，只有原生 clear 表示真正开始写图。
    const clearObserver = map.onClearObservable.add(() => { this.renderedFaces++; });
    const unbindObserver = map.onAfterUnbindObservable.add(() => this.finishRender());
    const beforeBind = new Set(map.onBeforeBindObservable.observers);
    const beforeRender = new Set(map.onBeforeRenderObservable.observers);
    const afterRender = new Set(map.onAfterRenderObservable.observers);
    const clear = new Set(map.onClearObservable.observers);
    const afterUnbind = new Set(map.onAfterUnbindObservable.observers);
    this.targetHasCustomObservers = () => map.onBeforeBindObservable.observers.length !== beforeBind.size
      || map.onBeforeRenderObservable.observers.length !== beforeRender.size
      || map.onAfterRenderObservable.observers.length !== afterRender.size
      || map.onClearObservable.observers.length !== clear.size
      || map.onAfterUnbindObservable.observers.length !== afterUnbind.size
      || map.onBeforeBindObservable.observers.some(observer => !beforeBind.has(observer))
      || map.onBeforeRenderObservable.observers.some(observer => !beforeRender.has(observer))
      || map.onAfterRenderObservable.observers.some(observer => !afterRender.has(observer))
      || map.onClearObservable.observers.some(observer => !clear.has(observer))
      || map.onAfterUnbindObservable.observers.some(observer => !afterUnbind.has(observer));
    this.detachShadowMap = () => {
      map.onBeforeBindObservable.remove(bindObserver);
      map.onClearObservable.remove(clearObserver);
      map.onAfterUnbindObservable.remove(unbindObserver);
      map.refreshRate = originalRefreshRate;
      map.resetRefreshCounter();
    };
  }

  private setRefreshPolicy(policy: NativeShadowRefreshPolicy): void {
    this.metrics.refreshPolicy = policy;
    const rate = policy === 'render-once' ? RenderTargetTexture.REFRESHRATE_RENDER_ONCE : RenderTargetTexture.REFRESHRATE_RENDER_ONEVERYFRAME;
    if (this.shadowMap && this.shadowMap.refreshRate !== rate) this.shadowMap.refreshRate = rate;
  }

  private clearCachedSignature(): void {
    if (this.cachedSignature !== null) this.metrics.cacheInvalidations++;
    this.cachedSignature = null;
    this.reusableFaces = 0;
    this.shadowMap?.resetRefreshCounter();
  }

  private prepare(): void {
    if (this.disposed) return;
    this.bindShadowMap();
    const map = this.shadowMap;
    if (!map || this.contextLost) return;
    // 同一轮 targets 的多灯共享 CPU 签名；多相机/后续轮次重新检查，避免复用早一轮的姿态。
    this.state.refreshForFrame(this.scene.getRenderId());
    this.preparedFrame = this.scene.getFrameId();
    const reason = this.enabled ? this.getRealtimeReason() : null;
    this.metrics.unsupportedCacheReason = reason;
    if (!this.enabled || reason) {
      this.setRefreshPolicy('every-frame');
      this.clearCachedSignature();
      return;
    }
    this.setRefreshPolicy('render-once');
    const signature = this.getSignature();
    if (signature === null) {
      this.metrics.unsupportedCacheReason = '投影包含非有限值，使用原生整图实时阴影。';
      this.setRefreshPolicy('every-frame');
      this.clearCachedSignature();
    } else if (signature !== this.cachedSignature) {
      this.clearCachedSignature();
    }
  }

  private finishRender(): void {
    const map = this.shadowMap;
    if (!map || !this.renderedFaces) return;
    const faces = this.renderedFaces;
    this.renderedFaces = 0;
    this.metrics.nativeMapRenders++;
    this.reusableFaces = 0;
    this.lastRenderedFrame = this.scene.getFrameId();
    if (this.metrics.refreshPolicy !== 'render-once' || this.contextLost) return;
    if (this.getRealtimeReason()) { this.setRefreshPolicy('every-frame'); this.clearCachedSignature(); return; }
    if (faces !== (this.generator.getLight().needCube() ? 6 : 1)) { this.clearCachedSignature(); return; }
    // 未就绪时原生生成器会重置刷新计数器；解绑后不能再调用阴影 readiness，避免污染相机 pass 的 effect。
    // 原生方向光可能在首次绘图中更新自动范围，cube 也会切换到最后一面；记录完成后的投影。
    this.cachedSignature = this.getSignature();
    if (this.cachedSignature === null) map.resetRefreshCounter();
  }

  private getRealtimeReason(): string | null {
    const generator = this.generator, map = this.shadowMap!, light = generator.getLight();
    if (generator instanceof CascadedShadowGenerator) return 'CSM 使用 Babylon 原生逐帧级联，不提供独立静态缓存。';
    if (generator.constructor !== ShadowGenerator || Boolean(light.customProjectionMatrixBuilder)
      || generator.customShaderOptions || Boolean(generator.customAllowRendering)
      || generator.onBeforeShadowMapRenderObservable.hasObservers() || generator.onBeforeShadowMapRenderMeshObservable.hasObservers()
      || generator.onAfterShadowMapRenderObservable.hasObservers()
      || generator.onAfterShadowMapRenderMeshObservable.observers.some(observer => observer !== this.submissionObserver)
      || map.customRenderFunction !== this.nativeRender || map.customIsReadyFunction !== this.nativeReadiness
      || this.targetHasCustomObservers()) return '存在自定义阴影渲染，保守使用原生整图实时刷新。';
    if (!map.renderList?.length || Boolean(map.getCustomRenderList) || Boolean(map.renderListPredicate) || map.forceLayerMaskCheck
      || map.renderParticles || map.renderSprites
      || map.useCameraPostProcesses || this.scene.customRenderFunction
      || Boolean(this.scene.customLODSelector) || this.engine.snapshotRendering || this.scene.frameGraph) {
      return '渲染集合或调度无法静态证明，使用原生整图实时刷新。';
    }
    if (!this.scene.activeCamera || generator.enableSoftTransparentShadow) return '相机或透明阴影状态需要原生实时刷新。';
    if (generator.useOpacityTextureForTransparentShadow) return '独立透明度贴图由原生生成器实时采样，不冻结透明阴影。';
    if (!(light instanceof DirectionalLight || light instanceof PointLight || light instanceof SpotLight)) return '未知光源投影使用原生整图实时刷新。';
    const checkedSources = new Set<Mesh>();
    for (const mesh of map.renderList) {
      if (mesh.isDisposed() || !mesh.isEnabled() || !mesh.isVisible || mesh.visibility <= 0) continue;
      if (!this.state.isStatic(mesh)) return '包含动态或未确认静态的投射物，使用原生整图实时刷新。';
      const source = mesh instanceof InstancedMesh ? mesh.sourceMesh : mesh instanceof Mesh ? mesh : null;
      if (!source) return '未知投射物使用原生整图实时刷新。';
      if (!checkedSources.has(source) && (source.skeleton || source.morphTargetManager || source.bakedVertexAnimationManager?.isEnabled || source.hasThinInstances
        || source.billboardMode || source.infiniteDistance || source.getLODLevels().length || source.doNotSyncBoundingInfo
        || source.getBoundingInfo().isLocked || source.instances.some(instance => !instance.isDisposed() && !this.state.isStatic(instance))
        || source.getVerticesDataKinds().some(kind => source.getVertexBuffer(kind)?.isUpdatable())
        || source.onBeforeRenderObservable.hasObservers() || source.onBeforeBindObservable.hasObservers()
        || source.onBeforeDrawObservable.hasObservers() || source.onAfterRenderObservable.hasObservers())) {
        return '投射物含变形、动态实例或自定义提交，使用原生整图实时刷新。';
      }
      checkedSources.add(source);
      if (mesh.renderingGroupId !== 0 || map.renderPassIds.some(id => mesh.getMaterialForRenderPass(id) || source.getMaterialForRenderPass(id))) {
        return '自定义渲染组或阴影通道材质无法静态证明，使用原生整图实时刷新。';
      }
      for (const subMesh of mesh.subMeshes ?? []) {
        const material = subMesh.getMaterial();
        if (!material || material.shadowDepthWrapper || Boolean(material.customShaderNameResolve) || material.disableDepthWrite || material.disableColorWrite
          || !['StandardMaterial', 'PBRMaterial', 'PBRMetallicRoughnessMaterial', 'PBRSpecularGlossinessMaterial'].includes(material.getClassName())
          || subMesh.getReplacementMesh() || subMesh.getRenderingMesh() !== source) {
          return '自定义深度或材质路径无法静态证明，使用原生整图实时刷新。';
        }
        const alpha = material.needAlphaTestingForMesh(source) || material.needAlphaBlendingForMesh(source);
        const texture = alpha ? material.getAlphaTestTexture() : null;
        if (texture && (texture.constructor !== Texture || texture.isRenderTarget || texture.animations.length)) {
          return '透明贴图内容可能逐帧变化，使用原生整图实时刷新。';
        }
      }
    }
    return null;
  }

  /** CPU 签名只读取公共灯光/相机/材质状态；绘制、过滤和深度资源全部归 Babylon。 */
  private getSignature(): string | null {
    const generator = this.generator, map = this.shadowMap!, light = generator.getLight();
    light.parent?.computeWorldMatrix(true);
    const world = light.computeWorldMatrix(true);
    const matrix = generator.getTransformMatrix().asArray();
    if (!Array.from(matrix).every(Number.isFinite)) return null;
    const size = map.getSize();
    const cameras = [...new Set([this.scene.activeCamera, generator.camera, map.activeCamera])];
    const cameraSignature = cameras.map(camera => camera
      ? [camera.uniqueId, camera.minZ, camera.maxZ, camera.layerMask, ...camera.getViewMatrix().asArray(), ...camera.getProjectionMatrix().asArray()].join(',') : '').join(';');
    const projection = light instanceof DirectionalLight
      ? [light.shadowFrustumSize, light.shadowOrthoScale, light.autoUpdateExtends, light.autoCalcShadowZBounds,
        light.orthoLeft, light.orthoRight, light.orthoTop, light.orthoBottom]
      : light instanceof PointLight ? [light.shadowAngle] : light instanceof SpotLight ? [light.angle, light.shadowAngleScale] : [];
    const materialSignature = (map.renderList ?? []).map(mesh => {
      const source = mesh instanceof InstancedMesh ? mesh.sourceMesh : mesh instanceof Mesh ? mesh : null;
      return [mesh.uniqueId, mesh.isBlocked, mesh.layerMask, source?.overrideMaterialSideOrientation, source?.useVertexColors, source?.hasVertexAlpha,
      ...(mesh.subMeshes ?? []).map(subMesh => {
        const material = subMesh.getMaterial(), texture = material?.getAlphaTestTexture();
        return [material?.uniqueId, material?.disableDepthWrite, material?.disableColorWrite, material?.needDepthPrePass,
          material?.useLogarithmicDepth, texture?.getInternalTexture()?.uniqueId, (texture as Texture | null)?.url,
          texture?.hasAlpha, texture?.getAlphaFromRGB, texture?.level, texture?.wrapU, texture?.wrapV, texture?.samplingMode,
          ...[material?.clipPlane, material?.clipPlane2, material?.clipPlane3, material?.clipPlane4, material?.clipPlane5, material?.clipPlane6]
            .map(plane => plane ? [...plane.normal.asArray(), plane.d].join(',') : '')].join(',');
      })].join(':');
    }).join(';');
    const rendered = generator.getShadowMapForRendering();
    return [this.revision, this.state.revision, map.uniqueId, map.getInternalTexture()?.uniqueId, rendered?.uniqueId, rendered?.getInternalTexture()?.uniqueId, size.width, size.height, map.samples,
      ...matrix, light.uniqueId, ...world.asArray(), ...light.position.asArray(), ...(light.direction?.asArray() ?? []),
      light.range, light.shadowMinZ, light.shadowMaxZ, light.getDepthMinZ(this.scene.activeCamera), light.getDepthMaxZ(this.scene.activeCamera),
      ...projection, cameraSignature, materialSignature, generator.bias, generator.normalBias, generator.filter, generator.filteringQuality,
      generator.transparencyShadow, generator.forceBackFacesOnly, generator.depthScale, generator.enableSoftTransparentShadow,
      generator.useKernelBlur, generator.blurScale, generator.blurKernel, generator.blurBoxOffset, generator.contactHardeningLightSizeUVRatio,
      this.engine.useReverseDepthBuffer, this.engine.isNDCHalfZRange, this.scene.useRightHandedSystem, ...this.scene.floatingOriginOffset.asArray(),
      ...[this.scene.clipPlane, this.scene.clipPlane2, this.scene.clipPlane3, this.scene.clipPlane4, this.scene.clipPlane5, this.scene.clipPlane6]
        .map(plane => plane ? [...plane.normal.asArray(), plane.d].join(',') : '')].join(',');
  }
}
