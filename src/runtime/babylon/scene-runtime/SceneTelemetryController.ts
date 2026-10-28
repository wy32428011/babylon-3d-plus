import { MotionStaticBatchRuntime } from '../MotionStaticBatchRuntime';
import { Scene } from '@babylonjs/core/scene.js';
import type { Nullable, Observer } from '@babylonjs/core';
import { ConveyorSurfaceArrowRenderer } from '../effects/ConveyorSurfaceArrowRenderer';
import { ConveyorSurfaceArrowSystem } from '../telemetry/ConveyorSurfaceArrowSystem';
import { buildArrowModelViews, type ArrowModelViews, type ArrowSystemKind } from '../telemetry/arrowModelViews';
import { StackerMotionArrowSystem } from '../telemetry/StackerMotionArrowSystem';
import { StackerMotionArrowRenderer } from '../effects/StackerMotionArrowRenderer';
import { RgvMotionArrowSystem } from '../telemetry/RgvMotionArrowSystem';
import { RgvMotionArrowRenderer } from '../effects/RgvMotionArrowRenderer';
import { LiftMotionArrowSystem } from '../telemetry/LiftMotionArrowSystem';
import { LiftMotionArrowRenderer } from '../effects/LiftMotionArrowRenderer';
import { type ExternalModelScriptRuntimeMode, type ExternalModelScriptTelemetrySnapshot } from '../ExternalModelScriptRuntime';
import { captureModelTelemetryPreviewBaseline, restoreModelTelemetryPreviewBaseline } from '../telemetry/telemetryPreviewBaseline';
import { type DeviceTelemetrySnapshot } from '../../mqtt/deviceTelemetry';
import { resetConveyorTelemetryState, resetHcliftTelemetryState, resetLiftTelemetryState, resetRgvTelemetryState, resetShuttleTelemetryState, resetStackerTelemetryState } from '../telemetry/specialized/specializedModelAssets';
import { SpecializedTelemetryRuntime } from '../telemetry/specialized/SpecializedTelemetryRuntime';
import type { SpecializedTelemetryHost } from '../telemetry/specialized/types';
import type { SceneRuntimeContext } from './SceneRuntimeContext';
import { runSceneRuntimeCleanup } from './sceneRuntimeCleanup';
import type { ModelArrayRuntimeController } from './ModelArrayRuntimeController';
import type { ModelAssetRuntimeController } from './ModelAssetRuntimeController';
import type { ParameterVariantHostPool } from './ParameterVariantHostPool';
import type { GeneratedModelOutputController } from './GeneratedModelOutputController';
import type { SceneLocatorController } from './SceneLocatorController';
import type { SceneLocatorFetchController } from './SceneLocatorFetchController';
import type { SceneWorldBoundsController } from './SceneWorldBoundsController';
import type { SceneTransformPreviewController } from './SceneTransformPreviewController';
import type { SceneMeshPresentationController } from './SceneMeshPresentationController';
import type { ScenePatrolAndRoamController } from './ScenePatrolAndRoamController';
import type { ScenePoiAndEffectsController } from './ScenePoiAndEffectsController';
import type { SceneDocumentController } from './SceneDocumentController';
import type { ScenePickingAndSelectionController } from './ScenePickingAndSelectionController';
import type { EnvironmentAndSkyboxController } from './EnvironmentAndSkyboxController';
import type { SceneTriangleAndReadinessController } from './SceneTriangleAndReadinessController';
import { type ModelRuntimeEntry } from './sceneRuntimeTypes';

/** 此领域仅能访问明确列出的协作能力，资源与缓存由所属 Controller 持有。 */
type Dependencies = {
  readonly arrays: Pick<ModelArrayRuntimeController, 'modelArrayBatchByMeshUniqueId' | 'modelArrayTelemetryProxies' | 'refreshModelArrayRuntimeRepresentation' | 'prepareModelArrayRuntimeMutation'>;
  readonly assets: Pick<ModelAssetRuntimeController, 'models'>;
  readonly variants: Pick<ParameterVariantHostPool, 'modelArrayParameterVariants'>;
  readonly outputs: Pick<GeneratedModelOutputController, 'spawnedDeviceModels' | 'getGeneratedCargoFallbackSpec' | 'ensureGeneratedCargoFallback' | 'ensureGeneratedCargoOutputOwner' | 'syncGeneratedCargoVisual' | 'setGeneratedCargoRootPose' | 'disposeGeneratedCargo' | 'clearModelGeneratorLoadFailureCache' | 'syncAllModelGeneratorPresentations' | 'syncDeviceSpawnerMarkerVisibility' | 'configureDeviceSpawnersFromDocument' | 'deviceSpawnerRuntime' | 'stopDeviceSpawning' | 'generatedOutputOwners' | 'revealDrivenSpawnedDevices'>;
  readonly locators: Pick<SceneLocatorController, 'findLocatorByDevice' | 'findLocatorsByDevice' | 'findLocatorByAisle' | 'findLocatorsByAisle' | 'findLayerChangePlatformLocator' | 'findBuiltInSlotLocatorForHostModel' | 'resolveBuiltInSlotHost' | 'resolveCargoGeneratorForModel' | 'resolveColumnTargetPose' | 'refreshAllBuiltInSlotRenderability'>;
  readonly fetch: Pick<SceneLocatorFetchController, 'resolveFetchDriveRowForLocator' | 'suppressFetchCellForLocator' | 'retainFetchCellForLocator' | 'releaseRetainedFetchCellForLocator' | 'handleFetchRowSync' | 'keepCargoForFetchRowSync' | 'stopPreviewRequests' | 'resetPreview'>;
  readonly bounds: Pick<SceneWorldBoundsController, 'getModelWorldBounds'>;
  readonly transforms: Pick<SceneTransformPreviewController, 'clearEntityArrayPreview' | 'clearFolderGroupGizmoTarget'>;
  readonly presentation: Pick<SceneMeshPresentationController, 'lightMarkerRuntime' | 'meshes'>;
  readonly patrol: Pick<ScenePatrolAndRoamController, 'autoPatrolMarkerRuntime' | 'manualRoamSpawnRuntime'>;
  readonly effects: Pick<ScenePoiAndEffectsController, 'clickEventBindingRuntime' | 'cancelModelEntrance' | 'alarmRuntime' | 'alarmManagerIds' | 'modelEntranceRuntime' | 'modelEntranceVisible' | 'poiEffectRuntime'>;
  readonly document: Pick<SceneDocumentController, 'isEntityVisible' | 'flushSingleTransformPreview' | 'shadowDocument' | 'isEntityScenePickable' | 'disposed'>;
  readonly selection: Pick<ScenePickingAndSelectionController, 'setLocalSlotHighlight' | 'outlinedModelArrayBatches' | 'rebuildModelSelectionOutline'>;
  readonly environment: Pick<EnvironmentAndSkyboxController, 'shadowRuntime' | 'lightingRuntime'>;
  readonly readiness: Pick<SceneTriangleAndReadinessController, 'invalidateModelStatistics'>;
};


