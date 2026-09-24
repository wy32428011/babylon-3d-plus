import {
  Color3, DynamicTexture, Material, Mesh, MeshBuilder, Scene, StandardMaterial, Texture,
  TransformNode, Vector3, VertexData,
} from '@babylonjs/core';
import type { PoiEffectComponent } from '../../../editor/model/components';

const KINDS = new Set(['alarm-icon', 'alarm-zone', 'alarm-label', 'alarm-route']);
const TAU = Math.PI * 2;
const MAX_ROUTE_POINTS = 128;
const MAX_ROUTE_ARROWS = 128;
type Geometry = { positions: number[]; indices: number[] };
type ColorRole = 'primary' | 'secondary' | 'canvas' | 'background';

export function supportsAlarmReferenceEffect(kind: string): boolean { return KINDS.has(kind); }

/** 参考图中的设备告警附件；仅使用本地几何和 Canvas，由 POI 唯一帧循环统一驱动。 */
export class AlarmReferenceEffects {
  readonly meshes: Mesh[] = [];
  readonly materials: Material[] = [];
  readonly textures: Texture[] = [];
  private active = true;
  private disposed = false;
  private phase = 0;
  private speed = 1;
  private topology = '';
  private textSignature = '';
  private labelTexture: DynamicTexture | null = null;
  private routePoints: Vector3[] = [];
  private routeLengths: number[] = [];
  private arrows: Mesh[] = [];

  constructor(private readonly id: string, private readonly scene: Scene, private readonly root: TransformNode,
    private component: PoiEffectComponent) {
    this.update(component);
  }

  private parameter(key: string): unknown { return this.component.configuration?.parameters[key]; }
  private number(key: string, fallback: number, min = 0, max = 10000): number {
    const value = this.parameter(key);
    return typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
  }
  private visual(key: 'radius' | 'height' | 'width' | 'opacity' | 'duration', fallback: number): number {
    const value = this.component.visual?.[key];
    return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : fallback;
  }
  private text(key: string, fallback: string): string {
    const value = this.parameter(key); return typeof value === 'string' ? value : fallback;
  }
  private topologySignature(): string {
    const kind = this.component.effectKind;
    const keys = kind === 'alarm-zone' ? ['segments', 'gapRatio', 'showWarning'] : kind === 'alarm-route' ? ['arrowSpacing'] : [];
    return JSON.stringify({ kind, parameters: keys.map(key => this.parameter(key)),
      shape: kind === 'alarm-zone' ? [this.visual('radius', 2.5), this.visual('width', .14)]
        : kind === 'alarm-route' ? [this.component.visual?.points, this.visual('width', .12)] : null });
  }

  update(component: PoiEffectComponent): void {
    if (this.disposed) return;
    this.component = component;
    this.updatePlaybackSpeed(component.speed);
    const topology = this.topologySignature();
    if (topology !== this.topology) {
      this.releaseResources();
      this.create();
      this.topology = topology;
      this.setActive(this.active);
    }
    this.updateMaterials();
    this.updateLayout();
    this.updateText();
    this.animate();
  }

  updatePlaybackSpeed(speed: number): void { this.speed = Number.isFinite(speed) ? Math.max(0, Math.min(5, speed)) : 0; }
  tick(deltaSeconds: number): void {
    if (this.disposed || !this.active || !Number.isFinite(deltaSeconds) || deltaSeconds <= 0 || this.speed === 0) return;
    this.phase = (this.phase + Math.min(.25, deltaSeconds) * this.speed / Math.max(.1, this.visual('duration', 2))) % 1;
    this.animate();
  }
  setActive(active: boolean): void { this.active = active; for (const mesh of this.meshes) mesh.setEnabled(active); }
  dispose(): void { if (this.disposed) return; this.disposed = true; this.releaseResources(); }

