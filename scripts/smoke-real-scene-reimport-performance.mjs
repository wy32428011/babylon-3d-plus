import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const workspace = process.cwd();
const require = createRequire(path.join(workspace, 'package.json'));
const { _electron: electron } = require('playwright');
const sourceScene = resolveRequiredPath(
  process.env.ZENDING_SCENE_SOURCE ?? process.argv[2],
  '请通过 ZENDING_SCENE_SOURCE 或第一个参数提供真实 .scene.json。',
);
const modelRoot = resolveRequiredPath(
  process.env.ZENDING_MODEL_ROOT ?? process.argv[3],
  '请通过 ZENDING_MODEL_ROOT 或第二个参数提供待重导入的模型包根目录。',
);
const sceneAssetSourceRoot = process.env.ZENDING_SCENE_ASSET_SOURCE_ROOT ?? String.raw`D:\ZDDT\Assets`;
const sceneAssetTargetRoot = path.resolve(process.env.ZENDING_SCENE_ASSET_TARGET_ROOT ?? path.join(modelRoot, 'Assets'));
const expectedModelEntityCount = readPositiveInteger(process.env.ZENDING_EXPECTED_MODEL_ENTITY_COUNT, 8_346);
const stableSecondsRequired = readPositiveNumber(process.env.ZENDING_STABLE_SECONDS, 12);
const stableTimeoutMs = readPositiveNumber(process.env.ZENDING_STABLE_TIMEOUT_SECONDS, 600) * 1_000;
const reportCopyTimeoutMs = readPositiveNumber(process.env.ZENDING_REPORT_COPY_TIMEOUT_SECONDS, 5) * 1_000;
const rotationSeconds = readPositiveNumber(process.env.ZENDING_ROTATION_SECONDS, 36);
const minimumFpsRetention = readPositiveNumber(process.env.ZENDING_MINIMUM_FPS_RETENTION, 0.95);
const minimumRotationRadians = readPositiveNumber(process.env.ZENDING_MINIMUM_ROTATION_RADIANS, Math.PI * 1.5);
const overviewBetaTarget = readPositiveNumber(process.env.ZENDING_OVERVIEW_BETA_RADIANS, 1.05);
const overviewBetaTolerance = readPositiveNumber(process.env.ZENDING_OVERVIEW_BETA_TOLERANCE_RADIANS, 0.08);
const configuredMinimumRotatingFps = readOptionalPositiveNumber(process.env.ZENDING_MINIMUM_ROTATING_FPS);
const extraElectronArgs = readJsonStringArray(process.env.ZENDING_ELECTRON_EXTRA_ARGS, 'ZENDING_ELECTRON_EXTRA_ARGS');
const evidenceRoot = path.resolve(
  process.env.ZENDING_EVIDENCE_DIR ?? path.join(tmpdir(), 'zending-performance-evidence'),
);
const focusFolderId = '__performance_full_scene_focus__';

await access(path.join(workspace, 'dist', 'index.html'));
await access(sourceScene);
await access(modelRoot);
await access(sceneAssetTargetRoot);
await access(path.join(sceneAssetTargetRoot, 'Models'));
await mkdir(evidenceRoot, { recursive: true });

const runRoot = await mkdtemp(path.join(tmpdir(), 'zending-reimport-performance-'));
const userDataRoot = path.join(runRoot, 'userdata');
const projectRoot = path.join(runRoot, 'project');
const scenePath = path.join(runRoot, 'current.scene.json');
await mkdir(userDataRoot, { recursive: true });
await mkdir(projectRoot, { recursive: true });
const fixture = await writeRebasedFullSceneFixture(
  sourceScene,
  scenePath,
  sceneAssetSourceRoot,
  sceneAssetTargetRoot,
  expectedModelEntityCount,
);
await writeFile(path.join(userDataRoot, 'recent-workspaces.json'), JSON.stringify({
  version: 1,
  projects: [],
  scenes: [{ filePath: scenePath, lastOpenedAt: new Date().toISOString() }],
}, null, 2), 'utf8');

