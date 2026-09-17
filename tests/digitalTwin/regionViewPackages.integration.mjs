import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import electron from 'electron';

const require = createRequire(import.meta.url);
const { app } = electron;
const root = await mkdtemp(path.join(tmpdir(), 'region-view-packages-'));
app.setPath('userData', path.join(root, 'user-data'));
app.getAppPath = () => process.cwd();
const abortController = new AbortController();
async function cleanup() {
  const relative = path.relative(path.resolve(tmpdir()), path.resolve(root));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('拒绝清理临时目录之外的路径');
  await rm(root, { recursive: true, force: true });
}
const deadline = setTimeout(() => {
  console.error('区域视角双包验证超时'); abortController.abort();
  void cleanup().catch(console.error).finally(() => app.exit(1));
}, 120_000);
let code = 1;
async function run() {
try {
  console.log('开始验证 SOURCE 与 DIST 压缩包…');
  const { buildDigitalTwinSourcePackage } = await import('../../dist-electron/ipc/digitalTwinSourcePackage.js');
  const { buildDigitalTwinDistPackage } = await import('../../dist-electron/ipc/digitalTwinDistPackage.js');
  const unzipper = require('unzipper');
  const content = await readFile('output/region-views/scene.scene.json', 'utf8');
  const source = JSON.parse(content);
  const projectRoot = path.join(root, 'project');
  const entrySceneFilePath = path.join(projectRoot, 'Scenes', 'main.scene.json');
  await mkdir(path.dirname(entrySceneFilePath), { recursive: true });
  await writeFile(entrySceneFilePath, content);
  const second = structuredClone(source);
  second.scene.name = '另一场景';
  second.scene.sceneSettings.regionViews = [{ ...second.scene.sceneSettings.regionViews[0], id: 'other', name: '另一场景区域' }];
  await writeFile(path.join(projectRoot, 'Scenes', 'second.scene.json'), JSON.stringify(second));
  const signal = abortController.signal;
  const sourcePackage = await buildDigitalTwinSourcePackage({ projectRoot, sharedResourcesRoot: path.join(root, 'shared'),
    entrySceneFilePath, outputRoot: path.join(root, 'source-output'), signal,
    manifest: { projectId: '123', projectName: '区域视角验收', editorProjectId: null, baseVersionId: null, resourceRevision: '1' },
    isPlatformImageReference: () => false, findSyncedImageForReference: async () => null,
    skyboxCacheDependencies: { getSharedProjectSkyboxRoot: () => null } });
  const distPackage = await buildDigitalTwinDistPackage({ projectId: '123', publishName: '区域视角验收',
    sceneContent: sourcePackage.entrySceneContent, sourceResourceFiles: sourcePackage.resourceFiles,
    outputRoot: path.join(root, 'dist-output'), signal });
  const readEntry = async (archivePath, entryPath) => {
    const archive = await unzipper.Open.file(archivePath);
    const entry = archive.files.find(file => file.path.replace(/\\/g, '/') === entryPath);
    assert.ok(entry, entryPath);
    return JSON.parse((await entry.buffer()).toString('utf8'));
  };
  const packagedSource = await readEntry(sourcePackage.filePath, 'Scenes/main.scene.json');
  const packagedSecond = await readEntry(sourcePackage.filePath, 'Scenes/second.scene.json');
  const packagedDist = await readEntry(distPackage.filePath, 'project/scene.json');
  assert.deepEqual(packagedSource.scene.sceneSettings.regionViews, source.scene.sceneSettings.regionViews);
  assert.deepEqual(packagedSecond.scene.sceneSettings.regionViews, second.scene.sceneSettings.regionViews);
  assert.deepEqual(packagedDist.scene.sceneSettings.regionViews, source.scene.sceneSettings.regionViews);
  assert.equal(await readFile(entrySceneFilePath, 'utf8'), content);
  await writeFile('output/region-views/packages-result.json', JSON.stringify({ ok: true, sourceScenes: 2, entryViews: source.scene.sceneSettings.regionViews.length, distFiles: distPackage.fileCount }, null, 2));
  console.log('SOURCE 多场景 ZIP 与 DIST 实际 ZIP 的区域视角保留验证通过');
  code = 0;
} catch (error) { console.error(error); }
finally {
  clearTimeout(deadline);
  await cleanup();
  app.exit(code);
}
}
app.whenReady().then(run).catch(error => { console.error(error); app.exit(1); });
