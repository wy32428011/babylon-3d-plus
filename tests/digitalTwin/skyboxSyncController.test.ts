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

function completed(runId: string) {
  return { runId, phase: 'completed', completed: 1, total: 1, message: 'done', error: null };
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
  controller.receiveProgress(invalidPayloads[0]);
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

  controller.setContext({ readOnly: false, sceneId: scene.id });
  const firstStart = controller.start();
  const secondStart = controller.start();
  assert.equal(startCalls, 1);
  assert.equal(await secondStart, false);
  resolveStart(true);
  assert.equal(await firstStart, true);

  controller.receiveProgress({ runId: 'failed-run', phase: 'failed', completed: 0, total: 0, message: 'failed', error: 'failed' });
  const firstRetry = controller.retry();
  const secondRetry = controller.retry();
  assert.equal(await firstRetry, false);
  assert.equal(await secondRetry, false);
  assert.equal(retryCalls, 1);

  controller.setContext({ readOnly: true, sceneId: scene.id });
  controller.receiveProgress(completed('run-complete'));
  await flushPromises();
  assert.equal(applyCalls, 0);
  assert.equal(controller.getState().pendingRunId, 'run-complete');
  assert.equal(JSON.stringify(scene), persisted);

  controller.setContext({ readOnly: false, sceneId: scene.id });
  assert.equal(applyCalls, 1);
  assert.equal(history.undoStack.length, 1);
  assert.notEqual(JSON.stringify(scene), persisted);
  assert.equal(controller.getState().pendingRunId, null);

  controller.setContext({ readOnly: false, sceneId: 'another-scene' });
  assert.equal(applyCalls, 1);

  const undone = historyModule.undoCommand(scene, history);
  scene = undone.scene;
  history = undone.history;
  assert.equal(JSON.stringify(scene), persisted);
  assert.equal(history.undoStack.length, 0);
});

test('guard blocked 不消费 completed；scene identity 变化后补一次稳定 ID 重关联', async () => {
  let attempts = 0;
  const controller = controllerModule.createSkyboxSyncController({
    startSync: async () => true,
    retrySync: async () => true,
    reloadAssets: async () => [createAsset()],
    applyAssets: (_assets, sceneId) => {
      attempts += 1;
      return sceneId === 'scene-b' ? 'applied' : 'blocked';
    },
  });
  controller.setContext({ readOnly: false, sceneId: 'scene-a' });
  controller.receiveProgress(completed('run-switch'));
  await flushPromises();
  assert.equal(attempts, 1);
  assert.equal(controller.getState().pendingRunId, 'run-switch');

  controller.setContext({ readOnly: false, sceneId: 'scene-b' });
  assert.equal(attempts, 2);
  assert.equal(controller.getState().pendingRunId, null);
  controller.setContext({ readOnly: false, sceneId: 'scene-c' });
  assert.equal(attempts, 2);
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
  controller.setContext({ readOnly: false, sceneId: 'scene-a' });
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
  controller.setContext({ readOnly: false, sceneId: 'scene-a' });
  controller.receiveProgress({ runId: 'run-throttle', phase: 'downloading', completed: 1, total: 3, message: '1', error: null });
  controller.receiveProgress({ runId: 'run-throttle', phase: 'downloading', completed: 2, total: 3, message: '2', error: null });
  assert.equal(controller.getState().progress, null);
  scheduler.flush();
  assert.equal(controller.getState().progress?.completed, 2);
  assert.deepEqual(logs, ['run-throttle:downloading']);

  controller.receiveProgress({ runId: 'run-throttle', phase: 'validating', completed: 3, total: 3, message: 'valid', error: null });
  controller.receiveProgress(completed('run-throttle'));
  assert.equal(controller.getState().progress?.phase, 'completed');
  assert.deepEqual(logs, ['run-throttle:downloading', 'run-throttle:validating', 'run-throttle:completed']);
  await flushPromises();
});
