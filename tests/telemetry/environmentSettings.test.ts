import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createDefaultSceneEnvironmentTransform,
  createEmptySceneDocument,
  sanitizeSceneEnvironment,
  type SceneEnvironmentSettings,
} from '../../src/editor/model/SceneDocument';
import {
  calculateEnvironmentOriginLeftOffset,
  calculateEnvironmentSceneBaseOffset,
} from '../../src/runtime/babylon/environmentPlacement';
import {
  createEnvironmentFromAsset,
} from '../../src/editor/assets/environmentAssets';
import { deserializeScene, serializeScene } from '../../src/editor/project/SceneSerializer';
import type { ProjectModelAssetEntry } from '../../src/editor/assets/AssetDatabase';

function createEnvironmentAsset(assetRevision = 'revision-new'): ProjectModelAssetEntry {
  return {
    id: 'C:/project/Assets/Environments/factory/factory.glb',
    name: 'factory.glb',
    displayName: '示例厂区',
    path: 'C:/project/Assets/Environments/factory/factory.glb',
    sourceUrl: 'editor-asset://local/factory.glb',
    assetRevision,
    kind: 'model',
    libraryKind: 'environment',
    packagePath: 'C:/project/Assets/Environments/factory',
    lengthUnit: 'meter',
    unitScaleToMeters: 1,
    fileSizeBytes: 20 * 1024 * 1024,
  };
}

function createVariants(revision: string) {
  return [
    {
      name: '默认预设',
      sourcePath: 'C:/project/Assets/Environments/factory/factory.glb',
      sourceUrl: `editor-asset://local/factory.glb?assetRevision=${revision}`,
    },
    {
      name: '夜间效果',
      sourcePath: 'C:/project/Assets/Environments/factory/factory-night.glb',
      sourceUrl: `editor-asset://local/factory-night.glb?assetRevision=${revision}`,
    },
  ];
}

test('旧环境配置缺少显示字段时保持 legacy-left 摆放并补齐安全默认值', () => {
  const environment = sanitizeSceneEnvironment({
    packagePath: 'C:/project/Assets/Environments/legacy',
    activeVariantUrl: 'editor-asset://local/legacy.glb',
    variants: [{
      name: '旧环境',
      sourcePath: 'C:/project/Assets/Environments/legacy/legacy.glb',
      sourceUrl: 'editor-asset://local/legacy.glb',
    }],
  });

  assert.ok(environment);
  assert.equal(environment.placementMode, 'legacy-left');
  assert.deepEqual(environment.transform, createDefaultSceneEnvironmentTransform());
  assert.equal(environment.visible, true);
  assert.equal(environment.opacity, 1);
  assert.equal(environment.lengthUnit, 'meter');
  assert.equal(environment.unitScaleToMeters, 1);
});

test('新环境资产创建 scene-base 配置并保存资源摘要字段', () => {
  const asset = createEnvironmentAsset();
  const environment = createEnvironmentFromAsset(asset, createVariants('revision-new'));

  assert.ok(environment);
  assert.equal(environment.placementMode, 'scene-base');
  assert.deepEqual(environment.transform, createDefaultSceneEnvironmentTransform());
  assert.equal(environment.visible, true);
  assert.equal(environment.opacity, 1);
  assert.equal(environment.displayName, '示例厂区');
  assert.equal(environment.fileSizeBytes, 20 * 1024 * 1024);
});

test('环境配置归一化限制透明度和统一缩放，并拒绝非有限 Transform 分量', () => {
  const environment = sanitizeSceneEnvironment({
    packagePath: 'C:/project/Assets/Environments/factory',
    lengthUnit: 'meter',
    unitScaleToMeters: 1,
    placementMode: 'scene-base',
    transform: {
      position: { x: 4, y: Number.NaN, z: -2 },
      rotation: { x: 0.1, y: Number.POSITIVE_INFINITY, z: 0.3 },
      scale: -5,
    },
    visible: false,
    opacity: 2,
    activeVariantUrl: 'editor-asset://local/factory.glb',
    variants: [{
      name: '默认预设',
      sourcePath: 'C:/project/Assets/Environments/factory/factory.glb',
      sourceUrl: 'editor-asset://local/factory.glb',
    }],
  });

  assert.ok(environment);
  assert.deepEqual(environment.transform, {
    position: { x: 4, y: 0, z: -2 },
    rotation: { x: 0.1, y: 0, z: 0.3 },
    scale: 1,
  });
  assert.equal(environment.visible, false);
  assert.equal(environment.opacity, 1);
});

