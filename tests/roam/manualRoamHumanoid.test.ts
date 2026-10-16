import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { LoadAssetContainerAsync, NullEngine, Scene, Quaternion, Vector3, VertexBuffer, Matrix, TransformNode, Bone, Skeleton } from '@babylonjs/core';
import { analyzeManualRoamHumanoid } from '../../electron/shared/manualRoamHumanoid.ts';
import { ManualRoamAvatarAnimator } from '../../src/runtime/roam/ManualRoamAvatarAnimator.ts';
import { identifyRuntimeHumanoid, prepareHumanoidReference, retargetHumanoidGroup } from '../../src/runtime/roam/manualRoamHumanoid.ts';
import { validateManualRoamRigNodes } from '../../src/runtime/roam/manualRoamAvatarRig.ts';
import '@babylonjs/loaders/glTF/index.js';

async function jsonFile(path: string) { const file = await readFile(path); return JSON.parse(file.toString('utf8',20,20+file.readUInt32LE(12))); }
const ordinary = 'scripts/manual-roam-assets/sources/Xbot.glb';
const loadInScene=async(scene:Scene,path=ordinary)=>LoadAssetContainerAsync(new Uint8Array(await readFile(path)),scene,{pluginExtension:'.glb',pluginOptions:{gltf:{animationStartMode:0,skipMaterials:true}}});

test('普通Mixamo人物无需专用metadata即可识别全部语义关节且不改变源JSON', async () => {
  const json = await jsonFile(ordinary), before = JSON.stringify(json);
  const result = analyzeManualRoamHumanoid(json);
  assert.equal(result.metadata.version,1);
  assert.equal(Object.keys(result.metadata.joints).length,22);
  assert.match(json.nodes[result.metadata.joints.Hips].name,/Hips/);
  assert.equal(JSON.stringify(json),before);
});

test('导入结构校验拒绝无skin、多skin、非法joint索引、父级冲突和骨架循环',async()=>{
  const source=await jsonFile(ordinary),known=analyzeManualRoamHumanoid(source).metadata.joints;
  assert.throws(()=>analyzeManualRoamHumanoid(null),/结构/);
  assert.throws(()=>analyzeManualRoamHumanoid({}),/节点/);
  const noSkin=structuredClone(source);for(const node of noSkin.nodes)delete node.skin;
  assert.throws(()=>analyzeManualRoamHumanoid(noSkin),/骨架/);
  const multiple=structuredClone(source);multiple.skins.push(structuredClone(multiple.skins[0]));multiple.nodes.filter((node:{mesh?:number})=>node.mesh!==undefined)[0].skin=1;
  assert.throws(()=>analyzeManualRoamHumanoid(multiple),/同一/);
  const wrongIndex=structuredClone(source);wrongIndex.skins[0].joints[0]=wrongIndex.nodes.length;
  assert.throws(()=>analyzeManualRoamHumanoid(wrongIndex),/关节/);
  const duplicateParent=structuredClone(source);duplicateParent.nodes[known.Hips].children.push(known.LeftHand);
  assert.throws(()=>analyzeManualRoamHumanoid(duplicateParent),/父级/);
  const wrongParent=structuredClone(source);wrongParent.nodes[known.LeftForeArm].children=wrongParent.nodes[known.LeftForeArm].children.filter((index:number)=>index!==known.LeftHand);wrongParent.nodes[known.Hips].children.push(known.LeftHand);
  assert.throws(()=>analyzeManualRoamHumanoid(wrongParent),/LeftHand/);
  const cycle=structuredClone(source),root=analyzeManualRoamHumanoid(cycle).rootNodeIndex;
  cycle.nodes[root].children.push(root);
  assert.throws(()=>analyzeManualRoamHumanoid(cycle),/循环/);
});

