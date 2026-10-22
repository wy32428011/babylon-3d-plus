import type { Scene } from '@babylonjs/core';
import { TransformNode, Vector3 } from '@babylonjs/core';
import {
  clampNumber,
  filterTopLevelMotionNodes,
  getModelAxis,
  getModelTransformNodes,
  getNodesProjectedBounds,
  getNodesWorldBounds,
  moveNumberTowards,
  projectWorldBoundsOntoAxis,
  worldDeltaToParentLocalDelta,
} from '../../runtimeNodeGeometry';
import { isPlainRecord, readStringArrayPath } from '../../runtimeValueUtils';
import { readIntegerField, type DeviceTelemetrySnapshot } from '../../../mqtt/deviceTelemetry';
import { resolveLocatorBoxIndex, resolveLocatorCellSupportWorldPosition } from '../stackerStorageLocation';
import type { LocatorRuntimeEntry, ModelRuntimeEntry } from '../../SceneRuntime';
import { isShuttleRuntimeModel } from './specializedModelAssets';
import { writeDeviceTelemetryMetadata } from './telemetryMetadata';
import { clearLiftMotionFrame, getLiftMotionFrame, publishLiftMotionFrame } from '../liftMotionState';
import {
  HCLIFT_DECK_OCCUPANCY_STALE_MS,
  LIFT_DEFAULT_LIFT_SPEED_METERS_PER_SECOND,
  type SpecializedTelemetryDriverContext,
  type SpecializedTelemetryHost,
  type SpecializedTelemetrySharedState,
  type StackerLiftConstraint,
} from './types';

/**
 * 小车提升机（hclift）遥测驱动：多穿库的真实换层设备，竖版 RGV——载货台沿模型 Y 轴升降，
 * 按巷道对应多穿库换层站台货格（findLayerChangePlatformLocator：deviceAssetCode 命中优先，其次 aisleCode）。
 * lift_current_level 仅首个有效值吸附定位；task_target_level 直接驱动升降动画，不作 finish 完结门控
 * （2/5/7 均可能缺失）；work_state：10（急停）冻结，3（卸小车中）/5（换层中）作为设备动作凭据放行升降，
 * 1（取小车中）禁止升降，其余值只上报。
 * 层高度口径：站台货格下表面中心世界 Y = 载货台（cargo.nodes，Box050/Box051）上表面中心。
 * 只托举多穿小车（hcliftPlatformSurfaces 发布台面实时高度供 shuttle x=-2 跟随），不交接货箱。
 */
export class HcliftTelemetryDriver {
  private readonly motionObservations = new WeakMap<ModelRuntimeEntry, {
    runtimeState: ModelRuntimeEntry['hcliftTelemetry']; baseline: Vector3; deviceIdentity: string;
  }>();
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

  /** 对单台小车提升机应用载货台升降的遥测驱动，并发布载货台实时台面高度。 */
  applyToModel(model: ModelRuntimeEntry, snapshot: DeviceTelemetrySnapshot, deltaSeconds: number): void {
    const runtimeState = model.hcliftTelemetry;
    const previous = this.motionObservations.get(model);
    const deviceIdentity = JSON.stringify([snapshot.sourceId, snapshot.deviceType, snapshot.assetCode]);
    const initialized = previous?.runtimeState === runtimeState && previous.baseline === runtimeState.rootBasePosition
      && previous.deviceIdentity === deviceIdentity && getLiftMotionFrame(model) !== null;
    if (!initialized) clearLiftMotionFrame(model);
    this.reportHcliftRuntimeState(snapshot);
    writeDeviceTelemetryMetadata(model, snapshot);
    model.hcliftTelemetry.workState = readIntegerField(snapshot.fields, 'work_state');
    const lift = this.applyHcliftMotion(model, snapshot, deltaSeconds);
    this.applyHcliftNodeMotionOffsets(model);
    this.publishPlatformSurface(model, snapshot);
    publishLiftMotionFrame(model, this.scene.getFrameId(), initialized && !this.isHcliftFrozen(model, snapshot) ? deltaSeconds : 0, { lift, front: 0, back: 0 });
    this.motionObservations.set(model, { runtimeState, baseline: runtimeState.rootBasePosition, deviceIdentity });
  }

