import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { LoadAssetContainerAsync, NullEngine, Quaternion, Scene, TransformNode, Vector3 } from '@babylonjs/core';
import '@babylonjs/loaders/glTF/index.js';
import { ManualRoamFootIK } from '../../src/runtime/roam/ManualRoamFootIK.ts';
import { prepareManualRoamReferencePose } from '../../src/runtime/roam/manualRoamAvatarRig.ts';
import { measureManualRoamSole } from '../../src/runtime/roam/manualRoamSoleGeometry.ts';

async function fixture(scale: number, yaw: number, mirror: boolean) {
  const engine = new NullEngine(); const scene = new Scene(engine);
  const container = await LoadAssetContainerAsync(new Uint8Array(await readFile('public/manual-roam/EQ_People_rigged_v2.glb')), scene, { pluginExtension: '.glb', pluginOptions: { gltf: { skipMaterials: true, animationStartMode: 0 } } });
  container.addAllToScene(); prepareManualRoamReferencePose(container);
  container.skeletons.forEach(skeleton => skeleton.returnToRest());
  const root = new TransformNode('test-avatar-visual-root', scene);
  root.scaling.set(scale * (mirror ? -1 : 1), scale, scale);
  root.rotationQuaternion = Quaternion.RotationAxis(Vector3.Up(), yaw);
  root.position.set(2, 0.1, -3);
  container.rootNodes.forEach(node => node.parent = root);
  const node = (name: string) => container.transformNodes.find(node => node.name === name)!;
  const pose = () => {
    for (const side of ['Left','Right']) {
      node(side + 'UpLeg').rotationQuaternion = Quaternion.RotationAxis(Vector3.Right(), -0.18);
      node(side + 'Leg').rotationQuaternion = Quaternion.RotationAxis(Vector3.Right(), 0.36);
      // 与生产动作一致：叠加资产记录的脚俯仰补偿，鞋底在腿部净旋转为零时是平的。
      const soleUp = node(side + 'Foot').metadata?.gltf?.extras?.manualRoamSoleUp as number[] | undefined;
      const pitch = soleUp ? Math.atan2(-soleUp[2], soleUp[1]) : 0;
      node(side + 'Foot').rotationQuaternion = Quaternion.RotationAxis(Vector3.Right(), pitch).multiply(Quaternion.RotationAxis(Vector3.Right(), -0.18));
    }
    container.transformNodes.forEach(node => node.computeWorldMatrix(true));
  };
  pose();
  return { engine, scene, container, root, node, pose, dispose: () => { scene.dispose(); engine.dispose(); } };
}
const frame = { dt: 1 / 60, grounded: true, fly: false, speed: 0, footContacts: { left: 1, right: 1 } };

