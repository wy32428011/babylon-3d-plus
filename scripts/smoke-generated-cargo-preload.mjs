/* global window, document, Image */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer as createPortProbe } from 'node:net';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const output = path.resolve('output/generated-cargo-preload-20261023');
await mkdir(output, { recursive: true });
const report = { status: 'RUNNING', startedAt: new Date().toISOString(), modes: [], pageErrors: [], requests: [],
  boundary: '本地正式 SceneRuntime + 真实 Chrome 硬件 WebGL + 真实 GLB 解析；本地遥测快照驱动真实 SpecializedTelemetryRuntime。未连接现场 MQTT，也不代表已导出的 Viewer DIST 或线上部署。',
  comparison: '同一工作树、独立 BrowserContext；仅在 preload=off 模式注入空预取句柄，生成与交接业务路径完全相同。基准提交 219ec24 用于代码来源说明，未修改工作树检出它。',
};
const save = () => writeFile(path.join(output, 'results.json'), JSON.stringify(report, null, 2));
const digest = content => createHash('sha256').update(content).digest('hex');
let server, browser, activePage;

/** 构造真正的 GLB；预取与首次生成均由正式 SceneLoader 读取二进制数据。 */
function cubeGlb(size, color, animated = false) {
  const [x, y, z] = size.map(value => value / 2);
  const positions = new Float32Array([
    -x,-y,z, x,-y,z, x,y,z, -x,y,z, x,-y,-z, -x,-y,-z, -x,y,-z, x,y,-z,
    -x,y,z, x,y,z, x,y,-z, -x,y,-z, -x,-y,-z, x,-y,-z, x,-y,z, -x,-y,z,
    x,-y,z, x,-y,-z, x,y,-z, x,y,z, -x,-y,-z, -x,-y,z, -x,y,z, -x,y,-z,
  ]);
  const normals = new Float32Array([...[0,0,1], ...[0,0,1], ...[0,0,1], ...[0,0,1],
    ...[0,0,-1], ...[0,0,-1], ...[0,0,-1], ...[0,0,-1], ...[0,1,0], ...[0,1,0], ...[0,1,0], ...[0,1,0],
    ...[0,-1,0], ...[0,-1,0], ...[0,-1,0], ...[0,-1,0], ...[1,0,0], ...[1,0,0], ...[1,0,0], ...[1,0,0],
    ...[-1,0,0], ...[-1,0,0], ...[-1,0,0], ...[-1,0,0]]);
  const indices = new Uint16Array(Array.from({ length: 6 }, (_, face) => [0,1,2,0,2,3].map(index => index + face * 4)).flat());
  const arrays = [positions, normals, indices];
  if (animated) arrays.push(new Float32Array([0, 1]), new Float32Array([0,0,0, 0,0,.2]));
  let offset = 0;
  const views = arrays.map(array => { const view = { buffer: 0, byteOffset: offset, byteLength: array.byteLength }; offset += array.byteLength; return view; });
  const binary = Buffer.concat(arrays.map(array => Buffer.from(array.buffer)));
  const gltf = { asset: { version: '2.0', generator: 'generated-cargo-preload-smoke' }, scene: 0,
    scenes: [{ nodes: [0] }], nodes: [{ name: 'CargoBody', mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0 }] }],
    materials: [{ name: 'CargoPBR', pbrMetallicRoughness: { baseColorFactor: [...color, 1], metallicFactor: 0, roughnessFactor: .8 } }],
    buffers: [{ byteLength: binary.length }], bufferViews: views,
    accessors: [{ bufferView: 0, componentType: 5126, count: 24, type: 'VEC3', min: [-x,-y,-z], max: [x,y,z] },
      { bufferView: 1, componentType: 5126, count: 24, type: 'VEC3' }, { bufferView: 2, componentType: 5123, count: 36, type: 'SCALAR' }],
  };
  if (animated) {
    gltf.accessors.push({ bufferView: 3, componentType: 5126, count: 2, type: 'SCALAR', min: [0], max: [1] },
      { bufferView: 4, componentType: 5126, count: 2, type: 'VEC3' });
    gltf.animations = [{ name: 'CargoSlide', samplers: [{ input: 3, output: 4, interpolation: 'LINEAR' }], channels: [{ sampler: 0, target: { node: 0, path: 'translation' } }] }];
  }
  const jsonText = Buffer.from(JSON.stringify(gltf));
  const json = Buffer.concat([jsonText, Buffer.alloc((4 - jsonText.length % 4) % 4, 0x20)]);
  const bin = Buffer.concat([binary, Buffer.alloc((4 - binary.length % 4) % 4)]);
  const header = Buffer.alloc(12); header.writeUInt32LE(0x46546c67); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + 8 + json.length + 8 + bin.length, 8);
  const chunk = (bytes, type) => { const prefix = Buffer.alloc(8); prefix.writeUInt32LE(bytes.length); prefix.writeUInt32LE(type, 4); return Buffer.concat([prefix, bytes]); };
  return Buffer.concat([header, chunk(json, 0x4e4f534a), chunk(bin, 0x004e4942)]);
}

