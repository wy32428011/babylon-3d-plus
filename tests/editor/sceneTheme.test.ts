import assert from 'node:assert/strict';
import test from 'node:test';
import { createTechBlueNightTheme, normalizeSceneTheme, isTechBlueNightThemeAdjusted, TECH_BLUE_NIGHT_SHADOWS } from '../../src/editor/model/sceneTheme.ts';

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
