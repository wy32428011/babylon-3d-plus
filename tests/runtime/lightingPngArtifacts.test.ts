import assert from 'node:assert/strict';
import { existsSync, promises as fs } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { getLightingAtlasDimensions, validateLightingPng } from '../../electron/shared/sceneLightingBakeArtifacts.ts';
import { validateSceneLightingBakeSnapshot, type SceneLightingBakeSnapshot } from '../../electron/shared/sceneLightingBakeContract.ts';

// 单元测试只构造PNG头部；完整图像解码仍由运行时loader负责。
function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33); bytes.set([137, 80, 78, 71, 13, 10, 26, 10]); bytes.set([73, 72, 68, 82], 12);
  const view = new DataView(bytes.buffer); view.setUint32(16, width); view.setUint32(20, height); return bytes;
}
function snapshot(atlasCount = 1, textureBytes = 1024): SceneLightingBakeSnapshot {
  return { version: 1, signature: 'lighting-test', geometrySignature: 'geometry-test', createdAt: '2026-10-23T00:00:00Z', engineVersion: 'fixture',
    assets: [
      ...Array.from({ length: atlasCount }, (_, index) => ({ id: 'map-' + index, kind: 'lightmap' as const, url: 'memory://map-' + index + '.png', byteLength: 33, rgbmRange: 1 })),
      { id: 'geometry', kind: 'geometry', url: 'memory://geometry.json', byteLength: 1 }, { id: 'probes', kind: 'probes', url: 'memory://probes.json', byteLength: 1 },
    ], surfaces: [{ key: 'fixed/root/primitive:0', entityId: 'fixed', nodeKey: 'root', geometryAssetId: 'geometry', lightmapAssetId: 'map-0' }], probeAssetId: 'probes',
    statistics: { meshCount: 1, triangleCount: 1, atlasCount, probeCount: 1, textureBytes, durationMs: 0 } };
}

test('正式snapshot正规化后的同像素32×8图集必须与后台16×16声明一样拒绝', () => {
  const raw = snapshot(), normalized = validateSceneLightingBakeSnapshot(raw); assert.ok(normalized);
  assert.doesNotThrow(() => validateLightingPng(pngHeader(32, 8), normalized.statistics.textureBytes / 4), '原有总像素上限确实无法识别异形图集');
  const expected = getLightingAtlasDimensions(normalized); assert.deepEqual(expected, { width: 16, height: 16 });
  assert.throws(() => validateLightingPng(pngHeader(32, 8), 256, expected), /实际尺寸/);
  assert.deepEqual(validateLightingPng(pngHeader(16, 16), 256, expected), expected);
});

test('实际图集数量必须匹配统计，预算必须描述同尺寸RGBA方图', () => {
  const countMismatch = snapshot(); countMismatch.statistics.atlasCount = 2;
  assert.ok(validateSceneLightingBakeSnapshot(countMismatch), '保持既有snapshot正规化兼容性，严格检查在实际资源加载边界完成');
  assert.throws(() => getLightingAtlasDimensions(countMismatch), /图集/);
  for (const bytes of [0, 3, 16 * 8 * 4, 1024.5]) assert.throws(() => getLightingAtlasDimensions(snapshot(1, bytes)), /图集/);
  const noMaps = snapshot(); noMaps.assets = noMaps.assets.filter(asset => asset.kind !== 'lightmap');
  assert.throws(() => getLightingAtlasDimensions(noMaps), /图集/);
});

test('合法多图和1×1小图集仍保持现有v1兼容，不硬限生产图集尺寸', () => {
  const multi = snapshot(2, 2 * 16 * 16 * 4); assert.deepEqual(getLightingAtlasDimensions(multi), { width: 16, height: 16 });
  const tiny = snapshot(1, 4); assert.deepEqual(getLightingAtlasDimensions(tiny), { width: 1, height: 1 });
  assert.deepEqual(validateLightingPng(pngHeader(1, 1), 1, getLightingAtlasDimensions(tiny)), { width: 1, height: 1 });
});

test('实际loader在创建纹理前拒绝同像素异形图集并保留资源身份', async t => {
  const project = new URL('../../', import.meta.url);
  const hooks = registerHooks({ resolve(specifier, context, next) {
    if (specifier.startsWith('.') && context.parentURL?.startsWith(project.href) && !specifier.endsWith('.ts')) {
      const source = new URL(specifier.endsWith('.js') ? specifier.slice(0, -3) + '.ts' : specifier + '.ts', context.parentURL);
      if (existsSync(source)) return { url: source.href, shortCircuit: true };
    }
    return next(specifier, context);
  } });
  try {
    const { loadLightingResources } = await import('../../src/runtime/babylon/lightingRuntimeResources.ts');
    let reads = 0; t.mock.method(globalThis, 'fetch', async () => { reads++; return new Response(pngHeader(32, 8).buffer as ArrayBuffer); });
    const normalized = validateSceneLightingBakeSnapshot(snapshot()); assert.ok(normalized);
    await assert.rejects(loadLightingResources(normalized, {} as never), error => {
      const resource = error as Error & { diagnostic?: { assetId: string } };
      assert.match(resource.message, /实际尺寸/); assert.equal(resource.diagnostic?.assetId, 'map-0'); return true;
    });
    assert.equal(reads, 1, '非法图集不得继续加载后续资源或创建纹理');
  } finally { hooks.deregister(); }
});

test('真实引擎manifest中的全部PNG与实际统计相符', { skip: !process.env.LIGHTING_BAKE_REAL_MANIFEST }, async () => {
  const raw = JSON.parse(await fs.readFile(process.env.LIGHTING_BAKE_REAL_MANIFEST!, 'utf8'));
  const manifest = validateSceneLightingBakeSnapshot(raw); assert.ok(manifest, '真实fixture必须是正式manifest');
  const expected = getLightingAtlasDimensions(manifest);
  const maps = manifest.assets.filter(asset => asset.kind === 'lightmap'); assert.equal(maps.length, manifest.statistics.atlasCount);
  for (const asset of maps) {
    assert.ok(asset.url.startsWith('editor-asset://local/'), '真实fixture使用正式本地资源URL');
    const file = decodeURIComponent(asset.url.slice('editor-asset://local/'.length).split(/[?#]/)[0]);
    const bytes = await fs.readFile(file); assert.equal(bytes.byteLength, asset.byteLength);
    assert.deepEqual(validateLightingPng(bytes, expected.width * expected.height, expected), expected);
  }
});
