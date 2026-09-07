import {
  type AbstractMesh, Color3, Color4, Constants, DirectionalLight, Material,
  MaterialPluginBase, Matrix, Mesh, PBRMaterial, RenderTargetTexture, type Scene,
  ShaderMaterial, ShadowGenerator, StandardMaterial, Texture, Vector3, Vector4, VertexBuffer,
  type MaterialDefines, type SubMesh, type UniformBuffer, type AbstractEngine,
} from '@babylonjs/core';
import type { SceneShadowSettings } from '../../editor/model/SceneDocument';
import type { SceneShadowBakeSnapshot } from '../../editor/model/sceneShadowBake';
import { EnvironmentShadowMaterialPlugin, setEnvironmentShadowGenerator } from './EnvironmentShadowMaterialPlugin';
import { partitionGroundShadowLayers, selectGroundShadowReceivers, type GroundShadowReceiver } from './staticShadowReceivers';
import { cloneEnvironmentMaterial } from './cloneEnvironmentMaterial';
import { planGroundShadowLayer, type ShadowBounds } from './staticShadowQuality';
import { SCENE_SHADOW_BAKE_MAX_PIXELS } from '../../../electron/shared/sceneShadowBakeContract';

export type ShadowBakeSurface = { key: string; mesh: AbstractMesh; material: Material | null; useVertexColors?: boolean; sourceAlpha?: number };
type BakeMaterial = PBRMaterial | StandardMaterial;
type UvBounds = [number, number, number, number];
const MAX_PIXELS = 16 * 1024 * 1024;
const MAX_DATA_LENGTH = 32 * 1024 * 1024;

function cancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('阴影烘焙已取消。');
}

async function renderReadyTarget(target: RenderTargetTexture, signal?: AbortSignal): Promise<void> {
  const deadline = performance.now() + 30_000;
  while (!target.isReadyForRendering()) {
    cancelled(signal);
    if (performance.now() > deadline) throw new Error('阴影着色器未能就绪，本次结果未保存；请查看渲染错误。');
    await new Promise<void>(resolve => setTimeout(resolve, 16));
  }
  cancelled(signal); target.render(false);
}

/** 只修改临时烘焙材质的裁剪坐标，模型世界位置和源 UV 均保持不变。 */
class UvBakeProjection extends MaterialPluginBase {
  constructor(material: Material, private readonly bounds: UvBounds, private readonly worldHeight?: [number, number]) {
    super(material, 'ShadowBakeUv', 210, { UV1: true }, true, true);
    this.doNotSerialize = true;
  }
  override getClassName(): string { return 'UvBakeProjection'; }
  override prepareDefinesBeforeAttributes(defines: MaterialDefines): void {
    if (this.worldHeight) return;
    defines.UV1 = true;
    defines._needUVs = true;
  }
  override getAttributes(attributes: string[]): void { if (!this.worldHeight && !attributes.includes('uv')) attributes.push('uv'); }
  override getUniforms() { return { externalUniforms: ['bakeUvBounds', 'bakeWorldHeight'] }; }
  override bindForSubMesh(_ubo: UniformBuffer, _scene: Scene, _engine: AbstractEngine, subMesh: SubMesh): void {
    subMesh.effect?.setFloat4('bakeUvBounds', ...this.bounds);
    if (this.worldHeight) subMesh.effect?.setFloat2('bakeWorldHeight', ...this.worldHeight);
  }
  override getCustomCode(type: string): Record<string, string> | null {
    if (type === 'vertex') return {
      CUSTOM_VERTEX_DEFINITIONS: 'uniform vec4 bakeUvBounds; uniform vec2 bakeWorldHeight;',
      CUSTOM_VERTEX_MAIN_END: this.worldHeight
        ? 'gl_Position=vec4(((worldPos.xz-bakeUvBounds.xy)/(bakeUvBounds.zw-bakeUvBounds.xy))*2.0-1.0,((bakeWorldHeight.y-worldPos.y)/(bakeWorldHeight.y-bakeWorldHeight.x))*2.0-1.0,1.0);'
        : 'gl_Position = vec4(((uv - bakeUvBounds.xy) / (bakeUvBounds.zw - bakeUvBounds.xy)) * 2.0 - 1.0, 0.0, 1.0);',
    };
    if (type === 'fragment') return {
      CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR: this.worldHeight ? '#ifdef ENVIRONMENT_SHADOW\nfinalColor=vec4(vec3(environmentShadowFactor(vPositionW)),1.0);\n#endif' : '',
    };
    return null;
  }
}

