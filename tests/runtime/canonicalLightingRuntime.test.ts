import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { Color3, DirectionalLight, HemisphericLight, NullEngine, PointLight, Scene, Vector3 } from '@babylonjs/core';
import { SceneShadowRuntime } from '../../src/runtime/babylon/SceneShadowRuntime.ts';

const shadows = { enabled: true, mode: 'hybrid' as const, quality: 'balanced' as const, darkness: 0.32,
  catcherEnabled: false, sunAzimuthDegrees: 56, sunElevationDegrees: 63, sunIntensity: 1.05,
  distanceMeters: 0, bias: 0.002, normalBias: 0.03, fillIntensity: 0.2, iblIntensityMax: 0.45 };

test('阴影管理器只管理投影，不创建太阳或改写半球补光和IBL', () => {
  const engine = new NullEngine(), scene = new Scene(engine);
  const fill = new HemisphericLight('EditorLight', Vector3.Up(), scene);
  fill.intensity = 0.73; scene.environmentIntensity = 0.91;
  const runtime = new SceneShadowRuntime(scene);
  try {
    runtime.applySettings(shadows);
    assert.deepEqual(scene.lights.map(light => light.name), ['EditorLight']);
    assert.equal(fill.intensity, 0.73); assert.equal(scene.environmentIntensity, 0.91);
  } finally { runtime.dispose(); scene.dispose(); engine.dispose(); }
});

test('关闭投影保留现有主光和局部光，重新开启仅重建阴影', () => {
  const engine = new NullEngine(), scene = new Scene(engine);
  const sun = new DirectionalLight('managed-main', Vector3.Down(), scene), local = new PointLight('local', Vector3.Up(), scene);
  sun.intensity = 1.7; sun.diffuse = Color3.FromHexString('#ffeedd');
  const runtime = new SceneShadowRuntime(scene);
  try {
    runtime.syncLight('managed-main', sun); runtime.syncLight('local', local); runtime.applySettings(shadows);
    assert.ok(sun.getShadowGenerator()); assert.ok(local.getShadowGenerator());
    runtime.applySettings({ ...shadows, enabled: false });
    assert.equal(sun.isDisposed(), false); assert.equal(sun.isEnabled(), true); assert.equal(sun.intensity, 1.7);
    assert.equal(local.isEnabled(), true); assert.equal(sun.getShadowGenerator(), null);
    runtime.applySettings(shadows);
    assert.ok(sun.getShadowGenerator()); assert.equal(scene.lights.length, 2);
  } finally { runtime.dispose(); scene.dispose(); engine.dispose(); }
});

test('统一光照独立管理主光来源，实体禁用清单不改文档显隐或额外隐藏方向灯', async () => {
  const { SceneLightRigRuntime } = await import('../../src/runtime/babylon/SceneLightRigRuntime.ts');
  const engine = new NullEngine(), scene = new Scene(engine), rig = new SceneLightRigRuntime(scene);
  const directional = new DirectionalLight('scene-sun', Vector3.Down(), scene), point = new PointLight('point', Vector3.Up(), scene);
  const config = { main: { source: 'managed', enabled: true, color: '#ffeedd', azimuthDegrees: 32, elevationDegrees: 45, intensity: 1.7 },
    fill: { intensity: 0.4, color: '#abcdef', groundColor: '#123456' }, environmentIntensity: 0.8, disabledLightIds: [] } as any;
  try {
    rig.sync(config); rig.syncEntityLight('scene-sun', directional, true); rig.syncEntityLight('point', point, true);
    const managed = rig.mainLight; assert.ok(managed); assert.equal(managed.intensity, 1.7);
    assert.equal(directional.isEnabled(), true); assert.equal(point.isEnabled(), true);
    rig.sync({ ...config, disabledLightIds: ['scene-sun'] }); rig.syncEntityLight('scene-sun', directional, true);
    assert.equal(directional.isEnabled(), false); assert.equal(directional.intensity, 1);
    rig.sync({ ...config, main: { ...config.main, source: 'scene' } }); rig.syncEntityLight('scene-sun', directional, true);
    assert.equal(rig.mainLight, null); assert.equal(managed.isDisposed(), true); assert.equal(directional.isEnabled(), true);
    assert.equal(scene.lights.filter(light => light instanceof DirectionalLight).length, 1);
    assert.equal(scene.environmentIntensity, 0.8);
  } finally { rig.dispose(); scene.dispose(); engine.dispose(); }
});

