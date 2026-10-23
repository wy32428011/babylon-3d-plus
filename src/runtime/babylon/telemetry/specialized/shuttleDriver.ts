import type { Scene } from '@babylonjs/core';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import {
  resolveLocatorBoxIndex,
  resolveLocatorCellSupportWorldPosition,
} from '../stackerStorageLocation';
import {
  clampNumber,
  filterTopLevelMotionNodes,
  findModelNodes,
  findModelNodesByName,
  getHorizontalModelAxis,
  getModelAxis,
  getModelTransformNodes,
  getNodesProjectedBounds,
  getNodesWorldBounds,
  getNodeWorldPosePreservingMirror,
  moveNumberTowards,
  moveVectorTowards,
  projectPointOntoAxis,
  projectWorldBoundsOntoAxis,
  worldDeltaToParentLocalDelta,
} from '../../runtimeNodeGeometry';
import { isPlainRecord, readStringArrayPath, sanitizeBabylonName } from '../../runtimeValueUtils';
import {
  readIntegerField,
  readStringField,
  type DeviceTelemetrySnapshot,
} from '../../../mqtt/deviceTelemetry';
import type { LocatorRuntimeEntry, ModelRuntimeEntry } from '../../SceneRuntime';
import { writeDeviceTelemetryMetadata } from './telemetryMetadata';
import {
  createCargoHandoffState,
  createCargoSpawnWorldRotation,
  createRetainedSlotCargoKey,
  takeRetainedSlotCargo,
  HCLIFT_DECK_OCCUPANCY_STALE_MS,
  type GeneratedCargoRuntimeEntry,
  type HcliftPlatformSurfaceState,
  normalizeCargoTask,
  resolveCargoHandoffPose,
  type RgvTravelConstraint,
  type ShuttleCargoRuntimeEntry,
  SHUTTLE_CATCH_UP_MAX_WINDOW_SECONDS,
  SHUTTLE_CATCH_UP_MIN_WINDOW_SECONDS,
  SHUTTLE_DEFAULT_FORK_SPEED_METERS_PER_SECOND,
  SHUTTLE_DEFAULT_TRAVEL_SPEED_METERS_PER_SECOND,
  SHUTTLE_FORK_CATCH_UP_SPEED_MULTIPLIER,
  SHUTTLE_MAX_CATCH_UP_SPEED_METERS_PER_SECOND,
  type SlotPlaceTarget,
  type SpecializedTelemetryDriverContext,
  type SpecializedTelemetryHost,
  type SpecializedTelemetrySharedState,
} from './types';

/**
 * 小车驶入/驶出换层站台与提升机载货台的速度上限（m/s）。
 * 普通走线 2 m/s 直接上台对位过冲明显，进出载货台统一降到该速度；机内普通走行不受影响。
 * 载货台进出可用数据驱动绑定 telemetryBinding.shuttleDeckTravelSpeed 覆盖，换层站台（x=-1）固定该常量。
 */
const SHUTTLE_PLATFORM_TRAVEL_SPEED_METERS_PER_SECOND = 0.5;

/** 遥测解析出的目标货格：to_x/to_y 列层 + to_z 排号 + to_Depth 解码出的排深与支撑位世界坐标。 */
type ShuttleTargetCell = {
  locator: LocatorRuntimeEntry;
  supportPosition: Vector3;
  toX: number;
  toY: number;
  row: number;
  /** 目标货格排深（to_Depth 解码）：near 浅库位 / far 深库位。 */
  storageDepth: LocatorRuntimeEntry['storageDepth'];
  /** 换层站台货格（x 负值语义）：站台不支持装卸货，Status=1/3 伸叉被抑制。 */
  isLayerChangePlatform?: boolean;
  /** 匹配到的 hclift 载货台键（共享占位表）；x=-1/-2 时用于占位上报。 */
  hcliftKey?: string;
  /** 匹配到的 hclift 当前 work_state：1（取小车中）允许进梯，3（卸小车中）允许出梯，其余锁住进出。 */
  hcliftWorkState?: number | null;
  /** 匹配到的 hclift 载货台水平中心（仅门控用，不参与走行目标）。 */
  hcliftDeckCenter?: Vector3;
  /** x=-2 时 hclift 载货台水平中心：存在时以其为上台走行目标（而非站台货格中心）。 */
  deckCenter?: Vector3;
  /** 到层自动出梯（中/完成）：目标为目标层站台格而非载货台中心，Status=0 也走行。 */
  exitToPlatform?: boolean;
};

/**
 * to_Depth 值 → 库位排深：2→浅库位（near），8→深库位（far），0→无排深接驳位（输送线内置货格，不按排深过滤）。
 * 其它值或字段缺失返回 null（非法）。
 */
function decodeShuttleStorageDepth(
  toDepth: number | null,
): LocatorRuntimeEntry['storageDepth'] | undefined | null {
  if (toDepth === 0) return undefined;
  if (toDepth === 2) return 'near';
  if (toDepth === 8) return 'far';
  return null;
}

/**
 * 多穿小车 Status 枚举（设备新协议）：
 * 0 空闲待机 / 1 取货中 / 2 取货完成 / 3 卸货中 / 4 卸货完成 / 5 移动中 / 6 移动完成 / 10 急停 / 11 未知。
 * _finish 事件不保证送达，只作为非动作状态静默忽略，动作完结由驱动自身的伸叉/收叉动画决定。
 */
const SHUTTLE_STATUS = {
  idle: 0,
  taking: 1,
  takeFinish: 2,
  unloading: 3,
  unloadFinish: 4,
  moving: 5,
  moveFinish: 6,
  emergencyStop: 10,
  unknown: 11,
} as const;

const SHUTTLE_STATUS_LABELS: Record<number, string> = {
  [SHUTTLE_STATUS.idle]: '空闲待机',
  [SHUTTLE_STATUS.taking]: '取货中',
  [SHUTTLE_STATUS.takeFinish]: '取货完成',
  [SHUTTLE_STATUS.unloading]: '卸货中',
  [SHUTTLE_STATUS.unloadFinish]: '卸货完成',
  [SHUTTLE_STATUS.moving]: '移动中',
  [SHUTTLE_STATUS.moveFinish]: '移动完成',
  [SHUTTLE_STATUS.emergencyStop]: '急停触发',
  [SHUTTLE_STATUS.unknown]: '未知',
};

/** 列号未知哨兵：进出换层提升机的过渡帧会上报 255 且 y=0，此时按载货台过渡处理而非普通目标。 */
const SHUTTLE_COLUMN_UNKNOWN = 255;

/** 走行到位判定余量（米）：Status=1/3 伸叉前要求车体已对准目标格。 */
const SHUTTLE_TRAVEL_ARRIVE_TOLERANCE_METERS = 0.02;
/** hclift 台面高度发布的保鲜阈值：超过视为失联滞留值，小车回退按层闪现。 */
const HCLIFT_PLATFORM_SURFACE_STALE_MS = 2000;

/**
 * 多穿小车遥测驱动：Status 单字段状态机（0 待机 / 1 取货中 / 3 卸货中 / 5 移动中 / 10 急停）。
 * - 走行仅 Z 轴（Status=5 向目标格推进），Y 层变换无动画、每帧闪现对齐目标格层高（载货平面顶面与货格底面持平）；
 * - 目标货格由 to_x/to_y/to_z（列/层/排）与 to_Depth（2=浅、8=深库位）指向当前阶段动作格，先按绑定设备匹配、再按绑定巷道（aisleCode）匹配；
 * - 两段货叉沿 X 比例联动：二段偏移 = forkOffset，一段 = forkOffset / 2，同步启动同步到位；
 * - Status=1 货从格到车（伸满绑定、收回完结），Status=3 货从车到格（伸满解绑落格、收回完结）。
 */
export class ShuttleTelemetryDriver {
  /** 只读暴露实际驱动解析的运动节点，光照分类不另建名称猜测规则。 */
  getLightingMotionNodes(model: ModelRuntimeEntry): { moving: TransformNode[]; fixed: TransformNode[] } {
    return { moving: [...new Set([...this.findShuttleTravelNodes(model), ...this.findShuttleForkStage1Nodes(model), ...this.findShuttleForkStage2Nodes(model)])], fixed: this.findShuttleFixedNodes(model) };
  }

  constructor(private readonly context: SpecializedTelemetryDriverContext) {}

  private get scene(): Scene {
    return this.context.scene;
  }

  private get state(): SpecializedTelemetrySharedState {
    return this.context.state;
  }

  private get host(): SpecializedTelemetryHost {
    return this.context.host;
  }

  /** 对单台多穿小车应用走行、货叉伸缩和货物状态机的遥测驱动。 */
  applyToModel(model: ModelRuntimeEntry, snapshot: DeviceTelemetrySnapshot, deltaSeconds: number): void {
    const state = model.shuttleTelemetry;
    const status = readIntegerField(snapshot.fields, 'Status');
    const task = normalizeCargoTask(readIntegerField(snapshot.fields, 'task'));
    const containerCode = readStringField(snapshot.fields, 'containerCode')?.trim() ?? '';
    this.reportShuttleRuntimeState(snapshot, status);
    writeDeviceTelemetryMetadata(model, snapshot);

    const target = this.resolveShuttleTargetCell(model, snapshot);
    if (status !== null) {
      // Status 相位退出边沿收尾须在目标格跳变跟踪之前：同帧「Status 跳变 + 目标格跳变」时先清滞留状态，避免 catch-up 误判
      this.completeShuttleCargoOnStatusExit(model, status, target.cell);
      this.trackShuttleTargetCellChange(model, target.key, target.cell, status);
    }

    // 无目标（to_* 全 0 / 字段缺失，典型为 Status=2/4 完结帧）时保持上一帧 Y 姿态，不弹回模型初始高度
    const yFlashOffset = target.cell
      ? this.resolveShuttleYFlashOffset(model, target.cell)
      : state.lastYFlashOffset ?? Vector3.Zero();
    if (target.cell) state.lastYFlashOffset = yFlashOffset.clone();

    if (status === SHUTTLE_STATUS.emergencyStop) {
      // 急停：冻结走行与货叉，保持当前姿态等待状态恢复
    } else if (state.forkCatchUp) {
      this.applyShuttleForkCatchUpRetract(model, deltaSeconds);
    } else if (status !== null) {
      const travel = this.applyShuttleTravelMotion(model, snapshot, status, target.cell, deltaSeconds);
      this.applyShuttleStatusPhase(model, snapshot, status, task, containerCode, target, travel, deltaSeconds);
    }
    this.syncHcliftDeckOccupancy(model, snapshot, status, target.cell);
    this.applyShuttleNodeMotionOffsets(model, yFlashOffset);
    this.updateShuttleCargoPose(model, snapshot, deltaSeconds);
    this.writeShuttleTelemetryMetadata(model, snapshot, status, target.cell?.locator ?? null);
    if (status !== null) state.lastStatus = status;
  }

  // ===== 目标货格解析（绑定设备 → 绑定巷道） =====

  /** 读取小车绑定的巷道编号（模型参数 aisleCode）；空串表示未配置，不参与巷道匹配。 */
  private resolveShuttleAisleCode(model: ModelRuntimeEntry): string {
    const value = model.entitySnapshot?.components.modelAsset?.parameterValues?.['aisleCode'];
    return typeof value === 'string' ? value.trim() : '';
  }

