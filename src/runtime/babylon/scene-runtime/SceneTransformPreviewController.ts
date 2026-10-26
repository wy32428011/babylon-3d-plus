import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight.js';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight.js';
import { Light } from '@babylonjs/core/Lights/light.js';
import { PointLight } from '@babylonjs/core/Lights/pointLight.js';
import { RectAreaLight } from '@babylonjs/core/Lights/rectAreaLight.js';
import { SpotLight } from '@babylonjs/core/Lights/spotLight.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import { Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh.js';

import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import { Scene } from '@babylonjs/core/scene.js';
import type { Nullable, Observer, Node } from '@babylonjs/core';
import type { Entity } from '../../../editor/model/Entity';
import type { TransformComponent } from '../../../editor/model/components';
import type { Vector3Data } from '../../../editor/model/math';
import { createGroupSpatialInfo, type GroupSpatialInfoResult } from '../../../editor/model/groupSpatialInfo';
import { getCompositionArrayInfo, MODEL_ARRAY_COPY_COUNT_MAX, MODEL_ARRAY_MIN_SPAN_METERS } from '../../../editor/model/modelArray';
import { measureEntityMeshesSpanMetersAlongWorldDirection } from '../modelMeasurement';
import { repairInstancedMeshBufferContainers } from '../instancedSelectionBuffers';
import { EntityArrayThinInstanceBatch } from '../EntityArrayThinInstanceBatch';
import { EntityGroupTranslationPreview, type EntityGroupTranslationTarget } from '../EntityGroupTranslationPreview';
import { EntityGroupRotationPreview, type EntityGroupRotationTarget } from '../EntityGroupRotationPreview';
import type { SceneRuntimeContext } from './SceneRuntimeContext';
import { runSceneRuntimeCleanup } from './sceneRuntimeCleanup';
import type { SceneDocumentController } from './SceneDocumentController';
import type { ModelArrayRuntimeController } from './ModelArrayRuntimeController';
import type { ModelAssetRuntimeController } from './ModelAssetRuntimeController';
import type { SceneMeshPresentationController } from './SceneMeshPresentationController';
import type { EnvironmentAndSkyboxController } from './EnvironmentAndSkyboxController';
import type { SceneLocatorController } from './SceneLocatorController';
import type { SceneCadReferenceController } from './SceneCadReferenceController';
import type { GeneratedModelOutputController } from './GeneratedModelOutputController';
import type { ScenePoiAndEffectsController } from './ScenePoiAndEffectsController';
import type { ScenePatrolAndRoamController } from './ScenePatrolAndRoamController';
import type { SceneWorldBoundsController } from './SceneWorldBoundsController';
import type { SceneTelemetryController } from './SceneTelemetryController';
import { type EntityArrayPreviewSource, type EntityArrayPreviewEntry, readCurrentThinInstanceMatrices } from './sceneRuntimeTypes';

/** 此领域仅能访问明确列出的协作能力，资源与缓存由所属 Controller 持有。 */
type Dependencies = {
  readonly document: Pick<SceneDocumentController, 'isEntityTransformEditable' | 'syncedEntities' | 'shadowDocument'>;
  readonly arrays: Pick<ModelArrayRuntimeController, 'modelArrayInstanceEntities' | 'resolveModelArrayBatchForEntityId'>;
  readonly assets: Pick<ModelAssetRuntimeController, 'models'>;
  readonly presentation: Pick<SceneMeshPresentationController, 'meshes' | 'lightMarkerRuntime' | 'lights' | 'applyTransform' | 'vectorFromTransformPosition' | 'directionFromRotation'>;
  readonly environment: Pick<EnvironmentAndSkyboxController, 'skyboxRuntime' | 'shadowRuntime'>;
  readonly locators: Pick<SceneLocatorController, 'locators'>;
  readonly cad: Pick<SceneCadReferenceController, 'cadReferences'>;
  readonly outputs: Pick<GeneratedModelOutputController, 'modelGenerators' | 'deviceSpawnerMarkers'>;
  readonly effects: Pick<ScenePoiAndEffectsController, 'poiEffectRuntime' | 'clickEventBindingRuntime'>;
  readonly patrol: Pick<ScenePatrolAndRoamController, 'autoPatrolMarkerRuntime' | 'manualRoamSpawnRuntime'>;
  readonly bounds: Pick<SceneWorldBoundsController, 'getEntitiesWorldBounds' | 'resolveModelArrayRenderModel' | 'getModelArrayInstanceWorldPoints' | 'measureWorldPointsAlongAxes'>;
  readonly telemetry: Pick<SceneTelemetryController, 'telemetryPreviewActive'>;
};


/** SceneTransformPreviewController 的资源、状态及取消/释放操作在同一领域内维护。 */
export class SceneTransformPreviewController {
  constructor(private readonly context: SceneRuntimeContext, private readonly dependencies: Dependencies) {}

  public modelArrayGizmoProxy: { entityId: string; node: TransformNode } | null = null;
  public entityGroupGizmoProxy: {
    groupId: string;
    entityIds: string[];
    tool: 'translate' | 'rotate';
    node: TransformNode;
  } | null = null;
  public groupTransformPreviewObserver!: Nullable<Observer<Scene>>;
  public entityArrayPreview: EntityArrayPreviewEntry | null = null;
  public compositionArrayPreview: {
    sourceEntityId: string;
    entityIds: string[];
    members: Map<string, { source: EntityArrayPreviewSource; batch: EntityArrayThinInstanceBatch }>;
  } | null = null;
  public groupTranslationPreview: EntityGroupTranslationPreview | null = null;
  public pendingGroupTranslationDelta: Vector3Data | null = null;
  public groupRotationPreview: EntityGroupRotationPreview | null = null;
  public pendingGroupRotationMatrix: number[] | null = null;
  private disposed = false;

