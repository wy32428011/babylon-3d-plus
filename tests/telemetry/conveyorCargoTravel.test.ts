import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CONVEYOR_CARGO_FALLBACK_SPAN_METERS,
  resolveConveyorCargoTravelHalfRange,
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
