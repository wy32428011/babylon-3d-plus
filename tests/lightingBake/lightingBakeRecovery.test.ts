import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, promises as fs } from 'node:fs';
import { registerHooks } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { getSceneLightingBakeError, getSceneLightingBakeSignature } from '../../electron/shared/sceneLightingBakeContract.ts';
import { normalizeSceneAppearanceConfig, normalizeSceneLightingConfig } from '../../electron/shared/sceneLightingConfig.ts';

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL?.includes('/electron/')) {
      const target = new URL(specifier, context.parentURL), source = new URL(target.href.slice(0, -3) + '.ts');
      if (!existsSync(target) && existsSync(source)) return nextResolve(source.href, context);
    }
    return nextResolve(specifier, context);
  },
});
const { recoverLocalSceneResourcePaths } = await import('../../electron/ipc/localSceneResourceRecovery.ts');
hooks.deregister();
const url = (file: string) => 'editor-asset://local/' + encodeURIComponent(file);

test('本地恢复覆盖全部独立光照资产，内容不匹配保留旧引用并报告', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lighting-recovery-'));
  t.after(() => cleanupFixture(root));
  const workspace = path.join(root, 'workspace'), projectRoot = path.join(workspace, 'Projects', '42');
  const assets = [];
  for (const [id, kind, name, text] of [['g', 'geometry', 'mesh.json', '{"positions":[1,2,3]}'], ['l', 'lightmap', 'map.png', 'png'], ['p', 'probes', 'probes.json', '{"probes":[1]}']]) {
    const relative = 'Projects/42/Assets/LightingBakes/job/' + name;
    const actual = path.join(workspace, ...relative.split('/'));
    await fs.mkdir(path.dirname(actual), { recursive: true }); await fs.writeFile(actual, text);
    assets.push({ id, kind, url: url('Z:/old/' + relative), byteLength: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex') });
  }
  const scene: any = { entities: { cube: { components: { meshRenderer: { meshKind: 'cube' } } } }, sceneSettings: { lighting: normalizeSceneLightingConfig({ version: 2 }), appearance: normalizeSceneAppearanceConfig({}) } };
  scene.sceneSettings.lighting.result = { version: 1, signature: getSceneLightingBakeSignature(scene), createdAt: '2026-10-20T00:00:00Z', engineVersion: 'fixture',
    assets, surfaces: [{ key: 'cube/root', entityId: 'cube', nodeKey: 'root', geometryAssetId: 'g', lightmapAssetId: 'l' }], probeAssetId: 'p',
    statistics: { meshCount: 1, triangleCount: 1, atlasCount: 1, probeCount: 1, textureBytes: 3, durationMs: 1 } };
  const sceneContent = JSON.stringify({ version: 5, scene });
  const restored = await recoverLocalSceneResourcePaths({ sceneContent, workspaceRoot: workspace, projectRoot });
  assert.deepEqual(restored.issues, []);
  assert.equal(restored.restoredReferenceCount, 3);
  assert.equal(restored.resolvedFiles.length, 3);
  const reopened = JSON.parse(restored.sceneContent).scene;
  assert.equal(getSceneLightingBakeError(reopened), null);
  for (const asset of reopened.sceneSettings.lighting.result.assets) assert.ok(decodeURIComponent(new URL(asset.url).pathname).includes('LightingBakes'));
  await fs.writeFile(path.join(projectRoot, 'Assets', 'LightingBakes', 'job', 'probes.json'), '{"probes":[2]}');
  const failed = await recoverLocalSceneResourcePaths({ sceneContent, workspaceRoot: workspace, projectRoot });
  assert.match(failed.issues[0].message, /光照.*校验/);
  assert.equal(JSON.parse(failed.sceneContent).scene.sceneSettings.lighting.result.assets[2].url, assets[2].url);
});

async function cleanupFixture(root: string): Promise<void> {
  if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('lighting-')) throw new Error('测试清理目录越界。');
  await fs.rm(root, { recursive: true, force: true });
}
