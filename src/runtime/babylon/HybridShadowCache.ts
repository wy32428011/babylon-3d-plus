import { HybridShadowNumericSignature, legacyHybridShadowSignature } from './hybridShadowSignatures.ts';
import { registerGeometryUpdateDelegate } from './lightingGeometryUpdates.ts';
import { Constants } from '@babylonjs/core/Engines/constants.js';
import { CascadedShadowGenerator } from '@babylonjs/core/Lights/Shadows/cascadedShadowGenerator.js';
import { InstancedMesh } from '@babylonjs/core/Meshes/instancedMesh.js';
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { SmartArray } from '@babylonjs/core/Misc/smartArray.js';
import { RenderingManager } from '@babylonjs/core/Rendering/renderingManager.js';
import type { AbstractEngine, AbstractMesh, Geometry, Observer, RenderTargetTexture, Scene, ShadowGenerator, SubMesh, ThinEngine } from '@babylonjs/core';

export type HybridShadowMeshRole = {
  mobility: 'static' | 'dynamic';
  castShadows: boolean;
  receiveShadows: boolean;
};
export type HybridShadowOptions = { cacheStaticShadows?: boolean; dynamicShadows?: boolean };
export type HybridShadowMetrics = {
  staticRenders: number;
  dynamicRenders: number;
  cacheInvalidations: number;
  staticCasterCount: number;
  dynamicCasterCount: number;
  textureBytes: number;
  cacheHits: number;
  cachedFaces: number;
  unsupportedCacheReason: string | null;
  validationErrors: string[];
};

type GeometryWatch = {
  previous: Geometry['onGeometryUpdated'];
  callback: Geometry['onGeometryUpdated'];
  version: number;
};

/**
 * 静态只描述可缓存的投射几何。带变形或动态实例的批次保守走动态深度路径，
 * 不改变业务侧的静态接收/lightmap 身份，避免把动画姿态留在静态缓存中。
 */
export class HybridShadowMeshState {
  readonly staticMeshes = new Set<AbstractMesh>();
  readonly dynamicMeshes = new Set<AbstractMesh>();
  revision = 0;
  private readonly signatures = new Map<AbstractMesh, string>();
  private readonly numericSignatures = new Map<AbstractMesh, HybridShadowNumericSignature>();
  private signatureMode: 'numeric' | 'legacy' = 'numeric';
  private readonly geometrySignatures = new Map<AbstractMesh, { id: number | undefined; version: number }>();
  private readonly geometries = new Map<Geometry, GeometryWatch>();
  private refreshedFrame = -1;

  setMeshes(meshes: Iterable<AbstractMesh>, roles: ReadonlyMap<AbstractMesh, HybridShadowMeshRole>): void {
    const candidates = [...meshes].filter(mesh => roles.get(mesh)?.castShadows !== false && !mesh.isDisposed());
    const batches = new Map<Mesh, AbstractMesh[]>();
    for (const mesh of candidates) {
      const source = mesh instanceof InstancedMesh ? mesh.sourceMesh : mesh instanceof Mesh ? mesh : null;
      if (source) {
        const batch = batches.get(source) ?? [];
        batch.push(mesh);
        batches.set(source, batch);
      }
    }
    const nextStatic = new Set<AbstractMesh>(), nextDynamic = new Set<AbstractMesh>();
    for (const mesh of candidates) {
      const source = mesh instanceof InstancedMesh ? mesh.sourceMesh : mesh instanceof Mesh ? mesh : null;
      const batch = source ? batches.get(source)! : [mesh];
      const deformable = source && (source.skeleton || source.morphTargetManager
        || source.bakedVertexAnimationManager?.isEnabled || source.hasThinInstances);
      const canCache = !deformable && batch.every(member => roles.get(member)?.mobility === 'static');
      (canCache ? nextStatic : nextDynamic).add(mesh);
    }
    const changed = nextStatic.size !== this.staticMeshes.size
      || [...nextStatic].some(mesh => !this.staticMeshes.has(mesh));
    this.staticMeshes.clear();
    this.dynamicMeshes.clear();
    for (const mesh of nextStatic) this.staticMeshes.add(mesh);
    for (const mesh of nextDynamic) this.dynamicMeshes.add(mesh);
    for (const mesh of this.geometrySignatures.keys()) if (!nextStatic.has(mesh)) {
      this.signatures.delete(mesh);
      this.numericSignatures.delete(mesh);
      this.geometrySignatures.delete(mesh);
    }
    this.syncGeometryWatches();
    this.refreshedFrame = -1;
    if (changed) this.revision++;
  }

