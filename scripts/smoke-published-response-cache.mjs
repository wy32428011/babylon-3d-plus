/* global window, location, caches */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { precompressDeploymentFiles } from '../dist-electron/ipc/deploymentPrecompression.js';
import path from 'node:path';
import ts from 'typescript';
import { chromium } from 'playwright';
import { deploymentGlbFixture } from '../tests/helpers/deploymentGlbFixture.mjs';

const output = path.resolve(process.env.RESPONSE_CACHE_OUTPUT ?? 'output/playwright/published-response-cache');
await mkdir(output, { recursive: true });
const helper = ts.transpileModule(await readFile('src/player/publishedResponseCache.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
// 直接运行产品缓存实现；测试服务器仅将这几个本地TS模块转为浏览器可执行JS。
const modules = new Map();
for (const file of ['src/runtime/assets/publishedAssetCache.ts', 'src/runtime/assets/publishedCacheStore.ts',
  'src/runtime/assets/publishedRawStore.ts', 'src/runtime/assets/publishedBlobHash.ts',
  'src/runtime/babylon/skyboxContentHash.ts', 'src/runtime/babylon/SceneLoadDiagnostics.ts', 'electron/shared/sha256.ts']) {
  modules.set('/' + file, ts.transpileModule(await readFile(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText);
}
const source = await readFile('public/published-cache-worker.js', 'utf8');
// 仅测试服务器注入浏览器 Cache API 故障，生产 worker 不包含故障开关。
const worker = source + `\nlet fixtureQuota = false;
const fixturePut = Cache.prototype.put;
Cache.prototype.put = function(request,response) {
  if (fixtureQuota && String(request.url || request).endsWith('/quota.js')) return Promise.reject(new DOMException('Fixture quota exceeded','QuotaExceededError'));
  return fixturePut.call(this,request,response);
};
self.addEventListener('message',event=> { if(event.data.fixtureQuota !== undefined) { fixtureQuota = event.data.fixtureQuota; event.ports[0].postMessage(true); } });`;
// 使用公开B7合同独立构造有效binary；运输测试不依赖先前任务输出。
const fixtureSource = ts.transpileModule(await readFile('tests/lightingBake/lightingGeometryBinaryFixture.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { binaryFixture, geometryFixture } = await import('data:text/javascript;base64,' + Buffer.from(fixtureSource).toString('base64'));
const binaryGeometry = Buffer.from(binaryFixture({ ...geometryFixture, indices: Array.from({ length: 4096 }, () => [0, 1, 2]).flat() }));
const packages = new Map();
const fixtureRoot=path.join(output,'releases',String(Date.now()));
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
 const transport=[];
 for(const file of manifest.files.filter(file=>file.path.startsWith('transport/'))) {
   const response=await fetch('./'+file.path); const bytes=await response.arrayBuffer();
   const sha256=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
   transport.push({path:file.path,size:bytes.byteLength,sha256,contentType:response.headers.get('content-type')});
 }
 const {PublishedAssetCache}=await import('/src/runtime/assets/publishedAssetCache.ts');
 const {PublishedRawStore}=await import('/src/runtime/assets/publishedRawStore.ts');
 const rawFiles=manifest.files.filter(file=>file.path.startsWith('project/assets/transport'));
 const resources=new Map(rawFiles.map(file=>[new URL(file.path,base).href,{size:file.size,sha256:file.sha256}]));
 const cache=new PublishedAssetCache({baseUrl:base,revision:config.cacheRevision,assetBase:'./project/assets/',documentUrls:[],
   resources,rawStore:new PublishedRawStore('precompression-raw-'+config.cacheRevision)});
 const decoded=[];
 for(const file of rawFiles) {
   const response=await cache.fetch(new URL(file.path,base).href); const bytes=await response.arrayBuffer();
   const glb=file.path.endsWith('.glb');
   const value=glb
     ? await cache.decode('glb-metadata-v1',bytes,async()=>{
       const view=new DataView(bytes);
       if(view.getUint32(0,true)!==0x46546c67||view.getUint32(4,true)!==2||view.getUint32(8,true)!==bytes.byteLength) throw new Error('invalid GLB fixture');
       const json=JSON.parse(new TextDecoder().decode(bytes.slice(20,20+view.getUint32(12,true))));
       return {node:json.nodes[0].name,vertices:json.accessors[0].count,indices:json.accessors[1].count};
     },value=>value?.vertices===3&&value.indices===6144,value=>JSON.stringify(value).length)
     : await cache.decode('json-v1',bytes,async()=>JSON.parse(new TextDecoder().decode(bytes)),
       value=>Array.isArray(value?.positions),value=>value.positions.length*8);
   const sha256=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
   decoded.push({path:file.path,size:bytes.byteLength,sha256,contentType:response.headers.get('content-type'),
     ...(glb?value:{positions:value.positions.length,first:value.positions[0]})});
 }
 const metrics={...cache.metrics}; cache.dispose();
 window.result={available:session.available,reason:session.reason,ready:results.every(Boolean),content,revision:config.cacheRevision,transport,decoded,metrics};
 document.querySelector('#status').textContent=JSON.stringify(window.result);
}catch(error){window.result={error:String(error)};}
</script></body></html>`;
  const files = new Map([
    ['index.html', Buffer.from(html)], ['helper.js', Buffer.from(helper)],
    ['app.js', Buffer.from('/* visible release ' + version + ' */')], ['quota.js', Buffer.from('/* quota fallback */')],
    ['transport/main.js', Buffer.from('export const message="压缩传输字节";\n'.repeat(4096))],
    ['transport/main.css', Buffer.from('.fixture { color: #123456; }\n'.repeat(4096))],
    ['transport/geometry.bin', binaryGeometry],
    ['transport/model.glb', deploymentGlbFixture('HTTP-' + version)],
    ['transport/decoder.wasm', Buffer.concat([Buffer.from([0,97,115,109,1,0,0,0]), Buffer.alloc(65536, 65)])],
    ['project/assets/transport-gi.json', Buffer.from(JSON.stringify({ positions:Array(16384).fill(0.125) }))],
    ['project/assets/transport-model.glb', deploymentGlbFixture('HTTP-' + version)],
    ['slow.bin', Buffer.alloc(128 * 1024, 71)],
    ['oversized.bin', Buffer.from('expected response')],
    ['assets/%E6%A8%A1%E5%9E%8B%20%231%25.bin', Buffer.from('encoded path resource')],
    ['project/assets/raw.bin', Buffer.from('IDB owned, no SW write')],
  ]);
  const manifest = { version: 1, cacheRevision: 'revision-' + version, totalBytes: 0, files: [...files].map(([name, body]) => ({ path: name, size: body.length, sha256: createHash('sha256').update(body).digest('hex'), contentType: ({'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.wasm':'application/wasm','.glb':'model/gltf-binary'})[path.extname(name)]??'application/octet-stream', storage: name.startsWith('project/') ? 'asset' : 'response' })) };
  manifest.totalBytes = manifest.files.reduce((sum, file) => sum + file.size, 0);
  const root=path.join(fixtureRoot,version);
  for(const [name,body] of files) { const file=path.join(root,...name.split('/').map(decodeURIComponent)); await mkdir(path.dirname(file),{recursive:true}); await writeFile(file,body); }
  await writeFile(path.join(root,'runtime-config.json'),JSON.stringify({cacheRevision:manifest.cacheRevision}));
  await writeFile(path.join(root,'release-cache-manifest.json'),JSON.stringify(manifest));
  await writeFile(path.join(root,'published-cache-worker.js'),worker);
  const precompression=await precompressDeploymentFiles(root,manifest,new AbortController().signal);
  const sidecars=new Map();
  for(const file of precompression.files) { const key=file.sourcePath.split('/').map(encodeURIComponent).join('/'); sidecars.set(key+':'+file.encoding,await readFile(path.join(root,file.path))); }
  assert.ok(precompression.files.length>=14,'实际生成JS/CSS/WASM/GI JSON/binary/GLB传输侧车');
  for(const name of ['transport/model.glb','project/assets/transport-model.glb']) {
    for(const encoding of ['br','gzip']) assert.ok(sidecars.has(name+':'+encoding),'GLB 生成两种可选传输表示');
  }
  packages.set(base, { files, manifest, root, sidecars, precompression, encoding:version==='101'?'gzip':'br' });
}
const counts = new Map();
const transfers = [];
let slowDelay = false;
let slowCancelled = 0;
let oversizedMode = false;
let oversizedChunks = 0;
let oversizedCancelled = 0;
const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://fixture');
  counts.set(url.pathname, (counts.get(url.pathname) ?? 0) + 1);
  response.setHeader('Cache-Control', 'no-store');
  if(modules.has(url.pathname)) { response.setHeader('Content-Type','text/javascript'); response.end(modules.get(url.pathname)); return; }
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
    } else {
      const encoded=pkg.sidecars.get(file+':'+pkg.encoding);
      const accepted=String(request.headers['accept-encoding']??'').split(',').some(value=>value.trim().split(';')[0]===pkg.encoding);
      const body=encoded&&accepted?encoded:pkg.files.get(file);
      if(encoded&&accepted) response.setHeader('Content-Encoding',pkg.encoding);
      response.setHeader('Vary','Accept-Encoding'); response.setHeader('Content-Length',body.length);
      if(file.startsWith('transport/')||file.startsWith('project/assets/transport')) transfers.push({path:base+file,encoding:encoded&&accepted?pkg.encoding:'identity',bytes:body.length,decodedBytes:pkg.files.get(file).length,probe:request.headers['x-fixture-probe']==='1'});
      response.end(body);
    }
  }
  else { response.setHeader('Content-Type', 'text/plain'); response.end('uncached dynamic path'); }
});
let browser;
const httpNegotiation=[];
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  // 同一原URL直接检查无编码回退和压缩表示的MIME/协商头/解压后SHA，不经过应用缓存。
  for(const [base,pkg] of packages) for(const file of pkg.manifest.files.filter(file=>file.path.startsWith('transport/')||file.path.startsWith('project/assets/transport'))) {
    for(const encoding of ['identity',pkg.encoding]) {
      const response=await fetch(origin+base+file.path,{headers:{'Accept-Encoding':encoding,'X-Fixture-Probe':'1'}});
      const bytes=Buffer.from(await response.arrayBuffer()),sha256=createHash('sha256').update(bytes).digest('hex');
      assert.equal(response.status,200); assert.equal(bytes.length,file.size); assert.equal(sha256,file.sha256);
      assert.equal(response.headers.get('content-encoding'),encoding==='identity'?null:encoding);
      assert.equal(response.headers.get('content-type'),file.contentType); assert.match(response.headers.get('vary'),/Accept-Encoding/i);
      const encodedBytes=Number(response.headers.get('content-length'));
      assert.equal(encodedBytes,encoding==='identity'?file.size:pkg.sidecars.get(file.path+':'+encoding).length);
      httpNegotiation.push({path:base+file.path,encoding,encodedBytes,decodedBytes:bytes.length,sha256,contentType:file.contentType});
    }
  }
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const samples = [];
  for (const [name, version] of [['cold', '101'], ['warm', '101'], ['new-release', '102'], ['warm-br', '102'], ['old-release', '101']]) {
    const base = '/digital-twin/releases/7/' + version + '/';
    const before = Object.fromEntries(counts);
    const firstTransfer=transfers.length;
    await page.goto(origin + base);
    await page.waitForFunction(() => window.result, { timeout: 30000 });
    const result = await page.evaluate(() => window.result);
    assert.equal(result.error, undefined, result.error);
    assert.equal(result.available, true, result.reason); assert.equal(result.ready, true, JSON.stringify(result));
    assert.equal(result.revision, 'revision-' + version);
    const warm=name==='warm'||name==='warm-br'||name==='old-release';
    for(const file of [...result.transport,...result.decoded]) { const expected=packages.get(base).manifest.files.find(row=>row.path===file.path); assert.equal(file.size,expected.size); assert.equal(file.sha256,expected.sha256); assert.equal(file.contentType,expected.contentType); }
    assert.equal(result.decoded[0].positions,16384); assert.equal(result.decoded[0].first,0.125);
    const model=result.decoded.find(file=>file.path.endsWith('.glb'));
    assert.equal(model.node,'HTTP-'+version); assert.equal(model.vertices,3); assert.equal(model.indices,6144);
    assert.equal(model.contentType,'model/gltf-binary');
    assert.equal(result.metrics.storageFailures,0);
    if(warm) { assert.equal(result.metrics.downloads,0); assert.equal(result.metrics.decodes,0); assert.equal(result.metrics.resourceHits,2); assert.equal(result.metrics.decodeHits,2); }
    else { assert.equal(result.metrics.downloads,2); assert.equal(result.metrics.decodes,2); assert.equal(result.metrics.decodeHits,0); }
    if (warm) {
      for (const file of packages.get(base).manifest.files.filter(file => file.storage === 'response')) {
        assert.equal(counts.get(base + file.path) ?? 0, before[base + file.path] ?? 0, name + ': no repeated static bytes: ' + file.path);
      }
      assert.equal(counts.get(base) ?? 0, before[base] ?? 0, 'root index alias must be cached');
    }
    const wire=transfers.slice(firstTransfer);
    if(warm) assert.equal(wire.length,0,'冷热缓存命中后无重复传输侧车/原文');
    else { assert.equal(wire.length,7); assert.ok(wire.every(row=>row.encoding===packages.get(base).encoding&&row.bytes<row.decodedBytes)); }
    samples.push({ name, ...result, transfer:{encoding:packages.get(base).encoding,requests:wire.length,encodedBytes:wire.reduce((n,row)=>n+row.bytes,0),decodedBytes:wire.reduce((n,row)=>n+row.decodedBytes,0)} });
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
  const report = { status: 'PASS', samples, workerRestart: true, bypass, repair, quota, range, cancellation, oversized: { ...oversized, chunks: oversizedChunks, cancelled: oversizedCancelled }, requests: Object.fromEntries(counts), httpNegotiation, transfers, precompression:[...packages].map(([base,pkg])=>({base,...pkg.precompression})), errors };
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
