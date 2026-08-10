import type { Scene } from '@babylonjs/core';
import { Quaternion, TransformNode, Vector3 } from '@babylonjs/core';
import {
  clampNumber,
  createLocalAxis,
  filterTopLevelMotionNodes,
  findModelNodes,
  getHorizontalModelAxis,
  getModelAxis,
  getModelTransformNodes,
  getNodeWorldRotation,
  getNodesWorldBounds,
  projectWorldBoundsOntoAxis,
} from '../../runtimeNodeGeometry';
import { isPlainRecord, sanitizeBabylonName } from '../../runtimeValueUtils';
import {
  readBooleanField,
  readIntegerField,
  readNumberField,
  readStringField,
  type DeviceTelemetrySnapshot,
} from '../../../mqtt/deviceTelemetry';
import { resolveConveyorCargoTravelHalfRange } from '../conveyorCargoTravel';
import type { ModelRuntimeEntry } from '../../SceneRuntime';
import { readConveyorCargoSignalFields, readConveyorMotionConfigs, readConveyorTravelAxisFromConfigs, isConveyorRuntimeModel, isRgvRuntimeModel } from './specializedModelAssets';
import { writeDeviceTelemetryMetadata } from './telemetryMetadata';
import {
  type ConveyorCargoRuntimeEntry,
  type ConveyorMotionConfig,
  type ConveyorNodeBaseline,
  CONVEYOR_CARGO_SIZE,
  CONVEYOR_DEFAULT_TRANSLATE_LOOP_METERS,
  CONVEYOR_DEFAULT_TRANSLATE_SPEED_METERS_PER_SECOND,
  createCargoHandoffState,
  type GeneratedCargoRuntimeEntry,
  normalizeCargoTask,
  resolveCargoHandoffPose,
  type SpecializedTelemetryDriverContext,
  type SpecializedTelemetryHost,
  type SpecializedTelemetrySharedState,
} from './types';

/** 输送线运行时单货物固定身份键：刷出与走行不依赖光电信号，位置只由 movement_x 方向决定。 */
const CONVEYOR_CARGO_IDENTITY = 'cargo';

export class ConveyorTelemetryDriver {
  /** 探测点订阅序号：单调递增，多下游订阅同一上游时先订阅者（seq 小）先被推送。 */
  private nextProbeSubscriptionSeq = 0;

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

  /** 对单条输送线应用滚筒/链条动作、货物占位和状态 metadata。 */
  applyToModel(model: ModelRuntimeEntry, snapshot: DeviceTelemetrySnapshot, deltaSeconds: number): void {
    this.reportConveyorRuntimeState(snapshot);
    writeDeviceTelemetryMetadata(model, snapshot);

    if (!snapshot.faulted) {
      this.applyConveyorMotion(model, snapshot, deltaSeconds);
    }

    this.applyConveyorCargoMotion(model, snapshot, deltaSeconds);
  }

  /** 根据模型脚本 dataDriven.motion 配置驱动 Conveyor 节点。 */
  private applyConveyorMotion(
    model: ModelRuntimeEntry,
    snapshot: DeviceTelemetrySnapshot,
    deltaSeconds: number,
  ): void {
    for (const config of readConveyorMotionConfigs(model)) {
      const direction = this.readConveyorMotionDirection(snapshot, config);
      if (direction === 0) continue;

      const nodes = this.findConveyorMotionNodes(model, config);
      if (nodes.length === 0) continue;

      if (config.kind === 'rotate') {
        const speed = this.readConveyorRotationSpeed(snapshot, config);
        this.rotateConveyorNodes(nodes, config.axis, direction * speed * deltaSeconds);
      } else {
        const nextOffset = this.updateConveyorMotionOffset(model, config, direction * config.speed * deltaSeconds);
        this.translateConveyorNodesFromBaseline(model, nodes, config.axis, nextOffset);
      }
    }
  }

