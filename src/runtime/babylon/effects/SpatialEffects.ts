import {
  AbstractMesh, BoundingInfo, Color3, Constants, DynamicTexture, Material, Matrix, Mesh, MeshBuilder,
  Quaternion, Scene, ShaderMaterial, StandardMaterial, Texture, TransformNode, Vector3, VertexBuffer, VertexData,
} from '@babylonjs/core';
import type { PoiEffectComponent } from '../../../editor/model/components';

const KINDS = new Set([
  'boundary-flow', 'area-fill', 'ripple-ring', 'breathing-ring', 'radar-sector', 'light-pillar', 'energy-dome',
  'flow-path', 'flow-arrows', 'fly-line', 'motion-trail', 'path-reveal', 'pipe-flow', 'heatmap', 'region-level',
  'data-bars', 'camera-frustum', 'rain', 'snow', 'water-surface', 'flame', 'smoke-plume',
]);
const TAU = Math.PI * 2;
const MAX_POINTS = 128;
const MAX_PARTICLES = 1024;
type Config = NonNullable<PoiEffectComponent['visual']>;
type Mover = { mesh: Mesh; offset: number; arrow: boolean };

const SURFACE_VERTEX = `
precision highp float;
attribute vec3 position;
attribute vec2 uv;
#ifdef HEAT_VERTEX
attribute vec4 color;
varying vec4 vColor;
#endif
uniform mat4 worldViewProjection;
varying vec2 vUv;
varying vec3 vLocal;
void main() {
  vUv=uv; vLocal=position;
  #ifdef HEAT_VERTEX
  vColor=color;
  #endif
  gl_Position=worldViewProjection*vec4(position,1.0);
}`;

const SURFACE_FRAGMENT = `
precision highp float;
varying vec2 vUv;
varying vec3 vLocal;
#ifdef HEAT_VERTEX
varying vec4 vColor;
#endif
uniform vec3 primary;
uniform vec3 secondary;
uniform float opacity;
uniform float intensity;
uniform float time;
uniform float mode;
uniform float thickness;
uniform float progress;
uniform float amount;
const float PI=3.14159265359;
const float TAU=6.28318530718;
float line(float distance,float width) { return 1.0-smoothstep(width,width*1.8+0.0001,abs(distance)); }
void main() {
  vec2 p=vUv*2.0-1.0; float radius=length(p);
  float a=1.0; float glow=1.0; vec3 rgb=primary;
  if(mode<0.5) {
    float wave=pow(0.5+0.5*cos((vUv.x*amount-time)*TAU),14.0);
    a=(0.22+wave*0.78)*pow(max(0.0,1.0-abs(p.y)),0.65);
    rgb=mix(primary,secondary,wave); glow=0.7+wave*1.4;
  } else if(mode<1.5) {
    vec2 grid=abs(fract(vLocal.xz*0.25)-0.5);
    float gridLine=step(0.48,max(grid.x,grid.y)); a=0.30+gridLine*0.45;
  } else if(mode<2.5) {
    if(radius>1.0) discard;
    float ring=fract(radius*max(1.0,amount)-time);
    a=pow(1.0-ring,16.0)*smoothstep(0.0,0.12,radius)*(1.0-radius);
    glow=1.3; rgb=mix(primary,secondary,ring);
  } else if(mode<3.5) {
    float pulse=0.6+0.4*sin(time*TAU);
    float outer=line(radius-(0.82+0.025*pulse),thickness);
    float inner=line(radius-0.60,thickness*0.50);
    float tick=step(0.6,sin(atan(p.y,p.x)*72.0))*line(radius-0.94,0.014);
    a=(outer+inner*0.45+tick*0.65)*pulse; glow=1.2;
  } else if(mode<4.5) {
    if(radius>1.0) discard;
    float angle=fract(atan(p.y,p.x)/TAU-time+1.0);
    float sector=clamp(amount/360.0,0.015,0.95);
    float sweep=(1.0-smoothstep(0.0,sector,angle))*step(angle,sector);
    float rings=line(fract(radius*4.0),0.01)*0.28;
    a=(sweep*0.78+rings+line(radius-0.98,0.008))*smoothstep(0.0,0.04,radius);
    rgb=mix(primary,secondary,pow(sweep,8.0));
  } else if(mode<5.5) {
    float scan=pow(0.5+0.5*cos((vUv.y*3.0-time)*TAU),12.0);
    float columns=pow(abs(sin(vUv.x*TAU*8.0)),16.0);
    a=pow(1.0-vUv.y,0.7)*(0.15+scan*0.4+columns*0.4); glow=1.3;
  } else if(mode<6.5) {
    vec2 cells=vec2(vUv.x*36.0,vUv.y*14.0);
    cells.x+=mod(floor(cells.y),2.0)*0.5;
    vec2 cell=abs(fract(cells)-0.5);
    float hexEdge=line(max(cell.x*0.866+cell.y*0.5,cell.y)-0.45,0.028);
    a=(0.08+hexEdge*0.55)*(0.7+0.3*sin(time*TAU));
    rgb=mix(primary,secondary,hexEdge); glow=1.2;
  } else if(mode<7.5) {
    float lit=step(vUv.x,progress);
    a=(0.12+lit*0.88)*pow(max(0.0,1.0-abs(p.y)),0.5);
    rgb=mix(secondary*0.35,primary,lit);
  } else if(mode<8.5) {
    float waves=sin(vLocal.x*2.3+time*TAU)*cos(vLocal.z*1.7-time*TAU*2.0);
    float fine=sin((vLocal.x+vLocal.z)*5.0+time*TAU*3.0);
    float crest=pow(clamp(waves*0.55+fine*0.2+0.3,0.0,1.0),7.0);
    rgb=mix(primary*0.45,secondary,crest); a=0.55+crest*0.4;
  } else if(mode>9.5) {
    a=pow(vUv.x,1.6)*pow(max(0.0,1.0-abs(p.y)),0.65);
    rgb=mix(primary,secondary,vUv.x); glow=1.3;
  }
  #ifdef HEAT_VERTEX
  rgb=vColor.rgb; a=vColor.a;
  #endif
  if(a*opacity<0.001) discard;
  gl_FragColor=vec4(rgb*intensity*glow,a*opacity);
}`;

