import assert from 'node:assert/strict';
import test from 'node:test';
import { CONVEYOR_ARROW_EFFECT_KINDS, createDefaultConveyorArrowEffect, isConveyorArrowEffectKind, sanitizeConveyorArrowEffect } from '../../src/editor/model/conveyorArrowEffect.ts';
import { createDefaultConveyorSurfaceArrowsConfig, normalizeConveyorSurfaceArrowsConfig } from '../../src/editor/model/conveyorSurfaceArrows.ts';

test('六类默认配置独立，未知类型不进入箭头白名单', () => {
  for (const kind of CONVEYOR_ARROW_EFFECT_KINDS) {
    assert.equal(isConveyorArrowEffectKind(kind), true);
    const first = createDefaultConveyorArrowEffect(kind);
    const second = createDefaultConveyorArrowEffect(kind);
    first.width = 100;
    assert.notEqual(first.width, second.width);
    assert.deepEqual(sanitizeConveyorArrowEffect(undefined, kind), second);
  }
  for (const invalid of [null, undefined, 'conveyor-arrow-unknown', {}, 'flow-arrows']) assert.equal(isConveyorArrowEffectKind(invalid), false);
});

test('尺寸、数量和不透明度保持有界，零值和反向有效', () => {
  const requested = { length: 0.1, width: 10000, count: 32, opacity: 0, reverse: true };
  assert.deepEqual(sanitizeConveyorArrowEffect(requested), requested);
  const normalized = sanitizeConveyorArrowEffect({ length: Infinity, width: '10', count: -2.5, opacity: NaN, reverse: 'true' });
  assert.deepEqual(normalized, { length: 6, width: 1.4, count: 1, opacity: 0.9, reverse: false });
  assert.deepEqual(sanitizeConveyorArrowEffect(normalized), normalized);
});

test('新表面样式间距不受隐藏的旧箭头长度限制，切回旧样式恢复原约束', () => {
  const previous = { ...createDefaultConveyorSurfaceArrowsConfig(), arrowLength: 9, spacing: 0.4 };
  for (const style of CONVEYOR_ARROW_EFFECT_KINDS) {
    const value = normalizeConveyorSurfaceArrowsConfig({ ...previous, style })!;
    assert.equal(value.spacing, 0.4);
    assert.equal(value.arrowLength, 9, '切换样式保留旧尺寸，方便切回');
    assert.equal(normalizeConveyorSurfaceArrowsConfig({ ...value, style: 'conveyor-direction' })!.spacing, 9.02);
  }
});