  /**
   * 货物生命周期两种模式：
   * - task 模式（快照携带数值 task 字段）：仅当 task 相对 lastTask 发生变化才登记 pendingTask（新 task 边沿），
   *   边沿当帧即刷出/订阅判定；movement_x 为 0 时按正转（方向 1）处理。
   *   同 task 重复到达（含线体清空后的重发）不再触发刷出+走行。
   * - 匿名模式（无 task 字段）：线体运行即刷出，设备自管理，不参与探测点订阅推送。
   *
   * 探测点订阅/推送协议（货物流转由 3D 场景布局决定，不再按 task 匹配）：
   * - 探测点：轨迹轴向两端各向外延伸一个货箱长度的点；正转探测点对应 movement_x 0/1，反转探测点对应 movement_x 2。
   *   探测点落在其他专用设备（conveyor/stacker/rgv）世界包围盒内即视为上游邻居。
   * - 新 task 边沿：自身持有货物 → 直接复用滞留箱（盖新 task）；否则解析探测点邻居——
   *   有邻居 → 进入等待（waitingTask）并登记订阅 probeSubscription（holderAssetCode+方向+seq，先订阅者 seq 小）；
   *   无邻居且为起点设备（telemetryBinding.cargoOriginDevice）→ 自行创建货箱（movement_x=0 登记自驱移向终点）；
   *   无邻居且非起点 → 仅等待（无订阅对象）。
   * - 等待中：不刷出、不走行；mode 变 0（同时放弃 pendingTask 并退订）、新 task 边沿（退订后重新判定）、
   *   被推送三种方式退出。方向翻转时邻居不变则更新订阅方向保留 seq，邻居变化则重新排队。
   * - 推送：facade 每帧无条件执行 pushCargoToProbeSubscribers（与快照新旧无关）——
   *   持有方一旦在三张货物表中有货，即推送给其订阅者中 seq 最小者（实例不销毁，1 秒交接插值接入），
   *   无需下游再收 MQTT 消息；其余订阅者顺位等下一箱。
   * - 被推送方：cargoTravelOffset 置自身刷出端、按订阅方向自驱走行（断流期间由帧调度驱动，新消息到达恢复字段驱动）。
   * - 持有方完全被动：无订阅者时继续持有（clamp 在行程端点）；mode==2 且双光电无货时
   *   由 telemetryBinding.cargoAutoDispose（缺省不销毁，勾选才销毁）决定销毁或遗留（遗留箱等新 task 复用或被下游推送取走）。
   * 轨迹方向（telemetryBinding.trajectoryDirection）定义为 movement_x 正转时货物的运动方向：
   * 正转（=1）刷在轨迹起点向终点移动；反转（=2）刷在轨迹终点向起点移动。
   */
  private applyConveyorCargoMotion(
    model: ModelRuntimeEntry,
    snapshot: DeviceTelemetrySnapshot,
    deltaSeconds: number,
  ): void {
    const state = model.conveyorTelemetry;
    const signalFields = readConveyorCargoSignalFields(model);
    const frontHasGoods = readBooleanField(snapshot.fields, signalFields.frontHasGoods) ?? false;
    const backHasGoods = readBooleanField(snapshot.fields, signalFields.backHasGoods) ?? false;
    const mode = readIntegerField(snapshot.fields, 'mode');

    // 接管自驱只活到下一条新消息：receivedAt 变化即恢复字段驱动；断流重放（stale 快照）保持不变。
    // mode 变 2/0、新 task 边沿等停止语义都随新消息到达，天然由该清零覆盖。
    if (snapshot.receivedAt !== state.lastSnapshotReceivedAt) {
      state.lastSnapshotReceivedAt = snapshot.receivedAt;
      state.selfDriveDirection = 0;
    }

    // task 语义：数值 0/缺失为无任务；仅新 task 边沿（相对 lastTask 变化）登记。
    // lastTask 持久保存：货物销毁/被推送走后同 task 重发不得重走刷出+走行。
    const taskValue = readIntegerField(snapshot.fields, 'task');
    const taskMode = taskValue !== null;
    const task = normalizeCargoTask(taskValue);
    const newTaskEdge = taskMode && task !== '' && task !== state.lastTask;
    if (newTaskEdge) {
      state.lastTask = task;
      state.currentTask = task;
      state.pendingTask = task;
      // 新 task 取代旧等待：退订旧上游，走新 task 的刷出/订阅判定
      state.waitingTask = null;
      state.probeSubscription = null;
    }

    // 货物走行与链条本体共用同一份 translate 配置（fields+actionMap+speed），避免链/货速度脱节。
    const translateConfig = this.findConveyorCargoTranslateConfig(model);
    const movementDirection = translateConfig
      ? this.readConveyorMotionDirection(snapshot, translateConfig)
      : this.readConveyorMovementDirection(readIntegerField(snapshot.fields, 'movement_x'));
    if (movementDirection !== 0) state.lastMovementDirection = movementDirection;

    // 等待方退出等待：仅 mode === 0（空闲，level 判断覆盖边沿）；持有方货物中途消失不自动退出。
    // mode=2 是销毁条件而非等待退出条件：等待方 mode=2 不退出等待、不影响被推送资格。
    // 退出等待必须同时放弃 pendingTask 并退订，否则当帧立即重新订阅。
    if (mode === 0) {
      if (state.waitingTask !== null) state.pendingTask = null;
      state.waitingTask = null;
      state.probeSubscription = null;
    }

    // 销货条件：mode==2 且双光电（前后）都无货；与线体是否在走行无关。
    if (mode === 2 && !frontHasGoods && !backHasGoods) {
      // 勾选自动销毁时才销毁；缺省不勾选：保留货物与位姿（遗留箱），等下游订阅推送取走或新 task 复用。
      if (model.telemetryBinding?.cargoAutoDispose === true) {
        this.disposeConveyorCargoForAssetCode(model.assetCode);
        state.cargoCode = null;
        return;
      }
      if (!state.cargoCode) return;
    }

    const travelContext = this.resolveConveyorCargoTravelContext(model);
    const cargoAxialLength = CONVEYOR_CARGO_SIZE[travelContext.travelAxisName];
    const travelHalfRange = resolveConveyorCargoTravelHalfRange(travelContext.spanMeters ?? 0, cargoAxialLength);
    const forwardSign = this.readConveyorTrajectoryForwardSign(model, travelContext.travelAxis);
    // 刷出端由运行方向决定：正转刷在轨迹起点向终点移动，反转刷在轨迹终点向起点移动。
    const spawnOffsetForDirection = (direction: number): number => -direction * forwardSign * travelHalfRange;

    // task 模式：新 task 边沿（pendingTask 登记）即刷出/订阅判定，不再等线体运行；movement_x 为 0 时按正转处理。
    // 等待期间 pendingTask 保留，本块每帧幂等重估：方向翻转时切换订阅目标，邻居消失的起点设备随即自建。
    if (taskMode && state.pendingTask) {
      const heldCargo = state.cargoCode !== null
        ? this.state.conveyorCargoMeshes.get(this.getConveyorCargoKey(model.assetCode, state.cargoCode)) ?? null
        : null;
      if (heldCargo) {
        // 滞留箱直接复用：保持位置，盖上新 task，不等待不订阅（无论 autoDispose 与否）。
        heldCargo.task = state.pendingTask;
        const containerCode = readStringField(snapshot.fields, 'containerCode')?.trim() ?? '';
        heldCargo.containerCode = containerCode || heldCargo.containerCode;
        state.pendingTask = null;
        state.waitingTask = null;
        state.probeSubscription = null;
        // movement_x=0 按正转处理：登记自驱从滞留位置继续移向终点（下一条新消息恢复字段驱动）。
        if (movementDirection === 0) state.selfDriveDirection = 1;
      } else {
        const probeDirection = movementDirection !== 0 ? movementDirection : 1;
        const neighbor = this.resolveProbeNeighbor(model, probeDirection);
        if (neighbor) {
          // 上游邻居存在：进入等待并向其订阅，由其持货后主动推送（无需本机再收消息）。
          state.waitingTask = state.pendingTask;
          this.subscribeProbe(model, neighbor.assetCode, probeDirection);
        } else if (model.telemetryBinding?.cargoOriginDevice === true) {
          // 起点设备：探测点未触及上游设备时允许自行创建货箱。
          state.pendingTask = null;
          state.waitingTask = null;
          state.probeSubscription = null;
          state.cargoTravelOffset = spawnOffsetForDirection(probeDirection);
          state.cargoCode = CONVEYOR_CARGO_IDENTITY;
          this.createConveyorCargoForTask(model, snapshot, state.cargoCode);
          if (movementDirection === 0) state.selfDriveDirection = 1;
        } else {
          // 探测点无上游且非起点设备：无货可等，仅挂起等待（无订阅对象）。
          state.waitingTask = state.pendingTask;
          state.probeSubscription = null;
        }
      }
    }

    // 等待中：放弃主动创建货物和运动；接管完全由帧级推送扫描完成，本机断流也能收到推送。
    if (state.waitingTask) return;

    if (!taskMode && !state.cargoCode) {
      // 匿名模式：线体运行即刷出，不再依赖光电信号；单货物身份固定，刷出位置只由运行方向决定。
      if (movementDirection === 0) return;
      state.cargoTravelOffset = spawnOffsetForDirection(movementDirection);
      const cargo = this.getOrCreateConveyorCargo(model.assetCode, CONVEYOR_CARGO_IDENTITY);
      cargo.containerCode = readStringField(snapshot.fields, 'containerCode')?.trim() ?? '';
      cargo.task = '';
      state.cargoCode = CONVEYOR_CARGO_IDENTITY;
    }

    if (!state.cargoCode) return;
    const cargo = this.state.conveyorCargoMeshes.get(this.getConveyorCargoKey(model.assetCode, state.cargoCode));
    if (!cargo) return;

    const cargoSpeed = translateConfig?.speed ?? CONVEYOR_DEFAULT_TRANSLATE_SPEED_METERS_PER_SECOND;
    // 快照 movement 为 0 时回退到接管自驱方向：承接货物控制权后立即走行，不等下一条 MQTT 消息。
    const cargoDirection = movementDirection !== 0 ? movementDirection : state.selfDriveDirection;
    if (!snapshot.faulted && cargoDirection !== 0) {
      state.cargoTravelOffset += cargoDirection * forwardSign * cargoSpeed * deltaSeconds;
    }
    // 每帧按当前行程钳制偏移：货箱前沿到端即停住，参数化改长度后旧偏移也不会把货箱留在机外。
    state.cargoTravelOffset = clampNumber(state.cargoTravelOffset, -travelHalfRange, travelHalfRange);

    this.host.syncGeneratedCargoVisual(cargo, 'conveyor', snapshot, this.host.resolveCargoGeneratorForModel(model));
    const pose = resolveCargoHandoffPose(
      cargo,
      this.getConveyorCargoPosition(model, travelContext, state.cargoTravelOffset),
      getNodeWorldRotation(model.root),
      deltaSeconds,
    );
    this.host.setGeneratedCargoRootPose(cargo, pose.position, pose.rotation);
  }

