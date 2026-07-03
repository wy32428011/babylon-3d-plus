import type { MqttConfig, StackerSimulationScenario } from '../../editor/model/SceneDocument';
import {
  parseStackerTelemetryMessage,
  stackerTelemetryStore,
} from './stackerTelemetry';

type StackerTelemetrySimulatorLog = (message: string) => void;

type StackerTargetLocation = {
  x: number;
  y: number;
  z: number;
};

type StackerForkSide = 'front' | 'back';

type StackerMotionState = {
  target: StackerTargetLocation | null;
  distanceX: number;
  distanceY: number;
  frontDistanceZ: number;
  backDistanceZ: number;
  movementX: number;
  movementY: number;
  frontMovementZ: number;
  backMovementZ: number;
  frontCommand: number;
  backCommand: number;
  frontContainerCode: string;
  backContainerCode: string;
  normal: boolean;
  errorCode: number;
  message: string;
};

type StackerPayloadPoint = {
  e: string;
  p: string;
  v: unknown;
};

type StackerTelemetryPayload = {
  data: StackerPayloadPoint[];
  ts: string;
};

/** 在没有 MQTT broker 时生成本地 Stacker 遥测，并写入运行时内存快照。 */
export class StackerTelemetrySimulator {
  private configSignature = '';
  private timerId: number | null = null;
  private startMs = 0;
  private tick = 0;

  constructor(private readonly pushLog: StackerTelemetrySimulatorLog) {}

  /** 根据场景配置启动、停止或切换本地模拟数据源。 */
  updateConfig(config: MqttConfig): void {
    const signature = JSON.stringify({
      enabled: config.enabled,
      simulatorEnabled: config.simulatorEnabled,
      simulatorAssetCode: config.simulatorAssetCode,
      simulatorScenario: config.simulatorScenario,
      simulatorIntervalMs: config.simulatorIntervalMs,
    });
    if (signature === this.configSignature) return;

    this.configSignature = signature;
    this.stop(false);

    if (!config.enabled || !config.simulatorEnabled) return;

    this.start(config);
  }

  /** 释放定时器并清理模拟状态。 */
  dispose(): void {
    this.configSignature = '';
    this.stop(true);
  }

  /** 创建定时器，并立即推送第一帧，保证打开场景后无需等待即可看到数据。 */
  private start(config: MqttConfig): void {
    this.startMs = Date.now();
    this.tick = 0;
    this.emitFrame(config);
    this.timerId = window.setInterval(() => {
      this.tick += 1;
      this.emitFrame(config);
    }, config.simulatorIntervalMs);
    this.pushLog(
      `Stacker 本地模拟已启动：${config.simulatorAssetCode}，场景 ${config.simulatorScenario}，间隔 ${config.simulatorIntervalMs}ms`,
    );
  }

  /** 停止模拟定时器，可按调用方需要清空当前遥测快照。 */
  private stop(clearStore: boolean): void {
    if (this.timerId !== null) {
      window.clearInterval(this.timerId);
      this.timerId = null;
      this.pushLog('Stacker 本地模拟已停止。');
    }
    if (clearStore) {
      stackerTelemetryStore.clear();
    }
  }

  /** 生成并解析一帧模拟 payload，保持和真实 MQTT 消息一致的数据入口。 */
  private emitFrame(config: MqttConfig): void {
    const topic = createStackerSimulatorTopic(config.simulatorAssetCode);
    const payload = createStackerSimulatorPayload(
      config.simulatorAssetCode,
      config.simulatorScenario,
      this.tick,
      this.startMs,
    );
    const snapshot = parseStackerTelemetryMessage(topic, JSON.stringify(payload));
    if (!snapshot) return;
    stackerTelemetryStore.upsert(snapshot);
  }
}

/** 根据资产编号生成真实可解析的 Stacker topic。 */
export function createStackerSimulatorTopic(assetCode: string): string {
  return `dt/factory/logistics/stacker/${assetCode}/twindatadriven/joint`;
}

