/* global document, window */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { _electron } from 'playwright';

const { values } = parseArgs({ options: { output: { type: 'string' }, help: { type: 'boolean', default: false } } });
if (values.help) { console.log('node scripts/phase2-model-density-ui.mjs [--output output/phase2-completion-20261025/<new-run>]'); process.exit(0); }
const repository = process.cwd(), taskRoot = path.resolve('output/phase2-completion-20261025');
const output = path.resolve(values.output ?? path.join(taskRoot, 'model-density-ui-' + Date.now()));
const relative = path.relative(taskRoot, output);
assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), '输出必须是任务目录下的新目录');
await fs.mkdir(output);
const project = path.join(output, 'project'), userData = path.join(output, 'userdata');
const sceneFile = path.join(project, 'Scenes', 'density-ui.scene.json');
await fs.mkdir(path.dirname(sceneFile), { recursive: true }); await fs.mkdir(userData);
await fs.writeFile(path.join(userData, 'recent-workspaces.json'), JSON.stringify({ version: 1, projects: [], scenes: [] }));
await fs.writeFile(path.join(userData, 'data-platform-config.json'), JSON.stringify({ version: 2, baseUrl: '', workspaceRoot: output }));
const folders = { high: path.join(taskRoot, 'model-density-ui-fixtures', 'high'), normal: path.join(taskRoot, 'model-density-ui-fixtures', 'normal') };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function fingerprintSources() {
  const result = {};
  for (const [kind, directory] of Object.entries(folders)) for (const filename of ['main.glb', 'meta.json']) {
    const file = path.join(directory, filename), bytes = await fs.readFile(file);
    result[kind + '/' + filename] = { bytes: bytes.length, sha256: sha(bytes) };
  }
  return result;
}
const sourceBefore = await fingerprintSources();
const report = { status: 'RUNNING', scope: 'built Editor, native Home/new-scene/import/save entry points; functional only, no performance measurement',
  output, project, userData, sceneFile, sourceBefore, sourceAfter: null, stages: [], dialogs: [], screenshots: [], cards: {},
  pageErrors: [], consoleErrors: [], rendererGone: [], cleanup: {} };
