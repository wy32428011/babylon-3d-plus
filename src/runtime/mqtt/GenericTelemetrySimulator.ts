import type { MqttConfig } from '../../editor/model/SceneDocument';
import {
  DEFAULT_TELEMETRY_SOURCE_ID,
  deviceTelemetryStore,
  parseDeviceTelemetryMessage,
} from './deviceTelemetry';

type GenericTelemetrySimulatorLog = (message: string) => void;

type GenericTelemetryPhase = 'forward' | 'reverse' | 'fault' | 'stale' | 'recovery';

type GenericPayloadPoint = {
  e: string;
  p: string;
  v: unknown;
};

export type GenericTelemetryPayload = {
  seq: number;
  ts: number;
  data: GenericPayloadPoint[];
};

const GENERIC_SIMULATOR_DEVICE_TYPE = 'generic-machine';
const GENERIC_SIMULATOR_DEFAULT_ASSET_CODES = ['GEN-A', 'GEN-B'] as const;
const GENERIC_SIMULATOR_CYCLE_MS = 20_000;
const GENERIC_SIMULATOR_STALE_START_MS = 12_000;
const GENERIC_SIMULATOR_STALE_END_MS = 16_000;

/** 在没有 broker 时按 EPV 协议生成通用设备遥测，验证非 Stacker 资产的数据入口。 */
export class GenericTelemetrySimulator {
  private configSignature = '';
  private timerId: number | null = null;
  private startMs = 0;
  private tick = 0;
  private lastLoggedPhase: GenericTelemetryPhase | null = null;
  private readonly sourceId = DEFAULT_TELEMETRY_SOURCE_ID;

  constructor(private readonly pushLog: GenericTelemetrySimulatorLog) {}

  /** 根据场景配置启动、停止或切换 generic 本地模拟数据源。 */
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
    this.stop(true);

    if (!config.enabled || !config.simulatorEnabled || config.simulatorScenario !== 'generic') return;

    this.start(config);
  }

  /** 释放定时器并清理 generic 模拟状态。 */
  dispose(): void {
    this.configSignature = '';
    this.stop(true);
  }

  /** 创建定时器并立即发出首帧，避免首帧被其他模拟器清理。 */
  private start(config: MqttConfig): void {
    this.startMs = Date.now();
    this.tick = 0;
    this.lastLoggedPhase = null;
    this.emitFrame(config);
    this.timerId = window.setInterval(() => {
      this.tick += 1;
      this.emitFrame(config);
    }, config.simulatorIntervalMs);
    this.pushLog(
      `generic 本地模拟已启动：${resolveGenericSimulatorAssetCodes(config.simulatorAssetCode).join(', ')}，间隔 ${config.simulatorIntervalMs}ms`,
    );
  }

  /** 停止定时器，并按 sourceId 清理本模拟器写入的快照。 */
  private stop(clearStore: boolean): void {
    if (this.timerId !== null) {
      window.clearInterval(this.timerId);
      this.timerId = null;
      this.pushLog('generic 本地模拟已停止。');
    }
    if (clearStore) {
      deviceTelemetryStore.clearSource(this.sourceId);
    }
  }

  /** 生成所有 generic 资产的一帧模拟消息，并复用真实 EPV 解析入口写入 store。 */
  private emitFrame(config: MqttConfig): void {
    const nowMs = Date.now();
    const elapsedMs = nowMs - this.startMs;
    const phase = resolveGenericTelemetryPhase(elapsedMs);
    this.logPhaseChange(phase);

    const assetCodes = resolveGenericSimulatorAssetCodes(config.simulatorAssetCode);
    assetCodes.forEach((assetCode, assetIndex) => {
      const payload = createGenericTelemetrySimulatorPayload(assetCode, this.tick, nowMs, this.startMs, assetIndex, assetCodes.length);
      if (!payload) return;

      const snapshot = parseDeviceTelemetryMessage(
        createGenericTelemetrySimulatorTopic(assetCode),
        JSON.stringify(payload),
        { kind: 'epv', sourceId: this.sourceId },
      );
      if (!snapshot) return;
      deviceTelemetryStore.upsert(snapshot);
    });
  }

  /** 仅在阶段变化时输出日志，避免 500ms 循环刷屏。 */
  private logPhaseChange(phase: GenericTelemetryPhase): void {
    if (phase === this.lastLoggedPhase) return;
    this.lastLoggedPhase = phase;
    this.pushLog(`generic 本地模拟阶段：${phase}`);
  }
}

/** 根据资产编号生成 generic 设备的真实可解析 EPV topic。 */
export function createGenericTelemetrySimulatorTopic(assetCode: string): string {
  return `dt/factory/logistics/${GENERIC_SIMULATOR_DEVICE_TYPE}/${assetCode}/twindatadriven/joint`;
}

