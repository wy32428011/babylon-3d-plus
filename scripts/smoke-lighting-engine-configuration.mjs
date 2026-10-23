/* global window */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createConnection } from 'node:net';
import { pathToFileURL } from 'node:url';
import { _electron as electron } from 'playwright';
import { createServer } from 'vite';
import { createLiftBroker, createLiftFixture } from '../tests/helpers/liftMotionArrowFixture.mjs';
import { findLightingSmokePort } from '../tests/helpers/lightingSmokePort.mjs';
import { runLightingViewerSmoke } from '../tests/helpers/lightingViewerSmoke.mjs';
import { engineConfiguration, engineDialog, runLightingEngineConfigurationUiSmoke,
  runLightingEnginePublishCheckSmoke } from '../tests/helpers/lightingEngineConfigurationSmoke.mjs';

// 只替代系统文件选择器；实际 EditorLayout、preload、IPC、Blender、导出及 WebGL 均运行正式实现。
const workspace = path.resolve(import.meta.dirname, '..');
const runId = Date.now() + '-' + randomUUID().slice(0, 8);
const output = path.join(workspace, 'output', 'lighting-engine-configuration', runId);
const temporary = await mkdtemp(path.join(tmpdir(), 'lighting-engine-configuration-'));
const userData = path.join(temporary, 'user-data'), isolatedProgramFiles = path.join(temporary, 'program-files');
const projectRoot = path.join(temporary, 'project'), scenePath = path.join(projectRoot, 'Scenes', 'engine.scene.json');
const uiExportParent = path.join(temporary, 'ui-export');
const originalProgramFiles = process.env.ProgramFiles ?? 'C:\\Program Files';
const report = { status: 'RUNNING', runId, startedAt: new Date().toISOString(), output, temporary,
  userData, projectRoot, scenePath, uiExportParent, checks: [], screenshots: [], pageErrors: [], consoleErrors: [], launches: [],
  limits: ['仅本机隔离工程和本地 DIST 导出；不向数据中台远端提交或发布。'] };
let application, page, server, broker, bootstrap, fixtureContent;
const check = name => { report.checks.push(name); console.log('[lighting-engine] ' + name); };
const save = () => writeFile(path.join(output, 'result.json'), JSON.stringify(report, null, 2));
const capture = async name => {
  const file = path.join(output, name + '.png');
  await page.screenshot({ path: file }); report.screenshots.push(file);
};
const inside = (root, target) => {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep);
};

function running(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

function checkClosedPort(url) {
  return new Promise(resolve => {
    const parsed = new URL(url), socket = createConnection({ host: parsed.hostname, port: Number(parsed.port) });
    let settled = false;
    const finish = result => { if (!settled) { settled = true; socket.destroy(); resolve({ url, ...result }); } };
    socket.once('connect', () => finish({ closed: false }));
    socket.once('error', error => finish({ closed: error.code === 'ECONNREFUSED', error: error.code }));
    socket.setTimeout(1500, () => finish({ closed: false, error: 'timeout' }));
  });
}

async function recordOwnedProcesses() {
  if (!application) return;
  report.launches.at(-1).processes = await application.evaluate(({ app }) => app.getAppMetrics().map(item => ({ pid: item.pid, type: item.type })));
}

async function locateBlender() {
  if (process.env.LIGHTING_ENGINE_SMOKE_BLENDER_PATH) return path.resolve(process.env.LIGHTING_ENGINE_SMOKE_BLENDER_PATH);
  const base = path.join(originalProgramFiles, 'Blender Foundation');
  for (const name of (await readdir(base)).filter(name => /^Blender \d/.test(name)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))) {
    const candidate = path.join(base, name, 'blender.exe');
    if ((await stat(candidate).catch(() => null))?.isFile()) return candidate;
  }
  throw new Error('需要真实 Blender 4+；可用 LIGHTING_ENGINE_SMOKE_BLENDER_PATH 指定现存 blender.exe。');
}

