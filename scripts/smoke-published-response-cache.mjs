import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import ts from 'typescript';
import { chromium } from 'playwright';

const output = path.resolve('output/playwright/published-response-cache');
await mkdir(output, { recursive: true });
const helper = ts.transpileModule(await readFile('src/player/publishedResponseCache.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const source = await readFile('public/published-cache-worker.js', 'utf8');
// 仅测试服务器注入浏览器 Cache API 故障，生产 worker 不包含故障开关。
const worker = source + `\nlet fixtureQuota = false;
const fixturePut = Cache.prototype.put;
Cache.prototype.put = function(request,response) {
  if (fixtureQuota && String(request.url || request).endsWith('/quota.js')) return Promise.reject(new DOMException('Fixture quota exceeded','QuotaExceededError'));
  return fixturePut.call(this,request,response);
};
self.addEventListener('message',event=> { if(event.data.fixtureQuota !== undefined) { fixtureQuota = event.data.fixtureQuota; event.ports[0].postMessage(true); } });`;
const packages = new Map();
for (const version of ['101', '102']) {
  const base = '/digital-twin/releases/7/' + version + '/';
  const html = `<!doctype html><html><body><p id="status">缓存回归 ${version}</p><script type="module">
import { installPublishedResponseCache } from './helper.js';
window.result=null;
try {
 const base=new URL('./',location.href).href;
 const config=await (await fetch('./runtime-config.json',{cache:'no-store'})).json();
 const manifest=await (await fetch('./release-cache-manifest.json',{cache:'no-store'})).json();
 const session=await installPublishedResponseCache(base,manifest);
 window.session=session; window.manifest=manifest;
 const responses=manifest.files.filter(file=>file.storage==='response');
 let cursor=0; const results=[];
 await Promise.all(Array.from({length:3},async()=>{while(cursor<responses.length){const file=responses[cursor++];results.push(await session.ensure(file));}}));
 const content=await (await fetch('./app.js')).text();
 window.result={available:session.available,reason:session.reason,ready:results.every(Boolean),content,revision:config.cacheRevision};
 document.querySelector('#status').textContent=JSON.stringify(window.result);
}catch(error){window.result={error:String(error)};}
</script></body></html>`;
  const files = new Map([
    ['index.html', Buffer.from(html)], ['helper.js', Buffer.from(helper)],
    ['app.js', Buffer.from('/* visible release ' + version + ' */')], ['quota.js', Buffer.from('/* quota fallback */')],
    ['slow.bin', Buffer.alloc(128 * 1024, 71)],
    ['oversized.bin', Buffer.from('expected response')],
    ['assets/%E6%A8%A1%E5%9E%8B%20%231%25.bin', Buffer.from('encoded path resource')],
    ['project/assets/raw.bin', Buffer.from('IDB owned, no SW write')],
  ]);
  const manifest = { version: 1, cacheRevision: 'revision-' + version, totalBytes: 0, files: [...files].map(([name, body]) => ({ path: name, size: body.length, sha256: createHash('sha256').update(body).digest('hex'), contentType: name.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8', storage: name.startsWith('project/') ? 'asset' : 'response' })) };
  manifest.totalBytes = manifest.files.reduce((sum, file) => sum + file.size, 0);
  packages.set(base, { files, manifest });
}
const counts = new Map();
let slowDelay = false;
let slowCancelled = 0;
let oversizedMode = false;
let oversizedChunks = 0;
let oversizedCancelled = 0;
const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://fixture');
  counts.set(url.pathname, (counts.get(url.pathname) ?? 0) + 1);
  response.setHeader('Cache-Control', 'no-store');
  const entry = [...packages].find(([base]) => url.pathname.startsWith(base));
  if (!entry) { response.writeHead(404).end(); return; }
  const [base, pkg] = entry;
  const file = url.pathname.slice(base.length) || 'index.html';
  if (file === 'published-cache-worker.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(worker); }
  else if (file === 'runtime-config.json') { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ cacheRevision: pkg.manifest.cacheRevision })); }
  else if (file === 'release-cache-manifest.json') { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(pkg.manifest)); }
  else if (pkg.files.has(file)) {
    response.setHeader('Content-Type', pkg.manifest.files.find(item => item.path === file).contentType);
    if (file === 'oversized.bin' && oversizedMode) {
      let sent = 0;
      const write = () => { oversizedChunks++; response.write(Buffer.alloc(1024, 65)); if (++sent === 100) response.end(); };
      write(); const timer = setInterval(write, 10);
      response.on('close', () => { clearInterval(timer); if (!response.writableFinished) oversizedCancelled++; });
    } else if (file === 'slow.bin' && slowDelay) {
      response.write(pkg.files.get(file).subarray(0, 32));
      const timer = setTimeout(() => response.end(pkg.files.get(file).subarray(32)), 400);
      response.on('close', () => { clearTimeout(timer); if (!response.writableFinished) slowCancelled++; });
    } else if (file.endsWith('.js')) {
      const compressed = gzipSync(pkg.files.get(file));
      response.setHeader('Content-Encoding', 'gzip'); response.setHeader('Content-Length', compressed.length); response.end(compressed);
    } else response.end(pkg.files.get(file));
  }
  else { response.setHeader('Content-Type', 'text/plain'); response.end('uncached dynamic path'); }
});
let browser;
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const samples = [];
  for (const [name, version] of [['cold', '101'], ['warm', '101'], ['new-release', '102'], ['old-release', '101']]) {
    const base = '/digital-twin/releases/7/' + version + '/';
    const before = Object.fromEntries(counts);
    await page.goto(origin + base);
    await page.waitForFunction(() => window.result, { timeout: 30000 });
    const result = await page.evaluate(() => window.result);
    assert.equal(result.error, undefined, result.error);
    assert.equal(result.available, true, result.reason); assert.equal(result.ready, true, JSON.stringify(result));
    assert.equal(result.revision, 'revision-' + version);
    if (name === 'warm' || name === 'old-release') {
      for (const file of packages.get(base).manifest.files.filter(file => file.storage === 'response')) {
        assert.equal(counts.get(base + file.path) ?? 0, before[base + file.path] ?? 0, name + ': no repeated static bytes: ' + file.path);
      }
      assert.equal(counts.get(base) ?? 0, before[base] ?? 0, 'root index alias must be cached');
    }
    samples.push({ name, ...result });
  }
  const base = '/digital-twin/releases/7/101/';
  const beforeRestart = Object.fromEntries(counts);
  const cdp = await context.newCDPSession(page);
  await cdp.send('ServiceWorker.enable'); await cdp.send('ServiceWorker.stopAllWorkers');
  assert.equal(await page.evaluate(() => window.session.has(window.manifest.files.find(file => file.path === 'app.js'))), true, 'live helper reconnects after the idle worker restarts');
  await cdp.send('ServiceWorker.stopAllWorkers');
  await page.reload(); await page.waitForFunction(() => window.result);
  assert.equal((await page.evaluate(() => window.result)).ready, true);
  assert.equal(counts.get(base), beforeRestart[base], 'worker restart restores root HTML from its persisted manifest metadata');
  assert.equal(counts.get(base + 'app.js'), beforeRestart[base + 'app.js']);
  const bypass = await page.evaluate(async () => {
    const raw = new URL('./project/assets/raw.bin', location.href).href;
    const unknown = new URL('./not-listed.js', location.href).href;
    await fetch(raw); await fetch(raw); await fetch(unknown); await fetch(unknown);
    return { rawCached: Boolean(await caches.match(raw)), unknownCached: Boolean(await caches.match(unknown)) };
  });
  assert.deepEqual(bypass, { rawCached: false, unknownCached: false });
  assert.equal(counts.get(base + 'project/assets/raw.bin'), 2); assert.equal(counts.get(base + 'not-listed.js'), 2);
  const repair = await page.evaluate(async () => {
    const name = (await caches.keys()).find(name => name.includes(encodeURIComponent(new URL('./', location.href).href)));
    const cache = await caches.open(name);
    const file = window.manifest.files.find(file => file.path === 'app.js');
    await cache.put(new URL('./app.js', location.href), new Response('corruption'));
    const hit = await window.session.has(file);
    const fixed = await window.session.ensure(file);
    return { hit, fixed, content: await (await fetch('./app.js')).text() };
  });
  assert.deepEqual(repair, { hit: false, fixed: true, content: '/* visible release 101 */' });
  const quota = await page.evaluate(async () => {
    const toggle = value => new Promise(resolve => { const channel = new MessageChannel(); channel.port1.onmessage = () => { channel.port1.close(); resolve(); }; navigator.serviceWorker.controller.postMessage({ fixtureQuota: value }, [channel.port2]); });
    const name = (await caches.keys()).find(name => name.includes(encodeURIComponent(new URL('./', location.href).href)));
    await (await caches.open(name)).delete(new URL('./quota.js', location.href));
    await toggle(true);
    const file = window.manifest.files.find(file => file.path === 'quota.js');
    const content = await (await fetch('./quota.js')).text();
    const ensured = await window.session.ensure(file);
    const hit = await window.session.has(file);
    await toggle(false);
    const repaired = await window.session.ensure(file);
    return { content, ensured, hit, repaired };
  });
  assert.deepEqual(quota, { content: '/* quota fallback */', ensured: false, hit: false, repaired: true });
  const range = await page.evaluate(async () => { const response = await fetch('./app.js', { headers: { Range: 'bytes=3-9' } }); return { status: response.status, text: await response.text() }; });
  assert.deepEqual(range, { status: 206, text: 'visible' });
  slowDelay = true;
  const slowBefore = counts.get(base + 'slow.bin');
  const cancellation = await page.evaluate(async () => {
    const { installPublishedResponseCache } = await import('./helper.js');
    const root = new URL('./', location.href).href;
    const controller = new AbortController();
    const first = await installPublishedResponseCache(root, window.manifest, controller.signal);
    const second = await installPublishedResponseCache(root, window.manifest);
    const name = (await caches.keys()).find(name => name.includes(encodeURIComponent(root)));
    await (await caches.open(name)).delete(new URL('./slow.bin', location.href));
    const file = window.manifest.files.find(file => file.path === 'slow.bin');
    const pendingFirst = first.ensure(file); const pendingSecond = second.ensure(file);
    await new Promise(resolve => setTimeout(resolve, 60)); controller.abort();
    const results = await Promise.all([pendingFirst, pendingSecond]);
    const retained = await second.has(file); second.dispose();
    return { results, retained };
  });
  assert.deepEqual(cancellation, { results: [false, true], retained: true });
  assert.equal(counts.get(base + 'slow.bin') - slowBefore, 1, 'two sessions share one download');
  assert.equal(slowCancelled, 0, 'one cancelled session cannot abort another session');
  oversizedMode = true;
  const oversized = await page.evaluate(async () => {
    const root = new URL('./', location.href).href;
    const name = (await caches.keys()).find(name => name.includes(encodeURIComponent(root)));
    const url = new URL('./oversized.bin', location.href);
    await (await caches.open(name)).delete(url);
    let failed = false;
    try { await (await fetch(url)).arrayBuffer(); } catch { failed = true; }
    const file = window.manifest.files.find(file => file.path === 'oversized.bin');
    return { failed, cached: await window.session.has(file), ensured: await window.session.ensure(file) };
  });
  assert.deepEqual(oversized, { failed: true, cached: false, ensured: false });
  assert.ok(oversizedChunks < 200, 'oversized native and prefetch responses must stop early');
  assert.equal(oversizedCancelled, 2);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: path.join(output, 'ready.png') });
  const report = { status: 'PASS', samples, workerRestart: true, bypass, repair, quota, range, cancellation, oversized: { ...oversized, chunks: oversizedChunks, cancelled: oversizedCancelled }, requests: Object.fromEntries(counts), errors };
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
