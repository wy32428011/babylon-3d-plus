import type { Mesh, Scene, StandardMaterial, TransformNode } from '@babylonjs/core';
import { Quaternion, Vector3 } from '@babylonjs/core';
import type { ModelGeneratorComponent } from '../../../../editor/model/components';
import type { ExternalModelScriptRuntime, ExternalModelScriptTelemetrySnapshot } from '../../ExternalModelScriptRuntime';
import type {
  GeneratedOutputOwnerRuntimeEntry,
  LocatorRuntimeEntry,
  ModelGeneratorRuntimeEntry,
  ModelRuntimeEntry,
} from '../../SceneRuntime';
import type { RuntimeWorldBounds } from '../../runtimeNodeGeometry';
import type { DeviceTelemetrySnapshot } from '../../../mqtt/deviceTelemetry';
import type { ResolvedSpecializedTelemetryBinding } from '../specializedTelemetryBinding';

export const STACKER_TARGET_SPEED_METERS_PER_SECOND = 1.2;
export const STACKER_DEFAULT_TRAVEL_SPEED_METERS_PER_SECOND = 0.8;
export const STACKER_DEFAULT_LIFT_SPEED_METERS_PER_SECOND = 0.3;
export const STACKER_DEFAULT_FORK_SPEED_METERS_PER_SECOND = 0.25;
/** front_ 变化触发动作收尾时，货叉收回速度倍率。 */
export const STACKER_FORK_CATCH_UP_SPEED_MULTIPLIER = 4;
/** 自适应追赶速度的估算窗口下限/上限（秒）：按 front_ 变化间隔估算，夹在 0.25s~2s。 */
export const STACKER_CATCH_UP_MIN_WINDOW_SECONDS = 0.25;
export const STACKER_CATCH_UP_MAX_WINDOW_SECONDS = 2;
/** 自适应追赶速度上限（m/s），防止极端间隔下速度爆炸。 */
export const STACKER_MAX_CATCH_UP_SPEED_METERS_PER_SECOND = 8;
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
  /** 本次交接的插值总时长（秒）：越级交付按跳数除数加快（CARGO_HANDOFF_SECONDS / hops）。 */
  durationSeconds: number;
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
  handoff.progress = Math.min(1, handoff.progress + deltaSeconds / handoff.durationSeconds);
  const position = Vector3.Lerp(handoff.fromPosition, targetPosition, handoff.progress);
  const rotation = Quaternion.Slerp(handoff.fromRotation, targetRotation, handoff.progress);
  if (handoff.progress >= 1) cargo.handoff = null;
  return { position, rotation };
}

/** 以货物当前世界位姿为起点创建交接插值状态（root 无父级，本地位姿即世界位姿）。 */
export function createCargoHandoffState(
  cargo: { root: TransformNode },
  durationSeconds: number = CARGO_HANDOFF_SECONDS,
): CargoHandoffState {
  return {
    fromPosition: cargo.root.position.clone(),
    fromRotation: cargo.root.rotationQuaternion?.clone() ?? Quaternion.Identity(),
    progress: 0,
    durationSeconds: Math.max(durationSeconds, 0.05),
  };
}
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

/** 升降物理行程：整机移动框架（含立柱）决定框架范围，载货台/货叉基线决定端点余量。 */
export type StackerLiftConstraint = {
  axis: Vector3;
  frameMin: number;
  frameMax: number;
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
  /** 基于整机框架和载货台基线计算的升降行程约束，防止遥测把载货台顶出立柱。 */
  liftConstraint: StackerLiftConstraint | null;
  /** 货叉未伸出时用于对齐库位的世界坐标锚点。 */
  targetReferencePosition: Vector3 | null;
  liftOffset: number;
  frontForkOffset: number;
  backForkOffset: number;
  lastFrameTimeMs: number;
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
  /** 上一帧 front_x/front_y/front_z 组成的库位键；变化时触发动作收尾（catch-up）。 */
  lastFrontCellKey: string | null;
  /** true 表示正在快速收尾：货叉加速收回，收回前冻结平移/升降。 */
  forkCatchUp: boolean;
  /** 按节点几何实测的前叉一段/二段行程上限；null 表示尚未测量。 */
  frontForkStroke: StackerForkReachConfig | null;
  backForkStroke: StackerForkReachConfig | null;
  /** 当前货格要求的前叉目标行程（有符号，沿伸出方向）；由库位几何每帧求解。 */
  frontForkTargetOffset: number;
  backForkTargetOffset: number;
  /** 最近一次 front_ 库位键变化的时间戳（performance.now()）；null 表示尚未收到过有效库位。 */
  lastFrontCellChangedAtMs: number | null;
  /** 最近两次 front_ 变化的间隔（毫秒），用于估算自适应追赶窗口；null 表示尚未观察到变化。 */
  frontCellChangeIntervalMs: number | null;
};

/** 上位链路：本机的一条货物来向通道，由持有方的 available 通知建立（探测邻居或注册设备均可为上一跳）。 */
export type ConveyorUpstreamLink = {
  /** 该链路通报的在持货物 task。 */
  task: string;
  /** 实际持货设备 assetCode（链路可跨越多跳，holder 未必是上一跳）。 */
  holderAssetCode: string;
  /** 本机距持货设备的跳数，兼作越级交付交接动画的时长除数。 */
  hops: number;
  /** 链路建立时的流向；流向翻转后链路失效清空。 */
  direction: number;
};

