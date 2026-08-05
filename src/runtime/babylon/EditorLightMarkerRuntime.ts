import {
  Camera,
  Color3,
  Mesh,
  MeshBuilder,
  type Nullable,
  type Observer,
  Scene,
  StandardMaterial,
  TransformNode,
  Vector3,
} from '@babylonjs/core';
import type { Entity } from '../../editor/model/Entity';
import type { TransformComponent } from '../../editor/model/components';
import { getLightEditorCapabilities, type LightEditorMarkerKind } from '../../editor/model/lightEditor';
import type { Vector3Data } from '../../editor/model/math';

const LIGHT_MARKER_COLOR = '#f2bf48';
const LIGHT_MARKER_SELECTED_COLOR = '#f7d774';
const LIGHT_MARKER_ALPHA = 0.58;
const LIGHT_MARKER_TARGET_PIXELS = 30;
const LIGHT_MARKER_MIN_WORLD_SCALE = 0.015;
const LIGHT_MARKER_MAX_WORLD_SCALE = 500;
const MIN_RENDER_HEIGHT_PIXELS = 1;
const MIN_CAMERA_DISTANCE = 0.001;
const MIN_PARENT_SCALE = 1e-6;

type EditorLightMarkerEntry = {
  kind: LightEditorMarkerKind;
  root: TransformNode;
  visualRoot: TransformNode;
  meshes: Mesh[];
  material: StandardMaterial;
  selected: boolean;
  visible: boolean;
  pickable: boolean;
};

/**
 * 点光源和方向光的编辑器辅助标记运行时。
 * 根节点保存实体 Transform，子视觉根节点独立抵消实体缩放并维持近似固定屏幕尺寸。
 */
export class EditorLightMarkerRuntime {
  private readonly entries = new Map<string, EditorLightMarkerEntry>();
  private readonly screenScaleObserver: Nullable<Observer<Scene>>;
  private previewActive = false;
  private editorEnabled = true;

  constructor(private readonly scene: Scene) {
    this.screenScaleObserver = scene.onBeforeRenderObservable.add(() => this.updateScreenScales());
  }

  /** 创建或更新一个灯光的编辑器标记；半球光会主动清理旧标记。 */
  sync(entity: Entity, selected: boolean, visible: boolean, pickable: boolean): void {
    if (!this.editorEnabled) {
      this.disposeEntity(entity.id);
      return;
    }

    const lightKind = entity.components.light?.lightKind;
    const markerKind = lightKind ? getLightEditorCapabilities(lightKind).markerKind : null;
    if (!markerKind) {
      this.disposeEntity(entity.id);
      return;
    }

    let entry = this.entries.get(entity.id);
    if (entry && entry.kind !== markerKind) {
      this.disposeEntity(entity.id);
      entry = undefined;
    }
    if (!entry) {
      entry = this.createEntry(entity.id, markerKind);
      this.entries.set(entity.id, entry);
    }

    this.applyTransform(entry.root, entity.components.transform);
    entry.selected = selected;
    entry.visible = visible;
    entry.pickable = pickable;
    this.applyPresentation(entry);
    this.updateEntryScreenScale(entry);
  }

  /** 只刷新选择、显隐和锁定表现，不重建标记几何。 */
  syncPresentation(entityId: string, selected: boolean, visible: boolean, pickable: boolean): void {
    const entry = this.entries.get(entityId);
    if (!entry) return;
    entry.selected = selected;
    entry.visible = visible;
    entry.pickable = pickable;
    this.applyPresentation(entry);
  }

  /** 发布 Viewer 在首次场景同步前永久禁用编辑器标记，且不再分配辅助 Mesh。 */
  disable(): void {
    if (!this.editorEnabled) return;
    this.editorEnabled = false;
    for (const entityId of [...this.entries.keys()]) this.disposeEntity(entityId);
  }

  /** 编辑态显示标记，运行预览隐藏标记。 */
  setPreviewActive(active: boolean): void {
    if (this.previewActive === active) return;
    this.previewActive = active;
    for (const entry of this.entries.values()) this.applyPresentation(entry);
  }

  /** 返回灯光标记根节点作为 Transform Gizmo 目标。 */
  getGizmoTarget(entityId: string): TransformNode | null {
    const entry = this.entries.get(entityId);
    return entry && !entry.root.isDisposed() ? entry.root : null;
  }

  has(entityId: string): boolean {
    return this.entries.has(entityId);
  }

