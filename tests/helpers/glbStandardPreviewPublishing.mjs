/* global window */
import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createHash, randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { inspectGlbScene, assertGlbSnapshotPreserved } from './glbStandardPreviewEditor.mjs';

const inside = (root, target) => {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
};

/** 正式导出只替换本次文件选择器，不修改生产导出过程或包内容。 */
export async function exportGlbViewer({ application, page, exportParent, content, name }) {
  await mkdir(exportParent, { recursive: true });
  await application.evaluate(({ dialog }, directory) => {
    const previous = dialog.showOpenDialog;
    globalThis.glbSmokeExportDialog = previous;
    dialog.showOpenDialog = async (...args) => args.at(-1)?.title === '选择 Web 部署工程输出目录'
      ? { canceled: false, filePaths: [directory] } : previous.apply(dialog, args);
  }, exportParent);
  try {
    const result = await page.evaluate(async ({ content, name, requestId }) => {
      window.glbExportProgress = [];
      const unsubscribe = window.editorApi.onWebProjectExportProgress(progress => {
        if (progress.requestId === requestId) window.glbExportProgress.push(progress);
      });
      let timer;
      try {
        const exported = window.editorApi.exportWebProject({ requestId, suggestedName: name, format: 'directory', sceneContent: content });
        return await Promise.race([exported, new Promise((_, reject) => {
          timer = setTimeout(() => {
            window.editorApi.cancelWebProjectExport({ requestId }).then(
              () => reject(new Error('GLB Viewer 正式导出超过 240 秒，已发送取消。')),
              error => reject(new Error('GLB Viewer 导出超时且取消失败：' + String(error))),
            );
          }, 240_000);
        })]);
      } finally { clearTimeout(timer); unsubscribe(); }
    }, { content, name, requestId: 'glb-preview-' + randomUUID() });
    assert.equal(result.canceled, false, JSON.stringify(result));
    assert.ok(result.outputPath && inside(exportParent, result.outputPath), JSON.stringify(result));
    return { result, progress: await page.evaluate(() => window.glbExportProgress) };
  } finally {
    await application.evaluate(({ dialog }) => {
      if (globalThis.glbSmokeExportDialog) dialog.showOpenDialog = globalThis.glbSmokeExportDialog;
      delete globalThis.glbSmokeExportDialog;
    });
  }
}

