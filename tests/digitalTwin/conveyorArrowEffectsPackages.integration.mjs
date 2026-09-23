import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import electron from 'electron';

const require = createRequire(import.meta.url);
const { app } = electron;
const root = await mkdtemp(path.join(tmpdir(), 'conveyor-arrow-effects-packages-'));
app.setPath('userData', path.join(root, 'user-data'));
app.getAppPath = () => process.cwd();
const abortController = new AbortController();
async function cleanup() {
  const relative = path.relative(path.resolve(tmpdir()), path.resolve(root));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)
    || !path.basename(root).startsWith('conveyor-arrow-effects-packages-')) throw new Error('拒绝清理测试临时目录之外的路径');
  await rm(root, { recursive: true, force: true });
}
const deadline = setTimeout(() => {
  console.error('六款箭头 SOURCE/DIST 双包验证超时');
  abortController.abort();
  void cleanup().catch(console.error).finally(() => app.exit(1));
}, 120000);
const effects = document => Object.values(document.scene.entities)
  .filter(entity => entity.components.poiEffect?.effectKind.startsWith('conveyor-arrow-'))
  .map(entity => ({ id: entity.id, name: entity.name, transform: entity.components.transform, effect: entity.components.poiEffect }));

async function run() {
  let code = 1;
  try {
    const { buildDigitalTwinSourcePackage } = await import('../../dist-electron/ipc/digitalTwinSourcePackage.js');
    const { buildDigitalTwinDistPackage } = await import('../../dist-electron/ipc/digitalTwinDistPackage.js');
    const unzipper = require('unzipper');
    const content = await readFile('output/conveyor-arrow-effects/scene.scene.json', 'utf8');
    const source = JSON.parse(content);
    assert.equal(effects(source).length, 6, '先运行 smoke-conveyor-arrow-effects.mjs 生成六款箭头场景');
    assert.equal(new Set(effects(source).map(entity => entity.effect.effectKind)).size, 6);
    const projectRoot = path.join(root, 'project');
    const entrySceneFilePath = path.join(projectRoot, 'Scenes', 'main.scene.json');
    await mkdir(path.dirname(entrySceneFilePath), { recursive: true });
    await writeFile(entrySceneFilePath, content);
    const second = structuredClone(source);
    second.scene.name = '六款箭头零速度与零不透明度';
    for (const entity of Object.values(second.scene.entities)) {
      if (!entity.components.poiEffect?.effectKind.startsWith('conveyor-arrow-')) continue;
      entity.components.poiEffect.speed = 0;
      entity.components.poiEffect.conveyorArrow.opacity = 0;
      entity.components.poiEffect.conveyorArrow.reverse = true;
    }
    await writeFile(path.join(projectRoot, 'Scenes', 'second.scene.json'), JSON.stringify(second));
    const signal = abortController.signal;
    const sourcePackage = await buildDigitalTwinSourcePackage({
      projectRoot, sharedResourcesRoot: path.join(root, 'shared'), entrySceneFilePath,
      outputRoot: path.join(root, 'source-output'), signal,
      manifest: { projectId: '123', projectName: '输送方向箭头六款验收', editorProjectId: null, baseVersionId: null, resourceRevision: '1' },
      isPlatformImageReference: () => false, findSyncedImageForReference: async () => null,
      skyboxCacheDependencies: { getSharedProjectSkyboxRoot: () => null },
    });
    const distPackage = await buildDigitalTwinDistPackage({
      projectId: '123', publishName: '输送方向箭头六款验收', sceneContent: sourcePackage.entrySceneContent,
      sourceResourceFiles: sourcePackage.resourceFiles, outputRoot: path.join(root, 'dist-output'), signal,
    });
    const readEntry = async (archivePath, entryPath) => {
      const archive = await unzipper.Open.file(archivePath);
      const entry = archive.files.find(file => file.path.replace(/\\/g, '/') === entryPath);
      assert.ok(entry, entryPath);
      return JSON.parse((await entry.buffer()).toString('utf8'));
    };
    const packagedSecond = await readEntry(sourcePackage.filePath, 'Scenes/second.scene.json');
    assert.deepEqual(effects(await readEntry(sourcePackage.filePath, 'Scenes/main.scene.json')), effects(source));
    assert.deepEqual(effects(packagedSecond), effects(second));
    assert.deepEqual(effects(await readEntry(distPackage.filePath, 'project/scene.json')), effects(source));
    const zeroValuesDistPackage = await buildDigitalTwinDistPackage({
      projectId: '123', publishName: '六款箭头零值验收', sceneContent: JSON.stringify(packagedSecond),
      sourceResourceFiles: sourcePackage.resourceFiles, outputRoot: path.join(root, 'dist-zero-output'), signal,
    });
    assert.deepEqual(effects(await readEntry(zeroValuesDistPackage.filePath, 'project/scene.json')), effects(second));
    assert.equal(await readFile(entrySceneFilePath, 'utf8'), content, '打包不能修改原场景');
    // 每次独立解包，防止上次构建遗留的哈希文件被 Viewer 验收误用。
    const viewerRoot = await mkdtemp(path.resolve('output/conveyor-arrow-effects/viewer-'));
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
    await writeFile('output/conveyor-arrow-effects/packages-result.json', JSON.stringify({
      ok: true, sourceScenes: 2, entryEffects: effects(source).length, kinds: effects(source).map(entity => entity.effect.effectKind),
      distFiles: distPackage.fileCount, viewerRoot,
      checks: ['source-entry', 'source-second-zero-values-reverse', 'dist-entry', 'dist-second-zero-values-reverse', 'source-not-mutated'],
    }, null, 2));
    console.log('PASS: SOURCE 双场景 ZIP 与 DIST 实际 ZIP 保留六款箭头类型、外观、尺寸、数量、反向、零值与 Transform。');
    code = 0;
  } catch (error) { console.error(error); }
  finally { clearTimeout(deadline); await cleanup(); app.exit(code); }
}
app.whenReady().then(run).catch(error => { console.error(error); app.exit(1); });
