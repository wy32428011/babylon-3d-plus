import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import type { SceneSkyboxSettings } from '../../src/editor/model/SceneDocument';
import type { ProjectSkyboxAssetEntry } from '../../src/editor/assets/AssetDatabase';
import { importIsolatedTypeScriptModules } from '../helpers/extensionlessTypeScriptTestBootstrap.ts';


const [sceneDocumentModule, sceneSerializerModule, deploymentExportModule, skyboxAssetsModule] =
  await importIsolatedTypeScriptModules<[
    typeof import('../../src/editor/model/SceneDocument'),
    typeof import('../../src/editor/project/SceneSerializer'),
    typeof import('../../src/editor/deployment/deploymentExport'),
    typeof import('../../src/editor/assets/skyboxAssets'),
  ]>([
    'src/editor/model/SceneDocument.ts',
    'src/editor/project/SceneSerializer.ts',
    'src/editor/deployment/deploymentExport.ts',
    'src/editor/assets/skyboxAssets.ts',
  ]);
const {
  createDefaultSceneSettings,
  createEmptySceneDocument,
  createSkyboxEntity,
  getSceneSkyboxSettings,
  getSkyboxSphereDiameterMeters,
  isPointInsideSkyboxSphere,
  normalizeSkyboxSphereScale,
  sanitizeSceneSkybox,
  sanitizeSceneViewDistance,
  SCENE_SKYBOX_VIEW_DISTANCE_MIN,
  SCENE_VIEW_DISTANCE_DEFAULT,
  SKYBOX_FOCUS_VIEW_DISTANCE_METERS,
  SKYBOX_SPHERE_DIAMETER_METERS,
  SKYBOX_SPHERE_SCALE_MAX,
  SKYBOX_SPHERE_SCALE_MIN,
} = sceneDocumentModule;
const { deserializeScene, serializeScene } = sceneSerializerModule;
const { createDeploymentSceneSummary } = deploymentExportModule;
const { createSceneSkyboxFromAsset, findSkyboxAssetForSettings } = skyboxAssetsModule;

const VALID_SKYBOX: SceneSkyboxSettings = {
  packagePath: String.raw`C:\Project\Assets\Skyboxes\grasslands_sunset_4k.hdr`,
  sourcePath: String.raw`C:\Project\Assets\Skyboxes\grasslands_sunset_4k.hdr\grasslands_sunset_4k.hdr`,
  sourceUrl: 'editor-asset://local/C%3A%5CProject%5CAssets%5CSkyboxes%5Cgrasslands_sunset_4k.hdr%5Cgrasslands_sunset_4k.hdr',
  assetRevision: 'revision-1',
  format: 'hdr',
  rotationDegrees: 0,
  intensity: 1,
  resolution: 512,
};


function createHandwrittenLegacySkyboxFile(
  version: 1 | 2,
  dataPlatformResourceId?: string,
): string {
  return JSON.stringify({
    version,
    scene: {
      id: `legacy-skybox-v${version}`,
      name: `Legacy Skybox v${version}`,
      entityIds: [],
      entities: {},
      sceneSettings: {
        camera: {
          savedPose: null,
          viewDistance: 12000,
        },
        sensitivity: {
          zoom: 1,
          pan: 1,
          rotate: 1,
        },
        environment: null,
        skybox: {
          packagePath: String.raw`D:\Legacy\Skyboxes\factory.hdr`,
          sourcePath: String.raw`D:\Legacy\Skyboxes\factory.hdr\factory.hdr`,
          sourceUrl: 'editor-asset://local/D%3A%5CLegacy%5CSkyboxes%5Cfactory.hdr%5Cfactory.hdr',
          assetRevision: 'legacy-revision',
          ...(dataPlatformResourceId ? { dataPlatformResourceId } : {}),
          format: 'hdr',
          rotationDegrees: 45,
          intensity: 1.25,
          resolution: 512,
        },
      },
    },
  });
}

