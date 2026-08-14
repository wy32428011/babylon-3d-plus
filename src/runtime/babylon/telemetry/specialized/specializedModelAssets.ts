import type { TransformNode, Vector3 } from '@babylonjs/core';
import type { ModelAssetComponent } from '../../../../editor/model/components';
import { isPlainRecord, readStringArrayPath } from '../../runtimeValueUtils';
import type { ModelRuntimeEntry } from '../../SceneRuntime';
import {
  type ConveyorCargoTravelConfig,
  type ConveyorModelTelemetryState,
  CONVEYOR_DEFAULT_TRANSLATE_SPEED_METERS_PER_SECOND,
  type RgvModelTelemetryState,
  type StackerModelTelemetryState,
} from './types';

/** 判断当前模型是否具备输送线驱动能力，脚本声明 devType=conveyor 或文件名兜底识别即接入。 */
export function isConveyorRuntimeModel(model: ModelRuntimeEntry): boolean {
  if (model.conveyorCapable) return true;
  for (const _config of iterateConveyorDataDrivenConfigs(model)) return true;
  return false;
}

/** 通过模型包脚本、路径和资产编号兜底识别输送线模型。 */
export function isConveyorModelAsset(modelAsset: ModelAssetComponent): boolean {
  const signature = JSON.stringify([
    modelAsset.assetCode,
    modelAsset.sourcePath,
    modelAsset.sourceUrl,
    modelAsset.parameterScriptMetadata ?? [],
    modelAsset.animationScriptMetadata ?? [],
  ]).toLowerCase();

  return signature.includes('conveyor')
    || signature.includes('roller-conveyor')
    || signature.includes('chain-conveyor')
    || signature.includes('输送')
    || signature.includes('滚筒')
    || signature.includes('链条');
}

/** 通过模型包脚本、元数据或路径判断当前导入模型是否是 stacker。 */
export function isStackerModelAsset(modelAsset: ModelAssetComponent): boolean {
  const signature = JSON.stringify([
    modelAsset.assetCode,
    modelAsset.sourcePath,
    modelAsset.sourceUrl,
    modelAsset.parameterScriptMetadata ?? [],
    modelAsset.animationScriptMetadata ?? [],
  ]).toLowerCase();

  return signature.includes('stacker') || signature.includes('堆垛机');
}

/** 通过模型包脚本、元数据或路径判断当前导入模型是否是 rgv。 */
export function isRgvModelAsset(modelAsset: ModelAssetComponent): boolean {
  const signature = JSON.stringify([
    modelAsset.assetCode,
    modelAsset.sourcePath,
    modelAsset.sourceUrl,
    modelAsset.parameterScriptMetadata ?? [],
    modelAsset.animationScriptMetadata ?? [],
  ]).toLowerCase();

  return signature.includes('rgv') || signature.includes('穿梭车');
}

/** 判断当前模型是否具备 RGV 驱动能力：资产识别命中，或脚本声明 devType=rgv。 */
export function isRgvRuntimeModel(model: ModelRuntimeEntry): boolean {
  if (model.rgvCapable) return true;
  for (const dataDriven of model.externalScriptRuntime?.getDataDrivenConfigs() ?? []) {
    if (!isPlainRecord(dataDriven)) continue;
    const deviceConfig = isPlainRecord(dataDriven.device) ? dataDriven.device : {};
    const devType = typeof deviceConfig.devType === 'string' ? deviceConfig.devType.trim().toLowerCase() : '';
    if (devType === 'rgv') return true;
  }
  return false;
}

/** 创建 RGV 遥测运行态，所有偏移和货物占位只保存在内存中。 */
export function createRgvTelemetryState(root: TransformNode): RgvModelTelemetryState {
  return {
    rootBasePosition: root.position.clone(),
    rootPosition: null,
    travelConstraint: null,
    travelTargetPosition: null,
    travelTargetColumn: null,
    frontCargoKey: null,
    backCargoKey: null,
    frontCargoOnBoard: false,
    backCargoOnBoard: false,
    frontCargoHoldPosition: null,
    backCargoHoldPosition: null,
    frontCargoHoldRotation: null,
    backCargoHoldRotation: null,
    frontTransferProgress: 0,
    backTransferProgress: 0,
    frontLastCommand: null,
    backLastCommand: null,
    frontLastMovementZ: null,
    backLastMovementZ: null,
    nodeBaselines: new Map(),
  };
}

