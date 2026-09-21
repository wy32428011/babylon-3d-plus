import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, copyFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import electron from 'electron';

const require = createRequire(import.meta.url);
const { app } = electron;
const root = await mkdtemp(path.join(tmpdir(), 'environment-building-effect-packages-'));
app.setPath('userData', path.join(root, 'user-data'));
app.getAppPath = () => process.cwd();
const abortController = new AbortController();
async function cleanup() {
  const relative = path.relative(path.resolve(tmpdir()), path.resolve(root));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)
    || !path.basename(root).startsWith('environment-building-effect-packages-')) throw new Error('拒绝清理测试临时目录之外的路径');
  await rm(root, { recursive: true, force: true });
}
const deadline = setTimeout(() => {
  console.error('环境建筑特效双包验证超时');
  abortController.abort();
  void cleanup().catch(console.error).finally(() => app.exit(1));
}, 120_000);

function effects(document) {
  return Object.values(document.scene.entities)
    .filter(entity => entity.components.poiEffect?.visual)
    .map(entity => ({ id: entity.id, name: entity.name, transform: entity.components.transform, effect: entity.components.poiEffect }));
}

async function run() {
  let code = 1;
  try {
    const { buildDigitalTwinSourcePackage } = await import('../../dist-electron/ipc/digitalTwinSourcePackage.js');
    const { buildDigitalTwinDistPackage } = await import('../../dist-electron/ipc/digitalTwinDistPackage.js');
    const unzipper = require('unzipper');
    const { authorizeAssetFile } = await import('../../dist-electron/ipc/assetRegistry.js');
    let content = await readFile('output/environment-building-effect/scene.scene.json', 'utf8');
    const source = JSON.parse(content);

    assert.equal(effects(source).length, 1, '先运行环境建筑特效 WebGL 烟测生成场景');
    const projectRoot = path.join(root, 'project');
    // 按真实本地项目组织资源，SOURCE 快照和 DIST 校验共同引用项目内 GLB。
    const projectAsset = path.join(projectRoot, 'Assets', 'Environments', 'factory.glb');
    await mkdir(path.dirname(projectAsset), { recursive: true });
    await copyFile(source.scene.sceneSettings.environment.variants[0].sourcePath, projectAsset);
    const assetUrl = 'editor-asset://local/' + encodeURIComponent(projectAsset);
    source.scene.sceneSettings.environment.packagePath = projectAsset;
    source.scene.sceneSettings.environment.activeVariantUrl = assetUrl;
    source.scene.sceneSettings.environment.variants = [{name:'默认环境',sourcePath:projectAsset,sourceUrl:assetUrl}];
    content = JSON.stringify(source);
    authorizeAssetFile(projectAsset);
    const entrySceneFilePath = path.join(projectRoot, 'Scenes', 'main.scene.json');
    await mkdir(path.dirname(entrySceneFilePath), { recursive: true });
    await writeFile(entrySceneFilePath, content);
    const second = structuredClone(source);
    second.scene.name = '静止环境特效';
    const secondEffect = Object.values(second.scene.entities).find(entity => entity.components.poiEffect?.visual);
    secondEffect.components.poiEffect.speed = 0;
    secondEffect.components.poiEffect.visual.opacity = 0;
    secondEffect.components.poiEffect.primaryColor = '#3366ff';
    await writeFile(path.join(projectRoot, 'Scenes', 'second.scene.json'), JSON.stringify(second));
    const signal = abortController.signal;
    const sourcePackage = await buildDigitalTwinSourcePackage({
      projectRoot, sharedResourcesRoot: path.join(root, 'shared'), entrySceneFilePath,
      outputRoot: path.join(root, 'source-output'), signal,
      manifest: { projectId: '123', projectName: '环境建筑特效验收', editorProjectId: null, baseVersionId: null, resourceRevision: '1' },
      isPlatformImageReference: () => false, findSyncedImageForReference: async () => null,
      skyboxCacheDependencies: { getSharedProjectSkyboxRoot: () => null },
    });
    const distPackage = await buildDigitalTwinDistPackage({
      projectId: '123', publishName: '环境建筑特效验收', sceneContent: sourcePackage.entrySceneContent,
      sourceResourceFiles: sourcePackage.resourceFiles, outputRoot: path.join(root, 'dist-output'), signal,
    });
    const readEntry = async (archivePath, entryPath) => {
      const archive = await unzipper.Open.file(archivePath);
      const entry = archive.files.find(file => file.path.replace(/\\/g, '/') === entryPath);
      assert.ok(entry, entryPath);
      return JSON.parse((await entry.buffer()).toString('utf8'));
    };
    const packagedSource = await readEntry(sourcePackage.filePath, 'Scenes/main.scene.json');
    const packagedSecond = await readEntry(sourcePackage.filePath, 'Scenes/second.scene.json');
    const packagedDist = await readEntry(distPackage.filePath, 'project/scene.json');
    assert.deepEqual(effects(packagedSource), effects(source));
    assert.deepEqual(effects(packagedSecond), effects(second));
    assert.deepEqual(effects(packagedDist), effects(source));
    assert.equal(effects(packagedDist)[0].effect.visual.targetEntityId,'__scene_environment_model__');
    assert.ok(packagedDist.scene.sceneSettings.environment);
    const distEntries = await unzipper.Open.file(distPackage.filePath);
    assert.ok(distEntries.files.some(file=>file.path.endsWith('.glb')), 'DIST包含实际环境GLB');
    assert.ok(distPackage.fileCount>0);
    assert.equal(await readFile(entrySceneFilePath, 'utf8'), content, '打包不能修改原场景');
    const viewerRoot = path.resolve('output/environment-building-effect/viewer');
    const distArchive = await unzipper.Open.file(distPackage.filePath);
    for (const entry of distArchive.files) {
      const destination = path.resolve(viewerRoot, entry.path);
      const relative = path.relative(viewerRoot, destination);
      assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'DIST 条目必须位于验收目录内');
      if (entry.type === 'Directory') await mkdir(destination, { recursive: true });
      else {
        await mkdir(path.dirname(destination), { recursive: true });
        await pipeline(entry.stream(), createWriteStream(destination));
      }
    }
    await writeFile('output/environment-building-effect/packages-result.json', JSON.stringify({
      ok: true, sourceScenes: 2, entryEffects: effects(source).length, contourPoints: effects(source)[0].effect.visual.points.length,
      distFiles: distPackage.fileCount, viewerRoot,
      checks: ['source-entry', 'source-second-zero-values', 'dist-entry', 'source-not-mutated'],
    }, null, 2));
    console.log('SOURCE 双场景 ZIP 与 DIST 实际 ZIP：环境模型特效参数、目标引用、路径、数据和 Transform 保留验证通过');
    code = 0;
  } catch (error) {
    console.error(error);
  } finally {
    clearTimeout(deadline);
    await cleanup();
    app.exit(code);
  }
}
app.whenReady().then(run).catch(error => { console.error(error); app.exit(1); });
