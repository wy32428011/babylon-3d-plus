/* global window */
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createServer } from 'vite';
import { _electron as electron } from 'playwright';
import { findLightingSmokePort } from '../tests/helpers/lightingSmokePort.mjs';
import { verifyGiSourceReadback } from '../tests/helpers/phase2GiArtifacts.mjs';
import { openGiArtifactReader } from '../tests/helpers/phase2GiArchiveReader.mjs';
import { mipsSha, prepareMipsBusinessFixture, exerciseMipsUi, inspectMipsAssets, installMipsProbe, verifyMipsProbe, verifyMipsViewers, verifyMipArchiveStore, saveReopenMipsResult, waitForMipsLighting,
  makeNativeRestoreControlDocument, installNativeRestoreControl, verifyNativeRestoreControl, mipsContextRestoreProtocol } from '../tests/helpers/phase2MipsGiAcceptance.mjs';

const options = { levels: 4, encoding: 'rgbm-gamma', bake: false };
for (let index = 2; index < process.argv.length; index++) { const argument = process.argv[index];
  if (argument === '--output') options.output = process.argv[++index];
  else if (argument === '--source') options.sourceScene = process.argv[++index];
  else if (argument === '--entity') options.entityId = process.argv[++index];
  else if (argument === '--levels') options.levels = Number(process.argv[++index]);
  else if (argument === '--encoding') options.encoding = process.argv[++index];
  else if (argument === '--negative-report') options.negativeReport = process.argv[++index];
  else if (argument === '--resume-report') options.resumeReport = process.argv[++index];
  else if (argument === '--verify') options.verify = true;
  else if (argument === '--diagnostic-restore') options.diagnosticRestore = true;
  else if (argument === '--native-control') options.nativeControl = true;
  else if (argument === '--bake') options.bake = true;
  else throw new Error('未知B9参数：' + argument);
}
assert.ok(options.output && [1, 2, 3, 4].includes(options.levels) && ['rgbm', 'rgbm-gamma'].includes(options.encoding));
assert.ok(!(options.resumeReport && options.negativeReport));
assert.ok(options.negativeReport || options.resumeReport ? !options.sourceScene && !options.entityId : options.sourceScene && options.entityId, '正例明确原场景/单一业务根；负例/重开仅给准确既有报告');
if (options.resumeReport) assert.ok(options.verify && !options.bake, '复用已烘焙场景只能--verify，禁止--bake');
assert.ok(!options.verify || options.resumeReport, '--verify仅用于显式resume；新producer必须--bake');
if (options.diagnosticRestore) assert.ok(options.resumeReport && options.verify && !options.bake, '侵入式GL诊断仅允许resume，无Cycles且不能当功能PASS');
if (options.nativeControl) assert.ok(options.resumeReport && options.verify && !options.bake && !options.negativeReport && !options.diagnosticRestore, 'native对照只能独立resume诊断，禁止Cycles/负例/GLwrapper');
const repository = process.cwd(), output = path.resolve(options.output), relative = path.relative(path.resolve('output'), output);
assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative)); await fs.mkdir(output);
const report = { status: 'RUNNING', options, scope: options.negativeReport ? 'Read original owned B8 Gamma scene; unsaved live Mip request must reject and preserve prior scene/assets/result; no original scene write' : 'Owned small business occluder plus real Standard/PBR single-chart receivers; explicit B9 functional integration, not medium workload/performance',
  acceptanceProtocol: mipsContextRestoreProtocol,
  startedAt: new Date().toISOString(), diagnosticMode: Boolean(options.diagnosticRestore), ...(options.diagnosticRestore ? { functionalPass: false } : {}), pageErrors: [], consoleErrors: [], captures: [], cleanup: [] };
const coreFiles = ['electron/lighting-bake/cycles_bake.py', 'electron/lighting-bake/lightmap_mips.py', 'electron/shared/sceneLightingTextureCodec.ts', 'electron/shared/sceneLightingLightmapMips.ts',
  'src/runtime/babylon/lightingRuntimeResources.ts', 'src/runtime/babylon/lightingLightmapMipTexture.ts', 'src/runtime/babylon/SceneLightingRuntime.ts', 'src/runtime/babylon/BakedLightingMaterialPlugin.ts', 'electron/ipc/localSceneResourceRecovery.ts'];
