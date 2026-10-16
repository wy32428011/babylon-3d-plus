import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { Animation, AnimationGroup, AssetContainer, Bone, Matrix, MeshBuilder, NullEngine, Quaternion, Scene, Skeleton, TransformNode, Vector3, VertexBuffer, LoadAssetContainerAsync } from '@babylonjs/core';
import { ManualRoamAvatarAnimator } from '../../src/runtime/roam/ManualRoamAvatarAnimator.ts';
import { MANUAL_ROAM_JOINT_PARENTS, getManualRoamRigProfile, validateManualRoamAvatarRig } from '../../src/runtime/roam/manualRoamAvatarRig.ts';
import { MANUAL_ROAM_CLIPS } from '../../src/runtime/roam/manualRoamAnimationState.ts';

function fixture(scene: Scene, skin: boolean, heightScale = 1) {
  const container = new AssetContainer(scene);
  const root = new TransformNode('RigRoot', scene);
  root.metadata = { gltf: { extras: { manualRoamRig: { profile: 'mixamo-humanoid-v1', version: 1 } } } };
  container.rootNodes.push(root); container.transformNodes.push(root);
  const nodes = new Map<string, TransformNode>();
  const skeleton = new Skeleton('rig', 'rig', scene);
  const bones = new Map<string, Bone>();
  for (const [name, parent] of Object.entries(MANUAL_ROAM_JOINT_PARENTS)) {
    const node = new TransformNode(name, scene);
    node.parent = parent ? nodes.get(parent)! : root;
    node.position = new Vector3(name.startsWith('Left') ? -0.1 : name.startsWith('Right') ? 0.1 : 0, 0.1, 0).scale(heightScale);
    node.rotationQuaternion = Quaternion.Identity();
    nodes.set(name, node); container.transformNodes.push(node);
    const bone = new Bone(name, skeleton, parent ? bones.get(parent) : undefined, Matrix.Translation(node.position.x, node.position.y, node.position.z));
    bone.linkTransformNode(node); bones.set(name, bone);
  }
  container.skeletons.push(skeleton);
  if (skin) {
    const mesh = MeshBuilder.CreateBox('skin', {}, scene); mesh.parent = root; mesh.skeleton = skeleton;
    const count = mesh.getTotalVertices();
    mesh.setVerticesData(VertexBuffer.MatricesIndicesKind, Array(count).fill([0, 0, 0, 0]).flat());
    mesh.setVerticesData(VertexBuffer.MatricesWeightsKind, Array(count).fill([1, 0, 0, 0]).flat());
    container.meshes.push(mesh);
  } else {
    for (const name of MANUAL_ROAM_CLIPS) {
      const group = new AnimationGroup(name, scene);
      for (const node of nodes.values()) {
        const animation = new Animation(`${name}-${node.name}`, 'rotationQuaternion', 30, Animation.ANIMATIONTYPE_QUATERNION);
        animation.setKeys([{ frame: 0, value: Quaternion.Identity() }, { frame: 30, value: Quaternion.RotationAxis(Vector3.Right(), 0.3) }]);
        group.addTargetedAnimation(animation, node);
      }
      const hips = nodes.get('Hips')!;
      const position = new Animation(`${name}-hips-height`, 'position', 30, Animation.ANIMATIONTYPE_VECTOR3);
      position.setKeys([{ frame: 0, value: hips.position.clone() }, { frame: 30, value: hips.position.add(new Vector3(0, 0.02, 0)) }]);
      group.addTargetedAnimation(position, hips);
      container.animationGroups.push(group);
    }
  }
  container.removeAllFromScene();
  return { container, nodes, root };
}
const manifest = { version: 1, profile: 'mixamo-humanoid-v1', clips: Object.fromEntries(MANUAL_ROAM_CLIPS.map(name => [name, { name, loop: !['JumpStart', 'Land'].includes(name), referenceSpeed: name.startsWith('Run') ? 3.2 : 1.6 }])) };
const frame = { deltaSeconds: 0.05, velocityX: 0, velocityZ: 1.6, yaw: 0, verticalVelocity: 0, grounded: true, jumped: false, fly: false, sprint: false, walkSpeed: 1.6, worldScale: 1 };

test('scene动画求值不能用零速首帧覆盖手动加权采样', async t => {
  const engine=new NullEngine(),scene=new Scene(engine),avatar=fixture(scene,true),source=fixture(scene,false);
  t.mock.method(globalThis,'fetch',async()=>new Response(JSON.stringify(manifest)));
  try {
    const animator=await ManualRoamAvatarAnimator.create(scene,avatar.container,{sourceUrl:'manual://weighted',manifestUrl:'manual://manifest',loadContainer:async()=>source.container});
    for(let i=0;i<5;i++){animator.update(frame);scene.animate();}
    const rotation=avatar.nodes.get('LeftLeg')!.rotationQuaternion!;
    assert.ok(Math.abs(rotation.x)>.02,'实际场景动画阶段后应保留已推进的关节姿态');
    const before=rotation.clone();animator.update(frame);scene.animate();
    assert.ok(Math.abs(Quaternion.Dot(before,rotation))<.9999999,'播放游标应继续推进，不能停在首帧');
    animator.dispose();avatar.container.dispose();
  } finally {scene.dispose();engine.dispose();}
});

