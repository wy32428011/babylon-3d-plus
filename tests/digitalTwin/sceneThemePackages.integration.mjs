import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import electron from 'electron';

const require = createRequire(import.meta.url);
const { app } = electron;
const root = await mkdtemp(path.resolve('node_modules/.scene-theme-packages-'));
app.setPath('userData', path.join(root, 'user-data'));
app.getAppPath = () => process.cwd();
const abortController = new AbortController();
let cleanupPromise;
function cleanup() {
  cleanupPromise ??= (async () => {
    if (path.dirname(root) !== path.resolve('node_modules')
      || !path.basename(root).startsWith('.scene-theme-packages-')) throw new Error('拒绝清理测试临时目录之外的路径');
    await rm(root, { recursive: true, force: true });
  })();
  return cleanupPromise;
}
const deadline = setTimeout(() => {
  console.error('场景主题 SOURCE/DIST 双包验证超时');
  abortController.abort();
  void cleanup().catch(console.error).finally(() => app.exit(1));
}, 120_000);

function lightSnapshot(scene) {
  return Object.values(scene.entities)
    .filter(entity => entity.components.light)
    .map(entity => ({ id: entity.id, transform: entity.components.transform, light: entity.components.light }));
}

async function loadSceneModules() {
  // 仅构建本测试私有模块，不改写共享 dist 或 Viewer 构建产物。
  const entry = path.join(root, 'entry.mjs');
  await writeFile(entry, [
    "export { createEmptySceneDocument, createMeshEntity, createLightEntity } from '../../src/editor/model/SceneDocument.ts';",
    "export { serializeScene, deserializeScene } from '../../src/editor/project/SceneSerializer.ts';",
    "export { createTechBlueNightTheme, TECH_BLUE_NIGHT_SHADOWS } from '../../src/editor/model/sceneTheme.ts';",
    "export { WARM_WORK_LIGHT_SETTINGS } from '../../src/editor/model/lightSettings.ts';",
  ].join('\n'));
  const { build } = await import('vite');
  await build({
    configFile: false, publicDir: false, logLevel: 'silent',
    build: {
      ssr: entry, outDir: path.join(root, 'modules'),
      rolldownOptions: { output: { entryFileNames: 'scene-modules.mjs' } },
    },
  });
  return import(pathToFileURL(path.join(root, 'modules/scene-modules.mjs')).href);
}

