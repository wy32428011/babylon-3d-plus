import type { AbstractEngine } from '@babylonjs/core/Engines/abstractEngine.js';

export const GPU_CAPABILITY_PROFILE_ALGORITHM = 'webgl2-fixed-fragment-v1';
export const GPU_CAPABILITY_PROFILE_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SCHEMA = 'babylon.gpu-capability-profile';
const SIZE = 256, DRAWS = 8, WARMUP = 3, FRAMES = 12, TOTAL_BUDGET_MS = 1500, FRAME_BUDGET_MS = 150;
export type GpuCapabilityTier = 'T0' | 'T1' | 'T2';
export type GpuCapabilityCaps = { maxTextureSize: number; maxTexturesImageUnits: number };
export type GpuCapabilityDriver = { renderer: string; vendor: string; version: string; webGLVersion: number; caps: GpuCapabilityCaps };
export type GpuCapabilityMeasurement = {
  unit: 'ms-cpu-submit-and-sync'; samplesMs: readonly number[]; medianMs: number; p95Ms: number; meanMs: number;
  warmupFrames: number; measuredFrames: number; drawsPerFrame: number; width: number; height: number; elapsedMs: number;
};
export type GpuCapabilityProvenance = { unmasked: true; renderer: string; vendor: string; version: string; hostMatched: true };
export type GpuCapabilityProfile = {
  schema: typeof SCHEMA; version: 1; algorithmVersion: typeof GPU_CAPABILITY_PROFILE_ALGORITHM;
  status: 'measured' | 'unavailable'; tier: GpuCapabilityTier | null; source: 'probe' | 'cache' | 'unavailable';
  createdAt: number; expiresAt: number | null; fingerprint: string | null; driver: GpuCapabilityDriver | null;
  measurement: GpuCapabilityMeasurement | null; provenance: GpuCapabilityProvenance | null; reason: string | null;
  calibration: 'heuristic-not-cross-device-calibrated';
  backend?: 'webgl' | 'webgpu';
};
type StorageAccess = Pick<Storage, 'getItem' | 'setItem'>;
/** 仅用于聚焦回归的环境seam；正式调用只需engine/signal，不替换host渲染或画质。 */
export type GpuCapabilityEnvironment = {
  createCanvas?: () => Pick<HTMLCanvasElement, 'width' | 'height' | 'getContext'> | null;
  storage?: StorageAccess | null; now?: () => number; timestamp?: () => number; yieldFrame?: (signal?: AbortSignal) => Promise<void>;
};
const profiles = new WeakMap<AbstractEngine, GpuCapabilityProfile>();
type PendingProfile = { promise: Promise<GpuCapabilityProfile>; signal?: AbortSignal };
const pending = new WeakMap<AbstractEngine, PendingProfile>();
const engineLifetimes = new WeakMap<AbstractEngine, { epoch: number; disposed: boolean; needsProbe: boolean; remove: () => void }>();
function engineLifetime(engine: AbstractEngine) {
  const previous = engineLifetimes.get(engine); if (previous) return previous;
  const state = { epoch: 0, disposed: false, needsProbe: false, remove: () => {} }; engineLifetimes.set(engine, state);
  const restored = engine.onContextRestoredObservable, disposed = engine.onDisposeObservable;
  const restoreObserver = restored?.add(() => { state.epoch++; state.needsProbe = true; profiles.delete(engine); });
  const disposeObserver = disposed?.addOnce(() => { state.disposed = true; state.epoch++; profiles.delete(engine); state.remove(); });
  state.remove = () => { if (restoreObserver) restored.remove(restoreObserver); if (disposeObserver) disposed.remove(disposeObserver); };
  return state;
}

function statistics(samples: readonly number[]) {
  const sorted = [...samples].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return { medianMs: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
    p95Ms: sorted[Math.ceil(sorted.length * .95) - 1], meanMs: samples.reduce((sum, value) => sum + value, 0) / samples.length };
}
/** 阈值仅作增强效果建议，未经多显卡校准；集成与未知设备始终保守，不改变任何原画质设置。 */
export function resolveGpuCapabilityTier(renderer: string, caps: GpuCapabilityCaps, samples: readonly number[]): GpuCapabilityTier {
  if (!samples.length || samples.some(value => !Number.isFinite(value) || value < 0)
    || !Object.values(caps).every(value => Number.isSafeInteger(value) && value > 0)) return 'T0';
  const knownDiscrete = /NVIDIA.*(?:GeForce|Quadro|RTX|Tesla)|(?:AMD|ATI).*Radeon.*(?:RX\s*\d|PRO\b)/i.test(renderer);
  if (!knownDiscrete || caps.maxTextureSize < 16384 || caps.maxTexturesImageUnits < 16) return 'T0';
  const { medianMs, p95Ms } = statistics(samples);
  if (caps.maxTextureSize >= 16384 && caps.maxTexturesImageUnits >= 32 && medianMs <= 4 && p95Ms <= 8) return 'T2';
  return medianMs <= 12 && p95Ms <= 20 ? 'T1' : 'T0';
}

