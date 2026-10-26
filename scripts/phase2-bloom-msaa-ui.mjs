/* global window, document, WebGL2RenderingContext */
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { _electron, chromium } from 'playwright';
import unzipper from 'unzipper';
import { createBusinessGiViewerServer } from '../tests/helpers/phase2GiViewer.mjs';
import { normalizeSceneAppearanceConfig, normalizeSceneLightingConfig } from '../dist-electron/shared/sceneLightingConfig.js';

const { values } = parseArgs({ options: { scene: { type: 'string' }, output: { type: 'string' } } });
assert.ok(values.scene && values.output, '--scene / --output 必填');
const repository = process.cwd(), output = path.resolve(values.output), source = path.resolve(values.scene);
const relative = path.relative(path.resolve('output'), output);
assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), '输出必须是仓库output内新目录');
await fs.mkdir(path.dirname(output), { recursive: true }); await fs.mkdir(output);
const original = await fs.readFile(source), hash = data => createHash('sha256').update(data).digest('hex');
const documentInput = JSON.parse(original), fixture = structuredClone(documentInput);
assert.ok(fixture.scene?.entities && fixture.scene.entityIds?.length, '必须是有效小模型场景');
assert.ok(!fixture.scene.sceneSettings?.lighting?.result, '必须使用无GI结果的独立功能夹具');
fixture.scene.name = 'Bloom MSAA 实际界面验收'; fixture.scene.selectedEntityId = null;
fixture.scene.mqttConfig = { ...fixture.scene.mqttConfig, enabled: false, simulatorEnabled: false };
fixture.scene.sceneSettings ??= {};
fixture.scene.sceneSettings.lighting = normalizeSceneLightingConfig(fixture.scene.sceneSettings.lighting);
fixture.scene.sceneSettings.lighting.bake.enabled = false; fixture.scene.sceneSettings.lighting.allowDayNightCycle = false;
fixture.scene.sceneSettings.appearance = normalizeSceneAppearanceConfig({ exposure: 1.2, bloomEnabled: false, bloomWeight: .35 });
fixture.scene.sceneSettings.camera = { savedPose: { alpha: .8, beta: 1.1, radius: 6, target: { x: 0, y: .7, z: 0 } },
  savedOrientation: 'orbit', savedProjection: 'perspective', viewDistance: 1000 };
fixture.scene.sceneSettings.openingAnimation = { ...fixture.scene.sceneSettings.openingAnimation, enabled: false };
fixture.scene.sceneSettings.modelEntrance = { ...fixture.scene.sceneSettings.modelEntrance, enabled: false };
const cubeId = 'phase2-bloom-alias-cube';
assert.ok(!fixture.scene.entities[cubeId], '输入必须是原小场景，而非本工具已经生成的夹具');
fixture.scene.entities[cubeId] = { id: cubeId, name: '受控白色边缘夹具', visible: true, locked: false, parentId: null, childrenIds: [],
  components: { transform: { position: { x: 0, y: .8, z: 0 }, rotation: { x: .18, y: .35, z: .12 }, scale: { x: 1.3, y: 1.6, z: 1.3 } },
    meshRenderer: { meshKind: 'cube', materialColor: '#ffffff' } } };
fixture.scene.entityIds.push(cubeId);
const userData = path.join(output, 'userdata'), project = path.join(output, 'project'), sceneFile = path.join(project, 'Scenes', 'bloom-ui.scene.json');
await fs.mkdir(path.dirname(sceneFile), { recursive: true }); await fs.mkdir(userData);
await fs.writeFile(sceneFile, JSON.stringify(fixture, null, 2));
await fs.writeFile(path.join(userData, 'recent-workspaces.json'), JSON.stringify({ version: 1, projects: [], scenes: [{ filePath: sceneFile, lastOpenedAt: new Date().toISOString() }] }));
await fs.writeFile(path.join(userData, 'data-platform-config.json'), JSON.stringify({ version: 2, baseUrl: '', workspaceRoot: project }));
const report = { status: 'RUNNING', scope: 'real Editor UI / saved scene / actual DIST standalone+iframe Bloom MSAA; functional allocation proof, not formal performance A/B',
  source, sourceSha256: hash(original), fixtureConditions: 'independent non-GI scene copy, MQTT/day-night/entrance disabled; fixed camera plus white primitive for visible 3D edges; original models unchanged',
  output, stages: [], cases: [], browserCases: [], dialogs: [], consoleErrors: [], pageErrors: [], requestFailures: [], rendererGone: [], allocations: [], errors: [] };
