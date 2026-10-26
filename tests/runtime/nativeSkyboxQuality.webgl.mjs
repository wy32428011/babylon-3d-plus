/* global document, window, performance, requestAnimationFrame */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { startSkyboxViteServer } from '../helpers/skyboxViteServer.mjs';

/**
 * R11：画质与成本证据（真实 GPU，不使用 NullEngine/Mock）。
 * 对照 A 只比较“编码”：同一 Engine/Scene/相机/曝光，将内存中的预过滤立方体与其导出再重载的 .env 逐像素比较。
 * 误差预算在运行本脚本之前冻结（单位：8 位通道值 0–255），不依据结果调整：
 */
const BUDGET = {
  sky: { meanAbs: 1.5, p99Max: 8 },
  ibl: { meanAbs: 2.5, p99Max: 12 },
};
const output = path.resolve('output/native-skybox-implementation-20261025/quality');
await mkdir(output, { recursive: true });
const SOURCE_SHA = 'b35653ca75a00d75392649d29cd27001e5af79dcc6412aa557241bb3ecda1420';
const vite = await startSkyboxViteServer();
const browser = await chromium.launch({ executablePath: process.env.SKYBOX_TEST_BROWSER ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const watchdog = setTimeout(() => { console.error('画质/性能验证超过 20 分钟，关闭本次浏览器。'); void browser.close(); }, 1_200_000);
const errors = [];
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * fraction))];

