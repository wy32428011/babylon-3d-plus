import { equalPreviewTransform } from '../../../editor/store/transformPreviewStore';
import { collectAlarmIndependentEntityIds } from '../../../editor/model/alarmManager';
import { collectDigitalTwinEffectTargetIds } from '../../../editor/model/digitalTwinEffect';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';

import type { Entity } from '../../../editor/model/Entity';
import { createEntityHierarchyStateMap } from '../../../editor/model/entityHierarchy';
import { isEntityLocalSyncChange } from '../../../editor/model/editModeModelThinInstances';
import type { TransformComponent } from '../../../editor/model/components';
import { getCompositionArrayInfo } from '../../../editor/model/modelArray';
import { type SceneDocument } from '../../../editor/model/SceneDocument';
import { isConveyorModelAsset } from '../telemetry/specialized/specializedModelAssets';
import { parseSpawnedDeviceEntityId } from '../telemetry/spawner/DeviceSpawnerRuntime';
import { mergeSceneRuntimeHighlightEntityIds } from '../sceneRuntimeHighlight';
import { isRuntimeModelSelectionCandidate } from '../sceneRuntimeSelection';
import type { SceneRuntimeContext } from './SceneRuntimeContext';
import type { SceneTelemetryController } from './SceneTelemetryController';
import type { SceneTransformPreviewController } from './SceneTransformPreviewController';
import type { ModelArrayRuntimeController } from './ModelArrayRuntimeController';
import type { ScenePickingAndSelectionController } from './ScenePickingAndSelectionController';
import type { SceneTriangleAndReadinessController } from './SceneTriangleAndReadinessController';
import type { EnvironmentAndSkyboxController } from './EnvironmentAndSkyboxController';
import type { ScenePoiAndEffectsController } from './ScenePoiAndEffectsController';
import type { GeneratedModelOutputController } from './GeneratedModelOutputController';
import type { ScenePatrolAndRoamController } from './ScenePatrolAndRoamController';
import type { SceneMeshPresentationController } from './SceneMeshPresentationController';
import type { SceneLocatorController } from './SceneLocatorController';
import type { SceneCadReferenceController } from './SceneCadReferenceController';
import type { ModelAssetRuntimeController } from './ModelAssetRuntimeController';
import { type ModelRuntimeEntry, type EntityRuntimeState, type SceneRuntimeSyncOptions, readRuntimeTimestampMs } from './sceneRuntimeTypes';

/** 此领域仅能访问明确列出的协作能力，资源与缓存由所属 Controller 持有。 */
type Dependencies = {
  readonly telemetry: Pick<SceneTelemetryController, 'telemetryPreviewActive' | 'hasConveyorSurfaceArrows' | 'conveyorSurfaceArrowSystem' | 'hasStackerMotionArrows' | 'stackerMotionArrowSystem' | 'hasRgvMotionArrows' | 'rgvMotionArrowSystem' | 'hasLiftMotionArrows' | 'liftMotionArrowSystem'>;
  readonly transforms: Pick<SceneTransformPreviewController, 'getGizmoTargetByEntityId' | 'cancelFolderGroupTransforms' | 'disposeStaleModelArrayGizmoProxy' | 'compositionArrayPreview' | 'clearEntityArrayPreview' | 'entityArrayPreview' | 'clearEntityArrayPreviewIfSource' | 'modelArrayGizmoProxy'>;
  readonly arrays: Pick<ModelArrayRuntimeController, 'resolveModelArrayBatchForEntityId' | 'modelArrayIdentityMode' | 'syncAllModelArrayBatches' | 'syncModelArrayTelemetryProxies' | 'modelArrayInstanceEntities'>;
  readonly selection: Pick<ScenePickingAndSelectionController, 'selectedEntityIds' | 'setHierarchySelectionIds' | 'isEntityHighlighted' | 'rebuildModelSelectionOutline' | 'resolveSelectedEntityIds' | 'localHighlightedEntityIds' | 'externalHighlightedEntityIds' | 'selectionSyncCount' | 'lastSelectionSyncDurationMs' | 'maxSelectionSyncDurationMs' | 'lastSelectionChangedEntityCount' | 'applyModelSelection'>;
  readonly readiness: Pick<SceneTriangleAndReadinessController, 'invalidateModelStatistics' | 'modelStatisticsEnvironmentSourceUrl' | 'modelReadinessErrors'>;
  readonly environment: Pick<EnvironmentAndSkyboxController, 'lightingRuntime' | 'syncAppearance' | 'syncLighting' | 'syncSkybox' | 'skyboxRuntime' | 'syncSkyboxEntity' | 'lightRigRuntime' | 'shadowRuntime'>;
  readonly effects: Pick<ScenePoiAndEffectsController, 'alarmRuntime' | 'alarmManagerIds' | 'poiEffectRuntime' | 'effectPoseNodes' | 'clickEventBindingRuntime' | 'dataPlatformScreenTextures'>;
  readonly outputs: Pick<GeneratedModelOutputController, 'defaultCargoGeneratorId' | 'modelGenerators' | 'disposeModelGenerator' | 'deviceSpawnerMarkers' | 'disposeDeviceSpawnerMarker' | 'applyModelGeneratorPresentation' | 'syncModelGeneratorEntity' | 'syncDeviceSpawnerEntity' | 'spawnedDeviceModels'>;
  readonly patrol: Pick<ScenePatrolAndRoamController, 'autoPatrolMarkerRuntime' | 'manualRoamSpawnRuntime'>;
  readonly presentation: Pick<SceneMeshPresentationController, 'meshes' | 'disposeMesh' | 'conveyorTrajectories' | 'disposeConveyorTrajectory' | 'lights' | 'disposeLight' | 'lightMarkerRuntime' | 'applyMeshInteractivity' | 'applyPrimitiveMeshAppearance' | 'applyTransform' | 'refreshConveyorTrajectoryRoot' | 'syncPrimitiveMeshEntity' | 'syncDataPlatformScreenEntity' | 'syncLightEntity'>;
  readonly locators: Pick<SceneLocatorController, 'locators' | 'disposeLocator' | 'rebuildLocatorTargetIndex' | 'applyLocatorStyle' | 'applyLocatorInteractivity' | 'syncLocatorEntity'>;
  readonly cad: Pick<SceneCadReferenceController, 'cadReferences' | 'disposeCadReference' | 'applyCadReferenceInteractivity' | 'syncCadReferenceEntity'>;
  readonly assets: Pick<ModelAssetRuntimeController, 'models' | 'disposeModel' | 'applyModelInteractivity' | 'syncModelArrayInstanceEntity' | 'syncModelEntity'>;
};


