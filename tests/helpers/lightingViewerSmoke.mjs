/* global window, document, Image, requestAnimationFrame */
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { chromium } from 'playwright';
import { liftId } from './liftMotionArrowFixture.mjs';

const workspace = path.resolve(import.meta.dirname, '../..');
const inside = (root, target) => {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
};
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.ts': 'text/plain; charset=utf-8', '.png': 'image/png',
  '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.wasm': 'application/wasm',
};

/** 调用正式导出 IPC，仅为本次已授权测试指定文件选择器的目标目录。 */
async function exportSavedViewer(application, editorPage, sceneContent, exportParent, report) {
  report.app = await application.evaluate(({ app }) => ({ appPath: app.getAppPath(), packaged: app.isPackaged }));
  report.app.template = path.join(report.app.appPath, 'dist-viewer-template', 'index.html');
  assert.ok((await stat(report.app.template)).isFile(), '实际应用路径必须包含 Viewer 模板');
  await application.evaluate(({ dialog }, directory) => {
    if (globalThis.__lightingViewerDialogState) throw new Error('已有 Viewer 导出测试占用文件选择器。');
    const previous = dialog.showOpenDialog;
    globalThis.__lightingViewerDialogState = { previous };
    dialog.showOpenDialog = async (...args) => {
      const options = args.at(-1);
      if (options?.title === '选择 Web 部署工程输出目录') return { canceled: false, filePaths: [directory] };
      return previous.apply(dialog, args);
    };
  }, exportParent);
  try {
    const requestId = 'lighting-viewer-' + randomUUID();
    const result = await editorPage.evaluate(async ({ requestId, content }) => {
      if (typeof window.editorApi?.exportWebProject !== 'function') throw new Error('真实导出 preload API 不可用。');
      window.__lightingViewerExportProgress = [];
      const unsubscribe = window.editorApi.onWebProjectExportProgress(event => {
        if (event.requestId === requestId) window.__lightingViewerExportProgress.push(event);
      });
      let timeoutId, cancelTimeoutId, timedOut = false;
      const exporting = window.editorApi.exportWebProject({ requestId, suggestedName: 'hybrid-lighting-viewer', format: 'directory', sceneContent: content });
      try {
        return await Promise.race([exporting, new Promise((_, reject) => {
          timeoutId = setTimeout(() => { timedOut = true; reject(new Error('正式 Viewer 导出在 180 秒内未完成。')); }, 180_000);
        })]);
      } catch (error) {
        if (timedOut) {
          // 超时后仍通过正式 IPC 取消并等待收尾，避免留下继续写出的导出事务。
          await Promise.race([
            window.editorApi.cancelWebProjectExport({ requestId }).then(() => exporting).catch(() => {}),
            new Promise(resolve => { cancelTimeoutId = setTimeout(resolve, 15_000); }),
          ]);
        }
        throw error;
      } finally { clearTimeout(timeoutId); clearTimeout(cancelTimeoutId); unsubscribe(); }
    }, { requestId, content: sceneContent });
    report.exportProgress = await editorPage.evaluate(() => window.__lightingViewerExportProgress ?? []);
    assert.equal(result.canceled, false, JSON.stringify(result));
    assert.ok(result.outputPath, JSON.stringify(result));
    assert.ok(inside(exportParent, result.outputPath), '正式导出结果必须位于本次 Viewer 输出目录');
    report.exportResult = result;
    return path.resolve(result.outputPath);
  } finally {
    await restoreExportDialog(application);
  }
}

async function restoreExportDialog(application) {
  await application.evaluate(({ dialog }) => {
    const saved = globalThis.__lightingViewerDialogState;
    if (saved) { dialog.showOpenDialog = saved.previous; delete globalThis.__lightingViewerDialogState; }
  });
}

