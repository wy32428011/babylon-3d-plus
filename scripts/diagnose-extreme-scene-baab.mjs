import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createReadStream } from 'node:fs';
import { cp, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { inspectPayload } from './phase2-mqtt-capture.mjs';

export const BAAB_EXPERIMENT = 'hardware-scaling-baab';
const ORDER = ['B', 'A', 'A', 'B'];
const SCALES = { A: 1, B: 2 };
const WINDOW_MS = 60_000;
const WARMUP_MS = 3_000;
const PROFILE_MS = 20_000;
const EDGE_BUDGET_MS = 5_000;
const MAX_REPLAY_GAP_MS = 5_000;
const CPU_RATIO = [0.90, 1.10];
const GPU_RATIO = 2;
const REPEAT_RATIO = 1.10;
const TOPIC = 'dt/factory/logistics/+/+/twindatadriven/joint';
const TOPIC_PATTERN = /^dt\/factory\/logistics\/([^/+#]+)\/([^/+#]+)\/twindatadriven\/joint$/;
const MOTION_POINT = /^(?:(?:front_|back_)?(?:movement|distance|rpm)_[xyz]|(?:front_|back_)?command|task|to_[xyz]|lift_current_level|task_target_level|work_state)$/i;
const SPECIALIZED_TYPES = new Set(['stacker', 'conveyor', 'shuttle', 'rgv', 'lift', 'hclift']);
const SENSITIVE_POINT = /password|passwd|passphrase|pwd|secret|token|authorization|apikey|accesskey|credential|privatekey|username|密码|口令|秘钥|密钥|令牌|凭据/i;
const LAUNCH_ENV = new Set(['PATH', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR',
  'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'PROGRAMDATA', 'DISPLAY', 'XAUTHORITY',
  'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR']);
const SOFTWARE = /swiftshader|llvmpipe|softpipe|lavapipe|software|basic render driver|\bwarp\b|unknown/i;
const HASH = /^[a-f\d]{64}$/;
const VIEW_KEYS = ['cssWidth', 'cssHeight', 'windowWidth', 'windowHeight', 'displayWidth', 'displayHeight', 'dpr'];
const SETTINGS_PATH = '.babylon-editor/asset-index.json';
const LOCAL_RESOURCE_KEYS = new Set(['sourcePath', 'metadataPath', 'thumbnailPath', 'packagePath', 'scriptPaths', 'path']);
const USAGE = 'node scripts/smoke-extreme-scene-performance.mjs --baab --scene <离线场景.json> --project-root <含 Assets 的离线编辑器工程> --replay <MQTT recording.json> --output <报告目录> [--app-root <已有构建>] [--fullscreen] [--profile]';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const epochNow = () => performance.timeOrigin + performance.now();
const sleepUntil = epoch => delay(Math.max(0, Math.ceil(epoch - epochNow())));
const positive = value => Number.isFinite(value) && value > 0;

export function parseBaabArgs(args) {
  const { values } = parseArgs({ args, options: {
    baab: { type: 'boolean' }, help: { type: 'boolean' }, scene: { type: 'string' },
    'project-root': { type: 'string' }, replay: { type: 'string' }, output: { type: 'string' },
    'app-root': { type: 'string' }, fullscreen: { type: 'boolean', default: false },
    profile: { type: 'boolean', default: false }, timeout: { type: 'string', default: '600000' },
  } });
  assert.ok(values.baab && (values.help || (values.scene?.trim() && values['project-root']?.trim()
    && values.replay?.trim() && values.output?.trim())));
  const timeout = Number(values.timeout);
  assert.ok(Number.isInteger(timeout) && timeout >= 1000 && timeout <= 3_600_000);
  return { ...values, timeout };
}

/** 本地已有录制必须完整；只返回同一时间轴的数量、字节和哈希，不向报告透传录制字段。 */
export function prepareRecordedMotion(recording, bindings, sourceSha256) {
  const { records, summary } = recording ?? {};
  assert.ok(summary?.sensitiveSkipped === 0 && (summary.budgetSkipped ?? 0) === 0
    && summary.replayCompatible !== false && summary.allLocalMessageSlotsStored !== false
    && Array.isArray(records) && records.length > 1 && records.length <= 10_000);
  if (recording.source?.sceneSha256 !== undefined) assert.equal(recording.source.sceneSha256, sourceSha256);
  assert.ok(bindings.length && bindings.every(binding => binding.sourceId === 'default'));
  const deviceTopics = new Set(bindings.map(({ deviceType, assetCode }) => `${deviceType}/${assetCode}`));
  const motionPayloads = new Map();
  const normalizeAt = record => record.atMs - records[0].atMs;
  let containsMotion = false, bytes = 0, messages = 0, totalBytes = 0;
  let latestDeviceInput = WARMUP_MS, maxDeviceGapMs = 0;
  for (const [index, record] of records.entries()) {
    assert.ok(record && Number.isFinite(record.atMs) && record.atMs >= 0
      && (index === 0 || record.atMs >= records[index - 1].atMs)
      && !record.payloadRedacted && record.payloadTextByteExact !== false
      && typeof record.topic === 'string' && typeof record.payloadText === 'string');
    const match = TOPIC_PATTERN.exec(record.topic);
    assert.ok(match && !inspectPayload(Buffer.from(record.topic)).sensitive);
    const payload = Buffer.from(record.payloadText);
    totalBytes += payload.length;
    assert.ok(totalBytes <= 16 * 1024 * 1024);
    const inspected = inspectPayload(payload);
    assert.ok(!inspected.sensitive && inspected.format === 'json');
    if (record.payloadSha256 !== undefined) assert.equal(record.payloadSha256, sha(payload));
    const data = JSON.parse(record.payloadText)?.data;
    assert.ok(!Array.isArray(data) || !data.some(point => typeof point?.p === 'string'
      && SENSITIVE_POINT.test(point.p.replace(/[^\p{L}\p{N}]/gu, ''))));
    const atMs = normalizeAt(record);
    if (atMs > WINDOW_MS + WARMUP_MS) continue;
    messages += 1;
    bytes += payload.length;
    if (atMs < WARMUP_MS || !deviceTopics.has(`${match[1]}/${match[2]}`) || !Array.isArray(data)) continue;
    // 排除仅序号、时间戳、故障状态或无绑定设备的消息变化。
    const points = Object.fromEntries(data.filter(point => point && typeof point.p === 'string'
      && MOTION_POINT.test(point.p) && (point.e === undefined || point.e === '' || point.e === match[2])
      && point.v !== undefined && point.v !== null)
      .map(point => [point.p, point.v]).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
    if (!Object.keys(points).length) continue;
    maxDeviceGapMs = Math.max(maxDeviceGapMs, atMs - latestDeviceInput);
    latestDeviceInput = atMs;
    const fingerprint = sha(JSON.stringify(points));
    if (motionPayloads.has(record.topic) && fingerprint !== motionPayloads.get(record.topic)) containsMotion = true;
    motionPayloads.set(record.topic, fingerprint);
  }
  maxDeviceGapMs = Math.max(maxDeviceGapMs, WINDOW_MS + WARMUP_MS - latestDeviceInput);
  assert.ok(normalizeAt(records.at(-1)) >= WINDOW_MS + WARMUP_MS && containsMotion && messages > 1
    && maxDeviceGapMs <= MAX_REPLAY_GAP_MS);
  const timeline = records.map(({ atMs, topic, payloadText }) => ({ atMs, topic, payloadText }));
  return { timeline, sha256: sha(JSON.stringify(timeline)), messages, bytes, maxDeviceGapMs };
}

function sameCamera(left, right) {
  if (!left || !right) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length
    && ['alpha', 'beta', 'radius', 'x', 'y', 'z', 'mode', 'fov', 'minZ', 'maxZ'].every(key => Number.isFinite(left[key]))
    && keys.every(key => left[key] === null ? right[key] === null
      : Number.isFinite(right[key]) && Math.abs(left[key] - right[key]) <= 1e-6);
}

function sameViewport(left, right) {
  const limit = left?.frameRateLimit ?? null;
  return VIEW_KEYS.every(key => positive(left?.[key]) && left[key] === right?.[key])
    && (limit === null || positive(limit)) && limit === (right?.frameRateLimit ?? null);
}

function hasMotionActivity(samples, last) {
  const first = samples[0];
  return first && ['telemetryFrames', 'motionContexts'].every(key =>
    Number.isSafeInteger(first[key]) && Number.isSafeInteger(last?.[key]) && last[key] > first[key]);
}

function validRenderer(renderer) {
  return renderer?.isWebGPU === false && [renderer.vendor, renderer.renderer, renderer.version]
    .every(value => typeof value === 'string' && value.trim()) && !SOFTWARE.test(renderer.renderer);
}

function validView(sample, baseline, level) {
  return sample?.ready === true && sample.scale === level
    && sample.width === Math.floor(baseline.width / level)
    && sample.height === Math.floor(baseline.height / level) && sample.width > 0 && sample.height > 0
    && sameViewport(baseline, sample) && sameCamera(baseline.camera, sample.camera)
    && isDeepStrictEqual(baseline.renderer, sample.renderer);
}

function validDriver(driver) {
  return driver?.enabled === true && positive(driver.vendorId) && positive(driver.deviceId)
    && typeof driver.driverVersion === 'string' && /^\d[\w. -]{0,63}$/.test(driver.driverVersion)
    && !/^0(?:\.0)*$/.test(driver.driverVersion);
}

function validWindow(run, index, evidence) {
  if (run?.variant !== ORDER[index] || run.index !== index + 1 || run.mode !== 'motion'
    || !validDriver(run.driver) || !HASH.test(run.inventorySha256 ?? '') || run.violation !== null) return false;
  const { baseline, replay } = run;
  if (!validRenderer(baseline?.renderer) || !validView(baseline, baseline, SCALES.A)
    || baseline.width !== baseline.cssWidth || baseline.height !== baseline.cssHeight
    || !Array.isArray(run.samples) || !hasMotionActivity(run.samples, run.last)
    || ![...run.samples, run.last].every(sample => validView(sample, baseline, SCALES[run.variant]))) return false;
  return run.windowMs === WINDOW_MS && run.elapsedMs >= WINDOW_MS && positive(run.startEpochMs)
    && Number.isInteger(run.frameCount) && run.frameCount >= 3 && run.intervalCount === run.frameCount - 1
    && Number.isFinite(run.firstFrameOffsetMs) && run.firstFrameOffsetMs >= 0
    && run.lastFrameOffsetMs < WINDOW_MS && run.measuredDurationMs >= WINDOW_MS - EDGE_BUDGET_MS
    && Math.abs(run.lastFrameOffsetMs - run.firstFrameOffsetMs - run.measuredDurationMs) <= 1
    && Array.isArray(run.intervalsMs) && run.intervalsMs.length === run.intervalCount
    && run.intervalsMs.every(positive)
    && Math.abs(run.intervalsMs.reduce((sum, ms) => sum + ms, 0) - run.measuredDurationMs) <= 1
    && replay?.clients === 1 && replay.failures === 0 && replay.ticks === evidence.replayMessages
    && replay.messages === evidence.replayMessages && replay.bytes === evidence.replayBytes;
}

/** 固定墙钟内实际帧数为 FPS。两组各两次，均值和对称配对同时过线才归因。 */
export function classifyBaab(runs, evidence) {
  const undetermined = reason => ({ conditionsMatched: false, classification: 'undetermined', reason, fps: null });
  if (evidence?.unchanged !== true || ![evidence.sourceSha256, evidence.fixtureSha256, evidence.buildSha256,
    evidence.resourcesSha256, evidence.recordingSha256, evidence.replaySha256].every(value => HASH.test(value ?? ''))
    || !Number.isSafeInteger(evidence.replayMessages) || evidence.replayMessages <= 1 || !positive(evidence.replayBytes)
    || !Number.isFinite(evidence.maxDeviceGapMs) || evidence.maxDeviceGapMs < 0
    || evidence.maxDeviceGapMs > MAX_REPLAY_GAP_MS) return undetermined('missing-input-evidence');
  if (runs.length !== ORDER.length || !runs.every((run, index) => validWindow(run, index, evidence))) {
    return undetermined('incomplete-or-invalid-windows');
  }
  const [first] = runs;
  if (!runs.every((run, index) => isDeepStrictEqual(run.driver, first.driver)
    && run.inventorySha256 === first.inventorySha256 && sameViewport(run.baseline, first.baseline)
    && sameCamera(run.baseline.camera, first.baseline.camera)
    && isDeepStrictEqual(run.baseline.renderer, first.baseline.renderer)
    && (index === 0 || run.startEpochMs >= runs[index - 1].startEpochMs + WINDOW_MS))) {
    return undetermined('conditions-changed-or-windows-overlap');
  }
  const [b1, a1, a2, b2] = runs.map(run => run.frameCount * 1000 / WINDOW_MS);
  const a = (a1 + a2) / 2, b = (b1 + b2) / 2;
  const pairedRatios = [b1 / a1, b2 / a2];
  const fps = { A: a, B: b, ratio: b / a, pairedRatios, windows: [b1, a1, a2, b2] };
  const result = (classification, reason) => ({ conditionsMatched: true, classification, reason, fps });
  if ([Math.max(a1, a2) / Math.min(a1, a2), Math.max(b1, b2) / Math.min(b1, b2)]
    .some(ratio => ratio > REPEAT_RATIO)) return result('undetermined', 'within-scale-drift');
  if (fps.ratio >= GPU_RATIO && pairedRatios.every(ratio => ratio >= GPU_RATIO)) {
    return result('gpu-limited', 'both-pairs-at-least-2x');
  }
  const nearOne = ratio => ratio >= CPU_RATIO[0] && ratio <= CPU_RATIO[1];
  if (!nearOne(fps.ratio) || !pairedRatios.every(nearOne)) return result('undetermined', 'between-thresholds');
  const frameRateLimit = Math.min(first.driver.displayHz, first.baseline.frameRateLimit ?? Infinity);
  if (!positive(frameRateLimit) || Math.max(a1, a2, b1, b2) >= frameRateLimit * 0.9) {
    return result('undetermined', 'refresh-rate-unknown-or-near-cap');
  }
  return result('cpu-limited', 'both-pairs-within-10-percent');
}

export async function runHardwareScalingDiagnosis(args, harness) {
  let options;
  try { options = parseBaabArgs(args); }
  catch { console.error(USAGE); process.exitCode = 1; return; }
  if (options.help) {
    console.log(`${USAGE}\n只接收本地离线副本和现有录制；输出应是父目录已存在的新目录。固定 B(2)–A(1)–A(1)–B(2) 各 60 秒。--profile 另加 20 秒 A，不改变四轮采样。--fullscreen 使用显示器原生全屏。`);
    return;
  }
  const report = { experiment: BAAB_EXPERIMENT, schemaVersion: 1, equalImageQuality: false,
    order: ORDER, scales: SCALES, windowMs: WINDOW_MS, warmupMs: WARMUP_MS, cpuRatioRange: CPU_RATIO,
    gpuMinRatio: GPU_RATIO, maxWithinScaleRatio: REPEAT_RATIO,
    profile: options.profile ? { status: 'not-run' } : null,
    maxReplayGapMs: MAX_REPLAY_GAP_MS,
    unmeasured: ['concurrent-system-load', 'power-and-thermal-state', 'main-process-cpu', 'replay-delivery-jitter', 'remote-fetch-and-platform'],
    notes: '缩放实验不等画质。CPU 受限为固定条件下的 FPS 诊断，并不能排除不随分辨率改变的 GPU 工作；GPU 计时不可用仍记为 null。',
    evidence: {}, runs: [], errors: [], passed: false };
  let output, root, broker, stage = 'explicit-local-inputs';
  try {
    const source = await localPath(options.scene), recordingPath = await localPath(options.replay);
    const project = await localPath(options['project-root']), appRoot = await localPath(options['app-root'] ?? process.cwd());
    assert.ok((await lstat(source)).isFile() && (await lstat(recordingPath)).isFile());
    const destination = path.resolve(options.output);
    // 不向原工程写报告，也不覆盖旧证据。输出的父目录必须是普通本地目录。
    await localPath(path.dirname(destination));
    assert.ok(![project, path.join(appRoot, 'dist'), path.join(appRoot, 'dist-electron')]
      .some(inputRoot => inside(inputRoot, destination)));
    await mkdir(destination);
    output = await open(path.join(await localPath(destination), 'baab-result.json'), 'wx');
    const [sourceBytes, replayBytes] = await Promise.all([readFile(source), readFile(recordingPath)]);
    const document = JSON.parse(sourceBytes.toString('utf8'));
    const { scene } = document;
    assert.ok(scene?.entities && scene.entityIds?.length);
    const bindings = Object.values(scene.entities).flatMap(entity => {
      const { telemetryBinding, modelAsset } = entity.components ?? {};
      const assetCode = (telemetryBinding?.assetCode ?? modelAsset?.assetCode)?.trim();
      const deviceType = telemetryBinding?.deviceType?.trim().toLowerCase();
      return telemetryBinding?.enabled && assetCode && SPECIALIZED_TYPES.has(deviceType)
        ? [{ assetCode, deviceType, sourceId: telemetryBinding.sourceId?.trim() || 'default' }] : [];
    });
    stage = 'recording-validation';
    const sourceSha256 = sha(sourceBytes), recordingSha256 = sha(replayBytes);
    const motion = prepareRecordedMotion(JSON.parse(replayBytes.toString('utf8')), bindings, sourceSha256);
    Object.assign(report.evidence, { sourceSha256, recordingSha256, replaySha256: motion.sha256,
      replayMessages: motion.messages, replayBytes: motion.bytes, maxDeviceGapMs: motion.maxDeviceGapMs });
    stage = 'offline-snapshot';
    root = await mkdtemp(path.join(await localPath(tmpdir()), 'zending-extreme-baab-'));
    const fixtureProject = path.join(root, 'project'), workspace = path.join(root, 'workspace');
    const fixture = path.join(fixtureProject, 'performance.scene.json');
    const assets = path.join(project, 'Assets'), fixtureAssets = path.join(fixtureProject, 'Assets');
    await mkdir(workspace);
    await cp(assets, fixtureAssets, { recursive: true, filter: async filename => { await localPath(filename); return true; } });
    const buildSha256 = await hashPaths(appRoot, ['package.json', 'dist', 'dist-electron']);
    const { relocateDataPlatformScene } = await import(pathToFileURL(path.join(appRoot, 'dist-electron', 'ipc', 'dataPlatformSceneRelocation.js')).href);
    const fixtureIndex = path.join(fixtureProject, SETTINGS_PATH), sourceIndex = path.join(project, SETTINGS_PATH);
    const index = await localPath(sourceIndex).then(readFile).catch(error => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    });
    if (index) {
      const indexCopy = relocateDataPlatformScene(JSON.parse(index.toString('utf8')), fixtureProject);
      assertOfflineResources(indexCopy, fixtureAssets);
      await mkdir(path.dirname(fixtureIndex));
      await writeFile(fixtureIndex, JSON.stringify(indexCopy));
    }
    const resourcePaths = index ? ['Assets', SETTINGS_PATH] : ['Assets'];
    const resourcesSha256 = await hashPaths(fixtureProject, resourcePaths);
    broker = await harness.createPerformanceMqttReplay([], 500, { records: motion.timeline, durationMs: WARMUP_MS + WINDOW_MS });
    // 只重定位资产和隔离输入；不改业务几何、相机、灯光或渲染档位。
    scene.mqttConfig = { enabled: true, simulatorEnabled: false, address: broker.address, ip: '127.0.0.1', topic: TOPIC,
      subscriptions: [{ topic: TOPIC, qos: 0, adapter: { kind: 'epv', sourceId: 'default' } }] };
    scene.fetchConfig = { url: '', apiKey: '', syncIntervalSeconds: 0 };
    const copy = relocateDataPlatformScene(document, fixtureProject);
    assertOfflineResources(copy, fixtureAssets);
    const fixtureBytes = JSON.stringify(copy);
    const fixtureSha256 = sha(fixtureBytes);
    await writeFile(fixture, fixtureBytes);
    Object.assign(report.evidence, { buildSha256, resourcesSha256, fixtureSha256 });
    const inputs = { appRoot, workspace, fixtureProject, fixture, broker, root };
    const setWindowStage = (trial, step) => { stage = `window-${trial.index}-${trial.variant}:${step}`; };
    for (const [index, variant] of ORDER.entries()) {
      const trial = { variant, index: index + 1 };
      const sample = await collectWindow(options, inputs, harness, trial, setWindowStage);
      report.runs.push(sample);
      setWindowStage(trial, 'validate-window');
      if (!validWindow(sample, index, report.evidence)) throw new Error('invalid-window');
      console.log(JSON.stringify({ experiment: BAAB_EXPERIMENT, index: index + 1, variant,
        fps: sample.frameCount * 1000 / WINDOW_MS, width: sample.last.width, height: sample.last.height }));
    }
    if (options.profile) {
      try {
        const trial = { variant: 'A', index: 5, profile: true };
        report.profile = await collectWindow(options, inputs, harness, trial, setWindowStage, report.runs[1]);
        if (report.profile.status !== 'complete') process.exitCode = 1;
      } catch {
        report.profile = { status: 'invalid', reason: stage };
        process.exitCode = 1;
      }
    }
    stage = 'input-recheck';
    report.evidence.unchanged = sha(await readFile(source)) === sourceSha256 && sha(await readFile(recordingPath)) === recordingSha256
      && sha(await readFile(fixture)) === fixtureSha256 && await hashPaths(appRoot, ['package.json', 'dist', 'dist-electron']) === buildSha256
      && await hashPaths(fixtureProject, resourcePaths) === resourcesSha256;
  } catch {
    // Playwright、文件和应用错误可拼入地址、报文或本地路径；诊断仅记录固定失败阶段。
    report.errors.push(stage);
  } finally {
    try { await broker?.close(); } catch { report.errors.push('broker-cleanup'); }
    try { if (root) await rm(root, { recursive: true, force: true }); } catch { report.errors.push('temporary-project-cleanup'); }
    Object.assign(report, classifyBaab(report.runs, report.evidence));
    if (report.errors.length) Object.assign(report, { conditionsMatched: false, classification: 'undetermined',
      reason: report.errors[0], fps: null });
    report.passed = report.conditionsMatched;
    if (!report.passed) process.exitCode = 1;
    if (output) {
      try { await output.writeFile(JSON.stringify(report, null, 2)); }
      finally { await output.close(); }
    }
    console.log(JSON.stringify({ experiment: BAAB_EXPERIMENT, passed: report.passed,
      classification: report.classification, reason: report.reason, profileStatus: report.profile?.status ?? null }));
  }
}

async function collectWindow(options, inputs, harness, trial, setWindowStage, reference) {
  const { root, appRoot, workspace, fixtureProject, broker, fixture } = inputs;
  setWindowStage(trial, 'prepare-instance');
  const disconnectedBy = performance.now() + 5_000;
  while (broker.getMetrics().clients > 0 && performance.now() < disconnectedBy) await delay(50);
  assert.equal(broker.getMetrics().clients, 0);
  const userData = path.join(root, `userdata-${trial.index}`);
  await mkdir(userData);
  await writeFile(path.join(userData, 'data-platform-config.json'), JSON.stringify({ version: 2, baseUrl: '', workspaceRoot: workspace }));
  await writeFile(path.join(userData, 'recent-workspaces.json'), JSON.stringify({ version: 1, projects: [],
    scenes: [{ filePath: fixture, lastOpenedAt: new Date().toISOString() }] }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => LAUNCH_ENV.has(key.toUpperCase())));
  Object.assign(env, { OPEN_DEVTOOLS: 'false', VITE_DEV_SERVER_URL: '', EDITOR_ALLOW_SOFTWARE_WEBGL: '0' });
  setWindowStage(trial, 'launch');
  const app = await harness.launch({ args: [appRoot, `--user-data-dir=${userData}`, '--disable-background-networking'],
    cwd: appRoot, env, acceptDownloads: false, chromiumSandbox: true, timeout: 120_000 });
  let page, installed = false, profiler;
  try {
    page = await app.firstWindow();
    const actualUserData = await localPath(await app.evaluate(({ app }) => app.getPath('userData')));
    assert.equal(path.relative(userData, actualUserData), '');
    // 在打开工程前拒绝 renderer 一切网络请求（仅允许此轮本机 MQTT WebSocket）。主进程无中台绑定或凭据。
    await app.evaluate(({ BrowserWindow }, allowed) => {
      globalThis.__baabBlockedRequests = 0;
      BrowserWindow.getAllWindows()[0].webContents.session.webRequest.onBeforeRequest({
        urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'],
      }, ({ url }, callback) => {
        const cancel = url !== allowed;
        if (cancel) globalThis.__baabBlockedRequests += 1;
        callback({ cancel });
      });
    }, broker.address);
    let pageErrors = 0;
    page.on('pageerror', () => { pageErrors += 1; });
    page.on('dialog', dialog => { void dialog.dismiss().catch(() => {}); });
    page.setDefaultTimeout(30_000);
    await harness.configureWindow(app, options.fullscreen);
    await page.bringToFront();
    setWindowStage(trial, 'open-scene');
    await harness.selectProjectDirectory(app, page, fixtureProject);
    await harness.openRecentScene(page, fixture, options.timeout, true);
    if (options.fullscreen) {
      await page.getByRole('button', { name: '全屏显示场景 (F11)', exact: true }).click();
      await page.locator('[data-scene-fullscreen="true"]').waitFor();
    }
    await harness.waitForStableCanvas(page);
    setWindowStage(trial, 'install-capture');
    await page.evaluate(harness.installCapture, true);
    installed = true;
    setWindowStage(trial, 'start-performance-run');
    await page.getByRole('button', { name: '性能运行', exact: true }).click();
    await page.getByRole('button', { name: '停止', exact: true }).waitFor();
    const connectedBy = performance.now() + 10_000;
    while (broker.getMetrics().clients !== 1 && performance.now() < connectedBy) await delay(50);
    assert.equal(broker.getMetrics().clients, 1);
    setWindowStage(trial, 'validate-baseline');
    await harness.waitForStableCanvas(page);
    await page.evaluate(() => window.__extremeCapture.resetCamera());
    const baseline = await page.evaluate(() => window.__extremeCapture.snapshot());
    assert.ok(validRenderer(baseline.renderer) && validView(baseline, baseline, 1), 'A 须为自然硬件缩放 1');
    assert.equal(await page.locator('aside[aria-label="场景资源状态"] pre').count(), 0);
    const inventorySha256 = await readInventoryHash(page);
    const driver = await readDriver(app);
    assert.ok(validDriver(driver));
    if (reference) assert.ok(isDeepStrictEqual(driver, reference.driver) && inventorySha256 === reference.inventorySha256
      && sameViewport(baseline, reference.baseline) && sameCamera(baseline.camera, reference.baseline.camera)
      && isDeepStrictEqual(baseline.renderer, reference.baseline.renderer));
    setWindowStage(trial, 'validate-scaling');
    if (trial.variant === 'B') await page.evaluate(() => window.__extremeCapture.setDiagnosticScale(2));
    await harness.waitForStableCanvas(page);
    assert.ok(validView(await page.evaluate(() => window.__extremeCapture.snapshot()), baseline, SCALES[trial.variant]));
    setWindowStage(trial, 'measure');
    const beforeReplay = epochNow();
    broker.setMode('motion');
    const afterReplay = epochNow();
    assert.ok(afterReplay - beforeReplay <= 50, '回放与相机采样起点的对齐误差过大');
    const startEpochMs = (beforeReplay + afterReplay) / 2 + WARMUP_MS;
    const durationMs = trial.profile ? PROFILE_MS : WINDOW_MS;
    await page.evaluate(window => globalThis.__extremeCapture.start(true, false, window), { startEpochMs, durationMs });
    if (trial.profile) {
      await sleepUntil(startEpochMs);
      profiler = await harness.startCpuProfile(page);
      await delay(PROFILE_MS);
    } else {
      await sleepUntil(startEpochMs + durationMs + 100);
    }
    const { clients, messages, bytes, ticks, failures } = broker.getMetrics();
    broker.setMode('silent');
    const profile = profiler && (await profiler.send('Profiler.stop')).profile;
    const measured = await page.evaluate(() => window.__extremeCapture.stop());
    setWindowStage(trial, 'verify-measurement');
    const finalDriver = await readDriver(app);
    assert.ok(isDeepStrictEqual(finalDriver, driver) && await readInventoryHash(page) === inventorySha256);
    assert.equal(await page.locator('aside[aria-label="场景资源状态"] pre').count(), 0);
    assert.equal(pageErrors, 0);
    assert.equal(await app.evaluate(() => globalThis.__baabBlockedRequests), 0);
    if (trial.profile) {
      assert.ok(measured.violation === null && clients === 1 && failures === 0 && messages > 0
        && measured.elapsedMs >= PROFILE_MS && measured.measuredDurationMs >= PROFILE_MS - EDGE_BUDGET_MS
        && hasMotionActivity(measured.samples, measured.last)
        && [measured.last, ...measured.samples].every(sample => validView(sample, baseline, 1)));
      return summarizeCpuProfile(profile, appRoot);
    }
    return { ...trial, mode: 'motion', baseline, driver, inventorySha256, replay: { clients, messages, bytes, ticks, failures }, ...measured };
  } finally {
    broker.setMode('silent');
    try {
      if (profiler) await withinDeadline(profiler.detach(), 2_000).catch(() => {});
      if (page && !page.isClosed() && installed) {
        await withinDeadline(page.evaluate(() => {
          const capture = window.__extremeCapture;
          capture?.stop();
          try { capture?.setDiagnosticScale(1); } finally { capture?.dispose(); }
        }), 2_000).catch(() => {});
      }
    } finally { await closeOwnedElectron(app); }
  }
}

async function withinDeadline(promise, timeoutMs) {
  const timeout = new AbortController();
  try {
    const expiration = delay(timeoutMs, null, { signal: timeout.signal }).then(() => {
      throw new Error('Electron 诊断清理超时');
    });
    return await Promise.race([promise, expiration]);
  } finally {
    timeout.abort();
  }
}

async function closeOwnedElectron(app) {
  const child = app.process();
  try {
    await withinDeadline(app.close(), 10_000);
  } catch {
    // 只终止当前窗口对应的 Playwright 子进程，不能按程序名结束用户的编辑器。
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (!child.kill('SIGKILL')) throw new Error('无法退出本次诊断的 Electron 进程');
    const wait = new AbortController();
    try {
      await withinDeadline(once(child, 'exit', { signal: wait.signal }), 5_000);
    } finally {
      wait.abort();
    }
  }
}

async function readInventoryHash(page) {
  return page.evaluate(async () => {
    const bytes = new TextEncoder().encode(JSON.stringify(window.__extremeCapture.inventory()));
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(hash), value => value.toString(16).padStart(2, '0')).join('');
  });
}

async function readDriver(app) {
  return app.evaluate(async ({ app, BrowserWindow, screen }) => {
    const { gpuDevice, auxAttributes } = await app.getGPUInfo('complete');
    const active = gpuDevice?.find(device => device.active === true) ?? (gpuDevice?.length === 1 ? gpuDevice[0] : null);
    const display = screen.getDisplayMatching(BrowserWindow.getAllWindows()[0].getBounds());
    return { enabled: app.isHardwareAccelerationEnabled(), vendorId: active?.vendorId ?? null,
      deviceId: active?.deviceId ?? null, driverVersion: active?.driverVersion || auxAttributes?.driverVersion || null,
      displayHz: display.displayFrequency ?? null, electron: process.versions.electron, chromium: process.versions.chrome };
  });
}

export function summarizeCpuProfile(profile, appRoot) {
  const rootUrl = pathToFileURL(path.join(appRoot, 'dist') + path.sep).href;
  const durationMs = (profile.endTime - profile.startTime) / 1000;
  assert.ok(durationMs >= PROFILE_MS - 100 && durationMs <= PROFILE_MS + 1000
    && profile.samples.length > 0 && profile.samples.length === profile.timeDeltas.length);
  const stats = new Map();
  const frameById = new Map(profile.nodes.map(node => [node.id, node.callFrame]));
  for (const [index, id] of profile.samples.entries()) {
    const frame = frameById.get(id);
    if (!frame || frame.functionName === '(idle)' || !positive(profile.timeDeltas[index])) continue;
    const key = sha(JSON.stringify([frame.url, frame.functionName, frame.lineNumber, frame.columnNumber]));
    const row = stats.get(key) ?? { frameSha256: key,
      functionName: frame.url.startsWith(rootUrl) && /^[\w$]{1,80}$/.test(frame.functionName) ? frame.functionName : null,
      line: frame.lineNumber + 1, column: frame.columnNumber + 1, selfMs: 0 };
    row.selfMs += profile.timeDeltas[index] / 1000;
    stats.set(key, row);
  }
  assert.ok(stats.size > 0);
  return { status: 'complete', variant: 'A', durationMs, sampleCount: profile.samples.length,
    semantics: '按 CDP 叶帧采样累计自耗时，百分比分母为整个采样窗口；不保留原始堆栈、URL 或外部函数名称。',
    bottomUpTop10: [...stats.values()].sort((a, b) => b.selfMs - a.selfMs).slice(0, 10)
      .map(row => ({ ...row, selfPercent: row.selfMs * 100 / durationMs })) };
}

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function localPath(input) {
  const absolute = path.resolve(input);
  assert.ok(!/^\\\\/.test(absolute), '只允许本机路径');
  const stat = await lstat(absolute);
  assert.ok(stat.isFile() || stat.isDirectory());
  const actual = await realpath(absolute);
  assert.equal(process.platform === 'win32' ? actual.toLowerCase() : actual,
    process.platform === 'win32' ? absolute.toLowerCase() : absolute, '不允许符号链接或目录联接');
  return absolute;
}

export function assertOfflineResources(value, assets, key = '') {
  if (Array.isArray(value)) for (const item of value) assertOfflineResources(item, assets, key);
  else if (value && typeof value === 'object') {
    for (const [childKey, child] of Object.entries(value)) assertOfflineResources(child, assets, childKey);
  } else if (typeof value === 'string' && value) {
    let file;
    const reference = value.trim();
    if (/^editor-asset:/i.test(reference)) {
      const url = new URL(reference);
      assert.ok(url.hostname === 'local' && !url.username && !url.password);
      file = decodeURIComponent(url.pathname.slice(1));
    } else if (/^file:/i.test(reference)) file = fileURLToPath(reference);
    else if (LOCAL_RESOURCE_KEYS.has(key)) {
      if (path.isAbsolute(reference) || path.win32.isAbsolute(reference)) file = reference;
      else assert.ok(!/^[a-z]:/i.test(reference) && !reference.split(/[\\/]/).includes('..'), '资产相对路径不能离开离线副本');
    }
    if (file !== undefined) assert.ok(path.isAbsolute(file) && inside(assets, file), '资产不在离线工程副本内');
  }
}

async function hashPaths(root, names) {
  const hash = createHash('sha256');
  const visit = async (relative) => {
    const filename = await localPath(path.join(root, relative));
    if ((await lstat(filename)).isDirectory()) {
      for (const child of (await readdir(filename)).sort()) await visit(path.join(relative, child));
      return;
    }
    const bytes = createHash('sha256');
    for await (const chunk of createReadStream(filename)) bytes.update(chunk);
    hash.update(JSON.stringify([relative.split(path.sep).join('/'), bytes.digest('hex')]) + '\n');
  };
  for (const name of names) await visit(name);
  return hash.digest('hex');
}
