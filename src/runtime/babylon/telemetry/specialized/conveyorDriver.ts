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
import { readConveyorCargoSignalFields, readConveyorMotionConfigs, readConveyorTravelAxisFromConfigs } from './specializedModelAssets';
import { writeDeviceTelemetryMetadata } from './telemetryMetadata';
import {
  type ConveyorCargoRuntimeEntry,
  type ConveyorMotionConfig,
  type ConveyorNodeBaseline,
  CONVEYOR_CARGO_SIZE,
  CONVEYOR_DEFAULT_TRANSLATE_LOOP_METERS,
  CONVEYOR_DEFAULT_TRANSLATE_SPEED_METERS_PER_SECOND,
  createCargoHandoffState,
  normalizeCargoTask,
  resolveCargoHandoffPose,
  type SpecializedTelemetryDriverContext,
  type SpecializedTelemetryHost,
  type SpecializedTelemetrySharedState,
} from './types';

export class ConveyorTelemetryDriver {
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
   *   光电有货且线体运行（movement_x 非 0）后刷出；同 task 重复到达（含线体清空后的重发）不再触发刷出+走行；
   *   刷出时按 task 全局接管他设备货箱实例（插值接入本机走行）。
   * - 匿名模式（无 task 字段）：光电有货且线体运行时刷出，设备自管理，不参与全局接管。
   * 停线且双光电无货时是否销毁货物由 telemetryBinding.cargoAutoDispose 控制（缺省开启）：
   * 开启时清空本机货物；关闭时货物保持原位，交由下游设备凭 task 接管决定去向。
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

    // task 语义：数值 0/缺失为无任务；仅新 task 边沿（相对 lastTask 变化）登记，等待光电确认刷出。
    // lastTask 持久保存：货物销毁/被接管后同 task 重发不得重走刷出+走行。
    const taskValue = readIntegerField(snapshot.fields, 'task');
    const taskMode = taskValue !== null;
    const task = normalizeCargoTask(taskValue);
    if (taskMode && task && task !== state.lastTask) {
      state.lastTask = task;
      state.currentTask = task;
      state.pendingTask = task;
    }

    // 货物走行与链条本体共用同一份 translate 配置（fields+actionMap+speed），避免链/货速度脱节。
    const translateConfig = this.findConveyorCargoTranslateConfig(model);
    const movementDirection = translateConfig
      ? this.readConveyorMotionDirection(snapshot, translateConfig)
      : this.readConveyorMovementDirection(readIntegerField(snapshot.fields, 'movement_x'));

    if (movementDirection === 0 && !frontHasGoods && !backHasGoods) {
      // 自动销毁关闭时货物交由 task 由下游设备接管：本机保留货物与位姿，直到被凭 task 取走。
      if (model.telemetryBinding?.cargoAutoDispose === false) {
        if (!state.cargoCode) return;
      } else {
        this.disposeConveyorCargoForAssetCode(model.assetCode);
        state.cargoCode = null;
        return;
      }
    }

    const travelContext = this.resolveConveyorCargoTravelContext(model);
    const travelHalfRange = resolveConveyorCargoTravelHalfRange(
      travelContext.spanMeters ?? 0,
      CONVEYOR_CARGO_SIZE[travelContext.travelAxisName],
    );
    const forwardSign = this.readConveyorTrajectoryForwardSign(model, travelContext.travelAxis);
    // 刷出端由运行方向决定：正转刷在轨迹起点向终点移动，反转刷在轨迹终点向起点移动。
    const spawnOffsetForDirection = (direction: number): number => -direction * forwardSign * travelHalfRange;

