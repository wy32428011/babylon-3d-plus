import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createServer } from 'vite';
import { chromium } from 'playwright';

// 隔离的真实 GLB/WebGL 对照；不打开业务工程，不替换参数脚本或修改资产。
const sourcePath = process.argv[2];
if (!sourcePath) throw new Error('用法：node scripts/smoke-model-template-cache.mjs <GLB绝对路径> [输出目录]');
const output = path.resolve(process.argv[3] ?? 'output/playwright/model-template-cache');
const bytes = await readFile(sourcePath);
const hash = createHash('sha256').update(bytes).digest('hex');
const html = `<!doctype html><html><body style="margin:0"><canvas id="canvas" style="width:960px;height:640px"></canvas>
<script type="module">
import { Engine, Scene, SceneLoader, FreeCamera, Vector3, HemisphericLight, VertexBuffer, Mesh } from '@babylonjs/core';
import '@babylonjs/loaders/glTF';
import { SharedModelAssetCache } from '/src/runtime/babylon/SharedModelAssetCache.ts';
import { AssetLoadScheduler } from '/src/runtime/babylon/AssetLoadScheduler.ts';
const canvas = document.getElementById('canvas');
const engine = new Engine(canvas, true, { preserveDrawingBuffer: true });
window.runModelBenchmark = async (optimized, count = 12) => {
  const scene = new Scene(engine);
  const cache = new SharedModelAssetCache();
  const scheduler = new AssetLoadScheduler(4);
  let reads = 0;
  const owned = [];
  try {
    const camera = new FreeCamera('camera', new Vector3(8, 6, -10), scene);
    new HemisphericLight('light', Vector3.Up(), scene);
    const loader = signal => scheduler.run(() => { reads++; return SceneLoader.LoadAssetContainerAsync('/', '__model-template.glb', scene); }, signal);
    const start = performance.now();
    await Promise.all(Array.from({ length: count }, async (_, index) => {
      const container = optimized ? await cache.acquireOwnedContainer('model:r1', loader) : await loader();
      owned[index] = container;
      container.addAllToScene();
    }));
    const loadMs = performance.now() - start;
    const bounds = scene.getWorldExtends();
    const center = bounds.min.add(bounds.max).scale(0.5);
    const radius = Math.max(1, bounds.max.subtract(bounds.min).length());
    camera.position.copyFrom(center.add(new Vector3(radius, radius * 0.7, -radius)));
    camera.setTarget(center);
    await scene.whenReadyAsync();
    scene.render();
    const totalMs = performance.now() - start;
    const textureObjects = new Set(owned.flatMap(container => container.meshes.flatMap(mesh => mesh.material?.getActiveTextures() ?? [])));
    const textureStorage = new Set([...textureObjects].map(texture => texture.getInternalTexture()).filter(Boolean));
    const meshes = owned.map(container => container.meshes.find(mesh => mesh instanceof Mesh && mesh.getTotalVertices() > 0));
    if (!meshes[0] || !meshes[1]) throw new Error('测试模型必须包含可渲染几何');
    const stats = container => ({
      vertices: container.meshes.reduce((sum, mesh) => sum + mesh.getTotalVertices(), 0),
      indices: container.meshes.reduce((sum, mesh) => sum + mesh.getTotalIndices(), 0),
      meshes: container.meshes.length, transformNodes: container.transformNodes.length,
      materials: new Set(container.meshes.map(mesh => mesh.material).filter(Boolean)).size,
      animationGroups: container.animationGroups.length,
      positions: container.meshes.filter(mesh => mesh.getTotalVertices() > 0).map(mesh =>
        Array.from(mesh.getVerticesData(VertexBuffer.PositionKind) ?? [])),
      matrices: container.meshes.map(mesh => Array.from(mesh.computeWorldMatrix(true).m)),
    });
    const firstStats = stats(owned[0]);
    const otherPosition = meshes[1].getVerticesData(VertexBuffer.PositionKind)[0];
    const positions = meshes[0].getVerticesData(VertexBuffer.PositionKind);
    positions[0] += 17;
    meshes[0].updateVerticesData(VertexBuffer.PositionKind, positions);
    if (meshes[1].getVerticesData(VertexBuffer.PositionKind)[0] !== otherPosition) throw new Error('参数顶点修改污染其它实体');
    owned[0].dispose();
    scene.render();
    if (meshes[1].isDisposed()) throw new Error('释放一个实体错误释放其它实体');
    for (const material of owned[1].materials) {
      if (material.getActiveTextures().some(texture => !texture.isReady())) throw new Error('释放实体导致其它纹理失效');
    }
    return { optimized, count, reads, loadMs, totalMs, textureObjects: textureObjects.size, textureStorage: textureStorage.size, metrics: cache.getMetrics(), stats: firstStats,
      renderer: engine.getGlInfo(), independentGeometry: true, independentRelease: true };
  } finally {
    for (const container of owned) container.dispose();
    scheduler.dispose(); cache.dispose(); scene.dispose();
  }
};
window.benchmarkReady = true;
</script></body></html>`;
const server = await createServer({ configFile: false, root: process.cwd(), cacheDir: path.join(output, '.vite-cache'), logLevel: 'error',
  optimizeDeps: { include: ['@babylonjs/core', '@babylonjs/loaders/glTF'] },
  server: { host: '127.0.0.1', port: 0, hmr: false }, plugins: [{ name: 'model-template-benchmark',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.url === '/__model-template-benchmark') {
          void server.transformIndexHtml(request.url, html).then(transformed => {
            response.setHeader('Content-Type', 'text/html'); response.end(transformed);
          }, error => { response.statusCode = 500; response.end(String(error)); });
        }
        else if (request.url === '/__model-template.glb') { response.setHeader('Content-Type', 'model/gltf-binary'); response.end(bytes); }
        else next();
      });
    } }] });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  const page = await browser.newPage({ viewport: { width: 960, height: 640 } });
  page.on('pageerror', error => console.error('页面错误:', error.message));
  page.setDefaultTimeout(120_000);
  await page.goto('http://127.0.0.1:' + server.httpServer.address().port + '/__model-template-benchmark');
  await page.waitForFunction(() => window.benchmarkReady);
  const samples = [];
  for (let round = 0; round < 3; round++) {
    for (const optimized of (round % 2 ? [true, false] : [false, true])) {
      const sample = await page.evaluate(optimized => window.runModelBenchmark(optimized), optimized);
      assert.equal(sample.reads, optimized ? 1 : 12);
      samples.push(sample);
      console.log(JSON.stringify({ round, optimized, reads: sample.reads, loadMs: sample.loadMs, totalMs: sample.totalMs }));
    }
  }
  for (const sample of samples) assert.deepEqual(sample.stats, samples[0].stats, '网格、顶点、材质与世界矩阵必须一致');
  const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const report = { scope: 'isolated-real-glb-webgl-12-independent-models', assetName: path.basename(sourcePath),
    bytes: bytes.length, sha256: hash, geometryAndMatricesPreserved: true,
    baselineMedianMs: median(samples.filter(s => !s.optimized).map(s => s.totalMs)),
    optimizedMedianMs: median(samples.filter(s => s.optimized).map(s => s.totalMs)),
    samples: samples.map(({ stats, ...sample }) => ({ ...sample, geometrySha256: createHash('sha256').update(JSON.stringify(stats)).digest('hex') })) };
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, 'result.json'), JSON.stringify(report, null, 2));
  assert.equal(createHash('sha256').update(await readFile(sourcePath)).digest('hex'), hash);
  console.log(JSON.stringify(report, null, 2));
} finally { await browser?.close(); await server.close(); }