async function run() {
  let code = 1;
  try {
    for (const dependency of ['dist-electron/ipc/digitalTwinSourcePackage.js', 'dist-electron/ipc/digitalTwinDistPackage.js', 'dist-viewer-template/index.html']) {
      try { await access(dependency); }
      catch { throw new Error('缺少构建产物 ' + dependency + '，请先运行 npm run build:electron 和 npm run build:viewer。'); }
    }
    const { buildDigitalTwinSourcePackage } = await import('../../dist-electron/ipc/digitalTwinSourcePackage.js');
    const { buildDigitalTwinDistPackage } = await import('../../dist-electron/ipc/digitalTwinDistPackage.js');
    const {
      createEmptySceneDocument, createMeshEntity, createLightEntity, serializeScene, deserializeScene,
      createTechBlueNightTheme, TECH_BLUE_NIGHT_SHADOWS, WARM_WORK_LIGHT_SETTINGS,
    } = await loadSceneModules();
    const scene = createEmptySceneDocument('科技蓝夜景双包验收');
    scene.sceneSettings.theme = { ...createTechBlueNightTheme(), exposure: 1.27, fogStart: 125, fogEnd: 820, backgroundColor: '#0a1731' };
    scene.sceneSettings.shadows = { ...scene.sceneSettings.shadows, ...TECH_BLUE_NIGHT_SHADOWS };
    const building = createMeshEntity('cube', { x: 0, y: 3, z: 0 });
    building.components.transform.scale = { x: 12, y: 6, z: 9 };
    const warmLight = createLightEntity('point', { x: 4, y: 5, z: -6 });
    warmLight.components.light = { ...WARM_WORK_LIGHT_SETTINGS, range: 24 };
    const hemiLight = createLightEntity('hemispheric');
    hemiLight.components.light = { ...hemiLight.components.light, color: '#829ec7', groundColor: '#293b55', nightBehavior: 'dim' };
    const oldLight = createLightEntity('directional');
    for (const entity of [building, warmLight, hemiLight, oldLight]) {
      scene.entityIds.push(entity.id);
      scene.entities[entity.id] = entity;
    }
    const second = structuredClone(scene);
    second.name = '自定义夜景零值快照';
    second.sceneSettings.theme = {
      ...second.sceneSettings.theme, exposure: 1.62, environmentIntensity: 0, glowIntensity: 0,
      bloomEnabled: true, bloomWeight: 0, fogEnabled: false, skyboxVisible: true, environmentLighting: 'original',
    };
    second.entities[warmLight.id].components.light = { ...WARM_WORK_LIGHT_SETTINGS, color: '#ffe4bd', range: 9 };
    const legacy = createEmptySceneDocument('没有主题的旧场景');
    delete legacy.sceneSettings.theme;
    legacy.entityIds = [oldLight.id];
    legacy.entities = { [oldLight.id]: structuredClone(oldLight) };

    const projectRoot = path.join(root, 'project');
    const scenesRoot = path.join(projectRoot, 'Scenes');
    await mkdir(scenesRoot, { recursive: true });
    const fixtures = [
      { name: 'main.scene.json', scene, content: serializeScene(scene) },
      { name: 'second.scene.json', scene: second, content: serializeScene(second) },
      { name: 'legacy.scene.json', scene: legacy, content: serializeScene(legacy) },
    ];
    for (const fixture of fixtures) await writeFile(path.join(scenesRoot, fixture.name), fixture.content);
    const sourcePackage = await buildDigitalTwinSourcePackage({
      projectRoot, sharedResourcesRoot: path.join(root, 'shared'), entrySceneFilePath: path.join(scenesRoot, 'main.scene.json'),
      outputRoot: path.join(root, 'source-output'), signal: abortController.signal,
      manifest: { projectId: '123', projectName: '科技蓝夜景验收', editorProjectId: null, baseVersionId: null, resourceRevision: '1' },
      isPlatformImageReference: () => false, findSyncedImageForReference: async () => null,
      skyboxCacheDependencies: { getSharedProjectSkyboxRoot: () => null },
    });
    assert.equal(sourcePackage.sceneCount, 3);
    const distPackage = await buildDigitalTwinDistPackage({
      projectId: '123', publishName: '科技蓝夜景验收', sceneContent: sourcePackage.entrySceneContent,
      sourceResourceFiles: sourcePackage.resourceFiles, outputRoot: path.join(root, 'dist-output'), signal: abortController.signal,
    });
    const unzipper = require('unzipper');
    const sourceArchive = await unzipper.Open.file(sourcePackage.filePath);
    const distArchive = await unzipper.Open.file(distPackage.filePath);
    const readEntry = async (archive, name) => {
      const entry = archive.files.find(file => file.path.replace(/\\/g, '/') === name);
      assert.ok(entry, 'ZIP 应包含 ' + name);
      return (await entry.buffer()).toString('utf8');
    };
    for (const fixture of fixtures) {
      const content = await readEntry(sourceArchive, 'Scenes/' + fixture.name);
      const packaged = JSON.parse(content).scene;
      assert.deepEqual(packaged.sceneSettings.theme ?? null, fixture.scene.sceneSettings.theme ?? null, fixture.name + ' SOURCE 主题快照');
      assert.deepEqual(lightSnapshot(packaged), lightSnapshot(fixture.scene), fixture.name + ' SOURCE 灯光参数');
      const reopened = deserializeScene(content);
      assert.deepEqual(reopened.sceneSettings.theme ?? null, fixture.scene.sceneSettings.theme ?? null, fixture.name + ' SOURCE 重开主题');
      assert.deepEqual(lightSnapshot(reopened), lightSnapshot(fixture.scene), fixture.name + ' SOURCE 重开灯光');
      assert.equal(await readFile(path.join(scenesRoot, fixture.name), 'utf8'), fixture.content, '打包不能修改原场景');
    }
    const distContent = await readEntry(distArchive, 'project/scene.json');
    const packagedDist = JSON.parse(distContent).scene;
    assert.deepEqual(packagedDist.sceneSettings.theme, scene.sceneSettings.theme, 'DIST 保留实际主题快照');
    assert.deepEqual(packagedDist.sceneSettings.shadows, scene.sceneSettings.shadows, 'DIST 保留主光和阴影参数');
    assert.deepEqual(lightSnapshot(packagedDist), lightSnapshot(scene), 'DIST 保留扩展灯光字段及旧字段缺省状态');
    assert.deepEqual(deserializeScene(distContent).sceneSettings.theme, scene.sceneSettings.theme, 'DIST JSON 可由同一解析器读取');
    assert.ok(distArchive.files.some(file => file.path === 'index.html'), 'DIST 包含真实 Viewer 入口');
    assert.ok(distArchive.files.some(file => /\.js$/.test(file.path)), 'DIST 包含真实 Viewer 脚本');
    assert.ok(distPackage.fileCount > 0);
    const outputRoot = path.resolve('output/scene-theme');
    await mkdir(outputRoot, { recursive: true });
    const viewerRoot = path.join(outputRoot, 'viewer-' + Date.now());
    await distArchive.extract({ path: viewerRoot });
    await writeFile(path.join(outputRoot, 'packages-result.json'), JSON.stringify({
      ok: true, viewerRoot, sourceScenes: fixtures.length, lightCount: lightSnapshot(scene).length,
      distFiles: distPackage.fileCount, sourceBytes: sourcePackage.fileSize, distBytes: distPackage.fileSize,
      checks: ['source-main-theme-snapshot', 'source-second-zero-values', 'source-legacy-theme-absent',
        'source-reopen', 'dist-theme-and-light-fields', 'dist-viewer-entry', 'source-not-mutated'],
    }, null, 2));
    console.log('科技蓝夜景 SOURCE 三场景与 DIST 实际 ZIP：主题快照、零值、旧场景、扩展灯光和 SOURCE 重开验证通过');
    code = 0;
  } catch (error) {
    console.error(error);
  } finally {
    clearTimeout(deadline);
    try { await cleanup(); }
    catch (error) { console.error(error); code = 1; }
    app.exit(code);
  }
}
app.whenReady().then(run).catch(error => {
  console.error(error);
  clearTimeout(deadline);
  void cleanup().catch(console.error).finally(() => app.exit(1));
});
