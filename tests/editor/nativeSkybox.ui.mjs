/* global window */
import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { startSkyboxViteServer } from '../helpers/skyboxViteServer.mjs';
import { mkdir, mkdtemp, readFile, writeFile, rm, rename } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { exportGlbViewer } from '../helpers/glbStandardPreviewPublishing.mjs';
import unzipper from 'unzipper';

const workspace = process.cwd(), output = path.resolve('output/native-skybox-implementation-20261025');
// 测试自带 Vite 服务，结束时只关闭自己创建的服务。
const viteServer = process.env.SKYBOX_TEST_URL
  ? { origin: process.env.SKYBOX_TEST_URL, close: async () => {} }
  : await startSkyboxViteServer();
const base = viteServer.origin;
const root = await mkdtemp(path.join(output, 'electron-ui-'));
const project = path.join(root, 'project'), userData = path.join(root, 'profile');
const original = await readFile('public/builtin-skyboxes/partly-cloudy-light/partly-cloudy-light.hdr');
const firstLine = original.indexOf(10) + 1;
const hdr = Buffer.concat([original.subarray(0, firstLine), Buffer.from('COMMENT=native-skybox-editor-import-verification\n'), original.subarray(firstLine)]);
const source = path.join(root, 'custom-test.hdr'), savedScene = path.join(project, 'Scenes', 'native-skybox.scene.json');
await mkdir(path.dirname(savedScene), { recursive: true }); await mkdir(userData); await writeFile(source, hdr);
await writeFile(path.join(root, 'session.json'), JSON.stringify({ root, project, userData, source, savedScene }, null, 2));
console.log('session', root);
const env = { ...process.env, VITE_DEV_SERVER_URL: base, OPEN_DEVTOOLS: 'false' }; delete env.ELECTRON_RUN_AS_NODE;
const bootstrap = path.join(workspace, `.tmp-native-skybox-${path.basename(root)}.mjs`);
await writeFile(bootstrap, `import { app } from 'electron';\nimport { writeFileSync } from 'node:fs';\napp.setPath('userData', ${JSON.stringify(userData)});\nprocess.env.VITE_DEV_SERVER_URL = ${JSON.stringify(base)};\nprocess.env.OPEN_DEVTOOLS = 'false';\nwriteFileSync(${JSON.stringify(path.join(root, 'boot.json'))}, JSON.stringify({pid: process.pid, userData: app.getPath('userData'), appPath: app.getAppPath(), renderer: process.env.VITE_DEV_SERVER_URL}));\nawait import(${JSON.stringify(pathToFileURL(path.join(workspace, 'dist-electron/main.js')).href)});\n`, { flag: 'wx' });
let app, page;
const errors = [], consoleErrors = [], requests = [];
try {
  app = await electron.launch({
    // 使用包提供的 Electron 入口，保留当前 Playwright 的主进程 loader 注入。
    args: [bootstrap, `--user-data-dir=${userData}`], cwd: workspace, env, timeout: 90000 });
  await app.evaluate(({ dialog }, paths) => {
    dialog.showOpenDialog = async (...args) => {
      const options = args.at(-1);
      if (options.properties?.includes('openDirectory')) return { canceled: false, filePaths: [paths.project] };
      if (options.filters?.some(filter => filter.extensions?.includes('hdr'))) return { canceled: false, filePaths: [paths.source] };
      return { canceled: false, filePaths: [paths.savedScene] };
    };
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: paths.savedScene });
  }, { project, source, savedScene });
  page = await app.firstWindow();
  page.setDefaultTimeout(45000);
  page.on('pageerror', error => { errors.push(error.message); console.error('pageerror', error.message); });
  page.on('console', message => { if (message.type() === 'error') { consoleErrors.push(message.text()); console.error(message.text()); } });
  page.on('request', request => requests.push(request.url()));
  page.on('dialog', dialog => dialog.accept());
  await page.addInitScript(() => {
    window.addEventListener('DOMContentLoaded', () => {
      void import('/tests/fixtures/nativeSkybox.appInspection.ts').then(module => { window.inspectNativeSkyboxApp = module.inspectNativeSkyboxApp; });
    });
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof window.inspectNativeSkyboxApp === 'function');
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: '打开项目目录', exact: true }).click();
  await page.locator('canvas.scene-canvas').waitFor();
  await page.getByRole('button', { name: '天空盒库', exact: true }).click();
  const builtin = page.locator('.skybox-resource-card', { hasText: '多云天空' }).first();
  await builtin.click();
  await page.waitForFunction(() => {
    const state = window.inspectNativeSkyboxApp();
    return state.skyboxes.length === 1 && state.skyboxes[0].skybox.environment?.faceSize === 512 && state.runtime?.skyReady;
  }, null, { timeout: 120000 });
  const builtinState = await page.evaluate(() => window.inspectNativeSkyboxApp());
  await page.screenshot({ path: path.join(root, 'builtin.png') });
  assert.equal(builtinState.runtime.infiniteDistance, true); assert.equal(builtinState.runtime.pickable, false);
  assert.equal(builtinState.runtime.triangles, 12);
  assert.deepEqual(builtinState.runtime.position, [0, 0, 0]);
  assert.deepEqual(builtinState.resourceIssues, []);

  await page.getByRole('button', { name: '导入 HDR/EXR', exact: true }).click();
  await page.getByText(/天空原图已导入且 ENV 已准备/).first().waitFor({ timeout: 180000 });
  const custom = page.locator('.skybox-resource-card', { hasText: 'custom-test' }).first();
  await custom.click();
  await page.waitForFunction(() => {
    const state = window.inspectNativeSkyboxApp();
    return state.skyboxes[0]?.skybox.sourcePath.includes('custom-test') && state.skyboxes[0].skybox.environment && state.runtime?.skyReady;
  }, null, { timeout: 120000 });
  await page.getByTitle('天空盒水平旋转角度（度）').fill('37');
  await page.getByText('旧场景的位置、尺寸和倾斜仅保留为兼容数据', { exact: false }).waitFor();
  const importedSource = await page.evaluate(() => window.inspectNativeSkyboxApp().skyboxes[0].skybox.sourcePath);
  assert.ok(importedSource.startsWith(project + path.sep));
  await rename(importedSource, `${importedSource}.unavailable`);
  try {
    await page.locator('.skybox-resolution-row select').selectOption('256');
    await page.waitForFunction(() => document.querySelector('[aria-label="天空 ENV 状态"]')?.getAttribute('role') === 'alert');
    const failed = await page.evaluate(() => window.inspectNativeSkyboxApp());
    assert.equal(failed.runtime.infiniteDistance, true, '准备失败时保留原有天空网格');
    await page.screenshot({ path: path.join(root, 'preparation-error.png') });
  } finally { await rename(`${importedSource}.unavailable`, importedSource); }
  await page.getByRole('button', { name: '重试天空 ENV', exact: true }).first().click();
  await page.waitForFunction(() => {
    const sky = window.inspectNativeSkyboxApp().skyboxes[0];
    return sky?.skybox.environment?.faceSize === 256 && Math.abs(sky.transform.rotation.y - 37 * Math.PI / 180) < 1e-8;
  }, null, { timeout: 120000 });
  await page.getByRole('button', { name: '保存场景', exact: true }).click();
  await page.waitForFunction(() => window.inspectNativeSkyboxApp().dirty === false, null, { timeout: 120000 });
  const saved = JSON.parse(await readFile(savedScene, 'utf8'));
  assert.equal(saved.version, 7);
  const sky = Object.values(saved.scene.entities).find(entity => entity.components.skybox).components.skybox;
  assert.equal(sky.environment.format, 'env'); assert.equal(sky.environment.faceSize, 256);
  assert.equal(sky.format, 'hdr'); assert.ok(sky.sourcePath.endsWith('.hdr'));
  assert.deepEqual(await readFile(source), hdr, '源输入文件不改写');
  const previousSession = await page.evaluate(() => window.inspectNativeSkyboxApp().sceneSessionId);
  await page.getByRole('button', { name: '加载场景', exact: true }).click();
  await page.waitForFunction(previous => {
    const state = window.inspectNativeSkyboxApp();
    return state.sceneSessionId !== previous && state.skyboxes[0]?.skybox.environment?.faceSize === 256 && state.runtime?.skyReady && !state.dirty;
  }, previousSession, { timeout: 120000 });
  await page.getByRole('button', { name: '取消加载并返回首页', exact: true }).waitFor({ state: 'hidden', timeout: 120000 });
  await page.getByLabel('天空 ENV 状态', { exact: true }).filter({ hasText: 'ENV 已加载' }).waitFor();
  const reopened = await page.evaluate(() => window.inspectNativeSkyboxApp());
  await page.screenshot({ path: path.join(root, 'saved-reopened.png') });
  assert.deepEqual(reopened.resourceIssues, []);
  assert.deepEqual(errors, []);
  const exportParent = path.join(root, 'exports');
  const directoryExport = await exportGlbViewer({ application: app, page, exportParent, content: JSON.stringify(saved), name: 'NativeSkybox' });
  const exportedScene = JSON.parse(await readFile(path.join(directoryExport.result.outputPath, 'project/scene.json'), 'utf8'));
  const exportedSkybox = Object.values(exportedScene.scene.entities).find(entity => entity.components.skybox).components.skybox;
  assert.equal(exportedSkybox.sourceAvailable, false);
  assert.equal(exportedSkybox.sourceUrl, '');
  assert.equal(exportedSkybox.environment.sha256, sky.environment.sha256);
  const exportedManifest = JSON.parse(await readFile(path.join(directoryExport.result.outputPath, 'project/asset-manifest.json'), 'utf8'));
  assert.equal(exportedManifest.assets.filter(asset => asset.path.endsWith('.env')).length, 1);
  assert.equal(exportedManifest.assets.filter(asset => /\.(hdr|exr)$/i.test(asset.path)).length, 0);
  const zipPath = path.join(exportParent, 'NativeSkybox.zip');
  await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, zipPath);
  const zipExport = await page.evaluate(content => window.editorApi.exportWebProject({ requestId: 'native-skybox-zip', suggestedName: 'NativeSkybox',
    format: 'zip', sceneContent: content }), JSON.stringify(saved));
  assert.equal(zipExport.canceled, false);
  const archive = await unzipper.Open.file(zipExport.outputPath);
  assert.equal(archive.files.filter(file => /skyboxes\/.*\.env$/i.test(file.path)).length, 1);
  assert.equal(archive.files.filter(file => /\.(hdr|exr)$/i.test(file.path)).length, 0);
  const report = { root, project, source, savedScene, directoryExport: directoryExport.result, zipExport, builtin: builtinState, reopened, errors, consoleErrors,
    envRequests: requests.filter(url => /\.env(?:[?#]|$)/i.test(decodeURIComponent(url))),
    checks: ['actual-electron-entry', 'real-preload-ipc', 'builtin-selection', 'hdr-import-and-env-compile', 'apply-custom-sky', 'rotation', 'resolution', 'source-missing-keeps-old-sky', 'retry-env', 'legacy-transform-notice', 'save-v7', 'reopen', 'source-preserved', 'standalone-directory-export', 'standalone-zip-export'] };
  await writeFile(path.join(root, 'result.json'), JSON.stringify(report, null, 2));
  console.log('PASS', JSON.stringify({ root, checks: report.checks, renderer: reopened.runtime.renderer }));
} catch (error) {
  if (page) {
    await page.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {});
    await writeFile(path.join(root, 'failure-state.json'), JSON.stringify({ message: String(error), errors, consoleErrors,
      state: await page.evaluate(() => window.inspectNativeSkyboxApp?.()).catch(() => null), body: await page.locator('body').innerText().catch(() => '') }, null, 2));
  }
  throw error;
} finally { await app?.close().catch(() => {}); await viteServer.close(); await rm(bootstrap, { force: true }); }
