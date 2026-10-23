/* global window */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, cp, mkdir, mkdtemp, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { _electron as electron } from 'playwright';
import { createServer } from 'vite';
import { findLightingSmokePort } from '../tests/helpers/lightingSmokePort.mjs';
import { installGlbEditorProbe, createGlbFixture, waitForGlbEditor, frameAndSaveGlbCamera,
  applyGlbPresetThroughUi, inspectGlbScene, assertGlbStandardSnapshot, assertGlbSnapshotPreserved,
  runGlbShaderDiagnostic, inspectGlbMemory } from '../tests/helpers/glbStandardPreviewEditor.mjs';
import { exportGlbViewer, inspectGlbViewer } from '../tests/helpers/glbStandardPreviewPublishing.mjs';

// 只使用独立 userData、本次临时工程和明确指定的原 GLB；不连接发布服务。
const workspace = path.resolve(import.meta.dirname, '..');
const originalGlb = process.env.GLB_PREVIEW_MODEL ?? 'E:/公司文件/数字孪生/展会/优化_20261020/压缩30M/展会_保画质精简.glb';
const output = path.resolve(process.env.GLB_PREVIEW_OUTPUT ?? 'output/glb-standard-preview');
const selected = process.argv.find(value => value.startsWith('--case='))?.slice(7) ?? 'all';
assert.ok(['all', 'model', 'environment'].includes(selected), '--case 仅支持 all、model、environment');
const modes = selected === 'all' ? ['model', 'environment'] : [selected];
const skipSource = process.argv.includes('--skip-source');
const diagnostic = process.env.GLB_PREVIEW_DIAGNOSTIC === '1';
const resumeModelReport = process.argv.find(value => value.startsWith('--resume-model='))?.slice(15);
const resumeEnvironmentReport = process.argv.find(value => value.startsWith('--resume-environment='))?.slice(21);
const executablePath = process.env.GLB_PREVIEW_BROWSER ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const runId = Date.now() + '-' + randomUUID().slice(0, 8);
const runOutput = path.join(output, runId);
const temporary = await mkdtemp(path.join(tmpdir(), 'glb-standard-preview-'));
await mkdir(runOutput, { recursive: true });
const report = { status: 'RUNNING', startedAt: new Date().toISOString(), originalGlb, temporary, runOutput,
  modes, skipSource, diagnostic, cases: [], checks: [], pageErrors: [], consoleErrors: [], rendererGone: [] };
const check = name => { report.checks.push(name); console.log('[glb-preview] ' + name); };
const saveReport = async () => {
  await writeFile(path.join(runOutput, 'result.json'), JSON.stringify(report, null, 2));
  await writeFile(path.join(output, 'latest-result.json'), JSON.stringify(report, null, 2));
};
const hashFile = async file => {
  const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk); return hash.digest('hex');
};
let server, application, page, bootstrap, metricsTimer, diagnosticCdp;
report.processMetrics = []; report.pageCrashes = []; report.electronStderr = '';

async function enterEditor() {
  await page.getByRole('button', { name: '进入空白编辑器', exact: true }).click();
  await page.locator('canvas.scene-canvas').waitFor({ state: 'visible' });
  await installGlbEditorProbe(page);
}

async function activateProject(projectRoot, scenePath) {
  await application.evaluate(async (_electron, { projectRoot, scenePath }) => {
    globalThis.glbSmokeDialogPaths = { projectRoot, scenePath };
    await globalThis.glbSmokeModules.assets.activateProjectRoot(projectRoot);
    globalThis.glbSmokeModules.registry.authorizeAssetRoot(projectRoot);
  }, { projectRoot, scenePath });
}

async function reopenThroughIpc(scenePath, recent = true) {
  // 重建 renderer 和 Babylon Scene，避免复用旧场景中的成功加载状态。
  await page.reload({ waitUntil: 'domcontentloaded' }); await enterEditor();
  // SOURCE 解压后的首次打开必须走文件选择，不能旁路最近文件白名单。
  assert.equal(await page.evaluate(({ file, recent }) => recent
    ? window.glbSmoke.store.getState().loadSceneFromFile(file)
    : window.glbSmoke.store.getState().loadScene(), { file: scenePath, recent }), true);
  await waitForGlbEditor(page, true);
}

