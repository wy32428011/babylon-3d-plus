import type { Scene } from '@babylonjs/core';
import { Quaternion, TransformNode, Vector3 } from '@babylonjs/core';
import {
  clampNumber,
  filterTopLevelMotionNodes,
  findModelNodesByName,
  getModelAxis,
  getModelTransformNodes,
  getNodesProjectedBounds,
  getNodesWorldBounds,
  moveNumberTowards,
  projectWorldBoundsOntoAxis,
  worldDeltaToParentLocalDelta,
} from '../../runtimeNodeGeometry';
import { isPlainRecord, readStringArrayPath, sanitizeBabylonName } from '../../runtimeValueUtils';
import { readIntegerField, type DeviceTelemetrySnapshot } from '../../../mqtt/deviceTelemetry';
import type { ModelRuntimeEntry } from '../../SceneRuntime';
import { writeDeviceTelemetryMetadata } from './telemetryMetadata';
import { isConveyorRuntimeModel } from './specializedModelAssets';
import {
  createCargoHandoffState,
  createCargoSpawnWorldRotation,
  resolveCargoHandoffPose,
  type GeneratedCargoRuntimeEntry,
  LIFT_DEFAULT_LIFT_SPEED_METERS_PER_SECOND,
  type LiftCargoRuntimeEntry,
  RGV_CARGO_TRANSFER_SECONDS,
  type SpecializedTelemetryDriverContext,
  type SpecializedTelemetryHost,
  type SpecializedTelemetrySharedState,
  type StackerLiftConstraint,
} from './types';

/** 层候选：绑定实体 + 货物支撑面世界坐标 + 已确认为 conveyor 的模型条目。 */
type LiftLayerCandidate = { entityId: string; surfacePoint: Vector3; conveyor: ModelRuntimeEntry };