function inspectSurface(surface: ShadowBakeSurface) {
  const { mesh, material } = surface;
  const fail = (reason: string): never => { throw new Error(`环境表面「${mesh.name}」${reason}，未生成烘焙结果。`); };
  if (!(mesh instanceof Mesh) || mesh.hasThinInstances || mesh.skeleton || mesh.morphTargetManager) fail('含实例、骨骼或变形');
  if (!(material instanceof PBRMaterial || material instanceof StandardMaterial)) fail('不是单一 PBR/Standard 材质');
  const supported = material as BakeMaterial;
  if (supported.detailMap.isEnabled || (supported instanceof StandardMaterial && (supported.reflectionTexture || supported.refractionTexture))) {
    fail('包含细节、反射或折射纹理，需要静态遮罩保留原材质');
  }
  if ((surface.sourceAlpha ?? 1) < 0.999) fail('使用透明材质');
  const colors = mesh.getVerticesData(VertexBuffer.ColorKind);
  if (mesh.hasVertexAlpha && colors?.some((value, index) => index % 4 === 3 && value < 0.999)) fail('含透明顶点颜色');
  const base = supported instanceof PBRMaterial ? supported.albedoTexture : supported.diffuseTexture;
  if (supported.opacityTexture || supported.needAlphaTesting()
    || (base?.hasAlpha && (supported instanceof PBRMaterial ? supported.useAlphaFromAlbedoTexture : supported.useAlphaFromDiffuseTexture))) {
    fail('含透明裁切纹理，不能直接合成为不透明环境纹理');
  }
  const uv = mesh.getVerticesData(VertexBuffer.UVKind);
  if (!uv || uv.length < 6 || !mesh.getIndices()?.length) fail('缺少有效 UV 或三角形索引');
  const bounds: UvBounds = [Infinity, Infinity, -Infinity, -Infinity];
  for (const vertex of new Set(mesh.getIndices()!)) {
    const u = uv![vertex * 2], v = uv![vertex * 2 + 1];
    if (!Number.isFinite(u) || !Number.isFinite(v)) fail('含非法 UV');
    bounds[0] = Math.min(bounds[0], u); bounds[1] = Math.min(bounds[1], v);
    bounds[2] = Math.max(bounds[2], u); bounds[3] = Math.max(bounds[3], v);
  }
  if (bounds[2] - bounds[0] < 1e-6 || bounds[3] - bounds[1] < 1e-6) fail('UV 面积为零');
  const sourceSize = base?.getSize();
  const width = sourceSize?.width || 512, height = sourceSize?.height || 512;
  if (width > 4096 || height > 4096) fail('原色贴图超过 4096 像素，需先规划烘焙纹理预算');
  return { ...surface, material: supported, bounds, width, height };
}

