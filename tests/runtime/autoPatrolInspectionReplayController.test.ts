import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AutoPatrolInspectionReplayController,
  createSceneCameraPoseFromReplayCamera,
  type AutoPatrolInspectionReplayCamera,
  type AutoPatrolInspectionReplayEvent,
} from '../../src/runtime/patrol/AutoPatrolInspectionReplayController.ts';
import type { AutoPatrolInspectionRecord } from '../../src/runtime/patrol/AutoPatrolInspectionRecordStore.ts';
import { getSceneCameraPosition } from '../../src/editor/model/autoPatrolInspection.ts';

class FakeReplayAdapter {
  nowMs = 0;
  camera: AutoPatrolInspectionReplayCamera | null = null;
  events: AutoPatrolInspectionReplayEvent[] = [];
  private frameCallback: (() => void) | null = null;

  now = (): number => this.nowMs;
  applyCamera = (camera: AutoPatrolInspectionReplayCamera): void => { this.camera = structuredClone(camera); };
  onEvent = (event: AutoPatrolInspectionReplayEvent): void => { this.events.push(structuredClone(event)); };
  subscribeFrame = (callback: () => void): (() => void) => {
    this.frameCallback = callback;
    return () => { this.frameCallback = null; };
  };
  advance(milliseconds: number): void {
    this.nowMs += milliseconds;
    this.frameCallback?.();
  }
}

function createRecord(): AutoPatrolInspectionRecord {
  return {
    schemaVersion: 1,
    scopeId: 'scene-history',
    taskId: 'task-history',
    routeId: 'route-1',
    routeName: '历史路线',
    operator: 'operator-1',
    startedAtMs: 1_000,
    endedAtMs: 5_000,
    durationMs: 4_000,
    status: 'completed',
    trajectory: [
      { recordedAtMs: 1_000, position: { x: 0, y: 1.7, z: 0 }, rotation: { x: 0, y: 0, z: 0 } },
      { recordedAtMs: 3_000, position: { x: 10, y: 1.7, z: 0 }, rotation: { x: 0, y: Math.PI, z: 0 } },
      { recordedAtMs: 5_000, position: { x: 20, y: 1.7, z: 0 }, rotation: { x: 0, y: Math.PI, z: 0 } },
    ],
    events: [{
      id: 'event-1',
      eventDefinitionId: 'alarm',
      name: '温度异常',
      trigger: 'region-enter',
      occurredAtMs: 3_000,
      targetEntityId: 'machine-1',
      position: { x: 10, y: 1.7, z: 0 },
      businessData: { temperature: 88 },
      anomaly: true,
      screenshot: {
        id: 'event-1',
        capturedAtMs: 3_050,
        localUrl: 'data:image/png;base64,history',
        remoteUrl: null,
      },
    }],
    screenshots: [{
      id: 'event-1',
      capturedAtMs: 3_050,
      localUrl: 'data:image/png;base64,history',
      remoteUrl: null,
    }],
    anomalyEventIds: ['event-1'],
  };
}

test('历史回放按记录时间轴插值相机并同步事件和截图', () => {
  const adapter = new FakeReplayAdapter();
  const controller = new AutoPatrolInspectionReplayController(adapter);
  assert.deepEqual(controller.load(createRecord()), { ok: true });
  controller.play();

  adapter.advance(1_000);
  assert.equal(adapter.camera?.position.x, 5);
  assert.equal(adapter.events.length, 0);
  adapter.advance(1_000);
  assert.equal(adapter.camera?.position.x, 10);
  assert.equal(adapter.events.length, 1);
  assert.equal(adapter.events[0].event.id, 'event-1');
  assert.equal(adapter.events[0].screenshot?.localUrl, 'data:image/png;base64,history');
  assert.equal(controller.getSnapshot().activeEventId, 'event-1');

  adapter.advance(2_000);
  assert.equal(adapter.camera?.position.x, 20);
  assert.equal(controller.getSnapshot().phase, 'completed');
  controller.dispose();
});