test('鞋底跨越局部高差时检查整片接触轮廓，不能只贴住低处后跟平面',async()=>{
  for(const slope of [0,.3]){
  const f=await fixture(1,0,false),ground=.1;let raised=false,boundary=0,direction=1;
  const heightAt=(x:number)=>ground-slope*(x-2)+(raised&&(x-boundary)*direction>0?.012:0);
  const ik=new ManualRoamFootIK(f.container,{probeGround:(x)=>({height:heightAt(x),normal:new Vector3(slope,1,0).normalize()})});
  const shoe=()=>{
    f.container.skeletons.forEach(s=>s.prepare(true));
    return f.container.meshes.flatMap(mesh=>{const p=mesh.getPositionData(true),weights=mesh.getVerticesData('matricesWeights'),joints=mesh.getVerticesData('matricesIndices');if(!p||!weights||!joints||!mesh.skeleton)return [];const world=mesh.computeWorldMatrix(true);return [...new Set(mesh.getIndices()??[])].filter(i=>{let w=0;for(let k=0;k<4;k++)if(/^Left(Foot|ToeBase)$/.test(mesh.skeleton!.bones[joints[i*4+k]].name))w+=weights[i*4+k];return w>.99;}).map(i=>Vector3.TransformCoordinates(Vector3.FromArray(p,i*3),world));});
  };
  try{
    ik.update(frame);const before=shoe(),lowest=before.reduce((a,b)=>a.y-heightAt(a.x)<b.y-heightAt(b.x)?a:b),bottom=before.filter(p=>p.y-heightAt(p.x)<lowest.y-heightAt(lowest.x)+.006);
    assert.ok(bottom.length>3);const xs=bottom.map(p=>p.x);boundary=(Math.min(...xs)+Math.max(...xs))/2;direction=lowest.x<=boundary?1:-1;
    assert.ok(Math.max(...xs)-Math.min(...xs)>.03);const root=f.root.position.clone(),anchor=ik.getDebugState().left.lockPoint!.clone();
    raised=true;assert.ok(Math.min(...before.map(p=>p.y-heightAt(p.x)))<-.002,'必须实际构造局部高差穿地');f.pose();ik.update(frame);const points=shoe(),clearances=points.map(p=>p.y-heightAt(p.x));
    assert.ok(Math.min(...clearances)>-.002,`真实鞋底跨高差穿地${-Math.min(...clearances)}m`);
    assert.ok(Math.min(...clearances)<.002,'支撑鞋必须实际接触某一处地面');
    const contact=points[before.indexOf(lowest)];assert.ok(Math.hypot(contact.x-lowest.x,contact.z-lowest.z)<.001,'斜面高差纠正不得产生水平鞋滑');
    assert.ok(f.root.position.equals(root));const lock=ik.getDebugState().left.lockPoint!;assert.ok(lock&&Math.hypot(lock.x-anchor.x,lock.z-anchor.z)<1e-6,'贴地补偿保留水平锁');
  }finally{ik.dispose();f.dispose();}
  }
});

test('地面探测对齐真实鞋底接触点，不能采到相邻踝部下的高地面',async()=>{
  const f=await fixture(1,0,false),foot=f.node('LeftFoot');
  const sole=measureManualRoamSole(f.container,foot,'Left',.065),world=foot.computeWorldMatrix(true),at=foot.getAbsolutePosition().clone();
  const expected=sole.sample().map(p=>Vector3.TransformNormal(p,world).add(at)).sort((a,b)=>a.y-b.y)[0];
  const probes:Vector3[]=[];
  const ik=new ManualRoamFootIK(f.container,{probeGround:(x,z)=>{probes.push(new Vector3(x,.1,z));return {height:.1,normal:Vector3.Up()};}});
  try{ik.update(frame);assert.ok(probes.length>=2);assert.ok(Math.hypot(probes[0].x-expected.x,probes[0].z-expected.z)<1e-5,'射线必须落在真实后跟/前掌接触位置');assert.equal(ik.getDebugState().left.reason,'solved');}
  finally{ik.dispose();f.dispose();}
});

test('摆动脚按本帧步幅系数扩展视觉目标，不改人物根和骨长',async()=>{
  const f=await fixture(1,0,false);
  for(const side of ['Left','Right']){f.node(side+'UpLeg').rotationQuaternion=Quaternion.RotationAxis(Vector3.Right(),-.5);f.node(side+'Leg').rotationQuaternion=Quaternion.RotationAxis(Vector3.Right(),.7);f.node(side+'Foot').rotationQuaternion=Quaternion.RotationAxis(Vector3.Right(),-.2);}
  f.container.transformNodes.forEach(n=>n.computeWorldMatrix(true));
  const before=f.node('LeftFoot').getAbsolutePosition().clone(),hip=f.node('Hips').getAbsolutePosition().clone(),root=f.root.position.clone();
  const upper=Vector3.Distance(f.node('LeftUpLeg').getAbsolutePosition(),f.node('LeftLeg').getAbsolutePosition()),lower=Vector3.Distance(f.node('LeftLeg').getAbsolutePosition(),before);
  const ik=new ManualRoamFootIK(f.container,{probeGround:()=>({height:.1,normal:Vector3.Up()})});
  try{ik.update({...frame,speed:1.6,strideScale:1.15,footContacts:{left:0,right:0}});const after=f.node('LeftFoot').getAbsolutePosition();assert.ok(Math.abs(after.z-before.z-(before.z-hip.z)*.15)<.001);assert.ok(Vector3.Distance(before,after)>.005);assert.ok(f.root.position.equals(root));assert.ok(Math.abs(Vector3.Distance(f.node('LeftUpLeg').getAbsolutePosition(),f.node('LeftLeg').getAbsolutePosition())-upper)<1e-5);assert.ok(Math.abs(Vector3.Distance(f.node('LeftLeg').getAbsolutePosition(),after)-lower)<1e-5);}
  finally{ik.dispose();f.dispose();}
});

