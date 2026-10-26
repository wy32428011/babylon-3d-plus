import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdaptiveResolutionController } from '../../src/runtime/babylon/AdaptiveResolutionController.ts';

function fixture(baseline = 1) {
  let level = baseline, reads = 0, resizeCount = 0, readFailures = 0;
  const writes: number[] = [];
  const engine = {
    getHardwareScalingLevel() { reads++; if (readFailures > 0) { readFailures--; throw new Error('get-level-failed'); } return level; },
    setHardwareScalingLevel(value: number) { writes.push(value); level = value; resizeCount++; },
    resize() { throw new Error('Babylon setter 已resize，不能重复调用'); },
  };
  return { engine, writes, current: () => level, external: (value: number) => { level = value; },
    reads: () => reads, resizes: () => resizeCount, failReads: (count: number) => { readFailures = count; } };
}

test('默认关闭不修改Engine或逐帧读取等级，重复状态复用快照', () => {
  const f = fixture(), controller = new AdaptiveResolutionController(f.engine);
  const snapshot = controller.getSnapshot();
  for (let now = 0; now < 10; now++) assert.equal(controller.update({ enabled: false, moving: true, now }), snapshot);
  assert.deepEqual(f.writes, []); assert.equal(f.reads(), 1); assert.equal(f.resizes(), 0);
  assert.equal(snapshot.enabled, false); assert.equal(snapshot.reduced, false);
  assert.ok(Object.isFrozen(snapshot)); controller.dispose();
});

test('运动倍率相对初始等级，重复运动不重复set/resize，静止500ms准确恢复', () => {
  const f = fixture(0.5), controller = new AdaptiveResolutionController(f.engine);
  controller.update({ enabled: true, moving: true, now: 100 });
  assert.equal(f.current(), 0.75);
  controller.update({ enabled: true, moving: true, now: 116 });
  controller.update({ enabled: true, moving: false, now: 200 });
  assert.equal(controller.getSnapshot().status, 'waiting');
  controller.update({ enabled: true, moving: false, now: 615 });
  assert.equal(f.current(), 0.75);
  controller.update({ enabled: true, moving: false, now: 616 });
  controller.update({ enabled: true, moving: false, now: 700 });
  assert.deepEqual(f.writes, [0.75, 0.5]); assert.equal(f.resizes(), 2);
  assert.equal(controller.getSnapshot().status, 'baseline'); controller.dispose();
});

test('等待期间恢复运动重置静止期限，零等待和倍率1均有明确行为', () => {
  const f = fixture(), controller = new AdaptiveResolutionController(f.engine);
  controller.update({ enabled: true, moving: true, now: 0 });
  controller.update({ enabled: true, moving: false, now: 499 });
  controller.update({ enabled: true, moving: true, now: 500 });
  controller.update({ enabled: true, moving: false, now: 999 });
  assert.equal(f.current(), 1.5);
  controller.update({ enabled: true, moving: false, now: 1000 }); assert.equal(f.current(), 1);
  controller.dispose();
  const instant = new AdaptiveResolutionController(f.engine, { idleRestoreMs: 0 });
  instant.update({ enabled: true, moving: true, now: 0 });
  instant.update({ enabled: true, moving: false, now: 0 }); assert.equal(f.current(), 1); instant.dispose();
  const same = fixture(), noOp = new AdaptiveResolutionController(same.engine, { motionScale: 1 });
  noOp.update({ enabled: true, moving: true, now: 0 }); noOp.dispose(); assert.deepEqual(same.writes, []);
});

test('禁用和dispose立即还原，dispose重复或后续update都不再改Engine', () => {
  const f = fixture(), controller = new AdaptiveResolutionController(f.engine);
  controller.update({ enabled: true, moving: true, now: 0 });
  controller.update({ enabled: false, moving: true, now: 1 }); assert.equal(f.current(), 1);
  controller.update({ enabled: true, moving: true, now: 2 }); controller.dispose();
  assert.deepEqual(f.writes, [1.5, 1, 1.5, 1]);
  controller.dispose(); controller.update({ enabled: true, moving: true, now: 3 }); controller.onContextRestored();
  assert.deepEqual(f.writes, [1.5, 1, 1.5, 1]); assert.equal(controller.getSnapshot().disposed, true);
});

test('上下文恢复先还原并暂停本周期，必须关到开才重新接管', () => {
  const f = fixture(), controller = new AdaptiveResolutionController(f.engine);
  controller.update({ enabled: true, moving: true, now: 100 }); controller.onContextRestored();
  assert.equal(f.current(), 1); assert.equal(controller.getSnapshot().suspended, true);
  controller.update({ enabled: true, moving: true, now: 0 }); assert.deepEqual(f.writes, [1.5, 1]);
  controller.update({ enabled: false, moving: false, now: 1 });
  controller.update({ enabled: true, moving: true, now: 2 }); assert.equal(f.current(), 1.5); controller.dispose();
});

test('外部owner改过等级后立即让出，禁用/恢复/销毁不能覆盖它', () => {
  const f = fixture(), controller = new AdaptiveResolutionController(f.engine);
  controller.update({ enabled: true, moving: true, now: 0 }); f.external(2);
  controller.update({ enabled: true, moving: true, now: 1 });
  assert.equal(controller.getSnapshot().status, 'yielded'); assert.equal(controller.getSnapshot().reduced, false);
  controller.update({ enabled: false, moving: false, now: 2 }); controller.onContextRestored(); controller.dispose();
  assert.equal(f.current(), 2); assert.deepEqual(f.writes, [1.5]);
});