type TelemetryModelSnapshotEntry = { readonly entityId: string; readonly model: ModelRuntimeEntry };

/** SceneTelemetryController 的资源、状态及取消/释放操作在同一领域内维护。 */
export class SceneTelemetryController {
  constructor(private readonly context: SceneRuntimeContext, private readonly dependencies: Dependencies) {}

  public telemetryObserver!: Nullable<Observer<Scene>>;
  public specializedTelemetryRuntime!: SpecializedTelemetryRuntime;
  public conveyorSurfaceArrowSystem!: ConveyorSurfaceArrowSystem;
  public stackerMotionArrowSystem!: StackerMotionArrowSystem;
  public hasStackerMotionArrows = false;
  public rgvMotionArrowSystem!: RgvMotionArrowSystem;
  public hasRgvMotionArrows = false;
  public liftMotionArrowSystem!: LiftMotionArrowSystem;
  public hasLiftMotionArrows = false;
  public hasConveyorSurfaceArrows = false;
  public motionStaticBatchRuntime!: MotionStaticBatchRuntime;
  // 尚未验证性能收益；通过既有显式实验 API 启用，默认保留原绘制。
  public motionStaticBatchingEnabled = false;
  public readonly controlledMotionObservers = new WeakSet<object>();
  public hostMotionObserversRegistered = false;
  public telemetryPreviewActive = false;
  public telemetryPerformanceTimingEnabled = false;
  public telemetryFrameTimeMs: number | null = null;
  public readonly telemetryOuterStages = { diagnosticsMs: 0, baselineMs: 0, alarmsMs: 0 };
  public telemetryMaxFrameTimeMs: number | null = null;
  private collectedModels: readonly TelemetryModelSnapshotEntry[] | null = null;
  private modelEntranceHidden = false;
  private updatesStopped = false;
  private disposed = false;

  /** 入场仅影响运动箭头显示，遥测和原有箭头开关继续运行。 */
  setModelEntranceHidden(hidden: boolean): void {
    if (!this.updatesStopped) this.modelEntranceHidden = hidden;
  }

  /** 最终销毁的第一阶段；先停帧回调并归还合批接管的原件，光照与模型资源此时仍须存活。 */
  stopUpdates(): void {
    if (this.updatesStopped) return;
    this.updatesStopped = true;
    if (this.telemetryObserver) this.context.scene.onBeforeRenderObservable.remove(this.telemetryObserver);
    this.telemetryObserver = null;
    runSceneRuntimeCleanup(this.context, '遥测动静合批', () => this.motionStaticBatchRuntime.dispose());
  }

  /** 最终销毁的释放阶段；普通退出预览不释放这些可重用系统。 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopUpdates();
    runSceneRuntimeCleanup(this.context, '遥测预览', () => this.endTelemetryPreview());
    runSceneRuntimeCleanup(this.context, '输送线箭头', () => this.conveyorSurfaceArrowSystem.dispose());
    runSceneRuntimeCleanup(this.context, '堆垛机箭头', () => this.stackerMotionArrowSystem.dispose());
    runSceneRuntimeCleanup(this.context, 'RGV 箭头', () => this.rgvMotionArrowSystem.dispose());
    runSceneRuntimeCleanup(this.context, '提升机箭头', () => this.liftMotionArrowSystem.dispose());
    runSceneRuntimeCleanup(this.context, '专用遥测', () => this.specializedTelemetryRuntime.dispose());
    this.collectedModels = null;
    this.hasConveyorSurfaceArrows = this.hasStackerMotionArrows = this.hasRgvMotionArrows = this.hasLiftMotionArrows = false;
  }

  /** 诊断开关不入文档，用于同一正式运行时的受控 A/B；需显式启用。 */
  setMotionStaticBatchingEnabled(enabled: boolean): void {
    this.motionStaticBatchingEnabled = enabled;
    this.motionStaticBatchRuntime.setEnabled(enabled);
    this.motionStaticBatchRuntime.sync();
  }

