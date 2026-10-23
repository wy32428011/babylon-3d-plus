/* global window, requestAnimationFrame */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { _electron as electron } from 'playwright';
import { createServer } from 'vite';
import { findLightingSmokePort } from '../tests/helpers/lightingSmokePort.mjs';

const workspace = path.resolve(import.meta.dirname, '..');
const unifiedSmoke = process.argv.includes('--unified');
const managerSmoke = unifiedSmoke || process.argv.includes('--manager');
const output = path.join(workspace, 'output', unifiedSmoke ? 'lighting-unified' : managerSmoke ? 'lighting-manager' : 'lighting-bake');
const sourceReportPath = path.join(output, ...(managerSmoke ? ['electron', 'electron-result.json'] : ['electron-result.json']));
const sourceReport = JSON.parse(await readFile(sourceReportPath, 'utf8'));
assert.equal(sourceReport.viewer?.status, 'PASS', '需要已通过正式 Viewer 验收的真实保存场景');
assert.ok(sourceReport.checks?.includes('真实保存重开保留光照资产和分类'), '主验收必须已实际保存重开');
const projectRoot = path.resolve(sourceReport.projectRoot);
const scenePath = path.resolve(sourceReport.viewer.scenePath);
const relativeScene = path.relative(projectRoot, scenePath);
assert.ok(relativeScene && !relativeScene.startsWith('..') && !path.isAbsolute(relativeScene), '场景必须位于已验收的临时工程内');
assert.equal(path.resolve(sourceReport.viewer.projectRoot), projectRoot);
const sourceBytes = await readFile(scenePath);
const sourceHash = createHash('sha256').update(sourceBytes).digest('hex');
const sourceFile = JSON.parse(sourceBytes.toString('utf8'));
const sourceBake = sourceFile.scene?.sceneSettings?.lighting?.result;
assert.ok(sourceBake?.surfaces?.length && sourceBake?.assets?.length, '不允许用占位结果执行状态验收');
assert.equal(sourceBake.signature, sourceReport.viewer.source.signature);
const runId = 'state-' + Date.now() + '-' + randomUUID().slice(0, 8);
const runRoot = path.join(output, runId);
const temporary = await mkdtemp(path.join(tmpdir(), 'lighting-bake-state-'));
const userData = path.join(temporary, 'user-data');
await mkdir(runRoot, { recursive: true });
await mkdir(userData, { recursive: true });
const report = {
  status: 'RUNNING', runId, sourceReportPath, sourceReportStatus: sourceReport.status,
  projectRoot, scenePath, sourceHash, startedAt: new Date().toISOString(),
  checks: [], states: [], screenshots: [], pageErrors: [], consoleErrors: [],
  rendererGone: [], telemetryDisabledInMemory: true,
};
let server, application, page, bootstrap, failure;
let observeErrors = true;
const check = message => { report.checks.push(message); console.log('[lighting-state] ' + message); };
const saveReport = async () => {
  await writeFile(path.join(runRoot, 'result.json'), JSON.stringify(report, null, 2));
  await writeFile(path.join(output, 'state-result.json'), JSON.stringify({ ...report, reportPath: path.join(runRoot, 'result.json') }, null, 2));
};
await saveReport();