test('profile不等于有效骨骼：拒绝无权重、重名关节和错误父级', () => {
  const engine = new NullEngine(); const scene = new Scene(engine);
  try {
    const avatar = fixture(scene, true);
    assert.equal(getManualRoamRigProfile(avatar.container), 'mixamo-humanoid-v1');
    assert.equal(validateManualRoamAvatarRig(avatar.container).size, 22);
    const duplicate = new TransformNode('LeftHand', scene); avatar.container.transformNodes.push(duplicate);
    assert.throws(() => validateManualRoamAvatarRig(avatar.container), /重名/);
    avatar.container.transformNodes.pop(); duplicate.dispose();
    avatar.nodes.get('LeftHand')!.parent = avatar.root;
    assert.throws(() => validateManualRoamAvatarRig(avatar.container), /父级/);
    avatar.nodes.get('LeftHand')!.parent = avatar.nodes.get('LeftForeArm')!;
    avatar.container.meshes[0].setVerticesData(VertexBuffer.MatricesWeightsKind, Array(96).fill(0));
    assert.throws(() => validateManualRoamAvatarRig(avatar.container), /权重/);
  } finally { scene.dispose(); engine.dispose(); }
});

test('同骨架不同腿长保留目标骨盆基高、缩放起伏和步频，水平位移保持不变', async t => {
  const engine = new NullEngine(); const scene = new Scene(engine);
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(manifest)));
  const source = fixture(scene, false); const small = fixture(scene, true); const tall = fixture(scene, true, 1.5);
  const options = { sourceUrl: 'scale://motion', manifestUrl: 'scale://manifest', loadContainer: async () => source.container };
  try {
    const a = await ManualRoamAvatarAnimator.create(scene, small.container, options);
    const b = await ManualRoamAvatarAnimator.create(scene, tall.container, options);
    a.update(frame); b.update(frame);
    assert.ok(Math.abs(a.getStatus().phase / b.getStatus().phase - 1.5) < 1e-5);
    const group = scene.animationGroups.find(group => group.name.startsWith('manual-roam-') && group.name.endsWith('WalkForward') && group.targetedAnimations[0].target === tall.nodes.get('Hips'))!;
    const keys = group.targetedAnimations.find(track => track.animation.targetProperty === 'position')!.animation.getKeys();
    assert.ok(Math.abs(keys[0].value.y - 0.15) < 1e-6);
    assert.ok(Math.abs(keys[1].value.y - 0.18) < 1e-6);
    assert.ok(keys.every(key => key.value.x === 0 && key.value.z === 0));
    a.dispose(); b.dispose();
  } finally { scene.dispose(); engine.dispose(); }
});

test('同Scene并行人物共享一次源加载，但绑定目标、动画键、暂停和释放彼此独立', async t => {
  const engine = new NullEngine(); const scene = new Scene(engine);
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(manifest)));
  const source = fixture(scene, false); const first = fixture(scene, true); const second = fixture(scene, true);
  let loads = 0;
  const options = { sourceUrl: 'test://locomotion.glb', manifestUrl: 'test://manifest.json', loadContainer: async () => { loads++; return source.container; } };
  try {
    const [a, b] = await Promise.all([ManualRoamAvatarAnimator.create(scene, first.container, options), ManualRoamAvatarAnimator.create(scene, second.container, options)]);
    assert.equal(loads, 1);
    for (let i = 0; i < 5; i++) a.update(frame);
    assert.deepEqual(a.getStatus().activeGroups, ['WalkForward']);
    const group = scene.animationGroups.find(group => group.name.startsWith('manual-roam-') && group.name.endsWith('WalkForward') && group.targetedAnimations[0].target === first.nodes.get('Hips'))!;
    assert.ok(group);
    assert.notEqual(group.targetedAnimations[0].animation.getKeys(), source.container.animationGroups[1].targetedAnimations[0].animation.getKeys());
    assert.ok(group.targetedAnimations.every(track => first.container.transformNodes.includes(track.target)));
    a.pause(); assert.equal(group.isPlaying, false);
    a.resume(); assert.equal(group.isPlaying, true);
    a.dispose(); assert.equal(group.isPlaying, false);
    assert.equal(source.root.isDisposed(), false);
    b.update(frame); b.dispose(); assert.equal(source.root.isDisposed(), true);
  } finally { scene.dispose(); engine.dispose(); }
});

