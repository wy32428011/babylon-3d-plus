import assert from 'node:assert/strict';
import test from 'node:test';
import { Observable } from '@babylonjs/core/Misc/observable.js';
import type { Engine } from '@babylonjs/core/Engines/engine.js';
import { GPU_CAPABILITY_PROFILE_CACHE_TTL_MS, getGpuCapabilityProfile, prepareGpuCapabilityProfile, resolveGpuCapabilityTier } from '../../src/runtime/babylon/gpuCapabilityProfile.ts';

const intel = 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11)';
const discrete = 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Direct3D11)';
const caps = { maxTextureSize: 16384, maxTexturesImageUnits: 32 };
function storage() {
  const entries = new Map<string, string>();
  return { entries, getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => { entries.set(key, value); } };
}
function harness(options: { renderer?: string; probeRenderer?: string; sampleMs?: number; failCompile?: boolean; noCanvas?: boolean; missingProvenance?: boolean; throwStorage?: boolean } = {}) {
  const data = storage(), clock = { value: 0 }, counts = { canvas: 0, draw: 0, finish: 0, delete: 0, contextLost: 0, yield: 0 };
  const host = { onContextRestoredObservable: new Observable<Engine>(), onDisposeObservable: new Observable<Engine>(), webGLVersion: 2, getGlInfo: () => ({ vendor: 'Google Inc.', renderer: options.renderer ?? intel, version: 'WebGL 2.0' }), getCaps: () => ({ ...caps }) } as unknown as Engine;
  let resourceId = 0;
  const debug = { UNMASKED_RENDERER_WEBGL: 10001, UNMASKED_VENDOR_WEBGL: 10002 };
  const gl: Record<string, unknown> = { VERTEX_SHADER: 1, FRAGMENT_SHADER: 2, COMPILE_STATUS: 3, LINK_STATUS: 4, FRAMEBUFFER: 5, FRAMEBUFFER_COMPLETE: 6,
    TEXTURE_2D: 7, RGBA: 8, RGBA8: 9, UNSIGNED_BYTE: 10, TEXTURE_MIN_FILTER: 11, TEXTURE_MAG_FILTER: 12, NEAREST: 13,
    COLOR_ATTACHMENT0: 14, TRIANGLES: 15, COLOR_BUFFER_BIT: 16, VERSION: 17, RENDERER: 18, VENDOR: 19, NO_ERROR: 0,
    createShader: () => ({ id: ++resourceId }), createProgram: () => ({ id: ++resourceId }), createFramebuffer: () => ({ id: ++resourceId }), createTexture: () => ({ id: ++resourceId }),
    shaderSource() {}, compileShader() {}, attachShader() {}, linkProgram() {}, bindFramebuffer() {}, bindTexture() {}, texImage2D() {}, texParameteri() {}, framebufferTexture2D() {},
    viewport() {}, clearColor() {}, clear() {}, useProgram() {}, getUniformLocation: () => ({}), uniform1f() {}, drawArrays() { counts.draw++; },
    getShaderParameter: () => !options.failCompile, getProgramParameter: () => true, getShaderInfoLog: () => 'compile failed', getProgramInfoLog: () => '',
    checkFramebufferStatus: () => 6, isContextLost: () => false, getError: () => 0,
    getParameter: (key: number) => key === debug.UNMASKED_RENDERER_WEBGL ? options.probeRenderer ?? options.renderer ?? intel : key === debug.UNMASKED_VENDOR_WEBGL ? 'Google Inc.' : 'WebGL 2.0',
    getExtension: (name: string) => name === 'WEBGL_debug_renderer_info' ? options.missingProvenance ? null : debug
      : name === 'WEBGL_lose_context' ? { loseContext() { counts.contextLost++; } } : null,
    finish() { counts.finish++; clock.value += options.sampleMs ?? 2; },
    deleteShader() { counts.delete++; }, deleteProgram() { counts.delete++; }, deleteFramebuffer() { counts.delete++; }, deleteTexture() { counts.delete++; },
  };
  const canvas = { width: 0, height: 0, getContext: (kind: string) => { assert.equal(kind, 'webgl2'); return gl; } };
  const env = { now: () => clock.value, timestamp: () => 1_790_000_000_000,
    storage: options.throwStorage ? { getItem() { throw new Error('storage denied'); }, setItem() { throw new Error('storage denied'); } } : data,
    createCanvas: () => { counts.canvas++; return options.noCanvas ? null : canvas as unknown as HTMLCanvasElement; },
    yieldFrame: async () => { counts.yield++; },
  };
  return { host, env, data, counts, canvas, clock, gl };
}
const samples = (ms: number) => Array.from({ length: 12 }, () => ms);

