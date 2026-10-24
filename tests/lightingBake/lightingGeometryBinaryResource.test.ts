import { binaryFixture } from './lightingGeometryBinaryFixture.ts';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import type { SceneLightingBakeSnapshot } from '../../electron/shared/sceneLightingBakeData.ts';

const state = { textures: [] as unknown[], created: 0, disposed: 0 };
const key = Symbol.for('b6-geometry-version');
(globalThis as unknown as Record<symbol, unknown>)[key] = state;
const stub = 'data:text/javascript,' + encodeURIComponent(`export class Texture {
 static BILINEAR_SAMPLINGMODE=2; static CLAMP_ADDRESSMODE=0;
 constructor(...args) { this.scene=args[1]; this.scene.textures.push(this); this.onDisposeObservable={addOnce:()=>{}};
 globalThis[Symbol.for('b6-geometry-version')].created++; queueMicrotask(()=>args[5]()); }
 dispose() { const state=globalThis[Symbol.for('b6-geometry-version')]; state.disposed++;
 const i=this.scene.textures.indexOf(this); if(i>=0)this.scene.textures.splice(i,1); }
}`);
const project = new URL('../../', import.meta.url);
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier === '@babylonjs/core/Materials/Textures/texture.js') return { url: stub, shortCircuit: true };
  if (specifier.startsWith('.') && context.parentURL?.startsWith(project.href) && !specifier.endsWith('.ts')) {
    const file = new URL(specifier.endsWith('.js') ? specifier.slice(0, -3) + '.ts' : specifier + '.ts', context.parentURL);
    if (existsSync(file)) return next(file.href, context);
  }
  return next(specifier, context);
} });
const { loadLightingResources } = await import('../../src/runtime/babylon/lightingRuntimeResources.ts');
test.after(() => { hooks.deregister(); delete (globalThis as unknown as Record<symbol, unknown>)[key]; });

function fixture(version: 1 | 2, declared?: 1 | 2) {
  const geometry = { version, positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
    indices: [0, 1, 2], uvs: [0, 0, 1, 0, 0, 1], bakeUvs: [0, 0, 1, 0, 0, 1] };
  const png = new Uint8Array(33); png.set([137, 80, 78, 71, 13, 10, 26, 10]); png.set([73, 72, 68, 82], 12);
  const view = new DataView(png.buffer); view.setUint32(16, 1); view.setUint32(20, 1);
  const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
  const bytes = new Map([['l', png], ['g', encode(geometry)], ['p', encode({ version: 1, encoding: 'ambient-cube', spacing: 1,
    probes: [{ position: [0, 0, 0], irradiance: Array(18).fill(0.5) }] })]]);
  const snapshot: SceneLightingBakeSnapshot = { version: 1, signature: 'b6', createdAt: '2026-10-24T00:00:00Z', engineVersion: 'fixture',
    assets: [...bytes].map(([id, data]) => ({ id, kind: id === 'g' ? 'geometry' : id === 'l' ? 'lightmap' : 'probes', url: 'memory://' + id,
      byteLength: data.byteLength, sha256: createHash('sha256').update(data).digest('hex'), ...(id === 'g' && declared ? { geometryVersion: declared } : {}) })),
    surfaces: [{ key: 'a/root', entityId: 'a', nodeKey: 'root', geometryAssetId: 'g', lightmapAssetId: 'l' }], probeAssetId: 'p',
    statistics: { meshCount: 1, triangleCount: 1, atlasCount: 1, probeCount: 1, textureBytes: 4, durationMs: 0 } };
  return { snapshot, bytes };
}