  /**
   * 目标货格解析：x 字段优先于 to_x/to_y/to_z/to_Depth——
   * x=-1/-2 指向换层站台货格（层取 y 字段，排固定站台排），x>=0 或字段缺失走原 to_x/to_y/to_z/to_Depth 逻辑：
   * 列/层/排全 0（无目标/任务完结）、或目标字段整体缺失（本帧未报目标）返回无目标；
   * to_x/to_y/to_z 任一缺失、to_Depth 非 2/8、或绑定设备与绑定巷道两路都匹配不到货格时一次性告警并冻结（mismatch）。
   */
  private resolveShuttleTargetCell(
    model: ModelRuntimeEntry,
    snapshot: DeviceTelemetrySnapshot,
  ): { cell: ShuttleTargetCell | null; key: string | null; mismatch: boolean } {
    const x = readIntegerField(snapshot.fields, 'x');
    if (x === -1 || x === -2) {
      return this.resolveLayerChangePlatformCell(model, snapshot, x);
    }
    // 进出提升机的过渡帧：列号未知且层号为 0/缺失，按载货台过渡处理，避免用 to_y 目标层闪现
    const currentY = readIntegerField(snapshot.fields, 'y');
    if (x === SHUTTLE_COLUMN_UNKNOWN && (currentY === null || currentY < 1)) {
      const platform = this.host.findLayerChangePlatformLocator(
        snapshot.assetCode,
        this.resolveShuttleAisleCode(model),
      );
      if (platform) return this.resolveLayerChangePlatformCell(model, snapshot, -2);
    }

    const toX = readIntegerField(snapshot.fields, 'to_x');
    const toY = readIntegerField(snapshot.fields, 'to_y');
    const toZ = readIntegerField(snapshot.fields, 'to_z');
    const toDepth = readIntegerField(snapshot.fields, 'to_Depth');
    // 回到正常任务语义：出梯闩锁复位，下次进梯重新判定
    model.shuttleTelemetry.hcliftExitDoneKey = null;
    // 目标字段整体缺失：设备本帧未报目标（心跳/诊断帧），不告警
    if (toX === null && toY === null && toZ === null && toDepth === null) {
      return { cell: null, key: null, mismatch: false };
    }
    // 列/层/排全 0：无目标或任务完结
    if (toX === 0 && toY === 0 && toZ === 0) return { cell: null, key: null, mismatch: false };

    const storageDepth = decodeShuttleStorageDepth(toDepth);
    if (toX === null || toY === null || toZ === null || storageDepth === null) {
      this.reportShuttleTargetFieldError(snapshot, toX, toY, toZ, toDepth, storageDepth);
      return { cell: null, key: null, mismatch: true };
    }

    // 目标层 ≠ 当前上报层（y）：任务需先换层，PLC 随后会走 x=-1/-2 流程，本帧按无目标处理，避免先闪到目标层再闪回
    const currentLayer = readIntegerField(snapshot.fields, 'y');
    if (currentLayer !== null && currentLayer >= 1 && toY >= 1 && currentLayer !== toY) {
      return { cell: null, key: null, mismatch: false };
    }

    const aisleCode = this.resolveShuttleAisleCode(model);
    const locator = this.host.findLocatorByDevice(snapshot.assetCode, toX, toY, toZ, storageDepth)
      ?? (aisleCode ? this.host.findLocatorByAisle(aisleCode, toX, toY, toZ, storageDepth) : null);
    if (!locator) {
      this.reportShuttleTargetCellMiss(model, snapshot, aisleCode, toX, toY, toZ, storageDepth);
      return { cell: null, key: null, mismatch: true };
    }
    const supportPosition = this.resolveLocatorBoxSupportPosition(locator, toX, toY);
    if (!supportPosition) return { cell: null, key: null, mismatch: true };
    // D0（无排深接驳位）不按排深过滤，货格键与动作语义使用命中的实际排深
    const resolvedDepth = storageDepth ?? locator.storageDepth;
    return {
      cell: { locator, supportPosition, toX, toY, row: toZ, storageDepth: resolvedDepth },
      key: JSON.stringify([toX, toY, toZ, resolvedDepth]),
      mismatch: false,
    };
  }

  /**
   * 目标字段非法的一次性报错：to_x/to_y/to_z 任一缺失，或 to_Depth 非 2/8（浅/深库位）。
   * 用于替代旧的「to_Depth 位编码排号」协议，字段不完整即冻结，不做降级猜测。
   */
  private reportShuttleTargetFieldError(
    snapshot: DeviceTelemetrySnapshot,
    toX: number | null,
    toY: number | null,
    toZ: number | null,
    toDepth: number | null,
    storageDepth: LocatorRuntimeEntry['storageDepth'] | undefined | null,
  ): void {
    const reasons: string[] = [];
    const missing = ([['to_x', toX], ['to_y', toY], ['to_z', toZ]] as const)
      .filter(([, value]) => value === null)
      .map(([name]) => name);
    if (missing.length > 0) reasons.push(`缺 ${missing.join('/')}`);
    if (storageDepth === null) {
      reasons.push(toDepth === null
        ? 'to_Depth 缺失（仅支持 0=无排深接驳位 / 2=浅库位 / 8=深库位）'
        : `to_Depth=${toDepth} 非法（仅支持 0=无排深接驳位 / 2=浅库位 / 8=深库位）`);
    }
    const reportKey = `${snapshot.sourceId}:${snapshot.deviceType}:${snapshot.assetCode}:target-field:${reasons.join('|')}`;
    if (this.state.reportedMissingTargets.has(reportKey)) return;
    this.state.reportedMissingTargets.add(reportKey);
    this.host.pushLog(`错误：多穿小车 ${snapshot.assetCode} 目标字段非法（${reasons.join('；')}），已冻结移动。`);
  }

  /**
   * x=-1（驶入站台等待提升）/ x=-2（换层中，Y 随 y 闪现）的站台货格解析：
   * 层优先取 y 字段；进出提升机过程中设备可能把 y 上报为 0（层未知），回退到 to_y 目标层。
   * 排固定站台排（rowNumber），列固定站台起始列。层号仍非法或未匹配到站台时一次性告警并冻结（mismatch）。
   */
  private resolveLayerChangePlatformCell(
    model: ModelRuntimeEntry,
    snapshot: DeviceTelemetrySnapshot,
    x: number,
  ): { cell: ShuttleTargetCell | null; key: string | null; mismatch: boolean } {
    const reportedY = readIntegerField(snapshot.fields, 'y');
    const fallbackY = readIntegerField(snapshot.fields, 'to_y');
    // 进/出提升机时 y 可能短暂为 0：优先保持最近有效层，避免按 to_y 目标层闪现
    // （典型：进梯途中 x=-1→x=-2 的 y=0 帧按 to_y 跳到目标层再回退）。
    const y = reportedY !== null && reportedY >= 1
      ? reportedY
      : model.shuttleTelemetry.lastHcliftLayer ?? fallbackY;
    if (reportedY !== null && reportedY >= 1) model.shuttleTelemetry.lastHcliftLayer = reportedY;
    if (y === null || y < 1) {
      const reportKey = `${snapshot.sourceId}:${snapshot.deviceType}:${snapshot.assetCode}:platform-layer:${reportedY ?? 'missing'}`;
      if (!this.state.reportedMissingTargets.has(reportKey)) {
        this.state.reportedMissingTargets.add(reportKey);
        this.host.pushLog(`错误：多穿小车 ${snapshot.assetCode} x=${x} 进入换层流程但 y=${reportedY ?? '缺失'} 非法（层号需 ≥1），已冻结移动。`);
      }
      return { cell: null, key: null, mismatch: true };
    }

    const aisleCode = this.resolveShuttleAisleCode(model);
    const locator = this.host.findLayerChangePlatformLocator(snapshot.assetCode, aisleCode);
    if (!locator) {
      const reportKey = `${snapshot.sourceId}:${snapshot.deviceType}:${snapshot.assetCode}:platform-missing`;
      if (!this.state.reportedMissingTargets.has(reportKey)) {
        this.state.reportedMissingTargets.add(reportKey);
        this.host.pushLog(`错误：多穿小车 ${snapshot.assetCode} x=${x} 请求换层站台，但未匹配到换层站台（设备绑定与巷道${aisleCode || '未配置'}均无站台货格），已冻结移动。`);
      }
      return { cell: null, key: null, mismatch: true };
    }

    const supportPosition = this.resolveLocatorBoxSupportPosition(locator, locator.startColumn, y);
    if (!supportPosition) return { cell: null, key: null, mismatch: true };
    // x=-2（进入/在提升机中）且存在同巷道/同站台绑定的小车提升机：水平目标改为载货台中心（真正驶入载台），
    // 支撑位 Y 跟随载货台实时台面高度（整车被托举升降）；x=-1（驶入站台等待）或无匹配提升机时维持原行为。
    const hclift = this.resolveHcliftPlatformSurface(locator);
    // 到层自动出梯：协议无出梯信号（x 直接由 -2 翻 -1）。占位 loaded 期间观察到提升机「未到位→到位」
    // （载车移动过的证据，排除驶入静止提升机误触发）后，目标切到目标层站台格，由驱动侧合成驶出动画。
    let exitToPlatform = false;
    let exitLevel: number | null = null;
    if (x === -2 && hclift) {
      const surface = hclift.surface;
      const shuttleState = model.shuttleTelemetry;
      exitLevel = surface.targetLevel !== null && surface.targetLevel >= 1 ? surface.targetLevel : null;
      const exitKey = exitLevel !== null ? `${hclift.key}:${exitLevel}` : null;
      const deckLoaded = this.isShuttleLoadedOnHcliftDeck(model, hclift.key);
      if (deckLoaded && !surface.arrived) shuttleState.hcliftLoadedSawMoving = true;
      if (exitKey !== null && shuttleState.hcliftExitDoneKey !== exitKey
        && surface.arrived && deckLoaded && shuttleState.hcliftLoadedSawMoving) {
        // 出梯触发：闩锁同轮不重复；层号立即切到目标层，后续 x=-1/-2 的 y=0 帧按目标层解析站台格
        shuttleState.hcliftExitDoneKey = exitKey;
        shuttleState.lastHcliftLayer = exitLevel;
      }
      if (exitKey !== null && shuttleState.hcliftExitDoneKey === exitKey && exitLevel !== null) {
        const exitSupport = this.resolveLocatorBoxSupportPosition(locator, locator.startColumn, exitLevel);
        if (exitSupport) {
          // 出梯（中/完成）：水平目标 = 目标层站台格中心，Y 仍贴台面实时高度（到层时与站台面同高）
          supportPosition.x = exitSupport.x;
          supportPosition.z = exitSupport.z;
          supportPosition.y = surface.supportY;
          exitToPlatform = true;
        }
      }
      if (!exitToPlatform) {
        supportPosition.x = surface.deckCenter.x;
        supportPosition.z = surface.deckCenter.z;
        supportPosition.y = surface.supportY;
      }
    }
    const cellY = exitToPlatform && exitLevel !== null ? exitLevel : y;
    const cell: ShuttleTargetCell = {
      locator,
      supportPosition,
      toX: locator.startColumn,
      toY: cellY,
      row: locator.rowNumber,
      storageDepth: locator.storageDepth,
      isLayerChangePlatform: true,
      ...(exitToPlatform ? { exitToPlatform: true } : {}),
      ...(hclift
        ? {
            hcliftKey: hclift.key,
            hcliftWorkState: hclift.surface.workState,
            hcliftDeckCenter: hclift.surface.deckCenter.clone(),
          }
        : {}),
      ...(x === -2 && hclift && !exitToPlatform ? { deckCenter: hclift.surface.deckCenter.clone() } : {}),
    };
    return { cell, key: JSON.stringify(['platform', cellY]), mismatch: false };
  }