test('动作缺轨绑定失败，失败缓存释放后允许重试', async t => {
  const engine = new NullEngine(); const scene = new Scene(engine);
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(manifest)));
  const avatar = fixture(scene, true); const broken = fixture(scene, false);
  broken.container.animationGroups[0].targetedAnimations[0].target = new TransformNode('UnknownJoint', scene);
  let loads = 0;
  const options = { sourceUrl: 'test://retry.glb', manifestUrl: 'test://manifest.json', loadContainer: async () => { loads++; return loads === 1 ? broken.container : fixture(scene, false).container; } };
  try {
    await assert.rejects(ManualRoamAvatarAnimator.create(scene, avatar.container, options), /轨道/);
    const animator = await ManualRoamAvatarAnimator.create(scene, avatar.container, options);
    assert.equal(loads, 2); animator.dispose();
  } finally { scene.dispose(); engine.dispose(); }
});

for (const version of ['v1','v2']) test(`实际${version}人物与独立动作包通过严格绑定并实际改变关节姿势`, async t => {
  const engine = new NullEngine(); const scene = new Scene(engine);
  const actualManifest = await readFile(`public/manual-roam/locomotion-${version}.manifest.json`, 'utf8');
  t.mock.method(globalThis, 'fetch', async () => new Response(actualManifest));
  const loadFile = async (path: string) => LoadAssetContainerAsync(new Uint8Array(await readFile(path)), scene, { pluginExtension: '.glb', pluginOptions: { gltf: { animationStartMode: 0, skipMaterials: true } } });
  try {
    const avatar = await loadFile(`public/manual-roam/EQ_People_rigged_${version}.glb`);
    const animator = await ManualRoamAvatarAnimator.create(scene, avatar, { sourceUrl: 'real://locomotion', manifestUrl: 'real://manifest', loadContainer: () => loadFile(`public/manual-roam/locomotion-${version}.glb`) });
    animator.sampleIdle();
    const leg = avatar.transformNodes.find(node => node.name === 'LeftUpLeg')!;
    const idle = leg.rotationQuaternion!.clone();
    for (let i = 0; i < 10; i++) animator.update(frame);
    const walk = scene.animationGroups.find(group => group.name.endsWith('WalkForward') && group.name.startsWith('manual-roam-'))!;
    walk.goToFrame(walk.from + (walk.to - walk.from) * 0.25);
    assert.ok(Math.abs(Quaternion.Dot(idle, leg.rotationQuaternion!)) < 0.9999, '真实动作必须改变腿部骨骼');
    assert.deepEqual(animator.getStatus().activeGroups, ['WalkForward']);
    animator.dispose(); avatar.dispose();
  } finally { scene.dispose(); engine.dispose(); }
});

test('v2动作加载失败还原真实bind显示，清单与源骨架版本不符时明确拒绝', async t => {
  const engine = new NullEngine(); const scene = new Scene(engine);
  const load = async (path: string) => LoadAssetContainerAsync(new Uint8Array(await readFile(path)), scene, { pluginExtension: '.glb', pluginOptions: { gltf: { animationStartMode: 0, skipMaterials: true } } });
  try {
    const avatar = await load('public/manual-roam/EQ_People_rigged_v2.glb');
    const rest = avatar.skeletons[0].bones.map(bone=>bone.getRestMatrix().clone());
    const positions = avatar.transformNodes.map(node=>node.position.clone());
    t.mock.method(globalThis,'fetch',async()=>{throw new Error('离线动作缺失');});
    await assert.rejects(ManualRoamAvatarAnimator.create(scene,avatar,{sourceUrl:'error://motion',manifestUrl:'error://manifest'}),/离线动作缺失/);
    avatar.skeletons[0].bones.forEach((bone,i)=>assert.ok(bone.getRestMatrix().equals(rest[i])));
    avatar.transformNodes.forEach((node,i)=>assert.ok(node.position.equals(positions[i])));
    t.mock.method(globalThis,'fetch',async()=>new Response(await readFile('public/manual-roam/locomotion-v2.manifest.json','utf8')));
    await assert.rejects(ManualRoamAvatarAnimator.create(scene,avatar,{sourceUrl:'mismatch://motion',manifestUrl:'mismatch://manifest',loadContainer:()=>load('public/manual-roam/locomotion-v1.glb')}),/骨架版本不一致/);
    avatar.dispose();
  } finally { scene.dispose(); engine.dispose(); }
});