test('支撑鞋真实残差迭代有界、实际下降且不移动根',async()=>{
  const f=await fixture(1,0,false),root=f.root.position.clone();
  // 在此夹具重现旧鞋底的小腿混合影响，生产资产已修复，不能再靠它偶然触发残差。
  let injected=0;
  for(const mesh of f.container.meshes){
    const skeleton=mesh.skeleton,ids=mesh.getVerticesData('matricesIndices'),ws=mesh.getVerticesData('matricesWeights');
    if(!skeleton||!ids||!ws)continue;
    const leg=skeleton.bones.findIndex(b=>b.name==='RightLeg'),foot=skeleton.bones.findIndex(b=>b.name==='RightFoot');
    if(leg<0||foot<0)continue;
    const indices=Array.from(ids),weights=Array.from(ws);
    let changed=false;
    for(const i of new Set(mesh.getIndices()??[])){
      let footWeight=0;for(let k=0;k<4;k++)if(indices[i*4+k]===foot)footWeight+=weights[i*4+k];
      if(footWeight<.9)continue;
      indices.splice(i*4,4,foot,leg,0,0);weights.splice(i*4,4,.55,.45,0,0);injected++;changed=true;
    }
    if(changed){mesh.setVerticesData('matricesIndices',indices,false,4);mesh.setVerticesData('matricesWeights',weights,false,4);}
  }
  assert.ok(injected>20,'必须注入非空真实鞋底顶点集合');
  const ik=new ManualRoamFootIK(f.container,{probeGround:()=>({height:.1,normal:Vector3.Up()})});let corrections=0;
  let residual=0,improvement=0;
  try{
    for(let tick=0;tick<8;tick++){f.pose();f.node('RightUpLeg').rotationQuaternion=Quaternion.RotationAxis(Vector3.Up(),tick*.035).multiply(f.node('RightUpLeg').rotationQuaternion!);ik.update(frame);const d=ik.getDebugState().right;assert.equal(d.reason,'solved');assert.ok(d.residualIterations<=2&&d.residualCorrection<=.020001);assert.ok(d.soleResidualAfter<=d.soleResidualBefore+1e-7);corrections+=d.residualIterations;residual=Math.max(residual,d.soleResidualBefore);improvement+=d.soleResidualBefore-d.soleResidualAfter;}
    assert.ok(residual>.001,'混合蒙皮必须产生至少1mm真实残差');assert.ok(improvement>.001,'残差必须有实际下降');
    assert.ok(corrections>0,'必须真实执行蒙皮残差修正');assert.ok(f.root.position.equals(root));
  }finally{ik.dispose();f.dispose();}
});

test('小幅贴地优先保留源动作膝盖弯曲平面，不强制改成身体正前方',async()=>{
  const f=await fixture(1,.2,false);
  f.node('LeftUpLeg').rotationQuaternion=Quaternion.RotationAxis(Vector3.Up(),.45).multiply(f.node('LeftUpLeg').rotationQuaternion!);
  f.container.transformNodes.forEach(n=>n.computeWorldMatrix(true));
  const hip=f.node('LeftUpLeg').getAbsolutePosition().clone(),foot=f.node('LeftFoot').getAbsolutePosition().clone(),axis=foot.subtract(hip).normalize();
  const projected=(p:Vector3)=>p.subtract(axis.scale(Vector3.Dot(p,axis))).normalize();
  const before=projected(f.node('LeftLeg').getAbsolutePosition().subtract(hip));
  const ik=new ManualRoamFootIK(f.container,{probeGround:()=>({height:.14,normal:Vector3.Up()})});
  try{ik.update(frame);const debug=ik.getDebugState().left;assert.equal(debug.reason,'solved');assert.ok(debug.targetError<.002);assert.ok(Vector3.Distance(foot,f.node('LeftFoot').getAbsolutePosition())>.005,'必须真实执行地面纠正');const after=projected(f.node('LeftLeg').getAbsolutePosition().subtract(f.node('LeftUpLeg').getAbsolutePosition()));assert.ok(Vector3.Dot(before,after)>.995,'IK额外膝盖偏转应小于约6度');}
  finally{ik.dispose();f.dispose();}
});

