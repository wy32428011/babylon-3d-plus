import assert from 'node:assert/strict';
import test from 'node:test';
import { createOpeningController } from '../../src/standalone-opening/controller.ts';

function fixture(options: Record<string, unknown> = {}, allowSkip = true, onDispose?: () => void) {
  let now = 0;
  let visible = true;
  let nextId = 0;
  const frames = new Map<number, () => void>();
  const timers = new Map<number, () => void>();
  const listeners = new Set<() => void>();
  const runtimes: { resolve(): void; reject(error: Error): void; disposed: boolean; renders: [number, boolean][] }[] = [];
  const completions: string[] = [];
  const errors: Error[] = [];
  const controller = createOpeningController({
    onComplete: event => completions.push(event.reason), onError: error => errors.push(error), ...options,
  }, {
    totalDurationSeconds: 62, initialElapsedSeconds: 0, allowSkip,
    now: () => now, isDocumentVisible: () => visible, isContainerVisible: () => true,
    getFrame: elapsedSeconds => ({ phase: elapsedSeconds >= 62 ? 'complete' : 'globe', stageIndex: 0, progress: elapsedSeconds / 62 }),
    requestFrame: callback => { const id = ++nextId; frames.set(id, callback); return id; },
    cancelFrame: id => { frames.delete(id); },
    setTimer: callback => { const id = ++nextId; timers.set(id, callback); return id; },
    clearTimer: id => { timers.delete(id); },
    subscribeVisibility: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    createRuntime: () => {
      let resolve!: () => void, reject!: (error: Error) => void;
      const ready = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
      const runtime = { resolve, reject, disposed: false, renders: [] as [number, boolean][] };
      runtimes.push(runtime);
      return { ready, render: (seconds, paused) => { runtime.renders.push([seconds, paused]); }, dispose: () => { runtime.disposed = true; onDispose?.(); } };
    },
  });
  return { controller, runtimes, completions, errors, frames, timers, listeners,
    ready: async () => { runtimes.at(-1)!.resolve(); await controller.ready; },
    advance: (ms: number) => { now += ms; const current = [...frames.values()]; frames.clear(); current.forEach(callback => callback()); },
    visible: (value: boolean) => { visible = value; listeners.forEach(listener => listener()); },
  };
}

test('默认62秒自动播放，完成释放全部运行资源且回调只发生一次', async () => {
  const f = fixture();
  assert.equal(f.controller.getState().status, 'loading');
  await f.ready();
  assert.equal(f.controller.getState().status, 'playing');
  f.advance(62_000);
  assert.equal(f.controller.getState().status, 'completed');
  assert.deepEqual(f.completions, ['completed']);
  assert.equal(f.runtimes[0].disposed, true);
  assert.equal(f.frames.size + f.timers.size + f.listeners.size, 0);
  f.controller.skip(); f.controller.play(); f.controller.resume();
  assert.deepEqual(f.completions, ['completed']);
});

test('autoplay=false等待play，用户暂停不会被宿主或页面恢复覆盖', async () => {
  const f = fixture({ autoplay: false });
  await f.ready();
  assert.equal(f.controller.getState().status, 'ready');
  assert.equal(f.frames.size, 0);
  f.controller.play(); f.advance(1_000); f.controller.pause();
  f.controller.setHostVisible(false); f.visible(false); f.advance(9_000);
  f.controller.setHostVisible(true); f.visible(true);
  assert.equal(f.controller.getState().status, 'paused');
  assert.equal(f.controller.getState().elapsedSeconds, 1);
  f.controller.resume(); f.advance(2_000);
  assert.equal(f.controller.getState().elapsedSeconds, 3);
  f.controller.destroy();
});

test('隐藏期间准备完成不会消耗首播，页面与宿主可见性共同控制暂停', async () => {
  const f = fixture({ hostVisible: false });
  await f.ready(); f.advance(15_000);
  assert.equal(f.controller.getState().elapsedSeconds, 0);
  f.visible(false); f.controller.setHostVisible(true); f.advance(15_000);
  assert.equal(f.controller.getState().elapsedSeconds, 0);
  f.visible(true); f.advance(1_000);
  assert.equal(f.controller.getState().elapsedSeconds, 1);
  f.controller.setHostVisible(false); f.advance(10_000);
  assert.equal(f.controller.getState().elapsedSeconds, 1);
  f.controller.destroy();
});

test('跳过后可重新准备并重播，完成事件每轮一次', async () => {
  const f = fixture(); await f.ready();
  f.controller.seek(15); assert.equal(f.controller.getState().elapsedSeconds, 15);
  f.controller.skip(); f.controller.skip();
  assert.deepEqual(f.completions, ['skipped']);
  f.controller.restart(); await f.ready();
  assert.equal(f.controller.getState().elapsedSeconds, 0);
  f.advance(62_000);
  assert.deepEqual(f.completions, ['skipped', 'completed']);
  f.controller.destroy();
});