/** 创建一条 generic 设备 EPV payload；stale 阶段返回 null 表示连续不发消息。 */
export function createGenericTelemetrySimulatorPayload(
  assetCode: string,
  sequence: number,
  nowMs: number,
  startMs: number,
  assetIndex: number,
  assetCount: number,
): GenericTelemetryPayload | null {
  const elapsedMs = nowMs - startMs;
  const globalPhase = resolveGenericTelemetryPhase(elapsedMs);
  if (globalPhase === 'stale') return null;

  const operationPhase = resolveAssetGenericTelemetryPhase(globalPhase, assetIndex);
  const direction = assetCount > 1 && assetIndex % 2 === 1 ? -1 : 1;
  const cycleMs = ((elapsedMs % GENERIC_SIMULATOR_CYCLE_MS) + GENERIC_SIMULATOR_CYCLE_MS) % GENERIC_SIMULATOR_CYCLE_MS;
  const normal = globalPhase !== 'fault';
  const errorCode = normal ? 0 : 5001;

  return {
    seq: sequence,
    ts: nowMs,
    data: [
      createGenericPayloadPoint(assetCode, 'position_x', roundGenericTelemetryValue(direction * resolveGenericTravelOffset(globalPhase, cycleMs))),
      createGenericPayloadPoint(assetCode, 'joint_angle_deg', roundGenericTelemetryValue(direction * resolveGenericJointAngle(globalPhase, cycleMs))),
      createGenericPayloadPoint(assetCode, 'operation_state', operationPhase),
      createGenericPayloadPoint(assetCode, 'normal', normal),
      createGenericPayloadPoint(assetCode, 'errorCode', errorCode),
      createGenericPayloadPoint(assetCode, 'message', `generic ${operationPhase}`),
    ],
  };
}

/** 从逗号分隔配置提取最多两台 generic 资产，空值回退到示例资产。 */
export function resolveGenericSimulatorAssetCodes(value: string): string[] {
  const assetCodes = value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 2);

  return assetCodes.length ? assetCodes : [...GENERIC_SIMULATOR_DEFAULT_ASSET_CODES];
}

/** 根据 20 秒周期解析 generic 模拟阶段，stale 持续 4 秒不发消息。 */
function resolveGenericTelemetryPhase(elapsedMs: number): GenericTelemetryPhase {
  const cycleMs = ((elapsedMs % GENERIC_SIMULATOR_CYCLE_MS) + GENERIC_SIMULATOR_CYCLE_MS) % GENERIC_SIMULATOR_CYCLE_MS;
  if (cycleMs < 5_000) return 'forward';
  if (cycleMs < 9_000) return 'reverse';
  if (cycleMs < GENERIC_SIMULATOR_STALE_START_MS) return 'fault';
  if (cycleMs < GENERIC_SIMULATOR_STALE_END_MS) return 'stale';
  return 'recovery';
}

/** 按阶段生成有界平移偏移，恢复阶段从故障冻结位置平滑回到基线。 */
function resolveGenericTravelOffset(phase: GenericTelemetryPhase, cycleMs: number): number {
  if (phase === 'forward') return interpolateGenericValue(0.2, 2.4, cycleMs / 5_000);
  if (phase === 'reverse') return interpolateGenericValue(2.4, -1.8, (cycleMs - 5_000) / 4_000);
  if (phase === 'fault') return -1.8;
  return interpolateGenericValue(-1.8, 0, (cycleMs - GENERIC_SIMULATOR_STALE_END_MS) / 4_000);
}

/** 按阶段生成有界关节角度，两个资产通过方向因子形成相反旋转。 */
function resolveGenericJointAngle(phase: GenericTelemetryPhase, cycleMs: number): number {
  if (phase === 'forward') return interpolateGenericValue(15, 60, cycleMs / 5_000);
  if (phase === 'reverse') return interpolateGenericValue(60, -45, (cycleMs - 5_000) / 4_000);
  if (phase === 'fault') return -45;
  return interpolateGenericValue(-45, 0, (cycleMs - GENERIC_SIMULATOR_STALE_END_MS) / 4_000);
}

/** 在线性阶段内插值，并把进度约束在 0 到 1。 */
function interpolateGenericValue(from: number, to: number, progress: number): number {
  const clampedProgress = Math.min(1, Math.max(0, progress));
  return from + (to - from) * clampedProgress;
}

/** 让相邻 generic 资产在正常行走阶段方向相反，故障和恢复阶段保持同步。 */
function resolveAssetGenericTelemetryPhase(phase: GenericTelemetryPhase, assetIndex: number): GenericTelemetryPhase {
  if (assetIndex % 2 === 0) return phase;
  if (phase === 'forward') return 'reverse';
  if (phase === 'reverse') return 'forward';
  return phase;
}

/** 创建单个 EPV 点位，保持 e/p/v 与真实解析器一致。 */
function createGenericPayloadPoint(assetCode: string, name: string, value: unknown): GenericPayloadPoint {
  return { e: assetCode, p: name, v: value };
}

/** 收敛浮点输出，避免模拟数据出现无意义长小数。 */
function roundGenericTelemetryValue(value: number): number {
  return Math.round(value * 10000) / 10000;
}
