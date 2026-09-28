import assert from 'node:assert/strict';
import test from 'node:test';
import { getPackageTimelineFrame, getOpeningRoutePoint, resolveOpeningStage } from '../../src/runtime/opening/openingPackageTimeline.ts';

const stages = [
  { id: 'brand', label: '品牌', durationSeconds: 2, title: '默认', titleKey: 'brandTitle' },
  { id: 'skip', label: '跳过', durationSeconds: 0 },
  { id: 'park', label: '园区', durationSeconds: 5 },
];

test('任意分镜按保存顺序播放，零秒跳过且没有九段假设', () => {
  assert.equal(getPackageTimelineFrame(1, stages, .5).stageId, 'brand');
  assert.equal(getPackageTimelineFrame(2, stages, .5).stageId, 'park');
  assert.equal(getPackageTimelineFrame(3, stages, .5).stageElapsedSeconds, 1);
  assert.equal(getPackageTimelineFrame(3, stages, .5).totalDurationSeconds, 7);
  assert.equal(getPackageTimelineFrame(6.75, stages, .5).opacity, .5);
  assert.equal(getPackageTimelineFrame(7, stages, .5).phase, 'complete');
  assert.equal(getPackageTimelineFrame(7, stages, .5).opacity, 0);
});

test('空时长、越界和低动态取帧始终返回有限数值', () => {
  for (const input of [-1, NaN, Infinity, 0, 10]) {
    const frame = getPackageTimelineFrame(input, [{ id: 'zero', label: '', durationSeconds: 0 }], 0);
    assert.equal(frame.phase, 'complete');
    assert.ok(Number.isFinite(frame.progress)); assert.ok(Number.isFinite(frame.stageProgress));
  }
  const zeroTail = [...stages, { id: 'tail', label: '零秒尾段', durationSeconds: 0 }];
  const final = getPackageTimelineFrame(7, zeroTail, .8);
  assert.equal(final.stageId, 'park'); assert.equal(final.stageProgress, 1);
});

test('场景实例的参数只作用于引用字段并保留显式空文字', () => {
  const first = resolveOpeningStage(stages[0], { brandTitle: '甲场景' });
  const second = resolveOpeningStage(stages[0], { brandTitle: '' });
  assert.equal(first.title, '甲场景'); assert.equal(second.title, ''); assert.equal(stages[0].title, '默认');
});

test('曲率仅改变飞线中点，两端严格保持画面 UV', () => {
  const route = { from: { x: .2, y: .5 }, to: { x: .8, y: .5 }, curvature: .3 };
  assert.deepEqual(getOpeningRoutePoint(route, 0), route.from);
  assert.deepEqual(getOpeningRoutePoint(route, 1), route.to);
  assert.ok(getOpeningRoutePoint(route, .5).y < .5);
  assert.equal(getOpeningRoutePoint({ ...route, curvature: 0 }, .5).y, .5);
});