async function launch(blenderPath) {
  const environment = { ...process.env, VITE_DEV_SERVER_URL: server.resolvedUrls.local[0], OPEN_DEVTOOLS: 'false', ProgramFiles: isolatedProgramFiles };
  delete environment.BABYLON_BLENDER_PATH; delete environment.ELECTRON_RUN_AS_NODE; delete environment.EDITOR_ALLOW_SOFTWARE_WEBGL;
  application = await electron.launch({ args: [bootstrap, `--user-data-dir=${userData}`], cwd: workspace, env: environment, timeout: 90_000 });
  const launchState = await application.evaluate(async ({ app, BrowserWindow, dialog }, options) => {
    globalThis.lightingEngineSmokeGone = [];
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.setBackgroundThrottling(false);
      win.webContents.on('render-process-gone', (_event, details) => globalThis.lightingEngineSmokeGone.push(details));
    }
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: options.scenePath });
    dialog.showOpenDialog = async (...args) => {
      const settings = args.at(-1);
      if (settings?.title === '选择 Web 部署工程输出目录') return { canceled: false, filePaths: [options.exportParent] };
      if (settings?.properties?.includes('openDirectory')) return { canceled: false, filePaths: [options.projectRoot] };
      if (/Blender/i.test(settings?.title ?? '') || settings?.filters?.some(filter => filter.extensions.includes('exe'))) {
        return { canceled: false, filePaths: [options.blenderPath] };
      }
      return { canceled: false, filePaths: [options.scenePath] };
    };
    await globalThis.lightingEngineSmokeMain.assets.activateProjectRoot(options.projectRoot);
    globalThis.lightingEngineSmokeMain.registry.authorizeAssetRoot(options.projectRoot);
    return { userData: app.getPath('userData'), pid: process.pid, programFiles: process.env.ProgramFiles };
  }, { projectRoot, scenePath, blenderPath, exportParent: uiExportParent });
  assert.equal(launchState.userData, userData, '不得使用用户真实编辑器配置');
  report.launches.push(launchState);
  page = await application.firstWindow(); page.setDefaultTimeout(60_000);
  await page.setViewportSize({ width: 1440, height: 960 });
  page.on('pageerror', error => report.pageErrors.push(error.stack ?? error.message));
  page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(message.text()); });
  await page.getByRole('button', { name: '进入空白编辑器', exact: true }).click();
  await page.locator('canvas.scene-canvas').waitFor();
  await page.evaluate(async ({ content, scenePath }) => {
    const { useEditorStore } = await import('/src/editor/store/editorStore.ts');
    const { SceneRuntime } = await import('/src/runtime/babylon/SceneRuntime.ts');
    const { createEmptySceneDocument } = await import('/src/editor/model/SceneDocument.ts');
    const { serializeScene, deserializeScene } = await import('/src/editor/project/SceneSerializer.ts');
    const original = SceneRuntime.prototype.getLightingClassification;
    const state = { store: useEditorStore, runtime: null, progress: [] };
    SceneRuntime.prototype.getLightingClassification = function () { state.runtime = this; return original.call(this); };
    window.lightingSmoke = state;
    window.editorApi.onLightingBakeProgress(event => { state.progress.push(event); console.log('[lighting-progress]', event.phase, event.progress, event.message); });
    const legacy = JSON.parse(content), canonical = JSON.parse(serializeScene(createEmptySceneDocument(legacy.scene.name)));
    delete canonical.scene.sceneSettings.lighting; delete canonical.scene.sceneSettings.appearance;
    canonical.scene = { ...canonical.scene, ...legacy.scene,
      sceneSettings: { ...canonical.scene.sceneSettings, ...legacy.scene.sceneSettings } };
    if (!useEditorStore.getState().loadSceneFromContent(serializeScene(deserializeScene(JSON.stringify(canonical))), scenePath)) {
      throw new Error(JSON.stringify(useEditorStore.getState().logs.slice(0, 5)));
    }
  }, { content: fixtureContent, scenePath });
  await page.waitForFunction(() => window.lightingSmoke.runtime && !window.lightingSmoke.runtime.getInitialLoadSnapshot().progress.loading
    && window.lightingSmoke.store.getState().lightingClassification.some(entry => entry.name.includes('LiftColumn') && entry.mobility === 'static'), null, { timeout: 180_000 });
  await page.getByRole('button', { name: '取消加载并返回首页', exact: true }).waitFor({ state: 'hidden', timeout: 180_000 });
  const notice = page.getByRole('button', { name: '关闭场景资源提示', exact: true });
  if (await notice.isVisible()) await notice.click();
}