test('天空盒默认关闭，合法设置会约束旋转、强度与立方体分辨率', () => {
  const defaults = createDefaultSceneSettings();
  assert.equal(defaults.skybox, null);
  assert.equal(defaults.camera.viewDistance, SCENE_VIEW_DISTANCE_DEFAULT);
  assert.equal(SCENE_VIEW_DISTANCE_DEFAULT, 12000);

  assert.deepEqual(sanitizeSceneSkybox({
    ...VALID_SKYBOX,
    rotationDegrees: 720,
    intensity: 9,
    resolution: 768 as 512,
  }), {
    ...VALID_SKYBOX,
    rotationDegrees: 360,
    intensity: 5,
    resolution: 512,
  });
});

test('天空盒拒绝非授权 URL、空路径和扩展名与格式不匹配的设置', () => {
  assert.equal(sanitizeSceneSkybox({ ...VALID_SKYBOX, sourceUrl: 'https://example.com/sky.hdr' }), null);
  assert.equal(sanitizeSceneSkybox({ ...VALID_SKYBOX, sourceUrl: VALID_SKYBOX.sourceUrl.replace(/\.hdr$/i, '.exr') }), null);
  assert.equal(sanitizeSceneSkybox({ ...VALID_SKYBOX, packagePath: '  ' }), null);
  assert.equal(sanitizeSceneSkybox({ ...VALID_SKYBOX, sourcePath: VALID_SKYBOX.sourcePath.replace(/\.hdr$/i, '.exr') }), null);
});



test('天空盒稳定资源 ID 仅接受 trim 后 1-64 位正十进制字符串且不修改输入', () => {
  const input = { ...VALID_SKYBOX, dataPlatformResourceId: '  2052912068767571969  ' };
  const snapshot = structuredClone(input);
  assert.deepEqual(sanitizeSceneSkybox(input), {
    ...VALID_SKYBOX,
    dataPlatformResourceId: '2052912068767571969',
  });
  assert.deepEqual(input, snapshot);

  const withoutId = sanitizeSceneSkybox({ ...VALID_SKYBOX });
  assert.ok(withoutId);
  assert.equal('dataPlatformResourceId' in withoutId, false);

  const invalidIds: unknown[] = ['', ' ', '0', '-1', '1e3', '01', '1.0', '+1', '9'.repeat(65), 1, null];
  for (const dataPlatformResourceId of invalidIds) {
    assert.equal(
      sanitizeSceneSkybox({ ...VALID_SKYBOX, dataPlatformResourceId } as SceneSkyboxSettings),
      null,
      `应拒绝 ${String(dataPlatformResourceId)}`,
    );
  }
});

test('天空盒稳定资源 ID 不从原型或 getter 继承，实体组件与设置转换只传递自有数据字段', () => {
  const inherited = Object.assign(Object.create({ dataPlatformResourceId: '88' }), VALID_SKYBOX) as SceneSkyboxSettings;
  const inheritedResult = sanitizeSceneSkybox(inherited);
  assert.ok(inheritedResult);
  assert.equal('dataPlatformResourceId' in inheritedResult, false);

  let getterReads = 0;
  const accessor = { ...VALID_SKYBOX } as SceneSkyboxSettings;
  Object.defineProperty(accessor, 'dataPlatformResourceId', {
    enumerable: true,
    get() {
      getterReads += 1;
      return '99';
    },
  });
  const accessorResult = sanitizeSceneSkybox(accessor);
  assert.ok(accessorResult);
  assert.equal('dataPlatformResourceId' in accessorResult, false);
  assert.equal(getterReads, 0);

  const scene = createEmptySceneDocument('Getter Skybox');
  const entity = createSkyboxEntity(VALID_SKYBOX);
  Object.defineProperty(entity.components.skybox!, 'dataPlatformResourceId', {
    enumerable: true,
    get() {
      getterReads += 1;
      return '100';
    },
  });
  scene.entityIds.push(entity.id);
  scene.entities[entity.id] = entity;
  const settings = getSceneSkyboxSettings(scene);
  assert.ok(settings);
  assert.equal('dataPlatformResourceId' in settings, false);
  assert.equal(getterReads, 0);
});