  /** 预览会归还模型姿态，必须在实体与阵列批次释放之前完成。 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.context.scene.onBeforeActiveMeshesEvaluationObservable.remove(this.groupTransformPreviewObserver);
    this.groupTransformPreviewObserver = null;
    runSceneRuntimeCleanup(this.context, '阵列预览', () => this.clearEntityArrayPreview());
    runSceneRuntimeCleanup(this.context, '群组平移预览', () => this.cancelFolderGroupTranslation());
    runSceneRuntimeCleanup(this.context, '群组旋转预览', () => this.cancelFolderGroupRotation());
    const groupProxy = this.entityGroupGizmoProxy, arrayProxy = this.modelArrayGizmoProxy;
    this.entityGroupGizmoProxy = this.modelArrayGizmoProxy = null;
    this.groupTranslationPreview = this.groupRotationPreview = null;
    this.pendingGroupTranslationDelta = this.pendingGroupRotationMatrix = null;
    runSceneRuntimeCleanup(this.context, '群组变换代理', () => groupProxy?.node.dispose(false, false));
    runSceneRuntimeCleanup(this.context, '阵列变换代理', () => arrayProxy?.node.dispose(false, false));
  }

  /** 根据实体 ID 获取当前运行时中可被 Gizmo 绑定的 Babylon 节点。 */
  getGizmoTargetByEntityId(entityId: string | null): AbstractMesh | TransformNode | null {
    if (this.disposed || !entityId) return null;
    if (!this.dependencies.document.isEntityTransformEditable(entityId)) return null;

    const modelArrayInstance = this.dependencies.arrays.modelArrayInstanceEntities.get(entityId);
    if (modelArrayInstance) return this.getOrCreateModelArrayGizmoProxy(modelArrayInstance);
    const sourceModel = this.dependencies.assets.models.get(entityId);
    if (sourceModel?.modelArrayBatch && sourceModel.entitySnapshot) {
      return this.getOrCreateModelArrayGizmoProxy(sourceModel.entitySnapshot);
    }

    return (
      this.dependencies.presentation.meshes.get(entityId) ??
      this.dependencies.locators.locators.get(entityId)?.root ??
      this.dependencies.cad.cadReferences.get(entityId)?.root ??
      this.dependencies.assets.models.get(entityId)?.root ??
      this.dependencies.outputs.modelGenerators.get(entityId)?.markerRoot ??
      this.dependencies.outputs.deviceSpawnerMarkers.get(entityId)?.root ??
      this.dependencies.effects.poiEffectRuntime.getGizmoTarget(entityId) ??
      this.dependencies.presentation.lightMarkerRuntime.getGizmoTarget(entityId) ??
      this.dependencies.patrol.autoPatrolMarkerRuntime.getRouteGizmoTarget(entityId) ??
      this.dependencies.patrol.manualRoamSpawnRuntime.getGizmoTarget(entityId) ??
      this.dependencies.effects.clickEventBindingRuntime.getGizmoTarget(entityId) ??
      null
    );
  }

  /** 返回当前群组完整世界包围盒，供 Inspector 展示中心位置和包围尺寸。 */
  getEntityGroupSpatialInfo(entityIds: readonly string[]): GroupSpatialInfoResult {
    return createGroupSpatialInfo(entityIds, this.dependencies.bounds.getEntitiesWorldBounds([...entityIds]));
  }

  /** 在完整选区世界包围盒中心创建或更新不可见变换代理；包围盒或当前工具目标未就绪时保持禁用。 */
  getFolderGroupGizmoTarget(
    groupId: string,
    entityIds: readonly string[],
    tool: 'translate' | 'rotate' = 'translate',
    compositionPivot?: Vector3Data,
  ): TransformNode | null {
    if (this.disposed) return null;
    const uniqueEntityIds = [...new Set(entityIds)].filter((entityId) => Boolean(entityId));
    if (uniqueEntityIds.length === 0) {
      this.entityGroupGizmoProxy?.node.setEnabled(false);
      return null;
    }

    let proxy = this.entityGroupGizmoProxy;
    if (!proxy) {
      const node = new Mesh('__entityGroupTransformGizmoProxy', this.context.scene);
      node.isPickable = false;
      proxy = {
        groupId,
        entityIds: uniqueEntityIds,
        tool,
        node,
      };
      this.entityGroupGizmoProxy = proxy;
    }
    proxy.groupId = groupId;
    proxy.entityIds = uniqueEntityIds;
    proxy.tool = tool;

    const bounds = this.dependencies.bounds.getEntitiesWorldBounds(uniqueEntityIds);
    const ready = Boolean(
      bounds?.geometryReady
      && bounds.resolvedEntityCount === uniqueEntityIds.length
      && bounds.geometryReadyEntityCount === uniqueEntityIds.length
      && this.areEntityGroupTransformTargetsReady(uniqueEntityIds, tool),
    );
    if (!bounds || !ready) {
      proxy.node.setEnabled(false);
      return proxy.node;
    }

    proxy.node.setEnabled(true);
    const pivot = compositionPivot ?? bounds.center;
    proxy.node.position.copyFromFloats(pivot.x, pivot.y, pivot.z);
    proxy.node.rotationQuaternion = null;
    proxy.node.rotation.copyFromFloats(0, 0, 0);
    proxy.node.scaling.copyFromFloats(1, 1, 1);
    proxy.node.computeWorldMatrix(true);
    return proxy.node;
  }

  /** 完整包围盒和对应运行时目标均就绪后，才允许开始组合移动或旋转。 */
  isEntityGroupTransformReady(
    entityIds: readonly string[],
    tool: 'translate' | 'rotate',
  ): boolean {
    const uniqueEntityIds = [...new Set(entityIds)].filter((entityId) => Boolean(entityId));
    if (uniqueEntityIds.length === 0) return false;

    const bounds = this.dependencies.bounds.getEntitiesWorldBounds(uniqueEntityIds);
    if (
      !bounds?.geometryReady
      || bounds.resolvedEntityCount !== uniqueEntityIds.length
      || bounds.geometryReadyEntityCount !== uniqueEntityIds.length
    ) return false;

    return this.areEntityGroupTransformTargetsReady(uniqueEntityIds, tool);
  }

  /** 当前工具所需的全部运行时写入目标均存在时，组合 Gizmo 才可见或开始拖拽。 */
  public areEntityGroupTransformTargetsReady(
    entityIds: readonly string[],
    tool: 'translate' | 'rotate',
  ): boolean {
    return entityIds.every((entityId) => (
      tool === 'rotate'
        ? this.resolveGroupRotationTarget(entityId) !== null
        : this.resolveGroupTranslationTarget(entityId) !== null
    ));
  }

  /** 隐藏群组代理并取消任何尚未提交的运行时预览。 */
  clearFolderGroupGizmoTarget(): void {
    this.cancelFolderGroupTransforms();
    this.entityGroupGizmoProxy?.node.setEnabled(false);
  }

