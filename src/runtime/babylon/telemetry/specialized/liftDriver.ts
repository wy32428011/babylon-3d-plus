import type { Scene } from '@babylonjs/core';
import { Quaternion, TransformNode, Vector3 } from '@babylonjs/core';
import {
  clampNumber,
  filterTopLevelMotionNodes,
  findModelNodesByName,
  getHorizontalModelAxis,  getModelAxis,
  getModelTransformNodes,
  getNodesProjectedBounds,
  getNodesWorldBounds,
  moveNumberTowards,
  projectWorldBoundsOntoAxis,
  worldDeltaToParentLocalDelta,
} from '../../runtimeNodeGeometry';
import { isPlainRecord, readStringArrayPath } from '../../runtimeValueUtils';
import { readIntegerField, type DeviceTelemetrySnapshot } from '../../../mqtt/deviceTelemetry';
import type { ModelRuntimeEntry } from '../../SceneRuntime';
import { writeDeviceTelemetryMetadata } from './telemetryMetadata';
import { isConveyorRuntimeModel } from './specializedModelAssets';
import {
  CARGO_HANDOFF_SECONDS,
  createCargoHandoffState,
  createCargoSpawnWorldRotation,
  normalizeCargoTask,
  resolveCargoHandoffPose,
  type GeneratedCargoRuntimeEntry,
  LIFT_DEFAULT_LIFT_SPEED_METERS_PER_SECOND,
  type LiftCargoRuntimeEntry,
  type LiftStationState,
  type LiftTravelAxisCache,
  RGV_CARGO_TRANSFER_SECONDS,
  type SpecializedTelemetryDriverContext,
  type SpecializedTelemetryHost,
  type SpecializedTelemetrySharedState,
  type StackerLiftConstraint,
} from './types';

/** 层候选：绑定实体 + 货物支撑面世界坐标 + 已确认为 conveyor 的模型条目。 */
type LiftLayerCandidate = { entityId: string; surfacePoint: Vector3; conveyor: ModelRuntimeEntry };

/** work_state ∈ {1 取货中, 3 卸货中} 且载货台未到位时的赶位速度倍率。 */
const LIFT_RUSH_SPEED_MULTIPLIER = 4;

/**
 * 物料提升机（lift）遥测驱动：RGV 的垂直版——载货台沿模型 Y 轴升降，层绑定分来料/送料两张表。
 * reference_upper_step（1=来料侧/2=送料侧）+ level_upper（该侧目标层号）组成目标键做边沿检测，
 * 目标层绑定 conveyor 的货物支撑面世界 Y 决定载货台目标偏移；movement_y 字段不消费。
 * work_state 存在时交接动作由状态机门控（1/2 取货、3/5 卸货，doing/done 同为门控；未到位 4 倍速赶位；
 * 2/5 补齐交接动画；0/6/7/11 只移动不交接；10 急停冻结）；字段缺失走旧的到位自动交接兼容路径。
 * 双工位载货：载物台按货物轨迹轴分前（step1，stations[0]）后（step2，stations[1]）两区，
 * 来料先收进 step2、后收进 step1；送料侧 step2 先出，step1 先平移到 step2 再出。
 * 目标层不在绑定表内则不响应不移动（一次性 Console 提示）。货箱全程只平移不旋转。
 */
export class LiftTelemetryDriver {
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

  /** 对单台提升机应用载货台升降与交接的遥测驱动。 */
  applyToModel(model: ModelRuntimeEntry, snapshot: DeviceTelemetrySnapshot, deltaSeconds: number): void {
    this.reportLiftRuntimeState(snapshot);
    writeDeviceTelemetryMetadata(model, snapshot);
    this.applyLiftWorkState(model, snapshot);
    this.applyLiftMotion(model, snapshot, deltaSeconds);
    this.applyLiftNodeMotionOffsets(model);
    this.applyLiftCargoHandoff(model, snapshot, deltaSeconds);
  }

  /** 每帧读入 work_state 原始值（缺失为 null，走兼容路径），并按 task_num_fin_* 标注对应工位货物身份。 */
  private applyLiftWorkState(model: ModelRuntimeEntry, snapshot: DeviceTelemetrySnapshot): void {
    const state = model.liftTelemetry;
    state.workState = readIntegerField(snapshot.fields, 'work_state');
    this.applyStationTaskAnnotation(model, snapshot, 0, 'task_num_fin_first_up');
    this.applyStationTaskAnnotation(model, snapshot, 1, 'task_num_fin_second_up');
  }