function groupSurfaces(surfaces: ShadowBakeSurface[]) {
  const groups = new Map<BakeMaterial, ReturnType<typeof inspectSurface>[]>();
  for (const surface of surfaces) {
    const plan = inspectSurface(surface);
    const group = groups.get(plan.material) ?? []; group.push(plan); groups.set(plan.material, group);
  }
  return [...groups.values()].map(surfaces => {
    const bounds: UvBounds = [Infinity, Infinity, -Infinity, -Infinity];
    for (const surface of surfaces) {
      bounds[0] = Math.min(bounds[0], surface.bounds[0]); bounds[1] = Math.min(bounds[1], surface.bounds[1]);
      bounds[2] = Math.max(bounds[2], surface.bounds[2]); bounds[3] = Math.max(bounds[3], surface.bounds[3]);
    }
    const material = surfaces[0].material;
    const base = material instanceof PBRMaterial ? material.albedoTexture : material.diffuseTexture;
    if (base && base.coordinatesIndex !== 0) throw new Error(`环境材质「${material.name}」使用第二套纹理坐标，需先规划独立烘焙 UV。`);
    const matrix = base?.getTextureMatrix().m;
    const densityU = matrix ? Math.hypot(matrix[0], matrix[1]) : 1;
    const densityV = matrix ? Math.hypot(matrix[4], matrix[5]) : 1;
    const width = Math.ceil(surfaces[0].width * Math.max(1, (bounds[2] - bounds[0]) * densityU));
    const height = Math.ceil(surfaces[0].height * Math.max(1, (bounds[3] - bounds[1]) * densityV));
    if (width > 4096 || height > 4096) throw new Error(`环境材质「${material.name}」的平铺纹理需要超过 4096 像素才能保持清晰度，请先整理烘焙 UV 图集。`);
    return { material, surfaces, bounds, width, height };
  });
}

/** RGBA 数据以 UV 原点为第一行编码；加载时 invertY=false 与此约定成对使用。 */
function encodeTexture(pixels: Uint8Array, width: number, height: number, coverage: Uint8Array): string {
  // 扩展岛边缘两个像素，避免线性采样在 UV 岛边界采到透明黑色。
  const filled = new Uint8Array(width * height);
  for (let i = 0; i < filled.length; i++) filled[i] = coverage[i * 4] > 0 ? 1 : 0;
  for (let pass = 0; pass < 2; pass++) {
    const before = filled.slice();
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (before[i]) continue;
      const adjacent = [x > 0 ? i - 1 : -1, x + 1 < width ? i + 1 : -1, y > 0 ? i - width : -1, y + 1 < height ? i + width : -1];
      const source = adjacent.find(index => index >= 0 && before[index]);
      if (source == null) continue;
      pixels.set(pixels.subarray(source * 4, source * 4 + 4), i * 4);
      filled[i] = 1;
    }
  }
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('浏览器不能创建阴影纹理编码画布。');
  context.putImageData(new ImageData(new Uint8ClampedArray(pixels), width, height), 0, 0);
  return canvas.toDataURL('image/png');
}

