import assert from 'node:assert/strict';
import test from 'node:test';

import type { ProjectSkyboxAssetEntry } from '../../src/editor/assets/AssetDatabase.ts';
import type { SceneSkyboxSettings } from '../../src/editor/model/SceneDocument.ts';
import { importIsolatedTypeScriptModules } from '../helpers/extensionlessTypeScriptTestBootstrap.ts';

const [controllerModule, skyboxAssets, historyModule, commandModule, sceneModule] =
  await importIsolatedTypeScriptModules<[
    typeof import('../../src/editor/assets/skyboxSyncController'),
    typeof import('../../src/editor/assets/skyboxAssets'),
    typeof import('../../src/editor/commands/CommandHistory'),
    typeof import('../../src/editor/commands/entityCommands'),
    typeof import('../../src/editor/model/SceneDocument'),
  ]>([
    'src/editor/assets/skyboxSyncController.ts',
    'src/editor/assets/skyboxAssets.ts',
    'src/editor/commands/CommandHistory.ts',
    'src/editor/commands/entityCommands.ts',
    'src/editor/model/SceneDocument.ts',
  ]);

const RESOURCE_ID = '2052912068767571969';
const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

function createAsset(revision = SHA_B): ProjectSkyboxAssetEntry {
  const sourcePath = String.raw`C:\Shared\factory.hdr\factory.hdr`;
  return {
    id: `data-platform-skybox:${RESOURCE_ID}`,
    name: 'factory.hdr',
    displayName: 'factory',
    path: sourcePath,
    sourceUrl: `editor-asset://local/${encodeURIComponent(sourcePath)}`,
    assetRevision: revision,
    packagePath: String.raw`C:\Shared\factory.hdr`,
    kind: 'skybox',
    libraryKind: 'skybox',
    format: 'hdr',
    fileSizeBytes: 1024,
    source: 'data-platform',
    availability: 'active',
    dataPlatformResourceId: RESOURCE_ID,
    dataPlatformRevision: '2',
    fileSha256: revision,
  };
}

function createSettings(revision = SHA_A): SceneSkyboxSettings {
  const sourcePath = String.raw`D:\Old\factory.hdr\factory.hdr`;
  return {
    packagePath: String.raw`D:\Old\factory.hdr`,
    sourcePath,
    sourceUrl: `editor-asset://local/${encodeURIComponent(sourcePath)}`,
    assetRevision: revision,
    dataPlatformResourceId: RESOURCE_ID,
    format: 'hdr',
    rotationDegrees: 45,
    intensity: 1.7,
    resolution: 1024,
  };
}

function completed(runId: string, contextKey = 'project-a') {
  return { runId, contextKey, phase: 'completed', completed: 1, total: 1, message: 'done', error: null };
}