const rendererEvents = [];
let electronApp;
try {
  console.log(JSON.stringify({
    phase: 'launch',
    sourceScene,
    modelRoot,
    sceneAssetSourceRoot,
    sceneAssetTargetRoot,
    projectRoot,
    expectedModelEntityCount,
    sourceSceneSha256: fixture.sourceSceneSha256,
    stableSecondsRequired,
    stableTimeoutMs,
    reportCopyTimeoutMs,
    rotationSeconds,
    configuredMinimumRotatingFps,
    minimumRotationRadians,
    overviewBetaTarget,
    overviewBetaTolerance,
    extraElectronArgs,
  }));
  electronApp = await electron.launch({
    args: [...extraElectronArgs, workspace, `--user-data-dir=${userDataRoot}`],
    cwd: workspace,
    env: { ...process.env, OPEN_DEVTOOLS: 'false', VITE_DEV_SERVER_URL: '' },
    timeout: 120_000,
  });
  const window = await electronApp.firstWindow({ timeout: 120_000 });
  window.setDefaultTimeout(120_000);
  await window.bringToFront();
  window.on('console', (message) => {
    const location = message.location();
    const source = location?.url
      ? ` @ ${location.url}:${location.lineNumber ?? 0}:${location.columnNumber ?? 0}`
      : '';
    rendererEvents.push(`[console:${message.type()}] ${message.text()}${source}`);
  });
  window.on('pageerror', (error) => rendererEvents.push(`[pageerror] ${error.message}`));
  window.on('requestfailed', (request) => {
    rendererEvents.push(`[requestfailed] ${request.failure()?.errorText ?? 'unknown'} ${request.url()}`);
  });
  await window.waitForLoadState('domcontentloaded');
  const rendererFramePacing = await measureRendererFramePacing(window);
  console.log(JSON.stringify({ phase: 'renderer-frame-pacing', ...rendererFramePacing }));

  const recentCard = window.locator('.home-recent-card').filter({ hasText: path.basename(scenePath) });
  await recentCard.waitFor({ state: 'visible', timeout: 120_000 });
  await recentCard.getByRole('button', { name: '打开' }).click();
  const canvas = window.locator('canvas.scene-canvas');
  await canvas.waitFor({ state: 'visible', timeout: 600_000 });

  const performanceSummary = window.locator('.scene-performance-summary');
  await performanceSummary.waitFor({ state: 'visible', timeout: 120_000 });
  await performanceSummary.click();
  const copyButton = window.locator('button.scene-performance-copy');
  await copyButton.waitFor({ state: 'visible', timeout: 120_000 });
  await window.evaluate(() => {
    const clipboard = navigator.clipboard;
    const originalWriteText = clipboard?.writeText?.bind(clipboard);
    if (!clipboard || !originalWriteText) return;
    Object.defineProperty(clipboard, 'writeText', {
      configurable: true,
      value: async (text) => {
        window.__zendingPerformanceReportCapture = String(text);
        try {
          await originalWriteText(text);
        } catch {
          // smoke 已在 renderer 内保留原始报告；系统剪贴板失败不影响性能验收读取。
        }
      },
    });
  });

  let reportReadFailureCount = 0;
  const readReport = async () => {
    await copyButton.click();
    const deadline = Date.now() + reportCopyTimeoutMs;
    let text = '';
    while (Date.now() < deadline) {
      await window.waitForTimeout(200);
      text = await window.evaluate(async () => {
        if (typeof window.__zendingPerformanceReportCapture === 'string') {
          return window.__zendingPerformanceReportCapture;
        }
        try {
          return await navigator.clipboard.readText();
        } catch {
          return '';
        }
      });
      if (!text) text = await electronApp.evaluate(({ clipboard }) => clipboard.readText());
      try {
        const report = JSON.parse(text);
        if (Array.isArray(report?.samples)) return report;
      } catch {
        // 低 FPS 场景中复制事件可能跨多个渲染帧才完成，继续等待系统剪贴板更新。
      }
    }

    reportReadFailureCount += 1;
    if (reportReadFailureCount === 1 || reportReadFailureCount % 6 === 0) {
      const diagnostics = await window.evaluate(() => ({
        performanceSummary: document.querySelector('.scene-performance-summary')?.textContent?.trim() ?? null,
        latestConsoleMessage: document.querySelector('.console-dock-message')?.textContent?.trim() ?? null,
      }));
      console.log(JSON.stringify({
        phase: 'performance-report-unavailable',
        reportReadFailureCount,
        clipboardLength: text.length,
        clipboardPrefix: text.slice(0, 160),
        ...diagnostics,
      }));
    }
    return null;
  };

  await waitForStableReport({
    phase: 'baseline',
    minimumFullSyncCount: 1,
    minimumPlanEntityCount: fixture.modelEntityCount,
    readReport,
    window,
  });
  const baselineFocus = await focusCompleteScene({
    canvas,
    expectedModelEntityCount: fixture.modelEntityCount,
    readReport,
    window,
  });
  const baselineRotation = await sampleRotatingScene({
    canvas,
    expectedModelEntityCount: fixture.modelEntityCount,
    phase: 'baseline-full-scene-rotation',
    readReport,
    rotationSeconds,
    window,
  });
  const baselineVisual = await captureRotatedVisualEvidence({
    canvas,
    electronApp,
    evidenceRoot,
    phase: 'baseline',
    window,
  });
  console.log(JSON.stringify({
    phase: 'baseline-complete',
    focus: compactFocus(baselineFocus),
    rotation: baselineRotation.summary,
    visual: compactVisual(baselineVisual),
  }, null, 2));

  await electronApp.evaluate(({ dialog }, input) => {
    const originalShowOpenDialog = dialog.showOpenDialog.bind(dialog);
    dialog.showOpenDialog = async (options) => {
      if (options?.title === '选择项目目录') {
        return { canceled: false, filePaths: [input.projectRoot], bookmarks: [] };
      }
      if (options?.title === '选择模型文件夹') {
        return { canceled: false, filePaths: [input.modelRoot], bookmarks: [] };
      }
      return originalShowOpenDialog(options);
    };
  }, { projectRoot, modelRoot });

  const importButton = window.locator('button.library-import-button');
  await importButton.waitFor({ state: 'visible', timeout: 120_000 });
  await importButton.click();
  const refreshStatus = window.locator('.library-project-root').filter({ hasText: '已刷新' });
  await refreshStatus.waitFor({ state: 'visible', timeout: 600_000 });
  const refreshStatusText = await refreshStatus.innerText();
  const refreshedCount = Number(/已刷新\s+(\d+)/.exec(refreshStatusText)?.[1] ?? 0);
  assert.equal(refreshedCount, fixture.modelEntityCount, `模型重导入必须刷新全部 ${fixture.modelEntityCount} 个场景实例，实际状态：${refreshStatusText}`);

  await waitForStableReport({
    phase: 'after-reimport',
    minimumFullSyncCount: 2,
    minimumPlanEntityCount: fixture.modelEntityCount,
    readReport,
    window,
  });
  const afterFocus = await focusCompleteScene({
    canvas,
    expectedModelEntityCount: fixture.modelEntityCount,
    readReport,
    window,
  });
  const afterRotation = await sampleRotatingScene({
    canvas,
    expectedModelEntityCount: fixture.modelEntityCount,
    phase: 'after-reimport-full-scene-rotation',
    readReport,
    rotationSeconds,
    window,
  });
  const afterVisual = await captureRotatedVisualEvidence({
    canvas,
    electronApp,
    evidenceRoot,
    phase: 'after-reimport',
    window,
  });

  const rendererText = [
    afterRotation.report?.renderer?.vendor,
    afterRotation.report?.renderer?.renderer,
    afterRotation.report?.renderer?.version,
  ].filter(Boolean).join(' ');
  const rendererPacingTargetFps = Math.min(60, rendererFramePacing.estimatedFps);
  const automaticMinimumRotatingFps = /nvidia/i.test(rendererText) ? 60 : rendererPacingTargetFps;
  const minimumRotatingFps = configuredMinimumRotatingFps ?? automaticMinimumRotatingFps;
  // 60 Hz 下 16.6/16.7ms 的采样量化会产生约 59.98~60.02 FPS；只放宽 0.25%，不掩盖真实性能回退。
  const minimumAcceptedRotatingFps = minimumRotatingFps * 0.9975;
  assert.ok(
    rendererFramePacing.estimatedFps >= minimumRotatingFps * 0.95,
    `当前 Electron 会话的 requestAnimationFrame 上限不足以验收 ${minimumRotatingFps} FPS：`
      + `${rendererFramePacing.estimatedFps.toFixed(2)} FPS。请在刷新率足够且未被远程桌面节流的前台会话重试。`,
  );

  assert.equal(
    afterRotation.summary.last.totalMeshes,
    baselineRotation.summary.last.totalMeshes,
    '重导入后不得残留旧 Mesh 或重复创建运行时 Mesh。',
  );
  assert.equal(
    afterRotation.summary.last.totalVertices,
    baselineRotation.summary.last.totalVertices,
    '重导入后批次 Geometry 总顶点必须恢复到刷新前。',
  );
  assert.equal(
    afterRotation.summary.last.runtime?.modelArrayBatchMeshCount,
    baselineRotation.summary.last.runtime?.modelArrayBatchMeshCount,
    '重导入后原模型 Geometry 批次数量必须恢复到刷新前。',
  );
  assert.equal(
    afterRotation.summary.last.runtime?.modelArrayBatchEntityCount,
    fixture.modelEntityCount,
    '重导入后必须恢复全部逻辑模型实体。',
  );
  for (const [phase, sample] of [
    ['刷新前', baselineRotation.summary.last],
    ['重导入后', afterRotation.summary.last],
  ]) {
    const runtime = sample.runtime;
    assert.equal(runtime?.modelArrayScreenSpaceProxyBatchCount ?? 0, 0, `${phase} 不得创建屏幕空间代理批次。`);
    assert.equal(runtime?.modelArraySolidProxyEntityCount ?? 0, 0, `${phase} 不得使用实心方块代理。`);
    assert.equal(runtime?.modelArrayFrameProxyEntityCount ?? 0, 0, `${phase} 不得使用框架代理。`);
    assert.equal(runtime?.modelArrayProxyEntityCount ?? 0, 0, `${phase} 代理逻辑实体数量必须为 0。`);
    assert.equal(
      runtime?.modelArrayDetailedEntityCount,
      fixture.modelEntityCount,
      `${phase} 全部逻辑模型都必须由原始 Geometry 覆盖。`,
    );
  }
  assert.deepEqual(
    collectGpuWorkloadSourceIds(afterRotation.summary.last.gpuWorkloadsBySource),
    collectGpuWorkloadSourceIds(baselineRotation.summary.last.gpuWorkloadsBySource),
    '重导入后所有参数化模型源都必须继续出现在 GPU 工作量中。',
  );
  assert.ok(
    afterRotation.summary.averageFps >= baselineRotation.summary.averageFps * minimumFpsRetention,
    `重导入后全景旋转 FPS 保留率过低：${afterRotation.summary.averageFps.toFixed(2)} / ${baselineRotation.summary.averageFps.toFixed(2)}`,
  );
  assert.ok(
    afterRotation.summary.averageFps >= minimumAcceptedRotatingFps,
    `全模型旋转视角平均 FPS 低于验收下限：${afterRotation.summary.averageFps.toFixed(2)} < ${minimumAcceptedRotatingFps.toFixed(2)}`,
  );
  assert.ok(
    (afterRotation.summary.last.runtime?.fullSyncCount ?? 0) >= 2,
    '重导入后必须发生一次新的完整 SceneRuntime 同步。',
  );
  assert.ok(
    (afterRotation.summary.last.editThinInstancePlan?.planCount ?? 0) >= 2,
    '重导入后必须重建编辑态 thinInstance 计划。',
  );

  const modelFailures = rendererEvents.filter((event) => {
    const normalized = event.replace(/\\/g, '/');
    return /模型(?:加载|脚本|参数|矩阵阵列).*失败|context lost|software renderer/i.test(event)
      || (/Assets\/Models\//i.test(normalized) && /failed|ERR_/i.test(event));
  });
  assert.deepEqual(modelFailures, [], `重导入期间存在模型或 GPU 失败：${modelFailures.join('\n')}`);

  const sourceSceneSha256After = createHash('sha256').update(await readFile(sourceScene)).digest('hex');
  assert.equal(sourceSceneSha256After, fixture.sourceSceneSha256, '真实源场景在重导入 smoke 期间被修改。');

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = path.join(evidenceRoot, `${stamp}-real-scene-full-rotation-performance.json`);
  const result = {
    status: 'PASS',
    generatedAt: new Date().toISOString(),
    sourceScene,
    sourceSceneSha256Before: fixture.sourceSceneSha256,
    sourceSceneSha256After,
    fixtureSceneSha256: fixture.fixtureSceneSha256,
    modelRoot,
    expectedModelEntityCount,
    refreshedCount,
    renderer: afterRotation.report.renderer,
    electronArgs: extraElectronArgs,
    rendererFramePacing,
    minimumRotatingFps,
    minimumAcceptedRotatingFps,
    baseline: {
      focus: baselineFocus,
      rotation: baselineRotation.summary,
      visual: baselineVisual,
    },
    after: {
      focus: afterFocus,
      rotation: afterRotation.summary,
      visual: afterVisual,
    },
    ratios: {
      fps: afterRotation.summary.averageFps / baselineRotation.summary.averageFps,
      gpuFrameTime: baselineRotation.summary.averageGpuFrameTimeMs > 0
        ? afterRotation.summary.averageGpuFrameTimeMs / baselineRotation.summary.averageGpuFrameTimeMs
        : null,
    },
    report: afterRotation.report,
  };
  await writeFile(reportPath, JSON.stringify(result, null, 2), 'utf8');
  console.log(JSON.stringify({ ...result, report: undefined, reportPath }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    status: 'FAIL',
    message: error instanceof Error ? error.stack ?? error.message : String(error),
    rendererEvents: rendererEvents.slice(-100),
  }, null, 2));
  process.exitCode = 1;
} finally {
  try {
    await electronApp?.close();
  } finally {
    await rm(runRoot, { recursive: true, force: true });
  }
}

