import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { chromium, _electron } from 'playwright';
import { WebSocketServer } from 'ws';
import mqttPacket from 'mqtt-packet';
import { assertSceneOpenReady } from './lib/sceneOpenAcceptance.mjs';

// 真实资源只读；场景、配置与部署产物均写入本 smoke 的隔离目录。
const workspace = process.cwd();
const source = path.resolve(process.argv[2] ?? String.raw`C:\Users\WY\Desktop\中鼎智能-工厂.scene.json`);
const output = path.resolve(process.argv[3] ?? 'output/playwright/local-shadow-full-scene');
const allowStartupWarning = process.argv.includes('--allow-startup-warning');
const original = await readFile(source);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const fixture = JSON.parse(original.toString('utf8'));
const document = fixture.scene;
const models = document.entityIds.filter(id => document.entities[id].components?.modelAsset);
const lightEntity = document.entityIds.map(id => document.entities[id]).find(e => e.components?.light?.lightKind === 'point');
assert.ok(lightEntity, '真实场景没有点光源');
const root = await mkdtemp(path.join(tmpdir(), 'local-shadow-full-scene-'));
const userData = path.join(root, 'userdata');
const scenePath = path.join(root, 'shadow-fixture.scene.json');
await mkdir(userData); await mkdir(output, { recursive: true });
// 新 userData 不继承读取授权；仅授予本场景引用的资源目录，源资源保持只读。
const resourceDirectories = new Set();
function collectResources(value) {
  if (typeof value === 'string' && value.startsWith('editor-asset://local/')) {
    resourceDirectories.add(path.dirname(decodeURIComponent(value.slice('editor-asset://local/'.length).split('?')[0])));
  } else if (value && typeof value === 'object') for (const child of Object.values(value)) collectResources(child);
}
collectResources(document);
for (const directory of resourceDirectories) await stat(directory);
const configuredAddress = JSON.parse(await readFile(path.join(process.env.APPDATA, 'ZENDING 3D EDITOR', 'data-platform-config.json'), 'utf8')).baseUrl;
assert.ok(configuredAddress, '完整本地场景准备需要已有数据中台地址');
await writeFile(path.join(userData, 'data-platform-config.json'), JSON.stringify({ version: 2, baseUrl: configuredAddress, workspaceRoot: root }));
const brokerServer = createServer();
const broker = new WebSocketServer({ server: brokerServer });
broker.on('connection', socket => {
  const parser = mqttPacket.parser();
  let protocolVersion = 4;
  const send = packet => socket.send(mqttPacket.generate(packet, { protocolVersion }));
  socket.on('message', bytes => parser.parse(bytes));
  parser.on('error', () => socket.close());
  parser.on('packet', packet => {
    if (packet.cmd === 'connect') { protocolVersion = packet.protocolVersion; send({ cmd: 'connack', returnCode: 0, reasonCode: 0, sessionPresent: false }); }
    if (packet.cmd === 'subscribe') send({ cmd: 'suback', messageId: packet.messageId, granted: packet.subscriptions.map(subscription => subscription.qos) });
    if (packet.cmd === 'pingreq') send({ cmd: 'pingresp' });
  });
});
await new Promise(resolve => brokerServer.listen(0, '127.0.0.1', resolve));
Object.assign(document.sceneSettings.shadows, { bias: .002, normalBias: .03 });
const targetQuality = document.sceneSettings.shadows.quality;
// 先以缓存档完成真实资源准备，避免首次编译同时重绘全场六面阴影压满测试 GPU。
document.sceneSettings.shadows.quality = 'balanced';
document.sceneSettings.openingAnimation = { ...document.sceneSettings.openingAnimation, enabled: false };
document.sceneSettings.modelEntrance = { ...document.sceneSettings.modelEntrance, enabled: false };
document.mqttConfig = { ...document.mqttConfig, enabled: true, simulatorEnabled: false,
  address: `ws://127.0.0.1:${brokerServer.address().port}`, username: '', password: '', topic: 'fixture/local-shadow', sources: [],
  subscriptions: [{ topic: 'fixture/local-shadow', qos: 0 }] };
