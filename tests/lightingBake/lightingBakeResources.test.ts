import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, promises as fs } from 'node:fs';
import { registerHooks } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { getSceneLightingBakeSignature } from '../../electron/shared/sceneLightingBakeContract.ts';
import { normalizeSceneLightingConfig } from '../../electron/shared/sceneLightingConfig.ts';

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL?.includes('/electron/')) {
      const target = new URL(specifier, context.parentURL), source = new URL(target.href.slice(0, -3) + '.ts');
      if (!existsSync(target) && existsSync(source)) return nextResolve(source.href, context);
    }
    return nextResolve(specifier, context);
  },
});
const { resolveSceneLightingBakeAssets, prepareLightingSceneSave, prepareLightingSceneContent, assertLightingBakeResourceFile } = await import('../../electron/ipc/sceneLightingBakeResources.ts');
hooks.deregister();
const url = (file: string) => 'editor-asset://local/' + encodeURIComponent(file);

test('打开或保存的光照预处理拒绝未知场景版本，不能将其改写为当前版本', async () => {
  for (const version of [7, '6', null]) {
    const content = JSON.stringify({ version, scene: { entities: {}, sceneSettings: {} } });
    for (const prepare of [prepareLightingSceneContent, prepareLightingSceneSave]) {
      await assert.rejects(prepare(content, path.join(os.tmpdir(), 'unsupported.scene.json')), /场景.*版本|场景.*格式/);
    }
  }
});

