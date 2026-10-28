import './babylonSideEffects.js';
import './babylonGltfLoader.js';
import { setSparseMatrixUploadsEnabled } from './thinInstanceSparseUpdates';
import type { Engine } from '@babylonjs/core/Engines/engine.js';
import { getGpuCapabilityProfile as readGpuCapabilityProfile } from './gpuCapabilityProfile';
import { SceneDocumentController } from './scene-runtime/SceneDocumentController';
import { ModelAssetRuntimeController } from './scene-runtime/ModelAssetRuntimeController';
import { ModelParameterBindingController } from './scene-runtime/ModelParameterBindingController';
import { ModelArrayRuntimeController } from './scene-runtime/ModelArrayRuntimeController';
import { ParameterVariantHostPool } from './scene-runtime/ParameterVariantHostPool';
import { EnvironmentAndSkyboxController } from './scene-runtime/EnvironmentAndSkyboxController';
import { ScenePickingAndSelectionController } from './scene-runtime/ScenePickingAndSelectionController';
import { SceneTransformPreviewController } from './scene-runtime/SceneTransformPreviewController';
import { SceneWorldBoundsController } from './scene-runtime/SceneWorldBoundsController';
import { ScenePoiAndEffectsController } from './scene-runtime/ScenePoiAndEffectsController';
import { GeneratedModelOutputController } from './scene-runtime/GeneratedModelOutputController';
import { SceneTelemetryController } from './scene-runtime/SceneTelemetryController';
import { SceneLocatorFetchController } from './scene-runtime/SceneLocatorFetchController';
import { SceneLocatorController } from './scene-runtime/SceneLocatorController';
import { SceneCadReferenceController } from './scene-runtime/SceneCadReferenceController';
import { ScenePatrolAndRoamController } from './scene-runtime/ScenePatrolAndRoamController';
import { SceneTriangleAndReadinessController } from './scene-runtime/SceneTriangleAndReadinessController';
import { SceneMeshPresentationController } from './scene-runtime/SceneMeshPresentationController';
import type { SceneRuntimeContext } from './scene-runtime/SceneRuntimeContext';
import { runSceneRuntimeCleanup } from './scene-runtime/sceneRuntimeCleanup';
import { type SceneLightingBakeSnapshot, type LightingClassificationEntry } from '../../../electron/shared/sceneLightingBakeContract';
import type { SceneModelStatisticsSnapshot } from '../../editor/model/sceneModelStatistics';
import { type SceneModelEntranceSettings } from '../../editor/model/sceneModelEntrance';
import { createStackerFocusView } from './stackerFocusBounds';
import { type AlarmActivation } from './AlarmManagerRuntime';
import type { GeneratedUnitClickHit } from '../../editor/model/clickEventBinding';
import { configureLocalBabylonDecoders } from './localDecoderConfiguration';
import { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import { Scene } from '@babylonjs/core/scene.js';
import type { TransformComponent } from '../../editor/model/components';
import type { Vector3Data } from '../../editor/model/math';
import { type GroupSpatialInfoResult } from '../../editor/model/groupSpatialInfo';
import { type FetchConfig, type SceneDocument, type SceneEnvironmentSettings } from '../../editor/model/SceneDocument';
import { type AutoPatrolMarkerPick } from './EditorAutoPatrolRuntime';
import { type SceneEnvironmentApplyOptions } from './SceneEnvironmentRuntime';
import type { EnvironmentApplyResult, EnvironmentRuntimeSnapshot, EnvironmentWorldBounds } from '../../editor/model/environmentRuntime';
import { type ModelMeasurementResult } from './modelMeasurement';
import type { PublishedAssetCache } from '../assets/publishedAssetCache';
import type { DataPlatformScreenOverlayItem, LocatorRuntimeEntry, SceneRuntimeSyncOptions, SceneRuntimeModelLoadProgress, SceneRuntimePerformanceMetrics } from './scene-runtime/sceneRuntimeTypes';
export type { DataPlatformScreenOverlayItem, ModelRuntimeEntry, GeneratedOutputOwnerRuntimeEntry, ModelGeneratorRuntimeEntry, LocatorRuntimeEntry, SceneRuntimeModelArrayIdentityMode, SceneRuntimeSyncOptions, SceneRuntimeModelLoadProgress, SceneRuntimePerformanceMetrics } from './scene-runtime/sceneRuntimeTypes';

import type { ProjectOpenTraceRecorder, ProjectOpenSpanOutcome, ProjectOpenTraceCode } from '../../../electron/shared/projectOpenTrace.ts';
import { getDetachedMaterialCloneMetrics } from './cloneDetachedModelMaterial';

configureLocalBabylonDecoders();

/** 各领域相互借用资源；门面协调构造与释放阶段，不维护子控制器的内部清理清单。 */
export class SceneRuntime {
  private readonly lifecycleContext: SceneRuntimeContext;
  private preparationClassificationGate: (() => boolean) | null = null;
  private preparationClassificationEnabled = false;
  private preparationClassificationReleased = false;
  private preparationClassificationSession: string | null = null;
  private readonly document: SceneDocumentController;
  private readonly assets: ModelAssetRuntimeController;
  private readonly parameters: ModelParameterBindingController;
  private readonly arrays: ModelArrayRuntimeController;
  private readonly variants: ParameterVariantHostPool;
  private readonly environment: EnvironmentAndSkyboxController;
  private readonly selection: ScenePickingAndSelectionController;
  private readonly transforms: SceneTransformPreviewController;
  private readonly bounds: SceneWorldBoundsController;
  private readonly effects: ScenePoiAndEffectsController;
  private readonly outputs: GeneratedModelOutputController;
  private readonly telemetry: SceneTelemetryController;
  private readonly fetch: SceneLocatorFetchController;
  private readonly locators: SceneLocatorController;
  private readonly cad: SceneCadReferenceController;
  private readonly patrol: ScenePatrolAndRoamController;
  private readonly readiness: SceneTriangleAndReadinessController;
  private readonly presentation: SceneMeshPresentationController;

  constructor(
    private readonly scene: Scene,
    pushLog: (message: string) => void = () => undefined,
    onModelMeasurementChanged: (entityId: string) => void = () => undefined,
    onEnvironmentSnapshot: (snapshot: EnvironmentRuntimeSnapshot) => void = () => undefined,
    onModelLoadProgress?: (progress: SceneRuntimeModelLoadProgress) => void,
    getResourceLoadDiagnostics?: () => ReturnType<PublishedAssetCache['getLoadDiagnostics']> | null,
  ) {
    const owner = () => this;
    const context: SceneRuntimeContext = { scene, pushLog, onModelMeasurementChanged, onModelLoadProgress, getResourceLoadDiagnostics,
      callbackReceiver: owner(),
      canDeferPreparationClassification: () => this.preparationClassificationEnabled
        && !this.preparationClassificationReleased && this.preparationClassificationGate?.() === true,
      notifyEnvironmentSnapshot: snapshot => onEnvironmentSnapshot(snapshot),
      get onModelStatisticsChanged() { return owner().onModelStatisticsChanged; },
      set onModelStatisticsChanged(callback) { owner().onModelStatisticsChanged = callback; },
      get onAlarmActivated() { return owner().onAlarmActivated; },
      set onAlarmActivated(callback) { owner().onAlarmActivated = callback; },
    };
    this.lifecycleContext = context;
    this.document = new SceneDocumentController(context, {
      get telemetry() { return owner().telemetry; },
      get transforms() { return owner().transforms; },
      get arrays() { return owner().arrays; },
      get selection() { return owner().selection; },
      get readiness() { return owner().readiness; },
      get environment() { return owner().environment; },
      get effects() { return owner().effects; },
      get outputs() { return owner().outputs; },
      get patrol() { return owner().patrol; },
      get presentation() { return owner().presentation; },
      get locators() { return owner().locators; },
      get cad() { return owner().cad; },
      get assets() { return owner().assets; }
    });
    this.assets = new ModelAssetRuntimeController(context, {
      get selection() { return owner().selection; },
      get arrays() { return owner().arrays; },
      get transforms() { return owner().transforms; },
      get presentation() { return owner().presentation; },
      get document() { return owner().document; },
      get locators() { return owner().locators; },
      get telemetry() { return owner().telemetry; },
      get parameters() { return owner().parameters; },
      get readiness() { return owner().readiness; },
      get variants() { return owner().variants; },
      get outputs() { return owner().outputs; },
      get environment() { return owner().environment; }
    });
    this.parameters = new ModelParameterBindingController(context, {
      get presentation() { return owner().presentation; },
      get document() { return owner().document; }
    });
    this.arrays = new ModelArrayRuntimeController(context, {
      get assets() { return owner().assets; },
      get variants() { return owner().variants; },
      get presentation() { return owner().presentation; },
      get readiness() { return owner().readiness; },
      get selection() { return owner().selection; },
      get telemetry() { return owner().telemetry; },
      get bounds() { return owner().bounds; },
      get document() { return owner().document; },
      get transforms() { return owner().transforms; }
    });
    this.variants = new ParameterVariantHostPool(context, {
      get assets() { return owner().assets; },
      get presentation() { return owner().presentation; },
      get arrays() { return owner().arrays; },
      get parameters() { return owner().parameters; },
      get readiness() { return owner().readiness; },
      get locators() { return owner().locators; },
      get selection() { return owner().selection; }
    });
    this.environment = new EnvironmentAndSkyboxController(context, {
      get selection() { return owner().selection; },
      get document() { return owner().document; },
      get readiness() { return owner().readiness; },
      get outputs() { return owner().outputs; },
      get effects() { return owner().effects; },
      get presentation() { return owner().presentation; },
      get assets() { return owner().assets; },
      get telemetry() { return owner().telemetry; },
      get variants() { return owner().variants; },
      get arrays() { return owner().arrays; }
    });
    this.selection = new ScenePickingAndSelectionController(context, {
      get document() { return owner().document; },
      get patrol() { return owner().patrol; },
      get presentation() { return owner().presentation; },
      get locators() { return owner().locators; },
      get arrays() { return owner().arrays; },
      get assets() { return owner().assets; },
      get outputs() { return owner().outputs; },
      get effects() { return owner().effects; },
      get environment() { return owner().environment; },
      get telemetry() { return owner().telemetry; }
    });
    this.transforms = new SceneTransformPreviewController(context, {
      get document() { return owner().document; },
      get arrays() { return owner().arrays; },
      get assets() { return owner().assets; },
      get presentation() { return owner().presentation; },
      get environment() { return owner().environment; },
      get locators() { return owner().locators; },
      get cad() { return owner().cad; },
      get outputs() { return owner().outputs; },
      get effects() { return owner().effects; },
      get patrol() { return owner().patrol; },
      get bounds() { return owner().bounds; },
      get telemetry() { return owner().telemetry; }
    });
    this.bounds = new SceneWorldBoundsController(context, {
      get assets() { return owner().assets; },
      get arrays() { return owner().arrays; },
      get document() { return owner().document; },
      get locators() { return owner().locators; },
      get outputs() { return owner().outputs; },
      get cad() { return owner().cad; },
      get presentation() { return owner().presentation; },
      get environment() { return owner().environment; },
      get effects() { return owner().effects; },
      get patrol() { return owner().patrol; },
      get variants() { return owner().variants; }
    });
    this.effects = new ScenePoiAndEffectsController(context, {
      get telemetry() { return owner().telemetry; },
      get outputs() { return owner().outputs; },
      get fetch() { return owner().fetch; },
      get environment() { return owner().environment; },
      get document() { return owner().document; },
      get assets() { return owner().assets; },
      get presentation() { return owner().presentation; },
      get variants() { return owner().variants; },
      get readiness() { return owner().readiness; },
      get bounds() { return owner().bounds; },
      get locators() { return owner().locators; },
      get cad() { return owner().cad; }
    });
    this.outputs = new GeneratedModelOutputController(context, {
      get telemetry() { return owner().telemetry; },
      get presentation() { return owner().presentation; },
      get readiness() { return owner().readiness; },
      get parameters() { return owner().parameters; },
      get assets() { return owner().assets; },
      get selection() { return owner().selection; },
      get document() { return owner().document; }
    });
    this.telemetry = new SceneTelemetryController(context, {
      get arrays() { return owner().arrays; },
      get assets() { return owner().assets; },
      get variants() { return owner().variants; },
      get outputs() { return owner().outputs; },
      get locators() { return owner().locators; },
      get fetch() { return owner().fetch; },
      get bounds() { return owner().bounds; },
      get transforms() { return owner().transforms; },
      get presentation() { return owner().presentation; },
      get patrol() { return owner().patrol; },
      get effects() { return owner().effects; },
      get document() { return owner().document; },
      get selection() { return owner().selection; },
      get environment() { return owner().environment; },
      get readiness() { return owner().readiness; }
    });
    this.fetch = new SceneLocatorFetchController(context, {
      get assets() { return owner().assets; },
      get outputs() { return owner().outputs; },
      get presentation() { return owner().presentation; },
      get document() { return owner().document; },
      get locators() { return owner().locators; },
      get telemetry() { return owner().telemetry; },
      get readiness() { return owner().readiness; }
    });
    this.locators = new SceneLocatorController(context, {
      get outputs() { return owner().outputs; },
      get assets() { return owner().assets; },
      get presentation() { return owner().presentation; },
      get arrays() { return owner().arrays; },
      get document() { return owner().document; },
      get variants() { return owner().variants; },
      get selection() { return owner().selection; },
      get bounds() { return owner().bounds; },
      get fetch() { return owner().fetch; },
      get readiness() { return owner().readiness; },
      get transforms() { return owner().transforms; },
      get telemetry() { return owner().telemetry; }
    });
    this.cad = new SceneCadReferenceController(context, {
      get presentation() { return owner().presentation; },
      get assets() { return owner().assets; },
      get transforms() { return owner().transforms; },
      get document() { return owner().document; }
    });
    this.patrol = new ScenePatrolAndRoamController(context, {
      get effects() { return owner().effects; },
      get document() { return owner().document; }
    });
    this.readiness = new SceneTriangleAndReadinessController(context, {
      get document() { return owner().document; },
      get bounds() { return owner().bounds; },
      get presentation() { return owner().presentation; },
      get assets() { return owner().assets; },
      get variants() { return owner().variants; },
      get arrays() { return owner().arrays; },
      get outputs() { return owner().outputs; },
      get fetch() { return owner().fetch; },
      get environment() { return owner().environment; },
      get selection() { return owner().selection; },
      get effects() { return owner().effects; },
      get transforms() { return owner().transforms; },
      get telemetry() { return owner().telemetry; }
    });
    this.presentation = new SceneMeshPresentationController(context, {
      get document() { return owner().document; },
      get effects() { return owner().effects; },
      get transforms() { return owner().transforms; },
      get environment() { return owner().environment; },
      get arrays() { return owner().arrays; },
      get variants() { return owner().variants; },
      get assets() { return owner().assets; },
      get bounds() { return owner().bounds; }
    });
    this.effects.initializeModelEntranceRuntime();
    this.selection.initializeModelSelectionOutlineLayer();
    this.effects.initializePoiEffectRuntime();
    this.environment.initializeShadowRuntime();
    this.environment.initializeAppearanceRuntime();
    this.environment.initializeLightRigRuntime();
    this.presentation.initializeLightMarkerRuntime();
    this.patrol.initializeAutoPatrolMarkerRuntime();
    this.patrol.initializeManualRoamSpawnRuntime();
    this.effects.initializeClickEventBindingRuntime();
    this.effects.initializeAlarmRuntime();
    this.environment.initializeSkyboxRuntime();
    this.environment.initializeEnvironmentRuntime();
    this.telemetry.initializeSpecializedTelemetryRuntime();
    this.telemetry.initializeConveyorSurfaceArrowSystem();
    this.telemetry.initializeStackerMotionArrowSystem();
    this.telemetry.initializeRgvMotionArrowSystem();
    this.telemetry.initializeLiftMotionArrowSystem();
    this.outputs.initializeDeviceSpawnerRuntime();
    this.transforms.initializeGroupTransformPreviewObserver();
    this.arrays.initializeModelArrayVariantRenderSuppressionObserver();
    this.arrays.initializeModelArrayVariantRenderRestoreObserver();
    this.telemetry.initializeTelemetryObserver();
    this.readiness.initializeModelStatisticsMeshAddedObserver();
    this.readiness.initializeModelStatisticsMeshRemovedObserver();
    this.telemetry.moveEffectFrameObserverToEnd();
    this.telemetry.initializeMotionStaticBatchRuntime();
    this.environment.initializeLightingRuntime();
    this.telemetry.captureControlledSceneObservers();
  }

  isAlarmActive(managerId: string, targetId: string): boolean { return this.effects.isAlarmActive(managerId, targetId); }

  setMotionStaticBatchingEnabled(enabled: boolean): void { return this.telemetry.setMotionStaticBatchingEnabled(enabled); }

  beginSceneSession(sessionId: string, recorder?: ProjectOpenTraceRecorder | null): void {
    if (this.document.disposed) return;
    if (sessionId !== this.preparationClassificationSession) {
      this.preparationClassificationSession = sessionId;
      this.preparationClassificationReleased = false;
    }
    if (this.readiness.loadDiagnostics.captureTrace()?.recorder !== recorder) this.environment.endProjectOpenSkyboxTrace('stale', 'scene-stale');
    this.readiness.loadDiagnostics.beginProjectOpenTrace(recorder, sessionId);
    this.telemetry.beginSceneSession(sessionId);
  }

  markProjectOpenAssetsSettled(): void { this.readiness.loadDiagnostics.markProjectOpenAssetsSettled(); }

  getProjectOpenModelAcquisitionFailures(sceneSessionId: string): number | null {
    return this.readiness.loadDiagnostics.getProjectOpenModelAcquisitionFailures(sceneSessionId);
  }

  completeProjectOpenRuntime(outcome: ProjectOpenSpanOutcome = 'ok', code?: ProjectOpenTraceCode): void {
    this.environment.endProjectOpenSkyboxTrace(outcome, code);
    this.readiness.loadDiagnostics.completeProjectOpenRuntime(outcome, code);
  }

  getMotionStaticBatchDiagnostics() { return this.telemetry.getMotionStaticBatchDiagnostics(); }

  registerHostSceneObservers(): void { return this.telemetry.registerHostSceneObservers(); }

  withControlledSceneObservers<T>(initialize: () => T): T { return this.telemetry.withControlledSceneObservers(initialize); }

  handleFetchDriveEvent(fetchConfig: FetchConfig): Promise<void> { return this.fetch.handleFetchDriveEvent(fetchConfig); }

  handleFetchRowSync(rowNumber: number): void { return this.fetch.handleFetchRowSync(rowNumber); }

  setOpeningCameraOwned(owned: boolean): void { return this.effects.setOpeningCameraOwned(owned); }

  prepareModelEntrance(settings: SceneModelEntranceSettings, signal?: AbortSignal): Promise<void> { return this.effects.prepareModelEntrance(settings, signal); }

  startModelEntrance(): void { return this.effects.startModelEntrance(); }

  cancelModelEntrance(): void { return this.effects.cancelModelEntrance(); }

  setModelEntranceVisible(visible: boolean): void { return this.effects.setModelEntranceVisible(visible); }

  isModelEntranceReady(): boolean { return this.effects.isModelEntranceReady(); }

  getModelEntranceSnapshot() { return this.effects.getModelEntranceSnapshot(); }

  async waitForInitialRenderReady(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException('首帧准备已取消。', 'AbortError'));
    this.preparationClassificationReleased = true;
    this.environment.lightingRuntime?.finishPreparationClassification();
    return this.readiness.waitForInitialRenderReady(signal);
  }

  setPreparationClassificationGate(gate: () => boolean): void { this.preparationClassificationGate = gate; }
  setPreparationClassificationEnabled(enabled: boolean): void { this.preparationClassificationEnabled = enabled; }
  getPreparationClassificationMetrics() { return { enabled: this.preparationClassificationEnabled,
    released: this.preparationClassificationReleased, deferredFrames: this.environment.lightingRuntime?.getPreparationDeferredFrames() ?? 0 }; }

  beginTelemetryPreview(): void { return this.telemetry.beginTelemetryPreview(); }

  endTelemetryPreview(): void { return this.telemetry.endTelemetryPreview(); }

  disableEditorLightMarkers(): void { return this.presentation.disableEditorLightMarkers(); }

  disableEditorAutoPatrolMarkers(): void { return this.patrol.disableEditorAutoPatrolMarkers(); }

  disableEditorManualRoamSpawnMarkers(): void { return this.patrol.disableEditorManualRoamSpawnMarkers(); }

  disableEditorClickEventBindingMarkers(): void { return this.patrol.disableEditorClickEventBindingMarkers(); }

  setAutoPatrolSelection(routeId: string | null, waypointId: string | null): void { return this.patrol.setAutoPatrolSelection(routeId, waypointId); }

  setAutoPatrolPlaybackTarget(routeId: string | null, waypointIndex: number | null): void { return this.patrol.setAutoPatrolPlaybackTarget(routeId, waypointIndex); }

  getAutoPatrolWaypointGizmoTarget(entityId: string, waypointId: string): TransformNode | null { return this.patrol.getAutoPatrolWaypointGizmoTarget(entityId, waypointId); }

  previewAutoPatrolWaypointTransform(entityId: string, waypointId: string, transform: TransformComponent): void { return this.patrol.previewAutoPatrolWaypointTransform(entityId, waypointId, transform); }

  getGizmoTargetByEntityId(entityId: string | null): AbstractMesh | TransformNode | null { return this.transforms.getGizmoTargetByEntityId(entityId); }

  getEntityGroupSpatialInfo(entityIds: readonly string[]): GroupSpatialInfoResult { return this.transforms.getEntityGroupSpatialInfo(entityIds); }

  getFolderGroupGizmoTarget(
    groupId: string,
    entityIds: readonly string[],
    tool: 'translate' | 'rotate' = 'translate',
    compositionPivot?: Vector3Data,
  ): TransformNode | null { return this.transforms.getFolderGroupGizmoTarget(groupId, entityIds, tool, compositionPivot); }

  isEntityGroupTransformReady(
    entityIds: readonly string[],
    tool: 'translate' | 'rotate',
  ): boolean { return this.transforms.isEntityGroupTransformReady(entityIds, tool); }

  clearFolderGroupGizmoTarget(): void { return this.transforms.clearFolderGroupGizmoTarget(); }

  beginFolderGroupTranslation(
    entityIds: readonly string[],
    beforePositions: Readonly<Record<string, Vector3Data>>,
  ): boolean { return this.transforms.beginFolderGroupTranslation(entityIds, beforePositions); }

  updateFolderGroupTranslation(delta: Vector3Data): boolean { return this.transforms.updateFolderGroupTranslation(delta); }

  cancelFolderGroupTranslation(): void { return this.transforms.cancelFolderGroupTranslation(); }

  finishFolderGroupTranslation(): void { return this.transforms.finishFolderGroupTranslation(); }

  beginFolderGroupRotation(
    entityIds: readonly string[],
    beforeTransforms: Readonly<Record<string, TransformComponent>>,
  ): boolean { return this.transforms.beginFolderGroupRotation(entityIds, beforeTransforms); }

  updateFolderGroupRotation(deltaMatrix: readonly number[]): boolean { return this.transforms.updateFolderGroupRotation(deltaMatrix); }

  getFolderGroupRotationTransforms(): Record<string, TransformComponent> | null { return this.transforms.getFolderGroupRotationTransforms(); }

  cancelFolderGroupRotation(): void { return this.transforms.cancelFolderGroupRotation(); }

  finishFolderGroupRotation(): void { return this.transforms.finishFolderGroupRotation(); }

  pickAutoPatrolAtCanvasPoint(clientX: number, clientY: number, canvas: HTMLCanvasElement): AutoPatrolMarkerPick | null { return this.selection.pickAutoPatrolAtCanvasPoint(clientX, clientY, canvas); }

  pickEntityIdAtCanvasPoint(clientX: number, clientY: number, canvas: HTMLCanvasElement): string | null { return this.selection.pickEntityIdAtCanvasPoint(clientX, clientY, canvas); }

  pickRuntimeModelEntityIdAtCanvasPoint(
    clientX: number,
    clientY: number,
    canvas: HTMLCanvasElement,
  ): string | null { return this.selection.pickRuntimeModelEntityIdAtCanvasPoint(clientX, clientY, canvas); }

  pickRuntimeModelHitAtCanvasPoint(
    clientX: number,
    clientY: number,
    canvas: HTMLCanvasElement,
  ): { entityId: string; distance: number; precise: boolean } | null { return this.selection.pickRuntimeModelHitAtCanvasPoint(clientX, clientY, canvas); }

  pickGeneratedUnitClickTargetAtCanvasPoint(
    clientX: number,
    clientY: number,
    canvas: HTMLCanvasElement,
  ): { hit: GeneratedUnitClickHit; distance: number } | null { return this.selection.pickGeneratedUnitClickTargetAtCanvasPoint(clientX, clientY, canvas); }

  pickChartMarkerAtCanvasPoint(clientX: number, clientY: number, canvas: HTMLCanvasElement): string | null { return this.selection.pickChartMarkerAtCanvasPoint(clientX, clientY, canvas); }

  pickBuiltInSlotCellAtCanvasPoint(
    clientX: number,
    clientY: number,
    canvas: HTMLCanvasElement,
  ): { locatorEntityId: string; hostEntityId: string; row: number; column: number; layer: number; distance: number } | null { return this.selection.pickBuiltInSlotCellAtCanvasPoint(clientX, clientY, canvas); }

  getGroundPointAtCanvasPoint(clientX: number, clientY: number, canvas: HTMLCanvasElement): Vector3Data | null { return this.selection.getGroundPointAtCanvasPoint(clientX, clientY, canvas); }

  getModelMeasurement(entityId: string): ModelMeasurementResult { return this.bounds.getModelMeasurement(entityId); }

  setTrajectoryVisible(visible: boolean): void { return this.presentation.setTrajectoryVisible(visible); }

  getEntityArrayGeometry(entityId: string, worldDirection: Vector3Data): {
    direction: Vector3Data;
    spanMeters: number;
  } | null { return this.transforms.getEntityArrayGeometry(entityId, worldDirection); }

  updateEntityArrayPreview(
    entityId: string,
    worldDirection: Vector3Data,
    copyCount: number,
    spacingMeters: number,
  ): boolean { return this.transforms.updateEntityArrayPreview(entityId, worldDirection, copyCount, spacingMeters); }

  clearEntityArrayPreview(): void { return this.transforms.clearEntityArrayPreview(); }

  getEntitiesWorldBounds(entityIds: string[]): {
    center: Vector3Data;
    sizeMeters: Vector3Data;
    radiusMeters: number;
    geometryReady: boolean;
    requestedEntityCount: number;
    resolvedEntityCount: number;
    geometryReadyEntityCount: number;
    missingEntityCount: number;
    notReadyEntityCount: number;
    missingEntityIds: string[];
    notReadyEntityIds: string[];
  } | null { return this.bounds.getEntitiesWorldBounds(entityIds); }

  getEntitiesFocusBounds(entityIds: string[]): (NonNullable<ReturnType<SceneRuntime['getEntitiesWorldBounds']>> & {
    focusView?: ReturnType<typeof createStackerFocusView>;
  }) | null { return this.bounds.getEntitiesFocusBounds(entityIds); }

  getLocatorCellWorldBounds(entityId: string, coordinate: { row: number; column: number; layer: number }): {
    center: Vector3Data;
    sizeMeters: Vector3Data;
    radiusMeters: number;
    geometryReady: boolean;
    requestedEntityCount: number;
    resolvedEntityCount: number;
    geometryReadyEntityCount: number;
    missingEntityCount: number;
    notReadyEntityCount: number;
    missingEntityIds: string[];
    notReadyEntityIds: string[];
  } | null { return this.bounds.getLocatorCellWorldBounds(entityId, coordinate); }

  setLocalHighlightEntityIds(entityIds: readonly string[]): void { return this.selection.setLocalHighlightEntityIds(entityIds); }

  setClickHighlightTrackExclusion(entityIds: readonly string[]): void { return this.selection.setClickHighlightTrackExclusion(entityIds); }

  clearLocalHighlight(): void { return this.selection.clearLocalHighlight(); }

  setExternalHighlightEntityIds(entityIds: readonly string[]): void { return this.selection.setExternalHighlightEntityIds(entityIds); }

  clearExternalHighlight(): void { return this.selection.clearExternalHighlight(); }

  setLocalSlotHighlight(
    entityId: string,
    coordinate: { row: number; column: number; layer: number } | null,
  ): void { return this.selection.setLocalSlotHighlight(entityId, coordinate); }

  setExternalSlotHighlight(
    entityId: string,
    coordinate: { row: number; column: number; layer: number } | null,
  ): void { return this.selection.setExternalSlotHighlight(entityId, coordinate); }

  beginSingleTransformPreview(entityId: string, before: TransformComponent): boolean { return this.document.beginSingleTransformPreview(entityId, before); }

  updateSingleTransformPreview(entityId: string, after: TransformComponent): void { return this.document.updateSingleTransformPreview(entityId, after); }

  endSingleTransformPreview(): void { return this.document.endSingleTransformPreview(); }

  sync(
    document: SceneDocument,
    hierarchySelectionIds?: readonly string[],
    options: SceneRuntimeSyncOptions = {},
  ): void { return this.document.sync(document, hierarchySelectionIds, options); }

  syncModelParameters(
    document: SceneDocument,
    entityId: string,
    hierarchySelectionIds?: readonly string[],
    options?: SceneRuntimeSyncOptions,
  ): void { return this.document.syncModelParameters(document, entityId, hierarchySelectionIds, options); }

  /** 局部同步一组实体；返回 false 表示条件不满足且未修改运行时，调用方须改用 sync()。 */
  syncEntitiesLocally(
    document: SceneDocument,
    entityIds: readonly string[],
    hierarchySelectionIds?: readonly string[],
    options?: SceneRuntimeSyncOptions,
  ): boolean { return this.document.syncEntitiesLocally(document, entityIds, hierarchySelectionIds, options); }

  syncSelection(document: SceneDocument, hierarchySelectionIds?: readonly string[]): void { return this.document.syncSelection(document, hierarchySelectionIds); }

  getDataPlatformScreenOverlayItems(): DataPlatformScreenOverlayItem[] { return this.effects.getDataPlatformScreenOverlayItems(); }

  public getModelStatistics(): SceneModelStatisticsSnapshot { return this.readiness.getModelStatistics(); }

  getPerformanceMetrics(): SceneRuntimePerformanceMetrics { return this.readiness.getPerformanceMetrics(); }

  /** 只读已完成的准备诊断；打开管理器不会启动离屏检测或分类。 */
  getGpuCapabilityProfile() { return readGpuCapabilityProfile(this.scene.getEngine() as Engine); }

  getShaderWarmupMetrics() { return this.assets.shaderWarmup.getMetrics(); }

  getDetachedMaterialCloneMetrics() { return getDetachedMaterialCloneMetrics(this.scene); }

  /** 准备阶段shader预热内部A/B入口；不写入场景或修改任何画质默认值。 */
  setPreparationShaderWarmupEnabled(enabled: boolean): void { this.assets.shaderWarmup.setEnabled(enabled); }

  /** 只影响本 Scene 的有界矩阵上传实验；不写场景文件，缺省关闭。 */
  setSparseMatrixUploadsEnabled(enabled: boolean): void { setSparseMatrixUploadsEnabled(this.scene, enabled); }

  /** 同构建 A/B：应在打开场景前设置，不原地切换已创建实例的共享资源所有权。 */
  setReadonlyGeometrySharingEnabled(enabled: boolean): void {
    this.assets.sharedModelAssetCache.setReadonlyGeometrySharingEnabled(enabled);
  }

  setSkyboxEnvironmentResolver(resolver: import('./SceneSkyboxRuntime').SkyboxEnvironmentResolver,
    onPrepared?: import('./SceneSkyboxRuntime').SkyboxEnvironmentPrepared,
    onReadiness?: (state: import('./SceneSkyboxRuntime').SkyboxReadiness) => void): void {
    this.environment.skyboxRuntime.setEnvironmentResolver(resolver, onPrepared, onReadiness);
  }

  syncSkybox(document: SceneDocument): void { return this.environment.syncSkybox(document); }

  syncEnvironment(environment: SceneEnvironmentSettings | null): void { return this.environment.syncEnvironment(environment); }

  syncDefaultCargoGenerator(defaultCargoGeneratorId: string | null): void { return this.environment.syncDefaultCargoGenerator(defaultCargoGeneratorId); }

  syncAppearance(document: SceneDocument): void { return this.environment.syncAppearance(document); }

  syncLighting(document: SceneDocument): void { return this.environment.syncLighting(document); }

  preflightLightingBake(document: SceneDocument, signal?: AbortSignal) { return this.environment.preflightLightingBake(document, signal); }

  setLightingDraftPreview(preview: import('../../editor/store/lightingManagementState').LightingDraftPreview | null) { return this.environment.setLightingDraftPreview(preview); }

  peekLightingClassificationForEntities(entityIds: readonly string[]) { return this.environment.peekLightingClassificationForEntities(entityIds); }

  getLightingClassification(): LightingClassificationEntry[] { return this.environment.getLightingClassification(); }

  setLightingPreview(debugVisible: boolean, beforeBake: boolean): void { return this.environment.setLightingPreview(debugVisible, beforeBake); }

  focusLightingNode(entityId: string, nodeKey: string): void { return this.environment.focusLightingNode(entityId, nodeKey); }

  getLightingBakeRuntimeError(): string | null { return this.environment.getLightingBakeRuntimeError(); }

  getLightingRuntimeDiagnostic() { return this.environment.getLightingRuntimeDiagnostic(); }

  getHybridLightingMetrics() { return this.environment.getHybridLightingMetrics(); }

  setLightingOptimizationOptions(options: Partial<import('./lightingOptimizationSettings.ts').LightingOptimizationOptions>): void {
    this.environment.setLightingOptimizationOptions(options);
  }

  getLightingOptimizationMetrics() { return this.environment.getLightingOptimizationMetrics(); }

  waitForLightingReady(): Promise<void> { return this.environment.waitForLightingReady(); }

  bakeLighting(document: SceneDocument, signal?: AbortSignal, progress?: (message: string, fraction?: number, phase?: string) => void): Promise<SceneLightingBakeSnapshot> { return this.environment.bakeLighting(document, signal, progress); }

  applyEnvironment(
    environment: SceneEnvironmentSettings,
    options: SceneEnvironmentApplyOptions,
  ): Promise<EnvironmentApplyResult> { return this.environment.applyEnvironment(environment, options); }

  getEnvironmentGizmoTarget(): TransformNode | null { return this.environment.getEnvironmentGizmoTarget(); }

  getEnvironmentWorldBounds(): EnvironmentWorldBounds | null { return this.environment.getEnvironmentWorldBounds(); }

  getOpeningEnvironmentSnapshot() { return this.environment.getOpeningEnvironmentSnapshot(); }

  setEnvironmentAdjustmentActive(active: boolean): void { return this.environment.setEnvironmentAdjustmentActive(active); }

  findLayerChangePlatformLocator(assetCode: string, aisleCode: string): LocatorRuntimeEntry | null { return this.locators.findLayerChangePlatformLocator(assetCode, aisleCode); }

  isModelReady(entityId: string): boolean { return this.readiness.isModelReady(entityId); }

  getSkyboxReadiness(): { phase: 'idle' | 'loading' | 'ready' | 'error'; message: string | null; sourceUrl: string | null } { return this.readiness.getSkyboxReadiness(); }

  retrySkyboxLoading(): void { return this.readiness.retrySkyboxLoading(); }

  retryFailedSceneResources(document: SceneDocument, hierarchySelectionIds?: readonly string[]): number { return this.readiness.retryFailedSceneResources(document, hierarchySelectionIds); }

  getInitialLoadSnapshot() { return this.readiness.getInitialLoadSnapshot(); }

  getModelReadinessError(entityId: string): string | null { return this.readiness.getModelReadinessError(entityId); }

  setTelemetryPerformanceTimingEnabled(enabled: boolean): void { return this.telemetry.setTelemetryPerformanceTimingEnabled(enabled); }

  getTelemetryPerformanceMetrics() { return this.telemetry.getTelemetryPerformanceMetrics(); }

  public onModelStatisticsChanged?: (snapshot: SceneModelStatisticsSnapshot) => void;
  onAlarmActivated?: (event: AlarmActivation) => void;



  dispose(): void {
    if (!this.document.beginDisposal()) return;
    const cleanup = (resource: string, action: () => void) => runSceneRuntimeCleanup(this.lifecycleContext, resource, action);
    cleanup('场景打开记录', () => this.completeProjectOpenRuntime('cancelled', 'aborted'));

    // 先封闭新工作和异步回写；预览与本帧抑制必须在模型仍然存活时归还。
    cleanup('停止统计通知', () => this.readiness.stopUpdates());
    cleanup('停止遥测帧', () => this.telemetry.stopUpdates());
    cleanup('停止生成产物', () => this.outputs.stopUpdates());
    cleanup('停止模型入场', () => this.effects.stopUpdates());
    cleanup('停止模型加载', () => this.assets.stopUpdates());
    cleanup('停止阵列更新', () => this.arrays.stopUpdates());
    cleanup('停止 CAD 加载', () => this.cad.stopUpdates());
    cleanup('停止环境任务', () => this.environment.stopUpdates());
    cleanup('遥测预览复位', () => this.telemetry.endTelemetryPreview());
    cleanup('Fetch 运行时', () => this.fetch.dispose());
    cleanup('就绪统计', () => this.readiness.dispose());
    cleanup('货格高亮', () => this.selection.clearSlotHighlights());
    cleanup('变换预览', () => this.transforms.dispose());

    // GI 派生资源先归还，效果与选择能力仍供业务模型释放时解绑。
    cleanup('环境与 GI', () => this.environment.disposeEnvironment());
    cleanup('基础网格', () => this.presentation.disposeMeshes());
    cleanup('定位器', () => this.locators.dispose());
    cleanup('CAD 参考图', () => this.cad.dispose());
    cleanup('输送线轨迹', () => this.presentation.disposeTrajectories());
    cleanup('模型实例', () => this.assets.disposeModels());
    cleanup('参数变体', () => this.variants.dispose());
    cleanup('阵列代理及索引', () => this.arrays.dispose());
    cleanup('生成产物', () => this.outputs.dispose());
    cleanup('POI 效果', () => this.effects.disposeEffects());
    cleanup('遥测资源', () => this.telemetry.dispose());
    cleanup('实体灯光', () => this.presentation.dispose());
    cleanup('巡检与漫游标记', () => this.patrol.dispose());
    cleanup('点击、告警与大屏', () => this.effects.dispose());

    // 所有共享资源消费者退出后才释放缓存与选择层，文档引用最后清空。
    cleanup('阴影与天空', () => this.environment.dispose());
    cleanup('共享模型资产', () => this.assets.dispose());
    cleanup('选择状态', () => this.selection.dispose());
    cleanup('场景文档', () => this.document.dispose());
    this.preparationClassificationGate = null;
    this.preparationClassificationSession = null;
  }
}
