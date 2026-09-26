import assert from 'node:assert/strict';
import test from 'node:test';
import { FreeCamera, MeshBuilder, NullEngine, Ray, Scene, Vector3, VertexBuffer } from '@babylonjs/core';
import { createServer } from 'vite';

const close = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-5,
  `${message}: expected ${expected}, got ${actual}`);

test('环形图表立标真实几何与生命周期', async (t) => {
  const server = await createServer({ configFile: false, root: process.cwd(), logLevel: 'silent',
    server: { middlewareMode: true, hmr: false, watch: null }, optimizeDeps: { noDiscovery: true } });
  t.after(() => server.close());
  const presentationModule = await server.ssrLoadModule('/src/runtime/babylon/ChartMarkerPresentation.ts');
  const { ChartMarkerPresentation } = presentationModule;
  const { CHART_MARKER_DEFAULTS } = await server.ssrLoadModule('/src/editor/model/chartMarker.ts');
  const setup = (context) => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const mesh = MeshBuilder.CreateGround('marker', { width: 2, height: 2, updatable: true }, scene);
    mesh.scaling.set(2, 1.125, 1);
    mesh.position.set(3, 1.125, -5);
    mesh.isPickable = true;
    const presentation = new ChartMarkerPresentation();
    const component = { ...CHART_MARKER_DEFAULTS, panelShape: 'ring', ringRadius: 3, floatHeight: 1 };
    context.after(() => { presentation.remove(mesh); scene.dispose(); engine.dispose(); });
    const facets = () => presentationModule.getChartMarkerRingFacets(mesh);
    const worldFacets = () => facets().map(facet => facet.map(point => Vector3.TransformCoordinates(point, mesh.computeWorldMatrix(true))));
    return { scene, mesh, presentation, component, facets, worldFacets };
  };

  await t.test('360 度闭合侧壁半径为米、保持镂空且 UV 连续', (context) => {
    const { mesh, scene, presentation, component, facets, worldFacets } = setup(context);
    const worldBefore = Array.from(mesh.computeWorldMatrix(true).asArray());
    presentation.update(mesh, component, true);
    assert.equal(typeof presentationModule.getChartMarkerRingFacets, 'function');
    const actual = worldFacets();
    assert.equal(actual.length, 96);
    for (const facet of actual) {
      for (const point of facet) close(Math.hypot(point.x - 3, point.z + 5), 3, '默认根缩放不能把圆环压成椭圆');
      close(facet[0].y - facet[3].y, 2.25, 'height=180 对应 2.25 米');
      close(facet[0].y, 3.25, '屏幕上边高度');
    }
    close(Vector3.Distance(actual[0][0], actual.at(-1)[1]), 0, '接缝闭合');
    assert.equal(mesh.getTotalVertices(), 194);
    assert.equal(mesh.getTotalIndices(), 576);
    const uv = mesh.getVerticesData(VertexBuffer.UVKind);
    const normals = mesh.getVerticesData(VertexBuffer.NormalKind);
    for (let index = 0; index <= 96; index++) {
      const point = Vector3.FromArray(mesh.getVerticesData(VertexBuffer.PositionKind), index * 6);
      const normal = Vector3.FromArray(normals, index * 6);
      assert.ok(Vector3.Dot(new Vector3(point.x, 0, point.z), normal) > 0, '侧壁正面朝向圆环外侧');
    }
    close(uv[0], 0, '左接缝 U');
    close(uv.at(-2), 1, '右接缝 U');
    for (let index = 0; index <= 96; index++) {
      close(uv[index * 4], index / 96, '连续 U');
      close(uv[index * 4 + 1], 1, '顶部 V');
      close(uv[index * 4 + 3], 0, '底部 V');
    }
    assert.deepEqual(Array.from(mesh.computeWorldMatrix(true).asArray()), worldBefore, '不得修改权威 Transform / Gizmo 根');
    assert.equal(scene.pickWithRay(new Ray(new Vector3(3, 8, -5), Vector3.Down()), part => part === mesh).hit, false, '顶部和中心应镂空');
    assert.equal(scene.pickWithRay(new Ray(new Vector3(3, 2, -12), Vector3.Forward()), part => part === mesh).hit, true, '侧壁可拾取');
    const bounds = mesh.getBoundingInfo().boundingBox;
    close(bounds.maximumWorld.x - bounds.minimumWorld.x, 6, '可拾取边界宽度');
    assert.equal(facets()[48][1].x > facets()[48][0].x, true, '前侧文字从左到右展开');
  });

  await t.test('环形不受相机或展开宽度影响，尺寸和用户变换继续生效', (context) => {
    const { mesh, scene, presentation, component, worldFacets } = setup(context);
    scene.activeCamera = new FreeCamera('camera', new Vector3(0, 5, -20), scene);
    presentation.update(mesh, component, true);
    const original = worldFacets();
    scene.activeCamera.position.set(15, 8, 4);
    scene.activeCamera.getViewMatrix(true);
    presentation.update(mesh, { ...component, width: 900, faceCamera: false }, true);
    assert.deepEqual(worldFacets(), original);
    mesh.scaling.set(4, 2.25, 2);
    mesh.rotation.y = Math.PI / 2;
    presentation.update(mesh, { ...component, ringRadius: 4, height: 360 }, true);
    const changed = worldFacets();
    close(changed[0][0].y - changed[0][3].y, 9, '高度和用户缩放各自生效');
    for (const facet of changed) {
      for (const point of facet) close(Math.hypot(point.x - 3, point.z + 5), 8, '额外的等比缩放与旋转');
    }
  });

  await t.test('环形与矩形反复切换完整恢复拓扑，隐藏和删除无遗留辅助网格', (context) => {
    const { mesh, scene, presentation, component, facets } = setup(context);
    const original = Object.fromEntries([VertexBuffer.PositionKind, VertexBuffer.NormalKind, VertexBuffer.UVKind]
      .map(kind => [kind, Array.from(mesh.getVerticesData(kind))]));
    const originalIndices = Array.from(mesh.getIndices());
    const plane = { ...component, panelShape: 'plane', faceCamera: false };
    presentation.update(mesh, plane, true);
    const expectedPlane = Array.from(mesh.getVerticesData(VertexBuffer.PositionKind));
    for (let iteration = 0; iteration < 3; iteration++) {
      presentation.update(mesh, component, true);
      assert.equal(facets().length, 96);
      const rims = scene.meshes.filter(part => part.name.includes('_ring_rim_'));
      assert.equal(rims.length, 2);
      assert.ok(rims.every(part => !part.isPickable && part.isEnabled()));
      const stem = scene.getMeshByName('marker_indicator');
      const anchor = scene.getMeshByName('marker_indicator_base').position;
      close(Vector3.Distance(anchor, new Vector3(3, 0, -5)), 0, '保持原实体地面锚点');
      const midpoint = new Vector3(3, 0.5, -6.5);
      close(Vector3.Distance(stem.position, midpoint), 0, '指示线连接前侧底边');
      presentation.update(mesh, component, false);
      assert.ok(rims.every(part => !part.isEnabled() || part.isDisposed()));
      assert.equal(stem.isEnabled(), false);
      presentation.update(mesh, component, true);
      assert.equal(scene.meshes.filter(part => part.name.includes('_ring_rim_') && part.isEnabled()).length, 2);
      presentation.update(mesh, plane, true);
      assert.equal(facets().length, 0);
      assert.equal(scene.meshes.filter(part => part.name.includes('_ring_rim_')).length, 0);
      assert.deepEqual(Array.from(mesh.getVerticesData(VertexBuffer.PositionKind)), expectedPlane);
      assert.deepEqual(Array.from(mesh.getIndices()), originalIndices);
      assert.deepEqual(Array.from(mesh.getVerticesData(VertexBuffer.UVKind)), original.uv);
      assert.equal(mesh.getVerticesData(VertexBuffer.NormalKind).length, original.normal.length);
    }
    presentation.update(mesh, component, true);
    presentation.remove(mesh);
    for (const [kind, values] of Object.entries(original)) assert.deepEqual(Array.from(mesh.getVerticesData(kind)), values);
    assert.deepEqual(Array.from(mesh.getIndices()), originalIndices);
    assert.equal(scene.meshes.length, 1);
    assert.equal(scene.materials.some(material => material.name.includes('indicator')), false);
    assert.equal(facets().length, 0);
  });
});
