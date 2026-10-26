/* global window, document, requestAnimationFrame */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright';
import { decodeLightingGeometryResource } from '../../dist-electron/shared/sceneLightingBakeGeometryBinary.js';
import { assertPortableGiContract } from './phase2GiArtifacts.mjs';
import { openGiArtifactReader } from './phase2GiArchiveReader.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.webp': 'image/webp', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.ktx2': 'image/ktx2' };

/** 检查真实DIST文件的逐资产摘要和原精度几何，不把“页面能打开”当GI成功。 */
export async function inspectBusinessGiDist(root, expectedSnapshot, expectedScene) {
  const reader = await openGiArtifactReader(root);
  const file = JSON.parse((await reader.read('project/scene.json')).toString('utf8'));
  const snapshot = assertPortableGiContract(file.scene, expectedSnapshot, expectedScene);
  assert.ok(snapshot?.surfaces?.length && snapshot.probeAssetId);
  assert.equal(snapshot.surfaces.length, expectedSnapshot.surfaces.length);
  assert.equal(snapshot.geometrySignature, expectedSnapshot.geometrySignature);
  const manifest = JSON.parse((await reader.read('project/asset-manifest.json')).toString('utf8'));
  const checked = [], triangles = new Map();
  for (const asset of snapshot.assets) {
    const original = expectedSnapshot.assets.find(row => row.id === asset.id);
    assert.ok(original, 'DIST新增了未知GI资产'); assert.equal(asset.sha256, original.sha256);
    const mapping = manifest.assets.find(row => row.logicalUrl === asset.url);
    assert.ok(mapping, 'DIST清单遗漏GI资源：' + asset.id);
    const physical = path.posix.join('project/assets', mapping.path.replaceAll('\\', '/'));
    assert.ok(!path.isAbsolute(mapping.path) && !mapping.path.split(/[\\/]/).includes('..'));
    const bytes = await reader.read(physical);
    assert.equal(bytes.length, asset.byteLength); assert.equal(sha(bytes), asset.sha256);
    if (asset.kind === 'geometry') {
      const geometry = decodeLightingGeometryResource(new Uint8Array(bytes), asset.encoding);
      assert.ok(geometry.positions.length > 0 && geometry.indices.length > 0 && geometry.indices.length % 3 === 0);
      triangles.set(asset.id, geometry.indices.length / 3);
    }
    checked.push({ id: asset.id, kind: asset.kind, bytes: bytes.length, sha256: sha(bytes), path: mapping.path });
  }
  const expectedTriangles = snapshot.surfaces.reduce((sum, surface) => {
    assert.ok(triangles.has(surface.geometryAssetId), 'GI表面缺少原精度几何'); return sum + triangles.get(surface.geometryAssetId);
  }, 0);
  return { snapshot, checked, expectedTriangles, reader };
}