test('version 3 实体保存加载与 version 1/2 场景设置迁移保真稳定资源 ID，缺失字段仍兼容', () => {
  const resourceId = '2052912068767571969';
  const entityScene = createEmptySceneDocument('Stable ID Entity');
  const entity = createSkyboxEntity({ ...VALID_SKYBOX, dataPlatformResourceId: resourceId });
  entityScene.entityIds.push(entity.id);
  entityScene.entities[entity.id] = entity;
  const serialized = serializeScene(entityScene);
  assert.equal((JSON.parse(serialized) as { version: number }).version, 3);
  assert.equal(getSceneSkyboxSettings(deserializeScene(serialized))?.dataPlatformResourceId, resourceId);

  for (const version of [1, 2] as const) {
    const legacyScene = createEmptySceneDocument(`Legacy v${version}`);
    legacyScene.sceneSettings.skybox = { ...VALID_SKYBOX, dataPlatformResourceId: resourceId };
    const document = JSON.parse(serializeScene(legacyScene)) as { version: number };
    document.version = version;
    const restored = deserializeScene(JSON.stringify(document));
    assert.equal(getSceneSkyboxSettings(restored)?.dataPlatformResourceId, resourceId);
    assert.equal(restored.sceneSettings.skybox, null);
  }

  for (const version of [1, 2, 3] as const) {
    const legacyScene = createEmptySceneDocument(`Missing ID v${version}`);
    legacyScene.sceneSettings.skybox = { ...VALID_SKYBOX };
    const document = JSON.parse(serializeScene(legacyScene)) as { version: number };
    document.version = version;
    const restored = deserializeScene(JSON.stringify(document));
    const settings = getSceneSkyboxSettings(restored);
    assert.ok(settings);
    assert.equal('dataPlatformResourceId' in settings, false);
  }
});

test('SceneSerializer 在 scene settings 与实体组件两处清晰拒绝非法稳定资源 ID', () => {
  const invalidId = '01';
  const legacyScene = createEmptySceneDocument('Invalid settings ID');
  legacyScene.sceneSettings.skybox = { ...VALID_SKYBOX, dataPlatformResourceId: invalidId };
  assert.throws(
    () => deserializeScene(serializeScene(legacyScene)),
    /dataPlatformResourceId.*1-64/,
  );

  const entityScene = createEmptySceneDocument('Invalid component ID');
  const entity = createSkyboxEntity(VALID_SKYBOX);
  entity.components.skybox = { ...entity.components.skybox!, dataPlatformResourceId: invalidId };
  entityScene.entityIds.push(entity.id);
  entityScene.entities[entity.id] = entity;
  assert.throws(
    () => deserializeScene(serializeScene(entityScene)),
    /dataPlatformResourceId.*1-64/,
  );
});



test('稳定资源 ID 接受 1 位和 64 位合法边界', () => {
  for (const dataPlatformResourceId of ['1', '9'.repeat(64)]) {
    const normalized = sanitizeSceneSkybox({ ...VALID_SKYBOX, dataPlatformResourceId });
    assert.ok(normalized);
    assert.equal(normalized.dataPlatformResourceId, dataPlatformResourceId);
    assert.equal(createSkyboxEntity(normalized).components.skybox?.dataPlatformResourceId, dataPlatformResourceId);
  }
});

