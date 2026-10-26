import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { build } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
const base = path.dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({ options: { fixtures: { type: 'string' }, output: { type: 'string' }, perf: { type: 'boolean', default: false }, parallel: { type: 'boolean', default: false } }, strict: true });
assert.ok(values.fixtures, '用法：node tests/runtime/localKtx2Workers.webgl.mjs --fixtures <三类KTX2目录> [--output output/新目录] [--perf]');
const output = path.resolve(values.output ?? ('output/playwright/local-ktx2-' + Date.now()));
const relative = path.relative(path.resolve('output'), output);
assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), '测试输出须为workspace output内的新目录');
await fs.mkdir(path.dirname(output), { recursive: true }); await fs.mkdir(output);
const site = path.join(output, 'site'), assets = path.resolve(values.fixtures);
const fixtureEntry = path.join(base, 'fixtures/localKtx2WorkerFixture.ts');
const hash = data => createHash('sha256').update(data).digest('hex');
assert.ok(!(values.perf && values.parallel), '并发语义测试不用于原顺序加载计时');
const performanceMode = values.perf;
const report = { passed: false, samples: [], comparisons: [], errors: [], requests: [], cleanup: {}, performanceMode, parallel: values.parallel, inputs: [] };
let browser, server;
const config = { version: 1, cacheRevision: 'ld1-isolated-1', page: { title: 'LD1', loadingText: '加载', backgroundColor: '#111111' },
  paths: { scene: './project/scene.json', assetManifest: './project/asset-manifest.json', assetBase: './project/assets/' },
  viewer: { showGrid: false, allowCameraControl: false, showStatusOverlay: false },
  mqtt: { enabled: false, ip: '', address: '', topic: '', subscriptions: [], simulatorEnabled: false, simulatorAssetCode: '', simulatorScenario: 'cycle', simulatorIntervalMs: 500 } };
