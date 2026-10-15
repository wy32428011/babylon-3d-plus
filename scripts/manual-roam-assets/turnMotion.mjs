import { Matrix, Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector.js';

export const TURN_MOTION_DEFINITIONS = Object.freeze(Object.fromEntries([90].flatMap(degrees=>['Left','Right'].map(side=>[
  `Turn${side}${degrees}`, {angleRadians:(side==='Left'?1:-1)*degrees*Math.PI/180,duration:.8,loop:false,
    source:{kind:'original-authored-turn-keyframes',author:'project manual-roam asset pipeline',description:'Two-step pivot authored offline with planted world-space ankle constraints; not motion capture or a downloaded native turn'}}
]))));
const ease=t=>t*t*(3-2*t);
const clamp=t=>Math.max(0,Math.min(1,t));
function fromTo(a,b){a=a.normalizeToNew();b=b.normalizeToNew();const d=Vector3.Dot(a,b);if(d>.999999)return Quaternion.Identity();if(d<-.999999)return Quaternion.RotationAxis(Vector3.Right(),Math.PI);const c=Vector3.Cross(a,b);return new Quaternion(c.x,c.y,c.z,1+d).normalize();}

/** 原创离线双步转身。姿态移除整体yaw，运行时必须按同一rotationProgress旋转视觉根。 */
export function sampleTurnPose(name,normalizedPhase,restPoints,names,parents){
  const definition=TURN_MOTION_DEFINITIONS[name];
  if(!definition||!Number.isFinite(normalizedPhase))throw new Error('转身动作或采样时间无效');
  const point=n=>{const i=names.indexOf(n);if(i<0||!restPoints[i])throw new Error(`转身骨架缺少${n}`);return restPoints[i];};
  const phase=clamp(normalizedPhase),rotationProgress=ease(clamp(phase*2)),angle=definition.angleRadians;
  const bodyYaw=angle*rotationProgress,inverseYaw=Matrix.RotationY(-bodyYaw),lead=angle>0?'Left':'Right';
  const local=names.map(()=>Quaternion.Identity()),targets={},footYaws={},contacts={};
  for(const side of ['Left','Right']){
    const p=clamp(side===lead?phase*2:(phase-.5)*2),progress=ease(p),start=point(side+'Foot');
    // 支撑阶段保持世界锚点；摆动脚沿转弯弧抬起，禁止用整条腿轴映射伪装转身。
    const target=Vector3.TransformCoordinates(start,Matrix.RotationY(angle*progress));
    target.y+=.065*Math.sin(Math.PI*p)**2;
    targets[side]=Vector3.TransformCoordinates(target,inverseYaw);
    footYaws[side]=angle*progress-bodyYaw;
    contacts[side.toLowerCase()]=p<=1e-8||p>=1-1e-8;
  }
  // 为转向后的跨距留出可达余量，骨盆只作局部上下缓冲，不产生世界水平位移。
  let hipY=-.025*Math.sin(Math.PI*phase)**2;
  for(const side of ['Left','Right']){
    const hip=point(side+'UpLeg'),knee=point(side+'Leg'),foot=point(side+'Foot'),target=targets[side];
    const reach=Vector3.Distance(hip,knee)+Vector3.Distance(knee,foot),horizontal=(target.x-hip.x)**2+(target.z-hip.z)**2;
    if(horizontal>=reach*reach)throw new Error('转身脚位超出腿部可达范围');
    hipY=Math.min(hipY,target.y+Math.sqrt(Math.max(0,reach*reach-horizontal))-hip.y-1e-7);
  }
  for(const side of ['Left','Right']){
    const hip=point(side+'UpLeg').add(new Vector3(0,hipY,0)),restKnee=point(side+'Leg'),restFoot=point(side+'Foot'),target=targets[side];
    const upperLength=Vector3.Distance(point(side+'UpLeg'),restKnee),lowerLength=Vector3.Distance(restKnee,restFoot);
    const offset=target.subtract(hip),distance=offset.length(),axis=offset.scale(1/distance);
    const along=(upperLength**2-lowerLength**2+distance**2)/(2*distance),bend=Math.sqrt(Math.max(0,upperLength**2-along**2));
    // 正前方pole保持膝盖前弯，不能跟随脚部yaw把膝盖扭成侧向铰链。
    const forward=new Vector3(0,0,1),pole=forward.subtract(axis.scale(Vector3.Dot(forward,axis))).normalize();
    const knee=hip.add(axis.scale(along)).add(pole.scale(bend));
    const upper=fromTo(restKnee.subtract(point(side+'UpLeg')),knee.subtract(hip));
    const lower=fromTo(restFoot.subtract(restKnee),target.subtract(knee));
    local[names.indexOf(side+'UpLeg')]=upper;
    local[names.indexOf(side+'Leg')]=upper.conjugate().multiply(lower).normalize();
    local[names.indexOf(side+'Foot')]=lower.conjugate().multiply(Quaternion.RotationAxis(Vector3.Up(),footYaws[side])).normalize();
    local[names.indexOf(side+'Arm')]=Quaternion.RotationAxis(Vector3.Forward(),side==='Left'?-1.35:1.35);
  }
  // parents参与契约检查，避免将该局部旋转直接套到不同父链。
  for(const side of ['Left','Right'])if(parents[names.indexOf(side+'UpLeg')]!=='Hips'||parents[names.indexOf(side+'Leg')]!==side+'UpLeg'||parents[names.indexOf(side+'Foot')]!==side+'Leg')throw new Error('转身腿部父链不兼容');
  return {local,hipY,rotationProgress,contacts};
}
