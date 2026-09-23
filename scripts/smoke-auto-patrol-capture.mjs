import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const output = path.resolve('output/playwright/auto-patrol-capture');
await mkdir(output, { recursive: true });
const server = await createServer({ server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false } });
let browser, page;
const pageErrors = [];
const checks = [];

function assertVector(actual, expected, message) {
  for (const axis of ['x', 'y', 'z']) {
    assert.ok(Math.abs(actual[axis] - expected[axis]) < 1e-5, `${message}.${axis}: ${actual[axis]} != ${expected[axis]}`);
  }
}

try {
  await server.listen();
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  page = await browser.newPage({ viewport: { width: 1500, height: 1050 } });
  page.setDefaultTimeout(30000);
  page.on('pageerror', error => pageErrors.push(error.message));
  const html = await server.transformIndexHtml('/__auto_patrol_capture__', '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="/tests/fixtures/autoPatrolCapture.harness.tsx"></script></body></html>');
  await page.route('**/__auto_patrol_capture__', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto(server.resolvedUrls.local[0] + '__auto_patrol_capture__', { waitUntil: 'commit' });
  await page.getByRole('button', { name: '+ 添加点位', exact: true }).waitFor({ timeout: 180000 });
  await page.waitForFunction(() => window.autoPatrolCaptureHarness?.camera()?.getScene().isReady(), null, { timeout: 120000 });
  await page.waitForFunction(() => window.autoPatrolCaptureHarness.preparation().completed, null, { timeout: 120000 });
  const canvas = page.locator('.scene-canvas');

  const settle = async () => {
    await page.evaluate(() => new Promise((resolve, reject) => {
      let previous = '', stable = 0, frames = 0;
      const next = () => {
        const current = JSON.stringify(window.autoPatrolCaptureHarness.snapshot());
        stable = current === previous ? stable + 1 : 0;
        previous = current;
        if (stable >= 5) return resolve();
        if (++frames > 500) return reject(new Error('相机未达到稳定帧'));
        requestAnimationFrame(next);
      };
      requestAnimationFrame(next);
    }));
  };
  const gesture = async (dx, dy, wheel = 0) => {
    const box = await canvas.boundingBox();
    const x = box.x + box.width * 0.55, y = box.y + box.height * 0.45;
    await page.mouse.move(x, y);
    await page.mouse.down({ button: 'right' });
    await page.mouse.move(x + dx, y + dy, { steps: 8 });
    await page.mouse.up({ button: 'right' });
    if (wheel) await page.mouse.wheel(0, wheel);
    await settle();
  };
  const snapshot = () => page.evaluate(() => window.autoPatrolCaptureHarness.snapshot());
  const checkCapture = async (name, index, count, expected) => {
    await page.waitForFunction(count => {
      const h = window.autoPatrolCaptureHarness;
      return !h.store.getState().autoPatrolCameraRequest && h.waypoints().length === count;
    }, count);
    const points = await page.evaluate(() => window.autoPatrolCaptureHarness.waypoints());
    assertVector(points[index].world.position, expected.position, `${name}相机位置`);
    assertVector(points[index].world.target, expected.target, `${name}观察目标`);
    assert.ok(Math.abs(points[index].world.radius - expected.radius) < 1e-5, `${name}观察距离`);
    const current = await snapshot();
    assertVector(current.position, expected.position, `${name}不移动当前相机`);
    checks.push({ name, position: points[index].world.position, target: points[index].world.target });
    return points[index];
  };

  await settle();
  await page.evaluate(() => window.autoPatrolCaptureHarness.setPose({ alpha: -1.1, beta: 0.95, radius: 35, target: { x: 2, y: 4, z: 0 } }));
  const beforeGesture = await snapshot();
  await gesture(70, -30, -100);
  let expected = await snapshot();
  assert.notDeepEqual(expected.position, beforeGesture.position, '真实鼠标操作必须改变编辑器相机');
  await page.keyboard.press('F1');
  await checkCapture('F1 新增', 0, 1, expected);

  await gesture(-110, 35, 100);
  expected = await snapshot();
  await page.getByRole('button', { name: '+ 添加点位', exact: true }).click();
  let point = await checkCapture('按钮新增', 1, 2, expected);
  const originalId = point.id;

  await gesture(50, -40);
  expected = await snapshot();
  await page.keyboard.press('F1');
  point = await checkCapture('F1 覆盖', 1, 2, expected);
  assert.equal(point.id, originalId, 'F1 覆盖保留节点 ID');

  await gesture(-60, 20);
  expected = await snapshot();
  await page.getByRole('button', { name: '使用当前视角覆盖', exact: true }).click();
  point = await checkCapture('按钮覆盖', 1, 2, expected);
  assert.equal(point.id, originalId, '按钮覆盖保留节点 ID');

  // 只改变高度仍是不同点，预校验和 Store 校验都必须按实际三维位置判断。
  await page.evaluate(pose => window.autoPatrolCaptureHarness.setPose({ ...pose, target: { ...pose.target, y: pose.target.y + 8 } }), expected);
  await settle();
  expected = await snapshot();
  await page.getByRole('button', { name: '+ 添加点位', exact: true }).click();
  await checkCapture('同水平位置不同高度新增', 2, 3, expected);
  await settle();
  const reference = await snapshot();
  await canvas.screenshot({ path: path.join(output, 'captured-view.png') });
  await gesture(120, 35, 150);
  await page.getByRole('button', { name: '聚焦节点', exact: true }).click();
  await page.waitForFunction(expected => window.autoPatrolCaptureHarness.snapshot().matrix.every((value, index) => Math.abs(value - expected.matrix[index]) < 1e-4), reference);
  await settle();
  assertVector((await snapshot()).position, reference.position, '聚焦节点还原当前取景');
  await canvas.screenshot({ path: path.join(output, 'focused-view.png') });
  checks.push({ name: '聚焦节点恢复真实相机视图矩阵' });

  const saved = await page.evaluate(() => window.autoPatrolCaptureHarness.save());
  await writeFile(path.join(output, 'scene.scene.json'), saved);
  await page.evaluate(content => window.autoPatrolCaptureHarness.reopen(content), saved);
  await page.waitForFunction(() => window.autoPatrolCaptureHarness.waypoints().length === 3);
  await page.waitForFunction(() => window.autoPatrolCaptureHarness.preparation().completed, null, { timeout: 120000 });
  await page.getByTitle('聚焦此视角', { exact: true }).nth(2).click();
  await page.waitForFunction(expected => window.autoPatrolCaptureHarness.snapshot().matrix.every((value, index) => Math.abs(value - expected.matrix[index]) < 1e-4), reference);
  await settle();
  assertVector((await snapshot()).position, reference.position, '保存重开后聚焦还原取景');
  checks.push({ name: '保存重开后聚焦恢复真实相机视图矩阵' });
  assert.deepEqual(pageErrors, [], '浏览器不得发生页面异常');
  await writeFile(path.join(output, 'result.json'), JSON.stringify({ ok: true, checks, pageErrors }, null, 2));
  console.log(JSON.stringify({ ok: true, checks, pageErrors }, null, 2));
} catch (error) {
  if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  if (page) console.error(await page.evaluate(() => {
    const state = window.autoPatrolCaptureHarness?.store.getState();
    return { focus: document.activeElement?.tagName, selected: state?.scene.selectedEntityId, request: state?.autoPatrolCameraRequest, mode: state?.runtimeMode, preparation: window.autoPatrolCaptureHarness?.preparation(), logs: state?.logs.slice(0, 5) };
  }).catch(() => null));
  console.error('页面异常：', pageErrors);
  throw error;
} finally {
  if (page) await page.evaluate(() => window.autoPatrolCaptureHarness?.dispose()).catch(() => {});
  await browser?.close();
  await server.close();
}