  /** task_num_fin_first_up/second_up 仅标注对应工位货物的 cargo.task（值变化才写），不驱动状态机；字段缺失不清除。 */
  private applyStationTaskAnnotation(model: ModelRuntimeEntry, snapshot: DeviceTelemetrySnapshot, stationIndex: 0 | 1, field: string): void {
    const raw = readIntegerField(snapshot.fields, field);
    if (raw === null) return;
    const cargoKey = model.liftTelemetry.stations[stationIndex].cargoKey;
    if (!cargoKey) return;
    const cargo = this.state.liftCargoMeshes.get(cargoKey);
    if (!cargo) return;
    const task = normalizeCargoTask(raw);
    if (cargo.task !== task) cargo.task = task;
  }

  /** 急停（work_state=10）与 faulted 同等冻结：不寻址、不移动、不交接。 */
  private isLiftFrozen(model: ModelRuntimeEntry, snapshot: DeviceTelemetrySnapshot): boolean {
    return snapshot.faulted || model.liftTelemetry.workState === 10;
  }

  // ===== 载货台升降 =====

  /** 目标层信号驱动载货台沿 Y 轴升降；目标键变化时重解析层绑定并换算目标偏移。work_state=1/3 且未到位时 4 倍速赶位。 */
  private applyLiftMotion(model: ModelRuntimeEntry, snapshot: DeviceTelemetrySnapshot, deltaSeconds: number): void {
    const state = model.liftTelemetry;
    const upAxis = getModelAxis(model.root, 'y');
    const frozen = this.isLiftFrozen(model, snapshot);

    // 协议侧别映射：reference_upper_step 1=来料侧（内部 0），2=送料侧（内部 1），其它值无目标
    const sideValue = readIntegerField(snapshot.fields, 'reference_upper_step');
    const side = sideValue === 1 ? 0 : sideValue === 2 ? 1 : null;
    const layerValue = readIntegerField(snapshot.fields, 'level_upper');
    const layer = layerValue !== null && layerValue > 0 ? layerValue : null;
    const targetKey = side !== null && layer !== null ? `${side}:${layer}` : null;

    if (!frozen && targetKey !== null && targetKey !== state.targetKey) {
      const candidate = this.resolveLiftLayerCandidate(model, side as 0 | 1, layer as number);
      if (candidate) {
        const deckTopBase = this.resolveLiftDeckTopBaseCoordinate(model, upAxis);
        if (deckTopBase !== null) {
          state.targetKey = targetKey;
          state.targetSide = side;
          state.targetLayer = layer;
          state.targetEntityId = candidate.entityId;
          state.arrivedTargetKey = null;
          state.liftTargetOffset = this.clampLiftOffset(
            model,
            Vector3.Dot(candidate.surfacePoint, upAxis) - deckTopBase,
          );
        }
      }
      // 解析失败不记录目标键，后续帧持续重试（告警一次性）
    }

    if (!frozen && state.liftTargetOffset !== null) {
      const rushing = (state.workState === 1 || state.workState === 3) && state.arrivedTargetKey !== state.targetKey;
      const speed = this.readLiftSpeed(model) * (rushing ? LIFT_RUSH_SPEED_MULTIPLIER : 1);
      state.liftOffset = moveNumberTowards(state.liftOffset, state.liftTargetOffset, speed * deltaSeconds);
      if (state.liftOffset === state.liftTargetOffset && state.arrivedTargetKey !== state.targetKey) {
        state.arrivedTargetKey = state.targetKey;
      }
    }

    state.liftOffset = this.clampLiftOffset(model, state.liftOffset);
  }

  /** 载货面节点包围盒顶面在基线（liftOffset=0）时的世界 Y 投影坐标。 */
  private resolveLiftDeckTopBaseCoordinate(model: ModelRuntimeEntry, upAxis: Vector3): number | null {
    const state = model.liftTelemetry;
    const bounds = getNodesWorldBounds(this.findLiftCargoDeckNodes(model));
    if (!bounds) return null;
    const projected = projectWorldBoundsOntoAxis(bounds, upAxis);
    return projected.max - state.liftOffset;
  }

  /** 将载货台升降偏移限制在物理行程内：整机框架与载货面基线投影得出（同 stacker，模型大小决定）；约束不可用时保持 [0, +∞) 现行为。 */
  private clampLiftOffset(model: ModelRuntimeEntry, offset: number): number {
    let min = 0;
    let max = Number.POSITIVE_INFINITY;
    const constraint = this.getLiftConstraint(model);
    if (constraint) {
      const physicalMin = constraint.frameMin - constraint.movingMin;
      const physicalMax = constraint.frameMax - constraint.movingMax;
      if (physicalMin <= physicalMax) {
        min = physicalMin;
        max = physicalMax;
      }
    }
    return clampNumber(offset, Math.min(min, max), Math.max(min, max));
  }