test('骨盆偏移按时间平滑、有界并随FK基准回收，持续待机不积累',async()=>{
  const drops:number[]=[];
  for(const fps of [30,60,120]){
    const f=await fixture(1,0,false),base=f.node('Hips').position.clone();let ground=.055;
    const ik=new ManualRoamFootIK(f.container,{probeGround:()=>({height:ground,normal:Vector3.Up()})});
    try{
      let previous=0;
      for(let tick=0;tick<fps/2;tick++){f.node('Hips').position.copyFrom(base);f.pose();ik.update({...frame,dt:1/fps});const drop=base.y-f.node('Hips').position.y;assert.ok(drop>=-1e-5&&drop<=.08001);assert.ok(Math.abs(drop-previous)<.45/fps,'视觉骨盆不能瞬间弹落');previous=drop;}
      drops.push(base.y-f.node('Hips').position.y);ground=.1;
      assert.ok(drops.at(-1)!>.005,'必须真实触发骨盆补偿，不能用全零轨迹通过');
      for(let tick=0;tick<fps*2;tick++){f.node('Hips').position.copyFrom(base);f.pose();ik.update({...frame,dt:1/fps});}
      assert.ok(Math.abs(base.y-f.node('Hips').position.y)<.001,'平地待机应回收额外偏移');
    }finally{ik.dispose();f.dispose();}
  }
  assert.ok(Math.max(...drops)-Math.min(...drops)<.002,'不同帧率骨盆应落在同一时间轨迹');
});

test('移动转向保留仍可达的支撑脚，持续鞋底贴地而非同时清除两锁',async()=>{
  const f=await fixture(1,0,false),ground=.1;
  const ik=new ManualRoamFootIK(f.container,{probeGround:()=>({height:ground,normal:Vector3.Up()})});
  try {
    ik.update(frame);assert.equal(ik.getDebugState().left.locked,true);const before=ik.getDebugState();
    f.pose();f.root.position.x+=.02;f.root.rotationQuaternion=Quaternion.RotationAxis(Vector3.Up(),.12);
    ik.update({...frame,speed:1.6,turning:true});
    const after=ik.getDebugState();assert.ok(Object.values(after).some(foot=>foot.locked),'正常转向必须保留实际支撑');for(const side of ['left','right'] as const)if(after[side].locked)assert.equal(after[side].lockId,before[side].lockId);
    f.container.skeletons.forEach(s=>s.prepare(true));
    let minimum=Infinity;
    for(const mesh of f.container.meshes){const p=mesh.getPositionData(true);if(!p)continue;for(const i of new Set(mesh.getIndices()??[]))minimum=Math.min(minimum,Vector3.TransformCoordinates(Vector3.FromArray(p,i*3),mesh.computeWorldMatrix(true)).y);}
    assert.ok(Math.abs(minimum-ground)<.006,`急转不能因旧锚点拉低骨盆而穿地：${minimum}`);
    f.pose();ik.update({...frame,speed:1.6});assert.equal(ik.getDebugState().left.locked,true);
  }finally{ik.dispose();f.dispose();}
});

