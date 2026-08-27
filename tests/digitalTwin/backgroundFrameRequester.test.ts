import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BACKGROUND_FRAME_INTERVAL_MS,
  createBackgroundFrameRequester,
  type BackgroundFrameTimer,
} from '../../src/runtime/babylon/backgroundFrameRequester.ts';

type VisibilityState = 'visible' | 'hidden';

function createFixture(initialVisibility: VisibilityState = 'visible') {
  let visibility = initialVisibility;
  let visibilityListener: (() => void) | null = null;
  let nextVisibleRequestId = 100;
  const visibleCallbacks = new Map<number, (timestamp: number) => void>();
  const canceledVisibleRequests: number[] = [];
  const backgroundCallbacks = new Map<number, number>();
  const canceledBackgroundRequests: number[] = [];
  let backgroundFrameListener: ((requestId: number) => void) | null = null;
  let backgroundTimerDisposed = false;
  let now = 321;

  const backgroundTimer: BackgroundFrameTimer = {
    schedule: (requestId, delayMs) => {
      backgroundCallbacks.set(requestId, delayMs);
    },
    cancel: (requestId) => {
      canceledBackgroundRequests.push(requestId);
      backgroundCallbacks.delete(requestId);
    },
    dispose: () => {
      backgroundTimerDisposed = true;
      backgroundCallbacks.clear();
    },
  };

  const requester = createBackgroundFrameRequester({
    getVisibilityState: () => visibility,
    subscribeVisibilityChange: (listener) => {
      visibilityListener = listener;
      return () => {
        if (visibilityListener === listener) visibilityListener = null;
      };
    },
    requestVisibleFrame: (callback) => {
      const requestId = nextVisibleRequestId;
      nextVisibleRequestId += 1;
      visibleCallbacks.set(requestId, callback);
      return requestId;
    },
    cancelVisibleFrame: (requestId) => {
      canceledVisibleRequests.push(requestId);
      visibleCallbacks.delete(requestId);
    },
    createBackgroundTimer: (onFrame) => {
      backgroundFrameListener = onFrame;
      return backgroundTimer;
    },
    now: () => now,
  });

  return {
    requester,
    visibleCallbacks,
    canceledVisibleRequests,
    backgroundCallbacks,
    canceledBackgroundRequests,
    setVisibility(nextVisibility: VisibilityState) {
      visibility = nextVisibility;
      visibilityListener?.();
    },
    fireVisible(requestId: number, timestamp: number) {
      const callback = visibleCallbacks.get(requestId);
      assert.ok(callback, `缺少可见帧回调：${requestId}`);
      visibleCallbacks.delete(requestId);
      callback(timestamp);
    },
    fireBackground(requestId: number) {
      assert.equal(backgroundCallbacks.has(requestId), true, `缺少后台帧回调：${requestId}`);
      backgroundCallbacks.delete(requestId);
      backgroundFrameListener?.(requestId);
    },
    setNow(value: number) {
      now = value;
    },
    isBackgroundTimerDisposed: () => backgroundTimerDisposed,
    hasVisibilityListener: () => visibilityListener !== null,
  };
}

test('可见页面使用浏览器 requestAnimationFrame 并透传时间戳', () => {
  const fixture = createFixture('visible');
  let receivedTimestamp = -1;

  const requestId = fixture.requester.requestAnimationFrame((timestamp) => {
    receivedTimestamp = timestamp;
  });

  assert.equal(requestId, 1);
  assert.deepEqual([...fixture.visibleCallbacks.keys()], [100]);
  assert.equal(fixture.backgroundCallbacks.size, 0);

  fixture.fireVisible(100, 456);
  assert.equal(receivedTimestamp, 456);
  fixture.requester.dispose();
});

test('隐藏页面改用 Worker 后台帧并使用单调时钟时间戳', () => {
  const fixture = createFixture('hidden');
  fixture.setNow(789);
  let receivedTimestamp = -1;

  const requestId = fixture.requester.requestAnimationFrame((timestamp) => {
    receivedTimestamp = timestamp;
  });

  assert.equal(fixture.backgroundCallbacks.get(requestId), BACKGROUND_FRAME_INTERVAL_MS);
  assert.equal(fixture.visibleCallbacks.size, 0);

  fixture.fireBackground(requestId);
  assert.equal(receivedTimestamp, 789);
  fixture.requester.dispose();
});

test('可见性变化会迁移尚未执行的帧请求', () => {
  const fixture = createFixture('visible');
  const requestId = fixture.requester.requestAnimationFrame(() => undefined);

  fixture.setVisibility('hidden');
  assert.deepEqual(fixture.canceledVisibleRequests, [100]);
  assert.equal(fixture.backgroundCallbacks.size, 1);
  const [backgroundScheduleId] = fixture.backgroundCallbacks.keys();
  assert.equal(fixture.backgroundCallbacks.get(backgroundScheduleId), BACKGROUND_FRAME_INTERVAL_MS);

  fixture.setVisibility('visible');
  assert.deepEqual(fixture.canceledBackgroundRequests, [backgroundScheduleId]);
  assert.deepEqual([...fixture.visibleCallbacks.keys()], [101]);
  fixture.requester.dispose();
});

test('取消与释放会清理帧请求、监听器和后台计时器', () => {
  const fixture = createFixture('hidden');
  const canceledRequestId = fixture.requester.requestAnimationFrame(() => undefined);
  fixture.requester.cancelAnimationFrame(canceledRequestId);
  assert.deepEqual(fixture.canceledBackgroundRequests, [canceledRequestId]);

  const pendingRequestId = fixture.requester.requestAnimationFrame(() => undefined);
  assert.equal(fixture.backgroundCallbacks.has(pendingRequestId), true);
  fixture.requester.dispose();

  assert.deepEqual(fixture.canceledBackgroundRequests, [canceledRequestId, pendingRequestId]);
  assert.equal(fixture.hasVisibilityListener(), false);
  assert.equal(fixture.isBackgroundTimerDisposed(), true);
});
