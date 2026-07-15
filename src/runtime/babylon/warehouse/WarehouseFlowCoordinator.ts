/** 仓储流入库阶段。 */
export type WarehouseInboundPhase =
  | 'inbound-front'
  | 'inbound-transfer'
  | 'inbound-back'
  | 'inbound-lifting'
  | 'inbound-pickup'
  | 'inbound-carrying'
  | 'inbound-storing';

/** 仓储流出库阶段。 */
export type WarehouseOutboundPhase =
  | 'outbound-retrieving'
  | 'outbound-carrying'
  | 'outbound-handoff'
  | 'outbound-lowering'
  | 'outbound-transfer'
  | 'outbound-front';

/** 输送机进入仓储协调器的最小遥测视图。 */
export type WarehouseConveyorFrame = {
  containerCode: string | null;
  frontHasGoods: boolean;
  backHasGoods: boolean;
  movementX: number;
  movementY: number;
  liftAtLow: boolean | null;
  liftAtHigh: boolean | null;
  faulted: boolean;
  receivedAt: number;
  spanMeters: number;
};

/** 堆垛机进入仓储协调器的单侧作业视图。 */
export type WarehouseStackerFrame = {
  side: 'front' | 'back' | null;
  command: number | null;
  movementZ: number | null;
  containerCode: string | null;
  targetLocationKey: string | null;
  faulted: boolean;
  receivedAt: number;
};

/** 已入库货物的最小索引，协调器只据此选择条码和库位。 */
export type StoredWarehouseCargoReference = {
  cargoCode: string;
  locatorKey: string;
};

/** 单帧仓储流输入。 */
export type WarehouseFlowFrame = {
  nowMs: number;
  deltaSeconds: number;
  ttlMs: number;
  canStartInbound: boolean;
  inbound: WarehouseConveyorFrame | null;
  stacker: WarehouseStackerFrame | null;
  outbound: WarehouseConveyorFrame | null;
  storedCargos: StoredWarehouseCargoReference[];
};

/** 当前入库流程状态。 */
export type WarehouseInboundState = {
  cargoCode: string;
  phase: WarehouseInboundPhase;
  progress: number;
  stackerSide: 'front' | 'back' | null;
  targetLocationKey: string | null;
  storeRequested: boolean;
  lastEvidenceAt: number;
};

/** 当前出库流程状态。 */
export type WarehouseOutboundState = {
  cargoCode: string;
  sourceLocatorKey: string;
  phase: WarehouseOutboundPhase;
  progress: number;
  stackerSide: 'front' | 'back' | null;
  lastEvidenceAt: number;
  quietSince: number | null;
};

/** 协调器输出的一次性事件。 */
export type WarehouseFlowEvents = {
  startInboundCargoCode?: string;
  renameInboundCargo?: { from: string; to: string };
  storeInboundCargo?: { cargoCode: string; locatorKey: string };
  cancelInboundCargoCode?: string;
  startOutboundCargo?: { cargoCode: string; locatorKey: string };
  completeOutboundCargoCode?: string;
  conflictMessage?: string;
};

/** 协调器当前状态和本帧事件。 */
export type WarehouseFlowUpdate = {
  inbound: WarehouseInboundState | null;
  outbound: WarehouseOutboundState | null;
  events: WarehouseFlowEvents;
};

const AUTO_CARGO_PREFIX = 'AUTO-CARGO-';
const CONVEYOR_SPEED_METERS_PER_SECOND = 0.45;
const OUTBOUND_COMPLETE_QUIET_MS = 300;

/**
 * 只维护仓储业务阶段和条码归属，不读取 Babylon 节点，也不创建或销毁可视对象。
 * SceneRuntime 根据这里的阶段把同一货物实例放到 1004、DDJ2、库位或 1005 的世界锚点。
 */
