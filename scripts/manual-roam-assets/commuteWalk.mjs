import { Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector.js';

/**
 * 原创男性自然步行步态。
 * 本片段由世界空间足部轨迹与两段腿解析IK生成：两脚各走一条平行线，脚跟着地→柔和屈膝缓冲→支撑中段自然伸展→
 * 绕前掌加速抬跟蹬离→顺应小腿倾角的放松摆动折叠（消除双支撑W形反折膝与摆动勾踝），骨盆带自然侧向重心转移与侧倾扭转，
 * 胸腔反向稳定，肩臂自然微内旋与前臂轻度旋前，呈现贴身对称、带多关节惯性滞后的流畅摆臂。
 * 只依赖参考骨架与实测鞋底尺寸。
 */
export const COMMUTE_WALK = Object.freeze({
  // 默认步速1.6m/s、人物缩放约0.9567时作者单位约1.67m/s；
  // 0.83s（约144.6步/分钟，1.6m/s实际约142步/分钟）配合1.365m周期（世界1.306m，更贴合0.754m髋高无量纲比例），
  // 在1.6m/s下 strideScale≈1.017（<=1.02），步幅紧凑挺拔、消除过跨导致的深蹲走与反折膝。
  duration: 0.83,          // 约142步/分钟（默认1.6m/s），贴合本人物腿长比例的自然稳健步行
  stride: 1.365,           // 周期距离（两步，单步作者0.683m / 世界0.653m）
  lead: 'auto',            // 着地时踝部在骨盆前方占支撑后移量的比例；auto取使骨盆起伏最小的值
  stanceFraction: 0.565,   // 单脚支撑占周期56.5%（每次双支撑6.5%，周期双支撑13%，兼顾落地稳重与几何可达性）
  trackHalfWidth: 0.068,   // 两脚踝各距中线6.8cm（步宽13.6cm），配合±1.4cm重心横移仍保持宽稳平行步线
  toeOut: 0.105,           // 脚尖自然外展约6.0°
  heelStrikePitch: 0.21,   // 着地时脚尖柔和上翘约12.0°
  heelRiseStart: 0.62,     // 支撑相62%（周期约35%）开始平滑加速抬跟（采用幂函数加速而非末尾平台化的smooth）
  toeOffPitch: 0.56,       // 离地时绕前掌抬跟约32.1°，确保蹬离末段持续发力抬跟、后腿屈膝单调递增无反折
  swingClearance: 0.017,   // 摆动期鞋底真实最低点离地高度（约1.6-2.0cm真实步行最小脚尖间隙），自然驱动约60°-64°屈膝折叠
  swingPeak: 0.34,         // 摆动高度峰值偏前（摆动34%、约周期71%），贴合自然摆腿折叠时相
  reach: 0.996,            // 腿长利用率；单支撑中段保留自然微屈，避免膝盖锁死
  midstanceSlack: 0.008,   // 单支撑中段骨盆柔和松弛量，兼顾挺拔度与4.2cm左右的自然骨盆起伏
  swingTangent: 0.34,      // 摆动端点切线占地面速度比例，平缓衔接支撑地面速度
  pelvisSwayX: 0.014,      // 骨盆随支撑脚自然横向重心转移±1.4cm（零均值闭环，消除滑轨木偶感）
  pelvisRoll: 0.048,       // 骨盆侧倾约±2.75°（全幅约5.5°，位于2°-7°自然区间）
  pelvisYaw: 0.060,        // 骨盆水平扭转约±3.4°（全幅约6.9°，位于2°-8°自然区间）
  pelvisTilt: 0.022,       // 骨盆基础微前倾约1.3°
  pelvisPitchSwing: 0.012, // 双频骨盆俯仰韵律约±0.7°
  chestCounterYaw: 0.084,  // 胸部相对骨盆反向扭转约±4.8°
  chestCounterRoll: 0.026, // 胸部反向侧倾稳定肩带
  chestPitchSwing: 0.010,  // 双频胸腔呼吸与步韵微动
  forwardLean: 0.048,      // 上身自然微前倾约2.8°
  shoulderYaw: 0.036,      // 锁骨随摆臂前后牵伸约±2.1°
  shoulderRoll: 0.016,     // 锁骨微幅随步起伏
  armSwing: 0.31,          // 肩部前后摆幅约±17.8°
  armBias: -0.045,         // 轻微后偏补偿屈肘前探，使手部前后摆动更对称自然，告别前伸僵直感
  armAdduct: 0.048,        // 前摆时大臂自然轻度内收
  armHang: 0.105,          // 手臂贴身自然下垂（约6°外展），告别外撑企鹅臂
  armInternalRot: 0.16,    // 大臂基础自然内旋约9°，让屈肘与手掌不再僵硬朝正前
  armInternalSwing: 0.08,  // 前摆时额外微内旋，手向身体中线柔和收拢
  foreArmPronation: 0.18,  // 前臂轻度自然旋前约10°，拇指微向大腿前内侧放松
  armLag: 0.04,            // 大臂滞后下肢相位
  elbowBase: 0.18,         // 肘部后摆自然微屈约10°
  elbowSwing: 0.30,        // 前摆平滑增加屈肘至约28°
  elbowLag: 0.08,          // 前臂惯性滞后，形成柔和的摆臂甩动质感
  wristSwing: 0.055,       // 手腕柔和惯性随动约±3.2°
  wristLag: 0.10,          // 手腕滞后前臂
  headYawKeep: 0.16,       // 头颈保留少量胸腔残余转角，避免机械云台感
  headNod: 0.010,          // 随步频的轻微自然点头微动
  source: { kind: 'original-authored-commute-walk', author: 'project manual-roam asset pipeline',
    description: 'Male commuter walk solved offline from world-space foot trajectories (heel strike, smooth loading, midstance extension, accelerating ball-roll push-off, shank-coupled natural swing ankle) with analytic two-bone leg IK, lateral pelvic weight shift and natural pronated arm swing; not motion capture' },
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
 * footPitch 为参考姿态下放平鞋底所需的脚骨俯仰补偿。返回按时间采样的局部旋转、骨盆高度与侧向重心微移。
 */
export function createCommuteWalkSampler(restPoints, names, parents, geometry, footPitch, config = COMMUTE_WALK) {
  const point = n => { const i = names.indexOf(n); if (i < 0 || !restPoints[i]) throw new Error(`步行骨架缺少${n}`); return restPoints[i]; };
  for (const side of ['Left', 'Right']) {
    if (parents[names.indexOf(side + 'UpLeg')] !== 'Hips' || parents[names.indexOf(side + 'Leg')] !== side + 'UpLeg'
      || parents[names.indexOf(side + 'Foot')] !== side + 'Leg' || parents[names.indexOf(side + 'ToeBase')] !== side + 'Foot') throw new Error('步行腿部父链不兼容');
  }
  const heel = new Vector3(0, geometry.soleY, geometry.heelZ), ball = new Vector3(0, geometry.soleY, geometry.ballZ), tip = new Vector3(0, geometry.soleY, geometry.toeZ);
  const stance = config.stanceFraction, sweep = config.stride * stance, hipsRest = point('Hips');
  const swingPeak = config.swingPeak ?? 0.34;
  let lead = 0.44;
  const leg = side => ({ upper: Vector3.Distance(point(side + 'UpLeg'), point(side + 'Leg')), lower: Vector3.Distance(point(side + 'Leg'), point(side + 'Foot')), offset: point(side + 'UpLeg').subtract(hipsRest) });
  const legs = { Left: leg('Left'), Right: leg('Right') };
  const sign = side => side === 'Left' ? 1 : -1;
  const orientation = (side, pitch) => rot(axisY, sign(side) * config.toeOut).multiply(rot(axisX, pitch));

  /** 支撑相：脚跟或前掌为支点随地面后移，踝部由支点反算，鞋底始终贴地。progress 为支撑进度0..1。 */
  function stanceFoot(side, progress) {
    const anchor = new Vector3(sign(side) * config.trackHalfWidth, -geometry.soleY, sweep * (lead - progress));
    let pitch = 0, bend = 0;
    if (progress < 0.14) pitch = -config.heelStrikePitch * (1 - smooth(progress / 0.14));
    else if (progress > config.heelRiseStart) {
      const t = (progress - config.heelRiseStart) / (1 - config.heelRiseStart);
      // 抬跟使用单调加速幂曲线：起点一阶导为0（平滑离地），末段持续加速推蹬（避免smooth在t=1处斜率归零导致膝盖反折拉直）。
      pitch = config.toeOffPitch * Math.pow(t, 1.85);
      bend = pitch;
    }
    const yaw = rot(axisY, sign(side) * config.toeOut), q = orientation(side, pitch), pivot = pitch < 0 ? heel : ball;
    const ground = anchor.add(pivot.applyRotationQuaternion(yaw));
    return { ankle: ground.subtract(pivot.applyRotationQuaternion(q)), pitch, bend, isSwing: false, swingProgress: 0 };
  }
  const lowestOffset = (q, bend) => {
    const toe = ball.add(tip.subtract(ball).applyRotationQuaternion(rot(axisX, -bend)));
    return Math.min(...[heel, ball, toe].map(p => p.applyRotationQuaternion(q).y));
  };
  let lift, land;
  const tangent = -sweep / stance * (1 - stance) * config.swingTangent;
  /** 摆动相：前后位置用Hermite曲线衔接支撑端点，鞋底真实最低点按smooth离地轮廓抬升，最终脚掌俯仰耦合小腿倾角。 */
  function swingFoot(side, progress, pitchOverride = null) {
    const fallbackPitch = config.toeOffPitch * (1 - smooth(progress / 0.45)) - config.heelStrikePitch * smooth((progress - 0.45) / 0.55);
    const pitch = pitchOverride ?? fallbackPitch;
    const bend = config.toeOffPitch * (1 - smooth(progress / 0.25));
    const q = orientation(side, pitch);
    const liftBump = progress < swingPeak ? smoother(progress / swingPeak) : 1 - smoother((progress - swingPeak) / (1 - swingPeak));
    const clearance = config.swingClearance * liftBump;
    const z = hermite(lift.ankle.z, land.ankle.z, tangent, tangent, progress);
    const x = Math.abs(lift.ankle.x) + (Math.abs(land.ankle.x) - Math.abs(lift.ankle.x)) * smooth(progress);
    return { ankle: new Vector3(sign(side) * x, clearance - lowestOffset(q, bend), z), pitch, bend, isSwing: true, swingProgress: progress };
  }
  const foot = (side, cycle) => cycle < stance ? stanceFoot(side, cycle / stance) : swingFoot(side, (cycle - stance) / (1 - stance));
  const phases = cycle => ({ Left: wrap(cycle), Right: wrap(cycle + 0.5) });
  const hipXAt = cycle => (config.pelvisSwayX ?? 0) * Math.sin(2 * Math.PI * cycle);
  const pelvisAt = cycle => {
    const w = 2 * Math.PI * cycle;
    const pitch = config.pelvisTilt + (config.pelvisPitchSwing ?? 0) * Math.cos(2 * w - 0.35);
    return Quaternion.RotationYawPitchRoll(-config.pelvisYaw * Math.cos(w), pitch, config.pelvisRoll * Math.sin(w));
  };
  const hipLimit = cycle => {
    const pelvis = pelvisAt(cycle), p = phases(cycle), hx = hipXAt(cycle);
    let limit = Infinity;
    for (const side of ['Left', 'Right']) {
      const target = foot(side, p[side]).ankle, offset = legs[side].offset.applyRotationQuaternion(pelvis), reach = (legs[side].upper + legs[side].lower) * config.reach;
      const dx = target.x - (hipsRest.x + hx + offset.x), dz = target.z - (hipsRest.z + offset.z), horizontal = dx * dx + dz * dz;
      if (horizontal >= reach * reach) throw new Error(`步行脚位超出腿部可达范围：${side} 周期${cycle.toFixed(3)}`);
      limit = Math.min(limit, target.y + Math.sqrt(reach * reach - horizontal) - offset.y - hipsRest.y);
    }
    return limit;
  };
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
    for (let candidate = 0.36; candidate <= 0.56 + 1e-9; candidate += 0.01) {
      lead = candidate;
      try { const result = plan(); if (!choice || result.drop < choice.result.drop) choice = { lead: candidate, result }; } catch { /* 该着地位置不可达 */ }
    }
    if (!choice) throw new Error('步行脚位超出腿部可达范围');
    lead = choice.lead; hip = plan();
  } else { lead = config.lead; hip = plan(); }
  const hipAt = cycle => hip.top - hip.drop * dipShape(wrap(cycle));

  function solveLegGeometry(side, hipPos, ankleTarget) {
    const { upper, lower } = legs[side];
    const toTarget = ankleTarget.subtract(hipPos);
    const distance = Math.min(toTarget.length(), upper + lower - 1e-6), axis = toTarget.normalizeToNew();
    const along = (upper * upper - lower * lower + distance * distance) / (2 * distance), bendOut = Math.sqrt(Math.max(0, upper * upper - along * along));
    const forward = new Vector3(Math.sin(sign(side) * config.toeOut * 0.5), 0, Math.cos(config.toeOut * 0.5));
    const pole = forward.subtract(axis.scale(Vector3.Dot(forward, axis))).normalize();
    const knee = hipPos.add(axis.scale(along)).add(pole.scale(bendOut)), ankleReached = hipPos.add(axis.scale(distance));
    return { knee, ankleReached };
  }

  // 测量蹬离瞬间的真实小腿倾角与解剖踝角，使摆动期从蹬离帧无缝衔接。
  const toeOffAnkleDF = (() => {
    const pel = pelvisAt(stance), hips = hipsRest.add(new Vector3(hipXAt(stance), hipAt(stance), 0));
    const hipPos = hips.add(legs.Left.offset.applyRotationQuaternion(pel));
    const st = stanceFoot('Left', 1);
    const { knee, ankleReached } = solveLegGeometry('Left', hipPos, st.ankle);
    const shank = ankleReached.subtract(knee);
    return -(Math.atan2(shank.z, -shank.y) + st.pitch);
  })();

  // 步行摆动踝角：初段顺应蹬离小腿后倾柔和回中（避免42°勾踝），中段轻微背屈+8°~+12°保证鞋尖轻松过地而不过度上抬踝部，
  // 末段平滑抬起脚尖至-heelStrikePitch 准备脚跟着地。
  function naturalSwingPitch(shankAngle, progress) {
    // 早期（0..25%）轻度微跖屈/中立，中段（25..65%）温和背屈+0.18rad（约10°）使脚尖自然略抬、不过度下垂把踝部顶高。
    const midTarget = 0.06 * (1 - smooth((progress - 0.08) / 0.28)) + 0.20 * smooth((progress - 0.08) / 0.32);
    const desiredDF = toeOffAnkleDF * (1 - smooth(progress / 0.20)) + midTarget * smooth(progress / 0.20);
    const anatomicalWorldPitch = -shankAngle - desiredDF;
    const landBlend = smoother((progress - 0.56) / 0.44);
    const targetPitch = anatomicalWorldPitch * (1 - landBlend) + (-config.heelStrikePitch) * landBlend;
    return Math.max(-config.heelStrikePitch - 0.04, Math.min(0.56, targetPitch));
  }

  const sampler = time => {
    const cycle = wrap(time / config.duration), w = 2 * Math.PI * cycle, local = names.map(() => Quaternion.Identity());
    const set = (name, q) => { local[names.indexOf(name)] = q.normalize(); };
    const pelvis = pelvisAt(cycle), hipY = hipAt(cycle), hipX = hipXAt(cycle);
    const hips = hipsRest.add(new Vector3(hipX, hipY, 0)), p = phases(cycle);
    set('Hips', pelvis);
    for (const side of ['Left', 'Right']) {
      let ft = foot(side, p[side]);
      const { offset } = legs[side], hipPos = hips.add(offset.applyRotationQuaternion(pelvis));
      let solved = solveLegGeometry(side, hipPos, ft.ankle);
      if (ft.isSwing) {
        for (let iter = 0; iter < 2; iter++) {
          const shank = solved.ankleReached.subtract(solved.knee);
          const shankAngle = Math.atan2(shank.z, -shank.y);
          const pitch = naturalSwingPitch(shankAngle, ft.swingProgress);
          ft = swingFoot(side, ft.swingProgress, pitch);
          solved = solveLegGeometry(side, hipPos, ft.ankle);
        }
      }
      const { knee, ankleReached } = solved;
      const thigh = fromTo(point(side + 'Leg').subtract(point(side + 'UpLeg')), knee.subtract(hipPos));
      const shin = fromTo(point(side + 'Foot').subtract(point(side + 'Leg')), ankleReached.subtract(knee));
      set(side + 'UpLeg', pelvis.conjugate().multiply(thigh));
      set(side + 'Leg', thigh.conjugate().multiply(shin));
      set(side + 'Foot', shin.conjugate().multiply(orientation(side, ft.pitch)).multiply(rot(axisX, footPitch[side])));
      set(side + 'ToeBase', rot(axisX, -ft.bend));
    }
    const chestYaw = config.chestCounterYaw * Math.cos(w);
    const chestPitch = config.forwardLean + (config.chestPitchSwing ?? 0) * Math.cos(2 * w - 0.65);
    const chestRoll = -(config.chestCounterRoll ?? 0) * Math.sin(w);
    const chest = Quaternion.RotationYawPitchRoll(chestYaw, chestPitch, chestRoll);
    const spine = pelvis.conjugate().multiply(chest).normalize();
    set('Spine', power(spine, 0.38)); set('Spine1', power(spine, 0.36)); set('Spine2', power(spine, 0.26));
    const headTarget = Quaternion.RotationYawPitchRoll(chestYaw * (config.headYawKeep ?? 0), 0.015 + (config.headNod ?? 0) * Math.cos(2 * w - 0.9), 0);
    const head = chest.conjugate().multiply(headTarget).normalize();
    set('Neck', power(head, 0.5)); set('Head', power(head, 0.5));
    for (const side of ['Left', 'Right']) {
      const s = sign(side);
      const swingNorm = -s * Math.cos(2 * Math.PI * (cycle - config.armLag));
      const swing = config.armSwing * swingNorm + (config.armBias ?? 0);
      const shoulderYaw = -s * (config.shoulderYaw ?? 0) * swingNorm;
      const shoulderRoll = s * (config.shoulderRoll ?? 0) * Math.sin(w);
      set(side + 'Shoulder', Quaternion.RotationYawPitchRoll(shoulderYaw, 0, shoulderRoll));
      const adduct = (config.armAdduct ?? 0) * Math.max(0, swingNorm);
      const down = rot(axisZ, -s * (Math.PI / 2 - Math.max(0.04, config.armHang - adduct)));
      const pitch = rot(axisX, -swing);
      // 大臂微内旋（左右同为+X正转即互为镜像向胸前内收）：前摆时屈肘平面向中线柔和收拢，消除僵直平行摆臂。
      const internal = rot(axisX, (config.armInternalRot ?? 0) + (config.armInternalSwing ?? 0) * Math.max(0, swingNorm));
      set(side + 'Arm', pitch.multiply(down).multiply(internal));
      const elbowNorm = -s * Math.cos(2 * Math.PI * (cycle - (config.elbowLag ?? config.armLag)));
      const elbowAngle = config.elbowBase + config.elbowSwing * (0.5 + 0.5 * elbowNorm);
      const pronate = rot(axisX, config.foreArmPronation ?? 0);
      set(side + 'ForeArm', rot(axisY, -s * elbowAngle).multiply(pronate));
      const wristNorm = -s * Math.cos(2 * Math.PI * (cycle - (config.wristLag ?? config.armLag)));
      set(side + 'Hand', rot(axisY, -s * (config.wristSwing ?? 0) * wristNorm));
    }
    return { local, hipY, hipX };
  };
  sampler.hipRange = hip.drop;
  sampler.lead = lead;
  return sampler;
}

/** 原创步行的精确标定：步速、周期距离与接触曲线直接来自作者参数，左脚着地为相位0。 */
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
