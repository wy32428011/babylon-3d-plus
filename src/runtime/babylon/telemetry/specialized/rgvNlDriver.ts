import type { Scene } from '@babylonjs/core';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import {
  findModelNodesByName,
  getHorizontalModelAxis,
  getModelTransformNodes,
  getNodesWorldBounds,
  projectWorldBoundsOntoAxis,
  worldDeltaToParentLocalDelta,
} from '../../runtimeNodeGeometry';
import { isPlainRecord, readStringArrayPath, sanitizeBabylonName } from '../../runtimeValueUtils';
import { readBooleanField, readIntegerField, readStringField, type DeviceTelemetrySnapshot } from '../../../mqtt/deviceTelemetry';
import type { LocatorRuntimeEntry, ModelRuntimeEntry } from '../../SceneRuntime';
import { resolveLocatorCellSupportWorldPosition } from '../stackerStorageLocation';
import { writeDeviceTelemetryMetadata } from './telemetryMetadata';
import {
  createCargoHandoffState,
  createCargoSpawnWorldRotation,
  normalizeCargoTask,
  resolveCargoHandoffPose,
  type RgvNlCargoRuntimeEntry,
  type RgvNlModelTelemetryState,
  type SpecializedTelemetryDriverContext,
  type SpecializedTelemetryHost,
  type SpecializedTelemetrySharedState,
} from './types';

const ENDPOINT_EPSILON = 1e-4;
const DEFAULT_HAS_GOODS_FIELDS = ['front_has_goods', 'back_has_goods', 'has_goods'];

export type RgvNlConfig = {
  speed: number;
  speedParam: string | null;
  deckNodes: string[];
  surfaceNodes: string[];
  homeEnd: 'a' | 'b';
  aEndInset: number;
  bEndInset: number;
  aEndInsetParam: string;
  bEndInsetParam: string;
  workingModeField: string;
  movementFields: string[];
  hasGoodsFields: string[];
};

type RgvNlGeometry = {
  deck: TransformNode;
  surface: TransformNode;
  axis: Vector3;
  baselinePosition: Vector3;
};

