/* global window */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { mkdir, writeFile, readdir, readFile, lstat } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { build } from 'vite';
import { chromium } from 'playwright';

const valueOf = name => process.argv.find(value => value.startsWith(name + '='))?.slice(name.length + 1);
const performanceMode = process.argv.includes('--performance');
const label = valueOf('--label') ?? ((performanceMode ? 'abba-' : 'semantics-') + Date.now());
assert.match(label, /^[a-zA-Z0-9_-]+$/);
const cargoModelPath = valueOf('--cargo-model');
if (cargoModelPath) assert.ok(path.isAbsolute(cargoModelPath), '--cargo-model必须是绝对GLB路径');
const cycles = Number(valueOf('--cycles') ?? (performanceMode ? 100 : 12));
assert.ok(Number.isSafeInteger(cycles) && cycles > 0 && cycles <= 1000, '--cycles必须是1到1000的整数');
const output = path.resolve('output/render-optimization-q1-20261024/ld5', label);
// 每轮必须新目录；拒绝覆盖旧失败、源码归档或正式原始数据。
await mkdir(path.dirname(output), { recursive: true });
await mkdir(output);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const files = [
  'src/runtime/babylon/scene-runtime/GeneratedCargoInstancePool.ts',
  'src/runtime/babylon/scene-runtime/GeneratedModelOutputController.ts',
  'src/runtime/babylon/effects/TargetModelEffects.ts',
  'src/runtime/babylon/SceneRuntime.ts', 'src/runtime/babylon/SharedModelAssetCache.ts',
  'src/runtime/babylon/scene-runtime/ModelAssetRuntimeController.ts',
  'src/runtime/babylon/scene-runtime/SceneTriangleAndReadinessController.ts',
  'src/runtime/babylon/SceneLoadDiagnostics.ts', 'src/runtime/babylon/gpuCapabilityProfile.ts',
  'src/runtime/babylon/SceneShaderWarmup.ts', 'src/runtime/babylon/scene-runtime/SceneTelemetryController.ts',
  'src/runtime/babylon/localDecoderConfiguration.ts', 'src/runtime/babylon/ktx2WorkerDecoder.ts',
  'tests/fixtures/generatedCargoPool.harness.ts', 'tests/runtime/generatedCargoPool.webgl.mjs',
  'package.json', 'package-lock.json',
];
const hashes = () => Object.fromEntries(files.map(file => [file, digest(readFileSync(file))]));
const dependencies = Object.fromEntries(['@babylonjs/core', '@babylonjs/loaders', '@babylonjs/ktx2decoder', 'vite', 'playwright', 'typescript', 'react', 'zustand']
  .map(name => [name, JSON.parse(readFileSync(path.join('node_modules', name, 'package.json'), 'utf8')).version]));
const report = { status: 'RUNNING', performanceMode, cycles, startedAt: new Date().toISOString(), sourceHashes: hashes(), dependencies,
  boundary: '真实Chrome/WebGL2+SceneRuntime+GLB加载+正式telemetry store/conveyor driver的固定50ms夹具。可选业务货物GLB保持原字节；输送机仍为合成box，未连接真实MQTT broker/完整生产工厂/发布Viewer。',
  metricScope: 'replay/window为包含等待、材质就绪、固定姿态/geometry/material/pick采样、渲染与排队的墙钟；longtask只计正式窗口交集。clone计数/cloneMs/Pool.resetMs为组成项，均不能单独称净生成CPU成本或业务FPS收益。未包装生产生成/退役方法，未改变Promise身份。',
  modes: [], warmups: [], errors: [], requests: [], cleanup: [] };
const save = () => writeFile(path.join(output, 'results.json'), JSON.stringify(report, null, 2));
let browser, server;

