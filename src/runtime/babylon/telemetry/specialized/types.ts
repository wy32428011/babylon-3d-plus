import type { Mesh, Scene, StandardMaterial, TransformNode } from '@babylonjs/core';
import { Quaternion, Vector3 } from '@babylonjs/core';
import type { ModelGeneratorComponent } from '../../../../editor/model/components';
import type { ExternalModelScriptTelemetrySnapshot } from '../../ExternalModelScriptRuntime';
import type {
  GeneratedOutputOwnerRuntimeEntry,
  LocatorRuntimeEntry,
  ModelGeneratorRuntimeEntry,
  ModelRuntimeEntry,
} from '../../SceneRuntime';
import type { RuntimeWorldBounds } from '../../runtimeNodeGeometry';
import type { DeviceTelemetrySnapshot } from '../../../mqtt/deviceTelemetry';
import type { ResolvedSpecializedTelemetryBinding } from '../specializedTelemetryBinding';

export const STACKER_CALIBRATION_RATE = 4;
export const STACKER_TARGET_SPEED_METERS_PER_SECOND = 1.2;
export const STACKER_DEFAULT_TRAVEL_SPEED_METERS_PER_SECOND = 0.8;
export const STACKER_DEFAULT_LIFT_SPEED_METERS_PER_SECOND = 0.3;
export const STACKER_DEFAULT_FORK_SPEED_METERS_PER_SECOND = 0.25;
export const STACKER_RPM_TO_METERS_PER_SECOND = 0.01;
export const STACKER_CARGO_COLOR = '#d8a03a';
export const STACKER_CARGO_EMISSIVE_COLOR = '#3a2508';
export const STACKER_CARGO_SIZE = new Vector3(0.8, 0.42, 0.8);
export const CONVEYOR_CARGO_COLOR = '#4fa3d8';
export const CONVEYOR_CARGO_EMISSIVE_COLOR = '#09283a';
export const CONVEYOR_CARGO_SIZE = new Vector3(0.72, 0.34, 0.72);
export const CONVEYOR_ANONYMOUS_CARGO_CODE = '__anonymous__';

/** 归一化 MQTT task 字段为全局货物身份：null/0 为匿名（空串），不参与全局唯一。 */
export function normalizeCargoTask(value: number | null): string {
  return value !== null && value !== 0 ? String(value) : '';
}

/** 货物跨设备交接的视觉过渡时长（秒）：接管后从原世界位姿插值接入新设备动画。 */
export const CARGO_HANDOFF_SECONDS = 1.0;

/** 交接插值状态：adopt 时记录货物当前世界位姿，progress 到 1 后过渡结束。 */
export type CargoHandoffState = {
  fromPosition: Vector3;
  fromRotation: Quaternion;
  progress: number;
};

/** 交接插值：handoff 未完结时在接管起点与目标位姿间插值并推进进度，完结后清除并返回目标位姿。 */
export function resolveCargoHandoffPose(
  cargo: { handoff: CargoHandoffState | null },
  targetPosition: Vector3,
  targetRotation: Quaternion,
  deltaSeconds: number,
): { position: Vector3; rotation: Quaternion } {
  const handoff = cargo.handoff;
  if (!handoff) return { position: targetPosition, rotation: targetRotation };
  handoff.progress = Math.min(1, handoff.progress + deltaSeconds / CARGO_HANDOFF_SECONDS);
  const position = Vector3.Lerp(handoff.fromPosition, targetPosition, handoff.progress);
  const rotation = Quaternion.Slerp(handoff.fromRotation, targetRotation, handoff.progress);
  if (handoff.progress >= 1) cargo.handoff = null;
  return { position, rotation };
}

