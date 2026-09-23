import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { channels, countCyanPixels, createRgvBroker, rgvId } from '../tests/helpers/rgvMotionArrowFixture.mjs';

const output = path.resolve('output/rgv-motion-arrows');
const packages = JSON.parse(await readFile(path.join(output, 'packages-result.json'), 'utf8'));
assert.equal(packages.ok, true, '先完成实际 SOURCE/DIST 验收');
const roots = {};
for (const key of ['main', 'legacy', 'disabled', 'zero']) {
  const root = path.resolve(packages.viewers[key]);
  assert.equal(path.dirname(root), output, '仅运行本次验收解包的 Viewer');
  roots[key] = root;
}
const document = JSON.parse(await readFile(path.join(roots.main, 'project/scene.json'), 'utf8'));
const component = document.scene.entities[rgvId].components;
const transform = component.transform, arrowConfig = component.telemetryBinding.rgvMotionArrows;
assert.deepEqual(transform.position, { x: 0, y: 0, z: 0 }, 'Viewer 基准场景应恢复原点');
assert.deepEqual(transform.rotation, { x: 0, y: 0, z: 0 });
assert.deepEqual(transform.scale, { x: 1, y: 1, z: 1 });
assert.ok(arrowConfig.enabled && arrowConfig.opacity > 0 && arrowConfig.intensity > 0);
assert.ok(channels.every(channel => arrowConfig.channels[channel].enabled));

const mime = { '.html': 'text/html', '.js': 'text/javascript', '.ts': 'text/plain', '.json': 'application/json', '.css': 'text/css', '.glb': 'model/gltf-binary', '.png': 'image/png', '.wasm': 'application/wasm' };
const server = createServer(async (req, res) => {
  try {
    const [, key, ...segments] = decodeURIComponent(new URL(req.url, 'http://localhost').pathname).split('/');
    if (!roots[key]) { res.writeHead(404).end(); return; }
    const file = path.resolve(roots[key], segments.join('/') || 'index.html'), relative = path.relative(roots[key], file);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) { res.writeHead(403).end(); return; }
    res.setHeader('Content-Type', mime[path.extname(file)] ?? 'application/octet-stream');
    await pipeline(createReadStream(file), res);
  } catch (error) { if (!res.headersSent) res.writeHead(error.code === 'ENOENT' ? 404 : 500); res.end(); }
});
const broker = createRgvBroker(server);
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port;
let browser, page;
const errors = [], results = {};

function assertRailPlacement(geometry) {
  const travel = geometry.arrows.travel;
  assert.ok(travel, '行走箭头必须已创建');
  assert.ok(Math.abs(travel.max[2] - travel.min[2] - 16) < .001, '行走覆盖 16 m 全轨');
  assert.ok(Math.abs(travel.min[2] - geometry.rails.min[2]) < .001);
  assert.ok(Math.abs(travel.max[2] - geometry.rails.max[2]) < .001);
  assert.ok(Math.abs(travel.center[0]) < .001, '箭头必须位于双轨中心，不能放在轨旁');
  assert.ok(travel.center[1] > geometry.rails.max[1], '箭头必须高于轨顶');
  assert.ok(Math.abs(travel.center[1] - geometry.rails.max[1] - arrowConfig.channels.travel.surfaceOffset) < .001, '箭头按保存的离面距离贴合轨顶');
  assert.equal(travel.pickable, false);
}

