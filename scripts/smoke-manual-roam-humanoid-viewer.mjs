import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { createDeploymentReleaseCacheManifest } from '../dist-electron/ipc/deploymentReleaseCacheManifest.js';
import { copyManualRoamAvatarWithAdaptation } from '../dist-electron/ipc/manualRoamAvatarAdaptation.js';

// 使用正式构建的 Viewer 外壳与正式导入派生器；独立场景/发布配置为本机验收夹具。
const template = path.resolve(process.env.VIEWER_TEMPLATE_DIR ?? 'dist-viewer-template');
const output = path.resolve('output/playwright/manual-roam-humanoid-viewer', `run-${Date.now()}`);
const releaseRoot = path.join(output, 'release');
const profile = path.join(output, 'browser-profile');
const prefix = '/digital-twin/releases/123/1/';
const avatarRelativePath = 'project/assets/avatar.glb';
const sourcePath = path.resolve('scripts/manual-roam-assets/sources/Xbot.glb');
const timeout = 120_000;
const requests = new Map(), pageErrors = [], consoleErrors = [], samples = [];
let server, context, page, origin, manifest, failure;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

async function prepareFixture() {
  await stat(path.join(template, 'index.html'));
  await cp(template, releaseRoot, { recursive: true, errorOnExist: true, force: false });
  await mkdir(path.join(releaseRoot, 'project', 'assets'), { recursive: true });
  const target = path.join(releaseRoot, avatarRelativePath);
  await copyManualRoamAvatarWithAdaptation(sourcePath, target);
  const original = await readFile(sourcePath), avatar = await readFile(target);
  const json = JSON.parse(avatar.subarray(20, 20 + avatar.readUInt32LE(12)).toString().trimEnd());
  const metadata = json.nodes.find(node => node.extras?.manualRoamHumanoid)?.extras.manualRoamHumanoid;
  assert.equal(metadata?.sourceHash, sha256(original));
  assert.deepEqual(avatar.subarray(20 + avatar.readUInt32LE(12)), original.subarray(20 + original.readUInt32LE(12)));
  const logicalUrl = 'editor-asset://local/project%2Fassets%2Favatar.glb';
  const transform = { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } };
  const entity = (id, name, components) => ({ id, name, visible: true, locked: false, parentId: null, childrenIds: [], components });
  const mqtt = { enabled: false, ip: '', address: '', topic: '', subscriptions: [], simulatorEnabled: false,
    simulatorAssetCode: '', simulatorScenario: 'cycle', simulatorIntervalMs: 500 };
  const scene = { version: 5, units: { length: 'meter' }, scene: {
    id: 'humanoid-viewer-smoke', name: '普通人物发布验收', entityIds: ['ground', 'reference', 'roam'], selectedEntityId: null,
    entities: {
      ground: entity('ground', '地面', { transform: { ...transform, position: { x: 0, y: -.05, z: 0 }, scale: { x: 40, y: .1, z: 40 } }, meshRenderer: { meshKind: 'cube', materialColor: '#35465a' } }),
      reference: entity('reference', '距离参照', { transform: { ...transform, position: { x: 1.5, y: .5, z: 3 }, scale: { x: .4, y: 1, z: .4 } }, meshRenderer: { meshKind: 'cube', materialColor: '#c3904b' } }),
      roam: entity('roam', '手动漫游初始位置', { transform, manualRoamSpawn: { avatar: { name: '普通 Xbot', sourcePath: logicalUrl, sourceUrl: logicalUrl } } }),
    },
    mqttConfig: mqtt, fetchConfig: { url: '', apiKey: '' },
    sceneSettings: { camera: { savedPose: { alpha: -Math.PI / 3, beta: Math.PI / 3, radius: 5, target: { x: 0, y: .85, z: 0 } }, savedOrientation: 'orbit', savedProjection: 'perspective', viewDistance: 500 } },
  } };
  const config = { version: 1, cacheRevision: 'humanoid-auto-v1', cacheManifest: 'release-cache-manifest.json',
    page: { title: '普通人物自动适配 Viewer 验收', loadingText: '场景加载中...', backgroundColor: '#101822' },
    paths: { scene: './project/scene.json', assetManifest: './project/asset-manifest.json', assetBase: './project/assets/' },
    viewer: { showGrid: true, allowCameraControl: true, showStatusOverlay: false }, mqtt };
  const assets = { version: 1, assets: [{ logicalUrl, path: './avatar.glb', kind: 'model', size: avatar.length, sha256: sha256(avatar) }] };
  for (const [relative, value] of [['runtime-config.json', config], ['project/scene.json', scene], ['project/asset-manifest.json', assets]]) {
    await writeFile(path.join(releaseRoot, relative), JSON.stringify(value));
  }
  manifest = await createDeploymentReleaseCacheManifest(releaseRoot, config.cacheRevision, new AbortController().signal);
  await writeFile(path.join(releaseRoot, 'release-cache-manifest.json'), JSON.stringify(manifest));
  assert.ok(manifest.files.some(file => file.path === avatarRelativePath && file.storage === 'asset'));
  assert.ok(manifest.files.some(file => file.path === 'manual-roam/locomotion-v2.glb' && file.storage === 'asset'));
  return { sourceHash: metadata.sourceHash, derivedHash: sha256(avatar), bytes: avatar.length, manifestFiles: manifest.files.length };
}

