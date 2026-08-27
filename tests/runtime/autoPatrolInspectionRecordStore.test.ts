import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AutoPatrolInspectionRecordStore,
  MemoryAutoPatrolInspectionBackend,
  type AutoPatrolInspectionReporter,
} from '../../src/runtime/patrol/AutoPatrolInspectionRecordStore.ts';

const POSITION = { x: 1, y: 2, z: 3 };

test('巡检记录完整保存轨迹、事件、截图和异常汇总', async () => {
  const backend = new MemoryAutoPatrolInspectionBackend();
  const reports: string[] = [];
  const reporter: AutoPatrolInspectionReporter = {
    reportEvent: async (_record, event) => { reports.push(`event:${event.id}`); },
    reportRecord: async (record) => { reports.push(`record:${record.taskId}`); },
  };
  const store = new AutoPatrolInspectionRecordStore({
    backend,
    reporter,
    idFactory: (() => {
      let index = 0;
      return () => `generated-${++index}`;
    })(),
    now: () => 1_000,
  });

  const record = await store.startInspection({
    taskId: 'task-1',
    routeId: 'route-1',
    routeName: '厂区巡检',
    operator: 'operator-1',
    startedAtMs: 100,
  });
  assert.equal(record.status, 'running');

  await store.appendTrajectory('task-1', {
    recordedAtMs: 500,
    position: POSITION,
    rotation: { x: 0.1, y: 0.2, z: 0.3 },
  });
  await store.appendEvent('task-1', {
    id: 'event-1',
    eventDefinitionId: 'temperature-high',
    name: '温度异常',
    trigger: 'region-enter',
    occurredAtMs: 800,
    targetEntityId: 'machine-1',
    position: POSITION,
    businessData: { temperature: 86 },
    anomaly: true,
    screenshot: {
      id: 'screenshot-1',
      capturedAtMs: 810,
      localUrl: 'data:image/png;base64,inspection-1',
      remoteUrl: null,
    },
  });
  await store.completeInspection('task-1', { status: 'completed', endedAtMs: 1_100 });
  await store.flushOutbox({ force: true });

  const saved = await store.getRecord('task-1');
  assert.ok(saved);
  assert.equal(saved.status, 'completed');
  assert.equal(saved.durationMs, 1_000);
  assert.equal(saved.trajectory.length, 1);
  assert.equal(saved.events.length, 1);
  assert.equal(saved.screenshots.length, 1);
  assert.deepEqual(saved.anomalyEventIds, ['event-1']);
  assert.deepEqual(reports, ['event:event-1', 'record:task-1']);
  assert.deepEqual(await backend.listOutbox(), []);
});

test('网络失败时保留 Outbox，恢复后按事件再全量记录的顺序补报', async () => {
  const backend = new MemoryAutoPatrolInspectionBackend();
  let online = false;
  const reports: string[] = [];
  const reporter: AutoPatrolInspectionReporter = {
    reportEvent: async (_record, event) => {
      if (!online) throw new Error('offline');
      reports.push(`event:${event.id}`);
    },
    reportRecord: async (record) => {
      if (!online) throw new Error('offline');
      reports.push(`record:${record.taskId}`);
    },
  };
  const store = new AutoPatrolInspectionRecordStore({ backend, reporter, now: () => 5_000 });

  await store.startInspection({ taskId: 'task-offline', routeId: 'route-1', startedAtMs: 1_000 });
  await store.appendEvent('task-offline', {
    id: 'event-offline',
    eventDefinitionId: 'alarm',
    name: '离线告警',
    trigger: 'distance',
    occurredAtMs: 2_000,
    targetEntityId: null,
    position: POSITION,
    businessData: {},
    anomaly: true,
  });
  await store.completeInspection('task-offline', { status: 'completed', endedAtMs: 3_000 });
  await store.flushOutbox({ force: true });

  const pending = await backend.listOutbox();
  assert.equal(pending.length, 2);
  assert.ok(pending[0].attempts >= 1);
  assert.match(pending[0].lastError ?? '', /offline/);
  assert.deepEqual(reports, []);

  online = true;
  const result = await store.flushOutbox({ force: true });
  assert.deepEqual(result, { sent: 2, remaining: 0 });
  assert.deepEqual(reports, ['event:event-offline', 'record:task-offline']);
});

