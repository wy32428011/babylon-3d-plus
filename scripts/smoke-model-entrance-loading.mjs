import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import path from 'node:path';
import ts from 'typescript';

const output = path.resolve('output/playwright/entrance-loading-20261009');
const source = 'http://192.168.50.34:8080/digital-twin/releases/2071816469849280514/109/';
const baseline = path.join(output, 'baseline');
const canonicalBaseline = path.join(output, 'baseline-canonical');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const within = (root, relative) => {
  const file = path.resolve(root, relative);
  const checked = path.relative(root, file);
  assert.ok(checked && !checked.startsWith('..') && !path.isAbsolute(checked), `非法资源路径 ${relative}`);
  return file;
};

async function download() {
  const response = await fetch(new URL('release-cache-manifest.json', source), { signal: AbortSignal.timeout(30000) });
  assert.equal(response.status, 200);
  const manifestBytes = Buffer.from(await response.arrayBuffer());
  const manifest = JSON.parse(manifestBytes);
  await mkdir(baseline, { recursive: true });
  await writeFile(path.join(baseline, 'release-cache-manifest.json'), manifestBytes);
  const configResponse = await fetch(new URL('runtime-config.json', source), { signal: AbortSignal.timeout(30000) });
  assert.equal(configResponse.status, 200);
  await writeFile(path.join(baseline, 'runtime-config.json'), Buffer.from(await configResponse.arrayBuffer()));
  const results = [];
  let cursor = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (cursor < manifest.files.length) {
      const item = manifest.files[cursor++];
      const target = within(baseline, item.path);
      let bytes = await readFile(target).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (!bytes || bytes.length !== item.size || hash(bytes) !== item.sha256) {
        const resource = await fetch(new URL(item.path, source), { signal: AbortSignal.timeout(120000) });
        assert.equal(resource.status, 200, item.path);
        bytes = Buffer.from(await resource.arrayBuffer());
        assert.equal(bytes.length, item.size, `${item.path} 字节数`);
        assert.equal(hash(bytes), item.sha256, `${item.path} SHA256`);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, bytes);
      }
      results.push({ path: item.path, size: bytes.length, sha256: hash(bytes) });
    }
  }));
  results.sort((a, b) => a.path.localeCompare(b.path));
  assert.equal(results.length, manifest.files.length);
  assert.equal(results.reduce((sum, item) => sum + item.size, 0), manifest.totalBytes);
  await writeFile(path.join(output, 'baseline-integrity.json'), JSON.stringify({ source, cacheRevision: manifest.cacheRevision, files: results.length, totalBytes: manifest.totalBytes, results }, null, 2));
  console.log(`PASS 第109版完整发布副本：${results.length}文件/${manifest.totalBytes}字节全部size/SHA256一致`);
}

if (process.argv.includes('--download')) await download();

async function canonicalizeBaseline() {
  const manifestBytes = await readFile(path.join(baseline, 'release-cache-manifest.json'));
  const manifest = JSON.parse(manifestBytes);
  await mkdir(canonicalBaseline, { recursive: true });
  for (const item of manifest.files) {
    const bytes = await readFile(within(baseline, item.path));
    assert.equal(bytes.length, item.size, item.path); assert.equal(hash(bytes), item.sha256, item.path);
    // 清单存的是 URL 路径；还原真实文件名后再生成新清单，避免 % 被二次编码。
    const target = within(canonicalBaseline, decodeURIComponent(item.path));
    await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, bytes);
  }
  await writeFile(path.join(canonicalBaseline, 'release-cache-manifest.json'), manifestBytes);
  await cp(path.join(baseline, 'runtime-config.json'), path.join(canonicalBaseline, 'runtime-config.json'));
}