  /** 读取或创建升降行程约束：整机静态框架决定可升范围，载货台基线决定端点余量。 */
  private getLiftConstraint(model: ModelRuntimeEntry): StackerLiftConstraint | null {
    const state = model.liftTelemetry;
    const upAxis = getModelAxis(model.root, 'y');
    if (state.liftConstraint && Vector3.Dot(state.liftConstraint.axis, upAxis) > 0.999) {
      return state.liftConstraint;
    }

    const deckNodes = this.findLiftDeckNodes(model);
    const deckSet = new Set(deckNodes);
    const frameNodes = getModelTransformNodes(model, this.scene).filter((node) => {
      if (node === model.root || node === model.contentRoot) return false;
      if (deckSet.has(node)) return false;
      return !deckNodes.some((deck) => node.isDescendantOf(deck));
    });
    const frameBounds = getNodesProjectedBounds(frameNodes, upAxis);
    const movingBounds = getNodesProjectedBounds(deckNodes, upAxis);
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

  /** 把载货台升降偏移一次性写回载货台节点，其余结构保持不动。 */
  private applyLiftNodeMotionOffsets(model: ModelRuntimeEntry): void {
    const state = model.liftTelemetry;
    const upAxis = getModelAxis(model.root, 'y');
    const worldOffset = upAxis.scale(state.liftOffset);
    for (const node of filterTopLevelMotionNodes(this.findLiftDeckNodes(model))) {
      const baseline = this.getLiftNodeBaseline(model, node);
      node.position = baseline.add(worldDeltaToParentLocalDelta(node, worldOffset));
    }
  }

  /** 记录遥测动作前的节点基线位置。 */
  private getLiftNodeBaseline(model: ModelRuntimeEntry, node: TransformNode): Vector3 {
    const existing = model.liftTelemetry.nodeBaselines.get(node);
    if (existing) return existing;

    const baseline = node.position.clone();
    model.liftTelemetry.nodeBaselines.set(node, baseline);
    return baseline;
  }

  /** 查找载货台随动节点：模型脚本 dataDriven.motion.lift.nodes 声明，兼容参数化运行时克隆。 */
  private findLiftDeckNodes(model: ModelRuntimeEntry): TransformNode[] {
    return this.findLiftConfiguredNodes(model, this.readLiftMotionNodeNames(model));
  }

  /**
   * 查找载货面节点（货物锚点/层对齐口径）：模型脚本 dataDriven.cargo.nodes 声明（同 RGV cargo.frontNodes 的 motion/cargo 分离），
   * 未声明回退载货台随动节点全集。
   */
  private findLiftCargoDeckNodes(model: ModelRuntimeEntry): TransformNode[] {
    const configuredNames = this.readLiftCargoNodeNames(model);
    if (configuredNames.length === 0) return this.findLiftDeckNodes(model);
    const nodes = this.findLiftConfiguredNodes(model, configuredNames);
    return nodes.length > 0 ? nodes : this.findLiftDeckNodes(model);
  }

  /** 按声明节点名收集原始节点及其参数化运行时克隆（metadata.motionSourceNodeName 兼容链）。 */
  private findLiftConfiguredNodes(model: ModelRuntimeEntry, names: string[]): TransformNode[] {
    if (names.length === 0) return [];
    const nameSet = new Set(names);
    return getModelTransformNodes(model, this.scene).filter((node) => {
      if (nameSet.has(String(node.name ?? ''))) return true;
      const sourceNodeName = this.readParametricMotionSourceNodeName(node);
      return sourceNodeName !== null && nameSet.has(sourceNodeName);
    });
  }

  /** 读取参数化克隆继承的源运动节点名，普通场景节点不会进入该兼容链路。 */
  private readParametricMotionSourceNodeName(node: TransformNode): string | null {
    if (!isPlainRecord(node.metadata) || node.metadata.generatedByParametricRuntime !== true) return null;
    const sourceNodeName = typeof node.metadata.motionSourceNodeName === 'string'
      ? node.metadata.motionSourceNodeName
      : typeof node.metadata.sourceNodeName === 'string'
        ? node.metadata.sourceNodeName
        : '';
    const normalizedName = sourceNodeName.trim();
    return normalizedName || null;
  }

  // ===== 双工位交接状态机 =====

  /**
   * 到位锁命中后按目标侧交接：
   * 来料层（side 0）到位→从绑定 conveyor 取货上台，工位分配 step2（后）优先、其次 step1（前），双满拒取下帧重试；
   * 送料层（side 1）到位→step2 先出，step2 空且 step1 有货时先平移到 step2 锚点（rekey）再交付；
   * 送料侧接收方未空闲时货物滞留台上持续重试，不销毁。
   * work_state 存在时动作门控（doing/done 同为门控：允许执行或赶着到位，不死锁货箱）：
   * 1/2 允许取货、3/5 允许卸货（接收方被占用则货留 step2 锚点每帧重试，有人接立即给），2 同时补齐取货动画、
   * 0/6/7/11 只移动不交接；缺失（null）走兼容路径——到位即自动交接。
   */
  private applyLiftCargoHandoff(model: ModelRuntimeEntry, snapshot: DeviceTelemetrySnapshot, deltaSeconds: number): void {
    const state = model.liftTelemetry;
    const frozen = this.isLiftFrozen(model, snapshot);
    // 出站交付冷却逐帧消退：冷却期内 step1 货不得启动向 step2 的排队平移（让离台货的承接平滑先播完）
    state.outgoingHandoffCooldown = Math.max(0, state.outgoingHandoffCooldown - deltaSeconds);
    const arrived = !frozen
      && state.arrivedTargetKey !== null
      && state.arrivedTargetKey === state.targetKey
      && state.targetEntityId !== null;
    const workState = state.workState;

    const pickupAllowed = arrived && state.targetSide === 0 && (workState === null || workState === 1 || workState === 2);
    const deliveryAllowed = arrived && state.targetSide === 1 && (workState === null || workState === 3 || workState === 5);
    const transferAdvancing = !frozen
      && (workState === null || workState === 1 || workState === 2 || workState === 3 || workState === 5);

    if (pickupAllowed) {
      const stationIndex = state.stations[1].cargoKey === null ? 1 : state.stations[0].cargoKey === null ? 0 : null;
      if (stationIndex !== null) this.tryAdoptIncomingCargo(model, state.targetEntityId as string, stationIndex);
    }

    // work_state 2（取货完成）：补齐取货方向交接动画；交付仍走正常接收重试
    if (workState === 2) this.forceCompletePickupTransfers(state);

    if (transferAdvancing) {
      for (const station of state.stations) {
        if (station.cargoKey === null || !station.transferActive) continue;
        station.transferProgress = clampNumber(
          station.transferProgress + (station.transferDirection * deltaSeconds) / RGV_CARGO_TRANSFER_SECONDS,
          0,
          1,
        );
        if (station.transferDirection === 1 && station.transferProgress >= 1) {
          station.cargoOnBoard = true;
          station.transferActive = false;
          station.cargoHoldPosition = null;
          station.cargoHoldRotation = null;
        }
      }
    }

    if (deliveryAllowed) {
      this.processOutgoingDelivery(model, state.targetEntityId as string);
    }

    this.updateLiftCargoPoses(model, snapshot, deltaSeconds);
  }

  /** work_state 2（取货完成）补齐取货动画：取货方向直接推满上台。放货无台上插值（接收方忙时货留锚点等空闲），无需补齐。 */
  private forceCompletePickupTransfers(state: ModelRuntimeEntry['liftTelemetry']): void {
    for (const station of state.stations) {
      if (station.cargoKey === null || !station.transferActive || station.transferDirection !== 1) continue;
      station.transferProgress = 1;
      station.cargoOnBoard = true;
      station.transferActive = false;
      station.cargoHoldPosition = null;
      station.cargoHoldRotation = null;
    }
  }

  /** 送料层卸货：step1 货先平移到 step2（rekey 到后工位，从前工位锚点插值），随后 step2 出货交付。
   *  上一货刚离台时平移延迟 outgoingHandoffCooldown 秒启动——离台货在接收方侧还有承接平滑，两货动画须先后而非并发。 */
  private processOutgoingDelivery(model: ModelRuntimeEntry, entityId: string): void {
    const state = model.liftTelemetry;
    const front = state.stations[0];
    const back = state.stations[1];

    if (back.cargoKey === null && front.cargoKey !== null && front.cargoOnBoard && !front.transferActive
      && state.outgoingHandoffCooldown <= 0) {
      const cargo = this.state.liftCargoMeshes.get(front.cargoKey);
      if (cargo) {
        const newKey = this.getLiftCargoKey(model.assetCode, 1);
        this.state.liftCargoMeshes.delete(front.cargoKey);
        this.state.liftCargoMeshes.set(newKey, cargo);
        this.clearLiftStationState(front);
        back.cargoKey = newKey;
        back.cargoOnBoard = false;
        back.cargoHoldPosition = this.getLiftStationPose(model, 0, cargo.lockedWorldRotation).position;
        back.cargoHoldRotation = null;
        back.transferProgress = 0;
        back.transferDirection = 1;
        back.transferActive = true;
      }
    }

    if (back.cargoKey === null) return;
    // 接收方被占用时货留 step2 锚点原位等待、每帧重试（不预播送出动画，避免滑入输送线撞上在机货）；
    // 接收方一空闲当帧交付，离台动画由接收方侧的承接平滑承担。排队平移（direction=1）未完成前不得交付。
    if (back.cargoOnBoard) this.tryDeliverOutgoingCargo(model, entityId, 1);
  }

  /** 来料层取货：从目标 conveyor 接管当前持货进指定工位，成功则以货物当前实际位置为起点进入取货插值；无货下帧重试。 */
  private tryAdoptIncomingCargo(model: ModelRuntimeEntry, entityId: string, stationIndex: 0 | 1): void {
    const state = model.liftTelemetry;
    const adopted = this.context.adoptConveyorCargoForLift(entityId, model.assetCode);
    if (!adopted) return;

    const cargoKey = this.getLiftCargoKey(model.assetCode, stationIndex);
    this.disposeLiftCargoByKey(cargoKey);
    adopted.assetCode = model.assetCode;
    adopted.handoff = createCargoHandoffState(adopted);
    this.state.liftCargoMeshes.set(cargoKey, adopted);

    const station = state.stations[stationIndex];
    station.cargoKey = cargoKey;
    station.cargoOnBoard = false;
    // 锚点取货物在来料输送线上的实际位置（通常停在紧靠提升机的末端）；
    // 若取输送线台面中心，插值起点会落在货物后方半个机身，先向后滑再上台（后摇）。
    station.cargoHoldPosition = adopted.root.getAbsolutePosition().clone();
    station.cargoHoldRotation = null;
    station.transferProgress = 0;
    station.transferDirection = 1;
    station.transferActive = true;
  }

  /** 送料层放货交付：目标 conveyor 仅查空闲接收（无视 task）后清理本工位持货状态；预检不过返回 false 保持重试。
   *  交付只在货在台上（锚点原位）时发起，恒进入端落地（preserveAxialPosition=false）。 */
  private tryDeliverOutgoingCargo(model: ModelRuntimeEntry, entityId: string, stationIndex: 0 | 1): boolean {
    const state = model.liftTelemetry;
    const station = state.stations[stationIndex];
    const cargoKey = station.cargoKey;
    if (!cargoKey) return false;
    if (!this.context.deliverLiftCargoToConveyorLayer(entityId, cargoKey, false)) return false;

    this.clearLiftStationState(station);
    return true;
  }

  /** 每帧刷新双工位货箱外观与位姿：台上跟随本工位锚点（台升货自升），交接/排队平移中在另一端与工位锚点间插值；朝向恒锁定朝向。 */
  private updateLiftCargoPoses(model: ModelRuntimeEntry, snapshot: DeviceTelemetrySnapshot, deltaSeconds: number): void {
    const state = model.liftTelemetry;
    for (let stationIndex = 0 as 0 | 1; stationIndex < 2; stationIndex++) {
      const station = state.stations[stationIndex];
      if (station.cargoKey === null) continue;
      const cargo = this.state.liftCargoMeshes.get(station.cargoKey);
      if (!cargo) {
        this.clearLiftStationState(station);
        continue;
      }

      this.host.syncGeneratedCargoVisual(
        cargo, 'lift', snapshot, this.host.resolveCargoGeneratorForModel(model), model.entitySnapshot?.id ?? '',
      );
      const anchor = this.getLiftStationPose(model, stationIndex, cargo.lockedWorldRotation);
      let targetPosition = anchor.position;
      if (!station.cargoOnBoard && station.cargoHoldPosition) {
        targetPosition = Vector3.Lerp(station.cargoHoldPosition, anchor.position, station.transferProgress);
      }

      const pose = resolveCargoHandoffPose(cargo, targetPosition, anchor.rotation, deltaSeconds);
      this.host.setGeneratedCargoRootPose(cargo, pose.position, pose.rotation, null);
    }
  }

  /**
   * 工位锚点：载货面节点包围盒顶面中心沿货物轨迹轴前后错开跨度的四分位（step1=前/来料侧取负，step2=后/送料侧取正）；
   * 轨迹轴不可解析时两工位同取中心。朝向取货箱锁定朝向，未锁定（fresh 刷出）取货物模板自身朝向（世界恒等），不继承机体旋转。
   */
  private getLiftStationPose(model: ModelRuntimeEntry, stationIndex: 0 | 1, lockedRotation: Quaternion | null): { position: Vector3; rotation: Quaternion } {
    const rotation = lockedRotation ?? createCargoSpawnWorldRotation();
    const upAxis = getModelAxis(model.root, 'y');
    const bounds = getNodesWorldBounds(this.findLiftCargoDeckNodes(model));
    const center = bounds
      ? bounds.minimum.add(bounds.maximum).scale(0.5)
      : model.liftTelemetry.rootBasePosition.add(upAxis.scale(model.liftTelemetry.liftOffset));
    if (bounds) center.y = bounds.maximum.y;
    const travel = this.resolveLiftTravelAxis(model);
    if (!travel) return { position: center, rotation };
    const sign = stationIndex === 0 ? -1 : 1;
    return { position: center.add(travel.axis.scale(sign * travel.stationOffset)), rotation };
  }

  // ===== 货物轨迹轴（工位锚点分区） =====

  /**
   * 解析载物台货物轨迹轴并缓存：dataDriven.motion.lift.travelAxis 声明优先（'x'/'-x'/'z'/'-z' 或模型局部向量），
   * 否则从来料/送料绑定表各取首个可解析 conveyor 支撑点，水平差向量（来料→送料为正）归一为轴；
   * 按两表实体集签名缓存，绑定变化失效重建；不可解析时缓存空轴（两工位锚点退化为台面中心）。
   */
  private resolveLiftTravelAxis(model: ModelRuntimeEntry): LiftTravelAxisCache | null {
    const state = model.liftTelemetry;
    const signature = this.computeLiftBindingsSignature(model);
    if (state.travelAxis && state.travelAxis.bindingsSignature === signature) {
      return state.travelAxis.axis.lengthSquared() > 1e-8 ? state.travelAxis : null;
    }

    const axis = this.readLiftTravelAxisOverride(model) ?? this.inferLiftTravelAxisFromBindings(model);
    if (!axis) {
      state.travelAxis = { axis: Vector3.Zero(), stationOffset: 0, bindingsSignature: signature };
      return null;
    }

    let stationOffset = 0;
    const bounds = getNodesWorldBounds(this.findLiftCargoDeckNodes(model));
    if (bounds) {
      const projected = projectWorldBoundsOntoAxis(bounds, axis);
      stationOffset = Math.max((projected.max - projected.min) / 4, 0);
    }
    state.travelAxis = { axis, stationOffset, bindingsSignature: signature };
    return state.travelAxis;
  }

  /** 绑定表实体集签名：来料+送料两表「层号:实体列表」排序序列化，供轨迹轴缓存失效判定。 */
  private computeLiftBindingsSignature(model: ModelRuntimeEntry): string {
    const flatten = (table: Record<string, string[]> | undefined): string => Object.keys(table ?? {})
      .sort((a, b) => Number(a) - Number(b))
      .map((layer) => `${layer}:${[...(table?.[layer] ?? [])].sort().join(',')}`)
      .join('|');
    return `${flatten(model.telemetryBinding?.incomingLayerBindings)}#${flatten(model.telemetryBinding?.outgoingLayerBindings)}`;
  }

  /** 从绑定表推断轨迹轴：来料/送料侧各取首个可解析 conveyor 支撑点，水平差向量（来料→送料）归一；任一侧不可解析返回 null。 */
  private inferLiftTravelAxisFromBindings(model: ModelRuntimeEntry): Vector3 | null {
    const incoming = this.firstLayerSurfacePoint(model, 0);
    const outgoing = this.firstLayerSurfacePoint(model, 1);
    if (!incoming || !outgoing) return null;
    const delta = outgoing.subtract(incoming);
    delta.y = 0;
    return delta.lengthSquared() > 1e-8 ? delta.normalize() : null;
  }

  /** 取指定侧绑定表中首个可解析 conveyor 支撑点世界坐标（层号升序、表内顺序）。 */
  private firstLayerSurfacePoint(model: ModelRuntimeEntry, side: 0 | 1): Vector3 | null {
    const table = side === 0
      ? model.telemetryBinding?.incomingLayerBindings
      : model.telemetryBinding?.outgoingLayerBindings;
    for (const layer of Object.keys(table ?? {}).sort((a, b) => Number(a) - Number(b))) {
      for (const entityId of table?.[layer] ?? []) {
        const point = this.context.resolveConveyorDeckSurfacePoint(entityId);
        if (point) return point;
      }
    }
    return null;
  }

  /** 读取模型脚本 dataDriven.motion.lift.travelAxis 覆盖声明：'x'/'-x'/'z'/'-z' 或模型局部三分量向量，归一到世界水平轴。 */
  private readLiftTravelAxisOverride(model: ModelRuntimeEntry): Vector3 | null {
    for (const dataDriven of model.externalScriptRuntime?.getDataDrivenConfigs() ?? []) {
      const value = this.readPath(dataDriven, ['motion', 'lift', 'travelAxis']);
      const axis = this.parseLiftTravelAxisValue(model, value);
      if (axis) return axis;
    }
    return null;
  }

  /** 解析 travelAxis 声明值：字符串轴向取模型水平轴（负号反向），数组按模型局部向量变换到世界后取水平投影。 */
  private parseLiftTravelAxisValue(model: ModelRuntimeEntry, value: unknown): Vector3 | null {
    let local: Vector3 | null = null;
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      const negative = normalized.startsWith('-');
      const axisName = normalized.replace(/^-/, '');
      if (axisName !== 'x' && axisName !== 'z') return null;
      local = getHorizontalModelAxis(model.root, axisName);
      if (negative) local = local.negate();
      return local.lengthSquared() > 1e-8 ? local : null;
    }
    if (Array.isArray(value) && value.length === 3 && value.every((n) => typeof n === 'number' && Number.isFinite(n))) {
      const world = Vector3.TransformNormal(
        new Vector3(value[0] as number, value[1] as number, value[2] as number),
        model.root.computeWorldMatrix(true),
      );
      world.y = 0;
      return world.lengthSquared() > 1e-8 ? world.normalize() : null;
    }
    return null;
  }