try {
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

// 只读GLB资格审计；绝不修模型、改动画/脚本、重缩放以追求池命中。
function auditGlb(bytes, sourcePath) {
  assert.ok(bytes.length >= 20 && bytes.readUInt32LE(0) === 0x46546c67 && bytes.readUInt32LE(4) === 2, '货物必须是GLB v2');
  assert.equal(bytes.readUInt32LE(8), bytes.length, 'GLB length必须完整');
  const chunks = []; let json, offset = 12;
  while (offset < bytes.length) {
    assert.ok(offset + 8 <= bytes.length); const length = bytes.readUInt32LE(offset), type = bytes.readUInt32LE(offset + 4);
    assert.ok(length % 4 === 0 && offset + 8 + length <= bytes.length, 'GLB chunk边界错误');
    chunks.push({ type, bytes: length });
    if (type === 0x4e4f534a) { assert.equal(json, undefined, 'GLB重复JSON'); json = JSON.parse(bytes.subarray(offset + 8, offset + 8 + length).toString('utf8')); }
    offset += 8 + length;
  }
  assert.ok(json); const external = [];
  for (const [kind, resources] of [['buffer', json.buffers ?? []], ['image', json.images ?? []]]) for (const [index, resource] of resources.entries()) {
    if (!resource.uri) continue;
    if (/^data:/i.test(resource.uri)) { external.push({ kind, index, embeddedData: true, bytes: resource.uri.length }); continue; }
    assert.ok(sourcePath, '默认合成GLB不能引用外部资源');
    assert.equal(typeof resource.uri, 'string');
    assert.ok(!/^[a-z][a-z0-9+.-]*:|^\/|[\\?#]/i.test(resource.uri), 'GLB额外资源必须是无query/fragment的本地相对URI，禁止外网');
    const relative = decodeURIComponent(resource.uri), root = realpathSync(path.dirname(sourcePath));
    assert.ok(!relative.includes('\0') && !relative.includes('\\') && !path.isAbsolute(relative));
    const physical = realpathSync(path.resolve(root, relative)), delta = path.relative(root, physical);
    assert.ok(delta && !delta.startsWith('..') && !path.isAbsolute(delta), 'GLB额外资源越过模型目录');
    assert.ok(statSync(physical).isFile());
    external.push({ kind, index, uri: resource.uri, relative, sourcePath: physical, bytes: statSync(physical).size, sha256: digest(readFileSync(physical)) });
  }
  return { sourcePath: sourcePath ?? null, sha256: digest(bytes), bytes: bytes.length, chunks, asset: json.asset,
    animations: json.animations?.length ?? 0, skins: json.skins?.length ?? 0,
    morphPrimitiveCount: (json.meshes ?? []).flatMap(mesh => mesh.primitives ?? []).filter(primitive => primitive.targets?.length).length,
    extensionsUsed: json.extensionsUsed ?? [], extensionsRequired: json.extensionsRequired ?? [], external,
    imageResources: (json.images ?? []).map(({ name, mimeType, bufferView, uri }) => ({ name, mimeType, bufferView, uri: uri?.startsWith('data:') ? 'data:embedded' : uri })),
    nodes: json.nodes ?? [],
    positionBounds: (json.meshes ?? []).flatMap(mesh => (mesh.primitives ?? []).map(primitive => {
      const accessor = json.accessors?.[primitive.attributes?.POSITION];
      return { mesh: mesh.name ?? null, vertices: accessor?.count, min: accessor?.min, max: accessor?.max,
        indices: json.accessors?.[primitive.indices]?.count, mode: primitive.mode ?? 4 };
    })),
    units: 'glTF坐标；fixture保留既有meter/unitScaleToMeters=1，未改节点transform或模型字节。',
  };
}

const servedAssets = new Map();
if (cargoModelPath) glbs['cargo.glb'] = readFileSync(cargoModelPath);
report.cargoModel = { businessInput: Boolean(cargoModelPath), ...auditGlb(glbs['cargo.glb'], cargoModelPath) };
for (const [name, bytes] of Object.entries(glbs)) servedAssets.set('/__cargo_preload__/' + name, bytes);
servedAssets.set('/__cargo_preload__/cargo.model.ts', Buffer.from(scriptSource));
servedAssets.set('/__cargo_preload__/cargo.model.ts.compiled.json', Buffer.from(compiledScript));
const modelInputFiles = new Map();
if (cargoModelPath) modelInputFiles.set(cargoModelPath, report.cargoModel.sha256);
for (const resource of report.cargoModel.external) if (resource.sourcePath) {
  const url = new URL(resource.uri, 'http://fixture/__cargo_preload__/cargo.glb');
  const key = decodeURIComponent(url.pathname), bytes = readFileSync(resource.sourcePath);
  assert.ok(!servedAssets.has(key), 'GLB资源URI冲突'); servedAssets.set(key, bytes); modelInputFiles.set(resource.sourcePath, resource.sha256);
}
await writeFile(path.join(output, 'cargo-model-audit.json'), JSON.stringify(report.cargoModel, null, 2));
const workspace = process.cwd(), site = path.join(output, 'site'), archive = path.join(output, 'archive');
await mkdir(site); await mkdir(archive); const sourceSnapshots = new Map();
function snapshotSource(file, loadedCode) {
  const relative = path.relative(workspace, file).replaceAll('\\', '/');
  if (relative.startsWith('../') || path.isAbsolute(relative)) return;
  const bytes = readFileSync(file), sha256 = digest(bytes), previous = sourceSnapshots.get(relative);
  if (previous) { assert.equal(previous.sha256, sha256, 'build期间源码漂移：' + relative); if (loadedCode !== undefined) previous.loadedCodeSha256.add(digest(loadedCode)); }
  else sourceSnapshots.set(relative, { bytes, sha256, loadedCodeSha256: new Set(loadedCode === undefined ? [] : [digest(loadedCode)]) });
}
for (const file of files) snapshotSource(path.resolve(file));
const sourceArchivePlugin = { name: 'cargo-pool-source-evidence', enforce: 'pre',
  transform(code, id) {
    const file = id.split('?')[0];
    if (path.isAbsolute(file) && /[\\/](?:src|electron|tests)[\\/]/.test(file) && !file.includes('/node_modules/') && !file.includes('\\node_modules\\')) snapshotSource(file, code);
    return null;
  } };
// 单次build生成完整固定模块图；六臂只运行该site，不从dev server取活动源码。
await build({ configFile: false, root: workspace, base: './', publicDir: false, logLevel: 'warn', plugins: [sourceArchivePlugin],
  build: { outDir: site, emptyOutDir: false, rollupOptions: { input: path.resolve('tests/fixtures/generatedCargoPool.harness.ts'), output: { entryFileNames: 'fixture.js' } } } });
for (const [relative, record] of sourceSnapshots) {
  const target = path.join(archive, 'sources', relative); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, record.bytes);
}
const sourceManifest = [...sourceSnapshots].map(([file, record]) => ({ file, sha256: record.sha256, bytes: record.bytes.length, loadedCodeSha256: [...record.loadedCodeSha256] }));
await writeFile(path.join(output, 'source-archive.json'), JSON.stringify(sourceManifest, null, 2));
const copiedInputs = new Map();
async function copyDecoderTree(directory, relative = '') {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const source = path.join(directory, entry.name), name = path.posix.join(relative, entry.name);
    assert.ok(!(await lstat(source)).isSymbolicLink(), 'decoder归档拒绝符号链接');
    if (entry.isDirectory()) await copyDecoderTree(source, name);
    else { const bytes = await readFile(source), target = path.join(site, 'babylon-decoders', name); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, bytes); copiedInputs.set(source, digest(bytes)); }
  }
}
await copyDecoderTree(path.resolve('public/babylon-decoders'));
for (const [url, bytes] of servedAssets) {
  const target = path.join(site, url.slice(1)); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, bytes);
}
const mime = file => file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.wasm') ? 'application/wasm'
  : file.endsWith('.json') ? 'application/json' : file.endsWith('.glb') ? 'model/gltf-binary' : /\.png$/i.test(file) ? 'image/png' : /\.jpe?g$/i.test(file) ? 'image/jpeg' : 'application/octet-stream';
