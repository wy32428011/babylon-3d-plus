import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { AssetContainer, Bone, LoadAssetContainerAsync, Matrix, Mesh, MorphTarget, MorphTargetManager, NullEngine, Quaternion, Scene, Skeleton, TransformNode, Vector3, VertexBuffer } from '@babylonjs/core';
import '@babylonjs/loaders/glTF/index.js';
import { ManualRoamAvatarAnimator } from '../../src/runtime/roam/ManualRoamAvatarAnimator.ts';
import { ManualRoamFootIK } from '../../src/runtime/roam/ManualRoamFootIK.ts';
import { measureManualRoamSole } from '../../src/runtime/roam/manualRoamSoleGeometry.ts';

function fixture({ extraInfluences = false, toes = true, large = false, footCopies = 1 } = {}) {
  const engine = new NullEngine(), scene = new Scene(engine), container = new AssetContainer(scene);
  const root = new TransformNode('unusual-armature-root', scene), joints = new Map<string, TransformNode>();
  const skeleton = new Skeleton('generic-skin', 'generic-skin', scene), bones = new Map<TransformNode, Bone>();
  const add = (canonical: string, parent: TransformNode, point: Vector3, rotation = Quaternion.Identity()) => {
    const node = new TransformNode('vendor:' + canonical.toLowerCase(), scene);
    node.parent = parent; node.position.copyFrom(point); node.rotationQuaternion = rotation;
    const bone = new Bone(node.name, skeleton, bones.get(parent), Matrix.Compose(node.scaling, rotation, point));
    bone.linkTransformNode(node); bones.set(node, bone); joints.set(canonical, node); container.transformNodes.push(node);
    return node;
  };
  const hips = add('Hips', root, new Vector3(0, 1, 0));
  for (const [side, x] of [['Left', -.15], ['Right', .15]] as const) {
    const thigh = add(side + 'UpLeg', hips, new Vector3(x, 0, 0));
    const helper = add(side + 'ThighHelper', thigh, Vector3.Zero());
    const knee = add(side + 'Leg', helper, new Vector3(0, -.4, .08));
    const foot = add(side + 'Foot', knee, new Vector3(0, -.4, -.08), Quaternion.RotationAxis(Vector3.Right(), Math.PI / 2));
    if (toes) add(side + 'ToeBase', foot, new Vector3(0, .2, 0));
  }
  const mesh = new Mesh('whole-character-body-and-shoes', scene), positions: number[] = [], ids: number[] = [], weights: number[] = [], extraIds: number[] = [], extraWeights: number[] = [];
  mesh.parent = root; mesh.skeleton = skeleton; mesh.numBoneInfluencers = extraInfluences ? 8 : 4;
  const leftIndices: number[] = [];
  const addVertex = (point: number[], joint: number, extraJoint = joint) => {
    const index = positions.length / 3; positions.push(...point);
    ids.push(joint, 0, 0, 0); weights.push(extraInfluences ? .4 : 1, 0, 0, 0);
    extraIds.push(extraJoint, 0, 0, 0); extraWeights.push(extraInfluences ? .6 : 0, 0, 0, 0);
    return index;
  };
  for (const [side, x] of [['Left', -.15], ['Right', .15]] as const) {
    const footIndex = skeleton.bones.indexOf(bones.get(joints.get(side + 'Foot')!)!);
    const toeIndex = toes ? skeleton.bones.indexOf(bones.get(joints.get(side + 'ToeBase')!)!) : footIndex;
    for (let copy = 0; copy < footCopies; copy++) for (const [dx, z] of [[-.05, -.08], [.05, -.08], [-.05, .22], [.05, .22], [0, .12], [0, .03]]) {
      const i = addVertex([x + dx, .08, z], footIndex, toeIndex);
      if (side === 'Left') leftIndices.push(i);
    }
  }
  // 单网格绝大多数顶点属于躯干；不能用整网格平均足部权重识别鞋子。
  for (let i = 0; i < (large ? 50_010 : 90); i++) addVertex([0, 1.3 + (i % 3) * .1, 0], 0);
  mesh.setVerticesData(VertexBuffer.PositionKind, positions);
  mesh.setVerticesData(VertexBuffer.MatricesIndicesKind, ids, false, 4);
  mesh.setVerticesData(VertexBuffer.MatricesWeightsKind, weights, false, 4);
  if (extraInfluences) {
    mesh.setVerticesData(VertexBuffer.MatricesIndicesExtraKind, extraIds, false, 4);
    mesh.setVerticesData(VertexBuffer.MatricesWeightsExtraKind, extraWeights, false, 4);
  }
  mesh.setIndices(Array.from({ length: positions.length / 3 }, (_, i) => i));
  container.meshes.push(mesh); container.skeletons.push(skeleton); skeleton.prepare(true);
  const worldSole = () => {
    skeleton.prepare(true); const values = mesh.getPositionData(true)!;
    return leftIndices.map(i => Vector3.TransformCoordinates(Vector3.FromArray(values, i * 3), mesh.computeWorldMatrix(true)));
  };
  return { container, joints, root, mesh, worldSole, dispose: () => { scene.dispose(); engine.dispose(); } };
}