test('运行时拒绝未蒙皮与多骨架人物、缺失语义及非法参考变换',async()=>{
  const engine=new NullEngine(),scene=new Scene(engine);
  try{
    const avatar=await loadInScene(scene),binding=identifyRuntimeHumanoid(avatar),mesh=avatar.meshes.find(mesh=>mesh.skeleton&&mesh.getTotalVertices()>0)!,skeleton=mesh.skeleton!;
    for(const side of ['Left','Right']){
      const foot=binding.joints.get(side+'Foot')!;foot.computeWorldMatrix(true);
      const expected=Vector3.TransformNormal(Vector3.Up(),Matrix.Invert(foot.getWorldMatrix())).normalize();
      assert.ok(Vector3.Distance(binding.footReferenceUp!.get(side+'Foot')!,expected)<1e-6,'脚底参考上方须来自校准前实际节点姿态');
    }
    mesh.skeleton=null;assert.throws(()=>identifyRuntimeHumanoid(avatar),/骨架/);mesh.skeleton=skeleton;
    const another=new Skeleton('another','another',scene);mesh.skeleton=another;assert.throws(()=>identifyRuntimeHumanoid(avatar),/同一/);mesh.skeleton=skeleton;another.dispose();
    const hand=binding.joints.get('LeftHand')!,name=hand.name;hand.name='unrecognized';assert.throws(()=>identifyRuntimeHumanoid(avatar),/LeftHand/);hand.name=name;
    const bone=skeleton.bones.find(bone=>bone.getTransformNode()===hand)!,rest=bone.getRestMatrix().clone();
    hand.scaling.set(1,2,1);assert.throws(()=>identifyRuntimeHumanoid(avatar),/缩放/);hand.scaling.setAll(1);
    const rotation=hand.rotationQuaternion!.clone();hand.rotationQuaternion!.set(Number.NaN,0,0,1);assert.throws(()=>identifyRuntimeHumanoid(avatar),/变换/);hand.rotationQuaternion=rotation;
    bone.setRestMatrix(Matrix.Zero());assert.throws(()=>identifyRuntimeHumanoid(avatar),/绑定矩阵/);bone.setRestMatrix(rest);
    const head=binding.joints.get('Head')!,headPosition=head.position.clone();head.position.y-=1000;assert.throws(()=>identifyRuntimeHumanoid(avatar),/参考姿态/);head.position.copyFrom(headPosition);
    const parent=hand.parent;hand.parent=binding.joints.get('Hips')!;assert.throws(()=>identifyRuntimeHumanoid(avatar),/父级/);hand.parent=parent;
    assert.equal(identifyRuntimeHumanoid(avatar).joints.size,22);
    avatar.dispose();
  }finally{scene.dispose();engine.dispose();}
});

test('非法蒙皮权重不会被裁剪或归一化掩盖，损坏缓存版本明确拒绝',async()=>{
  const engine=new NullEngine(),scene=new Scene(engine);
  try{
    const avatar=await loadInScene(scene),mesh=avatar.meshes.find(mesh=>mesh.skeleton&&mesh.getTotalVertices()>0)!;
    const weights=mesh.getVerticesData(VertexBuffer.MatricesWeightsKind)!.slice(),indices=mesh.getVerticesData(VertexBuffer.MatricesIndicesKind)!.slice();
    for(const bad of [-.2,Number.NaN,0]){
      const changed=weights.slice();changed[0]=bad;mesh.setVerticesData(VertexBuffer.MatricesWeightsKind,changed);
      assert.throws(()=>identifyRuntimeHumanoid(avatar),/权重/);assert.deepEqual(mesh.getVerticesData(VertexBuffer.MatricesWeightsKind),changed);
    }
    mesh.setVerticesData(VertexBuffer.MatricesWeightsKind,weights);
    const changed=indices.slice();changed[0]=mesh.skeleton!.bones.length;mesh.setVerticesData(VertexBuffer.MatricesIndicesKind,changed);assert.throws(()=>identifyRuntimeHumanoid(avatar),/索引/);mesh.setVerticesData(VertexBuffer.MatricesIndicesKind,indices);
    mesh.numBoneInfluencers=9;assert.throws(()=>identifyRuntimeHumanoid(avatar),/8个/);mesh.numBoneInfluencers=4;
    const metadata=analyzeManualRoamHumanoid(await jsonFile(ordinary)).metadata,root=avatar.rootNodes[0];
    root.metadata={manualRoamHumanoid:{...metadata,version:2}};assert.throws(()=>identifyRuntimeHumanoid(avatar),/版本/);
    root.metadata={manualRoamHumanoid:metadata};avatar.transformNodes[0].metadata={manualRoamHumanoid:metadata};assert.throws(()=>identifyRuntimeHumanoid(avatar),/重复/);avatar.transformNodes[0].metadata=null;
    assert.equal(identifyRuntimeHumanoid(avatar).metadataSource,'embedded');
    avatar.dispose();
  }finally{scene.dispose();engine.dispose();}
});