  /** 同一文件重新打开也有独立会话；烘焙期间的保守暂停只属于原会话。 */
  beginSceneSession(sessionId: string): void { this.motionStaticBatchRuntime.beginSceneSession(sessionId); }

  getMotionStaticBatchDiagnostics() {
    return { ...this.motionStaticBatchRuntime.getDiagnostics(), uncontrolledSceneObservers: this.motionObserverSources()
      .map(observable => observable.observers.filter(observer => !observer._willBeUnregistered && !this.controlledMotionObservers.has(observer)).length) };
  }

  /** 宿主同步初始化结束、模型脚本微任务执行前登记一次内建控制器；不能用于接纳稍后的未知脚本。 */
  registerHostSceneObservers(): void {
    if (this.hostMotionObserversRegistered) return;
    this.hostMotionObserversRegistered = true;
    for (const observable of this.motionObserverSources()) {
      for (const observer of observable.observers) this.controlledMotionObservers.add(observer);
    }
  }

  /** 仅包裹内建诊断器的同步构造；先前已存在的未知回调不会获得授权。 */
  withControlledSceneObservers<T>(initialize: () => T): T {
    const previous = new Set(this.motionObserverSources().flatMap(observable => observable.observers));
    try { return initialize(); }
    finally {
      for (const observable of this.motionObserverSources()) {
        for (const observer of observable.observers) if (!previous.has(observer)) this.controlledMotionObservers.add(observer);
      }
    }
  }

  public motionObserverSources(): ReadonlyArray<{ readonly observers: readonly { readonly _willBeUnregistered: boolean }[] }> {
    // 动画回调可切换整个渲染管线；候选核对后的未知回调也可能改变本帧绘制，均保守回退。
    return [this.context.scene.onBeforeAnimationsObservable, this.context.scene.onAfterAnimationsObservable,
      this.context.scene.onBeforeActiveMeshesEvaluationObservable, this.context.scene.onAfterActiveMeshesEvaluationObservable,
      this.context.scene.onBeforeRenderTargetsRenderObservable, this.context.scene.onAfterRenderTargetsRenderObservable,
      this.context.scene.onBeforeDrawPhaseObservable, this.context.scene.onAfterDrawPhaseObservable,
    ];
  }

  public areMotionObserversControlled(): boolean {
    for (const observer of this.motionStaticBatchRuntime.getControlledSceneObservers()) this.controlledMotionObservers.add(observer);
    for (const batch of new Set(this.dependencies.arrays.modelArrayBatchByMeshUniqueId.values())) {
      for (const observer of batch.getControlledSceneObservers()) this.controlledMotionObservers.add(observer);
    }
    // 不跳过任何脚本回调。beforeRender/animation结束后控制器再核对实际源状态；晚于核对的未知回调保守退出。
    return this.motionObserverSources().every(observable => observable.observers.every(observer =>
      observer._willBeUnregistered || this.controlledMotionObservers.has(observer)));
  }

  /**
   * 每次读取公开模型 Map 的实时内容和顺序；稳定集合复用快照，变化时写时复制。
   * 不以帧号、数量或 Map 引用判断有效性，嵌套收集也不能修改外层正在遍历的旧快照。
   * 只缓存成员身份，不缓存 ready、绑定或脚本 metadata，驱动仍在原检查边界读取这些可变状态。
   */
  private collectTelemetryModels(): readonly TelemetryModelSnapshotEntry[] {
    const previous = this.collectedModels;
    let next: TelemetryModelSnapshotEntry[] | null = null;
    let count = 0;
    const append = (model: ModelRuntimeEntry, entityId: string): void => {
      const cached = previous?.[count];
      if (cached?.entityId === entityId && cached.model === model) {
        next?.push(cached);
      } else {
        next ??= previous?.slice(0, count) ?? [];
        next.push({ entityId, model });
      }
      count++;
    };
    // Map.forEach 不为每个成员创建 entries() 的键值对数组。
    this.dependencies.assets.models.forEach(append);
    this.dependencies.variants.modelArrayParameterVariants.forEach(variant => append(variant.model, variant.representativeEntityId));
    this.dependencies.arrays.modelArrayTelemetryProxies.forEach(append);
    this.dependencies.outputs.spawnedDeviceModels.forEach((model, key) => append(model, `spawned:${key}`));
    this.collectedModels = next ?? (previous && count === previous.length ? previous : previous?.slice(0, count) ?? []);
    return this.collectedModels;
  }