test('自动足底从超过5万顶点的整个人物网格提取映射足部，不依赖名称或鞋材质', () => {
  const f = fixture({ large: true }), foot = f.joints.get('LeftFoot')!;
  try {
    const sole = measureManualRoamSole(f.container, foot, 'Left', .065, { joints: f.joints, automatic: true });
    const points = sole.sample().map(p => Vector3.TransformCoordinates(p, foot.computeWorldMatrix(true)));
    assert.equal(points.length, 6);
    assert.ok(points.every(p => Math.abs(p.y - .08) < 1e-6));
    assert.ok(points.every(p => p.x < 0));
    assert.equal(f.mesh.getTotalVertices(), 50_022, '适配不能裁剪原网格');
  } finally { f.dispose(); }
});

test('自动足底保留第5至8项权重，采样随趾骨变形且匹配完整CPU蒙皮', () => {
  const f = fixture({ extraInfluences: true }), foot = f.joints.get('LeftFoot')!;
  try {
    const sole = measureManualRoamSole(f.container, foot, 'Left', .065, { joints: f.joints, automatic: true });
    const before = sole.sample().map(p => Vector3.TransformCoordinates(p, foot.computeWorldMatrix(true)));
    f.joints.get('LeftToeBase')!.rotationQuaternion = Quaternion.RotationAxis(Vector3.Right(), .4);
    const actual = sole.sample().map(p => Vector3.TransformCoordinates(p, foot.computeWorldMatrix(true))), expected = f.worldSole();
    assert.equal(actual.length, expected.length);
    assert.ok(actual.some((point, i) => Vector3.Distance(point, before[i]) > .01), '必须真的响应额外权重');
    actual.forEach((point, i) => assert.ok(Vector3.Distance(point, expected[i]) < 1e-6));
  } finally { f.dispose(); }
});

test('映射腿允许辅助祖先骨与不同脚骨轴，缺趾骨仍可使用站姿前向贴地', () => {
  for (const toes of [true, false]) for (const [scale,yaw,mirror] of [[1,0,false],[1.3,.6,false],[.8,-.4,true]] as const) {
    const f = fixture({ toes }), before = f.root.position.clone();
    f.root.scaling.set(scale*(mirror?-1:1),scale,scale);
    f.root.rotationQuaternion = Quaternion.RotationAxis(Vector3.Up(),yaw);
    try {
      const ik = new ManualRoamFootIK(f.container, { joints: f.joints, automatic: true, probeGround: () => ({ height: .09*scale, normal: Vector3.Up() }) });
      ik.update({ dt: 1 / 60, grounded: true, fly: false, footContacts: { left: 1, right: 1 } });
      assert.equal(ik.getDebugState().left.reason, 'solved');
      assert.ok(ik.getDebugState().left.normalAlignment > .999);
      assert.ok(Math.abs(Math.min(...f.worldSole().map(p => p.y)) - .09*scale) < .002);
      assert.ok(f.root.position.equals(before), '只纠正视觉骨骼'); ik.dispose();
    } finally { f.dispose(); }
  }
});

test('自动足底超过精确采样边界时明确降级，保留原网格和全部权重', () => {
  const f = fixture({ footCopies: 2731 }), foot = f.joints.get('LeftFoot')!;
  const count = f.mesh.getTotalVertices(), weights = Array.from(f.mesh.getVerticesData(VertexBuffer.MatricesWeightsKind)!);
  try {
    assert.throws(() => measureManualRoamSole(f.container, foot, 'Left', .065, { automatic: true }), /采样超过.*基础动作/);
    assert.equal(f.mesh.getTotalVertices(), count);
    assert.deepEqual(Array.from(f.mesh.getVerticesData(VertexBuffer.MatricesWeightsKind)!),weights);
  } finally { f.dispose(); }
});