test('倍速切换与暂停共用同一虚拟时间轴', () => {
  const adapter = new FakeReplayAdapter();
  const controller = new AutoPatrolInspectionReplayController(adapter);
  controller.load(createRecord());
  controller.play();
  controller.setPlaybackRate(2);
  adapter.advance(500);
  assert.equal(controller.getSnapshot().elapsedMs, 1_000);
  assert.equal(adapter.camera?.position.x, 5);

  controller.pause();
  adapter.advance(1_000);
  assert.equal(controller.getSnapshot().elapsedMs, 1_000);
  controller.setPlaybackRate(0.5);
  controller.play();
  adapter.advance(2_000);
  assert.equal(controller.getSnapshot().elapsedMs, 2_000);
  assert.equal(adapter.camera?.position.x, 10);
  assert.equal(controller.setPlaybackRate(3 as 2).ok, false);
  controller.dispose();
});

test('跳转到指定事件会定位相机并立即显示事件和对应截图', () => {
  const adapter = new FakeReplayAdapter();
  const controller = new AutoPatrolInspectionReplayController(adapter);
  controller.load(createRecord());

  assert.deepEqual(controller.jumpToEvent('event-1'), { ok: true });
  assert.equal(controller.getSnapshot().elapsedMs, 2_000);
  assert.equal(controller.getSnapshot().phase, 'paused');
  assert.equal(adapter.camera?.position.x, 10);
  assert.equal(adapter.events.at(-1)?.event.name, '温度异常');
  assert.equal(controller.jumpToEvent('missing').ok, false);
  controller.dispose();
});

test('前后拖动后仅重放新跨越的事件且播放结束可从头重新开始', () => {
  const adapter = new FakeReplayAdapter();
  const controller = new AutoPatrolInspectionReplayController(adapter);
  controller.load(createRecord());
  controller.play();
  adapter.advance(4_000);
  assert.equal(adapter.events.length, 1);
  assert.equal(controller.getSnapshot().phase, 'completed');

  controller.play();
  assert.equal(controller.getSnapshot().elapsedMs, 0);
  adapter.advance(2_000);
  assert.equal(adapter.events.length, 2);
  controller.seek(500);
  adapter.advance(1_500);
  assert.equal(adapter.events.length, 3);
  controller.dispose();
});

test('无有效轨迹的历史记录会拒绝加载', () => {
  const adapter = new FakeReplayAdapter();
  const controller = new AutoPatrolInspectionReplayController(adapter);
  const record = createRecord();
  record.trajectory = [];
  assert.equal(controller.load(record).ok, false);
  assert.equal(controller.play().ok, false);
  controller.dispose();
});

test('起点事件参与重放且暂停不会把已完成状态改回暂停态', () => {
  const adapter = new FakeReplayAdapter();
  const controller = new AutoPatrolInspectionReplayController(adapter);
  const record = createRecord();
  record.events.unshift({
    ...record.events[0],
    id: 'event-at-start',
    occurredAtMs: record.startedAtMs,
    screenshot: undefined,
  });
  controller.load(record);
  controller.play();
  adapter.advance(1);
  assert.equal(adapter.events[0]?.event.id, 'event-at-start');

  adapter.nowMs = 10_000;
  controller.pause();
  assert.equal(controller.getSnapshot().phase, 'completed');
  controller.dispose();
});

test('回放位置与角度可无偏差还原为 Babylon ArcRotate 相机位姿', () => {
  const camera: AutoPatrolInspectionReplayCamera = {
    position: { x: 12, y: 3.5, z: -8 },
    rotation: { x: 1.1, y: -0.75, z: 0 },
  };
  const pose = createSceneCameraPoseFromReplayCamera(camera, 2.5);

  assert.deepEqual(getSceneCameraPosition(pose), camera.position);
  assert.equal(pose.alpha, camera.rotation.y);
  assert.equal(pose.beta, camera.rotation.x);
  assert.equal(pose.radius, 2.5);
});
