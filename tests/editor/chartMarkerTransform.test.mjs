import assert from 'node:assert/strict';
import test from 'node:test';
import { Matrix, Quaternion, Vector3 } from '@babylonjs/core';
import { createServer } from 'vite';

const UPRIGHT_BASIS = Matrix.RotationX(Math.PI / 2);

function transformMatrix(transform) {
  return Matrix.Compose(
    new Vector3(transform.scale.x, transform.scale.y, transform.scale.z),
    Quaternion.RotationYawPitchRoll(transform.rotation.y, transform.rotation.x, transform.rotation.z),
    new Vector3(transform.position.x, transform.position.y, transform.position.z),
  );
}

function assertSameMatrix(actual, expected, message) {
  for (let index = 0; index < 16; index += 1) {
    assert.ok(Math.abs(actual.m[index] - expected.m[index]) < 2e-6,
      `${message}: matrix[${index}] expected ${expected.m[index]}, got ${actual.m[index]}`);
  }
}

test('图表立标坐标基准的旧场景兼容', async (t) => {
  const server = await createServer({
    configFile: false,
    root: process.cwd(),
    logLevel: 'silent',
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true },
    ssr: { noExternal: ['@linkiez/dxf-renew'] },
  });
  t.after(() => server.close());
  const { createEmptySceneDocument } = await server.ssrLoadModule('/src/editor/model/SceneDocument.ts');
  const { createChartMarkerEntity, normalizeChartMarker, resolveChartMarker } = await server.ssrLoadModule('/src/editor/model/chartMarker.ts');
  const { serializeScene, deserializeScene } = await server.ssrLoadModule('/src/editor/project/SceneSerializer.ts');

  const makeScene = (entity) => ({
    ...createEmptySceneDocument('坐标基准回归'),
    entityIds: [entity.id],
    entities: { [entity.id]: entity },
  });
  // 直接构造旧格式输入，避免保存入口提前转换掩盖加载兼容缺陷。
  const readOldScene = (entity) => deserializeScene(JSON.stringify({
    version: 5, units: { length: 'meter' }, scene: makeScene(entity),
  }));
  const makeLegacy = (component = {}) => {
    const entity = createChartMarkerEntity({ x: 3, y: 2, z: -4 });
    entity.components.chartMarker = { ...component };
    entity.components.transform = {
      position: { x: 3, y: 3.125, z: -4 },
      rotation: { x: Math.PI / 2, y: 0, z: 0 },
      scale: { x: 2, y: 1, z: 1.125 },
    };
    return entity;
  };

  await t.test('旧默认立标的根坐标轴归零且宽高与位置保持', () => {
    const legacy = makeLegacy();
    const restored = readOldScene(legacy).entities[legacy.id];
    assert.equal(restored.components.chartMarker.geometryBasis, 'upright');
    for (const value of Object.values(restored.components.transform.rotation)) assert.ok(Math.abs(value) < 1e-10);
    assert.deepEqual(restored.components.transform.position, legacy.components.transform.position);
    assert.deepEqual(restored.components.transform.scale, { x: 2, y: 1.125, z: 1 });
    assertSameMatrix(UPRIGHT_BASIS.multiply(transformMatrix(restored.components.transform)),
      transformMatrix(legacy.components.transform), '默认立标世界矩阵');
  });

  await t.test('多轴旋转和非等比及负缩放迁移后几何世界矩阵等价', () => {
    const rotations = [
      { x: 0, y: 0, z: 0 },
      { x: 0.73, y: -1.18, z: 0.39 },
      { x: -1.23, y: 2.06, z: -2.71 },
      { x: Math.PI / 2, y: 0.84, z: 1.32 },
    ];
    const scales = [
      { x: 3.5, y: 0.75, z: 2.25 },
      { x: -3.5, y: 0.75, z: 2.25 },
      { x: 3.5, y: -0.75, z: 2.25 },
      { x: 3.5, y: 0.75, z: -2.25 },
      { x: -3.5, y: -0.75, z: -2.25 },
    ];
    for (const rotation of rotations) {
      for (const scale of scales) {
        const legacy = makeLegacy({ geometryBasis: 'ground', faceCamera: false, width: 640, height: 270 });
        legacy.components.transform = {
          position: { x: -18.3, y: 6.125, z: 72 }, rotation, scale,
        };
        const snapshot = structuredClone(legacy);
        const restored = readOldScene(legacy).entities[legacy.id];
        assertSameMatrix(UPRIGHT_BASIS.multiply(transformMatrix(restored.components.transform)),
          transformMatrix(legacy.components.transform), JSON.stringify({ rotation, scale }));
        assert.deepEqual(restored.components.transform.scale, { x: scale.x, y: scale.z, z: scale.y });
        assert.deepEqual(legacy, snapshot, '读取不得修改输入对象');
      }
    }
  });

  await t.test('保存重开只迁移一次，upright组件与变换保持幂等', () => {
    const legacy = makeLegacy({ text: '旧立标', backgroundColor: '#123456', faceCamera: false });
    legacy.components.transform.rotation = { x: 0.81, y: -0.37, z: 1.26 };
    let scene = readOldScene(legacy);
    const expected = structuredClone(scene.entities[legacy.id]);
    for (let index = 0; index < 3; index += 1) {
      scene = deserializeScene(serializeScene(scene));
      assert.deepEqual(scene.entities[legacy.id], expected);
    }
    const fresh = createChartMarkerEntity({ x: 2, y: 1, z: 5 });
    assert.equal(fresh.components.chartMarker.geometryBasis, 'upright');
    assert.deepEqual(deserializeScene(serializeScene(makeScene(fresh))).entities[fresh.id].components, fresh.components);
  });

  await t.test('旧空组件和旧大屏外观缺省不会被新建立标默认值覆盖', () => {
    for (const component of [{}, { screenName: '旧大屏', contentType: 'screen' }]) {
      const legacy = makeLegacy(component);
      const restored = readOldScene(legacy).entities[legacy.id].components.chartMarker;
      assert.deepEqual(restored, { ...component, geometryBasis: 'upright' });
      const style = resolveChartMarker(restored);
      assert.equal(style.contentType, 'screen');
      assert.equal(style.backgroundColor, '#101827');
      assert.equal(style.floatHeight, 0);
      assert.equal(style.faceCamera, false);
      assert.equal(style.appearance, 'none');
    }
    assert.equal(resolveChartMarker({}).geometryBasis, 'ground');
  });

  await t.test('普通plane实体保持原变换且不会添加立标组件', () => {
    const plane = makeLegacy();
    delete plane.components.chartMarker;
    plane.components.transform.rotation = { x: 0.72, y: -0.31, z: 1.12 };
    const restored = readOldScene(plane).entities[plane.id];
    assert.deepEqual(restored.components.transform, plane.components.transform);
    assert.equal(restored.components.chartMarker, undefined);
  });

  await t.test('无效几何基准在属性与场景加载入口均被拒绝', () => {
    for (const geometryBasis of ['xy', 'xz', '', 1, true, null, {}, []]) {
      assert.throws(() => normalizeChartMarker({ geometryBasis }), /图表立标/);
      assert.throws(() => readOldScene(makeLegacy({ geometryBasis })), /场景/);
    }
    assert.deepEqual(normalizeChartMarker({ geometryBasis: 'ground' }), { geometryBasis: 'ground' });
    assert.deepEqual(normalizeChartMarker({ geometryBasis: 'upright' }), { geometryBasis: 'upright' });
  });
});
