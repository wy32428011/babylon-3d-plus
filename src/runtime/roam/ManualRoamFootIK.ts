import { Matrix, Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import type { AssetContainer, TransformNode } from '@babylonjs/core';
import { measureManualRoamSole, type ManualRoamSoleGeometry } from './manualRoamSoleGeometry.ts';
import { MANUAL_ROAM_MAX_STRIDE_SCALE } from './manualRoamAnimationState.ts';
import { createManualRoamFootPhaseState, stepManualRoamFootPhase, type ManualRoamFootPhaseState } from './manualRoamFootPhase.ts';

export type ManualRoamGroundHit = { point: Vector3; normal: Vector3 } | { height: number; normal: Vector3 };
export type ManualRoamFootIKOptions = {
  probeGround: (x: number, z: number, originY: number, length: number) => ManualRoamGroundHit | null;
  /** 自动人物保留原骨骼名称，以语义映射连接现有动作及脚部校准。 */
  joints?: ReadonlyMap<string, TransformNode>;
  automatic?: boolean;
  /** 自动姿态校准前捕获的脚骨局部朝上；原始mesh bind坐标不一定是Y向上。 */
  footReferenceUp?: ReadonlyMap<string, Vector3>;
  /** 作者米制的脚踝到鞋底距离；由真实人物根缩放换算成世界距离。 */
  soleHeight?: number;
  /** 世界米，限制视觉纠正，不能用 IK 代替碰撞器登阶。 */
  maxCorrection?: number;
  maxSlopeDegrees?: number;
};
export type ManualRoamFootIKFrame = {
  dt: number;
  grounded: boolean;
  fly: boolean;
  teleported?: boolean;
  footContacts: { left: number; right: number };
  speed?: number;
  strideScale?: number;
  /** 移动转向时逐脚保留可达支撑；超限脚独立释放并继续有界贴地。 */
  turning?: boolean;
};
export type ManualRoamFootIKFootDebug = {
  locked: boolean;
  target: Vector3 | null;
  targetError: number;
  normalAlignment: number;
  kneeForward: number;
  reason: string;
  phase: ManualRoamFootPhaseState['phase'];
  weights: { position:number;rotation:number;plant:number };
  pelvisOffset: number;
  poleCorrectionRadians: number;
  lockId: number;
  releaseReason: string;
  soleResidualBefore: number;
  soleResidualAfter: number;
  residualIterations: number;
  residualCorrection: number;
  lockPoint: Vector3|null;
};
type Leg = { soleUp: Vector3; soleForward: Vector3 | null; thigh: TransformNode; knee: TransformNode; foot: TransformNode; toe: TransformNode | null; sole:ManualRoamSoleGeometry; solePoints:Vector3[]; strideOffset:Vector3; lock: Vector3 | null; lockId:number;releaseReason:string;plantOffsets:Vector3[]|null; phase:ManualRoamFootPhaseState; previousClearance:number|null; pole:Vector3|null; ground:{point:Vector3;normal:Vector3}|null; debug: ManualRoamFootIKFootDebug };
const emptyDebug = (reason = 'inactive'): ManualRoamFootIKFootDebug => ({ locked: false, target: null, targetError: 0, normalAlignment: 1, kneeForward: 0, reason,phase:'Swing',weights:{position:0,rotation:0,plant:0},pelvisOffset:0,poleCorrectionRadians:0,lockId:0,releaseReason:reason,soleResidualBefore:0,soleResidualAfter:0,residualIterations:0,residualCorrection:0,lockPoint:null });
/** 参考姿态把脚骨拉平，鞋网格仍按真实绑定蒙皮；资产在脚骨局部记录“鞋底自然朝上”的方向，缺省时回退脚骨Up轴。 */
function readSoleUp(foot: TransformNode): Vector3 {
  const value = foot.metadata?.gltf?.extras?.manualRoamSoleUp ?? foot.metadata?.manualRoamSoleUp;
  if (!Array.isArray(value) || value.length !== 3 || !value.every(Number.isFinite)) return Vector3.Up();
  const direction = Vector3.FromArray(value);
  return direction.lengthSquared() > 1e-8 ? direction.normalize() : Vector3.Up();
}
const finiteVector = (value: Vector3): boolean => value.asArray().every(Number.isFinite);
const position = (node: TransformNode): Vector3 => { node.computeWorldMatrix(true); return node.getAbsolutePosition().clone(); };
const worldDirection = (node: TransformNode, local: Vector3): Vector3 => Vector3.TransformNormal(local, node.computeWorldMatrix(true)).normalize();
const project = (value: Vector3, normal: Vector3): Vector3 => value.subtract(normal.scale(Vector3.Dot(value, normal)));
const footForward = (leg: Leg): Vector3 => leg.soleForward
  ? worldDirection(leg.foot, leg.soleForward)
  : position(leg.toe!).subtract(position(leg.foot)).normalize();

function fromTo(from: Vector3, to: Vector3): Quaternion {
  const a = from.normalizeToNew(), b = to.normalizeToNew(), dot = Math.max(-1, Math.min(1, Vector3.Dot(a,b)));
  if (dot > 1 - 1e-10) return Quaternion.Identity();
  if (dot < -1 + 1e-8) {
    const axis = Vector3.Cross(a, Math.abs(a.y) < 0.9 ? Vector3.Up() : Vector3.Right()).normalize();
    return Quaternion.RotationAxis(axis, Math.PI);
  }
  const axis = Vector3.Cross(a,b);
  return new Quaternion(axis.x,axis.y,axis.z,1+dot).normalize();
}

/** 在父级坐标中求旋转增量，保留 glTF 根镜像及外层统一缩放，不分解反射世界四元数。 */
function aim(node: TransformNode, fromWorld: Vector3, toWorld: Vector3): void {
  const parentWorld = node.parent?.getWorldMatrix() ?? Matrix.Identity();
  const inverse = Matrix.Invert(parentWorld);
  const from = Vector3.TransformNormal(fromWorld,inverse), to = Vector3.TransformNormal(toWorld,inverse);
  if (from.lengthSquared() < 1e-12 || to.lengthSquared() < 1e-12) return;
  const current = node.rotationQuaternion ?? Quaternion.FromEulerVector(node.rotation);
  node.rotationQuaternion = fromTo(from,to).multiply(current).normalize();
  node.computeWorldMatrix(true);
}

/** 必须在本帧动画姿态求值后调用；只修改视觉骨骼，不移动人物根或碰撞器。 */
export class ManualRoamFootIK {
  private readonly hips: TransformNode;
  private readonly bodyForward: Vector3;
  private readonly legs: Record<'left' | 'right', Leg>;
  private readonly options: ManualRoamFootIKOptions;
  private readonly soleHeight: number;
  private readonly maxCorrection: number;
  private readonly minimumNormalY: number;
  private disposed = false;
  private pelvisOffset=0;
  private pelvisVelocity=0;
  private nextLockId=0;

  constructor(container: AssetContainer, options: ManualRoamFootIKOptions) {
    this.options = options;
    const get = (name: string): TransformNode => {
      if (options.joints) {
        const mapped = options.joints.get(name);
        if (!mapped) throw new Error(`足部 IK 关节未映射：${name}`);
        return mapped;
      }
      const found = container.transformNodes.filter(node => node.name === name);
      if (found.length !== 1) throw new Error(`足部 IK 关节缺失或重名：${name}`);
      return found[0];
    };
    this.hips = get('Hips');
    const leg = (side: string): Leg => {
      const thigh = get(side+'UpLeg'), knee = get(side+'Leg'), foot = get(side+'Foot');
      const toe = options.automatic ? options.joints?.get(side+'ToeBase') ?? null : get(side+'ToeBase');
      const connected = (child: TransformNode, parent: TransformNode) => options.automatic ? child.isDescendantOf(parent) : child.parent === parent;
      if (!connected(thigh,this.hips) || !connected(knee,thigh) || !connected(foot,knee) || (toe && !connected(toe,foot))) throw new Error(`足部 IK 层级无效：${side}`);
      const sole=measureManualRoamSole(container,foot,side,options.soleHeight??0.065,options);
      const inverse = Matrix.Invert(foot.computeWorldMatrix(true));
      const up = options.automatic ? options.footReferenceUp?.get(side+'Foot')?.clone().normalize() ?? Vector3.TransformNormal(Vector3.Up(),inverse).normalize() : readSoleUp(foot);
      // 原始脚骨的轴可能沿小腿；沿用校准前站姿的鞋底朝上，不将mesh的inverse bind误认为节点的原站姿。
      const forward = toe ? position(toe).subtract(position(foot)) : Vector3.TransformNormal(Vector3.Forward(),this.hips.parent?.computeWorldMatrix(true) ?? Matrix.Identity());
      const soleForward = options.automatic ? project(Vector3.TransformNormal(forward,inverse),up).normalize() : null;
      if (options.automatic && (!finiteVector(up) || !finiteVector(soleForward!) || soleForward!.lengthSquared()<1e-8)) throw new Error(`足底参考朝向无法确定：${side}`);
      return { soleUp:up,soleForward,thigh,knee,foot,toe,sole,solePoints:sole.points,strideOffset:Vector3.Zero(),lock:null,lockId:0,releaseReason:'inactive',plantOffsets:null,phase:createManualRoamFootPhaseState(),previousClearance:null,pole:null,ground:null,debug:emptyDebug() };
    };
    this.legs = { left:leg('Left'),right:leg('Right') };
    const initialForward = project(footForward(this.legs.left).add(footForward(this.legs.right)),Vector3.Up());
    this.bodyForward = options.automatic
      ? Vector3.TransformNormal(initialForward,Matrix.Invert(this.hips.parent?.computeWorldMatrix(true) ?? Matrix.Identity())).normalize()
      : Vector3.Forward();
    if (!finiteVector(this.bodyForward) || this.bodyForward.lengthSquared()<1e-8) throw new Error('足部 IK 无法确定人体前向。');
    this.soleHeight = options.soleHeight ?? 0.065;
    this.maxCorrection = options.maxCorrection ?? 0.26;
    const slope = options.maxSlopeDegrees ?? 50;
    if (!Number.isFinite(this.soleHeight) || this.soleHeight < 0 || this.soleHeight > 0.2
      || !Number.isFinite(this.maxCorrection) || this.maxCorrection <= 0 || this.maxCorrection > 0.3
      || !Number.isFinite(slope) || slope < 0 || slope > 70) throw new Error('足部 IK 配置无效。');
    this.minimumNormalY = Math.cos(slope*Math.PI/180);
  }

  update(frame: ManualRoamFootIKFrame): void {
    if (this.disposed) return;
    if (!Number.isFinite(frame.dt) || frame.dt < 0 || frame.teleported) { this.reset(); return; }
    if(!frame.grounded||frame.fly){this.resetLegs();this.applyPelvis(0,frame.dt);return;}
    const moving=(frame.speed??0)>0.03;
    const stride=Number.isFinite(frame.strideScale)?Math.max(1,Math.min(MANUAL_ROAM_MAX_STRIDE_SCALE,frame.strideScale!)):1;
    const forward=Vector3.TransformNormal(this.bodyForward,this.hips.parent?.computeWorldMatrix(true) ?? Matrix.Identity()).normalize(),center=position(this.hips);
    for(const side of ['left','right'] as const){const leg=this.legs[side];leg.solePoints=leg.sole.sample();leg.strideOffset=forward.scale(Vector3.Dot(position(leg.foot).subtract(center),forward)*(stride-1));this.prepareLeg(leg,frame.footContacts[side],moving,frame.dt);}
    this.fitPelvis(moving,frame.dt);
    for (const side of ['left','right'] as const) this.updateLeg(this.legs[side],frame.footContacts[side],moving,!!frame.turning);
  }

  private solePose(leg:Leg,normal:Vector3,moving:boolean,weight=1):{offset:Vector3;reference:Vector3;up:Vector3;forward:Vector3} {
    const world=leg.foot.computeWorldMatrix(true),up=worldDirection(leg.foot,leg.soleUp);
    const tilt=Quaternion.Slerp(Quaternion.Identity(),fromTo(moving?Vector3.Up():up,normal),weight),matrix=Matrix.Identity();tilt.toRotationMatrix(matrix);
    const rotate=(value:Vector3)=>Vector3.TransformNormal(value,matrix);
    const original=leg.solePoints.map(point=>Vector3.TransformNormal(point,world)),points=original.map(rotate);
    let lowest=0;points.forEach((point,i)=>{if(Vector3.Dot(point,normal)<Vector3.Dot(points[lowest],normal))lowest=i;});
    const flatMatrix=Matrix.Identity();fromTo(up,normal).toRotationMatrix(flatMatrix);
    const flatPoint=Vector3.TransformNormal(original[lowest],flatMatrix);
    // 锁平脚参考点；前掌/后跟只贡献相对平脚的滚动位移，避免最低点切换时踝部横跳一整只鞋长。
    const offset=leg.lock&&leg.plantOffsets?.length===points.length?points[lowest].subtract(leg.plantOffsets[lowest]):normal.scale(Vector3.Dot(points[lowest],normal)).add(project(points[lowest].subtract(flatPoint),normal));
    return {offset,reference:points[lowest].subtract(offset),up:rotate(up),forward:rotate(footForward(leg))};
  }

  private prepareLeg(leg:Leg,contact:number,moving:boolean,dt:number):void {
    const foot=position(leg.foot),pose=this.solePose(leg,Vector3.Up(),moving),at=leg.lock??foot.add(leg.strideOffset).add(pose.offset);
    // 地面射线对齐实际前掌/后跟接触点，返回后再换回平脚锚点，避免局部高差被错采到踝部下方。
    const probe=at.add(pose.reference),hit=this.options.probeGround(probe.x,probe.z,foot.y+this.maxCorrection,this.maxCorrection*2+.2);
    if(!hit){this.release(leg,'no-ground');return;}
    const point='point'in hit?hit.point.clone():new Vector3(probe.x,hit.height,probe.z);
    if(!finiteVector(point)||!finiteVector(hit.normal)||hit.normal.lengthSquared()<1e-8){this.release(leg,'invalid-ground');return;}
    const normal=hit.normal.normalizeToNew();if(normal.y<this.minimumNormalY){this.release(leg,'slope-limit');return;}
    point.subtractInPlace(project(pose.reference,normal));
    leg.ground={point,normal};
    const clearance=Vector3.Dot(foot.add(this.solePose(leg,normal,moving).offset).subtract(point),normal);
    const velocity=leg.previousClearance===null||dt<=0?0:(clearance-leg.previousClearance)/Math.min(.1,dt);
    leg.previousClearance=clearance;
    leg.phase=stepManualRoamFootPhase(leg.phase,{dt,contact,moving,soleClearance:clearance,verticalSpeed:velocity,canPlant:Math.abs(clearance)<=this.maxCorrection});
    if(!leg.phase.canLock){if(leg.lock)leg.releaseReason='phase-'+leg.phase.phase;leg.lock=null;leg.plantOffsets=null;}
  }

  /** 支撑腿共同约束视觉骨盆；世界补偿最多8厘米，不移动碰撞体。 */
  private fitPelvis(moving:boolean,dt:number): void {
    let drop=0;
    for(const side of ['left','right'] as const) {
      if(!this.legs[side].ground||this.legs[side].phase.positionWeight<.5)continue;
      const leg=this.legs[side],hip=position(leg.thigh),knee=position(leg.knee),foot=position(leg.foot);
      const {point:ground,normal}=leg.ground!,target=ground.subtract(this.solePose(leg,normal,moving,leg.phase.rotationWeight).offset);
      const reach=Vector3.Distance(hip,knee)+Vector3.Distance(knee,foot)-1e-4,horizontal=(target.x-hip.x)**2+(target.z-hip.z)**2;
      if(horizontal>=reach*reach||Vector3.Distance(foot,target)>this.maxCorrection)continue;
      drop=Math.max(drop,hip.y-target.y-Math.sqrt(reach*reach-horizontal));
    }
    this.applyPelvis(Math.max(0,Math.min(.08,drop)),dt);
  }

  /** 相对本帧FK骨盆基准施加临界阻尼偏移；调用方必须先提交本帧动画。 */
  private applyPelvis(target:number,rawDt:number):void {
    const dt=Math.min(.1,Math.max(0,rawDt)),omega=16,delta=this.pelvisOffset-target,term=this.pelvisVelocity+omega*delta,decay=Math.exp(-omega*dt);
    this.pelvisOffset=Math.max(0,Math.min(.08,target+(delta+term*dt)*decay));
    this.pelvisVelocity=(this.pelvisVelocity-omega*term*dt)*decay;
    if(this.pelvisOffset>0) {
      const inverse=Matrix.Invert(this.hips.parent?.computeWorldMatrix(true)??Matrix.Identity());
      this.hips.position.addInPlace(Vector3.TransformNormal(new Vector3(0,-this.pelvisOffset,0),inverse));
      this.hips.computeWorldMatrix(true);
    }
  }

  private release(leg: Leg, reason: string): void { if(leg.lock)leg.releaseReason=reason;leg.lock = null;leg.plantOffsets=null;leg.ground=null;if(reason!=='swing'){leg.phase=createManualRoamFootPhaseState();leg.previousClearance=null;}leg.debug = emptyDebug(reason); }

  private updateLeg(leg: Leg, rawWeight: number,moving:boolean,turning:boolean,allowFallback=true): void {
    const weight=leg.phase.positionWeight;
    if(!leg.ground)return;
    if(!moving&&rawWeight<.15){this.release(leg,'swing');return;}
    if (weight < 0.15) leg.lock=null;
    const hip = position(leg.thigh), knee = position(leg.knee), foot = position(leg.foot);
    const scale = Math.cbrt(Math.abs(leg.foot.getWorldMatrix().determinant()));
    if (!Number.isFinite(scale) || scale < 1e-5) { this.release(leg,'invalid-transform'); return; }
    const {point:ground,normal}=leg.ground;
    const sole=this.solePose(leg,normal,moving,leg.phase.rotationWeight);
    let target = ground.subtract(sole.offset);
    const penetration=Math.max(0,Vector3.Dot(target.subtract(foot),normal));
    // 普通人物的摆动脚可能前掌已越过台边、最低后跟仍在低处；释放前先核查实际轮廓上的局部高地面。
    const edgeLift=this.options.automatic&&moving&&weight<.15
      ? this.terrainLift(leg.solePoints.map(point=>Vector3.TransformCoordinates(point,leg.foot.getWorldMatrix())),foot.y,scale,normal)
      : 0;
    if(weight<0.15&&moving) {
      if(penetration<=1e-6&&edgeLift<=1e-6&&leg.strideOffset.lengthSquared()<1e-10){this.release(leg,'swing');return;}
      // 摆动脚只做必要法向抬升，不锁水平位置，也不把高空脚吸向地面。
      target=foot.add(leg.strideOffset).add(normal.scale(penetration));
      target.y+=Math.max(0,edgeLift-penetration*normal.y);
    }
    if (Vector3.Distance(foot,target) > this.maxCorrection) { if(allowFallback&&(moving||leg.lock)){this.groundFallback(leg,turning?'turn-correction-limit':'stance-correction-limit');return;}this.release(leg,'correction-limit');return; }
    const upper = Vector3.Distance(hip,knee), lower = Vector3.Distance(knee,foot);let distance = Vector3.Distance(hip,target);
    if(!leg.lock&&leg.strideOffset.lengthSquared()>1e-10&&distance>=upper+lower-1e-4) {
      // 摆动/落脚目标只能在真实腿长可达范围内扩大；保留必要法向抬升，不以伸长骨骼换步幅。
      const base=target.subtract(leg.strideOffset),reach=upper+lower-1e-4;
      if(Vector3.Distance(hip,base)<reach){let lo=0,hi=1;for(let i=0;i<8;i++){const mid=(lo+hi)/2;if(Vector3.Distance(hip,base.add(leg.strideOffset.scale(mid)))<reach)lo=mid;else hi=mid;}leg.strideOffset.scaleInPlace(lo);target=base.add(leg.strideOffset);distance=Vector3.Distance(hip,target);}
    }
    if (upper < 1e-5 || lower < 1e-5 || distance >= upper+lower-1e-5 || distance <= Math.abs(upper-lower)+1e-5) { if(allowFallback&&(moving||leg.lock)){this.groundFallback(leg,turning?'turn-unreachable':'stride-unreachable');return;}this.release(leg,'unreachable');return; }
    const newlyLocked=!leg.lock&&leg.phase.canLock;
    if (newlyLocked) {
      leg.lock = ground.clone();leg.lockId=++this.nextLockId;const world=leg.foot.computeWorldMatrix(true),flat=Matrix.Identity();fromTo(worldDirection(leg.foot,leg.soleUp),normal).toRotationMatrix(flat);
      // 固定落地时每个鞋底采样点的平脚参考，避免腿/趾混合变形被当作新的锁点继续滑动。
      leg.plantOffsets=leg.solePoints.map(p=>project(Vector3.TransformNormal(Vector3.TransformNormal(p,world),flat),normal));
    }
    const effectiveTarget = weight<.15?target.clone():Vector3.Lerp(foot,target,weight);
    if(!leg.lock&&weight>=.15)effectiveTarget.addInPlace(leg.strideOffset.scale(1-weight));
    // 接触权重只控制贴地/水平锁的融合，不能把安全抬升乘小后留下穿地。
    if(moving)effectiveTarget.addInPlace(normal.scale(Math.max(0,penetration-Vector3.Dot(effectiveTarget.subtract(foot),normal))));
    const axis = effectiveTarget.subtract(hip).normalize();
    const bodyWorld = this.hips.parent?.computeWorldMatrix(true) ?? Matrix.Identity();
    const forward = Vector3.TransformNormal(this.bodyForward,bodyWorld).normalize();
    const originalPole=project(knee.subtract(hip),axis),safeForward=project(forward,axis).normalize();
    let pole=originalPole.clone();
    if(pole.lengthSquared()<1e-8&&leg.pole)pole=project(leg.pole,axis);
    if(pole.lengthSquared()<1e-8)pole=safeForward.clone();
    if (pole.lengthSquared() < 1e-8) { this.release(leg,'degenerate-pole'); return; }
    pole.normalize();
    // 保留源动作弯曲平面；只有越过前向60度安全锥或退化时才收回，避免轻微贴地重写膝轨迹。
    if(safeForward.lengthSquared()>1e-8&&Vector3.Dot(pole,safeForward)<.5){const lateral=project(pole,safeForward);pole=lateral.lengthSquared()>1e-8?safeForward.scale(.5).add(lateral.normalize().scale(Math.sqrt(.75))):safeForward.clone();}
    const poleCorrection=originalPole.lengthSquared()>1e-8?Math.acos(Math.max(-1,Math.min(1,Vector3.Dot(originalPole.normalizeToNew(),pole)))):0;
    leg.pole=pole.clone();
    this.solveLeg(leg,effectiveTarget,pole,sole.up,sole.forward);
    if(newlyLocked)this.capturePlant(leg,normal);
    const residual=this.refineSole(leg,foot,pole,sole.up,sole.forward,normal);
    if(residual.target)target.copyFrom(residual.target);
    const actual = position(leg.foot), actualKnee = position(leg.knee);
    leg.debug = { locked:leg.lock !== null,target:target.clone(),targetError:Vector3.Distance(actual,target),
      normalAlignment:Vector3.Dot(worldDirection(leg.foot,leg.soleUp),normal),
      kneeForward:Vector3.Dot(project(actualKnee.subtract(hip),axis),forward),reason:'solved',phase:leg.phase.phase,
      weights:{position:leg.phase.positionWeight,rotation:leg.phase.rotationWeight,plant:leg.phase.plantWeight},pelvisOffset:this.pelvisOffset,poleCorrectionRadians:poleCorrection,
      lockId:leg.lockId,releaseReason:leg.releaseReason,soleResidualBefore:residual.before,soleResidualAfter:residual.after,residualIterations:residual.iterations,residualCorrection:residual.correction,lockPoint:leg.lock?.clone()??null };
  }

  private groundFallback(leg:Leg,reason:string):void {
    // 只释放超限的该脚，本帧缩步后继续防穿地；有界重算一次，不扩大腿长和纠正预算。
    this.release(leg,reason);leg.strideOffset.setAll(0);this.prepareLeg(leg,0,true,0);this.updateLeg(leg,0,true,false,false);
  }

  /** 平面先查4×4轮廓；发现不同地面平面时核查全部有界缓存点，避免窄高台落在分区内部。 */
  private terrainLift(points:Vector3[],originY:number,scale:number,normal:Vector3,allowDown=false):number {
    const depth=(p:Vector3)=>Vector3.Dot(p,normal),lowest=points.reduce((a,b)=>depth(a)<depth(b)?a:b),bottom=points.filter(p=>depth(p)<=depth(lowest)+.08*scale),cells=new Map<number,Vector3>();
    const minX=Math.min(...bottom.map(p=>p.x)),maxX=Math.max(...bottom.map(p=>p.x)),minZ=Math.min(...bottom.map(p=>p.z)),maxZ=Math.max(...bottom.map(p=>p.z));
    for(const p of bottom){const x=Math.min(3,Math.floor((p.x-minX)/Math.max(1e-8,maxX-minX)*4)),z=Math.min(3,Math.floor((p.z-minZ)/Math.max(1e-8,maxZ-minZ)*4)),key=x+z*4,old=cells.get(key);if(!old||depth(p)<depth(old))cells.set(key,p);}
    let lift=-Infinity,minPlane=Infinity,maxPlane=-Infinity;const queried=new Map<string,number|null>();
    const check=(p:Vector3)=>{const key=p.x+':'+p.z;let y=queried.get(key);if(y===undefined){const hit=this.options.probeGround(p.x,p.z,originY+this.maxCorrection,this.maxCorrection*2+.2);y=hit&&finiteVector(hit.normal)&&hit.normal.lengthSquared()>1e-8&&hit.normal.normalizeToNew().y>=this.minimumNormalY?('point'in hit?hit.point.y:hit.height):null;queried.set(key,y);}if(y===null||!Number.isFinite(y))return;lift=Math.max(lift,y-p.y);const plane=Vector3.Dot(new Vector3(p.x,y,p.z),normal);minPlane=Math.min(minPlane,plane);maxPlane=Math.max(maxPlane,plane);};
    for(const p of cells.values())check(p);
    if(this.options.automatic){
      // 坐标极值覆盖刚踏入台面的窄前/后掌，不能被分区里更低、但仍悬在台外的顶点取代。
      // 探到不同平面后仍核查全部缓存点，不裁剪实际足底几何，也不提高纠正预算。
      for(const axis of ['x','z'] as const){let minimum=points[0],maximum=points[0];for(const p of points){if(p[axis]<minimum[axis])minimum=p;if(p[axis]>maximum[axis])maximum=p;}check(minimum);check(maximum);}
    }
    if(maxPlane-minPlane>.001)for(const p of points)check(p);
    return Number.isFinite(lift)?allowDown?lift:Math.max(0,lift):0;
  }

  private solveLeg(leg:Leg,target:Vector3,pole:Vector3,up:Vector3,forward:Vector3):boolean {
    const hip=position(leg.thigh),knee=position(leg.knee),foot=position(leg.foot),upper=Vector3.Distance(hip,knee),lower=Vector3.Distance(knee,foot),length=Vector3.Distance(hip,target);
    if(length>=upper+lower-1e-5||length<=Math.abs(upper-lower)+1e-5)return false;
    const axis=target.subtract(hip).normalize(),bendPole=project(pole,axis).normalize(),along=(upper*upper-lower*lower+length*length)/(2*length);
    const desiredKnee=hip.add(axis.scale(along)).add(bendPole.scale(Math.sqrt(Math.max(0,upper*upper-along*along))));
    aim(leg.thigh,knee.subtract(hip),desiredKnee.subtract(hip));
    const nextKnee=position(leg.knee);aim(leg.knee,position(leg.foot).subtract(nextKnee),target.subtract(nextKnee));
    aim(leg.foot,worldDirection(leg.foot,leg.soleUp),up);
    aim(leg.foot,project(footForward(leg),up),project(forward,up));
    return true;
  }

  /** 首次落地以最终蒙皮姿态建立参考；后续迭代绝不重建此参考。 */
  private capturePlant(leg:Leg,normal:Vector3):void {
    if(!leg.lock)return;
    leg.solePoints=leg.sole.sample();const world=leg.foot.computeWorldMatrix(true),flat=Matrix.Identity();fromTo(worldDirection(leg.foot,leg.soleUp),normal).toRotationMatrix(flat);
    const points=leg.solePoints.map(p=>Vector3.TransformNormal(p,world));
    leg.plantOffsets=points.map(p=>project(Vector3.TransformNormal(p,flat),normal));
    let lowest=0;points.forEach((p,i)=>{if(Vector3.Dot(p,normal)<Vector3.Dot(points[lowest],normal))lowest=i;});
    const base=position(leg.foot).add(points[lowest]).subtract(leg.plantOffsets[lowest]);
    base.subtractInPlace(normal.scale(Vector3.Dot(base.subtract(leg.lock),normal)));leg.lock=base;
    if(leg.ground)leg.ground.point=base.clone();
  }

  /** 最多两次10毫米修正；只有真实蒙皮残差下降才接受，不提高原有可达及纠正上限。 */
  private refineSole(leg:Leg,fkFoot:Vector3,pole:Vector3,up:Vector3,forward:Vector3,normal:Vector3):{before:number;after:number;iterations:number;correction:number;target:Vector3|null} {
    const result={before:0,after:0,iterations:0,correction:0,target:null as Vector3|null};
    if(!leg.ground)return result;
    const sample=()=>{const world=leg.foot.computeWorldMatrix(true),at=position(leg.foot);return leg.sole.sample().map(p=>Vector3.TransformNormal(p,world).add(at));};
    for(let iteration=0;iteration<2;iteration++) {
      const points=sample();let index=0;points.forEach((p,i)=>{if(Vector3.Dot(p,normal)<Vector3.Dot(points[index],normal))index=i;});
      const base=leg.lock??leg.ground.point;
      const expected=leg.lock&&leg.plantOffsets?base.add(leg.plantOffsets[index]):points[index].clone();
      const error=expected.subtract(points[index]);error.y=this.terrainLift(points,fkFoot.y,Math.cbrt(Math.abs(leg.foot.getWorldMatrix().determinant())),normal,!!leg.lock);
      const height=-Math.max(0,error.y),size=error.length();expected.copyFrom(points[index].add(error));
      if(iteration===0)result.before=size;result.after=size;if(size<.001)break;
      const step=error.scale(Math.min(size,.01,.02-result.correction)/size),target=position(leg.foot).add(step);
      if(Vector3.Distance(fkFoot,target)>this.maxCorrection)break;
      const saved=[leg.thigh,leg.knee,leg.foot].map(node=>node.rotationQuaternion!.clone());
      if(!this.solveLeg(leg,target,pole,up,forward))break;
      const next=sample(),remaining=Vector3.Distance(next[index],expected),penetration=-this.terrainLift(next,fkFoot.y,Math.cbrt(Math.abs(leg.foot.getWorldMatrix().determinant())),normal);
      if(remaining>=size-1e-5||penetration<Math.min(-.006,height)-1e-5){[leg.thigh,leg.knee,leg.foot].forEach((node,i)=>{node.rotationQuaternion=saved[i];node.computeWorldMatrix(true);});break;}
      result.after=remaining;result.iterations++;result.correction+=step.length();result.target=target;
    }
    return result;
  }

  private resetLegs():void {for(const leg of Object.values(this.legs)){this.release(leg,'reset');leg.pole=null;}}
  reset(): void {this.resetLegs();this.pelvisOffset=0;this.pelvisVelocity=0;}
  dispose(): void { this.reset(); this.disposed = true; }
  getDebugState(): Record<'left' | 'right', ManualRoamFootIKFootDebug> {
    const copy = (leg: Leg): ManualRoamFootIKFootDebug => ({ ...leg.debug,lockPoint:leg.lock?.clone()??null,lockId:leg.lockId,releaseReason:leg.releaseReason,phase:leg.phase.phase,weights:{position:leg.phase.positionWeight,rotation:leg.phase.rotationWeight,plant:leg.phase.plantWeight},pelvisOffset:this.pelvisOffset,target:leg.debug.target?.clone() ?? null });
    return { left:copy(this.legs.left),right:copy(this.legs.right) };
  }
}