  isStatic(mesh: AbstractMesh): boolean { return this.staticMeshes.has(mesh); }

  /** @internal 在等价性测试与诊断中切回旧签名；切换后的首帧重新建立快照。 */
  setSignatureMode(mode: 'numeric' | 'legacy'): void {
    if (this.signatureMode === mode) return;
    this.signatureMode = mode;
    this.signatures.clear();
    this.numericSignatures.clear();
    this.refreshedFrame = -1;
  }

  /** 每帧只读取静态网格的矩阵、几何版本及透明裁剪条件，不遍历顶点数据。 */
  refresh(): void {
    let changed = false;
    const currentGeometries = new Set<Geometry>();
    for (const mesh of this.staticMeshes) {
      const source = mesh instanceof InstancedMesh ? mesh.sourceMesh : mesh instanceof Mesh ? mesh : null;
      const geometry = source?.geometry;
      if (geometry) currentGeometries.add(geometry);
      if (geometry && !this.geometries.has(geometry)) this.watchGeometry(geometry);
      const watch = geometry && this.geometries.get(geometry);
      if (watch && geometry.onGeometryUpdated !== watch.callback) {
        this.watchGeometry(geometry, watch.version + 1);
      }
      const version = geometry ? this.geometries.get(geometry)?.version ?? 0 : 0;
      const previousGeometry = this.geometrySignatures.get(mesh);
      const geometryChanged = !previousGeometry || previousGeometry.id !== geometry?.uniqueId || previousGeometry.version !== version;
      if (geometryChanged) this.geometrySignatures.set(mesh, { id: geometry?.uniqueId, version });
      // 同一 renderId 内编辑变换/顶点时 Babylon 的快速返回会留下旧矩阵或世界包围盒。
      const world = mesh.computeWorldMatrix(geometryChanged || !mesh.isSynchronized());
      if (this.signatureMode === 'legacy') {
        const signature = legacyHybridShadowSignature(mesh, source, geometry, version, world);
        if (signature !== this.signatures.get(mesh)) { this.signatures.set(mesh, signature); changed = true; }
      } else {
        let signature = this.numericSignatures.get(mesh);
        if (!signature) { signature = new HybridShadowNumericSignature(); this.numericSignatures.set(mesh, signature); }
        if (signature.update(mesh, source, geometry, version, world)) changed = true;
      }
    }
    for (const [geometry, watch] of this.geometries) {
      if (!currentGeometries.has(geometry)) this.unwatchGeometry(geometry, watch);
    }
    if (changed) this.revision++;
  }

  /** 多灯共用同一个场景静态版本，避免每盏灯/每个 cube 面重新扫描全部静态网格。 */
  refreshForFrame(frame: number): void {
    if (this.refreshedFrame === frame) return;
    this.refreshedFrame = frame;
    this.refresh();
  }

  dispose(): void {
    for (const [geometry, watch] of this.geometries) this.unwatchGeometry(geometry, watch);
    this.signatures.clear();
    this.numericSignatures.clear();
    this.geometrySignatures.clear();
    this.staticMeshes.clear();
    this.dynamicMeshes.clear();
  }

  private syncGeometryWatches(): void {
    for (const mesh of this.staticMeshes) {
      const source = mesh instanceof InstancedMesh ? mesh.sourceMesh : mesh instanceof Mesh ? mesh : null;
      if (source?.geometry && !this.geometries.has(source.geometry)) this.watchGeometry(source.geometry);
    }
  }