test('重定向前置校验与采样中途失败均释放新动作组，不留下半成品',async t=>{
  const engine=new NullEngine(),scene=new Scene(engine);
  try{
    const avatar=await loadInScene(scene),source=await loadInScene(scene,'public/manual-roam/locomotion-v2.glb'),nodes=validateManualRoamRigNodes(source);
    const binding=prepareHumanoidReference(avatar,identifyRuntimeHumanoid(avatar),nodes),original=source.animationGroups[0];
    const broken=original.clone('missing-hips')!;broken.targetedAnimations.splice(broken.targetedAnimations.findIndex(track=>track.animation.targetProperty==='position'),1);
    assert.throws(()=>retargetHumanoidGroup(broken,nodes,binding,'manual-roam-rejected'),/完整绑定/);
    assert.equal(scene.animationGroups.some(group=>group.name==='manual-roam-rejected'),false,'前置校验拒绝不能泄漏动作组');broken.dispose();
    const failing=original.targetedAnimations.find(track=>track.animation.targetProperty==='rotationQuaternion')!.animation;
    t.mock.method(failing,'evaluate',()=>{throw new Error('采样失败');});
    assert.throws(()=>retargetHumanoidGroup(original,nodes,binding,'manual-roam-failed'),/采样失败/);
    assert.equal(scene.animationGroups.some(group=>group.name==='manual-roam-failed'),false);
    avatar.dispose();source.dispose();
  }finally{scene.dispose();engine.dispose();}
});

test('自动人物动作生成失败恢复原始参考姿态并释放源资源，允许随后重试',async t=>{
  const engine=new NullEngine(),scene=new Scene(engine);
  t.mock.method(globalThis,'fetch',async()=>new Response(await readFile('public/manual-roam/locomotion-v2.manifest.json','utf8')));
  try{
    const avatar=await loadInScene(scene),rest=avatar.skeletons[0].bones.map(bone=>bone.getRestMatrix().clone()),rotations=avatar.transformNodes.map(node=>node.rotationQuaternion?.clone());
    const source=await loadInScene(scene,'public/manual-roam/locomotion-v2.glb');
    t.mock.method(source.animationGroups[0].targetedAnimations.find(track=>track.animation.targetProperty==='rotationQuaternion')!.animation,'evaluate',()=>new Quaternion(Number.NaN,0,0,1));
    await assert.rejects(ManualRoamAvatarAnimator.create(scene,avatar,{sourceUrl:'bad-evaluation://motion',manifestUrl:'bad-evaluation://manifest',loadContainer:async()=>source}),/无效旋转/);
    avatar.skeletons[0].bones.forEach((bone,index)=>assert.ok(bone.getRestMatrix().equals(rest[index])));
    avatar.transformNodes.forEach((node,index)=>assert.deepEqual(node.rotationQuaternion?.asArray(),rotations[index]?.asArray()));
    assert.equal(source.rootNodes[0].isDisposed(),true);assert.equal(scene.animationGroups.some(group=>group.name.startsWith('manual-roam-')),false);
    const retry=await ManualRoamAvatarAnimator.create(scene,avatar,{sourceUrl:'bad-evaluation://motion',manifestUrl:'bad-evaluation://manifest',loadContainer:()=>loadInScene(scene,'public/manual-roam/locomotion-v2.glb')});
    assert.equal(retry.getRigBinding().automatic,true);retry.dispose();avatar.dispose();
  }finally{scene.dispose();engine.dispose();}
});