  /** 构造专用遥测门面所需的宿主委托对象。 */
  public createSpecializedTelemetryHost(): SpecializedTelemetryHost {
    return {
      pushLog: (message) => Reflect.apply(this.context.pushLog, this.context.callbackReceiver, [message]),
      collectModels: () => this.collectTelemetryModels(),
      findLocatorByDevice: (assetCode, x, y, z, storageDepth) => this.dependencies.locators.findLocatorByDevice(assetCode, x, y, z, storageDepth),
      findLocatorsByDevice: (assetCode) => this.dependencies.locators.findLocatorsByDevice(assetCode),
      findLocatorByAisle: (aisleCode, x, y, z, storageDepth) => this.dependencies.locators.findLocatorByAisle(aisleCode, x, y, z, storageDepth),
      findLocatorsByAisle: (aisleCode) => this.dependencies.locators.findLocatorsByAisle(aisleCode),
      findLayerChangePlatformLocator: (assetCode, aisleCode) => this.dependencies.locators.findLayerChangePlatformLocator(assetCode, aisleCode),
      findBuiltInSlotLocatorForHostModel: (hostEntityId) => this.dependencies.locators.findBuiltInSlotLocatorForHostModel(hostEntityId),
      resolveBuiltInSlotHost: (locatorEntityId) => this.dependencies.locators.resolveBuiltInSlotHost(locatorEntityId),
      resolveCargoGeneratorForModel: (model) => this.dependencies.locators.resolveCargoGeneratorForModel(model),
      resolveColumnTargetPose: (entityId) => this.dependencies.locators.resolveColumnTargetPose(entityId),
      resolveFetchDriveRowForLocator: (locator) => this.dependencies.fetch.resolveFetchDriveRowForLocator(locator),
      suppressFetchCellForLocator: (locator, column, layer) => this.dependencies.fetch.suppressFetchCellForLocator(locator, column, layer),
      retainFetchCellForLocator: (locator, column, layer) => this.dependencies.fetch.retainFetchCellForLocator(locator, column, layer),
      releaseRetainedFetchCellForLocator: (locator, column, layer) => this.dependencies.fetch.releaseRetainedFetchCellForLocator(locator, column, layer),
      handleFetchRowSync: (row) => this.dependencies.fetch.handleFetchRowSync(row),
      keepCargoForFetchRowSync: (row, assetCode, cargoKey) => this.dependencies.fetch.keepCargoForFetchRowSync(row, assetCode, cargoKey),
      updateExternalScriptContext: (model, telemetry) => this.updateModelExternalScriptRuntimeContext(model, 'runtime', telemetry, true),
      refreshModelArrayRepresentation: (model) => this.dependencies.arrays.refreshModelArrayRuntimeRepresentation(model),
      getGeneratedCargoFallbackSpec: (kind) => this.dependencies.outputs.getGeneratedCargoFallbackSpec(kind),
      ensureGeneratedCargoFallback: (cargo, kind) => this.dependencies.outputs.ensureGeneratedCargoFallback(cargo, kind),
      ensureGeneratedCargoOutputOwner: (cargo, kind, component, snapshot) => this.dependencies.outputs.ensureGeneratedCargoOutputOwner(cargo, kind, component, snapshot),
      syncGeneratedCargoVisual: (cargo, kind, snapshot, generator, hostEntityId) =>
        this.dependencies.outputs.syncGeneratedCargoVisual(cargo, kind, snapshot, generator, hostEntityId),
      setGeneratedCargoRootPose: (cargo, position, rotation, scaling) => this.dependencies.outputs.setGeneratedCargoRootPose(cargo, position, rotation, scaling),
      disposeGeneratedCargo: (cargo) => this.dependencies.outputs.disposeGeneratedCargo(cargo),
      getModelWorldBounds: (model) => this.dependencies.bounds.getModelWorldBounds(model),
    } as SpecializedTelemetryHost;
  }

  /** 开始 MQTT 运行预览；该方法幂等，并在真正驱动前清空上一次预览残留运行态。 */
  beginTelemetryPreview(): void {
    if (this.telemetryPreviewActive || this.updatesStopped || this.dependencies.document.disposed) return;
    this.dependencies.transforms.clearEntityArrayPreview();
    this.dependencies.transforms.clearFolderGroupGizmoTarget();
    this.telemetryPreviewActive = true;
    this.conveyorSurfaceArrowSystem.clear();
    this.stackerMotionArrowSystem.clear();
    this.rgvMotionArrowSystem.clear();
    this.liftMotionArrowSystem.clear();
    this.dependencies.presentation.lightMarkerRuntime.setPreviewActive(true);
    this.dependencies.patrol.autoPatrolMarkerRuntime.setPreviewActive(true);
    this.dependencies.patrol.manualRoamSpawnRuntime.setPreviewActive(true);
    this.dependencies.effects.clickEventBindingRuntime.setPreviewActive(true);
    this.clearTelemetryPreviewRuntimeState();
    this.updateAllExternalScriptRuntimeContexts('runtime', null);
    this.dependencies.outputs.clearModelGeneratorLoadFailureCache();
    this.dependencies.outputs.syncAllModelGeneratorPresentations();
    this.dependencies.outputs.syncDeviceSpawnerMarkerVisibility();
    this.dependencies.outputs.configureDeviceSpawnersFromDocument();
    this.dependencies.locators.refreshAllBuiltInSlotRenderability();
  }

  /** 结束 MQTT 运行预览；该方法幂等，按驱动关闭、运行态清理、模型恢复的顺序回到编辑态。 */
  endTelemetryPreview(): void {
    runSceneRuntimeCleanup(this.context, '遥测预览复位', () => this.resetTelemetryPreview());
    this.collectedModels = null;
  }