function createManualScheduler() {
  let nextId = 1;
  const tasks = new Map<number, () => void>();
  return {
    schedule(callback: () => void): number {
      const id = nextId++;
      tasks.set(id, callback);
      return id;
    },
    cancel(id: unknown): void {
      tasks.delete(id as number);
    },
    flush(): void {
      const callbacks = [...tasks.values()];
      tasks.clear();
      for (const callback of callbacks) callback();
    },
  };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

test('严格 progress 校验拒绝继承/accessor/非法计数与字段类型，非法状态 never reload', async () => {
  let getterReads = 0;
  const inherited = Object.create({ runId: 'inherited' }) as Record<string, unknown>;
  Object.assign(inherited, { phase: 'completed', completed: 1, total: 1, message: 'done', error: null });
  const accessor = { phase: 'completed', completed: 1, total: 1, message: 'done', error: null } as Record<string, unknown>;
  Object.defineProperty(accessor, 'runId', { get() { getterReads += 1; return 'accessor'; } });
  const invalidPayloads: unknown[] = [
    inherited,
    accessor,
    { runId: '', phase: 'completed', completed: 1, total: 1, message: 'done', error: null },
    { runId: 'x', phase: 'unknown', completed: 1, total: 1, message: 'done', error: null },
    { runId: 'x', phase: 'completed', completed: -1, total: 1, message: 'done', error: null },
    { runId: 'x', phase: 'completed', completed: 2, total: 1, message: 'done', error: null },
    { runId: 'x', phase: 'completed', completed: 0, total: 1, message: 'done', error: null },
    { runId: 'x', phase: 'completed', completed: 1.5, total: 2, message: 'done', error: null },
    { runId: 'x', phase: 'completed', completed: 1, total: 1, message: 7, error: null },
    { runId: 'x', phase: 'completed', completed: 1, total: 1, message: 'done', error: {} },
  ];

  for (const payload of invalidPayloads) {
    const normalized = skyboxAssets.normalizeSkyboxSyncProgress(payload);
    assert.equal(normalized.valid, false);
    assert.equal(normalized.progress.phase, 'failed');
    assert.equal(normalized.shouldReloadProjectAssets, false);
  }
  assert.equal(getterReads, 0);

  let reloads = 0;
  const controller = controllerModule.createSkyboxSyncController({
    startSync: async () => true,
    retrySync: async () => true,
    reloadAssets: async () => { reloads += 1; return []; },
    applyAssets: () => 'unchanged',
  });
  for (const payload of invalidPayloads) controller.receiveProgress(payload);
  await flushPromises();
  assert.equal(reloads, 0);
  assert.equal(controller.getState().progress?.phase, 'failed');
});

test('controller 防 double start/retry，readOnly completed 只加载并 pending，恢复后只应用一次且 undo 恢复 dirty', async () => {
  let startCalls = 0;
  let retryCalls = 0;
  let resolveStart!: (value: boolean) => void;
  let scene = sceneModule.createEmptySceneDocument('controller');
  scene = { ...scene, sceneSettings: { ...scene.sceneSettings, skybox: createSettings() } };
  const persisted = JSON.stringify(scene);
  let history = historyModule.createCommandHistory();
  let applyCalls = 0;
  const asset = createAsset();

  const controller = controllerModule.createSkyboxSyncController({
    startSync: () => { startCalls += 1; return new Promise<boolean>((resolve) => { resolveStart = resolve; }); },
    retrySync: async () => { retryCalls += 1; return false; },
    reloadAssets: async () => [asset],
    applyAssets: (assets) => {
      applyCalls += 1;
      const current = scene.sceneSettings.skybox;
      if (!current) return 'not-found';
      const matched = skyboxAssets.findSkyboxAssetForSettings(current, assets);
      if (!matched) return 'not-found';
      const next = skyboxAssets.createSceneSkyboxFromAsset(matched, current);
      if (JSON.stringify(next) === JSON.stringify(current)) return 'unchanged';
      const command = commandModule.updateSceneDocumentCommand('同步天空盒', (document) => ({
        ...document,
        sceneSettings: { ...document.sceneSettings, skybox: next },
      }));
      const result = historyModule.executeCommand(scene, history, command);
      scene = result.scene;
      history = result.history;
      return 'applied';
    },
  });

  controller.setContext({ readOnly: false, sceneId: scene.id, contextKey: 'session-main', syncContextKey: 'project-main' });
  const firstStart = controller.start();
  const secondStart = controller.start();
  assert.equal(startCalls, 1);
  assert.equal(await secondStart, false);
  resolveStart(true);
  assert.equal(await firstStart, true);

  controller.receiveProgress({
    runId: 'failed-run',
    contextKey: 'project-main',
    phase: 'failed',
    completed: 0,
    total: 0,
    message: 'failed',
    error: 'failed',
  });
  const firstRetry = controller.retry();
  const secondRetry = controller.retry();
  assert.equal(await firstRetry, false);
  assert.equal(await secondRetry, false);
  assert.equal(retryCalls, 1);

  controller.setContext({ readOnly: true, sceneId: scene.id, contextKey: 'session-main', syncContextKey: 'project-main' });
  controller.receiveProgress(completed('run-complete', 'project-main'));
  await flushPromises();
  assert.equal(applyCalls, 0);
  assert.equal(controller.getState().pendingRunId, 'run-complete');
  assert.equal(JSON.stringify(scene), persisted);

  controller.setContext({ readOnly: false, sceneId: scene.id, contextKey: 'session-main', syncContextKey: 'project-main' });
  assert.equal(applyCalls, 1);
  assert.equal(history.undoStack.length, 1);
  assert.notEqual(JSON.stringify(scene), persisted);
  assert.equal(controller.getState().pendingRunId, null);

  controller.setContext({ readOnly: false, sceneId: 'another-scene', contextKey: 'session-other', syncContextKey: 'project-other' });
  assert.equal(applyCalls, 1);

  const undone = historyModule.undoCommand(scene, history);
  scene = undone.scene;
  history = undone.history;
  assert.equal(JSON.stringify(scene), persisted);
  assert.equal(history.undoStack.length, 0);
});

test('guard blocked 不消费 completed；切换场景会丢弃旧 session pending，禁止跨项目重关联', async () => {
  let attempts = 0;
  const controller = controllerModule.createSkyboxSyncController({
    startSync: async () => true,
    retrySync: async () => true,
    reloadAssets: async () => [createAsset()],
    applyAssets: () => {
      attempts += 1;
      return 'blocked';
    },
  });
  controller.setContext({ readOnly: false, sceneId: 'shared-scene', contextKey: 'project-a-session', syncContextKey: 'project-a' });
  controller.receiveProgress(completed('run-switch'));
  await flushPromises();
  assert.equal(attempts, 1);
  assert.equal(controller.getState().pendingRunId, 'run-switch');

  controller.setContext({ readOnly: false, sceneId: 'shared-scene', contextKey: 'project-b-session', syncContextKey: 'project-b' });
  assert.equal(attempts, 1);
  assert.equal(controller.getState().pendingRunId, null);
  assert.equal(controller.getState().progress, null);
});

test('旧 session 已观察到的 run 迟到 completed 不得绑定新场景', async () => {
  let reloadCalls = 0;
  let applyCalls = 0;
  const controller = controllerModule.createSkyboxSyncController({
    startSync: async () => true,
    retrySync: async () => true,
    reloadAssets: async () => { reloadCalls += 1; return [createAsset()]; },
    applyAssets: () => { applyCalls += 1; return 'applied'; },
  });
  controller.setContext({ readOnly: false, sceneId: 'scene-a', contextKey: 'project-a-session', syncContextKey: 'project-a' });
  controller.receiveProgress({
    runId: 'run-late',
    contextKey: 'project-a',
    phase: 'downloading',
    completed: 0,
    total: 1,
    message: 'downloading',
    error: null,
  });

  controller.setContext({ readOnly: false, sceneId: 'scene-b', contextKey: 'project-b-session', syncContextKey: 'project-b' });
  controller.receiveProgress(completed('run-late', 'project-a'));
  await flushPromises();

  assert.equal(reloadCalls, 0);
  assert.equal(applyCalls, 0);
  assert.equal(controller.getState().progress, null);
});

test('场景 session 切换使在途资源重载和旧 start 结果失效', async () => {
  const reload = createDeferred<ProjectSkyboxAssetEntry[]>();
  const start = createDeferred<boolean>();
  let applyCalls = 0;
  const controller = controllerModule.createSkyboxSyncController({
    startSync: () => start.promise,
    retrySync: async () => true,
    reloadAssets: () => reload.promise,
    applyAssets: () => { applyCalls += 1; return 'applied'; },
  });
  controller.setContext({ readOnly: false, sceneId: 'shared-scene', contextKey: 'project-a-session', syncContextKey: 'project-a' });
  const startResult = controller.start();
  controller.receiveProgress(completed('run-a'));

  controller.setContext({ readOnly: false, sceneId: 'shared-scene', contextKey: 'project-b-session', syncContextKey: 'project-b' });
  start.resolve(false);
  reload.resolve([createAsset()]);
  await flushPromises();

  assert.equal(await startResult, false);
  assert.equal(applyCalls, 0);
  assert.equal(controller.getState().pendingRunId, null);
  assert.equal(controller.getState().progress, null);
  assert.equal(controller.getState().starting, false);
  assert.equal(controller.getState().reloadingAssets, false);
});

test('run A 重载期间收到 run B completed 时，结束后串行处理最新 pending run', async () => {
  const reloadA = createDeferred<ProjectSkyboxAssetEntry[]>();
  const reloadB = createDeferred<ProjectSkyboxAssetEntry[]>();
  const appliedRevisions: string[] = [];
  let reloadCalls = 0;
  const controller = controllerModule.createSkyboxSyncController({
    startSync: async () => true,
    retrySync: async () => true,
    reloadAssets: () => {
      reloadCalls += 1;
      return reloadCalls === 1 ? reloadA.promise : reloadB.promise;
    },
    applyAssets: (assets) => {
      appliedRevisions.push(assets[0]?.assetRevision ?? 'missing');
      return 'unchanged';
    },
  });
  controller.setContext({ readOnly: false, sceneId: 'scene-a', contextKey: 'session-a', syncContextKey: 'project-a' });

  controller.receiveProgress(completed('run-a'));
  assert.equal(reloadCalls, 1);
  controller.receiveProgress(completed('run-b'));
  assert.equal(reloadCalls, 1, 'run B 必须等待 run A 的资源重载释放。');
  assert.equal(controller.getState().pendingRunId, 'run-b');

  reloadA.resolve([createAsset(SHA_A)]);
  await flushPromises();
  assert.equal(reloadCalls, 2, 'run A 结束后必须自动 drain 最新 pending run B。');
  assert.deepEqual(appliedRevisions, [], '过期 run A 的资源不得应用到场景。');

  reloadB.resolve([createAsset(SHA_B)]);
  await flushPromises();
  assert.deepEqual(appliedRevisions, [SHA_B]);
  assert.equal(controller.getState().pendingRunId, null);
  assert.equal(controller.getState().progress?.runId, 'run-b');
  assert.equal(controller.getState().progress?.phase, 'completed');
});

test('资源列表加载失败转 renderer failed，可重新加载并仅在成功处理后自动关闭', async () => {
  const scheduler = createManualScheduler();
  let reloads = 0;
  const controller = controllerModule.createSkyboxSyncController({
    startSync: async () => true,
    retrySync: async () => true,
    reloadAssets: async () => {
      reloads += 1;
      if (reloads === 1) throw new Error('list failed');
      return [createAsset()];
    },
    applyAssets: () => 'unchanged',
    schedule: (callback) => scheduler.schedule(callback),
    cancelSchedule: (id) => scheduler.cancel(id),
  });
  controller.setContext({ readOnly: false, sceneId: 'scene-a', contextKey: 'session-a', syncContextKey: 'project-a' });
  controller.receiveProgress(completed('run-reload'));
  await flushPromises();
  assert.equal(controller.getState().progress?.phase, 'failed');
  assert.match(controller.getState().reloadError ?? '', /list failed/);
  assert.equal(controller.getState().pendingRunId, 'run-reload');

  assert.equal(await controller.retryAssetReload(), true);
  assert.equal(reloads, 2);
  assert.equal(controller.getState().reloadError, null);
  assert.equal(controller.getState().progress?.phase, 'completed');
  scheduler.flush();
  assert.equal(controller.getState().progress, null);
});

test('进度更新 225ms 节流，日志只记录阶段切换且 completed 立即提交', async () => {
  const scheduler = createManualScheduler();
  const states: Array<string | null> = [];
  const logs: string[] = [];
  const controller = controllerModule.createSkyboxSyncController({
    startSync: async () => true,
    retrySync: async () => true,
    reloadAssets: async () => [],
    applyAssets: () => 'unchanged',
    onStateChange: (state) => states.push(state.progress ? `${state.progress.phase}:${state.progress.completed}` : null),
    onProgressLog: (progress) => logs.push(`${progress.runId}:${progress.phase}`),
    schedule: (callback) => scheduler.schedule(callback),
    cancelSchedule: (id) => scheduler.cancel(id),
    progressThrottleMs: 225,
  });
  controller.setContext({ readOnly: false, sceneId: 'scene-a', contextKey: 'session-a', syncContextKey: 'project-a' });
  controller.receiveProgress({ runId: 'run-throttle', contextKey: 'project-a', phase: 'downloading', completed: 1, total: 3, message: '1', error: null });
  controller.receiveProgress({ runId: 'run-throttle', contextKey: 'project-a', phase: 'downloading', completed: 2, total: 3, message: '2', error: null });
  assert.equal(controller.getState().progress, null);
  scheduler.flush();
  assert.equal(controller.getState().progress?.completed, 2);
  assert.deepEqual(logs, ['run-throttle:downloading']);

  controller.receiveProgress({ runId: 'run-throttle', contextKey: 'project-a', phase: 'validating', completed: 3, total: 3, message: 'valid', error: null });
  controller.receiveProgress(completed('run-throttle'));
  assert.equal(controller.getState().progress?.phase, 'completed');
  assert.deepEqual(logs, ['run-throttle:downloading', 'run-throttle:validating', 'run-throttle:completed']);
  await flushPromises();
});
