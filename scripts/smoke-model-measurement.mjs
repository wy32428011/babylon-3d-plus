import assert from 'node:assert/strict';
import { MeshBuilder, NullEngine, Scene, TransformNode, Vector3 } from '@babylonjs/core';
import { createServer } from 'vite';

/** 比较米制尺寸，允许 Babylon 世界矩阵计算产生极小浮点误差。 */
function assertClose(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) <= 1e-6, `${message}: ${actual} !== ${expected}`);
}

/** 校验三轴米制尺寸。 */
function assertSize(actual, expected, message) {
  assert.ok(actual, `${message}: 未返回尺寸`);
  assertClose(actual.x, expected.x, `${message} X`);
  assertClose(actual.y, expected.y, `${message} Y`);
  assertClose(actual.z, expected.z, `${message} Z`);
}

let server;
const engine = new NullEngine();
const scene = new Scene(engine);

try {
  server = await createServer({
    configFile: false,
    root: process.cwd(),
    server: { middlewareMode: true, hmr: { port: 24679, clientPort: 24679 } },
    optimizeDeps: { noDiscovery: true },
  });

  const measurementModule = await server.ssrLoadModule('/src/runtime/babylon/modelMeasurement.ts');
  const { measureModelSizeMeters } = measurementModule;

  const root = new TransformNode('entityRoot', scene);
  const contentRoot = new TransformNode('contentRoot', scene);
  contentRoot.parent = root;
  contentRoot.scaling.copyFromFloats(0.01, 0.01, 0.01);

  const box = MeshBuilder.CreateBox('box', { width: 18, height: 18, depth: 32 }, scene);
  box.parent = contentRoot;

  assertSize(
    measureModelSizeMeters(root, contentRoot),
    { x: 0.18, y: 0.18, z: 0.32 },
    '厘米源模型必须按米测量',
  );

  root.rotation.copyFromFloats(0.35, Math.PI / 3, -0.2);
  assertSize(
    measureModelSizeMeters(root, contentRoot),
    { x: 0.18, y: 0.18, z: 0.32 },
    '模型旋转不应改变自身轴向尺寸',
  );

  root.scaling.copyFromFloats(2, 3, 4);
  assertSize(
    measureModelSizeMeters(root, contentRoot),
    { x: 0.36, y: 0.54, z: 1.28 },
    '用户非均匀缩放必须反映到实际尺寸',
  );

  root.scaling.copyFromFloats(1, 1, 1);
  contentRoot.scaling.copyFromFloats(0.02, 0.015, 0.02);
  assertSize(
    measureModelSizeMeters(root, contentRoot),
    { x: 0.36, y: 0.27, z: 0.64 },
    '参数化脚本调整内容根后必须刷新实际尺寸',
  );

  const hidden = MeshBuilder.CreateBox('hidden-helper', { size: 1000 }, scene);
  hidden.parent = contentRoot;
  hidden.position.copyFromFloats(5000, 5000, 5000);
  hidden.isVisible = false;
  assertSize(
    measureModelSizeMeters(root, contentRoot),
    { x: 0.36, y: 0.27, z: 0.64 },
    '不可见辅助网格不得污染模型尺寸',
  );

  box.dispose();
  hidden.dispose();
  assert.equal(measureModelSizeMeters(root, contentRoot), null, '无有效网格时必须返回 null');

  console.log(JSON.stringify({
    ok: true,
    modelMeasurement: {
      sourceUnitScale: 0.01,
      rotationInvariant: true,
      transformScaleApplied: true,
      parameterScaleApplied: true,
      hiddenMeshesIgnored: true,
    },
  }, null, 2));
} finally {
  scene.dispose();
  engine.dispose();
  await server?.close();
}