async function openPage() {
  const page = await browser.newPage({ viewport: { width: 640, height: 480 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${vite.origin}/tests/fixtures/nativeSkybox.harness.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__skyboxModulesReady === true);
  await page.waitForLoadState('networkidle');
  return page;
}

// 一次编译：返回阶段耗时，必要时在两份纹理仍存活时做画质对照。
const compileOnce = (page, faceSize, compare) => page.evaluate(async ({ origin, faceSize, compare, sourceSha }) => {
  const { compileSkyboxEnvironment, CreateBox, Texture, PBRMaterial, CreateSphere, ArcRotateCamera, Vector3 } = window.__skyboxModules;
  const contract = window.__skyboxContract;
  const started = performance.now(), stages = [];
  let comparison = null;
  const diagnostics = compare ? { onTextures: async ({ prefiltered, reloaded, engine, scene }) => {
    engine.setSize(480, 320);
    const camera = new ArcRotateCamera('quality-camera', 0, Math.PI / 2, 0.01, Vector3.Zero(), scene);
    camera.fov = 1.0; camera.minZ = 0.01; camera.maxZ = 5000; scene.activeCamera = camera;
    const skyMesh = CreateBox('quality-sky', { size: 1000 }, scene);
    skyMesh.infiniteDistance = true; skyMesh.isPickable = false;
    const skyMaterial = new PBRMaterial('quality-sky-material', scene);
    skyMaterial.backFaceCulling = false; skyMaterial.microSurface = 1; skyMaterial.disableLighting = true; skyMesh.material = skyMaterial;
    const spheres = [0.05, 0.4, 0.9].map((roughness, index) => {
      const sphere = CreateSphere(`quality-sphere-${index}`, { diameter: 1.2 }, scene);
      const material = new PBRMaterial(`quality-sphere-material-${index}`, scene); material.metallic = 1; material.roughness = roughness;
      sphere.material = material; sphere.position.set((index - 1) * 1.5, 0, 6); sphere.setEnabled(false); return sphere;
    });
    const read = async () => {
      await scene.whenReadyAsync();
      for (let index = 0; index < 3; index++) scene.render();
      const width = engine.getRenderWidth(), height = engine.getRenderHeight();
      return { width, height, data: new Uint8Array((await engine.readPixels(0, 0, width, height)).buffer.slice(0)) };
    };
    const useTexture = texture => { texture.coordinatesMode = Texture.SKYBOX_MODE; skyMaterial.reflectionTexture = texture; scene.environmentTexture = texture; };
    const capture = async (label, yaw, pitch, withSpheres) => {
      const result = {};
      for (const [name, texture] of [['prefiltered', prefiltered], ['reloaded', reloaded]]) {
        useTexture(texture);
        skyMesh.setEnabled(!withSpheres); spheres.forEach(sphere => sphere.setEnabled(withSpheres));
        // 每次渲染都完整指定相机状态，避免上一份纹理的渲染改变构图。
        if (withSpheres) { camera.target = new Vector3(0, 0, 6); camera.radius = 8; camera.alpha = -Math.PI / 2; camera.beta = Math.PI / 2; }
        else { camera.target = Vector3.Zero(); camera.radius = 0.01; camera.alpha = yaw; camera.beta = Math.PI / 2 - pitch; }
        result[name] = await read();
      }
      const a = result.prefiltered.data, b = result.reloaded.data, diffs = [];
      let total = 0, maxDiff = 0, count = 0;
      for (let index = 0; index < a.length; index += 4) {
        let worst = 0;
        for (let channel = 0; channel < 3; channel++) { const diff = Math.abs(a[index + channel] - b[index + channel]); total += diff; worst = Math.max(worst, diff); }
        diffs.push(worst); maxDiff = Math.max(maxDiff, worst); count += 3;
      }
      const thirds = [0, 1, 2].map(part => {
        const width = result.prefiltered.width, height = result.prefiltered.height; let sum = 0, n = 0, peak = 0;
        for (let y = 0; y < height; y++) for (let x = Math.floor(width * part / 3); x < Math.floor(width * (part + 1) / 3); x++) {
          const index = (y * width + x) * 4;
          for (let channel = 0; channel < 3; channel++) { const diff = Math.abs(a[index + channel] - b[index + channel]); sum += diff; n++; peak = Math.max(peak, diff); }
        }
        return { meanAbs: sum / n, peak };
      });
      const toPng = frame => {
        const canvas2d = document.createElement('canvas'); canvas2d.width = frame.width; canvas2d.height = frame.height;
        const context2d = canvas2d.getContext('2d'), image = context2d.createImageData(frame.width, frame.height);
        for (let y = 0; y < frame.height; y++) image.data.set(frame.data.subarray((frame.height - 1 - y) * frame.width * 4, (frame.height - y) * frame.width * 4), y * frame.width * 4);
        context2d.putImageData(image, 0, 0); return canvas2d.toDataURL('image/png').split(',')[1];
      };
      const images = withSpheres || label === 'yaw0' ? { prefiltered: toPng(result.prefiltered), reloaded: toPng(result.reloaded) } : null;
      diffs.sort((x, y) => x - y);
      return { label, kind: withSpheres ? 'ibl' : 'sky', meanAbs: total / count, p99Max: diffs[Math.floor(diffs.length * 0.99)], maxDiff,
        pixels: diffs.length, mean: Array.from(a.subarray(0, 4)), thirds, images };
    };
    comparison = [];
    for (const [label, yaw, pitch] of [['yaw0', 0, 0.2], ['yaw90', Math.PI / 2, 0.2], ['yaw180', Math.PI, 0.2], ['yaw270', -Math.PI / 2, 0.2], ['up', 0.5, 1.1], ['down', 0.5, -0.9]]) {
      comparison.push(await capture(label, yaw, pitch, false));
    }
    comparison.push(await capture('metal-spheres', 0, 0, true));
    skyMesh.dispose(); spheres.forEach(sphere => sphere.dispose());
  } } : undefined;
  const bytes = await compileSkyboxEnvironment({ token: 'quality', sourceUrl: `${origin}/builtin-skyboxes/partly-cloudy-light/partly-cloudy-light.hdr`,
    sourceSha256: sourceSha, sourceRevision: '', faceSize, recipeKey: contract.SKYBOX_ENVIRONMENT_RECIPE, environment: null }, 'hdr', new AbortController().signal,
  stage => stages.push({ stage, at: performance.now() - started }), diagnostics);
  return { totalMs: performance.now() - started, stages, bytes: bytes.length, comparison };
}, { origin: vite.origin, faceSize, compare, sourceSha: SOURCE_SHA });

// 运行时加载：每次新建 SceneSkyboxRuntime，记录到 ready 以及随后一帧渲染的耗时。
const loadRuns = (page, faceSize, runs) => page.evaluate(async ({ origin, faceSize, runs }) => {
  const { Engine, Scene, ArcRotateCamera, Vector3, SceneSkyboxRuntime } = window.__skyboxModules;
  const manifest = await (await fetch(`${origin}/builtin-skybox-environments/manifest.json`)).json();
  const resource = manifest.resources.find(item => item.faceSize === faceSize);
  const canvas = document.createElement('canvas'); canvas.width = 480; canvas.height = 320; document.body.append(canvas);
  const engine = new Engine(canvas, false, { preserveDrawingBuffer: true, stencil: true });
  const scene = new Scene(engine); new ArcRotateCamera('camera', 0, Math.PI / 2, 8, Vector3.Zero(), scene);
  const samples = [];
  for (let index = 0; index < runs; index++) {
    const runtime = new SceneSkyboxRuntime(scene);
    const target = { entityId: 'sky', transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } }, visible: true,
      skybox: { packagePath: '', sourcePath: '', sourceUrl: '', sourceAvailable: false, format: 'hdr', assetRevision: resource.sourceSha256, resolution: faceSize,
        rotationDegrees: 0, intensity: 1, environment: { ...resource, sourceUrl: `${origin}/builtin-skybox-environments/${resource.file}` } } };
    const started = performance.now();
    runtime.sync(target);
    while (runtime.getReadiness().phase === 'loading') { if (performance.now() - started > 60000) throw new Error('ENV 加载超时'); await new Promise(resolve => setTimeout(resolve, 5)); }
    if (runtime.getReadiness().phase !== 'ready') throw new Error(JSON.stringify(runtime.getReadiness()));
    const readyMs = performance.now() - started;
    await scene.whenReadyAsync(); scene.render(); await engine.readPixels(0, 0, 4, 4);
    samples.push({ readyMs, firstFrameMs: performance.now() - started, timings: runtime.getLoadDiagnostics().timings, receivedBytes: runtime.getLoadDiagnostics().receivedBytes });
    runtime.dispose();
  }
  engine.dispose(); canvas.remove();
  return { faceSize, bytes: resource.byteLength, samples };
}, { origin: vite.origin, faceSize, runs });