export class WarehouseFlowCoordinator {
  private inbound: WarehouseInboundState | null = null;
  private outbound: WarehouseOutboundState | null = null;
  private waitingForInboundClear = false;
  private generatedCargoSequence = 0;

  /** 清空本次预览的临时状态；已入库货物由 SceneRuntime 负责释放。 */
  reset(): void {
    this.inbound = null;
    this.outbound = null;
    this.waitingForInboundClear = false;
    this.generatedCargoSequence = 0;
  }

  /** 返回不可变快照，避免渲染层直接修改协调器内部状态。 */
  getState(): Pick<WarehouseFlowUpdate, 'inbound' | 'outbound'> {
    return {
      inbound: this.inbound ? { ...this.inbound } : null,
      outbound: this.outbound ? { ...this.outbound } : null,
    };
  }

  /** 入库可视实例已成功脱离生成器并登记到库位后，允许下一件货物进入。 */
  acknowledgeInboundStored(cargoCode: string): void {
    if (this.inbound?.cargoCode !== cargoCode) return;
    this.inbound = null;
    this.waitingForInboundClear = true;
  }

  /** 出库前端货物已释放后，清空对应出库流程。 */
  acknowledgeOutboundCompleted(cargoCode: string): void {
    if (this.outbound?.cargoCode !== cargoCode) return;
    this.outbound = null;
  }

  /** 消费一帧三设备遥测并推进状态机。 */
  update(frame: WarehouseFlowFrame): WarehouseFlowUpdate {
    const events: WarehouseFlowEvents = {};
    this.updateInboundClearGate(frame.inbound);
    this.tryStartInbound(frame, events);
    this.updateInbound(frame, events);
    this.tryStartOutbound(frame, events);
    this.updateOutbound(frame, events);

    return {
      inbound: this.inbound ? { ...this.inbound } : null,
      outbound: this.outbound ? { ...this.outbound } : null,
      events,
    };
  }

  /** 完成一次入库后必须观察到前端光电清空，防止同一托盘重复生成。 */
  private updateInboundClearGate(inbound: WarehouseConveyorFrame | null): void {
    if (!this.waitingForInboundClear) return;
    if (inbound && !inbound.faulted && !inbound.frontHasGoods) {
      this.waitingForInboundClear = false;
    }
  }

  /** 1004 前端有货且生成模板有效时启动一条新的入库流程。 */
  private tryStartInbound(frame: WarehouseFlowFrame, events: WarehouseFlowEvents): void {
    const inbound = frame.inbound;
    if (this.inbound || this.waitingForInboundClear || !frame.canStartInbound || !inbound || inbound.faulted) return;
    if (!inbound.frontHasGoods) return;

    const cargoCode = inbound.containerCode ?? this.createAutomaticCargoCode();
    if (!this.isAutomaticCargoCode(cargoCode) && this.isCargoCodeAlreadyActive(frame, cargoCode)) {
      events.conflictMessage = `入库货物 ${cargoCode} 已在库位或出库流程中，拒绝重复生成。`;
      this.waitingForInboundClear = true;
      return;
    }
    this.inbound = {
      cargoCode,
      phase: 'inbound-front',
      progress: 0,
      stackerSide: null,
      targetLocationKey: null,
      storeRequested: false,
      lastEvidenceAt: frame.nowMs,
    };
    events.startInboundCargoCode = cargoCode;
  }

