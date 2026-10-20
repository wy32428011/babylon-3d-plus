import assert from 'node:assert/strict';
import test from 'node:test';

import { Vector3 } from '@babylonjs/core';

import {
  CONVEYOR_CARGO_FALLBACK_SPAN_METERS,
  resolveConveyorCargoTravelHalfRange,
  resolvePerpendicularHandoffOffset,
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

test('直角相邻：交付落点取两条中心轨迹交叉点沿下游轴的偏移', () => {
  // 上游沿 +X、中心 (0,0,0)；下游沿 +Z、中心 (0.5,0,0.8) → 交叉点 (0.5,0,0)，下游偏移 -0.8
  const offset = resolvePerpendicularHandoffOffset(
    { center: new Vector3(0, 0, 0), axis: new Vector3(1, 0, 0), halfSpanMeters: 2 },
    { center: new Vector3(0.5, 0, 0.8), axis: new Vector3(0, 0, 1), halfSpanMeters: null },
    1.64,
  );
  assert.ok(offset !== null && Math.abs(offset + 0.8) < 1e-9, `下游偏移应为 -0.8，实际 ${offset}`);
});

test('直角过渡段：交叉点超出正常停靠点但在允许外伸量内仍返回拐角偏移', () => {
  // 上游沿 +X、中心 (0,0,0)；下游沿 +Z、中心 (0.5,0,0.8) → 交叉点沿下游偏移 -0.8
  const upstream = { center: new Vector3(0, 0, 0), axis: new Vector3(1, 0, 0), halfSpanMeters: 2 };
  const downstream = { center: new Vector3(0.5, 0, 0.8), axis: new Vector3(0, 0, 1), halfSpanMeters: null };
  // 正常行程半径 0.125，端面外过渡段 + 一个货箱长度 = 1.08
  assert.equal(resolvePerpendicularHandoffOffset(upstream, downstream, 0.125), null);
  const offset = resolvePerpendicularHandoffOffset(upstream, downstream, 0.125, 1.08);
  assert.ok(offset !== null && Math.abs(offset + 0.8) < 1e-9, `应允许拐角落点，实际 ${offset}`);
});

test('直角交接兜底：平行、非直角、超出行程、层高不一致、上游过远均返回 null', () => {
  const upstream = { center: new Vector3(0, 0, 0), axis: new Vector3(1, 0, 0), halfSpanMeters: 2 };
  const downstreamAt = (center: Vector3, axis = new Vector3(0, 0, 1)) => ({ center, axis, halfSpanMeters: null });

  assert.equal(resolvePerpendicularHandoffOffset(upstream, downstreamAt(new Vector3(0, 0, 0), new Vector3(1, 0, 0)), 2), null);
  assert.equal(resolvePerpendicularHandoffOffset(upstream, downstreamAt(new Vector3(0, 0, 0), new Vector3(Math.SQRT1_2, 0, Math.SQRT1_2)), 2), null);
  assert.equal(resolvePerpendicularHandoffOffset(upstream, downstreamAt(new Vector3(0, 0, 3)), 2), null, '交叉点超出下游行程');
  assert.equal(resolvePerpendicularHandoffOffset(upstream, downstreamAt(new Vector3(0, 1, 0)), 2), null, '层高差异过大');
  assert.equal(resolvePerpendicularHandoffOffset(upstream, downstreamAt(new Vector3(5, 0, 0)), 10), null, '交叉点远离上游');
});