async function serveFixture() {
  server = createServer((request, response) => {
    void (async () => {
      let pathname = decodeURIComponent(new URL(request.url, 'http://fixture').pathname);
      if (pathname === '/favicon.ico') { response.statusCode = 204; response.end(); return; }
      if (pathname === prefix) pathname += 'index.html';
      requests.set(pathname, (requests.get(pathname) ?? 0) + 1);
      response.setHeader('Cache-Control', 'no-store');
      if (!pathname.startsWith(prefix)) { response.statusCode = 404; response.end(); return; }
      const relative = pathname.slice(prefix.length), target = path.resolve(releaseRoot, relative), inside = path.relative(releaseRoot, target);
      assert.ok(inside && !inside.startsWith('..') && !path.isAbsolute(inside), '只能服务本次发布夹具目录');
      const entry = manifest.files.find(file => decodeURIComponent(file.path) === relative);
      const type = entry?.contentType ?? (relative.endsWith('.json') ? 'application/json' : relative.endsWith('.js') ? 'text/javascript' : 'application/octet-stream');
      response.setHeader('Content-Type', type); response.end(await readFile(target));
    })().catch(error => { consoleErrors.push({ source: 'fixture-server', error: String(error) }); response.statusCode = error?.code === 'ENOENT' ? 404 : 500; response.end(String(error)); });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
}

async function waitFrames(count) {
  await page.evaluate(count => new Promise(resolve => {
    let frame = 0; const step = () => { if (++frame >= count) resolve(); else requestAnimationFrame(step); }; requestAnimationFrame(step);
  }), count);
}
async function renderedPixels() {
  return page.evaluate(() => new Promise((resolve, reject) => requestAnimationFrame(() => {
    try {
      const canvas = document.querySelector('canvas'), gl = canvas?.getContext('webgl2') ?? canvas?.getContext('webgl');
      if (!gl || !canvas.width || !canvas.height) throw new Error('实际 Viewer 未创建 WebGL 画布');
      const pixels = new Uint8Array(canvas.width * canvas.height * 4); gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      const colors = new Set(); for (let offset = 0; offset < pixels.length; offset += 32) colors.add(`${pixels[offset]},${pixels[offset + 1]},${pixels[offset + 2]}`);
      resolve({ width: canvas.width, height: canvas.height, colors: colors.size, renderer: gl.getParameter(gl.RENDERER) });
    } catch (error) { reject(error); }
  })));
}
async function ready() {
  await page.waitForFunction(() => document.querySelector('.manual-roam-controls') || document.querySelector('.player-status-blocked'), null, { timeout });
  assert.equal(await page.locator('.player-status-blocked').count(), 0, await page.locator('body').innerText());
  await page.getByRole('button', { name: '开始漫游', exact: true }).waitFor({ state: 'visible', timeout });
  await page.getByText('自动适配动作', { exact: true }).waitFor({ state: 'visible', timeout });
  assert.equal(await page.locator('.player-status-blocked').count(), 0, await page.locator('body').innerText());
  await page.waitForFunction(() => ['ready', 'partial'].includes(globalThis.__ZENDING_RELEASE_CACHE__?.phase), null, { timeout });
  const cache = await page.evaluate(() => globalThis.__ZENDING_RELEASE_CACHE__);
  assert.equal(cache.phase, 'ready', `必须完成发布资源缓存：${JSON.stringify(cache)}`);
  assert.equal(cache.completedFiles, cache.totalFiles); assert.equal(cache.totalFiles, manifest.files.length);
  return cache;
}
async function exercise(name) {
  await page.getByRole('button', { name: '开始漫游', exact: true }).click();
  await page.getByText('运行中', { exact: true }).waitFor({ state: 'visible' });
  await page.getByText('自动适配动作', { exact: true }).waitFor({ state: 'visible' });
  // 使用真实控件拉远验收机位，完整记录腿与脚；不改 Viewer 的默认配置。
  const distance = page.locator('.manual-roam-slider').filter({ hasText: '跟随距离' }).locator('input');
  await distance.focus(); await distance.press('Home');
  for (let index = 0; index < 32; index++) await distance.press('ArrowRight');
  assert.equal(await distance.inputValue(), '4');
  await page.locator('canvas').focus(); await waitFrames(15);
  await page.screenshot({ path: path.join(output, `${name}-idle.png`) });
  await page.keyboard.down('KeyW'); await waitFrames(35);
  await page.screenshot({ path: path.join(output, `${name}-walk.png`) });
  await page.keyboard.down('Shift'); await waitFrames(30);
  await page.screenshot({ path: path.join(output, `${name}-run.png`) });
  await page.keyboard.up('KeyW'); await page.keyboard.up('Shift');
  await page.keyboard.press('Space'); await waitFrames(10);
  await page.screenshot({ path: path.join(output, `${name}-jump.png`) });
  const pixels = await renderedPixels(); assert.ok(pixels.colors > 20, `Viewer 必须有实际人物及地面像素：${JSON.stringify(pixels)}`);
  await page.getByRole('button', { name: '结束漫游', exact: true }).click();
  return pixels;
}

try {
  await mkdir(output, { recursive: true });
  const asset = await prepareFixture();
  await serveFixture();
  console.log(`正式 Viewer 本机夹具：${origin + prefix}`);
  context = await chromium.launchPersistentContext(profile, { executablePath: process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: true, viewport: { width: 1280, height: 900 }, serviceWorkers: 'allow', recordVideo: { dir: path.join(output, 'video'), size: { width: 1280, height: 900 } } });
  page = context.pages()[0] ?? await context.newPage(); page.setDefaultTimeout(timeout);
  page.on('pageerror', error => pageErrors.push(error.stack ?? error.message));
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push({ source: 'browser', message: message.text() }); });
  await page.goto(origin + prefix, { waitUntil: 'commit' });
  const coldCache = await ready();
  samples.push({ name: 'cold', cache: coldCache, pixels: await exercise('cold'), asset });
  assert.ok((requests.get(prefix + avatarRelativePath) ?? 0) >= 1, '首访必须实际下载派生人物 GLB');
  const before = new Map(requests);
  await page.reload({ waitUntil: 'commit' });
  samples.push({ name: 'warm-reopen', cache: await ready(), pixels: await exercise('warm-reopen') });
  for (const entry of manifest.files.filter(file => file.path.endsWith('.glb'))) {
    const resource = prefix + decodeURIComponent(entry.path);
    assert.equal((requests.get(resource) ?? 0) - (before.get(resource) ?? 0), 0, `二次打开不应重新下载 GLB：${entry.path}`);
  }
  assert.ok((requests.get(prefix + 'runtime-config.json') ?? 0) > (before.get(prefix + 'runtime-config.json') ?? 0), '发布配置仍须在线读取');
  const beforeOffline = new Map(requests);
  await context.setOffline(true);
  try { samples.push({ name: 'offline-reenter', pixels: await exercise('offline-reenter') }); }
  finally { await context.setOffline(false); }
  for (const file of [avatarRelativePath, 'manual-roam/locomotion-v2.glb']) {
    assert.equal(requests.get(prefix + file), beforeOffline.get(prefix + file), `已缓存资源离线进入不发起下载：${file}`);
  }
  assert.deepEqual(pageErrors, [], '正式 Viewer 不得有未处理运行错误');
  assert.deepEqual(consoleErrors, [], '正式 Viewer 不得有控制台或资源加载错误');
} catch (error) {
  failure = error; console.error(error);
  if (page) {
    await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
    await writeFile(path.join(output, 'failure-body.txt'), await page.locator('body').innerText().catch(String));
    await writeFile(path.join(output, 'failure-cache.json'), JSON.stringify(await page.evaluate(() => globalThis.__ZENDING_RELEASE_CACHE__).catch(String), null, 2));
  }
} finally {
  try {
    const video = page?.video();
    await page?.close();
    if (video) await video.saveAs(path.join(output, 'viewer-validation.webm'));
  } catch (error) { failure ??= error; }
  await context?.close().catch(() => {});
  if (server?.listening) await new Promise(resolve => server.close(resolve));
  const report = { status: failure ? 'FAIL' : 'PASS', error: failure?.stack ?? null, output, origin, template, sourcePath, samples,
    requests: Object.fromEntries(requests), pageErrors, consoleErrors,
    boundary: '正式构建 PlayerApp + 正式 GLB 派生器 + 本机独立发布夹具；验证缓存后二次打开与离线再进入，不代表在线中台部署。' };
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  if (path.relative(output, path.resolve(profile)) === 'browser-profile') await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  console.log(`普通人物发布 Viewer ${report.status}: ${path.join(output, 'report.json')}`);
}
process.exitCode = failure ? 1 : 0;
