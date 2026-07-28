import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CONVEYOR_CARGO_FALLBACK_SPAN_METERS,
  resolveConveyorCargoTravelHalfRange,
  wrapConveyorCargoOffset,
} from '../../src/runtime/babylon/telemetry/conveyorCargoTravel';

const CARGO_LENGTH = 0.72;

test('拉长后的输送线行程半径 = 跨度/2 − 货箱半长', () => {
  assert.ok(Math.abs(resolveConveyorCargoTravelHalfRange(5, CARGO_LENGTH) - 2.14) < 1e-9);
  assert.ok(Math.abs(resolveConveyorCargoTravelHalfRange(1.483953, CARGO_LENGTH) - 0.3819765) < 1e-9);
});

test('跨度不大于货箱长度时行程半径防御为下限值', () => {
  assert.equal(resolveConveyorCargoTravelHalfRange(0.5, CARGO_LENGTH), 0.01);
  assert.equal(resolveConveyorCargoTravelHalfRange(0, CARGO_LENGTH), CONVEYOR_CARGO_FALLBACK_SPAN_METERS / 2 - CARGO_LENGTH / 2);
  assert.equal(resolveConveyorCargoTravelHalfRange(NaN, CARGO_LENGTH), CONVEYOR_CARGO_FALLBACK_SPAN_METERS / 2 - CARGO_LENGTH / 2);
});

test('货箱偏移在 [-halfRange, +halfRange) 内对称回绕', () => {
  const halfRange = resolveConveyorCargoTravelHalfRange(5, CARGO_LENGTH);
  assert.ok(Math.abs(wrapConveyorCargoOffset(0, halfRange)) < 1e-9);
  assert.ok(Math.abs(wrapConveyorCargoOffset(2.14, halfRange) - (-2.14)) < 1e-9);
  assert.ok(Math.abs(wrapConveyorCargoOffset(2.5, halfRange) - (-1.78)) < 1e-9);
  assert.ok(Math.abs(wrapConveyorCargoOffset(-2.5, halfRange) - 1.78) < 1e-9);
  assert.ok(Math.abs(wrapConveyorCargoOffset(2.14 + 4.28 * 3, halfRange) - (-2.14)) < 1e-9);
});

test('非法偏移归零，非法半径回退下限', () => {
  assert.equal(wrapConveyorCargoOffset(NaN, 2.14), 0);
  assert.equal(wrapConveyorCargoOffset(Infinity, 2.14), 0);
  assert.ok(Math.abs(wrapConveyorCargoOffset(0.005, 0) - 0.005) < 1e-9);
  assert.ok(Math.abs(wrapConveyorCargoOffset(0.02, -1)) < 1e-9);
});
