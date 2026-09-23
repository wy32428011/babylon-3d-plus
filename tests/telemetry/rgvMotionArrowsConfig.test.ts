import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDefaultRgvMotionArrowsConfig, normalizeRgvMotionArrowsConfig, RGV_MOTION_ARROW_CHANNELS } from '../../src/editor/model/rgvMotionArrows.ts';

test('旧场景缺省不启用 RGV 箭头，三路独立、默认顶部青蓝双箭头且关闭呼吸', () => {
  for (const value of [undefined, null, false, [], 'arrow', 1, Object.create({ enabled: true })]) {
    assert.equal(normalizeRgvMotionArrowsConfig(value), undefined);
  }
  const first = createDefaultRgvMotionArrowsConfig();
  const second = createDefaultRgvMotionArrowsConfig();
  assert.equal(first.enabled, false);
  assert.equal(first.style, 'moving-double-arrow');
  assert.equal(first.color, '#39d8ff');
  assert.equal(first.opacity, 0.9);
  assert.equal(first.breathingEnabled, false);
  assert.deepEqual(RGV_MOTION_ARROW_CHANNELS, ['travel', 'front', 'back']);
  for (const channel of RGV_MOTION_ARROW_CHANNELS) {
    assert.equal(first.channels[channel].enabled, true);
    assert.equal(first.channels[channel].surfaceNode, '');
    assert.equal(first.channels[channel].face, 'top');
    assert.notEqual(first.channels[channel], second.channels[channel]);
  }
  first.channels.travel.surfaceNode = 'Track';
  assert.equal(second.channels.travel.surfaceNode, '');
  assert.equal(first.channels.front.surfaceNode, '');
});

test('行走始终处于轨道正上方、居中并覆盖全长，输入侧面或偏移不能将箭头移到轨旁', () => {
  const result = normalizeRgvMotionArrowsConfig({ enabled: true, channels: {
    travel: { face: 'side', length: 8, offsetAlong: -3, offsetAcross: 2, width: 0.4, surfaceOffset: 0.03, surfaceNode: ' Track ', reverse: true },
    front: { face: 'side', length: 2, offsetAlong: -0.3, offsetAcross: 0.4, surfaceNode: ' FrontDeck ' },
    back: { enabled: false },
  } })!;
  assert.equal(result.channels.travel.face, 'top');
  assert.equal(result.channels.travel.length, 0);
  assert.equal(result.channels.travel.offsetAlong, 0);
  assert.equal(result.channels.travel.offsetAcross, 0);
  assert.equal(result.channels.travel.width, 0.4);
  assert.equal(result.channels.travel.surfaceOffset, 0.03);
  assert.equal(result.channels.travel.surfaceNode, 'Track');
  assert.equal(result.channels.travel.reverse, true);
  assert.equal(result.channels.front.face, 'side');
  assert.equal(result.channels.front.length, 2);
  assert.equal(result.channels.front.offsetAlong, -0.3);
  assert.equal(result.channels.front.offsetAcross, 0.4);
  assert.equal(result.channels.front.surfaceNode, 'FrontDeck');
  assert.equal(result.channels.back.enabled, false);
  assert.deepEqual(normalizeRgvMotionArrowsConfig(result), result);
});

test('归一化保留零值与关闭状态，未知预览和运行状态不会进入持久化配置', () => {
  const input = { enabled: false, speed: 0, opacity: 0, intensity: 0, color: '#AABBCC',
    channels: { front: { enabled: false, reverse: true, length: 0, width: 0 }, unexpected: { enabled: true } },
    preview: 1, activeDirection: -1,
  };
  const result = normalizeRgvMotionArrowsConfig(input)!;
  assert.equal(result.enabled, false);
  assert.equal(result.speed, 0);
  assert.equal(result.opacity, 0);
  assert.equal(result.intensity, 0);
  assert.equal(result.color, '#aabbcc');
  assert.equal(result.channels.front.enabled, false);
  assert.equal(result.channels.front.reverse, true);
  assert.equal(result.channels.front.length, 0);
  assert.equal(result.channels.front.width, 0);
  assert.equal('preview' in result, false);
  assert.equal('activeDirection' in result, false);
  assert.equal('unexpected' in result.channels, false);
  assert.notEqual(result.channels.front, input.channels.front);
});

test('非法样式和数值回退，范围、强度、透明度和流速归一化', () => {
  const defaults = createDefaultRgvMotionArrowsConfig();
  const result = normalizeRgvMotionArrowsConfig({ enabled: 'true', style: 'fire', color: 'url(script)',
    opacity: 9, speed: -1, intensity: 30, arrowLength: 2, arrowWidth: -1, spacing: 0.1,
    breathingPeriod: Infinity, channels: { travel: { surfaceOffset: NaN, width: 1e8 }, front: [], back: { length: -1, face: 'bottom' } },
  })!;
  assert.equal(result.enabled, false);
  assert.equal(result.style, defaults.style);
  assert.equal(result.color, defaults.color);
  assert.equal(result.opacity, 1);
  assert.equal(result.speed, 0);
  assert.equal(result.intensity, 10);
  assert.equal(result.breathingPeriod, defaults.breathingPeriod);
  assert.equal(result.channels.travel.surfaceOffset, defaults.channels.travel.surfaceOffset);
  assert.equal(result.channels.travel.width, 10000);
  assert.equal(result.channels.front.enabled, true);
  assert.equal(result.channels.back.length, 0);
  assert.equal(result.channels.back.face, 'top');
  assert.ok(result.spacing >= result.arrowLength + 0.02);
  assert.ok(result.arrowWidth > 0);
  for (const intensity of [undefined, NaN, Infinity, -Infinity, '2', null]) {
    assert.equal(normalizeRgvMotionArrowsConfig({ intensity })!.intensity, 1);
  }
  assert.equal(normalizeRgvMotionArrowsConfig({ intensity: -2 })!.intensity, 0);
  assert.equal(normalizeRgvMotionArrowsConfig({ intensity: 2.3 })!.intensity, 2.3);
});
