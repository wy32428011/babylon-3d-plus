import '@babylonjs/loaders';
import {
  type AbstractMesh,
  Color3,
  Mesh,
  MeshBuilder,
  Scene,
  SceneLoader,
  StandardMaterial,
  TransformNode,
  Vector3,
} from '@babylonjs/core';
import type { Entity } from '../../editor/model/Entity';
import type { TransformComponent } from '../../editor/model/components';
import { resolveDefaultManualRoamAvatarUrl } from '../assets/manualRoamAvatarAsset';
import { createDefaultManualRoamConfig } from '../roam/manualRoamCore';

const DEFAULT_AVATAR_HEIGHT_METERS = createDefaultManualRoamConfig().capsuleHeight;
const MARKER_COLOR = '#27c7d8';
const MARKER_SELECTED_COLOR = '#fff1a6';

type SpawnEntry = {
  entity: Entity;
  root: TransformNode;
  visualRoot: TransformNode;
  guideMeshes: Mesh[];
  placeholderMeshes: Mesh[];
  guideMaterial: StandardMaterial;
  placeholderMaterial: StandardMaterial;
  avatarMeshes: AbstractMesh[];
  avatarContainer: Awaited<ReturnType<typeof SceneLoader.LoadAssetContainerAsync>> | null;
  loadGeneration: number;
  selected: boolean;
  visible: boolean;
  pickable: boolean;
};

type ManualRoamSpawnMeshMetadata = {
  editorEntityId: string;
  editorManualRoamSpawn: true;
};

/** 编辑态显示人物出生姿态；运行预览和发布 Viewer 中只保留场景数据，不显示辅助人物。 */
export class EditorManualRoamSpawnRuntime {
  private readonly entries = new Map<string, SpawnEntry>();
  private previewActive = false;
  private editorEnabled = true;

  constructor(
    private readonly scene: Scene,
    private readonly pushLog: (message: string) => void = () => undefined,
  ) {}

