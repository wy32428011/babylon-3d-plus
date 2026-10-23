import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_SCENE_LIGHTING_CONFIG, DEFAULT_SCENE_APPEARANCE_CONFIG,
  normalizeSceneLightingConfig, normalizeSceneAppearanceConfig,
  getSceneLightingConfig, getSceneAppearanceConfig, migrateSceneLightingDocument,
} from '../../electron/shared/sceneLightingConfig.ts';
import {
  getSceneLightingBakeSignature, getSceneLightingBakeError, requiresSceneLightingBake,
} from '../../electron/shared/sceneLightingBakeContract.ts';

const extensions = (value: unknown): Record<string, unknown> => value as Record<string, unknown>;

function scene() {
  return { id: 'scene', name: '统一光照', entities: {
    wall: { id: 'wall', visible: true, components: { transform: { position: { x: 0, y: 0, z: 0 } }, meshRenderer: { meshKind: 'cube', materialColor: '#ffffff' } } },
  }, sceneSettings: { lighting: normalizeSceneLightingConfig(undefined), appearance: normalizeSceneAppearanceConfig(undefined) } };
}
function result(signature = 'lighting-v1-old') {
  return { version: 1 as const, signature, createdAt: '2026-10-21T00:00:00Z', engineVersion: 'test',
    assets: [{ id: 'g', kind: 'geometry' as const, url: 'Assets/LightingBakes/job/g.json', byteLength: 1 },
      { id: 'l', kind: 'lightmap' as const, url: 'Assets/LightingBakes/job/l.png', byteLength: 1 },
      { id: 'p', kind: 'probes' as const, url: 'Assets/LightingBakes/job/p.json', byteLength: 1 }],
    surfaces: [{ key: 'wall/root', entityId: 'wall', nodeKey: 'root', geometryAssetId: 'g', lightmapAssetId: 'l' }], probeAssetId: 'p',
    statistics: { meshCount: 1, triangleCount: 1, atlasCount: 1, probeCount: 1, textureBytes: 1, durationMs: 1 } };
}
const theme = { version: 1, presetId: 'warm-gold-dusk', environmentLighting: 'scene', backgroundColor: '#30272a',
  fillColor: '#b8c9e0', groundColor: '#584842', mainColor: '#ffd6a0', environmentIntensity: .8,
  skyboxVisible: false, exposure: 1.2, contrast: 1.1, glowIntensity: .35, bloomEnabled: true, bloomWeight: .12,
  fogEnabled: true, fogColor: '#544248', fogStart: 220, fogEnd: 900 };

test('新配置默认完整、互不共享可变状态，未知明确版本拒绝', () => {
  const lighting = normalizeSceneLightingConfig(undefined), appearance = normalizeSceneAppearanceConfig(undefined);
  assert.deepEqual(lighting, DEFAULT_SCENE_LIGHTING_CONFIG);
  assert.deepEqual(appearance, DEFAULT_SCENE_APPEARANCE_CONFIG);
  assert.equal(lighting.version, 2);
  assert.equal(lighting.main.source, 'managed');
  assert.equal(lighting.allowDayNightCycle, true);
  assert.equal(appearance.toneMappingEnabled, false);
  lighting.main.intensity = 8; lighting.disabledLightIds.push('test');
  assert.equal(normalizeSceneLightingConfig(null).main.intensity, 1.05);
  assert.deepEqual(normalizeSceneLightingConfig(null).disabledLightIds, []);
  assert.throws(() => normalizeSceneLightingConfig({ version: 3 }), /版本/);
  assert.throws(() => normalizeSceneAppearanceConfig({ version: 2 }), /版本/);
});