function resolveRequiredPath(value, message) {
  if (!value?.trim()) throw new Error(message);
  return path.resolve(value.trim());
}

function readPositiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readPositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function readOptionalPositiveNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}


function readJsonStringArray(value, environmentName) {
  if (!value?.trim()) return [];
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`${environmentName} 必须是 JSON 字符串数组：${error instanceof Error ? error.message : String(error)}`);
  }
  assert.ok(Array.isArray(parsed), `${environmentName} 必须是 JSON 数组。`);
  for (const item of parsed) {
    assert.equal(typeof item, 'string', `${environmentName} 只能包含字符串。`);
    assert.match(item, /^--[^\s]+$/, `${environmentName} 只允许完整 Electron/Chromium switch：${item}`);
  }
  return parsed;
}

async function writeRebasedFullSceneFixture(sourcePath, destinationPath, sourceRoot, targetRoot, expectedCount) {
  const sourceBytes = await readFile(sourcePath);
  const sourceSceneSha256 = createHash('sha256').update(sourceBytes).digest('hex');
  const raw = sourceBytes.toString('utf8');
  const escapedSourceRoot = JSON.stringify(sourceRoot).slice(1, -1);
  const escapedTargetRoot = JSON.stringify(targetRoot).slice(1, -1);
  const encodedSourceRoot = encodeURIComponent(sourceRoot);
  const encodedTargetRoot = encodeURIComponent(targetRoot);
  const rewritten = raw
    .split(escapedSourceRoot).join(escapedTargetRoot)
    .replace(new RegExp(escapeRegExp(encodedSourceRoot), 'gi'), encodedTargetRoot);
  const document = JSON.parse(rewritten);
  const scene = document?.scene;
  assert.ok(scene?.entityIds && scene?.entities, '真实场景缺少 SceneDocument。');

  const modelEntityIds = scene.entityIds.filter((entityId) => {
    const entity = scene.entities[entityId];
    return Boolean(entity && !entity.isFolder && entity.visible !== false && entity.components?.modelAsset);
  });
  assert.equal(
    modelEntityIds.length,
    expectedCount,
    `真实目标场景可见模型实体必须为 ${expectedCount}，当前为 ${modelEntityIds.length}。`,
  );
  const modelEntityIdSet = new Set(modelEntityIds);

  for (const entityId of scene.entityIds) {
    const entity = scene.entities[entityId];
    if (!entity) continue;
    if (entity.isFolder) {
      entity.childrenIds = entity.childrenIds.filter((childId) => !modelEntityIdSet.has(childId));
      continue;
    }
    if (modelEntityIdSet.has(entityId)) entity.parentId = focusFolderId;
  }

  scene.entities[focusFolderId] = {
    id: focusFolderId,
    name: '性能验收：全部可见模型',
    isFolder: true,
    visible: true,
    locked: false,
    parentId: null,
    childrenIds: modelEntityIds,
    components: {
      transform: {
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      },
    },
  };
  scene.entityIds = [focusFolderId, ...scene.entityIds.filter((entityId) => entityId !== focusFolderId)];
  scene.selectedEntityId = focusFolderId;
  const fixtureText = JSON.stringify(document);
  await writeFile(destinationPath, fixtureText, 'utf8');
  return {
    modelEntityCount: modelEntityIds.length,
    sourceSceneSha256,
    fixtureSceneSha256: createHash('sha256').update(fixtureText).digest('hex'),
  };
}

