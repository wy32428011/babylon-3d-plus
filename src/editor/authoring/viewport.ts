import * as B from '@babylonjs/core';
import '@babylonjs/loaders/glTF';
import { createAuthoringGeometry } from './portableGeometry';
import { createAuthoringAppearance } from './portableAppearance';
import { evaluateExpression, resolveParameterValues, validateProject } from './expression';
import { createLegacyPreview } from './hostBridge';
import type { AuthoringSession, AuthoringProject, AuthoringNode, AuthoringIssue, PickedSurface, SurfaceAnchor, SurfaceRegion, Vec2, Vec3 } from './types';

export type ViewportTool = 'select' | 'faces' | 'place' | 'rectangle' | 'polygon';
type Callbacks = {
  onPick: (pick: PickedSurface, additive: boolean) => void;
  onPlace: (pick: PickedSurface) => void;
  onRegion: (region: Omit<SurfaceRegion, 'id' | 'label'>) => void;
  onIssues: (issues: AuthoringIssue[]) => void;
  onBusy: (busy: boolean) => void;
};
const tuple = (v: B.Vector3): Vec3 => [v.x, v.y, v.z];
const vector = (v: Vec3) => B.Vector3.FromArray(v);

export class AuthoringViewport {
  readonly engine: B.Engine;
  readonly scene: B.Scene;
  readonly camera: B.ArcRotateCamera;
  private root: B.TransformNode | null = null;
  private entityRoot: B.TransformNode | null = null;
  private geometry: ReturnType<typeof createAuthoringGeometry> | null = null;
  private appearance: ReturnType<typeof createAuthoringAppearance> | null = null;
  private legacy: Awaited<ReturnType<typeof createLegacyPreview>> = null;
  private session: AuthoringSession | null = null;
  private urls = new Map<string, string>();
  private loadVersion = 0;
  private disposed = false;
  private pending: AuthoringProject | null = null;
  private applying = false;
  private tool: ViewportTool = 'select';
  private selection = new Set<string>();
  private isolated = false;
  private original = false;
  private legacySignature = '';
  private lastApplied: { project: AuthoringProject; values: Record<string, any> } | null = null;
  private faceSelection: Record<string, number[]> = {};
  private frameError = '';
  private highlight: B.HighlightLayer;
  private resizeObserver: ResizeObserver;
  private meshIds = new Map<B.AbstractMesh, string>();
  private layerMasks = new WeakMap<B.AbstractMesh, number>();
  private down: { x: number; y: number; pick: PickedSurface | null } | null = null;
  private polygon: { anchor: SurfaceAnchor; points: Vec2[] } | null = null;
  private guide: B.LinesMesh | null = null;
  private faceOverlay: B.Mesh | null = null;
  private floor: B.Mesh;
  private grid: B.LinesMesh;
  private keyHandler: (e: KeyboardEvent) => void;

