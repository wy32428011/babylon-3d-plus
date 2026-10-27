import type { GeneratedUnitClickHit } from '../../../editor/model/clickEventBinding';
import { getChartMarkerClickEvents } from '../../../editor/model/chartMarker';
import { Plane } from '@babylonjs/core/Maths/math.plane.js';
import { Matrix, Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh.js';

import { collectFolderRuntimeEntityIds } from '../../../editor/model/entityHierarchy';
import type { Vector3Data } from '../../../editor/model/math';
import type { SceneDocument } from '../../../editor/model/SceneDocument';
import { type AutoPatrolMarkerPick } from '../EditorAutoPatrolRuntime';
import { intersectWorldRayWithModelDisplayBounds } from '../modelPickBounds';
import { prepareInstancedMeshesForSelectionOutline } from '../instancedSelectionBuffers';
import { EntityArrayThinInstanceBatch } from '../EntityArrayThinInstanceBatch';
import { mergeSceneRuntimeHighlightEntityIds } from '../sceneRuntimeHighlight';
import { clearSceneSelectionHighlight, createSceneSelectionHighlightLayer, setSceneSelectionHighlightGroups, type SceneSelectionHighlightLayer } from '../sceneSelectionHighlight';
import { excludeFixedTrackMeshes, getFixedTrackNodes } from '../fixedTrackHighlightNodes';
import type { SceneRuntimeContext } from './SceneRuntimeContext';
import { runSceneRuntimeCleanup } from './sceneRuntimeCleanup';
import type { SceneDocumentController } from './SceneDocumentController';
import type { ScenePatrolAndRoamController } from './ScenePatrolAndRoamController';
import type { SceneMeshPresentationController } from './SceneMeshPresentationController';
import type { SceneLocatorController } from './SceneLocatorController';
import type { ModelArrayRuntimeController } from './ModelArrayRuntimeController';
import type { ModelAssetRuntimeController } from './ModelAssetRuntimeController';
import type { GeneratedModelOutputController } from './GeneratedModelOutputController';
import type { ScenePoiAndEffectsController } from './ScenePoiAndEffectsController';
import type { EnvironmentAndSkyboxController } from './EnvironmentAndSkyboxController';
import type { SceneTelemetryController } from './SceneTelemetryController';
import { EDITOR_ENTITY_ID_METADATA_KEY, type EditorMeshMetadata, type ModelRuntimeEntry, type LocatorRuntimeEntry, type LocatorSlotHighlightState, type LocatorSlotHighlightOverlay, isChainConveyorModelAsset, readGeneratedUnitClickTarget, collectGeneratedOutputMeshes } from './sceneRuntimeTypes';

/** 此领域仅能访问明确列出的协作能力，资源与缓存由所属 Controller 持有。 */
type Dependencies = {
  readonly document: Pick<SceneDocumentController, 'syncedEntities' | 'hasGeneratedUnitClickBinding' | 'isEntityVisible' | 'isRuntimeModelSceneSelectable' | 'isEntityScenePickable' | 'appendBuiltInSlotEntityIdsForHost' | 'syncEntityPresentation' | 'resolveSpawnedDeviceModel'>;
  readonly patrol: Pick<ScenePatrolAndRoamController, 'autoPatrolMarkerRuntime' | 'manualRoamSpawnRuntime'>;
  readonly presentation: Pick<SceneMeshPresentationController, 'meshes' | 'lightMarkerRuntime'>;
  readonly locators: Pick<SceneLocatorController, 'locators' | 'refreshSlotHighlightOverlay' | 'refreshLocatorPresentation' | 'disposeSlotHighlightOverlay'>;
  readonly arrays: Pick<ModelArrayRuntimeController, 'modelArrayBatchByMeshUniqueId' | 'modelArrayInstanceEntities' | 'resolveModelArrayBatchForEntityId'>;
  readonly assets: Pick<ModelAssetRuntimeController, 'models'>;
  readonly outputs: Pick<GeneratedModelOutputController, 'modelGenerators' | 'deviceSpawnerMarkers' | 'generatedOutputOwners'>;
  readonly effects: Pick<ScenePoiAndEffectsController, 'poiEffectRuntime' | 'clickEventBindingRuntime'>;
  readonly environment: Pick<EnvironmentAndSkyboxController, 'skyboxRuntime' | 'lightingRuntime'>;
  readonly telemetry: Pick<SceneTelemetryController, 'motionStaticBatchRuntime'>;
};


/** ScenePickingAndSelectionController 的资源、状态及取消/释放操作在同一领域内维护。 */
export class ScenePickingAndSelectionController {
  constructor(private readonly context: SceneRuntimeContext, private readonly dependencies: Dependencies) {}

  public selectedEntityIds = new Set<string>();
  public localHighlightedEntityIds = new Set<string>();
  public externalHighlightedEntityIds = new Set<string>();
  /** 点击事件绑定「忽略固定轨道」生效的实体：高亮描边时剔除固定轨道子树网格。 */
  public clickHighlightExcludeTrackEntityIds = new Set<string>();
  public hierarchySelectionIds: string[] | null = null;
  public modelSelectionOutlineLayer!: SceneSelectionHighlightLayer;
  /** 本地交互（点击单元事件）产生的单格高亮，与外部搜索高亮各自独立互不覆盖。 */
  public localSlotHighlight: LocatorSlotHighlightState | null = null;
  public externalSlotHighlight: LocatorSlotHighlightState | null = null;
  public localSlotHighlightOverlay: LocatorSlotHighlightOverlay | null = null;
  public externalSlotHighlightOverlay: LocatorSlotHighlightOverlay | null = null;
  public outlinedModelArrayBatches = new Set<EntityArrayThinInstanceBatch>();
  public selectionSyncCount = 0;
  public lastSelectionSyncDurationMs = 0;
  public maxSelectionSyncDurationMs = 0;
  public lastSelectionChangedEntityCount = 0;
  private disposed = false;

  /** 清理高亮的拥有关系，不再刷新即将释放的定位器表现。 */
  clearSlotHighlights(): void {
    this.localSlotHighlight = this.externalSlotHighlight = null;
    runSceneRuntimeCleanup(this.context, '本地货格高亮', () => this.dependencies.locators.disposeSlotHighlightOverlay('local'));
    runSceneRuntimeCleanup(this.context, '外部货格高亮', () => this.dependencies.locators.disposeSlotHighlightOverlay('external'));
    this.localSlotHighlightOverlay = this.externalSlotHighlightOverlay = null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearSlotHighlights();
    runSceneRuntimeCleanup(this.context, '模型选择描边', () => this.modelSelectionOutlineLayer.dispose());
    this.selectedEntityIds.clear();
    this.localHighlightedEntityIds.clear();
    this.externalHighlightedEntityIds.clear();
    this.clickHighlightExcludeTrackEntityIds.clear();
    this.outlinedModelArrayBatches.clear();
    this.hierarchySelectionIds = null;
  }

  /** 无限远背景始终不是场景可选对象。 */
  public isEntityPickableFromActiveCamera(entityId: string): boolean {
    return !this.dependencies.document.syncedEntities.get(entityId)?.components.skybox;
  }

  /** 优先拾取巡检节点编号；路线原点返回 waypointId=null。 */
  pickAutoPatrolAtCanvasPoint(clientX: number, clientY: number, canvas: HTMLCanvasElement): AutoPatrolMarkerPick | null {
    const point = this.getCanvasPickPoint(clientX, clientY, canvas);
    if (!point) return null;
    const picks = this.context.scene.multiPick(point.x, point.y, (mesh) => {
      if (mesh.isDisposed() || !mesh.isEnabled() || !mesh.isVisible || mesh.visibility <= 0 || !mesh.isPickable) {
        return false;
      }
      return this.dependencies.patrol.autoPatrolMarkerRuntime.readPick(mesh) !== null;
    }) ?? [];
    picks.sort((left, right) => left.distance - right.distance);
    for (const picked of picks) {
      const result = this.dependencies.patrol.autoPatrolMarkerRuntime.readPick(picked.pickedMesh ?? null);
      if (result) return result;
    }
    return null;
  }

  /** 在画布客户端坐标位置拾取可编辑 Mesh，并把 thinInstanceIndex 还原为具体阵列实体 ID。 */
  pickEntityIdAtCanvasPoint(clientX: number, clientY: number, canvas: HTMLCanvasElement): string | null {
    return this.pickSceneEntityHitAtCanvasPoint(clientX, clientY, canvas, 'editable')?.entityId ?? null;
  }

  /** 运行预览和发布 Viewer 只读拾取真实业务模型；locked 不影响查看，但隐藏和辅助对象仍被过滤。 */
  pickRuntimeModelEntityIdAtCanvasPoint(
    clientX: number,
    clientY: number,
    canvas: HTMLCanvasElement,
  ): string | null {
    return this.pickSceneEntityHitAtCanvasPoint(clientX, clientY, canvas, 'runtime-model')?.entityId ?? null;
  }

  /** 同 pickRuntimeModelEntityIdAtCanvasPoint，附带命中距离用于与货格填充体命中做前后比较。 */
  pickRuntimeModelHitAtCanvasPoint(
    clientX: number,
    clientY: number,
    canvas: HTMLCanvasElement,
  ): { entityId: string; distance: number; precise: boolean } | null {
    return this.pickSceneEntityHitAtCanvasPoint(clientX, clientY, canvas, 'runtime-model');
  }

  /**
   * 运行态拾取生成器产物（货箱或动态设备实例）用于点击事件绑定。
   * 单独一条链路：产物不带 editorEntityId，常规实体拾取会按元数据把它们过滤掉。
   * 未配置点击事件的生成器产物也会被拾取到，由调用方在决策阶段回落到常规点击。
   */
  pickGeneratedUnitClickTargetAtCanvasPoint(
    clientX: number,
    clientY: number,
    canvas: HTMLCanvasElement,
  ): { hit: GeneratedUnitClickHit; distance: number } | null {
    // 没有生成器配置点击事件时，不为普通点击增加一次全场景射线检测。
    if (!this.dependencies.document.hasGeneratedUnitClickBinding()) return null;
    const point = this.getCanvasPickPoint(clientX, clientY, canvas);
    if (!point) return null;
    const picks = this.context.scene.multiPick(point.x, point.y, (mesh) => (
      !mesh.isDisposed()
      && mesh.isEnabled()
      && mesh.isVisible
      && mesh.visibility > 0
      && mesh.isPickable
      && readGeneratedUnitClickTarget(mesh) !== null
    )) ?? [];
    picks.sort((left, right) => left.distance - right.distance);
    for (const picked of picks) {
      const hit = picked.pickedMesh ? readGeneratedUnitClickTarget(picked.pickedMesh) : null;
      if (hit) return { hit, distance: picked.distance };
    }
    return null;
  }

  /** 运行态点击立标正文：按真实几何深度拾取，前景模型和其他立标都能阻挡点击。 */
  pickChartMarkerAtCanvasPoint(clientX: number, clientY: number, canvas: HTMLCanvasElement): string | null {
    // 没有已配置动作的可见立标时，不为普通模型点击增加一次全场景射线检测。
    let hasClickEvents = false;
    for (const entityId of this.dependencies.presentation.meshes.keys()) {
      const component = this.dependencies.document.syncedEntities.get(entityId)?.components.chartMarker;
      if (component && this.dependencies.document.isEntityVisible(entityId)
        && getChartMarkerClickEvents(component, entityId).some(event => event.actions.length > 0)) {
        hasClickEvents = true;
        break;
      }
    }
    if (!hasClickEvents) return null;
    const point = this.getCanvasPickPoint(clientX, clientY, canvas);
    const camera = this.context.scene.cameraToUseForPointers ?? this.context.scene.activeCamera;
    if (!point || !camera) return null;
    const pick = this.context.scene.pick(point.x, point.y, (mesh) => (
      !mesh.isDisposed() && mesh.isEnabled() && mesh.isVisible && mesh.visibility > 0
      && (mesh.layerMask & camera.layerMask) !== 0 && (mesh.material?.alpha ?? 1) > 0
    ), false, camera);
    if (!pick?.hit || !pick.pickedMesh) return null;
    const entityId = this.readEntityIdFromMesh(pick.pickedMesh, pick.thinInstanceIndex);
    if (!entityId || !this.dependencies.document.isEntityVisible(entityId) || this.dependencies.presentation.meshes.get(entityId) !== pick.pickedMesh) return null;
    return this.dependencies.document.syncedEntities.get(entityId)?.components.chartMarker ? entityId : null;
  }

  /**
   * 对所有内置绑定货格做解析射线拾取，返回最近命中格（业务 排-列-层）、宿主与命中距离。
   * 不用网格拾取：预览里货格 root 被禁用，拾取不稳定；且货架是框架，模型拾取会透过空格命中后排。
   * 改为在货格局部空间做射线与网格范围盒的 slab 求交，进入点直接归格：
   * 前/背/侧面进入时进入点即点击格面；顶/底面进入（近似俯视/仰视）时视线落在顶/底面上，
   * 用户看到的就是最顶/底层，进入点同时给出正确列与层。
   * 相机在盒内（飞行穿行）时改用射线朝向前方的前/背表面平面交点归格。
   * 多排竞争按射线真实命中盒体的先后排序，避免穿透到另一排。
   */
  pickBuiltInSlotCellAtCanvasPoint(
    clientX: number,
    clientY: number,
    canvas: HTMLCanvasElement,
  ): { locatorEntityId: string; hostEntityId: string; row: number; column: number; layer: number; distance: number } | null {
    const point = this.getCanvasPickPoint(clientX, clientY, canvas);
    if (!point) return null;
    const camera = this.context.scene.cameraToUseForPointers ?? this.context.scene.activeCamera;
    if (!camera) return null;
    const ray = this.context.scene.createPickingRay(point.x, point.y, Matrix.Identity(), camera);

    let bestEntityId: string | null = null;
    let bestEntry: LocatorRuntimeEntry | null = null;
    let bestLocal: Vector3 | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (const [entityId, entry] of this.dependencies.locators.locators) {
      if (entry.fillMesh.isDisposed()) continue;
      // 只有内置绑定货格参与点击单元拾取；独立摆放的货格线框不算单元。
      const hostEntityId = this.dependencies.document.syncedEntities.get(entityId)?.components.locator?.builtInBinding?.hostEntityId;
      if (!hostEntityId) continue;

      const worldMatrix = entry.root.getWorldMatrix();
      // Matrix.invert() 原地修改，而 getWorldMatrix() 返回节点内部矩阵引用，
      // 原地逆转会腐蚀该节点世界矩阵并使下方 worldPoint 计算失真；必须用静态版生成新矩阵。
      const inverseWorld = Matrix.Invert(worldMatrix);
      const origin = Vector3.TransformCoordinates(ray.origin, inverseWorld);
      const direction = Vector3.TransformNormal(ray.direction, inverseWorld);

      // 网格范围盒：列向 x、层向 y、进深 z；与 buildLocatorGridMeshes 的中心公式同源。
      const { length, height, width } = entry.cellSize;
      const spanMinX = Math.min(0, (entry.columns - 1) * entry.cellSteps.columnStepX);
      const spanMaxX = Math.max(0, (entry.columns - 1) * entry.cellSteps.columnStepX);
      const minX = spanMinX - length / 2;
      const maxX = spanMaxX + length / 2;
      const minY = 0;
      const maxY = (entry.layers - 1) * entry.cellSteps.layerStepY + height;
      const minZ = -width / 2;
      const maxZ = width / 2;

      const slabs = [
        { o: origin.x, d: direction.x, min: minX, max: maxX },
        { o: origin.y, d: direction.y, min: minY, max: maxY },
        { o: origin.z, d: direction.z, min: minZ, max: maxZ },
      ];
      let tEnter = -Infinity;
      let tExit = Infinity;
      let intersects = true;
      for (const slab of slabs) {
        if (Math.abs(slab.d) < 1e-8) {
          if (slab.o < slab.min || slab.o > slab.max) { intersects = false; break; }
          continue;
        }
        let t0 = (slab.min - slab.o) / slab.d;
        let t1 = (slab.max - slab.o) / slab.d;
        if (t0 > t1) [t0, t1] = [t1, t0];
        if (t0 > tEnter) tEnter = t0;
        tExit = Math.min(tExit, t1);
        if (tEnter > tExit) { intersects = false; break; }
      }
      if (!intersects || tExit <= 0) continue;

      let local: Vector3;
      let tHit: number;
      if (tEnter > 0) {
        // 前/背/侧面进入：进入点即点击格面。顶/底面进入（近似俯视/仰视）时视线落在顶/底面上，
        // 用户看到的就是最顶/底层，进入点同时给出正确列与层 —— 不能改用前表面平面交点，
        // 近垂直视线下该交点会沿列向飞出网格，被钳制到起始/终结列。
        local = origin.add(direction.scale(tEnter));
        tHit = tEnter;
      } else {
        // 相机在盒内：按射线朝向取前方的前/背表面平面交点（列准确，层按该面投影）。
        const faceZ = direction.z >= 0 ? maxZ : minZ;
        if (Math.abs(direction.z) < 1e-8) continue;
        const tFace = (faceZ - origin.z) / direction.z;
        if (tFace <= 0) continue;
        local = origin.add(direction.scale(tFace));
        tHit = tFace;
      }

      // 前表面平面交点可能超出网格范围（如在盒子上方），钳制回范围后就近归格。
      const clamped = new Vector3(
        Math.min(maxX, Math.max(minX, local.x)),
        Math.min(maxY, Math.max(minY, local.y)),
        local.z,
      );
      // 多排竞争按射线真实命中盒体的先后排序；钳制后的点可能偏离射线，不能用于距离比较。
      const worldPoint = Vector3.TransformCoordinates(origin.add(direction.scale(tHit)), worldMatrix);
      const distance = Vector3.Distance(ray.origin, worldPoint);
      if (distance >= bestDistance) continue;
      bestEntityId = entityId;
      bestEntry = entry;
      bestLocal = clamped;
      bestDistance = distance;
    }
    if (!bestEntry || !bestEntityId || !bestLocal) return null;
    const hostEntityId = this.dependencies.document.syncedEntities.get(bestEntityId)?.components.locator?.builtInBinding?.hostEntityId;
    if (!hostEntityId) return null;

    // 与 buildLocatorGridMeshes 的格子中心公式同源：中心 (col*stepX, height/2 + layer*stepY, 0)。
    const columnIndex = Math.min(bestEntry.columns - 1, Math.max(0, Math.round(bestLocal.x / bestEntry.cellSteps.columnStepX)));
    const layerIndex = Math.min(bestEntry.layers - 1, Math.max(0, Math.round((bestLocal.y - bestEntry.cellSize.height / 2) / bestEntry.cellSteps.layerStepY)));
    return {
      locatorEntityId: bestEntityId,
      hostEntityId,
      row: bestEntry.rowNumber,
      column: bestEntry.startColumn + (bestEntry.columnReversed ? bestEntry.columns - 1 - columnIndex : columnIndex),
      layer: bestEntry.startLayer + layerIndex,
      distance: bestDistance,
    };
  }

  /** 按编辑或运行态策略执行最近可见实体拾取，并统一处理 thinInstance 与模型显示范围兜底。 */
  public pickSceneEntityHitAtCanvasPoint(
    clientX: number,
    clientY: number,
    canvas: HTMLCanvasElement,
    mode: 'editable' | 'runtime-model',
  ): { entityId: string; distance: number; precise: boolean } | null {
    const point = this.getCanvasPickPoint(clientX, clientY, canvas);
    if (!point) return null;
    const isCandidate = (entityId: string): boolean => mode === 'runtime-model'
      ? this.dependencies.document.isRuntimeModelSceneSelectable(entityId)
      : this.dependencies.document.isEntityScenePickable(entityId) && this.isEntityPickableFromActiveCamera(entityId);

    const picks = this.context.scene.multiPick(point.x, point.y, (mesh) => {
      // Babylon 传入自定义 predicate 后会跳过默认的 enabled / visible / pickable 判断。
      // 运行态故意忽略 authoring lock 导致的 isPickable=false，但仍保留真实显隐约束。
      if (mesh.isDisposed() || !mesh.isEnabled() || !mesh.isVisible || mesh.visibility <= 0) return false;
      const batch = this.dependencies.arrays.modelArrayBatchByMeshUniqueId.get(mesh.uniqueId);
      if (batch) return mode === 'runtime-model' || (mesh.isPickable && batch.hasPickableEntities());
      if (mode === 'editable' && !mesh.isPickable) return false;
      const entityId = this.readEntityIdFromMesh(mesh);
      return entityId !== null && isCandidate(entityId);
    }) ?? [];
    picks.sort((left, right) => left.distance - right.distance);

    for (const picked of picks) {
      const entityId = this.readEntityIdFromMesh(
        picked.pickedMesh ?? null,
        typeof picked.thinInstanceIndex === 'number' ? picked.thinInstanceIndex : null,
      );
      if (entityId && isCandidate(entityId)) return { entityId, distance: picked.distance, precise: true };
    }

    const camera = this.context.scene.cameraToUseForPointers ?? this.context.scene.activeCamera;
    if (!camera) return null;
    const ray = this.context.scene.createPickingRay(point.x, point.y, Matrix.Identity(), camera);
    let nearestEntityId: string | null = null;
    let nearestDistance = Number.POSITIVE_INFINITY;

    // 精确三角面完全未命中时，才用模型当前显示范围填补细杆/梁之间的空隙；
    // 真实可见几何仍保持优先，避免前方货架抢走透过空格看到的后方模型。
    for (const [entityId, model] of this.dependencies.assets.models) {
      if (model.modelArrayBatch || !isCandidate(entityId)) continue;
      const modelAsset = model.entitySnapshot?.components.modelAsset;
      if (modelAsset && isChainConveyorModelAsset(modelAsset)) continue;
      const distance = intersectWorldRayWithModelDisplayBounds(ray, model.root, model.contentRoot);
      if (distance === null || distance >= nearestDistance) continue;
      nearestEntityId = entityId;
      nearestDistance = distance;
    }

    return nearestEntityId ? { entityId: nearestEntityId, distance: nearestDistance, precise: false } : null;
  }

  /** 将画布客户端坐标投射到世界 y=0 地面平面，用于拖拽释放时按鼠标位置放置模型。 */
  getGroundPointAtCanvasPoint(clientX: number, clientY: number, canvas: HTMLCanvasElement): Vector3Data | null {
    const point = this.getCanvasPickPoint(clientX, clientY, canvas);
    const camera = this.context.scene.activeCamera;
    if (!point || !camera) return null;

    const ray = this.context.scene.createPickingRay(point.x, point.y, Matrix.Identity(), camera);
    const groundPlane = Plane.FromPositionAndNormal(Vector3.Zero(), Vector3.Up());
    const distance = ray.intersectsPlane(groundPlane);
    if (distance === null || !Number.isFinite(distance) || distance < 0) return null;

    const hitPoint = ray.origin.add(ray.direction.scale(distance));
    if (!Number.isFinite(hitPoint.x) || !Number.isFinite(hitPoint.y) || !Number.isFinite(hitPoint.z)) return null;

    return { x: hitPoint.x, y: 0, z: hitPoint.z };
  }

  /** 设置发布 Viewer 的本地持久选区，不影响编辑器权威选区和外部定位高亮。 */
  setLocalHighlightEntityIds(entityIds: readonly string[]): void {
    this.setTransientHighlightEntityIds('local', entityIds);
  }

  /**
   * 整体替换点击事件「忽略固定轨道」的实体集合；集合变化时主动重建描边。
   * 选区差量刷新在同实体重点击时会跳过重建，排除集合必须自带触发。
   */
  setClickHighlightTrackExclusion(entityIds: readonly string[]): void {
    const next = new Set(entityIds.filter((entityId) => typeof entityId === 'string' && entityId.length > 0));
    if (next.size === this.clickHighlightExcludeTrackEntityIds.size
      && [...next].every((entityId) => this.clickHighlightExcludeTrackEntityIds.has(entityId))) {
      return;
    }
    this.clickHighlightExcludeTrackEntityIds = next;
    this.rebuildModelSelectionOutline();
  }

  /** 清除发布 Viewer 的本地持久选区。 */
  clearLocalHighlight(): void {
    this.setLocalSlotHighlight('', null);
    this.setLocalHighlightEntityIds([]);
  }

  /** 设置不影响编辑器选区的外部临时描边。 */
  setExternalHighlightEntityIds(entityIds: readonly string[]): void {
    this.setTransientHighlightEntityIds('external', entityIds);
  }

  /** 清除外部临时描边，同时保留编辑器和 Viewer 本地选区。 */
  clearExternalHighlight(): void {
    this.setExternalSlotHighlight('', null);
    this.setExternalHighlightEntityIds([]);
  }

  /** 高亮单个货格格子（本地交互，如点击单元事件）；coordinate 为 null 时只清除本地格子 overlay，不影响实体描边与外部高亮。 */
  setLocalSlotHighlight(
    entityId: string,
    coordinate: { row: number; column: number; layer: number } | null,
  ): void {
    this.setSlotHighlight('local', entityId, coordinate);
  }

  /** 高亮单个货格格子（外部搜索定位）；coordinate 为 null 时只清除格子 overlay，不影响实体描边。 */
  setExternalSlotHighlight(
    entityId: string,
    coordinate: { row: number; column: number; layer: number } | null,
  ): void {
    this.setSlotHighlight('external', entityId, coordinate);
  }

  /** 差量更新指定来源的单格高亮，并只刷新前后变化实体的表现。 */
  public setSlotHighlight(
    source: 'local' | 'external',
    entityId: string,
    coordinate: { row: number; column: number; layer: number } | null,
  ): void {
    if (this.disposed) return;
    const previousEntityId = (source === 'local' ? this.localSlotHighlight : this.externalSlotHighlight)?.entityId ?? null;
    const next = coordinate && entityId
      ? { entityId, coordinate: { row: coordinate.row, column: coordinate.column, layer: coordinate.layer } }
      : null;
    if (source === 'local') this.localSlotHighlight = next;
    else this.externalSlotHighlight = next;
    this.dependencies.locators.refreshSlotHighlightOverlay(source);
    if (previousEntityId && previousEntityId !== next?.entityId) this.dependencies.locators.refreshLocatorPresentation(previousEntityId);
    if (next) this.dependencies.locators.refreshLocatorPresentation(next.entityId);
  }

  /** 差量替换指定临时高亮来源，并只刷新前后变化实体的表现。 */
  public setTransientHighlightEntityIds(
    source: 'local' | 'external',
    entityIds: readonly string[],
  ): void {
    const currentEntityIds = source === 'local'
      ? this.localHighlightedEntityIds
      : this.externalHighlightedEntityIds;
    const nextEntityIds = new Set(entityIds.filter((entityId) => typeof entityId === 'string' && entityId.length > 0));
    const changedEntityIds = new Set<string>();
    for (const entityId of currentEntityIds) {
      if (!nextEntityIds.has(entityId)) changedEntityIds.add(entityId);
    }
    for (const entityId of nextEntityIds) {
      if (!currentEntityIds.has(entityId)) changedEntityIds.add(entityId);
    }
    if (changedEntityIds.size === 0) return;

    if (source === 'local') this.localHighlightedEntityIds = nextEntityIds;
    else this.externalHighlightedEntityIds = nextEntityIds;
    for (const entityId of [...changedEntityIds]) {
      this.dependencies.document.appendBuiltInSlotEntityIdsForHost(entityId, changedEntityIds);
    }
    for (const entityId of changedEntityIds) {
      const entity = this.dependencies.document.syncedEntities.get(entityId);
      if (entity) this.dependencies.document.syncEntityPresentation(entity, this.isEntityHighlighted(entityId));
    }
    this.rebuildModelSelectionOutline();
  }

  /** 将浏览器客户端坐标转换为 Babylon 画布内拾取坐标，并过滤画布外输入。 */
  public getCanvasPickPoint(clientX: number, clientY: number, canvas: HTMLCanvasElement): { x: number; y: number } | null {
    const rect = canvas.getBoundingClientRect();
    if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) {
      return null;
    }

    return {
      x: clientX - rect.left,
      y: clientY - rect.top,
    };
  }


  /** 保存调用方提供的 transient Hierarchy 选区；未提供时回退到场景主选对象。 */
  public setHierarchySelectionIds(
    document: SceneDocument,
    hierarchySelectionIds?: readonly string[],
  ): void {
    this.hierarchySelectionIds = hierarchySelectionIds === undefined
      ? null
      : [...new Set(hierarchySelectionIds)].filter((entityId) => Boolean(document.entities[entityId]));
  }

  /** 外部描边只叠加展示，不修改编辑器的权威选区。 */
  public isEntityHighlighted(
    entityId: string,
    selectedEntityIds: ReadonlySet<string> = this.selectedEntityIds,
  ): boolean {
    return selectedEntityIds.has(entityId)
      || this.localHighlightedEntityIds.has(entityId)
      || this.externalHighlightedEntityIds.has(entityId);
  }
  /** 将普通实体和文件夹多选统一展开为全部需要高亮的运行时实体。 */
  public resolveSelectedEntityIds(document: SceneDocument): Set<string> {
    const selectionIds = this.hierarchySelectionIds
      ?? (document.selectedEntityId ? [document.selectedEntityId] : []);
    const selectedEntityIds = new Set<string>();

    for (const selectionId of selectionIds) {
      const selectedEntity = document.entities[selectionId];
      if (!selectedEntity) continue;
      if (!selectedEntity.isFolder) {
        selectedEntityIds.add(selectedEntity.id);
        continue;
      }
      for (const entityId of collectFolderRuntimeEntityIds(document.entities, selectedEntity.id)) {
        selectedEntityIds.add(entityId);
      }
    }
    return selectedEntityIds;
  }

  /** 从普通 Mesh 元数据或矩阵批次 thinInstanceIndex 中读取编辑器实体 ID。 */
  public readEntityIdFromMesh(mesh: AbstractMesh | null, thinInstanceIndex: number | null = null): string | null {
    if (!mesh) return null;

    const modelArrayBatch = this.dependencies.arrays.modelArrayBatchByMeshUniqueId.get(mesh.uniqueId);
    if (modelArrayBatch && thinInstanceIndex !== null) {
      return modelArrayBatch.getEntityIdForThinInstance(mesh, thinInstanceIndex);
    }

    const metadata = mesh.metadata as EditorMeshMetadata | null | undefined;
    const entityId = metadata?.[EDITOR_ENTITY_ID_METADATA_KEY];

    return typeof entityId === 'string'
      && (
        this.dependencies.presentation.meshes.has(entityId)
        || this.dependencies.locators.locators.has(entityId)
        || this.dependencies.assets.models.has(entityId)
        || this.dependencies.arrays.modelArrayInstanceEntities.has(entityId)
        || this.dependencies.outputs.modelGenerators.has(entityId)
        || this.dependencies.outputs.deviceSpawnerMarkers.has(entityId)
        || this.dependencies.effects.poiEffectRuntime.has(entityId)
        || this.dependencies.presentation.lightMarkerRuntime.has(entityId)
        || this.dependencies.patrol.autoPatrolMarkerRuntime.has(entityId)
        || this.dependencies.patrol.manualRoamSpawnRuntime.has(entityId)
        || this.dependencies.effects.clickEventBindingRuntime.has(entityId)
        || this.dependencies.environment.skyboxRuntime.hasEntity(entityId)
      )
      ? entityId
      : null;
  }

  /** 记录模型选中状态；普通模型、共享实例和矩阵阵列统一由场景选择高亮层描边。 */
  public applyModelSelection(model: ModelRuntimeEntry, selected: boolean): void {
    model.highlighted = selected;
  }

  /**
   * 只从当前选区推导基础 Mesh、普通模型、共享实例和矩阵阵列描边。普通单选为 O(1)，文件夹整组选中为 O(selected)，
   * 不再展开全部可见实体 ID 或拼接全场景 signature；批次内部再按差量刷新实例选择缓冲。
   */
  public rebuildModelSelectionOutline(): void {
    if (this.disposed) return;
    const selectedModelGroups: AbstractMesh[][] = [];
    const selectedArrayEntityIdsByBatch = new Map<EntityArrayThinInstanceBatch, Set<string>>();
    const highlightedEntityIds = mergeSceneRuntimeHighlightEntityIds(
      this.selectedEntityIds,
      this.localHighlightedEntityIds,
      this.externalHighlightedEntityIds,
    );

    for (const entityId of highlightedEntityIds) {
      const primitiveMesh = this.dependencies.presentation.meshes.get(entityId);
      if (primitiveMesh && !primitiveMesh.isDisposed() && primitiveMesh.getTotalVertices() > 0) {
        selectedModelGroups.push(this.dependencies.environment.lightingRuntime.getSelectionMeshes(entityId, [primitiveMesh]));
      }

      const model = this.dependencies.assets.models.get(entityId);
      if (model && !model.modelArrayBatch && model.highlighted) {
        const meshes = model.meshes.filter((mesh) => !mesh.isDisposed() && !this.dependencies.telemetry.motionStaticBatchRuntime.isSuspended(mesh) && mesh.getTotalVertices() > 0);
        const highlightMeshes = this.clickHighlightExcludeTrackEntityIds.has(entityId)
          ? excludeFixedTrackMeshes(meshes, getFixedTrackNodes(model, this.context.scene))
          : meshes;
        if (highlightMeshes.length > 0) selectedModelGroups.push(this.dependencies.environment.lightingRuntime.getSelectionMeshes(entityId, highlightMeshes));
      }

      // 动态设备实例没有文档实体，选中状态不经 applyModelSelection 维护，按合成 id 直接命中。
      const spawnedModel = this.dependencies.document.resolveSpawnedDeviceModel(entityId);
      if (spawnedModel && !spawnedModel.modelArrayBatch) {
        const meshes = spawnedModel.meshes.filter((mesh) => !mesh.isDisposed() && mesh.getTotalVertices() > 0);
        const highlightMeshes = this.clickHighlightExcludeTrackEntityIds.has(entityId)
          ? excludeFixedTrackMeshes(meshes, getFixedTrackNodes(spawnedModel, this.context.scene))
          : meshes;
        if (highlightMeshes.length > 0) selectedModelGroups.push(this.dependencies.environment.lightingRuntime.getSelectionMeshes(entityId, highlightMeshes));
      }

      // 生成货物的输出宿主同样是合成 id：点击事件的高亮目标是产物自身而非承运设备。
      const generatedOwner = this.dependencies.outputs.generatedOutputOwners.get(entityId);
      if (generatedOwner) {
        const ownerMeshes = collectGeneratedOutputMeshes(generatedOwner.output)
          .filter((mesh) => !mesh.isDisposed() && mesh.getTotalVertices() > 0);
        if (ownerMeshes.length > 0) selectedModelGroups.push(this.dependencies.environment.lightingRuntime.getSelectionMeshes(entityId, ownerMeshes));
      }

      for (const motionBatch of this.dependencies.telemetry.motionStaticBatchRuntime.getBatchesForEntity(entityId)) {
        if (model && this.clickHighlightExcludeTrackEntityIds.has(entityId)) {
          const source = this.dependencies.telemetry.motionStaticBatchRuntime.getSourceMeshForEntity(motionBatch, entityId);
          if (source && excludeFixedTrackMeshes([source], getFixedTrackNodes(model, this.context.scene)).length === 0) continue;
        }
        const originalCarriers = new Set<AbstractMesh>(motionBatch.meshes);
        const visibleProxies = this.dependencies.environment.lightingRuntime.getSelectionMeshes(entityId, motionBatch.meshes)
          .filter(mesh => !originalCarriers.has(mesh));
        if (visibleProxies.length) selectedModelGroups.push(visibleProxies);
        const selected = selectedArrayEntityIdsByBatch.get(motionBatch) ?? new Set<string>();
        selected.add(entityId); selectedArrayEntityIdsByBatch.set(motionBatch, selected);
      }
      const batch = this.dependencies.arrays.resolveModelArrayBatchForEntityId(entityId);
      if (!batch) continue;
      // 烘焙代理已按逻辑实例拆分；直接选择它，未派生的批次继续使用原权威选择 mask。
      const lightingMeshes = this.dependencies.environment.lightingRuntime.getSelectionMeshes(entityId);
      if (lightingMeshes.length) { selectedModelGroups.push(lightingMeshes); continue; }
      const selectedEntityIds = selectedArrayEntityIdsByBatch.get(batch) ?? new Set<string>();
      selectedEntityIds.add(entityId);
      selectedArrayEntityIdsByBatch.set(batch, selectedEntityIds);
    }

    for (const previousBatch of this.outlinedModelArrayBatches) {
      if (selectedArrayEntityIdsByBatch.has(previousBatch)) continue;
      if (previousBatch.meshes.some((mesh) => !mesh.isDisposed())) {
        previousBatch.setSelectionMask(new Set(), 0);
      }
    }

    // 先写入批次维护的权威选择缓冲，再把当前活动的原模型 Mesh 交给场景选择高亮层。
    // 这样只高亮目标逻辑实体，不会因共享 Geometry 或 thinInstance 批次而整类高亮。
    let nextArraySelectionId = selectedModelGroups.length + 1;
    const selectedArrayGroups = [...selectedArrayEntityIdsByBatch.entries()]
      .map(([batch, selectedEntityIds]) => {
        const selectionId = nextArraySelectionId;
        nextArraySelectionId += 1;
        batch.setSelectionMask(selectedEntityIds, selectionId);
        const meshes = batch.meshes.filter((mesh) => (
          !mesh.isDisposed() && mesh.thinInstanceCount > 0 && mesh.getTotalVertices() > 0
        ));
        return meshes.length > 0 ? { batch, meshes, selectedEntityIds, selectionId } : null;
      })
      .filter((group): group is NonNullable<typeof group> => group !== null);
    // 代理暂时隐藏全部载体时也记住已写的mask，取消选择必须清掉，避免代理回收后旧高亮复活。
    const nextOutlinedModelArrayBatches = new Set(selectedArrayEntityIdsByBatch.keys());

    const selectedGlowGroups = [
      ...selectedModelGroups,
      ...selectedArrayGroups.map((group) => group.meshes),
    ];
    if (selectedGlowGroups.length === 0) {
      // 选择效果会为遮挡正确的描边延迟启用全场景 DepthRenderer；空选区必须主动释放。
      clearSceneSelectionHighlight(this.modelSelectionOutlineLayer, this.context.scene);
      this.outlinedModelArrayBatches = nextOutlinedModelArrayBatches;
      return;
    }

    prepareInstancedMeshesForSelectionOutline(selectedGlowGroups.flat());
    setSceneSelectionHighlightGroups(this.modelSelectionOutlineLayer, selectedGlowGroups);

    for (const group of selectedArrayGroups) {
      // addSelection() 会临时把整个 thinInstance 批次改为选中；再次绑定权威缓冲只保留目标实体。
      group.batch.setSelectionMask(group.selectedEntityIds, group.selectionId);
    }

    this.outlinedModelArrayBatches = nextOutlinedModelArrayBatches;
  }
  /** 按原构造顺序连接此领域的资源与回调。 */
  initializeModelSelectionOutlineLayer(): void {
    if (this.disposed || this.modelSelectionOutlineLayer) return;
    this.modelSelectionOutlineLayer = createSceneSelectionHighlightLayer(this.context.scene, undefined, this.context.pushLog);
  }

}
