import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { createDeploymentReleaseCacheManifest } from '../dist-electron/ipc/deploymentReleaseCacheManifest.js';

// npm run build:viewer && npm run build:electron 后运行；可显式传入既有场景、GLB，只读提取最小模型夹具。
const [sceneArgument, modelArgument] = process.argv.slice(2);
const template = path.resolve(process.env.VIEWER_TEMPLATE_DIR ?? 'dist-viewer-template');
const output = path.resolve('output/playwright/published-release-cache', `run-${Date.now()}`);
const profile = path.join(output, 'browser-profile');
const timeout = Number(process.env.RELEASE_CACHE_TIMEOUT_MS ?? 180_000);
const modelPath = path.resolve(modelArgument ?? 'public/builtin-model-packages/virtual-conveyor/virtual-conveyor.glb');
const lazyPath = 'assets/smoke-lazy-中文 #.txt';
const lazyBody = 'lazy-response-must-survive-refresh-and-release-switch';
const counts = new Map();
const wireBytes = new Map();
const samples = [];
const pageErrors = [];
const consoleErrors = [];
const releases = new Map();
let currentRelease = '1';
let context;
let faultBrowser;
let page;
let origin;
let server;
let failure;

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const releasePrefix = (version) => `/digital-twin/releases/123/${version}/`;
const signal = new AbortController().signal;
const mqtt = { enabled: false, ip: '', address: '', topic: '', subscriptions: [], simulatorEnabled: false,
  simulatorAssetCode: '', simulatorScenario: 'cycle', simulatorIntervalMs: 500 };

async function createFixture(version, model, skybox) {
  const root = path.join(output, 'releases', version);
  await cp(template, root, { recursive: true, errorOnExist: true, force: false });
  const scene = sceneArgument ? JSON.parse(await readFile(path.resolve(sceneArgument), 'utf8')) : { version: 5, units: { length: 'meter' }, scene: {} };
  const modelUrl = 'editor-asset://local/project%2Fassets%2Fmodel.glb';
  const skyboxUrl = 'editor-asset://local/project%2Fassets%2Fsky.hdr';
  const transform = { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } };
  scene.scene = {
    id: 'smoke-release-cache', name: `缓存发布 ${version}`, entityIds: ['model', 'skybox'], selectedEntityId: null,
    entities: {
      model: { id: 'model', name: '缓存验收模型', visible: true, locked: false, parentId: null, childrenIds: [], components: {
        transform, modelAsset: { sourcePath: modelUrl, sourceUrl: modelUrl, assetRevision: 'fixture', lengthUnit: 'meter', unitScaleToMeters: 1 },
      } },
      skybox: { id: 'skybox', name: '缓存验收天空盒', visible: true, locked: false, parentId: null, childrenIds: [], components: {
        transform, skybox: { packagePath: 'editor-asset://local/project%2Fassets%2F', sourcePath: skyboxUrl, sourceUrl: skyboxUrl,
          format: 'hdr', resolution: 256, intensity: 0.5, assetRevision: 'fixture' },
      } },
    },
    fetchConfig: { url: '', apiKey: '' }, mqttConfig: mqtt,
    sceneSettings: { camera: { savedPose: { alpha: -Math.PI / 3, beta: Math.PI / 3, radius: 6, target: { x: 0, y: 0, z: 0 } },
      savedOrientation: 'orbit', savedProjection: 'perspective', viewDistance: 1000 } },
  };
  const config = { version: 2, cacheRevision: `smoke-release-${version}`, cacheManifest: 'release-cache-manifest.json',
    page: { title: `缓存验收 ${version}`, loadingText: '场景加载中...', backgroundColor: '#141414' },
    paths: { scene: './project/scene.json', assetManifest: './project/asset-manifest.json', assetBase: './project/assets/' },
    viewer: { showGrid: false, allowCameraControl: true, showStatusOverlay: false }, mqtt,
    digitalTwin: { projectId: '123', runtimeConfigEndpoint: '/api/runtime-config' },
  };
  const assetManifest = { version: 1, assets: [
    { logicalUrl: modelUrl, path: './model.glb', kind: 'model', size: model.length, sha256: sha256(model) },
    { logicalUrl: skyboxUrl, path: './sky.hdr', kind: 'texture', size: skybox.length, sha256: sha256(skybox) },
  ] };
  for (const [relative, content] of [
    ['runtime-config.json', JSON.stringify(config)], ['project/scene.json', JSON.stringify(scene)],
    ['project/asset-manifest.json', JSON.stringify(assetManifest)], ['project/assets/model.glb', model],
    ['project/assets/sky.hdr', skybox], [lazyPath, lazyBody],
  ]) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  const manifest = await createDeploymentReleaseCacheManifest(root, config.cacheRevision, signal);
  await writeFile(path.join(root, 'release-cache-manifest.json'), JSON.stringify(manifest));
  assert.ok(manifest.files.some((file) => file.path.endsWith('.wasm')), '真实 Viewer 模板必须包含 WASM');
  assert.ok(manifest.files.some((file) => file.path.endsWith('.css')), '真实 Viewer 模板必须包含 CSS');
  assert.ok(manifest.files.some((file) => file.path === 'manual-roam/EQ_People.glb'), '实际模板必须包含懒加载 avatar');
  releases.set(version, { root, manifest, config });
}

