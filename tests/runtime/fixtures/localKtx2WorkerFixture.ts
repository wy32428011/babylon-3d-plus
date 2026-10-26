import { Engine, Scene, FreeCamera, Vector3, MeshBuilder, ShaderMaterial, Texture } from '@babylonjs/core';
import * as decoder from '@babylonjs/ktx2decoder';
import { KhronosTextureContainer2 } from '@babylonjs/core/Misc/khronosTextureContainer2.js';
import { configureLocalBabylonDecoders } from '/src/runtime/babylon/localDecoderConfiguration.ts';
import { registerKtx2WorkerEngine, getLocalKtx2DecodeDiagnostics } from '/src/runtime/babylon/ktx2WorkerDecoder.ts';
import { installPublishedViewerCache } from '/src/player/publishedBabylonCache.ts';
import { parsePlayerRuntimeConfig } from '/src/player/runtimeConfig.ts';

const query = new URLSearchParams(location.search);
const mode = query.get('mode'), parallel = query.get('parallel') === '1';
let bootAttempts = 0;
if (mode === 'main') Object.defineProperty(globalThis, 'Worker', { configurable: true, value: undefined });
if (mode === 'boot-failure') {
  const NativeWorker = Worker;
  Object.defineProperty(globalThis, 'Worker', { configurable: true, value: class extends NativeWorker {
    constructor(url: string | URL, options?: WorkerOptions) {
      if (String(url).includes('ktx2Decode.worker')) { bootAttempts++; throw new Error('owned fixture: KTX2 worker boot blocked'); }
      super(url, options);
    }
  } });
}
const check = (condition: unknown, message: string) => { if (!condition) throw Error(message); };
const decodes: unknown[] = [];
async function record(result: Awaited<ReturnType<decoder.KTX2Decoder['decode']>>) {
  const hashes = [];
  for (const mip of result.mipmaps) {
    const bytes = mip.data!;
    hashes.push({ width: mip.width, height: mip.height, bytes: bytes.byteLength,
      sha256: Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map(b => b.toString(16).padStart(2, '0')).join('') });
  }
  decodes.push({ width: result.width, height: result.height, format: result.transcodedFormat, gamma: result.isInGammaSpace,
    alpha: result.hasAlpha, transcoder: result.transcoderName, mips: hashes });
  return result;
}
// 当前Viewer配置合同拒绝file URL；file轮只核对实际解码/GPU/CSP，缓存合同由HTTP轮验证。
const isFile = location.protocol === 'file:';
const config = isFile ? null : parsePlayerRuntimeConfig(await (await fetch('./runtime-config.json', { cache: 'no-store' })).json());
const cache = config ? await installPublishedViewerCache(config, new URL('./', location.href).href) : null;
check(isFile || cache, '真实Viewer cache安装失败');
if (isFile) configureLocalBabylonDecoders();
if (cache) {
  const original = cache.cache.decode;
  cache.cache.decode = function(key, source, create, validate, byteLength) {
    return original.call(this, key, source, async () => {
      const result = await create(); await record(result as Awaited<ReturnType<decoder.KTX2Decoder['decode']>>); return result;
    }, validate, byteLength);
  };
}
const canvas = document.querySelector('canvas')!;
const engine = new Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true });
engine.setHardwareScalingLevel(1); registerKtx2WorkerEngine(engine);
const bridgeDecode = decoder.KTX2Decoder.prototype.decode;
const scene = new Scene(engine); cache?.attach(scene);
scene.clearColor.set(.04, .07, .1, 1);
const camera = new FreeCamera('fixed', new Vector3(0, 0, -5), scene); camera.setTarget(Vector3.Zero());
const plane = MeshBuilder.CreatePlane('sample', { width: 4, height: 3 }, scene);
const material = new ShaderMaterial('sample', scene, {
  vertexSource: 'precision highp float; attribute vec3 position; attribute vec2 uv; uniform mat4 worldViewProjection; varying vec2 texUV; void main(){texUV=uv;gl_Position=worldViewProjection*vec4(position,1.0);}',
  fragmentSource: 'precision highp float; varying vec2 texUV; uniform sampler2D sampleTex; uniform float forceOpaque; void main(){gl_FragColor=texture2D(sampleTex,texUV);gl_FragColor.a=mix(gl_FragColor.a,1.0,forceOpaque);}',
}, { attributes: ['position', 'uv'], uniforms: ['worldViewProjection', 'forceOpaque'], samplers: ['sampleTex'], needAlphaBlending: true });
material.setFloat('forceOpaque', 0);
plane.material = material;
const longTaskEntries: Array<{ startTime: number; duration: number }> = [];
const loadWindows: Array<{ name: string; start: number; end: number }> = [];
const supportsLongTasks = typeof PerformanceObserver === 'function' && PerformanceObserver.supportedEntryTypes.includes('longtask');
const longTaskObserver = supportsLongTasks ? new PerformanceObserver(list => {
  for (const entry of list.getEntries()) longTaskEntries.push({ startTime: entry.startTime, duration: entry.duration });
}) : null;
longTaskObserver?.observe({ type: 'longtask' });
async function load(name: string, supplied?: Texture) {
  const started = performance.now();
  const texture = supplied ?? await new Promise<Texture>((resolve, reject) => {
    const value = new Texture(new URL('./project/assets/' + name, location.href).href, scene, false, false,
      Texture.NEAREST_SAMPLINGMODE, () => resolve(value), (message, error) => reject(error ?? new Error(message)));
  });
  loadWindows.push({ name, start: started, end: performance.now() });
  check(texture.isReady(), '实际GPU纹理未就绪');
  material.setTexture('sampleTex', texture); await material.forceCompilationAsync(plane); await scene.whenReadyAsync();
  for (let i = 0; i < 4; i++) scene.render();
  const raw = await engine.readPixels(0, 0, canvas.width, canvas.height);
  const bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  let binary = ''; for (const b of bytes) binary += String.fromCharCode(b);
  const colors = new Set<string>(); for (let i = 0; i < bytes.length; i += 4) colors.add(bytes[i] + ',' + bytes[i+1] + ',' + bytes[i+2]);
  const png = canvas.toDataURL('image/png');
  let alphaControlChangedComponents: number | null = null;
  if (name.startsWith('alpha_')) {
    material.setFloat('forceOpaque', 1); scene.render(); scene.render();
    const opaque = await engine.readPixels(0, 0, canvas.width, canvas.height), control = new Uint8Array(opaque.buffer, opaque.byteOffset, opaque.byteLength);
    alphaControlChangedComponents = 0;
    for (let i = 0; i < bytes.length; i++) if (bytes[i] !== control[i]) alphaControlChangedComponents++;
    check(alphaControlChangedComponents > 1000, 'alpha纹理没有产生有效透明度差异');
    material.setFloat('forceOpaque', 0); scene.render();
  }
  return { name, rgba: btoa(binary), png, colors: colors.size, size: texture.getSize(), alphaControlChangedComponents,
    samplingValid: colors.size >= (name.startsWith('color_grid') ? 32 : 2),
    ready: material.isReady(plane), uniforms: material.getEffect()?.getSamplers(), textureReady: texture.isReady() };
}
try {
  const captures = [];
  const names = ['color_grid_blze.ktx2', 'color_grid_uastc_zstd_5.ktx2', 'alpha_simple_blze.ktx2'];
  if (parallel) {
    // 并发请求与逐张采样分开，避免共享采样材质竞争；这一分支只做语义/真实worker数量验证。
    const textures = await Promise.all(names.map(name => new Promise<Texture>((resolve, reject) => {
      const value = new Texture(new URL('./project/assets/' + name, location.href).href, scene, false, false,
        Texture.NEAREST_SAMPLINGMODE, () => resolve(value), (message, error) => reject(error ?? new Error(message)));
    })));
    for (let i = 0; i < names.length; i++) captures.push(await load(names[i], textures[i]));
  } else for (const name of names) captures.push(await load(name));
  await new Promise(resolve => setTimeout(resolve, 100));
  for (const entry of longTaskObserver?.takeRecords() ?? []) longTaskEntries.push({ startTime: entry.startTime, duration: entry.duration });
  const timing = { supported: supportsLongTasks, windows: loadWindows.map(window => ({ ...window, readyMs: window.end - window.start,
    longTaskClippedMs: supportsLongTasks ? longTaskEntries.reduce((sum, entry) => sum + Math.max(0, Math.min(window.end, entry.startTime + entry.duration) - Math.max(window.start, entry.startTime)), 0) : null })),
    entries: longTaskEntries, definition: '每个Texture请求到GPU-ready回调的墙钟区间；longtask按该区间交集裁切；不含后续shader/截图/显式options边界检查，不是独占decodeCPU或整场景首帧。' };
  const textureCacheMetrics = cache ? { ...cache.cache.metrics } : null;
  const textureDecodes = [...decodes];
  const beforeBoundary = getLocalKtx2DecodeDiagnostics();
  const instance = await (KhronosTextureContainer2 as unknown as { _DecoderModulePromise: Promise<decoder.KTX2Decoder> })._DecoderModulePromise;
  const input = new Uint8Array(await (await fetch('./project/assets/color_grid_blze.ktx2')).arrayBuffer());
  let getterReads = 0;
  const options = { get forceRGBA() { getterReads++; return false; } };
  await bridgeDecode.call(instance, input, engine.getCaps(), options);
  // HTTP先JSON.stringify一次；只有本次cache miss执行原decoder时才再spread一次。
  const explicitMisses = cache ? cache.cache.metrics.decodes - textureCacheMetrics!.decodes : 0;
  const expectedReads = cache ? 1 + explicitMisses : 1;
  check(getterReads === expectedReads, '未知显式选项getter次数改变：' + getterReads + '/' + expectedReads);
  const afterBoundary = getLocalKtx2DecodeDiagnostics();
  check(afterBoundary.submitted === beforeBoundary.submitted, '未知显式选项进入worker');
  Object.assign(window, { ld1Result: { renderer: engine.getGlInfo(), decodes: textureDecodes, captures, cache: textureCacheMetrics,
    diagnostics: afterBoundary, timing, parallel, timingEligible: !parallel, bootAttempts, explicitOptionsGetterReads: getterReads, installationOrder: 'cache(configure internally) -> engine/register -> Texture; file: configure -> engine', errors: [] },
    ld1Dispose() { longTaskObserver?.disconnect(); cache?.dispose(); scene.dispose(); engine.dispose(); } });
} catch (error) {
  Object.assign(window, { ld1Result: { error: error instanceof Error ? error.stack : String(error) } });
}
