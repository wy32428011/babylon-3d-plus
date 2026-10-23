import { AssetContainer } from '@babylonjs/core/assetContainer.js';
import { SceneLoader } from '@babylonjs/core/Loading/sceneLoader.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh.js';

import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import type { ISceneLoaderProgressEvent } from '@babylonjs/core';
import type { Entity } from '../../../editor/model/Entity';
import type { ModelAssetComponent } from '../../../editor/model/components';
import { ExternalModelScriptRuntime } from '../ExternalModelScriptRuntime';
import { isMeasurableModelMesh } from '../modelMeasurement';
import { getMeshesWorldBottomCenter } from '../runtimeNodeGeometry';
import { resolveRuntimeAssetUrl } from '../../assets/editorAssetUrl';
import { AssetLoadScheduler } from '../AssetLoadScheduler';
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
import { EDITOR_ENTITY_ID_METADATA_KEY, type LoadedModelRuntimeAssets, type ModelRuntimeEntry, type GeneratedOutputOwnerRuntimeEntry, readRuntimeTimestampMs } from './sceneRuntimeTypes';

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
  constructor(private readonly context: SceneRuntimeContext, private readonly dependencies: Dependencies) {}

  public readonly models = new Map<string, ModelRuntimeEntry>();
  public readonly assetLoadScheduler = new AssetLoadScheduler();
  public modelPresentationRefreshPending = false;
  public readonly sharedModelAssetCache = new SharedModelAssetCache();
  public modelLoadSequence = 0;

  /** 记录独立矩阵实例实体；其几何由 sourceEntityId 对应源模型的批次统一提交。 */
  public syncModelArrayInstanceEntity(
    entity: Entity,
    highlightSet: ReadonlySet<string> = this.dependencies.selection.selectedEntityIds,
  ): void {
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

    void this.loadModelRuntimeAssets(modelAsset, assetSignature, loadAbortController.signal, entity.id)
      .then((loadedAssets) => this.dependencies.readiness.loadDiagnostics.measure('modelInitialize', () => {
        const activeEntry = this.models.get(entity.id);
        if (!activeEntry || activeEntry.loadToken !== loadToken || activeEntry.assetSignature !== assetSignature) {
          loadedAssets.handle.dispose();
          return;
        }

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
      }))
      .catch((error) => {
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
    const { rootUrl, fileName } = this.splitAssetUrl(
      this.resolveVersionedRuntimeAssetUrl(modelAsset.sourceUrl, modelAsset.assetRevision),
    );
    const sequence = this.dependencies.readiness.beginModelLoadProgressUnit(fileName);
    try {
      return await this.sharedModelAssetCache.preload(
        createModelAssetTemplateKey(modelAsset),
        sourceSignal => this.loadAssetContainer(rootUrl, fileName, sourceSignal, event => {
          this.dependencies.readiness.updateModelLoadProgressUnit(sequence, event);
        }),
        signal,
      );
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
    const { rootUrl, fileName } = this.splitAssetUrl(
      this.resolveVersionedRuntimeAssetUrl(modelAsset.sourceUrl, modelAsset.assetRevision),
    );

    const loadSequence = this.dependencies.readiness.beginModelLoadProgressUnit(fileName);
    try {
      const instancingPolicy = resolveModelAssetSharedInstancingPolicy(modelAsset);
      if (!forceOwnedContainer && instancingPolicy.mode === 'shared-instance') {
        const sharedInstance = await this.sharedModelAssetCache.instantiate(
          createModelAssetTemplateKey(modelAsset),
          (sourceSignal) => this.loadAssetContainer(rootUrl, fileName, sourceSignal, (event) => {
            this.dependencies.readiness.updateModelLoadProgressUnit(loadSequence, event);
          }),
          (sourceName) => sourceName,
          loadSignal,
          (ms, failed) => this.dependencies.readiness.loadDiagnostics.record('modelClone', ms, failed, { resource: fileName, entityId }),
        );
        return {
          kind: 'shared-instance',
          handle: {
            kind: 'shared-instance',
            animationGroups: sharedInstance.entries.animationGroups,
            dispose: sharedInstance.dispose,
          },
          rootNodes: sharedInstance.entries.rootNodes,
        };
      }

      const container = await this.sharedModelAssetCache.acquireOwnedContainer(
        createModelAssetTemplateKey(modelAsset),
        (sourceSignal) => this.loadAssetContainer(rootUrl, fileName, sourceSignal, (event) => {
          this.dependencies.readiness.updateModelLoadProgressUnit(loadSequence, event);
        }),
        loadSignal,
        (ms, failed) => this.dependencies.readiness.loadDiagnostics.record('modelClone', ms, failed, { resource: fileName, entityId }),
      );
      try {
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
        container.dispose();
        throw error;
      }
    } catch (error) {
      if (!(error instanceof Error && error.name === 'AbortError')) this.dependencies.readiness.failedModelAcquisitions += 1;
      throw error;
    } finally {
      this.dependencies.readiness.settleModelLoadProgressUnit(loadSequence);
    }
  }

  /** 释放导入模型的容器、根节点与所有子资源。 */
  public disposeModel(entityId: string, model: ModelRuntimeEntry): void {
    this.dependencies.telemetry.motionStaticBatchRuntime.markModelDirty(model);
    for (const [key, failure] of this.dependencies.readiness.modelReadinessErrors) {
      if (failure.entityIds.includes(entityId)) this.dependencies.readiness.modelReadinessErrors.delete(key);
    }
    this.dependencies.transforms.clearEntityArrayPreviewIfSource(entityId);
    const trajectory = this.dependencies.presentation.conveyorTrajectories.get(entityId);
    if (trajectory) this.dependencies.presentation.disposeConveyorTrajectory(entityId, trajectory);
    model.telemetryPreviewBaseline = null;
    model.cancelLoad?.();
    model.cancelLoad = null;
    this.dependencies.arrays.endModelArrayHostRenderSuppression(model);
    this.dependencies.selection.applyModelSelection(model, false);
    this.restoreModelArrayHostMeshes(model);
    model.root.setEnabled(true);
    model.externalScriptRuntime?.dispose();
    for (const texture of model.textureCache.values()) {
      texture.dispose();
    }
    this.dependencies.variants.disposeModelArrayParameterVariantsForSource(entityId);
    this.dependencies.arrays.disposeModelArrayBatch(model);
    model.assetHandle?.dispose();
    this.dependencies.telemetry.specializedTelemetryRuntime.disposeCargoForAssetCode(model.assetCode);
    model.contentRoot.dispose();
    model.root.dispose();
    model.modelArraySuspendedMeshes.clear();
    this.models.delete(entityId);
    Reflect.apply(this.context.onModelMeasurementChanged, this.context.callbackReceiver, [entityId]);
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
    }));
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
    this.dependencies.environment.lightingRuntime?.markDirty();
  }

  /** 同步模型资产脚本生命周期，普通模型和生成模型共享同一份受控实现。 */
  public syncModelAssetExternalScripts(
    modelAsset: ModelAssetComponent,
    model: ModelRuntimeEntry,
    onSettled: (current: ModelRuntimeEntry) => void,
  ): void {
    if (!model.assetHandle) return;
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
      try {
        onSettled(current);
      } finally {
        this.dependencies.arrays.endModelArrayHostRenderSuppression(current);
        this.dependencies.readiness.invalidateModelStatistics();
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
      model.externalScriptRuntime = new ExternalModelScriptRuntime(model.contentRoot, modelAsset);
      model.externalScriptSignature = signature;
      this.dependencies.telemetry.updateModelExternalScriptRuntimeContext(model, runtimeMode, null, true);
      model.externalScriptRuntime.updateAssetCode(modelAsset.assetCode);
      model.externalScriptRuntime.updateParameterValues(modelAsset.parameterValues);

      const runtime = model.externalScriptRuntime;
      const loadToken = model.loadToken;
      // 此阶段为脚本 start 的整体等待；不将其误报为纯 CPU 初始化或解码时间。
      void this.dependencies.readiness.loadDiagnostics.measureAsync('scriptInitialize', () => runtime.start(), {
        resource: modelAsset.sourceUrl, entityId: model.entitySnapshot?.id ?? model.root.name,
      })
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
      assetRevision: modelAsset.assetRevision ?? null,
      lengthUnit: modelAsset.lengthUnit,
      unitScaleToMeters: modelAsset.unitScaleToMeters,
      instancingMode: resolveModelAssetSharedInstancingPolicy(modelAsset).mode,
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
  ): Promise<AssetContainer> {
    const queuedAt = readRuntimeTimestampMs();
    return this.assetLoadScheduler.run(
      () => {
        this.dependencies.readiness.loadDiagnostics.record('assetQueue', readRuntimeTimestampMs() - queuedAt);
        return this.dependencies.readiness.loadDiagnostics.measureAsync('assetReadDecode',
          () => SceneLoader.LoadAssetContainerAsync(rootUrl, fileName, this.context.scene, onProgress), fileName);
      },
      loadSignal,
    );
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