const PARTICLE_VERTEX = `
precision highp float;
attribute vec3 position;
attribute vec2 uv;
attribute vec4 color;
uniform mat4 world;
uniform mat4 view;
uniform mat4 projection;
uniform float time;
uniform float height;
uniform float radius;
uniform float size;
uniform float mode;
varying vec2 vUv;
varying float age;
varying float seed;
void main() {
  vUv=uv; seed=color.r; age=fract(color.b+time);
  vec3 center=position;
  if(mode<1.5) {
    center.y=height*(1.0-age);
    if(mode>0.5) center.xz+=vec2(sin((age+seed)*6.283),cos((age+seed)*6.283))*radius*0.035;
  } else {
    center.y=height*age;
    center.xz*=0.35+age;
    center.x+=sin(age*8.0+seed*6.283)*radius*age*0.3;
  }
  vec4 viewPosition=view*world*vec4(center,1.0);
  float scale=size*(0.55+color.a*0.45);
  if(mode>1.5) scale*=0.55+age*1.5;
  vec2 quad=(uv-0.5)*scale;
  if(mode<0.5) quad.x*=0.055;
  if(mode>1.5&&mode<2.5) quad.y*=1.7;
  viewPosition.xy+=quad;
  gl_Position=projection*viewPosition;
}`;

const PARTICLE_FRAGMENT = `
precision highp float;
varying vec2 vUv;
varying float age;
varying float seed;
uniform float mode;
uniform float opacity;
uniform float intensity;
uniform vec3 primary;
uniform vec3 secondary;
float hash(vec2 p) { return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }
float noise(vec2 p) {
  vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
  return mix(mix(hash(i),hash(i+vec2(1.0,0.0)),f.x),mix(hash(i+vec2(0.0,1.0)),hash(i+vec2(1.0)),f.x),f.y);
}
void main() {
  vec2 p=vUv*2.0-1.0;
  float alpha=1.0; vec3 rgb=primary;
  if(mode<0.5) alpha=(1.0-abs(p.x))*pow(1.0-abs(p.y),0.4);
  else if(mode<1.5) alpha=1.0-smoothstep(0.25,1.0,length(p));
  else if(mode<2.5) {
    float warp=noise(p*4.0+vec2(seed*10.0,-age*5.0));
    alpha=clamp(1.0-length(vec2(p.x*(1.0+vUv.y),p.y))-warp*0.3,0.0,1.0);
    alpha*=smoothstep(0.0,0.15,age)*(1.0-age); rgb=mix(secondary,primary,age);
  } else {
    float cloud=noise(p*3.0+seed*10.0)*0.65+noise(p*7.0)*0.35;
    alpha=(1.0-smoothstep(0.25,1.0,length(p)))*cloud*smoothstep(0.0,0.15,age)*(1.0-age);
    rgb=mix(primary,secondary,age);
  }
  if(alpha*opacity<0.001) discard;
  gl_FragColor=vec4(rgb*intensity,alpha*opacity);
}`;

/** 与旧版 POI 类型独立的空间组件集合；稳定类型由场景文件持久化。 */
export function supportsSpatialEffect(kind: string): boolean { return KINDS.has(kind); }

/** 所有动画由 POI 的唯一帧循环驱动，创建与释放均限制在该实体自己的资源内。 */
export class SpatialEffects {
  readonly meshes: Mesh[] = [];
  readonly materials: Material[] = [];
  readonly textures: Texture[] = [];
  private readonly config: Config;
  private readonly path: Vector3[];
  private readonly lengths: number[];
  private readonly movers: Mover[] = [];
  private readonly revealNodes: { mesh: Mesh; fraction: number; lit: Material; dim: Material }[] = [];
  private readonly shaders: ShaderMaterial[] = [];
  private elapsed = 0;
  private playbackSpeed = 0;
  private active = true;
  private disposed = false;
  private trail: Mesh | null = null;
  private readonly history: Vector3[] = [];
  private trailTarget: TransformNode | AbstractMesh | null = null;
  private targetRetry = 0;
  private trailIdleSeconds = 0;

