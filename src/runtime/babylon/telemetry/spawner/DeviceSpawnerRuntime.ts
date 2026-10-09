import {
  onDeviceTelemetryMessages,
  readStringField,
  type DeviceTelemetrySnapshot,
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
  /** 模板派生的设备类型，与消息 topic 段复合严格匹配。 */
  deviceType: string;
};

export type SpawnedDeviceKey = string;

/** 创建动态实例表键，产生器 id 与资产编号联合唯一。 */
export function createSpawnedDeviceKey(spawnerCode: string, assetCode: string): SpawnedDeviceKey {
  return [spawnerCode, assetCode].join('\u0000');
}

/** 产生器注册表键：spawnerCode 与设备类型复合严格匹配。 */
function createSpawnerRegistryKey(spawnerCode: string, deviceType: string): string {
  return [spawnerCode, deviceType.trim().toLowerCase()].join('\u0000');
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
  /** topic (sourceId, deviceType, assetCode) 是否已命中既有设备（静态实体或任一产生器的实例）。 */
  isDeviceKnown(sourceId: string, deviceType: string, assetCode: string): boolean;
};

type SpawnedDeviceRecord = {
  key: SpawnedDeviceKey;
  spawnerRegistryKey: string;
  spawnerCode: string;
  assetCode: string;
  lastMessageAt: number;
};

/** 判断快照是否携带显式下线点位。 */
function isOfflineSnapshot(snapshot: DeviceTelemetrySnapshot): boolean {
  const status = readStringField(snapshot.fields, DEVICE_SPAWN_OFFLINE_POINT_NAME);
  return status !== null && status.trim().toLowerCase() === DEVICE_SPAWN_OFFLINE_POINT_VALUE;
}

/**
 * 设备产生器运行时：维护 (spawnerCode, deviceType)→配置注册表与动态实例心跳表，
 * 订阅统一遥测消息流，按 实例反查保活/下线 → s 触发生成 的三段式判定驱动生命周期。
 */
export class DeviceSpawnerRuntime {
  private readonly spawners = new Map<string, DeviceSpawnerConfig>();
  private readonly instances = new Map<SpawnedDeviceKey, SpawnedDeviceRecord>();
  private readonly instancesByAssetCode = new Map<string, SpawnedDeviceRecord>();
  private readonly reportedMissingSpawnerCodes = new Set<string>();
  private unsubscribeMessages: (() => void) | null = null;

  constructor(private readonly host: DeviceSpawnerRuntimeHost) {}

  /** 运行预览开始时注册产生器配置并订阅遥测消息；重复调用先清空旧状态。 */
  configure(spawners: DeviceSpawnerConfig[]): void {
    this.disposeAll();
    for (const spawner of spawners) {
      if (!spawner.spawnerCode) continue;
      this.spawners.set(createSpawnerRegistryKey(spawner.spawnerCode, spawner.deviceType), spawner);
    }
    this.unsubscribeMessages = onDeviceTelemetryMessages((snapshot) => this.handleSnapshot(snapshot));
  }

  /** 资产编号是否已被本运行时的动态实例占用（含加载中的实例）。 */
  hasAssetCode(assetCode: string): boolean {
    return this.instancesByAssetCode.has(assetCode);
  }

  /** 每帧检查心跳超时；先收集后统一销毁，禁止边迭代边销毁。 */
  applyFrame(nowMs: number): void {
    if (this.instances.size === 0) return;
    const expiredKeys: SpawnedDeviceKey[] = [];
    for (const record of this.instances.values()) {
      const spawner = this.spawners.get(record.spawnerRegistryKey);
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
      this.removeInstance(key);
      if (record) {
        this.host.pushLog(`设备产生器实例已超时销毁：spawner=${record.spawnerCode}，assetCode=${record.assetCode}`);
      }
    }
  }

  /** 异步生成失败时丢弃实例记录，下一条消息可重试。 */
  dropInstance(key: SpawnedDeviceKey): void {
    const record = this.instances.get(key);
    this.instances.delete(key);
    if (record) this.instancesByAssetCode.delete(record.assetCode);
  }

  /** 结束预览时销毁全部动态实例并退订消息。 */
  disposeAll(): void {
    for (const key of [...this.instances.keys()]) {
      this.host.disposeDeviceInstance(key);
    }
    this.instances.clear();
    this.instancesByAssetCode.clear();
    this.spawners.clear();
    this.reportedMissingSpawnerCodes.clear();
    this.unsubscribeMessages?.();
    this.unsubscribeMessages = null;
  }

  private removeInstance(key: SpawnedDeviceKey): void {
    const record = this.instances.get(key);
    if (!record) return;
    this.instances.delete(key);
    this.instancesByAssetCode.delete(record.assetCode);
    this.host.disposeDeviceInstance(key);
  }

  private handleSnapshot(snapshot: DeviceTelemetrySnapshot): void {
    const record = this.instancesByAssetCode.get(snapshot.assetCode);
    if (record) {
      if (isOfflineSnapshot(snapshot)) {
        this.removeInstance(record.key);
        this.host.pushLog(`设备产生器实例已下线销毁：spawner=${record.spawnerCode}，assetCode=${record.assetCode}`);
        return;
      }
      record.lastMessageAt = snapshot.receivedAt;
      return;
    }

    // 实例未知时的显式下线消息没有处理对象，直接忽略。
    if (isOfflineSnapshot(snapshot)) return;

    const spawnerCode = snapshot.spawnerCode;
    if (!spawnerCode) return;

    const spawnerRegistryKey = createSpawnerRegistryKey(spawnerCode, snapshot.deviceType);
    const spawner = this.spawners.get(spawnerRegistryKey);
    if (!spawner) {
      if (!this.reportedMissingSpawnerCodes.has(spawnerRegistryKey)) {
        this.reportedMissingSpawnerCodes.add(spawnerRegistryKey);
        this.host.pushLog(`设备产生器消息未匹配到产生器：spawner=${spawnerCode}，deviceType=${snapshot.deviceType}，assetCode=${snapshot.assetCode}`);
      }
      return;
    }

    // 静态实体或任一产生器的实例已占用该编号时不再生成，消息直达既有设备。
    if (this.host.isDeviceKnown(snapshot.sourceId, snapshot.deviceType, snapshot.assetCode)) return;

    const key = createSpawnedDeviceKey(spawnerCode, snapshot.assetCode);
    if (this.instances.has(key)) return;
    if (!this.host.spawnDeviceInstance(spawner, snapshot.assetCode)) return;
    const spawnedRecord: SpawnedDeviceRecord = {
      key,
      spawnerRegistryKey,
      spawnerCode,
      assetCode: snapshot.assetCode,
      lastMessageAt: snapshot.receivedAt,
    };
    this.instances.set(key, spawnedRecord);
    this.instancesByAssetCode.set(snapshot.assetCode, spawnedRecord);
    this.host.pushLog(`设备产生器生成实例：spawner=${spawnerCode}，assetCode=${snapshot.assetCode}`);
  }
}
