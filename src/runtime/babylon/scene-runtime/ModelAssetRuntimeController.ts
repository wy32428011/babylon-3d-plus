import { AssetContainer } from '@babylonjs/core/assetContainer.js';
import { loadCapabilityModelTemplate } from '../modelRuntimeCapabilities.ts';
import { modelRuntimeConfigurationKey } from '../../../../electron/shared/modelRuntimeCapabilities.ts';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh.js';

import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import type { ISceneLoaderProgressEvent } from '@babylonjs/core';
import type { Entity } from '../../../editor/model/Entity';
import type { ModelAssetComponent } from '../../../editor/model/components';
import { ExternalModelScriptRuntime } from '../ExternalModelScriptRuntime';
import type { SceneAssetTrace, SceneLoadTraceScope } from '../SceneLoadDiagnostics.ts';
import { isMeasurableModelMesh } from '../modelMeasurement';
import { getMeshesWorldBottomCenter } from '../runtimeNodeGeometry';
import { resolveRuntimeAssetUrl } from '../../assets/editorAssetUrl';
import { AssetLoadScheduler } from '../AssetLoadScheduler';
import { SceneShaderWarmup } from '../SceneShaderWarmup';
import { resolveModelAssetSharedInstancingPolicy, SharedModelAssetCache, createModelAssetTemplateKey, type SharedModelTemplateLease } from '../SharedModelAssetCache';
import { repairInstancedMeshBufferContainers } from '../instancedSelectionBuffers';
import { createConveyorTelemetryState, createHcliftTelemetryState, createLiftTelemetryState, createRgvTelemetryState, createShuttleTelemetryState, createStackerTelemetryState, isConveyorModelAsset, isLiftModelAsset, isRgvModelAsset, isStackerModelAsset, resetConveyorTelemetryState, resetHcliftTelemetryState, resetLiftTelemetryState, resetRgvTelemetryState, resetShuttleTelemetryState, resetStackerTelemetryState } from '../telemetry/specialized/specializedModelAssets';
import type { SceneRuntimeContext } from './SceneRuntimeContext';
import type { ScenePickingAndSelectionController } from './ScenePickingAndSelectionController';
import type { ModelArrayRuntimeController } from './ModelArrayRuntimeController';
import type { SceneTransformPreviewController } from './SceneTransformPreviewController';
import type { SceneMeshPresentationController } from './SceneMeshPresentationController';
import type { SceneDocumentController } from './SceneDocumentController';
import type { SceneLocatorController } from './SceneLocatorController';
import type { SceneTelemetryController } from './SceneTelemetryController';
import type { ModelParameterBindingController } from './ModelParameterBindingController';
import type { SceneTriangleAndReadinessController } from './SceneTriangleAndReadinessController';
import type { ParameterVariantHostPool } from './ParameterVariantHostPool';
import type { GeneratedModelOutputController } from './GeneratedModelOutputController';
import type { EnvironmentAndSkyboxController } from './EnvironmentAndSkyboxController';
import { runSceneRuntimeCleanup } from './sceneRuntimeCleanup';
import { EDITOR_ENTITY_ID_METADATA_KEY, type LoadedModelRuntimeAssets, type ModelRuntimeEntry, type GeneratedOutputOwnerRuntimeEntry, readRuntimeTimestampMs } from './sceneRuntimeTypes';

/** 只读取组件快照的own-data描述符；不为准备阶段求值新的脚本/参数元数据getter。 */
function canPrepareSharedTemplate(asset: ModelAssetComponent): boolean {
  const prototype=Object.getPrototypeOf(asset); if(prototype!==Object.prototype&&prototype!==null)return false;
  for(const name of ['scriptAssets','parameterConfig','parameterScriptMetadata','animationScriptMetadata']) {
    const descriptor=Object.getOwnPropertyDescriptor(asset,name); if(descriptor&&!('value'in descriptor))return false;
    const value=descriptor?.value;
    if(name==='parameterConfig'){if(value!=null)return false;continue;}
    if(value==null)continue;if(!Array.isArray(value))return false;
    const length=Object.getOwnPropertyDescriptor(value,'length');
    if(!length||!('value'in length)||length.value!==0)return false;
  }
  return true;
}

/** 此领域仅能访问明确列出的协作能力，资源与缓存由所属 Controller 持有。 */
type Dependencies = {
  readonly selection: Pick<ScenePickingAndSelectionController, 'selectedEntityIds' | 'isEntityHighlighted' | 'applyModelSelection'>;
  readonly arrays: Pick<ModelArrayRuntimeController, 'modelArrayInstanceEntities' | 'endModelArrayHostRenderSuppression' | 'disposeModelArrayBatch' | 'syncModelArrayBatch' | 'beginModelArrayHostRenderSuppression'>;
  readonly transforms: Pick<SceneTransformPreviewController, 'modelArrayGizmoProxy' | 'clearEntityArrayPreviewIfSource'>;
  readonly presentation: Pick<SceneMeshPresentationController, 'applyTransform' | 'syncConveyorTrajectory' | 'conveyorTrajectories' | 'disposeConveyorTrajectory'>;
  readonly document: Pick<SceneDocumentController, 'syncedEntities' | 'isEntityVisible' | 'isEntityScenePickable'>;
  readonly locators: Pick<SceneLocatorController, 'syncLocatorEntity' | 'locators' | 'computeBuiltInSlotRenderable' | 'refreshBuiltInSlotBindings'>;
  readonly telemetry: Pick<SceneTelemetryController, 'specializedTelemetryRuntime' | 'motionStaticBatchRuntime' | 'telemetryPreviewActive' | 'updateModelExternalScriptRuntimeContext'>;
  readonly parameters: Pick<ModelParameterBindingController, 'applyModelParameters' | 'applyModelUnitScale' | 'syncModelScriptMetadata'>;
  readonly readiness: Pick<SceneTriangleAndReadinessController, 'modelReadinessErrors' | 'loadDiagnostics' | 'scheduleModelPresentationRefresh' | 'invalidateModelStatistics' | 'beginModelLoadProgressUnit' | 'updateModelLoadProgressUnit' | 'failedModelAcquisitions' | 'settleModelLoadProgressUnit'>;
  readonly variants: Pick<ParameterVariantHostPool, 'disposeModelArrayParameterVariantsForSource' | 'modelArrayParameterVariants'>;
  readonly outputs: Pick<GeneratedModelOutputController, 'generatedOutputOwners' | 'applyGeneratedOutputPresentation' | 'spawnedDeviceModels'>;
  readonly environment: Pick<EnvironmentAndSkyboxController, 'lightingRuntime'>;
};


