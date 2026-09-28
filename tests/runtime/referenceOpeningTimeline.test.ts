import assert from 'node:assert/strict';
import test from 'node:test';
import { createDefaultReferenceOpening } from '../../src/editor/model/sceneOpeningReference.ts';
import { getReferenceOpeningFrame, getReferenceStageStart } from '../../src/runtime/opening/referenceOpeningTimeline.ts';

test('九段默认时刻精确对齐用户 HTML 的 62 秒轴', () => {
  const settings = createDefaultReferenceOpening();
  assert.deepEqual(Array.from({ length: 10 }, (_, index) => getReferenceStageStart(index, settings)), [0, 9, 16, 24, 30, 34, 42, 48, 54, 62]);
  for (const seconds of [0, 4, 9, 12, 16, 20, 24, 28, 30, 32, 34, 38, 42, 45, 48, 51, 54, 59]) {
    const frame = getReferenceOpeningFrame(seconds, settings);
    assert.equal(frame.referenceSeconds, seconds);
    assert.equal(frame.opacity, 1);
  }
  assert.equal(getReferenceOpeningFrame(32, settings).phase, 'jiangsu-highlight');
  assert.equal(getReferenceOpeningFrame(38, settings).phase, 'china-routes');
});

test('国内业务停留增减独立调整后续实际时刻而不改绘制路径', () => {
  const settings = createDefaultReferenceOpening();
  settings.stageDurations[5] = 28;
  const midpoint = getReferenceOpeningFrame(48, settings);
  assert.equal(midpoint.referenceSeconds, 38);
  assert.equal(midpoint.chinaHoldElapsedSeconds, 14);
  assert.equal(midpoint.chinaHoldProgress, .5);
  assert.equal(midpoint.totalDurationSeconds, 82);
  assert.equal(getReferenceOpeningFrame(62, settings).referenceSeconds, 42);
});

test('零秒业务段直接跳过，跨段和末帧均为有限值', () => {
  const settings = createDefaultReferenceOpening();
  settings.stageDurations[2] = 0;
  settings.stageDurations[5] = 0;
  assert.equal(getReferenceOpeningFrame(16, settings).stageIndex, 3);
  assert.equal(getReferenceOpeningFrame(16, settings).referenceSeconds, 22.8);
  assert.equal(getReferenceOpeningFrame(26, settings).stageIndex, 6);
  assert.equal(getReferenceOpeningFrame(26, settings).referenceSeconds, 40.2);
  assert.equal(getReferenceOpeningFrame(46, settings).phase, 'complete');
  for (const seconds of [-1, 0, 16, 26, 40, 45.9, 46, 999, NaN]) {
    const frame = getReferenceOpeningFrame(seconds, settings);
    assert.ok(Number.isFinite(frame.referenceSeconds));
    assert.ok(frame.opacity >= 0 && frame.opacity <= 1);
    assert.ok(frame.progress >= 0 && frame.progress <= 1);
  }
});

test('最终短交接保持默认前61.2秒完整亮度并在末帧完全透明', () => {
  const settings = createDefaultReferenceOpening();
  assert.equal(getReferenceOpeningFrame(61, settings).opacity, 1);
  const fading = getReferenceOpeningFrame(61.6, settings);
  assert.equal(fading.phase, 'handoff');
  assert.ok(Math.abs(fading.opacity - .5) < 1e-10);
  const finished = getReferenceOpeningFrame(62, settings);
  assert.equal(finished.phase, 'complete');
  assert.equal(finished.opacity, 0);
  assert.equal(finished.progress, 1);
});
