import {
  AbstractMesh, BoundingInfo, Color3, Constants, DynamicTexture, Material, Matrix, Mesh, MeshBuilder,
  Quaternion, Scene, ShaderMaterial, StandardMaterial, Texture, TransformNode, Vector3, Vector4, VertexBuffer, VertexData,
} from '@babylonjs/core';
import type { PoiEffectComponent } from '../../../editor/model/components';
import { SURFACE_VERTEX, SURFACE_FRAGMENT, PARTICLE_VERTEX, PARTICLE_FRAGMENT } from './SpatialEffectShaders';

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

/** 与旧版 POI 类型独立的空间组件集合；稳定类型由场景文件持久化。 */
export function supportsSpatialEffect(kind: string): boolean { return KINDS.has(kind); }

/** 所有动画由 POI 的唯一帧循环驱动，创建与释放均限制在该实体自己的资源内。 */
export class SpatialEffects {
  readonly meshes: Mesh[] = [];
  readonly materials: Material[] = [];
  readonly textures: Texture[] = [];
  private config: Config;
  private path: Vector3[];
  private lengths: number[];
  private readonly movers: Mover[] = [];
  private readonly revealNodes: { mesh: Mesh; fraction: number; lit: Material; dim: Material }[] = [];
  private readonly shaders: ShaderMaterial[] = [];
  private elapsed = 0;
  private playbackSpeed = 0;
  private pausedPathPhase = 0;
  private physicalFlowPhase = 0;
  private active = true;
  private disposed = false;
  private trail: Mesh | null = null;
  private readonly history: Vector3[] = [];
  private trailTarget: TransformNode | AbstractMesh | null = null;
  private targetRetry = 0;
  private trailIdleSeconds = 0;
  private trailSampleElapsed = 0;
  private historyAges: number[] = [];
  private elapsedLifetime = 0;
  private stoppedAt = -1;
  private emissionFraction = 1;
  private particlesStarted = false;
  private paletteSource: unknown;
  private palette: { value: number; color: Color3 }[] = [];
  private topology = '';
  private labelTexture: DynamicTexture | null = null;
  private labelTextSignature = '';
  private labelMeshes: Mesh[] = [];
  private dataTransitions: {mesh: Mesh; height: number; desired: number; baseY: number; sign: number}[] = [];

  constructor(
    private readonly id: string,
    private readonly scene: Scene,
    private readonly root: TransformNode,
    private component: PoiEffectComponent,
    private readonly resolveTarget?: (id: string) => TransformNode | AbstractMesh | null,
  ) {
    if (!component.visual) throw new Error(`空间特效缺少规范化参数：${id}`);
    this.updatePlaybackSpeed(component.speed);
    this.config = component.visual;
    this.path = this.readPath();
    this.lengths = this.path.map((point, index) => index ? Vector3.Distance(point, this.path[index - 1]) : 0);
    for (let index = 1; index < this.lengths.length; index += 1) this.lengths[index] += this.lengths[index - 1];
    this.create();
    this.topology = this.topologySignature();
    this.updateUniforms();
    this.updateAnimation();
  }

  tick(deltaSeconds: number): void {
    if (!this.active || this.disposed || !Number.isFinite(deltaSeconds) || deltaSeconds <= 0) return;
    this.updateDataTransitions(deltaSeconds);
    if(this.playbackSpeed <= 0) return;
    const duration = this.effectiveDuration();
    if (!this.config.loop && this.elapsed >= duration && !(this.trail && this.config.targetEntityId)) return;
    const advance = Math.min(deltaSeconds, 0.25) * this.playbackSpeed;
    if(this.parameter('speedMetersPerSecond')!==undefined) {
      const length=Math.max(0.001,this.lengths.at(-1)??1);
      const count=this.parameter('bandSpacing')!==undefined?length/this.number('bandSpacing',2,0.01):Math.max(1,Math.min(12,this.config.amount));
      this.physicalFlowPhase=(this.physicalFlowPhase+advance*this.number('speedMetersPerSecond',0,0,1000)*count/length)%1;
    }
    this.elapsed += advance;
    this.elapsedLifetime += advance;
    this.elapsed = this.config.loop ? this.elapsed % duration : Math.min(duration, this.elapsed);
    this.updateAnimation();
    if (this.trail && this.config.targetEntityId) this.updateTargetTrail(advance);
  }