  sync(entity: Entity, selected: boolean, visible: boolean, pickable: boolean): void {
    if (!this.editorEnabled || !entity.components.manualRoamSpawn) {
      this.disposeEntity(entity.id);
      return;
    }

    let entry = this.entries.get(entity.id);
    if (!entry) {
      entry = this.createEntry(entity);
      this.entries.set(entity.id, entry);
      void this.loadAvatar(entry);
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

  getWorldBoundsMeshes(entityId: string): AbstractMesh[] {
    const entry = this.entries.get(entityId);
    if (!entry) return [];
    const avatarGeometryMeshes = entry.avatarMeshes.filter((mesh) => (
      !mesh.isDisposed() && mesh.getTotalVertices() > 0
    ));
    return avatarGeometryMeshes.length > 0
      ? avatarGeometryMeshes
      : [...entry.placeholderMeshes, ...entry.guideMeshes];
  }

  has(entityId: string): boolean {
    return this.entries.has(entityId);
  }

  isComplete(entity: Entity): boolean {
    if (!this.editorEnabled) return !this.entries.has(entity.id);
    return entity.components.manualRoamSpawn
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

  /** Viewer 在首次同步前关闭编辑辅助人物，避免重复加载同一 GLB。 */
  disable(): void {
    if (!this.editorEnabled) return;
    this.editorEnabled = false;
    for (const entityId of [...this.entries.keys()]) this.disposeEntity(entityId);
  }

  disposeEntity(entityId: string): void {
    const entry = this.entries.get(entityId);
    if (!entry) return;
    entry.loadGeneration += 1;
    entry.avatarContainer?.dispose();
    for (const mesh of [...entry.placeholderMeshes, ...entry.guideMeshes]) mesh.dispose(false, false);
    entry.guideMaterial.dispose(false, false);
    entry.placeholderMaterial.dispose(false, false);
    entry.visualRoot.dispose(false, false);
    entry.root.dispose(false, false);
    this.entries.delete(entityId);
  }

  dispose(): void {
    for (const entityId of [...this.entries.keys()]) this.disposeEntity(entityId);
  }

  private createEntry(entity: Entity): SpawnEntry {
    const root = new TransformNode(`${entity.id}_manualRoamSpawnRoot`, this.scene);
    const visualRoot = new TransformNode(`${entity.id}_manualRoamSpawnVisualRoot`, this.scene);
    visualRoot.parent = root;

    const guideMaterial = new StandardMaterial(`${entity.id}_manualRoamSpawnGuideMaterial`, this.scene);
    guideMaterial.disableLighting = true;
    guideMaterial.backFaceCulling = false;
    const ring = MeshBuilder.CreateTorus(
      `${entity.id}_manualRoamSpawnRing`,
      { diameter: 0.78, thickness: 0.045, tessellation: 32 },
      this.scene,
    );
    ring.position.y = 0.018;
    const arrow = MeshBuilder.CreateCylinder(
      `${entity.id}_manualRoamSpawnArrow`,
      { height: 0.48, diameterTop: 0, diameterBottom: 0.18, tessellation: 12 },
      this.scene,
    );
    arrow.rotation.x = Math.PI / 2;
    arrow.position.copyFromFloats(0, 0.05, 0.62);
    const guideMeshes = [ring, arrow];

    const placeholderMaterial = new StandardMaterial(`${entity.id}_manualRoamSpawnPlaceholderMaterial`, this.scene);
    placeholderMaterial.disableLighting = false;
    placeholderMaterial.alpha = 0.48;
    const body = MeshBuilder.CreateCapsule(
      `${entity.id}_manualRoamSpawnPlaceholderBody`,
      { height: DEFAULT_AVATAR_HEIGHT_METERS * 0.82, radius: 0.2, tessellation: 12 },
      this.scene,
    );
    body.position.y = DEFAULT_AVATAR_HEIGHT_METERS * 0.44;
    const head = MeshBuilder.CreateSphere(
      `${entity.id}_manualRoamSpawnPlaceholderHead`,
      { diameter: 0.3, segments: 12 },
      this.scene,
    );
    head.position.y = DEFAULT_AVATAR_HEIGHT_METERS - 0.15;
    const placeholderMeshes = [body, head];

    for (const mesh of guideMeshes) {
      this.configureMesh(mesh, entity.id, root, guideMaterial);
    }
    for (const mesh of placeholderMeshes) {
      this.configureMesh(mesh, entity.id, root, placeholderMaterial);
    }

    const entry: SpawnEntry = {
      entity,
      root,
      visualRoot,
      guideMeshes,
      placeholderMeshes,
      guideMaterial,
      placeholderMaterial,
      avatarMeshes: [],
      avatarContainer: null,
      loadGeneration: 0,
      selected: false,
      visible: true,
      pickable: true,
    };
    this.applyTransform(root, entity.components.transform);
    return entry;
  }

  private async loadAvatar(entry: SpawnEntry): Promise<void> {
    const generation = entry.loadGeneration + 1;
    entry.loadGeneration = generation;
    const avatarUrl = resolveDefaultManualRoamAvatarUrl();
    const { rootUrl, fileName } = splitAssetUrl(avatarUrl);
    let container: Awaited<ReturnType<typeof SceneLoader.LoadAssetContainerAsync>> | null = null;
    try {
      container = await SceneLoader.LoadAssetContainerAsync(rootUrl, fileName, this.scene);
      const current = this.entries.get(entry.entity.id);
      if (!current || current !== entry || entry.loadGeneration !== generation || !this.editorEnabled) {
        container.dispose();
        return;
      }
      for (const mesh of container.meshes) {
        mesh.metadata = {
          ...(mesh.metadata ?? {}),
          editorEntityId: entry.entity.id,
          editorManualRoamSpawn: true,
        } satisfies ManualRoamSpawnMeshMetadata;
        mesh.receiveShadows = false;
        mesh.renderingGroupId = 2;
      }
      container.addAllToScene();
      for (const node of container.rootNodes) node.parent = entry.visualRoot;
      normalizeAvatar(entry.visualRoot, container.meshes);
      entry.avatarContainer = container;
      entry.avatarMeshes = [...container.meshes];
      for (const mesh of entry.placeholderMeshes) mesh.setEnabled(false);
      this.applyPresentation(entry);
    } catch (error) {
      container?.dispose();
      if (this.entries.get(entry.entity.id) !== entry || entry.loadGeneration !== generation) return;
      this.pushLog(`手动漫游初始人物加载失败，已保留占位标记：${getErrorMessage(error)}`);
    }
  }

  private configureMesh(
    mesh: Mesh,
    entityId: string,
    parent: TransformNode,
    material: StandardMaterial,
  ): void {
    mesh.parent = parent;
    mesh.material = material;
    mesh.receiveShadows = false;
    mesh.renderingGroupId = 2;
    mesh.metadata = {
      editorEntityId: entityId,
      editorManualRoamSpawn: true,
    } satisfies ManualRoamSpawnMeshMetadata;
  }

  private applyTransform(root: TransformNode, transform: TransformComponent): void {
    root.position.copyFromFloats(transform.position.x, transform.position.y, transform.position.z);
    root.rotationQuaternion = null;
    root.rotation.copyFromFloats(0, transform.rotation.y, 0);
    root.scaling.setAll(1);
    root.computeWorldMatrix(true);
  }

  private applyPresentation(entry: SpawnEntry): void {
    const show = entry.visible && !this.previewActive && this.editorEnabled;
    const color = Color3.FromHexString(entry.selected ? MARKER_SELECTED_COLOR : MARKER_COLOR);
    entry.guideMaterial.diffuseColor = color;
    entry.guideMaterial.emissiveColor = color;
    entry.guideMaterial.alpha = entry.selected ? 1 : 0.75;
    entry.placeholderMaterial.diffuseColor = color;
    entry.placeholderMaterial.emissiveColor = color.scale(0.25);
    entry.root.setEnabled(show);
    for (const mesh of [...entry.guideMeshes, ...entry.placeholderMeshes, ...entry.avatarMeshes]) {
      mesh.isPickable = show && entry.pickable && mesh.getTotalVertices() > 0;
    }
  }

  private canInteract(entry: SpawnEntry): boolean {
    return this.editorEnabled && !this.previewActive && entry.visible && entry.pickable;
  }
}

function normalizeAvatar(visualRoot: TransformNode, meshes: readonly AbstractMesh[]): void {
  visualRoot.position.setAll(0);
  visualRoot.scaling.setAll(1);
  visualRoot.computeWorldMatrix(true);
  const bounds = collectBoundsRelativeToNode(meshes, visualRoot);
  if (!bounds) return;
  const height = bounds.maximum.y - bounds.minimum.y;
  const scale = height > 1e-5 ? DEFAULT_AVATAR_HEIGHT_METERS / height : 1;
  visualRoot.scaling.setAll(scale);
  visualRoot.position.set(
    -(bounds.minimum.x + bounds.maximum.x) / 2 * scale,
    -bounds.minimum.y * scale,
    -(bounds.minimum.z + bounds.maximum.z) / 2 * scale,
  );
  visualRoot.computeWorldMatrix(true);
}

function collectBoundsRelativeToNode(
  meshes: readonly AbstractMesh[],
  node: TransformNode,
): { minimum: Vector3; maximum: Vector3 } | null {
  node.computeWorldMatrix(true);
  const inverseWorld = node.getWorldMatrix().clone().invert();
  let minimum: Vector3 | null = null;
  let maximum: Vector3 | null = null;
  for (const mesh of meshes) {
    if (mesh.isDisposed() || mesh.getTotalVertices() <= 0) continue;
    mesh.computeWorldMatrix(true);
    const box = mesh.getBoundingInfo().boundingBox;
    for (const worldCorner of box.vectorsWorld) {
      const localCorner = Vector3.TransformCoordinates(worldCorner, inverseWorld);
      minimum = minimum ? Vector3.Minimize(minimum, localCorner) : localCorner.clone();
      maximum = maximum ? Vector3.Maximize(maximum, localCorner) : localCorner.clone();
    }
  }
  return minimum && maximum ? { minimum, maximum } : null;
}

function splitAssetUrl(url: string): { rootUrl: string; fileName: string } {
  const index = url.lastIndexOf('/');
  return index >= 0
    ? { rootUrl: url.slice(0, index + 1), fileName: url.slice(index + 1) }
    : { rootUrl: '', fileName: url };
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
