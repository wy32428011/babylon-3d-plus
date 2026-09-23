import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { captureStackerGapFrame, channels, countCyanPixels, createStackerBroker, inspectLiftGapPixels, readStackerArrowGeometry } from '../tests/helpers/stackerMotionArrowFixture.mjs';

const output = path.resolve('output/stacker-motion-arrows');
const packages = JSON.parse(await readFile(path.join(output, 'packages-result.json'), 'utf8'));
assert.equal(packages.ok, true, '先完成实际 SOURCE/DIST 验收');
const roots = {};
for (const key of ['main', 'legacy', 'disabled']) {
  const root = path.resolve(packages.viewers[key]); assert.equal(path.dirname(root), output);
  roots[key] = root;
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
const broker = createStackerBroker(server);
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port;
let browser, page;
const errors = [], results = {};
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  for (const key of ['main', 'legacy', 'disabled']) {
    broker.drive({});
    page = await browser.newPage({ viewport: { width: 1280, height: 900 } }); page.setDefaultTimeout(30000);
    page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
    await page.route('**/api/v1/digital-twin/runtime-config/detail', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, data: { projectId: '123', runtimeEnabled: true,
      mqttBrokerUrl: base.replace('http:', 'ws:') + '/__stacker_mqtt__' } }) }));
    await page.goto(base + '/' + key + '/', { waitUntil: 'load' });
    const engineModule = (await readdir(path.join(roots[key], 'assets'))).find(name => name.startsWith('engineStore-'));
    assert.ok(engineModule, '实际 DIST 包含 Babylon EngineStore 模块');
    await page.evaluate(async url => {
      const module = await import(url); const engines = Object.values(module).find(value => Array.isArray(value?.Instances));
      window.stackerViewer = {
        scene: () => engines.Instances.flatMap(engine => engine.scenes).find(scene => scene.meshes.some(mesh => mesh.name.includes('ArrowMast'))),
        visual: () => engines.Instances.flatMap(engine => engine.scenes.flatMap(scene => scene.meshes)).filter(mesh => mesh.metadata?.stackerMotionArrow === true)
          .map(mesh => { mesh.computeWorldMatrix(true); return { id: mesh.uniqueId, channel: mesh.metadata.channel, enabled: mesh.isEnabled(), ready: mesh.isReady(true),
            pickable: mesh.isPickable, phase: mesh.material?._floats.phase, direction: mesh.material?._floats.direction, center: mesh.getBoundingInfo().boundingBox.centerWorld.asArray() }; }),
      };
    }, base + '/' + key + '/assets/' + engineModule);
    await page.getByRole('progressbar').waitFor({ state: 'hidden', timeout: 60000 });
    await page.waitForFunction(() => window.stackerViewer.scene()?.meshes.some(mesh => mesh.name === 'ArrowMast' && mesh.isReady(true)), null, { timeout: 60000 });
    await page.waitForFunction(() => window.stackerViewer.scene().transformNodes.some(node => node.metadata?.stackerTelemetry?.fields?.front_x === 1));
    if (key !== 'main') {
      broker.drive({ to_x: 5, to_y: 4, to_z: 2, front_movement_z: 1 });
      const frame = await page.evaluate(() => window.stackerViewer.scene().getFrameId());
      await page.waitForFunction(before => window.stackerViewer.scene().getFrameId() > before + 20, frame);
      assert.equal(await page.evaluate(() => window.stackerViewer.visual().length), 0, key + ' 不应创建箭头');
      results[key] = { noArrowMeshes: true }; await page.close(); page = null; continue;
    }
    await page.evaluate(() => { const scene = window.stackerViewer.scene(), camera = scene.activeCamera;
      scene.transformNodes.filter(node => node.name.startsWith('arrow-locator_')).forEach(node => node.getChildMeshes().forEach(mesh => { mesh.visibility = 0; }));
      const rail = scene.meshes.find(mesh => mesh.name === 'ArrowRail'), center = rail.getBoundingInfo().boundingBox.centerWorld.clone(); center.y = 2.5;
      camera.setTarget(center); camera.alpha = -2.3; camera.beta = 1.03; camera.radius = 23; });
    const waitMoving = (channel, direction) => page.waitForFunction(({ channel, direction }) => window.stackerViewer.visual().some(v => v.channel === channel && v.enabled && v.ready && (direction == null || v.direction === direction)), { channel, direction });
    const waitStopped = () => page.waitForFunction(() => window.stackerViewer.visual().every(v => !v.enabled));
    await waitStopped();
    const stoppedPng = await page.locator('canvas').first().screenshot({ path: path.join(output, 'viewer-stopped.png') });
    const stoppedCyan = await countCyanPixels(page, stoppedPng), main = { stoppedCyan };
    broker.drive({ to_x: 5, to_y: 4, to_z: 2 }); await waitMoving('travel', 1); await waitMoving('lift', 1);
    main.forward = await page.evaluate(() => window.stackerViewer.visual());
    const movingPng = await page.locator('canvas').first().screenshot({ path: path.join(output, 'viewer-travel-lift.png') });
    main.movingCyan = await countCyanPixels(page, movingPng);
    assert.ok(main.movingCyan > stoppedCyan + 40, '实际 DIST 行走升降必须有箭头像素');
    const travel = main.forward.find(item => item.channel === 'travel');
    assert.equal(travel.pickable, false);
    const trackAtStart = await readStackerArrowGeometry(page, 'stackerViewer');
    assert.ok(Math.abs(trackAtStart.travel.length - 18) < .001);
    assert.ok(Math.abs(trackAtStart.travel.min[2] - trackAtStart.rail.min[2]) < .001 && Math.abs(trackAtStart.travel.max[2] - trackAtStart.rail.max[2]) < .001,
      '实际 DIST 箭头必须覆盖固定轨道两端');
    await page.waitForFunction(phase => window.stackerViewer.visual().some(v => v.channel === 'travel' && v.phase !== phase), travel.phase);
    await page.waitForFunction(() => { const mesh = window.stackerViewer.scene().meshes.find(mesh => mesh.name === 'ArrowPlatform');
      mesh.computeWorldMatrix(true); return mesh.getBoundingInfo().boundingBox.centerWorld.y > 2.7; });
    await page.evaluate(() => {
      const scene = window.stackerViewer.scene(), mast = scene.meshes.find(mesh => mesh.name === 'ArrowMast'), camera = scene.activeCamera;
      camera.setTarget(mast.getBoundingInfo().boundingBox.centerWorld.clone()); camera.alpha = -Math.PI; camera.beta = Math.PI / 2; camera.radius = 10;
    });
    const gapCameraFrame = await page.evaluate(() => window.stackerViewer.scene().getFrameId());
    await page.waitForFunction(frame => window.stackerViewer.scene().getFrameId() > frame + 2, gapCameraFrame);
    const { geometry: gapAscending, png: gapPng } = await captureStackerGapFrame(page, 'stackerViewer', path.join(output, 'viewer-lift-platform-gap.png'));
    assert.equal(gapAscending.gap.enabled, 1);
    assert.ok(gapAscending.gap.min > .15 && gapAscending.gap.max < .8);
    assert.ok(gapAscending.gap.min > trackAtStart.gap.min);
    assert.deepEqual(gapAscending.travel.center, trackAtStart.travel.center, 'DIST 行走箭头不随底盘移动');
    const gapPixels = await inspectLiftGapPixels(page, gapPng, gapAscending);
    assert.ok(gapPixels.gap.samples > 20);
    assert.equal(gapPixels.gap.cyan, 0, 'DIST 载货台高度必须没有升降箭头像素');
    assert.ok(gapPixels.above.cyan > 20 && gapPixels.below.cyan > 20, 'DIST 缺口上下必须继续显示：' + JSON.stringify(gapPixels));
    main.railAndPlatformGap = { trackAtStart, ascending: gapAscending, pixels: gapPixels };
    broker.drive({ to_x: 1, to_y: 1, to_z: 2 }); await waitMoving('travel', -1); await waitMoving('lift', -1);
    await page.waitForFunction(previous => {
      const lift = window.stackerViewer.scene().meshes.find(mesh => mesh.metadata?.stackerMotionArrow && mesh.metadata.channel === 'lift');
      return lift?.material?._floats.liftGapMin < previous - .02;
    }, gapAscending.gap.min);
    main.railAndPlatformGap.descending = await readStackerArrowGeometry(page, 'stackerViewer');
    assert.deepEqual(main.railAndPlatformGap.descending.travel.center, trackAtStart.travel.center);
    await page.evaluate(() => { const scene = window.stackerViewer.scene(), camera = scene.activeCamera;
      const center = scene.meshes.find(mesh => mesh.name === 'ArrowRail').getBoundingInfo().boundingBox.centerWorld.clone(); center.y = 2.5;
      camera.setTarget(center); camera.alpha = -2.3; camera.beta = 1.03; camera.radius = 23; });
    main.reverse = await page.evaluate(() => window.stackerViewer.visual());
    assert.equal(main.reverse.find(item => item.channel === 'travel').id, travel.id, '反向复用网格');
    await waitStopped();
    for (const [channel, field] of [['frontFork', 'front_movement_z'], ['backFork', 'back_movement_z']]) {
      broker.drive({ [field]: 1 }); await waitMoving(channel, 1);
      main[channel] = await page.evaluate(() => window.stackerViewer.visual());
      await page.screenshot({ path: path.join(output, 'viewer-' + channel + '.png') });
      broker.drive({ [field]: 2 }); await waitMoving(channel, -1); await waitStopped();
    }
    broker.drive({ to_x: 5, to_y: 4, to_z: 2 }); await waitMoving('travel');
    broker.drive({ to_x: 5, to_y: 4, to_z: 2, normal: false, errorCode: 1 }); await waitStopped(); main.faultHidden = true;
    broker.drive({ to_x: 5, to_y: 4, to_z: 2 }); await waitMoving('travel'); broker.pause(); await waitStopped(); main.staleHidden = true;
    broker.drive({ to_x: 1, to_y: 1, to_z: 2 }); await waitMoving('travel', -1);
    assert.equal((await page.evaluate(() => window.stackerViewer.visual())).find(item => item.channel === 'travel').id, travel.id, '恢复复用网格');
    const observed = [...main.forward, ...main.frontFork, ...main.backFork];
    assert.ok(channels.every(channel => observed.some(item => item.channel === channel && item.enabled)), '四路均在对应实际运动时绘制');
    results.main = main; await page.close(); page = null;
  }
  assert.ok(broker.publications > 0); assert.deepEqual(errors, []); assert.deepEqual(broker.errors, []);
  await writeFile(path.join(output, 'viewer-result.json'), JSON.stringify({ ok: true, results, errors, publications: broker.publications,
    mqtt: 'local-websocket-fixture', platformConfig: 'local-fixture', checks: ['actual-DIST', 'four-channel-motion', 'real-WebGL-pixels', 'full-fixed-rail-length-and-ends',
      'moving-platform-gap-pixel-mask', 'gap-follows-ascent-and-descent', 'reverse-phase', 'fault-stale-hidden', 'legacy-disabled-no-mesh'] }, null, 2));
  console.log('PASS: 实际 DIST Viewer 18m全轨覆盖/平台动态缺口像素/四路实际运动/正反向/故障过期/旧场景和显式关闭');
} catch (error) { if (page) await page.screenshot({ path: path.join(output, 'viewer-failure.png') }).catch(() => {}); throw error; }
finally { await browser?.close(); await broker.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
