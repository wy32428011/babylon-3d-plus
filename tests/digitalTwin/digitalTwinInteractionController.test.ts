import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { createServer } from 'vite';

import type { DigitalTwinAssetIndex } from '../../src/shared/digitalTwinAssetCodes.ts';
import type {
  CameraTransitionCancelReason,
  CameraViewTransitionOptions,
} from '../../src/runtime/babylon/ArcRotateCameraViewController.ts';
import type {
  DigitalTwinFocusBounds,
  DigitalTwinInteractionRuntime,
  DigitalTwinMessageEvent,
} from '../../src/player/DigitalTwinInteractionController.ts';
import {
  DIGITAL_TWIN_BRIDGE_CHANNEL,
  DIGITAL_TWIN_BRIDGE_VERSION,
  type DigitalTwinBridgeMessage,
} from '../../src/player/digitalTwinInteractionProtocol.ts';


const viteServer = await createServer({
  appType: 'custom',
  configFile: false,
  root: process.cwd(),
  server: { middlewareMode: true, hmr: false },
  optimizeDeps: { noDiscovery: true },
});
const { DigitalTwinInteractionController } = await viteServer.ssrLoadModule(
  '/src/player/DigitalTwinInteractionController.ts',
) as typeof import('../../src/player/DigitalTwinInteractionController.ts');
after(async () => {
  await viteServer.close();
});

class FakeScheduler {
  nowMs = 0;
  private nextId = 1;
  private tasks = new Map<number, { dueAt: number; callback: () => void }>();

  setTimer = (callback: () => void, delayMs: number): number => {
    const id = this.nextId++;
    this.tasks.set(id, { dueAt: this.nowMs + Math.max(0, delayMs), callback });
    return id;
  };

  clearTimer = (id: unknown): void => {
    if (typeof id === 'number') this.tasks.delete(id);
  };

  advance(milliseconds: number): void {
    const target = this.nowMs + milliseconds;
    for (;;) {
      const next = [...this.tasks.entries()]
        .filter(([, task]) => task.dueAt <= target)
        .sort((left, right) => left[1].dueAt - right[1].dueAt || left[0] - right[0])[0];
      if (!next) break;
      this.tasks.delete(next[0]);
      this.nowMs = next[1].dueAt;
      next[1].callback();
    }
    this.nowMs = target;
  }

  pendingCount(): number {
    return this.tasks.size;
  }
}

class FakeMessageBus {
  private listeners = new Set<(event: DigitalTwinMessageEvent) => void>();

  subscribe = (listener: (event: DigitalTwinMessageEvent) => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  dispatch(event: DigitalTwinMessageEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }

  listenerCount(): number {
    return this.listeners.size;
  }
}

class FakeRuntime implements DigitalTwinInteractionRuntime {
  readonly assetIndex: DigitalTwinAssetIndex;
  boundsFactory: (entityId: string) => DigitalTwinFocusBounds | null;
  focusCalls: Array<{ bounds: DigitalTwinFocusBounds; options: CameraViewTransitionOptions }> = [];
  pauseCount = 0;
  cameraChangedWhilePausedCount = 0;
  highlightedEntityIds: string[][] = [];
  clearHighlightCount = 0;
  patrolPhase: 'idle' | 'moving' | 'dwelling' | 'paused' | 'completed' | 'returning' = 'idle';
  private activeTransition: CameraViewTransitionOptions | null = null;

  constructor(entries: Array<{ assetCode: string; entityIds: string[]; visible?: boolean }>, boundsFactory?: (entityId: string) => DigitalTwinFocusBounds | null) {
    this.assetIndex = {
      entityIdsByAssetCode: new Map(entries.map((entry) => [entry.assetCode, [...entry.entityIds]])),
      effectiveVisibilityByEntityId: new Map(entries.flatMap((entry) => entry.entityIds.map((id) => [id, entry.visible !== false]))),
    };
    this.boundsFactory = boundsFactory ?? (() => ({
      center: { x: 1, y: 2, z: 3 },
      radiusMeters: 4,
      geometryReady: true,
      requestedEntityCount: 1,
      resolvedEntityCount: 1,
      geometryReadyEntityCount: 1,
    }));
  }

  getEntityBounds = (entityId: string): DigitalTwinFocusBounds | null => this.boundsFactory(entityId);

