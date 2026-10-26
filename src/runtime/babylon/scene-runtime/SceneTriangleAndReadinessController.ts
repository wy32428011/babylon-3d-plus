import type { SceneModelStatisticsSnapshot } from '../../../editor/model/sceneModelStatistics';
import { countModelMeshTriangles } from '../modelTriangleStatistics';

import { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh.js';
import { InstancedMesh } from '@babylonjs/core/Meshes/instancedMesh.js';
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';

import type { Nullable, Observer, ISceneLoaderProgressEvent, Node } from '@babylonjs/core';
import { type SceneDocument } from '../../../editor/model/SceneDocument';
import { resolveModelGeneratorTargetFromSnapshot } from '../modelGeneratorRuntime';
import { getExternalModelScriptLoadDiagnostics } from '../ExternalModelScriptRuntime';
import { waitForSceneRenderReady } from '../sceneRenderReadiness';
import { SceneLoadDiagnostics } from '../SceneLoadDiagnostics';
import { prepareGpuCapabilityProfile } from '../gpuCapabilityProfile';
import type { Engine } from '@babylonjs/core/Engines/engine.js';
import { EntityArrayThinInstanceBatch } from '../EntityArrayThinInstanceBatch';
import type { SceneRuntimeContext } from './SceneRuntimeContext';
import type { SceneDocumentController } from './SceneDocumentController';
import type { SceneWorldBoundsController } from './SceneWorldBoundsController';
import type { SceneMeshPresentationController } from './SceneMeshPresentationController';
import type { ModelAssetRuntimeController } from './ModelAssetRuntimeController';
import type { ParameterVariantHostPool } from './ParameterVariantHostPool';
import type { ModelArrayRuntimeController } from './ModelArrayRuntimeController';
import type { GeneratedModelOutputController } from './GeneratedModelOutputController';
import type { SceneLocatorFetchController } from './SceneLocatorFetchController';
import type { EnvironmentAndSkyboxController } from './EnvironmentAndSkyboxController';
import type { ScenePickingAndSelectionController } from './ScenePickingAndSelectionController';
import type { ScenePoiAndEffectsController } from './ScenePoiAndEffectsController';
import type { SceneTransformPreviewController } from './SceneTransformPreviewController';
import type { SceneTelemetryController } from './SceneTelemetryController';
import { type ModelRuntimeEntry, type GeneratedOutputOwnerRuntimeEntry, type SceneRuntimeModelLoadProgress, type SceneRuntimePerformanceMetrics } from './sceneRuntimeTypes';

/** 此领域仅能访问明确列出的协作能力，资源与缓存由所属 Controller 持有。 */
type Dependencies = {
  readonly document: Pick<SceneDocumentController, 'disposed' | 'syncedEntities' | 'shadowDocument' | 'fullSyncCount' | 'lastFullSyncDurationMs' | 'maxFullSyncDurationMs' | 'sync'>;
  readonly bounds: Pick<SceneWorldBoundsController, 'isModelBoundsMesh'>;
  readonly presentation: Pick<SceneMeshPresentationController, 'meshes'>;
  readonly assets: Pick<ModelAssetRuntimeController, 'models' | 'sharedModelAssetCache' | 'shaderWarmup' | 'disposeModel' | 'modelPresentationRefreshPending'>;
  readonly variants: Pick<ParameterVariantHostPool, 'modelArrayParameterVariants' | 'modelArrayParameterVariantByEntityId' | 'disposeModelArrayParameterVariant'>;
  readonly arrays: Pick<ModelArrayRuntimeController, 'modelArrayInstanceEntities' | 'createModelArrayRenderSignature' | 'modelArrayIdentityMode'>;
  readonly outputs: Pick<GeneratedModelOutputController, 'generatorAssetPreloader' | 'spawnedDeviceModels' | 'generatedOutputOwners' | 'disposeModelGeneratorOutput' | 'syncModelGeneratorResolvedTarget'>;
  readonly fetch: Pick<SceneLocatorFetchController, 'locatorFetchRuntimes'>;
  readonly environment: Pick<EnvironmentAndSkyboxController, 'environmentRuntime' | 'skyboxRuntime' | 'environmentAssetCache' | 'lightingRuntime'>;
  readonly selection: Pick<ScenePickingAndSelectionController, 'selectionSyncCount' | 'lastSelectionSyncDurationMs' | 'maxSelectionSyncDurationMs' | 'lastSelectionChangedEntityCount' | 'rebuildModelSelectionOutline'>;
  readonly effects: Pick<ScenePoiAndEffectsController, 'getModelEntranceSnapshot'>;
  readonly transforms: Pick<SceneTransformPreviewController, 'refreshGroupTransformPreviewTargets'>;
  readonly telemetry: Pick<SceneTelemetryController, 'motionStaticBatchRuntime'>;
};


/** SceneTriangleAndReadinessController 的资源、状态及取消/释放操作在同一领域内维护。 */
export class SceneTriangleAndReadinessController {
  constructor(private readonly context: SceneRuntimeContext, private readonly dependencies: Dependencies) {}

  /** 模型统计只在业务结构变化后失效；没有订阅方时不主动扫描。 */
  get onModelStatisticsChanged(): ((snapshot: SceneModelStatisticsSnapshot) => void) | undefined { return this.context.onModelStatisticsChanged; }
  set onModelStatisticsChanged(callback: ((snapshot: SceneModelStatisticsSnapshot) => void) | undefined) { this.context.onModelStatisticsChanged = callback; }
  public modelStatisticsSnapshot: SceneModelStatisticsSnapshot | null = null;
  public modelStatisticsDirty = true;
  public modelStatisticsNotificationPending = false;
  public modelStatisticsEnvironmentSourceUrl!: string | null | undefined;
  public readonly modelStatisticsFallbackMeshes = new Set<Mesh>();
  public modelStatisticsMeshAddedObserver!: Nullable<Observer<AbstractMesh>>;
  public modelStatisticsMeshRemovedObserver!: Nullable<Observer<AbstractMesh>>;
  /** acquire 失败会销毁条目，错误需保留到该实体下一次加载尝试。 */
  public readonly modelReadinessErrors = new Map<string, { entityIds: string[]; error: string }>();
  public readonly loadDiagnostics = new SceneLoadDiagnostics();
  public progressNotificationPending = false;
  public failedModelAcquisitions = 0;
  /** 模型加载进度单元序号与最近上报字节进度；单元在 loadModelRuntimeAssets 或环境加载期间登记。 */
  public modelLoadProgressSequence = 0;
  public modelLoadProgressReportSequence = 0;
  public modelLoadProgressStartedCount = 0;
  public modelLoadProgressSettledCount = 0;
  public readonly activeModelLoadProgress = new Map<number, {
    fileName: string | null;
    loaded: number;
    total: number;
    reportedAt: number;
  }>();

  /** 入场准备完成后仍需验证材质就绪与实际渲染；两个阶段独立计量。 */
  async waitForInitialRenderReady(signal?: AbortSignal): Promise<void> {
    do {
      await this.dependencies.outputs.generatorAssetPreloader.waitForReady(signal);
      if (this.dependencies.document.disposed) throw new DOMException('场景准备已取消。', 'AbortError');
      await this.loadDiagnostics.measureAsync('gpuCapabilityProbe', () => prepareGpuCapabilityProfile(this.context.scene.getEngine() as Engine, signal));
      if (this.dependencies.assets.shaderWarmup.getMetrics().enabled) {
        await this.loadDiagnostics.measureAsync('shaderWarmup', () => this.dependencies.assets.shaderWarmup.prepare(signal));
      }
      if (this.dependencies.document.disposed) throw new DOMException('场景准备已取消。', 'AbortError');
      await this.loadDiagnostics.measureAsync('firstFrameValidation', () => waitForSceneRenderReady(this.context.scene, signal));
      // 等首帧期间配置仍可变化；新目标也必须完成预取才能结算当前准备。
    } while (this.dependencies.outputs.generatorAssetPreloader.getMetrics().pendingCount > 0);
  }

  /** 返回当前场景的完整模型三角面数，不依赖相机裁剪后的渲染批次。 */
  public getModelStatistics(): SceneModelStatisticsSnapshot {
    if (this.modelStatisticsDirty || !this.modelStatisticsSnapshot) {
      this.modelStatisticsSnapshot = this.collectModelStatistics();
      this.modelStatisticsDirty = false;
    }
    return { ...this.modelStatisticsSnapshot };
  }

  /** 同步事务与异步加载共享一个微任务通知，避免同一批网格创建触发多次汇总。 */
  public invalidateModelStatistics(): void {
    this.modelStatisticsDirty = true;
    if (this.dependencies.document.disposed || !this.onModelStatisticsChanged || this.modelStatisticsNotificationPending) return;
    this.modelStatisticsNotificationPending = true;
    queueMicrotask(() => {
      this.modelStatisticsNotificationPending = false;
      if (this.dependencies.document.disposed || !this.onModelStatisticsChanged) return;
      const previous = this.modelStatisticsSnapshot;
      const snapshot = this.getModelStatistics();
      if (previous && Object.keys(snapshot).every(key => snapshot[key as keyof SceneModelStatisticsSnapshot] === previous[key as keyof SceneModelStatisticsSnapshot])) return;
      Reflect.apply(this.onModelStatisticsChanged, this.context.callbackReceiver, [snapshot]);
    });
  }

  public collectModelStatistics(): SceneModelStatisticsSnapshot {
    let phase: SceneModelStatisticsSnapshot['phase'] = 'ready';
    let modelTriangleCount = 0;
    const setPhase = (next: SceneModelStatisticsSnapshot['phase']) => {
      if (next === 'error' || (next === 'loading' && phase !== 'error')) phase = next;
    };
    const countModel = (model: ModelRuntimeEntry): number => {
      if (model.readinessError || model.externalScriptRuntime?.getInitializationError()) setPhase('error');
      else if (!model.measurementReady || model.externalScriptStarting) setPhase('loading');
      // 特效为 InstancedMesh 建立的替身不能使原模型消失，也不能重复贡献三角面。
      const currentMeshes = [...new Set([...model.meshes, ...model.contentRoot.getChildMeshes(false)])];
      const effectProxyParents = new Map<number, Node | null>();
      for (const mesh of currentMeshes) {
        const sourceId = mesh.metadata?.digitalTwinEffectSourceMeshUniqueId;
        if (mesh.metadata?.digitalTwinEffectProxy && typeof sourceId === 'number' && mesh.isEnabled(false)) {
          effectProxyParents.set(sourceId, mesh.parent);
        }
      }
      let triangles = 0;
      for (const mesh of currentMeshes) {
        let ancestor = mesh.parent;
        let enabledAncestors = true;
        while (ancestor && ancestor !== model.root) {
          if (!ancestor.isEnabled(false)) enabledAncestors = false;
          ancestor = ancestor.parent;
        }
        const replacedInstance = mesh instanceof InstancedMesh && !mesh.isDisposed() && mesh.isVisible && mesh.visibility > 0
          && enabledAncestors && ancestor === model.root && effectProxyParents.get(mesh.uniqueId) === mesh.parent;
        if (!this.dependencies.bounds.isModelBoundsMesh(model, mesh) && !replacedInstance) continue;
        triangles += countModelMeshTriangles(mesh);
      }
      return triangles;
    };
    const perModel = new Map<ModelRuntimeEntry, number>();
    const modelCount = (model: ModelRuntimeEntry): number => {
      if (!perModel.has(model)) perModel.set(model, countModel(model));
      return perModel.get(model)!;
    };
    for (const failure of this.modelReadinessErrors.values()) if (failure.error) setPhase('error');
    if (this.activeModelLoadProgress.size > 0) setPhase('loading');
    for (const [id, mesh] of this.dependencies.presentation.meshes) {
      if (this.dependencies.document.syncedEntities.get(id)?.components.meshRenderer) modelTriangleCount += countModelMeshTriangles(mesh);
    }
    for (const model of this.dependencies.assets.models.values()) {
      if (model.telemetryProxySource) continue;
      modelTriangleCount += modelCount(model) * (1 + (model.entitySnapshot?.components.modelArray?.items.length ?? 0));
    }
    // 隐藏逻辑实体不一定存在于GPU批次或权威可见映射，参数宿主的实体登记仍是全量。
    const variants = new Map<string, ModelRuntimeEntry>();
    for (const variant of this.dependencies.variants.modelArrayParameterVariants.values()) {
      for (const entity of variant.entities) {
        const current = this.dependencies.arrays.modelArrayInstanceEntities.get(entity.id);
        const asset = current?.components.modelAsset;
        if (!variants.has(entity.id) || (asset && variant.renderSignature === this.dependencies.arrays.createModelArrayRenderSignature(asset, current?.components.telemetryBinding))) {
          variants.set(entity.id, variant.model);
        }
      }
    }
    for (const [id, entity] of this.dependencies.arrays.modelArrayInstanceEntities) {
      if (this.dependencies.assets.models.has(id)) continue;
      const sourceId = entity.components.modelArrayInstance?.sourceEntityId;
      const source = sourceId ? this.dependencies.assets.models.get(sourceId) : undefined;
      const asset = entity.components.modelAsset;
      const sourceAsset = source?.entitySnapshot?.components.modelAsset;
      const canUseSource = !asset || !sourceAsset || this.dependencies.arrays.createModelArrayRenderSignature(asset, entity.components.telemetryBinding)
        === this.dependencies.arrays.createModelArrayRenderSignature(sourceAsset, source?.entitySnapshot?.components.telemetryBinding);
      const model = variants.get(id) ?? this.dependencies.variants.modelArrayParameterVariantByEntityId.get(id)?.model ?? (canUseSource ? source : undefined);
      if (model) modelTriangleCount += modelCount(model);
      else setPhase('loading');
    }
    for (const model of this.dependencies.outputs.spawnedDeviceModels.values()) modelTriangleCount += modelCount(model);
    for (const owner of this.dependencies.outputs.generatedOutputOwners.values()) {
      if (owner.readinessError) setPhase('error');
      const output = owner.output;
      if (!output) {
        if (owner.activeTargetSignature && !owner.readinessError) setPhase('loading');
        continue;
      }
      if (output.kind === 'mesh') modelTriangleCount += countModelMeshTriangles(output.mesh);
      else if (output.kind === 'model') modelTriangleCount += modelCount(output.model);
      else for (const member of output.members) {
        // 组合阵列以 interactive:false 创建，不执行视锥裁剪；完整批次已含源自身，宿主不重复计数。
        if (member.arrayBatch) {
          if (member.model) modelCount(member.model);
          for (const mesh of member.arrayBatch.meshes) {
            if (mesh instanceof Mesh && mesh.thinInstanceCount > 0) modelTriangleCount += countModelMeshTriangles(mesh);
          }
        } else if (member.model) modelTriangleCount += modelCount(member.model);
        else if (member.mesh) modelTriangleCount += countModelMeshTriangles(member.mesh);
      }
    }
    for (const mesh of this.modelStatisticsFallbackMeshes) modelTriangleCount += countModelMeshTriangles(mesh);
    for (const runtime of this.dependencies.fetch.locatorFetchRuntimes.values()) {
      const statistics = runtime.getTriangleStatistics();
      modelTriangleCount += statistics.triangleCount;
      setPhase(statistics.phase);
    }
    const environment = this.dependencies.environment.environmentRuntime.getSnapshot();
    if (environment.phase === 'loading' || environment.phase === 'error') setPhase(environment.phase);
    const expectedEnvironmentSource = this.modelStatisticsEnvironmentSourceUrl === undefined
      ? this.dependencies.document.shadowDocument?.sceneSettings.environment?.activeVariantUrl : this.modelStatisticsEnvironmentSourceUrl;
    if (expectedEnvironmentSource && (environment.phase === 'idle' || environment.sourceUrl !== expectedEnvironmentSource)) setPhase('loading');
    return { sceneId: this.dependencies.document.shadowDocument?.id ?? null, phase, modelTriangleCount,
      environmentTriangleCount: environment.statistics?.triangleCount ?? 0 };
  }

  /** 返回 Scene View HUD 使用的低频运行时同步指标快照。 */
  getPerformanceMetrics(): SceneRuntimePerformanceMetrics {
    const modelArrayBatches = new Set<EntityArrayThinInstanceBatch>();
    for (const model of this.dependencies.assets.models.values()) {
      if (model.modelArrayBatch) modelArrayBatches.add(model.modelArrayBatch);
    }
    for (const variant of this.dependencies.variants.modelArrayParameterVariants.values()) {
      if (variant.model.modelArrayBatch) modelArrayBatches.add(variant.model.modelArrayBatch);
    }

    let modelArrayBatchEntityCount = 0;
    let modelArrayBatchMeshCount = 0;
    for (const batch of modelArrayBatches) {
      modelArrayBatchEntityCount += batch.getEntityIds().length;
      modelArrayBatchMeshCount += batch.meshes.length;
    }
    // 保留旧报告字段作为发布防回归守卫；正式路径已删除代理 API，所有实体均为原模型 Geometry。
    const modelArrayScreenSpaceProxyBatchCount = 0;
    const modelArraySolidProxyEntityCount = 0;
    const modelArrayFrameProxyEntityCount = 0;
    const modelArrayProxyEntityCount = 0;
    const modelArrayDetailedEntityCount = modelArrayBatchEntityCount;

    return {
      fullSyncCount: this.dependencies.document.fullSyncCount,
      selectionSyncCount: this.dependencies.selection.selectionSyncCount,
      lastFullSyncDurationMs: this.dependencies.document.lastFullSyncDurationMs,
      maxFullSyncDurationMs: this.dependencies.document.maxFullSyncDurationMs,
      lastSelectionSyncDurationMs: this.dependencies.selection.lastSelectionSyncDurationMs,
      maxSelectionSyncDurationMs: this.dependencies.selection.maxSelectionSyncDurationMs,
      lastSelectionChangedEntityCount: this.dependencies.selection.lastSelectionChangedEntityCount,
      modelRuntimeCount: this.dependencies.assets.models.size,
      loading: { ...this.loadDiagnostics.snapshot(),
        environmentPhase: this.dependencies.environment.environmentRuntime.getSnapshot().phase,
        skybox: this.getSkyboxReadiness(),
        skyboxTiming: this.dependencies.environment.skyboxRuntime.getLoadDiagnostics(),
        externalScripts: getExternalModelScriptLoadDiagnostics(),
        pendingModelCount: [...this.dependencies.assets.models.values()].filter((model) => !model.measurementReady).length,
        failedModelAcquisitions: this.failedModelAcquisitions,
        modelCache: this.dependencies.assets.sharedModelAssetCache.getMetrics(),
        cargoPreload: this.dependencies.outputs.generatorAssetPreloader.getMetrics(),
        environmentCache: this.dependencies.environment.environmentAssetCache.getMetrics(),
        entrance: this.dependencies.effects.getModelEntranceSnapshot(), resources: this.context.getResourceLoadDiagnostics?.call(this.context.callbackReceiver) ?? null },
      modelArrayInstanceEntityCount: this.dependencies.arrays.modelArrayInstanceEntities.size,
      modelArrayParameterVariantCount: this.dependencies.variants.modelArrayParameterVariants.size,
      modelArrayBatchCount: modelArrayBatches.size,
      modelArrayBatchEntityCount,
      modelArrayBatchMeshCount,
      modelArrayScreenSpaceProxyBatchCount,
      modelArraySolidProxyEntityCount,
      modelArrayFrameProxyEntityCount,
      modelArrayProxyEntityCount,
      modelArrayDetailedEntityCount,
    };
  }

  /** 登记一个模型或环境加载进度单元（按文件名跟踪当前下载目标）。 */
  public beginModelLoadProgressUnit(fileName: string): number {
    const sequence = ++this.modelLoadProgressSequence;
    this.modelLoadProgressStartedCount += 1;
    this.activeModelLoadProgress.set(sequence, {
      fileName,
      loaded: 0,
      total: 0,
      reportedAt: -1,
    });
    this.notifyModelLoadProgressChanged();
    return sequence;
  }

  /** 把 SceneLoader 的字节进度合并进对应加载单元；容器内多文件时按当前文件进度折算。 */
  public updateModelLoadProgressUnit(sequence: number, event: ISceneLoaderProgressEvent): void {
    const active = this.activeModelLoadProgress.get(sequence);
    if (!active) return;
    active.loaded = event.loaded;
    active.total = event.total;
    active.reportedAt = ++this.modelLoadProgressReportSequence;
    this.notifyModelLoadProgressChanged();
  }

  /** 结算一个加载单元：移出在途表并累加已结算单元数。 */
  public settleModelLoadProgressUnit(sequence: number): void {
    if (this.activeModelLoadProgress.delete(sequence)) {
      this.modelLoadProgressSettledCount += 1;
    }
    this.notifyModelLoadProgressChanged();
  }

  /** 有订阅方时重新计算并推送模型加载进度快照。 */
  public notifyModelLoadProgressChanged(): void {
    this.invalidateModelStatistics();
    if (!this.context.onModelLoadProgress || this.dependencies.document.disposed) return;
    if (this.activeModelLoadProgress.size === 0) {
      this.progressNotificationPending = false;
      this.loadDiagnostics.measure('progressNotify', () => this.emitModelLoadProgress());
      return;
    }
    if (this.progressNotificationPending) return;
    this.progressNotificationPending = true;
    queueMicrotask(() => {
      if (!this.progressNotificationPending || this.dependencies.document.disposed) return;
      this.progressNotificationPending = false;
      this.loadDiagnostics.measure('progressNotify', () => this.emitModelLoadProgress());
    });
  }

  /** 进度订阅是观察者，异常不得覆盖成功返回的模板句柄或阻断加载单元结算。 */
  private emitModelLoadProgress(): void {
    try {
      this.context.onModelLoadProgress?.call(this.context.callbackReceiver, this.computeModelLoadProgress());
    } catch (error) {
      console.warn('[Scene load] 模型加载进度观察者失败。', error);
    }
  }

  /** 加载门控只查询源实体状态，不为每次轮询重复计算全模型包围盒；失败或已删除的模型不会被计为就绪。 */
  isModelReady(entityId: string): boolean {
    const model = this.dependencies.assets.models.get(entityId);
    return Boolean(model?.assetHandle && model.measurementReady);
  }

  /** 当前天空盒任务独立报告就绪，已取消旧任务不参与场景加载门控。 */
  getSkyboxReadiness(): { phase: 'idle' | 'loading' | 'ready' | 'error'; message: string | null; sourceUrl: string | null } {
    return this.dependencies.environment.skyboxRuntime.getReadiness();
  }

  retrySkyboxLoading(): void {
    this.dependencies.environment.skyboxRuntime.retry();
  }

  /** 每轮显式资源恢复后重试失败项；重建脚本宿主以避免在半初始化几何上重复执行 onStart。 */
  retryFailedSceneResources(document: SceneDocument, hierarchySelectionIds?: readonly string[]): number {
    if (this.dependencies.document.disposed) return 0;
    const failedEntities = new Set<string>();
    const failedScript = (model: ModelRuntimeEntry): boolean => !model.externalScriptStarting
      && Boolean(model.readinessError || model.externalScriptRuntime?.getInitializationError());
    for (const failure of this.modelReadinessErrors.values()) {
      for (const entityId of failure.entityIds) {
        if (document.entities[entityId]?.components.modelAsset) {
          failedEntities.add(entityId);
          this.dependencies.document.syncedEntities.delete(entityId);
        }
      }
    }
    for (const [entityId, model] of [...this.dependencies.assets.models]) {
      if (!document.entities[entityId]?.components.modelAsset || !failedScript(model)) continue;
      this.dependencies.assets.disposeModel(entityId, model);
      failedEntities.add(entityId);
      this.dependencies.document.syncedEntities.delete(entityId);
    }
    for (const variant of [...this.dependencies.variants.modelArrayParameterVariants.values()]) {
      if (!document.entities[variant.sourceEntityId]?.components.modelAsset || !failedScript(variant.model)) continue;
      this.dependencies.variants.disposeModelArrayParameterVariant(variant);
      failedEntities.add(variant.sourceEntityId);
      this.dependencies.document.syncedEntities.delete(variant.sourceEntityId);
    }
    const failedOwners: GeneratedOutputOwnerRuntimeEntry[] = [];
    for (const owner of this.dependencies.outputs.generatedOutputOwners.values()) {
      const entityId = owner.editorEntityId ?? owner.entityId;
      if (!document.entities[entityId]) continue;
      const output = owner.output;
      if (output?.kind === 'model' && output.model.externalScriptStarting) continue;
      if (!owner.readinessError && owner.failedTargetSignatures.size === 0
        && !(output?.kind === 'model' && failedScript(output.model))) continue;
      owner.loadToken += 1;
      this.dependencies.outputs.disposeModelGeneratorOutput(owner);
      owner.failedTargetSignatures.clear();
      owner.reportedLoadFailureKeys.clear();
      owner.activeTargetSignature = null;
      owner.readinessError = undefined;
      failedOwners.push(owner);
      failedEntities.add(entityId);
    }
    if (failedEntities.size === 0) return 0;
    // 沿用现有增量同步与矩阵身份规则，健康宿主不重新初始化，也不改模型修订和业务参数。
    this.dependencies.document.sync(document, hierarchySelectionIds, { modelArrayIdentityMode: this.dependencies.arrays.modelArrayIdentityMode });
    for (const owner of failedOwners) {
      if (this.dependencies.outputs.generatedOutputOwners.get(owner.entityId) !== owner) continue;
      const resolution = owner.activeSnapshot
        ? resolveModelGeneratorTargetFromSnapshot(owner.component, owner.activeSnapshot)
        : { target: owner.component.defaultTarget, role: 'default' as const, snapshot: null };
      if (resolution) this.dependencies.outputs.syncModelGeneratorResolvedTarget(owner, resolution);
    }
    return failedEntities.size;
  }

  /** 首次加载的低频诊断；错误独立于已结算计数，避免失败单元被误当成功。 */
  getInitialLoadSnapshot() {
    const describe = (id: string, error: string): string => '模型 ' + (this.dependencies.document.shadowDocument?.entities[id]?.name ?? id) + '：' + error;
    const modelError = (model: ModelRuntimeEntry | undefined): string | null => model?.readinessError
      ?? model?.externalScriptRuntime?.getInitializationError() ?? null;
    let error: string | null = null;
    const environment = this.dependencies.environment.environmentRuntime.getSnapshot();
    const skybox = this.dependencies.environment.skyboxRuntime.getReadiness();
    if (environment.phase === 'error') error = '环境模型加载失败：' + environment.message;
    else if (skybox.phase === 'error') error = '天空盒加载失败：' + skybox.message;
    if (!error) for (const failure of this.modelReadinessErrors.values()) { error = describe(failure.entityIds[0], failure.error); break; }
    if (!error) for (const [id, model] of this.dependencies.assets.models) { const reason = modelError(model) ?? modelError(model.telemetryProxySource); if (reason) { error = describe(id, reason); break; } }
    if (!error) for (const variant of this.dependencies.variants.modelArrayParameterVariants.values()) { const reason = modelError(variant.model); if (reason) { error = describe(variant.sourceEntityId, reason); break; } }
    if (!error) for (const owner of this.dependencies.outputs.generatedOutputOwners.values()) {
      const reason = owner.readinessError ?? (owner.output?.kind === 'model' ? modelError(owner.output.model) : null);
      if (reason) { error = describe(owner.editorEntityId ?? owner.entityId, reason); break; }
    }
    const resourceBytes = [...this.activeModelLoadProgress.values()].reduce((sum, item) => sum + item.loaded, 0);
    const entrance = this.dependencies.effects.getModelEntranceSnapshot();
    return { progress: this.computeModelLoadProgress(), skybox: this.dependencies.environment.skyboxRuntime.getLoadDiagnostics(), resourceBytes, error, entrance,
      startupStage: entrance.status === 'preparing' ? `准备入场材质 ${entrance.preparedBindingCount}/${entrance.totalBindingCount}` : undefined };
  }

  /** 严格加载门控单独读取失败信息，保留本地编辑对基础几何的容错显示。 */
  getModelReadinessError(entityId: string): string | null {
    const direct = this.dependencies.assets.models.get(entityId);
    const errorFor = (model: ModelRuntimeEntry | undefined): string | null => model?.readinessError
      ?? model?.externalScriptRuntime?.getInitializationError() ?? null;
    const directError = errorFor(direct) ?? errorFor(direct?.telemetryProxySource);
    if (directError) return directError;
    for (const failure of this.modelReadinessErrors.values()) {
      if (failure.entityIds.includes(entityId)) return failure.error;
    }
    for (const variant of this.dependencies.variants.modelArrayParameterVariants.values()) {
      if (variant.sourceEntityId === entityId || variant.entities.some(entity => entity.id === entityId)) {
        const error = errorFor(variant.model);
        if (error) return error;
      }
    }
    for (const owner of this.dependencies.outputs.generatedOutputOwners.values()) {
      if (owner.entityId !== entityId && owner.editorEntityId !== entityId) continue;
      if (owner.readinessError) return owner.readinessError;
      if (owner.output?.kind === 'model') {
        const error = errorFor(owner.output.model);
        if (error) return error;
      }
    }
    return null;
  }

  /** 同批异步模型就绪只刷新一次选区与分组目标；直接选择/拖拽路径仍同步执行。 */
  public scheduleModelPresentationRefresh(): void {
    this.invalidateModelStatistics();
    if (this.dependencies.document.disposed || this.dependencies.assets.modelPresentationRefreshPending) return;
    this.dependencies.assets.modelPresentationRefreshPending = true;
    queueMicrotask(() => {
      if (!this.dependencies.assets.modelPresentationRefreshPending || this.dependencies.document.disposed) return;
      this.dependencies.assets.modelPresentationRefreshPending = false;
      try {
        this.loadDiagnostics.measure('presentationRefresh', () => {
          this.dependencies.selection.rebuildModelSelectionOutline();
          this.dependencies.transforms.refreshGroupTransformPreviewTargets();
        });
      } catch (error) {
        Reflect.apply(this.context.pushLog, this.context.callbackReceiver, [`模型选择与分组呈现刷新失败：${error instanceof Error ? error.message : String(error)}`]);
      }
    });
  }

  /** 按单元数汇总已结算与在途单元，生成 0-1 的总体进度；在途单元按当前文件字节折算。 */
  public computeModelLoadProgress(): SceneRuntimeModelLoadProgress {
    const skyboxPhase = this.dependencies.environment.skyboxRuntime.getReadiness().phase;
    const skyboxLoading = skyboxPhase === 'loading';
    const cargoPreloadPending = this.dependencies.outputs.generatorAssetPreloader.getMetrics().pendingCount > 0;
    const totalCount = this.modelLoadProgressStartedCount + (skyboxPhase === 'idle' ? 0 : 1);
    const settledCount = this.modelLoadProgressSettledCount + (skyboxPhase === 'ready' || skyboxPhase === 'error' ? 1 : 0);
    let weightedSettled = settledCount;
    let latestReportedAt = -1;
    let currentFile: string | null = null;
    let currentFilePercent: number | null = null;
    for (const progress of this.activeModelLoadProgress.values()) {
      const fraction = progress.total > 0
        ? Math.min(1, Math.max(0, progress.loaded / progress.total))
        : 0;
      weightedSettled += fraction;
      if (progress.reportedAt >= latestReportedAt) {
        latestReportedAt = progress.reportedAt;
        currentFile = progress.fileName;
        currentFilePercent = progress.total > 0 ? fraction : null;
      }
    }
    if (skyboxLoading && !currentFile) currentFile = '天空盒纹理';
    if (cargoPreloadPending && !currentFile) currentFile = '货物模板预解码';
    const percent = totalCount > 0
      ? Math.min(1, Math.max(0, weightedSettled / totalCount))
      : 1;
    return {
      loading: cargoPreloadPending || skyboxLoading || this.activeModelLoadProgress.size > 0 || settledCount < totalCount,
      percent: cargoPreloadPending ? Math.min(percent, totalCount > 0 ? 0.99 : 0) : percent,
      completedCount: settledCount,
      totalCount,
      currentFile,
      filePercent: currentFilePercent,
    };
  }
  /** 保持mesh广播的同步时序；只由光照运行时决定已pending请求能否合并。 */
  private notifyMeshLightingChange(reason: string): void {
    const lighting = this.dependencies.environment.lightingRuntime;
    const notify = lighting?.notifyMeshLifecycleChange ?? lighting?.markDirty;
    if (notify) Reflect.apply(notify, lighting, [reason]);
  }

  /** 按原构造顺序连接此领域的资源与回调。 */
  initializeModelStatisticsMeshAddedObserver(): void {
    this.modelStatisticsMeshAddedObserver = this.context.scene.onNewMeshAddedObservable.add(mesh => {
      if (this.dependencies.telemetry.motionStaticBatchRuntime?.isTemporaryMeshEvent(mesh)) return;
      this.invalidateModelStatistics();
      if (!mesh.metadata?.lightingDerived) this.notifyMeshLightingChange('scene-mesh-added');
    });
  }

  /** 按原构造顺序连接此领域的资源与回调。 */
  initializeModelStatisticsMeshRemovedObserver(): void {
    this.modelStatisticsMeshRemovedObserver = this.context.scene.onMeshRemovedObservable.add(mesh => {
      if (this.dependencies.telemetry.motionStaticBatchRuntime?.isTemporaryMeshEvent(mesh)) return;
      this.invalidateModelStatistics();
      if (!mesh.metadata?.lightingDerived) this.notifyMeshLightingChange('scene-mesh-removed');
    });
  }

}
