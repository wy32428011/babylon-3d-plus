import type { Scene, Vector3 } from '@babylonjs/core';
import { Quaternion, TransformNode } from '@babylonjs/core';
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
  type DeviceTelemetrySnapshot,
} from '../../../mqtt/deviceTelemetry';
import { resolveConveyorCargoTravelHalfRange } from '../conveyorCargoTravel';
import type { ModelRuntimeEntry } from '../../SceneRuntime';
import { readConveyorCargoSignalFields, readConveyorMotionConfigs } from './specializedModelAssets';
import { writeDeviceTelemetryMetadata } from './telemetryMetadata';
import {
  type ConveyorCargoRuntimeEntry,
  type ConveyorMotionConfig,
  type ConveyorNodeBaseline,
  CONVEYOR_CARGO_SIZE,
  CONVEYOR_DEFAULT_TRANSLATE_LOOP_METERS,
  CONVEYOR_DEFAULT_TRANSLATE_SPEED_METERS_PER_SECOND,
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

  /** 根据光电信号（缺省 front_has_goods / back_has_goods，可在 motion.cargo 配置）决定货物创建与销毁，货物走行跟随 translate 配置的方向与速度。 */
  private applyConveyorCargoMotion(
    model: ModelRuntimeEntry,
    snapshot: DeviceTelemetrySnapshot,
    deltaSeconds: number,
  ): void {
    const signalFields = readConveyorCargoSignalFields(model);
    const frontHasGoods = readBooleanField(snapshot.fields, signalFields.frontHasGoods) ?? false;
    const backHasGoods = readBooleanField(snapshot.fields, signalFields.backHasGoods) ?? false;

    if (!frontHasGoods && !backHasGoods) {
      this.disposeConveyorCargoForAssetCode(model.assetCode);
      model.conveyorTelemetry.cargoCode = null;
      return;
    }

    // 前端有货优先；前后同时有货时按前端处理。
    const photoelectricSource = frontHasGoods ? 'front' : 'back';
    const isNewCargo = model.conveyorTelemetry.cargoCode !== photoelectricSource;
    if (isNewCargo && model.conveyorTelemetry.cargoCode) {
      this.disposeConveyorCargoForAssetCode(model.assetCode);
    }

    // 货物走行与链条本体共用同一份 translate 配置（fields+actionMap+speed），避免链/货速度脱节。
    const translateConfig = this.findConveyorCargoTranslateConfig(model);
    const movementDirection = translateConfig
      ? this.readConveyorMotionDirection(snapshot, translateConfig)
      : this.readConveyorMovementDirection(readIntegerField(snapshot.fields, 'movement_x'));
    const travelContext = this.resolveConveyorCargoTravelContext(model);
    const travelHalfRange = resolveConveyorCargoTravelHalfRange(
      travelContext.spanMeters ?? 0,
      CONVEYOR_CARGO_SIZE[travelContext.travelAxisName],
    );
    if (isNewCargo) {
      // front_has_goods → 正向前端刷出；back_has_goods → 负向末端刷出。
      model.conveyorTelemetry.cargoTravelOffset = frontHasGoods ? travelHalfRange : -travelHalfRange;
    }
    if (!snapshot.faulted && movementDirection !== 0) {
      const cargoSpeed = translateConfig?.speed ?? CONVEYOR_DEFAULT_TRANSLATE_SPEED_METERS_PER_SECOND;
      model.conveyorTelemetry.cargoTravelOffset += movementDirection * cargoSpeed * deltaSeconds;
    }
    // 每帧按当前行程钳制偏移：货箱前沿到端即停住，参数化改长度后旧偏移也不会把货箱留在机外。
    model.conveyorTelemetry.cargoTravelOffset = clampNumber(model.conveyorTelemetry.cargoTravelOffset, -travelHalfRange, travelHalfRange);

    const cargo = this.getOrCreateConveyorCargo(model.assetCode, photoelectricSource);
    this.host.syncGeneratedCargoVisual(cargo, 'conveyor', snapshot, this.host.resolveCargoGeneratorForModel(model));
    this.host.setGeneratedCargoRootPose(
      cargo,
      this.getConveyorCargoPosition(model, travelContext),
      getNodeWorldRotation(model.root),
    );
    model.conveyorTelemetry.cargoCode = photoelectricSource;
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
      root,
      outputOwner: null,
      fallback: null,
      generatorEntityId: null,
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
    const translateConfig = this.findConveyorCargoTranslateConfig(model);
    if (translateConfig?.axis === 'x' || translateConfig?.axis === 'z') return translateConfig.axis;

    const rotateConfig = readConveyorMotionConfigs(model).find((config) => config.kind === 'rotate');
    if (rotateConfig?.axis === 'x') return 'z';
    return 'x';
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
