import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test, { type TestContext } from 'node:test';
import { validateSceneLightingBakeSnapshot, type SceneLightingBakeSnapshot } from '../../electron/shared/sceneLightingBakeContract.ts';

type TextureState = { created: number; disposed: number; activeDecodes: number; maxDecodes: number; delay: number; syncFailure?: boolean; failDecodeAt?: number };
const key = Symbol.for('lighting-texture-load-fixture');
const globals = globalThis as unknown as Record<symbol, unknown>;
const stub = 'data:text/javascript,' + encodeURIComponent([
  "const key = Symbol.for('lighting-texture-load-fixture');",
  'export class Texture {',
  ' static BILINEAR_SAMPLINGMODE = 2; static CLAMP_ADDRESSMODE = 0;',
  ' constructor(...args) {',
  '  this.onDisposeObservable = { addOnce: callback => { this.onDispose = callback; } };',
  '  const state = globalThis[key]; this.state = state; this.scene = args[1]; this.scene.textures.push(this);',
  '  this.invertY = args[3]; this.noMipmap = args[2]; const index = state.created++;',
  "  if (state.syncFailure) { args[6]('同步解码失败'); return; }",
  '  state.activeDecodes++; state.maxDecodes = Math.max(state.maxDecodes, state.activeDecodes);',
  "  setTimeout(() => { state.activeDecodes--; if (state.failDecodeAt === index) args[6]('异步解码失败'); else args[5](); }, state.delay);",
  ' }',
  ' dispose() { if (this.disposed) throw new Error("纹理重复释放"); this.disposed = true; this.state.disposed++; this.onDispose?.(); const index = this.scene.textures.indexOf(this); if (index >= 0) this.scene.textures.splice(index, 1); }',
  '}',
].join('\n'));
const project = new URL('../../', import.meta.url);
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier === '@babylonjs/core/Materials/Textures/texture.js') return { url: stub, shortCircuit: true };
  if (specifier.startsWith('.') && context.parentURL?.startsWith(project.href) && !specifier.endsWith('.ts')) {
    const candidate = new URL(specifier.endsWith('.js') ? specifier.slice(0, -3) + '.ts' : specifier + '.ts', context.parentURL);
    if (existsSync(candidate)) return { url: candidate.href, shortCircuit: true };
  }
  return next(specifier, context);
} });
const { loadLightingResources } = await import('../../src/runtime/babylon/lightingRuntimeResources.ts');
test.after(() => hooks.deregister());