test('全身单网格可保留面部形态，但足底形态改变时明确降级', () => {
  const f = fixture(), foot = f.joints.get('LeftFoot')!;
  try {
    const morph = new MorphTarget('expression', 1, f.mesh.getScene()), manager = new MorphTargetManager(f.mesh.getScene());
    const positions = Array.from(f.mesh.getVerticesData(VertexBuffer.PositionKind)!);
    positions[positions.length - 2] += .1; morph.setPositions(positions); manager.addTarget(morph); f.mesh.morphTargetManager = manager;
    assert.equal(measureManualRoamSole(f.container, foot, 'Left', .065, { automatic: true }).sample().length,6);
    positions[1] += .02; morph.setPositions(positions);
    assert.throws(() => measureManualRoamSole(f.container, foot, 'Left', .065, { automatic: true }), /足底带有形态变形/);
  } finally { f.dispose(); }
});

test('自动足底缺少有效蒙皮时明确拒绝精确贴地，不能伪造默认鞋底成功', () => {
  const f = fixture(), foot = f.joints.get('LeftFoot')!;
  try {
    f.mesh.setVerticesData(VertexBuffer.MatricesIndicesKind, new Float32Array(f.mesh.getTotalVertices() * 4), false, 4);
    assert.throws(() => measureManualRoamSole(f.container, foot, 'Left', .065, { joints: f.joints, automatic: true }), /足底|蒙皮/);
  } finally { f.dispose(); }
});

test('普通人物低接触摆动脚跨15厘米台边时检查真实前掌轮廓，不能因后跟在低地面而跳过安全抬升', () => {
  const f=fixture(),heightAt=(z:number)=>z>.1?.15:0;
  try {
    assert.ok(Math.min(...f.worldSole().map(point=>point.y-heightAt(point.z)))<-.06,'必须重现前掌越过台边而后跟仍在低处');
    const root=f.root.position.clone(),ik=new ManualRoamFootIK(f.container,{joints:f.joints,automatic:true,probeGround:(_x,z)=>({height:heightAt(z),normal:Vector3.Up()})});
    ik.update({dt:1/60,grounded:true,fly:false,speed:1.6,footContacts:{left:0,right:0}});
    const clearances=f.worldSole().map(point=>point.y-heightAt(point.z));
    assert.ok(Math.min(...clearances)>-.002,`跨台边摆动脚真实蒙皮穿地：${-Math.min(...clearances)}m`);
    assert.equal(ik.getDebugState().left.locked,false,'摆动脚不能锁到提前探测的台面');
    assert.ok(f.root.position.equals(root),'安全视觉抬脚不能移动碰撞体或人物根');
    ik.dispose();
  } finally { f.dispose(); }
});

test('动画参考姿态转动脚骨后沿用校准前站姿的脚部朝上，静止贴地不保留错误鞋底倾斜', () => {
  const f = fixture();
  try {
    const footReferenceUp = new Map(['Left','Right'].map(side => [side+'Foot',Vector3.TransformNormal(Vector3.Up(),Matrix.Invert(f.joints.get(side+'Foot')!.computeWorldMatrix(true))).normalize()]));
    for (const side of ['Left','Right']) {
      const foot = f.joints.get(side+'Foot')!;
      foot.rotationQuaternion = Quaternion.RotationAxis(Vector3.Right(),.3).multiply(foot.rotationQuaternion!);
    }
    const before = f.worldSole().map(p=>p.y);
    assert.ok(Math.max(...before)-Math.min(...before)>.04,'必须先产生真实鞋底倾斜');
    const ik = new ManualRoamFootIK(f.container,{joints:f.joints,automatic:true,footReferenceUp,probeGround:()=>({height:.09,normal:Vector3.Up()})});
    ik.update({dt:1/60,grounded:true,fly:false,footContacts:{left:1,right:1}});
    const after=f.worldSole().map(p=>p.y);
    assert.equal(ik.getDebugState().left.reason,'solved');
    assert.ok(Math.max(...after)-Math.min(...after)<.002,'真实鞋底须被压平，不只是错误参考向量与法线对齐');
    assert.ok(Math.abs(Math.min(...after)-.09)<.002);
    ik.dispose();
  } finally { f.dispose(); }
});

