/* global window, requestAnimationFrame */
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, readdir, writeFile, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { _electron as electron } from 'playwright';
import { createServer } from 'vite';
import { createLiftBroker, createLiftFixture, liftId } from '../tests/helpers/liftMotionArrowFixture.mjs';
import { runLightingOptimizationUiSmoke } from '../tests/helpers/lightingOptimizationUiSmoke.mjs';
import { runLightingViewerSmoke } from '../tests/helpers/lightingViewerSmoke.mjs';
import { runLightingFactoryGiPerformance } from '../tests/helpers/lightingFactoryGiPerformance.mjs';
import { runLightingFactoryPerformance } from '../tests/helpers/lightingFactoryPerformance.mjs';
import { runLightingManagerUiSmoke, lightingManagerSecondLiftId } from '../tests/helpers/lightingManagerUiSmoke.mjs';
import { findLightingSmokePort } from '../tests/helpers/lightingSmokePort.mjs';
import { runUnifiedLightingControlsSmoke, runUnifiedLightingAppearanceSmoke, runUnifiedSkyboxUiSmoke } from '../tests/helpers/lightingUnifiedUiSmoke.mjs';

// 仅替代文件选择器。真实 EditorLayout、IPC、Cycles、MQTT 驱动、材质和 GPU 使用正式实现。
const workspace = path.resolve(import.meta.dirname, '..');
const preflight = process.env.LIGHTING_SMOKE_STAGE === 'preflight';
const optimizationSmoke = process.argv.includes('--optimization');
const unifiedSmoke = optimizationSmoke || process.argv.includes('--unified') || process.argv.includes('--unified-ui-only');
const skyboxUiSmoke = process.argv.includes('--skybox-ui-only');
const managerUiOnly = process.argv.includes('--manager-ui-only') || process.argv.includes('--unified-ui-only');
const managerSmoke = unifiedSmoke || managerUiOnly || process.argv.includes('--manager') || process.env.LIGHTING_SMOKE_STAGE === 'manager';
const factoryGi = process.env.LIGHTING_SMOKE_STAGE === 'factory-gi';
const factoryProfile = process.env.LIGHTING_SMOKE_STAGE === 'factory-profile';
const factoryOnly = process.env.LIGHTING_SMOKE_STAGE === 'factory-only' || factoryProfile || factoryGi;
const reopen = process.env.LIGHTING_SMOKE_STAGE === 'reopen';
const density = preflight || managerSmoke ? 8 : 128;
const output = reopen && process.env.LIGHTING_SMOKE_REOPEN_REPORT ? path.resolve(path.dirname(process.env.LIGHTING_SMOKE_REOPEN_REPORT), 'editor-reopen') : factoryGi ? path.resolve('output/lighting-optimization', 'factory-' + Date.now()) : optimizationSmoke ? path.resolve('output/lighting-optimization', 'electron-' + Date.now()) : unifiedSmoke ? path.resolve('output/lighting-unified', managerUiOnly ? 'ui' : 'electron') : managerSmoke ? path.resolve('output/lighting-manager', managerUiOnly ? 'ui' : 'electron') : path.resolve('output/lighting-bake', preflight ? 'preflight' : factoryProfile ? 'factory-profile' : factoryOnly ? 'factory-only' : reopen ? 'reopen' : '.');
const previous = reopen ? JSON.parse(await readFile(path.resolve(process.env.LIGHTING_SMOKE_REOPEN_REPORT || 'output/lighting-bake/electron-result.json'), 'utf8')) : null;
const previousScenePath = previous ? (process.env.LIGHTING_SMOKE_REOPEN_SCENE ? path.resolve(process.env.LIGHTING_SMOKE_REOPEN_SCENE) : path.join(previous.projectRoot, 'Scenes', 'hybrid.scene.json')) : null;
const temporary = await mkdtemp(path.join(tmpdir(), 'lighting-bake-electron-'));
const projectRoot = path.join(temporary, 'project');
const scenePath = path.join(projectRoot, 'Scenes', 'hybrid.scene.json');
await mkdir(path.dirname(scenePath), { recursive: true }); await mkdir(output, { recursive: true });
const skyboxPath = path.join(projectRoot, 'Assets', 'Skyboxes', 'managed-ui', 'partly-cloudy-light.hdr');
if (skyboxUiSmoke) {
  await mkdir(path.dirname(skyboxPath), { recursive: true });
  await copyFile(path.join(workspace, 'public', 'builtin-skyboxes', 'partly-cloudy-light', 'partly-cloudy-light.hdr'), skyboxPath);
}
const fixture = reopen ? JSON.parse(await readFile(previousScenePath, 'utf8')) : await createLiftFixture(projectRoot);
if (!reopen) {
fixture.scene.name = '混合光照与材质烘焙验收'; fixture.scene.selectedEntityId = null;
if (!factoryOnly) {
  const second = structuredClone(fixture.scene.entities[liftId]);
  second.id = lightingManagerSecondLiftId; second.name = '提升机集中实例02';
  second.components.modelAsset.assetCode = 'LIFT-MANAGER-TWO';
  second.components.transform.position.x = 0;
  fixture.scene.entities[second.id] = second; fixture.scene.entityIds.push(second.id);
}
fixture.scene.sceneSettings = {
  shadows: { enabled: true, mode: 'hybrid', quality: 'balanced', sunAzimuthDegrees: 225, sunElevationDegrees: 45 },
   lightingBake: { enabled: true, quality: 'preview', atlasSize: 1024, texelsPerMeter: density, probeSpacing: 6, maxTextureMiB: 128,
    cacheStaticShadows: true, dynamicShadows: true,
    ...(optimizationSmoke ? { device: 'gpu', probeVolumes: [{ id: 'optimization-floor', name: '首层活动范围', enabled: true, min: [-8, -0.3, -5], max: [8, 10, 5] }] } : {}) },
};
const box = (id, color, position, scale) => ({ id, name: id, parentId: null, childrenIds: [], visible: true, locked: false,
  components: { transform: { position, rotation: { x: 0, y: 0, z: 0 }, scale }, meshRenderer: { meshKind: 'cube', materialColor: color } } });
for (const item of [box('静态地面', '#8d9297', { x: 0, y: -0.15, z: 0 }, { x: 15, y: 0.3, z: 10 }),
  box('静态墙体', '#9c5f42', { x: 0, y: 2.5, z: 4 }, { x: 15, y: 5, z: 0.3 })]) {
  fixture.scene.entities[item.id] = item; fixture.scene.entityIds.push(item.id);
}
}
const report = { status: 'RUNNING', stage: managerUiOnly ? 'central-manager-ui-only' : managerSmoke ? 'central-manager-integration' : preflight ? 'preflight-single-page' : factoryProfile ? 'factory-profile' : factoryOnly ? 'factory-only' : reopen ? 'reopen-export' : 'final-multiple-pages', density,
  startedAt: new Date().toISOString(), projectRoot, checks: [], gpu: null, pageErrors: [],
  rendererGone: [], consoleErrors: [], screenshots: [], snapshots: [], performance: [] };