  /** 建立文件夹组运行时平移会话；未加载成员会在后续批次就绪时自动接回。 */
  beginFolderGroupTranslation(
    entityIds: readonly string[],
    beforePositions: Readonly<Record<string, Vector3Data>>,
  ): boolean {
    if (this.disposed || this.dependencies.telemetry.telemetryPreviewActive) return false;
    this.cancelFolderGroupTransforms();

    const validEntityIds = [...new Set(entityIds)].filter((entityId) => {
      const position = beforePositions[entityId];
      return Boolean(
        position
        && Number.isFinite(position.x)
        && Number.isFinite(position.y)
        && Number.isFinite(position.z),
      );
    });
    if (validEntityIds.length === 0) return false;

    const baselines = Object.fromEntries(validEntityIds.map((entityId) => {
      const position = beforePositions[entityId];
      return [entityId, { x: position.x, y: position.y, z: position.z }];
    }));
    this.groupTranslationPreview = new EntityGroupTranslationPreview(
      validEntityIds,
      baselines,
      (entityId) => this.resolveGroupTranslationTarget(entityId),
    );
    this.pendingGroupTranslationDelta = null;
    this.groupTranslationPreview.refresh();
    return true;
  }

  /** 记录最新绝对 delta，并在下一次 active-mesh 评估前合并为一次运行时更新。 */
  updateFolderGroupTranslation(delta: Vector3Data): boolean {
    if (
      !this.groupTranslationPreview
      || !Number.isFinite(delta.x)
      || !Number.isFinite(delta.y)
      || !Number.isFinite(delta.z)
    ) return false;

    this.pendingGroupTranslationDelta = { x: delta.x, y: delta.y, z: delta.z };
    return true;
  }

  /** 取消整组预览并恢复节点、灯光与 thinInstance 矩阵基线。 */
  cancelFolderGroupTranslation(): void {
    const preview = this.groupTranslationPreview;
    if (!preview) return;

    this.pendingGroupTranslationDelta = null;
    this.groupTranslationPreview = null;
    preview.cancel();
    this.refreshFolderGroupGizmoProxyPosition();
  }

  /** 完成整组预览并保留当前画面，等待场景文档同步权威位置。 */
  finishFolderGroupTranslation(): void {
    const preview = this.groupTranslationPreview;
    if (!preview) return;

    this.flushGroupTranslationPreview();
    this.groupTranslationPreview = null;
    this.pendingGroupTranslationDelta = null;
    preview.finish();
  }

  /** 建立文件夹组运行时旋转会话；最终 Transform 对全部成员计算，未加载成员也可随提交写回。 */
  beginFolderGroupRotation(
    entityIds: readonly string[],
    beforeTransforms: Readonly<Record<string, TransformComponent>>,
  ): boolean {
    if (this.disposed || this.dependencies.telemetry.telemetryPreviewActive) return false;
    this.cancelFolderGroupTransforms();

    this.groupRotationPreview = new EntityGroupRotationPreview(
      entityIds,
      beforeTransforms,
      (entityId) => this.resolveGroupRotationTarget(entityId),
    );
    this.pendingGroupRotationMatrix = null;
    if (this.groupRotationPreview.refresh()) return true;

    this.groupRotationPreview.cancel();
    this.groupRotationPreview = null;
    return false;
  }

  /** 记录最新绝对世界增量矩阵，并在下一次 active-mesh 评估前合并为一次运行时更新。 */
  updateFolderGroupRotation(deltaMatrix: readonly number[]): boolean {
    if (
      !this.groupRotationPreview
      || deltaMatrix.length !== 16
      || !deltaMatrix.every(Number.isFinite)
    ) return false;

    this.pendingGroupRotationMatrix = [...deltaMatrix];
    return true;
  }

  /** 返回当前旋转会话为全部成员计算出的最终 Transform。 */
  getFolderGroupRotationTransforms(): Record<string, TransformComponent> | null {
    this.flushGroupRotationPreview();
    return this.groupRotationPreview?.getTransforms() ?? null;
  }

  /** 取消整组旋转预览并恢复普通节点与 thinInstance 完整矩阵基线。 */
  cancelFolderGroupRotation(): void {
    const preview = this.groupRotationPreview;
    if (!preview) return;

    this.pendingGroupRotationMatrix = null;
    this.groupRotationPreview = null;
    preview.cancel();
    this.refreshFolderGroupGizmoProxyPosition();
  }

  /** 完成整组旋转预览并保留当前画面，等待场景文档同步权威 Transform。 */
  finishFolderGroupRotation(): void {
    const preview = this.groupRotationPreview;
    if (!preview) return;

    this.flushGroupRotationPreview();
    this.groupRotationPreview = null;
    this.pendingGroupRotationMatrix = null;
    preview.finish();
  }

  /** 把同一渲染帧内最后一次旋转矩阵应用到轻量预览会话。 */
  public flushGroupRotationPreview(): void {
    const preview = this.groupRotationPreview;
    const deltaMatrix = this.pendingGroupRotationMatrix;
    if (!preview || !deltaMatrix) return;

    this.pendingGroupRotationMatrix = null;
    preview.update(deltaMatrix);
  }

  /** 同时取消文件夹平移和旋转会话，供选区/文档/运行模式切换统一清理。 */
  public cancelFolderGroupTransforms(): void {
    this.cancelFolderGroupTranslation();
    this.cancelFolderGroupRotation();
  }

  /** 把同一渲染帧内最后一次拖拽 delta 应用到轻量预览会话。 */
  public flushGroupTranslationPreview(): void {
    const preview = this.groupTranslationPreview;
    const delta = this.pendingGroupTranslationDelta;
    if (!preview || !delta) return;

    this.pendingGroupTranslationDelta = null;
    preview.update(delta);
  }

  /** 异步模型或批次就绪后重新解析群组变换目标，并保持上一帧已应用的绝对结果。 */
  public refreshGroupTransformPreviewTargets(): void {
    if (this.disposed) return;
    const translationPreview = this.groupTranslationPreview;
    const rotationPreview = this.groupRotationPreview;
    translationPreview?.refresh();
    rotationPreview?.refresh();
    // 活动拖动期间代理位姿由 Gizmo 权威控制；异步几何只接入预览目标，
    // 否则包围盒中心变化会被误算进相对 delta。
    if (!translationPreview && !rotationPreview) this.refreshFolderGroupGizmoProxyPosition();
  }

