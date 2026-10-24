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

test('v1/v2 内容与显式清单一致才加载；旧无字段不变，失败释放已完成候选', async t => {
  for (const [actual, declared] of [[1, undefined], [1, 1], [2, 2], [2, undefined], [1, 2], [2, 1]] as const) {
    const { snapshot, bytes } = fixture(actual, declared);
    t.mock.method(globalThis, 'fetch', async (url: string) => new Response(bytes.get(url.slice(9))!));
    const before = state.created, disposed = state.disposed;
    if (declared !== undefined && declared !== actual) {
      await assert.rejects(loadLightingResources(snapshot, state as never, undefined, { concurrency: 1, textureDecoder: 'image' }), /版本/);
    } else {
      const resources = await loadLightingResources(snapshot, state as never, undefined, { concurrency: 1, textureDecoder: 'image' });
      assert.equal(resources.geometries.get('g')?.version, actual); resources.dispose();
    }
    assert.equal(state.created - before, 1); assert.equal(state.disposed - disposed, 1); assert.equal(state.textures.length, 0);
    t.mock.restoreAll();
  }
});

test('SHA 校验先于版本判断，损坏文件仍按真实资源身份报错', async t => {
  const { snapshot, bytes } = fixture(1, 2);
  snapshot.assets.find(asset => asset.id === 'g')!.sha256 = '0'.repeat(64);
  t.mock.method(globalThis, 'fetch', async (url: string) => new Response(bytes.get(url.slice(9))!));
  await assert.rejects(loadLightingResources(snapshot, state as never, undefined, { concurrency: 1, textureDecoder: 'image' }), /校验失败/);
  assert.equal(state.textures.length, 0);
});