function readDriver(engine: AbstractEngine): GpuCapabilityDriver {
  if (engine.isDisposed) throw new Error('host engine已释放。');
  if (engine.isWebGPU) throw new Error('WebGPU 不使用独立 WebGL2 探针。');
  const getInfo: unknown = Reflect.get(engine, 'getGlInfo');
  const info: unknown = typeof getInfo === 'function' ? getInfo.call(engine) : null;
  const webGLVersion: unknown = Reflect.get(engine, 'webGLVersion');
  if (!info || typeof info !== 'object' || webGLVersion !== 2) throw new Error('host缺少有效WebGL2 renderer/caps。');
  const renderer: unknown = Reflect.get(info, 'renderer'), vendor: unknown = Reflect.get(info, 'vendor'), version: unknown = Reflect.get(info, 'version');
  if (typeof renderer !== 'string' || typeof vendor !== 'string' || typeof version !== 'string') throw new Error('host缺少有效WebGL2 renderer/caps。');
  const caps = engine.getCaps();
  const driver = { renderer, vendor, version, webGLVersion,
    caps: { maxTextureSize: caps.maxTextureSize, maxTexturesImageUnits: caps.maxTexturesImageUnits } };
  if (![driver.renderer, driver.vendor, driver.version].every(value => typeof value === 'string' && value.trim().length > 0)
    || !Object.values(driver.caps).every(value => Number.isSafeInteger(value) && value > 0) || driver.webGLVersion !== 2) {
    throw new Error('host缺少有效WebGL2 renderer/caps。');
  }
  return driver;
}
function fingerprint(driver: GpuCapabilityDriver): string { return JSON.stringify([GPU_CAPABILITY_PROFILE_ALGORITHM, driver]); }
function cacheKey(value: string): string {
  // 短key只定位条目；命中仍比较完整driver/caps指纹，不把此散列当安全校验或资源SHA。
  let hash = 2166136261; for (const character of value) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return 'babylon.gpu-profile.v1.' + (hash >>> 0).toString(16);
}
function storageFor(environment: GpuCapabilityEnvironment): StorageAccess | null {
  if (environment.storage !== undefined) return environment.storage;
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}
function freeze(profile: GpuCapabilityProfile): GpuCapabilityProfile {
  if (profile.driver) { Object.freeze(profile.driver.caps); Object.freeze(profile.driver); }
  if (profile.measurement) { Object.freeze(profile.measurement.samplesMs); Object.freeze(profile.measurement); }
  if (profile.provenance) Object.freeze(profile.provenance);
  return Object.freeze(profile);
}
function measured(driver: GpuCapabilityDriver, measurement: GpuCapabilityMeasurement, provenance: GpuCapabilityProvenance,
  createdAt: number, source: 'probe' | 'cache'): GpuCapabilityProfile {
  return freeze({ schema: SCHEMA, version: 1, algorithmVersion: GPU_CAPABILITY_PROFILE_ALGORITHM, status: 'measured',
    source, tier: resolveGpuCapabilityTier(driver.renderer, driver.caps, measurement.samplesMs), createdAt,
    expiresAt: createdAt + GPU_CAPABILITY_PROFILE_CACHE_TTL_MS, fingerprint: fingerprint(driver), driver, measurement, provenance,
    reason: null, calibration: 'heuristic-not-cross-device-calibrated' });
}
function unavailable(reason: string, driver: GpuCapabilityDriver | null, timestamp: number, backend: 'webgl' | 'webgpu' = 'webgl'): GpuCapabilityProfile {
  return freeze({ schema: SCHEMA, version: 1, algorithmVersion: GPU_CAPABILITY_PROFILE_ALGORITHM, status: 'unavailable', tier: null,
    source: 'unavailable', createdAt: timestamp, expiresAt: null, fingerprint: driver ? fingerprint(driver) : null,
    driver, measurement: null, provenance: null, reason, backend, calibration: 'heuristic-not-cross-device-calibrated' });
}
function readCache(storage: StorageAccess | null, driver: GpuCapabilityDriver, timestamp: number): GpuCapabilityProfile | null {
  try {
    const text = storage?.getItem(cacheKey(fingerprint(driver))); if (!text || text.length > 16_384) return null;
    const value = JSON.parse(text);
    if (value?.schema !== SCHEMA || value.version !== 1 || value.algorithmVersion !== GPU_CAPABILITY_PROFILE_ALGORITHM
      || value.status !== 'measured' || value.fingerprint !== fingerprint(driver)
      || !Number.isFinite(value.createdAt) || value.createdAt > timestamp + 300_000 || timestamp - value.createdAt >= GPU_CAPABILITY_PROFILE_CACHE_TTL_MS
      || value.expiresAt !== value.createdAt + GPU_CAPABILITY_PROFILE_CACHE_TTL_MS) return null;
    const provenance = value.provenance;
    if (provenance?.unmasked !== true || provenance.hostMatched !== true || provenance.renderer !== driver.renderer
      || provenance.vendor !== driver.vendor || provenance.version !== driver.version) return null;
    const sample = value.measurement;
    if (!sample || sample.unit !== 'ms-cpu-submit-and-sync' || !Array.isArray(sample.samplesMs) || sample.samplesMs.length !== FRAMES
      || sample.samplesMs.some((entry: unknown) => typeof entry !== 'number' || !Number.isFinite(entry) || entry < 0 || entry > FRAME_BUDGET_MS)
      || sample.warmupFrames !== WARMUP || sample.measuredFrames !== FRAMES || sample.drawsPerFrame !== DRAWS || sample.width !== SIZE || sample.height !== SIZE
      || !Number.isFinite(sample.elapsedMs) || sample.elapsedMs < sample.samplesMs.reduce((sum: number, value: number) => sum + value, 0) - 0.000001 || sample.elapsedMs > TOTAL_BUDGET_MS) return null;
    const recomputed = statistics(sample.samplesMs);
    if (Object.entries(recomputed).some(([key, number]) => number !== sample[key])
      || value.tier !== resolveGpuCapabilityTier(driver.renderer, driver.caps, sample.samplesMs)) return null;
    return measured(driver, { unit: 'ms-cpu-submit-and-sync', samplesMs: [...sample.samplesMs], ...recomputed,
      warmupFrames: WARMUP, measuredFrames: FRAMES, drawsPerFrame: DRAWS, width: SIZE, height: SIZE, elapsedMs: sample.elapsedMs },
    { unmasked: true, hostMatched: true, renderer: driver.renderer, vendor: driver.vendor, version: driver.version }, value.createdAt, 'cache');
  } catch { return null; }
}
function yieldFrame(signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener('abort', abort);
    const timeout = setTimeout(() => { cleanup(); resolve(); }, 0);
    const abort = () => { clearTimeout(timeout); cleanup(); reject(signal?.reason); };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}