  constructor(
    private readonly id: string,
    private readonly scene: Scene,
    private readonly root: TransformNode,
    private readonly component: PoiEffectComponent,
    private readonly resolveTarget?: (id: string) => TransformNode | AbstractMesh | null,
  ) {
    if (!component.visual) throw new Error(`空间特效缺少规范化参数：${id}`);
    this.updatePlaybackSpeed(component.speed);
    this.config = component.visual;
    this.path = this.readPath();
    this.lengths = this.path.map((point, index) => index ? Vector3.Distance(point, this.path[index - 1]) : 0);
    for (let index = 1; index < this.lengths.length; index += 1) this.lengths[index] += this.lengths[index - 1];
    this.create();
    this.updateAnimation();
  }

  tick(deltaSeconds: number): void {
    if (!this.active || this.disposed || this.playbackSpeed <= 0 || !Number.isFinite(deltaSeconds) || deltaSeconds <= 0) return;
    const duration = Math.max(0.05, this.config.duration);
    if (!this.config.loop && this.elapsed >= duration) return;
    const advance = Math.min(deltaSeconds, 0.25) * this.playbackSpeed;
    this.elapsed += advance;
    this.elapsed = this.config.loop ? this.elapsed % duration : Math.min(duration, this.elapsed);
    this.updateAnimation();
    if (this.trail && this.config.targetEntityId) this.updateTargetTrail(advance);
  }

  /** 调速不改变现有相位或资源，也不修改传入的场景组件对象。 */
  updatePlaybackSpeed(speed: number): void {
    this.playbackSpeed = Number.isFinite(speed) ? Math.min(5, Math.max(0, speed)) : 0;
  }

