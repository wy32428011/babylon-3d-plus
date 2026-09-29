import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { build } from 'vite';
import { chromium } from 'playwright';

const output = path.resolve('output/opening-package-editor');
const map = '<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900" viewBox="0 0 1600 900"><rect width="1600" height="900" fill="#0b2032"/><g fill="#204c64" stroke="#428baa" stroke-width="4"><rect x="160" y="130" width="360" height="220"/><rect x="880" y="160" width="420" height="180"/><rect x="280" y="550" width="500" height="200"/></g><path d="M0 430H1600M700 0V900" stroke="#4b7385" stroke-width="26"/></svg>';
await mkdir(output, { recursive: true });
const siteRoot = path.join(output, 'site');
await build({ configFile: false, logLevel: 'warn', publicDir: false, cacheDir: path.join(output, '.vite-build'), build: {
  outDir: siteRoot, emptyOutDir: true, target: 'esnext', minify: false, assetsInlineLimit: 0,
  rollupOptions: { input: path.resolve('tests/fixtures/openingPackageEditor.html') },
} });
const migrationRoot = path.resolve('output/opening-packages/reference-huishan-1.1.0');
const migrationDefinition = Object.fromEntries(await Promise.all(Object.entries({ manifest:'manifest.json', schema:'config.schema.json', uiSchema:'ui.schema.json', defaults:'defaults.json', timeline:'timeline.json' })
  .map(async ([key, file]) => [key, JSON.parse(await readFile(path.join(migrationRoot, file), 'utf8'))])));
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
  if (pathname === '/__opening_pkg__/reference-definition.json') { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(migrationDefinition)); return; }
  if (/^\/__opening_migration__\/assets\/asset-(?:10|[1-9])\.webp$/.test(pathname)) { response.setHeader('Content-Type', 'image/webp'); response.end(await readFile(path.join(migrationRoot, 'assets', path.basename(pathname)))); return; }
  if (pathname === '/__opening_pkg__/assets/map.svg') { response.setHeader('Content-Type', 'image/svg+xml'); response.end(map); return; }
  if (/^\/__opening_pkg__\/assets\/ref-\d+\.svg$/.test(pathname)) {
    response.setHeader('Content-Type', 'image/svg+xml'); response.end(pathname.endsWith('ref-6.svg') ? map.replace('width="1600" height="900" viewBox="0 0 1600 900"', 'width="1200" height="800" viewBox="0 0 1600 900"') : map); return;
  }
  if (pathname === '/favicon.ico') { response.statusCode = 204; response.end(); return; }
  const filename = path.resolve(siteRoot, `.${decodeURIComponent(pathname)}`);
  if (!filename.startsWith(`${siteRoot}${path.sep}`)) { response.statusCode = 403; response.end(); return; }
  try {
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp' };
    response.setHeader('Content-Type', types[path.extname(filename)] ?? 'application/octet-stream'); response.end(await readFile(filename));
  } catch { response.statusCode = 404; response.end(); }
});
let browser, page;
const errors = [];
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); browser = await chromium.launch({ channel: 'chrome', headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
  await page.goto(`http://127.0.0.1:${server.address().port}/tests/fixtures/openingPackageEditor.html`, { waitUntil: 'commit', timeout: 120000 });
  await page.getByRole('button', { name: '导入开场包', exact: true }).waitFor({ timeout: 120000 });
  console.log('开场包配置面板已加载');
  const panel = page.locator('.scene-opening-animation-panel');
  const prepared = () => page.waitForFunction(() => window.openingPackageHarness.preparation().completed, null, { timeout: 60000 });
  await prepared();
  const read = () => page.evaluate(() => window.openingPackageHarness.store.getState().scene.sceneSettings.openingAnimation);
  const edit = async (label, value, parent = panel) => { const input = parent.getByLabel(label, { exact: true }); await input.fill(value); await input.blur(); };
  const expand = async (matcher, parent = panel) => { const summary = parent.locator('summary').filter({ hasText: matcher });
    assert.equal(await summary.count(), 1); if (!await summary.evaluate(element => element.parentElement.open)) await summary.click(); return summary.locator('..'); };
  assert.equal(await panel.getByLabel('进入场景时播放', { exact: true }).count(), 0, '无包时没有开场参数');
  assert.equal(await read(), undefined);
  await panel.getByRole('button', { name: '导入开场包', exact: true }).click();
  await panel.getByRole('status').filter({ hasText: '已导入工程资源库' }).waitFor();
  assert.equal(await read(), undefined, '导入包不自动创建场景配置');
  await panel.getByRole('button', { name: '应用到当前场景', exact: true }).click();
  assert.equal((await read()).template, 'package', await panel.innerText());
  assert.equal(await panel.locator('summary').filter({ hasText: /^科技呼吸效果$/ }).count(), 0, '通用包隐藏不支持的全局呼吸配置');
  await panel.getByLabel('进入场景时播放', { exact: true }).check();
  await edit('公司标题', '场景 A 专属 <b>文字</b>');
  await panel.getByLabel('显示标识', { exact: true }).uncheck(); await edit('计数参数', '0');
  assert.equal((await read()).package.config.values.count, 0); assert.equal((await read()).package.config.values.show, false);
  const titleInput = panel.getByLabel('公司标题', { exact: true }); await titleInput.fill('不应保存'); await titleInput.press('Escape');
  assert.equal((await read()).package.config.values.title, '场景 A 专属 <b>文字</b>');
  const first = await expand(/^1\. 品牌亮相/); await edit('分镜时长（秒）', '0', first);
  const style = await expand(/^标题样式$/, first); await edit('标题字号', '72', style); await edit('标题位置 X', '0', style);
  await first.getByRole('button', { name: '复制分镜', exact: true }).click();
  assert.equal((await read()).package.config.stages.length, 4);
  const duplicate = await expand(/^2\. 品牌亮相 副本/); await duplicate.getByRole('button', { name: '下移分镜', exact: true }).click();
  assert.equal((await read()).package.config.stages[2].label, '品牌亮相 副本');
  await (await expand(/^3\. 品牌亮相 副本/)).getByRole('button', { name: '删除分镜', exact: true }).click();
  const campus = await expand(/^2\. 园区飞线/); const routes = await expand(/^飞线与点位/, campus);
  await campus.getByLabel('分镜底图', { exact: true }).selectOption('');
  assert.equal(Object.hasOwn((await read()).package.config.stages[1], 'backgroundAssetId'), false, '清空底图必须删除JSON可选键');
  await campus.getByLabel('分镜底图', { exact: true }).selectOption('map');
  await routes.getByRole('button', { name: '拾取终点', exact: true }).click();
  const mapBox = await routes.getByRole('group', { name: '飞线 UV 底图', exact: true }).boundingBox();
  await page.mouse.click(mapBox.x + mapBox.width * .4, mapBox.y + mapBox.height * .3);
  let route = (await read()).package.config.stages[1].routes[0]; assert.ok(Math.abs(route.to.x - .4) < .01); assert.ok(Math.abs(route.to.y - .3) < .01);
  const beforeDrag = structuredClone(route.to);
  const endpoint = routes.getByRole('button', { name: '一号仓库终点', exact: true }); await endpoint.scrollIntoViewIfNeeded();
  const endpointBox = await endpoint.boundingBox(), currentMap = await routes.getByRole('group', { name: '飞线 UV 底图', exact: true }).boundingBox();
  await page.mouse.move(endpointBox.x + endpointBox.width / 2, endpointBox.y + endpointBox.height / 2); await page.mouse.down();
  await page.mouse.move(currentMap.x + currentMap.width * .82, currentMap.y + currentMap.height * .75, { steps: 5 }); await page.mouse.up();
  route = (await read()).package.config.stages[1].routes[0]; assert.ok(Math.abs(route.to.x - .82) < .01);
  await page.evaluate(() => window.openingPackageHarness.store.getState().undo());
  assert.deepEqual((await read()).package.config.stages[1].routes[0].to, beforeDrag, '一次拖动只需一次撤销');
  await page.evaluate(() => window.openingPackageHarness.store.getState().redo());
  await edit('流动速度', '0', routes); await routes.getByLabel('点位脉冲', { exact: true }).uncheck();
  await routes.getByRole('button', { name: '添加飞线', exact: true }).click(); assert.equal((await read()).package.config.stages[1].routes.length, 2);
  await routes.getByRole('button', { name: '删除所选飞线', exact: true }).click();
  const assets = await expand(/^场景独立素材/); await assets.getByRole('button', { name: '替换素材 map', exact: true }).click();
  await page.waitForFunction(() => Boolean(window.openingPackageHarness.store.getState().scene.sceneSettings.openingAnimation.package.config.assetOverrides?.map));
  const sceneA = await page.evaluate(() => window.openingPackageHarness.save());
  const expectedA = await read();
  await page.screenshot({ path: path.join(output, 'configured.png'), fullPage: true });
  console.log('配置、分镜、UV和素材交互已通过，准备真实开场预览');
  await prepared();
  await page.evaluate(() => window.openingPackageHarness.startBusinessProbe());
  const beforeOpeningBusiness = await page.evaluate(() => window.openingPackageHarness.businessState());
  await panel.getByRole('button', { name: '预览开场动画', exact: true }).click();
  const player = page.locator('[aria-label="开场动画播放器"]');
  await player.waitFor({ state: 'visible', timeout: 30000 });
  await player.getByRole('button', { name: '暂停', exact: true }).click();
  const progress = player.getByLabel('开场播放进度', { exact: true });
  const paused = await progress.inputValue(); await page.waitForTimeout(180); assert.equal(await progress.inputValue(), paused);
  const progressBox = await progress.boundingBox(); await progress.click({ position: { x: progressBox.width * .35, y: progressBox.height / 2 } });
  const pixelRange = await player.locator('canvas').evaluate(canvas => {
    const values = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data; let min = 255, max = 0;
    for (let i = 0; i < values.length; i += 4) { min = Math.min(min, values[i]); max = Math.max(max, values[i]); } return max - min;
  });
  assert.ok(pixelRange > 20, '真实开场Canvas必须绘制底图和飞线');
  await page.screenshot({ path: path.join(output, 'preview.png') });
  const duringOpeningBusiness = await page.evaluate(() => window.openingPackageHarness.businessState());
  assert.equal(duringOpeningBusiness.sceneId, beforeOpeningBusiness.sceneId);
  assert.ok(duringOpeningBusiness.frames > beforeOpeningBusiness.frames + 2, '开场暂停不能停止三维帧循环');
  assert.ok(duringOpeningBusiness.alpha > beforeOpeningBusiness.alpha, '独立预览不能重置或停止业务相机');
  await page.getByRole('button', { name: /^关闭开场预览/ }).click();
  await page.evaluate(() => window.openingPackageHarness.stopBusinessProbe());
  await player.waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(() => window.openingPackageHarness.save()), sceneA, '预览不修改已保存配置');
  console.log('UV编辑与真实预览已通过');
  await page.evaluate(() => window.openingPackageHarness.createScene('场景 B'));
  await prepared();
  await panel.getByRole('button', { name: '应用到当前场景', exact: true }).click();
  assert.equal((await read()).package.config.values.title, '智慧园区', '另一场景应用同包使用独立默认值');
  await edit('公司标题', '场景 B');
  assert.equal(await page.evaluate(() => window.openingPackageHarness.original.config.values.title), '智慧园区', '场景编辑不污染资源包');
  await page.evaluate(value => window.openingPackageHarness.reopen(value), sceneA);
  await prepared();
  assert.deepEqual(await read(), expectedA, '保存重开保留完整包配置');
  await page.evaluate(() => { const store = window.openingPackageHarness.store, opening = store.getState().scene.sceneSettings.openingAnimation;
    store.getState().updateSceneOpeningAnimation({ package: { ...opening.package, manifestUrl: new URL('/missing/manifest.json', location.href).href } }); });
  await panel.getByRole('button', { name: '重新关联并保留配置', exact: true }).click();
  assert.deepEqual((await read()).package.config, expectedA.package.config, '同版重新关联保留全部自定义配置');
  assert.equal((await read()).package.manifestUrl, expectedA.package.manifestUrl, '重新关联使用工程库中的新路径');
  await panel.getByLabel('开场包版本', { exact: true }).selectOption({ label: '品牌与园区 · 1.1.0' });
  await panel.getByRole('button', { name: '升级并保留兼容配置', exact: true }).click();
  assert.equal((await read()).package.version, '1.1.0'); assert.equal((await read()).package.config.values.title, expectedA.package.config.values.title);
  await panel.getByLabel('开场包版本', { exact: true }).selectOption({ label: '另一套开场 · 1.0.0' });
  await panel.getByRole('button', { name: '应用到当前场景', exact: true }).click();
  assert.equal((await read()).package.config.stages.length, 2, '不同包不固定九阶段');
  await panel.getByText('当前场景：另一套开场 · 1.0.0 · dddddddddddd', { exact: true }).waitFor();
  await edit('公司标题', '');
  await page.waitForFunction(() => window.openingPackageHarness.store.getState().scene.sceneSettings.openingAnimation.package.config.values.title === '', null, { timeout: 3000 });
  assert.equal((await read()).package.config.values.title, '', await panel.innerText());
  await page.evaluate(() => { const store = window.openingPackageHarness.store, opening = store.getState().scene.sceneSettings.openingAnimation;
    store.getState().updateSceneOpeningAnimation({ package: { ...opening.package, contentHash: 'f'.repeat(64) } }); });
  await panel.getByRole('alert').filter({ hasText: '当前场景引用的开场包缺失或不可用' }).waitFor();
  assert.equal((await read()).package.config.values.title, '', '包缺失时不覆盖用户配置');
  await panel.getByLabel('开场包版本', { exact: true }).selectOption({ label: '参考整图 UV · 1.0.0' });
  await panel.getByRole('button', { name: '应用到当前场景', exact: true }).click();
  const referenceStage = await expand(/^6\. 参考阶段 6/); const referenceRoutes = await expand(/^飞线与点位/, referenceStage);
  await referenceRoutes.getByRole('img', { name: '飞线底图', exact: true }).evaluate(image => image.decode());
  const referenceMap = referenceRoutes.getByRole('group', { name: '飞线 UV 底图', exact: true });
  await referenceMap.scrollIntoViewIfNeeded();
  const referenceBounds = await referenceMap.boundingBox(); assert.ok(Math.abs(referenceBounds.width / referenceBounds.height - 1.5) < .02, '参考国内图保留3:2完整原图');
  await referenceRoutes.getByRole('button', { name: '拾取终点', exact: true }).click();
  const referenceClick = await referenceMap.boundingBox();
  await page.mouse.click(referenceClick.x + referenceClick.width * .4, referenceClick.y + referenceClick.height * .1);
  assert.ok(Math.abs((await read()).package.config.stages[5].routes[0].to.y - .1) < .01, '3:2参考图点击位置与整图UV一致');
  assert.equal(await panel.getByRole('button', { name: '复制分镜', exact: true }).count(), 0, '参考包保持固定九阶段');
  assert.equal(await panel.locator('summary').filter({ hasText: /^科技呼吸效果$/ }).count(), 0, '包未声明呼吸配置时不能出现全局硬编码参数');
  await page.screenshot({ path: path.join(output, 'reference-uv.png') });
  await page.evaluate(() => { const store = window.openingPackageHarness.store; store.getState().updateSceneOpeningAnimation({ template: 'package', package: { id: 'broken' } }); });
  await panel.getByRole('alert').filter({ hasText: '原配置已保留' }).waitFor();
  assert.equal((await read()).package.id, 'broken');
  await page.evaluate(() => { window.openingPackageHarness.createScene('场景 C'); window.openingPackageHarness.defer(); });
  await prepared();
  await panel.getByRole('button', { name: '导入开场包', exact: true }).click();
  await page.evaluate(() => { window.openingPackageHarness.createScene('场景 D'); window.openingPackageHarness.release(); });
  await prepared();
  await panel.getByRole('button', { name: '应用到当前场景', exact: true }).waitFor();
  assert.equal(await read(), undefined, '跨场景返回的导入结果不能创建开场配置');
  const legacyConfig = await page.evaluate(() => {
    const h = window.openingPackageHarness, legacy = h.makeLegacy(); legacy.enabled = true;
    legacy.reference.brandName = '迁移品牌'; legacy.reference.companyName = '迁移公司';
    legacy.reference.stageDurations[2] = 0; legacy.reference.worldDestinations = []; legacy.breathingIntensity = 0;
    h.store.getState().updateSceneOpeningAnimation(legacy); return legacy;
  });
  await panel.getByRole('status').filter({ hasText: '旧内置开场待迁移' }).waitFor();
  assert.equal(await panel.getByLabel('进入场景时播放', { exact: true }).count(), 0, '旧配置未迁移不能显示播放参数');
  await panel.getByLabel('开场包版本', { exact: true }).selectOption({ label: '地球到惠山 · 参考开场 · 1.1.0' });
  await panel.getByRole('button', { name: '迁移旧配置到此包', exact: true }).click();
  await panel.getByLabel('品牌名称', { exact: true }).waitFor();
  const migrated = await read();
  assert.equal(migrated.package.config.values.brandName, '迁移品牌');
  assert.equal(migrated.package.config.values.companyName, '迁移公司');
  assert.equal(migrated.package.config.values.breathingIntensity, 0);
  assert.equal(migrated.package.config.stages[2].durationSeconds, 0);
  assert.deepEqual(migrated.package.config.stages[2].routes, []);
  assert.equal(migrated.reference, undefined);
  await page.evaluate(() => window.openingPackageHarness.store.getState().undo());
  assert.deepEqual(await read(), legacyConfig, '迁移撤销应恢复原始旧配置');
  await panel.getByRole('button', { name: '解除当前场景的开场绑定', exact: true }).click();
  assert.equal(await read(), undefined);
  assert.equal(await panel.getByLabel('品牌名称', { exact: true }).count(), 0);
  assert.deepEqual(errors, []);
  const report = { passed: true, checks: ['无包不显示或保存配置', '旧配置显式迁移与撤销、解除绑定', '导入与应用分离', 'schema文字/零值/开关', 'Escape取消草稿', '分镜零时长/样式/复制/排序/删除',
    'UV点击拾点与拖动', '拖动一次撤销', '飞线新增删除及零速度/关闭脉冲', '场景素材覆盖', '多场景同包配置隔离',
    '独立预览/暂停/退出不改配置，三维帧循环与业务相机持续运行', '保存重开', '同版路径重新关联保留配置', '版本升级保留参数', '不同包阶段数量', '显式空字符串',
    '缺失包保留与错误提示', '参考包3:2整图拾点与九段能力限制', '损坏包保留与错误提示', '异步导入跨场景隔离'], errors };
  await writeFile(path.join(output, 'verification.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} catch (error) {
  if (page) { await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {}); await writeFile(path.join(output, 'failure.txt'), await page.locator('body').innerText().catch(() => '页面不可用')); }
  console.error(error); throw error;
}
finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