  /** 推进入库输送、堆垛机取货、搬运和放货阶段。 */
  private updateInbound(frame: WarehouseFlowFrame, events: WarehouseFlowEvents): void {
    const state = this.inbound;
    if (!state) return;

    const realCargoCode = this.pickRealCargoCode(
      frame.inbound?.containerCode,
      this.outbound ? null : frame.stacker?.containerCode,
    );
    if (realCargoCode && realCargoCode !== state.cargoCode) {
      if (this.isAutomaticCargoCode(state.cargoCode)) {
        if (this.isCargoCodeAlreadyActive(frame, realCargoCode)) {
          events.conflictMessage = `入库临时货物识别为 ${realCargoCode}，但该条码已在库位或出库流程中，已取消重复实例。`;
          events.cancelInboundCargoCode = state.cargoCode;
          this.inbound = null;
          this.waitingForInboundClear = true;
          return;
        }
        events.renameInboundCargo = { from: state.cargoCode, to: realCargoCode };
        state.cargoCode = realCargoCode;
      } else {
        events.conflictMessage = `入库货物条码冲突：当前=${state.cargoCode}，新值=${realCargoCode}`;
        return;
      }
    }

    if (state.storeRequested && state.targetLocationKey) {
      events.storeInboundCargo = { cargoCode: state.cargoCode, locatorKey: state.targetLocationKey };
      return;
    }

    const stacker = frame.stacker;
    const stackerOwnsCargo = Boolean(
      !this.outbound
      && stacker
      && !stacker.faulted
      && this.isInboundReadyForStacker(state, frame.inbound)
      && this.canStackerOwnCargo(state.cargoCode, stacker),
    );
    if (stackerOwnsCargo && stacker) {
      state.stackerSide = stacker.side;
      state.targetLocationKey = stacker.targetLocationKey ?? state.targetLocationKey;
      state.lastEvidenceAt = frame.nowMs;
      if (stacker.command === 1) state.phase = 'inbound-pickup';
      if (stacker.command === 2) state.phase = 'inbound-carrying';
      if (stacker.command === 3 || stacker.command === 4 || stacker.command === 5) {
        state.phase = 'inbound-storing';
      }
      if (stacker.command === 5) {
        if (state.targetLocationKey) {
          state.storeRequested = true;
          events.storeInboundCargo = { cargoCode: state.cargoCode, locatorKey: state.targetLocationKey };
        } else {
          events.conflictMessage = `DDJ2 已上报放货完成，但货物 ${state.cargoCode} 缺少目标库位。`;
        }
      }
      return;
    }

    if (state.phase === 'inbound-pickup' || state.phase === 'inbound-carrying' || state.phase === 'inbound-storing') {
      return;
    }

    const inbound = frame.inbound;
    if (!inbound || inbound.faulted) return;
    state.progress = this.updateConveyorProgress(
      state.progress,
      inbound.frontHasGoods,
      inbound.backHasGoods,
      inbound.movementX,
      inbound.spanMeters,
      frame.deltaSeconds,
    );
    if (state.progress <= 0.001) {
      state.phase = 'inbound-front';
    } else if (state.progress < 0.999) {
      state.phase = 'inbound-transfer';
    } else {
      const liftReady = inbound.liftAtHigh === true
        || (inbound.liftAtHigh === null && inbound.movementY === 0);
      state.phase = liftReady ? 'inbound-back' : 'inbound-lifting';
    }

    const hasEvidence = inbound.frontHasGoods
      || inbound.backHasGoods
      || Boolean(inbound.containerCode)
      || inbound.movementX !== 0
      || inbound.movementY !== 0
      || inbound.liftAtHigh === true;
    if (hasEvidence) state.lastEvidenceAt = frame.nowMs;
    if (!hasEvidence && frame.nowMs - state.lastEvidenceAt > frame.ttlMs) {
      events.cancelInboundCargoCode = state.cargoCode;
      this.inbound = null;
    }
  }