/** 测量空闲 renderer 的真实 requestAnimationFrame 节拍，区分场景瓶颈与显示/远程会话上限。 */
async function measureRendererFramePacing(window, sampleCount = 120) {
  await window.bringToFront();
  await window.waitForTimeout(500);
  return window.evaluate(async (requestedSampleCount) => {
    const intervals = [];
    let previousTimestamp = null;
    await new Promise((resolve) => {
      const sampleFrame = (timestamp) => {
        if (previousTimestamp !== null) intervals.push(timestamp - previousTimestamp);
        previousTimestamp = timestamp;
        if (intervals.length >= requestedSampleCount) resolve();
        else requestAnimationFrame(sampleFrame);
      };
      requestAnimationFrame(sampleFrame);
    });
    const sorted = [...intervals].sort((left, right) => left - right);
    const averageIntervalMs = intervals.reduce((sum, value) => sum + value, 0) / intervals.length;
    return {
      sampleCount: intervals.length,
      averageIntervalMs,
      estimatedFps: 1_000 / averageIntervalMs,
      p50IntervalMs: sorted[Math.floor(sorted.length * 0.5)],
      p95IntervalMs: sorted[Math.floor(sorted.length * 0.95)],
      minimumIntervalMs: sorted[0],
      maximumIntervalMs: sorted.at(-1),
      visibilityState: document.visibilityState,
      hasFocus: document.hasFocus(),
      devicePixelRatio: window.devicePixelRatio,
    };
  }, sampleCount);
}

async function waitForStableReport({
  phase,
  minimumFullSyncCount,
  minimumPlanEntityCount,
  readReport,
  window,
}) {
  let stableKey = '';
  let stableMs = 0;
  let lastReport = null;
  const startedAt = Date.now();
  while (Date.now() - startedAt < stableTimeoutMs) {
    await window.waitForTimeout(5_000);
    const report = await readReport();
    const last = report?.samples?.at(-1);
    if (!last) continue;
    lastReport = report;
    const key = [
      last.totalMeshes,
      last.activeMeshes,
      last.thinInstances,
      last.drawCalls,
      last.runtime?.fullSyncCount,
      last.editThinInstancePlan?.planCount,
    ].join(':');
    if (key === stableKey) stableMs += 5_000;
    else {
      stableKey = key;
      stableMs = 0;
    }
    console.log(JSON.stringify({ phase, stableSeconds: stableMs / 1_000, ...compactSample(last) }));
    if (
      stableMs >= stableSecondsRequired * 1_000
      && (last.runtime?.fullSyncCount ?? 0) >= minimumFullSyncCount
      && (last.editThinInstancePlan?.entityCount ?? 0) >= minimumPlanEntityCount
    ) return lastReport;
  }
  throw new Error(`${phase} 阶段未稳定：${stableKey}; last=${JSON.stringify(compactSample(lastReport?.samples?.at(-1)))}`);
}