test('集成/未知保守T0；独显T1/T2仅按未校准建议阈值，不自动改画质', () => {
  assert.equal(resolveGpuCapabilityTier(intel, caps, samples(.1)), 'T0');
  assert.equal(resolveGpuCapabilityTier('privacy-redacted', caps, samples(.1)), 'T0');
  assert.equal(resolveGpuCapabilityTier(discrete, caps, samples(2)), 'T2');
  assert.equal(resolveGpuCapabilityTier(discrete, caps, samples(7)), 'T1');
  assert.equal(resolveGpuCapabilityTier(discrete, caps, samples(25)), 'T0');
  assert.equal(resolveGpuCapabilityTier(discrete, { maxTextureSize: 4096, maxTexturesImageUnits: 8 }, samples(1)), 'T0');
  assert.equal(resolveGpuCapabilityTier(discrete, { maxTextureSize: 8192, maxTexturesImageUnits: 32 }, samples(1)), 'T0', '方案0.4明确T1 texture>=16384');
  assert.equal(resolveGpuCapabilityTier(discrete, { maxTextureSize: 16383, maxTexturesImageUnits: 32 }, samples(1)), 'T0');
  assert.equal(resolveGpuCapabilityTier(discrete, { maxTextureSize: 16384, maxTexturesImageUnits: 16 }, samples(7)), 'T1');
  assert.equal(resolveGpuCapabilityTier(discrete, { maxTextureSize: NaN, maxTexturesImageUnits: 32 }, samples(1)), 'T0');
});

test('只读getter不读caps/storage、不创建DOM/probe；冷调用15帧与资源释放齐全', async () => {
  const f = harness(); assert.equal(getGpuCapabilityProfile(f.host), null); assert.equal(f.counts.canvas, 0);
  const profile = await prepareGpuCapabilityProfile(f.host, undefined, f.env);
  assert.equal(profile.status, 'measured'); assert.equal(profile.tier, 'T0'); assert.equal(profile.source, 'probe');
  assert.equal(profile.measurement?.samplesMs.length, 12); assert.equal(profile.measurement?.medianMs, 2); assert.equal(profile.measurement?.p95Ms, 2);
  assert.equal(f.counts.finish, 15); assert.equal(f.counts.yield, 15); assert.ok(f.counts.draw > 0);
  assert.equal(f.counts.delete, 5); assert.equal(f.counts.contextLost, 1);
  assert.equal(f.canvas.width, 0); assert.equal(f.canvas.height, 0); assert.equal(getGpuCapabilityProfile(f.host), profile);
  assert.equal((await prepareGpuCapabilityProfile(f.host, undefined, f.env)), profile); assert.equal(f.counts.canvas, 1);
});

test('匹配driver/caps/版本的热缓存不创建context，并重算样本统计', async () => {
  const first = harness(), measured = await prepareGpuCapabilityProfile(first.host, undefined, first.env);
  const second = harness(); second.env.storage = first.data;
  const profile = await prepareGpuCapabilityProfile(second.host, undefined, second.env);
  assert.equal(profile.status, 'measured'); assert.equal(profile.source, 'cache'); assert.equal(second.counts.canvas, 0);
  assert.deepEqual(profile.measurement, measured.measurement); assert.equal(profile.tier, measured.tier);
});