async function runCase(mode) {
  const priorReport = mode === 'model' ? resumeModelReport : resumeEnvironmentReport;
  if (priorReport) return resumePublishing(mode, priorReport);
  const caseOutput = path.join(runOutput, mode), projectRoot = path.join(temporary, mode, 'project');
  const scenePath = path.join(projectRoot, 'Scenes', 'exhibition.scene.json');
  const modelPath = path.join(projectRoot, 'Assets', mode === 'model' ? 'Models' : 'Environments', 'exhibition', 'model.glb');
  await mkdir(path.dirname(scenePath), { recursive: true }); await mkdir(path.dirname(modelPath), { recursive: true });
  await mkdir(caseOutput, { recursive: true }); await copyFile(originalGlb, modelPath);
  const item = { mode, projectRoot, scenePath, modelPath, status: 'RUNNING', screenshots: [] }; report.cases.push(item);
  const capture = async name => {
    const file = path.join(caseOutput, name + '.png'); await page.screenshot({ path: file }); item.screenshots.push(file);
    if (diagnosticCdp) {
      const memory = await page.evaluate(inspectGlbMemory);
      memory.heap = await diagnosticCdp.send('Runtime.getHeapUsage'); memory.domCounters = await diagnosticCdp.send('Memory.getDOMCounters');
      await writeFile(path.join(caseOutput, name + '-memory.json'), JSON.stringify(memory, null, 2));
      check(`${mode}：${name} 内存诊断已保存`);
      if (process.env.GLB_PREVIEW_MEMORY_DIAGNOSTIC === '2' && name === 'preset-draft') {
        const sample = await diagnosticCdp.send('HeapProfiler.stopSampling');
        await writeFile(path.join(caseOutput, 'retained-heap-sampling.json'), JSON.stringify(sample));
        throw new Error('GLB_MEMORY_DIAGNOSTIC_COMPLETE');
      }
    }
  };
  await activateProject(projectRoot, scenePath);
  if (report.cases.length > 1) { await page.reload({ waitUntil: 'domcontentloaded' }); await enterEditor(); }
  const fixture = await createGlbFixture(page, { mode, modelPath, scenePath });
  await writeFile(scenePath, fixture.content, 'utf8');
  item.originalSceneSha256 = await hashFile(scenePath);
  await waitForGlbEditor(page);
  const existing = await page.evaluate(() => {
    const settings = window.glbSmoke.store.getState().scene.sceneSettings;
    return { lighting: settings.lighting, appearance: settings.appearance };
  });
  assert.deepEqual(existing, { lighting: fixture.lighting, appearance: fixture.appearance }, '读取已有场景不得套用新场景默认预设');
  assert.equal(await hashFile(scenePath), item.originalSceneSha256, '打开已有场景不得自动写盘');
  check(`${mode}：已有场景自定义光照和外观保持，源场景未自动写盘`);
  let profiler;
  if (process.env.GLB_PREVIEW_PROFILE === '1') {
    profiler = await page.context().newCDPSession(page);
    await profiler.send('Profiler.enable'); await profiler.send('Profiler.setSamplingInterval', { interval: 2000 });
    await profiler.send('Profiler.start');
  }
  await applyGlbPresetThroughUi(page, capture, name => check(`${mode}：${name}`), async () => {
    if (diagnosticCdp) await capture('first-applied');
    if (!profiler) return;
    const { profile } = await profiler.send('Profiler.stop'); await profiler.send('Profiler.disable');
    await writeFile(path.join(caseOutput, 'ui-first-apply.cpuprofile'), JSON.stringify(profile));
    await profiler.detach(); profiler = null;
  });
  await waitForGlbEditor(page, true);
  await frameAndSaveGlbCamera(page);
  item.editor = await page.evaluate(inspectGlbScene);
  if (diagnostic) {
    const diagnostics = await runGlbShaderDiagnostic(page, capture);
    item.diagnosticFile = path.join(caseOutput, 'diagnostic.json');
    await writeFile(item.diagnosticFile, JSON.stringify(diagnostics, null, 2));
    item.diagnosticLuminance = { baseline: diagnostics.baseline.pixels.meanLuminance,
      explicitReflection: diagnostics.explicitReflection.pixels.meanLuminance,
      refreshedSceneFallback: diagnostics.refreshedSceneFallback.pixels.meanLuminance };
    item.status = 'DIAGNOSTIC'; await saveReport();
    check(`${mode}：仅完成临时反射绑定与 shader 刷新诊断，未执行保存发布验收`);
    return;
  }
  assertGlbStandardSnapshot(item.editor);
  await capture('editor-standard-preview');
  const canvasFile = path.join(caseOutput, 'editor-canvas.png'); await page.locator('canvas.scene-canvas').screenshot({ path: canvasFile }); item.screenshots.push(canvasFile);
  assert.equal(await hashFile(scenePath), item.originalSceneSha256, '应用草稿与相机保存动作不能擅自保存文件');
  await page.getByRole('button', { name: '保存场景', exact: true }).click();
  await page.waitForFunction(() => {
    const content = window.glbSmoke.store.getState().persistedSceneContent;
    if (!content) return false;
    try { return JSON.parse(content).scene.sceneSettings.lighting.environment?.source === 'sandbox'; } catch { return false; }
  }, null, { timeout: 60_000 });
  const saved = JSON.parse(await readFile(scenePath, 'utf8'));
  assert.equal(saved.scene.sceneSettings.lighting.environment.source, 'sandbox');
  assert.equal(saved.scene.sceneSettings.lighting.retainedExtension.marker, 'existing-scene-must-survive');
  assert.equal(saved.scene.sceneSettings.lighting.bake.enabled, false, '标准预览不能要求 GI 烘焙才可发布');
  item.savedSceneSha256 = await hashFile(scenePath);
  await reopenThroughIpc(scenePath);
  item.reopened = await page.evaluate(inspectGlbScene); assertGlbSnapshotPreserved(item.editor, item.reopened);
  assert.equal(await hashFile(scenePath), item.savedSceneSha256, '重开场景不得自动改写文件');
  await capture('editor-reopened'); check(`${mode}：真实 IPC 保存后重建 renderer 并按文件重开，环境、材质和视角保留`);

  if (!skipSource) {
    item.source = await application.evaluate(async (_electron, options) => {
      const result = await globalThis.glbSmokeModules.source.buildDigitalTwinSourcePackage({
        projectRoot: options.projectRoot, sharedResourcesRoot: options.sharedRoot, entrySceneFilePath: options.scenePath,
        outputRoot: options.outputRoot, manifest: { projectId: '42', projectName: 'GLB 标准预览验收', editorProjectId: null,
          baseVersionId: null, resourceRevision: '7' }, signal: new AbortController().signal,
        isPlatformImageReference: () => false, findSyncedImageForReference: async () => null,
        skyboxCacheDependencies: { getSharedProjectSkyboxRoot: () => null },
      });
      return { filePath: result.filePath, sha256: result.sha256, fileSize: result.fileSize, entryScenePath: result.entryScenePath,
        sceneCount: result.sceneCount, resourceFileCount: result.resourceFileCount, warnings: result.warnings };
    }, { projectRoot, scenePath, sharedRoot: path.join(temporary, mode, 'shared'), outputRoot: path.join(caseOutput, 'source') });
    const sourceRoot = path.join(temporary, mode, 'source-reopened'); await mkdir(sourceRoot, { recursive: true });
    item.source.reopenedRoot = sourceRoot;
    const unzipper = createRequire(import.meta.url)('unzipper');
    await new Promise((resolve, reject) => createReadStream(item.source.filePath).pipe(unzipper.Extract({ path: sourceRoot })).on('close', resolve).on('error', reject));
    const portableScenePath = path.join(sourceRoot, item.source.entryScenePath);
    const portable = JSON.parse(await readFile(portableScenePath, 'utf8'));
    const relocated = await application.evaluate((_electron, { portable, sourceRoot }) =>
      globalThis.glbSmokeModules.relocation.relocateDataPlatformScene(portable, sourceRoot), { portable, sourceRoot });
    await writeFile(portableScenePath, JSON.stringify(relocated, null, 2));
    await activateProject(sourceRoot, portableScenePath);
    await reopenThroughIpc(portableScenePath, false);
    item.source.snapshot = await page.evaluate(inspectGlbScene); assertGlbSnapshotPreserved(item.editor, item.source.snapshot);
    await capture('editor-source-reopened'); check(`${mode}：正式 SOURCE 包解压到新工程后重开，保留内置环境、材质和相机`);
  }

  const content = await page.evaluate(async () => {
    const { serializeScene } = await import('/src/editor/project/SceneSerializer.ts');
    return serializeScene(window.glbSmoke.store.getState().scene);
  });
  item.dist = await exportGlbViewer({ application, page, exportParent: path.join(caseOutput, 'dist'), content, name: `glb-standard-${mode}` });
  item.viewer = await inspectGlbViewer({ root: item.dist.result.outputPath, expected: item.editor, output: caseOutput, executablePath });
  check(`${mode}：正式 DIST 导出后独立硬件 WebGL Viewer 离线读取 GLB 与 ENV，无远程请求`);
  item.status = skipSource ? 'PARTIAL_SOURCE_SKIPPED' : 'PASS';
  await saveReport();
}