type SingleTransformPreview = { entityId: string; before: TransformComponent; after: TransformComponent | null;
  sceneId: string; document: SceneDocument; derived: SceneDocument | null; pending: boolean };

/** SceneDocumentController 的资源、状态及取消/释放操作在同一领域内维护。 */
export class SceneDocumentController {
  constructor(_context: SceneRuntimeContext, private readonly dependencies: Dependencies) {}

  public shadowDocument: SceneDocument | null = null;
  public readonly entityStates = new Map<string, EntityRuntimeState>();
  public readonly syncedEntities = new Map<string, Entity>();
  public disposed = false;
  public singleTransformPreview: SingleTransformPreview | null = null;
  public fullSyncCount = 0;
  public lastFullSyncDurationMs = 0;
  public maxFullSyncDurationMs = 0;

  /** 先关闭所有协作者共同检查的入口，最后再释放文档引用，供清理阶段读取必要的归属信息。 */
  beginDisposal(): boolean {
    if (this.disposed) return false;
    this.disposed = true;
    this.singleTransformPreview = null;
    return true;
  }

  dispose(): void {
    this.beginDisposal();
    this.entityStates.clear();
    this.syncedEntities.clear();
    this.shadowDocument = null;
    this.singleTransformPreview = null;
  }

  /** 将编辑器文档增量同步到 Babylon 运行时场景，并记录完整同步耗时。 */
  /** 单体拖拽只保持运行时预览；阵列优先沿受控局部同步链更新，未知变更回退完整同步。 */
  beginSingleTransformPreview(entityId: string, before: TransformComponent): boolean {
    if (this.disposed || this.dependencies.telemetry.telemetryPreviewActive || !this.shadowDocument || !this.dependencies.transforms.getGizmoTargetByEntityId(entityId)) return false;
    this.singleTransformPreview = { entityId, before, after: null, sceneId: this.shadowDocument.id,
      document: this.shadowDocument, derived: null, pending: false };
    return true;
  }

  updateSingleTransformPreview(entityId: string, after: TransformComponent): void {
    const preview = this.singleTransformPreview;
    if (!preview || preview.entityId !== entityId) return;
    preview.after = after;
    // 无独立节点的逻辑实例仍需重建其权威矩阵；不触发 Zustand 文档/面板更新。
    if (this.dependencies.arrays.resolveModelArrayBatchForEntityId(entityId)) preview.pending = true;
  }

  endSingleTransformPreview(): void { this.singleTransformPreview = null; }

  public flushSingleTransformPreview(): void {
    const preview = this.singleTransformPreview;
    if (!preview?.pending) return;
    preview.pending = false;
    const document = this.applySingleTransformPreview(preview.document);
    const selectedIds = [...this.dependencies.selection.selectedEntityIds];
    const options = { modelArrayIdentityMode: this.dependencies.arrays.modelArrayIdentityMode };
    // 只允许本次受控派生文档绕过活动预览门；其它变更仍逐项核对，不能临时清空预览状态冒充普通同步。
    if (this.singleTransformPreview === preview
      && this.syncEntitiesLocallyInternal(document, [preview.entityId], selectedIds, options, preview)) return;
    this.sync(document, selectedIds, options);
  }

  public applySingleTransformPreview(document: SceneDocument): SceneDocument {
    const preview = this.singleTransformPreview;
    if (!preview || !preview.after) return document;
    if (document === preview.derived) document = preview.document;
    const entity = document.entities[preview.entityId];
    if (document.id !== preview.sceneId || !entity) { this.singleTransformPreview = null; return document; }
    // 权威文档与派生预览分开保存；不能拿上一帧派生坐标误判真实外部编辑。
    if (!equalPreviewTransform(entity.components.transform, preview.before)) {
      this.singleTransformPreview = null;
      return document;
    }
    preview.document = document;
    preview.derived = { ...document, entities: { ...document.entities,
      [entity.id]: { ...entity, components: { ...entity.components, transform: preview.after } } } };
    return preview.derived;
  }

  sync(
    document: SceneDocument,
    hierarchySelectionIds?: readonly string[],
    options: SceneRuntimeSyncOptions = {},
  ): void {
    if (this.disposed) return;
    document = this.applySingleTransformPreview(document);
    const nextModelArrayIdentityMode = options.modelArrayIdentityMode ?? 'device';
    const modelArrayIdentityModeChanged = this.dependencies.arrays.modelArrayIdentityMode !== nextModelArrayIdentityMode;
    this.dependencies.arrays.modelArrayIdentityMode = nextModelArrayIdentityMode;
    this.dependencies.selection.setHierarchySelectionIds(document, hierarchySelectionIds);
    this.dependencies.transforms.cancelFolderGroupTransforms();
    const startedAt = readRuntimeTimestampMs();
    try {
      this.syncDocument(document, modelArrayIdentityModeChanged);
    } finally {
      const durationMs = Math.max(0, readRuntimeTimestampMs() - startedAt);
      this.fullSyncCount += 1;
      this.lastFullSyncDurationMs = durationMs;
      this.maxFullSyncDurationMs = Math.max(this.maxFullSyncDurationMs, durationMs);
      this.dependencies.readiness.invalidateModelStatistics();
    }
  }

  public localSyncCount = 0;
  public lastLocalSyncDurationMs = 0;

