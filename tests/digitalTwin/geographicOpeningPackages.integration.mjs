import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import electron from 'electron';

const require = createRequire(import.meta.url);
const { app } = electron;
const root = await mkdtemp(path.resolve('node_modules/.geographic-opening-packages-'));
app.setPath('userData', path.join(root, 'user-data'));
app.getAppPath = () => process.cwd();
const abortController = new AbortController();
let cleanupPromise;
function cleanup() {
  cleanupPromise ??= (async () => {
    if (path.dirname(root) !== path.resolve('node_modules')
      || !path.basename(root).startsWith('.geographic-opening-packages-')) throw new Error('拒绝清理测试临时目录之外的路径');
    await rm(root, { recursive: true, force: true });
  })();
  return cleanupPromise;
}
const deadline = setTimeout(() => {
  console.error('地理开场 SOURCE/DIST 双包验证超时');
  abortController.abort();
  void cleanup().catch(console.error).finally(() => app.exit(1));
}, 180_000);

async function loadSceneModules() {
  // 私有 SSR 模块仅供生成夹具与重新解析，不改写共享构建目录。
  const entry = path.join(root, 'entry.mjs');
  await writeFile(entry, [
    "export { createEmptySceneDocument, createMeshEntity } from '../../src/editor/model/SceneDocument.ts';",
    "export { serializeScene, deserializeScene } from '../../src/editor/project/SceneSerializer.ts';",
    "export { createDefaultSceneOpeningAnimation } from '../../src/editor/model/sceneOpeningAnimation.ts';",
  ].join('\n'));
  const { build } = await import('vite');
  await build({ configFile: false, publicDir: false, logLevel: 'silent',
    build: { ssr: entry, outDir: path.join(root, 'modules'),
      rolldownOptions: { output: { entryFileNames: 'scene-modules.mjs' } } } });
  return import(pathToFileURL(path.join(root, 'modules/scene-modules.mjs')).href);
}

async function readEntry(archive, name) {
  const entry = archive.files.find(file => file.path.replace(/\\/g, '/') === name);
  assert.ok(entry, 'ZIP 应包含 ' + name);
  return (await entry.buffer()).toString('utf8');
}

async function extractViewer(archive, viewerRoot) {
  for (const entry of archive.files) {
    const destination = path.resolve(viewerRoot, entry.path);
    const relative = path.relative(viewerRoot, destination);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'DIST 条目必须位于验收目录内');
    if (entry.type === 'Directory') await mkdir(destination, { recursive: true });
    else {
      await mkdir(path.dirname(destination), { recursive: true });
      await pipeline(entry.stream(), createWriteStream(destination));
    }
  }
}