test('普通Xbot不创建IK时Idle脚掌与脚趾保持原平脚，行走仍保留蹬地滚动',async t=>{
  const engine=new NullEngine(),scene=new Scene(engine);
  t.mock.method(globalThis,'fetch',async()=>new Response(await readFile('public/manual-roam/locomotion-v2.manifest.json','utf8')));
  try{
    const avatar=await loadInScene(scene),original=identifyRuntimeHumanoid(avatar);
    const referenceUp=new Map(['LeftFoot','RightFoot','LeftToeBase','RightToeBase'].map(name=>[name,Vector3.TransformNormal(Vector3.Up(),Matrix.Invert(original.joints.get(name)!.computeWorldMatrix(true))).normalize()]));
    const motion=await loadInScene(scene,'public/manual-roam/locomotion-v2.glb');
    const animator=await ManualRoamAvatarAnimator.create(scene,avatar,{sourceUrl:'natural-feet://motion',manifestUrl:'natural-feet://manifest',loadContainer:async()=>motion});
    const binding=animator.getRigBinding();animator.sampleIdle();
    for(const [name,up] of referenceUp){
      const actual=Vector3.TransformNormal(up,binding.joints.get(name)!.computeWorldMatrix(true)).normalize();
      assert.ok(actual.y>.999,`${name}无IK站立必须保留平脚，当前倾角${Math.acos(Math.min(1,actual.y))*180/Math.PI}度`);
    }
    const walk=scene.animationGroups.find(group=>group.name.startsWith('manual-roam-')&&group.name.endsWith('WalkForward'))!;
    const sourceWalk=motion.animationGroups.find(group=>group.name==='WalkForward')!,sourceFoot=motion.transformNodes.find(node=>node.name==='LeftFoot')!;
    animator.pause();walk.start(true,0);sourceWalk.start(true,0);const upSamples:Vector3[]=[],sourceRotations:Quaternion[]=[],targetRotations:Quaternion[]=[];
    for(const progress of [0,.25,.5,.75]){
      walk.goToFrame(walk.from+(walk.to-walk.from)*progress);sourceWalk.goToFrame(sourceWalk.from+(sourceWalk.to-sourceWalk.from)*progress);
      const targetWorld=binding.joints.get('LeftFoot')!.computeWorldMatrix(true);upSamples.push(Vector3.TransformNormal(referenceUp.get('LeftFoot')!,targetWorld).normalize());
      const sourceRotation=Quaternion.Identity(),targetRotation=Quaternion.Identity();sourceFoot.computeWorldMatrix(true).decompose(undefined,sourceRotation);targetWorld.decompose(undefined,targetRotation);
      sourceRotations.push(sourceRotation);targetRotations.push(targetRotation);
    }
    assert.ok(upSamples.some(up=>Vector3.Dot(up,upSamples[0])<.98),'脚掌不能被锁死，行走应保留源动作蹬地滚动');
    for(let index=1;index<sourceRotations.length;index++)assert.ok(Math.abs(Math.abs(Quaternion.Dot(sourceRotations[0],sourceRotations[index]))-Math.abs(Quaternion.Dot(targetRotations[0],targetRotations[index])))<1e-5,'只移除静态鞋型偏角，不能改变相邻动作姿态之间的旋转量');
    animator.dispose();avatar.dispose();
  }finally{scene.dispose();engine.dispose();}
});

