import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { app } from 'electron';
import unzipper from 'unzipper';

const root = await mkdtemp(path.join(tmpdir(), 'zending-video-publish-'));
await mkdir(path.join(root, 'user-data'));
app.setPath('userData', path.join(root, 'user-data'));
app.getAppPath = () => process.cwd();

async function run() {
  const { buildDigitalTwinSourcePackage } = await import('../../dist-electron/ipc/digitalTwinSourcePackage.js');
  const { buildDigitalTwinDistPackage } = await import('../../dist-electron/ipc/digitalTwinDistPackage.js');
  const { setCurrentProjectRoot } = await import('../../dist-electron/ipc/projectAssetStore.js');
  const content = await readFile('output/playwright/chart-marker-video/scene.json', 'utf8');
  const original = JSON.parse(content);
  const marker = Object.values(original.scene.entities).find(entity => entity.components.chartMarker?.contentType === 'video');
  assert.ok(marker, '先运行 smoke-chart-marker-video.mjs 生成真实场景');
  const projectRoot = path.join(root, 'project');
  const entrySceneFilePath = path.join(projectRoot, 'Scenes/main.scene.json');
  await mkdir(path.dirname(entrySceneFilePath), { recursive: true });
  await writeFile(entrySceneFilePath, content);
  setCurrentProjectRoot(projectRoot);
  const signal = new AbortController().signal;
  const source = await buildDigitalTwinSourcePackage({ projectRoot, sharedResourcesRoot: path.join(root, 'shared'),
    entrySceneFilePath, outputRoot: path.join(root, 'source-output'), signal,
    manifest: { projectId: '123', projectName: '视频立标', editorProjectId: null, baseVersionId: null, resourceRevision: '1' },
    isPlatformImageReference: () => false, findSyncedImageForReference: async () => null,
    skyboxCacheDependencies: { getSharedProjectSkyboxRoot: () => null } });
  const dist = await buildDigitalTwinDistPackage({ projectId: '123', publishName: '视频立标',
    sceneContent: source.entrySceneContent, sourceResourceFiles: source.resourceFiles,
    outputRoot: path.join(root, 'dist-output'), signal });
  for (const [filePath, entryPath] of [[source.filePath, 'Scenes/main.scene.json'], [dist.filePath, 'project/scene.json']]) {
    const archive = await unzipper.Open.file(filePath);
    const entry = archive.files.find(file => file.path.replaceAll('\\', '/') === entryPath);
    assert.ok(entry, entryPath);
    const scene = JSON.parse((await entry.buffer()).toString('utf8')).scene;
    assert.deepEqual(scene.entities[marker.id].components.chartMarker, marker.components.chartMarker);
    assert.deepEqual(scene.entities[marker.id].components.transform, marker.components.transform);
    assert.equal(archive.files.some(file => /\.(webm|mp4)$/i.test(file.path)), false, 'URL 引用不下载视频文件');
  }
  console.log('PASS: 真实 SOURCE/DIST ZIP 完整保留视频 URL、播放配置及立标变换，外链视频无需下载打包。');
  await writeFile('output/playwright/chart-marker-video/packages-result.json', JSON.stringify({
    ok: true, sourceBytes: source.fileSize, distBytes: dist.fileSize, markerId: marker.id,
    videoUrl: marker.components.chartMarker.videoUrl,
  }, null, 2));
}

async function finish(code) {
  const resolved = path.resolve(root);
  if (path.dirname(resolved) !== path.resolve(tmpdir()) || !path.basename(resolved).startsWith('zending-video-publish-')) throw Error('临时路径越界');
  await rm(resolved, { recursive: true, force: true });
  app.exit(code);
}
app.whenReady().then(run).then(() => finish(0), async error => { console.error(error); await finish(1); });