  constructor(private canvas: HTMLCanvasElement, private callbacks: Callbacks) {
    this.engine = new B.Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true, antialias: true });
    this.engine.setHardwareScalingLevel(Math.max(1, window.devicePixelRatio / 1.5));
    this.scene = new B.Scene(this.engine);
    this.scene.clearColor = new B.Color4(0.89, 0.92, 0.945, 1);
    this.scene.ambientColor = new B.Color3(0.55, 0.58, 0.62);
    this.camera = new B.ArcRotateCamera('authoring-camera', -Math.PI / 3, 1.1, 5, B.Vector3.Zero(), this.scene);
    this.camera.attachControl(canvas, true);
    this.camera.wheelDeltaPercentage = 0.015;
    this.camera.minZ = 0.001;
    this.camera.lowerRadiusLimit = 0.02;
    this.camera.panningSensibility = 200;
    new B.HemisphericLight('authoring-sky', new B.Vector3(0, 1, 0), this.scene).intensity = 1.5;
    const key = new B.DirectionalLight('authoring-key', new B.Vector3(-0.6, -1, 0.4), this.scene);
    key.intensity = 2;
    const fill = new B.DirectionalLight('authoring-fill', new B.Vector3(0.6, -0.3, -0.5), this.scene);
    fill.intensity = 1;
    this.floor = B.MeshBuilder.CreateGround('authoring-floor', { width: 1, height: 1 }, this.scene);
    this.floor.isPickable = false;
    const floorMaterial = new B.StandardMaterial('authoring-floor-material', this.scene);
    floorMaterial.diffuseColor = new B.Color3(0.81, 0.85, 0.89);
    floorMaterial.specularColor = B.Color3.Black();
    this.floor.material = floorMaterial;
    const lines: B.Vector3[][] = [];
    for (let i = -10; i <= 10; i++) {
      lines.push([new B.Vector3(i / 10, 0, -1), new B.Vector3(i / 10, 0, 1)]);
      lines.push([new B.Vector3(-1, 0, i / 10), new B.Vector3(1, 0, i / 10)]);
    }
    this.grid = B.MeshBuilder.CreateLineSystem('authoring-grid', { lines }, this.scene);
    this.grid.isPickable = false;
    this.grid.color = new B.Color3(0.64, 0.71, 0.77);
    this.highlight = new B.HighlightLayer('authoring-selection', this.scene);
    this.highlight.innerGlow = false;
    this.highlight.blurHorizontalSize = 0.6;
    this.highlight.blurVerticalSize = 0.6;
    this.resizeObserver = new ResizeObserver(() => this.engine.resize());
    this.resizeObserver.observe(canvas);
    this.scene.onPointerObservable.add(info => this.handlePointer(info));
    this.keyHandler = e => {
      if (document.activeElement !== this.canvas) return;
      if (e.key === 'Escape') { this.cancelDrawing(); this.callbacks.onIssues([]); }
      if (e.key === 'Enter' && this.polygon) { e.preventDefault(); this.finishPolygon(); }
      if (e.key.toLowerCase() === 'f') this.frameSelection();
    };
    canvas.addEventListener('keydown', this.keyHandler);
    this.engine.runRenderLoop(() => {
      if (this.disposed) return;
      if (!this.applying && !this.original && !this.frameError) {
        try {
          if (this.lastApplied) this.legacy?.update(this.lastApplied.values);
          this.appearance?.refreshAnchors();
        } catch (error) {
          this.frameError = error instanceof Error ? error.message : String(error);
          this.callbacks.onIssues([{ code: 'surface-anchor', severity: 'error', message: this.frameError }]);
        }
      }
      this.scene.render();
    });
  }

  private assetUrl(id: string): string {
    const known = this.urls.get(id);
    if (known) return known;
    const asset = this.session?.assets.get(id);
    if (!asset) throw new Error(`缺少资源：${id}`);
    const url = URL.createObjectURL(new Blob([new Uint8Array(asset.bytes)], { type: asset.mediaType }));
    this.urls.set(id, url);
    return url;
  }

  async load(session: AuthoringSession): Promise<AuthoringNode[]> {
    const ticket = ++this.loadVersion;
    this.callbacks.onBusy(true);
    this.pending = null;
    while (this.applying) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    this.clearModel();
    this.session = session;
    const source = session.project.source;
    if (!source) { this.callbacks.onBusy(false); return []; }
    this.entityRoot = new B.TransformNode('authoring-entity', this.scene);
    const root = new B.TransformNode('authoring-content', this.scene);
    root.parent = this.entityRoot;
    root.scaling.setAll(source.unitScale);
    this.root = root;
    try {
      const loaded = await B.SceneLoader.ImportMeshAsync('', '', this.assetUrl(source.modelAssetId), this.scene, undefined, '.glb');
      if (ticket !== this.loadVersion || this.disposed) {
        loaded.meshes.forEach(mesh => mesh.dispose()); root.dispose(); return [];
      }
      for (const node of [...loaded.meshes, ...loaded.transformNodes]) if (!node.parent) node.parent = root;
      root.computeWorldMatrix(true);
      this.legacy = await createLegacyPreview(root, session);
      if (ticket !== this.loadVersion || this.disposed) { this.clearModel(); return []; }
      this.geometry = createAuthoringGeometry(B, root, { unitScale: source.unitScale, evaluate: evaluateExpression });
      this.appearance = createAuthoringAppearance(B, this.scene, () => this.geometry!.getContext(), {
        resolveTexture: (id: string) => this.assetUrl(id), evaluate: evaluateExpression,
      });
      const nodes = this.geometry.inspect() as AuthoringNode[];
      this.refreshMeshIds();
      this.frameAll();
      this.legacySignature = JSON.stringify(resolveParameterValues(session.project.parameters).values);
      return nodes;
    } catch (error) {
      this.clearModel();
      throw error;
    } finally { if (ticket === this.loadVersion) this.callbacks.onBusy(false); }
  }

  updateSession(session: AuthoringSession): void {
    this.session = session;
    this.pending = session.project;
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.applying || !this.geometry || !this.appearance) return;
    this.applying = true;
    this.callbacks.onBusy(true);
    try {
      while (this.pending && !this.disposed) {
        const project = this.pending;
        this.pending = null;
        const result = resolveParameterValues(project.parameters);
        const validation = [...result.issues, ...validateProject(project)];
        if (validation.some((issue: AuthoringIssue) => issue.severity === 'error')) {
          this.callbacks.onIssues(validation); continue;
        }
        if (this.original) continue;
        const signature = JSON.stringify(result.values);
        if (this.legacy && signature !== this.legacySignature) {
          this.cancelDrawing(); this.faceOverlay?.dispose(false, true); this.faceOverlay = null;
          this.appearance.restore();
          this.geometry.restore();
          this.legacy.update(result.values);
          const error = this.legacy.getError();
          if (error) { await this.recoverLastApplied(); this.callbacks.onIssues([{ code: 'legacy', severity: 'error', message: error }]); continue; }
          this.geometry.rebase();
          this.legacySignature = signature;
        }
        const geometric = this.geometry.apply(project, result.values);
        if (!geometric.ok) { await this.recoverLastApplied(); this.callbacks.onIssues([...validation, ...geometric.issues]); continue; }
        const appearance = await this.appearance.apply(project, result.values);
        if (!appearance.ok) await this.recoverLastApplied();
        else { this.lastApplied = { project: structuredClone(project), values: { ...result.values } }; this.frameError = ''; }
        this.refreshMeshIds();
        this.updateSelection();
        this.setFaceSelection(this.faceSelection);
        this.callbacks.onIssues([...validation, ...geometric.issues, ...appearance.issues]);
      }
    } catch (error) {
      this.callbacks.onIssues([{ code: 'preview', severity: 'error', message: error instanceof Error ? error.message : String(error) }]);
    } finally { this.applying = false; this.callbacks.onBusy(false); }
  }

  private async recoverLastApplied(): Promise<void> {
    if (!this.lastApplied || !this.geometry || !this.appearance) return;
    const { project, values } = this.lastApplied;
    this.cancelDrawing(); this.faceOverlay?.dispose(false, true); this.faceOverlay = null;
    this.appearance.restore();
    if (this.legacy) { this.geometry.restore(); this.legacy.update(values); this.geometry.rebase(); this.legacySignature = JSON.stringify(values); }
    const geometry = this.geometry.apply(project, values);
    if (!geometry.ok) throw new Error(`无法恢复上一次预览：${geometry.issues.map(issue => issue.message).join('；')}`);
    const appearance = await this.appearance.apply(project, values);
    if (!appearance.ok) throw new Error(`无法恢复上一次外观：${appearance.issues.map(issue => issue.message).join('；')}`);
  }

  private refreshMeshIds(): void {
    this.meshIds.clear();
    const context = this.geometry?.getContext();
    if (!context) return;
    for (const [id, mesh] of context.meshes as Map<string, B.AbstractMesh>) this.meshIds.set(mesh, id);
    for (const item of context.generated ?? []) this.meshIds.set(item.mesh, item.sourceId);
  }

  setTool(tool: ViewportTool): void {
    this.cancelDrawing(); this.tool = tool;
    this.canvas.style.cursor = tool === 'select' ? 'default' : 'crosshair';
  }
  setSelection(ids: string[]): void { this.selection = new Set(ids); this.updateSelection(); }
  setFaceSelection(faces: Record<string, number[]>): void {
    this.faceSelection = faces;
    this.faceOverlay?.dispose(false, true); this.faceOverlay = null;
    const context = this.geometry?.getContext();
    if (!context || !this.root) return;
    const positions: number[] = [], indices: number[] = [];
    for (const [id, selected] of Object.entries(faces)) {
      const mesh = context.getMesh(id) as B.AbstractMesh | undefined;
      if (!mesh) continue;
      const source = mesh.getVerticesData(B.VertexBuffer.PositionKind), sourceIndices = mesh.getIndices();
      if (!source || !sourceIndices) continue;
      const matrix = context.getModelMatrix(mesh) as B.Matrix;
      for (const face of selected) {
        if (face < 0 || face * 3 + 2 >= sourceIndices.length) continue;
        const triangle = [0, 1, 2].map(i => B.Vector3.TransformCoordinates(B.Vector3.FromArray(source, Number(sourceIndices[face * 3 + i]) * 3), matrix));
        const normal = B.Vector3.Cross(triangle[1].subtract(triangle[0]), triangle[2].subtract(triangle[0])).normalize().scale(0.0002);
        for (const point of triangle) { const p = point.add(normal).scale(1 / context.unitScale); indices.push(positions.length / 3); positions.push(p.x, p.y, p.z); }
      }
    }
    if (!indices.length) return;
    const overlay = new B.Mesh('authoring-selected-faces', this.scene);
    const data = new B.VertexData(); data.positions = positions; data.indices = indices; data.applyToMesh(overlay);
    const material = new B.StandardMaterial('authoring-selected-faces-material', this.scene);
    material.emissiveColor = new B.Color3(0.05, 0.4, 0.9); material.disableLighting = true; material.alpha = 0.42; material.backFaceCulling = false;
    material.zOffset = -2; overlay.material = material; overlay.parent = this.root; overlay.isPickable = false; this.faceOverlay = overlay;
  }
  setIsolation(enabled: boolean): void { this.isolated = enabled; this.updateSelection(); }
  private updateSelection(): void {
    this.highlight.removeAllMeshes();
    for (const [mesh, id] of this.meshIds) {
      if (mesh.isDisposed()) continue;
      let mask = this.layerMasks.get(mesh);
      if (mask === undefined) {
        const source = this.geometry?.getContext().getMesh(id) as B.AbstractMesh | undefined;
        mask = source && source !== mesh ? this.layerMasks.get(source) ?? source.layerMask : mesh.layerMask;
        this.layerMasks.set(mesh, mask);
      }
      mesh.layerMask = this.isolated && !this.selection.has(id) ? 0 : mask;
      if (this.selection.has(id) && mesh instanceof B.Mesh && mesh.isEnabled()) this.highlight.addMesh(mesh, new B.Color3(0.12, 0.47, 0.83));
    }
  }

  setOriginal(enabled: boolean): void {
    this.original = enabled;
    if (enabled) { this.appearance?.restore(); this.geometry?.restore(); }
    else if (this.session) this.updateSession(this.session);
  }

  frameSelection(): void {
    const selected = [...this.meshIds].filter(([, id]) => this.selection.has(id)).map(([mesh]) => mesh);
    this.frame(selected.length ? selected : [...this.meshIds.keys()]);
  }
  frameAll(): void { this.frame([...this.meshIds.keys()]); }
  private frame(meshes: B.AbstractMesh[]): void {
    const valid = meshes.filter(mesh => mesh.getTotalVertices() > 0 && !mesh.isDisposed());
    if (!valid.length) return;
    let min = new B.Vector3(Infinity, Infinity, Infinity), max = new B.Vector3(-Infinity, -Infinity, -Infinity);
    for (const mesh of valid) {
      mesh.computeWorldMatrix(true);
      const box = mesh.getBoundingInfo().boundingBox;
      min = B.Vector3.Minimize(min, box.minimumWorld); max = B.Vector3.Maximize(max, box.maximumWorld);
    }
    const size = max.subtract(min), extent = Math.max(size.x, size.y, size.z, 0.1);
    this.camera.target.copyFrom(min.add(max).scale(0.5));
    this.camera.radius = extent * 1.8;
    this.camera.upperRadiusLimit = extent * 30;
    this.camera.lowerRadiusLimit = extent * 0.03;
    this.camera.minZ = Math.max(0.0001, extent / 10000);
    this.camera.maxZ = Math.max(100, extent * 100);
    this.camera.panningSensibility = 500 / extent;
    this.floor.scaling.set(extent * 5, 1, extent * 5);
    this.floor.position.set(this.camera.target.x, min.y - extent * 0.012, this.camera.target.z);
    this.grid.scaling.setAll(extent * 1.8);
    this.grid.position.copyFrom(this.floor.position); this.grid.position.y += extent * 0.001;
  }
  setView(view: 'front' | 'top' | 'iso'): void {
    this.camera.alpha = view === 'front' ? -Math.PI / 2 : -Math.PI / 3;
    this.camera.beta = view === 'top' ? 0.015 : view === 'front' ? Math.PI / 2 : 1.1;
  }

  private pick(x: number, y: number): PickedSurface | null {
    const hit = this.scene.pick(x, y, mesh => this.meshIds.has(mesh) && mesh.isVisible && mesh.visibility > 0 && mesh.isEnabled() && (mesh.layerMask & this.camera.layerMask) !== 0);
    if (!hit?.hit || !hit.pickedMesh || !hit.pickedPoint || hit.faceId < 0) return null;
    const mesh = hit.pickedMesh;
    const nodeId = this.meshIds.get(mesh)!;
    const context = this.geometry!.getContext();
    const baseMesh = context.getMesh(nodeId) as B.AbstractMesh;
    const positions = baseMesh.getVerticesData(B.VertexBuffer.PositionKind);
    const indices = baseMesh.getIndices();
    if (!positions || !indices) return null;
    const face = hit.faceId;
    const localPoint = B.Vector3.TransformCoordinates(hit.pickedPoint, B.Matrix.Invert(mesh.computeWorldMatrix(true)));
    const p = [0, 1, 2].map(i => B.Vector3.FromArray(positions, Number(indices[face * 3 + i]) * 3));
    const v0 = p[1].subtract(p[0]), v1 = p[2].subtract(p[0]), v2 = localPoint.subtract(p[0]);
    const d00 = B.Vector3.Dot(v0, v0), d01 = B.Vector3.Dot(v0, v1), d11 = B.Vector3.Dot(v1, v1);
    const denom = d00 * d11 - d01 * d01;
    if (Math.abs(denom) < 1e-20) return null;
    const b = (d11 * B.Vector3.Dot(v2, v0) - d01 * B.Vector3.Dot(v2, v1)) / denom;
    const c = (d00 * B.Vector3.Dot(v2, v1) - d01 * B.Vector3.Dot(v2, v0)) / denom;
    const matrix = context.getModelMatrix(baseMesh) as B.Matrix;
    const modelPoints = p.map(point => B.Vector3.TransformCoordinates(point, matrix));
    const normal = B.Vector3.Cross(modelPoints[1].subtract(modelPoints[0]), modelPoints[2].subtract(modelPoints[0])).normalize();
    const worldNormal = hit.getNormal(true, true);
    if (worldNormal && B.Vector3.Dot(normal, worldNormal) < 0) normal.scaleInPlace(-1);
    const tangent = B.Vector3.Cross(Math.abs(normal.y) < 0.95 ? B.Vector3.Up() : new B.Vector3(0, 0, -1), normal).normalize();
    return { nodeId, faceIndex: face, screen: [x, y], anchor: {
      nodeId, faceIndex: face, barycentric: [1 - b - c, b, c], point: tuple(B.Vector3.TransformCoordinates(localPoint, matrix)),
      normal: tuple(normal), tangent: tuple(tangent), referenceTriangle: modelPoints.map(tuple) as [Vec3, Vec3, Vec3],
    } };
  }

  private handlePointer(info: B.PointerInfo): void {
    const e = info.event as PointerEvent;
    if (e.button > 0 && info.type !== B.PointerEventTypes.POINTERMOVE) return;
    if (info.type === B.PointerEventTypes.POINTERDOWN) {
      this.canvas.focus();
      this.down = { x: this.scene.pointerX, y: this.scene.pointerY, pick: this.pick(this.scene.pointerX, this.scene.pointerY) };
      if (this.tool !== 'select') this.camera.detachControl();
    }
    if (info.type === B.PointerEventTypes.POINTERMOVE && this.down?.pick && this.tool === 'rectangle') {
      const current = this.pick(this.scene.pointerX, this.scene.pointerY);
      if (current) {
        const xy = this.toPlane(current.anchor.point, this.down.pick.anchor);
        this.drawGuide(this.down.pick.anchor, [[0, 0], [xy[0], 0], xy, [0, xy[1]], [0, 0]]);
      }
    }
    if (info.type !== B.PointerEventTypes.POINTERUP || !this.down) return;
    const down = this.down; this.down = null;
    this.camera.attachControl(this.canvas, true);
    const picked = this.pick(this.scene.pointerX, this.scene.pointerY);
    const distance = Math.hypot(this.scene.pointerX - down.x, this.scene.pointerY - down.y);
    if (!picked) { this.guide?.dispose(); this.guide = null; return; }
    if ((this.tool === 'select' || this.tool === 'faces') && distance < 7) this.callbacks.onPick(picked, e.shiftKey || e.ctrlKey || e.metaKey);
    if (this.tool === 'place') this.callbacks.onPlace(picked);
    if (this.tool === 'rectangle' && down.pick && distance >= 4) {
      const xy = this.toPlane(picked.anchor.point, down.pick.anchor);
      if (Math.abs(xy[0]) > 1e-5 && Math.abs(xy[1]) > 1e-5) this.callbacks.onRegion(this.regionFromPlane(down.pick.anchor, [[0, 0], [xy[0], 0], xy, [0, xy[1]]], 'rectangle'));
      this.cancelDrawing();
    }
    if (this.tool === 'polygon' && distance < 7) {
      if (!this.polygon) this.polygon = { anchor: picked.anchor, points: [[0, 0]] };
      else if (this.polygon.anchor.nodeId === picked.nodeId) this.polygon.points.push(this.toPlane(picked.anchor.point, this.polygon.anchor));
      this.drawGuide(this.polygon.anchor, this.polygon.points);
    }
  }

  private toPlane(point: Vec3, anchor: SurfaceAnchor): Vec2 {
    const delta = vector(point).subtract(vector(anchor.point));
    const tangent = vector(anchor.tangent), bitangent = B.Vector3.Cross(vector(anchor.normal), tangent).normalize();
    return [B.Vector3.Dot(delta, tangent), B.Vector3.Dot(delta, bitangent)];
  }
  private regionFromPlane(anchor: SurfaceAnchor, points: Vec2[], kind: 'rectangle' | 'polygon'): Omit<SurfaceRegion, 'id' | 'label'> {
    const minU = Math.min(...points.map(p => p[0])), maxU = Math.max(...points.map(p => p[0]));
    const minV = Math.min(...points.map(p => p[1])), maxV = Math.max(...points.map(p => p[1]));
    const width = Math.max(0.001, maxU - minU), height = Math.max(0.001, maxV - minV);
    const center: Vec2 = [(minU + maxU) / 2, (minV + maxV) / 2];
    return { kind, targets: [anchor.nodeId], faces: {}, anchor, width, height, depth: Math.max(0.005, Math.min(width, height) * 0.1), rotation: 0,
      offset: center, points: points.map(p => [(p[0] - center[0]) / width, (p[1] - center[1]) / height]), backfaces: false };
  }
  finishPolygon(): void {
    if (!this.polygon || this.polygon.points.length < 3) return;
    this.callbacks.onRegion(this.regionFromPlane(this.polygon.anchor, this.polygon.points, 'polygon'));
    this.cancelDrawing();
  }
  cancelDrawing(): void { this.polygon = null; this.down = null; this.guide?.dispose(); this.guide = null; this.camera.attachControl(this.canvas, true); }
  private drawGuide(anchor: SurfaceAnchor, points: Vec2[]): void {
    this.guide?.dispose();
    if (points.length < 2 || !this.root) return;
    const tangent = vector(anchor.tangent), bitangent = B.Vector3.Cross(vector(anchor.normal), tangent).normalize();
    const unit = this.session?.project.source?.unitScale ?? 1;
    const vertices = points.map(([u, v]) => vector(anchor.point).add(tangent.scale(u)).add(bitangent.scale(v)).add(vector(anchor.normal).scale(0.001)).scale(1 / unit));
    this.guide = B.MeshBuilder.CreateLines('authoring-region-guide', { points: vertices }, this.scene);
    this.guide.parent = this.root; this.guide.color = new B.Color3(0.9, 0.42, 0.08); this.guide.isPickable = false;
  }
  getNodeBounds(ids: string[]): { min: Vec3; max: Vec3 } | null {
    const context = this.geometry?.getContext();
    if (!context) return null;
    let minimum = new B.Vector3(Infinity, Infinity, Infinity), maximum = new B.Vector3(-Infinity, -Infinity, -Infinity);
    let found = false;
    for (const id of ids) {
      const mesh = context.getMesh(id) as B.AbstractMesh | undefined;
      const positions = mesh?.getVerticesData(B.VertexBuffer.PositionKind);
      if (!mesh || !positions) continue;
      const matrix = context.getModelMatrix(mesh) as B.Matrix;
      for (let i = 0; i < positions.length; i += 3) {
        const point = B.Vector3.TransformCoordinates(B.Vector3.FromArray(positions, i), matrix);
        minimum = B.Vector3.Minimize(minimum, point); maximum = B.Vector3.Maximize(maximum, point);
      }
      found = true;
    }
    return found ? { min: tuple(minimum), max: tuple(maximum) } : null;
  }
  getDiagnostics() { return { meshes: this.meshIds.size, selected: [...this.selection], sceneReady: this.scene.isReady(), applying: this.applying, nodes: this.geometry?.inspect() ?? [] }; }
  private clearModel(): void {
    this.highlight.removeAllMeshes(); this.guide?.dispose(); this.guide = null;
    this.faceOverlay?.dispose(false, true); this.faceOverlay = null;
    this.appearance?.dispose(); this.appearance = null;
    this.geometry?.dispose(); this.geometry = null;
    this.legacy?.dispose(); this.legacy = null;
    this.root?.dispose(false, true); this.root = null;
    this.entityRoot?.dispose(); this.entityRoot = null;
    for (const url of this.urls.values()) URL.revokeObjectURL(url);
    this.urls.clear(); this.meshIds.clear(); this.selection.clear(); this.legacySignature = ''; this.lastApplied = null; this.faceSelection = {}; this.frameError = '';
  }
  dispose(): void {
    this.disposed = true; this.loadVersion++; this.pending = null;
    this.canvas.removeEventListener('keydown', this.keyHandler);
    this.resizeObserver.disconnect(); this.engine.stopRenderLoop();
    this.clearModel(); this.highlight.dispose(); this.scene.dispose(); this.engine.dispose();
  }
}