/** 模型完成归一化和外置脚本初始化后，重新建立 RGV 遥测基线。 */
export function resetRgvTelemetryState(model: ModelRuntimeEntry): void {
  model.rgvTelemetry.rootBasePosition = model.root.position.clone();
  model.rgvTelemetry.rootPosition = null;
  model.rgvTelemetry.travelConstraint = null;
  model.rgvTelemetry.travelTargetPosition = null;
  model.rgvTelemetry.travelTargetColumn = null;
  model.rgvTelemetry.frontCargoKey = null;
  model.rgvTelemetry.backCargoKey = null;
  model.rgvTelemetry.frontCargoOnBoard = false;
  model.rgvTelemetry.backCargoOnBoard = false;
  model.rgvTelemetry.frontCargoHoldPosition = null;
  model.rgvTelemetry.backCargoHoldPosition = null;
  model.rgvTelemetry.frontCargoHoldRotation = null;
  model.rgvTelemetry.backCargoHoldRotation = null;
  model.rgvTelemetry.frontTransferProgress = 0;
  model.rgvTelemetry.backTransferProgress = 0;
  model.rgvTelemetry.frontLastCommand = null;
  model.rgvTelemetry.backLastCommand = null;
  model.rgvTelemetry.frontLastMovementZ = null;
  model.rgvTelemetry.backLastMovementZ = null;
  model.rgvTelemetry.nodeBaselines.clear();
}

/** 遍历模型脚本声明的 conveyor dataDriven 配置块，运行时只接受 devType=conveyor。 */
function* iterateConveyorDataDrivenConfigs(model: ModelRuntimeEntry): Generator<Record<string, unknown>> {
  // 合批遥测代理自身不持有脚本运行时，配置读取委托给承载几何的宿主模型。
  const scriptRuntime = model.externalScriptRuntime ?? model.telemetryProxySource?.externalScriptRuntime ?? null;
  for (const dataDriven of scriptRuntime?.getDataDrivenConfigs() ?? []) {
    if (!isPlainRecord(dataDriven)) continue;
    const deviceConfig = isPlainRecord(dataDriven.device) ? dataDriven.device : {};
    const devType = typeof deviceConfig.devType === 'string' ? deviceConfig.devType.trim().toLowerCase() : '';
    if (devType === 'conveyor') yield dataDriven;
  }
}

/** 读取模型脚本 dataDriven.cargo.travel 声明的货物走行配置，逐键归一化；conveyor 本体无自主动画，全部走行语义集中于此。 */
export function readConveyorCargoTravelConfig(model: ModelRuntimeEntry): ConveyorCargoTravelConfig {
  for (const dataDriven of iterateConveyorDataDrivenConfigs(model)) {
    const cargo = isPlainRecord(dataDriven.cargo) ? dataDriven.cargo : null;
    const travel = cargo && isPlainRecord(cargo.travel) ? cargo.travel : null;
    if (!travel) continue;

    const rawAxis = typeof travel.axis === 'string' ? travel.axis.trim().toLowerCase() : '';
    const axis: ConveyorCargoTravelConfig['axis'] = rawAxis === 'z' ? 'z' : 'x';
    const rawSpeed = typeof travel.speed === 'number' ? travel.speed : Number(travel.speed);
    const speed = Number.isFinite(rawSpeed) && rawSpeed > 0 ? rawSpeed : CONVEYOR_DEFAULT_TRANSLATE_SPEED_METERS_PER_SECOND;
    const nodes = readStringArrayPath(travel, ['nodes']);
    const fields = readStringArrayPath(travel, ['fields']);
    const rawFallbackPattern = typeof travel.fallbackPattern === 'string' ? travel.fallbackPattern.trim() : '';

    return {
      axis,
      speed,
      nodes,
      fallbackPattern: rawFallbackPattern || null,
      fields: fields.length > 0 ? fields : ['movement_x'],
      actionMap: readConveyorActionMap(travel.actionMap),
    };
  }

  return {
    axis: 'x',
    speed: CONVEYOR_DEFAULT_TRANSLATE_SPEED_METERS_PER_SECOND,
    nodes: [],
    fallbackPattern: null,
    fields: ['movement_x'],
    actionMap: readConveyorActionMap(undefined),
  };
}