  // ===== 载货台升降 =====

  private applyHcliftMotion(model: ModelRuntimeEntry, snapshot: DeviceTelemetrySnapshot, deltaSeconds: number): number {
    const state = model.hcliftTelemetry;
    const upAxis = getModelAxis(model.root, 'y');
    const frozen = this.isHcliftFrozen(model, snapshot);

    const locator = this.resolvePlatformLocator(model, snapshot);
    if (!locator) return 0;

    const currentLevel = readIntegerField(snapshot.fields, 'lift_current_level');
    if (!state.hasInitialLevel && currentLevel !== null && currentLevel >= 1) {
      const offset = this.resolveLevelLiftOffset(model, locator, currentLevel, upAxis, snapshot);
      if (offset !== null) {
        // 首个实际层直接吸附，避免从导入姿态缓慢追赶
        state.liftOffset = offset;
        state.liftTargetOffset = offset;
        state.targetLevel = currentLevel;
        state.hasInitialLevel = true;
      }
    }

    const targetLevel = readIntegerField(snapshot.fields, 'task_target_level');
    if (!frozen && targetLevel !== null && targetLevel >= 1 && targetLevel !== state.targetLevel) {
      const offset = this.resolveLevelLiftOffset(model, locator, targetLevel, upAxis, snapshot);
      if (offset !== null) {
        state.targetLevel = targetLevel;
        state.liftTargetOffset = offset;
      }
    }

    // 初层吸附在此前完成，只观察其后真正执行的连续升降。
    const before = state.liftOffset;
    const correctedBefore = this.clampLiftOffset(model, before);
    if (this.isHcliftLiftAllowed(model, snapshot) && state.liftTargetOffset !== null) {
      state.liftOffset = moveNumberTowards(state.liftOffset, state.liftTargetOffset, this.readHcliftSpeed(model) * deltaSeconds);
    }

    state.liftOffset = this.clampLiftOffset(model, state.liftOffset);
    return frozen || before !== correctedBefore ? 0 : state.liftOffset - before;
  }

  /**
   * 升降门控：同巷道存在多穿小车时，必须等小车上台并停稳（fresh loaded 占位）、且不在取小车中（ws=1）才允许升降；
   * **换层中（ws=5）/卸小车中（ws=3）以工作状态为设备动作凭据直接放行**——这两个状态本身就说明小车已在台上、
   * 提升机正在执行换层/卸车，不能因占位短暂缺失或未判 loaded 而冻结换层动画（仍保留占位可见的急停/故障否决）。
   * 无关联小车时保持旧行为（允许空载升降）。急停/faulted 始终冻结。
   */
  private isHcliftLiftAllowed(model: ModelRuntimeEntry, snapshot: DeviceTelemetrySnapshot): boolean {
    if (this.isHcliftFrozen(model, snapshot)) return false;
    const key = model.entitySnapshot?.id ?? snapshot.assetCode;
    const occupancy = this.state.hcliftDeckOccupancies.get(key);
    const workState = model.hcliftTelemetry.workState;
    if (workState === 3 || workState === 5) {
      if (!occupancy || Date.now() - occupancy.updatedAtMs > HCLIFT_DECK_OCCUPANCY_STALE_MS) return true;
      return !occupancy.shuttleFaulted && occupancy.shuttleStatus !== 10;
    }
    if (!this.hasAssociatedShuttle(model)) return true;
    if (workState === 1) return false;

    if (!occupancy) return false;
    if (Date.now() - occupancy.updatedAtMs > HCLIFT_DECK_OCCUPANCY_STALE_MS) return false;
    if (occupancy.phase !== 'loaded') return false;
    return !occupancy.shuttleFaulted && occupancy.shuttleStatus !== 10;
  }