  /**
   * 只同步一组“局部可同步”的实体变更：每个实体的层级、显隐、锁定、组合与组件集合不变，
   * 且仅 transform、meshRenderer、light、camera、lighting 或名称变化。此时各组件 ID 集合、遥测箭头开关、
   * 告警、天空盒、定位器索引及其它实体的运行时状态都不受影响，只需重新应用光照与阴影、刷新这些实体及其阵列批次。
   * 任一前置条件不满足时不做任何运行时修改并返回 false，调用方必须回退完整同步。
   */
  syncEntitiesLocally(
    document: SceneDocument,
    entityIds: readonly string[],
    hierarchySelectionIds?: readonly string[],
    options?: SceneRuntimeSyncOptions,
  ): boolean {
    return this.syncEntitiesLocallyInternal(document, entityIds, hierarchySelectionIds, options, null);
  }

  private syncEntitiesLocallyInternal(
    document: SceneDocument,
    entityIds: readonly string[],
    hierarchySelectionIds: readonly string[] | undefined,
    options: SceneRuntimeSyncOptions | undefined,
    preview: SingleTransformPreview | null,
  ): boolean {
    const shadow = this.shadowDocument;
    const nextModelArrayIdentityMode = options?.modelArrayIdentityMode ?? this.dependencies.arrays.modelArrayIdentityMode;
    if (
      this.disposed || entityIds.length === 0 || !shadow || shadow === document
      || (this.singleTransformPreview !== null && this.singleTransformPreview !== preview)
      || (preview !== null && (this.singleTransformPreview !== preview || document !== preview.derived
        || entityIds.length !== 1 || entityIds[0] !== preview.entityId))
      || this.dependencies.telemetry.telemetryPreviewActive
      || nextModelArrayIdentityMode !== this.dependencies.arrays.modelArrayIdentityMode
      || shadow.id !== document.id || shadow.entityIds !== document.entityIds
      || this.syncedEntities.size !== document.entityIds.length
    ) return false;
    for (const key of new Set([...Object.keys(shadow), ...Object.keys(document)])) {
      if (key === 'entities' || key === 'selectedEntityId') continue;
      if ((shadow as Record<string, unknown>)[key] !== (document as Record<string, unknown>)[key]) return false;
    }
    const targets = new Set(entityIds);
    const changes: { previous: Entity; entity: Entity }[] = [];
    for (const entityId of targets) {
      const previous = this.syncedEntities.get(entityId);
      const entity = document.entities[entityId];
      if (!previous || !entity || !this.entityStates.has(entityId) || !isEntityLocalSyncChange(previous, entity)
        || !this.hasCompleteRuntimeEntity(entity)) return false;
      changes.push({ previous, entity });
    }
    // 以运行时实际已同步的实体为基准核对，确保除目标外没有其它实体变化。
    for (const id of document.entityIds) {
      if (!targets.has(id) && this.syncedEntities.get(id) !== document.entities[id]) return false;
    }

    this.dependencies.selection.setHierarchySelectionIds(document, hierarchySelectionIds);
    const selectedEntityIds = this.dependencies.selection.resolveSelectedEntityIds(document);
    const currentSelectedEntityIds = this.dependencies.selection.selectedEntityIds;
    // 选区同时变化时其它实体的高亮也要刷新，交给完整同步处理。
    if (selectedEntityIds.size !== currentSelectedEntityIds.size
      || [...selectedEntityIds].some(id => !currentSelectedEntityIds.has(id))) return false;

    const startedAt = readRuntimeTimestampMs();
    this.dependencies.transforms.cancelFolderGroupTransforms();
    this.shadowDocument = document;
    // 预览原先走完整同步，保留其在环境/实体更新前的光照失效入口。
    if (preview) this.dependencies.environment.lightingRuntime?.sync(document);
    this.dependencies.effects.poiEffectRuntime.setDocument(document);
    if (this.dependencies.transforms.compositionArrayPreview) {
      const preview = this.dependencies.transforms.compositionArrayPreview;
      const info = getCompositionArrayInfo(document, [preview.sourceEntityId], 1);
      const validMemberIds = new Set(info?.entityIds);
      if (!info || info.error || preview.entityIds.some(id => !validMemberIds.has(id))) this.dependencies.transforms.clearEntityArrayPreview();
    }
    // 与完整同步保持同一顺序：灯光/阴影重新应用（含阴影接收面按场景网格重算）先于实体同步。
    this.dependencies.environment.syncLighting(document);

    const nextHighlightSet = mergeSceneRuntimeHighlightEntityIds(
      selectedEntityIds,
      this.dependencies.selection.localHighlightedEntityIds,
      this.dependencies.selection.externalHighlightedEntityIds,
    );
    const dirtyModelArraySourceIds = new Set<string>();
    for (const { previous, entity } of changes) {
      const previousSourceId = previous.components.modelArrayInstance?.sourceEntityId;
      const nextSourceId = entity.components.modelArrayInstance?.sourceEntityId;
      if (previousSourceId) dirtyModelArraySourceIds.add(previousSourceId);
      if (nextSourceId) dirtyModelArraySourceIds.add(nextSourceId);
      if (entity.components.modelAsset && !entity.components.modelArrayInstance) dirtyModelArraySourceIds.add(entity.id);
      this.syncEntity(entity, this.dependencies.selection.isEntityHighlighted(entity.id, selectedEntityIds), nextHighlightSet);
      this.syncedEntities.set(entity.id, entity);
    }
    this.dependencies.arrays.syncAllModelArrayBatches(document, dirtyModelArraySourceIds);
    this.dependencies.arrays.syncModelArrayTelemetryProxies();
    this.dependencies.transforms.disposeStaleModelArrayGizmoProxy();
    this.dependencies.selection.selectedEntityIds = selectedEntityIds;
    this.dependencies.selection.rebuildModelSelectionOutline();
    this.dependencies.readiness.invalidateModelStatistics();
    this.localSyncCount += 1;
    this.lastLocalSyncDurationMs = Math.max(0, readRuntimeTimestampMs() - startedAt);
    return true;
  }