  /**
   * 匹配本站台对应的小车提升机（hclift）载货台发布状态：巷道号相等优先，其次提升机 assetCode 命中站台
   * deviceAssetCode；失联（停止驱动超过阈值）的滞留值丢弃。无匹配返回 null（维持按层闪现/站台原位）。
   */
  private resolveHcliftPlatformSurface(
    locator: LocatorRuntimeEntry,
  ): { key: string; surface: HcliftPlatformSurfaceState } | null {
    const nowMs = Date.now();
    let byAssetCode: { key: string; surface: HcliftPlatformSurfaceState } | null = null;
    for (const [key, surface] of this.state.hcliftPlatformSurfaces) {
      if (nowMs - surface.updatedAtMs > HCLIFT_PLATFORM_SURFACE_STALE_MS) continue;
      if (surface.aisleCode && locator.aisleCode && surface.aisleCode === locator.aisleCode) {
        return { key, surface };
      }
      if (byAssetCode === null && locator.deviceAssetCode && surface.assetCode === locator.deviceAssetCode) {
        byAssetCode = { key, surface };
      }
    }
    return byAssetCode;
  }

  /** 本车是否已停稳在指定 hclift 载货台上（占位 phase=loaded 且未失联）。 */
  private isShuttleLoadedOnHcliftDeck(model: ModelRuntimeEntry, hcliftKey: string): boolean {
    const occupancy = this.state.hcliftDeckOccupancies.get(hcliftKey);
    if (!occupancy || occupancy.shuttleAssetCode !== model.assetCode) return false;
    if (Date.now() - occupancy.updatedAtMs > HCLIFT_DECK_OCCUPANCY_STALE_MS) return false;
    return occupancy.phase === 'loaded';
  }

  /**
   * 同步本车在 hclift 载货台上的占位：x=-1/-2 且匹配到提升机时每帧刷新；
   * x=-2 且已抵达载货台中心 → loaded，否则 entering；离开平台/目标失配时清除自己的占位。
   * 出梯（exitToPlatform，触发即释放）：车已驶离/正驶离载货台，不再占位，提升机保持冻结。
   * 占位时间戳取报文时间，断流后不再刷新，hclift 侧按过期阈值保持原地。
   */
  private syncHcliftDeckOccupancy(
    model: ModelRuntimeEntry,
    snapshot: DeviceTelemetrySnapshot,
    status: number | null,
    cell: ShuttleTargetCell | null,
  ): void {
    const state = model.shuttleTelemetry;
    const x = readIntegerField(snapshot.fields, 'x');
    const hcliftKey = cell?.hcliftKey ?? null;
    const onPlatform = x === -1 || x === -2
      || (x === SHUTTLE_COLUMN_UNKNOWN && hcliftKey !== null && cell?.isLayerChangePlatform === true);
    if (!cell || !hcliftKey || !onPlatform || cell.exitToPlatform === true) {
      this.releaseShuttleDeckOccupancy(model);
      return;
    }
    if (state.hcliftOccupancyKey !== null && state.hcliftOccupancyKey !== hcliftKey) {
      this.releaseShuttleDeckOccupancy(model);
    }

    const existing = this.state.hcliftDeckOccupancies.get(hcliftKey);
    if (existing && existing.shuttleAssetCode !== model.assetCode
      && Date.now() - existing.updatedAtMs <= HCLIFT_DECK_OCCUPANCY_STALE_MS) {
      const reportKey = `${snapshot.sourceId}:${snapshot.deviceType}:${snapshot.assetCode}:deck-busy:${hcliftKey}`;
      if (!this.state.reportedMissingTargets.has(reportKey)) {
        this.state.reportedMissingTargets.add(reportKey);
        this.host.pushLog(`错误：多穿小车 ${snapshot.assetCode} 请求驶入提升机载货台，但该载货台已被小车 ${existing.shuttleAssetCode} 占用，已保持原位。`);
      }
      this.releaseShuttleDeckOccupancy(model);
      return;
    }

    // 新一轮上台：复位载车移动观察，出梯只对「上台后提升机确实动过」触发
    if (state.hcliftOccupancyKey !== hcliftKey) state.hcliftLoadedSawMoving = false;

    const travelAxis = getHorizontalModelAxis(model.root, 'z');
    const loaded = x === -2 && cell.deckCenter !== undefined
      && this.isShuttleTravelArrived(model, cell, travelAxis);
    this.state.hcliftDeckOccupancies.set(hcliftKey, {
      shuttleAssetCode: model.assetCode,
      aisleCode: this.resolveShuttleAisleCode(model),
      phase: loaded ? 'loaded' : 'entering',
      shuttleStatus: status,
      shuttleFaulted: snapshot.faulted,
      updatedAtMs: snapshot.receivedAt,
    });
    state.hcliftOccupancyKey = hcliftKey;
  }

  /** 清除本车占用的 hclift 载货台占位（只删除属于本车的记录）。 */
  private releaseShuttleDeckOccupancy(model: ModelRuntimeEntry): void {
    const state = model.shuttleTelemetry;
    const key = state.hcliftOccupancyKey;
    if (!key) return;
    const entry = this.state.hcliftDeckOccupancies.get(key);
    if (entry?.shuttleAssetCode === model.assetCode) this.state.hcliftDeckOccupancies.delete(key);
    state.hcliftOccupancyKey = null;
  }

  /** 目标位匹配失败的一次性报错：绑定设备与巷道均无货格 / 目标位（排+排深+列层）超出货格范围。 */
  private reportShuttleTargetCellMiss(
    model: ModelRuntimeEntry,
    snapshot: DeviceTelemetrySnapshot,
    aisleCode: string,
    toX: number,
    toY: number,
    row: number,
    storageDepth: LocatorRuntimeEntry['storageDepth'] | undefined,
  ): void {
    const deviceLocators = this.host.findLocatorsByDevice(snapshot.assetCode);
    const aisleLocators = aisleCode ? this.host.findLocatorsByAisle(aisleCode) : [];
    const boundLocators = deviceLocators.length > 0 ? deviceLocators : aisleLocators;
    const kind = boundLocators.length > 0 ? 'target-range' : 'target-cell';
    const depthLabel = storageDepth === undefined ? '无排深接驳位' : storageDepth === 'near' ? '浅库位' : '深库位';
    const target = `排${row} ${depthLabel} 列${toX} 层${toY}`;
    const reportKey = `${snapshot.sourceId}:${snapshot.deviceType}:${snapshot.assetCode}:${kind}:${row}:${storageDepth}:${toX}:${toY}`;
    if (this.state.reportedMissingTargets.has(reportKey)) return;
    this.state.reportedMissingTargets.add(reportKey);
    if (boundLocators.length === 0) {
      this.host.pushLog(`错误：多穿小车 ${snapshot.assetCode} 目标位（${target}）未匹配到任何已绑定货格（绑定设备 ${deviceLocators.length} 个，巷道${aisleCode || '未配置'} ${aisleLocators.length} 个），已冻结移动。`);
      return;
    }
    const ranges = boundLocators
      .map((entry) => `排${entry.rowNumber}${entry.storageDepth === 'near' ? '浅' : '深'}：列${entry.startColumn}-${entry.startColumn + entry.columns - 1} 层${entry.startLayer}-${entry.startLayer + entry.layers - 1}`)
      .join('；');
    this.host.pushLog(`错误：多穿小车 ${snapshot.assetCode} 目标位（${target}）超出已绑定货格范围（${ranges}），已冻结移动。`);
  }

  /** 解析目标格口的支撑位世界坐标：水平取 box 中心、高度取 box 底面，越界时返回 null 由调用方冻结。 */
  private resolveLocatorBoxSupportPosition(
    locator: LocatorRuntimeEntry,
    toX: number,
    toY: number,
  ): Vector3 | null {
    const boxIndex = resolveLocatorBoxIndex({
      startColumn: locator.startColumn,
      startLayer: locator.startLayer,
      columns: locator.columns,
      layers: locator.layers,
      columnReversed: locator.columnReversed,
      toX,
      toY,
    });
    const supportPosition = boxIndex === null ? null : resolveLocatorCellSupportWorldPosition(locator, boxIndex);
    if (!supportPosition) {
      const reportKey = `${locator.assetId}:${toX}:${toY}`;
      if (!this.state.reportedInvalidStackerBoxTargets.has(reportKey)) {
        this.state.reportedInvalidStackerBoxTargets.add(reportKey);
        this.host.pushLog(`错误：库位 ${locator.assetId} 不存在目标货格（列${toX} 层${toY}），已忽略移动指令。`);
      }
      return null;
    }

    return supportPosition;
  }

  // ===== 目标格跳变跟踪与 catch-up =====

  /**
   * 目标货格键跟踪：
   * - 首条有效目标：走行直接吸附到目标格，避免从原点缓慢追赶期间消息已经推进；
   * - 后续跳变：记录变化间隔（供自适应追赶速度估算），货叉已伸出或仍有货物滞留货格（未绑定）时进入 catch-up 并立即补齐动作语义。
   */
  private trackShuttleTargetCellChange(
    model: ModelRuntimeEntry,
    key: string | null,
    cell: ShuttleTargetCell | null,
    status: number,
  ): void {
    const state = model.shuttleTelemetry;
    if (key === null) return;

    const nowMs = performance.now();
    if (state.lastTargetCellKey === null) {
      state.lastTargetCellKey = key;
      state.lastTargetCellChangedAtMs = nowMs;
      if (cell) this.snapShuttleToCell(model, cell);
      return;
    }
    if (key === state.lastTargetCellKey) return;

    if (state.lastTargetCellChangedAtMs !== null) {
      state.targetCellChangeIntervalMs = nowMs - state.lastTargetCellChangedAtMs;
    }
    state.lastTargetCellChangedAtMs = nowMs;
    state.lastTargetCellKey = key;
    if (state.forkCatchUp) return;

    const forkDeployed = Math.abs(state.forkOffset) > 1e-3;
    // 已绑定货物随叉随行是正常搬运；仅滞留货格的未绑定货物才需在目标跳变时补齐取/放语义
    const midAction = state.cargoKey !== null && !state.cargoBoundToFork;
    if (!forkDeployed && !midAction) return;

    state.forkCatchUp = true;
    state.forkPhase = 'idle';
    // 目标格已跳变表示设备转场：本相位动作按当前 Status 立即完结，同相位不再重复触发
    state.statusActionDone = true;
    this.forceCompleteShuttleForkAction(model, status, cell);
  }

  /** 首帧吸附：走行一步到位对齐目标格（仍受轨道约束钳制），货叉保持原点。 */
  private snapShuttleToCell(model: ModelRuntimeEntry, cell: ShuttleTargetCell): void {
    const state = model.shuttleTelemetry;
    const travelAxis = getHorizontalModelAxis(model.root, 'z');
    state.rootPosition = this.resolveShuttleTravelTargetPosition(model, cell, travelAxis);
  }

  /**
   * 自适应追赶速度：按最近两次目标格变化间隔估算本期窗口（夹在 0.25s~2s），
   * 速度 = 剩余距离 ÷ 窗口剩余时间，不低于默认速度、不超过上限，保证推送再快也能在下次变化前到位。
   */
  private resolveShuttleCatchUpSpeed(
    model: ModelRuntimeEntry,
    distance: number,
    defaultSpeed: number,
  ): number {
    const state = model.shuttleTelemetry;
    if (distance <= 1e-6 || state.targetCellChangeIntervalMs === null || state.lastTargetCellChangedAtMs === null) {
      return defaultSpeed;
    }
    const windowMs = Math.min(
      Math.max(state.targetCellChangeIntervalMs, SHUTTLE_CATCH_UP_MIN_WINDOW_SECONDS * 1000),
      SHUTTLE_CATCH_UP_MAX_WINDOW_SECONDS * 1000,
    );
    const remainingSeconds = Math.max(0.05, (windowMs - (performance.now() - state.lastTargetCellChangedAtMs)) / 1000);
    return Math.min(
      SHUTTLE_MAX_CATCH_UP_SPEED_METERS_PER_SECOND,
      Math.max(defaultSpeed, distance / remainingSeconds),
    );
  }