  /** 运行时基线恢复或异步几何就绪后，把群组代理放回完整选区包围盒中心。 */
  public refreshFolderGroupGizmoProxyPosition(): void {
    const proxy = this.entityGroupGizmoProxy;
    if (!proxy || proxy.node.isDisposed()) return;

    const bounds = this.dependencies.bounds.getEntitiesWorldBounds(proxy.entityIds);
    if (
      !bounds?.geometryReady
      || bounds.resolvedEntityCount !== proxy.entityIds.length
      || bounds.geometryReadyEntityCount !== proxy.entityIds.length
      || !this.areEntityGroupTransformTargetsReady(proxy.entityIds, proxy.tool)
    ) {
      proxy.node.setEnabled(false);
      return;
    }
    proxy.node.setEnabled(true);
    proxy.node.position.copyFromFloats(bounds.center.x, bounds.center.y, bounds.center.z);
    proxy.node.rotationQuaternion = null;
    proxy.node.rotation.copyFromFloats(0, 0, 0);
    proxy.node.scaling.copyFromFloats(1, 1, 1);
    proxy.node.computeWorldMatrix(true);
  }

  /** 将逻辑实体解析为普通位置目标或共享 thinInstance 批次目标。 */
  public resolveGroupTranslationTarget(entityId: string): EntityGroupTranslationTarget | null {
    const batch = this.dependencies.arrays.resolveModelArrayBatchForEntityId(entityId);
    if (batch) return { kind: 'batch', batch };

    const autoPatrolTarget = this.dependencies.patrol.autoPatrolMarkerRuntime.getRouteTransformTarget(entityId);
    const autoPatrolEntity = this.dependencies.document.syncedEntities.get(entityId);
    if (autoPatrolTarget && autoPatrolEntity?.components.autoPatrol) {
      return {
        kind: 'position',
        identity: autoPatrolTarget,
        setPosition: (position) => {
          this.dependencies.patrol.autoPatrolMarkerRuntime.previewRouteTransform(entityId, {
            ...autoPatrolEntity.components.transform,
            position,
          });
        },
      };
    }

    const node = (
      this.dependencies.presentation.meshes.get(entityId)
      ?? this.dependencies.locators.locators.get(entityId)?.root
      ?? this.dependencies.cad.cadReferences.get(entityId)?.root
      ?? this.dependencies.assets.models.get(entityId)?.root
      ?? this.dependencies.outputs.modelGenerators.get(entityId)?.markerRoot
      ?? this.dependencies.effects.poiEffectRuntime.getGizmoTarget(entityId)
      ?? this.dependencies.patrol.manualRoamSpawnRuntime.getTransformTarget(entityId)
      ?? this.dependencies.effects.clickEventBindingRuntime.getTransformTarget(entityId)
      ?? null
    );
    if (node && !node.isDisposed()) {
      return {
        kind: 'position',
        identity: node,
        setPosition: (position) => {
          if (node.isDisposed()) return;
          node.position.copyFromFloats(position.x, position.y, position.z);
          node.computeWorldMatrix(true);
        },
      };
    }

    const light = this.dependencies.presentation.lights.get(entityId);
    if (!light || light.isDisposed()) return null;
    const markerTarget = this.dependencies.presentation.lightMarkerRuntime.getGizmoTarget(entityId);
    return {
      kind: 'position',
      identity: markerTarget ?? light,
      setPosition: (position) => {
        this.applyGroupTranslationLightPosition(light, position);
        this.dependencies.presentation.lightMarkerRuntime.setPosition(entityId, position);
      },
    };
  }

  /** 将逻辑实体解析为普通完整 Transform 目标或共享 thinInstance 旋转批次目标。 */
  public resolveGroupRotationTarget(entityId: string): EntityGroupRotationTarget | null {
    const batch = this.dependencies.arrays.resolveModelArrayBatchForEntityId(entityId);
    if (batch) return { kind: 'batch', batch };

    const autoPatrolTarget = this.dependencies.patrol.autoPatrolMarkerRuntime.getRouteTransformTarget(entityId);
    const autoPatrolEntity = this.dependencies.document.syncedEntities.get(entityId);
    if (autoPatrolTarget && autoPatrolEntity?.components.autoPatrol) {
      return {
        kind: 'transform',
        identity: autoPatrolTarget,
        setTransform: (transform) => {
          this.dependencies.patrol.autoPatrolMarkerRuntime.previewRouteTransform(entityId, transform);
        },
      };
    }

    const node = (
      this.dependencies.presentation.meshes.get(entityId)
      ?? this.dependencies.locators.locators.get(entityId)?.root
      ?? this.dependencies.cad.cadReferences.get(entityId)?.root
      ?? this.dependencies.assets.models.get(entityId)?.root
      ?? this.dependencies.outputs.modelGenerators.get(entityId)?.markerRoot
      ?? this.dependencies.effects.poiEffectRuntime.getGizmoTarget(entityId)
      ?? this.dependencies.patrol.manualRoamSpawnRuntime.getTransformTarget(entityId)
      ?? this.dependencies.effects.clickEventBindingRuntime.getTransformTarget(entityId)
      ?? null
    );
    if (node && !node.isDisposed()) {
      return {
        kind: 'transform',
        identity: node,
        setTransform: (transform) => {
          if (node.isDisposed()) return;
          this.dependencies.presentation.applyTransform(node, transform);
          node.computeWorldMatrix(true);
        },
      };
    }

    const light = this.dependencies.presentation.lights.get(entityId);
    if (!light || light.isDisposed()) return null;
    const markerTarget = this.dependencies.presentation.lightMarkerRuntime.getGizmoTarget(entityId);
    return {
      kind: 'transform',
      identity: markerTarget ?? light,
      setTransform: (transform) => {
        this.applyGroupRotationLightTransform(light, transform);
        this.dependencies.presentation.lightMarkerRuntime.setTransform(entityId, transform);
      },
    };
  }

  /** 灯光旋转预览复用正式同步语义，方向光同时更新世界位置和方向。 */
  public applyGroupRotationLightTransform(light: Light, transform: TransformComponent): void {
    this.applyLightTransform(light, transform);
    this.dependencies.environment.shadowRuntime.syncLight(light.name, light);
  }

  public applyLightTransform(light: Light, transform: TransformComponent): void {
    if (light instanceof HemisphericLight) {
      light.direction.copyFrom(this.dependencies.presentation.vectorFromTransformPosition(transform, new Vector3(0, 1, 0)));
      return;
    }
    if (light instanceof DirectionalLight || light instanceof SpotLight) {
      light.position.copyFrom(this.dependencies.presentation.vectorFromTransformPosition(transform, Vector3.Zero()));
      light.direction.copyFrom(this.dependencies.presentation.directionFromRotation(transform));
      return;
    }
    if (light instanceof PointLight) {
      light.position.copyFrom(this.dependencies.presentation.vectorFromTransformPosition(transform, Vector3.Zero()));
    }
    if (light instanceof RectAreaLight && light.parent instanceof TransformNode) {
      light.parent.position.copyFrom(this.dependencies.presentation.vectorFromTransformPosition(transform, Vector3.Zero()));
      // Babylon 面光沿局部 -Z 发光；先统一到灯具 -Y 基准，再应用实体旋转。
      light.parent.rotationQuaternion = Quaternion.FromEulerAngles(transform.rotation.x, transform.rotation.y, transform.rotation.z)
        .multiply(Quaternion.RotationAxis(Vector3.Right(), -Math.PI / 2));
      light.parent.computeWorldMatrix(true);
    }
  }