function fixture(mapCount = 8) {
  const png = new Uint8Array(33); png.set([137, 80, 78, 71, 13, 10, 26, 10]); png.set([73, 72, 68, 82], 12);
  const view = new DataView(png.buffer); view.setUint32(16, 1); view.setUint32(20, 1);
  const encoder = new TextEncoder();
  const content = new Map<string, Uint8Array>(Array.from({ length: mapCount }, (_, i) => ['map-' + i, png]));
  content.set('geometry', encoder.encode(JSON.stringify({ version: 1, positions: [0,0,0,1,0,0,0,1,0], normals: [0,0,1,0,0,1,0,0,1], uvs: [0,0,1,0,0,1], bakeUvs: [0,0,1,0,0,1], indices: [0,1,2] })));
  content.set('probes', encoder.encode(JSON.stringify({ version: 1, encoding: 'ambient-cube', spacing: 1, probes: [{ position: [0,0,0], irradiance: Array(18).fill(0.5) }] })));
  const snapshot: SceneLightingBakeSnapshot = {
    version: 1, signature: 'load-fixture', createdAt: '2026-10-24T00:00:00Z', engineVersion: 'fixture',
    assets: [...content].map(([id, bytes]) => ({ id, kind: id.startsWith('map-') ? 'lightmap' : id === 'geometry' ? 'geometry' : 'probes', url: 'memory://' + id, byteLength: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex'), ...(id.startsWith('map-') ? { rgbmRange: 1 } : {}) })),
    surfaces: [{ key: 'fixed/root', entityId: 'fixed', nodeKey: 'root', geometryAssetId: 'geometry', lightmapAssetId: 'map-0' }],
    probeAssetId: 'probes', statistics: { meshCount: 1, triangleCount: 1, atlasCount: mapCount, probeCount: 1, textureBytes: mapCount * 4, durationMs: 0 },
  };
  assert.ok(validateSceneLightingBakeSnapshot(snapshot));
  return { snapshot, content };
}

function setup(t: TestContext, config: Partial<TextureState> = {}) {
  const state: TextureState = { created: 0, disposed: 0, activeDecodes: 0, maxDecodes: 0, delay: 5, ...config };
  const previous = globals[key]; globals[key] = state;
  t.after(() => { if (previous === undefined) delete globals[key]; else globals[key] = previous; });
  const urls: string[] = [], revoked: string[] = [];
  t.mock.method(URL, 'createObjectURL', () => { const url = 'blob:fixture-' + urls.length; urls.push(url); return url; });
  t.mock.method(URL, 'revokeObjectURL', (url: string) => { revoked.push(url); });
  const scene = { textures: [] as Array<{ invertY: boolean; noMipmap: boolean; gammaSpace: boolean; hasAlpha: boolean; wrapU: number; wrapV: number }> };
  return { state, scene, urls, revoked };
}
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test('GI 默认有界并行最多四项，全部成功后原子返回并保留纹理采样语义', async t => {
  const { snapshot, content } = fixture(); const { state, scene, urls, revoked } = setup(t);
  let activeReads = 0, maxReads = 0;
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    activeReads++; maxReads = Math.max(maxReads, activeReads); await pause(10); activeReads--;
    return new Response(content.get(url.slice('memory://'.length))!);
  });
  const result = await loadLightingResources(snapshot, scene as never);
  assert.equal(maxReads, 4); assert.ok(state.maxDecodes <= 4); assert.equal(state.created, 8);
  assert.equal(result.textures.size, 8); assert.deepEqual([...result.textures.keys()], snapshot.assets.filter(asset => asset.kind === 'lightmap').map(asset => asset.id)); assert.equal(result.geometries.size, 1); assert.deepEqual(result.probes.sample([0,0,0]), Array(18).fill(0.5));
  for (const texture of scene.textures) assert.deepEqual([texture.invertY, texture.noMipmap, texture.gammaSpace, texture.hasAlpha, texture.wrapU, texture.wrapV], [true, true, false, false, 0, 0]);
  assert.deepEqual([...urls].sort(), [...revoked].sort()); result.dispose();
  assert.equal(scene.textures.length, 0); assert.equal(state.disposed, 8);
});

test('GI 内部串行开关保留 A/B 基线并给出可复现受控延迟对照', async t => {
  const { snapshot, content } = fixture(); const { scene } = setup(t); const samples = [];
  for (const concurrency of [1, 4] as const) {
    let active = 0, maximum = 0;
    t.mock.method(globalThis, 'fetch', async (url: string) => { active++; maximum = Math.max(maximum, active); await pause(20); active--; return new Response(content.get(url.slice('memory://'.length))!); });
    const started = performance.now();
    const result = await loadLightingResources(snapshot, scene as never, undefined, { concurrency });
    samples.push({ concurrency, durationMs: Number((performance.now() - started).toFixed(2)), maxConcurrentReads: maximum });
    assert.equal(maximum, concurrency); result.dispose();
  }
  t.diagnostic('受控读取每资源 20 ms、模拟解码每图集 5 ms：' + JSON.stringify(samples));
});

test('并发读取失败停止派发，等待忽略取消的同批读取结束后才拒绝', async t => {
  const { snapshot, content } = fixture(); const { state, scene } = setup(t);
  let active = 0, started = 0, finished = 0;
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    active++; started++; await pause(url.endsWith('map-0') ? 5 : 30); active--; finished++;
    if (url.endsWith('map-0')) throw new Error('读取失败');
    return new Response(content.get(url.slice('memory://'.length))!);
  });
  await assert.rejects(loadLightingResources(snapshot, scene as never), error => {
    const failure = error as Error & { diagnostic?: { assetId?: string } };
    assert.match(failure.message, /读取失败/); assert.equal(failure.diagnostic?.assetId, 'map-0'); return true;
  });
  assert.equal(started, 4); assert.equal(finished, 4); assert.equal(active, 0); assert.equal(state.created, 0); assert.equal(scene.textures.length, 0);
});

