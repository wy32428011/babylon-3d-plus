import { registerGeometryUpdateDelegate } from './lightingGeometryUpdates.ts';
import { getSceneLightingConfig } from '../../../electron/shared/sceneLightingConfig.ts';
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera.js';
import { Light } from '@babylonjs/core/Lights/light.js';
import { Material } from '@babylonjs/core/Materials/material.js';
import { MultiMaterial } from '@babylonjs/core/Materials/multiMaterial.js';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import { Matrix, Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh.js';
import { Geometry } from '@babylonjs/core/Meshes/geometry.js';
import { InstancedMesh } from '@babylonjs/core/Meshes/instancedMesh.js';
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData.js';
import { SubMesh } from '@babylonjs/core/Meshes/subMesh.js';
import type { Observer, Scene } from '@babylonjs/core';
import type {
  LightingBakeInput, LightingClassificationEntry, SceneLightingBakeSettings, SceneLightingBakeSnapshot,
} from '../../../electron/shared/sceneLightingBakeContract.ts';
import {
  getSceneLightingBakeSignature, lightingContentHash, validateSceneLightingBakeSnapshot,
} from '../../../electron/shared/sceneLightingBakeContract.ts';
import type { SceneDocument } from '../../editor/model/SceneDocument';
import { BakedLightingMaterialPlugin, LIGHTING_UV_ATTRIBUTE, type BakedLightingBinding } from './BakedLightingMaterialPlugin';
import type { LightingRuntimeSource } from './lightingClassificationRuntime.ts';
import {
  captureLightingEnvironment, captureRuntimeLightingInput, getLightingGeometrySignature,
  lightingMaterialFingerprint, lightingSourceVisible, sourceGeometryMesh,
} from './lightingRuntimeCapture.ts';
import { loadLightingResources, type LoadedLightingResources } from './lightingRuntimeResources.ts';
import { lightingMaterialValueSignature, restoreLightingMaterialValues } from './lightingRuntimeMaterial.ts';
import { copyLightingMaterialExportBaseline } from './lightingGeometry.ts';
import { LightingShadowInstanceRuntime } from './LightingShadowInstanceRuntime.ts';
import { LightingInvalidationDiagnostics, type LightingChangeKind, type LightingInvalidationEntry, type LightingInvalidationDiagnosticsSnapshot } from './lightingInvalidation.ts';
import { LightingProbeOcclusionQuery } from './lightingProbeOcclusion.ts';
import { getLightingRuntimeDiagnostic, type LightingRuntimeDiagnostic } from './lightingRuntimeDiagnostic.ts';

type ShadowRole = { mobility: 'static' | 'dynamic'; castShadows: boolean; receiveShadows: boolean };
type LightingInstanceBatch = NonNullable<LightingRuntimeSource['instance']>['batch'];
type RuntimeOptions = {
  getSources: () => LightingRuntimeSource[];
  setShadowRoles: (roles: ReadonlyMap<AbstractMesh, ShadowRole>, settings: SceneLightingBakeSettings) => void;
  pushLog: (message: string) => void;
  /** 可见源/代理切换后由编辑器刷新已有选择层；构造时不会调用。 */
  onBindingsChanged?: () => void;
  /** 资源读取边界可在 NullEngine 测试中替换；正式编辑器和 Viewer 共用默认加载器。 */
  loadResources?: typeof loadLightingResources;
};
type RenderBinding = {
  source: LightingRuntimeSource;
  mesh: AbstractMesh;
  binding: BakedLightingBinding;
  proxy: boolean;
  dynamic: boolean;
  lastProbePosition: Vector3 | null;
  sourceMaterial?: Material | null;
  sourceMaterialSignature?: string;
};
type StaticWatch = {
  source: LightingRuntimeSource;
  matrix: Matrix;
  visible: boolean;
  visibility: number;
  material: string;
  geometry: Geometry | null;
  instanceRevision: number | null;
  carrierMatrix: Matrix | null;
};
type GeometryHook = { geometry: Geometry; previous: Geometry['onGeometryUpdated']; listener: Geometry['onGeometryUpdated'] };
type LightingState = {
  snapshot: SceneLightingBakeSnapshot;
  resources: LoadedLightingResources;
  bindings: Map<AbstractMesh, BakedLightingBinding>;
  records: RenderBinding[];
  materials: Set<Material>;
  originalMaterials: Map<AbstractMesh, Material | null>;
  originalMaterialValues: Map<AbstractMesh, string>;
  hiddenSources: Map<AbstractMesh, number>;
  sourceLayerMasks: Map<AbstractMesh, number>;
  sourcePickability: Map<AbstractMesh, boolean>;
  hiddenInstances: Map<LightingInstanceBatch, Map<number, Set<number>>>;
  staticWatch: StaticWatch[];
  geometryHooks: GeometryHook[];
  ownedProxies: Set<Mesh>;
  lightSignature: string;
  sourceLayoutKey: string;
  dynamicGeometryTargets: Map<Mesh, Geometry>;
  released?: boolean;
};
type DebugOverlay = { source: LightingRuntimeSource; mesh: Mesh };
type PendingLightingActivation = { candidate: LightingState; previous: LightingState | null; finished: boolean };

function matrixChanged(before: Matrix, after: Matrix): boolean {
  for (let index = 0; index < 16; index++) if (Math.abs(before.m[index] - after.m[index]) > 1e-6) return true;
  return false;
}
function sourceParentKey(surfaceKey: string): { key: string; primitive: number } {
  const match = /^(.*)\/primitive:(\d+)(?:\/tile:[^/]+)?$/.exec(surfaceKey);
  if (!match) throw new Error(`光照表面标识缺少材质分组：${surfaceKey}`);
  return { key: match[1], primitive: Number(match[2]) };
}
function applyWorldMatrix(mesh: Mesh, matrix: Matrix): void {
  // 只更新光照代理，业务源节点和阵列权威矩阵仍由现有动作系统控制。
  mesh.setPreTransformMatrix(matrix);
  mesh.computeWorldMatrix(true);
}
function lightingInstanceRevision(source: LightingRuntimeSource): number | null {
  const batch = source.instance?.batch as (LightingInstanceBatch & { getLightingRevision?: () => number }) | undefined;
  return batch?.getLightingRevision?.() ?? null;
}

/** 管理完整光照资源事务、动静代理及运行期失效；不改业务脚本、设备动作或持久化文档。 */
export class SceneLightingRuntime {
  private document: SceneDocument | null = null;
  private sources: LightingRuntimeSource[] = [];
  private classification: LightingClassificationEntry[] = [];
  private dirty = true;
  private bindingsDirty = true;
  private state: LightingState | null = null;
  private disposed = false;
  private creatingDerived = false;
  private beforeBake = false;
  private temporaryLightingPreview = false;
  private suppressPreviewIndirect = false;
  private debugVisible = false;
  private debugOverlays: DebugOverlay[] = [];
  private debugMaterials: Material[] = [];
  private error: string | null = null;
  private diagnostic: LightingRuntimeDiagnostic | null = null;
  private operation = 0;
  private controller: AbortController | null = null;
  private ready: Promise<void> = Promise.resolve();
  private desiredSnapshotKey: string | null = null;
  private readonly proxyLightPolicies = new Map<Light, {
    appliedIncluded: AbstractMesh[]; appliedExcluded: AbstractMesh[];
    addedIncluded: Set<AbstractMesh>; addedExcluded: Set<AbstractMesh>;
  }>();
  private lightPolicyObserver: Observer<Scene> | null = null;
  private lightPolicySignature = '';
  private readonly observer: Observer<Scene>;
  private pendingInvalidation: string | null = null;
  private invalidatedSnapshotKey: string | null = null;
  private sourceRevision = 0;
  private bindingsRevision = 0;
  private structureRevision = 0;
  private consumedStructureRevision = 0;
  // 同步消费和完整异步事务期间不合并标记，避免吞掉回调产生的新代失效。
  private dirtyConsumptionDepth = 0;
  private readonly invalidationDiagnostics = new LightingInvalidationDiagnostics();
  private documentSignature: string | null = null;
  private readonly changedDynamicGeometry = new Set<Mesh>();
  private capturedInput: { signature: string; geometrySignature: string; materials: string; lighting: string } | null = null;
  private pendingActivation: PendingLightingActivation | null = null;
  private readonly shadowInstances: LightingShadowInstanceRuntime;

  constructor(private readonly scene: Scene, private readonly options: RuntimeOptions) {
    this.shadowInstances = new LightingShadowInstanceRuntime(scene, () => this.restoreProxyLightPolicies());
    this.observer = scene.onBeforeRenderObservable.add(() => this.tick())!;
  }

  sync(document: SceneDocument): void {
    this.dirtyConsumptionDepth++;
    try {
      if (this.disposed) return;
      const documentSignature = getSceneLightingBakeSignature(document);
      if (documentSignature !== this.documentSignature) this.invalidatedSnapshotKey = null;
      this.documentSignature = documentSignature;
      this.document = document;
      this.requestChange('classification', 'document-sync');
      const settings = getSceneLightingConfig(document).bake;
      if (!settings.enabled) {
        this.cancelPending(); this.desiredSnapshotKey = null; this.clearState(); this.setError(null);
        this.refreshSources('sync'); this.updateShadowRoles(); this.rebuildDebug(); return;
      }
      const raw = getSceneLightingConfig(document).result;
      const snapshot = raw ? validateSceneLightingBakeSnapshot(raw) : null;
      if (!snapshot || snapshot.signature !== getSceneLightingBakeSignature(document)) {
        this.cancelPending(); this.desiredSnapshotKey = null; this.clearState();
        this.setError(raw ? '静态对象、材质或灯光已变化，光照结果已过期，请重新烘焙。' : null);
        this.refreshSources('sync'); this.updateShadowRoles(); this.rebuildDebug(); return;
      }
      const key = this.snapshotKey(snapshot);
      if (this.invalidatedSnapshotKey === key) { this.refreshSources('sync'); this.updateShadowRoles(); this.rebuildDebug(); return; }
      if (this.state && this.snapshotKey(this.state.snapshot) === key) {
        this.desiredSnapshotKey = key;
        if (!this.pendingActivation) this.refreshBindingsForSources('sync');
        return;
      }
      if (this.desiredSnapshotKey === key && this.controller) return;
      this.desiredSnapshotKey = key;
      this.ready = this.applySnapshot(snapshot).catch(error => {
        if (!this.disposed && this.desiredSnapshotKey === key) this.reportError(error);
      });
    } finally { this.dirtyConsumptionDepth--; }
  }

  /** 旧入口仍按未知变更执行完整分类与绑定校验。 */
  markDirty(reason = 'unknown'): void { this.notifyChange('unknown', reason); }
  notifyChange(kind: LightingChangeKind, reason: string = kind): void {
    if (this.disposed) { this.invalidationDiagnostics.skip('disposed'); return; }
    if (this.creatingDerived) { this.invalidationDiagnostics.skip('derived'); return; }
    this.requestChange(kind, reason);
  }
  /** 仅供受控原生mesh增删事件：已有双路pending且没有消费事务时，只合并重复标记。 */
  notifyMeshLifecycleChange(reason: string): 'coalesced' | 'full' {
    const coalesced = !this.disposed && !this.creatingDerived && this.dirty && this.bindingsDirty
      && this.dirtyConsumptionDepth === 0 && !this.controller && !this.pendingActivation;
    this.invalidationDiagnostics.meshLifecycle(reason, coalesced);
    if (coalesced) return 'coalesced';
    this.notifyChange('unknown', reason);
    return 'full';
  }
  private requestChange(kind: LightingChangeKind, reason: string): void {
    this.invalidationDiagnostics.mark(kind, reason);
    if (kind === 'pose') return;
    this.bindingsDirty = true; this.bindingsRevision++;
    if (kind !== 'bindings') {
      this.dirty = true; this.sourceRevision++;
      if (kind === 'structure') this.structureRevision++;
    }
  }
  /** 仅记录生产端判断，不把“未变化”伪造为位姿失效。 */
  recordInvalidationDecision(reason: string, skipped: boolean): void { this.invalidationDiagnostics.decision(reason, skipped); }
  setInvalidationDiagnosticsEnabled(enabled: boolean): void { this.invalidationDiagnostics.setEnabled(enabled); }
  resetInvalidationDiagnostics(): void { this.invalidationDiagnostics.reset(); }
  getInvalidationDiagnostics(): LightingInvalidationDiagnosticsSnapshot & Readonly<{
    revisions: Readonly<{ classification: number; bindings: number; structure: number }>;
    pending: Readonly<{ classification: boolean; bindings: boolean; structure: boolean }>;
  }> {
    return { ...this.invalidationDiagnostics.snapshot(),
      revisions: { classification: this.sourceRevision, bindings: this.bindingsRevision, structure: this.structureRevision },
      pending: { classification: this.dirty, bindings: this.bindingsDirty, structure: this.structureRevision !== this.consumedStructureRevision },
    };
  }
  getClassification(): LightingClassificationEntry[] { this.refreshSources('query'); return this.classification; }
  getError(): string | null { return this.error; }
  getDiagnostic(): LightingRuntimeDiagnostic | null { return this.diagnostic ? { ...this.diagnostic } : null; }
  whenReady(): Promise<void> { return this.ready; }

  /** 不传 originals 时只返回当前逻辑实体的代理，阵列调用方可继续保留原 thin-instance mask 回退。 */
  getSelectionMeshes(entityId: string, originals?: readonly AbstractMesh[]): AbstractMesh[] {
    const proxies = this.renderingRecords().filter(record => record.proxy && record.source.entry.entityId === entityId
      && !record.mesh.isDisposed() && record.mesh.isEnabled() && record.mesh.isVisible && record.mesh.visibility > 0);
    if (!originals) return [...new Set(proxies.map(record => record.mesh))];
    const output = new Set<AbstractMesh>();
    for (const original of originals) {
      if (original.isDisposed()) continue;
      const replacements = proxies.filter(record => record.source.mesh === original);
      if (replacements.length) for (const record of replacements) output.add(record.mesh);
      else output.add(original);
    }
    return [...output];
  }
  private renderingRecords(): ReadonlyArray<Pick<RenderBinding, 'source' | 'mesh' | 'proxy'>> {
    return this.state?.records ?? this.shadowInstances.records;
  }

  setPreview(debugVisible: boolean, beforeBake: boolean): void {
    if (this.disposed) return;
    const changed = this.debugVisible !== debugVisible;
    this.debugVisible = debugVisible; this.beforeBake = beforeBake;
    if (this.state) for (const record of this.state.records) record.binding.enabled = !beforeBake && !this.suppressPreviewIndirect;
    this.updateProxyLightPolicies();
    if (changed || this.dirty) { this.refreshSources('preview'); this.rebuildDebug(); }
    if (this.state) this.notifyBindingsChanged();
  }

  /** 临时草稿不更改持久化签名；物理输入变化时仅抑制GI绑定，保留原资源供取消恢复。 */
  setTemporaryLightingPreview(active: boolean, suppressIndirect: boolean): void {
    if (this.disposed) return;
    this.temporaryLightingPreview = active;
    this.suppressPreviewIndirect = active && suppressIndirect;
    if (this.state) for (const record of this.state.records) record.binding.enabled = !this.beforeBake && !this.suppressPreviewIndirect;
    this.updateProxyLightPolicies();
  }

  focusNode(entityId: string, nodeKey: string): void {
    this.refreshSources('focus');
    if (!(this.scene.activeCamera instanceof ArcRotateCamera)) return;
    const sources = this.sources.filter(source => source.entry.entityId === entityId && source.entry.nodeKey === nodeKey);
    const minimum = new Vector3(Infinity, Infinity, Infinity), maximum = new Vector3(-Infinity, -Infinity, -Infinity);
    for (const source of sources) {
      const world = source.getWorldMatrix();
      if (!world) continue;
      const bounds = sourceGeometryMesh(source.mesh).rawBoundingInfo?.boundingBox ?? source.mesh.getBoundingInfo().boundingBox;
      for (const vertex of bounds.vectors) {
        const point = Vector3.TransformCoordinates(vertex, world);
        minimum.minimizeInPlace(point); maximum.maximizeInPlace(point);
      }
    }
    if (!Number.isFinite(minimum.x)) return;
    const camera = this.scene.activeCamera;
    camera.setTarget(minimum.add(maximum).scale(0.5));
    camera.radius = Math.max(camera.lowerRadiusLimit ?? 0.1, Vector3.Distance(minimum, maximum) * 1.2);
    if (camera.upperRadiusLimit !== null) camera.radius = Math.min(camera.radius, camera.upperRadiusLimit);
  }

  async captureBakeInput(jobId: string, signal?: AbortSignal, progress?: (message: string) => void): Promise<LightingBakeInput> {
    this.dirtyConsumptionDepth++;
    try {
      if (!this.document || this.disposed) throw new Error('没有可烘焙的当前场景。');
      this.refreshSources('capture');
      if (this.scene.environmentTexture && !this.document.sceneSettings.skybox?.sourceUrl?.match(/(?:hdr|exr)(?:[?#]|$)/i)
        && this.document.sceneSettings.skybox?.format !== 'hdr') this.options.pushLog('当前环境使用预过滤天空盒，间接光烘焙采用其平均环境辐照度；镜面反射继续使用原天空盒。');
      const materials = this.staticMaterialSignature(), lighting = lightingContentHash(captureLightingEnvironment(this.scene, this.document));
      const input = await captureRuntimeLightingInput(this.scene, this.document, this.sources, jobId, signal, progress);
      this.refreshSources('capture');
      if (materials !== this.staticMaterialSignature() || lighting !== lightingContentHash(captureLightingEnvironment(this.scene, this.document))) {
        throw new Error('捕获期间实际静态材质或灯光发生变化，请等待场景稳定后重新烘焙。');
      }
      this.capturedInput = { signature: input.signature, geometrySignature: input.geometrySignature!, materials, lighting };
      return input;
    } finally { this.dirtyConsumptionDepth--; }
  }

  async applySnapshot(raw: SceneLightingBakeSnapshot, signal?: AbortSignal, finalValidation?: () => Promise<void>): Promise<void> {
    this.dirtyConsumptionDepth++;
    let snapshotOwnsConsumption = false;
    try {
      if (!this.document || this.disposed) throw new Error('当前场景已经关闭。');
      const snapshot = validateSceneLightingBakeSnapshot(raw);
      if (!snapshot) throw new Error('光照资源清单格式无效。');
      if (snapshot.signature !== getSceneLightingBakeSignature(this.document)) throw new Error('光照结果与当前静态场景不一致。');
      this.cancelPending();
      const operation = ++this.operation, sourceRevision = this.sourceRevision, bindingsRevision = this.bindingsRevision, controller = new AbortController();
      this.controller = controller;
      const abort = () => controller.abort(signal?.reason);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      let resources: LoadedLightingResources | null = null, candidate: LightingState | null = null;
      let activation: PendingLightingActivation | null = null, preparedStructureRevision = this.structureRevision;
      const check = () => {
        controller.signal.throwIfAborted();
        if (this.disposed || operation !== this.operation || !this.document
          || snapshot.signature !== getSceneLightingBakeSignature(this.document)) throw new Error('场景已经变化，候选光照结果未提交。');
        if (this.capturedInput?.signature === snapshot.signature && this.capturedInput.geometrySignature === snapshot.geometrySignature
          && (this.capturedInput.materials !== this.staticMaterialSignature()
            || this.capturedInput.lighting !== lightingContentHash(captureLightingEnvironment(this.scene, this.document)))) {
          throw new Error('烘焙期间实际静态材质或灯光发生变化，候选结果未提交。');
        }
      };
      snapshotOwnsConsumption = true;
      const pending = (async () => {
        try {
          check(); this.refreshSources('snapshot');
          const geometrySignature = getLightingGeometrySignature(this.sources);
          if (snapshot.geometrySignature && snapshot.geometrySignature !== geometrySignature) throw new Error('模型几何或实际姿态与烘焙资源不一致，请重新烘焙。');
          resources = await (this.options.loadResources ?? loadLightingResources)(snapshot, this.scene, controller.signal);
          check(); this.refreshSources('snapshot');
          if (getLightingGeometrySignature(this.sources) !== geometrySignature) throw new Error('加载光照期间静态几何已经变化，候选结果未提交。');
          preparedStructureRevision = this.structureRevision;
          candidate = this.prepareState(snapshot, resources);
          check();
          const previous = this.commitState(candidate, true, false);
          activation = { candidate, previous, finished: false };
          this.pendingActivation = activation;
          this.notifyBindingsChanged();
          check();
          if (finalValidation) await this.validateActivatedState(finalValidation, controller.signal);
          check(); this.refreshSources('snapshot');
          if (this.pendingInvalidation || getLightingGeometrySignature(this.sources) !== geometrySignature) {
            throw new Error('验证光照期间静态几何已经变化，候选结果未提交。');
          }
          if (this.pendingActivation !== activation || this.state !== candidate) throw new Error('候选光照已被其他操作替换，未提交。');
          activation.finished = true; this.pendingActivation = null;
          if (previous) this.releaseState(previous, previous.resources === candidate.resources, false);
          this.consumedStructureRevision = Math.max(this.consumedStructureRevision, preparedStructureRevision);
          candidate = null; resources = null; this.setError(null); this.invalidatedSnapshotKey = null;
          this.capturedInput = null;
          this.desiredSnapshotKey = this.snapshotKey(snapshot);
          this.notifyBindingsChanged();
        } catch (error) {
          if (activation) this.rollbackActivation(activation);
          else if (candidate) this.releaseState(candidate, false, false);
          else resources?.dispose();
          if (!controller.signal.aborted && !this.disposed && operation === this.operation) this.reportError(error);
          throw error;
        } finally {
          try {
            signal?.removeEventListener('abort', abort);
            if (this.controller === controller) this.controller = null;
            if (!this.disposed && operation === this.operation) {
              if (sourceRevision !== this.sourceRevision) this.dirty = true;
              if (bindingsRevision !== this.bindingsRevision || this.structureRevision !== this.consumedStructureRevision) this.bindingsDirty = true;
            }
          } finally { this.dirtyConsumptionDepth--; }
        }
      })();
      this.ready = pending;
      return pending;
    } finally {
      // 内层事务负责覆盖资源/验证await及其finally；前置校验失败由此释放。
      if (!snapshotOwnsConsumption) this.dirtyConsumptionDepth--;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.cancelPending();
    this.scene.onBeforeRenderObservable.remove(this.observer);
    this.clearDebug(); this.clearState(); this.shadowInstances.clear(); this.sources = []; this.classification = [];
    this.options.setShadowRoles(new Map(), getSceneLightingConfig(this.document).bake);
  }

  private snapshotKey(snapshot: SceneLightingBakeSnapshot): string {
    return `${snapshot.signature}:${lightingContentHash(snapshot.assets.map(asset => [asset.id, asset.url, asset.sha256]))}`;
  }
  private cancelPending(): void {
    this.operation++; this.controller?.abort(); this.controller = null;
    if (this.pendingActivation) this.rollbackActivation(this.pendingActivation);
  }

  private async validateActivatedState(validation: () => Promise<void>, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    let abort: (() => void) | undefined;
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal.reason ?? new Error('光照应用验证已取消。'));
      signal.addEventListener('abort', abort, { once: true });
    });
    try { await Promise.race([Promise.resolve().then(validation), cancelled]); }
    finally { if (abort) signal.removeEventListener('abort', abort); }
  }

  /** 验证失败恢复仍在内存中的旧状态，不能依赖读取旧资源成功才能回滚。 */
  private rollbackActivation(activation: PendingLightingActivation): void {
    if (activation.finished) return;
    activation.finished = true;
    if (this.pendingActivation === activation) this.pendingActivation = null;
    const { candidate, previous } = activation;
    if (this.state === candidate) {
      this.detachState(candidate);
      this.state = previous;
      if (!this.disposed) {
        if (previous) {
          // 候选显示期间仍可能收到遥测材质更新；回滚仅换回光照资源，保留这些业务值。
          const replacedMaterials = new Map<AbstractMesh, Material | null>();
          for (const [mesh, original] of previous.originalMaterials) {
            const working = (previous.bindings.get(mesh) as BakedLightingBinding & { workingMaterial?: Material }).workingMaterial;
            if (mesh.material !== original) replacedMaterials.set(mesh, mesh.material);
            else restoreLightingMaterialValues(working ?? null, original, lightingMaterialValueSignature(working ?? null));
          }
          this.activateState(previous);
          for (const [mesh, replacement] of replacedMaterials) mesh.material = replacement;
          if (replacedMaterials.size) this.requestChange('bindings', 'rollback-material-replaced');
        }
        else { this.updateShadowRoles(); this.rebuildDebug(); }
      }
    }
    this.releaseState(candidate, previous?.resources === candidate.resources || this.state?.resources === candidate.resources, false);
    this.notifyBindingsChanged();
  }

  private notifyBindingsChanged(): void {
    if (this.disposed) return;
    try { this.options.onBindingsChanged?.(); } catch (error) { this.reportError(error); }
  }
  private reportError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    if (message !== this.error) this.options.pushLog(`混合光照：${message}`);
    this.setError(message, getLightingRuntimeDiagnostic(error));
  }
  private setError(message: string | null, diagnostic?: LightingRuntimeDiagnostic): void {
    this.error = message;
    this.diagnostic = message === null ? null : diagnostic ?? { message, kind: 'runtime' };
  }
  private refreshSources(entry: LightingInvalidationEntry): void {
    this.dirtyConsumptionDepth++;
    try {
      if (!this.dirty || this.disposed) { this.invalidationDiagnostics.skip('cleanClassification'); return; }
      const revision = this.sourceRevision, started = this.invalidationDiagnostics.beginCollection();
      try {
        const next = this.options.getSources(), keys = new Set<string>();
        for (const source of next) {
          if (keys.has(source.entry.key)) throw new Error(`光照对象标识重复：${source.entry.key}`);
          keys.add(source.entry.key);
        }
        this.sources = next; this.classification = next.map(source => ({ ...source.entry }));
        // 同步getter/回调可在collect内再次失效；旧代结果不能吞掉新一代请求。
        this.dirty = revision !== this.sourceRevision;
        if (this.dirty) this.invalidationDiagnostics.reentrant('classification');
      } finally { this.invalidationDiagnostics.endCollection(entry, started); }
    } finally { this.dirtyConsumptionDepth--; }
  }
  private sourceMaterial(mesh: AbstractMesh): Material | null {
    return this.state?.originalMaterials.has(mesh) && this.state.materials.has(mesh.material!)
      ? this.state.originalMaterials.get(mesh)! : mesh.material;
  }
  private sourceLayerMask(mesh: AbstractMesh): number {
    return this.state?.sourceLayerMasks.get(mesh) ?? this.shadowInstances.getSourceLayerMask(mesh) ?? mesh.layerMask;
  }
  private sourcePickable(mesh: AbstractMesh): boolean {
    return this.state?.sourcePickability.get(mesh) ?? this.shadowInstances.getSourcePickability(mesh) ?? mesh.isPickable;
  }
  private sourceLogicalPickable(source: LightingRuntimeSource): boolean {
    return source.instance
      ? source.instance.batch.isLightingInstancePickable?.(source.instance.mesh, source.instance.sourceIndex) ?? this.sourcePickable(source.mesh)
      : source.mesh.isPickable;
  }

  private prepareState(snapshot: SceneLightingBakeSnapshot, resources: LoadedLightingResources): LightingState {
    const state: LightingState = { snapshot, resources, bindings: new Map(), records: [], materials: new Set(),
      originalMaterials: new Map(), hiddenSources: new Map(), hiddenInstances: new Map(), staticWatch: [], geometryHooks: [], ownedProxies: new Set(),
      originalMaterialValues: new Map(),
      sourceLayerMasks: new Map(this.sources.map(source => [source.mesh, this.sourceLayerMask(source.mesh)])),
      sourcePickability: new Map(this.sources.map(source => [source.mesh, this.sourcePickable(source.mesh)])),
      sourceLayoutKey: this.sourceLayoutKey(), dynamicGeometryTargets: new Map(),
      lightSignature: lightingContentHash(captureLightingEnvironment(this.scene, this.document!)) };
    const sources = new Map(this.sources.map(source => [source.entry.key, source]));
    const materialCache = new Map<Material, Material>(), dynamicGeometry = state.dynamicGeometryTargets;
    const material = (original: Material | null): Material => {
      const baseline = original ?? this.scene.defaultMaterial;
      const cached = materialCache.get(baseline);
      if (cached) return cached;
      if (baseline instanceof MultiMaterial) {
        const clone = new MultiMaterial(`${baseline.name}:lighting`, this.scene);
        materialCache.set(baseline, clone); state.materials.add(clone);
        clone.subMaterials = baseline.subMaterials.map(child => material(child));
        return clone;
      }
      if (!(baseline instanceof PBRMaterial) && !(baseline instanceof StandardMaterial)) throw new Error(`材质「${baseline.name}」不支持混合间接光，已保留原画面。`);
      const clone = baseline.clone(`${baseline.name}:lighting`);
      if (!clone) throw new Error(`无法复制材质「${baseline.name}」。`);
      copyLightingMaterialExportBaseline(baseline, clone);
      clone.unfreeze(); state.materials.add(clone); materialCache.set(baseline, clone);
      new BakedLightingMaterialPlugin(clone, mesh => state.bindings.get(mesh) ?? { enabled: false });
      return clone;
    };
    const registerProxy = (source: LightingRuntimeSource, proxy: Mesh): void => {
      state.ownedProxies.add(proxy);
      proxy.metadata = { ...source.mesh.metadata, lightingDerived: true, lightingSourceKey: source.entry.key,
        entityId: source.entry.entityId, editorEntityId: source.entry.entityId };
      proxy.setEnabled(false); proxy.isPickable = this.sourceLogicalPickable(source); proxy.layerMask = this.sourceLayerMask(source.mesh);
      proxy.isVisible = lightingSourceVisible(source); proxy.visibility = source.mesh.visibility;
      proxy.renderingGroupId = source.mesh.renderingGroupId; proxy.receiveShadows = source.entry.receiveShadows;
      proxy.alphaIndex = source.mesh.alphaIndex; proxy.applyFog = source.mesh.applyFog;
      proxy.overrideMaterialSideOrientation = sourceGeometryMesh(source.mesh).overrideMaterialSideOrientation;
      if (source.instance) {
        const batches = state.hiddenInstances.get(source.instance.batch) ?? new Map<number, Set<number>>();
        const indexes = batches.get(source.instance.mesh.uniqueId) ?? new Set<number>();
        indexes.add(source.instance.sourceIndex); batches.set(source.instance.mesh.uniqueId, indexes);
        state.hiddenInstances.set(source.instance.batch, batches);
      } else state.hiddenSources.set(source.mesh, this.sourceLayerMask(source.mesh));
      // 不进入业务层级，避免参数脚本或设备驱动再次遍历并驱动代理。
      proxy.parent = null;
      const world = source.getWorldMatrix(); if (!world) throw new Error(`对象「${source.entry.name}」已经失效。`);
      applyWorldMatrix(proxy, world);
    };
    this.creatingDerived = true;
    try {
      const covered = new Set<string>(), coveredSurfaces = new Set<string>();
      for (const surface of snapshot.surfaces) {
        const identity = sourceParentKey(surface.key), source = sources.get(identity.key);
        if (!source || source.entry.mobility !== 'static' || !source.entry.bakeIndirect || !lightingSourceVisible(source)
          || source.entry.entityId !== surface.entityId || source.entry.nodeKey !== surface.nodeKey) throw new Error(`光照表面「${surface.key}」找不到当前静态节点。`);
        const geometry = resources.geometries.get(surface.geometryAssetId), texture = resources.textures.get(surface.lightmapAssetId);
        const asset = snapshot.assets.find(value => value.id === surface.lightmapAssetId);
        if (!geometry || !texture || !asset) throw new Error(`光照表面「${surface.key}」的资源缺失。`);
        const proxy = new Mesh(`__LightingDerived_${lightingContentHash(surface.key)}`, this.scene);
        registerProxy(source, proxy);
        const data = new VertexData();
        data.positions = geometry.positions; data.normals = geometry.normals; data.indices = geometry.indices;
        data.uvs = geometry.uvs; if (geometry.uvs2) data.uvs2 = geometry.uvs2;
        if (geometry.colors) data.colors = geometry.colors; if (geometry.tangents) data.tangents = geometry.tangents;
        data.applyToMesh(proxy, false);
        proxy.setVerticesData(LIGHTING_UV_ATTRIBUTE, geometry.bakeUvs, false, 2);
        proxy.useVertexColors = source.mesh.useVertexColors; proxy.hasVertexAlpha = source.mesh.hasVertexAlpha;
        const original = this.sourceMaterial(source.mesh), sourceGeometry = sourceGeometryMesh(source.mesh);
        const materialIndex = sourceGeometry.subMeshes[identity.primitive]?.materialIndex ?? 0;
        proxy.material = material(original instanceof MultiMaterial ? original.subMaterials[materialIndex] : original);
        const binding = { texture, rgbmRange: asset.rgbmRange ?? 1, enabled: !this.beforeBake && !this.suppressPreviewIndirect };
        state.bindings.set(proxy, binding); state.records.push({ source, mesh: proxy, binding, proxy: true, dynamic: false, lastProbePosition: null });
        covered.add(source.entry.key);
        coveredSurfaces.add(`${identity.key}/primitive:${identity.primitive}`);
      }
      for (const source of this.sources) {
        if (source.entry.mobility === 'static') {
          if (lightingSourceVisible(source) && source.entry.bakeIndirect) {
            const geometry = sourceGeometryMesh(source.mesh), groups = geometry.subMeshes;
            const expected = groups.length ? groups.flatMap((group, index) => (geometry.isUnIndexed ? group.verticesCount : group.indexCount)
              ? [`${source.entry.key}/primitive:${index}`] : []) : [`${source.entry.key}/primitive:0`];
            if (!expected.length || expected.some(key => !coveredSurfaces.has(key))) throw new Error(`静态表面「${source.entry.name}」没有完整的材质分组光照资源。`);
          }
          const matrix = source.getWorldMatrix();
          if (!matrix) throw new Error(`静态对象「${source.entry.name}」矩阵失效。`);
          state.staticWatch.push({ source, matrix: matrix.clone(), visible: lightingSourceVisible(source), visibility: source.mesh.visibility,
            material: lightingMaterialFingerprint(source.mesh), geometry: sourceGeometryMesh(source.mesh).geometry,
            instanceRevision: lightingInstanceRevision(source), carrierMatrix: source.instance ? source.mesh.computeWorldMatrix(true).clone() : null });
          // 原生 thin instance 的代理接管整个载体；未烘焙的静态叶片也需基线代理以免丢失。
          if (!source.instance || covered.has(source.entry.key)) continue;
        }
        let mesh: AbstractMesh = source.mesh;
        const needsProxy = Boolean(source.instance) || source.mesh instanceof InstancedMesh;
        if (needsProxy) {
          const original = sourceGeometryMesh(source.mesh), proxy = new Mesh(`__LightingDerived_${lightingContentHash(source.entry.key)}`, this.scene);
          registerProxy(source, proxy);
          const cachedGeometry = dynamicGeometry.get(original);
          if (cachedGeometry) cachedGeometry.applyToMesh(proxy);
          else {
            VertexData.ExtractFromMesh(original, true, true).applyToMesh(proxy, false);
            if (proxy.geometry) dynamicGeometry.set(original, proxy.geometry);
          }
          proxy.releaseSubMeshes();
          for (const sub of original.subMeshes) new SubMesh(sub.materialIndex, sub.verticesStart, sub.verticesCount, sub.indexStart, sub.indexCount, proxy);
          proxy.skeleton = original.skeleton; proxy.morphTargetManager = original.morphTargetManager;
          proxy.useVertexColors = original.useVertexColors; proxy.hasVertexAlpha = original.hasVertexAlpha;
          proxy.material = source.entry.mobility === 'static' ? this.sourceMaterial(source.mesh) : material(this.sourceMaterial(source.mesh)); mesh = proxy;
        } else state.originalMaterials.set(mesh, this.sourceMaterial(mesh));
        const binding: BakedLightingBinding = { enabled: !this.beforeBake && !this.suppressPreviewIndirect };
        state.bindings.set(mesh, binding);
        state.records.push({ source, mesh, binding, proxy: needsProxy, dynamic: source.entry.mobility === 'dynamic', lastProbePosition: null,
          ...(needsProxy ? { sourceMaterial: source.mesh.material, sourceMaterialSignature: lightingMaterialValueSignature(source.mesh.material) } : {}) });
        if (!needsProxy) material(mesh.material);
      }
      // 暂存工作材质映射，正式提交前不改任何源网格的材质。
      for (const [mesh, original] of state.originalMaterials) {
        const working = material(mesh.material ?? original);
        (state.bindings.get(mesh) as BakedLightingBinding & { workingMaterial?: Material }).workingMaterial = working;
      }
      return state;
    } catch (error) { this.releaseState(state, true, false); throw error; }
    finally { this.creatingDerived = false; }
  }

  private commitState(candidate: LightingState, preservePrevious = false, notify = true): LightingState | null {
    this.dirtyConsumptionDepth++;
    try {
      const previous = this.state, revision = this.bindingsRevision;
      if (previous) this.detachState(previous);
      try {
        this.state = candidate;
        this.restoreProxyLightPolicies(); this.shadowInstances.clear();
        this.activateState(candidate);
        this.bindingsDirty = revision !== this.bindingsRevision;
      } catch (error) {
        this.detachState(candidate);
        this.state = previous;
        if (previous) this.activateState(previous);
        else this.updateShadowRoles();
        throw error;
      }
      if (previous && !preservePrevious) this.releaseState(previous, previous.resources === candidate.resources, false);
      if (notify) this.notifyBindingsChanged();
      return previous;
    } finally { this.dirtyConsumptionDepth--; }
  }

  private activateState(state: LightingState): void {
    for (const [mesh] of state.originalMaterials) {
      state.originalMaterialValues.set(mesh, lightingMaterialValueSignature(state.originalMaterials.get(mesh)!));
      const binding = state.bindings.get(mesh) as BakedLightingBinding & { workingMaterial?: Material };
      mesh.material = binding.workingMaterial!;
    }
    for (const [mesh] of state.hiddenSources) mesh.layerMask = 0;
    for (const [batch, hidden] of state.hiddenInstances) batch.setLightingHiddenInstances(hidden);
    for (const record of state.records) if (record.proxy) record.mesh.setEnabled(true);
    this.installGeometryHooks(state); this.updateDynamicBindings(true); this.updateShadowRoles(); this.rebuildDebug();
  }

  private detachState(state: LightingState): void {
    for (const hook of state.geometryHooks) if (hook.geometry.onGeometryUpdated === hook.listener) hook.geometry.onGeometryUpdated = hook.previous;
    state.geometryHooks.length = 0;
    this.restoreProxyLightPolicies();
    for (const [mesh, original] of state.originalMaterials) if (state.materials.has(mesh.material!)) {
      restoreLightingMaterialValues(original, mesh.material, state.originalMaterialValues.get(mesh) ?? 'changed');
      mesh.material = original;
    }
    for (const [mesh, layerMask] of state.hiddenSources) if (!mesh.isDisposed() && mesh.layerMask === 0) mesh.layerMask = layerMask;
    for (const [batch] of state.hiddenInstances) batch.setLightingHiddenInstances(new Map());
    for (const proxy of state.ownedProxies) if (!proxy.isDisposed()) proxy.setEnabled(false);
  }

  private installGeometryHooks(state: LightingState): void {
    const tracked = new Set<Geometry>();
    for (const watch of state.staticWatch) {
      const geometry = watch.geometry;
      if (!geometry || tracked.has(geometry)) continue;
      tracked.add(geometry);
      const previous = geometry.onGeometryUpdated;
      const listener: Geometry['onGeometryUpdated'] = (value, kind) => {
        previous?.(value, kind);
        if (kind && ['world0', 'world1', 'world2', 'world3', 'instanceSelectionId'].includes(kind)) return;
        this.pendingInvalidation = `静态对象「${watch.source.entry.name}」的几何发生变化，请重新烘焙。`;
      };
      registerGeometryUpdateDelegate(geometry, listener, previous);
      geometry.onGeometryUpdated = listener; state.geometryHooks.push({ geometry, previous, listener });
    }
    for (const [source] of state.dynamicGeometryTargets) {
      const geometry = source.geometry;
      if (!geometry || tracked.has(geometry)) continue;
      tracked.add(geometry);
      const previous = geometry.onGeometryUpdated;
      const listener: Geometry['onGeometryUpdated'] = (value, kind) => {
        previous?.(value, kind);
        if (kind && ['world0', 'world1', 'world2', 'world3', 'instanceSelectionId'].includes(kind)) return;
        this.changedDynamicGeometry.add(source);
      };
      registerGeometryUpdateDelegate(geometry, listener, previous);
      geometry.onGeometryUpdated = listener; state.geometryHooks.push({ geometry, previous, listener });
    }
  }

  private releaseState(state: LightingState, preserveResources = false, restoreSources = true): void {
    if (state.released) return;
    state.released = true;
    this.creatingDerived = true;
    try {
      if (restoreSources) this.detachState(state);
      for (const proxy of state.ownedProxies) proxy.dispose(false, false);
      for (const material of state.materials) material.dispose(false, false);
      if (!preserveResources) state.resources.dispose();
    } finally { this.creatingDerived = false; }
  }
  private clearState(): void {
    const changed = Boolean(this.state || this.pendingActivation);
    if (this.pendingActivation) this.cancelPending();
    if (this.state) this.releaseState(this.state);
    this.state = null; this.pendingInvalidation = null; this.restoreProxyLightPolicies();
    this.changedDynamicGeometry.clear();
    if (changed) this.notifyBindingsChanged();
  }

  private refreshBindingsForSources(entry: LightingInvalidationEntry): void {
    this.dirtyConsumptionDepth++;
    try {
      const revision = this.bindingsRevision, structure = this.structureRevision;
      const force = structure !== this.consumedStructureRevision;
      this.invalidationDiagnostics.bindingRefresh(entry, force);
      try {
        this.refreshSources(entry);
        if (!this.state) {
          const hadProxies = this.shadowInstances.records.length > 0;
          if (force) {
            const creatingDerived = this.creatingDerived; this.creatingDerived = true;
            try { this.restoreProxyLightPolicies(); this.shadowInstances.clear(); }
            finally { this.creatingDerived = creatingDerived; }
          }
          this.updateShadowRoles(); this.rebuildDebug();
          if (force && hadProxies && !this.shadowInstances.records.length) this.notifyBindingsChanged();
          this.consumedStructureRevision = Math.max(this.consumedStructureRevision, structure);
          return;
        }
        if (this.state.snapshot.geometrySignature && getLightingGeometrySignature(this.sources) !== this.state.snapshot.geometrySignature) {
          this.invalidate('静态对象集合或实际几何发生变化，请重新烘焙。');
          this.consumedStructureRevision = Math.max(this.consumedStructureRevision, structure); return;
        }
        if (force || this.state.sourceLayoutKey !== this.sourceLayoutKey() || this.dynamicMaterialReplaced(this.state)) {
          try {
            this.commitState(this.prepareState(this.state.snapshot, this.state.resources)); this.setError(null);
            this.consumedStructureRevision = Math.max(this.consumedStructureRevision, structure);
          } catch (error) { this.reportError(error); this.updateShadowRoles(); }
        } else { this.updateShadowRoles(); this.rebuildDebug(); }
      } finally {
        const reentered = revision !== this.bindingsRevision;
        this.bindingsDirty = reentered || this.structureRevision !== this.consumedStructureRevision;
        if (reentered) this.invalidationDiagnostics.reentrant('bindings');
      }
    } finally { this.dirtyConsumptionDepth--; }
  }
  private sourceLayoutKey(): string {
    return lightingContentHash(this.sources.map(source => [source.entry.key, source.mesh.uniqueId, source.entry.mobility,
      source.entry.bakeIndirect, source.entry.castShadows, source.entry.receiveShadows, source.instance?.sourceIndex]));
  }
  private staticMaterialSignature(): string {
    const cache = new Map<AbstractMesh, string>();
    return lightingContentHash(this.sources.filter(source => source.entry.mobility === 'static' && lightingSourceVisible(source))
      .map(source => {
        let signature = cache.get(source.mesh);
        if (!signature) { signature = lightingMaterialFingerprint(source.mesh); cache.set(source.mesh, signature); }
        return [source.entry.key, signature];
      }));
  }
  private invalidate(message: string): void {
    this.invalidatedSnapshotKey = this.state ? this.snapshotKey(this.state.snapshot) : this.desiredSnapshotKey;
    this.clearState(); this.setError(message); this.options.pushLog(`混合光照已恢复实时基线：${message}`);
    this.updateShadowRoles(); this.rebuildDebug();
  }

  private tick(): void {
    if (this.disposed) return;
    try {
      if (this.state && !this.bindingsDirty && this.dynamicMaterialReplaced(this.state)) this.requestChange('bindings', 'dynamic-material-replaced');
      if ((this.dirty || this.bindingsDirty) && !this.pendingActivation) {
        this.refreshBindingsForSources('frame');
        if (!this.state && this.document && getSceneLightingConfig(this.document).result && !this.controller) this.sync(this.document);
      } else this.invalidationDiagnostics.skip(this.pendingActivation ? 'pendingActivation' : 'cleanBindings');
      const state = this.state;
      if (state) {
        if (this.pendingInvalidation) { this.invalidate(this.pendingInvalidation); return; }
        const sourceState = new Map<AbstractMesh, { visibility: number; material: string; geometry: Geometry | null; carrierMatrix: Matrix }>();
        const revisions = new Map<LightingInstanceBatch, number | null>();
        for (const watch of state.staticWatch) {
          let current = sourceState.get(watch.source.mesh);
          if (!current) {
            current = { visibility: watch.source.mesh.visibility, material: lightingMaterialFingerprint(watch.source.mesh),
              geometry: sourceGeometryMesh(watch.source.mesh).geometry, carrierMatrix: watch.source.mesh.computeWorldMatrix(true) };
            sourceState.set(watch.source.mesh, current);
          }
          let revision: number | null = null;
          if (watch.source.instance) {
            const batch = watch.source.instance.batch;
            if (!revisions.has(batch)) revisions.set(batch, lightingInstanceRevision(watch.source));
            revision = revisions.get(batch)!;
          }
          const unchangedInstance = revision !== null && revision === watch.instanceRevision && watch.carrierMatrix
            && !matrixChanged(watch.carrierMatrix, current.carrierMatrix);
          const matrix = unchangedInstance ? watch.matrix : watch.source.getWorldMatrix();
          if (!matrix || matrixChanged(watch.matrix, matrix) || watch.visible !== lightingSourceVisible(watch.source)
            || watch.visibility !== current.visibility || watch.geometry !== current.geometry || watch.material !== current.material) {
            this.invalidate(`静态对象「${watch.source.entry.name}」的姿态、显隐、几何或材质发生变化，请重新烘焙。`); return;
          }
          watch.instanceRevision = revision;
        }
        if (!this.temporaryLightingPreview && state.lightSignature !== lightingContentHash(captureLightingEnvironment(this.scene, this.document!))) {
          this.invalidate('参与烘焙的灯光或环境照明发生变化，请重新烘焙。'); return;
        }
        this.refreshDynamicGeometry(state);
        this.updateDynamicBindings(false);
      } else this.shadowInstances.update();
      this.updateDebugMatrices();
    } catch (error) { this.reportError(error); }
  }

  private updateDynamicBindings(force: boolean): void {
    const state = this.state;
    if (!state) return;
    let coverageChanged = false;
    const materialSignatures = new Map<Material | null, string>(), synchronizedMaterials = new Set<Material>();
    let occlusion: LightingProbeOcclusionQuery | undefined;
    for (const record of state.records) {
      if (record.proxy) record.mesh.isPickable = this.sourceLogicalPickable(record.source);
      if (!record.dynamic) continue;
      record.binding.enabled = !this.beforeBake && !this.suppressPreviewIndirect;
      const world = record.source.getWorldMatrix();
      if (!world) continue;
      if (record.proxy) {
        record.mesh.isVisible = lightingSourceVisible(record.source);
        record.mesh.visibility = record.source.mesh.visibility;
        applyWorldMatrix(record.mesh as Mesh, world);
      }
      if (record.proxy) {
        const sourceMaterial = record.source.mesh.material;
        let signature = materialSignatures.get(sourceMaterial);
        if (signature === undefined) { signature = lightingMaterialValueSignature(sourceMaterial); materialSignatures.set(sourceMaterial, signature); }
        if (signature !== record.sourceMaterialSignature) {
          if (record.mesh.material && !synchronizedMaterials.has(record.mesh.material)) {
            restoreLightingMaterialValues(record.mesh.material, sourceMaterial, lightingMaterialValueSignature(record.mesh.material));
            synchronizedMaterials.add(record.mesh.material);
          }
          record.sourceMaterialSignature = signature;
        }
      }
      const bounds = sourceGeometryMesh(record.source.mesh).rawBoundingInfo?.boundingBox ?? record.source.mesh.getBoundingInfo().boundingBox;
      const position = Vector3.TransformCoordinates(bounds.center, world);
      if (!force && record.lastProbePosition && Vector3.DistanceSquared(position, record.lastProbePosition) < 0.0001) continue;
      record.lastProbePosition = position.clone();
      // 仅在实际发生采样时构建，当前同步边界结束即释放，保留同帧业务修改的可见性。
      occlusion ??= new LightingProbeOcclusionQuery(state.staticWatch.filter(watch => watch.visible).map(watch => ({
        key: watch.source.entry.key, mesh: sourceGeometryMesh(watch.source.mesh), getWorldMatrix: () => watch.source.getWorldMatrix(),
      })));
      const probes = state.resources.probes.sample([position.x, position.y, position.z], point => occlusion!.visible(position, point, record.source.entry.key));
      if (Boolean(record.binding.probes) !== Boolean(probes)) coverageChanged = true;
      record.binding.probes = probes ?? undefined;
    }
    if (force || coverageChanged) this.updateProxyLightPolicies();
  }

  private dynamicMaterialReplaced(state: LightingState): boolean {
    return state.records.some(record => record.dynamic && (record.proxy
      ? record.source.mesh.material !== record.sourceMaterial
      : !state.materials.has(record.mesh.material!)));
  }

  private refreshDynamicGeometry(state: LightingState): void {
    for (const source of this.changedDynamicGeometry) {
      const target = state.dynamicGeometryTargets.get(source);
      if (!target || source.isDisposed()) continue;
      VertexData.ExtractFromMesh(source, true, true).applyToGeometry(target, true);
      for (const record of state.records) {
        if (!record.proxy || sourceGeometryMesh(record.source.mesh) !== source) continue;
        const proxy = record.mesh as Mesh;
        proxy.releaseSubMeshes();
        for (const sub of source.subMeshes) new SubMesh(sub.materialIndex, sub.verticesStart, sub.verticesCount, sub.indexStart, sub.indexCount, proxy);
        proxy.refreshBoundingInfo();
      }
    }
    this.changedDynamicGeometry.clear();
  }

  private updateShadowRoles(): void {
    let shadowInstancesChanged: boolean;
    this.creatingDerived = true;
    try {
      shadowInstancesChanged = this.shadowInstances.sync(this.sources, Boolean(!this.state && !this.disposed
        && this.document && getSceneLightingConfig(this.document).shadows.enabled));
    } finally { this.creatingDerived = false; }
    const roles = new Map<AbstractMesh, ShadowRole>();
    for (const source of this.sources) {
      const role = roles.get(source.mesh);
      roles.set(source.mesh, { mobility: role?.mobility === 'dynamic' || source.entry.mobility === 'dynamic' ? 'dynamic' : 'static',
        castShadows: (role?.castShadows ?? false) || source.entry.castShadows, receiveShadows: (role?.receiveShadows ?? false) || source.entry.receiveShadows });
    }
    const visible = this.state ?? this.shadowInstances;
    if (visible.records.length) {
      for (const [mesh] of visible.hiddenSources) roles.set(mesh, { mobility: 'static', castShadows: false, receiveShadows: false });
      for (const record of visible.records) if (record.source.instance) roles.set(record.source.instance.mesh, { mobility: 'static', castShadows: false, receiveShadows: false });
      for (const record of visible.records) roles.set(record.mesh, { mobility: record.source.entry.mobility,
        castShadows: record.source.entry.castShadows, receiveShadows: record.source.entry.receiveShadows });
    }
    this.options.setShadowRoles(roles, getSceneLightingConfig(this.document).bake);
    if (!this.state) this.updateProxyLightPolicies();
    if (shadowInstancesChanged) this.notifyBindingsChanged();
  }
  private restoreProxyLightPolicies(): void {
    if (this.lightPolicyObserver) this.scene.onBeforeRenderObservable.remove(this.lightPolicyObserver);
    this.lightPolicyObserver = null;
    for (const [light, policy] of this.proxyLightPolicies) {
      if (light.isDisposed()) continue;
      const included = this.readLightPolicy(light.includedOnlyMeshes, policy.appliedIncluded, policy.addedIncluded);
      const excluded = this.readLightPolicy(light.excludedMeshes, policy.appliedExcluded, policy.addedExcluded);
      this.applyLightPolicy(light, included, excluded, true);
    }
    this.proxyLightPolicies.clear();
    this.lightPolicySignature = '';
  }

  /** 只移除本运行时注入的代理；用户运行期间替换/追加的过滤规则仍是新的权威值。 */
  private readLightPolicy(current: AbstractMesh[], applied: AbstractMesh[], additions: ReadonlySet<AbstractMesh>): AbstractMesh[] {
    if (current !== applied) return [...current];
    const remaining = new Set(additions);
    return current.filter(mesh => !remaining.delete(mesh));
  }

  private currentLightPolicySignature(): string {
    return this.scene.lights.map(light => [
      light.uniqueId, light.includeOnlyWithLayerMask, light.excludeWithLayerMask,
      light.includedOnlyMeshes.map(mesh => mesh.uniqueId).join(','),
      light.excludedMeshes.map(mesh => mesh.uniqueId).join(','),
    ].join(':')).join('|');
  }

  private applyLightPolicy(light: Light, included: AbstractMesh[], excluded: AbstractMesh[], forceResync = false): void {
    const equal = (a: AbstractMesh[], b: AbstractMesh[]) => a.length === b.length && a.every((mesh, index) => mesh === b[index]);
    if (!forceResync && equal(light.includedOnlyMeshes, included) && equal(light.excludedMeshes, excluded)) return;
    const affected = new Set([...light.includedOnlyMeshes, ...light.excludedMeshes, ...included, ...excluded,
      ...this.renderingRecords().map(record => record.mesh)]);
    light.excludedMeshes = [...excluded];
    // Babylon 的 excludedMeshes=[] setter 不会重同步被移除的网格；included setter 会完整刷新。
    light.includedOnlyMeshes = [...included];
    const materials = new Set<Material>();
    for (const mesh of affected) {
      const material = mesh.material;
      if (material instanceof MultiMaterial) for (const child of material.subMaterials) { if (child) materials.add(child); }
      else if (material) materials.add(material);
    }
    for (const material of materials) {
      const frozen = material.isFrozen;
      if (frozen) material.unfreeze();
      material.markAsDirty(Material.LightDirtyFlag);
      if (frozen) { material.freeze(); material.markDirty(true); }
    }
  }

  private updateProxyLightPolicies(): void {
    const records = this.renderingRecords();
    if (!records.length) { this.restoreProxyLightPolicies(); return; }
    const policyChanged = this.currentLightPolicySignature() !== this.lightPolicySignature;
    const lights = new Set(this.scene.lights);
    for (const [light, policy] of this.proxyLightPolicies) {
      if (lights.has(light)) continue;
      if (!light.isDisposed()) this.applyLightPolicy(light,
        this.readLightPolicy(light.includedOnlyMeshes, policy.appliedIncluded, policy.addedIncluded),
        this.readLightPolicy(light.excludedMeshes, policy.appliedExcluded, policy.addedExcluded));
      this.proxyLightPolicies.delete(light);
    }
    for (const light of lights) {
      const old = this.proxyLightPolicies.get(light);
      const included = old ? this.readLightPolicy(light.includedOnlyMeshes, old.appliedIncluded, old.addedIncluded) : [...light.includedOnlyMeshes];
      const excluded = old ? this.readLightPolicy(light.excludedMeshes, old.appliedExcluded, old.addedExcluded) : [...light.excludedMeshes];
      const nextIncluded = new Set(included), nextExcluded = new Set(excluded);
      for (const record of records) {
        if (record.mesh === record.source.mesh) continue;
        if (included.includes(record.source.mesh)) nextIncluded.add(record.mesh);
        if (excluded.includes(record.source.mesh)) nextExcluded.add(record.mesh);
      }
      const addedIncluded = new Set([...nextIncluded].filter(mesh => !included.includes(mesh)));
      const addedExcluded = new Set([...nextExcluded].filter(mesh => !excluded.includes(mesh)));
      this.applyLightPolicy(light, [...nextIncluded], [...nextExcluded], policyChanged);
      this.proxyLightPolicies.set(light, { addedIncluded, addedExcluded,
        appliedIncluded: light.includedOnlyMeshes, appliedExcluded: light.excludedMeshes });
    }
    // 所有原生灯都需继承源网格过滤；GI shader 仅替换 Hemi 的 diffuse，其余原生光照持续实时绑定。
    this.lightPolicySignature = this.currentLightPolicySignature();
    this.lightPolicyObserver ??= this.scene.onBeforeRenderObservable.add(() => {
      if (this.currentLightPolicySignature() !== this.lightPolicySignature) this.updateProxyLightPolicies();
    });
  }

  private clearDebug(): void {
    this.creatingDerived = true;
    try {
      for (const overlay of this.debugOverlays) overlay.mesh.dispose(false, false);
      for (const material of this.debugMaterials) material.dispose(false, false);
      this.debugOverlays = []; this.debugMaterials = [];
    } finally { this.creatingDerived = false; }
  }
  private rebuildDebug(): void {
    this.clearDebug();
    if (!this.debugVisible || this.disposed) return;
    const materials = new Map<string, StandardMaterial>(), geometry = new Map<Mesh, Geometry>();
    this.creatingDerived = true;
    try {
      for (const source of this.sources) {
        const original = sourceGeometryMesh(source.mesh);
        let material = materials.get(source.entry.mobility);
        if (!material) {
          material = new StandardMaterial(`__lighting_debug_${source.entry.mobility}`, this.scene);
          material.disableLighting = true; material.emissiveColor = source.entry.mobility === 'static' ? Color3.FromHexString('#19d4dc') : Color3.FromHexString('#ff9b36');
          material.wireframe = true; material.zOffset = -2; material.alpha = 0.8;
          materials.set(source.entry.mobility, material); this.debugMaterials.push(material);
        }
        const mesh = new Mesh(`__LightingDebug_${lightingContentHash(source.entry.key)}`, this.scene);
        mesh.metadata = { lightingDerived: true, editorHelper: true };
        mesh.isPickable = false; mesh.layerMask = this.sourceLayerMask(source.mesh); mesh.renderingGroupId = source.mesh.renderingGroupId;
        const cached = geometry.get(original);
        if (cached) cached.applyToMesh(mesh);
        else { VertexData.ExtractFromMesh(original, true, true).applyToMesh(mesh, false); if (mesh.geometry) geometry.set(original, mesh.geometry); }
        mesh.material = material; mesh.useVertexColors = false; mesh.skeleton = original.skeleton; mesh.morphTargetManager = original.morphTargetManager;
        this.debugOverlays.push({ source, mesh });
      }
      this.updateDebugMatrices();
    } finally { this.creatingDerived = false; }
  }
  private updateDebugMatrices(): void {
    for (const { source, mesh } of this.debugOverlays) {
      const matrix = source.getWorldMatrix();
      mesh.isVisible = !!matrix && lightingSourceVisible(source);
      if (matrix) applyWorldMatrix(mesh, matrix);
    }
  }
}
