import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  DEFAULT_SCENE_APPEARANCE_CONFIG,
  DEFAULT_SCENE_LIGHTING_CONFIG,
  normalizeSceneAppearanceConfig,
  normalizeSceneLightingConfig,
} from '../../electron/shared/sceneLightingConfig.ts';
import { createDefaultEditorLightingConfig } from '../../electron/shared/glbStandardPreview.ts';
import { getSceneLightingBakeSignature } from '../../electron/shared/sceneLightingBakeContract.ts';
import {
  applyWarehouseLightingPreset,
  applyWarehouseQualityTier,
  detectWarehouseQualityTier,
  WAREHOUSE_LIGHTING_PRESETS,
  WAREHOUSE_QUALITY_TIERS,
} from '../../electron/shared/warehouseLightingPresets.ts';
import {
  assertViewerTemplateSupportsScene,
  createViewerTemplateCapabilities,
  VIEWER_TEMPLATE_CAPABILITIES_PATH,
} from '../../electron/ipc/viewerTemplateCapabilities.ts';

test('旧默认配置与新增可选字段的缺省省略行为保持零漂移', () => {
  const lighting = normalizeSceneLightingConfig(undefined);
  const appearance = normalizeSceneAppearanceConfig(undefined);
  const editorDefault = createDefaultEditorLightingConfig();

  assert.deepEqual(lighting, DEFAULT_SCENE_LIGHTING_CONFIG);
  assert.deepEqual(appearance, DEFAULT_SCENE_APPEARANCE_CONFIG);
  assert.equal(Object.hasOwn(appearance, 'ssaoMode'), false);
  assert.equal(Object.hasOwn(lighting.shadows, 'receiverScope'), false);
  assert.equal(Object.hasOwn(lighting.shadows, 'skipSmallCastersMeters'), false);
  assert.equal(Object.hasOwn(lighting.shadows, 'skipGeneratedCargoCasters'), false);
  assert.equal(Object.hasOwn(lighting.shadows, 'respectEntityShadowOverrides'), false);
  assert.equal(Object.hasOwn(lighting.shadows, 'mobileBlobShadows'), false);
  assert.equal(Object.hasOwn(editorDefault.environment ?? {}, 'preset'), false);

  const normalizedFalse = normalizeSceneLightingConfig({
    environment: { source: 'sandbox', rotationDegrees: 10, preset: 'warehouse-bright' },
    shadows: {
      receiverScope: 'invalid',
      skipSmallCastersMeters: 0,
      skipGeneratedCargoCasters: false,
      respectEntityShadowOverrides: false,
      mobileBlobShadows: false,
    },
  });
  assert.equal(normalizedFalse.environment?.preset, 'warehouse-bright');
  assert.equal(Object.hasOwn(normalizedFalse.shadows, 'receiverScope'), false);
  assert.equal(Object.hasOwn(normalizedFalse.shadows, 'skipSmallCastersMeters'), false);
  assert.equal(Object.hasOwn(normalizedFalse.shadows, 'skipGeneratedCargoCasters'), false);
  assert.equal(Object.hasOwn(normalizedFalse.shadows, 'respectEntityShadowOverrides'), false);
  assert.equal(Object.hasOwn(normalizedFalse.shadows, 'mobileBlobShadows'), false);

  const clamped = normalizeSceneLightingConfig({
    environment: { source: 'scene', preset: 'warehouse-bright' },
    shadows: {
      receiverScope: 'ground-only',
      skipSmallCastersMeters: 99,
      skipGeneratedCargoCasters: true,
      respectEntityShadowOverrides: true,
      mobileBlobShadows: true,
    },
  });
  assert.equal(Object.hasOwn(clamped.environment ?? {}, 'preset'), false);
  assert.equal(clamped.shadows.receiverScope, 'ground-only');
  assert.equal(clamped.shadows.skipSmallCastersMeters, 10);
  assert.equal(clamped.shadows.skipGeneratedCargoCasters, true);
  assert.equal(clamped.shadows.respectEntityShadowOverrides, true);
  assert.equal(clamped.shadows.mobileBlobShadows, true);

  const ssaoOff = normalizeSceneAppearanceConfig({ ssaoMode: 'off' });
  assert.equal(Object.hasOwn(ssaoOff, 'ssaoMode'), false);
  assert.equal(normalizeSceneAppearanceConfig({ ssaoMode: 'balanced' }).ssaoMode, 'balanced');
  assert.equal(normalizeSceneAppearanceConfig({ ssaoMode: 'high' }).ssaoMode, 'high');
});

