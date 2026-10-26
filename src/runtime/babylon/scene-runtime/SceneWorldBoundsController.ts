import type { SceneRuntime } from '../SceneRuntime';
import { createStackerFocusView, getStackerFocusWorldBounds } from '../stackerFocusBounds';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight.js';
import { Light } from '@babylonjs/core/Lights/light.js';
import { PointLight } from '@babylonjs/core/Lights/pointLight.js';
import { RectAreaLight } from '@babylonjs/core/Lights/rectAreaLight.js';
import { SpotLight } from '@babylonjs/core/Lights/spotLight.js';
import { Matrix, Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh.js';
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import type { Entity } from '../../../editor/model/Entity';
import type { TransformComponent } from '../../../editor/model/components';
import type { Vector3Data } from '../../../editor/model/math';
import { isMeasurableModelMesh, measureModelSizeMeters, type ModelMeasurementResult } from '../modelMeasurement';
import { resolveLocatorCellWorldBounds } from '../telemetry/stackerStorageLocation';
import { computeRootRelativeWorldMatrix, createPointWorldBounds, getMeshWorldBounds, getThinInstanceMeshWorldBounds, isFiniteVector3, mergeWorldBounds, transformWorldBounds, type RuntimeWorldBounds } from '../runtimeNodeGeometry';
import type { SceneRuntimeContext } from './SceneRuntimeContext';
import type { ModelAssetRuntimeController } from './ModelAssetRuntimeController';
import type { ModelArrayRuntimeController } from './ModelArrayRuntimeController';
import type { SceneDocumentController } from './SceneDocumentController';
import type { SceneLocatorController } from './SceneLocatorController';
import type { GeneratedModelOutputController } from './GeneratedModelOutputController';
import type { SceneCadReferenceController } from './SceneCadReferenceController';
import type { SceneMeshPresentationController } from './SceneMeshPresentationController';
import type { EnvironmentAndSkyboxController } from './EnvironmentAndSkyboxController';
import type { ScenePoiAndEffectsController } from './ScenePoiAndEffectsController';
import type { ScenePatrolAndRoamController } from './ScenePatrolAndRoamController';
import type { ParameterVariantHostPool } from './ParameterVariantHostPool';
import { type ModelRuntimeEntry, type ModelGeneratorRuntimeEntry, type CadReferenceRuntimeEntry, readCurrentThinInstanceMatrices, collectGeneratedOutputMeshes, getGeneratedOutputMeshWorldBounds } from './sceneRuntimeTypes';

/** 此领域仅能访问明确列出的协作能力，资源与缓存由所属 Controller 持有。 */
type Dependencies = {
  readonly assets: Pick<ModelAssetRuntimeController, 'models'>;
  readonly arrays: Pick<ModelArrayRuntimeController, 'modelArrayInstanceEntities'>;
  readonly document: Pick<SceneDocumentController, 'resolveRuntimeModelByEntityId' | 'syncedEntities' | 'resolveSpawnedDeviceModel'>;
  readonly locators: Pick<SceneLocatorController, 'locators'>;
  readonly outputs: Pick<GeneratedModelOutputController, 'modelGenerators' | 'generatedOutputOwners' | 'deviceSpawnerMarkers'>;
  readonly cad: Pick<SceneCadReferenceController, 'cadReferences'>;
  readonly presentation: Pick<SceneMeshPresentationController, 'meshes' | 'lights'>;
  readonly environment: Pick<EnvironmentAndSkyboxController, 'skyboxRuntime'>;
  readonly effects: Pick<ScenePoiAndEffectsController, 'poiEffectRuntime' | 'clickEventBindingRuntime'>;
  readonly patrol: Pick<ScenePatrolAndRoamController, 'manualRoamSpawnRuntime'>;
  readonly variants: Pick<ParameterVariantHostPool, 'modelArrayParameterVariantByEntityId'>;
};


/** SceneWorldBoundsController 的资源、状态及取消/释放操作在同一领域内维护。 */
export class SceneWorldBoundsController {
  constructor(_context: SceneRuntimeContext, private readonly dependencies: Dependencies) {}


  /**
   * 读取普通导入模型沿实体自身 X/Y/Z 轴的实际米制尺寸。
   * 加载与脚本初始化完成前返回 loading；没有有效可见几何时返回 unavailable。
   */
  getModelMeasurement(entityId: string): ModelMeasurementResult {
    const model = this.dependencies.assets.models.get(entityId);
    if (model) {
      if (!model.assetHandle || !model.measurementReady) return { status: 'loading', sizeMeters: null };
      const sizeMeters = measureModelSizeMeters(model.root, model.contentRoot);
      return sizeMeters
        ? { status: 'ready', sizeMeters }
        : { status: 'unavailable', sizeMeters: null };
    }

    const instanceEntity = this.dependencies.arrays.modelArrayInstanceEntities.get(entityId);
    const sourceModel = instanceEntity ? this.resolveModelArrayRenderModel(instanceEntity) : null;
    if (!instanceEntity || !sourceModel) return { status: 'unavailable', sizeMeters: null };
    if (!sourceModel.assetHandle || !sourceModel.measurementReady) return { status: 'loading', sizeMeters: null };

    const points = this.getModelArrayInstanceWorldPoints(instanceEntity, sourceModel);
    const axes = this.getTransformWorldAxes(instanceEntity.components.transform);
    const spans = points && axes ? this.measureWorldPointsAlongAxes(points, axes) : null;
    return spans
      ? { status: 'ready', sizeMeters: { x: spans[0], y: spans[1], z: spans[2] } }
      : { status: 'unavailable', sizeMeters: null };
  }

  /** 汇总多个实体的世界包围盒，供场景聚焦和模型阵列读取中心、尺寸与几何就绪状态。 */
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
  } | null {
    let mergedBounds: RuntimeWorldBounds | null = null;
    let geometryReady = true;
    let resolvedEntityCount = 0;
    let geometryReadyEntityCount = 0;
    let missingEntityCount = 0;
    let notReadyEntityCount = 0;
    const missingEntityIds: string[] = [];
    const notReadyEntityIds: string[] = [];
    const uniqueEntityIds = [...new Set(entityIds)];

    for (const entityId of uniqueEntityIds) {
      const bounds = this.getEntityWorldBounds(entityId);
      if (!bounds) {
        geometryReady = false;
        missingEntityCount += 1;
        if (missingEntityIds.length < 32) missingEntityIds.push(entityId);
        continue;
      }
      resolvedEntityCount += 1;
      if (this.isEntityWorldBoundsReady(entityId)) {
        geometryReadyEntityCount += 1;
      } else {
        geometryReady = false;
        notReadyEntityCount += 1;
        if (notReadyEntityIds.length < 32) notReadyEntityIds.push(entityId);
      }
      mergedBounds = mergedBounds ? mergeWorldBounds(mergedBounds, bounds) : bounds;
    }

    if (!mergedBounds) return null;

    const center = mergedBounds.minimum.add(mergedBounds.maximum).scale(0.5);
    const size = mergedBounds.maximum.subtract(mergedBounds.minimum);
    const radiusMeters = Math.max(0.5, size.length() / 2);

    return {
      center: { x: center.x, y: center.y, z: center.z },
      sizeMeters: { x: size.x, y: size.y, z: size.z },
      radiusMeters,
      geometryReady,
      requestedEntityCount: uniqueEntityIds.length,
      resolvedEntityCount,
      geometryReadyEntityCount,
      missingEntityCount,
      notReadyEntityCount,
      missingEntityIds,
      notReadyEntityIds,
    };
  }

  /** 单台堆垛机使用运动机身范围；多选及其他用途仍保留完整实体几何。 */
  getEntitiesFocusBounds(entityIds: string[]): (NonNullable<ReturnType<SceneRuntime['getEntitiesWorldBounds']>> & {
    focusView?: ReturnType<typeof createStackerFocusView>;
  }) | null {
    const complete = this.getEntitiesWorldBounds(entityIds);
    const uniqueIds = [...new Set(entityIds)];
    if (!complete?.geometryReady || uniqueIds.length !== 1) return complete;
    const model = this.dependencies.document.resolveRuntimeModelByEntityId(uniqueIds[0]);
    if (!model) return complete;
    const bounds = getStackerFocusWorldBounds(model);
    if (!bounds) return complete;
    if (model.externalScriptStarting || !model.measurementReady) {
      return { ...complete, geometryReady: false, geometryReadyEntityCount: 0,
        notReadyEntityCount: 1, notReadyEntityIds: uniqueIds };
    }
    const center = bounds.minimum.add(bounds.maximum).scale(0.5);
    const size = bounds.maximum.subtract(bounds.minimum);
    return { ...complete, focusView: createStackerFocusView(model, bounds),
      center: { x: center.x, y: center.y, z: center.z },
      sizeMeters: { x: size.x, y: size.y, z: size.z }, radiusMeters: Math.max(0.5, size.length() / 2) };
  }

  /** 按货格「排-列-层」返回单格世界包围盒，供发布 Viewer 搜索聚焦；找不到格子时返回 null。 */
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
  } | null {
    const locator = this.dependencies.locators.locators.get(entityId);
    if (!locator || locator.root.isDisposed()) return null;
    const bounds = resolveLocatorCellWorldBounds(locator, coordinate);
    if (!bounds) return null;

    const hostEntityId = this.dependencies.document.syncedEntities.get(entityId)?.components.locator?.builtInBinding?.hostEntityId;
    const hostReady = !hostEntityId || this.isEntityWorldBoundsReady(hostEntityId);
    const center = bounds.minimum.add(bounds.maximum).scale(0.5);
    const size = bounds.maximum.subtract(bounds.minimum);
    const radiusMeters = Math.max(0.5, size.length() / 2);
    return {
      center: { x: center.x, y: center.y, z: center.z },
      sizeMeters: { x: size.x, y: size.y, z: size.z },
      radiusMeters,
      geometryReady: hostReady,
      requestedEntityCount: 1,
      resolvedEntityCount: 1,
      geometryReadyEntityCount: hostReady ? 1 : 0,
      missingEntityCount: 0,
      notReadyEntityCount: hostReady ? 0 : 1,
      missingEntityIds: [],
      notReadyEntityIds: hostReady || !hostEntityId ? [] : [hostEntityId],
    };
  }
  /** 判断实体的真实几何是否已就绪，避免模型加载或外置脚本初始化中的临时包围盒参与正式阵列。 */
  public isEntityWorldBoundsReady(entityId: string): boolean {
    const model = this.dependencies.assets.models.get(entityId);
    if (model) {
      if (!model.assetHandle || !model.stackerTelemetryReady) return false;
      return !model.modelArrayBatch || model.modelArrayBatch.hasEntityId(entityId);
    }

    const spawnedModel = this.dependencies.document.resolveSpawnedDeviceModel(entityId);
    if (spawnedModel) {
      return Boolean(spawnedModel.assetHandle) && spawnedModel.stackerTelemetryReady;
    }

    const modelArrayInstance = this.dependencies.arrays.modelArrayInstanceEntities.get(entityId);
    if (modelArrayInstance) {
      const renderModel = this.resolveModelArrayRenderModel(modelArrayInstance);
      return Boolean(
        renderModel?.assetHandle
        && renderModel.measurementReady
        && renderModel.modelArrayBatch?.hasEntityId(entityId),
      );
    }

    const modelGenerator = this.dependencies.outputs.modelGenerators.get(entityId);
    if (modelGenerator) return true;

    const cadReference = this.dependencies.cad.cadReferences.get(entityId);
    if (cadReference) return cadReference.geometryReady && cadReference.lineMeshes.length > 0;

    return this.dependencies.presentation.meshes.has(entityId)
      || this.dependencies.environment.skyboxRuntime.hasEntity(entityId)
      || this.dependencies.locators.locators.has(entityId)
      || this.dependencies.presentation.lights.has(entityId)
      || this.dependencies.effects.poiEffectRuntime.has(entityId)
      || Boolean(this.dependencies.document.syncedEntities.get(entityId)?.components.autoPatrol);
  }

  /** 根据运行时对象类型读取单个实体的世界包围盒。 */
  public getEntityWorldBounds(entityId: string): RuntimeWorldBounds | null {
    const primitiveMesh = this.dependencies.presentation.meshes.get(entityId);
    if (primitiveMesh) return getMeshWorldBounds(primitiveMesh);

    if (this.dependencies.environment.skyboxRuntime.hasEntity(entityId)) return null;

    const locator = this.dependencies.locators.locators.get(entityId);
    if (locator) {
      // fillMesh 的局部包围盒已覆盖全部薄实例格子，直接读世界包围盒即可。
      const bounds = getMeshWorldBounds(locator.fillMesh);
      if (bounds) return bounds;
    }

    const cadReference = this.dependencies.cad.cadReferences.get(entityId);
    if (cadReference) return this.getCadReferenceWorldBounds(cadReference);

    const modelArrayInstance = this.dependencies.arrays.modelArrayInstanceEntities.get(entityId);
    const modelArrayRenderModel = modelArrayInstance ? this.resolveModelArrayRenderModel(modelArrayInstance) : null;
    if (modelArrayInstance && modelArrayRenderModel) {
      return this.getModelArrayInstanceWorldBounds(modelArrayInstance, modelArrayRenderModel);
    }

    const model = this.dependencies.document.resolveRuntimeModelByEntityId(entityId);
    if (model) return this.getModelWorldBounds(model);

    // 生成货物的输出宿主：聚焦目标为产物自身全部网格的合并包围盒。
    const generatedOwner = this.dependencies.outputs.generatedOutputOwners.get(entityId);
    if (generatedOwner) {
      let mergedBounds: RuntimeWorldBounds | null = null;
      for (const mesh of collectGeneratedOutputMeshes(generatedOwner.output)) {
        if (mesh.isDisposed()) continue;
        const bounds = getGeneratedOutputMeshWorldBounds(mesh);
        if (!bounds) continue;
        mergedBounds = mergedBounds ? mergeWorldBounds(mergedBounds, bounds) : bounds;
      }
      if (mergedBounds) return mergedBounds;
    }

    const modelGenerator = this.dependencies.outputs.modelGenerators.get(entityId);
    if (modelGenerator) return this.getModelGeneratorWorldBounds(modelGenerator);

    const deviceSpawnerMarker = this.dependencies.outputs.deviceSpawnerMarkers.get(entityId);
    if (deviceSpawnerMarker) return getMeshWorldBounds(deviceSpawnerMarker.mesh);

    const light = this.dependencies.presentation.lights.get(entityId);
    if (light) return this.getLightWorldBounds(light);

    const autoPatrolEntity = this.dependencies.document.syncedEntities.get(entityId);
    if (autoPatrolEntity?.components.autoPatrol) {
      const position = autoPatrolEntity.components.transform.position;
      return createPointWorldBounds(new Vector3(position.x, position.y, position.z));
    }

    const manualRoamSpawnMeshes = this.dependencies.patrol.manualRoamSpawnRuntime.getWorldBoundsMeshes(entityId);
    if (manualRoamSpawnMeshes.length > 0) {
      let mergedBounds: RuntimeWorldBounds | null = null;
      for (const mesh of manualRoamSpawnMeshes) {
        const bounds = getMeshWorldBounds(mesh);
        if (!bounds) continue;
        mergedBounds = mergedBounds ? mergeWorldBounds(mergedBounds, bounds) : bounds;
      }
      if (mergedBounds) return mergedBounds;
    }

    const clickEventBindingMeshes = this.dependencies.effects.clickEventBindingRuntime.getWorldBoundsMeshes(entityId);
    if (clickEventBindingMeshes.length > 0) {
      let mergedBounds: RuntimeWorldBounds | null = null;
      for (const mesh of clickEventBindingMeshes) {
        const bounds = getMeshWorldBounds(mesh);
        if (!bounds) continue;
        mergedBounds = mergedBounds ? mergeWorldBounds(mergedBounds, bounds) : bounds;
      }
      if (mergedBounds) return mergedBounds;
    }

    const poiEffectMeshes = this.dependencies.effects.poiEffectRuntime.getWorldBoundsMeshes(entityId);
    if (poiEffectMeshes.length > 0) {
      let mergedBounds: RuntimeWorldBounds | null = null;
      for (const mesh of poiEffectMeshes) {
        const bounds = getMeshWorldBounds(mesh);
        if (!bounds) continue;
        mergedBounds = mergedBounds ? mergeWorldBounds(mergedBounds, bounds) : bounds;
      }
      if (mergedBounds) return mergedBounds;
    }

    return null;
  }

  /** 检查 Mesh 自身和模型内部祖先；实体根可能因显隐或矩阵批次被禁用，不作为几何失效依据。 */
  public isModelBoundsMesh(model: ModelRuntimeEntry, mesh: AbstractMesh): boolean {
    if (!isMeasurableModelMesh(mesh)) return false;

    let ancestor = mesh.parent;
    while (ancestor && ancestor !== model.root) {
      if (!ancestor.isEnabled(false)) return false;
      ancestor = ancestor.parent;
    }
    return ancestor === model.root;
  }

  /** 导入模型只汇总内部层级有效且有顶点的子网格包围盒，加载中则回退到模型根节点位置。 */
  public getModelWorldBounds(model: ModelRuntimeEntry): RuntimeWorldBounds | null {
    // 遥测代理没有自身网格：把宿主模型的世界包围盒按两台设备的相对位姿换算到代理位姿。
    const proxySource = model.telemetryProxySource;
    if (proxySource) {
      const sourceBounds = this.getModelWorldBounds(proxySource);
      if (!sourceBounds) return null;
      const relativeMatrix = computeRootRelativeWorldMatrix(proxySource.root, model.root);
      return relativeMatrix ? transformWorldBounds(sourceBounds, relativeMatrix) : null;
    }

    let mergedBounds: RuntimeWorldBounds | null = null;

    for (const mesh of model.meshes) {
      if (!this.isModelBoundsMesh(model, mesh)) continue;
      const bounds = getMeshWorldBounds(mesh);
      if (!bounds) continue;
      mergedBounds = mergedBounds ? mergeWorldBounds(mergedBounds, bounds) : bounds;
    }

    if (mergedBounds) return mergedBounds;

    model.root.computeWorldMatrix(true);
    return createPointWorldBounds(model.root.getAbsolutePosition());
  }

  /** 按实体参数组合返回真正提供几何的源模型或隐藏参数脚本宿主。 */
  public resolveModelArrayRenderModel(entity: Entity): ModelRuntimeEntry | null {
    const variant = this.dependencies.variants.modelArrayParameterVariantByEntityId.get(entity.id);
    if (variant) return variant.model;

    const sourceEntityId = entity.components.modelArrayInstance?.sourceEntityId;
    return sourceEntityId ? this.dependencies.assets.models.get(sourceEntityId) ?? null : null;
  }

  /** 将源模型有效网格的世界包围盒角点转换到一个独立矩阵实例的世界空间。 */
  public getModelArrayInstanceWorldPoints(entity: Entity, sourceModel: ModelRuntimeEntry): Vector3[] | null {
    sourceModel.root.computeWorldMatrix(true);
    const inverseSourceRoot = sourceModel.root.getWorldMatrix().clone();
    const determinant = inverseSourceRoot.determinant();
    if (!Number.isFinite(determinant) || Math.abs(determinant) <= 1e-12) return null;
    inverseSourceRoot.invert();

    const targetWorldMatrix = this.createEntityTransformMatrix(entity.components.transform);
    const points: Vector3[] = [];
    for (const mesh of sourceModel.meshes) {
      if (!this.isModelBoundsMesh(sourceModel, mesh)) continue;
      mesh.computeWorldMatrix(true);
      const meshWorldMatrix = mesh.getWorldMatrix().clone();
      const hasThinInstances = mesh instanceof Mesh && mesh.thinInstanceCount > 0;
      const thinInstanceMatrices = hasThinInstances ? readCurrentThinInstanceMatrices(mesh) : null;
      if (hasThinInstances && !thinInstanceMatrices) return null;
      const sourceWorldMatrices = hasThinInstances
        ? thinInstanceMatrices!.map((matrix) => matrix.multiply(meshWorldMatrix))
        : [meshWorldMatrix];

      // 必须从 Geometry 原始局部包围盒出发；先使用 world AABB 再旋转会二次放大斜置部件，
      // 导致负缩放或旋转阵列实例的聚焦/测量范围与真实批次不一致。
      const boundingBox = (mesh.rawBoundingInfo ?? mesh.getBoundingInfo()).boundingBox;
      for (const sourceWorldMatrix of sourceWorldMatrices) {
        const finalWorldMatrix = sourceWorldMatrix.multiply(inverseSourceRoot).multiply(targetWorldMatrix);
        for (const localCorner of boundingBox.vectors) {
          const targetWorldCorner = Vector3.TransformCoordinates(localCorner, finalWorldMatrix);
          if (isFiniteVector3(targetWorldCorner)) points.push(targetWorldCorner);
        }
      }
    }
    return points.length > 0 ? points : null;
  }

  /** 计算单个独立矩阵实例的世界轴对齐包围盒。 */
  public getModelArrayInstanceWorldBounds(entity: Entity, sourceModel: ModelRuntimeEntry): RuntimeWorldBounds | null {
    const points = this.getModelArrayInstanceWorldPoints(entity, sourceModel);
    if (!points) return createPointWorldBounds(
      new Vector3(
        entity.components.transform.position.x,
        entity.components.transform.position.y,
        entity.components.transform.position.z,
      ),
    );

    let minimum = points[0].clone();
    let maximum = points[0].clone();
    for (let index = 1; index < points.length; index += 1) {
      minimum = Vector3.Minimize(minimum, points[index]);
      maximum = Vector3.Maximize(maximum, points[index]);
    }
    return { minimum, maximum };
  }

  /** 从实体 Transform 构造与无父节点 TransformNode 一致的世界矩阵。 */
  public createEntityTransformMatrix(transform: TransformComponent): Matrix {
    return Matrix.Compose(
      new Vector3(transform.scale.x, transform.scale.y, transform.scale.z),
      Quaternion.RotationYawPitchRoll(transform.rotation.y, transform.rotation.x, transform.rotation.z),
      new Vector3(transform.position.x, transform.position.y, transform.position.z),
    );
  }

  /** 读取实体局部 X/Y/Z 轴在世界空间的单位方向。 */
  public getTransformWorldAxes(transform: TransformComponent): [Vector3, Vector3, Vector3] | null {
    const matrix = this.createEntityTransformMatrix(transform);
    const axes = [Vector3.Right(), Vector3.Up(), Vector3.Forward()]
      .map((axis) => Vector3.TransformNormal(axis, matrix));
    if (axes.some((axis) => !Number.isFinite(axis.lengthSquared()) || axis.lengthSquared() <= 1e-12)) {
      return null;
    }
    return axes.map((axis) => axis.normalize()) as [Vector3, Vector3, Vector3];
  }

  /** 测量显式世界点集沿一组单位方向的投影跨度。 */
  public measureWorldPointsAlongAxes(points: readonly Vector3[], axes: readonly Vector3[]): number[] | null {
    if (points.length === 0 || axes.length === 0) return null;
    const minimum = axes.map(() => Number.POSITIVE_INFINITY);
    const maximum = axes.map(() => Number.NEGATIVE_INFINITY);

    for (const point of points) {
      for (let axisIndex = 0; axisIndex < axes.length; axisIndex += 1) {
        const projection = Vector3.Dot(point, axes[axisIndex]);
        if (!Number.isFinite(projection)) return null;
        minimum[axisIndex] = Math.min(minimum[axisIndex], projection);
        maximum[axisIndex] = Math.max(maximum[axisIndex], projection);
      }
    }
    return minimum.map((value, index) => Math.max(0, maximum[index] - value));
  }

  /** 模型生成器包围盒始终只描述编辑态配置标记，不包含任何运行时自动货物。 */
  public getModelGeneratorWorldBounds(modelGenerator: ModelGeneratorRuntimeEntry): RuntimeWorldBounds | null {
    const markerBounds = getMeshWorldBounds(modelGenerator.marker.mesh);
    if (markerBounds) return markerBounds;

    modelGenerator.markerRoot.computeWorldMatrix(true);
    return createPointWorldBounds(modelGenerator.markerRoot.getAbsolutePosition());
  }

  /** CAD 取景包含所有 INSERT 实例，不能使用只描述原型尺寸的模型包围盒。 */
  public getCadReferenceWorldBounds(cadReference: CadReferenceRuntimeEntry): RuntimeWorldBounds | null {
    let mergedBounds: RuntimeWorldBounds | null = null;

    for (const lineMesh of cadReference.lineMeshes) {
      const bounds = getThinInstanceMeshWorldBounds(lineMesh) ?? getMeshWorldBounds(lineMesh);
      if (!bounds) continue;
      mergedBounds = mergedBounds ? mergeWorldBounds(mergedBounds, bounds) : bounds;
    }

    if (mergedBounds) return mergedBounds;

    cadReference.root.computeWorldMatrix(true);
    return createPointWorldBounds(cadReference.root.getAbsolutePosition());
  }

  /** 灯光没有可见体积时用其位置生成一个小包围盒。 */
  public getLightWorldBounds(light: Light): RuntimeWorldBounds {
    if (light instanceof DirectionalLight || light instanceof PointLight || light instanceof SpotLight) {
      return createPointWorldBounds(light.position);
    }
    if (light instanceof RectAreaLight && light.parent instanceof TransformNode) return createPointWorldBounds(light.parent.getAbsolutePosition());

    return createPointWorldBounds(new Vector3(0, 2, 0));
  }
}
