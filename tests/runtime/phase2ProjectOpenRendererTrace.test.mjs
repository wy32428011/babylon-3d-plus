import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import * as trace from '../../src/editor/loading/projectOpenTrace.ts';
import * as preparation from '../../src/editor/loading/scenePreparationProgress.ts';
import { ProjectOpenTraceRecorder, PROJECT_OPEN_PHASES } from '../../electron/shared/projectOpenTrace.ts';
import { createProjectOpenSession } from '../../src/editor/home/projectLoadingCancellation.ts';

const sources = Object.fromEntries(await Promise.all([
  ['home', 'src/editor/home/HomePage.tsx'], ['app', 'src/App.tsx'], ['store', 'src/editor/store/slices/sceneDocumentSlice.ts'],
  ['panel', 'src/editor/panels/ProjectPanel.tsx'], ['view', 'src/editor/panels/SceneViewPanel.tsx'], ['reports', 'src/editor/panels/scene-view/scenePerformanceReports.ts'],
].map(async ([name, file]) => [name, ts.createSourceFile(file, await readFile(file, 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)])));
function find(ast, predicate) { const found = []; const visit = node => { if (predicate(node)) found.push(node); ts.forEachChild(node, visit); }; visit(ast); return found; }
function fn(file, name) { const node = find(sources[file], node => ts.isFunctionDeclaration(node) && node.name?.text === name)[0]; assert.ok(node, name); return node.getText(sources[file]).replace(/^export\s+/, ''); }
function evaluate(source, scope) { runInNewContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } }).outputText, scope); }
const loader = find(sources.store, node => ts.isPropertyAssignment(node) && node.name.getText(sources.store) === 'loadSceneFromFile')[0].initializer.getText(sources.store);
const resourceEffect = find(sources.panel, node => ts.isCallExpression(node) && node.expression.getText(sources.panel) === 'useEffect'
  && node.arguments[0]?.getText(sources.panel).includes('const runId = `local-scene-${sceneSessionId}-${localResourceRetry}`'));
assert.equal(resourceEffect.length, 1);
const completeRuntime = find(sources.view, node => ts.isVariableDeclaration(node) && node.name.getText(sources.view) === 'completeOpenTrace')[0].initializer.getText(sources.view);
let sequence = 100;
const id = () => (++sequence).toString(16).padStart(8, '0') + '-1111-4111-8111-111111111111';
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

