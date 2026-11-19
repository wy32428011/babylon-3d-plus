import { Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector.js';

/**
 * 原创男性自然步行步态。
 * 本片段由世界空间足部轨迹与两段腿解析IK生成：两脚各走一条平行线，脚跟着地→屈膝缓冲→放平中段→绕前掌抬跟→平滑摆动折叠，
 * 支撑中段接近伸直，骨盆随步适度侧倾扭转并带双频微动，胸腔反向稳定，锁骨/大臂/前臂/手腕具备多关节惯性滞后。
 * 只依赖参考骨架与实测鞋底尺寸。
 */
export const COMMUTE_WALK = Object.freeze({
  // 默认步速1.6m/s、人物缩放约0.957时作者单位约1.67m/s；
  // 133步/分钟（0.90s）配合1.50m周期与59%支撑占比，在1.6m/s下基本无需步幅拉伸（strideScale≈1.004），
  // 同时避免过高步频的急促感与过短双支撑的飘浮感。
  duration: 0.88,          // 约136步/分钟，贴合本人物腿长比例的自然稳健快走
  stride: 1.445,           // 周期距离（两步），默认1.6m/s下 strideScale≈1.019
  lead: 'auto',            // 着地时踝部在骨盆前方占支撑后移量的比例；auto取使骨盆起伏最小的值
  stanceFraction: 0.56,    // 单脚支撑占周期比例（每次双支撑约6%，周期双支撑约12%，避免骨盆下沉过深）
  trackHalfWidth: 0.056,   // 两脚踝各距中线5.6cm（步宽约11.2cm）
  toeOut: 0.095,           // 脚尖外展约5.5°
  heelStrikePitch: 0.25,   // 着地时脚尖上翘约14.3°
  heelRiseStart: 0.58,     // 支撑相58%（周期约32.5%）开始平稳抬跟
  toeOffPitch: 0.46,       // 离地时绕前掌抬跟约26.4°，保证蹬离期踝部抬升与屈膝衔接
  swingClearance: 0.072,   // 摆动初-中段鞋底抬高，驱动自然的55°-60°屈膝折叠
  swingPeak: 0.30,         // 摆动高度峰值偏前（约周期69%），符合真实摆腿折叠时相
  reach: 0.996,            // 腿长利用率；直腿时保留约5°-7°自然微屈，避免锁死
  midstanceSlack: 0.007,   // 单支撑中段骨盆允许低于直腿高度的量，平衡挺拔度与骨盆起伏
  swingTangent: 0.32,      // 摆动端点切线占地面速度比例，平缓衔接支撑速度，降低着地/离地加速度尖峰
  pelvisRoll: 0.042,       // 骨盆侧倾约±2.4°（全幅约4.8°，位于2°-7°自然区间）
  pelvisYaw: 0.056,        // 骨盆水平扭转约±3.2°（全幅约6.4°，位于2°-8°自然区间）
  pelvisTilt: 0.025,       // 骨盆基础微前倾约1.4°
  pelvisPitchSwing: 0.014, // 双频骨盆俯仰韵律约±0.8°
  chestCounterYaw: 0.075,  // 胸部相对骨盆反向扭转约±4.3°
  chestCounterRoll: 0.022, // 胸部轻微反向侧倾稳定肩线
  chestPitchSwing: 0.010,  // 双频胸腔微动
  forwardLean: 0.045,      // 上身微前倾约2.6°
  shoulderYaw: 0.032,      // 锁骨随摆臂前后牵伸约±1.8°
  shoulderRoll: 0.015,     // 锁骨微幅随步起伏
  armSwing: 0.34,          // 肩部前后摆幅约±19.5°
  armBias: 0.04,           // 前摆略大于后摆，贴合真实自然摆臂
  armAdduct: 0.042,        // 前摆时大臂轻微内收约2.4°
  armHang: 0.15,           // 手臂基础外展约8.6°
  armLag: 0.04,            // 大臂滞后下肢相位
  elbowBase: 0.24,         // 肘部后摆基础微屈约14°
  elbowSwing: 0.28,        // 前摆平滑增加屈肘至约30°
  elbowLag: 0.07,          // 前臂惯性滞后
  wristSwing: 0.055,       // 手腕柔和惯性随动约±3.2°
  wristLag: 0.09,          // 手腕滞后前臂
  headYawKeep: 0.18,       // 头颈保留少量胸腔残余转角，避免机械云台感
  headNod: 0.012,          // 随步频的轻微自然点头微动
  source: { kind: 'original-authored-commute-walk', author: 'project manual-roam asset pipeline',
    description: 'Male commuter walk solved offline from world-space foot trajectories (heel strike, loading response, flat foot, ball roll, smooth swing fold) with analytic two-bone leg IK and multi-joint upper-body inertia; not motion capture' },
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
  const swingPeak = config.swingPeak ?? 0.36;
  let lead = 0.5;
  const leg = side => ({ upper: Vector3.Distance(point(side + 'UpLeg'), point(side + 'Leg')), lower: Vector3.Distance(point(side + 'Leg'), point(side + 'Foot')), offset: point(side + 'UpLeg').subtract(hipsRest) });
  const legs = { Left: leg('Left'), Right: leg('Right') };
  const sign = side => side === 'Left' ? 1 : -1;
  const orientation = (side, pitch) => rot(axisY, sign(side) * config.toeOut).multiply(rot(axisX, pitch));

  /** 支撑相：脚跟或前掌为支点随地面后移，踝部由支点反算，鞋底始终贴地。progress 为支撑进度0..1。 */
  function stanceFoot(side, progress) {
    const anchor = new Vector3(sign(side) * config.trackHalfWidth, -geometry.soleY, sweep * (lead - progress));
    let pitch = 0, bend = 0;
    if (progress < 0.16) pitch = -config.heelStrikePitch * (1 - smooth(progress / 0.16));
    else if (progress > config.heelRiseStart) {
      const t = (progress - config.heelRiseStart) / (1 - config.heelRiseStart);
      pitch = config.toeOffPitch * smooth(t);
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
  // 着地与离地时脚相对骨盆以地面速度后移，摆动端点的切线与之匹配，脚落地时不打滑且减少加速度尖峰。
  const tangent = -sweep / stance * (1 - stance) * config.swingTangent;
  /** 摆动相：前后位置用Hermite曲线衔接支撑端点，脚掌由抬跟平滑过渡到翘脚尖，离地曲线端点一阶导数为0。 */
  function swingFoot(side, progress) {
    const pitch = config.toeOffPitch * (1 - smooth(progress / 0.42)) - config.heelStrikePitch * smooth((progress - 0.38) / 0.62);
    const bend = config.toeOffPitch * (1 - smooth(progress / 0.28));
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
    const pitch = config.pelvisTilt + (config.pelvisPitchSwing ?? 0) * Math.cos(2 * w - 0.35);
    // 左脚着地（周期0）时左髋随步前送；单脚支撑中段摆动侧微降。
    return Quaternion.RotationYawPitchRoll(-config.pelvisYaw * Math.cos(w), pitch, config.pelvisRoll * Math.sin(w));
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
  // 骨盆高度为每周期两次下沉的平滑曲线（双支撑中点最低、单支撑中段最高）：
  // 在双腿可达上限之下取最高位置，下沉量取能让单支撑中段接近伸直的最小值。
  const count = 240, dipCenter = (stance - 0.5) / 2;
  const dipShape = cycle => (1 + Math.cos(2 * Math.PI * 2 * (cycle - dipCenter))) / 2;
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
    // 脊柱三节分担“骨盆→胸部”的相对旋转；胸腔带反向扭转、轻微反侧倾稳定肩线与双频微动。
    const chestYaw = config.chestCounterYaw * Math.cos(w);
    const chestPitch = config.forwardLean + (config.chestPitchSwing ?? 0) * Math.cos(2 * w - 0.65);
    const chestRoll = -(config.chestCounterRoll ?? 0) * Math.sin(w);
    const chest = Quaternion.RotationYawPitchRoll(chestYaw, chestPitch, chestRoll);
    const spine = pelvis.conjugate().multiply(chest).normalize();
    set('Spine', power(spine, 0.4)); set('Spine1', power(spine, 0.35)); set('Spine2', power(spine, 0.25));
    // 头颈保留少量胸腔残余转角与轻微自然点头，避免机械云台死锁感。
    const headTarget = Quaternion.RotationYawPitchRoll(chestYaw * (config.headYawKeep ?? 0), 0.02 + (config.headNod ?? 0) * Math.cos(2 * w - 0.9), 0);
    const head = chest.conjugate().multiply(headTarget).normalize();
    set('Neck', power(head, 0.5)); set('Head', power(head, 0.5));
    for (const side of ['Left', 'Right']) {
      // 手臂与同侧腿反相：左脚着地（左腿在前）时左臂在后。
      const swingNorm = -sign(side) * Math.cos(2 * Math.PI * (cycle - config.armLag));
      const swing = config.armSwing * swingNorm + (config.armBias ?? 0);
      const shoulderYaw = -sign(side) * (config.shoulderYaw ?? 0) * swingNorm;
      const shoulderRoll = sign(side) * (config.shoulderRoll ?? 0) * Math.sin(w);
      set(side + 'Shoulder', Quaternion.RotationYawPitchRoll(shoulderYaw, 0, shoulderRoll));
      const adduct = (config.armAdduct ?? 0) * Math.max(0, swingNorm);
      const down = rot(axisZ, -sign(side) * (Math.PI / 2 - Math.max(0.05, config.armHang - adduct)));
      const pitch = rot(axisX, -swing);
      set(side + 'Arm', pitch.multiply(down));
      // 前臂连续屈伸并滞后大臂，避免半周期硬截断为常数。
      const elbowNorm = -sign(side) * Math.cos(2 * Math.PI * (cycle - (config.elbowLag ?? config.armLag)));
      const elbowAngle = config.elbowBase + config.elbowSwing * (0.5 + 0.5 * elbowNorm);
      set(side + 'ForeArm', rot(axisY, -sign(side) * elbowAngle));
      const wristNorm = -sign(side) * Math.cos(2 * Math.PI * (cycle - (config.wristLag ?? config.armLag)));
      set(side + 'Hand', rot(axisY, -sign(side) * (config.wristSwing ?? 0) * wristNorm));
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
