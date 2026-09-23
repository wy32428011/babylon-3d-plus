import assert from 'node:assert/strict';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { assetCode, channels, countCyanPixels, createRgvBroker, createRgvFixture, nodeNames, rgvId } from '../tests/helpers/rgvMotionArrowFixture.mjs';

const output = path.resolve('output/rgv-motion-arrows'); await mkdir(output, { recursive: true });
const fixture = await createRgvFixture(output);
const server = await createServer({ cacheDir: 'node_modules/.vite-rgv-motion-arrows',
  optimizeDeps: { noDiscovery: true, include: ['react', 'react-dom/client', 'react/jsx-runtime', '@babylonjs/core', '@babylonjs/loaders', '@linkiez/dxf-renew', 'typescript', 'mqtt', 'zustand'] },
  server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false } });
const broker = createRgvBroker(server.httpServer), errors = [], results = {};
let browser, page;
try {
  await server.listen(); await server.watcher.close();
  fixture.scene.mqttConfig.address = `ws://127.0.0.1:${server.httpServer.address().port}/__rgv_mqtt__`;
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--disable-features=LocalNetworkAccessChecks,LocalNetworkAccessChecksWebSockets'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, recordVideo: { dir: path.join(output, 'video'), size: { width: 1440, height: 960 } } });
  page = await context.newPage(); page.setDefaultTimeout(30000);
  page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
  page.on('console', message => { if (message.type() === 'error') { errors.push(message.text()); console.error(message.text()); } });
  await page.addInitScript(content => { window.rgvArrowScene = content; }, JSON.stringify(fixture));
  const html = await server.transformIndexHtml('/__rgv_arrows__', '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="/tests/fixtures/rgvMotionArrows.harness.tsx"></script></body></html>');
  await page.route('**/__rgv_arrows__', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto(server.resolvedUrls.local[0] + '__rgv_arrows__', { waitUntil: 'commit' });
  await page.waitForFunction(() => window.rgvArrowHarness?.ready(), null, { timeout: 90000 });
  await page.evaluate(id => { const h = window.rgvArrowHarness; h.store.getState().selectEntity(id); h.camera(); }, rgvId);
  console.log('RGV WebGL 与真实编辑器已加载');
  const panel = page.getByTestId('rgv-motion-arrows'), enabled = panel.getByLabel('启用运动箭头', { exact: true });
  assert.equal(await enabled.isChecked(), false); await enabled.check();
  const labels = { travel: '行走', front: '前工位', back: '后工位' };
  for (const channel of channels) {
    const card = page.getByTestId('rgv-motion-arrow-' + channel);
    await card.getByText(labels[channel] + '挂点与范围', { exact: true }).click();
    const node = card.getByLabel(labels[channel] + '部件', { exact: true });
    await node.fill(nodeNames[channel]); await node.press('Enter');
    if (channel === 'travel') {
      assert.equal(await card.getByLabel('显示面', { exact: true }).count(), 0);
      assert.equal(await card.getByLabel('横向偏移(m)', { exact: true }).count(), 0);
    }
    await card.getByLabel('宽度(m，0自动)', { exact: true }).fill('.38');
    await card.getByLabel('离面距离(m)', { exact: true }).fill('.025');
    await card.getByText(labels[channel] + '挂点与范围', { exact: true }).click();
  }
  const config = () => page.evaluate(() => window.rgvArrowHarness.current().components.telemetryBinding.rgvMotionArrows);
  await panel.getByRole('combobox').first().selectOption('conveyor-direction');
  await page.getByRole('button', { name: '特效库', exact: true }).click();
  const count = await page.evaluate(() => window.rgvArrowHarness.store.getState().scene.entityIds.length);
  await page.locator('button.resource-card').filter({ has: page.getByText('移动双箭头', { exact: true }) }).dragTo(page.getByTestId('rgv-motion-arrow-style-drop'));
  assert.equal((await config()).style, 'moving-double-arrow');
  assert.equal(await page.evaluate(() => window.rgvArrowHarness.store.getState().scene.entityIds.length), count);
  results.styleDrag = true;
  const original = await config();
  await page.evaluate(() => { const h = window.rgvArrowHarness, b = h.current().components.telemetryBinding;
    h.store.getState().updateSelectedTelemetryBinding({ ...b, rgvMotionArrows: { ...b.rgvMotionArrows, speed: .91 } }); });
  await page.evaluate(() => window.rgvArrowHarness.store.getState().undo()); assert.deepEqual(await config(), original);
  await page.evaluate(() => window.rgvArrowHarness.store.getState().redo()); assert.equal((await config()).speed, .91);
  results.undoRedo = true;
  const visual = () => page.evaluate(() => window.rgvArrowHarness.visual());
  async function capture(name) {
    const frame = await page.evaluate(() => window.rgvArrowHarness.scene().getFrameId());
    await page.waitForFunction(before => window.rgvArrowHarness.scene().getFrameId() > before + 3, frame);
    const png = await page.locator('canvas').first().screenshot({ path: path.join(output, name + '.png') });
    return { cyan: await countCyanPixels(page, png), visual: await visual() };
  }
  const waitMoving = (channel, direction) => page.waitForFunction(({ channel, direction }) => window.rgvArrowHarness.visual().some(v => v.channel === channel && v.enabled && v.ready && v.uniforms.direction === direction), { channel, direction });
  const waitStopped = () => page.waitForFunction(() => window.rgvArrowHarness.visual().every(v => !v.enabled));
  const preview = async (channel, direction) => {
    await page.getByTestId('rgv-motion-arrow-' + channel).getByRole('button', { name: direction === 1 ? '正向' : '反向', exact: true }).click();
    await waitMoving(channel, direction);
  };
  results.preview = {};
  for (const channel of channels) {
    await preview(channel, 1); results.preview[channel] = await capture('editor-' + channel + '-forward');
    const mesh = results.preview[channel].visual.find(value => value.channel === channel);
    if (channel === 'travel') { assert.ok(Math.abs(mesh.length - 16) < .001); assert.ok(Math.abs(mesh.center[0]) < .001); }
    const phase = mesh.uniforms.phase;
    await page.waitForFunction(({ channel, phase }) => window.rgvArrowHarness.visual().some(v => v.channel === channel && v.uniforms.phase !== phase), { channel, phase });
    await preview(channel, -1); await capture('editor-' + channel + '-reverse');
    await page.getByTestId('rgv-motion-arrow-' + channel).getByRole('button', { name: '停止', exact: true }).click();
    await waitStopped();
  }
  const stopped = await capture('editor-stopped');
  for (const channel of channels) assert.ok(results.preview[channel].cyan > stopped.cyan + 20, `${channel}真实箭头像素必须增加`);
  const card = page.getByTestId('rgv-motion-arrow-front');
  await card.getByText('前工位挂点与范围', { exact: true }).click();
  await card.getByLabel('前工位部件', { exact: true }).fill('missing-deck'); await card.getByLabel('前工位部件', { exact: true }).press('Enter');
  await card.getByRole('button', { name: '正向', exact: true }).click();
  await page.waitForFunction(id => /未找到/.test(window.rgvArrowHarness.session.getDiagnostic(id, 'front')), rgvId);
  assert.equal((await visual()).find(v => v.channel === 'front')?.enabled, false);
  await card.getByLabel('前工位部件', { exact: true }).fill(nodeNames.front); await card.getByLabel('前工位部件', { exact: true }).press('Enter');
  await card.getByRole('button', { name: '结束预览', exact: true }).click();
  results.invalidNode = true;
  const saved = await page.evaluate(() => window.rgvArrowHarness.save()); await writeFile(path.join(output, 'scene.scene.json'), saved);
  await page.evaluate(() => { const store = window.rgvArrowHarness.store.getState(); store.copySelectedEntities(); store.pasteEntityClipboard(); });
  await page.waitForFunction(id => window.rgvArrowHarness.current().id !== id, rgvId);
  assert.deepEqual(await config(), JSON.parse(saved).scene.entities[rgvId].components.telemetryBinding.rgvMotionArrows);
  await page.evaluate(() => { const h = window.rgvArrowHarness, b = h.current().components.telemetryBinding;
    const arrows = structuredClone(b.rgvMotionArrows); arrows.channels.travel.reverse = true;
    h.store.getState().updateSelectedTelemetryBinding({ ...b, rgvMotionArrows: arrows }); });
  assert.equal(await page.evaluate(id => window.rgvArrowHarness.store.getState().scene.entities[id].components.telemetryBinding.rgvMotionArrows.channels.travel.reverse, rgvId), false);
  await page.evaluate(content => window.rgvArrowHarness.reopen(content), saved); await page.waitForFunction(() => window.rgvArrowHarness.ready());
  await page.evaluate(id => { const h = window.rgvArrowHarness; h.store.getState().selectEntity(id); h.camera(); }, rgvId);
  for (const channel of channels) assert.equal(await page.evaluate(({ id, channel }) => window.rgvArrowHarness.session.getPreview(id, channel), { id: rgvId, channel }), null);
  results.copySaveReopen = true;
  assert.notEqual(await page.evaluate(() => window.rgvArrowHarness.store.getState().startRuntimePreview()), false);
  await page.waitForFunction(() => window.rgvArrowHarness.store.getState().runtimeMode === 'preview');
  await page.waitForFunction(() => window.rgvArrowHarness.scene().transformNodes.some(node => node.metadata?.telemetry?.fields?.front_y === 1));
  await page.evaluate(() => window.rgvArrowHarness.camera());
  await waitStopped();
  const before = await page.evaluate(() => window.rgvArrowHarness.nodes());
  broker.drive({ front_command: 1, front_movement_z: 1, back_command: 2, back_movement_z: 2 });
  await waitMoving('front', -1); await waitMoving('back', 1);
  results.transfer = await capture('mqtt-dual-transfer');
  broker.drive({}); await waitStopped();
  broker.drive({ go_column: 2 }); await waitMoving('travel', 1);
  results.forward = await capture('mqtt-travel-forward');
  const track = results.forward.visual.find(value => value.channel === 'travel');
  assert.ok(Math.abs(track.center[0]) < .001 && Math.abs(track.length - 16) < .001);
  assert.ok(Math.abs(track.center[1] - .185) < .001, '行走箭头位于0.16m轨顶加0.025m离面处');
  await page.waitForFunction(() => window.rgvArrowHarness.nodes().RgvBody[2] > 2);
  assert.deepEqual((await visual()).find(value => value.channel === 'travel').center, track.center, '车体移动时轨道箭头固定');
  const moved = await page.evaluate(() => window.rgvArrowHarness.nodes());
  assert.deepEqual(moved.RgvRailLeft, before.RgvRailLeft);
  assert.ok(moved.RgvBody[2] > before.RgvBody[2] + 1);
  broker.drive({ front_y: 2, back_y: 4, front_command: 2, front_movement_z: 2, back_command: 1, back_movement_z: 1 });
  await waitMoving('front', -1); await waitMoving('back', 1);
  results.movedTransfer = await capture('mqtt-moved-transfer');
  const nodes = await page.evaluate(() => window.rgvArrowHarness.nodes());
  for (const channel of ['front', 'back']) assert.ok(Math.abs(results.movedTransfer.visual.find(value => value.channel === channel).center[2] - nodes[nodeNames[channel]][2]) < .001, '台面箭头必须随真实车体节点移动');
  broker.drive({ go_column: 1 }); await waitMoving('travel', -1); results.reverse = await capture('mqtt-travel-reverse');
  broker.drive({ go_column: 1, normal: false, errorCode: 1 }); await waitStopped(); results.faultHidden = true;
  broker.drive({ go_column: 2 }); await waitMoving('travel', 1); broker.pause(); await waitStopped(); results.staleHidden = true;
  await page.evaluate(() => window.rgvArrowHarness.store.getState().stopRuntimePreview()); await waitStopped();
  assert.deepEqual(errors, []); assert.deepEqual(broker.errors, []);
  results.mqtt = { source: 'local-websocket-fixture', assetCode, publications: broker.publications };
  await writeFile(path.join(output, 'editor-result.json'), JSON.stringify({ ok: true, results, errors }, null, 2));
  const video = page.video(); await page.evaluate(() => window.rgvArrowHarness.dispose()); await context.close();
  if (video) await copyFile(await video.path(), path.join(output, 'editor-demo.webm'));
  console.log('PASS: RGV 三路箭头 WebGL/轨道正上方固定全长/工位跟随/MQTT/故障断流/保存重开');
} catch (error) {
  if (page) { await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {}); console.error(await page.evaluate(() => ({ visual: window.rgvArrowHarness?.visual(), nodes: window.rgvArrowHarness?.nodes(), logs: window.rgvArrowHarness?.store.getState().logs.slice(0, 12) })).catch(() => null)); }
  throw error;
} finally { await browser?.close(); await broker.close(); await server.close(); }
