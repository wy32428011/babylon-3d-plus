/* global window */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'vite';
import { _electron as electron } from 'playwright';
import { prepareBusinessGiSubset } from '../tests/lightingBake/phase2GiBusinessSubset.mjs';
import { verifyBusinessGiViewer } from '../tests/helpers/phase2GiViewer.mjs';
import { findLightingSmokePort } from '../tests/helpers/lightingSmokePort.mjs';
import { verifyGiSourceReadback } from '../tests/helpers/phase2GiArtifacts.mjs';
import { openGiArtifactReader } from '../tests/helpers/phase2GiArchiveReader.mjs';
import { createEnvironmentGiBudgetMonitor } from '../tests/helpers/phase2GiBudget.mjs';
import { exerciseGammaGiUi, gammaTransportBootstrap, inspectGammaGiPngs, verifyGammaGiTransport } from '../tests/helpers/phase2GammaGiAcceptance.mjs';
import { readReceiverRoiReceipt, readReceiverRoiVersionLock, assertReceiverRoiVersionLock, copyReceiverRoiRun,
  assertReceiverRoiCapture, verifyReceiverRoiRuntime, verifyAppliedReceiverRoi, ROI_LIMITS } from '../tests/lightingBake/phase2GiReceiverRoi.mjs';

const repository = process.cwd(), projectId = '9000000000000000001';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const inside = (root, file) => { const relative = path.relative(root, file); return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)); };
const options = { entityIds: [], environment: 'omit', executeBake: false, preflightMaxTriangles: 300000, preflightMaxProbes: 512 };
for (let index = 2; index < process.argv.length; index++) {
  const flag = process.argv[index];
  if (flag === '--source') options.sourceScene = process.argv[++index];
  else if (flag === '--output') options.output = process.argv[++index];
  else if (flag === '--entity') options.entityIds.push(process.argv[++index]);
  else if (flag === '--environment') options.environment = process.argv[++index];
  else if (flag === '--bake') options.executeBake = true;
  else if (flag === '--environment-only') options.environmentOnly = true;
  else if (flag === '--plan') options.environmentPlan = process.argv[++index];
  else if (flag === '--admission-preflight') options.admissionPreflight = process.argv[++index];
  else if (flag === '--max-triangles') options.preflightMaxTriangles = Number(process.argv[++index]);
  else if (flag === '--max-probes') options.preflightMaxProbes = Number(process.argv[++index]);
  else if (flag === '--lightmap-encoding') options.lightmapEncoding = process.argv[++index];
  else if (flag === '--receiver-roi-receipt') options.receiverRoiReceipt = process.argv[++index];
  else throw new Error('未知GI验收参数：' + flag);
}
assert.ok(options.output && (options.receiverRoiReceipt || options.sourceScene && (options.environmentOnly ? options.environmentPlan && !options.entityIds.length && options.environment === 'keep' : options.entityIds.length)),
  '需要真实模型--entity，或独立--environment-only --plan --environment keep；--bake才启动Cycles');
if (options.receiverRoiReceipt) assert.ok(!process.argv.slice(2).some(flag => ['--source', '--entity', '--environment', '--environment-only', '--plan',
  '--admission-preflight', '--max-triangles', '--max-probes', '--lightmap-encoding'].includes(flag)), 'ROI receipt模式不接受旧准入或参数覆盖');
for (const value of [options.preflightMaxTriangles, options.preflightMaxProbes]) assert.ok(Number.isSafeInteger(value) && value > 0);
if (options.lightmapEncoding !== undefined) assert.ok(['rgbm', 'rgbm-gamma'].includes(options.lightmapEncoding));
const gamma = options.lightmapEncoding === 'rgbm-gamma';
if (gamma) assert.ok(options.executeBake && !options.environmentOnly, 'Gamma真实全链只使用显式--bake的小业务模型案例');
const output = path.resolve(options.output), outputBase = path.resolve('output');
assert.ok(output !== outputBase && inside(outputBase, output));
await fs.mkdir(output, { recursive: false });
const report = { status: 'RUNNING', scope: 'independent actual-business GI subset; local SOURCE/DIST only; no production publish',
  startedAt: new Date().toISOString(), output, options, pageErrors: [], consoleErrors: [], inputCaptures: [], checks: [] };
const sourceEntries = ['src/runtime/babylon/SceneRuntime.ts', 'src/runtime/babylon/SceneLightingRuntime.ts',
  'src/runtime/babylon/lightingRuntimeCapture.ts', 'src/runtime/babylon/lightingGeometry.ts', 'src/runtime/babylon/createEngine.ts',
  'src/editor/panels/scene-view/useSceneLightingPreview.ts', 'src/player/PlayerApp.tsx', 'src/player/runtimeConfig.ts',
  'electron/ipc/lightingBakeEngineConfiguration.ts', 'electron/lighting-bake/cycles_bake.py'];
if (gamma) sourceEntries.push('electron/shared/sceneLightingTextureCodec.ts', 'electron/shared/sceneLightingBakeData.ts',
  'electron/shared/sceneLightingConfig.ts', 'electron/shared/sceneLightingBakeContract.ts', 'electron/ipc/lightingBakeService.ts',
  'electron/ipc/sceneLightingBakeResources.ts', 'electron/ipc/viewerTemplateCapabilities.ts', 'electron/lighting-bake/rgbm_gamma_codec.py',
  'src/runtime/babylon/lightingRuntimeResources.ts', 'src/runtime/babylon/BakedLightingMaterialPlugin.ts',
  'src/editor/panels/LightingBakeManagerOverview.tsx', 'src/editor/store/slices/lightingManagerSlice.ts', 'electron/shared/sceneLightingBakeBinary.ts');
