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

const pointBinding = { mode: 'point', field: 'motor.direction', forwardValue: 'F', reverseValue: 'R', stopValue: 'S' };
test('精确点位自定义正反停，忽略原movement，未命中隐藏', () => {
  for (const [value, direction] of [['F', 1], ['R', -1], ['S', 0], ['unknown', 0]]) {
    const result = resolve(snapshot(2, { fields: { movement_x: 2, 'motor.direction': value } }), { directionBinding: pointBinding });
    assert.equal(result.direction, direction, String(value));
  }
  assert.equal(resolve(snapshot(1), { directionBinding: pointBinding }).status, 'missing');
  assert.equal(resolve(snapshot(1, { fields: { 'motor.direction': 'unknown' } }), { directionBinding: pointBinding }).status, 'unmatched');
});

test('点位值保留前导零，数字/布尔以标量文本比较，不对字符串作数值转换', () => {
  const numeric = { ...pointBinding, forwardValue: '01', reverseValue: '1', stopValue: 'false' };
  for (const [value, expected] of [['01', 1], [1, -1], ['1', -1], [false, 0]]) {
    assert.equal(resolve(snapshot(0, { fields: { 'motor.direction': value } }), { directionBinding: numeric }).direction, expected);
  }
});

test('配置空值/冲突时不猜方向，自定义映射仍遵守故障与过期', () => {
  const data = snapshot(1, { fields: { 'motor.direction': 'F' } });
  for (const directionBinding of [{ ...pointBinding, field: '' }, { ...pointBinding, reverseValue: 'F' }, { ...pointBinding, stopValue: '' }]) {
    assert.equal(resolve(data, { directionBinding }).status, 'invalid');
  }
  assert.equal(resolve(data, { directionBinding: pointBinding, now: 14000 }).status, 'stale');
  assert.equal(resolve({ ...data, faulted: true }, { directionBinding: pointBinding }).status, 'faulted');
  assert.equal(resolve(data, { directionBinding: pointBinding, trajectoryDirection: '-x' }).direction, -1);
});
