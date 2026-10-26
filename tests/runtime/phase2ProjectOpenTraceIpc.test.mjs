import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { ProjectOpenTraceStore } from '../../electron/ipc/projectOpenTraceStore.ts';
import { readProjectOpenTraceContext } from '../../electron/shared/projectOpenTrace.ts';

const ID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const traceContext = { version: 1, openId: ID, detail: 'assets', parentSpanId: 'renderer:1' };
const files = Object.fromEntries(await Promise.all(['dataPlatformIpc', 'dataPlatformProjectService'].map(async name => {
  const source = await readFile(new URL('../../electron/ipc/' + name + '.ts', import.meta.url), 'utf8');
  return [name, ts.createSourceFile(name + '.ts', source, ts.ScriptTarget.Latest, true)];
})));
function declaration(ast, name) {
  const found = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(found, '真实函数缺失：' + name); return found.getText(ast).replace(/^export\s+/, '');
}
function handler(channel) {
  let callback;
  const visit = node => {
    if (ts.isCallExpression(node) && node.arguments[0] && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === channel) {
      assert.equal(callback, undefined, 'IPC通道重复：' + channel); callback = node.arguments[1].getText(files.dataPlatformIpc);
    }
    ts.forEachChild(node, visit);
  };
  visit(files.dataPlatformIpc); assert.ok(callback, '真实IPC回调缺失：' + channel); return callback;
}
const ipcFunctions = ['projectTraceClock', 'readRequestedProjectTrace', 'observeProjectOpenTrace', 'projectTraceParent', 'projectTraceFailure',
  'registerProjectSessionHandler', 'validateOpenProjectRequest'];
const serviceFunctions = ['observeProjectTrace', 'endProjectTracePhase', 'measureProjectTracePhase', 'openDataPlatformProject',
  'openDataPlatformProjectInternal', 'cancelDataPlatformProjectLoading'];
const source = ipcFunctions.map(name => declaration(files.dataPlatformIpc, name)).join('\n') + '\n'
  + serviceFunctions.map(name => declaration(files.dataPlatformProjectService, name)).join('\n') + '\n'
  + ['data-platform:openProject', 'data-platform:prepareLocalSceneResources'].map(channel => 'registerProjectSessionHandler(' + JSON.stringify(channel) + ',' + handler(channel) + ');').join('\n')
  + '\nipcMain.handle("data-platform:getProjectOpenTrace",' + handler('data-platform:getProjectOpenTrace') + ');'
  + '\nipcMain.handle("data-platform:cancelProjectLoading",' + handler('data-platform:cancelProjectLoading') + ');';
const executable = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;

