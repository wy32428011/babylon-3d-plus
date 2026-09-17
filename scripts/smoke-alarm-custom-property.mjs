import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const outputDir = path.resolve('output/playwright/alarm-custom-property');
await mkdir(outputDir, { recursive: true });
const server = await createServer({ server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false } });
let browser;
const errors = [];
try {
  await server.listen();
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 520, height: 900 } });
  page.setDefaultTimeout(60_000);
  page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
  const html = await server.transformIndexHtml('/__alarm_inspector__', `<!doctype html><html><head><meta charset="utf-8"><title>报警点位配置验证</title>
    <style>html,body{margin:0;height:100%;overflow:auto}#root{width:420px;max-width:100%;padding:12px;box-sizing:border-box;margin:auto}</style>
    </head><body><main id="root" class="inspector-panel"></main><script type="module" src="/tests/fixtures/alarmInspector.harness.ts"></script></body></html>`);
  await page.route('**/__alarm_inspector__', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto(server.resolvedUrls.local[0] + '__alarm_inspector__', { waitUntil: 'commit' });
  // Vite 冷启动可能仍在预构建依赖，以真实表单就绪为准。
  await page.getByLabel('火警属性', { exact: true }).waitFor({ timeout: 180_000 });
  await page.getByLabel('火警属性', { exact: true }).fill('fire.signal');
  await page.getByLabel('触发值', { exact: true }).fill('1');
  const before = await page.evaluate(() => window.alarmInspectorHarness.inspect());
  assert.equal(before.config.customProperty, 'fire.signal');
  assert.equal(before.config.customValue, '1');
  await page.evaluate(() => window.alarmInspectorHarness.undo());
  assert.equal(await page.getByLabel('触发值', { exact: true }).inputValue(), 'true');
  await page.evaluate(() => { window.alarmInspectorHarness.redo(); window.alarmInspectorHarness.reload(); });
  assert.equal(await page.getByLabel('火警属性', { exact: true }).inputValue(), 'fire.signal');
  assert.equal(await page.getByLabel('触发值', { exact: true }).inputValue(), '1');
  await page.screenshot({ path: path.join(outputDir, 'configuration.png') });
  await page.evaluate(() => window.alarmInspectorHarness.run());
  assert.equal(await page.getByLabel('触发值', { exact: true }).isDisabled(), true);
  const first = page.getByRole('region', { name: '设备诊断：设备 1', exact: true });
  await first.locator('[data-alarm-property-status="waiting"]').waitFor();
  await page.evaluate(() => window.alarmInspectorHarness.mqtt([{ p: 'temperature', v: 25 }, { e: 'CV-1', p: 'fire.signal', v: 1 }]));
  await first.locator('[data-alarm-property-status="matched"]').waitFor();
  assert.match(await first.innerText(), /当前 v：1/);
  await first.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(outputDir, 'matched.png') });
  const after = await page.evaluate(() => window.alarmInspectorHarness.inspect());
  assert.deepEqual(after.config, before.config, '实时值不得写回场景配置');
  assert.equal(after.undoCount, before.undoCount, '实时诊断不得写入撤销历史');
  await first.locator('[data-alarm-property-status="stale"]').waitFor();
  await page.evaluate(() => window.alarmInspectorHarness.mqtt([{ p: 'temperature', v: 26 }]));
  await first.locator('[data-alarm-property-status="missing"]').waitFor();
  await page.evaluate(() => window.alarmInspectorHarness.mqtt([{ p: 'fire.signal', v: 0 }]));
  await first.locator('[data-alarm-property-status="unmatched"]').waitFor();
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await page.getByRole('region', { name: '设备诊断：设备 11', exact: true }).waitFor();
  assert.equal(await page.locator('.alarm-property-device').count(), 2);
  await page.getByRole('button', { name: '上一页', exact: true }).click();
  assert.equal(await page.locator('.alarm-property-device').count(), 10);
  await page.evaluate(() => window.alarmInspectorHarness.stop());
  await first.locator('[data-alarm-property-status="waiting"]').waitFor();
  assert.match(await first.innerText(), /当前 v：—/);
  await page.locator('.alarm-property-diagnostics summary').click();
  assert.equal(await page.locator('.alarm-property-device').count(), 0);
  assert.deepEqual(errors, []);
  await page.evaluate(() => window.alarmInspectorHarness.dispose());
  console.log('PASS: CUSTOM PROPERTY 配置、撤销重做、保存重开、逐设备 p/v 只读诊断、超时、缺失、恢复、分页及停止清理。');
} finally {
  await browser?.close();
  await server.close();
}