test('重复事件和已结束任务不会破坏历史记录', async () => {
  const backend = new MemoryAutoPatrolInspectionBackend();
  const store = new AutoPatrolInspectionRecordStore({ backend, now: () => 10_000 });
  await store.startInspection({ taskId: 'task-idempotent', routeId: 'route-1', startedAtMs: 100 });
  const event = {
    id: 'event-once',
    eventDefinitionId: 'alarm',
    name: '一次事件',
    trigger: 'manual' as const,
    occurredAtMs: 200,
    targetEntityId: null,
    position: POSITION,
    businessData: {},
    anomaly: false,
  };
  await store.appendEvent('task-idempotent', event);
  await store.appendEvent('task-idempotent', event);
  await store.completeInspection('task-idempotent', { status: 'stopped', endedAtMs: 500 });

  await assert.rejects(
    store.appendTrajectory('task-idempotent', {
      recordedAtMs: 600,
      position: POSITION,
      rotation: { x: 0, y: 0, z: 0 },
    }),
    /已经结束/,
  );
  const saved = await store.getRecord('task-idempotent');
  assert.equal(saved?.events.length, 1);
  assert.equal(saved?.status, 'stopped');
});

test('历史列表按开始时间倒序返回且不暴露内部可变引用', async () => {
  const backend = new MemoryAutoPatrolInspectionBackend();
  const store = new AutoPatrolInspectionRecordStore({ backend });
  await store.startInspection({ taskId: 'older', routeId: 'route-1', startedAtMs: 100 });
  await store.startInspection({ taskId: 'newer', routeId: 'route-2', startedAtMs: 200 });

  const records = await store.listRecords();
  assert.deepEqual(records.map((record) => record.taskId), ['newer', 'older']);
  records[0].trajectory.push({
    recordedAtMs: 300,
    position: POSITION,
    rotation: { x: 0, y: 0, z: 0 },
  });
  assert.equal((await store.getRecord('newer'))?.trajectory.length, 0);
});

test('浏览器 online 事件会自动触发断网记录补报', async () => {
  const backend = new MemoryAutoPatrolInspectionBackend();
  let onlineListener: (() => void) | null = null;
  let reported = false;
  let online = false;
  const store = new AutoPatrolInspectionRecordStore({
    backend,
    now: () => 10_000,
    onlineEventSource: {
      addEventListener: (_type, listener) => { onlineListener = listener; },
      removeEventListener: (_type, listener) => {
        if (onlineListener === listener) onlineListener = null;
      },
    },
    reporter: {
      reportEvent: async () => {
        if (!online) throw new Error('offline');
        reported = true;
      },
      reportRecord: async () => undefined,
    },
  });
  await store.startInspection({ taskId: 'task-online', routeId: 'route-1', startedAtMs: 100 });
  await store.appendEvent('task-online', {
    id: 'event-online',
    eventDefinitionId: 'alarm',
    name: '网络恢复测试',
    trigger: 'manual',
    occurredAtMs: 200,
    targetEntityId: null,
    position: POSITION,
    businessData: {},
    anomaly: false,
  });
  assert.equal((await backend.listOutbox()).length, 1);

  online = true;
  assert.ok(onlineListener);
  onlineListener();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(reported, true);
  assert.equal((await backend.listOutbox()).length, 0);

  store.dispose();
  assert.equal(onlineListener, null);
});

