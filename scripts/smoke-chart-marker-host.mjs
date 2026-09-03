import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

// 先运行 smoke-chart-marker.mjs 生成真实保存场景；参数为已构建的数据中台 frontend 目录。
const frontendRoot = process.argv[2];
assert.ok(frontendRoot, '请传入数据中台 frontend 目录');
const output = path.resolve('output/playwright/chart-marker');
await mkdir(output, { recursive: true });
const fixture = JSON.parse(await readFile(path.join(output, 'fixture.json'), 'utf8'));
const savedScene = JSON.parse(await readFile(path.join(output, 'scene.json'), 'utf8'));
const viewerRoot = path.resolve('dist-viewer-template');
const hostRoot = path.resolve(frontendRoot, 'dist');
const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const server = createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const isViewer = pathname.startsWith('/__viewer__/');
    const root = isViewer ? viewerRoot : hostRoot;
    const relative = isViewer ? pathname.slice('/__viewer__/'.length) : pathname.slice(1);
    const file = path.resolve(root, relative || 'index.html');
    if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': mime[path.extname(file)] ?? 'application/octet-stream' }).end(data);
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
let page;
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  for (const mode of ['preview', 'published']) {
    for (const referenced of [true, false]) {
      page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      page.setDefaultTimeout(45_000);
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.addInitScript(() => {
        window.bridgeMessages = [];
        window.addEventListener('message', event => window.bridgeMessages.push(event.data));
      });
      const textWidget = (id, text, pageKey) => ({ id, type: 'TEXT', name: text, x: 1040, y: 180, w: 360, h: 200, zIndex: 10, visible: true, pageKey, style: { color: '#7de3ff', fontSize: 30, showTitle: false }, data: { text } });
      const themeText = `工站信息：${mode} 外层展示验证`;
      const canvas = { width: 1440, height: 900, backgroundColor: '#061928' };
      const themeContent = { version: 1, projectId: '1', canvas, widgets: [textWidget('theme-text', themeText)] };
      const hostContent = { version: 1, projectId: '1', canvas,
        pages: [{ key: 'home', name: '概览' }, ...(referenced ? [{ key: 'theme', name: '工站信息', sourceScreenId: '3' }] : [])], activePageKey: 'home',
        widgets: [
          { id: 'runtime', type: 'BABYLON_RUNTIME', name: '数字孪生', x: 0, y: 0, w: 1000, h: 900, zIndex: 1, visible: true, style: { showTitle: false }, data: { sourceType: 'externalRuntime', digitalTwinBinding: { mode: 'manualUrl', runtimeUrl: `${origin}/__viewer__/index.html` } } },
          textWidget('home-text', '点击三维立标切换工站信息', 'home'),
        ],
      };
      const detail = id => ({ id, projectId: '1', screenName: id === '1' ? '宿主大屏' : '工站信息', jsonContent: JSON.stringify(id === '1' ? hostContent : themeContent) });
      await page.route('**/api/**', route => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.pathname === '/api/v1/screens/detail') return route.fulfill({ json: { code: 200, data: detail(String(request.postDataJSON().id)) } });
        const published = url.pathname.match(/^\/api\/v1\/screens\/(\d+)\/published$/);
        if (published) return route.fulfill({ json: { code: 200, data: { id: '10', screenId: published[1], versionNumber: 1, publishNumber: 1, versionStatus: 'PUBLISHED', snapshotJson: JSON.stringify({ jsonContent: detail(published[1]).jsonContent, referencedScreenJsonContents: { '3': JSON.stringify(themeContent) } }) } } });
        return route.fulfill({ json: { code: 200, data: [] } });
      });
      const scene = structuredClone(savedScene);
      for (const entity of Object.values(scene.scene.entities)) {
        if (entity.components.dataPlatformScreen) entity.components.dataPlatformScreen.screenUrl = `${origin}/__chart_marker_fixture__`;
      }
      await page.route('**/__chart_marker_fixture__', route => route.fulfill({ contentType: 'text/html', body: '<html><body style="background:#061928;color:#7de3ff">立标原内容保持不变</body></html>' }));
      await page.route('**/__viewer__/runtime-config.json', route => route.fulfill({ json: {
        version: 1, page: { title: '数字孪生主题联动', loadingText: '加载中', backgroundColor: '#101827' },
        paths: { scene: './scene.json', assetManifest: './asset-manifest.json', assetBase: './' },
        viewer: { showGrid: true, allowCameraControl: true, showStatusOverlay: false },
        mqtt: { ...scene.scene.mqttConfig, enabled: false, address: '', subscriptions: [] },
      } }));
      await page.route('**/__viewer__/scene.json', route => route.fulfill({ json: scene }));
      await page.route('**/__viewer__/asset-manifest.json', route => route.fulfill({ json: { version: 1, assets: [] } }));
      let internalThemeLoads = 0;
      await page.route('https://theme.example.test/**', route => { internalThemeLoads += 1; return route.fulfill({ body: '错误：主题不能加载在 Viewer 内' }); });
      if (mode === 'preview' && referenced) {
        await page.goto(origin + '/__viewer__/index.html');
        const standaloneBody = page.locator('[data-screen-entity-id="' + fixture.builtinId + '"] [data-chart-marker-text]');
        await standaloneBody.waitFor();
        const standaloneBox = await standaloneBody.boundingBox();
        assert.ok(standaloneBox && standaloneBox.width > 0);
        await page.mouse.click(standaloneBox.x + standaloneBox.width / 2, standaloneBox.y + standaloneBox.height / 2);
        await page.getByRole('alert').filter({ hasText: '主题展示未发送' }).waitFor();
        await page.getByRole('button', { name: '关闭提示', exact: true }).click();
        await page.getByRole('alert').filter({ hasText: '主题展示未发送' }).waitFor({ state: 'detached' });
        console.log(JSON.stringify({ ok: true, scenario: 'standalone-error-dismiss' }));
      }
      await page.goto(`${origin}/#/bigscreen-designer/${mode}/1`);
      const iframe = page.locator('iframe[src*="/__viewer__/index.html"]');
      await iframe.waitFor();
      const viewer = await (await iframe.elementHandle()).contentFrame();
      await viewer.locator('canvas').waitFor();
      await page.waitForFunction(() => window.bridgeMessages.some(message => message.type === 'viewer.ready'));
      await viewer.evaluate(() => { window.viewerInstance = crypto.randomUUID(); });
      const instance = await viewer.evaluate(() => window.viewerInstance);
      const body = viewer.locator(`[data-screen-entity-id="${fixture.builtinId}"] [data-chart-marker-text]`);
      await body.waitFor();
      const box = await body.boundingBox();
      assert.ok(box && box.width > 0);
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await page.getByText(themeText, { exact: true }).waitFor();
      assert.equal(await page.getByText('点击三维立标切换工站信息', { exact: true }).count(), 0);
      const showMessage = await page.evaluate(() => window.bridgeMessages.find(message => message.type === 'viewer.showScreen'));
      assert.deepEqual(showMessage.payload, { projectId: '1', screenId: '3' });
      assert.equal(internalThemeLoads, 0);
      if (referenced) {
        assert.equal(page.url(), `${origin}/#/bigscreen-designer/${mode}/1`);
        assert.equal(await viewer.evaluate(() => window.viewerInstance), instance, '引用内容页切换必须保留公共三维实例');
        assert.equal(await viewer.locator('[data-data-platform-viewport-screen]').count(), 0);
        assert.equal(await viewer.locator(`[data-screen-entity-id="${fixture.builtinId}"] [data-chart-marker-text]`).textContent(), '内置面板导出验证');
      } else {
        assert.equal(page.url(), `${origin}/#/bigscreen-designer/${mode}/3`);
        await iframe.waitFor({ state: 'detached' });
      }
      assert.deepEqual(errors, []);
      const scenario = `${mode}-${referenced ? 'reference' : 'route'}`;
      await page.screenshot({ path: path.join(output, `host-${scenario}.png`) });
      console.log(JSON.stringify({ ok: true, scenario, destination: 'CentralDataPlatform', internalThemeLoads }));
      await page.close();
    }
  }
} catch (error) {
  if (page && !page.isClosed()) {
    await page.screenshot({ path: path.join(output, 'host-failure.png') });
    console.error(await page.locator('body').innerText());
    console.error(await page.evaluate(() => window.bridgeMessages));
  }
  throw error;
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