const report = { budget: BUDGET, startedAt: new Date().toISOString() };
try {
  // 冷编译：每次使用全新页面（含首次着色器/模块初始化），首次同时做画质对照。
  report.cold256 = [];
  for (let index = 0; index < 3; index++) {
    const page = await openPage();
    report.cold256.push(await compileOnce(page, 256, index === 0));
    if (index === 0) report.renderer = await page.evaluate(() => { const gl = document.createElement('canvas').getContext('webgl2'); const info = gl.getExtension('WEBGL_debug_renderer_info'); return gl.getParameter(info.UNMASKED_RENDERER_WEBGL); });
    await page.close();
  }
  const warmPage = await openPage();
  report.compare512 = await compileOnce(warmPage, 512, true);
  report.warm512 = [];
  for (let index = 0; index < 2; index++) report.warm512.push(await compileOnce(warmPage, 512, false));
  report.warm1024 = await compileOnce(warmPage, 1024, false);
  await warmPage.close();
  // 运行时：ENV 加载（热）至少 10 次；尺寸 256/512/1024 各自报告。
  const loadPage = await openPage();
  report.runtimeLoads = [];
  for (const size of [256, 512, 1024]) report.runtimeLoads.push(await loadRuns(loadPage, size, 10));
  await loadPage.close();

  const summarize = values => ({ median: median(values), p90: percentile(values, 0.9), min: Math.min(...values), max: Math.max(...values), count: values.length });
  report.summary = {
    compileCold256Ms: summarize(report.cold256.map(item => item.totalMs)),
    compileWarm512Ms: summarize(report.warm512.map(item => item.totalMs)),
    compile1024Ms: report.warm1024.totalMs,
    runtimeLoads: report.runtimeLoads.map(entry => ({ faceSize: entry.faceSize, bytes: entry.bytes, readyMs: summarize(entry.samples.map(item => item.readyMs)),
      firstFrameMs: summarize(entry.samples.map(item => item.firstFrameMs)) })),
  };
  for (const [name, comparison] of [['256', report.cold256[0].comparison], ['512', report.compare512.comparison]]) {
    for (const item of comparison) {
      if (!item.images) continue;
      for (const [kind, base64] of Object.entries(item.images)) await writeFile(path.join(output, `${name}-${item.label}-${kind}.png`), Buffer.from(base64, 'base64'));
      delete item.images;
    }
  }
  await writeFile(path.join(output, 'quality-report.json'), JSON.stringify(report, null, 2));
  const failures = [];
  for (const [name, comparison] of [['256', report.cold256[0].comparison], ['512', report.compare512.comparison]]) {
    for (const item of comparison) {
      const budget = BUDGET[item.kind];
      if (item.meanAbs > budget.meanAbs || item.p99Max > budget.p99Max) failures.push(`${name}/${item.label}: meanAbs=${item.meanAbs.toFixed(3)} p99Max=${item.p99Max} maxDiff=${item.maxDiff}`);
    }
  }
  console.log(JSON.stringify(report.summary, null, 2));
  console.log(JSON.stringify([report.cold256[0].comparison, report.compare512.comparison].map(list => list.map(item => ({ label: item.label, meanAbs: +item.meanAbs.toFixed(3), p99Max: item.p99Max, maxDiff: item.maxDiff, thirds: item.thirds.map(t => [+t.meanAbs.toFixed(2), t.peak]) }))), null, 1));
  assert.deepEqual(failures, [], `画质误差超出事先冻结的预算：\n${failures.join('\n')}`);
  assert.deepEqual(errors, []);
  assert.doesNotMatch(report.renderer, /SwiftShader|llvmpipe|Software/i, '必须使用真实 GPU');
  console.log('PASS 画质/性能', report.renderer);
} finally { clearTimeout(watchdog); await browser.close(); await vite.close(); }