test('重新创建 Store 后会自动补报上次会话遗留的 Outbox', async () => {
  const backend = new MemoryAutoPatrolInspectionBackend();
  const previousStore = new AutoPatrolInspectionRecordStore({ backend });
  await previousStore.startInspection({ taskId: 'task-restart', routeId: 'route-1', startedAtMs: 100 });
  await previousStore.appendEvent('task-restart', {
    id: 'event-restart',
    eventDefinitionId: 'alarm',
    name: '重启补报测试',
    trigger: 'manual',
    occurredAtMs: 200,
    targetEntityId: null,
    position: POSITION,
    businessData: {},
    anomaly: false,
  });
  previousStore.dispose();
  assert.equal((await backend.listOutbox()).length, 1);

  let markReported!: () => void;
  const reported = new Promise<void>((resolve) => { markReported = resolve; });
  const resumedStore = new AutoPatrolInspectionRecordStore({
    backend,
    reporter: {
      reportEvent: async () => { markReported(); },
      reportRecord: async () => undefined,
    },
  });

  await Promise.race([
    reported,
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('遗留 Outbox 未自动补报')), 100)),
  ]);
  assert.deepEqual(await backend.listOutbox(), []);
  resumedStore.dispose();
});

test('增量上报缓慢时不阻塞本地事件和后续轨迹写入', async () => {
  const backend = new MemoryAutoPatrolInspectionBackend();
  const neverCompletes = new Promise<void>(() => undefined);
  const store = new AutoPatrolInspectionRecordStore({
    backend,
    reporter: {
      reportEvent: async () => neverCompletes,
      reportRecord: async () => undefined,
    },
  });
  await store.startInspection({ taskId: 'task-slow-report', routeId: 'route-1', startedAtMs: 100 });

  await Promise.race([
    store.appendEvent('task-slow-report', {
      id: 'event-slow',
      eventDefinitionId: 'alarm',
      name: '慢上报',
      trigger: 'manual',
      occurredAtMs: 200,
      targetEntityId: null,
      position: POSITION,
      businessData: {},
      anomaly: false,
    }),
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('本地事件写入被网络阻塞')), 100)),
  ]);
  await store.appendTrajectory('task-slow-report', {
    recordedAtMs: 500,
    position: POSITION,
    rotation: { x: 0, y: 0, z: 0 },
  });

  assert.equal((await store.getRecord('task-slow-report'))?.trajectory.length, 1);
});

test('批量轨迹写入会按时间排序并忽略重复样本', async () => {
  const store = new AutoPatrolInspectionRecordStore({
    backend: new MemoryAutoPatrolInspectionBackend(),
  });
  await store.startInspection({ taskId: 'task-batch', routeId: 'route-1', startedAtMs: 100 });
  await store.appendTrajectoryBatch('task-batch', [
    { recordedAtMs: 600, position: POSITION, rotation: { x: 0, y: 2, z: 0 } },
    { recordedAtMs: 100, position: POSITION, rotation: { x: 0, y: 0, z: 0 } },
    { recordedAtMs: 600, position: POSITION, rotation: { x: 0, y: 3, z: 0 } },
  ]);

  const record = await store.getRecord('task-batch');
  assert.deepEqual(record?.trajectory.map((sample) => sample.recordedAtMs), [100, 600]);
  assert.equal(record?.trajectory[1]?.rotation.y, 2);
});

test('异步截图完成后可补写已存在事件并重新排队上报', async () => {
  const backend = new MemoryAutoPatrolInspectionBackend();
  const store = new AutoPatrolInspectionRecordStore({ backend });
  await store.startInspection({ taskId: 'task-screenshot', routeId: 'route-1', startedAtMs: 100 });
  const event = {
    id: 'event-screenshot',
    eventDefinitionId: 'camera',
    name: '异常截图',
    trigger: 'manual' as const,
    occurredAtMs: 200,
    targetEntityId: null,
    position: POSITION,
    businessData: {},
    anomaly: true,
  };
  await store.appendEvent('task-screenshot', event);
  await store.appendEvent('task-screenshot', {
    ...event,
    screenshot: {
      id: 'event-screenshot',
      capturedAtMs: 250,
      localUrl: 'data:image/png;base64,inspection',
      remoteUrl: null,
    },
  });

  const record = await store.getRecord('task-screenshot');
  assert.equal(record?.events.length, 1);
  assert.equal(record?.events[0]?.screenshot?.localUrl, 'data:image/png;base64,inspection');
  assert.equal(record?.screenshots.length, 1);
  assert.equal((await backend.listOutbox()).length, 1);
});

