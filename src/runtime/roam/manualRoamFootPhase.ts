export type ManualRoamFootPhase = 'Swing' | 'Landing' | 'Support' | 'ToeOff';
export type ManualRoamFootPhaseState = {
  phase: ManualRoamFootPhase;
  positionWeight: number;
  rotationWeight: number;
  plantWeight: number;
  canLock: boolean;
  initialized: boolean;
};
export type ManualRoamFootPhaseFrame = {
  dt: number;
  contact: number;
  moving: boolean;
  /** 鞋底相对当前探测地面的世界高度，正值表示离地。 */
  soleClearance: number;
  verticalSpeed: number;
  canPlant: boolean;
};

export function createManualRoamFootPhaseState(): ManualRoamFootPhaseState {
  return { phase: 'Swing', positionWeight: 0, rotationWeight: 0, plantWeight: 0, canLock: false, initialized: false };
}

/** 每脚独立阶段；不修改IK目标，防穿地补偿由调用方单独处理。 */
export function stepManualRoamFootPhase(previous: ManualRoamFootPhaseState, frame: ManualRoamFootPhaseFrame): ManualRoamFootPhaseState {
  if (!frame.canPlant || ![frame.dt,frame.contact,frame.soleClearance,frame.verticalSpeed].every(Number.isFinite) || frame.dt < 0) return createManualRoamFootPhaseState();
  const dt=Math.min(.1,frame.dt);
  if (dt===0) return {...previous};
  const contact=Math.max(0,Math.min(1,frame.contact));
  const state={...previous,initialized:true};
  // 源姿态已实际触地且接触曲线明确承重时立即建立支撑，短促跑步落地不能耗尽在过渡计时里。
  if(contact>=.9&&frame.soleClearance<=.01&&frame.verticalSpeed<=.15)return support();
  const landing=contact>=.35 && frame.soleClearance<=.10 && frame.verticalSpeed<=.2;
  if (!previous.initialized && !frame.moving && contact>=.65 && frame.soleClearance<=.12) return support();
  if (state.phase==='Support') {
    // 两个阈值形成迟滞：混合接触在0.55附近波动不会反复捕获支撑点。
    if (contact>.35 && frame.soleClearance<=.12 && frame.verticalSpeed<=.35) return support();
    state.phase='ToeOff';
  } else if (state.phase==='Landing') {
    if (!landing) state.phase='ToeOff';
  } else if (landing) state.phase='Landing';

  state.canLock=false;
  if (state.phase==='Landing') {
    state.positionWeight=Math.min(1,state.positionWeight+dt/.08);
    state.rotationWeight=Math.min(1,state.rotationWeight+dt/.12);
    state.plantWeight=0;
    // 着地姿态收敛后一次捕获水平支撑点，不能用渐变目标拖动整段支撑脚。
    if (contact>=.65 && frame.soleClearance<=.03 && frame.verticalSpeed<=.15
      && state.positionWeight>=1-1e-8 && state.rotationWeight>=1-1e-8) return support();
  } else if (state.phase==='ToeOff') {
    state.positionWeight=Math.max(0,state.positionWeight-dt/.08);
    state.rotationWeight=Math.max(0,state.rotationWeight-dt/.05);
    state.plantWeight=Math.max(0,state.plantWeight-dt/.06);
    if (state.positionWeight===0 && state.rotationWeight===0 && state.plantWeight===0) state.phase='Swing';
  } else {
    state.positionWeight=0;state.rotationWeight=0;state.plantWeight=0;
  }
  return state;
}

function support(): ManualRoamFootPhaseState {
  return { phase:'Support',positionWeight:1,rotationWeight:1,plantWeight:1,canLock:true,initialized:true };
}