/** ModelAssetRuntimeController 的资源、状态及取消/释放操作在同一领域内维护。 */
export class ModelAssetRuntimeController {
  constructor(private readonly context: SceneRuntimeContext, private readonly dependencies: Dependencies) {
    this.shaderWarmup = new SceneShaderWarmup(context.scene);
    // 单项净收益尚未验收；内部A/B先保留原准备路径，验证后才启用。
    this.shaderWarmup.setEnabled(false);
  }

  public readonly shaderWarmup: SceneShaderWarmup;

  public readonly models = new Map<string, ModelRuntimeEntry>();
  public readonly assetLoadScheduler = new AssetLoadScheduler();
  public modelPresentationRefreshPending = false;
  public readonly sharedModelAssetCache = new SharedModelAssetCache();
  public modelLoadSequence = 0;
  private updatesStopped = false;
  private disposed = false;

  /** 先关闭新增加载与呈现入口；已运行的解码允许结束，但结果不能再交给场景。 */
  public stopUpdates(): void {
    if (this.updatesStopped) return;
    this.updatesStopped = true;
    this.modelPresentationRefreshPending = false;
    runSceneRuntimeCleanup(this.context, '模型加载调度器', () => this.assetLoadScheduler.dispose());
  }

  /** 逐模型归还脚本、阵列与资产句柄；共享模板仍供其它领域完成释放。 */
  public disposeModels(): void {
    this.stopUpdates();
    for (const [entityId, model] of [...this.models]) {
      runSceneRuntimeCleanup(this.context, `模型 ${entityId}`, () => this.disposeModel(entityId, model));
    }
    this.models.clear();
  }

