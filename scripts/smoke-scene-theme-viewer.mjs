import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const output = path.resolve('output/scene-theme');
const packages = JSON.parse(await readFile(path.join(output, 'packages-result.json'), 'utf8'));
const fixtures = packages.viewerFixtures ?? [{ id: 'tech-blue-night', viewerRoot: packages.viewerRoot,
  theme: { mainColor: '#b5d4ff', exposure: 1.27, contrast: 1.1, environmentIntensity: .3, backgroundColor: '#0a1731', fogEnabled: true, fogStart: 125, fogEnd: 820 } }];
for (const fixture of fixtures) {
  assert.equal(path.dirname(path.resolve(fixture.viewerRoot)), output, 'Viewer 必须来自本测试的双包产物目录');
}
let activeRoot = path.resolve(fixtures[0].viewerRoot);
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.wasm': 'application/wasm', '.png': 'image/png' };
const server = createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const file = path.resolve(activeRoot, '.' + (pathname === '/' ? '/index.html' : pathname));
    const relative = path.relative(activeRoot, file);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) { res.writeHead(403).end(); return; }
    res.setHeader('Content-Type', mime[path.extname(file)] ?? 'application/octet-stream');
    await pipeline(createReadStream(file), res);
  } catch (error) { if (!res.headersSent) res.writeHead(error.code === 'ENOENT' ? 404 : 500); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser, page;
const errors = [], results = [];
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  for (const fixture of fixtures) {
    // 每套使用独立页面和真实 ZIP，避免上一套的浏览器缓存或运行时状态影响结果。
    activeRoot = path.resolve(fixture.viewerRoot);
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.setDefaultTimeout(30000);
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.route('**/api/v1/digital-twin/runtime-config/detail', route => route.fulfill({
      contentType: 'application/json', body: JSON.stringify({ success: true, data: { projectId: '123', runtimeEnabled: true } }),
    }));
    const engineModule = (await readdir(path.join(activeRoot, 'assets'))).find(name => name.startsWith('engineStore-'));
    assert.ok(engineModule);
    async function observe() {
      await page.evaluate(async source => {
        const module = await import('/assets/' + source);
        window.themeViewerEngines = Object.values(module).find(value => Array.isArray(value?.Instances));
      }, engineModule);
      await page.waitForFunction(() => window.themeViewerEngines?.Instances.some(engine => engine.scenes.some(scene =>
        scene.lights.some(light => light.name === '__SceneThemeMain') && scene.transformNodes.some(node =>
          node.name.startsWith('EnvironmentRoot_') && node.getChildMeshes().some(mesh => mesh.getTotalVertices() > 0))
        && scene.isReady())), null, { timeout: 120000 });
      return page.evaluate(() => {
        const engine = window.themeViewerEngines.Instances.find(engine => engine.scenes.some(scene => scene.lights.some(light => light.name === '__SceneThemeMain')));
        const scene = engine.scenes.find(scene => scene.lights.some(light => light.name === '__SceneThemeMain'));
        const camera = scene.activeCamera; const target = camera.target.clone(); target.set(0, 3, 0);
        target.set(0, 2, 0); camera.setTarget(target); camera.alpha = -1.2; camera.beta = 1.15; camera.radius = 30;
        const main = scene.lights.filter(light => light.name === '__SceneThemeMain');
        const work = scene.lights.find(light => light.metadata?.nightBehavior === 'keep');
        return { renderer: engine.getGlInfo().renderer, mainLights: main.length, mainColor: main[0].diffuse.toHexString().toLowerCase(),
          backgroundColor: scene.clearColor.toHexString().slice(0, 7).toLowerCase(),
          exposure: scene.imageProcessingConfiguration.exposure, contrast: scene.imageProcessingConfiguration.contrast,
          environment: scene.environmentIntensity, fogMode: scene.fogMode, fogStart: scene.fogStart, fogEnd: scene.fogEnd,
          workColor: work?.diffuse.toHexString().toLowerCase(), workRange: work?.range,
          disabledGlobalLights: scene.lights.filter(light => !light.isEnabled()).length, frame: scene.getFrameId() };
      });
    }
    function assertTheme(state) {
      assert.equal(state.mainLights, 1); assert.equal(state.mainColor, fixture.theme.mainColor);
      assert.equal(state.backgroundColor, fixture.theme.backgroundColor);
      assert.equal(state.exposure, fixture.theme.exposure); assert.equal(state.contrast, fixture.theme.contrast);
      assert.equal(state.environment, fixture.theme.environmentIntensity);
      assert.equal(state.fogMode !== 0, fixture.theme.fogEnabled);
      if (fixture.theme.fogEnabled) { assert.equal(state.fogStart, fixture.theme.fogStart); assert.equal(state.fogEnd, fixture.theme.fogEnd); }
      assert.equal(state.workColor, '#ffd6a3'); assert.equal(state.workRange, 24); assert.equal(state.disabledGlobalLights, 2);
    }
    await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load' });
    const state = await observe(); assertTheme(state);
    await page.waitForFunction(frame => window.themeViewerEngines.Instances.some(engine => engine.scenes.some(scene =>
      scene.getFrameId() > frame + 15 && scene.isReady())), state.frame);
    const png = await page.locator('canvas').first().screenshot();
    const hiddenFrame = await page.evaluate(() => {
      const scene = window.themeViewerEngines.Instances.flatMap(engine => engine.scenes)
        .find(scene => scene.lights.some(light => light.name === '__SceneThemeMain'));
      scene.transformNodes.find(node => node.name.startsWith('EnvironmentRoot_')).setEnabled(false);
      return scene.getFrameId();
    });
    let background;
    try {
      await page.waitForFunction(frame => window.themeViewerEngines.Instances.some(engine => engine.scenes.some(scene => scene.getFrameId() > frame + 10)), hiddenFrame);
      background = await page.locator('canvas').first().screenshot();
    } finally {
      await page.evaluate(() => window.themeViewerEngines.Instances.flatMap(engine => engine.scenes)
        .find(scene => scene.lights.some(light => light.name === '__SceneThemeMain'))
        .transformNodes.find(node => node.name.startsWith('EnvironmentRoot_')).setEnabled(true));
    }
    const pixels = await page.evaluate(async images => {
      const decoded = await Promise.all(images.map(async data => {
        const img = new Image(); img.src = 'data:image/png;base64,' + data; await img.decode();
        const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
        const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0); return ctx.getImageData(0, 0, c.width, c.height).data;
      }));
      let bright = 0, clipped = 0, min = 255, max = 0, maskPixels = 0;
      for (let i = 0; i < decoded[0].length; i += 4) {
        const difference = Math.abs(decoded[0][i] - decoded[1][i]) + Math.abs(decoded[0][i + 1] - decoded[1][i + 1])
          + Math.abs(decoded[0][i + 2] - decoded[1][i + 2]);
        if (difference <= 18) continue;
        const luminance = (decoded[0][i] + decoded[0][i + 1] + decoded[0][i + 2]) / 3;
        if (luminance > 20) bright++; if (decoded[0][i] > 250 && decoded[0][i + 1] > 250 && decoded[0][i + 2] > 250) clipped++;
        min = Math.min(min, luminance); max = Math.max(max, luminance); maskPixels++;
      }
      return { bright, clippedFraction: maskPixels ? clipped / maskPixels : 1, range: max - min, maskPixels };
    }, [png.toString('base64'), background.toString('base64')]);
    assert.ok(pixels.maskPixels > 5000 && pixels.bright > pixels.maskPixels * .5 && pixels.range > 20 && pixels.clippedFraction < .1,
      fixture.id + ' 发布场景必须有模型细节且不过曝：' + JSON.stringify(pixels));
    const screenshot = path.join(output, 'viewer-' + fixture.id + '.png');
    await writeFile(screenshot, png);
    if (fixture.id === 'tech-blue-night') await writeFile(path.join(output, 'viewer.png'), png);
    await page.reload({ waitUntil: 'load' }); const reloaded = await observe(); assertTheme(reloaded);
    results.push({ id: fixture.id, state, reloaded, pixels, screenshot });
    await page.close(); page = null;
  }
  assert.deepEqual(errors, []);
  await writeFile(path.join(output, 'viewer-result.json'), JSON.stringify({ ok: true, results, errors, platformConfig: 'local-fixture' }, null, 2));
  console.log('PASS: 五套实际 DIST Viewer 的主题、固定相机可见模型像素及刷新一致性。');
} catch (error) { if (page) await page.screenshot({ path: path.join(output, 'viewer-failure.png') }).catch(() => undefined); throw error; }
finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
