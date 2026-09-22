import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';
const output = path.resolve('output/flow-arrow-direction'); await mkdir(output, { recursive: true });
const server = await createServer({ server: { host: '127.0.0.1', port: 53129, strictPort: true, hmr: { port: 53129 } } });
let browser; const errors = [], results = [];
const point = (x, y, z) => ({ x, y, z });
const cases = [
  { name: 'positive-x', points: [point(-5, 0, 0), point(5, 0, 0)] },
  { name: 'negative-x', points: [point(5, 0, 0), point(-5, 0, 0)] },
  { name: 'positive-z', points: [point(0, 0, -5), point(0, 0, 5)] },
  { name: 'negative-z', points: [point(0, 0, 5), point(0, 0, -5)] },
  { name: 'corner', points: [point(-4, 0, -4), point(4, 0, -4), point(4, 0, 4)], advance: 2.5 },
  { name: 'slope', points: [point(-4, 0, -2), point(4, 3, 2)] },
  { name: 'vertical', points: [point(0, 0, 0), point(0, 6, 0)] },
  { name: 'transformed', points: [point(-4, 0, -2), point(4, 3, 2)], transformed: true },
];
try {
  await server.listen(); await server.watcher.close();
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--disable-features=LocalNetworkAccessChecks,LocalNetworkAccessChecksWebSockets'] });
  const page = await browser.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const html = await server.transformIndexHtml('/__flow_arrows__', '<!doctype html><html><body><script type="module" src="/tests/fixtures/flowArrowDirection.harness.ts"></script></body></html>');
  await page.route('**/__flow_arrows__', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto(server.resolvedUrls.local[0] + '__flow_arrows__', { waitUntil: 'commit' });
  await page.waitForFunction(() => window.flowArrowDirection, null, { timeout: 180000 });
  for (const scenario of cases) {
    const result = await page.evaluate(({ points, advance, transformed }) => window.flowArrowDirection.run(points, advance, transformed), scenario);
    await writeFile(path.join(output, scenario.name + '-before.png'), Buffer.from(result.beforeImage.split(',')[1], 'base64'));
    await writeFile(path.join(output, scenario.name + '-after.png'), Buffer.from(result.afterImage.split(',')[1], 'base64'));
    delete result.beforeImage; delete result.afterImage;
    results.push({ name: scenario.name, ...result });
    assert.ok(result.alignment > .9999, JSON.stringify(result));
    assert.ok(result.screenAlignment > .9999, '屏幕中尖端朝向与实际位移一致：' + JSON.stringify(result));
  }
  assert.deepEqual(errors, []); await page.evaluate(() => window.flowArrowDirection.dispose());
  await writeFile(path.join(output, 'result.json'), JSON.stringify({ ok: true, results, errors }, null, 2));
  console.log('PASS: 8 个 Chrome WebGL 场景，箭头尖端与实际移动方向一致');
} finally { await browser?.close(); await server.close(); }