  /**
   * 只同步一个实体的模型参数值。调用方已确认 Store 本次原子更新未改变其它场景内容；
   * 因此这里不重建层级状态、组件 ID 集合或 Locator 索引，只刷新目标及其所属矩阵源。
   */
  syncModelParameters(
    document: SceneDocument,
    entityId: string,
    hierarchySelectionIds?: readonly string[],
    options?: SceneRuntimeSyncOptions,
  ): void {
    if (this.disposed) return;
    const nextModelArrayIdentityMode = options?.modelArrayIdentityMode ?? this.dependencies.arrays.modelArrayIdentityMode;
    if (nextModelArrayIdentityMode !== this.dependencies.arrays.modelArrayIdentityMode) {
      this.sync(document, hierarchySelectionIds, { modelArrayIdentityMode: nextModelArrayIdentityMode });
      return;
    }
    this.dependencies.selection.setHierarchySelectionIds(document, hierarchySelectionIds);
    this.dependencies.transforms.cancelFolderGroupTransforms();
    const entity = document.entities[entityId];
    const previousEntity = this.syncedEntities.get(entityId);
    if (!entity?.components.modelAsset || !previousEntity?.components.modelAsset) {
      this.sync(document, hierarchySelectionIds, { modelArrayIdentityMode: this.dependencies.arrays.modelArrayIdentityMode });
      return;
    }

    const dirtyModelArraySourceIds = new Set<string>();
    const previousSourceEntityId = previousEntity.components.modelArrayInstance?.sourceEntityId;
    const nextSourceEntityId = entity.components.modelArrayInstance?.sourceEntityId;
    if (previousSourceEntityId) dirtyModelArraySourceIds.add(previousSourceEntityId);
    if (nextSourceEntityId) dirtyModelArraySourceIds.add(nextSourceEntityId);
    if (!entity.components.modelArrayInstance) dirtyModelArraySourceIds.add(entity.id);

    this.syncEntity(entity, this.dependencies.selection.isEntityHighlighted(entityId));
    this.syncedEntities.set(entityId, entity);
    this.dependencies.arrays.syncAllModelArrayBatches(document, dirtyModelArraySourceIds, entityId);
    this.dependencies.arrays.syncModelArrayTelemetryProxies();
    this.dependencies.transforms.disposeStaleModelArrayGizmoProxy();
    this.dependencies.selection.rebuildModelSelectionOutline();
    this.dependencies.readiness.invalidateModelStatistics();
  }

  /** 把高亮状态依赖宿主/副本的绑定货格实体 ID 追加进刷新集合。 */
  public appendBuiltInSlotEntityIdsForHost(hostEntityId: string, target: Set<string>): void {
    for (const entity of this.syncedEntities.values()) {
      if (entity.components.locator?.builtInBinding?.hostEntityId === hostEntityId) target.add(entity.id);
    }
  }

  /**
   * 只同步选区变化。普通单选只访问旧/新目标实体以及对应共享模型或矩阵批次，
   * 不重新扫描 entityIds、加载模型、执行参数脚本或重建 Locator 索引。
   */
  syncSelection(document: SceneDocument, hierarchySelectionIds?: readonly string[]): void {
    if (this.disposed) return;
    this.dependencies.selection.setHierarchySelectionIds(document, hierarchySelectionIds);
    this.dependencies.transforms.cancelFolderGroupTransforms();
    const startedAt = readRuntimeTimestampMs();
    let changedEntityCount = 0;
    try {
      const nextSelectedEntityIds = this.dependencies.selection.resolveSelectedEntityIds(document);
      const changedEntityIds = new Set<string>();
      for (const entityId of this.dependencies.selection.selectedEntityIds) {
        if (!nextSelectedEntityIds.has(entityId)) changedEntityIds.add(entityId);
      }
      for (const entityId of nextSelectedEntityIds) {
        if (!this.dependencies.selection.selectedEntityIds.has(entityId)) changedEntityIds.add(entityId);
      }

      changedEntityCount = changedEntityIds.size;
      if (changedEntityCount === 0) return;

      const nextHighlightSet = mergeSceneRuntimeHighlightEntityIds(
        nextSelectedEntityIds,
        this.dependencies.selection.localHighlightedEntityIds,
        this.dependencies.selection.externalHighlightedEntityIds,
      );
      for (const entityId of [...changedEntityIds]) {
        this.appendBuiltInSlotEntityIdsForHost(entityId, changedEntityIds);
      }

      for (const entityId of changedEntityIds) {
        const entity = document.entities[entityId] ?? this.syncedEntities.get(entityId);
        if (!entity) continue;
        this.syncEntityPresentation(entity, this.dependencies.selection.isEntityHighlighted(entityId, nextSelectedEntityIds), nextHighlightSet);
      }

      this.dependencies.selection.selectedEntityIds = nextSelectedEntityIds;
      this.dependencies.selection.rebuildModelSelectionOutline();
    } finally {
      const durationMs = Math.max(0, readRuntimeTimestampMs() - startedAt);
      this.dependencies.selection.selectionSyncCount += 1;
      this.dependencies.selection.lastSelectionSyncDurationMs = durationMs;
      this.dependencies.selection.maxSelectionSyncDurationMs = Math.max(this.dependencies.selection.maxSelectionSyncDurationMs, durationMs);
      this.dependencies.selection.lastSelectionChangedEntityCount = changedEntityCount;
    }
  }

