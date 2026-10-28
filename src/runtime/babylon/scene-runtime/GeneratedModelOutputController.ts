import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import { Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh.js';
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import type { Entity } from '../../../editor/model/Entity';
import type { MeshKind, ModelAssetComponent, ModelGeneratorComponent, ModelGeneratorTarget } from '../../../editor/model/components';
import { BUILT_IN_BOX_SIZE_METERS, BUILT_IN_PLANE_SIZE_METERS, BUILT_IN_SPHERE_DIAMETER_METERS, getBuiltInMeshGroundOffsetMeters } from '../../../editor/model/builtInMeshGeometry';
import { createModelAssetCode } from '../../../editor/model/SceneDocument';
import { createId } from '../../../shared/ids';
import type { TelemetryBindingComponent } from '../../../editor/model/telemetryBinding';
import { createModelGeneratorTargetSignature, createRuntimeModelAssetFromTarget, sanitizeModelAssetTemplate } from '../../../editor/model/modelGenerator';
import { resolveModelGeneratorTargetFromSnapshot } from '../modelGeneratorRuntime';
import { buildCompositionNodeTree, readCompositionNodeArraySourceId, readCompositionNodeMeshRenderer, type CompositionNodeTree } from '../composition/compositionCargoBuilder';
import { clearCompositionCache, getCompositionLibraryEntry } from '../composition/compositionCargoCache';
import { sanitizeBabylonName } from '../runtimeValueUtils';
import { type DeviceTelemetrySnapshot } from '../../mqtt/deviceTelemetry';
import { EntityArrayThinInstanceBatch } from '../EntityArrayThinInstanceBatch';
import { ModelGeneratorAssetPreloader } from '../ModelGeneratorAssetPreloader';
import { createModelAssetTemplateKey, resolveModelAssetSharedInstancingPolicy } from '../SharedModelAssetCache';
import { GeneratedCargoInstancePool, type GeneratedCargoPoolEntry } from './GeneratedCargoInstancePool';
import { createConveyorTelemetryState, createHcliftTelemetryState, createLiftTelemetryState, createRgvTelemetryState, createShuttleTelemetryState, createStackerTelemetryState, isConveyorModelAsset, isLiftModelAsset, isRgvModelAsset, isStackerModelAsset } from '../telemetry/specialized/specializedModelAssets';
import { DeviceSpawnerRuntime, createSpawnedDeviceEntityId, createSpawnedDeviceKey, type DeviceSpawnerConfig, type SpawnedDeviceKey } from '../telemetry/spawner/DeviceSpawnerRuntime';
import { STACKER_CARGO_COLOR, STACKER_CARGO_EMISSIVE_COLOR, STACKER_CARGO_SIZE, CONVEYOR_CARGO_COLOR, CONVEYOR_CARGO_EMISSIVE_COLOR, CONVEYOR_CARGO_SIZE, RGV_CARGO_COLOR, RGV_CARGO_EMISSIVE_COLOR, RGV_CARGO_SIZE, LIFT_CARGO_COLOR, LIFT_CARGO_EMISSIVE_COLOR, LIFT_CARGO_SIZE, SHUTTLE_CARGO_COLOR, SHUTTLE_CARGO_EMISSIVE_COLOR, SHUTTLE_CARGO_SIZE } from '../telemetry/specialized/types';
import type { GeneratedCargoKind, GeneratedCargoRuntimeEntry } from '../telemetry/specialized/types';
import type { SceneRuntimeContext } from './SceneRuntimeContext';
import { runSceneRuntimeCleanup } from './sceneRuntimeCleanup';
import type { SceneTelemetryController } from './SceneTelemetryController';
import type { SceneMeshPresentationController } from './SceneMeshPresentationController';
import type { SceneTriangleAndReadinessController } from './SceneTriangleAndReadinessController';
import type { ModelParameterBindingController } from './ModelParameterBindingController';
import type { ModelAssetRuntimeController } from './ModelAssetRuntimeController';
import type { ScenePickingAndSelectionController } from './ScenePickingAndSelectionController';
import type { SceneDocumentController } from './SceneDocumentController';
import { MODEL_GENERATOR_MARKER_COLOR, MODEL_GENERATOR_MARKER_ALPHA, DEVICE_SPAWNER_MARKER_COLOR, EDITOR_ENTITY_ID_METADATA_KEY, type ModelRuntimeEntry, type ModelGeneratorMarkerRuntimeEntry, type DeviceSpawnerMarkerRuntimeEntry, type ModelGeneratorMeshOutputRuntimeEntry, type ModelGeneratorCompositionMemberRuntimeEntry, type ModelGeneratorCompositionOutputRuntimeEntry, type ModelGeneratorOutputRuntimeEntry, COMPOSITION_ARRAY_MAX_INSTANCES, type GeneratedOutputOwnerRuntimeEntry, type ModelGeneratorRuntimeEntry, type ResolvedModelGeneratorTarget } from './sceneRuntimeTypes';

/** 此领域仅能访问明确列出的协作能力，资源与缓存由所属 Controller 持有。 */
type Dependencies = {
  readonly telemetry: Pick<SceneTelemetryController, 'specializedTelemetryRuntime' | 'telemetryPreviewActive' | 'createExternalScriptTelemetrySnapshot' | 'updateModelExternalScriptRuntimeContext'>;
  readonly presentation: Pick<SceneMeshPresentationController, 'applyTransform' | 'readColor'>;
  readonly readiness: Pick<SceneTriangleAndReadinessController, 'invalidateModelStatistics' | 'modelStatisticsFallbackMeshes' | 'notifyModelLoadProgressChanged' | 'modelStatisticsMeshAddedObserver'>;
  readonly parameters: Pick<ModelParameterBindingController, 'applyModelUnitScale' | 'applyModelAssetParameters'>;
  readonly assets: Pick<ModelAssetRuntimeController, 'createModelAssetSignature' | 'modelLoadSequence' | 'loadModelRuntimeAssets' | 'preloadModelRuntimeAsset' | 'parentTopLevelModelNodes' | 'refreshModelGeneratorModelMeshes' | 'normalizeModelContentOrigin' | 'syncModelGeneratorExternalScripts' | 'splitAssetUrl' | 'resolveVersionedRuntimeAssetUrl' | 'loadAssetContainer' | 'refreshModelMeshes' | 'models' | 'syncModelAssetExternalScripts'>;
  readonly selection: Pick<ScenePickingAndSelectionController, 'applyModelSelection' | 'selectedEntityIds' | 'localHighlightedEntityIds' | 'externalHighlightedEntityIds'>;
  readonly document: Pick<SceneDocumentController, 'isEntityVisible' | 'isEntityScenePickable' | 'shadowDocument' | 'disposed'>;
};


/** GeneratedModelOutputController 的资源、状态及取消/释放操作在同一领域内维护。 */
export class GeneratedModelOutputController {
  constructor(private readonly context: SceneRuntimeContext, private readonly dependencies: Dependencies) {
    this.generatedCargoInstancePool = new GeneratedCargoInstancePool(this.context.scene);
    // 真实业务等价与净收益尚未验收；默认保留原生创建/释放，仅内部A/B可启用候选。
    this.generatedCargoInstancePool.setEnabled(false);
    this.generatorAssetPreloader = new ModelGeneratorAssetPreloader({
      preload: (asset, signal) => this.dependencies.assets.preloadModelRuntimeAsset(asset, signal),
      getAssetKey: createModelAssetTemplateKey,
      loadCompositionModels: async target => {
        const entry = await getCompositionLibraryEntry(target.libraryId, target.revision);
        return entry.definition.nodes.flatMap(node => {
          if (node.visible === false || readCompositionNodeArraySourceId(node) || readCompositionNodeMeshRenderer(node)) return [];
          const template = sanitizeModelAssetTemplate(node.components.modelAsset);
          return template ? [{ assetCode: '', ...template }] : [];
        });
      },
      onError: (error, target) => {
        Reflect.apply(this.context.pushLog, this.context.callbackReceiver, [
          '货物模板预取失败，生成时将按原规则重试：' + target.displayName + '；'
          + (error instanceof Error ? error.message : String(error)),
        ]);
      },
      onChange: () => this.dependencies.readiness.notifyModelLoadProgressChanged(),
    });
  }

  public readonly generatorAssetPreloader: ModelGeneratorAssetPreloader;
  private readonly generatedCargoInstancePool: GeneratedCargoInstancePool;
  private readonly generatedCargoPoolEntries = new WeakMap<ModelRuntimeEntry, GeneratedCargoPoolEntry>();

  /** 仅供固定输入验收使用的内部A/B开关；关闭时排空idle，活动资源仍由原model释放。 */
  public setGeneratedCargoPoolingEnabled(enabled: boolean): void {
    if (!this.updatesStopped) this.generatedCargoInstancePool.setEnabled(enabled);
  }
  public getGeneratedCargoPoolMetrics() { return this.generatedCargoInstancePool.getMetrics(); }

  public readonly modelGenerators = new Map<string, ModelGeneratorRuntimeEntry>();
  /** 设备产生器标记（编辑态可视），按实体 ID 组织。 */
  public readonly deviceSpawnerMarkers = new Map<string, DeviceSpawnerMarkerRuntimeEntry>();
  /** MQTT 消息驱动生成的动态设备实例，键为 spawnerCode + assetCode。 */
  public readonly spawnedDeviceModels = new Map<string, ModelRuntimeEntry>();
  /** 已创建但尚未显示的生成实例：等首帧驱动把设备吸附到目标位后再揭示，避免先在模板位置闪现再跳走。 */
  public readonly spawnedDeviceRevealPending = new Set<SpawnedDeviceKey>();
  /** 隐藏期被置 layerMask=0 的网格原值（mesh.uniqueId → 原 layerMask），揭示/销毁时恢复。 */
  public readonly spawnedDeviceHiddenLayerMasks = new Map<number, number>();
  public deviceSpawnerRuntime!: DeviceSpawnerRuntime;
  /** 场景级默认模型生成器实体 ID，syncDocument 时从文档快照刷新。 */
  public defaultCargoGeneratorId: string | null = null;
  public readonly generatedOutputOwners = new Map<string, GeneratedOutputOwnerRuntimeEntry>();
  public readonly reportedCargoIssues = new Set<string>();
  private modelEntranceOutputsHidden = false;
  private readonly modelEntranceLayerMasks = new Map<AbstractMesh, number>();
  private removeModelEntranceRenderObservers: (() => void) | null = null;

  /** 入场期间只在渲染帧屏蔽动态产物，避免改变脚本和遥测所依赖的业务显隐状态。 */
  public setModelEntranceOutputsHidden(hidden: boolean): void {
    if (this.updatesStopped || this.modelEntranceOutputsHidden === hidden) return;
    this.modelEntranceOutputsHidden = hidden;
    if (!hidden) {
      this.removeModelEntranceRenderObservers?.();
      this.removeModelEntranceRenderObservers = null;
      this.restoreModelEntranceLayerMasks();
      return;
    }
    const scene = this.context.scene;
    const before = scene.onBeforeRenderObservable.add(() => {
      // 上一帧意外中断时先恢复，再读取本帧业务状态。
      this.restoreModelEntranceLayerMasks();
      const meshes = new Set<AbstractMesh>();
      for (const owner of this.generatedOutputOwners.values()) {
        const output = owner.output;
        if (output?.kind === 'mesh') meshes.add(output.mesh);
        else if (output?.kind === 'model') {
          for (const mesh of output.model.meshes) meshes.add(mesh);
          for (const mesh of output.model.modelArrayBatch?.meshes ?? []) meshes.add(mesh);
        } else if (output?.kind === 'composition') {
          for (const member of output.members) {
            for (const mesh of member.model?.meshes ?? []) meshes.add(mesh);
            for (const mesh of member.model?.modelArrayBatch?.meshes ?? []) meshes.add(mesh);
            if (member.mesh) meshes.add(member.mesh);
            for (const mesh of member.arrayBatch?.meshes ?? []) meshes.add(mesh);
          }
        }
      }
      for (const mesh of this.dependencies.readiness.modelStatisticsFallbackMeshes) meshes.add(mesh);
      for (const model of this.spawnedDeviceModels.values()) {
        for (const mesh of model.meshes) meshes.add(mesh);
        for (const mesh of model.modelArrayBatch?.meshes ?? []) meshes.add(mesh);
      }
      for (const mesh of meshes) {
        if (mesh.isDisposed()) continue;
        this.modelEntranceLayerMasks.set(mesh, mesh.layerMask);
        mesh.layerMask = 0;
      }
    });
    const after = scene.onAfterRenderObservable.add(() => this.restoreModelEntranceLayerMasks());
    this.removeModelEntranceRenderObservers = () => {
      scene.onBeforeRenderObservable.remove(before);
      scene.onAfterRenderObservable.remove(after);
    };
  }

  private restoreModelEntranceLayerMasks(): void {
    for (const [mesh, layerMask] of this.modelEntranceLayerMasks) {
      if (!mesh.isDisposed()) mesh.layerMask = layerMask;
    }
    this.modelEntranceLayerMasks.clear();
  }

  private deviceSpawningStopped = false;
  private updatesStopped = false;
  private disposed = false;

  /** 产物在模型/变体之后、共享资产缓存之前释放；货物支撑根由遥测货物所有者管理。 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopUpdates();
    for (const [entityId, generator] of [...this.modelGenerators]) {
      runSceneRuntimeCleanup(this.context, `模型生成器 ${entityId}`, () => this.disposeModelGenerator(entityId, generator));
    }
    for (const [entityId, owner] of [...this.generatedOutputOwners]) {
      this.generatedOutputOwners.delete(entityId);
      owner.loadToken += 1;
      runSceneRuntimeCleanup(this.context, `生成输出 ${entityId}`, () => this.disposeModelGeneratorOutput(owner));
      owner.failedTargetSignatures.clear();
      owner.reportedLoadFailureKeys.clear();
      owner.onTerminalLoadFailure = undefined;
    }
    for (const entityId of [...this.deviceSpawnerMarkers.keys()]) {
      runSceneRuntimeCleanup(this.context, `设备产生器标记 ${entityId}`, () => this.disposeDeviceSpawnerMarker(entityId));
    }
    this.modelGenerators.clear();
    this.generatedOutputOwners.clear();
    this.deviceSpawnerMarkers.clear();
    this.reportedCargoIssues.clear();
    this.defaultCargoGeneratorId = null;
  }

  /** 最终销毁前停止预取与新设备；先关闭复用池，使后续归还的活动句柄直接释放。 */
  stopUpdates(): void {
    if (this.updatesStopped) return;
    this.setModelEntranceOutputsHidden(false);
    this.updatesStopped = true;
    runSceneRuntimeCleanup(this.context, '生成器资产预取', () => this.generatorAssetPreloader.dispose());
    runSceneRuntimeCleanup(this.context, '生成货物复用池', () => this.generatedCargoInstancePool.setEnabled(false));
    this.stopDeviceSpawning();
  }

  /** 动态设备只属于预览；先退订消息，再使在途模型加载失效，不销毁编辑态标记或共享资产。 */
  stopDeviceSpawning(): void {
    this.deviceSpawningStopped = true;
    runSceneRuntimeCleanup(this.context, '设备产生器订阅', () => this.deviceSpawnerRuntime.disposeAll());
    for (const key of [...this.spawnedDeviceModels.keys()]) this.disposeSpawnedDeviceModel(key);
    this.spawnedDeviceRevealPending.clear();
    this.spawnedDeviceHiddenLayerMasks.clear();
    if (!this.dependencies.document.disposed) this.syncDeviceSpawnerMarkerVisibility();
  }

  /** 同步模型生成器配置标记；实体 Transform 只影响 markerRoot，不影响任何自动货物。 */
  public syncModelGeneratorEntity(entity: Entity, selected: boolean): void {
    if (this.updatesStopped) return;
    const component = entity.components.modelGenerator;
    if (!component) return;

    let runtimeEntry = this.modelGenerators.get(entity.id);
    if (!runtimeEntry) {
      const markerRoot = new TransformNode(`${entity.id}_modelGeneratorMarkerRoot`, this.context.scene);
      const root = new TransformNode(`${entity.id}_modelGeneratorOutputRoot`, this.context.scene);
      runtimeEntry = {
        entityId: entity.id,
        entityName: entity.name,
        editorEntityId: null,
        runtimeAssetCode: createModelAssetCode('GEN', entity.id),
        root,
        markerRoot,
        marker: this.createModelGeneratorMarker(entity.id, markerRoot),
        component,
        selected,
        output: null,
        activeTargetSignature: null,
        loadToken: 0,
        failedTargetSignatures: new Set(),
        reportedLoadFailureKeys: new Set(),
        activeSnapshot: null,
        metadata: { modelGeneratorCargo: true, generatorEntityId: entity.id },
        runtimeConfigSignature: '',
      };
      this.modelGenerators.set(entity.id, runtimeEntry);
      this.generatedOutputOwners.set(runtimeEntry.entityId, runtimeEntry);
    }

    const runtimeConfigSignature = this.createModelGeneratorRuntimeConfigSignature(component);
    if (runtimeEntry.runtimeConfigSignature && runtimeEntry.runtimeConfigSignature !== runtimeConfigSignature) {
      this.dependencies.telemetry.specializedTelemetryRuntime.disposeCargoForGenerator(entity.id);
      this.disposeModelGeneratorOutput(runtimeEntry);
      this.generatedCargoInstancePool.clearGenerator(entity.id);
      runtimeEntry.activeTargetSignature = null;
      runtimeEntry.activeSnapshot = null;
      runtimeEntry.readinessError = undefined;
    }
    runtimeEntry.entityName = entity.name;
    runtimeEntry.component = component;
    runtimeEntry.runtimeConfigSignature = runtimeConfigSignature;
    this.generatorAssetPreloader.sync(entity.id, component, runtimeConfigSignature);
    runtimeEntry.selected = selected;
    this.dependencies.presentation.applyTransform(runtimeEntry.markerRoot, entity.components.transform);
    this.applyModelGeneratorPresentation(runtimeEntry);
  }

  /** 在编辑态与运行态切换时允许全部生成输出重新尝试失败目标。 */
  public clearModelGeneratorLoadFailureCache(): void {
    this.generatedCargoInstancePool.clear();
    clearCompositionCache();
    this.generatorAssetPreloader.retryFailed();
    for (const owner of this.generatedOutputOwners.values()) {
      owner.failedTargetSignatures.clear();
      owner.readinessError = undefined;
    }
  }

  /** 在编辑态与预览态切换时批量刷新所有模型生成器配置标记。 */
  public syncAllModelGeneratorPresentations(): void {
    for (const runtimeEntry of this.modelGenerators.values()) {
      this.applyModelGeneratorPresentation(runtimeEntry);
    }
  }

  /** 对解析结果去重，同一目标签名不会重复销毁和加载。 */
  public syncModelGeneratorResolvedTarget(
    runtimeEntry: GeneratedOutputOwnerRuntimeEntry,
    resolution: ResolvedModelGeneratorTarget,
  ): void {
    if (this.updatesStopped) return;
    runtimeEntry.activeSnapshot = resolution.snapshot;
    const target = resolution.target;
    runtimeEntry.activeModelTarget = target?.kind === 'model' ? target : null;
    if (!target) {
      if (runtimeEntry.activeTargetSignature !== null || runtimeEntry.output) {
        runtimeEntry.loadToken += 1;
        this.disposeModelGeneratorOutput(runtimeEntry);
        runtimeEntry.activeTargetSignature = null;
      }
      return;
    }

    const targetSignature = createModelGeneratorTargetSignature(target);
    if (runtimeEntry.failedTargetSignatures.has(targetSignature)) {
      if (resolution.role === 'conditional') {
        this.syncModelGeneratorResolvedTarget(runtimeEntry, {
          target: runtimeEntry.component.defaultTarget,
          role: 'default',
          snapshot: resolution.snapshot,
        });
        return;
      }

      if (runtimeEntry.activeTargetSignature !== targetSignature || runtimeEntry.output) {
        runtimeEntry.loadToken += 1;
        this.disposeModelGeneratorOutput(runtimeEntry);
        runtimeEntry.activeTargetSignature = targetSignature;
      }
      runtimeEntry.onTerminalLoadFailure?.();
      return;
    }

    if (runtimeEntry.activeTargetSignature === targetSignature) {
      this.applyGeneratedOutputPresentation(runtimeEntry);
      return;
    }

    runtimeEntry.loadToken += 1;
    this.disposeModelGeneratorOutput(runtimeEntry);
    runtimeEntry.activeTargetSignature = targetSignature;
    runtimeEntry.readinessError = undefined;

    if (target.kind === 'mesh') {
      runtimeEntry.output = this.createModelGeneratorMeshOutput(runtimeEntry, target);
      this.dependencies.readiness.invalidateModelStatistics();
      this.applyGeneratedOutputPresentation(runtimeEntry);
      return;
    }

    if (target.kind === 'composition') {
      this.loadModelGeneratorCompositionOutput(runtimeEntry, target, targetSignature, resolution);
      return;
    }

    this.loadModelGeneratorModelOutput(runtimeEntry, target, targetSignature, resolution);
  }

  /** 创建生成输出的模型运行时条目：稳定根挂到指定父节点，内容根只做单位换算。 */
  public createGeneratedModelRuntimeEntry(
    namePrefix: string,
    parentNode: TransformNode,
    modelAsset: ModelAssetComponent,
  ): ModelRuntimeEntry {
    const modelRoot = new TransformNode(`${namePrefix}_generatedModelRoot`, this.context.scene);
    const contentRoot = new TransformNode(`${namePrefix}_generatedModelContentRoot`, this.context.scene);
    modelRoot.parent = parentNode;
    contentRoot.parent = modelRoot;
    this.dependencies.parameters.applyModelUnitScale(contentRoot, modelAsset.unitScaleToMeters);

    return {
      sourceUrl: modelAsset.sourceUrl,
      resolvedModelAsset: modelAsset,
      assetRevision: modelAsset.assetRevision ?? null,
      assetSignature: this.dependencies.assets.createModelAssetSignature(modelAsset),
      entitySnapshot: null,
      assetCode: modelAsset.assetCode,
      telemetryBinding: null,
      stackerCapable: isStackerModelAsset(modelAsset),
      conveyorCapable: isConveyorModelAsset(modelAsset),
      rgvCapable: isRgvModelAsset(modelAsset),
      liftCapable: isLiftModelAsset(modelAsset),
      root: modelRoot,
      contentRoot,
      assetHandle: null,
      meshes: [],
      modelArraySuspendedMeshes: new Set(),
      modelArrayBatch: null,
      modelArraySourceSignature: '',
      modelArrayFailureSignature: '',
      highlighted: false,
      loadToken: ++this.dependencies.assets.modelLoadSequence,
      cancelLoad: null,
      parameterSignature: '',
      parameterBaseline: new Map(),
      textureCache: new Map(),
      externalScriptRuntime: null,
      externalScriptSignature: '',
      externalScriptStarting: false,
      measurementReady: false,
      stackerTelemetry: createStackerTelemetryState(modelRoot),
      conveyorTelemetry: createConveyorTelemetryState(),
      rgvTelemetry: createRgvTelemetryState(modelRoot),
      shuttleTelemetry: createShuttleTelemetryState(modelRoot),
      liftTelemetry: createLiftTelemetryState(modelRoot),
      hcliftTelemetry: createHcliftTelemetryState(modelRoot),
      stackerTelemetryReady: false,
      telemetryPreviewBaseline: null,
    };
  }

  /** 异步加载生成器导入模型输出；过期 token 的容器会立即丢弃。 */
  public loadModelGeneratorModelOutput(
    runtimeEntry: GeneratedOutputOwnerRuntimeEntry,
    target: Extract<ModelGeneratorTarget, { kind: 'model' }>,
    targetSignature: string,
    resolution: ResolvedModelGeneratorTarget,
  ): void {
    const modelAsset = createRuntimeModelAssetFromTarget(
      target,
      runtimeEntry.runtimeAssetCode,
    );
    if (!modelAsset) {
      this.handleModelGeneratorLoadFailure(runtimeEntry, targetSignature, resolution, new Error('目标模型快照无效'));
      return;
    }

    const model = this.createGeneratedModelRuntimeEntry(runtimeEntry.entityId, runtimeEntry.root, modelAsset);
    runtimeEntry.output = { kind: 'model', model };
    this.dependencies.readiness.invalidateModelStatistics();
    const generatorLoadToken = runtimeEntry.loadToken;
    this.applyGeneratedOutputPresentation(runtimeEntry);

    const identity = this.getGeneratedCargoPoolIdentity(runtimeEntry, modelAsset, model);
    const pooled = identity ? this.generatedCargoInstancePool.take(identity.generatorId, identity.key) : null;
    const loading = pooled ? Promise.resolve(pooled.assets)
      : this.dependencies.assets.loadModelRuntimeAssets(modelAsset, model.assetSignature, undefined, model.entitySnapshot?.id ?? model.root.name);
    void loading
      .then((loadedAssets) => {
        const activeEntry = this.generatedOutputOwners.get(runtimeEntry.entityId);
        const activeOutput = activeEntry?.output;
        if (
          !activeEntry
          || activeEntry.loadToken !== generatorLoadToken
          || activeEntry.activeTargetSignature !== targetSignature
          || activeOutput?.kind !== 'model'
          || activeOutput.model !== model
        ) {
          if (pooled) this.generatedCargoInstancePool.discard(pooled);
          else loadedAssets.handle.dispose();
          return;
        }

        // 四个原提交身份检查通过后先接管原句柄；可选基线捕获抛错时也由原catch完整释放。
        model.assetHandle = loadedAssets.handle;
        const candidate = pooled ?? (identity ? this.generatedCargoInstancePool.capture(identity.generatorId, identity.key, loadedAssets) : null);
        if (candidate) this.generatedCargoPoolEntries.set(model, candidate);
        if (loadedAssets.kind === 'owned-container') {
          model.meshes = loadedAssets.meshes;
          this.dependencies.assets.parentTopLevelModelNodes(model, loadedAssets.transformNodes);
        } else {
          for (const rootNode of loadedAssets.rootNodes) {
            rootNode.parent = model.contentRoot;
          }
        }

        if (candidate) this.generatedCargoInstancePool.activate(candidate, model.contentRoot);
        this.dependencies.assets.refreshModelGeneratorModelMeshes(activeEntry);
        this.dependencies.assets.normalizeModelContentOrigin(model);
        this.dependencies.parameters.applyModelAssetParameters(modelAsset, model);
        this.dependencies.assets.syncModelGeneratorExternalScripts(activeEntry, modelAsset, model);
        this.applyGeneratedOutputPresentation(activeEntry);
      })
      .catch((error) => {
        const activeEntry = this.generatedOutputOwners.get(runtimeEntry.entityId);
        const activeOutput = activeEntry?.output;
        if (
          !activeEntry
          || activeEntry.loadToken !== generatorLoadToken
          || activeEntry.activeTargetSignature !== targetSignature
          || activeOutput?.kind !== 'model'
          || activeOutput.model !== model
        ) return;

        // 失败提交不是合格的退役实例，必须释放而非重新进入idle。
        const failedEntry = this.generatedCargoPoolEntries.get(model);
        if (failedEntry) {
          this.generatedCargoPoolEntries.delete(model);
          model.assetHandle = null;
          this.generatedCargoInstancePool.discard(failedEntry);
        }
        this.disposeModelGeneratorOutput(activeEntry);
        this.handleModelGeneratorLoadFailure(activeEntry, targetSignature, resolution, error);
      });
  }

  /** 异步加载组合资源库生成输出；成员模型并行加载，任一成员失败则整组回退。 */
  public loadModelGeneratorCompositionOutput(
    runtimeEntry: GeneratedOutputOwnerRuntimeEntry,
    target: Extract<ModelGeneratorTarget, { kind: 'composition' }>,
    targetSignature: string,
    resolution: ResolvedModelGeneratorTarget,
  ): void {
    const generatorLoadToken = runtimeEntry.loadToken;
    void this.buildCompositionGeneratorOutput(runtimeEntry, target)
      .then((output) => {
        const activeEntry = this.generatedOutputOwners.get(runtimeEntry.entityId);
        if (
          !activeEntry
          || activeEntry.loadToken !== generatorLoadToken
          || activeEntry.activeTargetSignature !== targetSignature
        ) {
          this.disposeModelGeneratorOutputValue(output);
          return;
        }

        activeEntry.output = output;
        this.dependencies.readiness.invalidateModelStatistics();
        // 组合成员模型在 buildCompositionGeneratorOutput 内各自加载，统一在此补齐产物点击元数据。
        this.dependencies.assets.refreshModelGeneratorModelMeshes(activeEntry);
        this.applyGeneratedOutputPresentation(activeEntry);
      })
      .catch((error) => {
        const activeEntry = this.generatedOutputOwners.get(runtimeEntry.entityId);
        if (
          !activeEntry
          || activeEntry.loadToken !== generatorLoadToken
          || activeEntry.activeTargetSignature !== targetSignature
        ) return;

        this.handleModelGeneratorLoadFailure(activeEntry, targetSignature, resolution, error);
      });
  }

  /**
   * 构建组合生成输出：层级树挂到生成器稳定根下，成员保持组合内相对结构，
   * 不做原点归一、不执行成员脚本；阵列实例成员由 thinInstance 批次承载。
   */
  public async buildCompositionGeneratorOutput(
    runtimeEntry: GeneratedOutputOwnerRuntimeEntry,
    target: Extract<ModelGeneratorTarget, { kind: 'composition' }>,
  ): Promise<ModelGeneratorCompositionOutputRuntimeEntry> {
    const entry = await getCompositionLibraryEntry(target.libraryId, target.revision);
    const namePrefix = `${runtimeEntry.entityId}_generatedComposition`;
    const tree = buildCompositionNodeTree(entry.definition, this.context.scene, namePrefix);
    tree.root.parent = runtimeEntry.root;
    const members: ModelGeneratorCompositionMemberRuntimeEntry[] = [];
    const output: ModelGeneratorCompositionOutputRuntimeEntry = { kind: 'composition', tree, members };

    try {
      const arrayInstanceIdsBySource = new Map<string, string[]>();
      for (const node of entry.definition.nodes) {
        if (node.visible === false) continue;
        const sourceId = readCompositionNodeArraySourceId(node);
        if (!sourceId) continue;
        const list = arrayInstanceIdsBySource.get(sourceId);
        if (list) list.push(node.id);
        else arrayInstanceIdsBySource.set(sourceId, [node.id]);
      }

      const modelLoads: Promise<void>[] = [];
      for (const node of entry.definition.nodes) {
        if (node.visible === false) continue;
        const memberRoot = tree.nodes.get(node.id);
        if (!memberRoot) continue;
        if (readCompositionNodeArraySourceId(node)) continue;

        const meshRenderer = readCompositionNodeMeshRenderer(node);
        if (meshRenderer) {
          const memberName = `${namePrefix}_${sanitizeBabylonName(node.id)}`;
          const mesh = this.createModelGeneratorMesh(memberName, meshRenderer.meshKind);
          const material = new StandardMaterial(`${memberName}_material`, this.context.scene);
          material.diffuseColor = this.dependencies.presentation.readColor(meshRenderer.materialColor);
          mesh.material = material;
          mesh.parent = memberRoot;
          mesh.metadata = { ...(mesh.metadata ?? {}), ...runtimeEntry.metadata };
          mesh.isPickable = true;
          members.push({ nodeId: node.id, memberRoot, model: null, mesh, material, arrayBatch: null });
          continue;
        }

        const template = sanitizeModelAssetTemplate(node.components.modelAsset);
        if (!template) continue;
        const modelAsset: ModelAssetComponent = { assetCode: '', ...template };
        const memberName = `${namePrefix}_${sanitizeBabylonName(node.id)}`;
        const model = this.createGeneratedModelRuntimeEntry(memberName, memberRoot, modelAsset);
        const member: ModelGeneratorCompositionMemberRuntimeEntry = {
          nodeId: node.id,
          memberRoot,
          model,
          mesh: null,
          material: null,
          arrayBatch: null,
        };
        members.push(member);
        modelLoads.push(this.loadCompositionMemberModel(
          modelAsset,
          model,
          member,
          arrayInstanceIdsBySource.get(node.id) ?? [],
          tree,
          runtimeEntry.root,
        ));
      }

      if (members.length === 0) throw new Error(`组合“${entry.name}”没有可渲染成员。`);
      await Promise.all(modelLoads);
      return output;
    } catch (error) {
      this.disposeModelGeneratorOutputValue(output);
      throw error;
    }
  }

  /** 加载组合成员模型并挂到成员节点；阵列源成员强制独占容器（共享实例不能作为批次几何源）。 */
  public async loadCompositionMemberModel(
    modelAsset: ModelAssetComponent,
    model: ModelRuntimeEntry,
    member: ModelGeneratorCompositionMemberRuntimeEntry,
    arrayInstanceNodeIds: string[],
    tree: CompositionNodeTree,
    cargoRoot: TransformNode,
  ): Promise<void> {
    // 阵列源仍使用独占 Geometry；只将读取/解码接回同一模板缓存，不改变参数或脚本执行。
    const loadedAssets = await this.dependencies.assets.loadModelRuntimeAssets(
      modelAsset, model.assetSignature, undefined, model.entitySnapshot?.id ?? model.root.name,
      arrayInstanceNodeIds.length > 0,
    );
    model.assetHandle = loadedAssets.handle;
    if (loadedAssets.kind === 'owned-container') {
      model.meshes = loadedAssets.meshes;
      this.dependencies.assets.parentTopLevelModelNodes(model, loadedAssets.transformNodes);
    } else {
      for (const rootNode of loadedAssets.rootNodes) rootNode.parent = model.contentRoot;
    }

    this.dependencies.assets.refreshModelMeshes(model, {});
    this.dependencies.parameters.applyModelAssetParameters(modelAsset, model);

    if (arrayInstanceNodeIds.length > 0) {
      this.createCompositionArrayBatch(member, arrayInstanceNodeIds, tree, cargoRoot);
    }
  }

  /**
   * 为组合内阵列组创建 thinInstance 批次：批次网格挂到组合根下随货物移动，
   * 实例矩阵取各成员节点相对货物根的局部矩阵（构建时刻固化，组合层级此后不再形变）。
   */
  public createCompositionArrayBatch(
    member: ModelGeneratorCompositionMemberRuntimeEntry,
    instanceNodeIds: string[],
    tree: CompositionNodeTree,
    cargoRoot: TransformNode,
  ): void {
    const model = member.model;
    if (!model) return;
    const sourceMeshes = model.meshes.filter((mesh) => !mesh.isDisposed() && mesh.getTotalVertices() > 0);
    if (sourceMeshes.length === 0) throw new Error('组合阵列源成员没有可渲染 Mesh。');

    const allNodeIds = [member.nodeId, ...instanceNodeIds];
    if (allNodeIds.length > COMPOSITION_ARRAY_MAX_INSTANCES) {
      throw new Error(`组合阵列实例数 ${allNodeIds.length} 超过 ${COMPOSITION_ARRAY_MAX_INSTANCES} 上限。`);
    }

    cargoRoot.computeWorldMatrix(true);
    const inverseCargoRoot = cargoRoot.getWorldMatrix().clone();
    inverseCargoRoot.invert();
    const sourceNode = tree.nodes.get(member.nodeId);
    if (!sourceNode) throw new Error('组合阵列源成员节点缺失。');
    const sourceWorld = sourceNode.getWorldMatrix().clone();

    const instances = allNodeIds.map((nodeId) => {
      const node = tree.nodes.get(nodeId);
      if (!node) throw new Error('组合阵列实例节点缺失。');
      const local = node.getWorldMatrix().multiply(inverseCargoRoot);
      const scale = new Vector3();
      const rotation = new Quaternion();
      const translation = new Vector3();
      if (!local.decompose(scale, rotation, translation)) {
        throw new Error('组合阵列实例矩阵无法分解为 TRS。');
      }
      const euler = rotation.toEulerAngles();
      return {
        entityId: nodeId,
        transform: {
          position: { x: translation.x, y: translation.y, z: translation.z },
          rotation: { x: euler.x, y: euler.y, z: euler.z },
          scale: { x: scale.x, y: scale.y, z: scale.z },
        },
        pickable: false,
      };
    });

    const batch = EntityArrayThinInstanceBatch.create(member.nodeId, sourceMeshes, {
      interactive: false,
      namePrefix: '__compositionArrayThinInstance',
    });
    if (!batch) throw new Error('组合阵列源成员几何不支持批量实例。');
    if (!batch.updateEntityTransforms(sourceWorld, instances)) {
      batch.dispose();
      throw new Error('组合阵列实例矩阵提交失败。');
    }

    for (const mesh of batch.meshes) {
      mesh.parent = tree.root;
    }
    member.arrayBatch = batch;
    // 源成员几何已由批次承载（含源自身实例），原始 Mesh 退出场景避免重复渲染。
    for (const mesh of model.meshes) {
      if (!mesh.isDisposed()) this.context.scene.removeMesh(mesh);
    }
  }

  /** 记录一次模型加载失败；规则覆盖模型失败时在同一有效信号下回退共享生成模板。 */
  public handleModelGeneratorLoadFailure(
    runtimeEntry: GeneratedOutputOwnerRuntimeEntry,
    targetSignature: string,
    resolution: ResolvedModelGeneratorTarget,
    error: unknown,
  ): void {
    runtimeEntry.failedTargetSignatures.add(targetSignature);
    runtimeEntry.activeTargetSignature = targetSignature;
    const failureKey = `${resolution.role}:${targetSignature}`;
    if (!runtimeEntry.reportedLoadFailureKeys.has(failureKey)) {
      runtimeEntry.reportedLoadFailureKeys.add(failureKey);
      const message = error instanceof Error ? error.message : String(error);
      const targetLabel = resolution.role === 'conditional' ? '规则覆盖模型' : '共享生成模板';
      const fallbackLabel = resolution.role === 'conditional' ? '，已回退共享生成模板' : '';
      Reflect.apply(this.context.pushLog, this.context.callbackReceiver, [`模型生成器“${runtimeEntry.entityName}”${targetLabel}加载失败${fallbackLabel}：${message}`]);
    }

    if (resolution.role === 'conditional') {
      this.syncModelGeneratorResolvedTarget(runtimeEntry, {
        target: runtimeEntry.component.defaultTarget,
        role: 'default',
        snapshot: resolution.snapshot,
      });
      runtimeEntry.readinessError = error instanceof Error ? error.message : String(error);
      this.dependencies.readiness.invalidateModelStatistics();
      return;
    }

    runtimeEntry.readinessError = error instanceof Error ? error.message : String(error);
    this.dependencies.readiness.invalidateModelStatistics();
    runtimeEntry.onTerminalLoadFailure?.();
    this.applyGeneratedOutputPresentation(runtimeEntry);
  }

  /** 将当前 MQTT 快照作为只读运行上下文注入生成模型脚本。 */
  public updateModelGeneratorOutputRuntimeContext(runtimeEntry: GeneratedOutputOwnerRuntimeEntry): void {
    if (runtimeEntry.output?.kind !== 'model') return;
    const telemetry = this.dependencies.telemetry.telemetryPreviewActive && runtimeEntry.activeSnapshot
      ? this.dependencies.telemetry.createExternalScriptTelemetrySnapshot(runtimeEntry.activeSnapshot)
      : null;
    this.dependencies.telemetry.updateModelExternalScriptRuntimeContext(
      runtimeEntry.output.model,
      this.dependencies.telemetry.telemetryPreviewActive ? 'runtime' : 'edit',
      telemetry,
    );
  }


  /** 根据货物类型读取旧版 Box 回退尺寸和材质，保证无模板场景行为不变。 */
  public getGeneratedCargoFallbackSpec(kind: GeneratedCargoKind): {
    size: Vector3;
    color: string;
    emissiveColor: string;
  } {
    if (kind === 'stacker') {
      return { size: STACKER_CARGO_SIZE, color: STACKER_CARGO_COLOR, emissiveColor: STACKER_CARGO_EMISSIVE_COLOR };
    }
    if (kind === 'rgv') {
      return { size: RGV_CARGO_SIZE, color: RGV_CARGO_COLOR, emissiveColor: RGV_CARGO_EMISSIVE_COLOR };
    }
    if (kind === 'shuttle') {
      return { size: SHUTTLE_CARGO_SIZE, color: SHUTTLE_CARGO_COLOR, emissiveColor: SHUTTLE_CARGO_EMISSIVE_COLOR };
    }
    if (kind === 'lift') {
      return { size: LIFT_CARGO_SIZE, color: LIFT_CARGO_COLOR, emissiveColor: LIFT_CARGO_EMISSIVE_COLOR };
    }
    return { size: CONVEYOR_CARGO_SIZE, color: CONVEYOR_CARGO_COLOR, emissiveColor: CONVEYOR_CARGO_EMISSIVE_COLOR };
  }

  /** 为普通自动货物创建旧版 Box 回退；root 表示底部支撑点，Mesh 局部上移半高。 */
  public ensureGeneratedCargoFallback(cargo: GeneratedCargoRuntimeEntry, kind: GeneratedCargoKind): void {
    if (cargo.fallback) return;
    const spec = this.getGeneratedCargoFallbackSpec(kind);
    const mesh = MeshBuilder.CreateBox(
      `${kind}_cargo_${sanitizeBabylonName(cargo.assetCode)}_${sanitizeBabylonName(cargo.containerCode)}`,
      { width: spec.size.x, height: spec.size.y, depth: spec.size.z },
      this.context.scene,
    );
    const material = new StandardMaterial(`${mesh.name}_mat`, this.context.scene);
    material.diffuseColor = Color3.FromHexString(spec.color);
    material.emissiveColor = Color3.FromHexString(spec.emissiveColor);
    mesh.parent = cargo.root;
    mesh.position.y = spec.size.y / 2;
    mesh.material = material;
    // 回退 Box 是「模板不可用」占位，不代表任何可点击的生成模板，保持不可拾取。
    mesh.isPickable = false;
    mesh.metadata = {
      ...(mesh.metadata ?? {}),
      generatedCargo: true,
      cargoKind: kind,
      sourceAssetCode: cargo.assetCode,
      containerCode: cargo.containerCode,
      fallback: true,
    };
    cargo.fallback = { mesh, material };
    this.dependencies.readiness.modelStatisticsFallbackMeshes.add(mesh);
    this.dependencies.readiness.invalidateModelStatistics();
  }

  /** 释放普通货物的旧版 Box 回退，不影响已加载生成模板。 */
  public disposeGeneratedCargoFallback(cargo: GeneratedCargoRuntimeEntry): void {
    if (!cargo.fallback) return;
    this.dependencies.readiness.modelStatisticsFallbackMeshes.delete(cargo.fallback.mesh);
    this.dependencies.readiness.invalidateModelStatistics();
    cargo.fallback.material.dispose();
    cargo.fallback.mesh.dispose();
    cargo.fallback = null;
  }

  /** 为普通货物按需创建共享生成输出宿主，并登记异步加载查找表。 */
  public ensureGeneratedCargoOutputOwner(
    cargo: GeneratedCargoRuntimeEntry,
    kind: GeneratedCargoKind,
    component: ModelGeneratorComponent,
    snapshot: DeviceTelemetrySnapshot,
  ): GeneratedOutputOwnerRuntimeEntry {
    if (cargo.outputOwner) {
      const metadata = cargo.outputOwner.metadata;
      // 跨设备接管时宿主会变，元数据变化后必须重新下发到已加载网格，否则点击会报旧宿主。
      const metadataChanged = metadata.containerCode !== cargo.containerCode
        || metadata.generatorEntityId !== cargo.generatorEntityId
        || metadata.hostEntityId !== cargo.hostEntityId;
      cargo.outputOwner.component = component;
      cargo.outputOwner.activeSnapshot = snapshot;
      metadata.containerCode = cargo.containerCode;
      metadata.generatorEntityId = cargo.generatorEntityId;
      metadata.hostEntityId = cargo.hostEntityId;
      if (metadataChanged) this.applyGeneratedOutputMetadata(cargo.outputOwner);
      return cargo.outputOwner;
    }

    const runtimeId = createId(`runtime_${kind}_cargo`);
    const owner: GeneratedOutputOwnerRuntimeEntry = {
      entityId: runtimeId,
      entityName: `${kind === 'stacker' ? '堆垛机' : '输送机'} ${cargo.assetCode} 货物 ${cargo.containerCode}`,
      editorEntityId: null,
      // 匿名货物（无 containerCode）回退设备编号：生成器模型目标要求 runtimeAssetCode 非空，否则判定快照无效回退内置 Box
      runtimeAssetCode: cargo.containerCode || cargo.assetCode,
      root: cargo.root,
      component,
      output: null,
      activeTargetSignature: null,
      loadToken: 0,
      failedTargetSignatures: new Set(),
      reportedLoadFailureKeys: new Set(),
      activeSnapshot: snapshot,
      metadata: {
        generatedCargo: true,
        cargoKind: kind,
        sourceAssetCode: cargo.assetCode,
        containerCode: cargo.containerCode,
        generatorEntityId: cargo.generatorEntityId,
        hostEntityId: cargo.hostEntityId,
        generatedUnitEntityId: runtimeId,
      },
      onTerminalLoadFailure: () => {
        if (cargo.outputOwner === owner) this.ensureGeneratedCargoFallback(cargo, kind);
      },
    };
    cargo.outputOwner = owner;
    this.generatedOutputOwners.set(owner.entityId, owner);
    return owner;
  }

  /** 把 owner 的最新元数据下发到已加载的产物网格；生成物拾取只读网格元数据。 */
  public applyGeneratedOutputMetadata(runtimeEntry: GeneratedOutputOwnerRuntimeEntry): void {
    const output = runtimeEntry.output;
    if (!output) return;
    const apply = (mesh: AbstractMesh | null | undefined): void => {
      if (!mesh || mesh.isDisposed()) return;
      mesh.metadata = { ...(mesh.metadata ?? {}), ...runtimeEntry.metadata };
    };
    if (output.kind === 'mesh') {
      apply(output.mesh);
      return;
    }
    if (output.kind === 'model') {
      for (const mesh of output.model.meshes) apply(mesh);
      return;
    }
    for (const member of output.members) {
      for (const mesh of member.model?.meshes ?? []) apply(mesh);
      apply(member.mesh);
      for (const mesh of member.arrayBatch?.meshes ?? []) apply(mesh);
    }
  }

  /** 根据设备绑定的生成器规则同步普通货物外观；无可用模板时回退旧版 Box。 */
  public syncGeneratedCargoVisual(
    cargo: GeneratedCargoRuntimeEntry,
    kind: GeneratedCargoKind,
    snapshot: DeviceTelemetrySnapshot,
    generator: ModelGeneratorRuntimeEntry | null,
    hostEntityId: string,
  ): void {
    // 宿主随接管变化：每帧刷新，保证点击货箱回落上报的是当前承运设备的编号。
    cargo.hostEntityId = hostEntityId;
    cargo.generatorEntityId = generator?.entityId ?? null;
    const component = generator?.component ?? null;
    const resolution = component ? resolveModelGeneratorTargetFromSnapshot(component, snapshot) : null;
    if (!component || !resolution) {
      this.disposeGeneratedCargoOutputOwner(cargo);
      this.ensureGeneratedCargoFallback(cargo, kind);
      return;
    }

    const owner = this.ensureGeneratedCargoOutputOwner(cargo, kind, component, snapshot);
    owner.component = component;
    owner.activeSnapshot = snapshot;
    const targetSignature = createModelGeneratorTargetSignature(resolution.target);
    if (!owner.failedTargetSignatures.has(targetSignature)) {
      this.disposeGeneratedCargoFallback(cargo);
    }
    this.syncModelGeneratorResolvedTarget(owner, resolution);
    if (owner.output) this.disposeGeneratedCargoFallback(cargo);
  }

  /** 注销普通货物生成输出宿主并释放当前输出，但保留货物支撑点根节点。 */
  public disposeGeneratedCargoOutputOwner(cargo: GeneratedCargoRuntimeEntry): void {
    const owner = cargo.outputOwner;
    if (!owner) return;
    owner.loadToken += 1;
    this.disposeModelGeneratorOutput(owner);
    owner.failedTargetSignatures.clear();
    owner.reportedLoadFailureKeys.clear();
    this.generatedOutputOwners.delete(owner.entityId);
    cargo.outputOwner = null;
  }

  /** 释放普通自动货物的模板、Box 回退和支撑点根节点。 */
  public disposeGeneratedCargo(cargo: GeneratedCargoRuntimeEntry): void {
    this.disposeGeneratedCargoFallback(cargo);
    this.disposeGeneratedCargoOutputOwner(cargo);
    cargo.root.dispose();
  }

  /** 设置普通自动货物世界支撑点、朝向和缩放（箱位含镜像时缩放保留负号）；root 无父级，不受 POI Transform 影响。首个稳定位姿（非交接插值中间态）建立全生命周期朝向锁定，之后转运/交接只平移不旋转。 */
  public setGeneratedCargoRootPose(cargo: GeneratedCargoRuntimeEntry, position: Vector3, rotation: Quaternion, scaling?: Vector3 | null): void {
    cargo.root.position.copyFrom(position);
    cargo.root.rotationQuaternion = rotation.clone();
    // handoff 插值期间不锁定：完结帧 resolveCargoHandoffPose 清除 handoff 并返回精确目标，锁定落到稳定朝向
    if (!cargo.handoff) cargo.lockedWorldRotation ??= rotation.clone();
    cargo.root.scaling.copyFrom(scaling ?? Vector3.OneReadOnly);
    cargo.root.computeWorldMatrix(true);
    cargo.outputOwner && this.applyGeneratedOutputPresentation(cargo.outputOwner);
  }


  /** 创建编辑态空生成器的青色线框标记；标记只属于 Babylon 运行时。 */
  public createModelGeneratorMarker(entityId: string, root: TransformNode): ModelGeneratorMarkerRuntimeEntry {
    const mesh = MeshBuilder.CreateBox(`${entityId}_modelGeneratorMarker`, { size: 0.8 }, this.context.scene);
    const material = new StandardMaterial(`${entityId}_modelGeneratorMarkerMaterial`, this.context.scene);
    material.disableLighting = true;
    material.wireframe = true;
    material.alpha = MODEL_GENERATOR_MARKER_ALPHA;
    material.diffuseColor = Color3.FromHexString(MODEL_GENERATOR_MARKER_COLOR);
    material.emissiveColor = Color3.FromHexString(MODEL_GENERATOR_MARKER_COLOR);

    mesh.parent = root;
    mesh.position.y = 0.4;
    mesh.material = material;
    mesh.metadata = { ...(mesh.metadata ?? {}), [EDITOR_ENTITY_ID_METADATA_KEY]: entityId };
    return { mesh, material };
  }

  /** 创建内置基础网格生成输出，并挂到生成器稳定根节点下。 */
  public createModelGeneratorMeshOutput(
    runtimeEntry: GeneratedOutputOwnerRuntimeEntry,
    target: Extract<ModelGeneratorTarget, { kind: 'mesh' }>,
  ): ModelGeneratorMeshOutputRuntimeEntry {
    const mesh = this.createModelGeneratorMesh(runtimeEntry.entityId, target.meshKind);
    const material = new StandardMaterial(
      `${runtimeEntry.entityId}_generated_${target.meshKind}_material`,
      this.context.scene,
    );
    mesh.parent = runtimeEntry.root;
    mesh.position.y = getBuiltInMeshGroundOffsetMeters(target.meshKind);
    mesh.material = material;
    mesh.metadata = {
      ...(mesh.metadata ?? {}),
      editorMeshKind: target.meshKind,
      ...runtimeEntry.metadata,
      ...(runtimeEntry.editorEntityId ? { [EDITOR_ENTITY_ID_METADATA_KEY]: runtimeEntry.editorEntityId } : {}),
    };
    mesh.isPickable = true;

    return {
      kind: 'mesh',
      target,
      mesh,
      material,
    };
  }

  /** 按内置类型创建生成器输出 Mesh，几何语义与模型库基础网格保持一致。 */
  public createModelGeneratorMesh(entityId: string, meshKind: MeshKind): Mesh {
    if (meshKind === 'sphere') {
      return MeshBuilder.CreateSphere(`${entityId}_generatedSphere`, { diameter: BUILT_IN_SPHERE_DIAMETER_METERS }, this.context.scene);
    }
    if (meshKind === 'plane') {
      return MeshBuilder.CreateGround(
        `${entityId}_generatedPlane`,
        { width: BUILT_IN_PLANE_SIZE_METERS, height: BUILT_IN_PLANE_SIZE_METERS },
        this.context.scene,
      );
    }
    return MeshBuilder.CreateBox(
      `${entityId}_generatedCube`,
      { size: BUILT_IN_BOX_SIZE_METERS },
      this.context.scene,
    );
  }

  /** 为模型生成器完整运行时配置生成稳定签名，配置变化时统一释放旧自动货物。 */
  public createModelGeneratorRuntimeConfigSignature(component: ModelGeneratorComponent): string {
    return JSON.stringify({
      defaultTarget: component.defaultTarget,
      rules: component.rules,
    });
  }

  /** 释放生成器当前派生输出；稳定根节点和空状态标记保持不变。 */
  public disposeModelGeneratorOutput(runtimeEntry: GeneratedOutputOwnerRuntimeEntry): void {
    const output = runtimeEntry.output;
    if (!output) return;
    runtimeEntry.output = null;
    try {
      if (output.kind === 'model') this.tryRetainGeneratedCargoModel(runtimeEntry, output.model);
    } finally {
      // 即使释放异常，宿主也不再持有待释放输出，避免重入或迟到回调再次使用。
      try { this.disposeModelGeneratorOutputValue(output); }
      finally { this.dependencies.readiness.invalidateModelStatistics(); }
    }
  }

  /** 限定普通货物、当前生成器配置与标准静态共享策略；其它所有权保持原加载/释放路径。 */
  private getGeneratedCargoPoolIdentity(owner: GeneratedOutputOwnerRuntimeEntry, asset: ModelAssetComponent, model: ModelRuntimeEntry) {
    if (!this.generatedCargoInstancePool.getMetrics().enabled || owner.metadata.generatedCargo !== true) return null;
    const generatorId = owner.metadata.generatorEntityId;
    const generator = typeof generatorId === 'string' ? this.modelGenerators.get(generatorId) : undefined;
    if (!generator || resolveModelAssetSharedInstancingPolicy(asset).mode !== 'shared-instance') {
      this.generatedCargoInstancePool.recordRejection('non-static-policy-or-generator'); return null;
    }
    const selection = this.dependencies.selection;
    if (model.highlighted || selection.selectedEntityIds.has(owner.entityId) || selection.localHighlightedEntityIds.has(owner.entityId)
      || selection.externalHighlightedEntityIds.has(owner.entityId)) {
      this.generatedCargoInstancePool.recordRejection('selected-or-highlighted'); return null;
    }
    // 复用不会重发物理mesh/TransformNode added；未知订阅者可能持有旧业务身份，因此保守走新实例。
    if (this.context.scene.onNewTransformNodeAddedObservable.hasObservers()
      || this.context.scene.onNewMeshAddedObservable.observers.some(observer => observer !== this.dependencies.readiness.modelStatisticsMeshAddedObserver)) {
      this.generatedCargoInstancePool.recordRejection('unknown-scene-added-observer'); return null;
    }
    const templateKey = createModelAssetTemplateKey(asset);
    if (!templateKey) return null;
    return { generatorId: generator.entityId, key: JSON.stringify([generator.runtimeConfigSignature, templateKey, model.assetSignature]) };
  }

  private tryRetainGeneratedCargoModel(owner: GeneratedOutputOwnerRuntimeEntry, model: ModelRuntimeEntry): void {
    const entry = this.generatedCargoPoolEntries.get(model);
    if (!entry || !model.resolvedModelAsset || model.assetHandle !== entry.assets.handle) return;
    const identity = this.getGeneratedCargoPoolIdentity(owner, model.resolvedModelAsset, model);
    if (!identity || identity.generatorId !== entry.generatorId || identity.key !== entry.key) return;
    if (model.externalScriptRuntime || model.externalScriptStarting || model.externalScriptSignature || model.parameterBaseline.size
      || model.textureCache.size || model.modelArrayBatch || model.modelArraySuspendedMeshes.size || model.telemetryProxySource) {
      this.generatedCargoInstancePool.recordRejection('dynamic-model-state'); return;
    }
    if (!this.generatedCargoInstancePool.put(entry, model.contentRoot)) return;
    // 先断开原model所有权，空刷新显式通知lighting dirty；随后原contentRoot.dispose释放分类scope。
    this.generatedCargoPoolEntries.delete(model);
    model.assetHandle = null;
    this.dependencies.assets.refreshModelMeshes(model, {});
  }

  /** 释放单个生成模型条目，普通生成模型与组合成员模型共用。 */
  public disposeGeneratedModelEntry(model: ModelRuntimeEntry): void {
    const poolEntry = this.generatedCargoPoolEntries.get(model);
    this.generatedCargoPoolEntries.delete(model);
    model.telemetryPreviewBaseline = null;
    this.dependencies.selection.applyModelSelection(model, false);
    model.externalScriptRuntime?.dispose();
    for (const texture of model.textureCache.values()) {
      texture.dispose();
    }
    if (poolEntry && model.assetHandle === poolEntry.assets.handle) this.generatedCargoInstancePool.discard(poolEntry);
    else model.assetHandle?.dispose();
    model.contentRoot.dispose();
    model.root.dispose();
  }

  /** 释放任意生成器派生输出。 */
  public disposeModelGeneratorOutputValue(output: ModelGeneratorOutputRuntimeEntry): void {
    if (output.kind === 'mesh') {
      output.material.dispose();
      output.mesh.dispose();
      return;
    }

    if (output.kind === 'composition') {
      for (const member of output.members) {
        if (member.arrayBatch) {
          // 批次网格挂在组合根下，先脱离父级避免 tree.dispose 递归二次释放共享 Geometry。
          for (const mesh of member.arrayBatch.meshes) mesh.parent = null;
          member.arrayBatch.dispose();
        }
        if (member.model) this.disposeGeneratedModelEntry(member.model);
        member.material?.dispose();
        if (member.mesh) {
          member.mesh.parent = null;
          member.mesh.dispose();
        }
      }
      output.tree.dispose();
      return;
    }

    this.disposeGeneratedModelEntry(output.model);
  }

  /** 释放模型生成器配置标记、独立输出根节点、以其为模板的货物和异步资源。 */
  public disposeModelGenerator(entityId: string, runtimeEntry: ModelGeneratorRuntimeEntry): void {
    runtimeEntry.loadToken += 1;
    this.generatedOutputOwners.delete(runtimeEntry.entityId);
    this.modelGenerators.delete(entityId);
    runSceneRuntimeCleanup(this.context, `生成器预取 ${entityId}`, () => this.generatorAssetPreloader.remove(entityId));
    runSceneRuntimeCleanup(this.context, `生成器货物 ${entityId}`, () => this.dependencies.telemetry.specializedTelemetryRuntime.disposeCargoForGenerator(entityId));
    runSceneRuntimeCleanup(this.context, `生成器输出 ${entityId}`, () => this.disposeModelGeneratorOutput(runtimeEntry));
    runSceneRuntimeCleanup(this.context, `生成器复用池 ${entityId}`, () => this.generatedCargoInstancePool.clearGenerator(entityId));
    runSceneRuntimeCleanup(this.context, `生成器标记材质 ${entityId}`, () => runtimeEntry.marker.material.dispose());
    runSceneRuntimeCleanup(this.context, `生成器标记网格 ${entityId}`, () => runtimeEntry.marker.mesh.dispose());
    runSceneRuntimeCleanup(this.context, `生成器标记根 ${entityId}`, () => runtimeEntry.markerRoot.dispose());
    runSceneRuntimeCleanup(this.context, `生成器根 ${entityId}`, () => runtimeEntry.root.dispose());
    runtimeEntry.failedTargetSignatures.clear();
    runtimeEntry.reportedLoadFailureKeys.clear();
  }

  // ===== 设备产生器（deviceSpawner）=====

  /** 同步设备产生器编辑态标记；实例产生逻辑仅在运行预览时由 DeviceSpawnerRuntime 驱动。 */
  public syncDeviceSpawnerEntity(entity: Entity, selected: boolean): void {
    if (this.updatesStopped) return;
    if (!entity.components.deviceSpawner) return;

    let marker = this.deviceSpawnerMarkers.get(entity.id);
    if (!marker) {
      const root = new TransformNode(`${entity.id}_deviceSpawnerMarkerRoot`, this.context.scene);
      const mesh = MeshBuilder.CreateBox(`${entity.id}_deviceSpawnerMarker`, { size: 0.8 }, this.context.scene);
      const material = new StandardMaterial(`${entity.id}_deviceSpawnerMarkerMaterial`, this.context.scene);
      material.disableLighting = true;
      material.wireframe = true;
      material.alpha = MODEL_GENERATOR_MARKER_ALPHA;
      material.diffuseColor = Color3.FromHexString(DEVICE_SPAWNER_MARKER_COLOR);
      material.emissiveColor = Color3.FromHexString(DEVICE_SPAWNER_MARKER_COLOR);
      mesh.parent = root;
      mesh.position.y = 0.4;
      mesh.material = material;
      mesh.metadata = { ...(mesh.metadata ?? {}), [EDITOR_ENTITY_ID_METADATA_KEY]: entity.id };
      marker = { root, mesh, material };
      this.deviceSpawnerMarkers.set(entity.id, marker);
    }

    this.dependencies.presentation.applyTransform(marker.root, entity.components.transform);
    const visible = this.dependencies.document.isEntityVisible(entity.id);
    const showMarker = visible && !this.dependencies.telemetry.telemetryPreviewActive;
    marker.root.setEnabled(visible);
    marker.mesh.isVisible = showMarker;
    marker.mesh.isPickable = showMarker && this.dependencies.document.isEntityScenePickable(entity.id);
    marker.material.alpha = selected ? 1 : MODEL_GENERATOR_MARKER_ALPHA;
  }

  /** 释放设备产生器编辑态标记。 */
  public disposeDeviceSpawnerMarker(entityId: string): void {
    const marker = this.deviceSpawnerMarkers.get(entityId);
    if (!marker) return;
    marker.material.dispose();
    marker.mesh.dispose();
    marker.root.dispose();
    this.deviceSpawnerMarkers.delete(entityId);
  }

  /** 预览态切换时刷新全部产生器标记显隐（运行态隐藏编辑标记）。 */
  public syncDeviceSpawnerMarkerVisibility(): void {
    for (const [entityId, marker] of this.deviceSpawnerMarkers.entries()) {
      const visible = this.dependencies.document.isEntityVisible(entityId);
      const showMarker = visible && !this.dependencies.telemetry.telemetryPreviewActive;
      marker.root.setEnabled(visible);
      marker.mesh.isVisible = showMarker;
      marker.mesh.isPickable = showMarker && this.dependencies.document.isEntityScenePickable(entityId);
    }
  }

  /** 运行预览开始时从文档解析产生器配置并注册；模板无效的产生器跳过并提示。 */
  public configureDeviceSpawnersFromDocument(): void {
    if (this.updatesStopped || this.dependencies.document.disposed) return;
    const document = this.dependencies.document.shadowDocument;
    if (!document) return;
    this.deviceSpawningStopped = false;

    const configs: DeviceSpawnerConfig[] = [];
    for (const entityId of document.entityIds) {
      const entity = document.entities[entityId];
      const component = entity?.components.deviceSpawner;
      if (!entity || !component || !component.spawnerCode) continue;
      const templateEntity = component.templateEntityId ? document.entities[component.templateEntityId] : undefined;
      if (!templateEntity?.components.modelAsset) {
        Reflect.apply(this.context.pushLog, this.context.callbackReceiver, [`设备产生器“${entity.name}”未绑定有效模板实例，本次预览不生效。`]);
        continue;
      }
      const deviceType = (
        templateEntity.components.telemetryBinding?.deviceType
        || templateEntity.components.modelAsset.dataDrivenConfig?.device.devType
        || ''
      ).trim().toLowerCase();
      configs.push({
        entityId,
        entityName: entity.name,
        spawnerCode: component.spawnerCode,
        templateEntityId: templateEntity.id,
        timeoutSeconds: component.timeoutSeconds,
        deviceType,
      });
    }
    this.deviceSpawnerRuntime.configure(configs);
  }

  /**
   * topic (sourceId, deviceType, assetCode) 是否已命中既有设备：动态实例（含加载中）直接查产生器运行时；
   * 静态侧遍历场景文档的遥测绑定（与模型加载进度无关，消除首帧前窗口）。绑定未显式声明设备类型时
   * 按编号保守视为已占用，避免与自动探测类型的静态设备重号。
   */
  public isTelemetryDeviceKnown(sourceId: string, deviceType: string, assetCode: string): boolean {
    if (this.deviceSpawnerRuntime.hasAssetCode(assetCode)) return true;
    const document = this.dependencies.document.shadowDocument;
    if (!document) return false;
    const normalizedSourceId = sourceId.trim() || 'default';
    const normalizedDeviceType = deviceType.trim().toLowerCase();
    for (const entityId of document.entityIds) {
      const entity = document.entities[entityId];
      const binding = entity?.components.telemetryBinding;
      if (!entity || !binding || binding.enabled === false) continue;
      const boundAssetCode = binding.assetCode?.trim() || entity.components.modelAsset?.assetCode?.trim() || '';
      if (!boundAssetCode || boundAssetCode !== assetCode) continue;
      if ((binding.sourceId?.trim() || 'default') !== normalizedSourceId) continue;
      const boundDeviceType = binding.deviceType?.trim().toLowerCase() ?? '';
      if (boundDeviceType && boundDeviceType !== normalizedDeviceType) continue;
      return true;
    }
    return false;
  }

  /** 基于模板实体派生一台动态设备实例；模板模型未加载完成时返回 false，等待下一条消息重试。 */
  public spawnDeviceInstance(spawner: DeviceSpawnerConfig, assetCode: string): boolean {
    if (this.deviceSpawningStopped || this.dependencies.document.disposed) return false;
    const key = createSpawnedDeviceKey(spawner.spawnerCode, assetCode);
    if (this.spawnedDeviceModels.has(key)) return true;

    const templateEntity = this.dependencies.document.shadowDocument?.entities[spawner.templateEntityId];
    const templateModelAsset = templateEntity?.components.modelAsset;
    const templateModel = this.dependencies.assets.models.get(spawner.templateEntityId);
    if (!templateEntity || !templateModelAsset || !templateModel?.assetHandle) return false;

    // 拷贝模板参数，assetCode 由消息提供；绑定 assetCode 显式覆盖，防止指向模板自身编号。
    const modelAsset: ModelAssetComponent = {
      ...(JSON.parse(JSON.stringify(templateModelAsset)) as Omit<ModelAssetComponent, 'assetCode'>),
      assetCode,
    };
    const templateBinding = templateEntity.components.telemetryBinding;
    const telemetryBinding: TelemetryBindingComponent | null = templateBinding
      ? { ...(JSON.parse(JSON.stringify(templateBinding)) as TelemetryBindingComponent), assetCode }
      : null;
    // 合成实体快照供驱动读取参数（shuttle/stacker 经 entitySnapshot 取 parameterValues）。
    const entitySnapshot: Entity = {
      ...(JSON.parse(JSON.stringify(templateEntity)) as Entity),
      id: `spawned:${key}`,
      components: {
        ...(JSON.parse(JSON.stringify(templateEntity.components)) as Entity['components']),
        modelAsset,
        ...(telemetryBinding ? { telemetryBinding } : {}),
      },
    };

    const root = new TransformNode(`spawnedDevice_${spawner.spawnerCode}_${assetCode}`, this.context.scene);
    // 继承模板实例的完整变换（位置/旋转/缩放），与常规实体 root 同源。
    this.dependencies.presentation.applyTransform(root, templateEntity.components.transform);
    // 先隐藏：异步加载与脚本初始化期间设备仍停在模板位姿，等首帧驱动吸附到 MQTT 目标位后再显示。
    // 隐藏走 layerMask=0（见 setSpawnedDeviceMeshesVisible），禁用 root 或 isVisible=false 都会被脚本
    // 捕获/过滤（isEnabled 基线快照、isBoundsMesh 过滤），导致参数化（主体颜色/尺寸拉伸）丢失或整车永隐。
    // root 启用期间 contentRoot 下无内容，本就无可渲染网格；网格挂载后再隐藏。
    this.spawnedDeviceRevealPending.add(key);
    const contentRoot = new TransformNode(`spawnedDevice_${spawner.spawnerCode}_${assetCode}_content`, this.context.scene);
    contentRoot.parent = root;
    this.dependencies.parameters.applyModelUnitScale(contentRoot, modelAsset.unitScaleToMeters);

    const modelLoadToken = ++this.dependencies.assets.modelLoadSequence;
    const model: ModelRuntimeEntry = {
      sourceUrl: modelAsset.sourceUrl,
      assetRevision: modelAsset.assetRevision ?? null,
      assetSignature: this.dependencies.assets.createModelAssetSignature(modelAsset),
      entitySnapshot,
      assetCode,
      telemetryBinding,
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
      loadToken: modelLoadToken,
      cancelLoad: null,
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
    this.spawnedDeviceModels.set(key, model);

    void this.dependencies.assets.loadModelRuntimeAssets(modelAsset, model.assetSignature, undefined, model.entitySnapshot?.id ?? model.root.name)
      .then((loadedAssets) => {
        if (this.spawnedDeviceModels.get(key) !== model || model.loadToken !== modelLoadToken) {
          loadedAssets.handle.dispose();
          return;
        }

        model.assetHandle = loadedAssets.handle;
        if (loadedAssets.kind === 'owned-container') {
          model.meshes = loadedAssets.meshes;
          this.dependencies.assets.parentTopLevelModelNodes(model, loadedAssets.transformNodes);
        } else {
          for (const rootNode of loadedAssets.rootNodes) {
            rootNode.parent = model.contentRoot;
          }
        }

        this.refreshSpawnedDeviceModelMeshes(model, spawner);
        this.setSpawnedDeviceMeshesVisible(model, false);
        this.dependencies.assets.normalizeModelContentOrigin(model);
        this.dependencies.parameters.applyModelAssetParameters(modelAsset, model);
        this.dependencies.assets.syncModelAssetExternalScripts(modelAsset, model, (current) => {
          if (this.spawnedDeviceModels.get(key) !== current) return;
          this.refreshSpawnedDeviceModelMeshes(current, spawner);
          // 脚本 start 可能新建网格，待揭示期间统一保持隐藏。
          if (this.spawnedDeviceRevealPending.has(key)) {
            this.setSpawnedDeviceMeshesVisible(current, false);
          }
        });
      })
      .catch((error: unknown) => {
        if (this.spawnedDeviceModels.get(key) !== model) return;
        this.disposeSpawnedDeviceModel(key);
        this.deviceSpawnerRuntime.dropInstance(key);
        const message = error instanceof Error ? error.message : String(error);
        Reflect.apply(this.context.pushLog, this.context.callbackReceiver, [`设备产生器实例加载失败（${assetCode}）：${message}`]);
      });

    return true;
  }

  /**
   * 收集动态实例网格并补齐生成器产物点击元数据。
   * 实例始终不进入编辑选择（缺 editorEntityId），可拾取只为生成器产物点击链路服务。
   */
  public refreshSpawnedDeviceModelMeshes(model: ModelRuntimeEntry, spawner: DeviceSpawnerConfig): void {
    this.dependencies.assets.refreshModelMeshes(model, {
      deviceSpawnerSpawned: true,
      spawnerEntityId: spawner.entityId,
      spawnedEntityId: createSpawnedDeviceEntityId(spawner.spawnerCode, model.assetCode),
      spawnedAssetCode: model.assetCode,
    });
    for (const mesh of model.meshes) {
      mesh.isPickable = true;
    }
  }

  /**
   * 揭示已就绪的生成实例：模型加载 + 脚本初始化完成（= 通过驱动候选门槛）后，
   * 首帧驱动已在同一帧把它吸附到 MQTT 目标位，此时显示即直接出现在目标位、无模板位闪现。
   * 无有效快照的设备不会被驱动，按模板位姿显示（本就不产生位移）。
   */
  public revealDrivenSpawnedDevices(): void {
    if (this.spawnedDeviceRevealPending.size === 0) return;
    for (const key of [...this.spawnedDeviceRevealPending]) {
      const model = this.spawnedDeviceModels.get(key);
      if (!model) {
        this.spawnedDeviceRevealPending.delete(key);
        continue;
      }
      if (!model.assetHandle || !model.stackerTelemetryReady) continue;
      this.setSpawnedDeviceMeshesVisible(model, true);
      this.spawnedDeviceRevealPending.delete(key);
    }
  }

  /** 生成实例隐藏期的网格级显隐：走 layerMask=0 渲染剔除，不动 enabled/isVisible/visibility——脚本会捕获 enabled 基线、过滤 isVisible=false 的网格，这两条路都会让参数化丢失。 */
  public setSpawnedDeviceMeshesVisible(model: ModelRuntimeEntry, visible: boolean): void {
    for (const mesh of model.meshes) {
      if (visible) {
        const original = this.spawnedDeviceHiddenLayerMasks.get(mesh.uniqueId);
        if (original !== undefined) {
          mesh.layerMask = original;
          this.spawnedDeviceHiddenLayerMasks.delete(mesh.uniqueId);
        }
      } else {
        if (!this.spawnedDeviceHiddenLayerMasks.has(mesh.uniqueId)) {
          this.spawnedDeviceHiddenLayerMasks.set(mesh.uniqueId, mesh.layerMask);
        }
        mesh.layerMask = 0;
      }
    }
  }

  /** 销毁一台动态设备实例；负载中的异步加载通过 loadToken 失效自行丢弃。 */
  public disposeSpawnedDeviceModel(key: string): void {
    const model = this.spawnedDeviceModels.get(key);
    if (!model) return;
    this.spawnedDeviceModels.delete(key);
    this.spawnedDeviceRevealPending.delete(key);
    for (const mesh of model.meshes) {
      this.spawnedDeviceHiddenLayerMasks.delete(mesh.uniqueId);
    }
    model.loadToken += 1;
    runSceneRuntimeCleanup(this.context, `动态设备脚本 ${key}`, () => model.externalScriptRuntime?.dispose());
    for (const texture of model.textureCache.values()) {
      runSceneRuntimeCleanup(this.context, `动态设备纹理 ${key}`, () => texture.dispose());
    }
    model.textureCache.clear();
    runSceneRuntimeCleanup(this.context, `动态设备资产 ${key}`, () => model.assetHandle?.dispose());
    runSceneRuntimeCleanup(this.context, `动态设备内容节点 ${key}`, () => model.contentRoot.dispose());
    runSceneRuntimeCleanup(this.context, `动态设备根节点 ${key}`, () => model.root.dispose());
  }

  /** 仅同步模型生成器配置标记；自动货物不继承实体显隐、锁定或选中状态。 */
  public applyModelGeneratorPresentation(runtimeEntry: ModelGeneratorRuntimeEntry): void {
    const visible = this.dependencies.document.isEntityVisible(runtimeEntry.entityId);
    const pickable = visible && this.dependencies.document.isEntityScenePickable(runtimeEntry.entityId);
    const showMarker = visible && !this.dependencies.telemetry.telemetryPreviewActive;

    runtimeEntry.markerRoot.setEnabled(visible);
    runtimeEntry.marker.mesh.isVisible = showMarker;
    runtimeEntry.marker.mesh.isPickable = showMarker && pickable;
    runtimeEntry.marker.material.alpha = runtimeEntry.selected ? 1 : MODEL_GENERATOR_MARKER_ALPHA;
    runtimeEntry.marker.material.diffuseColor = Color3.FromHexString(MODEL_GENERATOR_MARKER_COLOR);
    runtimeEntry.marker.material.emissiveColor = Color3.FromHexString(MODEL_GENERATOR_MARKER_COLOR);
  }

  /**
   * 统一同步生成输出可视状态。
   * 生成产物一律可拾取：常规实体拾取按元数据里的 editorEntityId 过滤，产物本来就不带，
   * 可拾取只为生成器产物点击链路服务；组合里的阵列成员由 thinInstance 批次承载，
   * 批次网格同样开放实例级拾取（refreshModelGeneratorModelMeshes 已下发产物元数据）。
   */
  public applyGeneratedOutputPresentation(runtimeEntry: GeneratedOutputOwnerRuntimeEntry): void {
    if (runtimeEntry.output?.kind === 'mesh') {
      runtimeEntry.output.mesh.isVisible = true;
      runtimeEntry.output.mesh.isPickable = true;
      runtimeEntry.output.material.diffuseColor = this.dependencies.presentation.readColor(runtimeEntry.output.target.materialColor);
      runtimeEntry.output.material.emissiveColor = Color3.Black();
      return;
    }

    if (runtimeEntry.output?.kind === 'model') {
      runtimeEntry.output.model.root.setEnabled(true);
      this.dependencies.selection.applyModelSelection(runtimeEntry.output.model, false);
      for (const mesh of runtimeEntry.output.model.meshes) {
        mesh.isPickable = true;
      }
      this.updateModelGeneratorOutputRuntimeContext(runtimeEntry);
      return;
    }

    if (runtimeEntry.output?.kind === 'composition') {
      for (const member of runtimeEntry.output.members) {
        if (member.model) {
          member.model.root.setEnabled(true);
          for (const mesh of member.model.meshes) {
            mesh.isPickable = true;
          }
        }
        if (member.mesh) {
          member.mesh.isVisible = true;
          member.mesh.isPickable = true;
        }
        if (member.arrayBatch) {
          for (const mesh of member.arrayBatch.meshes) {
            mesh.isPickable = true;
            mesh.thinInstanceEnablePicking = true;
          }
        }
      }
    }
  }
  /** 按原构造顺序连接此领域的资源与回调。 */
  initializeDeviceSpawnerRuntime(): void {
    this.deviceSpawnerRuntime = new DeviceSpawnerRuntime({
      pushLog: (message) => Reflect.apply(this.context.pushLog, this.context.callbackReceiver, [message]),
      spawnDeviceInstance: (spawner, assetCode) => this.spawnDeviceInstance(spawner, assetCode),
      disposeDeviceInstance: (key) => this.disposeSpawnedDeviceModel(key),
      isDeviceKnown: (sourceId, deviceType, assetCode) => this.isTelemetryDeviceKnown(sourceId, deviceType, assetCode),
    });
  }

}