async function startServer() {
  server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url, 'http://fixture');
      let pathname = decodeURIComponent(url.pathname);
      if (/^\/digital-twin\/releases\/123\/\d+\/$/.test(pathname)) pathname += 'index.html';
      counts.set(pathname, (counts.get(pathname) ?? 0) + 1);
      // 强制证明应用缓存命中，不能让浏览器的 HTTP 缓存掩盖遗漏。
      response.setHeader('Cache-Control', 'no-store');
      const send = (body, contentType) => {
        response.setHeader('Content-Type', contentType);
        wireBytes.set(pathname, (wireBytes.get(pathname) ?? 0) + Buffer.byteLength(body));
        response.end(body);
      };
      if (pathname === '/bigscreen') {
        send(`<!doctype html><html><head><title>大屏缓存验收</title></head><body style="margin:0;background:#141414">
          <iframe title="数字孪生" style="width:100vw;height:100vh;border:0" sandbox="allow-scripts allow-same-origin allow-pointer-lock"></iframe>
          <script>fetch('/api/project-status',{cache:'no-store'}).then(r=>r.json()).then(status=>{
            if(status.status!=='ACTIVE')throw Error('项目不在线');
            document.querySelector('iframe').src=status.releaseUrl+'?performance=1';
          });</script></body></html>`, 'text/html; charset=utf-8');
        return;
      }
      if (pathname === '/api/project-status') {
        send(JSON.stringify({ projectId: '123', status: 'ACTIVE', releaseUrl: releasePrefix(currentRelease) }), 'application/json');
        return;
      }
      if (pathname === '/api/runtime-config') {
        send(JSON.stringify({ success: true, data: { projectId: '123', runtimeEnabled: true, mqttBrokerUrl: null,
          apiBaseUrl: null, configJson: '{}' } }), 'application/json');
        return;
      }
      if (pathname === '/api/business-state') {
        send(JSON.stringify({ success: true, data: { speed: 42, sequence: counts.get(pathname) } }), 'application/json');
        return;
      }
      if (pathname === '/favicon.ico') { response.statusCode = 204; response.end(); return; }
      const match = /^\/digital-twin\/releases\/123\/(\d+)\/(.+)$/.exec(pathname);
      const release = match && releases.get(match[1]);
      if (!release) { response.statusCode = 404; response.end(); return; }
      const relative = match[2];
      const target = path.resolve(release.root, relative);
      const inside = path.relative(release.root, target);
      assert.ok(inside && !inside.startsWith('..') && !path.isAbsolute(inside), '服务文件必须位于测试发布目录内');
      const entry = release.manifest.files.find((file) => decodeURIComponent(file.path) === relative);
      const type = entry?.contentType ?? (relative.endsWith('.json') ? 'application/json' : relative.endsWith('.js') ? 'text/javascript' : 'application/octet-stream');
      send(await readFile(target), type);
    })().catch((error) => {
      consoleErrors.push({ source: 'fixture-server', message: String(error) });
      response.statusCode = error?.code === 'ENOENT' ? 404 : 500;
      response.end(String(error));
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
}

function trackPage(target) {
  target.setDefaultTimeout(timeout);
  target.on('pageerror', (error) => pageErrors.push({ url: target.url(), message: error.stack ?? error.message }));
  target.on('console', (message) => { if (message.type() === 'error') consoleErrors.push({ url: target.url(), message: message.text() }); });
}

async function launch() {
  context = await chromium.launchPersistentContext(profile, { executablePath: process.env.CHROME_PATH
    ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, viewport: { width: 1100, height: 760 },
    serviceWorkers: 'allow' });
  context.on('page', trackPage);
  page = context.pages()[0] ?? await context.newPage();
  trackPage(page);
}

async function ready(target, version, expectedPhase = 'ready') {
  await target.waitForFunction((prefix) => document.querySelector('iframe')?.src.includes(prefix), releasePrefix(version));
  await target.frameLocator('iframe').locator('.player-performance').waitFor({ state: 'visible' });
  const frame = target.frames().find((item) => item.url().includes(releasePrefix(version)));
  assert.ok(frame, '宿主页应解析并锁定当前发布地址');
  await frame.getByRole('progressbar').waitFor({ state: 'detached' });
  assert.equal(await frame.locator('.player-status-blocked').count(), 0, await frame.locator('body').innerText());
  await frame.waitForFunction(() => ['ready', 'partial'].includes(globalThis.__ZENDING_RELEASE_CACHE__?.phase), null, { timeout });
  const state = await frame.evaluate(() => globalThis.__ZENDING_RELEASE_CACHE__);
  assert.equal(state.phase, expectedPhase, `缓存状态应为 ${expectedPhase}：${JSON.stringify(state)}`);
  if (expectedPhase === 'ready' || state.totalFiles > 0) {
    assert.equal(state.totalFiles, releases.get(version).manifest.files.length);
    assert.equal(state.totalBytes, releases.get(version).manifest.totalBytes);
  } else {
    assert.equal(state.totalBytes, 0, '清单尚未返回时不能伪造待缓存字节数');
    assert.equal(state.completedFiles, 0);
    assert.equal(state.completedBytes, 0);
  }
  if (expectedPhase === 'ready') {
    assert.equal(state.completedFiles, state.totalFiles);
    assert.equal(state.completedBytes, state.totalBytes);
  } else {
    assert.ok(state.totalFiles === 0 || state.completedFiles < state.totalFiles, '故障时不得把全部资源标为已持久缓存');
    assert.ok(typeof state.reason === 'string' && state.reason, '部分缓存必须说明原因');
  }
  return { frame, state };
}

function snapshot() { return new Map(counts); }
function increments(before, version) {
  return releases.get(version).manifest.files.map((file) => {
    const resource = releasePrefix(version) + decodeURIComponent(file.path);
    return { path: file.path, storage: file.storage, requests: (counts.get(resource) ?? 0) - (before.get(resource) ?? 0) };
  });
}
function assertNoStaticDownloads(before, version, label, exceptions = new Map()) {
  for (const entry of increments(before, version)) assert.equal(entry.requests, exceptions.get(decodeURIComponent(entry.path)) ?? 0,
    `${label}: ${entry.path} 不应重新下载`);
}

async function renderedPixels(frame) {
  return frame.evaluate(() => new Promise((resolve, reject) => requestAnimationFrame(() => {
    try {
      const canvas = document.querySelector('canvas');
      const gl = canvas?.getContext('webgl2') ?? canvas?.getContext('webgl');
      if (!gl || !canvas.width || !canvas.height) throw new Error('Viewer 未创建 WebGL 画布');
      const pixels = new Uint8Array(canvas.width * canvas.height * 4);
      gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      const colors = new Set();
      for (let offset = 0; offset < pixels.length; offset += 16) colors.add(`${pixels[offset]},${pixels[offset + 1]},${pixels[offset + 2]}`);
      resolve({ width: canvas.width, height: canvas.height, colors: colors.size, renderer: gl.getParameter(gl.RENDERER) });
    } catch (error) { reject(error); }
  })));
}

async function record(name, target, version, before, extra = {}, expectedPhase = 'ready') {
  const { frame, state } = await ready(target, version, expectedPhase);
  const pixels = await renderedPixels(frame);
  assert.ok(pixels.colors > 5, `缓存后的 Viewer 应有实际三维像素：${JSON.stringify(pixels)}`);
  await target.screenshot({ path: path.join(output, `${name}.png`) });
  const sample = { name, version, state, pixels, staticRequests: increments(before, version), ...extra };
  samples.push(sample);
  console.log(JSON.stringify({ name, version, phase: state.phase, files: state.completedFiles,
    bytes: state.completedBytes, networkStaticRequests: sample.staticRequests.reduce((sum, file) => sum + file.requests, 0) }));
  return frame;
}

async function fetchLazy(frame, relative = lazyPath) {
  return frame.evaluate(async (file) => {
    const safePath = file.split('/').map(encodeURIComponent).join('/');
    const response = await fetch(new URL(safePath, location.href));
    if (!response.ok) throw new Error(`懒加载文件 ${file}: ${response.status}`);
    const bytes = await response.arrayBuffer();
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return { bytes: bytes.byteLength, status: response.status,
      sha256: Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('') };
  }, relative);
}

async function corruptResponse(frame, version) {
  return frame.evaluate(async ({ version, relative }) => {
    const base = new URL(`/digital-twin/releases/123/${version}/`, location.origin).href;
    const name = `zending-published-response:v1:${encodeURIComponent(base)}:${encodeURIComponent(`smoke-release-${version}`)}`;
    const cache = await caches.open(name);
    const url = new URL(relative.split('/').map(encodeURIComponent).join('/'), base).href;
    if (!await cache.match(url)) throw new Error('待破坏的响应尚未缓存');
    await cache.put(url, new Response('corrupted response', { headers: { 'Content-Type': 'text/plain' } }));
    return { cacheName: name, url };
  }, { version, relative: lazyPath });
}

async function corruptModel(frame, version) {
  return frame.evaluate(async (releaseVersion) => {
    const suffix = `/digital-twin/releases/123/${releaseVersion}/project/assets/model.glb`;
    for (const databaseInfo of await indexedDB.databases()) {
      if (!databaseInfo.name?.startsWith('zending-')) continue;
      const database = await new Promise((resolve, reject) => {
        const request = indexedDB.open(databaseInfo.name); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      try {
        if (!database.objectStoreNames.contains('values')) continue;
        const result = await new Promise((resolve, reject) => {
          const transaction = database.transaction('values', 'readwrite');
          const store = transaction.objectStore('values');
          let changed;
          transaction.oncomplete = () => resolve(changed);
          transaction.onerror = () => reject(transaction.error);
          transaction.onabort = () => reject(transaction.error ?? new Error('损坏注入事务取消'));
          const cursor = store.openCursor();
          cursor.onsuccess = () => {
            const current = cursor.result;
            if (!current) return;
            const head = current.value;
            if (typeof current.key !== 'string' || !current.key.endsWith(suffix) || head?.format !== 'release-blob-v1' || !head.chunks?.length) {
              current.continue(); return;
            }
            const key = head.chunks[0];
            const request = store.get(key);
            request.onsuccess = () => {
              if (!(request.result instanceof Blob)) { transaction.abort(); return; }
              store.put(new Blob([new Uint8Array(request.result.size)]), key);
              changed = { database: databaseInfo.name, key, size: request.result.size };
            };
          };
        });
        if (result) return result;
      } finally { database.close(); }
    }
    throw new Error('未找到当前发布模型的原始分块缓存');
  }, version);
}

async function checkCacheFailureModes() {
  // 独立的新 context 不继承前述 SW、CacheStorage 或 IDB，避免旧缓存掩盖故障回退。
  await context.close(); context = null;
  faultBrowser = await chromium.launch({ executablePath: process.env.CHROME_PATH
    ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  context = await faultBrowser.newContext({ viewport: { width: 1100, height: 760 }, serviceWorkers: 'allow' });
  await context.addInitScript(() => {
    Object.defineProperty(IDBFactory.prototype, 'open', { configurable: true,
      value() { throw new DOMException('smoke: IndexedDB 不可用', 'InvalidStateError'); } });
  });
  page = await context.newPage(); trackPage(page);
  let before = snapshot();
  await page.goto(`${origin}/bigscreen?fault=indexeddb`);
  let frame = await record('indexeddb-unavailable', page, '1', before, { fault: 'IndexedDB.open throws' }, 'partial');
  const rawEntries = releases.get('1').manifest.files.filter((file) => file.storage === 'asset');
  for (const entry of rawEntries) {
    const resource = releasePrefix('1') + decodeURIComponent(entry.path);
    assert.ok((counts.get(resource) ?? 0) > (before.get(resource) ?? 0), `IDB 故障应联网加载 ${entry.path}`);
  }
  assert.equal(await frame.evaluate(() => {
    try { indexedDB.open('smoke-probe'); return false; } catch { return true; }
  }), true, 'IndexedDB 故障注入必须生效');
  await context.close(); context = null;

  context = await faultBrowser.newContext({ viewport: { width: 1100, height: 760 }, serviceWorkers: 'allow' });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, get: () => undefined });
  });
  page = await context.newPage(); trackPage(page);
  before = snapshot();
  await page.goto(`${origin}/bigscreen?fault=service-worker`);
  frame = await record('service-worker-unavailable-cold', page, '1', before,
    { fault: 'navigator.serviceWorker unavailable' }, 'partial');
  assert.equal(await frame.evaluate(() => navigator.serviceWorker === undefined), true, 'SW 故障注入必须生效');
  assert.equal((await frame.evaluate(() => globalThis.__ZENDING_RELEASE_CACHE__)).completedFiles, rawEntries.length,
    'SW 不可用时仍完整缓存四项原始场景与资源');
  before = snapshot();
  await page.reload();
  await record('service-worker-unavailable-refresh', page, '1', before,
    { fault: 'navigator.serviceWorker unavailable' }, 'partial');
  for (const entry of increments(before, '1').filter((file) => file.storage === 'asset')) {
    assert.equal(entry.requests, 0, `SW 不可用时刷新仍复用 raw 缓存：${entry.path}`);
  }
  assert.ok(increments(before, '1').some((entry) => entry.storage === 'response' && entry.requests > 0),
    'SW 不可用时壳资源按普通网络加载，不能冒充完整缓存');
  await context.close(); context = null;

  context = await faultBrowser.newContext({ viewport: { width: 1100, height: 760 }, serviceWorkers: 'allow' });
  await context.addInitScript(() => {
    const originalFetch = window.fetch.bind(window);
    const probe = { intercepted: 0, aborted: 0 };
    window.__SMOKE_CACHE_MANIFEST_FETCH__ = probe;
    window.fetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      if (!url.pathname.endsWith('/release-cache-manifest.json')) return originalFetch(input, init);
      probe.intercepted++;
      // 模拟永不返回的可选清单请求；只响应生产代码的 AbortSignal，不自行注入超时。
      const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      return new Promise((_resolve, reject) => {
        const abort = () => { probe.aborted++; reject(signal.reason ?? new DOMException('Aborted', 'AbortError')); };
        if (signal?.aborted) abort();
        else signal?.addEventListener('abort', abort, { once: true });
      });
    };
  });
  page = await context.newPage(); trackPage(page);
  before = snapshot();
  const setupStarted = Date.now();
  await page.goto(`${origin}/bigscreen?fault=manifest-never-returns`);
  frame = await record('cache-manifest-timeout', page, '1', before,
    { fault: 'release-cache-manifest.json fetch never settles before abort' }, 'partial');
  const setupElapsedMs = Date.now() - setupStarted;
  assert.ok(setupElapsedMs >= 12_000 && setupElapsedMs < 45_000,
    `缓存初始化应约 15 秒超时并继续首帧，实际 ${setupElapsedMs} ms`);
  const timeoutState = await frame.evaluate(() => globalThis.__ZENDING_RELEASE_CACHE__);
  assert.match(timeoutState.reason, /初始化超时/, '超时降级必须保留明确原因');
  const probe = await frame.evaluate(() => window.__SMOKE_CACHE_MANIFEST_FETCH__);
  assert.ok(probe.intercepted >= 1 && probe.aborted >= 1, '生产超时必须实际取消悬挂的清单请求');
  assert.ok((counts.get('/api/runtime-config') ?? 0) > (before.get('/api/runtime-config') ?? 0),
    '可选缓存超时不应阻断项目运行配置 API');
  assert.ok((counts.get(releasePrefix('1') + 'runtime-config.json') ?? 0)
    > (before.get(releasePrefix('1') + 'runtime-config.json') ?? 0), '发布运行配置仍正常获取');
  const businessResults = await frame.evaluate(async () => {
    const results = [];
    for (let index = 0; index < 2; index++) results.push(await (await fetch('/api/business-state')).json());
    return results;
  });
  assert.ok(businessResults.every((value) => value.success && value.data.speed === 42));
  assert.equal(businessResults[1].data.sequence, businessResults[0].data.sequence + 1,
    '缓存初始化超时后业务接口仍实时请求，不被缓存或阻断');
  samples.at(-1).setupElapsedMs = setupElapsedMs;
  samples.at(-1).abortProbe = probe;
  samples.at(-1).businessResults = businessResults;
  await context.close(); context = null;
  await faultBrowser.close(); faultBrowser = null;
}