  /** 本 hclift 是否有关联的多穿小车：巷道号一致，或任一方未配置巷道时视为可能关联。 */
  private hasAssociatedShuttle(model: ModelRuntimeEntry): boolean {
    const aisleCode = this.resolveHcliftAisleCode(model);
    for (const { model: candidate } of this.host.collectModels()) {
      if (candidate === model || !isShuttleRuntimeModel(candidate)) continue;
      const rawAisle = candidate.entitySnapshot?.components.modelAsset?.parameterValues?.['aisleCode'];
      const shuttleAisle = typeof rawAisle === 'string' ? rawAisle.trim() : '';
      if (!aisleCode || !shuttleAisle || shuttleAisle === aisleCode) return true;
    }
    return false;
  }

  /** 目标层 → 载货台 Y 偏移：站台格下表面中心世界 Y − 载货台上表面基线世界 Y；层越界一次性告警并返回 null。 */
  private resolveLevelLiftOffset(
    model: ModelRuntimeEntry,
    locator: LocatorRuntimeEntry,
    level: number,
    upAxis: Vector3,
    snapshot: DeviceTelemetrySnapshot,
  ): number | null {
    const boxIndex = resolveLocatorBoxIndex({
      startColumn: locator.startColumn,
      startLayer: locator.startLayer,
      columns: locator.columns,
      layers: locator.layers,
      columnReversed: locator.columnReversed,
      toX: locator.startColumn,
      toY: level,
    });
    const supportPosition = boxIndex === null ? null : resolveLocatorCellSupportWorldPosition(locator, boxIndex);
    if (!supportPosition) {
      this.reportHcliftIssueOnce(
        `${snapshot.sourceId}:${snapshot.deviceType}:${snapshot.assetCode}:level:${level}`,
        `错误：小车提升机 ${snapshot.assetCode} 目标层 ${level} 超出换层站台货格范围（层 ${locator.startLayer}-${locator.startLayer + locator.layers - 1}），已忽略移动指令。`,
      );
      return null;
    }
    const deckTopBase = this.resolveDeckTopBaseCoordinate(model, upAxis);
    if (deckTopBase === null) return null;
    return this.clampLiftOffset(model, Vector3.Dot(supportPosition, upAxis) - deckTopBase);
  }

  /** 站台解析：assetCode（站台 deviceAssetCode）优先，巷道号（Inspector aisleCode 参数，同多穿小车）其次；未匹配一次性告警。 */
  private resolvePlatformLocator(model: ModelRuntimeEntry, snapshot: DeviceTelemetrySnapshot): LocatorRuntimeEntry | null {
    const aisleCode = this.resolveHcliftAisleCode(model);
    const locator = this.host.findLayerChangePlatformLocator(snapshot.assetCode, aisleCode);
    if (!locator) {
      this.reportHcliftIssueOnce(
        `${snapshot.sourceId}:${snapshot.deviceType}:${snapshot.assetCode}:platform-missing`,
        `错误：小车提升机 ${snapshot.assetCode} 未匹配到换层站台（站台 deviceAssetCode 与巷道${aisleCode || '未配置'}均无命中），已忽略移动指令。`,
      );
    }
    return locator;
  }

  /** 读取提升机绑定的巷道编号（数据驱动遥测绑定 aisleCode，同 RGV 列绑定模式）；空串表示未配置，不参与巷道匹配。 */
  private resolveHcliftAisleCode(model: ModelRuntimeEntry): string {
    return model.telemetryBinding?.aisleCode?.trim() ?? '';
  }

  /** 载货台节点包围盒顶面在基线（liftOffset=0）时的世界 Y 投影坐标。 */
  private resolveDeckTopBaseCoordinate(model: ModelRuntimeEntry, upAxis: Vector3): number | null {
    const bounds = getNodesWorldBounds(this.findHcliftCargoDeckNodes(model));
    if (!bounds) return null;
    const projected = projectWorldBoundsOntoAxis(bounds, upAxis);
    return projected.max - model.hcliftTelemetry.liftOffset;
  }