  /** 按路径读取任意配置值，供模型脚本 dataDriven 扩展字段使用。 */
  private readPath(source: unknown, path: string[]): unknown {
    let current: unknown = source;
    for (const key of path) {
      if (!isPlainRecord(current)) return undefined;
      current = current[key];
    }
    return current;
  }

  // ===== 层绑定解析 =====

  /** 解析层绑定候选并按交接语义仲裁：来料侧取持货方，送料侧取空闲方（无视 task——lift task 号与输送线无关），无匹配回退首个候选。 */
  private resolveLiftLayerCandidate(model: ModelRuntimeEntry, side: 0 | 1, layer: number): LiftLayerCandidate | null {
    const candidates = this.resolveLiftLayerCandidates(model, side, layer);
    if (candidates.length === 0) return null;

    if (side === 0) {
      return candidates.find((candidate) => candidate.conveyor.conveyorTelemetry.cargoCode !== null)
        ?? candidates[0];
    }

    return candidates.find((candidate) => candidate.conveyor.conveyorTelemetry.cargoCode === null)
      ?? candidates[0];
  }

  /** 解析层号绑定的全部候选实体：仅 conveyor 参与交接；未绑定或实体已删除一次性告警并剔除。 */
  private resolveLiftLayerCandidates(model: ModelRuntimeEntry, side: 0 | 1, layer: number): LiftLayerCandidate[] {
    const table = side === 0
      ? model.telemetryBinding?.incomingLayerBindings
      : model.telemetryBinding?.outgoingLayerBindings;
    const bindings = table?.[String(layer)];
    const sideLabel = side === 0 ? '来料' : '送料';
    if (!bindings || bindings.length === 0) {
      this.reportLiftIssueOnce(
        `lift-layer-unbound:${model.assetCode}:${side}:${layer}`,
        `提升机 ${model.assetCode} ${sideLabel}层 ${layer} 未绑定场景实体，该层不响应不移动。`,
      );
      return [];
    }

    const candidates: LiftLayerCandidate[] = [];
    for (const entityId of bindings) {
      const conveyor = this.findConveyorModelByEntityId(entityId);
      const surfacePoint = this.context.resolveConveyorDeckSurfacePoint(entityId);
      if (!conveyor || !surfacePoint) {
        this.reportLiftIssueOnce(
          `lift-layer-missing:${model.assetCode}:${side}:${layer}:${entityId}`,
          `提升机 ${model.assetCode} ${sideLabel}层 ${layer} 绑定的实体不存在或不是输送线，已忽略该实体定位。`,
        );
        continue;
      }
      candidates.push({ entityId, surfacePoint, conveyor });
    }
    return candidates;
  }