let app, page, browser, server;
const saveReport = () => fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
async function stage(name) { report.stages.push(name); console.log('[bloom-msaa] ' + name); await saveReport(); }
const bootstrap = path.join(output, 'bootstrap.mjs');
await fs.writeFile(bootstrap, "import {app} from 'electron';\napp.setPath('userData'," + JSON.stringify(userData) + ');\n'
  + 'app.getAppPath=()=>'+JSON.stringify(repository)+';\n'
  + 'globalThis.phase2BloomHost={shared:await import('+JSON.stringify(pathToFileURL(path.join(repository,'dist-electron/shared/sceneLightingBakeContract.js')).href)+'),'
  + 'assets:await import('+JSON.stringify(pathToFileURL(path.join(repository,'dist-electron/ipc/projectAssetStore.js')).href)+'),'
  + 'dist:await import('+JSON.stringify(pathToFileURL(path.join(repository,'dist-electron/ipc/digitalTwinDistPackage.js')).href)+'),dialogs:[]};\n'
  + 'await globalThis.phase2BloomHost.assets.activateProjectRoot('+JSON.stringify(project)+');\n'
  + 'await import('+JSON.stringify(pathToFileURL(path.join(repository,'dist-electron/main.js')).href)+');\n', { flag: 'wx' });