  focusOnBounds = (bounds: DigitalTwinFocusBounds, options: CameraViewTransitionOptions): void => {
    this.focusCalls.push({ bounds, options });
    this.activeTransition = options;
  };

  completeFocus(): void {
    const transition = this.activeTransition;
    this.activeTransition = null;
    transition?.onCompleted?.();
  }

  cancelCameraTransition = (reason: CameraTransitionCancelReason = 'cancelled'): boolean => {
    const transition = this.activeTransition;
    if (!transition) return false;
    this.activeTransition = null;
    transition.onCancelled?.(reason);
    return true;
  };

  setExternalHighlightEntityIds = (entityIds: readonly string[]): void => {
    this.highlightedEntityIds.push([...entityIds]);
  };

  clearExternalHighlight = (): void => {
    this.clearHighlightCount += 1;
  };

  getPatrolPhase = () => this.patrolPhase;

  pausePatrol = (): void => {
    this.pauseCount += 1;
    this.patrolPhase = 'paused';
  };

  notifyCameraChangedWhilePaused = (): void => {
    this.cameraChangedWhilePausedCount += 1;
  };
}

const parentWindow = { name: 'parent' };
const otherWindow = { name: 'other' };
const sameOrigin = 'https://viewer.example.com';
const sessionId = 'runtime-1:session-1';

function message<T extends DigitalTwinBridgeMessage>(value: T): T {
  return value;
}

function hostHello() {
  return message({
    channel: DIGITAL_TWIN_BRIDGE_CHANNEL,
    version: DIGITAL_TWIN_BRIDGE_VERSION,
    sessionId,
    type: 'host.hello',
  });
}

function focusCommand(requestId: string, assetCode: string) {
  return message({
    channel: DIGITAL_TWIN_BRIDGE_CHANNEL,
    version: DIGITAL_TWIN_BRIDGE_VERSION,
    sessionId,
    type: 'command.focusAsset',
    requestId,
    payload: { assetCode },
  });
}

function createFixture() {
  const scheduler = new FakeScheduler();
  const bus = new FakeMessageBus();
  const posted: Array<{ message: DigitalTwinBridgeMessage; targetOrigin: string }> = [];
  const controller = new DigitalTwinInteractionController({
    parentWindow,
    viewerOrigin: sameOrigin,
    subscribeToMessages: bus.subscribe,
    postToParent: (postedMessage, targetOrigin) => posted.push({ message: postedMessage, targetOrigin }),
    now: () => scheduler.nowMs,
    setTimer: scheduler.setTimer,
    clearTimer: scheduler.clearTimer,
    projectId: '2051942646011785218',
  });
  return { scheduler, bus, posted, controller };
}

function dispatch(bus: FakeMessageBus, data: unknown, origin = sameOrigin, source: unknown = parentWindow): void {
  bus.dispatch({ data, origin, source });
}

test('只接受父窗口和允许 Origin，并按 bridge.ready -> viewer.ready 顺序握手', () => {
  const f = createFixture();
  const runtime = new FakeRuntime([{ assetCode: 'DDJ2', entityIds: ['entity_1'] }]);
  try {
    f.controller.markViewerReady(runtime);
    dispatch(f.bus, hostHello(), sameOrigin, otherWindow);
    dispatch(f.bus, hostHello(), 'https://evil.example.com', parentWindow);
    assert.equal(f.posted.length, 0);

    dispatch(f.bus, hostHello());
    assert.deepEqual(f.posted.map((entry) => entry.message.type), ['bridge.ready', 'viewer.ready']);
    assert.ok(f.posted.every((entry) => entry.targetOrigin === sameOrigin));
    const viewerReady = f.posted[1].message;
    assert.equal(viewerReady.type, 'viewer.ready');
    if (viewerReady.type === 'viewer.ready') {
      assert.deepEqual(viewerReady.payload, {
        projectId: '2051942646011785218',
        capabilities: ['focusAsset'],
      });
    }
  } finally {
    f.controller.dispose();
  }
});

test('跨域父页面只有命中显式白名单时才可握手', () => {
  const f = createFixture();
  const crossOrigin = 'https://screen.example.com';
  try {
    f.controller.setAllowedParentOrigins([crossOrigin]);
    dispatch(f.bus, hostHello(), crossOrigin);
    assert.deepEqual(f.posted.map((entry) => entry.targetOrigin), [crossOrigin]);
  } finally {
    f.controller.dispose();
  }
});

test('唯一可见且几何就绪的模型开始聚焦时才暂停巡检并在完成后返回成功', () => {
  const f = createFixture();
  const runtime = new FakeRuntime([{ assetCode: 'DDJ2', entityIds: ['entity_1'] }]);
  runtime.patrolPhase = 'moving';
  try {
    f.controller.markViewerReady(runtime);
    dispatch(f.bus, hostHello());
    f.posted.length = 0;

    dispatch(f.bus, focusCommand('request-1', ' DDJ2 '));
    assert.equal(runtime.pauseCount, 1);
    assert.equal(runtime.focusCalls.length, 1);
    assert.equal(runtime.focusCalls[0].options.durationMs, 450);
    assert.deepEqual(runtime.highlightedEntityIds, [['entity_1']]);
    assert.equal(f.posted.length, 0);

    runtime.completeFocus();
    assert.equal(f.posted.length, 1);
    assert.deepEqual(f.posted[0].message, {
      channel: DIGITAL_TWIN_BRIDGE_CHANNEL,
      version: DIGITAL_TWIN_BRIDGE_VERSION,
      sessionId,
      type: 'command.result',
      requestId: 'request-1',
      ok: true,
      payload: { assetCode: 'DDJ2', entityIds: ['entity_1'] },
    });

    f.scheduler.advance(2999);
    assert.equal(runtime.clearHighlightCount, 1, '开始新请求时先清除旧描边');
    f.scheduler.advance(1);
    assert.equal(runtime.clearHighlightCount, 2, '3 秒后清除本次描边');
  } finally {
    f.controller.dispose();
  }
});

test('几何等待期间不暂停巡检，几何 ready 后才开始聚焦', () => {
  const f = createFixture();
  const runtime = new FakeRuntime(
    [{ assetCode: 'WAIT', entityIds: ['entity_wait'] }],
    () => ({
      center: { x: 0, y: 0, z: 0 },
      radiusMeters: 1,
      geometryReady: f.scheduler.nowMs >= 100,
      requestedEntityCount: 1,
      resolvedEntityCount: 1,
      geometryReadyEntityCount: f.scheduler.nowMs >= 100 ? 1 : 0,
    }),
  );
  runtime.patrolPhase = 'dwelling';
  try {
    f.controller.markViewerReady(runtime);
    dispatch(f.bus, hostHello());
    f.posted.length = 0;
    dispatch(f.bus, focusCommand('request-wait', 'WAIT'));
    assert.equal(runtime.pauseCount, 0);
    assert.equal(runtime.focusCalls.length, 0);

    f.scheduler.advance(99);
    assert.equal(runtime.pauseCount, 0);
    f.scheduler.advance(1);
    assert.equal(runtime.pauseCount, 1);
    assert.equal(runtime.focusCalls.length, 1);
  } finally {
    f.controller.dispose();
  }
});

test('几何 5 秒未就绪返回 ASSET_GEOMETRY_NOT_READY 且巡检不变', () => {
  const f = createFixture();
  const runtime = new FakeRuntime(
    [{ assetCode: 'WAIT', entityIds: ['entity_wait'] }],
    () => ({
      center: { x: 0, y: 0, z: 0 },
      radiusMeters: 1,
      geometryReady: false,
      requestedEntityCount: 1,
      resolvedEntityCount: 1,
      geometryReadyEntityCount: 0,
    }),
  );
  runtime.patrolPhase = 'moving';
  try {
    f.controller.markViewerReady(runtime);
    dispatch(f.bus, hostHello());
    f.posted.length = 0;
    dispatch(f.bus, focusCommand('request-timeout', 'WAIT'));
    f.scheduler.advance(5000);

    assert.equal(runtime.pauseCount, 0);
    assert.equal(runtime.focusCalls.length, 0);
    assert.equal(f.posted.length, 1);
    const result = f.posted[0].message;
    assert.equal(result.type, 'command.result');
    if (result.type === 'command.result') {
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error.code, 'ASSET_GEOMETRY_NOT_READY');
    }
  } finally {
    f.controller.dispose();
  }
});

