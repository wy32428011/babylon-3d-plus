import assert from 'node:assert/strict';
import test from 'node:test';
import { createTechBlueNightTheme, normalizeSceneTheme, isTechBlueNightThemeAdjusted, TECH_BLUE_NIGHT_SHADOWS } from '../../src/editor/model/sceneTheme.ts';
import * as sceneThemes from '../../src/editor/model/sceneTheme.ts';

const expectedPresets = [
  ['tech-blue-night', '科技蓝夜景', '#091525'],
  ['industrial-daylight', '工业日光', '#e6eef5'],
  ['graphite-neutral', '石墨中性', '#20262e'],
  ['teal-night', '青绿夜景', '#071d22'],
  ['warm-gold-dusk', '暖金黄昏', '#30272a'],
] as const;

test('四套新主题标识可保存实际参数，原蓝色快照不受影响', () => {
  for (const [presetId] of expectedPresets) {
    const saved = { ...createTechBlueNightTheme(), presetId, exposure: 1.37 };
    assert.deepEqual(normalizeSceneTheme(saved), saved);
  }
});

test('主题目录按固定顺序提供独立默认值，恢复与调整判断使用当前预设', () => {
  assert.deepEqual(sceneThemes.SCENE_THEME_PRESETS.map(preset => [preset.id, preset.name, preset.settings.backgroundColor]), expectedPresets);
  for (const [id] of expectedPresets) {
    assert.equal(sceneThemes.isSceneThemePresetId(id), true);
    const preset = sceneThemes.getSceneThemePreset(id);
    const theme = sceneThemes.createSceneTheme(id);
    assert.equal(theme.presetId, id);
    assert.equal(theme.version, 1);
    assert.equal(theme.environmentLighting, 'scene');
    assert.equal(theme.skyboxVisible, false);
    assert.equal(theme.bloomEnabled, false);
    assert.deepEqual(normalizeSceneTheme(theme), theme);
    assert.equal(sceneThemes.isSceneThemeAdjusted(theme, preset.shadows), false);
    theme.exposure = 1.37;
    assert.equal(sceneThemes.isSceneThemeAdjusted(theme, preset.shadows), true);
    assert.notEqual(sceneThemes.createSceneTheme(id).exposure, 1.37);
    assert.equal(sceneThemes.isSceneThemeAdjusted(sceneThemes.createSceneTheme(id), { ...preset.shadows, sunIntensity: 2 }), true);
    assert.ok(Object.isFrozen(preset.settings));
    assert.ok(Object.isFrozen(preset.shadows));
  }
  for (const invalid of ['unknown', '__proto__', null, 1, {}]) {
    assert.equal(sceneThemes.isSceneThemePresetId(invalid), false);
  }
  assert.deepEqual(sceneThemes.createSceneTheme(), createTechBlueNightTheme());
  assert.equal(sceneThemes.isSceneThemeAdjusted(null, {}), false);
});

test('旧场景不自动获得主题，坏主题明确拒绝', () => {
  assert.equal(normalizeSceneTheme(undefined), null);
  assert.equal(normalizeSceneTheme(null), null);
  assert.throws(() => normalizeSceneTheme({ presetId: 'unknown', version: 1 }), /主题/);
  assert.throws(() => normalizeSceneTheme({ ...createTechBlueNightTheme(), exposure: NaN }), /exposure/);
  assert.throws(() => normalizeSceneTheme({ ...createTechBlueNightTheme(), fogEnd: 1 }), /雾/);
});
test('预设参数独立且保存快照不被默认值覆盖', () => {
  const first = createTechBlueNightTheme(); const second = createTechBlueNightTheme();
  first.exposure = 1.37;
  assert.notEqual(first.exposure, second.exposure);
  const saved = JSON.parse(JSON.stringify(first));
  assert.deepEqual(normalizeSceneTheme(saved), first);
  assert.equal(isTechBlueNightThemeAdjusted(first, TECH_BLUE_NIGHT_SHADOWS), true);
  assert.equal(isTechBlueNightThemeAdjusted(second, TECH_BLUE_NIGHT_SHADOWS), false);
});
test('主题颜色、数字、版本及枚举严格校验，不接受任意材质输入', () => {
  const theme = createTechBlueNightTheme();
  for (const patch of [{version: 2}, {fillColor:'url(secret)'}, {exposure:-1}, {fogEnabled:'true'}, {environmentLighting:'bad'}]) {
    assert.throws(() => normalizeSceneTheme({...theme,...patch}));
  }
  assert.equal(isTechBlueNightThemeAdjusted(theme, {...TECH_BLUE_NIGHT_SHADOWS, sunIntensity: 2}),true);
});
