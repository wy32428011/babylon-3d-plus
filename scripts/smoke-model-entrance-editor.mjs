import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { build } from 'vite';
import { chromium } from 'playwright';

const output = path.resolve('output/playwright/entrance-loading-20261009');
await mkdir(output, { recursive: true });
const fixtureRoot = path.join(output, 'editor-fixture');
await build({ logLevel: 'error', build: { outDir: fixtureRoot, emptyOutDir: true,
  rollupOptions: { input: 'tests/fixtures/modelEntranceEditor.harness.tsx', output: { entryFileNames: 'editor.js' } } } });
const styles = (await readdir(path.join(fixtureRoot, 'assets'))).filter(name => name.endsWith('.css'));
const html = `<!doctype html><html><head>${styles.map(name => `<link rel="stylesheet" href="/assets/${name}">`).join('')}</head><body><div id="root"></div><script type="module" src="/editor.js"></script></body></html>`;
const server = createServer((request, response) => { void (async () => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (pathname === '/') { response.setHeader('content-type', 'text/html'); response.end(html); return; }
    if (pathname === '/favicon.ico') { response.writeHead(204).end(); return; }
    const file = path.resolve(fixtureRoot, '.' + pathname), relative = path.relative(fixtureRoot, file);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    response.setHeader('content-type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream');
    response.end(await readFile(file));
  } catch (error) { response.writeHead(404).end(); }
})(); });
const errors = []; let browser;
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'commit' });
  await page.getByRole('button', { name: '进入运行', exact: true }).waitFor({ timeout: 180000 });
  await page.waitForTimeout(2500);
  await page.getByRole('button', { name: '进入运行', exact: true }).click();
  await page.waitForFunction(() => JSON.parse(document.querySelector('#runtime-entrance-status')?.textContent || '{}').snapshot?.status === 'completed', null, { timeout: 120000 });
  const first = JSON.parse(await page.locator('#runtime-entrance-status').innerText());
  assert.equal(first.starts, 1); assert.equal(first.snapshot.targetCount, 3);
  await page.screenshot({ path: path.join(output, 'editor-entrance-completed.png') });
  await page.getByRole('button', { name: '退出运行', exact: true }).click();
  await page.getByRole('button', { name: '进入运行', exact: true }).click();
  await page.waitForFunction(() => { const s = JSON.parse(document.querySelector('#runtime-entrance-status')?.textContent || '{}'); return s.starts === 2 && s.snapshot?.status === 'completed'; }, null, { timeout: 120000 });
  assert.deepEqual(errors, []);
  await writeFile(path.join(output, 'editor-webgl.json'), JSON.stringify({ first, errors, starts: 2,
    boundary: '真实SceneViewPanel按钮进入/退出预览及再次完整播放；内置几何fixture，无真实MQTT或业务模型。' }, null, 2));
  console.log('PASS Editor: 真实按钮进入、退出、再次入场完成，无浏览器错误');
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