test('普通人物保留8影响权重，拒绝不完整扩展权重和过期索引metadata', async () => {
  const engine=new NullEngine(),scene=new Scene(engine);
  try {
    const avatar=await LoadAssetContainerAsync(new Uint8Array(await readFile(ordinary)),scene,{pluginExtension:'.glb',pluginOptions:{gltf:{animationStartMode:0,skipMaterials:true}}});
    const mesh=avatar.meshes.find(node=>node.skeleton&&node.getTotalVertices()>0)!;
    const weights=mesh.getVerticesData(VertexBuffer.MatricesWeightsKind)!,indices=mesh.getVerticesData(VertexBuffer.MatricesIndicesKind)!;
    mesh.setVerticesData(VertexBuffer.MatricesWeightsKind,Array.from(weights,value=>value*.75));
    mesh.setVerticesData(VertexBuffer.MatricesWeightsExtraKind,Array.from(weights,value=>value*.25));
    mesh.setVerticesData(VertexBuffer.MatricesIndicesExtraKind,Array.from(indices));mesh.numBoneInfluencers=8;
    const before=mesh.getVerticesData(VertexBuffer.MatricesWeightsExtraKind)!.slice();
    assert.equal(identifyRuntimeHumanoid(avatar).joints.size,22);
    assert.deepEqual(mesh.getVerticesData(VertexBuffer.MatricesWeightsExtraKind),before);
    const metadata=analyzeManualRoamHumanoid(await jsonFile(ordinary)).metadata;
    const root=avatar.rootNodes[0];root.metadata={gltf:{extras:{manualRoamHumanoid:metadata}}};
    assert.equal(identifyRuntimeHumanoid(avatar).metadataSource,'embedded');
    metadata.joints.LeftHand=metadata.joints.RightHand;
    assert.throws(()=>identifyRuntimeHumanoid(avatar),/缓存|metadata|映射/);
    root.metadata=null;
    mesh.setVerticesData(VertexBuffer.MatricesWeightsExtraKind,[1]);
    assert.throws(()=>identifyRuntimeHumanoid(avatar),/权重/);
    avatar.dispose();
  }finally{scene.dispose();engine.dispose();}
});

test('同骨架UE名称和额外中间骨可识别，缺关节与歧义明确拒绝', async () => {
  const json = await jsonFile(ordinary);
  const result = analyzeManualRoamHumanoid(json), joints = result.metadata.joints;
  const names: Record<string,string> = {Hips:'pelvis',Spine:'spine_01',Spine1:'spine_02',Spine2:'spine_03',Neck:'neck_01',Head:'head'};
  for(const side of ['Left','Right']) for(const [part,alias] of Object.entries({Shoulder:'clavicle',Arm:'upperarm',ForeArm:'lowerarm',Hand:'hand',UpLeg:'thigh',Leg:'calf',Foot:'foot',ToeBase:'ball'})) names[side+part]=alias+'_'+(side==='Left'?'l':'r');
  for(const [semantic,index] of Object.entries(joints))json.nodes[index].name=names[semantic];
  assert.equal(Object.keys(analyzeManualRoamHumanoid(json).metadata.joints).length,22);
  const missing = structuredClone(json);missing.nodes[joints.LeftHand].name='unknown';
  assert.throws(()=>analyzeManualRoamHumanoid(missing),/LeftHand/);
  const ambiguous=structuredClone(json),duplicate=ambiguous.nodes.length;
  ambiguous.nodes.push({...ambiguous.nodes[joints.LeftHand],children:[],name:'hand_l'});
  ambiguous.skins[0].joints.push(duplicate);
  assert.throws(()=>analyzeManualRoamHumanoid(ambiguous),/歧义|重名/);
});