async function createReadonlyViewerServer(root, requests) {
  const realRoot = await realpath(root);
  const server = createServer(async (request, response) => {
    const record = { method: request.method, path: request.url, status: 0, complete: false };
    requests.push(record);
    response.on('finish', () => { record.status = response.statusCode; record.complete = true; });
    try {
      if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405).end(); return; }
      const url = new URL(request.url, 'http://127.0.0.1');
      record.path = url.pathname;
      if (url.pathname === '/favicon.ico') { response.writeHead(204).end(); return; }
      const decoded = decodeURIComponent(url.pathname);
      if (decoded.includes('\0') || decoded.split('/').includes('..')) { response.writeHead(403).end(); return; }
      const file = path.resolve(root, decoded.replace(/^\/+/, '') || 'index.html');
      if (!inside(root, file)) { response.writeHead(403).end(); return; }
      const actual = await realpath(file);
      if (!inside(realRoot, actual)) { response.writeHead(403).end(); return; }
      const info = await stat(actual);
      if (!info.isFile()) { response.writeHead(404).end(); return; }
      response.setHeader('Content-Type', MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream');
      response.setHeader('Content-Length', info.size);
      response.setHeader('Cache-Control', 'no-store');
      if (request.method === 'HEAD') response.end();
      else await pipeline(createReadStream(actual), response);
    } catch (error) {
      record.error = String(error?.message ?? error);
      if (!response.headersSent) response.writeHead(error?.code === 'ENOENT' ? 404 : 500);
      response.end();
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { server, base: 'http://127.0.0.1:' + server.address().port + '/' };
}

async function installViewerProbe(page, engineStoreUrl) {
  await page.evaluate(async ({ engineStoreUrl, entityId }) => {
    const module = await import(engineStoreUrl);
    const store = Object.values(module).find(value => Array.isArray(value?.Instances));
    if (!store) throw new Error('实际 Viewer 包未导出 Babylon EngineStore。');
    const scene = () => store.Instances.flatMap(engine => engine.scenes)
      .find(candidate => candidate.meshes.some(mesh => mesh.name.includes('LiftDeck')
        && (mesh.metadata?.editorEntityId === entityId || mesh.metadata?.entityId === entityId)));
    const snapshot = () => {
      const current = scene();
      if (!current) return null;
      const active = current.getActiveMeshes(), activeSet = new Set(active.data.slice(0, active.length));
      const engine = current.getEngine(), gl = engine._gl;
      const details = mesh => {
        const metadata = mesh.metadata ?? {}, material = mesh.material;
        const effect = mesh.subMeshes?.map(sub => sub.effect).find(Boolean);
        let indirectActive = null, uniformError = null;
        const location = effect?.getUniform('lightingBakeActive'), program = effect?.getPipelineContext()?.program;
        if (location && program) {
          try { indirectActive = gl.getUniform(program, location); }
          catch (error) { uniformError = String(error?.message ?? error); }
        }
        return {
          id: mesh.uniqueId, name: mesh.name, entityId: metadata.editorEntityId ?? metadata.entityId,
          sourceKey: metadata.lightingSourceKey, enabled: mesh.isEnabled(), visible: mesh.isVisible,
          layerMask: mesh.layerMask, rendered: activeSet.has(mesh), vertices: mesh.getTotalVertices(),
          world: Array.from(mesh.getWorldMatrix().m), center: mesh.getBoundingInfo().boundingBox.centerWorld.asArray(),
          materialId: material?.uniqueId, materialName: material?.name,
          color: (material?.albedoColor ?? material?.diffuseColor)?.asArray() ?? null,
          mapShader: Boolean(effect?.defines?.includes('BAKED_INDIRECT_MAP')),
          receiveShadows: mesh.receiveShadows,
          receivesShadowShader: Boolean(effect?.defines && /(?:^|\n)#define SHADOW\d+(?:\s|$)/.test(effect.defines)),
          indirectActive, uniformError,
        };
      };
      const staticMaps = current.meshes.filter(mesh => mesh.metadata?.lightingDerived && mesh.isVerticesDataPresent('lightingBakeUV')).map(details);
      const deck = current.meshes.find(mesh => mesh.name.includes('LiftDeck') && !mesh.metadata?.lightingDerived
        && (mesh.metadata?.editorEntityId === entityId || mesh.metadata?.entityId === entityId));
      return {
        ready: current.isReady(), editorApiPresent: typeof window.editorApi !== 'undefined',
        runtimeStatusText: document.querySelector('.player-status')?.innerText ?? '',
        staticMaps, deck: deck ? details(deck) : null,
        meshCount: current.meshes.length,
        gpu: { webGLVersion: engine.webGLVersion, info: engine.getGlInfo(), contextLost: gl.isContextLost() },
      };
    };
    window.__lightingViewerProbe = { scene, snapshot };
  }, { engineStoreUrl, entityId: liftId });
}

async function frames(page, count = 3) {
  await page.evaluate(count => new Promise(resolve => {
    let frame = 0;
    const next = () => ++frame >= count ? resolve() : requestAnimationFrame(next);
    requestAnimationFrame(next);
  }), count);
}

async function pixelSummary(page, png) {
  return page.evaluate(async dataUrl => {
    const image = new Image();
    await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject; image.src = dataUrl; });
    const canvas = document.createElement('canvas');
    canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const background = Array.from(pixels.slice(0, 3)), palette = new Set();
    let varying = 0, colored = 0;
    for (let offset = 0; offset < pixels.length; offset += 4) {
      const r = pixels[offset], g = pixels[offset + 1], b = pixels[offset + 2];
      palette.add((r >> 3) * 1024 + (g >> 3) * 32 + (b >> 3));
      if (Math.abs(r - background[0]) + Math.abs(g - background[1]) + Math.abs(b - background[2]) > 24) varying++;
      if (Math.max(r, g, b) > 35 && Math.max(r, g, b) - Math.min(r, g, b) > 14) colored++;
    }
    return { width: canvas.width, height: canvas.height, palette: palette.size, varying, colored };
  }, 'data:image/png;base64,' + png.toString('base64'));
}

function assertStaticGi(snapshot, expectedCount) {
  assert.ok(snapshot?.ready, 'Viewer 实际场景尚未就绪');
  assert.equal(snapshot.editorApiPresent, false, '只读 Viewer 不应拥有 editorApi 或本机烘焙入口');
  assert.doesNotMatch(snapshot.runtimeStatusText, /混合光照[：:]|模型几何或实际姿态|请重新烘焙/, 'Viewer 不能在正常加载和运动后保留光照失败提示');
  assert.equal(snapshot.staticMaps.length, expectedCount, '必须应用全部静态 GI 表面，不能仅加载部分结果');
  assert.ok(snapshot.staticMaps.every(mesh => mesh.enabled && mesh.visible && mesh.layerMask !== 0 && mesh.vertices > 0), '静态 GI 代理必须保持有效几何与可见状态');
  const rendered = snapshot.staticMaps.filter(mesh => mesh.rendered);
  assert.ok(rendered.length > 0, '相机中必须实际绘制静态 GI 表面');
  assert.ok(rendered.every(mesh => mesh.mapShader && mesh.indirectActive === 1 && !mesh.uniformError), '实际绘制的材质必须启用光照图 shader');
  assert.equal(snapshot.gpu.webGLVersion, 2);
  assert.equal(snapshot.gpu.contextLost, false);
  assert.doesNotMatch(JSON.stringify(snapshot.gpu.info), /swiftshader|llvmpipe|WARP|software|basic render driver/i, 'Viewer 验收需要实际硬件 WebGL');
}

function assertSameStaticGi(before, after) {
  const stable = snapshot => snapshot.staticMaps.map(mesh => ({
    id: mesh.id, sourceKey: mesh.sourceKey, materialId: mesh.materialId, world: mesh.world, color: mesh.color,
    receiveShadows: mesh.receiveShadows,
  })).sort((a, b) => a.id - b.id);
  assert.deepEqual(stable(after), stable(before), 'MQTT 动作不应重建、移动或替换静态 GI 表面');
}

/**
 * 输入来自已经真实烘焙并保存的 Editor。只创建自己的 Edge/HTTP；不关闭调用方的应用或 broker。
 * output 是报告根目录；正式导出保留在 output/viewer 下，截图和本次报告保留在唯一子目录。
 */
export async function runLightingViewerSmoke({
  application, editorPage, scenePath, projectRoot, output = path.join(workspace, 'output', 'lighting-bake'),
  broker, viewport = { width: 1440, height: 960 }, expectedPolicyBindings = [],
}) {
  assert.ok(application && editorPage && broker?.drive, '需要仍在运行的真实 Electron、Editor 页面和本地 MQTT broker');
  assert.ok(inside(projectRoot, scenePath), '只能读取本次测试工程内的已保存场景');
  output = path.resolve(output);
  assert.ok(inside(path.join(workspace, 'output'), output), 'Viewer 验收输出必须在仓库 output 内');
  const runId = 'viewer-' + Date.now() + '-' + randomUUID().slice(0, 8);
  const runRoot = path.join(output, runId), exportParent = path.join(output, 'viewer', runId);
  await mkdir(runRoot, { recursive: true }); await mkdir(exportParent, { recursive: true });
  const report = { status: 'RUNNING', runId, startedAt: new Date().toISOString(), scenePath, projectRoot, runRoot,
    checks: [], screenshots: [], snapshots: [], requests: [], pageErrors: [], consoleErrors: [], runtimeLogs: [], requestFailures: [], websockets: [] };
  const reportPath = path.join(runRoot, 'result.json');
  const save = async () => {
    await writeFile(reportPath, JSON.stringify(report, null, 2));
    await writeFile(path.join(output, 'viewer-result.json'), JSON.stringify({ ...report, reportPath }, null, 2));
  };
  const check = name => { report.checks.push(name); console.log('[lighting-viewer] ' + name); };
  const brokerErrorStart = broker.errors?.length ?? 0;
  let browser, page, server, failure, observeNetwork = true;
  await save();
  try {
    const sourceContent = await readFile(scenePath, 'utf8'), sourceScene = JSON.parse(sourceContent).scene;
    const originalBake = sourceScene?.sceneSettings?.lighting?.result;
    assert.equal(sourceScene?.sceneSettings?.lighting?.version, 2);
    assert.ok(originalBake?.surfaces?.length && originalBake?.assets?.length, '必须先完成实际 UI 烘焙并保存，不能生成占位结果');
    const brokerAddress = new URL(sourceScene.mqttConfig.address);
    assert.ok(['ws:', 'wss:'].includes(brokerAddress.protocol) && ['127.0.0.1', 'localhost', '[::1]'].includes(brokerAddress.hostname), '此验收只允许连接调用方的 loopback MQTT');
    assert.equal(brokerAddress.username, ''); assert.equal(brokerAddress.password, '');
    report.source = { signature: originalBake.signature, engineVersion: originalBake.engineVersion,
      surfaces: originalBake.surfaces.length, assets: originalBake.assets.length, broker: brokerAddress.href };
    report.exportRoot = await exportSavedViewer(application, editorPage, sourceContent, exportParent, report);
    check('通过真实 preload/IPC 执行正式 Viewer 导出');
    const runtimeConfig = JSON.parse(await readFile(path.join(report.exportRoot, 'runtime-config.json'), 'utf8'));
    const exportedScene = JSON.parse(await readFile(path.join(report.exportRoot, 'project', 'scene.json'), 'utf8')).scene;
    const manifest = JSON.parse(await readFile(path.join(report.exportRoot, 'project', 'asset-manifest.json'), 'utf8'));
    const exportedBake = exportedScene.sceneSettings.lighting.result;
    if (sourceScene.sceneSettings.lighting.policy) {
      const originalPolicy = sourceScene.sceneSettings.lighting.policy, exportedPolicy = exportedScene.sceneSettings.lighting.policy;
      assert.ok(exportedPolicy, '正式Viewer导出不能丢失集中规则');
      assert.deepEqual(exportedPolicy.defaults, originalPolicy.defaults);
      assert.equal(exportedPolicy.rules.length, originalPolicy.rules.length);
      for (const rule of originalPolicy.rules) {
        const exportedRule = exportedPolicy.rules.find(item => item.id === rule.id);
        assert.ok(exportedRule); assert.deepEqual(exportedRule.values, rule.values);
        assert.deepEqual(exportedRule.nodeRules, rule.nodeRules);
      }
      report.policy = exportedPolicy;
    }
    assert.equal(runtimeConfig.mqtt.enabled, true, '正式导出必须保留可用的本地 MQTT 配置');
    assert.equal(runtimeConfig.mqtt.address, brokerAddress.href);
    assert.equal(exportedBake.surfaces.length, originalBake.surfaces.length);
    assert.equal(exportedBake.assets.length, originalBake.assets.length);
    report.exported = { signature: exportedBake.signature, statistics: exportedBake.statistics };
    for (const asset of exportedBake.assets) {
      const mapping = manifest.assets.find(entry => entry.logicalUrl === asset.url);
      assert.ok(mapping, '资源清单缺少 ' + asset.id);
      const file = path.resolve(report.exportRoot, 'project/assets', mapping.path);
      assert.ok(inside(report.exportRoot, file));
      const bytes = await readFile(file);
      assert.equal(bytes.length, asset.byteLength);
      if (asset.sha256) assert.equal(createHash('sha256').update(bytes).digest('hex'), asset.sha256);
    }
    check('全部 PNG、几何 JSON 和探针 JSON 已导出且摘要一致');
    ({ server, base: report.base } = await createReadonlyViewerServer(report.exportRoot, report.requests));
    const chunks = await readdir(path.join(report.exportRoot, 'assets'));
    const engineStoreFile = chunks.find(name => /^engineStore-.*\.js$/.test(name));
    assert.ok(engineStoreFile, '实际 Viewer 模板缺少 EngineStore chunk，请先构建最新 Viewer');
    const expectedPaths = exportedBake.assets.map(asset => {
      const mapping = manifest.assets.find(entry => entry.logicalUrl === asset.url);
      return { id: asset.id, kind: asset.kind, path: new URL(mapping.path, new URL(runtimeConfig.paths.assetBase, report.base)).pathname };
    });
    broker.drive('lift', {}); broker.drive('hclift', {});
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    page = await browser.newPage({ viewport }); page.setDefaultTimeout(60_000);
    page.on('pageerror', error => report.pageErrors.push(error.stack ?? error.message));
    page.on('console', message => {
      if (message.type() === 'error' && observeNetwork) report.consoleErrors.push(message.text());
      if (message.text().startsWith('[Viewer]')) report.runtimeLogs.push(message.text());
    });
    page.on('requestfailed', request => { if (observeNetwork) report.requestFailures.push({ url: request.url(), error: request.failure()?.errorText }); });
    page.on('websocket', socket => {
      const item = { url: socket.url(), received: 0, sent: 0 }; report.websockets.push(item);
      socket.on('framereceived', () => item.received++); socket.on('framesent', () => item.sent++);
    });
    await page.goto(report.base, { waitUntil: 'domcontentloaded' });
    await installViewerProbe(page, new URL('assets/' + engineStoreFile, report.base).href);
    await page.waitForFunction(count => {
      const state = window.__lightingViewerProbe?.snapshot();
      return state?.ready && state.deck && state.staticMaps.length === count;
    }, exportedBake.surfaces.length, { timeout: 180_000 });
    await page.locator('#scene-loading-mask-detail').waitFor({ state: 'hidden', timeout: 180_000 });
    await page.evaluate(() => {
      const camera = window.__lightingViewerProbe.scene().activeCamera;
      camera.target.set(0, 2.7, 0); camera.alpha = -0.65; camera.beta = 1.15; camera.radius = 20;
    });
    await frames(page);
    const capture = async name => {
      const file = path.join(runRoot, name + '.png');
      const png = await page.locator('canvas').first().screenshot({ path: file });
      report.screenshots.push(file);
      const snapshot = await page.evaluate(() => window.__lightingViewerProbe.snapshot());
      const pixels = await pixelSummary(page, png);
      report.snapshots.push({ name, snapshot, pixels });
      return snapshot;
    };
    await page.waitForFunction(() => window.__lightingViewerProbe.snapshot()?.deck?.center[1] < 0.9, null, { timeout: 60_000 });
    const before = await capture('viewer-idle');
    assertStaticGi(before, exportedBake.surfaces.length);
    report.policyBindings = [];
    for (const expected of expectedPolicyBindings) {
      const maps = before.staticMaps.filter(mesh => mesh.entityId === expected.entityId && mesh.sourceKey?.includes(expected.nodeName));
      assert.ok(maps.length > 0, 'Viewer缺少集中规则验证部件：' + JSON.stringify(expected));
      assert.ok(maps.every(mesh => mesh.receiveShadows === expected.receiveShadows), 'Viewer未应用资源/部件规则：' + JSON.stringify({ expected, maps }));
      const rendered = maps.filter(mesh => mesh.rendered);
      assert.ok(rendered.length > 0, '集中规则验证部件必须实际绘制：' + JSON.stringify(expected));
      assert.ok(rendered.every(mesh => mesh.receivesShadowShader === expected.receiveShadows), '实际shader未采用集中接收阴影规则：' + JSON.stringify({ expected, rendered }));
      if (!expected.receiveShadows) assert.equal(sourceScene.entities[expected.entityId].components.lighting, undefined,
        '验证资源规则的新增实例不能依赖逐实体例外');
      report.policyBindings.push({ expected, actual: maps.map(mesh => ({ sourceKey: mesh.sourceKey,
        receiveShadows: mesh.receiveShadows, receivesShadowShader: mesh.receivesShadowShader, rendered: mesh.rendered })) });
    }
    if (expectedPolicyBindings.length) check('集中资源/部件规则已在独立Viewer实际shader生效，新增实例无逐模型例外');
    const pixels = report.snapshots.at(-1).pixels;
    assert.ok(pixels.palette > 16 && pixels.varying > pixels.width * pixels.height * 0.01 && pixels.colored > 100, JSON.stringify(pixels));
    report.materialColors = [];
    const staticEntityIds = new Set(exportedBake.surfaces.map(surface => surface.entityId));
    for (const [id, entity] of Object.entries(sourceScene.entities)) {
      const hex = entity.components?.meshRenderer?.materialColor;
      if (!staticEntityIds.has(id) || !/^#[\da-f]{6}$/i.test(hex ?? '')) continue;
      const actual = before.staticMaps.filter(mesh => mesh.entityId === id);
      assert.ok(actual.length, 'Viewer 缺少用于核验底色的静态模型：' + id);
      const expected = [1, 3, 5].map(start => parseInt(hex.slice(start, start + 2), 16) / 255);
      assert.ok(actual.every(mesh => mesh.color && mesh.color.every((value, index) => Math.abs(value - expected[index]) < 1e-5)), 'Viewer 改变了静态模型底色：' + id);
      report.materialColors.push({ entityId: id, expected, actual: actual.map(mesh => mesh.color) });
    }
    assert.ok(report.materialColors.length > 0, '夹具必须包含实际绘制并保留模型底色的静态对象');
    check('独立 Edge Viewer 无 editorApi，实际硬件 WebGL 绘制完整静态 GI 与模型颜色');
    const initialY = before.deck.center[1];
    broker.drive('lift', { reference_upper_step: 1, level_upper: 2, work_state: 0 });
    await page.waitForFunction(y => window.__lightingViewerProbe.snapshot()?.deck?.center[1] > y + 0.5, initialY, { timeout: 60_000 });
    await frames(page);
    const up = await capture('viewer-lift-up');
    assertStaticGi(up, exportedBake.surfaces.length); assertSameStaticGi(before, up);
    broker.drive('lift', { reference_upper_step: 1, level_upper: 1, work_state: 0 });
    await page.waitForFunction(y => window.__lightingViewerProbe.snapshot()?.deck?.center[1] < y - 0.3, up.deck.center[1], { timeout: 60_000 });
    await frames(page);
    const down = await capture('viewer-lift-down');
    assertStaticGi(down, exportedBake.surfaces.length); assertSameStaticGi(before, down);
    assert.ok(report.websockets.some(socket => socket.url === brokerAddress.href && socket.received > 0), 'Viewer 必须实际收到本地 MQTT 消息');
    check('真实 MQTT 升降与回落生效，静态 GI 材质、几何和世界姿态保持不变');
    report.assetRequests = expectedPaths.map(asset => ({ ...asset,
      loads: report.requests.filter(request => request.path === asset.path && request.method === 'GET' && request.complete && request.status === 200).length }));
    assert.ok(report.assetRequests.every(asset => asset.loads > 0), JSON.stringify(report.assetRequests));
    report.glErrors = await page.evaluate(() => {
      const gl = window.__lightingViewerProbe.scene().getEngine()._gl, errors = [];
      for (let error = gl.getError(); error !== gl.NO_ERROR && errors.length < 64; error = gl.getError()) errors.push(error);
      return errors;
    });
    assert.deepEqual(report.glErrors, []);
    // Viewer 会取消过时的初始化/预取；同 URL 必须已有完整成功读取，才能视为已恢复的取消。
    report.recoveredAborts = report.requestFailures.filter(failure => failure.error === 'net::ERR_ABORTED'
      && report.requests.some(request => new URL(request.path, report.base).href === failure.url
        && request.method === 'GET' && request.complete && request.status === 200));
    report.unrecoveredFailures = report.requestFailures.filter(failure => !report.recoveredAborts.includes(failure));
    assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.consoleErrors, []); assert.deepEqual(report.unrecoveredFailures, []);
    assert.deepEqual((broker.errors ?? []).slice(brokerErrorStart), []);
    check('Viewer 实际读取全部光照资产，无页面、未恢复网络或 GPU/shader 错误');
    report.status = 'PASS';
  } catch (error) {
    failure = error; report.status = 'FAIL'; report.failure = error.stack ?? String(error);
    if (page && !page.isClosed()) {
      try {
        const file = path.join(runRoot, 'viewer-failure.png');
        await page.screenshot({ path: file }); report.screenshots.push(file);
        report.failureScene = await page.evaluate(() => window.__lightingViewerProbe?.snapshot() ?? null);
        report.failureText = await page.locator('body').innerText();
      } catch (captureError) { report.failureCaptureError = String(captureError?.message ?? captureError); }
    }
  } finally {
    observeNetwork = false;
    const cleanupErrors = [];
    try { await browser?.close(); } catch (error) { cleanupErrors.push(String(error?.message ?? error)); }
    if (server) {
      try { server.closeAllConnections(); await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
      catch (error) { cleanupErrors.push(String(error?.message ?? error)); }
    }
    try { await restoreExportDialog(application); } catch (error) { cleanupErrors.push(String(error?.message ?? error)); }
    broker.drive('lift', {}); broker.drive('hclift', {});
    if (cleanupErrors.length) {
      report.cleanupErrors = cleanupErrors; report.status = 'FAIL';
      failure ??= new Error('Viewer 验收资源清理失败：' + cleanupErrors.join('；'));
    }
    report.finishedAt = new Date().toISOString();
    await save();
  }
  if (failure) throw failure;
  return { ...report, reportPath };
}