/** 以货物当前世界位姿为起点创建交接插值状态（root 无父级，本地位姿即世界位姿）。 */
export function createCargoHandoffState(cargo: { root: TransformNode }): CargoHandoffState {
  return {
    fromPosition: cargo.root.position.clone(),
    fromRotation: cargo.root.rotationQuaternion?.clone() ?? Quaternion.Identity(),
    progress: 0,
  };
}
export const CONVEYOR_DEFAULT_TRANSLATE_LOOP_METERS = 1.2;
export const CONVEYOR_DEFAULT_ROTATE_SPEED_DEGREES_PER_SECOND = 180;
export const CONVEYOR_DEFAULT_TRANSLATE_SPEED_METERS_PER_SECOND = 0.3;
export const RGV_DEFAULT_TRAVEL_SPEED_METERS_PER_SECOND = 0.8;
/** RGV 货箱交接（列接驳位 ↔ 车工位）一次完整移行时长。 */
export const RGV_CARGO_TRANSFER_SECONDS = 1.5;
export const RGV_CARGO_COLOR = '#7db85c';
export const RGV_CARGO_EMISSIVE_COLOR = '#1e3a14';
export const RGV_CARGO_SIZE = new Vector3(0.8, 0.42, 0.8);
/** RGV 固定轨道节点（导轨 A45/A46 + 盖板 A37~A44）名称兜底匹配，兼容 GLB 导入的 . / _ 后缀。 */
export const RGV_FALLBACK_FIXED_NODE_PATTERN = /^A(?:3[7-9]|4[0-6])(?:[._]|$)/i;
export const STACKER_FALLBACK_FIXED_NODE_NAMES = ['guidaoshang.1', 'guidaoxia.2'];
export const STACKER_FALLBACK_TRAVEL_NODE_NAMES = [
  'dingbuhuagui2.3',
  'dingbuhuagui1.4',
  'dingbu.5',
  'dibu.6',
  'lizhu1.11',
  'lizhu2.12',
  'dianji.7',
  'caozuotai.8',
  'xiang.13',
  'huocha.9',
  'huocha2.10',
];

export type StackerTravelConstraint = {
  axis: Vector3;
  trackMin: number;
  trackMax: number;
  movingMin: number;
  movingMax: number;
};

export type StackerForkSide = 'front' | 'back';

export type StackerForkReachConfig = {
  stageOne: number;
  stageTwo: number;
  total: number;
};

export type StackerForkOffsetParts = {
  totalOffset: number;
  stageOneOffset: number;
  stageTwoOffset: number;
  activeStage: 0 | 1 | 2;
};

export type StackerForkNodeGroups = {
  frontNodes: TransformNode[];
  backNodes: TransformNode[];
  frontStageOneNodes: TransformNode[];
  frontStageTwoNodes: TransformNode[];
  backStageOneNodes: TransformNode[];
  backStageTwoNodes: TransformNode[];
};

export type GeneratedCargoKind = 'stacker' | 'conveyor' | 'rgv';

export type GeneratedCargoFallbackRuntimeEntry = {
  mesh: Mesh;
  material: StandardMaterial;
};

/** 普通自动货物共享字段；root 始终表示货物底部支撑点。 */
export type GeneratedCargoRuntimeEntry = {
  assetCode: string;
  /** MQTT containerCode，仅作元数据（命名/metadata），不参与全局唯一性。 */
  containerCode: string;
  /** MQTT task（归一化字符串）：全局货物唯一身份，空串为匿名不参与跨设备接管。 */
  task: string;
  root: TransformNode;
  outputOwner: GeneratedOutputOwnerRuntimeEntry | null;
  fallback: GeneratedCargoFallbackRuntimeEntry | null;
  /** 货箱模板来源生成器实体 ID；null 表示内置几何体回退。 */
  generatorEntityId: string | null;
  /** 跨设备接管时的视觉过渡；null 表示无交接插值。 */
  handoff: CargoHandoffState | null;
};

export type StackerCargoRuntimeEntry = GeneratedCargoRuntimeEntry;

export type StackerModelTelemetryState = {
  rootBasePosition: Vector3;
  /** 行走机构的虚拟世界位置；模型根节点和上下轨道保持静止。 */
  rootPosition: Vector3 | null;
  /** 基于固定轨道和行走机构基线计算的轨道约束，防止遥测把机体推出轨道。 */
  travelConstraint: StackerTravelConstraint | null;
  /** 货叉未伸出时用于对齐库位的世界坐标锚点。 */
  targetReferencePosition: Vector3 | null;
  liftOffset: number;
  frontForkOffset: number;
  backForkOffset: number;
  lastFrameTimeMs: number;
  frontForkDirection: number;
  backForkDirection: number;
  /** 叉上货物键（JSON.stringify([assetCode, side])）；非 null 表示叉上有货。 */
  frontCargoKey: string | null;
  backCargoKey: string | null;
  /** 货物是否绑定叉尖；false 时静止于 holdPosition（取货=源箱位，放货=目标箱位）。 */
  frontCargoBoundToFork: boolean;
  backCargoBoundToFork: boolean;
  frontCargoHoldPosition: Vector3 | null;
  backCargoHoldPosition: Vector3 | null;
  /** 未绑定时货物在箱位中的朝向（取货=源库位，放货=目标库位）。 */
  frontCargoHoldRotation: Quaternion | null;
  backCargoHoldRotation: Quaternion | null;
  /** 箱位朝向含镜像（负缩放）时的缩放分量；null 表示无镜像，按单位缩放渲染。 */
  frontCargoHoldScaling: Vector3 | null;
  backCargoHoldScaling: Vector3 | null;
  /** 取货时锁定的源排号，取货完成（command 2）用于触发 fetch 单排同步。 */
  frontCargoFetchRow: number | null;
  backCargoFetchRow: number | null;
  /** command 边沿检测：取货/放货完成只触发一次。 */
  frontLastCommand: number | null;
  backLastCommand: number | null;
  nodeBaselines: Map<TransformNode, Vector3>;
  lastTargetKey: string | null;
};

