import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  createDefaultSceneSettings,
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
  type SceneSkyboxSettings,
} from '../../src/editor/model/SceneDocument';
import { deserializeScene, serializeScene } from '../../src/editor/project/SceneSerializer';
import { createEmptySceneDocument } from '../../src/editor/model/SceneDocument';
import { createDeploymentSceneSummary } from '../../src/editor/deployment/deploymentExport';
import {
  createSceneSkyboxFromAsset,
  findSkyboxAssetForSettings,
} from '../../src/editor/assets/skyboxAssets';
import type { ProjectSkyboxAssetEntry } from '../../src/editor/assets/AssetDatabase';

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