try {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  for (const key of ['main', 'legacy', 'disabled', 'zero']) {
    broker.drive({});
    page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.setDefaultTimeout(30000);
    page.on('pageerror', error => { errors.push(key + ': ' + error.message); console.error(error.message); });
    await page.route('**/api/v1/digital-twin/runtime-config/detail', route => route.fulfill({
      contentType: 'application/json', body: JSON.stringify({ success: true, data: { projectId: '123', runtimeEnabled: true,
        mqttBrokerUrl: base.replace('http:', 'ws:') + '/__rgv_mqtt__' } }),
    }));
    let receivedPublish = false;
    page.on('websocket', socket => socket.on('framereceived', ({ payload }) => {
      const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
      if ((bytes[0] >> 4) === 3) receivedPublish = true;
    }));
    await page.goto(base + '/' + key + '/', { waitUntil: 'load' });
    const engineModule = (await readdir(path.join(roots[key], 'assets'))).find(name => name.startsWith('engineStore-'));
    assert.ok(engineModule, '实际 DIST 包含 Babylon EngineStore 模块');
    await page.evaluate(async url => {
      const module = await import(url), engines = Object.values(module).find(value => Array.isArray(value?.Instances));
      if (!engines) throw new Error('DIST EngineStore 导出不存在');
      const currentScene = () => engines.Instances.flatMap(engine => engine.scenes).find(scene => scene.meshes.some(mesh => mesh.name === 'RgvBody'));
      const bounds = mesh => {
        mesh.computeWorldMatrix(true);
        const box = mesh.getBoundingInfo().boundingBox;
        return { center: box.centerWorld.asArray(), min: box.minimumWorld.asArray(), max: box.maximumWorld.asArray() };
      };
      const arrowState = mesh => ({ ...bounds(mesh), id: mesh.uniqueId, channel: mesh.metadata.channel, enabled: mesh.isEnabled(),
        ready: mesh.isReady(true), pickable: mesh.isPickable, phase: mesh.material?._floats.phase, direction: mesh.material?._floats.direction });
      window.rgvViewer = {
        scene: currentScene,
        visual: () => currentScene()?.meshes.filter(mesh => mesh.metadata?.rgvMotionArrow === true).map(arrowState) ?? [],
        geometry: () => {
          const scene = currentScene(), rails = ['RgvRailLeft', 'RgvRailRight'].map(name => bounds(scene.meshes.find(mesh => mesh.name === name)));
          return {
            rails: { min: [0, 1, 2].map(index => Math.min(...rails.map(item => item.min[index]))),
              max: [0, 1, 2].map(index => Math.max(...rails.map(item => item.max[index]))) },
            body: bounds(scene.meshes.find(mesh => mesh.name === 'RgvBody')),
            front: bounds(scene.meshes.find(mesh => mesh.name === 'RgvFrontDeck')),
            back: bounds(scene.meshes.find(mesh => mesh.name === 'RgvBackDeck')),
            arrows: Object.fromEntries(window.rgvViewer.visual().map(item => [item.channel, item])),
          };
        },
      };
    }, base + '/' + key + '/assets/' + engineModule);
    await page.getByRole('progressbar').waitFor({ state: 'hidden', timeout: 60000 });
    await page.waitForFunction(() => window.rgvViewer.scene()?.meshes.some(mesh => mesh.name === 'RgvBody' && mesh.isReady(true)), null, { timeout: 60000 });
    const waitMoving = (channel, direction) => page.waitForFunction(({ channel, direction }) =>
      window.rgvViewer.visual().some(item => item.channel === channel && item.enabled && item.ready && item.direction === direction), { channel, direction });
    const waitStopped = () => page.waitForFunction(() => window.rgvViewer.visual().every(item => !item.enabled));
    const frames = async (count = 4) => {
      const before = await page.evaluate(() => window.rgvViewer.scene().getFrameId());
      await page.waitForFunction(({ before, count }) => window.rgvViewer.scene().getFrameId() > before + count, { before, count });
    };
    if (key !== 'main') {
      broker.drive({ go_column: 2 });
      await page.waitForFunction(() => window.rgvViewer.geometry().body.center[2] > .25);
      await frames();
      assert.equal(receivedPublish, true, '应消费实际本地 MQTT WebSocket 数据');
      assert.equal(await page.evaluate(() => window.rgvViewer.visual().length), 0, key + ' 不应创建箭头');
      results[key] = { noArrowMeshes: true, deviceMoved: true };
      await page.close(); page = null;
      continue;
    }
    await page.evaluate(() => {
      const scene = window.rgvViewer.scene(), camera = scene.activeCamera;
      const center = scene.meshes.find(mesh => mesh.name === 'RgvBody').getBoundingInfo().boundingBox.centerWorld.clone();
      center.y = .5; camera.setTarget(center); camera.alpha = -2.3; camera.beta = .6; camera.radius = 18;
    });
    await waitStopped(); await frames();
    const stoppedPng = await page.locator('canvas').first().screenshot({ path: path.join(output, 'viewer-stopped.png') });
    const stoppedCyan = await countCyanPixels(page, stoppedPng), main = { stoppedCyan };

    // 起转时已在原始工位：前取货指向车内，后放货指向 +X 接驳位，两路方向独立。
    broker.drive({ front_command: 1, front_movement_z: 1, back_command: 2, back_movement_z: 2 });
    await waitMoving('front', -1); await waitMoving('back', 1);
    main.stationsAtOrigin = await page.evaluate(() => window.rgvViewer.geometry());
    assert.ok(!main.stationsAtOrigin.arrows.travel?.enabled, '初始定位与滚筒起转不显示行走箭头');
    const stationPng = await page.locator('canvas').first().screenshot({ path: path.join(output, 'viewer-dual-stations-origin.png') });
    main.stationCyan = await countCyanPixels(page, stationPng);
    assert.ok(main.stationCyan > stoppedCyan + 20, '实际 DIST 双工位应有箭头像素');

    broker.drive({ go_column: 2 });
    await waitMoving('travel', 1);
    main.forward = await page.evaluate(() => window.rgvViewer.geometry());
    assertRailPlacement(main.forward);
    const travel = main.forward.arrows.travel;
    await page.waitForFunction(phase => window.rgvViewer.visual().some(item => item.channel === 'travel' && item.enabled && item.phase !== phase), travel.phase);
    const travelPng = await page.locator('canvas').first().screenshot({ path: path.join(output, 'viewer-travel-forward.png') });
    main.travelCyan = await countCyanPixels(page, travelPng);
    assert.ok(main.travelCyan > stoppedCyan + 40, '实际 DIST 轨道正上方必须有流动箭头像素');
    await page.waitForFunction(() => Math.abs(window.rgvViewer.geometry().body.center[2] - 4) < .001);
    await waitStopped();

    broker.drive({ front_y: 2, back_y: 4, front_command: 1, front_movement_z: 1, back_command: 2, back_movement_z: 2 });
    await waitMoving('front', 1); await waitMoving('back', -1);
    main.stationsAtDestination = await page.evaluate(() => window.rgvViewer.geometry());
    for (const channel of ['front', 'back']) {
      const before = main.stationsAtOrigin.arrows[channel], after = main.stationsAtDestination.arrows[channel];
      assert.equal(after.id, before.id, '工位移动及换向复用网格');
      assert.ok(Math.abs(after.center[2] - before.center[2] - 4) < .001, channel + ' 工位箭头随车移动 4 m');
      assert.ok(Math.abs(after.center[2] - main.stationsAtDestination[channel].center[2]) < .001, channel + ' 箭头仍贴合对应台面');
      assert.ok(Math.abs(after.center[1] - main.stationsAtDestination[channel].max[1]
        - arrowConfig.channels[channel].surfaceOffset) < .001, channel + ' 箭头保持已保存的离面距离');
    }
    assert.deepEqual(main.stationsAtDestination.arrows.travel.center, travel.center, '轨道箭头不随车移动');
    await page.locator('canvas').first().screenshot({ path: path.join(output, 'viewer-dual-stations-destination.png') });

    broker.drive({ go_column: 1 });
    await waitMoving('travel', -1);
    main.reverse = await page.evaluate(() => window.rgvViewer.geometry());
    assertRailPlacement(main.reverse);
    assert.equal(main.reverse.arrows.travel.id, travel.id, '行走反向复用网格');
    assert.deepEqual(main.reverse.arrows.travel.center, travel.center);
    await page.locator('canvas').first().screenshot({ path: path.join(output, 'viewer-travel-reverse.png') });
    await page.waitForFunction(() => Math.abs(window.rgvViewer.geometry().body.center[2]) < .001);
    await waitStopped();

    broker.drive({ go_column: 2 }); await waitMoving('travel', 1);
    broker.drive({ go_column: 2, normal: false, errorCode: 1 }); await waitStopped();
    main.faultHidden = true;
    broker.drive({ go_column: 2 }); await waitMoving('travel', 1);
    broker.pause(); await waitStopped(); main.staleHidden = true;
    broker.drive({ go_column: 1 }); await waitMoving('travel', -1);
    assert.equal((await page.evaluate(() => window.rgvViewer.visual())).find(item => item.channel === 'travel').id, travel.id, '故障/断流恢复复用网格');
    assert.equal(receivedPublish, true);
    const observed = [...Object.values(main.stationsAtOrigin.arrows), ...Object.values(main.forward.arrows)];
    assert.ok(channels.every(channel => observed.some(item => item.channel === channel && item.enabled)), '三路均按对应实际运动绘制');
    results.main = main;
    await page.close(); page = null;
  }
  assert.ok(broker.publications > 0); assert.deepEqual(errors, []); assert.deepEqual(broker.errors, []);
  await writeFile(path.join(output, 'viewer-result.json'), JSON.stringify({ ok: true, results, errors, publications: broker.publications,
    mqtt: 'local-websocket-fixture', platformConfig: 'local-fixture',
    checks: ['actual-DIST', 'three-channel-motion', 'real-WebGL-pixels', '16m-track-top-centered-full-length', 'dual-stations-follow-body',
      'independent-station-directions', 'reverse-phase', 'fault-stale-hidden', 'legacy-disabled-zero-no-mesh'] }, null, 2));
  console.log('PASS: 实际 DIST Viewer 16m轨顶居中全长/双工位跟随和独立方向/三路实际运动/像素/正反向/故障断流/旧场景及关闭零值');
} catch (error) {
  if (page) {
    await page.screenshot({ path: path.join(output, 'viewer-failure.png') }).catch(() => {});
    const state = await page.evaluate(() => window.rgvViewer?.geometry()).catch(() => null);
    await writeFile(path.join(output, 'viewer-failure.json'), JSON.stringify({ error: String(error), state, errors, brokerErrors: broker.errors }, null, 2)).catch(() => {});
  }
  throw error;
} finally {
  await browser?.close(); await broker.close(); server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