const frozen = new Map();
async function freezeSite(directory, relative = '') {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name), key = path.posix.join(relative, entry.name);
    assert.ok(!(await lstat(file)).isSymbolicLink());
    if (entry.isDirectory()) await freezeSite(file, key); else frozen.set('/' + key, { file, bytes: await readFile(file) });
  }
}
await freezeSite(site);
report.bundle = [...frozen].map(([url, { bytes }]) => ({ url, bytes: bytes.length, sha256: digest(bytes) }));
report.modelInputHashes = Object.fromEntries(modelInputFiles); report.decoderInputHashes = Object.fromEntries(copiedInputs);
report.sourceArchive = sourceManifest; await writeFile(path.join(output, 'executed-assets.json'), JSON.stringify(report.bundle, null, 2));
function assertFrozenInputs() {
  assert.deepEqual(hashes(), report.sourceHashes, '顶层源码不能漂移');
  for (const [file, record] of sourceSnapshots) assert.equal(digest(readFileSync(file)), record.sha256, '模块源码漂移：' + file);
  for (const [file, sha256] of [...modelInputFiles, ...copiedInputs]) assert.equal(digest(readFileSync(file)), sha256, 'GLB/decoder输入漂移：' + file);
  for (const { file, bytes } of frozen.values()) assert.equal(digest(readFileSync(file)), digest(bytes), '执行bundle/asset磁盘漂移：' + file);
}
assertFrozenInputs(); await save();

