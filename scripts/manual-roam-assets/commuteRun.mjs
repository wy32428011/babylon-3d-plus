import { Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector.js';

/**
 * 原创男性自然跑步步态。
 * 相比旧版 KayKit 卡通跑步（18.6cm深蹲弹跳、单帧膝盖抽搐、无腾空双支撑、直臂后仰），
 * 本片段按巡检人物腿长与 3.2m/s 默认跑速由世界空间足部轨迹与两段腿解析IK生成：
 * 具备真实单脚支撑（36%）+ 双段腾空相（28%）、零双支撑、平滑的弹性骨盆弹道（6-8cm起伏）、
 * 支撑缓冲→蹬离→高摆腿折叠的自然双峰屈膝、前倾躯干与曲肘异侧摆臂。
 */
export const COMMUTE_RUN = Object.freeze({
  // 默认跑速 3.2m/s、人物缩放约 0.957 时作者单位约 3.34m/s；
  // 0.66s（约182步/分钟）配合 2.16m 周期与 32% 单脚支撑（约0.21s触地时间），
  // 既贴合 0.7175m 腿长的伸展几何（避免蹲跑），又具备 36% 真实腾空相且 3.2m/s 时 strideScale≈1.02。
  duration: 0.66,          // 约181.8步/分钟，经典自然慢跑/中跑步频
  stride: 2.14,            // 周期距离（两步，单步1.07m）
  lead: 'auto',            // 着地时踝部在骨盆前方占支撑后移量的比例；auto取使支撑最平稳的值
  stanceFraction: 0.31,    // 单脚支撑占31%（触地约0.205s，无双支撑，两段腾空合计38%）
  trackHalfWidth: 0.042,   // 跑步落脚更贴近中线（步宽约8.4cm）
  toeOut: 0.06,            // 脚尖微外展约3.4°
  heelStrikePitch: 0.12,   // 中前掌/微后跟着地（约7°），避免直腿硬砸
  heelRiseStart: 0.40,     // 支撑中段后迅速转入前掌蹬伸
  toeOffPitch: 0.56,       // 蹬离时前掌发力抬跟约32°
  swingClearance: 0.155,   // 摆动折叠抬脚高度，自然驱动约88°-96°高抬后跟屈膝
  swingPeak: 0.42,         // 抬脚峰值在摆动前中段（约周期59%），形成紧凑的折叠→前摆提膝
  reach: 0.994,            // 跑步保持弹性微屈，不锁直膝盖
  midstanceDip: 0.044,     // 支撑中段相对最高点的缓冲下沉深度（形成约6-7cm总起伏）
  flightLift: 0.018,       // 腾空段相对站立高度的微抬升
  swingTangent: 0.38,      // 摆动端点水平速度平滑衔接支撑地面速度
  pelvisRoll: 0.055,       // 骨盆侧倾约±3.2°
  pelvisYaw: 0.095,        // 骨盆水平扭转约±5.4°
  pelvisTilt: 0.105,       // 骨盆前倾约6°，与胸腔协调前倾，消除反折腰
  pelvisPitchSwing: 0.022, // 双频骨盆俯仰弹跳韵律
  chestCounterYaw: 0.11,   // 胸腔反向扭转约±6.3°
  chestCounterRoll: 0.028, // 胸腔轻微反侧倾稳定肩带
  chestPitchSwing: 0.016,  // 双频胸腔弹性微动
  forwardLean: 0.145,      // 跑步整体前倾约8.3°
  shoulderYaw: 0.055,      // 锁骨随大幅摆臂前后牵伸约±3.2°
  shoulderRoll: 0.022,     // 锁骨随步微动
  armSwing: 0.56,          // 肩部跑步摆臂约±32°
  armBias: 0.06,           // 跑步摆臂略偏前
  armAdduct: 0.075,        // 前摆时大臂自然内收靠向胸前中线
  armHang: 0.14,           // 大臂贴身外展约8°
  armLag: 0.03,            // 摆臂相位滞后
  elbowBase: 1.18,         // 跑步曲肘基础角约68°（后摆约68°，前摆收至约86°，兼顾跑步质感与衣袖蒙皮容差）
  elbowSwing: 0.32,        // 前摆额外收肘约18°
  elbowLag: 0.06,          // 前臂惯性滞后
  wristSwing: 0.07,        // 手腕自然随动约±4°（远低于0.35rad上限）
  wristLag: 0.08,          // 手腕滞后前臂
  headYawKeep: 0.14,       // 头部基本盯住前方并保留少量自然惯性
  headNod: 0.016,          // 随跑步弹跳的柔和点头微动
  source: { kind: 'original-authored-commute-run', author: 'project manual-roam asset pipeline',
    description: 'Male natural jog/run solved offline from world-space foot trajectories with true flight phase, ballistic pelvis arc, analytic two-bone leg IK and bent-arm athletic upper body; not motion capture' },
});

const smooth = t => { t = Math.max(0, Math.min(1, t)); return t * t * (3 - 2 * t); };
const smoother = t => { t = Math.max(0, Math.min(1, t)); return t * t * t * (t * (t * 6 - 15) + 10); };
const wrap = t => ((t % 1) + 1) % 1;
const axisX = Vector3.Right(), axisY = Vector3.Up(), axisZ = new Vector3(0, 0, 1);
const rot = (axis, angle) => Quaternion.RotationAxis(axis, angle);
const power = (q, t) => Quaternion.Slerp(Quaternion.Identity(), q, t).normalize();
function fromTo(a, b) {
  a = a.normalizeToNew(); b = b.normalizeToNew();
  const d = Vector3.Dot(a, b);
  if (d > 0.999999) return Quaternion.Identity();
  if (d < -0.999999) return rot(axisX, Math.PI);
  const c = Vector3.Cross(a, b);
  return new Quaternion(c.x, c.y, c.z, 1 + d).normalize();
}
function hermite(p0, p1, m0, m1, t) {
  const t2 = t * t, t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * p0 + (t3 - 2 * t2 + t) * m0 + (-2 * t3 + 3 * t2) * p1 + (t3 - t2) * m1;
}

export function createCommuteRunSampler(restPoints, names, parents, geometry, footPitch, config = COMMUTE_RUN) {
  const point = n => { const i = names.indexOf(n); if (i < 0 || !restPoints[i]) throw new Error(`跑步骨架缺少${n}`); return restPoints[i]; };
  for (const side of ['Left', 'Right']) {
    if (parents[names.indexOf(side + 'UpLeg')] !== 'Hips' || parents[names.indexOf(side + 'Leg')] !== side + 'UpLeg'
      || parents[names.indexOf(side + 'Foot')] !== side + 'Leg' || parents[names.indexOf(side + 'ToeBase')] !== side + 'Foot') throw new Error('跑步腿部父链不兼容');
  }
  const heel = new Vector3(0, geometry.soleY, geometry.heelZ), ball = new Vector3(0, geometry.soleY, geometry.ballZ), tip = new Vector3(0, geometry.soleY, geometry.toeZ);
  const stance = config.stanceFraction, sweep = config.stride * stance, hipsRest = point('Hips');
  const swingPeak = config.swingPeak ?? 0.38;
  let lead = 0.42;
  const leg = side => ({ upper: Vector3.Distance(point(side + 'UpLeg'), point(side + 'Leg')), lower: Vector3.Distance(point(side + 'Leg'), point(side + 'Foot')), offset: point(side + 'UpLeg').subtract(hipsRest) });
  const legs = { Left: leg('Left'), Right: leg('Right') };
  const sign = side => side === 'Left' ? 1 : -1;
  const orientation = (side, pitch) => rot(axisY, sign(side) * config.toeOut).multiply(rot(axisX, pitch));

  /** 支撑相：中前掌着地迅速放平承重缓冲，随后绕前掌有力蹬伸。 */
  function stanceFoot(side, progress) {
    const anchor = new Vector3(sign(side) * config.trackHalfWidth, -geometry.soleY, sweep * (lead - progress));
    let pitch = 0, bend = 0;
    if (progress < 0.18) pitch = -config.heelStrikePitch * (1 - smooth(progress / 0.18));
    else if (progress > config.heelRiseStart) {
      const t = (progress - config.heelRiseStart) / (1 - config.heelRiseStart);
      pitch = config.toeOffPitch * smoother(t);
      bend = pitch;
    }
    const yaw = rot(axisY, sign(side) * config.toeOut), q = orientation(side, pitch), pivot = pitch < 0 ? heel : ball;
    const ground = anchor.add(pivot.applyRotationQuaternion(yaw));
    return { ankle: ground.subtract(pivot.applyRotationQuaternion(q)), pitch, bend };
  }
  const lowestOffset = (q, bend) => {
    const toe = ball.add(tip.subtract(ball).applyRotationQuaternion(rot(axisX, -bend)));
    return Math.min(...[heel, ball, toe].map(p => p.applyRotationQuaternion(q).y));
  };
  let lift, land;
  const tangent = -sweep / stance * (1 - stance) * config.swingTangent;
  /** 摆动相：蹬离后脚跟高收折叠，中后段顺滑前摆提膝并准备落地。 */
  function swingFoot(side, progress) {
    const pitch = config.toeOffPitch * (1 - smooth(progress / 0.45)) - config.heelStrikePitch * smooth((progress - 0.55) / 0.45);
    const bend = config.toeOffPitch * (1 - smooth(progress / 0.30));
    const q = orientation(side, pitch);
    const liftBump = progress < swingPeak ? smoother(progress / swingPeak) : 1 - smoother((progress - swingPeak) / (1 - swingPeak));
    const clearance = config.swingClearance * liftBump;
    const z = hermite(lift.ankle.z, land.ankle.z, tangent, tangent, progress);
    const x = Math.abs(lift.ankle.x) + (Math.abs(land.ankle.x) - Math.abs(lift.ankle.x)) * smooth(progress);
    return { ankle: new Vector3(sign(side) * x, clearance - lowestOffset(q, bend), z), pitch, bend };
  }
  const foot = (side, cycle) => cycle < stance ? stanceFoot(side, cycle / stance) : swingFoot(side, (cycle - stance) / (1 - stance));
  const phases = cycle => ({ Left: wrap(cycle), Right: wrap(cycle + 0.5) });
  const pelvisAt = cycle => {
    const w = 2 * Math.PI * cycle;
    // 跑步骨盆前倾并随双步弹性起伏微动；左脚落地时左髋前送，支撑中段摆动侧微降。
    const pitch = config.pelvisTilt + (config.pelvisPitchSwing ?? 0) * Math.cos(2 * w - 0.6);
    return Quaternion.RotationYawPitchRoll(-config.pelvisYaw * Math.cos(w), pitch, config.pelvisRoll * Math.sin(w));
  };
  const hipLimit = cycle => {
    const pelvis = pelvisAt(cycle), p = phases(cycle);
    let limit = Infinity;
    for (const side of ['Left', 'Right']) {
      const target = foot(side, p[side]).ankle, offset = legs[side].offset.applyRotationQuaternion(pelvis), reach = (legs[side].upper + legs[side].lower) * config.reach;
      const dx = target.x - (hipsRest.x + offset.x), dz = target.z - (hipsRest.z + offset.z), horizontal = dx * dx + dz * dz;
      if (horizontal >= reach * reach) throw new Error(`跑步脚位超出腿部可达范围：${side} 周期${cycle.toFixed(3)}`);
      limit = Math.min(limit, target.y + Math.sqrt(reach * reach - horizontal) - offset.y - hipsRest.y);
    }
    return limit;
  };
  // 跑步弹簧-质点骨盆弹道：支撑中段（cycle≈stance/2 与 0.5+stance/2）达到最低缓冲谷，
  // 腾空中段（cycle≈(stance+0.5)/2 与 0.5+(stance+0.5)/2）达到最高点。
  const count = 240;
  const dipCenter = stance * 0.48;
  const dipShape = cycle => (1 + Math.cos(2 * Math.PI * 2 * (cycle - dipCenter))) / 2;
  function plan() {
    lift = stanceFoot('Left', 1); land = stanceFoot('Left', 0);
    const limits = Array.from({ length: count }, (_, i) => hipLimit(i / count));
    const minLimit = Math.min(...limits);
    // 在满足全周期双腿可达的前提下，按弹性下沉深度构建 6–8cm 的自然跑步弹道。
    const targetDrop = Math.max(0.055, config.midstanceDip + config.flightLift);
    let best = null;
    for (let drop = targetDrop; drop <= 0.14 + 1e-9; drop += 0.001) {
      const top = Math.min(...limits.map((limit, i) => limit + drop * dipShape(i / count)));
      if (top - drop <= minLimit + 1e-6) {
        best = { top: Math.min(top, config.flightLift), drop };
        // 确保不越过任何一帧的腿长可达上限
        const safeTop = Math.min(best.top, ...limits.map((limit, i) => limit + drop * dipShape(i / count)));
        best = { top: safeTop, drop };
        break;
      }
    }
    if (!best) throw new Error('跑步骨盆弹道超出腿部可达范围');
    return best;
  }
  let hip;
  if (config.lead === 'auto') {
    let choice = null;
    for (let candidate = 0.28; candidate <= 0.52 + 1e-9; candidate += 0.01) {
      lead = candidate;
      try {
        const result = plan();
        // 偏好最高点接近站立微腾空（top 越高越不蹲跑）
        if (!choice || result.top > choice.result.top) choice = { lead: candidate, result };
      } catch { /* 该着地位置不可达 */ }
    }
    if (!choice) throw new Error('跑步脚位超出腿部可达范围');
    lead = choice.lead; hip = plan();
  } else { lead = config.lead; hip = plan(); }
  const hipAt = cycle => hip.top - hip.drop * dipShape(wrap(cycle));

  const sampler = time => {
    const cycle = wrap(time / config.duration), w = 2 * Math.PI * cycle, local = names.map(() => Quaternion.Identity());
    const set = (name, q) => { local[names.indexOf(name)] = q.normalize(); };
    const pelvis = pelvisAt(cycle), hipY = hipAt(cycle), hips = hipsRest.add(new Vector3(0, hipY, 0)), p = phases(cycle);
    set('Hips', pelvis);
    for (const side of ['Left', 'Right']) {
      const { ankle, pitch, bend } = foot(side, p[side]), { upper, lower, offset } = legs[side];
      const hip = hips.add(offset.applyRotationQuaternion(pelvis)), toTarget = ankle.subtract(hip);
      const distance = Math.min(toTarget.length(), upper + lower - 1e-6), axis = toTarget.normalizeToNew();
      const along = (upper * upper - lower * lower + distance * distance) / (2 * distance), bendOut = Math.sqrt(Math.max(0, upper * upper - along * along));
      const forward = new Vector3(Math.sin(sign(side) * config.toeOut * 0.5), 0, Math.cos(config.toeOut * 0.5));
      const pole = forward.subtract(axis.scale(Vector3.Dot(forward, axis))).normalize();
      const knee = hip.add(axis.scale(along)).add(pole.scale(bendOut)), ankleReached = hip.add(axis.scale(distance));
      const thigh = fromTo(point(side + 'Leg').subtract(point(side + 'UpLeg')), knee.subtract(hip));
      const shin = fromTo(point(side + 'Foot').subtract(point(side + 'Leg')), ankleReached.subtract(knee));
      set(side + 'UpLeg', pelvis.conjugate().multiply(thigh));
      set(side + 'Leg', thigh.conjugate().multiply(shin));
      set(side + 'Foot', shin.conjugate().multiply(orientation(side, pitch)).multiply(rot(axisX, footPitch[side])));
      set(side + 'ToeBase', rot(axisX, -bend));
    }
    const chestYaw = config.chestCounterYaw * Math.cos(w);
    const chestPitch = config.forwardLean + (config.chestPitchSwing ?? 0) * Math.cos(2 * w - 0.8);
    const chestRoll = -(config.chestCounterRoll ?? 0) * Math.sin(w);
    const chest = Quaternion.RotationYawPitchRoll(chestYaw, chestPitch, chestRoll);
    const spine = pelvis.conjugate().multiply(chest).normalize();
    set('Spine', power(spine, 0.4)); set('Spine1', power(spine, 0.35)); set('Spine2', power(spine, 0.25));
    const headTarget = Quaternion.RotationYawPitchRoll(chestYaw * (config.headYawKeep ?? 0), 0.03 + (config.headNod ?? 0) * Math.cos(2 * w - 1.0), 0);
    const head = chest.conjugate().multiply(headTarget).normalize();
    set('Neck', power(head, 0.5)); set('Head', power(head, 0.5));
    for (const side of ['Left', 'Right']) {
      const swingNorm = -sign(side) * Math.cos(2 * Math.PI * (cycle - config.armLag));
      const swing = config.armSwing * swingNorm + (config.armBias ?? 0);
      const shoulderYaw = -sign(side) * (config.shoulderYaw ?? 0) * swingNorm;
      const shoulderRoll = sign(side) * (config.shoulderRoll ?? 0) * Math.sin(w);
      set(side + 'Shoulder', Quaternion.RotationYawPitchRoll(shoulderYaw, 0, shoulderRoll));
      const adduct = (config.armAdduct ?? 0) * Math.max(0, swingNorm);
      const down = rot(axisZ, -sign(side) * (Math.PI / 2 - Math.max(0.04, config.armHang - adduct)));
      const pitch = rot(axisX, -swing);
      set(side + 'Arm', pitch.multiply(down));
      const elbowNorm = -sign(side) * Math.cos(2 * Math.PI * (cycle - (config.elbowLag ?? config.armLag)));
      const elbowAngle = config.elbowBase + config.elbowSwing * (0.5 + 0.5 * elbowNorm);
      set(side + 'ForeArm', rot(axisY, -sign(side) * elbowAngle));
      const wristNorm = -sign(side) * Math.cos(2 * Math.PI * (cycle - (config.wristLag ?? config.armLag)));
      set(side + 'Hand', rot(axisY, -sign(side) * (config.wristSwing ?? 0) * wristNorm));
    }
    return { local, hipY };
  };
  sampler.hipRange = hip.drop;
  sampler.hipTop = hip.top;
  sampler.lead = lead;
  return sampler;
}

/** 原创跑步的精确标定：步速、周期距离与含真实腾空相的接触曲线直接来自作者参数，左脚着地为相位0。 */
export function commuteRunCalibration(times, config = COMMUTE_RUN) {
  const n = times.length - 1, duration = times.at(-1) - times[0];
  if (!(n >= 8 && Math.abs(duration - config.duration) < 1e-6)) throw new Error('原创跑步标定时间无效');
  const stance = cycle => wrap(cycle) < config.stanceFraction ? 1 : 0;
  const curve = offset => {
    const raw = Array.from({ length: n }, (_, i) => stance(i / n + offset));
    const smoothed = raw.map((value, i) => (raw[(i + n - 1) % n] + 2 * value + raw[(i + 1) % n]) / 4);
    return [...smoothed, smoothed[0]];
  };
  return { referenceSpeed: config.stride / config.duration, cycleDistanceMeters: config.stride, phaseOffset: 0,
    contacts: { left: curve(0), right: curve(0.5) }, calibration: 'authored-commute-run-exact-v1' };
}
