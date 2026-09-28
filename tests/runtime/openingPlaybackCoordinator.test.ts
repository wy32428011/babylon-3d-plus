import assert from 'node:assert/strict';
import test from 'node:test';
import { OpeningPlaybackCoordinator, type OpeningTerminal } from '../../src/shared/opening/OpeningPlaybackCoordinator.ts';

function fixture({ enabled = true, visible = Promise.resolve(true), fail = false } = {}) {
  const active: boolean[] = [], terminal: OpeningTerminal[] = [], errors: unknown[] = [];
  let starts = 0, disposals = 0, complete = () => {};
  const controller = new OpeningPlaybackCoordinator({
    enabled, waitUntilVisible: () => visible,
    createRuntime(done) {
      if (fail) throw new Error('fixture visual failure');
      complete = done;
      return { start() { starts++; }, skip() { done(); }, pause() {}, resume() {}, dispose() { disposals++; } };
    },
    onActiveChange: value => active.push(value), onTerminal: value => terminal.push(value), onError: e => errors.push(e),
  });
  return { controller, active, terminal, errors, complete: () => complete(), starts: () => starts, disposals: () => disposals };
}

test('关闭开场时不创建视觉运行时，不阻塞普通入场', async () => {
  const f = fixture({ enabled: false }); await f.controller.start();
  assert.equal(f.starts(), 0); assert.deepEqual(f.terminal, ['disabled']); assert.deepEqual(f.active, []);
});
test('可见性确认之前保持等待，确认后只启动一次', async () => {
  let resolve!: (value: boolean) => void;
  const f = fixture({ visible: new Promise<boolean>(r => { resolve = r; }) });
  const starting = f.controller.start(); void f.controller.start();
  assert.deepEqual(f.active, [true]); assert.equal(f.starts(), 0);
  resolve(true); await starting; assert.equal(f.starts(), 1);
  f.complete(); f.complete(); await Promise.resolve();
  assert.deepEqual(f.terminal, ['completed']); assert.deepEqual(f.active, [true, false]); assert.equal(f.disposals(), 1);
});
test('旧宿主未确认可见时跳过，释放等待', async () => {
  const f = fixture({ visible: Promise.resolve(false) }); await f.controller.start();
  assert.equal(f.starts(), 0); assert.deepEqual(f.terminal, ['skipped']); assert.deepEqual(f.active, [true, false]);
});
test('等待期间取消，迟到可见回调不得启动旧场景', async () => {
  let resolve!: (value: boolean) => void;
  const f = fixture({ visible: new Promise<boolean>(r => { resolve = r; }) });
  const starting = f.controller.start(); f.controller.cancel(); resolve(true); await starting;
  assert.equal(f.starts(), 0); assert.deepEqual(f.terminal, ['cancelled']);
});
test('跳过完成保留 skipped 结果，并且只释放一次', async () => {
  const f = fixture(); await f.controller.start(); f.controller.skip(); f.controller.dispose(); await Promise.resolve();
  assert.deepEqual(f.terminal, ['skipped']); assert.equal(f.disposals(), 1);
});
test('渲染创建失败有诊断且不锁住相机', async () => {
  const f = fixture({ fail: true }); await f.controller.start();
  assert.equal(f.errors.length, 1); assert.deepEqual(f.terminal, ['failed']); assert.deepEqual(f.active, [true, false]);
});
test('已经销毁的实例不能开始播放', async () => {
  const f = fixture(); f.controller.dispose(); await f.controller.start();
  assert.equal(f.starts(), 0); assert.deepEqual(f.active, []);
});

test('相机接管回调失败仍释放HUD并通知终态', async () => {
  const errors: unknown[] = [], terminal: OpeningTerminal[] = [];
  const active: boolean[] = [];
  const controller = new OpeningPlaybackCoordinator({
    enabled: true, waitUntilVisible: async () => true,
    createRuntime: () => { throw new Error('不应创建'); },
    onActiveChange(value) { active.push(value); if (value) throw new Error('相机接管失败'); },
    onError: error => errors.push(error), onTerminal: value => terminal.push(value),
  });
  await controller.start();
  assert.deepEqual(active, [true, false]); assert.equal(errors.length, 1); assert.deepEqual(terminal, ['failed']);
});