document.fetchConfig = { ...document.fetchConfig, enabled: false, sources: [] };
document.selectedEntityId = null;
await writeFile(scenePath, JSON.stringify(fixture));
await writeFile(path.join(userData, 'recent-workspaces.json'), JSON.stringify({ version: 1, projects: [],
  scenes: [{ filePath: scenePath, lastOpenedAt: new Date().toISOString() }] }));
const report = { status: 'RUNNING', source, sourceSha256: digest(original), modelCount: models.length,
  fixtureAdjustments: 'default bias .002/.03; boot balanced then restore source quality before pixels; disabled opening/model entrance animation/Fetch; local MQTT handshake only with no telemetry; no added geometry',
  runs: [], errors: [], requestFailures: [] };
let app, browser, server, page;
async function checkpoint(phase) {
  report.phase = phase;
  await writeFile(path.join(output, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ phase }));
}

async function observeScene(targetPage, assetDir, base, waitUntilReady = true) {
  const engineModule = (await readdir(assetDir)).find(name => name.startsWith('engineStore-'));
  assert.ok(engineModule, '缺少 built EngineStore chunk');
  await targetPage.evaluate(async url => {
    const module = await import(url);
    window.shadowEngines = Object.values(module).find(value => Array.isArray(value?.Instances));
    window.shadowScene = () => window.shadowEngines?.Instances.flatMap(engine => engine.scenes)
      .find(scene => scene.transformNodes.some(node => node.name.startsWith('EnvironmentRoot_')));
  }, base + 'assets/' + engineModule);
  await targetPage.waitForFunction(() => Boolean(window.shadowScene?.()), null, { timeout: 600_000 });
  if (waitUntilReady) await targetPage.waitForFunction(() => window.shadowScene().isReady(), null, { timeout: 600_000 });
}

async function readinessDiagnostic(targetPage) {
  return targetPage.evaluate(() => {
    const scene = window.shadowScene?.();
    if (!scene) return { sceneAvailable: false };
    const canvas = document.querySelector('canvas.scene-canvas, canvas.player-canvas');
    let fiber = canvas?.[Object.keys(canvas).find(key => key.startsWith('__reactFiber$'))];
    let runtime;
    // 从当前 SceneView 的 ref 读取生产诊断接口，避免用 mesh ready 代替模型初始化完成。
    for (let depth = 0; fiber && depth < 30 && !runtime; depth++, fiber = fiber.return) {
      for (let hook = fiber.memoizedState; hook; hook = hook.next) {
        const candidate = hook.memoizedState?.current;
        if (typeof candidate?.getPerformanceMetrics === 'function' && typeof candidate?.isModelReady === 'function') {
          runtime = candidate; break;
        }
      }
    }
    const unready = scene.meshes.filter(mesh => mesh.subMeshes?.length && !mesh.isReady(true));
    return {
      runtime: runtime?.getPerformanceMetrics(), environment: runtime?.environmentRuntime?.getSnapshot(),
      unreadyModels: runtime ? [...runtime.models.keys()].filter(id => !runtime.isModelReady(id)) : null,
      frameId: scene.getFrameId(), ready: scene.isReady(), readyWithoutTargets: scene.isReady(false), meshCount: scene.meshes.length,
      pending: scene._pendingData.map(item => ({ name: item?.name, className: item?.getClassName?.() })),
      unreadyCount: unready.length,
      unready: unready.slice(0, 25).map(mesh => ({ name: mesh.name, enabled: mesh.isEnabled(), material: mesh.material?.name,
        subMeshes: mesh.subMeshes.map(sub => ({ material: sub.getMaterial()?.name, effectReady: sub.effect?.isReady(),
          error: sub.effect?.getCompilationError(), defines: sub.effect?.defines?.split(String.fromCharCode(10)).filter(line => /SHADOW|LIGHT\d/.test(line)) })) })),
      targets: scene.customRenderTargets.map(target => ({ name: target.name, ready: target.isReadyForRendering() })),
    };
  });
}

