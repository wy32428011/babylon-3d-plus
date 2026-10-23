/* global document, requestAnimationFrame */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';

// 小型真实 GPU 用例复现容器中实例源的缓存失效；完整 GLB 保存/发布另由 smoke 入口验收。
const temporary = await mkdtemp(path.join(os.tmpdir(), 'glb-instance-webgl-'));
const output = path.resolve('output/glb-standard-preview');
await mkdir(output, { recursive: true });
const server = await createServer({ configFile: false, root: process.cwd(), cacheDir: path.join(temporary, 'cache'),
  appType: 'custom', server: { host: '127.0.0.1', port: 0, hmr: false, watch: null }, optimizeDeps: { noDiscovery: true } });
server.middlewares.use('/__glb_instance_gpu__', async (_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end(await server.transformIndexHtml('/__glb_instance_gpu__', '<!doctype html><canvas id="canvas" width="640" height="480"></canvas>'));
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ executablePath: process.env.GLB_PREVIEW_BROWSER ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__glb_instance_gpu__`, { waitUntil: 'domcontentloaded' });
  const result = await page.evaluate(async () => {
    const [{ Engine }, { Scene }, { ArcRotateCamera }, { Vector3 }, { PBRMaterial }, { CreateSphere },
      { AssetContainer }, { HemisphericLight }, { CubeTexture }, { refreshDetachedInstanceSourceMaterials, refreshSceneLightingMaterialDrawCaches }] = await Promise.all([
      import('/node_modules/@babylonjs/core/Engines/engine.js'), import('/node_modules/@babylonjs/core/scene.js'),
      import('/node_modules/@babylonjs/core/Cameras/arcRotateCamera.js'), import('/node_modules/@babylonjs/core/Maths/math.vector.js'),
      import('/node_modules/@babylonjs/core/Materials/PBR/pbrMaterial.js'), import('/node_modules/@babylonjs/core/Meshes/Builders/sphereBuilder.js'),
      import('/node_modules/@babylonjs/core/assetContainer.js'), import('/node_modules/@babylonjs/core/Lights/hemisphericLight.js'),
      import('/node_modules/@babylonjs/core/Materials/Textures/cubeTexture.js'),
      import('/src/runtime/babylon/refreshDetachedInstanceSourceMaterials.ts'),
    ]);
    const engine = new Engine(document.querySelector('canvas'), true, { preserveDrawingBuffer: true });
    // 统计实际 WebGL 编译入口，不能把 Babylon createEffect 的缓存查询当成新编译。
    const gl = engine._gl, originalCompileShader = gl.compileShader;
    let shaderCompileCalls = 0;
    gl.compileShader = function (...args) { shaderCompileCalls++; return originalCompileShader.apply(this, args); };
    const makeScene = () => {
      const scene = new Scene(engine);
      new ArcRotateCamera('camera', -1.1, 1.1, 7, Vector3.Zero(), scene);
      const mesh = CreateSphere('white', { diameter: 3 }, scene), material = new PBRMaterial('white', scene);
      material.albedoColor.set(1, 1, 1); material.metallic = 0; material.roughness = .85; mesh.material = material;
      return { scene, mesh, material };
    };
    const texture = async scene => {
      const value = CubeTexture.CreateFromPrefilteredData('/src/runtime/babylon/assets/sanGiuseppeBridge.env', scene);
      await new Promise(resolve => value.isReady() ? resolve() : value.onLoadObservable.addOnce(resolve));
      value.rotationY = 5.54; return value;
    };
    const render = async ({ scene, mesh }) => {
      await scene.whenReadyAsync();
      for (let frame = 0; frame < 8; frame++) { scene.render(); await new Promise(requestAnimationFrame); }
      const pixels = await engine.readPixels(0, 0, 640, 480);
      const defines = mesh.subMeshes.flatMap(sub => Object.values(sub._drawWrappers ?? {})
        .flatMap(wrapper => wrapper?.effect?.defines?.split('\n') ?? []));
      return { center: Array.from(pixels.slice((240 * 640 + 320) * 4, (240 * 640 + 320) * 4 + 4)),
        reflection: defines.includes('#define REFLECTION'), spherical: defines.includes('#define USESPHERICALFROMREFLECTIONMAP'),
        activeSourceLights: mesh.lightSources.filter(light => light.isEnabled() && light.intensity > 0).map(light => light.name) };
    };
    const drawWrappers = mesh => new Set(mesh.subMeshes.flatMap(sub => [
      ...Object.values(sub._drawWrappers ?? {}).filter(Boolean), ...(sub._drawWrapperOverride ? [sub._drawWrapperOverride] : []),
    ]));
    const verifyResourceReuse = async (target, refresh) => {
      const resources = [...drawWrappers(target.mesh)].filter(wrapper => wrapper.effect).map(wrapper => ({
        wrapper, effect: wrapper.effect, drawContext: wrapper.drawContext, pipeline: wrapper.effect.getPipelineContext(),
      }));
      const effects = [...new Set(resources.map(resource => resource.effect))];
      const originals = effects.map(effect => [effect, effect.dispose]);
      let disposeCalls = 0;
      for (const [effect, dispose] of originals) effect.dispose = function (...args) {
        disposeCalls++; return dispose.apply(this, args);
      };
      const compileCallsBefore = shaderCompileCalls;
      try {
        const refreshed = refresh(target.scene);
        const immediate = { wrappers: resources.every(resource => drawWrappers(target.mesh).has(resource.wrapper)),
          effects: resources.every(resource => resource.wrapper.effect === resource.effect), disposeCalls };
        const pixels = await render(target);
        const retained = drawWrappers(target.mesh);
        return { resourceCount: resources.length, effectCount: effects.length, refreshed, immediate, disposeCalls,
          compileCallsBefore, compileCallsAfter: shaderCompileCalls,
          wrapperIdentity: resources.every(resource => retained.has(resource.wrapper)),
          effectIdentity: resources.every(resource => resource.wrapper.effect === resource.effect),
          drawContextIdentity: resources.every(resource => resource.wrapper.drawContext === resource.drawContext),
          pipelineIdentity: resources.every(resource => resource.pipeline && resource.effect.getPipelineContext() === resource.pipeline),
          remainsFrozen: target.material.isFrozen, pixels };
      } finally {
        for (const [effect, dispose] of originals) effect.dispose = dispose;
      }
    };
    const subject = makeScene(), container = new AssetContainer(subject.scene);
    const light = new HemisphericLight('removed-light', Vector3.Up(), subject.scene); light.intensity = .19;
    container.meshes = [subject.mesh]; container.materials = [subject.material]; container.removeAllFromScene();
    subject.mesh.createInstance('instance'); await render(subject);
    light.dispose(); subject.scene.environmentTexture = await texture(subject.scene);
    const before = await render(subject), refreshed = refreshDetachedInstanceSourceMaterials(subject.scene), after = await render(subject);
    subject.material.freeze(); subject.scene.environmentTexture.rotationY = .3;
    refreshDetachedInstanceSourceMaterials(subject.scene); const frozen = await render(subject);
    const detachedResourceReuse = await verifyResourceReuse(subject, refreshDetachedInstanceSourceMaterials);
    const reference = makeScene(); reference.scene.environmentTexture = await texture(reference.scene);
    const expected = await render(reference); reference.scene.environmentTexture.rotationY = .3;
    const expectedRotated = await render(reference);
    reference.material.freeze(); await render(reference); reference.scene.environmentTexture = null;
    const staleFrozen = await render(reference);
    refreshSceneLightingMaterialDrawCaches(reference.scene); const clearedFrozen = await render(reference);
    reference.scene.environmentTexture = await texture(reference.scene);
    refreshSceneLightingMaterialDrawCaches(reference.scene); const restoredFrozen = await render(reference);
    const remainsFrozen = reference.material.isFrozen;
    const registeredResourceReuse = await verifyResourceReuse(reference, refreshSceneLightingMaterialDrawCaches);
    gl.compileShader = originalCompileShader;
    const gpu = engine.getGlInfo(); subject.scene.dispose(); reference.scene.dispose(); container.dispose(); engine.dispose();
    return { before, refreshed, after, frozen, expected, expectedRotated, staleFrozen, clearedFrozen, restoredFrozen, remainsFrozen, detachedResourceReuse, registeredResourceReuse, shaderCompileCalls, gpu };
  });
  await writeFile(path.join(output, 'instance-gpu-regression.json'), JSON.stringify({ result, errors }, null, 2));
  assert.deepEqual(errors, []);
  assert.doesNotMatch(result.gpu.renderer, /swiftshader|llvmpipe|software/i);
  assert.equal(result.before.reflection, false, '夹具必须实际复现普通刷新漏掉容器实例源的路径');
  assert.equal(result.refreshed, 1, '同一实例源只刷新一次');
  for (const [actual, expected] of [[result.after, result.expected], [result.frozen, result.expectedRotated]]) {
    assert.equal(actual.reflection, true); assert.equal(actual.spherical, true); assert.deepEqual(actual.activeSourceLights, []);
    actual.center.forEach((value, index) => assert.ok(Math.abs(value - expected.center[index]) <= 1,
      `实例源与原生 PBR 的同条件像素必须相同：${actual.center} / ${expected.center}`));
  }
  assert.equal(result.staleFrozen.reflection, true, '注册冻结材质必须复现普通标脏后仍缓存旧环境的路径');
  assert.equal(result.clearedFrozen.reflection, false);
  assert.equal(result.restoredFrozen.reflection, true); assert.equal(result.restoredFrozen.spherical, true);
  assert.equal(result.remainsFrozen, true, '刷新不改变环境材质冻结状态');
  result.restoredFrozen.center.forEach((value, index) => assert.ok(Math.abs(value - result.expected.center[index]) <= 1));
  assert.ok(result.shaderCompileCalls > 0, '编译计数器必须观测到真实 WebGL shader 编译，避免失效的零计数');
  for (const [name, reuse, expected] of [
    ['离场实例源', result.detachedResourceReuse, result.frozen],
    ['注册冻结环境', result.registeredResourceReuse, result.restoredFrozen],
  ]) {
    assert.ok(reuse.resourceCount > 0 && reuse.effectCount > 0, name + '必须具有真实已编译 Effect');
    assert.equal(reuse.refreshed, 1, name + '应只刷新一个网格');
    assert.deepEqual(reuse.immediate, { wrappers: true, effects: true, disposeCalls: 0 }, name + '刷新不能清空或释放已有资源');
    for (const field of ['wrapperIdentity', 'effectIdentity', 'drawContextIdentity', 'pipelineIdentity', 'remainsFrozen']) {
      assert.equal(reuse[field], true, name + '必须保留' + field);
    }
    assert.equal(reuse.disposeCalls, 0, name + '刷新及后续帧不得主动释放仍复用的 Effect');
    assert.equal(reuse.compileCallsAfter, reuse.compileCallsBefore, name + '同 defines 的刷新不得产生新的 WebGL shader 编译');
    reuse.pixels.center.forEach((value, index) => assert.ok(Math.abs(value - expected.center[index]) <= 1,
      name + '同配置资源复用必须保持原像素：' + reuse.pixels.center + ' / ' + expected.center));
  }
  console.log(JSON.stringify({ status: 'PASS', ...result }));
} finally { await browser?.close(); await server.close(); }