try {
  await Promise.all([mkdir(output, { recursive: true }), mkdir(userData), mkdir(isolatedProgramFiles),
    mkdir(path.dirname(scenePath), { recursive: true }), mkdir(uiExportParent, { recursive: true })]);
  await save();
  const blenderPath = await locateBlender();
  assert.ok((await stat(blenderPath)).isFile()); report.blenderPath = blenderPath;
  const port = await findLightingSmokePort();
  server = await createServer({ server: { host: '127.0.0.1', port, strictPort: true, hmr: false },
    optimizeDeps: { noDiscovery: true, include: ['react', 'react-dom/client', 'react/jsx-runtime', '@babylonjs/core', '@babylonjs/loaders', '@linkiez/dxf-renew', 'typescript', 'mqtt', 'zustand'] } });
  broker = createLiftBroker(server.httpServer); await server.listen(); await server.watcher.close();
  report.viteUrl = server.resolvedUrls.local[0];
  const fixture = await createLiftFixture(projectRoot);
  fixture.scene.name = '本机 Blender 配置验收'; fixture.scene.selectedEntityId = null;
  fixture.scene.mqttConfig.address = `ws://127.0.0.1:${server.httpServer.address().port}/__lift_mqtt__`;
  fixture.scene.sceneSettings = { shadows: { enabled: true, mode: 'hybrid', quality: 'balanced', sunAzimuthDegrees: 225, sunElevationDegrees: 45 },
    lightingBake: { enabled: true, quality: 'preview', atlasSize: 1024, texelsPerMeter: 8, probeSpacing: 6, maxTextureMiB: 128, cacheStaticShadows: true, dynamicShadows: true, device: 'cpu' } };
  for (const [id, color, position, scale] of [
    ['静态地面', '#8d9297', { x: 0, y: -0.15, z: 0 }, { x: 15, y: 0.3, z: 10 }],
    ['静态墙体', '#9c5f42', { x: 0, y: 2.5, z: 4 }, { x: 15, y: 5, z: 0.3 }],
  ]) {
    fixture.scene.entities[id] = { id, name: id, parentId: null, childrenIds: [], visible: true, locked: false,
      components: { transform: { position, rotation: { x: 0, y: 0, z: 0 }, scale }, meshRenderer: { meshKind: 'cube', materialColor: color } } };
    fixture.scene.entityIds.push(id);
  }
  fixtureContent = JSON.stringify(fixture); await writeFile(scenePath, fixtureContent);
  bootstrap = path.join(workspace, `.tmp-lighting-engine-${randomUUID()}.mjs`);
  // Windows 启动 Electron 时可能重建 ProgramFiles；在本次专用主进程内明确隔离自动发现。
  await writeFile(bootstrap, `import { app } from 'electron';\napp.setPath('userData', ${JSON.stringify(userData)});\n`
    + `process.env.ProgramFiles = ${JSON.stringify(isolatedProgramFiles)};\ndelete process.env.BABYLON_BLENDER_PATH;\n`
    + `const assets = await import(${JSON.stringify(pathToFileURL(path.join(workspace, 'dist-electron/ipc/projectAssetStore.js')).href)});\n`
    + `const registry = await import(${JSON.stringify(pathToFileURL(path.join(workspace, 'dist-electron/ipc/assetRegistry.js')).href)});\n`
    + `globalThis.lightingEngineSmokeMain = { assets, registry };\nawait import(${JSON.stringify(pathToFileURL(path.join(workspace, 'dist-electron/main.js')).href)});\n`, { flag: 'wx' });
  await launch(blenderPath);
  assert.ok(inside(userData, (await engineConfiguration(page)).configPath), '正式 IPC 配置文件必须位于本次隔离 userData');
  report.configuration = await runLightingEngineConfigurationUiSmoke({ page, blenderPath,
    invalidPath: path.join(temporary, 'missing', 'blender.exe'), capture, check });
  assert.ok(inside(userData, report.configuration.configuration.configPath));
  report.initialRendererGone = await application.evaluate(() => globalThis.lightingEngineSmokeGone);
  assert.deepEqual(report.initialRendererGone, []);
  await recordOwnedProcesses();
  await application.close(); application = null;
  await launch(blenderPath);
  report.afterRestart = await engineConfiguration(page);
  assert.equal(report.afterRestart.configuredPath, blenderPath); assert.equal(report.afterRestart.engine.available, true);
  check('整个本次 Electron 关闭并重启后，正式 IPC 读回已保存路径且引擎可用');
  await page.getByRole('button', { name: '光照与烘焙管理器', exact: true }).click();
  const manager = page.getByRole('dialog', { name: '光照与烘焙管理器', exact: true });
  await manager.getByRole('button', { name: '配置引擎…', exact: true }).click();
  await application.evaluate((_electron, directory) => { process.env.ProgramFiles = directory; }, originalProgramFiles);
  await engineDialog(page).getByRole('button', { name: '恢复自动查找', exact: true }).click();
  await engineDialog(page).getByRole('button', { name: '保存并关闭', exact: true }).click();
  await engineDialog(page).waitFor({ state: 'hidden', timeout: 90_000 });
  report.afterAutomatic = await engineConfiguration(page);
  assert.equal(report.afterAutomatic.configuredPath, null); assert.equal(report.afterAutomatic.engine.available, true);
  assert.equal(report.afterAutomatic.source, 'installation');
  assert.equal(report.afterAutomatic.engine.path, blenderPath);
  const automaticFile = await readFile(report.afterAutomatic.configPath, 'utf8').catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
  assert.ok(!automaticFile || !JSON.parse(automaticFile).blenderPath);
  await capture('engine-automatic');
  await manager.getByRole('button', { name: '关闭光照与烘焙管理器', exact: true }).click();
  check('恢复自动查找并保存后清除显式路径，由真实安装目录重新发现 Blender');
  await application.evaluate((_electron, directory) => { process.env.ProgramFiles = directory; }, isolatedProgramFiles);
  assert.equal((await engineConfiguration(page)).engine.available, false);
  await runLightingEnginePublishCheckSmoke({ page, blenderPath, capture, check });
  await page.getByRole('button', { name: '光照与烘焙管理器', exact: true }).click();
  await manager.getByRole('tab', { name: '总览与烘焙', exact: true }).click();
  await manager.getByRole('button', { name: '开始烘焙', exact: true }).click();
  await page.waitForFunction(() => window.lightingSmoke.progress.some(event => event.phase === 'baking'), null, { timeout: 90_000 });
  await page.waitForFunction(() => !window.lightingSmoke.store.getState().lightingBakeRequest, null, { timeout: 900_000 });
  report.bake = await page.evaluate(() => ({ status: window.lightingSmoke.store.getState().lightingBakeStatus,
    result: window.lightingSmoke.store.getState().scene.sceneSettings.lighting.result,
    runtimeError: window.lightingSmoke.runtime.getLightingBakeRuntimeError() }));
  assert.equal(report.bake.status.phase, 'idle', JSON.stringify(report.bake));
  assert.ok(report.bake.result?.surfaces.length > 0, JSON.stringify(report.bake));
  assert.equal(report.bake.runtimeError, null); await page.evaluate(() => window.lightingSmoke.runtime.waitForLightingReady());
  await capture('engine-real-bake');
  await manager.getByRole('button', { name: '关闭光照与烘焙管理器', exact: true }).click();
  await page.getByRole('button', { name: '保存场景', exact: true }).click();
  await page.waitForFunction(() => {
    const state = window.lightingSmoke.store.getState(), signature = state.scene.sceneSettings.lighting.result?.signature;
    return signature && state.persistedSceneContent?.includes(signature);
  });
  assert.ok(JSON.parse(await readFile(scenePath, 'utf8')).scene.sceneSettings.lighting.result?.assets.length);
  check('配置路径由真实 UI 触发正式 IPC 和 Cycles 烘焙，结果应用并通过正式保存落盘');
  await page.getByRole('button', { name: '导出离线部署包', exact: true }).click();
  const publish = page.getByRole('dialog', { name: '导出部署工程', exact: true });
  await publish.getByRole('textbox', { name: '工程名称', exact: true }).fill('engine-configuration-dist');
  await publish.getByRole('button', { name: '开始导出', exact: true }).click();
  await page.waitForFunction(() => {
    const dialog = window.document.querySelector('.deployment-export-dialog');
    return dialog?.textContent?.includes('部署工程已生成，可打开结果位置继续部署。') || Boolean(dialog?.querySelector('[role="alert"]'));
  }, null, { timeout: 180_000 });
  assert.equal(await publish.getByText('部署工程已生成，可打开结果位置继续部署。', { exact: true }).isVisible(), true,
    await publish.innerText());
  await capture('engine-export-success');
  const exported = await readdir(uiExportParent);
  assert.ok(exported.length > 0, '正式 UI 导出必须生成实际部署目录'); report.uiExports = exported.map(name => path.join(uiExportParent, name));
  await publish.getByRole('button', { name: '关闭导出部署工程对话框', exact: true }).click();
  check('真实本地发布 UI 点击开始导出，正式 DIST 工程生成成功且无缺少引擎阻断');
  report.viewer = await runLightingViewerSmoke({ application, editorPage: page, scenePath, projectRoot, output, broker });
  check('正式 DIST 在独立 Edge 硬件 WebGL 加载全部烘焙资产，MQTT 升降和回落保持 GI 有效');
  report.gpu = await page.evaluate(() => window.lightingSmoke.runtime.scene.getEngine().getGlInfo());
  assert.doesNotMatch(report.gpu.renderer, /swiftshader|llvmpipe|software/i);
  report.rendererGone = await application.evaluate(() => globalThis.lightingEngineSmokeGone);
  assert.deepEqual(report.rendererGone, []); assert.deepEqual(report.pageErrors, []); assert.deepEqual(broker.errors, []);
  report.status = 'PASS';
} catch (error) {
  report.status = 'FAIL'; report.failure = error.stack ?? String(error);
  if (page && !page.isClosed()) {
    report.failureText = await page.locator('body').innerText().catch(() => null);
    report.diagnostics = await page.evaluate(() => {
      const state = window.lightingSmoke?.store.getState();
      return state ? { logs: state.logs.slice(0, 20), status: state.lightingBakeStatus, issues: state.sceneResourceIssues } : null;
    }).catch(() => null);
    await capture('failure').catch(() => {});
  }
  throw error;
} finally {
  const cleanupErrors = [];
  try { await recordOwnedProcesses(); } catch (error) { cleanupErrors.push(error.stack ?? String(error)); }
  if (page && !page.isClosed()) {
    try { await page.evaluate(() => window.lightingSmoke?.store.getState().cancelLightingBake()); }
    catch (error) { cleanupErrors.push(error.stack ?? String(error)); }
  }
  for (const cleanup of [() => application?.close(), () => broker?.close(), () => server?.close(), () => bootstrap && unlink(bootstrap)]) {
    try { await cleanup(); } catch (error) { cleanupErrors.push(error.stack ?? String(error)); }
  }
  try {
    report.cleanupVerification = {
      electronProcesses: [...new Map(report.launches.flatMap(launch => launch.processes ?? [{ pid: launch.pid, type: 'Browser' }]).map(item => [item.pid, item])).values()]
        .map(item => ({ ...item, running: running(item.pid) })),
      ports: await Promise.all([report.viteUrl, report.viewer?.base].filter(Boolean).map(checkClosedPort)),
      viewerHelperClosed: report.viewer ? report.viewer.status === 'PASS' && !report.viewer.cleanupErrors : null,
      bootstrapRemoved: bootstrap ? await stat(bootstrap).then(() => false, error => error.code === 'ENOENT') : true,
    };
    assert.ok(report.cleanupVerification.electronProcesses.every(item => !item.running), '本次 Electron 进程应全部退出');
    assert.ok(report.cleanupVerification.ports.every(item => item.closed), '本次 loopback 服务应全部关闭');
    assert.equal(report.cleanupVerification.bootstrapRemoved, true);
  } catch (error) { cleanupErrors.push(error.stack ?? String(error)); }
  if (cleanupErrors.length) { report.cleanupErrors = cleanupErrors; report.status = 'FAIL'; process.exitCode = 1; }
  report.finishedAt = new Date().toISOString(); await save();
  console.log('[lighting-engine] ' + report.status + ' ' + path.join(output, 'result.json'));
}
