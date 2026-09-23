import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const output = path.resolve('output/playwright/effect-model-v2'); await mkdir(output, { recursive: true });
const server = await createServer({ server: { host: '127.0.0.1', port: 53139, strictPort: true, hmr: { port: 53139 } } });
let browser; const errors = [], results = [];
try {
  await server.listen(); await server.watcher.close();
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--disable-features=LocalNetworkAccessChecks,LocalNetworkAccessChecksWebSockets'] });
  const page = await browser.newPage();
  page.on('pageerror', error => errors.push(error.message)); page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const html = await server.transformIndexHtml('/__model_effect_v2__', '<!doctype html><html><body><script type="module" src="/tests/fixtures/modelEnvironmentConfiguration.harness.ts"></script></body></html>');
  await page.route('**/__model_effect_v2__', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto(server.resolvedUrls.local[0] + '__model_effect_v2__', { waitUntil: 'commit' });
  await page.waitForFunction(() => window.modelEffectV2, null, { timeout: 180000 });
  for (const material of ['standard', 'pbr']) {
    const result = await page.evaluate(material => window.modelEffectV2.run(material), material);
    await writeFile(path.join(output, `${material}-gradient.png`), Buffer.from(result.gradientImage.split(',')[1], 'base64')); delete result.gradientImage;
    results.push(result);
  }
  await page.evaluate(() => window.modelEffectV2.dispose());
  await writeFile(path.join(output, 'result.json'), JSON.stringify({ results, errors }, null, 2));
  assert.deepEqual(errors, []);
  for (const r of results) {
    for (const key of ['gradient', 'dissolve', 'above', 'slice', 'hologram', 'scan']) assert.ok(r[key].changed > 100, `${r.materialKind}/${key} 必须改变可见像素`);
    for (const key of ['dissolve', 'above', 'slice']) assert.ok(r[key].missing > 100, `${r.materialKind}/${key} 必须正确裁剪`);
    for (const key of ['complete', 'delayedScan', 'restored']) assert.equal(r[key].changed, 0, `${r.materialKind}/${key} 必须保持或恢复原貌`);
    assert.equal(r.reused, true, '外部进度更新不能替换材质');
  }
  console.log(JSON.stringify({ passed: true, cases: results.length * 9, results }));
} finally { await browser?.close(); await server.close(); }
