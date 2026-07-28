import type { Scene } from '@babylonjs/core';
import { TransformNode, Vector3 } from '@babylonjs/core';
import type { StackerStorageTargetOffsets } from '../stackerStorageLocation';
import {
  resolveLocatorBoxIndex,
  resolveStackerStorageForkReach,
  resolveStackerStorageTargetOffsets,
} from '../stackerStorageLocation';
import {
  clampNumber,
  filterTopLevelMotionNodes,
  findModelNodes,
  findModelNodesByName,
  getHorizontalModelAxis,
  getMeshWorldBounds,
  getModelAxis,
  getNodesProjectedBounds,
  getNodesWorldBounds,
  getNodeWorldRotation,
  lerpNumber,
  lerpVector,
  moveNumberTowards,
  moveVectorTowards,
  projectPointOntoAxis,
  uniqueTransformNodes,
  worldDeltaToParentLocalDelta,
} from '../../runtimeNodeGeometry';
import { isPlainRecord, readStringArrayPath, sanitizeBabylonName } from '../../runtimeValueUtils';
import {
  readIntegerField,
  readNumberField,
  type StackerTelemetrySnapshot,
} from '../../../mqtt/deviceTelemetry';
import type { LocatorRuntimeEntry, ModelRuntimeEntry } from '../../SceneRuntime';
import { readContainerCode, writeDeviceTelemetryMetadata } from './telemetryMetadata';
import {
  type SpecializedTelemetryDriverContext,
  type SpecializedTelemetryHost,
  type SpecializedTelemetrySharedState,
  type StackerCargoRuntimeEntry,
  type StackerForkNodeGroups,
  type StackerForkOffsetParts,
  type StackerForkReachConfig,
  type StackerForkSide,
  type StackerTravelConstraint,
  STACKER_CALIBRATION_RATE,
  STACKER_DEFAULT_FORK_SPEED_METERS_PER_SECOND,
  STACKER_DEFAULT_LIFT_SPEED_METERS_PER_SECOND,
  STACKER_DEFAULT_TRAVEL_SPEED_METERS_PER_SECOND,
  STACKER_FALLBACK_FIXED_NODE_NAMES,
  STACKER_FALLBACK_TRAVEL_NODE_NAMES,
  STACKER_RPM_TO_METERS_PER_SECOND,
  STACKER_TARGET_SPEED_METERS_PER_SECOND,
  STACKER_CARGO_SIZE,
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

  /** 对单台 stacker 应用根节点、载货台和前后叉的遥测驱动。 */
  applyToModel(model: ModelRuntimeEntry, snapshot: StackerTelemetrySnapshot, deltaSeconds: number): void {
    const toX = readIntegerField(snapshot.fields, 'to_x');
    const toY = readIntegerField(snapshot.fields, 'to_y');
    const toZ = readIntegerField(snapshot.fields, 'to_z');
    const targetLocator = (snapshot.assetCode && toX !== null && toY !== null && toZ !== null)
      ? this.host.findLocatorByDevice(snapshot.assetCode, toX, toY, toZ)
      : snapshot.targetLocationKey
        ? this.host.getLocatorTarget(snapshot.targetLocationKey)
        : null;
    this.reportStackerRuntimeState(snapshot, targetLocator);
    writeDeviceTelemetryMetadata(model, snapshot);

    const targetPosition = targetLocator
      ? this.resolveStackerTargetPosition(targetLocator, snapshot.assetCode, toX, toY, toZ)
      : null;
    const targetOffsets = targetPosition ? this.resolveStackerTargetMotionOffsets(model, targetPosition) : null;
    this.reportStackerTargetProjection(model, targetLocator, targetPosition, targetOffsets, toX, toY);
    this.applyStackerRootMotion(model, snapshot, targetOffsets?.travelOffset ?? null, deltaSeconds);
    this.applyStackerLiftMotion(model, snapshot, targetOffsets?.liftOffset ?? null, deltaSeconds);
    this.applyStackerForkMotion(model, snapshot, targetPosition, deltaSeconds, targetLocator);
    this.applyStackerNodeMotionOffsets(model);
    this.applyStackerCargoMotion(model, snapshot, targetLocator, targetPosition);
    this.writeStackerTelemetryMetadata(model, snapshot, targetLocator);
  }

  /** 解析堆垛机运动目标：设备网格匹配路径精确到格口支撑位，assetId 直查保持定位框根节点语义。 */
  private resolveStackerTargetPosition(
    locator: LocatorRuntimeEntry,
    assetCode: string,
    toX: number | null,
    toY: number | null,
    toZ: number | null,
  ): Vector3 {
    const rootPosition = locator.root.getAbsolutePosition();
    if (!assetCode || toX === null || toY === null || toZ === null) return rootPosition;
    return this.resolveLocatorBoxSupportPosition(locator, toX, toY) ?? rootPosition;
  }

  /** 解析目标格口的支撑位世界坐标：水平取 box 中心、高度取 box 底面，越界时返回 null 由调用方回退。 */
  private resolveLocatorBoxSupportPosition(
    locator: LocatorRuntimeEntry,
    toX: number,
    toY: number,
  ): Vector3 | null {
    const boxIndex = resolveLocatorBoxIndex({
      startColumn: locator.startColumn,
      columns: locator.columns,
      layers: locator.layers,
      toX,
      toY,
    });
    const box = boxIndex === null ? null : locator.boxes[boxIndex];
    if (!box) {
      const reportKey = `${locator.assetId}:${toX}:${toY}`;
      if (!this.state.reportedInvalidStackerBoxTargets.has(reportKey)) {
        this.state.reportedInvalidStackerBoxTargets.add(reportKey);
        this.host.pushLog(`库位 ${locator.assetId} 不存在格口 列${toX} 层${toY}，已回退定位框根节点。`);
      }
      return null;
    }

    const bounds = getMeshWorldBounds(box);
    if (!bounds) return null;
    return new Vector3(
      (bounds.minimum.x + bounds.maximum.x) / 2,
      bounds.minimum.y,
      (bounds.minimum.z + bounds.maximum.z) / 2,
    );
  }

  /** 使用 locator 盒体底面作为生成模型原点，保证模型落在定位框内部而不是悬在中心高度。 */
  private getWarehouseLocatorSupportPosition(locator: LocatorRuntimeEntry): Vector3 {
    const bounds = locator.boxes.length > 0 ? getMeshWorldBounds(locator.boxes[0]) : null;
    const position = locator.root.getAbsolutePosition();
    return new Vector3(position.x, bounds?.minimum.y ?? position.y, position.z);
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

  /** 目标位变化时在 Console 打印一次行走/升降/货叉投影距离，便于联调核对格口级目标。 */
  private reportStackerTargetProjection(
    model: ModelRuntimeEntry,
    targetLocator: LocatorRuntimeEntry | null,
    targetPosition: Vector3 | null,
    targetOffsets: StackerStorageTargetOffsets | null,
    toX: number | null,
    toY: number | null,
  ): void {
    const signature = targetLocator && targetPosition
      ? `${targetLocator.assetId}:${toX}:${toY}:${targetPosition.x.toFixed(3)}:${targetPosition.y.toFixed(3)}:${targetPosition.z.toFixed(3)}`
      : 'none';
    if (this.state.lastReportedStackerTargetSignatures.get(model.assetCode) === signature) return;
    this.state.lastReportedStackerTargetSignatures.set(model.assetCode, signature);
    if (!targetLocator || !targetPosition || !targetOffsets) return;

    const forkAxis = getModelAxis(model.root, 'x');
    const referencePosition = this.getStackerTargetReferencePosition(model);
    const forkProjection = Math.abs(Vector3.Dot(targetPosition.subtract(referencePosition), forkAxis));
    const reach = this.readStackerForkReachConfig(model);
    const stageLabel = forkProjection > reach.stageOne + 0.001 ? '两段' : '一段';
    this.host.pushLog(
      `堆垛机 ${model.assetCode} 目标 ${targetLocator.assetId}（列${toX} 层${toY}）：` +
      `box 支撑位 (${targetPosition.x.toFixed(3)}, ${targetPosition.y.toFixed(3)}, ${targetPosition.z.toFixed(3)})，` +
      `行走投影偏移 ${targetOffsets.travelOffset.toFixed(3)}m，升降投影偏移 ${targetOffsets.liftOffset.toFixed(3)}m，` +
      `货叉投影距离 ${forkProjection.toFixed(3)}m（一段行程 ${reach.stageOne}m，判定${stageLabel}）。`,
    );
  }

  /** 根据 distance_x 校准行走机构虚拟位置，并在有目标位或 movement_x 时沿轨道推进。 */
  private applyStackerRootMotion(
    model: ModelRuntimeEntry,
    snapshot: StackerTelemetrySnapshot,
    targetTravelOffset: number | null,
    deltaSeconds: number,
  ): void {
    const state = model.stackerTelemetry;
    const travelAxis = getHorizontalModelAxis(model.root, 'z');
    state.rootPosition ??= state.rootBasePosition.clone();

    const distanceX = readNumberField(snapshot.fields, 'distance_x');
    if (distanceX !== null && targetTravelOffset === null) {
      const calibratedPosition = state.rootBasePosition.add(travelAxis.scale(distanceX));
      state.rootPosition = lerpVector(
        state.rootPosition,
        this.constrainStackerTravelPosition(model, calibratedPosition, travelAxis),
        this.getCalibrationAlpha(deltaSeconds),
      );
    }

    if (!snapshot.faulted) {
      if (targetTravelOffset !== null) {
        const rootTargetPosition = this.constrainStackerTravelPosition(
          model,
          state.rootBasePosition.add(travelAxis.scale(targetTravelOffset)),
          travelAxis,
        );
        const forkMoving = (readIntegerField(snapshot.fields, 'front_movement_z') ?? 0) !== 0
          || (readIntegerField(snapshot.fields, 'back_movement_z') ?? 0) !== 0;
        if (forkMoving) {
          state.rootPosition = rootTargetPosition;
        } else {
          state.rootPosition = moveVectorTowards(
            state.rootPosition,
            rootTargetPosition,
            STACKER_TARGET_SPEED_METERS_PER_SECOND * deltaSeconds,
          );
        }
      } else {
        const direction = this.readTravelDirection(readIntegerField(snapshot.fields, 'movement_x'));
        const speed = this.readSpeed(snapshot, 'rpm_x', STACKER_DEFAULT_TRAVEL_SPEED_METERS_PER_SECOND);
        if (direction !== 0) {
          state.rootPosition = state.rootPosition.add(travelAxis.scale(direction * speed * deltaSeconds));
        }
      }
    }

    state.rootPosition = this.constrainStackerTravelPosition(model, state.rootPosition, travelAxis);
  }

  /** 根据 distance_y 校准载货台高度，并按目标位层高或 movement_y 推进升降。 */
  private applyStackerLiftMotion(
    model: ModelRuntimeEntry,
    snapshot: StackerTelemetrySnapshot,
    targetLiftOffset: number | null,
    deltaSeconds: number,
  ): void {
    const state = model.stackerTelemetry;
    const distanceY = readNumberField(snapshot.fields, 'distance_y');
    if (distanceY !== null && targetLiftOffset === null) {
      state.liftOffset = lerpNumber(state.liftOffset, distanceY, this.getCalibrationAlpha(deltaSeconds));
    }

    if (!snapshot.faulted) {
      if (targetLiftOffset !== null) {
        const forkMoving = (readIntegerField(snapshot.fields, 'front_movement_z') ?? 0) !== 0
          || (readIntegerField(snapshot.fields, 'back_movement_z') ?? 0) !== 0;
        if (forkMoving) {
          state.liftOffset = targetLiftOffset;
        } else {
          state.liftOffset = moveNumberTowards(
            state.liftOffset,
            targetLiftOffset,
            STACKER_DEFAULT_LIFT_SPEED_METERS_PER_SECOND * deltaSeconds,
          );
        }
      } else {
        const direction = this.readLiftDirection(readIntegerField(snapshot.fields, 'movement_y'));
        const speed = this.readSpeed(snapshot, 'rpm_y', STACKER_DEFAULT_LIFT_SPEED_METERS_PER_SECOND);
        state.liftOffset = Math.max(0, state.liftOffset + direction * speed * deltaSeconds);
      }
    }
  }

  /** 根据前后叉编码值和 movement_z 信号分别驱动两组货叉伸缩。 */
  private applyStackerForkMotion(
    model: ModelRuntimeEntry,
    snapshot: StackerTelemetrySnapshot,
    targetPosition: Vector3 | null,
    deltaSeconds: number,
    targetLocator: LocatorRuntimeEntry | null,
  ): void {
    const frontMovement = readIntegerField(snapshot.fields, 'front_movement_z');
    const backMovement = readIntegerField(snapshot.fields, 'back_movement_z');
    const frontForkSpeed = this.readSpeed(snapshot, 'front_rpm_z', STACKER_DEFAULT_FORK_SPEED_METERS_PER_SECOND);
    const backForkSpeed = this.readSpeed(snapshot, 'back_rpm_z', STACKER_DEFAULT_FORK_SPEED_METERS_PER_SECOND);
    const reach = this.readStackerForkReachConfig(model);
    const targetForkReach = snapshot.hasTargetLocation && targetLocator
      ? resolveStackerStorageForkReach(targetLocator.storageDepth, reach.stageOne, reach.stageTwo)
      : null;
    const state = model.stackerTelemetry;

    state.frontForkOffset = this.updateForkOffset(
      state.frontForkOffset,
      this.resolveForkCalibrationDistance(
        model,
        'front',
        targetPosition,
        this.resolveTargetLocatorForkDistance(targetForkReach, frontMovement),
      ),
      frontMovement,
      frontForkSpeed,
      targetForkReach ?? reach.total,
      deltaSeconds,
      snapshot.faulted,
      (direction) => {
        state.frontForkDirection = direction;
      },
      state.frontForkDirection,
    );
    state.backForkOffset = this.updateForkOffset(
      state.backForkOffset,
      this.resolveForkCalibrationDistance(
        model,
        'back',
        targetPosition,
        this.resolveTargetLocatorForkDistance(targetForkReach, backMovement),
      ),
      backMovement,
      backForkSpeed,
      targetForkReach ?? reach.total,
      deltaSeconds,
      snapshot.faulted,
      (direction) => {
        state.backForkDirection = direction;
      },
      state.backForkDirection,
    );
  }

  /** 更新单侧货叉偏移：编码器/目标投影优先校准，movement_z 只在没有距离时兜底。 */
  private updateForkOffset(
    currentOffset: number,
    distance: number | null,
    movement: number | null,
    speed: number,
    maxReach: number,
    deltaSeconds: number,
    faulted: boolean,
    rememberDirection: (direction: number) => void,
    lastDirection: number,
  ): number {
    let nextOffset = currentOffset;
    const movementDirection = this.readForkDirection(movement, nextOffset);
    if (movementDirection === 1 || movementDirection === -1) rememberDirection(movementDirection);

    if (distance !== null) {
      const calibrationDirection = Math.sign(distance) || Math.sign(nextOffset) || lastDirection || 1;
      nextOffset = lerpNumber(
        nextOffset,
        clampNumber(Math.abs(distance), 0, maxReach) * calibrationDirection,
        this.getCalibrationAlpha(deltaSeconds),
      );
      return this.clampForkOffset(nextOffset, maxReach);
    }

    if (faulted) return this.clampForkOffset(nextOffset, maxReach);

    if (movement === 2 || movement === 4) {
      return moveNumberTowards(this.clampForkOffset(nextOffset, maxReach), 0, speed * deltaSeconds);
    }

    return this.clampForkOffset(nextOffset + movementDirection * speed * deltaSeconds, maxReach);
  }

  /** 读取模型脚本中的两段货叉行程配置，Inspector 参数优先于 dataDriven 默认值。 */
  private readStackerForkReachConfig(model: ModelRuntimeEntry): StackerForkReachConfig {
    const stageOne = this.readPositiveStackerModelNumber(
      model,
      'forkStageOneReach',
      this.readStackerDataDrivenNumber(model, ['motion', 'fork', 'stageOneReach']) ?? 0.8,
    );
    const stageTwo = this.readNonNegativeStackerModelNumber(
      model,
      'forkStageTwoReach',
      this.readStackerDataDrivenNumber(model, ['motion', 'fork', 'stageTwoReach']) ?? 0.8,
    );

    return {
      stageOne,
      stageTwo,
      total: Math.max(0, stageOne + stageTwo),
    };
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

  /** 按目标定位框在模型局部 X 轴上的投影计算伸出距离，符号表示方向。 */
  private resolveForkCalibrationDistance(
    model: ModelRuntimeEntry,
    side: StackerForkSide,
    targetPosition: Vector3 | null,
    targetForkDistance: number | null,
  ): number | null {
    if (!targetPosition) return null;

    const forkGroups = this.findStackerForkNodeGroups(model);
    const candidateNodes = side === 'front'
      ? [forkGroups.frontStageOneNodes, forkGroups.frontStageTwoNodes, forkGroups.frontNodes]
      : [forkGroups.backStageOneNodes, forkGroups.backStageTwoNodes, forkGroups.backNodes];
    const forkBounds = getNodesWorldBounds(candidateNodes.find((n) => n.length > 0) ?? []);
    if (!forkBounds) return null;

    const forkCenter = forkBounds.minimum.add(forkBounds.maximum).scale(0.5);
    const forkAxis = getModelAxis(model.root, 'x');
    const projectedDistance = Vector3.Dot(targetPosition.subtract(forkCenter), forkAxis);
    if (!Number.isFinite(projectedDistance)) return null;

    if (targetForkDistance !== null) return Math.sign(projectedDistance) * targetForkDistance;
    return projectedDistance;
  }

  /** 根据 MQTT 动作信号或目标库位返回货叉伸出/归零距离。 */
  private resolveTargetLocatorForkDistance(targetForkReach: number | null, movement: number | null): number | null {
    if (targetForkReach === null) return null;
    if (movement === 2 || movement === 4) return 0;
    if (movement === 1 || movement === 3) return targetForkReach;
    if (targetForkReach > 0) return targetForkReach;
    return null;
  }

  /** 从 Stacker 脚本 metadata 或当前参数值读取正数参数。 */
  private readPositiveStackerModelNumber(model: ModelRuntimeEntry, key: string, fallback: number): number {
    const value = this.readStackerModelNumber(model, key);
    return value !== null && value > 0 ? value : fallback;
  }

  /** 从 Stacker 脚本 metadata 或当前参数值读取非负参数。 */
  private readNonNegativeStackerModelNumber(model: ModelRuntimeEntry, key: string, fallback: number): number {
    const value = this.readStackerModelNumber(model, key);
    return value !== null && value >= 0 ? value : fallback;
  }

  /** 读取模型脚本 values 中的数值字段。 */
  private readStackerModelNumber(model: ModelRuntimeEntry, key: string): number | null {
    const scripts = Array.isArray(model.contentRoot.metadata?.scripts) ? model.contentRoot.metadata.scripts : [];
    for (const script of scripts) {
      if (!isPlainRecord(script)) continue;
      const values = isPlainRecord(script.values) ? script.values : {};
      const rawValue = this.readWrappedNumber(values[key]);
      if (rawValue !== null) return rawValue;
    }

    return null;
  }

  /** 读取模型脚本 dataDriven 配置中的数值字段。 */
  private readStackerDataDrivenNumber(model: ModelRuntimeEntry, path: string[]): number | null {
    for (const dataDriven of model.externalScriptRuntime?.getDataDrivenConfigs() ?? []) {
      const value = this.readNumberPath(dataDriven, path);
      if (value !== null) return value;
    }

    return null;
  }

  /** 兼容 meta.json 中 { value } 包装和普通数值。 */
  private readWrappedNumber(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (isPlainRecord(value)) {
      const nestedValue = value.value ?? value.currentValue ?? value.defaultValue;
      if (typeof nestedValue === 'number' && Number.isFinite(nestedValue)) return nestedValue;
    }
    return null;
  }

  /** 根据前叉/后叉托盘条码驱动货物：取货时随叉运动，放货时进入目标定位线框。 */
  private applyStackerCargoMotion(
    model: ModelRuntimeEntry,
    snapshot: StackerTelemetrySnapshot,
    targetLocator: LocatorRuntimeEntry | null,
    targetPosition: Vector3 | null,
  ): void {
    const frontContainerCode = readContainerCode(snapshot, 'front_containerCode');
    const backContainerCode = readContainerCode(snapshot, 'back_containerCode');

    this.applyStackerForkCargoMotion(model, snapshot, targetLocator, targetPosition, 'front', frontContainerCode);
    this.applyStackerForkCargoMotion(model, snapshot, targetLocator, targetPosition, 'back', backContainerCode);
  }

  /** 让指定货叉上的托盘在叉尖和目标 locator 之间运动，放货完成后留在 locator 内。 */
  private applyStackerForkCargoMotion(
    model: ModelRuntimeEntry,
    snapshot: StackerTelemetrySnapshot,
    targetLocator: LocatorRuntimeEntry | null,
    targetPosition: Vector3 | null,
    side: StackerForkSide,
    containerCode: string | null,
  ): void {
    const command = readIntegerField(snapshot.fields, side === 'front' ? 'front_command' : 'back_command');
    const previousForkCode = this.getStackerForkCargoCode(model, side);
    const activeContainerCode = this.resolveStackerForkCargoCode(model, side, containerCode, command, targetLocator);
    if (!activeContainerCode) return;

    // 取货完成沿检测：新条码上叉且当前位是 fetch 驱动定位线框时，触发该排单排同步
    if (activeContainerCode !== previousForkCode && (command === 1 || command === 2) && snapshot.currentLocationKey) {
      const sourceLocator = this.host.getLocatorTarget(snapshot.currentLocationKey);
      const fetchRow = sourceLocator ? this.host.resolveFetchDriveRowForLocator(sourceLocator) : null;
      if (fetchRow !== null) this.host.handleFetchRowSync(fetchRow);
    }

    const cargo = this.getOrCreateStackerCargo(model.assetCode, activeContainerCode);
    cargo.placedLocatorKey = null;
    this.host.syncGeneratedCargoVisual(cargo, 'stacker', snapshot, this.host.resolveCargoGeneratorForModel(model));
    const forkPosition = this.getStackerForkCargoPosition(model, side);
    const supportPosition = targetLocator
      ? targetPosition ?? this.getWarehouseLocatorSupportPosition(targetLocator)
      : null;
    const reach = this.readStackerForkReachConfig(model);
    const placingProgress = this.getStackerCargoPlacingProgress(command, side === 'front'
      ? model.stackerTelemetry.frontForkOffset
      : model.stackerTelemetry.backForkOffset, reach);
    const nextPosition = supportPosition && placingProgress > 0
      ? lerpVector(forkPosition, supportPosition, placingProgress)
      : forkPosition;

    const nextRotation = targetLocator && placingProgress >= 1
      ? getNodeWorldRotation(targetLocator.root)
      : getNodeWorldRotation(model.root);
    this.host.setGeneratedCargoRootPose(cargo, nextPosition, nextRotation);
    if (supportPosition && placingProgress >= 1 && snapshot.targetLocationKey) {
      const fetchRow = targetLocator ? this.host.resolveFetchDriveRowForLocator(targetLocator) : null;
      if (fetchRow === null) {
        cargo.placedLocatorKey = snapshot.targetLocationKey;
      } else if (this.host.keepCargoForFetchRowSync(fetchRow, model.assetCode, activeContainerCode)) {
        // fetch 驱动定位线框的库位货物由 fetch 数据唯一渲染：MQTT 货箱保留到单排同步响应应用时再销毁
        this.host.handleFetchRowSync(fetchRow);
      }
      this.setStackerForkCargoCode(model, side, null);
    }
  }

  /** 在条码清空但仍处于放货命令时，沿用上一帧货物编号完成落位。 */
  private resolveStackerForkCargoCode(
    model: ModelRuntimeEntry,
    side: StackerForkSide,
    containerCode: string | null,
    command: number | null,
    targetLocator: LocatorRuntimeEntry | null,
  ): string | null {
    if (containerCode) {
      const previousContainerCode = this.getStackerForkCargoCode(model, side);
      if (previousContainerCode && previousContainerCode !== containerCode) {
        this.disposeUnplacedStackerCargo(model.assetCode, previousContainerCode);
      }
      this.setStackerForkCargoCode(model, side, containerCode);
      return containerCode;
    }

    const previousContainerCode = this.getStackerForkCargoCode(model, side);
    if (previousContainerCode && targetLocator && this.isStackerCargoPlacingCommand(command)) {
      return previousContainerCode;
    }

    this.setStackerForkCargoCode(model, side, null);
    return null;
  }

  /** 判断当前货叉状态是否正在把货物交接到目标定位框。 */
  private isStackerCargoPlacingCommand(command: number | null): boolean {
    return command === 3 || command === 4 || command === 5;
  }

  /** 货物跟随最远段叉节点包围盒中心，确保始终定位在货叉实际伸出位置而非全部叉节点几何中心。 */
  private getStackerForkCargoPosition(model: ModelRuntimeEntry, side: StackerForkSide): Vector3 {
    const forkGroups = this.findStackerForkNodeGroups(model);
    const stageTwoNodes = side === 'front' ? forkGroups.frontStageTwoNodes : forkGroups.backStageTwoNodes;
    const allNodes = side === 'front' ? forkGroups.frontNodes : forkGroups.backNodes;
    const nodes = stageTwoNodes.length > 0 ? stageTwoNodes : allNodes;
    const bounds = getNodesWorldBounds(nodes);
    if (!bounds) return model.root.getAbsolutePosition();

    const upAxis = getModelAxis(model.root, 'y');
    const legacyCenter = bounds.minimum
      .add(bounds.maximum)
      .scale(0.5)
      .add(upAxis.scale(STACKER_CARGO_SIZE.y * 0.75));
    return legacyCenter.subtract(upAxis.scale(STACKER_CARGO_SIZE.y / 2));
  }

  /** 放货中逐步进入目标框，放货完成时完全落入目标框。 */
  private getStackerCargoPlacingProgress(command: number | null, forkOffset: number, reach: StackerForkReachConfig): number {
    if (command === 5) return 1;
    if (command === 4) return 0.85;
    if (command === 3) return Math.max(0.45, Math.min(0.95, Math.abs(forkOffset) / Math.max(0.1, reach.total)));
    return 0;
  }

  /** 读取某侧货叉当前正在携带或放货中的托盘编号。 */
  private getStackerForkCargoCode(model: ModelRuntimeEntry, side: StackerForkSide): string | null {
    return side === 'front' ? model.stackerTelemetry.frontCargoCode : model.stackerTelemetry.backCargoCode;
  }

  /** 更新某侧货叉当前货物编号，只保存运行时内存状态。 */
  private setStackerForkCargoCode(model: ModelRuntimeEntry, side: StackerForkSide, containerCode: string | null): void {
    if (side === 'front') {
      model.stackerTelemetry.frontCargoCode = containerCode;
      return;
    }

    model.stackerTelemetry.backCargoCode = containerCode;
  }

  /** 清理还没有落位的旧货物，避免条码切换后遗留在叉尖半路。 */
  private disposeUnplacedStackerCargo(assetCode: string, containerCode: string): void {
    const key = this.getStackerCargoKey(assetCode, containerCode);
    const cargo = this.state.stackerCargoMeshes.get(key);
    if (!cargo || cargo.placedLocatorKey) return;

    this.disposeStackerCargo(cargo);
    this.state.stackerCargoMeshes.delete(key);
  }

  /** 创建或复用某个条码的堆垛机运行时货物。 */
  getOrCreateStackerCargo(assetCode: string, containerCode: string): StackerCargoRuntimeEntry {
    const key = this.getStackerCargoKey(assetCode, containerCode);
    const existing = this.state.stackerCargoMeshes.get(key);
    if (existing) return existing;

    const root = new TransformNode(
      `stacker_cargo_root_${sanitizeBabylonName(assetCode)}_${sanitizeBabylonName(containerCode)}`,
      this.scene,
    );
    const entry: StackerCargoRuntimeEntry = {
      assetCode,
      containerCode,
      root,
      outputOwner: null,
      fallback: null,
      generatorEntityId: null,
      placedLocatorKey: null,
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

  /** 生成堆垛机运行时货物的无歧义唯一键，允许设备编号和条码包含任意分隔符。 */
  getStackerCargoKey(assetCode: string, containerCode: string): string {
    return JSON.stringify([assetCode, containerCode]);
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
    const forkReach = this.readStackerForkReachConfig(model);
    const frontFork = this.splitForkOffset(model.stackerTelemetry.frontForkOffset, forkReach);
    const backFork = this.splitForkOffset(model.stackerTelemetry.backForkOffset, forkReach);
    const telemetryMetadata = {
      assetCode: snapshot.assetCode,
      payloadDeviceCode: snapshot.payloadDeviceCode,
      sourceTimestamp: snapshot.sourceTimestamp,
      receivedAt: snapshot.receivedAt,
      currentLocationKey: snapshot.currentLocationKey,
      targetLocationKey: snapshot.targetLocationKey,
      targetFound: Boolean(targetLocator),
      hasTargetLocation: snapshot.hasTargetLocation,
      faulted: snapshot.faulted,
      message: snapshot.message,
      fields: snapshot.fields,
      forkReach,
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

  /** 对故障和目标位缺失做一次性 Console 提示，避免每帧刷屏。 */
  private reportStackerRuntimeState(snapshot: StackerTelemetrySnapshot, targetLocator: LocatorRuntimeEntry | null): void {
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

    if (snapshot.hasTargetLocation && !targetLocator && snapshot.targetLocationKey) {
      const missingTargetKey = `${deviceKey}:${snapshot.targetLocationKey}`;
      if (!this.state.reportedMissingTargets.has(missingTargetKey)) {
        this.state.reportedMissingTargets.add(missingTargetKey);
        this.host.pushLog(`Stacker ${snapshot.assetCode} 未找到目标定位线框：${snapshot.targetLocationKey}`);
      }
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
    const forkReach = this.readStackerForkReachConfig(model);
    const frontOffset = this.splitForkOffset(state.frontForkOffset, forkReach);
    const backOffset = this.splitForkOffset(state.backForkOffset, forkReach);
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
    this.setStackerForkStageTwoNodesEnabled(frontStageTwoNodes, Math.abs(frontOffset.stageTwoOffset) > 0.001);
    this.setStackerForkStageTwoNodesEnabled(backStageTwoNodes, Math.abs(backOffset.stageTwoOffset) > 0.001);
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

  /** 第二段收纳时隐藏克隆件，避免与第一段重叠产生闪烁；非 _stage2 标记的节点不参与显隐切换。 */
  private setStackerForkStageTwoNodesEnabled(nodes: TransformNode[], enabled: boolean): void {
    for (const node of nodes) {
      if (!this.isStackerForkStageTwoNode(node)) continue;
      node.setEnabled(enabled);
    }
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
      findModelNodes(model, this.scene, /dingbuhuagui|dingbu|dibu|lizhu|dianji|caozuotai|xiang|huocha|顶部|底部|立柱|电机|操作台|载货|货叉/i),
    );
  }

  /** 查找模型脚本声明或当前 GLB 中的固定轨道节点，水平遥测不会直接写入这些节点。 */
  private findStackerFixedNodes(model: ModelRuntimeEntry): TransformNode[] {
    const configuredNodes = findModelNodesByName(model, this.scene, this.readStackerFixedNodeNames(model));
    if (configuredNodes.length > 0) return configuredNodes;
    return findModelNodesByName(model, this.scene, STACKER_FALLBACK_FIXED_NODE_NAMES);
  }

  /** 从候选运动节点中剔除固定轨道节点，避免上下轨道被 movement_x 带动。 */
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

  /** 查找载货台和货叉节点，升降时这两类部件需要一起动。 */
  private findStackerLiftNodes(model: ModelRuntimeEntry): TransformNode[] {
    return uniqueTransformNodes([
      ...this.findStackerPlatformNodes(model),
      ...this.findStackerForkNodeGroups(model).frontNodes,
      ...this.findStackerForkNodeGroups(model).backNodes,
    ]);
  }

  /** 查找 stacker 载货台节点。 */
  private findStackerPlatformNodes(model: ModelRuntimeEntry): TransformNode[] {
    const namedNodes = findModelNodesByName(model, this.scene, ['xiang.13']);
    return namedNodes.length > 0 ? namedNodes : findModelNodes(model, this.scene, /platform|cargo|bay|xiang|台|仓/i);
  }

  /** 查找前后货叉节点，精确命名优先，名称变化时按顺序兜底。 */
  private findStackerForkNodeGroups(model: ModelRuntimeEntry): StackerForkNodeGroups {
    const exactFrontStageOneNodes = findModelNodesByName(model, this.scene, ['huocha.9']).filter((node) => !this.isStackerForkStageTwoNode(node));
    const exactBackStageOneNodes = findModelNodesByName(model, this.scene, ['huocha2.10']).filter((node) => !this.isStackerForkStageTwoNode(node));
    const exactFrontStageTwoNodes = findModelNodesByName(model, this.scene, ['huocha.9_stage2']);
    const exactBackStageTwoNodes = findModelNodesByName(model, this.scene, ['huocha2.10_stage2']);
    if (exactFrontStageOneNodes.length > 0 || exactBackStageOneNodes.length > 0) {
      const hasStageTwoClones = exactFrontStageTwoNodes.length > 0 || exactBackStageTwoNodes.length > 0;
      if (!hasStageTwoClones) {
        // 无 _stage2 克隆件：huocha.9 两段都参与得 totalOffset，huocha2.10 只参与一段得 stageOneOffset
        const frontMainNodes = exactFrontStageOneNodes;
        const frontAuxNodes = exactBackStageOneNodes;
        return {
          frontNodes: uniqueTransformNodes([...frontMainNodes, ...frontAuxNodes]),
          backNodes: uniqueTransformNodes([...frontMainNodes, ...frontAuxNodes]),
          frontStageOneNodes: frontAuxNodes,
          frontStageTwoNodes: frontMainNodes,
          backStageOneNodes: [],
          backStageTwoNodes: [],
        };
      }
      return {
        frontNodes: uniqueTransformNodes([...exactFrontStageOneNodes, ...exactFrontStageTwoNodes]),
        backNodes: uniqueTransformNodes([...exactBackStageOneNodes, ...exactBackStageTwoNodes]),
        frontStageOneNodes: exactFrontStageOneNodes,
        frontStageTwoNodes: exactFrontStageTwoNodes,
        backStageOneNodes: exactBackStageOneNodes,
        backStageTwoNodes: exactBackStageTwoNodes,
      };
    }

    const forkNodes = findModelNodes(model, this.scene, /fork|叉|huocha|cha\d*/i);
    const stageOneNodes = forkNodes.filter((node) => !this.isStackerForkStageTwoNode(node));
    const stageTwoNodes = forkNodes.filter((node) => this.isStackerForkStageTwoNode(node));
    const frontStageOneNodes = stageOneNodes.slice(0, 1);
    const backStageOneNodes = stageOneNodes.slice(1, 2);
    return {
      frontNodes: uniqueTransformNodes([...frontStageOneNodes, ...stageTwoNodes.filter((node) => this.readStackerForkSide(node) === 'front')]),
      backNodes: uniqueTransformNodes([...backStageOneNodes, ...stageTwoNodes.filter((node) => this.readStackerForkSide(node) === 'back')]),
      frontStageOneNodes,
      frontStageTwoNodes: stageTwoNodes.filter((node) => this.readStackerForkSide(node) === 'front'),
      backStageOneNodes,
      backStageTwoNodes: stageTwoNodes.filter((node) => this.readStackerForkSide(node) === 'back'),
    };
  }

  /** 判断节点是否为参数脚本生成的第二段货叉。 */
  private isStackerForkStageTwoNode(node: TransformNode): boolean {
    const metadata = isPlainRecord(node.metadata) ? node.metadata : {};
    return metadata.stackerForkStage === 2 || String(node.name ?? '').endsWith('_stage2');
  }

  /** 读取第二段货叉所属侧，元数据缺失时按节点名称兜底。 */
  private readStackerForkSide(node: TransformNode): StackerForkSide | null {
    const metadata = isPlainRecord(node.metadata) ? node.metadata : {};
    if (metadata.stackerForkSide === 'front' || metadata.stackerForkSide === 'back') return metadata.stackerForkSide;
    const name = String(node.name ?? '').toLowerCase();
    if (name.includes('huocha2') || name.includes('back')) return 'back';
    if (name.includes('huocha') || name.includes('front')) return 'front';
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

  /** 读取模型脚本 dataDriven.fixedNodes 中声明的固定节点名。 */
  private readStackerFixedNodeNames(model: ModelRuntimeEntry): string[] {
    for (const dataDriven of model.externalScriptRuntime?.getDataDrivenConfigs() ?? []) {
      const nodes = readStringArrayPath(dataDriven, ['fixedNodes']);
      if (nodes.length > 0) return nodes;
    }

    return STACKER_FALLBACK_FIXED_NODE_NAMES;
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

  /** movement_x：0 静止，1 前进，2 后退。 */
  private readTravelDirection(value: number | null): number {
    if (value === 1) return 1;
    if (value === 2) return -1;
    return 0;
  }

  /** movement_y：0 原位，1 上升，2 下降。 */
  private readLiftDirection(value: number | null): number {
    if (value === 1) return 1;
    if (value === 2) return -1;
    return 0;
  }

  /** movement_z：1 右伸，2 左缩，3 左伸，4 右缩。 */
  private readForkDirection(value: number | null, currentOffset: number): number {
    if (value === 1) return 1;
    if (value === 3) return -1;
    if (value === 2 || value === 4) return currentOffset === 0 ? 0 : -Math.sign(currentOffset);
    return 0;
  }

  /** 使用 rpm 字段换算速度；没有有效 rpm 时回退模型默认速度。 */
  private readSpeed(snapshot: StackerTelemetrySnapshot, rpmKey: string, fallbackSpeed: number): number {
    const rpm = readNumberField(snapshot.fields, rpmKey);
    if (rpm === null || rpm <= 0) return fallbackSpeed;
    return Math.max(fallbackSpeed * 0.25, rpm * STACKER_RPM_TO_METERS_PER_SECOND);
  }

  /** 根据帧时间计算编码器校准插值权重。 */
  private getCalibrationAlpha(deltaSeconds: number): number {
    return Math.min(1, Math.max(0, deltaSeconds * STACKER_CALIBRATION_RATE));
  }
}