  setActive(active: boolean): void {
    this.active = active;
    for (const mesh of this.meshes) mesh.setEnabled(active);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const mesh of this.meshes) mesh.dispose(false, false);
    for (const material of this.materials) material.dispose(false, false);
    for (const texture of this.textures) texture.dispose();
    this.history.length = 0;
    this.trailTarget = null;
  }

  private readPath(): Vector3[] {
    const points: Vector3[] = [];
    const isData = ['heatmap', 'region-level', 'data-bars'].includes(this.component.effectKind);
    for (const point of this.config.points.slice(0, MAX_POINTS)) {
      if (![point.x, point.y, point.z].every(Number.isFinite)) continue;
      const vector = new Vector3(point.x, point.y, point.z);
      // 数据点按索引与 values 配对，同位置的多个观测也必须保留，不能按路径去重。
      if (isData || !points.length || Vector3.DistanceSquared(points[points.length - 1], vector) > 0.000001) points.push(vector);
    }
    if (isData && points.length) return points;
    if (points.length >= 2) return points;
    const radius = this.config.radius;
    return [new Vector3(-radius, 0.03, 0), new Vector3(0, 0.03, radius * 0.5), new Vector3(radius, 0.03, 0)];
  }

  private mesh(mesh: Mesh, role: string, material: Material): Mesh {
    mesh.parent = this.root;
    mesh.material = material;
    mesh.isPickable = false;
    mesh.metadata = { editorEntityId: this.id, effectRole: role };
    this.meshes.push(mesh);
    return mesh;
  }

  private surface(mode: number, additive = true, heat = false): ShaderMaterial {
    const material = new ShaderMaterial(`${this.id}_surface_${this.materials.length}`, this.scene,
      { vertexSource: SURFACE_VERTEX, fragmentSource: SURFACE_FRAGMENT }, {
        attributes: heat ? ['position', 'uv', 'color'] : ['position', 'uv'],
        uniforms: ['worldViewProjection', 'primary', 'secondary', 'opacity', 'intensity', 'time', 'mode', 'thickness', 'progress', 'amount'],
        defines: heat ? ['#define HEAT_VERTEX'] : [], needAlphaBlending: true,
      });
    material.setFloat('mode', mode);
    material.setFloat('thickness', Math.min(0.15, this.config.width / Math.max(0.01, this.config.radius)));
    material.setFloat('amount', mode === 4 ? this.config.amount : Math.max(1, Math.min(12, this.config.amount)));
    this.prepareShader(material, additive);
    return material;
  }

  private prepareShader(material: ShaderMaterial, additive: boolean): void {
    material.backFaceCulling = false;
    material.disableDepthWrite = true;
    material.alphaMode = additive ? Constants.ALPHA_ADD : Constants.ALPHA_COMBINE;
    material.setColor3('primary', Color3.FromHexString(this.component.primaryColor));
    material.setColor3('secondary', Color3.FromHexString(this.component.secondaryColor));
    material.setFloat('opacity', this.config.opacity);
    material.setFloat('intensity', this.component.intensity);
    material.setFloat('time', 0);
    this.materials.push(material);
    this.shaders.push(material);
  }

  private solid(color: string | Color3, alpha = this.config.opacity): StandardMaterial {
    const material = new StandardMaterial(`${this.id}_solid_${this.materials.length}`, this.scene);
    material.disableLighting = true;
    material.emissiveColor = (typeof color === 'string' ? Color3.FromHexString(color) : color).scale(this.component.intensity);
    material.diffuseColor = Color3.Black();
    material.alpha = alpha;
    material.backFaceCulling = false;
    material.disableDepthWrite = alpha < 1;
    this.materials.push(material);
    return material;
  }

  private create(): void {
    const kind = this.component.effectKind;
    if (['rain', 'snow', 'flame', 'smoke-plume'].includes(kind)) { this.createParticles(kind); return; }
    if (kind === 'heatmap') { this.createHeatmap(); return; }
    if (kind === 'region-level' || kind === 'data-bars') { this.createData(kind); return; }
    if (kind === 'camera-frustum') { this.createFrustum(); return; }
    if (kind === 'area-fill') { this.createArea(); return; }
    if (kind === 'light-pillar' || kind === 'energy-dome') { this.createVolume(kind); return; }
    if (['ripple-ring', 'breathing-ring', 'radar-sector', 'water-surface'].includes(kind)) {
      const modes: Record<string, number> = { 'ripple-ring': 2, 'breathing-ring': 3, 'radar-sector': 4, 'water-surface': 8 };
      const ground = MeshBuilder.CreateGround(`${this.id}_${kind}`, { width: this.config.radius * 2, height: this.config.radius * 2 }, this.scene);
      this.mesh(ground, kind, this.surface(modes[kind], kind !== 'water-surface')).position.y = 0.025;
      return;
    }
    this.createPath(kind);
  }

  private createPath(kind: string): void {
    let path = this.path;
    if (kind === 'boundary-flow') path = [...path, path[0]];
    if (kind === 'fly-line') {
      const [start, end] = [path[0], path[path.length - 1]];
      path = Array.from({ length: 65 }, (_, index) => {
        const t = index / 64;
        const point = Vector3.Lerp(start, end, t); point.y += this.config.height * 4 * t * (1 - t); return point;
      });
    }
    if (kind === 'motion-trail') {
      const budget = Math.max(8, Math.min(MAX_POINTS, Math.round(this.config.amount)));
      this.trail = this.ribbon(Array.from({ length: budget }, () => path[0].clone()), 'motion-history', this.surface(10), true);
      this.trail.metadata.trailMode = this.config.targetEntityId ? 'target' : 'path-demo';
      if (this.config.targetEntityId) this.trail.visibility = 0;
      return;
    }
    if (kind === 'pipe-flow' || kind === 'fly-line') {
      const tube = MeshBuilder.CreateTube(`${this.id}_${kind}`, { path, radius: this.config.width * (kind === 'pipe-flow' ? 0.5 : 0.12), tessellation: 8 }, this.scene);
      // Babylon Tube 的默认纵向 UV 方向不同，使用实际弧长重写，使动画方向与路径一致。
      this.assignTubeUvs(tube, path);
      this.mesh(tube, kind === 'fly-line' ? 'fly-arc' : 'pipe-shell', this.surface(0));
    } else {
      this.ribbon(path, kind === 'path-reveal' ? 'path-progress' : 'path-ribbon', this.surface(kind === 'path-reveal' ? 7 : 0));
    }
    if (kind === 'flow-arrows' || kind === 'pipe-flow') this.createMovers(kind);
    if (kind === 'path-reveal') {
      const lit = this.solid(this.component.primaryColor);
      const dim = this.solid(this.component.secondaryColor, this.config.opacity * 0.2);
      path.forEach((point, index) => {
        const mesh = this.mesh(MeshBuilder.CreateSphere(`${this.id}_node`, { diameter: this.config.width * 2, segments: 4 }, this.scene), 'path-node', dim);
        mesh.position.copyFrom(point);
        this.revealNodes.push({ mesh, fraction: this.lengths[index] / Math.max(0.001, this.lengths[this.lengths.length - 1]), lit, dim });
      });
    }
  }

  private ribbon(path: Vector3[], role: string, material: Material, updatable = false): Mesh {
    const mesh = new Mesh(`${this.id}_${role}`, this.scene);
    const data = this.ribbonData(path);
    data.applyToMesh(mesh, updatable);
    return this.mesh(mesh, role, material);
  }

  private ribbonData(path: Vector3[]): VertexData {
    const positions: number[] = [], indices: number[] = [], uvs: number[] = [];
    let total = 0;
    const lengths = path.map((point, index) => { if (index) total += Vector3.Distance(point, path[index - 1]); return total; });
    for (let index = 0; index < path.length; index += 1) {
      const tangent = path[Math.min(index + 1, path.length - 1)].subtract(path[Math.max(0, index - 1)]);
      const side = Vector3.Cross(tangent, Vector3.Up());
      if (side.lengthSquared() < 0.00001) side.set(1, 0, 0);
      side.normalize().scaleInPlace(this.config.width * 0.5);
      for (const sign of [-1, 1]) {
        const point = path[index].add(side.scale(sign)); positions.push(point.x, point.y + 0.035, point.z);
        uvs.push(total > 0 ? lengths[index] / total : index / Math.max(1, path.length - 1), (sign + 1) / 2);
      }
      if (index < path.length - 1) { const v = index * 2; indices.push(v, v + 1, v + 2, v + 1, v + 3, v + 2); }
    }
    const data = new VertexData(); data.positions = positions; data.indices = indices; data.uvs = uvs; return data;
  }

  private assignTubeUvs(mesh: Mesh, path: Vector3[]): void {
    const uvs = mesh.getVerticesData(VertexBuffer.UVKind);
    if (!uvs) return;
    let total = 0;
    const distances = path.map((point, index) => { if (index) total += Vector3.Distance(point, path[index - 1]); return total; });
    const ringSize = mesh.getTotalVertices() / path.length;
    for (let vertex = 0; vertex < mesh.getTotalVertices(); vertex += 1) {
      const ring = Math.min(path.length - 1, Math.floor(vertex / ringSize));
      uvs[vertex * 2] = distances[ring] / Math.max(0.0001, total);
      uvs[vertex * 2 + 1] = 0.5;
    }
    mesh.setVerticesData(VertexBuffer.UVKind, uvs);
  }

  private createMovers(kind: string): void {
    const count = Math.max(2, Math.min(64, Math.round(this.config.amount * this.component.density)));
    const material = this.solid(this.component.primaryColor);
    for (let index = 0; index < count; index += 1) {
      let mesh: Mesh;
      if (kind === 'flow-arrows') {
        mesh = new Mesh(`${this.id}_arrow_${index}`, this.scene);
        const scale = this.config.width * 2.5;
        const data = new VertexData();
        data.positions = [-0.6, 0, -0.5, 0, 0, 0.2, 0.6, 0, -0.5, 0.6, 0, -0.15, 0, 0, 0.65, -0.6, 0, -0.15].map(value => value * scale);
        data.indices = [0, 1, 5, 1, 4, 5, 1, 2, 3, 1, 3, 4];
        data.applyToMesh(mesh);
      } else mesh = MeshBuilder.CreateSphere(`${this.id}_flow_${index}`, { diameter: this.config.width * 0.65, segments: 4 }, this.scene);
      this.mesh(mesh, kind === 'flow-arrows' ? 'moving-arrow' : 'moving-fluid', material);
      this.movers.push({ mesh, offset: index / count, arrow: kind === 'flow-arrows' });
    }
  }

  private pointOnPath(fraction: number): { point: Vector3; tangent: Vector3 } {
    const distance = Math.max(0, Math.min(1, fraction)) * this.lengths[this.lengths.length - 1];
    let index = 1;
    while (index < this.lengths.length - 1 && this.lengths[index] < distance) index += 1;
    const start = this.path[index - 1], end = this.path[index];
    const t = (distance - this.lengths[index - 1]) / Math.max(0.000001, this.lengths[index] - this.lengths[index - 1]);
    return { point: Vector3.Lerp(start, end, t), tangent: end.subtract(start).normalize() };
  }

  private updateAnimation(): void {
    const phase = this.elapsed / Math.max(0.05, this.config.duration);
    const progress = this.component.effectKind === 'path-reveal' ? Math.min(1, this.config.progress + phase) : this.config.progress;
    for (const shader of this.shaders) { shader.setFloat('time', phase); shader.setFloat('progress', progress); }
    for (const node of this.revealNodes) node.mesh.material = node.fraction <= progress ? node.lit : node.dim;
    for (const mover of this.movers) {
      const fraction = this.config.loop ? (mover.offset + phase) % 1 : Math.min(1, mover.offset + phase);
      const sample = this.pointOnPath(fraction);
      mover.mesh.position.copyFrom(sample.point);
      mover.mesh.position.y += 0.055;
      if (mover.arrow) {
        // 箭头尖端沿局部 +Z，旋转基的 +Z 必须与路径切线一致。
        // 斜坡和竖直路径先构造正交 up，避免非正交输入造成偏转和形变。
        const referenceUp = Math.abs(sample.tangent.y) > 0.99 ? Vector3.Right() : Vector3.Up();
        const right = Vector3.Cross(referenceUp, sample.tangent).normalize();
        const up = Vector3.Cross(sample.tangent, right).normalize();
        mover.mesh.rotationQuaternion ??= Quaternion.Identity();
        Quaternion.FromLookDirectionRHToRef(sample.tangent, up, mover.mesh.rotationQuaternion);
      }
    }
    if (this.trail && !this.config.targetEntityId) {
      const count = this.trail.getTotalVertices() / 2;
      const samples = Array.from({ length: count }, (_, index) => {
        const fraction = phase - (count - 1 - index) / count * 0.22;
        return this.pointOnPath(Math.max(0, fraction)).point;
      });
      this.updateTrailMesh(samples);
    }
  }

  private updateTargetTrail(deltaSeconds: number): void {
    this.trailIdleSeconds += deltaSeconds;
    const material = this.trail!.material as ShaderMaterial;
    material.setFloat('opacity', this.config.opacity * Math.max(0, 1 - this.trailIdleSeconds / this.config.duration));
    if (this.trailIdleSeconds >= this.config.duration) {
      this.history.length = 0;
      this.trail!.visibility = 0;
    }
    this.targetRetry -= deltaSeconds;
    if ((!this.trailTarget || this.trailTarget.isDisposed()) && this.targetRetry <= 0) {
      this.trailTarget = this.resolveTarget?.(this.config.targetEntityId!) ?? null;
      this.targetRetry = 0.5;
    }
    if (!this.trailTarget || this.trailTarget.isDisposed()) return;
    this.trailTarget.computeWorldMatrix(true);
    this.root.computeWorldMatrix(true);
    const local = Vector3.TransformCoordinates(this.trailTarget.getAbsolutePosition(), Matrix.Invert(this.root.getWorldMatrix()));
    const last = this.history[this.history.length - 1];
    if (last && Vector3.DistanceSquared(last, local) < 0.0001) return;
    this.trailIdleSeconds = 0;
    material.setFloat('opacity', this.config.opacity);
    this.history.push(local);
    const count = this.trail!.getTotalVertices() / 2;
    if (this.history.length > count) this.history.shift();
    const samples = Array.from({ length: count }, (_, index) => this.history[Math.max(0, index - (count - this.history.length))]);
    this.updateTrailMesh(samples);
    this.trail!.visibility = this.history.length > 1 ? 1 : 0;
  }

  private updateTrailMesh(samples: Vector3[]): void {
    if (!this.trail) return;
    const data = this.ribbonData(samples);
    this.trail.updateVerticesData(VertexBuffer.PositionKind, data.positions!, true);
    this.trail.updateVerticesData(VertexBuffer.UVKind, data.uvs!);
  }

  private createVolume(kind: string): void {
    const { radius, height } = this.config;
    if (kind === 'light-pillar') {
      const pillar = MeshBuilder.CreateCylinder(`${this.id}_pillar`, { diameterBottom: radius * 0.35, diameterTop: radius * 0.12, height, tessellation: 48, cap: Mesh.NO_CAP }, this.scene);
      this.mesh(pillar, 'light-column', this.surface(5)).position.y = height * 0.5;
    } else {
      const dome = new Mesh(`${this.id}_dome`, this.scene);
      const positions: number[] = [], indices: number[] = [], uvs: number[] = [];
      for (let latitude = 0; latitude <= 16; latitude += 1) for (let longitude = 0; longitude <= 48; longitude += 1) {
        const phi = latitude / 16 * Math.PI * 0.5, theta = longitude / 48 * TAU;
        positions.push(radius * Math.sin(phi) * Math.cos(theta), height * Math.cos(phi), radius * Math.sin(phi) * Math.sin(theta));
        uvs.push(longitude / 48, latitude / 16);
        if (latitude < 16 && longitude < 48) { const v = latitude * 49 + longitude; indices.push(v, v + 1, v + 49, v + 1, v + 50, v + 49); }
      }
      const data = new VertexData(); data.positions = positions; data.indices = indices; data.uvs = uvs; data.applyToMesh(dome);
      this.mesh(dome, 'energy-hemisphere', this.surface(6));
    }
    const ground = MeshBuilder.CreateGround(`${this.id}_base_ring`, { width: radius * 2, height: radius * 2 }, this.scene);
    this.mesh(ground, 'volume-base', this.surface(3)).position.y = 0.04;
  }

  private createArea(): void {
    const points = this.config.points.length >= 3 ? this.path : [
      new Vector3(-this.config.radius, 0, -this.config.radius), new Vector3(this.config.radius, 0, -this.config.radius),
      new Vector3(this.config.radius, 0, this.config.radius), new Vector3(-this.config.radius, 0, this.config.radius),
    ];
    const mesh = new Mesh(`${this.id}_area`, this.scene);
    const data = new VertexData();
    data.positions = points.flatMap(point => [point.x, point.y + 0.02, point.z]);
    data.uvs = points.flatMap(point => [point.x / this.config.radius * 0.5 + 0.5, point.z / this.config.radius * 0.5 + 0.5]);
    data.indices = triangulatePolygon(points);
    data.applyToMesh(mesh);
    this.mesh(mesh, 'area-polygon', this.surface(1, false));
    this.ribbon([...points, points[0]], 'area-boundary', this.surface(0));
  }

  private createHeatmap(): void {
    const radius = this.config.radius, resolution = 40;
    const positions: number[] = [], colors: number[] = [], uvs: number[] = [], indices: number[] = [];
    const values = this.config.values.slice(0, 64);
    const minimum = Math.min(0, ...values), maximum = Math.max(0.001, ...values);
    const influence = Math.max(this.config.width, radius * 0.08);
    for (let z = 0; z <= resolution; z += 1) for (let x = 0; x <= resolution; x += 1) {
      const px = (x / resolution * 2 - 1) * radius, pz = (z / resolution * 2 - 1) * radius;
      let heat = 0;
      for (let index = 0; index < this.path.length; index += 1) {
        const point = this.path[index], distance = (point.x - px) ** 2 + (point.z - pz) ** 2;
        heat += ((values[index] ?? minimum) - minimum) / (maximum - minimum) * Math.exp(-distance / (2 * influence * influence));
      }
      const color = heatColor(Math.min(1, heat));
      positions.push(px, 0.04, pz); uvs.push(x / resolution, z / resolution); colors.push(color.r, color.g, color.b, 0.62);
      if (x < resolution && z < resolution) { const v = z * (resolution + 1) + x; indices.push(v, v + 1, v + resolution + 1, v + 1, v + resolution + 2, v + resolution + 1); }
    }
    const mesh = new Mesh(`${this.id}_heatmap`, this.scene), data = new VertexData();
    data.positions = positions; data.indices = indices; data.uvs = uvs; data.colors = colors; data.applyToMesh(mesh);
    this.mesh(mesh, 'heat-field', this.surface(9, false, true));
  }

  private createData(kind: string): void {
    const values = this.config.values.slice(0, 64);
    const maximum = Math.max(0.001, ...values.map(Math.abs));
    const minimumValue = Math.min(0, ...values), maximumValue = Math.max(0.001, ...values);
    const labels: { text: string; position: Vector3 }[] = [];
    values.forEach((value, index) => {
      const position = this.config.points[index] ? Vector3.FromArray([this.config.points[index].x, this.config.points[index].y, this.config.points[index].z])
        : new Vector3((index - (values.length - 1) / 2) * this.config.radius, 0, 0);
      const proportion = Math.abs(value) / maximum, height = Math.max(0.01, proportion * this.config.height);
      const color = kind === 'data-bars' ? Color3.Lerp(Color3.FromHexString(this.component.primaryColor), Color3.FromHexString(this.component.secondaryColor), proportion)
        : heatColor((value - minimumValue) / (maximumValue - minimumValue));
      const mesh = kind === 'data-bars'
        ? MeshBuilder.CreateBox(`${this.id}_bar_${index}`, { width: this.config.width, depth: this.config.width, height }, this.scene)
        : MeshBuilder.CreateGround(`${this.id}_region_${index}`, { width: this.config.radius * 1.8, height: this.config.radius * 1.8 }, this.scene);
      this.mesh(mesh, kind === 'data-bars' ? 'data-bar' : 'region-cell', this.solid(color));
      mesh.position.copyFrom(position);
      mesh.position.y += kind === 'data-bars' ? Math.sign(value || 1) * height * 0.5 : 0.04;
      mesh.metadata.value = value; mesh.metadata.label = this.config.labels[index] ?? `${index + 1}`;
      labels.push({ text: `${mesh.metadata.label}  ${value}`, position: position.add(new Vector3(0, kind === 'data-bars' ? Math.sign(value || 1) * (height + 0.4) : 0.5, 0)) });
    });
    this.createLabels(labels);
  }

  private createLabels(labels: { text: string; position: Vector3 }[]): void {
    // NullEngine 无绘图上下文；真实浏览器共用一张字图，避免每根数据柱创建独立纹理。
    if (!labels.length || (typeof document === 'undefined' && typeof OffscreenCanvas === 'undefined')) return;
    const texture = new DynamicTexture(`${this.id}_labels`, { width: 1024, height: 2048 }, this.scene, false);
    const context = texture.getContext() as CanvasRenderingContext2D;
    context.clearRect(0, 0, 1024, 2048); context.font = 'bold 25px sans-serif'; context.fillStyle = '#eaffff';
    context.textAlign = 'center'; context.textBaseline = 'middle';
    labels.forEach((label, index) => context.fillText(label.text.slice(0, 50), 256 + index % 2 * 512, Math.floor(index / 2) * 64 + 32, 500));
    texture.hasAlpha = true; texture.update(); this.textures.push(texture);
    const material = this.solid('#ffffff'); material.diffuseTexture = texture; material.useAlphaFromDiffuseTexture = true;
    material.emissiveTexture = texture; material.emissiveColor = Color3.White();
    labels.forEach((label, index) => {
      const mesh = MeshBuilder.CreatePlane(`${this.id}_label_${index}`, { width: Math.max(1.8, this.config.width * 3), height: Math.max(0.3, this.config.width * 0.5) }, this.scene);
      const left = index % 2 * 0.5, top = 1 - Math.floor(index / 2) / 32;
      mesh.setVerticesData(VertexBuffer.UVKind, [left, top - 1 / 32, left + 0.5, top - 1 / 32, left + 0.5, top, left, top]);
      this.mesh(mesh, 'data-label', material).position.copyFrom(label.position);
      mesh.billboardMode = Mesh.BILLBOARDMODE_ALL;
    });
  }

  private createFrustum(): void {
    const { radius, height } = this.config;
    const tip = new Vector3(0, height, 0);
    const corners = [new Vector3(-radius, 0, radius * 0.5), new Vector3(radius, 0, radius * 0.5), new Vector3(radius, 0, radius * 2), new Vector3(-radius, 0, radius * 2)];
    const mesh = new Mesh(`${this.id}_frustum`, this.scene), data = new VertexData();
    data.positions = [tip, ...corners].flatMap(point => point.asArray());
    data.indices = [0, 1, 2, 0, 2, 3, 0, 3, 4, 0, 4, 1, 1, 4, 3, 1, 3, 2];
    data.applyToMesh(mesh); this.mesh(mesh, 'camera-coverage', this.solid(this.component.primaryColor, this.config.opacity * 0.18));
    const borderMaterial = this.solid(this.component.secondaryColor);
    for (const corner of corners) this.ribbon([tip, corner], 'frustum-edge', borderMaterial);
    this.ribbon([...corners, corners[0]], 'frustum-footprint', borderMaterial);
  }

  private createParticles(kind: string): void {
    const mode = ['rain', 'snow', 'flame', 'smoke-plume'].indexOf(kind);
    const count = Math.max(8, Math.min(MAX_PARTICLES, Math.round(this.config.amount * this.component.density * (mode < 2 ? 12 : 4))));
    const material = new ShaderMaterial(`${this.id}_particles_mat`, this.scene, { vertexSource: PARTICLE_VERTEX, fragmentSource: PARTICLE_FRAGMENT }, {
      attributes: ['position', 'uv', 'color'], uniforms: ['world', 'view', 'projection', 'time', 'height', 'radius', 'size', 'mode', 'primary', 'secondary', 'opacity', 'intensity'], needAlphaBlending: true,
    });
    this.prepareShader(material, kind === 'flame');
    material.setFloat('mode', mode); material.setFloat('height', this.config.height); material.setFloat('radius', this.config.radius);
    const size = mode === 0 ? this.config.height * 0.075 : mode === 1 ? this.config.width : this.config.radius * (mode === 2 ? 0.8 : 1.4);
    material.setFloat('size', size);
    const positions: number[] = [], colors: number[] = [], uvs: number[] = [], indices: number[] = [];
    for (let index = 0; index < count; index += 1) {
      const a = random(index * 4 + 1), b = random(index * 4 + 2), c = random(index * 4 + 3), d = random(index * 4 + 4);
      const radial = Math.sqrt(b) * this.config.radius;
      for (const uv of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
        positions.push(Math.cos(a * TAU) * radial, c * this.config.height, Math.sin(a * TAU) * radial);
        uvs.push(...uv); colors.push(a, b, c, d);
      }
      const v = index * 4; indices.push(v, v + 1, v + 2, v, v + 2, v + 3);
    }
    const mesh = new Mesh(`${this.id}_${kind}_particles`, this.scene), data = new VertexData();
    data.positions = positions; data.uvs = uvs; data.colors = colors; data.indices = indices; data.applyToMesh(mesh);
    this.mesh(mesh, 'shader-particles', material);
    const bound = this.config.radius * 1.6 + size;
    mesh.setBoundingInfo(new BoundingInfo(new Vector3(-bound, -size, -bound), new Vector3(bound, this.config.height + size, bound)));
  }
}