export type ConveyorNodeBaseline = {
  position: Vector3;
};

export type ConveyorModelTelemetryState = {
  cargoCode: string | null;
  /** 当前 task（归一化字符串）：task 模式下同 task 不重复刷出，构成接管锁；线体清空后复位允许复用。 */
  currentTask: string | null;
  /** 已登记待光电确认刷出的 task；光电报有货时消费。 */
  pendingTask: string | null;
  cargoTravelOffset: number;
  motionOffsets: Map<string, number>;
  nodeBaselines: Map<TransformNode, ConveyorNodeBaseline>;
};

export type ConveyorCargoRuntimeEntry = GeneratedCargoRuntimeEntry;

export type RgvForkSide = 'front' | 'back';

export type RgvTravelConstraint = {
  axis: Vector3;
  trackMin: number;
  trackMax: number;
  movingMin: number;
  movingMax: number;
};

export type RgvModelTelemetryState = {
  rootBasePosition: Vector3;
  /** 车体的虚拟世界位置；模型根节点和固定轨道保持静止（同 stacker rootPosition 语义）。 */
  rootPosition: Vector3 | null;
  /** 基于固定轨道和车体基线计算的行走约束，防止遥测把车推出轨道。 */
  travelConstraint: RgvTravelConstraint | null;
  /** 列信号给出的行走目标世界位置（沿行走轴投影）。 */
  travelTargetPosition: Vector3 | null;
  /** 行走目标对应的列号，用于列号边沿检测。 */
  travelTargetColumn: number | null;
  frontCargoKey: string | null;
  backCargoKey: string | null;
  /** true=货箱在车上随工位；false=静止于列接驳位或正在交接插值。 */
  frontCargoOnBoard: boolean;
  backCargoOnBoard: boolean;
  frontCargoHoldPosition: Vector3 | null;
  backCargoHoldPosition: Vector3 | null;
  frontCargoHoldRotation: Quaternion | null;
  backCargoHoldRotation: Quaternion | null;
  /** 0=在车体朝向列设备一侧的侧缘，1=在车上工位（交接插值进度）。 */
  frontTransferProgress: number;
  backTransferProgress: number;
  frontLastCommand: number | null;
  backLastCommand: number | null;
  frontLastMovementZ: number | null;
  backLastMovementZ: number | null;
  nodeBaselines: Map<TransformNode, Vector3>;
};

export type RgvCargoRuntimeEntry = GeneratedCargoRuntimeEntry;

export type ConveyorMotionConfig = {
  key: string;
  fields: string[];
  kind: 'rotate' | 'translate';
  axis: 'x' | 'y' | 'z';
  actionMap: Record<string, number>;
  speed: number;
  nodes: string[];
  fallbackPattern: string | null;
};

export type SpecializedTelemetryRuntimeEntry = {
  entityId: string;
  model: ModelRuntimeEntry;
  binding: ResolvedSpecializedTelemetryBinding;
};

/** 门面与两个 driver 共享的可变状态；由 SpecializedTelemetryRuntime 构造时创建一份。 */
export type SpecializedTelemetrySharedState = {
  stackerCargoMeshes: Map<string, StackerCargoRuntimeEntry>;
  conveyorCargoMeshes: Map<string, ConveyorCargoRuntimeEntry>;
  rgvCargoMeshes: Map<string, RgvCargoRuntimeEntry>;
  reportedMissingTargets: Set<string>;
  reportedFaults: Map<string, string>;
  reportedStatuses: Map<string, string>;
  reportedInvalidStackerBoxTargets: Set<string>;
  lastReportedStackerTargetSignatures: Map<string, string>;
};