test('准备超时或资源失败拒绝ready，清理DOM适配器与监听且不会完成', async () => {
  for (const cause of ['timeout', 'load-error']) {
    const f = fixture();
    const rejected = assert.rejects(f.controller.ready, cause === 'timeout' ? /超时/ : /failed-image/);
    if (cause === 'timeout') [...f.timers.values()][0](); else f.runtimes[0].reject(new Error('failed-image'));
    await rejected;
    assert.equal(f.controller.getState().status, 'failed');
    assert.equal(f.runtimes[0].disposed, true);
    assert.equal(f.frames.size + f.timers.size + f.listeners.size, 0);
    assert.equal(f.errors.length, 1); assert.equal(f.completions.length, 0);
    f.runtimes[0].resolve(); await Promise.resolve();
    assert.equal(f.controller.getState().status, 'failed');
    f.controller.destroy();
  }
});

test('准备中销毁或重播结算旧ready，迟到加载完成不会重新挂载', async () => {
  const f = fixture();
  const first = assert.rejects(f.controller.ready, { name: 'AbortError' });
  f.controller.restart(); await first;
  f.runtimes[0].resolve(); await Promise.resolve();
  assert.equal(f.controller.getState().status, 'loading');
  const second = assert.rejects(f.controller.ready, { name: 'AbortError' });
  f.controller.destroy(); await second;
  f.runtimes[1].resolve(); await Promise.resolve();
  assert.equal(f.controller.getState().status, 'destroyed');
  assert.equal(f.frames.size + f.timers.size + f.listeners.size, 0);
  assert.deepEqual(f.completions, []);
});

test('宿主回调抛出不会阻止终态清理', async () => {
  const f = fixture({ onComplete: () => { throw new Error('host callback'); } });
  await f.ready(); f.controller.skip();
  assert.equal(f.controller.getState().status, 'skipped');
  assert.equal(f.runtimes[0].disposed, true);
  assert.equal(f.frames.size + f.timers.size + f.listeners.size, 0);
  assert.match(f.errors[0].message, /host callback/);
});

test('不允许跳过时API跳过和寻帧同样受限，但可以暂停与正常完成', async () => {
  const f = fixture({}, false); await f.ready();
  f.controller.seek(61); f.controller.skip();
  assert.equal(f.controller.getState().elapsedSeconds, 0);
  assert.equal(f.controller.getState().status, 'playing');
  assert.deepEqual(f.completions, []);
  f.controller.pause(); assert.equal(f.controller.getState().status, 'paused');
  f.controller.resume(); f.advance(62_000);
  assert.deepEqual(f.completions, ['completed']);
});

test('终态之间更新hostVisible也保留给下一轮，destroy后所有操作失效', async () => {
  const f = fixture(); await f.ready(); f.controller.skip();
  f.controller.setHostVisible(false); f.controller.restart(); await f.ready();
  assert.equal(f.controller.getState().hostVisible, false);
  assert.equal(f.controller.getState().status, 'paused');
  f.controller.destroy();
  f.controller.restart(); f.controller.play(); f.controller.resume(); f.controller.seek(0); f.controller.skip(); f.controller.setHostVisible(true);
  assert.equal(f.controller.getState().status, 'destroyed');
  assert.equal(f.runtimes.length, 2);
});

test('加载中主动跳过会清理并拒绝ready，迟到加载不能触发第二次完成', async () => {
  const f = fixture();
  const rejected = assert.rejects(f.controller.ready, { name: 'AbortError' });
  f.controller.skip(); await rejected;
  assert.deepEqual(f.completions, ['skipped']);
  f.runtimes[0].resolve(); await Promise.resolve();
  assert.equal(f.controller.getState().status, 'skipped');
  assert.equal(f.frames.size + f.timers.size + f.listeners.size, 0);
});

test('onProgress中暂停、继续或同值寻帧不会同步递归通知', async () => {
  for (const action of ['pause', 'resume', 'seek'] as const) {
    let notifications = 0;
    const f = fixture({ onProgress: () => {
      notifications += 1;
      if (notifications > 10) throw new Error('recursive-progress');
      if (action === 'seek') f.controller.seek(0); else f.controller[action]();
    } });
    await f.ready();
    assert.equal(f.errors.length, 0, action);
    assert.equal(notifications, 1, action);
    f.controller.destroy();
  }
});

test('释放错误的onError中重播，不会让外层重播覆盖新ready或遗留渲染器', async () => {
  let throwOnce = true;
  const f = fixture({ onError: () => f.controller.restart() }, true, () => {
    if (throwOnce) { throwOnce = false; throw new Error('dispose failed once'); }
  });
  await f.ready();
  f.controller.restart();
  assert.equal(f.runtimes.slice(0, -1).every(runtime => runtime.disposed), true);
  await f.ready();
  assert.equal(f.controller.getState().status, 'playing');
  f.controller.destroy();
  assert.equal(f.runtimes.every(runtime => runtime.disposed), true);
  assert.equal(f.frames.size + f.timers.size + f.listeners.size, 0);
});
