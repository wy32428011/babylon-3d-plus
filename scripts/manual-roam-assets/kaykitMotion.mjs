import { Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector.js';

/** 将完整源层级的世界姿态增量转为目标人形参考轴，保留原生关节屈伸方向。 */
export function createKaykitSampler(source, names, parents, restPoints, read, worldMatrices, sample) {
  const rest = worldMatrices(source.json);
  const index = new Map(source.json.nodes.map((node,i)=>[node.name,i]));
  const map = { Hips:'hips', Spine:'spine', Spine2:'chest', Head:'head' };
  for(const side of ['Left','Right']) {
    const suffix=side==='Left'?'.l':'.r';
    for(const [part,bone] of Object.entries({Arm:'upperarm',ForeArm:'lowerarm',Hand:'hand',UpLeg:'upperleg',Leg:'lowerleg',Foot:'foot',ToeBase:'toes'})) map[side+part]=bone+suffix;
  }
  for(const bone of Object.values(map)) if(!index.has(bone)) throw new Error(`KayKit缺少关节：${bone}`);
  const rotation = matrix => {const q=Quaternion.Identity();matrix.decompose(undefined,q);return q.normalize();};
  const sourceLength = ['l','r'].reduce((sum,suffix)=>sum+
    Vector3.Distance(rest[index.get('upperleg.'+suffix)].getTranslation(),rest[index.get('lowerleg.'+suffix)].getTranslation())+
    Vector3.Distance(rest[index.get('lowerleg.'+suffix)].getTranslation(),rest[index.get('foot.'+suffix)].getTranslation()),0)/2;
  const targetLength = ['Left','Right'].reduce((sum,side)=>sum+
    Vector3.Distance(restPoints[names.indexOf(side+'UpLeg')],restPoints[names.indexOf(side+'Leg')])+
    Vector3.Distance(restPoints[names.indexOf(side+'Leg')],restPoints[names.indexOf(side+'Foot')]),0)/2;
  if(!(sourceLength>0&&targetLength>0))throw new Error('动作腿长标定无效');
  return (name,time) => {
    const clip=source.json.animations.find(clip=>clip.name===name);
    if(!clip)throw new Error(`KayKit动作缺失：${name}`);
    const overrides=new Map();
    for(const channel of clip.channels) {
      const override=overrides.get(channel.target.node)??{};
      override[channel.target.path]=sample(source,clip.samplers[channel.sampler],time,channel.target.path==='rotation');
      overrides.set(channel.target.node,override);
    }
    const worlds=worldMatrices(source.json,overrides),delta={};
    for(const [target,bone] of Object.entries(map)) {
      const i=index.get(bone); delta[target]=rotation(worlds[i]).multiply(rotation(rest[i]).conjugate()).normalize();
    }
    delta.Spine1=Quaternion.Slerp(delta.Spine,delta.Spine2,.5);
    delta.Neck=Quaternion.Slerp(delta.Spine2,delta.Head,.5);
    delta.LeftShoulder=delta.Spine2.clone();delta.RightShoulder=delta.Spine2.clone();
    const local=names.map((name,i)=>parents[i]===null?delta[name].clone():delta[parents[i]].conjugate().multiply(delta[name]).normalize());
    const hips=index.get('hips');
    return {local,hipY:(worlds[hips].getTranslation().y-rest[hips].getTranslation().y)*targetLength/sourceLength};
  };
}