/** 显式烘焙期间暂停本引擎画面；完成后释放全部实时阴影资源，再恢复原渲染循环。 */
async function bakeUvEnvironmentShadows(
  scene: Scene, surfaces: ShadowBakeSurface[], casters: AbstractMesh[], settings: SceneShadowSettings,
  signature: string, signal?: AbortSignal,
): Promise<SceneShadowBakeSnapshot> {
  cancelled(signal);
  if (!surfaces.length) throw new Error('请先加载有可渲染表面的环境模型。');
  const plans = groupSurfaces(surfaces);
  if (plans.reduce((sum, plan) => sum + plan.width * plan.height * plan.surfaces.length, 0) > MAX_PIXELS) {
    throw new Error('烘焙纹理超过 1600 万像素预算；为避免显存增长导致掉帧，本次烘焙已停止。');
  }
  const engine = scene.getEngine();
  const loops = [...engine.activeRenderLoops];
  const previousShadowState = scene.shadowsEnabled;
  const imageProcessing = scene.imageProcessingConfiguration;
  const previousImageProcessing = imageProcessing.isEnabled;
  const previousReceive = new Map(surfaces.map(surface => [surface.mesh, surface.mesh.receiveShadows]));
  const previousVertexColors = new Map(surfaces.map(surface => [surface.mesh, surface.mesh.useVertexColors]));
  const previousMaterials = new Map(surfaces.map(surface => [surface.mesh, surface.mesh.material]));
  const sourceMaterialStates = new Map(plans.map(plan => [plan.material, {
    alpha: plan.material.alpha, transparencyMode: plan.material.transparencyMode, frozen: plan.material.isFrozen,
  }]));
  const light = new DirectionalLight('__StaticShadowBakeSun', Vector3.Down(), scene);
  const azimuth = settings.sunAzimuthDegrees * Math.PI / 180, elevation = settings.sunElevationDegrees * Math.PI / 180;
  light.direction.set(-Math.sin(azimuth) * Math.cos(elevation), -Math.sin(elevation), -Math.cos(azimuth) * Math.cos(elevation));
  const center = surfaces[0].mesh.getBoundingInfo().boundingBox.centerWorld;
  light.position.copyFrom(center.subtract(light.direction.scale(100)));
  light.intensity = 0; light.autoUpdateExtends = true; light.autoCalcShadowZBounds = true;
  const generator = new ShadowGenerator(2048, light);
  generator.bias = settings.bias; generator.normalBias = settings.normalBias; generator.darkness = settings.darkness;
  generator.usePercentageCloserFiltering = true; generator.filteringQuality = ShadowGenerator.QUALITY_HIGH;
  generator.getShadowMap()!.renderList = [...new Set(casters)];
  const maskMaterial = new ShaderMaterial('__BakeUvCoverage', scene, {
    vertexSource: 'precision highp float; attribute vec3 position; attribute vec2 uv; uniform vec4 bakeUvBounds; void main(){gl_Position=vec4(((uv-bakeUvBounds.xy)/(bakeUvBounds.zw-bakeUvBounds.xy))*2.0-1.0,0.0,1.0);}',
    fragmentSource: 'precision highp float; void main(){gl_FragColor=vec4(0.25,0.25,0.25,1.0);}',
  }, { attributes: ['position', 'uv'], uniforms: ['bakeUvBounds'], needAlphaBlending: true });
  maskMaterial.backFaceCulling = false; maskMaterial.disableDepthWrite = true;
  maskMaterial.depthFunction = Constants.ALWAYS; maskMaterial.alphaMode = Constants.ALPHA_ADD;
  const output: SceneShadowBakeSnapshot = { version: 1, signature, createdAt: new Date().toISOString(), surfaces: [] };
  let dataLength = 0;
  try {
    loops.forEach(loop => engine.stopRenderLoop(loop));
    scene.shadowsEnabled = true; imageProcessing.isEnabled = false;
    setEnvironmentShadowGenerator(scene, generator);
    for (const surface of surfaces) {
      surface.mesh.receiveShadows = true;
      surface.mesh.useVertexColors = surface.useVertexColors ?? surface.mesh.useVertexColors;
      surface.mesh.material = surface.material;
    }
    // 环境的编辑透明度只影响显示，不能改变用于烘焙的物理遮挡。
    for (const material of sourceMaterialStates.keys()) {
      material.unfreeze(); material.alpha = 1; material.transparencyMode = Material.MATERIAL_OPAQUE;
    }
    await generator.forceCompilationAsync(); cancelled(signal);
    if (casters.some(mesh => mesh.hasThinInstances || mesh.isAnInstance)) await generator.forceCompilationAsync({ useInstances: true });
    await renderReadyTarget(generator.getShadowMap()!, signal);
    for (const plan of plans) {
      cancelled(signal);
      const target = new RenderTargetTexture('__BakeUvTarget', { width: plan.width, height: plan.height }, scene, false);
      const material = cloneEnvironmentMaterial(plan.material, '__BakeMaterial');
      if (!material) throw new Error(`不能克隆环境材质「${plan.material.name}」。`);
      target.renderList = plan.surfaces.map(surface => surface.mesh); target.clearColor = new Color4(0, 0, 0, 0);
      target.renderParticles = false; target.renderSprites = false; target.ignoreCameraViewport = true;
      target.activeCamera = scene.activeCamera;
      try {
        maskMaterial.setVector4('bakeUvBounds', new Vector4(...plan.bounds));
        for (const surface of plan.surfaces) await maskMaterial.forceCompilationAsync(surface.mesh);
        cancelled(signal);
        target.setMaterialForRendering(target.renderList, maskMaterial); await renderReadyTarget(target, signal);
        const coverage = new Uint8Array((await target.readPixels())!.buffer);
        if (coverage.some((value, index) => index % 4 === 0 && value > 70)) {
          throw new Error(`环境材质「${plan.material.name}」UV 重叠（含共享材质的不同表面）；请先展开不重叠 UV，避免增加材质和绘制批次。`);
        }
        material.unfreeze(); material.alpha = 1; material.alphaMode = Constants.ALPHA_DISABLE;
        material.transparencyMode = Material.MATERIAL_OPAQUE;
        material.backFaceCulling = false; material.disableDepthWrite = true; material.depthFunction = Constants.ALWAYS;
        material.fogEnabled = false;
        new EnvironmentShadowMaterialPlugin(material as BakeMaterial);
        new UvBakeProjection(material, plan.bounds);
        for (const surface of plan.surfaces) await material.forceCompilationAsync(surface.mesh);
        cancelled(signal);
        target.setMaterialForRendering(target.renderList, material); await renderReadyTarget(target, signal);
        const pixels = new Uint8Array((await target.readPixels())!.buffer);
        const dataUrl = encodeTexture(pixels, plan.width, plan.height, coverage);
        dataLength += dataUrl.length * plan.surfaces.length;
        if (dataLength > MAX_DATA_LENGTH) throw new Error('烘焙 PNG 数据超过 32 MiB 场景快照预算，本次结果未保存。');
        for (const surface of plan.surfaces) output.surfaces.push({ key: surface.key, dataUrl, width: plan.width, height: plan.height, uvBounds: plan.bounds });
        await new Promise<void>(resolve => setTimeout(resolve, 0));
      } finally { target.setMaterialForRendering(target.renderList!, undefined); target.dispose(); material.dispose(false, false); }
    }
    return output;
  } finally {
    for (const [mesh, receive] of previousReceive) if (!mesh.isDisposed()) mesh.receiveShadows = receive;
    for (const [mesh, enabled] of previousVertexColors) if (!mesh.isDisposed()) mesh.useVertexColors = enabled;
    for (const [mesh, material] of previousMaterials) if (!mesh.isDisposed()) mesh.material = material;
    for (const [material, state] of sourceMaterialStates) {
      material.alpha = state.alpha; material.transparencyMode = state.transparencyMode;
      if (state.frozen) material.freeze();
      material.markDirty(true);
    }
    setEnvironmentShadowGenerator(scene, null);
    maskMaterial.dispose(); generator.dispose(); light.dispose();
    scene.shadowsEnabled = previousShadowState; imageProcessing.isEnabled = previousImageProcessing;
    if (!engine.isDisposed) loops.forEach(loop => engine.runRenderLoop(loop));
  }
}