  /** 完整同步文档内容；调用方负责统计耗时。 */
  public syncDocument(document: SceneDocument, forceModelArrayResync = false): void {
    if (this.disposed) return;
    if (this.shadowDocument?.id !== document.id
      || this.shadowDocument?.sceneSettings.environment?.activeVariantUrl !== document.sceneSettings.environment?.activeVariantUrl) {
      this.dependencies.readiness.modelStatisticsEnvironmentSourceUrl = undefined;
    }
    this.shadowDocument = document;
    this.dependencies.environment.lightingRuntime?.sync(document);
    if (this.dependencies.transforms.compositionArrayPreview) {
      const preview = this.dependencies.transforms.compositionArrayPreview;
      const info = getCompositionArrayInfo(document, [preview.sourceEntityId], 1);
      const validMemberIds = new Set(info?.entityIds);
      if (!info || info.error || preview.entityIds.some(id => !validMemberIds.has(id))) this.dependencies.transforms.clearEntityArrayPreview();
    }
    for (const [key, failure] of this.dependencies.readiness.modelReadinessErrors) {
      if (!failure.entityIds.some(entityId => document.entities[entityId]?.components.modelAsset)) this.dependencies.readiness.modelReadinessErrors.delete(key);
    }
    const independentIds = new Set([...collectAlarmIndependentEntityIds(document), ...collectDigitalTwinEffectTargetIds(document)]);
    const overrides = [...independentIds].filter(id => document.entities[id]?.components.modelArrayInstance);
    if (overrides.length) {
      const entities = { ...document.entities };
      for (const id of overrides) { const components = { ...entities[id].components }; delete components.modelArrayInstance; entities[id] = { ...entities[id], components }; }
      document = { ...document, entities };
    }
    this.dependencies.effects.alarmRuntime.sync(document);
    this.dependencies.outputs.defaultCargoGeneratorId = document.sceneSettings.defaultCargoGeneratorId ?? null;
    this.dependencies.effects.poiEffectRuntime.setDocument(document);
    for (const [id, node] of this.dependencies.effects.effectPoseNodes) if (!document.entities[id]) { node.dispose(); this.dependencies.effects.effectPoseNodes.delete(id); }
    this.dependencies.environment.syncAppearance(document);
    this.dependencies.environment.syncLighting(document);
    const previousEntityStates = new Map(this.entityStates);
    const previousHighlightedEntityIds = mergeSceneRuntimeHighlightEntityIds(
      this.dependencies.selection.selectedEntityIds,
      this.dependencies.selection.localHighlightedEntityIds,
      this.dependencies.selection.externalHighlightedEntityIds,
    );
    const dirtyModelArraySourceIds = new Set<string>();

    this.entityStates.clear();
    const hierarchyStates = createEntityHierarchyStateMap(document.entityIds, document.entities);
    for (const [entityId, state] of hierarchyStates) this.entityStates.set(entityId, state);

    // 一次遍历完成全部组件集合与遥测箭头开关的分类，避免对 entityIds 重复扫描。
    const primitiveMeshIds = new Set<string>();
    const locatorIds = new Set<string>();
    const cadReferenceIds = new Set<string>();
    const modelArrayInstanceIds = new Set<string>();
    const modelIds = new Set<string>();
    const modelGeneratorIds = new Set<string>();
    const deviceSpawnerIds = new Set<string>();
    const lightIds = new Set<string>();
    const poiEffectIds = new Set<string>();
    const autoPatrolIds = new Set<string>();
    const manualRoamSpawnIds = new Set<string>();
    const clickEventBindingIds = new Set<string>();
    const dataPlatformScreenIds = new Set<string>();
    let hasSurfaceArrows = false;
    let hasStackerArrows = false;
    let hasRgvArrows = false;
    let hasLiftArrows = false;
    this.dependencies.effects.alarmManagerIds.clear();
    for (const entityId of document.entityIds) {
      const entity = document.entities[entityId];
      if (!entity) continue;
      const components = entity.components;
      if (components.meshRenderer) primitiveMeshIds.add(entityId);
      if (components.locator) locatorIds.add(entityId);
      if (components.cadReference) cadReferenceIds.add(entityId);
      if (components.modelAsset) {
        (components.modelArrayInstance ? modelArrayInstanceIds : modelIds).add(entityId);
        if (!hasSurfaceArrows && components.telemetryBinding?.surfaceArrows?.enabled !== false) {
          hasSurfaceArrows = components.telemetryBinding?.deviceType === 'conveyor'
            || components.modelAsset.dataDrivenConfig?.device.devType === 'conveyor'
            || isConveyorModelAsset(components.modelAsset);
        }
      }
      if (components.modelGenerator) modelGeneratorIds.add(entityId);
      if (components.deviceSpawner) deviceSpawnerIds.add(entityId);
      if (components.light) lightIds.add(entityId);
      if (components.poiEffect) poiEffectIds.add(entityId);
      if (components.autoPatrol) autoPatrolIds.add(entityId);
      if (components.manualRoamSpawn) manualRoamSpawnIds.add(entityId);
      if (this.isClickEventBindingMarkerEntity(entity)) clickEventBindingIds.add(entityId);
      if (components.alarmManager) this.dependencies.effects.alarmManagerIds.add(entityId);
      if (components.dataPlatformScreen) dataPlatformScreenIds.add(entityId);
      const binding = components.telemetryBinding;
      if (binding?.stackerMotionArrows?.enabled) hasStackerArrows = true;
      if (binding?.rgvMotionArrows?.enabled) hasRgvArrows = true;
      if (binding?.liftMotionArrows?.enabled) hasLiftArrows = true;
    }
    const telemetry = this.dependencies.telemetry;
    if (telemetry.hasConveyorSurfaceArrows && !hasSurfaceArrows) telemetry.conveyorSurfaceArrowSystem.clear();
    telemetry.hasConveyorSurfaceArrows = hasSurfaceArrows;
    if (telemetry.hasStackerMotionArrows && !hasStackerArrows) telemetry.stackerMotionArrowSystem.clear();
    telemetry.hasStackerMotionArrows = hasStackerArrows;
    if (telemetry.hasRgvMotionArrows && !hasRgvArrows) telemetry.rgvMotionArrowSystem.clear();
    telemetry.hasRgvMotionArrows = hasRgvArrows;
    if (telemetry.hasLiftMotionArrows && !hasLiftArrows) telemetry.liftMotionArrowSystem.clear();
    telemetry.hasLiftMotionArrows = hasLiftArrows;
    if (forceModelArrayResync) {
      for (const modelId of modelIds) dirtyModelArraySourceIds.add(modelId);
    }

    const previewSourceId = this.dependencies.transforms.entityArrayPreview?.sourceEntityId;
    if (previewSourceId && this.dependencies.effects.poiEffectRuntime.has(previewSourceId) && !poiEffectIds.has(previewSourceId)) {
      this.dependencies.transforms.clearEntityArrayPreview();
    }
    this.dependencies.effects.poiEffectRuntime.disposeMissing(poiEffectIds);
    this.dependencies.patrol.autoPatrolMarkerRuntime.disposeMissing(autoPatrolIds);
    this.dependencies.patrol.manualRoamSpawnRuntime.disposeMissing(manualRoamSpawnIds);
    this.dependencies.effects.clickEventBindingRuntime.disposeMissing(clickEventBindingIds);
    for (const [entityId, entry] of this.dependencies.effects.dataPlatformScreenTextures.entries()) {
      if (dataPlatformScreenIds.has(entityId)) continue;
      const material = this.dependencies.presentation.meshes.get(entityId)?.material;
      if (material instanceof StandardMaterial && material.diffuseTexture === entry.texture) {
        material.diffuseTexture = null;
      }
      entry.texture.dispose();
      this.dependencies.effects.dataPlatformScreenTextures.delete(entityId);
    }
    for (const [entityId, mesh] of this.dependencies.presentation.meshes.entries()) {
      if (!primitiveMeshIds.has(entityId)) {
        this.dependencies.presentation.disposeMesh(entityId, mesh);
      }
    }

    for (const [entityId, locator] of this.dependencies.locators.locators.entries()) {
      if (!locatorIds.has(entityId)) {
        this.dependencies.locators.disposeLocator(entityId, locator);
      }
    }

    for (const [entityId, cadReference] of this.dependencies.cad.cadReferences.entries()) {
      if (!cadReferenceIds.has(entityId)) {
        this.dependencies.cad.disposeCadReference(entityId, cadReference);
      }
    }

    for (const [entityId, model] of this.dependencies.assets.models.entries()) {
      if (!modelIds.has(entityId)) {
        this.dependencies.assets.disposeModel(entityId, model);
      }
    }

    for (const entityId of [...this.dependencies.arrays.modelArrayInstanceEntities.keys()]) {
      if (modelArrayInstanceIds.has(entityId)) continue;
      const previousSourceId = this.dependencies.arrays.modelArrayInstanceEntities.get(entityId)?.components.modelArrayInstance?.sourceEntityId;
      if (previousSourceId) dirtyModelArraySourceIds.add(previousSourceId);
      this.dependencies.arrays.modelArrayInstanceEntities.delete(entityId);
      const trajectory = this.dependencies.presentation.conveyorTrajectories.get(entityId);
      if (trajectory) this.dependencies.presentation.disposeConveyorTrajectory(entityId, trajectory);
    }
    for (const [entityId, modelGenerator] of this.dependencies.outputs.modelGenerators.entries()) {
      if (!modelGeneratorIds.has(entityId)) {
        this.dependencies.outputs.disposeModelGenerator(entityId, modelGenerator);
      }
    }
    for (const entityId of [...this.dependencies.outputs.deviceSpawnerMarkers.keys()]) {
      if (!deviceSpawnerIds.has(entityId)) {
        this.dependencies.outputs.disposeDeviceSpawnerMarker(entityId);
      }
    }

    for (const [entityId, light] of this.dependencies.presentation.lights.entries()) {
      if (!lightIds.has(entityId)) {
        this.dependencies.presentation.disposeLight(entityId, light);
      }
    }
    this.dependencies.presentation.lightMarkerRuntime.disposeMissing(lightIds);

    for (const entityId of [...this.syncedEntities.keys()]) {
      if (!document.entities[entityId]) this.syncedEntities.delete(entityId);
    }
    for (const entityId of this.dependencies.selection.localHighlightedEntityIds) {
      if (!document.entities[entityId]) this.dependencies.selection.localHighlightedEntityIds.delete(entityId);
    }
    for (const entityId of this.dependencies.selection.externalHighlightedEntityIds) {
      if (!document.entities[entityId]) this.dependencies.selection.externalHighlightedEntityIds.delete(entityId);
    }

    const selectedEntityIds = this.dependencies.selection.resolveSelectedEntityIds(document);
    const nextHighlightSet = mergeSceneRuntimeHighlightEntityIds(
      selectedEntityIds,
      this.dependencies.selection.localHighlightedEntityIds,
      this.dependencies.selection.externalHighlightedEntityIds,
    );

    for (const entityId of document.entityIds) {
      const entity = document.entities[entityId];
      if (!entity) continue;

      const selected = this.dependencies.selection.isEntityHighlighted(entityId, selectedEntityIds);
      const previousEntity = this.syncedEntities.get(entityId);
      const previousState = previousEntityStates.get(entityId);
      const nextState = this.entityStates.get(entityId);
      const entityChanged = previousEntity !== entity;
      const runtimeStateChanged = !this.areEntityRuntimeStatesEqual(previousState, nextState);
      const slotBinding = entity.components.locator?.builtInBinding;
      const slotHostHighlightChanged = slotBinding
        ? previousHighlightedEntityIds.has(slotBinding.hostEntityId)
          !== this.dependencies.selection.isEntityHighlighted(slotBinding.hostEntityId, nextHighlightSet)
        : false;
      const presentationChanged = previousHighlightedEntityIds.has(entityId) !== selected
        || runtimeStateChanged
        || slotHostHighlightChanged;
      if (entityChanged || runtimeStateChanged) {
        const previousSourceId = previousEntity?.components.modelArrayInstance?.sourceEntityId;
        const nextSourceId = entity.components.modelArrayInstance?.sourceEntityId;
        if (previousSourceId) dirtyModelArraySourceIds.add(previousSourceId);
        if (nextSourceId) dirtyModelArraySourceIds.add(nextSourceId);
        if (entity.components.modelAsset && !entity.components.modelArrayInstance) {
          dirtyModelArraySourceIds.add(entity.id);
        }
      }

      if (entityChanged || !this.hasCompleteRuntimeEntity(entity)) {
        this.syncEntity(entity, selected, nextHighlightSet);
      } else if (presentationChanged) {
        this.syncEntityPresentation(entity, selected, nextHighlightSet);
      }

      this.syncedEntities.set(entityId, entity);
    }

    this.dependencies.environment.syncSkybox(document);
    this.dependencies.arrays.syncAllModelArrayBatches(document, dirtyModelArraySourceIds);
    this.dependencies.arrays.syncModelArrayTelemetryProxies();
    this.dependencies.transforms.disposeStaleModelArrayGizmoProxy();
    this.dependencies.selection.selectedEntityIds = selectedEntityIds;
    this.dependencies.locators.rebuildLocatorTargetIndex(document);
    this.dependencies.selection.rebuildModelSelectionOutline();
  }