test('尚未接管时也尊重外部改值，回到初始等级后仍需显式重启本周期', () => {
  const f = fixture(), controller = new AdaptiveResolutionController(f.engine); f.external(2);
  controller.update({ enabled: true, moving: true, now: 0 }); assert.deepEqual(f.writes, []);
  f.external(1); controller.update({ enabled: true, moving: true, now: 1 }); assert.deepEqual(f.writes, []);
  controller.update({ enabled: false, moving: false, now: 2 });
  controller.update({ enabled: true, moving: true, now: 3 }); assert.deepEqual(f.writes, [1.5]); controller.dispose();
});

test('严格拒绝配置范围和无效初始等级，配置错误不触碰Engine', () => {
  for (const motionScale of [0.99, 2.01, NaN, Infinity]) {
    const f = fixture(); assert.throws(() => new AdaptiveResolutionController(f.engine, { motionScale }), /motionScale/);
    assert.equal(f.reads(), 0); assert.deepEqual(f.writes, []);
  }
  for (const idleRestoreMs of [-1, 0.5, 5001, NaN]) assert.throws(() => new AdaptiveResolutionController(fixture().engine, { idleRestoreMs }), /idleRestoreMs/);
  for (const baseline of [0, -1, NaN, Infinity]) assert.throws(() => new AdaptiveResolutionController(fixture(baseline).engine), /hardwareScalingLevel/);
});

test('非法时钟或倒退在持有低分辨率时恢复初始等级并显式报告错误', () => {
  for (const now of [NaN, -1, 99]) {
    const f = fixture(), controller = new AdaptiveResolutionController(f.engine);
    controller.update({ enabled: true, moving: true, now: 100 });
    const snapshot = controller.update({ enabled: true, moving: true, now });
    assert.equal(f.current(), 1); assert.equal(snapshot.status, 'faulted'); assert.equal(snapshot.errorCount, 1);
    assert.match(snapshot.lastError!, /单调/); controller.dispose();
  }
});

test('setter在改值后抛错也能验证并恢复，坏诊断回调不覆盖原错误', () => {
  const f = fixture(), original = f.engine.setHardwareScalingLevel;
  let once = true;
  f.engine.setHardwareScalingLevel = level => { original(level); if (once) { once = false; throw new Error('setter-after-change'); } };
  const controller = new AdaptiveResolutionController(f.engine, { onError() { throw new Error('bad-diagnostic'); } });
  const snapshot = controller.update({ enabled: true, moving: true, now: 0 });
  assert.equal(f.current(), 1); assert.deepEqual(f.writes, [1.5, 1]);
  assert.equal(snapshot.errorCount, 1); assert.equal(snapshot.diagnosticErrorCount, 1);
  assert.equal(snapshot.lastError, 'setter-after-change'); assert.equal(snapshot.restorationPending, false);
  controller.dispose();
});

test('setter在修改前失败不产生伪还原写入，短暂getter异常可恢复', () => {
  const f = fixture(), original = f.engine.setHardwareScalingLevel;
  let once = true;
  f.engine.setHardwareScalingLevel = level => { if (once) { once = false; throw new Error('setter-before-change'); } original(level); };
  const controller = new AdaptiveResolutionController(f.engine);
  controller.update({ enabled: true, moving: true, now: 0 }); assert.deepEqual(f.writes, []);
  controller.update({ enabled: false, moving: false, now: 1 }); controller.update({ enabled: true, moving: true, now: 2 });
  f.failReads(1); controller.update({ enabled: true, moving: true, now: 3 });
  assert.equal(f.current(), 1); assert.deepEqual(f.writes, [1.5, 1]); controller.dispose();
});

test('getter持续不可用时报告待恢复，恢复读取后不能覆盖期间外部owner的新等级', () => {
  const f = fixture(), controller = new AdaptiveResolutionController(f.engine);
  controller.update({ enabled: true, moving: true, now: 0 }); f.failReads(2);
  let snapshot = controller.update({ enabled: true, moving: true, now: 1 });
  assert.equal(snapshot.restorationPending, true); assert.equal(f.current(), 1.5); assert.deepEqual(f.writes, [1.5]);
  f.external(2); snapshot = controller.update({ enabled: false, moving: false, now: 2 });
  assert.equal(snapshot.restorationPending, false); assert.equal(f.current(), 2); assert.deepEqual(f.writes, [1.5]); controller.dispose();
});

test('setter同步观察者已改为其它等级时不冒认所有权，后续销毁保持外部等级', () => {
  const f = fixture(), original = f.engine.setHardwareScalingLevel;
  f.engine.setHardwareScalingLevel = level => { original(level); f.external(2); };
  const controller = new AdaptiveResolutionController(f.engine);
  const snapshot = controller.update({ enabled: true, moving: true, now: 0 });
  assert.equal(snapshot.status, 'yielded'); assert.equal(snapshot.suspended, true); assert.equal(snapshot.reduced, false);
  controller.dispose(); assert.equal(f.current(), 2); assert.deepEqual(f.writes, [1.5]);
});

test('dispose还原过程的单次写入异常重试恢复，持续写入不可用则显式待恢复', () => {
  for (const failureCount of [1, Infinity]) {
    const f = fixture(), original = f.engine.setHardwareScalingLevel;
    let remaining = failureCount;
    f.engine.setHardwareScalingLevel = level => {
      if (level === 1 && remaining > 0) { remaining--; throw new Error('restore-setter-failed'); }
      original(level);
    };
    const controller = new AdaptiveResolutionController(f.engine);
    controller.update({ enabled: true, moving: true, now: 0 }); controller.dispose();
    const snapshot = controller.getSnapshot();
    assert.equal(snapshot.disposed, true); assert.ok(snapshot.errorCount > 0);
    assert.equal(f.current(), failureCount === 1 ? 1 : 1.5);
    assert.equal(snapshot.restorationPending, failureCount !== 1);
  }
});