  /** 高频数值、颜色和进度保持资源；轮廓/容量变化才重建本实体的有界几何。 */
  update(component: PoiEffectComponent): void {
    if (this.disposed || !component.visual) return;
    const oldTarget = this.config.targetEntityId;
    const oldDuration = this.effectiveDuration(), oldPhase = this.animationPhase();
    this.component = component;
    this.config = component.visual;
    this.updatePlaybackSpeed(component.speed);
    if (oldTarget !== this.config.targetEntityId) { this.trailTarget = null; this.history.length = 0; this.historyAges.length = 0; this.targetRetry = 0; }
    const topology = this.topologySignature();
    if (topology !== this.topology) {
      this.releaseResources();
      this.path = this.readPath(); this.measurePath(); this.create(); this.topology = topology;
      this.setActive(this.active);
    } else if (['heatmap','region-level','data-bars'].includes(this.component.effectKind)) {
      this.path=this.readPath();this.measurePath();
      if(this.component.effectKind==='heatmap')this.updateHeatmap();else this.updateData();
    }
    const duration=this.effectiveDuration();
    if(duration!==oldDuration) {
      this.pausedPathPhase=oldPhase;
      this.elapsed=duration===Number.MAX_VALUE?0:oldPhase*duration;
    }
    this.updateUniforms(); this.updateAnimation();
  }

  private parameter(key: string): unknown { return this.component.configuration?.parameters[key]; }
  private number(key: string, fallback: number, min = -1000000, max = 1000000): number {
    const value = this.parameter(key); return typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
  }
  private rows(key: string): Array<Record<string, unknown>> { const value = this.parameter(key); return Array.isArray(value) ? value.slice(0,64) : []; }
  private vector(key: string, fallback: Vector3): Vector3 {
    const value = this.parameter(key) as {x?:unknown;y?:unknown;z?:unknown}|undefined;
    return value && [value.x,value.y,value.z].every(v=>typeof v === 'number' && Number.isFinite(v)) ? new Vector3(value.x as number,value.y as number,value.z as number) : fallback;
  }
  private measurePath(): void { this.lengths = this.path.map((p,i)=> i ? Vector3.Distance(p,this.path[i-1]) : 0); for (let i=1;i<this.lengths.length;i++) this.lengths[i]+=this.lengths[i-1]; }
  private effectiveDuration(): number {
    const speed = this.number('speedMetersPerSecond', -1, 0, 1000);
    return speed < 0 ? Math.max(0.05,this.config.duration) : speed === 0 ? Number.MAX_VALUE : Math.max(0.001,(this.lengths.at(-1) ?? 1)/speed);
  }
  private animationPhase(): number {
    return this.parameter('speedMetersPerSecond')===0?this.pausedPathPhase:this.elapsed/this.effectiveDuration();
  }
  private topologySignature(): string {
    const {radius,height,width,points,amount,values} = this.config;
    const keys = ['closed','elevation','arrowSpacing','arrowLength','arrowWidth','maxMovers','bottomRadius','topRadius','showBase','arcSegments','fluidSize','gridResolution','horizontalFov','verticalFov','nearDistance','farDistance','showEdges','showCoverage','particleBudget','usePolygon','showBoundary','showLabels','segments'];
    const parameters = Object.fromEntries(keys.map(k=>[k,this.parameter(k)]));
    const regions = this.rows('regions').map(r=>({id:r.id,points:r.points}));
    const dataEffect=['heatmap','region-level','data-bars'].includes(this.component.effectKind);
    return JSON.stringify({kind:this.component.effectKind,radius,height,width,points:dataEffect?points.length:points,amount,density:this.component.density,count:this.component.effectKind==='heatmap'?0:values.length,parameters,regions});
  }

  private updateUniforms(): void {
    const kind = this.component.effectKind;
    for (const shader of this.shaders) {
      shader.setColor3('primary',Color3.FromHexString(this.component.primaryColor)); shader.setColor3('secondary',Color3.FromHexString(this.component.secondaryColor));
      shader.setFloat('opacity',kind==='pipe-flow'?this.number('shellOpacity',this.config.opacity,0,1):this.config.opacity); shader.setFloat('intensity',this.component.intensity);
      shader.setFloat('amount',kind==='radar-sector'?this.number('sectorDegrees',this.config.amount,1,360):kind==='ripple-ring'?this.number('ringCount',Math.max(1,Math.min(12,this.config.amount)),1,32):this.parameter('bandSpacing')!==undefined?(this.lengths.at(-1)??1)/this.number('bandSpacing',2,0.01):Math.max(1,Math.min(12,this.config.amount)));
      shader.setVector4('detail',new Vector4(this.number('gridSpacing',4,0.01),this.number('fadeExponent',kind==='motion-trail'?1.6:1,0.1,8),this.number('brightnessMin',0.2,0,3),this.number('brightnessMax',1,0,3)));
      shader.setVector4('shape',new Vector4(this.number(kind==='energy-dome'?'gridColumns':'tickCount',36,0,256),this.number('startAngleDegrees',0)/360,this.number(kind==='energy-dome'?'gridRows':'rangeRings',kind==='energy-dome'?14:4,0,128),kind==='ripple-ring'?this.number('ringWidth',-1,0.001)>0?Math.max(1,this.config.radius/this.number('ringWidth',0.1,0.001)):16:this.number('gridLineWidth',0.028,0.001,0.2)));
      shader.setVector4('wave',new Vector4(this.parameter('waveLength')!==undefined?TAU/this.number('waveLength',3,0.01):2.3,this.number('waveAmplitude',1,0,10),this.number('waveDirectionDegrees',0)*Math.PI/180,0));
    }
    for (const material of this.materials) if (material instanceof StandardMaterial) {
      const role = material.metadata?.effectColorRole;
      if (role) material.emissiveColor = Color3.FromHexString(role==='secondary'?this.component.secondaryColor:this.component.primaryColor).scale(this.component.intensity);
      material.alpha = this.config.opacity * (material.metadata?.effectAlphaMultiplier ?? 1);
    }
    for (const mesh of this.meshes) if (['camera-coverage','frustum-edge','frustum-footprint'].includes(mesh.metadata?.effectRole)) mesh.rotation.set(this.number('pitchDegrees',0)*Math.PI/180,this.number('yawDegrees',0)*Math.PI/180,0);
    this.updateParticleUniforms();
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
    this.releaseResources();
  }