try {
  const env = { ...process.env, OPEN_DEVTOOLS: 'false', VITE_DEV_SERVER_URL: '' }; delete env.ELECTRON_RUN_AS_NODE;
  app = await _electron.launch({ args: [bootstrap, '--user-data-dir=' + userData], cwd: repository, env, timeout: 120000 });
  report.applicationPid = app.process().pid;
  report.native = await app.evaluate(({ app, dialog, BrowserWindow }, file) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.setBackgroundThrottling(false);
      win.webContents.on('render-process-gone', (_event, details) => { globalThis.phase2BloomHost.rendererGone ??= []; globalThis.phase2BloomHost.rendererGone.push(details); });
    }
    dialog.showSaveDialog = async () => { globalThis.phase2BloomHost.dialogs.push({ type: 'native-save', path: file }); return { canceled: false, filePath: file }; };
    return { versions: process.versions, appPath: app.getAppPath(), userData: app.getPath('userData') };
  }, sceneFile);
  page = await app.firstWindow(); page.setDefaultTimeout(45000);
  page.on('pageerror', error => report.pageErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(message.text()); });
  page.on('requestfailed', request => report.requestFailures.push({ url: request.url().split(/[?#]/)[0], error: request.failure()?.errorText }));
  page.on('dialog', dialog => { report.dialogs.push({ type: dialog.type(), message: dialog.message() }); void dialog.dismiss(); });
  await page.setViewportSize({ width: 1440, height: 960 }); await page.bringToFront();
  await page.waitForLoadState('networkidle');
  report.homeButtons = await page.getByRole('button').allTextContents();
  await page.addInitScript(installNativeAllocationSpy); await page.evaluate(installNativeAllocationSpy);
  await openRecent(); await stage('editor-ready');
  report.initial = await page.evaluate(readState, cubeId);
  assert.equal(report.initial.appearance.bloomMsaaEnabled, undefined, '初始旧字段必须缺失');
  const signatureBefore = await signatureFromPage();
  await openAppearance();
  await page.getByRole('checkbox', { name: '柔和泛光', exact: true }).check(); await applyManager();
  await closeManager();
  const baseline = await capture('editor-bloom-baseline');
  assert.equal(baseline.state.msaa.configuredSamples, 1); assert.equal(baseline.state.fxaa, true);
  assert.equal(await signatureFromPage(), signatureBefore);
  await stage('baseline-samples-1');

  await setMsaa(true, 'editor-enable');
  const enabled = await capture('editor-enabled');
  assert.equal(enabled.state.appearance.bloomMsaaEnabled, true); assert.equal(enabled.state.msaa.configuredSamples, 4);
  assert.ok(enabled.allocations.some(row => row.phase === 'editor-enable' && row.requestedSamples === 4 && row.actualSamples === 4), '必须由开关阶段原生调用后的RENDERBUFFER_SAMPLES证明4×实际分配');
  enabled.differenceFromBaseline = compare(enabled.bytes, baseline.bytes); delete enabled.bytes;
  assert.equal(await signatureFromPage(), signatureBefore);
  await stage('actual-msaa-4-allocation');

  await page.getByRole('button', { name: '撤销 (Ctrl+Z)', exact: true }).click();
  await waitMsaa(1); const undo = await capture('editor-undo');
  undo.differenceFromBaseline = compare(undo.bytes, baseline.bytes); assert.equal(undo.differenceFromBaseline.changedPixels, 0); delete undo.bytes;
  await page.getByRole('button', { name: '重做', exact: true }).click(); await waitMsaa(4);
  report.undoRedo = { undoSamples: 1, redoSamples: (await page.evaluate(readState, cubeId)).msaa.configuredSamples };
  await setMsaa(false, 'editor-disable');
  const disabled = await capture('editor-disabled'); disabled.differenceFromBaseline = compare(disabled.bytes, baseline.bytes);
  assert.equal(disabled.differenceFromBaseline.changedPixels, 0, '关闭后整个3D buffer必须回到原Bloom基线'); delete disabled.bytes;
  await stage('disable-and-undo-redo');

  await setMsaa(true, 'editor-save-enabled');
  await saveSceneThroughUi(true);
  const savedTrue = await fs.readFile(sceneFile), savedTrueFile = path.join(output, 'saved-enabled.scene.json');
  await fs.writeFile(savedTrueFile, savedTrue);
  const persisted = JSON.parse(savedTrue);
  assert.equal(persisted.scene.sceneSettings.appearance.bloomMsaaEnabled, true);
  report.savedEnabled = { path: savedTrueFile, bytes: savedTrue.length, sha256: hash(savedTrue) };
  const savedSignature = await app.evaluate((_electron, doc) => globalThis.phase2BloomHost.shared.getSceneLightingBakeSignature(doc.scene), persisted);
  assert.equal(savedSignature, signatureBefore); report.giSignature = { before: signatureBefore, saved: savedSignature, unchanged: true };
  await page.getByRole('button', { name: '返回首页', exact: true }).click();
  await page.locator('.home-recent-card').filter({ hasText: path.basename(sceneFile) }).waitFor({ state: 'visible' });
  await openRecent();
  const reopened = await capture('editor-reopened');
  assert.equal(reopened.state.appearance.bloomMsaaEnabled, true); assert.equal(reopened.state.msaa.configuredSamples, 4);
  assert.ok(reopened.allocations.some(row => row.requestedSamples === 4 && row.actualSamples === 4));
  delete reopened.bytes; await stage('saved-and-reopened');
  await setMsaa(false, 'editor-reopened-disable');
  const reopenedOff = await capture('editor-reopened-disabled'); reopenedOff.differenceFromBaseline = compare(reopenedOff.bytes, baseline.bytes);
  assert.equal(reopenedOff.differenceFromBaseline.changedPixels, 0, '重开后关闭选项的整个buffer必须一致'); delete reopenedOff.bytes; delete baseline.bytes;
  await saveSceneThroughUi(false);
  report.allocations = await page.evaluate(() => window.__phase2BloomSpy.records);
  report.editorSpyRestored = await page.evaluate(() => window.__phase2BloomSpy.restore());
  assert.equal(report.editorSpyRestored, true);
  report.dialogs.push(...await app.evaluate(() => globalThis.phase2BloomHost.dialogs));
  report.rendererGone = await app.evaluate(() => globalThis.phase2BloomHost.rendererGone ?? []);

  report.package = await app.evaluate(async (_electron, setup) => globalThis.phase2BloomHost.dist.buildDigitalTwinDistPackage({
    projectId: '123', publishName: 'BloomMSAA实际界面验收', sceneContent: setup.content, outputRoot: setup.output, signal: new AbortController().signal,
  }), { content: savedTrue.toString('utf8'), output: path.join(output, 'package') });
  await app.close(); app = null; page = null;
  const published = path.join(output, 'published'); await fs.mkdir(published);
  const archive = await unzipper.Open.file(report.package.filePath);
  for (const entry of archive.files) {
    const file = path.resolve(published, entry.path), inside = path.relative(published, file);
    assert.ok(inside && !inside.startsWith('..') && !path.isAbsolute(inside));
    if (entry.type === 'Directory') await fs.mkdir(file, { recursive: true });
    else { assert.equal(entry.type, 'File'); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, await entry.buffer()); }
  }
  await fs.writeFile(path.join(published, 'host.html'), '<!doctype html><body style="margin:0;background:#e020d0"><iframe title="Bloom MSAA实际Viewer" src="/?performance=1" width="960" height="640" style="border:0" sandbox="allow-scripts allow-same-origin allow-pointer-lock"></iframe>');
  const served = await createBusinessGiViewerServer(published, '123', []); server = served.server;
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  for (const host of ['standalone', 'iframe']) {
    const context = await browser.newContext({ viewport: { width: 980, height: 680 }, deviceScaleFactor: 1 });
    try {
      await context.addInitScript(installNativeAllocationSpy);
      const viewerPage = await context.newPage();
      viewerPage.on('pageerror', error => report.pageErrors.push(host + ': ' + error.message));
      viewerPage.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(host + ': ' + message.text()); });
      await viewerPage.goto(served.origin + (host === 'iframe' ? '/host.html' : '/?performance=1'));
      const frame = host === 'iframe' ? await (await viewerPage.waitForSelector('iframe')).contentFrame() : viewerPage.mainFrame();
      await frame.waitForFunction(findRuntime, null, { timeout: 180000, polling: 300 }); await frame.waitForTimeout(1000);
      const state = await frame.evaluate(readState, cubeId), pixels = await frame.evaluate(capturePixels, cubeId);
      assert.equal(state.appearance.bloomMsaaEnabled, true); assert.equal(state.msaa.configuredSamples, 4); assert.equal(state.fxaa, true);
      assert.ok(state.allocations.some(row => row.actualSamples === 4 && row.requestedSamples === 4));
      assert.ok(pixels.colors > 8 && pixels.cubeActive, 'Viewer必须有可见3D夹具，不能用空白canvas通过');
      const bytes = Buffer.from(pixels.base64, 'base64'); await fs.writeFile(path.join(output, host + '-enabled.rgba'), bytes);
      report.browserCases.push({ host, state, pixels: { width: pixels.width, height: pixels.height, colors: pixels.colors, cubeActive: pixels.cubeActive, sha256: hash(bytes) },
        spyRestored: await frame.evaluate(() => window.__phase2BloomSpy.restore()),
        hostSpyRestored: await viewerPage.evaluate(() => window.__phase2BloomSpy.restore()), status: 'PASS' });
      await viewerPage.screenshot({ path: path.join(output, host + '-enabled.png') });
    } finally { await context.close(); }
  }
  assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.consoleErrors, []); assert.deepEqual(report.requestFailures, []);
  assert.deepEqual(report.rendererGone, []);
  assert.equal(report.dialogs.filter(item => item.type !== 'native-save').length, 0, '不能隐藏未预期的浏览器对话框');
  report.status = 'PASS'; await stage('standalone-and-iframe-physical-msaa');
} catch (error) {
  report.status = 'FAIL'; report.error = error.stack ?? String(error); process.exitCode = 1;
  if (page && !page.isClosed()) { await page.screenshot({ path: path.join(output, 'failed.png') }).catch(() => {}); report.lastState = await page.evaluate(readState, cubeId).catch(() => null); }
} finally {
  if (page && !page.isClosed()) report.editorSpyRestored ??= await page.evaluate(() => window.__phase2BloomSpy?.restore?.() ?? false).catch(() => false);
  await app?.close(); await browser?.close(); if (server) await new Promise(resolve => server.close(resolve));
  report.sourceUnchanged = (await fs.readFile(source)).equals(original);
  if (!report.sourceUnchanged) { report.status = 'FAIL'; process.exitCode = 1; }
  await saveReport(); console.log(JSON.stringify({ status: report.status, output, cases: report.cases.length, browserCases: report.browserCases.length, error: report.error }));
}