test('并发 SHA 校验失败保留资源身份，并释放同批已完成候选', async t => {
  const { snapshot, content } = fixture(); const { state, scene, urls, revoked } = setup(t);
  snapshot.assets[3].sha256 = '0'.repeat(64);
  t.mock.method(globalThis, 'fetch', async (url: string) => { if (url.endsWith('map-3')) await pause(20); return new Response(content.get(url.slice('memory://'.length))!); });
  await assert.rejects(loadLightingResources(snapshot, scene as never), error => {
    const failure = error as Error & { diagnostic?: { assetId?: string } }; assert.match(failure.message, /校验失败/); assert.equal(failure.diagnostic?.assetId, 'map-3'); return true;
  });
  assert.ok(state.created >= 3); assert.equal(state.created, state.disposed); assert.equal(scene.textures.length, 0); assert.equal(urls.length, revoked.length);
});

for (const syncFailure of [true, false]) test((syncFailure ? '同步' : '异步') + '纹理解码失败释放全部候选和 URL，保留失败资源', async t => {
  const { snapshot, content } = fixture(); const { state, scene, urls, revoked } = setup(t, { syncFailure, failDecodeAt: 0 });
  t.mock.method(globalThis, 'fetch', async (url: string) => new Response(content.get(url.slice('memory://'.length))!));
  await assert.rejects(loadLightingResources(snapshot, scene as never), error => {
    const failure = error as Error & { diagnostic?: { assetId?: string } }; assert.match(failure.message, /解码失败/); assert.equal(failure.diagnostic?.assetId, 'map-0'); return true;
  });
  assert.equal(state.created, state.disposed); assert.equal(scene.textures.length, 0); assert.equal(urls.length, revoked.length);
  await pause(10); assert.equal(scene.textures.length, 0);
});

for (const phase of ['读取', '解码']) test('外部在' + phase + '期间取消后等待队列收束，保留原 reason 并释放资源', async t => {
  const { snapshot, content } = fixture(); const { state, scene, urls, revoked } = setup(t, { delay: phase === '解码' ? 30 : 5 });
  const controller = new AbortController(), reason = new Error('用户取消'); let active = 0;
  t.mock.method(globalThis, 'fetch', async (url: string) => { active++; if (phase === '读取') await pause(25); active--; return new Response(content.get(url.slice('memory://'.length))!); });
  const pending = loadLightingResources(snapshot, scene as never, controller.signal);
  await pause(5); controller.abort(reason); await assert.rejects(pending, error => error === reason);
  assert.equal(active, 0); assert.equal(state.created, state.disposed); assert.equal(scene.textures.length, 0); assert.equal(urls.length, revoked.length);
  await pause(35); assert.equal(scene.textures.length, 0);
});

function installBitmapFixture(t: TestContext, delay = 0, fail = false) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'createImageBitmap');
  const state = { created: 0, closed: 0, options: [] as ImageBitmapOptions[], pending: 0 };
  Object.defineProperty(globalThis, 'createImageBitmap', { configurable: true, writable: true, value: async (_blob: Blob, options: ImageBitmapOptions) => {
    state.pending++; await pause(delay); state.pending--;
    if (fail) throw new Error('Bitmap 解码失败');
    state.created++; state.options.push(options); let closed = false;
    return { close() { assert.equal(closed, false); closed = true; state.closed++; } };
  } });
  t.after(() => { if (descriptor) Object.defineProperty(globalThis, 'createImageBitmap', descriptor); else Reflect.deleteProperty(globalThis, 'createImageBitmap'); });
  return state;
}