test('规范化有限值和颜色，不丢失false、零、未知扩展与实体ID顺序', () => {
  const lighting = normalizeSceneLightingConfig({ version: 2, future: { value: 7 }, allowDayNightCycle: false,
    main: { intensity: 0, enabled: false, color: '#ABCDEF', elevationDegrees: -120 },
    fill: { intensity: Infinity }, environmentIntensity: 9, disabledLightIds: [' x ', 'x', '', 'y'],
    shadows: { enabled: false, darkness: 2, quality: 'invalid', extra: true } });
  assert.equal(lighting.main.intensity, 0); assert.equal(lighting.main.enabled, false);
  assert.equal(lighting.main.color, '#abcdef'); assert.equal(lighting.main.elevationDegrees, -90);
  assert.equal(lighting.fill.intensity, .8); assert.equal(lighting.environmentIntensity, 5);
  assert.equal(lighting.shadows.darkness, .85); assert.equal(lighting.shadows.quality, 'balanced');
  assert.equal(lighting.allowDayNightCycle, false); assert.deepEqual(lighting.disabledLightIds, ['x', 'y']);
  assert.deepEqual(extensions(lighting).future, { value: 7 }); assert.equal(extensions(lighting.shadows).extra, true);
  const appearance = normalizeSceneAppearanceConfig({ fogStart: 900, fogEnd: 100, bloomWeight: -1, backgroundColor: 'invalid' });
  assert.ok(appearance.fogEnd > appearance.fogStart); assert.equal(appearance.bloomWeight, 0);
  assert.equal(appearance.backgroundColor, DEFAULT_SCENE_APPEARANCE_CONFIG.backgroundColor);
});

test('旧主题转换保留实际主光、填充、IBL上限、外观与全局灯禁用，不修改实体或动作', () => {
  const entities = {
    directional: { id: 'directional', visible: true, components: { light: { lightKind: 'directional' }, actions: [{ type: 'move' }] } },
    hemi: { id: 'hemi', visible: false, components: { light: { lightKind: 'hemispheric' } } },
    spot: { id: 'spot', components: { light: { lightKind: 'spot' } } },
  };
  const original = { name: 'legacy', entities, extension: { preserve: true }, sceneSettings: {
    theme: { ...theme, appearanceExtension: { keep: 1 } }, shadows: { mode: 'baked', enabled: false,
      sunAzimuthDegrees: 270, sunElevationDegrees: 18, sunIntensity: .7, fillIntensity: .6, iblIntensityMax: .4, shadowExtension: 3 },
    lightingBake: { quality: 'high', bakeExtension: true }, otherSetting: { retain: true },
  } };
  const frozen = JSON.stringify(original), migrated = migrateSceneLightingDocument(original);
  const config = migrated.sceneSettings.lighting, appearance = migrated.sceneSettings.appearance;
  assert.equal(migrated.entities, entities); assert.equal(JSON.stringify(original), frozen);
  assert.deepEqual(config.main, { source: 'managed', enabled: true, color: '#ffd6a0', azimuthDegrees: 270, elevationDegrees: 18, intensity: .7 });
  assert.deepEqual(config.fill, { intensity: .6, color: '#b8c9e0', groundColor: '#584842' });
  assert.equal(config.environmentIntensity, .4); assert.equal(config.shadows.enabled, false);
  assert.deepEqual(config.disabledLightIds, ['directional', 'hemi']); assert.equal(config.allowDayNightCycle, false);
  assert.equal(appearance.exposure, 1.2); assert.equal(appearance.toneMappingEnabled, true);
  assert.equal(appearance.fogStart, 220); assert.equal(appearance.bloomEnabled, true);
  assert.deepEqual(extensions(appearance).appearanceExtension, { keep: 1 });
  assert.equal(extensions(config.shadows).shadowExtension, 3); assert.equal(extensions(config.bake).bakeExtension, true);
  assert.deepEqual(migrated.sceneSettings.otherSetting, { retain: true });
});

test('旧无主题按有效模式迁移：baked不凭空加太阳，realtime保留填充与IBL限制，hybrid保持原底光', () => {
  const legacy = (mode: string) => ({ entities: {}, sceneSettings: { shadows: {
    mode, enabled: true, sunIntensity: 1.3, fillIntensity: .3, iblIntensityMax: .25 }, skybox: { intensity: .9 } } });
  const baked = getSceneLightingConfig(legacy('baked'));
  assert.equal(baked.main.enabled, false); assert.equal(baked.fill.intensity, .8);
  assert.equal(baked.environmentIntensity, .9); assert.equal(baked.allowDayNightCycle, true);
  const realtime = getSceneLightingConfig(legacy('realtime'));
  assert.equal(realtime.main.enabled, true); assert.equal(realtime.fill.intensity, .3); assert.equal(realtime.environmentIntensity, .25);
  const hybrid = getSceneLightingConfig(legacy('hybrid'));
  assert.equal(hybrid.main.enabled, true); assert.equal(hybrid.fill.intensity, .8); assert.equal(hybrid.environmentIntensity, .9);
});

