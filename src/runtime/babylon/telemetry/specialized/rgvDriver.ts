import type { Scene } from '@babylonjs/core';
import { Quaternion, TransformNode, Vector3 } from '@babylonjs/core';
import {
  clampNumber,
  filterTopLevelMotionNodes,
  findModelNodes,
  findModelNodesByName,
  getHorizontalModelAxis,
  getModelTransformNodes,
  getNodesProjectedBounds,
  getNodesWorldBounds,
  getNodeWorldRotation,
  moveVectorTowards,
  projectPointOntoAxis,
  projectWorldBoundsOntoAxis,
  worldDeltaToParentLocalDelta,
} from '../../runtimeNodeGeometry';
import { isPlainRecord, readStringArrayPath, sanitizeBabylonName } from '../../runtimeValueUtils';
import { readIntegerField, readStringField, type DeviceTelemetrySnapshot } from '../../../mqtt/deviceTelemetry';
import type { ModelRuntimeEntry } from '../../SceneRuntime';
import { writeDeviceTelemetryMetadata } from './telemetryMetadata';
import {
  createCargoHandoffState,
  normalizeCargoTask,
  resolveCargoHandoffPose,
  type RgvCargoRuntimeEntry,
  type RgvForkSide,
  type RgvTravelConstraint,
  RGV_CARGO_TRANSFER_SECONDS,
  RGV_DEFAULT_TRAVEL_SPEED_METERS_PER_SECOND,
  RGV_FALLBACK_FIXED_NODE_PATTERN,
  type SpecializedTelemetryDriverContext,
  type SpecializedTelemetryHost,
  type SpecializedTelemetrySharedState,
} from './types';

/**
 * RGV（有轨穿梭车）遥测驱动：列号(front_y/back_y) → 列绑定实体投影定位车体；
 * movement_z 起转边沿锁定交接列，command 决定取货(列→车)/放货(车→列)方向。
 * 协议无完成码，command 回落 0 作为完成兜底；
 * task（front_task/back_task）只参与全局货物唯一接管（同 task 货箱实例移交本机），不参与本机流程。
 */
export class RgvTelemetryDriver {
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

  /** 对单台 RGV 应用车体行走和前后工位货箱交接的遥测驱动。 */
  applyToModel(model: ModelRuntimeEntry, snapshot: DeviceTelemetrySnapshot, deltaSeconds: number): void {
    this.reportRgvRuntimeState(snapshot);
    writeDeviceTelemetryMetadata(model, snapshot);
    this.applyRgvTravelMotion(model, snapshot, deltaSeconds);
    this.applyRgvNodeMotionOffsets(model);
    this.applyRgvForkCargoMotion(model, snapshot, 'front', deltaSeconds);
    this.applyRgvForkCargoMotion(model, snapshot, 'back', deltaSeconds);
  }

  // ===== 车体行走 =====

  /** 列信号驱动车体沿行走轴（模型局部 Z）移动；command 活动期间以活动侧列号为准。 */
  private applyRgvTravelMotion(model: ModelRuntimeEntry, snapshot: DeviceTelemetrySnapshot, deltaSeconds: number): void {
    const state = model.rgvTelemetry;
    const travelAxis = getHorizontalModelAxis(model.root, 'z');
    state.rootPosition ??= state.rootBasePosition.clone();

    const frontColumn = this.readPositiveColumn(snapshot, 'front_y');
    const backColumn = this.readPositiveColumn(snapshot, 'back_y');
    const frontCommand = readIntegerField(snapshot.fields, 'front_command');
    const backCommand = readIntegerField(snapshot.fields, 'back_command');
    const frontMovementZ = readIntegerField(snapshot.fields, 'front_movement_z') ?? 0;
    const backMovementZ = readIntegerField(snapshot.fields, 'back_movement_z') ?? 0;

    // 权威列：command 活动侧优先（前后都活动取前），否则前叉列、再退后叉列
    const frontActive = frontCommand === 1 || frontCommand === 2 || frontCommand === 3;
    const backActive = backCommand === 1 || backCommand === 2 || backCommand === 3;
    const authoritativeSide: RgvForkSide = frontActive && frontColumn !== null
      ? 'front'
      : backActive && backColumn !== null
        ? 'back'
        : frontColumn !== null ? 'front' : 'back';
    const authoritativeColumn = frontActive && frontColumn !== null
      ? frontColumn
      : backActive && backColumn !== null
        ? backColumn
        : frontColumn ?? backColumn;

    // 列号边沿：解析列绑定实体，让载货台面该侧工位的行走轴投影与列投影对齐
    if (!snapshot.faulted && authoritativeColumn !== null && authoritativeColumn !== state.travelTargetColumn) {
      const pose = this.resolveRgvColumnPose(model, authoritativeColumn);
      if (pose) {
        state.travelTargetColumn = authoritativeColumn;
        state.travelTargetPosition = this.constrainRgvTravelPosition(
          model,
          this.resolveRgvColumnAlignedTravelTarget(model, travelAxis, authoritativeSide, pose.position),
          travelAxis,
        );
      }
      // 解析失败不记录列号，后续帧持续重试（告警一次性）
    }

    if (!snapshot.faulted && state.travelTargetPosition) {
      if (frontMovementZ !== 0 || backMovementZ !== 0) {
        // 滚筒起转表示车已到位：瞬移对齐（同 stacker 伸叉到位语义）
        state.rootPosition = state.travelTargetPosition.clone();
        state.travelTargetPosition = null;
      } else {
        const speed = this.readRgvDataDrivenNumber(model, ['motion', 'travel', 'speed'])
          ?? RGV_DEFAULT_TRAVEL_SPEED_METERS_PER_SECOND;
        state.rootPosition = moveVectorTowards(state.rootPosition, state.travelTargetPosition, speed * deltaSeconds);
        if (Vector3.DistanceSquared(state.rootPosition, state.travelTargetPosition) <= 1e-12) {
          state.travelTargetPosition = null;
        }
      }
    }

    state.rootPosition = this.constrainRgvTravelPosition(model, state.rootPosition, travelAxis);
  }