  /** catch-up 进入时按当前 Status 补齐取/放语义：取货立即绑定并完成，卸货立即解绑落位并完成。 */
  private forceCompleteShuttleForkAction(
    model: ModelRuntimeEntry,
    status: number,
    cell: ShuttleTargetCell | null,
  ): void {
    if (!model.shuttleTelemetry.cargoKey) return;
    if (status === SHUTTLE_STATUS.taking) {
      this.bindShuttleCargo(model);
      this.completeShuttleFetch(model);
      return;
    }
    if (status === SHUTTLE_STATUS.unloading) {
      this.unbindShuttleCargo(model, cell?.locator ?? null, cell?.supportPosition ?? null);
      this.completeShuttlePlace(model, cell?.locator ?? null, cell?.supportPosition ?? null);
    }
  }

  /** catch-up 期间货叉按倍率速度收回原点，归零后退出 catch-up 放行走行。 */
  private applyShuttleForkCatchUpRetract(model: ModelRuntimeEntry, deltaSeconds: number): void {
    const state = model.shuttleTelemetry;
    const speed = this.readShuttleForkSpeed(model) * SHUTTLE_FORK_CATCH_UP_SPEED_MULTIPLIER;
    state.forkTargetOffset = 0;
    state.forkOffset = moveNumberTowards(state.forkOffset, 0, speed * deltaSeconds);
    if (Math.abs(state.forkOffset) < 1e-4) {
      state.forkOffset = 0;
      state.forkCatchUp = false;
      state.forkPhase = 'idle';
    }
  }

  // ===== 走行（仅 Status=5，Z 轴） =====

  /**
   * Status=5 且有目标格支撑位时沿走行轴向目标推进；换层站台目标在 x=-1（驶入站台）、
   * x=-2（驶入提升机载货台，存在 deckCenter 时）或到层出梯（exitToPlatform）不等 Status=5 即触发走行；其余状态车体停驻。
   * 返回本帧是否在移动及是否已对准目标格（伸叉前置条件）。
   */
  private applyShuttleTravelMotion(
    model: ModelRuntimeEntry,
    snapshot: DeviceTelemetrySnapshot,
    status: number,
    cell: ShuttleTargetCell | null,
    deltaSeconds: number,
  ): { moving: boolean; arrived: boolean } {
    const state = model.shuttleTelemetry;
    const travelAxis = getHorizontalModelAxis(model.root, 'z');
    state.rootPosition ??= state.rootBasePosition.clone();

    const x = readIntegerField(snapshot.fields, 'x');
    // 提升机失联/未发布载货台时保持在原位，避免退回站台目标（出梯中除外：目标已是站台格，继续驶出）
    if (cell?.isLayerChangePlatform && x === -2 && !cell.deckCenter && !cell.exitToPlatform) {
      return { moving: false, arrived: this.isShuttleTravelArrived(model, cell, travelAxis) };
    }
    const platformTravelTrigger = cell?.isLayerChangePlatform === true
      && (x === -1 || cell.exitToPlatform === true
        || ((x === -2 || x === SHUTTLE_COLUMN_UNKNOWN) && cell.deckCenter !== undefined));
    // 取/卸状态但尚未到位（典型：出梯后 PLC 立即报 Status=1 而车还在站台）时先补走行，到位后再伸叉
    const actionTravelTrigger = cell !== null && !cell.isLayerChangePlatform
      && (status === SHUTTLE_STATUS.taking || status === SHUTTLE_STATUS.unloading);
    if (snapshot.faulted || !cell
      || (status !== SHUTTLE_STATUS.moving && !platformTravelTrigger && !actionTravelTrigger)) {
      return { moving: false, arrived: this.isShuttleTravelArrived(model, cell, travelAxis) };
    }

    const rootTargetPosition = this.resolveShuttleTravelTargetPosition(model, cell, travelAxis);
    // 小车进出提升机由 hclift 工作状态门控：1（取小车中）才允许驶入载货台，3（卸小车中）才允许驶出。
    const workState = cell.hcliftWorkState;
    if (cell.isLayerChangePlatform && workState !== null && workState !== undefined) {
      const entryToDeck = cell.deckCenter !== undefined;
      if (entryToDeck && workState !== 1) {
        return { moving: false, arrived: this.isShuttleTravelArrived(model, cell, travelAxis) };
      }
      if (!entryToDeck && cell.hcliftDeckCenter) {
        const current = state.rootPosition ?? state.rootBasePosition;
        // 只在水平面上比较“车在载台侧还是站台侧”，Y 由台面跟随单独处理，避免层高差翻转判定。
        const deckDistance = Math.hypot(current.x - cell.hcliftDeckCenter.x, current.z - cell.hcliftDeckCenter.z);
        const stationDistance = Math.hypot(current.x - rootTargetPosition.x, current.z - rootTargetPosition.z);
        const onDeckSide = deckDistance < stationDistance;
        if (onDeckSide && workState !== 3) {
          return { moving: false, arrived: this.isShuttleTravelArrived(model, cell, travelAxis) };
        }
      }
    }
    const defaultSpeed = this.readShuttleInspectorSpeed(model, 'travelSpeed')
      ?? this.readShuttleDataDrivenNumber(model, ['motion', 'travel', 'speed'])
      ?? SHUTTLE_DEFAULT_TRAVEL_SPEED_METERS_PER_SECOND;
    const targetSpeed = this.resolveShuttleCatchUpSpeed(model, Vector3.Distance(state.rootPosition, rootTargetPosition), defaultSpeed);
    // 进出换层站台/提升机载货台限速，避免 2m/s 直接上台造成对位过冲与视觉过快。
    // 提升机载货台（x=-2 进梯 / 到层出梯）可由数据驱动绑定调速；换层站台（x=-1）固定常量。
    const onHcliftDeck = cell.deckCenter !== undefined || cell.exitToPlatform === true;
    const motionSpeed = cell.isLayerChangePlatform
      ? Math.min(targetSpeed, onHcliftDeck
        ? this.readShuttleDeckTravelSpeed(model)
        : SHUTTLE_PLATFORM_TRAVEL_SPEED_METERS_PER_SECOND)
      : targetSpeed;
    const previous = state.rootPosition;
    state.rootPosition = moveVectorTowards(
      state.rootPosition,
      rootTargetPosition,
      motionSpeed * deltaSeconds,
    );
    // 驶入提升机载货台时不受站台轨道约束（载货台在站台/轨道尽头之外），仅投影到走行轴
    state.rootPosition = cell.deckCenter
      ? projectPointOntoAxis(state.rootBasePosition, travelAxis, state.rootPosition)
      : this.constrainShuttleTravelPosition(model, state.rootPosition, travelAxis);
    const moving = Vector3.DistanceSquared(previous, state.rootPosition) > 1e-12;
    return { moving, arrived: !moving };
  }

  /** 车体是否已对准目标格（走行轴投影差在到位余量内）；无目标格时视为未到位。 */
  private isShuttleTravelArrived(model: ModelRuntimeEntry, cell: ShuttleTargetCell | null, travelAxis: Vector3): boolean {
    if (!cell) return false;
    const state = model.shuttleTelemetry;
    const rootTargetPosition = this.resolveShuttleTravelTargetPosition(model, cell, travelAxis);
    return Vector3.Distance(state.rootPosition ?? state.rootBasePosition, rootTargetPosition) <= SHUTTLE_TRAVEL_ARRIVE_TOLERANCE_METERS;
  }

  /**
   * 目标格支撑位换算出的走行虚拟目标位置：普通货格对齐叉收回位中心（受轨道约束钳制）；
   * 换层站台对齐车体包围盒底部中点，且朝轨道尽头一侧的车体端面不得越过站台轨道边界（尽力对齐、越界钳回）；
   * x=-2 驶入提升机载货台时以 deckCenter 为车体中心目标，跳过站台轨道尽头/固定轨道约束。
   */
  private resolveShuttleTravelTargetPosition(model: ModelRuntimeEntry, cell: ShuttleTargetCell, travelAxis: Vector3): Vector3 {
    const state = model.shuttleTelemetry;
    if (cell.isLayerChangePlatform) {
      const home = this.getShuttleTravelBodyHome(model, travelAxis);
      if (home) {
        const bodyAxisCenter = (home.axisMin + home.axisMax) / 2;
        if (cell.deckCenter) {
          const deckCoordinate = Vector3.Dot(cell.deckCenter, travelAxis);
          return projectPointOntoAxis(
            state.rootBasePosition,
            travelAxis,
            state.rootBasePosition.add(travelAxis.scale(deckCoordinate - bodyAxisCenter)),
          );
        }
        const cellCenterCoordinate = Vector3.Dot(cell.supportPosition, travelAxis);
        let targetCoordinate = cellCenterCoordinate;
        const trackEnd = cell.locator.platformTrackEndWorld;
        if (trackEnd) {
          const endCoordinate = Vector3.Dot(trackEnd, travelAxis);
          const halfLength = (home.axisMax - home.axisMin) / 2;
          const direction = Math.sign(endCoordinate - cellCenterCoordinate) || 1;
          const limit = endCoordinate - direction * halfLength;
          targetCoordinate = direction > 0
            ? Math.min(cellCenterCoordinate, limit)
            : Math.max(cellCenterCoordinate, limit);
        }
        return this.constrainShuttleTravelPosition(
          model,
          state.rootBasePosition.add(travelAxis.scale(targetCoordinate - bodyAxisCenter)),
          travelAxis,
        );
      }
    }
    const referenceCoordinate = this.getShuttleTravelReferenceCoordinate(model, travelAxis);
    const targetTravelOffset = Vector3.Dot(cell.supportPosition, travelAxis) - referenceCoordinate;
    return this.constrainShuttleTravelPosition(
      model,
      state.rootBasePosition.add(travelAxis.scale(targetTravelOffset)),
      travelAxis,
    );
  }

  /**
   * 走行对齐参考坐标：二段叉收回位中心在走行轴上的投影（叉心对准货格支撑位即到位）。
   * 参照点投影减去当前走行偏移还原原位，行走期间保持恒定；缓存于遥测状态。
   */
  private getShuttleTravelReferenceCoordinate(model: ModelRuntimeEntry, travelAxis: Vector3): number {
    const state = model.shuttleTelemetry;
    if (state.targetReferencePosition) return Vector3.Dot(state.targetReferencePosition, travelAxis);

    const bounds = getNodesWorldBounds(this.findShuttleForkStage2Nodes(model));
    let reference: Vector3;
    if (bounds) {
      // 首个普通目标可能出现在换层站台之后：节点已叠加平台走行偏移，需扣除后还原叉心原位
      const travelOffset = (state.rootPosition ?? state.rootBasePosition).subtract(state.rootBasePosition);
      reference = bounds.minimum.add(bounds.maximum).scale(0.5).subtract(travelOffset);
    } else {
      reference = state.rootBasePosition.clone();
    }
    state.targetReferencePosition = reference;
    return Vector3.Dot(reference, travelAxis);
  }