/** 每个高度层单独渲染，避免深度测试覆盖下层的阴影结果。 */
async function renderGroundShadowLayer(scene: Scene, receivers: GroundShadowReceiver[], casters: AbstractMesh[],
  settings: SceneShadowSettings, bounds: ShadowBounds, width: number, height: number, signal?: AbortSignal): Promise<Uint8ClampedArray<ArrayBuffer>> {
  cancelled(signal);
  // 连续离屏烘焙需要独立渲染批次，否则 Babylon 会跳过上一层已投射过的 subMesh。
  scene.incrementRenderId();
  const min = new Vector3(Infinity, Infinity, Infinity), max = new Vector3(-Infinity, -Infinity, -Infinity);
  for (const receiver of receivers) { min.minimizeInPlace(receiver.min); max.maximizeInPlace(receiver.max); }
  const engine = scene.getEngine();
  const loops = [...engine.activeRenderLoops];
  const previousShadows = scene.shadowsEnabled;
  const originalReceivers = new Map(receivers.map(receiver => [receiver.surface.mesh, receiver.surface.mesh.receiveShadows]));
  const light = new DirectionalLight('__StaticGroundBakeSun', Vector3.Down(), scene);
  const azimuth = settings.sunAzimuthDegrees * Math.PI / 180, elevation = settings.sunElevationDegrees * Math.PI / 180;
  light.direction.set(-Math.sin(azimuth) * Math.cos(elevation), -Math.sin(elevation), -Math.cos(azimuth) * Math.cos(elevation));
  light.position.copyFrom(new Vector3((bounds[0] + bounds[2]) / 2, (min.y + max.y) / 2, (bounds[1] + bounds[3]) / 2).subtract(light.direction.scale(1000)));
  light.intensity = 0; light.autoCalcShadowZBounds = true; light.autoUpdateExtends = true;
  const generator = new ShadowGenerator(Math.min(2048, engine.getCaps().maxTextureSize), light);
  // 大面积共面地面需要最低偏移，避免旧场景的零偏移把整块地面误当作自阴影。
  generator.bias = Math.max(settings.bias, 0.0001); generator.normalBias = Math.max(settings.normalBias, 0.005);
  generator.darkness = settings.darkness; generator.usePercentageCloserFiltering = true;
  generator.filteringQuality = ShadowGenerator.QUALITY_HIGH;
  const meshes = receivers.map(receiver => receiver.surface.mesh);
  generator.getShadowMap()!.renderList = [...new Set(casters)];
  // 接收地面只扩大深度范围，不写入深度贴图；避免厂房大地面产生大量自阴影噪点。
  const lightView = Matrix.LookAtLH(light.position, light.position.add(light.direction), Vector3.Up());
  let minDepth = Infinity, maxDepth = -Infinity;
  const includeBounds = (minimum: Vector3, maximum: Vector3) => {
    for (const x of [minimum.x, maximum.x]) for (const y of [minimum.y, maximum.y]) for (const z of [minimum.z, maximum.z]) {
      const depth = Vector3.TransformCoordinates(new Vector3(x, y, z), lightView).z;
      minDepth = Math.min(minDepth, depth); maxDepth = Math.max(maxDepth, depth);
    }
  };
  for (const receiver of receivers) includeBounds(receiver.min, receiver.max);
  for (const caster of casters) {
    const box = caster.getBoundingInfo().boundingBox; includeBounds(box.minimumWorld, box.maximumWorld);
  }
  light.autoCalcShadowZBounds = false; light.shadowMinZ = minDepth - 2; light.shadowMaxZ = maxDepth + 2;
  // 深度图仅覆盖当前图块，远处模型仍可投射长阴影，但不会扩大 XY 范围稀释细节。
  light.customProjectionMatrixBuilder = (view, _renderList, result) => {
    const minimum = new Vector3(Infinity, Infinity, Infinity), maximum = new Vector3(-Infinity, -Infinity, -Infinity);
    for (const x of [bounds[0], bounds[2]]) for (const y of [min.y, max.y]) for (const z of [bounds[1], bounds[3]]) {
      const point = Vector3.TransformCoordinates(new Vector3(x, y, z), view);
      minimum.minimizeInPlace(point); maximum.maximizeInPlace(point);
    }
    const near = light.shadowMinZ!, far = light.shadowMaxZ!;
    Matrix.OrthoOffCenterLHToRef(minimum.x - 0.05, maximum.x + 0.05, minimum.y - 0.05, maximum.y + 0.05,
      engine.useReverseDepthBuffer ? far : near, engine.useReverseDepthBuffer ? near : far, result, engine.isNDCHalfZRange);
  };
  const material = new PBRMaterial('__StaticGroundMask', scene);
  material.unlit = true; material.disableLighting = true; material.backFaceCulling = false;
  material.depthFunction = Constants.LEQUAL;
  const target = new RenderTargetTexture('__StaticGroundMaskTarget', { width, height }, scene, false);
  target.renderList = meshes; target.clearColor = new Color4(1, 1, 1, 1);
  target.activeCamera = scene.activeCamera; target.ignoreCameraViewport = true;
  target.renderParticles = false; target.renderSprites = false;
  try {
    loops.forEach(loop => engine.stopRenderLoop(loop)); scene.shadowsEnabled = true;
    for (const mesh of meshes) mesh.receiveShadows = true;
    setEnvironmentShadowGenerator(scene, generator);
    new EnvironmentShadowMaterialPlugin(material);
    new UvBakeProjection(material, bounds, [min.y - 1, max.y + 1]);
    await generator.forceCompilationAsync();
    if (casters.some(mesh => mesh.hasThinInstances || mesh.isAnInstance)) await generator.forceCompilationAsync({ useInstances: true });
    await renderReadyTarget(generator.getShadowMap()!, signal);
    for (const mesh of meshes) { await material.forceCompilationAsync(mesh); cancelled(signal); }
    target.setMaterialForRendering(meshes, material); await renderReadyTarget(target, signal);
    const readback = await target.readPixels(); cancelled(signal);
    if (!readback) throw new Error('无法读取静态阴影遮罩，请检查显卡状态。');
    return new Uint8ClampedArray(new Uint8Array(readback.buffer));
  } finally {
    target.setMaterialForRendering(meshes, undefined); target.dispose(); material.dispose(false, false);
    generator.dispose(); light.dispose(); setEnvironmentShadowGenerator(scene, null);
    for (const [mesh, receive] of originalReceivers) if (!mesh.isDisposed()) mesh.receiveShadows = receive;
    scene.shadowsEnabled = previousShadows;
    if (!engine.isDisposed) loops.forEach(loop => engine.runRenderLoop(loop));
  }
}