/** 输送线货物生命周期信号字段名，缺省遵循 front_has_goods/back_has_goods 光电约定。 */
export type ConveyorCargoSignalFields = {
  frontHasGoods: string;
  backHasGoods: string;
};

const DEFAULT_CONVEYOR_CARGO_SIGNAL_FIELDS: ConveyorCargoSignalFields = {
  frontHasGoods: 'front_has_goods',
  backHasGoods: 'back_has_goods',
};

/** 读取模型脚本 dataDriven.cargo 声明的货物生命周期信号字段名，未声明时遵循默认约定。 */
export function readConveyorCargoSignalFields(model: ModelRuntimeEntry): ConveyorCargoSignalFields {
  for (const dataDriven of iterateConveyorDataDrivenConfigs(model)) {
    const cargoConfig = isPlainRecord(dataDriven.cargo) ? dataDriven.cargo : null;
    if (!cargoConfig) continue;

    const front = typeof cargoConfig.frontHasGoodsField === 'string' ? cargoConfig.frontHasGoodsField.trim() : '';
    const back = typeof cargoConfig.backHasGoodsField === 'string' ? cargoConfig.backHasGoodsField.trim() : '';
    return {
      frontHasGoods: front || DEFAULT_CONVEYOR_CARGO_SIGNAL_FIELDS.frontHasGoods,
      backHasGoods: back || DEFAULT_CONVEYOR_CARGO_SIGNAL_FIELDS.backHasGoods,
    };
  }
  return DEFAULT_CONVEYOR_CARGO_SIGNAL_FIELDS;
}

/** 读取 movement 编码映射，缺省遵循 0=停、1=正向、2=反向。 */
function readConveyorActionMap(rawActionMap: unknown): Record<string, number> {
  const actionMap: Record<string, number> = { 0: 0, 1: 1, 2: -1 };
  if (!isPlainRecord(rawActionMap)) return actionMap;

  for (const [key, value] of Object.entries(rawActionMap)) {
    const numberValue = typeof value === 'number' ? value : Number(value);
    if (Number.isFinite(numberValue)) {
      actionMap[key] = numberValue;
    }
  }

  return actionMap;
}

/** 创建输送线运行时状态，货物占位只保存在内存。 */
export function createConveyorTelemetryState(): ConveyorModelTelemetryState {
  return {
    cargoCode: null,
    currentTask: null,
    pendingTask: null,
    lastTask: null,
    waitingTask: null,
    probeNeighbors: null,
    travelPlan: null,
    upstreamLinks: new Map(),
    downstreamLinks: new Map(),
    externalPulls: new Map(),
    transitedTasks: new Set(),
    lastMovementDirection: 0,
    selfDriveDirection: 0,
    lastSnapshotReceivedAt: 0,
    cargoTravelOffset: 0,
  };
}

/** 模型脚本或资产编号变化后重置输送线基线，避免旧状态污染新模型。 */
export function resetConveyorTelemetryState(model: ModelRuntimeEntry): void {
  model.conveyorTelemetry.cargoCode = null;
  model.conveyorTelemetry.currentTask = null;
  model.conveyorTelemetry.pendingTask = null;
  model.conveyorTelemetry.lastTask = null;
  model.conveyorTelemetry.waitingTask = null;
  model.conveyorTelemetry.probeNeighbors = null;
  model.conveyorTelemetry.travelPlan = null;
  model.conveyorTelemetry.upstreamLinks.clear();
  model.conveyorTelemetry.downstreamLinks.clear();
  model.conveyorTelemetry.externalPulls.clear();
  model.conveyorTelemetry.transitedTasks.clear();
  model.conveyorTelemetry.lastMovementDirection = 0;
  model.conveyorTelemetry.selfDriveDirection = 0;
  model.conveyorTelemetry.lastSnapshotReceivedAt = 0;
  model.conveyorTelemetry.cargoTravelOffset = 0;
}