async function focusCompleteScene({ canvas, expectedModelEntityCount, readReport, window }) {
  // fixture 把完整模型文件夹放在根层级首行，确保虚拟化 Hierarchy 无需搜索或滚动即可选中。
  const focusFolderRow = window.locator('.entity-tree-row.folder[title="性能验收：全部可见模型"]').first();
  await focusFolderRow.waitFor({ state: 'visible', timeout: 120_000 });
  await focusFolderRow.click();
  await canvas.evaluate((element) => {
    element.tabIndex = -1;
    element.focus();
  });

  const startedAt = Date.now();
  while (Date.now() - startedAt < 600_000) {
    await window.keyboard.press('f');
    await window.waitForTimeout(2_000);
    const report = await readReport();
    const last = report?.samples?.at(-1);
    const focus = last?.focus;
    const camera = last?.camera;
    if (!focus || !camera) {
      await window.waitForTimeout(3_000);
      continue;
    }

    console.log(JSON.stringify({ phase: 'focus-full-scene', focus: compactFocus(focus), camera }));
    const complete = focus.requestedEntityCount === expectedModelEntityCount
      && focus.resolvedEntityCount === expectedModelEntityCount
      && focus.geometryReadyEntityCount === expectedModelEntityCount
      && focus.missingEntityCount === 0
      && focus.notReadyEntityCount === 0
      && focus.geometryReady === true;
    if (!complete) {
      await window.waitForTimeout(3_000);
      continue;
    }

    const fitRatio = calculateCameraFitRatio(camera, focus);
    assert.ok(fitRatio >= 1.02, `全景取景边距不足：fitRatio=${fitRatio.toFixed(4)}`);
    assert.ok(
      camera.radius + focus.radiusMeters < camera.maxZ,
      `全景远端会被 far plane 裁剪：radius=${camera.radius}, bounds=${focus.radiusMeters}, maxZ=${camera.maxZ}`,
    );
    assert.ok(
      camera.radius - focus.radiusMeters > camera.minZ,
      `全景近端会被 near plane 裁剪：radius=${camera.radius}, bounds=${focus.radiusMeters}, minZ=${camera.minZ}`,
    );
    assert.ok(distance3(camera.target, focus.center) <= Math.max(1e-4, focus.radiusMeters * 1e-6), '相机 target 未对准全场景中心。');

    // 文件夹仅用于复用正式 F 聚焦路径；取景完成后点击画布空白处清除 10k 多选描边，避免污染性能数据。
    const canvasBox = await canvas.boundingBox();
    assert.ok(canvasBox, 'Scene canvas 不可见。');
    await window.mouse.click(canvasBox.x + canvasBox.width - 8, canvasBox.y + 8);
    await window.waitForTimeout(1_000);
    const overviewCamera = await adjustCameraToObliqueOverview({ canvas, readReport, window });
    const overviewFitRatio = calculateCameraFitRatio(overviewCamera, focus);
    assert.ok(overviewFitRatio >= 1.02, `斜俯视全景取景边距不足：fitRatio=${overviewFitRatio.toFixed(4)}`);
    assert.ok(
      overviewCamera.radius + focus.radiusMeters < overviewCamera.maxZ,
      `斜俯视全景远端会被 far plane 裁剪：radius=${overviewCamera.radius}, bounds=${focus.radiusMeters}, maxZ=${overviewCamera.maxZ}`,
    );
    assert.ok(
      overviewCamera.radius - focus.radiusMeters > overviewCamera.minZ,
      `斜俯视全景近端会被 near plane 裁剪：radius=${overviewCamera.radius}, bounds=${focus.radiusMeters}, minZ=${overviewCamera.minZ}`,
    );
    assert.ok(
      distance3(overviewCamera.target, focus.center) <= Math.max(1e-4, focus.radiusMeters * 1e-6),
      '斜俯视相机 target 未对准全场景中心。',
    );
    return { ...focus, fitRatio: overviewFitRatio, camera: overviewCamera };
  }
  throw new Error('全场景几何在 10 分钟内仍未全部进入可渲染运行时。');
}

