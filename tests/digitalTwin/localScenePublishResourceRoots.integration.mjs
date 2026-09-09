import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { app } from 'electron';

const root = await mkdtemp(path.join(os.tmpdir(), 'local-publish-roots-'));
await mkdir(path.join(root, 'user-data'));
app.setPath('userData', path.join(root, 'user-data'));
app.disableHardwareAcceleration();

async function run() {
  const store = await import('../../dist-electron/ipc/projectAssetStore.js');
  const service = await import('../../dist-electron/ipc/dataPlatformProjectService.js');
  const bindings = await import('../../dist-electron/ipc/dataPlatformBindingStore.js');
  const { buildDigitalTwinSourcePackage } = await import('../../dist-electron/ipc/digitalTwinSourcePackage.js');
  const workspaceRoot = path.join(root, 'workspace');
  const legacyPackage = path.join(workspaceRoot, 'Assets', 'Models', 'Model-1001-货架');
  await mkdir(legacyPackage, { recursive: true });
  const modelPath = path.join(legacyPackage, 'model.glb');
  await writeFile(modelPath, 'fixture-model');
  await writeFile(path.join(legacyPackage, 'meta.json'), '{"displayName":"货架","lengthUnit":"meter"}');
  await store.activateProjectRoot(workspaceRoot);
  bindings.clearCurrentDataPlatformBinding();
  const prepared = await service.prepareDataPlatformProjectForPublish({
    id: '42', projectName: '本地场景首次发布', currentResourceRevision: '0',
    latestEditorProjectId: null, latestEditorProjectVersionId: null, latestEditorProjectVersionNumber: null,
  }, 'http://127.0.0.1:9999', workspaceRoot);
  const scenePath = path.join(prepared.projectRoot, 'Scenes', 'local.scene.json');
  await mkdir(path.dirname(scenePath), { recursive: true });
  const scene = { version: 5, scene: { name: '本地同步场景', entityIds: ['device'],
    entities: { device: { id: 'device', components: { modelAsset: {
      sourcePath: modelPath, sourceUrl: `editor-asset://local/${encodeURIComponent(modelPath)}`,
    } } } }, sceneSettings: {} } };
  await writeFile(scenePath, JSON.stringify(scene));
  const result = await buildDigitalTwinSourcePackage({
    projectRoot: prepared.projectRoot, sharedResourcesRoot: path.join(workspaceRoot, 'SharedResources'), legacyWorkspaceRoot: workspaceRoot,
    entrySceneFilePath: scenePath, outputRoot: path.join(root, 'output'), signal: new AbortController().signal,
    manifest: { projectId: '42', projectName: '本地场景首次发布', editorProjectId: null, baseVersionId: null, resourceRevision: '0' },
    isPlatformImageReference: () => false, findSyncedImageForReference: async () => null,
    skyboxCacheDependencies: { getSharedProjectSkyboxRoot: () => null },
  });
  assert.deepEqual(result.omittedResources, [], '首次绑定发布后，本地场景刚同步的工作区模型不能被当成外部资源');
  assert.equal(result.resourceFileCount, 2);
  console.log('PASS: local workspace cache remains packageable after first publish binding');
  await service.disposeDataPlatformProjectTasks();
}

let exitCode = 0;
void app.whenReady().then(run).catch(error => { console.error(error); exitCode = 1; }).finally(async () => {
  const actual = path.resolve(root);
  assert.ok(actual.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(actual).startsWith('local-publish-roots-'));
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  app.exit(exitCode);
});
