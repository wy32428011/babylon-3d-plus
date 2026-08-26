import {
  Color3,
  Mesh,
  MeshBuilder,
  Scene,
  StandardMaterial,
  TransformNode,
} from '@babylonjs/core';
import type { Entity } from '../../editor/model/Entity';
import type { TransformComponent } from '../../editor/model/components';

const MARKER_COLOR = '#f5a623';
const MARKER_SELECTED_COLOR = '#fff1a6';
const MARKER_ALPHA = 0.65;

type BindingEntry = {
  entity: Entity;
  root: TransformNode;
  markerMesh: Mesh;
  markerMaterial: StandardMaterial;
  selected: boolean;
  visible: boolean;
  pickable: boolean;
};

type ClickEventBindingMeshMetadata = {
  editorEntityId: string;
  editorClickEventBinding: true;
};

/** 编辑态显示点击事件绑定的线框标记；运行预览和发布 Viewer 中标记隐藏，绑定逻辑仍按场景数据生效。 */
export class EditorClickEventBindingRuntime {
  private readonly entries = new Map<string, BindingEntry>();
  private previewActive = false;
  private editorEnabled = true;

  constructor(private readonly scene: Scene) {}

  sync(entity: Entity, selected: boolean, visible: boolean, pickable: boolean): void {
    if (!this.editorEnabled || !entity.components.clickEventBinding) {
      this.disposeEntity(entity.id);
      return;
    }

    let entry = this.entries.get(entity.id);
    if (!entry) {
      entry = this.createEntry(entity);
      this.entries.set(entity.id, entry);
    }
    entry.entity = entity;
    entry.selected = selected;
    entry.visible = visible;
    entry.pickable = pickable;
    this.applyTransform(entry.root, entity.components.transform);
    this.applyPresentation(entry);
  }

  syncPresentation(entity: Entity, selected: boolean, visible: boolean, pickable: boolean): void {
    const entry = this.entries.get(entity.id);
    if (!entry) return;
    entry.entity = entity;
    entry.selected = selected;
    entry.visible = visible;
    entry.pickable = pickable;
    this.applyPresentation(entry);
  }

  getGizmoTarget(entityId: string): TransformNode | null {
    const entry = this.entries.get(entityId);
    return entry && this.canInteract(entry) && !entry.root.isDisposed() ? entry.root : null;
  }

  getTransformTarget(entityId: string): TransformNode | null {
    const entry = this.entries.get(entityId);
    return entry && !entry.root.isDisposed() ? entry.root : null;
  }

  previewTransform(entityId: string, transform: TransformComponent): void {
    const entry = this.entries.get(entityId);
    if (!entry) return;
    this.applyTransform(entry.root, transform);
  }

  getWorldBoundsMeshes(entityId: string): Mesh[] {
    const entry = this.entries.get(entityId);
    return entry && !entry.markerMesh.isDisposed() ? [entry.markerMesh] : [];
  }

  has(entityId: string): boolean {
    return this.entries.has(entityId);
  }

  isComplete(entity: Entity): boolean {
    if (!this.editorEnabled) return !this.entries.has(entity.id);
    return entity.components.clickEventBinding
      ? this.entries.has(entity.id)
      : !this.entries.has(entity.id);
  }

  disposeMissing(validEntityIds: ReadonlySet<string>): void {
    for (const entityId of [...this.entries.keys()]) {
      if (!validEntityIds.has(entityId)) this.disposeEntity(entityId);
    }
  }

  setPreviewActive(active: boolean): void {
    if (this.previewActive === active) return;
    this.previewActive = active;
    for (const entry of this.entries.values()) this.applyPresentation(entry);
  }

  /** Viewer 在首次同步前关闭编辑辅助标记。 */
  disable(): void {
    if (!this.editorEnabled) return;
    this.editorEnabled = false;
    for (const entityId of [...this.entries.keys()]) this.disposeEntity(entityId);
  }

  disposeEntity(entityId: string): void {
    const entry = this.entries.get(entityId);
    if (!entry) return;
    entry.markerMesh.dispose(false, false);
    entry.markerMaterial.dispose(false, false);
    entry.root.dispose(false, false);
    this.entries.delete(entityId);
  }

  dispose(): void {
    for (const entityId of [...this.entries.keys()]) this.disposeEntity(entityId);
  }

  private createEntry(entity: Entity): BindingEntry {
    const root = new TransformNode(`${entity.id}_clickEventBindingRoot`, this.scene);
    const markerMesh = MeshBuilder.CreateBox(`${entity.id}_clickEventBindingMarker`, { size: 0.8 }, this.scene);
    const markerMaterial = new StandardMaterial(`${entity.id}_clickEventBindingMarkerMaterial`, this.scene);
    markerMaterial.disableLighting = true;
    markerMaterial.wireframe = true;
    markerMaterial.alpha = MARKER_ALPHA;

    markerMesh.parent = root;
    markerMesh.position.y = 0.4;
    markerMesh.material = markerMaterial;
    markerMesh.receiveShadows = false;
    markerMesh.renderingGroupId = 2;
    markerMesh.metadata = {
      editorEntityId: entity.id,
      editorClickEventBinding: true,
    } satisfies ClickEventBindingMeshMetadata;

    const entry: BindingEntry = {
      entity,
      root,
      markerMesh,
      markerMaterial,
      selected: false,
      visible: true,
      pickable: true,
    };
    this.applyTransform(root, entity.components.transform);
    return entry;
  }

  private applyTransform(root: TransformNode, transform: TransformComponent): void {
    root.position.copyFromFloats(transform.position.x, transform.position.y, transform.position.z);
    root.rotationQuaternion = null;
    root.rotation.copyFromFloats(transform.rotation.x, transform.rotation.y, transform.rotation.z);
    root.scaling.copyFromFloats(transform.scale.x, transform.scale.y, transform.scale.z);
    root.computeWorldMatrix(true);
  }

  private applyPresentation(entry: BindingEntry): void {
    const show = entry.visible && !this.previewActive && this.editorEnabled;
    const color = Color3.FromHexString(entry.selected ? MARKER_SELECTED_COLOR : MARKER_COLOR);
    entry.markerMaterial.diffuseColor = color;
    entry.markerMaterial.emissiveColor = color;
    entry.markerMaterial.alpha = entry.selected ? 1 : MARKER_ALPHA;
    entry.root.setEnabled(show);
    entry.markerMesh.isPickable = show && entry.pickable;
  }

  private canInteract(entry: BindingEntry): boolean {
    return this.editorEnabled && !this.previewActive && entry.visible && entry.pickable;
  }
}