/** 各楼层独立贴图；分块高精度计算仅发生在更新期间，运行时只采样静态 lightmap。 */
async function bakeGroundShadowMask(scene: Scene, receivers: GroundShadowReceiver[], casters: AbstractMesh[],
  settings: SceneShadowSettings, signature: string, signal?: AbortSignal,
  progress?: (message: string) => void): Promise<SceneShadowBakeSnapshot> {
  const engine = scene.getEngine();
  const azimuth = settings.sunAzimuthDegrees * Math.PI / 180, elevation = settings.sunElevationDegrees * Math.PI / 180;
  const direction = new Vector3(-Math.sin(azimuth) * Math.cos(elevation), -Math.sin(elevation), -Math.cos(azimuth) * Math.cos(elevation));
  const plans = partitionGroundShadowLayers(receivers)
    .map(layer => planGroundShadowLayer(layer, casters, direction, Math.min(8192, engine.getCaps().maxTextureSize)))
    .filter((plan): plan is NonNullable<typeof plan> => plan !== null);
  if (plans.reduce((sum, plan) => sum + plan.width * plan.height, 0) > SCENE_SHADOW_BAKE_MAX_PIXELS) {
    throw new Error('高精度阴影纹理超过 128M 像素显存预算，本次结果未保存。');
  }
  const surfaces: SceneShadowBakeSnapshot['surfaces'] = [];
  const loops = [...engine.activeRenderLoops];
  let hasShadow = false, dataLength = 0, completed = 0;
  const tileSize = 1024, padding = 4;
  const total = plans.reduce((sum, plan) => sum + Math.ceil(plan.width / tileSize) * Math.ceil(plan.height / tileSize), 0);
  try {
    loops.forEach(loop => engine.stopRenderLoop(loop));
    for (const plan of plans) {
      const { width, height, bounds } = plan;
      const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
      const context = canvas.getContext('2d'); if (!context) throw new Error('无法编码静态阴影遮罩。');
      context.fillStyle = '#ffffff'; context.fillRect(0, 0, width, height);
      const dx = (bounds[2] - bounds[0]) / width, dz = (bounds[3] - bounds[1]) / height;
      for (let y = 0; y < height; y += tileSize) for (let x = 0; x < width; x += tileSize) {
        cancelled(signal);
        const w = Math.min(tileSize, width - x), h = Math.min(tileSize, height - y);
        const tileBounds: ShadowBounds = [bounds[0] + (x - padding) * dx, bounds[1] + (y - padding) * dz,
          bounds[0] + (x + w + padding) * dx, bounds[1] + (y + h + padding) * dz];
        progress?.('正在高精度烘焙阴影：' + (++completed) + '/' + total + ' 个图块…');
        const pixels = await renderGroundShadowLayer(scene, plan.receivers, casters, settings, tileBounds, w + padding * 2, h + padding * 2, signal);
        // 相邻图块保留采样重叠，写入时只取内部，避免 PCF 在接缝处丢失遮挡。
        context.putImageData(new ImageData(pixels, w + padding * 2, h + padding * 2), x - padding, y - padding, padding, padding, w, h);
        hasShadow ||= pixels.some((value, offset) => offset % 4 === 0 && value < 245);
        await new Promise<void>(resolve => setTimeout(resolve, 0));
      }
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, width, 1); context.fillRect(0, height - 1, width, 1);
      context.fillRect(0, 0, 1, height); context.fillRect(width - 1, 0, 1, height);
      const dataUrl = canvas.toDataURL('image/png'); dataLength += dataUrl.length;
      if (dataLength > MAX_DATA_LENGTH) throw new Error('高精度阴影遮罩的场景数据超过 32 MiB 预算。');
      const firstKey = plan.receivers[0].surface.key;
      for (const [index, receiver] of plan.receivers.entries()) surfaces.push({ key: receiver.surface.key, kind: 'shadow-mask',
        dataUrl: index === 0 ? dataUrl : '', ...(index === 0 ? {} : { textureRef: firstKey }), width, height, uvBounds: bounds });
      canvas.width = 0; canvas.height = 0;
    }
    if (!hasShadow) throw new Error('没有检测到模型落在地面上的阴影，请检查模型位置和太阳方向。');
    return { version: 1, signature, createdAt: new Date().toISOString(), surfaces };
  } finally {
    if (!engine.isDisposed) loops.forEach(loop => engine.runRenderLoop(loop));
  }
}

