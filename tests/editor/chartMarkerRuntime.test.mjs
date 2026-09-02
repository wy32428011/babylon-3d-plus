import assert from 'node:assert/strict';
import test from 'node:test';
import { NullEngine, RawTexture, Scene } from '@babylonjs/core';
import { createServer } from 'vite';

const SCREEN_SOURCE = {
  projectId: '2040000000000000001',
  screenId: '2040000000000000002',
  name: '设备监控',
  screenUrl: 'https://screen.example.com/#/bigscreen-designer/preview/2040000000000000002',
};

test('图表立标运行时与保存重开边界', async (context) => {
  const server = await createServer({
    configFile: false,
    root: process.cwd(),
    logLevel: 'silent',
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true },
    ssr: { noExternal: ['@linkiez/dxf-renew'] },
  });
  context.after(() => server.close());
  const { SceneRuntime } = await server.ssrLoadModule('/src/runtime/babylon/SceneRuntime.ts');
  const { createChartMarkerEntity } = await server.ssrLoadModule('/src/editor/model/chartMarker.ts');
  const { createDataPlatformScreenComponent, createDataPlatformScreenEntity } = await server.ssrLoadModule(
    '/src/editor/model/dataPlatformScreen.ts',
  );
  const { createEmptySceneDocument, createFolderEntity } = await server.ssrLoadModule(
    '/src/editor/model/SceneDocument.ts',
  );
  const { serializeScene, deserializeScene } = await server.ssrLoadModule('/src/editor/project/SceneSerializer.ts');

  const makeDocument = (entities) => ({
    ...createEmptySceneDocument('图表立标回归'),
    entityIds: entities.map((entity) => entity.id),
    entities: Object.fromEntries(entities.map((entity) => [entity.id, entity])),
  });
  const makeMarker = () => createChartMarkerEntity({ x: 3, y: 0, z: -5 });
  const bindScreen = (marker, source = SCREEN_SOURCE) => ({
    ...marker,
    components: {
      ...marker.components,
      chartMarker: { screenName: source.name },
      dataPlatformScreen: createDataPlatformScreenComponent(source),
    },
  });
  const setup = (t) => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const runtime = new SceneRuntime(scene);
    let disposed = false;
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      runtime.dispose();
    };
    t.after(() => {
      try {
        dispose();
      } finally {
        scene.dispose();
        engine.dispose();
      }
    });
    return { runtime, scene, dispose };
  };

  await context.test('空立标具有可拾取平面和待绑定 Overlay，保存重开后仍存在', (t) => {
    const { runtime } = setup(t);
    const marker = makeMarker();
    const document = deserializeScene(serializeScene(makeDocument([marker])));
    runtime.sync(document);
    const [item] = runtime.getDataPlatformScreenOverlayItems();
    assert.ok(item, '未绑定图表的立标也需要 Overlay 接收拖入内容');
    assert.equal(item.entityId, marker.id);
    assert.equal(item.chartMarker, true);
    assert.equal(item.name, marker.name);
    assert.equal(item.screenUrl, undefined);
    assert.equal(item.mesh, runtime.getGizmoTargetByEntityId(marker.id));
    assert.equal(item.mesh.isPickable, true);
    assert.equal(item.mesh.isEnabled(), true);
    assert.deepEqual(document.entities[marker.id].components.chartMarker, {});
    assert.deepEqual(document.entities[marker.id].components.transform, marker.components.transform);
  });

  await context.test('绑定、替换、清空及重开保持原 Gizmo 根与位置，并更新实时页面引用', (t) => {
    const { runtime } = setup(t);
    const marker = makeMarker();
    runtime.sync(makeDocument([marker]));
    const root = runtime.getGizmoTargetByEntityId(marker.id);
    assert.ok(root);
    const originalWorld = [...root.computeWorldMatrix(true).asArray()];
    const replacement = {
      ...SCREEN_SOURCE,
      screenId: '2040000000000000003',
      name: '产线总览',
      screenUrl: 'https://screen.example.com/#/bigscreen-designer/published/2040000000000000003',
    };

    for (const source of [SCREEN_SOURCE, replacement]) {
      const document = deserializeScene(serializeScene(makeDocument([bindScreen(marker, source)])));
      runtime.sync(document);
      const [item] = runtime.getDataPlatformScreenOverlayItems();
      assert.equal(runtime.getGizmoTargetByEntityId(marker.id), root, '内容变化不应重建 Gizmo 绑定节点');
      assert.equal(item.mesh, root);
      assert.equal(item.chartMarker, true);
      assert.equal(item.projectId, source.projectId);
      assert.equal(item.screenId, source.screenId);
      assert.equal(item.screenUrl, source.screenUrl);
      assert.equal(item.renderMode, 'iframe');
      assert.deepEqual([...root.computeWorldMatrix(true).asArray()], originalWorld);
      assert.equal(document.entities[marker.id].components.chartMarker.screenName, source.name);
    }

    runtime.sync(makeDocument([marker]));
    const [emptyItem] = runtime.getDataPlatformScreenOverlayItems();
    assert.equal(emptyItem.mesh, root);
    assert.equal(emptyItem.screenUrl, undefined);
    assert.equal(root.isDisposed(), false);
  });

  await context.test('自身及祖先隐藏均移除 Overlay，恢复可见时复用原平面', (t) => {
    const { runtime } = setup(t);
    const folder = createFolderEntity('立标分组');
    const marker = { ...bindScreen(makeMarker()), parentId: folder.id };
    folder.childrenIds = [marker.id];
    runtime.sync(makeDocument([folder, marker]));
    const root = runtime.getGizmoTargetByEntityId(marker.id);

    for (const entities of [
      [folder, { ...marker, visible: false }],
      [{ ...folder, visible: false }, marker],
    ]) {
      runtime.sync(deserializeScene(serializeScene(makeDocument(entities))));
      assert.deepEqual(runtime.getDataPlatformScreenOverlayItems(), []);
      assert.equal(root.isEnabled() && root.isVisible && root.visibility > 0, false);
      runtime.sync(makeDocument([folder, marker]));
      assert.equal(runtime.getDataPlatformScreenOverlayItems()[0].mesh, root);
      assert.equal(root.isEnabled() && root.isVisible && root.visibility > 0, true);
    }
  });

  await context.test('清空带缩略图的大屏同时解除材质纹理引用并释放纹理', (t) => {
    const { runtime, scene } = setup(t);
    const marker = makeMarker();
    const thumbnailUrl = 'https://screen.example.com/thumbnail.png';
    const texture = RawTexture.CreateRGBATexture(new Uint8Array([255, 255, 255, 255]), 1, 1, scene);
    // 用已就绪的本地纹理模拟缓存，覆盖真实绑定与清空同步路径而不依赖网络。
    runtime.dataPlatformScreenTextures.set(marker.id, { url: thumbnailUrl, texture });
    runtime.sync(makeDocument([bindScreen(marker, { ...SCREEN_SOURCE, thumbnailUrl })]));
    const root = runtime.getGizmoTargetByEntityId(marker.id);
    assert.ok(root);
    assert.equal(root.material.diffuseTexture, texture);

    runtime.sync(makeDocument([marker]));
    assert.equal(root.material.diffuseTexture, null, '空牌不得保留已经释放的缩略图纹理');
    assert.equal(runtime.dataPlatformScreenTextures.has(marker.id), false);
    assert.equal(scene.textures.includes(texture), false);
    assert.equal(texture.getInternalTexture(), null);
    assert.equal(runtime.getDataPlatformScreenOverlayItems()[0].mesh, root);
    assert.equal(root.isPickable, true);
  });

  await context.test('自身及祖先锁定保留展示，但禁止拾取和 Gizmo 编辑', (t) => {
    const { runtime } = setup(t);
    const folder = createFolderEntity('锁定分组');
    const marker = { ...bindScreen(makeMarker()), parentId: folder.id };
    folder.childrenIds = [marker.id];
    for (const entities of [
      [folder, { ...marker, locked: true }],
      [{ ...folder, locked: true }, marker],
    ]) {
      runtime.sync(makeDocument(entities));
      const [item] = runtime.getDataPlatformScreenOverlayItems();
      assert.ok(item, '锁定不能让大屏停止展示');
      assert.equal(item.mesh.isEnabled(), true);
      assert.equal(item.mesh.isPickable, false);
      assert.equal(runtime.getGizmoTargetByEntityId(marker.id), null);
    }
    runtime.sync(makeDocument([folder, marker]));
    assert.equal(runtime.getDataPlatformScreenOverlayItems()[0].mesh.isPickable, true);
  });

  await context.test('运行预览及普通大屏平面保持兼容，删除后 Overlay 和几何同步释放', (t) => {
    const { runtime } = setup(t);
    const emptyMarker = makeMarker();
    const marker = bindScreen(makeMarker());
    const ordinaryScreen = createDataPlatformScreenEntity(SCREEN_SOURCE, { x: 8, y: 2, z: 0 });
    const document = makeDocument([emptyMarker, marker, ordinaryScreen]);
    runtime.sync(document);
    const items = runtime.getDataPlatformScreenOverlayItems();
    assert.equal(items.length, 3);
    const ordinaryItem = items.find((item) => item.entityId === ordinaryScreen.id);
    assert.ok(ordinaryItem);
    assert.notEqual(ordinaryItem.chartMarker, true);
    assert.equal(ordinaryItem.screenUrl, SCREEN_SOURCE.screenUrl);
    assert.equal(ordinaryItem.renderMode, 'iframe');

    runtime.beginTelemetryPreview();
    runtime.sync(document);
    assert.deepEqual(runtime.getDataPlatformScreenOverlayItems().map((item) => item.mesh), items.map((item) => item.mesh));
    runtime.endTelemetryPreview();
    assert.equal(runtime.getDataPlatformScreenOverlayItems().length, 3);
    runtime.sync(makeDocument([]));
    assert.deepEqual(runtime.getDataPlatformScreenOverlayItems(), []);
    assert.ok(items.every((item) => item.mesh.isDisposed()));
    assert.equal(runtime.getGizmoTargetByEntityId(marker.id), null);
  });

  await context.test('退出运行时释放立标资源，并清空供 Overlay 使用的引用', (t) => {
    const { runtime, dispose } = setup(t);
    const marker = bindScreen(makeMarker());
    runtime.sync(makeDocument([marker]));
    const [item] = runtime.getDataPlatformScreenOverlayItems();
    assert.ok(item);
    dispose();
    assert.equal(item.mesh.isDisposed(), true);
    assert.deepEqual(runtime.getDataPlatformScreenOverlayItems(), []);
    assert.equal(runtime.getGizmoTargetByEntityId(marker.id), null);
  });
});
