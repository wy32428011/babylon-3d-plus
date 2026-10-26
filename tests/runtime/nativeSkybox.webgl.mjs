/* global document, window, requestAnimationFrame */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { startSkyboxViteServer } from '../helpers/skyboxViteServer.mjs';

// 未指定 SKYBOX_TEST_URL 时自带 Vite 服务并在结束时关闭；指定外部服务时不启动也不关闭它。
const ownServer = process.env.SKYBOX_TEST_URL ? null : await startSkyboxViteServer();
const base = ownServer?.origin ?? process.env.SKYBOX_TEST_URL;
const output = path.resolve('output/native-skybox-implementation-20261025');
const manifestEnv = JSON.parse(await readFile('public/builtin-skybox-environments/manifest.json', 'utf8')).resources.find(item => item.faceSize === 512);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.SKYBOX_TEST_BROWSER ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
const errors = [], requests = [], failedResponses = [];
const watchdog = setTimeout(() => { console.error('真实 WebGL 验证超过 180 秒，关闭本次测试浏览器。'); void browser.close(); }, 180000);
page.on('console', message => console.log(`[browser:${message.type()}] ${message.text()}`));
page.on('requestfailed', request => console.log(`[request-failed] ${request.url()} ${request.failure()?.errorText}`));
page.on('pageerror', error => errors.push(error.message));
page.on('response', response => { if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`); });
page.on('request', request => requests.push(request.url()));
try {
  await page.goto(`${base}/tests/fixtures/nativeSkybox.harness.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__skyboxModulesReady === true);
  await page.waitForLoadState('networkidle');
  const result = await page.evaluate(async baseUrl => {
    const { compileSkyboxEnvironment } = window.__skyboxModules;
    const contract = window.__skyboxContract;
    const started = performance.now(), stages = [];
    const bytes = await compileSkyboxEnvironment({ token: 'gpu-fixture', sourceUrl: `${baseUrl}/builtin-skyboxes/partly-cloudy-light/partly-cloudy-light.hdr`,
      sourceSha256: 'b35653ca75a00d75392649d29cd27001e5af79dcc6412aa557241bb3ecda1420', sourceRevision: '', faceSize: 256,
      recipeKey: contract.SKYBOX_ENVIRONMENT_RECIPE, environment: null }, 'hdr', new AbortController().signal,
    stage => { stages.push({ stage, timeMs: performance.now() - started }); console.log('[skybox-stage]', stage); });
    return { bytes: Array.from(bytes), stages, compileMs: performance.now() - started };
  }, base);
  const bytes = Buffer.from(result.bytes), hash = createHash('sha256').update(bytes).digest('hex');
  await writeFile(path.join(output, 'generated-256.env'), bytes);
  const compile = { sha256: hash, bytes: bytes.length, stages: result.stages, compileMs: result.compileMs };
  await writeFile(path.join(output, 'compile-256.json'), JSON.stringify(compile, null, 2));
  const render = await page.evaluate(async ({ baseUrl, hash, length }) => {
    const { Engine, Scene, ArcRotateCamera, Camera, Vector3, SceneSkyboxRuntime, CreateSphere, PBRMaterial } = window.__skyboxModules;
    const contract = window.__skyboxContract;
    const engine = new Engine(document.querySelector('canvas'), false, { preserveDrawingBuffer: true, stencil: true });
    const scene = new Scene(engine), camera = new ArcRotateCamera('camera', -Math.PI / 2, Math.PI / 2, 8, Vector3.Zero(), scene);
    camera.maxZ = 12000;
    const gl = engine._gl, debug = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    const sphere = CreateSphere('reference-sphere', { diameter: 2 }, scene);
    const material = new PBRMaterial('reference-material', scene); material.metallic = 1; material.roughness = .2; sphere.material = material;
    const runtime = new SceneSkyboxRuntime(scene);
    const sourceSha = 'b35653ca75a00d75392649d29cd27001e5af79dcc6412aa557241bb3ecda1420';
    const target = { entityId: 'sky', skybox: { packagePath: '', sourcePath: '', sourceUrl: '', sourceAvailable: false,
      format: 'hdr', assetRevision: sourceSha, resolution: 256, rotationDegrees: 0, intensity: 1,
      environment: { version: 1, format: 'env', sourceSha256: sourceSha, sourceRevision: '', recipeKey: contract.SKYBOX_ENVIRONMENT_RECIPE,
        sha256: hash, byteLength: length, faceSize: 256, sourceUrl: `${baseUrl}/output/native-skybox-implementation-20261025/generated-256.env` } },
      transform: { position: { x: 100, y: 200, z: 300 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: .1, y: .1, z: .1 } }, visible: true };
    runtime.sync(target);
    const deadline = performance.now() + 30000;
    while (runtime.getReadiness().phase === 'loading') {
      if (performance.now() > deadline) throw new Error(`ENV runtime readiness timeout: ${JSON.stringify(runtime.getLoadDiagnostics())}`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    if (runtime.getReadiness().phase !== 'ready') throw new Error(JSON.stringify(runtime.getReadiness()));
    const sample = async () => {
      await scene.whenReadyAsync();
      for (let index = 0; index < 4; index++) { scene.render(); await new Promise(requestAnimationFrame); }
      const pixels = await engine.readPixels(0, 0, 800, 600);
      const color = (x, y) => Array.from(pixels.subarray((y * 800 + x) * 4, (y * 800 + x) * 4 + 4));
      return { center: color(400, 300), corner: color(50, 500), right: color(750, 300) };
    };
    const perspective = await sample();
    sphere.setEnabled(false);
    const skyBeforeMove = await sample();
    camera.target.set(25000, 100, 25000);
    const skyAfterMove = await sample();
    camera.target.setAll(0); camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
    camera.orthoLeft = -4; camera.orthoRight = 4; camera.orthoTop = 3; camera.orthoBottom = -3;
    sphere.setEnabled(true);
    const orthographic = await sample();
    const mesh = runtime.getMesh('sky');
    const flags = { infiniteDistance: mesh.infiniteDistance, ignoreCameraMaxZ: mesh.ignoreCameraMaxZ, pickable: mesh.isPickable,
      position: mesh.position.asArray(), triangles: mesh.getTotalIndices() / 3, maxZ: camera.maxZ };
    window.__nativeSkybox = { engine, scene, camera, runtime, target };
    return { renderer, perspective, skyBeforeMove, skyAfterMove, orthographic, flags, ready: runtime.getReadiness(), timings: runtime.getLoadDiagnostics() };
  }, { baseUrl: base, hash, length: bytes.length });
  await page.screenshot({ path: path.join(output, 'native-orthographic.png') });
  assert.equal(render.flags.infiniteDistance, true);
  assert.equal(render.flags.pickable, false);
  assert.equal(render.flags.triangles, 12);
  assert.deepEqual(render.flags.position, [0, 0, 0]);
  assert.deepEqual(render.skyBeforeMove, render.skyAfterMove, '纯平移不改变无限远背景');
  assert.notDeepEqual(render.perspective.center, render.perspective.corner, '物体不能被天空覆盖');
  assert.notDeepEqual(render.orthographic.center, render.orthographic.corner, '正交视角必须保留物体');
  assert.notDeepEqual(render.orthographic.corner, [51, 51, 76, 255], '正交背景不能退化为 Scene clearColor');
  assert.deepEqual(render.orthographic.corner, render.perspective.corner, '正交业务视图的天空保持同相机朝向的背景投影');
  assert.ok(!/SwiftShader|Software|llvmpipe/i.test(render.renderer), `需要真实 GPU，实际为 ${render.renderer}`);
  assert.deepEqual(errors, []);
  const lighting = await page.evaluate(async baseUrl => {
    const { captureLightingEnvironment, createEmptySceneDocument, getSceneLightingBakeSignature } = window.__skyboxModules;
    const { scene, runtime, target } = window.__nativeSkybox;
    const sourceUrl = `${baseUrl}/builtin-skyboxes/partly-cloudy-light/partly-cloudy-light.hdr`;
    const document = createEmptySceneDocument('天空GI捕获');
    document.sceneSettings.lighting.environment.source = 'scene';
    document.sceneSettings.lighting.environmentIntensity = 0.8;
    const source = { ...target.skybox, sourceAvailable: undefined, sourceUrl, sourcePath: sourceUrl, environment: undefined };
    document.entityIds.push('sky');
    document.entities.sky = { id: 'sky', name: 'sky', visible: true, parentId: null, childrenIds: [],
      components: { transform: { ...target.transform, rotation: { x: 0, y: 37 * Math.PI / 180, z: 0 } }, skybox: source } };
    runtime.setLightingOverrides({ source: 'scene', visible: true, intensity: 0.8, rotationDegrees: 0 });
    const before = captureLightingEnvironment(scene, document);
    const signature = getSceneLightingBakeSignature(document);
    source.environment = target.skybox.environment;
    const after = captureLightingEnvironment(scene, document);
    const preparedSignature = getSceneLightingBakeSignature(document);
    source.environment = { ...source.environment, sourceUrl: `${baseUrl}/moved.env`, sha256: 'a'.repeat(64) };
    const relocatedSignature = getSceneLightingBakeSignature(document);
    const texture = scene.environmentTexture;
    runtime.setLightingOverrides({ source: 'scene', visible: false, intensity: 0.8, rotationDegrees: 0 });
    const hidden = { keptIbl: scene.environmentTexture === texture, meshHidden: !runtime.getMesh('sky').isEnabled(), intensity: scene.environmentIntensity };
    source.sourceAvailable = false;
    let blocked = false;
    try { captureLightingEnvironment(scene, document); } catch { blocked = true; }
    runtime.setLightingOverrides({ source: 'scene', visible: true, intensity: 1, rotationDegrees: 0 });
    return { before, after, signature, preparedSignature, relocatedSignature, hidden, blocked, sourceUrl };
  }, base);
  assert.deepEqual(lighting.after, lighting.before, '生成ENV不能把GI方向原图变成平均环境光');
  assert.equal(lighting.after.environment.textureUrl, lighting.sourceUrl);
  assert.equal(lighting.after.environment.intensity, 0.8);
  assert.ok(Math.abs(lighting.after.environment.rotation - 37 * Math.PI / 180) < 1e-8);
  assert.equal(lighting.signature, lighting.preparedSignature);
  assert.equal(lighting.signature, lighting.relocatedSignature, '同源派生路径/编码不改变物理GI输入');
  assert.deepEqual(lighting.hidden, { keptIbl: true, meshHidden: true, intensity: 0.8 });
  assert.equal(lighting.blocked, true, '无原图的运行包不得重新烘焙');
  // R7：异步切换、失败保留、迟到回调与上下文恢复，均在同一真实 GPU 页面中以产品运行时验证。
  const race = await page.evaluate(async ({ baseUrl, builtin }) => {
    const { SceneSkyboxRuntime } = window.__skyboxModules;
    const { scene, engine, target: targetA, runtime: runtimeA } = window.__nativeSkybox;
    const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
    const waitFor = async (condition, label, timeout = 30000) => {
      const deadline = performance.now() + timeout;
      while (!condition()) { if (performance.now() > deadline) throw new Error(`等待超时：${label}`); await pause(20); }
    };
    // 天空 CubeTexture 绑定在 Engine 而非 Scene.textures；以 GPU 内部纹理缓存数量判断泄漏。
    const gpuTextures = () => engine.getLoadedTexturesCache().length;
    const reflection = runtime => runtime.getMesh('sky')?.material?.reflectionTexture ?? null;
    const targetB = { ...targetA, skybox: { ...targetA.skybox, resolution: 512, environment: { ...targetA.skybox.environment, ...builtin,
      sourceUrl: `${baseUrl}/builtin-skybox-environments/512.env` } } };
    const result = {};
    // A→B→A：B 尚未提交就切回 A，迟到的 B 不得替换 A，也不得泄漏纹理。
    const textureA = reflection(runtimeA), gpuWithA = gpuTextures();
    runtimeA.sync(targetB); runtimeA.sync(targetA);
    await pause(2500);
    result.aba = { sameTexture: reflection(runtimeA) === textureA, phase: runtimeA.getReadiness().phase, textureDelta: gpuTextures() - gpuWithA };
    // 真正切到 B：旧 A 纹理必须释放，不能残留。
    runtimeA.sync(targetB);
    await waitFor(() => reflection(runtimeA) !== textureA && runtimeA.getReadiness().phase === 'ready', '切换到 B');
    const oldInternal = textureA.getInternalTexture();
    result.toB = { oldReleased: !oldInternal || oldInternal.isDisposed, gpuDelta: gpuTextures() - gpuWithA, phase: runtimeA.getReadiness().phase };
    // 失败：错误 SHA 的 ENV 不得替换有效天空，状态显示 error，修正后恢复 ready。
    const textureB = reflection(runtimeA);
    const bad = { ...targetB, skybox: { ...targetB.skybox, environment: { ...targetB.skybox.environment, sha256: '0'.repeat(64) } } };
    runtimeA.sync(bad);
    await waitFor(() => runtimeA.getReadiness().phase === 'error', '失败状态');
    result.failure = { kept: reflection(runtimeA) === textureB, enabled: runtimeA.getMesh('sky')?.isEnabled(), message: runtimeA.getReadiness().message };
    runtimeA.sync(targetB);
    await waitFor(() => runtimeA.getReadiness().phase === 'ready', '失败后恢复');
    result.recovered = { kept: reflection(runtimeA) === textureB, phase: runtimeA.getReadiness().phase };
    // 迟到回调：加载未完成时销毁，之后到达的结果不得创建网格或残留纹理。
    runtimeA.sync(targetA);
    runtimeA.dispose();
    await pause(2500);
    result.lateDispose = { skyMeshes: scene.meshes.filter(mesh => mesh.name === 'SceneInfiniteSkybox').length, releasedGpuTextures: gpuWithA - gpuTextures() };
    // 上下文丢失/恢复：重建运行时后丢失再恢复 WebGL 上下文，天空必须自行恢复。
    const runtime = new SceneSkyboxRuntime(scene);
    runtime.sync(targetA);
    await waitFor(() => runtime.getReadiness().phase === 'ready', '重建运行时');
    const readCorner = async () => {
      await scene.whenReadyAsync();
      for (let index = 0; index < 4; index++) { scene.render(); await new Promise(requestAnimationFrame); }
      const pixels = await engine.readPixels(0, 0, 800, 600);
      return Array.from(pixels.subarray((500 * 800 + 50) * 4, (500 * 800 + 50) * 4 + 4));
    };
    const cornerBefore = await readCorner();
    // 恢复后 Babylon 自身会补一张 1×1 占位内部纹理；只比较立方体（天空 ENV）数量，要求恢复前后各一份。
    const cubeTextures = () => engine.getLoadedTexturesCache().filter(texture => texture.isCube).length;
    const cubesBeforeLoss = cubeTextures();
    const extension = engine._gl.getExtension('WEBGL_lose_context');
    let lost = 0, restored = 0;
    engine.onContextLostObservable.add(() => { lost++; });
    engine.onContextRestoredObservable.add(() => { restored++; });
    extension.loseContext(); await pause(300); extension.restoreContext();
    await waitFor(() => restored > 0, '上下文恢复事件');
    let cornerAfter = null;
    const deadline = performance.now() + 30000;
    while (performance.now() < deadline) {
      cornerAfter = await readCorner().catch(() => null);
      if (cornerAfter && cornerAfter.every((value, index) => Math.abs(value - cornerBefore[index]) <= 2)) break;
      await pause(250);
    }
    result.contextRestore = { lost, restored, cornerBefore, cornerAfter, phase: runtime.getReadiness().phase, cubesBeforeLoss, cubesAfterRestore: cubeTextures() };
    runtime.dispose();
    return result;
  }, { baseUrl: base, builtin: { sha256: manifestEnv.sha256, byteLength: manifestEnv.byteLength, faceSize: 512 } });
  await page.screenshot({ path: path.join(output, 'native-after-race.png') });
  assert.deepEqual(race.aba, { sameTexture: true, phase: 'ready', textureDelta: 0 }, 'A→B→A 后仍使用原 A 纹理且无泄漏');
  assert.equal(race.toB.oldReleased, true, '切换后旧纹理必须释放');
  assert.equal(race.toB.gpuDelta, 0, '切换后 GPU 内部纹理数量与切换前一致（旧 ENV 已释放）');
  assert.equal(race.failure.kept, true, '失败不得替换有效天空'); assert.equal(race.failure.enabled, true);
  assert.match(race.failure.message, /ENV|SHA|完整/);
  assert.equal(race.recovered.kept, true); assert.equal(race.recovered.phase, 'ready');
  assert.equal(race.lateDispose.skyMeshes, 0, '销毁后的迟到回调不得创建网格');
  assert.ok(race.lateDispose.releasedGpuTextures > 0, '销毁后天空 GPU 纹理必须全部释放且迟到结果不得再创建');
  assert.ok(race.contextRestore.lost > 0 && race.contextRestore.restored > 0, '必须真实触发上下文丢失与恢复');
  assert.deepEqual(race.contextRestore.cornerAfter, race.contextRestore.cornerBefore, '上下文恢复后天空像素应恢复');
  assert.equal(race.contextRestore.cubesBeforeLoss, 1);
  assert.equal(race.contextRestore.cubesAfterRestore, 1, '上下文恢复后天空 ENV 仍只有一份立方体纹理');
  assert.deepEqual(errors, []);
  const report = { compile, render, lighting, race, errors, remoteRequests: requests.filter(url => /^https?:/.test(url) && !url.startsWith(base)) };
  assert.deepEqual(report.remoteRequests, []);
  // 浏览器自动请求 favicon 不属于天空盒资源；其它任何 4xx/5xx 都必须失败。
  assert.deepEqual(failedResponses.filter(entry => !/\/favicon\.ico$/.test(entry)), []);
  await writeFile(path.join(output, 'native-webgl.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { clearTimeout(watchdog); await browser.close(); await ownServer?.close(); }
