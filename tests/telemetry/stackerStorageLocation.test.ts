import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveStackerStorageTargetOffsets } from '../../src/runtime/babylon/telemetry/stackerStorageLocation';

test('目标库位世界坐标必须相对货叉初始锚点换算行走与升降偏移', () => {
  assert.equal(typeof resolveStackerStorageTargetOffsets, 'function');
  const offsets = resolveStackerStorageTargetOffsets({
    targetTravelCoordinate: 4,
    targetLiftCoordinate: 1.2,
    referenceTravelCoordinate: -7.8385433618,
    referenceLiftCoordinate: 0.8921632311,
  });
  assert.ok(Math.abs(offsets.travelOffset - 11.8385433618) < 1e-9);
  assert.ok(Math.abs(offsets.liftOffset - 0.3078367689) < 1e-9);
});