/** 创建一条符合 twindatadriven/joint 协议的本地模拟消息。 */
export function createStackerSimulatorPayload(
  assetCode: string,
  scenario: StackerSimulationScenario,
  tick: number,
  startMs: number,
): StackerTelemetryPayload {
  const elapsedMs = Date.now() - startMs;
  const motion = resolveMotionState(elapsedMs, scenario);
  const target = motion.target ?? { x: 0, y: 0, z: 0 };
  const frontLocation = motion.target ?? { x: 21, y: 7, z: 0 };

  return {
    data: [
      createPayloadPoint(assetCode, 'deviceCode', '1'),
      createPayloadPoint(assetCode, 'front_command', motion.frontCommand),
      createPayloadPoint(assetCode, 'mode', motion.normal ? 3 : 4),
      createPayloadPoint(assetCode, 'back_command', motion.backCommand),
      createPayloadPoint(assetCode, 'front_z', frontLocation.z),
      createPayloadPoint(assetCode, 'front_x', frontLocation.x),
      createPayloadPoint(assetCode, 'front_y', frontLocation.y),
      createPayloadPoint(assetCode, 'front_task', tick),
      createPayloadPoint(assetCode, 'back_task', 0),
      createPayloadPoint(assetCode, 'front_containerCode', motion.frontContainerCode),
      createPayloadPoint(assetCode, 'back_containerCode', motion.backContainerCode),
      createPayloadPoint(assetCode, 'signalBits', tick % 2),
      createPayloadPoint(assetCode, 'front_signalBits', tick % 4),
      createPayloadPoint(assetCode, 'back_signalBits', tick % 3),
      createPayloadPoint(assetCode, 'movement_x', motion.movementX),
      createPayloadPoint(assetCode, 'movement_y', motion.movementY),
      createPayloadPoint(assetCode, 'front_movement_z', motion.frontMovementZ),
      createPayloadPoint(assetCode, 'back_movement_z', motion.backMovementZ),
      createPayloadPoint(assetCode, 'rpm_x', motion.movementX ? 45 : 0),
      createPayloadPoint(assetCode, 'rpm_y', motion.movementY ? 18 : 0),
      createPayloadPoint(assetCode, 'front_rpm_z', motion.frontMovementZ ? 12 : 0),
      createPayloadPoint(assetCode, 'back_rpm_z', motion.backMovementZ ? 10 : 0),
      createPayloadPoint(assetCode, 'distance_x', roundTelemetryValue(motion.distanceX)),
      createPayloadPoint(assetCode, 'distance_y', roundTelemetryValue(motion.distanceY)),
      createPayloadPoint(assetCode, 'front_distance_z', roundTelemetryValue(motion.frontDistanceZ)),
      createPayloadPoint(assetCode, 'back_distance_z', roundTelemetryValue(motion.backDistanceZ)),
      createPayloadPoint(assetCode, 'workingHours_x', roundTelemetryValue(elapsedMs / 3600000)),
      createPayloadPoint(assetCode, 'workingHours_y', roundTelemetryValue(elapsedMs / 7200000)),
      createPayloadPoint(assetCode, 'front_workingHours_z', roundTelemetryValue(elapsedMs / 9000000)),
      createPayloadPoint(assetCode, 'back_workingHours_z', roundTelemetryValue(elapsedMs / 9000000)),
      createPayloadPoint(assetCode, 'normal', motion.normal),
      createPayloadPoint(assetCode, 'errorCode', motion.errorCode),
      createPayloadPoint(assetCode, 'message', motion.message),
      createPayloadPoint(assetCode, 'to_z', target.z),
      createPayloadPoint(assetCode, 'to_x', target.x),
      createPayloadPoint(assetCode, 'to_y', target.y),
    ],
    ts: new Date().toISOString(),
  };
}

/** 创建 payload.data 中的单个点位。 */
function createPayloadPoint(assetCode: string, p: string, v: unknown): StackerPayloadPoint {
  return { e: assetCode, p, v };
}