  private releaseResources(): void {
    for (const mesh of this.meshes) mesh.dispose(false, false);
    for (const material of this.materials) material.dispose(false, false);
    for (const texture of this.textures) texture.dispose();
    this.meshes.length = 0; this.materials.length = 0; this.textures.length = 0;
    this.arrows = []; this.routePoints = []; this.routeLengths = [];
    this.labelTexture = null; this.textSignature = '';
  }
  private material(role: ColorRole, opacity = 1): StandardMaterial {
    const material = new StandardMaterial(`${this.id}_${role}_${this.materials.length}`, this.scene);
    material.disableLighting = true; material.backFaceCulling = false; material.disableDepthWrite = true;
    material.diffuseColor = Color3.Black(); material.specularColor = Color3.Black();
    material.metadata = { alarmColorRole: role, alarmOpacity: opacity };
    this.materials.push(material); return material;
  }
  private own(mesh: Mesh, role: string, material: Material): Mesh {
    mesh.parent = this.root; mesh.material = material; mesh.isPickable = false;
    mesh.metadata = { editorEntityId: this.id, effectRole: role };
    this.meshes.push(mesh); return mesh;
  }
  private geometry(role: string, geometry: Geometry, material: Material): Mesh {
    const mesh = this.own(new Mesh(`${this.id}_${role}`, this.scene), role, material);
    const data = new VertexData(); data.positions = geometry.positions; data.indices = geometry.indices;
    data.normals = []; VertexData.ComputeNormals(data.positions, data.indices, data.normals); data.applyToMesh(mesh);
    return mesh;
  }
  private quad(data: Geometry, points: number[][]): void {
    const base = data.positions.length / 3; data.positions.push(...points.flat());
    data.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  private create(): void {
    switch (this.component.effectKind as string) {
      case 'alarm-icon': this.createIcon(); break;
      case 'alarm-zone': this.createZone(); break;
      case 'alarm-label': this.createLabel(); break;
      case 'alarm-route': this.createRoute(); break;
    }
  }
  private warningGeometry(): Geometry {
    const data: Geometry = { positions: [], indices: [] };
    const corners = [[0, .5], [-.5, -.38], [.5, -.38]];
    for (let index = 0; index < 3; index++) {
      const a = corners[index], b = corners[(index + 1) % 3];
      const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const dx = -(b[1] - a[1]) / length * .024, dy = (b[0] - a[0]) / length * .024;
      this.quad(data, [[a[0] + dx, a[1] + dy, 0], [b[0] + dx, b[1] + dy, 0], [b[0] - dx, b[1] - dy, 0], [a[0] - dx, a[1] - dy, 0]]);
    }
    this.quad(data, [[-.042, .22, 0], [.042, .22, 0], [.028, -.08, 0], [-.028, -.08, 0]]);
    this.quad(data, [[-.039, -.16, 0], [.039, -.16, 0], [.039, -.24, 0], [-.039, -.24, 0]]);
    return data;
  }
  private createIcon(): void {
    const geometry = this.warningGeometry();
    this.geometry('alarm-icon-halo', geometry, this.material('primary', .13)).billboardMode = Mesh.BILLBOARDMODE_ALL;
    this.geometry('alarm-icon', geometry, this.material('primary')).billboardMode = Mesh.BILLBOARDMODE_ALL;
    this.own(MeshBuilder.CreateCylinder(`${this.id}_stem`, { diameter: .015, height: 1, tessellation: 6 }, this.scene),
      'alarm-icon-stem', this.material('primary', .45));
  }
  private createZone(): void {
    const radius = Math.max(.05, this.visual('radius', 2.5)), width = Math.min(radius * .8, Math.max(.005, this.visual('width', .14)));
    const segments = Math.round(this.number('segments', 24, 4, 128)), gap = this.number('gapRatio', .24, 0, .8);
    const geometry: Geometry[] = [{ positions: [], indices: [] }, { positions: [], indices: [] }];
    for (let index = 0; index < segments; index++) {
      for (let step = 0; step < 4; step++) {
        const from = TAU * (index + gap / 2 + (1 - gap) * step / 4) / segments;
        const to = TAU * (index + gap / 2 + (1 - gap) * (step + 1) / 4) / segments;
        this.quad(geometry[index % 2], [[Math.cos(from) * radius, 0, Math.sin(from) * radius],
          [Math.cos(to) * radius, 0, Math.sin(to) * radius], [Math.cos(to) * (radius - width), 0, Math.sin(to) * (radius - width)],
          [Math.cos(from) * (radius - width), 0, Math.sin(from) * (radius - width)]]);
      }
    }
    this.geometry('alarm-zone-primary', geometry[0], this.material('primary'));
    this.geometry('alarm-zone-secondary', geometry[1], this.material('secondary'));
    this.own(MeshBuilder.CreateTorus(`${this.id}_zone_inner`, { diameter: (radius - width) * 2, thickness: Math.max(.005, width * .14), tessellation: 64 }, this.scene),
      'alarm-zone-inner', this.material('primary', .35));
    if (this.parameter('showWarning') !== false) {
      const canvas = this.createTexture(1024, 256);
      if (canvas) {
        const material = this.texturedMaterial(canvas);
        const warning = this.own(MeshBuilder.CreatePlane(`${this.id}_zone_warning`, { size: 1 }, this.scene), 'alarm-zone-warning', material);
        warning.rotation.x = Math.PI / 2;
      } else {
        const warning = this.geometry('alarm-zone-warning', this.warningGeometry(), this.material('secondary'));
        warning.rotation.x = Math.PI / 2;
      }
    }
  }
  private createTexture(width: number, height: number): DynamicTexture | null {
    // NullEngine 的单元测试不提供 Canvas；运行浏览器始终生成本地纹理，无远程字体或图片依赖。
    if (typeof document === 'undefined' && typeof OffscreenCanvas === 'undefined') return null;
    const texture = new DynamicTexture(`${this.id}_label`, { width, height }, this.scene, false);
    texture.hasAlpha = true; this.textures.push(texture); this.labelTexture = texture; return texture;
  }
  private texturedMaterial(texture: DynamicTexture): StandardMaterial {
    const material = this.material('canvas'); material.diffuseTexture = texture; material.emissiveTexture = texture;
    material.useAlphaFromDiffuseTexture = true; return material;
  }
  private createLabel(): void {
    const texture = this.createTexture(1024, 640);
    const card = this.own(MeshBuilder.CreatePlane(`${this.id}_card`, { size: 1 }, this.scene), 'alarm-label',
      texture ? this.texturedMaterial(texture) : this.material('background', .78));
    card.billboardMode = Mesh.BILLBOARDMODE_ALL;
    if (!texture) {
      const data: Geometry = { positions: [], indices: [] };
      this.quad(data, [[-.5, -.5, 0], [.5, -.5, 0], [.5, -.485, 0], [-.5, -.485, 0]]);
      this.quad(data, [[-.5, .485, 0], [.5, .485, 0], [.5, .5, 0], [-.5, .5, 0]]);
      this.quad(data, [[-.5, -.5, 0], [-.485, -.5, 0], [-.485, .5, 0], [-.5, .5, 0]]);
      this.quad(data, [[.485, -.5, 0], [.5, -.5, 0], [.5, .5, 0], [.485, .5, 0]]);
      this.geometry('alarm-label-frame', data, this.material('primary')).billboardMode = Mesh.BILLBOARDMODE_ALL;
    }
    this.own(MeshBuilder.CreateCylinder(`${this.id}_label_stem`, { diameter: .016, height: 1, tessellation: 6 }, this.scene),
      'alarm-label-stem', this.material('primary', .65));
  }

  private readRoute(): Vector3[] {
    const points: Vector3[] = [];
    for (const point of (this.component.visual?.points ?? []).slice(0, MAX_ROUTE_POINTS)) {
      if (!point || ![point.x, point.y, point.z].every(Number.isFinite)) continue;
      const vector = new Vector3(Math.max(-100000, Math.min(100000, point.x)), Math.max(-100000, Math.min(100000, point.y)), Math.max(-100000, Math.min(100000, point.z)));
      if (!points.length || Vector3.DistanceSquared(points.at(-1)!, vector) > .000001) points.push(vector);
    }
    // 最终指引始终落在报警设备，不能把普通路径模板的末点当成另一个故障位置。
    if (points.length > 1) points.pop();
    if (!points.length || points.every(point => point.lengthSquared() < .000001)) return [new Vector3(-6, 0, 0), Vector3.Zero()];
    if (points.at(-1)!.lengthSquared() > .000001) points.push(Vector3.Zero());
    return points;
  }
  private createRoute(): void {
    this.routePoints = this.readRoute();
    this.routeLengths = this.routePoints.map((point, index) => index ? Vector3.Distance(point, this.routePoints[index - 1]) : 0);
    for (let index = 1; index < this.routeLengths.length; index++) this.routeLengths[index] += this.routeLengths[index - 1];
    this.own(MeshBuilder.CreateTube(`${this.id}_route`, { path: this.routePoints, radius: Math.max(.005, this.visual('width', .12) * .2), tessellation: 6 }, this.scene),
      'alarm-route-line', this.material('primary', .35));
    const arrowMaterial = this.material('primary');
    const arrowData: Geometry = { positions: [-.5, 0, -.5, 0, 0, -.05, .5, 0, -.5, .5, 0, -.08, 0, 0, .42, -.5, 0, -.08], indices: [0, 1, 4, 0, 4, 5, 1, 2, 3, 1, 3, 4] };
    const count = Math.max(1, Math.min(MAX_ROUTE_ARROWS, Math.ceil(this.routeLengths.at(-1)! / this.number('arrowSpacing', .9, .05, 1000))));
    for (let index = 0; index < count; index++) this.arrows.push(this.geometry('alarm-route-arrow', arrowData, arrowMaterial));
    this.own(MeshBuilder.CreateTorus(`${this.id}_endpoint`, { diameter: 2, thickness: .04, tessellation: 48 }, this.scene),
      'alarm-route-endpoint', this.material('secondary'));
  }

  private updateMaterials(): void {
    const opacity = Math.min(1, this.visual('opacity', .8));
    const intensity = Number.isFinite(this.component.intensity) ? Math.max(0, Math.min(10, this.component.intensity)) : 1;
    for (const material of this.materials) if (material instanceof StandardMaterial) {
      const role: ColorRole = material.metadata.alarmColorRole;
      material.emissiveColor = (role === 'canvas' ? Color3.White() : role === 'background' ? Color3.FromHexString('#220610')
        : Color3.FromHexString(role === 'primary' ? this.component.primaryColor : this.component.secondaryColor)).scale(intensity);
      material.alpha = opacity * material.metadata.alarmOpacity;
    }
  }
  private updateLayout(): void {
    for (const mesh of this.meshes) {
      const role = mesh.metadata.effectRole as string;
      if (role === 'alarm-icon' || role === 'alarm-icon-halo') mesh.scaling.setAll(this.number('iconSize', .9, .05, 100) * (role === 'alarm-icon-halo' ? 1.13 : 1));
      if (role === 'alarm-icon-stem') {
        const length = Math.max(0, this.visual('height', .9) - this.number('iconSize', .9, .05, 100) * .5);
        mesh.scaling.y = Math.max(.001, length); mesh.position.y = length / 2;
        mesh.visibility = this.parameter('showStem') === false ? 0 : 1;
      }
      if (role.startsWith('alarm-zone-')) {
        mesh.position.y = this.number('elevation', .025, -.5, 1000);
        if (role === 'alarm-zone-warning') {
          const radius = this.visual('radius', 2.5);
          // 放在设备局部前方，避免默认视角下被设备本体遮住。
          mesh.position.z = -radius * .65; mesh.position.y += .006;
          mesh.scaling.set(radius * 1.25, this.labelTexture ? radius * .31 : radius * .55, 1);
        }
      }
      if (role === 'alarm-label' || role === 'alarm-label-frame') {
        mesh.scaling.set(this.number('cardWidth', 2.8, .2, 100), this.number('cardHeight', 1.7, .15, 100), 1);
        mesh.position.set(this.number('offsetX', 1.6, -10000, 10000), this.visual('height', 1.1), 0);
        mesh.metadata.timeText = this.text('timeText', '');
      }
      if (role === 'alarm-label-stem') {
        const end = new Vector3(this.number('offsetX', 1.6, -10000, 10000), Math.max(0, this.visual('height', 1.1) - this.number('cardHeight', 1.7, .15, 100) / 2), 0);
        mesh.scaling.y = Math.max(.001, end.length()); mesh.position.copyFrom(end.scale(.5));
        mesh.rotation.z = -Math.atan2(end.x, end.y);
      }
      if (role === 'alarm-route-line' || role === 'alarm-route-endpoint') mesh.position.y = this.number('elevation', .04, -.5, 1000);
      if (role === 'alarm-route-endpoint') {
        mesh.scaling.setAll(Math.max(.05, this.visual('radius', .45)));
        mesh.visibility = this.parameter('showEndpoint') === false ? 0 : 1;
      }
      if (role === 'alarm-route-arrow') mesh.scaling.setAll(this.number('arrowSize', .45, .05, 100));
    }
  }
  private animate(): void {
    for (const mesh of this.meshes) {
      if (mesh.metadata.effectRole === 'alarm-icon' || mesh.metadata.effectRole === 'alarm-icon-halo')
        mesh.position.y = this.visual('height', .9) + Math.sin(this.phase * TAU) * this.number('floatAmplitude', .1, 0, 10);
    }
    const total = this.routeLengths.at(-1) ?? 0;
    for (let index = 0; index < this.arrows.length; index++) {
      const distance = ((index + this.phase) / this.arrows.length) * total;
      let segment = 1;
      while (segment < this.routeLengths.length - 1 && this.routeLengths[segment] < distance) segment++;
      const start = this.routePoints[segment - 1], end = this.routePoints[segment];
      const t = (distance - this.routeLengths[segment - 1]) / Math.max(.000001, this.routeLengths[segment] - this.routeLengths[segment - 1]);
      const arrow = this.arrows[index], direction = end.subtract(start);
      Vector3.LerpToRef(start, end, t, arrow.position); arrow.position.y += this.number('elevation', .04, -.5, 1000) + .006;
      arrow.rotation.y = Math.atan2(direction.x, direction.z);
    }
  }

  private updateText(): void {
    if (!this.labelTexture) return;
    const signature = JSON.stringify({ kind: this.component.effectKind, color: this.component.primaryColor, secondary: this.component.secondaryColor,
      texts: ['title', 'severity', 'message', 'timeText', 'warningText'].map(key => this.parameter(key)), background: this.parameter('backgroundOpacity') });
    if (signature === this.textSignature) return;
    this.textSignature = signature;
    const context = this.labelTexture.getContext() as CanvasRenderingContext2D;
    if ((this.component.effectKind as string) === 'alarm-zone') this.drawZoneText(context); else this.drawCard(context);
    this.labelTexture.update();
  }
  private drawZoneText(context: CanvasRenderingContext2D): void {
    context.clearRect(0, 0, 1024, 256); context.strokeStyle = this.component.secondaryColor; context.fillStyle = this.component.secondaryColor;
    context.lineWidth = 9; context.lineJoin = 'round'; context.beginPath(); context.moveTo(135, 25); context.lineTo(35, 215); context.lineTo(235, 215); context.closePath(); context.stroke();
    context.font = 'bold 142px sans-serif'; context.textAlign = 'center'; context.fillText('!', 135, 192);
    context.font = 'bold 94px sans-serif'; context.textAlign = 'left'; context.fillText(this.text('warningText', '禁止靠近'), 290, 168, 700);
  }
  private drawCard(context: CanvasRenderingContext2D): void {
    context.clearRect(0, 0, 1024, 640);
    context.fillStyle = `rgba(35, 4, 12, ${this.number('backgroundOpacity', .78, 0, 1)})`;
    context.fillRect(15, 15, 994, 610); context.strokeStyle = this.component.primaryColor;
    context.lineWidth = 8; context.strokeRect(15, 15, 994, 610);
    context.fillStyle = this.component.primaryColor; context.fillRect(16, 16, 992, 12);
    context.textAlign = 'left'; context.fillStyle = '#ffffff'; context.font = 'bold 76px sans-serif';
    context.fillText(this.text('title', '').trim() || '设备报警', 55, 119, 908);
    context.lineWidth = 2; context.beginPath(); context.moveTo(55, 159); context.lineTo(969, 159); context.stroke();
    context.fillStyle = this.component.secondaryColor; context.font = 'bold 64px sans-serif';
    context.fillText(`⚠ ${this.text('severity', '严重告警')}`, 55, 248, 908);
    context.fillStyle = '#ffffff'; context.font = '52px sans-serif';
    context.fillText(this.text('message', '检测到异常，请及时处理'), 55, 360, 908);
    const time = this.text('timeText', '');
    if (time) { context.fillStyle = '#f4c3ca'; context.font = '42px sans-serif'; context.fillText(time, 55, 544, 908); }
    context.strokeStyle = this.component.primaryColor; context.lineWidth = 4;
    context.beginPath(); context.moveTo(52, 597); context.lineTo(150, 597); context.stroke();
  }
}
