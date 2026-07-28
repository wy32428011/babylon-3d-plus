import type { Mesh, Quaternion, Scene, StandardMaterial, TransformNode } from '@babylonjs/core';
import { Vector3 } from '@babylonjs/core';
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
export const CONVEYOR_DEFAULT_TRANSLATE_LOOP_METERS = 1.2;
export const CONVEYOR_DEFAULT_ROTATE_SPEED_DEGREES_PER_SECOND = 180;
export const CONVEYOR_DEFAULT_TRANSLATE_SPEED_METERS_PER_SECOND = 0.3;
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

export type GeneratedCargoKind = 'stacker' | 'conveyor';

export type GeneratedCargoFallbackRuntimeEntry = {
  mesh: Mesh;
  material: StandardMaterial;
};

/** 普通自动货物共享字段；root 始终表示货物底部支撑点。 */
export type GeneratedCargoRuntimeEntry = {
  assetCode: string;
  containerCode: string;
  root: TransformNode;
  outputOwner: GeneratedOutputOwnerRuntimeEntry | null;
  fallback: GeneratedCargoFallbackRuntimeEntry | null;
  /** 货箱模板来源生成器实体 ID；null 表示内置几何体回退。 */
  generatorEntityId: string | null;
};

export type StackerCargoRuntimeEntry = GeneratedCargoRuntimeEntry & {
  placedLocatorKey: string | null;
};

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
  frontCargoCode: string | null;
  backCargoCode: string | null;
  nodeBaselines: Map<TransformNode, Vector3>;
  lastTargetKey: string | null;
};

export type ConveyorNodeBaseline = {
  position: Vector3;
};

export type ConveyorModelTelemetryState = {
  cargoCode: string | null;
  cargoTravelOffset: number;
  motionOffsets: Map<string, number>;
  nodeBaselines: Map<TransformNode, ConveyorNodeBaseline>;
};

export type ConveyorCargoRuntimeEntry = GeneratedCargoRuntimeEntry;

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
  resolveFetchDriveRowForLocator(locator: LocatorRuntimeEntry): number | null;
  handleFetchRowSync(rowNumber: number): void;
  keepCargoForFetchRowSync(rowNumber: number | null, assetCode: string, containerCode: string): boolean;
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
  setGeneratedCargoRootPose(cargo: GeneratedCargoRuntimeEntry, position: Vector3, rotation: Quaternion): void;
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
  getOrCreateStackerCargo(assetCode: string, containerCode: string): StackerCargoRuntimeEntry;
  getOrCreateConveyorCargo(assetCode: string, containerCode: string): ConveyorCargoRuntimeEntry;
}