async function fixture(t: Parameters<Parameters<typeof test>[1]>[0]) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lighting-resources-'));
  t.after(() => cleanupFixture(root));
  const projectRoot = path.join(root, 'original');
  const jobRoot = path.join(projectRoot, 'Assets', 'LightingBakes', 'job-1');
  await fs.mkdir(jobRoot, { recursive: true });
  const assets = [];
  for (const [id, kind, file, content] of [['geometry', 'geometry', 'mesh.json', '{"vertices":[0,1,2]}'], ['lightmap', 'lightmap', 'map.png', 'png-fixture'], ['probes', 'probes', 'probes.json', '{"probes":[]}']]) {
    await fs.writeFile(path.join(jobRoot, file), content);
    assets.push({ id, kind, url: url(path.join(jobRoot, file)), byteLength: Buffer.byteLength(content), sha256: createHash('sha256').update(content).digest('hex') });
  }
  const scene: any = { entities: { a: { components: { meshRenderer: { meshKind: 'cube' } } } }, sceneSettings: { lighting: normalizeSceneLightingConfig(undefined) } };
  scene.sceneSettings.lighting.result = { version: 1, signature: getSceneLightingBakeSignature(scene), createdAt: '2026-10-20T00:00:00Z', engineVersion: 'fixture',
    assets, surfaces: [{ key: 'a/root', entityId: 'a', nodeKey: 'root', geometryAssetId: 'geometry', lightmapAssetId: 'lightmap' }], probeAssetId: 'probes',
    statistics: { meshCount: 1, triangleCount: 1, atlasCount: 1, probeCount: 1, textureBytes: 11, durationMs: 1 } };
  return { root, projectRoot, jobRoot, scene, content: JSON.stringify({ version: 5, scene }) };
}
test('显式收集光照PNG、几何JSON和探针JSON，并按真实内容校验', async t => {
  const f = await fixture(t);
  const assets = await resolveSceneLightingBakeAssets(f.scene, { projectRoot: f.projectRoot });
  assert.equal(assets.length, 3);
  assert.deepEqual(assets.map(asset => path.extname(asset.sourcePath)).sort(), ['.json', '.json', '.png']);
  await fs.writeFile(path.join(f.jobRoot, 'probes.json'), '{"probes":[1]}');
  await assert.rejects(resolveSceneLightingBakeAssets(f.scene, { projectRoot: f.projectRoot }), /内容|大小|校验/);
});
test('另存为复制独立资产，移走原工程后仍能离线重新打开', async t => {
  const f = await fixture(t);
  const target = path.join(f.root, 'saved', 'Scenes', 'saved.scene.json');
  await fs.mkdir(path.dirname(target), { recursive: true });
  const saved = await prepareLightingSceneSave(f.content, target, { projectRoot: f.projectRoot });
  await fs.writeFile(target, saved.content);
  assert.equal(saved.files.length, 3);
  assert.equal(path.dirname(path.resolve(f.projectRoot)), path.resolve(f.root));
  const movedRoot = path.resolve(f.root, 'original-moved');
  assert.equal(path.dirname(movedRoot), path.resolve(f.root));
  await fs.rename(f.projectRoot, movedRoot);
  const reopened = JSON.parse((await prepareLightingSceneContent(saved.content, target)).content).scene;
  assert.equal(reopened.sceneSettings.lighting.result.signature, getSceneLightingBakeSignature(reopened));
  for (const asset of reopened.sceneSettings.lighting.result.assets) {
    assert.match(decodeURIComponent(new URL(asset.url).pathname), /saved[/\\]Assets[/\\]LightingBakes/);
    assert.ok((await fs.readFile(decodeURIComponent(new URL(asset.url).pathname.slice(1)))).length);
  }
});
test('过期结果另存为仍保持过期，禁止未经授权的资产和路径逃逸', async t => {
  const f = await fixture(t);
  f.scene.entities.a.components.meshRenderer.scale = 4;
  const signature = f.scene.sceneSettings.lighting.result.signature;
  const target = path.join(f.root, 'saved', 'saved.scene.json');
  await fs.mkdir(path.dirname(target), { recursive: true });
  const saved = await prepareLightingSceneSave(JSON.stringify({ version: 5, scene: f.scene }), target, { projectRoot: f.projectRoot });
  assert.equal(JSON.parse(saved.content).scene.sceneSettings.lighting.result.signature, signature);
  await assert.rejects(resolveSceneLightingBakeAssets(f.scene, { projectRoot: path.join(f.root, 'other') }), /授权|工程|目录/);
  f.scene.sceneSettings.lighting.result.assets[0].url = url(path.join(f.projectRoot, 'Assets', 'LightingBakes', 'job-1', '..', '..', 'secret.json'));
  await assert.rejects(resolveSceneLightingBakeAssets(f.scene, { projectRoot: f.projectRoot }), /LightingBakes|路径|目录/);
});
test('协议读取拒绝授权目录内的Junction，嵌套Scenes另存为仍写到工程Assets', async t => {
  const f = await fixture(t);
  const outside = path.join(f.root, 'outside');
  await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'secret.json'), '{}');
  const junction = path.join(f.jobRoot, 'linked');
  await fs.symlink(outside, junction, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(assertLightingBakeResourceFile(path.join(junction, 'secret.json')), /符号链接|目录|路径/);
  await assertLightingBakeResourceFile(path.join(f.jobRoot, 'mesh.json'));
  const target = path.join(f.root, 'saved', 'Scenes', '区域', 'scene.scene.json');
  await fs.mkdir(path.dirname(target), { recursive: true });
  const saved = await prepareLightingSceneSave(f.content, target, { projectRoot: f.projectRoot });
  assert.ok(saved.files.every(file => file.startsWith(path.join(f.root, 'saved', 'Assets', 'LightingBakes'))));
});
test('另存为目标存在不同资产时保留原文件，并回收本次新建的中间资产', async t => {
  const f = await fixture(t);
  const target = path.join(f.root, 'saved', 'main.scene.json');
  const conflicting = path.join(f.root, 'saved', 'Assets', 'LightingBakes', 'job-1', 'map.png');
  await fs.mkdir(path.dirname(conflicting), { recursive: true });
  await fs.writeFile(conflicting, 'existing-user-file');
  await assert.rejects(prepareLightingSceneSave(f.content, target, { projectRoot: f.projectRoot }), /不同内容|未覆盖/);
  assert.equal(await fs.readFile(conflicting, 'utf8'), 'existing-user-file');
  await assert.rejects(fs.access(path.join(path.dirname(conflicting), 'mesh.json')), { code: 'ENOENT' });
});

async function cleanupFixture(root: string): Promise<void> {
  if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('lighting-')) throw new Error('测试清理目录越界。');
  await fs.rm(root, { recursive: true, force: true });
}