async function packageViewer() {
  await canonicalizeBaseline();
  const optimized = path.join(output, process.argv.includes('--final-package') ? 'validated-dist' : 'optimized-v2');
  await mkdir(optimized, { recursive: true });
  await cp(path.resolve('dist-viewer-template'), optimized, { recursive: true });
  await cp(path.join(canonicalBaseline, 'project'), path.join(optimized, 'project'), { recursive: true });
  const config = JSON.parse(await readFile(path.join(canonicalBaseline, 'runtime-config.json'), 'utf8'));
  config.cacheRevision = 'entrance-loading-local-20261009';
  await writeFile(path.join(optimized, 'runtime-config.json'), JSON.stringify(config, null, 2));
  const { createDeploymentReleaseCacheManifest } = await import('../dist-electron/ipc/deploymentReleaseCacheManifest.js');
  const manifest = await createDeploymentReleaseCacheManifest(optimized, config.cacheRevision, new AbortController().signal);
  await writeFile(path.join(optimized, 'release-cache-manifest.json'), JSON.stringify(manifest, null, 2));
  const previous = JSON.parse(await readFile(path.join(baseline, 'release-cache-manifest.json'), 'utf8'));
  const matched = previous.files.filter(item => item.path.startsWith('project/'));
  for (const item of matched) {
    const current = manifest.files.find(candidate => candidate.path === item.path);
    assert.ok(current, item.path); assert.equal(current.size, item.size, item.path); assert.equal(current.sha256, item.sha256, item.path);
  }
  await writeFile(path.join(output, 'optimized-integrity.json'), JSON.stringify({ projectFiles: matched.length, identical: true, viewerFiles: manifest.files.length, cacheRevision: manifest.cacheRevision }, null, 2));
  console.log(`PASS 离线DIST保留${matched.length}个project文件原始字节`);
}

