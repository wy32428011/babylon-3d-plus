import type { Scene } from '@babylonjs/core';
import { TransformNode, Vector3 } from '@babylonjs/core';
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
  type GeneratedCargoRuntimeEntry,
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
  type SpecializedTelemetryDriverContext,
  type SpecializedTelemetryHost,
  type SpecializedTelemetrySharedState,
} from './types';

/** 遥测解析出的目标货格：to_x/to_y 列层 + to_Depth 位解码出的排号与支撑位世界坐标。 */
type ShuttleTargetCell = {
  locator: LocatorRuntimeEntry;
  supportPosition: Vector3;
  toX: number;
  toY: number;
  row: number;
};

/** to_Depth 位值 → 排号：1→排1，2→排2，4→排3，8→排4。 */
function decodeShuttleDepthRow(toDepth: number): number | null {
  if (toDepth === 1 || toDepth === 2 || toDepth === 4 || toDepth === 8) {
    return Math.log2(toDepth) + 1;
  }
  return null;
}

/** 走行到位判定余量（米）：Status=1/2 伸叉前要求车体已对准目标格。 */
const SHUTTLE_TRAVEL_ARRIVE_TOLERANCE_METERS = 0.02;

/**
 * 多穿小车遥测驱动：Status 单字段状态机（0 待机 / 1 装货 / 2 卸货 / 3 移动中）。
 * - 走行仅 Z 轴（Status=3 向目标格推进），Y 层变换无动画、每帧闪现对齐目标格层高（载货平面顶面与货格底面持平）；
 * - 目标货格由 to_x/to_y/to_Depth 指向当前阶段动作格，先按绑定设备匹配、再按绑定巷道（aisleCode）匹配；
 * - 两段货叉沿 X 比例联动：二段偏移 = forkOffset，一段 = forkOffset / 2，同步启动同步到位；
 * - Status=1 货从格到车（伸满绑定、收回完结），Status=2 货从车到格（伸满解绑落格、收回完结）。
 */
export class ShuttleTelemetryDriver {
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

    const yFlashOffset = this.resolveShuttleYFlashOffset(model, target.cell);

    if (state.forkCatchUp) {
      this.applyShuttleForkCatchUpRetract(model, deltaSeconds);
    } else if (status !== null) {
      const travel = this.applyShuttleTravelMotion(model, snapshot, status, target.cell, deltaSeconds);
      this.applyShuttleStatusPhase(model, snapshot, status, task, containerCode, target, travel, deltaSeconds);
    }
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
   * to_x/to_y/to_Depth 目标货格解析：三字段全部缺失或全为 0（无目标/任务完结）返回无目标；
   * to_Depth 位值非法、或绑定设备与绑定巷道两路都匹配不到货格时一次性告警并冻结（mismatch）。
   */
  private resolveShuttleTargetCell(
    model: ModelRuntimeEntry,
    snapshot: DeviceTelemetrySnapshot,
  ): { cell: ShuttleTargetCell | null; key: string | null; mismatch: boolean } {
    const toX = readIntegerField(snapshot.fields, 'to_x');
    const toY = readIntegerField(snapshot.fields, 'to_y');
    const toDepth = readIntegerField(snapshot.fields, 'to_Depth');
    if (toX === null || toY === null || toDepth === null) return { cell: null, key: null, mismatch: false };
    if (toX === 0 && toY === 0 && toDepth === 0) return { cell: null, key: null, mismatch: false };

    const row = decodeShuttleDepthRow(toDepth);
    if (row === null) {
      const reportKey = `${snapshot.sourceId}:${snapshot.deviceType}:${snapshot.assetCode}:depth:${toDepth}`;
      if (!this.state.reportedMissingTargets.has(reportKey)) {
        this.state.reportedMissingTargets.add(reportKey);
        this.host.pushLog(`错误：多穿小车 ${snapshot.assetCode} to_Depth=${toDepth} 非法（仅支持 1/2/4/8 对应排 1-4），已冻结移动。`);
      }
      return { cell: null, key: null, mismatch: true };
    }

    const aisleCode = this.resolveShuttleAisleCode(model);
    const locator = this.host.findLocatorByDevice(snapshot.assetCode, toX, toY, row)
      ?? (aisleCode ? this.host.findLocatorByAisle(aisleCode, toX, toY, row) : null);
    if (!locator) {
      this.reportShuttleTargetCellMiss(model, snapshot, aisleCode, toX, toY, row);
      return { cell: null, key: null, mismatch: true };
    }
    const supportPosition = this.resolveLocatorBoxSupportPosition(locator, toX, toY);
    if (!supportPosition) return { cell: null, key: null, mismatch: true };
    return { cell: { locator, supportPosition, toX, toY, row }, key: JSON.stringify([toX, toY, row]), mismatch: false };
  }