async function openRecent() {
  const card = page.locator('.home-recent-card').filter({ hasText: path.basename(sceneFile) });
  await card.getByRole('button', { name: '打开', exact: true }).waitFor({ state: 'visible', timeout: 120000 });
  await card.getByRole('button', { name: '打开', exact: true }).click();
  await page.locator('canvas.scene-canvas').waitFor({ state: 'visible', timeout: 120000 });
  await page.waitForFunction(findRuntime, null, { timeout: 180000, polling: 300 }); await page.waitForTimeout(500);
}
async function openAppearance() {
  await page.getByRole('button', { name: '光照与烘焙管理器', exact: true }).click();
  const manager = page.getByRole('dialog', { name: '光照与烘焙管理器', exact: true }); await manager.waitFor({ state: 'visible' });
  const details = manager.locator('details').filter({ has: page.locator('summary', { hasText: '显示效果' }) }).first();
  if (await details.getAttribute('open') === null) await details.locator(':scope > summary').click();
  await page.getByRole('checkbox', { name: '柔和泛光', exact: true }).waitFor({ state: 'visible' });
}
async function applyManager() { await page.getByRole('button', { name: '应用配置', exact: true }).click(); await page.waitForTimeout(300); }
async function closeManager() { await page.getByRole('button', { name: '关闭光照与烘焙管理器', exact: true }).click(); }
async function setMsaa(enabled, phase) {
  await page.evaluate(value => { window.__phase2BloomSpy.phase = value; }, phase);
  await openAppearance(); await page.getByRole('checkbox', { name: '泛光抗锯齿（MSAA）', exact: true }).setChecked(enabled);
  await applyManager(); await closeManager(); await waitMsaa(enabled ? 4 : 1);
}
async function waitMsaa(samples) {
  await page.waitForFunction(expected => window.__phase2Bloom.runtime.environment.appearanceRuntime.getBloomMsaaState().configuredSamples === expected, samples);
  await page.waitForTimeout(500);
}
async function capture(name) {
  const state = await page.evaluate(readState, cubeId), pixels = await page.evaluate(capturePixels, cubeId);
  assert.ok(pixels.colors > 8 && pixels.cubeActive, '必须有实际三维像素与可见受控几何');
  const bytes = Buffer.from(pixels.base64, 'base64'); await fs.writeFile(path.join(output, name + '.rgba'), bytes);
  await page.screenshot({ path: path.join(output, name + '.png') });
  const result = { name, state, allocations: state.allocations, width: pixels.width, height: pixels.height,
    colors: pixels.colors, cubeActive: pixels.cubeActive, sha256: hash(bytes) };
  Object.defineProperty(result, 'bytes', { value: bytes, configurable: true });
  report.cases.push(result); await saveReport(); return result;
}
function compare(left, right) {
  assert.equal(left.length, right.length, '完整buffer尺寸必须一致'); let changedPixels = 0, maxChannelError = 0;
  for (let index = 0; index < left.length; index += 4) {
    let changed = false; for (let channel = 0; channel < 4; channel++) { const difference = Math.abs(left[index + channel] - right[index + channel]); changed ||= difference !== 0; maxChannelError = Math.max(maxChannelError, difference); }
    if (changed) changedPixels++;
  }
  return { pixels: left.length / 4, changedPixels, maxChannelError };
}
async function signatureFromPage() {
  const scene = await page.evaluate(() => window.__phase2Bloom.runtime.document.shadowDocument);
  return app.evaluate((_electron, value) => globalThis.phase2BloomHost.shared.getSceneLightingBakeSignature(value), scene);
}
async function saveSceneThroughUi(expected) {
  await page.getByRole('button', { name: '保存场景', exact: true }).click();
  const deadline = Date.now() + 30000;
  let lastIncompleteJson = null;
  while (Date.now() < deadline) {
    try {
      const saved = JSON.parse(await fs.readFile(sceneFile, 'utf8'));
      if (saved.scene.sceneSettings?.appearance?.bloomMsaaEnabled === expected) return;
    } catch (error) {
      // 原保存是异步writeFile；等待完整文件，不把截断到写完之间的短暂空串当作产品结果。
      if (!(error instanceof SyntaxError) && error.code !== 'ENOENT') throw error;
      lastIncompleteJson = error.message;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('真实保存入口未落盘完整JSON及预期Bloom MSAA布尔字段：' + (lastIncompleteJson ?? '字段未匹配'));
}
function installNativeAllocationSpy() {
  if (window.__phase2BloomSpy) return;
  const prototype = WebGL2RenderingContext.prototype, descriptor = Object.getOwnPropertyDescriptor(prototype, 'renderbufferStorageMultisample');
  const original = descriptor.value, ids = new WeakMap(); let next = 1;
  const state = { records: [], errors: [], phase: 'initial', idFor(gl) { if (!ids.has(gl)) ids.set(gl, next++); return ids.get(gl); }, restore() {
    if (prototype.renderbufferStorageMultisample === original) return true;
    if (prototype.renderbufferStorageMultisample !== wrapped) return false;
    Object.defineProperty(prototype, 'renderbufferStorageMultisample', descriptor); return prototype.renderbufferStorageMultisample === original;
  } };
  function wrapped(...args) {
    const result = Reflect.apply(original, this, args);
    try { state.records.push({ contextId: state.idFor(this), phase: state.phase, requestedSamples: args[1], actualSamples: this.getRenderbufferParameter(args[0], this.RENDERBUFFER_SAMPLES),
      internalFormat: args[2], width: args[3], height: args[4] }); } catch (error) { state.errors.push(String(error)); }
    return result;
  }
  Object.defineProperty(prototype, 'renderbufferStorageMultisample', { ...descriptor, value: wrapped }); window.__phase2BloomSpy = state;
}
function findRuntime() {
  const root = document.getElementById('root'), key = Object.keys(root ?? {}).find(key => key.startsWith('__reactContainer$'));
  const first = root?.[key], stack = first ? [first.stateNode?.current ?? first] : [], seen = new Set(); let runtime;
  const visit = value => { if (!value || typeof value !== 'object') return; const current = value.current ?? value;
    if (current.scene?.meshes && !current.scene.isDisposed && typeof current.getPerformanceMetrics === 'function') runtime = current; };
  while (stack.length && seen.size < 30000) { const fiber = stack.pop(); if (!fiber || seen.has(fiber)) continue; seen.add(fiber);
    for (const value of Object.values(fiber.memoizedProps ?? {})) visit(value);
    let hook = fiber.memoizedState; for (let index = 0; hook && index < 500; index++, hook = hook.next) visit(hook.memoizedState);
    stack.push(fiber.child, fiber.sibling); }
  if (!runtime || !runtime.environment?.appearanceRuntime?.getBloomMsaaState) return false;
  const loading = runtime.getPerformanceMetrics().loading;
  if (loading.pendingModelCount || loading.active.length || !runtime.scene.isReady() || document.querySelector('[data-scene-preparation-phase]')) return false;
  window.__phase2Bloom = { runtime }; return true;
}
function readState(cube) {
  const runtime = window.__phase2Bloom.runtime, scene = runtime.scene, engine = scene.getEngine(), pipeline = runtime.environment.appearanceRuntime.pipeline;
  const spy = window.__phase2BloomSpy, contextId = spy.idFor(engine._gl);
  return { msaa: runtime.environment.appearanceRuntime.getBloomMsaaState(), fxaa: pipeline?.fxaaEnabled ?? null,
    appearance: structuredClone(runtime.document.shadowDocument.sceneSettings.appearance), contextId,
    renderer: engine.getGlInfo(), buffer: [engine.getRenderWidth(), engine.getRenderHeight()], hardwareLevel: engine.getHardwareScalingLevel(),
    caps: { maxMSAASamples: engine.getCaps().maxMSAASamples, supportMSAA: engine._features.supportMSAA },
    frameId: engine.frameId, cubeKnown: runtime.presentation.meshes.has(cube),
    allocations: spy.records.filter(row => row.contextId === contextId), spyErrors: [...spy.errors] };
}
function capturePixels(cube) {
  const runtime = window.__phase2Bloom.runtime, scene = runtime.scene;
  return new Promise(resolve => scene.onAfterRenderObservable.addOnce(() => {
    const engine = scene.getEngine(), gl = engine._gl, width = engine.getRenderWidth(), height = engine.getRenderHeight();
    const bytes = new Uint8Array(width * height * 4); gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
    const colors = new Set(); for (let index = 0; index < bytes.length; index += 64) colors.add(bytes[index] + ',' + bytes[index + 1] + ',' + bytes[index + 2]);
    const active = scene.getActiveMeshes(), mesh = runtime.presentation.meshes.get(cube), cubeActive = active.data.slice(0, active.length).includes(mesh);
    let binary = ''; for (let index = 0; index < bytes.length; index += 8192) binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
    resolve({ width, height, colors: colors.size, cubeActive, base64: btoa(binary) });
  }));
}
