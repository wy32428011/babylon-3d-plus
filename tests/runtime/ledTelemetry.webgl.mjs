/* global window */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer as createPortProbe } from 'node:net';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import ts from 'typescript';
import { prepareModelScriptCompilation } from '../../electron/shared/modelScriptCompilation.ts';

const workspace = process.cwd();
const output = await mkdtemp(path.join(tmpdir(), 'zending-led-webgl-'));
const modelRoot = path.resolve('Assets/Models/Model-2080102163768123393-LED');
const digest = value => createHash('sha256').update(value).digest('hex');
const scriptSource = await readFile(path.join(modelRoot, 'led.model.ts'), 'utf8');
const preparedScript = prepareModelScriptCompilation(scriptSource);
const compiledCode = ts.transpileModule(preparedScript.sourceText, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.None,
    experimentalDecorators: true,
    useDefineForClassFields: false,
  },
}).outputText + '\n' + preparedScript.returnStatement;
const compiledScript = JSON.stringify({
  format: 'babylon-model-script-v1',
  sourceSha256: digest(scriptSource),
  codeSha256: digest(compiledCode),
  compilerVersion: 'led-webgl-fixture',
  code: compiledCode,
});
let server;
let browser;
let page;
let runningResult;
const errors = [];
const consoleMessages = [];
const portProbe = createPortProbe();
await new Promise((resolve, reject) => {
  portProbe.once('error', reject);
  portProbe.listen(0, '127.0.0.1', resolve);
});
const port = portProbe.address().port;
await new Promise((resolve, reject) => portProbe.close(error => error ? reject(error) : resolve()));
try {
  server = await createServer({
    configFile: false,
    root: workspace,
    cacheDir: path.join(output, 'vite-cache'),
    appType: 'custom',
    optimizeDeps: { noDiscovery: true },
    server: { host: '127.0.0.1', port, strictPort: true, hmr: false, watch: null },
  });
  server.middlewares.use('/favicon.ico', (_request, response) => {
    response.writeHead(204).end();
  });
  server.middlewares.use('/__led__', async (request, response) => {
    try {
      const name = decodeURIComponent(new URL(request.url, 'http://led').pathname);
      if (!/^\/(?:LED\.glb|led\.model\.ts(?:\.compiled\.json)?)$/.test(name)) {
        response.writeHead(404).end();
        return;
      }
      const url = new URL(request.url, 'http://led');
      const precompiled = name === '/led.model.ts.compiled.json'
        || (name === '/led.model.ts' && url.searchParams.get('modelScriptCompiled') === '1');
      const bytes = precompiled ? Buffer.from(compiledScript) : await readFile(path.join(modelRoot, name.slice(1)));
      response.setHeader('Content-Type', precompiled
        ? 'application/json; charset=utf-8'
        : name.endsWith('.glb') ? 'model/gltf-binary' : 'text/plain; charset=utf-8');
      response.setHeader('Content-Length', bytes.length);
      response.end(bytes);
    } catch (error) {
      response.writeHead(500).end(String(error));
    }
  });
  server.middlewares.use('/__led_test__', async (_request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(await server.transformIndexHtml('/__led_test__', '<!doctype html><meta charset="utf-8"><title>LED MQTT WebGL</title><style>body{margin:0;background:#101722}</style><script type="module" src="/tests/fixtures/ledTelemetry.harness.ts"></script>'));
  });
  await server.listen();
  const address = server.httpServer.address();
  assert.ok(address && typeof address !== 'string');
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  page = await browser.newPage({ viewport: { width: 1200, height: 760 }, deviceScaleFactor: 1 });
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    consoleMessages.push(`[${message.type()}] ${message.text()}`);
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto(`http://127.0.0.1:${address.port}/__led_test__`, { waitUntil: 'commit', timeout: 120_000 });
  await page.waitForFunction(() => Boolean(window.ledTelemetryHarness), undefined, { timeout: 120_000 });
  const renderer = await page.evaluate(() => window.ledTelemetryHarness.renderer());
  assert.equal(renderer.webGLVersion, 2);
  assert.doesNotMatch(renderer.renderer, /swiftshader|llvmpipe|software|microsoft basic render/i);

  const editing = await page.evaluate(() => window.ledTelemetryHarness.prepare());
  await page.locator('canvas').screenshot({ path: path.join(output, '01-editing.png') });
  runningResult = await page.evaluate(() => window.ledTelemetryHarness.start());
  const running = runningResult.settled;
  assert.equal(runningResult.immediate.length, 2);
  assert.deepEqual(runningResult.immediate.map(row => row.text).sort(), ['MQTT-A 正常', 'MQTT-B 故障']);
  assert.equal(running.length, 2);
  assert.equal(new Set(running.map(row => row.materialId)).size, 2, '每块 LED 必须拥有独立文字材质');
  assert.equal(new Set(running.map(row => row.geometryId)).size, 1, '文字层仍应共享屏幕几何');
  assert.ok(running.every(row => row.meshClass === 'Mesh'));
  assert.ok(running.every(row => !row.readinessError && !row.initializationError && !row.diagnostics?.paint));
  assert.deepEqual(running.map(row => row.text).sort(), ['MQTT-A 正常', 'MQTT-B 故障']);
  await page.locator('canvas').screenshot({ path: path.join(output, '02-runtime-mqtt.png') });

  const moved = await page.evaluate(() => window.ledTelemetryHarness.moveCamera());
  assert.deepEqual(moved.map(row => row.world), running.map(row => row.world), '移动相机不能改变文字层世界矩阵');
  await page.locator('canvas').screenshot({ path: path.join(output, '03-camera-moved.png') });
  const picks = await page.evaluate(() => [
    window.ledTelemetryHarness.pickScreen('led-source'),
    window.ledTelemetryHarness.pickScreen('led-copy'),
  ]);
  for (const [index, entityId] of ['led-source', 'led-copy'].entries()) {
    assert.equal(picks[index].hit?.entityId, entityId, '点击屏幕必须命中整块 LED');
    assert.equal(picks[index].hit?.precise, true);
    assert.equal(picks[index].resolution.kind, 'trigger');
    assert.equal(picks[index].resolution.entityId, entityId, '屏幕必须触发本机点击事件绑定');
  }
  const interruption = await page.evaluate(() => window.ledTelemetryHarness.interruptLongText());
  const interruptedSource = interruption.retained.find(row => row.entityId === 'led-source');
  assert.equal(interruptedSource.text, interruption.longText, '断流时未完成长文案必须保留');
  assert.equal(interruptedSource.runtimeContext.telemetry, null);
  const completedSource = interruption.completed.find(row => row.entityId === 'led-source');
  assert.equal(completedSource.text, '欢迎光临，新年快乐！', '完整滚动一遍后才回退模型参数');
  const stopped = await page.evaluate(() => window.ledTelemetryHarness.stop());
  assert.deepEqual(stopped, []);
  await page.locator('canvas').screenshot({ path: path.join(output, '04-editing-restored.png') });
  assert.deepEqual(errors, []);
  const report = { status: 'PASS', renderer, editing, running: runningResult, moved, picks, interruption, stopped, consoleMessages };
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, output, renderer: renderer.renderer, texts: running.map(row => row.text) }, null, 2));
} catch (error) {
  const failureState = await page?.evaluate(() => window.ledTelemetryHarness?.state()).catch(() => null);
  await page?.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  await writeFile(path.join(output, 'failure.json'), JSON.stringify({ error: String(error), runningResult, failureState, errors, consoleMessages }, null, 2));
  console.error(JSON.stringify({ status: 'FAIL', output, error: String(error), runningResult, failureState, errors }, null, 2));
  throw error;
} finally {
  await page?.evaluate(() => window.ledTelemetryHarness?.dispose()).catch(() => {});
  await browser?.close();
  await server?.close();
  if (!process.env.ZENDING_LED_KEEP_OUTPUT) await rm(output, { recursive: true, force: true });
}
