import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { build } from 'vite';
import { chromium } from 'playwright';

// 用真实 GPU 同时检查原材质画面、独立副本和克隆/释放后的内部纹理数量。
const output = path.resolve(process.argv[2] ?? 'output/playwright/material-texture-clone');
await mkdir(output, { recursive: true });
const html = `<!doctype html><html><body style="margin:0;background:#18212b"><canvas width="256" height="256"></canvas>
<script type="module">
import { AssetContainer, Color3, Engine, FreeCamera, MeshBuilder, PBRMaterial, RawTexture, Scene, StandardMaterial, Texture, Vector3 } from '@babylonjs/core';
import { cloneModelAssetContainer } from '/src/runtime/babylon/cloneModelAssetContainer.ts';
import { cloneEnvironmentMaterial } from '/src/runtime/babylon/cloneEnvironmentMaterial.ts';
const engine = new Engine(document.querySelector('canvas'), false, { preserveDrawingBuffer: true });
window.runCloneCheck = async (kind) => {
  const scene = new Scene(engine);
  const source = new AssetContainer(scene);
  const camera = new FreeCamera('camera', new Vector3(0, 0, -3), scene);
  camera.setTarget(Vector3.Zero());
  const mesh = MeshBuilder.CreatePlane('surface', { size: 2.4 }, scene);
  const material = kind === 'pbr' ? new PBRMaterial('source', scene) : new StandardMaterial('source', scene);
  const pixels = new Uint8Array(32 * 16 * 4);
  const palette = [[230, 40, 30], [25, 200, 80], [35, 75, 225], [225, 185, 40]];
  for (let y = 0; y < 16; y++) for (let x = 0; x < 32; x++) {
    const offset = (y * 32 + x) * 4;
    pixels.set([...palette[(x >= 16 ? 1 : 0) + (y >= 8 ? 2 : 0)], 255], offset);
  }
  const texture = RawTexture.CreateRGBATexture(pixels, 32, 16, scene, true, false, Texture.NEAREST_SAMPLINGMODE);
  texture.uScale = 3; texture.vScale = 2; texture.uOffset = 0.25; texture.vOffset = 0.125;
  texture.wAng = 0.15; texture.wrapU = Texture.WRAP_ADDRESSMODE; texture.wrapV = Texture.MIRROR_ADDRESSMODE;
  if (kind === 'pbr') { material.unlit = true; material.disableLighting = true; material.albedoTexture = texture; }
  else { material.disableLighting = true; material.emissiveColor = Color3.White(); material.emissiveTexture = texture; }
  material.detailMap.isEnabled = true; material.detailMap.texture = texture; material.detailMap.diffuseBlendLevel = 0.2;
  mesh.material = material;
  source.meshes.push(mesh); source.rootNodes.push(mesh); source.materials.push(material); source.textures.push(texture);
  const capture = async () => {
    engine.beginFrame(); scene.render(); engine.endFrame();
    let timeout;
    try { await Promise.race([scene.whenReadyAsync(true), new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error('材质未在 15 秒内准备就绪: ' + kind)), 15000);
    })]); } finally { clearTimeout(timeout); }
    for (let i = 0; i < 3; i++) { engine.beginFrame(); scene.render(); engine.endFrame(); }
    return Array.from(await engine.readPixels(0, 0, 256, 256));
  };
  const compare = (a, b) => { let changed = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) changed++; return changed; };
  const containers = [], environmentMaterials = [];
  try {
    const reference = await capture();
    const colors = new Set();
    for (let i = 0; i < reference.length; i += 4) colors.add(reference.slice(i, i + 3).join(','));
    source.removeAllFromScene();
    const initialStorage = engine.getLoadedTexturesCache().length;
    for (let i = 0; i < 12; i++) containers.push(cloneModelAssetContainer(source));
    const ownedStorage = engine.getLoadedTexturesCache().length;
    const copy = containers[0]; copy.addAllToScene();
    const copiedMaterial = copy.meshes[0].material;
    const copiedTexture = kind === 'pbr' ? copiedMaterial.albedoTexture : copiedMaterial.emissiveTexture;
    const ownedPixels = await capture();
    await new Promise(resolve => requestAnimationFrame(resolve));
    copy.removeAllFromScene();
    const originalUScale = texture.uScale;
    copiedTexture.uScale = 7;
    const independentUv = texture.uScale === originalUScale;
    const rawSubtype = copiedTexture instanceof RawTexture && typeof copiedTexture.updateMipLevel === 'function';
    const sharedStorage = copiedTexture.getInternalTexture() === texture.getInternalTexture();
    for (const container of containers.splice(0)) container.dispose();
    const releasedOwnedStorage = engine.getLoadedTexturesCache().length;
    for (let i = 0; i < 12; i++) environmentMaterials.push(cloneEnvironmentMaterial(material, 'environment-' + i));
    const environmentStorage = engine.getLoadedTexturesCache().length;
    mesh.material = environmentMaterials[0]; source.addAllToScene();
    const environmentPixels = await capture();
    window.lastCloneLabel = kind;
    const canvas = document.querySelector('canvas');
    window.lastCloneImage = canvas.toDataURL('image/png');
    source.removeAllFromScene(); mesh.material = material;
    const environmentSharedWrapper = environmentMaterials.every(item => (kind === 'pbr' ? item.albedoTexture : item.emissiveTexture) === texture);
    for (const item of environmentMaterials.splice(0)) item.dispose(false, false);
    const releasedEnvironmentStorage = engine.getLoadedTexturesCache().length;
    source.addAllToScene(); const restoredPixels = await capture();
    return { kind, count: 12, sourceColors: colors.size, initialStorage, ownedStorage, releasedOwnedStorage,
      environmentStorage, releasedEnvironmentStorage, rawSubtype, independentUv, sharedStorage, environmentSharedWrapper,
      ownedPixelDifferences: compare(reference, ownedPixels), environmentPixelDifferences: compare(reference, environmentPixels),
      restoredPixelDifferences: compare(reference, restoredPixels), renderer: engine.getGlInfo() };
  } finally {
    for (const container of containers) container.dispose();
    for (const item of environmentMaterials) item.dispose(false, false);
    source.dispose(); scene.dispose();
  }
};
window.cloneCheckReady = true;
</script></body></html>`;
const inputDirectory = path.join(output, '.source'), buildDirectory = path.join(output, '.build');
const server = createServer((request, response) => {
  const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
  const file = path.resolve(buildDirectory, '.' + (pathname === '/' ? '/index.html' : pathname));
  if (!file.startsWith(buildDirectory + path.sep)) { response.writeHead(403).end(); return; }
  void readFile(file).then(bytes => {
    response.setHeader('Content-Type', file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : 'application/octet-stream');
    response.end(bytes);
  }, () => response.writeHead(404).end());
});
let browser;
const report = { status: 'RUNNING', scope: 'real-webgl-source-material-pixels-and-internal-texture-lifecycle', samples: [], errors: [] };
try {
  await mkdir(inputDirectory, { recursive: true });
  const sourcePrefix = path.relative(inputDirectory, path.join(process.cwd(), 'src')).replaceAll('\\', '/') + '/';
  await writeFile(path.join(inputDirectory, 'index.html'), html.replaceAll('/src/', sourcePrefix));
  console.log('phase: build');
  await build({ configFile: false, root: inputDirectory, cacheDir: path.join(output, '.vite-cache'), logLevel: 'error',
    build: { outDir: buildDirectory, emptyOutDir: true, minify: false } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  console.log('phase: browser');
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  const page = await browser.newPage({ viewport: { width: 256, height: 256 } });
  page.setDefaultTimeout(120_000);
  page.on('pageerror', error => report.errors.push(error.message));
  await page.goto('http://127.0.0.1:' + server.address().port + '/');
  await page.waitForFunction(() => window.cloneCheckReady);
  for (const kind of ['standard', 'pbr']) {
    const sample = await page.evaluate(kind => Promise.race([window.runCloneCheck(kind),
      new Promise((_, reject) => setTimeout(() => reject(new Error('克隆 WebGL 检查超时: ' + kind)), 45000))]), kind);
    report.samples.push(sample);
    const dataUrl = await page.evaluate(() => window.lastCloneImage);
    await writeFile(path.join(output, kind + '.png'), Buffer.from(dataUrl.split(',')[1], 'base64'));
    console.log(JSON.stringify(sample));
  }
  assert.deepEqual(report.errors, []);
  for (const sample of report.samples) {
    assert.doesNotMatch(sample.renderer.renderer, /swiftshader|llvmpipe|software/i);
    assert.ok(sample.sourceColors >= 4, '四块不同颜色的原贴图必须实际渲染，不能用空画面通过');
    assert.equal(sample.rawSubtype && sample.independentUv && sample.sharedStorage && sample.environmentSharedWrapper, true);
    for (const key of ['ownedStorage', 'releasedOwnedStorage', 'environmentStorage', 'releasedEnvironmentStorage']) {
      assert.equal(sample[key], sample.initialStorage, sample.kind + '/' + key + ': 克隆或释放后不得遗留内部纹理');
    }
    for (const key of ['ownedPixelDifferences', 'environmentPixelDifferences', 'restoredPixelDifferences']) {
      assert.equal(sample[key], 0, sample.kind + '/' + key + ': 副本和释放后的原材质必须保持原始画面');
    }
  }
  report.status = 'PASS';
} catch (error) {
  report.status = 'FAIL'; report.error = error.message; process.exitCode = 1;
} finally {
  await writeFile(path.join(output, 'result.json'), JSON.stringify(report, null, 2));
  await browser?.close(); if (server.listening) await new Promise(resolve => server.close(resolve));
  console.log(JSON.stringify({ status: report.status, output, error: report.error }));
}
