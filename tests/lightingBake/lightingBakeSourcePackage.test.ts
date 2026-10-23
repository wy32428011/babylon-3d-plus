import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, promises as fs } from 'node:fs';
import { registerHooks, createRequire } from 'node:module';
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
const [{ buildDigitalTwinSourcePackage }, { relocateDataPlatformScene }] = await Promise.all([
  import('../../electron/ipc/digitalTwinSourcePackage.ts'), import('../../electron/ipc/dataPlatformSceneRelocation.ts'),
]);
hooks.deregister();
const unzipper = createRequire(import.meta.url)('unzipper');
const url = (file: string) => 'editor-asset://local/' + encodeURIComponent(file);

test('SOURCE完整携带几何、探针、贴图并在其他工作区保留可编辑有效结果', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lighting-source-'));
  t.after(() => cleanupFixture(root));
  const projectRoot = path.join(root, 'project'), scenePath = path.join(projectRoot, 'Scenes', 'main.scene.json');
  const model = path.join(projectRoot, 'Assets', 'Models', 'pump', 'model.glb');
  await fs.mkdir(path.dirname(model), { recursive: true }); await fs.writeFile(model, 'source-model');
  await fs.mkdir(path.dirname(scenePath), { recursive: true });
  const job = path.join(projectRoot, 'Assets', 'LightingBakes', 'job-1');
  await fs.mkdir(job, { recursive: true });
  const assets = [];
  for (const [id, kind, file, text] of [['g', 'geometry', 'mesh.json', '{"positions":[1,2,3]}'], ['l', 'lightmap', 'map.png', 'png'], ['p', 'probes', 'probes.json', '{"probes":[1]}']]) {
    await fs.writeFile(path.join(job, file), text);
    assets.push({ id, kind, url: url(path.join(job, file)), byteLength: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex') });
  }
  await fs.writeFile(path.join(job, 'not-referenced.txt'), 'not an asset');
  const scene: any = { name: '烘焙工厂', entityIds: ['a'], entities: { a: { id: 'a', components: {
    transform: { position: { x: 0, y: 0, z: 0 } }, modelAsset: { sourcePath: model, sourceUrl: url(model), assetRevision: 'r1' },
    lighting: { mobility: 'auto', nodeOverrides: { root: { mobility: 'static' } }, resourceIdentity: 'geometry-identity' },
  } } }, sceneSettings: { lighting: normalizeSceneLightingConfig({ version: 2 }), appearance: normalizeSceneAppearanceConfig({}) } };
  scene.sceneSettings.lighting.result = { version: 1, signature: getSceneLightingBakeSignature(scene), createdAt: '2026-10-20T00:00:00Z', engineVersion: 'fixture',
    assets, surfaces: [{ key: 'a/root', entityId: 'a', nodeKey: 'root', geometryAssetId: 'g', lightmapAssetId: 'l' }], probeAssetId: 'p',
    statistics: { meshCount: 1, triangleCount: 1, atlasCount: 1, probeCount: 1, textureBytes: 3, durationMs: 1 } };
  await fs.writeFile(scenePath, JSON.stringify({ version: 5, scene }));
  const result = await buildDigitalTwinSourcePackage({ projectRoot, sharedResourcesRoot: path.join(root, 'shared'), entrySceneFilePath: scenePath,
    outputRoot: path.join(root, 'output'), manifest: { projectId: '42', projectName: '工厂', editorProjectId: null, baseVersionId: null, resourceRevision: '1' },
    signal: new AbortController().signal, isPlatformImageReference: () => false, findSyncedImageForReference: async () => null,
    skyboxCacheDependencies: { getSharedProjectSkyboxRoot: () => null } });
  const archive = await unzipper.Open.file(result.filePath);
  const portable = JSON.parse((await archive.files.find((file: any) => file.path === 'Scenes/main.scene.json').buffer()).toString());
  assert.equal(getSceneLightingBakeError(portable.scene), null);
  assert.equal(archive.files.some((file: any) => file.path.endsWith('not-referenced.txt')), false);
  for (const asset of portable.scene.sceneSettings.lighting.result.assets) {
    const member = decodeURIComponent(new URL(asset.url).pathname.slice(1));
    assert.match(member, /^Assets\/LightingBakes\//);
    const bytes = await archive.files.find((file: any) => file.path === member).buffer();
    assert.equal(createHash('sha256').update(bytes).digest('hex'), asset.sha256);
  }
  const reopenedRoot = path.join(root, 'reopened');
  await archive.extract({ path: reopenedRoot });
  const reopened = relocateDataPlatformScene(portable, reopenedRoot) as any;
  assert.equal(getSceneLightingBakeError(reopened.scene), null);
  for (const asset of reopened.scene.sceneSettings.lighting.result.assets) assert.ok((await fs.readFile(decodeURIComponent(new URL(asset.url).pathname.slice(1)))).length);
  assert.deepEqual(reopened.scene.entities.a.components.lighting, scene.entities.a.components.lighting);
  await fs.writeFile(path.join(job, 'probes.json'), '{"probes":[2]}');
  await assert.rejects(buildDigitalTwinSourcePackage({ projectRoot, sharedResourcesRoot: path.join(root, 'shared'), entrySceneFilePath: scenePath,
    outputRoot: path.join(root, 'bad-output'), manifest: { projectId: '42', projectName: '工厂', editorProjectId: null, baseVersionId: null, resourceRevision: '1' },
    signal: new AbortController().signal, isPlatformImageReference: () => false, findSyncedImageForReference: async () => null,
    skyboxCacheDependencies: { getSharedProjectSkyboxRoot: () => null } }), /光照|校验|SHA/);
});

async function cleanupFixture(root: string): Promise<void> {
  if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('lighting-')) throw new Error('测试清理目录越界。');
  await fs.rm(root, { recursive: true, force: true });
}