test('未启用实时上报的事件只写入本地历史，不生成增量 Outbox', async () => {
  const backend = new MemoryAutoPatrolInspectionBackend();
  const store = new AutoPatrolInspectionRecordStore({ backend });
  await store.startInspection({ taskId: 'task-local-only', routeId: 'route-1', startedAtMs: 100 });
  await store.appendEvent('task-local-only', {
    id: 'event-local-only',
    eventDefinitionId: 'local-panel',
    name: '仅本地展示',
    trigger: 'manual',
    occurredAtMs: 200,
    targetEntityId: null,
    position: POSITION,
    businessData: {},
    anomaly: false,
  }, { queueForReport: false });

  assert.equal((await store.getRecord('task-local-only'))?.events.length, 1);
  assert.deepEqual(await backend.listOutbox(), []);
});

test('事件上报期间补写截图不会被旧版本完成回调误删', async () => {
  const backend = new MemoryAutoPatrolInspectionBackend();
  let markReportStarted!: () => void;
  let releaseFirstReport!: () => void;
  const reportStarted = new Promise<void>((resolve) => { markReportStarted = resolve; });
  const firstReportGate = new Promise<void>((resolve) => { releaseFirstReport = resolve; });
  const screenshotStates: boolean[] = [];
  const store = new AutoPatrolInspectionRecordStore({
    backend,
    reporter: {
      reportEvent: async (_record, event) => {
        screenshotStates.push(Boolean(event.screenshot));
        if (screenshotStates.length === 1) {
          markReportStarted();
          await firstReportGate;
        }
      },
      reportRecord: async () => undefined,
    },
  });
  await store.startInspection({ taskId: 'task-inflight-screenshot', routeId: 'route-1', startedAtMs: 100 });
  const event = {
    id: 'event-inflight-screenshot',
    eventDefinitionId: 'camera',
    name: '在途截图',
    trigger: 'manual' as const,
    occurredAtMs: 200,
    targetEntityId: null,
    position: POSITION,
    businessData: {},
    anomaly: false,
  };

  await store.appendEvent('task-inflight-screenshot', event);
  await reportStarted;
  await store.appendEvent('task-inflight-screenshot', {
    ...event,
    screenshot: {
      id: event.id,
      capturedAtMs: 250,
      localUrl: 'data:image/png;base64,inflight',
      remoteUrl: null,
    },
  });
  releaseFirstReport();
  await store.flushOutbox({ force: true });

  assert.deepEqual(screenshotStates, [false, true]);
  assert.deepEqual(await backend.listOutbox(), []);
});

test('持续在线的临时失败会按退避时间自动重试', async () => {
  const backend = new MemoryAutoPatrolInspectionBackend();
  let attempts = 0;
  const store = new AutoPatrolInspectionRecordStore({
    backend,
    reporter: {
      reportEvent: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('temporary failure');
      },
      reportRecord: async () => undefined,
    },
  });
  await store.startInspection({ taskId: 'task-auto-retry', routeId: 'route-1', startedAtMs: 100 });
  await store.appendEvent('task-auto-retry', {
    id: 'event-auto-retry',
    eventDefinitionId: 'alarm',
    name: '自动重试',
    trigger: 'manual',
    occurredAtMs: 200,
    targetEntityId: null,
    position: POSITION,
    businessData: {},
    anomaly: false,
  });

  const deadline = Date.now() + 2_000;
  while (attempts < 2 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  assert.equal(attempts, 2);
  assert.deepEqual(await backend.listOutbox(), []);
  store.dispose();
});

