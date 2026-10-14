import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { build } from 'vite';
import { createServer } from 'node:http';
import { chromium } from 'playwright';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'composition-array-ui-'));
const output = path.resolve('output/playwright/composition-array');
await fs.mkdir(output, { recursive: true });
let server, browser, page;
const errors = [], checks = [];
const snapshot = () => page.evaluate(() => JSON.parse(window.compositionArrayHarness.save()).scene);
async function reset() {
  await page.evaluate(() => window.compositionArrayHarness.reopen(window.compositionArrayHarness.seed));
  await page.waitForFunction(() => window.compositionArrayHarness.ready(), null, { timeout: 180000 });
  await page.evaluate(() => window.compositionArrayHarness.camera());
}
async function openArray() {
  await page.getByText('阵列设备1', { exact: true }).first().click({ button: 'right' });
  const menu = page.getByRole('menuitem', { name: '模型阵列', exact: true });
  assert.equal(await menu.isDisabled(), false, '单个组合根必须允许右键模型阵列');
  await menu.click(); await page.getByRole('dialog', { name: '模型阵列', exact: true }).waitFor();
}
async function pixels(name) {
  const png = await page.locator('.scene-canvas').screenshot({ path: path.join(output, name + '.png') });
  const count = await page.evaluate(async value => {
    const image = new Image(); image.src = 'data:image/png;base64,' + value; await image.decode();
    const c = document.createElement('canvas'); c.width = image.width; c.height = image.height;
    const ctx = c.getContext('2d'); ctx.drawImage(image, 0, 0); const data = ctx.getImageData(0, 0, c.width, c.height).data;
    let n = 0; for (let i = 0; i < data.length; i += 4) if (data[i + 2] > 60 && data[i + 2] > data[i] * 1.15 && data[i + 2] > data[i + 1] * 1.01) n++;
    return n;
  }, png.toString('base64'));
  assert.ok(count > 100, name + ' 必须绘制真实模型像素'); return count;
}
try {
  const webRoot = path.join(directory, 'web');
  await build({ publicDir: false, logLevel: 'error', cacheDir: path.join(directory, 'vite-cache'),
    build: { outDir: webRoot, emptyOutDir: true, rollupOptions: { input: path.resolve('tests/fixtures/composition-array.harness.tsx'), output: { entryFileNames: 'harness.js' } } } });
  const css = (await fs.readdir(path.join(webRoot, 'assets'))).filter(name => name.endsWith('.css'));
  const html = '<!doctype html><html><head><meta charset="utf-8">' + css.map(name => '<link rel="stylesheet" href="/assets/' + name + '">').join('') + '</head><body><div id="root"></div><script type="module" src="/harness.js"></script></body></html>';
  server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname === '/__composition_array__') { response.setHeader('content-type', 'text/html'); response.end(html); return; }
      const root = url.pathname.startsWith('/builtin-model-packages/') ? path.resolve('public') : webRoot;
      const file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
      if (!file.startsWith(root + path.sep)) { response.writeHead(403); response.end(); return; }
      const type = { '.js': 'text/javascript', '.css': 'text/css', '.glb': 'model/gltf-binary', '.png': 'image/png' }[path.extname(file)] ?? 'application/octet-stream';
      const content = await fs.readFile(file); response.setHeader('content-type', type); response.end(content);
    } catch { response.writeHead(404); response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  page = await browser.newPage({ viewport: { width: 1600, height: 1000 } }); page.setDefaultTimeout(30000);
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(asset => { window.compositionArrayAsset = asset; window.editorApi = { prepareLocalSceneResources: async () => ({ configured: true, sourceKey: 'array-fixture', modelAssets: [], environmentAssets: [], modelReplacements: [], issues: [], warnings: [] }) }; }, path.resolve('public/builtin-model-packages/virtual-conveyor/virtual-conveyor.glb'));
  await page.goto('http://127.0.0.1:' + server.address().port + '/__composition_array__', { waitUntil: 'commit' });
  await page.waitForFunction(() => window.compositionArrayHarness?.ready(), null, { timeout: 30000 });
  await page.evaluate(() => window.compositionArrayHarness.camera());
  await openArray(); checks.push('composition-context-menu');
  if (process.env.COMPOSITION_ARRAY_RED_ONLY === '1') { console.log('PASS: 单组合模型右键阵列可用'); }
  else {
    const dialog = page.getByRole('dialog', { name: '模型阵列', exact: true });
    await dialog.getByText('内部成员自动生成新编号', { exact: false }).waitFor();
    assert.equal(await dialog.getByLabel('资产编号规则', { exact: true }).count(), 0);
    await page.keyboard.press('Escape');
    const before = await snapshot();
    const source = Object.values(before.entities).find(e => e.composition);
    for (const direction of ['x', '-x', 'y', '-y', 'z', '-z']) {
      await reset(); await openArray();
      const axis = direction.replace('-', ''), sign = direction.startsWith('-') ? -1 : 1;
      const span = await page.evaluate(({ ids, axis }) => {
        const points = window.compositionArrayHarness.scene().meshes.filter(m => ids.includes(m.metadata?.editorEntityId) && m.getTotalVertices() > 0 && m.isEnabled()).flatMap(m => { m.computeWorldMatrix(true); return m.getBoundingInfo().boundingBox.vectorsWorld.map(v => v[axis]); });
        if (!points.length) throw Error('组合实际几何未加载'); return Math.max(...points) - Math.min(...points);
      }, { ids: source.childrenIds, axis });
      await dialog.getByLabel('副本数量', { exact: true }).fill('2');
      await dialog.getByRole('combobox').selectOption(direction);
      await dialog.getByLabel('阵列净间距(m)', { exact: true }).fill('0.5');
      await dialog.getByRole('button', { name: '确认', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
      const after = await snapshot(), roots = Object.values(after.entities).filter(e => e.composition);
      assert.equal(roots.length, 3); assert.equal(after.selectedEntityId, source.id);
      assert.equal(new Set(roots.map(e => e.composition.instanceId)).size, 3);
      const codes = Object.values(after.entities).filter(e => e.components.modelAsset).map(e => e.components.modelAsset.assetCode);
      assert.equal(new Set(codes).size, codes.length);
      for (const root of roots) assert.equal(root.childrenIds.length, 3);
      const copy = roots.find(e => e.id !== source.id);
      const delta = copy.components.transform.position[axis] - source.components.transform.position[axis]; assert.ok(Math.abs(delta * sign - span - .5) < 1e-4, '整组实际跨度与净间距必须一致');
      for (let i = 0; i < source.childrenIds.length; i++) {
        const a = before.entities[source.childrenIds[i]], b = after.entities[copy.childrenIds[i]];
        for (const coordinate of ['x', 'y', 'z']) assert.ok(Math.abs(b.components.transform.position[coordinate] - a.components.transform.position[coordinate] - (coordinate === axis ? delta : 0)) < 1e-5);
      }
      await page.evaluate(() => window.compositionArrayHarness.store.getState().undo()); assert.deepEqual(await snapshot(), before);
      await page.evaluate(() => window.compositionArrayHarness.store.getState().redo()); assert.deepEqual(await snapshot(), after);
      checks.push('menu-' + direction + '-undo-redo');
    }
    await pixels('array-six-directions-final');
    const saved = await page.evaluate(() => window.compositionArrayHarness.save());
    await fs.writeFile(path.join(output, 'scene.scene.json'), saved, 'utf8');
    await page.evaluate(content => window.compositionArrayHarness.reopen(content), saved);
    await page.waitForFunction(() => window.compositionArrayHarness.ready());
    assert.deepEqual(await snapshot(), { ...JSON.parse(saved).scene, selectedEntityId: null }); checks.push('save-reopen');
    await reset(); await openArray(); await page.keyboard.press('Escape'); assert.deepEqual(await snapshot(), before); checks.push('cancel-atomic');
    const meshCount = await page.evaluate(() => window.compositionArrayHarness.scene().meshes.length);
    // 从真实 Babylon Gizmo 网格计算抓取位置，随后只用鼠标事件执行拖轴。
    const locateDrag = () => page.evaluate(() => {
      const h = window.compositionArrayHarness;
      const utility = h.engines.Instances.flatMap(e => [...e.scenes, ...(e._virtualScenes ?? [])]).find(s => s !== h.scene() && s.transformNodes.some(n => n.name === 'arrow'));
      if (!utility) throw Error('没有可拾取的真实 Gizmo 轴');
      const candidates = utility.meshes.filter(m => m.isPickable && m.isEnabled() && m.getTotalVertices() > 0);
      const red = candidates.find(m => m.name === 'cylinder' && m.material?.diffuseColor?.r >= .49 && m.material.diffuseColor.g < .1 && m.material.diffuseColor.b < .1);
      if (!red) throw Error('没有可拾取的 X 轴');
      red.computeWorldMatrix(true); const start = red.getBoundingInfo().boundingBox.centerWorld;
      const end = start.add(new start.constructor(8, 0, 0));
      return { start: h.project(start, utility), end: h.project(end, utility), name: red.name };
    });
    const drag = await locateDrag();
    await page.keyboard.down('Shift'); await page.mouse.move(drag.start.x, drag.start.y); await page.mouse.down();
    await page.mouse.move((drag.start.x + drag.end.x) / 2, (drag.start.y + drag.end.y) / 2, { steps: 12 });
    await pixels('shift-drag-middle');
    assert.ok(await page.evaluate(() => window.compositionArrayHarness.scene().meshes.length) > meshCount, '拖动中间帧必须存在组合预览几何');
    assert.deepEqual(await snapshot(), before, '拖动预览不得写入场景');
    await page.mouse.move(drag.end.x, drag.end.y, { steps: 12 }); await page.mouse.up(); await page.keyboard.up('Shift');
    await dialog.waitFor(); await pixels('shift-drag-final-preview');
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    assert.deepEqual(await snapshot(), before); assert.equal(await page.evaluate(() => window.compositionArrayHarness.scene().meshes.length), meshCount, '取消必须释放临时组合网格');
    checks.push('shift-cancel-clears-geometry');
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const nextDrag = await locateDrag();
    await page.keyboard.down('Shift'); await page.mouse.move(nextDrag.start.x, nextDrag.start.y); await page.mouse.down(); await page.mouse.move(nextDrag.end.x, nextDrag.end.y, { steps: 24 }); await page.mouse.up(); await page.keyboard.up('Shift'); await dialog.waitFor();
    await dialog.getByLabel('副本数量', { exact: true }).fill('2'); await dialog.getByRole('button', { name: '确认', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' }); assert.equal(Object.values((await snapshot()).entities).filter(e => e.composition).length, 3);
    checks.push('real-mouse-shift-drag'); assert.deepEqual(errors, []);
    await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ status: 'PASS', checks, errors, drag }, null, 2));
    console.log('PASS: 组合阵列六方向、独立身份、撤销重做、保存重开与真实 Shift 拖轴');
  }
} catch (error) {
  if (page) { await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {}); await fs.writeFile(path.join(output, 'failure.json'), JSON.stringify({ error: String(error), errors, checks, state: await page.evaluate(() => ({ text: document.body.innerText, logs: window.compositionArrayHarness?.store.getState().logs.slice(0, 8), scenes: window.compositionArrayHarness?.engines.Instances.flatMap(e => e.scenes).map(s => ({ frame: s.getFrameId(), nodes: s.transformNodes.map(n => n.name), meshes: s.meshes.map(m => ({ name: m.name, id: m.metadata?.editorEntityId, vertices: m.getTotalVertices(), enabled: m.isEnabled() })) })) })) }, null, 2)); }
  throw error;
} finally {
  await browser?.close(); if (server) await new Promise(resolve => server.close(resolve));
  const resolved = path.resolve(directory); assert.equal(path.dirname(resolved), path.resolve(os.tmpdir())); assert.ok(path.basename(resolved).startsWith('composition-array-ui-'));
  await fs.rm(resolved, { recursive: true, force: true });
}
