
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import type { Entity } from '../../../editor/model/Entity';
import type { ModelAssetComponent } from '../../../editor/model/components';
import { createConveyorTelemetryState, createHcliftTelemetryState, createLiftTelemetryState, createRgvTelemetryState, createShuttleTelemetryState, createStackerTelemetryState, isConveyorModelAsset, isLiftModelAsset, isRgvModelAsset, isStackerModelAsset } from '../telemetry/specialized/specializedModelAssets';
import type { SceneRuntimeContext } from './SceneRuntimeContext';
import type { ModelAssetRuntimeController } from './ModelAssetRuntimeController';
import type { SceneMeshPresentationController } from './SceneMeshPresentationController';
import type { ModelArrayRuntimeController } from './ModelArrayRuntimeController';
import type { ModelParameterBindingController } from './ModelParameterBindingController';
import type { SceneTriangleAndReadinessController } from './SceneTriangleAndReadinessController';
import type { SceneLocatorController } from './SceneLocatorController';
import type { ScenePickingAndSelectionController } from './ScenePickingAndSelectionController';
import { runSceneRuntimeCleanup } from './sceneRuntimeCleanup';
import { type ModelRuntimeEntry, type ModelArrayParameterVariantRuntimeEntry } from './sceneRuntimeTypes';

/** 此领域仅能访问明确列出的协作能力，资源与缓存由所属 Controller 持有。 */
type Dependencies = {
  readonly assets: Pick<ModelAssetRuntimeController, 'createModelAssetSignature' | 'modelLoadSequence' | 'loadModelRuntimeAssets' | 'parentTopLevelModelNodes' | 'refreshModelMeshes' | 'normalizeModelContentOrigin' | 'syncModelAssetExternalScripts' | 'restoreModelArrayHostMeshes'>;
  readonly presentation: Pick<SceneMeshPresentationController, 'applyTransform'>;
  readonly arrays: Pick<ModelArrayRuntimeController, 'isModelArrayBatchCurrent' | 'syncModelArrayBatchForEntities' | 'scheduleModelArraySourceResync' | 'beginModelArrayHostRenderSuppression' | 'endModelArrayHostRenderSuppression' | 'disposeModelArrayBatch'>;
  readonly parameters: Pick<ModelParameterBindingController, 'applyModelAssetParameters' | 'applyModelUnitScale'>;
  readonly readiness: Pick<SceneTriangleAndReadinessController, 'modelReadinessErrors' | 'invalidateModelStatistics'>;
  readonly locators: Pick<SceneLocatorController, 'refreshBuiltInSlotBindings'>;
  readonly selection: Pick<ScenePickingAndSelectionController, 'rebuildModelSelectionOutline'>;
};


/** ParameterVariantHostPool 的资源、状态及取消/释放操作在同一领域内维护。 */
export class ParameterVariantHostPool {
  constructor(private readonly context: SceneRuntimeContext, private readonly dependencies: Dependencies) {}

  public readonly modelArrayParameterVariants = new Map<string, ModelArrayParameterVariantRuntimeEntry>();
  public readonly modelArrayParameterVariantByEntityId = new Map<string, ModelArrayParameterVariantRuntimeEntry>();
  private disposed = false;

