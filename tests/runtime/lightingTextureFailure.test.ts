import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { validateSceneLightingBakeSnapshot, type SceneLightingBakeSnapshot } from '../../electron/shared/sceneLightingBakeContract.ts';

test('纹理构造同步失败时释放候选并保留原资源错误', async t => {
  // 只模拟构造器的同步回调顺序；真实解码和WebGL由独立Electron闭环验证。
  const state = { created: 0, disposed: 0 };
  const key = Symbol.for('lighting-texture-sync-failure');
  const globals = globalThis as unknown as Record<symbol, unknown>, previous = globals[key];
  globals[key] = state;
  const stub = 'data:text/javascript,' + encodeURIComponent([
    "const state = globalThis[Symbol.for('lighting-texture-sync-failure')];",
    'export class Texture {',
    ' static BILINEAR_SAMPLINGMODE = 2; static CLAMP_ADDRESSMODE = 0;',
    " constructor(...args) { state.created++; this.scene = args[1]; this.scene.textures.push(this); args[6]('同步解码失败'); }",
    ' dispose() { state.disposed++; this.scene.textures.splice(this.scene.textures.indexOf(this), 1); }',
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
  try {
    const bytes = new Uint8Array(33); bytes.set([137, 80, 78, 71, 13, 10, 26, 10]); bytes.set([73, 72, 68, 82], 12);
    const view = new DataView(bytes.buffer); view.setUint32(16, 1); view.setUint32(20, 1);
    t.mock.method(globalThis, 'fetch', async () => new Response(bytes.buffer));
    const snapshot: SceneLightingBakeSnapshot = {
      version: 1, signature: 'sync-failure', createdAt: '2026-10-23T00:00:00Z', engineVersion: 'fixture',
      assets: [{ id: 'map', kind: 'lightmap', url: 'memory://sync.png', byteLength: bytes.byteLength, rgbmRange: 1 },
        { id: 'geometry', kind: 'geometry', url: 'memory://geometry.json', byteLength: 1 },
        { id: 'probes', kind: 'probes', url: 'memory://probes.json', byteLength: 1 }],
      surfaces: [{ key: 'fixed/root', entityId: 'fixed', nodeKey: 'root', geometryAssetId: 'geometry', lightmapAssetId: 'map' }],
      probeAssetId: 'probes', statistics: { meshCount: 1, triangleCount: 1, atlasCount: 1, probeCount: 1, textureBytes: 4, durationMs: 0 },
    };
    assert.ok(validateSceneLightingBakeSnapshot(snapshot));
    const scene = { textures: [] };
    const { loadLightingResources } = await import('../../src/runtime/babylon/lightingRuntimeResources.ts');
    await assert.rejects(loadLightingResources(snapshot, scene as never), error => {
      const failure = error as Error & { diagnostic?: { assetId?: string } };
      assert.match(failure.message, /同步解码失败/); assert.equal(failure.diagnostic?.assetId, 'map'); return true;
    });
    assert.equal(state.created, 1); assert.equal(state.disposed, 1); assert.equal(scene.textures.length, 0);
  } finally {
    hooks.deregister(); if (previous === undefined) delete globals[key]; else globals[key] = previous;
  }
});