test('不同场景的历史和 Outbox 互相隔离，切回原场景后才补报', async () => {
  const backend = new MemoryAutoPatrolInspectionBackend();
  const scopeAStore = new AutoPatrolInspectionRecordStore({ backend, scopeId: 'scene-a' });
  await scopeAStore.startInspection({ taskId: 'task-scene-a', routeId: 'route-a', startedAtMs: 100 });
  await scopeAStore.appendEvent('task-scene-a', {
    id: 'event-scene-a',
    eventDefinitionId: 'alarm',
    name: 'A 场景事件',
    trigger: 'manual',
    occurredAtMs: 200,
    targetEntityId: null,
    position: POSITION,
    businessData: {},
    anomaly: false,
  });
  scopeAStore.dispose();

  const reportedTaskIds: string[] = [];
  const scopedStore = new AutoPatrolInspectionRecordStore({
    backend,
    scopeId: 'scene-b',
    reporter: {
      reportEvent: async (record) => { reportedTaskIds.push(record.taskId); },
      reportRecord: async (record) => { reportedTaskIds.push(record.taskId); },
    },
  });

  assert.deepEqual(await scopedStore.listRecords(), []);
  assert.equal(await scopedStore.getRecord('task-scene-a'), null);
  assert.deepEqual(await scopedStore.flushOutbox({ force: true }), { sent: 0, remaining: 0 });
  assert.deepEqual(reportedTaskIds, []);
  assert.equal((await backend.listOutbox()).length, 1, '其他场景的待补报数据必须保留');

  scopedStore.setScope('scene-a');
  assert.deepEqual((await scopedStore.listRecords()).map((record) => record.taskId), ['task-scene-a']);
  assert.deepEqual(await scopedStore.flushOutbox({ force: true }), { sent: 1, remaining: 0 });
  assert.deepEqual(reportedTaskIds, ['task-scene-a']);
  scopedStore.dispose();
});

test('场景作用域保持精确值，首尾空格不会与其他场景混淆', async () => {
  const backend = new MemoryAutoPatrolInspectionBackend();
  const sourceStore = new AutoPatrolInspectionRecordStore({ backend, scopeId: 'victim' });
  await sourceStore.startInspection({ taskId: 'scope-exact', routeId: 'route-a', startedAtMs: 100 });
  sourceStore.dispose();

  const spacedStore = new AutoPatrolInspectionRecordStore({ backend, scopeId: ' victim ' });
  assert.deepEqual(await spacedStore.listRecords(), []);
  assert.equal(await spacedStore.getRecord('scope-exact'), null);
  spacedStore.dispose();
});

test('Outbox 结构化键支持孤立代理项，不会阻断任务完成', async () => {
  const backend = new MemoryAutoPatrolInspectionBackend();
  const store = new AutoPatrolInspectionRecordStore({ backend, scopeId: '\ud800' });
  await store.startInspection({ taskId: 'unicode-scope', routeId: 'route-a', startedAtMs: 100 });

  const completed = await store.completeInspection('unicode-scope', {
    status: 'completed',
    endedAtMs: 200,
  });

  assert.equal(completed.status, 'completed');
  assert.equal((await backend.listOutbox()).length, 1);
  store.dispose();
});

test('切换场景后仍按活动任务自身作用域完成持久化', async () => {
  const backend = new MemoryAutoPatrolInspectionBackend();
  const store = new AutoPatrolInspectionRecordStore({ backend, scopeId: 'scene-active-a' });
  await store.startInspection({ taskId: 'active-a', routeId: 'route-a', startedAtMs: 100 });

  store.setScope('scene-active-b');
  await store.appendEvent('active-a', {
    id: 'event-active-a',
    eventDefinitionId: 'alarm',
    name: '切换后的收尾事件',
    trigger: 'manual',
    occurredAtMs: 200,
    targetEntityId: null,
    position: POSITION,
    businessData: {},
    anomaly: false,
  });
  await store.completeInspection('active-a', { status: 'completed', endedAtMs: 300 });

  assert.equal(await store.getRecord('active-a'), null);
  store.setScope('scene-active-a');
  const record = await store.getRecord('active-a');
  assert.equal(record?.scopeId, 'scene-active-a');
  assert.equal(record?.status, 'completed');
  assert.equal(record?.events.length, 1);
  assert.ok((await backend.listOutbox()).every((item) => item.scopeId === 'scene-active-a'));
  store.dispose();
});

