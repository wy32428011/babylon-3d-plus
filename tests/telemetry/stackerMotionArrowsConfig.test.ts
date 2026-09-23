import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDefaultStackerMotionArrowsConfig, normalizeStackerMotionArrowsConfig, STACKER_MOTION_ARROW_CHANNELS } from '../../src/editor/model/stackerMotionArrows.ts';

test('缺省不启用堆垛机箭头，四路配置独立且升降默认使用竖直侧面', () => {
  for (const value of [undefined, null, false, [], 'arrow', 1, Object.create({ enabled: true })]) {
    assert.equal(normalizeStackerMotionArrowsConfig(value), undefined);
  }
  const first = createDefaultStackerMotionArrowsConfig();
  const second = createDefaultStackerMotionArrowsConfig();
  assert.equal(first.enabled, false);
  assert.equal(first.style, 'moving-double-arrow');
  assert.equal(first.breathingEnabled, false);
  for (const channel of STACKER_MOTION_ARROW_CHANNELS) {
    assert.equal(first.channels[channel].enabled, true);
    assert.equal(first.channels[channel].surfaceNode, '');
    assert.equal(first.channels[channel].face, channel === 'lift' ? 'side' : 'top');
    assert.notEqual(first.channels[channel], second.channels[channel]);
  }
  first.channels.travel.surfaceNode = 'Base';
  assert.equal(second.channels.travel.surfaceNode, '');
  assert.equal(first.channels.frontFork.surfaceNode, '');
});

test('归一化保留关闭、反向、自动尺寸和偏移，丢弃未知状态且幂等', () => {
  const input = {
    enabled: true, style: 'conveyor-arrow-double', speed: 0, opacity: 0, color: '#AABBCC',
    channels: { travel: { enabled: false, surfaceNode: ' Base ', reverse: true, face: 'side', offsetAlong: -3, offsetAcross: -0.2, length: 0, width: 0 } },
    preview: 1,
  };
  const result = normalizeStackerMotionArrowsConfig(input)!;
  assert.equal(result.enabled, true);
  assert.equal(result.channels.travel.enabled, false);
  assert.equal(result.channels.travel.surfaceNode, 'Base');
  assert.equal(result.channels.travel.reverse, true);
  assert.equal(result.channels.travel.face, 'side');
  assert.equal(result.channels.travel.offsetAlong, -3);
  assert.equal(result.channels.travel.offsetAcross, -0.2);
  assert.equal(result.channels.travel.length, 0);
  assert.equal(result.speed, 0);
  assert.equal(result.opacity, 0);
  assert.equal(result.color, '#aabbcc');
  assert.equal('preview' in result, false);
  assert.deepEqual(normalizeStackerMotionArrowsConfig(result), result);
  assert.notEqual(result.channels.travel, input.channels.travel);
});

test('非法样式和数值回退，尺寸透明度速度有界，升降保持竖直面', () => {
  const defaults = createDefaultStackerMotionArrowsConfig();
  const result = normalizeStackerMotionArrowsConfig({
    enabled: 'true', style: 'fire', color: 'url(script)', opacity: 9, speed: -1,
    arrowLength: 2, arrowWidth: -1, spacing: 0.1, breathingPeriod: Infinity,
    channels: { travel: { surfaceOffset: NaN, length: -1, width: 1e8, face: 'bottom' }, lift: { face: 'top' }, frontFork: [] },
  })!;
  assert.equal(result.enabled, false);
  assert.equal(result.style, defaults.style);
  assert.equal(result.color, defaults.color);
  assert.equal(result.opacity, 1);
  assert.equal(result.speed, 0);
  assert.equal(result.breathingPeriod, defaults.breathingPeriod);
  assert.equal(result.channels.travel.surfaceOffset, defaults.channels.travel.surfaceOffset);
  assert.equal(result.channels.travel.length, 0);
  assert.equal(result.channels.travel.width, 10000);
  assert.equal(result.channels.travel.face, 'top');
  assert.equal(result.channels.lift.face, 'side');
  assert.equal(result.channels.frontFork.enabled, true);
  assert.ok(result.spacing >= result.arrowLength + 0.02);
  assert.ok(result.arrowWidth > 0);
});

test('发光强度缺省为1，零值保留且独立于启用状态与透明度，非法值有限归一化', () => {
  assert.equal(createDefaultStackerMotionArrowsConfig().intensity, 1);
  assert.equal(normalizeStackerMotionArrowsConfig({ enabled: true })!.intensity, 1);
  for (const intensity of [undefined, NaN, Infinity, -Infinity, '2', null]) {
    assert.equal(normalizeStackerMotionArrowsConfig({ intensity })!.intensity, 1);
  }
  for (const enabled of [false, true]) {
    const result = normalizeStackerMotionArrowsConfig({ enabled, intensity: 0, opacity: 0.7 })!;
    assert.equal(result.intensity, 0);
    assert.equal(result.enabled, enabled);
    assert.equal(result.opacity, 0.7);
    assert.deepEqual(normalizeStackerMotionArrowsConfig(result), result);
  }
  assert.equal(normalizeStackerMotionArrowsConfig({ intensity: -2 })!.intensity, 0);
  assert.equal(normalizeStackerMotionArrowsConfig({ intensity: 30 })!.intensity, 10);
  const vivid = normalizeStackerMotionArrowsConfig({ intensity: 2.3, opacity: 0 })!;
  assert.equal(vivid.intensity, 2.3);
  assert.equal(vivid.opacity, 0);
});