try {
  await mkdir(output, { recursive: true });
  await stat(path.join(template, 'published-cache-worker.js'));
  const model = await readFile(modelPath);
  assert.equal(model.readUInt32LE(0), 0x46546c67, '模型输入必须为 GLB');
  const skybox = Buffer.concat([Buffer.from('#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 8 +X 16\n'),
    ...Array.from({ length: 8 }, (_, row) => Buffer.from([2, 2, 0, 16, 144, 32 + row * 12, 144, 128 - row * 8, 144, 64, 144, 129]))]);
  await createFixture('1', model, skybox);
  await createFixture('2', model, skybox);
  await startServer();
  await launch();

  let before = snapshot();
  await page.goto(`${origin}/bigscreen`);
  let frame = await record('cold', page, '1', before);
  for (const entry of increments(before, '1')) assert.ok(entry.requests >= 1, `首访遗漏静态文件：${entry.path}`);

  before = snapshot();
  await page.reload();
  frame = await record('refresh', page, '1', before);
  assertNoStaticDownloads(before, '1', '同版本刷新');
  assert.ok(counts.get('/api/runtime-config') > (before.get('/api/runtime-config') ?? 0), '运行配置每次刷新仍从网络读取');
  assert.ok(counts.get(releasePrefix('1') + 'runtime-config.json') > (before.get(releasePrefix('1') + 'runtime-config.json') ?? 0), '发布配置每次刷新仍读取');

  before = snapshot();
  assert.equal((await fetchLazy(frame)).sha256, sha256(lazyBody));
  assert.equal((await fetchLazy(frame, 'manual-roam/EQ_People.glb')).sha256,
    releases.get('1').manifest.files.find((file) => file.path === 'manual-roam/EQ_People.glb').sha256);
  assertNoStaticDownloads(before, '1', '首次进入懒加载功能');
  samples.push({ name: 'lazy-files', version: '1', files: [lazyPath, 'manual-roam/EQ_People.glb'], staticRequests: increments(before, '1') });

  before = snapshot();
  await page.goto(`${origin}/bigscreen?layout=republished-screen`);
  frame = await record('screen-republish', page, '1', before);
  assertNoStaticDownloads(before, '1', '仅重发大屏布局');

  before = snapshot();
  await context.close(); context = null;
  await launch();
  await page.goto(`${origin}/bigscreen`);
  frame = await record('browser-restart', page, '1', before);
  assertNoStaticDownloads(before, '1', '关闭 Chrome 后使用同一 profile 重启');

  before = snapshot();
  const damagedResponse = await corruptResponse(frame, '1');
  assert.equal((await fetchLazy(frame)).sha256, sha256(lazyBody));
  assertNoStaticDownloads(before, '1', '损坏响应仅补齐自身', new Map([[lazyPath, 1]]));
  samples.push({ name: 'response-repair', version: '1', damagedResponse, staticRequests: increments(before, '1') });

  before = snapshot();
  const damagedModel = await corruptModel(frame, '1');
  await page.reload();
  frame = await record('model-repair', page, '1', before, { damagedModel });
  assertNoStaticDownloads(before, '1', '损坏模型仅补齐自身', new Map([['project/assets/model.glb', 1]]));

  const oldPage = page;
  const oldFrame = frame;
  currentRelease = '2';
  before = snapshot();
  page = await context.newPage();
  await page.goto(`${origin}/bigscreen`);
  await record('new-release', page, '2', before);
  for (const entry of increments(before, '2')) assert.ok(entry.requests >= 1, `新版应创建独立缓存：${entry.path}`);
  assert.ok(oldFrame.url().includes(releasePrefix('1')), '旧标签页保持原发布地址');
  const oldCounts = snapshot();
  await fetchLazy(oldFrame);
  await record('old-release-still-open', oldPage, '1', oldCounts);
  assertNoStaticDownloads(oldCounts, '1', '新版发布不清理仍打开的旧版缓存');

  currentRelease = '1';
  before = snapshot();
  await page.goto(`${origin}/bigscreen?rollback=1`);
  await record('rollback-cached-release', page, '1', before);
  assertNoStaticDownloads(before, '1', '切回已完整缓存的旧版本');
  await checkCacheFailureModes();
  assert.deepEqual(pageErrors, [], '浏览器不得出现未捕获异常');
} catch (error) {
  failure = error;
  console.error(error);
  await page?.screenshot({ path: path.join(output, 'failure.png') }).catch(() => undefined);
  if (page) {
    const diagnostics = [];
    for (const frame of page.frames()) diagnostics.push({ url: frame.url(),
      body: await frame.locator('body').innerText({ timeout: 2000 }).catch(String),
      state: await frame.evaluate(() => globalThis.__ZENDING_RELEASE_CACHE__).catch(String) });
    await writeFile(path.join(output, 'failure-diagnostics.json'), JSON.stringify(diagnostics, null, 2)).catch(() => undefined);
  }
} finally {
  await context?.close().catch(() => undefined);
  await faultBrowser?.close().catch(() => undefined);
  if (server?.listening) await new Promise((resolve) => server.close(resolve));
  const report = { status: failure ? 'FAIL' : 'PASS', error: failure?.stack ?? null, template, modelPath, output, origin,
    samples, requests: Object.fromEntries(counts), transferredBytes: Object.fromEntries(wireBytes), pageErrors, consoleErrors,
    boundary: '真实生产 Viewer + 本机临时发布目录 + 独立持久 Chrome profile；非在线中台或实际业务场景验收。' };
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  await writeFile(path.resolve('output/playwright/published-release-cache/latest-report.json'), JSON.stringify({ report: path.join(output, 'report.json'), status: report.status }, null, 2));
  const relativeProfile = path.relative(output, path.resolve(profile));
  if (relativeProfile === 'browser-profile') await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  console.log(`发布缓存浏览器回归 ${report.status}: ${path.join(output, 'report.json')}`);
}
process.exitCode = failure ? 1 : 0;