test('own-data descriptor 不受 Object.prototype.value 污染且不执行 accessor getter', () => {
  const previousValueDescriptor = Object.getOwnPropertyDescriptor(Object.prototype, 'value');
  let descriptorPrototypeReads = 0;
  let resourceGetterReads = 0;
  const accessor = { ...VALID_SKYBOX } as SceneSkyboxSettings;
  Object.defineProperty(accessor, 'dataPlatformResourceId', {
    configurable: true,
    enumerable: true,
    get() {
      resourceGetterReads += 1;
      return '8';
    },
  });
  Object.defineProperty(Object.prototype, 'value', {
    configurable: true,
    get() {
      descriptorPrototypeReads += 1;
      return '7';
    },
  });

  try {
    const normalized = sanitizeSceneSkybox(accessor);
    assert.ok(normalized);
    assert.equal('dataPlatformResourceId' in normalized, false);
    assert.equal(descriptorPrototypeReads, 0);
    assert.equal(resourceGetterReads, 0);
  } finally {
    if (previousValueDescriptor) {
      Object.defineProperty(Object.prototype, 'value', previousValueDescriptor);
    } else {
      delete (Object.prototype as { value?: unknown }).value;
    }
  }
});

test('serializeScene 对 scene settings 和实体天空盒生成安全 snapshot，保留 non-enumerable ID 且不修改输入', () => {
  const settingsScene = createEmptySceneDocument('Non-enumerable Settings ID');
  const settingsSkybox = { ...VALID_SKYBOX };
  Object.defineProperty(settingsSkybox, 'dataPlatformResourceId', {
    configurable: true,
    enumerable: false,
    writable: true,
    value: '1',
  });
  settingsScene.sceneSettings.skybox = settingsSkybox;
  const settingsDescriptorBefore = Object.getOwnPropertyDescriptor(settingsSkybox, 'dataPlatformResourceId');
  const settingsContent = serializeScene(settingsScene);
  const settingsRaw = JSON.parse(settingsContent) as {
    scene: { sceneSettings: { skybox: { dataPlatformResourceId?: string } } };
  };
  assert.equal(settingsRaw.scene.sceneSettings.skybox.dataPlatformResourceId, '1');
  assert.equal(getSceneSkyboxSettings(deserializeScene(settingsContent))?.dataPlatformResourceId, '1');
  assert.deepEqual(
    Object.getOwnPropertyDescriptor(settingsSkybox, 'dataPlatformResourceId'),
    settingsDescriptorBefore,
  );

  const entityScene = createEmptySceneDocument('Non-enumerable Component ID');
  const entity = createSkyboxEntity(VALID_SKYBOX);
  const maximumId = '9'.repeat(64);
  Object.defineProperty(entity.components.skybox!, 'dataPlatformResourceId', {
    configurable: true,
    enumerable: false,
    writable: true,
    value: maximumId,
  });
  entityScene.entityIds.push(entity.id);
  entityScene.entities[entity.id] = entity;
  const componentDescriptorBefore = Object.getOwnPropertyDescriptor(
    entity.components.skybox!,
    'dataPlatformResourceId',
  );
  const entityContent = serializeScene(entityScene);
  const entityRaw = JSON.parse(entityContent) as {
    scene: { entities: Record<string, { components: { skybox: { dataPlatformResourceId?: string } } }> };
  };
  assert.equal(
    entityRaw.scene.entities[entity.id].components.skybox.dataPlatformResourceId,
    maximumId,
  );
  assert.equal(getSceneSkyboxSettings(deserializeScene(entityContent))?.dataPlatformResourceId, maximumId);
  assert.deepEqual(
    Object.getOwnPropertyDescriptor(entity.components.skybox!, 'dataPlatformResourceId'),
    componentDescriptorBefore,
  );
});