// 只在HTTP响应末尾追加测试观察器；磁盘发布副本及算法保持原始字节。
function observeBundle(text) {
  const ast = ts.createSourceFile('viewer.js', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const classes = [];
  const visit = node => {
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      const name = node.name?.text ?? (ts.isVariableDeclaration(node.parent) ? node.parent.name.getText(ast) : null);
      if (name) classes.push({ name, methods: new Set(node.members.filter(ts.isMethodDeclaration).map(member => member.name.getText(ast))) });
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  const runtime = classes.filter(candidate => candidate.methods.has('prepareModelEntrance') && candidate.methods.has('getInitialLoadSnapshot'));
  const bridge = classes.filter(candidate => candidate.methods.has('markInitialLoadComplete') && candidate.methods.has('markInitialLoadStarted'));
  assert.equal(runtime.length, 1, '运行时类必须唯一'); assert.equal(bridge.length, 1, '首帧门控类必须唯一');
  return text + `\n;(()=>{const p=${runtime[0].name}.prototype, original=p.prepareModelEntrance;const state=globalThis.__entranceSmoke={instrumentation:'method boundary observation only; no algorithm changes',sequence:0,longTasks:[]};new PerformanceObserver(list=>{for(const entry of list.getEntries()){state.longTasks.push(entry.duration);if(state.longTasks.length>1000)state.longTasks.shift();}}).observe({entryTypes:['longtask']});p.prepareModelEntrance=function(...args){state.runtime=this;const sequence=++state.sequence,start=performance.now();const finish=()=>{if(sequence!==state.sequence)return;state.prepareMs=performance.now()-start;state.preparedAt=performance.now();};try{const value=original.apply(this,args);if(value&&typeof value.then==='function')return value.finally(finish);finish();return value;}catch(error){finish();throw error;}};const b=${bridge[0].name}.prototype,complete=b.markInitialLoadComplete;b.markInitialLoadComplete=function(...args){const value=complete.apply(this,args);state.firstFrameAt??=performance.now();return value;};setInterval(()=>{if(!state.runtime)return;const root=document.querySelector('.player-root'),entrance=state.runtime.getModelEntranceSnapshot();if(!state.openingCompletedAt&&state.preparedAt&&root&&!root.classList.contains('opening-presentation-active'))state.openingCompletedAt=performance.now();if(!state.interactiveAt&&state.firstFrameAt&&state.openingCompletedAt&&entrance.status==='completed')state.interactiveAt=performance.now();state.snapshot=entrance;},50);})();`;
}

async function benchmark() {
  await canonicalizeBaseline();
  const report = { boundary: '第109版完整scene/project字节；本机静态DIST Chrome硬件WebGL；runtime API与MQTT配置使用fixture，不验证线上网络或业务消息。首帧就绪为原初始加载门控markInitialLoadComplete调用；另测开场结束与入场完成，均非GPU提交时间。', samples: [], errors: [] };
  const observedBundles = new Map();
  const observedBundle = async file => { if (!observedBundles.has(file)) observedBundles.set(file, Buffer.from(observeBundle(await readFile(file, 'utf8')))); return observedBundles.get(file); };
  const mime = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.wasm': 'application/wasm', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
  const server = createServer((request, response) => { void (async () => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname === '/favicon.ico') { response.writeHead(204).end(); return; }
      if (url.pathname === '/api/v1/digital-twin/runtime-config/detail') {
        response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ success: true, data: { projectId: '2071816469849280514', runtimeEnabled: true, mqttBrokerUrl: null, apiBaseUrl: null, config: {} } })); return;
      }
      const pathname = url.pathname.endsWith('/') ? url.pathname + 'index.html' : url.pathname;
      const relative = pathname.startsWith('/baseline/') ? 'baseline-canonical/' + pathname.slice('/baseline/'.length)
        : pathname.startsWith('/optimized/') ? 'optimized-v2/' + pathname.slice('/optimized/'.length) : pathname.slice(1);
      const file = within(output, decodeURIComponent(relative));
      let bytes = await readFile(file);
      if (file.endsWith('release-cache-manifest.json')) {
        const manifest = JSON.parse(bytes);
        for (const entry of manifest.files.filter(item => /^assets\/index-[^/]+\.js$/.test(item.path))) {
          const observed = await observedBundle(within(path.dirname(file), decodeURIComponent(entry.path)));
          manifest.totalBytes += observed.length - entry.size; entry.size = observed.length; entry.sha256 = hash(observed);
        }
        bytes = Buffer.from(JSON.stringify(manifest));
      }
      if (file.endsWith('runtime-config.json')) { const config = JSON.parse(bytes); config.mqtt.enabled = false; bytes = Buffer.from(JSON.stringify(config)); }
      if (/[/\\]assets[/\\]index-[^/\\]+\.js$/.test(file)) bytes = await observedBundle(file);
      response.writeHead(200, { 'content-type': mime[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' }); response.end(bytes);
    } catch (error) { report.errors.push(String(error)); response.writeHead(404).end(); }
  })(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const requested = process.env.ENTRANCE_VARIANTS?.split(',') ?? ['baseline', 'optimized'];
    for (const variant of requested) for (let repeat = 1; repeat <= 3; repeat++) {
      const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
      try {
        const page = await context.newPage();
        page.on('pageerror', error => report.errors.push(error.message));
        page.on('console', message => { if (message.type() === 'error') report.errors.push(message.text()); });
        for (const cache of ['cold', 'warm']) {
          await page.goto(`http://127.0.0.1:${server.address().port}/${variant}/`, { waitUntil: 'commit', timeout: 60000 });
          await page.waitForFunction(() => globalThis.__entranceSmoke?.interactiveAt, null, { timeout: 300000 });
          const sample = await page.evaluate(() => { const state = globalThis.__entranceSmoke;const canvas=document.querySelector('canvas.player-canvas');const gl=canvas.getContext('webgl2')??canvas.getContext('webgl');const ext=gl.getExtension('WEBGL_debug_renderer_info');return {prepareMs:state.prepareMs,firstFrameAt:state.firstFrameAt,openingCompletedAt:state.openingCompletedAt,interactiveAt:state.interactiveAt,entrance:state.snapshot,loading:state.runtime.getPerformanceMetrics().loading,longTasks:{count:state.longTasks.length,totalMs:state.longTasks.reduce((a,b)=>a+b,0),maxMs:Math.max(0,...state.longTasks)},renderer:ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER)}; });
          assert.ok(!/SwiftShader|llvmpipe/i.test(sample.renderer), '性能对照需要硬件WebGL');
          sample.variant=variant;sample.cache=cache;sample.repeat=repeat;report.samples.push(sample);
          await page.screenshot({ path: path.join(output, `${variant}-${cache}-${repeat}.png`) });
          console.log(JSON.stringify({variant, cache, repeat,prepareMs:sample.prepareMs,interactiveAt:sample.interactiveAt,renderer:sample.renderer}));
          await writeFile(path.join(output, 'benchmark.json'), JSON.stringify(report,null,2));
          assert.equal(report.errors.length, 0, '浏览器或静态资源错误必须可见');
        }
      } finally { await context.close(); }
    }
  } finally { await browser.close();await new Promise(resolve=>server.close(resolve));await writeFile(path.join(output,'benchmark.json'),JSON.stringify(report,null,2)); }
}
if (process.argv.includes('--package')) await packageViewer();
if (process.argv.includes('--benchmark')) await benchmark();
