import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, promises as fs } from 'node:fs';
import { registerHooks } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { getSceneLightingBakeError, getSceneLightingBakeSignature } from '../../electron/shared/sceneLightingBakeContract.ts';
import { normalizeSceneAppearanceConfig, normalizeSceneLightingConfig } from '../../electron/shared/sceneLightingConfig.ts';

const electronRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lighting-export-host-'));
after(() => cleanupFixture(electronRoot));
const electronStub = 'data:text/javascript,' + encodeURIComponent(
  'export const app={isPackaged:false,getPath:()=>'+JSON.stringify(electronRoot)+',getAppPath:()=>process.cwd()}; export const dialog={},ipcMain={},net={},shell={},BrowserWindow={},protocol={},session={};'
);
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'electron') return nextResolve(electronStub, context);
    if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL?.includes('/electron/')) {
      const target = new URL(specifier, context.parentURL), source = new URL(target.href.slice(0, -3) + '.ts');
      if (!existsSync(target) && existsSync(source)) return nextResolve(source.href, context);
    }
    return nextResolve(specifier, context);
  },
});
const [{ prepareDeploymentExport }, { copyDeploymentFiles }, registry] = await Promise.all([
  import('../../electron/ipc/deploymentExportScene.ts'),
  import('../../electron/ipc/deploymentExportFileSystem.ts'),
  import('../../electron/ipc/assetRegistry.ts'),
]);
hooks.deregister();
const url = (file: string) => 'editor-asset://local/' + encodeURIComponent(file);

test('DIST复制全部光照JSON与PNG，重写资源后离线可读且无需烘焙引擎', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lighting-dist-'));
  t.after(() => cleanupFixture(root));
  const project = path.join(root, 'project'), job = path.join(project, 'Assets', 'LightingBakes', 'job-1');
  const model = path.join(project, 'Assets', 'Models', 'pump', 'model.glb');
  await fs.mkdir(path.dirname(model), { recursive: true }); await fs.writeFile(model, 'model');
  await fs.writeFile(path.join(path.dirname(model), 'meta.json'), '{}');
  await fs.mkdir(job, { recursive: true });
  registry.authorizeAssetRoot(project);
  const assets = [];
  for (const [id, kind, file, text] of [['g', 'geometry', 'mesh.json', '{"positions":[1,2,3]}'], ['l', 'lightmap', 'map.png', 'png'], ['p', 'probes', 'probes.json', '{"probes":[1]}']]) {
    await fs.writeFile(path.join(job, file), text);
    assets.push({ id, kind, url: url(path.join(job, file)), byteLength: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex') });
  }
  const scene: any = { id: 'scene', name: '工厂', entityIds: ['a'], entities: { a: { id: 'a', components: {
    transform: { position: { x: 1, y: 2, z: 3 } }, modelAsset: { sourcePath: model, sourceUrl: url(model), assetRevision: 'r1', thumbnailUrl: url(path.join(path.dirname(model), 'thumb.png')) },
  } } }, sceneSettings: { lighting: normalizeSceneLightingConfig({ version: 2 }), appearance: normalizeSceneAppearanceConfig({}) }, mqttConfig: { enabled: false } };
  scene.sceneSettings.lighting.result = { version: 1, signature: getSceneLightingBakeSignature(scene), createdAt: '2026-10-20T00:00:00Z', engineVersion: 'fixture',
    assets, surfaces: [{ key: 'a/root', entityId: 'a', nodeKey: 'root', geometryAssetId: 'g', lightmapAssetId: 'l' }], probeAssetId: 'p',
    statistics: { meshCount: 1, triangleCount: 1, atlasCount: 1, probeCount: 1, textureBytes: 3, durationMs: 1 } };
  const signal = new AbortController().signal;
  const prepared = await prepareDeploymentExport(JSON.stringify({ version: 5, scene }), 'factory', [], signal, () => {});
  const deployment = JSON.parse(prepared.sceneContent).scene;
  assert.equal(getSceneLightingBakeError(deployment), null);
  const output = path.join(root, 'dist');
  await fs.mkdir(output);
  await copyDeploymentFiles(prepared.assetFiles, output, 2, signal, () => {});
  assert.equal(path.dirname(path.resolve(project)), path.resolve(root));
  const movedRoot = path.resolve(root, 'source-moved');
  assert.equal(path.dirname(movedRoot), path.resolve(root));
  await fs.rename(project, movedRoot);
  for (const asset of deployment.sceneSettings.lighting.result.assets) {
    const reference = decodeURIComponent(new URL(asset.url).pathname.slice(1));
    assert.match(reference, /^project\/assets\/lighting-bakes\//);
    const data = await fs.readFile(path.join(output, reference));
    assert.equal(createHash('sha256').update(data).digest('hex'), asset.sha256);
  }
  assert.equal(prepared.assetFiles.filter(file => file.destinationRelativePath.includes('/lighting-bakes/')).length, 3);
});

async function cleanupFixture(root: string): Promise<void> {
  if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('lighting-')) throw new Error('测试清理目录越界。');
  await fs.rm(root, { recursive: true, force: true });
}
