import '@babylonjs/loaders';
import {
  AbstractMesh,
  AssetContainer,
  Color3,
  DirectionalLight,
  HemisphericLight,
  HighlightLayer,
  Light,
  Matrix,
  Mesh,
  MeshBuilder,
  Plane,
  PointLight,
  Scene,
  SceneLoader,
  StandardMaterial,
  TransformNode,
  Vector3,
} from '@babylonjs/core';
import type { Entity } from '../../editor/model/Entity';
import type { LightComponent, TransformComponent } from '../../editor/model/components';
import type { Vector3Data } from '../../editor/model/math';
import type { SceneDocument } from '../../editor/model/SceneDocument';

const SELECTED_MATERIAL_COLOR = '#f7d774';
const SELECTED_EMISSIVE_COLOR = '#332400';
const FALLBACK_MATERIAL_COLOR = '#8ab4f8';
const EDITOR_ENTITY_ID_METADATA_KEY = 'editorEntityId';

type EditorMeshMetadata = {
  [EDITOR_ENTITY_ID_METADATA_KEY]?: unknown;
};

type ModelRuntimeEntry = {
  sourceUrl: string;
  root: TransformNode;
  container: AssetContainer | null;
  meshes: AbstractMesh[];
  highlighted: boolean;
  loadToken: number;
};

export class SceneRuntime {
  private readonly meshes = new Map<string, Mesh>();
  private readonly models = new Map<string, ModelRuntimeEntry>();
  private readonly lights = new Map<string, Light>();
  private readonly modelHighlightLayer: HighlightLayer;
  private modelLoadSequence = 0;

  constructor(private readonly scene: Scene) {
    this.modelHighlightLayer = new HighlightLayer('EditorModelHighlightLayer', scene);
  }

  /** 根据实体 ID 获取当前运行时中可被 Gizmo 绑定的 Babylon 节点。 */
  getGizmoTargetByEntityId(entityId: string | null): AbstractMesh | TransformNode | null {
    if (!entityId) return null;
    return this.meshes.get(entityId) ?? this.models.get(entityId)?.root ?? null;
  }

  /** 在画布客户端坐标位置拾取可编辑 Mesh，并返回对应实体 ID。 */
  pickEntityIdAtCanvasPoint(clientX: number, clientY: number, canvas: HTMLCanvasElement): string | null {
    const point = this.getCanvasPickPoint(clientX, clientY, canvas);
    if (!point) return null;

    const picked = this.scene.pick(point.x, point.y, (mesh) => this.readEntityIdFromMesh(mesh) !== null);

    return this.readEntityIdFromMesh(picked?.pickedMesh ?? null);
  }

  /** 将画布客户端坐标投射到世界 y=0 地面平面，用于拖拽释放时按鼠标位置放置模型。 */
  getGroundPointAtCanvasPoint(clientX: number, clientY: number, canvas: HTMLCanvasElement): Vector3Data | null {
    const point = this.getCanvasPickPoint(clientX, clientY, canvas);
    const camera = this.scene.activeCamera;
    if (!point || !camera) return null;

    const ray = this.scene.createPickingRay(point.x, point.y, Matrix.Identity(), camera);
    const groundPlane = Plane.FromPositionAndNormal(Vector3.Zero(), Vector3.Up());
    const distance = ray.intersectsPlane(groundPlane);
    if (distance === null || !Number.isFinite(distance) || distance < 0) return null;

    const hitPoint = ray.origin.add(ray.direction.scale(distance));
    if (!Number.isFinite(hitPoint.x) || !Number.isFinite(hitPoint.y) || !Number.isFinite(hitPoint.z)) return null;

    return { x: hitPoint.x, y: 0, z: hitPoint.z };
  }

  /** 将浏览器客户端坐标转换为 Babylon 画布内拾取坐标，并过滤画布外输入。 */
  private getCanvasPickPoint(clientX: number, clientY: number, canvas: HTMLCanvasElement): { x: number; y: number } | null {
    const rect = canvas.getBoundingClientRect();
    if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) {
      return null;
    }