  /** DDJ2 对已入库条码或目标库位执行取货时启动出库流程。 */
  private tryStartOutbound(frame: WarehouseFlowFrame, events: WarehouseFlowEvents): void {
    if (this.outbound || frame.storedCargos.length === 0) return;
    if (this.inbound && ['inbound-pickup', 'inbound-carrying', 'inbound-storing'].includes(this.inbound.phase)) return;
    const stacker = frame.stacker;
    if (!stacker || !stacker.side || stacker.faulted || (stacker.command !== 1 && stacker.command !== 2)) return;

    const candidate = this.findStoredCargo(frame.storedCargos, stacker.containerCode, stacker.targetLocationKey);
    if (!candidate) return;
    this.outbound = {
      cargoCode: candidate.cargoCode,
      sourceLocatorKey: candidate.locatorKey,
      phase: stacker.command === 1 ? 'outbound-retrieving' : 'outbound-carrying',
      progress: 0,
      stackerSide: stacker.side,
      lastEvidenceAt: frame.nowMs,
      quietSince: null,
    };
    events.startOutboundCargo = { cargoCode: candidate.cargoCode, locatorKey: candidate.locatorKey };
  }

  /** 推进 DDJ2 取货、搬运、1005 接管和前端完成阶段。 */
  private updateOutbound(frame: WarehouseFlowFrame, events: WarehouseFlowEvents): void {
    const state = this.outbound;
    if (!state) return;

    const stacker = frame.stacker;
    if (stacker && !stacker.faulted && this.canStackerOwnCargo(state.cargoCode, stacker)) {
      state.stackerSide = stacker.side ?? state.stackerSide;
      state.lastEvidenceAt = frame.nowMs;
      if (stacker.command === 1) state.phase = 'outbound-retrieving';
      if (stacker.command === 2) state.phase = 'outbound-carrying';
      if (stacker.command === 3 || stacker.command === 4 || stacker.command === 5) {
        state.phase = 'outbound-handoff';
        state.progress = Math.max(state.progress, this.resolveStackerHandoffProgress(stacker.command));
      }
    }

    const outbound = frame.outbound;
    if (!outbound || outbound.faulted) return;
    const outboundCodeConflict = outbound.containerCode
      && outbound.containerCode !== state.cargoCode;
    if (outboundCodeConflict) {
      events.conflictMessage = `出库货物条码冲突：当前=${state.cargoCode}，1005=${outbound.containerCode}`;
      return;
    }

    const conveyorOwnsCargo = outbound.backHasGoods
      || outbound.frontHasGoods
      || outbound.containerCode === state.cargoCode;
    if (conveyorOwnsCargo) {
      const conveyorStartProgress = state.phase === 'outbound-handoff'
        || state.phase === 'outbound-carrying'
        || state.phase === 'outbound-retrieving'
        ? 0
        : state.progress;
      state.progress = this.updateConveyorProgress(
        conveyorStartProgress,
        outbound.frontHasGoods,
        outbound.backHasGoods,
        outbound.movementX,
        outbound.spanMeters,
        frame.deltaSeconds,
        true,
      );
      const liftReadyForTransfer = outbound.liftAtLow === true
        || outbound.movementX !== 0
        || (outbound.liftAtLow === null && outbound.movementY === 0);
      state.phase = state.progress >= 0.999
        ? 'outbound-front'
        : (liftReadyForTransfer ? 'outbound-transfer' : 'outbound-lowering');
      state.lastEvidenceAt = frame.nowMs;
    }

    const liftStableAtLow = outbound.liftAtLow === true
      || (outbound.liftAtLow === null && outbound.movementY === 0);
    const completedAndCleared = state.phase === 'outbound-front'
      && !outbound.frontHasGoods
      && !outbound.backHasGoods
      && !outbound.containerCode
      && outbound.movementX === 0
      && liftStableAtLow;
    if (!completedAndCleared) {
      state.quietSince = null;
      return;
    }

    state.quietSince ??= frame.nowMs;
    if (frame.nowMs - state.quietSince >= OUTBOUND_COMPLETE_QUIET_MS) {
      events.completeOutboundCargoCode = state.cargoCode;
    }
  }