  /** 判断当前实体是否已经具备其灯光类型要求的标记资源。 */
  isComplete(entity: Entity): boolean {
    if (!this.editorEnabled) return !this.entries.has(entity.id);
    const lightKind = entity.components.light?.lightKind;
    if (!lightKind) return !this.entries.has(entity.id);
    const markerKind = getLightEditorCapabilities(lightKind).markerKind;
    const entry = this.entries.get(entity.id);
    return markerKind ? entry?.kind === markerKind : !entry;
  }

  /** 文件夹组平移预览中同步移动标记根节点。 */
  setPosition(entityId: string, position: Vector3Data): void {
    const root = this.entries.get(entityId)?.root;
    if (!root || root.isDisposed()) return;
    root.position.copyFromFloats(position.x, position.y, position.z);
    root.computeWorldMatrix(true);
  }

  /** 文件夹组旋转预览中同步完整标记 Transform。 */
  setTransform(entityId: string, transform: TransformComponent): void {
    const root = this.entries.get(entityId)?.root;
    if (!root || root.isDisposed()) return;
    this.applyTransform(root, transform);
  }

  disposeMissing(entityIds: ReadonlySet<string>): void {
    for (const entityId of [...this.entries.keys()]) {
      if (!entityIds.has(entityId)) this.disposeEntity(entityId);
    }
  }

  disposeEntity(entityId: string): void {
    const entry = this.entries.get(entityId);
    if (!entry) return;
    entry.material.dispose();
    for (const mesh of entry.meshes) mesh.dispose(false, false);
    entry.visualRoot.dispose(false, false);
    entry.root.dispose(false, false);
    this.entries.delete(entityId);
  }

  dispose(): void {
    if (this.screenScaleObserver) {
      this.scene.onBeforeRenderObservable.remove(this.screenScaleObserver);
    }
    for (const entityId of [...this.entries.keys()]) this.disposeEntity(entityId);
  }

  private createEntry(entityId: string, kind: LightEditorMarkerKind): EditorLightMarkerEntry {
    const root = new TransformNode(`${entityId}_lightMarkerRoot`, this.scene);
    const visualRoot = new TransformNode(`${entityId}_lightMarkerVisualRoot`, this.scene);
    visualRoot.parent = root;

    const material = new StandardMaterial(`${entityId}_lightMarkerMaterial`, this.scene);
    material.disableLighting = true;
    material.disableDepthWrite = true;
    material.backFaceCulling = false;
    material.wireframe = true;

    const meshes = kind === 'point'
      ? this.createPointMarkerMeshes(entityId, visualRoot, material)
      : this.createDirectionalMarkerMeshes(entityId, visualRoot, material);

    return {
      kind,
      root,
      visualRoot,
      meshes,
      material,
      selected: false,
      visible: true,
      pickable: true,
    };
  }

  /** 点光源使用线框球体，中心即实体位置和 Gizmo 锚点。 */
  private createPointMarkerMeshes(
    entityId: string,
    parent: TransformNode,
    material: StandardMaterial,
  ): Mesh[] {
    const sphere = MeshBuilder.CreateSphere(
      `${entityId}_pointLightMarker`,
      { diameter: 0.8, segments: 12 },
      this.scene,
    );
    this.configureMarkerMesh(sphere, entityId, parent, material);
    return [sphere];
  }

  /** 方向光箭头沿本地 -Y 指向，与 SceneRuntime 的方向计算基准保持一致。 */
  private createDirectionalMarkerMeshes(
    entityId: string,
    parent: TransformNode,
    material: StandardMaterial,
  ): Mesh[] {
    const origin = MeshBuilder.CreateSphere(
      `${entityId}_directionalLightOriginMarker`,
      { diameter: 0.26, segments: 8 },
      this.scene,
    );
    origin.position.y = 0.08;

    const shaft = MeshBuilder.CreateCylinder(
      `${entityId}_directionalLightShaftMarker`,
      { height: 0.58, diameter: 0.12, tessellation: 10 },
      this.scene,
    );
    shaft.position.y = -0.24;

    const head = MeshBuilder.CreateCylinder(
      `${entityId}_directionalLightHeadMarker`,
      { height: 0.34, diameterTop: 0.32, diameterBottom: 0, tessellation: 10 },
      this.scene,
    );
    head.position.y = -0.7;

    const meshes = [origin, shaft, head];
    for (const mesh of meshes) this.configureMarkerMesh(mesh, entityId, parent, material);
    return meshes;
  }

