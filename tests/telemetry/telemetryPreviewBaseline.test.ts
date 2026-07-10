import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { Bone, Mesh, NullEngine, Quaternion, Scene, Skeleton, TransformNode, Vector3 } from '@babylonjs/core';

import {
  captureModelTelemetryPreviewBaseline,
  restoreModelTelemetryPreviewBaseline,
} from '../../src/runtime/babylon/telemetry/telemetryPreviewBaseline';

test('SceneRuntime beginTelemetryPreview 重复调用时直接返回，不触发 end 恢复当前预览', () => {
  const source = readFileSync('src/runtime/babylon/SceneRuntime.ts', 'utf8');
  const beginStart = source.indexOf('beginTelemetryPreview(): void');
  assert.notEqual(beginStart, -1);
  const beginBody = source.slice(beginStart, source.indexOf('endTelemetryPreview(): void', beginStart));
  assert.match(beginBody, /if \(this\.telemetryPreviewActive\) return;/);
  assert.doesNotMatch(beginBody, /this\.endTelemetryPreview\(\)/);
});

test('预览基线恢复节点 Transform、enabled 与骨骼本地矩阵，并保留 Euler/Quaternion 形态', () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const root = new TransformNode('Root', scene);
  const contentRoot = new TransformNode('ContentRoot', scene);
  const eulerNode = new TransformNode('EulerNode', scene);
  const quaternionNode = new TransformNode('QuaternionNode', scene);
  const mesh = new Mesh('SkinnedMesh', scene);
  const skeleton = new Skeleton('Skeleton', 'skeleton-id', scene);
  const bone = new Bone('ArmBone', skeleton);

  contentRoot.parent = root;
  eulerNode.parent = contentRoot;
  quaternionNode.parent = contentRoot;
  mesh.parent = contentRoot;
  mesh.skeleton = skeleton;

  root.position.set(1, 2, 3);
  contentRoot.scaling.set(2, 2, 2);
  eulerNode.rotation.set(0.1, 0.2, 0.3);
  quaternionNode.rotationQuaternion = Quaternion.FromEulerAngles(0.4, 0.5, 0.6);
  quaternionNode.setEnabled(false);
  bone.getLocalMatrix().setTranslationFromFloats(7, 8, 9);

  const baseline = captureModelTelemetryPreviewBaseline({ root, contentRoot });

  root.position.set(10, 20, 30);
  contentRoot.scaling.set(4, 5, 6);
  eulerNode.rotation.set(1, 1, 1);
  quaternionNode.rotationQuaternion = null;
  quaternionNode.rotation.set(2, 2, 2);
  quaternionNode.setEnabled(true);
  bone.getLocalMatrix().setTranslationFromFloats(70, 80, 90);
  let boneDirtyCount = 0;
  const originalMarkAsDirty = bone.markAsDirty.bind(bone);
  bone.markAsDirty = (() => {
    boneDirtyCount += 1;
    return originalMarkAsDirty();
  }) as Bone['markAsDirty'];

  restoreModelTelemetryPreviewBaseline(baseline);

  assert.deepEqual(root.position.asArray(), [1, 2, 3]);
  assert.deepEqual(contentRoot.scaling.asArray(), [2, 2, 2]);
  assert.deepEqual(eulerNode.rotation.asArray(), [0.1, 0.2, 0.3]);
  assert.equal(eulerNode.rotationQuaternion, null);
  const restoredQuaternion = quaternionNode.rotationQuaternion as Quaternion | null;
  assert.ok(restoredQuaternion);
  assert.deepEqual(restoredQuaternion.asArray(), Quaternion.FromEulerAngles(0.4, 0.5, 0.6).asArray());
  assert.equal(quaternionNode.isEnabled(false), false);
  assert.equal(boneDirtyCount > 0, true);
  assert.deepEqual(bone.getLocalMatrix().getTranslation().asArray(), [7, 8, 9]);

  scene.dispose();
  engine.dispose();
});
