import { Animation } from '@babylonjs/core/Animations/animation.js';
import { AnimationGroup } from '@babylonjs/core/Animations/animationGroup.js';
import { VertexBuffer } from '@babylonjs/core/Buffers/buffer.js';
import { Matrix, Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import type { AssetContainer, TransformNode } from '@babylonjs/core';
import { identifyManualRoamHumanoid, MANUAL_ROAM_HUMANOID_PARENTS } from '../../../electron/shared/manualRoamHumanoid.ts';

export type ManualRoamRigBinding={
  joints:ReadonlyMap<string,TransformNode>;automatic:boolean;facingYaw:number;warnings:readonly string[];legLength:number;
  metadataSource?:'embedded'|'detected';
  /** 仅供加载时世界姿态烘焙使用，包含当前外层变换；对外朝向只使用facingYaw。 */
  referenceYaw?:number;
  /** 校准前实际站姿的脚底上方；inverse bind不一定等于GLTF节点初始姿态。 */
  footReferenceUp?:ReadonlyMap<string,Vector3>;
};
const endpoint:Record<string,string>={Hips:'Spine',Spine:'Spine1',Spine1:'Spine2',Spine2:'Neck',Neck:'Head'};
for(const side of ['Left','Right'])for(const [part,child] of Object.entries({Shoulder:'Arm',Arm:'ForeArm',ForeArm:'Hand',UpLeg:'Leg',Leg:'Foot',Foot:'ToeBase'}))endpoint[side+part]=side+child;

export function humanoidLegLength(nodes:ReadonlyMap<string,TransformNode>):number {
  return ['Left','Right'].reduce((sum,side)=>sum+Vector3.Distance(position(nodes.get(side+'UpLeg')!),position(nodes.get(side+'Leg')!))+Vector3.Distance(position(nodes.get(side+'Leg')!),position(nodes.get(side+'Foot')!)),0)/2;
}
function position(node:TransformNode):Vector3{node.computeWorldMatrix(true);return node.getAbsolutePosition().clone();}
function facing(nodes:ReadonlyMap<string,TransformNode>):number {
  const forward=position(nodes.get('LeftToeBase')!).subtract(position(nodes.get('LeftFoot')!)).add(position(nodes.get('RightToeBase')!).subtract(position(nodes.get('RightFoot')!)));
  const lateral=position(nodes.get('LeftUpLeg')!).subtract(position(nodes.get('RightUpLeg')!));
  const up=position(nodes.get('Head')!).subtract(position(nodes.get('Hips')!));
  if(up.y<up.length()*.8||Math.abs(lateral.y)>lateral.length()*.3||Math.hypot(forward.x,forward.z)<forward.length()*.6)throw new Error('人物参考姿态需为Y向上的直立T/A站姿，且双脚朝向可识别。');
  if(lateral.length()<up.length()*.015||Math.abs(Vector3.Dot(forward.normalize(),lateral.normalize()))>.4)throw new Error('人物左右关节或脚部朝向不符合人形结构。');
  return Math.atan2(forward.x,forward.z);
}

function cachedJointMapping(nodes:readonly TransformNode[],identified:Record<string,number>):Record<string,number>|null {
  const declarations=nodes.map(node=>node.metadata?.gltf?.extras?.manualRoamHumanoid??node.metadata?.manualRoamHumanoid).filter(value=>value!==undefined);
  if(!declarations.length)return null;
  if(declarations.length!==1)throw new Error('人物自动适配缓存metadata重复。');
  const cached=declarations[0];
  if(!cached||cached.version!==1||cached.algorithm!=='humanoid-semantic-v1'||cached.motionProfile!=='mixamo-humanoid-v2'||!cached.joints||typeof cached.joints!=='object'||Object.keys(cached.joints).length!==Object.keys(identified).length)throw new Error('人物自动适配缓存metadata版本或结构无效，请重新导入。');
  const byGltfIndex=new Map<number,number>();
  nodes.forEach((node,index)=>{
    const pointers=node._internalMetadata?.gltf?.pointers;
    if(Array.isArray(pointers))for(const pointer of pointers){const match=typeof pointer==='string'?/^\/nodes\/(\d+)$/.exec(pointer):null;if(match){const gltfIndex=Number(match[1]);if(byGltfIndex.has(gltfIndex)&&byGltfIndex.get(gltfIndex)!==index)throw new Error('人物自动适配缓存节点索引重复。');byGltfIndex.set(gltfIndex,index);}}
  });
  const resolved:Record<string,number>={};
  for(const [name,index] of Object.entries(identified)) {
    const gltfIndex=cached.joints[name];
    if(!Number.isInteger(gltfIndex)||gltfIndex<0||byGltfIndex.get(gltfIndex)!==index)throw new Error(`人物自动适配缓存映射已失效：${name}，请重新导入。`);
    resolved[name]=byGltfIndex.get(gltfIndex)!;
  }
  return resolved;
}

export function identifyRuntimeHumanoid(container:AssetContainer):ManualRoamRigBinding {
  const meshes=container.meshes.filter(mesh=>mesh.getTotalVertices()>0),skeletons=new Set(meshes.map(mesh=>mesh.skeleton));
  if(!meshes.length||skeletons.size!==1||skeletons.has(null))throw new Error('自动适配需要所有人物网格绑定同一有效骨架。');
  const skeleton=meshes[0].skeleton!,linked=new Set(skeleton.bones.map(bone=>bone.getTransformNode()).filter(Boolean));
  const all=[...new Set([...container.transformNodes,...container.meshes])];
  const index=new Map(all.map((node,i)=>[node,i]));
  const candidates=all.map((node,i)=>({index:i,name:linked.has(node)?node.name:'',parent:node.parent?index.get(node.parent as TransformNode)??null:null}));
  const identified=identifyManualRoamHumanoid(candidates),cached=cachedJointMapping(all,identified);
  const joints=new Map(Object.entries(cached??identified).map(([name,i])=>[name,all[i] as TransformNode]));
  for(const bone of skeleton.bones) {
    const node=bone.getTransformNode();
    if(!node)throw new Error(`人物骨骼缺少关联节点：${bone.name}`);
    const q=node.rotationQuaternion??Quaternion.FromEulerVector(node.rotation);
    if(![...node.position.asArray(),...node.scaling.asArray(),...q.asArray()].every(Number.isFinite)||Math.min(...node.scaling.asArray())<=0||Math.abs(node.scaling.x-node.scaling.y)>1e-4||Math.abs(node.scaling.x-node.scaling.z)>1e-4||Math.abs(q.length()-1)>.01)throw new Error(`人物骨骼变换无效或包含非均匀缩放：${node.name}`);
    if(!Array.from(bone.getAbsoluteInverseBindMatrix().m).every(Number.isFinite)||Math.abs(bone.getRestMatrix().determinant())<1e-12)throw new Error(`人物蒙皮绑定矩阵无效：${node.name}`);
  }
  for(const mesh of meshes) {
    const count=mesh.getTotalVertices(),weights=mesh.getVerticesData(VertexBuffer.MatricesWeightsKind),indices=mesh.getVerticesData(VertexBuffer.MatricesIndicesKind);
    const extraWeights=mesh.getVerticesData(VertexBuffer.MatricesWeightsExtraKind),extraIndices=mesh.getVerticesData(VertexBuffer.MatricesIndicesExtraKind);
    const extended=mesh.numBoneInfluencers>4||Boolean(extraWeights)||Boolean(extraIndices);
    if(!weights||!indices||weights.length!==count*4||indices.length!==count*4||mesh.numBoneInfluencers>8||extended&&(!extraWeights||!extraIndices||extraWeights.length!==count*4||extraIndices.length!==count*4))throw new Error(`人物蒙皮权重格式无效：${mesh.name}，当前最多支持8个骨骼影响。`);
    for(let v=0;v<count;v++){
      let sum=0;
      for(let k=0;k<(extended?8:4);k++){
        const i=v*4+k%4,w=(k<4?weights:extraWeights!)[i],joint=(k<4?indices:extraIndices!)[i];
        if(!Number.isFinite(w)||w<0||!Number.isInteger(joint)||joint<0||joint>=skeleton.bones.length)throw new Error(`人物蒙皮权重或索引无效：${mesh.name}`);
        sum+=w;
      }
      if(Math.abs(sum-1)>.01)throw new Error(`人物蒙皮权重未归一化：${mesh.name}`);
    }
  }
  const length=humanoidLegLength(joints);
  if(!Number.isFinite(length)||length<1e-6)throw new Error('人物腿部长度无效。');
  for(const [name,child] of Object.entries(endpoint))if(Vector3.Distance(position(joints.get(name)!),position(joints.get(child)!))<length*.002)throw new Error(`人物关节间距无效：${name}`);
  facing(joints);
  const footReferenceUp=new Map(['LeftFoot','RightFoot'].map(name=>[name,Vector3.TransformNormal(Vector3.Up(),Matrix.Invert(joints.get(name)!.computeWorldMatrix(true))).normalize()]));
  return {joints,automatic:true,facingYaw:0,warnings:[],legLength:length,metadataSource:cached?'embedded':'detected',footReferenceUp};
}

/** 校准动画参考姿态只改变骨骼rest，真实inverse bind和网格权重保持原样。 */
export function prepareHumanoidReference(container:AssetContainer,binding:ManualRoamRigBinding,source:ReadonlyMap<string,TransformNode>):ManualRoamRigBinding {
  const targetYaw=facing(binding.joints),sourceYaw=facing(source),yaw=targetYaw-sourceYaw;
  const assetParent=container.rootNodes[0]?.parent as TransformNode|null;
  const targetForward=new Vector3(Math.sin(targetYaw),0,Math.cos(targetYaw));
  const assetForward=assetParent?Vector3.TransformNormal(targetForward,Matrix.Invert(assetParent.computeWorldMatrix(true))):targetForward;
  // 出生点/漫游朝向由外层节点拥有，不能在自动朝向补偿中抵消它。
  const assetYaw=Math.atan2(assetForward.x,assetForward.z);
  const alignment=Matrix.RotationY(yaw);
  for(const [name,child] of Object.entries(endpoint)) {
    const node=binding.joints.get(name)!,tip=binding.joints.get(child)!;
    const footUp=binding.footReferenceUp?.get(name);
    // 脚踝到脚趾常常斜向下，不代表鞋底法线；直立参考只恢复原鞋底水平，不能套用源人物的脚骨轴。
    const actual=footUp?Vector3.TransformNormal(footUp,node.computeWorldMatrix(true)).normalize():position(tip).subtract(position(node)).normalize();
    const desired=footUp?Vector3.Up():Vector3.TransformNormal(position(source.get(child)!).subtract(position(source.get(name)!)),alignment).normalize();
    const rotation=Quaternion.FromUnitVectorsToRef(actual,desired,new Quaternion());
    const world=node.computeWorldMatrix(true),delta=Matrix.Compose(Vector3.One(),rotation,Vector3.Zero());
    const rotated=world.multiply(delta);
    // 平移不参与参考旋转，局部位置、比例继续由原人物拥有。
    const parentInverse=node.parent?Matrix.Invert((node.parent as TransformNode).computeWorldMatrix(true)):Matrix.Identity();
    const q=Quaternion.Identity();rotated.multiply(parentInverse).decompose(undefined,q);
    node.rotationQuaternion=q.normalize();node.rotation.setAll(0);node.computeWorldMatrix(true);
  }
  for(const skeleton of container.skeletons)for(const bone of skeleton.bones){const node=bone.getTransformNode()!;bone.setRestMatrix(Matrix.Compose(node.scaling,node.rotationQuaternion??Quaternion.FromEulerVector(node.rotation),node.position));}
  return {...binding,facingYaw:sourceYaw-assetYaw,referenceYaw:yaw};
}

type Pose={position:Vector3;scaling:Vector3;rotation:Quaternion};
function pose(node:TransformNode):Pose{return{position:node.position.clone(),scaling:node.scaling.clone(),rotation:node.rotationQuaternion?.clone()??Quaternion.FromEulerVector(node.rotation)};}
function matrix(value:Pose):Matrix{return Matrix.Compose(value.scaling,value.rotation,value.position);}

/** 源动作的Idle承载默认鞋的静态补偿；相对这套中立姿态传递脚掌/脚趾运动，避免把鞋型偏角传给新人物。 */
export function sampleHumanoidFootReference(source:ReadonlyMap<string,TransformNode>,idle:AnimationGroup):ReadonlyMap<string,Matrix> {
  const tracks=new Map(idle.targetedAnimations.map(track=>[`${track.target.name}:${track.animation.targetProperty}`,track.animation]));
  const worlds=new Map<string,Matrix>();
  for(const [name,node] of source){
    const rotation=tracks.get(`${name}:rotationQuaternion`)?.evaluate(idle.from);
    if(!rotation)throw new Error(`Idle中立姿态缺少旋转轨道：${name}`);
    const translation=name==='Hips'?tracks.get(`${name}:position`)?.evaluate(idle.from):node.position;
    if(!translation)throw new Error('Idle中立姿态缺少骨盆位置轨道。');
    const parent=MANUAL_ROAM_HUMANOID_PARENTS[name];
    worlds.set(name,Matrix.Compose(node.scaling,rotation,translation).multiply(parent?worlds.get(parent)!:node.parent?.getWorldMatrix()??Matrix.IdentityReadOnly));
  }
  return new Map([...worlds].filter(([name])=>name.endsWith('Foot')||name.endsWith('ToeBase')));
}

/** 在加载时烘焙世界姿态，再按目标真实父链求局部旋转；额外辅助骨不要求伪造源层级。 */
export function retargetHumanoidGroup(original:AnimationGroup,source:ReadonlyMap<string,TransformNode>,binding:ManualRoamRigBinding,name:string,footReference?:ReadonlyMap<string,Matrix>):AnimationGroup {
  const scene=original.getScene(),target=binding.joints;
  const sourcePose=new Map([...source].map(([semantic,node])=>[semantic,pose(node)]));
  const sourceWorld=new Map([...source].map(([semantic,node])=>[semantic,node.computeWorldMatrix(true).clone()]));
  const targetWorld=new Map([...target].map(([semantic,node])=>[semantic,node.computeWorldMatrix(true).clone()]));
  const alignment=Matrix.RotationY(binding.referenceYaw??-binding.facingYaw);
  const corrections=new Map([...target].map(([semantic])=>[semantic,targetWorld.get(semantic)!.multiply(Matrix.Invert((footReference?.get(semantic)??sourceWorld.get(semantic)!).multiply(alignment)))]));
  const byNode=new Map([...source].map(([semantic,node])=>[node,semantic]));
  const rotations=new Map(original.targetedAnimations.filter(track=>track.animation.targetProperty==='rotationQuaternion').map(track=>[byNode.get(track.target)!,track.animation]));
  const sourceHips=source.get('Hips')!,targetHips=target.get('Hips')!,hipsBase=targetHips.position.clone();
  const hipsAnimation=original.targetedAnimations.find(track=>track.target===sourceHips&&track.animation.targetProperty==='position')?.animation;
  const fps=original.targetedAnimations[0].animation.framePerSecond;
  if(!hipsAnimation||rotations.size!==target.size)throw new Error(`动作轨道无法完整绑定：${original.name}`);
  const targetNodes=new Set<TransformNode>();
  for(const node of target.values()){let current:TransformNode|null=node;while(current){targetNodes.add(current);current=current.parent as TransformNode|null;}}
  const poses=new Map([...targetNodes].map(node=>[node,pose(node)]));
  const semanticByTarget=new Map([...target].map(([semantic,node])=>[node,semantic]));
  const keys=new Map([...target].map(([semantic])=>[semantic,[] as {frame:number;value:Quaternion}[]]));
  const hipKeys:{frame:number;value:Vector3}[]=[];
  const frames=new Set<number>([original.from,original.to]);
  for(let f=original.from;f<original.to;f+=1)frames.add(f);
  for(const track of original.targetedAnimations)for(const key of track.animation.getKeys())frames.add(key.frame);
  if(frames.size>10000)throw new Error('动作采样数量超出自动适配上限。');
  const legRatio=binding.legLength/humanoidLegLength(source);
  // 所有前置校验完成后才登记到Scene，拒绝无效片段时不能遗留空动作组。
  const group=new AnimationGroup(name,scene);
  try {
    for(const frame of [...frames].sort((a,b)=>a-b)) {
      const animatedSource=new Map<string,Matrix>();
      for(const [semantic,node] of source) {
        const rest=sourcePose.get(semantic)!,local=Matrix.Compose(rest.scaling,rotations.get(semantic)!.evaluate(frame),semantic==='Hips'?hipsAnimation.evaluate(frame):rest.position);
        const parent=MANUAL_ROAM_HUMANOID_PARENTS[semantic];
        animatedSource.set(semantic,local.multiply(parent?animatedSource.get(parent)!:node.parent?.getWorldMatrix()??Matrix.IdentityReadOnly));
      }
      const animatedTarget=new Map<TransformNode,Matrix>();
      const resolve=(node:TransformNode):Matrix=>{
        const existing=animatedTarget.get(node);if(existing)return existing;
        const parent=node.parent as TransformNode|null,parentWorld=parent?resolve(parent):Matrix.IdentityReadOnly,rest=poses.get(node)!;
        const semantic=semanticByTarget.get(node);
        if(!semantic){const world=matrix(rest).multiply(parentWorld);animatedTarget.set(node,world);return world;}
        const desired=corrections.get(semantic)!.multiply(animatedSource.get(semantic)!).multiply(alignment);
        const rotation=Quaternion.Identity();desired.multiply(Matrix.Invert(parentWorld)).decompose(undefined,rotation);rotation.normalize();
        if(!rotation.asArray().every(Number.isFinite))throw new Error(`动作重定向产生无效旋转：${semantic}`);
        const previous=keys.get(semantic)!.at(-1)?.value;if(previous&&Quaternion.Dot(previous,rotation)<0)rotation.scaleInPlace(-1);
        keys.get(semantic)!.push({frame,value:rotation});
        let translation=rest.position;
        if(semantic==='Hips'){
          const deltaY=(animatedSource.get('Hips')!.getTranslation().y-sourceWorld.get('Hips')!.getTranslation().y)*legRatio;
          translation=hipsBase.add(Vector3.TransformNormal(new Vector3(0,deltaY,0),Matrix.Invert(parentWorld)));hipKeys.push({frame,value:translation});
        }
        const world=Matrix.Compose(rest.scaling,rotation,translation).multiply(parentWorld);animatedTarget.set(node,world);return world;
      };
      for(const node of target.values())resolve(node);
    }
    for(const [semantic,node] of target){const animation=new Animation(`${name}-${semantic}`,'rotationQuaternion',fps,Animation.ANIMATIONTYPE_QUATERNION);animation.setKeys(keys.get(semantic)!);group.addTargetedAnimation(animation,node);}
    const animation=new Animation(`${name}-hips-height`,'position',fps,Animation.ANIMATIONTYPE_VECTOR3);animation.setKeys(hipKeys);group.addTargetedAnimation(animation,targetHips);
    group.normalize(original.from,original.to);group.stop();return group;
  }catch(error){group.dispose();throw error;}
}
