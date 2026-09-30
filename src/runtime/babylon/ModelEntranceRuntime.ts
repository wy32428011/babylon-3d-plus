import {
  AbstractMesh, Color3, InstancedMesh, Material, MaterialDefines, MaterialPluginBase, Mesh,
  MultiMaterial, PBRBaseMaterial, ShaderMaterial, StandardMaterial, TransformNode, Vector3,
  Vector4, VertexBuffer, VertexData, type BaseTexture, type Scene, type UniformBuffer,
} from '@babylonjs/core';
import type { SceneModelEntranceSettings } from '../../editor/model/sceneModelEntrance';
import { cloneEnvironmentMaterial } from './cloneEnvironmentMaterial';
import { isTargetModelEffectSuspended, registerTargetModelEffectSuspension, suspendTargetModelEffects } from './effects/TargetModelEffects';

type Target = { id: string; node: TransformNode | AbstractMesh; meshes?: readonly AbstractMesh[] };
type Binding = {
  mesh: Mesh; original: Material | null; replacement: Material | null; materials: Material[];
  textures: Set<BaseTexture>; plugins: EntrancePlugin[]; targets: Map<AbstractMesh, number>;
  instanceBuffer: boolean; thinBuffer: Float32Array | null;
  releases: Array<() => void>; unsubscribe: Array<() => void>;
  minimum: Vector3; maximum: Vector3; wireframes: Map<Material, boolean>;
};
export type ModelEntranceSnapshot = {
  status: 'idle' | 'prepared' | 'playing' | 'completed' | 'cancelled'; elapsedSeconds: number;
  progress: number; targetCount: number; meshCount: number; unsupportedMeshCount: number;
  interruptedMeshCount: number; cycle: number;
};
const ATTRIBUTE = 'dtEntranceInstance';
const clamp = (value: number, minimum: number, maximum: number) => Math.min(maximum, Math.max(minimum, value));
const modes = { fade: 0, scan: 1, dissolve: 2, hologram: 3, particles: 4, assembly: 5, radial: 6, stagger: 7 };
const uniformNames = ['dtEntranceParams', 'dtEntranceColor', 'dtEntranceMinimum', 'dtEntranceMaximum', 'dtEntranceAssembly'];
const uniformDeclarations = '#ifndef UNIFORMBUFFERS\n' + uniformNames.map(name => `uniform vec4 ${name};`).join('\n') + '\n#endif';