function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
/** 执行真实完整handler/服务函数，仅注入I/O依赖；不联网、不写真实工程、不启动Electron。 */
function fixture(options = {}) {
  let now = 10;
  const channels = new Map(), calls = [], timing = {}, resources = [], gate = deferred(), enteredDownload = deferred();
  const step = (name, ms = 1) => { calls.push(name); const start = now; now += ms; timing[name] = { start, end: now }; };
  const project = { id: 'p1', projectName: 'fixture', latestEditorProjectPackageUrl: options.generated ? null : 'https://fixture.invalid/private/source.zip?token=business-only',
    latestEditorProjectVersionId: options.generated ? null : 'v1', latestEditorProjectVersionNumber: 1, latestEditorProjectId: 'editor-1', currentResourceRevision: 'r1' };
  class RollbackError extends Error {}
  const scope = {
    AbortController, path, readProjectOpenTraceContext, ProjectOpenTraceStore,
    performance: { now: () => now }, projectOpenTraces: new ProjectOpenTraceStore({ now: () => now }),
    ipcMain: { handle: (name, callback) => { assert.equal(channels.has(name), false); channels.set(name, callback); } },
    projectClosing: false, projectSessionTasks: new Set(), projectMetadataControllers: new Set(), projectConfigRevision: 1,
    trustedProjectsById: new Map([['p1', project]]), trustedProjectsBaseUrl: 'https://fixture.invalid',
    isPlainObject: value => !!value && typeof value === 'object' && !Array.isArray(value),
    normalizeRequiredIdentifier: (value, label) => { if (typeof value !== 'string' || !value.trim()) throw new Error(label); return value.trim(); },
    assertSceneSwitchAllowed: () => { if (options.publishBlocked) throw options.publishBlocked; },
    readDataPlatformConfig: async () => { step('config'); return { baseUrl: 'https://fixture.invalid', workspaceRoot: '/virtual/workspace', webBaseUrl: 'https://fixture.invalid' }; },
    requestCurrentDataPlatformProject: async (_base, _id, signal) => { step('detail', 3); signal.throwIfAborted(); return project; },
    assertProjectOpenConfigUnchanged: async () => { step('config-check'); },
    dataPlatformProjectServiceShuttingDown: false, sceneResourceContextGeneration: 0, openingProjectCount: 0,
    openTaskControllers: new Set(), openTasks: new Set(), localSceneResourceTask: null,
    ensureWritableEditorRoot: async root => { step('writable:' + root); },
    resolveDataPlatformProjectLocation: async () => { step('locate'); return { projectRoot: '/virtual/project' }; },
    resolveDataPlatformSharedResourcesRoot: () => '/virtual/shared',
    ensureProjectDirectories: async root => { step('directories:' + root); },
    setSharedProjectAssetRoot: () => {}, setSharedProjectEnvironmentRoot: () => {}, setSharedProjectSkyboxRoot: () => {},
    readDataPlatformBinding: async () => { step('binding-read'); return null; },
    hasDifferentLocalProjectContent: async () => !!options.conflict,
    createLocalConflictCopy: async () => '/virtual/conflict',
    randomUUID: () => 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    assertPathInside: () => {}, fs: { rm: async () => { step('stage-rm'); }, mkdir: async () => { step('stage-mkdir'); } },
    PROJECT_DOWNLOAD_TIMEOUT_MS: 600000, DataPlatformRollbackError: RollbackError,
    downloadRemoteFile: async request => {
      timing.download = { start: now, end: null }; calls.push('download'); enteredDownload.resolve();
      if (options.pending) await new Promise((resolve, reject) => {
        const abort = () => reject(request.signal.reason);
        request.signal.addEventListener('abort', abort, { once: true });
        gate.promise.then(() => { request.signal.removeEventListener('abort', abort); resolve(); });
        if (request.signal.aborted) abort();
      });
      request.signal.throwIfAborted(); if (options.downloadError) throw options.downloadError;
      now += 40; timing.download.end = now;
    },
    extractZipSecurely: async () => { step('extract', 7); if (options.extractError) throw options.extractError; },
    detectCurrentProjectPackage: async () => { step('detect', 2); return options.invalidPackage ? { kind: 'invalid', reason: 'fixture-rejected' }
      : { kind: 'current', packageRoot: '/virtual/package', sceneFilePaths: ['/virtual/package/Scenes/entry.scene.json'], sceneFilePath: '/virtual/package/Scenes/entry.scene.json' }; },
    materializeCurrentProjectPackage: async request => {
      timing.materialize = { start: now, end: null }; calls.push('materialize'); await request.beforePromote('/virtual/staged');
      if (options.materializeError) throw options.materializeError; now += 11; timing.materialize.end = now;
      return { sceneFilePath: '/virtual/project/Scenes/entry.scene.json', warning: null };
    },
    ensureGeneratedProjectMetadata: async () => { step('generated'); }, activateProjectRoot: async () => { step('activate', 3); },
    rememberRecentSceneFile: async () => { step('recent'); }, toProjectRelativePath: () => 'Scenes/entry.scene.json',
    createDataPlatformBinding: value => value, writeDataPlatformBinding: async () => { step('binding-write'); },
    setCurrentDataPlatformBinding: () => {}, setBoundScenePublishScope: () => {}, invalidateDataPlatformSkyboxSyncPrepareContext: () => {},
    getRequiredEnvironmentResourceIds: () => [], readProjectPackageJson: async () => { step('scene-environment-read'); return {}; },
    startDataPlatformModelSync: () => true, startDataPlatformEnvironmentSync: () => true,
    createDataPlatformEnvironmentSyncContextKey: () => 'environment-key', createDataPlatformSkyboxSyncContextKey: () => 'skybox-key',
    startDataPlatformSkyboxSync: () => { step('skybox-background-start'); return true; },
    cancelDataPlatformEnvironmentSync: () => false, cancelDataPlatformModelSync: () => false,
    prepareLocalSceneResources: async (_base, _root, request) => {
      resources.push(request); step('resource-prepare', 17); if (options.resourceError) throw options.resourceError;
      return { configured: true, sourceKey: 'fixture-source', modelAssets: [], environmentAssets: [] };
    },
  };
  runInNewContext(executable, scope);
  return { scope, calls, timing, resources, enteredDownload: enteredDownload.promise, release: gate.resolve,
    advance: ms => { now += ms; }, getNow: () => now,
    invoke: (channel, request, owner = 1) => channels.get(channel)({ sender: { id: owner } }, request) };
}
const open = (f, trace = traceContext) => f.invoke('data-platform:openProject', { projectId: 'p1', ...(trace ? { trace } : {}) });
const read = (f, openId = ID, owner = 1) => f.invoke('data-platform:getProjectOpenTrace', { openId }, owner);

