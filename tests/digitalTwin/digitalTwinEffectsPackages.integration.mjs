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
const root = await mkdtemp(path.join(tmpdir(), 'digital-twin-effects-packages-'));
app.setPath('userData', path.join(root, 'user-data'));
app.getAppPath = () => process.cwd();
const abortController = new AbortController();
async function cleanup() {
  const relative = path.relative(path.resolve(tmpdir()), path.resolve(root));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)
    || !path.basename(root).startsWith('digital-twin-effects-packages-')) throw new Error('拒绝清理测试临时目录之外的路径');
  await rm(root, { recursive: true, force: true });
}
const deadline = setTimeout(() => {
  console.error('数字孪生特效双包验证超时');
  abortController.abort();
  void cleanup().catch(console.error).finally(() => app.exit(1));
}, 120_000);

function walls(document) {
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
    let content = await readFile('output/digital-twin-effects/scene.scene.json', 'utf8');
    const source = JSON.parse(content);
    // 保留全部类型进行双包协议核对，选择代表性效果供实际 Viewer 可视回归。
    for (const entity of Object.values(source.scene.entities)) {
      const effect = entity.components.poiEffect;
      if (!effect?.visual) continue;
      effect.enabled = ['model-scan', 'flow-path', 'energy-dome'].includes(effect.effectKind);
      effect.speed = 1; effect.visual.opacity = 0.65; effect.visual.progress = 1; effect.visual.loop = true;
      effect.visual.targetEntityId = effect.effectKind === 'model-scan' ? 'demo-building' : null;
      entity.components.transform.position = {x:0,y:0,z:0};
    }
    source.scene.entities['demo-building'] = {
      id:'demo-building',name:'发布验收建筑',isFolder:false,visible:true,locked:false,parentId:null,childrenIds:[],
      components:{transform:{position:{x:0,y:3,z:0},rotation:{x:0,y:0,z:0},scale:{x:6,y:6,z:4}},meshRenderer:{meshKind:'cube',materialColor:'#405469'}}
    };
    source.scene.entityIds.push('demo-building');
    content = JSON.stringify(source);
    assert.equal(walls(source).length, 37, '先运行编辑器集成测试生成围栏场景');
    const projectRoot = path.join(root, 'project');
    const entrySceneFilePath = path.join(projectRoot, 'Scenes', 'main.scene.json');
    await mkdir(path.dirname(entrySceneFilePath), { recursive: true });
    await writeFile(entrySceneFilePath, content);
    const second = structuredClone(source);
    second.scene.name = '零透明度静止围栏';
    const secondWall = Object.values(second.scene.entities).find(entity => entity.components.poiEffect?.visual);
    secondWall.components.poiEffect.speed = 0;
    secondWall.components.poiEffect.visual.opacity = 0;
    secondWall.components.poiEffect.primaryColor = '#3366ff';
    await writeFile(path.join(projectRoot, 'Scenes', 'second.scene.json'), JSON.stringify(second));
    const signal = abortController.signal;
    const sourcePackage = await buildDigitalTwinSourcePackage({
      projectRoot, sharedResourcesRoot: path.join(root, 'shared'), entrySceneFilePath,
      outputRoot: path.join(root, 'source-output'), signal,
      manifest: { projectId: '123', projectName: '数字孪生特效验收', editorProjectId: null, baseVersionId: null, resourceRevision: '1' },
      isPlatformImageReference: () => false, findSyncedImageForReference: async () => null,
      skyboxCacheDependencies: { getSharedProjectSkyboxRoot: () => null },
    });
    const distPackage = await buildDigitalTwinDistPackage({
      projectId: '123', publishName: '数字孪生特效验收', sceneContent: sourcePackage.entrySceneContent,
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
    assert.deepEqual(walls(packagedSource), walls(source));
    assert.deepEqual(walls(packagedSecond), walls(second));
    assert.deepEqual(walls(packagedDist), walls(source));
    assert.equal(await readFile(entrySceneFilePath, 'utf8'), content, '打包不能修改原场景');
    const viewerRoot = path.resolve('output/digital-twin-effects/viewer');
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
    await writeFile('output/digital-twin-effects/packages-result.json', JSON.stringify({
      ok: true, sourceScenes: 2, entryWalls: walls(source).length, contourPoints: walls(source)[0].effect.visual.points.length,
      distFiles: distPackage.fileCount, viewerRoot,
      checks: ['source-entry', 'source-second-zero-values', 'dist-entry', 'source-not-mutated'],
    }, null, 2));
    console.log('SOURCE 双场景 ZIP 与 DIST 实际 ZIP：37 类特效参数、目标引用、路径、数据和 Transform 保留验证通过');
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
