import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const output = path.resolve('output/geographic-opening');
await mkdir(output, { recursive: true });
const baseUrl = (process.env.OPENING_EDITOR_BASE_URL ?? 'http://127.0.0.1:5198').replace(/\/$/, '');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
  await page.goto(`${baseUrl}/tests/fixtures/geographicOpeningEditor.html`, { waitUntil: 'commit', timeout: 120000 });
  const waitPrepared = () => page.waitForFunction(() => window.openingEditorHarness?.preparation().completed, null, { timeout: 180000 });
  await waitPrepared();
  const panel = page.locator('.scene-opening-animation-panel');
  const readOpening = () => page.evaluate(() => window.openingEditorHarness.store.getState().scene.sceneSettings.openingAnimation);
  const edit = async (label, value) => { const field = panel.getByLabel(label, { exact: true }); await field.fill(value); await field.blur(); };
  const expand = async matcher => {
    const summary = panel.locator('summary').filter({ hasText: matcher });
    assert.equal(await summary.count(), 1, `唯一配置分组：${matcher}`);
    if (!await summary.evaluate(element => element.parentElement.open)) await summary.click();
  };
  await panel.getByLabel('进入场景时播放').check();
  const initial = await readOpening();
  assert.equal(initial.enabled, true);
  assert.equal(initial.template, 'reference-huishan');
  assert.equal(initial.reference.stageDurations.reduce((sum, value) => sum + value, 0), 62);
  assert.equal(initial.reference.worldDestinations.length, 40);
  assert.equal(initial.reference.chinaDestinations.length, 34);

  await expand(/^科技呼吸效果$/);
  const breathing = panel.getByRole('checkbox', { name: '科技呼吸效果', exact: true });
  const intensity = panel.getByLabel('呼吸强度（%）', { exact: true });
  assert.equal(await breathing.isChecked(), true);
  await breathing.uncheck();
  assert.equal(await intensity.isDisabled(), true);
  assert.equal((await readOpening()).breathingIntensity, .65);
  await breathing.check();
  await edit('呼吸强度（%）', '0'); assert.equal((await readOpening()).breathingIntensity, 0);
  await edit('呼吸强度（%）', '65');
  await edit('呼吸周期（秒）', '5.5');
  await edit('全球飞线停留（秒）', '0');
  await edit('国内飞线停留（秒）', '0');
  const zeroSaved = await page.evaluate(() => window.openingEditorHarness.save());
  await page.evaluate(value => window.openingEditorHarness.reopen(value), zeroSaved);
  await waitPrepared();
  assert.equal((await readOpening()).reference.stageDurations[2], 0);
  assert.equal((await readOpening()).reference.stageDurations[5], 0);
  await edit('国内飞线停留（秒）', '4.5');

  await expand(/^品牌与公司文案$/);
  await edit('品牌名称', '测试品牌 <b>纯文本</b>');
  await edit('公司名称', '配置往返测试公司');
  await panel.getByLabel('参考画质', { exact: true }).selectOption('low');
  await panel.getByLabel('显示开场界面', { exact: true }).uncheck();
  assert.equal((await readOpening()).reference.showUI, false);
  await panel.getByLabel('显示开场界面', { exact: true }).check();

  await expand(/^全球参考点位（/);
  await edit('全球起点 UV X', '0'); await edit('全球起点 UV Y', '0');
  assert.deepEqual((await readOpening()).reference.worldOrigin, { x: 0, y: 0 });
  await panel.getByRole('button', { name: '恢复全球参考点位', exact: true }).click();
  const worldSnapshot = (await readOpening()).reference.worldDestinations;
  await expand(/^国内参考点位（/);
  await expand(/^\d+\. 上海$/);
  await panel.getByRole('button', { name: '删除国内参考地点 上海', exact: true }).click();
  assert.equal((await readOpening()).reference.chinaDestinations.some(point => point.name === '上海'), false);
  await panel.getByLabel('添加国内预置地点', { exact: true }).selectOption('上海');
  await panel.getByRole('button', { name: '添加国内自定义地点', exact: true }).click();
  const customIndex = (await readOpening()).reference.chinaDestinations.length;
  await expand(new RegExp(`^${customIndex}\\. 自定义地点${customIndex}$`));
  await edit(`国内地点${customIndex}名称`, '自定义城市');
  await edit(`国内地点${customIndex} UV X`, '.42');
  await edit(`国内地点${customIndex} UV Y`, '.62');
  assert.deepEqual((await readOpening()).reference.chinaDestinations.at(-1), { name: '自定义城市', x: .42, y: .62 });
  await panel.getByRole('button', { name: '删除国内参考地点 自定义城市', exact: true }).click();
  await panel.getByRole('button', { name: '恢复国内参考点位', exact: true }).click();
  assert.deepEqual((await readOpening()).reference.chinaDestinations, initial.reference.chinaDestinations);
  assert.deepEqual((await readOpening()).reference.worldDestinations, worldSnapshot, '国内UV操作不修改全球列表');

  const originalCamera = await page.evaluate(() => window.openingEditorHarness.camera());
  const saved = await page.evaluate(() => window.openingEditorHarness.save());
  const expected = await readOpening();
  const overlay = page.getByRole('region', { name: '开场动画', exact: true });
  const visual = page.locator('.geographic-opening-host .zd-intro');
  const waitOpening = async () => {
    await overlay.waitFor({ state: 'visible', timeout: 30000 });
    await visual.waitFor({ state: 'visible', timeout: 90000 });
    await page.waitForFunction(() => Number(document.querySelector('.zd-intro [data-role="progress"]')?.value) > 0, null, { timeout: 90000 });
  };
  const stopPreview = () => overlay.getByRole('button', { name: /^结束预览/ }).click();
  await panel.getByRole('button', { name: '预览开场动画', exact: true }).click();
  await waitOpening();
  assert.ok((await visual.locator('.zd-brand-name').textContent()).includes('<b>纯文本</b>'), '品牌文案按纯文本显示');
  assert.equal(await visual.locator('.zd-brand-name b').count(), 0, '品牌文案不能创建HTML节点');
  const playButton = visual.locator('[data-action="play"]');
  await playButton.click();
  const pausedTime = Number(await visual.locator('[data-role="progress"]').inputValue());
  await page.waitForTimeout(250);
  assert.equal(Number(await visual.locator('[data-role="progress"]').inputValue()), pausedTime, '暂停期间进度不增加');
  await playButton.click();
  await page.waitForFunction(time => Number(document.querySelector('.zd-intro [data-role="progress"]')?.value) > time + .02, pausedTime);
  await page.screenshot({ path: path.join(output, 'editor-opening.png') });
  await stopPreview();
  await overlay.waitFor({ state: 'hidden' });
  assert.deepEqual(await page.evaluate(() => window.openingEditorHarness.camera()), originalCamera, '退出预览恢复编辑相机');
  assert.equal(await page.evaluate(() => window.openingEditorHarness.save()), saved, '预览操作不写场景');

  const duringTransition = await page.evaluate(async () => {
    window.openingEditorHarness.store.getState().setCameraOrientation('top');
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const beta = window.openingEditorHarness.scene().activeCamera.beta;
    window.openingEditorHarness.store.getState().requestOpeningAnimationPreview('play');
    return beta;
  });
  assert.ok(duringTransition > .01, '相机仍向俯视过渡时发出预览请求');
  await waitOpening(); await stopPreview(); await overlay.waitFor({ state: 'hidden' });
  await panel.getByLabel('进入场景时播放').uncheck();
  await panel.getByRole('button', { name: '预览开场动画', exact: true }).click();
  assert.equal(await overlay.count(), 0, '关闭总开关不播放');
  await page.evaluate(value => window.openingEditorHarness.reopen(value), saved);
  await waitPrepared();
  assert.deepEqual(await readOpening(), expected, '保存重开保留参考UV、时长、品牌和呼吸设置');
  await panel.getByRole('button', { name: '预览开场动画', exact: true }).click();
  await waitOpening(); await page.keyboard.press('Escape'); await overlay.waitFor({ state: 'hidden' });
  const preview = await page.evaluate(() => window.openingEditorHarness.store.getState().startRuntimePreview());
  assert.equal(preview.ok, true);
  await waitOpening();
  await visual.locator('[data-action="skip"]:visible').first().click();
  await overlay.waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(() => window.openingEditorHarness.store.getState().runtimeMode), 'preview');
  await page.evaluate(() => window.openingEditorHarness.store.getState().stopRuntimePreview());
  await page.screenshot({ path: path.join(output, 'editor-settings.png') });
  assert.deepEqual(errors, []);
  const report = { checks: ['参考模板默认62秒与40/34点', '呼吸关闭/零强度/小数周期', '全球和国内0秒保存重开',
    '参考UV零值、真实删除、预置添加、自定义与恢复', '两组UV隔离', '品牌文案纯文本与画质设置',
    '参考播放器暂停继续', '退出恢复原相机', '预览不写场景', '相机过渡途中启动', '关闭不播放',
    '完整配置保存重开', 'Esc退出', '运行预览自动播放和跳过'], errors };
  await writeFile(path.join(output, 'editor-verification.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally { await browser.close(); }