  private releaseResources(): void {
    for (const mesh of this.meshes) mesh.dispose(false, false);
    for (const material of this.materials) material.dispose(false, false);
    for (const texture of this.textures) texture.dispose();
    this.history.length = 0;
    this.trailTarget = null;
    this.historyAges.length = 0; this.meshes.length = 0; this.materials.length = 0; this.textures.length = 0;
    this.shaders.length = 0; this.movers.length = 0; this.revealNodes.length = 0; this.trail = null;
    this.labelTexture = null; this.labelMeshes.length = 0; this.dataTransitions.length = 0;
  }

  private readPath(): Vector3[] {
    const points: Vector3[] = [];
    const isData = ['heatmap', 'region-level', 'data-bars'].includes(this.component.effectKind);
    for (const point of this.config.points.slice(0, MAX_POINTS)) {
      if (![point.x, point.y, point.z].every(Number.isFinite)) continue;
      const vector = new Vector3(point.x, point.y + this.number('elevation',0), point.z);
      // 数据点按索引与 values 配对，同位置的多个观测也必须保留，不能按路径去重。
      if (isData || !points.length || Vector3.DistanceSquared(points[points.length - 1], vector) > 0.000001) points.push(vector);
    }
    if (isData && points.length) return points;
    if (points.length >= 2) { if (this.parameter('closed')===true && !points[0].equals(points.at(-1)!)) points.push(points[0].clone()); return points; }
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
        uniforms: ['worldViewProjection', 'primary', 'secondary', 'opacity', 'intensity', 'time', 'mode', 'thickness', 'progress', 'amount','detail','shape','wave'],
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

  private solid(color: string | Color3, alpha = this.config.opacity, alphaMultiplier?: number): StandardMaterial {
    const material = new StandardMaterial(`${this.id}_solid_${this.materials.length}`, this.scene);
    material.disableLighting = true;
    material.emissiveColor = (typeof color === 'string' ? Color3.FromHexString(color) : color).scale(this.component.intensity);
    material.diffuseColor = Color3.Black();
    material.alpha = alpha;
    material.backFaceCulling = false;
    material.disableDepthWrite = alpha < 1;
    material.metadata = { effectAlphaMultiplier: alphaMultiplier ?? (this.config.opacity > 0 ? alpha / this.config.opacity : 1),
      effectColorRole: typeof color==='string' ? color===this.component.secondaryColor?'secondary':'primary' : null };
    this.materials.push(material);
    return material;
  }

  private create(): void {
    const kind = this.component.effectKind;
    if (['rain', 'snow', 'flame', 'smoke-plume'].includes(kind)) { this.createParticles(kind); return; }
    if (kind === 'heatmap') { this.createHeatmap(); return; }
    if (kind === 'region-level' || kind === 'data-bars') { this.createData(kind); return; }
    if (kind === 'camera-frustum') { this.createFrustum(); return; }
    if (kind === 'area-fill' || kind === 'water-surface' && this.parameter('usePolygon') === true) { this.createArea(); return; }
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
      const segments = Math.round(this.number('arcSegments',64,8,128));
      path = Array.from({ length: segments + 1 }, (_, index) => {
        const t = index / segments;
        const point = Vector3.Lerp(start, end, t); point.y += this.config.height * 4 * t * (1 - t); return point;
      });
    }
    if (kind === 'fly-line' || kind === 'boundary-flow') { this.path = path; this.measurePath(); }
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
      const dim = this.solid(this.component.secondaryColor, this.config.opacity * 0.2, 0.2);
      const segments=this.rows('segments');
      path.forEach((point, index) => {
        const mesh = this.mesh(MeshBuilder.CreateSphere(`${this.id}_node`, { diameter: this.config.width * 2, segments: 4 }, this.scene), 'path-node', dim);
        mesh.position.copyFrom(point);
        const threshold=segments[index]?.threshold;
        this.revealNodes.push({ mesh, fraction: typeof threshold==='number'?Math.max(0,Math.min(1,threshold)):this.lengths[index] / Math.max(0.001, this.lengths[this.lengths.length - 1]), lit, dim });
        if(typeof segments[index]?.label==='string') mesh.metadata.segmentLabel=segments[index].label;
      });
      if(segments.length)this.createLabels(path.slice(0,segments.length).map((position,index)=>({text:String(segments[index].label??index+1),position:position.add(new Vector3(0,0.5,0))})));
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
    const count = this.parameter('arrowSpacing')!==undefined ? Math.max(1, Math.min(this.number('maxMovers',64,1,256),Math.floor((this.lengths.at(-1)??1)/this.number('arrowSpacing',2,0.05)))) : Math.max(2, Math.min(this.number('maxMovers',64,1,256), Math.round(this.config.amount * this.component.density)));
    const material = this.solid(this.component.primaryColor);
    for (let index = 0; index < count; index += 1) {
      let mesh: Mesh;
      if (kind === 'flow-arrows') {
        mesh = new Mesh(`${this.id}_arrow_${index}`, this.scene);
        const scale = this.config.width * 2.5;
        const data = new VertexData();
        data.positions = [-0.6, 0, -0.5, 0, 0, 0.2, 0.6, 0, -0.5, 0.6, 0, -0.15, 0, 0, 0.65, -0.6, 0, -0.15].map((value,index) => value * (index%3===0?this.number('arrowWidth',scale*1.2,0.01)/1.2:index%3===2?this.number('arrowLength',scale*1.15,0.01)/1.15:scale));
        data.indices = [0, 1, 5, 1, 4, 5, 1, 2, 3, 1, 3, 4];
        data.applyToMesh(mesh);
      } else mesh = MeshBuilder.CreateSphere(`${this.id}_flow_${index}`, { diameter: this.number('fluidSize',this.config.width * 0.65,0.005), segments: 4 }, this.scene);
      this.mesh(mesh, kind === 'flow-arrows' ? 'moving-arrow' : 'moving-fluid', material);
      const offset=this.parameter('arrowSpacing')!==undefined?index*this.number('arrowSpacing',2,0.05)/Math.max(0.001,this.lengths.at(-1)??1):index/count;
      this.movers.push({ mesh, offset, arrow: kind === 'flow-arrows' });
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
    const phase = this.animationPhase();
    const reversed = this.parameter('flowDirection') === 'reverse' || this.parameter('rotationDirection') === 'reverse';
    const progress = this.component.effectKind === 'path-reveal' && this.parameter('progressMode')!=='data' ? Math.min(1, this.config.progress + phase) : this.config.progress;
    const physicalFlow = this.parameter('speedMetersPerSecond')!==undefined && ['boundary-flow','flow-path','flow-arrows','fly-line','pipe-flow'].includes(this.component.effectKind);
    for (const shader of this.shaders) { shader.setFloat('time', (reversed?-1:1)*(physicalFlow?this.physicalFlowPhase:phase)); shader.setFloat('progress', progress); shader.setFloat('particleClock',this.elapsedLifetime); }
    for (const node of this.revealNodes) node.mesh.material = node.fraction <= progress ? node.lit : node.dim;
    for (const mover of this.movers) {
      const forwardFraction = this.config.loop ? (mover.offset + phase) % 1 : Math.min(1, mover.offset + phase);
      const fraction = reversed ? 1-forwardFraction : forwardFraction;
      const sample = this.pointOnPath(fraction);
      if (reversed) sample.tangent.scaleInPlace(-1);
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
    this.trailIdleSeconds += deltaSeconds; this.trailSampleElapsed += deltaSeconds;
    for(let i=0;i<this.historyAges.length;i++) this.historyAges[i]+=deltaSeconds;
    const retention = this.number('retentionSeconds',this.config.duration,0.1,3600);
    while(this.historyAges.length && this.historyAges[0]>retention) {this.historyAges.shift();this.history.shift();}
    const material = this.trail!.material as ShaderMaterial;
    material.setFloat('opacity', this.config.opacity * Math.max(0, 1 - this.trailIdleSeconds / retention));
    if (this.trailIdleSeconds >= retention) {
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
    if (this.trailSampleElapsed < this.number('sampleInterval',0,0,10)) return;
    this.trailSampleElapsed = 0;
    if (last && Vector3.DistanceSquared(last, local) < this.number('minSampleDistance',0.01,0,100)**2) return;
    this.trailIdleSeconds = 0;
    material.setFloat('opacity', this.config.opacity);
    this.history.push(local);
    this.historyAges.push(0);
    const count = this.trail!.getTotalVertices() / 2;
    if (this.history.length > count) {this.history.shift();this.historyAges.shift();}
    let length = 0; for(let i=this.history.length-1;i>0;i--) {length+=Vector3.Distance(this.history[i],this.history[i-1]);if(length>this.number('maxTrailLength',Number.MAX_VALUE,0.01)){this.history.splice(0,i);this.historyAges.splice(0,i);break;}}
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
      const pillar = MeshBuilder.CreateCylinder(`${this.id}_pillar`, { diameterBottom: this.number('bottomRadius',radius*0.175,0.005)*2, diameterTop: this.number('topRadius',radius*0.06,0)*2, height, tessellation: 48, cap: Mesh.NO_CAP }, this.scene);
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
    if(this.parameter('showBase')===false) return;
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
    this.mesh(mesh, 'area-polygon', this.surface(this.component.effectKind==='water-surface'?8:1, false));
    if(this.parameter('showBoundary')!==false) this.ribbon([...points, points[0]], 'area-boundary', this.surface(0));
  }

  private createHeatmap(): void {
    const radius = this.config.radius, resolution = Math.round(this.number('gridResolution',40,8,96));
    const positions: number[] = [], colors: number[] = [], uvs: number[] = [], indices: number[] = [];
    const values = this.config.values.slice(0, 64);
    const [minimum, maximum] = this.domain(values);
    const influence = this.number('influenceRadius',Math.max(this.config.width, radius * 0.08),0.001);
    for (let z = 0; z <= resolution; z += 1) for (let x = 0; x <= resolution; x += 1) {
      const px = (x / resolution * 2 - 1) * radius, pz = (z / resolution * 2 - 1) * radius;
      let heat = 0;
      for (let index = 0; index < this.path.length; index += 1) {
        const point = this.path[index], distance = (point.x - px) ** 2 + (point.z - pz) ** 2;
        heat += ((values[index] ?? minimum) - minimum) / (maximum - minimum) * Math.exp(-distance / (2 * influence * influence));
      }
      const color = this.dataColor(minimum+Math.min(1,heat)*(maximum-minimum),minimum,maximum);
      positions.push(px, 0.04, pz); uvs.push(x / resolution, z / resolution); colors.push(color.r, color.g, color.b, 0.62);
      if (x < resolution && z < resolution) { const v = z * (resolution + 1) + x; indices.push(v, v + 1, v + resolution + 1, v + 1, v + resolution + 2, v + resolution + 1); }
    }
    const mesh = new Mesh(`${this.id}_heatmap`, this.scene), data = new VertexData();
    data.positions = positions; data.indices = indices; data.uvs = uvs; data.colors = colors; data.applyToMesh(mesh,true);
    this.mesh(mesh, 'heat-field', this.surface(9, false, true));
  }

  private updateHeatmap(): void {
    const mesh=this.meshes.find(m=>m.metadata?.effectRole==='heat-field'); if(!mesh) return;
    const positions=mesh.getVerticesData(VertexBuffer.PositionKind)!;
    const colors:number[]=[]; const values=this.config.values.slice(0,64), [minimum,maximum]=this.domain(values);
    const influence=this.number('influenceRadius',Math.max(this.config.width,this.config.radius*0.08),0.001);
    for(let v=0;v<positions.length;v+=3) {
      let heat=0; this.path.forEach((p,i)=>{const distance=(p.x-positions[v])**2+(p.z-positions[v+2])**2; heat+=((values[i]??minimum)-minimum)/(maximum-minimum)*Math.exp(-distance/(2*influence*influence));});
      const color=this.dataColor(minimum+Math.min(1,heat)*(maximum-minimum),minimum,maximum); colors.push(color.r,color.g,color.b,0.62);
    }
    mesh.updateVerticesData(VertexBuffer.ColorKind,colors);
  }

  private domain(values: number[]): [number,number] {
    const minimum=this.parameter('domainMode')==='fixed'?this.number('domainMin',0):Math.min(0,...values);
    const maximum=this.parameter('domainMode')==='fixed'?this.number('domainMax',100):Math.max(0.001,...values);
    return [minimum,Math.max(minimum+0.001,maximum)];
  }
  private dataColor(value:number, minimum:number, maximum:number): Color3 {
    const levels=this.parameter('levels');const discrete=this.component.effectKind==='region-level'&&Array.isArray(levels)&&levels.length>0;
    const source=discrete?levels:this.parameter('colorStops');
    if(source!==this.paletteSource){
      this.paletteSource=source;this.palette=(Array.isArray(source)?source.slice(0,64):[])
        .filter(r=>typeof r.value==='number' && Number.isFinite(r.value) && typeof r.color==='string' && /^#[0-9a-f]{6}$/i.test(r.color))
        .map(r=>({value:r.value as number,color:Color3.FromHexString(r.color as string)})).sort((a,b)=>a.value-b.value);
    }
    const stops=this.palette;
    if(stops.length) {
      if(value<=stops[0].value) return stops[0].color;
      for(let i=1;i<stops.length;i++) if(value<stops[i].value) return discrete?stops[i-1].color:Color3.Lerp(stops[i-1].color,stops[i].color,(value-stops[i-1].value)/Math.max(0.001,stops[i].value-stops[i-1].value));
      return stops.at(-1)!.color;
    }
    const proportion=Math.max(0,Math.min(1,(value-minimum)/(maximum-minimum)));
    return this.component.effectKind==='data-bars'?Color3.Lerp(Color3.FromHexString(this.component.primaryColor),Color3.FromHexString(this.component.secondaryColor),proportion):heatColor(proportion);
  }

  private regionRows(): {id:string;name:string;value:number;points:Vector3[]}[] {
    return this.rows('regions').flatMap((row,index)=> {
      const source=Array.isArray(row.points)?row.points.slice(0,MAX_POINTS):[];
      if(source.length<3 || source.some(p=>!p || ![p.x,p.y,p.z].every(Number.isFinite))) return [];
      const points=source.map(p=>new Vector3(p.x,p.y,p.z));
      return [{id:String(row.id??index),name:String(row.name??row.id??index),value:typeof row.value==='number' && Number.isFinite(row.value)?row.value:0,points}];
    });
  }

  private createData(kind: string): void {
    const regions=kind==='region-level'?this.regionRows():[];
    if(regions.length) {
      for(const region of regions) {
        const mesh=new Mesh(`${this.id}_region_${region.id}`,this.scene),data=new VertexData();
        data.positions=region.points.flatMap(p=>[p.x,p.y+0.04,p.z]);data.indices=triangulatePolygon(region.points);data.applyToMesh(mesh);
        this.mesh(mesh,'region-polygon',this.solid(Color3.White()));mesh.metadata.regionId=region.id;
        mesh.metadata.center=region.points.reduce((sum,p)=>sum.addInPlace(p),Vector3.Zero()).scaleInPlace(1/region.points.length);
      }
      this.updateData(); return;
    }
    const values = this.config.values.slice(0, 64);
    const maximum = Math.max(0.001, ...values.map(Math.abs));
    const minimumValue = Math.min(0, ...values), maximumValue = Math.max(0.001, ...values);
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
    });
    this.updateData();
  }

  private updateData(): void {
    const regions=this.regionRows();
    const values=regions.length?regions.map(r=>r.value):this.config.values.slice(0,64), [minimum,maximum]=this.domain(values);
    const meshes=this.meshes.filter(m=>['data-bar','region-cell','region-polygon'].includes(m.metadata?.effectRole));
    const labels:{text:string;position:Vector3}[]=[];
    meshes.forEach((mesh,index)=> {
      const region=regions.find(r=>r.id===mesh.metadata.regionId), value=region?.value??values[index]??0;
      const material=mesh.material as StandardMaterial; material.emissiveColor=this.dataColor(value,minimum,maximum).scale(this.component.intensity);material.alpha=this.config.opacity;
      mesh.metadata.value=value;mesh.metadata.label=region?.name??this.config.labels[index]??`${index+1}`;
      const dataPoint=this.config.points[index];
      if(dataPoint&&mesh.metadata.effectRole!=='region-polygon'){mesh.position.x=dataPoint.x;mesh.position.z=dataPoint.z;}
      let position:Vector3;
      if(mesh.metadata.effectRole==='data-bar') {
        const desired=this.parameter('heightMode')==='scale'?Math.abs(value)*this.number('heightScale',0.1,0.000001):this.parameter('domainMode')==='fixed'?Math.max(0,value-minimum)/(maximum-minimum)*this.config.height:Math.abs(value)/Math.max(0.001,...values.map(Math.abs))*this.config.height;
        const sign=this.parameter('domainMode')==='fixed'?1:Math.sign(value||1);
        const baseY=this.config.points[index]?.y??0;
        let transition=this.dataTransitions.find(t=>t.mesh===mesh);
        if(!transition) {
          const currentHeight=mesh.getBoundingInfo().boundingBox.extendSize.y*2;
          mesh.metadata.baseHeight=Math.max(0.001,currentHeight);
          transition={mesh,height:Math.max(0.01,desired),desired:Math.max(0.01,desired),baseY,sign}; this.dataTransitions.push(transition);
        }
        transition.desired=Math.max(0.01,desired);transition.baseY=baseY;transition.sign=sign;
        if(this.number('transitionSeconds',0,0,10)===0) transition.height=transition.desired;
        mesh.scaling.y=transition.height/mesh.metadata.baseHeight;mesh.position.y=baseY+sign*transition.height*0.5;
        position=mesh.position.add(new Vector3(0,sign*(transition.height*0.5+0.4),0));
      } else position=mesh.metadata.center?mesh.metadata.center.add(new Vector3(0,0.5,0)):mesh.position.add(new Vector3(0,0.5,0));
      const formatted=this.parameter('decimalPlaces')!==undefined?value.toFixed(Math.round(this.number('decimalPlaces',0,0,6))):String(value);
      labels.push({text:`${mesh.metadata.label}  ${formatted}${String(this.parameter('valueUnit')??'')}`,position});
    });
    if(this.parameter('showLabels')!==false) this.createLabels(labels);
  }

  private updateDataTransitions(deltaSeconds:number): void {
    const seconds=this.number('transitionSeconds',0,0,10); if(seconds<=0) return;
    for(const t of this.dataTransitions) {
      t.height+=(t.desired-t.height)*(1-Math.exp(-Math.min(0.25,deltaSeconds)/seconds*5));
      t.mesh.scaling.y=t.height/t.mesh.metadata.baseHeight;t.mesh.position.y=t.baseY+t.sign*t.height*0.5;
      const index=this.dataTransitions.indexOf(t),label=this.labelMeshes[index];if(label) label.position.y=t.baseY+t.sign*(t.height+0.4);
    }
  }

  private createLabels(labels: { text: string; position: Vector3 }[]): void {
    // NullEngine 无绘图上下文；真实浏览器共用一张字图，避免每根数据柱创建独立纹理。
    if (!labels.length || (typeof document === 'undefined' && typeof OffscreenCanvas === 'undefined')) return;
    const signature=JSON.stringify(labels.map(label=>label.text));
    if(this.labelTexture&&signature===this.labelTextSignature){labels.forEach((label,index)=>this.labelMeshes[index]?.position.copyFrom(label.position));return;}
    this.labelTextSignature=signature;
    const texture = this.labelTexture ?? new DynamicTexture(`${this.id}_labels`, { width: 1024, height: 2048 }, this.scene, false);
    const context = texture.getContext() as CanvasRenderingContext2D;
    context.clearRect(0, 0, 1024, 2048); context.font = 'bold 25px sans-serif'; context.fillStyle = '#eaffff';
    context.textAlign = 'center'; context.textBaseline = 'middle';
    labels.forEach((label, index) => context.fillText(label.text.slice(0, 50), 256 + index % 2 * 512, Math.floor(index / 2) * 64 + 32, 500));
    texture.hasAlpha = true; texture.update();
    if(this.labelTexture) { labels.forEach((label,index)=>this.labelMeshes[index]?.position.copyFrom(label.position)); return; }
    this.labelTexture=texture;this.textures.push(texture);
    const material = this.solid('#ffffff'); material.diffuseTexture = texture; material.useAlphaFromDiffuseTexture = true;
    material.metadata.effectColorRole=null;
    material.emissiveTexture = texture; material.emissiveColor = Color3.White();
    labels.forEach((label, index) => {
      const mesh = MeshBuilder.CreatePlane(`${this.id}_label_${index}`, { width: Math.max(1.8, this.config.width * 3), height: Math.max(0.3, this.config.width * 0.5) }, this.scene);
      const left = index % 2 * 0.5, top = 1 - Math.floor(index / 2) / 32;
      mesh.setVerticesData(VertexBuffer.UVKind, [left, top - 1 / 32, left + 0.5, top - 1 / 32, left + 0.5, top, left, top]);
      this.mesh(mesh, 'data-label', material).position.copyFrom(label.position);
      mesh.billboardMode = Mesh.BILLBOARDMODE_ALL;
      this.labelMeshes.push(mesh);
    });
  }

  private createFrustum(): void {
    if(['horizontalFov','verticalFov','nearDistance','farDistance'].some(key=>this.parameter(key)!==undefined)) {
      const near=this.number('nearDistance',0.1,0.001,10000),far=Math.max(near+0.001,this.number('farDistance',50,0.01,100000));
      const horizontal=Math.tan(this.number('horizontalFov',90,1,175)*Math.PI/360),vertical=Math.tan(this.number('verticalFov',60,1,175)*Math.PI/360);
      const points=[near,far].flatMap(distance=>[new Vector3(-distance*horizontal,-distance*vertical,distance),new Vector3(distance*horizontal,-distance*vertical,distance),new Vector3(distance*horizontal,distance*vertical,distance),new Vector3(-distance*horizontal,distance*vertical,distance)]);
      const mesh=new Mesh(`${this.id}_frustum`,this.scene),data=new VertexData();data.positions=points.flatMap(p=>p.asArray());
      data.indices=[0,2,1,0,3,2,4,5,6,4,6,7,0,1,5,0,5,4,1,2,6,1,6,5,2,3,7,2,7,6,3,0,4,3,4,7];data.applyToMesh(mesh);
      this.mesh(mesh,'camera-coverage',this.solid(this.component.primaryColor,this.config.opacity*0.18,0.18));mesh.visibility=this.parameter('showCoverage')===false?0:1;
      if(this.parameter('showEdges')!==false) {const material=this.solid(this.component.secondaryColor);for(let i=0;i<4;i++){this.ribbon([points[i],points[i+4]],'frustum-edge',material);this.ribbon([points[i],points[(i+1)%4]],'frustum-edge',material);this.ribbon([points[i+4],points[(i+1)%4+4]],'frustum-footprint',material);}}
      return;
    }
    const { radius, height } = this.config;
    const tip = new Vector3(0, height, 0);
    const corners = [new Vector3(-radius, 0, radius * 0.5), new Vector3(radius, 0, radius * 0.5), new Vector3(radius, 0, radius * 2), new Vector3(-radius, 0, radius * 2)];
    const mesh = new Mesh(`${this.id}_frustum`, this.scene), data = new VertexData();
    data.positions = [tip, ...corners].flatMap(point => point.asArray());
    data.indices = [0, 1, 2, 0, 2, 3, 0, 3, 4, 0, 4, 1, 1, 4, 3, 1, 3, 2];
    data.applyToMesh(mesh); this.mesh(mesh, 'camera-coverage', this.solid(this.component.primaryColor, this.config.opacity * 0.18, 0.18));
    mesh.visibility=this.parameter('showCoverage')===false?0:1;
    if(this.parameter('showEdges')===false)return;
    const borderMaterial = this.solid(this.component.secondaryColor);
    for (const corner of corners) this.ribbon([tip, corner], 'frustum-edge', borderMaterial);
    this.ribbon([...corners, corners[0]], 'frustum-footprint', borderMaterial);
  }

  private createParticles(kind: string): void {
    const mode = ['rain', 'snow', 'flame', 'smoke-plume'].indexOf(kind);
    const count = Math.round(this.number('particleBudget',Math.max(8, Math.min(MAX_PARTICLES, Math.round(this.config.amount * this.component.density * (mode < 2 ? 12 : 4)))),1,MAX_PARTICLES));
    const material = new ShaderMaterial(`${this.id}_particles_mat`, this.scene, { vertexSource: PARTICLE_VERTEX, fragmentSource: PARTICLE_FRAGMENT }, {
      attributes: ['position', 'uv', 'color'], uniforms: ['world', 'view', 'projection', 'time', 'height', 'radius', 'size', 'mode', 'primary', 'secondary', 'opacity', 'intensity','configured','lifetime','particleSpeed','emitterRadius','emissionFraction','particleClock','stoppedAt','emissionDirection','gravity','wind'], needAlphaBlending: true,
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

  private updateParticleUniforms(): void {
    if(!['rain','snow','flame','smoke-plume'].includes(this.component.effectKind)) return;
    const kind=this.component.effectKind, falling=kind==='rain'||kind==='snow';
    const custom=['emissionDirection','gravity','wind','particleSpeed','emitterRadius','particleLifetime'].some(key=>this.parameter(key)!==undefined);
    const lifetime=this.number('particleLifetime',this.config.duration,0.05,120);
    const particleMesh=this.meshes.find(m=>m.metadata.effectRole==='shader-particles');
    const capacity=(particleMesh?.getTotalVertices()??4)/4;
    const rate=this.number('emissionRate',capacity/lifetime,0,10000);
    if(rate>0) {this.particlesStarted=true;this.stoppedAt=-1;this.emissionFraction=Math.min(1,rate*lifetime/capacity);}
    else {if(this.stoppedAt<0)this.stoppedAt=this.elapsedLifetime;if(!this.particlesStarted||this.parameter('stopBehavior')==='clear')this.emissionFraction=0;}
    const direction=this.vector('emissionDirection',new Vector3(0,falling?-1:1,0));if(direction.lengthSquared()>0)direction.normalize();
    const gravity=this.vector('gravity',Vector3.Zero()),wind=this.vector('wind',Vector3.Zero());
    const speed=this.number('particleSpeed',this.config.height/lifetime,0,1000),emitterRadius=this.number('emitterRadius',this.config.radius,0,10000);
    const defaultSize=kind==='rain'?this.config.height*0.075:kind==='snow'?this.config.width:this.config.radius*(kind==='flame'?0.8:1.4);
    const size=this.number('particleSize',defaultSize,0.001,100);
    for(const shader of this.shaders) {
      shader.setFloat('configured',custom?1:0);shader.setFloat('lifetime',lifetime);shader.setFloat('size',size);
      shader.setFloat('particleSpeed',speed);shader.setFloat('emitterRadius',emitterRadius);shader.setFloat('emissionFraction',this.emissionFraction);shader.setFloat('stoppedAt',this.stoppedAt);
      shader.setVector3('emissionDirection',direction);shader.setVector3('gravity',gravity);shader.setVector3('wind',wind);
    }
    if(custom && particleMesh) {
      // 包围盒覆盖整个有界弹道；否则远离喷口的粒子会被视锥过早裁掉。
      const displacement=direction.scale(speed*lifetime).add(gravity.scale(0.5*lifetime*lifetime)).add(wind.scale(lifetime));
      const bound=emitterRadius+size*3+displacement.length()+gravity.length()*lifetime*lifetime*0.5;
      particleMesh.setBoundingInfo(new BoundingInfo(new Vector3(-bound,-bound,-bound),new Vector3(bound,bound+this.config.height,bound)));
    }
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