test('开始任务会固定调用时的场景作用域，不受随后切换影响', async () => {
  const backend = new MemoryAutoPatrolInspectionBackend();
  const store = new AutoPatrolInspectionRecordStore({ backend, scopeId: 'scene-start-a' });

  const startPromise = store.startInspection({ taskId: 'start-a', routeId: 'route-a', startedAtMs: 100 });
  store.setScope('scene-start-b');
  const record = await startPromise;

  assert.equal(record.scopeId, 'scene-start-a');
  assert.equal((await backend.getRecord('start-a'))?.scopeId, 'scene-start-a');
  store.dispose();
});

test('历史达到上限时只清理当前场景内已完成且无待补报的最旧记录', async () => {
  const backend = new MemoryAutoPatrolInspectionBackend();
  const store = new AutoPatrolInspectionRecordStore({
    backend,
    scopeId: 'scene-capacity',
    limits: { maxRecordsPerScope: 2 },
    reporter: {
      reportEvent: async () => undefined,
      reportRecord: async () => undefined,
    },
  });

  await store.startInspection({ taskId: 'oldest', routeId: 'route-1', startedAtMs: 100 });
  await store.completeInspection('oldest', { status: 'completed', endedAtMs: 200 });
  await store.flushOutbox({ force: true });
  await store.startInspection({ taskId: 'newer', routeId: 'route-2', startedAtMs: 300 });
  await store.completeInspection('newer', { status: 'completed', endedAtMs: 400 });
  await store.flushOutbox({ force: true });

  await store.startInspection({ taskId: 'current', routeId: 'route-3', startedAtMs: 500 });

  assert.deepEqual(
    (await store.listRecords()).map((record) => record.taskId),
    ['current', 'newer'],
  );
  assert.equal(await backend.getRecord('oldest'), null);
  store.dispose();
});

test('运行中或待补报记录占满历史上限时拒绝开始新任务', async () => {
  const backend = new MemoryAutoPatrolInspectionBackend();
  const store = new AutoPatrolInspectionRecordStore({
    backend,
    scopeId: 'scene-pending',
    limits: { maxRecordsPerScope: 1 },
  });
  await store.startInspection({ taskId: 'pending', routeId: 'route-1', startedAtMs: 100 });
  await store.completeInspection('pending', { status: 'completed', endedAtMs: 200 });

  await assert.rejects(
    store.startInspection({ taskId: 'blocked', routeId: 'route-2', startedAtMs: 300 }),
    /待补报|上限/,
  );
  assert.deepEqual((await store.listRecords()).map((record) => record.taskId), ['pending']);
  store.dispose();
});

test('无效的新任务不会在校验失败前清理已有历史', async () => {
  const backend = new MemoryAutoPatrolInspectionBackend();
  const store = new AutoPatrolInspectionRecordStore({
    backend,
    scopeId: 'scene-validation',
    limits: { maxRecordsPerScope: 1 },
    reporter: {
      reportEvent: async () => undefined,
      reportRecord: async () => undefined,
    },
  });
  await store.startInspection({ taskId: 'kept', routeId: 'route-1', startedAtMs: 100 });
  await store.completeInspection('kept', { status: 'completed', endedAtMs: 200 });
  await store.flushOutbox({ force: true });

  await assert.rejects(
    store.startInspection({ taskId: 'invalid', routeId: 'route-2', startedAtMs: -1 }),
    /开始时间无效/,
  );

  assert.deepEqual((await store.listRecords()).map((record) => record.taskId), ['kept']);
  store.dispose();
});