/** 根据当前模拟场景生成运动、目标位和故障状态。 */
function resolveMotionState(elapsedMs: number, scenario: StackerSimulationScenario): StackerMotionState {
  if (scenario === 'fault') {
    return {
      target: { x: 1, y: 1, z: 1 },
      distanceX: 2.8,
      distanceY: 0.6,
      frontDistanceZ: 0.1,
      backDistanceZ: 0,
      movementX: 0,
      movementY: 0,
      frontMovementZ: 0,
      backMovementZ: 0,
      frontCommand: 8,
      backCommand: 8,
      frontContainerCode: '',
      backContainerCode: '',
      normal: false,
      errorCode: 9001,
      message: '模拟急停',
    };
  }

  const seconds = elapsedMs / 1000;
  const targetSequence = [
    { x: 1, y: 1, z: 1, distanceX: 4, distanceY: 1.2 },
    { x: 2, y: 1, z: 1, distanceX: 7, distanceY: 1.2 },
    { x: 3, y: 2, z: 1, distanceX: 10, distanceY: 2.2 },
  ];
  const sequenceIndex = Math.floor(seconds / 8) % targetSequence.length;
  const phaseProgress = (seconds % 8) / 8;
  const activeTarget = targetSequence[sequenceIndex];
  const forkCycle = Math.floor(seconds / 2) % 4;

  if (scenario === 'movement' || (scenario === 'cycle' && Math.floor(seconds / 24) % 2 === 1)) {
    const direction = Math.floor(seconds / 6) % 2 === 0 ? 1 : 2;
    return {
      target: null,
      distanceX: 5 + Math.sin(seconds * 0.65) * 2.4,
      distanceY: 1.2 + Math.sin(seconds * 0.4) * 0.6,
      frontDistanceZ: Math.max(0, Math.sin(seconds * 0.9) * 0.7),
      backDistanceZ: Math.max(0, Math.cos(seconds * 0.8) * 0.5),
      movementX: direction,
      movementY: Math.sin(seconds * 0.4) >= 0 ? 1 : 2,
      frontMovementZ: [1, 2, 3, 4][forkCycle],
      backMovementZ: [3, 4, 1, 2][forkCycle],
      frontCommand: 1,
      backCommand: 3,
      frontContainerCode: 'PALLET-MOVE-F',
      backContainerCode: 'PALLET-MOVE-B',
      normal: true,
      errorCode: 0,
      message: '全 0 目标位，按 movement 模拟移动',
    };
  }

  const activeSide: StackerForkSide = sequenceIndex % 2 === 0 ? 'front' : 'back';
  const cargoCode = `PALLET-${String(sequenceIndex + 1).padStart(2, '0')}-${activeTarget.x}${activeTarget.y}${activeTarget.z}`;
  const forkDistance = resolveTargetForkDistance(phaseProgress);
  const frontActive = activeSide === 'front';

  return {
    target: activeTarget,
    distanceX: activeTarget.distanceX + Math.sin(phaseProgress * Math.PI * 2) * 0.35,
    distanceY: activeTarget.distanceY + Math.sin(phaseProgress * Math.PI * 4) * 0.12,
    frontDistanceZ: frontActive ? forkDistance : 0,
    backDistanceZ: frontActive ? 0 : forkDistance,
    movementX: Math.cos(phaseProgress * Math.PI * 2) >= 0 ? 1 : 2,
    movementY: Math.cos(phaseProgress * Math.PI * 4) >= 0 ? 1 : 2,
    frontMovementZ: frontActive ? resolveTargetForkMovement(phaseProgress, 1, 2) : 0,
    backMovementZ: frontActive ? 0 : resolveTargetForkMovement(phaseProgress, 3, 4),
    frontCommand: frontActive ? resolveTargetForkCommand(phaseProgress) : 0,
    backCommand: frontActive ? 0 : resolveTargetForkCommand(phaseProgress),
    frontContainerCode: frontActive ? resolveTargetContainerCode(cargoCode, phaseProgress) : '',
    backContainerCode: frontActive ? '' : resolveTargetContainerCode(cargoCode, phaseProgress),
    normal: true,
    errorCode: 0,
    message: `${frontActive ? '前叉' : '后叉'}放货到目标位 ${activeTarget.x}-${activeTarget.y}-${activeTarget.z}`,
  };
}

/** 目标位演示中生成货叉作业命令：取货、携带、放货、请求卸货、放货完成。 */
function resolveTargetForkCommand(phaseProgress: number): number {
  if (phaseProgress < 0.18) return 1;
  if (phaseProgress < 0.52) return 2;
  if (phaseProgress < 0.8) return 3;
  if (phaseProgress < 0.92) return 4;
  return 5;
}

/** 目标位演示中生成货叉伸缩动作，前叉和后叉传入各自的伸出/缩回编码。 */
function resolveTargetForkMovement(phaseProgress: number, extendCode: number, retractCode: number): number {
  if (phaseProgress >= 0.52 && phaseProgress < 0.8) return extendCode;
  if (phaseProgress >= 0.92 && phaseProgress < 0.98) return retractCode;
  return 0;
}

/** 目标位演示中生成货叉编码器距离，用于校准货物进入虚拟定位框的过程。 */
function resolveTargetForkDistance(phaseProgress: number): number {
  if (phaseProgress < 0.52) return 0.12;
  if (phaseProgress < 0.8) return 0.12 + ((phaseProgress - 0.52) / 0.28) * 0.78;
  if (phaseProgress < 0.92) return 0.9;
  return Math.max(0.12, 0.9 - ((phaseProgress - 0.92) / 0.08) * 0.78);
}

/** 放货完成后清空叉上条码，验证运行时能让上一帧货物留在 locator 内。 */
function resolveTargetContainerCode(cargoCode: string, phaseProgress: number): string {
  return phaseProgress >= 0.96 ? '' : cargoCode;
}

/** 将模拟浮点数收敛到 4 位小数，避免快照中出现无意义长小数。 */
function roundTelemetryValue(value: number): number {
  return Math.round(value * 10000) / 10000;
}