test('智慧仓储预设关闭离线烘焙、开启自动阴影与ACSE调色，并保留规则和扩展字段', () => {
  assert.equal(WAREHOUSE_LIGHTING_PRESETS.length, 3);
  assert.equal(WAREHOUSE_QUALITY_TIERS.length, 3);

  const policy = { version: 1 as const, defaults: { castShadows: false }, rules: [] };
  const baseLighting = normalizeSceneLightingConfig({
    policy,
    disabledLightIds: ['lamp-1'],
    customField: 'keep',
  });
  const baseAppearance = normalizeSceneAppearanceConfig({ customAppearance: 42 });

  for (const preset of WAREHOUSE_LIGHTING_PRESETS) {
    const applied = applyWarehouseLightingPreset(baseLighting, baseAppearance, preset.id);
    assert.equal(applied.lighting.bake.enabled, false);
    assert.equal(applied.lighting.shadows.enabled, true);
    assert.equal(applied.lighting.shadows.managementMode, 'automatic');
    assert.equal(applied.lighting.shadows.respectEntityShadowOverrides, true);
    assert.equal(applied.lighting.shadows.skipGeneratedCargoCasters, true);
    assert.equal(applied.appearance.toneMappingEnabled, true);
    assert.equal(applied.appearance.ssaoMode, 'balanced');
    assert.deepEqual(applied.lighting.policy, policy);
    assert.deepEqual(applied.lighting.disabledLightIds, ['lamp-1']);
    assert.equal((applied.lighting as Record<string, unknown>).customField, 'keep');
    assert.equal((applied.appearance as Record<string, unknown>).customAppearance, 42);
  }
});

test('仓储三档画质切换与反向识别一致，且保持原有光源风格', () => {
  const { lighting, appearance } = applyWarehouseLightingPreset(undefined, undefined, 'warehouse-bright');

  for (const tier of ['performance', 'standard', 'high'] as const) {
    const switched = applyWarehouseQualityTier(lighting, appearance, tier);
    assert.equal(detectWarehouseQualityTier(switched.lighting, switched.appearance), tier);
    assert.deepEqual(switched.lighting.main, lighting.main);
    assert.deepEqual(switched.lighting.environment, lighting.environment);
  }

  const perf = applyWarehouseQualityTier(lighting, appearance, 'performance');
  assert.equal(perf.lighting.shadows.receiverScope, 'ground-only');
  assert.equal(perf.lighting.shadows.mobileBlobShadows, true);
  assert.equal(perf.appearance.ssaoMode, undefined);

  const custom = { ...perf, lighting: { ...perf.lighting, shadows: { ...perf.lighting.shadows, darkness: 0.25 } } };
  assert.equal(detectWarehouseQualityTier(custom.lighting, custom.appearance), 'performance');

  const modifiedTier = {
    ...perf,
    appearance: normalizeSceneAppearanceConfig({ ...perf.appearance, ssaoMode: 'balanced' }),
  };
  assert.equal(detectWarehouseQualityTier(modifiedTier.lighting, modifiedTier.appearance), 'custom');
});

