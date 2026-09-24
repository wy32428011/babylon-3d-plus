import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const output = path.resolve('output/playwright/lighting-types');
await mkdir(output, { recursive: true });
const server = await createServer({
  cacheDir: path.resolve('node_modules/.vite-lighting-types-smoke'),
  server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false },
});
let browser, page;
const errors = [], externalRequests = [], results = [];
const expectedClasses = {
  hemispheric: 'HemisphericLight', point: 'PointLight', spot: 'SpotLight', rectArea: 'RectAreaLight', directional: 'DirectionalLight',
};

try {
  await server.listen();
  await server.watcher.close();
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  page = await browser.newPage({ viewport: { width: 1660, height: 960 } });
  page.setDefaultTimeout(30_000);
  page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
  const baseUrl = server.resolvedUrls.local[0];
  await page.route('**/*', async route => {
    const url = route.request().url();
    if (/^https?:/.test(url) && !url.startsWith(baseUrl)) {
      externalRequests.push(url);
      return route.abort('blockedbyclient');
    }
    return route.continue();
  });
  const html = await server.transformIndexHtml('/__lighting_types__', '<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;background:#111923"><canvas width="800" height="600" style="display:block;width:800px;height:600px"></canvas><div id="panels" style="height:400px"></div><script type="module" src="/tests/fixtures/lightingTypes.harness.ts"></script></body></html>');
  await page.route('**/__lighting_types__', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto(baseUrl + '__lighting_types__', { waitUntil: 'commit' });
  await page.waitForFunction(() => Boolean(window.lightingTypesHarness), null, { timeout: 180_000 });
  const action = (method, ...args) => page.evaluate(({ method, args }) => window.lightingTypesHarness[method](...args), { method, args });
  const capture = name => page.locator('canvas').first().screenshot({ path: path.join(output, name + '.png') });

  await action('mountUI');
  await page.getByPlaceholder('请输入模型名称...').fill('光');
  const cardNames = { directional: '方向光', spot: '聚光灯', point: '点光源', hemispheric: '半球光', rectArea: '矩形面光' };
  const lightCards = page.locator('.resource-card').filter({ has: page.locator('.resource-card-thumbnail') });
  await lightCards.first().waitFor();
  assert.equal(await lightCards.count(), 6, '模型库搜索光必须展示五种光源和 HDRI/IBL 入口');
  assert.equal(await lightCards.evaluateAll(cards => cards.every(card => {
    const image = card.querySelector('img');
    return image.complete && image.naturalWidth > 0 && card.getAttribute('aria-description')?.length > 20;
  })), true, '六个光照卡片必须有已加载缩略图和完整说明');
  await page.screenshot({ path: path.join(output, 'light-library-cards.png'), fullPage: true });
  const cardClip = await lightCards.evaluateAll(cards => {
    const rectangles = cards.map(card => card.getBoundingClientRect());
    const x = Math.min(...rectangles.map(value => value.x)) - 8, y = Math.min(...rectangles.map(value => value.y)) - 8;
    return { x, y, width: Math.max(...rectangles.map(value => value.right)) - x + 8,
      height: Math.max(...rectangles.map(value => value.bottom)) - y + 8 };
  });
  await page.screenshot({ path: path.join(output, 'light-library-cards-row.png'), clip: cardClip });
  const selectedLight = () => page.evaluate(() => {
    const state = window.lightingUIStore.getState();
    return state.scene.entities[state.scene.selectedEntityId]?.components.light;
  });
  for (const [kind, name] of Object.entries(cardNames)) {
    await page.getByRole('button', { name: new RegExp('^' + name) }).click();
    assert.equal((await selectedLight()).lightKind, kind, `卡片点击创建${name}`);
    if (kind === 'spot') {
      await page.getByLabel('光锥角度 (°)', { exact: true }).fill('45');
      await page.getByLabel('光束衰减', { exact: true }).fill('0');
      await page.getByLabel('照射范围 (m)', { exact: true }).fill('18');
      const beforeZero = (await selectedLight()).intensity;
      await page.getByLabel('强度', { exact: true }).fill('0');
      assert.equal((await selectedLight()).intensity, 0, 'Inspector 必须接受强度 0');
      const spot = await selectedLight();
      assert.ok(Math.abs(spot.angle - Math.PI / 4) < 1e-9, 'Inspector 将聚光角度从度转换为弧度');
      assert.equal(spot.exponent, 0, 'Inspector 必须接受聚光衰减 0');
      assert.equal(spot.range, 18, 'Inspector 聚光照射范围');
      await page.screenshot({ path: path.join(output, 'spot-inspector.png'), fullPage: true });
      await page.evaluate(() => window.lightingUIStore.getState().undo());
      assert.equal((await selectedLight()).intensity, beforeZero, '撤销必须恢复修改前强度');
    }
    if (kind === 'rectArea') {
      await page.getByLabel('发光面宽度 (m)', { exact: true }).fill('4.5');
      await page.getByLabel('发光面高度 (m)', { exact: true }).fill('1.25');
      await page.getByLabel(/夜间行为/).selectOption('keep');
      const rectangle = await selectedLight();
      assert.equal(rectangle.width, 4.5, 'Inspector 矩形面宽度');
      assert.equal(rectangle.height, 1.25, 'Inspector 矩形面高度');
      assert.equal(rectangle.nightBehavior, 'keep', 'Inspector 保留夜间行为');
      await page.screenshot({ path: path.join(output, 'rect-area-inspector.png'), fullPage: true });
    }
  }
  const lightCountBeforeIBL = await page.evaluate(() => window.lightingUIStore.getState().scene.entityIds.length);
  await page.getByRole('button', { name: /^环境光 HDRI \/ IBL/ }).click();
  await page.getByPlaceholder('请输入天空盒名称...').waitFor();
  assert.equal(await page.evaluate(() => window.lightingUIStore.getState().scene.entityIds.length), lightCountBeforeIBL,
    'HDRI/IBL 卡片应进入天空盒库，不创建错误的普通光源');
  results.push({ editorUI: { cards: 6, createKinds: Object.keys(cardNames), spotParameters: true, rectangleParameters: true, undo: true, iblEntry: true } });
  await action('closeUI');
  console.log('Editor UI: 六卡缩略图、五灯创建、Inspector 参数与撤销、IBL 入口验收通过。');

  for (const kind of Object.keys(expectedClasses)) {
    const initial = await action('createCase', kind);
    assert.equal(initial.className, expectedClasses[kind], `${kind}: 必须实例化对应的 Babylon Light`);
    assert.equal(initial.visibleMarkerCount, 0, `${kind}: 预览画面不得有灯光辅助标记`);
    const inside = await action('sample', 0, -2);
    const outside = await action('sample', 7, 0);
    await capture(kind + '-lit');
    assert.ok(inside.luminance > 25, `${kind}: 实体地面必须实际受光，实际 ${inside.luminance}`);
    if (kind === 'spot') assert.ok(inside.luminance > outside.luminance + 25, '聚光灯锥内地面必须明显亮于锥外');
    if (kind === 'point') {
      const opposite = await action('sample', -7, 0);
      assert.ok(outside.luminance > 20 && opposite.luminance > 20, '点光源必须照亮左右两个方向');
    }
    if (kind === 'directional') {
      await action('patchLight', {}, { x: 0, y: 0, z: 0.65 });
      const unshadowed = await action('sample', 3.05, 0);
      await action('compareFrame', true);
      const state = await action('setShadows', true);
      const shadowed = await action('sample', 3.05, 0);
      const imageDifference = await action('compareFrame');
      await capture('directional-shadows');
      assert.equal(state.shadows, true, '方向光必须生成实时阴影：' + JSON.stringify(state));
      assert.ok(unshadowed.luminance - shadowed.luminance > 15,
        `方向光倾斜照射必须实际生成投影：${unshadowed.luminance} → ${shadowed.luminance}; ${JSON.stringify(imageDifference)}`);
      await action('setShadows', false);
      await action('patchLight', {}, { x: 0, y: 0, z: 0 });
      results.push({ kind, unshadowed, shadowed, shadowState: state, imageDifference });
    }
    if (['point', 'spot'].includes(kind)) {
      const unshadowed = await Promise.all([-3.05, 3.05].map(x => action('sample', x, 0)));
      const shadowState = await action('setShadows', true);
      const shadowed = await Promise.all([-3.05, 3.05].map(x => action('sample', x, 0)));
      await capture(kind + '-shadows');
      assert.equal(shadowState.shadows, true, `${kind}: 实时阴影必须创建生成器`);
      assert.equal(shadowState.markerCasterCount, 0, `${kind}: 阴影不得包含灯光辅助标记`);
      if (kind === 'point') assert.equal(shadowState.cubeShadow, true, '点光源必须使用六面立方体阴影贴图');
      for (let index = 0; index < shadowed.length; index++) {
        assert.ok(unshadowed[index].luminance - shadowed[index].luminance > 15,
          `${kind}: ${index === 0 ? '左' : '右'}侧遮挡物外地面应出现投影，之前 ${unshadowed[index].luminance} / 之后 ${shadowed[index].luminance}`);
      }
      results.push({ kind, unshadowed, shadowed, shadowState });
    }
    if (['hemispheric', 'rectArea'].includes(kind)) {
      const state = await action('setShadows', true);
      assert.equal(state.shadows, false, `${kind}: 不得虚假声明或生成该灯光的投射阴影`);
    }
    if (kind === 'rectArea') {
      await action('setShadows', false);
      await action('patchLight', {}, { x: Math.PI, y: 0, z: 0 });
      const away = await action('sample', 0, -2);
      await capture('rectArea-away');
      assert.ok(inside.luminance > away.luminance + 25,
        `矩形面光旋转背向地面后，地面的实际受光必须减弱：${inside.luminance} → ${away.luminance}`);
      await action('patchLight', {}, { x: 0, y: 0, z: 0 });
      results.push({ kind, inside, away });
    }
    await action('setShadows', false);
    await action('patchLight', { color: '#ff3300' });
    const colored = await action('sample', 0, -2);
    assert.ok(colored.rgb[0] > colored.rgb[1] + 20 && colored.rgb[1] > colored.rgb[2], `${kind}: 灯光颜色必须改变实际地面颜色`);
    await action('patchLight', { color: '#ffffff', intensity: 0 });
    assert.ok((await action('sample', 0, -2)).luminance < 10, `${kind}: 强度为 0 时必须停止实际照明`);
    await action('patchLight', { intensity: initial.intensity });
    if (['point', 'spot'].includes(kind)) {
      await action('patchLight', { range: 3 });
      assert.ok((await action('sample', 0, -2)).luminance < 10, `${kind}: 超出照射范围的地面必须变暗`);
      await action('patchLight', { range: 30 });
    }
    if (kind === 'spot') {
      await action('patchLight', { angle: Math.PI / 12 });
      assert.ok((await action('sample', 0, -2)).luminance < 10, '缩小聚光角度必须缩小实际光斑');
      await action('patchLight', { angle: Math.PI / 3 });
    }
    if (kind === 'rectArea') {
      await action('patchLight', { width: 0.5, height: 0.5 });
      const smaller = await action('sample', 0, -2);
      assert.ok(inside.luminance > smaller.luminance + 20, '减小发光面的宽高必须减少实际受光量');
      await action('patchLight', { width: 3, height: 2 });
    }
    const persistedParameters = { color: '#ffd6a3', intensity: 0.6, range: 18, nightBehavior: 'keep' };
    if (kind === 'spot') Object.assign(persistedParameters, { angle: Math.PI / 4, exponent: 0 });
    if (kind === 'rectArea') Object.assign(persistedParameters, { width: 4.5, height: 1.25 });
    await action('patchLight', persistedParameters,
      ['directional', 'spot', 'rectArea'].includes(kind) ? { x: 0.15, y: -0.3, z: 0.2 } : undefined);
    const roundtrip = await action('roundtrip');
    assert.deepEqual(roundtrip.after.component, roundtrip.before.component, `${kind}: 保存重载不得丢失灯光参数`);
    assert.deepEqual(roundtrip.after.transform, roundtrip.before.transform, `${kind}: 保存重载不得丢失位置/方向`);
    assert.equal(roundtrip.after.className, expectedClasses[kind], `${kind}: 保存重载保持灯光类型`);
    const lifecycle = await action('lifecycle');
    assert.equal(lifecycle.preview.visibleMarkerCount, 0, `${kind}: 运行预览不显示辅助标记`);
    if (kind !== 'hemispheric') assert.ok(lifecycle.edit.visibleMarkerCount > 0, `${kind}: 编辑模式应有辅助标记`);
    assert.equal(lifecycle.hidden.enabled, false, `${kind}: 隐藏实体必须禁用光源`);
    assert.ok(lifecycle.hiddenPixel.luminance < 10, `${kind}: 隐藏光源后地面必须实际变暗`);
    assert.equal(lifecycle.persisted.enabled, false, `${kind}: 保存重载保留隐藏状态`);
    assert.equal(lifecycle.deleted.className, undefined, `${kind}: 删除后不得残留 Babylon Light`);
    assert.equal(lifecycle.deleted.markerCount, 0, `${kind}: 删除后不得残留辅助 Mesh`);
    assert.equal(lifecycle.disposed, true, `${kind}: 删除释放灯光资源`);
    results.push({ kind, inside, outside, lifecycle });
    console.log(`${kind}: 实际照明、保存重载、隐藏/预览/删除验收通过。`);
  }
  assert.deepEqual(errors, [], '页面不得出现运行异常');
  assert.deepEqual(externalRequests, [], '光源验收必须完全使用本地资源');
  await writeFile(path.join(output, 'results.json'), JSON.stringify({ results, errors, externalRequests }, null, 2));
  await Promise.all(['failure.json', 'failure.png'].map(name => rm(path.join(output, name), { force: true })));
  await action('dispose');
  console.log('Lighting types Chrome/WebGL smoke passed. Evidence: ' + output);
} catch (error) {
  if (page) await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true });
  await writeFile(path.join(output, 'failure.json'), JSON.stringify({ message: String(error), results, errors, externalRequests }, null, 2));
  throw error;
} finally {
  await browser?.close();
  await server.close();
}