/**
 * 物料提升机（lift）遥测驱动：RGV 的垂直版——载货台沿模型 Y 轴升降，层绑定分来料/送料两张表。
 * reference_upper_step（1=来料侧/2=送料侧）+ level_upper（该侧目标层号）组成目标键做边沿检测，
 * 目标层绑定 conveyor 的货物支撑面世界 Y 决定载货台目标偏移；movement_y 字段不消费。
 * 到位自动交接：来料层到位且台上无货→从绑定 conveyor 取货上台；送料层到位且台上有货→向绑定 conveyor 放货；
 * 送料侧无等待方时货物滞留台上持续重试，不销毁。单车单货，货箱全程只平移不旋转。
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

  /** 对单台提升机应用载货台升降与到位自动交接的遥测驱动。 */
  applyToModel(model: ModelRuntimeEntry, snapshot: DeviceTelemetrySnapshot, deltaSeconds: number): void {
    this.reportLiftRuntimeState(snapshot);
    writeDeviceTelemetryMetadata(model, snapshot);
    this.applyLiftMotion(model, snapshot, deltaSeconds);
    this.applyLiftNodeMotionOffsets(model);
    this.applyLiftCargoHandoff(model, snapshot, deltaSeconds);
  }

  // ===== 载货台升降 =====

  /** 目标层信号驱动载货台沿 Y 轴升降；目标键变化时重解析层绑定并换算目标偏移。 */
  private applyLiftMotion(model: ModelRuntimeEntry, snapshot: DeviceTelemetrySnapshot, deltaSeconds: number): void {
    const state = model.liftTelemetry;
    const upAxis = getModelAxis(model.root, 'y');

    // 协议侧别映射：reference_upper_step 1=来料侧（内部 0），2=送料侧（内部 1），其它值无目标
    const sideValue = readIntegerField(snapshot.fields, 'reference_upper_step');
    const side = sideValue === 1 ? 0 : sideValue === 2 ? 1 : null;
    const layerValue = readIntegerField(snapshot.fields, 'level_upper');
    const layer = layerValue !== null && layerValue > 0 ? layerValue : null;
    const targetKey = side !== null && layer !== null ? `${side}:${layer}` : null;

    if (!snapshot.faulted && targetKey !== null && targetKey !== state.targetKey) {
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

    if (!snapshot.faulted && state.liftTargetOffset !== null) {
      const speed = this.readLiftSpeed(model);
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

  // ===== 到位自动交接 =====

  /**
   * 到位锁命中后按目标侧自动交接：
   * 来料层（side 0）到位且台上无货→每帧幂等尝试从绑定 conveyor 取货，成功后进入取货插值（0→1）；
   * 送料层（side 1）到位且台上有货→当场先试交付，无等待方进入放货插值（1→0），插值结束仍未交付持续重试，不销毁。
   */
  private applyLiftCargoHandoff(model: ModelRuntimeEntry, snapshot: DeviceTelemetrySnapshot, deltaSeconds: number): void {
    const state = model.liftTelemetry;
    const arrived = !snapshot.faulted
      && state.arrivedTargetKey !== null
      && state.arrivedTargetKey === state.targetKey
      && state.targetEntityId !== null;

    if (arrived && state.targetSide === 0 && state.cargoKey === null && !state.transferActive) {
      this.tryAdoptIncomingCargo(model, state.targetEntityId as string);
    }

    if (state.cargoKey !== null && !state.cargoOnBoard && state.transferActive) {
      const direction = state.targetSide === 1 ? -1 : 1;
      state.transferProgress = clampNumber(
        state.transferProgress + (direction * deltaSeconds) / RGV_CARGO_TRANSFER_SECONDS,
        0,
        1,
      );
      if (state.transferProgress >= 1 && direction === 1) {
        state.cargoOnBoard = true;
        state.transferActive = false;
        state.cargoHoldPosition = null;
        state.cargoHoldRotation = null;
      }
    }

    if (arrived && state.targetSide === 1 && state.cargoKey !== null) {
      if (state.cargoOnBoard) {
        // 到位当场先试交付：等待方已就绪则直接放行，否则进入放货插值
        if (!this.tryDeliverOutgoingCargo(model, state.targetEntityId as string)) {
          const surfacePoint = this.context.resolveConveyorDeckSurfacePoint(state.targetEntityId as string);
          if (surfacePoint) {
            state.cargoOnBoard = false;
            state.cargoHoldPosition = surfacePoint;
            state.transferProgress = 1;
            state.transferActive = true;
          }
        }
      } else if (state.transferActive) {
        // 放货插值进行中/已到输送线侧：每帧重试交付，无等待方货物滞留不销毁
        this.tryDeliverOutgoingCargo(model, state.targetEntityId as string);
      }
    }

    this.updateLiftCargoPose(model, snapshot, deltaSeconds);
  }

  /** 来料层取货：从目标 conveyor 接管当前持货，成功则以货物当前实际位置为起点进入取货插值；无货下帧重试。 */
  private tryAdoptIncomingCargo(model: ModelRuntimeEntry, entityId: string): void {
    const state = model.liftTelemetry;
    const adopted = this.context.adoptConveyorCargoForLift(entityId, model.assetCode);
    if (!adopted) return;

    const cargoKey = this.getLiftCargoKey(model.assetCode);
    this.disposeLiftCargoByKey(cargoKey);
    adopted.assetCode = model.assetCode;
    adopted.handoff = createCargoHandoffState(adopted);
    this.state.liftCargoMeshes.set(cargoKey, adopted);

    state.cargoKey = cargoKey;
    state.cargoOnBoard = false;
    // 锚点取货物在来料输送线上的实际位置（通常停在紧靠提升机的末端）；
    // 若取输送线台面中心，插值起点会落在货物后方半个机身，先向后滑再上台（后摇）。
    state.cargoHoldPosition = adopted.root.getAbsolutePosition().clone();
    state.cargoHoldRotation = null;
    state.transferProgress = 0;
    state.transferActive = true;
  }

  /** 送料层放货交付：目标 conveyor 接收（settle+广播）后清理本机持货状态；预检不过返回 false 保持重试。 */
  private tryDeliverOutgoingCargo(model: ModelRuntimeEntry, entityId: string): boolean {
    const state = model.liftTelemetry;
    const cargoKey = state.cargoKey;
    if (!cargoKey) return false;
    const task = this.state.liftCargoMeshes.get(cargoKey)?.task ?? '';
    // 对齐 RGV 滞后承接语义（rgvDriver.tryDeliverRgvCargoToColumn）：放货插值已推进（progress<1，
    // 货物在离台途中/已到输送线侧）属接收方 task 消息滞后的兜底交付，按货物当前轴向投影落地；
    // 到位当场交付（progress=1，货仍在台上）保持进入端落地。否则交付成功瞬间货物被拽回进入端（后摇）。
    const preserveAxialPosition = state.transferProgress < 1;
    if (!this.context.deliverLiftCargoToConveyorLayer(entityId, cargoKey, task, preserveAxialPosition)) return false;

    this.clearLiftCargoState(model);
    return true;
  }

  /** 每帧刷新货箱外观与位姿：台上跟随载货台顶面锚点（台升货自升），交接中在输送线支撑点与台工位间插值；朝向恒锁定朝向。 */
  private updateLiftCargoPose(model: ModelRuntimeEntry, snapshot: DeviceTelemetrySnapshot, deltaSeconds: number): void {
    const state = model.liftTelemetry;
    const cargoKey = state.cargoKey;
    if (!cargoKey) return;
    const cargo = this.state.liftCargoMeshes.get(cargoKey);
    if (!cargo) {
      this.clearLiftCargoState(model);
      return;
    }

    this.host.syncGeneratedCargoVisual(cargo, 'lift', snapshot, this.host.resolveCargoGeneratorForModel(model));
    const station = this.getLiftStationPose(model, cargo.lockedWorldRotation);
    let targetPosition = station.position;
    if (!state.cargoOnBoard && state.cargoHoldPosition) {
      targetPosition = Vector3.Lerp(state.cargoHoldPosition, station.position, state.transferProgress);
    }

    const pose = resolveCargoHandoffPose(cargo, targetPosition, station.rotation, deltaSeconds);
    this.host.setGeneratedCargoRootPose(cargo, pose.position, pose.rotation, null);
  }

  /** 台工位锚点：载货面节点包围盒顶面中心；朝向取货箱锁定朝向，未锁定（fresh 刷出）取货物模板自身朝向（世界恒等），不继承机体旋转。 */
  private getLiftStationPose(model: ModelRuntimeEntry, lockedRotation: Quaternion | null): { position: Vector3; rotation: Quaternion } {
    const rotation = lockedRotation ?? createCargoSpawnWorldRotation();
    const bounds = getNodesWorldBounds(this.findLiftCargoDeckNodes(model));
    if (!bounds) {
      const upAxis = getModelAxis(model.root, 'y');
      return { position: model.liftTelemetry.rootBasePosition.add(upAxis.scale(model.liftTelemetry.liftOffset)), rotation };
    }
    const position = bounds.minimum.add(bounds.maximum).scale(0.5);
    position.y = bounds.maximum.y;
    return { position, rotation };
  }

  // ===== 层绑定解析 =====

  /** 解析层绑定候选并按交接语义仲裁：来料侧取持货方，送料侧取等待/空闲方，无匹配回退首个候选。 */
  private resolveLiftLayerCandidate(model: ModelRuntimeEntry, side: 0 | 1, layer: number): LiftLayerCandidate | null {
    const candidates = this.resolveLiftLayerCandidates(model, side, layer);
    if (candidates.length === 0) return null;

    if (side === 0) {
      return candidates.find((candidate) => candidate.conveyor.conveyorTelemetry.cargoCode !== null)
        ?? candidates[0];
    }

    const state = model.liftTelemetry;
    const task = state.cargoKey ? this.state.liftCargoMeshes.get(state.cargoKey)?.task ?? '' : '';
    return candidates.find((candidate) => {
      const conveyorState = candidate.conveyor.conveyorTelemetry;
      if (conveyorState.cargoCode !== null) return false;
      return task === '' || conveyorState.pendingTask === task || conveyorState.waitingTask === task;
    }) ?? candidates.find((candidate) => candidate.conveyor.conveyorTelemetry.cargoCode === null)
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
        `提升机 ${model.assetCode} ${sideLabel}层 ${layer} 未绑定场景实体，已忽略该层定位。`,
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

  /** 生成提升机运行时货箱的唯一键：每台设备同时最多携带一箱。 */
  getLiftCargoKey(assetCode: string): string {
    return JSON.stringify([assetCode]);
  }

  /** 创建或复用提升机运行时货箱。 */
  getOrCreateLiftCargo(assetCode: string): LiftCargoRuntimeEntry {
    const key = this.getLiftCargoKey(assetCode);
    const existing = this.state.liftCargoMeshes.get(key);
    if (existing) return existing;

    const root = new TransformNode(`lift_cargo_root_${sanitizeBabylonName(assetCode)}`, this.scene);
    const entry: LiftCargoRuntimeEntry = {
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
    this.state.liftCargoMeshes.set(key, entry);
    return entry;
  }

  /** 按键销毁提升机运行时货箱，map 中不存在时幂等跳过。 */
  private disposeLiftCargoByKey(key: string): void {
    const cargo = this.state.liftCargoMeshes.get(key);
    if (!cargo) return;
    this.host.disposeGeneratedCargo(cargo);
    this.state.liftCargoMeshes.delete(key);
  }

  /** 其他设备凭同一 task 接管本货箱：清理引用该货箱的模型遥测引用后从表中取出（不销毁），实例交给接管方保持视觉连续。 */
  detachClaimedCargoByKey(key: string): LiftCargoRuntimeEntry | null {
    const cargo = this.state.liftCargoMeshes.get(key);
    if (!cargo) return null;
    for (const { model } of this.host.collectModels()) {
      if (model.liftTelemetry.cargoKey === key) this.clearLiftCargoState(model);
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

  /** 外部拉取就绪门控：仅当载货台到位、货在台上且非交接中才允许 pull 摘除，防止升降/交接中途摘货。 */
  isLiftCargoReadyForExternalPull(cargo: GeneratedCargoRuntimeEntry): boolean {
    for (const { model } of this.host.collectModels()) {
      const state = model.liftTelemetry;
      if (state.cargoKey && this.state.liftCargoMeshes.get(state.cargoKey) === cargo) {
        return state.arrivedTargetKey !== null
          && state.arrivedTargetKey === state.targetKey
          && state.cargoOnBoard
          && !state.transferActive;
      }
    }
    return false;
  }

  /** 清空本机全部货箱状态。 */
  private clearLiftCargoState(model: ModelRuntimeEntry): void {
    const state = model.liftTelemetry;
    state.cargoKey = null;
    state.cargoOnBoard = false;
    state.cargoHoldPosition = null;
    state.cargoHoldRotation = null;
    state.transferProgress = 0;
    state.transferActive = false;
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