export async function bakeEnvironmentShadows(scene: Scene, surfaces: ShadowBakeSurface[], casters: AbstractMesh[],
  settings: SceneShadowSettings, signature: string, signal?: AbortSignal,
  progress?: (message: string) => void): Promise<SceneShadowBakeSnapshot> {
  progress?.('正在筛选设备附近的阴影接收地面…');
  const environmentMeshes = new Set(surfaces.map(surface => surface.mesh));
  const devices = casters.filter(mesh => !environmentMeshes.has(mesh) && mesh.getTotalVertices() > 0);
  if (!devices.length) throw new Error('没有可参与烘焙的可见模型，未生成空白阴影。');
  for (const mesh of devices) if (mesh instanceof Mesh && mesh.hasThinInstances) mesh.thinInstanceRefreshBoundingInfo(true);
  const azimuth = settings.sunAzimuthDegrees * Math.PI / 180, elevation = settings.sunElevationDegrees * Math.PI / 180;
  const direction = new Vector3(-Math.sin(azimuth) * Math.cos(elevation), -Math.sin(elevation), -Math.cos(azimuth) * Math.cos(elevation));
  const ground = selectGroundShadowReceivers(surfaces, devices, direction);
  const selected = ground.length ? ground.map(receiver => receiver.surface) : surfaces;
  if (ground.length) {
    return bakeGroundShadowMask(scene, ground, devices, settings, signature, signal, progress);
  }

  progress?.('正在合成静态阴影…');
  return bakeUvEnvironmentShadows(scene, selected, [...devices, ...selected.map(surface => surface.mesh)], settings, signature, signal);
}

export function createBakedEnvironmentMaterial(source: BakeMaterial, texture: Texture): BakeMaterial {
  const material = cloneEnvironmentMaterial(source, `${source.name}-static-shadow`)! as BakeMaterial;
  material.unfreeze(); material.disableLighting = true;
  material.detailMap.isEnabled = false;
  material.emissiveTexture = null; material.opacityTexture = null; material.ambientTexture = null; material.lightmapTexture = null;
  material.emissiveColor = Color3.Black();
  if (material instanceof PBRMaterial) {
    material.unlit = true; material.albedoColor = Color3.White(); material.albedoTexture = texture;
    material.directIntensity = 1; material.emissiveIntensity = 1;
  } else {
    material.diffuseColor = Color3.White(); material.diffuseTexture = texture; material.emissiveColor = Color3.White();
    material.reflectionTexture = null; material.refractionTexture = null;
    material.useEmissiveAsIllumination = false; material.linkEmissiveWithDiffuse = false;
  }
  return material;
}