  /** 目标位匹配失败的一次性报错：绑定设备与巷道均无货格 / 目标位超出货格列层范围。 */
  private reportShuttleTargetCellMiss(
    model: ModelRuntimeEntry,
    snapshot: DeviceTelemetrySnapshot,
    aisleCode: string,
    toX: number,
    toY: number,
    row: number,
  ): void {
    const deviceLocators = this.host.findLocatorsByDevice(snapshot.assetCode);
    const aisleLocators = aisleCode ? this.host.findLocatorsByAisle(aisleCode) : [];
    const boundLocators = deviceLocators.length > 0 ? deviceLocators : aisleLocators;
    const kind = boundLocators.length > 0 ? 'target-range' : 'target-cell';
    const reportKey = `${snapshot.sourceId}:${snapshot.deviceType}:${snapshot.assetCode}:${kind}:${row}:${toX}:${toY}`;
    if (this.state.reportedMissingTargets.has(reportKey)) return;
    this.state.reportedMissingTargets.add(reportKey);
    if (boundLocators.length === 0) {
      this.host.pushLog(`错误：多穿小车 ${snapshot.assetCode} 目标位（排${row} 列${toX} 层${toY}）未匹配到任何已绑定货格（绑定设备 ${deviceLocators.length} 个，巷道${aisleCode || '未配置'} ${aisleLocators.length} 个），已冻结移动。`);
      return;
    }
    const ranges = boundLocators
      .map((entry) => `排${entry.rowNumber}：列${entry.startColumn}-${entry.startColumn + entry.columns - 1} 层${entry.startLayer}-${entry.startLayer + entry.layers - 1}`)
      .join('；');
    this.host.pushLog(`错误：多穿小车 ${snapshot.assetCode} 目标位（排${row} 列${toX} 层${toY}）超出已绑定货格范围（${ranges}），已冻结移动。`);
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
      if (cell) this.snapShuttleToCell(model, cell.supportPosition);
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
  private snapShuttleToCell(model: ModelRuntimeEntry, supportPosition: Vector3): void {
    const state = model.shuttleTelemetry;
    const travelAxis = getHorizontalModelAxis(model.root, 'z');
    const referenceCoordinate = this.getShuttleTravelReferenceCoordinate(model, travelAxis);
    const targetTravelOffset = Vector3.Dot(supportPosition, travelAxis) - referenceCoordinate;
    state.rootPosition = this.constrainShuttleTravelPosition(
      model,
      state.rootBasePosition.add(travelAxis.scale(targetTravelOffset)),
      travelAxis,
    );
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

  /** catch-up 进入时按当前 Status 补齐取/放语义：装货立即绑定并完成，卸货立即解绑落位并完成。 */
  private forceCompleteShuttleForkAction(
    model: ModelRuntimeEntry,
    status: number,
    cell: ShuttleTargetCell | null,
  ): void {
    if (!model.shuttleTelemetry.cargoKey) return;
    if (status === 1) {
      this.bindShuttleCargo(model);
      this.completeShuttleFetch(model);
      return;
    }
    if (status === 2) {
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

  // ===== 走行（仅 Status=3，Z 轴） =====

  /**
   * Status=3 且有目标格支撑位时沿走行轴向目标推进，其余状态车体停驻；
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

    if (snapshot.faulted || status !== 3 || !cell) {
      return { moving: false, arrived: this.isShuttleTravelArrived(model, cell, travelAxis) };
    }

    const rootTargetPosition = this.resolveShuttleTravelTargetPosition(model, cell, travelAxis);
    const defaultSpeed = this.readShuttleInspectorSpeed(model, 'travelSpeed')
      ?? this.readShuttleDataDrivenNumber(model, ['motion', 'travel', 'speed'])
      ?? SHUTTLE_DEFAULT_TRAVEL_SPEED_METERS_PER_SECOND;
    const targetSpeed = this.resolveShuttleCatchUpSpeed(model, Vector3.Distance(state.rootPosition, rootTargetPosition), defaultSpeed);
    const previous = state.rootPosition;
    state.rootPosition = moveVectorTowards(
      state.rootPosition,
      rootTargetPosition,
      targetSpeed * deltaSeconds,
    );
    state.rootPosition = this.constrainShuttleTravelPosition(model, state.rootPosition, travelAxis);
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

  /** 目标格支撑位换算出的走行虚拟目标位置：叉收回位中心对准货格支撑位即到位（受轨道约束钳制）。 */
  private resolveShuttleTravelTargetPosition(model: ModelRuntimeEntry, cell: ShuttleTargetCell, travelAxis: Vector3): Vector3 {
    const state = model.shuttleTelemetry;
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
    const reference = bounds
      ? bounds.minimum.add(bounds.maximum).scale(0.5)
      : state.rootBasePosition.clone();
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
   * Y 层变换无动画：有目标格时每帧计算整车竖直闪现偏移，使载货基准面（载货平面包围盒顶面，
   * 环抱式机构中货物底面所在高度）与货格底面（支撑位）持平；无目标格回零（回待机层高位）。
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
    return topY;
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
   * Status=1/2 的取/放相位状态机：车到位后自动伸叉（方向按货格几何判定），伸满执行绑定/解绑，
   * 随后自动收回，归零完结并置 statusActionDone（同相位不再重复）；Status=0/3 或车体移动中强制收叉；
   * 目标格失配时冻结货叉。
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

    if (status !== 1 && status !== 2) {
      this.retractShuttleForkToHome(model, forkSpeed, deltaSeconds);
      return;
    }
    if (state.statusActionDone) {
      this.retractShuttleForkToHome(model, forkSpeed, deltaSeconds);
      return;
    }
    // 目标位失配/缺失：冻结伸叉（滞留伸出由 Status 离开或目标恢复后的相位逻辑处理）
    if (target.mismatch || !target.cell) return;
    // 车未到位不伸叉：走行期间或尚未对准目标格时保持收叉
    if (travel.moving || !travel.arrived) {
      this.retractShuttleForkToHome(model, forkSpeed, deltaSeconds);
      return;
    }

    const cell = target.cell;
    if (state.forkPhase === 'idle') {
      if (status === 1) {
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
        // 伸叉动画完结：装货绑定货物上叉，卸货解绑落入箱位
        if (status === 1) this.bindShuttleCargo(model);
        else this.unbindShuttleCargo(model, cell.locator, cell.supportPosition);
        state.forkPhase = 'retracting';
        state.forkTargetOffset = 0;
      }
      return;
    }

    if (this.retractShuttleForkToHome(model, forkSpeed, deltaSeconds)) {
      state.statusActionDone = true;
      if (status === 1) this.completeShuttleFetch(model);
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
   * Status 相位离开边沿收尾：装货（1）/卸货（2）相位被中断或完结后 Status 跳变时兜底执行完成语义；
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
    if (state.lastStatus === 1) {
      this.completeShuttleFetch(model);
    } else if (state.lastStatus === 2) {
      this.completeShuttlePlace(model, cell?.locator ?? null, cell?.supportPosition ?? null);
    }
    if (status !== 1 && status !== 2) state.forkPhase = 'idle';
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
    // 目标是 conveyor 站台（内置 1×1 货格）：无视 task 直接接管该 conveyor 的滞留持货；
    // 未命中（普通库位/对方无货）回退按 task 全局接管或自建。
    const platformAdopted = this.context.adoptConveyorPlatformCargo(cell.locator.entityId, model.assetCode);
    if (platformAdopted) {
      this.finalizeAdoptedShuttleCargo(model, task, containerCode, platformAdopted);
    } else {
      this.adoptOrCreateShuttleCargo(model, task, containerCode);
    }
    // 抑制源格口 fetch 渲染（货物改由 shuttle 渲染）；装货不留存排号，fetch 单排同步不由装货完成触发
    this.host.suppressFetchCellForLocator(cell.locator, cell.toX, cell.toY);
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

    if (state.cargoFetchRow === null) {
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

  /** 卸货完成：fetch 库位保留货物至单排同步响应后销毁，其余立即销毁；conveyor 站台交接在落货时已完成。 */
  private completeShuttlePlace(
    model: ModelRuntimeEntry,
    targetLocator: LocatorRuntimeEntry | null,
    targetPosition: Vector3 | null,
  ): void {
    const state = model.shuttleTelemetry;
    const cargoKey = state.cargoKey;
    if (!cargoKey) return;
    this.unbindShuttleCargo(model, targetLocator, targetPosition);

    if (this.host.keepCargoForFetchRowSync(state.cargoFetchRow, model.assetCode, cargoKey)) {
      this.host.handleFetchRowSync(state.cargoFetchRow as number);
    } else if (state.cargoFetchRow === null) {
      this.disposeShuttleCargoByKey(cargoKey);
    }
    this.clearShuttleCargoState(model);
  }

  /** 每帧刷新货物外观与位姿：绑定跟随二段叉尖，未绑定静止于箱位支撑位；朝向取锁定的世界朝向，未锁定（fresh 刷出）取货物模板自身朝向。 */
  private updateShuttleCargoPose(model: ModelRuntimeEntry, snapshot: DeviceTelemetrySnapshot, deltaSeconds: number): void {
    const state = model.shuttleTelemetry;
    if (!state.cargoKey) return;
    const cargo = this.state.shuttleCargoMeshes.get(state.cargoKey);
    if (!cargo) return;

    this.host.syncGeneratedCargoVisual(cargo, 'shuttle', snapshot, this.host.resolveCargoGeneratorForModel(model));
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

    if (!snapshot.faulted) {
      this.state.reportedFaults.delete(deviceKey);
      return;
    }

    const faultMessage = snapshot.message || `errorCode=${readIntegerField(snapshot.fields, 'errorCode') ?? 0}`;
    if (this.state.reportedFaults.get(deviceKey) === faultMessage) return;

    this.state.reportedFaults.set(deviceKey, faultMessage);
    this.host.pushLog(`多穿小车 ${snapshot.assetCode} 故障/急停：${faultMessage}`);
  }

  /** Status 值的人类可读描述。 */
  private describeShuttleStatus(status: number | null): string {
    if (status === null) return 'Status 未知';
    const label = ['待机', '装货', '卸货', '移动中'][status];
    return label ? `Status=${status}（${label}）` : `Status=${status}`;
  }
}