test('Store 对轨迹、事件、截图和业务字符串执行防御性资源上限', async () => {
  const backend = new MemoryAutoPatrolInspectionBackend();
  const store = new AutoPatrolInspectionRecordStore({
    backend,
    limits: {
      maxTrajectorySamples: 1,
      maxEventsPerRecord: 1,
      maxScreenshotsPerRecord: 1,
      maxBusinessStringLength: 4,
      maxScreenshotDataUrlLength: 64,
    },
  });
  await store.startInspection({ taskId: 'bounded', routeId: 'route-1', startedAtMs: 100 });

  await assert.rejects(store.appendTrajectoryBatch('bounded', [
    { recordedAtMs: 200, position: POSITION, rotation: POSITION },
    { recordedAtMs: 300, position: POSITION, rotation: POSITION },
  ]), /轨迹.*上限/);
  assert.equal((await store.getRecord('bounded'))?.trajectory.length, 0);

  await assert.rejects(store.appendEvent('bounded', {
    id: 'too-long',
    eventDefinitionId: 'alarm',
    name: '业务字段过长',
    trigger: 'manual',
    occurredAtMs: 200,
    targetEntityId: null,
    position: POSITION,
    businessData: { note: '12345' },
    anomaly: false,
  }), /字符串.*上限/);

  await assert.rejects(store.appendEvent('bounded', {
    id: 'invalid-format',
    eventDefinitionId: 'alarm',
    name: '错误截图格式',
    trigger: 'manual',
    occurredAtMs: 250,
    targetEntityId: null,
    position: POSITION,
    businessData: {},
    anomaly: false,
    screenshot: {
      id: 'invalid-format',
      capturedAtMs: 250,
      localUrl: 'data:image/jpeg;base64,invalid',
      remoteUrl: null,
    },
  }), /PNG/);

  await assert.rejects(store.appendEvent('bounded', {
    id: 'too-large-screenshot',
    eventDefinitionId: 'alarm',
    name: '截图过大',
    trigger: 'manual',
    occurredAtMs: 275,
    targetEntityId: null,
    position: POSITION,
    businessData: {},
    anomaly: false,
    screenshot: {
      id: 'too-large-screenshot',
      capturedAtMs: 275,
      localUrl: `data:image/png;base64,${'x'.repeat(64)}`,
      remoteUrl: null,
    },
  }), /截图.*上限/);

  await store.appendEvent('bounded', {
    id: 'event-1',
    eventDefinitionId: 'alarm',
    name: '首个事件',
    trigger: 'manual',
    occurredAtMs: 300,
    targetEntityId: null,
    position: POSITION,
    businessData: { note: '1234' },
    anomaly: false,
    screenshot: {
      id: 'shot-1',
      capturedAtMs: 300,
      localUrl: 'data:image/png;base64,one',
      remoteUrl: null,
    },
  }, { queueForReport: false });

  await assert.rejects(store.appendEvent('bounded', {
    id: 'event-2',
    eventDefinitionId: 'alarm',
    name: '第二个事件',
    trigger: 'manual',
    occurredAtMs: 400,
    targetEntityId: null,
    position: POSITION,
    businessData: {},
    anomaly: false,
  }, { queueForReport: false }), /事件.*上限/);
  const record = await store.getRecord('bounded');
  assert.equal(record?.events.length, 1);
  assert.equal(record?.screenshots.length, 1);
  store.dispose();
});

test('Store 在写入前拒绝超过单条记录近似大小上限的数据', async () => {
  const backend = new MemoryAutoPatrolInspectionBackend();
  const store = new AutoPatrolInspectionRecordStore({
    backend,
    limits: { maxRecordApproxBytes: 128 },
  });

  await assert.rejects(
    store.startInspection({ taskId: 'too-large-record', routeId: 'route-1', startedAtMs: 100 }),
    /单条巡检记录.*上限/,
  );
  assert.equal(await backend.getRecord('too-large-record'), null);
  store.dispose();
});

test('轨迹追加不能绕过单条记录近似大小上限', async () => {
  const backend = new MemoryAutoPatrolInspectionBackend();
  const store = new AutoPatrolInspectionRecordStore({
    backend,
    limits: { maxRecordApproxBytes: 700 },
  });
  await store.startInspection({ taskId: 'trajectory-size', routeId: 'route-1', startedAtMs: 100 });

  await assert.rejects(store.appendTrajectory('trajectory-size', {
    recordedAtMs: 200,
    position: POSITION,
    rotation: POSITION,
  }), /单条巡检记录.*上限/);

  assert.equal((await store.getRecord('trajectory-size'))?.trajectory.length, 0);
  const completed = await store.completeInspection('trajectory-size', {
    status: 'completed',
    endedAtMs: 300,
  });
  assert.equal(completed.status, 'completed');
  store.dispose();
});
