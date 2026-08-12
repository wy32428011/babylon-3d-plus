import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'vite';

const EPSILON = 1e-6;

function assertClose(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) <= EPSILON, `${message}: expected ${expected}, got ${actual}`);
}

function assertQuaternionEquivalent(Quaternion, actualRotation, expectedRotation, message) {
  const actual = Quaternion.RotationYawPitchRoll(actualRotation.y, actualRotation.x, actualRotation.z).normalize();
  const expected = Quaternion.RotationYawPitchRoll(expectedRotation.y, expectedRotation.x, expectedRotation.z).normalize();
  const dot = Math.abs(Quaternion.Dot(actual, expected));
  assert.ok(Math.abs(1 - dot) <= EPSILON, `${message}: quaternion dot=${dot}`);
}

function transform(positionX, rotation) {
  return {
    position: { x: positionX, y: 0, z: 0 },
    rotation: { ...rotation },
    scale: { x: 1, y: 1, z: 1 },
  };
}

test('群组 Inspector 绝对位置和旋转转换为现有群组事务使用的相对增量', async (context) => {
  const server = await createServer({
    appType: 'custom',
    logLevel: 'silent',
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true },
  });
  context.after(async () => server.close());

  const [spatialModule, rotationModule, babylon] = await Promise.all([
    server.ssrLoadModule('/src/editor/model/groupSpatialInfo.ts'),
    server.ssrLoadModule('/src/runtime/babylon/EntityGroupRotationPreview.ts'),
    import('@babylonjs/core'),
  ]);
  assert.equal(typeof spatialModule.createGroupPositionDelta, 'function');
  assert.equal(typeof rotationModule.createEntityGroupRotationDeltaMatrix, 'function');

  assert.deepEqual(spatialModule.createGroupPositionDelta({ x: 1, y: 2, z: 3 }, 'z', -4), {
    x: 0,
    y: 0,
    z: -7,
  });
  assert.equal(spatialModule.createGroupPositionDelta({ x: 1, y: 2, z: 3 }, 'x', Number.NaN), null);

  const currentRotation = { x: 0.2, y: -0.35, z: 0.1 };
  const targetRotation = { x: -0.15, y: 0.6, z: -0.25 };
  const baselines = {
    first: transform(2, currentRotation),
    second: transform(-2, { x: -0.1, y: 0.15, z: 0.3 }),
  };
  const deltaMatrix = rotationModule.createEntityGroupRotationDeltaMatrix(
    { x: 0, y: 0, z: 0 },
    currentRotation,
    targetRotation,
  );
  assert.ok(deltaMatrix);

  const preview = new rotationModule.EntityGroupRotationPreview(
    ['first', 'second'],
    baselines,
    () => null,
  );
  preview.update(deltaMatrix);
  const after = preview.getTransforms();

  assertQuaternionEquivalent(
    babylon.Quaternion,
    after.first.rotation,
    targetRotation,
    '参考成员应到达 Inspector 目标旋转',
  );
  assertClose(Math.hypot(after.first.position.x, after.first.position.y, after.first.position.z), 2, '第一个成员保持绕中心半径');
  assertClose(Math.hypot(after.second.position.x, after.second.position.y, after.second.position.z), 2, '第二个成员保持绕中心半径');
  assert.deepEqual(after.first.scale, baselines.first.scale);
  assert.deepEqual(after.second.scale, baselines.second.scale);
});