    if (taskMode) {
      // task 模式：待刷出任务经光电有货且线体运行确认后接管/自建；同 task 已被接管时 cargoCode 被清空且 pendingTask 为空，不会重生。
      if (state.pendingTask && (frontHasGoods || backHasGoods) && movementDirection !== 0) {
        const photoelectricSource = frontHasGoods ? 'front' : 'back';
        state.pendingTask = null;
        this.disposeConveyorCargoForAssetCode(model.assetCode);
        state.cargoTravelOffset = spawnOffsetForDirection(movementDirection);
        state.cargoCode = photoelectricSource;
        this.adoptOrCreateConveyorCargo(model, snapshot, photoelectricSource);
      }
    } else {
      // 匿名模式：前端有货优先；有货但线体未运行时不刷出，等待 movement_x 非 0 确认；
      // 运行中前后信号都暂失时维持原货物身份继续走行。
      const photoelectricSource = frontHasGoods ? 'front' : backHasGoods ? 'back' : state.cargoCode;
      if (!photoelectricSource) return;
      const isNewCargo = state.cargoCode !== photoelectricSource;
      if (isNewCargo) {
        if (movementDirection === 0) return;
        if (state.cargoCode) {
          this.disposeConveyorCargoForAssetCode(model.assetCode);
        }
        state.cargoTravelOffset = spawnOffsetForDirection(movementDirection);
        const cargo = this.getOrCreateConveyorCargo(model.assetCode, photoelectricSource);
        cargo.containerCode = readStringField(snapshot.fields, 'containerCode')?.trim() ?? '';
        cargo.task = '';
      }
      state.cargoCode = photoelectricSource;
    }

    if (!state.cargoCode) return;
    const cargo = this.state.conveyorCargoMeshes.get(this.getConveyorCargoKey(model.assetCode, state.cargoCode));
    if (!cargo) return;

    if (!snapshot.faulted && movementDirection !== 0) {
      const cargoSpeed = translateConfig?.speed ?? CONVEYOR_DEFAULT_TRANSLATE_SPEED_METERS_PER_SECOND;
      state.cargoTravelOffset += movementDirection * forwardSign * cargoSpeed * deltaSeconds;
    }
    // 每帧按当前行程钳制偏移：货箱前沿到端即停住，参数化改长度后旧偏移也不会把货箱留在机外。
    state.cargoTravelOffset = clampNumber(state.cargoTravelOffset, -travelHalfRange, travelHalfRange);

    this.host.syncGeneratedCargoVisual(cargo, 'conveyor', snapshot, this.host.resolveCargoGeneratorForModel(model));
    const pose = resolveCargoHandoffPose(
      cargo,
      this.getConveyorCargoPosition(model, travelContext),
      getNodeWorldRotation(model.root),
      deltaSeconds,
    );
    this.host.setGeneratedCargoRootPose(cargo, pose.position, pose.rotation);
  }

  /** task 模式刷出：全局接管同 task 货箱实例（交接插值接入本机走行），否则自建；接管后本机持锁，上游不再重生。 */
  private adoptOrCreateConveyorCargo(
    model: ModelRuntimeEntry,
    snapshot: DeviceTelemetrySnapshot,
    photoelectricSource: string,
  ): void {
    const cargoKey = this.getConveyorCargoKey(model.assetCode, photoelectricSource);
    const task = model.conveyorTelemetry.currentTask ?? '';
    const containerCode = readStringField(snapshot.fields, 'containerCode')?.trim() ?? '';
    const adopted = this.context.adoptGlobalCargoByTask(task, cargoKey);
    if (adopted) {
      const placeholder = this.state.conveyorCargoMeshes.get(cargoKey);
      if (placeholder && placeholder !== adopted) {
        this.disposeConveyorCargo(placeholder);
        this.state.conveyorCargoMeshes.delete(cargoKey);
      }
      adopted.assetCode = model.assetCode;
      adopted.task = task;
      adopted.containerCode = containerCode || adopted.containerCode;
      adopted.handoff = createCargoHandoffState(adopted);
      this.state.conveyorCargoMeshes.set(cargoKey, adopted);
      return;
    }
    const cargo = this.getOrCreateConveyorCargo(model.assetCode, photoelectricSource);
    cargo.task = task;
    cargo.containerCode = containerCode;
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

  /** 基于输送线行程上下文计算货物底部支撑点，并沿输送方向加入行程偏移。 */
  private getConveyorCargoPosition(
    model: ModelRuntimeEntry,
    travelContext: { center: Vector3; upAxis: Vector3; travelAxis: Vector3 },
  ): Vector3 {
    const legacyCenter = travelContext.center.add(travelContext.upAxis.scale(CONVEYOR_CARGO_SIZE.y * 0.75));
    return legacyCenter
      .subtract(travelContext.upAxis.scale(CONVEYOR_CARGO_SIZE.y / 2))
      .add(travelContext.travelAxis.scale(model.conveyorTelemetry.cargoTravelOffset));
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