test('真实main/API函数传同ID、四阶段实际await及独立IPC包络；晚getter不扩大service耗时', async () => {
  const f = fixture(), result = await open(f);
  assert.equal(result.source, 'package'); assert.equal(result.trace.openId, ID); assert.equal(result.trace.status, 'active');
  assert.equal(result.traceIpc.openId, ID); assert.equal(result.traceIpc.operation, 'openProject'); assert.equal(result.traceIpc.outcome, 'ok');
  const trace = read(f), download = trace.spans.find(span => span.stage === 'sourceDownload');
  const extracted = trace.spans.find(span => span.stage === 'sourceExtractValidate'), materialized = trace.spans.find(span => span.stage === 'projectMaterialize');
  assert.equal(download.startMs, f.timing.download.start); assert.equal(download.endMs, f.timing.download.end);
  assert.equal(extracted.startMs, f.timing.extract.start); assert.equal(extracted.endMs, f.timing.detect.end);
  assert.equal(materialized.startMs, f.timing.materialize.start); assert.ok(materialized.endMs > f.timing.materialize.end);
  const bridge = trace.spans.find(span => span.kind === 'bridge');
  assert.equal(bridge.startMs, result.traceIpc.receivedMs); assert.equal(bridge.endMs, result.traceIpc.returnedMs);
  assert.equal(bridge.durationMs, result.traceIpc.returnedMs - result.traceIpc.receivedMs);
  assert.equal(trace.recording.phaseCoverageComplete, true); assert.equal(trace.root.ended, false, '后续resource IPC仍需原上下文');
  f.advance(10000); const later = read(f); assert.equal(later.spans.find(span => span.kind === 'bridge').durationMs, bridge.durationMs);
  assert.ok(later.sampledAtMs > result.traceIpc.returnedMs); assert.doesNotMatch(JSON.stringify(later), /fixture\.invalid|private|token=business/);
});

test('旧caller省略trace保持原结果键/调用，malformed trace不改变业务返回或trusted-project门', async () => {
  const f = fixture(), legacy = await open(f, null);
  assert.equal(Object.hasOwn(legacy, 'trace'), false); assert.equal(Object.hasOwn(legacy, 'traceIpc'), false);
  const invalid = await open(f, { version: 1, openId: 'https://secret', detail: 'assets' });
  assert.equal(Object.hasOwn(invalid, 'trace'), false); assert.deepEqual(Object.keys(invalid).sort(), Object.keys(legacy).sort());
  const denied = fixture(); await assert.rejects(denied.invoke('data-platform:openProject', { projectId: 'untrusted', trace: traceContext }), /只能打开最近一次/);
  assert.equal(denied.calls.includes('download'), false); assert.equal(read(denied).status, 'failed');
});

test('无SOURCE真实分支明确skip2/3，物化/激活仍有真实phase4，不冒充本地旧包复用', async () => {
  const f = fixture({ generated: true }), result = await open(f), trace = read(f);
  assert.equal(result.source, 'generated'); assert.equal(result.sceneFilePath, null); assert.equal(f.calls.includes('download'), false);
  for (const phase of ['sourceDownload', 'sourceExtractValidate']) { const row = trace.spans.find(span => span.stage === phase); assert.equal(row.status, 'skipped'); assert.equal(row.code, 'no-source-package'); }
  assert.equal(trace.spans.find(span => span.stage === 'projectMaterialize').status, 'ok'); assert.equal(trace.recording.phaseCoverageComplete, true);
});