  /** 将走行虚拟位置限制在固定轨道范围内；未声明 fixedNodes（多穿无固定轨道）时仅投影到走行轴。 */
  private constrainShuttleTravelPosition(model: ModelRuntimeEntry, position: Vector3, travelAxis: Vector3): Vector3 {
    const state = model.shuttleTelemetry;
    const projectedPosition = projectPointOntoAxis(state.rootBasePosition, travelAxis, position);
    const constraint = this.getShuttleTravelConstraint(model, travelAxis);
    if (!constraint) return projectedPosition;

    const requestedDelta = Vector3.Dot(projectedPosition.subtract(state.rootBasePosition), constraint.axis);
    const minDelta = constraint.trackMin - constraint.movingMin;
    const maxDelta = constraint.trackMax - constraint.movingMax;
    const clampedDelta = minDelta <= maxDelta
      ? clampNumber(requestedDelta, minDelta, maxDelta)
      : (constraint.trackMin + constraint.trackMax - constraint.movingMin - constraint.movingMax) / 2;

    return state.rootBasePosition.add(constraint.axis.scale(clampedDelta));
  }

  /** 读取或创建轨道约束：仅当模型脚本 dataDriven.fixedNodes 声明轨道节点时建立，否则无约束。 */
  private getShuttleTravelConstraint(model: ModelRuntimeEntry, travelAxis: Vector3): RgvTravelConstraint | null {
    const state = model.shuttleTelemetry;
    if (state.travelConstraint && Vector3.Dot(state.travelConstraint.axis, travelAxis) > 0.999) {
      return state.travelConstraint;
    }

    const fixedBounds = getNodesProjectedBounds(this.findShuttleFixedNodes(model), travelAxis);
    const movingBounds = getNodesProjectedBounds(this.findShuttleTravelNodes(model), travelAxis);
    if (!fixedBounds || !movingBounds) return null;

    state.travelConstraint = {
      axis: travelAxis.clone(),
      trackMin: fixedBounds.min,
      trackMax: fixedBounds.max,
      movingMin: movingBounds.min,
      movingMax: movingBounds.max,
    };
    return state.travelConstraint;
  }

  // ===== Y 层闪现 =====

  /**
   * Y 层变换无动画：有目标格时每帧计算整车竖直闪现偏移。载货基准面（载货平面包围盒顶面，
   * 环抱式机构中货物底面所在高度）对齐目标格支撑位，换层站台/提升机载货台同口径（小车载货台面与提升机台面齐平）。
   * 不按车体包围盒底面定位——车体相应沉到台面以下。无目标格回零（回待机层高位）。
   */
  private resolveShuttleYFlashOffset(model: ModelRuntimeEntry, cell: ShuttleTargetCell | null): Vector3 {
    if (!cell) return Vector3.Zero();
    const upAxis = getModelAxis(model.root, 'y');
    const cargoBaseHomeY = this.getShuttleCargoBaseHomeY(model, upAxis);
    if (cargoBaseHomeY === null) return Vector3.Zero();
    return upAxis.scale(Vector3.Dot(cell.supportPosition, upAxis) - cargoBaseHomeY);
  }

  /** 载货基准面在无 Y 偏移时的世界高度：首个目标格帧缓存（此时节点尚未施加 Y 偏移，避免自污染）。 */
  private getShuttleCargoBaseHomeY(model: ModelRuntimeEntry, upAxis: Vector3): number | null {
    const state = model.shuttleTelemetry;
    if (state.cargoBaseHomeY !== null) return state.cargoBaseHomeY;
    const topY = this.getShuttleCargoBaseTopY(model, upAxis);
    if (topY === null) return null;
    state.cargoBaseHomeY = topY;
    // 车体原位量必须同帧缓存：之后再测会叠上已施加的 Y 闪现/走行偏移
    this.getShuttleTravelBodyHome(model, getHorizontalModelAxis(model.root, 'z'));
    return topY;
  }

  /** 行走车体贴（travelNodes）包围盒的无偏移原位量：中心与走行轴投影区间；换层站台水平对齐与轨道尽头钳制用。 */
  private getShuttleTravelBodyHome(
    model: ModelRuntimeEntry,
    travelAxis: Vector3,
  ): { center: Vector3; axisMin: number; axisMax: number } | null {
    const state = model.shuttleTelemetry;
    if (state.travelBodyHome) return state.travelBodyHome;
    const bounds = getNodesWorldBounds(this.findShuttleTravelNodes(model));
    if (!bounds) return null;
    const projected = projectWorldBoundsOntoAxis(bounds, travelAxis);
    state.travelBodyHome = {
      center: bounds.minimum.add(bounds.maximum).scale(0.5),
      axisMin: projected.min,
      axisMax: projected.max,
    };
    return state.travelBodyHome;
  }

  /** 载货基准面顶面高度：优先载货平面节点（cargoDeckNodes）包围盒顶面，未声明时回退二段叉顶面。 */
  private getShuttleCargoBaseTopY(model: ModelRuntimeEntry, upAxis: Vector3): number | null {
    const deckBounds = getNodesWorldBounds(this.findShuttleCargoDeckNodes(model));
    if (deckBounds) return projectWorldBoundsOntoAxis(deckBounds, upAxis).max;
    const forkBounds = getNodesWorldBounds(this.findShuttleForkStage2Nodes(model));
    return forkBounds ? projectWorldBoundsOntoAxis(forkBounds, upAxis).max : null;
  }

  // ===== 货叉（Status 相位状态机，两段比例联动） =====

  /**
   * Status=1/3 的取/卸相位状态机：车到位后自动伸叉（方向按货格几何判定），伸满执行绑定/解绑，
   * 随后自动收回，归零完结并置 statusActionDone（同相位不再重复）；其他状态（含 _finish/移动/待机/未知）
   * 或车体移动中强制收叉；故障时冻结货叉（急停由 applyToModel 整体冻结）。
   */
  private applyShuttleStatusPhase(
    model: ModelRuntimeEntry,
    snapshot: DeviceTelemetrySnapshot,
    status: number,
    task: string,
    containerCode: string,
    target: { cell: ShuttleTargetCell | null; mismatch: boolean },
    travel: { moving: boolean; arrived: boolean },
    deltaSeconds: number,
  ): void {
    const state = model.shuttleTelemetry;
    if (snapshot.faulted) return;
    const forkSpeed = this.readShuttleForkSpeed(model);

    if (status !== SHUTTLE_STATUS.taking && status !== SHUTTLE_STATUS.unloading) {
      this.retractShuttleForkToHome(model, forkSpeed, deltaSeconds);
      return;
    }
    if (state.statusActionDone) {
      this.retractShuttleForkToHome(model, forkSpeed, deltaSeconds);
      return;
    }
    // 目标位失配/缺失：冻结伸叉（滞留伸出由 Status 离开或目标恢复后的相位逻辑处理）
    if (target.mismatch || !target.cell) return;
    // 换层站台只承载整车等待/换层，不支持装卸货：一次性告警并保持收叉
    if (target.cell.isLayerChangePlatform) {
      const reportKey = `${snapshot.sourceId}:${snapshot.deviceType}:${snapshot.assetCode}:platform-fork:${status}`;
      if (!this.state.reportedMissingTargets.has(reportKey)) {
        this.state.reportedMissingTargets.add(reportKey);
        this.host.pushLog(`多穿小车 ${snapshot.assetCode} 当前目标为换层站台，站台不支持装卸货（Status=${status}），已忽略伸叉。`);
      }
      this.retractShuttleForkToHome(model, forkSpeed, deltaSeconds);
      return;
    }
    // 车未到位不伸叉：走行期间或尚未对准目标格时保持收叉
    if (travel.moving || !travel.arrived) {
      this.retractShuttleForkToHome(model, forkSpeed, deltaSeconds);
      return;
    }

    const cell = target.cell;
    if (state.forkPhase === 'idle') {
      if (status === SHUTTLE_STATUS.taking) {
        // 伸叉开始瞬间在目标格刷出/接管货物并接管该格口渲染；cargoKey 保证一次装货只刷一次
        if (!state.cargoKey) this.beginShuttleFetch(model, task, containerCode, cell);
      } else {
        this.prepareShuttlePlace(model, task, containerCode, cell);
      }
      state.forkPhase = 'extending';
    }

    if (state.forkPhase === 'extending') {
      const stroke = this.getShuttleForkStroke(model);
      const direction = this.resolveForkExtendDirection(model, cell) ?? 1;
      const targetOffset = this.resolveForkTargetOffset(model, direction, cell, stroke);
      state.forkTargetOffset = targetOffset;
      state.forkOffset = moveNumberTowards(state.forkOffset, targetOffset, forkSpeed * deltaSeconds);
      if (this.isShuttleForkFullyExtended(model)) {
        // 伸叉动画完结：取货绑定货物上叉，卸货解绑落入箱位
        if (status === SHUTTLE_STATUS.taking) this.bindShuttleCargo(model);
        else this.unbindShuttleCargo(model, cell.locator, cell.supportPosition);
        state.forkPhase = 'retracting';
        state.forkTargetOffset = 0;
      }
      return;
    }

    if (this.retractShuttleForkToHome(model, forkSpeed, deltaSeconds)) {
      state.statusActionDone = true;
      if (status === SHUTTLE_STATUS.taking) this.completeShuttleFetch(model);
      else this.completeShuttlePlace(model, cell.locator, cell.supportPosition);
    }
  }

  /** 货叉向原点收回，归零后相位归 idle；返回本帧是否已在原点。 */
  private retractShuttleForkToHome(model: ModelRuntimeEntry, speed: number, deltaSeconds: number): boolean {
    const state = model.shuttleTelemetry;
    state.forkTargetOffset = 0;
    state.forkOffset = moveNumberTowards(state.forkOffset, 0, speed * deltaSeconds);
    if (Math.abs(state.forkOffset) < 1e-4) {
      state.forkOffset = 0;
      state.forkPhase = 'idle';
      return true;
    }
    return false;
  }

  /**
   * 按货格几何求伸出方向：货格支撑位相对二段叉收回位中心在货叉轴上的投影符号。
   * 叉节点不可投影或货格正对叉中心（方向无意义）时返回 null，由调用方回退默认方向。
   */
  private resolveForkExtendDirection(
    model: ModelRuntimeEntry,
    cell: ShuttleTargetCell,
  ): number | null {
    const forkAxis = getModelAxis(model.root, 'x');
    const homeCenter = this.resolveForkCenterHomeCoordinate(model, forkAxis);
    if (homeCenter === null) return null;
    const diff = Vector3.Dot(cell.supportPosition, forkAxis) - homeCenter;
    if (!Number.isFinite(diff) || Math.abs(diff) < 1e-6) return null;
    return Math.sign(diff);
  }

  /** 二段叉中心在货叉完全收回（offset=0）时沿货叉轴的坐标；当前投影中点减去当前偏移还原原位。 */
  private resolveForkCenterHomeCoordinate(model: ModelRuntimeEntry, forkAxis: Vector3): number | null {
    const projected = getNodesProjectedBounds(this.findShuttleForkStage2Nodes(model), forkAxis);
    if (!projected) return null;
    return (projected.max + projected.min) / 2 - model.shuttleTelemetry.forkOffset;
  }

  /**
   * 按货格几何求二段叉目标行程（带方向符号）：叉中心对准货格中心即停，
   * 绑定时货物锚点（载货平面顶面中心）与货格支撑位重合，交接无跳变；
   * 行程不按货叉模型长度钳位，货格纵深超过叉长时允许悬空。无货格几何时回退全行程。
   */
  private resolveForkTargetOffset(
    model: ModelRuntimeEntry,
    direction: number,
    cell: ShuttleTargetCell,
    stroke: number,
  ): number {
    const forkAxis = getModelAxis(model.root, 'x');
    const centerHome = this.resolveForkCenterHomeCoordinate(model, forkAxis);
    if (centerHome === null) return direction * stroke;

    // needed 贴近 0 仅出现于货格正对叉中心的退化布局（真实货格恒在叉侧向），回退全行程保持旧语义
    const needed = direction * (Vector3.Dot(cell.supportPosition, forkAxis) - centerHome);
    if (!Number.isFinite(needed) || needed <= 0.001) return direction * stroke;
    return direction * needed;
  }

