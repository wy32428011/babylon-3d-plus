import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { createServer } from 'vite';
import type { AbstractEngine, Camera } from '@babylonjs/core';
import { createSceneCameraPose } from '../../src/editor/model/autoPatrolInspection.ts';
import type {
  AutoPatrolInspectionEvent,
  AutoPatrolInspectionRecord,
  AutoPatrolInspectionTrajectorySample,
} from '../../src/runtime/babylon/AutoPatrolPlaybackController.ts';
import {
  AutoPatrolInspectionRecordStore,
  MemoryAutoPatrolInspectionBackend,
} from '../../src/runtime/patrol/AutoPatrolInspectionRecordStore.ts';

const viteServer = await createServer({
  appType: 'custom',
  configFile: false,
  root: process.cwd(),
  server: { middlewareMode: true, hmr: false },
  optimizeDeps: { noDiscovery: true },
});
const { AutoPatrolRuntimeIntegration } = await viteServer.ssrLoadModule(
  '/src/runtime/patrol/AutoPatrolRuntimeIntegration.ts',
) as typeof import('../../src/runtime/patrol/AutoPatrolRuntimeIntegration.ts');

after(async () => {
  await viteServer.close();
});

test('异步截图始终写回事件触发时的巡检任务', async () => {
  const backend = new MemoryAutoPatrolInspectionBackend();
  const recordStore = new AutoPatrolInspectionRecordStore({ backend });
  let context = { taskId: 'task-a', routeId: 'route-a', routeName: '路线 A' };
  const integration = new AutoPatrolRuntimeIntegration({
    engine: {} as AbstractEngine,
    getCamera: () => null,
    getInspectionContext: () => context,
    setHighlightedEntityIds: () => undefined,
    recordStore,
  });
  const event: AutoPatrolInspectionEvent = {
    occurrenceId: 'occurrence-a',
    eventId: 'event-a',
    name: '任务 A 截图',
    anomaly: false,
    triggeredAt: 1_000,
    elapsedMs: 200,
    trigger: { kind: 'manual' },
    responses: ['screenshot'],
    targetEntityId: null,
    position: { x: 1, y: 2, z: 3 },
    businessData: {},
  };

  integration.onInspectionEvent(event);
  context = { taskId: 'task-b', routeId: 'route-b', routeName: '路线 B' };
  await integration.onInspectionScreenshot(event, {
    occurrenceId: event.occurrenceId,
    capturedAt: 1_050,
    dataUrl: 'data:image/png;base64,task-a',
  });

  const taskA = await recordStore.getRecord('task-a');
  assert.equal(taskA?.events[0]?.screenshot?.localUrl, 'data:image/png;base64,task-a');
  assert.equal(await recordStore.getRecord('task-b'), null);

  integration.dispose();
  recordStore.dispose();
});

test('巡检运行期间会在结束前增量持久化任务和轨迹', async () => {
  const backend = new MemoryAutoPatrolInspectionBackend();
  const recordStore = new AutoPatrolInspectionRecordStore({ backend });
  const integration = new AutoPatrolRuntimeIntegration({
    engine: {} as AbstractEngine,
    getCamera: () => null,
    getInspectionContext: () => ({ taskId: null, routeId: null, routeName: null }),
    setHighlightedEntityIds: () => undefined,
    recordStore,
  });
  const startedRecord: AutoPatrolInspectionRecord = {
    taskId: 'task-live',
    routeId: 'route-live',
    routeName: '运行中路线',
    startedAt: 1_000,
    endedAt: null,
    durationMs: 0,
    status: 'running',
    trajectory: [],
    events: [],
    screenshots: [],
  };
  const samples: AutoPatrolInspectionTrajectorySample[] = [{
    elapsedMs: 500,
    capturedAt: 1_500,
    pose: createSceneCameraPose({ x: 1, y: 1.7, z: 2 }, { x: 1, y: 1.7, z: 3 }),
    phase: 'moving',
    waypointIndex: 0,
    viewMode: 'first-person',
  }];

  await integration.onInspectionStart(startedRecord);
  await integration.onInspectionTrajectory(startedRecord.taskId, samples);

  const stored = await recordStore.getRecord(startedRecord.taskId);
  assert.equal(stored?.status, 'running');
  assert.deepEqual(stored?.trajectory.map((sample) => sample.recordedAtMs), [1_500]);

  integration.dispose();
  recordStore.dispose();
});

