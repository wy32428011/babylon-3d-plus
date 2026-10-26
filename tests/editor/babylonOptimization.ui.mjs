/* global window */
import assert from 'node:assert/strict';
import { _electron } from 'playwright';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { NullEngine, Scene, MeshBuilder, StandardMaterial } from '@babylonjs/core';
import { GLTF2Export } from '@babylonjs/serializers/glTF/index.js';
import { declareReadonlyPackage } from '../../scripts/declare-model-runtime-capabilities.mjs';
import { exportGlbViewer } from '../helpers/glbStandardPreviewPublishing.mjs';

const workspace = process.cwd(), output = path.resolve('output/babylon-optimization-20261026');
const origin = process.env.BABYLON_TEST_URL;
assert.ok(origin, '请先用preview_start启动已有开发服务，再提供BABYLON_TEST_URL');
const root = await fs.mkdtemp(path.join(output, 'editor-contract-'));
const project = path.join(root, 'project'), userData = path.join(root, 'profile'), original = path.join(root, 'original');
const candidate = path.join(root, 'candidate'), savedScene = path.join(project, 'Scenes', 'ReadonlyProbe.scene.json');
await fs.mkdir(path.dirname(savedScene), { recursive: true }); await fs.mkdir(userData); await fs.mkdir(original);
const engine = new NullEngine(), scene = new Scene(engine);
const box = MeshBuilder.CreateBox('body', {}, scene); box.material = new StandardMaterial('surface', scene);
const exported = await GLTF2Export.GLBAsync(scene, 'model');
await fs.writeFile(path.join(original, 'model.glb'), new Uint8Array(await exported.glTFFiles['model.glb'].arrayBuffer()));
scene.dispose(); engine.dispose();
const script = 'export default class RuntimeComponent { constructor(node) { this.node = node; } onStart() { this.node.metadata = { ...this.node.metadata, readonlyFixtureStarted: true }; } }\n';
await fs.writeFile(path.join(original, 'readonly.model.ts'), script);
await fs.writeFile(path.join(original, 'meta.json'), JSON.stringify({ displayName: 'Readonly Probe', lengthUnit: 'meter' }));
const asset = { sourcePath: path.join(original, 'model.glb'), sourceUrl: 'editor-asset://local/' + encodeURIComponent(path.join(original, 'model.glb')),
  lengthUnit: 'meter', unitScaleToMeters: 1, assetRevision: 'fixture-original', assetCode: 'fixture',
  scriptAssets: [{ name: 'readonly.model.ts', path: path.join(original, 'readonly.model.ts'), sourceUrl: 'editor-asset://local/' + encodeURIComponent(path.join(original, 'readonly.model.ts')) }] };
