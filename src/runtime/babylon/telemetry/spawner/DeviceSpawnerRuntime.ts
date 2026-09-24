import {
  createSpawnSnapshot,
  deviceTelemetryStore,
  onDeviceSpawnMessages,
  type DeviceSpawnMessage,
} from '../../../mqtt/deviceTelemetry';

/** 显式下线点位（暂定协议，后续按真实协议调整时只改这两个常量）。 */
export const DEVICE_SPAWN_OFFLINE_POINT_NAME = 'status';
export const DEVICE_SPAWN_OFFLINE_POINT_VALUE = 'offline';

/** 产生器注册配置：beginTelemetryPreview 时从场景实体解析。 */
export type DeviceSpawnerConfig = {
  entityId: string;
  entityName: string;
  spawnerCode: string;
  templateEntityId: string;
  timeoutSeconds: number;
  /** 模板派生的设备类型，快照归一用（消息 topic 段可能与驱动类型不一致）。 */
  deviceType: string;
};

export type SpawnedDeviceKey = string;

/** 创建动态实例表键，产生器 id 与资产编号联合唯一。 */
export function createSpawnedDeviceKey(spawnerCode: string, assetCode: string): SpawnedDeviceKey {
  return [spawnerCode, assetCode].join('\u0000');
}

/**
 * 动态实例的运行时合成实体 id：实例不写入场景文档，用它与真实实体 id 区分开，
 * 高亮、聚焦与生成器产物点击都按这个 id 寻址。
 */
export function createSpawnedDeviceEntityId(spawnerCode: string, assetCode: string): string {
  return `spawned:${createSpawnedDeviceKey(spawnerCode, assetCode)}`;
}

/** 从合成实体 id 还原实例表键；不是合成 id 时返回 null。 */
export function parseSpawnedDeviceEntityId(entityId: string): SpawnedDeviceKey | null {
  return entityId.startsWith('spawned:') ? entityId.slice('spawned:'.length) : null;
}

export type DeviceSpawnerRuntimeHost = {
  pushLog(message: string): void;
  /**
   * 基于模板派生一台动态设备实例（异步加载 + 脚本绑定）。
   * 模板未就绪返回 false，调用方丢弃实例记录并等待下一条消息重试。
   */
  spawnDeviceInstance(spawner: DeviceSpawnerConfig, assetCode: string): boolean;
  disposeDeviceInstance(key: SpawnedDeviceKey): void;
};

type SpawnedDeviceRecord = {
  key: SpawnedDeviceKey;
  spawnerCode: string;
  assetCode: string;
  lastMessageAt: number;
};

/** 判断消息是否携带显式下线点位。 */
function isOfflineMessage(message: DeviceSpawnMessage): boolean {
  return message.points.some(
    (point) => point.p === DEVICE_SPAWN_OFFLINE_POINT_NAME
      && String(point.v).trim().toLowerCase() === DEVICE_SPAWN_OFFLINE_POINT_VALUE,
  );
}

/**
 * 设备产生器运行时：维护 spawnerCode→配置注册表与动态实例心跳表，
 * 消息驱动生成/销毁，快照转交 deviceTelemetryStore 由现有专用驱动消费。
 */
export class DeviceSpawnerRuntime {
  private readonly spawners = new Map<string, DeviceSpawnerConfig>();
  private readonly instances = new Map<SpawnedDeviceKey, SpawnedDeviceRecord>();
  private readonly reportedMissingSpawnerCodes = new Set<string>();
  private unsubscribeMessages: (() => void) | null = null;

  constructor(private readonly host: DeviceSpawnerRuntimeHost) {}

  /** 运行预览开始时注册产生器配置并订阅产生器消息；重复调用先清空旧状态。 */
  configure(spawners: DeviceSpawnerConfig[]): void {
    this.disposeAll();
    for (const spawner of spawners) {
      if (!spawner.spawnerCode) continue;
      this.spawners.set(spawner.spawnerCode, spawner);
    }
    this.unsubscribeMessages = onDeviceSpawnMessages((messages) => this.handleMessages(messages));
  }

  /** 每帧检查心跳超时；先收集后统一销毁，禁止边迭代边销毁。 */
  applyFrame(nowMs: number): void {
    if (this.instances.size === 0) return;
    const expiredKeys: SpawnedDeviceKey[] = [];
    for (const record of this.instances.values()) {
      const spawner = this.spawners.get(record.spawnerCode);
      if (!spawner) {
        expiredKeys.push(record.key);
        continue;
      }
      if (nowMs - record.lastMessageAt > spawner.timeoutSeconds * 1000) {
        expiredKeys.push(record.key);
      }
    }
    for (const key of expiredKeys) {
      const record = this.instances.get(key);
      this.instances.delete(key);
      this.host.disposeDeviceInstance(key);
      if (record) {
        this.host.pushLog(`设备产生器实例已超时销毁：spawner=${record.spawnerCode}，assetCode=${record.assetCode}`);
      }
    }
  }

  /** 异步生成失败时丢弃实例记录，下一条消息可重试。 */
  dropInstance(key: SpawnedDeviceKey): void {
    this.instances.delete(key);
  }

  /** 结束预览时销毁全部动态实例并退订消息。 */
  disposeAll(): void {
    for (const key of [...this.instances.keys()]) {
      this.host.disposeDeviceInstance(key);
    }
    this.instances.clear();
    this.spawners.clear();
    this.reportedMissingSpawnerCodes.clear();
    this.unsubscribeMessages?.();
    this.unsubscribeMessages = null;
  }

  private handleMessages(messages: DeviceSpawnMessage[]): void {
    for (const message of messages) {
      const spawner = this.spawners.get(message.spawnerCode);
      if (!spawner) {
        if (!this.reportedMissingSpawnerCodes.has(message.spawnerCode)) {
          this.reportedMissingSpawnerCodes.add(message.spawnerCode);
          this.host.pushLog(`设备产生器消息未匹配到产生器：spawner=${message.spawnerCode}，assetCode=${message.assetCode}`);
        }
        continue;
      }

      const key = createSpawnedDeviceKey(message.spawnerCode, message.assetCode);
      if (isOfflineMessage(message)) {
        if (this.instances.delete(key)) {
          this.host.disposeDeviceInstance(key);
          this.host.pushLog(`设备产生器实例已下线销毁：spawner=${message.spawnerCode}，assetCode=${message.assetCode}`);
        }
        continue;
      }

      const record = this.instances.get(key);
      if (record) {
        record.lastMessageAt = message.receivedAt;
      } else {
        if (!this.host.spawnDeviceInstance(spawner, message.assetCode)) continue;
        this.instances.set(key, {
          key,
          spawnerCode: message.spawnerCode,
          assetCode: message.assetCode,
          lastMessageAt: message.receivedAt,
        });
        this.host.pushLog(`设备产生器生成实例：spawner=${message.spawnerCode}，assetCode=${message.assetCode}`);
      }

      // 快照设备类型以模板派生为准（topic 段是暂定协议，可能与驱动类型不一致）；模板未配置时沿用 topic 段。
      deviceTelemetryStore.upsert(createSpawnSnapshot({ ...message, deviceType: spawner.deviceType || message.deviceType }));
    }
  }
}