async function readEditorReport() {
  let startupWarning = null;
  try { await Promise.race([
    page.waitForFunction(() => !document.querySelector('[data-scene-preparation-phase]'), null, { timeout: 600_000 }),
    page.getByText('场景资源加载失败', { exact: true }).waitFor({ state: 'visible', timeout: 600_000 })
      .then(async () => { throw new Error(await page.locator('[data-scene-preparation-phase]').innerText()); }),
  ]); } catch (error) {
    if (!allowStartupWarning || !String(error).includes('未能在规定时间内完成加载与首帧渲染')) throw error;
    const diagnostic = await readinessDiagnostic(page);
    const runtime = diagnostic.runtime;
    assert.ok(diagnostic.ready && diagnostic.unreadyModels?.length === 0);
    assert.equal(runtime.modelRuntimeCount + runtime.modelArrayInstanceEntityCount, models.length);
    assert.equal(runtime.loading.pendingModelCount, 0); assert.equal(runtime.loading.active.length, 0);
    assert.equal(runtime.loading.failedModelAcquisitions, 0); assert.equal(runtime.loading.environmentPhase, 'ready');
    for (const metric of Object.values(runtime.loading.stages ?? {})) assert.equal(metric.failedCount, 0);
    startupWarning = String(error);
    (report.startupWarnings ??= []).push({ message: startupWarning, loading: runtime.loading });
    await page.getByRole('button', { name: '保留资源问题并继续编辑', exact: true }).click();
  }
  const checkbox = page.getByRole('checkbox', { name: '性能监控', exact: true });
  if (await checkbox.count()) await checkbox.check();
  const copy = page.locator('button.scene-performance-copy');
  if (!await copy.isVisible()) await page.locator('.scene-performance-summary').click();
  await page.evaluate(() => Object.defineProperty(navigator.clipboard, 'writeText', {
    configurable: true, value: async text => { window.shadowPerformanceReport = String(text); },
  }));
  const deadline = Date.now() + 600_000;
  let latest;
  while (Date.now() < deadline) {
    await page.waitForTimeout(1500); await copy.click();
    await page.waitForFunction(() => typeof window.shadowPerformanceReport === 'string');
    latest = await page.evaluate(() => JSON.parse(window.shadowPerformanceReport));
    if (startupWarning) break;
    try { assertSceneOpenReady(latest.scenePreparation, latest.samples.at(-1)?.runtime?.loading); break; } catch {}
  }
  if (!startupWarning) assertSceneOpenReady(latest?.scenePreparation, latest?.samples.at(-1)?.runtime?.loading);
  const runtime = latest.samples.at(-1).runtime;
  const modelCount = runtime.modelRuntimeCount + runtime.modelArrayInstanceEntityCount;
  assert.equal(modelCount, models.length, '独立模型与阵列实例必须覆盖全部真实模型');
  return { preparation: latest.scenePreparation, startupWarning, loading: runtime.loading, modelCount,
    renderer: latest.renderer, summary: latest.summary };
}

async function readViewerReport() {
  const deadline = Date.now() + 600_000;
  while (!report.viewerInitialLoading && Date.now() < deadline) await page.waitForTimeout(500);
  const loading = report.viewerInitialLoading;
  assert.ok(loading, 'Viewer 必须完成实际首帧准备并输出加载诊断');
  assert.equal(loading.pendingModelCount, 0); assert.equal(loading.active.length, 0);
  assert.equal(loading.failedModelAcquisitions, 0); assert.equal(loading.environmentPhase, 'ready');
  for (const metric of Object.values(loading.stages ?? {})) assert.equal(metric.failedCount, 0);
  await page.locator('.scene-loading-mask').waitFor({ state: 'hidden', timeout: 600_000 });
  const diagnostic = await readinessDiagnostic(page);
  const modelCount = diagnostic.runtime.modelRuntimeCount + diagnostic.runtime.modelArrayInstanceEntityCount;
  assert.equal(modelCount, models.length, 'Viewer 必须建立全部真实模型运行实例');
  return { modelCount, loading };
}

