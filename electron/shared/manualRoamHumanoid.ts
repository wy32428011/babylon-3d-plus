/** 导入与运行时共用语义关节识别；专用数据只缓存识别结果，不替代骨架与蒙皮校验。 */
export const MANUAL_ROAM_HUMANOID_PARENTS: Readonly<Record<string,string|null>> = {
  Hips:null,Spine:'Hips',Spine1:'Spine',Spine2:'Spine1',Neck:'Spine2',Head:'Neck',
  LeftShoulder:'Spine2',LeftArm:'LeftShoulder',LeftForeArm:'LeftArm',LeftHand:'LeftForeArm',
  RightShoulder:'Spine2',RightArm:'RightShoulder',RightForeArm:'RightArm',RightHand:'RightForeArm',
  LeftUpLeg:'Hips',LeftLeg:'LeftUpLeg',LeftFoot:'LeftLeg',LeftToeBase:'LeftFoot',
  RightUpLeg:'Hips',RightLeg:'RightUpLeg',RightFoot:'RightLeg',RightToeBase:'RightFoot',
};
export type ManualRoamHumanoidMetadata = {
  version:1; algorithm:'humanoid-semantic-v1'; motionProfile:'mixamo-humanoid-v2';
  joints:Record<string,number>; warnings:string[]; sourceHash?:string;
};
export type HumanoidJointCandidate = {index:number;name:string;parent:number|null};
const aliases:Record<string,string[]>={
  Hips:['hips','pelvis'],Spine:['spine','spine01','lowerback'],Spine1:['spine1','spine001','spine02'],
  Spine2:['spine2','spine002','spine03','chest','upperchest'],Neck:['neck','neck01','spine003'],Head:['head','spine004'],
};
for(const side of ['Left','Right'])for(const [part,names] of Object.entries({Shoulder:['shoulder','clavicle'],Arm:['arm','upperarm'],ForeArm:['forearm','lowerarm'],Hand:['hand','wrist'],UpLeg:['upleg','thigh'],Leg:['leg','lowerleg','calf','shin'],Foot:['foot','ankle'],ToeBase:['toebase','toe','toes','ball']})) {
  const letter=side==='Left'?'l':'r';
  aliases[side+part]=[side.toLowerCase()+part.toLowerCase(),...names.flatMap(name=>[name+letter,letter+name,side.toLowerCase()+name])];
}
function normalized(name:string):string {
  return name.toLowerCase().replace(/[^a-z0-9]/g,'').replace(/^(?:(?:mixamorig|character)\d*|armature|def)+/,'');
}

export function identifyManualRoamHumanoid(candidates:readonly HumanoidJointCandidate[]):Record<string,number> {
  const joints:Record<string,number>={};
  for(const [semantic,names] of Object.entries(aliases)) {
    const matches=candidates.filter(candidate=>names.includes(normalized(candidate.name)));
    if(matches.length!==1)throw new Error(matches.length?`人物关节名称存在歧义或重名：${semantic}`:`人物缺少可识别的关节：${semantic}。当前自动适配需要完整人形骨架。`);
    joints[semantic]=matches[0].index;
  }
  if(new Set(Object.values(joints)).size!==Object.keys(joints).length)throw new Error('人物关节语义存在歧义。');
  const byIndex=new Map(candidates.map(candidate=>[candidate.index,candidate]));
  const semanticByIndex=new Map(Object.entries(joints).map(([name,index])=>[index,name]));
  for(const [name,parent] of Object.entries(MANUAL_ROAM_HUMANOID_PARENTS)) {
    let next=byIndex.get(joints[name])?.parent??null;
    const visited=new Set<number>([joints[name]]);
    while(next!==null&&!semanticByIndex.has(next)) {
      if(visited.has(next))throw new Error('人物骨架层级包含循环。');
      visited.add(next);next=byIndex.get(next)?.parent??null;
    }
    if((next===null?null:semanticByIndex.get(next))!==parent)throw new Error(`人物关节父级不兼容：${name}`);
  }
  return joints;
}

type GltfNode={name?:string;children?:number[];mesh?:number;skin?:number};
type Gltf={nodes?:GltfNode[];skins?:{joints?:number[]}[]};
export function analyzeManualRoamHumanoid(value:unknown):{metadata:ManualRoamHumanoidMetadata;rootNodeIndex:number} {
  if(!value||typeof value!=='object')throw new Error('人物GLB结构无效。');
  const gltf=value as Gltf,nodes=gltf.nodes;
  if(!Array.isArray(nodes)||nodes.length>100000)throw new Error('人物节点数量无效或超出自动适配上限。');
  const meshNodes=nodes.filter(node=>typeof node.mesh==='number'),skins=new Set(meshNodes.map(node=>node.skin));
  if(!meshNodes.length||skins.size!==1||skins.has(undefined))throw new Error('自动适配需要所有人物网格绑定同一有效骨架。');
  const skin=gltf.skins?.[[...skins][0]!];
  if(!skin?.joints?.length||skin.joints.some(index=>!Number.isInteger(index)||!nodes[index]))throw new Error('人物没有有效骨架或蒙皮关节。');
  const parents=new Map<number,number>();
  nodes.forEach((node,index)=>{for(const child of node.children??[]){if(!Number.isInteger(child)||!nodes[child]||parents.has(child))throw new Error('人物节点父级无效或重复。');parents.set(child,index);}});
  // 辅助节点参与层级检查，只有skin中的真实关节允许被识别为人体语义。
  const jointSet=new Set(skin.joints);
  const candidates=nodes.map((node,index)=>({index,name:jointSet.has(index)?node.name??'':'',parent:parents.get(index)??null}));
  const joints=identifyManualRoamHumanoid(candidates);
  let rootNodeIndex=joints.Hips;const visited=new Set<number>();
  while(parents.has(rootNodeIndex)){if(visited.has(rootNodeIndex))throw new Error('人物骨架层级包含循环。');visited.add(rootNodeIndex);rootNodeIndex=parents.get(rootNodeIndex)!;}
  return {metadata:{version:1,algorithm:'humanoid-semantic-v1',motionProfile:'mixamo-humanoid-v2',joints,warnings:[]},rootNodeIndex};
}
