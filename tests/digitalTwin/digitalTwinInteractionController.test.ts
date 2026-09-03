import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { createServer } from 'vite';

import type { DigitalTwinAssetIndex } from '../../src/shared/digitalTwinAssetCodes.ts';
import type { SceneDocument } from '../../src/editor/model/SceneDocument.ts';
import type { DigitalTwinSlotCoordinate, DigitalTwinSlotIndex } from '../../src/shared/digitalTwinSlotCodes.ts';
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
  DIGITAL_TWIN_HARDWARE_GPU_CAPABILITY,
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
const { createViewerModelClickHandler } = await viteServer.ssrLoadModule('/src/player/viewerModelClick.ts') as typeof import('../../src/player/viewerModelClick.ts');
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
  readonly hardwareGpuVerified = true;
  readonly assetIndex: DigitalTwinAssetIndex;
  slotIndex: DigitalTwinSlotIndex;
  boundsFactory: (entityId: string, slot?: DigitalTwinSlotCoordinate) => DigitalTwinFocusBounds | null;
  focusCalls: Array<{ bounds: DigitalTwinFocusBounds; options: CameraViewTransitionOptions }> = [];
  clickCalls: Array<{ entityId: string; slot?: DigitalTwinSlotCoordinate }> = [];
  pauseCount = 0;
  cameraChangedWhilePausedCount = 0;
  highlightedEntityIds: string[][] = [];
  slotHighlights: Array<{ entityId: string; coordinate: DigitalTwinSlotCoordinate | null }> = [];
  clearHighlightCount = 0;
  startAutoPatrolCount = 0;
  startManualRoamCount = 0;
  patrolPhase: 'idle' | 'moving' | 'dwelling' | 'paused' | 'completed' | 'returning' = 'idle';
  private activeTransition: CameraViewTransitionOptions | null = null;

  constructor(entries: Array<{ assetCode: string; entityIds: string[]; visible?: boolean }>, boundsFactory?: (entityId: string, slot?: DigitalTwinSlotCoordinate) => DigitalTwinFocusBounds | null) {
    this.assetIndex = {
      entityIdsByAssetCode: new Map(entries.map((entry) => [entry.assetCode, [...entry.entityIds]])),
      effectiveVisibilityByEntityId: new Map(entries.flatMap((entry) => entry.entityIds.map((id) => [id, entry.visible !== false]))),
    };
    this.slotIndex = {
      locators: [],
      standaloneEntityIdsByAssetId: new Map(),
      effectiveVisibilityByEntityId: new Map(),
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

  getFocusBounds = (entityId: string, slot?: DigitalTwinSlotCoordinate): DigitalTwinFocusBounds | null => this.boundsFactory(entityId, slot);

  triggerTargetClick = (entityId: string, slot?: DigitalTwinSlotCoordinate): void => {
    this.clickCalls.push({ entityId, slot });
  };

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

  setExternalSlotHighlight = (entityId: string, coordinate: DigitalTwinSlotCoordinate | null): void => {
    this.slotHighlights.push({ entityId, coordinate });
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

  startAutoPatrol: (() => void) | undefined = () => {
    this.startAutoPatrolCount += 1;
    this.patrolPhase = 'moving' as const;
  };

  startManualRoam: (() => void) | undefined = () => {
    this.startManualRoamCount += 1;
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

function runtimeActionCommand(requestId: string, action: 'startAutoPatrol' | 'startManualRoam') {
  return message({
    channel: DIGITAL_TWIN_BRIDGE_CHANNEL,
    version: DIGITAL_TWIN_BRIDGE_VERSION,
    sessionId,
    type: `command.${action}`,
    requestId,
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

test('未通过硬件 GPU 校验的运行时不能进入 viewer.ready', () => {
  const f = createFixture();
  const runtime = new FakeRuntime([{ assetCode: 'DDJ2', entityIds: ['entity_1'] }]);
  Object.defineProperty(runtime, 'hardwareGpuVerified', { value: false });
  try {
    assert.throws(
      () => f.controller.markViewerReady(runtime),
      /必须先通过硬件 GPU 校验/,
    );
    dispatch(f.bus, hostHello());
    assert.deepEqual(f.posted.map((entry) => entry.message.type), ['bridge.ready']);
  } finally {
    f.controller.dispose();
  }
});

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
        capabilities: [
          DIGITAL_TWIN_HARDWARE_GPU_CAPABILITY,
          'focusAsset',
          'startAutoPatrol',
          'startManualRoam',
        ],
      });
    }
  } finally {
    f.controller.dispose();
  }
});

test('自动巡检和手动漫游命令分别调用运行时并立即返回成功', () => {
  const f = createFixture();
  const runtime = new FakeRuntime([]);
  try {
    f.controller.markViewerReady(runtime);
    dispatch(f.bus, hostHello());
    f.posted.length = 0;

    dispatch(f.bus, runtimeActionCommand('request-patrol', 'startAutoPatrol'));
    dispatch(f.bus, runtimeActionCommand('request-roam', 'startManualRoam'));

    assert.equal(runtime.startAutoPatrolCount, 1);
    assert.equal(runtime.startManualRoamCount, 1);
    assert.deepEqual(f.posted.map((entry) => entry.message), [
      {
        channel: DIGITAL_TWIN_BRIDGE_CHANNEL,
        version: DIGITAL_TWIN_BRIDGE_VERSION,
        sessionId,
        type: 'command.result',
        requestId: 'request-patrol',
        ok: true,
        payload: { action: 'startAutoPatrol' },
      },
      {
        channel: DIGITAL_TWIN_BRIDGE_CHANNEL,
        version: DIGITAL_TWIN_BRIDGE_VERSION,
        sessionId,
        type: 'command.result',
        requestId: 'request-roam',
        ok: true,
        payload: { action: 'startManualRoam' },
      },
    ]);
  } finally {
    f.controller.dispose();
  }
});

test('首次场景加载状态在握手时重放，并在加载完成后只发送一次 complete', () => {
  const f = createFixture();
  const runtime = new FakeRuntime([]);
  try {
    f.controller.markInitialLoadStarted();
    f.controller.markViewerReady(runtime);
    dispatch(f.bus, hostHello());

    assert.deepEqual(f.posted.map((entry) => entry.message.type), [
      'bridge.ready',
      'viewer.initialLoadState',
      'viewer.ready',
    ]);
    assert.deepEqual(f.posted[1].message, {
      channel: DIGITAL_TWIN_BRIDGE_CHANNEL,
      version: DIGITAL_TWIN_BRIDGE_VERSION,
      sessionId,
      type: 'viewer.initialLoadState',
      payload: { phase: 'loading' },
    });

    f.controller.markInitialLoadComplete();
    f.controller.markInitialLoadComplete();
    assert.deepEqual(f.posted.at(-1)?.message, {
      channel: DIGITAL_TWIN_BRIDGE_CHANNEL,
      version: DIGITAL_TWIN_BRIDGE_VERSION,
      sessionId,
      type: 'viewer.initialLoadState',
      payload: { phase: 'complete' },
    });
    assert.equal(
      f.posted.filter((entry) => entry.message.type === 'viewer.initialLoadState'
        && entry.message.payload.phase === 'complete').length,
      1,
    );
  } finally {
    f.controller.dispose();
  }
});

test('只声明运行时实际支持的能力，并为缺失或执行异常的动作返回错误', () => {
  const f = createFixture();
  const runtime = new FakeRuntime([]);
  runtime.startAutoPatrol = undefined;
  runtime.startManualRoam = () => {
    throw new Error('manual roam failed');
  };
  try {
    f.controller.markViewerReady(runtime);
    dispatch(f.bus, hostHello());
    const viewerReady = f.posted.at(-1)?.message;
    assert.equal(viewerReady?.type, 'viewer.ready');
    if (viewerReady?.type === 'viewer.ready') {
      assert.deepEqual(viewerReady.payload.capabilities, [
        DIGITAL_TWIN_HARDWARE_GPU_CAPABILITY,
        'focusAsset',
        'startManualRoam',
      ]);
    }
    f.posted.length = 0;

    dispatch(f.bus, runtimeActionCommand('request-patrol', 'startAutoPatrol'));
    dispatch(f.bus, runtimeActionCommand('request-roam', 'startManualRoam'));

    assert.deepEqual(f.posted.map((entry) => entry.message), [
      {
        channel: DIGITAL_TWIN_BRIDGE_CHANNEL,
        version: DIGITAL_TWIN_BRIDGE_VERSION,
        sessionId,
        type: 'command.result',
        requestId: 'request-patrol',
        ok: false,
        error: { code: 'UNSUPPORTED_COMMAND', message: '当前 Viewer 不支持该命令' },
      },
      {
        channel: DIGITAL_TWIN_BRIDGE_CHANNEL,
        version: DIGITAL_TWIN_BRIDGE_VERSION,
        sessionId,
        type: 'command.result',
        requestId: 'request-roam',
        ok: false,
        error: { code: 'INTERNAL_ERROR', message: 'Viewer 执行命令时发生内部异常' },
      },
    ]);
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

test('白名单含 * 时任意来源（含 null）都可握手并按实际 Origin 回发', () => {
  const f = createFixture();
  try {
    f.controller.setAllowedParentOrigins(['*']);
    dispatch(f.bus, hostHello(), 'https://random.example.com');
    assert.deepEqual(f.posted.map((entry) => entry.targetOrigin), ['https://random.example.com']);
    assert.deepEqual(f.posted.map((entry) => entry.message.type), ['bridge.ready']);

    f.posted.length = 0;
    dispatch(f.bus, hostHello(), 'null');
    assert.deepEqual(f.posted.map((entry) => entry.targetOrigin), ['null']);
    assert.deepEqual(f.posted.map((entry) => entry.message.type), ['bridge.ready']);
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
    assert.equal(runtime.focusCalls[0].options.animate, false, '发布后的模型聚焦必须立即进入约束位姿');
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

test('搜索聚焦完成后只触发一次目标点击，失败或取消请求不触发', () => {
  const f = createFixture();
  const runtime = new FakeRuntime([{ assetCode: 'DDJ2', entityIds: ['entity_1'] }]);
  try {
    f.controller.markViewerReady(runtime);
    dispatch(f.bus, hostHello());
    dispatch(f.bus, focusCommand('missing', 'missing'));
    dispatch(f.bus, focusCommand('cancelled', 'DDJ2'));
    const cancelledCompletion = runtime.focusCalls[0].options.onCompleted;
    dispatch(f.bus, focusCommand('latest', 'DDJ2'));
    cancelledCompletion?.();
    assert.deepEqual(runtime.clickCalls, []);
    const completion = runtime.focusCalls[1].options.onCompleted;
    runtime.completeFocus();
    completion?.();
    assert.deepEqual(runtime.clickCalls, [{ entityId: 'entity_1', slot: undefined }]);
  } finally {
    f.controller.dispose();
  }
});

test('目标点击处理异常返回 INTERNAL_ERROR，不把异常回调当作聚焦成功', () => {
  const f = createFixture();
  const runtime = new FakeRuntime([{ assetCode: 'DDJ2', entityIds: ['entity_1'] }]);
  runtime.triggerTargetClick = () => { throw new Error('click failed'); };
  try {
    f.controller.markViewerReady(runtime);
    dispatch(f.bus, hostHello());
    dispatch(f.bus, focusCommand('click-error', 'DDJ2'));
    assert.doesNotThrow(() => runtime.completeFocus());
    const result = f.posted.at(-1)?.message;
    assert.equal(result?.type === 'command.result' && !result.ok ? result.error.code : '', 'INTERNAL_ERROR');
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

test('货格坐标命中后聚焦单格包围盒并设置格子 overlay', () => {
  const f = createFixture();
  const runtime = new FakeRuntime([]);
  runtime.slotIndex = {
    locators: [{
      entityId: 'entity_locator',
      assetId: 'SHELF-01',
      rowNumber: 1,
      startColumn: 1,
      startLayer: 1,
      columns: 10,
      layers: 5,
      builtIn: true,
      hostEntityId: 'entity_shelf',
    }],
    standaloneEntityIdsByAssetId: new Map(),
    effectiveVisibilityByEntityId: new Map([
      ['entity_locator', true],
      ['entity_shelf', true],
    ]),
  };
  runtime.boundsFactory = (_entityId, slot) => ({
    center: { x: slot?.column ?? 0, y: slot?.layer ?? 0, z: slot?.row ?? 0 },
    radiusMeters: 0.5,
    geometryReady: true,
    requestedEntityCount: 1,
    resolvedEntityCount: 1,
    geometryReadyEntityCount: 1,
  });
  runtime.patrolPhase = 'moving';
  try {
    f.controller.markViewerReady(runtime);
    dispatch(f.bus, hostHello());
    f.posted.length = 0;
    dispatch(f.bus, focusCommand('request-slot', '1-5-3'));
    assert.equal(runtime.pauseCount, 1);
    assert.deepEqual(runtime.highlightedEntityIds, [[]]);
    assert.deepEqual(runtime.slotHighlights, [{
      entityId: 'entity_locator',
      coordinate: { row: 1, column: 5, layer: 3 },
    }]);
    assert.deepEqual(runtime.focusCalls[0].bounds.center, { x: 5, y: 3, z: 1 });
    runtime.completeFocus();
    assert.deepEqual(runtime.clickCalls, [{ entityId: 'entity_locator', slot: { row: 1, column: 5, layer: 3 } }]);
    const result = f.posted[0].message;
    assert.equal(result.type, 'command.result');
    if (result.type === 'command.result') {
      assert.equal(result.ok, true);
      if (result.ok) {
        assert.deepEqual(result.payload, { assetCode: '1-5-3', entityIds: ['entity_locator'] });
      }
    }
  } finally {
    f.controller.dispose();
  }
});

test('内置货格与宿主同号时优先命中模型', () => {
  const f = createFixture();
  const runtime = new FakeRuntime([{ assetCode: 'SHELF-01', entityIds: ['entity_shelf'] }]);
  runtime.slotIndex = {
    locators: [{
      entityId: 'entity_locator',
      assetId: 'SHELF-01',
      rowNumber: 1,
      startColumn: 1,
      startLayer: 1,
      columns: 10,
      layers: 5,
      builtIn: true,
      hostEntityId: 'entity_shelf',
    }],
    standaloneEntityIdsByAssetId: new Map(),
    effectiveVisibilityByEntityId: new Map([
      ['entity_locator', true],
      ['entity_shelf', true],
    ]),
  };
  try {
    f.controller.markViewerReady(runtime);
    dispatch(f.bus, hostHello());
    f.posted.length = 0;
    dispatch(f.bus, focusCommand('request-shelf', 'SHELF-01'));
    assert.deepEqual(runtime.highlightedEntityIds, [['entity_shelf']]);
    assert.equal(runtime.slotHighlights.at(-1)?.coordinate, null);
    runtime.completeFocus();
    const result = f.posted[0].message;
    assert.equal(result.type, 'command.result');
    if (result.type === 'command.result' && result.ok) {
      assert.deepEqual(result.payload, { assetCode: 'SHELF-01', entityIds: ['entity_shelf'] });
    }
  } finally {
    f.controller.dispose();
  }
});

test('库位资产编号消息贯通聚焦与宿主点击单元事件', () => {
  const f = createFixture();
  const runtime = new FakeRuntime([]);
  const sourceUrl = 'editor-asset://local/shelf.glb';
  const scene = { entities: {
    shelf: { id: 'shelf', components: { modelAsset: {
      sourceUrl,
      builtInSlotBindingConfig: { dimensionMapping: { columns: 'columns', layers: 'layers' } },
    } } },
    slot: { id: 'slot', components: { locator: { builtInBinding: { hostEntityId: 'shelf' } } } },
    binding: { id: 'binding', components: { clickEventBinding: {
      deviceSlots: [{ deviceType: { sourceUrl } }],
      events: [{ eventType: 'click-cell', effects: ['highlight', 'focus'] }],
    } } },
  } } as unknown as SceneDocument;
  const selected: string[][] = [];
  const events: string[] = [];
  const highlighted: unknown[] = [];
  const click = createViewerModelClickHandler(scene, {
    updateSelection: (ids) => selected.push([...ids]),
    setSlotHighlight: (entityId, cell) => highlighted.push({ entityId, cell }),
    focusTarget: () => assert.fail('点击事件不能再次覆盖搜索聚焦'),
    triggerManualEvents: (id) => events.push(id),
  });
  runtime.slotIndex.locators.push({
    entityId: 'slot', assetId: '0001-A', rowNumber: 2, startColumn: 3, startLayer: 4,
    columns: 1, layers: 1, builtIn: true, hostEntityId: 'shelf',
  });
  runtime.triggerTargetClick = (id, cell) => click(id, cell ? { locatorEntityId: id, ...cell } : null, { focus: false });
  try {
    f.controller.markViewerReady(runtime);
    dispatch(f.bus, hostHello());
    dispatch(f.bus, focusCommand('slot-code', ' 0001-A '));
    assert.equal(runtime.focusCalls.length, 1);
    assert.deepEqual(events, []);
    runtime.completeFocus();
    assert.deepEqual(selected, [[]]);
    assert.deepEqual(events, ['shelf']);
    assert.deepEqual(highlighted, [{ entityId: 'slot', cell: { row: 2, column: 3, layer: 4 } }]);
    const result = f.posted.at(-1)?.message;
    assert.equal(result?.type === 'command.result' && result.ok, true);
  } finally {
    f.controller.dispose();
  }
});


test('主题动作仅在就绪且完成握手后向当前宿主发送同项目大屏标识', () => {
  const f = createFixture();
  const screen = { projectId: '2051942646011785218', screenId: '2051942646011785300' };
  try {
    assert.equal(f.controller.showScreen(screen), false);
    dispatch(f.bus, hostHello());
    assert.equal(f.controller.showScreen(screen), false);
    f.controller.markViewerReady(new FakeRuntime([]));
    f.posted.length = 0;
    assert.equal(f.controller.showScreen({ ...screen, projectId: 'other' }), false);
    assert.equal(f.controller.showScreen({ ...screen, screenId: '' }), false);
    assert.equal(f.controller.showScreen({ ...screen, screenId: 'x'.repeat(129) }), false);
    assert.deepEqual(f.posted, []);
    assert.equal(f.controller.showScreen({ ...screen, screenUrl: 'https://unused.example' } as typeof screen), true);
    assert.deepEqual(f.posted, [{ targetOrigin: sameOrigin, message: {
      channel: DIGITAL_TWIN_BRIDGE_CHANNEL, version: DIGITAL_TWIN_BRIDGE_VERSION,
      sessionId, type: 'viewer.showScreen', payload: screen,
    } }]);
    const nextSessionId = 'runtime-1:session-2';
    dispatch(f.bus, { ...hostHello(), sessionId: nextSessionId });
    assert.equal(f.controller.showScreen(screen), true);
    assert.equal(f.posted.at(-1)?.message.sessionId, nextSessionId);
    f.controller.dispose();
    assert.equal(f.controller.showScreen(screen), false);
  } finally { f.controller.dispose(); }
});

test('错误来源或窗口不能借主题动作建立宿主会话', () => {
  const f = createFixture();
  try {
    f.controller.markViewerReady(new FakeRuntime([]));
    dispatch(f.bus, hostHello(), 'https://untrusted.example');
    dispatch(f.bus, hostHello(), sameOrigin, otherWindow);
    assert.equal(f.controller.showScreen({ projectId: '2051942646011785218', screenId: '3' }), false);
    assert.deepEqual(f.posted, []);
  } finally { f.controller.dispose(); }
});