async function captureGround(targetPage, label) {
  const result = await targetPage.evaluate(async ({ pointId, position }) => {
    const scene = window.shadowScene(); const engine = scene.getEngine(); const camera = scene.activeCamera;
    camera.setTarget(camera.target.clone().set(position.x, 3, position.z));
    camera.alpha = -1.9; camera.beta = 1.02; camera.radius = 38;
    camera.inertialAlphaOffset = camera.inertialBetaOffset = camera.inertialRadiusOffset = 0;
    const point = scene.lights.find(light => light.metadata?.entityId === pointId || light.name.includes(pointId));
    if (!point) throw new Error('运行时缺少真实点光源');
    const initialPosition = point.position.clone(); const enabled = point.isEnabled();
    const environment = scene.transformNodes.find(node => node.name.startsWith('EnvironmentRoot_'));
    const ground = new Set(environment.getChildMeshes().filter(mesh => mesh.getTotalVertices() > 0));
    const wait = async () => {
      const frame = scene.getFrameId();
      while (scene.getFrameId() < frame + 12) await new Promise(resolve => setTimeout(resolve, 25));
    };
    const capture = async () => {
      await wait(); scene.render(); const pixels = Array.from(await engine.readPixels(0, 0, engine.getRenderWidth(), engine.getRenderHeight()));
      return { pixels, png: engine.getRenderingCanvas().toDataURL('image/png') };
    };
    const compare = (first, second, samples) => {
      let darker = 0, brighter = 0, changed = 0;
      for (const pixel of samples) {
        const delta = (second[pixel] + second[pixel + 1] + second[pixel + 2]
          - first[pixel] - first[pixel + 1] - first[pixel + 2]) / 3;
        if (delta < -3) darker++; if (delta > 3) brighter++; if (Math.abs(delta) > 3) changed++;
      }
      return { darker, brighter, changed, samples: samples.length };
    };
    try {
      point.setEnabled(false); const off = await capture();
      const width = engine.getRenderWidth(), height = engine.getRenderHeight();
      const canvas = engine.getRenderingCanvas(); const samples = [];
      // 通过实际屏幕射线确定可见地面，避免将设备的直接受光计入阴影证据。
      for (let y = 4; y < height; y += 16) for (let x = 4; x < width; x += 16) {
        const hit = scene.pick(x * canvas.clientWidth / width, y * canvas.clientHeight / height,
          mesh => mesh.isEnabled() && mesh.isVisible && mesh.visibility > 0 && mesh.getTotalVertices() > 0);
        // glTF primitive 可共享顶点缓冲，包围盒可能包含整栋建筑；按实际命中三角形识别地面。
        if (hit?.hit && ground.has(hit.pickedMesh) && hit.pickedPoint.y < 1
          && Math.abs(hit.getNormal(true)?.y ?? 0) > 0.98) samples.push(((height - 1 - y) * width + x) * 4);
      }
      point.setEnabled(true); const on = await capture();
      point.position.x += 5; const moved = await capture();
      point.position.copyFrom(initialPosition); const restored = await capture();
      const durations = [];
      for (let i = 0; i < 60; i++) {
        const start = performance.now(); await new Promise(resolve => requestAnimationFrame(resolve)); durations.push(performance.now() - start);
      }
      return { maskMeshCount: ground.size, offToOn: compare(off.pixels, on.pixels, samples),
        onToMoved: compare(on.pixels, moved.pixels, samples), onToRestored: compare(on.pixels, restored.pixels, samples),
        renderer: engine.getGlInfo(), meanFrameMs: durations.reduce((a, b) => a + b, 0) / durations.length,
        point: { position: initialPosition.asArray(), range: point.range, generator: !!point.getShadowGenerator() },
        images: { off: off.png, on: on.png, moved: moved.png } };
    } finally { point.position.copyFrom(initialPosition); point.setEnabled(enabled); }
  }, { pointId: lightEntity.id, position: lightEntity.components.transform.position });
  for (const [name, png] of Object.entries(result.images)) await writeFile(path.join(output, `${label}-${name}.png`), Buffer.from(png.split(',')[1], 'base64'));
  delete result.images;
  report.latestPixelProbe = { label, ...result };
  assert.ok(result.offToOn.samples > 20, '固定相机没有足够可见真实地面采样点');
  assert.ok(result.offToOn.changed > 10, '真实点光开关没有可见地面阴影差异');
  assert.ok(result.onToMoved.changed > 5, '移动真实点光没有改变地面阴影位置');
  assert.equal(result.onToRestored.changed, 0, '移动复位后残留阴影');
  console.log(JSON.stringify({ phase: label, ...result }));
  return result;
}

