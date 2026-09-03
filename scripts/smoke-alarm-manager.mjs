import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const outputDir = path.resolve('output/playwright/alarm-manager');
await mkdir(outputDir, { recursive: true });
const server = await createServer({
  server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false },
});
let browser;
const errors = [];
try {
  await server.listen();
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  page.setDefaultTimeout(60_000);
  page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
  const html = await server.transformIndexHtml('/__alarm_test__', `<!doctype html><html><head><meta charset="utf-8"><title>报警管理器运行验证</title>
    <style>html,body,#stage{width:100%;height:100%;margin:0;overflow:hidden;background:#152131}#stage{position:relative}canvas{width:100%;height:100%;display:block}#overlay{position:absolute;inset:0;pointer-events:none}</style>
    </head><body><div id="stage"><canvas id="canvas"></canvas><div id="overlay"></div></div><script type="module" src="/tests/fixtures/alarmManager.harness.ts"></script></body></html>`);
  await page.route('**/__alarm_test__', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto(server.resolvedUrls.local[0] + '__alarm_test__', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(window.alarmHarness));
  await page.evaluate(() => window.alarmHarness.signal(true));
  await page.waitForFunction(() => window.alarmHarness.inspect().activeParticles > 0 && window.alarmHarness.inspect().overridden);
  await page.locator('[data-chart-marker-builtin]').waitFor({ state: 'visible' });

  // DOM 存在不足以证明立标可见；检查最终合成画面，覆盖动态 Mesh 未进入渲染队列的回归。
  const pixels = async () => {
    const png = await page.screenshot();
    return page.evaluate(async data => {
      const img = new Image(); img.src = 'data:image/png;base64,' + data; await img.decode();
      const canvas = document.createElement('canvas'); canvas.width = img.width; canvas.height = img.height;
      const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0);
      return [[400, 400], [750, 400], [350, 120]].map(([x, y]) => [...ctx.getImageData(x, y, 1, 1).data]);
    }, png.toString('base64'));
  };
  let colors;
  const deadline = Date.now() + 10_000;
  do {
    colors = await pixels();
    if (colors[2][0] < 30 && colors[2][2] > 20) break;
    await page.waitForTimeout(100);
  } while (Date.now() < deadline);
  assert.ok(colors[0][0] > 200 && colors[0][1] < 80, '报警设备应显示覆盖色');
  assert.ok(colors[1][0] < 50 && colors[1][1] > 100, '正常共享模型不应被染色');
  assert.ok(colors[2][0] < 30 && colors[2][2] > 20, '立标应实际出现在最终合成画面');
  await page.screenshot({ path: path.join(outputDir, 'active.png') });
  let state = await page.evaluate(() => window.alarmHarness.inspect());
  assert.equal(state.normalUnchanged, true); assert.equal(state.overlays, 1); assert.equal(state.events, 1);
  await page.evaluate(() => window.alarmHarness.signal(false));
  await page.waitForFunction(() => !window.alarmHarness.inspect().overridden && window.alarmHarness.inspect().particles === 0);
  assert.equal((await page.evaluate(() => window.alarmHarness.inspect())).overlays, 0);
  await page.screenshot({ path: path.join(outputDir, 'cleared.png') });
  await page.evaluate(() => window.alarmHarness.appearance());
  await page.waitForFunction(() => window.alarmHarness.inspect().appearance);
  state = await page.evaluate(() => window.alarmHarness.inspect());
  assert.deepEqual(state.errors, []); assert.deepEqual(errors, []);
  await page.evaluate(() => window.alarmHarness.dispose());
  console.log('PASS: 报警 WebGL 着色隔离、火焰、立标可见像素、解除恢复、真实 GLB 外观加载与资源释放。');
} finally {
  await browser?.close();
  await server.close();
}