  /** 二段叉几何行程：叉节点沿货叉轴的实测长度，仅作货格几何不可用时的默认全行程回退，不再钳位；测不出节点时行程为 0（不伸叉）。 */
  private getShuttleForkStroke(model: ModelRuntimeEntry): number {
    const state = model.shuttleTelemetry;
    if (state.forkStroke !== null) return state.forkStroke;

    const forkAxis = getModelAxis(model.root, 'x');
    const projected = getNodesProjectedBounds(this.findShuttleForkStage2Nodes(model), forkAxis);
    state.forkStroke = projected ? Math.max(0, projected.max - projected.min) : 0;
    return state.forkStroke;
  }

  /** 货叉是否已伸出到目标行程（伸叉动画完结）；目标行程为零视为未在伸出，留 2cm 到位余量。 */
  private isShuttleForkFullyExtended(model: ModelRuntimeEntry): boolean {
    const state = model.shuttleTelemetry;
    if (Math.abs(state.forkTargetOffset) < 0.001) return false;
    return Math.abs(state.forkOffset) >= Math.abs(state.forkTargetOffset) - 0.02;
  }

  // ===== 货物状态机 =====

  /**
   * Status 相位离开边沿收尾：取货（1）/卸货（3）相位被中断或完结后 Status 跳变时兜底执行完成语义。
   * 只依赖离开动作状态的边沿，因此不要求收到 2/4/6 的 _finish 事件；
   * Status 变化同时复位 statusActionDone，允许新相位重新动作。
   */
  private completeShuttleCargoOnStatusExit(
    model: ModelRuntimeEntry,
    status: number,
    cell: ShuttleTargetCell | null,
  ): void {
    const state = model.shuttleTelemetry;
    if (state.lastStatus === null || status === state.lastStatus) return;
    state.statusActionDone = false;
    if (state.lastStatus === SHUTTLE_STATUS.taking) {
      this.completeShuttleFetch(model);
    } else if (state.lastStatus === SHUTTLE_STATUS.unloading) {
      this.completeShuttlePlace(model, cell?.locator ?? null, cell?.supportPosition ?? null);
    }
    if (status !== SHUTTLE_STATUS.taking && status !== SHUTTLE_STATUS.unloading) state.forkPhase = 'idle';
  }

  /** 装货初始化（伸叉开始瞬间触发）：在目标格支撑位创建货物并抑制该格口 fetch 渲染，货物暂留货格等待伸叉到位绑定。 */
  private beginShuttleFetch(
    model: ModelRuntimeEntry,
    task: string,
    containerCode: string,
    cell: ShuttleTargetCell,
  ): void {
    const state = model.shuttleTelemetry;
    // 旧货物（含 fetch 保留中的滞留项）先销毁，避免新任务复用到已交接的货物
    this.disposeShuttleCargoByKey(this.getShuttleCargoKey(model.assetCode));
    this.clearShuttleCargoState(model);

    this.getOrCreateShuttleCargo(model.assetCode);
    // 内置货格留存货物优先：按格口接管留在货架上的同一货物实例。
    const retained = takeRetainedSlotCargo(this.state, cell.locator.entityId, cell.toX, cell.toY);
    if (retained) {
      this.finalizeAdoptedShuttleCargo(model, task, containerCode, retained);
    } else {
      // 目标是 conveyor 站台（内置 1×1 货格）：无视 task 直接接管该 conveyor 的滞留持货；
      // 未命中（普通库位/对方无货）回退按 task 全局接管或自建。
      const platformAdopted = this.context.adoptConveyorPlatformCargo(cell.locator.entityId, model.assetCode);
      if (platformAdopted) {
        this.finalizeAdoptedShuttleCargo(model, task, containerCode, platformAdopted);
      } else {
        this.adoptOrCreateShuttleCargo(model, task, containerCode);
      }
    }
    // 抑制源格口 fetch 渲染（货物改由 shuttle 渲染）；装货不留存排号，fetch 单排同步不由装货完成触发
    this.host.suppressFetchCellForLocator(cell.locator, cell.toX, cell.toY);
    // 接管留存货物后解除该格的持久抑制：瞬态抑制已就位，不会闪出旧 fetch 记录
    if (retained) this.host.releaseRetainedFetchCellForLocator?.(cell.locator, cell.toX, cell.toY);
    const holdPose = getNodeWorldPosePreservingMirror(cell.locator.root);
    // 接管货保持来货世界朝向（交接只平移）；fresh 刷出取货物模板自身朝向（世界恒等），不继承货格/机体旋转
    const holdRotation = this.state.shuttleCargoMeshes.get(this.getShuttleCargoKey(model.assetCode))?.lockedWorldRotation
      ?? createCargoSpawnWorldRotation();
    state.cargoKey = this.getShuttleCargoKey(model.assetCode);
    state.cargoHoldPosition = cell.supportPosition;
    state.cargoHoldRotation = holdRotation;
    state.cargoHoldScaling = holdPose.scaling;
  }

  /** 卸货相位入口：未经历装货直接卸货（如开机即卸货）时叉上补建货物并绑定叉尖；锁定目标排号（卸货完成时目标字段可能已变化，排号必须提前留存）。 */
  private prepareShuttlePlace(
    model: ModelRuntimeEntry,
    task: string,
    containerCode: string,
    cell: ShuttleTargetCell,
  ): void {
    const state = model.shuttleTelemetry;
    if (!state.cargoKey) this.beginShuttlePlaceWithCargo(model, task, containerCode);
    // 入场即锁定目标格：放货完成或相位退出时目标字段可能已变化，留存归属必须用这里的格口。
    state.cargoPlaceTarget = {
      locator: cell.locator,
      column: cell.toX,
      layer: cell.toY,
      supportPosition: cell.supportPosition,
      retainCargo: cell.locator.retainCargo === true,
    };
    if (state.cargoFetchRow === null) {
      state.cargoFetchRow = this.host.suppressFetchCellForLocator(cell.locator, cell.toX, cell.toY)
        ?? this.host.resolveFetchDriveRowForLocator(cell.locator);
    }
  }

  /** 直接进入卸货流程时补建叉上货物：初始即绑定叉尖，等待伸叉到位后解绑落入目标箱位。 */
  private beginShuttlePlaceWithCargo(model: ModelRuntimeEntry, task: string, containerCode: string): void {
    this.disposeShuttleCargoByKey(this.getShuttleCargoKey(model.assetCode));
    this.clearShuttleCargoState(model);
    this.getOrCreateShuttleCargo(model.assetCode);
    this.adoptOrCreateShuttleCargo(model, task, containerCode);
    const state = model.shuttleTelemetry;
    state.cargoKey = this.getShuttleCargoKey(model.assetCode);
    state.cargoBoundToFork = true;
  }

  /** 伸叉结束，货物绑定到叉尖，之后随货叉一同运动；绑定瞬间锁定货物当前世界朝向（货叉托举不改变货物姿态）。 */
  private bindShuttleCargo(model: ModelRuntimeEntry): void {
    const state = model.shuttleTelemetry;
    if (!state.cargoKey || state.cargoBoundToFork) return;
    const carriedRotation = this.state.shuttleCargoMeshes.get(state.cargoKey)?.root.rotationQuaternion?.clone() ?? null;
    state.cargoBoundToFork = true;
    state.cargoHoldPosition = null;
    state.cargoHoldRotation = carriedRotation ?? state.cargoHoldRotation;
    state.cargoHoldScaling = null;
  }

  /**
   * 卸货伸叉结束，货物解绑并留在目标箱位支撑位，货叉随后空收。
   * 落货保持搬运朝向（货叉托举/放下均不改变货物姿态）：优先沿用绑定时锁定的朝向，
   * 其次取货物当前世界朝向，最后回退货格朝向；缩放不取货格镜像，避免与保留朝向错配。
   * 非 fetch 的 conveyor 站台目标在落货当场交接给 conveyor 继续流转；
   * 交接被拒（对方已有货等）保持原位，Status 相位退出走原销毁路径。
   */
  private unbindShuttleCargo(
    model: ModelRuntimeEntry,
    targetLocator: LocatorRuntimeEntry | null,
    targetPosition: Vector3 | null,
  ): void {
    const state = model.shuttleTelemetry;
    const cargoKey = state.cargoKey;
    if (!cargoKey || !targetLocator || !state.cargoBoundToFork) return;
    const holdPosition = targetPosition ?? this.getWarehouseLocatorSupportPosition(targetLocator);
    const holdPose = getNodeWorldPosePreservingMirror(targetLocator.root);
    const currentRotation = this.state.shuttleCargoMeshes.get(cargoKey)?.root.rotationQuaternion?.clone() ?? null;
    state.cargoBoundToFork = false;
    state.cargoHoldPosition = holdPosition;
    state.cargoHoldRotation = state.cargoHoldRotation ?? currentRotation ?? holdPose.rotation;
    state.cargoHoldScaling = null;

    const retainAtSlot = state.cargoPlaceTarget?.retainCargo === true;
    if (retainAtSlot) {
      // 留存格口：只落到目标支撑位，不再尝试 conveyor 站台交接（留存优先于平台接手）。
      const cargo = this.state.shuttleCargoMeshes.get(cargoKey);
      if (cargo) {
        const rotation = state.cargoHoldRotation ?? currentRotation ?? holdPose.rotation;
        this.host.setGeneratedCargoRootPose(cargo, holdPosition, rotation, null);
        cargo.handoff = null;
      }
    } else if (state.cargoFetchRow === null) {
      // 货物网格位姿落后叉状态一帧：交接前对齐到持货位，
      // 否则 conveyor 交接插值以滞后位姿起步，卸货后多出一段本不存在的滑行动画
      const cargo = this.state.shuttleCargoMeshes.get(cargoKey);
      if (cargo) {
        const rotation = state.cargoHoldRotation ?? currentRotation ?? holdPose.rotation;
        this.host.setGeneratedCargoRootPose(cargo, holdPosition, rotation, null);
      }
      this.context.placeShuttleCargoIntoConveyorPlatform(targetLocator.entityId, cargoKey);
    }
  }

  /** 装货完成：兜底绑定后货物随叉收回。 */
  private completeShuttleFetch(model: ModelRuntimeEntry): void {
    if (!model.shuttleTelemetry.cargoKey) return;
    this.bindShuttleCargo(model);
  }

  /**
   * 卸货完成：开启「留存货物」的内置货格把货物移入共享留存表，等待再次取货；
   * 其余 fetch 库位保留至单排同步响应后销毁，非 fetch 库位立即销毁；conveyor 站台交接在落货时已完成。
   */
  private completeShuttlePlace(
    model: ModelRuntimeEntry,
    targetLocator: LocatorRuntimeEntry | null,
    targetPosition: Vector3 | null,
  ): void {
    const state = model.shuttleTelemetry;
    const cargoKey = state.cargoKey;
    if (!cargoKey) return;
    this.unbindShuttleCargo(model, targetLocator, targetPosition);

    const placeTarget = state.cargoPlaceTarget;
    if (placeTarget?.retainCargo === true) {
      this.retainShuttleCargoAtSlot(model, cargoKey, placeTarget, targetPosition);
    } else if (this.host.keepCargoForFetchRowSync(state.cargoFetchRow, model.assetCode, cargoKey)) {
      this.host.handleFetchRowSync(state.cargoFetchRow as number);
    } else if (state.cargoFetchRow === null) {
      this.disposeShuttleCargoByKey(cargoKey);
    }
    this.clearShuttleCargoState(model);
  }