function installLongTaskObserver(t) {
  const descriptors = new Map(['performance', 'PerformanceObserver']
    .map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const observers = [], opens = [];
  let now = 100;
  class Observer {
    static supportedEntryTypes = ['longtask'];
    static failObserve = false;
    constructor(callback) { this.callback = callback; this.pending = []; this.calls = []; observers.push(this); }
    observe(options) {
      this.calls.push('observe');
      assert.deepEqual(options, { entryTypes: ['longtask'] });
      if (Observer.failObserve) throw new Error('observer-secret');
    }
    disconnect() { this.calls.push('disconnect'); }
    takeRecords() {
      this.calls.push('takeRecords');
      if (this.failTakeRecords) throw new Error('take-records-secret');
      return this.pending.splice(0);
    }
    deliver(entries) { this.callback({ getEntries: () => entries }, this); }
  }
  Object.defineProperty(globalThis, 'performance', { value: { now: () => now }, configurable: true });
  Object.defineProperty(globalThis, 'PerformanceObserver', { value: Observer, configurable: true });
  t.after(() => {
    for (const context of opens) trace.finishProjectOpenTrace(context, 'stale');
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  });
  return {
    Observer, observers, time: value => { now = value; },
    open(detail = 'phases') {
      trace.setNextProjectOpenTraceDetail(detail);
      const context = trace.beginHomeProjectOpenTrace(id());
      assert.ok(context);
      opens.push(context);
      return context;
    },
  };
}

function browserLongTask(startTime, duration, entryType = 'longtask') {
  return { entryType, startTime, duration, name: 'frame-secret', attribution: [{ containerSrc: 'url-secret' }],
    toJSON() { throw new Error('原始浏览器归因不应序列化'); } };
}

function fixture(t, options = {}) {
  trace.setNextProjectOpenTraceDetail('phases');
  const openId = id(), session = 'scene_session_' + sequence, viewChanges = [], statuses = [], requests = [], panels = [], copied = [];
  const apiGate = deferred(), enteredApi = deferred(), cachedGate = deferred(), enteredCached = deferred();
  const scene = { id: 'source-case', name: 'source', entityIds: [], entities: {}, sceneSettings: { environment: null } };
  let state = { sceneSessionId: 'old_' + session, scene: { id: 'old' }, runtimeMode: 'edit', logs: [], hierarchySelectionIds: [], sceneResourceIssues: [],
    hasUnsavedChanges: () => false, pushLog: message => statuses.push(message), recordSceneResourceIssues: (_s, issues) => { state.sceneResourceIssues.push(...issues); },
    finishSceneStartupResourcePreparation: () => { state.sceneStartupResourceSessionId = null; },
    commitLatestSceneResources: (s, before, after) => { assert.equal(s, state.sceneSessionId); assert.equal(before === state.scene, true); state.scene = after; state.sceneStartupResourceSessionId = null; return true; } };
  let main, mainNow = 5000, getterCalls = 0;
  const resultFor = (requestContext, operation = 'openProject') => {
    const result = operation === 'openProject' ? { projectRoot: '/fixture/project', sceneFilePath: '/fixture/project/Scenes/source.scene.json',
      source: 'package', warning: null, conflictCopyPath: null, modelSyncStarted: false, envModelSyncStarted: false, skyboxSyncStarted: false, binding: {} }
      : { configured: true, sourceKey: 'fixture-source', modelReplacements: [], modelAssets: [], environmentAssets: [] };
    if (!requestContext || options.oldApi) return result;
    main ??= new ProjectOpenTraceRecorder(requestContext, { clockDomain: 'main', now: () => mainNow });
    const bridge = main.beginIpcBridge(operation, mainNow, { parent: { openId, clockDomain: 'renderer', spanId: requestContext.parentSpanId } });
    if (operation === 'openProject') for (const phase of PROJECT_OPEN_PHASES.slice(0, 4)) main.beginPhase(phase).end();
    result.trace = main.snapshot(); bridge.end('ok', undefined, mainNow);
    result.traceIpc = { openId, operation, receivedMs: mainNow, returnedMs: mainNow, outcome: 'ok' }; return result;
  };
  const window = { editorApi: {
    openDataPlatformProject: async request => { requests.push(request); enteredApi.resolve(); if (options.pendingApi) await apiGate.promise; return resultFor(request.trace); },
    loadSceneFile: async () => ({ content: JSON.stringify(scene), filePath: '/fixture/project/Scenes/source.scene.json', sceneOpenToken: 1 }),
    listSyncedImages: async () => { enteredCached.resolve(); if (options.pendingImages) await cachedGate.promise; return []; }, confirmSceneOpen: async () => true,
    closeDataPlatformProject: async () => {},
    prepareLocalSceneResources: async request => { panels.push(request); if (options.resourceError) throw options.resourceError; return resultFor(request.trace, 'sceneResources'); },
    cancelSceneModelSync: async () => true,
    getProjectOpenTrace: async request => { getterCalls++; assert.deepEqual(request, { openId }); mainNow += 10000; if (options.staleDuringGetter) state.sceneSessionId = 'switched'; return main?.snapshot() ?? null; },
  } };
  const storeScope = { ...trace, window, get: () => state, set: update => { state = { ...state, ...(typeof update === 'function' ? update(state) : update) }; },
    guardRuntimePreviewMutation: value => value, deserializeScene: JSON.parse, setSyncedImageAssets: () => {},
    prependLog: (logs, message) => [...logs, message], createLoadedSceneState: (_state, loaded) => ({ scene: loaded, sceneSessionId: session }), syncDataPlatformImagesAfterLocalSceneLoad: () => {} };
  evaluate('globalThis.action=' + loader, storeScope); state.loadSceneFromFile = storeScope.action;
  const appScope = { useEditorStore: { getState: () => state }, setView: view => viewChanges.push(view), ...trace };
  evaluate(fn('app', 'handleOpenRecentScene') + '\nglobalThis.openRecent=handleOpenRecentScene;', appScope);
  const homeScope = { ...trace, window, crypto: { randomUUID: () => openId }, isOpeningDataPlatformProject: false, isChangingDataPlatformWorkspace: false,
    projectOpenSession: { current: createProjectOpenSession() }, projectOpenTraceRef: { current: undefined },
    setCanCancelProjectOpen: () => {}, setBusyActionId: () => {}, setDataPlatformError: () => {}, setStatus: value => statuses.push(value),
    setIsCancellingProjectOpen: () => {}, canCancelProjectOpen: true, isCancellingProjectOpen: false, useEditorStore: { getState: () => state },
    onOpenRecentScene: appScope.openRecent, onEnterProjectEditor: () => { throw new Error('本fixture应有入口场景'); }, getHomeErrorMessage: error => error.message };
  evaluate(['getDataPlatformProjectOpenApi', 'requestOpenDataPlatformProject', 'handleOpenDataPlatformProject', 'handleCancelDataPlatformProjectOpen'].map(name => fn('home', name)).join('\n')
    + '\nglobalThis.openHome=handleOpenDataPlatformProject;globalThis.cancelHome=handleCancelDataPlatformProjectOpen;', homeScope);
  let runtimeTokens;
  t.after(() => { runtimeTokens?.forEach(token => token.end('stale', 'scene-stale')); trace.completeProjectOpenResources(homeScope.projectOpenTraceRef.current, 'stale'); trace.finishProjectOpenTrace(homeScope.projectOpenTraceRef.current, 'stale'); trace.setNextProjectOpenTraceDetail('phases'); });
  return { openId, session, scene, statuses, requests, panels, viewChanges, copied, homeScope, window,
    state: () => state, main: () => main, getterCalls: () => getterCalls, open: () => homeScope.openHome({ id: 'project-1', projectName: 'fixture' }), cancel: () => homeScope.cancelHome(),
    enteredApi: enteredApi.promise, releaseApi: apiGate.resolve, enteredCached: enteredCached.promise, releaseCached: cachedGate.resolve,
    switchSession: () => { state.sceneSessionId = 'changed'; },
    async resources() {
      preparation.beginScenePreparation(session); const done = deferred();
      const scope = { ...trace, ...preparation, sceneResourcePolicy: state.sceneResourcePolicy, sceneSessionId: session, localResourceRetry: 0,
        localResourcePreparingRef: { current: false }, setIsPreparingSceneResources: value => { if (!value) done.resolve(); }, crypto: { randomUUID: () => 'refresh-1' },
        useEditorStore: { getState: () => state }, environmentPreparationStore: { clearError() {}, fail() {} }, window,
        initialProjectAssetsLoadPromiseRef: { current: Promise.resolve({ ok: true }) }, serializeScene: JSON.stringify,
        applyAvailableSceneModelUpdates: before => ({ scene: before, issues: [], warnings: [], updatedCount: 0 }), pushLog: message => statuses.push(message) };
      evaluate('globalThis.effect=' + resourceEffect[0].arguments[0].getText(sources.panel), scope); const cleanup = scope.effect(); await done.promise; return cleanup;
    },
    complete(success = true, closeRuntime = true) {
      const recorder = trace.getSceneProjectOpenRecorder(session); assert.ok(recorder);
      const sixth = recorder.beginPhase('runtimeAcquireInitialize'), seventh = recorder.beginPhase('batchFirstReady'); runtimeTokens = [sixth, seventh];
      const scope = { ...trace, openTrace: trace.getSceneProjectOpenContext(session), sceneSessionId: session,
        useEditorStore: { getState: () => state }, runtimeRef: { current: { completeProjectOpenRuntime(outcome, code) { if (closeRuntime) { sixth.end(outcome, code); seventh.end(outcome, code); } } } } };
      evaluate('globalThis.complete=' + completeRuntime, scope); scope.complete(success);
      preparation.reportSceneRuntimeProgress(session, { generation: session, totalModels: 0, settledModels: 0, expectedBatchedEntities: 0, batchedEntities: 0, stable: true });
      return trace.readProjectOpenTrace(openId);
    },
    async copy() {
      const scope = { ...trace, ...preparation, useEditorStore: { getState: () => state }, window,
        navigator: { clipboard: { writeText: async text => copied.push(JSON.parse(text)) } } };
      evaluate(fn('reports', 'copyScenePerformanceReport') + '\n' + fn('reports', 'createScenePerformanceReportHandlers') + '\nglobalThis.create=createScenePerformanceReportHandlers;', scope);
      const handlers = scope.create({ performanceMonitorRef: { current: { createReport: () => '{"originalMetric":17}' } }, performanceRunSessionRef: { current: null }, pushLog: () => {}, getErrorMessage: error => error.message });
      await handlers.handleCopyPerformanceReport(); return copied.at(-1);
    } };
}

test('真实Home→App→Store→ProjectPanel传同ID，单次getter复制join，source文档不含trace', async t => {
  const browser = installLongTaskObserver(t);
  const f = fixture(t); assert.equal(trace.setNextProjectOpenTraceDetail('assets'), true); await f.open();
  const [observer] = browser.observers;
  assert.ok(observer, 'Home既有动作直接开始观察，无需性能运行开关');
  assert.equal(f.requests[0].trace.openId, f.openId); assert.equal(f.requests[0].trace.detail, 'assets');
  assert.equal(f.viewChanges.at(-1), 'editor'); assert.equal(f.state().sceneSessionId, f.session);
  assert.equal(trace.getSceneProjectOpenContext(f.session).openId, f.openId);
  await f.resources(); assert.equal(f.panels[0].trace.openId, f.openId); assert.notEqual(f.panels[0].trace.parentSpanId, f.requests[0].trace.parentSpanId);
  browser.time(220); observer.pending.push(browserLongTask(120, 80));
  assert.equal(f.complete().status, 'ready'); const copied = await f.copy();
  assert.deepEqual(observer.calls, ['observe', 'takeRecords', 'disconnect']);
  assert.equal(copied.projectOpen.longTasks.openId, f.openId);
  assert.equal(copied.projectOpen.longTasks.status, 'stopped');
  assert.deepEqual(copied.projectOpen.longTasks.window, { startMs: 100, endMs: 220, sampledThroughMs: 220 });
  assert.deepEqual(copied.projectOpen.longTasks.entries.map(entry => entry.durationMs), [80]);
  assert.equal(copied.originalMetric, 17); assert.equal(copied.scenePreparation.openId, f.openId); assert.equal(copied.projectOpen.openId, f.openId);
  assert.equal(copied.projectOpen.criticalPathComplete, true); assert.equal(f.copied.length, 1);
  assert.equal(f.getterCalls(), 1, '既有复制操作仅调用一次owner getter，不启动轮询');
  assert.equal(copied.projectOpen.bridges.length, 2); assert.ok(copied.projectOpen.bridges.every(pair => pair.residual.valid));
  assert.equal(Object.hasOwn(f.state().scene, 'openId'), false); assert.equal(Object.hasOwn(f.state().scene, 'trace'), false);
});

test('assets只下一次Home消费；取消/迟到保持旧ID，后续Home恢复phases', async t => {
  const f = fixture(t, { pendingApi: true }); trace.setNextProjectOpenTraceDetail('assets'); const running = f.open(); await f.enteredApi;
  assert.equal(f.requests[0].trace.detail, 'assets'); await f.cancel(); f.releaseApi(); await running;
  assert.equal(trace.readProjectOpenTrace(f.openId).status, 'cancelled'); assert.equal(f.viewChanges.length, 0);
  const next = fixture(t); await next.open(); assert.equal(next.requests[0].trace.detail, 'phases');
  assert.equal(trace.setNextProjectOpenTraceDetail('invalid'), false);
});

test('旧API不回trace仍按原Home/Store完成业务，诊断不冒充完整', async t => {
  const f = fixture(t, { oldApi: true }); trace.setNextProjectOpenTraceDetail('assets'); await f.open(); await f.resources();
  assert.equal(f.viewChanges.at(-1), 'editor'); assert.equal(f.complete().status, 'partial');
  const report = await f.copy(); assert.equal(report.projectOpen.criticalPathComplete, false);
});

test('图片缓存await期间切换会话，真实Store晚到不提交/不绑定新scene', async t => {
  const f = fixture(t, { pendingImages: true }); trace.setNextProjectOpenTraceDetail('assets'); const running = f.open(); await f.enteredCached;
  f.switchSession(); f.releaseCached(); await running;
  assert.equal(f.state().sceneSessionId, 'changed'); assert.equal(f.viewChanges.length, 0); assert.equal(trace.getSceneProjectOpenContext('changed'), undefined);
  assert.equal(trace.readProjectOpenTrace(f.openId).status, 'stale');
});

test('资源原错误和强制/部分完成保留，不能通过Runtime ok清掉phase5失败', async t => {
  const original = new Error('original-resource-error'), f = fixture(t, { resourceError: original }); trace.setNextProjectOpenTraceDetail('assets'); await f.open(); await f.resources();
  assert.ok(f.statuses.some(value => typeof value === 'string' && value.includes(original.message)));
  const snapshot = f.complete(); assert.equal(snapshot.status, 'partial');
  assert.equal(snapshot.phases.find(row => row.phase === 'sceneCommitResourceSync').state, 'error');
});

test('自然完成必须先关闭Runtime实际6/7，未关闭不能把Home根伪装ready', async t => {
  const f = fixture(t); trace.setNextProjectOpenTraceDetail('assets'); await f.open(); await f.resources();
  const snapshot = f.complete(true, false); assert.equal(snapshot.status, 'partial'); assert.equal(snapshot.recording.criticalPathComplete, false);
});

test('复制getter期间真实Store换session，保留原ID报告并标stale，不拼接新场景', async t => {
  const f = fixture(t, { staleDuringGetter: true }); trace.setNextProjectOpenTraceDetail('assets'); await f.open(); await f.resources(); f.complete();
  const report = await f.copy(); assert.equal(report.projectOpen.openId, f.openId); assert.equal(report.projectOpen.stale, true); assert.equal(report.projectOpen.criticalPathComplete, false);
});

test('真实SceneView assetsSettled条件不以缺省0掩盖pending/失败/环境未ready', async t => {
  const f = fixture(t); trace.setNextProjectOpenTraceDetail('assets'); await f.open(); await f.resources();
  const statement = find(sources.view, node => ts.isIfStatement(node) && node.thenStatement.getText(sources.view).includes('runtime.markProjectOpenAssetsSettled();'));
  assert.equal(statement.length, 1);
  for (const change of [() => {}, value => { value.settledModels = 0; }, value => { value.environmentReady = false; },
    value => { value.runtimeMetrics.loading.pendingModelCount = 1; }, value => { value.runtimeMetrics.loading.active = [{}]; },
    value => { value.currentFailures = 1; }, value => { value.currentFailures = null; }]) {
    let calls = 0;
    const scope = { ...trace, openTrace: trace.getSceneProjectOpenContext(f.session), sceneSessionId: f.session,
      settledModels: 1, totalSceneModels: 1, environmentReady: true, currentFailures: 0,
      runtimeMetrics: { loading: { pendingModelCount: 0, active: [], failedModelAcquisitions: 1 } }, runtime: {
        markProjectOpenAssetsSettled: () => { calls++; }, getProjectOpenModelAcquisitionFailures: session => { assert.equal(session, f.session); return scope.currentFailures; } } };
    change(scope); evaluate(statement[0].getText(sources.view), scope);
    assert.equal(calls, scope.settledModels === 1 && scope.environmentReady && scope.runtimeMetrics.loading.pendingModelCount === 0
      && scope.runtimeMetrics.loading.active.length === 0 && scope.currentFailures === 0 ? 1 : 0);
  }
});

test('两处trace门仅按当前open scope失败计数，旧lifetime1+B0可成功，B1/null拒绝', async t => {
  const f = fixture(t); trace.setNextProjectOpenTraceDetail('assets'); await f.open(); await f.resources();
  const assetGate = find(sources.view, node => ts.isIfStatement(node) && node.thenStatement.getText(sources.view).includes('runtime.markProjectOpenAssetsSettled();'))[0];
  const readyGate = find(sources.view, node => ts.isCallExpression(node) && node.expression.getText(sources.view) === 'completeOpenTrace'
    && node.arguments[0]?.getText(sources.view).includes('preparationState.runtime.forcedSettled'));
  assert.equal(readyGate.length, 1);
  for (const failures of [0, 1, null]) {
    let settled = 0;
    const scope = { ...trace, openTrace: trace.getSceneProjectOpenContext(f.session), sceneSessionId: f.session,
      settledModels: 1, totalSceneModels: 1, environmentReady: true,
      runtimeMetrics: { loading: { pendingModelCount: 0, active: [], failedModelAcquisitions: 1 } },
      preparationState: { runtime: { forcedSettled: false }, warnings: [] }, useEditorStore: { getState: () => ({ sceneResourceIssues: [] }) },
      runtime: { markProjectOpenAssetsSettled: () => { settled++; }, getInitialLoadSnapshot: () => ({ error: null }),
        getProjectOpenModelAcquisitionFailures: session => { assert.equal(session, f.session); return failures; } } };
    evaluate(assetGate.getText(sources.view), scope);
    assert.equal(settled, failures === 0 ? 1 : 0, '旧lifetime失败不能替代当前scope；unknown不伪0');
    evaluate('globalThis.traceReady=' + readyGate[0].arguments[0].getText(sources.view), scope);
    assert.equal(scope.traceReady, failures === 0, '最终自然ready的trace门同样按当前scope');
  }
  const readyNow = find(sources.view, node => ts.isVariableDeclaration(node) && node.name.getText(sources.view) === 'readyNow')[0].initializer.getText(sources.view);
  assert.doesNotMatch(readyNow, /getProjectOpenModelAcquisitionFailures|failedModelAcquisitions/, '诊断修复不改变实际业务ready门');
});

test('打开期最长十条按真实任务耗时排序，按同域阶段与 span 给出重叠证据', async t => {
  const browser = installLongTaskObserver(t);
  const context = browser.open('assets'), session = 'long_task_ranking';
  assert.equal(trace.bindProjectOpenScene(context, session), true);
  const recorder = trace.getSceneProjectOpenRecorder(session);
  const [observer] = browser.observers;
  trace.beginProjectOpenSceneCommit(context);
  browser.time(150);
  const sync = trace.beginProjectOpenRequest(context, 'sceneResources');
  browser.time(245);
  sync.finish('error');
  trace.completeProjectOpenResources(context, 'ok');
  browser.time(250);
  const phase = recorder.beginPhase('runtimeAcquireInitialize');
  browser.time(260);
  const scriptInit = recorder.beginTask('scriptInitialize', 'runtimeAcquireInitialize');
  browser.time(270);
  const script = recorder.beginTask('scriptConstructor', 'runtimeAcquireInitialize');
  browser.time(390);
  script.end(); scriptInit.end();
  const decode = recorder.beginTask('assetReadDecode', 'runtimeAcquireInitialize');
  browser.time(500);
  const classification = recorder.beginTask('lightingClassificationSources', 'runtimeAcquireInitialize');
  browser.time(590);
  observer.deliver([browserLongTask(510, 80)]);
  const interim = trace.readProjectOpenTrace(context.openId).longTasks;
  assert.equal(interim.status, 'recording');
  assert.deepEqual(interim.window, { startMs: 100, endMs: null, sampledThroughMs: 590 });
  assert.equal(interim.entries[0].category, 'ambiguous');
  browser.time(600); decode.end();
  browser.time(710); classification.end();
  browser.time(1620);
  observer.deliver([
    browserLongTask(0, 100), browserLongTask(10, 120), browserLongTask(155, 90),
    browserLongTask(280, 110), browserLongTask(400, 100), browserLongTask(600, 110),
    browserLongTask(200, 800, 'measure'), browserLongTask(NaN, 1000),
    browserLongTask(300, Infinity), browserLongTask(5000, 800), browserLongTask(300, 49),
    ...Array.from({ length: 12 }, (_, i) => browserLongTask(720 + i * 70, 50 + i)),
  ]);
  browser.time(1800); phase.end();
  observer.pending.push(browserLongTask(1630, 130));
  browser.time(1900); trace.finishProjectOpenTrace(context, 'partial');
  let mainNow = 1600;
  const main = new ProjectOpenTraceRecorder(context, { clockDomain: 'main', now: () => mainNow });
  const mainTask = main.beginTask('scriptConstructor', 'projectResolve');
  mainNow = 1900; mainTask.end();
  const report = (await trace.readSceneProjectOpenReport(session, async () => main.snapshot())).longTasks;
  assert.equal(report.observedCount, 19);
  assert.equal(report.limit, 10);
  assert.equal(report.attribution, 'span-overlap');
  assert.equal(report.clockDomain, 'renderer');
  assert.deepEqual(report.entries.map(task => task.durationMs), [130, 120, 110, 110, 100, 90, 80, 61, 60, 59]);
  const [pending, straddling, scriptTask, classificationTask, decodeTask, syncTask, ambiguousTask] = report.entries;
  assert.equal(pending.category, 'unknown', 'main span 即使数值重叠也不能提供 renderer 归因');
  assert.equal(straddling.openOverlapMs, 30);
  assert.equal(scriptTask.category, 'script');
  assert.deepEqual(scriptTask.overlaps.find(row => row.category === 'script'), {
    spanId: script.ref.spanId, stage: 'scriptConstructor', phase: 'runtimeAcquireInitialize',
    category: 'script', overlapMs: 110,
  });
  assert.equal(classificationTask.category, 'classification');
  assert.equal(classificationTask.overlaps.find(row => row.category === 'classification').spanId, classification.ref.spanId);
  assert.equal(decodeTask.category, 'asset-decode', '任务末端与分类起点相接时重叠为零');
  assert.equal(decodeTask.overlaps.find(row => row.category === 'asset-decode').spanId, decode.ref.spanId);
  assert.equal(syncTask.category, 'sync');
  assert.equal(syncTask.overlaps.find(row => row.category === 'sync').ipcOperation, 'sceneResources');
  assert.equal(ambiguousTask.category, 'ambiguous');
  assert.deepEqual(ambiguousTask.overlaps.filter(row => row.category !== 'unknown').map(row => row.category).sort(),
    ['asset-decode', 'classification']);
  assert.doesNotMatch(JSON.stringify(report), /frame-secret|url-secret|stack/);
  report.entries[0].durationMs = -1;
  assert.equal(trace.readProjectOpenTrace(context.openId).longTasks.entries[0].durationMs, 130);
});

test('并发打开各自按窗口接收，切场排空旧会话，淘汰和迟到回调保持隔离', async t => {
  const browser = installLongTaskObserver(t);
  const first = browser.open(), firstScene = 'long_task_first', secondScene = 'long_task_second';
  trace.bindProjectOpenScene(first, firstScene);
  preparation.beginScenePreparation(firstScene);
  const [observer] = browser.observers;
  browser.time(200);
  const second = browser.open();
  trace.bindProjectOpenScene(second, secondScene);
  assert.equal(browser.observers.length, 1);
  observer.pending.push(browserLongTask(100, 100), browserLongTask(190, 80));
  browser.time(300);
  preparation.beginScenePreparation(secondScene);
  const retired = trace.readProjectOpenTrace(first.openId);
  assert.equal(retired.status, 'stale');
  assert.equal(retired.longTasks.status, 'stopped');
  assert.deepEqual(retired.longTasks.entries.map(task => task.observedOpenCount), [1, 2]);
  assert.equal(await trace.readSceneProjectOpenReport(firstScene), null);
  assert.deepEqual(observer.calls, ['observe', 'takeRecords']);
  const active = trace.readProjectOpenTrace(second.openId).longTasks;
  assert.equal(active.status, 'recording');
  assert.deepEqual(active.entries.map(task => [task.durationMs, task.openOverlapMs, task.observedOpenCount]), [[80, 70, 2]]);
  observer.pending.push(browserLongTask(301, 55));
  browser.time(400);
  trace.finishProjectOpenTrace(second, 'cancelled');
  assert.deepEqual(observer.calls, ['observe', 'takeRecords', 'takeRecords', 'disconnect']);
  assert.equal(trace.readProjectOpenTrace(first.openId).longTasks.observedCount, 2);
  assert.equal(trace.readProjectOpenTrace(second.openId).longTasks.observedCount, 2);
  const replacement = browser.open();
  browser.time(500);
  observer.deliver([browserLongTask(401, 90)]);
  const currentObserver = browser.observers[1];
  currentObserver.deliver([browserLongTask(415, 60)]);
  assert.equal(trace.readProjectOpenTrace(replacement.openId).longTasks.observedCount, 1);
  const other = Array.from({ length: 7 }, () => browser.open());
  assert.equal(trace.beginHomeProjectOpenTrace(id()), undefined, '八个在途开场不驱逐活跃项目');
  assert.equal(trace.readProjectOpenTrace(first.openId), null);
  assert.equal(browser.observers.length, 2);
  for (const context of [replacement, ...other]) trace.finishProjectOpenTrace(context, 'cancelled');
  assert.equal(currentObserver.calls.filter(call => call === 'disconnect').length, 1);
});

test('不支持时报告状态，旧观察 API 和 phases 模式照常记录并排空未绑定打开', t => {
  const browser = installLongTaskObserver(t);
  browser.Observer.supportedEntryTypes = ['measure'];
  const unsupported = browser.open();
  trace.finishProjectOpenTrace(unsupported, 'failed');
  assert.equal(browser.observers.length, 0);
  assert.equal(trace.readProjectOpenTrace(unsupported.openId).longTasks.status, 'unsupported');
  delete browser.Observer.supportedEntryTypes;
  const legacy = browser.open();
  const [observer] = browser.observers;
  browser.time(200); observer.pending.push(browserLongTask(120, 60));
  trace.finishUnboundProjectOpenTrace(legacy, 'stale');
  const snapshot = trace.readProjectOpenTrace(legacy.openId);
  assert.equal(snapshot.detail, 'phases');
  assert.equal(snapshot.status, 'stale');
  assert.equal(snapshot.longTasks.status, 'stopped');
  assert.equal(snapshot.longTasks.entries[0].category, 'unknown');
  assert.deepEqual(observer.calls, ['observe', 'takeRecords', 'disconnect']);
});

test('观察启动、异步投递或排空失败不会阻断打开和原报告导出', async t => {
  const browser = installLongTaskObserver(t);
  browser.Observer.failObserve = true;
  const f = fixture(t); trace.setNextProjectOpenTraceDetail('assets'); await f.open(); await f.resources();
  assert.equal(f.complete().status, 'ready');
  const report = await f.copy();
  assert.equal(report.projectOpen.criticalPathComplete, true);
  assert.equal(report.projectOpen.longTasks.status, 'observer-error');
  assert.deepEqual(browser.observers[0].calls, ['observe', 'disconnect']);
  assert.doesNotMatch(JSON.stringify(report), /observer-secret/);
  browser.Observer.failObserve = false;
  const callbackFailure = browser.open();
  const callbackObserver = browser.observers[1];
  callbackObserver.callback({ getEntries() { throw new Error('callback-secret'); } }, callbackObserver);
  trace.finishProjectOpenTrace(callbackFailure, 'cancelled');
  assert.equal(trace.readProjectOpenTrace(callbackFailure.openId).longTasks.status, 'observer-error');
  assert.deepEqual(callbackObserver.calls, ['observe', 'disconnect']);
  const takeFailure = browser.open();
  const takeObserver = browser.observers[2];
  takeObserver.failTakeRecords = true;
  trace.finishProjectOpenTrace(takeFailure, 'partial');
  const snapshot = trace.readProjectOpenTrace(takeFailure.openId);
  assert.equal(snapshot.status, 'partial');
  assert.equal(snapshot.longTasks.status, 'observer-error');
  assert.deepEqual(takeObserver.calls, ['observe', 'takeRecords', 'disconnect']);
});

test('诊断getter失败仍复制原性能报告，不泄露原错误或假称P1通过', async t => {
  const f = fixture(t); trace.setNextProjectOpenTraceDetail('assets'); await f.open(); await f.resources(); f.complete();
  f.window.editorApi.getProjectOpenTrace = async () => { throw new Error('https://user:password@private/?token=credential'); };
  const report = await f.copy(); assert.equal(report.originalMetric, 17); assert.equal(report.projectOpen.criticalPathComplete, false);
  assert.doesNotMatch(JSON.stringify(report), /password|credential|private/);
});