  /**
   * 帧级推送扫描（facade 每帧调用，与快照新旧无关）：持有方一旦持货，
   * 即把货物推送给其订阅者中 seq 最小者；推送后该订阅者退出等待，其余订阅者顺位等下一箱。
   * 链式接力在同一扫描内逐级传递（A 推 B 后 B 持货，同帧可再推 C）。
   */
  pushCargoToProbeSubscribers(): void {
    const subscribersByHolder = new Map<string, ModelRuntimeEntry[]>();
    for (const { model } of this.host.collectModels()) {
      const subscription = model.conveyorTelemetry?.probeSubscription;
      if (!subscription) continue;
      const list = subscribersByHolder.get(subscription.holderAssetCode) ?? [];
      list.push(model);
      subscribersByHolder.set(subscription.holderAssetCode, list);
    }
    for (const [holderAssetCode, subscribers] of subscribersByHolder) {
      subscribers.sort(
        (a, b) => (a.conveyorTelemetry.probeSubscription?.seq ?? 0) - (b.conveyorTelemetry.probeSubscription?.seq ?? 0),
      );
      // 同组可能有多件货物（如 stacker 双叉）：循环按订阅顺序逐个推送，直到货物或订阅者耗尽。
      for (const subscriber of subscribers) {
        const subscription = subscriber.conveyorTelemetry.probeSubscription;
        if (!subscription || subscription.holderAssetCode !== holderAssetCode) continue;
        const cargo = this.findProbeHeldCargo(holderAssetCode, this.resolveProbePoint(subscriber, subscription.direction));
        if (!cargo) break;
        this.pushCargoToSubscriber(holderAssetCode, cargo, subscriber, subscription.direction);
      }
    }
  }