  /** 按实体 ID 找 conveyor 模型：命中非 conveyor 或实体不存在返回 null。 */
  private findConveyorModelByEntityId(entityId: string): ModelRuntimeEntry | null {
    for (const entry of this.host.collectModels()) {
      if (entry.entityId !== entityId) continue;
      return isConveyorRuntimeModel(entry.model) ? entry.model : null;
    }
    return null;
  }

  // ===== 货箱生命周期 =====

  /** 生成提升机工位货箱的唯一键：每台设备双工位（0=step1 前，1=step2 后）各最多一箱。 */
  getLiftCargoKey(assetCode: string, stationIndex: 0 | 1): string {
    return JSON.stringify([assetCode, stationIndex]);
  }

  /** 按键销毁提升机运行时货箱，map 中不存在时幂等跳过。 */
  private disposeLiftCargoByKey(key: string): void {
    const cargo = this.state.liftCargoMeshes.get(key);
    if (!cargo) return;
    this.host.disposeGeneratedCargo(cargo);
    this.state.liftCargoMeshes.delete(key);
  }

  /** 其他设备凭同一 task 接管本货箱：清理引用该货箱的工位遥测引用后从表中取出（不销毁），实例交给接管方保持视觉连续。
   *  出站离台时启动承接冷却：step1→step2 排队平移须等离台货在接收方侧的承接平滑播完再启动。 */
  detachClaimedCargoByKey(key: string): LiftCargoRuntimeEntry | null {
    const cargo = this.state.liftCargoMeshes.get(key);
    if (!cargo) return null;
    for (const { model } of this.host.collectModels()) {
      for (const station of model.liftTelemetry.stations) {
        if (station.cargoKey === key) {
          this.clearLiftStationState(station);
          model.liftTelemetry.outgoingHandoffCooldown = CARGO_HANDOFF_SECONDS;
        }
      }
    }
    this.state.liftCargoMeshes.delete(key);
    return cargo;
  }