  /** 所有异步回调先失效，再逐宿主释放；两个索引都只由宿主池负责清空。 */
  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const variant of [...this.modelArrayParameterVariants.values()]) {
      runSceneRuntimeCleanup(this.context, `参数变体 ${variant.representativeEntityId}`, () => this.disposeModelArrayParameterVariant(variant));
    }
    this.modelArrayParameterVariants.clear();
    this.modelArrayParameterVariantByEntityId.clear();
  }

  /** 单实体或整组连续调参时复用已就绪宿主，避免每次滑块变化都重新加载并启动脚本。 */
  public rekeyReusableModelArrayParameterVariant(
    sourceEntityId: string,
    nextKey: string,
    nextRenderSignature: string,
    entities: readonly Entity[],
    reservedKeys: ReadonlySet<string>,
  ): void {
    if (this.disposed || this.modelArrayParameterVariants.has(nextKey)) return;
    const entityIds = new Set(entities.map((entity) => entity.id));
    const reusable = [...this.modelArrayParameterVariants.values()].find((variant) => (
      variant.sourceEntityId === sourceEntityId
      && !reservedKeys.has(variant.key)
      && variant.model.assetHandle !== null
      && !variant.model.externalScriptStarting
      && variant.entities.length === entityIds.size
      && variant.entities.every((entity) => entityIds.has(entity.id))
    ));
    if (!reusable) return;

    this.modelArrayParameterVariants.delete(reusable.key);
    reusable.key = nextKey;
    reusable.renderSignature = nextRenderSignature;
    this.modelArrayParameterVariants.set(nextKey, reusable);
  }

  /** 为一个不同参数组合创建或刷新唯一脚本宿主；组内所有逻辑实体继续共享一个矩阵批次。 */
  public syncModelArrayParameterVariant(
    sourceEntity: Entity,
    key: string,
    renderSignature: string,
    entities: Entity[],
    parameterOnlyChangedEntityId?: string,
  ): ModelArrayParameterVariantRuntimeEntry | null {
    if (this.disposed) return null;
    const representative = entities[0];
    const modelAsset = representative?.components.modelAsset;
    if (!representative || !modelAsset) return null;

    const assetSignature = this.dependencies.assets.createModelAssetSignature(modelAsset);
    let variant = this.modelArrayParameterVariants.get(key);
    if (variant && variant.model.assetSignature !== assetSignature) {
      this.disposeModelArrayParameterVariant(variant);
      variant = undefined;
    }

    if (!variant) {
      variant = this.createModelArrayParameterVariant(
        sourceEntity,
        key,
        renderSignature,
        representative,
        entities,
        modelAsset,
        assetSignature,
        parameterOnlyChangedEntityId,
      );
      return variant;
    }

    variant.representativeEntityId = representative.id;
    variant.entities = entities;
    variant.parameterOnlyChangedEntityId = parameterOnlyChangedEntityId ?? null;
    const model = variant.model;
    model.entitySnapshot = representative;
    model.assetCode = modelAsset.assetCode;
    model.telemetryBinding = representative.components.telemetryBinding ?? null;
    model.assetRevision = modelAsset.assetRevision ?? null;
    model.assetSignature = assetSignature;
    model.stackerCapable = isStackerModelAsset(modelAsset);
    model.conveyorCapable = isConveyorModelAsset(modelAsset);
    model.rgvCapable = isRgvModelAsset(modelAsset);
    model.liftCapable = isLiftModelAsset(modelAsset);
    this.dependencies.presentation.applyTransform(model.root, representative.components.transform);
    // 参数变体宿主的单位缩放只在创建时设置；重复同步保留脚本叠加在 contentRoot 上的参数缩放。
    if (!model.assetHandle) return variant;
    if (this.dependencies.arrays.isModelArrayBatchCurrent(model, renderSignature) && !model.externalScriptStarting) {
      return variant;
    }

    this.restoreModelArrayParameterVariantHost(variant);
    this.dependencies.parameters.applyModelAssetParameters(modelAsset, model);
    this.syncModelArrayParameterVariantExternalScripts(variant, modelAsset);
    return variant;
  }

  public createModelArrayParameterVariant(
    sourceEntity: Entity,
    key: string,
    renderSignature: string,
    representative: Entity,
    entities: Entity[],
    modelAsset: ModelAssetComponent,
    assetSignature: string,
    parameterOnlyChangedEntityId?: string,
  ): ModelArrayParameterVariantRuntimeEntry {
    if (this.disposed) throw new Error('参数变体宿主池已释放，无法创建宿主。');
    this.dependencies.readiness.modelReadinessErrors.delete(`variant:${key}`);
    const variantSequence = ++this.dependencies.assets.modelLoadSequence;
    const root = new TransformNode(`__modelArrayParameterVariant_${sourceEntity.id}_${variantSequence}`, this.context.scene);
    const contentRoot = new TransformNode(`__modelArrayParameterVariantContent_${sourceEntity.id}_${variantSequence}`, this.context.scene);
    contentRoot.parent = root;
    this.dependencies.presentation.applyTransform(root, representative.components.transform);
    this.dependencies.parameters.applyModelUnitScale(contentRoot, modelAsset.unitScaleToMeters);

    const loadAbortController = new AbortController();
    const model: ModelRuntimeEntry = {
      sourceUrl: modelAsset.sourceUrl,
      assetRevision: modelAsset.assetRevision ?? null,
      assetSignature,
      entitySnapshot: representative,
      assetCode: modelAsset.assetCode,
      telemetryBinding: representative.components.telemetryBinding ?? null,
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
      loadToken: variantSequence,
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
    const variant: ModelArrayParameterVariantRuntimeEntry = {
      key,
      sourceEntityId: sourceEntity.id,
      renderSignature,
      representativeEntityId: representative.id,
      entities,
      sourceLayerMasks: new Map(),
      parameterOnlyChangedEntityId: parameterOnlyChangedEntityId ?? null,
      model,
    };
    this.modelArrayParameterVariants.set(key, variant);

    void this.dependencies.assets.loadModelRuntimeAssets(modelAsset, assetSignature, loadAbortController.signal, sourceEntity.id)
      .then((loadedAssets) => {
        const activeVariant = this.modelArrayParameterVariants.get(key);
        if (this.disposed || !activeVariant || activeVariant.model !== model || model.loadToken !== variantSequence) {
          runSceneRuntimeCleanup(this.context, `过期参数变体资产 ${representative.id}`, () => loadedAssets.handle.dispose());
          return;
        }

        model.cancelLoad = null;
        model.assetHandle = loadedAssets.handle;
        if (loadedAssets.kind === 'owned-container') {
          model.meshes = loadedAssets.meshes;
          this.dependencies.assets.parentTopLevelModelNodes(model, loadedAssets.transformNodes);
        } else {
          for (const rootNode of loadedAssets.rootNodes) rootNode.parent = model.contentRoot;
        }

        const latestEntity = activeVariant.entities.find((item) => item.id === activeVariant.representativeEntityId)
          ?? activeVariant.entities[0]
          ?? representative;
        const latestModelAsset = latestEntity.components.modelAsset ?? modelAsset;
        model.entitySnapshot = latestEntity;
        this.dependencies.assets.refreshModelMeshes(model, {
          modelArrayParameterVariant: true,
          modelArraySourceEntityId: sourceEntity.id,
        });
        this.dependencies.assets.normalizeModelContentOrigin(model);
        this.dependencies.parameters.applyModelAssetParameters(latestModelAsset, model);
        // 编译/启动外置脚本期间宿主必须保持 enabled 和原渲染属性，兼容脚本测量、scene.meshes 查找与克隆。
        // 仅在 Active Mesh 评估期间临时禁用根节点，旧批次继续显示，避免宿主与批次重叠闪烁。
        this.beginModelArrayParameterVariantRenderSuppression(activeVariant);
        this.syncModelArrayParameterVariantExternalScripts(activeVariant, latestModelAsset);
      })
      .catch((error) => {
        const activeVariant = this.modelArrayParameterVariants.get(key);
        if (this.disposed || !activeVariant || activeVariant.model !== model || model.loadToken !== variantSequence) return;
        this.disposeModelArrayParameterVariant(activeVariant);
        const message = error instanceof Error ? error.message : String(error);
        this.dependencies.readiness.modelReadinessErrors.set(`variant:${key}`, {
          entityIds: [sourceEntity.id, ...activeVariant.entities.map(item => item.id)], error: message,
        });
        this.dependencies.readiness.invalidateModelStatistics();
        Reflect.apply(this.context.pushLog, this.context.callbackReceiver, [`模型“${representative.name}”阵列参数脚本宿主加载失败：${message}`]);
      });

    return variant;
  }

  /** 参数脚本完成后刷新脚本生成 Mesh，并只把最终静态外观提交给该参数组的 thinInstance 批次。 */
  public syncModelArrayParameterVariantExternalScripts(
    variant: ModelArrayParameterVariantRuntimeEntry,
    modelAsset: ModelAssetComponent,
  ): void {
    if (this.disposed || this.modelArrayParameterVariants.get(variant.key) !== variant) return;
    this.dependencies.assets.syncModelAssetExternalScripts(modelAsset, variant.model, (current) => {
      const activeVariant = this.modelArrayParameterVariants.get(variant.key);
      if (this.disposed || !activeVariant || activeVariant.model !== current) return;

      this.dependencies.assets.refreshModelMeshes(current, {
        modelArrayParameterVariant: true,
        modelArraySourceEntityId: activeVariant.sourceEntityId,
      });
      this.hideModelArrayParameterVariantHost(activeVariant);
      this.endModelArrayParameterVariantRenderSuppression(activeVariant);
      const representative = activeVariant.entities.find((entity) => entity.id === activeVariant.representativeEntityId)
        ?? activeVariant.entities[0];
      if (representative) {
        this.dependencies.arrays.syncModelArrayBatchForEntities(representative, current, activeVariant.entities, [], {
          sourceEntityId: activeVariant.sourceEntityId,
          namePrefix: '__modelArrayParameterVariantThinInstance',
          variantKey: activeVariant.key,
          renderSignature: activeVariant.renderSignature,
          resolveLayerMask: (mesh) => activeVariant.sourceLayerMasks.get(mesh.uniqueId) ?? mesh.layerMask,
        });
      }
      for (const instanceEntity of activeVariant.entities) Reflect.apply(this.context.onModelMeasurementChanged, this.context.callbackReceiver, [instanceEntity.id]);
      // 变体批次已承载这些副本：先切换渲染源映射，绑定货格才能读到变体布局而非阵列源布局。
      for (const instanceEntity of activeVariant.entities) {
        if (
          current.modelArrayBatch?.hasEntityId(instanceEntity.id)
          && this.dependencies.arrays.isModelArrayBatchCurrent(current, activeVariant.renderSignature)
        ) {
          this.modelArrayParameterVariantByEntityId.set(instanceEntity.id, activeVariant);
        }
        this.dependencies.locators.refreshBuiltInSlotBindings(instanceEntity.id);
      }
      this.dependencies.selection.rebuildModelSelectionOutline();
      const parameterOnlyChangedEntityId = activeVariant.parameterOnlyChangedEntityId ?? undefined;
      activeVariant.parameterOnlyChangedEntityId = null;
      if (this.dependencies.arrays.isModelArrayBatchCurrent(current, activeVariant.renderSignature)) {
        this.dependencies.arrays.scheduleModelArraySourceResync(activeVariant.sourceEntityId, parameterOnlyChangedEntityId);
      }
    });
  }

  /** 新参数宿主异步初始化时保留脚本可见状态，只在每帧 Active Mesh 评估阶段禁止绘制。 */
  public beginModelArrayParameterVariantRenderSuppression(variant: ModelArrayParameterVariantRuntimeEntry): void {
    if (this.disposed) return;
    this.dependencies.arrays.beginModelArrayHostRenderSuppression(variant.model);
  }

  /** 参数脚本最终 Mesh 已转入 layerMask=0 后结束逐帧临时禁用，并恢复脚本宿主 enabled 状态。 */
  public endModelArrayParameterVariantRenderSuppression(variant: ModelArrayParameterVariantRuntimeEntry): void {
    this.dependencies.arrays.endModelArrayHostRenderSuppression(variant.model);
  }

  /** 先保存脚本宿主的原渲染层；批次创建期间仍需读取完整世界矩阵和视觉状态。 */
  public hideModelArrayParameterVariantHost(variant: ModelArrayParameterVariantRuntimeEntry): void {
    if (this.disposed) return;
    const activeMeshIds = new Set<number>();
    for (const mesh of variant.model.meshes) {
      if (mesh.isDisposed()) continue;
      activeMeshIds.add(mesh.uniqueId);
      variant.sourceLayerMasks.set(mesh.uniqueId, mesh.layerMask);
      mesh.layerMask = 0;
      mesh.isPickable = false;
    }
    for (const meshId of variant.sourceLayerMasks.keys()) {
      if (!activeMeshIds.has(meshId)) variant.sourceLayerMasks.delete(meshId);
    }
  }

  /** 参数更新前恢复宿主节点与原渲染层；Mesh 无需重新加入场景，脚本通过稳定节点引用直接更新。 */
  public restoreModelArrayParameterVariantHost(variant: ModelArrayParameterVariantRuntimeEntry): void {
    variant.model.root.setEnabled(true);
    for (const mesh of variant.model.meshes) {
      const layerMask = variant.sourceLayerMasks.get(mesh.uniqueId);
      if (layerMask !== undefined) mesh.layerMask = layerMask;
    }
  }

  public disposeMissingModelArrayParameterVariants(sourceEntityId: string, activeKeys: ReadonlySet<string>): void {
    for (const variant of [...this.modelArrayParameterVariants.values()]) {
      if (variant.sourceEntityId === sourceEntityId && !activeKeys.has(variant.key)) {
        this.disposeModelArrayParameterVariant(variant);
      }
    }
  }

  public disposeModelArrayParameterVariantsForSource(sourceEntityId: string): void {
    for (const variant of [...this.modelArrayParameterVariants.values()]) {
      if (variant.sourceEntityId === sourceEntityId) this.disposeModelArrayParameterVariant(variant);
    }
  }

  public disposeModelArrayParameterVariant(variant: ModelArrayParameterVariantRuntimeEntry): void {
    if (this.modelArrayParameterVariants.get(variant.key) !== variant) return;
    this.modelArrayParameterVariants.delete(variant.key);
    // 旧批次可能临时承载已离开参数组的实体；按所有权清除全部借用索引，而不只看当前 entities。
    for (const [entityId, current] of this.modelArrayParameterVariantByEntityId) {
      if (current === variant) this.modelArrayParameterVariantByEntityId.delete(entityId);
    }

    const model = variant.model;
    model.loadToken = 0;
    const cleanup = (resource: string, action: () => void): void => {
      runSceneRuntimeCleanup(this.context, `参数变体 ${variant.representativeEntityId} ${resource}`, action);
    };
    cleanup('渲染抑制', () => this.endModelArrayParameterVariantRenderSuppression(variant));
    const cancelLoad = model.cancelLoad;
    model.cancelLoad = null;
    cleanup('在途加载', () => cancelLoad?.());
    cleanup('渲染层恢复', () => this.restoreModelArrayParameterVariantHost(variant));
    cleanup('宿主网格恢复', () => this.dependencies.assets.restoreModelArrayHostMeshes(model));
    cleanup('宿主启用状态', () => { if (!model.root.isDisposed()) model.root.setEnabled(true); });
    const scriptRuntime = model.externalScriptRuntime;
    model.externalScriptRuntime = null;
    model.externalScriptStarting = false;
    cleanup('外置脚本', () => scriptRuntime?.dispose());
    const textures = [...model.textureCache.values()];
    model.textureCache.clear();
    for (const texture of textures) cleanup('参数纹理', () => texture.dispose());
    // 阵列仅借用源材质；先释放批次，再归还共享模型资产句柄。
    cleanup('阵列批次', () => this.dependencies.arrays.disposeModelArrayBatch(model));
    const assetHandle = model.assetHandle;
    model.assetHandle = null;
    cleanup('资产句柄', () => assetHandle?.dispose());
    cleanup('内容节点', () => { if (!model.contentRoot.isDisposed()) model.contentRoot.dispose(); });
    cleanup('根节点', () => { if (!model.root.isDisposed()) model.root.dispose(); });
    model.modelArraySuspendedMeshes.clear();
    model.parameterBaseline.clear();
    model.meshes = [];
    variant.sourceLayerMasks.clear();
    for (const entity of variant.entities) {
      cleanup(`测量通知 ${entity.id}`, () => Reflect.apply(this.context.onModelMeasurementChanged, this.context.callbackReceiver, [entity.id]));
    }
  }
}