  /** 向探测点上游设备登记订阅：邻居不变时仅更新方向并保留 seq（先来后到），邻居变化才重新排队。 */
  private subscribeProbe(model: ModelRuntimeEntry, holderAssetCode: string, direction: number): void {
    const state = model.conveyorTelemetry;
    const existing = state.probeSubscription;
    if (existing && existing.holderAssetCode === holderAssetCode) {
      existing.direction = direction;
      return;
    }
    state.probeSubscription = { holderAssetCode, direction, seq: ++this.nextProbeSubscriptionSeq };
  }

  /** 探测点邻居解析（带缓存）：正/反转各解析一次，预览期间模型不动，缓存安全。 */
  private resolveProbeNeighbor(model: ModelRuntimeEntry, direction: number): ModelRuntimeEntry | null {
    const state = model.conveyorTelemetry;
    if (!state.probeNeighbors) {
      state.probeNeighbors = {
        forward: this.findProbeNeighborAssetCode(model, 1),
        reverse: this.findProbeNeighborAssetCode(model, -1),
      };
    }
    const assetCode = direction < 0 ? state.probeNeighbors.reverse : state.probeNeighbors.forward;
    if (!assetCode) return null;
    for (const { model: candidate } of this.host.collectModels()) {
      if (candidate.assetCode === assetCode) return candidate;
    }
    return null;
  }