test('坏JSON/过期/未来时间/driver变化/caps变化/缓存篡改tier或统计均不信任', async () => {
  const seed = harness(); await prepareGpuCapabilityProfile(seed.host, undefined, seed.env);
  const [key, json] = [...seed.data.entries][0];
  for (const mutate of [
    () => '{bad-json',
    (value: Record<string, unknown>) => ({ ...value, createdAt: 1_790_000_000_000 - GPU_CAPABILITY_PROFILE_CACHE_TTL_MS - 1 }),
    (value: Record<string, unknown>) => ({ ...value, createdAt: 1_790_000_000_000 + 600_000 }),
    (value: Record<string, unknown>) => ({ ...value, tier: 'T2' }),
    (value: Record<string, unknown>) => ({ ...value, measurement: { ...(value.measurement as object), medianMs: 123 } }),
    (value: Record<string, unknown>) => ({ ...value, measurement: { ...(value.measurement as object), elapsedMs: 0 } }),
    (value: Record<string, unknown>) => ({ ...value, algorithmVersion: 'obsolete' }),
    (value: Record<string, unknown>) => ({ ...value, fingerprint: 'other-driver' }),
  ]) {
    const f = harness(), changed = mutate(JSON.parse(json)); f.data.entries.set(key, typeof changed === 'string' ? changed : JSON.stringify(changed));
    assert.equal((await prepareGpuCapabilityProfile(f.host, undefined, f.env)).source, 'probe'); assert.equal(f.counts.canvas, 1);
  }
  const changedDriver = harness({ renderer: discrete }); changedDriver.env.storage = seed.data;
  assert.equal((await prepareGpuCapabilityProfile(changedDriver.host, undefined, changedDriver.env)).source, 'probe');
  const changedCaps = harness(); changedCaps.env.storage = seed.data;
  changedCaps.host.getCaps = () => ({ ...caps, maxTextureSize: 8192 }) as ReturnType<Engine['getCaps']>;
  assert.equal((await prepareGpuCapabilityProfile(changedCaps.host, undefined, changedCaps.env)).source, 'probe');
});

test('storage拒绝仍可测量；无DOM/编译失败/缺provenance/renderer不匹配不给measured或T0实测', async () => {
  const blocked = harness({ throwStorage: true }); assert.equal((await prepareGpuCapabilityProfile(blocked.host, undefined, blocked.env)).status, 'measured');
  for (const config of [{ noCanvas: true }, { failCompile: true }, { missingProvenance: true }, { probeRenderer: 'other-gpu' }]) {
    const f = harness(config), profile = await prepareGpuCapabilityProfile(f.host, undefined, f.env);
    assert.equal(profile.status, 'unavailable'); assert.equal(profile.tier, null); assert.equal(profile.measurement, null);
    assert.equal(f.data.entries.size, 0); if (!config.noCanvas) assert.equal(f.counts.contextLost, 1);
  }
});

test('取消抛原reason，释放自有context/resources且不缓存；取消后可在明确prepare重试', async () => {
  const f = harness(), controller = new AbortController(), sentinel = new Error('scene-cancelled');
  f.env.yieldFrame = async () => { controller.abort(sentinel); };
  await assert.rejects(prepareGpuCapabilityProfile(f.host, controller.signal, f.env), error => error === sentinel);
  assert.equal(getGpuCapabilityProfile(f.host), null); assert.equal(f.counts.contextLost, 1); assert.equal(f.counts.delete, 5); assert.equal(f.data.entries.size, 0);
  f.env.yieldFrame = async () => {};
  assert.equal((await prepareGpuCapabilityProfile(f.host, undefined, f.env)).status, 'measured');
});

test('每帧/总预算超限安全unavailable；并发非owner取消不制造第二context或取消owner', async () => {
  const slow = harness({ sampleMs: 200 }); assert.equal((await prepareGpuCapabilityProfile(slow.host, undefined, slow.env)).status, 'unavailable');
  assert.ok(slow.counts.finish <= 2); assert.equal(slow.counts.contextLost, 1);
  const f = harness(); let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  f.env.yieldFrame = async () => { await gate; };
  const owner = prepareGpuCapabilityProfile(f.host, undefined, f.env), waiterAbort = new AbortController();
  const waiter = prepareGpuCapabilityProfile(f.host, waiterAbort.signal, f.env); const reason = new Error('only-waiter'); waiterAbort.abort(reason);
  await assert.rejects(waiter, error => error === reason); release(); assert.equal((await owner).status, 'measured'); assert.equal(f.counts.canvas, 1);
});

