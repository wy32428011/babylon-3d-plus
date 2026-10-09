import { ingestDeviceTelemetryMessage } from './deviceTelemetry';

type DeviceSpawnSimulatorLog = (message: string) => void;

/** 单个产生器的模拟目标：按 spawnerCode 生成固定资产编号池。 */
export type DeviceSpawnSimulatorTarget = {
  spawnerCode: string;
  deviceType: string;
  deviceCount: number;
  /** 每帧每台设备随机下线的概率，0 表示从不下线。 */
  offlineProbability?: number;
};

export type DeviceSpawnSimulatorConfig = {
  enabled: boolean;
  intervalMs: number;
  sourceId?: string;
  targets: DeviceSpawnSimulatorTarget[];
};

type SimulatedDevice = {
  assetCode: string;
  online: boolean;
  /** 是否已向上行宣告过产生器 id（s）；下线后重置，重新上线首条消息再次携带。 */
  announced: boolean;
  phase: number;
};

/** 无 broker 时本地生成设备产生器消息，走 ingestDeviceTelemetryMessage 与真实 MQTT 同一入口。 */
export class DeviceSpawnSimulator {
  private configSignature = '';
  private timerId: number | null = null;
  private tick = 0;
  private readonly devices = new Map<string, SimulatedDevice[]>();

  constructor(private readonly pushLog: DeviceSpawnSimulatorLog) {}

  /** 根据配置启动、停止或切换本地模拟。 */
  updateConfig(config: DeviceSpawnSimulatorConfig): void {
    const signature = JSON.stringify({
      enabled: config.enabled,
      intervalMs: config.intervalMs,
      sourceId: config.sourceId,
      targets: config.targets,
    });
    if (signature === this.configSignature) return;

    this.configSignature = signature;
    this.stop();

    if (!config.enabled || config.targets.length === 0) return;

    this.start(config);
  }

  /** 释放定时器并清空模拟设备池。 */
  dispose(): void {
    this.configSignature = '';
    this.stop();
  }

  /** 创建定时器，并立即推送第一帧，保证开始预览后无需等待即可看到实例生成。 */
  private start(config: DeviceSpawnSimulatorConfig): void {
    this.tick = 0;
    this.devices.clear();
    for (const target of config.targets) {
      const pool: SimulatedDevice[] = [];
      const count = Math.max(1, Math.floor(target.deviceCount));
      for (let index = 0; index < count; index += 1) {
        pool.push({
          assetCode: `${target.spawnerCode}-${String(index + 1).padStart(2, '0')}`,
          online: true,
          announced: false,
          phase: index * 0.7,
        });
      }
      this.devices.set(target.spawnerCode, pool);
    }

    this.emitFrame(config);
    this.timerId = window.setInterval(() => {
      this.tick += 1;
      this.emitFrame(config);
    }, Math.max(100, config.intervalMs));
    this.pushLog(
      `设备产生器本地模拟已启动：${config.targets.map((target) => `${target.spawnerCode}×${target.deviceCount}`).join('、')}，间隔 ${config.intervalMs}ms`,
    );
  }

  /** 停止模拟定时器。 */
  private stop(): void {
    if (this.timerId !== null) {
      window.clearInterval(this.timerId);
      this.timerId = null;
      this.pushLog('设备产生器本地模拟已停止。');
    }
    this.devices.clear();
  }

  /** 逐设备生成一帧模拟消息并经统一入口投递，保持与真实 MQTT 消息一致的数据通路。 */
  private emitFrame(config: DeviceSpawnSimulatorConfig): void {
    for (const target of config.targets) {
      const pool = this.devices.get(target.spawnerCode);
      if (!pool) continue;
      for (const device of pool) {
        const payload = createDeviceSpawnSimulatorPayload(target, device, this.tick);
        if (!payload) continue;
        const topic = createDeviceSpawnSimulatorTopic(target.deviceType, device.assetCode);
        ingestDeviceTelemetryMessage(topic, JSON.stringify(payload), {
          adapter: { kind: 'epv', sourceId: config.sourceId },
        });
      }
    }
  }
}

/** 生成动态设备的常规遥测 topic（与真实设备一致，assetCode 为设备自身编号）。 */
export function createDeviceSpawnSimulatorTopic(deviceType: string, assetCode: string): string {
  return `dt/factory/logistics/${deviceType}/${assetCode}/twindatadriven/joint`;
}

/**
 * 创建一台设备的模拟消息，含随机的下线/上线事件；返回 null 表示本帧该设备无消息。
 * 上线首条消息点位携带 s（产生器 id），后续保活不再携带。
 */
export function createDeviceSpawnSimulatorPayload(
  target: DeviceSpawnSimulatorTarget,
  device: SimulatedDevice,
  tick: number,
): { data: { p: string; v: unknown; s?: string }[]; ts: string } | null {
  const seconds = tick * 0.5;
  const offlineProbability = target.offlineProbability ?? 0.02;

  if (device.online && offlineProbability > 0 && Math.random() < offlineProbability) {
    device.online = false;
    device.announced = false;
    return { data: [{ p: 'status', v: 'offline' }], ts: new Date().toISOString() };
  }
  if (!device.online) {
    // 下线后停留一帧再上线，保证销毁可被观察到
    device.online = true;
  }

  const s = device.announced ? undefined : target.spawnerCode;
  device.announced = true;
  const wave = Math.sin(seconds * 0.6 + device.phase);
  return {
    data: [
      { p: 'deviceCode', v: device.assetCode, s },
      { p: 'movement_x', v: wave >= 0 ? 1 : 2, s },
      { p: 'distance_x', v: Math.round((5 + wave * 3 + device.phase) * 10000) / 10000, s },
      { p: 'normal', v: true, s },
      { p: 'errorCode', v: 0, s },
      { p: 'message', v: '模拟运行', s },
    ],
    ts: new Date().toISOString(),
  };
}