test('serializeScene 不执行稳定 ID getter，并在保存入口拒绝 accessor 与非法 ID', () => {
  let getterReads = 0;
  const accessorSettingsScene = createEmptySceneDocument('Accessor Settings ID');
  const accessorSettings = { ...VALID_SKYBOX };
  Object.defineProperty(accessorSettings, 'dataPlatformResourceId', {
    enumerable: true,
    get() {
      getterReads += 1;
      return '1';
    },
  });
  accessorSettingsScene.sceneSettings.skybox = accessorSettings;
  assert.throws(() => serializeScene(accessorSettingsScene), /dataPlatformResourceId.*1-64/);
  assert.equal(getterReads, 0);

  const accessorEntityScene = createEmptySceneDocument('Accessor Component ID');
  const accessorEntity = createSkyboxEntity(VALID_SKYBOX);
  Object.defineProperty(accessorEntity.components.skybox!, 'dataPlatformResourceId', {
    enumerable: true,
    get() {
      getterReads += 1;
      return '1';
    },
  });
  accessorEntityScene.entityIds.push(accessorEntity.id);
  accessorEntityScene.entities[accessorEntity.id] = accessorEntity;
  assert.throws(() => serializeScene(accessorEntityScene), /dataPlatformResourceId.*1-64/);
  assert.equal(getterReads, 0);

  const invalidSettingsScene = createEmptySceneDocument('Invalid Settings ID');
  invalidSettingsScene.sceneSettings.skybox = { ...VALID_SKYBOX, dataPlatformResourceId: '01' };
  assert.throws(() => serializeScene(invalidSettingsScene), /dataPlatformResourceId.*1-64/);

  const invalidEntityScene = createEmptySceneDocument('Invalid Component ID');
  const invalidEntity = createSkyboxEntity(VALID_SKYBOX);
  invalidEntity.components.skybox = {
    ...invalidEntity.components.skybox!,
    dataPlatformResourceId: '01',
  };
  invalidEntityScene.entityIds.push(invalidEntity.id);
  invalidEntityScene.entities[invalidEntity.id] = invalidEntity;
  assert.throws(() => serializeScene(invalidEntityScene), /dataPlatformResourceId.*1-64/);
});

test('真实手写 version 1/2 场景 fixture 缺失字段兼容并保真合法稳定 ID', () => {
  for (const version of [1, 2] as const) {
    const withId = deserializeScene(createHandwrittenLegacySkyboxFile(version, '1'));
    assert.equal(getSceneSkyboxSettings(withId)?.dataPlatformResourceId, '1');
    assert.equal(withId.sceneSettings.skybox, null);

    const withoutId = deserializeScene(createHandwrittenLegacySkyboxFile(version));
    const settings = getSceneSkyboxSettings(withoutId);
    assert.ok(settings);
    assert.equal('dataPlatformResourceId' in settings, false);
  }
});

test('天空盒资源创建为可移动球体实体，Transform Y 旋转映射为天空纹理水平旋转', () => {
  const entity = createSkyboxEntity(
    { ...VALID_SKYBOX, rotationDegrees: 135, intensity: 1.7, resolution: 1024 },
    { x: 4, y: 6, z: 8 },
  );
  const scene = createEmptySceneDocument('Skybox Sphere');
  scene.entityIds.push(entity.id);
  scene.entities[entity.id] = entity;

  assert.deepEqual(entity.components.transform.position, { x: 4, y: 6, z: 8 });
  assert.equal(entity.components.skybox?.format, 'hdr');
  assert.equal(entity.components.skybox?.intensity, 1.7);
  assert.ok(Math.abs(entity.components.transform.rotation.y - 135 * Math.PI / 180) < 1e-9);
  assert.deepEqual(getSceneSkyboxSettings(scene), {
    ...VALID_SKYBOX,
    rotationDegrees: 135,
    intensity: 1.7,
    resolution: 1024,
  });
  const defaultEntity = createSkyboxEntity(VALID_SKYBOX);
  assert.deepEqual(defaultEntity.components.transform.position, { x: 0, y: 0, z: 0 });
  assert.deepEqual(defaultEntity.components.transform.scale, { x: 1, y: 1, z: 1 });
  assert.equal(SKYBOX_SPHERE_DIAMETER_METERS, 10000);
  assert.equal(getSkyboxSphereDiameterMeters(defaultEntity.components.transform.scale), 10000);
});