test('混合格式JSON/binary真实decoder与四worker加载，旧JSON兼容且错误候选全部释放', async t => {
  for (const [actual, declared] of [[1, undefined], [1, 1], [2, 2], [2, undefined], [1, 2], [2, 1]] as const) {
    const { snapshot, bytes } = fixture(actual, declared);
    if (actual === 2) { const data = binaryFixture(); bytes.set('g', data); const asset = snapshot.assets.find(a => a.id === 'g')!; asset.encoding = 'binary-v1'; asset.byteLength = data.length; asset.sha256 = createHash('sha256').update(data).digest('hex'); }
    t.mock.method(globalThis, 'fetch', async (url: string) => new Response(bytes.get(url.slice(9))!));
    const before = state.created, disposed = state.disposed;
    if (declared !== undefined && declared !== actual) {
      await assert.rejects(loadLightingResources(snapshot, state as never, undefined, { concurrency: 4, textureDecoder: 'image' }), /版本/);
    } else {
      const resources = await loadLightingResources(snapshot, state as never, undefined, { concurrency: 4, textureDecoder: 'image' });
      assert.equal(resources.geometries.get('g')?.version, actual);
      assert.equal(resources.geometries.get('g')?.positions instanceof Float32Array, actual === 2); resources.dispose();
    }
    assert.equal(state.created - before, 1); assert.equal(state.disposed - disposed, 1); assert.equal(state.textures.length, 0);
    t.mock.restoreAll();
  }
});

test('SHA 校验先于版本判断，损坏文件仍按真实资源身份报错', async t => {
  const { snapshot, bytes } = fixture(1, 2);
  snapshot.assets.find(asset => asset.id === 'g')!.sha256 = '0'.repeat(64);
  t.mock.method(globalThis, 'fetch', async (url: string) => new Response(bytes.get(url.slice(9))!));
  await assert.rejects(loadLightingResources(snapshot, state as never, undefined, { concurrency: 4, textureDecoder: 'image' }), /校验失败/);
  assert.equal(state.textures.length, 0);
});

test('同一快照同时加载v1 JSON/v2 JSON/binary-v1，不跨资源混淆版本与编码', async t => {
  const { snapshot, bytes } = fixture(1, 1);
  const original = JSON.parse(new TextDecoder().decode(bytes.get('g')));
  for (const [id, data, encoding] of [['g2', new TextEncoder().encode(JSON.stringify({ ...original, version: 2 })), 'json'],
    ['g3', binaryFixture(), 'binary-v1']] as const) {
    bytes.set(id, data);
    snapshot.assets.push({ id, kind: 'geometry', geometryVersion: 2, encoding, url: 'memory://' + id, byteLength: data.length,
      sha256: createHash('sha256').update(data).digest('hex') });
    snapshot.surfaces.push({ key: 'a/' + id, entityId: 'a', nodeKey: id, geometryAssetId: id, lightmapAssetId: 'l' });
  }
  snapshot.statistics.meshCount = 3; snapshot.statistics.triangleCount = 3;
  t.mock.method(globalThis, 'fetch', async (url: string) => new Response(bytes.get(url.slice(9))!));
  const resources = await loadLightingResources(snapshot, state as never, undefined, { concurrency: 4, textureDecoder: 'image' });
  assert.deepEqual([...resources.geometries.keys()], ['g', 'g2', 'g3']);
  assert.deepEqual([...resources.geometries.values()].map(geometry => geometry.version), [1, 2, 2]);
  assert.ok(Array.isArray(resources.geometries.get('g')!.positions)); assert.ok(Array.isArray(resources.geometries.get('g2')!.positions));
  assert.ok(resources.geometries.get('g3')!.positions instanceof Float32Array);
  resources.dispose(); assert.equal(state.textures.length, 0);
});

 test('binary SHA/length优先于decode；声明binary但合法JSON不回退，失败仍归还纹理', async t => {
  for (const failure of ['sha', 'length', 'encoding']) {
    const { snapshot, bytes } = fixture(2, 2), asset = snapshot.assets.find(a => a.id === 'g')!;
    asset.encoding = 'binary-v1';
    if (failure !== 'encoding') bytes.set('g', new Uint8Array([1, 2, 3]));
    asset.byteLength = bytes.get('g')!.length + (failure === 'length' ? 1 : 0);
    asset.sha256 = failure === 'sha' ? '0'.repeat(64) : createHash('sha256').update(bytes.get('g')!).digest('hex');
    t.mock.method(globalThis, 'fetch', async (url: string) => new Response(bytes.get(url.slice(9))!));
    await assert.rejects(loadLightingResources(snapshot, state as never, undefined, { concurrency: 4, textureDecoder: 'image' }), failure === 'sha' ? /校验失败/ : failure === 'length' ? /长度/ : /二进制/);
    assert.equal(state.textures.length, 0); t.mock.restoreAll();
  }
});
