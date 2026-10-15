import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Matrix, Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { createKaykitSampler } from './manual-roam-assets/kaykitMotion.mjs';
import { TURN_MOTION_DEFINITIONS, sampleTurnPose } from './manual-roam-assets/turnMotion.mjs';
import { getManualRoamSkinCandidates } from './manual-roam-assets/skinWeights.mjs';
import { calibrateFootCycle } from './manual-roam-assets/contactCalibration.mjs';
import { COMMUTE_WALK, commuteWalkCalibration, createCommuteWalkSampler } from './manual-roam-assets/commuteWalk.mjs';

// 确定性离线资产构建：不访问网络，不覆盖原人物，输入源必须匹配固定指纹。
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const profile = { profile: 'mixamo-humanoid-v2', version: 2 };
const names = ['Hips','Spine','Spine1','Spine2','Neck','Head',...['Left','Right'].flatMap(s => ['Shoulder','Arm','ForeArm','Hand','UpLeg','Leg','Foot','ToeBase'].map(p => s+p))];
const parentNames = [null,'Hips','Spine','Spine1','Spine2','Neck',...['Left','Right'].flatMap(s => ['Spine2',s+'Shoulder',s+'Arm',s+'ForeArm','Hips',s+'UpLeg',s+'Leg',s+'Foot'])];
const hash = b => createHash('sha256').update(b).digest('hex');
const v = a => Vector3.FromArray(a);
const identity = () => Quaternion.Identity();
const rotation = (axis, angle) => Quaternion.RotationAxis(v(axis), angle);
const compose = n => n.matrix ? Matrix.FromArray(n.matrix) : Matrix.Compose(v(n.scale ?? [1,1,1]), Quaternion.FromArray(n.rotation ?? [0,0,0,1]), v(n.translation ?? [0,0,0]));
const qOf = m => { const q = identity(); m.decompose(undefined, q); return q.normalize(); };
function parseGlb(bytes) {
  if (bytes.toString('ascii',0,4) !== 'glTF' || bytes.readUInt32LE(4) !== 2 || bytes.readUInt32LE(8) !== bytes.length) throw new Error('输入不是完整 GLB 2');
  const size = bytes.readUInt32LE(12);
  return { json: JSON.parse(bytes.subarray(20,20+size)), binary: bytes.subarray(28+size), bytes };
}
function read(a, id) {
  const x = a.json.accessors[id], view = a.json.bufferViews[x.bufferView];
  const width = {SCALAR:1,VEC2:2,VEC3:3,VEC4:4,MAT4:16}[x.type];
  const size = {5121:1,5123:2,5125:4,5126:4}[x.componentType];
  return Array.from({length:x.count*width}, (_, i) => {
    const offset = (view.byteOffset??0)+(x.byteOffset??0)+Math.floor(i/width)*(view.byteStride??width*size)+i%width*size;
    return x.componentType===5126 ? a.binary.readFloatLE(offset) : a.binary.readUIntLE(offset,size);
  });
}
function writer(json = {asset:{version:'2.0'},accessors:[],bufferViews:[]}, binary=Buffer.alloc(0)) {
  const chunks = [binary]; let length=binary.length;
  return { json, append(values,type,componentType=5126) {
    const pad=(4-length%4)%4; if(pad){chunks.push(Buffer.alloc(pad));length+=pad;}
    const size=componentType===5123?2:4, b=Buffer.alloc(values.length*size);
    values.forEach((x,i)=>componentType===5123?b.writeUInt16LE(x,i*size):b.writeFloatLE(x,i*size));
    const bufferView=json.bufferViews.push({buffer:0,byteOffset:length,byteLength:b.length})-1;
    chunks.push(b);length+=b.length;
    const width={SCALAR:1,VEC2:2,VEC3:3,VEC4:4,MAT4:16}[type];
    const accessor={bufferView,componentType,count:values.length/width,type};
    if(type==='SCALAR'||type==='VEC3') {
      accessor.min=Array.from({length:width},(_,k)=>values.filter((_,i)=>i%width===k).reduce((a,b)=>Math.min(a,b),Infinity));
      accessor.max=Array.from({length:width},(_,k)=>values.filter((_,i)=>i%width===k).reduce((a,b)=>Math.max(a,b),-Infinity));
    }
    return json.accessors.push(accessor)-1;
  }, bytes() {
    json.buffers=[{byteLength:length}];json.asset.generator='manual-roam offline asset pipeline v1';
    const raw=Buffer.from(JSON.stringify(json)), j=Buffer.concat([raw,Buffer.alloc((4-raw.length%4)%4,32)]);
    const data=Buffer.concat([...chunks,Buffer.alloc((4-length%4)%4)]), out=Buffer.alloc(28+j.length+data.length);
    out.write('glTF');out.writeUInt32LE(2,4);out.writeUInt32LE(out.length,8);out.writeUInt32LE(j.length,12);out.write('JSON',16);j.copy(out,20);
    out.writeUInt32LE(data.length,20+j.length);out.writeUInt32LE(0x004e4942,24+j.length);data.copy(out,28+j.length);return out;
  }};
}
function worldMatrices(json, overrides=new Map()) {
  const out=[];
  const visit=(i,p)=>{const n={...json.nodes[i],...overrides.get(i)},m=compose(n).multiply(p);out[i]=m;for(const c of n.children??[])visit(c,m);};
  for(const i of json.scenes[json.scene??0].nodes)visit(i,Matrix.Identity());return out;
}
function skeletonNodes(points) {
  const nodes=[{name:'ManualRoamRig',extras:{manualRoamRig:profile},children:[1]}];
  names.forEach((name,i)=>{const parent=parentNames[i]===null?null:names.indexOf(parentNames[i]);nodes.push({name,translation:(parent===null?points[i]:points[i].subtract(points[parent])).asArray(),rotation:[0,0,0,1],children:[]});});
  parentNames.forEach((p,i)=>{if(p!==null)nodes[names.indexOf(p)+1].children.push(i+1);});return nodes;
}
function segmentDistance(p,a,b) {const d=b.subtract(a),t=Math.max(0,Math.min(1,Vector3.Dot(p.subtract(a),d)/d.lengthSquared()));return Vector3.Distance(p,a.add(d.scale(t)));}
function fromTo(from,to) {
  const a=from.normalizeToNew(),b=to.normalizeToNew(),dot=Vector3.Dot(a,b);
  if(dot>0.999999)return identity();if(dot < -0.999999)return rotation([0,0,1],Math.PI);
  const c=Vector3.Cross(a,b);return new Quaternion(c.x,c.y,c.z,1+dot).normalize();
}
function buildCharacter(original) {
  const json=structuredClone(original.json), worlds=worldMatrices(json), origin=worlds[json.scenes[0].nodes[0]].getTranslation();
  const source=names.map(name=>worlds[json.nodes.findIndex(n=>n.name==='Character1_'+name)].getTranslation().subtract(origin));
  const point=Object.fromEntries(names.map((n,i)=>[n,source[i].clone()]));
  for(const n of ['Hips','Spine','Spine1','Spine2','Neck','Head'])point[n]=new Vector3(0,point[n].y,0);
  for(const side of ['Left','Right']){
    const sign=side==='Left'?1:-1;
    point[side+'Shoulder']=new Vector3(sign*Math.abs(point[side+'Shoulder'].x),point[side+'Shoulder'].y,0);
    let previous=side+'Shoulder';
    for(const part of ['Arm','ForeArm','Hand']){const name=side+part;point[name]=point[previous].add(new Vector3(sign*Vector3.Distance(source[names.indexOf(previous)],source[names.indexOf(name)]),0,0));previous=name;}
    point[side+'UpLeg']=new Vector3(sign*Math.abs(point[side+'UpLeg'].x),point[side+'UpLeg'].y,0);
    previous=side+'UpLeg';for(const part of ['Leg','Foot']){const name=side+part;point[name]=point[previous].add(new Vector3(0,-Vector3.Distance(source[names.indexOf(previous)],source[names.indexOf(name)]),0));previous=name;}
    const toeLength=Vector3.Distance(source[names.indexOf(side+'ToeBase')],source[names.indexOf(side+'Foot')]);
    point[side+'ToeBase']=point[side+'Foot'].add(new Vector3(0,0,toeLength));
  }
  const rest=names.map(n=>point[n]);
  const endpoint=(i,points)=>{
    const name=names[i];let child=parentNames.indexOf(name);
    if(name==='Hips')child=1;if(name==='Spine2')child=4;
    if(child>=0)return points[child];
    const direction=points[i].subtract(points[names.indexOf(parentNames[i])]).normalize();
    return points[i].add(direction.scale(name.endsWith('Hand')?0.12:name==='Head'?0.15:0.07));
  };
  // bind 是模型原本的真实姿态；reference 是动画对齐姿态。只旋转骨架的坐标系，不重塑原网格。
  const bindRotations=source.map((p,i)=>fromTo(endpoint(i,rest).subtract(rest[i]),endpoint(i,source).subtract(p)));
  const positions=read(original,0);
  const vertices=Array.from({length:positions.length/3},(_,i)=>v(positions.slice(i*3,i*3+3)).scale(100));
  const materials=new Map();json.meshes[0].primitives.forEach(p=>read(original,p.indices).forEach(i=>materials.set(i,p.material)));
  const parents=vertices.map((_,i)=>i),find=i=>parents[i]===i?i:(parents[i]=find(parents[i]));
  const cells=new Map(),seamRadius=0.012;
  // 原模型衣物相接处并非重合顶点；共享近邻接缝组的权重，防止恢复姿态时把原覆盖关系撕开。
  vertices.forEach((p,i)=>{
    const cell=p.asArray().map(x=>Math.floor(x/seamRadius));
    for(let x=-1;x<=1;x++)for(let y=-1;y<=1;y++)for(let z=-1;z<=1;z++){
      for(const j of cells.get([cell[0]+x,cell[1]+y,cell[2]+z].join(','))??[]){
        if(materials.get(i)!==materials.get(j)&&Vector3.Distance(p,vertices[j])<=seamRadius)parents[find(i)]=find(j);
      }
    }
    const key=cell.join(','),bucket=cells.get(key)??[];bucket.push(i);cells.set(key,bucket);
  });
  const groupedWeights=new Map();
  vertices.forEach((p,i)=>{
    const trousers=materials.get(i)===5,side=p.x>=0?'Left':'Right';
    // 裤腿只受骨盆与对应腿链驱动；排除附近手掌、另一条腿等无解剖关联的影响。
    const candidates=trousers?names.map((name,index)=>({name,index,factor:1})).filter(({name})=>name==='Hips'||name==='Spine'||(name.startsWith(side)&&/UpLeg|Leg|Foot|ToeBase/.test(name))):getManualRoamSkinCandidates(p,materials.get(i),names,source);
    const ranked=candidates.map(({index,factor})=>({index,raw:factor/(segmentDistance(p,source[index],endpoint(index,source))+0.015)**(trousers?6:4)})).sort((a,b)=>b.raw-a.raw).slice(0,4);
    const raw=ranked.map(item=>item.raw),total=raw.reduce((a,b)=>a+b,0),key=find(i);
    const group=groupedWeights.get(key)??Array(names.length).fill(0);
    ranked.forEach((item,k)=>{group[item.index]+=raw[k]/total;});groupedWeights.set(key,group);
  });
  const influences=new Map([...groupedWeights].map(([key,group])=>{
    const ranked=group.map((weight,index)=>({index,weight})).sort((a,b)=>b.weight-a.weight).slice(0,4),total=ranked.reduce((sum,item)=>sum+item.weight,0);
    return[key,ranked.map(item=>({...item,weight:item.weight/total}))];
  }));
  const output=vertices.flatMap(p=>p.asArray()),joints=[],weights=[];
  for(let i=0;i<positions.length/3;i++){
    const ranked=influences.get(find(i));
    for(let k=0;k<4;k++){
      const item=ranked[k],weight=item?.weight??0,index=item?.index??0;joints.push(index);weights.push(weight);
    }
  }
  const minY=output.filter((_,i)=>i%3===1).reduce((a,b)=>Math.min(a,b),Infinity);
  output.forEach((_,i)=>{if(i%3===1)output[i]-=minY;});rest.forEach(p=>p.y-=minY);source.forEach(p=>p.y-=minY);
  const bindWorlds=source.map((p,i)=>Matrix.Compose(Vector3.One(),bindRotations[i],p));
  // 鞋网格仍按真实绑定姿态蒙皮，而参考骨架是直腿、脚骨水平：在参考姿态下对鞋做CPU蒙皮，测出鞋底相对脚骨的俯仰（原模型为走路姿态，脚尖上翘），
  // 以绕踝部的反向旋转放平；再整体抬高参考骨架，使放平后的鞋底最低点落在地面。补偿量由实测标定，不依赖绑定旋转。
  const shoeMaterial=json.materials.findIndex(m=>m.name==='Ren_Xie_M');
  if(shoeMaterial<0)throw new Error('原人物缺少鞋材质，无法标定脚底');
  const inverseBind=bindWorlds.map(matrix=>Matrix.Invert(matrix)),shoePoints={Left:[],Right:[]};
  for(let i=0;i<output.length/3;i++){
    if(materials.get(i)!==shoeMaterial)continue;
    const p=new Vector3(output[i*3],output[i*3+1],output[i*3+2]),skinned=Vector3.Zero();
    for(let k=0;k<4;k++){const weight=weights[i*4+k];if(weight>0)skinned.addInPlace(Vector3.TransformCoordinates(p,inverseBind[joints[i*4+k]]).add(rest[joints[i*4+k]]).scale(weight));}
    shoePoints[skinned.x>=0?'Left':'Right'].push(skinned);
  }
  const flatten=(points,ankle)=>{
    let pitch=0,rotated=points;
    for(let iteration=0;iteration<6;iteration++){
      const c=Math.cos(pitch),sn=Math.sin(pitch);
      rotated=points.map(p=>{const d=p.subtract(ankle);return new Vector3(d.x,d.y*c-d.z*sn,d.y*sn+d.z*c).add(ankle);});
      const zMin=Math.min(...rotated.map(p=>p.z)),zMax=Math.max(...rotated.map(p=>p.z)),low=group=>group.reduce((a,b)=>b.y<a.y?b:a);
      const heel=low(rotated.filter(p=>p.z<=zMin+.25*(zMax-zMin))),toe=low(rotated.filter(p=>p.z>=zMax-.25*(zMax-zMin)));
      const error=Math.atan2(toe.y-heel.y,toe.z-heel.z);
      if(Math.abs(error)<1e-5)break;
      pitch+=error;
    }
    return {pitch,floor:Math.min(...rotated.map(p=>p.y)),points:rotated};
  };
  const soles=Object.fromEntries(['Left','Right'].map(side=>[side,flatten(shoePoints[side],rest[names.indexOf(side+'Foot')])]));
  // 少抬6毫米：直腿鞋底刚好踩地时目标踝高正好等于腿长上限，足部IK会判不可达而放弃；留出余量，由IK以不足1度的屈膝补回。
  const ankleLift=-Math.min(soles.Left.floor,soles.Right.floor)-.006;
  rest.forEach(p=>{p.y+=ankleLift;});
  const footPitch={Left:soles.Left.pitch,Right:soles.Right.pitch};
  // 放平鞋底后相对踝部的脚跟、前掌（趾关节）、鞋尖与鞋底高度，供原创步行计算滚动支点；左右取平均保持对称。
  const footGeometry=['Left','Right'].map(side=>{const ankle=rest[names.indexOf(side+'Foot')],points=soles[side].points;
    return {heelZ:Math.min(...points.map(p=>p.z))-ankle.z,toeZ:Math.max(...points.map(p=>p.z))-ankle.z,ballZ:Vector3.Distance(rest[names.indexOf(side+'ToeBase')],ankle)*Math.cos(soles[side].pitch),soleY:soles[side].floor-ankle.y};})
    .reduce((a,b)=>Object.fromEntries(Object.keys(a).map(k=>[k,(a[k]+b[k])/2])));
  json.nodes=skeletonNodes(rest);
  names.forEach((name,i)=>{
    const node=json.nodes[i+1];
    node.extras={manualRoamReferencePose:{translation:[...node.translation],rotation:[0,0,0,1],scale:[1,1,1]}};
    const parent=parentNames[i]===null?-1:names.indexOf(parentNames[i]);
    const local=parent<0?bindWorlds[i]:bindWorlds[i].multiply(Matrix.Invert(bindWorlds[parent]));
    const position=Vector3.Zero(),quaternion=identity(),scale=Vector3.One();
    if(!local.decompose(scale,quaternion,position))throw new Error(`无法分解人物bind变换：${name}`);
    node.translation=position.asArray();node.rotation=quaternion.normalize().asArray();
  });
  json.nodes.push({name:'Ren',mesh:0,skin:0});json.nodes[0].children.push(json.nodes.length-1);json.scenes=[{nodes:[0]}];json.scene=0;delete json.animations;
  const w=writer(json,original.binary),pos=w.append(output,'VEC3'),joint=w.append(joints,'VEC4',5123),weight=w.append(weights,'VEC4');
  json.meshes[0].primitives.forEach(p=>Object.assign(p.attributes,{POSITION:pos,JOINTS_0:joint,WEIGHTS_0:weight}));
  json.skins=[{name:profile.profile,skeleton:1,joints:names.map((_,i)=>i+1),inverseBindMatrices:w.append(bindWorlds.flatMap(matrix=>Array.from(Matrix.Invert(matrix).m)),'MAT4')}];
  // 脚骨局部的鞋底自然朝上方向：运行时IK以它为贴地基准，而不是把脚骨压平（压平会让翘起的鞋底再次离地）。
  for(const side of ['Left','Right']){
    const node=json.nodes[names.indexOf(side+'Foot')+1];
    node.extras={...node.extras,manualRoamSoleUp:[0,Math.cos(footPitch[side]),-Math.sin(footPitch[side])]};
  }
  return {bytes:w.bytes(),rest,footPitch,footGeometry};
}
function sample(a, sampler, time, rotationTrack) {
  const times=read(a,sampler.input),values=read(a,sampler.output),width=rotationTrack?4:3;
  let i=0;while(i<times.length-2&&times[i+1]<time)i++;
  const t=Math.max(0,Math.min(1,(time-times[i])/Math.max(1e-8,times[i+1]-times[i])));
  const start=values.slice(i*width,(i+1)*width),end=values.slice((i+1)*width,(i+2)*width);
  return rotationTrack?Quaternion.Slerp(Quaternion.FromArray(start),Quaternion.FromArray(end),t).normalize().asArray():start.map((x,k)=>x+(end[k]-x)*t);
}
function createXbotSampler(source) {
  const rest=worldMatrices(source.json), indices=names.map(name=>source.json.nodes.findIndex(n=>n.name==='mixamorig:'+name));
  if(indices.some(i=>i<0))throw new Error('Xbot 缺少标准关节');
  return (clipName,t)=>{
    const clip=source.json.animations.find(a=>a.name===clipName),overrides=new Map();
    for(const channel of clip.channels){const o=overrides.get(channel.target.node)??{};o[channel.target.path]=sample(source,clip.samplers[channel.sampler],t,channel.target.path==='rotation');overrides.set(channel.target.node,o);}
    const worlds=worldMatrices(source.json,overrides);
    const global=indices.map(index=>qOf(worlds[index]).multiply(qOf(rest[index]).conjugate()).normalize());
    const local=global.map((q,i)=>parentNames[i]===null?q:global[names.indexOf(parentNames[i])].conjugate().multiply(q).normalize());
    const hipY=worlds[indices[0]].getTranslation().y-rest[indices[0]].getTranslation().y;
    return {local,hipY};
  };
}
function authoredPose(name,t,duration) {
  const q=names.map(identity),set=(n,x,y=0,z=0)=>{q[names.indexOf(n)]=Quaternion.RotationYawPitchRoll(y,x,z);};
  const ease=x=>x*x*(3-2*x),fraction=ease(t/duration),wave=Math.sin(t/duration*Math.PI*2);
  // 原创离线关键帧姿态。上身朝向保持不变，位移由漫游控制器负责。
  let crouch=0,raise=0;
  if(name==='JumpStart'){crouch=0.6*Math.sin(fraction*Math.PI);raise=fraction*0.5;}
  if(name==='JumpUp'){crouch=0.3+0.12*wave;raise=0.5+0.2*fraction;}
  if(name==='Fall'){crouch=0.12+0.03*wave;raise=0.4+0.04*wave;}
  if(name==='Land'){crouch=0.65*Math.sin(fraction*Math.PI);raise=0.25*(1-fraction);}
  const flying=name.startsWith('Fly');
  set('Spine',flying?0.12+0.015*wave:crouch*0.22);
  for(const side of ['Left','Right']){
    const sign=side==='Left'?1:-1;
    set(side+'Arm',-raise*0.8,0,sign*(flying?(name==='FlyMove'?-0.7:-0.9):-1.35+raise*0.7));
    set(side+'ForeArm',flying?-0.25-0.03*wave:-0.15-raise*0.5);
    set(side+'UpLeg',flying?0.2+0.04*wave:-crouch);
    set(side+'Leg',flying?0.45+0.06*wave:crouch*1.8);
    set(side+'Foot',flying?-0.2:-crouch*0.8);
  }
  return {local:q,hipY:flying?0.015*wave:-crouch*0.08};
}
function relaxedIdlePose(t,duration) {
  const local=names.map(identity),wave=Math.sin(t/duration*Math.PI*2);
  const set=(name,q)=>{local[names.indexOf(name)]=q;};
  // 巡检待机采用对称窄站距和轻微呼吸，不继承演示角色的偏胯站姿。
  set('Spine',rotation([1,0,0],.004*wave));
  set('Neck',rotation([1,0,0],-.004*wave));
  for(const side of ['Left','Right']) {
    const sign=side==='Left'?1:-1;
    set(side+'Arm',rotation([0,0,1],-sign*1.40));
    set(side+'ForeArm',rotation([0,1,0],-sign*.16));
    set(side+'UpLeg',Quaternion.RotationYawPitchRoll(0,-.035,sign*.035));
    set(side+'Leg',rotation([1,0,0],.07));
    set(side+'Foot',rotation([1,0,0],-.035));
  }
  return {local,hipY:-.003+.001*wave};
}
/** 在脚骨局部先绕踝部放平鞋底，再叠加动作旋转；脚骨与趾骨的屈伸同为X轴，趾骨无需反向补偿。 */
function flattenFeet(local,footPitch){
  for(const side of ['Left','Right']){const i=names.indexOf(side+'Foot');local[i]=rotation([1,0,0],footPitch[side]).multiply(local[i]).normalize();}
}