async function adjustCameraToObliqueOverview({ canvas, readReport, window }) {
  await canvas.evaluate((element) => {
    element.tabIndex = -1;
    element.focus();
  });

  const minimumBeta = overviewBetaTarget - overviewBetaTolerance;
  const maximumBeta = overviewBetaTarget + overviewBetaTolerance;
  const canvasBox = await canvas.boundingBox();
  assert.ok(canvasBox, 'Scene canvas 不可见，无法调整斜俯视角。');
  let previousBeta = null;
  let stableReads = 0;
  for (let attempt = 0; attempt < 48; attempt += 1) {
    const report = await readReport();
    const camera = report?.samples?.at(-1)?.camera;
    if (!camera) {
      await window.waitForTimeout(300);
      continue;
    }

    const betaStable = previousBeta !== null && Math.abs(camera.beta - previousBeta) <= 0.01;
    if (camera.beta >= minimumBeta && camera.beta <= maximumBeta) {
      stableReads = betaStable ? stableReads + 1 : 0;
      if (stableReads >= 2) {
        console.log(JSON.stringify({ phase: 'camera-oblique-overview', camera }));
        return camera;
      }
      previousBeta = camera.beta;
      await window.waitForTimeout(350);
      continue;
    }

    stableReads = 0;
    previousBeta = camera.beta;
    // 右键竖向拖拽走编辑器正式 ArcRotateCamera 输入链；向下拖减小 beta、形成斜俯视。
    const dragPixels = Math.min(18, Math.max(6, Math.abs(camera.beta - overviewBetaTarget) * 45));
    const deltaY = camera.beta > overviewBetaTarget ? dragPixels : -dragPixels;
    const startX = canvasBox.x + canvasBox.width * 0.7;
    const startY = canvasBox.y + canvasBox.height * 0.45;
    await window.mouse.move(startX, startY);
    await window.mouse.down({ button: 'right' });
    try {
      await window.mouse.move(startX, startY + deltaY, { steps: 4 });
    } finally {
      await window.mouse.up({ button: 'right' });
    }
    await window.waitForTimeout(350);
  }

  const finalReport = await readReport();
  const finalCamera = finalReport?.samples?.at(-1)?.camera;
  throw new Error(`无法通过正式相机输入进入斜俯视全景：camera=${JSON.stringify(finalCamera)}`);
}
async function sampleRotatingScene({ canvas, expectedModelEntityCount, phase, readReport, rotationSeconds: seconds, window }) {
  await window.bringToFront();
  const windowState = await window.evaluate(() => ({
    visibilityState: document.visibilityState,
    hasFocus: document.hasFocus(),
    devicePixelRatio: window.devicePixelRatio,
  }));
  assert.equal(windowState.visibilityState, 'visible', `${phase} Electron renderer 不可见，FPS 会被后台节流。`);
  const box = await canvas.boundingBox();
  assert.ok(box && box.width >= 200 && box.height >= 160, `Scene canvas 尺寸异常：${JSON.stringify(box)}`);
  await canvas.evaluate((element) => {
    element.tabIndex = -1;
    element.focus();
  });

  const startedAtMs = Date.now();
  await window.keyboard.down('ArrowLeft');
  try {
    await window.waitForTimeout(seconds * 1_000);
  } finally {
    await window.keyboard.up('ArrowLeft');
  }
  const endedAtMs = Date.now();
  await window.waitForTimeout(1_200);
  const report = await readReport();
  const samples = (report?.samples ?? []).filter((sample) => {
    const sampledAtMs = Date.parse(sample.sampledAt);
    return sampledAtMs >= startedAtMs + 1_000 && sampledAtMs <= endedAtMs + 250;
  });
  assert.ok(samples.length >= Math.max(8, Math.floor(seconds * 0.6)), `${phase} 旋转采样不足：${samples.length}`);
  const summary = summarizeSamples(samples);
  const fitRatios = [];
  for (const sample of samples) {
    const camera = sample.camera;
    const focus = sample.focus;
    assert.ok(camera && focus, `${phase} 采样缺少相机或全场景包围信息。`);
    assert.equal(focus.requestedEntityCount, expectedModelEntityCount, `${phase} 请求聚焦模型数量变化。`);
    assert.equal(focus.resolvedEntityCount, expectedModelEntityCount, `${phase} 旋转期间存在无法解析的模型。`);
    assert.equal(focus.geometryReadyEntityCount, expectedModelEntityCount, `${phase} 旋转期间存在未就绪模型。`);
    assert.equal(focus.missingEntityCount, 0, `${phase} 旋转期间存在缺失模型。`);
    assert.equal(focus.notReadyEntityCount, 0, `${phase} 旋转期间存在未就绪模型。`);
    assert.equal(focus.geometryReady, true, `${phase} 旋转期间全场景几何状态失效。`);
    const runtime = sample.runtime;
    assert.ok(runtime, `${phase} 采样缺少 SceneRuntime 指标。`);
    assert.equal(
      runtime.modelArrayBatchEntityCount,
      expectedModelEntityCount,
      `${phase} 旋转期间矩阵批次逻辑实体数量变化。`,
    );
    assert.equal(runtime.modelArrayScreenSpaceProxyBatchCount, 0, `${phase} 不得创建屏幕空间代理批次。`);
    assert.equal(runtime.modelArraySolidProxyEntityCount, 0, `${phase} 不得使用实心方块代理。`);
    assert.equal(runtime.modelArrayFrameProxyEntityCount, 0, `${phase} 不得使用框架代理。`);
    assert.equal(runtime.modelArrayProxyEntityCount, 0, `${phase} 代理逻辑实体数量必须为 0。`);
    assert.equal(
      runtime.modelArrayDetailedEntityCount,
      expectedModelEntityCount,
      `${phase} 全部逻辑模型都必须由原始 Geometry 覆盖。`,
    );
    assert.ok(
      sample.activeMeshes > 0 && sample.activeMeshes <= sample.totalMeshes,
      `${phase} Active Mesh 数量异常：${sample.activeMeshes}/${sample.totalMeshes}`,
    );
    assert.ok(sample.activeThinInstances > 0, `${phase} 没有活动 thinInstance，场景可能未显示。`);
    assert.ok(
      sample.frustumVisibleThinInstances <= sample.thinInstances,
      `${phase} 视锥内 thinInstance 估算超过当前提交数量。`,
    );
    const fitRatio = calculateCameraFitRatio(camera, focus);
    fitRatios.push(fitRatio);
    assert.ok(fitRatio >= 1.02, `${phase} 旋转期间全景取景边距不足：fitRatio=${fitRatio.toFixed(4)}`);
    assert.ok(
      camera.radius + focus.radiusMeters < camera.maxZ,
      `${phase} 旋转期间全景远端被 far plane 裁剪。`,
    );
    assert.ok(
      camera.radius - focus.radiusMeters > camera.minZ,
      `${phase} 旋转期间全景近端被 near plane 裁剪。`,
    );
    assert.ok(
      distance3(camera.target, focus.center) <= Math.max(1e-4, focus.radiusMeters * 1e-6),
      `${phase} 旋转期间相机 target 未保持在全场景中心。`,
    );
  }
  const firstCamera = samples.find((sample) => sample.camera)?.camera;
  const lastCamera = [...samples].reverse().find((sample) => sample.camera)?.camera;
  assert.ok(firstCamera && lastCamera, `${phase} 缺少相机位姿采样。`);
  const cameraTrace = samples.map((sample) => ({ sampledAt: sample.sampledAt, alpha: sample.camera?.alpha, beta: sample.camera?.beta }));
  const sampledBetas = samples.map((sample) => sample.camera?.beta).filter(Number.isFinite);
  const minimumSampledBeta = Math.min(...sampledBetas);
  const maximumSampledBeta = Math.max(...sampledBetas);
  const alphaTravel = Math.abs(lastCamera.alpha - firstCamera.alpha);
  console.log(JSON.stringify({ phase: `${phase}-camera-trace`, cameraTrace }, null, 2));
  assert.ok(alphaTravel >= minimumRotationRadians, `${phase} 相机旋转不足验收角度：alphaTravel=${alphaTravel.toFixed(4)}`);
  assert.ok(
    distance3(firstCamera.target, lastCamera.target) <= 1e-3,
    `${phase} 旋转期间相机 target 漂移，测试不再是围绕全场景中心旋转。`,
  );
  assert.ok(
    minimumSampledBeta >= overviewBetaTarget - overviewBetaTolerance
      && maximumSampledBeta <= overviewBetaTarget + overviewBetaTolerance,
    `${phase} 未保持斜俯视角：beta=${minimumSampledBeta.toFixed(4)}..${maximumSampledBeta.toFixed(4)}`,
  );
  assert.ok(
    maximumSampledBeta - minimumSampledBeta <= 0.03,
    `${phase} 环绕旋转期间 beta 漂移过大：${(maximumSampledBeta - minimumSampledBeta).toFixed(4)}`,
  );
  summary.alphaTravelRadians = alphaTravel;
  summary.betaRangeRadians = { minimum: minimumSampledBeta, maximum: maximumSampledBeta };
  summary.minimumFullSceneFitRatio = Math.min(...fitRatios);
  summary.rotationDurationSeconds = (endedAtMs - startedAtMs) / 1_000;
  summary.windowState = windowState;
  console.log(JSON.stringify({ phase, ...summary }, null, 2));
  return { report, samples, summary };
}

async function captureRotatedVisualEvidence({ canvas, electronApp, evidenceRoot: outputRoot, phase, window }) {
  const captures = [];
  const previousHudVisibility = await window.evaluate(() => {
    const hud = document.querySelector('.scene-performance-hud');
    if (!(hud instanceof HTMLElement)) return null;
    const previous = hud.style.visibility;
    hud.style.visibility = 'hidden';
    return previous;
  });
  try {
    for (let index = 0; index < 3; index += 1) {
      if (index > 0) await rotateSceneByKeyboard(canvas, window, 1_250);
      await window.waitForTimeout(500);
      const buffer = await canvas.screenshot({ type: 'png' });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const imagePath = path.join(outputRoot, `${stamp}-${phase}-angle-${index + 1}.png`);
      await writeFile(imagePath, buffer);
      const analysis = await analyzePng(electronApp, buffer);
      captures.push({
        index,
        imagePath,
        sha256: createHash('sha256').update(buffer).digest('hex'),
        ...analysis,
      });
    }
  } finally {
    await window.evaluate((visibility) => {
      const hud = document.querySelector('.scene-performance-hud');
      if (hud instanceof HTMLElement) hud.style.visibility = visibility ?? '';
    }, previousHudVisibility);
  }
  assert.equal(new Set(captures.map((capture) => capture.sha256)).size, captures.length, `${phase} 多角度截图完全相同，相机没有真实旋转。`);
  for (const capture of captures) {
    assert.ok(capture.distinctForegroundColors >= 8, `${phase} 截图前景颜色过少，可能为空白或模型未显示：${capture.imagePath}`);
    assert.ok(capture.foregroundRatio >= 0.001, `${phase} 截图有效模型像素占比过低：${capture.imagePath}`);
    // 当前真实场景长宽比超过 13:1，环绕到端视角时模型会自然转成竖向长条；
    // 因此按主轴跨度判断完整场景仍在画面中，不能把合法竖向投影误判为模型消失。
    assert.ok(
      Math.max(capture.foregroundSpanRatio.x, capture.foregroundSpanRatio.y) >= 0.05,
      `${phase} 截图模型主轴跨度过小：${capture.imagePath}`,
    );
    assert.ok(capture.foregroundLumaStandardDeviation >= 4, `${phase} 截图模型亮度变化过小，可能为空白：${capture.imagePath}`);
  }
  assert.ok(
    Math.max(...captures.map((capture) => capture.foregroundSpanRatio.x)) >= 0.05,
    `${phase} 三个旋转角均未形成有效横向跨度。`,
  );
  assert.ok(
    Math.max(...captures.map((capture) => capture.foregroundSpanRatio.y)) >= 0.05,
    `${phase} 三个旋转角均未形成有效纵向跨度。`,
  );
  return captures;
}