test('清单不兼容、缺动作、非法基准速度与网络失败明确拒绝，不加载GLB', async t => {
  const engine = new NullEngine(); const scene = new Scene(engine); const avatar = fixture(scene, true);
  let payload: unknown = null; let ok = true; let loads = 0;
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(payload), { status: ok ? 200 : 503 }));
  const options = { sourceUrl: 'bad://motion', manifestUrl: 'bad://manifest', loadContainer: async () => { loads++; return fixture(scene, false).container; } };
  try {
    for (const value of [null, { ...manifest, version: 2 }, { ...manifest, clips: {} }, { ...manifest, clips: { ...manifest.clips, WalkForward: { name: 'WalkForward', loop: true, referenceSpeed: 0 } } }]) {
      payload = value;
      await assert.rejects(ManualRoamAvatarAnimator.create(scene, avatar.container, options), /清单|速度/);
    }
    ok = false;
    await assert.rejects(ManualRoamAvatarAnimator.create(scene, avatar.container, options), /HTTP 503/);
    assert.equal(loads, 0);
  } finally { scene.dispose(); engine.dispose(); }
});

test('退出期间Idle取样保持暂停，场景销毁释放源资源，重复释放安全', async t => {
  const engine = new NullEngine(); const scene = new Scene(engine);
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(manifest)));
  const avatar = fixture(scene, true); const source = fixture(scene, false);
  const animator = await ManualRoamAvatarAnimator.create(scene, avatar.container, { sourceUrl: 'dispose://motion', manifestUrl: 'dispose://manifest', loadContainer: async () => source.container });
  animator.pause(); animator.pause(); animator.sampleIdle(); animator.update(frame);
  assert.equal(animator.getStatus().phase, 0);
  assert.equal(scene.animationGroups.some(group => group.name.startsWith('manual-roam-') && group.isPlaying), false);
  animator.resume(); animator.resume(); animator.update({ ...frame, deltaSeconds: Number.NaN });
  scene.dispose(); assert.equal(source.root.isDisposed(), true);
  animator.dispose(); animator.dispose(); animator.update(frame); animator.pause(); animator.resume(); animator.sampleIdle();
  engine.dispose();
});

test('进入Fall时渐出JumpUp的采样时间继续前进，不能跳回首帧', async t => {
  const engine = new NullEngine(); const scene = new Scene(engine);
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(manifest)));
  const avatar = fixture(scene, true); const source = fixture(scene, false);
  const animator = await ManualRoamAvatarAnimator.create(scene, avatar.container, { sourceUrl: 'clock://motion', manifestUrl: 'clock://manifest', loadContainer: async () => source.container });
  try {
    for (let i = 0; i < 5; i++) animator.update({ ...frame, velocityZ: 0, grounded: false, verticalVelocity: 2 });
    const up = scene.animationGroups.find(group => group.name.startsWith('manual-roam-') && group.name.endsWith('JumpUp'))!;
    const before = up.getCurrentFrame();
    animator.update({ ...frame, velocityZ: 0, grounded: false, verticalVelocity: -1 });
    assert.equal(animator.getStatus().state, 'Fall');
    assert.ok(up.isStarted, '渐出组仍应参与混合');
    assert.ok(up.getCurrentFrame() >= before, '旧片段不能借用新状态的elapsed=0');
  } finally { animator.dispose(); scene.dispose(); engine.dispose(); }
});

test('整个权重向量按统一0.18秒过渡到斜行，连续方向更新不会重置过渡进度', async t => {
  const engine = new NullEngine(); const scene = new Scene(engine);
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(manifest)));
  const avatar = fixture(scene, true); const source = fixture(scene, false);
  const animator = await ManualRoamAvatarAnimator.create(scene, avatar.container, { sourceUrl: 'blend://motion', manifestUrl: 'blend://manifest', loadContainer: async () => source.container });
  const group = (clip: string) => scene.animationGroups.find(group => group.name.startsWith('manual-roam-') && group.name.endsWith(clip))!;
  try {
    for (let i = 0; i < 5; i++) animator.update(frame);
    const diagonal = { ...frame, deltaSeconds: 0.03, velocityX: 1, velocityZ: 1 };
    for (let i = 0; i < 3; i++) animator.update(diagonal);
    assert.ok(Math.abs(group('WalkForward').animatables[0].weight - 0.75) < 1e-6, '半程应在完整权重向量中间，不能提前完成');
    assert.ok(Math.abs(group('WalkRight').animatables[0].weight - 0.25) < 1e-6);
    for (let i = 0; i < 3; i++) animator.update({ ...diagonal, velocityX: 1 + i * 0.02 });
    const right = 1.04 / 2.04;
    assert.ok(Math.abs(group('WalkRight').animatables[0].weight - right) < 1e-6, '持续方向输入不能无限重开过渡');
    assert.ok(Math.abs(group('WalkForward').animatables[0].weight + group('WalkRight').animatables[0].weight - 1) < 1e-6);
  } finally { animator.dispose(); scene.dispose(); engine.dispose(); }
});