    return {
      x: clientX - rect.left,
      y: clientY - rect.top,
    };
  }

  /** 将编辑器文档同步到 Babylon 运行时场景。 */
  sync(document: SceneDocument): void {
    const primitiveMeshIds = new Set(
      document.entityIds.filter((entityId) => Boolean(document.entities[entityId]?.components.meshRenderer)),
    );
    const modelIds = new Set(
      document.entityIds.filter((entityId) => Boolean(document.entities[entityId]?.components.modelAsset)),
    );
    const lightIds = new Set(
      document.entityIds.filter((entityId) => Boolean(document.entities[entityId]?.components.light)),
    );

    for (const [entityId, mesh] of this.meshes.entries()) {
      if (!primitiveMeshIds.has(entityId)) {
        this.disposeMesh(entityId, mesh);
      }
    }

    for (const [entityId, model] of this.models.entries()) {
      if (!modelIds.has(entityId)) {
        this.disposeModel(entityId, model);
      }
    }

    for (const [entityId, light] of this.lights.entries()) {
      if (!lightIds.has(entityId)) {
        this.disposeLight(entityId, light);
      }
    }

    for (const entityId of document.entityIds) {
      const entity = document.entities[entityId];
      if (!entity) continue;

      this.syncEntity(entity, entityId === document.selectedEntityId);
    }
  }

  dispose(): void {
    for (const [entityId, mesh] of this.meshes.entries()) {
      this.disposeMesh(entityId, mesh);
    }
    for (const [entityId, model] of this.models.entries()) {
      this.disposeModel(entityId, model);
    }
    for (const [entityId, light] of this.lights.entries()) {
      this.disposeLight(entityId, light);
    }
    this.modelHighlightLayer.dispose();
    this.meshes.clear();
    this.models.clear();
    this.lights.clear();
  }

  /** 按组件类型同步单个实体的运行时表现。 */
  private syncEntity(entity: Entity, selected: boolean): void {
    if (entity.components.meshRenderer) {
      this.syncPrimitiveMeshEntity(entity, selected);
    }

    if (entity.components.modelAsset) {
      this.syncModelEntity(entity, selected);
    }

    if (entity.components.light) {
      this.syncLightEntity(entity);
    }
  }

  /** 同步基础几何体 Mesh 类型、Transform 与选中材质状态。 */
  private syncPrimitiveMeshEntity(entity: Entity, selected: boolean): void {
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

    const material = mesh.material instanceof StandardMaterial ? mesh.material : new StandardMaterial(`${entity.id}_mat`, this.scene);
    material.diffuseColor = selected ? Color3.FromHexString(SELECTED_MATERIAL_COLOR) : this.readColor(meshRenderer.materialColor);
    material.emissiveColor = selected ? Color3.FromHexString(SELECTED_EMISSIVE_COLOR) : Color3.Black();
    mesh.material = material;
  }

  /** 同步 glTF/GLB 模型资源，并通过加载 token 避免异步过期结果污染当前场景。 */
  private syncModelEntity(entity: Entity, selected: boolean): void {
    const modelAsset = entity.components.modelAsset;
    if (!modelAsset) return;

    const existing = this.models.get(entity.id);
    if (existing && existing.sourceUrl !== modelAsset.sourceUrl) {
      this.disposeModel(entity.id, existing);
    }

    const current = this.models.get(entity.id);
    if (current) {
      this.applyModelTransform(current.root, entity.components.transform, modelAsset.unitScaleToMeters);
      this.applyModelSelection(current, selected);
      return;
    }

    const root = new TransformNode(`${entity.id}_modelRoot`, this.scene);
    this.applyModelTransform(root, entity.components.transform, modelAsset.unitScaleToMeters);

    const loadToken = ++this.modelLoadSequence;
    const pending: ModelRuntimeEntry = {
      sourceUrl: modelAsset.sourceUrl,
      root,
      container: null,
      meshes: [],
      highlighted: false,
      loadToken,
    };
    this.models.set(entity.id, pending);

    const { rootUrl, fileName } = this.splitAssetUrl(modelAsset.sourceUrl);

    void SceneLoader.LoadAssetContainerAsync(rootUrl, fileName, this.scene)
      .then((container) => {
        const activeEntry = this.models.get(entity.id);
        if (!activeEntry || activeEntry.loadToken !== loadToken || activeEntry.sourceUrl !== modelAsset.sourceUrl) {
          container.dispose();
          return;
        }

        container.addAllToScene();
        activeEntry.container = container;
        activeEntry.meshes = container.meshes;
        this.parentTopLevelModelNodes(activeEntry);
        this.normalizeModelContentOrigin(activeEntry);

        for (const mesh of activeEntry.meshes) {
          mesh.metadata = { ...(mesh.metadata ?? {}), [EDITOR_ENTITY_ID_METADATA_KEY]: entity.id };
        }
        this.applyModelSelection(activeEntry, selected);
      })
      .catch(() => {
        const activeEntry = this.models.get(entity.id);
        if (activeEntry?.loadToken === loadToken) {
          this.disposeModel(entity.id, activeEntry);
        }
      });
  }

  /** 同步灯光类型、位置/方向和强度。 */
  private syncLightEntity(entity: Entity): void {
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

    const transform = entity.components.transform;
    if (light instanceof HemisphericLight) {
      light.direction = this.vectorFromTransformPosition(transform, new Vector3(0, 1, 0));
      return;
    }

    if (light instanceof DirectionalLight) {
      light.position = this.vectorFromTransformPosition(transform, Vector3.Zero());
      light.direction = this.directionFromRotation(transform);
      return;
    }

    if (light instanceof PointLight) {
      light.position = this.vectorFromTransformPosition(transform, Vector3.Zero());
    }
  }

  /** 根据实体的 MeshRenderer 创建运行时 Mesh，并写入编辑器拾取元数据。 */
  private createMesh(entity: Entity): Mesh {
    const meshKind = entity.components.meshRenderer?.meshKind ?? 'cube';

    if (meshKind === 'sphere') {
      const mesh = MeshBuilder.CreateSphere(entity.id, { diameter: 1 }, this.scene);
      mesh.metadata = { ...(mesh.metadata ?? {}), editorMeshKind: meshKind, editorEntityId: entity.id };
      return mesh;
    }

    if (meshKind === 'plane') {
      const mesh = MeshBuilder.CreateGround(entity.id, { width: 2, height: 2 }, this.scene);
      mesh.metadata = { ...(mesh.metadata ?? {}), editorMeshKind: meshKind, editorEntityId: entity.id };
      return mesh;
    }

    const mesh = MeshBuilder.CreateBox(entity.id, { size: 1 }, this.scene);
    mesh.metadata = { ...(mesh.metadata ?? {}), editorMeshKind: meshKind, editorEntityId: entity.id };
    return mesh;
  }

  /** 根据组件类型创建对应 Babylon Light。 */
  private createLight(entityId: string, light: LightComponent): Light {
    if (light.lightKind === 'directional') {
      return new DirectionalLight(entityId, new Vector3(0, -1, 0), this.scene);
    }

    if (light.lightKind === 'point') {
      return new PointLight(entityId, Vector3.Zero(), this.scene);
    }

    return new HemisphericLight(entityId, new Vector3(0, 1, 0), this.scene);
  }

  /** 释放实体对应的 Mesh 与材质资源。 */
  private disposeMesh(entityId: string, mesh: Mesh): void {
    mesh.material?.dispose();
    mesh.dispose();
    this.meshes.delete(entityId);
  }

  /** 释放导入模型的容器、根节点与所有子资源。 */
  private disposeModel(entityId: string, model: ModelRuntimeEntry): void {
    this.applyModelSelection(model, false);
    model.container?.dispose();
    model.root.dispose();
    this.models.delete(entityId);
  }

  /** 释放灯光资源。 */
  private disposeLight(entityId: string, light: Light): void {
    light.dispose();
    this.lights.delete(entityId);
  }

  /** 从 Mesh 元数据中读取编辑器实体 ID。 */
  private readEntityIdFromMesh(mesh: AbstractMesh | null): string | null {
    const metadata = mesh?.metadata as EditorMeshMetadata | null | undefined;
    const entityId = metadata?.[EDITOR_ENTITY_ID_METADATA_KEY];

    return typeof entityId === 'string' && (this.meshes.has(entityId) || this.models.has(entityId)) ? entityId : null;
  }

  /** 读取材质颜色，非法颜色回退到默认编辑器颜色。 */
  private readColor(hexColor: string): Color3 {
    try {
      return Color3.FromHexString(hexColor);
    } catch {
      return Color3.FromHexString(FALLBACK_MATERIAL_COLOR);
    }
  }

  /** 将编辑器 Transform 写入 Babylon 节点。 */
  private applyTransform(target: AbstractMesh | TransformNode, transform: TransformComponent): void {
    target.position = new Vector3(transform.position.x, transform.position.y, transform.position.z);
    target.rotation = new Vector3(transform.rotation.x, transform.rotation.y, transform.rotation.z);
    target.scaling = new Vector3(transform.scale.x, transform.scale.y, transform.scale.z);
  }

  /** 将导入模型源单位换算到米，再叠加用户 Transform 缩放。 */
  private applyModelTransform(target: TransformNode, transform: TransformComponent, unitScaleToMeters: number): void {
    target.position = new Vector3(transform.position.x, transform.position.y, transform.position.z);
    target.rotation = new Vector3(transform.rotation.x, transform.rotation.y, transform.rotation.z);
    target.scaling = new Vector3(
      transform.scale.x * unitScaleToMeters,
      transform.scale.y * unitScaleToMeters,
      transform.scale.z * unitScaleToMeters,
    );
  }

  /** 根据选中状态给导入模型添加或移除 HighlightLayer 高亮，不破坏原始材质。 */
  private applyModelSelection(model: ModelRuntimeEntry, selected: boolean): void {
    if (model.highlighted === selected) return;

    for (const mesh of model.meshes) {
      if (!(mesh instanceof Mesh)) continue;

      if (selected) {
        this.modelHighlightLayer.addMesh(mesh, Color3.FromHexString(SELECTED_MATERIAL_COLOR));
      } else {
        this.modelHighlightLayer.removeMesh(mesh);
      }
    }

    model.highlighted = selected;
  }

  /** 仅把 glTF 顶层节点挂到编辑器根节点，保留模型内部层级、骨骼和动画关系。 */
  private parentTopLevelModelNodes(model: ModelRuntimeEntry): void {
    const transformNodes = model.container?.transformNodes ?? [];
    const allImportedNodes = new Set([...model.meshes, ...transformNodes]);

    for (const node of allImportedNodes) {
      if (!node.parent || !allImportedNodes.has(node.parent as AbstractMesh | TransformNode)) {
        node.parent = model.root;
      }
    }
  }

  /** 将导入模型内容的底部中心归一到实体根节点，避免源模型巨大坐标偏移影响场景放置。 */
  private normalizeModelContentOrigin(model: ModelRuntimeEntry): void {
    model.root.computeWorldMatrix(true);

    const childMeshes = model.root.getChildMeshes(false);
    if (childMeshes.length === 0) return;

    let minimum = new Vector3(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);
    let maximum = new Vector3(Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY);

    for (const mesh of childMeshes) {
      mesh.computeWorldMatrix(true);
      const boundingInfo = mesh.getBoundingInfo();
      minimum = Vector3.Minimize(minimum, boundingInfo.boundingBox.minimumWorld);
      maximum = Vector3.Maximize(maximum, boundingInfo.boundingBox.maximumWorld);
    }

    if (!Number.isFinite(minimum.x) || !Number.isFinite(minimum.y) || !Number.isFinite(minimum.z)) return;
    if (!Number.isFinite(maximum.x) || !Number.isFinite(maximum.y) || !Number.isFinite(maximum.z)) return;

    const bottomCenter = new Vector3(
      (minimum.x + maximum.x) / 2,
      minimum.y,
      (minimum.z + maximum.z) / 2,
    );
    const inverseRootMatrix = model.root.getWorldMatrix().clone().invert();
    const localBottomCenter = Vector3.TransformCoordinates(bottomCenter, inverseRootMatrix);

    for (const child of model.root.getChildren()) {
      if (child instanceof TransformNode) {
        child.position.subtractInPlace(localBottomCenter);
      }
    }
  }

  /** 把完整资源 URL 拆成 Babylon SceneLoader 需要的 rootUrl 和 fileName。 */
  private splitAssetUrl(sourceUrl: string): { rootUrl: string; fileName: string } {
    const lastSlashIndex = sourceUrl.lastIndexOf('/');
    if (lastSlashIndex < 0) {
      return { rootUrl: '', fileName: sourceUrl };
    }

    return {
      rootUrl: sourceUrl.slice(0, lastSlashIndex + 1),
      fileName: sourceUrl.slice(lastSlashIndex + 1),
    };
  }

  /** 从 Transform 位置生成向量，零向量时回退到默认值。 */
  private vectorFromTransformPosition(transform: TransformComponent, fallback: Vector3): Vector3 {
    const vector = new Vector3(transform.position.x, transform.position.y, transform.position.z);
    return vector.lengthSquared() > 0 ? vector : fallback;
  }

  /** 使用实体旋转估算 DirectionalLight 方向。 */
  private directionFromRotation(transform: TransformComponent): Vector3 {
    const direction = new Vector3(0, -1, 0);
    const matrix = Matrix.RotationYawPitchRoll(transform.rotation.y, transform.rotation.x, transform.rotation.z);
    return Vector3.TransformNormal(direction, matrix).normalize();
  }

  /** 判断已存在灯光是否仍匹配组件要求的灯光类型。 */
  private isLightKind(light: Light, lightKind: LightComponent['lightKind']): boolean {
    return (
      (lightKind === 'hemispheric' && light instanceof HemisphericLight) ||
      (lightKind === 'directional' && light instanceof DirectionalLight) ||
      (lightKind === 'point' && light instanceof PointLight)
    );
  }
}