  private resetTelemetryPreview(): void {
    const wasPreviewActive = this.telemetryPreviewActive;
    this.telemetryPreviewActive = false;
    runSceneRuntimeCleanup(this.context, '模型入场动画', () => this.dependencies.effects.cancelModelEntrance());
    this.dependencies.fetch.stopPreviewRequests();
    runSceneRuntimeCleanup(this.context, '动态设备预览', () => this.dependencies.outputs.stopDeviceSpawning());
    const hadPreviewState = wasPreviewActive
      || [...this.dependencies.assets.models.values()].some((model) => model.telemetryPreviewBaseline)
      || [...this.dependencies.outputs.generatedOutputOwners.values()].some((owner) => (
        owner.output?.kind === 'model' && owner.output.model.telemetryPreviewBaseline !== null
      ));
    if (!hadPreviewState) {
      this.dependencies.fetch.resetPreview();
      return;
    }

    runSceneRuntimeCleanup(this.context, '输送线箭头预览', () => this.conveyorSurfaceArrowSystem.clear());
    runSceneRuntimeCleanup(this.context, '堆垛机箭头预览', () => this.stackerMotionArrowSystem.clear());
    runSceneRuntimeCleanup(this.context, 'RGV 箭头预览', () => this.rgvMotionArrowSystem.clear());
    runSceneRuntimeCleanup(this.context, '提升机箭头预览', () => this.liftMotionArrowSystem.clear());
    runSceneRuntimeCleanup(this.context, '告警预览', () => this.dependencies.effects.alarmRuntime.reset());
    for (const id of this.dependencies.effects.alarmManagerIds) this.dependencies.presentation.meshes.get(id)?.setEnabled(this.dependencies.document.isEntityVisible(id));
    this.dependencies.presentation.lightMarkerRuntime.setPreviewActive(false);
    this.dependencies.patrol.autoPatrolMarkerRuntime.setPreviewActive(false);
    this.dependencies.patrol.manualRoamSpawnRuntime.setPreviewActive(false);
    this.dependencies.effects.clickEventBindingRuntime.setPreviewActive(false);
    // 点击单元产生的单格高亮属于预览交互产物，随预览结束一并清除。
    this.dependencies.selection.setLocalSlotHighlight('', null);
    runSceneRuntimeCleanup(this.context, '预览货物', () => this.specializedTelemetryRuntime.disposeAllCargo());
    this.dependencies.fetch.resetPreview();
    for (const model of this.dependencies.assets.models.values()) {
      if (model.telemetryPreviewBaseline) {
        restoreModelTelemetryPreviewBaseline(model.telemetryPreviewBaseline);
        model.telemetryPreviewBaseline = null;
      }
      resetStackerTelemetryState(model);
      resetConveyorTelemetryState(model);
      resetRgvTelemetryState(model);
      resetShuttleTelemetryState(model);
      resetLiftTelemetryState(model);
      resetHcliftTelemetryState(model);
    }
    for (const owner of this.dependencies.outputs.generatedOutputOwners.values()) {
      if (owner.output?.kind !== 'model') continue;
      const model = owner.output.model;
      if (model.telemetryPreviewBaseline) {
        restoreModelTelemetryPreviewBaseline(model.telemetryPreviewBaseline);
        model.telemetryPreviewBaseline = null;
      }
      resetStackerTelemetryState(model);
      resetConveyorTelemetryState(model);
      resetRgvTelemetryState(model);
      resetShuttleTelemetryState(model);
      resetLiftTelemetryState(model);
      resetHcliftTelemetryState(model);
    }
    // 合批阵列代表模型同样接受遥测驱动（collectModels 合并视图），退出时必须一并清理
    for (const variant of this.dependencies.variants.modelArrayParameterVariants.values()) {
      resetStackerTelemetryState(variant.model);
      resetConveyorTelemetryState(variant.model);
      resetRgvTelemetryState(variant.model);
      resetShuttleTelemetryState(variant.model);
      resetLiftTelemetryState(variant.model);
      resetHcliftTelemetryState(variant.model);
    }
    for (const proxy of this.dependencies.arrays.modelArrayTelemetryProxies.values()) {
      resetConveyorTelemetryState(proxy);
    }
    this.clearTelemetryPreviewRuntimeState();
    // 最终销毁不重新进入编辑态脚本、不重试加载；共享资源由后续销毁阶段释放。
    if (this.updatesStopped || this.dependencies.document.disposed) return;
    this.updateAllExternalScriptRuntimeContexts('edit', null);
    this.dependencies.outputs.clearModelGeneratorLoadFailureCache();
    this.dependencies.outputs.syncAllModelGeneratorPresentations();
    this.dependencies.locators.refreshAllBuiltInSlotRenderability();
  }

  /** 仅显式开启发布诊断时采集帧级耗时，正常运行不读取高精度时钟。 */
  setTelemetryPerformanceTimingEnabled(enabled: boolean): void {
    if (enabled && !this.telemetryPerformanceTimingEnabled) {
      this.telemetryFrameTimeMs = null;
      this.telemetryMaxFrameTimeMs = null;
      this.telemetryOuterStages.diagnosticsMs = this.telemetryOuterStages.baselineMs = this.telemetryOuterStages.alarmsMs = 0;
    }
    this.telemetryPerformanceTimingEnabled = enabled;
    this.specializedTelemetryRuntime.setPerformanceTimingEnabled(enabled);
  }

  getTelemetryPerformanceMetrics() {
    const metrics = this.specializedTelemetryRuntime.getPerformanceMetrics();
    return {
      ...metrics,
      stages: metrics.stages ? { ...metrics.stages, ...this.telemetryOuterStages } : null,
      lastFrameTimeMs: this.telemetryFrameTimeMs,
      maxFrameTimeMs: this.telemetryMaxFrameTimeMs,
    };
  }