  /** 判断实体已有的 Babylon 对象是否覆盖其全部运行时组件；缺失时回退完整同步。 */
  public hasCompleteRuntimeEntity(entity: Entity): boolean {
    if (entity.components.meshRenderer && !this.dependencies.presentation.meshes.has(entity.id)) return false;
    if (entity.components.skybox && !this.dependencies.environment.skyboxRuntime.hasEntity(entity.id)) return false;
    if (entity.components.locator && !this.dependencies.locators.locators.has(entity.id)) return false;
    if (entity.components.cadReference && !this.dependencies.cad.cadReferences.has(entity.id)) return false;
    if (entity.components.modelAsset) {
      if (entity.components.modelArrayInstance && !this.dependencies.arrays.modelArrayInstanceEntities.has(entity.id)) return false;
      if (!entity.components.modelArrayInstance && !this.dependencies.assets.models.has(entity.id)) return false;
    }
    if (entity.components.modelGenerator && !this.dependencies.outputs.modelGenerators.has(entity.id)) return false;
    if (entity.components.poiEffect && !this.dependencies.effects.poiEffectRuntime.has(entity.id)) return false;
    if (entity.components.light && !this.dependencies.presentation.lights.has(entity.id)) return false;
    if (entity.components.light && !this.dependencies.presentation.lightMarkerRuntime.isComplete(entity)) return false;
    if (entity.components.autoPatrol && !this.dependencies.patrol.autoPatrolMarkerRuntime.isComplete(entity)) return false;
    if (entity.components.manualRoamSpawn && !this.dependencies.patrol.manualRoamSpawnRuntime.isComplete(entity)) return false;
    if (this.isClickEventBindingMarkerEntity(entity) && !this.dependencies.effects.clickEventBindingRuntime.isComplete(entity)) return false;
    return true;
  }