test('环境资源刷新保留用户摆放、显示状态和按 sourcePath 匹配的活动变体', () => {
  const previous = createEnvironmentFromAsset(createEnvironmentAsset('revision-old'), createVariants('revision-old'))!;
  const customized: SceneEnvironmentSettings = {
    ...previous,
    activeVariantUrl: previous.variants[1].sourceUrl,
    transform: {
      position: { x: 12, y: 1.5, z: -8 },
      rotation: { x: 0, y: Math.PI / 3, z: 0 },
      scale: 1.25,
    },
    visible: false,
    opacity: 0.35,
    lengthUnit: 'millimeter',
    unitScaleToMeters: 0.001,
  };

  const refreshed = createEnvironmentFromAsset(
    createEnvironmentAsset('revision-new'),
    createVariants('revision-new'),
    customized,
  );

  assert.ok(refreshed);
  assert.deepEqual(refreshed.transform, customized.transform);
  assert.equal(refreshed.visible, false);
  assert.equal(refreshed.opacity, 0.35);
  assert.equal(refreshed.lengthUnit, 'millimeter');
  assert.equal(refreshed.unitScaleToMeters, 0.001);
  assert.equal(refreshed.activeVariantUrl, refreshed.variants[1].sourceUrl);
  assert.equal(refreshed.placementMode, 'scene-base');
});

test('scene-base 摆放按 X/Z 中心和 Y 底部计算，旧版左侧摆放保持原契约', () => {
  const minimum = { x: 10, y: -2, z: -5 };
  const maximum = { x: 30, y: 8, z: 15 };

  assert.deepEqual(calculateEnvironmentSceneBaseOffset(minimum, maximum), {
    x: -20,
    y: 2,
    z: -5,
  });
  assert.deepEqual(calculateEnvironmentOriginLeftOffset(minimum, maximum), {
    x: -32,
    y: 2,
    z: -5,
  });
  assert.equal(
    calculateEnvironmentSceneBaseOffset({ x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 1 }),
    null,
  );
});

test('环境显示字段可序列化往返，旧场景反序列化后仍标记为 legacy-left', () => {
  const asset = createEnvironmentAsset();
  const environment = createEnvironmentFromAsset(asset, createVariants('revision-new'))!;
  const scene = createEmptySceneDocument('环境场景');
  scene.sceneSettings.environment = {
    ...environment,
    transform: {
      position: { x: 3, y: 0.5, z: -4 },
      rotation: { x: 0, y: 0.75, z: 0 },
      scale: 0.8,
    },
    opacity: 0.25,
  };

  const restored = deserializeScene(serializeScene(scene));
  assert.deepEqual(restored.sceneSettings.environment, scene.sceneSettings.environment);

  const legacyScene = createEmptySceneDocument('旧环境场景');
  const legacyEnvironment = {
    packagePath: 'C:/project/Assets/Environments/legacy',
    activeVariantUrl: 'editor-asset://local/legacy.glb',
    variants: [{
      name: '旧环境',
      sourcePath: 'C:/project/Assets/Environments/legacy/legacy.glb',
      sourceUrl: 'editor-asset://local/legacy.glb',
    }],
  };
  const legacyContent = JSON.stringify({
    version: 3,
    units: { length: 'meter' },
    scene: {
      ...legacyScene,
      sceneSettings: {
        ...legacyScene.sceneSettings,
        environment: legacyEnvironment,
      },
    },
  });
  const restoredLegacy = deserializeScene(legacyContent);
  assert.equal(restoredLegacy.sceneSettings.environment?.placementMode, 'legacy-left');
});