  /** 箭头同时覆盖编辑预览和运行态，失效状态也更新，避免停机或断流后残留。 */
  public updateConveyorSurfaceArrows(views?: ArrowModelViews): void {
    // 没有启用箭头的输送线时跳过逐帧收集；缺省开启，显式关闭保留。
    if (this.updatesStopped || !this.hasConveyorSurfaceArrows) return;
    const delta = Math.min(0.25, Math.max(0, this.context.scene.getEngine().getDeltaTime() / 1000));
    this.conveyorSurfaceArrowSystem.tick((views ?? this.buildArrowModelViews(['conveyor'])).conveyor, this.telemetryPreviewActive, delta);
  }

  /** 读取本帧已执行的四路运动，只在显式启用堆垛机箭头时收集实例。 */
  public updateStackerMotionArrows(views?: ArrowModelViews): void {
    if (this.updatesStopped || !this.hasStackerMotionArrows) return;
    const delta = Math.min(.25, Math.max(0, this.context.scene.getEngine().getDeltaTime() / 1000));
    this.stackerMotionArrowSystem.tick((views ?? this.buildArrowModelViews(['stacker'])).stacker, this.telemetryPreviewActive, delta, this.context.scene.getFrameId());
  }

  /** RGV 三路箭头与设备共用类型解析；没有配置时跳过逐帧收集。 */
  public updateRgvMotionArrows(views?: ArrowModelViews): void {
    if (this.updatesStopped || !this.hasRgvMotionArrows) return;
    const delta = Math.min(.25, Math.max(0, this.context.scene.getEngine().getDeltaTime() / 1000));
    this.rgvMotionArrowSystem.tick((views ?? this.buildArrowModelViews(['rgv'])).rgv, this.telemetryPreviewActive, delta, this.context.scene.getFrameId());
  }

  /** 提升机与换层提升机在驱动后读取本帧实际运动；缺省关闭时不收集模型。 */
  public updateLiftMotionArrows(views?: ArrowModelViews): void {
    if (this.updatesStopped || !this.hasLiftMotionArrows) return;
    const delta = Math.min(.25, Math.max(0, this.context.scene.getEngine().getDeltaTime() / 1000));
    this.liftMotionArrowSystem.tick((views ?? this.buildArrowModelViews(['lift'])).lift, this.telemetryPreviewActive, delta, this.context.scene.getFrameId());
  }

  /** 只为已启用且被请求的箭头系统收集一次模型并按设备类型分组；结果仅在当前帧回调内同步使用。 */
  private buildArrowModelViews(kinds: readonly ArrowSystemKind[]): ArrowModelViews {
    const wants = (kind: ArrowSystemKind, enabled: boolean) => enabled && kinds.includes(kind);
    return buildArrowModelViews(
      this.specializedTelemetryRuntime.host.collectModels(),
      {
        conveyor: wants('conveyor', this.hasConveyorSurfaceArrows),
        stacker: wants('stacker', this.hasStackerMotionArrows),
        rgv: wants('rgv', this.hasRgvMotionArrows),
        lift: wants('lift', this.hasLiftMotionArrows),
      },
      (model) => this.specializedTelemetryRuntime.resolveDeviceType(model),
      (entityId) => !this.modelEntranceHidden && this.dependencies.document.isEntityVisible(entityId),
    );
  }

  /** 每帧把最新 MQTT 设备遥测分发到对应设备运行时。 */
  public applyDeviceTelemetryFrame(): void {
    if (!this.telemetryPreviewActive || this.updatesStopped || this.dependencies.document.disposed) return;
    const startedAt = this.telemetryPerformanceTimingEnabled ? performance.now() : null;
    try {
      this.specializedTelemetryRuntime.clearInactiveDiagnostics();
      const diagnosticsFinished = startedAt !== null ? performance.now() : null;
      if (diagnosticsFinished !== null) this.telemetryOuterStages.diagnosticsMs = diagnosticsFinished - startedAt!;
      this.captureReadyTelemetryPreviewBaselines();
      if (diagnosticsFinished !== null) this.telemetryOuterStages.baselineMs = performance.now() - diagnosticsFinished;
      const deltaSeconds = Math.min(0.25, Math.max(0, this.context.scene.getEngine().getDeltaTime() / 1000));
      this.specializedTelemetryRuntime.applyFrame(deltaSeconds);
      this.dependencies.outputs.revealDrivenSpawnedDevices();
      this.dependencies.outputs.deviceSpawnerRuntime.applyFrame(Date.now());
      const alarmsStarted = startedAt !== null ? performance.now() : null;
      for (const id of this.dependencies.effects.alarmManagerIds) this.dependencies.presentation.meshes.get(id)?.setEnabled(false);
      this.dependencies.effects.alarmRuntime.update();
      if (alarmsStarted !== null) this.telemetryOuterStages.alarmsMs = performance.now() - alarmsStarted;
    } finally {
      if (startedAt !== null) {
        this.telemetryFrameTimeMs = performance.now() - startedAt;
        this.telemetryMaxFrameTimeMs = Math.max(this.telemetryMaxFrameTimeMs ?? 0, this.telemetryFrameTimeMs);
      }
    }
  }