  /** 将载货台升降偏移限制在物理行程内：整机静态框架 × 提升部件基线投影（同 lift）；约束不可用时保持 [0, +∞)。 */
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

  /** 读取或创建升降行程约束：整机静态框架决定可升范围，提升部件基线决定端点余量。 */
  private getLiftConstraint(model: ModelRuntimeEntry): StackerLiftConstraint | null {
    const state = model.hcliftTelemetry;
    const upAxis = getModelAxis(model.root, 'y');
    if (state.liftConstraint && Vector3.Dot(state.liftConstraint.axis, upAxis) > 0.999) {
      return state.liftConstraint;
    }

    const deckNodes = this.findHcliftDeckNodes(model);
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

  /** 把载货台升降偏移一次性写回提升部件节点，其余结构保持不动。 */
  private applyHcliftNodeMotionOffsets(model: ModelRuntimeEntry): void {
    const state = model.hcliftTelemetry;
    const upAxis = getModelAxis(model.root, 'y');
    const worldOffset = upAxis.scale(state.liftOffset);
    for (const node of filterTopLevelMotionNodes(this.findHcliftDeckNodes(model))) {
      const baseline = this.getNodeBaseline(model, node);
      node.position = baseline.add(worldDeltaToParentLocalDelta(node, worldOffset));
    }
  }

  /** 发布载货台上表面实时世界 Y 与层状态：多穿小车 x=-2 换层时按巷道/assetCode 匹配跟随，到层（arrived）触发自动出梯。 */
  private publishPlatformSurface(model: ModelRuntimeEntry, snapshot: DeviceTelemetrySnapshot): void {
    const bounds = getNodesWorldBounds(this.findHcliftCargoDeckNodes(model));
    if (!bounds) return;
    const state = model.hcliftTelemetry;
    const supportY = projectWorldBoundsOntoAxis(bounds, getModelAxis(model.root, 'y')).max;
    this.state.hcliftPlatformSurfaces.set(model.entitySnapshot?.id ?? snapshot.assetCode, {
      assetCode: snapshot.assetCode,
      aisleCode: this.resolveHcliftAisleCode(model),
      supportY,
      deckCenter: bounds.minimum.add(bounds.maximum).scale(0.5),
      targetLevel: state.targetLevel,
      arrived: state.liftTargetOffset !== null && Math.abs(state.liftOffset - state.liftTargetOffset) <= 1e-3,
      updatedAtMs: Date.now(),
    });
  }

  /** 急停（work_state=10）与 faulted 同等冻结：不寻址、不移动。 */
  private isHcliftFrozen(model: ModelRuntimeEntry, snapshot: DeviceTelemetrySnapshot): boolean {
    return snapshot.faulted || model.hcliftTelemetry.workState === 10;
  }

  // ===== 节点与配置读取 =====

  /** 记录遥测动作前的节点基线位置。 */
  private getNodeBaseline(model: ModelRuntimeEntry, node: TransformNode): Vector3 {
    const existing = model.hcliftTelemetry.nodeBaselines.get(node);
    if (existing) return existing;

    const baseline = node.position.clone();
    model.hcliftTelemetry.nodeBaselines.set(node, baseline);
    return baseline;
  }

  /** 查找提升部件随动节点：模型脚本 dataDriven.motion.lift.nodes 声明，兼容参数化运行时克隆。 */
  private findHcliftDeckNodes(model: ModelRuntimeEntry): TransformNode[] {
    return this.findHcliftConfiguredNodes(model, this.readHcliftMotionNodeNames(model));
  }

  /** 查找载货台节点（层对齐/台面发布口径）：dataDriven.cargo.nodes 声明，未声明回退提升部件全集。 */
  private findHcliftCargoDeckNodes(model: ModelRuntimeEntry): TransformNode[] {
    const configuredNames = this.readHcliftCargoNodeNames(model);
    if (configuredNames.length === 0) return this.findHcliftDeckNodes(model);
    const nodes = this.findHcliftConfiguredNodes(model, configuredNames);
    return nodes.length > 0 ? nodes : this.findHcliftDeckNodes(model);
  }

  /** 按声明节点名收集原始节点及其参数化运行时克隆（metadata.motionSourceNodeName 兼容链）。 */
  private findHcliftConfiguredNodes(model: ModelRuntimeEntry, names: string[]): TransformNode[] {
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

  /** 读取模型脚本 dataDriven.motion.lift.nodes 声明的提升部件节点名。 */
  private readHcliftMotionNodeNames(model: ModelRuntimeEntry): string[] {
    for (const dataDriven of model.externalScriptRuntime?.getDataDrivenConfigs() ?? []) {
      const nodes = readStringArrayPath(dataDriven, ['motion', 'lift', 'nodes']);
      if (nodes.length > 0) return nodes;
    }
    return [];
  }

  /** 读取模型脚本 dataDriven.cargo.nodes 声明的载货台节点名。 */
  private readHcliftCargoNodeNames(model: ModelRuntimeEntry): string[] {
    for (const dataDriven of model.externalScriptRuntime?.getDataDrivenConfigs() ?? []) {
      const nodes = readStringArrayPath(dataDriven, ['cargo', 'nodes']);
      if (nodes.length > 0) return nodes;
    }
    return [];
  }

  /** 读取载货台升降速度（米/秒）：Inspector liftSpeed 参数优先，其次 dataDriven.motion.lift.speed，最后常量兜底（同 lift 优先级）。 */
  private readHcliftSpeed(model: ModelRuntimeEntry): number {
    const inspectorSpeed = model.entitySnapshot?.components.modelAsset?.parameterValues?.liftSpeed;
    if (typeof inspectorSpeed === 'number' && Number.isFinite(inspectorSpeed) && inspectorSpeed > 0) {
      return inspectorSpeed;
    }
    for (const dataDriven of model.externalScriptRuntime?.getDataDrivenConfigs() ?? []) {
      const speed = this.readNumberPath(dataDriven, ['motion', 'lift', 'speed']);
      if (speed !== null && speed > 0) return speed;
    }
    return LIFT_DEFAULT_LIFT_SPEED_METERS_PER_SECOND;
  }

  /** 按路径读取数值配置，供模型脚本 dataDriven 扩展字段使用。 */
  private readNumberPath(source: unknown, path: string[]): number | null {
    let current: unknown = source;
    for (const key of path) {
      if (!isPlainRecord(current)) return null;
      current = current[key];
    }
    const value = Number(current);
    return Number.isFinite(value) ? value : null;
  }

  // ===== 上报 =====

  private reportHcliftRuntimeState(snapshot: DeviceTelemetrySnapshot): void {
    const deviceKey = `${snapshot.sourceId}:${snapshot.deviceType}:${snapshot.assetCode}`;
    if (!snapshot.faulted) {
      this.state.reportedFaults.delete(deviceKey);
      return;
    }

    const faultMessage = snapshot.message || `errorCode=${readIntegerField(snapshot.fields, 'errorCode') ?? 0}`;
    if (this.state.reportedFaults.get(deviceKey) === faultMessage) return;

    this.state.reportedFaults.set(deviceKey, faultMessage);
    this.host.pushLog(`小车提升机 ${snapshot.assetCode} 故障/急停：${faultMessage}`);
  }

  /** 小车提升机运行问题按稳定 key 只写一次 Console。 */
  private reportHcliftIssueOnce(key: string, message: string): void {
    if (this.state.reportedMissingTargets.has(key)) return;
    this.state.reportedMissingTargets.add(key);
    this.host.pushLog(message);
  }
}
