import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { countCyanPixels, createLiftBroker, createLiftFixture, liftId, hcId } from '../tests/helpers/liftMotionArrowFixture.mjs';

const output = path.resolve('output/lift-motion-arrows'); await mkdir(output, { recursive: true });
const fixture = await createLiftFixture(output);
const server = await createServer({ cacheDir: 'node_modules/.vite-lift-motion-arrows',
  optimizeDeps: { noDiscovery: true, include: ['react', 'react-dom/client', 'react/jsx-runtime', '@babylonjs/core', '@babylonjs/loaders', '@linkiez/dxf-renew', 'typescript', 'mqtt', 'zustand'] },
  server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false } });
const broker = createLiftBroker(server.httpServer), errors = [], results = {};
let browser, page;
try {
  await server.listen(); await server.watcher.close();
  fixture.scene.mqttConfig.address = `ws://127.0.0.1:${server.httpServer.address().port}/__lift_mqtt__`;
  browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--disable-features=LocalNetworkAccessChecks,LocalNetworkAccessChecksWebSockets'] });
  page = await browser.newPage({ viewport: { width: 1440, height: 960 } }); page.setDefaultTimeout(30000);
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(content => { window.liftArrowScene = content; }, JSON.stringify(fixture));
  const html = await server.transformIndexHtml('/__lift_arrows__', '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="/tests/fixtures/liftMotionArrows.harness.tsx"></script></body></html>');
  await page.route('**/__lift_arrows__', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto(server.resolvedUrls.local[0] + '__lift_arrows__', { waitUntil: 'commit' });
  await page.waitForFunction(() => window.liftArrowHarness?.ready(), null, { timeout: 90000 });
  const select = id => page.evaluate(id => { const h = window.liftArrowHarness; h.store.getState().selectEntity(id); h.camera(); }, id);
  const visual = () => page.evaluate(() => window.liftArrowHarness.visual());
  const moving = (id, channel, direction) => page.waitForFunction(({ id, channel, direction }) => window.liftArrowHarness.visual()
    .some(v => v.name.includes(id) && v.channel === channel && v.enabled && v.ready && v.uniforms.direction === direction), { id, channel, direction });
  const stopped = () => page.waitForFunction(() => window.liftArrowHarness.visual().every(v => !v.enabled));
  const capture = async name => {
    const png = await page.locator('canvas').first().screenshot({ path: path.join(output, name + '.png') });
    return { cyan: await countCyanPixels(page, png), visual: await visual() };
  };
  console.log('编辑器WebGL已加载');
  for (const [id, channels] of [[liftId, ['lift', 'front', 'back']], [hcId, ['lift']]]) {
    await select(id);
    const panel = page.getByTestId('lift-motion-arrows');
    const enabled = panel.getByLabel('启用运动箭头', { exact: true }); assert.equal(await enabled.isChecked(), false); await enabled.check();
    assert.equal(await panel.locator('[data-testid^="lift-motion-arrow-"]').filter({ has: page.getByRole('group') }).count(), channels.length);
    await panel.getByRole('combobox').first().selectOption('conveyor-direction');
    await panel.getByRole('combobox').first().selectOption('moving-double-arrow');
    for (const channel of channels) {
      console.log('预览', id, channel);
      const card = page.getByTestId('lift-motion-arrow-' + channel);
      await card.getByRole('button', { name: '正向', exact: true }).click(); await moving(id, channel, 1);
      const frame = await capture(id + '-' + channel + '-preview');
      const arrow = frame.visual.find(v => v.name.includes(id) && v.channel === channel);
      if (channel === 'lift') { assert.ok(Math.abs(arrow.length - 6) < .001); assert.equal(arrow.uniforms.liftGapEnabled, 1); }
      const phase = arrow.uniforms.phase;
      await page.waitForFunction(({ id, channel, phase }) => window.liftArrowHarness.visual().some(v => v.name.includes(id) && v.channel === channel && v.uniforms.phase !== phase), { id, channel, phase });
      await card.getByRole('button', { name: '反向', exact: true }).click(); await moving(id, channel, -1);
      await card.getByRole('button', { name: '停止', exact: true }).click(); await stopped();
      const inactive = await capture(id + '-' + channel + '-stopped'); assert.ok(frame.cyan > inactive.cyan + 10, '预览必须实际渲染箭头像素');
      await card.getByRole('button', { name: '结束预览', exact: true }).click();
    }
  }
  results.previews = true;
  const saved = await page.evaluate(() => window.liftArrowHarness.save());
  await writeFile(path.join(output, 'scene.scene.json'), saved);
  await page.evaluate(content => window.liftArrowHarness.reopen(content), saved);
  await page.waitForFunction(() => window.liftArrowHarness.ready()); await select(liftId);
  assert.equal(await page.getByTestId('lift-motion-arrows').getByLabel('启用运动箭头', { exact: true }).isChecked(), true);
  assert.equal(await page.evaluate(id => window.liftArrowHarness.session.getPreview(id, 'lift'), liftId), null);
  results.savedReopened = true;
  await page.setViewportSize({ width: 1000, height: 760 });
  await page.screenshot({ path: path.join(output, 'editor-panel-narrow.png') });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.setViewportSize({ width: 1440, height: 960 });
  assert.notEqual(await page.evaluate(() => window.liftArrowHarness.store.getState().startRuntimePreview()), false);
  await page.waitForFunction(() => window.liftArrowHarness.store.getState().runtimeMode === 'preview');
  await stopped();
  broker.drive('lift', { reference_upper_step: 1, level_upper: 2 });
  broker.drive('hclift', { lift_current_level: 1, task_target_level: 4 });
  await moving(liftId, 'lift', 1); await moving(hcId, 'lift', 1);
  const first = await capture('mqtt-up');
  await page.waitForFunction(() => window.liftArrowHarness.nodes().LiftDeck[1] > 2);
  const second = await capture('mqtt-up-gap-moved');
  const lift = state => state.visual.find(v => v.name.includes('lift-arrow-fixture') && v.channel === 'lift');
  assert.ok(lift(second).uniforms.liftGapMin > lift(first).uniforms.liftGapMin, '载货台缺口应随台面上移');
  assert.deepEqual(lift(first).center, lift(second).center, '立柱箭头不随台面移动');
  results.up = second;
  broker.drive('lift', { reference_upper_step: 1, level_upper: 1 });
  broker.drive('hclift', { lift_current_level: 1, task_target_level: 1 });
  await moving(liftId, 'lift', -1); await moving(hcId, 'lift', -1); results.down = await capture('mqtt-down');
  broker.drive('lift', { reference_upper_step: 1, level_upper: 2, work_state: 10 });
  broker.drive('hclift', { lift_current_level: 1, task_target_level: 4, work_state: 10 });
  await stopped(); results.emergencyHidden = true;
  broker.drive('lift', { reference_upper_step: 1, level_upper: 2 });
  broker.drive('hclift', { lift_current_level: 1, task_target_level: 4 });
  await moving(liftId, 'lift', 1); await moving(hcId, 'lift', 1);
  broker.pause(); await stopped(); results.staleHidden = true;
  await page.evaluate(() => window.liftArrowHarness.store.getState().stopRuntimePreview()); await stopped();
  // 真实 task 边沿在起点 conveyor 生成两箱，既有提升机协议依次接管到后、前工位。
  broker.drive('lift', { reference_upper_step: 1, level_upper: 1, work_state: 1 });
  broker.drive('hclift', { lift_current_level: 1, task_target_level: 1 });
  assert.notEqual(await page.evaluate(() => window.liftArrowHarness.store.getState().startRuntimePreview()), false);
  await page.waitForFunction(() => window.liftArrowHarness.store.getState().runtimeMode === 'preview');
  await stopped();
  await page.evaluate(() => { const camera = window.liftArrowHarness.scene().activeCamera; camera.target.set(-2.5, 1.2, 0); camera.radius = 7; camera.beta = .85; });
  const platform = await page.evaluate(() => {
    const deck = window.liftArrowHarness.scene().meshes.find(mesh => mesh.name === 'LiftDeck');
    deck.computeWorldMatrix(true); const bounds = deck.getBoundingInfo().boundingBox;
    return { centerX: bounds.centerWorld.x, stationOffset: (bounds.maximumWorld.x - bounds.minimumWorld.x) / 4 };
  });
  const cargoSnapshot = () => page.evaluate(() => window.liftArrowHarness.scene().meshes
    .filter(mesh => mesh.metadata?.generatedCargo === true && mesh.parent)
    .map(mesh => ({ id: mesh.parent.uniqueId, containerCode: mesh.metadata.containerCode,
      position: mesh.parent.position.asArray() })));
  const onboard = (containerCode, targetX) => page.waitForFunction(({ containerCode, targetX }) =>
    window.liftArrowHarness.scene().meshes.some(mesh => mesh.metadata?.generatedCargo === true
      && mesh.metadata.containerCode === containerCode && mesh.parent
      && Math.abs(mesh.parent.position.x - targetX) < .01), { containerCode, targetX });
  broker.driveConveyor('lift-input', { task: 101, containerCode: 'LIFT-BOX-A' });
  await moving(liftId, 'back', 1);
  const backPickup = await capture('mqtt-back-pickup');
  const backCargo = await cargoSnapshot();
  assert.equal(backCargo.length, 1);
  assert.equal(backCargo[0].containerCode, 'LIFT-BOX-A');
  await onboard('LIFT-BOX-A', platform.centerX + platform.stationOffset); await stopped();
  const firstOnboard = await cargoSnapshot();
  broker.driveConveyor('lift-input', { task: 102, containerCode: 'LIFT-BOX-B' });
  await moving(liftId, 'front', 1);
  const frontPickup = await capture('mqtt-front-pickup');
  const frontCargo = await cargoSnapshot();
  assert.equal(frontCargo.length, 2);
  assert.equal(new Set(frontCargo.map(value => value.id)).size, 2, '两次 task 必须生成独立实物');
  assert.equal(frontCargo.find(value => value.containerCode === 'LIFT-BOX-A').id, firstOnboard[0].id, '第二箱取货不得替换已在后工位的第一箱');
  await onboard('LIFT-BOX-B', platform.centerX - platform.stationOffset); await stopped();
  const settled = await cargoSnapshot();
  assert.equal(settled.length, 2);
  assert.ok(Math.abs(settled.find(value => value.containerCode === 'LIFT-BOX-A').position[0] - platform.centerX - platform.stationOffset) < .01);
  assert.ok(Math.abs(settled.find(value => value.containerCode === 'LIFT-BOX-B').position[0] - platform.centerX + platform.stationOffset) < .01);
  results.stationPickup = { back: backPickup, front: frontPickup, platform, settled, mqttTasks: [101, 102] };
  await capture('mqtt-two-stations-onboard');
  await page.evaluate(() => window.liftArrowHarness.store.getState().stopRuntimePreview()); await stopped();
  assert.deepEqual(await cargoSnapshot(), [], '结束运行预览必须清理自动货物');
  results.gpu = await page.evaluate(() => { const engine = window.liftArrowHarness.scene().getEngine(); return { webGLVersion: engine.webGLVersion, info: engine.getGlInfo() }; });
  assert.equal(results.gpu.webGLVersion, 2); assert.deepEqual(errors, []); assert.deepEqual(broker.errors, []);
  await writeFile(path.join(output, 'editor-result.json'), JSON.stringify({ ok: true, results, errors, publications: broker.publications }, null, 2));
  console.log('PASS: lift/hclift 编辑器WebGL/四路预览/保存重开/升降MQTT/双工位真实取货MQTT/动态避让/急停断流');
} catch (error) {
  if (page) { await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {}); console.error(await page.evaluate(() => ({ visual: window.liftArrowHarness?.visual(), nodes: window.liftArrowHarness?.nodes(), cargo: window.liftArrowHarness?.scene()?.meshes.filter(mesh => mesh.metadata?.generatedCargo).map(mesh => ({ metadata: mesh.metadata, position: mesh.parent?.position.asArray() })), logs: window.liftArrowHarness?.store.getState().logs.slice(0, 12) })).catch(() => null)); }
  throw error;
} finally { await browser?.close(); await broker.close(); await server.close(); }