try {
  for (const file of ['src/runtime/babylon/ktx2WorkerDecoder.ts', 'src/runtime/babylon/ktx2DecodeWorkerPool.ts', 'src/runtime/babylon/ktx2Decode.worker.ts', 'src/runtime/babylon/ktx2DecoderConfiguration.ts', 'src/runtime/babylon/localDecoderConfiguration.ts', 'src/runtime/babylon/createEngine.ts', 'src/player/publishedBabylonCache.ts', fixtureEntry, fileURLToPath(import.meta.url), ...['color_grid_blze.ktx2','color_grid_uastc_zstd_5.ktx2','alpha_simple_blze.ktx2'].map(name=>path.join(assets,name)), ...['uastc_astc.wasm','uastc_bc7.wasm','uastc_rgba8_unorm_v2.wasm','uastc_rgba8_srgb_v2.wasm','uastc_r8_unorm.wasm','uastc_rg8_unorm.wasm','msc_basis_transcoder.js','msc_basis_transcoder.wasm','zstddec.wasm'].map(name=>path.resolve('public/babylon-decoders/ktx2',name)), 'node_modules/@babylonjs/core/Misc/khronosTextureContainer2.js', 'node_modules/@babylonjs/core/Misc/khronosTextureContainer2Worker.js', 'node_modules/@babylonjs/ktx2decoder/ktx2Decoder.js']) report.inputs.push({ path: path.resolve(file), sha256: hash(await fs.readFile(file)) });
  await build({ root: process.cwd(), configFile: false, base: './', publicDir: false, logLevel: 'warn',
    build: { outDir: site, emptyOutDir: false, rollupOptions: { input: fixtureEntry, output: { entryFileNames: 'fixture.js' } } } });
  server = createServer((req, res) => { void (async () => {
    const pathname = decodeURIComponent(new URL(req.url, 'http://local').pathname); report.requests.push(pathname);
    res.setHeader('Cache-Control', 'no-store');
    if (pathname === '/viewer/') {
      res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><link rel="icon" href="data:,"><style>body{margin:0}canvas{display:block}</style><canvas width="640" height="480"></canvas><script type="module" src="/fixture.js"></script>'); return;
    }
    if (pathname.endsWith('/runtime-config.json')) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(config)); return; }
    if (pathname.endsWith('/scene.json')) { res.end('ld1-isolated-source'); return; }
    if (pathname.endsWith('/asset-manifest.json')) { res.setHeader('Content-Type', 'application/json'); res.end('{"assets":[]}'); return; }
    let file;
    if (pathname.startsWith('/viewer/project/assets/') && pathname.endsWith('.ktx2')) file = path.join(assets, path.basename(pathname));
    else if (pathname.startsWith('/viewer/babylon-decoders/')) file = path.resolve('public', pathname.slice('/viewer/'.length));
    else file = path.join(site, pathname.replace(/^\//, ''));
    const resolved = path.resolve(file);
    assert.ok([site, assets, path.resolve('public/babylon-decoders')].some(root => !path.relative(root, resolved).startsWith('..')), 'server范围无效');
    try {
      const bytes = await fs.readFile(file); res.setHeader('Content-Type', file.endsWith('.wasm') ? 'application/wasm' : file.endsWith('.ktx2') ? 'image/ktx2' : 'text/javascript'); res.end(bytes);
    } catch { res.statusCode = 404; res.end(); }
  })().catch(error => { report.errors.push(error.stack); res.statusCode = 500; res.end(); }); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  report.port = server.address().port;
  browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--use-angle=d3d11'] });
  const raws = new Map();
  const experiments = performanceMode ? [ ['warmup-A', 'main'], ['warmup-B', 'worker'], ['A1', 'main'], ['B1', 'worker'], ['B2', 'worker'], ['A2', 'main'] ] : [['main', 'main'], ['worker', 'worker'], ['boot-failure', 'boot-failure']];
  for (const [label, mode] of experiments) {
    const context = await browser.newContext({ viewport: { width: 640, height: 480 }, deviceScaleFactor: 1 });
    const page = await context.newPage(); page.setDefaultTimeout(90000);
    const pageErrors = [], remote = [], warnings = [];
    page.on('pageerror', e => pageErrors.push(e.stack));
    page.on('console', m => { if (m.type() === 'warning') warnings.push(m.text()); });
    await context.route('**/*', route => {
      const u = new URL(route.request().url());
      if (u.protocol === 'http:' && u.hostname === '127.0.0.1' && Number(u.port) === report.port) return route.continue();
      if (u.protocol === 'data:') return route.continue();
      remote.push(u.href); return route.abort();
    });
    const physicalWorkers = [];
    page.on('worker', worker => { if (worker.url().includes('ktx2Decode.worker')) physicalWorkers.push(worker.url()); });
    for (const phase of ['cold', 'warm']) {
      const beforeWorkers = physicalWorkers.length;
      const name = label + '-' + phase;
      await page.goto(`http://127.0.0.1:${report.port}/viewer/?mode=${mode}${values.parallel ? '&parallel=1' : ''}`);
      await page.waitForFunction(() => window.ld1Result !== undefined);
      const r = await page.evaluate(() => window.ld1Result);
      r.physicalWorkers = physicalWorkers.slice(beforeWorkers);
      assert.ok(!r.error, r.error); assert.deepEqual(pageErrors, []); assert.deepEqual(remote, []);
      assert.ok(r.renderer.renderer.includes('Intel'), '不能用软件renderer验收');
      const pixels = [];
      for (const c of r.captures) {
        const raw = Buffer.from(c.rgba, 'base64'); pixels.push(raw); c.sha256 = hash(raw);
        await fs.writeFile(path.join(output, name + '-' + c.name + '.png'), Buffer.from(c.png.split(',')[1], 'base64'), { flag: 'wx' });
        delete c.rgba; delete c.png;
        assert.ok(c.samplingValid, '纹理采样未达到已知图像条件：' + JSON.stringify(c));
      }
      raws.set(name, pixels); report.samples.push({ name, ...r, warnings });
      if (phase === 'cold') { assert.equal(r.cache.decodes, 3); assert.equal(r.decodes.length, 3); }
      else { assert.equal(r.cache.decodes, 0); assert.equal(r.cache.decodeHits, 3); assert.equal(r.decodes.length, 0); }
      if (mode === 'worker' && phase === 'cold') {
        assert.equal(r.diagnostics.completed, 3, '真实worker未执行三个格式');
        assert.equal(r.physicalWorkers.length, values.parallel ? Math.min(3,r.diagnostics.workers) : 1, '实际worker数量与有界并发不符');
      }
      if (mode === 'boot-failure' && phase === 'cold') {
        assert.ok(r.diagnostics.infrastructureFallbacks >= 1 && r.diagnostics.mainThread >= 3, '基础设施故障没有回原执行器');
        assert.equal(r.diagnostics.completed, 0); assert.equal(r.bootAttempts, 1, '初始化失败后不得重复创建故障worker');
      }
      await page.evaluate(() => window.ld1Dispose());
      console.log(JSON.stringify({ name, cache: r.cache, diagnostics: r.diagnostics }));
    }
    await context.close();
  }
  const reference = raws.get(performanceMode ? 'A1-cold' : 'main-cold');
  for (const [name, pixels] of raws) {
    for (let i = 0; i < reference.length; i++) {
      let changed = 0, max = 0;
      for (let j = 0; j < pixels[i].length; j++) { const d = Math.abs(pixels[i][j] - reference[i][j]); if (d) changed++; max = Math.max(max, d); }
      report.comparisons.push({ name, texture: i, changedComponents: changed, maxChannelDelta: max });
      assert.equal(changed, 0, name + ' pixels changed');
    }
  }
  const sortedDecodes = rows => [...rows].sort((a,b) => a.mips[0].sha256.localeCompare(b.mips[0].sha256));
  const main = report.samples.find(r => r.name === (performanceMode ? 'A1-cold' : 'main-cold')).decodes;
  for (const name of (performanceMode ? ['B1-cold', 'B2-cold', 'A2-cold'] : ['worker-cold', 'boot-failure-cold'])) assert.deepEqual(sortedDecodes(report.samples.find(r => r.name === name).decodes), sortedDecodes(main), '实际转码mip字节或元数据不同');
  if (performanceMode) {
    const rows = ['A1', 'B1', 'B2', 'A2'].map(label => {
      const sample = report.samples.find(r => r.name === label + '-cold');
      assert.equal(sample.timing.supported, true, '缺少longtask API不能填0');
      return { name: label, readyMs: sample.timing.windows.reduce((sum, window) => sum + window.readyMs, 0),
        longTaskClippedMs: sample.timing.windows.reduce((sum, window) => sum + window.longTaskClippedMs, 0), windows: sample.timing.windows };
    });
    const mean = (arm, key) => rows.filter(row => row.name.startsWith(arm)).reduce((sum, row) => sum + row[key], 0) / 2;
    report.performance = { rows, A: { readyMs: mean('A', 'readyMs'), longTaskClippedMs: mean('A', 'longTaskClippedMs') },
      B: { readyMs: mean('B', 'readyMs'), longTaskClippedMs: mean('B', 'longTaskClippedMs') },
      limitations: ['受控三张KTX2纹理加载窗，不是完整Editor/Viewer/工厂首次打开时间或FPS。', '新context隔离冷IDB，每轮仍验证同context热cache；两次非计量warmup后ABBA。'] };
  }
  for (const row of report.inputs) assert.equal(hash(await fs.readFile(row.path)), row.sha256, 'LD1输入在运行后变化：' + row.path);
  assert.deepEqual(report.errors, []); report.passed = true;
} catch (error) { report.errors.push(error.stack ?? String(error)); process.exitCode = 1; }
finally {
  await browser?.close(); report.cleanup.browserClosed = Boolean(browser);
  if (server?.listening) { await new Promise(resolve => server.close(resolve)); report.cleanup.serverClosed = true; }
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ passed: report.passed, output, errors: report.errors }));
}