test('天空盒尺寸始终等比缩放，旧三轴取最大绝对值并限制到 0.1-1.0', () => {
  assert.equal(SKYBOX_SPHERE_SCALE_MIN, 0.1);
  assert.equal(SKYBOX_SPHERE_SCALE_MAX, 1);
  assert.deepEqual(normalizeSkyboxSphereScale({ x: -0.5, y: 0.8, z: 2 }), { x: 1, y: 1, z: 1 });
  assert.deepEqual(normalizeSkyboxSphereScale({ x: 0.01, y: -0.02, z: 0.03 }), { x: 0.1, y: 0.1, z: 0.1 });
  assert.equal(getSkyboxSphereDiameterMeters({ x: 0.5, y: 0.5, z: 0.5 }), 5000);
  assert.equal(
    isPointInsideSkyboxSphere(
      { position: { x: 10, y: 0, z: 0 }, scale: { x: 0.5, y: 0.5, z: 0.5 } },
      { x: 2509, y: 0, z: 0 },
    ),
    true,
  );
  assert.equal(
    isPointInsideSkyboxSphere(
      { position: { x: 10, y: 0, z: 0 }, scale: { x: 0.5, y: 0.5, z: 0.5 } },
      { x: 2511, y: 0, z: 0 },
    ),
    false,
  );
  assert.equal(sanitizeSceneViewDistance(5000, SCENE_SKYBOX_VIEW_DISTANCE_MIN), 12000);
  assert.equal(SKYBOX_FOCUS_VIEW_DISTANCE_METERS, 20000);
});

test('球形天空盒实体可随 version 3 场景保存加载，旧场景级天空盒会自动迁移为实体', () => {
  const scene = createEmptySceneDocument('Skybox Roundtrip');
  const entity = createSkyboxEntity({ ...VALID_SKYBOX, rotationDegrees: 90 });
  entity.components.transform.scale = { x: -0.5, y: 0.8, z: 2 };
  scene.sceneSettings.camera.viewDistance = 5000;
  scene.entityIds.push(entity.id);
  scene.entities[entity.id] = entity;

  const restored = deserializeScene(serializeScene(scene));
  assert.equal(restored.sceneSettings.skybox, null);
  assert.deepEqual(getSceneSkyboxSettings(restored), { ...VALID_SKYBOX, rotationDegrees: 90 });
  assert.equal(restored.entityIds.length, 1);
  assert.equal(restored.sceneSettings.camera.viewDistance, SCENE_SKYBOX_VIEW_DISTANCE_MIN);
  assert.deepEqual(restored.entities[entity.id].components.transform.scale, { x: 1, y: 1, z: 1 });

  const legacyScene = createEmptySceneDocument('Legacy Skybox');
  legacyScene.sceneSettings.camera.viewDistance = 5000;
  legacyScene.sceneSettings.skybox = { ...VALID_SKYBOX, rotationDegrees: 135 };
  const restoredLegacy = deserializeScene(serializeScene(legacyScene));
  assert.equal(restoredLegacy.sceneSettings.skybox, null);
  assert.equal(restoredLegacy.entityIds.length, 1);
  assert.equal(restoredLegacy.sceneSettings.camera.viewDistance, SCENE_SKYBOX_VIEW_DISTANCE_MIN);
  assert.deepEqual(
    restoredLegacy.entities[restoredLegacy.entityIds[0]].components.transform.position,
    { x: 0, y: 0, z: 0 },
  );
  assert.deepEqual(getSceneSkyboxSettings(restoredLegacy), { ...VALID_SKYBOX, rotationDegrees: 135 });

  const disabledDocument = JSON.parse(serializeScene(createEmptySceneDocument())) as {
    scene: { sceneSettings: { camera: { viewDistance: number }; skybox?: unknown } };
  };
  disabledDocument.scene.sceneSettings.camera.viewDistance = 5000;
  delete disabledDocument.scene.sceneSettings.skybox;
  const restoredDisabled = deserializeScene(JSON.stringify(disabledDocument));
  assert.equal(getSceneSkyboxSettings(restoredDisabled), null);
  assert.equal(restoredDisabled.sceneSettings.camera.viewDistance, 5000);
});