function readPositiveNumber(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readNonNegativeNumber(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function readString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function readParameterNumber(model: ModelRuntimeEntry, key: string | null, fallback: number, positive = false): number {
  if (!key) return fallback;
  const value = model.entitySnapshot?.components?.modelAsset?.parameterValues?.[key];
  return positive ? readPositiveNumber(value, fallback) : readNonNegativeNumber(value, fallback);
}

export function readRgvNlConfig(model: ModelRuntimeEntry): RgvNlConfig | null {
  const scriptRuntime = model.externalScriptRuntime ?? model.telemetryProxySource?.externalScriptRuntime ?? null;
  for (const declaration of scriptRuntime?.getDataDrivenConfigs() ?? []) {
    if (!isPlainRecord(declaration)) continue;
    const device = isPlainRecord(declaration.device) ? declaration.device : {};
    const devType = typeof device.devType === 'string' ? device.devType.trim().toLowerCase() : '';
    if (devType !== 'rgv_nl') continue;
    const motion = isPlainRecord(declaration.motion) ? declaration.motion : null;
    const deck = motion && isPlainRecord(motion.deckTransfer) ? motion.deckTransfer : null;
    if (!deck || deck.protocol !== 'working_mode') continue;
    const cargo = isPlainRecord(declaration.cargo) ? declaration.cargo : {};
    const hasGoodsFields = readStringArrayPath(cargo, ['hasGoodsFields']);
    const movementFields = readStringArrayPath(deck, ['movementFields']);
    const speed = readPositiveNumber(deck.speed, 0.8);
    const speedParam = typeof deck.speedParam === 'string' && deck.speedParam.trim() ? deck.speedParam.trim() : null;
    return {
      speed: readParameterNumber(model, speedParam, speed, true),
      speedParam,
      deckNodes: readStringArrayPath(deck, ['deckNodes']),
      surfaceNodes: readStringArrayPath(deck, ['surfaceNodes']),
      homeEnd: deck.homeEnd === 'a' ? 'a' : 'b',
      aEndInset: readNonNegativeNumber(deck.aEndInset, 0),
      bEndInset: readNonNegativeNumber(deck.bEndInset, 0),
      aEndInsetParam: readString(deck.aEndInsetParam, 'aEndInset'),
      bEndInsetParam: readString(deck.bEndInsetParam, 'bEndInset'),
      workingModeField: readString(deck.workingModeField, 'working_mode'),
      movementFields: movementFields.length > 0 ? movementFields : ['movement_x'],
      hasGoodsFields: hasGoodsFields.length > 0 ? hasGoodsFields : DEFAULT_HAS_GOODS_FIELDS,
    };
  }
  return null;
}

export function isRgvNlRuntimeModel(model: ModelRuntimeEntry): boolean {
  return readRgvNlConfig(model) !== null;
}

export class RgvNlTelemetryDriver {
  private readonly geometries = new WeakMap<RgvNlModelTelemetryState, RgvNlGeometry>();

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

  applyToModel(model: ModelRuntimeEntry, snapshot: DeviceTelemetrySnapshot, deltaSeconds: number): void {
    const config = readRgvNlConfig(model);
    if (!config) return;
    this.reportRuntimeState(snapshot);
    writeDeviceTelemetryMetadata(model, snapshot);
    const state = model.rgvNlTelemetry;
    const geometry = this.resolveGeometry(model, config);
    if (!geometry) return;

    if (!snapshot.faulted) {
      const workingModeValue = readIntegerField(snapshot.fields, config.workingModeField);
      const workingMode = workingModeValue === 1 || workingModeValue === 2 ? workingModeValue : null;
      if (workingMode !== null && !state.initialized) {
        state.initialized = true;
        state.workingMode = workingMode;
        state.currentOffset = workingMode === 1 ? state.homeOffset : state.stackerOffset;
        state.targetOffset = null;
      } else if (workingMode !== null && state.workingMode !== workingMode) {
        state.workingMode = workingMode;
        state.targetOffset = null;
      }

      if (state.initialized) {
        const hasGoods = this.readHasGoods(snapshot, config);
        if (hasGoods === false) state.sensorSpawnBlocked = false;
        if (state.workingMode === 1) {
          if (state.cargoKey !== null && hasGoods === false) this.disposeCargo(model);
          if (state.cargoKey === null && hasGoods === true && !state.sensorSpawnBlocked) {
            this.spawnCargo(model, snapshot);
            state.sensorSpawnBlocked = true;
          }
          if (state.cargoKey === null) {
            state.targetOffset = state.homeOffset;
          } else if (this.readMovementActive(snapshot, config) && !this.isAtStackerEnd(model)) {
            state.targetOffset = state.stackerOffset;
          }
        } else if (state.workingMode === 2) {
          state.targetOffset = state.cargoKey !== null ? state.homeOffset : state.stackerOffset;
        }
      }
    }

    if (!snapshot.faulted && state.targetOffset !== null) {
      const delta = Number.isFinite(deltaSeconds) && deltaSeconds > 0 ? deltaSeconds : 0;
      const distance = state.targetOffset - state.currentOffset;
      const step = Math.sign(distance) * Math.min(Math.abs(distance), config.speed * delta);
      state.currentOffset += step;
      if (Math.abs(state.targetOffset - state.currentOffset) <= ENDPOINT_EPSILON) {
        state.currentOffset = state.targetOffset;
        state.targetOffset = null;
      }
    }
    this.applyDeckOffset(geometry, state.currentOffset);

    if (!snapshot.faulted && state.initialized && state.workingMode === 2
      && state.cargoKey !== null && this.isAtHome(model) && this.readHasGoods(snapshot, config) === false) {
      this.disposeCargo(model);
      state.targetOffset = state.stackerOffset;
    }
    this.updateCargoPose(model, snapshot, geometry, deltaSeconds);
  }

  getLightingMotionNodes(model: ModelRuntimeEntry): { moving: TransformNode[]; fixed: TransformNode[] } {
    const config = readRgvNlConfig(model);
    const deck = config ? this.findDeck(model, config) : null;
    if (!deck) return { moving: [], fixed: [] };
    return {
      moving: [deck],
      fixed: getModelTransformNodes(model, this.scene).filter(node =>
        node !== model.root && node !== model.contentRoot && node !== deck
        && !node.isDescendantOf(deck) && !deck.isDescendantOf(node)),
    };
  }

  adoptPlatformCargoForStacker(model: ModelRuntimeEntry): RgvNlCargoRuntimeEntry | null {
    const state = model.rgvNlTelemetry;
    if (!state.initialized || state.workingMode !== 1 || state.cargoKey === null
      || state.targetOffset !== null || !this.isAtStackerEnd(model)) return null;
    return this.detachClaimedCargoByKey(state.cargoKey);
  }

  canAcceptPlatformPlacedCargo(model: ModelRuntimeEntry, platform: LocatorRuntimeEntry): boolean {
    const state = model.rgvNlTelemetry;
    return state.initialized && state.workingMode === 2 && state.cargoKey === null
      && state.targetOffset === null && this.isAtStackerEnd(model)
      && resolveLocatorCellSupportWorldPosition(platform, 0) !== null;
  }

  acceptPlatformPlacedCargo(
    model: ModelRuntimeEntry,
    platform: LocatorRuntimeEntry,
    cargo: RgvNlCargoRuntimeEntry,
  ): boolean {
    if (!this.canAcceptPlatformPlacedCargo(model, platform)) return false;
    const state = model.rgvNlTelemetry;
    const key = this.getCargoKey(model.assetCode);
    cargo.assetCode = model.assetCode;
    cargo.handoff = createCargoHandoffState(cargo);
    this.state.rgvNlCargoMeshes.set(key, cargo);
    state.cargoKey = key;
    state.currentTask = cargo.task || null;
    if (cargo.task) state.lastTask = cargo.task;
    state.targetOffset = state.homeOffset;
    return true;
  }

  isRgvNlCargoReadyForExternalPull(cargo: RgvNlCargoRuntimeEntry): boolean {
    for (const { model } of this.host.collectModels()) {
      const state = model.rgvNlTelemetry;
      if (state.cargoKey !== null && this.state.rgvNlCargoMeshes.get(state.cargoKey) === cargo) {
        return state.initialized && state.workingMode === 1 && state.targetOffset === null && this.isAtStackerEnd(model);
      }
    }
    return false;
  }

  getOrCreateRgvNlCargo(assetCode: string): RgvNlCargoRuntimeEntry {
    const key = this.getCargoKey(assetCode);
    const existing = this.state.rgvNlCargoMeshes.get(key);
    if (existing) return existing;
    const root = new TransformNode(`rgv_nl_cargo_root_${sanitizeBabylonName(assetCode)}`, this.scene);
    const cargo: RgvNlCargoRuntimeEntry = {
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
    this.state.rgvNlCargoMeshes.set(key, cargo);
    return cargo;
  }

  detachClaimedCargoByKey(key: string): RgvNlCargoRuntimeEntry | null {
    const cargo = this.state.rgvNlCargoMeshes.get(key);
    if (!cargo) return null;
    for (const { model } of this.host.collectModels()) {
      const state = model.rgvNlTelemetry;
      if (state.cargoKey !== key) continue;
      state.cargoKey = null;
      state.currentTask = null;
      if (state.initialized) state.targetOffset = state.workingMode === 1 ? state.homeOffset : state.stackerOffset;
    }
    this.state.rgvNlCargoMeshes.delete(key);
    return cargo;
  }

  disposeRgvNlCargoForAssetCode(assetCode: string): void {
    for (const [key, cargo] of this.state.rgvNlCargoMeshes.entries()) {
      if (cargo.assetCode !== assetCode) continue;
      this.host.disposeGeneratedCargo(cargo);
      this.state.rgvNlCargoMeshes.delete(key);
    }
  }

  private getCargoKey(assetCode: string): string {
    return JSON.stringify([assetCode, 'cargo']);
  }

  private resolveGeometry(model: ModelRuntimeEntry, config: RgvNlConfig): RgvNlGeometry | null {
    const state = model.rgvNlTelemetry;
    const cached = this.geometries.get(state);
    if (cached) return cached;
    const deck = this.findDeck(model, config);
    if (!deck) return null;
    const surface = this.findSurface(model, deck, config) ?? deck;
    const deckBounds = getNodesWorldBounds([deck]);
    const overallBounds = this.host.getModelWorldBounds(model) ?? getNodesWorldBounds(getModelTransformNodes(model, this.scene));
    if (!deckBounds || !overallBounds) return null;
    const axis = getHorizontalModelAxis(model.root, 'z');
    const deckProjection = projectWorldBoundsOntoAxis(deckBounds, axis);
    const overallProjection = projectWorldBoundsOntoAxis(overallBounds, axis);
    const baselineCenter = Vector3.Dot(deckBounds.minimum.add(deckBounds.maximum).scale(0.5), axis);
    const aEndInset = readParameterNumber(model, config.aEndInsetParam, config.aEndInset);
    const bEndInset = readParameterNumber(model, config.bEndInsetParam, config.bEndInset);
    let aCenter = overallProjection.min + baselineCenter - deckProjection.min + aEndInset;
    let bCenter = overallProjection.max - deckProjection.max + baselineCenter - bEndInset;
    if (aCenter > bCenter) aCenter = bCenter = (aCenter + bCenter) / 2;
    const homeCenter = config.homeEnd === 'a' ? aCenter : bCenter;
    const stackerCenter = config.homeEnd === 'a' ? bCenter : aCenter;
    state.homeOffset = homeCenter - baselineCenter;
    state.stackerOffset = stackerCenter - baselineCenter;
    const geometry = { deck, surface, axis, baselinePosition: deck.position.clone() };
    this.geometries.set(state, geometry);
    return geometry;
  }

  private findDeck(model: ModelRuntimeEntry, config: RgvNlConfig): TransformNode | null {
    if (config.deckNodes.length === 0) return null;
    return findModelNodesByName(model, this.scene, config.deckNodes)[0] ?? null;
  }

  private findSurface(model: ModelRuntimeEntry, deck: TransformNode, config: RgvNlConfig): TransformNode | null {
    const descendants = [deck, ...deck.getChildTransformNodes(false), ...deck.getChildMeshes(false)];
    for (const name of config.surfaceNodes) {
      const local = descendants.find(node => node.name === name);
      if (local) return local;
    }
    return findModelNodesByName(model, this.scene, config.surfaceNodes)[0] ?? null;
  }

  private applyDeckOffset(geometry: RgvNlGeometry, offset: number): void {
    const worldOffset = geometry.axis.scale(offset);
    geometry.deck.position = geometry.baselinePosition.add(worldDeltaToParentLocalDelta(geometry.deck, worldOffset));
    geometry.deck.computeWorldMatrix(true);
  }

  private isAtHome(model: ModelRuntimeEntry): boolean {
    const state = model.rgvNlTelemetry;
    return state.targetOffset === null && Math.abs(state.currentOffset - state.homeOffset) <= ENDPOINT_EPSILON;
  }

  private isAtStackerEnd(model: ModelRuntimeEntry): boolean {
    const state = model.rgvNlTelemetry;
    return Math.abs(state.currentOffset - state.stackerOffset) <= ENDPOINT_EPSILON;
  }

  private readMovementActive(snapshot: DeviceTelemetrySnapshot, config: RgvNlConfig): boolean {
    return config.movementFields.some(field => {
      const value = readIntegerField(snapshot.fields, field);
      return value !== null && value !== 0;
    });
  }

  private readHasGoods(snapshot: DeviceTelemetrySnapshot, config: RgvNlConfig): boolean | null {
    let observed = false;
    for (const field of config.hasGoodsFields) {
      const value = readBooleanField(snapshot.fields, field);
      if (value === null) continue;
      observed = true;
      if (value) return true;
    }
    return observed ? false : null;
  }

  private spawnCargo(model: ModelRuntimeEntry, snapshot: DeviceTelemetrySnapshot): void {
    const state = model.rgvNlTelemetry;
    const key = this.getCargoKey(model.assetCode);
    const placeholder = this.getOrCreateRgvNlCargo(model.assetCode);
    const task = normalizeCargoTask(readIntegerField(snapshot.fields, 'task'));
    const containerCode = readStringField(snapshot.fields, 'containerCode')?.trim() ?? '';
    const adopted = this.context.adoptGlobalCargoByTask(task, key);
    if (adopted && adopted !== placeholder) {
      this.host.disposeGeneratedCargo(placeholder);
      adopted.assetCode = model.assetCode;
      adopted.handoff = createCargoHandoffState(adopted);
      this.state.rgvNlCargoMeshes.set(key, adopted);
    }
    const cargo = this.state.rgvNlCargoMeshes.get(key);
    if (!cargo) return;
    cargo.task = task;
    cargo.containerCode = containerCode;
    state.cargoKey = key;
    state.currentTask = task || null;
    if (task) state.lastTask = task;
  }

  private disposeCargo(model: ModelRuntimeEntry): void {
    const state = model.rgvNlTelemetry;
    if (state.cargoKey === null) return;
    const cargo = this.state.rgvNlCargoMeshes.get(state.cargoKey);
    if (cargo) this.host.disposeGeneratedCargo(cargo);
    this.state.rgvNlCargoMeshes.delete(state.cargoKey);
    state.cargoKey = null;
    state.currentTask = null;
  }

  private getSurfacePosition(geometry: RgvNlGeometry): Vector3 | null {
    const bounds = getNodesWorldBounds([geometry.surface]);
    if (!bounds) return null;
    const position = bounds.minimum.add(bounds.maximum).scale(0.5);
    position.y = bounds.maximum.y;
    return position;
  }

  private updateCargoPose(
    model: ModelRuntimeEntry,
    snapshot: DeviceTelemetrySnapshot,
    geometry: RgvNlGeometry,
    deltaSeconds: number,
  ): void {
    const cargoKey = model.rgvNlTelemetry.cargoKey;
    if (cargoKey === null) return;
    const cargo = this.state.rgvNlCargoMeshes.get(cargoKey);
    if (!cargo) return;
    const surfacePosition = this.getSurfacePosition(geometry);
    if (!surfacePosition) return;
    this.host.syncGeneratedCargoVisual(
      cargo,
      'rgv_nl',
      snapshot,
      this.host.resolveCargoGeneratorForModel(model),
      model.entitySnapshot?.id ?? '',
    );
    const pose = resolveCargoHandoffPose(
      cargo,
      surfacePosition,
      cargo.lockedWorldRotation ?? createCargoSpawnWorldRotation(),
      Number.isFinite(deltaSeconds) && deltaSeconds > 0 ? deltaSeconds : 0,
    );
    this.host.setGeneratedCargoRootPose(cargo, pose.position, pose.rotation);
  }

  private reportRuntimeState(snapshot: DeviceTelemetrySnapshot): void {
    const deviceKey = `${snapshot.sourceId}:${snapshot.deviceType}:${snapshot.assetCode}`;
    if (!snapshot.faulted) {
      this.state.reportedFaults.delete(deviceKey);
      return;
    }
    const faultMessage = snapshot.message || `errorCode=${readIntegerField(snapshot.fields, 'errorCode') ?? 0}`;
    if (this.state.reportedFaults.get(deviceKey) === faultMessage) return;
    this.state.reportedFaults.set(deviceKey, faultMessage);
    this.host.pushLog(`RGV_NL ${snapshot.assetCode} 故障/急停：${faultMessage}`);
  }
}