  /** 灯光预览复用正式同步语义：半球光位置字段表示方向，其余灯光表示世界位置。 */
  public applyGroupTranslationLightPosition(light: Light, position: Vector3Data): void {
    const vector = new Vector3(position.x, position.y, position.z);
    if (light instanceof HemisphericLight) {
      if (vector.lengthSquared() <= 1e-12) vector.copyFromFloats(0, 1, 0);
      light.direction.copyFrom(vector);
      return;
    }
    if (light instanceof DirectionalLight || light instanceof PointLight || light instanceof SpotLight) {
      light.position.copyFrom(vector);
    }
    if (light instanceof RectAreaLight && light.parent instanceof TransformNode) {
      light.parent.position.copyFrom(vector);
      light.parent.computeWorldMatrix(true);
    }
    this.dependencies.environment.shadowRuntime.syncLight(light.name, light);
  }

  /** 读取支持实体沿指定世界方向的有效几何跨度，供 Shift+Gizmo 阵列使用。 */
  getEntityArrayGeometry(entityId: string, worldDirection: Vector3Data): {
    direction: Vector3Data;
    spanMeters: number;
  } | null {
    const direction = new Vector3(worldDirection.x, worldDirection.y, worldDirection.z);
    const lengthSquared = direction.lengthSquared();
    if (!Number.isFinite(lengthSquared) || lengthSquared <= MODEL_ARRAY_MIN_SPAN_METERS ** 2) return null;
    direction.normalize();
    const normalizedDirection = { x: direction.x, y: direction.y, z: direction.z };

    if (this.dependencies.document.shadowDocument?.entities[entityId]?.composition) {
      const members = this.resolveCompositionArraySources(entityId, 1);
      if (!members) return null;
      const points: Vector3[] = [];
      for (const [memberId, source] of members) {
        const instance = this.dependencies.arrays.modelArrayInstanceEntities.get(memberId);
        const model = instance ? this.dependencies.bounds.resolveModelArrayRenderModel(instance) : null;
        if (instance && model) {
          const instancePoints = this.dependencies.bounds.getModelArrayInstanceWorldPoints(instance, model);
          if (!instancePoints) return null;
          for (const point of instancePoints) points.push(point);
          continue;
        }
        for (const mesh of source.geometryMeshes) {
          if (mesh.isDisposed() || mesh.getTotalVertices() === 0) continue;
          mesh.computeWorldMatrix(true);
          const matrices = mesh instanceof Mesh && mesh.thinInstanceCount > 0
            ? readCurrentThinInstanceMatrices(mesh)?.map(matrix => matrix.multiply(mesh.getWorldMatrix()))
            : [mesh.getWorldMatrix()];
          if (!matrices) return null;
          for (const matrix of matrices) {
            for (const corner of (mesh.rawBoundingInfo ?? mesh.getBoundingInfo()).boundingBox.vectors) {
              points.push(Vector3.TransformCoordinates(corner, matrix));
            }
          }
        }
      }
      const spanMeters = this.dependencies.bounds.measureWorldPointsAlongAxes(points, [direction])?.[0];
      return spanMeters !== undefined && Number.isFinite(spanMeters) && spanMeters > MODEL_ARRAY_MIN_SPAN_METERS
        ? { direction: normalizedDirection, spanMeters } : null;
    }

    const instanceEntity = this.dependencies.arrays.modelArrayInstanceEntities.get(entityId);
    const sourceModel = instanceEntity ? this.dependencies.bounds.resolveModelArrayRenderModel(instanceEntity) : null;
    if (instanceEntity && sourceModel) {
      if (!sourceModel.assetHandle || !sourceModel.measurementReady) return null;
      const points = this.dependencies.bounds.getModelArrayInstanceWorldPoints(instanceEntity, sourceModel);
      const spanMeters = points
        ? this.dependencies.bounds.measureWorldPointsAlongAxes(points, [direction])?.[0] ?? null
        : null;
      if (!Number.isFinite(spanMeters) || spanMeters === null || spanMeters <= MODEL_ARRAY_MIN_SPAN_METERS) return null;
      return { direction: normalizedDirection, spanMeters };
    }

    const source = this.resolveEntityArrayPreviewSource(entityId);
    if (!source?.geometryReady || source.root.isDisposed()) return null;
    const spanMeters = measureEntityMeshesSpanMetersAlongWorldDirection(
      source.geometryMeshes,
      normalizedDirection,
    );
    if (!Number.isFinite(spanMeters) || spanMeters === null || spanMeters <= MODEL_ARRAY_MIN_SPAN_METERS) return null;

    return { direction: normalizedDirection, spanMeters };
  }