test('旧可见方向灯采用scene来源，隐藏父级灯不阻止managed来源，层级循环不会挂起', () => {
  const legacy = { entities: { folder: { id: 'folder', visible: true, parentId: null as string | null },
    sun: { id: 'sun', parentId: 'folder', components: { light: { lightKind: 'directional', intensity: 1 } } } },
    sceneSettings: { shadows: { mode: 'hybrid' } } };
  assert.equal(getSceneLightingConfig(legacy).main.source, 'scene');
  legacy.entities.folder.visible = false;
  assert.equal(getSceneLightingConfig(legacy).main.source, 'managed');
  legacy.entities.folder.visible = true; legacy.entities.folder.parentId = 'folder';
  assert.equal(getSceneLightingConfig(legacy).main.source, 'scene');
});

test('canonical字段完全优先，迁移删除旧写字段且幂等并保留未知数据', () => {
  const current = { ...scene(), sceneSettings: { ...scene().sceneSettings, theme,
    shadows: { enabled: false }, lightingBake: { enabled: false }, lightingPolicy: { version: 1, defaults: { castShadows: false }, rules: [] },
    lightingBakeResult: result(), unknownSetting: 4 } };
  current.sceneSettings.lighting.main.intensity = 2;
  current.sceneSettings.lighting.allowDayNightCycle = true;
  const migrated = migrateSceneLightingDocument(current);
  assert.equal(migrated.sceneSettings.lighting.main.intensity, 2);
  assert.equal(migrated.sceneSettings.lighting.allowDayNightCycle, true);
  assert.equal(migrated.sceneSettings.lighting.bake.enabled, true);
  assert.equal(migrated.sceneSettings.lighting.result, null);
  assert.equal(migrated.sceneSettings.appearance.exposure, 1);
  assert.equal(migrated.sceneSettings.unknownSetting, 4);
  for (const key of ['theme', 'shadows', 'lightingBake', 'lightingPolicy', 'lightingBakeResult']) assert.equal(Object.hasOwn(migrated.sceneSettings, key), false, key);
  assert.equal(migrateSceneLightingDocument(migrated), migrated);
});

test('显式canonical空值重置为新默认，不能回退并复活旧主题或旧结果', () => {
  for (const empty of [undefined, null]) {
    const current = { sceneSettings: { lighting: empty, appearance: empty, theme, lightingBakeResult: result() } };
    assert.deepEqual(getSceneLightingConfig(current), DEFAULT_SCENE_LIGHTING_CONFIG);
    assert.deepEqual(getSceneAppearanceConfig(current), DEFAULT_SCENE_APPEARANCE_CONFIG);
  }
});

test('规则和结果扩展元数据保持，非法已知字段不借扩展回流，未知规则版本拒绝', () => {
  const original = result();
  const snapshot = { ...original, extension: { retain: true }, geometrySignature: 4,
    assets: [{ ...original.assets[0], extension: 'asset', sha256: 5 }, ...original.assets.slice(1)] };
  const current = normalizeSceneLightingConfig({ result: snapshot, policy: { version: 1, extension: 'policy',
    defaults: { castShadows: 'invalid', extension: 3 }, rules: [{ id: 'r', enabled: true, extension: 4,
      target: { kind: 'all' }, values: { receiveShadows: false, extension: 5 }, nodeRules: [] }] } });
  assert.equal(extensions(current.policy).extension, 'policy');
  assert.equal(extensions(current.policy!.defaults).extension, 3); assert.equal(current.policy!.defaults.castShadows, undefined);
  assert.equal(extensions(current.policy!.rules[0].values).extension, 5); assert.equal(current.policy!.rules[0].values.receiveShadows, false);
  assert.deepEqual(extensions(current.result).extension, { retain: true }); assert.equal(current.result?.geometrySignature, undefined);
  assert.equal(extensions(current.result?.assets[0]).extension, 'asset'); assert.equal(current.result?.assets[0].sha256, undefined);
  assert.throws(() => normalizeSceneLightingConfig({ policy: { version: 2 } }), /版本/);
});