  private watchGeometry(geometry: Geometry, version = 0): void {
    const previous = geometry.onGeometryUpdated;
    const watch: GeometryWatch = {
      previous, version,
      callback: (updated, kind) => { watch.version++; previous?.(updated, kind); },
    };
    registerGeometryUpdateDelegate(geometry, watch.callback, previous);
    geometry.onGeometryUpdated = watch.callback;
    this.geometries.set(geometry, watch);
  }

  private unwatchGeometry(geometry: Geometry, watch: GeometryWatch): void {
    if (geometry.onGeometryUpdated === watch.callback) geometry.onGeometryUpdated = watch.previous;
    this.geometries.delete(geometry);
  }
}

type CachedFace = {
  framebuffer: WebGLFramebuffer;
  color: WebGLRenderbuffer;
  depth: WebGLRenderbuffer;
  signature: string;
  bytes: number;
};
type ShadowRender = NonNullable<RenderTargetTexture['customRenderFunction']>;
type ShadowLists = [SmartArray<SubMesh>, SmartArray<SubMesh>, SmartArray<SubMesh>, SmartArray<SubMesh>];
type PreparedShadowGroup = { id: number; original: ShadowLists; statics: ShadowLists; dynamics: ShadowLists };

/**
 * 每盏灯/每个 cube 面/每个 CSM 层保存未滤波的静态深度。
 * 静态深度先复制回原生阴影目标，再让动态 caster 经过同一次深度测试；
 * 因而接收端采样的是遮挡并集，PCF/Poisson 只过滤一次，不叠乘已滤波阴影。
 */
export class HybridShadowCache {
  readonly metrics = {
    staticRenders: 0, dynamicRenders: 0, cacheInvalidations: 0, cacheHits: 0,
    unsupportedCacheReason: null as string | null,
  };
  private readonly generator: ShadowGenerator;
  private readonly state: HybridShadowMeshState;
  private readonly scene: Scene;
  private readonly shadowMap: RenderTargetTexture;
  private readonly originalRender: ShadowRender;
  private readonly renderCallback: ShadowRender;
  private readonly faces = new Map<number, CachedFace>();
  private readonly groups = new Map<number, PreparedShadowGroup>();
  private activeGroups: PreparedShadowGroup[] = [];
  private facePrepared = false;
  private faceRestored = false;
  private readonly faceObserver: Observer<number>;
  private readonly bindObserver: Observer<RenderTargetTexture>;
  private readonly restoreObserver: Observer<AbstractEngine>;
  private faceIndex = 0;
  private revision = 0;
  private enabled = true;
  private disposed = false;
  private readonly gl: WebGL2RenderingContext | null;
  private readonly engine: ThinEngine;

  constructor(generator: ShadowGenerator, state: HybridShadowMeshState) {
    this.generator = generator;
    this.state = state;
    this.scene = generator.getLight().getScene();
    this.engine = this.scene.getEngine() as ThinEngine;
    this.gl = this.engine.webGLVersion >= 2 && typeof this.engine._gl?.blitFramebuffer === 'function'
      ? this.engine._gl : null;
    if (!this.gl) this.metrics.unsupportedCacheReason = '静态深度缓存需要 WebGL 2；当前使用完整实时阴影。';
    this.shadowMap = generator.getShadowMap()!;
    this.originalRender = this.shadowMap.customRenderFunction!;
    this.renderCallback = (opaque, alphaTest, transparent, depthOnly) => this.render([opaque, alphaTest, transparent, depthOnly]);
    this.shadowMap.customRenderFunction = this.renderCallback;
    this.faceObserver = this.shadowMap.onBeforeRenderObservable.add(face => {
      this.faceIndex = face; this.facePrepared = false; this.faceRestored = false;
    });
    this.bindObserver = this.shadowMap.onBeforeBindObservable.add(() => {
      this.state.refreshForFrame(this.scene.getFrameId());
    });
    this.restoreObserver = this.engine.onContextRestoredObservable.add(() => {
      this.releaseFaces();
      this.invalidate();
    });
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    this.invalidate();
    if (!enabled) this.releaseFaces();
  }

