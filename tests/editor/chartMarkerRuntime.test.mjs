import assert from 'node:assert/strict';
import test from 'node:test';
import { FreeCamera, MeshBuilder, NullEngine, RawTexture, Scene, Vector3 } from '@babylonjs/core';
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
  const { getChartMarkerCorners, getChartMarkerText } = await server.ssrLoadModule(
    '/src/runtime/babylon/ChartMarkerPresentation.ts',
  );
  const { deviceTelemetryStore, parseDeviceTelemetryMessage } = await server.ssrLoadModule(
    '/src/runtime/mqtt/deviceTelemetry.ts',
  );
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
      chartMarker: { ...marker.components.chartMarker, contentType: 'screen', screenName: source.name },
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
    assert.deepEqual(document.entities[marker.id].components.chartMarker, marker.components.chartMarker);
    assert.equal(item.markerStyle.contentType, 'builtin');
    assert.equal(item.markerText, marker.components.chartMarker.text);
    assert.deepEqual(document.entities[marker.id].components.transform, marker.components.transform);
  });

  await context.test('旧场景空组件重开保留原有大屏朝向和高度', (t) => {
    const { runtime, scene } = setup(t);
    const marker = makeMarker();
    marker.components.chartMarker = {};
    const document = deserializeScene(serializeScene(makeDocument([marker])));
    runtime.sync(document);
    const [item] = runtime.getDataPlatformScreenOverlayItems();
    assert.deepEqual(document.entities[marker.id].components.chartMarker, {});
    assert.equal(item.markerStyle.contentType, 'screen');
    assert.equal(item.markerStyle.floatHeight, 0);
    assert.equal(item.markerStyle.faceCamera, false);
    assert.equal(item.markerStyle.appearance, 'none');
    assert.equal(scene.getMeshByName(`${item.mesh.name}_indicator`), null);
  });

  await context.test('尺寸和悬浮高度更新真实边界与投影角点，保留 Transform 和 Gizmo 根', (t) => {
    const { runtime } = setup(t);
    const marker = makeMarker();
    marker.components.chartMarker = { ...marker.components.chartMarker, faceCamera: false };
    runtime.sync(makeDocument([marker]));
    const [first] = runtime.getDataPlatformScreenOverlayItems();
    const root = first.mesh;
    const transform = structuredClone(marker.components.transform);
    const world = [...root.computeWorldMatrix(true).asArray()];
    const readWorldCorners = () => getChartMarkerCorners(root).map((point) => Vector3.TransformCoordinates(point, root.computeWorldMatrix(true)));
    const before = readWorldCorners();
    const beforeBounds = root.getBoundingInfo().boundingBox;
    const oldMinimum = beforeBounds.minimumWorld.clone();
    const oldMaximum = beforeBounds.maximumWorld.clone();
    const next = {
      ...marker,
      components: {
        ...marker.components,
        chartMarker: { ...marker.components.chartMarker, width: 640, height: 360, floatHeight: 4 },
      },
    };
    runtime.sync(makeDocument([next]));
    const [item] = runtime.getDataPlatformScreenOverlayItems();
    const after = readWorldCorners();
    assert.equal(item.mesh, root);
    assert.equal(runtime.getGizmoTargetByEntityId(marker.id), root);
    assert.deepEqual(next.components.transform, transform);
    assert.deepEqual([...root.computeWorldMatrix(true).asArray()], world);
    assert.ok(Math.abs(Vector3.Distance(after[0], after[1]) / Vector3.Distance(before[0], before[1]) - 2) < 1e-5);
    assert.ok(Math.abs(Vector3.Distance(after[0], after[3]) / Vector3.Distance(before[0], before[3]) - 2) < 1e-5);
    const center = (points) => points.reduce((sum, point) => sum.add(point), Vector3.Zero()).scale(1 / 4);
    assert.ok(Math.abs(center(after).y - center(before).y - 3) < 1e-5);
    const bounds = root.getBoundingInfo().boundingBox;
    assert.ok(!bounds.minimumWorld.equalsWithEpsilon(oldMinimum) || !bounds.maximumWorld.equalsWithEpsilon(oldMaximum));
    for (const corner of after) {
      for (const axis of ['x', 'y', 'z']) {
        assert.ok(corner[axis] >= bounds.minimumWorld[axis] - 1e-5 && corner[axis] <= bounds.maximumWorld[axis] + 1e-5,
          'Overlay 角点必须与可拾取几何的世界边界一致');
      }
    }
  });

  await context.test('面向摄像机随相机移动更新角点，关闭后恢复原旋转且不改写世界矩阵', (t) => {
    const { runtime, scene } = setup(t);
    const camera = new FreeCamera('chart-marker-camera', new Vector3(8, 6, -15), scene);
    scene.activeCamera = camera;
    const marker = makeMarker();
    runtime.sync(makeDocument([marker]));
    const root = runtime.getGizmoTargetByEntityId(marker.id);
    const world = [...root.computeWorldMatrix(true).asArray()];
    const readCorners = () => {
      camera.setTarget(root.position);
      camera.getViewMatrix(true);
      runtime.getDataPlatformScreenOverlayItems();
      return getChartMarkerCorners(root).map((point) => Vector3.TransformCoordinates(point, root.computeWorldMatrix(true)));
    };
    const assertFacingCamera = (corners) => {
      const normal = Vector3.Cross(corners[1].subtract(corners[0]), corners[3].subtract(corners[0])).normalize();
      const center = corners.reduce((sum, point) => sum.add(point), Vector3.Zero()).scale(1 / 4);
      const direction = camera.globalPosition.subtract(center).normalize();
      assert.ok(Math.abs(Vector3.Dot(normal, direction)) > 0.9999, '几何平面法线应对准相机');
    };
    const first = readCorners();
    assertFacingCamera(first);
    camera.position.set(-12, 9, 4);
    const moved = readCorners();
    assertFacingCamera(moved);
    assert.ok(moved.some((corner, index) => !corner.equalsWithEpsilon(first[index])));
    assert.deepEqual([...root.computeWorldMatrix(true).asArray()], world);
    const fixed = { ...marker, components: { ...marker.components, chartMarker: { ...marker.components.chartMarker, faceCamera: false } } };
    runtime.sync(makeDocument([fixed]));
    const fixedCorners = readCorners();
    camera.position.set(16, 1, -8);
    assert.deepEqual(readCorners().map((corner) => corner.asArray()), fixedCorners.map((corner) => corner.asArray()));
    const originalWidthDirection = Vector3.TransformNormal(Vector3.Right(), root.computeWorldMatrix(true)).normalize();
    assert.ok(Vector3.Dot(fixedCorners[1].subtract(fixedCorners[0]).normalize(), originalWidthDirection) > 0.9999);
    assert.equal(runtime.getGizmoTargetByEntityId(marker.id), root);
    assert.deepEqual([...root.computeWorldMatrix(true).asArray()], world);
  });

  await context.test('指示器跟随隐藏和外观开关，并在删除时释放几何与材质', (t) => {
    const { runtime, scene } = setup(t);
    const marker = makeMarker();
    runtime.sync(makeDocument([marker]));
    const [{ mesh }] = runtime.getDataPlatformScreenOverlayItems();
    const stem = scene.getMeshByName(`${mesh.name}_indicator`);
    const base = scene.getMeshByName(`${mesh.name}_indicator_base`);
    assert.ok(stem && base);
    assert.equal(stem.isPickable, false);
    const material = stem.material;
    runtime.sync(makeDocument([{ ...marker, visible: false }]));
    assert.deepEqual(runtime.getDataPlatformScreenOverlayItems(), []);
    assert.equal(stem.isEnabled(), false);
    assert.equal(base.isEnabled(), false);
    runtime.sync(makeDocument([{ ...marker, components: { ...marker.components, chartMarker: { ...marker.components.chartMarker, appearance: 'none' } } }]));
    runtime.getDataPlatformScreenOverlayItems();
    assert.equal(stem.isEnabled(), false);
    assert.equal(base.isEnabled(), false);
    runtime.sync(makeDocument([marker]));
    runtime.getDataPlatformScreenOverlayItems();
    assert.equal(stem.isEnabled(), true);
    assert.equal(base.isEnabled(), true);
    runtime.sync(makeDocument([]));
    assert.equal(stem.isDisposed(), true);
    assert.equal(base.isDisposed(), true);
    assert.equal(scene.materials.includes(material), false);
  });

  await context.test('数据驱动使用指定设备和数据源，支持零、false、精确字段与点路径并安全回退', (t) => {
    const { runtime } = setup(t);
    const sourceId = 'chart-marker-regression';
    t.after(() => deviceTelemetryStore.clear(sourceId));
    const source = createFolderEntity('测试设备');
    source.components.telemetryBinding = { enabled: true, assetCode: 'MARKER-001', deviceType: 'sensor', sourceId, staleAfterMs: 10000 };
    const marker = makeMarker();
    marker.components.chartMarker = {
      ...marker.components.chartMarker, text: '等待数据', driveMode: 'data', dataSourceEntityId: source.id, dataField: 'count',
    };
    const snapshot = parseDeviceTelemetryMessage(
      'dt/factory/logistics/sensor/MARKER-001/twindatadriven/joint',
      JSON.stringify({ seq: 1, data: [
        { p: 'count', v: 0 }, { p: 'running', v: false }, { p: 'empty', v: '' },
        { p: 'nested', v: { value: 12, active: false } }, { p: 'nested.value', v: 34 },
        { p: 'invalid', v: null }, { p: 'list', v: [1, 2] },
      ] }),
      { sourceId },
    );
    assert.ok(snapshot);
    assert.equal(deviceTelemetryStore.upsert(snapshot), true);
    runtime.sync(makeDocument([source, marker]));
    assert.equal(runtime.getDataPlatformScreenOverlayItems()[0].markerText, '等待数据', '编辑态不展示上次运行数据');
    runtime.beginTelemetryPreview();
    assert.equal(runtime.getDataPlatformScreenOverlayItems()[0].markerText, '0');
    const style = runtime.getDataPlatformScreenOverlayItems()[0].markerStyle;
    for (const [dataField, expected] of [['running', 'false'], ['empty', ''], ['nested.value', '34'], ['nested.active', 'false']]) {
      assert.equal(getChartMarkerText({ ...style, dataField }, source, true), expected);
    }
    for (const dataField of ['missing', 'nested', 'invalid', 'list', 'nested.__proto__', 'constructor', 'nested.missing']) {
      assert.equal(getChartMarkerText({ ...style, dataField }, source, true), '等待数据', dataField);
    }
    assert.equal(getChartMarkerText(style, undefined, true), '等待数据');
    assert.equal(getChartMarkerText({ ...style, driveMode: 'none' }, source, true), '等待数据');
    for (const binding of [{ enabled: false }, { sourceId: 'unrelated-source' }, { assetCode: 'OTHER' }, { deviceType: 'other' }]) {
      const changedSource = { ...source, components: { ...source.components, telemetryBinding: { ...source.components.telemetryBinding, ...binding } } };
      assert.equal(getChartMarkerText(style, changedSource, true), '等待数据');
    }
    deviceTelemetryStore.clear(sourceId);
    deviceTelemetryStore.upsert({ ...snapshot, receivedAt: Date.now() - 30000 });
    assert.equal(getChartMarkerText(style, source, true), '等待数据', '过期快照不得继续展示旧值');
    runtime.endTelemetryPreview();
    assert.equal(runtime.getDataPlatformScreenOverlayItems()[0].markerText, '等待数据');
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

  await context.test('运行左键拾取允许锁定立标，并遵守前景遮挡与显隐', (t) => {
    const { runtime, scene } = setup(t);
    const camera = new FreeCamera('click-camera', new Vector3(0, 2, -10), scene);
    camera.setTarget(new Vector3(0, 2, 0));
    scene.activeCamera = camera;
    const marker = createChartMarkerEntity({ x: 0, y: 0, z: 0 });
    marker.locked = true;
    marker.components.chartMarker = { ...marker.components.chartMarker, faceCamera: false, floatHeight: 0, clickAction: 'focus' };
    const document = makeDocument([marker]);
    runtime.sync(document);
    scene.render();
    const engine = scene.getEngine();
    const canvas = { getBoundingClientRect: () => ({ left: 0, top: 0, width: engine.getRenderWidth(), height: engine.getRenderHeight() }) };
    const pick = () => runtime.pickChartMarkerAtCanvasPoint(engine.getRenderWidth() / 2, engine.getRenderHeight() / 2, canvas);
    assert.equal(pick(), marker.id, 'authoring lock 不能禁用运行时点击');
    const blocker = MeshBuilder.CreateBox('foreground', { size: 3 }, scene);
    blocker.position.set(0, 2, -3);
    blocker.isPickable = false;
    scene.render();
    assert.equal(pick(), null, '即使前景不可编辑也应遮挡后方点击');
    blocker.setEnabled(false);
    assert.equal(pick(), marker.id);
    runtime.sync(makeDocument([{ ...marker, visible: false }]));
    assert.equal(pick(), null, '隐藏立标不能触发');
    runtime.sync(document);
    const front = createChartMarkerEntity({ x: 0, y: 0, z: -2 });
    front.components.chartMarker = { ...front.components.chartMarker, faceCamera: false, floatHeight: 0 };
    runtime.sync(makeDocument([marker, front]));
    scene.render();
    assert.equal(pick(), front.id, '前景无动作立标同样阻挡后方立标');
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