  /** 结合光电端点和运行方向计算 0..1 输送进度。 */
  private updateConveyorProgress(
    current: number,
    frontHasGoods: boolean,
    backHasGoods: boolean,
    movementX: number,
    spanMeters: number,
    deltaSeconds: number,
    reverseSensorOrder = false,
  ): number {
    const startHasGoods = reverseSensorOrder ? backHasGoods : frontHasGoods;
    const endHasGoods = reverseSensorOrder ? frontHasGoods : backHasGoods;
    if (endHasGoods && !startHasGoods) return 1;
    if (startHasGoods && !endHasGoods) return 0;

    const direction = movementX === 1 ? 1 : (movementX === 2 ? -1 : 0);
    if (direction === 0) return this.clampProgress(current);
    const safeSpan = Math.max(0.1, spanMeters);
    return this.clampProgress(current + direction * CONVEYOR_SPEED_METERS_PER_SECOND * deltaSeconds / safeSpan);
  }

  /** 按条码优先、库位次优选择已入库货物。 */
  private findStoredCargo(
    storedCargos: StoredWarehouseCargoReference[],
    cargoCode: string | null,
    locatorKey: string | null,
  ): StoredWarehouseCargoReference | null {
    if (cargoCode) {
      const byCargoCode = storedCargos.find((cargo) => cargo.cargoCode === cargoCode);
      if (byCargoCode) return byCargoCode;
    }
    if (locatorKey) {
      return storedCargos.find((cargo) => cargo.locatorKey === locatorKey) ?? null;
    }
    return null;
  }

  /** 判断真实条码是否已经被库位货物或当前出库流程占用。 */
  private isCargoCodeAlreadyActive(frame: WarehouseFlowFrame, cargoCode: string): boolean {
    return this.outbound?.cargoCode === cargoCode
      || frame.storedCargos.some((cargo) => cargo.cargoCode === cargoCode);
  }

  /** 只有货物到达 1004 后端且顶升已到高位或高位状态未知时，DDJ2 才能接管。 */
  private isInboundReadyForStacker(
    state: WarehouseInboundState,
    inbound: WarehouseConveyorFrame | null,
  ): boolean {
    if (state.phase === 'inbound-pickup' || state.phase === 'inbound-carrying' || state.phase === 'inbound-storing') {
      return true;
    }
    if (!inbound || state.progress < 0.999 || !inbound.backHasGoods) return false;
    if (inbound.liftAtHigh === true) return true;
    if (inbound.liftAtHigh === false) return false;
    return inbound.movementY === 0;
  }

  /** 把 DDJ2 放货状态映射为 0..1 的后端交接进度，重复状态保持幂等。 */
  private resolveStackerHandoffProgress(command: number): number {
    if (command === 5) return 1;
    if (command === 4) return 0.85;
    return 0.45;
  }

  /** 判断当前堆垛机帧是否可以接管指定条码。 */
  private canStackerOwnCargo(cargoCode: string, stacker: WarehouseStackerFrame): boolean {
    if (stacker.command === null || stacker.command <= 0 || stacker.command === 8) return false;
    return !stacker.containerCode
      || stacker.containerCode === cargoCode
      || this.isAutomaticCargoCode(cargoCode);
  }

  /** 从多个现场来源中选择第一个非空真实条码。 */
  private pickRealCargoCode(...values: Array<string | null | undefined>): string | null {
    for (const value of values) {
      const normalized = value?.trim();
      if (normalized) return normalized;
    }
    return null;
  }

  /** 生成一次预览内稳定且不会与现场条码混淆的临时编号。 */
  private createAutomaticCargoCode(): string {
    this.generatedCargoSequence += 1;
    return AUTO_CARGO_PREFIX + String(this.generatedCargoSequence).padStart(4, '0');
  }

  /** 判断条码是否为协调器生成的临时编号。 */
  private isAutomaticCargoCode(cargoCode: string): boolean {
    return cargoCode.startsWith(AUTO_CARGO_PREFIX);
  }

  /** 将输送进度限制在闭区间内。 */
  private clampProgress(value: number): number {
    return Math.max(0, Math.min(1, value));
  }
}