test('增量详情达到资源上限后最终记录仍会完成收尾', async () => {
  const backend = new MemoryAutoPatrolInspectionBackend();
  const recordStore = new AutoPatrolInspectionRecordStore({
    backend,
    limits: { maxTrajectorySamples: 1 },
  });
  const integration = new AutoPatrolRuntimeIntegration({
    engine: {} as AbstractEngine,
    getCamera: () => null,
    getInspectionContext: () => ({ taskId: null, routeId: null, routeName: null }),
    setHighlightedEntityIds: () => undefined,
    recordStore,
  });
  const startedRecord: AutoPatrolInspectionRecord = {
    taskId: 'task-bounded-finalize',
    routeId: 'route-bounded-finalize',
    routeName: '资源上限路线',
    startedAt: 1_000,
    endedAt: null,
    durationMs: 0,
    status: 'running',
    trajectory: [],
    events: [],
    screenshots: [],
  };
  const firstSample: AutoPatrolInspectionTrajectorySample = {
    elapsedMs: 500,
    capturedAt: 1_500,
    pose: createSceneCameraPose({ x: 1, y: 1.7, z: 2 }, { x: 1, y: 1.7, z: 3 }),
    phase: 'moving',
    waypointIndex: 0,
    viewMode: 'first-person',
  };
  const rejectedSample: AutoPatrolInspectionTrajectorySample = {
    ...firstSample,
    elapsedMs: 1_000,
    capturedAt: 2_000,
    pose: createSceneCameraPose({ x: 2, y: 1.7, z: 2 }, { x: 2, y: 1.7, z: 3 }),
  };

  await integration.onInspectionStart(startedRecord);
  await integration.onInspectionTrajectory(startedRecord.taskId, [firstSample]);
  await assert.rejects(
    integration.onInspectionTrajectory(startedRecord.taskId, [rejectedSample]),
    /轨迹.*上限/,
  );
  await assert.rejects(integration.onInspectionRecord({
    ...startedRecord,
    endedAt: 2_500,
    durationMs: 1_500,
    status: 'stopped',
    trajectory: [firstSample, rejectedSample],
  }), /轨迹.*上限/);

  const stored = await recordStore.getRecord(startedRecord.taskId);
  assert.equal(stored?.status, 'stopped');
  assert.equal(stored?.endedAtMs, 2_500);
  assert.deepEqual(stored?.trajectory.map((sample) => sample.recordedAtMs), [1_500]);

  integration.dispose();
  recordStore.dispose();
});

test('底层截图超时后不会永久阻塞后续调用或并发堆积采集', async () => {
  const recordStore = new AutoPatrolInspectionRecordStore({
    backend: new MemoryAutoPatrolInspectionBackend(),
  });
  let captureCount = 0;
  let resolveFirstCapture!: (dataUrl: string) => void;
  const firstCapture = new Promise<string>((resolve) => { resolveFirstCapture = resolve; });
  const integration = new AutoPatrolRuntimeIntegration({
    engine: {} as AbstractEngine,
    getCamera: () => ({}) as Camera,
    getInspectionContext: () => ({ taskId: null, routeId: null, routeName: null }),
    setHighlightedEntityIds: () => undefined,
    recordStore,
    screenshotCaptureTimeoutMs: 10,
    createScreenshot: async () => {
      captureCount += 1;
      return captureCount === 1
        ? firstCapture
        : 'data:image/png;base64,recovered';
    },
  });

  await assert.rejects(integration.captureScreenshot(), /截图.*超时/);
  const skippedWhileNativeCaptureIsPending = await Promise.race([
    integration.captureScreenshot(),
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('后续截图仍被悬挂队列阻塞')), 50)),
  ]);
  assert.equal(skippedWhileNativeCaptureIsPending, null);
  assert.equal(captureCount, 1);

  resolveFirstCapture('data:image/png;base64,late');
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(await integration.captureScreenshot(), 'data:image/png;base64,recovered');
  assert.equal(captureCount, 2);

  integration.dispose();
  recordStore.dispose();
});

test('Integration 在回调边界固定场景作用域，不受随后切换影响', async () => {
  const backend = new MemoryAutoPatrolInspectionBackend();
  const recordStore = new AutoPatrolInspectionRecordStore({ backend, scopeId: 'scene-a' });
  const integration = new AutoPatrolRuntimeIntegration({
    engine: {} as AbstractEngine,
    getCamera: () => null,
    getInspectionContext: () => ({ taskId: null, routeId: null, routeName: null }),
    setHighlightedEntityIds: () => undefined,
    recordStore,
  });
  const startedRecord: AutoPatrolInspectionRecord = {
    taskId: 'scope-race',
    routeId: 'route-a',
    routeName: '场景 A 路线',
    startedAt: 1_000,
    endedAt: null,
    durationMs: 0,
    status: 'running',
    trajectory: [],
    events: [],
    screenshots: [],
  };

  const pendingStart = integration.onInspectionStart(startedRecord);
  recordStore.setScope('scene-b');
  await pendingStart;

  assert.equal(await recordStore.getRecord('scope-race'), null);
  recordStore.setScope('scene-a');
  assert.equal((await recordStore.getRecord('scope-race'))?.scopeId, 'scene-a');
  integration.dispose();
  recordStore.dispose();
});