/** 已通过的实机保存/SOURCE证据保留原报告；仅重试尚未成功的正式发布步骤。 */
async function resumePublishing(mode, priorReport) {
  const prior = JSON.parse(await readFile(path.resolve(priorReport), 'utf8'));
  const saved = prior.cases.find(item => item.mode === mode);
  assert.equal(prior.originalSha256, report.originalSha256, '复用证据必须对应同一个原始 GLB');
  assert.ok(saved?.editor && saved.reopened && saved.source?.snapshot && saved.source.filePath);
  assertGlbSnapshotPreserved(saved.editor, saved.reopened);
  assertGlbSnapshotPreserved(saved.editor, saved.source.snapshot);
  assert.equal(await hashFile(saved.scenePath), saved.savedSceneSha256, '已验证的场景文件必须保持');
  assert.equal(await hashFile(saved.modelPath), report.originalSha256, '已验证的模型字节必须保持');
  assert.equal(await hashFile(saved.source.filePath), saved.source.sha256, 'SOURCE 包必须保持');
  const caseOutput = path.join(runOutput, mode); await mkdir(caseOutput, { recursive: true });
  let sourceProof = prior, sourceCase = saved;
  const seenProofs = new Set();
  while (sourceCase.reusedEditorAndSourceEvidence) {
    const reference = path.resolve(sourceCase.reusedEditorAndSourceEvidence);
    assert.ok(!seenProofs.has(reference), '恢复证据链不能循环'); seenProofs.add(reference);
    sourceProof = JSON.parse(await readFile(reference, 'utf8'));
    sourceCase = sourceProof.cases.find(item => item.mode === mode);
    assert.equal(sourceCase.source.sha256, saved.source.sha256, '恢复链必须指向同一个SOURCE包');
  }
  const sourceRoot = saved.source.reopenedRoot ?? sourceCase.source.reopenedRoot
    ?? path.join(sourceProof.temporary, mode, 'source-reopened');
  const scenePath = path.join(sourceRoot, saved.source.entryScenePath);
  await activateProject(sourceRoot, scenePath);
  const item = { ...saved, status: 'RUNNING', reusedEditorAndSourceEvidence: path.resolve(priorReport) };
  item.source = { ...saved.source, reopenedRoot: sourceRoot };
  delete item.dist; delete item.viewer; report.cases.push(item);
  const content = await readFile(scenePath, 'utf8');
  const archive = await createRequire(import.meta.url)('unzipper').Open.file(saved.source.filePath);
  const archivedScene = archive.files.find(entry => entry.path === saved.source.entryScenePath);
  assert.ok(archivedScene, 'SOURCE ZIP 必须包含实际发布场景');
  const portable = JSON.parse((await archivedScene.buffer()).toString('utf8'));
  const expected = await application.evaluate((_electron, { portable, sourceRoot }) =>
    globalThis.glbSmokeModules.relocation.relocateDataPlatformScene(portable, sourceRoot), { portable, sourceRoot });
  const actual = JSON.parse(content); assert.deepEqual(actual, expected, '实际发布场景须与原SOURCE包的重定位结果一致');
  const environment = actual.scene.sceneSettings.environment;
  const sourceModel = mode === 'model'
    ? Object.values(actual.scene.entities).find(entity => entity.components?.modelAsset)?.components.modelAsset
    : environment.variants.find(variant => variant.sourceUrl === environment.activeVariantUrl);
  assert.ok(sourceModel?.sourcePath);
  assert.equal(await hashFile(sourceModel.sourcePath), report.originalSha256, '实际发布模型字节必须保持');
  check(`${mode}：复用原报告中实际保存/SOURCE重开证据，实际发布场景及GLB/SOURCE包完整性已重新验证`);
  item.dist = await exportGlbViewer({ application, page, exportParent: path.join(temporary, 'publishing', mode), content, name: 'glb-standard-' + mode });
  const delivered = path.join(caseOutput, 'dist', path.basename(item.dist.result.outputPath));
  await cp(item.dist.result.outputPath, delivered, { recursive: true, force: false, errorOnExist: true });
  const list = async (root, relative = '') => {
    const files = [];
    for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
      const file = path.join(relative, entry.name);
      if (entry.isDirectory()) files.push(...await list(root, file));
      else { assert.ok(entry.isFile(), '发布包不能包含符号链接或特殊文件'); files.push(file); }
    }
    return files.sort();
  };
  const files = await list(item.dist.result.outputPath); assert.deepEqual(await list(delivered), files);
  for (const file of files) assert.equal(await hashFile(path.join(delivered, file)), await hashFile(path.join(item.dist.result.outputPath, file)));
  item.dist.deliveredCopy = { outputPath: delivered, fileCount: files.length, allSha256Verified: true };
  item.viewer = await inspectGlbViewer({ root: delivered, expected: item.editor, output: caseOutput, executablePath });
  item.status = 'PASS'; await saveReport();
  check(`${mode}：独立目录正式DIST导出、交付副本逐文件SHA及离线Viewer通过`);
}