const reportPath = path.join(output, 'report.json');
const save = () => fs.writeFile(reportPath, JSON.stringify(report, null, 2));
const stage = async name => { report.stages.push(name); console.log('[model-density-ui] ' + name); await save(); };
const bootstrap = path.join(output, 'bootstrap.mjs');
let application, page;
try {
  const moduleUrl = name => pathToFileURL(path.join(repository, 'dist-electron/ipc', name + '.js')).href;
  await fs.writeFile(bootstrap, "import {app} from 'electron';\napp.setPath('userData'," + JSON.stringify(userData) + ');\n'
    + 'app.getAppPath=()=>'+JSON.stringify(repository)+';\n'
    + 'globalThis.phase2DensityHost={assets:await import('+JSON.stringify(moduleUrl('projectAssetStore'))+'),registry:await import('+JSON.stringify(moduleUrl('assetRegistry'))+'),dialogs:[],selectedFolder:null,saveCount:0};\n'
    + 'await globalThis.phase2DensityHost.assets.activateProjectRoot('+JSON.stringify(project)+');\n'
    + 'await import('+JSON.stringify(pathToFileURL(path.join(repository,'dist-electron/main.js')).href)+');\n', { flag: 'wx' });
  const env = { ...process.env, VITE_DEV_SERVER_URL: '', OPEN_DEVTOOLS: 'false' }; delete env.ELECTRON_RUN_AS_NODE;
  application = await _electron.launch({ args: [bootstrap, '--user-data-dir=' + userData], cwd: repository, env, timeout: 120000 });
  report.applicationPid = application.process().pid;
  await application.evaluate(({ app, dialog, BrowserWindow }, options) => {
    const host = globalThis.phase2DensityHost;
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.setBackgroundThrottling(false);
      win.webContents.on('render-process-gone', (_event, details) => { host.rendererGone ??= []; host.rendererGone.push(details); });
    }
    dialog.showOpenDialog = async (...args) => {
      const config = args.at(-1);
      if (config?.title !== '选择模型文件夹') throw new Error('未预期的文件选择：' + config?.title);
      if (!Object.values(options.folders).includes(host.selectedFolder)) throw new Error('只允许选择本次两个源模型包');
      host.dialogs.push({ kind: 'import', title: config.title, path: host.selectedFolder });
      return { canceled: false, filePaths: [host.selectedFolder] };
    };
    dialog.showSaveDialog = async () => { host.saveCount++; host.dialogs.push({ kind: 'save', path: options.sceneFile }); return { canceled: false, filePath: options.sceneFile }; };
    host.runtime = { versions: process.versions, appPath: app.getAppPath(), userData: app.getPath('userData') };
  }, { folders, sceneFile });
  page = await application.firstWindow(); page.setDefaultTimeout(60000);
  page.on('pageerror', error => report.pageErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(message.text()); });
  await page.setViewportSize({ width: 1440, height: 960 }); await page.bringToFront();
  await page.waitForLoadState('networkidle');
  report.homeButtons = await page.getByRole('button').allTextContents();
  await page.getByRole('button', { name: '新建场景', exact: true }).waitFor({ state: 'visible' });
  await stage('home-ready');
  await page.screenshot({ path: path.join(output, '01-home.png') }); report.screenshots.push('01-home.png');
  await page.getByRole('button', { name: '新建场景', exact: true }).click();
  await page.locator('canvas.scene-canvas').waitFor({ state: 'visible' });
  await page.getByRole('button', { name: '导入模型文件夹', exact: true }).waitFor({ state: 'visible' });
  await stage('new-scene-ready');
  await page.getByRole('button', { name: '保存场景', exact: true }).click();
  await waitSavedScene(); const sceneBefore = await fs.readFile(sceneFile);
  report.sceneBefore = { bytes: sceneBefore.length, sha256: sha(sceneBefore) };
  for (const kind of ['high', 'normal']) {
    await application.evaluate((_electron, folder) => { globalThis.phase2DensityHost.selectedFolder = folder; }, folders[kind]);
    await page.getByRole('button', { name: '导入模型文件夹', exact: true }).click();
    await page.waitForFunction(kind => document.querySelectorAll('.resource-card-name').length
      && [...document.querySelectorAll('.resource-card-name')].some(node => node.textContent === kind), kind);
    const source = await page.evaluate(async kind => {
      const listed = await window.editorApi.listProjectAssets();
      return listed.assets.find(asset => asset.libraryKind === 'model' && asset.displayName === kind);
    }, kind);
    assert.ok(source, kind + ' did not reach actual project index');
    assert.equal(source.lengthUnit, 'centimeter'); assert.equal(source.unitScaleToMeters, 0.01);
    assert.equal(source.sourceModelDensity.unitScaleToMeters, 0.01);
    assert.deepEqual(await fs.readFile(source.path), await fs.readFile(path.join(folders[kind], 'main.glb')));
    const card = page.locator('button.resource-card').filter({ has: page.locator('.resource-card-name', { hasText: new RegExp('^' + kind + '$') }) });
    await card.scrollIntoViewIfNeeded(); await card.hover();
    const state = await card.evaluate(element => {
      const badge = [...element.querySelectorAll('span')].find(node => node.childElementCount === 0 && node.textContent === '源模型高密度');
      const style = badge ? window.getComputedStyle(badge) : null;
      const rect = badge?.getBoundingClientRect();
      return { title: element.title, aria: element.getAttribute('aria-description'), badge: badge ? { text: badge.textContent,
        color: style.color, backgroundColor: style.backgroundColor, fontSize: style.fontSize,
        opacity: style.opacity, visibility: style.visibility, width: rect.width, height: rect.height } : null };
    });
    if (kind === 'high') {
      assert.ok(state.badge); assert.match(state.title, /小尺寸高面数/); assert.match(state.aria, /源 GLB JSON/);
      assert.ok(state.badge.width > 20 && state.badge.height >= 14); assert.equal(state.badge.visibility, 'visible');
      assert.notEqual(state.badge.color, state.badge.backgroundColor);
      state.badge.minimumContrast = minimumContrast(state.badge.color, state.badge.backgroundColor);
      assert.ok(state.badge.minimumContrast >= 4.5, '警告字色对实际背景应清晰可辨');
      assert.equal(await page.getByText('源模型高密度', { exact: true }).count(), 1);
    } else { assert.equal(state.badge, null); assert.doesNotMatch(state.title, /小尺寸高面数|面密度过高/); }
    report.cards[kind] = { source: { path: source.path, lengthUnit: source.lengthUnit, unitScaleToMeters: source.unitScaleToMeters,
      sourceModelDensity: source.sourceModelDensity, bytes: (await fs.stat(source.path)).size }, ...state, hovered: true };
    const screenshot = kind === 'high' ? '02-high-hover.png' : '03-normal-hover.png';
    await page.screenshot({ path: path.join(output, screenshot) }); report.screenshots.push(screenshot);
    await card.screenshot({ path: path.join(output, kind + '-card.png') }); report.screenshots.push(kind + '-card.png');
    await stage('import-' + kind + '-verified');
  }
  assert.equal(await page.getByText('源模型高密度', { exact: true }).count(), 1);
  const previousMtime = (await fs.stat(sceneFile)).mtimeMs;
  await page.getByRole('button', { name: '保存场景', exact: true }).click();
  await waitSavedScene();
  for (let attempt = 0; attempt < 100 && (await fs.stat(sceneFile)).mtimeMs === previousMtime; attempt++) await page.waitForTimeout(50);
  const sceneAfter = await fs.readFile(sceneFile); assert.deepEqual(sceneAfter, sceneBefore, '只导入模型库和hover不能改场景内容');
  report.sceneAfter = { bytes: sceneAfter.length, sha256: sha(sceneAfter), unchanged: true };
  const host = await application.evaluate(({ app }, root) => ({ runtime: globalThis.phase2DensityHost.runtime,
    dialogs: globalThis.phase2DensityHost.dialogs, saveCount: globalThis.phase2DensityHost.saveCount,
    rendererGone: globalThis.phase2DensityHost.rendererGone ?? [], repositoryAuthorized: globalThis.phase2DensityHost.registry.isAuthorizedAssetFile(root + '/package.json'),
    acceleration: app.isHardwareAccelerationEnabled(), gpuFeatures: app.getGPUFeatureStatus() }), repository);
  Object.assign(report, host); assert.equal(report.repositoryAuthorized, false, '未授权整个仓库'); assert.equal(host.saveCount, 2);
  report.sourceAfter = await fingerprintSources(); assert.deepEqual(report.sourceAfter, sourceBefore);
  assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.consoleErrors, []); assert.deepEqual(report.rendererGone, []);
  report.status = 'PASS'; await stage('all-functional-checks-passed');
} catch (error) {
  report.status = 'FAIL'; report.error = error.stack ?? String(error);
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  process.exitCode = 1;
} finally {
  if (application) { await application.close(); report.cleanup.applicationClosed = true; }
  await fs.rm(bootstrap, { force: true }); report.cleanup.bootstrapRemoved = true;
  await save(); console.log(JSON.stringify({ status: report.status, reportPath, error: report.error?.split('\n')[0] }));
}
async function waitFile(file) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fs.stat(file)).size) return; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await page.waitForTimeout(50);
  }
  throw new Error('等待真实保存场景超时');
}
async function waitSavedScene() {
  await page.waitForFunction(() => document.querySelector('.console-dock-message')?.textContent?.startsWith('场景已保存：'));
  await waitFile(sceneFile);
}
function minimumContrast(foreground, background) {
  const fg = foreground.match(/[\d.]+/g).map(Number), bg = background.match(/[\d.]+/g).map(Number);
  const alpha = bg[3] ?? 1; assert.ok(alpha >= 0.8, '徽标背景不能透明到不可读');
  const luminance = color => color.slice(0, 3).map(value => value / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
    .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
  const text = luminance(fg);
  return Math.min(...[0, 255].map(backdrop => {
    const fill = luminance(bg.slice(0, 3).map(channel => channel * alpha + backdrop * (1 - alpha)));
    return (Math.max(text, fill) + 0.05) / (Math.min(text, fill) + 0.05);
  }));
}