function waitForOwner(promise: Promise<GpuCapabilityProfile>, signal?: AbortSignal): Promise<GpuCapabilityProfile> {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    promise.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
    if (signal.aborted) abort();
  });
}
const VERTEX = '#version 300 es\nvoid main(){vec2 p=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2));gl_Position=vec4(p*2.0-1.0,0.0,1.0);}';
const FRAGMENT = '#version 300 es\nprecision highp float;uniform float uSeed;out vec4 color;void main(){vec3 v=vec3(gl_FragCoord.xy/256.0,uSeed*0.001);for(int i=0;i<16;i++){v=fract(v*vec3(1.31,1.17,1.73)+v.yzx*0.19+uSeed*0.0001);}color=vec4(v,1.0);}';
async function probe(driver: GpuCapabilityDriver, signal: AbortSignal | undefined, environment: GpuCapabilityEnvironment, assertCurrent: () => void) {
  const now = environment.now ?? (() => performance.now()), started = now();
  const canvas = environment.createCanvas ? environment.createCanvas() : typeof document === 'undefined' ? null : document.createElement('canvas');
  if (!canvas) throw new Error('当前环境没有可用DOM/canvas。');
  canvas.width = SIZE; canvas.height = SIZE;
  let gl: WebGL2RenderingContext | null = null;
  const cleanupErrors: unknown[] = []; let failure: unknown, failed = false;
  let result: { provenance: GpuCapabilityProvenance; measurement: GpuCapabilityMeasurement } | undefined;
  const shaders: WebGLShader[] = []; let program: WebGLProgram | null = null, texture: WebGLTexture | null = null, framebuffer: WebGLFramebuffer | null = null;
  try {
    signal?.throwIfAborted();
    gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false,
      powerPreference: 'high-performance', failIfMajorPerformanceCaveat: true }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error('独立离屏WebGL2 context不可用。');
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    if (!debug) throw new Error('离屏context缺少unmasked renderer provenance。');
    const provenance: GpuCapabilityProvenance = { unmasked: true, hostMatched: true,
      renderer: String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)), vendor: String(gl.getParameter(debug.UNMASKED_VENDOR_WEBGL)), version: String(gl.getParameter(gl.VERSION)) };
    if (provenance.renderer !== driver.renderer || provenance.vendor !== driver.vendor || provenance.version !== driver.version) throw new Error('独立context与host renderer/driver不匹配。');
    if (/swiftshader|llvmpipe|software|microsoft basic render/i.test(driver.renderer)) throw new Error('软件renderer不作为本机GPU实测。');
    for (const [type, code] of [[gl.VERTEX_SHADER, VERTEX], [gl.FRAGMENT_SHADER, FRAGMENT]] as const) {
      const shader = gl.createShader(type); if (!shader) throw new Error('无法创建诊断shader。'); shaders.push(shader);
      gl.shaderSource(shader, code); gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error('诊断shader编译失败。');
    }
    program = gl.createProgram(); if (!program) throw new Error('无法创建诊断program。');
    shaders.forEach(shader => gl!.attachShader(program!, shader)); gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('诊断program链接失败。');
    texture = gl.createTexture(); framebuffer = gl.createFramebuffer(); if (!texture || !framebuffer) throw new Error('无法创建诊断离屏目标。');
    gl.bindTexture(gl.TEXTURE_2D, texture); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, SIZE, SIZE, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('诊断离屏目标不完整。');
    gl.viewport(0, 0, SIZE, SIZE); gl.useProgram(program); const seed = gl.getUniformLocation(program, 'uSeed');
    const samplesMs: number[] = [];
    for (let frame = 0; frame < WARMUP + FRAMES; frame++) {
      signal?.throwIfAborted(); assertCurrent(); if (now() - started > TOTAL_BUDGET_MS) throw new Error('离屏诊断超出总预算。');
      const frameStart = now();
      for (let draw = 0; draw < DRAWS; draw++) { gl.uniform1f(seed, frame * DRAWS + draw); gl.drawArrays(gl.TRIANGLES, 0, 3); }
      gl.finish(); const elapsed = now() - frameStart;
      signal?.throwIfAborted();
      if (gl.isContextLost() || gl.getError() !== gl.NO_ERROR) throw new Error('离屏诊断context丢失或draw失败。');
      if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed > FRAME_BUDGET_MS || now() - started > TOTAL_BUDGET_MS) throw new Error('离屏诊断超出单帧或总预算。');
      if (frame >= WARMUP) samplesMs.push(elapsed);
      await (environment.yieldFrame ?? yieldFrame)(signal); assertCurrent();
    }
    signal?.throwIfAborted(); const elapsedMs = now() - started;
    if (elapsedMs > TOTAL_BUDGET_MS) throw new Error('离屏诊断超出总预算。');
    result = { provenance, measurement: { unit: 'ms-cpu-submit-and-sync' as const, samplesMs, ...statistics(samplesMs),
      warmupFrames: WARMUP, measuredFrames: FRAMES, drawsPerFrame: DRAWS, width: SIZE, height: SIZE, elapsedMs } };
  } catch (error) { failed = true; failure = error; } finally {
    // 只有本函数新建的独立context；绝不lose host或修改其render loop/画质/材质状态。
    const cleanup = (release: () => void) => { try { release(); } catch (error) { cleanupErrors.push(error); } };
    if (gl) {
      if (framebuffer) cleanup(() => gl!.deleteFramebuffer(framebuffer));
      if (texture) cleanup(() => gl!.deleteTexture(texture));
      if (program) cleanup(() => gl!.deleteProgram(program));
      shaders.forEach(shader => cleanup(() => gl!.deleteShader(shader)));
      cleanup(() => gl!.getExtension('WEBGL_lose_context')?.loseContext());
    }
    canvas.width = 0; canvas.height = 0;
  }
  if (cleanupErrors.length) throw new AggregateError(failed ? [failure, ...cleanupErrors] : cleanupErrors, '独立诊断context清理失败。');
  if (failed) throw failure;
  return result!;
}

