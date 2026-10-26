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
  const f = fixture(t); assert.equal(trace.setNextProjectOpenTraceDetail('assets'), true); await f.open();
  assert.equal(f.requests[0].trace.openId, f.openId); assert.equal(f.requests[0].trace.detail, 'assets');
  assert.equal(f.viewChanges.at(-1), 'editor'); assert.equal(f.state().sceneSessionId, f.session);
  assert.equal(trace.getSceneProjectOpenContext(f.session).openId, f.openId);
  await f.resources(); assert.equal(f.panels[0].trace.openId, f.openId); assert.notEqual(f.panels[0].trace.parentSpanId, f.requests[0].trace.parentSpanId);
  assert.equal(f.complete().status, 'ready'); const copied = await f.copy();
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

test('诊断getter失败仍复制原性能报告，不泄露原错误或假称P1通过', async t => {
  const f = fixture(t); trace.setNextProjectOpenTraceDetail('assets'); await f.open(); await f.resources(); f.complete();
  f.window.editorApi.getProjectOpenTrace = async () => { throw new Error('https://user:password@private/?token=credential'); };
  const report = await f.copy(); assert.equal(report.originalMetric, 17); assert.equal(report.projectOpen.criticalPathComplete, false);
  assert.doesNotMatch(JSON.stringify(report), /password|credential|private/);
});
