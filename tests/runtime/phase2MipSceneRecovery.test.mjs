import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, promises as fs } from 'node:fs';
import { registerHooks } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { normalizeSceneLightingConfig, normalizeSceneAppearanceConfig } from '../../electron/shared/sceneLightingConfig.ts';
import { getSceneLightingBakeSignature } from '../../electron/shared/sceneLightingBakeContract.ts';
import { encodeLightingLightmapMips } from '../../electron/shared/sceneLightingLightmapMips.ts';
import { LIGHTING_LIGHTMAP_MIP_RECIPE } from '../../electron/shared/sceneLightingTextureCodec.ts';

const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL?.includes('/electron/')) {
    const original = new URL(specifier, context.parentURL), source = new URL(original.href.slice(0, -3) + '.ts');
    if (!existsSync(original) && existsSync(source)) return next(source.href, context);
  }
  return next(specifier, context);
} });
const { recoverLocalSceneResourcePaths } = await import('../../electron/ipc/localSceneResourceRecovery.ts');
hooks.deregister();
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const url = file => 'editor-asset://local/' + encodeURIComponent(file);

async function fixture(t, { mip = false, gamma = false, binaryGeometry = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'phase2-mip-recovery-'));
  t.after(async () => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.match(path.basename(root), /^phase2-mip-recovery-/); await fs.rm(root, { recursive: true, force: true }); });
  const projectRoot = path.join(root, 'Projects', '42'), directory = path.join(projectRoot, 'Assets', 'LightingBakes', 'job'); await fs.mkdir(directory, { recursive: true });
  const lightmap = mip ? encodeLightingLightmapMips({ baseEncoding: gamma ? 'rgbm-gamma' : 'rgbm', rgbmRange: 1, levels: [4, 2].map(size => ({ width: size, height: size, rgba: new Uint8Array(size * size * 4).fill(127) })), maxTextureBytes: 80 }) : Buffer.from('legacy-png-path-hash-fixture');
  const lightmapAsset = { id: 'l', kind: 'lightmap', url: url(path.join(directory, mip ? 'map.bin' : 'map.png')), byteLength: lightmap.length, sha256: sha(lightmap),
    ...(mip ? { encoding: gamma ? 'rgbm-gamma-mips-v1' : 'rgbm-linear-mips-v1', rgbmRange: 1, width: 4, height: 4, levelCount: 2, textureBytes: 80, mipRecipe: LIGHTING_LIGHTMAP_MIP_RECIPE }
      : gamma ? { encoding: 'rgbm-gamma', rgbmRange: 1 } : {}) };
  // 恢复入口仅核路径、大小与SHA；fixture不冒充已完成geometry或PNG内容解码。
  const geometry = Buffer.from('owned-geometry-path-hash-fixture'), probes = Buffer.from('{"probes":[]}');
  const assets = [{ id: 'g', kind: 'geometry', url: url(path.join(directory, binaryGeometry ? 'mesh.bin' : 'mesh.json')), byteLength: geometry.length, sha256: sha(geometry), ...(binaryGeometry ? { encoding: 'binary-v1' } : {}) },
    lightmapAsset, { id: 'p', kind: 'probes', url: url(path.join(directory, 'probes.json')), byteLength: probes.length, sha256: sha(probes) }];
  for (const [asset, bytes] of assets.map((asset, index) => [asset, [geometry, lightmap, probes][index]])) await fs.writeFile(decodeURIComponent(new URL(asset.url).pathname.slice(1)), bytes);
  const scene = { entityIds: ['cube'], entities: { cube: { id: 'cube', parentId: null, childrenIds: [], components: { meshRenderer: { meshKind: 'cube' }, transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } } } } },
    sceneSettings: { lighting: normalizeSceneLightingConfig({ version: mip || gamma ? 3 : 2, bake: { enabled: true, ...(mip ? { lightmapMipLevels: 1 } : {}), ...(gamma ? { lightmapEncoding: 'rgbm-gamma' } : {}) } }), appearance: normalizeSceneAppearanceConfig({}) } };
  scene.sceneSettings.lighting.result = { version: 1, signature: getSceneLightingBakeSignature(scene), createdAt: '2026-10-25T00:00:00Z', engineVersion: 'recovery-path-contract', assets,
    surfaces: [{ key: 'cube/root', entityId: 'cube', nodeKey: 'root', geometryAssetId: 'g', lightmapAssetId: 'l' }], probeAssetId: 'p',
    statistics: { meshCount: 1, triangleCount: 1, atlasCount: 1, probeCount: 1, textureBytes: mip ? 80 : 4, durationMs: 1 } };
  return { root, projectRoot, scene, content: () => JSON.stringify({ version: 6, scene }), options: () => ({ sceneContent: JSON.stringify({ version: 6, scene }), workspaceRoot: root, projectRoot }) };
}

