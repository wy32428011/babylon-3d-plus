import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const root = path.resolve('output/multi-effect-binding/viewer'), output = path.resolve('output/playwright/multi-effect-binding');
await mkdir(output, { recursive: true });
const original = JSON.parse(await readFile(path.join(root, 'project/scene.json'), 'utf8'));
const moduleName = (await readdir(path.join(root, 'assets'))).find(name => name.startsWith('engineStore-'));
assert.ok(moduleName);
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.wasm': 'application/wasm', '.png': 'image/png' };
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname)), relative = path.relative(root, file);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) { response.writeHead(403).end(); return; }
    response.setHeader('Content-Type', mime[path.extname(file)] ?? 'application/octet-stream');
    await pipeline(createReadStream(file), response);
  } catch (error) { if (!response.headersSent) response.writeHead(error.code === 'ENOENT' ? 404 : 500); response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const errors = [], results = [];
let browser, page;
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  let current;
  for (const mode of ['disabled', 'explicit-multiple', 'type-all', 'one-removed']) {
    // 每个配置使用独立浏览器上下文，避免同一发布版本的 IndexedDB 场景缓存复用前一例。
    await page?.close();
    page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/v1/digital-twin/runtime-config/detail', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, data: { projectId: '123', runtimeEnabled: true } }) }));
    await page.route('**/project/scene.json*', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify(current) }));
    current = structuredClone(original);
    const scene = current.scene;
    for (const entity of Object.values(scene.entities)) if (entity.components.poiEffect) { entity.visible = false; entity.components.poiEffect.enabled = false; }
    const entity = scene.entities['multi-entity-effect'], effect = entity.components.poiEffect, target = effect.configuration.target;
    entity.visible = true; effect.enabled = mode !== 'disabled'; effect.effectKind = 'model-emissive';
    effect.configuration.parameters = { color: '#00ffff', emissiveIntensity: 1.5, glowIntensity: 0, glowRadius: 1 };
    effect.primaryColor = '#00ffff'; effect.configuration.data.mode = 'none';
    effect.configuration.data.trigger.enabled = false;
    target.entityIds = mode === 'one-removed' ? ['model-b'] : ['model-a', 'model-b']; target.selection = 'all';
    target.entityId = target.entityIds[0];
    if (mode === 'type-all') {
      target.mode = 'model'; target.entityId = null; target.entityIds = [];
      const asset = scene.entities['model-a'].components.modelAsset;
      target.model = { name: '共享类型', sourcePath: asset.sourcePath, sourceUrl: asset.sourceUrl };
    }
    scene.sceneSettings.camera.savedPose = { alpha: -Math.PI / 2, beta: 1.1, radius: 22, target: { x: 0, y: 1.2, z: 0 } };
    await page.goto(`http://127.0.0.1:${server.address().port}/?case=${mode}`, { waitUntil: 'load' });
    await page.evaluate(async name => {
      const module = await import('/assets/' + name);
      window.viewerEngineStore = Object.values(module).find(value => Array.isArray(value?.Instances));
    }, moduleName);
    await page.waitForFunction(() => window.viewerEngineStore?.Instances.some(engine => engine.scenes.some(scene =>
      ['model-a', 'model-b', 'model-c'].every(id => scene.meshes.some(mesh => mesh.metadata?.editorEntityId === id && mesh.getTotalVertices() > 0 && mesh.isReady(true))))), null, { timeout: 120000 });
    const result = await page.evaluate(async mode => {
      const scene = window.viewerEngineStore.Instances.flatMap(engine => engine.scenes).find(scene => scene.meshes.some(mesh => mesh.metadata?.editorEntityId === 'model-a'));
      const engine = scene.getEngine();
      // 等待材质编译和至少 20 个真实渲染帧；在渲染结束回调读取实际 WebGL 像素。
      await new Promise(resolve => { let frames = 0; const observer = scene.onAfterRenderObservable.add(() => { if (++frames >= 20) { scene.onAfterRenderObservable.remove(observer); resolve(); } }); });
      const frame = await new Promise(resolve => scene.onAfterRenderObservable.addOnce(() => {
        const width = engine.getRenderWidth(), height = engine.getRenderHeight();
        Promise.resolve(engine.readPixels(0, 0, width, height)).then(pixels => resolve({ pixels, width, height }));
      }));
      const modelData = ['model-a', 'model-b', 'model-c'].map(id => {
        const meshes = scene.meshes.filter(mesh => mesh.metadata?.editorEntityId === id && mesh.getTotalVertices() > 0 && mesh.isEnabled());
        const Vector = scene.activeCamera.position.constructor;
        const Matrix = meshes[0].getWorldMatrix().constructor;
        const projected = meshes.flatMap(mesh => mesh.getBoundingInfo().boundingBox.vectorsWorld.map(point => Vector.Project(point, Matrix.Identity(), scene.getTransformMatrix(), scene.activeCamera.viewport.toGlobal(frame.width, frame.height))));
        const left = Math.max(0, Math.floor(Math.min(...projected.map(point => point.x)))), right = Math.min(frame.width - 1, Math.ceil(Math.max(...projected.map(point => point.x))));
        const top = Math.max(0, Math.floor(Math.min(...projected.map(point => point.y)))), bottom = Math.min(frame.height - 1, Math.ceil(Math.max(...projected.map(point => point.y))));
        let cyan = 0;
        for (let y = top; y <= bottom; y++) for (let x = left; x <= right; x++) {
          const offset = ((frame.height - 1 - y) * frame.width + x) * 4;
          const r = frame.pixels[offset], g = frame.pixels[offset + 1], b = frame.pixels[offset + 2];
          if (g > 110 && b > 110 && g > r * 1.5 && b > r * 1.5) cyan++;
        }
        return { id, cyan, bounds: { left, right, top, bottom }, materials: meshes.map(mesh => ({ id: mesh.uniqueId, name: mesh.material?.name, emissive: mesh.material?.emissiveColor?.asArray() ?? [] })) };
      });
      const picks = scene.meshes.filter(mesh => mesh.name.includes('multi-entity-effect') && mesh.metadata?.editorEntityId).map(mesh => ({ name: mesh.name, owner: mesh.metadata.editorEntityId }));
      return { mode, modelData, picks };
    }, mode);
    const activeIds = mode === 'disabled' ? [] : mode === 'one-removed' ? ['model-b'] : ['model-a', 'model-b'];
    await writeFile(path.join(output, `viewer-${mode}-measurements.json`), JSON.stringify(result, null, 2));
    for (const model of result.modelData) {
      const active = activeIds.includes(model.id);
      assert.equal(model.materials.some(material => material.emissive[1] > 1 && material.emissive[2] > 1), active, `${mode}: ${model.id} 的材质只作用于选中的对象`);
      assert.ok(active ? model.cyan > 100 : model.cyan < 20, `${mode}: ${model.id} 的真实画面 cyan=${model.cyan}`);
    }
    if (mode !== 'disabled') {
      assert.ok(result.picks.length >= activeIds.length, `${mode}: 每个派生目标保留拾取代理`);
      assert.ok(result.picks.every(pick => pick.owner === 'multi-entity-effect'), `${mode}: 派生目标指向同一个编辑特效实体`);
    }
    await page.screenshot({ path: path.join(output, `viewer-${mode}.png`) });
    results.push(result);
  }
  assert.deepEqual(errors, []);
  const report = { ok: true, platform: 'actual-local-DIST-viewer', cases: results, errors,
    checks: ['real-models-three', 'explicit-two-targets', 'type-all-two-matches', 'removed-target-restored', 'different-type-isolated', 'stable-WebGL-pixels', 'derived-pick-owner'] };
  await writeFile(path.join(output, 'viewer-result.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify({ ok: true, cases: results.map(result => ({ mode: result.mode, cyan: result.modelData.map(model => model.cyan) })), errors }, null, 2));
} catch (error) {
  if (page) await page.screenshot({ path: path.join(output, 'viewer-failure.png') });
  throw error;
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
