import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const output = path.resolve('output/model-entrance');
await mkdir(output, { recursive: true });
const server = await createServer({ cacheDir: 'node_modules/.vite-model-entrance', server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false } });
let browser;
const errors = [], results = [];
try {
  await server.listen(); await server.watcher.close();
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const html = await server.transformIndexHtml('/__model_entrance__', '<!doctype html><html><body><script type="module" src="/tests/fixtures/modelEntrance.harness.ts"></script></body></html>');
  await page.route('**/__model_entrance__', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto(server.resolvedUrls.local[0] + '__model_entrance__', { waitUntil: 'commit' });
  await page.waitForFunction(() => window.modelEntranceHarness, null, { timeout: 180000 });
  const effects = await page.evaluate(() => window.modelEntranceHarness.effects);
  for (const effect of effects) for (const materialKind of ['standard', 'pbr']) {
    const result = await page.evaluate(({ effect, materialKind }) => window.modelEntranceHarness.run(effect, materialKind), { effect, materialKind });
    for (const phase of ['midpoint', 'completed']) {
      const key = phase + 'Image'; await writeFile(path.join(output, `${effect}-${materialKind}-${phase}.png`), Buffer.from(result[key].split(',')[1], 'base64')); delete result[key];
    }
    results.push(result);
    assert.ok(result.midpoint > 100, `${effect}/${materialKind} 中间帧必须产生真实像素变化`);
    assert.equal(result.completed, 0, `${effect}/${materialKind} 终态恢复原始纹理画面`);
    assert.equal(result.cancelled, 0, `${effect}/${materialKind} 取消恢复原始纹理画面`);
    assert.deepEqual(result.paused, result.beforePause, '隐藏时不推进动画');
    assert.equal(result.completion.status, 'completed'); assert.equal(result.materialsRestored, true);
  }
  assert.deepEqual(errors, []);
  await page.evaluate(() => window.modelEntranceHarness.dispose());
  console.log('PASS: 八效果 × Standard/PBR 贴图中间帧、完成/取消像素恢复、隐藏暂停');
} finally {
  await writeFile(path.join(output, 'webgl-result.json'), JSON.stringify({ results, errors }, null, 2));
  await browser?.close(); await server.close();
}
