import assert from 'node:assert/strict';
import test from 'node:test';
import { AssetContainer, Bone, Matrix, NullEngine, Quaternion, Scene, Skeleton, TransformNode, Vector3 } from '@babylonjs/core';
import { getManualRoamRigProfile, prepareManualRoamReferencePose } from '../../src/runtime/roam/manualRoamAvatarRig.ts';

test('v2参考姿态独立于真实bind矩阵，准备动画不会改写蒙皮绑定', () => {
  const engine = new NullEngine(); const scene = new Scene(engine);
  try {
    const container = new AssetContainer(scene);
    const node = new TransformNode('Hips', scene);
    node.metadata = { gltf: { extras: { manualRoamRig: { profile: 'mixamo-humanoid-v2', version: 2 },
      manualRoamReferencePose: { translation: [0, 0.9, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } } } };
    const skeleton = new Skeleton('posed', 'posed', scene);
    const posed = Matrix.Compose(Vector3.One(), Quaternion.RotationAxis(Vector3.Right(), 0.3), new Vector3(0, 0.86, 0.03));
    const bone = new Bone('Hips', skeleton, null, posed); bone.linkTransformNode(node);
    container.transformNodes.push(node); container.skeletons.push(skeleton);
    const bindBefore = bone.getAbsoluteInverseBindMatrix().clone();
    prepareManualRoamReferencePose(container); skeleton.returnToRest();
    assert.equal(getManualRoamRigProfile(container), 'mixamo-humanoid-v2');
    assert.ok(node.position.equalsWithEpsilon(new Vector3(0, 0.9, 0), 1e-6));
    assert.ok(node.rotationQuaternion!.equalsWithEpsilon(Quaternion.Identity(), 1e-6));
    assert.ok(bone.getAbsoluteInverseBindMatrix().equals(bindBefore), '参考姿态不能覆盖真实inverse bind');
    node.metadata.gltf.extras.manualRoamReferencePose.rotation = [0, 0, 0, 0];
    assert.throws(() => prepareManualRoamReferencePose(container), /参考姿态/);
  } finally { scene.dispose(); engine.dispose(); }
});

test('v2参考姿态直腿站立时真实鞋底贴地且鞋底放平，脚骨记录鞋底朝上方向', async () => {
  const { readFile } = await import('node:fs/promises');
  const { LoadAssetContainerAsync, NullEngine, Quaternion, Scene, Vector3 } = await import('@babylonjs/core');
  await import('@babylonjs/loaders/glTF/index.js');
  const engine = new NullEngine(), scene = new Scene(engine);
  try {
    const container = await LoadAssetContainerAsync(new Uint8Array(await readFile('public/manual-roam/EQ_People_rigged_v2.glb')), scene, { pluginExtension: '.glb', pluginOptions: { gltf: { skipMaterials: true, animationStartMode: 0 } } });
    container.addAllToScene(); prepareManualRoamReferencePose(container); container.skeletons.forEach(s => s.returnToRest());
    for (const side of ['Left', 'Right']) {
      const foot = container.transformNodes.find(n => n.name === side + 'Foot')!;
      const up = foot.metadata?.gltf?.extras?.manualRoamSoleUp as number[];
      assert.ok(Array.isArray(up) && up.length === 3 && Math.abs(Math.hypot(...up) - 1) < 1e-4, `${side}Foot 缺少鞋底朝上方向`);
      foot.rotationQuaternion = Quaternion.RotationAxis(Vector3.Right(), Math.atan2(-up[2], up[1])); // 动作叠加的放平补偿
    }
    container.transformNodes.forEach(n => n.computeWorldMatrix(true)); container.skeletons.forEach(s => s.prepare(true));
    let floor = Infinity;
    for (const mesh of container.meshes) {
      const positions = mesh.getPositionData(true); if (!positions) continue;
      const world = mesh.computeWorldMatrix(true);
      for (const i of new Set(mesh.getIndices() ?? [])) floor = Math.min(floor, Vector3.TransformCoordinates(Vector3.FromArray(positions, i * 3), world).y);
    }
    // 留有不到1厘米的可达余量；之前为-2.3厘米（陷入地面），会迫使足部IK弯膝抬脚。
    assert.ok(floor > -0.012 && floor < 0.002, `鞋底最低点 ${floor}`);
  } finally { scene.dispose(); engine.dispose(); }
});