  /**
   * 更新 Shift 阵列的临时预览；模型使用隔离 Geometry 承载 thinInstance 矩阵，避免同几何批次互相覆盖。
   * 临时对象不进入实体映射、选择、脚本、MQTT、持久化或命令历史。
   */
  updateEntityArrayPreview(
    entityId: string,
    worldDirection: Vector3Data,
    copyCount: number,
    spacingMeters: number,
  ): boolean {
    if (this.disposed) return false;
    if (this.dependencies.document.shadowDocument?.entities[entityId]?.composition) {
      return this.updateCompositionArrayPreview(entityId, worldDirection, copyCount, spacingMeters);
    }
    if (this.compositionArrayPreview) this.clearEntityArrayPreview();
    const source = this.resolveEntityArrayPreviewSource(entityId);
    const geometry = this.getEntityArrayGeometry(entityId, worldDirection);
    if (!source || !geometry) {
      this.clearEntityArrayPreview();
      return false;
    }

    const normalizedCopyCount = Math.min(
      MODEL_ARRAY_COPY_COUNT_MAX,
      Math.max(0, Math.floor(Number.isFinite(copyCount) ? copyCount : 0)),
    );
    if (normalizedCopyCount === 0) {
      this.clearEntityArrayPreview();
      return true;
    }

    const normalizedSpacingMeters = Number.isFinite(spacingMeters) ? spacingMeters : 0;
    if (
      this.entityArrayPreview
      && (
        this.entityArrayPreview.sourceEntityId !== entityId
        || this.entityArrayPreview.sourceRoot !== source.root
        || this.entityArrayPreview.sourceKind !== source.kind
        || this.entityArrayPreview.sourceStrategy !== source.strategy
      )
    ) {
      this.clearEntityArrayPreview();
    }
    this.entityArrayPreview ??= {
      sourceEntityId: entityId,
      sourceRoot: source.root,
      sourceKind: source.kind,
      sourceStrategy: source.strategy,
      activeStrategy: source.strategy,
      clones: [],
      matrixPreview: null,
      poiBoundsMaterial: null,
      placementSignature: '',
    };

    const preview = this.entityArrayPreview;
    const arrayStepMeters = geometry.spanMeters + normalizedSpacingMeters;
    const placementSignature = [
      normalizedCopyCount,
      geometry.direction.x,
      geometry.direction.y,
      geometry.direction.z,
      geometry.spanMeters,
      normalizedSpacingMeters,
      source.root.position.x,
      source.root.position.y,
      source.root.position.z,
      source.root.rotation.x,
      source.root.rotation.y,
      source.root.rotation.z,
      source.root.scaling.x,
      source.root.scaling.y,
      source.root.scaling.z,
    ].join('|');
    if (preview.placementSignature === placementSignature) return true;

    if (preview.activeStrategy === 'matrix-instances') {
      preview.matrixPreview ??= EntityArrayThinInstanceBatch.create(entityId, source.previewMeshes);
      let matrixUpdated: boolean;
      if (preview.matrixPreview && source.modelArraySourceRoot && source.modelArrayBaseTransform) {
        const previewInstances = Array.from({ length: normalizedCopyCount }, (_, index) => {
          const offsetMultiplier = arrayStepMeters * (index + 1);
          return {
            entityId: `__modelArrayPreview_${index}`,
            transform: {
              position: {
                x: source.modelArrayBaseTransform!.position.x + geometry.direction.x * offsetMultiplier,
                y: source.modelArrayBaseTransform!.position.y + geometry.direction.y * offsetMultiplier,
                z: source.modelArrayBaseTransform!.position.z + geometry.direction.z * offsetMultiplier,
              },
              rotation: { ...source.modelArrayBaseTransform!.rotation },
              scale: { ...source.modelArrayBaseTransform!.scale },
            },
            pickable: false,
          };
        });
        source.modelArraySourceRoot.computeWorldMatrix(true);
        matrixUpdated = preview.matrixPreview.updateEntityTransforms(
          source.modelArraySourceRoot.getWorldMatrix().clone(),
          previewInstances,
        );
      } else {
        matrixUpdated = preview.matrixPreview?.update(normalizedCopyCount, geometry.direction, arrayStepMeters) ?? false;
      }
      if (matrixUpdated) {
        preview.placementSignature = placementSignature;
        return true;
      }

      preview.matrixPreview?.dispose();
      preview.matrixPreview = null;
      if (source.kind === 'model') {
        // 模型阵列禁止退回逐副本节点克隆；矩阵批次不可用时直接阻止本次预览。
        this.clearEntityArrayPreview();
        return false;
      }
      preview.activeStrategy = 'clone-hierarchy';
    }

    while (preview.clones.length < normalizedCopyCount) {
      const cloneIndex = preview.clones.length + 1;
      const clonedNode = this.createEntityArrayPreviewClone(source, preview, entityId, cloneIndex);
      if (!clonedNode) {
        this.clearEntityArrayPreview();
        return false;
      }
      preview.clones.push(clonedNode);
    }

    while (preview.clones.length > normalizedCopyCount) {
      preview.clones.pop()?.dispose(false, false);
    }

    for (let index = 0; index < preview.clones.length; index += 1) {
      const clone = preview.clones[index];
      const offsetMultiplier = arrayStepMeters * (index + 1);
      clone.position.copyFromFloats(
        source.root.position.x + geometry.direction.x * offsetMultiplier,
        source.root.position.y + geometry.direction.y * offsetMultiplier,
        source.root.position.z + geometry.direction.z * offsetMultiplier,
      );
      clone.computeWorldMatrix(true);
    }
    preview.placementSignature = placementSignature;

    return true;
  }

  /** 清除当前全部临时阵列批次或克隆，不释放源实体的材质、纹理或几何资源。 */
  clearEntityArrayPreview(): void {
    const compositionPreview = this.compositionArrayPreview;
    const preview = this.entityArrayPreview;
    this.compositionArrayPreview = this.entityArrayPreview = null;
    if (compositionPreview) {
      for (const { batch } of compositionPreview.members.values()) {
        runSceneRuntimeCleanup(this.context, '组合阵列预览批次', () => batch.dispose());
      }
    }
    if (!preview) return;
    for (const clone of preview.clones) {
      runSceneRuntimeCleanup(this.context, '阵列预览克隆', () => clone.dispose(false, false));
    }
    runSceneRuntimeCleanup(this.context, '阵列矩阵预览', () => preview.matrixPreview?.dispose());
    runSceneRuntimeCleanup(this.context, '阵列边界材质', () => preview.poiBoundsMaterial?.dispose(false, false));
  }

  /** 文件夹仅承载层级；组合成员的几何和预览按各自世界变换收集，禁止部分就绪提交。 */
  public resolveCompositionArraySources(entityId: string, copyCount: number): Map<string, EntityArrayPreviewSource> | null {
    if (!this.dependencies.document.shadowDocument) return null;
    const info = getCompositionArrayInfo(this.dependencies.document.shadowDocument, [entityId], copyCount);
    if (!info || info.error) return null;
    const members = new Map<string, EntityArrayPreviewSource>();
    for (const memberId of info.entityIds) {
      const entity = this.dependencies.document.shadowDocument.entities[memberId];
      if (entity.isFolder) continue;
      let ancestor: Entity | undefined = entity;
      while (ancestor && ancestor.visible !== false) {
        ancestor = ancestor.parentId ? this.dependencies.document.shadowDocument.entities[ancestor.parentId] : undefined;
      }
      if (ancestor?.visible === false) continue;
      const source = this.resolveEntityArrayPreviewSource(memberId);
      if (!source || !source.geometryReady || source.root.isDisposed() || source.previewMeshes.length === 0) return null;
      members.set(memberId, source);
    }
    return members.size > 0 ? members : null;
  }