if (previousScenePath) report.sourceSavedScenePath = previousScenePath;
const check = name => { report.checks.push(name); console.log(`[lighting-electron] ${name}`); };
let server, application, page, broker, bootstrap, initialSceneContent;
const saveReport = () => writeFile(path.join(output, 'electron-result.json'), JSON.stringify(report, null, 2));
async function capture(name) { const file = path.join(output, name + '.png'); await page.screenshot({ path: file }); report.screenshots.push(file); }
try {
  const port = await findLightingSmokePort();
  server = await createServer({ server: { host: '127.0.0.1', port, strictPort: true, hmr: false },
    optimizeDeps: { noDiscovery: true, include: ['react', 'react-dom/client', 'react/jsx-runtime', '@babylonjs/core', '@babylonjs/loaders', '@linkiez/dxf-renew', 'typescript', 'mqtt', 'zustand'] } });
  broker = createLiftBroker(server.httpServer);
  await server.listen(); await server.watcher.close();
  fixture.scene.mqttConfig.address = `ws://127.0.0.1:${server.httpServer.address().port}/__lift_mqtt__`;
  initialSceneContent = JSON.stringify(fixture);
  await writeFile(scenePath, initialSceneContent, 'utf8');
  const environment = { ...process.env, VITE_DEV_SERVER_URL: server.resolvedUrls.local[0], OPEN_DEVTOOLS: 'false' };
  delete environment.ELECTRON_RUN_AS_NODE; delete environment.EDITOR_ALLOW_SOFTWARE_WEBGL;
  const userData = path.join(temporary, 'user-data'); await mkdir(userData, { recursive: true });
  // Electron 依据入口目录确定 appPath，必须使用仓库根入口以验证正式 Viewer 模板查找。
  bootstrap = path.join(workspace, `.tmp-lighting-smoke-${randomUUID()}.mjs`);
  await writeFile(bootstrap, `import { app } from 'electron';\napp.setPath('userData', ${JSON.stringify(userData)});\n`
    + `const assets = await import(${JSON.stringify(pathToFileURL(path.join(workspace, 'dist-electron/ipc/projectAssetStore.js')).href)});\n`
    + `const registry = await import(${JSON.stringify(pathToFileURL(path.join(workspace, 'dist-electron/ipc/assetRegistry.js')).href)});\n`
    + 'globalThis.lightingSmokeMain = { assets, registry };\n'
    + `await import(${JSON.stringify(pathToFileURL(path.join(workspace, 'dist-electron/main.js')).href)});\n`, { encoding: 'utf8', flag: 'wx' });
  application = await electron.launch({ args: [bootstrap, `--user-data-dir=${userData}`],
    cwd: workspace, env: environment, timeout: 90_000 });
  await application.evaluate(async ({ app, BrowserWindow, dialog }, options) => {
    globalThis.lightingSmokeGone = [];
    for (const win of BrowserWindow.getAllWindows()) { win.webContents.setBackgroundThrottling(false);
      win.webContents.on('render-process-gone', (_event, details) => globalThis.lightingSmokeGone.push(details)); }
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: options.scenePath });
    dialog.showOpenDialog = async (...args) => ({ canceled: false, filePaths: [args.at(-1)?.properties?.includes('openDirectory') ? options.projectRoot : options.scenePath] });
    await globalThis.lightingSmokeMain.assets.activateProjectRoot(options.projectRoot);
    globalThis.lightingSmokeMain.registry.authorizeAssetRoot(options.projectRoot);
    if (options.previousProjectRoot) globalThis.lightingSmokeMain.registry.authorizeAssetRoot(options.previousProjectRoot);
    return app.getPath('userData');
  }, { projectRoot, scenePath, workspace, previousProjectRoot: previous?.projectRoot });
  page = await application.firstWindow(); page.setDefaultTimeout(60_000);
  await page.setViewportSize({ width: 1440, height: 960 });
  page.on('pageerror', error => report.pageErrors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error') report.consoleErrors.push(message.text());
    else if (message.text().startsWith('[lighting-progress]')) console.log(message.text());
  });
  await page.getByRole('button', { name: '进入空白编辑器' }).click();
  await page.locator('canvas.scene-canvas').waitFor();
  await page.evaluate(async ({ content, scenePath }) => {
    const { useEditorStore } = await import('/src/editor/store/editorStore.ts');
    const { SceneRuntime } = await import('/src/runtime/babylon/SceneRuntime.ts');
    const { createEmptySceneDocument } = await import('/src/editor/model/SceneDocument.ts');
    const { serializeScene, deserializeScene } = await import('/src/editor/project/SceneSerializer.ts');
    const preparation = await import('/src/editor/loading/scenePreparationProgress.ts');
    const original = SceneRuntime.prototype.getLightingClassification;
    const state = { store: useEditorStore, runtime: null, progress: [], preparation };
    SceneRuntime.prototype.getLightingClassification = function () { state.runtime = this; return original.call(this); };
    window.lightingSmoke = state;
    window.editorApi.onLightingBakeProgress(event => {
      state.progress.push(event);
      const bucket = event.phase + ':' + Math.floor(event.progress * 10);
      if (bucket !== state.progressBucket) {
        state.progressBucket = bucket;
        console.log('[lighting-progress]', event.phase, Math.round(event.progress * 100) + '%', event.message);
      }
    });
    const legacy = JSON.parse(content), canonical = JSON.parse(serializeScene(createEmptySceneDocument(legacy.scene.name)));
    // 旧夹具只补非光照默认值；不能用新默认覆盖待验证的历史光照输入。
    if (!legacy.scene.sceneSettings?.lighting) {
      delete canonical.scene.sceneSettings.lighting;
      delete canonical.scene.sceneSettings.appearance;
    }
    canonical.scene = { ...canonical.scene, ...legacy.scene,
      sceneSettings: { ...canonical.scene.sceneSettings, ...legacy.scene.sceneSettings } };
    const loaded = useEditorStore.getState().loadSceneFromContent(serializeScene(deserializeScene(JSON.stringify(canonical))), scenePath);
    if (!loaded) throw new Error(JSON.stringify(useEditorStore.getState().logs.slice(0, 5)));
    return { name: useEditorStore.getState().scene.name, count: useEditorStore.getState().scene.entityIds.length };
  }, { content: JSON.stringify(fixture), scenePath });
  await page.waitForFunction(() => {
    const state = window.lightingSmoke;
    return state?.runtime && !state.runtime.getInitialLoadSnapshot().progress.loading
      && state.store.getState().lightingClassification.some(e => e.name.includes('LiftColumn') && e.mobility === 'static')
      && state.store.getState().lightingClassification.some(e => e.name.includes('LiftDeck') && e.mobility === 'dynamic');
  }, null, { timeout: 180_000 });
  await page.getByRole('button', { name: '取消加载并返回首页', exact: true }).waitFor({ state: 'hidden', timeout: 180_000 });
  const closeNotice = page.getByRole('button', { name: '关闭场景资源提示', exact: true });
  if (await closeNotice.isVisible()) {
    report.resourceNotice = await page.getByRole('complementary', { name: '场景资源状态', exact: true }).innerText();
    report.resourceIssues = await page.evaluate(() => window.lightingSmoke.store.getState().sceneResourceIssues);
    await closeNotice.click();
  }
  const initial = await page.evaluate(() => window.lightingSmoke.store.getState().lightingClassification.map(e => ({ name: e.name, mobility: e.mobility, reason: e.reason })));
  assert.ok(initial.some(e => e.name.includes('LiftColumn') && e.mobility === 'static'), JSON.stringify(initial));
  assert.ok(initial.some(e => e.name.includes('LiftDeck') && e.mobility === 'dynamic'), JSON.stringify(initial));
  check('实际专用驱动识别固定立柱与升降部件');
  if (factoryOnly) {
    assert.ok(process.env.LIGHTING_FACTORY_SCENE_PATH, '工厂专项需要明确的真实场景路径');
    report.factory = await runLightingFactoryPerformance({ application, page,
      sourceScenePath: path.resolve(process.env.LIGHTING_FACTORY_SCENE_PATH), projectRoot, output, profile: factoryProfile, ...(factoryGi ? { measureGi: runLightingFactoryGiPerformance } : {}) });
    check(factoryGi ? (process.env.LIGHTING_FACTORY_GI_PREFLIGHT_ONLY === '1' ? '实际完整工厂仅完成GI预检，尚未进行烘焙或性能采样' : '实际完整工厂GI开启并完成探针算法A/B/B/A对照') : factoryProfile ? '完成实际工厂性能诊断，此阶段不代表正式性能验收'
      : '实际工厂场景完成隔离A/B/B/A帧时间和Windows GPU进程内存采样');
  } else if (reopen) {
    await page.evaluate(() => window.lightingSmoke.runtime.waitForLightingReady());
    const state = await page.evaluate(() => ({ error: window.lightingSmoke.runtime.getLightingBakeRuntimeError(),
      result: window.lightingSmoke.store.getState().scene.sceneSettings.lighting.result }));
    assert.equal(state.error, null, '真实保存场景重开后不应保留混合光照错误');
    assert.ok(state.result?.surfaces.length > 0);
    report.snapshots.push(state.result);
    await capture('editor-reopened'); check('复用真实Cycles资产重开，无重新烘焙且当前运行时光照有效');
    report.viewer = await runLightingViewerSmoke({ application, editorPage: page, scenePath, projectRoot, output, broker });
    check('最新Viewer正式导出与MQTT升降回落，无遗留光照失败提示');
    if (process.env.LIGHTING_FACTORY_SCENE_PATH) {
      report.factory = await runLightingFactoryPerformance({ application, page,
        sourceScenePath: path.resolve(process.env.LIGHTING_FACTORY_SCENE_PATH), projectRoot, output });
      check('实际工厂场景完成隔离A/B/B/A帧时间和Windows GPU进程内存采样');
    }
  } else {
  const managerUi = await runLightingManagerUiSmoke({ page, liftId, capture, check });
  if (unifiedSmoke) await runUnifiedLightingControlsSmoke({ page, ui: managerUi, capture, check });
  if (skyboxUiSmoke) await runUnifiedSkyboxUiSmoke({ page, ui: managerUi, skyboxPath, capture, check });
  if (managerUiOnly) {
    await capture('manager-ui-completed');
    check('集中管理器真实UI专项完成；此阶段不包含Cycles/保存/Viewer验收');
  } else {
  const sceneSettings = managerUi.manager;
  await managerUi.close();
  await page.evaluate(() => window.lightingSmoke.store.getState().selectEntity(null));
  await page.evaluate(() => {
    const runtime = window.lightingSmoke.runtime;
    const scene = runtime.scene ?? runtime['scene'];
    const camera = scene.activeCamera, target = camera.target.clone(); target.copyFromFloats(0, 2.3, 0);
    camera.setTarget(target); camera.alpha = -1.0; camera.beta = 1.12; camera.radius = 20;
  });
  await page.getByRole('button', { name: '保存当前视角', exact: true }).and(page.locator(':enabled')).click();
  await page.waitForFunction(() => !window.lightingSmoke.store.getState().cameraPoseSaveRequest);
  await managerUi.open('总览与烘焙');
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await capture('editor-before');
  await sceneSettings.getByRole('combobox', { name: '烘焙质量', exact: true }).selectOption('high');
  await sceneSettings.getByRole('button', { name: '应用配置', exact: true }).click();
  await page.getByRole('button', { name: '开始烘焙', exact: true }).click();
  await page.waitForFunction(() => window.lightingSmoke.progress.some(p => p.phase === 'baking'), null, { timeout: 90_000 });
  await managerUi.open('任务与资源');
  await capture('manager-task-progress');
  await managerUi.close();
  assert.ok(await page.evaluate(() => window.lightingSmoke.store.getState().lightingBakeRequest), '关闭管理器不能取消后台任务');
  await managerUi.open('任务与资源');
  await sceneSettings.getByRole('button', { name: '取消本次烘焙', exact: true }).click();
  await page.waitForFunction(() => !window.lightingSmoke.store.getState().lightingBakeRequest);
  assert.equal(await page.evaluate(() => window.lightingSmoke.store.getState().scene.sceneSettings.lighting.result), null);
  check('真实UI取消后台任务且不提交候选结果');
  await managerUi.open('总览与烘焙');
  await sceneSettings.getByRole('combobox', { name: '烘焙质量', exact: true }).selectOption('preview');
  await sceneSettings.getByRole('button', { name: '应用配置', exact: true }).click();
  await page.getByRole('button', { name: '开始烘焙', exact: true }).click();
  await page.waitForFunction(() => !window.lightingSmoke.store.getState().lightingBakeRequest, null, { timeout: 900_000 });
  const completion = await page.evaluate(() => ({ status: window.lightingSmoke.store.getState().lightingBakeStatus,
    result: window.lightingSmoke.store.getState().scene.sceneSettings.lighting.result, error: window.lightingSmoke.runtime.getLightingBakeRuntimeError() }));
  assert.equal(completion.status.phase, 'idle', JSON.stringify(completion));
  assert.ok(completion.result?.surfaces.length > 0, JSON.stringify(completion));
  if (!preflight && !managerSmoke) {
    assert.ok(completion.result.surfaces.filter(surface => surface.entityId === '静态地面').length > 1, '单个地面必须真实跨区域分片');
    assert.ok(completion.result.statistics.atlasCount > 1, '必须真实输出并应用多页图集');
  }
  assert.equal(completion.error, null, JSON.stringify(completion)); report.snapshots.push(completion.result);
  report.bakedTextures = await page.evaluate(() => Array.from(window.lightingSmoke.runtime.environment.lightingRuntime.state.resources.textures.values()).map(texture => {
    const internal = texture.getInternalTexture();
    return { width: internal.width, height: internal.height, mipmaps: internal.generateMipMaps };
  }));
  assert.ok(report.bakedTextures.every(texture => texture.mipmaps === false), '预算中的图集不能暗中分配额外mip链');
  assert.equal(report.bakedTextures.reduce((bytes, texture) => bytes + texture.width * texture.height * 4, 0), completion.result.statistics.textureBytes);
  check('真实UI调用IPC及Cycles并原子应用图集/UV/探针');
  await page.evaluate(() => window.lightingSmoke.runtime.waitForLightingReady());
  if (unifiedSmoke) await runUnifiedLightingAppearanceSmoke({ page, ui: managerUi, capture, check });
  if (optimizationSmoke) report.optimization = await runLightingOptimizationUiSmoke({ page, ui: managerUi, capture, check });
  await managerUi.open('总览与烘焙');
  await sceneSettings.evaluate(node => node.scrollIntoView({ block: 'start' }));
  await capture('editor-baked');
  await sceneSettings.getByRole('button', { name: '查看烘焙前', exact: true }).click();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await capture('editor-comparison');
  await sceneSettings.getByRole('button', { name: '恢复烘焙效果', exact: true }).click();
  await sceneSettings.getByRole('button', { name: '分类预览', exact: true }).click();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await capture('editor-classification');
  await sceneSettings.getByRole('button', { name: '正常材质', exact: true }).click();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await capture('editor-selection');
  await sceneSettings.getByRole('button', { name: '运动预览', exact: true }).click();
  await page.waitForFunction(() => window.lightingSmoke.store.getState().runtimeMode === 'preview');
  const getDeck = () => page.evaluate(() => {
    const scene = window.lightingSmoke.runtime.scene;
    const mesh = scene.meshes.find(m => m.name.includes('LiftDeck') && m.metadata?.editorEntityId === 'lift-arrow-fixture' && !m.metadata?.lightingDerived);
    mesh.computeWorldMatrix(true); return mesh.getBoundingInfo().boundingBox.centerWorld.y;
  });
  await page.evaluate(() => new Promise(resolve => { let frames = 0; const step = () => ++frames >= 60 ? resolve() : requestAnimationFrame(step); requestAnimationFrame(step); }));
  const cachedBeforeMotion = await page.evaluate(() => window.lightingSmoke.runtime.getHybridLightingMetrics());
  const initialY = await getDeck(); broker.drive('lift', { reference_upper_step: 1, level_upper: 2, work_state: 0 });
  await page.waitForFunction(y => {
    const mesh = window.lightingSmoke.runtime.scene.meshes.find(m => m.name.includes('LiftDeck') && m.metadata?.editorEntityId === 'lift-arrow-fixture' && !m.metadata?.lightingDerived);
    mesh.computeWorldMatrix(true); return mesh.getBoundingInfo().boundingBox.centerWorld.y > y + 0.5;
  }, initialY, { timeout: 60_000 });
  await capture('editor-mqtt-lift');
  assert.equal(await page.evaluate(() => window.lightingSmoke.runtime.getLightingBakeRuntimeError()), null);
  const cachedAfterMotion = await page.evaluate(() => window.lightingSmoke.runtime.getHybridLightingMetrics());
  report.performance.push({ before: cachedBeforeMotion, after: cachedAfterMotion });
  assert.ok(cachedAfterMotion.cacheHits > cachedBeforeMotion.cacheHits, JSON.stringify(cachedAfterMotion));
  assert.equal(cachedAfterMotion.staticRenders, cachedBeforeMotion.staticRenders, '固定场景投影下升降动作不能重绘静态几何阴影');
  check('真实本地MQTT提升动作运行，静态GI保持有效');
  await sceneSettings.getByRole('button', { name: '停止运动预览', exact: true }).click();
  await managerUi.close();
  await page.getByRole('button', { name: '保存场景', exact: true }).click();
  await page.waitForFunction(() => {
    const state = window.lightingSmoke.store.getState();
    const signature = state.scene.sceneSettings.lighting.result?.signature;
    return signature && state.persistedSceneContent?.includes(signature);
  }, null, { timeout: 60_000 });
  const saved = JSON.parse(await readFile(scenePath, 'utf8'));
  assert.ok(saved.scene.sceneSettings.lighting.result?.assets.length);
  if (unifiedSmoke) {
    assert.equal(saved.scene.sceneSettings.lighting.version, 2);
    for (const key of ['theme', 'shadows', 'lightingBake', 'lightingPolicy', 'lightingBakeResult']) assert.equal(Object.hasOwn(saved.scene.sceneSettings, key), false, key);
    const backups = (await readdir(path.dirname(scenePath))).filter(name => name.startsWith(path.basename(scenePath) + '.before-lighting-v2.'));
    assert.equal(backups.length, 1, '实际覆盖旧文件应生成一份迁移备份');
    const backup = path.join(path.dirname(scenePath), backups[0]);
    assert.equal(await readFile(backup, 'utf8'), initialSceneContent, '迁移备份必须保留原场景字节');
    report.migration = { backup, originalSha256: createHash('sha256').update(initialSceneContent).digest('hex'),
      backupSha256: createHash('sha256').update(await readFile(backup)).digest('hex') };
    check('真实IPC保存统一新配置，首次覆盖旧场景已逐字节备份');
  }
  await page.evaluate(async ({ content, scenePath }) => {
    window.lightingSmoke.store.getState().loadSceneFromContent(content, scenePath);
  }, { content: JSON.stringify(saved), scenePath });
  await page.waitForFunction(() => window.lightingSmoke.runtime?.getLightingClassification().length > 0, null, { timeout: 60_000 });
  await page.evaluate(() => window.lightingSmoke.runtime.waitForLightingReady());
  assert.equal(await page.evaluate(() => window.lightingSmoke.runtime.getLightingBakeRuntimeError()), null);
  await capture('editor-reopened'); check('真实保存重开保留光照资产和分类');
  report.viewer = await runLightingViewerSmoke({ application, editorPage: page, scenePath, projectRoot, output, broker,
    expectedPolicyBindings: managerUi.expectedPolicyBindings });
  check('真实导出Viewer在独立浏览器读取全部资源并完成MQTT运动');
  if (!preflight && process.env.LIGHTING_FACTORY_SCENE_PATH) {
    report.factory = await runLightingFactoryPerformance({ application, page,
      sourceScenePath: path.resolve(process.env.LIGHTING_FACTORY_SCENE_PATH), projectRoot, output });
    check('实际工厂场景完成隔离A/B/B/A帧时间和Windows GPU进程内存采样');
  }
  }
  }
  report.gpu = await application.evaluate(async ({ app }) => ({ enabled: app.isHardwareAccelerationEnabled(), features: app.getGPUFeatureStatus(), info: await app.getGPUInfo('complete') }));
  report.gpu.webgl = await page.evaluate(() => window.lightingSmoke.runtime.scene.getEngine().getGlInfo());
  assert.equal(report.gpu.enabled, true);
  assert.doesNotMatch(report.gpu.webgl.renderer, /swiftshader|llvmpipe|software/i, '需要实际硬件WebGL，不接受软件回退');
  report.rendererGone = await application.evaluate(() => globalThis.lightingSmokeGone);
  assert.deepEqual(report.rendererGone, []); assert.deepEqual(report.pageErrors, []);
  assert.deepEqual(broker.errors, []); report.status = 'PASS';
} catch (error) {
  report.status = 'FAIL'; report.error = error instanceof Error ? error.stack : String(error);
  if (page) report.diagnostics = await page.evaluate(() => {
    const state = window.lightingSmoke?.store.getState();
    return state ? { name: state.scene.name, entities: state.scene.entityIds, logs: state.logs.slice(0, 20), resourceIssues: state.sceneResourceIssues,
      classification: state.lightingClassification, status: state.lightingBakeStatus, hasRuntime: Boolean(window.lightingSmoke.runtime) } : null;
  }).catch(() => null);
  if (page) await capture('failure').catch(() => {});
  throw error;
} finally {
  await saveReport(); await application?.close(); await broker?.close(); await server?.close();
  if (bootstrap) await unlink(bootstrap);
}