  /**
   * 列对齐行走目标：载货台面该侧工位台面的行走轴投影与列位置投影重合。
   * 配置了 cargo.frontNodes/backNodes 时按该侧节点包围盒中心对齐；未配置回退整体台面四分位点。
   */
  private resolveRgvColumnAlignedTravelTarget(
    model: ModelRuntimeEntry,
    travelAxis: Vector3,
    side: RgvForkSide,
    columnPosition: Vector3,
  ): Vector3 {
    const state = model.rgvTelemetry;
    const currentRoot = state.rootPosition ?? state.rootBasePosition;
    const columnCoordinate = Vector3.Dot(columnPosition, travelAxis);
    const rootBaseCoordinate = Vector3.Dot(state.rootBasePosition, travelAxis);

    const stationCoordinate = this.resolveRgvDeckStationCoordinate(model, side, travelAxis);
    if (stationCoordinate === null) {
      return state.rootBasePosition.add(travelAxis.scale(columnCoordinate - rootBaseCoordinate));
    }

    // 台面包围盒随车行走，工位坐标含当前行走偏移；与当前根位置作差得到姿态不变量。
    const stationOffsetFromRoot = stationCoordinate - Vector3.Dot(currentRoot, travelAxis);
    return state.rootBasePosition.add(travelAxis.scale(columnCoordinate - stationOffsetFromRoot - rootBaseCoordinate));
  }

  /**
   * 该侧工位台面沿行走轴的中心坐标：配置了该侧 cargo.frontNodes/backNodes 时取其包围盒中心；
   * 未配置回退整体台面包围盒的四分位点（前=+Z，后=-Z）；无任何台面返回 null。
   */
  private resolveRgvDeckStationCoordinate(
    model: ModelRuntimeEntry,
    side: RgvForkSide,
    travelAxis: Vector3,
  ): number | null {
    const sideBounds = this.getRgvCargoDeckSideBounds(model, side);
    if (sideBounds) {
      return Vector3.Dot(sideBounds.minimum.add(sideBounds.maximum).scale(0.5), travelAxis);
    }
    const bounds = this.getRgvCargoDeckBounds(model);
    if (!bounds) return null;
    const projected = projectWorldBoundsOntoAxis(bounds, travelAxis);
    return (projected.min + projected.max) / 2
      + (side === 'front' ? 1 : -1) * (projected.max - projected.min) / 4;
  }

  /** 载货台面整体包围盒：合并 cargo.frontNodes/backNodes 声明节点；均未配置或未命中回退全部行走节点。 */
  private getRgvCargoDeckBounds(model: ModelRuntimeEntry): { minimum: Vector3; maximum: Vector3 } | null {
    const configuredNames = [
      ...this.readRgvCargoNodeNames(model, 'front'),
      ...this.readRgvCargoNodeNames(model, 'back'),
    ];
    const configuredNodes = configuredNames.length > 0 ? findModelNodesByName(model, this.scene, configuredNames) : [];
    return getNodesWorldBounds(configuredNodes.length > 0 ? configuredNodes : this.findRgvTravelNodes(model));
  }

  /**
   * 单侧工位台面包围盒：cargo.frontNodes/backNodes 声明节点的合并包围盒；
   * 未配置或未命中返回 null，调用方回退整体台面四分位点。
   */
  private getRgvCargoDeckSideBounds(
    model: ModelRuntimeEntry,
    side: RgvForkSide,
  ): { minimum: Vector3; maximum: Vector3 } | null {
    const configuredNames = this.readRgvCargoNodeNames(model, side);
    if (configuredNames.length === 0) return null;
    return getNodesWorldBounds(findModelNodesByName(model, this.scene, configuredNames));
  }

