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
  getNodeWorldRotation,
  moveNumberTowards,
  moveVectorTowards,
  projectPointOntoAxis,
  projectWorldBoundsOntoAxis,
  worldDeltaToParentLocalDelta,
} from '../../runtimeNodeGeometry';
import { isPlainRecord, readStringArrayPath, sanitizeBabylonName } from '../../runtimeValueUtils';
import {
  readIntegerField,
  readNumberField,
  readStringField,
  type DeviceTelemetrySnapshot,
} from '../../../mqtt/deviceTelemetry';
import type { LocatorRuntimeEntry, ModelRuntimeEntry } from '../../SceneRuntime';
import { writeDeviceTelemetryMetadata } from './telemetryMetadata';
import {
  createCargoHandoffState,
  type GeneratedCargoRuntimeEntry,
  normalizeCargoTask,
  resolveCargoHandoffPose,
  type RgvTravelConstraint,
  type ShuttleCargoRuntimeEntry,
  type ShuttleForkSide,
  SHUTTLE_CATCH_UP_MAX_WINDOW_SECONDS,
  SHUTTLE_CATCH_UP_MIN_WINDOW_SECONDS,
  SHUTTLE_DEFAULT_FORK_SPEED_METERS_PER_SECOND,
  SHUTTLE_DEFAULT_TRAVEL_SPEED_METERS_PER_SECOND,
  SHUTTLE_FORK_CATCH_UP_SPEED_MULTIPLIER,
  SHUTTLE_MAX_CATCH_UP_SPEED_METERS_PER_SECOND,
  SHUTTLE_RPM_TO_METERS_PER_SECOND,
  type SpecializedTelemetryDriverContext,
  type SpecializedTelemetryHost,
  type SpecializedTelemetrySharedState,
} from './types';

/** 活动侧仲裁结果：front/back 字段仅作协议侧别，单套货叉共用节点，front 优先。 */
type ShuttleActiveSide = {
  side: ShuttleForkSide;
  command: number | null;
  movement: number | null;
  task: string;
  containerCode: string;
};

