import type { Scene } from '@babylonjs/core';
import { TransformNode, Vector3 } from '@babylonjs/core';
import {
  resolveLocatorBoxIndex,
  resolveLocatorCellSupportWorldPosition,
  resolveStackerStorageTargetOffsets,
} from '../stackerStorageLocation';
import {
  clampNumber,
  filterTopLevelMotionNodes,
  findModelNodes,
  findModelNodesByName,
  getHorizontalModelAxis,
  getModelAxis,
  getNodesProjectedBounds,
  getNodesWorldBounds,
  getNodeWorldPosePreservingMirror,
  getNodeWorldRotation,
  moveNumberTowards,
  moveVectorTowards,
  projectPointOntoAxis,
  projectWorldBoundsOntoAxis,
  uniqueTransformNodes,
  worldDeltaToParentLocalDelta,
} from '../../runtimeNodeGeometry';
import { isPlainRecord, readStringArrayPath, sanitizeBabylonName } from '../../runtimeValueUtils';
import {
  readIntegerField,
  readNumberField,
  readStringField,
  type StackerTelemetrySnapshot,
} from '../../../mqtt/deviceTelemetry';
import type { LocatorRuntimeEntry, ModelRuntimeEntry } from '../../SceneRuntime';
import { writeDeviceTelemetryMetadata } from './telemetryMetadata';
import {
  createCargoHandoffState,
  type GeneratedCargoRuntimeEntry,
  normalizeCargoTask,
  resolveCargoHandoffPose,
  type SpecializedTelemetryDriverContext,
  type SpecializedTelemetryHost,
  type SpecializedTelemetrySharedState,
  type StackerCargoRuntimeEntry,
  type StackerForkNodeGroups,
  type StackerForkOffsetParts,
  type StackerForkReachConfig,
  type StackerForkSide,
  type StackerLiftConstraint,
  type StackerTravelConstraint,
  STACKER_DEFAULT_FORK_SPEED_METERS_PER_SECOND,
  STACKER_DEFAULT_LIFT_SPEED_METERS_PER_SECOND,
  STACKER_CATCH_UP_MAX_WINDOW_SECONDS,
  STACKER_CATCH_UP_MIN_WINDOW_SECONDS,
  STACKER_FALLBACK_FIXED_NODE_NAMES,
  STACKER_FALLBACK_TRAVEL_NODE_NAMES,
  STACKER_FORK_CATCH_UP_SPEED_MULTIPLIER,
  STACKER_MAX_CATCH_UP_SPEED_METERS_PER_SECOND,
  STACKER_RPM_TO_METERS_PER_SECOND,
  STACKER_TARGET_SPEED_METERS_PER_SECOND,
} from './types';

export class StackerTelemetryDriver {
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

  /** 对单台 stacker 应用根节点、载货台和前后叉的遥测驱动；位置始终由 front_x/front_y/front_z 当前库位解算。 */
  applyToModel(model: ModelRuntimeEntry, snapshot: StackerTelemetrySnapshot, deltaSeconds: number): void {
    const state = model.stackerTelemetry;
    const frontCell = this.resolveStackerFrontCell(snapshot);
    this.reportStackerRuntimeState(snapshot);
    writeDeviceTelemetryMetadata(model, snapshot);

    const targetOffsets = frontCell.cell ? this.resolveStackerTargetMotionOffsets(model, frontCell.cell.supportPosition) : null;
    // command 相位离开边沿收尾须在 front_ 跳变跟踪之前：同帧「command 跳变 + 库位跳变」时先清滞留状态，避免 catch-up 误判
    this.completeStackerCargoOnPhaseExit(model, snapshot, frontCell.cell, 'front');
    this.completeStackerCargoOnPhaseExit(model, snapshot, frontCell.cell, 'back');
    // front_ 跟踪：首帧直接吸附到上报库位；后续跳变表示设备转场，快速收尾取/放动作并收叉，收回前冻结平移/升降
    this.trackStackerFrontCellChange(model, snapshot, frontCell.key, frontCell.cell, targetOffsets);

    if (state.forkCatchUp) {
      this.applyStackerForkCatchUpRetract(model, snapshot, deltaSeconds);
    } else {
      const travelMoving = this.applyStackerRootMotion(model, snapshot, targetOffsets?.travelOffset ?? null, deltaSeconds);
      const liftMoving = this.applyStackerLiftMotion(model, snapshot, targetOffsets?.liftOffset ?? null, deltaSeconds);
      this.applyStackerForkMotion(model, snapshot, frontCell.cell, deltaSeconds, travelMoving || liftMoving, frontCell.mismatch);
    }
    this.applyStackerNodeMotionOffsets(model);
    this.applyStackerCargoMotion(model, snapshot, frontCell.cell?.locator ?? null, frontCell.cell?.supportPosition ?? null, deltaSeconds);
    this.writeStackerTelemetryMetadata(model, snapshot, frontCell.cell?.locator ?? null);
  }

  /**
   * 按 front_x/front_y/front_z 解析当前货格：三字段全部缺失或全为 0（设备回原点空闲姿态）视为未上报（保持原位）；
   * 任一非零即为真实坐标（允许单列/单层为 0，如起始列 0 的库位）；
   * 有值但匹配不到已绑定货格时一次性报错并冻结移动与伸叉（mismatch）。
   * key 为三字段组成的库位键，供首帧吸附与变化检测使用。
   */
  private resolveStackerFrontCell(
    snapshot: StackerTelemetrySnapshot,
  ): { cell: { locator: LocatorRuntimeEntry; supportPosition: Vector3 } | null; mismatch: boolean; key: string | null } {
    const frontX = readIntegerField(snapshot.fields, 'front_x');
    const frontY = readIntegerField(snapshot.fields, 'front_y');
    const frontZ = readIntegerField(snapshot.fields, 'front_z');
    if (!snapshot.assetCode || frontX === null || frontY === null || frontZ === null) {
      return { cell: null, mismatch: false, key: null };
    }
    if (frontX === 0 && frontY === 0 && frontZ === 0) return { cell: null, mismatch: false, key: null };
    const key = JSON.stringify([frontX, frontY, frontZ]);
    const locator = this.host.findLocatorByDevice(snapshot.assetCode, frontX, frontY, frontZ);
    if (!locator) {
      this.reportStackerFrontCellMiss(snapshot, frontX, frontY, frontZ);
      return { cell: null, mismatch: true, key };
    }
    const supportPosition = this.resolveLocatorBoxSupportPosition(locator, frontX, frontY);
    return supportPosition
      ? { cell: { locator, supportPosition }, mismatch: false, key }
      : { cell: null, mismatch: true, key };
  }

  /** 当前位匹配失败的两类一次性报错：设备无任何已绑定货格 / 当前位超出已绑定货格的列层范围。 */
  private reportStackerFrontCellMiss(snapshot: StackerTelemetrySnapshot, frontX: number, frontY: number, frontZ: number): void {
    const boundLocators = this.host.findLocatorsByDevice(snapshot.assetCode!);
    const kind = boundLocators.length > 0 ? 'front-cell-range' : 'front-cell';
    const reportKey = `${snapshot.sourceId}:${snapshot.deviceType}:${snapshot.assetCode}:${kind}:${frontZ}:${frontX}:${frontY}`;
    if (this.state.reportedMissingTargets.has(reportKey)) return;
    this.state.reportedMissingTargets.add(reportKey);
    if (boundLocators.length === 0) {
      this.host.pushLog(`错误：Stacker ${snapshot.assetCode} 当前位（排${frontZ} 列${frontX} 层${frontY}）未匹配到任何已绑定货格，已忽略移动。`);
      return;
    }
    const ranges = boundLocators
      .map((entry) => `排${entry.rowNumber}：列${entry.startColumn}-${entry.startColumn + entry.columns - 1} 层${entry.startLayer}-${entry.startLayer + entry.layers - 1}`)
      .join('；');
    this.host.pushLog(`错误：Stacker ${snapshot.assetCode} 当前位（排${frontZ} 列${frontX} 层${frontY}）超出已绑定货格范围（${ranges}），已忽略移动。`);
  }

  /**
   * front_ 库位键跟踪：
   * - 首条有效库位：行走/升降直接吸附到上报库位，避免从原点缓慢追赶期间消息已经推进；
   * - 后续跳变：记录变化间隔（供自适应追赶速度估算），货叉已伸出或仍有货物滞留货格（未绑定）时进入 catch-up 并立即补齐动作语义。
   */
  private trackStackerFrontCellChange(
    model: ModelRuntimeEntry,
    snapshot: StackerTelemetrySnapshot,
    key: string | null,
    cell: { locator: LocatorRuntimeEntry; supportPosition: Vector3 } | null,
    targetOffsets: { travelOffset: number; liftOffset: number } | null,
  ): void {
    const state = model.stackerTelemetry;
    if (key === null) return;

    const nowMs = performance.now();
    if (state.lastFrontCellKey === null) {
      state.lastFrontCellKey = key;
      state.lastFrontCellChangedAtMs = nowMs;
      if (targetOffsets) this.snapStackerToTargetOffsets(model, targetOffsets);
      return;
    }
    if (key === state.lastFrontCellKey) return;

    if (state.lastFrontCellChangedAtMs !== null) {
      state.frontCellChangeIntervalMs = nowMs - state.lastFrontCellChangedAtMs;
    }
    state.lastFrontCellChangedAtMs = nowMs;
    state.lastFrontCellKey = key;
    if (state.forkCatchUp) return;

    const frontCommand = readIntegerField(snapshot.fields, 'front_command');
    const backCommand = readIntegerField(snapshot.fields, 'back_command');
    const forkDeployed = Math.abs(state.frontForkOffset) > 1e-3 || Math.abs(state.backForkOffset) > 1e-3;
    // 已绑定货物随叉随行是正常搬运，库位连续更新（真实 WCS 行走期间持续上报）不算动作未完结；
    // 仅滞留货格的未绑定货物才需在转场跳变时补齐取/放语义
    const frontMidAction = state.frontCargoKey !== null && !state.frontCargoBoundToFork;
    const backMidAction = state.backCargoKey !== null && !state.backCargoBoundToFork;
    if (!forkDeployed && !frontMidAction && !backMidAction) return;

    state.forkCatchUp = true;
    this.forceCompleteStackerForkAction(model, 'front', frontCommand, cell);
    this.forceCompleteStackerForkAction(model, 'back', backCommand, cell);
  }