test('新请求替换旧请求，旧请求返回取消且只有最新请求可成功', () => {
  const f = createFixture();
  const runtime = new FakeRuntime(
    [
      { assetCode: 'A', entityIds: ['entity_a'] },
      { assetCode: 'B', entityIds: ['entity_b'] },
    ],
    (entityId) => ({
      center: { x: 0, y: 0, z: 0 },
      radiusMeters: 1,
      geometryReady: entityId === 'entity_b',
      requestedEntityCount: 1,
      resolvedEntityCount: 1,
      geometryReadyEntityCount: entityId === 'entity_b' ? 1 : 0,
    }),
  );
  try {
    f.controller.markViewerReady(runtime);
    dispatch(f.bus, hostHello());
    f.posted.length = 0;
    dispatch(f.bus, focusCommand('request-a', 'A'));
    dispatch(f.bus, focusCommand('request-b', 'B'));

    assert.equal(f.posted.length, 1);
    const cancelled = f.posted[0].message;
    assert.equal(cancelled.type, 'command.result');
    if (cancelled.type === 'command.result' && !cancelled.ok) {
      assert.equal(cancelled.requestId, 'request-a');
      assert.equal(cancelled.error.code, 'COMMAND_CANCELLED');
    }

    runtime.completeFocus();
    assert.equal(f.posted.length, 2);
    const success = f.posted[1].message;
    assert.equal(success.type, 'command.result');
    if (success.type === 'command.result') assert.equal(success.requestId, 'request-b');
  } finally {
    f.controller.dispose();
  }
});