/** 在原 Standard/PBR 管线末尾裁剪与着色，不改写模型业务节点或原材质。 */
class EntrancePlugin extends MaterialPluginBase {
  progress = 0;
  constructor(material: Material, private readonly binding: Binding, private readonly settings: SceneModelEntranceSettings) {
    super(material, 'DigitalTwinModelEntrance', 240, { DT_ENTRANCE_INSTANCED: false }, true, false);
    this.doNotSerialize = true; this.registerForExtraEvents = true; this._enable(true);
  }
  override prepareDefines(defines: MaterialDefines) {
    (defines as MaterialDefines & { DT_ENTRANCE_INSTANCED: boolean }).DT_ENTRANCE_INSTANCED = this.binding.instanceBuffer || !!this.binding.thinBuffer;
  }
  override getAttributes(attributes: string[]) {
    if (this.binding.instanceBuffer || this.binding.thinBuffer) attributes.push(ATTRIBUTE);
  }
  override getUniforms() {
    return { ubo: uniformNames.map(name => ({ name, size: 4, type: 'vec4' })), vertex: uniformDeclarations, fragment: uniformDeclarations };
  }
  override hardBindForSubMesh(buffer: UniformBuffer) {
    const { minimum, maximum } = this.binding;
    const color = Color3.FromHexString(this.settings.color);
    const axis = this.settings.axis === 'x' ? 0 : this.settings.axis === 'z' ? 2 : 1;
    buffer.updateFloat4('dtEntranceParams', modes[this.settings.effect], this.progress, axis, this.settings.reverse ? 1 : 0);
    buffer.updateFloat4('dtEntranceColor', color.r, color.g, color.b, this.settings.intensity);
    buffer.updateFloat4('dtEntranceMinimum', minimum.x, minimum.y, minimum.z, 0);
    buffer.updateFloat4('dtEntranceMaximum', maximum.x, maximum.y, maximum.z, 0);
    // 偏移在世界坐标计算，因此米制距离不被 GLB 或父级缩放二次放大。
    const seed = this.binding.mesh.uniqueId * 2.399963;
    buffer.updateFloat4('dtEntranceAssembly', Math.sin(seed), .7, Math.cos(seed), this.settings.assemblyDistanceMeters);
  }
  override getCustomCode(shaderType: string): Record<string, string> | null {
    if (shaderType === 'vertex') return {
      CUSTOM_VERTEX_DEFINITIONS: `varying vec3 dtEntranceLocal; varying vec3 dtEntranceWorld; varying float dtEntranceProgress;
        #if defined(INSTANCES) && defined(DT_ENTRANCE_INSTANCED)
        attribute vec4 ${ATTRIBUTE};
        #endif`,
      CUSTOM_VERTEX_UPDATE_POSITION: `dtEntranceLocal = positionUpdated; dtEntranceProgress = dtEntranceParams.y;
        #if defined(INSTANCES) && defined(DT_ENTRANCE_INSTANCED)
        dtEntranceProgress = ${ATTRIBUTE}.x;
        #endif`,
      CUSTOM_VERTEX_UPDATE_WORLDPOS: `dtEntranceWorld = worldPos.xyz; if (dtEntranceParams.x > 4.5 && dtEntranceParams.x < 5.5) {
        worldPos.xyz += normalize(dtEntranceAssembly.xyz) * dtEntranceAssembly.w * (1.0 - smoothstep(0.0, 1.0, dtEntranceProgress));
      }`,
    };
    if (shaderType !== 'fragment') return null;
    return {
      CUSTOM_FRAGMENT_DEFINITIONS: 'varying vec3 dtEntranceLocal; varying vec3 dtEntranceWorld; varying float dtEntranceProgress;',
      CUSTOM_FRAGMENT_MAIN_END: `
        float dtEP = clamp(dtEntranceProgress, 0.0, 1.0);
        if (dtEP <= 0.0) discard;
        if (dtEP < 1.0) {
          vec3 dtEN = clamp((dtEntranceWorld - dtEntranceMinimum.xyz) / max(vec3(.0001), dtEntranceMaximum.xyz - dtEntranceMinimum.xyz), 0.0, 1.0);
          float dtEH = dtEntranceParams.z < .5 ? dtEN.x : (dtEntranceParams.z > 1.5 ? dtEN.z : dtEN.y);
          if (dtEntranceParams.w > .5) dtEH = 1.0 - dtEH;
          float dtEM = dtEntranceParams.x;
          float dtENoise = fract(sin(dot(dtEntranceLocal, vec3(12.9898, 78.233, 39.425))) * 43758.5453);
          float dtEDither = fract(sin(dot(floor(gl_FragCoord.xy), vec2(12.9898, 78.233))) * 43758.5453);
          if (dtEM < .5 || dtEM > 6.5 || (dtEM > 4.5 && dtEM < 5.5)) {
            gl_FragColor.a *= smoothstep(0.0, 1.0, dtEP);
          } else if (dtEM < 1.5) {
            if (dtEH > dtEP) discard;
            gl_FragColor.rgb += dtEntranceColor.rgb * dtEntranceColor.a * (1.0 - smoothstep(.0, .075, abs(dtEH - dtEP)));
          } else if (dtEM < 2.5) {
            float dtEEdge = dtEH * .65 + dtENoise * .35;
            if (dtEEdge > dtEP) discard;
            gl_FragColor.rgb += dtEntranceColor.rgb * dtEntranceColor.a * (1.0 - smoothstep(.0, .07, abs(dtEEdge - dtEP)));
          } else if (dtEM < 3.5) {
            float dtELines = pow(max(0.0, sin(dtEH * 90.0 - dtEP * 12.0)), 8.0);
            gl_FragColor.rgb = mix(gl_FragColor.rgb, dtEntranceColor.rgb * (.75 + dtELines) * dtEntranceColor.a, (1.0 - smoothstep(.5, 1.0, dtEP)) * clamp(dtEntranceColor.a, 0.0, 1.0));
            gl_FragColor.a *= smoothstep(0.0, .4, dtEP);
          } else if (dtEM < 4.5) {
            if (dtEDither > smoothstep(.1, 1.0, dtEP)) discard;
            gl_FragColor.rgb += dtEntranceColor.rgb * dtEntranceColor.a * (1.0 - dtEP) * .4;
          } else {
            float dtER = length((dtEN - vec3(.5)) * vec3(1.0, .25, 1.0)) / .72;
            if (dtEntranceParams.w > .5) dtER = 1.0 - dtER;
            if (dtER > dtEP) discard;
            gl_FragColor.rgb += dtEntranceColor.rgb * dtEntranceColor.a * (1.0 - smoothstep(.0, .08, abs(dtER - dtEP)));
          }
        }`,
    };
  }
}

