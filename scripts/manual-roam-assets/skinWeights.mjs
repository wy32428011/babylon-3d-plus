/** 解剖候选限制只作用于权重计算；不移动顶点、不改变骨架，也不跨越已有接缝平均边界。 */
export function getManualRoamSkinCandidates(point, material, names, sourcePoints) {
  const index = new Map(names.map((name,i) => [name,i]));
  const joint = name => {
    const id = index.get(name);
    if (id === undefined || !sourcePoints[id]) throw new Error(`蒙皮分类缺少关节：${name}`);
    return sourcePoints[id];
  };
  if (![point.x,point.y,point.z].every(Number.isFinite)) throw new Error('蒙皮分类顶点坐标无效');
  const result = (allowed,factor=1) => allowed.map(name => {
    joint(name); return {index:index.get(name),factor};
  });
  const hips=joint('Hips'),side=point.x>=hips.x?'Left':'Right';
  const torso=['Hips','Spine','Spine1','Spine2','Neck'];
  if (material===4) return result([side+'ForeArm',side+'Hand']);
  if (material===5) return result(['Hips','Spine',side+'UpLeg',side+'Leg',side+'Foot',side+'ToeBase']);
  if (material===6) {
    const foot=joint(side+'Foot'),toe=joint(side+'ToeBase');
    const forward={x:toe.x-foot.x,y:toe.y-foot.y,z:toe.z-foot.z},length=Math.hypot(forward.x,forward.y,forward.z);
    if(!(length>.01))throw new Error('鞋底分类缺少有效脚长');
    for(const axis of ['x','y','z'])forward[axis]/=length;
    const up={x:-forward.x*forward.y,y:1-forward.y**2,z:-forward.z*forward.y},upLength=Math.hypot(up.x,up.y,up.z);
    if(upLength<.1)throw new Error('鞋底参考轴接近竖直，无法分类');
    const height=((point.x-foot.x)*up.x+(point.y-foot.y)*up.y+(point.z-foot.z)*up.z)/upLength;
    // 只收紧脚踝下方鞋底；鞋口回到原候选，保留与裤口的接缝平均。阈值随脚长缩放。
    const t=Math.max(0,Math.min(1,(height/length+.30)/.21)),originalFactor=t*t*(3-2*t);
    return result(names).map(candidate=>({...candidate,factor:[side+'Foot',side+'ToeBase'].includes(names[candidate.index])?1:originalFactor})).filter(candidate=>candidate.factor>1e-8);
  }
  if (material!==3) return result(names);

  const arm=joint(side+'Arm'),elbow=joint(side+'ForeArm');
  const shoulderWidth=Math.abs(arm.x-hips.x);
  if (!(shoulderWidth>0.01)) throw new Error('人物肩宽不足，无法安全分类上衣');
  const lateral=Math.abs(point.x-hips.x)/shoulderWidth;
  const smooth=value=>{const t=Math.max(0,Math.min(1,value));return t*t*(3-2*t);};
  // 腰部逐渐排除臂链；外侧袖口仍进入袖链，避免在固定高度产生权重断层。
  const lowerTorsoGate=Math.max(smooth((point.y-elbow.y+0.12)/0.12),smooth((lateral-0.9)/0.15));
  // 胸背中心到袖子的过渡按人物肩宽归一化，避免依赖某一顶点编号或绝对世界位置。
  const t=Math.max(0,Math.min(1,(lateral-0.65)/0.40));
  const armFactor=t*t*(3-2*t)*lowerTorsoGate;
  const armChain=[side+'Shoulder',side+'Arm',side+'ForeArm',side+'Hand'];
  return [...result(torso,1-armFactor),...result(armChain,armFactor)].filter(candidate=>candidate.factor>1e-8);
}