/** 本地v2运行配置查询沿用产品POST协议，只返回预置值；其它写请求拒绝，不连接真实中台。 */
export async function createBusinessGiViewerServer(root, projectId, requests) {
  const reader = await openGiArtifactReader(root);
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://fixture');
    const row = { method: request.method, path: url.pathname, status: 0 }; requests.push(row);
    response.on('finish', () => { row.status = response.statusCode; });
    try {
      response.setHeader('Cache-Control', 'no-store');
      if (['/phase2-gamma-host.html', '/phase2-receiver-roi-host.html'].includes(url.pathname) && request.method === 'GET') {
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        const title = url.pathname === '/phase2-gamma-host.html' ? 'Gamma GI Viewer' : 'Receiver ROI GI Viewer';
        response.end('<!doctype html><html><body style="margin:0"><iframe title="' + title + '" src="/" style="border:0;width:1200px;height:800px"></iframe></body></html>'); return;
      }
      if (url.pathname === '/api/v1/digital-twin/runtime-config/detail') {
        if (request.method !== 'POST') { response.writeHead(405).end(); return; }
        if (String(request.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase() !== 'application/json') { response.writeHead(415).end(); return; }
        const chunks = []; let length = 0;
        for await (const chunk of request) { length += chunk.length; if (length > 1024) { response.writeHead(413).end(); return; } chunks.push(chunk); }
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { response.writeHead(400).end(); return; }
        if (!body || Array.isArray(body) || Object.keys(body).length !== 1 || body.projectId !== projectId) { response.writeHead(403).end(); return; }
        row.readOnlyRuntimeQuery = true;
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ success: true, data: { projectId, runtimeEnabled: true,
          mqttBrokerUrl: null, apiBaseUrl: null, configJson: '{}' } })); return;
      }
      if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405).end(); return; }
      if (url.pathname === '/favicon.ico') { response.writeHead(204).end(); return; }
      const decoded = decodeURIComponent(url.pathname);
      if (decoded.includes('\0') || decoded.split('/').includes('..')) { response.writeHead(403).end(); return; }
      const file = decoded.replace(/^\/+/, '') || 'index.html', info = await reader.describe(file);
      response.setHeader('Content-Type', mime[path.extname(file).toLowerCase()] ?? 'application/octet-stream'); response.setHeader('Content-Length', info.size);
      if (request.method === 'HEAD') { response.end(); return; }
      const stream = info.stream(); stream.on('error', () => response.destroy()); stream.pipe(response);
    } catch (error) { if (!response.headersSent) response.writeHead(error.code === 'ENOENT' ? 404 : 500); response.end(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { server, origin: 'http://127.0.0.1:' + server.address().port };
}

export async function verifyBusinessGiViewer({ root, snapshot, expectedScene, output, projectId, signal, maxRendererHeapBytes, gamma = false, iframe = false, expectedReceiverTriangles }) {
  const artifact = await inspectBusinessGiDist(root, snapshot, expectedScene), requests = [];
  const receiverRoi = expectedReceiverTriangles !== undefined;
  if (expectedReceiverTriangles !== undefined) {
    assert.ok(Number.isSafeInteger(expectedReceiverTriangles) && expectedReceiverTriangles > 0);
    assert.equal(artifact.expectedTriangles, expectedReceiverTriangles, 'DIST独立解码几何必须等于fresh capture的receiver总量');
  }
  const report = { status: 'RUNNING', scope: 'local static DIST Viewer; actual business GI; read-only local v2 runtime envelope',
    checkedAssets: artifact.checked, signature: artifact.snapshot.signature, geometrySignature: artifact.snapshot.geometrySignature,
    expectedTriangles: artifact.expectedTriangles, requests, errors: [], consoleErrors: [], externalRequests: [] };
  let browser, server, page;
  const cancel = () => { void browser?.close().catch(error => { report.cancelCloseError = String(error); }); };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    signal?.throwIfAborted();
    const chunks = await artifact.reader.list('assets'), engineChunk = chunks.find(name => /^engineStore-.*\.js$/.test(name));
    assert.ok(engineChunk, '请先构建实际Viewer模板');
    const hosted = await createBusinessGiViewerServer(root, projectId, requests); server = hosted.server;
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (['http:', 'https:'].includes(url.protocol) && url.origin !== hosted.origin) {
        report.externalRequests.push({ origin: url.origin, file: url.pathname.split('/').pop() }); return route.abort();
      }
      return route.continue();
    });
    page = await context.newPage();
    page.on('pageerror', error => report.errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(message.text()); });
    await page.goto(hosted.origin + '/', { waitUntil: 'domcontentloaded' });
    const install = target => target.evaluate(async ({ moduleUrl, gammaMode, strictRuntimeMode }) => {
      const module = await import(moduleUrl), store = Object.values(module).find(value => Array.isArray(value?.Instances));
      if (!store) throw new Error('Viewer实际EngineStore不可读取');
      const scene = () => store.Instances.flatMap(engine => engine.scenes)
        .find(value => value.meshes.some(mesh => mesh.metadata?.lightingDerived && mesh.isVerticesDataPresent('lightingBakeUV')));
      const maps = current => current.meshes.filter(mesh => mesh.metadata?.lightingDerived && mesh.isVerticesDataPresent('lightingBakeUV'));
      let runtimeCache;
      function runtime() {
        if (runtimeCache && !runtimeCache.scene.isDisposed) return runtimeCache;
        const root = document.getElementById('root'), key = Object.keys(root ?? {}).find(key => key.startsWith('__reactContainer$'));
        const first = root?.[key], queue = first ? [first.stateNode?.current ?? first] : [], seen = new Set();
        const visit = value => { if (!value || typeof value !== 'object') return; const current = value.current ?? value;
          if (current.scene?.meshes && !current.scene.isDisposed && typeof current.getLightingBakeRuntimeError === 'function') runtimeCache = current; };
        while (queue.length && seen.size < 30000) {
          const fiber = queue.pop(); if (!fiber || seen.has(fiber)) continue; seen.add(fiber);
          for (const value of Object.values(fiber.memoizedProps ?? {})) visit(value);
          let hook = fiber.memoizedState; for (let count = 0; hook && count < 500; count++, hook = hook.next) visit(hook.memoizedState);
          queue.push(fiber.child, fiber.sibling);
        }
        return runtimeCache;
      }
      window.__phase2Gi = {
        readinessReceipt() {
          const owner = runtime(), current = owner?.scene; if (!current) return null;
          const disposed = value => typeof value?.isDisposed === 'function' ? value.isDisposed() : value?.isDisposed ?? value?._isDisposed ?? null;
          const failed = [];
          // Scene.isReady检查hidden/disabled prototype，不能只看active/visible集合。
          for (const mesh of current.meshes) {
            if (!mesh.subMeshes?.length) continue;
            let ready, error; try { ready = mesh.isReady(true); } catch (failure) { ready = false; error = String(failure); }
            if (!ready) failed.push({ name: mesh.name, id: mesh.uniqueId, enabled: mesh.isEnabled(), visible: mesh.isVisible, layerMask: mesh.layerMask,
              disposed: disposed(mesh), material: mesh.material ? { name: mesh.material.name, id: mesh.material.uniqueId, disposed: disposed(mesh.material), inScene: current.materials.includes(mesh.material) } : null, error });
            if (failed.length === 15) break;
          }
          return { pendingCount: current._pendingData?.length, pending: (current._pendingData ?? []).slice(0, 15).map(value => ({ type: value.constructor?.name, name: value.name, url: value.url ?? value._url, disposed: disposed(value) })),
            notReadyMeshes: failed, notReadyTextures: current.textures.filter(value => !value.isReady()).slice(0, 15).map(value => ({ name: value.name, url: value.url, disposed: disposed(value) })),
            readinessStages: Array.from(current._isReadyForMeshStage ?? []).map(value => ({ index: value.index, component: value.component?.name, action: value.action?.name })) };
        },
        runtimeStatus() {
          const current = runtime();
          return { runtimeFound: Boolean(current), ready: current?.scene.isReady() ?? false,
            runtimeError: current ? current.getLightingBakeRuntimeError() : 'runtime not found', entrance: current?.getModelEntranceSnapshot(),
            hudErrors: [...document.querySelectorAll('.player-status p')].map(node => node.textContent).filter(value => /混合光照|重新烘焙/.test(value)) };
        },
        frame() {
          const current = scene(), camera = current?.activeCamera; if (!camera?.setTarget) return false;
          const list = maps(current); if (!list.length) return false;
          const low = [Infinity, Infinity, Infinity], high = [-Infinity, -Infinity, -Infinity];
          for (const mesh of list) {
            mesh.computeWorldMatrix(true); const bounds = mesh.getBoundingInfo().boundingBox;
            for (let axis = 0; axis < 3; axis++) { low[axis] = Math.min(low[axis], bounds.minimumWorld.asArray()[axis]); high[axis] = Math.max(high[axis], bounds.maximumWorld.asArray()[axis]); }
          }
          camera.setTarget(camera.getTarget().clone().copyFromFloats(...low.map((value, axis) => (value + high[axis]) / 2)));
          camera.alpha = -Math.PI / 4; camera.beta = Math.PI / 3;
          camera.radius = Math.max(2, Math.hypot(...high.map((value, axis) => value - low[axis])) / Math.sin(camera.fov / 2));
          return true;
        },
        snapshot() {
          const current = scene() ?? (strictRuntimeMode ? runtime()?.scene : null); if (!current) return null;
          const engine = current.getEngine(), active = current.getActiveMeshes(), activeSet = new Set(active.data.slice(0, active.length));
          return { ready: current.isReady(), ...(strictRuntimeMode ? this.runtimeStatus() : {}), editorApiPresent: typeof window.editorApi !== 'undefined',
            observedJsHeapBytes: performance.memory?.usedJSHeapSize ?? null,
            gpu: { version: engine.webGLVersion, info: engine.getGlInfo(), contextLost: engine._gl.isContextLost() },
            maps: maps(current).map(mesh => {
              const effect = mesh.subMeshes.map(sub => sub.effect).find(value => value?.defines?.includes('BAKED_INDIRECT_MAP'));
              let indirectActive = null, uniformError = null, bakeRange = null;
              const location = effect?.getUniform('lightingBakeActive'), program = effect?.getPipelineContext()?.program;
              if (location && program) { try { indirectActive = engine._gl.getUniform(program, location); } catch (error) { uniformError = String(error); } }
              if (gammaMode && effect && program) { const range = effect.getUniform('lightingBakeRange'); if (range) bakeRange = engine._gl.getUniform(program, range); }
              return { sourceKey: mesh.metadata.lightingSourceKey, vertices: mesh.getTotalVertices(), indices: mesh.getTotalIndices(),
                enabled: mesh.isEnabled(), visible: mesh.isVisible, layerMask: mesh.layerMask, rendered: activeSet.has(mesh),
                giShader: Boolean(effect), indirectActive, uniformError,
                ...(gammaMode ? { gammaShader: Boolean(effect?.defines?.match(/(?:^|\n)#define BAKED_INDIRECT_GAMMA(?:\s|$)/)), bakeRange,
                  giPlugin: Boolean(mesh.material?.pluginManager?.getPlugin('BakedIndirectLighting')),
                  entrancePlugin: Boolean(mesh.material?.pluginManager?.getPlugin('DigitalTwinModelEntrance')),
                  entranceProgress: mesh.material?.pluginManager?.getPlugin('DigitalTwinModelEntrance')?.progress ?? null,
                  entranceShader: Boolean(effect?.fragmentSourceCode?.includes('dtEntranceParams')),
                  shaderReadback: 'Effect.fragmentSourceCode getter' } : {}),
                texturesReady: mesh.material?.getActiveTextures().every(texture => texture.isReady()) ?? false };
            }) };
        },
        pixels() {
          const current = scene();
          return new Promise(resolve => current.onAfterRenderObservable.addOnce(() => {
            const engine = current.getEngine(), gl = engine._gl, width = engine.getRenderWidth(), height = engine.getRenderHeight();
            const bytes = new Uint8Array(width * height * 4); gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
            const colors = new Set(); for (let index = 0; index < bytes.length; index += 4) colors.add(bytes[index] + ',' + bytes[index + 1] + ',' + bytes[index + 2]);
            let binary = ''; for (let index = 0; index < bytes.length; index += 8192) binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
            resolve({ width, height, colors: colors.size, base64: btoa(binary), frameId: engine.frameId });
          }));
        },
      };
    }, { moduleUrl: hosted.origin + '/assets/' + engineChunk, gammaMode: gamma, strictRuntimeMode: gamma || receiverRoi });
    await install(page);
    await page.waitForFunction(({ count, earlyGamma }) => { const value = window.__phase2Gi.snapshot(); return value?.maps.length === count && (earlyGamma || value.ready); },
      { count: artifact.snapshot.surfaces.length, earlyGamma: gamma }, { timeout: 180000 });
    await page.waitForFunction(() => window.__phase2Gi.frame(), null, { timeout: 15000 });
    const capturePlaying = async (target, screenshotPage, name) => {
      await target.waitForFunction(() => {
        const value = window.__phase2Gi.snapshot(), entrance = value?.entrance;
        return entrance?.status === 'playing' && value.maps.some(row => row.rendered && row.entranceProgress > 0 && row.entranceProgress < 1);
      }, null, { timeout: 15000 });
      const value = await target.evaluate(() => window.__phase2Gi.snapshot());
      assert.ok(value.maps.filter(row => row.rendered).every(row => row.giPlugin && row.entrancePlugin && row.entranceShader && row.gammaShader && row.indirectActive === 1),
        '动画实际播放期间可见GI代理必须同时具备入口/GI插件及实际shader');
      const pixels = await target.evaluate(() => window.__phase2Gi.pixels()), bytes = Buffer.from(pixels.base64, 'base64');
      const file = path.join(output, name + '-playing.rgba'); await fs.writeFile(file, bytes);
      const screenshot = path.join(output, name + '-playing.png'); await screenshotPage.screenshot({ path: screenshot });
      return { state: value, pixels: { width: pixels.width, height: pixels.height, colors: pixels.colors, sha256: sha(bytes), file }, screenshot };
    };
    if (gamma && expectedScene.sceneSettings.modelEntrance?.enabled) report.gammaEntrancePlaying = await capturePlaying(page, page, 'dist-viewer-gamma');
    else await page.evaluate(() => new Promise(resolve => { let frames = 0; const next = () => ++frames === 6 ? resolve() : requestAnimationFrame(next); requestAnimationFrame(next); }));
    const strictGammaStable = async target => {
      if (gamma && expectedScene.sceneSettings.modelEntrance?.enabled && !expectedScene.sceneSettings.modelEntrance.loop) {
        await target.waitForFunction(() => window.__phase2Gi.runtimeStatus().entrance?.status === 'completed', null, { timeout: 30000 });
      }
      const samples = [];
      for (let index = 0; index < 10; index++) { samples.push(await target.evaluate(() => window.__phase2Gi.runtimeStatus())); await target.waitForTimeout(200); }
      assert.ok(samples.every(value => value.runtimeFound && value.ready && value.runtimeError === null && value.hudErrors.length === 0),
        '入口完成后连续2秒必须ready=true、runtimeError=null、HUD无光照错误');
      return samples;
    };
    if (gamma) report.gammaStableWindow = await strictGammaStable(page);
    if (receiverRoi) report.roiStableWindow = await strictGammaStable(page);
    report.viewer = await page.evaluate(() => window.__phase2Gi.snapshot());
    const value = report.viewer;
    assert.equal(value.editorApiPresent, false); assert.equal(value.gpu.version, 2); assert.equal(value.gpu.contextLost, false);
    if (maxRendererHeapBytes !== undefined) assert.ok(value.observedJsHeapBytes !== null && value.observedJsHeapBytes <= maxRendererHeapBytes, 'Viewer heap实际观察值未知或超冻结预算');
    assert.doesNotMatch(JSON.stringify(value.gpu.info), /swiftshader|llvmpipe|warp|software|basic render driver/i);
    assert.ok(value.maps.every(row => row.enabled && row.visible && row.layerMask !== 0 && row.texturesReady));
    assert.ok(value.maps.some(row => row.rendered && row.giShader), '实际渲染的GI shader未生效');
    assert.ok(value.maps.filter(row => row.rendered).every(row => row.giShader && row.indirectActive === 1 && row.uniformError === null), '实际绘制的GI uniform必须启用，不能仅编译了define');
    assert.equal(value.maps.reduce((sum, row) => sum + row.indices / 3, 0), artifact.expectedTriangles, 'Viewer代理三角形与已校验原精度几何不一致');
    const counts = rows => Object.fromEntries([...new Set(rows)].sort().map(key => [key, rows.filter(value => value === key).length]));
    const expectedKeys = artifact.snapshot.surfaces.map(surface => surface.key.replace(/\/primitive:\d+(?:\/tile:[^/]+)?$/, ''));
    assert.deepEqual(counts(value.maps.map(row => row.sourceKey)), counts(expectedKeys), '实际GI来源/每来源表面数不完整');
    const captureGamma = async (target, name, observed) => {
      assert.ok(observed.maps.filter(row => row.rendered).length > 0);
      if (gamma) assert.ok(observed.maps.filter(row => row.rendered).every(row => row.gammaShader && row.bakeRange >= 1), '实际绘制必须使用gamma define及真实range uniform');
      const pixels = await target.evaluate(() => window.__phase2Gi.pixels()), bytes = Buffer.from(pixels.base64, 'base64');
      assert.equal(bytes.length, pixels.width * pixels.height * 4); assert.ok(pixels.colors > 16, '完整3D buffer不能为空白/纯色');
      const filename = path.join(output, name + '.rgba'); await fs.writeFile(filename, bytes);
      return { width: pixels.width, height: pixels.height, colors: pixels.colors, bytes: bytes.length, sha256: sha(bytes), file: filename, frameId: pixels.frameId };
    };
    if (gamma) {
      report.gammaPixels = await captureGamma(page, 'dist-viewer-gamma', value);
      if (report.gammaEntrancePlaying) assert.notEqual(report.gammaPixels.sha256, report.gammaEntrancePlaying.pixels.sha256, '固定相机下入场中与完成后的完整3D buffer应变化');
    }
    if (iframe) {
      assert.ok(gamma || receiverRoi, 'iframe额外合同只在显式gamma或已验证receiver ROI模式启用');
      const host = await context.newPage(); host.on('pageerror', error => report.errors.push(error.message));
      host.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(message.text()); });
      await host.goto(hosted.origin + (gamma ? '/phase2-gamma-host.html' : '/phase2-receiver-roi-host.html'), { waitUntil: 'domcontentloaded' });
      await host.locator('iframe').waitFor({ state: 'visible' });
      const frame = await host.locator('iframe').contentFrame();
      await frame.locator('canvas').waitFor({ state: 'visible', timeout: 180000 });
      const actualFrame = host.frames().find(value => value !== host.mainFrame() && value.url().startsWith(hosted.origin)); assert.ok(actualFrame);
      await install(actualFrame);
      await actualFrame.waitForFunction(count => window.__phase2Gi.snapshot()?.maps.length === count, artifact.snapshot.surfaces.length, { timeout: 180000 });
      await actualFrame.waitForFunction(() => window.__phase2Gi.frame(), null, { timeout: 15000 });
      const playing = gamma && expectedScene.sceneSettings.modelEntrance?.enabled ? await capturePlaying(actualFrame, host, 'dist-iframe-gamma') : null;
      if (!playing) await actualFrame.evaluate(() => new Promise(resolve => { let count = 0; const next = () => ++count === 6 ? resolve() : requestAnimationFrame(next); requestAnimationFrame(next); }));
      const stableWindow = await strictGammaStable(actualFrame);
      const state = await actualFrame.evaluate(() => window.__phase2Gi.snapshot());
      assert.equal(state.editorApiPresent, false); assert.equal(state.gpu.version, 2); assert.equal(state.gpu.contextLost, false);
      if (maxRendererHeapBytes !== undefined) assert.ok(state.observedJsHeapBytes !== null && state.observedJsHeapBytes <= maxRendererHeapBytes, 'iframe heap实际观察值未知或超冻结预算');
      assert.doesNotMatch(JSON.stringify(state.gpu.info), /swiftshader|llvmpipe|warp|software|basic render driver/i);
      assert.ok(state.maps.every(row => row.enabled && row.visible && row.texturesReady));
      assert.ok(state.maps.filter(row => row.rendered).every(row => row.indirectActive === 1 && row.uniformError === null));
      assert.equal(state.maps.reduce((sum, row) => sum + row.indices / 3, 0), artifact.expectedTriangles);
      assert.deepEqual(counts(state.maps.map(row => row.sourceKey)), counts(expectedKeys));
      const iframeName = gamma ? 'dist-iframe-gamma' : 'dist-iframe-receiver-roi';
      report.iframe = { state, stableWindow, playing, pixels: await captureGamma(actualFrame, iframeName, state), screenshot: path.join(output, iframeName + '.png') };
      if (playing) assert.notEqual(report.iframe.pixels.sha256, playing.pixels.sha256);
      await host.screenshot({ path: report.iframe.screenshot }); await host.close();
    }
    assert.deepEqual(report.externalRequests, []); assert.deepEqual(report.errors, []); assert.deepEqual(report.consoleErrors, []);
    assert.ok(requests.some(row => row.readOnlyRuntimeQuery && row.status === 200), '必须通过真实v2只读运行配置查询协议启动');
    assert.ok(requests.every(row => ['GET', 'HEAD'].includes(row.method) || row.readOnlyRuntimeQuery), '仅允许精确的本地只读运行配置POST，不得发布/上传');
    report.screenshot = path.join(output, 'dist-viewer-gi.png'); await page.screenshot({ path: report.screenshot });
    report.status = 'PASS';
    return report;
  } catch (error) {
    report.status = 'FAIL'; report.error = String(error);
    if (page && !page.isClosed()) {
      report.failureState = await page.evaluate(() => ({ snapshot: window.__phase2Gi?.snapshot?.(), runtime: window.__phase2Gi?.runtimeStatus?.(), resources: window.__phase2Gi?.readinessReceipt?.() })).catch(error => ({ readbackError: String(error) }));
      report.failureScreenshot = path.join(output, 'dist-viewer-failure.png'); await page.screenshot({ path: report.failureScreenshot }).catch(() => {});
    }
    throw error;
  }
  finally {
    signal?.removeEventListener('abort', cancel);
    await browser?.close(); if (server) await new Promise(resolve => server.close(resolve));
    await fs.writeFile(path.join(output, 'dist-viewer-report.json'), JSON.stringify(report, null, 2) + '\n');
  }
}