/**
 * 多穿小车遥测驱动：堆垛机的水平裁剪版——仅 Z 轴水平走行（无升降），单套货叉沿 X 轴伸缩；
 * 货格/站台按巷道编号（模型参数 aisleCode ↔ Locator 组件 aisleCode）+ 排 + 列层范围匹配；
 * front/back_command 仅作协议侧别，活动时仲裁（front 优先）；无 mode==4 signalBits 锁存。
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

  /** 对单台多穿小车应用走行、货叉伸缩和货物状态机的遥测驱动；移动目标优先取 to_x/to_y/to_z 目标货格，缺省回退 front_ 当前库位。 */
  applyToModel(model: ModelRuntimeEntry, snapshot: DeviceTelemetrySnapshot, deltaSeconds: number): void {
    const state = model.shuttleTelemetry;
    const frontCell = this.resolveShuttleCurrentCell(model, snapshot);
    this.reportShuttleRuntimeState(snapshot);
    writeDeviceTelemetryMetadata(model, snapshot);

    // to_x/to_y/to_z（WCS 目标货格）非全 0 且能匹配巷道货格时，以目标格支撑位为走行终点：任务下发即给出目的地，
    // 车体连续滑向目标，不等当前位 front_ 到位跳变再追赶；全 0/失配回退当前位驱动
    const toCell = this.resolveShuttleTargetCell(model, snapshot);
    const targetCell = toCell ?? frontCell.cell;
    const active = this.resolveActiveSide(snapshot);
    // command 相位离开边沿收尾须在 front_ 跳变跟踪之前：同帧「command 跳变 + 库位跳变」时先清滞留状态，避免 catch-up 误判
    this.completeShuttleCargoOnPhaseExit(model, active.command, frontCell.cell);
    // front_ 跟踪：首帧直接吸附到上报库位；后续跳变表示设备转场，快速收尾取/放动作并收叉，收回前冻结走行
    this.trackShuttleFrontCellChange(model, frontCell.key, frontCell.cell, targetCell, active.command);

    if (state.forkCatchUp) {
      this.applyShuttleForkCatchUpRetract(model, snapshot, active.side, deltaSeconds);
    } else {
      const travelMoving = this.applyShuttleTravelMotion(model, snapshot, targetCell?.supportPosition ?? null, deltaSeconds);
      this.applyShuttleForkMotion(model, snapshot, active, frontCell.cell, deltaSeconds, travelMoving, frontCell.mismatch);
    }
    this.applyShuttleNodeMotionOffsets(model);
    this.applyShuttleCargoMotion(model, snapshot, active, frontCell.cell?.locator ?? null, frontCell.cell?.supportPosition ?? null, deltaSeconds);
    this.writeShuttleTelemetryMetadata(model, snapshot, frontCell.cell?.locator ?? null);
  }

  // ===== 库位解析（巷道匹配） =====

  /** 读取小车绑定的巷道编号（模型参数 aisleCode）；空串表示未配置，不参与巷道匹配。 */
  private resolveShuttleAisleCode(model: ModelRuntimeEntry): string {
    const value = model.entitySnapshot?.components.modelAsset?.parameterValues?.['aisleCode'];
    return typeof value === 'string' ? value.trim() : '';
  }

  /**
   * 按 front_x/front_y/front_z 解析当前货格：三字段全部缺失或全为 0（设备回原点空闲姿态）视为未上报（保持原位）；
   * 任一非零即为真实坐标；有值但巷道匹配不到已绑定货格时一次性报错并冻结走行与伸叉（mismatch）。
   */
  private resolveShuttleCurrentCell(
    model: ModelRuntimeEntry,
    snapshot: DeviceTelemetrySnapshot,
  ): { cell: { locator: LocatorRuntimeEntry; supportPosition: Vector3 } | null; mismatch: boolean; key: string | null } {
    const frontX = readIntegerField(snapshot.fields, 'front_x');
    const frontY = readIntegerField(snapshot.fields, 'front_y');
    const frontZ = readIntegerField(snapshot.fields, 'front_z');
    if (frontX === null || frontY === null || frontZ === null) {
      return { cell: null, mismatch: false, key: null };
    }
    if (frontX === 0 && frontY === 0 && frontZ === 0) return { cell: null, mismatch: false, key: null };
    const key = JSON.stringify([frontX, frontY, frontZ]);
    const aisleCode = this.resolveShuttleAisleCode(model);
    const locator = aisleCode ? this.host.findLocatorByAisle(aisleCode, frontX, frontY, frontZ) : null;
    if (!locator) {
      this.reportShuttleFrontCellMiss(model, snapshot, aisleCode, frontX, frontY, frontZ);
      // 失配帧不占用库位键：恢复命中后仍能触发首帧吸附/跳变跟踪
      return { cell: null, mismatch: true, key: null };
    }
    const supportPosition = this.resolveLocatorBoxSupportPosition(locator, frontX, frontY);
    return supportPosition
      ? { cell: { locator, supportPosition }, mismatch: false, key }
      : { cell: null, mismatch: true, key: null };
  }

  /**
   * to_x/to_y/to_z 目标货格解析：三字段全部缺失或全为 0（无目标/任务完结）返回 null，调用方回退当前位驱动；
   * 非全 0 但巷道匹配不到已绑定货格时一次性告警并回退当前位驱动。
   */
  private resolveShuttleTargetCell(
    model: ModelRuntimeEntry,
    snapshot: DeviceTelemetrySnapshot,
  ): { locator: LocatorRuntimeEntry; supportPosition: Vector3 } | null {
    const toX = readIntegerField(snapshot.fields, 'to_x');
    const toY = readIntegerField(snapshot.fields, 'to_y');
    const toZ = readIntegerField(snapshot.fields, 'to_z');
    if (toX === null || toY === null || toZ === null) return null;
    if (toX === 0 && toY === 0 && toZ === 0) return null;
    const aisleCode = this.resolveShuttleAisleCode(model);
    const locator = aisleCode ? this.host.findLocatorByAisle(aisleCode, toX, toY, toZ) : null;
    if (!locator) {
      const reportKey = `${snapshot.sourceId}:${snapshot.deviceType}:${snapshot.assetCode}:to-cell:${toZ}:${toX}:${toY}`;
      if (!this.state.reportedMissingTargets.has(reportKey)) {
        this.state.reportedMissingTargets.add(reportKey);
        this.host.pushLog(`错误：多穿小车 ${snapshot.assetCode} 目标位（巷道${aisleCode || '未配置'} 排${toZ} 列${toX} 层${toY}）未匹配到任何已绑定货格，回退当前位驱动。`);
      }
      return null;
    }
    const supportPosition = this.resolveLocatorBoxSupportPosition(locator, toX, toY);
    return supportPosition ? { locator, supportPosition } : null;
  }

  /** 当前位匹配失败的一次性报错：未配置巷道 / 巷道无绑定货格 / 当前位超出货格列层范围。 */
  private reportShuttleFrontCellMiss(
    model: ModelRuntimeEntry,
    snapshot: DeviceTelemetrySnapshot,
    aisleCode: string,
    frontX: number,
    frontY: number,
    frontZ: number,
  ): void {
    const boundLocators = aisleCode ? this.host.findLocatorsByAisle(aisleCode) : [];
    const kind = !aisleCode ? 'front-cell-no-aisle' : boundLocators.length > 0 ? 'front-cell-range' : 'front-cell';
    const reportKey = `${snapshot.sourceId}:${snapshot.deviceType}:${snapshot.assetCode}:${kind}:${frontZ}:${frontX}:${frontY}`;
    if (this.state.reportedMissingTargets.has(reportKey)) return;
    this.state.reportedMissingTargets.add(reportKey);
    if (!aisleCode) {
      this.host.pushLog(`错误：多穿小车 ${snapshot.assetCode} 未配置巷道编号（模型参数 aisleCode），已忽略移动。`);
      return;
    }
    if (boundLocators.length === 0) {
      this.host.pushLog(`错误：多穿小车 ${snapshot.assetCode} 当前位（巷道${aisleCode} 排${frontZ} 列${frontX} 层${frontY}）未匹配到任何已绑定货格，已忽略移动。`);
      return;
    }
    const ranges = boundLocators
      .map((entry) => `排${entry.rowNumber}：列${entry.startColumn}-${entry.startColumn + entry.columns - 1} 层${entry.startLayer}-${entry.startLayer + entry.layers - 1}`)
      .join('；');
    this.host.pushLog(`错误：多穿小车 ${snapshot.assetCode} 当前位（巷道${aisleCode} 排${frontZ} 列${frontX} 层${frontY}）超出已绑定货格范围（${ranges}），已忽略移动。`);
  }

  /** 解析目标格口的支撑位世界坐标：水平取 box 中心、高度取 box 底面，越界时返回 null 由调用方回退。 */
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

  // ===== 活动侧仲裁 =====

  /** front/back command 活动侧仲裁（front 优先）：输出该侧 command/movement/task/containerCode；双侧空闲回退 front。 */
  private resolveActiveSide(snapshot: DeviceTelemetrySnapshot): ShuttleActiveSide {
    const frontCommand = readIntegerField(snapshot.fields, 'front_command');
    const backCommand = readIntegerField(snapshot.fields, 'back_command');
    const frontActive = frontCommand !== null && frontCommand !== 0;
    const backActive = backCommand !== null && backCommand !== 0;
    const side: ShuttleForkSide = frontActive ? 'front' : backActive ? 'back' : 'front';
    return {
      side,
      command: side === 'front' ? frontCommand : backCommand,
      movement: readIntegerField(snapshot.fields, side === 'front' ? 'front_movement_z' : 'back_movement_z'),
      task: normalizeCargoTask(readIntegerField(snapshot.fields, side === 'front' ? 'front_task' : 'back_task')),
      containerCode: readStringField(snapshot.fields, side === 'front' ? 'front_containerCode' : 'back_containerCode')?.trim() ?? '',
    };
  }

  // ===== 库位跳变跟踪与 catch-up =====

  /**
   * front_ 库位键跟踪：
   * - 首条有效库位：走行直接吸附到上报库位，避免从原点缓慢追赶期间消息已经推进；
   * - 后续跳变：记录变化间隔（供自适应追赶速度估算），货叉已伸出或仍有货物滞留货格（未绑定）时进入 catch-up 并立即补齐动作语义。
   */
  private trackShuttleFrontCellChange(
    model: ModelRuntimeEntry,
    key: string | null,
    cell: { locator: LocatorRuntimeEntry; supportPosition: Vector3 } | null,
    targetCell: { locator: LocatorRuntimeEntry; supportPosition: Vector3 } | null,
    command: number | null,
  ): void {
    const state = model.shuttleTelemetry;
    if (key === null) return;

    const nowMs = performance.now();
    if (state.lastFrontCellKey === null) {
      state.lastFrontCellKey = key;
      state.lastFrontCellChangedAtMs = nowMs;
      const snapTarget = cell ?? targetCell;
      if (snapTarget) this.snapShuttleToCell(model, snapTarget.supportPosition);
      return;
    }
    if (key === state.lastFrontCellKey) return;

    if (state.lastFrontCellChangedAtMs !== null) {
      state.frontCellChangeIntervalMs = nowMs - state.lastFrontCellChangedAtMs;
    }
    state.lastFrontCellChangedAtMs = nowMs;
    state.lastFrontCellKey = key;
    if (state.forkCatchUp) return;

    const forkDeployed = Math.abs(state.forkOffset) > 1e-3;
    // 已绑定货物随叉随行是正常搬运，库位连续更新（真实 WCS 行走期间持续上报）不算动作未完结；
    // 仅滞留货格的未绑定货物才需在转场跳变时补齐取/放语义
    const midAction = state.cargoKey !== null && !state.cargoBoundToFork;
    if (!forkDeployed && !midAction) return;

    state.forkCatchUp = true;
    this.forceCompleteShuttleForkAction(model, command, cell);
  }

  /** 首帧吸附：走行一步到位对齐上报库位（仍受轨道约束钳制），货叉保持原点。 */
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
   * 自适应追赶速度：按最近两次 front_ 变化间隔估算本期窗口（夹在 0.25s~2s），
   * 速度 = 剩余距离 ÷ 窗口剩余时间，不低于默认速度、不超过上限，保证推送再快也能在下次变化前到位。
   */
  private resolveShuttleCatchUpSpeed(
    model: ModelRuntimeEntry,
    distance: number,
    defaultSpeed: number,
  ): number {
    const state = model.shuttleTelemetry;
    if (distance <= 1e-6 || state.frontCellChangeIntervalMs === null || state.lastFrontCellChangedAtMs === null) {
      return defaultSpeed;
    }
    const windowMs = Math.min(
      Math.max(state.frontCellChangeIntervalMs, SHUTTLE_CATCH_UP_MIN_WINDOW_SECONDS * 1000),
      SHUTTLE_CATCH_UP_MAX_WINDOW_SECONDS * 1000,
    );
    const remainingSeconds = Math.max(0.05, (windowMs - (performance.now() - state.lastFrontCellChangedAtMs)) / 1000);
    return Math.min(
      SHUTTLE_MAX_CATCH_UP_SPEED_METERS_PER_SECOND,
      Math.max(defaultSpeed, distance / remainingSeconds),
    );
  }

  /** catch-up 进入时按当前 command 补齐取/放语义：取货立即绑定并完成，放货立即解绑落位并完成。 */
  private forceCompleteShuttleForkAction(
    model: ModelRuntimeEntry,
    command: number | null,
    cell: { locator: LocatorRuntimeEntry; supportPosition: Vector3 } | null,
  ): void {
    if (!model.shuttleTelemetry.cargoKey) return;
    if (command === 1 || command === 2) {
      this.bindShuttleCargo(model);
      this.completeShuttleFetch(model);
      return;
    }
    if (command === 3 || command === 4) {
      this.unbindShuttleCargo(model, cell?.locator ?? null, cell?.supportPosition ?? null);
      this.completeShuttlePlace(model, cell?.locator ?? null, cell?.supportPosition ?? null);
    }
  }

  /** catch-up 期间货叉按倍率速度收回原点，归零后退出 catch-up 放行走行。 */
  private applyShuttleForkCatchUpRetract(
    model: ModelRuntimeEntry,
    snapshot: DeviceTelemetrySnapshot,
    side: ShuttleForkSide,
    deltaSeconds: number,
  ): void {
    const state = model.shuttleTelemetry;
    const speed = this.readShuttleForkSpeed(model, snapshot, side) * SHUTTLE_FORK_CATCH_UP_SPEED_MULTIPLIER;
    state.forkTargetOffset = 0;
    state.forkOffset = moveNumberTowards(state.forkOffset, 0, speed * deltaSeconds);
    if (Math.abs(state.forkOffset) < 1e-4) {
      state.forkOffset = 0;
      state.forkCatchUp = false;
    }
  }

  // ===== 走行 =====

  /** 有目标库位支撑位时沿走行轴向目标推进，否则保持原位；返回本帧是否在移动。 */
  private applyShuttleTravelMotion(
    model: ModelRuntimeEntry,
    snapshot: DeviceTelemetrySnapshot,
    targetSupportPosition: Vector3 | null,
    deltaSeconds: number,
  ): boolean {
    const state = model.shuttleTelemetry;
    const travelAxis = getHorizontalModelAxis(model.root, 'z');
    state.rootPosition ??= state.rootBasePosition.clone();

    let moving = false;
    if (!snapshot.faulted && targetSupportPosition) {
      const referenceCoordinate = this.getShuttleTravelReferenceCoordinate(model, travelAxis);
      const targetTravelOffset = Vector3.Dot(targetSupportPosition, travelAxis) - referenceCoordinate;
      const rootTargetPosition = this.constrainShuttleTravelPosition(
        model,
        state.rootBasePosition.add(travelAxis.scale(targetTravelOffset)),
        travelAxis,
      );
      const defaultSpeed = this.readShuttleInspectorSpeed(model, 'travelSpeed')
        ?? this.readShuttleDataDrivenNumber(model, ['motion', 'travel', 'speed'])
        ?? SHUTTLE_DEFAULT_TRAVEL_SPEED_METERS_PER_SECOND;
      const rpmSpeed = this.readShuttleRpmSpeed(model, snapshot, 'rpm_x', defaultSpeed);
      const targetSpeed = this.resolveShuttleCatchUpSpeed(model, Vector3.Distance(state.rootPosition, rootTargetPosition), rpmSpeed);
      const previous = state.rootPosition;
      state.rootPosition = moveVectorTowards(
        state.rootPosition,
        rootTargetPosition,
        targetSpeed * deltaSeconds,
      );
      moving = Vector3.DistanceSquared(previous, state.rootPosition) > 1e-12;
    }

    state.rootPosition = this.constrainShuttleTravelPosition(model, state.rootPosition, travelAxis);
    return moving;
  }

  /**
   * 走行对齐参考坐标：货叉收回位中心在走行轴上的投影（叉心对准货格支撑位即到位）。
   * 参照点投影减去当前走行偏移还原原位，行走期间保持恒定；缓存于遥测状态。
   */
  private getShuttleTravelReferenceCoordinate(model: ModelRuntimeEntry, travelAxis: Vector3): number {
    const state = model.shuttleTelemetry;
    if (state.targetReferencePosition) return Vector3.Dot(state.targetReferencePosition, travelAxis);

    const bounds = getNodesWorldBounds(this.findShuttleForkNodes(model));
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

  // ===== 货叉 =====

  /** 根据活动侧 movement 驱动单套货叉伸缩；本体走行期间强制收回原点。 */
  private applyShuttleForkMotion(
    model: ModelRuntimeEntry,
    snapshot: DeviceTelemetrySnapshot,
    active: ShuttleActiveSide,
    cell: { locator: LocatorRuntimeEntry; supportPosition: Vector3 } | null,
    deltaSeconds: number,
    bodyMoving: boolean,
    extensionBlocked: boolean,
  ): void {
    // 当前位匹配失败时禁止伸叉（1/3 归一为静止），收回（2/4）始终可用
    const rawMovement = active.movement;
    const movement = extensionBlocked && (rawMovement === 1 || rawMovement === 3) ? null : rawMovement;
    const forkSpeed = this.readShuttleForkSpeed(model, snapshot, active.side);
    const state = model.shuttleTelemetry;

    // 走行与货叉伸出互斥：本体移动期间收叉并保持原点
    if (bodyMoving) {
      state.forkOffset = moveNumberTowards(state.forkOffset, 0, forkSpeed * deltaSeconds);
      return;
    }

    state.forkOffset = this.updateShuttleForkOffset(model, state.forkOffset, movement, forkSpeed, cell, snapshot.faulted, deltaSeconds);
  }

  /** 更新货叉偏移：movement 1/3 向目标行程伸出，2/4 收回原点，其余保持；目标行程由当前货格几何决定，超出叉长允许悬空。 */
  private updateShuttleForkOffset(
    model: ModelRuntimeEntry,
    currentOffset: number,
    movement: number | null,
    speed: number,
    cell: { locator: LocatorRuntimeEntry; supportPosition: Vector3 } | null,
    faulted: boolean,
    deltaSeconds: number,
  ): number {
    const state = model.shuttleTelemetry;
    const stroke = this.getShuttleForkStroke(model);
    if (faulted) return currentOffset;

    if (movement === 1 || movement === 3) {
      // 伸出方向由目标货格几何决定：1/3 不再区分左右编码；无货格或货格正对叉中心时回退编码语义
      const direction = this.resolveForkExtendDirection(model, cell) ?? (movement === 1 ? 1 : -1);
      const target = this.resolveForkTargetOffset(model, direction, cell, stroke);
      state.forkTargetOffset = target;
      return moveNumberTowards(currentOffset, target, speed * deltaSeconds);
    }

    if (movement === 2 || movement === 4) {
      state.forkTargetOffset = 0;
      return moveNumberTowards(currentOffset, 0, speed * deltaSeconds);
    }

    return currentOffset;
  }

  /**
   * 按货格几何求伸出方向：货格支撑位相对叉收回位中心在货叉轴上的投影符号。
   * 无货格、叉节点不可投影或货格正对叉中心（方向无意义）时返回 null，由调用方回退编码语义。
   */
  private resolveForkExtendDirection(
    model: ModelRuntimeEntry,
    cell: { locator: LocatorRuntimeEntry; supportPosition: Vector3 } | null,
  ): number | null {
    if (!cell) return null;
    const forkAxis = getModelAxis(model.root, 'x');
    const homeCenter = this.resolveForkCenterHomeCoordinate(model, forkAxis);
    if (homeCenter === null) return null;
    const diff = Vector3.Dot(cell.supportPosition, forkAxis) - homeCenter;
    if (!Number.isFinite(diff) || Math.abs(diff) < 1e-6) return null;
    return Math.sign(diff);
  }

  /** 叉中心在货叉完全收回（offset=0）时沿货叉轴的坐标；当前投影中点减去当前偏移还原原位。 */
  private resolveForkCenterHomeCoordinate(model: ModelRuntimeEntry, forkAxis: Vector3): number | null {
    const projected = getNodesProjectedBounds(this.findShuttleForkNodes(model), forkAxis);
    if (!projected) return null;
    return (projected.max + projected.min) / 2 - model.shuttleTelemetry.forkOffset;
  }

  /**
   * 按货格几何求货叉目标行程（带方向符号）：叉中心对准货格中心即停，
   * 绑定时货物锚点（叉顶面中心）与货格支撑位重合，交接无跳变；
   * 行程不按货叉模型长度钳位，货格纵深超过叉长时允许悬空。无货格时回退全行程。
   */
  private resolveForkTargetOffset(
    model: ModelRuntimeEntry,
    direction: number,
    cell: { locator: LocatorRuntimeEntry; supportPosition: Vector3 } | null,
    stroke: number,
  ): number {
    // 实测叉长只作无货格/方向不明时的全行程回退；有货格时目标由几何解算，不再受叉长限制
    if (!cell) return stroke > 0 ? direction * stroke : 0;

    const forkAxis = getModelAxis(model.root, 'x');
    const centerHome = this.resolveForkCenterHomeCoordinate(model, forkAxis);
    if (centerHome === null) return direction * stroke;

    // needed 贴近 0 仅出现于货格正对叉中心的退化布局（真实货格恒在叉侧向），回退全行程保持旧语义
    const needed = direction * (Vector3.Dot(cell.supportPosition, forkAxis) - centerHome);
    if (!Number.isFinite(needed) || needed <= 0.001) return direction * stroke;
    return direction * needed;
  }

  /** 货叉几何行程：叉节点沿货叉轴的实测长度，仅作无货格时的默认全行程回退，不再钳位；无节点时回退 dataDriven limits.max。 */
  private getShuttleForkStroke(model: ModelRuntimeEntry): number {
    const state = model.shuttleTelemetry;
    if (state.forkStroke !== null) return state.forkStroke;

    const forkAxis = getModelAxis(model.root, 'x');
    const projected = getNodesProjectedBounds(this.findShuttleForkNodes(model), forkAxis);
    const measured = projected ? Math.max(0, projected.max - projected.min) : 0;
    state.forkStroke = measured > 0
      ? measured
      : this.readShuttleDataDrivenNumber(model, ['motion', 'fork', 'limits', 'max']) ?? 0;
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
   * 单套货叉的货物状态机：command 决定取/放阶段；取货货物在伸叉开始瞬间于当前货格刷出，
   * 货叉伸出到位（伸叉动画完结）执行绑定/解绑；伸出窗口结束（收叉阶段）但叉未达计算行程时
   * 每帧按到达动作点幂等重试绑定/解绑，避免放货货物随叉带回。
   * command 语义：1 取货中 / 2 取货完成 / 3、4 放货中 / 5 放货完成；完成确认值（2/5）可能缺失，
   * 完成逻辑统一在离开对应 command 相位时执行（completeShuttleCargoOnPhaseExit）。
   */
  private applyShuttleCargoMotion(
    model: ModelRuntimeEntry,
    snapshot: DeviceTelemetrySnapshot,
    active: ShuttleActiveSide,
    targetLocator: LocatorRuntimeEntry | null,
    targetPosition: Vector3 | null,
    deltaSeconds: number,
  ): void {
    const state = model.shuttleTelemetry;
    const { command, movement } = active;

    if (!snapshot.faulted) {
      // 取货伸叉开始瞬间才在当前货格刷出货物并接管该格口渲染；command 1 本身不刷货，
      // 避免货物在设备仍在就位途中时提前出现。cargoKey 保证一次取货只刷一次。
      if (command === 1 && (movement === 1 || movement === 3) && targetLocator && !state.cargoKey) {
        this.beginShuttleFetch(model, snapshot, active, targetLocator, targetPosition);
      }
      // 放货阶段：未经历取货直接放货（如开机即放货）时叉上补建货物并绑定叉尖；
      // 补建仅限本相位尚未伸叉（伸出标记为空）：伸叉后落货交接会摘除 cargoKey，
      // 此时再补建会在叉上刷出第二个货物，与站台上的交接货物重叠；
      // 锁定目标排号：放货完成时当前位字段可能已变化，排号必须提前留存
      if ((command === 3 || command === 4) && targetLocator) {
        if (!state.cargoKey && state.lastMovementZ === null) {
          this.beginShuttlePlaceWithCargo(model, active);
        }
        if (state.cargoFetchRow === null) {
          const frontX = readIntegerField(snapshot.fields, 'front_x');
          const frontY = readIntegerField(snapshot.fields, 'front_y');
          state.cargoFetchRow = frontX !== null && frontY !== null
            ? this.host.suppressFetchCellForLocator(targetLocator, frontX, frontY)
            : this.host.resolveFetchDriveRowForLocator(targetLocator);
        }
      }
      // 伸叉动画完结（偏移到达目标行程）：取货阶段绑定货物上叉，放货阶段解绑落入箱位
      if (!state.forkCatchUp && this.isShuttleForkFullyExtended(model)) {
        if (command === 1 || command === 2) this.bindShuttleCargo(model);
        else if (command === 3 || command === 4) this.unbindShuttleCargo(model, targetLocator, targetPosition);
      }
      // 收叉阶段补齐：伸出窗口结束（伸 1/3 → 收 2/4）但叉未达计算行程时，上面的到位判定永不触发；
      // 收叉期间每帧按到达动作点重试绑定/解绑（两者幂等：已绑定/已解绑直接早退）；
      // 伸出标记只在伸出（1/3）时写入，收叉（2/4）与停止（0）帧均不覆盖，保证重试在整个收叉阶段有效
      const extendSeen = state.lastMovementZ === 1 || state.lastMovementZ === 3;
      const retracting = movement === 2 || movement === 4;
      if (!state.forkCatchUp && extendSeen && retracting) {
        if (command === 1 || command === 2) this.bindShuttleCargo(model);
        else if (command === 3 || command === 4) this.unbindShuttleCargo(model, targetLocator, targetPosition);
      }
    }

    this.updateShuttleCargoPose(model, snapshot, deltaSeconds);

    state.lastCommand = command;
    if (movement === 1 || movement === 3) state.lastMovementZ = movement;
    state.prevRawMovementZ = movement;
  }

  /** 取货初始化（伸叉开始瞬间触发）：在当前货格支撑位创建货物并抑制该格口 fetch 渲染，货物暂留货格等待伸叉到位绑定。 */
  private beginShuttleFetch(
    model: ModelRuntimeEntry,
    snapshot: DeviceTelemetrySnapshot,
    active: ShuttleActiveSide,
    targetLocator: LocatorRuntimeEntry,
    targetPosition: Vector3 | null,
  ): void {
    const state = model.shuttleTelemetry;
    // 旧货物（含 fetch 保留中的滞留项）先销毁，避免新任务复用到已交接的货物
    this.disposeShuttleCargoByKey(this.getShuttleCargoKey(model.assetCode));
    this.clearShuttleCargoState(model);

    this.getOrCreateShuttleCargo(model.assetCode);
    // 目标是 conveyor 站台（内置 1×1 货格）：无视 task 直接接管该 conveyor 的滞留持货；
    // 未命中（普通库位/对方无货）回退按 task 全局接管或自建。
    const platformAdopted = this.context.adoptConveyorPlatformCargo(targetLocator.entityId, model.assetCode);
    if (platformAdopted) {
      this.finalizeAdoptedShuttleCargo(model, active, platformAdopted);
    } else {
      this.adoptOrCreateShuttleCargo(model, active);
    }
    // 抑制源格口 fetch 渲染（货物改由 shuttle 渲染）；取货不留存排号，fetch 单排同步不由取货完成触发
    const frontX = readIntegerField(snapshot.fields, 'front_x');
    const frontY = readIntegerField(snapshot.fields, 'front_y');
    if (frontX !== null && frontY !== null) this.host.suppressFetchCellForLocator(targetLocator, frontX, frontY);
    const holdPosition = targetPosition ?? this.getWarehouseLocatorSupportPosition(targetLocator);
    const holdPose = getNodeWorldPosePreservingMirror(targetLocator.root);
    // 接管货保持来货世界朝向（交接只平移）；fresh 刷出取货格朝向
    const holdRotation = this.state.shuttleCargoMeshes.get(this.getShuttleCargoKey(model.assetCode))?.lockedWorldRotation
      ?? holdPose.rotation;
    state.cargoKey = this.getShuttleCargoKey(model.assetCode);
    state.cargoHoldPosition = holdPosition;
    state.cargoHoldRotation = holdRotation;
    state.cargoHoldScaling = holdPose.scaling;
  }

  /** 直接进入放货流程时补建叉上货物：初始即绑定叉尖，等待伸叉到位后解绑落入目标箱位。 */
  private beginShuttlePlaceWithCargo(model: ModelRuntimeEntry, active: ShuttleActiveSide): void {
    this.disposeShuttleCargoByKey(this.getShuttleCargoKey(model.assetCode));
    this.clearShuttleCargoState(model);
    this.getOrCreateShuttleCargo(model.assetCode);
    this.adoptOrCreateShuttleCargo(model, active);
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
   * 放货伸叉结束，货物解绑并留在目标箱位支撑位，货叉随后空收。
   * 落货保持搬运朝向（货叉托举/放下均不改变货物姿态）：优先沿用绑定时锁定的朝向，
   * 其次取货物当前世界朝向，最后回退货格朝向；缩放不取货格镜像，避免与保留朝向错配。
   * 非 fetch 的 conveyor 站台目标在落货当场交接给 conveyor 继续流转，不等 command 5；
   * 交接被拒（对方已有货等）保持原位，command 5 走原销毁路径。
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
      // 否则 conveyor 交接插值以滞后位姿起步，放货后多出一段本不存在的滑行动画
      const cargo = this.state.shuttleCargoMeshes.get(cargoKey);
      if (cargo) {
        const rotation = state.cargoHoldRotation ?? currentRotation ?? holdPose.rotation;
        this.host.setGeneratedCargoRootPose(cargo, holdPosition, rotation, null);
      }
      this.context.placeShuttleCargoIntoConveyorPlatform(targetLocator.entityId, cargoKey);
    }
  }

  /**
   * command 相位离开边沿收尾：取/放完成确认值（2/5）可能缺失，统一在离开取货（1）/放货（3、4）
   * 相位时执行原确认值逻辑；不受 faulted 门控：纯状态簿记，且故障恰好跨越跳变时仍要收尾，避免货物状态滞留。
   */
  private completeShuttleCargoOnPhaseExit(
    model: ModelRuntimeEntry,
    command: number | null,
    cell: { locator: LocatorRuntimeEntry; supportPosition: Vector3 } | null,
  ): void {
    const state = model.shuttleTelemetry;
    if (state.lastCommand === 1 && command !== 1) {
      this.completeShuttleFetch(model);
      // 相位结束清零伸出标记，避免上一任务的伸出记录串到下一任务的收叉补齐
      state.lastMovementZ = null;
      return;
    }
    if ((state.lastCommand === 3 || state.lastCommand === 4) && command !== 3 && command !== 4) {
      this.completeShuttlePlace(model, cell?.locator ?? null, cell?.supportPosition ?? null);
      state.lastMovementZ = null;
    }
  }

  /** 取货完成：兜底绑定后交还源库位；fetch 单排同步不在此触发。 */
  private completeShuttleFetch(model: ModelRuntimeEntry): void {
    if (!model.shuttleTelemetry.cargoKey) return;
    this.bindShuttleCargo(model);
  }

  /** 放货完成：fetch 库位保留货物至单排同步响应后销毁，其余立即销毁；conveyor 站台交接在落货时已完成。 */
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

  /** 每帧刷新货物外观与位姿：绑定跟随叉尖，未绑定静止于箱位支撑位；朝向取锁定的世界朝向，缺省回退机体朝向。 */
  private updateShuttleCargoPose(model: ModelRuntimeEntry, snapshot: DeviceTelemetrySnapshot, deltaSeconds: number): void {
    const state = model.shuttleTelemetry;
    if (!state.cargoKey) return;
    const cargo = this.state.shuttleCargoMeshes.get(state.cargoKey);
    if (!cargo) return;

    this.host.syncGeneratedCargoVisual(cargo, 'shuttle', snapshot, this.host.resolveCargoGeneratorForModel(model));
    const targetPosition = state.cargoBoundToFork || !state.cargoHoldPosition
      ? this.getShuttleForkCargoPosition(model)
      : state.cargoHoldPosition;
    const targetRotation = state.cargoHoldRotation ?? cargo.lockedWorldRotation ?? getNodeWorldRotation(model.root);
    // 跨设备接管的货物从原世界位姿插值接入本机锚点，目标位姿每帧动态追踪（如叉尖随叉移动）
    const pose = resolveCargoHandoffPose(cargo, targetPosition, targetRotation, deltaSeconds);
    this.host.setGeneratedCargoRootPose(cargo, pose.position, pose.rotation, state.cargoBoundToFork ? null : state.cargoHoldScaling);
  }

  /** 货物底面锚定叉包围盒顶面中心，确保定位在货叉实际载货位置。 */
  private getShuttleForkCargoPosition(model: ModelRuntimeEntry): Vector3 {
    const bounds = getNodesWorldBounds(this.findShuttleForkNodes(model));
    if (!bounds) return model.root.getAbsolutePosition();

    const upAxis = getModelAxis(model.root, 'y');
    const center = bounds.minimum.add(bounds.maximum).scale(0.5);
    const topOffset = projectWorldBoundsOntoAxis(bounds, upAxis).max - Vector3.Dot(center, upAxis);
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
  private adoptOrCreateShuttleCargo(model: ModelRuntimeEntry, active: ShuttleActiveSide): void {
    const cargoKey = this.getShuttleCargoKey(model.assetCode);
    const adopted = this.context.adoptGlobalCargoByTask(active.task, cargoKey);
    if (adopted) {
      this.finalizeAdoptedShuttleCargo(model, active, adopted);
      return;
    }
    const cargo = this.state.shuttleCargoMeshes.get(cargoKey);
    if (!cargo) return;
    cargo.task = active.task;
    cargo.containerCode = active.containerCode;
  }

  /** 接管收尾：销毁本侧占位条目（从未渲染），货物身份换绑本机、记录交接插值起点并登记到本机货物键。 */
  private finalizeAdoptedShuttleCargo(
    model: ModelRuntimeEntry,
    active: ShuttleActiveSide,
    adopted: GeneratedCargoRuntimeEntry,
  ): void {
    const cargoKey = this.getShuttleCargoKey(model.assetCode);
    const placeholder = this.state.shuttleCargoMeshes.get(cargoKey);
    if (placeholder && placeholder !== adopted) this.disposeShuttleCargoByKey(cargoKey);
    adopted.assetCode = model.assetCode;
    adopted.task = active.task;
    adopted.containerCode = active.containerCode || adopted.containerCode;
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

  /** 清空本机的全部货物状态，保留 lastCommand/lastMovementZ 边沿检测基线。 */
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

  /** 将走行和货叉伸缩合成为每个节点的一次性世界偏移，避免重叠节点被后续动作覆盖。 */
  private applyShuttleNodeMotionOffsets(model: ModelRuntimeEntry): void {
    const state = model.shuttleTelemetry;
    const travelWorldOffset = (state.rootPosition ?? state.rootBasePosition).subtract(state.rootBasePosition);
    const forkAxis = getModelAxis(model.root, 'x');
    const offsets = new Map<TransformNode, Vector3>();

    this.addShuttleWorldOffset(offsets, filterTopLevelMotionNodes(this.findShuttleTravelNodes(model)), travelWorldOffset);
    this.addShuttleWorldOffset(offsets, filterTopLevelMotionNodes(this.findShuttleForkNodes(model)), forkAxis.scale(state.forkOffset));
    this.offsetNodesFromBaselineByWorldOffsets(model, offsets);
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

  /** 查找货叉节点：优先模型脚本 dataDriven.motion.fork.nodes 声明，缺失时按其 fallbackPattern 回退，再退硬编码正则。 */
  private findShuttleForkNodes(model: ModelRuntimeEntry): TransformNode[] {
    const configuredNames = this.readShuttleMotionNodeNames(model, 'fork');
    const configuredNodes = configuredNames.length > 0 ? findModelNodesByName(model, this.scene, configuredNames) : [];
    if (configuredNodes.length > 0) return configuredNodes;
    return findModelNodes(model, this.scene, this.readShuttleMotionFallbackPattern(model, 'fork', /fork|叉|huocha|cha\d*/i));
  }

  /** 读取模型脚本 dataDriven.motion.<key>.nodes 中声明的节点名。 */
  private readShuttleMotionNodeNames(model: ModelRuntimeEntry, motionKey: string): string[] {
    for (const dataDriven of model.externalScriptRuntime?.getDataDrivenConfigs() ?? []) {
      const nodes = readStringArrayPath(dataDriven, ['motion', motionKey, 'nodes']);
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

  /** 货叉速度：活动侧 rpm_z 优先，缺省回退 Inspector forkSpeed → dataDriven.motion.fork.speed → 常量。 */
  private readShuttleForkSpeed(model: ModelRuntimeEntry, snapshot: DeviceTelemetrySnapshot, side: ShuttleForkSide): number {
    const defaultSpeed = this.readShuttleInspectorSpeed(model, 'forkSpeed')
      ?? this.readShuttleDataDrivenNumber(model, ['motion', 'fork', 'speed'])
      ?? SHUTTLE_DEFAULT_FORK_SPEED_METERS_PER_SECOND;
    return this.readShuttleRpmSpeed(model, snapshot, side === 'front' ? 'front_rpm_z' : 'back_rpm_z', defaultSpeed);
  }

  /** 使用 rpm 字段换算速度；没有有效 rpm 时回退给定默认速度。 */
  private readShuttleRpmSpeed(model: ModelRuntimeEntry, snapshot: DeviceTelemetrySnapshot, rpmKey: string, defaultSpeed: number): number {
    const rpm = readNumberField(snapshot.fields, rpmKey);
    if (rpm === null || rpm <= 0) return defaultSpeed;
    const rpmScale = this.readShuttleDataDrivenNumber(model, ['device', 'rpmToMetersPerSecond']) ?? SHUTTLE_RPM_TO_METERS_PER_SECOND;
    return Math.max(defaultSpeed * 0.25, rpm * rpmScale);
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
    targetLocator: LocatorRuntimeEntry | null,
  ): void {
    const telemetryMetadata = {
      assetCode: snapshot.assetCode,
      payloadDeviceCode: snapshot.payloadDeviceCode,
      sourceTimestamp: snapshot.sourceTimestamp,
      receivedAt: snapshot.receivedAt,
      aisleCode: this.resolveShuttleAisleCode(model),
      targetFound: Boolean(targetLocator),
      faulted: snapshot.faulted,
      message: snapshot.message,
      fields: snapshot.fields,
      forkOffset: model.shuttleTelemetry.forkOffset,
      forkTargetOffset: model.shuttleTelemetry.forkTargetOffset,
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

  /** 对故障和状态变化做一次性 Console 提示，避免每帧刷屏。 */
  private reportShuttleRuntimeState(snapshot: DeviceTelemetrySnapshot): void {
    const deviceKey = `${snapshot.sourceId}:${snapshot.deviceType}:${snapshot.assetCode}`;
    const frontCommand = readIntegerField(snapshot.fields, 'front_command');
    const backCommand = readIntegerField(snapshot.fields, 'back_command');
    const statusSignature = JSON.stringify([frontCommand, backCommand, snapshot.message]);
    if (this.state.reportedStatuses.get(deviceKey) !== statusSignature) {
      this.state.reportedStatuses.set(deviceKey, statusSignature);
      this.host.pushLog(
        `多穿小车 ${snapshot.assetCode} 状态：front=${frontCommand ?? '未知'}，back=${backCommand ?? '未知'}${snapshot.message ? `，${snapshot.message}` : ''}`,
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
}
