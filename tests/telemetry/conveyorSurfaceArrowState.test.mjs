import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConveyorArrowModules } from '../helpers/conveyorSurfaceArrowModules.mjs';

const [motion, arrows] = await loadConveyorArrowModules([
  'src/runtime/babylon/telemetry/conveyorMotionSignal.ts',
  'src/runtime/babylon/telemetry/conveyorSurfaceArrowState.ts',
]);
const config = { axis: 'x', fields: ['movement_x'], actionMap: { 0: 0, 1: 1, 2: -1 } };
const binding = { sourceId: 'default', deviceType: 'conveyor', assetCode: '0001', staleAfterMs: 2000, key: 'test' };
const snapshot = (movement, extra = {}) => ({ ...binding, receivedAt: 10000, faulted: false, fields: { movement_x: movement }, ...extra });
const resolve = (value, options = {}) => arrows.resolveConveyorSurfaceArrowState({ binding, snapshot: value, config, trajectoryDirection: 'x', now: 11000, conflict: false, ...options });

test('默认 MQTT 正反停，不以 mode 和货物自驱推断显示', () => {
  assert.equal(resolve(snapshot(1)).direction, 1);
  assert.equal(resolve(snapshot(2)).direction, -1);
  assert.equal(resolve(snapshot(0)).status, 'stopped');
  assert.equal(resolve(snapshot(1, { fields: { movement_x: 1, mode: 2 } })).direction, 1);
  assert.equal(resolve(snapshot(0, { fields: { movement_x: 0, task: 7 } })).direction, 0);
});

test('失效状态均隐藏，过期边界和恢复按绑定时效计算', () => {
  assert.equal(resolve(null).status, 'waiting');
  assert.equal(resolve(snapshot(1), { binding: null }).status, 'unbound');
  assert.equal(resolve(snapshot(1), { conflict: true }).status, 'conflict');
  assert.equal(resolve(snapshot(1, { faulted: true })).status, 'faulted');
  assert.equal(resolve(snapshot(1), { now: 12000 }).direction, 1);
  assert.equal(resolve(snapshot(1), { now: 12001 }).status, 'stale');
  assert.equal(resolve(snapshot(2, { receivedAt: 12000 }), { now: 12001 }).direction, -1);
  for (const fields of [{}, { movement_x: 'invalid' }, { movement_x: null }]) {
    assert.equal(resolve(snapshot(1, { fields })).status, 'missing');
  }
});

test('原有 actionMap 优先级、数值兼容与运动倍率保持，箭头只取符号', () => {
  const custom = { ...config, fields: ['a', 'b'], actionMap: { 7: -3 } };
  assert.equal(motion.readConveyorMotionSignal({ a: '7', b: 1 }, custom).direction, -3);
  assert.equal(resolve(snapshot(7), { config: { ...config, actionMap: { 7: -3 } } }).direction, -1);
  assert.equal(motion.readConveyorMotionSignal({ a: 'bad', b: 2 }, custom).direction, -1);
  assert.equal(motion.readConveyorMotionSignal({ movement_x: 5 }, config).direction, 1);
  assert.equal(motion.readConveyorMotionSignal({ movement_x: -5 }, config).direction, -1);
});

test('本地正向校准与货物同源，错配轴保留现有回退语义', () => {
  assert.equal(resolve(snapshot(1), { trajectoryDirection: '-x' }).direction, -1);
  assert.equal(resolve(snapshot(2), { trajectoryDirection: '-x' }).direction, 1);
  assert.equal(resolve(snapshot(1), { trajectoryDirection: '-z' }).direction, 1);
  assert.equal(resolve(snapshot(1), { trajectoryDirection: '-z', config: { ...config, axis: 'z' } }).direction, -1);
});
