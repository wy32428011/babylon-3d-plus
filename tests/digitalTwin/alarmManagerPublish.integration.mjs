import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { app } from 'electron';
import unzipper from 'unzipper';

const root = await mkdtemp(path.join(tmpdir(), 'zending-alarm-publish-'));
const userData = path.join(root, 'user-data');
await mkdir(userData);
app.setPath('userData', userData);

async function run() {
  const { importManualRoamAvatarIntoProject } = await import('../../dist-electron/ipc/manualRoamAvatarStore.js');
  const { setCurrentProjectRoot } = await import('../../dist-electron/ipc/projectAssetStore.js');
  const { prepareDeploymentExport } = await import('../../dist-electron/ipc/deploymentExportScene.js');
  const { buildDigitalTwinSourcePackage } = await import('../../dist-electron/ipc/digitalTwinSourcePackage.js');
  const projectRoot = path.join(root, 'project'); await mkdir(projectRoot); setCurrentProjectRoot(projectRoot);
  const fixture = path.resolve('public/manual-roam/EQ_People.glb');
  const device = await importManualRoamAvatarIntoProject(projectRoot, fixture);
  const fire = await importManualRoamAvatarIntoProject(projectRoot, fixture);
  const unused = await importManualRoamAvatarIntoProject(projectRoot, fixture);
  const target = asset => ({ kind: 'model', assetId: asset.id, displayName: asset.name, modelAsset: { sourcePath: asset.path, sourceUrl: asset.sourceUrl, lengthUnit: 'm', unitScaleToMeters: 1 } });
  const theme = { projectId: '42', screenId: '43', name: '火警大屏', screenUrl: 'https://example.com/screen/43' };
  const sceneFile = { version: 5, scene: { name: '报警发布', entityIds: ['device', 'alarm'], entities: {
    device: { id: 'device', components: { modelAsset: { ...target(device).modelAsset, assetCode: 'device-1' } } },
    alarm: { id: 'alarm', components: { alarmManager: { appearanceModel: target(fire), targets: [{ id: 'slot', model: target(device), entityId: 'device' }], theme } } },
  } } };
  const content = JSON.stringify(sceneFile);
  const deployment = await prepareDeploymentExport(content, '报警发布', [], new AbortController().signal, () => {});
  for (const asset of [device, fire]) assert.equal(deployment.assetFiles.filter(file => file.sourcePath === asset.path).length, 1);
  assert.equal(deployment.assetFiles.some(file => file.sourcePath === unused.path), false);
  const deployed = JSON.parse(deployment.sceneContent).scene.entities;
  assert.equal(deployed.alarm.components.alarmManager.targets[0].model.modelAsset.sourceUrl, deployed.device.components.modelAsset.sourceUrl);
  assert.notEqual(deployed.alarm.components.alarmManager.appearanceModel.modelAsset.sourcePath, fire.path);
  assert.deepEqual(deployed.alarm.components.alarmManager.theme, theme);
  assert.equal(deployment.sceneContent.includes(projectRoot.replaceAll('\\', '\\\\')), false);
  const scenePath = path.join(projectRoot, 'Scenes', 'main.scene.json');
  await mkdir(path.dirname(scenePath)); await writeFile(scenePath, content);
  const source = await buildDigitalTwinSourcePackage({
    projectRoot, sharedResourcesRoot: projectRoot, entrySceneFilePath: scenePath, outputRoot: path.join(root, 'source-output'),
    manifest: { projectId: '42', projectName: '报警发布', editorProjectId: null, baseVersionId: null, resourceRevision: '1' },
    signal: new AbortController().signal, isPlatformImageReference: () => false, findSyncedImageForReference: async () => null,
    skyboxCacheDependencies: { getSharedProjectSkyboxRoot: () => null },
  });
  const archive = await unzipper.Open.file(source.filePath);
  const names = archive.files.map(file => file.path.replaceAll('\\', '/'));
  for (const asset of [device, fire]) assert.ok(names.includes(path.relative(projectRoot, asset.path).replaceAll('\\', '/')));
  assert.ok(!names.includes(path.relative(projectRoot, unused.path).replaceAll('\\', '/')));
  const portable = JSON.parse((await archive.files.find(file => file.path === 'Scenes/main.scene.json').buffer()).toString()).scene.entities;
  assert.match(portable.alarm.components.alarmManager.appearanceModel.modelAsset.sourcePath, /^Assets\//);
  assert.equal(portable.alarm.components.alarmManager.targets[0].model.modelAsset.sourcePath, portable.device.components.modelAsset.sourcePath);
  assert.deepEqual(await readFile(device.path), await readFile(fixture));
  console.log('PASS: 报警模型与外观资源、Viewer 地址一致性、主题保留、SOURCE ZIP 及未引用资源排除。');
}

async function finish(code) {
  const resolved = path.resolve(root);
  if (path.dirname(resolved) !== path.resolve(tmpdir()) || !path.basename(resolved).startsWith('zending-alarm-publish-')) throw new Error('临时目录范围无效');
  await rm(resolved, { recursive: true, force: true });
  app.exit(code);
}
app.whenReady().then(run).then(() => finish(0), async error => { console.error(error); await finish(1); });