  /** 为已加载且 ready 的模型捕获本次预览基线，异步 GLB 后续 ready 时会在首个驱动帧前补捕获。 */
  public captureReadyTelemetryPreviewBaselines(): void {
    for (const model of this.dependencies.assets.models.values()) {
      if (model.telemetryPreviewBaseline || !model.assetHandle || !model.stackerTelemetryReady) continue;
      model.telemetryPreviewBaseline = captureModelTelemetryPreviewBaseline({ root: model.root, contentRoot: model.contentRoot });
      if (this.specializedTelemetryRuntime.resolveDeviceType(model) === 'stacker') {
        this.specializedTelemetryRuntime.primeStackerTargetReference(model);
      } else if (this.specializedTelemetryRuntime.resolveDeviceType(model) === 'conveyor') {
        this.specializedTelemetryRuntime.primeConveyorLinkCaches(model);
      }
    }
    for (const owner of this.dependencies.outputs.generatedOutputOwners.values()) {
      if (owner.output?.kind !== 'model') continue;
      const model = owner.output.model;
      if (model.telemetryPreviewBaseline || !model.assetHandle || !model.stackerTelemetryReady) continue;
      model.telemetryPreviewBaseline = captureModelTelemetryPreviewBaseline({ root: model.root, contentRoot: model.contentRoot });
    }
    // 遥测代理无几何无需捕获基线，但探测邻居/行程缓存需要同样的预热；就绪状态跟随宿主。
    for (const proxy of this.dependencies.arrays.modelArrayTelemetryProxies.values()) {
      if (!proxy.assetHandle || !proxy.stackerTelemetryReady) continue;
      if (this.specializedTelemetryRuntime.resolveDeviceType(proxy) === 'conveyor') {
        this.specializedTelemetryRuntime.primeConveyorLinkCaches(proxy);
      }
    }
  }

  /** 清空 SceneRuntime 级别的预览诊断、metadata 和已上报状态，不影响模型注册或编译绑定。 */
  public clearTelemetryPreviewRuntimeState(): void {
    this.specializedTelemetryRuntime.clearReportedState();
    for (const model of this.dependencies.assets.models.values()) {
      this.specializedTelemetryRuntime.clearDiagnosticsForModel(model);
    }
    for (const variant of this.dependencies.variants.modelArrayParameterVariants.values()) {
      this.specializedTelemetryRuntime.clearDiagnosticsForModel(variant.model);
    }
    for (const proxy of this.dependencies.arrays.modelArrayTelemetryProxies.values()) {
      this.specializedTelemetryRuntime.clearDiagnosticsForModel(proxy);
    }
    for (const owner of this.dependencies.outputs.generatedOutputOwners.values()) {
      if (owner.output?.kind === 'model') {
        this.specializedTelemetryRuntime.clearDiagnosticsForModel(owner.output.model);
      }
    }
  }

  /** 批量同步外置脚本运行上下文，预览开始和结束时用于清空或恢复模式。 */
  public updateAllExternalScriptRuntimeContexts(
    mode: ExternalModelScriptRuntimeMode,
    telemetry: ExternalModelScriptTelemetrySnapshot | null,
  ): void {
    for (const model of this.dependencies.assets.models.values()) {
      this.updateModelExternalScriptRuntimeContext(model, mode, telemetry);
    }
    for (const variant of this.dependencies.variants.modelArrayParameterVariants.values()) {
      this.updateModelExternalScriptRuntimeContext(variant.model, mode, telemetry);
    }
    for (const owner of this.dependencies.outputs.generatedOutputOwners.values()) {
      if (owner.output?.kind !== 'model') continue;
      this.updateModelExternalScriptRuntimeContext(owner.output.model, mode, telemetry);
    }
  }

  /** 同步单个模型的外置脚本上下文，未启用脚本的模型会被安全跳过。 */
  public updateModelExternalScriptRuntimeContext(
    model: ModelRuntimeEntry,
    mode: ExternalModelScriptRuntimeMode,
    telemetry: ExternalModelScriptTelemetrySnapshot | null,
    deferArrayRefresh = false,
  ): boolean {
    const runtime = model.externalScriptRuntime;
    if (!runtime) return false;

    const preparedArrayHost = this.dependencies.arrays.prepareModelArrayRuntimeMutation(model);
    this.motionStaticBatchRuntime.beginModelMutation(model);
    try { runtime.updateRuntimeContext({ mode, telemetry }); }
    finally { this.motionStaticBatchRuntime.endModelMutation(model); }
    if (preparedArrayHost && !deferArrayRefresh) this.dependencies.arrays.refreshModelArrayRuntimeRepresentation(model);
    return preparedArrayHost;
  }

  /** 从设备遥测快照提取外置脚本可消费的最小上下文，避免泄漏可变 store 对象。 */
  public createExternalScriptTelemetrySnapshot(snapshot: DeviceTelemetrySnapshot): ExternalModelScriptTelemetrySnapshot {
    return {
      deviceType: snapshot.deviceType,
      assetCode: snapshot.assetCode,
      faulted: snapshot.faulted,
      fields: { ...snapshot.fields },
    };
  }
  /** 按原构造顺序连接此领域的资源与回调。 */
  initializeSpecializedTelemetryRuntime(): void {
    this.specializedTelemetryRuntime = new SpecializedTelemetryRuntime(this.context.scene, this.createSpecializedTelemetryHost());
  }

  /** 按原构造顺序连接此领域的资源与回调。 */
  initializeConveyorSurfaceArrowSystem(): void {
    this.conveyorSurfaceArrowSystem = new ConveyorSurfaceArrowSystem(new ConveyorSurfaceArrowRenderer(this.context.scene));
  }

  /** 按原构造顺序连接此领域的资源与回调。 */
  initializeStackerMotionArrowSystem(): void {
    this.stackerMotionArrowSystem = new StackerMotionArrowSystem(new StackerMotionArrowRenderer(this.context.scene));
  }