async function serveGlbViewer(root, requests) {
  const realRoot = await realpath(root);
  const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8', '.glb': 'model/gltf-binary', '.env': 'application/octet-stream', '.wasm': 'application/wasm' };
  const server = createServer(async (request, response) => {
    const entry = { path: request.url, status: null }; requests.push(entry);
    response.on('finish', () => { entry.status = response.statusCode; });
    try {
      if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405).end(); return; }
      const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
      if (pathname === '/favicon.ico') { response.writeHead(204).end(); return; }
      if (pathname.includes('\0') || pathname.split('/').includes('..')) { response.writeHead(403).end(); return; }
      const target = path.resolve(root, pathname.replace(/^\/+/, '') || 'index.html');
      if (!inside(root, target)) { response.writeHead(403).end(); return; }
      const actual = await realpath(target), info = await stat(actual);
      if (!inside(realRoot, actual) || !info.isFile()) { response.writeHead(403).end(); return; }
      response.setHeader('Content-Type', mime[path.extname(actual).toLowerCase()] ?? 'application/octet-stream');
      response.setHeader('Content-Length', info.size); response.setHeader('Cache-Control', 'no-store');
      if (request.method === 'HEAD') response.end(); else await pipeline(createReadStream(actual), response);
    } catch (error) {
      entry.error = String(error.message ?? error);
      if (!response.headersSent) response.writeHead(error.code === 'ENOENT' ? 404 : 500);
      response.end();
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { server, base: `http://127.0.0.1:${server.address().port}/` };
}

/** 发布目录由实际 Viewer 独立读取，所有非 loopback HTTP 请求均拒绝。 */
export async function inspectGlbViewer({ root, expected, output, executablePath }) {
  const result = { status: 'RUNNING', root, requests: [], blockedExternal: [], pageErrors: [], consoleErrors: [], requestFailures: [] };
  let server, browser, page;
  try {
    const serving = await serveGlbViewer(root, result.requests); server = serving.server; result.base = serving.base;
    const files = await readdir(path.join(root, 'assets'));
    const engineStoreFile = files.find(name => /^engineStore-.*\.js$/.test(name));
    assert.ok(engineStoreFile, '当前 Viewer 模板缺少正式 EngineStore chunk，请先 build:viewer');
    browser = await chromium.launch({ executablePath, headless: true });
    page = await browser.newPage({ viewport: expected.viewport, deviceScaleFactor: 1 });
    page.on('pageerror', error => result.pageErrors.push(error.stack ?? error.message));
    page.on('console', message => { if (message.type() === 'error') result.consoleErrors.push(message.text()); });
    page.on('requestfailed', request => result.requestFailures.push({ url: request.url(), error: request.failure()?.errorText }));
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (/^https?:$/.test(url.protocol) && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
        result.blockedExternal.push(url.href); return route.abort('blockedbyclient');
      }
      return route.continue();
    });
    await page.goto(result.base, { waitUntil: 'domcontentloaded', timeout: 120_000 });
    await page.evaluate(async engineStoreUrl => {
      const module = await import(engineStoreUrl);
      const store = Object.values(module).find(value => Array.isArray(value?.Instances));
      if (!store) throw new Error('Viewer EngineStore 未导出。');
      window.__glbScene = () => store.Instances.flatMap(engine => engine.scenes)
        .find(scene => scene.meshes.filter(mesh => mesh.isEnabled() && mesh.isVisible && mesh.getTotalVertices() > 0).length > 2000);
    }, new URL('assets/' + engineStoreFile, result.base).href);
    await page.waitForFunction(() => window.__glbScene()?.environmentTexture?.isReady() && window.__glbScene().isReady(), null, { timeout: 240_000 });
    await page.locator('#scene-loading-mask-detail').waitFor({ state: 'hidden', timeout: 240_000 });
    result.snapshot = await page.evaluate(inspectGlbScene);
    assertGlbSnapshotPreserved(expected, result.snapshot);
    assert.equal(await page.evaluate(() => typeof window.editorApi), 'undefined', 'Viewer 必须独立运行');
    result.screenshot = path.join(output, 'viewer-offline.png'); await page.screenshot({ path: result.screenshot });
    result.scene = JSON.parse(await readFile(path.join(root, 'project', 'scene.json'), 'utf8')).scene;
    assert.equal(result.scene.sceneSettings.lighting.environment.source, 'sandbox');
    assert.ok(result.requests.some(entry => /\.env(?:$|\?)/i.test(entry.path) && entry.status === 200), '发布目录必须实际读取本地 ENV 资源');
    assert.deepEqual(result.blockedExternal, [], 'GLB 标准预览不能依赖远程环境资源');
    assert.deepEqual(result.pageErrors, []); assert.deepEqual(result.consoleErrors, []);
    // 保留所有取消事件；只有已知发布文件在浏览器中完整重读且大小/SHA均匹配时，才能排除资源缺失。
    const knownFiles = new Map();
    const sha = bytes => createHash('sha256').update(bytes).digest('hex');
    for (const relative of ['project/asset-manifest.json', 'project/scene.json']) {
      const bytes = await readFile(path.join(root, relative));
      knownFiles.set('/' + relative, { size: bytes.length, sha256: sha(bytes), source: 'bootstrap-document' });
    }
    const assets = JSON.parse(await readFile(path.join(root, 'project/asset-manifest.json'), 'utf8'));
    for (const asset of assets.assets) knownFiles.set(new URL(asset.path, new URL('project/assets/', result.base)).pathname,
      { size: asset.size, sha256: asset.sha256, source: 'asset-manifest' });
    const capabilities = JSON.parse(await readFile(path.join(root, 'viewer-capabilities.json'), 'utf8'));
    for (const file of capabilities.entryFiles) knownFiles.set(new URL(file.path, result.base).pathname, { ...file, source: 'viewer-capabilities' });
    const environmentFile = files.find(name => /^sanGiuseppeBridge-.*\.env$/.test(name));
    assert.ok(environmentFile, '内置环境必须是本次模板实际携带的已知资源');
    knownFiles.set('/assets/' + environmentFile, { size: 1009720,
      sha256: '2f0415a106e19c3dbc70f5a5a037d2c0fa1f712a8f0140102adf7925ea49006f', source: 'sandbox-reference' });
    result.verifiedCancellations = [];
    for (const failure of [...result.requestFailures]) {
      const url = new URL(failure.url), expectedFile = knownFiles.get(url.pathname);
      if (failure.error !== 'net::ERR_ABORTED' || url.origin !== new URL(result.base).origin || url.search || !expectedFile) continue;
      if (result.verifiedCancellations.some(item => item.url === url.href)) continue;
      assert.ok(result.requests.some(item => item.path === url.pathname && item.status === 200), '取消事件必须已有真实 200 响应');
      const local = path.resolve(root, url.pathname.slice(1));
      assert.ok(inside(root, local), '完整性校验只读取当前发布目录');
      const bytes = await readFile(local);
      assert.equal(bytes.length, expectedFile.size); assert.equal(sha(bytes), expectedFile.sha256);
      const complete = await page.evaluate(async href => {
        const response = await fetch(href, { cache: 'no-store' }), bytes = await response.arrayBuffer();
        const digest = await crypto.subtle.digest('SHA-256', bytes);
        return { status: response.status, size: bytes.byteLength,
          sha256: Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('') };
      }, url.href);
      assert.deepEqual(complete, { status: 200, size: expectedFile.size, sha256: expectedFile.sha256 });
      result.verifiedCancellations.push({ url: url.href, ...complete, source: expectedFile.source });
    }
    result.unresolvedRequestFailures = result.requestFailures.filter(failure => failure.error !== 'net::ERR_ABORTED'
      || !result.verifiedCancellations.some(item => item.url === failure.url));
    assert.deepEqual(result.unresolvedRequestFailures, []);
    result.status = 'PASS';
    return result;
  } catch (error) {
    result.status = 'FAIL'; result.error = error.stack ?? String(error);
    if (page) {
      result.screenshot = path.join(output, 'viewer-failure.png'); await page.screenshot({ path: result.screenshot }).catch(() => {});
    }
    error.glbViewerReport = result;
    throw error;
  } finally { await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); }
}