  /** 逐成员隔离矩阵批次，既保留独立世界位姿，也支持无独立 Mesh 的模型阵列成员。 */
  public updateCompositionArrayPreview(entityId: string, direction: Vector3Data, copyCount: number, spacingMeters: number): boolean {
    if (this.disposed) return false;
    if (copyCount === 0) { this.clearEntityArrayPreview(); return true; }
    const sources = this.resolveCompositionArraySources(entityId, copyCount);
    const geometry = this.getEntityArrayGeometry(entityId, direction);
    if (!sources || !geometry || !Number.isFinite(spacingMeters)) {
      this.clearEntityArrayPreview();
      return false;
    }
    const memberIds = [...sources.keys()];
    if (this.entityArrayPreview || (this.compositionArrayPreview && (
      this.compositionArrayPreview.sourceEntityId !== entityId
      || memberIds.join('|') !== this.compositionArrayPreview.entityIds.join('|')
      || memberIds.some(id => {
        const previous = this.compositionArrayPreview!.members.get(id)?.source;
        const current = sources.get(id)!;
        return previous?.root !== current.root
          || previous.previewMeshes.length !== current.previewMeshes.length
          || previous.previewMeshes.some((mesh, i) => mesh !== current.previewMeshes[i]);
      })
    ))) this.clearEntityArrayPreview();
    this.compositionArrayPreview ??= { sourceEntityId: entityId, entityIds: memberIds, members: new Map() };
    const preview = this.compositionArrayPreview;
    const step = geometry.spanMeters + spacingMeters;
    for (const [memberId, source] of sources) {
      let entry = preview.members.get(memberId);
      if (!entry) {
        const batch = EntityArrayThinInstanceBatch.create(memberId, source.previewMeshes);
        if (!batch) { this.clearEntityArrayPreview(); return false; }
        entry = { source, batch };
        preview.members.set(memberId, entry);
      }
      let updated: boolean;
      if (source.modelArraySourceRoot && source.modelArrayBaseTransform) {
        const transform = source.modelArrayBaseTransform;
        const instances = Array.from({ length: copyCount }, (_, i) => ({
          entityId: `__compositionArrayPreview_${memberId}_${i}`,
          pickable: false,
          transform: {
            ...transform,
            position: {
              x: transform.position.x + geometry.direction.x * step * (i + 1),
              y: transform.position.y + geometry.direction.y * step * (i + 1),
              z: transform.position.z + geometry.direction.z * step * (i + 1),
            },
          },
        }));
        source.modelArraySourceRoot.computeWorldMatrix(true);
        updated = entry.batch.updateEntityTransforms(source.modelArraySourceRoot.getWorldMatrix().clone(), instances);
      } else {
        updated = entry.batch.update(copyCount, geometry.direction, step);
      }
      if (!updated) { this.clearEntityArrayPreview(); return false; }
    }
    return true;
  }

  /** 按实体运行时类型解析阵列测量和预览所需的稳定根节点与真实几何。 */
  public resolveEntityArrayPreviewSource(entityId: string): EntityArrayPreviewSource | null {
    const primitiveMesh = this.dependencies.presentation.meshes.get(entityId);
    if (primitiveMesh) {
      return {
        kind: 'mesh',
        root: primitiveMesh,
        geometryMeshes: [primitiveMesh],
        previewMeshes: [primitiveMesh],
        geometryReady: !primitiveMesh.isDisposed(),
        strategy: 'clone-hierarchy',
      };
    }

    const locator = this.dependencies.locators.locators.get(entityId);
    if (locator) {
      const renderMeshes: AbstractMesh[] = [locator.fillMesh, locator.edgeLines];
      return {
        kind: 'locator',
        root: locator.root,
        geometryMeshes: renderMeshes,
        previewMeshes: renderMeshes,
        geometryReady: true,
        strategy: 'clone-hierarchy',
      };
    }

    const cadReference = this.dependencies.cad.cadReferences.get(entityId);
    if (cadReference) {
      return {
        kind: 'cad-reference',
        root: cadReference.root,
        geometryMeshes: cadReference.lineMeshes,
        previewMeshes: cadReference.lineMeshes,
        geometryReady: cadReference.geometryReady && cadReference.lineMeshes.length > 0,
        strategy: 'clone-hierarchy',
      };
    }

    const modelArrayInstance = this.dependencies.arrays.modelArrayInstanceEntities.get(entityId);
    const modelArraySource = modelArrayInstance ? this.dependencies.bounds.resolveModelArrayRenderModel(modelArrayInstance) : null;
    if (modelArrayInstance && modelArraySource) {
      const meshes = modelArraySource.contentRoot.getChildMeshes(false);
      return {
        kind: 'model',
        root: this.getOrCreateModelArrayGizmoProxy(modelArrayInstance),
        geometryMeshes: meshes,
        previewMeshes: meshes,
        geometryReady: Boolean(modelArraySource.assetHandle && modelArraySource.measurementReady),
        strategy: 'matrix-instances',
        modelArraySourceRoot: modelArraySource.root,
        modelArrayBaseTransform: modelArrayInstance.components.transform,
      };
    }

    const model = this.dependencies.assets.models.get(entityId);
    if (model) {
      const meshes = model.contentRoot.getChildMeshes(false);
      return {
        kind: 'model',
        root: model.root,
        geometryMeshes: meshes,
        previewMeshes: meshes,
        geometryReady: Boolean(model.assetHandle && model.measurementReady),
        strategy: 'matrix-instances',
      };
    }

    const poi = this.dependencies.effects.poiEffectRuntime.getEntityArraySource(entityId);
    if (poi) {
      return {
        kind: 'poi',
        root: poi.root,
        geometryMeshes: poi.geometryMeshes,
        previewMeshes: poi.previewMeshes,
        geometryReady: poi.geometryMeshes.length > 0,
        strategy: 'poi-static',
      };
    }

    return null;
  }