/** 只返回已准备结果；getter不读取storage、不创建DOM/context、不触发分类或probe。 */
export function getGpuCapabilityProfile(engine: AbstractEngine): GpuCapabilityProfile | null { return profiles.get(engine) ?? null; }

/** 在准备遮罩中显式await；非取消失败仅返回unavailable，不阻断正常3D，也不改变任何画质默认值。 */
export async function prepareGpuCapabilityProfile(engine: AbstractEngine, signal?: AbortSignal, environment: GpuCapabilityEnvironment = {}): Promise<GpuCapabilityProfile> {
  signal?.throwIfAborted();
  const timestamp = environment.timestamp ?? Date.now;
  let driver: GpuCapabilityDriver | null = null, checkedAt = 0;
  let lifetime: ReturnType<typeof engineLifetime>;
  try {
    checkedAt = timestamp(); if (!Number.isFinite(checkedAt) || checkedAt < 0) throw new Error('本机诊断时钟不可用。');
    if (engine.isWebGPU) {
      engineLifetime(engine);
      const profile = unavailable(engine.isDisposed ? 'host engine已释放。' : 'WebGPU 不使用独立 WebGL2 探针；当前能力分级不可用。', null, checkedAt, 'webgpu');
      profiles.set(engine, profile);
      return profile;
    }
    driver = readDriver(engine); lifetime = engineLifetime(engine);
    if (lifetime.disposed) throw new Error('host engine已释放。');
  } catch (error) {
    signal?.throwIfAborted();
    const profile = unavailable(error instanceof Error ? error.message : String(error), driver, checkedAt); profiles.set(engine, profile); return profile;
  }
  // 内存命中同样需要重新验证driver/caps/TTL；纯getter则保持无副作用。
  const existing = profiles.get(engine);
  if (existing?.status === 'measured' && existing.fingerprint === fingerprint(driver) && existing.createdAt <= checkedAt + 300_000
    && existing.expiresAt !== null && checkedAt < existing.expiresAt) return existing;
  profiles.delete(engine);
  const owner = pending.get(engine);
  if (owner) {
    try { return await waitForOwner(owner.promise, signal); }
    catch (error) {
      signal?.throwIfAborted();
      if (!owner.signal?.aborted) throw error;
      // 旧场景owner取消只结束旧probe。其finally已清理后，新场景以自己的signal重开，不能继承旧reason。
      if (pending.get(engine) === owner) pending.delete(engine);
      return prepareGpuCapabilityProfile(engine, signal, environment);
    }
  }
  const epoch = lifetime.epoch;
  const assertCurrent = () => { if (lifetime.disposed || lifetime.epoch !== epoch) throw new Error('host context已换代，本次诊断无效。'); };
  const activeDriver = driver;
  const work = (async () => {
    try {
      const storage = storageFor(environment), cached = lifetime.needsProbe ? null : readCache(storage, activeDriver, checkedAt);
      if (cached) { signal?.throwIfAborted(); assertCurrent(); profiles.set(engine, cached); return cached; }
      const result = await probe(activeDriver, signal, environment, assertCurrent);
      assertCurrent();
      if (fingerprint(readDriver(engine)) !== fingerprint(activeDriver)) throw new Error('host driver/caps在检测期间变化，本次诊断无效。');
      const createdAt = timestamp(); if (!Number.isFinite(createdAt) || createdAt < 0) throw new Error('本机诊断时钟不可用。');
      const profile = measured(activeDriver, result.measurement, result.provenance, createdAt, 'probe');
      signal?.throwIfAborted();
      try { storage?.setItem(cacheKey(profile.fingerprint!), JSON.stringify(profile)); } catch { /* storage拒绝不影响已完成诊断。 */ }
      lifetime.needsProbe = false; profiles.set(engine, profile); return profile;
    } catch (error) {
      signal?.throwIfAborted();
      const profile = unavailable(error instanceof Error ? error.message : String(error), activeDriver, checkedAt);
      if (!lifetime.disposed) profiles.set(engine, profile); return profile;
    }
  })();
  const entry = { promise: work, signal }; pending.set(engine, entry);
  try { return await work; } finally { if (pending.get(engine) === entry) pending.delete(engine); }
}