async function rotateSceneByKeyboard(canvas, window, durationMs) {
  await canvas.evaluate((element) => {
    element.tabIndex = -1;
    element.focus();
  });
  await window.keyboard.down('ArrowLeft');
  try {
    await window.waitForTimeout(durationMs);
  } finally {
    await window.keyboard.up('ArrowLeft');
  }
}

async function analyzePng(electronApp, buffer) {
  return electronApp.evaluate(({ nativeImage }, base64) => {
    const image = nativeImage.createFromBuffer(Buffer.from(base64, 'base64'));
    const size = image.getSize();
    const bitmap = image.toBitmap();
    const pixelCount = Math.max(1, size.width * size.height);
    const borderWidth = Math.max(2, Math.floor(Math.min(size.width, size.height) * 0.02));
    const borderHistogram = new Map();
    const quantizedColorKey = (r, g, b) => `${r >> 3}:${g >> 3}:${b >> 3}`;

    for (let y = 0; y < size.height; y += 1) {
      for (let x = 0; x < size.width; x += 1) {
        const isBorder = x < borderWidth || x >= size.width - borderWidth
          || y < borderWidth || y >= size.height - borderWidth;
        if (!isBorder) continue;
        const offset = (y * size.width + x) * 4;
        const b = bitmap[offset] ?? 0;
        const g = bitmap[offset + 1] ?? 0;
        const r = bitmap[offset + 2] ?? 0;
        const key = quantizedColorKey(r, g, b);
        const bucket = borderHistogram.get(key) ?? { key, count: 0, r: 0, g: 0, b: 0 };
        bucket.count += 1;
        bucket.r += r;
        bucket.g += g;
        bucket.b += b;
        borderHistogram.set(key, bucket);
      }
    }

    const orderedBorderColors = [...borderHistogram.values()].sort((left, right) => right.count - left.count);
    const borderSampleCount = orderedBorderColors.reduce((total, color) => total + color.count, 0);
    const backgroundPalette = [];
    let coveredBorderSamples = 0;
    for (const color of orderedBorderColors) {
      if (backgroundPalette.length >= 6) break;
      if (color.count < Math.max(4, borderSampleCount * 0.002) && coveredBorderSamples >= borderSampleCount * 0.995) break;
      backgroundPalette.push({
        key: color.key,
        count: color.count,
        r: color.r / color.count,
        g: color.g / color.count,
        b: color.b / color.count,
      });
      coveredBorderSamples += color.count;
      if (coveredBorderSamples >= borderSampleCount * 0.995) break;
    }

    const sampledColors = new Set();
    const foregroundColors = new Set();
    let foreground = 0;
    let foregroundMinimumX = size.width;
    let foregroundMinimumY = size.height;
    let foregroundMaximumX = -1;
    let foregroundMaximumY = -1;
    let foregroundLumaTotal = 0;
    let foregroundLumaSquaredTotal = 0;
    let lumaTotal = 0;
    let lumaSquaredTotal = 0;

    for (let y = 0; y < size.height; y += 1) {
      for (let x = 0; x < size.width; x += 1) {
        const offset = (y * size.width + x) * 4;
        const b = bitmap[offset] ?? 0;
        const g = bitmap[offset + 1] ?? 0;
        const r = bitmap[offset + 2] ?? 0;
        const key = quantizedColorKey(r, g, b);
        sampledColors.add(key);
        const luma = r * 0.2126 + g * 0.7152 + b * 0.0722;
        lumaTotal += luma;
        lumaSquaredTotal += luma * luma;
        const backgroundDistance = backgroundPalette.reduce((minimum, background) => Math.min(
          minimum,
          Math.abs(r - background.r) + Math.abs(g - background.g) + Math.abs(b - background.b),
        ), Number.POSITIVE_INFINITY);
        if (backgroundDistance < 24) continue;

        foreground += 1;
        foregroundColors.add(key);
        foregroundMinimumX = Math.min(foregroundMinimumX, x);
        foregroundMinimumY = Math.min(foregroundMinimumY, y);
        foregroundMaximumX = Math.max(foregroundMaximumX, x);
        foregroundMaximumY = Math.max(foregroundMaximumY, y);
        foregroundLumaTotal += luma;
        foregroundLumaSquaredTotal += luma * luma;
      }
    }

    const averageLuma = lumaTotal / pixelCount;
    const variance = Math.max(0, lumaSquaredTotal / pixelCount - averageLuma * averageLuma);
    const foregroundAverageLuma = foregroundLumaTotal / Math.max(1, foreground);
    const foregroundVariance = Math.max(
      0,
      foregroundLumaSquaredTotal / Math.max(1, foreground) - foregroundAverageLuma * foregroundAverageLuma,
    );
    const foregroundWidth = foregroundMaximumX >= foregroundMinimumX
      ? foregroundMaximumX - foregroundMinimumX + 1
      : 0;
    const foregroundHeight = foregroundMaximumY >= foregroundMinimumY
      ? foregroundMaximumY - foregroundMinimumY + 1
      : 0;
    return {
      width: size.width,
      height: size.height,
      distinctSampledColors: sampledColors.size,
      distinctForegroundColors: foregroundColors.size,
      foregroundRatio: foreground / pixelCount,
      foregroundBounds: foreground > 0 ? {
        minimumX: foregroundMinimumX,
        minimumY: foregroundMinimumY,
        maximumX: foregroundMaximumX,
        maximumY: foregroundMaximumY,
      } : null,
      foregroundSpanRatio: {
        x: foregroundWidth / Math.max(1, size.width),
        y: foregroundHeight / Math.max(1, size.height),
      },
      averageLuma,
      lumaStandardDeviation: Math.sqrt(variance),
      foregroundAverageLuma,
      foregroundLumaStandardDeviation: Math.sqrt(foregroundVariance),
      backgroundPalette: backgroundPalette.map(({ key, count }) => ({ key, count })),
    };
  }, buffer.toString('base64'));
}

