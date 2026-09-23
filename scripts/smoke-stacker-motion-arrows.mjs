import assert from 'node:assert/strict';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { assetCode, captureStackerGapFrame, channels, countCyanPixels, createStackerBroker, createStackerFixture, inspectLiftGapPixels, nodeNames, readStackerArrowGeometry, stackerId } from '../tests/helpers/stackerMotionArrowFixture.mjs';

const output = path.resolve('output/stacker-motion-arrows');
await mkdir(output, { recursive: true });
const fixture = await createStackerFixture(output);
fixture.scene.entities[stackerId].components.telemetryBinding.stackerMotionArrows = { enabled: false, channels: {
  travel: { surfaceNode: nodeNames.travel, length: 2.2, offsetAlong: 1.4 },
} };
const server = await createServer({ cacheDir: 'node_modules/.vite-stacker-motion-arrows',
  optimizeDeps: { noDiscovery: true, include: ['react', 'react-dom/client', 'react/jsx-runtime', '@babylonjs/core', '@babylonjs/loaders', '@linkiez/dxf-renew', 'typescript', 'mqtt', 'zustand'] },
  server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false } });
const broker = createStackerBroker(server.httpServer);
const errors = [], results = {};
let browser, page;
try {
  await server.listen(); await server.watcher.close();
  fixture.scene.mqttConfig.address = `ws://127.0.0.1:${server.httpServer.address().port}/__stacker_mqtt__`;
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--disable-features=LocalNetworkAccessChecks,LocalNetworkAccessChecksWebSockets'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, recordVideo: { dir: path.join(output, 'video'), size: { width: 1440, height: 960 } } });
  page = await context.newPage(); page.setDefaultTimeout(30000);
  page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
  page.on('console', message => { if (message.type() === 'error') { errors.push(message.text()); console.error(message.text()); } });
  await page.addInitScript(content => { window.stackerArrowScene = content; }, JSON.stringify(fixture));
  const html = await server.transformIndexHtml('/__stacker_arrows__', '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="/tests/fixtures/stackerMotionArrows.harness.tsx"></script></body></html>');
  await page.route('**/__stacker_arrows__', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto(server.resolvedUrls.local[0] + '__stacker_arrows__', { waitUntil: 'commit' });
  await page.waitForFunction(() => window.stackerArrowHarness?.ready(), null, { timeout: 90000 });
  await page.evaluate(id => { const h = window.stackerArrowHarness; h.store.getState().selectEntity(id); h.camera(); }, stackerId);
  console.log('堆垛机 WebGL 与真实编辑器已加载');
  const panel = page.getByTestId('stacker-motion-arrows');
  const enabled = panel.getByLabel('启用运动箭头', { exact: true });
  assert.equal(await enabled.isChecked(), false, '旧场景没有配置时保持原貌');
  await enabled.check();
  const labels = { travel: '行走', lift: '升降', frontFork: '前叉', backFork: '后叉' };
  for (const channel of channels) {
    const card = page.getByTestId('stacker-motion-arrow-' + channel);
    await card.getByText(labels[channel] + '挂点与范围', { exact: true }).click();
    const node = card.getByLabel(labels[channel] + '部件', { exact: true });
    await node.fill(nodeNames[channel]); await node.press('Enter');
    if (channel === 'travel') {
      assert.equal(await card.getByLabel('长度(m，0自动)', { exact: true }).isDisabled(), true);
      assert.equal(await card.getByLabel('沿运动偏移(m)', { exact: true }).isDisabled(), true);
    } else await card.getByLabel('长度(m，0自动)', { exact: true }).fill(channel === 'lift' ? '5.5' : '1.3');
    await card.getByLabel('宽度(m，0自动)', { exact: true }).fill(channel === 'lift' ? '.25' : '.3');
    await card.getByLabel('离面距离(m)', { exact: true }).fill('.025');
    if (channel === 'travel') await card.getByRole('combobox').selectOption('side');
    await card.getByText(labels[channel] + '挂点与范围', { exact: true }).click();
  }
  const config = () => page.evaluate(() => window.stackerArrowHarness.current().components.telemetryBinding.stackerMotionArrows);
  await panel.getByRole('combobox').first().selectOption('conveyor-direction');
  await page.getByRole('button', { name: '特效库', exact: true }).click();
  const countBeforeDrop = await page.evaluate(() => window.stackerArrowHarness.store.getState().scene.entityIds.length);
  await page.locator('button.resource-card').filter({ has: page.getByText('移动双箭头', { exact: true }) }).dragTo(page.getByTestId('stacker-motion-arrow-style-drop'));
  assert.equal((await config()).style, 'moving-double-arrow');
  assert.equal(await page.evaluate(() => window.stackerArrowHarness.store.getState().scene.entityIds.length), countBeforeDrop, '拖入只应用样式，不创建独立实体');
  results.styleDrag = true;
  const original = await config();
  await page.evaluate(() => { const h = window.stackerArrowHarness, s = h.store.getState(), b = h.current().components.telemetryBinding; s.updateSelectedTelemetryBinding({ ...b, stackerMotionArrows: { ...b.stackerMotionArrows, speed: .91 } }); });
  await page.evaluate(() => window.stackerArrowHarness.store.getState().undo());
  assert.deepEqual(await config(), original, '配置撤销还原');
  await page.evaluate(() => window.stackerArrowHarness.store.getState().redo());
  assert.equal((await config()).speed, .91, '配置重做');
  results.undoRedo = true;

  async function capture(name) {
    const frame = await page.evaluate(() => window.stackerArrowHarness.scene().getFrameId());
    await page.waitForFunction(before => window.stackerArrowHarness.scene().getFrameId() > before + 3, frame);
    const png = await page.locator('canvas').first().screenshot({ path: path.join(output, name + '.png') });
    return { cyan: await countCyanPixels(page, png), visual: await page.evaluate(() => window.stackerArrowHarness.visual()) };
  }
  const preview = async (channel, direction) => {
    await page.getByTestId('stacker-motion-arrow-' + channel).getByRole('button', { name: direction === 1 ? '正向' : '反向', exact: true }).click();
    await page.waitForFunction(({ channel, direction }) => window.stackerArrowHarness.visual().some(v => v.channel === channel && v.enabled && v.ready && v.uniforms.direction === direction), { channel, direction });
  };
  results.preview = {};
  for (const channel of channels) {
    await preview(channel, 1);
    results.preview[channel] = await capture('editor-' + channel + '-forward');
    const rendered = results.preview[channel].visual.find(v => v.channel === channel);
    assert.ok(Math.abs(rendered.length - (channel === 'travel' ? 18 : original.channels[channel].length)) < .001,
      channel + ' 行走须覆盖完整18m轨道，其余通道长度以米计');
    assert.ok(Math.abs(rendered.width - original.channels[channel].width) < .001, channel + ' 宽度以米计');
    const phase = results.preview[channel].visual.find(v => v.channel === channel).uniforms.phase;
    await page.waitForFunction(({ channel, phase }) => window.stackerArrowHarness.visual().some(v => v.channel === channel && v.uniforms.phase !== phase), { channel, phase });
    await preview(channel, -1);
    await capture('editor-' + channel + '-reverse');
    await page.getByTestId('stacker-motion-arrow-' + channel).getByRole('button', { name: '停止', exact: true }).click();
    await page.waitForFunction(channel => window.stackerArrowHarness.visual().filter(v => v.channel === channel).every(v => !v.enabled), channel);
  }
  const stopped = await capture('editor-stopped');
  for (const channel of channels) assert.ok(results.preview[channel].cyan > stopped.cyan + 20, `${channel} 箭头必须绘制真实可见像素：${results.preview[channel].cyan}/${stopped.cyan}`);

  const forkCard = page.getByTestId('stacker-motion-arrow-frontFork');
  await forkCard.getByText('前叉挂点与范围', { exact: true }).click();
  const forkNode = forkCard.getByLabel('前叉部件', { exact: true });
  await forkNode.fill('missing-arrow-node'); await forkNode.press('Enter');
  await forkCard.getByRole('button', { name: '正向', exact: true }).click();
  await page.waitForFunction(id => /未找到/.test(window.stackerArrowHarness.session.getDiagnostic(id, 'frontFork')), stackerId);
  assert.equal(await page.evaluate(() => window.stackerArrowHarness.visual().find(v => v.channel === 'frontFork')?.enabled), false);
  await forkNode.fill(nodeNames.frontFork); await forkNode.press('Enter');
  await forkCard.getByRole('button', { name: '停止', exact: true }).click();
  await forkCard.getByText('前叉挂点与范围', { exact: true }).click();
  const travelCard = page.getByTestId('stacker-motion-arrow-travel');
  await preview('travel', 1);
  await travelCard.getByLabel('启用行走箭头', { exact: true }).uncheck();
  await page.waitForFunction(() => window.stackerArrowHarness.visual().every(v => v.channel !== 'travel'));
  await travelCard.getByLabel('启用行走箭头', { exact: true }).check();
  results.invalidNodeAndDisableCleanup = true;

  // 保存不包含会话预览；复制后的校准对象必须独立。
  const saved = await page.evaluate(() => window.stackerArrowHarness.save());
  await writeFile(path.join(output, 'scene.scene.json'), saved);
  await page.evaluate(() => { const s = window.stackerArrowHarness.store.getState(); s.copySelectedEntities(); s.pasteEntityClipboard(); });
  await page.waitForFunction(id => window.stackerArrowHarness.current().id !== id, stackerId);
  const copy = await config();
  const copyId = await page.evaluate(() => window.stackerArrowHarness.current().id);
  assert.deepEqual(copy, JSON.parse(saved).scene.entities[stackerId].components.telemetryBinding.stackerMotionArrows);
  await page.evaluate(() => { const h = window.stackerArrowHarness, s = h.store.getState(), b = h.current().components.telemetryBinding;
    const arrows = structuredClone(b.stackerMotionArrows); arrows.channels.travel.reverse = true; s.updateSelectedTelemetryBinding({ ...b, stackerMotionArrows: arrows }); });
  assert.equal(await page.evaluate(id => window.stackerArrowHarness.store.getState().scene.entities[id].components.telemetryBinding.stackerMotionArrows.channels.travel.reverse, stackerId), false);
  await page.getByTestId('stacker-motion-arrow-travel').getByRole('button', { name: '正向', exact: true }).click();
  await page.waitForFunction(id => window.stackerArrowHarness.visual().some(v => v.name.includes(id) && v.enabled), copyId);
  await page.evaluate(() => window.stackerArrowHarness.store.getState().deleteSelectedEntity());
  await page.waitForFunction(id => window.stackerArrowHarness.visual().every(v => !v.name.includes(id)), copyId);
  results.deleteCleanup = true;
  await page.evaluate(content => window.stackerArrowHarness.reopen(content), saved);
  await page.waitForFunction(() => window.stackerArrowHarness.ready());
  await page.evaluate(id => { const h = window.stackerArrowHarness; h.store.getState().selectEntity(id); h.camera(); }, stackerId);
  for (const channel of channels) assert.equal(await page.evaluate(({ id, channel }) => window.stackerArrowHarness.session.getPreview(id, channel), { id: stackerId, channel }), null);
  results.copySaveReopen = true;
  const started = await page.evaluate(() => window.stackerArrowHarness.store.getState().startRuntimePreview());
  assert.notEqual(started, false, '运行预览应通过本地 MQTT 预检');
  await page.waitForFunction(() => window.stackerArrowHarness.store.getState().runtimeMode === 'preview');
  await page.waitForFunction(() => window.stackerArrowHarness.scene().transformNodes.some(node => node.metadata?.stackerTelemetry?.fields?.front_x === 1));
  await page.evaluate(() => window.stackerArrowHarness.camera());
  const waitMoving = (channel, direction) => page.waitForFunction(({ channel, direction }) => window.stackerArrowHarness.visual().some(v => v.channel === channel && v.enabled && (direction == null || v.uniforms.direction === direction)), { channel, direction });
  const waitStopped = () => page.waitForFunction(() => window.stackerArrowHarness.visual().every(v => !v.enabled));
  await waitStopped();
  const baseline = await page.evaluate(() => window.stackerArrowHarness.nodes());
  broker.drive({ to_x: 5, to_y: 4, to_z: 2 });
  await waitMoving('travel', 1); await waitMoving('lift', 1);
  results.mqttBody = await capture('mqtt-travel-lift');
  const trackAtStart = await readStackerArrowGeometry(page, 'stackerArrowHarness');
  assert.ok(Math.abs(trackAtStart.travel.length - 18) < .001, '旧2.2m配置不裁短18m轨道');
  assert.ok(Math.abs(trackAtStart.travel.min[2] - trackAtStart.rail.min[2]) < .001 && Math.abs(trackAtStart.travel.max[2] - trackAtStart.rail.max[2]) < .001,
    '行走条带两端必须与固定轨道端点重合');
  const moved = await page.evaluate(() => window.stackerArrowHarness.nodes());
  assert.deepEqual(moved.ArrowRail, baseline.ArrowRail, '固定轨道不能跟随机体移动');
  assert.ok(Math.abs(moved.ArrowBase[2] - baseline.ArrowBase[2]) > .01, '底盘真实沿轨道移动');
  assert.ok(moved.ArrowPlatform[1] > baseline.ArrowPlatform[1] + .01, '载货台真实升降');
  await page.waitForFunction(() => window.stackerArrowHarness.nodes().ArrowPlatform[1] > 2.7);
  await page.evaluate(() => window.stackerArrowHarness.camera('lift'));
  const gapCameraFrame = await page.evaluate(() => window.stackerArrowHarness.scene().getFrameId());
  await page.waitForFunction(frame => window.stackerArrowHarness.scene().getFrameId() > frame + 2, gapCameraFrame);
  const { geometry: gapAscending, png: gapPng } = await captureStackerGapFrame(page, 'stackerArrowHarness', path.join(output, 'editor-lift-platform-gap.png'));
  assert.equal(gapAscending.gap.enabled, 1, '平台进入条带中部时应开启动态缺口');
  assert.ok(gapAscending.gap.min > .15 && gapAscending.gap.max < .8, '缺口上下都应保留足够箭头');
  assert.ok(gapAscending.gap.min > trackAtStart.gap.min, '缺口随实际载货台向上移动');
  assert.deepEqual(gapAscending.travel.center, trackAtStart.travel.center, '底盘移动后整轨箭头中心不变');
  const gapPixels = await inspectLiftGapPixels(page, gapPng, gapAscending);
  assert.ok(gapPixels.gap.samples > 20, '缺口采样区域须实际落在画布中');
  assert.equal(gapPixels.gap.cyan, 0, '载货台高度不允许出现升降箭头像素');
  assert.ok(gapPixels.above.cyan > 20 && gapPixels.below.cyan > 20, '上下两段仍须绘制箭头像素：' + JSON.stringify(gapPixels));
  results.railAndPlatformGap = { trackAtStart, ascending: gapAscending, pixels: gapPixels };
  broker.drive({ to_x: 1, to_y: 1, to_z: 2 });
  await waitMoving('travel', -1); await waitMoving('lift', -1);
  await page.waitForFunction(previous => {
    const lift = window.stackerArrowHarness.visual().find(v => v.channel === 'lift');
    return lift?.uniforms.liftGapMin < previous - .02;
  }, gapAscending.gap.min);
  results.railAndPlatformGap.descending = await readStackerArrowGeometry(page, 'stackerArrowHarness');
  assert.deepEqual(results.railAndPlatformGap.descending.travel.center, trackAtStart.travel.center, '反向运行整轨箭头中心仍不变');
  await page.evaluate(() => window.stackerArrowHarness.camera());
  results.mqttBodyReverse = await capture('mqtt-travel-lift-reverse');
  await waitStopped();
  for (const [channel, field] of [['frontFork', 'front_movement_z'], ['backFork', 'back_movement_z']]) {
    const before = await page.evaluate(() => window.stackerArrowHarness.nodes());
    broker.drive({ [field]: 1 }); await waitMoving(channel, 1);
    results[channel] = await capture('mqtt-' + channel + '-extend');
    const after = await page.evaluate(() => window.stackerArrowHarness.nodes());
    assert.ok(after[nodeNames[channel]][0] > before[nodeNames[channel]][0] + .01, '货叉真实伸出并带动箭头');
    broker.drive({ [field]: 2 }); await waitMoving(channel, -1);
    await capture('mqtt-' + channel + '-retract'); await waitStopped();
  }
  broker.drive({ to_x: 5, to_y: 4, to_z: 2 }); await waitMoving('travel');
  broker.drive({ to_x: 5, to_y: 4, to_z: 2, normal: false, errorCode: 1 }); await waitStopped();
  results.faultHidden = true;
  broker.drive({ to_x: 5, to_y: 4, to_z: 2 }); await waitMoving('travel'); broker.pause(); await waitStopped();
  results.staleHidden = true;
  broker.drive({ to_x: 1, to_y: 1, to_z: 2 }); await waitMoving('travel', -1);
  await page.evaluate(() => window.stackerArrowHarness.store.getState().stopRuntimePreview());
  await page.waitForFunction(() => window.stackerArrowHarness.store.getState().runtimeMode === 'edit');
  await waitStopped();
  results.mqtt = { source: 'local-websocket-fixture', assetCode, publications: broker.publications };
  assert.deepEqual(errors, []); assert.deepEqual(broker.errors, []);
  await writeFile(path.join(output, 'editor-result.json'), JSON.stringify({ ok: true, results, errors }, null, 2));
  const video = page.video();
  await page.evaluate(() => window.stackerArrowHarness.dispose()); await context.close();
  if (video) await copyFile(await video.path(), path.join(output, 'editor-demo.webm'));
  console.log('PASS: 堆垛机四路箭头 WebGL/18m全轨覆盖/平台动态缺口像素/正反向/实际运动跟随/故障过期/撤销复制保存重开');
} catch (error) {
  if (page) { await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {}); console.error(await page.evaluate(() => ({ visual: window.stackerArrowHarness?.visual(), nodes: window.stackerArrowHarness?.nodes(), logs: window.stackerArrowHarness?.store.getState().logs.slice(0, 12) })).catch(() => null)); }
  throw error;
} finally { await browser?.close(); await broker.close(); await server.close(); }