test('真实localRecovery按kind/codec精确恢复旧PNG/JSON、B7 binary-v1和B9两类mip bin', async t => {
  for (const options of [{}, { binaryGeometry: true }, { gamma: true, binaryGeometry: true }, { mip: true, binaryGeometry: true }, { mip: true, gamma: true, binaryGeometry: true }]) {
    await t.test(JSON.stringify(options), async child => { const f = await fixture(child, options), before = f.content(), result = await recoverLocalSceneResourcePaths(f.options());
      assert.deepEqual(result.issues, []); assert.deepEqual(result.missing, []); assert.equal(result.resolvedFiles.length, 3);
      assert.deepEqual(JSON.parse(result.sceneContent).scene.sceneSettings.lighting.result, f.scene.sceneSettings.lighting.result);
      assert.equal(f.content(), before, '不能变更调用者传入对象'); });
  }
});

test('未知codec、错误扩展、越界路径和普通bin仍拒绝，不能扩大为允许所有bin', async t => {
  for (const [name, options, mutate, thrown] of [
    ['legacy lightmap bin', {}, asset => { asset.url = asset.url.replace(/map\.png$/, 'map.bin'); }, false],
    ['mip png', { mip: true }, asset => { asset.url = asset.url.replace(/map\.bin$/, 'map.png'); }, false],
    ['mip unknown', { mip: true }, asset => { asset.encoding = 'rgbm-gamma-mips-v999'; }, true],
    ['mip parent traversal', { mip: true }, asset => { asset.url = url(path.join(os.tmpdir(), 'Assets', 'LightingBakes', 'job') + path.sep + '..' + path.sep + 'outside.bin'); }, false],
    ['mip outside bake dir', { mip: true }, asset => { asset.url = asset.url.replace('LightingBakes', 'OtherAssets'); }, false],
  ]) await t.test(name, async child => { const f = await fixture(child, options); mutate(f.scene.sceneSettings.lighting.result.assets[1]);
    if (thrown) await assert.rejects(recoverLocalSceneResourcePaths(f.options()));
    else { const result = await recoverLocalSceneResourcePaths(f.options()); assert.ok(result.issues.length > 0); assert.ok(result.missing.length > 0); } });
});

// 外部真实case只在明确提供时执行；默认fresh clone不依赖未跟踪output产物。
if (process.env.PHASE2_MIP_RECOVERY_SCENE) test('明确外部case2已保存scene经真实localRecovery准备零缺失且文件/全部资产SHA保持', async () => {
  const sceneFilePath = path.resolve(process.env.PHASE2_MIP_RECOVERY_SCENE), bytes = await fs.readFile(sceneFilePath), document = JSON.parse(bytes.toString('utf8'));
  const projectRoot = path.dirname(path.dirname(sceneFilePath)), snapshot = document.scene.sceneSettings.lighting.result;
  assert.equal(document.scene.sceneSettings.lighting.version, 3); assert.ok(snapshot.assets.some(asset => asset.kind === 'lightmap' && asset.encoding?.endsWith('mips-v1')));
  const original = await Promise.all(snapshot.assets.map(async asset => ({ file: decodeURIComponent(new URL(asset.url).pathname.slice(1)), sha256: asset.sha256 })));
  const result = await recoverLocalSceneResourcePaths({ sceneContent: bytes.toString('utf8'), sceneFilePath, workspaceRoot: projectRoot, projectRoot });
  assert.deepEqual(result.issues, []); assert.deepEqual(result.missing, []); assert.deepEqual(JSON.parse(result.sceneContent).scene.sceneSettings.lighting.result, snapshot);
  assert.equal(sha(await fs.readFile(sceneFilePath)), sha(bytes)); for (const asset of original) assert.equal(sha(await fs.readFile(asset.file)), asset.sha256);
});
