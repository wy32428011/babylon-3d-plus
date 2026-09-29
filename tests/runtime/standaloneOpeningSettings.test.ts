import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultSettings, normalizeStandaloneSettings } from '../../src/standalone-opening/settings.ts';

test('独立默认完整九阶段62秒且没有编辑器或开场包字段', () => {
  const settings = defaultSettings();
  assert.deepEqual(settings.reference.stageDurations, [9, 7, 8, 6, 4, 8, 6, 6, 8]);
  assert.equal(settings.reference.stageDurations.reduce((a, b) => a + b), 62);
  assert.deepEqual(Object.keys(settings).sort(), ['allowSkip', 'breathingEnabled', 'breathingIntensity', 'breathingPeriodSeconds', 'motionPreference', 'reference']);
  assert.equal('version' in settings.reference, false);
  assert.equal(normalizeStandaloneSettings(undefined).reference.stageDurations.reduce((a, b) => a + b), 62);
});

test('多次默认配置及规范化结果相互隔离，局部参数保留显式零停留', () => {
  const first = defaultSettings(), second = defaultSettings();
  first.reference.stageDurations[2] = 0;
  first.reference.worldDestinations[0].name = 'changed';
  assert.equal(second.reference.stageDurations[2], 8);
  assert.notEqual(second.reference.worldDestinations[0].name, 'changed');
  const normalized = normalizeStandaloneSettings({ reference: { brandName: '独立网页', stageDurations: [9, 7, 0, 6, 4, 0, 6, 6, 8], worldDestinations: [] }, breathingIntensity: 0 });
  assert.equal(normalized.reference.brandName, '独立网页');
  assert.equal(normalized.reference.stageDurations[2], 0);
  assert.equal(normalized.reference.stageDurations[5], 0);
  assert.deepEqual(normalized.reference.worldDestinations, []);
  assert.equal(normalized.breathingIntensity, 0);
  assert.equal(normalized.reference.showUI, true);
});

test('只采纳公开字段，非法值由既有规范化恢复或限制', () => {
  const settings = normalizeStandaloneSettings({
    reference: { quality: 'broken', worldOrigin: { x: -1, y: 2 } },
    breathingIntensity: 99, breathingPeriodSeconds: 0, motionPreference: 'broken',
    template: 'package', package: { unsafe: true }, afterOpening: 'auto-patrol',
  } as never);
  assert.equal(settings.template, 'reference-huishan');
  assert.equal(settings.package, undefined);
  assert.equal(settings.afterOpening, 'stay');
  assert.equal(settings.reference.quality, 'high');
  assert.equal(settings.breathingIntensity, 1);
  assert.equal(settings.breathingPeriodSeconds, 2);
  assert.equal(settings.motionPreference, 'normal');
});