const scriptSource = `export default class RuntimeComponent {
  constructor(node) { this.node = node; }
  onStart() {
    window.cargoPreloadScriptStarts = (window.cargoPreloadScriptStarts || 0) + 1;
    for (const mesh of this.node.getChildMeshes(false)) if (mesh.getTotalVertices() > 0) mesh.scaling.x = this.width;
  }
}`;
// 小夹具提供校验摘要正确的预转译产物，避免把 TypeScript 编译器下载混入资源预取测量。
const compiledCode = scriptSource.replace('export default ', '') + '\nreturn { classes: { default: RuntimeComponent } };';
const compiledScript = JSON.stringify({ format: 'babylon-model-script-v1', sourceSha256: digest(scriptSource),
  codeSha256: digest(compiledCode), compilerVersion: 'smoke-fixture', code: compiledCode });
const glbs = { 'conveyor.glb': cubeGlb([4, .4, 1], [.2,.26,.33]),
  'cargo.glb': cubeGlb([.72,.34,.52], [.12,.72,.95]), 'animated.glb': cubeGlb([.72,.34,.52], [.8,.5,.16], true) };

function comparable(summary) {
  return { assetCode: summary.assetCode, task: summary.task, containerCode: summary.containerCode,
    position: summary.position, meshes: summary.meshes.map(({ id: _id, ...mesh }) => mesh) };
}

async function pixels(page, label) {
  const file = path.join(output, label + '.png');
  const png = await page.locator('canvas').screenshot({ path: file });
  const result = await page.evaluate(async value => {
    const image = new Image(); image.src = 'data:image/png;base64,' + value; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
    const bytes = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let colored = 0;
    for (let index = 0; index < bytes.length; index += 4) if (bytes[index + 2] > bytes[index] * 1.3 && bytes[index + 1] > bytes[index] * 1.7 && bytes[index + 1] > 70) colored++;
    return { width: image.width, height: image.height, colored };
  }, png.toString('base64'));
  assert.ok(result.colored > 30, '必须绘制真实青蓝货物像素：' + label);
  return { file, sha256: digest(png), ...result };
}