test('保留旧v1 GI供查看且保持过期，旧太阳贴图绝不充当新GI', () => {
  const legacy = { ...scene(), sceneSettings: { theme, shadows: { mode: 'baked', bake: { version: 1, surfaces: [{ dataUrl: 'data:image/png;base64,old' }] } },
    lightingBakeResult: result() } };
  const migrated = migrateSceneLightingDocument(legacy);
  assert.equal(migrated.sceneSettings.lighting.result?.signature, 'lighting-v1-old');
  assert.equal(migrated.sceneSettings.lighting.result?.assets.length, 3);
  assert.match(getSceneLightingBakeError(migrated)!, /过期|重新烘焙/);
  const onlyOldShadow = migrateSceneLightingDocument({ ...legacy, sceneSettings: { shadows: legacy.sceneSettings.shadows } });
  assert.equal(onlyOldShadow.sceneSettings.lighting.result, null);
});

test('旧策略与实体继承metadata迁移后保持顺序和语义', () => {
  const policy = { version: 1, defaults: { receiveShadows: false }, rules: [
    { id: 'first', enabled: true, target: { kind: 'all' }, values: { mobility: 'dynamic' } },
    { id: 'second', enabled: false, target: { kind: 'type', deviceType: 'lift' }, values: { mobility: 'static' } },
  ] };
  const original = { ...scene(), sceneSettings: { shadows: { mode: 'hybrid' }, lightingPolicy: policy } };
  const migrated = migrateSceneLightingDocument(original);
  assert.deepEqual(migrated.sceneSettings.lighting.policy, policy);
  assert.equal(migrated.entities, original.entities);
});

test('v2签名包含实际填充、环境、主光及规则输入，外观和实时阴影性能项不影响GI', () => {
  const current = scene(), original = getSceneLightingBakeSignature(current);
  assert.match(original, /^lighting-v2-/);
  for (const mutate of [
    (s: ReturnType<typeof scene>) => { s.sceneSettings.lighting.fill.intensity = .25; },
    (s: ReturnType<typeof scene>) => { s.sceneSettings.lighting.fill.color = '#ff0000'; },
    (s: ReturnType<typeof scene>) => { s.sceneSettings.lighting.fill.groundColor = '#0000ff'; },
    (s: ReturnType<typeof scene>) => { s.sceneSettings.lighting.environmentIntensity = .25; },
    (s: ReturnType<typeof scene>) => { s.sceneSettings.lighting.main.intensity = .25; },
    (s: ReturnType<typeof scene>) => { s.sceneSettings.lighting.allowDayNightCycle = false; },
  ]) { const changed = structuredClone(current); mutate(changed); assert.notEqual(getSceneLightingBakeSignature(changed), original); }
  const appearance = current.sceneSettings.appearance;
  Object.assign(appearance, { exposure: 2, contrast: 2, toneMappingEnabled: true, backgroundColor: '#ffffff', skyboxVisible: false,
    fogEnabled: true, fogColor: '#ff0000', fogStart: 5, fogEnd: 100, bloomEnabled: true, bloomWeight: .8, glowIntensity: 2 });
  Object.assign(current.sceneSettings.lighting.shadows, { enabled: false, quality: 'quality', darkness: .8, distanceMeters: 20, bias: .01, normalBias: .1 });
  Object.assign(current.sceneSettings.lighting.bake, { maxTextureMiB: 1024, cacheStaticShadows: false, dynamicShadows: false });
  assert.equal(getSceneLightingBakeSignature(current), original);
});