  /** 删除指定提升机实例生成的全部运行时货箱，不污染场景文档。 */
  disposeLiftCargoForAssetCode(assetCode: string): void {
    for (const [key, cargo] of this.state.liftCargoMeshes.entries()) {
      if (cargo.assetCode !== assetCode) continue;
      this.host.disposeGeneratedCargo(cargo);
      this.state.liftCargoMeshes.delete(key);
    }
  }

  /** 外部拉取就绪门控：仅当载货台到位、货在台上且非交接中才允许 pull 摘除，防止升降/交接中途摘货；
   *  step1（前工位）货在 step2 占用时不可拉走，保持 step2 先出的排队顺序。 */
  isLiftCargoReadyForExternalPull(cargo: GeneratedCargoRuntimeEntry): boolean {
    for (const { model } of this.host.collectModels()) {
      const state = model.liftTelemetry;
      for (let index = 0; index < state.stations.length; index += 1) {
        const station = state.stations[index];
        if (station.cargoKey && this.state.liftCargoMeshes.get(station.cargoKey) === cargo) {
          if (index === 0 && state.stations[1].cargoKey !== null) return false;
          return state.arrivedTargetKey !== null
            && state.arrivedTargetKey === state.targetKey
            && station.cargoOnBoard
            && !station.transferActive;
        }
      }
    }
    return false;
  }

