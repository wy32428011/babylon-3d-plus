import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { createServer } from 'vite';

const viteServer = await createServer({
  appType: 'custom',
  configFile: false,
  root: process.cwd(),
  server: { middlewareMode: true, hmr: false },
  optimizeDeps: { noDiscovery: true },
});
after(() => viteServer.close());

const { createEmptySceneDocument } = await viteServer.ssrLoadModule('/src/editor/model/SceneDocument.ts') as typeof import('../../src/editor/model/SceneDocument.ts');
const { createDataPlatformScreenEntity } = await viteServer.ssrLoadModule('/src/editor/model/dataPlatformScreen.ts') as typeof import('../../src/editor/model/dataPlatformScreen.ts');
const { deserializeScene, serializeScene } = await viteServer.ssrLoadModule('/src/editor/project/SceneSerializer.ts') as typeof import('../../src/editor/project/SceneSerializer.ts');

test('dataPlatformScreen 实体保存为带平面几何的可渲染场景组件', () => {
  const entity = createDataPlatformScreenEntity({
    projectId: 'project-1',
    screenId: 'screen-1',
    name: '设备总览',
    screenUrl: 'https://data.example.com/screens/screen-1',
    thumbnailUrl: 'https://data.example.com/screens/screen-1.png',
  });

  assert.equal(entity.components.meshRenderer?.meshKind, 'plane');
  assert.deepEqual(entity.components.dataPlatformScreen, {
    projectId: 'project-1',
    screenId: 'screen-1',
    screenUrl: 'https://data.example.com/screens/screen-1',
    thumbnailUrl: 'https://data.example.com/screens/screen-1.png',
    renderMode: 'iframe',
    widthMeters: 4,
    heightMeters: 2.25,
  });
  assert.equal(entity.components.transform.rotation.x, Math.PI / 2);
  assert.deepEqual(entity.components.transform.scale, { x: 2, y: 1, z: 1.125 });
});

test('dataPlatformScreen 随 v5 场景文件序列化往返，并兼容 v3 的别名字段迁移', () => {
  const scene = createEmptySceneDocument('大屏场景');
  const entity = createDataPlatformScreenEntity({
    projectId: 'project-1',
    screenId: 'screen-1',
    name: '设备总览',
    screenUrl: 'https://data.example.com/screens/screen-1',
  });
  scene.entityIds.push(entity.id);
  scene.entities[entity.id] = entity;

  const serialized = JSON.parse(serializeScene(scene)) as {
    version: number;
    scene: { entities: Record<string, { components: Record<string, Record<string, unknown>> }> };
  };
  assert.equal(serialized.version, 5);

  const restored = deserializeScene(JSON.stringify(serialized));
  assert.deepEqual(restored.entities[entity.id]?.components.dataPlatformScreen, entity.components.dataPlatformScreen);

  const legacy = JSON.parse(JSON.stringify(serialized)) as typeof serialized;
  legacy.version = 3;
  const legacyScreen = legacy.scene.entities[entity.id]?.components.dataPlatformScreen;
  assert.ok(legacyScreen);
  legacyScreen.mode = 'texture';
  legacyScreen.width = 6;
  legacyScreen.height = 3;
  delete legacyScreen.renderMode;
  delete legacyScreen.widthMeters;
  delete legacyScreen.heightMeters;

  const migrated = deserializeScene(JSON.stringify(legacy));
  assert.equal(migrated.entities[entity.id]?.components.dataPlatformScreen?.renderMode, 'texture');
  assert.equal(migrated.entities[entity.id]?.components.dataPlatformScreen?.widthMeters, 6);
  assert.equal(migrated.entities[entity.id]?.components.dataPlatformScreen?.heightMeters, 3);
});

test('纹理模式保留缩略图作为无 iframe 降级内容', () => {
  const entity = createDataPlatformScreenEntity({
    projectId: 'project-1',
    screenId: 'screen-texture',
    screenUrl: 'https://data.example.com/screens/screen-texture',
    thumbnailUrl: 'https://data.example.com/screens/screen-texture.png',
    renderMode: 'texture',
  });

  assert.equal(entity.components.dataPlatformScreen?.renderMode, 'texture');
  assert.equal(entity.components.dataPlatformScreen?.thumbnailUrl, 'https://data.example.com/screens/screen-texture.png');
});

test('dataPlatformScreen 拒绝危险地址和完全不可渲染的资源', () => {
  const scene = createEmptySceneDocument('非法大屏');
  const entity = createDataPlatformScreenEntity({
    projectId: 'project-1',
    screenId: 'screen-1',
    name: '非法大屏',
    screenUrl: 'https://data.example.com/screens/screen-1',
  });
  scene.entityIds.push(entity.id);
  scene.entities[entity.id] = entity;

  const serialized = JSON.parse(serializeScene(scene)) as {
    version: number;
    scene: { entities: Record<string, { components: Record<string, Record<string, unknown>> }> };
  };
  const screen = serialized.scene.entities[entity.id]?.components.dataPlatformScreen;
  assert.ok(screen);
  screen.screenUrl = 'javascript:alert(1)';
  assert.throws(() => deserializeScene(JSON.stringify(serialized)), /场景文件格式不受支持/);

  assert.throws(() => createDataPlatformScreenEntity({
    projectId: 'project-1',
    screenId: 'screen-2',
    name: '空资源',
  }), /大屏必须提供 screenUrl 或 thumbnailUrl/);
});