function comparable(result) {
  const ownerIds = new Map(result.births.map(row => [row.ownerId, 'logical-' + row.cycle]));
  const normalizeSummary = ({ cargoId: _cargoId, ownerId, ...summary }) => ({ ...summary, ownerId: ownerIds.get(ownerId),
    meshes: summary.meshes.map(({ id: _id, ...mesh }) => mesh) });
  return { cycles: result.cycles, rows: result.rows.map(row => ({ ...row, summary: normalizeSummary(row.summary) })),
    births: result.births.map(({ ownerId, cargoId: _cargoId, meshIds: _meshIds, modelCloneCount: _clones, clickFirst, modelRoot, contentRoot, ...row }) => ({ ...row,
      modelRoot: modelRoot.replace(ownerId, ownerIds.get(ownerId)), contentRoot: contentRoot.replace(ownerId, ownerIds.get(ownerId)),
      clickFirst: { ...clickFirst, highlightEntityId: ownerIds.get(clickFirst.highlightEntityId) } })) };
}
async function run(label, enabled, base, formal = true) {
  const context = await browser.newContext({ viewport: { width: 1100, height: 720 }, deviceScaleFactor: 1 });
  const page = await context.newPage(); const errors = [], requests = [], external = [];
  let bodyFailed = false;
  page.on('pageerror', error => errors.push(error.message));
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (['http:', 'https:'].includes(url.protocol) && url.origin !== new URL(base).origin) { external.push(url.href); return route.abort(); }
    return route.continue();
  });
  page.on('response', response => { const url = new URL(response.url()); requests.push({ path: url.pathname, query: url.search, status: response.status() }); });
  try {
    await page.goto(base + '__cargo_pool_smoke__?pool=' + (enabled ? 'on' : 'off'), { waitUntil: 'commit' });
    await page.waitForFunction(() => Boolean(window.generatedCargoPool), null, { timeout: 120_000 });
    const renderer = await page.evaluate(() => window.generatedCargoPool.renderer());
    assert.equal(renderer.webGLVersion, 2); assert.doesNotMatch(renderer.renderer, /swiftshader|llvmpipe|software|microsoft basic render/i);
    await page.evaluate(() => window.generatedCargoPool.prepare());
    await page.evaluate(() => {
      window.poolLongTasks = [];
      window.poolLongTaskObserver = new PerformanceObserver(list => window.poolLongTasks.push(...list.getEntries().map(entry => ({ startTime: entry.startTime, duration: entry.duration }))));
      window.poolLongTaskObserver.observe({ entryTypes: ['longtask'] });
    });
    const measured = await page.evaluate(async ({ cycles, classify }) => {
      let replay, replayError; const start = performance.now();
      try { replay = await window.generatedCargoPool.replay(cycles, 12, classify); }
      catch (error) { replayError = { message: error.message, stack: error.stack }; replay = window.generatedCargoPool.replayProgress(); }
      const end = performance.now(); await new Promise(resolve => setTimeout(resolve, 0));
      window.poolLongTasks.push(...window.poolLongTaskObserver.takeRecords().map(entry => ({ startTime: entry.startTime, duration: entry.duration })));
      window.poolLongTaskObserver.disconnect();
      const tasks = window.poolLongTasks.map(entry => ({ ...entry, clippedMs: Math.max(0, Math.min(end, entry.startTime + entry.duration) - Math.max(start, entry.startTime)) })).filter(entry => entry.clippedMs > 0);
      return { result: replay && { ...replay, window: { start, end, duration: end - start }, tasks, longtaskMs: tasks.reduce((sum, task) => sum + task.clippedMs, 0) }, replayError };
    }, { cycles, classify: !performanceMode });
    const result = measured.result;
    // 原始结果（包括guard拒绝/半途错误）先持久化，再执行资格/收益断言。
    await writeFile(path.join(output, label + '-replay-raw.json'), JSON.stringify({ label, enabled, formal, renderer, ...measured, requests, errors, external }, null, 2));
    if (measured.replayError) throw new Error(measured.replayError.stack ?? measured.replayError.message);
    assert.equal(result.births.length, cycles);
    assert.equal(result.after.poolMetrics.hits, enabled ? result.cycles - 1 : 0, '业务模型guard不适配须保留失败/原因分布，不改模型追命中');
    const newClones = result.after.cacheMetrics.instantiationCount - result.before.cacheMetrics.instantiationCount;
    assert.equal(newClones, enabled ? 1 : result.cycles, '实际SharedCache instantiation应与池命中对应');
    const pixels = {};
    if (!performanceMode) {
      await page.evaluate(() => window.generatedCargoPool.firstCargo());
      pixels.first = digest(await page.locator('canvas').screenshot({ path: path.join(output, label + '-first.png') }));
      await page.evaluate(() => window.generatedCargoPool.transfer());
      pixels.transfer = digest(await page.locator('canvas').screenshot({ path: path.join(output, label + '-transfer.png') }));
      await page.evaluate(() => window.generatedCargoPool.isolation());
    }
    const cleaned = await page.evaluate(() => window.generatedCargoPool.cleanup());
    assert.equal(cleaned.cargoCount, 0); assert.equal(cleaned.cargoMeshCount, 0); assert.equal(cleaned.ownerCount, 0);
    assert.deepEqual(errors, []); assert.deepEqual(external, []); assertFrozenInputs();
    const item = { label, enabled, formal, renderer, result, newClones, pixels, cleaned, requests, errors, external };
    await writeFile(path.join(output, label + '.json'), JSON.stringify(item, null, 2));
    (formal ? report.modes : report.warmups).push(item); await save(); return item;
  } catch (error) {
    bodyFailed = true;
    report.failureState = await page.evaluate(() => window.generatedCargoPool?.state()).catch(() => null);
    report.failureReplay = await page.evaluate(() => window.generatedCargoPool?.replayProgress()).catch(() => null);
    await writeFile(path.join(output, label + '-failure-raw.json'), JSON.stringify({ label, enabled, formal, state: report.failureState, replay: report.failureReplay, requests, errors, external, error: { message: error.message, stack: error.stack } }, null, 2));
    report.failureMode = label; await save(); throw error;
  } finally {
    // 两项都尝试清理，保留失败；不能用空catch把dispose错误变成PASS。
    const cleanupErrors = [];
    try { await page.evaluate(() => window.generatedCargoPool?.dispose()); } catch (error) { cleanupErrors.push(error); }
    try { await context.close(); } catch (error) { cleanupErrors.push(error); }
    report.cleanup.push({ label, scope: 'runtime-and-context', failures: cleanupErrors.map(error => String(error)) }); await save();
    if (cleanupErrors.length && !bodyFailed) throw new AggregateError(cleanupErrors, '本臂资源清理失败');
  }
}