test('自动重定向真实普通人物覆盖全部动作轨道，保留名称权重bind并改变真实骨骼', async t => {
  const engine=new NullEngine(),scene=new Scene(engine);
  const load=async(path:string)=>LoadAssetContainerAsync(new Uint8Array(await readFile(path)),scene,{pluginExtension:'.glb',pluginOptions:{gltf:{animationStartMode:0,skipMaterials:true}}});
  t.mock.method(globalThis,'fetch',async()=>new Response(await readFile('public/manual-roam/locomotion-v2.manifest.json','utf8')));
  try {
    const avatar=await load(ordinary),names=avatar.transformNodes.map(node=>node.name),bind=avatar.skeletons[0].bones.map(bone=>bone.getAbsoluteInverseBindMatrix().clone());
    const animator=await ManualRoamAvatarAnimator.create(scene,avatar,{sourceUrl:'ordinary://motion',manifestUrl:'ordinary://manifest',loadContainer:()=>load('public/manual-roam/locomotion-v2.glb')});
    const binding=animator.getRigBinding();
    assert.equal(binding.automatic,true);assert.equal(binding.joints.size,22);assert.ok(Number.isFinite(binding.facingYaw));
    assert.deepEqual(avatar.transformNodes.map(node=>node.name),names);
    avatar.skeletons[0].bones.forEach((bone,i)=>assert.ok(bone.getAbsoluteInverseBindMatrix().equals(bind[i])));
    const tracks=scene.animationGroups.filter(group=>group.name.startsWith('manual-roam-'));
    assert.ok(tracks.length>=17);assert.ok(tracks.every(group=>group.targetedAnimations.length===23));
    animator.sampleIdle();const leg=binding.joints.get('LeftUpLeg')!,before=leg.rotationQuaternion!.clone();
    // Xbot原始单位为厘米；模拟运行时把腿长归一到0.9米，验证实际世界速度下的步频。
    for(let i=0;i<10;i++){animator.update({deltaSeconds:.05,velocityX:0,velocityZ:1.6,yaw:0,verticalVelocity:0,grounded:true,jumped:false,fly:false,sprint:false,walkSpeed:1.6,worldScale:.9/binding.legLength});scene.animate();}
    const walk=tracks.find(group=>group.name.endsWith('WalkForward'))!;
    const legKeys=walk.targetedAnimations.find(track=>track.target===leg)!.animation.getKeys();
    assert.ok(Math.abs(Quaternion.Dot(before,leg.rotationQuaternion!))<.9999,JSON.stringify({phase:animator.getStatus().phase,before:before.asArray(),after:leg.rotationQuaternion!.asArray(),key0:legKeys[0].value.asArray(),keyQuarter:legKeys[Math.floor(legKeys.length/4)].value.asArray(),legLength:binding.legLength}));
    const fastFrame={deltaSeconds:.05,velocityX:0,velocityZ:5,yaw:0,verticalVelocity:0,grounded:true,jumped:false,fly:false,sprint:true,walkSpeed:1.6,worldScale:.9/binding.legLength};
    animator.setStrideWarpEnabled(true);for(let i=0;i<5;i++)animator.update(fastFrame);
    assert.ok(animator.getStrideScale()>1,'有IK时可按步幅扩展降低步频');
    animator.setStrideWarpEnabled(false);animator.update(fastFrame);
    assert.equal(animator.getStrideScale(),1,'IK不可用时关闭步幅扩展，按原动作步幅推进相位');
    for(const node of binding.joints.values())assert.ok(node.rotationQuaternion!.asArray().every(Number.isFinite));
    const left=binding.joints.get('LeftArm')!,hand=binding.joints.get('LeftHand')!;
    assert.ok(Vector3.Distance(left.getAbsolutePosition(),hand.getAbsolutePosition())>0);
    animator.dispose();avatar.dispose();
  }finally{scene.dispose();engine.dispose();}
});