  /** 清空单个工位的货箱状态。 */
  private clearLiftStationState(station: LiftStationState): void {
    station.cargoKey = null;
    station.cargoOnBoard = false;
    station.cargoHoldPosition = null;
    station.cargoHoldRotation = null;
    station.transferProgress = 0;
    station.transferDirection = 1;
    station.transferActive = false;
  }

  // ===== 诊断与配置读取 =====

  /** 对故障做一次性 Console 提示，避免每帧刷屏；info 类状态不进编辑器 Console。 */
  private reportLiftRuntimeState(snapshot: DeviceTelemetrySnapshot): void {
    const deviceKey = `${snapshot.sourceId}:${snapshot.deviceType}:${snapshot.assetCode}`;
    if (!snapshot.faulted) {
      this.state.reportedFaults.delete(deviceKey);
      return;
    }

    const faultMessage = snapshot.message || `errorCode=${readIntegerField(snapshot.fields, 'errorCode') ?? 0}`;
    if (this.state.reportedFaults.get(deviceKey) === faultMessage) return;

    this.state.reportedFaults.set(deviceKey, faultMessage);
    this.host.pushLog(`提升机 ${snapshot.assetCode} 故障/急停：${faultMessage}`);
  }

  /** 提升机运行问题按稳定 key 只写一次 Console。 */
  private reportLiftIssueOnce(key: string, message: string): void {
    if (this.state.reportedMissingTargets.has(key)) return;
    this.state.reportedMissingTargets.add(key);
    this.host.pushLog(message);
  }