test('真实Walking源低接触权重也阻止脚掌穿地，空中摆脚不锁水平落点', async () => {
  const f=await fixture(1,0,false),ground=0.1;
  const ik=new ManualRoamFootIK(f.container,{probeGround:()=>({height:ground,normal:Vector3.Up()})});
  try {
    const bytes=await readFile('public/manual-roam/locomotion-v2.glb'),size=bytes.readUInt32LE(12),j=JSON.parse(bytes.subarray(20,20+size).toString()),bin=bytes.subarray(28+size);
    const clip=j.animations.find((a:{name:string})=>a.name==='WalkForward');
    let worst=0;
    for(let tick=0;tick<30;tick++){
      for(const channel of clip.channels){const accessor=j.accessors[clip.samplers[channel.sampler].output],view=j.bufferViews[accessor.bufferView],width=channel.target.path==='rotation'?4:3,at=(view.byteOffset??0)+(accessor.byteOffset??0)+Math.min(tick,accessor.count-1)*width*4,values=Array.from({length:width},(_,i)=>bin.readFloatLE(at+i*4));const target=f.node(j.nodes[channel.target.node].name);if(width===4)target.rotationQuaternion=Quaternion.FromArray(values);else target.position.copyFromFloats(values[0],values[1],values[2]);}
      f.container.transformNodes.forEach(node=>node.computeWorldMatrix(true));
      ik.update({...frame,speed:1,strideScale:1.15,footContacts:{left:tick%2?0:0.25,right:tick%2?0.25:0}});
      f.container.skeletons.forEach(skeleton=>skeleton.prepare(true));
      for(const mesh of f.container.meshes){const p=mesh.getPositionData(true);if(!p)continue;const world=mesh.computeWorldMatrix(true);for(const i of new Set(mesh.getIndices()??[]))worst=Math.max(worst,ground-Vector3.TransformCoordinates(Vector3.FromArray(p,i*3),world).y);}
      assert.equal(ik.getDebugState().left.locked,false);assert.equal(ik.getDebugState().right.locked,false);
    }
    assert.ok(worst<0.006,`低contact Walk真实鞋穿地 ${worst}m`);
  } finally{ik.dispose();f.dispose();}
});

test('真实鞋CPU蒙皮最低点贴地且移动时保留源脚掌pitch而非强制压平', async () => {
  const f = await fixture(1,0.3,false),ground=0.1;
  const ik=new ManualRoamFootIK(f.container,{probeGround:()=>({height:ground,normal:Vector3.Up()})});
  try {
    ik.update(frame);
    f.container.skeletons.forEach(skeleton=>skeleton.prepare(true));
    let minimum=Infinity;
    for(const mesh of f.container.meshes){const positions=mesh.getPositionData(true);if(!positions)continue;const world=mesh.computeWorldMatrix(true);for(const i of new Set(mesh.getIndices()??[]))minimum=Math.min(minimum,Vector3.TransformCoordinates(Vector3.FromArray(positions,i*3),world).y);}
    assert.ok(Math.abs(minimum-ground)<0.004,`实际鞋底高度 ${minimum}，地面 ${ground}`);
    console.log(`Calibrated CPU sole floor error: ${minimum-ground}m`);
    ik.reset();f.pose();f.node('LeftFoot').rotationQuaternion=Quaternion.RotationAxis(Vector3.Right(),0.35);
    const before=Vector3.TransformNormal(Vector3.Up(),f.node('LeftFoot').computeWorldMatrix(true)).normalize();
    ik.update({...frame,speed:1});
    const after=Vector3.TransformNormal(Vector3.Up(),f.node('LeftFoot').computeWorldMatrix(true)).normalize();
    assert.equal(ik.getDebugState().left.reason,'solved');
    assert.ok(Vector3.Dot(before,after)>0.9999,'平地行走脚掌的原始pitch/roll必须保留');
    // 快速抬起前掌进入蹬离时解除水平锁；最低点切换仍不能横跳一只鞋长。
    const ankle=f.node('LeftFoot').getAbsolutePosition().clone();
    f.pose();f.node('LeftFoot').rotationQuaternion=Quaternion.RotationAxis(Vector3.Right(),-0.45);
    ik.update({...frame,speed:1});
    assert.equal(ik.getDebugState().left.locked,false);
    assert.equal(ik.getDebugState().left.phase,'ToeOff');
    assert.ok(Vector3.Distance(ankle,f.node('LeftFoot').getAbsolutePosition())<0.15);
  } finally {ik.dispose();f.dispose();}
});

