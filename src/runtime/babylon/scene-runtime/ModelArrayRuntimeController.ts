import { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh.js';
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import { Scene } from '@babylonjs/core/scene.js';
import type { Nullable, Observer } from '@babylonjs/core';
import type { Entity } from '../../../editor/model/Entity';
import type { ModelAssetComponent } from '../../../editor/model/components';
import { type SceneDocument } from '../../../editor/model/SceneDocument';
import type { TelemetryBindingComponent } from '../../../editor/model/telemetryBinding';
import { sanitizeBabylonName } from '../runtimeValueUtils';
import { resolveModelAssetSharedInstancingPolicy } from '../SharedModelAssetCache';
import { EntityArrayThinInstanceBatch } from '../EntityArrayThinInstanceBatch';
import { createConveyorTelemetryState, createHcliftTelemetryState, createLiftTelemetryState, createRgvTelemetryState, createShuttleTelemetryState, createStackerTelemetryState, isConveyorModelAsset } from '../telemetry/specialized/specializedModelAssets';
import type { SceneRuntimeContext } from './SceneRuntimeContext';
import type { ModelAssetRuntimeController } from './ModelAssetRuntimeController';
import type { ParameterVariantHostPool } from './ParameterVariantHostPool';
import type { SceneMeshPresentationController } from './SceneMeshPresentationController';
import type { SceneTriangleAndReadinessController } from './SceneTriangleAndReadinessController';
import type { ScenePickingAndSelectionController } from './ScenePickingAndSelectionController';
import type { SceneTelemetryController } from './SceneTelemetryController';
import type { SceneWorldBoundsController } from './SceneWorldBoundsController';
import type { SceneDocumentController } from './SceneDocumentController';
import type { SceneTransformPreviewController } from './SceneTransformPreviewController';
import { type ModelRuntimeEntry, type ModelArrayParameterVariantRuntimeEntry, type SceneRuntimeModelArrayIdentityMode } from './sceneRuntimeTypes';

/** 此领域仅能访问明确列出的协作能力，资源与缓存由所属 Controller 持有。 */
type Dependencies = {
  readonly assets: Pick<ModelAssetRuntimeController, 'models' | 'applyModelInteractivity' | 'suspendModelArrayHost' | 'restoreModelArrayHostMeshes' | 'refreshModelMeshes' | 'refreshModelEntityMeshes'>;
  readonly variants: Pick<ParameterVariantHostPool, 'disposeModelArrayParameterVariantsForSource' | 'modelArrayParameterVariantByEntityId' | 'rekeyReusableModelArrayParameterVariant' | 'syncModelArrayParameterVariant' | 'modelArrayParameterVariants' | 'disposeMissingModelArrayParameterVariants' | 'restoreModelArrayParameterVariantHost' | 'hideModelArrayParameterVariantHost'>;
  readonly presentation: Pick<SceneMeshPresentationController, 'applyTransform' | 'syncConveyorTrajectoriesForArrayInstances'>;
  readonly readiness: Pick<SceneTriangleAndReadinessController, 'modelReadinessErrors'>;
  readonly selection: Pick<ScenePickingAndSelectionController, 'rebuildModelSelectionOutline' | 'outlinedModelArrayBatches'>;
  readonly telemetry: Pick<SceneTelemetryController, 'motionStaticBatchRuntime'>;
  readonly bounds: Pick<SceneWorldBoundsController, 'isModelBoundsMesh'>;
  readonly document: Pick<SceneDocumentController, 'isEntityVisible' | 'isEntityScenePickable'>;
  readonly transforms: Pick<SceneTransformPreviewController, 'refreshGroupTransformPreviewTargets'>;
};


/** ModelArrayRuntimeController 的资源、状态及取消/释放操作在同一领域内维护。 */
export class ModelArrayRuntimeController {
  constructor(private readonly context: SceneRuntimeContext, private readonly dependencies: Dependencies) {}

  /** 阵列副本保留完整 Scene Entity；相同参数组合共享一个脚本宿主，而不是逐实体加载模型。 */
  public readonly modelArrayInstanceEntities = new Map<string, Entity>();
  /** 合批 conveyor 实例的遥测代理（key=实例实体 ID）：无几何，仅承载设备身份与遥测状态。 */
  public readonly modelArrayTelemetryProxies = new Map<string, ModelRuntimeEntry>();
  public readonly pendingModelArraySourceResyncs = new Map<string, string | null>();
  public readonly pendingModelArrayVariantRenderSuppressions = new Set<TransformNode>();
  public readonly suppressedModelArrayVariantRootsThisFrame = new Set<TransformNode>();
  public readonly modelArrayJsonSignatureCache = new WeakMap<object, string>();
  public readonly modelArrayTransientJsonSignatureCache = new WeakMap<object, string>();
  public readonly modelArrayCanonicalSignatureIds = new Map<string, number>();
  public modelArrayCanonicalSignatureSequence = 0;
  public readonly modelArrayBatchByMeshUniqueId = new Map<number, EntityArrayThinInstanceBatch>();
  public modelArrayVariantRenderSuppressionObserver!: Nullable<Observer<Scene>>;
  public modelArrayVariantRenderRestoreObserver!: Nullable<Observer<Scene>>;
  public modelArrayIdentityMode: SceneRuntimeModelArrayIdentityMode = 'device';

  /** 在文档实体完成同步后，按源模型统一刷新全部独立逻辑实例的矩阵批次。 */
  public syncAllModelArrayBatches(
    document: SceneDocument,
    sourceEntityIds: ReadonlySet<string>,
    parameterOnlyChangedEntityId?: string,
  ): void {
    for (const sourceEntityId of sourceEntityIds) {
      const model = this.dependencies.assets.models.get(sourceEntityId);
      if (!model) continue;
      const sourceEntity = document.entities[sourceEntityId];
      if (!sourceEntity?.components.modelAsset || sourceEntity.components.modelArrayInstance) {
        this.disposeModelArrayBatch(model);
        this.dependencies.variants.disposeModelArrayParameterVariantsForSource(sourceEntityId);
        continue;
      }
      this.syncModelArrayBatch(sourceEntity, model, parameterOnlyChangedEntityId);
    }
  }

  /**
   * 合批 conveyor 只失去渲染身份，不失去设备身份：为每台启用遥测的非代表实例维护一个
   * 无几何遥测代理（独立 assetCode/binding/遥测状态），几何查询经 telemetryProxySource
   * 换算回宿主模型，链路协议与货物走行无需拆批即可逐设备运行。
   */
  public syncModelArrayTelemetryProxies(): void {
    const desired = new Map<string, { entity: Entity; host: ModelRuntimeEntry }>();
    for (const instanceEntity of this.modelArrayInstanceEntities.values()) {
      const modelAsset = instanceEntity.components.modelAsset;
      const binding = instanceEntity.components.telemetryBinding;
      // 无显式绑定的实例与真实模型一致：按 assetCode 走默认绑定解析，不得跳过代理创建。
      // 禁用遥测仍可进行箭头编辑预览；专用绑定解析继续阻止其真实设备驱动。
      if (!modelAsset || (binding?.enabled === false && binding.surfaceArrows?.enabled === false)) continue;
      // devType 归一化在导入边界已统一小写；文件名关键词识别兜底未声明 devType 的旧包。
      const devType = modelAsset.dataDrivenConfig?.device?.devType?.trim().toLowerCase();
      if (devType !== 'conveyor' && !isConveyorModelAsset(modelAsset)) continue;

      const variant = this.dependencies.variants.modelArrayParameterVariantByEntityId.get(instanceEntity.id);
      if (variant) {
        // 变体代表机的位姿与身份由变体宿主模型直接承载，无需代理。
        if (variant.representativeEntityId === instanceEntity.id) continue;
        desired.set(instanceEntity.id, { entity: instanceEntity, host: variant.model });
        continue;
      }

      // 未映射变体：与源同签名说明由源批次承载；签名不同则参数变体宿主尚未就绪，等重同步后再建代理。
      const sourceEntityId = instanceEntity.components.modelArrayInstance?.sourceEntityId;
      const sourceModel = sourceEntityId ? this.dependencies.assets.models.get(sourceEntityId) : null;
      const sourceEntity = sourceModel?.entitySnapshot ?? null;
      const sourceModelAsset = sourceEntity?.components.modelAsset;
      if (!sourceModel || !sourceEntity || !sourceModelAsset) continue;
      if (
        this.createModelArrayRenderSignature(modelAsset, binding)
        !== this.createModelArrayRenderSignature(sourceModelAsset, sourceEntity.components.telemetryBinding)
      ) {
        continue;
      }
      desired.set(instanceEntity.id, { entity: instanceEntity, host: sourceModel });
    }

    for (const [entityId, proxy] of [...this.modelArrayTelemetryProxies.entries()]) {
      const target = desired.get(entityId);
      if (!target || proxy.telemetryProxySource !== target.host) {
        this.disposeModelArrayTelemetryProxy(entityId, proxy);
      }
    }
    for (const [entityId, target] of desired) {
      const proxy = this.modelArrayTelemetryProxies.get(entityId)
        ?? this.createModelArrayTelemetryProxy(target.entity, target.host);
      proxy.entitySnapshot = target.entity;
      proxy.assetCode = target.entity.components.modelAsset?.assetCode ?? proxy.assetCode;
      proxy.telemetryBinding = target.entity.components.telemetryBinding ?? null;
      this.dependencies.presentation.applyTransform(proxy.root, target.entity.components.transform);
    }
  }

  /** 创建合批 conveyor 实例的遥测代理：加载/就绪门控通过访问器跟随宿主，避免异步时序两处各写一份。 */
  public createModelArrayTelemetryProxy(entity: Entity, host: ModelRuntimeEntry): ModelRuntimeEntry {
    const modelAsset = entity.components.modelAsset;
    const root = new TransformNode(`__telemetryProxy_${sanitizeBabylonName(entity.id)}`, this.context.scene);
    const contentRoot = new TransformNode(`__telemetryProxyContent_${sanitizeBabylonName(entity.id)}`, this.context.scene);
    contentRoot.parent = root;
    this.dependencies.presentation.applyTransform(root, entity.components.transform);

    const proxy: ModelRuntimeEntry = {
      sourceUrl: modelAsset?.sourceUrl ?? host.sourceUrl,
      assetRevision: modelAsset?.assetRevision ?? null,
      assetSignature: host.assetSignature,
      entitySnapshot: entity,
      assetCode: modelAsset?.assetCode ?? '',
      telemetryBinding: entity.components.telemetryBinding ?? null,
      stackerCapable: false,
      conveyorCapable: true,
      rgvCapable: false,
      liftCapable: false,
      root,
      contentRoot,
      assetHandle: null,
      meshes: [],
      modelArraySuspendedMeshes: new Set(),
      modelArrayBatch: null,
      modelArraySourceSignature: '',
      modelArrayFailureSignature: '',
      highlighted: false,
      loadToken: 0,
      cancelLoad: null,
      parameterSignature: '',
      parameterBaseline: new Map(),
      textureCache: new Map(),
      externalScriptRuntime: null,
      externalScriptSignature: '',
      externalScriptStarting: false,
      measurementReady: true,
      stackerTelemetry: createStackerTelemetryState(root),
      conveyorTelemetry: createConveyorTelemetryState(),
      rgvTelemetry: createRgvTelemetryState(root),
      shuttleTelemetry: createShuttleTelemetryState(root),
      liftTelemetry: createLiftTelemetryState(root),
      hcliftTelemetry: createHcliftTelemetryState(root),
      stackerTelemetryReady: false,
      telemetryPreviewBaseline: null,
      telemetryProxySource: host,
    };
    Object.defineProperty(proxy, 'assetHandle', { get: () => host.assetHandle });
    Object.defineProperty(proxy, 'stackerTelemetryReady', { get: () => host.stackerTelemetryReady });
    this.modelArrayTelemetryProxies.set(entity.id, proxy);
    return proxy;
  }

  /** 销毁遥测代理：代理自身没有网格与资产，只释放位姿节点子树。 */
  public disposeModelArrayTelemetryProxy(entityId: string, proxy: ModelRuntimeEntry): void {
    if (this.modelArrayTelemetryProxies.get(entityId) !== proxy) return;
    this.modelArrayTelemetryProxies.delete(entityId);
    if (!proxy.root.isDisposed()) proxy.root.dispose(false, false);
  }

  /**
   * 将引用同一源模型的 N 个独立 Scene Entity 一次性提交为 thinInstance 矩阵。
   * 每个实体继续拥有独立名称、资产编号、Transform、显隐、锁定、删除和选择语义。
   */
  public syncModelArrayBatch(
    entity: Entity,
    model: ModelRuntimeEntry,
    parameterOnlyChangedEntityId?: string,
  ): void {
    const modelAsset = entity.components.modelAsset;
    if (!modelAsset) return;

    const instanceEntities = [...this.modelArrayInstanceEntities.values()]
      .filter((instanceEntity) => (
        instanceEntity.components.modelArrayInstance?.sourceEntityId === entity.id
      ));
    const legacyItems = entity.components.modelArray?.items ?? [];
    if (instanceEntities.length === 0 && legacyItems.length === 0) {
      for (const [key, failure] of this.dependencies.readiness.modelReadinessErrors) {
        if (key.startsWith('variant:') && failure.entityIds[0] === entity.id) this.dependencies.readiness.modelReadinessErrors.delete(key);
      }
      this.disposeModelArrayBatch(model);
      this.dependencies.variants.disposeModelArrayParameterVariantsForSource(entity.id);
      model.modelArrayFailureSignature = '';
      this.dependencies.assets.applyModelInteractivity(model, entity.id);
      return;
    }

    const previousVariantByEntityId = new Map<string, ModelArrayParameterVariantRuntimeEntry>();
    for (const instanceEntity of instanceEntities) {
      const previousVariant = this.dependencies.variants.modelArrayParameterVariantByEntityId.get(instanceEntity.id);
      if (previousVariant?.model.modelArrayBatch?.hasEntityId(instanceEntity.id)) {
        previousVariantByEntityId.set(instanceEntity.id, previousVariant);
      }
    }

    const sourceRenderSignature = this.createModelArrayRenderSignature(
      modelAsset,
      entity.components.telemetryBinding,
    );
    const groups = new Map<string, Entity[]>();
    for (const instanceEntity of instanceEntities) {
      const instanceModelAsset = instanceEntity.components.modelAsset;
      const renderSignature = instanceModelAsset
        ? this.createModelArrayRenderSignature(instanceModelAsset, instanceEntity.components.telemetryBinding)
        : sourceRenderSignature;
      const group = groups.get(renderSignature) ?? [];
      group.push(instanceEntity);
      groups.set(renderSignature, group);
    }

    const baseInstances = groups.get(sourceRenderSignature) ?? [];
    groups.delete(sourceRenderSignature);
    const activeVariantKeys = new Set<string>();
    const targetVariantByEntityId = new Map<string, ModelArrayParameterVariantRuntimeEntry>();
    for (const [renderSignature, entities] of groups) {
      const key = this.createModelArrayParameterVariantKey(entity.id, renderSignature);
      this.dependencies.variants.rekeyReusableModelArrayParameterVariant(entity.id, key, renderSignature, entities, activeVariantKeys);
      activeVariantKeys.add(key);
      const variant = this.dependencies.variants.syncModelArrayParameterVariant(
        entity,
        key,
        renderSignature,
        entities,
        parameterOnlyChangedEntityId && entities.some((item) => item.id === parameterOnlyChangedEntityId)
          ? parameterOnlyChangedEntityId
          : undefined,
      );
      if (!variant) continue;
      for (const instanceEntity of entities) targetVariantByEntityId.set(instanceEntity.id, variant);
    }

    // 参数回到基础模型或另一参数组后，旧变体失败不再属于当前场景要求。
    for (const [key, failure] of this.dependencies.readiness.modelReadinessErrors) {
      if (key.startsWith('variant:') && failure.entityIds[0] === entity.id && !activeVariantKeys.has(key.slice('variant:'.length))) {
        this.dependencies.readiness.modelReadinessErrors.delete(key);
      }
    }
    const renderEntitiesByVariant = new Map<ModelArrayParameterVariantRuntimeEntry, Entity[]>();
    const renderEntityIdsByVariant = new Map<ModelArrayParameterVariantRuntimeEntry, Set<string>>();
    const fallbackBaseInstances: Entity[] = [];
    const retainedVariantKeys = new Set(activeVariantKeys);
    const appendVariantEntity = (variant: ModelArrayParameterVariantRuntimeEntry, instanceEntity: Entity): void => {
      const renderEntityIds = renderEntityIdsByVariant.get(variant) ?? new Set<string>();
      if (renderEntityIds.has(instanceEntity.id)) return;
      renderEntityIds.add(instanceEntity.id);
      renderEntityIdsByVariant.set(variant, renderEntityIds);
      const renderEntities = renderEntitiesByVariant.get(variant) ?? [];
      renderEntities.push(instanceEntity);
      renderEntitiesByVariant.set(variant, renderEntities);
      retainedVariantKeys.add(variant.key);
    };

    for (const instanceEntity of instanceEntities) {
      const targetVariant = targetVariantByEntityId.get(instanceEntity.id);
      if (!targetVariant) continue;
      if (this.isModelArrayBatchCurrent(targetVariant.model, targetVariant.renderSignature)) {
        appendVariantEntity(targetVariant, instanceEntity);
        continue;
      }

      const previousVariant = previousVariantByEntityId.get(instanceEntity.id);
      if (previousVariant?.model.modelArrayBatch?.hasEntityId(instanceEntity.id)) {
        appendVariantEntity(previousVariant, instanceEntity);
      } else if (model.modelArrayBatch?.hasEntityId(instanceEntity.id)) {
        fallbackBaseInstances.push(instanceEntity);
      }
    }

    const baseBatchCurrent = this.isModelArrayBatchCurrent(model, sourceRenderSignature);
    const mustKeepPreviousBaseBatch = !baseBatchCurrent && fallbackBaseInstances.length > 0;
    if (mustKeepPreviousBaseBatch) {
      for (const baseInstance of baseInstances) {
        const previousVariant = previousVariantByEntityId.get(baseInstance.id);
        if (previousVariant?.model.modelArrayBatch?.hasEntityId(baseInstance.id)) {
          appendVariantEntity(previousVariant, baseInstance);
        }
      }
    }

    for (const variant of this.dependencies.variants.modelArrayParameterVariants.values()) {
      if (variant.sourceEntityId !== entity.id) continue;
      const targetEntities = variant.entities.filter((instanceEntity) => (
        targetVariantByEntityId.get(instanceEntity.id) === variant
        && this.isModelArrayBatchCurrent(variant.model, variant.renderSignature)
      ));
      for (const targetEntity of targetEntities) appendVariantEntity(variant, targetEntity);
    }

    for (const [variant, renderEntities] of renderEntitiesByVariant) {
      if (!this.isModelArrayBatchCurrent(variant.model, variant.renderSignature)) continue;
      const representative = variant.entities.find((item) => item.id === variant.representativeEntityId)
        ?? variant.entities[0]
        ?? renderEntities[0];
      if (!representative) continue;
      this.syncModelArrayBatchForEntities(representative, variant.model, renderEntities, [], {
        sourceEntityId: variant.sourceEntityId,
        namePrefix: '__modelArrayParameterVariantThinInstance',
        variantKey: variant.key,
        renderSignature: variant.renderSignature,
        resolveLayerMask: (mesh) => variant.sourceLayerMasks.get(mesh.uniqueId) ?? mesh.layerMask,
        parameterOnlyChangedEntityId,
      });
    }

    if (!mustKeepPreviousBaseBatch) {
      const baseRenderEntities: Entity[] = [];
      const baseRenderEntityIds = new Set<string>();
      for (const renderEntity of [entity, ...baseInstances, ...fallbackBaseInstances]) {
        if (baseRenderEntityIds.has(renderEntity.id)) continue;
        baseRenderEntityIds.add(renderEntity.id);
        baseRenderEntities.push(renderEntity);
      }
      this.syncModelArrayBatchForEntities(entity, model, baseRenderEntities, legacyItems, {
        sourceEntityId: entity.id,
        namePrefix: '__modelArrayThinInstance',
        renderSignature: sourceRenderSignature,
        parameterOnlyChangedEntityId,
      });
    } else {
      // 源参数已变化而副本的旧参数宿主尚未 ready：完整保留旧批次，等待新宿主就绪后原子切换。
      this.dependencies.assets.suspendModelArrayHost(model);
    }

    for (const [entityId, variant] of this.dependencies.variants.modelArrayParameterVariantByEntityId) {
      if (variant.sourceEntityId === entity.id) this.dependencies.variants.modelArrayParameterVariantByEntityId.delete(entityId);
    }
    for (const instanceEntity of instanceEntities) {
      const targetVariant = targetVariantByEntityId.get(instanceEntity.id);
      if (targetVariant?.model.modelArrayBatch?.hasEntityId(instanceEntity.id)
        && this.isModelArrayBatchCurrent(targetVariant.model, targetVariant.renderSignature)) {
        this.dependencies.variants.modelArrayParameterVariantByEntityId.set(instanceEntity.id, targetVariant);
        continue;
      }
      const previousVariant = previousVariantByEntityId.get(instanceEntity.id);
      if (previousVariant?.model.modelArrayBatch?.hasEntityId(instanceEntity.id)
        && (Boolean(targetVariant) || mustKeepPreviousBaseBatch)) {
        this.dependencies.variants.modelArrayParameterVariantByEntityId.set(instanceEntity.id, previousVariant);
      }
    }

    this.dependencies.variants.disposeMissingModelArrayParameterVariants(entity.id, retainedVariantKeys);
    this.dependencies.presentation.syncConveyorTrajectoriesForArrayInstances(entity.id);
  }

  /** 编辑态资产编号不影响外观；运行态仅对启用遥测的真实阵列按设备身份隔离宿主。 */
  public createModelArrayRenderSignature(
    modelAsset: ModelAssetComponent,
    telemetryBinding: TelemetryBindingComponent | null | undefined = null,
  ): string {
    const telemetryIdentity = this.modelArrayIdentityMode === 'device'
      && telemetryBinding
      && telemetryBinding.enabled !== false
      ? {
          assetCode: modelAsset.assetCode,
          binding: this.createModelArrayJsonSignature(telemetryBinding),
        }
      : null;
    return JSON.stringify({
      sourcePath: modelAsset.sourcePath,
      sourceUrl: modelAsset.sourceUrl,
      assetRevision: modelAsset.assetRevision ?? null,
      lengthUnit: modelAsset.lengthUnit,
      unitScaleToMeters: modelAsset.unitScaleToMeters,
      instancingMode: resolveModelAssetSharedInstancingPolicy(modelAsset).mode,
      scripts: (modelAsset.scriptAssets ?? []).map((script) => ({
        path: script.path,
        name: script.name,
        source: this.createModelArrayCanonicalStringSignature(script.sourceUrl),
      })),
      parameterScripts: this.createModelArrayJsonSignature(modelAsset.parameterScriptMetadata),
      animationScripts: this.createModelArrayJsonSignature(modelAsset.animationScriptMetadata),
      parameterConfig: this.createModelArrayJsonSignature(modelAsset.parameterConfig),
      parameterValues: this.createModelArrayTransientJsonSignature(modelAsset.parameterValues),
      dataDrivenConfig: this.createModelArrayJsonSignature(modelAsset.dataDrivenConfig),
      telemetryIdentity,
    });
  }

  /** 参数值可能随滑块持续变化，不进入长期驻留缓存，避免编辑会话内无界增长。 */
  public createModelArrayTransientJsonSignature(value: unknown): string {
    if (value === undefined) return '-';
    if (value !== null && typeof value === 'object') {
      const cached = this.modelArrayTransientJsonSignatureCache.get(value);
      if (cached) return cached;
      const signature = this.serializeModelArrayJsonValue(value);
      this.modelArrayTransientJsonSignatureCache.set(value, signature);
      return signature;
    }
    return this.serializeModelArrayJsonValue(value);
  }

  /** 对不可变 JSON 快照缓存精确的场景内编号，既避免大字符串重复拼接，也不存在哈希碰撞。 */
  public createModelArrayJsonSignature(value: unknown): string {
    if (value === undefined) return '-';
    if (value !== null && typeof value === 'object') {
      const cached = this.modelArrayJsonSignatureCache.get(value);
      if (cached) return cached;
      const signature = this.createModelArrayCanonicalStringSignature(this.serializeModelArrayJsonValue(value));
      this.modelArrayJsonSignatureCache.set(value, signature);
      return signature;
    }
    return this.createModelArrayCanonicalStringSignature(this.serializeModelArrayJsonValue(value));
  }

  public serializeModelArrayJsonValue(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
    if (Array.isArray(value)) return `[${value.map((item) => this.serializeModelArrayJsonValue(item)).join(',')}]`;

    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${this.serializeModelArrayJsonValue(record[key])}`)
      .join(',')}}`;
  }

  public createModelArrayCanonicalStringSignature(value: string): string {
    const existingId = this.modelArrayCanonicalSignatureIds.get(value);
    if (existingId !== undefined) return `s${existingId}`;
    const nextId = ++this.modelArrayCanonicalSignatureSequence;
    this.modelArrayCanonicalSignatureIds.set(value, nextId);
    return `s${nextId}`;
  }

  public createModelArrayParameterVariantKey(sourceEntityId: string, renderSignature: string): string {
    return `${sourceEntityId}\u0000${renderSignature}`;
  }

  /** 脚本异步刷新期间只保留宿主的脚本可见性，禁止它和上一份有效批次同时参与绘制。 */
  public beginModelArrayHostRenderSuppression(model: ModelRuntimeEntry): void {
    if (!model.root.isDisposed()) this.pendingModelArrayVariantRenderSuppressions.add(model.root);
  }

  /** 脚本完成并原子提交新批次后，结束宿主的逐帧渲染屏蔽。 */
  public endModelArrayHostRenderSuppression(model: ModelRuntimeEntry): void {
    const root = model.root;
    this.pendingModelArrayVariantRenderSuppressions.delete(root);
    if (this.suppressedModelArrayVariantRootsThisFrame.delete(root) && !root.isDisposed()) {
      root.setEnabled(true);
    }
  }

  /** 在 onBeforeActiveMeshesEvaluation 中临时禁用 pending 宿主；脚本编译和生命周期在帧间仍读取完整启用状态。 */
  public suppressPendingModelArrayVariantHostsForRender(): void {
    this.restoreSuppressedModelArrayVariantHostsAfterRender();
    for (const root of this.pendingModelArrayVariantRenderSuppressions) {
      if (root.isDisposed() || !root.isEnabled(false)) continue;
      root.setEnabled(false);
      this.suppressedModelArrayVariantRootsThisFrame.add(root);
    }
  }

  /** 每帧渲染完成后立即恢复宿主，避免临时渲染状态污染参数脚本基线。 */
  public restoreSuppressedModelArrayVariantHostsAfterRender(): void {
    for (const root of this.suppressedModelArrayVariantRootsThisFrame) {
      if (!root.isDisposed()) root.setEnabled(true);
    }
    this.suppressedModelArrayVariantRootsThisFrame.clear();
  }

  /** 参数变体异步 ready 后合并同一源的多次请求，并在微任务中完成最终原子换批。 */
  public scheduleModelArraySourceResync(
    sourceEntityId: string,
    parameterOnlyChangedEntityId?: string,
  ): void {
    const nextChangedEntityId = parameterOnlyChangedEntityId ?? null;
    if (this.pendingModelArraySourceResyncs.has(sourceEntityId)) {
      const pendingChangedEntityId = this.pendingModelArraySourceResyncs.get(sourceEntityId) ?? null;
      if (pendingChangedEntityId !== nextChangedEntityId) {
        // 同一微任务窗口内出现不同变化来源时不能再假设只有一个参数实体变化。
        this.pendingModelArraySourceResyncs.set(sourceEntityId, null);
      }
      return;
    }

    this.pendingModelArraySourceResyncs.set(sourceEntityId, nextChangedEntityId);
    queueMicrotask(() => {
      const changedEntityId = this.pendingModelArraySourceResyncs.get(sourceEntityId) ?? undefined;
      this.pendingModelArraySourceResyncs.delete(sourceEntityId);
      const sourceModel = this.dependencies.assets.models.get(sourceEntityId);
      const sourceEntity = sourceModel?.entitySnapshot;
      if (!sourceModel || !sourceEntity?.components.modelAsset || sourceEntity.components.modelArrayInstance) return;
      this.syncModelArrayBatch(sourceEntity, sourceModel, changedEntityId);
      this.syncModelArrayTelemetryProxies();
      this.dependencies.selection.rebuildModelSelectionOutline();
    });
  }

  /** 在运行态脚本或遥测修改前恢复当前阵列宿主；返回是否需要在修改后重提批次。 */
  public prepareModelArrayRuntimeMutation(model: ModelRuntimeEntry): boolean {
    if (!model.modelArrayBatch && model.modelArraySuspendedMeshes.size === 0) return false;
    const variant = [...this.dependencies.variants.modelArrayParameterVariants.values()].find((item) => item.model === model);
    if (variant) this.dependencies.variants.restoreModelArrayParameterVariantHost(variant);
    this.dependencies.assets.restoreModelArrayHostMeshes(model);
    model.root.setEnabled(true);
    return true;
  }

  /**
   * 运行态脚本/遥测可能改变 Transform、显隐、材质或增删 Mesh；重新收集宿主并更新当前参数组，
   * Geometry/网格集合未变时仅改写矩阵和材质，不重复创建批次。
   */
  public refreshModelArrayRuntimeRepresentation(model: ModelRuntimeEntry): void {
    if (!model.modelArrayBatch && model.modelArraySuspendedMeshes.size === 0) return;
    const variant = [...this.dependencies.variants.modelArrayParameterVariants.values()].find((item) => item.model === model);
    if (variant) {
      const activeVariant = this.dependencies.variants.modelArrayParameterVariants.get(variant.key);
      if (!activeVariant || activeVariant.model !== model) return;
      const representative = activeVariant.entities.find((entity) => entity.id === activeVariant.representativeEntityId)
        ?? activeVariant.entities[0];
      if (!representative) return;
      this.dependencies.assets.refreshModelMeshes(model, {
        modelArrayParameterVariant: true,
        modelArraySourceEntityId: activeVariant.sourceEntityId,
      });
      this.dependencies.variants.hideModelArrayParameterVariantHost(activeVariant);
      this.syncModelArrayBatchForEntities(representative, model, activeVariant.entities, [], {
        sourceEntityId: activeVariant.sourceEntityId,
        namePrefix: '__modelArrayParameterVariantThinInstance',
        variantKey: activeVariant.key,
        renderSignature: activeVariant.renderSignature,
        resolveLayerMask: (mesh) => activeVariant.sourceLayerMasks.get(mesh.uniqueId) ?? mesh.layerMask,
      });
      for (const entity of activeVariant.entities) Reflect.apply(this.context.onModelMeasurementChanged, this.context.callbackReceiver, [entity.id]);
      return;
    }

    const entity = model.entitySnapshot;
    const modelAsset = entity?.components.modelAsset;
    if (!entity || !modelAsset || entity.components.modelArrayInstance) return;
    this.dependencies.assets.refreshModelEntityMeshes(entity, model);
    const sourceRenderSignature = this.createModelArrayRenderSignature(
      modelAsset,
      entity.components.telemetryBinding,
    );
    const baseInstances = [...this.modelArrayInstanceEntities.values()].filter((instanceEntity) => {
      if (instanceEntity.components.modelArrayInstance?.sourceEntityId !== entity.id) return false;
      const instanceAsset = instanceEntity.components.modelAsset;
      return !instanceAsset || this.createModelArrayRenderSignature(
        instanceAsset,
        instanceEntity.components.telemetryBinding,
      ) === sourceRenderSignature;
    });
    this.syncModelArrayBatchForEntities(
      entity,
      model,
      [entity, ...baseInstances],
      entity.components.modelArray?.items ?? [],
      {
        sourceEntityId: entity.id,
        namePrefix: '__modelArrayThinInstance',
        renderSignature: sourceRenderSignature,
      },
    );
    Reflect.apply(this.context.onModelMeasurementChanged, this.context.callbackReceiver, [entity.id]);
    for (const instanceEntity of baseInstances) Reflect.apply(this.context.onModelMeasurementChanged, this.context.callbackReceiver, [instanceEntity.id]);
  }

  /** 判断当前批次是否已经承载给定视觉签名的完整 Geometry。 */
  public isModelArrayBatchCurrent(model: ModelRuntimeEntry, renderSignature: string): boolean {
    return Boolean(
      model.modelArrayBatch
      && model.modelArraySourceSignature.startsWith(`${renderSignature}|representation:original-geometry|`),
    );
  }

  /** 基础源和参数变体共用的矩阵批次提交路径。 */
  public syncModelArrayBatchForEntities(
    entity: Entity,
    model: ModelRuntimeEntry,
    instanceEntities: readonly Entity[],
    legacyItems: ReadonlyArray<NonNullable<Entity['components']['modelArray']>['items'][number]>,
    options: {
      sourceEntityId: string;
      namePrefix: string;
      renderSignature: string;
      variantKey?: string;
      resolveLayerMask?: (mesh: AbstractMesh) => number;
      parameterOnlyChangedEntityId?: string;
    },
  ): void {
    const totalInstanceCount = instanceEntities.length + legacyItems.length;
    if (totalInstanceCount === 0) {
      this.disposeModelArrayBatch(model);
      model.modelArrayFailureSignature = '';
      if (options.variantKey) this.dependencies.assets.suspendModelArrayHost(model);
      else this.dependencies.assets.applyModelInteractivity(model, entity.id);
      return;
    }
    if (!model.assetHandle || !model.measurementReady) return;

    // 整机阵列接管前先归还动静批次的原件。不能在 onSettled 之后再恢复，否则会把已挂起的宿主重新加入场景。
    this.dependencies.telemetry.motionStaticBatchRuntime.markModelDirty(model);

    // 必须与聚焦/测量共用同一份有效可见几何：参数脚本关闭部件后，隐藏 Mesh 不能继续留在阵列批次中。
    // 有效集合变化会同步改变 sourceSignature，避免参数快速路径复用包含旧几何的批次。
    const sourceMeshes = model.meshes.filter((mesh) => this.dependencies.bounds.isModelBoundsMesh(model, mesh));
    const hasSourceGeometry = model.meshes.some((mesh) => (
      !mesh.isDisposed() && mesh.getTotalVertices() > 0
    ));
    // 批次 Geometry 与脚本宿主隔离；参数或脚本输入变化时必须重建，才能复制最新顶点数据。
    const sourceSignature = `${options.renderSignature}|representation:original-geometry|${sourceMeshes
      .map((mesh) => `${mesh.uniqueId}:${mesh.geometry?.uniqueId ?? 0}:${mesh instanceof Mesh ? mesh.thinInstanceCount : 0}`)
      .join('|')}`;
    const failureSignature = `${options.variantKey ?? 'base'}:${sourceSignature}:${totalInstanceCount}`;

    if (sourceMeshes.length === 0) {
      // 全部原始几何仍存在但被参数脚本隐藏时，旧批次会与聚焦 bounds 脱节，必须立即移除。
      if (hasSourceGeometry) {
        this.disposeModelArrayBatch(model);
        this.dependencies.assets.suspendModelArrayHost(model);
        model.modelArrayFailureSignature = '';
        return;
      }
      if (model.modelArrayBatch) this.dependencies.assets.suspendModelArrayHost(model);
      else if (options.variantKey) this.dependencies.assets.suspendModelArrayHost(model);
      else this.dependencies.assets.applyModelInteractivity(model, entity.id);
      this.reportModelArrayBatchFailure(entity, model, failureSignature, '参数脚本执行后没有可渲染 Mesh，已保留上一份有效阵列');
      return;
    }

    const parameterOnlyChangedEntityId = options.parameterOnlyChangedEntityId;
    if (
      parameterOnlyChangedEntityId
      && model.modelArrayBatch
      && model.modelArraySourceSignature === sourceSignature
    ) {
      const shouldContainChangedEntity = instanceEntities.some((instance) => (
        instance.id === parameterOnlyChangedEntityId && this.dependencies.document.isEntityVisible(instance.id)
      )) || (
        legacyItems.length > 0
        && entity.id === parameterOnlyChangedEntityId
        && this.dependencies.document.isEntityVisible(entity.id)
      );
      if (model.modelArrayBatch.hasEntityId(parameterOnlyChangedEntityId) === shouldContainChangedEntity) {
        // 参数值变化未改变当前批次成员、Transform、显隐或拾取状态，复用既有 GPU 矩阵缓冲。
        model.modelArrayFailureSignature = '';
        this.dependencies.assets.suspendModelArrayHost(model);
        this.dependencies.transforms.refreshGroupTransformPreviewTargets();
        return;
      }
    }

    const visibleInstances = instanceEntities
      .filter((instanceEntity) => this.dependencies.document.isEntityVisible(instanceEntity.id))
      .map((instanceEntity) => ({
        entityId: instanceEntity.id,
        transform: instanceEntity.components.transform,
        pickable: this.dependencies.document.isEntityScenePickable(instanceEntity.id),
      }));
    // 兼容尚未经过反序列化迁移的内存场景；旧隐藏项继续映射回源实体。
    for (const item of legacyItems) {
      if (!this.dependencies.document.isEntityVisible(entity.id)) continue;
      visibleInstances.push({
        entityId: entity.id,
        transform: {
          ...entity.components.transform,
          position: {
            x: entity.components.transform.position.x + item.offset.x,
            y: entity.components.transform.position.y + item.offset.y,
            z: entity.components.transform.position.z + item.offset.z,
          },
        },
        pickable: this.dependencies.document.isEntityScenePickable(entity.id),
      });
    }

    model.root.computeWorldMatrix(true);
    if (!model.modelArrayBatch || model.modelArraySourceSignature !== sourceSignature) {
      let candidate: EntityArrayThinInstanceBatch | null = null;
      try {
        candidate = EntityArrayThinInstanceBatch.create(options.sourceEntityId, sourceMeshes, {
          interactive: true,
          mergeStaticMeshesByMaterial: true,
          sourceRootWorldMatrix: model.root.getWorldMatrix().clone(),
          metadata: {
            modelArraySourceEntityId: options.sourceEntityId,
            ...(options.variantKey ? { modelArrayParameterVariant: true } : {}),
          },
          namePrefix: options.namePrefix,
          resolveLayerMask: options.resolveLayerMask,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        Reflect.apply(this.context.pushLog, this.context.callbackReceiver, [`模型“${entity.name}”阵列批次创建失败：${message}`]);
      }

      if (!candidate || !candidate.updateEntityTransforms(model.root.getWorldMatrix().clone(), visibleInstances)) {
        candidate?.dispose();
        if (model.modelArrayBatch) this.dependencies.assets.suspendModelArrayHost(model);
        else if (options.variantKey) this.dependencies.assets.suspendModelArrayHost(model);
        else this.dependencies.assets.applyModelInteractivity(model, entity.id);
        this.reportModelArrayBatchFailure(
          entity,
          model,
          failureSignature,
          candidate
            ? '矩阵数量超过保护上限、Transform 非法或参数脚本输出 Mesh 不支持批量实例，已保留上一份有效阵列'
            : '参数脚本输出 Mesh 不支持批量实例，已保留上一份有效阵列',
        );
        return;
      }

      const previousBatch = model.modelArrayBatch;
      model.modelArrayBatch = candidate;
      model.modelArraySourceSignature = sourceSignature;
      for (const mesh of candidate.meshes) this.modelArrayBatchByMeshUniqueId.set(mesh.uniqueId, candidate);
      if (previousBatch) this.disposeModelArrayBatchResources(previousBatch);
    } else if (!model.modelArrayBatch.updateEntityTransforms(model.root.getWorldMatrix().clone(), visibleInstances)) {
      this.dependencies.assets.suspendModelArrayHost(model);
      this.reportModelArrayBatchFailure(
        entity,
        model,
        failureSignature,
        '矩阵数量超过保护上限、Transform 非法或参数脚本输出 Mesh 不支持批量实例，已保留上一份有效阵列',
      );
      return;
    }

    for (const mesh of model.modelArrayBatch.meshes) {
      this.modelArrayBatchByMeshUniqueId.set(mesh.uniqueId, model.modelArrayBatch);
    }
    model.modelArrayFailureSignature = '';
    this.dependencies.assets.suspendModelArrayHost(model);
    this.dependencies.transforms.refreshGroupTransformPreviewTargets();
  }

  /** 同一失败形态只记录一次，避免场景同步循环刷屏。 */
  public reportModelArrayBatchFailure(
    entity: Entity,
    model: ModelRuntimeEntry,
    failureSignature: string,
    reason: string,
  ): void {
    if (model.modelArrayFailureSignature === failureSignature) return;
    model.modelArrayFailureSignature = failureSignature;
    Reflect.apply(this.context.pushLog, this.context.callbackReceiver, [`模型“${entity.name}”矩阵阵列创建失败：${reason}。`]);
  }

  /** 释放一个正式矩阵阵列批次的隔离 Geometry，但保留源模型几何、材质和纹理。 */
  public disposeModelArrayBatchResources(modelArrayBatch: EntityArrayThinInstanceBatch): void {
    this.dependencies.selection.outlinedModelArrayBatches.delete(modelArrayBatch);
    for (const mesh of modelArrayBatch.meshes) {
      this.modelArrayBatchByMeshUniqueId.delete(mesh.uniqueId);
    }
    modelArrayBatch.dispose();
  }

  public disposeModelArrayBatch(model: ModelRuntimeEntry): void {
    if (!model.modelArrayBatch) {
      model.modelArraySourceSignature = '';
      return;
    }

    const modelArrayBatch = model.modelArrayBatch;
    model.modelArrayBatch = null;
    model.modelArraySourceSignature = '';
    this.disposeModelArrayBatchResources(modelArrayBatch);
    this.dependencies.transforms.refreshGroupTransformPreviewTargets();
  }

  /** 根据逻辑实体直接定位所属矩阵批次，避免选择变化扫描全部源模型和参数变体。 */
  public resolveModelArrayBatchForEntityId(entityId: string): EntityArrayThinInstanceBatch | null {
    const parameterVariant = this.dependencies.variants.modelArrayParameterVariantByEntityId.get(entityId);
    if (parameterVariant?.model.modelArrayBatch) return parameterVariant.model.modelArrayBatch;

    const sourceBatch = this.dependencies.assets.models.get(entityId)?.modelArrayBatch;
    if (sourceBatch) return sourceBatch;

    const instanceEntity = this.modelArrayInstanceEntities.get(entityId);
    const sourceEntityId = instanceEntity?.components.modelArrayInstance?.sourceEntityId;
    return sourceEntityId ? this.dependencies.assets.models.get(sourceEntityId)?.modelArrayBatch ?? null : null;
  }
  /** 按原构造顺序连接此领域的资源与回调。 */
  initializeModelArrayVariantRenderSuppressionObserver(): void {
    this.modelArrayVariantRenderSuppressionObserver = this.context.scene.onBeforeActiveMeshesEvaluationObservable.add(() => {
      this.suppressPendingModelArrayVariantHostsForRender();
    });
  }

  /** 按原构造顺序连接此领域的资源与回调。 */
  initializeModelArrayVariantRenderRestoreObserver(): void {
    this.modelArrayVariantRenderRestoreObserver = this.context.scene.onAfterRenderObservable.add(() => {
      this.restoreSuppressedModelArrayVariantHostsAfterRender();
    });
  }

}