const html = '<!doctype html><html><head><meta charset="utf-8"><base href="/"></head><body style="margin:0"><script type="module" src="/fixture.js"></script></body></html>';
report.executedHtml = { file: 'served-fixture.html', sha256: digest(html), bytes: Buffer.byteLength(html) };
report.queryRepresentations = [{ path: '/__cargo_preload__/cargo.model.ts?modelScriptCompiled', bytes: Buffer.byteLength(compiledScript), sha256: digest(compiledScript) }];
await writeFile(path.join(output, 'served-fixture.html'), html);
try {
  server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url, 'http://fixture'); response.setHeader('Cache-Control', 'no-store');
      if (url.pathname === '/__cargo_pool_smoke__') { response.setHeader('Content-Type', 'text/html'); response.end(html); return; }
      if (url.pathname === '/favicon.ico') { response.writeHead(204).end(); return; }
      const key = decodeURIComponent(url.pathname);
      const record = frozen.get(key);
      if (!record || key.includes('\0') || key.includes('\\')) { response.writeHead(404).end(); return; }
      const bytes = key === '/__cargo_preload__/cargo.model.ts' && url.searchParams.has('modelScriptCompiled') ? Buffer.from(compiledScript) : record.bytes;
      response.setHeader('Content-Type', mime(key)); response.setHeader('Content-Length', bytes.length); response.end(bytes);
    })().catch(error => { response.writeHead(500).end(String(error)); });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--disable-features=LocalNetworkAccessChecks,LocalNetworkAccessChecksWebSockets'] });
  const base = 'http://127.0.0.1:' + server.address().port + '/'; report.origin = base; await save();
  if (performanceMode) {
    await run('warmup-A', false, base, false); await run('warmup-B', true, base, false);
    for (const [arm, enabled] of [['A1', false], ['B1', true], ['B2', true], ['A2', false]]) await run(arm, enabled, base);
    assert.equal(report.modes.length, 4); assert.equal(report.warmups.length, 2);
    report.performanceSummary = Object.fromEntries([false, true].map(enabled => {
      const arms = report.modes.filter(row => row.enabled === enabled);
      return [enabled ? 'poolOn' : 'poolOff', { labels: arms.map(row => row.label), replayWallMs: arms.reduce((sum, row) => sum + row.result.elapsedMs, 0) / arms.length,
        formalWindowWallMs: arms.reduce((sum, row) => sum + row.result.window.duration, 0) / arms.length, clippedLongtaskMs: arms.reduce((sum, row) => sum + row.result.longtaskMs, 0) / arms.length,
        cloneCounts: arms.map(row => row.newClones), resetMs: arms.map(row => row.result.after.poolMetrics.resetMs) }];
    }));
  } else {
    await run('A', false, base); await run('B', true, base);
    assert.deepEqual(comparable(report.modes[1].result), comparable(report.modes[0].result), '每时刻位姿/geometry/material/nodeKey/role/逻辑点击身份必须相同');
    assert.deepEqual(report.modes[1].pixels, report.modes[0].pixels, '首件及交接末态截图必须逐字节一致');
  }
  assertFrozenInputs(); report.status = 'PASS'; report.completedAt = new Date().toISOString(); await save();
  console.log(JSON.stringify({ status: report.status, output, businessInput: report.cargoModel.businessInput, modes: report.modes.map(row => ({ label: row.label, clones: row.newClones, pool: row.result.after.poolMetrics, replayWallMs: row.result.elapsedMs, clippedLongtaskMs: row.result.longtaskMs })) }, null, 2));
} catch (error) { report.status = 'FAIL'; report.error = { message: error.message, stack: error.stack }; await save(); throw error; }
finally {
  const releases = await Promise.allSettled([browser?.close(), server?.listening ? new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) : undefined]);
  const failures = releases.filter(result => result.status === 'rejected').map(result => result.reason);
  report.cleanup.push({ scope: 'browser-and-server', failures: failures.map(error => String(error)) }); await save();
  if (failures.length) throw new AggregateError(failures, '本轮browser/server清理失败');
}

} catch (error) {
  report.status = 'FAIL'; report.failurePhase = report.origin ? 'execution' : 'preparation';
  report.error = { message: error.message, stack: error.stack }; await save(); throw error;
}