const recipe = path.join(root, 'author-scene.json');
await fs.writeFile(recipe, JSON.stringify({ scene: { entities: { fixture: { components: { modelAsset: asset } } } } }));
const declaration = await declareReadonlyPackage({ scene: recipe, entityId: 'fixture', output: candidate, acknowledgeReadonlyGeometry: true });
const bootstrap = path.join(workspace, `.tmp-babylon-optimization-${path.basename(root)}.mjs`);
await fs.writeFile(bootstrap, `import { app } from 'electron';\napp.setPath('userData', ${JSON.stringify(userData)});\nawait import(${JSON.stringify(pathToFileURL(path.join(workspace, 'dist-electron/main.js')).href)});\n`, { flag: 'wx' });
const report = { status: 'RUNNING', scope: 'actual Editor import/create/save/reopen/export; controlled readonly-script NON-GI fixture, not business FPS or GI acceptance', root, declaration, errors: [] };
let application, page;
try {
  const env = { ...process.env, VITE_DEV_SERVER_URL: origin, OPEN_DEVTOOLS: 'false' }; delete env.ELECTRON_RUN_AS_NODE;
  application = await _electron.launch({ args: [bootstrap, `--user-data-dir=${userData}`], cwd: workspace, env, timeout: 90000 });
  await application.evaluate(({ dialog }, target) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] });
  }, project);
  page = await application.firstWindow(); page.setDefaultTimeout(45000);
  page.on('pageerror', error => report.errors.push(error.message));
  page.on('dialog', dialog => dialog.accept());
  await page.addInitScript(() => window.addEventListener('DOMContentLoaded', () => {
    void import('/tests/fixtures/babylonOptimization.appInspection.ts').then(module => { window.inspectBabylonOptimizationApp = module.inspectBabylonOptimizationApp; });
  }));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof window.inspectBabylonOptimizationApp === 'function');
  await page.getByRole('button', { name: '打开项目目录', exact: true }).click();
  await page.locator('canvas.scene-canvas').waitFor();
  await application.evaluate(({ dialog }, target) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] }); }, candidate);
  await page.getByRole('button', { name: '导入模型文件夹', exact: true }).click();
  const card = page.locator('button.resource-card', { hasText: path.basename(candidate) }).first();
  await card.waitFor(); await card.click();
  await page.waitForFunction(() => { const s = window.inspectBabylonOptimizationApp(); return s.models.length === 1 && s.models[0].ready && s.models[0].scriptStarted; });
  await card.click();
  await page.waitForFunction(() => { const s = window.inspectBabylonOptimizationApp(); return s.models.length === 2 && s.models.every(m => m.ready && m.scriptStarted); });
  await page.locator('.transform-axis-fieldset').first().locator('input').first().fill('3');
  await page.locator('.transform-axis-fieldset').first().locator('input').first().press('Tab');
  const current = await page.evaluate(() => window.inspectBabylonOptimizationApp());
  assert.ok(current.models.every(model => model.verified && model.error === null));
  assert.equal(current.models[0].geometry, current.models[1].geometry);
  assert.notEqual(current.models[0].material, current.models[1].material);
  assert.equal(current.models.filter(model => model.transform.position.x === 3).length, 1);
  assert.equal(current.loading.modelCache.sharedGeometryCloneCount, 2);
  assert.equal(current.loading.modelCache.capabilityFallbackCount, 0);
  // 此独立夹具只验资源共享链；通过真实配置控件建立非GI条件，不绕过发布门禁。
  await page.getByRole('button', { name: '光照与烘焙管理器', exact: true }).click();
  await page.getByRole('checkbox', { name: /^间接光烘焙/ }).uncheck();
  await page.getByRole('button', { name: '应用配置', exact: true }).click();
  await page.getByRole('button', { name: '关闭光照与烘焙管理器', exact: true }).click();
  await application.evaluate(({ dialog }, target) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: target });
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] });
  }, savedScene);
  await page.getByRole('button', { name: '保存场景', exact: true }).click();
  await page.waitForFunction(() => !window.inspectBabylonOptimizationApp().dirty);
  const saved = await fs.readFile(savedScene, 'utf8');
  assert.ok(Object.values(JSON.parse(saved).scene.entities).filter(entity => entity.components.modelAsset).every(entity => entity.components.modelAsset.runtimeCapabilities));
  const session = current.sceneSessionId;
  await page.getByRole('button', { name: '加载场景', exact: true }).click();
  await page.waitForFunction(previous => {
    const s = window.inspectBabylonOptimizationApp();
    return s.sceneSessionId !== previous && s.models.length === 2 && s.models.every(m => m.ready && m.scriptStarted && m.verified && !m.error)
      && !document.querySelector('[data-scene-preparation-phase]');
  }, session, { timeout: 120000 });
  report.reopened = await page.evaluate(() => window.inspectBabylonOptimizationApp());
  assert.equal(report.reopened.models[0].geometry, report.reopened.models[1].geometry);
  assert.deepEqual(report.reopened.resources, []); assert.deepEqual(report.errors, []);
  await page.screenshot({ path: path.join(root, 'editor-ready.png') });
  report.export = (await exportGlbViewer({ application, page, exportParent: path.join(root, 'exports'), content: saved, name: 'ReadonlyProbe' })).result;
  const published = JSON.parse(await fs.readFile(path.join(report.export.outputPath, 'project/scene.json'), 'utf8'));
  assert.ok(Object.values(published.scene.entities).filter(entity => entity.components.modelAsset).every(entity => entity.components.modelAsset.runtimeCapabilities));
  report.status = 'PASS';
} catch (error) {
  report.status = 'FAIL'; report.error = error.stack ?? String(error); process.exitCode = 1;
  if (page) {
    report.state = await page.evaluate(() => window.inspectBabylonOptimizationApp?.()).catch(() => null);
    await page.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {});
  }
} finally {
  await fs.writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
  await application?.close(); await fs.rm(bootstrap, { force: true });
  console.log(JSON.stringify({ status: report.status, root, outputPath: report.export?.outputPath, error: report.error }));
}