try {
  report.originalSha256 = await hashFile(originalGlb);
  const port = await findLightingSmokePort();
  server = await createServer({ server: { host: '127.0.0.1', port, strictPort: true, hmr: false },
    cacheDir: path.join(temporary, 'vite-cache'),
    optimizeDeps: { noDiscovery: true, include: ['react', 'react-dom/client', 'react/jsx-runtime', '@babylonjs/core', '@babylonjs/loaders', '@linkiez/dxf-renew', 'typescript', 'mqtt', 'zustand'] } });
  await server.listen(); await server.watcher.close();
  const userData = path.join(temporary, 'user-data'); await mkdir(userData, { recursive: true });
  bootstrap = path.join(workspace, `.tmp-glb-preview-${randomUUID()}.mjs`);
  const moduleUrl = name => pathToFileURL(path.join(workspace, 'dist-electron/ipc', name + '.js')).href;
  await writeFile(bootstrap, `import { app } from 'electron';\napp.setPath('userData', ${JSON.stringify(userData)});\n`
    + `const assets = await import(${JSON.stringify(moduleUrl('projectAssetStore'))});\n`
    + `const registry = await import(${JSON.stringify(moduleUrl('assetRegistry'))});\n`
    + `const source = await import(${JSON.stringify(moduleUrl('digitalTwinSourcePackage'))});\n`
    + `const relocation = await import(${JSON.stringify(moduleUrl('dataPlatformSceneRelocation'))});\n`
    + 'globalThis.glbSmokeModules = { assets, registry, source, relocation };\n'
    + `await import(${JSON.stringify(pathToFileURL(path.join(workspace, 'dist-electron/main.js')).href)});\n`, { encoding: 'utf8', flag: 'wx' });
  const environment = { ...process.env, VITE_DEV_SERVER_URL: server.resolvedUrls.local[0], OPEN_DEVTOOLS: 'false' };
  delete environment.ELECTRON_RUN_AS_NODE; delete environment.EDITOR_ALLOW_SOFTWARE_WEBGL;
  application = await electron.launch({ args: [bootstrap, `--user-data-dir=${userData}`], cwd: workspace, env: environment, timeout: 120_000 });
  application.process().stderr?.on('data', data => { report.electronStderr = (report.electronStderr + data.toString()).slice(-65536); });
  metricsTimer = setInterval(() => { void application.evaluate(({ app }) => app.getAppMetrics()).then(metrics => {
    report.processMetrics.push({ at: new Date().toISOString(), metrics });
  }).catch(() => {}); }, 15_000);
  await application.evaluate(({ app, BrowserWindow, dialog }) => {
    globalThis.glbSmokeGone = [];
    const observed = new WeakSet();
    const observe = contents => {
      if (observed.has(contents)) return;
      observed.add(contents); contents.setBackgroundThrottling(false);
      contents.on('render-process-gone', (_event, details) => globalThis.glbSmokeGone.push(details));
    };
    app.on('web-contents-created', (_event, contents) => observe(contents));
    for (const win of BrowserWindow.getAllWindows()) observe(win.webContents);
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: globalThis.glbSmokeDialogPaths.scenePath });
    dialog.showOpenDialog = async (...args) => ({ canceled: false, filePaths: [args.at(-1)?.properties?.includes('openDirectory')
      ? globalThis.glbSmokeDialogPaths.projectRoot : globalThis.glbSmokeDialogPaths.scenePath] });
  });
  page = await application.firstWindow(); page.setDefaultTimeout(60_000); await page.setViewportSize({ width: 1440, height: 960 });
  if (process.env.GLB_PREVIEW_MEMORY_DIAGNOSTIC) {
    diagnosticCdp = await page.context().newCDPSession(page);
    if (process.env.GLB_PREVIEW_MEMORY_DIAGNOSTIC === '2') {
      await diagnosticCdp.send('HeapProfiler.startSampling', { samplingInterval: 32768 });
    }
  }
  page.on('crash', () => report.pageCrashes.push(new Date().toISOString()));
  page.on('pageerror', error => report.pageErrors.push(error.stack ?? error.message));
  page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(message.text());
    if (message.text().startsWith('[glb-point-cache]')) console.log(message.text()); });
  await enterEditor();
  await page.waitForFunction(async () => {
    const { EngineStore } = await import('/node_modules/@babylonjs/core/Engines/engineStore.js');
    return EngineStore.LastCreatedEngine?.scenes.some(scene => scene.activeCamera?.getClassName() === 'ArcRotateCamera'
      && scene.environmentTexture?.isReady());
  }, null, { timeout: 60_000 });
  report.defaultLighting = await page.evaluate(() => window.glbSmoke.store.getState().scene.sceneSettings.lighting);
  assert.equal(report.defaultLighting.environment.source, 'sandbox');
  assert.equal(report.defaultLighting.main.enabled, true); assert.equal(report.defaultLighting.fill.intensity, .8);
  check('真实空白编辑器默认内置环境已加载，基础对象所需的主光/补光保持');
  for (const mode of modes) await runCase(mode);
  if (report.cases.length === 2) {
    // 普通入口归一化底部中心，环境入口保留世界原点；对齐相对模型中心的取景，不改变同入口保存/发布的绝对相机断言。
    const relative = item => {
      const snapshot = item.editor;
      // 旧中断报告未记录bounds时，使用同一文档经严格绝对相机/像素复验的Viewer测量，保留来源。
      const center = snapshot.diagnostics.boundsCenter ?? item.viewer.snapshot.diagnostics.boundsCenter;
      assert.ok(center?.length === 3);
      item.crossModeBoundsSource = snapshot.diagnostics.boundsCenter ? 'editor' : 'viewer-same-document';
      return { ...snapshot, camera: { ...snapshot.camera,
        target: snapshot.camera.target.map((value, index) => value - center[index]) } };
    };
    assertGlbSnapshotPreserved(relative(report.cases[0]), relative(report.cases[1]));
    check('普通模型与100%透明度环境入口在相同相机/尺寸下保留相同材质和画面');
  }
  assert.equal(await hashFile(originalGlb), report.originalSha256, '原始 GLB 必须逐字节保持不变');
  report.rendererGone = await application.evaluate(() => globalThis.glbSmokeGone);
  assert.deepEqual(report.rendererGone, []); assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.consoleErrors, []);
  report.status = diagnostic ? 'DIAGNOSTIC' : skipSource ? 'PARTIAL_SOURCE_SKIPPED' : 'PASS';
} catch (error) {
  report.status = error.message === 'GLB_MEMORY_DIAGNOSTIC_COMPLETE' ? 'DIAGNOSTIC' : 'FAIL'; report.error = error.stack ?? String(error);
  report.rendererGone = await application?.evaluate(() => globalThis.glbSmokeGone).catch(() => report.rendererGone);
  if (error.glbViewerReport) report.viewerFailure = error.glbViewerReport;
  if (page) {
    report.failureState = await page.evaluate(() => {
      const state = window.glbSmoke?.store.getState();
      return state ? { scene: state.scene.name, logs: state.logs.slice(0, 20), resourceIssues: state.sceneResourceIssues,
        skybox: window.glbSmoke.runtime?.getSkyboxReadiness(), initial: window.glbSmoke.runtime?.getInitialLoadSnapshot() } : null;
    }).catch(() => null);
    await page.screenshot({ path: path.join(runOutput, 'failure.png') }).catch(() => {});
  }
  if (report.status !== 'DIAGNOSTIC') throw error;
} finally {
  clearInterval(metricsTimer);
  report.finishedAt = new Date().toISOString(); await saveReport();
  await application?.close(); await server?.close(); if (bootstrap) await unlink(bootstrap);
}
