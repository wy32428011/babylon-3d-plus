/* global document, window */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';

// 运行正式详情入口、隔离清单与宿主。此夹具不代表真实工程或业务数据。
let server;
let browser;
try {
  let origin = process.env.INSPECTION_FIXTURE_ORIGIN;
  if (!origin) {
    server = await createServer({
      configFile: 'tests/fixtures/inspection/vite.config.mjs',
      server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false },
    });
    await server.listen();
    const address = server.httpServer.address();
    assert.ok(address && typeof address === 'object');
    origin = `http://127.0.0.1:${address.port}`;
  }
  browser = await chromium.launch({ channel: process.env.INSPECTION_BROWSER_CHANNEL || 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  page.setDefaultTimeout(60_000);
  const errors = [];
  const responses = [];
  const externalRequests = [];
  const expectedOrigin = new URL(origin).origin;
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.origin === expectedOrigin) return route.continue();
    externalRequests.push(url.href);
    return route.abort();
  });
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('response', (response) => {
    if (response.url().includes('assembly-animation.glb')) responses.push(response.status());
  });
  await page.goto(new URL('/host.html', origin).href);
  const detail = page.frameLocator('#detail');
  const waitForResult = async (loadId) => {
    await page.waitForFunction((id) => window.inspectionFixture.events.some((event) =>
      event.type === 'viewer.inspectionResult' && event.payload.loadId === id), loadId);
    return page.evaluate((id) => window.inspectionFixture.events.find((event) =>
      event.type === 'viewer.inspectionResult' && event.payload.loadId === id), loadId);
  };
  const loaded = await waitForResult('load-1');
  assert.equal(loaded.ok, true, loaded.error);
  const frame = page.frames().find((entry) => new URL(entry.url()).pathname === '/inspection.html');
  assert.ok(frame, '详情 iframe 不存在');
  const renderer = await frame.evaluate(() => {
    const canvas = document.querySelector('canvas');
    const gl = canvas?.getContext('webgl2') ?? canvas?.getContext('webgl');
    if (!gl) return '';
    const extension = gl.getExtension('WEBGL_debug_renderer_info');
    return String(gl.getParameter(extension?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER));
  });
  assert.ok(renderer && !/swiftshader|llvmpipe|lavapipe|softpipe|software|\bwarp\b/i.test(renderer),
    `测试需要硬件 WebGL，实际 renderer=${renderer}`);
  assert.deepEqual(await detail.locator('.inspection-detail__part small').allTextContents(),
    ['assembly.base', 'drive', 'drive.motor', 'drive.guard']);
  await detail.getByRole('button', { name: /电机/ }).click();
  await page.waitForFunction(() => window.inspectionFixture.events.some((event) =>
    event.type === 'event.inspectionPartSelected' && event.payload.partKey === 'drive.motor'));
  assert.equal(await detail.getByRole('button', { name: /电机/ }).getAttribute('aria-pressed'), 'true');

  const slider = detail.getByRole('slider', { name: '展开程度' });
  await slider.fill('65');
  assert.equal(await slider.inputValue(), '65');
  await detail.getByRole('button', { name: '隔离零件' }).click();
  assert.equal(await detail.getByRole('button', { name: '退出隔离' }).getAttribute('aria-pressed'), 'true');
  await detail.getByRole('button', { name: /防护罩/ }).click();
  assert.equal(await detail.getByRole('button', { name: /防护罩/ }).getAttribute('aria-pressed'), 'true');

  // 同源父窗口的错误会话也不能改变当前详情。
  await page.evaluate(() => window.inspectionFixture.send('command.inspectionSelectPart',
    { loadId: 'load-1', assetCode: 'CV-021', partKey: 'drive.motor' }, 'wrong-session', 'other-session'));
  await page.waitForTimeout(300);
  assert.equal(await detail.getByRole('button', { name: /防护罩/ }).getAttribute('aria-pressed'), 'true');
  await page.evaluate(() => window.inspectionFixture.send('command.inspectionReset', { loadId: 'load-1', assetCode: 'CV-021' }));
  await page.waitForFunction(() => window.inspectionFixture.events.some((event) =>
    event.type === 'event.inspectionPartSelected' && event.payload.partKey === null));
  assert.equal(await slider.inputValue(), '0');

  // 未登记资源必须失败；后续合法加载仍能恢复。
  await page.evaluate(() => window.inspectionFixture.load('load-invalid', 'editor-asset://local/not-in-manifest.glb'));
  const rejected = await waitForResult('load-invalid');
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /资源清单/);
  await page.evaluate(() => window.inspectionFixture.load('load-2'));
  const recovered = await waitForResult('load-2');
  assert.equal(recovered.ok, true, recovered.error);
  // 大屏直接加载中台版本，不需要场景高模绑定或业务设备编号。
  await page.evaluate(() => window.inspectionFixture.loadVersion('platform-v1'));
  const platformLoaded = await waitForResult('platform-v1');
  assert.equal(platformLoaded.ok, true, platformLoaded.error);
  const progressRequestId = await page.evaluate(() => window.inspectionFixture.send('command.inspectionSetProgress', { loadId: 'platform-v1', assetCode: 'CV-021', progress: 1 }));
  await page.waitForFunction((requestId) => window.inspectionFixture.events.some((event) =>
    event.type === 'viewer.inspectionResult' && event.payload.loadId === 'platform-v1' && event.requestId === requestId && event.ok), progressRequestId);
  assert.equal(await slider.inputValue(), '100');
  await detail.getByRole('button', { name: /电机/ }).click();
  assert.equal(await detail.getByRole('button', { name: /电机/ }).getAttribute('aria-pressed'), 'true');
  await page.evaluate(() => window.inspectionFixture.loadVersion('platform-external', `${location.origin}/api/v1/files/external.gltf`, '.gltf'));
  const externalRejected = await waitForResult('platform-external');
  assert.equal(externalRejected.ok, false);
  assert.match(externalRejected.error, /外部纹理或缓冲区/);
  await page.evaluate(() => window.inspectionFixture.loadVersion('platform-v1-retry'));
  assert.equal((await waitForResult('platform-v1-retry')).ok, true);
  await detail.getByRole('button', { name: '关闭设备详情' }).click();
  await page.waitForFunction(() => window.inspectionFixture.events.some((event) =>
    event.type === 'event.inspectionClosed' && event.payload.loadId === 'platform-v1-retry'));
  assert.ok(responses.length >= 2 && responses.every((status) => status === 200));
  assert.deepEqual(externalRequests, [], '隔离详情页不能依赖外网资源');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ status: 'PASS', modelRequests: responses.length, wrongSessionIgnored: true, invalidResourceRejected: true }));
} finally {
  await browser?.close();
  await server?.close();
}
