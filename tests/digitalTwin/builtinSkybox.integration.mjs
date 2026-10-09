import assert from 'node:assert/strict';
import { app } from 'electron';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { createServer } from 'vite';
import os from 'node:os';
import path from 'node:path';

app.whenReady().then(async () => {
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'builtin-skybox-list-'));
try {
  app.setPath('userData', temporaryRoot);
  const { clearProjectAssetStoreSession, listProjectAssets, setCurrentProjectRoot } = await import('../../dist-electron/ipc/projectAssetStore.js');
  clearProjectAssetStoreSession();
  const result = await listProjectAssets();
  assert.equal(result.projectRoot, null);
  assert.equal(result.skyboxes.find(asset => asset.id === 'builtin-skybox:partly-cloudy-light')?.source, 'builtin');
  const outputRoot = path.resolve(process.env.BUILTIN_SKYBOX_TEST_OUTPUT ?? 'output/playwright/builtin-skybox');
  await mkdir(outputRoot, { recursive: true });
  await writeFile(path.join(outputRoot, 'asset-list.json'), JSON.stringify(result, null, 2));
  const projectRoot = path.join(temporaryRoot, 'project');
  setCurrentProjectRoot(projectRoot);
  const projectResult = await listProjectAssets();
  assert.equal(projectResult.skyboxes.find(asset => asset.source === 'builtin')?.path, result.skyboxes[0].path);
  assert.deepEqual(projectResult.localSkyboxes, []);
  const asset = projectResult.skyboxes.find(asset => asset.source === 'builtin');
  assert.ok(asset);
  assert.equal(asset.fileSha256, undefined);
  const server = await createServer({ configFile: false, logLevel: 'error', server: { watch: null }, optimizeDeps: { noDiscovery: true } });
  try {
    const { createEmptySceneDocument, createSkyboxEntity } = await server.ssrLoadModule('/src/editor/model/SceneDocument.ts');
    const { serializeScene, deserializeScene } = await server.ssrLoadModule('/src/editor/project/SceneSerializer.ts');
    const scene = createEmptySceneDocument('内置天空盒打包验收');
    scene.sceneSettings.shadows.enabled = false;
    const entity = createSkyboxEntity({ packagePath: asset.packagePath, sourcePath: asset.path, sourceUrl: asset.sourceUrl,
      format: 'hdr', assetRevision: asset.assetRevision, rotationDegrees: 37, intensity: 0.8, resolution: 256 });
    scene.entities[entity.id] = entity; scene.entityIds.push(entity.id);
    const content = serializeScene(scene);
    const sceneFile = path.join(projectRoot, 'Scenes', 'main.scene.json');
    await mkdir(path.dirname(sceneFile), { recursive: true });
    await writeFile(sceneFile, content);
    const { buildDigitalTwinSourcePackage } = await import('../../dist-electron/ipc/digitalTwinSourcePackage.js');
    const { buildDigitalTwinDistPackage } = await import('../../dist-electron/ipc/digitalTwinDistPackage.js');
    app.getAppPath = () => process.cwd();
    const signal = new AbortController().signal;
    const source = await buildDigitalTwinSourcePackage({ projectRoot, sharedResourcesRoot: path.join(temporaryRoot, 'shared'),
      entrySceneFilePath: sceneFile, outputRoot: path.join(outputRoot, 'source'), signal,
      manifest: { projectId: '123', projectName: scene.name, editorProjectId: null, baseVersionId: null, resourceRevision: '1' },
      isPlatformImageReference: () => false, findSyncedImageForReference: async () => null,
      skyboxCacheDependencies: { getSharedProjectSkyboxRoot: () => null } });
    const dist = await buildDigitalTwinDistPackage({ projectId: '123', publishName: scene.name, sceneContent: source.entrySceneContent,
      sourceResourceFiles: source.resourceFiles, outputRoot: path.join(outputRoot, 'dist'), signal });
    const require = createRequire(import.meta.url);
    const unzipper = require('unzipper');
    const results = [];
    for (const [type, result, scenePath] of [['SOURCE', source, 'Scenes/main.scene.json'], ['DIST', dist, 'project/scene.json']]) {
      const archive = await unzipper.Open.file(result.filePath);
      const hdrs = archive.files.filter(file => /\.hdr$/i.test(file.path));
      assert.equal(hdrs.length, 1, `${type}仅包含实际引用的单份天空盒`);
      const hdr = await hdrs[0].buffer();
      assert.equal(hdr.length, asset.fileSizeBytes);
      assert.equal(createHash('sha256').update(hdr).digest('hex'), asset.assetRevision);
      const sceneEntry = archive.files.find(file => file.path === scenePath);
      assert.ok(sceneEntry);
      const reopened = deserializeScene((await sceneEntry.buffer()).toString('utf8'));
      assert.equal(reopened.entities[entity.id].components.skybox.intensity, 0.8);
      assert.equal(reopened.entities[entity.id].components.skybox.resolution, 256);
      assert.deepEqual(reopened.entities[entity.id].components.transform.rotation, entity.components.transform.rotation);
      assert.deepEqual(result.warnings, []);
      if (type === 'DIST') await archive.extract({ path: path.join(outputRoot, 'viewer') });
      results.push({ type, filePath: result.filePath, hdrPath: hdrs[0].path, hdrBytes: hdr.length, warnings: result.warnings });
    }
    assert.equal(await readFile(sceneFile, 'utf8'), content);
    await writeFile(path.join(outputRoot, 'package-result.json'), JSON.stringify({ passed: true, results }, null, 2));
    console.log('builtin skybox: SOURCE/DIST roundtrip, hash, parameters and single-resource packaging passed');
  } finally { await server.close(); }
  console.log('builtin skybox: no-project and empty-project IPC store integration passed');
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
  app.quit();
}
}).catch(error => { console.error(error); app.exit(1); });