  /** 创建单个临时阵列副本；POI 只复制静态视觉 Mesh 或粒子范围代理。 */
  public createEntityArrayPreviewClone(
    source: EntityArrayPreviewSource,
    preview: EntityArrayPreviewEntry,
    entityId: string,
    cloneIndex: number,
  ): TransformNode | null {
    const cloneName = `__entityArrayPreview_${entityId}_${cloneIndex}`;
    if (source.strategy !== 'poi-static') {
      const clone = source.root.clone(cloneName, null, false);
      if (!clone) return null;
      this.prepareEntityArrayPreviewClone(clone);
      this.copyThinInstanceBuffersForPreviewClone(source.root, clone);
      return clone;
    }

    const cloneRoot = source.root.clone(cloneName, null, true);
    if (!cloneRoot) return null;

    for (let meshIndex = 0; meshIndex < source.previewMeshes.length; meshIndex += 1) {
      const sourceMesh = source.previewMeshes[meshIndex];
      const cloneMesh = sourceMesh.clone(`${cloneName}_mesh_${meshIndex}`, cloneRoot, true);
      if (!cloneMesh) {
        cloneRoot.dispose(false, false);
        return null;
      }

      const metadata = sourceMesh.metadata as Record<string, unknown> | null | undefined;
      if (metadata?.effectBoundsProxy === true) {
        cloneMesh.isVisible = true;
        cloneMesh.visibility = 1;
        cloneMesh.material = this.getOrCreatePoiArrayBoundsMaterial(preview);
      }
    }

    this.prepareEntityArrayPreviewClone(cloneRoot);
    return cloneRoot;
  }

  /** 复用一个轻量半透明材质显示纯粒子 POI 的效果范围代理。 */
  public getOrCreatePoiArrayBoundsMaterial(preview: EntityArrayPreviewEntry): StandardMaterial {
    if (preview.poiBoundsMaterial) return preview.poiBoundsMaterial;

    const material = new StandardMaterial('__entityArrayPoiBoundsMaterial', this.context.scene);
    const color = Color3.FromHexString('#55C8FF');
    material.disableLighting = true;
    material.alpha = 0.18;
    material.diffuseColor = color;
    material.emissiveColor = color;
    material.backFaceCulling = false;
    preview.poiBoundsMaterial = material;
    return material;
  }

  /** 当前源实体被删除、重建或锁定时立即释放其临时阵列预览。 */
  public clearEntityArrayPreviewIfSource(entityId: string): void {
    if (this.entityArrayPreview?.sourceEntityId === entityId
      || this.compositionArrayPreview?.sourceEntityId === entityId
      || this.compositionArrayPreview?.members.has(entityId)) this.clearEntityArrayPreview();
  }

  /** 清理临时阵列克隆的交互状态，并恢复共享矩阵实例的公开缓冲容器。 */
  public prepareEntityArrayPreviewClone(root: TransformNode): void {
    const nodes: Node[] = [root, ...root.getDescendants(false)];
    const previewMeshes: AbstractMesh[] = [];
    for (const node of nodes) {
      node.metadata = null;
      if (node instanceof AbstractMesh) {
        previewMeshes.push(node);
        node.isPickable = false;
        node.actionManager = null;
      }
    }

    // 递归 clone 不会继承 InstancedMesh.instancedBuffers；源 Mesh 已注册选择缓冲时必须在首帧前补齐。
    repairInstancedMeshBufferContainers(previewMeshes);
  }

  /**
   * 递归 clone 同样不携带 thinInstance 矩阵缓冲；从源拷贝，预览副本才能呈现全部实例。
   * 子克隆按 `克隆根名.源相对路径` 命名（见 TransformNode/Mesh._copySource），按相对路径回溯源 Mesh。
   */
  public copyThinInstanceBuffersForPreviewClone(sourceRoot: TransformNode, cloneRoot: TransformNode): void {
    const clonePrefix = `${cloneRoot.name}.`;
    const cloneMeshesByPath = new Map<string, AbstractMesh>();
    for (const node of cloneRoot.getDescendants(false)) {
      if (node instanceof AbstractMesh && node.name.startsWith(clonePrefix)) {
        cloneMeshesByPath.set(node.name.slice(clonePrefix.length), node);
      }
    }
    if (cloneMeshesByPath.size === 0) return;

    const relativePathOf = (node: Node): string => {
      const parts: string[] = [];
      let current: Node | null = node;
      while (current && current !== sourceRoot) {
        parts.unshift(current.name);
        current = current.parent;
      }
      return parts.join('.');
    };
    for (const node of sourceRoot.getDescendants(false)) {
      if (!(node instanceof Mesh) || node.thinInstanceCount === 0) continue;
      const matrixData = node._thinInstanceDataStorage?.matrixData;
      const cloneMesh = cloneMeshesByPath.get(relativePathOf(node));
      if (!matrixData || !(cloneMesh instanceof Mesh)) continue;
      cloneMesh.thinInstanceSetBuffer('matrix', new Float32Array(matrixData), 16, true);
      cloneMesh.thinInstanceRefreshBoundingInfo(true);
    }
  }

  /** 为当前选中的矩阵实例复用一个无几何 TransformNode，Gizmo 拖动仍回写该逻辑实体。 */
  public getOrCreateModelArrayGizmoProxy(entity: Entity): TransformNode {
    if (this.disposed) throw new Error('场景变换预览已释放。');
    if (!this.modelArrayGizmoProxy || this.modelArrayGizmoProxy.node.isDisposed()) {
      this.modelArrayGizmoProxy = {
        entityId: entity.id,
        node: new TransformNode('__modelArrayInstanceGizmoProxy', this.context.scene),
      };
    }

    this.modelArrayGizmoProxy.entityId = entity.id;
    this.dependencies.presentation.applyTransform(this.modelArrayGizmoProxy.node, entity.components.transform);
    this.modelArrayGizmoProxy.node.computeWorldMatrix(true);
    return this.modelArrayGizmoProxy.node;
  }

  /**
   * 完整同步结束后回收不再由矩阵阵列承载的 Gizmo 代理。
   * 正式阵列的原模型也使用该代理；若只检查 modelArrayInstance，拖动首帧同步会销毁当前目标。
   */
  public disposeStaleModelArrayGizmoProxy(): void {
    const proxy = this.modelArrayGizmoProxy;
    if (!proxy) return;
    if (
      this.dependencies.arrays.modelArrayInstanceEntities.has(proxy.entityId)
      || Boolean(this.dependencies.assets.models.get(proxy.entityId)?.modelArrayBatch)
    ) {
      return;
    }

    proxy.node.dispose(false, false);
    this.modelArrayGizmoProxy = null;
  }
  /** 按原构造顺序连接此领域的资源与回调。 */
  initializeGroupTransformPreviewObserver(): void {
    if (this.disposed || this.groupTransformPreviewObserver) return;
    this.groupTransformPreviewObserver = this.context.scene.onBeforeActiveMeshesEvaluationObservable.add(() => {
      if (this.disposed) return;
      this.flushGroupTranslationPreview();
      this.flushGroupRotationPreview();
    });
  }

}
