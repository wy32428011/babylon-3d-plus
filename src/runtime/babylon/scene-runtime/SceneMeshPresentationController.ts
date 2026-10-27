import { ensureLocalAreaLightTextures } from '../localAreaLightTextures';
import { DEFAULT_SPOT_ANGLE, DEFAULT_SPOT_EXPONENT, DEFAULT_AREA_LIGHT_SIZE } from '../../../editor/model/lightSettings';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight.js';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight.js';
import { Light } from '@babylonjs/core/Lights/light.js';
import { PointLight } from '@babylonjs/core/Lights/pointLight.js';
import { RectAreaLight } from '@babylonjs/core/Lights/rectAreaLight.js';
import { SpotLight } from '@babylonjs/core/Lights/spotLight.js';
import { GreasedLineMeshColorDistributionType, GreasedLineMeshMaterialType } from '@babylonjs/core/Materials/GreasedLine/greasedLineMaterialInterfaces.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { Texture } from '@babylonjs/core/Materials/Textures/texture.js';
import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import { Matrix, Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh.js';
import { CreateGreasedLine } from '@babylonjs/core/Meshes/Builders/greasedLineBuilder.js';
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import type { GreasedLineSimpleMaterial } from '@babylonjs/core';
import type { Entity } from '../../../editor/model/Entity';
import type { LightComponent, MeshRendererComponent, TransformComponent } from '../../../editor/model/components';
import { BUILT_IN_BOX_SIZE_METERS, BUILT_IN_PLANE_SIZE_METERS, BUILT_IN_SPHERE_DIAMETER_METERS } from '../../../editor/model/builtInMeshGeometry';
import { EditorLightMarkerRuntime } from '../EditorLightMarkerRuntime';
import { clampNumber, createLocalAxis, filterTopLevelMotionNodes, findModelNodes, findModelNodesByName, getHorizontalModelAxis, getModelAxis, getNodesWorldBounds, normalizeVector, projectWorldBoundsOntoAxis } from '../runtimeNodeGeometry';
import { readConveyorCargoSurfaceOffset, readConveyorCargoTravelConfig } from '../telemetry/specialized/specializedModelAssets';
import type { ConveyorCargoTravelConfig } from '../telemetry/specialized/types';
import type { SceneRuntimeContext } from './SceneRuntimeContext';
import { runSceneRuntimeCleanup } from './sceneRuntimeCleanup';
import type { SceneDocumentController } from './SceneDocumentController';
import type { ScenePoiAndEffectsController } from './ScenePoiAndEffectsController';
import type { SceneTransformPreviewController } from './SceneTransformPreviewController';
import type { EnvironmentAndSkyboxController } from './EnvironmentAndSkyboxController';
import type { ModelArrayRuntimeController } from './ModelArrayRuntimeController';
import type { ParameterVariantHostPool } from './ParameterVariantHostPool';
import type { ModelAssetRuntimeController } from './ModelAssetRuntimeController';
import type { SceneWorldBoundsController } from './SceneWorldBoundsController';
import { FALLBACK_MATERIAL_COLOR, type ModelRuntimeEntry, type ConveyorTrajectoryRuntimeEntry, type ConveyorTrajectoryContext } from './sceneRuntimeTypes';

/** 此领域仅能访问明确列出的协作能力，资源与缓存由所属 Controller 持有。 */
type Dependencies = {
  readonly document: Pick<SceneDocumentController, 'isEntityVisible' | 'isEntityScenePickable'>;
  readonly effects: Pick<ScenePoiAndEffectsController, 'poiEffectRuntime' | 'chartMarkerPresentation' | 'dataPlatformScreenTextures'>;
  readonly transforms: Pick<SceneTransformPreviewController, 'applyLightTransform' | 'clearEntityArrayPreviewIfSource'>;
  readonly environment: Pick<EnvironmentAndSkyboxController, 'lightRigRuntime' | 'shadowRuntime'>;
  readonly arrays: Pick<ModelArrayRuntimeController, 'modelArrayInstanceEntities'>;
  readonly variants: Pick<ParameterVariantHostPool, 'modelArrayParameterVariantByEntityId'>;
  readonly assets: Pick<ModelAssetRuntimeController, 'models'>;
  readonly bounds: Pick<SceneWorldBoundsController, 'getModelWorldBounds'>;
};


/** SceneMeshPresentationController 的资源、状态及取消/释放操作在同一领域内维护。 */
export class SceneMeshPresentationController {
  constructor(private readonly context: SceneRuntimeContext, private readonly dependencies: Dependencies) {}

  public readonly meshes = new Map<string, Mesh>();
  public readonly conveyorTrajectories = new Map<string, ConveyorTrajectoryRuntimeEntry>();
  public _trajectoryVisible = false;
  public readonly lights = new Map<string, Light>();
  public lightMarkerRuntime!: EditorLightMarkerRuntime;
  private meshesDisposed = false;
  private trajectoriesDisposed = false;
  private disposed = false;
  private readonly disposedMeshes = new WeakSet<Mesh>();
  private readonly disposedTrajectories = new WeakSet<ConveyorTrajectoryRuntimeEntry>();
  private readonly disposedLights = new WeakSet<Light>();
  private readonly areaLightTransforms = new WeakMap<Light, TransformNode>();

  /** 原始网格先于定位器和模型释放；不提前释放轨迹或灯光。 */
  disposeMeshes(): void {
    if (this.meshesDisposed) return;
    this.meshesDisposed = true;
    for (const [entityId, mesh] of [...this.meshes]) {
      runSceneRuntimeCleanup(this.context, `基础网格 ${entityId}`, () => this.disposeMesh(entityId, mesh));
    }
    this.meshes.clear();
  }

  /** 轨迹在 CAD 后、模型前释放，独立于原始网格阶段。 */
  disposeTrajectories(): void {
    if (this.trajectoriesDisposed) return;
    this.trajectoriesDisposed = true;
    for (const [entityId, trajectory] of [...this.conveyorTrajectories]) {
      runSceneRuntimeCleanup(this.context, `输送线轨迹 ${entityId}`, () => this.disposeConveyorTrajectory(entityId, trajectory));
    }
    this.conveyorTrajectories.clear();
    this._trajectoryVisible = false;
  }

  /** 灯光最后释放；独立调用时兜底前两个阶段，但不接管环境灯光或阴影运行时。 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.disposeMeshes();
    this.disposeTrajectories();
    for (const [entityId, light] of [...this.lights]) {
      runSceneRuntimeCleanup(this.context, `实体灯光 ${entityId}`, () => this.disposeLight(entityId, light));
    }
    this.lights.clear();
    runSceneRuntimeCleanup(this.context, '编辑器灯光标记', () => this.lightMarkerRuntime?.dispose());
  }

  /** 发布 Viewer 在首次同步前永久禁用编辑器专用灯光标记。 */
  disableEditorLightMarkers(): void {
    this.lightMarkerRuntime.disable();
  }

  /** 设置输送线轨迹可视化的全局开关，控制所有已创建轨迹的显示/隐藏。 */
  setTrajectoryVisible(visible: boolean): void {
    if (this.trajectoriesDisposed || this.disposed) return;
    this._trajectoryVisible = visible;
    for (const [entityId, entry] of this.conveyorTrajectories) {
      entry.root.setEnabled(visible && this.dependencies.document.isEntityVisible(entityId));
    }
  }

  /** 同步基础几何体 Mesh 类型、Transform 与选中材质状态。 */
  public syncPrimitiveMeshEntity(entity: Entity, selected: boolean): void {
    if (this.meshesDisposed || this.disposed) return;
    const meshRenderer = entity.components.meshRenderer;
    if (!meshRenderer) return;

    let mesh = this.meshes.get(entity.id);
    if (mesh && mesh.metadata?.editorMeshKind !== meshRenderer.meshKind) {
      this.disposeMesh(entity.id, mesh);
      mesh = undefined;
    }

    if (!mesh) {
      mesh = this.createMesh(entity);
      this.meshes.set(entity.id, mesh);
    }

    this.applyTransform(mesh, entity.components.transform);
    this.applyMeshInteractivity(mesh, entity.id);

    this.dependencies.effects.poiEffectRuntime.withTargetMutation(entity.id, () => this.applyPrimitiveMeshAppearance(mesh, meshRenderer, selected));
    if (entity.components.chartMarker) this.dependencies.effects.chartMarkerPresentation.update(mesh, entity.components.chartMarker, this.dependencies.document.isEntityVisible(entity.id));
    else this.dependencies.effects.chartMarkerPresentation.remove(mesh);
  }

  /** 将大屏缩略图挂到平面材质上；iframe 模式也保留纹理作为 Overlay 加载失败时的底图。 */
  public syncDataPlatformScreenEntity(entity: Entity): void {
    if (this.meshesDisposed || this.disposed) return;
    const screen = entity.components.dataPlatformScreen;
    const mesh = this.meshes.get(entity.id);
    if (!screen || !mesh || mesh.metadata?.editorMeshKind !== 'plane') return;

    // 视频模式保留大屏绑定数据，但不加载或展示其缩略图。
    const thumbnailUrl = entity.components.chartMarker?.contentType === 'video' ? undefined : screen.thumbnailUrl;
    let textureEntry = this.dependencies.effects.dataPlatformScreenTextures.get(entity.id);
    if (textureEntry?.url !== thumbnailUrl) {
      textureEntry?.texture.dispose();
      this.dependencies.effects.dataPlatformScreenTextures.delete(entity.id);
      textureEntry = undefined;
    }
    if (thumbnailUrl && !textureEntry) {
      const texture = new Texture(
        thumbnailUrl,
        this.context.scene,
        true,
        false,
        Texture.TRILINEAR_SAMPLINGMODE,
      );
      textureEntry = { url: thumbnailUrl, texture };
      this.dependencies.effects.dataPlatformScreenTextures.set(entity.id, textureEntry);
    }

    const material = mesh.material instanceof StandardMaterial
      ? mesh.material
      : new StandardMaterial(`${mesh.name}_screen_mat`, this.context.scene);
    material.diffuseTexture = textureEntry?.texture ?? null;
    material.diffuseColor = textureEntry ? Color3.White() : this.readColor('#101827');
    material.emissiveColor = Color3.Black();
    mesh.material = material;
  }

  /** 刷新基础 Mesh 原始材质；选中反馈统一由选择高亮层绘制，不改写模型表面。 */
  public applyPrimitiveMeshAppearance(mesh: Mesh, meshRenderer: MeshRendererComponent, _selected: boolean): void {
    const material = mesh.material instanceof StandardMaterial ? mesh.material : new StandardMaterial(`${mesh.name}_mat`, this.context.scene);
    material.diffuseColor = this.readColor(meshRenderer.materialColor);
    material.emissiveColor = Color3.Black();
    mesh.material = material;
  }

  /** 同步灯光类型、位置/方向、强度及编辑器标记。 */
  public syncLightEntity(entity: Entity, selected: boolean): void {
    if (this.disposed) return;
    const lightComponent = entity.components.light;
    if (!lightComponent) return;

    let light = this.lights.get(entity.id);
    if (light && !this.isLightKind(light, lightComponent.lightKind)) {
      this.disposeLight(entity.id, light);
      light = undefined;
    }

    if (!light) {
      light = this.createLight(entity.id, lightComponent);
      this.lights.set(entity.id, light);
    }

    light.intensity = lightComponent.intensity;
    light.diffuse = Color3.FromHexString(lightComponent.color ?? '#ffffff');
    light.specular = light.diffuse.clone();
    light.range = lightComponent.range ?? Number.MAX_VALUE;
    light.metadata = { ...light.metadata, nightBehavior: lightComponent.nightBehavior ?? 'dim' };
    if (light instanceof HemisphericLight) light.groundColor = Color3.FromHexString(lightComponent.groundColor ?? '#000000');
    if (light instanceof SpotLight) {
      light.angle = lightComponent.angle ?? DEFAULT_SPOT_ANGLE;
      light.exponent = lightComponent.exponent ?? DEFAULT_SPOT_EXPONENT;
    }
    if (light instanceof RectAreaLight) {
      light.width = lightComponent.width ?? DEFAULT_AREA_LIGHT_SIZE;
      light.height = lightComponent.height ?? DEFAULT_AREA_LIGHT_SIZE;
    }
    this.dependencies.transforms.applyLightTransform(light, entity.components.transform);
    this.dependencies.environment.lightRigRuntime.syncEntityLight(entity.id, light, this.dependencies.document.isEntityVisible(entity.id));
    this.dependencies.environment.shadowRuntime.syncLight(entity.id, light);
    this.lightMarkerRuntime.sync(
      entity,
      selected,
      this.dependencies.document.isEntityVisible(entity.id),
      this.dependencies.document.isEntityScenePickable(entity.id),
    );
  }

  /** 按集中米制基准创建内置 Mesh，避免普通实体与模型生成器出现尺寸差异。 */
  public createMesh(entity: Entity): Mesh {
    const meshKind = entity.components.meshRenderer?.meshKind ?? 'cube';

    if (meshKind === 'sphere') {
      const mesh = MeshBuilder.CreateSphere(entity.id, { diameter: BUILT_IN_SPHERE_DIAMETER_METERS }, this.context.scene);
      mesh.metadata = { ...(mesh.metadata ?? {}), editorMeshKind: meshKind, editorEntityId: entity.id };
      return mesh;
    }

    if (meshKind === 'plane') {
      const mesh = MeshBuilder.CreateGround(
        entity.id,
        { width: BUILT_IN_PLANE_SIZE_METERS, height: BUILT_IN_PLANE_SIZE_METERS },
        this.context.scene,
      );
      mesh.metadata = { ...(mesh.metadata ?? {}), editorMeshKind: meshKind, editorEntityId: entity.id };
      return mesh;
    }

    const mesh = MeshBuilder.CreateBox(entity.id, { size: BUILT_IN_BOX_SIZE_METERS }, this.context.scene);
    mesh.metadata = { ...(mesh.metadata ?? {}), editorMeshKind: meshKind, editorEntityId: entity.id };
    return mesh;
  }

  /** 根据组件类型创建对应 Babylon Light。 */
  public createLight(entityId: string, light: LightComponent): Light {
    if (light.lightKind === 'directional') {
      return new DirectionalLight(entityId, new Vector3(0, -1, 0), this.context.scene);
    }

    if (light.lightKind === 'point') {
      const point = new PointLight(entityId, Vector3.Zero(), this.context.scene);
      // 编辑强度与照射范围使用统一衰减，避免 PBR 将低数值强度按物理单位衰减到不可见。
      point.falloffType = Light.FALLOFF_STANDARD;
      return point;
    }

    if (light.lightKind === 'spot') {
      const spot = new SpotLight(entityId, Vector3.Zero(), Vector3.Down(),
        light.angle ?? DEFAULT_SPOT_ANGLE, light.exponent ?? DEFAULT_SPOT_EXPONENT, this.context.scene);
      spot.falloffType = Light.FALLOFF_STANDARD;
      return spot;
    }
    if (light.lightKind === 'rectArea') {
      ensureLocalAreaLightTextures(this.context.scene);
      const area = new RectAreaLight(entityId, Vector3.Zero(), light.width ?? DEFAULT_AREA_LIGHT_SIZE,
        light.height ?? DEFAULT_AREA_LIGHT_SIZE, this.context.scene);
      const areaTransform = new TransformNode(`${entityId}_areaLightTransform`, this.context.scene);
      area.parent = areaTransform;
      this.areaLightTransforms.set(area, areaTransform);
      return area;
    }

    return new HemisphericLight(entityId, new Vector3(0, 1, 0), this.context.scene);
  }

  /** 释放实体对应的 Mesh 与材质资源。 */
  public disposeMesh(entityId: string, mesh: Mesh): void {
    if (this.disposedMeshes.has(mesh)) return;
    this.disposedMeshes.add(mesh);
    if (this.meshes.get(entityId) === mesh) this.meshes.delete(entityId);
    runSceneRuntimeCleanup(this.context, `立标辅助资源 ${entityId}`, () => this.dependencies.effects.chartMarkerPresentation.remove(mesh));
    runSceneRuntimeCleanup(this.context, `基础网格阵列预览 ${entityId}`, () => this.dependencies.transforms.clearEntityArrayPreviewIfSource(entityId));
    // 大屏纹理由 effects 持有，材质释放不能连带销毁纹理。
    runSceneRuntimeCleanup(this.context, `基础网格材质 ${entityId}`, () => mesh.material?.dispose());
    runSceneRuntimeCleanup(this.context, `基础网格节点 ${entityId}`, () => mesh.dispose());
  }

  // ===== 输送线轨迹可视化 =====

  /** 同步输送线轨迹：conveyor 且模型就绪时创建（trajectoryDirection 缺省按 'x'），反之释放。 */
  public syncConveyorTrajectory(entity: Entity, model: ModelRuntimeEntry | null): void {
    if (this.trajectoriesDisposed || this.disposed) return;
    const binding = entity.components.telemetryBinding;
    const enabled = Boolean(
      binding
      && binding.deviceType === 'conveyor'
      && model?.assetHandle
      && model.measurementReady,
    );
    if (!enabled || !model) {
      const existing = this.conveyorTrajectories.get(entity.id);
      if (existing) this.disposeConveyorTrajectory(entity.id, existing);
      return;
    }

    const context = this.resolveConveyorTrajectoryContext(entity, model);
    const signature = this.createConveyorTrajectorySignature(entity, context);
    const existing = this.conveyorTrajectories.get(entity.id);
    if (existing && existing.signature === signature) {
      // 轨迹挂独立根节点（阵列源模型 root 会被合批挂起禁用），实体移动/显隐变化只刷新根节点。
      this.refreshConveyorTrajectoryRoot(entity, existing.root);
      return;
    }
    if (existing) this.disposeConveyorTrajectory(entity.id, existing);
    this.createConveyorTrajectory(entity, context, signature);
  }

  /** 轨迹根的变换与显隐：跟随实体 Transform、实体可见性与全局开关。 */
  public refreshConveyorTrajectoryRoot(entity: Entity, root: TransformNode): void {
    this.applyTransform(root, entity.components.transform);
    root.setEnabled(this._trajectoryVisible && this.dependencies.document.isEntityVisible(entity.id));
  }

  /** 同步某源模型全部阵列实例的输送线轨迹：几何取自实例所在批次（参数变体或源模型）。 */
  public syncConveyorTrajectoriesForArrayInstances(sourceEntityId: string): void {
    for (const instanceEntity of this.dependencies.arrays.modelArrayInstanceEntities.values()) {
      const instance = instanceEntity.components.modelArrayInstance;
      if (!instance || instance.sourceEntityId !== sourceEntityId) continue;
      const variant = this.dependencies.variants.modelArrayParameterVariantByEntityId.get(instanceEntity.id);
      const model = variant?.model ?? this.dependencies.assets.models.get(instance.sourceEntityId) ?? null;
      this.syncConveyorTrajectory(instanceEntity, model);
    }
  }

  public createConveyorTrajectorySignature(entity: Entity, context: ConveyorTrajectoryContext): string {
    const round = (v: Vector3) => `${v.x.toFixed(4)},${v.y.toFixed(4)},${v.z.toFixed(4)}`;
    return JSON.stringify([
      entity.components.telemetryBinding?.trajectoryDirection ?? 'x',
      context.travelAxisName,
      round(context.centerLocal),
      context.spanMeters.toFixed(4),
      context.surfaceYLocal.toFixed(4),
    ]);
  }

  /** 与 conveyorDriver 同源的行程计算：cargo.travel 配置行走轴 + 包围盒投影，转模型局部空间。 */
  public resolveConveyorTrajectoryContext(entity: Entity, model: ModelRuntimeEntry): ConveyorTrajectoryContext {
    const travelConfig = readConveyorCargoTravelConfig(model);
    const travelAxisName = travelConfig.axis;
    const configuredNodes = this.findEditorConveyorMotionNodes(model, travelConfig);
    const conveyorNodes = configuredNodes.length > 0
      ? configuredNodes
      : findModelNodes(model, this.context.scene, /conveyor|roller|chain|rail|GT|输送|滚筒|链条|轨道/i);
    const bounds = (conveyorNodes.length > 0 ? getNodesWorldBounds(conveyorNodes) : null)
      ?? this.dependencies.bounds.getModelWorldBounds(model);
    if (!bounds) {
      return { centerLocal: Vector3.Zero(), travelAxisName, travelAxisWorld: Vector3.Right(), spanMeters: 0, surfaceYLocal: 0 };
    }
    const center = bounds.minimum.add(bounds.maximum).scale(0.5);
    const travelAxisWorld = getHorizontalModelAxis(model.root, travelAxisName);
    const projected = projectWorldBoundsOntoAxis(bounds, travelAxisWorld);
    const spanMeters = Math.max(0, projected.max - projected.min);

    model.root.computeWorldMatrix(true);
    const rootWorldInverse = model.root.getWorldMatrix().clone();
    rootWorldInverse.invert();
    const centerLocal = Vector3.TransformCoordinates(center, rootWorldInverse);
    // 与 conveyorDriver.resolveConveyorCargoTravelContext 同源：包围盒沿竖直轴投影最高点 + cargo.surfaceOffset。
    const upAxisWorld = getModelAxis(model.root, 'y');
    const liftWorld = projectWorldBoundsOntoAxis(bounds, upAxisWorld).max
      - Vector3.Dot(center, upAxisWorld)
      + readConveyorCargoSurfaceOffset(model);
    const surfaceYLocal = Vector3.TransformCoordinates(center.add(upAxisWorld.scale(liftWorld)), rootWorldInverse).y;
    return { centerLocal, travelAxisName, travelAxisWorld, spanMeters, surfaceYLocal };
  }

  public findEditorConveyorMotionNodes(model: ModelRuntimeEntry, config: ConveyorCargoTravelConfig): TransformNode[] {
    if (config.nodes.length > 0) {
      return filterTopLevelMotionNodes(findModelNodesByName(model, this.context.scene, config.nodes));
    }
    if (config.fallbackPattern) {
      let pattern: RegExp | null;
      try { pattern = new RegExp(config.fallbackPattern, 'i'); } catch { pattern = null; }
      return pattern ? filterTopLevelMotionNodes(findModelNodes(model, this.context.scene, pattern)) : [];
    }
    return [];
  }

  /** 创建轨迹虚线 + 方向箭头；全部网格非拾取，挂独立根节点（阵列源模型 root 会被合批挂起禁用）。 */
  public createConveyorTrajectory(entity: Entity, context: ConveyorTrajectoryContext, signature: string): void {
    if (this.trajectoriesDisposed || this.disposed || context.spanMeters <= 0.001) return;

    const half = context.spanMeters / 2;
    const baseY = context.surfaceYLocal;
    const startBase = context.centerLocal.subtract(createLocalAxis(context.travelAxisName).scale(half));
    const endBase = context.centerLocal.add(createLocalAxis(context.travelAxisName).scale(half));
    const start = new Vector3(startBase.x, baseY, startBase.z);
    const end = new Vector3(endBase.x, baseY, endBase.z);

    const root = new TransformNode(`${entity.id}_conveyorTrajectoryRoot`, this.context.scene);
    this.refreshConveyorTrajectoryRoot(entity, root);

    // 流光渐变：颜色表沿虚线均匀分布（COLOR_DISTRIBUTION_TYPE_LINE），每帧滚动相位形成
    // 从起点流向终点的亮度波；箭头按各自在线上的位置同步脉冲。base 为暗部亮度。
    const flowSteps = 64;
    const flowBaseIntensity = 0.2;
    const flowSpeed = 1.0; // m/s，亮度波推进速度
    const flowColors: Color3[] = [];
    for (let i = 0; i < flowSteps; i += 1) flowColors.push(Color3.White());

    const dashCount = clampNumber(Math.round(context.spanMeters / 1.2), 2, 12);
    const line = CreateGreasedLine(
      `${entity.id}_conveyorTrajectoryLine`,
      { points: [start, end], updatable: false },
      {
        materialType: GreasedLineMeshMaterialType.MATERIAL_TYPE_SIMPLE,
        color: Color3.White(),
        width: 0.035,
        sizeAttenuation: false,
        useDash: true,
        dashCount,
        dashRatio: 0.45,
        useColors: true,
        colors: flowColors,
        colorDistributionType: GreasedLineMeshColorDistributionType.COLOR_DISTRIBUTION_TYPE_LINE,
      },
      this.context.scene,
    );
    line.parent = root;
    line.isPickable = false;

    // trajectoryDirection 为模型本地坐标：与本地行走轴点积判定箭头/流光是否翻转。
    const trajectoryDirLocal = this.readTrajectoryLocalDirection(entity.components.telemetryBinding?.trajectoryDirection ?? 'x');
    const localDir = normalizeVector(end.subtract(start), createLocalAxis(context.travelAxisName));
    const flip = Vector3.Dot(trajectoryDirLocal, localDir) < 0;
    const arrowDir = flip ? localDir.scale(-1) : localDir;
    const dot = Vector3.Dot(new Vector3(1, 0, 0), arrowDir);
    const cross = Vector3.Cross(new Vector3(1, 0, 0), arrowDir);
    const arrowQuat = cross.lengthSquared() < 0.0001
      ? (dot < 0 ? Quaternion.RotationAxis(new Vector3(0, 1, 0), Math.PI) : Quaternion.Identity())
      : Quaternion.RotationAxis(cross, Math.acos(clampNumber(dot, -1, 1)));

    // 平面 › 形箭头：两片扁盒从尖端向后张开，无柄无锥头；每臂独立材质以支持脉冲亮度。
    const chevronAngle = Math.PI / 4.5;
    const chevronArmLength = 0.26;
    const arrowCount = clampNumber(Math.round(context.spanMeters / 3), 2, 5);
    const arrowMeshes: Mesh[] = [];
    const arrowMaterials: StandardMaterial[] = [];
    for (let i = 0; i < arrowCount; i += 1) {
      const t = (i + 1) / (arrowCount + 1);
      const arrowRoot = new TransformNode(`${entity.id}_conveyorTrajectoryArrow_${i}`, this.context.scene);
      arrowRoot.parent = root;
      arrowRoot.position = Vector3.Lerp(start, end, t);
      arrowRoot.rotationQuaternion = arrowQuat;

      for (const side of [-1, 1]) {
        const arm = MeshBuilder.CreateBox(
          `${arrowRoot.name}_arm_${side}`,
          { width: chevronArmLength, height: 0.015, depth: 0.035 },
          this.context.scene,
        );
        arm.parent = arrowRoot;
        arm.rotation.y = -side * (Math.PI - chevronAngle);
        arm.position = new Vector3(
          -Math.cos(chevronAngle) * chevronArmLength * 0.5,
          0,
          side * Math.sin(chevronAngle) * chevronArmLength * 0.5,
        );
        const armMaterial = new StandardMaterial(`${arrowRoot.name}_armMat_${side}`, this.context.scene);
        armMaterial.diffuseColor = Color3.White();
        armMaterial.emissiveColor = Color3.White();
        armMaterial.disableLighting = true;
        armMaterial.alpha = 0.9;
        armMaterial.backFaceCulling = false;
        armMaterial.disableDepthWrite = true;
        arm.material = armMaterial;
        arm.isPickable = false;
        arrowMeshes.push(arm);
        arrowMaterials.push(armMaterial);
      }
    }

    // phase ∈ [0,1] 为沿货物流向的归一化位置，time 为当前波相位；波头最亮向后衰减。
    const flowIntensity = (phase: number, time: number): number => {
      const d = phase - time;
      const f = d - Math.floor(d);
      const pulse = Math.pow(1 - f, 3);
      return flowBaseIntensity + (1 - flowBaseIntensity) * pulse;
    };
    const updateFlow = (time: number): void => {
      for (let i = 0; i < flowSteps; i += 1) {
        const phase = i / (flowSteps - 1);
        const v = flowIntensity(flip ? 1 - phase : phase, time);
        flowColors[i].set(v, v, v);
      }
      (line.material as GreasedLineSimpleMaterial).setColors(flowColors);
      for (let i = 0; i < arrowCount; i += 1) {
        const t = (i + 1) / (arrowCount + 1);
        const v = flowIntensity(flip ? 1 - t : t, time);
        arrowMaterials[i * 2].emissiveColor.set(v, v, v);
        arrowMaterials[i * 2 + 1].emissiveColor.set(v, v, v);
      }
    };
    updateFlow(0);

    let flowTime = 0;
    const flowObserver = this.context.scene.onBeforeRenderObservable.add(() => {
      if (this.trajectoriesDisposed || root.isDisposed() || this.conveyorTrajectories.get(entity.id)?.root !== root || !root.isEnabled()) return;
      const dtSeconds = this.context.scene.getEngine().getDeltaTime() / 1000;
      flowTime = (flowTime + (dtSeconds * flowSpeed) / context.spanMeters) % 1;
      updateFlow(flowTime);
    });

    this.conveyorTrajectories.set(entity.id, {
      signature,
      root,
      lineMeshes: [line],
      arrowMeshes,
      arrowMaterials,
      flowObserver,
    });
  }

  /** trajectoryDirection 配置值转模型本地坐标向量（与 conveyorDriver 的本地语义一致）。 */
  public readTrajectoryLocalDirection(direction: string): Vector3 {
    if (direction === '-x') return new Vector3(-1, 0, 0);
    if (direction === 'z') return new Vector3(0, 0, 1);
    if (direction === '-z') return new Vector3(0, 0, -1);
    return new Vector3(1, 0, 0);
  }

  public disposeConveyorTrajectory(entityId: string, entry: ConveyorTrajectoryRuntimeEntry): void {
    if (this.disposedTrajectories.has(entry)) return;
    this.disposedTrajectories.add(entry);
    if (this.conveyorTrajectories.get(entityId) === entry) this.conveyorTrajectories.delete(entityId);
    runSceneRuntimeCleanup(this.context, `轨迹帧回调 ${entityId}`, () => this.context.scene.onBeforeRenderObservable.remove(entry.flowObserver));
    for (const [index, lineMesh] of entry.lineMeshes.entries()) {
      runSceneRuntimeCleanup(this.context, `轨迹线材质 ${entityId}/${index}`, () => lineMesh.material?.dispose(false, true));
      runSceneRuntimeCleanup(this.context, `轨迹线网格 ${entityId}/${index}`, () => lineMesh.dispose(false, false));
    }
    for (const [index, mesh] of entry.arrowMeshes.entries()) {
      runSceneRuntimeCleanup(this.context, `轨迹箭头 ${entityId}/${index}`, () => mesh.dispose());
    }
    for (const [index, material] of entry.arrowMaterials.entries()) {
      runSceneRuntimeCleanup(this.context, `轨迹箭头材质 ${entityId}/${index}`, () => material.dispose());
    }
    runSceneRuntimeCleanup(this.context, `轨迹根节点 ${entityId}`, () => entry.root.dispose());
  }

  public disposeLight(entityId: string, light: Light): void {
    if (this.disposedLights.has(light)) return;
    this.disposedLights.add(light);
    if (this.lights.get(entityId) === light) this.lights.delete(entityId);
    runSceneRuntimeCleanup(this.context, `实体灯光阴影 ${entityId}`, () => this.dependencies.environment.shadowRuntime.removeLight(entityId));
    runSceneRuntimeCleanup(this.context, `实体灯光标记 ${entityId}`, () => this.lightMarkerRuntime?.disposeEntity(entityId));
    // 只释放本领域为面光源创建的节点，不能把后来借用的 parent 当作自有资源。
    const areaTransform = this.areaLightTransforms.get(light);
    this.areaLightTransforms.delete(light);
    runSceneRuntimeCleanup(this.context, `实体灯光节点 ${entityId}`, () => light.dispose());
    runSceneRuntimeCleanup(this.context, `面光源变换节点 ${entityId}`, () => areaTransform?.dispose(true));
  }

  /** 将显隐和锁定状态应用到可拾取 Mesh。 */
  public applyMeshInteractivity(mesh: AbstractMesh, entityId: string): void {
    const visible = this.dependencies.document.isEntityVisible(entityId);
    mesh.isVisible = visible;
    mesh.isPickable = visible && this.dependencies.document.isEntityScenePickable(entityId);
  }

  /** 读取材质颜色，非法颜色回退到默认编辑器颜色。 */
  public readColor(hexColor: string): Color3 {
    try {
      return Color3.FromHexString(hexColor);
    } catch {
      return Color3.FromHexString(FALLBACK_MATERIAL_COLOR);
    }
  }

  /** 将编辑器 Transform 写入 Babylon 节点。 */
  public applyTransform(target: AbstractMesh | TransformNode, transform: TransformComponent): void {
    target.position = new Vector3(transform.position.x, transform.position.y, transform.position.z);
    target.rotationQuaternion = null;
    target.rotation = new Vector3(transform.rotation.x, transform.rotation.y, transform.rotation.z);
    target.scaling = new Vector3(transform.scale.x, transform.scale.y, transform.scale.z);
  }

  /** 从 Transform 位置生成向量，零向量时回退到默认值。 */
  public vectorFromTransformPosition(transform: TransformComponent, fallback: Vector3): Vector3 {
    const vector = new Vector3(transform.position.x, transform.position.y, transform.position.z);
    return vector.lengthSquared() > 0 ? vector : fallback;
  }

  /** 使用实体旋转估算 DirectionalLight 方向。 */
  public directionFromRotation(transform: TransformComponent): Vector3 {
    const direction = new Vector3(0, -1, 0);
    const matrix = Matrix.RotationYawPitchRoll(transform.rotation.y, transform.rotation.x, transform.rotation.z);
    return Vector3.TransformNormal(direction, matrix).normalize();
  }

  /** 判断已存在灯光是否仍匹配组件要求的灯光类型。 */
  public isLightKind(light: Light, lightKind: LightComponent['lightKind']): boolean {
    return (
      (lightKind === 'hemispheric' && light instanceof HemisphericLight) ||
      (lightKind === 'directional' && light instanceof DirectionalLight) ||
      (lightKind === 'point' && light instanceof PointLight) ||
      (lightKind === 'spot' && light instanceof SpotLight) ||
      (lightKind === 'rectArea' && light instanceof RectAreaLight)
    );
  }
  /** 按原构造顺序连接此领域的资源与回调。 */
  initializeLightMarkerRuntime(): void {
    if (this.disposed || this.lightMarkerRuntime) return;
    this.lightMarkerRuntime = new EditorLightMarkerRuntime(this.context.scene);
  }

}