const toolFiles = ['scripts/phase2-mips-business.mjs', 'tests/helpers/phase2MipsGiAcceptance.mjs', 'scripts/lib/phase2GlRestoreTrace.mjs'];
const hashFiles = async files => Object.fromEntries(await Promise.all(files.map(async file => [file, mipsSha(await fs.readFile(file))])));
const save = async phase => { report.phase = phase; await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n'); console.log('[phase2-mips]', phase); };
let application, page, server, bootstrap;
try {
  report.toolHashes = await hashFiles(toolFiles); await fs.mkdir(path.join(output, 'tool-snapshot'));
  for (const file of toolFiles) await fs.copyFile(file, path.join(output, 'tool-snapshot', path.basename(file)));
  report.sourceHashes = await hashFiles(coreFiles);
  report.buildHashes = await hashFiles(['dist-electron/main.js', 'dist-electron/lighting-bake/cycles_bake.py', 'dist-electron/lighting-bake/lightmap_mips.py', 'dist-viewer-template/index.html', 'dist-viewer-template/viewer-capabilities.json']);
  let preparation, nativeContent;
  if (options.negativeReport || options.resumeReport) { const previousFile = options.negativeReport ?? options.resumeReport, previousBytes = await fs.readFile(previousFile), previous = JSON.parse(previousBytes.toString('utf8'));
    preparation = { ...previous.preparation }; const saved = JSON.parse(await fs.readFile(preparation.scenePath, 'utf8'));
    assert.equal(saved.scene.sceneSettings.lighting.version, 3);
    if (options.negativeReport) assert.equal(saved.scene.sceneSettings.lighting.bake.lightmapMipLevels, undefined);
    else { assert.equal(saved.scene.sceneSettings.lighting.bake.lightmapMipLevels, options.levels); assert.equal(saved.scene.sceneSettings.lighting.bake.lightmapEncoding ?? 'rgbm', options.encoding);
      report.scope = 'Read exact already-produced case2 saved scene and assets; actual Home recent open, GPU and package/Viewer verification only; no Cycles, no save to original scene';
      report.resume = { previousReport: path.resolve(previousFile), previousReportSha256: mipsSha(previousBytes), receiverTriangles: previous.captures.at(-1).receiverTriangles,
        savedSceneSha256: mipsSha(await fs.readFile(preparation.scenePath)), noCyclesRequested: true }; }
    assert.ok(saved.scene.sceneSettings.lighting.result?.surfaces.length); report.previousSnapshot = saved.scene.sceneSettings.lighting.result;
    report.negativeSceneBefore = mipsSha(await fs.readFile(preparation.scenePath));
    report.negativeAssetsBefore = await hashFiles(report.previousSnapshot.assets.map(asset => decodeURIComponent(new URL(asset.url).pathname.slice(1))));
    if (options.nativeControl) { nativeContent = JSON.stringify(makeNativeRestoreControlDocument(saved)); report.scope = 'DIAGNOSTIC_NATIVE_CONTROL_NOT_B9_PASS: first in-memory document load has bake.enabled=false/result=null; no original scene save, no Cycles, no packaging, no B9 acceptance'; report.functionalPass = false;
      report.nativeInput = { sourceScenePath: preparation.scenePath, sourceSceneSha256: report.resume.savedSceneSha256, inMemoryContentSha256: mipsSha(Buffer.from(nativeContent)), changedFieldsOnly: ['scene.sceneSettings.lighting.bake.enabled=false', 'scene.sceneSettings.lighting.result=null'], noSceneWriteRequested: true }; }
  } else preparation = await prepareMipsBusinessFixture({ ...options, output: path.join(output, 'project') });
  report.preparation = preparation; await save('owned-input-ready');
  if (!options.bake && !options.verify) { report.status = 'PREPARED_NOT_EXECUTED'; }
  else {
    const port = await findLightingSmokePort();
    server = await createServer({ root: repository, server: { host: '127.0.0.1', port, strictPort: true, hmr: false, watch: null },
      optimizeDeps: { noDiscovery: true, include: ['react', 'react-dom/client', 'react/jsx-runtime', '@babylonjs/core', '@babylonjs/loaders', '@linkiez/dxf-renew', 'typescript', 'mqtt', 'zustand'] } });
    await server.listen(); await server.watcher.close();
    const userData = path.join(output, 'user-data'); await fs.mkdir(userData);
    await fs.writeFile(path.join(userData, 'data-platform-config.json'), JSON.stringify({ version: 2, baseUrl: '', workspaceRoot: output }));
    await fs.writeFile(path.join(userData, 'recent-workspaces.json'), JSON.stringify({ version: 1, projects: [], scenes: [{ filePath: preparation.scenePath, lastOpenedAt: new Date().toISOString() }] }));
    const ipcUrl = name => pathToFileURL(path.join(repository, 'dist-electron/ipc', name + '.js')).href;
    bootstrap = path.join(repository, '.tmp-phase2-mips-' + randomUUID() + '.mjs');
    // 与已验证B8启动路径一致；不能在原生ESM顶层await app.whenReady形成ready死锁。
    await fs.writeFile(bootstrap, "import {app} from 'electron';\napp.setPath('userData'," + JSON.stringify(userData) + ');\n'
      + 'globalThis.phase2MipsHost={assets:await import(' + JSON.stringify(ipcUrl('projectAssetStore')) + '),registry:await import(' + JSON.stringify(ipcUrl('assetRegistry')) + '),source:await import('
      + JSON.stringify(ipcUrl('digitalTwinSourcePackage')) + '),dist:await import(' + JSON.stringify(ipcUrl('digitalTwinDistPackage')) + '),images:await import(' + JSON.stringify(ipcUrl('dataPlatformImageSync')) + ')};\n'
      + 'await import(' + JSON.stringify(pathToFileURL(path.join(repository, 'dist-electron/main.js')).href) + ');\n', { flag: 'wx' });
    const env = { ...process.env, VITE_DEV_SERVER_URL: server.resolvedUrls.local[0], OPEN_DEVTOOLS: 'false' }; delete env.ELECTRON_RUN_AS_NODE;
    application = await electron.launch({ args: [bootstrap, '--user-data-dir=' + userData], cwd: repository, env, timeout: 120000 }); report.ownedPid = application.process().pid;
    await application.evaluate(async ({ dialog, BrowserWindow, app }, setup) => { if (app.getPath('userData') !== setup.userData) throw new Error('wrong owned profile');
      await globalThis.phase2MipsHost.assets.activateProjectRoot(setup.projectRoot); globalThis.phase2MipsHost.registry.authorizeAssetRoot(setup.projectRoot);
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: setup.scenePath }); for (const window of BrowserWindow.getAllWindows()) window.webContents.setBackgroundThrottling(false);
    }, { userData, projectRoot: preparation.projectRoot, scenePath: preparation.scenePath });
    page = await application.firstWindow(); page.setDefaultTimeout(120000); await page.setViewportSize({ width: 1440, height: 960 });
    page.on('pageerror', error => report.pageErrors.push(error.message)); page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(message.text()); });
    await page.getByRole('button', { name: '进入空白编辑器', exact: true }).click(); await page.locator('canvas.scene-canvas').waitFor();
    await page.exposeFunction('__phase2MipsCapture', async raw => { const capture = JSON.parse(raw), file = path.join(output, 'capture-' + report.captures.length + '.json'); await fs.writeFile(file, raw);
      report.captures.push({ file, sha256: mipsSha(Buffer.from(raw)), jobId: capture.jobId, signature: capture.signature, geometrySignature: capture.geometrySignature, settings: capture.settings,
        meshCount: capture.meshes.length, receiverTriangles: capture.meshes.filter(mesh => mesh.receiver !== false).reduce((sum, mesh) => sum + mesh.indices.length / 3, 0) }); });
    await page.evaluate(async ({ content, scenePath, resume }) => { const { useEditorStore } = await import('/src/editor/store/editorStore.ts'); const { SceneRuntime } = await import('/src/runtime/babylon/SceneRuntime.ts');
      window.phase2Mips = { store: useEditorStore, runtime: null, progress: [] }; const original = SceneRuntime.prototype.sync;
      SceneRuntime.prototype.sync = function (...args) { window.phase2Mips.runtime = this; return Reflect.apply(original, this, args); };
      window.phase2Mips.unsubscribe = window.editorApi.onLightingBakeProgress(event => window.phase2Mips.progress.push(event));
      if (!resume && !useEditorStore.getState().loadSceneFromContent(content, scenePath)) throw new Error('actual Store rejected Mip fixture');
    }, { content: nativeContent ?? await fs.readFile(preparation.scenePath, 'utf8'), scenePath: preparation.scenePath, resume: Boolean(options.resumeReport && !options.nativeControl) });
    if (options.resumeReport && !options.nativeControl) { await page.getByRole('button', { name: '返回首页', exact: true }).click();
      await page.locator('.home-recent-card').filter({ hasText: path.basename(preparation.scenePath) }).getByRole('button', { name: '打开', exact: true }).click(); await save('resume-actual-recent-open-requested'); }
    await page.waitForFunction(() => { const runtime = window.phase2Mips.runtime; return runtime && !runtime.getInitialLoadSnapshot().progress.loading && runtime.scene.isReady(); }, null, { timeout: 180000 });
    report.sourceMaterials = await page.evaluate(() => window.phase2Mips.runtime.scene.meshes.filter(mesh => !mesh.metadata?.lightingDerived && mesh.getTotalIndices()).map(mesh => ({ name: mesh.name, material: mesh.material?.getClassName() })));
    if (!options.negativeReport) { assert.ok(report.sourceMaterials.some(row => row.name === preparation.fixture.standardEntityId && row.material === 'StandardMaterial'));
      assert.ok(report.sourceMaterials.some(row => row.name.includes('ActualPbrPlane') && row.material === 'PBRMaterial')); }
    if (!options.resumeReport) report.ui = await exerciseMipsUi({ page, levels: options.levels, encoding: options.encoding, scenePath: preparation.scenePath, reopen: !options.negativeReport });
    await application.evaluate(async (_electron, root) => { await globalThis.phase2MipsHost.assets.activateProjectRoot(root); globalThis.phase2MipsHost.registry.authorizeAssetRoot(root); }, preparation.projectRoot);
    await page.waitForFunction(() => window.phase2Mips.runtime?.scene.isReady(), null, { timeout: 180000 });
    if (options.nativeControl) {
      await save('DIAGNOSTIC_NATIVE_CONTROL_NOT_B9_PASS-starting-native-probe');
      await page.evaluate(installMipsProbe, { expectedLevels: options.levels }); await page.evaluate(installNativeRestoreControl, { fixture: preparation.fixture });
      report.nativeControl = await verifyNativeRestoreControl(page, { output, checkpoint: async (phase, evidence) => {
        if (evidence) (report.nativePartialEvidence ??= {})[phase] = evidence; await save(phase);
      } });
      assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.consoleErrors, []); report.status = 'DIAGNOSTIC_NATIVE_CONTROL_NOT_B9_PASS'; report.functionalPass = false;
    } else {
    if (!options.resumeReport) {
    report.engine = await page.evaluate(() => window.editorApi.getLightingBakeEngineConfiguration()); assert.equal(report.engine.engine.available, true);
    await page.evaluate(() => { const runtime = window.phase2Mips.runtime, lighting = runtime.environment.lightingRuntime, original = lighting.captureBakeInput;
      lighting.captureBakeInput = async function (...args) { const input = await Reflect.apply(original, this, args); await window.__phase2MipsCapture(JSON.stringify(input, (_key, value) => ArrayBuffer.isView(value) ? Array.from(value) : value)); return input; };
      window.phase2Mips.store.getState().requestLightingBakePreflight(); });
    await page.waitForFunction(() => ['ready', 'blocked', 'error'].includes(window.phase2Mips.store.getState().lightingBakePreflight.phase), null, { timeout: 120000 });
    report.preflight = await page.evaluate(() => window.phase2Mips.store.getState().lightingBakePreflight); assert.equal(report.preflight.phase, 'ready', JSON.stringify(report.preflight));
    await page.evaluate(() => window.phase2Mips.store.getState().requestLightingBake()); await save('actual-cpu-bake-requested');
    }
    if (options.negativeReport) {
      await page.waitForFunction(() => { const state = window.phase2Mips.store.getState(); return ['error', 'cancelled'].includes(state.lightingBakeStatus.phase)
        || !state.lightingBakeRequest && window.phase2Mips.progress.some(event => event.phase === 'completed'); }, null, { timeout: 600000 });
      report.rejection = await page.evaluate(() => ({ status: window.phase2Mips.store.getState().lightingBakeStatus, result: window.phase2Mips.store.getState().scene.sceneSettings.lighting.result, progress: window.phase2Mips.progress }));
      assert.equal(report.rejection.status.phase, 'error', 'tightUV负例必须真实拒绝，不能将意外成功或取消当PASS');
      assert.match(report.rejection.status.message, /光照 mip|chart|足印|覆盖|种子/); assert.deepEqual(report.rejection.result, report.previousSnapshot);
      assert.equal(mipsSha(await fs.readFile(preparation.scenePath)), report.negativeSceneBefore); assert.deepEqual(await hashFiles(Object.keys(report.negativeAssetsBefore)), report.negativeAssetsBefore);
      report.status = 'PASS_EXPECTED_CERTIFICATE_REJECTION_PREVIOUS_GAMMA_PRESERVED';
    } else {
      if (!options.resumeReport) {
      await page.waitForFunction(() => { const state = window.phase2Mips.store.getState(); if (['error', 'cancelled'].includes(state.lightingBakeStatus.phase)) throw new Error(state.lightingBakeStatus.message);
        return !state.lightingBakeRequest && state.lightingBakeStatus.phase === 'idle' && state.scene.sceneSettings.lighting.result?.surfaces.length > 0; }, null, { timeout: 600000 });
      await waitForMipsLighting(page);
      report.snapshot = await page.evaluate(() => window.phase2Mips.store.getState().scene.sceneSettings.lighting.result);
      assert.equal(report.captures.at(-1).settings.lightmapMipLevels, options.levels); assert.equal(report.captures.at(-1).settings.lightmapEncoding ?? 'rgbm', options.encoding);
      } else { await waitForMipsLighting(page); report.snapshot = await page.evaluate(() => window.phase2Mips.store.getState().scene.sceneSettings.lighting.result); assert.deepEqual(report.snapshot, report.previousSnapshot); }
      report.expectedGpu = await inspectMipsAssets(report.snapshot); assert.ok(report.expectedGpu.every(row => row.asset.levelCount === options.levels + 1));
      await save('actual-result-and-asset-sha-validated');
      if (!options.resumeReport) {
      report.progress = await page.evaluate(() => window.phase2Mips.progress); report.history = await page.evaluate(() => window.editorApi.getLightingBakeHistory());
      const task = report.history.tasks.find(task => task.jobId === report.progress.find(event => event.phase === 'completed')?.jobId || task.signature === report.snapshot.signature); assert.ok(task); assert.equal(task.status, 'completed'); assert.equal(task.phase, 'completed');
      const jobDirectory = path.join(preparation.projectRoot, '.babylon-editor', 'lighting-bake-jobs', task.taskId), entries = await fs.readdir(jobDirectory, { withFileTypes: true });
      assert.ok(entries.every(entry => entry.isFile() && !entry.isSymbolicLink())); report.jobFiles = entries.map(entry => entry.name);
      report.resultReopen = await saveReopenMipsResult({ page, scenePath: preparation.scenePath, expectedSnapshot: report.snapshot, levels: options.levels, encoding: options.encoding, checkpoint: save });
      } else report.resultReopen = { actualHomeRecentOpen: true, existingSavedResultExactlyPreserved: true, noSceneWriteRequested: true, assetShaVerified: true };
      if (options.resumeReport) report.progress = await page.evaluate(() => window.phase2Mips.progress);
      await application.evaluate(async (_electron, root) => { await globalThis.phase2MipsHost.assets.activateProjectRoot(root); globalThis.phase2MipsHost.registry.authorizeAssetRoot(root); }, preparation.projectRoot);
      const geometry = { triangles: report.resume?.receiverTriangles ?? report.captures.at(-1).receiverTriangles, keys: report.snapshot.surfaces.map(surface => surface.key.replace(/\/primitive:\d+(?:\/tile:[^/]+)?$/, '')) };
      await save('actual-result-reopened-starting-editor-probe');
      await page.evaluate(installMipsProbe, { expectedLevels: options.levels }); report.editor = await verifyMipsProbe(page, report.expectedGpu, { expectedEncoding: options.encoding, geometry, artifacts: { output, prefix: 'mips-editor' }, diagnosticRestore: Boolean(options.diagnosticRestore), checkpoint: async (phase, evidence) => {
        if (evidence) (report.editorPartialEvidence ??= {})[phase] = evidence; await save('editor-' + phase);
      } });
      if (options.diagnosticRestore) { report.status = 'DIAGNOSTIC_NOT_FUNCTIONAL_PASS'; report.functionalPass = false; }
      else {
      const saved = JSON.parse(await fs.readFile(preparation.scenePath, 'utf8')); assert.equal(saved.scene.sceneSettings.lighting.bake.lightmapMipLevels, options.levels);
      report.editorScreenshot = path.join(output, 'mips-editor.png'); await page.screenshot({ path: report.editorScreenshot });
      await save('editor-probe-passed-native-packaging');
      report.packages = await application.evaluate(async (_electron, setup) => { const host = globalThis.phase2MipsHost, controller = new AbortController(), signal = controller.signal; let timer;
        globalThis.phase2MipsPackageController = controller;
        try { return await Promise.race([(async () => {
        const source = await host.source.buildDigitalTwinSourcePackage({ projectRoot: setup.projectRoot, sharedResourcesRoot: setup.shared, entrySceneFilePath: setup.scenePath, outputRoot: setup.sourceOutput, signal,
          manifest: { projectId: setup.projectId, projectName: 'B9独立小功能验收', editorProjectId: null, baseVersionId: null, resourceRevision: '1' }, isPlatformImageReference: host.images.isPlatformImageReference,
          findSyncedImageForReference: host.images.findSyncedImageForReference, skyboxCacheDependencies: { getSharedProjectSkyboxRoot: () => null } });
        const dist = await host.dist.buildDigitalTwinDistPackage({ projectId: setup.projectId, publishName: 'B9独立小功能验收', sceneContent: source.entrySceneContent, sourceResourceFiles: source.resourceFiles, outputRoot: setup.distOutput, signal });
        return { source: { filePath: source.filePath, fileSize: source.fileSize, sha256: source.sha256, entryScenePath: source.entryScenePath }, dist };
        })(), new Promise((_resolve, reject) => { timer = setTimeout(() => { const error = new Error('B9 SOURCE/DIST packaging exceeded 120s'); controller.abort(error); reject(error); }, 120000); })]); }
        finally { clearTimeout(timer); }
      }, { projectId: '9000000000000000001', projectRoot: preparation.projectRoot, scenePath: preparation.scenePath, shared: path.join(output, 'shared'), sourceOutput: path.join(output, 'source-package'), distOutput: path.join(output, 'dist-package') });
      const receiverTriangles = geometry.triangles;
      report.sourceReadback = await verifyGiSourceReadback({ root: report.packages.source.filePath, entryScenePath: report.packages.source.entryScenePath, expectedSnapshot: report.snapshot, expectedScene: saved.scene, expectedReceiverTriangles: receiverTriangles });
      report.actualMipZipStore = { source: await verifyMipArchiveStore(report.packages.source.filePath, report.packages.source.entryScenePath), dist: await verifyMipArchiveStore(report.packages.dist.filePath, 'project/scene.json', true) };
      for (const kind of ['source', 'dist']) { const pkg = report.packages[kind]; assert.equal(mipsSha(await fs.readFile(pkg.filePath)), pkg.sha256); const reader = await openGiArtifactReader(pkg.filePath);
        report[kind + 'Archive'] = { entries: reader.archiveEntries, unpackedBytes: reader.unpackedBytes }; }
      await application.close(); application = null; await server.close(); server = null; await save('actual-scene-packaged-editor-closed');
      report.viewers = await verifyMipsViewers({ root: report.packages.dist.filePath, snapshot: report.snapshot, expectedScene: saved.scene, expected: report.expectedGpu, output, projectId: '9000000000000000001', levels: options.levels, encoding: options.encoding, checkpoint: save });
      assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.consoleErrors, []); report.functionalPass = report.editor.functionalPass && report.viewers.functionalPass; report.status = report.functionalPass ? 'PASS' : 'INCONCLUSIVE_NATURAL_AA_UNSTABLE';
      }
    }
    }
  }
} catch (error) { report.status = options.diagnosticRestore ? 'DIAGNOSTIC_NOT_FUNCTIONAL_PASS' : 'FAIL'; report.error = String(error.stack ?? error); process.exitCode = 1;
  if (page && !page.isClosed()) { report.failure = await page.evaluate(() => ({ status: window.phase2Mips?.store.getState().lightingBakeStatus, progress: window.phase2Mips?.progress,
    runtimeError: window.phase2Mips?.runtime?.getLightingBakeRuntimeError(), probe: window.__phase2MipsProbe?.snapshot(), nativeControl: window.__phase2NativeRestoreControl?.state(), glDiagnostics: window.__phase2MipsProbe?.diagnostics() })).catch(failure => ({ readbackError: String(failure) }));
    report.failureScreenshot = path.join(output, 'failure.png'); await page.screenshot({ path: report.failureScreenshot }).catch(() => {}); }
} finally {
  const cleanup = async (name, run) => { try { await run(); report.cleanup.push({ name, status: 'PASS' }); } catch (error) { report.cleanup.push({ name, status: 'FAIL', error: String(error) }); report.status = 'FAIL'; process.exitCode = 1; } };
  if (options.nativeControl && page && !page.isClosed()) await cleanup('dispose-owned-native-control-observers', () => page.evaluate(() => window.__phase2NativeRestoreControl?.dispose()));
  if (page && !page.isClosed()) await cleanup('cancel-only-owned-bake', () => page.evaluate(() => { window.phase2Mips?.unsubscribe?.(); if (window.phase2Mips?.store.getState().lightingBakeRequest) window.phase2Mips.store.getState().cancelLightingBake(); }));
  if (application) await cleanup('close-owned-editor', () => application.close()); if (server) await cleanup('close-owned-vite', () => server.close());
  if (bootstrap) await cleanup('remove-owned-bootstrap', () => fs.unlink(bootstrap));
  await cleanup('frozen-tools-readback', async () => { report.toolHashesAfter = await hashFiles(toolFiles); assert.deepEqual(report.toolHashesAfter, report.toolHashes); });
  await cleanup('frozen-source-readback', async () => assert.deepEqual(await hashFiles(coreFiles), report.sourceHashes));
  if (report.preparation && !options.negativeReport && !options.resumeReport) await cleanup('original-inputs-preserved', async () => { assert.equal(mipsSha(await fs.readFile(options.sourceScene)), report.preparation.sourceSceneSha256);
    for (const asset of report.preparation.copiedAssets) assert.equal(mipsSha(await fs.readFile(path.join(report.preparation.sourceProject, asset.path))), asset.sha256); });
  if (report.negativeSceneBefore) await cleanup('negative-original-scene-assets-preserved', async () => { assert.equal(mipsSha(await fs.readFile(report.preparation.scenePath)), report.negativeSceneBefore);
    assert.deepEqual(await hashFiles(Object.keys(report.negativeAssetsBefore)), report.negativeAssetsBefore); });
  if (options.diagnosticRestore) { report.status = 'DIAGNOSTIC_NOT_FUNCTIONAL_PASS'; report.functionalPass = false; }
  if (options.nativeControl) { report.nativeControlError = report.error ?? null; report.status = 'DIAGNOSTIC_NATIVE_CONTROL_NOT_B9_PASS'; report.functionalPass = false; }
  report.finishedAt = new Date().toISOString(); await save('complete'); console.log(JSON.stringify({ status: report.status, output, error: report.error }));
}