function random(seed: number): number { const value = Math.sin(seed * 127.1 + 311.7) * 43758.5453; return value - Math.floor(value); }

function heatColor(value: number): Color3 {
  const colors = [new Color3(0, 0.15, 1), new Color3(0, 0.9, 1), new Color3(0.1, 1, 0.15), new Color3(1, 0.95, 0), new Color3(1, 0.08, 0)];
  const scaled = Math.max(0, Math.min(0.99999, value)) * 4, index = Math.floor(scaled);
  return Color3.Lerp(colors[index], colors[index + 1], scaled - index);
}

/** 耳切法支持凹多边形；点数已限制为 128，无法成面的轮廓只保留可用三角面。 */
function triangulatePolygon(points: Vector3[]): number[] {
  const cross = (a: Vector3, b: Vector3, c: Vector3) => (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
  let area = 0;
  points.forEach((point, index) => { const next = points[(index + 1) % points.length]; area += point.x * next.z - next.x * point.z; });
  const order = points.map((_, index) => index); if (area < 0) order.reverse();
  const result: number[] = [];
  for (let iteration = 0; order.length > 2 && iteration < MAX_POINTS * MAX_POINTS; iteration += 1) {
    let clipped = false;
    for (let index = 0; index < order.length; index += 1) {
      const a = order[(index + order.length - 1) % order.length], b = order[index], c = order[(index + 1) % order.length];
      if (cross(points[a], points[b], points[c]) <= 0.000001) continue;
      const contains = order.some(other => other !== a && other !== b && other !== c
        && cross(points[a], points[b], points[other]) >= 0 && cross(points[b], points[c], points[other]) >= 0 && cross(points[c], points[a], points[other]) >= 0);
      if (contains) continue;
      result.push(a, b, c); order.splice(index, 1); clipped = true; break;
    }
    if (!clipped) break;
  }
  return result;
}
