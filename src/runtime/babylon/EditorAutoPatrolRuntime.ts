import {
  type AbstractMesh,
  Camera,
  Color3,
  Curve3,
  DynamicTexture,
  LinesMesh,
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
import type { AutoPatrolTriggerRegion, AutoPatrolWaypoint, TransformComponent } from '../../editor/model/components';
import {
  getAutoPatrolWaypointView,
  sampleAutoPatrolWorldPath,
} from '../../editor/model/autoPatrolInspection';

const ROUTE_COLOR = '#d52e36';
const ROUTE_SELECTED_COLOR = '#ff5a61';
const WAYPOINT_COLOR = '#ff353f';
const WAYPOINT_SELECTED_COLOR = '#fff1a6';
const WAYPOINT_PLAYBACK_COLOR = '#77f28c';
const PATH_COLOR = '#ff3038';
const DETAIL_COLOR = '#ffd66d';
const TARGET_COLOR = '#8fe9ff';
const ROUTE_TARGET_PIXELS = 34;
const WAYPOINT_TARGET_PIXELS = 38;
const MIN_WORLD_SCALE = 0.02;
const MAX_WORLD_SCALE = 1_000;
const MIN_CAMERA_DISTANCE = 0.001;
const MIN_RENDER_HEIGHT_PIXELS = 1;

export type AutoPatrolMarkerPick = {
  entityId: string;
  waypointId: string | null;
};

type WaypointEntry = {
  waypoint: AutoPatrolWaypoint;
  index: number;
  root: TransformNode;
  visualRoot: TransformNode;
  markerSphere: Mesh;
  markerMaterial: StandardMaterial;
  numberPlane: Mesh;
  numberMaterial: StandardMaterial;
  numberTexture: DynamicTexture | null;
  textureState: string;
};

type TriggerRegionEntry = {
  region: AutoPatrolTriggerRegion;
  mesh: Mesh;
  material: StandardMaterial;
};

type RouteEntry = {
  entity: Entity;
  root: TransformNode;
  visualRoot: TransformNode;
  originMeshes: Mesh[];
  originMaterial: StandardMaterial;
  waypoints: Map<string, WaypointEntry>;
  pathMesh: LinesMesh | null;
  detailMeshes: LinesMesh[];
  triggerRegions: Map<string, TriggerRegionEntry>;
  selected: boolean;
  selectedWaypointId: string | null;
  visible: boolean;
  pickable: boolean;
};

type AutoPatrolMeshMetadata = {
  editorEntityId?: string;
  editorAutoPatrolMarker?: boolean;
  editorAutoPatrolWaypointId?: string;
};

/**
 * 自动巡检的编辑态辅助运行时。
 * 路线原点始终可选；只有当前路线展开编号、路径和选中节点相机视锥。
 */
export class EditorAutoPatrolRuntime {
  private readonly entries = new Map<string, RouteEntry>();
  private readonly screenScaleObserver: Nullable<Observer<Scene>>;
  private selectedRouteId: string | null = null;
  private selectedWaypointId: string | null = null;
  private playbackRouteId: string | null = null;
  private playbackWaypointIndex: number | null = null;
  private previewActive = false;
  private editorEnabled = true;

  constructor(private readonly scene: Scene) {
    this.screenScaleObserver = scene.onBeforeRenderObservable.add(() => this.updateScreenScales());
  }

  /** 创建或更新路线原点与当前路线的节点辅助对象。 */
  sync(entity: Entity, selected: boolean, visible: boolean, pickable: boolean): void {
    if (!this.editorEnabled || !entity.components.autoPatrol) {
      this.disposeEntity(entity.id);
      return;
    }

    let entry = this.entries.get(entity.id);
    if (!entry) {
      entry = this.createRouteEntry(entity);
      this.entries.set(entity.id, entry);
    }

    entry.entity = entity;
    entry.selected = selected;
    entry.selectedWaypointId = selected ? this.selectedWaypointId : null;
    entry.visible = visible;
    entry.pickable = pickable;
    this.applyTransform(entry.root, entity.components.transform);
    this.syncRouteDetails(entry);
    this.applyPresentation(entry);
    this.updateEntryScreenScales(entry);
  }

  /** 选择、显隐或锁定变化时只刷新路线展开态和交互表现。 */
  syncPresentation(entity: Entity, selected: boolean, visible: boolean, pickable: boolean): void {
    const entry = this.entries.get(entity.id);
    if (!entry) return;
    entry.entity = entity;
    entry.selected = selected;
    entry.selectedWaypointId = selected ? this.selectedWaypointId : null;
    entry.visible = visible;
    entry.pickable = pickable;
    this.syncRouteDetails(entry);
    this.applyPresentation(entry);
    this.updateEntryScreenScales(entry);
  }

  /** 节点子选区不进入 SceneDocument，因此由 SceneView 单独同步。 */
  setSelection(routeId: string | null, waypointId: string | null): void {
    if (this.selectedRouteId === routeId && this.selectedWaypointId === waypointId) return;
    this.selectedRouteId = routeId;
    this.selectedWaypointId = waypointId;
    for (const entry of this.entries.values()) {
      entry.selected = entry.entity.id === routeId;
      entry.selectedWaypointId = entry.selected ? waypointId : null;
      this.syncRouteDetails(entry);
      this.applyPresentation(entry);
    }
  }

  /** 播放目标用于编辑预览高亮；运行预览和 Viewer 中标记本身仍会隐藏。 */
  setPlaybackTarget(routeId: string | null, waypointIndex: number | null): void {
    if (this.playbackRouteId === routeId && this.playbackWaypointIndex === waypointIndex) return;
    this.playbackRouteId = routeId;
    this.playbackWaypointIndex = waypointIndex;
    for (const entry of this.entries.values()) this.updateWaypointTextureStates(entry);
  }

  /** Gizmo 拖动节点时即时更新标记、路径和相机视锥，不写入场景文档。 */
  previewWaypointTransform(entityId: string, waypointId: string, transform: TransformComponent): void {
    const entry = this.entries.get(entityId);
    const waypoint = entry?.waypoints.get(waypointId);
    if (!entry || !waypoint) return;
    waypoint.root.position.copyFromFloats(transform.position.x, transform.position.y, transform.position.z);
    waypoint.root.rotationQuaternion = null;
    waypoint.root.rotation.copyFromFloats(transform.rotation.x, transform.rotation.y, 0);
    waypoint.root.scaling.setAll(1);
    waypoint.root.computeWorldMatrix(true);
    this.rebuildPathFromWaypointRoots(entry);
    this.rebuildSelectedWaypointDetails(entry);
    this.updateEntryScreenScales(entry);
  }

  getRouteGizmoTarget(entityId: string): TransformNode | null {
    const entry = this.entries.get(entityId);
    return entry && this.canInteract(entry) && !entry.root.isDisposed() ? entry.root : null;
  }

  /** 文件夹组变换需要访问隐藏但已同步的路线根节点。 */
  getRouteTransformTarget(entityId: string): TransformNode | null {
    const entry = this.entries.get(entityId);
    return entry && !entry.root.isDisposed() ? entry.root : null;
  }

  /** 文件夹组临时变换同时刷新路线原点、节点、路径和视锥。 */
  previewRouteTransform(entityId: string, transform: TransformComponent): void {
    const entry = this.entries.get(entityId);
    const component = entry?.entity.components.autoPatrol;
    if (!entry || !component) return;
    this.applyTransform(entry.root, transform);
    for (const waypoint of component.waypoints) {
      const waypointEntry = entry.waypoints.get(waypoint.id);
      if (waypointEntry) this.applyWaypointTransform(waypointEntry, waypoint, transform);
    }
    this.rebuildPath(entry, transform);
    this.rebuildSelectedWaypointDetails(entry);
    this.updateEntryScreenScales(entry);
  }

  getWaypointGizmoTarget(entityId: string, waypointId: string): TransformNode | null {
    const entry = this.entries.get(entityId);
    const waypoint = entry?.waypoints.get(waypointId);
    return entry && waypoint && entry.selected && this.canInteract(entry) && !waypoint.root.isDisposed()
      ? waypoint.root
      : null;
  }

  readPick(mesh: AbstractMesh | null): AutoPatrolMarkerPick | null {
    if (!mesh) return null;
    const metadata = mesh.metadata as AutoPatrolMeshMetadata | null | undefined;
    if (metadata?.editorAutoPatrolMarker !== true || typeof metadata.editorEntityId !== 'string') return null;
    const entry = this.entries.get(metadata.editorEntityId);
    if (!entry || !this.canInteract(entry)) return null;
    const waypointId = typeof metadata.editorAutoPatrolWaypointId === 'string'
      && entry.waypoints.has(metadata.editorAutoPatrolWaypointId)
      ? metadata.editorAutoPatrolWaypointId
      : null;
    return { entityId: metadata.editorEntityId, waypointId };
  }

  has(entityId: string): boolean {
    return this.entries.has(entityId);
  }

  disposeMissing(validEntityIds: ReadonlySet<string>): void {
    for (const entityId of [...this.entries.keys()]) {
      if (!validEntityIds.has(entityId)) this.disposeEntity(entityId);
    }
  }

  isComplete(entity: Entity): boolean {
    if (!this.editorEnabled) return !this.entries.has(entity.id);
    const component = entity.components.autoPatrol;
    if (!component) return !this.entries.has(entity.id);
    const entry = this.entries.get(entity.id);
    if (!entry) return false;
    if (!entry.selected) return true;
    return component.waypoints.length === entry.waypoints.size
      && component.waypoints.every((waypoint) => entry.waypoints.has(waypoint.id));
  }

  setPreviewActive(active: boolean): void {
    if (this.previewActive === active) return;
    this.previewActive = active;
    for (const entry of this.entries.values()) this.applyPresentation(entry);
  }

  /** Viewer 在首次同步前永久关闭编辑标记，避免生成无用 GPU 资源。 */
  disable(): void {
    if (!this.editorEnabled) return;
    this.editorEnabled = false;
    for (const entityId of [...this.entries.keys()]) this.disposeEntity(entityId);
  }

  disposeEntity(entityId: string): void {
    const entry = this.entries.get(entityId);
    if (!entry) return;
    this.disposePath(entry);
    this.disposeDetails(entry);
    this.disposeTriggerRegions(entry);
    for (const waypoint of entry.waypoints.values()) this.disposeWaypoint(waypoint);
    entry.waypoints.clear();
    for (const mesh of entry.originMeshes) mesh.dispose(false, false);
    entry.originMaterial.dispose(false, false);
    entry.visualRoot.dispose(false, false);
    entry.root.dispose(false, false);
    this.entries.delete(entityId);
  }

  dispose(): void {
    if (this.screenScaleObserver) this.scene.onBeforeRenderObservable.remove(this.screenScaleObserver);
    for (const entityId of [...this.entries.keys()]) this.disposeEntity(entityId);
  }

  private createRouteEntry(entity: Entity): RouteEntry {
    const root = new TransformNode(`${entity.id}_autoPatrolRoot`, this.scene);
    const visualRoot = new TransformNode(`${entity.id}_autoPatrolVisualRoot`, this.scene);
    visualRoot.parent = root;
    const material = new StandardMaterial(`${entity.id}_autoPatrolOriginMaterial`, this.scene);
    material.disableLighting = true;
    material.backFaceCulling = false;
    const torus = MeshBuilder.CreateTorus(
      `${entity.id}_autoPatrolOriginRing`,
      { diameter: 1, thickness: 0.08, tessellation: 32 },
      this.scene,
    );
    const center = MeshBuilder.CreateSphere(
      `${entity.id}_autoPatrolOriginCenter`,
      { diameter: 0.18, segments: 10 },
      this.scene,
    );
    const arrow = MeshBuilder.CreateCylinder(
      `${entity.id}_autoPatrolOriginArrow`,
      { height: 0.55, diameterTop: 0, diameterBottom: 0.22, tessellation: 12 },
      this.scene,
    );
    arrow.rotation.x = Math.PI / 2;
    arrow.position.z = 0.62;
    const originMeshes = [torus, center, arrow];
    for (const mesh of originMeshes) this.configureMarkerMesh(mesh, entity.id, null, visualRoot, material);

    return {
      entity,
      root,
      visualRoot,
      originMeshes,
      originMaterial: material,
      waypoints: new Map(),
      pathMesh: null,
      detailMeshes: [],
      triggerRegions: new Map(),
      selected: false,
      selectedWaypointId: null,
      visible: true,
      pickable: true,
    };
  }

  private syncRouteDetails(entry: RouteEntry): void {
    const component = entry.entity.components.autoPatrol;
    if (!component || !entry.selected) {
      this.disposePath(entry);
      this.disposeDetails(entry);
      this.disposeTriggerRegions(entry);
      for (const waypoint of entry.waypoints.values()) this.disposeWaypoint(waypoint);
      entry.waypoints.clear();
      return;
    }

    const currentIds = new Set(component.waypoints.map((waypoint) => waypoint.id));
    for (const [waypointId, waypointEntry] of entry.waypoints.entries()) {
      if (currentIds.has(waypointId)) continue;
      this.disposeWaypoint(waypointEntry);
      entry.waypoints.delete(waypointId);
    }

    component.waypoints.forEach((waypoint, index) => {
      let waypointEntry = entry.waypoints.get(waypoint.id);
      if (!waypointEntry) {
        waypointEntry = this.createWaypointEntry(entry.entity.id, waypoint, index);
        entry.waypoints.set(waypoint.id, waypointEntry);
      }
      waypointEntry.waypoint = waypoint;
      waypointEntry.index = index;
      this.applyWaypointTransform(waypointEntry, waypoint, entry.entity.components.transform);
    });

    this.syncTriggerRegions(entry);

    this.rebuildPath(entry);
    this.rebuildSelectedWaypointDetails(entry);
    this.updateWaypointTextureStates(entry);
  }

  private createWaypointEntry(entityId: string, waypoint: AutoPatrolWaypoint, index: number): WaypointEntry {
    const root = new TransformNode(`${entityId}_${waypoint.id}_autoPatrolWaypointRoot`, this.scene);
    const visualRoot = new TransformNode(`${entityId}_${waypoint.id}_autoPatrolWaypointVisualRoot`, this.scene);
    visualRoot.parent = root;
    const numberTexture = typeof document !== 'undefined' || typeof OffscreenCanvas !== 'undefined'
      ? new DynamicTexture(
          `${entityId}_${waypoint.id}_autoPatrolWaypointTexture`,
          { width: 128, height: 128 },
          this.scene,
          false,
        )
      : null;
    if (numberTexture) {
      numberTexture.hasAlpha = true;
      // Billboard 从平面背面观察，预先水平翻转纹理以保证数字方向正确。
      numberTexture.uScale = -1;
      numberTexture.uOffset = 1;
    }
    const numberMaterial = new StandardMaterial(
      `${entityId}_${waypoint.id}_autoPatrolWaypointMaterial`,
      this.scene,
    );
    numberMaterial.disableLighting = true;
    numberMaterial.backFaceCulling = false;
    if (numberTexture) {
      numberMaterial.diffuseTexture = numberTexture;
      numberMaterial.opacityTexture = numberTexture;
    }
    numberMaterial.emissiveColor = Color3.White();
    const markerMaterial = new StandardMaterial(
      `${entityId}_${waypoint.id}_autoPatrolWaypointSphereMaterial`,
      this.scene,
    );
    markerMaterial.disableLighting = true;
    markerMaterial.backFaceCulling = false;
    markerMaterial.alpha = 0.38;
    const markerSphere = MeshBuilder.CreateSphere(
      `${entityId}_${waypoint.id}_autoPatrolWaypointSphere`,
      { diameter: 0.72, segments: 16 },
      this.scene,
    );
    markerSphere.parent = visualRoot;
    markerSphere.material = markerMaterial;
    markerSphere.renderingGroupId = 2;
    markerSphere.metadata = {
      editorEntityId: entityId,
      editorAutoPatrolMarker: true,
      editorAutoPatrolWaypointId: waypoint.id,
    } satisfies AutoPatrolMeshMetadata;
    const numberPlane = MeshBuilder.CreatePlane(
      `${entityId}_${waypoint.id}_autoPatrolWaypointMarker`,
      { size: 1.15 },
      this.scene,
    );
    numberPlane.parent = visualRoot;
    numberPlane.billboardMode = Mesh.BILLBOARDMODE_ALL;
    numberPlane.material = numberMaterial;
    numberPlane.renderingGroupId = 2;
    numberPlane.metadata = {
      editorEntityId: entityId,
      editorAutoPatrolMarker: true,
      editorAutoPatrolWaypointId: waypoint.id,
    } satisfies AutoPatrolMeshMetadata;

    const entry: WaypointEntry = {
      waypoint,
      index,
      root,
      visualRoot,
      markerSphere,
      markerMaterial,
      numberPlane,
      numberMaterial,
      numberTexture,
      textureState: '',
    };
    this.drawWaypointTexture(entry, WAYPOINT_COLOR, false);
    return entry;
  }

  private configureMarkerMesh(
    mesh: Mesh,
    entityId: string,
    waypointId: string | null,
    parent: TransformNode,
    material: StandardMaterial,
  ): void {
    mesh.parent = parent;
    mesh.material = material;
    mesh.receiveShadows = false;
    mesh.renderingGroupId = 2;
    mesh.metadata = {
      editorEntityId: entityId,
      editorAutoPatrolMarker: true,
      ...(waypointId ? { editorAutoPatrolWaypointId: waypointId } : {}),
    } satisfies AutoPatrolMeshMetadata;
  }

  private applyTransform(root: TransformNode, transform: TransformComponent): void {
    root.position.copyFromFloats(transform.position.x, transform.position.y, transform.position.z);
    root.rotationQuaternion = null;
    root.rotation.copyFromFloats(transform.rotation.x, transform.rotation.y, transform.rotation.z);
    root.scaling.setAll(1);
    root.computeWorldMatrix(true);
  }

  private applyWaypointTransform(
    entry: WaypointEntry,
    waypoint: AutoPatrolWaypoint,
    routeTransform: TransformComponent,
  ): void {
    const view = getAutoPatrolWaypointView(waypoint, routeTransform);
    entry.root.position.copyFromFloats(view.position.x, view.position.y, view.position.z);
    entry.root.rotationQuaternion = null;
    entry.root.rotation.copyFromFloats(
      -view.pitchDegrees * Math.PI / 180,
      view.headingDegrees * Math.PI / 180,
      0,
    );
    entry.root.scaling.setAll(1);
    entry.root.computeWorldMatrix(true);
  }

  private applyPresentation(entry: RouteEntry): void {
    const show = entry.visible && !this.previewActive && this.editorEnabled;
    const originColor = Color3.FromHexString(entry.selected ? ROUTE_SELECTED_COLOR : ROUTE_COLOR);
    entry.root.setEnabled(show);
    entry.originMaterial.diffuseColor = originColor;
    entry.originMaterial.emissiveColor = originColor;
    entry.originMaterial.alpha = entry.selected ? 1 : 0.68;
    for (const mesh of entry.originMeshes) {
      mesh.isVisible = show;
      mesh.isPickable = show && entry.pickable;
    }

    const showDetails = show && entry.selected;
    for (const waypoint of entry.waypoints.values()) {
      waypoint.root.setEnabled(showDetails);
      waypoint.numberPlane.isVisible = showDetails;
      waypoint.numberPlane.isPickable = showDetails && entry.pickable;
      waypoint.markerSphere.isVisible = showDetails;
      waypoint.markerSphere.isPickable = showDetails && entry.pickable;
    }
    if (entry.pathMesh) entry.pathMesh.isVisible = showDetails;
    for (const mesh of entry.detailMeshes) mesh.isVisible = showDetails;
    for (const region of entry.triggerRegions.values()) region.mesh.isVisible = showDetails;
    this.updateWaypointTextureStates(entry);
  }

  private updateWaypointTextureStates(entry: RouteEntry): void {
    for (const waypoint of entry.waypoints.values()) {
      const selected = entry.selectedWaypointId === waypoint.waypoint.id;
      const playback = this.playbackRouteId === entry.entity.id
        && this.playbackWaypointIndex === waypoint.index;
      const color = playback
        ? WAYPOINT_PLAYBACK_COLOR
        : selected
          ? WAYPOINT_SELECTED_COLOR
          : WAYPOINT_COLOR;
      const markerColor = Color3.FromHexString(color);
      waypoint.markerMaterial.diffuseColor = markerColor;
      waypoint.markerMaterial.emissiveColor = markerColor;
      waypoint.markerMaterial.alpha = selected || playback ? 0.58 : 0.38;
      this.drawWaypointTexture(waypoint, color, selected || playback);
    }
  }

  private drawWaypointTexture(entry: WaypointEntry, color: string, emphasized: boolean): void {
    const state = `${entry.index}:${color}:${emphasized ? 1 : 0}`;
    if (entry.textureState === state) return;
    entry.textureState = state;
    if (!entry.numberTexture) {
      const fallbackColor = Color3.FromHexString(color);
      entry.numberMaterial.diffuseColor = fallbackColor;
      entry.numberMaterial.emissiveColor = fallbackColor;
      return;
    }
    const context = entry.numberTexture.getContext() as unknown as CanvasRenderingContext2D;
    context.clearRect(0, 0, 128, 128);
    context.beginPath();
    context.arc(64, 64, emphasized ? 54 : 49, 0, Math.PI * 2);
    context.fillStyle = 'rgba(12, 28, 34, 0.92)';
    context.fill();
    context.lineWidth = emphasized ? 10 : 7;
    context.strokeStyle = color;
    context.stroke();
    context.fillStyle = color;
    context.font = `700 ${entry.index + 1 >= 100 ? 42 : entry.index + 1 >= 10 ? 52 : 62}px sans-serif`;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(String(entry.index + 1), 64, 67);
    entry.numberTexture.update(false);
  }

  private rebuildPath(entry: RouteEntry, routeTransform = entry.entity.components.transform): void {
    this.disposePath(entry);
    const component = entry.entity.components.autoPatrol;
    if (!component || !entry.selected || component.waypoints.length < 2) return;
    const points = sampleAutoPatrolWorldPath(component, routeTransform, 16)
      .map((point) => new Vector3(point.x, point.y, point.z));
    if (points.length < 2) return;
    const pathMesh = MeshBuilder.CreateLines(
      `${entry.entity.id}_autoPatrolPath`,
      { points },
      this.scene,
    );
    pathMesh.color = Color3.FromHexString(PATH_COLOR);
    pathMesh.alpha = 0.84;
    pathMesh.isPickable = false;
    pathMesh.renderingGroupId = 2;
    pathMesh.metadata = { editorAutoPatrolMarker: true } satisfies AutoPatrolMeshMetadata;
    entry.pathMesh = pathMesh;
  }

  private rebuildPathFromWaypointRoots(entry: RouteEntry): void {
    this.disposePath(entry);
    const component = entry.entity.components.autoPatrol;
    if (!component || !entry.selected || component.waypoints.length < 2) return;
    let points = component.waypoints
      .map((waypoint) => entry.waypoints.get(waypoint.id)?.root.position.clone())
      .filter((point): point is Vector3 => Boolean(point));
    const closed = component.playbackMode === 'loop';
    if (component.pathType === 'smooth' && points.length >= 2) {
      points = Curve3.CreateCatmullRomSpline(points, 16, closed).getPoints();
    } else if (closed && points.length > 1) {
      points.push(points[0].clone());
    }
    if (points.length < 2) return;
    const pathMesh = MeshBuilder.CreateLines(`${entry.entity.id}_autoPatrolPathPreview`, { points }, this.scene);
    pathMesh.color = Color3.FromHexString(PATH_COLOR);
    pathMesh.alpha = 0.84;
    pathMesh.isPickable = false;
    pathMesh.renderingGroupId = 2;
    pathMesh.metadata = { editorAutoPatrolMarker: true } satisfies AutoPatrolMeshMetadata;
    entry.pathMesh = pathMesh;
  }

  private rebuildSelectedWaypointDetails(entry: RouteEntry): void {
    this.disposeDetails(entry);
    const waypointId = entry.selectedWaypointId;
    if (!entry.selected || !waypointId) return;
    const waypoint = entry.waypoints.get(waypointId);
    if (!waypoint) return;

    const position = waypoint.root.position.clone();
    const heading = waypoint.root.rotation.y;
    const pitch = -waypoint.root.rotation.x;
    const cosPitch = Math.cos(pitch);
    const forward = new Vector3(
      Math.sin(heading) * cosPitch,
      Math.sin(pitch),
      Math.cos(heading) * cosPitch,
    ).normalize();
    const distance = Math.max(0.01, waypoint.waypoint.pose.radius);
    const target = position.add(forward.scale(distance));
    const worldUp = Math.abs(Vector3.Dot(forward, Vector3.Up())) > 0.98 ? Vector3.Right() : Vector3.Up();
    const right = Vector3.Cross(worldUp, forward).normalize();
    const up = Vector3.Cross(forward, right).normalize();
    const farDistance = Math.min(Math.max(distance * 0.28, 1), 24);
    const farCenter = position.add(forward.scale(farDistance));
    const halfHeight = farDistance * Math.tan(25 * Math.PI / 180);
    const halfWidth = halfHeight * 1.45;
    const corners = [
      farCenter.add(right.scale(halfWidth)).add(up.scale(halfHeight)),
      farCenter.subtract(right.scale(halfWidth)).add(up.scale(halfHeight)),
      farCenter.subtract(right.scale(halfWidth)).subtract(up.scale(halfHeight)),
      farCenter.add(right.scale(halfWidth)).subtract(up.scale(halfHeight)),
    ];
    const frustum = MeshBuilder.CreateLineSystem(
      `${entry.entity.id}_${waypointId}_autoPatrolFrustum`,
      {
        lines: [
          [position, corners[0]], [position, corners[1]], [position, corners[2]], [position, corners[3]],
          [corners[0], corners[1], corners[2], corners[3], corners[0]],
        ],
      },
      this.scene,
    );
    frustum.color = Color3.FromHexString(DETAIL_COLOR);
    frustum.alpha = 0.9;
    frustum.isPickable = false;
    frustum.renderingGroupId = 2;

    const targetLine = MeshBuilder.CreateLines(
      `${entry.entity.id}_${waypointId}_autoPatrolTargetLine`,
      { points: [position, target] },
      this.scene,
    );
    targetLine.color = Color3.FromHexString(TARGET_COLOR);
    targetLine.alpha = 0.86;
    targetLine.isPickable = false;
    targetLine.renderingGroupId = 2;
    for (const mesh of [frustum, targetLine]) {
      mesh.metadata = { editorAutoPatrolMarker: true } satisfies AutoPatrolMeshMetadata;
    }
    entry.detailMeshes = [frustum, targetLine];
  }

  private disposePath(entry: RouteEntry): void {
    entry.pathMesh?.dispose(false, false);
    entry.pathMesh = null;
  }

  private disposeDetails(entry: RouteEntry): void {
    for (const mesh of entry.detailMeshes) mesh.dispose(false, false);
    entry.detailMeshes = [];
  }

  private syncTriggerRegions(entry: RouteEntry): void {
    const component = entry.entity.components.autoPatrol;
    if (!component || !entry.selected) {
      this.disposeTriggerRegions(entry);
      return;
    }

    const currentIds = new Set((component.triggerRegions ?? []).map((region) => region.id));
    for (const [regionId, regionEntry] of entry.triggerRegions.entries()) {
      if (currentIds.has(regionId)) continue;
      this.disposeTriggerRegion(regionEntry);
      entry.triggerRegions.delete(regionId);
    }

    for (const region of component.triggerRegions ?? []) {
      const shape = region.shape ?? 'box';
      let regionEntry = entry.triggerRegions.get(region.id);
      if (regionEntry && (regionEntry.region.shape ?? 'box') !== shape) {
        this.disposeTriggerRegion(regionEntry);
        entry.triggerRegions.delete(region.id);
        regionEntry = undefined;
      }
      if (!regionEntry) {
        const material = new StandardMaterial(`${entry.entity.id}_${region.id}_autoPatrolRegionMaterial`, this.scene);
        material.disableLighting = true;
        material.backFaceCulling = false;
        const mesh = shape === 'sphere'
          ? MeshBuilder.CreateSphere(`${entry.entity.id}_${region.id}_autoPatrolRegion`, { diameter: 1, segments: 24 }, this.scene)
          : MeshBuilder.CreateBox(`${entry.entity.id}_${region.id}_autoPatrolRegion`, { size: 1 }, this.scene);
        mesh.parent = entry.root;
        mesh.material = material;
        mesh.isPickable = false;
        mesh.renderingGroupId = 1;
        mesh.metadata = { editorAutoPatrolMarker: true } satisfies AutoPatrolMeshMetadata;
        regionEntry = { region, mesh, material };
        entry.triggerRegions.set(region.id, regionEntry);
      }
      regionEntry.region = region;
      const color = Color3.FromHexString(region.color);
      regionEntry.material.diffuseColor = color;
      regionEntry.material.emissiveColor = color.scale(0.45);
      regionEntry.material.alpha = region.enabled ? 0.2 : 0.08;
      regionEntry.mesh.position.copyFromFloats(region.center.x, region.center.y, region.center.z);
      if (shape === 'sphere') {
        const radius = Math.max(0.01, region.radiusMeters ?? Math.max(region.size.x, region.size.y, region.size.z) / 2);
        regionEntry.mesh.scaling.setAll(radius * 2);
      } else {
        regionEntry.mesh.scaling.copyFromFloats(
          Math.max(0.01, Math.abs(region.size.x)),
          Math.max(0.01, Math.abs(region.size.y)),
          Math.max(0.01, Math.abs(region.size.z)),
        );
      }
      regionEntry.mesh.isVisible = entry.visible && !this.previewActive && region.enabled;
    }
  }

  private disposeTriggerRegions(entry: RouteEntry): void {
    for (const region of entry.triggerRegions.values()) this.disposeTriggerRegion(region);
    entry.triggerRegions.clear();
  }

  private disposeTriggerRegion(entry: TriggerRegionEntry): void {
    entry.mesh.dispose(false, false);
    entry.material.dispose(false, false);
  }

  private disposeWaypoint(entry: WaypointEntry): void {
    entry.markerSphere.dispose(false, false);
    entry.markerMaterial.dispose(false, false);
    entry.numberPlane.dispose(false, false);
    entry.numberMaterial.dispose(false, false);
    entry.numberTexture?.dispose();
    entry.visualRoot.dispose(false, false);
    entry.root.dispose(false, false);
  }

  private updateScreenScales(): void {
    if (!this.editorEnabled || this.previewActive) return;
    for (const entry of this.entries.values()) this.updateEntryScreenScales(entry);
  }

  private updateEntryScreenScales(entry: RouteEntry): void {
    if (!entry.visible || entry.root.isDisposed()) return;
    const camera = this.scene.cameraToUseForPointers ?? this.scene.activeCamera;
    if (!camera) return;
    entry.visualRoot.scaling.setAll(this.calculateWorldScale(camera, entry.root.getAbsolutePosition(), ROUTE_TARGET_PIXELS));
    entry.visualRoot.computeWorldMatrix(true);
    for (const waypoint of entry.waypoints.values()) {
      waypoint.visualRoot.scaling.setAll(this.calculateWorldScale(
        camera,
        waypoint.root.getAbsolutePosition(),
        WAYPOINT_TARGET_PIXELS,
      ));
      waypoint.visualRoot.computeWorldMatrix(true);
    }
  }

  private calculateWorldScale(camera: Camera, worldPosition: Vector3, targetPixels: number): number {
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
    const worldScale = visibleWorldHeight * targetPixels / renderHeight;
    return Math.min(MAX_WORLD_SCALE, Math.max(MIN_WORLD_SCALE, Number.isFinite(worldScale) ? worldScale : 1));
  }

  private canInteract(entry: RouteEntry): boolean {
    return this.editorEnabled && !this.previewActive && entry.visible && entry.pickable;
  }
}