async function runMode(mode, base, html) {
  const context = await browser.newContext({ viewport: { width: 1100, height: 720 }, deviceScaleFactor: 1 });
  const page = await context.newPage(); activePage = page;
  const requests = [];
  page.on('pageerror', error => report.pageErrors.push({ mode, message: error.message }));
  await page.route('**/__cargo_preload_smoke__?**', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.route('**/__cargo_preload__/**', async route => {
    const url = new URL(route.request().url()); const name = path.basename(url.pathname);
    requests.push({ name, query: url.search, at: Date.now() });
    if (glbs[name]) {
      // 真实异步延迟使 prepare() 必须跨过预取等待；只返回 GLB，不替换 SceneLoader。
      if (name !== 'conveyor.glb') await new Promise(resolve => setTimeout(resolve, 120));
      return route.fulfill({ contentType: 'model/gltf-binary', body: glbs[name] });
    }
    if (name === 'cargo.model.ts') return route.fulfill({ contentType: 'text/plain', body: url.searchParams.has('modelScriptCompiled') ? compiledScript : scriptSource });
    if (name === 'cargo.model.ts.compiled.json') return route.fulfill({ contentType: 'application/json', body: compiledScript });
    return route.fulfill({ status: 404, body: 'Unknown fixture asset' });
  });
  try {
    await page.goto(base + '__cargo_preload_smoke__?preload=' + mode, { waitUntil: 'commit' });
    await page.waitForFunction(() => Boolean(window.generatedCargoPreload), null, { timeout: 120_000 });
    const renderer = await page.evaluate(() => window.generatedCargoPreload.renderer());
    assert.ok(renderer.renderer, '缺少实际 WebGL renderer');
    assert.doesNotMatch(renderer.renderer, /swiftshader|llvmpipe|software|microsoft basic render/i, '软件渲染不能作为本轮硬件 WebGL 验收');
    const prepared = await page.evaluate(() => window.generatedCargoPreload.prepare());
    const preparationRequests = requests.map(request => ({ ...request }));
    assert.equal(preparationRequests.filter(request => request.name === 'cargo.model.ts').length, 0, '预取不得读取或执行模型参数脚本');
    if (mode === 'on') {
      assert.equal(preparationRequests.filter(request => request.name === 'cargo.glb').length, 1, '相同源默认目标和两条规则只应预取一个静态模板');
      assert.equal(preparationRequests.filter(request => request.name === 'animated.glb').length, 1, '同源参数变体只应预取一个原始容器');
      assert.equal(prepared.preloadMetrics.readyAssetCount, 2, '两个不同源模板必须在首帧准备前完成');
    } else assert.equal(preparationRequests.filter(request => request.name === 'cargo.glb' || request.name === 'animated.glb').length, 0, '关闭预取时不得提前加载货物资产');
    const first = await page.evaluate(() => window.generatedCargoPreload.firstCargo());
    assert.equal(first.click.hostEntityId, 'preload-conveyor-a'); assert.equal(first.click.containerCode, '000317');
    if (mode === 'on') assert.equal(first.after, first.before, '预取完成后的首次货物生成不得新增 assetReadDecode');
    else assert.equal(first.after, first.before + 1, '对照模式的首次生成必须实际执行一次资产读取/解码');
    const firstPixels = await pixels(page, mode + '-first');
    const transfer = await page.evaluate(() => window.generatedCargoPreload.transfer());
    assert.equal(transfer.click.hostEntityId, 'preload-conveyor-b'); assert.equal(transfer.click.containerCode, '000317');
    assert.equal(transfer.summary.cargoId, first.summary.cargoId); assert.equal(transfer.summary.ownerId, first.summary.ownerId);
    const transferredPixels = await pixels(page, mode + '-transferred');
    const isolation = await page.evaluate(() => window.generatedCargoPreload.isolation());
    if (mode === 'on') assert.equal(isolation.after, isolation.before, '独占脚本/动画目标应从已预取容器克隆，不得重新解析');
    const isolatedPixels = await pixels(page, mode + '-isolated');
    const cleaned = await page.evaluate(() => window.generatedCargoPreload.cleanup());
    const result = { mode, renderer, prepared, preparationRequests, first, firstPixels, transfer, transferredPixels, isolation, isolatedPixels, cleaned, requests };
    report.modes.push(result); report.requests.push(...requests.map(request => ({ mode, ...request }))); await save();
    await page.evaluate(() => window.generatedCargoPreload.dispose());
    return result;
  } catch (error) {
    await page.screenshot({ path: path.join(output, mode + '-failure.png') }).catch(() => undefined);
    report.failureMode = mode;
    report.failureState = await page.evaluate(() => window.generatedCargoPreload?.state()).catch(() => undefined);
    report.requests.push(...requests.map(request => ({ mode, ...request })));
    throw error;
  } finally { await context.close(); activePage = null; }
}

try {
  // Vite 会把 0 回退默认端口，因此先由操作系统分配空闲端口，再严格绑定。
  const probe = createPortProbe();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
  const available = probe.address(); assert.ok(available && typeof available === 'object');
  await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  server = await createServer({ server: { host: '127.0.0.1', port: available.port, strictPort: true, hmr: false },
    optimizeDeps: { noDiscovery: true }, logLevel: 'warn' });
  await server.listen(); await server.watcher.close();
  const address = server.httpServer.address(); assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}/`;
  const html = await server.transformIndexHtml('/__cargo_preload_smoke__', '<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"><script type="module" src="/tests/fixtures/generatedCargoPreload.harness.ts"></script></body></html>');
  browser = await chromium.launch({ channel: 'chrome', headless: true,
    args: ['--disable-features=LocalNetworkAccessChecks,LocalNetworkAccessChecksWebSockets'] });
  const baseline = await runMode('off', base, html);
  const preloaded = await runMode('on', base, html);
  assert.deepEqual(comparable(preloaded.first.summary), comparable(baseline.first.summary), '首次货物的几何、材质、位姿和点击元数据必须与关闭预取完全等价');
  assert.deepEqual(comparable(preloaded.transfer.summary), comparable(baseline.transfer.summary), '交接后的几何、材质、位姿必须等价');
  assert.equal(preloaded.firstPixels.sha256, baseline.firstPixels.sha256, '固定首件姿态必须产生完全相同的截图像素');
  assert.equal(preloaded.transferredPixels.sha256, baseline.transferredPixels.sha256, '固定交接末态必须产生完全相同的截图像素');
  assert.deepEqual(report.pageErrors, [], '真实浏览器不能带 pageerror 通过');
  report.status = 'PASS'; report.completedAt = new Date().toISOString(); await save();
  console.log(JSON.stringify({ status: report.status, output, renderer: preloaded.renderer,
    warmDecodeDelta: preloaded.first.after - preloaded.first.before, baselineDecodeDelta: baseline.first.after - baseline.first.before,
    checks: ['no-eager-cargo-or-script', 'deduplicated-real-GLB-prefetch', 'first-spawn-cache-hit', 'real-conveyor-driver-handoff',
      'stable-cargo-and-owner', 'click-host-metadata', 'parameter-and-animation-isolation', 'cleanup', 'identical-pixels'] }, null, 2));
} catch (error) {
  report.status = 'FAIL'; report.error = { message: error.message, stack: error.stack };
  if (activePage) await activePage.screenshot({ path: path.join(output, 'failure.png') }).catch(() => undefined);
  await save(); throw error;
} finally { await browser?.close(); await server?.close(); }