  invalidate(): void { this.revision++; }

  get cachedFaces(): number { return this.faces.size; }
  get textureBytes(): number { return [...this.faces.values()].reduce((total, face) => total + face.bytes, 0); }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.shadowMap.customRenderFunction === this.renderCallback) this.shadowMap.customRenderFunction = this.originalRender;
    this.shadowMap.onBeforeRenderObservable.remove(this.faceObserver);
    this.shadowMap.onBeforeBindObservable.remove(this.bindObserver);
    this.engine.onContextRestoredObservable.remove(this.restoreObserver);
    this.releaseFaces();
    for (const group of this.groups.values()) for (const list of [...group.statics, ...group.dynamics]) list.dispose();
    this.groups.clear(); this.activeGroups = [];
  }

  /** 原生阴影先 dispatch 完全部组；这里仅捕获现有 SmartArray，不触发组事件或实际绘制。 */
  private prepareFaceGroups(): void {
    this.facePrepared = true;
    this.activeGroups = [];
    const manager = (this.shadowMap as unknown as { _objectRenderer?: { renderingManager: RenderingManager } })._objectRenderer?.renderingManager;
    if (!manager) {
      this.metrics.unsupportedCacheReason = '无法读取原生阴影分组，保留完整实时深度。';
      this.releaseFaces();
      return;
    }
    for (let id = RenderingManager.MIN_RENDERINGGROUPS; id < RenderingManager.MAX_RENDERINGGROUPS; id++) {
      const native = manager.getRenderingGroup(id);
      if (native._empty) continue;
      let original: ShadowLists | undefined;
      native.render((opaque, alphaTest, transparent, depthOnly) => { original = [opaque, alphaTest, transparent, depthOnly]; }, false, false, null);
      if (!original) continue;
      let group = this.groups.get(id);
      if (!group) {
        const lists = () => Array.from({ length: 4 }, () => new SmartArray<SubMesh>(64)) as ShadowLists;
        group = { id, original, statics: lists(), dynamics: lists() }; this.groups.set(id, group);
      }
      group.original = original;
      for (let index = 0; index < 4; index++) {
        const statics = group.statics[index], dynamics = group.dynamics[index], source = original[index];
        statics.reset(); dynamics.reset();
        for (let i = 0; i < source.length; i++) {
          const subMesh = source.data[i];
          (this.state.isStatic(subMesh.getEffectiveMesh()) ? statics : dynamics).push(subMesh);
        }
      }
      this.activeGroups.push(group);
    }
    // Babylon ShadowGenerator 默认禁止组间清除深度，所有组共享最近遮挡并集。
    // 若外部显式改为组间清除，不能重排静态/动态阶段，应完整保留原生顺序。
    const clearsDepth = RenderingManager.AUTOCLEAR && this.activeGroups.slice(1).some(group => {
      const setup = manager._useSceneAutoClearSetup ? this.scene.getAutoClearDepthStencilSetup(group.id)
        : manager.getAutoClearDepthStencilSetup(group.id);
      return setup?.autoClear && setup.depth;
    });
    const customDepthOnlyColor = !this.generator.usePercentageCloserFiltering && this.activeGroups.length > 1
      && this.activeGroups.some(group => group.original.some(list => {
        for (let index = 0; index < list.length; index++) {
          const material = list.data[index].getMaterial(), wrapper = material?.shadowDepthWrapper;
          if (wrapper && (wrapper.standalone ? wrapper.baseMaterial : material)?.disableColorWrite) return true;
        }
        return false;
      }));
    this.metrics.unsupportedCacheReason = !this.gl ? '静态深度缓存需要 WebGL 2；当前使用完整实时阴影。'
      : clearsDepth ? '阴影组之间显式清除深度，当前保留完整原生实时顺序。'
        : customDepthOnlyColor ? '自定义阴影材质禁用颜色写入，当前保留完整原生实时顺序。' : null;
    if (this.metrics.unsupportedCacheReason) this.releaseFaces();
  }

  private render(lists: ShadowLists): void {
    if (!this.facePrepared) this.prepareFaceGroups();
    const group = this.activeGroups.find(value => value.original[0] === lists[0]);
    if (!group || !this.enabled || !this.gl || this.metrics.unsupportedCacheReason || this.disposed) {
      // 缓存关闭及不支持的定制状态必须调用完整原生路径，作为真实像素对照基准。
      this.originalRender(...lists);
      if (group?.statics.some(list => list.length > 0)) this.metrics.staticRenders++;
      if (!group || group.dynamics.some(list => list.length > 0)) this.metrics.dynamicRenders++;
      return;
    }
    if (!this.faceRestored) this.renderStaticFace();
    // 同一 face 的缓存只恢复一次；后续组只能追加动态，不能擦除前组的动态遮挡。
    this.originalRender(...group.dynamics);
    if (group.dynamics.some(list => list.length > 0)) this.metrics.dynamicRenders++;
  }

  private renderStaticFace(): void {
    this.faceRestored = true;
    const matrix = this.generator instanceof CascadedShadowGenerator
      ? this.generator.getCascadeTransformMatrix(this.faceIndex)
      : this.generator.getTransformMatrix();
    if (!matrix) throw new Error('混合阴影缺少当前级联的投影矩阵。');
    const light = this.generator.getLight();
    const signature = [
      this.revision, this.state.revision, ...matrix.asArray(), this.generator.bias, this.generator.normalBias,
      this.generator.filter, this.engine.useReverseDepthBuffer, this.scene.useRightHandedSystem,
      ...this.scene.floatingOriginOffset.asArray(),
      light.getDepthMinZ(this.scene.activeCamera!), light.getDepthMaxZ(this.scene.activeCamera!),
      this.generator.transparencyShadow, this.generator.forceBackFacesOnly,
      ...[this.scene.clipPlane, this.scene.clipPlane2, this.scene.clipPlane3,
        this.scene.clipPlane4, this.scene.clipPlane5, this.scene.clipPlane6]
        .map(plane => plane ? [...plane.normal.asArray(), plane.d].join(',') : ''),
    ].join(',');
    let face = this.faces.get(this.faceIndex);
    if (face && face.signature === signature) {
      this.copyFace(face, false);
      this.metrics.cacheHits++;
    } else {
      if (face?.signature) this.metrics.cacheInvalidations++;
      // 首组可能只有动态，仍须先汇集所有后续组静态；缓存中永远不含上一组动态旧姿态。
      for (const group of this.activeGroups) this.originalRender(...group.statics);
      this.metrics.staticRenders++;
      if (this.staticShadersReady()) {
        face ??= this.createFace();
        if (face) {
          this.faces.set(this.faceIndex, face);
          this.copyFace(face, true);
          face.signature = signature;
        }
      }
    }
  }

  private staticShadersReady(): boolean {
    const readiness = this.shadowMap.customIsReadyFunction;
    if (!readiness) return true;
    for (const mesh of this.state.staticMeshes) {
      if (!mesh.isDisposed() && mesh.isEnabled() && mesh.isVisible
        && !readiness(mesh, this.shadowMap.refreshRate, true)) return false;
    }
    return true;
  }

  private createFace(): CachedFace | undefined {
    const gl = this.gl!;
    const texture = this.shadowMap.getInternalTexture();
    const depthTexture = this.shadowMap.renderTarget?.depthStencilTexture;
    if (!texture || !depthTexture) {
      this.metrics.unsupportedCacheReason = '阴影目标缺少可复制的深度纹理，当前使用完整实时阴影。';
      return undefined;
    }
    const previousRead = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
    const previousDraw = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
    const previousRenderbuffer = gl.getParameter(gl.RENDERBUFFER_BINDING) as WebGLRenderbuffer | null;
    // Babylon 9 的 cube depth texture 没有填写 format 元数据；以实际附件规格为准，
    // 否则把 DEPTH_COMPONENT24 当成未定格式会导致点光六面缓存 framebuffer 不完整。
    const depthBits = gl.getFramebufferAttachmentParameter(gl.DRAW_FRAMEBUFFER, gl.DEPTH_ATTACHMENT,
      gl.FRAMEBUFFER_ATTACHMENT_DEPTH_SIZE) as number;
    const depthComponent = gl.getFramebufferAttachmentParameter(gl.DRAW_FRAMEBUFFER, gl.DEPTH_ATTACHMENT,
      gl.FRAMEBUFFER_ATTACHMENT_COMPONENT_TYPE) as number;
    const depthFormat = depthComponent === gl.FLOAT ? gl.DEPTH_COMPONENT32F
      : depthBits === 16 ? gl.DEPTH_COMPONENT16 : gl.DEPTH_COMPONENT24;
    const framebuffer = gl.createFramebuffer(), color = gl.createRenderbuffer(), depth = gl.createRenderbuffer();
    if (!framebuffer || !color || !depth) {
      if (framebuffer) gl.deleteFramebuffer(framebuffer);
      if (color) gl.deleteRenderbuffer(color);
      if (depth) gl.deleteRenderbuffer(depth);
      throw new Error('无法为混合阴影分配静态深度缓存。');
    }
    const { width, height } = this.shadowMap.getSize();
    try {
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.bindRenderbuffer(gl.RENDERBUFFER, color);
      gl.renderbufferStorage(gl.RENDERBUFFER,
        this.engine._getRGBABufferInternalSizedFormat(texture.type, texture.format, texture._useSRGBBuffer),
        width, height);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, color);
      gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
      gl.renderbufferStorage(gl.RENDERBUFFER, depthFormat, width, height);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        throw new Error('当前显卡不支持混合阴影静态深度缓存的纹理格式。');
      }
      const colorComponents = texture.format === Constants.TEXTUREFORMAT_RED ? 1 : 4;
      const componentBytes = texture.type === Constants.TEXTURETYPE_FLOAT ? 4
        : texture.type === Constants.TEXTURETYPE_HALF_FLOAT ? 2 : 1;
      return { framebuffer, color, depth, signature: '', bytes: width * height * (colorComponents * componentBytes + 4) };
    } catch (error) {
      gl.deleteFramebuffer(framebuffer); gl.deleteRenderbuffer(color); gl.deleteRenderbuffer(depth);
      throw error;
    } finally {
      gl.bindRenderbuffer(gl.RENDERBUFFER, previousRenderbuffer);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, previousRead);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, previousDraw);
    }
  }

  private copyFace(face: CachedFace, save: boolean): void {
    const gl = this.gl!;
    const read = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
    const draw = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
    const scissor = gl.isEnabled(gl.SCISSOR_TEST);
    const { width, height } = this.shadowMap.getSize();
    try {
      if (scissor) gl.disable(gl.SCISSOR_TEST);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, save ? draw : face.framebuffer);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, save ? face.framebuffer : draw);
      const mask = gl.DEPTH_BUFFER_BIT | (this.generator.usePercentageCloserFiltering ? 0 : gl.COLOR_BUFFER_BIT);
      gl.blitFramebuffer(0, 0, width, height, 0, 0, width, height, mask, gl.NEAREST);
    } finally {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, read);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, draw);
      if (scissor) gl.enable(gl.SCISSOR_TEST);
    }
  }

  private releaseFaces(): void {
    if (this.gl) for (const face of this.faces.values()) {
      this.gl.deleteFramebuffer(face.framebuffer);
      this.gl.deleteRenderbuffer(face.color);
      this.gl.deleteRenderbuffer(face.depth);
    }
    this.faces.clear();
  }
}