/** 创建 stacker 遥测运行态，所有偏移都只保存在内存中。 */
export function createStackerTelemetryState(root: TransformNode): StackerModelTelemetryState {
  return {
    rootBasePosition: root.position.clone(),
    rootPosition: null,
    travelConstraint: null,
    liftConstraint: null,
    targetReferencePosition: null,
    liftOffset: 0,
    frontForkOffset: 0,
    backForkOffset: 0,
    lastFrameTimeMs: performance.now(),
    frontCargoKey: null,
    backCargoKey: null,
    frontCargoBoundToFork: false,
    backCargoBoundToFork: false,
    frontCargoHoldPosition: null,
    backCargoHoldPosition: null,
    frontCargoHoldRotation: null,
    backCargoHoldRotation: null,
    frontCargoHoldScaling: null,
    backCargoHoldScaling: null,
    frontCargoFetchRow: null,
    backCargoFetchRow: null,
    frontLastCommand: null,
    backLastCommand: null,
    nodeBaselines: new Map(),
    lastTargetKey: null,
    lastFrontCellKey: null,
    forkCatchUp: false,
    frontForkStroke: null,
    backForkStroke: null,
    frontForkTargetOffset: 0,
    backForkTargetOffset: 0,
    lastFrontCellChangedAtMs: null,
    frontCellChangeIntervalMs: null,
  };
}

/** 模型完成归一化和外置脚本初始化后，重新建立 Stacker 遥测基线。 */
export function resetStackerTelemetryState(model: ModelRuntimeEntry): void {
  model.stackerTelemetry.rootBasePosition = model.root.position.clone();
  model.stackerTelemetry.rootPosition = null;
  model.stackerTelemetry.travelConstraint = null;
  model.stackerTelemetry.liftConstraint = null;
  model.stackerTelemetry.targetReferencePosition = null;
  model.stackerTelemetry.liftOffset = 0;
  model.stackerTelemetry.frontForkOffset = 0;
  model.stackerTelemetry.backForkOffset = 0;
  model.stackerTelemetry.frontCargoKey = null;
  model.stackerTelemetry.backCargoKey = null;
  model.stackerTelemetry.frontCargoBoundToFork = false;
  model.stackerTelemetry.backCargoBoundToFork = false;
  model.stackerTelemetry.frontCargoHoldPosition = null;
  model.stackerTelemetry.backCargoHoldPosition = null;
  model.stackerTelemetry.frontCargoHoldRotation = null;
  model.stackerTelemetry.backCargoHoldRotation = null;
  model.stackerTelemetry.frontCargoHoldScaling = null;
  model.stackerTelemetry.backCargoHoldScaling = null;
  model.stackerTelemetry.frontCargoFetchRow = null;
  model.stackerTelemetry.backCargoFetchRow = null;
  model.stackerTelemetry.frontLastCommand = null;
  model.stackerTelemetry.backLastCommand = null;
  model.stackerTelemetry.nodeBaselines.clear();
  model.stackerTelemetry.lastTargetKey = null;
  model.stackerTelemetry.lastFrontCellKey = null;
  model.stackerTelemetry.forkCatchUp = false;
  model.stackerTelemetry.frontForkStroke = null;
  model.stackerTelemetry.backForkStroke = null;
  model.stackerTelemetry.frontForkTargetOffset = 0;
  model.stackerTelemetry.backForkTargetOffset = 0;
  model.stackerTelemetry.lastFrontCellChangedAtMs = null;
  model.stackerTelemetry.frontCellChangeIntervalMs = null;
}