  /** 读取模型脚本 dataDriven.cargo.frontNodes/backNodes 中声明的该侧载货台面节点名。 */
  private readRgvCargoNodeNames(model: ModelRuntimeEntry, side: RgvForkSide): string[] {
    const key = side === 'front' ? 'frontNodes' : 'backNodes';
    for (const dataDriven of model.externalScriptRuntime?.getDataDrivenConfigs() ?? []) {
      const nodes = readStringArrayPath(dataDriven, ['cargo', key]);
      if (nodes.length > 0) return nodes;
    }
    return [];
  }

  /** 将行走虚拟位置限制在固定轨道范围内，避免列绑定实体把机体推出轨道端点。 */
  private constrainRgvTravelPosition(model: ModelRuntimeEntry, position: Vector3, travelAxis: Vector3): Vector3 {
    const state = model.rgvTelemetry;
    const projectedPosition = projectPointOntoAxis(state.rootBasePosition, travelAxis, position);
    const constraint = this.getRgvTravelConstraint(model, travelAxis);
    if (!constraint) return projectedPosition;

    const requestedDelta = Vector3.Dot(projectedPosition.subtract(state.rootBasePosition), constraint.axis);
    const minDelta = constraint.trackMin - constraint.movingMin;
    const maxDelta = constraint.trackMax - constraint.movingMax;
    const clampedDelta = minDelta <= maxDelta
      ? clampNumber(requestedDelta, minDelta, maxDelta)
      : (constraint.trackMin + constraint.trackMax - constraint.movingMin - constraint.movingMax) / 2;

    return state.rootBasePosition.add(constraint.axis.scale(clampedDelta));
  }

