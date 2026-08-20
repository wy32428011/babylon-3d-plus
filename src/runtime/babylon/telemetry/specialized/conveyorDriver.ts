import type { Scene } from '@babylonjs/core';
import { TransformNode, Vector3 } from '@babylonjs/core';
import {
  clampNumber,
  computeRootRelativeWorldMatrix,
  filterTopLevelMotionNodes,
  findModelNodes,
  getHorizontalModelAxis,
  getModelAxis,
  getModelTransformNodes,
  getNodeWorldRotation,
  getNodesWorldBounds,
  projectWorldBoundsOntoAxis,
  transformWorldBounds,
} from '../../runtimeNodeGeometry';
import { isPlainRecord, sanitizeBabylonName } from '../../runtimeValueUtils';
import { isMeasurableModelMesh } from '../../modelMeasurement';
import {
  readBooleanField,
  readIntegerField,
  readNumberField,
  readStringField,
  type DeviceTelemetrySnapshot,
} from '../../../mqtt/deviceTelemetry';
import { resolveConveyorCargoTravelHalfRange } from '../conveyorCargoTravel';
import { resolveLocatorCellSupportWorldPosition } from '../stackerStorageLocation';
import type { LocatorRuntimeEntry, ModelRuntimeEntry } from '../../SceneRuntime';
import { readConveyorCargoSignalFields, readConveyorCargoSurfaceOffset, readConveyorCargoTravelConfig, isConveyorRuntimeModel, isRgvRuntimeModel } from './specializedModelAssets';
import { writeDeviceTelemetryMetadata } from './telemetryMetadata';
import {
  type ConveyorCargoRuntimeEntry,
  type ConveyorCargoTravelConfig,
  type ConveyorCargoTravelPlan,
  type ConveyorDownstreamLink,
  type ConveyorModelTelemetryState,
  CARGO_HANDOFF_SECONDS,
  CONVEYOR_CARGO_SIZE,
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

/**
 * 链路消息：available/taken 下行泛洪，subscribe/unsubscribe 上行传递；visited 防环，hops 逐跳递增。
 * 消息处理为同步方法调用，与设备各自 MQTT 快照到达无关（断流设备也能收到链路事件）。
 */
type ConveyorLinkMessage = {
  kind: 'available' | 'taken' | 'subscribe' | 'unsubscribe';
  task: string;
  /** available/taken：持货方 assetCode；subscribe/unsubscribe：最终订阅者 assetCode。 */
  originAssetCode: string;
  /** taken 专用：货物交付对象（null=货物消失/销毁）。 */
  recipientAssetCode: string | null;
  /** 发送方距 origin 的跳数；接收方登记链路时 +1，兼作交付交接动画的时长除数。 */
  hops: number;
  /** 传播波的流向（±1，movement_x 约定）；各机据自身入口/出口探测邻居解析上下游。 */
  direction: number;
  /** 已处理设备 assetCode 链：命中即丢弃，防止环型布局消息死循环。 */
  visited: string[];
};

export class ConveyorTelemetryDriver {
  /** assetCode→model 索引：帧内首次使用时懒构建，帧尾 pullExternalHolderCargo 结束清空，下一帧重建。 */
  private modelIndex: Map<string, ModelRuntimeEntry> | null = null;

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

  /** 预热链路缓存：模型 ready 即解析行程规划与双向探测邻居，避免首个货物事件的级联把全场景几何扫描挤在一帧。 */
  primeLinkCaches(model: ModelRuntimeEntry): void {
    if (!isConveyorRuntimeModel(model)) return;
    this.resolveConveyorTravelPlan(model);
    this.resolveProbeNeighbor(model, 1);
    this.resolveProbeNeighbor(model, -1);
  }

  /** 对单条输送线应用货物占位/走行和状态 metadata；本体滚筒/链条不再驱动，仅维护货物运动。 */
  applyToModel(model: ModelRuntimeEntry, snapshot: DeviceTelemetrySnapshot, deltaSeconds: number): void {
    this.reportConveyorRuntimeState(snapshot);
    writeDeviceTelemetryMetadata(model, snapshot);

    this.applyConveyorCargoMotion(model, snapshot, deltaSeconds);
  }

  /**
   * 货物生命周期（task 模式）：快照携带数值 task 字段，仅当 task 相对 lastTask 发生变化才登记 pendingTask（新 task 边沿），
   * 边沿当帧即刷出/订阅判定；movement_x 为 0 时按正转（方向 1）处理。
   * 同 task 重复到达（含线体清空后的重发）不再触发刷出+走行。匿名模式已移除：无 task 字段不再刷出货箱。
   *
   * 链路流转协议（每台 conveyor 显式维护上位/下位链路，事件驱动，无帧级全量扫描）：
   * - 探测邻接：轨迹轴向两端各向外延伸一个货箱长度为探测点，落在其他专用设备包围盒内即邻居；
   *   入口侧（运行方向一侧）为轨迹上游，出口侧为轨迹下游，缓存于 probeNeighbors。
   * - 通知 available/taken（下行泛洪）：持货（交付到达/起点自建/复用盖 task）时向出口探测邻居逐跳
   *   通知 task 货物在本机；交付/销毁时通知货物已离开（含交付对象）。接收方登记/清除 upstreamLinks
   *   （key=上一跳，记录持货方与跳数），并继续向下游转发。泛洪仅走探测邻居（单波 O(N)），
   *   注册下游不直发——只作交付目标；转发不依赖中间设备的 MQTT 快照，断流设备不断链。
   * - 订阅 subscribe/unsubscribe（上行传递）：等待新 task 时向「入口探测邻居 + 注册上游」传递式订阅；
   *   途经设备登记 downstreamLinks（key=最终订阅者，记录 task 与跳数）；持有所订阅 task 货物的设备不再转发，
   *   直接交付给最终订阅者。收到货/变更 task/mode=0/流向翻转时退订，沿链清除登记。
   * - 交付：实例不销毁（交接插值保持视觉连续），越级直达最终订阅者，交接时长 = CARGO_HANDOFF_SECONDS / hops；
   *   订阅者置刷出端并按订阅方向自驱走行（断流期间由帧调度驱动，新消息到达恢复字段驱动）；
   *   收货即退订。级联接力合并下行波：K 跳接力只在终点发一次 taken（原始持货方）+ 一次 available
   *   （最终持有方），中间跳不发波——避免接力放大为链路消息风暴。
   * - 过境标记 transitedTasks：taken 波经过时 pendingTask 匹配且交付对象非本机 → 货已越过，
   *   此后收到同 task 仅更新 lastTask，不再挂单（替代旧 bypassedTasks 语义）。
   * - 新 task 到达且本机持货：旧货有下游订阅 → 先交付再按无货流程处理；无订阅且上游链路有新 task 持货
   *   → 销毁当前货物等传递；否则复用滞留箱盖新 task。
   * - 外部持货（stacker/RGV）：无链路能力，订阅传播触达时由相邻 conveyor 登记 externalPulls，
   *   facade 帧尾扫描其持货，命中即代交付（同样直达最终订阅者）。
   * - 站台（模型脚本声明的内置 1×1 货格）：conveyor↔stacker 双向交接缓冲，locator 事件驱动、不经链路。
   *   上游来货恒以站台为终点（按交付流向钳制收敛到站台支撑位，与站台在 A/B 端无关）；stacker 对站台
   *   货格取货时无视 task 直接接管本机持货（发 taken 波）；放货完成后货物落座站台成为本机滞留货物
   *   （不销毁、不自动驶离），已挂起的等待 task 立即由其兑现，后续到达的 task 走滞留箱复用驶离；
   *   线首（无上游）站台机新 task 到达时不自建也不订阅，等待 stacker 放入。
   * - 防环：消息携带 visited 设备链，命中即丢弃；hops 逐跳 +1。
   * 轨迹方向（telemetryBinding.trajectoryDirection）定义为 movement_x 正转时货物的运动方向，
   * 取**模型本地坐标**（x/-x/z/-z，缺省 x），模型旋转后仍跟随本地轴：
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
    // lastTask 持久保存：货物销毁/被交付走后同 task 重发不得重走刷出+走行。
    // 已过境 task（transitedTasks）：货已越过本机交付给更下游，仅更新 lastTask，不触发边沿，防止再次向上游订阅。
    const taskValue = readIntegerField(snapshot.fields, 'task');
    const taskMode = taskValue !== null;
    const task = normalizeCargoTask(taskValue);
    if (taskMode && task !== '' && task !== state.lastTask) {
      const previousWaitingTask = state.waitingTask;
      state.lastTask = task;
      if (!state.transitedTasks.has(task)) {
        // 新 task 取代旧等待：先沿链退订旧 task，再走新 task 的刷出/订阅判定
        if (previousWaitingTask !== null) {
          this.sendUnsubscribe(model, previousWaitingTask, this.resolveFlowDirection(model));
        }
        state.currentTask = task;
        state.pendingTask = task;
        state.waitingTask = null;
      }
    }

    // 货物走行的方向与速度取自 dataDriven.cargo.travel（fields+actionMap+speed），脚本未声明时回退 movement_x 默认映射。
    const travelConfig = readConveyorCargoTravelConfig(model);
    const movementDirection = this.readConveyorMotionDirection(snapshot, travelConfig);
    // 流向翻转：链路全部失效清空（探测缓存保留），等待中的订阅先退订再以新方向重订。
    const previousDirection = state.lastMovementDirection;
    if (movementDirection !== 0) state.lastMovementDirection = movementDirection;
    if (movementDirection !== 0 && previousDirection !== 0 && movementDirection !== previousDirection) {
      if (state.waitingTask !== null) this.sendUnsubscribe(model, state.waitingTask, previousDirection);
      state.upstreamLinks.clear();
      state.downstreamLinks.clear();
      state.externalPulls.clear();
      if (state.waitingTask !== null) this.sendSubscribe(model, state.waitingTask, movementDirection);
    }

    // 等待方退出等待：仅 mode === 0（空闲，level 判断覆盖边沿）；持有方货物中途消失不自动退出。
    // mode=2 是销毁条件而非等待退出条件：等待方 mode=2 不退出等待、不影响被交付资格。
    // 退出等待必须同时放弃 pendingTask 并沿链退订，否则当帧立即重新订阅。
    if (mode === 0) {
      if (state.waitingTask !== null) {
        this.sendUnsubscribe(model, state.waitingTask, movementDirection !== 0 ? movementDirection : this.resolveFlowDirection(model));
        state.pendingTask = null;
      }
      state.waitingTask = null;
    }

    // 销货条件：mode==2 且双光电（前后）都无货；与线体是否在走行无关。
    if (mode === 2 && !frontHasGoods && !backHasGoods) {
      // 勾选自动销毁时才销毁；缺省不勾选：保留货物与位姿（遗留箱），等下游订阅交付或新 task 复用。
      if (model.telemetryBinding?.cargoAutoDispose === true) {
        const heldCargo = state.cargoCode !== null
          ? this.state.conveyorCargoMeshes.get(this.getConveyorCargoKey(model.assetCode, state.cargoCode)) ?? null
          : null;
        const heldTask = heldCargo?.task ?? '';
        this.disposeConveyorCargoForAssetCode(model.assetCode);
        state.cargoCode = null;
        if (heldTask) {
          this.notifyTaken(model, heldTask, null, movementDirection !== 0 ? movementDirection : this.resolveFlowDirection(model));
        }
        return;
      }
      if (!state.cargoCode) return;
    }

    // task 模式：新 task 边沿（pendingTask 登记）即刷出/订阅判定，不再等线体运行；movement_x 为 0 时按正转处理。
    // 事件驱动：订阅只在首次进入等待（或 available 通知到达）时发出，等待期间（waitingTask 非空）本块幂等不重发。
    // 行程规划按需懒计算并缓存：等待中的设备不触及全场景几何扫描。
    if (taskMode && state.pendingTask) {
      const probeDirection = movementDirection !== 0 ? movementDirection : 1;
      let heldCargo = state.cargoCode !== null
        ? this.state.conveyorCargoMeshes.get(this.getConveyorCargoKey(model.assetCode, state.cargoCode)) ?? null
        : null;
      if (heldCargo && this.hasDownstreamSubscriberForTask(state, heldCargo.task)) {
        // 旧货已有下游订阅：先正常交付，本机按无货流程处理新 task
        this.tryDeliverHeldCargo(model);
        heldCargo = state.cargoCode !== null
          ? this.state.conveyorCargoMeshes.get(this.getConveyorCargoKey(model.assetCode, state.cargoCode)) ?? null
          : null;
      }
      if (heldCargo) {
        const flowDirection = movementDirection !== 0 ? movementDirection : this.resolveFlowDirection(model);
        const upstreamHoldsNewTask = this.hasUpstreamLinkForTask(state, state.pendingTask)
          || this.probeUpstreamHoldsTask(model, probeDirection, state.pendingTask);
        if (upstreamHoldsNewTask) {
          // 上游链路已有新 task 的货：销毁当前货物，订阅等传递
          const oldTask = heldCargo.task;
          this.disposeConveyorCargoForAssetCode(model.assetCode);
          state.cargoCode = null;
          this.notifyTaken(model, oldTask, null, flowDirection);
          state.waitingTask = state.pendingTask;
          this.sendSubscribe(model, state.pendingTask, probeDirection);
        } else {
          // 滞留箱复用：保持位置，盖上新 task；旧 task 货物视为消失，新 task 货物通知下游
          const oldTask = heldCargo.task;
          heldCargo.task = state.pendingTask;
          // 复用后货物可驶离（含从站台出发），不再按上游来货钳制终点
          state.platformInboundCargo = false;
          const containerCode = readStringField(snapshot.fields, 'containerCode')?.trim() ?? '';
          heldCargo.containerCode = containerCode || heldCargo.containerCode;
          state.pendingTask = null;
          state.waitingTask = null;
          if (oldTask && oldTask !== heldCargo.task) this.notifyTaken(model, oldTask, null, flowDirection);
          this.notifyAvailable(model, heldCargo.task, flowDirection);
          this.tryDeliverHeldCargo(model);
          // movement_x=0 按正转处理：登记自驱从滞留位置继续移向终点（下一条新消息恢复字段驱动）。
          if (state.cargoCode !== null && movementDirection === 0) state.selfDriveDirection = 1;
        }
      } else if (state.waitingTask === null) {
        const hasUpstream = this.resolveProbeNeighbor(model, probeDirection) !== null || state.upstreamLinks.size > 0;
        if (!hasUpstream && this.resolvePlatformLocator(model)) {
          // 线首站台机：货物只能由 stacker 放入站台（acceptPlatformPlacedCargo 事件满足），
          // 不自建货箱也不发订阅；无需勾选起点设备/货物自动销毁。
          state.waitingTask = state.pendingTask;
        } else if (!hasUpstream && model.telemetryBinding?.cargoOriginDevice === true) {
          // 起点设备：探测点未触及上游且无注册上游时允许自行创建货箱
          // 刷出端由运行方向决定：正转刷在轨迹起点向终点移动，反转刷在轨迹终点向起点移动。
          // 刷出瞬间货箱模板尚未加载，按内置长度计算行程；模板就绪后下一帧 clamp 自动收敛到实测端点。
          const plan = this.resolveConveyorTravelPlan(model);
          state.pendingTask = null;
          state.waitingTask = null;
          state.cargoTravelOffset = -probeDirection * plan.forwardSign * this.resolveTravelHalfRangeMeters(null, plan);
          state.cargoCode = CONVEYOR_CARGO_IDENTITY;
          state.platformInboundCargo = false;
          this.createConveyorCargoForTask(model, snapshot, state.cargoCode);
          if (movementDirection === 0) state.selfDriveDirection = 1;
          this.notifyAvailable(model, state.currentTask ?? '', probeDirection);
          this.tryDeliverHeldCargo(model);
        } else {
          // 等待上游传递：传递式订阅（沿入口探测邻居 + 注册上游上行，持货方命中即交付）
          state.waitingTask = state.pendingTask;
          this.sendSubscribe(model, state.pendingTask, probeDirection);
        }
      }
    }

    // 等待中：放弃主动创建货物和运动；接管完全由链路交付完成，本机断流也能收到交付。
    if (state.waitingTask) return;

    if (!state.cargoCode) return;
    // 帧级交付兜底：正常路径全部由事件驱动（持货/订阅登记时触发），此处仅遍历本机 downstreamLinks
    // 自愈事件缺口（如运行期外部直接注入持货），交付后本机不再持有，直接返回。
    this.tryDeliverHeldCargo(model);
    if (state.cargoCode === null) return;
    const cargo = this.state.conveyorCargoMeshes.get(this.getConveyorCargoKey(model.assetCode, state.cargoCode));
    if (!cargo) return;

    const plan = this.resolveConveyorTravelPlan(model);
    const cargoSpeed = travelConfig.speed;
    // 快照 movement 为 0 时回退到接管自驱方向：承接货物控制权后立即走行，不等下一条 MQTT 消息。
    const cargoDirection = movementDirection !== 0 ? movementDirection : state.selfDriveDirection;
    if (!snapshot.faulted && cargoDirection !== 0) {
      state.cargoTravelOffset += cargoDirection * plan.forwardSign * cargoSpeed * deltaSeconds;
    }
    // 每帧按当前货箱实测模板长度钳制偏移：货箱前沿到端即停住，参数化改长度后旧偏移也不会把货箱留在机外。
    const travelHalfRange = this.resolveTravelHalfRangeMeters(cargo, plan);
    // 上游来货恒以站台为终点：按交付流向把终点收敛到站台支撑位，与站台在 A/B 端无关；
    // stacker 放货/滞留箱复用的持货不钳站台（platformInboundCargo=false），可正常驶离。
    let minOffset = -travelHalfRange;
    let maxOffset = travelHalfRange;
    if (state.platformInboundCargo) {
      const platform = this.resolvePlatformLocator(model);
      const platformOffset = platform ? this.resolvePlatformTravelOffset(plan.travelContext, platform) : null;
      if (platformOffset !== null) {
        if (state.platformInboundDirection * plan.forwardSign >= 0) {
          maxOffset = Math.min(platformOffset, travelHalfRange);
        } else {
          minOffset = Math.max(platformOffset, -travelHalfRange);
        }
      }
    }
    state.cargoTravelOffset = clampNumber(state.cargoTravelOffset, minOffset, maxOffset);

    this.host.syncGeneratedCargoVisual(cargo, 'conveyor', snapshot, this.host.resolveCargoGeneratorForModel(model));
    const pose = resolveCargoHandoffPose(
      cargo,
      this.getConveyorCargoPosition(model, plan.travelContext, state.cargoTravelOffset),
      getNodeWorldRotation(model.root),
      deltaSeconds,
    );
    this.host.setGeneratedCargoRootPose(cargo, pose.position, pose.rotation);
  }

  /**
   * 帧尾外部持货拉取扫描（facade 每帧调用，与快照新旧无关）：stacker/RGV 无链路能力，
   * 订阅传播触达它们时由相邻 conveyor 登记 externalPulls；此处检查登记目标的持货，
   * 命中即代交付给最终订阅者（实例不销毁，hops 加速交接插值）。
   */
  pullExternalHolderCargo(): void {
    for (const { model } of this.host.collectModels()) {
      const state = model.conveyorTelemetry;
      if (!state || state.externalPulls.size === 0) continue;
      for (const [subscriberCode, pull] of [...state.externalPulls.entries()]) {
        const subscriber = this.findModelByAssetCode(subscriberCode);
        const subscriberState = subscriber?.conveyorTelemetry ?? null;
        // 登记自愈合：订阅者已不想要（task 变化/已有货）→ 摘除登记
        if (!subscriber || !subscriberState || subscriberState.cargoCode !== null
          || (subscriberState.pendingTask !== pull.task && subscriberState.waitingTask !== pull.task)) {
          state.externalPulls.delete(subscriberCode);
          continue;
        }
        const cargo = this.findHeldCargoByTask(pull.holderAssetCode, pull.task);
        if (!cargo) continue;
        state.externalPulls.delete(subscriberCode);
        const detached = this.context.detachClaimedCargoByReference(cargo);
        if (!detached) continue;
        // 代外部持有方交付并参与接力合并：本机为 taken 波起点，持货方记为外部设备
        this.runCargoDeliveryRelay(model, pull.holderAssetCode, detached, null, {
          subscriber,
          link: { task: pull.task, hops: pull.hops, direction: pull.direction },
        });
      }
    }
    // 帧尾边界：清空模型索引缓存，下一帧首次使用时按最新模型集合重建
    this.modelIndex = null;
  }

  /** 链路消息分发：visited 防环；非 conveyor 模型无链路能力，直接丢弃。 */
  private dispatchLinkMessage(target: ModelRuntimeEntry, msg: ConveyorLinkMessage): void {
    if (msg.visited.includes(target.assetCode)) return;
    if (!isConveyorRuntimeModel(target)) return;
    switch (msg.kind) {
      case 'available': this.handleAvailableMessage(target, msg); break;
      case 'taken': this.handleTakenMessage(target, msg); break;
      case 'subscribe': this.handleSubscribeMessage(target, msg); break;
      case 'unsubscribe': this.handleUnsubscribeMessage(target, msg); break;
    }
  }

  /** available（下行）：登记上一跳→持货方的上位链路；正等该 task 且无货则立即向上订阅；继续下行泛洪。 */
  private handleAvailableMessage(model: ModelRuntimeEntry, msg: ConveyorLinkMessage): void {
    const state = model.conveyorTelemetry;
    const prevHop = msg.visited[msg.visited.length - 1];
    state.upstreamLinks.set(prevHop, {
      task: msg.task,
      holderAssetCode: msg.originAssetCode,
      hops: msg.hops + 1,
      direction: msg.direction,
    });
    // 本机正等该 task 且无货：立即沿注册路径向上订阅（覆盖新出现的持货方路径）。
    // 去重：waitingTask 已是该 task 说明订阅在链，仅刷新上位链路登记，不再发波（防止 available 波放大为全链重订阅风暴）。
    if (state.pendingTask === msg.task && state.cargoCode === null && state.waitingTask !== msg.task) {
      state.waitingTask = msg.task;
      this.sendSubscribe(model, msg.task, msg.direction);
    }
    this.floodDownstream(model, { ...msg, hops: msg.hops + 1, visited: [...msg.visited, model.assetCode] });
  }

  /** taken（下行）：清除该 task 的上位链路记录；货物越过本机交付给更下游/消失 → 标记过境、不再挂单；继续泛洪。 */
  private handleTakenMessage(model: ModelRuntimeEntry, msg: ConveyorLinkMessage): void {
    const state = model.conveyorTelemetry;
    for (const [key, link] of [...state.upstreamLinks.entries()]) {
      if (link.task === msg.task && link.holderAssetCode === msg.originAssetCode) {
        state.upstreamLinks.delete(key);
      }
    }
    if (state.pendingTask === msg.task && msg.recipientAssetCode !== model.assetCode) {
      state.transitedTasks.add(msg.task);
      state.pendingTask = null;
      // 过境即退订：沿链清除本机的下位链路/外部拉取登记，不再挂单
      if (state.waitingTask !== null) {
        this.sendUnsubscribe(model, state.waitingTask, msg.direction);
        state.waitingTask = null;
      }
    }
    this.floodDownstream(model, { ...msg, hops: msg.hops + 1, visited: [...msg.visited, model.assetCode] });
  }

  /** subscribe（上行）：登记最终订阅者的下位链路；持有所订阅 task 的货 → 直接交付不再转发；否则继续上行传递。 */
  private handleSubscribeMessage(model: ModelRuntimeEntry, msg: ConveyorLinkMessage): void {
    const state = model.conveyorTelemetry;
    const linkHops = msg.hops + 1;
    state.downstreamLinks.set(msg.originAssetCode, { task: msg.task, hops: linkHops, direction: msg.direction });
    const heldCargo = state.cargoCode !== null
      ? this.state.conveyorCargoMeshes.get(this.getConveyorCargoKey(model.assetCode, state.cargoCode)) ?? null
      : null;
    if (heldCargo && heldCargo.task === msg.task) {
      this.tryDeliverHeldCargo(model);
      return;
    }
    this.propagateUpstream(model, { ...msg, hops: linkHops, visited: [...msg.visited, model.assetCode] }, linkHops);
  }

  /** unsubscribe（上行）：摘除最终订阅者的下位链路与外部拉取登记，继续上行传递。 */
  private handleUnsubscribeMessage(model: ModelRuntimeEntry, msg: ConveyorLinkMessage): void {
    const state = model.conveyorTelemetry;
    state.downstreamLinks.delete(msg.originAssetCode);
    state.externalPulls.delete(msg.originAssetCode);
    this.propagateUpstream(model, { ...msg, hops: msg.hops + 1, visited: [...msg.visited, model.assetCode] }, msg.hops + 1);
  }

  /**
   * 下行泛洪 available/taken：仅出口探测邻居逐跳传播，单波 O(N) 派发。
   * 不再直发注册下游——直发使单波派发数放大到全网 downstreamLinks 总数（O(N×订阅数)），
   * 接力每跳三波叠加即链路消息风暴根因；注册下游仍作为交付目标（tryDeliverHeldCargo）。
   * 转发由发送方驱动、用静态几何探测缓存，不依赖中间设备的 MQTT 快照，断流设备不断链。
   */
  private floodDownstream(model: ModelRuntimeEntry, msg: ConveyorLinkMessage): void {
    const exitNeighbor = this.resolveProbeNeighbor(model, -msg.direction);
    if (exitNeighbor && exitNeighbor.assetCode !== model.assetCode && isConveyorRuntimeModel(exitNeighbor)) {
      this.dispatchLinkMessage(exitNeighbor, msg);
    }
  }

  /**
   * 上行传递 subscribe/unsubscribe：入口探测邻居 + 所有注册上游（按 assetCode 去重）。
   * 入口探测邻居为非 conveyor 专用设备（stacker/RGV）时，由本机登记外部持货拉取（帧尾扫描代交付）。
   */
  private propagateUpstream(model: ModelRuntimeEntry, msg: ConveyorLinkMessage, registrarHops: number): void {
    const state = model.conveyorTelemetry;
    const targets = new Map<string, ModelRuntimeEntry>();
    const entryNeighbor = this.resolveProbeNeighbor(model, msg.direction);
    if (entryNeighbor && entryNeighbor.assetCode !== model.assetCode) {
      if (isConveyorRuntimeModel(entryNeighbor)) {
        targets.set(entryNeighbor.assetCode, entryNeighbor);
      } else if (msg.kind === 'subscribe') {
        state.externalPulls.set(msg.originAssetCode, {
          holderAssetCode: entryNeighbor.assetCode,
          task: msg.task,
          hops: registrarHops + 1,
          direction: msg.direction,
        });
      }
    }
    for (const key of state.upstreamLinks.keys()) {
      if (targets.has(key)) continue;
      const target = this.findModelByAssetCode(key);
      if (target) targets.set(key, target);
    }
    for (const target of targets.values()) this.dispatchLinkMessage(target, msg);
  }

  /** 持货事件下行通知：本机持有 task 货物（交付到达/起点自建/复用盖 task 后调用）。 */
  private notifyAvailable(model: ModelRuntimeEntry, task: string, direction: number): void {
    if (!task) return;
    this.floodDownstream(model, {
      kind: 'available',
      task,
      originAssetCode: model.assetCode,
      recipientAssetCode: null,
      hops: 0,
      direction,
      visited: [model.assetCode],
    });
  }

  /** 货物离开本机（交付/销毁）的下行通知；recipientAssetCode=null 表示货物消失。 */
  private notifyTaken(model: ModelRuntimeEntry, task: string, recipientAssetCode: string | null, direction: number): void {
    if (!task) return;
    this.sendTakenWave(model, model.assetCode, task, recipientAssetCode, direction);
  }

  /** taken 泛洪：waveOrigin 为波起点（外部持货时为相邻 conveyor），originAssetCode 记实际持货方。 */
  private sendTakenWave(
    waveOrigin: ModelRuntimeEntry,
    holderAssetCode: string,
    task: string,
    recipientAssetCode: string | null,
    direction: number,
  ): void {
    if (!task) return;
    this.floodDownstream(waveOrigin, {
      kind: 'taken',
      task,
      originAssetCode: holderAssetCode,
      recipientAssetCode,
      hops: 0,
      direction,
      visited: [waveOrigin.assetCode],
    });
  }

  /** 传递式订阅：向入口探测邻居 + 注册上游发送 subscribe（origin 为本机，hops 从 0 计）。 */
  private sendSubscribe(model: ModelRuntimeEntry, task: string, direction: number): void {
    if (!task) return;
    this.propagateUpstream(model, {
      kind: 'subscribe',
      task,
      originAssetCode: model.assetCode,
      recipientAssetCode: null,
      hops: 0,
      direction,
      visited: [model.assetCode],
    }, 0);
  }

  /** 退订：收到货/变更 task/mode=0/流向翻转时发出，沿链清除 downstreamLinks/externalPulls 登记。 */
  private sendUnsubscribe(model: ModelRuntimeEntry, task: string, direction: number): void {
    if (!task) return;
    this.propagateUpstream(model, {
      kind: 'unsubscribe',
      task,
      originAssetCode: model.assetCode,
      recipientAssetCode: null,
      hops: 0,
      direction,
      visited: [model.assetCode],
    }, 0);
  }

  /** 持货交付检查：本机持有货物且 downstreamLinks 中有该 task 的订阅者 → 开启交付接力。 */
  private tryDeliverHeldCargo(model: ModelRuntimeEntry): void {
    const state = model.conveyorTelemetry;
    if (state.cargoCode === null) return;
    const cargo = this.state.conveyorCargoMeshes.get(this.getConveyorCargoKey(model.assetCode, state.cargoCode));
    if (!cargo || !cargo.task) return;
    const target = this.findDeliveryTarget(model, cargo);
    if (!target) return;
    const detached = this.context.detachClaimedCargoByReference(cargo);
    if (!detached) return;
    this.runCargoDeliveryRelay(model, model.assetCode, detached, model, target);
  }

  /**
   * 在本机 downstreamLinks 中找该货物的最先登记订阅者（Map 插入序）；
   * 顺带自愈合：订阅者已不想要（task 变化/已有货）→ 摘除登记看下一个。
   */
  private findDeliveryTarget(
    model: ModelRuntimeEntry,
    cargo: GeneratedCargoRuntimeEntry,
  ): { subscriber: ModelRuntimeEntry; link: ConveyorDownstreamLink } | null {
    const state = model.conveyorTelemetry;
    for (const [subscriberCode, link] of state.downstreamLinks) {
      if (link.task !== cargo.task) continue;
      const subscriber = this.findModelByAssetCode(subscriberCode);
      const subscriberState = subscriber?.conveyorTelemetry ?? null;
      if (!subscriber || !subscriberState || subscriberState.cargoCode !== null
        || (subscriberState.pendingTask !== link.task && subscriberState.waitingTask !== link.task)) {
        state.downstreamLinks.delete(subscriberCode);
        continue;
      }
      return { subscriber, link };
    }
    return null;
  }

  /**
   * 交付接力主循环（越级直达的级联）：首跳货物已由调用方摘除，逐跳落地换绑直到无下游订阅者。
   * 接力期间抑制每跳 available/taken 下行波——中间跳信息对下游零行动价值（订阅早已在链），
   * K 跳接力从 3K 个全链波降为 2 个：终点处由原始持货方发一次 taken（含最终接收方）、
   * 最终持有方发一次 available。每跳退订保留（上行传递 O(路径)，清除该跳的订阅登记）。
   */
  private runCargoDeliveryRelay(
    waveOrigin: ModelRuntimeEntry,
    originHolderAssetCode: string,
    firstCargo: GeneratedCargoRuntimeEntry,
    firstHolder: ModelRuntimeEntry | null,
    firstTarget: { subscriber: ModelRuntimeEntry; link: ConveyorDownstreamLink },
  ): void {
    let cargo = firstCargo;
    let cargoDetached = true;
    let holder = firstHolder;
    let target = firstTarget;
    let task = firstTarget.link.task;
    let direction = firstTarget.link.direction;
    while (true) {
      if (!cargoDetached) {
        const detached = this.context.detachClaimedCargoByReference(cargo);
        if (!detached) return;
        cargo = detached;
      }
      holder?.conveyorTelemetry?.downstreamLinks.delete(target.subscriber.assetCode);
      task = target.link.task;
      direction = target.link.direction;
      this.settleCargoTransfer(cargo, target.subscriber, task, target.link.hops, direction);
      const next = this.findDeliveryTarget(target.subscriber, cargo);
      if (!next) {
        // 接力终点：唯一一次 taken + available
        this.sendTakenWave(waveOrigin, originHolderAssetCode, task, target.subscriber.assetCode, direction);
        this.notifyAvailable(target.subscriber, task, direction);
        return;
      }
      holder = target.subscriber;
      target = next;
      cargoDetached = false;
    }
  }

  /**
   * 交付落地（接力每一跳）：换绑订阅者、交接插值（hops 加速）、刷出端+自驱、清等待；
   * 收货即退订（沿订阅路径清除登记）。不发 available/taken 下行波，由接力驱动者在终点统一发。
   */
  private settleCargoTransfer(
    cargo: GeneratedCargoRuntimeEntry,
    subscriber: ModelRuntimeEntry,
    task: string,
    hops: number,
    direction: number,
  ): void {
    const subscriberState = subscriber.conveyorTelemetry;
    cargo.assetCode = subscriber.assetCode;
    cargo.task = task;
    cargo.handoff = createCargoHandoffState(cargo, CARGO_HANDOFF_SECONDS / Math.max(hops, 1));

    const plan = this.resolveConveyorTravelPlan(subscriber);
    subscriberState.cargoCode = CONVEYOR_CARGO_IDENTITY;
    // 交接货箱已在上游渲染完毕，模板长度实测可用，直接按实测端点重置偏移。
    subscriberState.cargoTravelOffset = -direction * plan.forwardSign * this.resolveTravelHalfRangeMeters(cargo, plan);
    subscriberState.pendingTask = null;
    subscriberState.waitingTask = null;
    // 承接即走行：登记自驱方向，快照断流期间由帧调度继续驱动，新消息到达即恢复字段驱动。
    subscriberState.selfDriveDirection = direction;
    // 上游来货恒以站台为终点：记录交付流向，走行钳制按流向收敛到站台支撑位（无站台则不钳）。
    subscriberState.platformInboundCargo = this.resolvePlatformLocator(subscriber) !== null;
    subscriberState.platformInboundDirection = direction;
    this.state.conveyorCargoMeshes.set(this.getConveyorCargoKey(subscriber.assetCode, CONVEYOR_CARGO_IDENTITY), cargo);

    this.sendUnsubscribe(subscriber, task, direction);
  }

  /** 本机 downstreamLinks 中是否有该 task 的订阅者（新 task 边沿时决定旧货先交付还是走复用/销毁规则）。 */
  private hasDownstreamSubscriberForTask(state: ConveyorModelTelemetryState, task: string): boolean {
    if (!task) return false;
    for (const link of state.downstreamLinks.values()) {
      if (link.task === task) return true;
    }
    return false;
  }

  /** 本机 upstreamLinks 中是否有该 task 的在持货物记录。 */
  private hasUpstreamLinkForTask(state: ConveyorModelTelemetryState, task: string): boolean {
    if (!task) return false;
    for (const link of state.upstreamLinks.values()) {
      if (link.task === task) return true;
    }
    return false;
  }

  /** 直接探测上游邻居是否持有该 task 的货物（覆盖 stacker/RGV 等无链路能力邻居与通知缺口）。 */
  private probeUpstreamHoldsTask(model: ModelRuntimeEntry, direction: number, task: string): boolean {
    if (!task) return false;
    const neighbor = this.resolveProbeNeighbor(model, direction);
    return neighbor !== null && this.findHeldCargoByTask(neighbor.assetCode, task) !== null;
  }

  /** 三张货物表（stacker/conveyor/rgv）中查找指定设备持有的指定 task 货物。 */
  private findHeldCargoByTask(holderAssetCode: string, task: string): GeneratedCargoRuntimeEntry | null {
    if (!task) return null;
    const tables = [this.state.stackerCargoMeshes, this.state.conveyorCargoMeshes, this.state.rgvCargoMeshes];
    for (const table of tables) {
      for (const cargo of table.values()) {
        if (cargo.assetCode === holderAssetCode && cargo.task === task) return cargo;
      }
    }
    return null;
  }

  /** 本机有效流向：最近非 0 运行方向，缺省回退（正转）。 */
  private resolveFlowDirection(model: ModelRuntimeEntry, fallback = 1): number {
    const direction = model.conveyorTelemetry?.lastMovementDirection ?? 0;
    return direction !== 0 ? direction : fallback;
  }

  /** 本机的内置站台货格（模型脚本声明 enablePlatform 并生成绑定时存在）；阵列代理等无实体快照时返回 null。 */
  private resolvePlatformLocator(model: ModelRuntimeEntry): LocatorRuntimeEntry | null {
    const entityId = model.entitySnapshot?.id;
    return entityId ? this.host.findBuiltInSlotLocatorForHostModel(entityId) : null;
  }

  /** 站台支撑位（1×1 货格 boxIndex=0）在行走轴上相对行程中心的投影偏移；站台在预览隐藏态也可解析。 */
  private resolvePlatformTravelOffset(
    travelContext: { center: Vector3; travelAxis: Vector3 },
    platform: LocatorRuntimeEntry,
  ): number | null {
    const supportWorld = resolveLocatorCellSupportWorldPosition(platform, 0);
    if (!supportWorld) return null;
    return Vector3.Dot(supportWorld.subtract(travelContext.center), travelContext.travelAxis);
  }

  /** 按资产编号查找模型：帧内懒构建索引一次，链路消息逐链路查找不再全量扫描。 */
  private findModelByAssetCode(assetCode: string): ModelRuntimeEntry | null {
    if (!this.modelIndex) {
      this.modelIndex = new Map();
      for (const { model } of this.host.collectModels()) {
        if (!this.modelIndex.has(model.assetCode)) this.modelIndex.set(model.assetCode, model);
      }
    }
    return this.modelIndex.get(assetCode) ?? null;
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
    return assetCode ? this.findModelByAssetCode(assetCode) : null;
  }

  /** 探测点世界坐标：轨迹端点沿走行方向向外延伸一个货箱长度（复用刷出端偏移公式）。邻居拓扑探测与货箱实测长度无关，且探测解析时货箱可能尚未渲染，这里固定用内置长度。 */
  private resolveProbePoint(model: ModelRuntimeEntry, direction: number): Vector3 {
    const plan = this.resolveConveyorTravelPlan(model);
    const cargoAxialLength = CONVEYOR_CARGO_SIZE[plan.travelContext.travelAxisName];
    const travelHalfRange = resolveConveyorCargoTravelHalfRange(plan.travelContext.spanMeters ?? 0, cargoAxialLength);
    return this.getConveyorCargoPosition(
      model,
      plan.travelContext,
      -direction * plan.forwardSign * (travelHalfRange + cargoAxialLength),
    );
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

  /** 按 cargo.travel.fields 读取输送线方向，支持模型脚本自定义 actionMap。 */
  private readConveyorMotionDirection(snapshot: DeviceTelemetrySnapshot, config: ConveyorCargoTravelConfig): number {
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

  /** 查找 cargo.travel 声明的行程节点，优先精确名称，失败后按 fallbackPattern 兜底。 */
  private findConveyorCargoSpanNodes(model: ModelRuntimeEntry, config: ConveyorCargoTravelConfig): TransformNode[] {
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
      axialLengthCache: null,
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
        model.conveyorTelemetry.platformInboundCargo = false;
      }
    }
    this.state.conveyorCargoMeshes.delete(key);
    return cargo;
  }

  /** stacker 从本机站台取货：无视 task 取出本机当前持货（不销毁），并向下游发 taken 波；无货返回 null。 */
  adoptPlatformCargoForStacker(model: ModelRuntimeEntry, stackerAssetCode: string): ConveyorCargoRuntimeEntry | null {
    const state = model.conveyorTelemetry;
    if (state.cargoCode === null) return null;
    const cargo = this.detachClaimedCargoByKey(this.getConveyorCargoKey(model.assetCode, state.cargoCode));
    if (!cargo) return null;
    this.notifyTaken(model, cargo.task, stackerAssetCode, this.resolveFlowDirection(model));
    return cargo;
  }

  /** 站台放货预检：本机空闲且站台偏移可解析才允许交接；纯读无副作用，供调用方在拆除原持货引用前判定。 */
  canAcceptPlatformPlacedCargo(model: ModelRuntimeEntry, platform: LocatorRuntimeEntry): boolean {
    const state = model.conveyorTelemetry;
    if (state.cargoCode !== null) return false;
    const plan = this.resolveConveyorTravelPlan(model);
    return this.resolvePlatformTravelOffset(plan.travelContext, platform) !== null;
  }

  /**
   * stacker 向本机站台放货完成：货物落座站台成为本机滞留货物（不销毁、不自动驶离），由本机继续维护；
   * 本机正等待的 task 立即由该货物兑现，未等待则保留货物随附 task，后续新 task 边沿走滞留箱复用驶离。
   * 本机已有货或站台偏移不可解析时返回 false（调用方走原销毁路径）。
   */
  acceptPlatformPlacedCargo(
    model: ModelRuntimeEntry,
    platform: LocatorRuntimeEntry,
    cargo: GeneratedCargoRuntimeEntry,
  ): boolean {
    const state = model.conveyorTelemetry;
    if (state.cargoCode !== null) return false;
    const plan = this.resolveConveyorTravelPlan(model);
    const platformOffset = this.resolvePlatformTravelOffset(plan.travelContext, platform);
    if (platformOffset === null) return false;

    cargo.assetCode = model.assetCode;
    cargo.handoff = createCargoHandoffState(cargo);
    this.state.conveyorCargoMeshes.set(this.getConveyorCargoKey(model.assetCode, CONVEYOR_CARGO_IDENTITY), cargo);
    state.cargoCode = CONVEYOR_CARGO_IDENTITY;
    state.cargoTravelOffset = platformOffset;
    state.platformInboundCargo = false;
    // 等待中的 task 由放入货物立即兑现（线首站台未发订阅，退订为无害空操作）
    if (state.waitingTask !== null) {
      cargo.task = state.waitingTask;
      this.sendUnsubscribe(model, state.waitingTask, this.resolveFlowDirection(model));
      state.waitingTask = null;
    }
    state.pendingTask = null;
    if (cargo.task) {
      state.currentTask = cargo.task;
      state.lastTask = cargo.task;
    }
    this.notifyAvailable(model, cargo.task, this.resolveFlowDirection(model));
    return true;
  }

  /** 释放单个输送线运行时货物的模板、回退 Box 和支撑点根节点。 */
  disposeConveyorCargo(cargo: ConveyorCargoRuntimeEntry): void {
    this.host.disposeGeneratedCargo(cargo);
  }

  /** 生成输送线运行时货物的无歧义唯一键，允许设备编号和条码包含任意分隔符。 */
  getConveyorCargoKey(assetCode: string, containerCode: string): string {
    return JSON.stringify([assetCode, containerCode]);
  }

  /**
   * 行程规划（带缓存）：走行上下文与轨迹符号首次使用时计算并缓存在遥测状态上。
   * 预览期间模型不动，缓存安全（与 probeNeighbors 同一假设）；reset 时随状态清空重算。
   * 行程半径不进缓存——按当前货箱实测模板长度每帧动态计算，见 resolveTravelHalfRangeMeters。
   */
  private resolveConveyorTravelPlan(model: ModelRuntimeEntry): ConveyorCargoTravelPlan {
    const state = model.conveyorTelemetry;
    if (state.travelPlan) return state.travelPlan;
    const travelContext = this.resolveConveyorCargoTravelContext(model);
    const plan: ConveyorCargoTravelPlan = {
      travelContext,
      forwardSign: this.readConveyorTrajectoryForwardSign(model, travelContext.travelAxisName),
    };
    state.travelPlan = plan;
    return plan;
  }

  /**
   * 实测货箱沿行走轴的模板长度（米）：生成器输出就绪后按世界包围盒在行走轴上的投影测量，
   * 按模板 target 签名缓存避免每帧重测；内置立方体/加载中/无货箱一律回退 CONVEYOR_CARGO_SIZE。
   */
  private resolveCargoAxialLengthMeters(
    cargo: ConveyorCargoRuntimeEntry | null,
    travelContext: ConveyorCargoTravelPlan['travelContext'],
  ): number {
    const fallbackLength = CONVEYOR_CARGO_SIZE[travelContext.travelAxisName];
    const owner = cargo?.outputOwner ?? null;
    const output = owner?.output ?? null;
    if (!cargo || !owner || !output) return fallbackLength;

    const cacheKey = `${owner.activeTargetSignature ?? ''}:${travelContext.travelAxisName}`;
    if (cargo.axialLengthCache?.key === cacheKey) return cargo.axialLengthCache.lengthMeters;

    const nodes = output.kind === 'mesh'
      ? [output.mesh]
      : output.model.contentRoot.getChildMeshes(false).filter(isMeasurableModelMesh);
    if (nodes.length === 0) return fallbackLength;

    cargo.root.computeWorldMatrix(true);
    const bounds = getNodesWorldBounds(nodes);
    const projected = bounds ? projectWorldBoundsOntoAxis(bounds, travelContext.travelAxis) : null;
    const lengthMeters = projected && projected.max > projected.min ? projected.max - projected.min : fallbackLength;
    cargo.axialLengthCache = { key: cacheKey, lengthMeters };
    return lengthMeters;
  }

  /** 行程半径 = 输送线跨度/2 − 当前货箱实测半长：货箱前沿到达输送线末端即停住。 */
  private resolveTravelHalfRangeMeters(
    cargo: ConveyorCargoRuntimeEntry | null,
    plan: ConveyorCargoTravelPlan,
  ): number {
    return resolveConveyorCargoTravelHalfRange(
      plan.travelContext.spanMeters ?? 0,
      this.resolveCargoAxialLengthMeters(cargo, plan.travelContext),
    );
  }

  /** 货箱行程上下文：支撑中心、竖直轴、行走轴、行走跨度与支撑面抬升量，供货物定位与探测点共用一份包围盒计算。 */
  private resolveConveyorCargoTravelContext(model: ModelRuntimeEntry): {
    center: Vector3;
    upAxis: Vector3;
    travelAxis: Vector3;
    travelAxisName: 'x' | 'z';
    spanMeters: number | null;
    surfaceLiftMeters: number;
  } {
    const travelConfig = readConveyorCargoTravelConfig(model);
    // 合批遥测代理无自身节点：行程节点与包围盒取自宿主模型，再按相对位姿换算到代理世界系。
    const geometryHost = model.telemetryProxySource ?? model;
    const configuredNodes = this.findConveyorCargoSpanNodes(geometryHost, travelConfig);
    const conveyorNodes = configuredNodes.length > 0
      ? configuredNodes
      : findModelNodes(geometryHost, this.scene, /conveyor|roller|chain|rail|GT|输送|滚筒|链条|轨道/i);
    let bounds = (conveyorNodes.length > 0 ? getNodesWorldBounds(conveyorNodes) : null)
      ?? this.host.getModelWorldBounds(geometryHost);
    if (model.telemetryProxySource && bounds) {
      const relativeMatrix = computeRootRelativeWorldMatrix(model.telemetryProxySource.root, model.root);
      bounds = relativeMatrix ? transformWorldBounds(bounds, relativeMatrix) : null;
    }
    const center = bounds
      ? bounds.minimum.add(bounds.maximum).scale(0.5)
      : model.root.getAbsolutePosition();
    const upAxis = getModelAxis(model.root, 'y');
    const travelAxisName = travelConfig.axis;
    const travelAxis = getHorizontalModelAxis(model.root, travelAxisName);
    const projected = bounds ? projectWorldBoundsOntoAxis(bounds, travelAxis) : null;
    const spanMeters = projected ? Math.max(0, projected.max - projected.min) : null;
    // 支撑面 = 包围盒沿竖直轴的上表面（投影最高点到 center 的抬升量），surfaceOffset 微调贴合真实台面。
    const surfaceLiftMeters = (bounds
      ? projectWorldBoundsOntoAxis(bounds, upAxis).max - Vector3.Dot(center, upAxis)
      : 0) + readConveyorCargoSurfaceOffset(model);
    return { center, upAxis, travelAxis, travelAxisName, spanMeters, surfaceLiftMeters };
  }

  /** 基于输送线行程上下文计算货物底部支撑点：落在设备包围盒上表面，并沿输送方向加入给定行程偏移。 */
  private getConveyorCargoPosition(
    model: ModelRuntimeEntry,
    travelContext: { center: Vector3; upAxis: Vector3; travelAxis: Vector3; surfaceLiftMeters: number },
    travelOffset: number,
  ): Vector3 {
    return travelContext.center
      .add(travelContext.upAxis.scale(travelContext.surfaceLiftMeters))
      .add(travelContext.travelAxis.scale(travelOffset));
  }

  /**
   * 轨迹方向（movement_x 正转时货物运动方向）与行走轴的对齐符号，取**模型本地坐标**：
   * trajectoryDirection 的轴与行走轴名一致时按其正负号返回 ±1；轴向不一致（配置缺省/错配）回退 1。
   * 同向返回 1：正转时偏移量沿行走轴正向增加；反向返回 -1。模型整体旋转不影响判定。
   */
  private readConveyorTrajectoryForwardSign(model: ModelRuntimeEntry, travelAxisName: 'x' | 'z'): 1 | -1 {
    const direction = model.telemetryBinding?.trajectoryDirection ?? 'x';
    const negative = direction.startsWith('-');
    const axisName = negative ? direction.slice(1) : direction;
    return axisName === travelAxisName ? (negative ? -1 : 1) : 1;
  }

  /** 输送线故障做节流日志，实时字段仍完整写入 metadata；info 类状态不进编辑器 Console。 */
  private reportConveyorRuntimeState(snapshot: DeviceTelemetrySnapshot): void {
    const deviceKey = `${snapshot.sourceId}:${snapshot.deviceType}:${snapshot.assetCode}`;
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