  /** 按原构造顺序连接此领域的资源与回调。 */
  initializeRgvMotionArrowSystem(): void {
    this.rgvMotionArrowSystem = new RgvMotionArrowSystem(new RgvMotionArrowRenderer(this.context.scene));
  }

  /** 按原构造顺序连接此领域的资源与回调。 */
  initializeLiftMotionArrowSystem(): void {
    this.liftMotionArrowSystem = new LiftMotionArrowSystem(new LiftMotionArrowRenderer(this.context.scene));
  }

  /** 按原构造顺序连接此领域的资源与回调。 */
  initializeTelemetryObserver(): void {
    if (this.telemetryObserver || this.updatesStopped || this.dependencies.document.disposed) return;
    this.telemetryObserver = this.context.scene.onBeforeRenderObservable.add(() => {
      if (this.updatesStopped || this.dependencies.document.disposed) return;
      this.applyDeviceTelemetryFrame();
      if (this.updatesStopped || this.dependencies.document.disposed) return;
      this.dependencies.document.flushSingleTransformPreview();
      this.motionStaticBatchRuntime?.sync();
      if (this.updatesStopped || this.dependencies.document.disposed) return;
      // 至少一类箭头启用时才收集一次模型并按设备类型分组；全部关闭时各更新方法自行早退，不收集模型。
      const anyArrows = this.hasConveyorSurfaceArrows || this.hasStackerMotionArrows || this.hasRgvMotionArrows || this.hasLiftMotionArrows;
      // 编辑态没有收集消费者时释放快照，避免保留此后已被删除的模型。
      if (!this.telemetryPreviewActive && !anyArrows) this.collectedModels = null;
      const arrowViews = anyArrows ? this.buildArrowModelViews(['conveyor', 'stacker', 'rgv', 'lift']) : undefined;
      this.updateConveyorSurfaceArrows(arrowViews);
      this.updateStackerMotionArrows(arrowViews);
      this.updateRgvMotionArrows(arrowViews);
      this.updateLiftMotionArrows(arrowViews);
      if (this.updatesStopped || this.dependencies.document.disposed) return;
      this.dependencies.effects.modelEntranceRuntime.tick(Math.min(this.context.scene.getEngine().getDeltaTime() / 1000, 0.1), this.dependencies.effects.modelEntranceVisible);
    });
  }

  /** 按原构造顺序连接此领域的资源与回调。 */
  moveEffectFrameObserverToEnd(): void {
    // 跟随相机应读取本帧设备/货物运动处理后的最终位置。
    this.dependencies.effects.poiEffectRuntime.moveFrameObserverToEnd();
  }

  /** 按原构造顺序连接此领域的资源与回调。 */
  initializeMotionStaticBatchRuntime(): void {
    this.motionStaticBatchRuntime = new MotionStaticBatchRuntime(this.context.scene, {
      getDocument: () => this.dependencies.document.shadowDocument,
      getModels: () => this.dependencies.assets.models,
      getMotionTargets: model => this.specializedTelemetryRuntime.getLightingMotionNodes(model),
      isEntityVisible: id => this.dependencies.document.isEntityVisible(id),
      isEntityPickable: id => this.dependencies.document.isEntityScenePickable(id),
      isSceneSafe: () => this.areMotionObserversControlled(),
      isRenderTargetControlled: texture => [...this.dependencies.environment.shadowRuntime.getManagedRenderTargets()].some(target => target === texture),
      onBatchAdded: batch => {
        const liveIds = new Set(batch.meshes.map(mesh => mesh.uniqueId));
        for (const [id, current] of this.dependencies.arrays.modelArrayBatchByMeshUniqueId) {
          if (current === batch && !liveIds.has(id)) this.dependencies.arrays.modelArrayBatchByMeshUniqueId.delete(id);
        }
        for (const mesh of batch.meshes) this.dependencies.arrays.modelArrayBatchByMeshUniqueId.set(mesh.uniqueId, batch);
        for (const observer of batch.getControlledSceneObservers()) this.controlledMotionObservers.add(observer);
      },
      onBatchRemoved: batch => {
        this.dependencies.selection.outlinedModelArrayBatches.delete(batch);
        for (const [id, current] of this.dependencies.arrays.modelArrayBatchByMeshUniqueId) {
          if (current === batch) this.dependencies.arrays.modelArrayBatchByMeshUniqueId.delete(id);
        }
      },
      onChanged: () => {
        if (this.dependencies.document.disposed) return;
        this.dependencies.environment.shadowRuntime.setRenderSuppressedMeshes(this.motionStaticBatchRuntime.getSuppressedMeshes());
        this.dependencies.readiness.invalidateModelStatistics();
        this.dependencies.environment.lightingRuntime?.markDirty('motion-batch-layout');
        // 回退先恢复完整布局；角色和静态深度必须在本帧绘制前同步，不能留一帧旧遮挡。
        if (!this.dependencies.document.disposed && this.dependencies.document.shadowDocument) this.dependencies.environment.lightingRuntime?.sync(this.dependencies.document.shadowDocument);
        this.dependencies.selection.rebuildModelSelectionOutline();
      },
    }, this.motionStaticBatchingEnabled);
  }

  /** 按原构造顺序连接此领域的资源与回调。 */
  captureControlledSceneObservers(): void {
    for (const observable of this.motionObserverSources()) {
      for (const observer of observable.observers) this.controlledMotionObservers.add(observer);
    }
  }

}