test('下载/解包/检测/物化失败保留原错误及对应阶段，失败getter仍有固定bridge边界', async () => {
  for (const [option, stage] of [['downloadError', 'sourceDownload'], ['extractError', 'sourceExtractValidate'], ['materializeError', 'projectMaterialize']]) {
    const original = new Error('original-' + option), f = fixture({ [option]: original });
    await assert.rejects(open(f), error => error === original);
    const trace = read(f), row = trace.spans.find(span => span.stage === stage), bridge = trace.spans.find(span => span.kind === 'bridge');
    assert.equal(row.status, 'error'); assert.equal(trace.status, 'failed'); assert.equal(bridge.ended, true); assert.equal(bridge.status, 'error');
    const elapsed = bridge.durationMs; f.advance(5000); assert.equal(read(f).spans.find(span => span.kind === 'bridge').durationMs, elapsed);
  }
  const rejected = fixture({ invalidPackage: true }); await assert.rejects(open(rejected), /fixture-rejected/);
  assert.equal(read(rejected).spans.find(span => span.stage === 'sourceExtractValidate').status, 'error');
  assert.equal(rejected.calls.includes('materialize'), false);
});

test('同sender resource入口关联原ID与新parent，其他sender只读/附加trace均不能借owner', async () => {
  const f = fixture(); await open(f);
  const request = { mode: 'data-platform-latest', requestId: 'resource-1', sceneContent: '{"unchanged":true}',
    trace: { ...traceContext, parentSpanId: 'renderer:2' } };
  const result = await f.invoke('data-platform:prepareLocalSceneResources', request);
  assert.equal(f.resources[0] === request, true); assert.equal(result.trace.openId, ID); assert.equal(result.traceIpc.operation, 'sceneResources');
  const bridge = read(f).spans.find(span => span.ipcOperation === 'sceneResources'); assert.equal(bridge.parent.spanId, 'renderer:2');
  assert.equal(bridge.parent.openId, ID); assert.equal(bridge.durationMs, 18);
  assert.equal(read(f, ID, 2), null); assert.equal(read(f, OTHER), null);
  const other = await f.invoke('data-platform:prepareLocalSceneResources', request, 2); assert.equal(Object.hasOwn(other, 'trace'), false);
  assert.equal(read(f).spans.filter(span => span.ipcOperation === 'sceneResources').length, 1);
});

test('实际取消沿原AbortController收束，不复用/覆盖旧ID，原business AbortError保持', async () => {
  const f = fixture({ pending: true }), running = open(f); await f.enteredDownload;
  assert.equal(f.invoke('data-platform:cancelProjectLoading'), true);
  await assert.rejects(running, error => error?.name === 'AbortError');
  const trace = read(f); assert.equal(trace.status, 'cancelled'); assert.equal(trace.recording.activeSpans, 0);
  assert.equal(trace.spans.find(span => span.stage === 'sourceDownload').status, 'cancelled');
  assert.equal(trace.spans.find(span => span.kind === 'bridge').status, 'cancelled');
});

test('诊断begin/snapshot故障不改变成功值或原下载错误', async () => {
  for (const failure of [false, true]) {
    const original = new Error('business-failure'), f = fixture({ ...(failure ? { downloadError: original } : {}) });
    const start = f.scope.projectOpenTraces.start.bind(f.scope.projectOpenTraces);
    f.scope.projectOpenTraces.start = (...args) => { const recorder = start(...args); recorder.beginPhase = () => { throw new Error('diagnostic-begin'); };
      recorder.snapshot = () => { throw new Error('diagnostic-snapshot'); }; return recorder; };
    if (failure) await assert.rejects(open(f), error => error === original);
    else { const result = await open(f); assert.equal(result.source, 'package'); assert.equal(Object.hasOwn(result, 'trace'), false); }
  }
});

test('preload真实两个arrow按原通道转发同一request，getter只读按owner请求不附带路径', async () => {
  const text = await readFile(new URL('../../electron/preload.ts', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('preload.ts', text, ts.ScriptTarget.Latest, true), arrows = new Map();
  const visit = node => { if (ts.isPropertyAssignment(node) && ['openDataPlatformProject', 'getProjectOpenTrace'].includes(node.name.getText(ast))) arrows.set(node.name.getText(ast), node.initializer.getText(ast)); ts.forEachChild(node, visit); }; visit(ast);
  const requests = [], sandbox = { ipcRenderer: { invoke: (...args) => { requests.push(args); return Promise.resolve(null); } } };
  for (const [name, arrow] of arrows) runInNewContext(ts.transpileModule('globalThis.' + name + '=' + arrow, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, sandbox);
  const request = { projectId: 'p1', trace: traceContext }; await sandbox.openDataPlatformProject(request); await sandbox.getProjectOpenTrace({ openId: ID });
  assert.equal(requests[0][0], 'data-platform:openProject'); assert.equal(requests[0][1] === request, true);
  assert.equal(requests[1][0], 'data-platform:getProjectOpenTrace'); assert.deepEqual(Object.keys(requests[1][1]), ['openId']);
});