if (gamma) sourceEntries.push('electron/ipc/lightingBakeTaskHistory.ts');
if (gamma) sourceEntries.push('scripts/phase2-gi-business.mjs', 'tests/helpers/phase2GammaGiAcceptance.mjs', 'tests/helpers/phase2GiViewer.mjs');
const sourceHashes = async () => Object.fromEntries(await Promise.all(sourceEntries.map(async file => [file, sha(await fs.readFile(file))])));
const save = () => fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
const checkpoint = async phase => { report.phase = phase; await save(); console.log('[phase2-gi]', phase); };
let server, application, page, bootstrap, bootstrapOwned = false, resourceMonitor;
const viewerCancellation = new AbortController();
let admission, roi;

try {
  report.sourceHashScope = 'selected source entry points; not a full repository freeze';
  report.sourceHashesBefore = await sourceHashes();
  report.buildHashes = Object.fromEntries(await Promise.all(['dist-electron/main.js', 'dist-electron/lighting-bake/cycles_bake.py', 'dist-viewer-template/index.html',
    ...(gamma ? ['dist-electron/lighting-bake/rgbm_gamma_codec.py', 'dist-viewer-template/viewer-capabilities.json', 'dist-electron/ipc/lightingBakeTaskHistory.js', 'dist-electron/ipc/lightingBakeService.js'] : [])]
    .map(async file => [file, sha(await fs.readFile(file))])));
  if (options.receiverRoiReceipt) {
    report.roiVersionLock = await readReceiverRoiVersionLock(repository);
    roi = await readReceiverRoiReceipt(options.receiverRoiReceipt, report.roiVersionLock);
    assert.ok(!options.executeBake || roi.mode === 'checked-run', '未经过真实绑定与复开校验的ROI receipt禁止bake');
    options.sourceScene = roi.bundle.approved.sourceScene; options.environmentOnly = true;
    options.preflightMaxTriangles = ROI_LIMITS.maxTriangles; options.preflightMaxProbes = ROI_LIMITS.maxProbes;
    report.environmentPlan = { ...roi.bundle.approved, pilot: roi.bundle.plan.pilot, preregisteredBudget: ROI_LIMITS };
    report.environmentPlanSha256 = roi.bundle.planSha256;
    report.roi = { mode: roi.mode, receipt: roi.receiptFile, receiptSha256: roi.receiptSha256,
      policySha256: roi.receipt.policySha256 ?? null, actualPredicateSkipCount: null, actualPredicateFallbackCount: null };
    report.scope = 'independent 33-node receiver ROI; all 798/866611 original environment occluder/bounce input preserved; not full-environment receiver acceptance';
  }
  if (options.environmentOnly && !roi) {
    const bytes = await fs.readFile(options.environmentPlan), plan = JSON.parse(bytes.toString('utf8'));
    assert.equal(plan.schemaVersion, 1); assert.equal(plan.case, 'independent-original-environment-only');
    assert.equal(plan.sourceSceneSha256, sha(await fs.readFile(options.sourceScene)), '新案例必须对应冻结原场景');
    assert.ok(plan.preregisteredBudget.maxTriangles <= 1000000 && plan.preregisteredBudget.maxProbes <= 1024);
    assert.equal(plan.pilot.atlasSize, 1024); assert.equal(plan.pilot.quality, 'preview');
    report.environmentPlan = plan; report.environmentPlanSha256 = sha(bytes);
    report.scope = 'independent complete original environment geometry GI; no model scripts; not full factory';
    options.preflightMaxTriangles = plan.preregisteredBudget.maxTriangles;
    options.preflightMaxProbes = plan.preregisteredBudget.maxProbes;
    if (options.admissionPreflight) {
      assert.equal(options.executeBake, true, '独立直接开始案例必须明确--bake');
      const previous = await fs.readFile(options.admissionPreflight); admission = JSON.parse(previous.toString('utf8'));
      assert.equal(admission.status, 'PREFLIGHT_ONLY_NOT_BAKED'); assert.equal(admission.preflight?.phase, 'ready');
      assert.equal(admission.environmentPlanSha256, report.environmentPlanSha256);
      assert.equal(admission.originalSceneUnchanged, true); assert.equal(admission.originalAssetHashesStillMatch, true); assert.equal(admission.sourceVersionsStable, true);
      assert.deepEqual(admission.sourceHashesAfter, report.sourceHashesBefore); assert.deepEqual(admission.buildHashes, report.buildHashes);
      report.directStartAdmission = { report: path.resolve(options.admissionPreflight), reportSha256: sha(previous),
        scope: 'independent fresh process normal Store direct-start; no additional explicit preflight capture in this process',
        ordinaryDoubleCaptureFailureNotRepaired: true, cachedInputReturned: false };
    }
  }
  const preparation = roi ? roi.mode === 'checked-run' ? await copyReceiverRoiRun(roi, output)
    : { ...roi.receipt.basePreparation, projectRoot: roi.receipt.project, scenePath: roi.receipt.scenePath,
      subsetSceneSha256: roi.receipt.sceneSha256 } : await prepareBusinessGiSubset({ ...options, output: path.join(output, 'project'), previewBudget: true });
  report.preparation = preparation;
  await checkpoint('business-copy-prepared');
  // 此独立pilot固定小预算；不改变原工程，也不以它冒充原工厂同条件性能对照。
  const preparedFile = JSON.parse(await fs.readFile(preparation.scenePath, 'utf8'));
  if (!roi) preparedFile.scene.sceneSettings.lighting.bake = { ...preparedFile.scene.sceneSettings.lighting.bake,
    ...(options.environmentOnly ? report.environmentPlan.pilot : { device: 'cpu', atlasSize: 1024, quality: 'preview', texelsPerMeter: 4 }) };
  if (options.environmentOnly) {
    const relative = path.relative(preparation.sourceProject, report.environmentPlan.environmentFile).replaceAll('\\', '/');
    assert.equal(preparation.copiedAssets.find(asset => asset.path === relative)?.sha256, report.environmentPlan.environmentSha256, '必须保留全部原环境文件字节');
  }
  if (!roi) await fs.writeFile(preparation.scenePath, JSON.stringify(preparedFile, null, 2) + '\n');
  report.pilotSettings = preparedFile.scene.sceneSettings.lighting.bake;
  report.preparedSceneSha256 = sha(await fs.readFile(preparation.scenePath));
  const port = await findLightingSmokePort(); report.sourceServerPort = port;
  server = await createServer({ root: repository, server: { host: '127.0.0.1', port, strictPort: true, hmr: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: ['react', 'react-dom/client', 'react/jsx-runtime', '@babylonjs/core', '@babylonjs/loaders', '@linkiez/dxf-renew', 'typescript', 'mqtt', 'zustand'] } });
  await server.listen(); await server.watcher.close();
  const address = server.resolvedUrls.local[0], userData = path.join(output, 'user-data'); await fs.mkdir(userData);
  if (gamma) await fs.writeFile(path.join(userData, 'recent-workspaces.json'), JSON.stringify({ version: 1, projects: [], scenes: [{ filePath: preparation.scenePath, lastOpenedAt: new Date().toISOString() }] }));
  await fs.writeFile(path.join(userData, 'data-platform-config.json'), JSON.stringify({ version: 2, baseUrl: '', workspaceRoot: output }));
  bootstrap = path.join(repository, '.tmp-phase2-gi-' + randomUUID() + '.mjs');
  const moduleUrl = name => pathToFileURL(path.join(repository, 'dist-electron/ipc', name + '.js')).href;
  await fs.writeFile(bootstrap, "import {app} from 'electron';\napp.setPath('userData'," + JSON.stringify(userData) + ');\n'
    + 'globalThis.phase2GiHost={assets:await import(' + JSON.stringify(moduleUrl('projectAssetStore')) + '),registry:await import('
    + JSON.stringify(moduleUrl('assetRegistry')) + '),loadPackages:async()=>({source:await import(' + JSON.stringify(moduleUrl('digitalTwinSourcePackage'))
    + '),dist:await import(' + JSON.stringify(moduleUrl('digitalTwinDistPackage')) + '),images:await import(' + JSON.stringify(moduleUrl('dataPlatformImageSync')) + ')})};\n'
    + (gamma ? gammaTransportBootstrap(pathToFileURL(path.join(repository, 'dist-electron/shared/sceneLightingBakeBinary.js')).href) : '')
    + 'await import(' + JSON.stringify(pathToFileURL(path.join(repository, 'dist-electron/main.js')).href) + ');\n', { flag: 'wx' });
  bootstrapOwned = true;
  const env = { ...process.env, VITE_DEV_SERVER_URL: address, OPEN_DEVTOOLS: 'false' }; delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({ args: [bootstrap, '--user-data-dir=' + userData], cwd: repository, env, timeout: 120000 });
  report.applicationPid = application.process().pid;
  report.app = await application.evaluate(({ app }) => ({ appPath: app.getAppPath(), appVersion: app.getVersion(), userData: app.getPath('userData'), versions: process.versions }));
  report.app.repositoryPackageVersion = JSON.parse(await fs.readFile('package.json', 'utf8')).version;
  report.app.launchMode = 'native ESM bootstrap; appVersion may reflect Electron default app, not repository package version';
  assert.equal(path.resolve(report.app.userData), userData, '必须使用独立userData，不能触碰用户编辑器会话');
  await application.evaluate(async ({ dialog, BrowserWindow }, setup) => {
    await globalThis.phase2GiHost.assets.activateProjectRoot(setup.projectRoot);
    globalThis.phase2GiHost.registry.authorizeAssetRoot(setup.projectRoot);
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: setup.scenePath });
    for (const window of BrowserWindow.getAllWindows()) window.webContents.setBackgroundThrottling(false);
  }, { projectRoot: preparation.projectRoot, scenePath: preparation.scenePath });
  page = await application.firstWindow(); page.setDefaultTimeout(120000); await page.setViewportSize({ width: 1440, height: 960 });
  page.on('pageerror', error => report.pageErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(message.text());
    else if (message.text().startsWith('[phase2-gi-progress]')) console.log(message.text()); });
  await page.getByRole('button', { name: '进入空白编辑器', exact: true }).click();
  await page.locator('canvas.scene-canvas').waitFor(); await page.bringToFront();
  await page.exposeFunction('__phase2GiCapture', async value => {
    const file = path.join(output, 'capture-' + report.inputCaptures.length + '.json'); await fs.writeFile(file, value);
    const data = JSON.parse(value); report.inputCaptures.push({ file, sha256: sha(Buffer.from(value)), jobId: data.jobId, signature: data.signature, geometrySignature: data.geometrySignature,
      proofKind: data.proofKind ?? 'raw-capture', meshCount: data.meshCount ?? data.meshes.length,
      rendererHeapMaxObservedBytes: data.rendererHeapMaxObservedBytes ?? null,
      receiverCount: data.receiverCount ?? data.meshes.filter(mesh => mesh.receiver !== false).length,
      triangleCount: data.triangleCount ?? data.meshes.reduce((sum, mesh) => sum + mesh.indices.length / 3, 0), lights: data.lights, environment: data.environment });
    if (roi) {
      assert.equal(report.inputCaptures.length, 1, 'ROI只允许本次Store唯一fresh capture，不能复用或重复旧输入');
      report.roi.freshCapture = assertReceiverRoiCapture(roi.bundle, data, report.pilotSettings);
      report.preflight = { phase: 'ready', report: data.preflight, basis: 'same fresh normal-Store input; production authorized inspection still required' };
      report.roiFreshCaptureChecked = true;
      report.workloadClass = data.receiverTriangleCount >= ROI_LIMITS.minReceiverTriangles && data.receiverCount >= ROI_LIMITS.minSourceReceiverNodes
        ? 'medium-receiver-ROI-functional-only' : 'small-functional-only';
    }
    if (admission) {
      assert.equal(data.geometrySignature, admission.inputCaptures[0].geometrySignature, '生产fresh capture几何内容必须等于独立冻结预检');
      for (const field of ['meshCount', 'receiverCount', 'triangleCount']) assert.equal(data[field], admission.preflight.report[field], 'fresh capture范围不能改变：' + field);
      assert.deepEqual(data.settings, report.pilotSettings);
      assert.ok(data.geometryBytes <= report.environmentPlan.preregisteredBudget.maxInputGeometryBytes, 'fresh capture输入仍须符合512MiB预算');
      assert.ok(data.rendererHeapMaxObservedBytes !== null && data.rendererHeapMaxObservedBytes <= report.environmentPlan.preregisteredBudget.maxObservedRendererHeapBytes,
        'fresh capture观察heap不得未知或超预算');
      report.directStartFreshCaptureChecked = true;
    }
  });
  await page.evaluate(async ({ content, scenePath }) => {
    const { useEditorStore } = await import('/src/editor/store/editorStore.ts');
    const { SceneRuntime } = await import('/src/runtime/babylon/SceneRuntime.ts');
    const preparation = await import('/src/editor/loading/scenePreparationProgress.ts');
    const state = { store: useEditorStore, runtime: null, preparation, progress: [], capturesInstalled: false };
    window.phase2Gi = state;
    const original = SceneRuntime.prototype.sync;
    SceneRuntime.prototype.sync = function (...args) { state.runtime = this; return Reflect.apply(original, this, args); };
    state.unsubscribeProgress = window.editorApi.onLightingBakeProgress(event => {
      state.progress.push(event); const bucket = event.phase + ':' + Math.floor(event.progress * 10);
      if (bucket !== state.lastBucket) { state.lastBucket = bucket; console.log('[phase2-gi-progress]', event.phase, Math.round(event.progress * 100) + '%', event.message); }
    });
    if (!useEditorStore.getState().loadSceneFromContent(content, scenePath)) throw new Error('实际Store拒绝业务子场景');
  }, { content: await fs.readFile(preparation.scenePath, 'utf8'), scenePath: preparation.scenePath });
  await page.waitForFunction(() => {
    const state = window.phase2Gi, runtime = state.runtime; if (!runtime) return false;
    const snapshot = runtime.getInitialLoadSnapshot(); if (snapshot.error) throw new Error(String(snapshot.error));
    const metrics = runtime.getPerformanceMetrics().loading;
    if (metrics.failedModelAcquisitions) throw new Error('真实模型资源获取失败');
    return !snapshot.progress.loading && !metrics.pendingModelCount && !metrics.active.length
      && !state.preparation.isScenePreparationActive() && runtime.scene.isReady();
  }, null, { timeout: 180000 });
  report.classification = await page.evaluate(() => window.phase2Gi.runtime.getLightingClassification().map(entry => ({
    key: entry.key, entityId: entry.entityId, nodeKey: entry.nodeKey, name: entry.name, mobility: entry.mobility,
    bakeIndirect: entry.bakeIndirect, castShadows: entry.castShadows, receiveShadows: entry.receiveShadows, reason: entry.reason,
  })));
  report.actualPilotSettings = await page.evaluate(() => window.phase2Gi.store.getState().scene.sceneSettings.lighting.bake);
  assert.deepEqual(report.actualPilotSettings, report.pilotSettings, '实际反序列化设置必须与预注册pilot预算一致');
  if (options.environmentOnly) assert.equal(await page.evaluate(() => window.phase2Gi.runtime.getPerformanceMetrics().modelRuntimeCount), 0, '环境only不能混入外置模型运行时');
  await checkpoint('actual-editor-ready');
  if (roi) {
    const observation = await page.evaluate(() => ({ runtimeError: window.phase2Gi.runtime.getLightingBakeRuntimeError(),
      statistics: window.phase2Gi.runtime.getModelStatistics(), classification: window.phase2Gi.runtime.getLightingClassification() }));
    report.roiObservation = { kind: 'ACTUAL_EDITOR_RUNTIME_CLASSIFICATION', captureId: randomUUID(), editorPid: report.applicationPid,
      capturedAt: new Date().toISOString(), scenePath: preparation.scenePath, sceneSha256: report.preparedSceneSha256,
      driverReport: path.join(output, 'report.json'), environmentSha256: roi.bundle.approved.environmentSha256, versionLock: report.roiVersionLock, ...observation };
    const expected = { scenePath: preparation.scenePath, sceneSha256: report.preparedSceneSha256 };
    if (roi.mode === 'observe-unbound') verifyReceiverRoiRuntime(roi.bundle, preparedFile, report.roiObservation, expected);
    else verifyAppliedReceiverRoi(roi.bundle, preparedFile, report.roiObservation, expected, roi.receipt.binding);
    await fs.writeFile(path.join(output, 'roi-runtime-observation.json'), JSON.stringify(report.roiObservation, null, 2) + '\n', { flag: 'wx' });
  }
  if (roi && (roi.mode !== 'checked-run' || !options.executeBake)) {
    assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.consoleErrors, []);
    report.status = 'ROI_ACTUAL_CLASSIFICATION_ONLY_NOT_CAPTURED_NOT_BAKED';
    report.acceptance = 'read-only actual identity/policy observation; no preflight/capture/Blender/Viewer acceptance';
  } else {
  report.engine = await page.evaluate(() => window.editorApi.getLightingBakeEngineConfiguration());
  if (roi) {
    const enabled = await page.evaluate(() => { window.phase2Gi.store.getState().updateLightingBakeSettings({ enabled: true });
      return window.phase2Gi.store.getState().scene.sceneSettings.lighting.bake; });
    assert.deepEqual(enabled, { ...report.pilotSettings, enabled: true }, '只经Store启用，不覆盖ROI pilot'); report.pilotSettings = enabled;
    report.roi.enabledThroughStore = true;
  }
  if (gamma) {
    report.gammaUi = await exerciseGammaGiUi({ page, scenePath: preparation.scenePath, output });
    // 首页的独立场景重开会清空工程会话；恢复启动时同一隔离工程，不改场景内容或编码。
    await application.evaluate(async (_electron, projectRoot) => {
      await globalThis.phase2GiHost.assets.activateProjectRoot(projectRoot);
      globalThis.phase2GiHost.registry.authorizeAssetRoot(projectRoot);
    }, preparation.projectRoot);
    report.gammaFixtureProjectContextRestoredAfterRecentScene = true;
    const actual = await page.evaluate(() => window.phase2Gi.store.getState().scene.sceneSettings.lighting.bake);
    const { lightmapEncoding, ...unchanged } = actual;
    assert.equal(lightmapEncoding, 'rgbm-gamma'); assert.deepEqual(unchanged, report.pilotSettings, 'UI只能更改显式Gamma编码，预算/质量参数不能漂移');
    report.gammaInitialPilotSettings = report.pilotSettings; report.pilotSettings = actual; report.actualPilotSettings = actual;
    await checkpoint('gamma-real-ui-saved-reopened');
  }
  await page.evaluate(async ({ environmentOnly, directStart, receiverRoi }) => {
    const lighting = window.phase2Gi.runtime.environment.lightingRuntime, original = lighting.captureBakeInput;
    const inspect = receiverRoi ? (await import('/electron/shared/sceneLightingBakePreflight.ts')).inspectLightingBakeInput : null;
    let captureCount = 0;
    lighting.captureBakeInput = async function (...args) {
      if (receiverRoi && ++captureCount !== 1) throw new Error('ROI只允许唯一fresh capture');
      const sample = () => { const bytes = performance.memory?.usedJSHeapSize;
        if (Number.isFinite(bytes) && bytes > 0) window.phase2Gi.captureHeapMaxObservedBytes = Math.max(window.phase2Gi.captureHeapMaxObservedBytes ?? 0, bytes); };
      const forwarded = [...args];
      if (environmentOnly) { const progress = forwarded[2]; forwarded[2] = (...values) => { sample(); return progress?.(...values); }; sample(); }
      const value = await Reflect.apply(original, this, forwarded);
      if (environmentOnly) sample();
      const proof = environmentOnly ? { proofKind: 'metadata-of-actual-capture-not-full-numeric-copy', jobId: value.jobId,
        signature: value.signature, geometrySignature: value.geometrySignature, settings: value.settings,
        rendererHeapMaxObservedBytes: window.phase2Gi.captureHeapMaxObservedBytes ?? null,
        meshCount: value.meshes.length, receiverCount: value.meshes.filter(mesh => mesh.receiver !== false).length,
        triangleCount: value.meshes.reduce((sum, mesh) => sum + mesh.indices.length / 3, 0),
        geometryBytes: value.meshes.reduce((sum, mesh) => sum + ['positions', 'normals', 'indices', 'uvs', 'uvs2', 'colors', 'tangents', 'worldMatrix']
          .reduce((values, name) => values + (mesh[name]?.length ?? 0) * 8, 0), 0),
        keys: value.meshes.map(mesh => ({ key: mesh.key, entityId: mesh.entityId, positions: mesh.positions.length, indices: mesh.indices.length,
          ...(receiverRoi ? { nodeKey: mesh.nodeKey, receiver: mesh.receiver !== false, worldMatrix: Array.from(mesh.worldMatrix) } : {}) })),
        ...(receiverRoi ? { receiverTriangleCount: value.meshes.filter(mesh => mesh.receiver !== false).reduce((sum, mesh) => sum + mesh.indices.length / 3, 0),
          preflight: inspect(value) } : {}),
        lights: value.lights, environment: value.environment } : value;
      if (receiverRoi) { sample(); proof.rendererHeapMaxObservedBytes = window.phase2Gi.captureHeapMaxObservedBytes ?? null; }
      await window.__phase2GiCapture(JSON.stringify(proof, (_key, item) => ArrayBuffer.isView(item) ? Array.from(item) : item));
      return value;
    };
    if (!directStart) window.phase2Gi.store.getState().requestLightingBakePreflight();
  }, { environmentOnly: Boolean(options.environmentOnly), directStart: Boolean(admission || roi), receiverRoi: Boolean(roi) });
  if (!roi) {
  if (admission) report.preflight = { phase: 'admitted-by-frozen-independent-process-not-repeated-here', report: admission.preflight.report };
  else {
    await page.waitForFunction(() => ['ready', 'blocked', 'error'].includes(window.phase2Gi.store.getState().lightingBakePreflight.phase), null, { timeout: 120000 });
    report.preflight = await page.evaluate(() => window.phase2Gi.store.getState().lightingBakePreflight);
    assert.equal(report.preflight.phase, 'ready', JSON.stringify(report.preflight));
  }
  const budget = report.preflight.report;
  assert.ok(budget.receiverCount > 0 && budget.triangleCount > 0 && budget.probeCount > 0);
  assert.ok(budget.triangleCount <= options.preflightMaxTriangles && budget.probeCount <= options.preflightMaxProbes, '真实几何或探针超过本轮预先冻结预算；不得删面/削光照追成功');
  if (options.environmentOnly) {
    const limits = report.environmentPlan.preregisteredBudget;
    assert.ok(budget.geometryBytes <= limits.maxInputGeometryBytes && budget.estimatedDerivedNumericBytes <= limits.maxDerivedNumericBytes
      && budget.minTextureBytes <= limits.maxTextureMiB * 1024 ** 2, '原环境实际捕获超出独立新案例预算，不能扩大门槛');
    report.preflightRendererHeap = await page.evaluate(() => {
      const currentBytes = performance.memory?.usedJSHeapSize ?? null, capture = window.phase2Gi.captureHeapMaxObservedBytes ?? null;
      return { duringCaptureMaxObservedBytes: capture, maxObservedBytes: Number.isFinite(currentBytes) && currentBytes > 0 ? Math.max(capture ?? 0, currentBytes) : capture,
        currentBytes, basis: 'performance.memory.usedJSHeapSize; samples around each exported mesh and after IPC; not OS memory or exact continuous peak' };
    });
    assert.ok(report.preflightRendererHeap.maxObservedBytes !== null && report.preflightRendererHeap.maxObservedBytes <= limits.maxObservedRendererHeapBytes,
      '实际Renderer准入heap观察不得未知或超2GiB，不以未知冒充0');
  }
  report.workloadClass = budget.triangleCount >= 20000 && budget.receiverCount >= 20 ? 'medium-by-declared-20k-triangle-20-receiver-threshold' : 'small-functional-only';
  report.workloadThresholdInterpretation = 'explicit task threshold, not an industry standard; entity count does not establish medium workload';
  await checkpoint('actual-preflight-complete');
  }
  if (!options.executeBake) { report.status = 'PREFLIGHT_ONLY_NOT_BAKED'; }
  else {
    assert.equal(report.engine.engine.available, true, JSON.stringify(report.engine));
    if (options.environmentOnly) {
      resourceMonitor = createEnvironmentGiBudgetMonitor({ output, limits: report.environmentPlan.preregisteredBudget,
        page: () => page, jobIds: () => report.inputCaptures.map(value => value.jobId), onViolation: async errors => {
          report.resourceBudgetViolation = errors; viewerCancellation.abort();
          if (page && !page.isClosed()) await page.evaluate(() => window.phase2Gi.store.getState().cancelLightingBake());
          if (application) await application.evaluate(() => globalThis.phase2GiPackageController?.abort());
        } });
      report.resourceObservations = resourceMonitor.observed;
      await resourceMonitor.start(); assert.equal(report.resourceBudgetViolation, undefined, '资源已超预算，不能启动新烘焙');
    }
    await page.evaluate(() => window.phase2Gi.store.getState().requestLightingBake());
    await checkpoint('real-cycles-requested-through-store');
    await page.waitForFunction(() => {
      const state = window.phase2Gi.store.getState();
      if (['error', 'cancelled'].includes(state.lightingBakeStatus.phase)) throw new Error(state.lightingBakeStatus.message);
      return !state.lightingBakeRequest && state.lightingBakeStatus.phase === 'idle' && state.scene.sceneSettings.lighting.result?.surfaces.length > 0;
    }, null, { timeout: 600000 });
    report.snapshot = await page.evaluate(async () => { await window.phase2Gi.runtime.waitForLightingReady();
      if (window.phase2Gi.runtime.getLightingBakeRuntimeError()) throw new Error(window.phase2Gi.runtime.getLightingBakeRuntimeError());
      return window.phase2Gi.store.getState().scene.sceneSettings.lighting.result; });
    report.progress = await page.evaluate(() => window.phase2Gi.progress);
    if (admission) assert.equal(report.directStartFreshCaptureChecked, true, '直接开始也必须通过生产fresh capture与实际预检核对');
    if (roi) { assert.equal(report.roiFreshCaptureChecked, true); assert.equal(report.inputCaptures.length, 1);
      assert.equal(report.snapshot.statistics.triangleCount, 866611, 'snapshot全输入统计不能偷换成receiver总量'); }
    if (resourceMonitor) { await resourceMonitor.markAtlas(report.snapshot.statistics.textureBytes); resourceMonitor.assertComplete(); }
    await checkpoint('real-cycles-applied-and-committed');
    if (gamma) {
      report.gammaTaskHistory = await page.evaluate(() => window.editorApi.getLightingBakeHistory());
      const completed = report.gammaTaskHistory.tasks.find(task => task.jobId === report.progress.find(event => event.phase === 'completed')?.jobId
        || task.signature === report.snapshot.signature);
      assert.ok(completed); assert.equal(completed.status, 'completed'); assert.equal(completed.phase, 'completed');
      const taskDirectory = path.join(preparation.projectRoot, '.babylon-editor', 'lighting-bake-jobs', completed.taskId);
      const files = await fs.readdir(taskDirectory, { withFileTypes: true });
      assert.ok(files.every(file => file.isFile() && !file.isSymbolicLink()), '新任务仍须保持平面普通文件，不得生成__pycache__');
      report.gammaTaskDirectory = { path: taskDirectory, files: files.map(file => file.name), noPycache: !files.some(file => file.name === '__pycache__') };
      report.gammaPng = await inspectGammaGiPngs({ snapshot: report.snapshot, output });
      report.gammaTransport = await verifyGammaGiTransport(application, report.inputCaptures);
    }
    await page.getByRole('button', { name: '保存场景', exact: true }).click();
    await page.waitForFunction(signature => window.phase2Gi.store.getState().persistedSceneContent?.includes(signature), report.snapshot.signature, { timeout: 60000 });
    const saved = JSON.parse(await fs.readFile(preparation.scenePath, 'utf8'));
    assert.equal(saved.scene.sceneSettings.lighting.result.signature, report.snapshot.signature);
    report.editorScreenshot = path.join(output, 'editor-gi.png'); await page.screenshot({ path: report.editorScreenshot });
    await checkpoint('actual-scene-saved');
    report.packages = await application.evaluate(async (_electron, setup) => {
      const { source, dist, images } = await globalThis.phase2GiHost.loadPackages();
      const controller = new AbortController(); globalThis.phase2GiPackageController = controller;
      const original = await source.buildDigitalTwinSourcePackage({ projectRoot: setup.projectRoot, sharedResourcesRoot: setup.shared,
        entrySceneFilePath: setup.scenePath, outputRoot: setup.sourceOutput, signal: controller.signal,
        manifest: { projectId: setup.projectId, projectName: '二期真实业务GI本地验证', editorProjectId: null, baseVersionId: null, resourceRevision: '1' },
        isPlatformImageReference: images.isPlatformImageReference, findSyncedImageForReference: images.findSyncedImageForReference,
        skyboxCacheDependencies: { getSharedProjectSkyboxRoot: () => null } });
      const deployed = await dist.buildDigitalTwinDistPackage({ projectId: setup.projectId, publishName: '二期真实业务GI本地验证',
        sceneContent: original.entrySceneContent, sourceResourceFiles: original.resourceFiles, outputRoot: setup.distOutput, signal: controller.signal });
      return { source: { filePath: original.filePath, fileSize: original.fileSize, sha256: original.sha256, entryScenePath: original.entryScenePath,
        warnings: original.warnings, omittedResources: original.omittedResources }, dist: deployed };
    }, { projectId, projectRoot: preparation.projectRoot,
      scenePath: preparation.scenePath, shared: path.join(output, 'shared'), sourceOutput: path.join(output, 'source-package'), distOutput: path.join(output, 'dist-package') });
    assert.equal(sha(await fs.readFile(report.packages.source.filePath)), report.packages.source.sha256);
    assert.equal(sha(await fs.readFile(report.packages.dist.filePath)), report.packages.dist.sha256);
    await checkpoint('formal-local-source-dist-packagers-complete');
    const sourceReader = await openGiArtifactReader(report.packages.source.filePath), distReader = await openGiArtifactReader(report.packages.dist.filePath);
    report.sourceArchive = { reader: 'zip-without-extra-extraction', entries: sourceReader.archiveEntries, unpackedBytes: sourceReader.unpackedBytes };
    report.distArchive = { reader: 'zip-without-extra-extraction', entries: distReader.archiveEntries, unpackedBytes: distReader.unpackedBytes };
    report.sourceReadback = await verifyGiSourceReadback({ root: report.packages.source.filePath, entryScenePath: report.packages.source.entryScenePath,
      expectedSnapshot: report.snapshot, expectedScene: saved.scene,
      ...(roi ? { expectedReceiverTriangles: report.roi.freshCapture.receiverTriangleCount } : {}) });
    if (resourceMonitor) await resourceMonitor.stop();
    await application.close(); application = null; report.editorClosedBeforeViewer = true;
    await checkpoint('source-readback-complete-viewer-starting');
    report.viewer = await verifyBusinessGiViewer({ root: report.packages.dist.filePath, snapshot: report.snapshot, expectedScene: saved.scene, output, projectId,
      signal: viewerCancellation.signal, maxRendererHeapBytes: options.environmentOnly ? report.environmentPlan.preregisteredBudget.maxObservedRendererHeapBytes : undefined,
      ...(roi ? { expectedReceiverTriangles: report.roi.freshCapture.receiverTriangleCount, iframe: true } : {}),
      ...(gamma ? { gamma: true, iframe: true } : {}) });
    if (resourceMonitor) { await resourceMonitor.stop(); resourceMonitor.assertComplete(); }
    assert.equal(report.resourceBudgetViolation, undefined);
    assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.consoleErrors, []);
    report.status = 'PASS';
    report.acceptance = report.workloadClass.startsWith('medium-') ? 'real-business-medium-functional-GI-SOURCE-DIST' : 'real-business-small-functional-GI-SOURCE-DIST; medium E2 not satisfied';
    if (roi) report.acceptance = 'real-business-medium-receiver-ROI-functional-GI-SOURCE-DIST; full-environment receiver case remains failed; actual predicate skip remains unmeasured';
  }
  }
} catch (error) {
  report.status = 'FAIL'; report.error = String(error.stack ?? error);
  if (gamma && application) report.gammaTransportFailureRecords = await application.evaluate(() => globalThis.phase2GiHost.transport).catch(error => ({ readbackError: String(error) }));
  if (page && !page.isClosed()) report.failureState = await page.evaluate(() => ({
    bakeStatus: window.phase2Gi?.store.getState().lightingBakeStatus, progress: window.phase2Gi?.progress,
    runtimeError: window.phase2Gi?.runtime?.getLightingBakeRuntimeError(),
  })).catch(error => ({ readbackError: String(error) }));
  if (page && !page.isClosed()) { report.failureScreenshot = path.join(output, 'failure.png'); await page.screenshot({ path: report.failureScreenshot }).catch(() => {}); }
  process.exitCode = 1;
} finally {
  const cleanup = async (name, run) => { try { await run(); if (gamma || roi) (report.cleanupActions ??= []).push({ name, status: 'PASS', finishedAt: new Date().toISOString() }); } catch (error) {
    (report.cleanupErrors ??= []).push({ name, error: String(error) }); report.status = 'FAIL'; process.exitCode = 1;
  } };
  if (resourceMonitor) await cleanup('stop-resource-monitor', () => resourceMonitor.stop());
  if (page && !page.isClosed()) await cleanup('cancel-current-bake', () => page.evaluate(() => {
    window.phase2Gi?.unsubscribeProgress?.(); if (window.phase2Gi?.store.getState().lightingBakeRequest) window.phase2Gi.store.getState().cancelLightingBake();
  }));
  if (application) {
    if (gamma) await cleanup('restore-owned-IPC-observer', () => application.evaluate(() => globalThis.phase2GiHost.restoreTransport?.()));
    await cleanup('cancel-current-package', () => application.evaluate(() => globalThis.phase2GiPackageController?.abort()));
    await cleanup('close-owned-editor', () => application.close());
  }
  if (server) await cleanup('close-owned-vite', () => server.close());
  if (bootstrapOwned) await cleanup('remove-owned-bootstrap', () => fs.unlink(bootstrap));
  if (report.preparation) await cleanup('original-input-readback', async () => {
    report.originalSceneUnchanged = sha(await fs.readFile(options.sourceScene)) === report.preparation.sourceSceneSha256;
    assert.equal(report.originalSceneUnchanged, true, '原场景被改变');
    report.originalAssetHashesStillMatch = true;
    for (const asset of report.preparation.copiedAssets) {
      const file = path.join(report.preparation.sourceProject, asset.path); if (sha(await fs.readFile(file)) !== asset.sha256) report.originalAssetHashesStillMatch = false;
    }
    assert.equal(report.originalAssetHashesStillMatch, true, '原资产被改变');
  });
  if (report.sourceHashesBefore) await cleanup('selected-source-version-readback', async () => {
    report.sourceHashesAfter = await sourceHashes();
    report.sourceVersionsStable = JSON.stringify(report.sourceHashesAfter) === JSON.stringify(report.sourceHashesBefore);
    assert.equal(report.sourceVersionsStable, true, '验收期间关键源文件改变，不能将版本混合');
  });
  if (report.roiVersionLock) await cleanup('ROI-source-build-tree-readback', async () => {
    const after = await readReceiverRoiVersionLock(repository); assertReceiverRoiVersionLock(report.roiVersionLock, after); report.roiVersionsStable = true;
  });
  await save(); console.log(JSON.stringify({ status: report.status, output, workload: report.workloadClass, error: report.error }));
}