for(const variant of ['A-pose','rotated-90','parent-yaw','helper-bone'] as const)test(`真实普通人物${variant}自动参考校准和全部动作保持有限、几何与bind不变`,async t=>{
  const engine=new NullEngine(),scene=new Scene(engine);
  const load=async(path:string)=>LoadAssetContainerAsync(new Uint8Array(await readFile(path)),scene,{pluginExtension:'.glb',pluginOptions:{gltf:{animationStartMode:0,skipMaterials:true}}});
  t.mock.method(globalThis,'fetch',async()=>new Response(await readFile('public/manual-roam/locomotion-v2.manifest.json','utf8')));
  try{
    const avatar=await load(ordinary),initial=identifyRuntimeHumanoid(avatar),skeleton=avatar.skeletons[0];
    if(variant==='rotated-90'){
      const root=avatar.rootNodes[0] as TransformNode;
      root.rotationQuaternion=Quaternion.RotationAxis(Vector3.Up(),Math.PI/2).multiply(root.rotationQuaternion??Quaternion.Identity());
    }else if(variant==='parent-yaw'){
      const parent=new TransformNode('user-spawn-yaw',scene);parent.rotation.y=.7;
      for(const root of avatar.rootNodes)root.parent=parent;
    }else if(variant==='A-pose'){
      for(const side of ['Left','Right']){
        const node=initial.joints.get(side+'Arm')!,bone=skeleton.bones.find(bone=>bone.getTransformNode()===node)!;
        node.rotationQuaternion=node.rotationQuaternion!.multiply(Quaternion.RotationAxis(Vector3.Forward(),side==='Left'?-.45:.45));
        bone.setRestMatrix(Matrix.Compose(node.scaling,node.rotationQuaternion,node.position));
      }
    }else{
      const hand=initial.joints.get('LeftHand')!,forearm=initial.joints.get('LeftForeArm')!;
      const helper=new TransformNode('arm_roll_helper',scene);helper.parent=forearm;helper.rotationQuaternion=Quaternion.RotationAxis(Vector3.Up(),.22);
      hand.setParent(helper);avatar.transformNodes.push(helper);
      const parentBone=skeleton.bones.find(bone=>bone.getTransformNode()===forearm)!;
      const helperBone=new Bone(helper.name,skeleton,parentBone,Matrix.Compose(helper.scaling,helper.rotationQuaternion,helper.position));helperBone.linkTransformNode(helper);
      const handBone=skeleton.bones.find(bone=>bone.getTransformNode()===hand)!;handBone.setParent(helperBone,false);handBone.setRestMatrix(Matrix.Compose(hand.scaling,hand.rotationQuaternion!,hand.position));
    }
    const binds=skeleton.bones.map(bone=>bone.getAbsoluteInverseBindMatrix().clone());
    const geometry=avatar.meshes.map(mesh=>mesh.getVerticesData(VertexBuffer.PositionKind)?.slice()??null);
    const animator=await ManualRoamAvatarAnimator.create(scene,avatar,{sourceUrl:`${variant}://motion`,manifestUrl:`${variant}://manifest`,loadContainer:()=>load('public/manual-roam/locomotion-v2.glb')});
    const binding=animator.getRigBinding();
    if(variant==='rotated-90')assert.ok(Math.abs(Math.abs(binding.facingYaw)-Math.PI/2)<.01);
    if(variant==='parent-yaw')assert.ok(Math.abs(binding.facingYaw)<.01,'自动朝向不能取消用户出生点旋转');
    for(const side of ['Left','Right']){
      const arm=binding.joints.get(side+'Arm')!,hand=binding.joints.get(side+'Hand')!;arm.computeWorldMatrix(true);hand.computeWorldMatrix(true);
      assert.ok(Math.abs(arm.getAbsolutePosition().y-hand.getAbsolutePosition().y)<binding.legLength*.02,'校准后手臂应接近源T姿态');
    }
    skeleton.bones.forEach((bone,i)=>assert.ok(bone.getAbsoluteInverseBindMatrix().equals(binds[i])));
    avatar.meshes.forEach((mesh,i)=>assert.deepEqual(mesh.getVerticesData(VertexBuffer.PositionKind),geometry[i]));
    const groups=scene.animationGroups.filter(group=>group.name.startsWith('manual-roam-'));
    for(const group of groups){
      assert.equal(group.targetedAnimations.length,23);
      for(const track of group.targetedAnimations){
        const keys=track.animation.getKeys();assert.ok(keys.every(key=>key.value.asArray().every(Number.isFinite)),group.name);
        if(track.animation.targetProperty==='rotationQuaternion')assert.ok(keys.every(key=>Math.abs(key.value.length()-1)<1e-5),group.name);
      }
      group.start(false,0);group.goToFrame(group.from+(group.to-group.from)*.25);group.pause();
      for(const node of binding.joints.values())assert.ok(node.rotationQuaternion!.asArray().every(Number.isFinite),group.name);
      group.stop();
    }
    animator.dispose();avatar.dispose();
  }finally{scene.dispose();engine.dispose();}
});