test('纯外观更新不创建灯、不调整IBL和灯强度；释放后恢复显示基线', async () => {
  const { SceneAppearanceRuntime } = await import('../../src/runtime/babylon/SceneAppearanceRuntime.ts');
  const engine = new NullEngine(), scene = new Scene(engine), fill = new HemisphericLight('EditorLight', Vector3.Up(), scene);
  const runtime = new SceneAppearanceRuntime(scene), baseline = scene.clearColor.clone();
  fill.intensity = 0.73; scene.environmentIntensity = 0.91;
  try {
    runtime.sync({ version: 1, backgroundColor: '#112233', exposure: 1.6, contrast: 1.2, toneMappingEnabled: true,
      bloomEnabled: false, bloomWeight: 0.15 } as any);
    assert.equal(scene.imageProcessingConfiguration.exposure, 1.6);
    assert.equal(scene.lights.length, 1); assert.equal(fill.intensity, 0.73); assert.equal(scene.environmentIntensity, 0.91);
    runtime.dispose(); assert.deepEqual(scene.clearColor.asArray(), baseline.asArray());
  } finally { runtime.dispose(); scene.dispose(); engine.dispose(); }
});

test('真实照明捕获和GI签名忽略曝光外观变化，但主光变化使两者变化', async () => {
  const project = new URL('../../', import.meta.url);
  const hooks = registerHooks({ resolve(specifier, context, next) {
    if (specifier.startsWith('.') && context.parentURL?.startsWith(project.href) && !context.parentURL.includes('/node_modules/')) {
      const target = new URL(specifier.endsWith('.js') ? specifier.slice(0, -3) + '.ts' : specifier + '.ts', context.parentURL);
      if (existsSync(target)) return next(target.href, context);
    }
    return next(specifier, context);
  } });
  const { captureLightingEnvironment } = await import('../../src/runtime/babylon/lightingRuntimeCapture.ts');
  const { normalizeSceneLightingConfig, normalizeSceneAppearanceConfig } = await import('../../electron/shared/sceneLightingConfig.ts');
  const { getSceneLightingBakeSignature } = await import('../../electron/shared/sceneLightingBakeContract.ts');
  const { SceneAppearanceRuntime } = await import('../../src/runtime/babylon/SceneAppearanceRuntime.ts');
  const { SceneLightRigRuntime } = await import('../../src/runtime/babylon/SceneLightRigRuntime.ts');
  hooks.deregister();
  const engine = new NullEngine(), scene = new Scene(engine), rig = new SceneLightRigRuntime(scene), appearance = new SceneAppearanceRuntime(scene);
  const document = { name: 'capture', entities: {}, rootIds: [], sceneSettings: {
    lighting: normalizeSceneLightingConfig(undefined), appearance: normalizeSceneAppearanceConfig(undefined),
  } } as any;
  try {
    rig.sync(document.sceneSettings.lighting); appearance.sync(document.sceneSettings.appearance);
    const captured = captureLightingEnvironment(scene, document), signature = getSceneLightingBakeSignature(document);
    document.sceneSettings.appearance = { ...document.sceneSettings.appearance, exposure: 1.7, contrast: 1.2, fogEnabled: true };
    appearance.sync(document.sceneSettings.appearance); rig.sync(document.sceneSettings.lighting);
    assert.deepEqual(captureLightingEnvironment(scene, document), captured);
    assert.equal(getSceneLightingBakeSignature(document), signature);
    document.sceneSettings.lighting = { ...document.sceneSettings.lighting, main: { ...document.sceneSettings.lighting.main, intensity: 2.1 } };
    rig.sync(document.sceneSettings.lighting);
    assert.notDeepEqual(captureLightingEnvironment(scene, document), captured);
    assert.notEqual(getSceneLightingBakeSignature(document), signature);
  } finally { appearance.dispose(); rig.dispose(); scene.dispose(); engine.dispose(); }
});