  private configureMarkerMesh(
    mesh: Mesh,
    entityId: string,
    parent: TransformNode,
    material: StandardMaterial,
  ): void {
    mesh.parent = parent;
    mesh.material = material;
    mesh.receiveShadows = false;
    mesh.metadata = {
      ...(mesh.metadata ?? {}),
      editorEntityId: entityId,
      editorLightMarker: true,
    };
  }

  private applyTransform(root: TransformNode, transform: TransformComponent): void {
    root.position.copyFromFloats(transform.position.x, transform.position.y, transform.position.z);
    root.rotationQuaternion = null;
    root.rotation.copyFromFloats(transform.rotation.x, transform.rotation.y, transform.rotation.z);
    root.scaling.copyFromFloats(transform.scale.x, transform.scale.y, transform.scale.z);
    root.computeWorldMatrix(true);
  }

  private applyPresentation(entry: EditorLightMarkerEntry): void {
    const showMarker = entry.visible && !this.previewActive;
    const color = Color3.FromHexString(entry.selected ? LIGHT_MARKER_SELECTED_COLOR : LIGHT_MARKER_COLOR);

    entry.root.setEnabled(entry.visible);
    entry.material.alpha = entry.selected ? 1 : LIGHT_MARKER_ALPHA;
    entry.material.diffuseColor = color;
    entry.material.emissiveColor = color;
    for (const mesh of entry.meshes) {
      mesh.isVisible = showMarker;
      mesh.isPickable = showMarker && entry.pickable;
    }
  }

  private updateScreenScales(): void {
    if (!this.editorEnabled || this.previewActive) return;
    for (const entry of this.entries.values()) this.updateEntryScreenScale(entry);
  }

  private updateEntryScreenScale(entry: EditorLightMarkerEntry): void {
    if (!entry.visible || entry.root.isDisposed() || entry.visualRoot.isDisposed()) return;
    const camera = this.scene.cameraToUseForPointers ?? this.scene.activeCamera;
    if (!camera) return;

    entry.root.computeWorldMatrix(true);
    const desiredWorldScale = this.calculateWorldScale(camera, entry.root.getAbsolutePosition());
    entry.visualRoot.scaling.copyFromFloats(
      divideByParentScale(desiredWorldScale, entry.root.scaling.x),
      divideByParentScale(desiredWorldScale, entry.root.scaling.y),
      divideByParentScale(desiredWorldScale, entry.root.scaling.z),
    );
    entry.visualRoot.computeWorldMatrix(true);
  }

  /** 根据相机投影和渲染高度把目标像素尺寸换算为世界尺度。 */
  private calculateWorldScale(camera: Camera, worldPosition: Vector3): number {
    const engine = this.scene.getEngine();
    const renderHeight = Math.max(MIN_RENDER_HEIGHT_PIXELS, engine.getRenderHeight(true));
    const renderWidth = Math.max(1, engine.getRenderWidth(true));
    let visibleWorldHeight: number | null = null;

    if (
      camera.mode === Camera.ORTHOGRAPHIC_CAMERA
      && Number.isFinite(camera.orthoTop)
      && Number.isFinite(camera.orthoBottom)
    ) {
      visibleWorldHeight = Math.abs((camera.orthoTop ?? 0) - (camera.orthoBottom ?? 0));
    }

    if (!visibleWorldHeight || visibleWorldHeight <= 0) {
      const distance = Math.max(MIN_CAMERA_DISTANCE, Vector3.Distance(camera.globalPosition, worldPosition));
      const fov = Number.isFinite(camera.fov) && camera.fov > 0 ? camera.fov : Math.PI / 4;
      const projectedSpan = 2 * distance * Math.tan(fov / 2);
      visibleWorldHeight = camera.fovMode === Camera.FOVMODE_HORIZONTAL_FIXED
        ? projectedSpan / Math.max(1e-6, renderWidth / renderHeight)
        : projectedSpan;
    }

    const worldScale = visibleWorldHeight * LIGHT_MARKER_TARGET_PIXELS / renderHeight;
    return Math.min(
      LIGHT_MARKER_MAX_WORLD_SCALE,
      Math.max(LIGHT_MARKER_MIN_WORLD_SCALE, Number.isFinite(worldScale) ? worldScale : 1),
    );
  }
}

/** 抵消灯光实体自身缩放，确保视觉标记缩放不回写或污染持久化 Transform。 */
function divideByParentScale(desiredScale: number, parentScale: number): number {
  return Number.isFinite(parentScale) && Math.abs(parentScale) > MIN_PARENT_SCALE
    ? desiredScale / parentScale
    : desiredScale;
}