test('真实Xbot原几何bind轴不同于站姿节点轴时，自动IK保持后跟前掌同时落地及人体前屈膝', async t => {
  const engine=new NullEngine(),scene=new Scene(engine);
  const load=async(path:string)=>LoadAssetContainerAsync(new Uint8Array(await readFile(path)),scene,{pluginExtension:'.glb',pluginOptions:{gltf:{skipMaterials:true,animationStartMode:0}}});
  t.mock.method(globalThis,'fetch',async()=>new Response(await readFile('public/manual-roam/locomotion-v2.manifest.json','utf8')));
  try {
    const avatar=await load('scripts/manual-roam-assets/sources/Xbot.glb');avatar.addAllToScene();
    const root=new TransformNode('avatar-root',scene);avatar.rootNodes.forEach(node=>node.parent=root);
    const foot=avatar.transformNodes.find(node=>node.name.endsWith('LeftFoot'))!;
    const footReferenceUp=new Map(['Left','Right'].map(side=>{
      const node=avatar.transformNodes.find(node=>node.name.endsWith(side+'Foot'))!;
      return [side+'Foot',Vector3.TransformNormal(Vector3.Up(),Matrix.Invert(node.computeWorldMatrix(true))).normalize()] as const;
    }));
    const sole=measureManualRoamSole(avatar,foot,'Left',.065,{automatic:true});
    const originalPoints=sole.sample().map(point=>Vector3.TransformCoordinates(point,foot.computeWorldMatrix(true)));
    const minimum=Math.min(...originalPoints.map(point=>point.y));
    const contactIndices=originalPoints.flatMap((point,index)=>point.y<minimum+.003?[index]:[]);
    assert.ok(contactIndices.length>3,'原模型必须有可测的平底接触区域');
    const animator=await ManualRoamAvatarAnimator.create(scene,avatar,{sourceUrl:'feet://motion',manifestUrl:'feet://manifest',loadContainer:()=>load('public/manual-roam/locomotion-v2.glb')});
    const binding=animator.getRigBinding();root.rotation.y=binding.facingYaw;
    const ik=new ManualRoamFootIK(avatar,{joints:binding.joints,automatic:true,footReferenceUp,probeGround:()=>({height:0,normal:Vector3.Up()})});
    root.scaling.setAll(.9/binding.legLength);animator.sampleIdle();
    ik.update({dt:1/60,grounded:true,fly:false,footContacts:{left:1,right:1}});
    const finalPoints=sole.sample().map(point=>Vector3.TransformCoordinates(point,foot.computeWorldMatrix(true)));
    const contactHeights=contactIndices.map(index=>finalPoints[index].y);
    assert.ok(Math.max(...contactHeights)-Math.min(...contactHeights)<.006,`真实脚底不应踮起：${Math.max(...contactHeights)-Math.min(...contactHeights)}m`);
    assert.ok(Math.abs(Math.min(...finalPoints.map(point=>point.y)))<.003,'真实脚底应贴住地面');
    const hip=binding.joints.get('LeftUpLeg')!.getAbsolutePosition(),knee=binding.joints.get('LeftLeg')!.getAbsolutePosition(),ankle=foot.getAbsolutePosition();
    const axis=ankle.subtract(hip).normalize(),pole=knee.subtract(hip),forward=Vector3.Forward();
    assert.ok(Vector3.Dot(pole.subtract(axis.scale(Vector3.Dot(pole,axis))),forward)>=-.002,'膝盖不能向人体后方弯');
    let lowest=Infinity,kneeMinimum=Infinity,worstFrame:unknown;
    for(const [stage,speed,ticks] of [['Walk',1.6,90],['Run',3.2,90],['Stop',0,60]] as const)for(let tick=0;tick<ticks;tick++){
      root.position.z+=speed/60;
      animator.update({deltaSeconds:1/60,velocityX:0,velocityZ:speed,yaw:0,verticalVelocity:0,grounded:true,jumped:false,fly:false,sprint:stage==='Run',walkSpeed:1.6,worldScale:root.scaling.y});
      scene.animate();
      ik.update({dt:1/60,grounded:true,fly:false,speed,strideScale:animator.getStrideScale(),footContacts:animator.getFootContacts()});
      const points=sole.sample().map(point=>Vector3.TransformCoordinates(point,foot.computeWorldMatrix(true))),minimum=Math.min(...points.map(point=>point.y));
      if(minimum<lowest){lowest=minimum;worstFrame={stage,tick,minimum,phase:animator.getStatus().phase,ik:ik.getDebugState().left};}
      const hip=binding.joints.get('LeftUpLeg')!.getAbsolutePosition(),knee=binding.joints.get('LeftLeg')!.getAbsolutePosition(),ankle=foot.getAbsolutePosition();
      const axis=ankle.subtract(hip).normalize(),pole=knee.subtract(hip);
      kneeMinimum=Math.min(kneeMinimum,Vector3.Dot(pole.subtract(axis.scale(Vector3.Dot(pole,axis))),forward));
    }
    assert.ok(lowest>-.02,`走跑停止全程真实足底穿地：${JSON.stringify(worstFrame)}`);
    assert.ok(kneeMinimum>-.02,`走跑停止全程膝盖反折：${kneeMinimum}m`);
    ik.dispose();animator.dispose();avatar.dispose();
  } finally {scene.dispose();engine.dispose();}
});
