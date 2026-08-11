import assert from 'node:assert/strict';
import test from 'node:test';
import { createGroupSpatialInfo } from '../../src/editor/model/groupSpatialInfo.ts';

test('空群组没有可展示的空间信息', () => {
  assert.deepEqual(createGroupSpatialInfo([], null), {
    status: 'unavailable',
    memberCount: 0,
    center: null,
    sizeMeters: null,
  });
});

test('全部成员包围盒就绪时返回世界中心和包围尺寸', () => {
  const info = createGroupSpatialInfo(['first', 'second', 'first'], {
    center: { x: 12.5, y: 3, z: -4.25 },
    sizeMeters: { x: 8, y: 2.5, z: 6 },
    geometryReady: true,
    requestedEntityCount: 2,
    resolvedEntityCount: 2,
    geometryReadyEntityCount: 2,
  });

  assert.deepEqual(info, {
    status: 'ready',
    memberCount: 2,
    center: { x: 12.5, y: 3, z: -4.25 },
    sizeMeters: { x: 8, y: 2.5, z: 6 },
  });
});

test('成员仍在加载或包围盒未完整解析时保持 loading', () => {
  assert.deepEqual(createGroupSpatialInfo(['first', 'second'], {
    center: { x: 1, y: 2, z: 3 },
    sizeMeters: { x: 4, y: 5, z: 6 },
    geometryReady: false,
    requestedEntityCount: 2,
    resolvedEntityCount: 1,
    geometryReadyEntityCount: 1,
  }), {
    status: 'loading',
    memberCount: 2,
    center: null,
    sizeMeters: null,
  });
});

test('非有限包围盒不会泄露到 Inspector', () => {
  assert.equal(createGroupSpatialInfo(['first'], {
    center: { x: Number.NaN, y: 0, z: 0 },
    sizeMeters: { x: 1, y: 1, z: 1 },
    geometryReady: true,
    requestedEntityCount: 1,
    resolvedEntityCount: 1,
    geometryReadyEntityCount: 1,
  }).status, 'loading');
});