test('SSAO与仓储阴影过滤不影响GI签名，而不同内置仓储环境贴图区分GI输入', () => {
  const base = {
    entities: {},
    sceneSettings: {
      lighting: createDefaultEditorLightingConfig(),
      appearance: normalizeSceneAppearanceConfig(undefined),
    },
  };
  const sandboxSig = getSceneLightingBakeSignature(base);

  const withRuntimeOptimizations = {
    ...base,
    sceneSettings: {
      lighting: normalizeSceneLightingConfig({
        ...base.sceneSettings.lighting,
        shadows: {
          ...base.sceneSettings.lighting.shadows,
          managementMode: 'automatic',
          receiverScope: 'ground-only',
          skipSmallCastersMeters: 0.8,
          skipGeneratedCargoCasters: true,
          respectEntityShadowOverrides: true,
          mobileBlobShadows: true,
        },
      }),
      appearance: normalizeSceneAppearanceConfig({
        ...base.sceneSettings.appearance,
        ssaoMode: 'high',
      }),
    },
  };
  assert.equal(getSceneLightingBakeSignature(withRuntimeOptimizations), sandboxSig);

  const brightEnv = {
    ...base,
    sceneSettings: {
      ...base.sceneSettings,
      lighting: normalizeSceneLightingConfig({
        ...base.sceneSettings.lighting,
        environment: { source: 'sandbox', rotationDegrees: 0, preset: 'warehouse-bright' },
      }),
    },
  };
  const darkEnv = {
    ...base,
    sceneSettings: {
      ...base.sceneSettings,
      lighting: normalizeSceneLightingConfig({
        ...base.sceneSettings.lighting,
        environment: { source: 'sandbox', rotationDegrees: 0, preset: 'warehouse-dark' },
      }),
    },
  };
  const brightSig = getSceneLightingBakeSignature(brightEnv);
  const darkSig = getSceneLightingBakeSignature(darkEnv);
  assert.notEqual(brightSig, sandboxSig);
  assert.notEqual(darkSig, sandboxSig);
  assert.notEqual(brightSig, darkSig);
});

test('Viewer能力清单按需校验SSAO2、仓储阴影过滤与内置仓储环境贴图', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'viewer-warehouse-cap-'));
  t.after(async () => {
    if (path.dirname(root) === path.resolve(os.tmpdir()) && path.basename(root).startsWith('viewer-warehouse-cap-')) {
      await rm(root, { recursive: true, force: true });
    }
  });

  const files: { sourcePath: string; destinationRelativePath: string; size: number }[] = [];
  const entries = [
    { path: 'index.html', content: '<script src="./assets/index.js"></script>' },
    { path: 'assets/index.js', content: 'viewer entry' },
  ];
  const images = Array.from({ length: 10 }, (_, index) => ({
    id: `asset-${index + 1}`,
    path: `assets/asset-${index + 1}.webp`,
    content: `img-${index + 1}`,
  }));
  const add = async (relativePath: string, content: string) => {
    const sourcePath = path.join(root, relativePath);
    await mkdir(path.dirname(sourcePath), { recursive: true });
    await writeFile(sourcePath, content);
    const existing = files.findIndex(item => item.destinationRelativePath === relativePath);
    const record = { sourcePath, destinationRelativePath: relativePath, size: Buffer.byteLength(content) };
    if (existing < 0) files.push(record);
    else files[existing] = record;
  };
  for (const item of [...entries, ...images]) await add(item.path, item.content);

  const manifest = createViewerTemplateCapabilities(entries, images);
  await add(VIEWER_TEMPLATE_CAPABILITIES_PATH, JSON.stringify(manifest));

  const applied = applyWarehouseLightingPreset(undefined, undefined, 'warehouse-bright');
  const warehouseScene = JSON.stringify({
    version: 7,
    scene: { sceneSettings: { lighting: applied.lighting, appearance: applied.appearance } },
  });
  await assertViewerTemplateSupportsScene(warehouseScene, files, new AbortController().signal);

  const legacyManifest = structuredClone(manifest);
  delete legacyManifest.appearanceFeatures;
  await add(VIEWER_TEMPLATE_CAPABILITIES_PATH, JSON.stringify(legacyManifest));
  await assert.rejects(
    assertViewerTemplateSupportsScene(warehouseScene, files, new AbortController().signal),
    /SSAO2/,
  );

  const noEnvManifest = structuredClone(manifest);
  noEnvManifest.builtinEnvironments = ['sandbox-default-v1'];
  await add(VIEWER_TEMPLATE_CAPABILITIES_PATH, JSON.stringify(noEnvManifest));
  await assert.rejects(
    assertViewerTemplateSupportsScene(warehouseScene, files, new AbortController().signal),
    /warehouse-bright-v1/,
  );

  const noFilterManifest = structuredClone(manifest);
  noFilterManifest.shadowModes = ['automatic-v1'];
  await add(VIEWER_TEMPLATE_CAPABILITIES_PATH, JSON.stringify(noFilterManifest));
  await assert.rejects(
    assertViewerTemplateSupportsScene(warehouseScene, files, new AbortController().signal),
    /仓储分层阴影/,
  );

  assert.equal(
    manifest.appearanceFeatures?.includes('ssao2-v1'),
    true,
  );
  assert.ok(createHash('sha256').update(entries[0].content).digest('hex'));
});
