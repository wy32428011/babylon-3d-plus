/* global document */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { decodeLightingGeometryResource } from '../../electron/shared/sceneLightingBakeGeometryBinary.ts';

const root = path.resolve('output/render-optimization-q1-20261024/b7'), output = path.join(root, 'load-abba');
await fs.mkdir(output, { recursive: true });
const size = 512, count = (size + 1) ** 2;
let geometry = { version: 2, key: 'controlled-large-grid', positions: [], normals: [], uvs: [], bakeUvs: [], indices: [] };
for (let y = 0; y <= size; y++) for (let x = 0; x <= size; x++) {
  geometry.positions.push(x / size, y / size, 0); geometry.normals.push(0, 0, 1);
  geometry.uvs.push(x / size, y / size); geometry.bakeUvs.push(x / size, y / size);
}
for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
  const a = y * (size + 1) + x, b = a + 1, c = a + size + 1, d = c + 1;
  geometry.indices.push(a, b, c, c, b, d);
}
await fs.writeFile(path.join(output, 'large-grid.json'), JSON.stringify(geometry));
// eslint-disable-next-line no-useless-assignment -- 主动归还准备阶段的大型数字数组，供下一次GC回收。
geometry = null; globalThis.gc?.();
console.log(execFileSync('python', ['output/render-optimization-q1-20261024/b7/encode-large.py'], { encoding: 'utf8' }).trim());
const data = new Map([
  ['json', await fs.readFile(path.join(output, 'large-grid.json'))], ['binary-v1', await fs.readFile(path.join(output, 'large-grid.bin'))],
  ['png', await fs.readFile(path.join(root, 'real-cpu-comparison/candidate-atlas-0.png'))],
  ['probes', Buffer.from(JSON.stringify({ version: 1, encoding: 'ambient-cube', spacing: 1, probes: [{ position: [0, 0, 0], irradiance: Array(18).fill(.5) }] }))],
]);
const hashes = Object.fromEntries([...data].map(([id, bytes]) => [id, { byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }]));
let jsonCheck = JSON.parse(data.get('json').toString('utf8')), binaryCheck = decodeLightingGeometryResource(data.get('binary-v1'), 'binary-v1');
let comparedComponents = 0;
for (const field of ['positions', 'normals', 'uvs', 'bakeUvs', 'indices']) {
  assert.equal(jsonCheck[field].length, binaryCheck[field].length);
  for (let index = 0; index < jsonCheck[field].length; index++) { assert.ok(Object.is(jsonCheck[field][index], binaryCheck[field][index])); comparedComponents++; }
}
// eslint-disable-next-line no-useless-assignment -- 精度审计结束后主动释放大数组/视图强引用，不能跨正式样本保留。
jsonCheck = null; binaryCheck = null; globalThis.gc?.();
await fs.writeFile(path.join(output, 'input.json'), JSON.stringify({ source: 'controlled synthetic 512x512 dyadic grid, not factory/exhibition scene', vertices: count,
  triangles: size * size * 2, attributes: ['positions3', 'normals3', 'uvs2', 'bakeUvs2', 'indices1'], exactFloat32ByConstruction: true, comparedComponents, hashes }, null, 2));