  /** 首帧吸附：行走/升降一步到位对齐上报库位（仍受轨道与升降框架物理钳制），货叉保持原点。 */
  private snapStackerToTargetOffsets(
    model: ModelRuntimeEntry,
    targetOffsets: { travelOffset: number; liftOffset: number },
  ): void {
    const state = model.stackerTelemetry;
    const travelAxis = getHorizontalModelAxis(model.root, 'z');
    state.rootPosition = this.constrainStackerTravelPosition(
      model,
      state.rootBasePosition.add(travelAxis.scale(targetOffsets.travelOffset)),
      travelAxis,
    );
    state.liftOffset = this.clampStackerLiftOffset(model, targetOffsets.liftOffset);
  }

  /**
   * 自适应追赶速度：按最近两次 front_ 变化间隔估算本期窗口（夹在 0.25s~2s），
   * 速度 = 剩余距离 ÷ 窗口剩余时间，不低于默认速度、不超过上限，保证推送再快也能在下次变化前到位。
   */
  private resolveStackerCatchUpSpeed(
    model: ModelRuntimeEntry,
    distance: number,
    defaultSpeed: number,
  ): number {
    const state = model.stackerTelemetry;
    if (distance <= 1e-6 || state.frontCellChangeIntervalMs === null || state.lastFrontCellChangedAtMs === null) {
      return defaultSpeed;
    }
    const windowMs = Math.min(
      Math.max(state.frontCellChangeIntervalMs, STACKER_CATCH_UP_MIN_WINDOW_SECONDS * 1000),
      STACKER_CATCH_UP_MAX_WINDOW_SECONDS * 1000,
    );
    const remainingSeconds = Math.max(0.05, (windowMs - (performance.now() - state.lastFrontCellChangedAtMs)) / 1000);
    return Math.min(
      STACKER_MAX_CATCH_UP_SPEED_METERS_PER_SECOND,
      Math.max(defaultSpeed, distance / remainingSeconds),
    );
  }

  /** catch-up 进入时按当前 command 补齐单侧取/放语义：取货立即绑定并完成，放货立即解绑落位并完成。 */
  private forceCompleteStackerForkAction(
    model: ModelRuntimeEntry,
    side: StackerForkSide,
    command: number | null,
    cell: { locator: LocatorRuntimeEntry; supportPosition: Vector3 } | null,
  ): void {
    if (!this.getStackerForkCargoKey(model, side)) return;
    if (command === 1 || command === 2) {
      this.bindStackerCargo(model, side);
      this.completeStackerFetch(model, side);
      return;
    }
    if (command === 3 || command === 4) {
      this.unbindStackerCargo(model, cell?.locator ?? null, cell?.supportPosition ?? null, side);
      this.completeStackerPlace(model, cell?.locator ?? null, cell?.supportPosition ?? null, side);
    }
  }