type Particle = { mesh: AbstractMesh; local: Vector3; origin: Vector3; targetIndex: number };

/** 每个运行会话最多播放一次；loop 可选，所有暂停都使用可见时间轴。 */
export class ModelEntranceRuntime {
  private settings: SceneModelEntranceSettings | null = null;
  private bindings: Binding[] = [];
  private targets: Target[] = [];
  private particles: Particle[] = [];
  private particleMesh: Mesh | null = null;
  private particleMaterial: ShaderMaterial | null = null;
  private particlePositions = new Float32Array(0);
  private particleVisibility = new Float32Array(0);
  private elapsed = 0;
  private progress = 0;
  private cycle = 0;
  private unsupported = 0;
  private interrupted = 0;
  private status: ModelEntranceSnapshot['status'] = 'idle';
  constructor(private readonly scene: Scene) {}
  get isActive() { return this.status === 'prepared' || this.status === 'playing'; }
  getSnapshot(): ModelEntranceSnapshot {
    return { status: this.status, elapsedSeconds: this.elapsed, progress: this.progress, targetCount: this.targets.length,
      meshCount: this.bindings.length, unsupportedMeshCount: this.unsupported, interruptedMeshCount: this.interrupted, cycle: this.cycle };
  }
  prepare(settings: SceneModelEntranceSettings, targets: Target[]): void {
    this.cancel(); this.elapsed = 0; this.progress = 0; this.cycle = 0; this.unsupported = 0; this.interrupted = 0;
    this.settings = { ...settings, targetEntityIds: [...settings.targetEntityIds] };
    this.status = 'idle'; this.targets = [];
    if (!settings.enabled) return;
    const selected = new Set(settings.targetEntityIds);
    this.targets = targets.filter(target => !target.node.isDisposed() && (settings.scope !== 'selected' || selected.has(target.id)));
    const bySource = new Map<Mesh, Binding>();
    this.targets.forEach((target, index) => {
      for (const node of target.meshes ?? [...(target.node instanceof AbstractMesh ? [target.node] : []), ...target.node.getChildMeshes(false)]) {
        if (!(node instanceof Mesh || node instanceof InstancedMesh) || node.isDisposed() || node.getTotalVertices() === 0 || node.metadata?.digitalTwinEffectProxy) continue;
        const mesh = node instanceof InstancedMesh ? node.sourceMesh : node;
        let binding = bySource.get(mesh);
        if (!binding) {
          binding = { mesh, original: mesh.material, replacement: null, materials: [], textures: new Set(), plugins: [], targets: new Map(), instanceBuffer: false, thinBuffer: null, releases: [], unsubscribe: [], minimum: Vector3.Zero(), maximum: Vector3.One(), wireframes: new Map() };
          bySource.set(mesh, binding);
        }
        if (!binding.targets.has(node)) binding.targets.set(node, index);
      }
    });
    try {
      for (const binding of bySource.values()) {
        const nodes = new Set([binding.mesh, ...binding.targets.keys()]);
        if ([...nodes].some(isTargetModelEffectSuspended)) { this.interrupted += binding.targets.size; continue; }
        for (const node of nodes) binding.releases.push(suspendTargetModelEffects(node));
        binding.original = binding.mesh.material;
        if (!this.supported(binding.original)) { this.unsupported += binding.targets.size; binding.releases.forEach(release => release()); continue; }
        this.bindings.push(binding);
        binding.replacement = this.cloneMaterial(binding.original, binding);
        this.installInstances(binding);
        binding.mesh.material = binding.replacement;
        for (const node of nodes) binding.unsubscribe.push(registerTargetModelEffectSuspension(node, () => {
          if (!this.bindings.includes(binding)) return;
          this.interrupted++; this.releaseBinding(binding); this.bindings.splice(this.bindings.indexOf(binding), 1);
        }));
      }
      if (!this.bindings.length) return;
      this.status = 'prepared'; this.update(0);
      if (settings.effect === 'particles') this.createParticles();
    } catch (error) { this.cancel(); throw error; }
  }
  start(): void { if (this.status === 'prepared') { this.status = 'playing'; this.update(0); } }
  tick(deltaSeconds: number, visible = true): void {
    if (this.status !== 'playing' || !visible || !this.settings) return;
    this.elapsed += Number.isFinite(deltaSeconds) ? Math.max(0, deltaSeconds) : 0;
    const duration = this.totalDuration();
    const cycleLength = this.settings.delaySeconds + duration + this.settings.loopIntervalSeconds;
    const local = this.settings.loop ? this.elapsed % cycleLength : this.elapsed;
    this.cycle = this.settings.loop ? Math.floor(this.elapsed / cycleLength) : 0;
    this.update(local);
    if (!this.settings.loop && local >= this.settings.delaySeconds + duration - 1e-7) {
      this.progress = 1; this.release(); this.status = 'completed';
    }
  }
  cancel(): void { this.release(); this.status = 'cancelled'; }
  dispose(): void { this.cancel(); this.settings = null; this.targets = []; }
  private supported(material: Material | null): boolean {
    if (material instanceof MultiMaterial) return material.subMaterials.every(child => this.supported(child));
    return !material || material instanceof StandardMaterial || material instanceof PBRBaseMaterial;
  }
  private cloneMaterial(original: Material | null, binding: Binding): Material {
    if (original instanceof MultiMaterial) {
      const multi = new MultiMaterial(`${original.name}_entrance`, this.scene); binding.materials.push(multi);
      multi.subMaterials = original.subMaterials.map(material => this.cloneMaterial(material, binding)); return multi;
    }
    const material = original ? cloneEnvironmentMaterial(original, `${original.name}_entrance`) : new StandardMaterial('entrance_default', this.scene);
    if (!material) throw new Error(`无法克隆入场材质: ${original?.name ?? 'default'}`);
    binding.materials.push(material);
    const originalTextures = new Set(original?.getActiveTextures() ?? []);
    for (const texture of material.getActiveTextures()) if (!originalTextures.has(texture)) binding.textures.add(texture);
    material.unfreeze(); binding.wireframes.set(material, material.wireframe);
    if (['fade', 'stagger', 'assembly', 'hologram'].includes(this.settings!.effect)) {
      material.transparencyMode = original?.needAlphaTesting() ? Material.MATERIAL_ALPHATESTANDBLEND : Material.MATERIAL_ALPHABLEND;
    }
    binding.plugins.push(new EntrancePlugin(material, binding, this.settings!)); return material;
  }
  private installInstances(binding: Binding): void {
    const mesh = binding.mesh;
    if (mesh.hasThinInstances) {
      binding.thinBuffer = new Float32Array(mesh.thinInstanceCount * 4);
      mesh.thinInstanceSetBuffer(ATTRIBUTE, binding.thinBuffer, 4, false);
    } else if (mesh.instances.length) {
      mesh.registerInstancedBuffer(ATTRIBUTE, 4); binding.instanceBuffer = true;
      mesh.instancedBuffers[ATTRIBUTE] = new Vector4(1, 0, 0, 0);
      for (const instance of mesh.instances) instance.instancedBuffers[ATTRIBUTE] = new Vector4(1, 0, 0, 0);
    }
  }
  private totalDuration(): number {
    return this.settings!.durationSeconds + (this.settings!.effect === 'stagger' ? Math.max(0, this.targets.length - 1) * this.settings!.staggerSeconds : 0);
  }
  private targetProgress(index: number, local: number): number {
    const s = this.settings!;
    const delay = s.effect === 'stagger' ? index * s.staggerSeconds : 0;
    return clamp((local - s.delaySeconds - delay) / Math.max(.001, s.durationSeconds), 0, 1);
  }
  private update(local: number): void {
    const s = this.settings!;
    this.progress = clamp((local - s.delaySeconds) / Math.max(.001, this.totalDuration()), 0, 1);
    const minimum = new Vector3(Infinity, Infinity, Infinity); const maximum = new Vector3(-Infinity, -Infinity, -Infinity);
    for (const binding of this.bindings) for (const mesh of binding.targets.keys()) {
      if (mesh.isDisposed()) continue;
      mesh.computeWorldMatrix(true); const box = mesh.getBoundingInfo().boundingBox;
      minimum.minimizeInPlace(box.minimumWorld); maximum.maximizeInPlace(box.maximumWorld);
    }
    for (const binding of [...this.bindings]) {
      if (binding.mesh.isDisposed() || binding.mesh.material !== binding.replacement) {
        this.interrupted++; this.releaseBinding(binding); this.bindings.splice(this.bindings.indexOf(binding), 1); continue;
      }
      const index = binding.targets.get(binding.mesh) ?? 0;
      const progress = binding.targets.has(binding.mesh) ? this.targetProgress(index, local) : 1;
      binding.minimum.copyFrom(minimum); binding.maximum.copyFrom(maximum);
      for (const plugin of binding.plugins) plugin.progress = progress;
      if (s.effect === 'hologram') {
        // wireframe 是实例整次 draw 的状态；部分实例入场时保留兄弟实例完整表面。
        const isolated = !binding.instanceBuffer ||
          ((!binding.mesh.isEnabled() || !binding.mesh.isVisible || binding.targets.has(binding.mesh)) &&
            binding.mesh.instances.every(instance => !instance.isEnabled() || !instance.isVisible || binding.targets.has(instance)));
        for (const [material, wireframe] of binding.wireframes) material.wireframe = (isolated && this.progress < .5) || wireframe;
      }
      if (binding.instanceBuffer) {
        binding.mesh.instancedBuffers[ATTRIBUTE].x = progress;
        for (const instance of binding.mesh.instances) {
          const target = binding.targets.get(instance);
          // 动态实例继承当前源值；非目标实例必须保持原外观。
          instance.instancedBuffers[ATTRIBUTE] ??= new Vector4(1, 0, 0, 0);
          instance.instancedBuffers[ATTRIBUTE].x = target === undefined ? 1 : this.targetProgress(target, local);
        }
      }
      if (binding.thinBuffer) {
        for (let i = 0; i < binding.thinBuffer.length; i += 4) binding.thinBuffer[i] = progress;
        binding.mesh.thinInstanceBufferUpdated(ATTRIBUTE);
      }
    }
    this.updateParticles(local);
  }
  private createParticles(): void {
    const s = this.settings!;
    const candidates = this.bindings.flatMap(binding => [...binding.targets].map(([mesh, targetIndex]) => ({ mesh, targetIndex })));
    const count = clamp(Math.round(s.particleCount), 0, 5000);
    if (!candidates.length || count === 0) return;
    this.particlePositions = new Float32Array(count * 3);
    this.particleVisibility = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const { mesh, targetIndex } = candidates[i % candidates.length];
      const box = mesh.getBoundingInfo().boundingBox;
      const local = Vector3.Lerp(box.minimum, box.maximum, (i * .61803398875) % 1);
      // 包围盒各面的确定性采样，非示例模型专用坐标。
      local.set(box.minimum.x + ((i * .754877666) % 1) * (box.maximum.x - box.minimum.x), box.minimum.y + ((i * .569840291) % 1) * (box.maximum.y - box.minimum.y), box.minimum.z + ((i * .438447187) % 1) * (box.maximum.z - box.minimum.z));
      const side = i % 6; const axis = side % 3; const face = side < 3 ? box.minimum : box.maximum;
      if (axis === 0) local.x = face.x; else if (axis === 1) local.y = face.y; else local.z = face.z;
      const surface = Vector3.TransformCoordinates(local, mesh.computeWorldMatrix(true));
      const offset = new Vector3(Math.sin(i * 17.3), Math.cos(i * 11.7), Math.sin(i * 7.9)).scale(s.spreadMeters);
      this.particles.push({ mesh, local, origin: surface.add(offset), targetIndex });
    }
    const mesh = this.particleMesh = new Mesh('modelEntranceParticles', this.scene);
    mesh.isPickable = false; mesh.alwaysSelectAsActiveMesh = true;
    const data = new VertexData(); data.positions = this.particlePositions; data.indices = Array.from({ length: count }, (_, i) => i);
    const material = this.particleMaterial = new ShaderMaterial('modelEntranceParticles', this.scene, {
      vertexSource: 'precision highp float; attribute vec3 position; attribute float entranceParticleVisibility; varying float entranceParticleAlpha; uniform mat4 worldViewProjection; uniform float particleSize; void main(){ entranceParticleAlpha=entranceParticleVisibility; gl_Position=worldViewProjection*vec4(position,1.0); gl_PointSize=particleSize; }',
      fragmentSource: 'precision highp float; varying float entranceParticleAlpha; uniform vec3 particleColor; uniform float opacity; void main(){float d=length(gl_PointCoord-vec2(.5)); if(d>.5 || entranceParticleAlpha<.5) discard; gl_FragColor=vec4(particleColor,(1.0-smoothstep(.1,.5,d))*opacity);}',
    }, { attributes: ['position', 'entranceParticleVisibility'], uniforms: ['worldViewProjection', 'particleSize', 'particleColor', 'opacity'], needAlphaBlending: true });
    material.fillMode = Material.PointListDrawMode; material.disableDepthWrite = true;
    material.setFloat('particleSize', s.particleSize); material.setColor3('particleColor', Color3.FromHexString(s.color).scale(s.intensity));
    mesh.material = material; data.applyToMesh(mesh, true);
    mesh.setVerticesData('entranceParticleVisibility', this.particleVisibility, true, 1); this.updateParticles(0);
  }
  private updateParticles(local: number): void {
    if (!this.particleMesh || !this.particleMaterial || !this.settings) return;
    const visible = local >= this.settings.delaySeconds && this.progress < 1;
    this.particleMaterial.setFloat('opacity', visible ? Math.sin(Math.PI * this.progress) : 0);
    const end = new Vector3();
    const owned = new Set(this.bindings.flatMap(binding => [...binding.targets.keys()]));
    this.particles.forEach((particle, index) => {
      this.particleVisibility[index] = !particle.mesh.isDisposed() && particle.mesh.isEnabled() && particle.mesh.isVisible && particle.mesh.visibility > 0 && owned.has(particle.mesh) ? 1 : 0;
      if (particle.mesh.isDisposed()) return;
      Vector3.TransformCoordinatesToRef(particle.local, particle.mesh.computeWorldMatrix(true), end);
      const p = this.targetProgress(particle.targetIndex, local); const ease = 1 - Math.pow(1 - p, 3);
      this.particlePositions[index * 3] = particle.origin.x + (end.x - particle.origin.x) * ease;
      this.particlePositions[index * 3 + 1] = particle.origin.y + (end.y - particle.origin.y) * ease;
      this.particlePositions[index * 3 + 2] = particle.origin.z + (end.z - particle.origin.z) * ease;
    });
    this.particleMesh.updateVerticesData(VertexBuffer.PositionKind, this.particlePositions, false, false);
    this.particleMesh.updateVerticesData('entranceParticleVisibility', this.particleVisibility, false, false);
  }
  private releaseBinding(binding: Binding): void {
    for (const unsubscribe of binding.unsubscribe) unsubscribe();
    if (!binding.mesh.isDisposed() && binding.mesh.material === binding.replacement) binding.mesh.material = binding.original;
    if (binding.thinBuffer && !binding.mesh.isDisposed()) binding.mesh.thinInstanceSetBuffer(ATTRIBUTE, null, 4);
    if (binding.instanceBuffer) {
      delete binding.mesh.instancedBuffers[ATTRIBUTE];
      for (const instance of binding.mesh.instances) delete instance.instancedBuffers[ATTRIBUTE];
      // Babylon 无注销接口；只释放本会话命名的 VBO 和对应记录，保留其他实例属性。
      const storage = binding.mesh._userInstancedBuffersStorage;
      if (storage) {
        storage.vertexBuffers[ATTRIBUTE]?.dispose();
        for (const table of [storage.vertexBuffers, storage.data, storage.strides, storage.sizes]) delete table[ATTRIBUTE];
        for (const buffers of Object.values(storage.renderPasses ?? {})) { buffers[ATTRIBUTE]?.dispose(); delete buffers[ATTRIBUTE]; }
        binding.mesh._invalidateInstanceVertexArrayObject();
      }
    }
    for (const material of binding.materials.reverse()) material.dispose(false, false);
    for (const texture of binding.textures) texture.dispose();
    for (const release of binding.releases) release();
  }
  private release(): void {
    for (const binding of this.bindings) this.releaseBinding(binding);
    this.bindings = []; this.particleMesh?.dispose(); this.particleMaterial?.dispose(false, false);
    this.particleMesh = null; this.particleMaterial = null; this.particles = [];
    this.particlePositions = new Float32Array(0);
    this.particleVisibility = new Float32Array(0);
  }
}