  /** 探测点世界坐标：轨迹端点沿走行方向向外延伸一个货箱长度（复用刷出端偏移公式）。 */
  private resolveProbePoint(model: ModelRuntimeEntry, direction: number): Vector3 {
    const travelContext = this.resolveConveyorCargoTravelContext(model);
    const cargoAxialLength = CONVEYOR_CARGO_SIZE[travelContext.travelAxisName];
    const travelHalfRange = resolveConveyorCargoTravelHalfRange(travelContext.spanMeters ?? 0, cargoAxialLength);
    const forwardSign = this.readConveyorTrajectoryForwardSign(model, travelContext.travelAxis);
    return this.getConveyorCargoPosition(model, travelContext, -direction * forwardSign * (travelHalfRange + cargoAxialLength));
  }

  /** 探测点落在哪个专用设备（conveyor/stacker/rgv）的世界包围盒内；多个命中取盒中心最近者。 */
  private findProbeNeighborAssetCode(model: ModelRuntimeEntry, direction: number): string | null {
    const probePoint = this.resolveProbePoint(model, direction);
    const epsilon = 0.05;
    let nearestAssetCode: string | null = null;
    let nearestDistance = Infinity;
    for (const { model: candidate } of this.host.collectModels()) {
      if (candidate === model || candidate.assetCode === model.assetCode) continue;
      if (!isConveyorRuntimeModel(candidate) && !isRgvRuntimeModel(candidate) && !candidate.stackerCapable) continue;
      const bounds = this.host.getModelWorldBounds(candidate);
      if (!bounds) continue;
      const { minimum, maximum } = bounds;
      if (probePoint.x < minimum.x - epsilon || probePoint.x > maximum.x + epsilon
        || probePoint.y < minimum.y - epsilon || probePoint.y > maximum.y + epsilon
        || probePoint.z < minimum.z - epsilon || probePoint.z > maximum.z + epsilon) continue;
      const distance = Vector3.DistanceSquared(probePoint, minimum.add(maximum).scale(0.5));
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestAssetCode = candidate.assetCode;
      }
    }
    return nearestAssetCode;
  }

  /** 扫三张货物表找持有方持有的货物；多件时取距参考点最近的一件（如 stacker 双叉各持一箱）。 */
  private findProbeHeldCargo(holderAssetCode: string, nearPoint: Vector3): GeneratedCargoRuntimeEntry | null {
    let nearest: GeneratedCargoRuntimeEntry | null = null;
    let nearestDistance = Infinity;
    const tables = [this.state.stackerCargoMeshes, this.state.conveyorCargoMeshes, this.state.rgvCargoMeshes];
    for (const table of tables) {
      for (const cargo of table.values()) {
        if (cargo.assetCode !== holderAssetCode) continue;
        const distance = Vector3.DistanceSquared(cargo.root.getAbsolutePosition(), nearPoint);
        if (distance < nearestDistance) {
          nearestDistance = distance;
          nearest = cargo;
        }
      }
    }
    return nearest;
  }

  /** 推送货物给订阅者：实例不销毁（交接插值保持视觉连续），订阅者置刷出端并按订阅方向自驱走行。 */
  private pushCargoToSubscriber(
    holderAssetCode: string,
    cargo: GeneratedCargoRuntimeEntry,
    subscriber: ModelRuntimeEntry,
    direction: number,
  ): void {
    const subscriberState = subscriber.conveyorTelemetry;
    const detached = this.context.detachClaimedCargoByReference(cargo);
    if (!detached) return;
    const task = subscriberState.pendingTask ?? subscriberState.currentTask ?? '';
    detached.assetCode = subscriber.assetCode;
    detached.task = task;
    detached.handoff = createCargoHandoffState(detached);

    const travelContext = this.resolveConveyorCargoTravelContext(subscriber);
    const travelHalfRange = resolveConveyorCargoTravelHalfRange(
      travelContext.spanMeters ?? 0,
      CONVEYOR_CARGO_SIZE[travelContext.travelAxisName],
    );
    const forwardSign = this.readConveyorTrajectoryForwardSign(subscriber, travelContext.travelAxis);
    subscriberState.cargoCode = CONVEYOR_CARGO_IDENTITY;
    subscriberState.cargoTravelOffset = -direction * forwardSign * travelHalfRange;
    subscriberState.pendingTask = null;
    subscriberState.waitingTask = null;
    subscriberState.probeSubscription = null;
    // 承接即走行：登记自驱方向，快照断流期间由帧调度继续驱动，新消息到达即恢复字段驱动。
    subscriberState.selfDriveDirection = direction;
    this.state.conveyorCargoMeshes.set(this.getConveyorCargoKey(subscriber.assetCode, CONVEYOR_CARGO_IDENTITY), detached);
    this.host.pushLog(`Conveyor ${subscriber.assetCode} 凭探测点订阅接管 ${holderAssetCode} 持有的货物（task=${task || '匿名'}）`);
  }

  /** task 模式刷出：探测点无上游的起点设备自建货箱。 */
  private createConveyorCargoForTask(
    model: ModelRuntimeEntry,
    snapshot: DeviceTelemetrySnapshot,
    cargoCode: string,
  ): void {
    const cargo = this.getOrCreateConveyorCargo(model.assetCode, cargoCode);
    cargo.task = model.conveyorTelemetry.currentTask ?? '';
    cargo.containerCode = readStringField(snapshot.fields, 'containerCode')?.trim() ?? '';
  }

  /** 按 motion.fields 读取输送线方向，支持模型脚本自定义 actionMap。 */
  private readConveyorMotionDirection(snapshot: DeviceTelemetrySnapshot, config: ConveyorMotionConfig): number {
    for (const field of config.fields) {
      const fieldValue = readNumberField(snapshot.fields, field);
      if (fieldValue === null) continue;

      const mappedValue = config.actionMap[String(Math.trunc(fieldValue))];
      if (Number.isFinite(mappedValue)) return mappedValue;
      return this.readConveyorMovementDirection(fieldValue);
    }

    return 0;
  }

  /** 输送线 movement_x 编码：0 静止，1 正向，2 反向，正负数做现场兼容兜底。 */
  private readConveyorMovementDirection(value: number | null): number {
    if (value === 1) return 1;
    if (value === 2) return -1;
    if (value !== null && value > 0) return 1;
    if (value !== null && value < 0) return -1;
    return 0;
  }

  /** 读取滚筒角速度，rotation 大于 3 时按度/秒处理，否则沿用模型脚本默认速度。 */
  private readConveyorRotationSpeed(snapshot: DeviceTelemetrySnapshot, config: ConveyorMotionConfig): number {
    const rotationSpeed = readNumberField(snapshot.fields, 'rotation');
    const degreesPerSecond = rotationSpeed !== null && rotationSpeed > 3 ? rotationSpeed : config.speed;
    return degreesPerSecond * Math.PI / 180;
  }

  /** 查找输送线 motion 声明的节点，优先精确名称，失败后按 fallbackPattern 或通用名称兜底。 */
  private findConveyorMotionNodes(model: ModelRuntimeEntry, config: ConveyorMotionConfig): TransformNode[] {
    const configuredNodes = config.nodes.length > 0
      ? this.findConfiguredConveyorMotionNodes(model, config.nodes)
      : [];
    if (configuredNodes.length > 0) return filterTopLevelMotionNodes(configuredNodes);

    const fallbackPattern = this.createConveyorFallbackPattern(config.fallbackPattern);
    return fallbackPattern ? filterTopLevelMotionNodes(findModelNodes(model, this.scene, fallbackPattern)) : [];
  }

  /**
   * 按 motion.nodes 收集原始节点及其参数化运行时克隆。
   * 参数脚本通过 metadata.motionSourceNodeName 声明克隆继承哪个源节点的遥测动作，
   * 同时兼容旧脚本已经写入的 metadata.sourceNodeName。
   */
  private findConfiguredConveyorMotionNodes(model: ModelRuntimeEntry, names: string[]): TransformNode[] {
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

  /** 创建模型脚本显式声明的兜底正则；未声明或非法时跳过，避免猜中静态结构。 */
  private createConveyorFallbackPattern(patternText: string | null): RegExp | null {
    if (!patternText) return null;
    try {
      return new RegExp(patternText, 'i');
    } catch {
      return null;
    }
  }

  /** 按局部轴旋转滚筒节点，兼容 GLB 节点使用 rotationQuaternion 的情况。 */
  private rotateConveyorNodes(nodes: TransformNode[], axis: 'x' | 'y' | 'z', radians: number): void {
    if (Math.abs(radians) <= 0.000001) return;
    const deltaRotation = Quaternion.RotationAxis(createLocalAxis(axis), radians);

    for (const node of nodes) {
      if (node.rotationQuaternion) {
        node.rotationQuaternion = node.rotationQuaternion.multiply(deltaRotation);
      } else {
        node.rotation[axis] += radians;
      }
    }
  }

  /** 更新链条平移偏移，使用循环偏移避免节点长期漂移到模型外。 */
  private updateConveyorMotionOffset(model: ModelRuntimeEntry, config: ConveyorMotionConfig, delta: number): number {
    const previousOffset = model.conveyorTelemetry.motionOffsets.get(config.key) ?? 0;
    const nextOffset = this.wrapConveyorOffset(previousOffset + delta);
    model.conveyorTelemetry.motionOffsets.set(config.key, nextOffset);
    return nextOffset;
  }

  /** 从首次驱动前的节点基线出发做局部轴平移，避免每帧累计误差。 */
  private translateConveyorNodesFromBaseline(
    model: ModelRuntimeEntry,
    nodes: TransformNode[],
    axis: 'x' | 'y' | 'z',
    offset: number,
  ): void {
    const localOffset = createLocalAxis(axis).scale(offset);
    for (const node of filterTopLevelMotionNodes(nodes)) {
      const baseline = this.getConveyorNodeBaseline(model, node);
      node.position = baseline.position.add(localOffset);
    }
  }

  /** 读取输送线节点基线，模型重新加载或脚本变化时会被 resetConveyorTelemetryState 清空。 */
  private getConveyorNodeBaseline(model: ModelRuntimeEntry, node: TransformNode): ConveyorNodeBaseline {
    const existing = model.conveyorTelemetry.nodeBaselines.get(node);
    if (existing) return existing;

    const baseline = { position: node.position.clone() };
    model.conveyorTelemetry.nodeBaselines.set(node, baseline);
    return baseline;
  }

  /** 把连续偏移约束在一个短循环内，适合链条和货物的运行时视觉表现。 */
  private wrapConveyorOffset(value: number): number {
    if (!Number.isFinite(value)) return 0;
    const loop = CONVEYOR_DEFAULT_TRANSLATE_LOOP_METERS;
    const halfLoop = loop / 2;
    return ((((value + halfLoop) % loop) + loop) % loop) - halfLoop;
  }

  /** 创建或复用输送线运行时货物；可视模板不写入场景文档。 */
  getOrCreateConveyorCargo(assetCode: string, containerCode: string): ConveyorCargoRuntimeEntry {
    const key = this.getConveyorCargoKey(assetCode, containerCode);
    const existing = this.state.conveyorCargoMeshes.get(key);
    if (existing) return existing;

    const root = new TransformNode(
      `conveyor_cargo_root_${sanitizeBabylonName(assetCode)}_${sanitizeBabylonName(containerCode)}`,
      this.scene,
    );
    const entry: ConveyorCargoRuntimeEntry = {
      assetCode,
      containerCode,
      task: '',
      root,
      outputOwner: null,
      fallback: null,
      generatorEntityId: null,
      handoff: null,
    };
    this.state.conveyorCargoMeshes.set(key, entry);
    return entry;
  }

  /** 删除指定输送线实例生成的运行时货物，不影响其他设备。 */
  disposeConveyorCargoForAssetCode(assetCode: string): void {
    for (const [key, cargo] of this.state.conveyorCargoMeshes.entries()) {
      if (cargo.assetCode !== assetCode) continue;
      this.disposeConveyorCargo(cargo);
      this.state.conveyorCargoMeshes.delete(key);
    }
  }

  /** 其他设备凭同一 task 接管本货物：清理引用该货物的模型遥测引用后从表中取出（不销毁），实例交给接管方保持视觉连续。 */
  detachClaimedCargoByKey(key: string): ConveyorCargoRuntimeEntry | null {
    const cargo = this.state.conveyorCargoMeshes.get(key);
    if (!cargo) return null;
    for (const { model } of this.host.collectModels()) {
      if (model.assetCode !== cargo.assetCode) continue;
      const cargoCode = model.conveyorTelemetry.cargoCode;
      if (cargoCode !== null && this.getConveyorCargoKey(model.assetCode, cargoCode) === key) {
        model.conveyorTelemetry.cargoCode = null;
      }
    }
    this.state.conveyorCargoMeshes.delete(key);
    return cargo;
  }

  /** 释放单个输送线运行时货物的模板、回退 Box 和支撑点根节点。 */
  disposeConveyorCargo(cargo: ConveyorCargoRuntimeEntry): void {
    this.host.disposeGeneratedCargo(cargo);
  }

  /** 生成输送线运行时货物的无歧义唯一键，允许设备编号和条码包含任意分隔符。 */
  getConveyorCargoKey(assetCode: string, containerCode: string): string {
    return JSON.stringify([assetCode, containerCode]);
  }

  /** 货箱行程上下文：支撑中心、竖直轴、行走轴与行走跨度，供偏移回绕和定位共用一份包围盒计算。 */
  private resolveConveyorCargoTravelContext(model: ModelRuntimeEntry): {
    center: Vector3;
    upAxis: Vector3;
    travelAxis: Vector3;
    travelAxisName: 'x' | 'z';
    spanMeters: number | null;
  } {
    const configuredNodes = readConveyorMotionConfigs(model).flatMap((config) => this.findConveyorMotionNodes(model, config));
    const conveyorNodes = configuredNodes.length > 0
      ? configuredNodes
      : findModelNodes(model, this.scene, /conveyor|roller|chain|rail|GT|输送|滚筒|链条|轨道/i);
    const bounds = (conveyorNodes.length > 0 ? getNodesWorldBounds(conveyorNodes) : null) ?? this.host.getModelWorldBounds(model);
    const center = bounds
      ? bounds.minimum.add(bounds.maximum).scale(0.5)
      : model.root.getAbsolutePosition();
    const upAxis = getModelAxis(model.root, 'y');
    const travelAxisName = this.readConveyorCargoTravelAxis(model);
    const travelAxis = getHorizontalModelAxis(model.root, travelAxisName);
    const projected = bounds ? projectWorldBoundsOntoAxis(bounds, travelAxis) : null;
    const spanMeters = projected ? Math.max(0, projected.max - projected.min) : null;
    return { center, upAxis, travelAxis, travelAxisName, spanMeters };
  }

  /** 基于输送线行程上下文计算货物底部支撑点，并沿输送方向加入给定行程偏移。 */
  private getConveyorCargoPosition(
    model: ModelRuntimeEntry,
    travelContext: { center: Vector3; upAxis: Vector3; travelAxis: Vector3 },
    travelOffset: number,
  ): Vector3 {
    const legacyCenter = travelContext.center.add(travelContext.upAxis.scale(CONVEYOR_CARGO_SIZE.y * 0.75));
    return legacyCenter
      .subtract(travelContext.upAxis.scale(CONVEYOR_CARGO_SIZE.y / 2))
      .add(travelContext.travelAxis.scale(travelOffset));
  }

  /** 首个非竖直轴的 translate 配置：货物行走轴、速度与方向统一跟随它，与链条本体同源。 */
  private findConveyorCargoTranslateConfig(model: ModelRuntimeEntry): ConveyorMotionConfig | null {
    return readConveyorMotionConfigs(model).find((config) => config.kind === 'translate' && config.axis !== 'y') ?? null;
  }

  /** 推断货物沿模型局部 x/z 哪个方向移动，滚筒线默认垂直于滚筒轴。 */
  private readConveyorCargoTravelAxis(model: ModelRuntimeEntry): 'x' | 'z' {
    return readConveyorTravelAxisFromConfigs(readConveyorMotionConfigs(model));
  }

  /**
   * 轨迹方向（movement_x 正转时货物运动的世界方向）与行走轴世界向量的对齐符号。
   * 同向返回 1：正转时偏移量沿行走轴正向增加；反向返回 -1。
   */
  private readConveyorTrajectoryForwardSign(model: ModelRuntimeEntry, travelAxisWorld: Vector3): 1 | -1 {
    const direction = model.telemetryBinding?.trajectoryDirection ?? 'x';
    const world = direction === '-x'
      ? new Vector3(-1, 0, 0)
      : direction === 'z'
        ? new Vector3(0, 0, 1)
        : direction === '-z'
          ? new Vector3(0, 0, -1)
          : new Vector3(1, 0, 0);
    return Vector3.Dot(world, travelAxisWorld) >= 0 ? 1 : -1;
  }

  /** 对输送线状态和故障做节流日志，实时字段仍完整写入 metadata。 */
  private reportConveyorRuntimeState(snapshot: DeviceTelemetrySnapshot): void {
    const deviceKey = `${snapshot.sourceId}:${snapshot.deviceType}:${snapshot.assetCode}`;
    const mode = readIntegerField(snapshot.fields, 'mode');
    const task = readIntegerField(snapshot.fields, 'task');
    const movementX = readIntegerField(snapshot.fields, 'movement_x');
    const statusSignature = JSON.stringify([mode, task, movementX, snapshot.message]);
    if (this.state.reportedStatuses.get(deviceKey) !== statusSignature) {
      this.state.reportedStatuses.set(deviceKey, statusSignature);
      this.host.pushLog(
        `Conveyor ${snapshot.assetCode} 状态：mode=${mode ?? '未知'}，task=${task ?? '未知'}，movement_x=${movementX ?? '未知'}${snapshot.message ? `，${snapshot.message}` : ''}`,
      );
    }

    if (!snapshot.faulted) {
      this.state.reportedFaults.delete(deviceKey);
      return;
    }

    const faultMessage = snapshot.message || `errorCode=${readIntegerField(snapshot.fields, 'errorCode') ?? 0}`;
    if (this.state.reportedFaults.get(deviceKey) === faultMessage) return;

    this.state.reportedFaults.set(deviceKey, faultMessage);
    this.host.pushLog(`Conveyor ${snapshot.assetCode} 故障：${faultMessage}`);
  }
}