try {
  // 使用独立临时会话和动态端口，不接管用户或其他任务的编辑器进程。
  const port = await findLightingSmokePort();
  server = await createServer({
    server: { host: '127.0.0.1', port, strictPort: true, hmr: false },
    optimizeDeps: { noDiscovery: true, include: ['react', 'react-dom/client', 'react/jsx-runtime', '@babylonjs/core', '@babylonjs/loaders', '@linkiez/dxf-renew', 'typescript', 'mqtt', 'zustand'] },
  });
  await server.listen();
  await server.watcher.close();
  const environment = { ...process.env, VITE_DEV_SERVER_URL: server.resolvedUrls.local[0], OPEN_DEVTOOLS: 'false' };
  delete environment.ELECTRON_RUN_AS_NODE;
  delete environment.EDITOR_ALLOW_SOFTWARE_WEBGL;
  bootstrap = path.join(workspace, `.tmp-lighting-state-${randomUUID()}.mjs`);
  await writeFile(bootstrap, `import { app } from 'electron';\napp.setPath('userData', ${JSON.stringify(userData)});\n`
    + `const assets = await import(${JSON.stringify(pathToFileURL(path.join(workspace, 'dist-electron/ipc/projectAssetStore.js')).href)});\n`
    + `const registry = await import(${JSON.stringify(pathToFileURL(path.join(workspace, 'dist-electron/ipc/assetRegistry.js')).href)});\n`
    + 'globalThis.lightingStateMain = { assets, registry };\n'
    + `await import(${JSON.stringify(pathToFileURL(path.join(workspace, 'dist-electron/main.js')).href)});\n`, { encoding: 'utf8', flag: 'wx' });
  application = await electron.launch({ args: [bootstrap, `--user-data-dir=${userData}`], cwd: workspace, env: environment, timeout: 90_000 });
  application.process().once('exit', (code, signal) => { report.electronExit = { code, signal }; });
  report.app = await application.evaluate(async ({ app, BrowserWindow, dialog }, options) => {
    globalThis.lightingStateGone = [];
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.setBackgroundThrottling(false);
      win.webContents.on('render-process-gone', (_event, details) => globalThis.lightingStateGone.push(details));
    }
    // 本验收没有保存或重新烘焙步骤；意外出现文件选择器时也不写入原场景。
    dialog.showSaveDialog = async () => ({ canceled: true });
    await globalThis.lightingStateMain.assets.activateProjectRoot(options.projectRoot);
    globalThis.lightingStateMain.registry.authorizeAssetRoot(options.projectRoot);
    return { appPath: app.getAppPath(), userData: app.getPath('userData') };
  }, { projectRoot });
  assert.equal(path.resolve(report.app.appPath), workspace, '必须使用真实应用根目录及正式资产协议');
  page = await application.firstWindow();
  page.setDefaultTimeout(60_000);
  await page.setViewportSize({ width: 1440, height: 960 });
  page.on('pageerror', error => { if (observeErrors) report.pageErrors.push(error.stack ?? error.message); });
  page.on('console', message => { if (observeErrors && message.type() === 'error') report.consoleErrors.push(message.text()); });
  await page.getByRole('button', { name: '进入空白编辑器', exact: true }).click();
  await page.locator('canvas.scene-canvas').waitFor();
  report.loaded = await page.evaluate(async ({ content, scenePath }) => {
    const { useEditorStore } = await import('/src/editor/store/editorStore.ts');
    const { SceneRuntime } = await import('/src/runtime/babylon/SceneRuntime.ts');
    const { serializeScene, deserializeScene } = await import('/src/editor/project/SceneSerializer.ts');
    const { getSceneLightingBakeSignature } = await import('/electron/shared/sceneLightingBakeContract.ts');
    const original = SceneRuntime.prototype.getLightingClassification;
    const state = { store: useEditorStore, runtime: null, progress: [], signature: getSceneLightingBakeSignature };
    SceneRuntime.prototype.getLightingClassification = function () { state.runtime = this; return original.call(this); };
    window.lightingStateSmoke = state;
    window.editorApi.onLightingBakeProgress(event => state.progress.push(event));
    const document = deserializeScene(content);
    const signatureBefore = getSceneLightingBakeSignature(document);
    // 仅隔离本次内存副本的遥测连接；实体、材质和烘焙输入保持原样。
    document.mqttConfig = { ...document.mqttConfig, enabled: false };
    const signatureAfter = getSceneLightingBakeSignature(document);
    if (signatureBefore !== signatureAfter) throw new Error('隔离遥测改变了静态光照签名');
    if (!useEditorStore.getState().loadSceneFromContent(serializeScene(document), scenePath)) throw new Error('真实场景加载失败');
    useEditorStore.getState().selectEntity(null);
    return { signature: signatureAfter, entities: document.entityIds.length };
  }, { content: sourceBytes.toString('utf8'), scenePath });
  assert.equal(report.loaded.signature, sourceBake.signature);
  await page.waitForFunction(() => {
    const state = window.lightingStateSmoke;
    return state?.runtime && !state.runtime.getInitialLoadSnapshot().progress.loading
      && state.store.getState().lightingClassification.length > 0;
  }, null, { timeout: 180_000 });
  await page.getByRole('button', { name: '取消加载并返回首页', exact: true }).waitFor({ state: 'hidden', timeout: 180_000 });
  const closeNotice = page.getByRole('button', { name: '关闭场景资源提示', exact: true });
  if (await closeNotice.isVisible()) {
    report.resourceIssues = await page.evaluate(() => window.lightingStateSmoke.store.getState().sceneResourceIssues);
    await closeNotice.click();
  }
  await page.evaluate(async () => {
    await window.lightingStateSmoke.runtime.waitForLightingReady();
    const camera = window.lightingStateSmoke.runtime.scene.activeCamera;
    camera.target.set(0, 2.7, 0); camera.alpha = -0.65; camera.beta = 1.15; camera.radius = 20;
  });
  const panel = page.locator('.lighting-manager-summary');
  await panel.waitFor();
  await panel.evaluate(node => node.scrollIntoView({ block: 'start' }));
  const label = panel.locator('.lighting-manager-badge');
  const manager = page.getByRole('dialog', { name: '光照与烘焙管理器', exact: true });
  const openOverview = async () => {
    if (!await manager.isVisible()) await page.getByRole('button', { name: '光照与烘焙管理器', exact: true }).click();
    await manager.getByRole('tab', { name: '总览与烘焙', exact: true }).click();
  };
  const closeManager = async () => {
    await manager.getByRole('button', { name: '关闭光照与烘焙管理器', exact: true }).click();
    await manager.waitFor({ state: 'hidden' });
  };
  await openOverview();
  const waitState = async (expectedLabel, hasResult, isStale, maps) => {
    await page.waitForFunction(({ expectedLabel, hasResult, isStale, maps }) => {
      const state = window.lightingStateSmoke, store = state.store.getState(), runtime = state.runtime;
      const result = store.scene.sceneSettings.lighting.result;
      const meshes = runtime.scene.meshes.filter(mesh => mesh.metadata?.lightingDerived && mesh.isVerticesDataPresent('lightingBakeUV'));
      const stale = Boolean(result && result.signature !== state.signature(store.scene));
      return window.document.querySelector('.lighting-manager-summary .lighting-manager-badge')?.textContent === expectedLabel
        && Boolean(result) === hasResult && stale === isStale && meshes.length === maps
        && runtime.scene.isReady() && (isStale ? runtime.getLightingBakeRuntimeError() !== null
          && store.lightingBakeStatus.phase === 'error' && store.lightingBakeStatus.source === 'runtime'
          : runtime.getLightingBakeRuntimeError() === null && store.lightingBakeStatus.phase !== 'error');
    }, { expectedLabel, hasResult, isStale, maps }, { timeout: 90_000 });
    await manager.getByText(expectedLabel, { exact: true }).first().waitFor({ state: 'visible' });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  };
  const capture = async name => {
    const file = path.join(runRoot, name + '.png');
    await page.screenshot({ path: file });
    report.screenshots.push(file);
    const snapshot = await page.evaluate(() => {
      const state = window.lightingStateSmoke, store = state.store.getState(), scene = state.runtime.scene;
      const active = scene.getActiveMeshes(), activeSet = new Set(active.data.slice(0, active.length));
      const maps = scene.meshes.filter(mesh => mesh.metadata?.lightingDerived && mesh.isVerticesDataPresent('lightingBakeUV'));
      const engine = scene.getEngine(), gl = engine._gl;
      return {
        label: window.document.querySelector('.lighting-manager-summary .lighting-manager-badge')?.textContent,
        status: store.lightingBakeStatus, quality: store.scene.sceneSettings.lighting.bake.quality,
        signature: state.signature(store.scene), result: store.scene.sceneSettings.lighting.result,
        runtimeError: state.runtime.getLightingBakeRuntimeError(), ready: scene.isReady(),
        requests: { lighting: store.lightingBakeRequest, hasLegacyShadowRequest: Object.hasOwn(store, 'shadowBakeRequest') },
        bakeProgressCount: state.progress.length, historyDepth: store.history.undoStack.length,
        maps: maps.map(mesh => {
          const effect = mesh.subMeshes?.map(sub => sub.effect).find(Boolean);
          const location = effect?.getUniform('lightingBakeActive'), program = effect?.getPipelineContext()?.program;
          return { name: mesh.name, enabled: mesh.isEnabled(), visible: mesh.isVisible, rendered: activeSet.has(mesh),
            mapShader: Boolean(effect?.defines?.includes('BAKED_INDIRECT_MAP')),
            active: location && program ? gl.getUniform(program, location) : null };
        }),
        gpu: { webGLVersion: engine.webGLVersion, info: engine.getGlInfo(), contextLost: gl.isContextLost() },
      };
    });
    report.states.push({ name, snapshot });
    assert.equal(snapshot.requests.lighting, null);
    assert.equal(snapshot.requests.hasLegacyShadowRequest, false, '旧太阳阴影任务状态必须已移除');
    assert.equal(snapshot.bakeProgressCount, 0, '状态操作不应调用新的 Blender 烘焙');
    if (snapshot.label === '可用') {
      assert.deepEqual(snapshot.result, sourceBake, '撤销后必须恢复原结果及全部资产引用');
      assert.equal(snapshot.signature, sourceBake.signature);
      assert.equal(snapshot.runtimeError, null);
      assert.ok(snapshot.maps.length === sourceBake.surfaces.length && snapshot.maps.every(mesh => mesh.enabled && mesh.visible));
      const rendered = snapshot.maps.filter(mesh => mesh.rendered);
      assert.ok(rendered.length > 0 && rendered.every(mesh => mesh.mapShader && mesh.active === 1), '恢复态必须实际绘制原GI');
    }
    assert.equal(snapshot.gpu.webGLVersion, 2);
    assert.equal(snapshot.gpu.contextLost, false);
    assert.doesNotMatch(JSON.stringify(snapshot.gpu.info), /swiftshader|llvmpipe|software|WARP/i);
    await saveReport();
    return snapshot;
  };

  await waitState('可用', true, false, sourceBake.surfaces.length);
  const initial = await capture('01-ready');
  check('真实保存场景初始可用，原静态GI完整绘制');
  const changedQuality = initial.quality === 'high' ? 'standard' : 'high';
  await manager.getByRole('combobox', { name: '烘焙质量', exact: true }).selectOption(changedQuality);
  await manager.getByRole('button', { name: '应用配置', exact: true }).click();
  await waitState('已过期', true, true, 0);
  const stale = await capture('02-stale');
  assert.equal(stale.quality, changedQuality);
  assert.equal(stale.status.source, 'runtime');
  check('UI修改质量后显示已过期，运行时诊断不能盖成更新失败');
  await closeManager();
  await page.keyboard.press('Control+z');
  await openOverview();
  await waitState('可用', true, false, sourceBake.surfaces.length);
  const firstUndo = await capture('03-undo-quality');
  assert.equal(firstUndo.quality, initial.quality);
  check('Ctrl+Z恢复原质量、结果和GI，运行时错误已清除');
  await manager.getByRole('tab', { name: '任务与资源', exact: true }).click();
  await manager.getByRole('button', { name: '清除烘焙结果', exact: true }).click();
  await manager.getByRole('tab', { name: '总览与烘焙', exact: true }).click();
  await waitState('未烘焙', false, false, 0);
  await capture('04-cleared');
  check('UI清除结果后显示未烘焙，并撤下GI');
  await closeManager();
  await page.keyboard.press('Control+z');
  await openOverview();
  await waitState('可用', true, false, sourceBake.surfaces.length);
  await capture('05-undo-clear');
  check('Ctrl+Z恢复清除前的原资源和真实GI画面');
  if (unifiedSmoke) {
    await manager.locator('summary').filter({ hasText: /^场景照明/ }).click();
    await manager.getByRole('combobox', { name: '主光来源', exact: true }).scrollIntoViewIfNeeded();
    const file = path.join(runRoot, '06-lighting-controls.png');
    await page.screenshot({ path: file }); report.screenshots.push(file);
  }
  assert.equal(await label.innerText(), '可用');
  report.rendererGone = await application.evaluate(() => globalThis.lightingStateGone);
  assert.deepEqual(report.rendererGone, []);
  assert.deepEqual(report.pageErrors, []);
  assert.deepEqual(report.consoleErrors, []);
  report.status = 'PASS';
} catch (error) {
  failure = error;
  report.status = 'FAIL';
  report.error = error.stack ?? String(error);
  if (page && !page.isClosed()) {
    try {
      const file = path.join(runRoot, 'failure.png');
      await page.screenshot({ path: file }); report.screenshots.push(file);
      report.failureState = await page.evaluate(() => {
        const state = window.lightingStateSmoke;
        return state ? { status: state.store.getState().lightingBakeStatus,
          runtimeError: state.runtime?.getLightingBakeRuntimeError(),
          body: window.document.body.innerText, logs: state.store.getState().logs.slice(0, 15) } : null;
      });
    } catch (captureError) { report.failureCaptureError = String(captureError); }
  }
} finally {
  observeErrors = false;
  const cleanupErrors = [];
  try { await application?.close(); } catch (error) { cleanupErrors.push(String(error)); }
  try { await server?.close(); } catch (error) { cleanupErrors.push(String(error)); }
  try { if (bootstrap) await unlink(bootstrap); } catch (error) { cleanupErrors.push(String(error)); }
  try {
    report.sourceHashAfter = createHash('sha256').update(await readFile(scenePath)).digest('hex');
    assert.equal(report.sourceHashAfter, sourceHash, '状态验收不能写回原场景文件');
  } catch (error) { cleanupErrors.push(String(error)); }
  if (cleanupErrors.length) {
    report.cleanupErrors = cleanupErrors;
    failure ??= new Error(cleanupErrors.join('；'));
    report.status = 'FAIL';
  }
  report.finishedAt = new Date().toISOString();
  await saveReport();
}
if (failure) throw failure;
console.log('LIGHTING_BAKE_STATE_PASS ' + path.join(output, 'state-result.json'));
