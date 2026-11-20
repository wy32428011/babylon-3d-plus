import { Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector.js';

/**
 * 原创男性自然跑步步态。
 * 按巡检人物腿长（0.686m世界腿长）与 3.2m/s 默认跑速由世界空间足部轨迹与两段腿解析IK生成：
 * 遵循弹簧-质点跑步动力学：支撑相31%（零双支撑、清晰双段腾空相）、仅由支撑腿约束骨盆弹道（允许腾空段真正跃升至站立高度以上，
 * 使支撑中段膝屈保持在挺拔轻盈的40°-45°而非57°深蹲）、有力后蹬伸展→高收后跟折叠（约95°-105°屈膝）→提膝前摆、
 * 耦合小腿倾角的生理踝角（告别60°平脚勾踝），以及后肘利落顶背、前手紧凑向胸中线斜收的自然跑步曲肘摆臂。
 */
export const COMMUTE_RUN = Object.freeze({
  // 默认跑速 3.2m/s、人物缩放约 0.9567 时作者单位约 3.34m/s；
  // 0.63s（约190.5步/分钟）配合 2.02m 周期（世界1.93m，极贴近Alexander无量纲最优1.91m）与 31% 单脚支撑（触地约0.195s），
  // 3.2m/s 下 strideScale≈1.04，兼顾自然奔跑节奏、充分后蹬伸展与高盈腾空。
  duration: 0.66,          // 约181.8步/分钟，贴合0.754m髋高在3.2m/s下的自然中慢跑步频
  stride: 2.08,            // 周期距离（两步，世界1.99m，默认3.2m/s下 strideScale≈1.05）
  lead: 0.32,              // 着地重心靠前（踝在髋前约14cm），消除刹车过跨并确保蹬离充分后伸
  stanceFraction: 0.31,    // 单脚支撑31%（触地0.205s，零双支撑，两段腾空合计38%）
  trackHalfWidth: 0.046,   // 跑步落脚贴近中线（步宽约9.2cm）
  toeOut: 0.065,           // 脚尖微外展约3.7°
  heelStrikePitch: 0.10,   // 轻中后掌着地（约5.7°），柔顺过渡放平
  heelRiseStart: 0.50,     // 支撑后半段以加速曲线有力抬跟蹬伸，消除中段提前压折膝盖
  toeOffPitch: 0.64,       // 蹬离时绕前掌发力抬跟约36.7°
  swingClearance: 0.066,   // 摆动最低点离地高度（配合自然下垂脚尖使脚跟抬升约30cm、屈膝约96°-100°且帧间变化平顺）
  swingPeak: 0.36,         // 抬脚峰值在摆动早中段（后跟向臀后紧凑折叠），后段提膝前送并干脆落脚
  reach: 0.992,            // 跑步保持弹性微屈，不锁直膝盖
  midstanceDip: 0.040,     // 支撑中段相对站立的弹性缓冲深度（使支撑膝屈维持在自然40°-45°挺拔弹跳感）
  flightLift: 0.022,       // 腾空顶点高于站立基准的真实腾空抬升（总骨盆弹道约6.2cm）
  swingTangent: 0.42,      // 摆动端点速度流畅衔接地面速度
  pelvisSwayX: 0.008,      // 跑步轻微重心横移±0.8cm（零均值闭环）
  pelvisRoll: 0.058,       // 骨盆侧倾约±3.3°（全幅约6.6°，位于2°-10°自然区间）
  pelvisYaw: 0.088,        // 骨盆水平扭转约±5.0°（全幅约10.1°，位于4°-16°自然区间）
  pelvisTilt: 0.115,       // 骨盆前倾约6.6°，与胸腔协调前倾
  pelvisPitchSwing: 0.020, // 双频骨盆俯仰弹性韵律
  chestCounterYaw: 0.125,  // 胸腔相对骨盆有力反向扭转约±7.2°
  chestCounterRoll: 0.030, // 胸腔反侧倾稳定肩带
  chestPitchSwing: 0.015,  // 双频胸腔弹性微动
  forwardLean: 0.165,      // 跑步整体前倾约9.5°，重心顺畅落于推进线上
  shoulderYaw: 0.062,      // 锁骨随大幅摆臂前后牵伸约±3.6°
  shoulderRoll: 0.022,     // 锁骨随步微动
  armSwing: 0.56,          // 肩部跑步摆臂幅度约±32°
  armBias: -0.18,          // 后偏使后摆肩伸达-40°（肘清晰顶向身后、手回摆过髋侧），前摆收至+22°（手紧凑在胸前）
  armAdduct: 0.055,        // 前摆时大臂轻度内收
  armHang: 0.125,          // 大臂自然贴近躯干（约7.2°外展），后摆干净避开裤腰不穿模
  armInternalRot: 0.15,    // 大臂基础自然内旋（后摆保持适度外留间隙，不擦碰髋侧）
  armInternalSwing: 0.22,  // 前摆时向胸骨中线自然斜收形成紧凑跑步三角摆臂（左右对称不越中线）
  foreArmPronation: 0.20,  // 前臂适度旋前，手掌自然半朝内斜向胸前
  armLag: 0.03,            // 摆臂相位滞后
  elbowBase: 1.38,         // 跑步曲肘基础角约79°（后摆约79°，前摆收至约97°，位于55°-115°区间）
  elbowSwing: 0.32,        // 前摆额外收肘约18°
  elbowLag: 0.055,         // 前臂惯性滞后
  wristSwing: 0.065,       // 手腕自然随动约±3.7°
  wristLag: 0.08,          // 手腕滞后前臂
  headYawKeep: 0.12,       // 头部基本盯住前方并保留少量自然惯性
  headNod: 0.014,          // 随跑步弹跳的柔和点头微动
  source: { kind: 'original-authored-commute-run', author: 'project manual-roam asset pipeline',
    description: 'Male natural jog/run solved offline from world-space foot trajectories with true flight phase, upright spring-mass pelvis arc, high heel-fold recovery, shank-coupled physiological ankle kinematics, analytic two-bone leg IK and compact athletic bent-arm swing; not motion capture' },
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
  const swingPeak = config.swingPeak ?? 0.36;
  let lead = typeof config.lead === 'number' ? config.lead : 0.34;
  const leg = side => ({ upper: Vector3.Distance(point(side + 'UpLeg'), point(side + 'Leg')), lower: Vector3.Distance(point(side + 'Leg'), point(side + 'Foot')), offset: point(side + 'UpLeg').subtract(hipsRest) });
  const legs = { Left: leg('Left'), Right: leg('Right') };
  const sign = side => side === 'Left' ? 1 : -1;
  const orientation = (side, pitch) => rot(axisY, sign(side) * config.toeOut).multiply(rot(axisX, pitch));

  /** 支撑相：轻中后掌着地迅速放平承重缓冲，随后绕前掌加速发力蹬伸。 */
  function stanceFoot(side, progress) {
    const anchor = new Vector3(sign(side) * config.trackHalfWidth, -geometry.soleY, sweep * (lead - progress));
    let pitch = 0, bend = 0;
    if (progress < 0.16) pitch = -config.heelStrikePitch * (1 - smooth(progress / 0.16));
    else if (progress > config.heelRiseStart) {
      const t = (progress - config.heelRiseStart) / (1 - config.heelRiseStart);
      pitch = config.toeOffPitch * Math.pow(t, 1.75);
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
  const phases = cycle => ({ Left: wrap(cycle), Right: wrap(cycle + 0.5) });
  const hipXAt = cycle => (config.pelvisSwayX ?? 0) * Math.sin(2 * Math.PI * cycle);
  const pelvisAt = cycle => {
    const w = 2 * Math.PI * cycle;
    const pitch = config.pelvisTilt + (config.pelvisPitchSwing ?? 0) * Math.cos(2 * w - 0.6);
    return Quaternion.RotationYawPitchRoll(-config.pelvisYaw * Math.cos(w), pitch, config.pelvisRoll * Math.sin(w));
  };
  // 弹簧-质点骨盆弹道：仅受支撑腿几何约束（腾空期两脚随骨盆腾空，不能被地面静止高度把骨盆死锁在负高度产生蹲跑）。
  const count = 240;
  const dipCenter = stance * 0.50;
  const dipShape = cycle => (1 + Math.cos(2 * Math.PI * 2 * (cycle - dipCenter))) / 2;
  const stanceHipLimit = cycle => {
    const pelvis = pelvisAt(cycle), p = phases(cycle), hx = hipXAt(cycle);
    let limit = Infinity;
    for (const side of ['Left', 'Right']) {
      if (p[side] >= stance) continue;
      const target = stanceFoot(side, p[side] / stance).ankle;
      const offset = legs[side].offset.applyRotationQuaternion(pelvis), reach = (legs[side].upper + legs[side].lower) * config.reach;
      const dx = target.x - (hipsRest.x + hx + offset.x), dz = target.z - (hipsRest.z + offset.z), horizontal = dx * dx + dz * dz;
      if (horizontal >= reach * reach) throw new Error(`跑步支撑脚位超出腿部可达范围：${side} 周期${cycle.toFixed(3)}`);
      limit = Math.min(limit, target.y + Math.sqrt(reach * reach - horizontal) - offset.y - hipsRest.y);
    }
    return limit;
  };
  function plan() {
    lift = stanceFoot('Left', 1); land = stanceFoot('Left', 0);
    const limits = Array.from({ length: count }, (_, i) => stanceHipLimit(i / count));
    const targetDrop = Math.max(0.056, config.midstanceDip + config.flightLift);
    let best = null;
    for (let drop = targetDrop; drop <= 0.11 + 1e-9; drop += 0.001) {
      let maxTop = Infinity;
      for (let i = 0; i < count; i++) if (Number.isFinite(limits[i])) maxTop = Math.min(maxTop, limits[i] + drop * dipShape(i / count));
      if (Number.isFinite(maxTop)) {
        const top = Math.min(maxTop, config.flightLift);
        best = { top, drop };
        break;
      }
    }
    if (!best) throw new Error('跑步骨盆弹道超出腿部可达范围');
    return best;
  }
  let hip;
  if (config.lead === 'auto') {
    let choice = null;
    for (let candidate = 0.28; candidate <= 0.44 + 1e-9; candidate += 0.01) {
      lead = candidate;
      try { const result = plan(); if (!choice || result.top > choice.result.top) choice = { lead: candidate, result }; } catch { /* 不可达 */ }
    }
    if (!choice) throw new Error('跑步脚位超出腿部可达范围');
    lead = choice.lead; hip = plan();
  } else { lead = config.lead; hip = plan(); }
  const hipAt = cycle => hip.top - hip.drop * dipShape(wrap(cycle));

  /** 摆动相：蹬离后脚跟向后上方高收折叠，中后段提膝前送，末段跟随腾空骨盆并在着地前干脆下压触地。 */
  function swingFoot(side, progress, cycle, pitchOverride = null) {
    const fallbackPitch = config.toeOffPitch * (1 - smooth(progress / 0.55)) - config.heelStrikePitch * smooth((progress - 0.60) / 0.40);
    const pitch = pitchOverride ?? fallbackPitch;
    const bend = config.toeOffPitch * (1 - smooth(progress / 0.24));
    const q = orientation(side, pitch);
    // 腾空上升段叠加骨盆正抬升，确保摆动脚在腾空最高点不会拉直超限或提前贴地；临近着地顺滑回落至地面。
    const hipLiftBonus = Math.max(0, hipAt(cycle)) * Math.sin(Math.PI * progress);
    const liftBump = progress < swingPeak
      ? Math.sin((progress / swingPeak) * (Math.PI / 2)) ** 1.25
      : Math.sin(((1 - progress) / (1 - swingPeak)) * (Math.PI / 2)) ** 0.90;
    const clearance = config.swingClearance * Math.max(0, liftBump) + hipLiftBonus;
    const z = hermite(lift.ankle.z, land.ankle.z, tangent * 1.1, tangent * 0.85, progress);
    const x = Math.abs(lift.ankle.x) + (Math.abs(land.ankle.x) - Math.abs(lift.ankle.x)) * smooth(progress);
    return { ankle: new Vector3(sign(side) * x, clearance - lowestOffset(q, bend), z), pitch, bend, isSwing: true, swingProgress: progress };
  }
  const foot = (side, sideCycle, globalCycle) => sideCycle < stance
    ? stanceFoot(side, sideCycle / stance)
    : swingFoot(side, (sideCycle - stance) / (1 - stance), globalCycle);

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

  const toeOffAnkleDF = (() => {
    const pel = pelvisAt(stance), hips = hipsRest.add(new Vector3(hipXAt(stance), hipAt(stance), 0));
    const hipPos = hips.add(legs.Left.offset.applyRotationQuaternion(pel));
    const st = stanceFoot('Left', 1);
    const { knee, ankleReached } = solveLegGeometry('Left', hipPos, st.ankle);
    const shank = ankleReached.subtract(knee);
    return -(Math.atan2(shank.z, -shank.y) + st.pitch);
  })();

  // 跑步摆动生理踝角：蹬离后顺应小腿后折自然下垂（轻微跖屈到中立），中后段回中微背屈准备轻中后掌着地，
  // 彻底消除平脚60°勾踝。
  function naturalSwingPitch(shankAngle, progress) {
    const midTarget = -0.10 * (1 - smooth((progress - 0.12) / 0.42)) + 0.10 * smooth((progress - 0.25) / 0.52);
    const desiredDF = toeOffAnkleDF * (1 - smooth(progress / 0.22)) + midTarget * smooth(progress / 0.22);
    const anatomicalWorldPitch = -shankAngle - desiredDF;
    const landBlend = smoother((progress - 0.70) / 0.30);
    const targetPitch = anatomicalWorldPitch * (1 - landBlend) + (-config.heelStrikePitch) * landBlend;
    return Math.max(-config.heelStrikePitch - 0.05, Math.min(1.20, targetPitch));
  }

  const sampler = time => {
    const cycle = wrap(time / config.duration), w = 2 * Math.PI * cycle, local = names.map(() => Quaternion.Identity());
    const set = (name, q) => { local[names.indexOf(name)] = q.normalize(); };
    const pelvis = pelvisAt(cycle), hipY = hipAt(cycle), hipX = hipXAt(cycle);
    const hips = hipsRest.add(new Vector3(hipX, hipY, 0)), p = phases(cycle);
    set('Hips', pelvis);
    for (const side of ['Left', 'Right']) {
      let ft = foot(side, p[side], cycle);
      const { offset } = legs[side], hipPos = hips.add(offset.applyRotationQuaternion(pelvis));
      let solved = solveLegGeometry(side, hipPos, ft.ankle);
      if (ft.isSwing) {
        for (let iter = 0; iter < 2; iter++) {
          const shank = solved.ankleReached.subtract(solved.knee);
          const shankAngle = Math.atan2(shank.z, -shank.y);
          const pitch = naturalSwingPitch(shankAngle, ft.swingProgress);
          ft = swingFoot(side, ft.swingProgress, cycle, pitch);
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
    const chestPitch = config.forwardLean + (config.chestPitchSwing ?? 0) * Math.cos(2 * w - 0.8);
    const chestRoll = -(config.chestCounterRoll ?? 0) * Math.sin(w);
    const chest = Quaternion.RotationYawPitchRoll(chestYaw, chestPitch, chestRoll);
    const spine = pelvis.conjugate().multiply(chest).normalize();
    set('Spine', power(spine, 0.38)); set('Spine1', power(spine, 0.36)); set('Spine2', power(spine, 0.26));
    const headTarget = Quaternion.RotationYawPitchRoll(chestYaw * (config.headYawKeep ?? 0), 0.02 + (config.headNod ?? 0) * Math.cos(2 * w - 1.0), 0);
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
      // 左右臂下垂后局部+X互为镜像内旋轴，统一使用正角使双臂对称向胸前中线内收。
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