test('场景加载拒绝重复球形天空盒实体', () => {
  const scene = createEmptySceneDocument('Duplicate Skyboxes');
  const first = createSkyboxEntity(VALID_SKYBOX);
  const second = createSkyboxEntity({ ...VALID_SKYBOX, sourcePath: VALID_SKYBOX.sourcePath.replace(/\.hdr$/i, '-2.hdr') });
  scene.entityIds.push(first.id, second.id);
  scene.entities[first.id] = first;
  scene.entities[second.id] = second;

  assert.throws(() => deserializeScene(serializeScene(scene)), /场景文件格式不受支持/);
});

const PROJECT_SKYBOX_ASSET: ProjectSkyboxAssetEntry = {
  id: String.raw`C:\Project\Assets\Skyboxes\grasslands_sunset_4k.hdr\grasslands_sunset_4k.hdr`,
  name: 'grasslands_sunset_4k.hdr',
  displayName: 'grasslands_sunset_4k',
  path: String.raw`C:\Project\Assets\Skyboxes\grasslands_sunset_4k.hdr\grasslands_sunset_4k.hdr`,
  sourceUrl: 'editor-asset://local/C%3A%5CProject%5CAssets%5CSkyboxes%5Cgrasslands_sunset_4k.hdr%5Cgrasslands_sunset_4k.hdr',
  assetRevision: 'asset-revision-2',
  packagePath: String.raw`C:\Project\Assets\Skyboxes\grasslands_sunset_4k.hdr`,
  kind: 'skybox',
  libraryKind: 'skybox',
  format: 'hdr',
  fileSizeBytes: 1024,
  source: 'project',
  availability: 'active',
};

test('从资源创建天空盒时使用默认参数，重导刷新路径时保留场景级参数', () => {
  const initial = createSceneSkyboxFromAsset(PROJECT_SKYBOX_ASSET);
  assert.equal(initial.rotationDegrees, 0);
  assert.equal(initial.intensity, 1);
  assert.equal(initial.resolution, 512);

  const refreshed = createSceneSkyboxFromAsset(
    { ...PROJECT_SKYBOX_ASSET, assetRevision: 'asset-revision-3' },
    { ...initial, rotationDegrees: 210, intensity: 2.4, resolution: 1024 },
  );
  assert.equal(refreshed.assetRevision, 'asset-revision-3');
  assert.equal(refreshed.rotationDegrees, 210);
  assert.equal(refreshed.intensity, 2.4);
  assert.equal(refreshed.resolution, 1024);
});

test('天空盒跨电脑重关联按包目录名和文件名匹配，歧义时拒绝自动选择', () => {
  const oldSettings = {
    ...VALID_SKYBOX,
    packagePath: String.raw`D:\Legacy\Assets\Skyboxes\grasslands_sunset_4k.hdr`,
    sourcePath: String.raw`D:\Legacy\Assets\Skyboxes\grasslands_sunset_4k.hdr\grasslands_sunset_4k.hdr`,
  };
  assert.equal(findSkyboxAssetForSettings(oldSettings, [PROJECT_SKYBOX_ASSET]), PROJECT_SKYBOX_ASSET);
  assert.equal(
    findSkyboxAssetForSettings(oldSettings, [PROJECT_SKYBOX_ASSET, { ...PROJECT_SKYBOX_ASSET, id: 'duplicate', path: String.raw`E:\Other\Assets\Skyboxes\grasslands_sunset_4k.hdr\grasslands_sunset_4k.hdr` }]),
    null,
  );
});