/** 下位链路：最终订阅者的货物订阅登记，由 subscribe 消息建立。 */
export type ConveyorDownstreamLink = {
  /** 订阅的货物 task。 */
  task: string;
  /** 订阅者距本机的跳数，兼作越级交付交接动画的时长除数。 */
  hops: number;
  /** 链路建立时的流向；流向翻转后链路失效清空。 */
  direction: number;
};

/** 外部持货拉取登记：订阅传播到 stacker/RGV 邻居时由相邻 conveyor 登记，帧尾扫描拉取。key=最终订阅者 assetCode。 */
export type ConveyorExternalPull = {
  holderAssetCode: string;
  task: string;
  /** 订阅者距外部持货设备的跳数，兼作交接动画时长除数。 */
  hops: number;
  direction: number;
};

/** 输送线行程规划缓存：走行上下文/行程半径/轨迹符号，预览期间模型不动可安全缓存，reset 时清空重算。 */
export type ConveyorCargoTravelPlan = {
  readonly travelContext: {
    readonly center: Vector3;
    readonly upAxis: Vector3;
    readonly travelAxis: Vector3;
    readonly travelAxisName: 'x' | 'z';
    readonly spanMeters: number | null;
    /** 支撑面抬升量（米）：center 沿 upAxis 到设备包围盒上表面的距离 + dataDriven.cargo.surfaceOffset 微调。 */
    readonly surfaceLiftMeters: number;
  };
  readonly travelHalfRange: number;
  readonly forwardSign: 1 | -1;
};

export type ConveyorModelTelemetryState = {
  cargoCode: string | null;
  /** 当前 task（归一化字符串）：刷出时盖到货物上，供全局接管匹配。 */
  currentTask: string | null;
  /** 已登记待确认的 task；新 task 边沿当帧进入持货复用/销毁或订阅判定。 */
  pendingTask: string | null;
  /** 最近接受的 task：边沿判定基准，不随线体清空复位，同 task 重复到达不得重走刷出+走行。 */
  lastTask: string | null;
  /** 正在等待上游交付的 task（归一化字符串）；非 null 时本机不刷出、不走行。 */
  waitingTask: string | null;
  /** 探测点邻居缓存（按正/反转各存邻居 assetCode），reset 时清空重算。 */
  probeNeighbors: { forward: string | null; reverse: string | null } | null;
  /** 行程规划缓存：首次需要时计算（避免等待设备每帧全场景几何扫描），reset 时清空。 */
  travelPlan: ConveyorCargoTravelPlan | null;
  /** 上位链路表：key=上一跳 assetCode；available 通知建立、taken 通知清除，含通知注册进来的非探测上游。 */
  upstreamLinks: Map<string, ConveyorUpstreamLink>;
  /** 下位链路表：key=最终订阅者 assetCode；subscribe 建立、unsubscribe/交付完成清除。 */
  downstreamLinks: Map<string, ConveyorDownstreamLink>;
  /** 外部持货拉取登记：订阅传播到 stacker/RGV 邻居时由相邻 conveyor 登记，帧尾扫描拉取。key=最终订阅者 assetCode。 */
  externalPulls: Map<string, ConveyorExternalPull>;
  /** 已过境 task：货物沿链路越过本机交付给更下游后标记，此后收到同 task 仅更新 lastTask，不再订阅。 */
  transitedTasks: Set<string>;
  /** 最近一次非 0 的 movement_x 运行方向（±1），供持有方计算机等待设备的上货坐标。 */
  lastMovementDirection: number;
  /** 接管货物后的自驱走行方向（±1，0=关闭）：快照断流期间不等新 MQTT 消息直接执行移动动画，新消息到达即清零。 */
  selfDriveDirection: number;
  /** 最近一次应用的快照 receivedAt：识别新消息到达并结束自驱；断流重放时保持不变。 */
  lastSnapshotReceivedAt: number;
  cargoTravelOffset: number;
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

/** conveyor 货物走行配置：由模型脚本 dataDriven.cargo.travel 归一化而来，本体无自主动画。 */
export type ConveyorCargoTravelConfig = {
  axis: 'x' | 'z';
  speed: number;
  nodes: string[];
  fallbackPattern: string | null;
  fields: string[];
  actionMap: Record<string, number>;
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
  /** 各模型最近一次注入的外置脚本遥测上下文（签名 + 脚本运行时实例）：无快照且未变化时跳过重复注入与阵列刷新。 */
  lastInjectedScriptContexts: Map<string, { signature: string | null; runtime: ExternalModelScriptRuntime | null }>;
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
    lastInjectedScriptContexts: new Map(),
  };
}

export interface SpecializedTelemetryHost {
  pushLog(message: string): void;
  /** models + modelArrayParameterVariants 的合并视图（entityId 用 representativeEntityId）。 */
  collectModels(): Iterable<{ entityId: string; model: ModelRuntimeEntry }>;
  findLocatorByDevice(assetCode: string, x: number, y: number, z: number): LocatorRuntimeEntry | null;
  /** 返回设备绑定的全部 Locator（所有排），无绑定返回空数组；用于区分「未绑定」与「坐标越界」。 */
  findLocatorsByDevice(assetCode: string): LocatorRuntimeEntry[];
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
  /**
   * 按货物实例引用摘除（不销毁）：扫三张货物表找到所属条目，交由对应 driver 清理遥测引用后取出；
   * 未找到返回 null。输送线探测点推送用。
   */
  detachClaimedCargoByReference(cargo: GeneratedCargoRuntimeEntry): GeneratedCargoRuntimeEntry | null;
}