test('Bitmap 显式保持 RGBM 编码、上传不重复翻转，成功后随 Texture 释放', async t => {
  const { snapshot, content } = fixture(); const { state, scene } = setup(t); const bitmaps = installBitmapFixture(t);
  t.mock.method(globalThis, 'fetch', async (url: string) => new Response(content.get(url.slice('memory://'.length))!));
  const result = await loadLightingResources(snapshot, scene as never);
  assert.equal(bitmaps.created, 8); assert.equal(bitmaps.closed, 0);
  for (const options of bitmaps.options) assert.deepEqual(options, { imageOrientation: 'flipY', premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  assert.ok(scene.textures.every(texture => texture.invertY === false));
  result.dispose(); assert.equal(state.disposed, 8); assert.equal(bitmaps.closed, 8);
});

test('内部 image 对照路径不调用 Bitmap', async t => {
  const { snapshot, content } = fixture(); const { scene } = setup(t); const bitmaps = installBitmapFixture(t);
  t.mock.method(globalThis, 'fetch', async (url: string) => new Response(content.get(url.slice('memory://'.length))!));
  const result = await loadLightingResources(snapshot, scene as never, undefined, { textureDecoder: 'image' });
  assert.equal(bitmaps.created, 0); assert.ok(scene.textures.every(texture => texture.invertY === true)); result.dispose();
});

test('Bitmap 解码中取消必须等待解码结束并 close 全部位图后拒绝', async t => {
  const { snapshot, content } = fixture(); const { scene } = setup(t); const bitmaps = installBitmapFixture(t, 30);
  const controller = new AbortController(), reason = new Error('取消 Bitmap');
  t.mock.method(globalThis, 'fetch', async (url: string) => new Response(content.get(url.slice('memory://'.length))!));
  const pending = loadLightingResources(snapshot, scene as never, controller.signal); await pause(5); controller.abort(reason);
  await assert.rejects(pending, error => error === reason);
  assert.equal(bitmaps.created, 4); assert.equal(bitmaps.pending, 0); assert.equal(bitmaps.closed, 4); assert.equal(scene.textures.length, 0);
});

test('Bitmap 解码失败保留资源诊断并等待同批解码收束', async t => {
  const { snapshot, content } = fixture(); const { scene } = setup(t); const bitmaps = installBitmapFixture(t, 5, true);
  t.mock.method(globalThis, 'fetch', async (url: string) => new Response(content.get(url.slice('memory://'.length))!));
  await assert.rejects(loadLightingResources(snapshot, scene as never), error => {
    const failure = error as Error & { diagnostic?: { assetId?: string } }; assert.match(failure.message, /Bitmap 解码失败/); assert.ok(failure.diagnostic?.assetId?.startsWith('map-')); return true;
  });
  assert.equal(bitmaps.pending, 0); assert.equal(scene.textures.length, 0);
});


test('Bitmap 已解码后创建 URL 失败也必须 close 全部同批位图', async t => {
  const { snapshot, content } = fixture(); const { state, scene } = setup(t); const bitmaps = installBitmapFixture(t);
  t.mock.method(globalThis, 'fetch', async (url: string) => new Response(content.get(url.slice('memory://'.length))!));
  t.mock.method(URL, 'createObjectURL', () => { throw new Error('URL 分配失败'); });
  await assert.rejects(loadLightingResources(snapshot, scene as never), /URL 分配失败/);
  assert.equal(bitmaps.pending, 0); assert.equal(bitmaps.created, 4); assert.equal(bitmaps.closed, 4); assert.equal(state.created, 0); assert.equal(scene.textures.length, 0);
});