try {
  await checkpoint('launch');
  app = await _electron.launch({ args: [workspace, `--user-data-dir=${userData}`], cwd: workspace,
    env: { ...process.env, OPEN_DEVTOOLS: 'false', VITE_DEV_SERVER_URL: '' }, timeout: 120_000 });
  page = await app.firstWindow({ timeout: 120_000 }); page.setDefaultTimeout(120_000);
  await app.evaluate(({ dialog }, input) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [input.root] });
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: input.scenePath });
  }, { root, scenePath });
  await page.evaluate(() => window.editorApi.selectProjectDirectory());
  for (const directory of resourceDirectories) {
    await app.evaluate(({ dialog }, directory) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
    }, directory);
    await page.evaluate(() => window.editorApi.scanAssets());
  }
  page.on('pageerror', error => report.errors.push(error.message));
  page.on('requestfailed', request => report.requestFailures.push({ url: request.url(), error: request.failure()?.errorText }));
  page.on('console', async message => {
    if (message.text().startsWith('[Viewer loading] 场景首帧诊断')) {
      report.viewerInitialLoading = await message.args()[1].jsonValue();
    }
  });
  const card = page.locator('.home-recent-card').filter({ hasText: path.basename(scenePath) });
  await card.getByRole('button', { name: '打开', exact: true }).click();
  await checkpoint('editor-loading');
  await page.locator('canvas.scene-canvas').waitFor({ state: 'visible', timeout: 600_000 });
  await observeScene(page, path.join(workspace, 'dist/assets'), new URL('./', page.url()).href, false);
  const ready = await readEditorReport();
  console.log(JSON.stringify({ phase: 'editor-ready', modelCount: ready.modelCount, renderer: ready.renderer }));
  await observeScene(page, path.join(workspace, 'dist/assets'), new URL('./', page.url()).href);
  await page.getByText('阴影质量', { exact: true }).locator('..').locator('select').selectOption(targetQuality);
  await checkpoint('editor-source-quality');
  report.runs.push({ label: 'editor', ready, pixels: await captureGround(page, 'editor') });
  await checkpoint('editor-pixels-complete');
  const beforeSave = (await stat(scenePath)).mtimeMs;
  await page.getByRole('button', { name: '保存场景', exact: true }).click();
  const saveDeadline = Date.now() + 30_000;
  while ((await stat(scenePath)).mtimeMs <= beforeSave && Date.now() < saveDeadline) await page.waitForTimeout(100);
  assert.ok((await stat(scenePath)).mtimeMs > beforeSave, '保存操作必须实际更新场景副本文件');
  const saved = JSON.parse(await readFile(scenePath, 'utf8'));
  assert.equal(saved.scene.sceneSettings.shadows.bias, .002);
  assert.equal(saved.scene.entities[lightEntity.id].components.light.lightKind, 'point');
  report.saved = { fileUpdated: true, bias: saved.scene.sceneSettings.shadows.bias };
  await page.getByRole('button', { name: '运行', exact: true }).click();
  await page.waitForTimeout(2000);
  assert.equal(await page.getByRole('button', { name: '停止', exact: true }).isEnabled(), true, '预览未进入运行状态');
  report.runs.push({ label: 'preview', pixels: await captureGround(page, 'preview') });
  await checkpoint('preview-complete');
  await page.getByRole('button', { name: '停止', exact: true }).click();
  await page.reload({ waitUntil: 'domcontentloaded' });
  const reopenCard = page.locator('.home-recent-card').filter({ hasText: path.basename(scenePath) });
  if (await reopenCard.count()) await reopenCard.getByRole('button', { name: '打开', exact: true }).click();
  await page.locator('canvas.scene-canvas').waitFor({ state: 'visible', timeout: 600_000 });
  const reopened = await readEditorReport();
  await observeScene(page, path.join(workspace, 'dist/assets'), new URL('./', page.url()).href);
  report.runs.push({ label: 'reopened', ready: reopened, pixels: await captureGround(page, 'reopened') });
  await checkpoint('reopened-complete');
  await app.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }); }, output);
  const exported = await page.evaluate(async content => window.editorApi.exportWebProject({
    requestId: 'local-shadow-' + Date.now(), suggestedName: 'local-shadow-full-scene', format: 'directory', sceneContent: content,
  }), await readFile(scenePath, 'utf8'));
  assert.equal(exported.canceled, false); assert.ok(exported.outputPath); report.exported = exported;
  await app.close(); app = null;
  const viewerRoot = path.resolve(exported.outputPath);
  const mime = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.wasm': 'application/wasm' };
  server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://local').pathname);
      const file = path.resolve(viewerRoot, '.' + (pathname === '/' ? '/index.html' : pathname));
      const relative = path.relative(viewerRoot, file);
      if (relative.startsWith('..') || path.isAbsolute(relative)) { response.writeHead(403).end(); return; }
      response.setHeader('Content-Type', mime[path.extname(file)] ?? 'application/octet-stream');
      await pipeline(createReadStream(file), response);
    } catch (error) { if (!response.headersSent) response.writeHead(error.code === 'ENOENT' ? 404 : 500); response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', error => report.errors.push(error.message));
  page.on('requestfailed', request => report.requestFailures.push({ url: request.url(), error: request.failure()?.errorText }));
  page.on('console', async message => {
    if (message.text().startsWith('[Viewer loading] 场景首帧诊断')) {
      report.viewerInitialLoading = await message.args()[1].jsonValue();
    }
  });
  const viewerUrl = `http://127.0.0.1:${server.address().port}/`;
  await page.goto(viewerUrl + '?performance=1', { waitUntil: 'load' });
  await checkpoint('viewer-loading');
  await observeScene(page, path.join(viewerRoot, 'assets'), viewerUrl);
  const viewerReady = await readViewerReport();
  report.runs.push({ label: 'viewer', ready: viewerReady, pixels: await captureGround(page, 'viewer') });
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.requestFailures.filter(entry => /\.(?:glb|gltf|png|jpg)(?:[?#]|$)/i.test(entry.url)), []);
  report.status = report.startupWarnings?.length ? 'PASS_WITH_STARTUP_WARNING' : 'PASS';
} catch (error) {
  report.status = 'FAIL'; report.error = error.stack; process.exitCode = 1;
  if (page && !page.isClosed()) {
    try { report.readiness = await readinessDiagnostic(page); }
    catch (diagnosticError) { report.diagnosticError = String(diagnosticError); }
  }
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => undefined);
} finally {
  await app?.close(); await browser?.close(); if (server) await new Promise(resolve => server.close(resolve));
  for (const socket of broker.clients) socket.terminate();
  await new Promise(resolve => broker.close(resolve)); await new Promise(resolve => brokerServer.close(resolve));
  report.sourceUnchanged = digest(await readFile(source)) === report.sourceSha256;
  if (!report.sourceUnchanged) { report.status = 'FAIL'; process.exitCode = 1; }
  await writeFile(path.join(output, 'result.json'), JSON.stringify(report, null, 2));
  assert.equal(path.dirname(root), tmpdir()); await rm(root, { recursive: true, force: true });
  console.log(JSON.stringify({ status: report.status, output, error: report.error, sourceUnchanged: report.sourceUnchanged }));
}