  /** 最终阶段调用：普通模型、参数变体及生成物等所有消费者须先归还租约。 */
  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.disposeModels();
    runSceneRuntimeCleanup(this.context, '模型着色器预热', () => this.shaderWarmup.dispose());
    runSceneRuntimeCleanup(this.context, '共享模型资产缓存', () => this.sharedModelAssetCache.dispose());
  }

  /** 加载前后都检查终止状态；不能只依赖调度器取消尚未开始的任务。 */
  private assertUpdatesActive(signal?: AbortSignal): void {
    if (this.updatesStopped || signal?.aborted) {
      throw new DOMException('模型资产更新已停止或加载已取消。', 'AbortError');
    }
  }

  /** 记录独立矩阵实例实体；其几何由 sourceEntityId 对应源模型的批次统一提交。 */
  public syncModelArrayInstanceEntity(
    entity: Entity,
    highlightSet: ReadonlySet<string> = this.dependencies.selection.selectedEntityIds,
  ): void {
    if (this.updatesStopped) return;
    this.dependencies.arrays.modelArrayInstanceEntities.set(entity.id, entity);
    if (this.dependencies.transforms.modelArrayGizmoProxy?.entityId === entity.id) {
      this.dependencies.presentation.applyTransform(this.dependencies.transforms.modelArrayGizmoProxy.node, entity.components.transform);
      this.dependencies.transforms.modelArrayGizmoProxy.node.computeWorldMatrix(true);
    }
    // 绑定到副本的内置货格挂在场景根下、按副本位姿换算世界坐标；副本位移后需重算跟随。
    for (const slotEntity of this.dependencies.document.syncedEntities.values()) {
      if (slotEntity.components.locator?.builtInBinding?.hostEntityId !== entity.id) continue;
      this.dependencies.locators.syncLocatorEntity(slotEntity, this.dependencies.selection.isEntityHighlighted(slotEntity.id), highlightSet);
    }
  }

  /** 同步 glTF/GLB 模型资源，并通过加载 token 避免异步过期结果污染当前场景。 */
  public syncModelEntity(
    entity: Entity,
    selected: boolean,
    highlightSet: ReadonlySet<string> = this.dependencies.selection.selectedEntityIds,
  ): void {
    if (this.updatesStopped) return;
    const modelAsset = entity.components.modelAsset;
    if (!modelAsset) return;

    const assetSignature = this.createModelAssetSignature(modelAsset);
    const existing = this.models.get(entity.id);
    if (existing && existing.assetSignature !== assetSignature) {
      this.disposeModel(entity.id, existing);
    }

    const current = this.models.get(entity.id);
    if (current) {
      current.entitySnapshot = entity;
      // 脚本宿主可能因上一帧矩阵批次而禁用；参数与脚本更新前先恢复节点计算。
      current.root.setEnabled(true);
      this.dependencies.presentation.applyTransform(current.root, entity.components.transform);
      if (current.assetCode !== modelAsset.assetCode) {
        this.dependencies.telemetry.specializedTelemetryRuntime.disposeCargoForAssetCode(current.assetCode);
        resetStackerTelemetryState(current);
        resetConveyorTelemetryState(current);
        resetRgvTelemetryState(current);
        resetShuttleTelemetryState(current);
        resetLiftTelemetryState(current);
        resetHcliftTelemetryState(current);
      }
      current.assetCode = modelAsset.assetCode;
      current.telemetryBinding = entity.components.telemetryBinding ?? null;
      current.assetRevision = modelAsset.assetRevision ?? null;
      current.assetSignature = assetSignature;
      current.stackerCapable = isStackerModelAsset(modelAsset);
      current.conveyorCapable = isConveyorModelAsset(modelAsset);
      current.rgvCapable = isRgvModelAsset(modelAsset);
      current.liftCapable = isLiftModelAsset(modelAsset);
      current.stackerTelemetry.rootBasePosition = current.root.position.clone();
      current.rgvTelemetry.rootBasePosition = current.root.position.clone();
      current.liftTelemetry.rootBasePosition = current.root.position.clone();
      // contentRoot 既承载源单位换算，也允许参数脚本在其上叠加尺寸缩放；同一资产同步时不得覆盖脚本输出。
      // lengthUnit / unitScaleToMeters 已进入 assetSignature，单位契约变化会走完整重载。
      this.dependencies.parameters.applyModelParameters(entity, current);
      this.syncExternalModelScripts(entity, current);
      this.dependencies.selection.applyModelSelection(current, selected);
      this.applyModelInteractivity(current, entity.id, highlightSet);
      this.dependencies.presentation.syncConveyorTrajectory(entity, current);
      return;
    }

    this.dependencies.readiness.modelReadinessErrors.delete(entity.id);
    const root = new TransformNode(`${entity.id}_modelRoot`, this.context.scene);
    const contentRoot = new TransformNode(`${entity.id}_modelContentRoot`, this.context.scene);
    contentRoot.parent = root;
    this.dependencies.presentation.applyTransform(root, entity.components.transform);
    this.dependencies.parameters.applyModelUnitScale(contentRoot, modelAsset.unitScaleToMeters);

    const loadToken = ++this.modelLoadSequence;
    const loadAbortController = new AbortController();
    const pending: ModelRuntimeEntry = {
      sourceUrl: modelAsset.sourceUrl,
      assetRevision: modelAsset.assetRevision ?? null,
      assetSignature,
      entitySnapshot: entity,
      assetCode: modelAsset.assetCode,
      telemetryBinding: entity.components.telemetryBinding ?? null,
      stackerCapable: isStackerModelAsset(modelAsset),
      conveyorCapable: isConveyorModelAsset(modelAsset),
      rgvCapable: isRgvModelAsset(modelAsset),
      liftCapable: isLiftModelAsset(modelAsset),
      root,
      contentRoot,
      assetHandle: null,
      meshes: [],
      modelArraySuspendedMeshes: new Set(),
      modelArrayBatch: null,
      modelArraySourceSignature: '',
      modelArrayFailureSignature: '',
      highlighted: false,
      loadToken,
      cancelLoad: () => loadAbortController.abort(),
      parameterSignature: '',
      parameterBaseline: new Map(),
      textureCache: new Map(),
      externalScriptRuntime: null,
      externalScriptSignature: '',
      externalScriptStarting: false,
      measurementReady: false,
      stackerTelemetry: createStackerTelemetryState(root),
      conveyorTelemetry: createConveyorTelemetryState(),
      rgvTelemetry: createRgvTelemetryState(root),
      shuttleTelemetry: createShuttleTelemetryState(root),
      liftTelemetry: createLiftTelemetryState(root),
      hcliftTelemetry: createHcliftTelemetryState(root),
      stackerTelemetryReady: false,
      telemetryPreviewBaseline: null,
    };
    this.models.set(entity.id, pending);
    this.dependencies.selection.applyModelSelection(pending, selected);
    this.applyModelInteractivity(pending, entity.id);

    const traceScope = this.dependencies.readiness.loadDiagnostics.captureTrace();
    void this.loadModelRuntimeAssets(modelAsset, assetSignature, loadAbortController.signal, entity.id)
      .then((loadedAssets) => {
        const activeEntry = this.models.get(entity.id);
        if (this.updatesStopped || !activeEntry || activeEntry.loadToken !== loadToken || activeEntry.assetSignature !== assetSignature) {
          runSceneRuntimeCleanup(this.context, `过期模型资产 ${entity.id}`, () => loadedAssets.handle.dispose());
          return;
        }
        return this.dependencies.readiness.loadDiagnostics.withTrace(traceScope, () => this.dependencies.readiness.loadDiagnostics.measure('modelInitialize', () => {
          activeEntry.cancelLoad = null;
          activeEntry.assetHandle = loadedAssets.handle;
          if (loadedAssets.kind === 'owned-container') {
            activeEntry.meshes = loadedAssets.meshes;
            this.parentTopLevelModelNodes(activeEntry, loadedAssets.transformNodes);
          } else {
            for (const rootNode of loadedAssets.rootNodes) {
              rootNode.parent = activeEntry.contentRoot;
            }
          }

          const latestEntity = activeEntry.entitySnapshot ?? entity;
          this.refreshModelEntityMeshes(latestEntity, activeEntry);
          this.normalizeModelContentOrigin(activeEntry);
          this.dependencies.parameters.applyModelParameters(latestEntity, activeEntry);
          this.syncExternalModelScripts(latestEntity, activeEntry);
          this.dependencies.selection.applyModelSelection(activeEntry, activeEntry.highlighted);
          this.applyModelInteractivity(activeEntry, latestEntity.id);
          this.dependencies.presentation.syncConveyorTrajectory(latestEntity, activeEntry);
          this.dependencies.readiness.scheduleModelPresentationRefresh();
        }, { entityId: entity.id }, traceScope));
      })
      .catch((error) => {
        if (this.updatesStopped) return;
        const activeEntry = this.models.get(entity.id);
        if (activeEntry?.loadToken === loadToken) {
          this.disposeModel(entity.id, activeEntry);
          const message = error instanceof Error ? error.message : String(error);
          this.dependencies.readiness.modelReadinessErrors.set(entity.id, { entityIds: [entity.id], error: message });
          this.dependencies.readiness.invalidateModelStatistics();
          Reflect.apply(this.context.pushLog, this.context.callbackReceiver, [`模型加载失败：${message}`]);
        }
      });
  }

  /** 仅预取并解码模板，不创建业务实例或执行脚本；句柄随生成器配置归还。 */
  public async preloadModelRuntimeAsset(modelAsset: ModelAssetComponent, signal?: AbortSignal): Promise<SharedModelTemplateLease> {
    this.assertUpdatesActive(signal);
    const traceScope = this.dependencies.readiness.loadDiagnostics.captureTrace();
    const trace = this.dependencies.readiness.loadDiagnostics.createAssetTrace(traceScope);
    const { rootUrl, fileName } = this.splitAssetUrl(
      this.resolveVersionedRuntimeAssetUrl(modelAsset.sourceUrl, modelAsset.sourceSnapshot?.contentSha256 ?? modelAsset.assetRevision),
    );
    const sequence = this.dependencies.readiness.beginModelLoadProgressUnit(fileName);
    try {
      const lease = await this.sharedModelAssetCache.preload(
        createModelAssetTemplateKey(modelAsset),
        sourceSignal => this.loadAssetContainer(rootUrl, fileName, sourceSignal, event => {
          this.dependencies.readiness.updateModelLoadProgressUnit(sequence, event);
        }, traceScope, trace),
        signal,
        this.shaderWarmup.getMetrics().enabled && canPrepareSharedTemplate(modelAsset)
          ? source => { if (!this.updatesStopped) this.shaderWarmup.registerContainer(source); } : undefined,
        trace,
      );
      try {
        this.assertUpdatesActive(signal);
        return lease;
      } catch (error) {
        runSceneRuntimeCleanup(this.context, `过期模型预取租约 ${fileName}`, () => lease.dispose());
        throw error;
      }
    } finally {
      this.dependencies.readiness.settleModelLoadProgressUnit(sequence);
    }
  }

  /** 按模型资产能力选择独占容器或安全共享实例加载路径；组合阵列源始终独占。 */
  public async loadModelRuntimeAssets(
    modelAsset: ModelAssetComponent,
    _assetSignature: string,
    loadSignal?: AbortSignal,
    entityId?: string,
    forceOwnedContainer = false,
  ): Promise<LoadedModelRuntimeAssets> {
    this.assertUpdatesActive(loadSignal);
    const traceScope = this.dependencies.readiness.loadDiagnostics.captureTrace();
    const trace = this.dependencies.readiness.loadDiagnostics.createAssetTrace(traceScope, { entityId });
    const { rootUrl, fileName } = this.splitAssetUrl(
      this.resolveVersionedRuntimeAssetUrl(modelAsset.sourceUrl, modelAsset.sourceSnapshot?.contentSha256 ?? modelAsset.assetRevision),
    );

    const loadSequence = this.dependencies.readiness.beginModelLoadProgressUnit(fileName);
    try {
      const instancingPolicy = resolveModelAssetSharedInstancingPolicy(modelAsset);
      if (!forceOwnedContainer && instancingPolicy.mode === 'shared-geometry-clone') {
        const acquired = await this.sharedModelAssetCache.acquireCapabilityContainer(
          createModelAssetTemplateKey(modelAsset),
          sourceSignal => this.loadAssetContainer(rootUrl, fileName, sourceSignal, event => {
            this.dependencies.readiness.updateModelLoadProgressUnit(loadSequence, event);
          }, traceScope, trace), modelAsset, loadSignal,
          (ms, failed) => this.dependencies.readiness.loadDiagnostics.record('modelClone', ms, failed, { resource: fileName, entityId }), trace,
        );
        try {
          this.assertUpdatesActive(loadSignal);
          acquired.container.addAllToScene();
          return { kind: 'owned-container', handle: { kind: 'owned-container', animationGroups: acquired.container.animationGroups,
            runtimeCapabilities: acquired.runtimeCapabilities, dispose: acquired.dispose },
          meshes: acquired.container.meshes, transformNodes: acquired.container.transformNodes };
        } catch (error) {
          runSceneRuntimeCleanup(this.context, `未交付共享几何模型 ${fileName}`, () => acquired.dispose());
          throw error;
        }
      }
      if (!forceOwnedContainer && instancingPolicy.mode === 'shared-instance') {
        const sharedInstance = await this.sharedModelAssetCache.instantiate(
          createModelAssetTemplateKey(modelAsset),
          (sourceSignal) => this.loadAssetContainer(rootUrl, fileName, sourceSignal, (event) => {
            this.dependencies.readiness.updateModelLoadProgressUnit(loadSequence, event);
          }, traceScope, trace),
          (sourceName) => sourceName,
          loadSignal,
          (ms, failed) => this.dependencies.readiness.loadDiagnostics.record('modelClone', ms, failed, { resource: fileName, entityId }),
          trace,
        );
        try {
          this.assertUpdatesActive(loadSignal);
          return {
            kind: 'shared-instance',
            handle: {
              kind: 'shared-instance',
              animationGroups: sharedInstance.entries.animationGroups,
              dispose: sharedInstance.dispose,
            },
            rootNodes: sharedInstance.entries.rootNodes,
          };
        } catch (error) {
          runSceneRuntimeCleanup(this.context, `未交付模型实例 ${fileName}`, () => sharedInstance.dispose());
          throw error;
        }
      }

      const container = await this.sharedModelAssetCache.acquireOwnedContainer(
        createModelAssetTemplateKey(modelAsset),
        (sourceSignal) => this.loadAssetContainer(rootUrl, fileName, sourceSignal, (event) => {
          this.dependencies.readiness.updateModelLoadProgressUnit(loadSequence, event);
        }, traceScope, trace),
        loadSignal,
        (ms, failed) => this.dependencies.readiness.loadDiagnostics.record('modelClone', ms, failed, { resource: fileName, entityId }),
        trace,
      );
      try {
        this.assertUpdatesActive(loadSignal);
        container.addAllToScene();
        return {
          kind: 'owned-container',
          handle: {
            kind: 'owned-container',
            animationGroups: container.animationGroups,
            dispose: () => container.dispose(),
          },
          meshes: container.meshes,
          transformNodes: container.transformNodes,
        };
      } catch (error) {
        runSceneRuntimeCleanup(this.context, `未交付独占模型 ${fileName}`, () => container.dispose());
        throw error;
      }
    } catch (error) {
      this.assertUpdatesActive(loadSignal);
      const aborted = error instanceof Error && error.name === 'AbortError';
      if (!aborted) {
        this.dependencies.readiness.failedModelAcquisitions += 1;
        this.dependencies.readiness.loadDiagnostics.recordProjectOpenModelAcquisitionFailure(traceScope);
      }
      throw error;
    } finally {
      this.dependencies.readiness.settleModelLoadProgressUnit(loadSequence);
    }
  }

  /** 释放导入模型的容器、根节点与所有子资源。 */
  public disposeModel(entityId: string, model: ModelRuntimeEntry): void {
    if (this.models.get(entityId) !== model) return;
    // 先撤销所有权与加载代次，清理回调重入及迟到 Promise 都不能重新找到此模型。
    this.models.delete(entityId);
    model.loadToken = 0;
    const cleanup = (resource: string, action: () => void): void => {
      runSceneRuntimeCleanup(this.context, `模型 ${entityId} ${resource}`, action);
    };
    cleanup('动静批次', () => this.dependencies.telemetry.motionStaticBatchRuntime.markModelDirty(model));
    for (const [key, failure] of this.dependencies.readiness.modelReadinessErrors) {
      if (failure.entityIds.includes(entityId)) this.dependencies.readiness.modelReadinessErrors.delete(key);
    }
    cleanup('阵列预览', () => this.dependencies.transforms.clearEntityArrayPreviewIfSource(entityId));
    const trajectory = this.dependencies.presentation.conveyorTrajectories.get(entityId);
    if (trajectory) cleanup('输送轨迹', () => this.dependencies.presentation.disposeConveyorTrajectory(entityId, trajectory));
    model.telemetryPreviewBaseline = null;
    const cancelLoad = model.cancelLoad;
    model.cancelLoad = null;
    cleanup('在途加载', () => cancelLoad?.());
    cleanup('渲染抑制', () => this.dependencies.arrays.endModelArrayHostRenderSuppression(model));
    cleanup('选择状态', () => this.dependencies.selection.applyModelSelection(model, false));
    cleanup('宿主网格恢复', () => this.restoreModelArrayHostMeshes(model));
    cleanup('宿主启用状态', () => { if (!model.root.isDisposed()) model.root.setEnabled(true); });
    const scriptRuntime = model.externalScriptRuntime;
    model.externalScriptRuntime = null;
    model.externalScriptStarting = false;
    cleanup('外置脚本', () => scriptRuntime?.dispose());
    const textures = [...model.textureCache.values()];
    model.textureCache.clear();
    for (const texture of textures) cleanup('参数纹理', () => texture.dispose());
    cleanup('参数变体', () => this.dependencies.variants.disposeModelArrayParameterVariantsForSource(entityId));
    // 批次借用源材质，必须先释放隔离 Geometry，再归还可能共享源几何的资产租约。
    cleanup('阵列批次', () => this.dependencies.arrays.disposeModelArrayBatch(model));
    const assetHandle = model.assetHandle;
    model.assetHandle = null;
    cleanup('资产句柄', () => assetHandle?.dispose());
    cleanup('遥测货物', () => this.dependencies.telemetry.specializedTelemetryRuntime.disposeCargoForAssetCode(model.assetCode));
    cleanup('内容节点', () => { if (!model.contentRoot.isDisposed()) model.contentRoot.dispose(); });
    cleanup('根节点', () => { if (!model.root.isDisposed()) model.root.dispose(); });
    model.modelArraySuspendedMeshes.clear();
    model.parameterBaseline.clear();
    model.meshes = [];
    cleanup('测量通知', () => Reflect.apply(this.context.onModelMeasurementChanged, this.context.callbackReceiver, [entityId]));
  }

  /** 将显隐和锁定状态应用到导入模型的根节点与子 Mesh。 */
  public applyModelInteractivity(
    model: ModelRuntimeEntry,
    entityId: string,
    highlightSet: ReadonlySet<string> = this.dependencies.selection.selectedEntityIds,
  ): void {
    const keepScriptHostActive = model.externalScriptStarting
      && (Boolean(model.modelArrayBatch) || model.modelArraySuspendedMeshes.size > 0);
    const visible = keepScriptHostActive || this.dependencies.document.isEntityVisible(entityId);
    if (model.modelArrayBatch && !keepScriptHostActive) {
      this.suspendModelArrayHost(model);
    } else {
      this.restoreModelArrayHostMeshes(model);
      const pickable = !keepScriptHostActive && visible && this.dependencies.document.isEntityScenePickable(entityId);
      model.root.setEnabled(visible);
      for (const mesh of model.meshes) {
        mesh.isPickable = pickable;
      }
    }
    // 绑定货格挂在 model.root 下但不属于模型网格；宿主挂起期间根节点保持启用，货格显隐由绑定条件统一计算。
    for (const slotEntity of this.dependencies.document.syncedEntities.values()) {
      if (slotEntity.components.locator?.builtInBinding?.hostEntityId !== entityId) continue;
      this.dependencies.locators.locators.get(slotEntity.id)?.root.setEnabled(this.dependencies.locators.computeBuiltInSlotRenderable(slotEntity, highlightSet));
    }
  }

  /**
   * 阵列批次已经承载源实体本身和全部逻辑实例时，脚本宿主只保留节点与几何引用。
   * 将其从 scene.meshes 移除，避免 Babylon 每帧重复遍历同一套隐藏叶 Mesh。
   * 根节点保持启用：绑定货格等外来子节点挂在 root 下，不属于模型网格，不能连带隐藏。
   */
  public suspendModelArrayHost(model: ModelRuntimeEntry): void {
    for (const mesh of model.meshes) {
      if (mesh.isDisposed()) continue;
      if (this.context.scene.removeMesh(mesh) >= 0) model.modelArraySuspendedMeshes.add(mesh);
      mesh.isPickable = false;
    }
  }

  /** 阵列取消或降级时，只把本运行时主动移除的宿主 Mesh 放回场景。 */
  public restoreModelArrayHostMeshes(model: ModelRuntimeEntry): void {
    if (model.modelArraySuspendedMeshes.size === 0) return;
    for (const mesh of model.modelArraySuspendedMeshes) {
      if (!mesh.isDisposed() && !this.context.scene.meshes.includes(mesh)) this.context.scene.addMesh(mesh);
    }
    model.modelArraySuspendedMeshes.clear();
  }

  /** 同步普通模型包外置脚本，并在脚本就绪后刷新模型呈现。 */
  public syncExternalModelScripts(entity: Entity, model: ModelRuntimeEntry): void {
    const modelAsset = entity.components.modelAsset;
    if (!modelAsset) return;
    const traceScope = this.dependencies.readiness.loadDiagnostics.captureTrace();
    this.syncModelAssetExternalScripts(modelAsset, model, (current) => this.dependencies.readiness.loadDiagnostics.measure('modelScriptRefresh', () => {
      const latestEntity = current.entitySnapshot ?? entity;
      this.refreshModelEntityMeshes(latestEntity, current);
      this.dependencies.arrays.syncModelArrayBatch(latestEntity, current);
      this.applyModelInteractivity(current, latestEntity.id);
      this.dependencies.selection.applyModelSelection(current, current.highlighted);
      Reflect.apply(this.context.onModelMeasurementChanged, this.context.callbackReceiver, [latestEntity.id]);
      this.dependencies.presentation.syncConveyorTrajectory(latestEntity, current);
      this.dependencies.locators.refreshBuiltInSlotBindings(latestEntity.id);
      this.dependencies.readiness.scheduleModelPresentationRefresh();
    }, { entityId: entity.id }, traceScope));
  }

  /** 同步生成模型外置脚本；只注入生成器快照，不注册独立遥测运动实体。 */
  public syncModelGeneratorExternalScripts(
    runtimeEntry: GeneratedOutputOwnerRuntimeEntry,
    modelAsset: ModelAssetComponent,
    model: ModelRuntimeEntry,
  ): void {
    this.syncModelAssetExternalScripts(modelAsset, model, (current) => {
      const activeEntry = this.dependencies.outputs.generatedOutputOwners.get(runtimeEntry.entityId);
      if (activeEntry?.output?.kind !== 'model' || activeEntry.output.model !== current) return;
      this.refreshModelGeneratorModelMeshes(activeEntry);
      this.dependencies.outputs.applyGeneratedOutputPresentation(activeEntry);
    });
  }

  /** 收集普通模型脚本生成的额外 Mesh，并统一补齐实体拾取元数据。 */
  public refreshModelEntityMeshes(entity: Entity, model: ModelRuntimeEntry): void {
    this.refreshModelMeshes(model, { [EDITOR_ENTITY_ID_METADATA_KEY]: entity.id });
  }

  /** 收集模型脚本在稳定根节点下创建的额外 Mesh，并补齐生成器产物点击元数据。 */
  public refreshModelGeneratorModelMeshes(runtimeEntry: GeneratedOutputOwnerRuntimeEntry): void {
    if (runtimeEntry.output?.kind === 'composition') {
      for (const member of runtimeEntry.output.members) {
        if (member.model) {
          this.refreshModelMeshes(member.model, runtimeEntry.metadata);
          for (const mesh of member.model.meshes) {
            mesh.isPickable = true;
          }
        }
        if (member.mesh && !member.mesh.isDisposed()) {
          member.mesh.metadata = { ...(member.mesh.metadata ?? {}), ...runtimeEntry.metadata };
          member.mesh.isPickable = true;
        }
        // 阵列成员的源 Mesh 已退出场景：拾取元数据与包围盒必须落在承载几何的批次网格上。
        if (member.arrayBatch) {
          for (const mesh of member.arrayBatch.meshes) {
            if (mesh.isDisposed()) continue;
            mesh.metadata = { ...(mesh.metadata ?? {}), ...runtimeEntry.metadata };
            mesh.isPickable = true;
            mesh.thinInstanceEnablePicking = true;
            mesh.thinInstanceRefreshBoundingInfo(true);
          }
        }
      }
      return;
    }
    if (runtimeEntry.output?.kind !== 'model') return;
    const model = runtimeEntry.output.model;
    this.refreshModelMeshes(model, {
      ...runtimeEntry.metadata,
      ...(runtimeEntry.editorEntityId ? { [EDITOR_ENTITY_ID_METADATA_KEY]: runtimeEntry.editorEntityId } : {}),
    });
    // 生成器产物没有 editorEntityId，常规实体拾取会按元数据过滤掉；放开可拾取只为生成物点击链路服务。
    for (const mesh of model.meshes) {
      mesh.isPickable = true;
    }
  }

  /** 从模型稳定根节点重新收集全部活动 Mesh，并合并运行时元数据。 */
  public refreshModelMeshes(model: ModelRuntimeEntry, metadata: Record<string, unknown>): void {
    // 只收集 contentRoot 下的模型自身内容：绑定货格挂在 model.root 下，混入会被阵列批次克隆、挂起时移出场景。
    model.meshes = [...new Set(model.contentRoot.getChildMeshes(false))]
      .filter((mesh) => !mesh.isDisposed() && !mesh.metadata?.lightingDerived);
    repairInstancedMeshBufferContainers(model.meshes);
    for (const mesh of model.meshes) {
      mesh.metadata = { ...(mesh.metadata ?? {}), ...metadata };
    }
    this.dependencies.readiness.invalidateModelStatistics();
    this.dependencies.environment.lightingRuntime?.markDirty('model-meshes-refresh-unknown');
  }

  /** 同步模型资产脚本生命周期，普通模型和生成模型共享同一份受控实现。 */
  public syncModelAssetExternalScripts(
    modelAsset: ModelAssetComponent,
    model: ModelRuntimeEntry,
    onSettled: (current: ModelRuntimeEntry) => void,
  ): void {
    if (this.updatesStopped || model.root.isDisposed() || !model.assetHandle) return;
    const traceScope = this.dependencies.readiness.loadDiagnostics.captureTrace();
    // 阵列会把脚本宿主 Mesh 移出 scene.meshes；生命周期执行前临时恢复，兼容按场景列表查找部件的模型包。
    // 参数/脚本更新的最终批次统一由 onSettled 原子提交；上下文注入阶段只恢复宿主，不得提前缩减旧批次覆盖。
    // 异步 start 完成前保持根节点启用，避免旧脚本把 enabled=false 捕获为参数基线。
    const hadArrayHost = Boolean(model.modelArrayBatch) || model.modelArraySuspendedMeshes.size > 0;
    this.restoreModelArrayHostMeshes(model);
    if (hadArrayHost) {
      model.root.setEnabled(true);
      this.dependencies.arrays.beginModelArrayHostRenderSuppression(model);
    }
    this.dependencies.parameters.syncModelScriptMetadata(model.contentRoot, modelAsset);
    const settle = (current: ModelRuntimeEntry): void => {
      if (this.updatesStopped || current.root.isDisposed()) return;
      try {
        this.dependencies.readiness.loadDiagnostics.withTrace(traceScope, () => onSettled(current));
      } finally {
        this.dependencies.arrays.endModelArrayHostRenderSuppression(current);
        if (!this.updatesStopped) this.dependencies.readiness.invalidateModelStatistics();
      }
    };

    const scriptAssets = modelAsset.scriptAssets ?? [];
    if (scriptAssets.length === 0) {
      if (model.externalScriptRuntime) this.dependencies.telemetry.motionStaticBatchRuntime.markModelDirty(model);
      model.readinessError = undefined;
      model.externalScriptRuntime?.dispose();
      model.externalScriptRuntime = null;
      model.externalScriptSignature = '';
      model.externalScriptStarting = false;
      model.measurementReady = true;
      resetStackerTelemetryState(model);
      resetConveyorTelemetryState(model);
      resetRgvTelemetryState(model);
      resetShuttleTelemetryState(model);
      resetLiftTelemetryState(model);
      resetHcliftTelemetryState(model);
      model.stackerTelemetryReady = true;
      settle(model);
      return;
    }

    const signature = JSON.stringify({
      assetRevision: modelAsset.assetRevision ?? null,
      scripts: scriptAssets.map((scriptAsset) => ({
        path: scriptAsset.path,
        sourceUrl: scriptAsset.sourceUrl,
        name: scriptAsset.name,
      })),
      parameterScripts: modelAsset.parameterScriptMetadata ?? [],
      animationScripts: modelAsset.animationScriptMetadata ?? [],
    });

    const runtimeMode = this.dependencies.telemetry.telemetryPreviewActive ? 'runtime' : 'edit';
    if (!model.externalScriptRuntime || model.externalScriptSignature !== signature) {
      if (model.externalScriptRuntime) this.dependencies.telemetry.motionStaticBatchRuntime.markModelDirty(model);
      model.readinessError = undefined;
      model.externalScriptStarting = true;
      model.measurementReady = false;
      this.dependencies.readiness.invalidateModelStatistics();
      model.stackerTelemetryReady = false;
      model.externalScriptRuntime?.dispose();
      const entityId = model.entitySnapshot?.id ?? model.root.name;
      model.externalScriptRuntime = new ExternalModelScriptRuntime(model.contentRoot, modelAsset, {
        expectedScriptHashes: model.assetHandle.runtimeCapabilities?.scripts,
        onInitializationStageStart: stage => {
          const token = this.dependencies.readiness.loadDiagnostics.beginTraceTask(stage, { entityId }, traceScope);
          return failed => token?.end(failed ? 'error' : 'ok', failed ? 'operation-failed' : undefined);
        },
        onInitializationTiming: ({ stage, scriptAsset, durationMs, failed }) => {
          this.dependencies.readiness.loadDiagnostics.record(stage, durationMs, failed, { resource: scriptAsset.sourceUrl || scriptAsset.name, entityId });
        },
      });
      model.externalScriptSignature = signature;
      this.dependencies.telemetry.updateModelExternalScriptRuntimeContext(model, runtimeMode, null, true);
      model.externalScriptRuntime.updateAssetCode(modelAsset.assetCode);
      model.externalScriptRuntime.updateParameterValues(modelAsset.parameterValues);

      const runtime = model.externalScriptRuntime;
      const loadToken = model.loadToken;
      // 此阶段为脚本 start 的整体等待；不将其误报为纯 CPU 初始化或解码时间。
      void this.dependencies.readiness.loadDiagnostics.measureAsync('scriptInitialize', () => runtime.start(), {
        resource: modelAsset.sourceUrl, entityId: model.entitySnapshot?.id ?? model.root.name,
      }, traceScope)
        .then(() => {
          const current = this.findActiveModelRuntimeEntry(runtime);
          if (!current || current.loadToken !== loadToken) return;
          this.dependencies.telemetry.updateModelExternalScriptRuntimeContext(current, this.dependencies.telemetry.telemetryPreviewActive ? 'runtime' : 'edit', null, true);
          runtime.update();
          current.readinessError = runtime.getInitializationError() ?? undefined;
          resetStackerTelemetryState(current);
          resetConveyorTelemetryState(current);
          resetRgvTelemetryState(current);
          resetShuttleTelemetryState(current);
          resetLiftTelemetryState(current);
          resetHcliftTelemetryState(current);
          current.externalScriptStarting = false;
          current.measurementReady = true;
          current.stackerTelemetryReady = true;
          settle(current);
        })
        .catch((error) => {
          const current = this.findActiveModelRuntimeEntry(runtime);
          if (!current || current.loadToken !== loadToken) return;
          current.externalScriptStarting = false;
          current.measurementReady = true;
          resetStackerTelemetryState(current);
          resetConveyorTelemetryState(current);
          resetRgvTelemetryState(current);
          resetShuttleTelemetryState(current);
          resetLiftTelemetryState(current);
          resetHcliftTelemetryState(current);
          current.stackerTelemetryReady = true;
          const message = error instanceof Error ? error.message : String(error);
          current.readinessError = message;
          Reflect.apply(this.context.pushLog, this.context.callbackReceiver, [`模型脚本初始化失败，已回退基础几何与测量：${message}`]);
          settle(current);
        });
      return;
    }

    this.dependencies.telemetry.motionStaticBatchRuntime.beginModelMutation(model);
    try {
      model.externalScriptRuntime.updateAssetCode(modelAsset.assetCode);
      model.externalScriptRuntime.updateParameterValues(modelAsset.parameterValues);
      this.dependencies.telemetry.updateModelExternalScriptRuntimeContext(model, runtimeMode, null, true);
      if (model.externalScriptStarting) return;

      model.externalScriptRuntime.update();
      resetStackerTelemetryState(model);
      resetConveyorTelemetryState(model);
      resetRgvTelemetryState(model);
      resetShuttleTelemetryState(model);
      resetLiftTelemetryState(model);
      resetHcliftTelemetryState(model);
      model.measurementReady = true;
      model.stackerTelemetryReady = true;
      settle(model);
    } finally {
      this.dependencies.telemetry.motionStaticBatchRuntime.endModelMutation(model);
    }
  }

  /** 在普通模型和生成器派生模型中查找仍处于活动状态的脚本宿主。 */
  public findActiveModelRuntimeEntry(runtime: ExternalModelScriptRuntime): ModelRuntimeEntry | null {
    if (this.updatesStopped) return null;
    for (const model of this.models.values()) {
      if (model.externalScriptRuntime === runtime) return model;
    }
    for (const variant of this.dependencies.variants.modelArrayParameterVariants.values()) {
      if (variant.model.externalScriptRuntime === runtime) return variant.model;
    }
    for (const owner of this.dependencies.outputs.generatedOutputOwners.values()) {
      if (owner.output?.kind === 'model' && owner.output.model.externalScriptRuntime === runtime) {
        return owner.output.model;
      }
    }
    for (const model of this.dependencies.outputs.spawnedDeviceModels.values()) {
      if (model.externalScriptRuntime === runtime) return model;
    }
    return null;
  }

  /** 用模型源 URL、导入版本和实例化策略生成加载签名，同路径覆盖或策略变化时都能重新载入。 */
  public createModelAssetSignature(modelAsset: ModelAssetComponent): string {
    return JSON.stringify({
      sourceUrl: modelAsset.sourceUrl,
      templateKey: createModelAssetTemplateKey(modelAsset),
      assetRevision: modelAsset.assetRevision ?? null,
      lengthUnit: modelAsset.lengthUnit,
      unitScaleToMeters: modelAsset.unitScaleToMeters,
      instancingMode: resolveModelAssetSharedInstancingPolicy(modelAsset).mode,
      ...(modelAsset.runtimeCapabilities ? { runtimeCapabilities: modelAsset.runtimeCapabilities,
        capabilityConfiguration: modelRuntimeConfigurationKey(modelAsset),
        capabilityScripts: modelAsset.scriptAssets ?? [] } : {}),
    });
  }

  /** 给运行时资源 URL 追加导入版本参数，绕开浏览器和 Electron 对同路径资源的缓存。 */
  public resolveVersionedRuntimeAssetUrl(sourceUrl: string, assetRevision: string | undefined | null): string {
    const runtimeUrl = resolveRuntimeAssetUrl(sourceUrl);
    if (!assetRevision) return runtimeUrl;

    const separator = runtimeUrl.includes('?') ? '&' : '?';
    return `${runtimeUrl}${separator}assetRevision=${encodeURIComponent(assetRevision)}`;
  }


  /** 仅把 glTF 顶层节点挂到模型内容节点，保留模型内部层级、骨骼和动画关系。 */
  public parentTopLevelModelNodes(model: ModelRuntimeEntry, transformNodes: TransformNode[]): void {
    const allImportedNodes = new Set([...model.meshes, ...transformNodes]);

    for (const node of allImportedNodes) {
      if (!node.parent || !allImportedNodes.has(node.parent as AbstractMesh | TransformNode)) {
        node.parent = model.contentRoot;
      }
    }
  }

  /** 将导入模型内容的底部中心归一到实体根节点，避免源模型巨大坐标偏移影响场景放置。 */
  public normalizeModelContentOrigin(model: ModelRuntimeEntry): void {
    model.root.computeWorldMatrix(true);

    // 只测量模型自身内容：绑定货格等外来子节点可能在异步加载完成前就挂到 root 下，
    // 参与测量会把归一化原点带偏（粘贴含内置货格的货架时原点跑到整排中点）。
    const childMeshes = model.contentRoot.getChildMeshes(false).filter(isMeasurableModelMesh);
    if (childMeshes.length === 0) return;

    const bottomCenter = getMeshesWorldBottomCenter(childMeshes);
    if (!bottomCenter) return;

    const inverseRootMatrix = model.root.getWorldMatrix().clone().invert();
    const localBottomCenter = Vector3.TransformCoordinates(bottomCenter, inverseRootMatrix);

    for (const child of model.root.getChildren()) {
      if (child instanceof TransformNode) {
        child.position.subtractInPlace(localBottomCenter);
      }
    }
  }

  /** 通过统一并发调度器加载 Babylon 资产容器，限制批量模型解析和 GPU 上传峰值。 */
  public loadAssetContainer(
    rootUrl: string,
    fileName: string,
    loadSignal?: AbortSignal,
    onProgress?: (event: ISceneLoaderProgressEvent) => void,
    traceScope: SceneLoadTraceScope | null = this.dependencies.readiness.loadDiagnostics.captureTrace(),
    trace?: SceneAssetTrace,
  ): Promise<AssetContainer> {
    if (this.updatesStopped) return Promise.reject(new DOMException('模型资产更新已停止。', 'AbortError'));
    const queuedAt = readRuntimeTimestampMs();
    const context = { resource: fileName, resourceOrdinal: trace?.resourceOrdinal };
    const queueToken = this.dependencies.readiness.loadDiagnostics.beginTraceTask('assetQueue', context, traceScope);
    return this.assetLoadScheduler.run(
      () => {
        this.assertUpdatesActive(loadSignal);
        queueToken?.end();
        this.dependencies.readiness.loadDiagnostics.record('assetQueue', readRuntimeTimestampMs() - queuedAt);
        return this.dependencies.readiness.loadDiagnostics.measureAsync('assetReadDecode',
          // 所有入口共享同一模板缓存；先独占加载的模板也必须保留实际源声明，避免准入依赖加载顺序。
          () => loadCapabilityModelTemplate(rootUrl, fileName, this.context.scene, event => {
            if (!this.updatesStopped && !loadSignal?.aborted) onProgress?.(event);
          }), context, traceScope);
      },
      loadSignal,
    ).then(container => {
      try {
        this.assertUpdatesActive(loadSignal);
        return container;
      } catch (error) {
        // 调度器无法取消已开始的底层解码，迟到容器必须在进入共享缓存前自行释放。
        runSceneRuntimeCleanup(this.context, `过期模型容器 ${fileName}`, () => container.dispose());
        throw error;
      }
    }).catch(error => {
      const aborted = this.updatesStopped || loadSignal?.aborted || (error instanceof Error && error.name === 'AbortError');
      queueToken?.end(aborted ? 'cancelled' : 'error', aborted ? 'aborted' : 'operation-failed');
      this.assertUpdatesActive(loadSignal);
      throw error;
    });
  }

  /** 把完整资源 URL 拆成 Babylon SceneLoader 需要的 rootUrl 和 fileName。 */
  public splitAssetUrl(sourceUrl: string): { rootUrl: string; fileName: string } {
    const lastSlashIndex = sourceUrl.lastIndexOf('/');
    if (lastSlashIndex < 0) {
      return { rootUrl: '', fileName: sourceUrl };
    }

    return {
      rootUrl: sourceUrl.slice(0, lastSlashIndex + 1),
      fileName: sourceUrl.slice(lastSlashIndex + 1),
    };
  }
}
