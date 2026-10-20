import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { countCyanPixels, createLiftBroker, liftId, hcId } from '../tests/helpers/liftMotionArrowFixture.mjs';

const output = path.resolve('output/lift-motion-arrows');
const packages = JSON.parse(await readFile(path.join(output, 'packages-result.json'), 'utf8'));
assert.equal(packages.ok, true);
const roots = {};
for (const key of ['main', 'legacy', 'disabled', 'zero']) {
  const root = path.resolve(packages.viewers[key]); assert.equal(path.dirname(root), output); roots[key] = root;
}
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.ts': 'text/plain', '.json': 'application/json', '.css': 'text/css', '.glb': 'model/gltf-binary', '.png': 'image/png', '.wasm': 'application/wasm' };
const server = createServer(async (req, res) => {
  try {
    const [, key, ...segments] = decodeURIComponent(new URL(req.url, 'http://localhost').pathname).split('/');
    if (!roots[key]) { res.writeHead(404).end(); return; }
    const file = path.resolve(roots[key], segments.join('/') || 'index.html'), relative = path.relative(roots[key], file);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) { res.writeHead(403).end(); return; }
    res.setHeader('Content-Type', mime[path.extname(file)] ?? 'application/octet-stream'); await pipeline(createReadStream(file), res);
  } catch (error) { if (!res.headersSent) res.writeHead(error.code === 'ENOENT' ? 404 : 500); res.end(); }
});
const broker = createLiftBroker(server);
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port;
let browser, page;
const errors = [], results = {};
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  for (const key of ['main', 'legacy', 'disabled', 'zero']) {
    broker.drive('lift', {}); broker.drive('hclift', {});
    page = await browser.newPage({ viewport: { width: 1280, height: 900 } }); page.setDefaultTimeout(30000);
    page.on('pageerror', error => errors.push(key + ': ' + error.message));
    await page.route('**/api/v1/digital-twin/runtime-config/detail', route => route.fulfill({ contentType: 'application/json',
      body: JSON.stringify({ success: true, data: { projectId: '123', runtimeEnabled: true, mqttBrokerUrl: base.replace('http:', 'ws:') + '/__lift_mqtt__' } }) }));
    await page.goto(base + '/' + key + '/', { waitUntil: 'load' });
    const engineModule = (await readdir(path.join(roots[key], 'assets'))).find(name => name.startsWith('engineStore-')); assert.ok(engineModule);
    await page.evaluate(async url => {
      const module = await import(url), engines = Object.values(module).find(value => Array.isArray(value?.Instances));
      if (!engines) throw new Error('DIST EngineStore 导出不存在');
      const scene = () => engines.Instances.flatMap(engine => engine.scenes).find(value => value.meshes.some(mesh => mesh.name === 'LiftColumn'));
      window.liftViewer = { scene, visual: () => scene()?.meshes.filter(mesh => mesh.metadata?.liftMotionArrow === true).map(mesh => {
        mesh.computeWorldMatrix(true); return { name: mesh.name, channel: mesh.metadata.channel, enabled: mesh.isEnabled(), ready: mesh.isReady(true),
          pickable: mesh.isPickable, uniforms: mesh.material?._floats, center: mesh.getBoundingInfo().boundingBox.centerWorld.asArray() };
      }) ?? [] };
    }, base + '/' + key + '/assets/' + engineModule);
    await page.waitForFunction(() => window.liftViewer.scene()?.isReady(), null, { timeout: 90000 });
    await page.evaluate(() => {
      const scene = window.liftViewer.scene(), camera = scene.activeCamera; camera.target.set(0, 2.7, 0); camera.alpha = -.65; camera.beta = 1.15; camera.radius = 15;
      scene.transformNodes.filter(node => node.name.startsWith('lift-arrow-locator')).forEach(node => node.getChildMeshes().forEach(mesh => { mesh.visibility = 0; }));
    });
    const moving = (id, direction) => page.waitForFunction(({ id, direction }) => window.liftViewer.visual().some(v => v.name.includes(id) && v.channel === 'lift' && v.enabled && v.ready && v.uniforms.direction === direction), { id, direction });
    const stopped = () => page.waitForFunction(() => window.liftViewer.visual().every(v => !v.enabled));
    const capture = async name => {
      const png = await page.locator('canvas').first().screenshot({ path: path.join(output, name + '.png') });
      return { cyan: await countCyanPixels(page, png), visual: await page.evaluate(() => window.liftViewer.visual()) };
    };
    await stopped();
    const inactive = await capture('viewer-' + key + '-stopped');
    broker.drive('lift', { reference_upper_step: 1, level_upper: 2 }); broker.drive('hclift', { lift_current_level: 1, task_target_level: 4 });
    if (key === 'main') {
      await moving(liftId, 1); await moving(hcId, 1); results.up = await capture('viewer-up');
      assert.ok(results.up.cyan > inactive.cyan + 20);
      assert.ok(results.up.visual.filter(v => v.enabled).every(v => !v.pickable && v.uniforms.liftGapEnabled === 1));
      const phase = results.up.visual.find(v => v.enabled).uniforms.phase;
      await page.waitForFunction(phase => window.liftViewer.visual().some(v => v.enabled && v.uniforms.phase !== phase), phase);
      broker.drive('lift', { reference_upper_step: 1, level_upper: 1 }); broker.drive('hclift', { lift_current_level: 1, task_target_level: 1 });
      await moving(liftId, -1); await moving(hcId, -1); results.down = await capture('viewer-down');
      broker.drive('lift', { reference_upper_step: 1, level_upper: 2, normal: false, errorCode: 1 });
      broker.drive('hclift', { lift_current_level: 1, task_target_level: 4, work_state: 10 });
      await stopped(); results.faultEmergencyHidden = true;
      broker.drive('lift', { reference_upper_step: 1, level_upper: 2 }); broker.drive('hclift', { lift_current_level: 1, task_target_level: 4 });
      await moving(liftId, 1); await moving(hcId, 1); broker.pause(); await stopped(); results.staleHidden = true;
      // 使用与编辑器相同的真实 MQTT 取货入口验证发布包工位箭头，不能注入运行摘要。
      broker.drive('lift', { reference_upper_step: 1, level_upper: 1, work_state: 1 }); broker.drive('hclift', {});
      await page.waitForFunction(() => {
        const deck = window.liftViewer.scene().meshes.find(mesh => mesh.name === 'LiftDeck');
        deck.computeWorldMatrix(true); return deck.getBoundingInfo().boundingBox.centerWorld.y < .7;
      });
      await stopped();
      const platform = await page.evaluate(() => {
        const scene = window.liftViewer.scene(), deck = scene.meshes.find(mesh => mesh.name === 'LiftDeck');
        deck.computeWorldMatrix(true); const box = deck.getBoundingInfo().boundingBox;
        scene.activeCamera.target.set(-2.5, 1.2, 0); scene.activeCamera.radius = 7; scene.activeCamera.beta = .85;
        return { centerX: box.centerWorld.x, offset: (box.maximumWorld.x - box.minimumWorld.x) / 4 };
      });
      const stationMoving = channel => page.waitForFunction(channel => window.liftViewer.visual()
        .some(v => v.name.includes('lift-arrow-fixture') && v.channel === channel && v.enabled && v.ready && v.uniforms.direction === 1), channel);
      const onboard = (code, x) => page.waitForFunction(({ code, x }) => window.liftViewer.scene().meshes.some(mesh => mesh.metadata?.generatedCargo
        && mesh.metadata.containerCode === code && mesh.parent && Math.abs(mesh.parent.position.x - x) < .01), { code, x });
      broker.driveConveyor('lift-input', { task: 101, containerCode: 'LIFT-BOX-A' });
      await stationMoving('back'); results.backPickup = await capture('viewer-back-pickup');
      await onboard('LIFT-BOX-A', platform.centerX + platform.offset); await stopped();
      broker.driveConveyor('lift-input', { task: 102, containerCode: 'LIFT-BOX-B' });
      await stationMoving('front'); results.frontPickup = await capture('viewer-front-pickup');
      await onboard('LIFT-BOX-B', platform.centerX - platform.offset); await stopped();
      results.stationCargo = await page.evaluate(() => window.liftViewer.scene().meshes.filter(mesh => mesh.metadata?.generatedCargo && mesh.parent)
        .map(mesh => ({ id: mesh.parent.uniqueId, code: mesh.metadata.containerCode, position: mesh.parent.position.asArray() })));
      assert.equal(results.stationCargo.length, 2); assert.equal(new Set(results.stationCargo.map(value => value.id)).size, 2);
      results.gpu = await page.evaluate(() => { const engine = window.liftViewer.scene().getEngine(); return { webGLVersion: engine.webGLVersion, info: engine.getGlInfo() }; });
      assert.equal(results.gpu.webGLVersion, 2);
    } else {
      await page.waitForFunction(() => window.liftViewer.scene().meshes.find(mesh => mesh.name === 'LiftDeck').getAbsolutePosition().y > 1.5);
      await stopped(); results[key] = true;
    }
    await page.close();
  }
  assert.deepEqual(errors, []); assert.deepEqual(broker.errors, []);
  await writeFile(path.join(output, 'viewer-result.json'), JSON.stringify({ ok: true, results, errors, mqtt: 'local-websocket-fixture' }, null, 2));
  console.log('PASS: 实际DIST Viewer lift/hclift WebGL升降/动画/故障急停断流/旧场景关闭/显式关闭/零值');
} catch (error) {
  if (page && !page.isClosed()) { await page.screenshot({ path: path.join(output, 'viewer-failure.png') }).catch(() => {}); console.error(await page.evaluate(() => window.liftViewer?.visual()).catch(() => null)); }
  throw error;
} finally { await browser?.close(); await broker.close(); await new Promise(resolve => server.close(resolve)); }