test('真实v2骨架在glTF根镜像、额外镜像、旋转和缩放后即时命中world足部目标并保持前屈膝', async () => {
  for (const [scale,yaw,mirror] of [[1,0,false],[1.35,0.73,false],[0.8,-1.1,true]] as const) {
    const f = await fixture(scale,yaw,mirror);
    const height = f.node('LeftFoot').getAbsolutePosition().y - 0.065 * scale + 0.035;
    const ik = new ManualRoamFootIK(f.container, { probeGround: (x,z) => ({ point: new Vector3(x,height,z), normal: Vector3.Up() }) });
    try {
      ik.update(frame);
      const debug = ik.getDebugState();
      console.log(`IK world target errors scale=${scale}, yaw=${yaw}, mirror=${mirror}: left=${debug.left.targetError}, right=${debug.right.targetError}`);
      for (const side of ['left','right'] as const) {
        const foot = debug[side];
        assert.equal(foot.locked, true);
        assert.ok(foot.targetError < 0.001, `${scale}/${yaw}/${mirror}/${side}: ${foot.targetError}`);
        assert.ok(foot.kneeForward > 0, '膝盖必须向人体前方弯曲');
        assert.ok(foot.normalAlignment > 0.999);
      }
      assert.deepEqual(f.root.position.asArray(), [2,0.1,-3], 'IK不得移动人物根或碰撞位置');
    } finally { ik.dispose(); f.dispose(); }
  }
});

test('支撑脚锁定世界点，坡面贴合法线；空中飞行瞬移、地面缺失与不可达目标释放锁', async () => {
  const f = await fixture(1.2,0.45,false);
  const initial = f.node('LeftFoot').getAbsolutePosition().clone();
  let normal = new Vector3(0.12,1,0.08).normalize();
  let height: number | null = initial.y - 0.065 * 1.2 + 0.04;
  // 斜面高度必须随射线XZ变化，与返回法线描述同一平面。
  const ik = new ManualRoamFootIK(f.container, { probeGround: (x,z) => height === null ? null : ({ height:height-(normal.x*(x-initial.x)+normal.z*(z-initial.z))/normal.y, normal }) });
  try {
    ik.update(frame); const first=ik.getDebugState().left;assert.ok(first.locked,JSON.stringify(first));const target = first.lockPoint!;
    f.root.position.x += 0.035; f.pose(); ik.update(frame);
    assert.ok(ik.getDebugState().left.locked,JSON.stringify({first,after:ik.getDebugState().left}));
    assert.ok(Vector3.Distance(ik.getDebugState().left.lockPoint!,target) < 1e-6);
    assert.ok(ik.getDebugState().left.targetError < 0.001);
    assert.ok(ik.getDebugState().left.normalAlignment > 0.999);
    for (const flags of [{ grounded:false },{ fly:true },{ teleported:true }]) {
      f.pose(); ik.update({ ...frame,...flags }); assert.equal(ik.getDebugState().left.locked,false);
      f.pose(); ik.update(frame);
    }
    height=null; f.pose(); ik.update(frame); assert.equal(ik.getDebugState().left.locked,false);
    height=initial.y-0.065*1.2-0.16; f.pose(); ik.update(frame);
    assert.equal(ik.getDebugState().left.reason,'unreachable');
    height=initial.y-0.065*1.2+0.04; normal=new Vector3(1,0.1,0).normalize(); f.pose(); ik.update(frame);
    assert.equal(ik.getDebugState().left.reason,'slope-limit');
    normal=Vector3.Up(); f.pose(); ik.update(frame); ik.update({...frame,footContacts:{left:0,right:0}});
    assert.equal(ik.getDebugState().left.reason,'swing');
    height=initial.y+1; f.pose(); ik.update(frame); assert.equal(ik.getDebugState().left.locked,false);
    assert.equal(ik.getDebugState().left.reason,'correction-limit');
    ik.dispose(); ik.update(frame); assert.equal(ik.getDebugState().left.locked,false);
  } finally { ik.dispose(); f.dispose(); }
});