  /** 读取或创建 RGV 轨道约束：固定轨道决定可行范围，车体基线决定端点余量。 */
  private getRgvTravelConstraint(model: ModelRuntimeEntry, travelAxis: Vector3): RgvTravelConstraint | null {
    const state = model.rgvTelemetry;
    if (state.travelConstraint && Vector3.Dot(state.travelConstraint.axis, travelAxis) > 0.999) {
      return state.travelConstraint;
    }

    const fixedBounds = getNodesProjectedBounds(this.findRgvFixedNodes(model), travelAxis);
    const movingBounds = getNodesProjectedBounds(this.findRgvTravelNodes(model), travelAxis);
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

  /** 把车体行走偏移一次性写回车体节点，固定轨道节点保持不动。 */
  private applyRgvNodeMotionOffsets(model: ModelRuntimeEntry): void {
    const state = model.rgvTelemetry;
    const travelWorldOffset = (state.rootPosition ?? state.rootBasePosition).subtract(state.rootBasePosition);
    const offsets = new Map<TransformNode, Vector3>();
    for (const node of filterTopLevelMotionNodes(this.findRgvTravelNodes(model))) {
      offsets.set(node, travelWorldOffset);
    }
    this.offsetRgvNodesFromBaselineByWorldOffsets(model, offsets);
  }

  /** 按世界位移写回节点位置，兼容模型内容根节点的单位缩放、旋转和父级层级。 */
  private offsetRgvNodesFromBaselineByWorldOffsets(model: ModelRuntimeEntry, offsets: Map<TransformNode, Vector3>): void {
    for (const [node, worldOffset] of offsets) {
      const baseline = this.getRgvNodeBaseline(model, node);
      const localOffset = worldDeltaToParentLocalDelta(node, worldOffset);
      node.position = baseline.add(localOffset);
    }
  }

  /** 记录遥测动作前的节点基线位置。 */
  private getRgvNodeBaseline(model: ModelRuntimeEntry, node: TransformNode): Vector3 {
    const existing = model.rgvTelemetry.nodeBaselines.get(node);
    if (existing) return existing;

    const baseline = node.position.clone();
    model.rgvTelemetry.nodeBaselines.set(node, baseline);
    return baseline;
  }

  /** 查找固定轨道节点（导轨/盖板）：优先模型脚本 dataDriven.fixedNodes 声明，缺失回退 A37~A46 命名匹配。 */
  private findRgvFixedNodes(model: ModelRuntimeEntry): TransformNode[] {
    const configuredNames = this.readRgvFixedNodeNames(model);
    const configuredNodes = configuredNames.length > 0 ? findModelNodesByName(model, this.scene, configuredNames) : [];
    if (configuredNodes.length > 0) return configuredNodes;
    return findModelNodes(model, this.scene, RGV_FALLBACK_FIXED_NODE_PATTERN);
  }

  /** 查找随车行走的车体节点：全部模型节点剔除固定轨道节点及其祖先/子孙，避免轨道被行走带动。 */
  private findRgvTravelNodes(model: ModelRuntimeEntry): TransformNode[] {
    const fixedNodes = this.findRgvFixedNodes(model);
    if (fixedNodes.length === 0) {
      this.reportRgvIssueOnce(
        `rgv-no-track:${model.assetCode}`,
        `RGV ${model.assetCode} 未识别到固定轨道节点（A37~A46），整车参与行走且不做轨道约束。`,
      );
    }
    const fixedSet = new Set(fixedNodes);
    return getModelTransformNodes(model, this.scene).filter((node) => {
      if (node === model.root || node === model.contentRoot) return false;
      if (fixedSet.has(node)) return false;
      return !fixedNodes.some((fixed) => node.isDescendantOf(fixed) || fixed.isDescendantOf(node));
    });
  }

  /** 读取模型脚本 dataDriven.fixedNodes 中声明的固定节点名。 */
  private readRgvFixedNodeNames(model: ModelRuntimeEntry): string[] {
    for (const dataDriven of model.externalScriptRuntime?.getDataDrivenConfigs() ?? []) {
      const nodes = readStringArrayPath(dataDriven, ['fixedNodes']);
      if (nodes.length > 0) return nodes;
    }
    return [];
  }

  // ===== 货箱状态机 =====

  /**
   * 单工位货箱状态机：command 决定取/放方向，movement_z 起转边沿刷出/锁定，停转边沿完成放货销毁。
   * command 语义：0 待机 / 1 取货中 / 2 放货中 / 3 取货准备；无完成码，回落 0 作为完成兜底。
   * 货箱只在车体朝向列设备一侧的侧缘刷出/销毁，列上的货物渲染由列设备自身驱动负责。
   */
  private applyRgvForkCargoMotion(
    model: ModelRuntimeEntry,
    snapshot: DeviceTelemetrySnapshot,
    side: RgvForkSide,
    deltaSeconds: number,
  ): void {
    const state = model.rgvTelemetry;
    const command = readIntegerField(snapshot.fields, side === 'front' ? 'front_command' : 'back_command');
    const movementZ = readIntegerField(snapshot.fields, side === 'front' ? 'front_movement_z' : 'back_movement_z');
    const column = this.readPositiveColumn(snapshot, side === 'front' ? 'front_y' : 'back_y');
    const containerCode = readStringField(snapshot.fields, `${side}_containerCode`)?.trim() ?? '';
    const task = normalizeCargoTask(readIntegerField(snapshot.fields, side === 'front' ? 'front_task' : 'back_task'));
    const lastCommand = side === 'front' ? state.frontLastCommand : state.backLastCommand;
    const lastMovementZ = side === 'front' ? state.frontLastMovementZ : state.backLastMovementZ;

    if (!snapshot.faulted) {
      // command 0→1/3 边沿：取货起始，先销毁同侧旧货箱
      if ((command === 1 || command === 3) && lastCommand !== 1 && lastCommand !== 3) {
        this.disposeRgvForkCargo(model, side);
      }
      // command 0→2 边沿：放货起始；车上无货（开机即放货）时补建并置于车上工位
      if (command === 2 && lastCommand !== 2 && !this.getRgvForkCargoKey(model, side)) {
        this.beginRgvOnboardCargo(model, side, task, containerCode);
      }
      // movement_z 0→非0 起转边沿：只有此时车才真实到达交接列，在此锁定交接列
      if (movementZ !== null && movementZ !== 0 && (lastMovementZ === null || lastMovementZ === 0)) {
        if (command === 1 || command === 3) this.beginRgvFetchTransfer(model, side, column, task, containerCode);
        else if (command === 2) this.beginRgvPlaceTransfer(model, side, column);
      }
      // 交接插值推进：方向由 command 决定（movement_z 正反转不区分出入）
      if (movementZ !== null && movementZ !== 0) {
        if (command === 1 || command === 3) this.advanceRgvTransfer(model, side, 1, deltaSeconds);
        else if (command === 2) this.advanceRgvTransfer(model, side, -1, deltaSeconds);
      }
      // movement_z 非0→0 停转边沿：放货交接完成，销毁货箱（之后由列设备侧渲染）
      if (command === 2 && movementZ === 0 && lastMovementZ !== null && lastMovementZ !== 0) {
        this.disposeRgvForkCargo(model, side);
      }
      // command 1/3→0 边沿：取货完成，兜底绑定上车
      if (command === 0 && (lastCommand === 1 || lastCommand === 3)) {
        if (!this.getRgvForkCargoKey(model, side) && lastCommand === 1) {
          // 起转边沿从未出现（遥测稀疏跳过流程）：直接补建上车
          this.beginRgvOnboardCargo(model, side, task, containerCode);
        }
        this.completeRgvFetch(model, side);
      }
      // command 2→0 边沿：停转边沿被稀疏遥测跳过时兜底销毁
      if (command === 0 && lastCommand === 2) {
        this.disposeRgvForkCargo(model, side);
      }
    }

    this.updateRgvCargoPose(model, snapshot, side, deltaSeconds);

    if (side === 'front') {
      state.frontLastCommand = command;
      state.frontLastMovementZ = movementZ;
    } else {
      state.backLastCommand = command;
      state.backLastMovementZ = movementZ;
    }
  }

  /** 取货起转锁列：清理同侧旧货箱，在车体朝向列设备一侧的侧缘刷出货箱等待移入。 */
  private beginRgvFetchTransfer(model: ModelRuntimeEntry, side: RgvForkSide, column: number | null, task: string, containerCode: string): void {
    const state = model.rgvTelemetry;
    this.disposeRgvForkCargo(model, side);

    if (column === null) {
      this.reportRgvIssueOnce(
        `rgv-fetch-no-column:${model.assetCode}:${side}`,
        `RGV ${model.assetCode} ${side === 'front' ? '前' : '后'}工位起转取货时缺少有效列号，已忽略。`,
      );
      return;
    }

    const pose = this.resolveRgvColumnPose(model, column);
    if (!pose) return;

    this.getOrCreateRgvCargo(model.assetCode, side);
    const cargoKey = this.getRgvCargoKey(model.assetCode, side);
    this.adoptOrCreateRgvCargo(model, side, task, containerCode);
    const edgePose = this.getRgvTransferEdgePose(model, side, pose.position);
    if (side === 'front') {
      state.frontCargoKey = cargoKey;
      state.frontCargoHoldPosition = edgePose.position;
      state.frontCargoHoldRotation = edgePose.rotation;
      state.frontTransferProgress = 0;
      state.frontCargoOnBoard = false;
    } else {
      state.backCargoKey = cargoKey;
      state.backCargoHoldPosition = edgePose.position;
      state.backCargoHoldRotation = edgePose.rotation;
      state.backTransferProgress = 0;
      state.backCargoOnBoard = false;
    }
  }

  /** 放货起转锁列：以车体朝向列设备一侧的侧缘作为货箱移出终点；车上无货时忽略。 */
  private beginRgvPlaceTransfer(model: ModelRuntimeEntry, side: RgvForkSide, column: number | null): void {
    if (!this.getRgvForkCargoKey(model, side)) return;
    if (column === null) {
      this.reportRgvIssueOnce(
        `rgv-place-no-column:${model.assetCode}:${side}`,
        `RGV ${model.assetCode} ${side === 'front' ? '前' : '后'}工位起转放货时缺少有效列号，已忽略。`,
      );
      return;
    }

    const pose = this.resolveRgvColumnPose(model, column);
    if (!pose) return;

    const state = model.rgvTelemetry;
    const edgePose = this.getRgvTransferEdgePose(model, side, pose.position);
    if (side === 'front') {
      state.frontCargoHoldPosition = edgePose.position;
      state.frontCargoHoldRotation = edgePose.rotation;
      state.frontTransferProgress = 1;
      // 货箱离车进入交接插值：onBoard 置 false 后 pose 走 lerp 分支，否则钉在车工位无动画
      state.frontCargoOnBoard = false;
    } else {
      state.backCargoHoldPosition = edgePose.position;
      state.backCargoHoldRotation = edgePose.rotation;
      state.backTransferProgress = 1;
      state.backCargoOnBoard = false;
    }
  }

  /** 直接建立车上货箱：放货起始补建、取货完成兜底共用；先清理同侧旧货箱。 */
  private beginRgvOnboardCargo(model: ModelRuntimeEntry, side: RgvForkSide, task: string, containerCode: string): void {
    this.disposeRgvCargoByKey(this.getRgvCargoKey(model.assetCode, side));
    this.clearRgvForkCargoState(model, side);
    this.getOrCreateRgvCargo(model.assetCode, side);
    const cargoKey = this.getRgvCargoKey(model.assetCode, side);
    this.adoptOrCreateRgvCargo(model, side, task, containerCode);
    const state = model.rgvTelemetry;
    if (side === 'front') {
      state.frontCargoKey = cargoKey;
      state.frontCargoOnBoard = true;
      state.frontTransferProgress = 1;
    } else {
      state.backCargoKey = cargoKey;
      state.backCargoOnBoard = true;
      state.backTransferProgress = 1;
    }
  }

  /** 交接插值推进：取货方向 +1（列→车），放货方向 -1（车→列）；未锁定交接列不推进。 */
  private advanceRgvTransfer(model: ModelRuntimeEntry, side: RgvForkSide, direction: 1 | -1, deltaSeconds: number): void {
    const state = model.rgvTelemetry;
    if (!this.getRgvForkCargoKey(model, side)) return;
    const holdPosition = side === 'front' ? state.frontCargoHoldPosition : state.backCargoHoldPosition;
    if (!holdPosition) return;

    const progress = side === 'front' ? state.frontTransferProgress : state.backTransferProgress;
    const next = clampNumber(progress + (direction * deltaSeconds) / RGV_CARGO_TRANSFER_SECONDS, 0, 1);
    if (side === 'front') state.frontTransferProgress = next;
    else state.backTransferProgress = next;
  }

  /** 取货完成：兜底置为车上态，货箱之后每帧跟随车工位。 */
  private completeRgvFetch(model: ModelRuntimeEntry, side: RgvForkSide): void {
    if (!this.getRgvForkCargoKey(model, side)) return;
    const state = model.rgvTelemetry;
    if (side === 'front') {
      state.frontTransferProgress = 1;
      state.frontCargoOnBoard = true;
      state.frontCargoHoldPosition = null;
      state.frontCargoHoldRotation = null;
    } else {
      state.backTransferProgress = 1;
      state.backCargoOnBoard = true;
      state.backCargoHoldPosition = null;
      state.backCargoHoldRotation = null;
    }
  }

  /** 销毁某侧工位的货箱并清空其状态，停转销毁与 command 兜底共用。 */
  private disposeRgvForkCargo(model: ModelRuntimeEntry, side: RgvForkSide): void {
    const cargoKey = this.getRgvForkCargoKey(model, side);
    if (!cargoKey) return;
    this.disposeRgvCargoByKey(cargoKey);
    this.clearRgvForkCargoState(model, side);
  }

  /** 每帧刷新货箱外观与位姿：车上跟随工位锚点，交接中在列支撑位与工位间插值；跨设备接管货物再叠加 handoff 过渡。 */
  private updateRgvCargoPose(model: ModelRuntimeEntry, snapshot: DeviceTelemetrySnapshot, side: RgvForkSide, deltaSeconds: number): void {
    const cargoKey = this.getRgvForkCargoKey(model, side);
    if (!cargoKey) return;
    const cargo = this.state.rgvCargoMeshes.get(cargoKey);
    if (!cargo) return;

    const state = model.rgvTelemetry;
    const onBoard = side === 'front' ? state.frontCargoOnBoard : state.backCargoOnBoard;
    const holdPosition = side === 'front' ? state.frontCargoHoldPosition : state.backCargoHoldPosition;
    const holdRotation = side === 'front' ? state.frontCargoHoldRotation : state.backCargoHoldRotation;
    const progress = side === 'front' ? state.frontTransferProgress : state.backTransferProgress;

    this.host.syncGeneratedCargoVisual(cargo, 'rgv', snapshot, this.host.resolveCargoGeneratorForModel(model));
    const station = this.getRgvStationPose(model, side);
    let targetPosition = station.position;
    let targetRotation = station.rotation;
    if (!onBoard && holdPosition && progress < 1) {
      targetPosition = Vector3.Lerp(holdPosition, station.position, progress);
      targetRotation = holdRotation
        ? Quaternion.Slerp(holdRotation, station.rotation, progress)
        : station.rotation;
    }

    const pose = resolveCargoHandoffPose(cargo, targetPosition, targetRotation, deltaSeconds);
    this.host.setGeneratedCargoRootPose(cargo, pose.position, pose.rotation, null);
  }

  /**
   * 车工位锚点：配置了该侧 cargo.frontNodes/backNodes 时取其台面节点包围盒中心；
   * 未配置回退整体台面包围盒沿行走轴的四分位点（前=+Z 侧，后=-Z 侧）。
   * 高度取台面包围盒顶面，货箱刷在台面上方。
   */
  private getRgvStationPose(model: ModelRuntimeEntry, side: RgvForkSide): { position: Vector3; rotation: Quaternion } {
    const state = model.rgvTelemetry;
    const rotation = getNodeWorldRotation(model.root);
    const travelAxis = getHorizontalModelAxis(model.root, 'z');

    const sideBounds = this.getRgvCargoDeckSideBounds(model, side);
    if (sideBounds) {
      const position = sideBounds.minimum.add(sideBounds.maximum).scale(0.5);
      position.y = sideBounds.maximum.y;
      return { position, rotation };
    }

    const bounds = this.getRgvCargoDeckBounds(model);
    if (!bounds) {
      return { position: (state.rootPosition ?? state.rootBasePosition).clone(), rotation };
    }

    const projected = projectWorldBoundsOntoAxis(bounds, travelAxis);
    const boundsCenter = bounds.minimum.add(bounds.maximum).scale(0.5);
    const stationCoord = (projected.min + projected.max) / 2
      + (side === 'front' ? 1 : -1) * (projected.max - projected.min) / 4;
    const position = boundsCenter.add(travelAxis.scale(stationCoord - Vector3.Dot(boundsCenter, travelAxis)));
    position.y = bounds.maximum.y;
    return { position, rotation };
  }

  /**
   * 交接侧缘锚点：车工位沿横向轴（模型局部 X）向列设备一侧偏移整个台面宽度，
   * 使货箱刷出/销毁的交接行程覆盖完整宽度，而不是中心到侧缘的半程。
   */
  private getRgvTransferEdgePose(
    model: ModelRuntimeEntry,
    side: RgvForkSide,
    columnPosition: Vector3,
  ): { position: Vector3; rotation: Quaternion } {
    const station = this.getRgvStationPose(model, side);
    const bounds = this.getRgvCargoDeckSideBounds(model, side) ?? this.getRgvCargoDeckBounds(model);
    if (!bounds) return station;

    const lateralAxis = getHorizontalModelAxis(model.root, 'x');
    const lateralProjected = projectWorldBoundsOntoAxis(bounds, lateralAxis);
    const columnSideSign = Vector3.Dot(columnPosition.subtract(station.position), lateralAxis) >= 0 ? 1 : -1;
    const edgeCoordinate = (lateralProjected.min + lateralProjected.max) / 2
      + columnSideSign * (lateralProjected.max - lateralProjected.min);
    const position = station.position.add(
      lateralAxis.scale(edgeCoordinate - Vector3.Dot(station.position, lateralAxis)),
    );
    return { position, rotation: station.rotation };
  }

  // ===== 列绑定解析 =====

  /** 解析列号绑定的场景实体世界位姿；未绑定或实体已删除时一次性告警并返回 null。 */
  private resolveRgvColumnPose(model: ModelRuntimeEntry, column: number): { position: Vector3; rotation: Quaternion } | null {
    const entityId = model.telemetryBinding?.columnBindings?.[String(column)];
    if (!entityId) {
      this.reportRgvIssueOnce(
        `rgv-column-unbound:${model.assetCode}:${column}`,
        `RGV ${model.assetCode} 列 ${column} 未绑定场景实体，已忽略该列定位。`,
      );
      return null;
    }
    const pose = this.host.resolveColumnTargetPose(entityId);
    if (!pose) {
      this.reportRgvIssueOnce(
        `rgv-column-missing:${model.assetCode}:${column}:${entityId}`,
        `RGV ${model.assetCode} 列 ${column} 绑定的实体已不存在，已忽略该列定位。`,
      );
      return null;
    }
    return pose;
  }

  /** 读取有效列号：正整数才合法，0/负值/缺失视为无列。 */
  private readPositiveColumn(snapshot: DeviceTelemetrySnapshot, key: string): number | null {
    const value = readIntegerField(snapshot.fields, key);
    return value !== null && value > 0 ? value : null;
  }

  // ===== 货箱生命周期 =====

  /** 生成 RGV 运行时货箱的唯一键：每台设备每侧工位同时最多携带一箱。 */
  getRgvCargoKey(assetCode: string, side: RgvForkSide): string {
    return JSON.stringify([assetCode, side]);
  }

  /** 读取某侧工位当前货箱键，null 表示无货。 */
  private getRgvForkCargoKey(model: ModelRuntimeEntry, side: RgvForkSide): string | null {
    return side === 'front' ? model.rgvTelemetry.frontCargoKey : model.rgvTelemetry.backCargoKey;
  }

  /** 创建或复用某侧工位的 RGV 运行时货箱。 */
  getOrCreateRgvCargo(assetCode: string, side: RgvForkSide): RgvCargoRuntimeEntry {
    const key = this.getRgvCargoKey(assetCode, side);
    const existing = this.state.rgvCargoMeshes.get(key);
    if (existing) return existing;

    const root = new TransformNode(
      `rgv_cargo_root_${sanitizeBabylonName(assetCode)}_${side}`,
      this.scene,
    );
    const entry: RgvCargoRuntimeEntry = {
      assetCode,
      containerCode: '',
      task: '',
      root,
      outputOwner: null,
      fallback: null,
      generatorEntityId: null,
      handoff: null,
    };
    this.state.rgvCargoMeshes.set(key, entry);
    return entry;
  }

  /** 按键销毁 RGV 运行时货箱，map 中不存在时幂等跳过。 */
  private disposeRgvCargoByKey(key: string): void {
    const cargo = this.state.rgvCargoMeshes.get(key);
    if (!cargo) return;
    this.host.disposeGeneratedCargo(cargo);
    this.state.rgvCargoMeshes.delete(key);
  }

  /** 其他设备凭同一 task 接管本货箱：清理引用该货箱的模型遥测引用后从表中取出（不销毁），实例交给接管方保持视觉连续。 */
  detachClaimedCargoByKey(key: string): RgvCargoRuntimeEntry | null {
    const cargo = this.state.rgvCargoMeshes.get(key);
    if (!cargo) return null;
    for (const { model } of this.host.collectModels()) {
      if (model.rgvTelemetry.frontCargoKey === key) this.clearRgvForkCargoState(model, 'front');
      if (model.rgvTelemetry.backCargoKey === key) this.clearRgvForkCargoState(model, 'back');
    }
    this.state.rgvCargoMeshes.delete(key);
    return cargo;
  }

  /**
   * 刷出货箱时按 task 全局接管或自建：接管成功则以货箱当前世界位姿为起点进入交接插值，
   * 并销毁本侧刚建的占位条目（从未渲染）；无 task 匿名，不参与全局接管。
   */
  private adoptOrCreateRgvCargo(model: ModelRuntimeEntry, side: RgvForkSide, task: string, containerCode: string): void {
    const cargoKey = this.getRgvCargoKey(model.assetCode, side);
    const adopted = this.context.adoptGlobalCargoByTask(task, cargoKey);
    if (adopted) {
      const placeholder = this.state.rgvCargoMeshes.get(cargoKey);
      if (placeholder && placeholder !== adopted) this.disposeRgvCargoByKey(cargoKey);
      adopted.assetCode = model.assetCode;
      adopted.task = task;
      adopted.containerCode = containerCode || adopted.containerCode;
      adopted.handoff = createCargoHandoffState(adopted);
      this.state.rgvCargoMeshes.set(cargoKey, adopted);
      return;
    }
    const cargo = this.state.rgvCargoMeshes.get(cargoKey);
    if (!cargo) return;
    cargo.task = task;
    cargo.containerCode = containerCode;
  }

  /** 删除指定 RGV 实例生成的全部运行时货箱，不污染场景文档。 */
  disposeRgvCargoForAssetCode(assetCode: string): void {
    for (const [key, cargo] of this.state.rgvCargoMeshes.entries()) {
      if (cargo.assetCode !== assetCode) continue;
      this.host.disposeGeneratedCargo(cargo);
      this.state.rgvCargoMeshes.delete(key);
    }
  }

  /** 清空某侧工位的全部货箱状态，保留 lastCommand/lastMovementZ 边沿检测基线。 */
  private clearRgvForkCargoState(model: ModelRuntimeEntry, side: RgvForkSide): void {
    const state = model.rgvTelemetry;
    if (side === 'front') {
      state.frontCargoKey = null;
      state.frontCargoOnBoard = false;
      state.frontCargoHoldPosition = null;
      state.frontCargoHoldRotation = null;
      state.frontTransferProgress = 0;
      return;
    }

    state.backCargoKey = null;
    state.backCargoOnBoard = false;
    state.backCargoHoldPosition = null;
    state.backCargoHoldRotation = null;
    state.backTransferProgress = 0;
  }

  // ===== 诊断与配置读取 =====

  /** 对故障和状态变化做一次性 Console 提示，避免每帧刷屏。 */
  private reportRgvRuntimeState(snapshot: DeviceTelemetrySnapshot): void {
    const deviceKey = `${snapshot.sourceId}:${snapshot.deviceType}:${snapshot.assetCode}`;
    const mode = readIntegerField(snapshot.fields, 'mode');
    const frontCommand = readIntegerField(snapshot.fields, 'front_command');
    const backCommand = readIntegerField(snapshot.fields, 'back_command');
    const statusSignature = JSON.stringify([mode, frontCommand, backCommand, snapshot.message]);
    if (this.state.reportedStatuses.get(deviceKey) !== statusSignature) {
      this.state.reportedStatuses.set(deviceKey, statusSignature);
      this.host.pushLog(
        `RGV ${snapshot.assetCode} 状态：mode=${mode ?? '未知'}，front=${frontCommand ?? '未知'}，back=${backCommand ?? '未知'}${snapshot.message ? `，${snapshot.message}` : ''}`,
      );
    }

    if (!snapshot.faulted) {
      this.state.reportedFaults.delete(deviceKey);
      return;
    }

    const faultMessage = snapshot.message || `errorCode=${readIntegerField(snapshot.fields, 'errorCode') ?? 0}`;
    if (this.state.reportedFaults.get(deviceKey) === faultMessage) return;

    this.state.reportedFaults.set(deviceKey, faultMessage);
    this.host.pushLog(`RGV ${snapshot.assetCode} 故障/急停：${faultMessage}`);
  }

  /** RGV 运行问题按稳定 key 只写一次 Console。 */
  private reportRgvIssueOnce(key: string, message: string): void {
    if (this.state.reportedMissingTargets.has(key)) return;
    this.state.reportedMissingTargets.add(key);
    this.host.pushLog(message);
  }

  /** 读取模型脚本 dataDriven 声明的数值配置。 */
  private readRgvDataDrivenNumber(model: ModelRuntimeEntry, path: string[]): number | null {
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
}