  /** 比较实体有效显隐和锁定状态，避免未变化实体重复进入完整同步链。 */
  public areEntityRuntimeStatesEqual(
    previous: EntityRuntimeState | undefined,
    next: EntityRuntimeState | undefined,
  ): boolean {
    return previous?.visible === next?.visible && previous?.locked === next?.locked;
  }

  /** 仅刷新选择、显隐和锁定相关表现，不重复执行模型加载、参数或外置脚本。 */
  public syncEntityPresentation(
    entity: Entity,
    selected: boolean,
    highlightSet: ReadonlySet<string> = this.dependencies.selection.selectedEntityIds,
  ): void {
    this.dependencies.transforms.clearEntityArrayPreviewIfSource(entity.id);
    const primitiveMesh = this.dependencies.presentation.meshes.get(entity.id);
    const meshRenderer = entity.components.meshRenderer;
    if (primitiveMesh && meshRenderer) {
      this.dependencies.presentation.applyMeshInteractivity(primitiveMesh, entity.id);
      this.dependencies.effects.poiEffectRuntime.withTargetMutation(entity.id, () => this.dependencies.presentation.applyPrimitiveMeshAppearance(primitiveMesh, meshRenderer, selected));
    }

    if (entity.components.skybox) this.dependencies.environment.syncSkyboxEntity(entity, selected);

    const locator = this.dependencies.locators.locators.get(entity.id);
    if (locator && entity.components.locator) {
      this.dependencies.locators.applyLocatorStyle(locator, selected);
      this.dependencies.locators.applyLocatorInteractivity(locator, entity, highlightSet);
    }

    const cadReference = this.dependencies.cad.cadReferences.get(entity.id);
    if (cadReference) {
      this.dependencies.cad.applyCadReferenceInteractivity(cadReference, entity.id);
    }

    if (entity.components.modelArrayInstance) {
      this.dependencies.arrays.modelArrayInstanceEntities.set(entity.id, entity);
      if (this.dependencies.transforms.modelArrayGizmoProxy?.entityId === entity.id) {
        this.dependencies.presentation.applyTransform(this.dependencies.transforms.modelArrayGizmoProxy.node, entity.components.transform);
        this.dependencies.transforms.modelArrayGizmoProxy.node.computeWorldMatrix(true);
      }
    } else {
      const model = this.dependencies.assets.models.get(entity.id);
      if (model) {
        this.dependencies.selection.applyModelSelection(model, selected);
        this.dependencies.assets.applyModelInteractivity(model, entity.id, highlightSet);
      }
    }

    const modelGenerator = this.dependencies.outputs.modelGenerators.get(entity.id);
    if (modelGenerator) {
      modelGenerator.selected = selected;
      this.dependencies.outputs.applyModelGeneratorPresentation(modelGenerator);
    }

    if (entity.components.poiEffect) {
      this.dependencies.effects.poiEffectRuntime.sync(
        entity,
        selected,
        this.isEntityVisible(entity.id),
        this.isEntityScenePickable(entity.id),
      );
    }

    if (entity.components.autoPatrol) {
      this.dependencies.patrol.autoPatrolMarkerRuntime.syncPresentation(
        entity,
        selected,
        this.isEntityVisible(entity.id),
        this.isEntityScenePickable(entity.id),
      );
    }

    if (entity.components.manualRoamSpawn) {
      this.dependencies.patrol.manualRoamSpawnRuntime.syncPresentation(
        entity,
        selected,
        this.isEntityVisible(entity.id),
        this.isEntityScenePickable(entity.id),
      );
    }

    if (this.isClickEventBindingMarkerEntity(entity)) {
      this.dependencies.effects.clickEventBindingRuntime.syncPresentation(
        entity,
        selected,
        this.isEntityVisible(entity.id),
        this.isEntityScenePickable(entity.id),
      );
    }

    const light = this.dependencies.presentation.lights.get(entity.id);
    if (light) {
      this.dependencies.environment.lightRigRuntime.syncEntityLight(entity.id, light, this.isEntityVisible(entity.id));
      this.dependencies.environment.shadowRuntime.syncLight(entity.id, light);
    }
    if (light && entity.components.light) {
      this.dependencies.presentation.lightMarkerRuntime.syncPresentation(
        entity.id,
        selected,
        this.isEntityVisible(entity.id),
        this.isEntityScenePickable(entity.id),
      );
    }

    const trajectory = this.dependencies.presentation.conveyorTrajectories.get(entity.id);
    if (trajectory) this.dependencies.presentation.refreshConveyorTrajectoryRoot(entity, trajectory.root);
  }