export function createSpecializedTelemetrySharedState(): SpecializedTelemetrySharedState {
  return {
    stackerCargoMeshes: new Map(),
    conveyorCargoMeshes: new Map(),
    rgvCargoMeshes: new Map(),
    reportedMissingTargets: new Set(),
    reportedFaults: new Map(),
    reportedStatuses: new Map(),
    reportedInvalidStackerBoxTargets: new Set(),
    lastReportedStackerTargetSignatures: new Map(),
  };
}

export interface SpecializedTelemetryHost {
  pushLog(message: string): void;
  /** models + modelArrayParameterVariants 的合并视图（entityId 用 representativeEntityId）。 */
  collectModels(): Iterable<{ entityId: string; model: ModelRuntimeEntry }>;
  findLocatorByDevice(assetCode: string, x: number, y: number, z: number): LocatorRuntimeEntry | null;
  getLocatorTarget(key: string): LocatorRuntimeEntry | null;
  resolveCargoGeneratorForModel(model: ModelRuntimeEntry): ModelGeneratorRuntimeEntry | null;
  /** 按实体 ID 解析 RGV 列接驳位的世界位姿（模型/定位线框/基础网格实体的 root，或合批阵列实例的实体位姿）；不存在返回 null。 */
  resolveColumnTargetPose(entityId: string): { position: Vector3; rotation: Quaternion } | null;
  resolveFetchDriveRowForLocator(locator: LocatorRuntimeEntry): number | null;
  /** 抑制 locator 某格口的 fetch 渲染（货物改由设备侧渲染）；返回排号，未启用 fetch 返回 null。 */
  suppressFetchCellForLocator(locator: LocatorRuntimeEntry, column: number, layer: number): number | null;
  handleFetchRowSync(rowNumber: number): void;
  keepCargoForFetchRowSync(rowNumber: number | null, assetCode: string, cargoKey: string): boolean;
  /** 返回 preparedArrayHost；defer 刷新由调用方决定。对应 updateModelExternalScriptRuntimeContext(model, 'runtime', telemetry, true)。 */
  updateExternalScriptContext(
    model: ModelRuntimeEntry,
    telemetry: ExternalModelScriptTelemetrySnapshot | null,
  ): boolean;
  refreshModelArrayRepresentation(model: ModelRuntimeEntry): void;
  getGeneratedCargoFallbackSpec(kind: GeneratedCargoKind): {
    size: Vector3;
    color: string;
    emissiveColor: string;
  };
  ensureGeneratedCargoFallback(cargo: GeneratedCargoRuntimeEntry, kind: GeneratedCargoKind): void;
  ensureGeneratedCargoOutputOwner(
    cargo: GeneratedCargoRuntimeEntry,
    kind: GeneratedCargoKind,
    component: ModelGeneratorComponent,
    snapshot: DeviceTelemetrySnapshot,
  ): GeneratedOutputOwnerRuntimeEntry;
  syncGeneratedCargoVisual(
    cargo: GeneratedCargoRuntimeEntry,
    kind: GeneratedCargoKind,
    snapshot: DeviceTelemetrySnapshot,
    generator: ModelGeneratorRuntimeEntry | null,
  ): void;
  setGeneratedCargoRootPose(cargo: GeneratedCargoRuntimeEntry, position: Vector3, rotation: Quaternion, scaling?: Vector3 | null): void;
  disposeGeneratedCargo(cargo: GeneratedCargoRuntimeEntry): void;
  /** 导入模型优先汇总子网格包围盒，加载中则回退到模型根节点位置。 */
  getModelWorldBounds(model: ModelRuntimeEntry): RuntimeWorldBounds | null;
}

export interface SpecializedTelemetryDriverContext {
  readonly scene: Scene;
  readonly state: SpecializedTelemetrySharedState;
  readonly host: SpecializedTelemetryHost;
  disposeStackerCargo(cargo: StackerCargoRuntimeEntry): void;
  disposeConveyorCargo(cargo: ConveyorCargoRuntimeEntry): void;
  getOrCreateStackerCargo(assetCode: string, side: StackerForkSide): StackerCargoRuntimeEntry;
  getOrCreateConveyorCargo(assetCode: string, containerCode: string): ConveyorCargoRuntimeEntry;
  /**
   * 按 task 全局接管货物：找到其他设备持有的同 task 货箱时，由其 driver 清理遥测引用后
   * 取出条目（不销毁）返回给调用方；未找到返回 null，调用方走自建路径。
   * 空 task（匿名）不参与，直接返回 null。
   */
  adoptGlobalCargoByTask(task: string, claimingCargoKey: string): GeneratedCargoRuntimeEntry | null;
}