async function run() {
  let code = 1;
  try {
    for (const dependency of ['dist-electron/ipc/digitalTwinSourcePackage.js',
      'dist-electron/ipc/digitalTwinDistPackage.js', 'dist-viewer-template/index.html']) {
      try { await access(dependency); }
      catch { throw new Error('缺少构建产物 ' + dependency + '，请先运行 npm run build:electron 和 npm run build:viewer。'); }
    }
    const { buildDigitalTwinSourcePackage } = await import('../../dist-electron/ipc/digitalTwinSourcePackage.js');
    const { buildDigitalTwinDistPackage } = await import('../../dist-electron/ipc/digitalTwinDistPackage.js');
    const { createEmptySceneDocument, createMeshEntity, serializeScene, deserializeScene,
      createDefaultSceneOpeningAnimation } = await loadSceneModules();
    const enabled = createEmptySceneDocument('参考HTML开场62秒与巡检双包验收');
    enabled.sceneSettings.camera = { ...enabled.sceneSettings.camera,
      savedPose: { alpha: 1.2, beta: 1.1, radius: 30, target: { x: 3, y: 2, z: -4 } },
      savedOrientation: 'orbit', savedProjection: 'perspective' };
    enabled.sceneSettings.openingAnimation = { ...createDefaultSceneOpeningAnimation(), enabled: true,
      durationSeconds: 23.5, allowSkip: false, title: '惠山测试主标题', subtitle: '双包完整配置快照',
      destination: { name: '惠山参考点', longitude: 120.3, latitude: 31.68 },
      destinations: [{ name: '北京', longitude: 116.4, latitude: 39.9 },
        { name: '南半球', longitude: -74.2, latitude: -33.9 }],
      chinaHoldSeconds: 9.5,
      chinaDestinations: [{ name: '四川自定义', longitude: 104.0665, latitude: 30.5723 },
        { name: '上海', longitude: 121.4737, latitude: 31.2304 }],
      breathingEnabled: true, breathingIntensity: 0.83, breathingPeriodSeconds: 3.25,
      motionPreference: 'normal', afterOpening: 'auto-patrol' };
    enabled.sceneSettings.openingAnimation.reference = {
      ...enabled.sceneSettings.openingAnimation.reference,
      brandName: '中鼎智能 · 包验收', companyName: '中鼎智能(无锡)科技股份有限公司',
      heroTitle: '从全球\n抵达智能现场', heroSubtitle: '参考HTML完整配置快照', finaleTitle: '抵达惠山\n进入实际场景',
      quality: 'high', showUI: true, stageDurations: [9, 7, 8, 6, 4, 8, 6, 6, 8],
      worldOrigin: { x: 0.709, y: 0.335 }, chinaOrigin: { x: 0.707, y: 0.520 },
      worldDestinations: [{ name: '美国东部自定义', x: 0.236, y: 0.32 }, { name: '澳大利亚', x: 0.839, y: 0.679 }],
      chinaDestinations: [{ name: '四川自定义', x: 0.456, y: 0.56 }, { name: '上海', x: 0.728, y: 0.554 }],
    };
    const building = createMeshEntity('cube', { x: 3, y: 1, z: -4 });
    building.components.transform.scale = { x: 12, y: 2, z: 8 };
    enabled.entityIds = [building.id];
    enabled.entities = { [building.id]: building };

    const disabled = structuredClone(enabled);
    disabled.name = '关闭开场与显式零值验收';
    disabled.sceneSettings.openingAnimation = { ...disabled.sceneSettings.openingAnimation,
      enabled: false, durationSeconds: 6, title: '', subtitle: '', allowSkip: true,
      destination: { name: '零经纬度', longitude: 0, latitude: 0 }, destinations: [],
      chinaHoldSeconds: 0, chinaDestinations: [],
      breathingEnabled: false, breathingIntensity: 0, breathingPeriodSeconds: 10,
      motionPreference: 'reduced', afterOpening: 'stay' };
    disabled.sceneSettings.openingAnimation.reference = {
      ...disabled.sceneSettings.openingAnimation.reference,
      brandName: '', heroTitle: '', heroSubtitle: '', finaleTitle: '', quality: 'low', showUI: false,
      stageDurations: [9, 7, 0, 6, 4, 0, 6, 6, 8],
      worldOrigin: { x: 0, y: 0 }, chinaOrigin: { x: 0, y: 0 }, worldDestinations: [], chinaDestinations: [],
    };
    const skippable = structuredClone(enabled);
    skippable.name = '可跳过开场与停留最终视角验收';
    skippable.sceneSettings.openingAnimation.allowSkip = true;
    skippable.sceneSettings.openingAnimation.afterOpening = 'stay';
    const legacy = createEmptySceneDocument('没有开场字段的旧场景');
    const legacyFile = JSON.parse(serializeScene(legacy));
    delete legacyFile.scene.sceneSettings.openingAnimation;
    const legacyGeographicFile = JSON.parse(serializeScene(enabled));
    legacyGeographicFile.scene.name = '旧地理模板向参考模板迁移';
    legacyGeographicFile.scene.sceneSettings.openingAnimation.template = 'globe-huishan';
    delete legacyGeographicFile.scene.sceneSettings.openingAnimation.reference;
    const legacyGeographicContent = JSON.stringify(legacyGeographicFile);
    const legacyGeographic = deserializeScene(legacyGeographicContent);
    const fixtures = [
      { name: 'main.scene.json', scene: enabled, content: serializeScene(enabled) },
      { name: 'disabled.scene.json', scene: disabled, content: serializeScene(disabled) },
      { name: 'legacy.scene.json', scene: legacy, content: JSON.stringify(legacyFile) },
      { name: 'legacy-geographic.scene.json', scene: legacyGeographic, content: legacyGeographicContent },
      { name: 'skippable.scene.json', scene: skippable, content: serializeScene(skippable) },
    ];
    const originalObjects = JSON.stringify([enabled, disabled, legacy, legacyGeographic, skippable]);
    const projectRoot = path.join(root, 'project');
    const scenesRoot = path.join(projectRoot, 'Scenes');
    await mkdir(scenesRoot, { recursive: true });
    for (const fixture of fixtures) await writeFile(path.join(scenesRoot, fixture.name), fixture.content);
    const sourcePackage = await buildDigitalTwinSourcePackage({
      projectRoot, sharedResourcesRoot: path.join(root, 'shared'), entrySceneFilePath: path.join(scenesRoot, 'main.scene.json'),
      outputRoot: path.join(root, 'source-output'), signal: abortController.signal,
      manifest: { projectId: '123', projectName: '地理开场验收', editorProjectId: null, baseVersionId: null, resourceRevision: '1' },
      isPlatformImageReference: () => false, findSyncedImageForReference: async () => null,
      skyboxCacheDependencies: { getSharedProjectSkyboxRoot: () => null },
    });
    assert.equal(sourcePackage.sceneCount, fixtures.length);
    const unzipper = require('unzipper');
    const sourceArchive = await unzipper.Open.file(sourcePackage.filePath);
    const sourceContents = new Map();
    for (const fixture of fixtures) {
      const content = await readEntry(sourceArchive, 'Scenes/' + fixture.name);
      sourceContents.set(fixture.name, content);
      const reopened = deserializeScene(content);
      assert.deepEqual(reopened.sceneSettings.openingAnimation, fixture.scene.sceneSettings.openingAnimation,
        fixture.name + ' SOURCE 重开保留完整开场配置');
      assert.deepEqual(reopened.sceneSettings.camera, fixture.scene.sceneSettings.camera,
        fixture.name + ' SOURCE 保留结束相机');
      assert.equal(await readFile(path.join(scenesRoot, fixture.name), 'utf8'), fixture.content, '打包不能改写原场景文件');
    }
    assert.equal(deserializeScene(sourceContents.get('legacy.scene.json')).sceneSettings.openingAnimation.enabled, false);
    const migratedOpening = deserializeScene(sourceContents.get('legacy-geographic.scene.json')).sceneSettings.openingAnimation;
    assert.equal(migratedOpening.template, 'reference-huishan');
    assert.equal(migratedOpening.reference.version, 1);
    assert.deepEqual(migratedOpening.destinations, enabled.sceneSettings.openingAnimation.destinations, '迁移保留原经纬度档案，不冒充为UV坐标');
    assert.ok(migratedOpening.reference.legacyUnmappedNames?.length, '未匹配旧点位必须保留迁移提示');

    // 走真实打包入口，证明旧模板不会把已启用的开场悄悄导出为普通场景。
    const legacyEditorRoot = path.join(root, 'legacy-editor');
    const legacyTemplateRoot = path.join(legacyEditorRoot, 'dist-viewer-template');
    await mkdir(path.join(legacyTemplateRoot, 'assets'), { recursive: true });
    await writeFile(path.join(legacyTemplateRoot, 'index.html'), '<script src="./assets/legacy.js"></script>');
    await writeFile(path.join(legacyTemplateRoot, 'assets/legacy.js'), '/* legacy viewer fixture */');
    const currentAppPath = app.getAppPath;
    try {
      app.getAppPath = () => legacyEditorRoot;
      const legacyOptions = {
        projectId: '123', publishName: '旧模板兼容验收', sourceResourceFiles: sourcePackage.resourceFiles,
        outputRoot: path.join(root, 'legacy-dist'), signal: abortController.signal,
      };
      await assert.rejects(buildDigitalTwinDistPackage({ ...legacyOptions,
        sceneContent: sourceContents.get('main.scene.json') }), /Viewer 模板.*开场动画.*更新/s);
      const legacyDisabled = await buildDigitalTwinDistPackage({ ...legacyOptions,
        sceneContent: sourceContents.get('disabled.scene.json') });
      assert.ok(legacyDisabled.fileSize > 0, '关闭开场的旧模板继续允许发布');
    } finally { app.getAppPath = currentAppPath; }

    const outputRoot = path.resolve('output/geographic-opening');
    await mkdir(outputRoot, { recursive: true });
    const distResults = [];
    for (const fixture of [fixtures[0], fixtures[1], fixtures[4]]) {
      const distPackage = await buildDigitalTwinDistPackage({
        projectId: '123', publishName: fixture.scene.name,
        sceneContent: sourceContents.get(fixture.name), sourceResourceFiles: sourcePackage.resourceFiles,
        outputRoot: path.join(root, 'dist-' + fixture.name), signal: abortController.signal,
      });
      const archive = await unzipper.Open.file(distPackage.filePath);
      const content = await readEntry(archive, 'project/scene.json');
      const packaged = JSON.parse(content).scene;
      assert.deepEqual(packaged.sceneSettings.openingAnimation, fixture.scene.sceneSettings.openingAnimation,
        fixture.name + ' DIST 原始 JSON 保留完整开场配置');
      const reopened = deserializeScene(content);
      assert.deepEqual(reopened.sceneSettings.openingAnimation, fixture.scene.sceneSettings.openingAnimation,
        fixture.name + ' DIST 可由运行时同源解析器重开');
      assert.deepEqual(reopened.sceneSettings.camera, fixture.scene.sceneSettings.camera, 'DIST 不改写结束相机');
      assert.equal(reopened.entityIds.length, 1, 'DIST 可解析并保留实际场景模型');
      assert.ok(archive.files.some(file => file.path === 'index.html'), 'DIST 包含真实 Viewer 入口');
      assert.ok(archive.files.some(file => /\.js$/.test(file.path)), 'DIST 包含 Viewer 脚本');
      const referenceAssets = archive.files.filter(file => /(?:^|\/)asset-(?:10|[1-9])(?:-[^/]+)?\.webp$/i.test(file.path));
      assert.equal(referenceAssets.length, 10, 'DIST 必须包含九张参考底图和地球atlas，不能依赖桌面路径或外部CDN');
      const prefix = fixture.name === 'skippable.scene.json' ? 'viewer-skippable-'
        : fixture.scene.sceneSettings.openingAnimation.enabled ? 'viewer-enabled-' : 'viewer-disabled-';
      const viewerRoot = await mkdtemp(path.join(outputRoot, prefix));
      await extractViewer(archive, viewerRoot);
      distResults.push({ enabled: fixture.scene.sceneSettings.openingAnimation.enabled,
        afterOpening: fixture.scene.sceneSettings.openingAnimation.afterOpening,
        template: reopened.sceneSettings.openingAnimation.template,
        referenceDuration: reopened.sceneSettings.openingAnimation.reference.stageDurations.reduce((sum, value) => sum + value, 0),
        referenceAssets: referenceAssets.length, fileCount: distPackage.fileCount, bytes: distPackage.fileSize, viewerRoot });
    }
    assert.equal(JSON.stringify([enabled, disabled, legacy, legacyGeographic, skippable]), originalObjects, '打包和重开不能修改源场景对象');
    assert.equal(distResults[0].referenceDuration, 62, '参考模板使用reference时长，不误用历史durationSeconds与chinaHoldSeconds');
    for (const fixture of fixtures) {
      assert.equal(await readFile(path.join(scenesRoot, fixture.name), 'utf8'), fixture.content, 'DIST 打包后原场景仍保持原字节');
    }
    await writeFile(path.join(outputRoot, 'packages-result.json'), JSON.stringify({
      ok: true, sourceScenes: fixtures.length, sourceBytes: sourcePackage.fileSize,
      viewerRoot: distResults[0].viewerRoot, disabledViewerRoot: distResults[1].viewerRoot,
      skippableViewerRoot: distResults[2].viewerRoot, distResults,
      checks: ['source-enabled-auto-patrol', 'source-disabled-stay-zero-coordinates-empty-routes',
        'source-dist-reference-template-full-config', 'reference-62-seconds-nine-stages',
        'reference-zero-business-stages-empty-uv-routes', 'reference-ten-offline-assets', 'legacy-geographic-migration-preserves-archive',
        'source-legacy-disabled', 'source-reopen', 'dist-enabled-complete-config', 'dist-disabled-complete-config',
        'dist-legacy-template-rejected-when-enabled', 'dist-legacy-template-allowed-when-disabled',
        'dist-skippable-stay', 'dist-runtime-deserialization', 'dist-camera-preserved', 'dist-viewer-entry', 'source-not-mutated'],
    }, null, 2));
    console.log('PASS: 参考开场 SOURCE 五场景和启用/关闭/可跳过三份 DIST 实际 ZIP，62秒九段、离线底图、配置、相机、旧模板迁移及源文件不改写验证通过。');
    console.log('DIST 浏览器验收目录：' + distResults[0].viewerRoot);
    code = 0;
  } catch (error) { console.error(error); }
  finally {
    clearTimeout(deadline);
    try { await cleanup(); } catch (error) { console.error(error); code = 1; }
    app.exit(code);
  }
}

app.whenReady().then(run).catch(error => {
  console.error(error);
  clearTimeout(deadline);
  void cleanup().catch(console.error).finally(() => app.exit(1));
});