  /** 把货物留在目标格口：强制落到支撑位、移出本机货物表、登记共享留存表并持久抑制该格 fetch 渲染。 */
  private retainShuttleCargoAtSlot(
    model: ModelRuntimeEntry,
    cargoKey: string,
    placeTarget: SlotPlaceTarget,
    targetPosition: Vector3 | null,
  ): void {
    const state = model.shuttleTelemetry;
    const cargo = this.state.shuttleCargoMeshes.get(cargoKey);
    if (!cargo) return;
    const position = targetPosition ?? state.cargoHoldPosition ?? placeTarget.supportPosition;
    const rotation = state.cargoHoldRotation ?? cargo.root.rotationQuaternion ?? createCargoSpawnWorldRotation();
    if (position) this.host.setGeneratedCargoRootPose(cargo, position, rotation, state.cargoHoldScaling);
    // 留存货物保持静止，不保留跨设备交接插值，避免停止更新后冻结在半途。
    cargo.handoff = null;

    this.state.shuttleCargoMeshes.delete(cargoKey);
    const key = createRetainedSlotCargoKey(placeTarget.locator.entityId, placeTarget.column, placeTarget.layer);
    const existing = this.state.slotRetainedCargoMeshes.get(key);
    if (existing && existing.cargo !== cargo) this.context.disposeShuttleCargo(existing.cargo);
    this.state.slotRetainedCargoMeshes.set(key, {
      locatorEntityId: placeTarget.locator.entityId,
      column: placeTarget.column,
      layer: placeTarget.layer,
      rowNumber: state.cargoFetchRow,
      cargo,
    });
    if (state.cargoFetchRow !== null) {
      this.host.retainFetchCellForLocator?.(placeTarget.locator, placeTarget.column, placeTarget.layer);
      this.host.handleFetchRowSync(state.cargoFetchRow);
    }
  }

  /** 每帧刷新货物外观与位姿：绑定跟随二段叉尖，未绑定静止于箱位支撑位；朝向取锁定的世界朝向，未锁定（fresh 刷出）取货物模板自身朝向。 */
  private updateShuttleCargoPose(model: ModelRuntimeEntry, snapshot: DeviceTelemetrySnapshot, deltaSeconds: number): void {
    const state = model.shuttleTelemetry;
    if (!state.cargoKey) return;
    const cargo = this.state.shuttleCargoMeshes.get(state.cargoKey);
    if (!cargo) return;

    this.host.syncGeneratedCargoVisual(
      cargo, 'shuttle', snapshot, this.host.resolveCargoGeneratorForModel(model), model.entitySnapshot?.id ?? '',
    );
    const targetPosition = state.cargoBoundToFork || !state.cargoHoldPosition
      ? this.getShuttleForkCargoPosition(model)
      : state.cargoHoldPosition;
    const targetRotation = state.cargoHoldRotation ?? cargo.lockedWorldRotation ?? createCargoSpawnWorldRotation();
    // 跨设备接管的货物从原世界位姿插值接入本机锚点，目标位姿每帧动态追踪（如叉尖随叉移动）
    const pose = resolveCargoHandoffPose(cargo, targetPosition, targetRotation, deltaSeconds);
    this.host.setGeneratedCargoRootPose(cargo, pose.position, pose.rotation, state.cargoBoundToFork ? null : state.cargoHoldScaling);
  }

  /**
   * 环抱式载货：货物水平锚定二段叉几何中心（夹抱臂从前后两侧夹住货物），
   * 竖直底面贴合载货平面（cargoDeckNodes 包围盒顶面，未声明时回退二段叉顶面）。
   */
  private getShuttleForkCargoPosition(model: ModelRuntimeEntry): Vector3 {
    const bounds = getNodesWorldBounds(this.findShuttleForkStage2Nodes(model));
    if (!bounds) return model.root.getAbsolutePosition();

    const upAxis = getModelAxis(model.root, 'y');
    const center = bounds.minimum.add(bounds.maximum).scale(0.5);
    const baseTopY = this.getShuttleCargoBaseTopY(model, upAxis);
    const topOffset = (baseTopY ?? projectWorldBoundsOntoAxis(bounds, upAxis).max) - Vector3.Dot(center, upAxis);
    return center.add(upAxis.scale(topOffset));
  }

  /** 使用 locator 盒体底面作为支撑位回退：取 locator 首格底面高度，水平取 locator 原点。 */
  private getWarehouseLocatorSupportPosition(locator: LocatorRuntimeEntry): Vector3 {
    const supportPosition = resolveLocatorCellSupportWorldPosition(locator, 0);
    const position = locator.root.getAbsolutePosition();
    return new Vector3(position.x, supportPosition?.y ?? position.y, position.z);
  }

  // ===== 货物生命周期 =====

  /** 生成多穿小车运行时货物的唯一键：每台设备同时最多携带一箱。 */
  getShuttleCargoKey(assetCode: string): string {
    return JSON.stringify([assetCode]);
  }

  /** 创建或复用本机的多穿小车运行时货物。 */
  getOrCreateShuttleCargo(assetCode: string): ShuttleCargoRuntimeEntry {
    const key = this.getShuttleCargoKey(assetCode);
    const existing = this.state.shuttleCargoMeshes.get(key);
    if (existing) return existing;

    const root = new TransformNode(
      `shuttle_cargo_root_${sanitizeBabylonName(assetCode)}`,
      this.scene,
    );
    const entry: ShuttleCargoRuntimeEntry = {
      assetCode,
      containerCode: '',
      task: '',
      root,
      outputOwner: null,
      fallback: null,
      generatorEntityId: null,
      handoff: null,
      axialLengthCache: null,
      lockedWorldRotation: null,
    };
    this.state.shuttleCargoMeshes.set(key, entry);
    return entry;
  }

  /** 按键销毁多穿小车运行时货物，map 中不存在时幂等跳过。 */
  private disposeShuttleCargoByKey(key: string): void {
    const cargo = this.state.shuttleCargoMeshes.get(key);
    if (!cargo) return;
    this.context.disposeShuttleCargo(cargo);
    this.state.shuttleCargoMeshes.delete(key);
  }

  /** 其他设备凭同一 task 接管本货箱：清理引用该货箱的模型遥测引用后从表中取出（不销毁），实例交给接管方保持视觉连续。 */
  detachClaimedCargoByKey(key: string): ShuttleCargoRuntimeEntry | null {
    const cargo = this.state.shuttleCargoMeshes.get(key);
    if (!cargo) return null;
    for (const { model } of this.host.collectModels()) {
      if (model.shuttleTelemetry.cargoKey === key) this.clearShuttleCargoState(model);
    }
    this.state.shuttleCargoMeshes.delete(key);
    return cargo;
  }

  /**
   * 刷出货物时按 task 全局接管或自建：接管成功则以货箱当前世界位姿为起点进入交接插值，
   * 并销毁本侧刚建的占位条目（从未渲染）；无 task 匿名，不参与全局接管。
   */
  private adoptOrCreateShuttleCargo(model: ModelRuntimeEntry, task: string, containerCode: string): void {
    const cargoKey = this.getShuttleCargoKey(model.assetCode);
    const adopted = this.context.adoptGlobalCargoByTask(task, cargoKey);
    if (adopted) {
      this.finalizeAdoptedShuttleCargo(model, task, containerCode, adopted);
      return;
    }
    const cargo = this.state.shuttleCargoMeshes.get(cargoKey);
    if (!cargo) return;
    cargo.task = task;
    cargo.containerCode = containerCode;
  }

  /** 接管收尾：销毁本侧占位条目（从未渲染），货物身份换绑本机、记录交接插值起点并登记到本机货物键。 */
  private finalizeAdoptedShuttleCargo(
    model: ModelRuntimeEntry,
    task: string,
    containerCode: string,
    adopted: GeneratedCargoRuntimeEntry,
  ): void {
    const cargoKey = this.getShuttleCargoKey(model.assetCode);
    const placeholder = this.state.shuttleCargoMeshes.get(cargoKey);
    if (placeholder && placeholder !== adopted) this.disposeShuttleCargoByKey(cargoKey);
    adopted.assetCode = model.assetCode;
    adopted.task = task;
    adopted.containerCode = containerCode || adopted.containerCode;
    adopted.handoff = createCargoHandoffState(adopted);
    this.state.shuttleCargoMeshes.set(cargoKey, adopted);
  }

  /** 删除指定 Shuttle 实例生成的运行时货物，不污染场景文档。 */
  disposeShuttleCargoForAssetCode(assetCode: string): void {
    for (const [key, cargo] of this.state.shuttleCargoMeshes.entries()) {
      if (cargo.assetCode !== assetCode) continue;
      this.context.disposeShuttleCargo(cargo);
      this.state.shuttleCargoMeshes.delete(key);
    }
  }

  /** 清空本机的全部货物状态，保留 lastStatus 边沿检测基线。 */
  private clearShuttleCargoState(model: ModelRuntimeEntry): void {
    const state = model.shuttleTelemetry;
    state.cargoKey = null;
    state.cargoBoundToFork = false;
    state.cargoHoldPosition = null;
    state.cargoHoldRotation = null;
    state.cargoHoldScaling = null;
    state.cargoFetchRow = null;
    state.cargoPlaceTarget = null;
  }

  // ===== 节点偏移写回 =====

  /** 将走行（含 Y 闪现）和两段货叉伸缩合成为每个节点的一次性世界偏移，避免重叠节点被后续动作覆盖。 */
  private applyShuttleNodeMotionOffsets(model: ModelRuntimeEntry, yFlashOffset: Vector3): void {
    const state = model.shuttleTelemetry;
    const travelWorldOffset = (state.rootPosition ?? state.rootBasePosition)
      .subtract(state.rootBasePosition)
      .add(yFlashOffset);
    const offsets = new Map<TransformNode, Vector3>();

    this.addShuttleWorldOffset(offsets, filterTopLevelMotionNodes(this.findShuttleTravelNodes(model)), travelWorldOffset);
    this.addShuttleForkMotionOffsets(model, offsets);
    this.offsetNodesFromBaselineByWorldOffsets(model, offsets);
  }

  /**
   * 两段货叉比例联动：二段偏移 = forkOffset，一段 = forkOffset / 2（同步启动、同步到位，二段速度两倍）。
   * 按期望世界偏移逐节点写回，并用最近货叉祖先的期望偏移补偿嵌套层级，一段/二段互为父子时不双倍计位移。
   */
  private addShuttleForkMotionOffsets(model: ModelRuntimeEntry, offsets: Map<TransformNode, Vector3>): void {
    const forkOffset = model.shuttleTelemetry.forkOffset;
    const forkAxis = getModelAxis(model.root, 'x');
    const desired = new Map<TransformNode, number>();
    for (const node of this.findShuttleForkStage1Nodes(model)) desired.set(node, forkOffset / 2);
    for (const node of this.findShuttleForkStage2Nodes(model)) desired.set(node, forkOffset);

    for (const [node, nodeDesired] of desired) {
      let inherited = 0;
      let ancestor = node.parent;
      while (ancestor) {
        const ancestorDesired = desired.get(ancestor as TransformNode);
        if (ancestorDesired !== undefined) {
          inherited = ancestorDesired;
          break;
        }
        ancestor = ancestor.parent;
      }
      this.addShuttleWorldOffset(offsets, [node], forkAxis.scale(nodeDesired - inherited));
    }
  }