test('预先取消不触发probe；清理一项抛错仍排空其它自有资源并保持host不变', async () => {
  const before = harness(), controller = new AbortController(), reason = new Error('already-aborted'); controller.abort(reason);
  await assert.rejects(prepareGpuCapabilityProfile(before.host, controller.signal, before.env), error => error === reason);
  assert.equal(before.counts.canvas, 0); assert.equal(getGpuCapabilityProfile(before.host), null);
  const f = harness(); Object.freeze(f.host);
  f.gl.deleteTexture = () => { f.counts.delete++; throw new Error('driver-delete-failed'); };
  const profile = await prepareGpuCapabilityProfile(f.host, undefined, f.env);
  assert.equal(profile.status, 'unavailable'); assert.equal(profile.tier, null);
  assert.equal(f.counts.delete, 5); assert.equal(f.counts.contextLost, 1); assert.equal(f.canvas.width, 0); assert.equal(f.canvas.height, 0);
  assert.equal(Object.isFrozen(f.host), true);
});

test('同Engine内存命中也验证TTL/driver/caps，不复用过期或已换设备结果', async () => {
  const f = harness(), first = await prepareGpuCapabilityProfile(f.host, undefined, f.env);
  f.env.timestamp = () => first.createdAt + GPU_CAPABILITY_PROFILE_CACHE_TTL_MS + 1;
  const expired = await prepareGpuCapabilityProfile(f.host, undefined, f.env);
  assert.notEqual(expired.createdAt, first.createdAt); assert.equal(f.counts.canvas, 2);
  f.host.getGlInfo = () => ({ renderer: 'new-driver', vendor: 'Google Inc.', version: 'WebGL 2.0' });
  const changed = await prepareGpuCapabilityProfile(f.host, undefined, f.env);
  assert.equal(changed.status, 'unavailable', '新driver与旧probe不匹配时不得保留旧measured');
  assert.equal(changed.tier, null); assert.equal(f.counts.canvas, 3);
});

test('旧owner取消不能取消未取消的新scene waiter，先清理旧probe后重新诊断', async () => {
  const f = harness(), controller = new AbortController(), reason = new Error('old-scene-aborted');
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); let firstYield = true;
  f.env.yieldFrame = async () => { if (firstYield) { firstYield = false; await gate; } };
  const owner = prepareGpuCapabilityProfile(f.host, controller.signal, f.env);
  const waiter = prepareGpuCapabilityProfile(f.host, undefined, f.env);
  controller.abort(reason); release();
  await assert.rejects(owner, error => error === reason);
  assert.equal((await waiter).status, 'measured', '新场景自己的signal未取消，不能沿用旧owner reason');
  assert.equal(f.counts.canvas, 2); assert.equal(f.counts.contextLost, 2); assert.equal(f.counts.delete, 10);
});

test('context restore立即使旧结果失效，dispose只清理模块自己的observer', async () => {
  const f = harness(); let foreign = 0;
  const other = f.host.onContextRestoredObservable.add(() => { foreign++; });
  assert.equal(f.host.onContextRestoredObservable.observers.length, 1);
  await prepareGpuCapabilityProfile(f.host, undefined, f.env);
  assert.equal(f.host.onContextRestoredObservable.observers.length, 2);
  f.host.onContextRestoredObservable.notifyObservers(f.host);
  assert.equal(foreign, 1); assert.equal(getGpuCapabilityProfile(f.host), null);
  await prepareGpuCapabilityProfile(f.host, undefined, f.env);
  assert.equal(f.counts.canvas, 2, 'context restore必须重probe，不复用旧localStorage测量');
  assert.equal(f.host.onContextRestoredObservable.observers.length, 2, '多次prepare不叠加生命周期observer');
  f.host.onDisposeObservable.notifyObservers(f.host);
  assert.equal(getGpuCapabilityProfile(f.host), null);
  assert.equal(other?._willBeUnregistered, false, '不能移除外部observer');
  assert.equal(f.host.onContextRestoredObservable.observers.filter(observer => !observer._willBeUnregistered).length, 1);
});

test('probe中context换代不能提交旧measured；自己的资源先收束再明确重试', async () => {
  const f = harness(); let changed = false;
  f.env.yieldFrame = async () => { if (!changed) { changed = true; f.host.onContextRestoredObservable.notifyObservers(f.host); } };
  const invalid = await prepareGpuCapabilityProfile(f.host, undefined, f.env);
  assert.equal(invalid.status, 'unavailable'); assert.equal(invalid.tier, null); assert.equal(f.counts.contextLost, 1); assert.equal(f.data.entries.size, 0);
  f.env.yieldFrame = async () => {};
  assert.equal((await prepareGpuCapabilityProfile(f.host, undefined, f.env)).status, 'measured'); assert.equal(f.counts.canvas, 2);
});
