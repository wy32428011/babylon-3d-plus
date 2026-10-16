import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { app, BrowserWindow, dialog } from 'electron';
import unzipper from 'unzipper';

const root = await mkdtemp(path.join(tmpdir(), 'zending-roam-avatar-'));
const userData = path.join(root, 'user-data');
await mkdir(userData);
app.setPath('userData', userData);

function inspectAdaptedGlb(bytes) {
  const jsonLength = bytes.readUInt32LE(12);
  const json = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString().trimEnd());
  const metadata = json.nodes.find(node => node.extras?.manualRoamHumanoid)?.extras.manualRoamHumanoid;
  assert.equal(metadata?.motionProfile, 'mixamo-humanoid-v2');
  assert.equal(Object.keys(metadata.joints).length, 22);
  return { metadata, tail: bytes.subarray(20 + jsonLength) };
}

async function run() {
  const { importManualRoamAvatarIntoProject } = await import('../../dist-electron/ipc/manualRoamAvatarStore.js');
  const { setCurrentProjectRoot, listProjectAssets } = await import('../../dist-electron/ipc/projectAssetStore.js');
  const { prepareDeploymentExport } = await import('../../dist-electron/ipc/deploymentExportScene.js');
  const { buildDigitalTwinSourcePackage } = await import('../../dist-electron/ipc/digitalTwinSourcePackage.js');
  const { registerAssetIpc } = await import('../../dist-electron/ipc/assetIpc.js');
  const projectRoot = path.join(root, 'project');
  await mkdir(projectRoot);
  setCurrentProjectRoot(projectRoot);
  const fixture = path.resolve('scripts/manual-roam-assets/sources/Xbot.glb');
  const originalBytes = await readFile(fixture);
  const originalHash = createHash('sha256').update(originalBytes).digest('hex');
  const first = await importManualRoamAvatarIntoProject(projectRoot, fixture);
  const second = await importManualRoamAvatarIntoProject(projectRoot, fixture);
  assert.notEqual(first.path, second.path, '同名人物不得覆盖已引用文件');
  const adaptedBytes = await readFile(first.path);
  const adapted = inspectAdaptedGlb(adaptedBytes);
  assert.equal(adapted.metadata.sourceHash, originalHash);
  assert.deepEqual(adapted.tail, originalBytes.subarray(20 + originalBytes.readUInt32LE(12)), '上传完整保留原蒙皮、纹理和动作二进制');
  assert.deepEqual(await readFile(fixture), originalBytes, '原始人物文件保持不变');
  assert.deepEqual(await readFile(second.path), adaptedBytes, '同一人物重复上传生成确定的适配结果');
  assert.equal((await listProjectAssets()).assets.length, 2);

  const broken = path.join(root, 'broken.glb');
  await writeFile(broken, 'not a GLB');
  await assert.rejects(importManualRoamAvatarIntoProject(projectRoot, broken), /人物模型校验失败/);
  assert.equal((await readdir(path.join(projectRoot, 'Assets', 'Models'))).length, 2);
  // 容器结构合法但引用外部纹理的 GLB 必须拒绝，防止上传后丢贴图。
  const json = Buffer.from(JSON.stringify({ asset: { version: '2.0' }, meshes: [{ primitives: [{}] }], images: [{ uri: '../texture.png' }] }));
  const padded = Buffer.concat([json, Buffer.alloc((4 - json.length % 4) % 4, 32)]);
  const glb = Buffer.alloc(20 + padded.length);
  glb.write('glTF'); glb.writeUInt32LE(2, 4); glb.writeUInt32LE(glb.length, 8);
  glb.writeUInt32LE(padded.length, 12); glb.write('JSON', 16); padded.copy(glb, 20);
  await writeFile(broken, glb);
  await assert.rejects(importManualRoamAvatarIntoProject(projectRoot, broken), /外部资源/);

  const avatar = { name: first.name, sourcePath: first.path, sourceUrl: first.sourceUrl };
  const scene = { version: 3, scene: { name: '人物导出', entityIds: ['spawn'], entities: {
    spawn: { id: 'spawn', name: '手动漫游', components: { manualRoamSpawn: { avatar } } },
  } } };
  const content = JSON.stringify(scene);
  const deployment = await prepareDeploymentExport(content, '人物导出', [], new AbortController().signal, () => {});
  assert.equal(deployment.assetFiles.filter((file) => file.sourcePath === first.path).length, 1);
  assert.equal(deployment.assetFiles.some((file) => file.sourcePath === second.path), false);
  const deployedFile = deployment.assetFiles.find(file => file.sourcePath === first.path);
  assert.deepEqual(await readFile(deployedFile.sourcePath), adaptedBytes, 'Viewer 收集派生人物及其完整适配数据');
  const deployedAvatar = JSON.parse(deployment.sceneContent).scene.entities.spawn.components.manualRoamSpawn.avatar;
  assert.match(deployedAvatar.sourceUrl, /^editor-asset:\/\/local\//);
  assert.notEqual(deployedAvatar.sourcePath, first.path);
  assert.equal(deployment.sceneContent.includes(projectRoot.replaceAll('\\', '\\\\')), false);
  const scenePath = path.join(projectRoot, 'Scenes', 'main.scene.json');
  await mkdir(path.dirname(scenePath));
  await writeFile(scenePath, content);
  const source = await buildDigitalTwinSourcePackage({
    projectRoot, sharedResourcesRoot: projectRoot, entrySceneFilePath: scenePath,
    outputRoot: path.join(root, 'source-output'),
    manifest: { projectId: '42', projectName: '人物导出', editorProjectId: null, baseVersionId: null, resourceRevision: '1' },
    signal: new AbortController().signal, isPlatformImageReference: () => false,
    findSyncedImageForReference: async () => null,
    skyboxCacheDependencies: { getSharedProjectSkyboxRoot: () => null },
  });
  const archive = await unzipper.Open.file(source.filePath);
  const names = archive.files.map((file) => file.path.replaceAll('\\', '/'));
  assert.ok(names.includes(path.relative(projectRoot, first.path).replaceAll('\\', '/')));
  assert.ok(!names.includes(path.relative(projectRoot, second.path).replaceAll('\\', '/')));
  const avatarEntry = archive.files.find(file => file.path.replaceAll('\\', '/') === path.relative(projectRoot, first.path).replaceAll('\\', '/'));
  const packagedBytes = await avatarEntry.buffer();
  assert.deepEqual(packagedBytes, adaptedBytes, 'SOURCE ZIP 包含已确认的派生人物，重新打开不依赖源文件');
  assert.equal(inspectAdaptedGlb(packagedBytes).metadata.sourceHash, originalHash);
  const sceneEntry = archive.files.find((file) => file.path.replaceAll('\\', '/') === 'Scenes/main.scene.json');
  const portableAvatar = JSON.parse((await sceneEntry.buffer()).toString()).scene.entities.spawn.components.manualRoamSpawn.avatar;
  assert.match(portableAvatar.sourcePath, /^Assets\/Models\/RoamAvatar-/);
  registerAssetIpc();
  const originalDialog = dialog.showOpenDialog;
  const window = new BrowserWindow({ show: false, webPreferences: {
    preload: path.resolve('dist-electron/preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false,
  } });
  try {
    await window.loadURL('data:text/html,<html><body>avatar preload integration</body></html>');
    dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
    const canceled = await window.webContents.executeJavaScript('window.editorApi.importManualRoamAvatar()');
    assert.equal(canceled.canceled, true);
    assert.equal(canceled.importedAsset, null);
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [fixture] });
    const imported = await window.webContents.executeJavaScript('window.editorApi.importManualRoamAvatar()');
    assert.equal(imported.canceled, false);
    assert.deepEqual(await readFile(imported.importedAsset.path), adaptedBytes);
  } finally {
    window.destroy();
    dialog.showOpenDialog = originalDialog;
  }
  console.log('PASS: 普通 Mixamo 人物自动适配、源文件/蒙皮保留、同名隔离、损坏/外部资源拒绝、项目索引、Viewer 派生资源改写、SOURCE ZIP 适配数据保留、sandbox preload 上传及取消。');
}

app.whenReady().then(run).then(async () => {
  await rm(root, { recursive: true, force: true });
  app.exit(0);
}, async (error) => {
  console.error(error);
  await rm(root, { recursive: true, force: true });
  app.exit(1);
});