/** 源动作的肩肘在无指骨人物上会把前臂抬起过高；向放松站姿收敛一半，保留摆臂方向但压低肘部屈曲。 */
function calmArms(local,reference,factor=.5){for(const side of ['Left','Right'])for(const part of ['Arm','ForeArm']){const i=names.indexOf(side+part);local[i]=Quaternion.Slerp(reference[i],local[i],factor).normalize();}}

function calibrateStride(name,rest,tracks,hips,times) {
  const direction=name.endsWith('Backward')?new Vector3(0,0,-1):name.endsWith('Left')?new Vector3(1,0,0):name.endsWith('Right')?new Vector3(-1,0,0):new Vector3(0,0,1);
  const feet={Left:[],Right:[]},toes={Left:[],Right:[]};
  for(let frame=0;frame<times.length;frame++) {
    const worlds=[];
    names.forEach((bone,i)=>{
      const parent=parentNames[i]===null?-1:names.indexOf(parentNames[i]);
      const translation=parent<0?v(hips.slice(frame*3,frame*3+3)):rest[i].subtract(rest[parent]);
      const matrix=Matrix.Compose(Vector3.One(),Quaternion.FromArray(tracks[i].slice(frame*4,frame*4+4)),translation);
      worlds[i]=parent<0?matrix:matrix.multiply(worlds[parent]);
    });
    for(const side of ['Left','Right']){feet[side].push(worlds[names.indexOf(side+'Foot')].getTranslation());toes[side].push(worlds[names.indexOf(side+'ToeBase')].getTranslation());}
  }
  return calibrateFootCycle({name,times,leftFoot:feet.Left,rightFoot:feet.Right,leftToe:toes.Left,rightToe:toes.Right,direction});
}
function buildAnimation(source,rest,footPitch,footGeometry,sourceInfo,kaykit,kaykitInfo) {
  const w=writer(),json=w.json;json.nodes=skeletonNodes(rest);json.scenes=[{nodes:[0]}];json.scene=0;json.animations=[];
  const fromXbot=createXbotSampler(source),fromKaykit=createKaykitSampler(kaykit,names,parentNames,rest,read,worldMatrices,sample);
  const commuteWalk=createCommuteWalkSampler(rest,names,parentNames,footGeometry,footPitch);
  const manifest={version:2,profile:profile.profile,clips:{},files:{},sources:[sourceInfo,kaykitInfo]};
  const configs=[['Idle','idle',2.5,0],...['Walk','Run'].flatMap((kind,i)=>['Forward','Backward','Left','Right'].map(dir=>[kind+dir,i?'run':'walk',i?0.7:29/30,i?3.2:1.6])),...['JumpStart','JumpUp','Fall','Land','FlyIdle','FlyMove'].map(n=>[n,null,{JumpStart:0.3,JumpUp:0.45,Fall:0.8,Land:0.3,FlyIdle:2,FlyMove:1.2}[n],0])];
  for(const [name,sourceClip,duration,speed]of configs){
    const direction=/Left|Right|Backward/.test(name);
    const nativeClip=name.endsWith('Backward')?'Walking_Backwards':name.endsWith('Left')?'Running_Strafe_Left':'Running_Strafe_Right';
    const nativeDuration=name.endsWith('Backward')?32/30:.8;
    const clipDuration=name==='WalkForward'?COMMUTE_WALK.duration:direction?(name.startsWith('Walk')&&!name.endsWith('Backward')?1.1:name==='RunBackward'?.75:nativeDuration):duration;
    const count=Math.round(clipDuration*30)+1,times=Array.from({length:count},(_,i)=>clipDuration*i/(count-1)),tracks=names.map(()=>[]),hip=[];
    const loop=!['JumpStart','JumpUp','Land'].includes(name);
    times.forEach((t,frame)=>{
      const pose=name==='Idle'?relaxedIdlePose(t,duration):name==='WalkForward'?commuteWalk(t):direction?fromKaykit(nativeClip,t/clipDuration*nativeDuration):sourceClip?fromXbot(sourceClip,t):authoredPose(name,t,duration);
      if(direction&&name.startsWith('Walk')&&!name.endsWith('Backward')) {
        // 原生侧跑减小屈伸与腾空幅度后重定时为低速侧步，保留膝盖原生屈伸轴。
        for(const side of ['Left','Right'])for(const part of ['Arm','ForeArm','UpLeg','Leg','Foot','ToeBase']) {
          const i=names.indexOf(side+part);pose.local[i]=Quaternion.Slerp(identity(),pose.local[i],.55).normalize();
        }
        pose.hipY*=.55;
      }
      if(name==='WalkBackward') {
        for(const side of ['Left','Right'])for(const part of ['UpLeg','Leg','Foot','ToeBase']) {
          const i=names.indexOf(side+part);pose.local[i]=Quaternion.Slerp(identity(),pose.local[i],.8).normalize();
        }
        pose.hipY*=.8;
      }
      if(name==='RunForward')for(const side of ['Left','Right']) {
        // 原人物没有指骨，保留少量腕部变化，避免源角色的腕部动作被放大为折腕。
        const i=names.indexOf(side+'Hand');pose.local[i]=Quaternion.Slerp(identity(),pose.local[i],.2).normalize();
      }
      if(name==='RunForward')calmArms(pose.local,relaxedIdlePose(0,2.5).local,.3);
      // 原创步行已在足部轨迹中计入鞋底放平补偿。
      if(name!=='WalkForward')flattenFeet(pose.local,footPitch);
      pose.local.forEach((q,i)=>{
        // 保证循环末帧等于首帧，且四元数符号连续，避免 LINEAR 插值翻转。
        if(loop&&frame===count-1)q=Quaternion.FromArray(tracks[i].slice(0,4));
        const previous=tracks[i].slice(-4);if(previous.length&&Quaternion.Dot(q,Quaternion.FromArray(previous))<0)q=q.scale(-1);
        tracks[i].push(...q.asArray());
      });
      hip.push(rest[0].x,loop&&frame===count-1?hip[1]:rest[0].y+pose.hipY,rest[0].z);
    });
    const calibration=name==='WalkForward'?commuteWalkCalibration(times):/^(Walk|Run)/.test(name)?calibrateStride(name,rest,tracks,hip,times):{};
    if(direction) {
      const family=name.startsWith('Run')?'Run':'Walk',upperDuration=family==='Run'?.7:COMMUTE_WALK.duration;
      const phaseShift=manifest.clips[family+'Forward'].phaseOffset-calibration.phaseOffset;
      times.forEach((t,frame)=>{
        const upperTime=((t/clipDuration+phaseShift+1)%1)*upperDuration,upper=family==='Run'?fromXbot('run',upperTime):commuteWalk(upperTime);
        const nativeHip=Quaternion.FromArray(tracks[0].slice(frame*4,frame*4+4));
        const upperSpine=upper.local[0].multiply(upper.local[names.indexOf('Spine')]).normalize();
        // 上身沿完整脊柱链衔接，并在髋部父坐标中重算；局部手臂不能直接拼到另一套胸腔上。
        upper.local[names.indexOf('Spine')]=nativeHip.conjugate().multiply(upperSpine).normalize();
        if(family==='Run'){for(const side of ['Left','Right']){const i=names.indexOf(side+'Hand');upper.local[i]=Quaternion.Slerp(identity(),upper.local[i],.2).normalize();}calmArms(upper.local,relaxedIdlePose(0,2.5).local,.3);}
        names.forEach((bone,i)=>{
          if(i===0||/UpLeg|Leg|Foot|ToeBase/.test(bone))return;
          let q=upper.local[i];if(frame===times.length-1)q=Quaternion.FromArray(tracks[i].slice(0,4));
          if(frame>0&&Quaternion.Dot(q,Quaternion.FromArray(tracks[i].slice((frame-1)*4,frame*4)))<0)q=q.scale(-1);
          tracks[i].splice(frame*4,4,...q.asArray());
        });
      });
    }
    const input=w.append(times,'SCALAR'),animation={name,samplers:[],channels:[]};
    tracks.forEach((track,i)=>{const sampler=animation.samplers.push({input,output:w.append(track,'VEC4'),interpolation:'LINEAR'})-1;animation.channels.push({sampler,target:{node:i+1,path:'rotation'}});});
    animation.channels.push({sampler:animation.samplers.length,target:{node:1,path:'translation'}});animation.samplers.push({input,output:w.append(hip,'VEC3'),interpolation:'LINEAR'});json.animations.push(animation);
    manifest.clips[name]={name,loop,referenceSpeed:speed,duration:clipDuration,fps:30,...calibration,source:name==='Idle'?{kind:'original-authored-neutral-idle',author:'project manual-roam asset pipeline',description:'Symmetric relaxed standing with subtle breathing; not motion capture'}:name==='WalkForward'?{...COMMUTE_WALK.source,parameters:Object.fromEntries(Object.entries(COMMUTE_WALK).filter(([key])=>key!=='source'))}:direction?{...kaykitInfo,clip:nativeClip,upperBody:name.startsWith('Run')?{...sourceInfo,clip:'run'}:{...COMMUTE_WALK.source,clip:'WalkForward'},derivation:'native-direction-phase-aligned-complete-upper-body'}:sourceClip?{...sourceInfo,clip:sourceClip,derivation:'rest-pose-retarget-in-place-reduced-wrist-motion'}:{kind:'original-authored-keyframes',author:'project manual-roam asset pipeline',description:'Explicit offline skeletal keyframes; not a downloaded Mixamo clip'}};
  }
  for(const [name,definition] of Object.entries(TURN_MOTION_DEFINITIONS)) {
    const count=Math.round(definition.duration*30)+1,times=Array.from({length:count},(_,i)=>definition.duration*i/(count-1));
    const poses=times.map(t=>sampleTurnPose(name,t/definition.duration,rest,names,parentNames));
    poses.forEach(p=>flattenFeet(p.local,footPitch));
    const input=w.append(times,'SCALAR'),animation={name,samplers:[],channels:[]};
    names.forEach((_,i)=>{const sampler=animation.samplers.push({input,output:w.append(poses.flatMap(p=>p.local[i].asArray()),'VEC4'),interpolation:'LINEAR'})-1;animation.channels.push({sampler,target:{node:i+1,path:'rotation'}});});
    animation.channels.push({sampler:animation.samplers.length,target:{node:1,path:'translation'}});
    animation.samplers.push({input,output:w.append(poses.flatMap(p=>[rest[0].x,rest[0].y+p.hipY,rest[0].z]),'VEC3'),interpolation:'LINEAR'});
    json.animations.push(animation);
    manifest.clips[name]={name,loop:false,duration:definition.duration,fps:30,source:definition.source,
      rotationProgress:poses.map(p=>p.rotationProgress),contacts:{left:poses.map(p=>Number(p.contacts.left)),right:poses.map(p=>Number(p.contacts.right))}};
  }
  return {bytes:w.bytes(),manifest};
}
const originalBytes=await fs.readFile(path.join(root,'public/manual-roam/EQ_People.glb'));
if(hash(originalBytes)!=='42499f8bdd191f2a97143a668f705d840e9b9ee3a3a565285d550f89d542f6e6')throw new Error('原人物指纹改变，拒绝无依据重绑');
const sourceBytes=await fs.readFile(path.join(root,'scripts/manual-roam-assets/sources/Xbot.glb'));
const sourceInfo={kind:'BabylonJS-Assets',url:'https://raw.githubusercontent.com/BabylonJS/Assets/c81f5d744fe8d41acfebd89eaeb7008c6f9659e3/meshes/Xbot.glb',sha256:'9ef2790c1321574a3425e8c3e6cfdcb2e077484719621cad3c244d2a7e3cb1ac',license:'CC-BY-4.0',attribution:'BabylonJS Assets contributors'};
if(hash(sourceBytes)!==sourceInfo.sha256)throw new Error('动作来源文件指纹不符');
const kaykitPath='scripts/manual-roam-assets/sources/kaykit-character-animations-1.1/';
const kaykitBytes=await fs.readFile(path.join(root,kaykitPath,'Rig_Medium_MovementAdvanced.glb'));
const kaykitMetadata=JSON.parse(await fs.readFile(path.join(root,kaykitPath,'source.json'),'utf8'));
const kaykitInfo={author:kaykitMetadata.author,kind:'KayKit Character Animations 1.1',url:kaykitMetadata.source,sha256:kaykitMetadata.files[0].sha256,license:kaykitMetadata.license};
if(hash(kaykitBytes)!==kaykitInfo.sha256)throw new Error('KayKit动作来源指纹不符');
const character=buildCharacter(parseGlb(originalBytes)),animation=buildAnimation(parseGlb(sourceBytes),character.rest,character.footPitch,character.footGeometry,sourceInfo,parseGlb(kaykitBytes),kaykitInfo);
const fixture=parseGlb(character.bytes);fixture.json.materials[3].pbrMetallicRoughness.baseColorFactor=[0.15,0.4,0.95,1];
animation.manifest.files={avatar:{path:'manual-roam/EQ_People_rigged_v2.glb',sha256:hash(character.bytes)},animation:{path:'manual-roam/locomotion-v2.glb',sha256:hash(animation.bytes)}};
await fs.mkdir(path.join(root,'tests/fixtures/roam'),{recursive:true});
await fs.writeFile(path.join(root,'public/manual-roam/EQ_People_rigged_v2.glb'),character.bytes);
await fs.writeFile(path.join(root,'public/manual-roam/locomotion-v2.glb'),animation.bytes);
await fs.writeFile(path.join(root,'public/manual-roam/locomotion-v2.manifest.json'),JSON.stringify(animation.manifest,null,2)+'\n');
await fs.writeFile(path.join(root,'tests/fixtures/roam/worker-blue-rigged-v2.glb'),writer(fixture.json,fixture.binary).bytes());
console.log(JSON.stringify({avatarBytes:character.bytes.length,animationBytes:animation.bytes.length,clips:Object.keys(animation.manifest.clips),files:animation.manifest.files},null,2));