  /** catch-up 期间货叉按倍率速度收回原点，双叉都归零后退出 catch-up 放行平移/升降。 */
  private applyStackerForkCatchUpRetract(model: ModelRuntimeEntry, snapshot: StackerTelemetrySnapshot, deltaSeconds: number): void {
    const state = model.stackerTelemetry;
    const frontSpeed = this.readSpeed(model, snapshot, 'front_rpm_z', 'fork', STACKER_DEFAULT_FORK_SPEED_METERS_PER_SECOND)
      * STACKER_FORK_CATCH_UP_SPEED_MULTIPLIER;
    const backSpeed = this.readSpeed(model, snapshot, 'back_rpm_z', 'fork', STACKER_DEFAULT_FORK_SPEED_METERS_PER_SECOND)
      * STACKER_FORK_CATCH_UP_SPEED_MULTIPLIER;
    state.frontForkTargetOffset = 0;
    state.backForkTargetOffset = 0;
    state.frontForkOffset = moveNumberTowards(state.frontForkOffset, 0, frontSpeed * deltaSeconds);
    state.backForkOffset = moveNumberTowards(state.backForkOffset, 0, backSpeed * deltaSeconds);
    if (Math.abs(state.frontForkOffset) < 1e-4 && Math.abs(state.backForkOffset) < 1e-4) {
      state.frontForkOffset = 0;
      state.backForkOffset = 0;
      state.forkCatchUp = false;
    }
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

  /** 使用 locator 盒体底面作为生成模型原点，保证模型落在定位框内部而不是悬在中心高度。 */
  private getWarehouseLocatorSupportPosition(locator: LocatorRuntimeEntry): Vector3 {
    const supportPosition = resolveLocatorCellSupportWorldPosition(locator, 0);
    const position = locator.root.getAbsolutePosition();
    return new Vector3(position.x, supportPosition?.y ?? position.y, position.z);
  }

  /** 按货叉初始世界锚点把 Locator 绝对坐标换算成运行时偏移。 */
  private resolveStackerTargetMotionOffsets(model: ModelRuntimeEntry, targetPosition: Vector3) {
    const referencePosition = this.getStackerTargetReferencePosition(model);
    const travelAxis = getHorizontalModelAxis(model.root, 'z');
    return resolveStackerStorageTargetOffsets({
      targetTravelCoordinate: Vector3.Dot(targetPosition, travelAxis),
      targetLiftCoordinate: targetPosition.y,
      referenceTravelCoordinate: Vector3.Dot(referencePosition, travelAxis),
      referenceLiftCoordinate: referencePosition.y,
    });
  }

  /** 有当前库位偏移时沿轨道向目标推进，否则保持原位；返回本帧是否在移动。 */
  private applyStackerRootMotion(
    model: ModelRuntimeEntry,
    snapshot: StackerTelemetrySnapshot,
    targetTravelOffset: number | null,
    deltaSeconds: number,
  ): boolean {
    const state = model.stackerTelemetry;
    const travelAxis = getHorizontalModelAxis(model.root, 'z');
    state.rootPosition ??= state.rootBasePosition.clone();

    let moving = false;
    if (!snapshot.faulted && targetTravelOffset !== null) {
      const rootTargetPosition = this.constrainStackerTravelPosition(
        model,
        state.rootBasePosition.add(travelAxis.scale(targetTravelOffset)),
        travelAxis,
      );
      const defaultSpeed = this.readStackerDataDrivenNumber(model, ['motion', 'travel', 'targetSpeed'])
        ?? STACKER_TARGET_SPEED_METERS_PER_SECOND;
      const targetSpeed = this.resolveStackerCatchUpSpeed(model, Vector3.Distance(state.rootPosition, rootTargetPosition), defaultSpeed);
      const previous = state.rootPosition;
      state.rootPosition = moveVectorTowards(
        state.rootPosition,
        rootTargetPosition,
        targetSpeed * deltaSeconds,
      );
      moving = Vector3.DistanceSquared(previous, state.rootPosition) > 1e-12;
    }

    state.rootPosition = this.constrainStackerTravelPosition(model, state.rootPosition, travelAxis);
    return moving;
  }

  /** 有当前库位层高偏移时向目标升降，否则保持原位；返回本帧是否在移动。 */
  private applyStackerLiftMotion(
    model: ModelRuntimeEntry,
    snapshot: StackerTelemetrySnapshot,
    targetLiftOffset: number | null,
    deltaSeconds: number,
  ): boolean {
    const state = model.stackerTelemetry;

    let moving = false;
    if (!snapshot.faulted && targetLiftOffset !== null) {
      const targetSpeed = this.resolveStackerCatchUpSpeed(
        model,
        Math.abs(targetLiftOffset - state.liftOffset),
        STACKER_DEFAULT_LIFT_SPEED_METERS_PER_SECOND,
      );
      const previous = state.liftOffset;
      state.liftOffset = this.clampStackerLiftOffset(
        model,
        moveNumberTowards(
          state.liftOffset,
          targetLiftOffset,
          targetSpeed * deltaSeconds,
        ),
      );
      moving = Math.abs(state.liftOffset - previous) > 1e-9;
    }
    return moving;
  }

  /** 根据前后叉 movement_z 信号分别驱动两组货叉伸缩；本体行走/升降期间强制收回原点。 */
  private applyStackerForkMotion(
    model: ModelRuntimeEntry,
    snapshot: StackerTelemetrySnapshot,
    cell: { locator: LocatorRuntimeEntry; supportPosition: Vector3 } | null,
    deltaSeconds: number,
    bodyMoving: boolean,
    extensionBlocked: boolean,
  ): void {
    // 当前位匹配失败时禁止伸叉（1/3 归一为静止），收回（2/4）始终可用
    const rawFrontMovement = readIntegerField(snapshot.fields, 'front_movement_z');
    const rawBackMovement = readIntegerField(snapshot.fields, 'back_movement_z');
    const frontMovement = extensionBlocked && (rawFrontMovement === 1 || rawFrontMovement === 3) ? null : rawFrontMovement;
    const backMovement = extensionBlocked && (rawBackMovement === 1 || rawBackMovement === 3) ? null : rawBackMovement;
    const frontForkSpeed = this.readSpeed(model, snapshot, 'front_rpm_z', 'fork', STACKER_DEFAULT_FORK_SPEED_METERS_PER_SECOND);
    const backForkSpeed = this.readSpeed(model, snapshot, 'back_rpm_z', 'fork', STACKER_DEFAULT_FORK_SPEED_METERS_PER_SECOND);
    const state = model.stackerTelemetry;

    // 平移/升降与货叉伸出互斥：本体移动期间两叉收回并保持原点
    if (bodyMoving) {
      state.frontForkOffset = moveNumberTowards(state.frontForkOffset, 0, frontForkSpeed * deltaSeconds);
      state.backForkOffset = moveNumberTowards(state.backForkOffset, 0, backForkSpeed * deltaSeconds);
      return;
    }

    state.frontForkOffset = this.updateForkOffset(model, 'front', state.frontForkOffset, frontMovement, frontForkSpeed, cell, snapshot.faulted, deltaSeconds);
    state.backForkOffset = this.updateForkOffset(model, 'back', state.backForkOffset, backMovement, backForkSpeed, cell, snapshot.faulted, deltaSeconds);
  }

  /** 更新单侧货叉偏移：movement_z 1/3 向目标行程伸出，2/4 收回原点，其余保持；目标行程由当前货格几何决定。 */
  private updateForkOffset(
    model: ModelRuntimeEntry,
    side: StackerForkSide,
    currentOffset: number,
    movement: number | null,
    speed: number,
    cell: { locator: LocatorRuntimeEntry; supportPosition: Vector3 } | null,
    faulted: boolean,
    deltaSeconds: number,
  ): number {
    const state = model.stackerTelemetry;
    const stroke = this.getStackerForkStroke(model, side);
    if (faulted) return this.clampForkOffset(currentOffset, stroke.total);

    if (movement === 1 || movement === 3) {
      // 伸出方向由目标货格几何决定：1/3 不再区分左右编码；无货格或货格正对叉中心时回退编码语义
      const direction = this.resolveForkExtendDirection(model, side, cell) ?? (movement === 1 ? 1 : -1);
      const target = this.resolveForkTargetOffset(model, side, direction, cell, stroke);
      if (side === 'front') state.frontForkTargetOffset = target;
      else state.backForkTargetOffset = target;
      return this.clampForkOffset(moveNumberTowards(currentOffset, target, speed * deltaSeconds), stroke.total);
    }

    if (movement === 2 || movement === 4) {
      if (side === 'front') state.frontForkTargetOffset = 0;
      else state.backForkTargetOffset = 0;
      return moveNumberTowards(this.clampForkOffset(currentOffset, stroke.total), 0, speed * deltaSeconds);
    }

    return this.clampForkOffset(currentOffset, stroke.total);
  }

  /**
   * 按货格几何求伸出方向：货格支撑位相对叉收回位中心在货叉轴上的投影符号。
   * 参照点减去当前偏移还原收回原位，伸出过程中保持恒定（不会中途掉头）；
   * 无货格、叉节点不可投影或货格正对叉中心（方向无意义）时返回 null，由调用方回退编码语义。
   */
  private resolveForkExtendDirection(
    model: ModelRuntimeEntry,
    side: StackerForkSide,
    cell: { locator: LocatorRuntimeEntry; supportPosition: Vector3 } | null,
  ): number | null {
    if (!cell) return null;
    const forkAxis = getModelAxis(model.root, 'x');
    const groups = this.findStackerForkNodeGroups(model);
    const stageTwoNodes = side === 'front' ? groups.frontStageTwoNodes : groups.backStageTwoNodes;
    const stageOneNodes = side === 'front' ? groups.frontStageOneNodes : groups.backStageOneNodes;
    const allNodes = side === 'front' ? groups.frontNodes : groups.backNodes;
    const nodes = stageTwoNodes.length > 0 ? stageTwoNodes : (stageOneNodes.length > 0 ? stageOneNodes : allNodes);
    const projected = getNodesProjectedBounds(nodes, forkAxis);
    if (!projected) return null;
    const state = model.stackerTelemetry;
    const offset = side === 'front' ? state.frontForkOffset : state.backForkOffset;
    const homeCenter = (projected.max + projected.min) / 2 - offset;
    const diff = Vector3.Dot(cell.supportPosition, forkAxis) - homeCenter;
    if (!Number.isFinite(diff) || Math.abs(diff) < 1e-6) return null;
    return Math.sign(diff);
  }

  /**
   * 按货格几何求单侧货叉目标行程（带方向符号）：叉尖需覆盖货格整个底部，即抵达货格远端；
   * 超出自身行程则夹到上限。无货格（输送线侧）或货格不在伸出方向上时回退全行程。
   */
  private resolveForkTargetOffset(
    model: ModelRuntimeEntry,
    side: StackerForkSide,
    direction: number,
    cell: { locator: LocatorRuntimeEntry; supportPosition: Vector3 } | null,
    stroke: StackerForkReachConfig,
  ): number {
    if (stroke.total <= 0) return 0;
    if (!cell) return direction * stroke.total;

    const forkAxis = getModelAxis(model.root, 'x');
    const tipHome = this.resolveForkTipHomeCoordinate(model, side, direction, forkAxis);
    if (tipHome === null) return direction * stroke.total;

    const halfDepth = this.resolveLocatorCellHalfDepthAlongAxis(cell.locator, forkAxis);
    const farEdge = Vector3.Dot(cell.supportPosition, forkAxis) + direction * halfDepth;
    const needed = direction * (farEdge - tipHome);
    if (!Number.isFinite(needed) || needed <= 0) return direction * stroke.total;
    return direction * Math.min(needed, stroke.total);
  }

  /** 叉尖在货叉完全收回（offset=0）时沿伸出方向的轴坐标；当前投影坐标减去当前偏移还原原位。 */
  private resolveForkTipHomeCoordinate(
    model: ModelRuntimeEntry,
    side: StackerForkSide,
    direction: number,
    forkAxis: Vector3,
  ): number | null {
    const state = model.stackerTelemetry;
    const groups = this.findStackerForkNodeGroups(model);
    const stageTwoNodes = side === 'front' ? groups.frontStageTwoNodes : groups.backStageTwoNodes;
    const stageOneNodes = side === 'front' ? groups.frontStageOneNodes : groups.backStageOneNodes;
    const allNodes = side === 'front' ? groups.frontNodes : groups.backNodes;
    const nodes = stageTwoNodes.length > 0 ? stageTwoNodes : (stageOneNodes.length > 0 ? stageOneNodes : allNodes);
    const projected = getNodesProjectedBounds(nodes, forkAxis);
    if (!projected) return null;
    const offset = side === 'front' ? state.frontForkOffset : state.backForkOffset;
    return (direction > 0 ? projected.max : projected.min) - offset;
  }

  /** 货格沿货叉轴的半深度：格子本地三轴半尺寸在货叉轴上的投影之和，任意货架摆向下都成立。 */
  private resolveLocatorCellHalfDepthAlongAxis(locator: LocatorRuntimeEntry, forkAxis: Vector3): number {
    locator.root.computeWorldMatrix(true);
    const worldMatrix = locator.root.getWorldMatrix();
    const axisX = Vector3.TransformNormal(new Vector3(1, 0, 0), worldMatrix);
    const axisY = Vector3.TransformNormal(new Vector3(0, 1, 0), worldMatrix);
    const axisZ = Vector3.TransformNormal(new Vector3(0, 0, 1), worldMatrix);
    return (
      Math.abs(Vector3.Dot(axisX, forkAxis)) * locator.cellSize.length
      + Math.abs(Vector3.Dot(axisY, forkAxis)) * locator.cellSize.height
      + Math.abs(Vector3.Dot(axisZ, forkAxis)) * locator.cellSize.width
    ) / 2;
  }

  /** 单侧货叉行程上限：一段/二段节点几何沿货叉轴的实测长度，缓存于遥测状态；无一段节点时回退该侧全部叉节点。 */
  private getStackerForkStroke(model: ModelRuntimeEntry, side: StackerForkSide): StackerForkReachConfig {
    const state = model.stackerTelemetry;
    const cached = side === 'front' ? state.frontForkStroke : state.backForkStroke;
    if (cached) return cached;

    const groups = this.findStackerForkNodeGroups(model);
    const forkAxis = getModelAxis(model.root, 'x');
    const measure = (nodes: TransformNode[]): number => {
      const projected = getNodesProjectedBounds(nodes, forkAxis);
      return projected ? Math.max(0, projected.max - projected.min) : 0;
    };
    const stageOneNodes = side === 'front' ? groups.frontStageOneNodes : groups.backStageOneNodes;
    const stageTwoNodes = side === 'front' ? groups.frontStageTwoNodes : groups.backStageTwoNodes;
    const allNodes = side === 'front' ? groups.frontNodes : groups.backNodes;
    const stageOne = stageOneNodes.length > 0 ? measure(stageOneNodes) : measure(allNodes);
    const stageTwo = measure(stageTwoNodes);
    const stroke: StackerForkReachConfig = { stageOne, stageTwo, total: stageOne + stageTwo };
    if (side === 'front') state.frontForkStroke = stroke;
    else state.backForkStroke = stroke;
    return stroke;
  }

  /** 将货叉总偏移拆分成第一段和第二段，保留正负方向语义。 */
  private splitForkOffset(offset: number, reach: StackerForkReachConfig): StackerForkOffsetParts {
    const direction = Math.sign(offset) || 1;
    const absoluteOffset = clampNumber(Math.abs(offset), 0, reach.total);
    const stageOneDistance = Math.min(absoluteOffset, reach.stageOne);
    const stageTwoDistance = Math.max(0, absoluteOffset - reach.stageOne);

    return {
      totalOffset: absoluteOffset * direction,
      stageOneOffset: stageOneDistance * direction,
      stageTwoOffset: stageTwoDistance * direction,
      activeStage: stageTwoDistance > 0.001 ? 2 : (stageOneDistance > 0.001 ? 1 : 0),
    };
  }

  /** 将货叉偏移限制在两段总行程内。 */
  private clampForkOffset(offset: number, maxReach: number): number {
    const reach = Math.max(0, maxReach);
    return clampNumber(offset, -reach, reach);
  }

  /** 根据前叉/后叉托盘条码驱动货物：取货时随叉运动，放货时进入目标定位线框。 */
  private applyStackerCargoMotion(
    model: ModelRuntimeEntry,
    snapshot: StackerTelemetrySnapshot,
    targetLocator: LocatorRuntimeEntry | null,
    targetPosition: Vector3 | null,
    deltaSeconds: number,
  ): void {
    this.applyStackerForkCargoMotion(model, snapshot, targetLocator, targetPosition, 'front', deltaSeconds);
    this.applyStackerForkCargoMotion(model, snapshot, targetLocator, targetPosition, 'back', deltaSeconds);
  }

  /**
   * 单侧货叉的货物状态机：command 决定取/放阶段；取货货物在伸叉开始瞬间于当前货格刷出，
   * 货叉伸出到位（伸叉动画完结）执行绑定/解绑。
   * command 语义：1 取货中 / 2 取货完成 / 3、4 放货中 / 5 放货完成；
   * 完成确认值（2/5）可能缺失，完成逻辑统一在离开对应 command 相位时执行（completeStackerCargoOnPhaseExit）。
   */
  private applyStackerForkCargoMotion(
    model: ModelRuntimeEntry,
    snapshot: StackerTelemetrySnapshot,
    targetLocator: LocatorRuntimeEntry | null,
    targetPosition: Vector3 | null,
    side: StackerForkSide,
    deltaSeconds: number,
  ): void {
    const state = model.stackerTelemetry;
    const command = readIntegerField(snapshot.fields, side === 'front' ? 'front_command' : 'back_command');

    if (!snapshot.faulted) {
      // 取货伸叉开始瞬间才在当前货格刷出货物并接管该格口渲染；command 1 本身不刷货，
      // 避免货物在设备仍在就位途中时提前出现。cargoKey 保证一次取货只刷一次。
      const movement = readIntegerField(snapshot.fields, side === 'front' ? 'front_movement_z' : 'back_movement_z');
      if (command === 1 && (movement === 1 || movement === 3) && targetLocator && !this.getStackerForkCargoKey(model, side)) {
        this.beginStackerFetch(model, snapshot, targetLocator, targetPosition, side);
      }
      // 放货阶段：未经历取货直接放货（如开机即放货）时叉上补建货物并绑定叉尖；
      // 同时接管目标格口渲染使其保持为空，货物全程由 stacker 渲染；
      // 锁定目标排号：放货完成时当前位字段可能已变化，排号必须提前留存
      if ((command === 3 || command === 4) && targetLocator) {
        if (!this.getStackerForkCargoKey(model, side)) {
          this.beginStackerPlaceWithCargo(model, snapshot, side);
        }
        const lockedRow = side === 'front' ? state.frontCargoFetchRow : state.backCargoFetchRow;
        if (lockedRow === null) {
          const frontX = readIntegerField(snapshot.fields, 'front_x');
          const frontY = readIntegerField(snapshot.fields, 'front_y');
          const fetchRow = frontX !== null && frontY !== null
            ? this.host.suppressFetchCellForLocator(targetLocator, frontX, frontY)
            : this.host.resolveFetchDriveRowForLocator(targetLocator);
          if (side === 'front') state.frontCargoFetchRow = fetchRow;
          else state.backCargoFetchRow = fetchRow;
        }
      }
      // 伸叉动画完结（偏移到达目标行程）：取货阶段绑定货物上叉，放货阶段解绑落入箱位
      if (!state.forkCatchUp && this.isStackerForkFullyExtended(model, side)) {
        if (command === 1 || command === 2) this.bindStackerCargo(model, side);
        else if (command === 3 || command === 4) this.unbindStackerCargo(model, targetLocator, targetPosition, side);
      }
    }

    this.updateStackerCargoPose(model, snapshot, side, deltaSeconds);

    if (side === 'front') {
      state.frontLastCommand = command;
    } else {
      state.backLastCommand = command;
    }
  }

  /** 货叉是否已伸出到目标行程（伸叉动画完结）；目标行程为零视为未在伸出，留 2cm 到位余量。 */
  private isStackerForkFullyExtended(model: ModelRuntimeEntry, side: StackerForkSide): boolean {
    const state = model.stackerTelemetry;
    const target = side === 'front' ? state.frontForkTargetOffset : state.backForkTargetOffset;
    if (Math.abs(target) < 0.001) return false;
    const forkOffset = side === 'front' ? state.frontForkOffset : state.backForkOffset;
    return Math.abs(forkOffset) >= Math.abs(target) - 0.02;
  }

  /** 取货初始化（伸叉开始瞬间触发）：在当前货格支撑位创建货物并抑制该格口 fetch 渲染，货物暂留货格等待伸叉到位绑定。 */
  private beginStackerFetch(
    model: ModelRuntimeEntry,
    snapshot: StackerTelemetrySnapshot,
    targetLocator: LocatorRuntimeEntry | null,
    targetPosition: Vector3 | null,
    side: StackerForkSide,
  ): void {
    const state = model.stackerTelemetry;
    // 同侧旧货物（含 fetch 保留中的滞留项）先销毁，避免新任务复用到已交接的货物
    this.disposeStackerCargoByKey(this.getStackerCargoKey(model.assetCode, side));
    this.clearStackerForkCargoState(model, side);

    // 触发方已保证当前货格存在；防御空指针直接返回
    if (!targetLocator) return;

    this.getOrCreateStackerCargo(model.assetCode, side);
    // 目标是 conveyor 站台（内置 1×1 货格）：无视 task 直接接管该 conveyor 的滞留持货；
    // 未命中（普通库位/对方无货）回退按 task 全局接管或自建。
    const platformAdopted = this.context.adoptConveyorPlatformCargo(targetLocator.entityId, model.assetCode);
    if (platformAdopted) {
      this.finalizeAdoptedStackerCargo(model, snapshot, side, platformAdopted);
    } else {
      this.adoptOrCreateStackerCargo(model, snapshot, side);
    }
    // 抑制源格口 fetch 渲染（货物改由 stacker 渲染）；取货不留存排号，fetch 单排同步不由取货完成触发
    const frontX = readIntegerField(snapshot.fields, 'front_x');
    const frontY = readIntegerField(snapshot.fields, 'front_y');
    if (frontX !== null && frontY !== null) this.host.suppressFetchCellForLocator(targetLocator, frontX, frontY);
    const holdPosition = this.resolveCellCargoHoldPosition(model, targetLocator, targetPosition);
    const holdPose = getNodeWorldPosePreservingMirror(targetLocator.root);
    if (side === 'front') {
      state.frontCargoKey = this.getStackerCargoKey(model.assetCode, side);
      state.frontCargoHoldPosition = holdPosition;
      state.frontCargoHoldRotation = holdPose.rotation;
      state.frontCargoHoldScaling = holdPose.scaling;
    } else {
      state.backCargoKey = this.getStackerCargoKey(model.assetCode, side);
      state.backCargoHoldPosition = holdPosition;
      state.backCargoHoldRotation = holdPose.rotation;
      state.backCargoHoldScaling = holdPose.scaling;
    }
  }

  /** 直接进入放货流程时补建叉上货物：初始即绑定叉尖，等待伸叉到位后解绑落入目标箱位。 */
  private beginStackerPlaceWithCargo(model: ModelRuntimeEntry, snapshot: StackerTelemetrySnapshot, side: StackerForkSide): void {
    this.disposeStackerCargoByKey(this.getStackerCargoKey(model.assetCode, side));
    this.clearStackerForkCargoState(model, side);
    this.getOrCreateStackerCargo(model.assetCode, side);
    this.adoptOrCreateStackerCargo(model, snapshot, side);
    const state = model.stackerTelemetry;
    const cargoKey = this.getStackerCargoKey(model.assetCode, side);
    if (side === 'front') {
      state.frontCargoKey = cargoKey;
      state.frontCargoBoundToFork = true;
    } else {
      state.backCargoKey = cargoKey;
      state.backCargoBoundToFork = true;
    }
  }

  /** 伸叉结束，货物绑定到叉尖，之后随货叉一同运动。 */
  private bindStackerCargo(model: ModelRuntimeEntry, side: StackerForkSide): void {
    const state = model.stackerTelemetry;
    if (!this.getStackerForkCargoKey(model, side)) return;
    if (side === 'front') {
      if (state.frontCargoBoundToFork) return;
      state.frontCargoBoundToFork = true;
      state.frontCargoHoldPosition = null;
      state.frontCargoHoldRotation = null;
      state.frontCargoHoldScaling = null;
    } else {
      if (state.backCargoBoundToFork) return;
      state.backCargoBoundToFork = true;
      state.backCargoHoldPosition = null;
      state.backCargoHoldRotation = null;
      state.backCargoHoldScaling = null;
    }
  }

  /**
   * 放货伸叉结束，货物解绑并留在目标箱位支撑位，货叉随后空收。
   * 非 fetch 的 conveyor 站台目标在落货当场交接给 conveyor 继续流转，不等 command 5；
   * 交接被拒（对方已有货等）保持原位，command 5 走原销毁路径。
   */
  private unbindStackerCargo(
    model: ModelRuntimeEntry,
    targetLocator: LocatorRuntimeEntry | null,
    targetPosition: Vector3 | null,
    side: StackerForkSide,
  ): void {
    const state = model.stackerTelemetry;
    if (!this.getStackerForkCargoKey(model, side) || !targetLocator) return;
    const bound = side === 'front' ? state.frontCargoBoundToFork : state.backCargoBoundToFork;
    if (!bound) return;
    const holdPosition = this.resolveCellCargoHoldPosition(model, targetLocator, targetPosition);
    const holdPose = getNodeWorldPosePreservingMirror(targetLocator.root);
    if (side === 'front') {
      state.frontCargoBoundToFork = false;
      state.frontCargoHoldPosition = holdPosition;
      state.frontCargoHoldRotation = holdPose.rotation;
      state.frontCargoHoldScaling = holdPose.scaling;
    } else {
      state.backCargoBoundToFork = false;
      state.backCargoHoldPosition = holdPosition;
      state.backCargoHoldRotation = holdPose.rotation;
      state.backCargoHoldScaling = holdPose.scaling;
    }

    const fetchRow = side === 'front' ? state.frontCargoFetchRow : state.backCargoFetchRow;
    const cargoKey = this.getStackerForkCargoKey(model, side);
    if (fetchRow === null && cargoKey) {
      this.context.placeCargoIntoConveyorPlatform(targetLocator.entityId, cargoKey);
    }
  }

  /**
   * command 相位离开边沿收尾：取/放完成确认值（2/5）可能缺失，统一在离开取货（1）/放货（3、4）
   * 相位时执行原确认值逻辑；正常路径（1→2、3/4→5）边沿时刻与原确认值边沿一致，行为不变。
   * 不受 faulted 门控：纯状态簿记，且故障恰好跨越跳变时仍要收尾，避免货物状态滞留。
   */
  private completeStackerCargoOnPhaseExit(
    model: ModelRuntimeEntry,
    snapshot: StackerTelemetrySnapshot,
    cell: { locator: LocatorRuntimeEntry; supportPosition: Vector3 } | null,
    side: StackerForkSide,
  ): void {
    const state = model.stackerTelemetry;
    const command = readIntegerField(snapshot.fields, side === 'front' ? 'front_command' : 'back_command');
    const lastCommand = side === 'front' ? state.frontLastCommand : state.backLastCommand;
    if (lastCommand === 1 && command !== 1) {
      this.completeStackerFetch(model, side);
      return;
    }
    if ((lastCommand === 3 || lastCommand === 4) && command !== 3 && command !== 4) {
      this.completeStackerPlace(model, cell?.locator ?? null, cell?.supportPosition ?? null, side);
    }
  }

  /** 取货完成：兜底绑定后交还源库位；fetch 单排同步不在此触发。 */
  private completeStackerFetch(model: ModelRuntimeEntry, side: StackerForkSide): void {
    if (!this.getStackerForkCargoKey(model, side)) return;
    this.bindStackerCargo(model, side);
  }

  /** 放货完成：fetch 库位保留货物至单排同步响应后销毁，其余立即销毁；conveyor 站台交接已在落货时完成。 */
  private completeStackerPlace(
    model: ModelRuntimeEntry,
    targetLocator: LocatorRuntimeEntry | null,
    targetPosition: Vector3 | null,
    side: StackerForkSide,
  ): void {
    const cargoKey = this.getStackerForkCargoKey(model, side);
    if (!cargoKey) return;
    this.unbindStackerCargo(model, targetLocator, targetPosition, side);

    const state = model.stackerTelemetry;
    const fetchRow = side === 'front' ? state.frontCargoFetchRow : state.backCargoFetchRow;
    if (this.host.keepCargoForFetchRowSync(fetchRow, model.assetCode, side)) {
      this.host.handleFetchRowSync(fetchRow as number);
    } else if (fetchRow === null) {
      this.disposeStackerCargoByKey(cargoKey);
    }
    this.clearStackerForkCargoState(model, side);
  }

  /** 每帧刷新货物外观与位姿：绑定跟随叉尖，未绑定静止于箱位支撑位。 */
  private updateStackerCargoPose(model: ModelRuntimeEntry, snapshot: StackerTelemetrySnapshot, side: StackerForkSide, deltaSeconds: number): void {
    const cargoKey = this.getStackerForkCargoKey(model, side);
    if (!cargoKey) return;
    const cargo = this.state.stackerCargoMeshes.get(cargoKey);
    if (!cargo) return;

    const state = model.stackerTelemetry;
    const bound = side === 'front' ? state.frontCargoBoundToFork : state.backCargoBoundToFork;
    const holdPosition = side === 'front' ? state.frontCargoHoldPosition : state.backCargoHoldPosition;
    const holdRotation = side === 'front' ? state.frontCargoHoldRotation : state.backCargoHoldRotation;
    const holdScaling = side === 'front' ? state.frontCargoHoldScaling : state.backCargoHoldScaling;

    this.host.syncGeneratedCargoVisual(cargo, 'stacker', snapshot, this.host.resolveCargoGeneratorForModel(model));
    const targetPosition = bound || !holdPosition
      ? this.getStackerForkCargoPosition(model, side)
      : holdPosition;
    const targetRotation = bound || !holdRotation
      ? getNodeWorldRotation(model.root)
      : holdRotation;
    // 跨设备接管的货物从原世界位姿插值接入本机锚点，目标位姿每帧动态追踪（如叉尖随叉移动）
    const pose = resolveCargoHandoffPose(cargo, targetPosition, targetRotation, deltaSeconds);
    this.host.setGeneratedCargoRootPose(cargo, pose.position, pose.rotation, bound ? null : holdScaling);
  }

  /** 货物底面锚定二段叉包围盒顶面 + 可配竖直间隙（无二段时回退一段/全叉），确保定位在货叉实际载货位置。 */
  private getStackerForkCargoPosition(model: ModelRuntimeEntry, side: StackerForkSide): Vector3 {
    const forkGroups = this.findStackerForkNodeGroups(model);
    const stageTwoNodes = side === 'front' ? forkGroups.frontStageTwoNodes : forkGroups.backStageTwoNodes;
    const stageOneNodes = side === 'front' ? forkGroups.frontStageOneNodes : forkGroups.backStageOneNodes;
    const allNodes = side === 'front' ? forkGroups.frontNodes : forkGroups.backNodes;
    const nodes = stageTwoNodes.length > 0 ? stageTwoNodes : (stageOneNodes.length > 0 ? stageOneNodes : allNodes);
    const bounds = getNodesWorldBounds(nodes);
    if (!bounds) return model.root.getAbsolutePosition();

    const upAxis = getModelAxis(model.root, 'y');
    const center = bounds.minimum.add(bounds.maximum).scale(0.5);
    const topOffset = projectWorldBoundsOntoAxis(bounds, upAxis).max - Vector3.Dot(center, upAxis);
    return center.add(upAxis.scale(topOffset + this.resolveStackerCargoGapY(model)));
  }

  /** 货物竖直间隙（telemetryBinding.stackerCargoGapY，允许负值）；叉面锚点与货格支撑位共用，保证取/放交接无高差跳变。 */
  private resolveStackerCargoGapY(model: ModelRuntimeEntry): number {
    return model.telemetryBinding?.stackerCargoGapY ?? 0;
  }

  /** 货格内货物的支撑位：箱位底面中心 + 货物竖直间隙（与叉面锚点同源，伸叉交接丝滑）。 */
  private resolveCellCargoHoldPosition(
    model: ModelRuntimeEntry,
    targetLocator: LocatorRuntimeEntry,
    targetPosition: Vector3 | null,
  ): Vector3 {
    const base = targetPosition ?? this.getWarehouseLocatorSupportPosition(targetLocator);
    return base.add(getModelAxis(model.root, 'y').scale(this.resolveStackerCargoGapY(model)));
  }

  /** 读取某侧货叉当前货物键（JSON.stringify([assetCode, side])），null 表示叉上无货。 */
  private getStackerForkCargoKey(model: ModelRuntimeEntry, side: StackerForkSide): string | null {
    return side === 'front' ? model.stackerTelemetry.frontCargoKey : model.stackerTelemetry.backCargoKey;
  }

  /** 清空某侧货叉的全部货物状态，保留 lastCommand/lastMovementZ 边沿检测基线。 */
  private clearStackerForkCargoState(model: ModelRuntimeEntry, side: StackerForkSide): void {
    const state = model.stackerTelemetry;
    if (side === 'front') {
      state.frontCargoKey = null;
      state.frontCargoBoundToFork = false;
      state.frontCargoHoldPosition = null;
      state.frontCargoHoldRotation = null;
      state.frontCargoHoldScaling = null;
      state.frontCargoFetchRow = null;
      return;
    }

    state.backCargoKey = null;
    state.backCargoBoundToFork = false;
    state.backCargoHoldPosition = null;
    state.backCargoHoldRotation = null;
    state.backCargoHoldScaling = null;
    state.backCargoFetchRow = null;
  }

  /** 按键销毁堆垛机运行时货物，map 中不存在时幂等跳过。 */
  private disposeStackerCargoByKey(key: string): void {
    const cargo = this.state.stackerCargoMeshes.get(key);
    if (!cargo) return;
    this.disposeStackerCargo(cargo);
    this.state.stackerCargoMeshes.delete(key);
  }

  /**
   * 其他设备凭同一 task 接管本货箱：清理引用该货箱的模型遥测引用后从表中取出（不销毁），
   * 货箱实例交给接管方保持视觉连续；fetch 保留中的滞留货箱无模型引用，同样直接取出。
   */
  detachClaimedCargoByKey(key: string): StackerCargoRuntimeEntry | null {
    const cargo = this.state.stackerCargoMeshes.get(key);
    if (!cargo) return null;
    for (const { model } of this.host.collectModels()) {
      if (model.stackerTelemetry.frontCargoKey === key) this.clearStackerForkCargoState(model, 'front');
      if (model.stackerTelemetry.backCargoKey === key) this.clearStackerForkCargoState(model, 'back');
    }
    this.state.stackerCargoMeshes.delete(key);
    return cargo;
  }

  /**
   * 刷出货物时按 task 全局接管或自建：接管成功则以货箱当前世界位姿为起点进入交接插值，
   * 并销毁本侧刚建的占位条目（从未渲染）；无 task 匿名，不参与全局接管。
   */
  private adoptOrCreateStackerCargo(
    model: ModelRuntimeEntry,
    snapshot: StackerTelemetrySnapshot,
    side: StackerForkSide,
  ): void {
    const cargoKey = this.getStackerCargoKey(model.assetCode, side);
    const task = normalizeCargoTask(readIntegerField(snapshot.fields, `${side}_task`));
    const adopted = this.context.adoptGlobalCargoByTask(task, cargoKey);
    if (adopted) {
      this.finalizeAdoptedStackerCargo(model, snapshot, side, adopted);
      return;
    }
    const cargo = this.state.stackerCargoMeshes.get(cargoKey);
    if (!cargo) return;
    cargo.task = task;
    cargo.containerCode = readStringField(snapshot.fields, `${side}_containerCode`)?.trim() ?? '';
  }

  /** 接管收尾：销毁本侧占位条目（从未渲染），货物身份换绑本机、记录交接插值起点并登记到本侧货叉键。 */
  private finalizeAdoptedStackerCargo(
    model: ModelRuntimeEntry,
    snapshot: StackerTelemetrySnapshot,
    side: StackerForkSide,
    adopted: GeneratedCargoRuntimeEntry,
  ): void {
    const cargoKey = this.getStackerCargoKey(model.assetCode, side);
    const task = normalizeCargoTask(readIntegerField(snapshot.fields, `${side}_task`));
    const containerCode = readStringField(snapshot.fields, `${side}_containerCode`)?.trim() ?? '';
    const placeholder = this.state.stackerCargoMeshes.get(cargoKey);
    if (placeholder && placeholder !== adopted) this.disposeStackerCargoByKey(cargoKey);
    adopted.assetCode = model.assetCode;
    adopted.task = task;
    adopted.containerCode = containerCode || adopted.containerCode;
    adopted.handoff = createCargoHandoffState(adopted);
    this.state.stackerCargoMeshes.set(cargoKey, adopted);
  }

  /** 创建或复用某侧货叉的堆垛机运行时货物。 */
  getOrCreateStackerCargo(assetCode: string, side: StackerForkSide): StackerCargoRuntimeEntry {
    const key = this.getStackerCargoKey(assetCode, side);
    const existing = this.state.stackerCargoMeshes.get(key);
    if (existing) return existing;

    const root = new TransformNode(
      `stacker_cargo_root_${sanitizeBabylonName(assetCode)}_${side}`,
      this.scene,
    );
    const entry: StackerCargoRuntimeEntry = {
      assetCode,
      containerCode: '',
      task: '',
      root,
      outputOwner: null,
      fallback: null,
      generatorEntityId: null,
      handoff: null,
      axialLengthCache: null,
    };
    this.state.stackerCargoMeshes.set(key, entry);
    return entry;
  }

  /** 删除指定 Stacker 实例生成的运行时货物，不污染场景文档。 */
  disposeStackerCargoForAssetCode(assetCode: string): void {
    for (const [key, cargo] of this.state.stackerCargoMeshes.entries()) {
      if (cargo.assetCode !== assetCode) continue;
      this.disposeStackerCargo(cargo);
      this.state.stackerCargoMeshes.delete(key);
    }
  }

  /** 释放单个堆垛机运行时货物的模板、回退 Box 和支撑点根节点。 */
  disposeStackerCargo(cargo: StackerCargoRuntimeEntry): void {
    this.host.disposeGeneratedCargo(cargo);
  }

  /** 生成堆垛机运行时货物的唯一键：每台设备每侧货叉同时最多携带一箱。 */
  getStackerCargoKey(assetCode: string, side: StackerForkSide): string {
    return JSON.stringify([assetCode, side]);
  }

  /** 读取并缓存前后一段货叉的初始世界中心，缺失货叉时回退到载货台。 */
  getStackerTargetReferencePosition(model: ModelRuntimeEntry): Vector3 {
    const state = model.stackerTelemetry;
    if (state.targetReferencePosition) return state.targetReferencePosition;

    const forkGroups = this.findStackerForkNodeGroups(model);
    const forkNodes = uniqueTransformNodes([
      ...forkGroups.frontStageOneNodes,
      ...forkGroups.backStageOneNodes,
    ]);
    const bounds = getNodesWorldBounds(forkNodes)
      ?? getNodesWorldBounds(this.findStackerPlatformNodes(model));
    state.targetReferencePosition = bounds
      ? bounds.minimum.add(bounds.maximum).scale(0.5)
      : state.rootBasePosition.clone();
    return state.targetReferencePosition;
  }

  /** 写入堆垛机兼容 metadata，保留旧调试入口 stackerTelemetry。 */
  private writeStackerTelemetryMetadata(
    model: ModelRuntimeEntry,
    snapshot: StackerTelemetrySnapshot,
    targetLocator: LocatorRuntimeEntry | null,
  ): void {
    const frontForkStroke = this.getStackerForkStroke(model, 'front');
    const backForkStroke = this.getStackerForkStroke(model, 'back');
    const frontFork = this.splitForkOffset(model.stackerTelemetry.frontForkOffset, frontForkStroke);
    const backFork = this.splitForkOffset(model.stackerTelemetry.backForkOffset, backForkStroke);
    const telemetryMetadata = {
      assetCode: snapshot.assetCode,
      payloadDeviceCode: snapshot.payloadDeviceCode,
      sourceTimestamp: snapshot.sourceTimestamp,
      receivedAt: snapshot.receivedAt,
      currentLocationKey: snapshot.currentLocationKey,
      targetFound: Boolean(targetLocator),
      faulted: snapshot.faulted,
      message: snapshot.message,
      fields: snapshot.fields,
      forkReach: { front: frontForkStroke, back: backForkStroke },
      forkOffsets: {
        front: frontFork,
        back: backFork,
      },
    };

    model.root.metadata = {
      ...(model.root.metadata ?? {}),
      stackerTelemetry: telemetryMetadata,
    };
    model.contentRoot.metadata = {
      ...(model.contentRoot.metadata ?? {}),
      stackerTelemetry: telemetryMetadata,
    };
  }

  /** 对故障和状态变化做一次性 Console 提示，避免每帧刷屏。 */
  private reportStackerRuntimeState(snapshot: StackerTelemetrySnapshot): void {
    const deviceKey = `${snapshot.sourceId}:${snapshot.deviceType}:${snapshot.assetCode}`;
    const mode = readIntegerField(snapshot.fields, 'mode');
    const frontCommand = readIntegerField(snapshot.fields, 'front_command');
    const backCommand = readIntegerField(snapshot.fields, 'back_command');
    const statusSignature = JSON.stringify([mode, frontCommand, backCommand, snapshot.message]);
    if (this.state.reportedStatuses.get(deviceKey) !== statusSignature) {
      this.state.reportedStatuses.set(deviceKey, statusSignature);
      this.host.pushLog(
        `Stacker ${snapshot.assetCode} 状态：mode=${mode ?? '未知'}，front=${frontCommand ?? '未知'}，back=${backCommand ?? '未知'}${snapshot.message ? `，${snapshot.message}` : ''}`,
      );
    }

    if (!snapshot.faulted) {
      this.state.reportedFaults.delete(deviceKey);
      return;
    }

    const faultMessage = snapshot.message || `errorCode=${readIntegerField(snapshot.fields, 'errorCode') ?? 0}`;
    if (this.state.reportedFaults.get(deviceKey) === faultMessage) return;

    this.state.reportedFaults.set(deviceKey, faultMessage);
    this.host.pushLog(`Stacker ${snapshot.assetCode} 故障/急停：${faultMessage}`);
  }

  /** 将行走、升降和货叉伸缩合成为每个节点的一次性世界偏移，避免重叠节点被后续动作覆盖。 */
  private applyStackerNodeMotionOffsets(model: ModelRuntimeEntry): void {
    const state = model.stackerTelemetry;
    const travelPosition = state.rootPosition ?? state.rootBasePosition;
    const travelWorldOffset = travelPosition.subtract(state.rootBasePosition);
    const liftWorldOffset = getModelAxis(model.root, 'y').scale(state.liftOffset);
    const forkAxis = getModelAxis(model.root, 'x');
    const frontOffset = this.splitForkOffset(state.frontForkOffset, this.getStackerForkStroke(model, 'front'));
    const backOffset = this.splitForkOffset(state.backForkOffset, this.getStackerForkStroke(model, 'back'));
    const {
      frontStageOneNodes,
      frontStageTwoNodes,
      backStageOneNodes,
      backStageTwoNodes,
    } = this.findStackerForkNodeGroups(model);
    const offsets = new Map<TransformNode, Vector3>();

    this.addStackerWorldOffset(offsets, filterTopLevelMotionNodes(this.findStackerTravelNodes(model)), travelWorldOffset);
    this.addStackerWorldOffset(offsets, filterTopLevelMotionNodes(this.findStackerLiftNodes(model)), liftWorldOffset);
    this.addStackerForkStageOffsets(offsets, frontStageOneNodes, frontStageTwoNodes, forkAxis, frontOffset);
    this.addStackerForkStageOffsets(offsets, backStageOneNodes, backStageTwoNodes, forkAxis, backOffset);
    this.offsetNodesFromBaselineByWorldOffsets(model, offsets);
  }

  /** 将单侧货叉总偏移拆到一段/二段节点；没有二段节点时保持旧模型整体伸缩行为。 */
  private addStackerForkStageOffsets(
    offsets: Map<TransformNode, Vector3>,
    stageOneNodes: TransformNode[],
    stageTwoNodes: TransformNode[],
    forkAxis: Vector3,
    offset: StackerForkOffsetParts,
  ): void {
    if (stageTwoNodes.length === 0) {
      this.addStackerWorldOffset(offsets, filterTopLevelMotionNodes(stageOneNodes), forkAxis.scale(offset.totalOffset));
      return;
    }

    this.addStackerWorldOffset(offsets, filterTopLevelMotionNodes(stageOneNodes), forkAxis.scale(offset.stageOneOffset));
    this.addStackerWorldOffset(offsets, filterTopLevelMotionNodes(stageTwoNodes), forkAxis.scale(offset.totalOffset));
  }

  /** 查找随水平行走机构移动的节点；优先使用模型脚本 dataDriven 声明，缺失时回退当前 Stacker GLB 名称。 */
  private findStackerTravelNodes(model: ModelRuntimeEntry): TransformNode[] {
    const configuredNames = this.readStackerMotionNodeNames(model, 'travel');
    const configuredNodes = configuredNames.length > 0 ? findModelNodesByName(model, this.scene, configuredNames) : [];
    if (configuredNodes.length > 0) {
      const forkGroups = this.findStackerForkNodeGroups(model);
      return this.excludeStackerFixedNodes(model, uniqueTransformNodes([
        ...configuredNodes,
        ...forkGroups.frontStageTwoNodes,
        ...forkGroups.backStageTwoNodes,
      ]));
    }

    const exactNodes = findModelNodesByName(model, this.scene, STACKER_FALLBACK_TRAVEL_NODE_NAMES);
    if (exactNodes.length > 0) {
      return this.excludeStackerFixedNodes(model, exactNodes);
    }

    return this.excludeStackerFixedNodes(
      model,
      findModelNodes(
        model,
        this.scene,
        this.readStackerMotionFallbackPattern(model, 'travel', /dingbuhuagui|dingbu|dibu|lizhu|dianji|caozuotai|xiang|huocha|顶部|底部|立柱|电机|操作台|载货|货叉/i),
      ),
    );
  }

  /** 查找模型脚本声明或当前 GLB 中的固定轨道节点，水平遥测不会直接写入这些节点。 */
  private findStackerFixedNodes(model: ModelRuntimeEntry): TransformNode[] {
    const configuredNodes = findModelNodesByName(model, this.scene, this.readStackerFixedNodeNames(model));
    if (configuredNodes.length > 0) return configuredNodes;
    return findModelNodesByName(model, this.scene, STACKER_FALLBACK_FIXED_NODE_NAMES);
  }

  /** 从候选运动节点中剔除固定轨道节点，避免上下轨道被行走偏移带动。 */
  private excludeStackerFixedNodes(model: ModelRuntimeEntry, nodes: TransformNode[]): TransformNode[] {
    const fixedNodes = new Set(this.findStackerFixedNodes(model));
    return nodes.filter((node) => !fixedNodes.has(node));
  }

  /** 将行走虚拟位置限制在固定轨道范围内，避免目标位或编码器值把机体推出轨道端点。 */
  private constrainStackerTravelPosition(model: ModelRuntimeEntry, position: Vector3, travelAxis: Vector3): Vector3 {
    const state = model.stackerTelemetry;
    const projectedPosition = projectPointOntoAxis(state.rootBasePosition, travelAxis, position);
    const constraint = this.getStackerTravelConstraint(model, travelAxis);
    if (!constraint) return projectedPosition;

    const requestedDelta = Vector3.Dot(projectedPosition.subtract(state.rootBasePosition), constraint.axis);
    const minDelta = constraint.trackMin - constraint.movingMin;
    const maxDelta = constraint.trackMax - constraint.movingMax;
    const clampedDelta = minDelta <= maxDelta
      ? clampNumber(requestedDelta, minDelta, maxDelta)
      : (constraint.trackMin + constraint.trackMax - constraint.movingMin - constraint.movingMax) / 2;

    return state.rootBasePosition.add(constraint.axis.scale(clampedDelta));
  }

  /** 读取或创建 Stacker 轨道约束，固定轨道决定可行范围，行走机构基线决定端点余量。 */
  private getStackerTravelConstraint(model: ModelRuntimeEntry, travelAxis: Vector3): StackerTravelConstraint | null {
    const state = model.stackerTelemetry;
    if (state.travelConstraint && Vector3.Dot(state.travelConstraint.axis, travelAxis) > 0.999) {
      return state.travelConstraint;
    }

    const fixedBounds = getNodesProjectedBounds(this.findStackerFixedNodes(model), travelAxis);
    const movingBounds = getNodesProjectedBounds(this.findStackerTravelNodes(model), travelAxis);
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

  /** 查找载货台和货叉节点，升降时这两类部件需要一起动；优先使用模型脚本 dataDriven 声明。 */
  private findStackerLiftNodes(model: ModelRuntimeEntry): TransformNode[] {
    const configuredNames = this.readStackerMotionNodeNames(model, 'lift');
    const configuredNodes = configuredNames.length > 0 ? findModelNodesByName(model, this.scene, configuredNames) : [];
    if (configuredNodes.length > 0) return configuredNodes;

    return uniqueTransformNodes([
      ...this.findStackerPlatformNodes(model),
      ...this.findStackerForkNodeGroups(model).frontNodes,
      ...this.findStackerForkNodeGroups(model).backNodes,
    ]);
  }

  /** 将载货台升降偏移限制在配置行程与物理行程的交集内：配置读 dataDriven.motion.lift.limits，物理行程由整机框架与载货台基线投影得出；两者都不可用时保持 [0, +∞) 现行为。 */
  private clampStackerLiftOffset(model: ModelRuntimeEntry, offset: number): number {
    let min = this.readStackerDataDrivenNumber(model, ['motion', 'lift', 'limits', 'min']) ?? 0;
    let max = this.readStackerDataDrivenNumber(model, ['motion', 'lift', 'limits', 'max']) ?? Number.POSITIVE_INFINITY;
    const constraint = this.getStackerLiftConstraint(model);
    if (constraint) {
      const physicalMin = constraint.frameMin - constraint.movingMin;
      const physicalMax = constraint.frameMax - constraint.movingMax;
      if (physicalMin <= physicalMax) {
        min = Math.max(min, physicalMin);
        max = Math.min(max, physicalMax);
      }
    }
    return clampNumber(offset, Math.min(min, max), Math.max(min, max));
  }

  /** 读取或创建 Stacker 升降行程约束：整机移动框架（含立柱/顶部）决定可升范围，载货台与货叉基线决定端点余量。 */
  private getStackerLiftConstraint(model: ModelRuntimeEntry): StackerLiftConstraint | null {
    const state = model.stackerTelemetry;
    const upAxis = getModelAxis(model.root, 'y');
    if (state.liftConstraint && Vector3.Dot(state.liftConstraint.axis, upAxis) > 0.999) {
      return state.liftConstraint;
    }

    const frameBounds = getNodesProjectedBounds(this.findStackerTravelNodes(model), upAxis);
    const movingBounds = getNodesProjectedBounds(this.findStackerLiftNodes(model), upAxis);
    if (!frameBounds || !movingBounds) return null;

    state.liftConstraint = {
      axis: upAxis.clone(),
      frameMin: frameBounds.min,
      frameMax: frameBounds.max,
      movingMin: movingBounds.min,
      movingMax: movingBounds.max,
    };
    return state.liftConstraint;
  }

  /** 查找 stacker 载货台节点。 */
  private findStackerPlatformNodes(model: ModelRuntimeEntry): TransformNode[] {
    const namedNodes = findModelNodesByName(model, this.scene, ['xiang.13']);
    return namedNodes.length > 0
      ? namedNodes
      : findModelNodes(model, this.scene, this.readStackerMotionFallbackPattern(model, 'lift', /platform|cargo|bay|xiang|台|仓/i));
  }

  /**
   * 查找前后货叉节点：优先按模型脚本 dataDriven.motion.fork 的四个 stage 数组构建，
   * 缺失时回退到精确命名和正则探测链。
   * stage 数组是偏移驱动对象（一段得 stageOneOffset、二段得 totalOffset）；
   * 单侧无独立货叉节点时该侧 Nodes 回退到对侧并集（共享叉），
   * 使校准距离与货物跟随仍能解析到物理叉，且该侧 stage 为空不产生双重位移。
   */
  private findStackerForkNodeGroups(model: ModelRuntimeEntry): StackerForkNodeGroups {
    const configured = this.readStackerForkStageNodeNames(model);
    if (configured) {
      const frontStageOneNodes = findModelNodesByName(model, this.scene, configured.frontStageOne);
      const frontStageTwoNodes = findModelNodesByName(model, this.scene, configured.frontStageTwo);
      const backStageOneNodes = findModelNodesByName(model, this.scene, configured.backStageOne);
      const backStageTwoNodes = findModelNodesByName(model, this.scene, configured.backStageTwo);
      const frontNodes = uniqueTransformNodes([...frontStageOneNodes, ...frontStageTwoNodes]);
      const backNodes = uniqueTransformNodes([...backStageOneNodes, ...backStageTwoNodes]);
      return {
        frontNodes: frontNodes.length > 0 ? frontNodes : backNodes,
        backNodes: backNodes.length > 0 ? backNodes : frontNodes,
        frontStageOneNodes,
        frontStageTwoNodes,
        backStageOneNodes,
        backStageTwoNodes,
      };
    }

    // 当前 Stacker GLB：huocha2.10 为一段叉（得 stageOneOffset），huocha.9 为二段叉（得 totalOffset）；后叉与前叉共享
    const exactStageOneNodes = findModelNodesByName(model, this.scene, ['huocha2.10']);
    const exactStageTwoNodes = findModelNodesByName(model, this.scene, ['huocha.9']);
    if (exactStageOneNodes.length > 0 || exactStageTwoNodes.length > 0) {
      const frontNodes = uniqueTransformNodes([...exactStageOneNodes, ...exactStageTwoNodes]);
      return {
        frontNodes,
        backNodes: frontNodes,
        frontStageOneNodes: exactStageOneNodes,
        frontStageTwoNodes: exactStageTwoNodes,
        backStageOneNodes: [],
        backStageTwoNodes: [],
      };
    }

    const forkNodes = findModelNodes(model, this.scene, this.readStackerMotionFallbackPattern(model, 'fork', /fork|叉|huocha|cha\d*/i));
    const frontStageOneNodes = forkNodes.slice(0, 1);
    const backStageOneNodes = forkNodes.slice(1, 2);
    return {
      frontNodes: frontStageOneNodes,
      backNodes: backStageOneNodes,
      frontStageOneNodes,
      frontStageTwoNodes: [],
      backStageOneNodes,
      backStageTwoNodes: [],
    };
  }

  /** 读取模型脚本 dataDriven.motion.fork 声明的前后叉两段节点名，任一数组非空即视为完整配置。 */
  private readStackerForkStageNodeNames(
    model: ModelRuntimeEntry,
  ): { frontStageOne: string[]; frontStageTwo: string[]; backStageOne: string[]; backStageTwo: string[] } | null {
    for (const dataDriven of model.externalScriptRuntime?.getDataDrivenConfigs() ?? []) {
      const frontStageOne = readStringArrayPath(dataDriven, ['motion', 'fork', 'frontStageOneNodes']);
      const frontStageTwo = readStringArrayPath(dataDriven, ['motion', 'fork', 'frontStageTwoNodes']);
      const backStageOne = readStringArrayPath(dataDriven, ['motion', 'fork', 'backStageOneNodes']);
      const backStageTwo = readStringArrayPath(dataDriven, ['motion', 'fork', 'backStageTwoNodes']);
      if (frontStageOne.length > 0 || frontStageTwo.length > 0 || backStageOne.length > 0 || backStageTwo.length > 0) {
        return { frontStageOne, frontStageTwo, backStageOne, backStageTwo };
      }
    }

    return null;
  }

  /** 读取模型脚本 dataDriven.motion.<key>.nodes 中声明的节点名。 */
  private readStackerMotionNodeNames(model: ModelRuntimeEntry, motionKey: string): string[] {
    for (const dataDriven of model.externalScriptRuntime?.getDataDrivenConfigs() ?? []) {
      const nodes = readStringArrayPath(dataDriven, ['motion', motionKey, 'nodes']);
      if (nodes.length > 0) return nodes;
    }

    return [];
  }

  /** 读取模型脚本声明的兜底节点正则；配置缺失或编译失败时回退硬编码正则。 */
  private readStackerMotionFallbackPattern(model: ModelRuntimeEntry, motionKey: string, fallback: RegExp): RegExp {
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
  private readStackerFixedNodeNames(model: ModelRuntimeEntry): string[] {
    for (const dataDriven of model.externalScriptRuntime?.getDataDrivenConfigs() ?? []) {
      const nodes = readStringArrayPath(dataDriven, ['fixedNodes']);
      if (nodes.length > 0) return nodes;
    }

    return STACKER_FALLBACK_FIXED_NODE_NAMES;
  }

  /** 读取模型脚本 dataDriven 配置中的数值字段。 */
  private readStackerDataDrivenNumber(model: ModelRuntimeEntry, path: string[]): number | null {
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

  /** 累加一组节点的世界位移，后续统一转换到各自父级本地坐标。 */
  private addStackerWorldOffset(offsets: Map<TransformNode, Vector3>, nodes: TransformNode[], worldOffset: Vector3): void {
    for (const node of nodes) {
      const existing = offsets.get(node) ?? Vector3.Zero();
      offsets.set(node, existing.add(worldOffset));
    }
  }

  /** 按世界位移写回节点位置，兼容模型内容根节点的毫米缩放、旋转和父级层级。 */
  private offsetNodesFromBaselineByWorldOffsets(model: ModelRuntimeEntry, offsets: Map<TransformNode, Vector3>): void {
    for (const [node, worldOffset] of offsets) {
      const baseline = this.getTelemetryNodeBaseline(model, node);
      const localOffset = worldDeltaToParentLocalDelta(node, worldOffset);
      node.position = baseline.add(localOffset);
    }
  }

  /** 记录遥测动作前的节点基线位置。 */
  private getTelemetryNodeBaseline(model: ModelRuntimeEntry, node: TransformNode): Vector3 {
    const existing = model.stackerTelemetry.nodeBaselines.get(node);
    if (existing) return existing;

    const baseline = node.position.clone();
    model.stackerTelemetry.nodeBaselines.set(node, baseline);
    return baseline;
  }

  /** 使用 rpm 字段换算速度；没有有效 rpm 时回退 dataDriven.motion.<motionKey>.speed 或模型默认速度。 */
  private readSpeed(
    model: ModelRuntimeEntry,
    snapshot: StackerTelemetrySnapshot,
    rpmKey: string,
    motionKey: 'travel' | 'lift' | 'fork',
    fallbackSpeed: number,
  ): number {
    const defaultSpeed = this.readStackerDataDrivenNumber(model, ['motion', motionKey, 'speed']) ?? fallbackSpeed;
    const rpm = readNumberField(snapshot.fields, rpmKey);
    if (rpm === null || rpm <= 0) return defaultSpeed;
    const rpmScale = this.readStackerDataDrivenNumber(model, ['device', 'rpmToMetersPerSecond']) ?? STACKER_RPM_TO_METERS_PER_SECOND;
    return Math.max(defaultSpeed * 0.25, rpm * rpmScale);
  }
}