  /** 查找随车行走的车体节点：全部模型节点剔除固定轨道节点及其祖先/子孙；未声明 fixedNodes 时整车参与行走。 */
  private findShuttleTravelNodes(model: ModelRuntimeEntry): TransformNode[] {
    const fixedNodes = this.findShuttleFixedNodes(model);
    if (fixedNodes.length === 0) {
      return getModelTransformNodes(model, this.scene).filter((node) => node !== model.root && node !== model.contentRoot);
    }
    const fixedSet = new Set(fixedNodes);
    return getModelTransformNodes(model, this.scene).filter((node) => {
      if (node === model.root || node === model.contentRoot) return false;
      if (fixedSet.has(node)) return false;
      return !fixedNodes.some((fixed) => node.isDescendantOf(fixed) || fixed.isDescendantOf(node));
    });
  }

  /** 查找固定轨道节点：仅认模型脚本 dataDriven.fixedNodes 声明（多穿无固定轨道时不做名称兜底猜测）。 */
  private findShuttleFixedNodes(model: ModelRuntimeEntry): TransformNode[] {
    const configuredNames = this.readShuttleFixedNodeNames(model);
    return configuredNames.length > 0 ? findModelNodesByName(model, this.scene, configuredNames) : [];
  }

  /** 查找二段货叉节点（载货段）：优先模型脚本 dataDriven.motion.fork.stage2Nodes 声明，缺失时按其 fallbackPattern 回退，再退硬编码正则。 */
  private findShuttleForkStage2Nodes(model: ModelRuntimeEntry): TransformNode[] {
    const configuredNames = this.readShuttleMotionNodeNames(model, 'fork', 'stage2Nodes');
    const configuredNodes = configuredNames.length > 0 ? findModelNodesByName(model, this.scene, configuredNames) : [];
    if (configuredNodes.length > 0) return configuredNodes;
    return findModelNodes(model, this.scene, this.readShuttleMotionFallbackPattern(model, 'fork', /fork|叉|huocha|cha\d*/i));
  }

  /** 查找载货平面节点（环抱机构收回后承载货物底面的台面板件）：仅认模型脚本 dataDriven.motion.cargoDeckNodes 声明，未声明时回退二段叉顶面基准。 */
  private findShuttleCargoDeckNodes(model: ModelRuntimeEntry): TransformNode[] {
    for (const dataDriven of model.externalScriptRuntime?.getDataDrivenConfigs() ?? []) {
      const nodes = readStringArrayPath(dataDriven, ['motion', 'cargoDeckNodes']);
      if (nodes.length > 0) return findModelNodesByName(model, this.scene, nodes);
    }
    return [];
  }

  /** 查找一段货叉节点（半行程段）：仅认模型脚本 dataDriven.motion.fork.stage1Nodes 声明，未声明时无一段（退回单段叉）。 */
  private findShuttleForkStage1Nodes(model: ModelRuntimeEntry): TransformNode[] {
    const configuredNames = this.readShuttleMotionNodeNames(model, 'fork', 'stage1Nodes');
    return configuredNames.length > 0 ? findModelNodesByName(model, this.scene, configuredNames) : [];
  }

  /** 读取模型脚本 dataDriven.motion.<key>.<field> 中声明的节点名。 */
  private readShuttleMotionNodeNames(model: ModelRuntimeEntry, motionKey: string, field: string): string[] {
    for (const dataDriven of model.externalScriptRuntime?.getDataDrivenConfigs() ?? []) {
      const nodes = readStringArrayPath(dataDriven, ['motion', motionKey, field]);
      if (nodes.length > 0) return nodes;
    }
    return [];
  }

  /** 读取模型脚本声明的兜底节点正则；配置缺失或编译失败时回退硬编码正则。 */
  private readShuttleMotionFallbackPattern(model: ModelRuntimeEntry, motionKey: string, fallback: RegExp): RegExp {
    for (const dataDriven of model.externalScriptRuntime?.getDataDrivenConfigs() ?? []) {
      const motion = isPlainRecord(dataDriven) && isPlainRecord(dataDriven.motion) ? dataDriven.motion : {};
      const config = isPlainRecord(motion[motionKey]) ? motion[motionKey] : {};
      const patternText = typeof config.fallbackPattern === 'string' ? config.fallbackPattern.trim() : '';
      if (!patternText) continue;
      try {
        return new RegExp(patternText, 'i');
      } catch {
        return fallback;
      }
    }
    return fallback;
  }

  /** 读取模型脚本 dataDriven.fixedNodes 中声明的固定节点名。 */
  private readShuttleFixedNodeNames(model: ModelRuntimeEntry): string[] {
    for (const dataDriven of model.externalScriptRuntime?.getDataDrivenConfigs() ?? []) {
      const nodes = readStringArrayPath(dataDriven, ['fixedNodes']);
      if (nodes.length > 0) return nodes;
    }
    return [];
  }

  /** 累加一组节点的世界位移，后续统一转换到各自父级本地坐标。 */
  private addShuttleWorldOffset(offsets: Map<TransformNode, Vector3>, nodes: TransformNode[], worldOffset: Vector3): void {
    for (const node of nodes) {
      const existing = offsets.get(node) ?? Vector3.Zero();
      offsets.set(node, existing.add(worldOffset));
    }
  }

  /** 按世界位移写回节点位置，兼容模型内容根节点的单位缩放、旋转和父级层级。 */
  private offsetNodesFromBaselineByWorldOffsets(model: ModelRuntimeEntry, offsets: Map<TransformNode, Vector3>): void {
    for (const [node, worldOffset] of offsets) {
      const baseline = this.getShuttleNodeBaseline(model, node);
      const localOffset = worldDeltaToParentLocalDelta(node, worldOffset);
      node.position = baseline.add(localOffset);
    }
  }

  /** 记录遥测动作前的节点基线位置。 */
  private getShuttleNodeBaseline(model: ModelRuntimeEntry, node: TransformNode): Vector3 {
    const existing = model.shuttleTelemetry.nodeBaselines.get(node);
    if (existing) return existing;

    const baseline = node.position.clone();
    model.shuttleTelemetry.nodeBaselines.set(node, baseline);
    return baseline;
  }

  // ===== 速度读取 =====

  /** 读取 Inspector 模型参数中的速度配置（米/秒）；未设置或非正数时返回 null，由 dataDriven/常量兜底。 */
  private readShuttleInspectorSpeed(model: ModelRuntimeEntry, key: string): number | null {
    const value = model.entitySnapshot?.components.modelAsset?.parameterValues?.[key];
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
  }

  /** 货叉速度（二段速度，一段减半）：Inspector forkSpeed 优先，缺省回退 dataDriven.motion.fork.speed → 常量。 */
  private readShuttleForkSpeed(model: ModelRuntimeEntry): number {
    return this.readShuttleInspectorSpeed(model, 'forkSpeed')
      ?? this.readShuttleDataDrivenNumber(model, ['motion', 'fork', 'speed'])
      ?? SHUTTLE_DEFAULT_FORK_SPEED_METERS_PER_SECOND;
  }

  /** 驶入/驶出提升机载货台速度：数据驱动绑定覆盖优先，缺省回退平台限速常量。 */
  private readShuttleDeckTravelSpeed(model: ModelRuntimeEntry): number {
    return model.telemetryBinding?.shuttleDeckTravelSpeed ?? SHUTTLE_PLATFORM_TRAVEL_SPEED_METERS_PER_SECOND;
  }

  /** 读取模型脚本 dataDriven 配置中的数值字段。 */
  private readShuttleDataDrivenNumber(model: ModelRuntimeEntry, path: string[]): number | null {
    for (const dataDriven of model.externalScriptRuntime?.getDataDrivenConfigs() ?? []) {
      const value = this.readNumberPath(dataDriven, path);
      if (value !== null) return value;
    }
    return null;
  }

  /** 按路径读取数值配置，供模型脚本 dataDriven 扩展字段使用。 */
  private readNumberPath(source: unknown, path: string[]): number | null {
    let current: unknown = source;
    for (const key of path) {
      if (!isPlainRecord(current)) return null;
      current = current[key];
    }
    return typeof current === 'number' && Number.isFinite(current) ? current : null;
  }

  // ===== 诊断与 metadata =====

  /** 写入多穿小车遥测 metadata，供 Inspector 调试查看。 */
  private writeShuttleTelemetryMetadata(
    model: ModelRuntimeEntry,
    snapshot: DeviceTelemetrySnapshot,
    status: number | null,
    targetLocator: LocatorRuntimeEntry | null,
  ): void {
    const telemetryMetadata = {
      assetCode: snapshot.assetCode,
      payloadDeviceCode: snapshot.payloadDeviceCode,
      sourceTimestamp: snapshot.sourceTimestamp,
      receivedAt: snapshot.receivedAt,
      aisleCode: this.resolveShuttleAisleCode(model),
      status,
      targetFound: Boolean(targetLocator),
      faulted: snapshot.faulted,
      message: snapshot.message,
      fields: snapshot.fields,
      forkOffset: model.shuttleTelemetry.forkOffset,
      forkTargetOffset: model.shuttleTelemetry.forkTargetOffset,
      forkPhase: model.shuttleTelemetry.forkPhase,
      hcliftOccupancyKey: model.shuttleTelemetry.hcliftOccupancyKey,
      hcliftDeckPhase: model.shuttleTelemetry.hcliftOccupancyKey
        ? this.state.hcliftDeckOccupancies.get(model.shuttleTelemetry.hcliftOccupancyKey)?.phase ?? null
        : null,
    };

    model.root.metadata = {
      ...(model.root.metadata ?? {}),
      shuttleTelemetry: telemetryMetadata,
    };
    model.contentRoot.metadata = {
      ...(model.contentRoot.metadata ?? {}),
      shuttleTelemetry: telemetryMetadata,
    };
  }

  /** 对故障和 Status 变化做一次性 Console 提示，避免每帧刷屏。 */
  private reportShuttleRuntimeState(snapshot: DeviceTelemetrySnapshot, status: number | null): void {
    const deviceKey = `${snapshot.sourceId}:${snapshot.deviceType}:${snapshot.assetCode}`;
    const statusSignature = JSON.stringify([status, snapshot.message]);
    if (this.state.reportedStatuses.get(deviceKey) !== statusSignature) {
      this.state.reportedStatuses.set(deviceKey, statusSignature);
      this.host.pushLog(
        `多穿小车 ${snapshot.assetCode} 状态：${this.describeShuttleStatus(status)}${snapshot.message ? `，${snapshot.message}` : ''}`,
      );
    }

    const emergencyStop = status === SHUTTLE_STATUS.emergencyStop;
    if (!snapshot.faulted && !emergencyStop) {
      this.state.reportedFaults.delete(deviceKey);
      return;
    }

    const faultMessage = snapshot.faulted
      ? snapshot.message || `errorCode=${readIntegerField(snapshot.fields, 'errorCode') ?? 0}`
      : 'Status=10（急停触发）';
    if (this.state.reportedFaults.get(deviceKey) === faultMessage) return;

    this.state.reportedFaults.set(deviceKey, faultMessage);
    this.host.pushLog(`多穿小车 ${snapshot.assetCode} 故障/急停：${faultMessage}`);
  }

  /** Status 值的人类可读描述（新协议）。 */
  private describeShuttleStatus(status: number | null): string {
    if (status === null) return 'Status 未知';
    const label = SHUTTLE_STATUS_LABELS[status];
    return label ? `Status=${status}（${label}）` : `Status=${status}`;
  }
}