test('人工相机输入静默取消动画和描边，巡检保持暂停并记录相机已变化', () => {
  const f = createFixture();
  const runtime = new FakeRuntime([{ assetCode: 'DDJ2', entityIds: ['entity_1'] }]);
  runtime.patrolPhase = 'moving';
  try {
    f.controller.markViewerReady(runtime);
    dispatch(f.bus, hostHello());
    f.posted.length = 0;
    dispatch(f.bus, focusCommand('request-manual', 'DDJ2'));
    assert.equal(runtime.patrolPhase, 'paused');

    f.controller.notifyManualCameraInput();
    assert.equal(runtime.cameraChangedWhilePausedCount, 1);
    assert.equal(runtime.patrolPhase, 'paused');
    assert.ok(runtime.clearHighlightCount >= 2);
    assert.equal(f.posted.length, 1);
    const result = f.posted[0].message;
    assert.equal(result.type, 'command.result');
    if (result.type === 'command.result' && !result.ok) {
      assert.equal(result.error.code, 'COMMAND_CANCELLED');
    }
  } finally {
    f.controller.dispose();
  }
});

test('未找到、重复和隐藏模型立即返回错误且不暂停巡检', () => {
  const f = createFixture();
  const runtime = new FakeRuntime([
    { assetCode: 'DUP', entityIds: ['entity_a', 'entity_b'] },
    { assetCode: 'HIDDEN', entityIds: ['entity_hidden'], visible: false },
  ]);
  runtime.patrolPhase = 'moving';
  try {
    f.controller.markViewerReady(runtime);
    dispatch(f.bus, hostHello());
    f.posted.length = 0;

    dispatch(f.bus, focusCommand('request-missing', 'MISSING'));
    dispatch(f.bus, focusCommand('request-duplicate', 'DUP'));
    dispatch(f.bus, focusCommand('request-hidden', 'HIDDEN'));

    assert.equal(runtime.pauseCount, 0);
    const codes = f.posted.map((entry) => {
      const result = entry.message;
      return result.type === 'command.result' && !result.ok ? result.error.code : null;
    });
    assert.deepEqual(codes, ['ASSET_NOT_FOUND', 'ASSET_CODE_AMBIGUOUS', 'ASSET_NOT_VISIBLE']);
  } finally {
    f.controller.dispose();
  }
});

test('dispose 移除监听器并清理所有定时任务', () => {
  const f = createFixture();
  const runtime = new FakeRuntime(
    [{ assetCode: 'WAIT', entityIds: ['entity_wait'] }],
    () => ({
      center: { x: 0, y: 0, z: 0 },
      radiusMeters: 1,
      geometryReady: false,
      requestedEntityCount: 1,
      resolvedEntityCount: 1,
      geometryReadyEntityCount: 0,
    }),
  );
  f.controller.markViewerReady(runtime);
  dispatch(f.bus, hostHello());
  dispatch(f.bus, focusCommand('request-wait', 'WAIT'));
  assert.equal(f.bus.listenerCount(), 1);
  assert.ok(f.scheduler.pendingCount() > 0);

  f.controller.dispose();
  assert.equal(f.bus.listenerCount(), 0);
  assert.equal(f.scheduler.pendingCount(), 0);
});
