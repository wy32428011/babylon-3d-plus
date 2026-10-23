import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeSceneLightingConfig, normalizeSceneAppearanceConfig, migrateSceneLightingDocument } from '../../electron/shared/sceneLightingConfig.ts';
import { createDefaultEditorLightingConfig, createGlbStandardPreviewLightingConfig, createGlbStandardPreviewAppearanceConfig, GLB_STANDARD_ENVIRONMENT_ROTATION_DEGREES } from '../../electron/shared/glbStandardPreview.ts';
import { getSceneLightingBakeSignature } from '../../electron/shared/sceneLightingBakeContract.ts';

test('标准预览显式使用 Sandbox 环境，保留规则和未涉及的设置，不修改输入', () => {
  const current = normalizeSceneLightingConfig({ main: { intensity: 2 }, disabledLightIds: ['old'],
    bake: { quality: 'high' }, policy: { version: 1, defaults: { castShadows: false }, rules: [] }, custom: { keep: true } });
  const before = JSON.stringify(current);
  const lighting = createGlbStandardPreviewLightingConfig(current, ['point', 'old']);
  assert.equal(JSON.stringify(current), before);
  assert.equal(lighting.main.enabled, false);
  assert.equal(lighting.main.source, 'managed');
  assert.equal(lighting.fill.intensity, 0);
  assert.equal(lighting.environmentIntensity, 1);
  assert.deepEqual(lighting.environment, { source: 'sandbox', rotationDegrees: GLB_STANDARD_ENVIRONMENT_ROTATION_DEGREES });
  assert.equal(lighting.allowDayNightCycle, false);
  assert.equal(lighting.shadows.enabled, false);
  assert.deepEqual(lighting.disabledLightIds, ['old', 'point']);
  assert.deepEqual(lighting.policy, current.policy);
  assert.deepEqual(lighting.bake, { ...current.bake, enabled: false });
  assert.deepEqual((lighting as unknown as Record<string, unknown>).custom, { keep: true });
  assert.deepEqual(createGlbStandardPreviewLightingConfig(lighting, ['point']), lighting);
});

test('标准预览外观使用无色调映射基线，保留无关参数并隐藏背景', () => {
  const appearance = normalizeSceneAppearanceConfig({ exposure: 2, contrast: 1.5, toneMappingEnabled: true, bloomEnabled: true,
    fogEnabled: true, fogStart: 300, custom: { keep: 1 } });
  const before = JSON.stringify(appearance), next = createGlbStandardPreviewAppearanceConfig(appearance);
  assert.equal(JSON.stringify(appearance), before);
  assert.equal(next.exposure, 1); assert.equal(next.contrast, 1); assert.equal(next.toneMappingEnabled, false);
  assert.equal(next.bloomEnabled, false); assert.equal(next.fogEnabled, false); assert.equal(next.skyboxVisible, false);
  assert.equal(next.fogStart, 300); assert.deepEqual((next as unknown as Record<string, unknown>).custom, { keep: 1 });
});

test('旧配置和旧场景缺少环境选择时不自动注入 Sandbox，归一化和迁移幂等', () => {
  const lighting = normalizeSceneLightingConfig({ main: { intensity: 2.3 }, environmentIntensity: .4 });
  assert.equal(lighting.environment, undefined);
  const old = { entities: {}, sceneSettings: { lighting, appearance: normalizeSceneAppearanceConfig({ exposure: 1.4 }), skybox: null } };
  const before = JSON.stringify(old), migrated = migrateSceneLightingDocument(old);
  assert.equal(JSON.stringify(old), before); assert.deepEqual(migrated, old);
  assert.deepEqual(migrateSceneLightingDocument(migrated), migrated);
});

test('新环境字段校验范围，保留扩展，环境选择与旋转改变 GI 输入，显示不改变', () => {
  const normalized = normalizeSceneLightingConfig({ environment: { source: 'sandbox', rotationDegrees: 999, future: true } });
  assert.equal(normalized.environment?.rotationDegrees, 360);
  assert.equal((normalized.environment as unknown as Record<string, unknown>).future, true);
  assert.equal(normalizeSceneLightingConfig({ environment: { source: 'invalid', rotationDegrees: NaN } }).environment?.source, 'scene');
  const scene = { entities: {}, sceneSettings: { lighting: normalizeSceneLightingConfig(undefined), appearance: normalizeSceneAppearanceConfig(undefined) } };
  const oldSignature = getSceneLightingBakeSignature(scene);
  const explicitScene = { ...scene, sceneSettings: { ...scene.sceneSettings, lighting: normalizeSceneLightingConfig({ ...scene.sceneSettings.lighting, environment: { source: 'scene', rotationDegrees: 45 } }) } };
  assert.equal(getSceneLightingBakeSignature(explicitScene), oldSignature);
  const standard = { ...scene, sceneSettings: { ...scene.sceneSettings, lighting: createGlbStandardPreviewLightingConfig() } };
  const signature = getSceneLightingBakeSignature(standard);
  assert.notEqual(signature, oldSignature);
  standard.sceneSettings.lighting.environment!.rotationDegrees = 80;
  assert.notEqual(getSceneLightingBakeSignature(standard), signature);
  const rotated = getSceneLightingBakeSignature(standard);
  standard.sceneSettings.appearance.exposure = 1.5;
  assert.equal(getSceneLightingBakeSignature(standard), rotated);
  const backgroundOnly = { ...standard, entities: { background: { id: 'background', visible: true,
    components: { skybox: { sourceUrl: 'background.hdr', rotationDegrees: 120 } } } },
    sceneSettings: { ...standard.sceneSettings, skybox: { sourceUrl: 'background.hdr', rotationDegrees: 120 } } };
  assert.equal(getSceneLightingBakeSignature(backgroundOnly), rotated, '内置环境选中时，背景资源不是 GI 照明输入');
});

test('新建编辑场景仅增加内置环境，保留旧主补光与其它默认值，不污染旧归一化默认', () => {
  const original = normalizeSceneLightingConfig(undefined);
  const lighting = createDefaultEditorLightingConfig();
  const { environment, ...remaining } = lighting;
  assert.deepEqual(environment, { source: 'sandbox', rotationDegrees: GLB_STANDARD_ENVIRONMENT_ROTATION_DEGREES });
  assert.deepEqual(remaining, original);
  assert.equal(lighting.main.source, 'managed');
  assert.equal(lighting.main.enabled, true);
  assert.equal(lighting.fill.intensity, 0.8);
  lighting.main.intensity = 8;
  assert.equal(createDefaultEditorLightingConfig().main.intensity, original.main.intensity);
  assert.equal(normalizeSceneLightingConfig(undefined).environment, undefined);
});