test('scene主光来源不hash未使用managed参数，旧运输地址与外观重复字段不会旁路新单一真值', () => {
  const current = { ...scene(), sceneSettings: { ...scene().sceneSettings,
    skybox: { sourceUrl: 'Assets/Skyboxes/a.hdr', rotationDegrees: 12, intensity: .2 }, theme: undefined as unknown, shadows: undefined as unknown } };
  current.sceneSettings.lighting.main.source = 'scene';
  const signature = getSceneLightingBakeSignature(current);
  Object.assign(current.sceneSettings.lighting.main, { intensity: 9, color: '#ff0000', enabled: false, azimuthDegrees: 300 });
  current.sceneSettings.skybox.intensity = .9;
  current.sceneSettings.theme = theme; current.sceneSettings.shadows = { sunIntensity: 19 };
  assert.equal(getSceneLightingBakeSignature(current), signature);
  current.sceneSettings.skybox.rotationDegrees = 20;
  assert.notEqual(getSceneLightingBakeSignature(current), signature);
});

test('新结果只从lighting.result验证，canonical缺失结果不会复活旧位置结果', () => {
  const current = { ...scene(), sceneSettings: { ...scene().sceneSettings, lightingBakeResult: result() } };
  const signature = getSceneLightingBakeSignature(current);
  current.sceneSettings.lightingBakeResult = result(signature);
  assert.match(getSceneLightingBakeError(current)!, /尚未|未完成/);
  current.sceneSettings.lighting.result = result(signature);
  assert.equal(getSceneLightingBakeError(current), null);
  current.sceneSettings.lighting.fill.intensity = .4;
  assert.match(getSceneLightingBakeError(current)!, /过期/);
  current.sceneSettings.lighting.bake.enabled = false;
  assert.equal(getSceneLightingBakeError(current), null);
});

test('烘焙需求读取新策略，关掉实时阴影仍可生成静态GI', () => {
  const current = scene(); current.sceneSettings.lighting.shadows.enabled = false;
  assert.equal(requiresSceneLightingBake(current), true);
  current.sceneSettings.lighting.policy = { version: 1, defaults: { mobility: 'dynamic' }, rules: [] };
  assert.equal(requiresSceneLightingBake(current), false);
  current.sceneSettings.lighting.policy = { version: 1, defaults: { bakeIndirect: false }, rules: [] };
  assert.equal(requiresSceneLightingBake(current), false);
});

test('允许日夜控制时实际光源配置与优先顺序进入签名，关闭后及雾/展示POI不进入', () => {
  const base = scene();
  const day = { id: 'day', visible: true, components: { poiEffect: { enabled: true, effectKind: 'day-night',
    visual: { duration: 10, loop: false, progress: .2 }, configuration: { parameters: { dayMode: 'manual', hour: 12 } } } } };
  const current = { ...base, entityIds: ['wall', 'day', 'second', 'fog'], entities: { ...base.entities, day,
    second: { ...structuredClone(day), id: 'second' },
    fog: { id: 'fog', components: { poiEffect: { enabled: true, effectKind: 'environment-fog', configuration: { parameters: { density: .1 } } } } },
  } };
  const original = getSceneLightingBakeSignature(current);
  current.entities.day.components.poiEffect.configuration.parameters.hour = 18;
  assert.notEqual(getSceneLightingBakeSignature(current), original);
  current.entities.day.components.poiEffect.configuration.parameters.hour = 12;
  current.entityIds = ['wall', 'second', 'day', 'fog'];
  assert.notEqual(getSceneLightingBakeSignature(current), original, '同类日夜控制器按运行时先后顺序占用控制权');
  current.entityIds = ['wall', 'day', 'second', 'fog'];
  current.entities.fog.components.poiEffect.configuration.parameters.density = .9;
  assert.equal(getSceneLightingBakeSignature(current), original);
  current.sceneSettings.lighting.allowDayNightCycle = false;
  const blocked = getSceneLightingBakeSignature(current);
  current.entities.day.components.poiEffect.configuration.parameters.hour = 20;
  assert.equal(getSceneLightingBakeSignature(current), blocked);
});