const server = await createServer({ configFile: false, root: process.cwd(), cacheDir: path.join(output, 'vite-cache'), appType: 'custom',
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null }, optimizeDeps: { noDiscovery: true } });
server.middlewares.use('/__b7_load__', async (_request, response) => {
  response.setHeader('Content-Type', 'text/html'); response.end(await server.transformIndexHtml('/__b7_load__', '<!doctype html><title>B7 controlled load</title><canvas width="64" height="64"></canvas>'));
});
server.middlewares.use('/__b7_load_asset__', (request, response) => {
  const bytes = data.get(new URL(request.url, 'http://localhost').pathname.slice(1));
  response.setHeader('Cache-Control', 'no-store'); response.setHeader('Content-Length', String(bytes.length)); response.end(bytes);
});
const rows = [];
let browser;
try {
  await server.listen();
  for (const [label, encoding] of [['warm-A', 'json'], ['warm-B', 'binary-v1'], ['A1', 'json'], ['B1', 'binary-v1'], ['B2', 'binary-v1'], ['A2', 'json']]) {
    browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true,
      args: ['--enable-precise-memory-info', '--js-flags=--expose-gc'] });
    const page = await browser.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://127.0.0.1:' + server.httpServer.address().port + '/__b7_load__');
    // 每轮使用新浏览器/renderer；import和WebGL创建在计时前完成，GC与进程RSS记录保留。
    await page.evaluate(async () => {
      const [{ Engine }, { Scene }, { Mesh }, { VertexData }, { loadLightingResources }] = await Promise.all([
        import('/node_modules/@babylonjs/core/Engines/engine.js'), import('/node_modules/@babylonjs/core/scene.js'),
        import('/node_modules/@babylonjs/core/Meshes/mesh.js'), import('/node_modules/@babylonjs/core/Meshes/mesh.vertexData.js'),
        import('/src/runtime/babylon/lightingRuntimeResources.ts'),
      ]);
      const engine = new Engine(document.querySelector('canvas'), false);
      globalThis.b7 = { engine, scene: new Scene(engine), Mesh, VertexData, loadLightingResources };
      globalThis.gc?.();
    });
    const session = await browser.newBrowserCDPSession();
    const processIds = (await session.send('SystemInfo.getProcessInfo')).processInfo.filter(item => item.type === 'renderer').map(item => Number(item.id));
    assert.ok(processIds.length > 0 && processIds.every(Number.isSafeInteger));
    const memory = () => JSON.parse(execFileSync('powershell', ['-NoProfile', '-Command', 'Get-Process -Id ' + processIds.join(',') + ' | Select-Object Id,WorkingSet64,PeakWorkingSet64,PrivateMemorySize64 | ConvertTo-Json -Compress'], { encoding: 'utf8' }));
    const beforeProcessMemory = memory();
    const assets = [[encoding, 'geometry'], ['png', 'lightmap'], ['probes', 'probes']].map(([id, kind]) => ({ id, kind,
      url: '/__b7_load_asset__/' + id, ...hashes[id], ...(kind === 'geometry' ? { geometryVersion: 2, encoding } : { rgbmRange: 3 }) }));
    const row = await page.evaluate(async snapshot => {
      const state = globalThis.b7, stages = [];
      const sample = label => { stages.push({ label, usedJSHeapSize: performance.memory?.usedJSHeapSize ?? null }); };
      globalThis.gc?.(); sample('before');
      const started = performance.now();
      const resources = await state.loadLightingResources(snapshot, state.scene);
      const loadMs = performance.now() - started; sample('after-read-sha-decode-validate-texture');
      const geometry = resources.geometries.get(snapshot.assets[0].id);
      let digest = 2166136261;
      for (const channel of ['positions', 'normals', 'uvs', 'bakeUvs', 'indices']) for (const value of geometry[channel]) digest = Math.imul(digest ^ Math.round(value * 1048576), 16777619) >>> 0;
      const mesh = new state.Mesh('b7-large', state.scene), vertexData = new state.VertexData();
      vertexData.positions = geometry.positions; vertexData.normals = geometry.normals; vertexData.uvs = geometry.uvs; vertexData.indices = geometry.indices;
      const applyStarted = performance.now(); vertexData.applyToMesh(mesh, false); mesh.setVerticesData('lightmapUv', geometry.bakeUvs, false, 2);
      const applyMs = performance.now() - applyStarted; sample('after-vertexdata-gpu-upload');
      const buffers = new Set(Object.values(geometry).filter(value => ArrayBuffer.isView(value)).map(value => value.buffer));
      const backingBytes = [...buffers].reduce((sum, buffer) => sum + buffer.byteLength, 0);
      const result = { loadMs, applyMs, measuredMs: loadMs + applyMs, digest, vertices: mesh.getTotalVertices(), indices: mesh.getTotalIndices(),
        bounds: [mesh.getBoundingInfo().boundingBox.minimum.asArray(), mesh.getBoundingInfo().boundingBox.maximum.asArray()],
        geometryBackingArrayBufferBytes: backingBytes, stages, gcAvailable: typeof globalThis.gc === 'function', glInfo: state.engine.getGlInfo() };
      globalThis.b7Hold = { resources, mesh, vertexData }; return result;
    }, { version: 1, signature: 'controlled-load', createdAt: '2026-10-24T00:00:00Z', engineVersion: 'controlled fixture', assets,
      surfaces: [{ key: 'a/root', entityId: 'a', nodeKey: 'root', geometryAssetId: encoding, lightmapAssetId: 'png' }], probeAssetId: 'probes',
      statistics: { meshCount: 1, triangleCount: size * size * 2, atlasCount: 1, probeCount: 1, textureBytes: 1024 ** 2 * 4, durationMs: 0 } });
    const heldProcessMemory = memory();
    await page.evaluate(() => { globalThis.b7Hold.resources.dispose(); globalThis.b7Hold.mesh.dispose(); globalThis.b7Hold = null; globalThis.b7.scene.dispose(); globalThis.b7.engine.dispose(); globalThis.b7 = null; globalThis.gc?.(); });
    const afterDisposeProcessMemory = memory();
    assert.deepEqual(errors, []); assert.equal(row.vertices, count); assert.equal(row.indices, size * size * 6); assert.equal(row.gcAvailable, true);
    assert.doesNotMatch(row.glInfo.renderer, /swiftshader|llvmpipe|software/i);
    if (rows.length) { assert.equal(row.digest, rows[0].digest); assert.deepEqual(row.bounds, rows[0].bounds); }
    const record = { label, encoding, ...row, beforeProcessMemory, heldProcessMemory, afterDisposeProcessMemory, processIds,
      peakDefinition: 'isolated fresh Chrome renderer lifetime PeakWorkingSet64, prefix/import baseline recorded; includes external ArrayBuffer/native/GPU host allocations. Stage JS heap samples are observed lower bound, not total memory.' };
    rows.push(record); await fs.writeFile(path.join(output, label + '.json'), JSON.stringify(record, null, 2));
    console.log('B7_LOAD_ROW ' + JSON.stringify({ label, encoding, loadMs: row.loadMs, applyMs: row.applyMs, heldProcessMemory }));
    await browser.close(); browser = null;
  }
  const average = (encoding, key) => rows.filter(row => !row.label.startsWith('warm') && row.encoding === encoding).reduce((sum, row) => sum + row[key], 0) / 2;
  const baseline = average('json', 'measuredMs'), candidate = average('binary-v1', 'measuredMs');
  const report = { status: 'PASS', scope: 'Controlled large GI-resource fixture; real browser production HTTP read/SHA/decoder/Texture/VertexData GPU upload; not business-scene FPS or factory coverage.',
    meanMs: { baseline, candidate, changePercent: (candidate / baseline - 1) * 100 }, hashes, rows };
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log('B7_LOAD_ABBA_PASS ' + JSON.stringify(report.meanMs));
} finally { await browser?.close(); await server.close(); }