function summarizeSamples(samples) {
  assert.ok(samples.length > 0, '性能采样为空。');
  const average = (key) => samples.reduce((sum, sample) => sum + (Number(sample[key]) || 0), 0) / samples.length;
  const sortedFps = samples.map((sample) => Number(sample.fps) || 0).sort((left, right) => left - right);
  const sortedFrameTimes = samples.map((sample) => Number(sample.frameTimeMs) || 0).sort((left, right) => left - right);
  const percentile = (values, ratio) => values[Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * ratio) - 1))] ?? 0;
  return {
    sampleCount: samples.length,
    averageFps: average('fps'),
    minimumFps: sortedFps[0] ?? 0,
    p10Fps: percentile(sortedFps, 0.1),
    averageFrameTimeMs: average('frameTimeMs'),
    p95FrameTimeMs: percentile(sortedFrameTimes, 0.95),
    averageRenderTimeMs: average('renderTimeMs'),
    averageActiveMeshesEvaluationMs: average('activeMeshesEvaluationMs'),
    averageGpuFrameTimeMs: average('gpuFrameTimeMs'),
    averageDrawCalls: average('drawCalls'),
    maximumDrawCalls: Math.max(...samples.map((sample) => Number(sample.drawCalls) || 0)),
    averageActiveMeshes: average('activeMeshes'),
    maximumActiveMeshes: Math.max(...samples.map((sample) => Number(sample.activeMeshes) || 0)),
    averageTotalMeshes: average('totalMeshes'),
    averageThinInstances: average('thinInstances'),
    averageActiveThinInstances: average('activeThinInstances'),
    averageEstimatedVertexInvocations: average('estimatedActiveVertexInvocations'),
    averageEstimatedTriangleInvocations: average('estimatedActiveTriangleInvocations'),
    averageSolidProxyEntityCount: samples.reduce(
      (sum, sample) => sum + (Number(sample.runtime?.modelArraySolidProxyEntityCount) || 0),
      0,
    ) / samples.length,
    averageFrameProxyEntityCount: samples.reduce(
      (sum, sample) => sum + (Number(sample.runtime?.modelArrayFrameProxyEntityCount) || 0),
      0,
    ) / samples.length,
    averageProxyEntityCount: samples.reduce(
      (sum, sample) => sum + (Number(sample.runtime?.modelArrayProxyEntityCount) || 0),
      0,
    ) / samples.length,
    averageDetailedEntityCount: samples.reduce(
      (sum, sample) => sum + (Number(sample.runtime?.modelArrayDetailedEntityCount) || 0),
      0,
    ) / samples.length,
    last: compactSample(samples.at(-1)),
  };
}


function collectGpuWorkloadSourceIds(workloads) {
  return [...new Set((workloads ?? [])
    .map((entry) => entry?.sourceEntityId)
    .filter((value) => typeof value === 'string' && value.length > 0))]
    .sort();
}

function calculateCameraFitRatio(camera, focus) {
  const configuredHalfFov = Math.min(Math.PI / 2 - 0.001, Math.max(0.01, camera.fovRadians / 2));
  const verticalHalfFov = camera.fovMode === 'horizontal-fixed'
    ? Math.atan(Math.tan(configuredHalfFov) / camera.aspectRatio)
    : configuredHalfFov;
  const horizontalHalfFov = camera.fovMode === 'horizontal-fixed'
    ? configuredHalfFov
    : Math.atan(Math.tan(configuredHalfFov) * camera.aspectRatio);
  return camera.radius * Math.sin(Math.min(verticalHalfFov, horizontalHalfFov)) / focus.radiusMeters;
}

function distance3(left, right) {
  return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
}

function compactFocus(focus) {
  if (!focus) return null;
  return {
    requestedEntityCount: focus.requestedEntityCount,
    resolvedEntityCount: focus.resolvedEntityCount,
    geometryReadyEntityCount: focus.geometryReadyEntityCount,
    missingEntityCount: focus.missingEntityCount,
    notReadyEntityCount: focus.notReadyEntityCount,
    missingEntityIds: focus.missingEntityIds,
    notReadyEntityIds: focus.notReadyEntityIds,
    geometryReady: focus.geometryReady,
    center: focus.center,
    sizeMeters: focus.sizeMeters,
    radiusMeters: focus.radiusMeters,
    fitRatio: focus.fitRatio,
  };
}

function compactVisual(captures) {
  return captures.map(({
    imagePath,
    sha256,
    distinctSampledColors,
    distinctForegroundColors,
    foregroundRatio,
    foregroundBounds,
    foregroundSpanRatio,
    lumaStandardDeviation,
    foregroundLumaStandardDeviation,
    backgroundPalette,
  }) => ({
    imagePath,
    sha256,
    distinctSampledColors,
    distinctForegroundColors,
    foregroundRatio,
    foregroundBounds,
    foregroundSpanRatio,
    lumaStandardDeviation,
    foregroundLumaStandardDeviation,
    backgroundPalette,
  }));
}

function compactSample(sample) {
  if (!sample) return null;
  return {
    sampledAt: sample.sampledAt,
    fps: sample.fps,
    frameTimeMs: sample.frameTimeMs,
    gpuFrameTimeMs: sample.gpuFrameTimeMs,
    drawCalls: sample.drawCalls,
    activeMeshes: sample.activeMeshes,
    totalMeshes: sample.totalMeshes,
    totalVertices: sample.totalVertices,
    thinInstances: sample.thinInstances,
    activeThinInstances: sample.activeThinInstances,
    frustumVisibleThinInstances: sample.frustumVisibleThinInstances,
    estimatedActiveVertexInvocations: sample.estimatedActiveVertexInvocations,
    estimatedActiveTriangleInvocations: sample.estimatedActiveTriangleInvocations,
    camera: sample.camera,
    focus: compactFocus(sample.focus),
    runtime: sample.runtime,
    editThinInstancePlan: sample.editThinInstancePlan,
    topActiveGpuWorkloads: sample.topActiveGpuWorkloads,
    gpuWorkloadsBySource: sample.gpuWorkloadsBySource,
    gpuMaterialTotals: sample.gpuMaterialTotals,
  };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