  /** 读取模型脚本 dataDriven.motion.lift.nodes 声明的载货台随动节点名。 */
  private readLiftMotionNodeNames(model: ModelRuntimeEntry): string[] {
    for (const dataDriven of model.externalScriptRuntime?.getDataDrivenConfigs() ?? []) {
      const nodes = readStringArrayPath(dataDriven, ['motion', 'lift', 'nodes']);
      if (nodes.length > 0) return nodes;
    }
    return [];
  }

  /** 读取模型脚本 dataDriven.cargo.nodes 声明的载货面节点名。 */
  private readLiftCargoNodeNames(model: ModelRuntimeEntry): string[] {
    for (const dataDriven of model.externalScriptRuntime?.getDataDrivenConfigs() ?? []) {
      const nodes = readStringArrayPath(dataDriven, ['cargo', 'nodes']);
      if (nodes.length > 0) return nodes;
    }
    return [];
  }

  /** 读取载货台升降速度（米/秒）：Inspector liftSpeed 参数优先，其次 dataDriven.motion.lift.speed，最后常量兜底（同 stacker 优先级）。 */
  private readLiftSpeed(model: ModelRuntimeEntry): number {
    const inspectorSpeed = model.entitySnapshot?.components.modelAsset?.parameterValues?.liftSpeed;
    if (typeof inspectorSpeed === 'number' && Number.isFinite(inspectorSpeed) && inspectorSpeed > 0) {
      return inspectorSpeed;
    }
    return this.readLiftDataDrivenNumber(model, ['motion', 'lift', 'speed'])
      ?? LIFT_DEFAULT_LIFT_SPEED_METERS_PER_SECOND;
  }

  /** 读取模型脚本 dataDriven 声明的数值配置。 */
  private readLiftDataDrivenNumber(model: ModelRuntimeEntry, path: string[]): number | null {
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