test('部署导出摘要把球形天空盒实体计入唯一资源', () => {
  const scene = createEmptySceneDocument('Skybox Summary');
  const entity = createSkyboxEntity(VALID_SKYBOX);
  scene.entityIds.push(entity.id);
  scene.entities[entity.id] = entity;

  assert.deepEqual(createDeploymentSceneSummary(scene), {
    entityCount: 1,
    resourceCount: 1,
    modelCount: 0,
    environmentCount: 0,
    skyboxCount: 1,
    cadCount: 0,
    scriptCount: 0,
  });
});


test('独立 Viewer 导出会收集和改写天空盒，并接受编辑器当前 version 3 场景', () => {
  const runtimeSource = readFileSync('src/runtime/babylon/SceneSkyboxRuntime.ts', 'utf8');
  assert.match(runtimeSource, /skyboxResolution/);
  assert.match(runtimeSource, /MeshBuilder\.CreateSphere/);
  assert.doesNotMatch(runtimeSource, /MeshBuilder\.CreateBox/);

  const source = readFileSync('electron/ipc/deploymentExportScene.ts', 'utf8');
  assert.match(source, /type BundleCategory = .*'skyboxes'/);
  assert.match(source, /sceneSettings.skybox/);
  assert.match(source, /components.skybox/);
  assert.match(source, /resolveSkyboxReference/);
  assert.match(source, /rewriteSkyboxReferences/);
  assert.match(source, /sceneFile.version !== 1 && sceneFile.version !== 2 && sceneFile.version !== 3/);

  const sceneViewSource = readFileSync('src/editor/panels/SceneViewPanel.tsx', 'utf8');
  assert.match(sceneViewSource, /SKYBOX_ASSET_DRAG_MIME_TYPE/);
  assert.match(
    sceneViewSource,
    /placeSkybox\(createSceneSkyboxFromAsset\(skyboxAsset, currentSkybox\), placementPosition\)/,
  );
  assert.doesNotMatch(sceneViewSource, /SKYBOX_SPHERE_DIAMETER_METERS/);
  assert.match(sceneViewSource, /SKYBOX_FOCUS_VIEW_DISTANCE_METERS/);
  assert.match(sceneViewSource, /components\.skybox/);

  const sceneRuntimeSource = readFileSync('src/runtime/babylon/SceneRuntime.ts', 'utf8');
  assert.match(sceneRuntimeSource, /isPointInsideSkyboxSphere/);
  assert.match(
    sceneRuntimeSource,
    /private readEntityIdFromMesh[\s\S]*?this\.skyboxRuntime\.hasEntity\(entityId\)[\s\S]*?: null;/,
  );

  const inspectorSource = readFileSync('src/editor/panels/InspectorPanel.tsx', 'utf8');
  assert.match(inspectorSource, /尺寸倍率/);
  assert.match(inspectorSource, /实际直径/);

  const gizmoSource = readFileSync('src/runtime/babylon/TransformGizmoController.ts', 'utf8');
  assert.match(gizmoSource, /uniformScaleOnly/);

  const sceneSettingsSource = readFileSync('src/editor/panels/SceneSettingsPanel.tsx', 'utf8');
  assert.match(sceneSettingsSource, /SCENE_SKYBOX_VIEW_DISTANCE_MIN/);

  const editorStoreSource = readFileSync('src/editor/store/editorStore.ts', 'utf8');
  assert.match(editorStoreSource, /visible:\s*options\.revealEntity \? true : existing\.visible/);
  assert.match(editorStoreSource, /revealEntity:\s*true/);

  const projectServiceSource = readFileSync('electron/ipc/dataPlatformProjectService.ts', 'utf8');
  assert.match(projectServiceSource, /Skyboxes/);
  assert.match(projectServiceSource, /setSharedProjectSkyboxRoot\(context\.sharedResourcesRoot\)/);

  const projectIpcSource = readFileSync('electron/ipc/projectIpc.ts', 'utf8');
  assert.match(projectIpcSource, /authorizeSceneSkyboxFile/);
});
