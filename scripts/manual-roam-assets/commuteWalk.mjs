import { Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector.js';

/**
 * 原创男性上班步态。可用的源步行都不合适：Xbot walk 两脚踩一条线、骨盆大幅侧倾扭转，步长偏短，
 * 拉到默认步速后支撑腿全程屈膝；KayKit 为卡通角色，支撑相屈膝约40°、双臂外张。
 * 本片段由世界空间足部轨迹与两段腿解析IK生成：两脚各走一条平行线，脚跟着地→放平→绕前掌抬跟，
 * 支撑腿接近伸直，骨盆只有小幅随步摆动，胸部微量反向扭转，双臂贴身前后摆。只依赖参考骨架与实测鞋底尺寸。
 */
export const COMMUTE_WALK = Object.freeze({
  // 默认步速1.6m/s、人物缩放约0.957时作者单位约1.67m/s；该人物腿长仅约身高46%，自然步行需较快步频，
  // 138步/分钟配合1.455m周期可让骨盆起伏约4.5cm、单支撑中段屈膝约12°，运行时基本不需要步幅拉伸。
  duration: 0.87,          // 138步/分钟，快步上班
  stride: 1.455,           // 周期距离（两步）
  lead: 'auto',            // 着地时踝部在骨盆前方占支撑后移量的比例；auto取使骨盆起伏最小的值
  stanceFraction: 0.56,    // 单脚支撑占周期比例（双支撑各约6%）
  trackHalfWidth: 0.06,    // 两脚踝各距中线6cm
  toeOut: 0.1,             // 脚尖外展约6°
  heelStrikePitch: 0.3,    // 着地时脚尖上翘约17°
  heelRiseStart: 0.55,     // 支撑相55%开始抬跟
  toeOffPitch: 0.5,        // 离地时绕前掌抬跟约29°
  swingClearance: 0.035,   // 摆动中段鞋底最低点离地
  reach: 0.997,            // 腿长利用率；直腿时仍保留约7°屈膝，避免锁死和IK不可达
  midstanceSlack: 0.008,   // 单支撑中段骨盆允许低于直腿高度的量；越大屈膝越多、起伏越小
  swingTangent: 0.15,      // 摆动端点切线占地面速度的比例；过大时脚在离地后继续后甩、着地前过度前伸
  pelvisRoll: 0.03,        // 约1.7°
  pelvisYaw: 0.05,         // 约2.9°
  pelvisTilt: 0.02,
  chestCounterYaw: 0.07,   // 胸部相对骨盆反向扭转约4°
  forwardLean: 0.05,       // 上身前倾约3°
  armSwing: 0.3,           // 肩部前后摆约±17°
  armHang: 0.16,           // 手臂外展约9°，与待机一致
  armLag: 0.04,
  elbowBase: 0.26,         // 肘部基础屈曲约15°
  elbowSwing: 0.16,        // 前摆时额外屈曲约9°
  source: { kind: 'original-authored-commute-walk', author: 'project manual-roam asset pipeline',
    description: 'Male commuter walk solved offline from world-space foot trajectories (heel strike, flat foot, ball roll) with analytic two-bone leg IK; not motion capture' },
});

const smooth = t => { t = Math.max(0, Math.min(1, t)); return t * t * (3 - 2 * t); };
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

/**
 * geometry 为放平鞋底后相对踝部的尺寸（米）：heelZ 脚跟、ballZ 前掌（趾关节下方）、toeZ 鞋尖、soleY 鞋底；
 * footPitch 为参考姿态下放平鞋底所需的脚骨俯仰补偿。返回按时间采样的局部旋转与骨盆高度。
 */
export function createCommuteWalkSampler(restPoints, names, parents, geometry, footPitch, config = COMMUTE_WALK) {
  const point = n => { const i = names.indexOf(n); if (i < 0 || !restPoints[i]) throw new Error(`步行骨架缺少${n}`); return restPoints[i]; };
  for (const side of ['Left', 'Right']) {
    if (parents[names.indexOf(side + 'UpLeg')] !== 'Hips' || parents[names.indexOf(side + 'Leg')] !== side + 'UpLeg'
      || parents[names.indexOf(side + 'Foot')] !== side + 'Leg' || parents[names.indexOf(side + 'ToeBase')] !== side + 'Foot') throw new Error('步行腿部父链不兼容');
  }
  const heel = new Vector3(0, geometry.soleY, geometry.heelZ), ball = new Vector3(0, geometry.soleY, geometry.ballZ), tip = new Vector3(0, geometry.soleY, geometry.toeZ);
  const stance = config.stanceFraction, sweep = config.stride * stance, hipsRest = point('Hips');
  let lead = 0.5;
  const leg = side => ({ upper: Vector3.Distance(point(side + 'UpLeg'), point(side + 'Leg')), lower: Vector3.Distance(point(side + 'Leg'), point(side + 'Foot')), offset: point(side + 'UpLeg').subtract(hipsRest) });
  const legs = { Left: leg('Left'), Right: leg('Right') };
  const sign = side => side === 'Left' ? 1 : -1;
  const orientation = (side, pitch) => rot(axisY, sign(side) * config.toeOut).multiply(rot(axisX, pitch));

  /** 支撑相：脚跟或前掌为支点随地面后移，踝部由支点反算，鞋底始终贴地。progress 为支撑进度0..1。 */
  function stanceFoot(side, progress) {
    const anchor = new Vector3(sign(side) * config.trackHalfWidth, -geometry.soleY, sweep * (lead - progress));
    let pitch = 0, bend = 0;
    if (progress < 0.15) pitch = -config.heelStrikePitch * (1 - smooth(progress / 0.15));
    else if (progress > config.heelRiseStart) { pitch = config.toeOffPitch * smooth((progress - config.heelRiseStart) / (1 - config.heelRiseStart)); bend = pitch; }
    const yaw = rot(axisY, sign(side) * config.toeOut), q = orientation(side, pitch), pivot = pitch < 0 ? heel : ball;
    const ground = anchor.add(pivot.applyRotationQuaternion(yaw));
    return { ankle: ground.subtract(pivot.applyRotationQuaternion(q)), pitch, bend };
  }
  const lowestOffset = (q, bend) => {
    const toe = ball.add(tip.subtract(ball).applyRotationQuaternion(rot(axisX, -bend)));
    return Math.min(...[heel, ball, toe].map(p => p.applyRotationQuaternion(q).y));
  };
  let lift, land;
  // 着地与离地时脚相对骨盆以地面速度后移，摆动端点的切线与之匹配，脚落地时不打滑。
  const tangent = -sweep / stance * (1 - stance) * config.swingTangent;
  /** 摆动相：前后位置用Hermite曲线衔接支撑端点，脚掌由抬跟回到翘脚尖，最低鞋底点按离地曲线抬高。 */
  function swingFoot(side, progress) {
    const pitch = config.toeOffPitch * (1 - smooth(progress / 0.45)) - config.heelStrikePitch * smooth((progress - 0.35) / 0.65);
    const bend = config.toeOffPitch * (1 - smooth(progress / 0.3));
    const q = orientation(side, pitch), clearance = config.swingClearance * Math.sin(Math.PI * progress) ** 0.8;
    const z = hermite(lift.ankle.z, land.ankle.z, tangent, tangent, progress);
    const x = Math.abs(lift.ankle.x) + (Math.abs(land.ankle.x) - Math.abs(lift.ankle.x)) * smooth(progress);
    return { ankle: new Vector3(sign(side) * x, clearance - lowestOffset(q, bend), z), pitch, bend };
  }
  const foot = (side, cycle) => cycle < stance ? stanceFoot(side, cycle / stance) : swingFoot(side, (cycle - stance) / (1 - stance));
  const phases = cycle => ({ Left: wrap(cycle), Right: wrap(cycle + 0.5) });
  const pelvisAt = cycle => {
    const w = 2 * Math.PI * cycle;
    // 左脚着地（周期0）时左髋随步前送；单脚支撑中段摆动侧微降。
    return Quaternion.RotationYawPitchRoll(-config.pelvisYaw * Math.cos(w), config.pelvisTilt, config.pelvisRoll * Math.sin(w));
  };
  const hipLimit = cycle => {
    const pelvis = pelvisAt(cycle), p = phases(cycle);
    let limit = Infinity;
    for (const side of ['Left', 'Right']) {
      const target = foot(side, p[side]).ankle, offset = legs[side].offset.applyRotationQuaternion(pelvis), reach = (legs[side].upper + legs[side].lower) * config.reach;
      const dx = target.x - (hipsRest.x + offset.x), dz = target.z - (hipsRest.z + offset.z), horizontal = dx * dx + dz * dz;
      if (horizontal >= reach * reach) throw new Error(`步行脚位超出腿部可达范围：${side} 周期${cycle.toFixed(3)}`);
      limit = Math.min(limit, target.y + Math.sqrt(reach * reach - horizontal) - offset.y - hipsRest.y);
    }
    return limit;
  };
  // 骨盆高度为每周期两次下沉的平滑曲线（双支撑最低、单支撑中段最高）：在双腿可达上限之下取最高位置，
  // 下沉量取能让单支撑中段几乎伸直的最小值；着地位置在候选中取使下沉量最小者。
  const count = 240, dipCenter = (stance - 0.5) / 2;
  const dipShape = cycle => (1 + Math.cos(2 * Math.PI * (2 * (cycle - dipCenter)))) / 2;
  function plan() {
    lift = stanceFoot('Left', 1); land = stanceFoot('Left', 0);
    const limits = Array.from({ length: count }, (_, i) => hipLimit(i / count)), peak = Math.max(...limits);
    let best = null;
    for (let drop = 0; drop <= 0.2 + 1e-9; drop += 0.0005) {
      const top = Math.min(...limits.map((limit, i) => limit + drop * dipShape(i / count)));
      if (top >= peak - config.midstanceSlack) { best = { top, drop }; break; }
    }
    if (!best) throw new Error('步行骨盆下沉超过20厘米，步幅与腿长不匹配');
    return best;
  }
  let hip;
  if (config.lead === 'auto') {
    let choice = null;
    for (let candidate = 0.3; candidate <= 0.6 + 1e-9; candidate += 0.01) {
      lead = candidate;
      try { const result = plan(); if (!choice || result.drop < choice.result.drop) choice = { lead: candidate, result }; } catch { /* 该着地位置不可达 */ }
    }
    if (!choice) throw new Error('步行脚位超出腿部可达范围');
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
      // 鞋底世界朝向 = 足部轨迹朝向 × 参考姿态放平补偿；趾骨反向弯曲使前掌支撑时鞋尖贴地。
      set(side + 'Foot', shin.conjugate().multiply(orientation(side, pitch)).multiply(rot(axisX, footPitch[side])));
      set(side + 'ToeBase', rot(axisX, -bend));
    }
    // 脊柱三节等分“骨盆→胸部”的相对旋转，胸部仅保留前倾与小幅反向扭转；头颈抵消胸部扭转保持平视。
    const chest = Quaternion.RotationYawPitchRoll(config.chestCounterYaw * Math.cos(w), config.forwardLean, 0);
    const spine = pelvis.conjugate().multiply(chest).normalize();
    set('Spine', power(spine, 0.4)); set('Spine1', power(spine, 0.35)); set('Spine2', power(spine, 0.25));
    const head = chest.conjugate().multiply(Quaternion.RotationYawPitchRoll(0, 0.02, 0)).normalize();
    set('Neck', power(head, 0.5)); set('Head', power(head, 0.5));
    for (const side of ['Left', 'Right']) {
      // 手臂与同侧腿反相：左脚着地（左腿在前）时左臂在后。
      const swing = -sign(side) * config.armSwing * Math.cos(2 * Math.PI * (cycle - config.armLag));
      const down = rot(axisZ, -sign(side) * (Math.PI / 2 - config.armHang)), pitch = rot(axisX, -swing);
      set(side + 'Arm', pitch.multiply(down));
      set(side + 'ForeArm', rot(axisY, -sign(side) * (config.elbowBase + config.elbowSwing * Math.max(0, swing / config.armSwing))));
    }
    return { local, hipY };
  };
  sampler.hipRange = hip.drop;
  sampler.lead = lead;
  return sampler;
}

/** 原创步行的精确标定：步速、周期距离与接触曲线直接来自作者参数，左脚着地为相位0。
 *  通用的踝/前掌后移标定会把脚跟、前掌滚动带来的踝部位移误计为步长，因此不用于本片段。 */
export function commuteWalkCalibration(times, config = COMMUTE_WALK) {
  const n = times.length - 1, duration = times.at(-1) - times[0];
  if (!(n >= 8 && Math.abs(duration - config.duration) < 1e-6)) throw new Error('原创步行标定时间无效');
  const stance = cycle => wrap(cycle) < config.stanceFraction ? 1 : 0;
  const curve = offset => {
    const raw = Array.from({ length: n }, (_, i) => stance(i / n + offset));
    const smoothed = raw.map((value, i) => (raw[(i + n - 1) % n] + 2 * value + raw[(i + 1) % n]) / 4);
    return [...smoothed, smoothed[0]];
  };
  return { referenceSpeed: config.stride / config.duration, cycleDistanceMeters: config.stride, phaseOffset: 0,
    contacts: { left: curve(0), right: curve(0.5) }, calibration: 'authored-commute-walk-exact-v1' };
}