  /** 按组件类型同步单个实体的运行时表现。 */
  public syncEntity(
    entity: Entity,
    selected: boolean,
    highlightSet: ReadonlySet<string> = this.dependencies.selection.selectedEntityIds,
  ): void {
    this.dependencies.transforms.clearEntityArrayPreviewIfSource(entity.id);
    if (entity.components.meshRenderer) {
      this.dependencies.presentation.syncPrimitiveMeshEntity(entity, selected);
    }

    if (entity.components.dataPlatformScreen) {
      this.dependencies.presentation.syncDataPlatformScreenEntity(entity);
    }

    if (entity.components.skybox) {
      this.dependencies.environment.syncSkyboxEntity(entity, selected);
    }

    if (entity.components.locator) {
      this.dependencies.locators.syncLocatorEntity(entity, selected, highlightSet);
    }

    if (entity.components.cadReference) {
      this.dependencies.cad.syncCadReferenceEntity(entity);
    }

    if (entity.components.modelAsset) {
      if (entity.components.modelArrayInstance) this.dependencies.assets.syncModelArrayInstanceEntity(entity, highlightSet);
      else this.dependencies.assets.syncModelEntity(entity, selected, highlightSet);
    }

    if (entity.components.modelGenerator) {
      this.dependencies.outputs.syncModelGeneratorEntity(entity, selected);
    }

    if (entity.components.deviceSpawner) {
      this.dependencies.outputs.syncDeviceSpawnerEntity(entity, selected);
    }

    if (entity.components.poiEffect) {
      this.dependencies.effects.poiEffectRuntime.sync(
        entity,
        selected,
        this.isEntityVisible(entity.id),
        this.isEntityScenePickable(entity.id),
      );
    }

    if (entity.components.autoPatrol) {
      this.dependencies.patrol.autoPatrolMarkerRuntime.sync(
        entity,
        selected,
        this.isEntityVisible(entity.id),
        this.isEntityScenePickable(entity.id),
      );
    }

    if (entity.components.manualRoamSpawn) {
      this.dependencies.patrol.manualRoamSpawnRuntime.sync(
        entity,
        selected,
        this.isEntityVisible(entity.id),
        this.isEntityScenePickable(entity.id),
      );
    }

    if (this.isClickEventBindingMarkerEntity(entity)) {
      this.dependencies.effects.clickEventBindingRuntime.sync(
        entity,
        selected,
        this.isEntityVisible(entity.id),
        this.isEntityScenePickable(entity.id),
      );
    }

    if (entity.components.light) {
      this.dependencies.presentation.syncLightEntity(entity, selected);
    }
  }

  /** 判断实体当前是否应在 Babylon 场景中显示。 */
  public isEntityVisible(entityId: string): boolean {
    return this.entityStates.get(entityId)?.visible !== false;
  }

  /** 判断实体是否允许被 Scene View 鼠标拾取。 */
  public isEntityScenePickable(entityId: string): boolean {
    const state = this.entityStates.get(entityId);
    if (state?.visible === false || state?.locked === true) return false;
    // 内置货格绑定期间位置由货架驱动，场景内点击穿透到货架。
    if (this.syncedEntities.get(entityId)?.components.locator?.builtInBinding) return false;
    return true;
  }

  /**
   * 点击事件绑定是否按 POI 标记呈现：生成器实体（模型生成器/设备产生器）自带的绑定
   * 作用域是它的产物，不生成全场匹配标记，也不参与标记的完整性与销毁管理。
   */
  public isClickEventBindingMarkerEntity(entity: Entity): boolean {
    if (!entity.components.clickEventBinding) return false;
    return !entity.components.modelGenerator && !entity.components.deviceSpawner;
  }

  /** 任意生成器实体配置了点击事件才需要做生成物拾取，否则普通点击可跳过这次全场景射线。 */
  public hasGeneratedUnitClickBinding(): boolean {
    const document = this.shadowDocument;
    if (!document) return false;
    for (const entityId of document.entityIds) {
      const components = document.entities[entityId]?.components;
      if (!components?.modelGenerator && !components?.deviceSpawner) continue;
      if (components.clickEventBinding?.events.some((event) => event.eventType === 'click')) return true;
    }
    return false;
  }

  /** 动态设备实例没有文档实体，用合成 id 反查实例模型；非合成 id 返回 null。 */
  public resolveSpawnedDeviceModel(entityId: string): ModelRuntimeEntry | null {
    const key = parseSpawnedDeviceEntityId(entityId);
    return key ? this.dependencies.outputs.spawnedDeviceModels.get(key) ?? null : null;
  }

  /** 运行态模型查找：文档实体模型优先，其次是动态设备实例的合成实体 id。 */
  public resolveRuntimeModelByEntityId(entityId: string): ModelRuntimeEntry | null {
    const model = this.dependencies.assets.models.get(entityId);
    if (model) return model;
    return this.resolveSpawnedDeviceModel(entityId);
  }

  /** 运行预览和发布 Viewer 的只读选择只要求模型可见，不继承 authoring lock。 */
  public isRuntimeModelSceneSelectable(entityId: string): boolean {
    return isRuntimeModelSelectionCandidate(
      this.syncedEntities.get(entityId),
      this.entityStates.get(entityId),
    );
  }

  /** 判断实体是否允许绑定 Transform Gizmo。 */
  public isEntityTransformEditable(entityId: string): boolean {
    return this.isEntityScenePickable(entityId);
  }
}
