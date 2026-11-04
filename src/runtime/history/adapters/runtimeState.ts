import type { DeviceIdentity, DeviceState, InputCursor, JsonObject, NumericPose, Quaternion, Vec3, VersionedAdapterState } from '../state/types';
import { LOGISTICS_ADAPTER_ID, LOGISTICS_ADAPTER_VERSION, LOGISTICS_STATE_SCHEMA_VERSION } from './manifest';
import type { LogisticsDeviceSpec, PassiveSubjectSpec } from './manifest';

export type DriverCommon = { diagnostics: string[]; lastFrameAt: number | null; birthOrder: string | null };
export type PlaceTarget = { locatorId: string; slotId: string; column: number; layer: number; supportPosition: Vec3; retainCargo: boolean };
export type ForkCargoState = {
  cargoId: string | null; bound: boolean; holdPosition: Vec3 | null; bindOffset: Vec3 | null;
  holdRotation: Quaternion | null; holdScaling: Vec3 | null; fetchRowId: string | null;
  placeTarget: PlaceTarget | null; pendingPlatformLocatorId: string | null;
};
export type StackerForkState = ForkCargoState & {
  offset: number; targetOffset: number; lastCommand: number | null; lastMovementZ: number | null; prevRawMovementZ: number | null;
  signalAction: 'fetch' | 'place' | null; signalExtended: boolean; signalCargoPresent: boolean | null;
};
export type StackerState = DriverCommon & {
  kind: 'stacker'; rootPosition: Vec3 | null; liftOffset: number; forkCatchUp: boolean;
  lastFrontCellKey: string | null; lastFrontCellChangedAt: number | null; frontCellChangeIntervalMs: number | null;
  front: StackerForkState; back: StackerForkState;
};
export type UpstreamLink = { deviceId: string; task: string; holderDeviceId: string; hops: number; direction: number };
export type DownstreamLink = { subscriberId: string; task: string; hops: number; direction: number };
export type ExternalPull = DownstreamLink & { holderDeviceId: string };
export type ConveyorState = DriverCommon & {
  kind: 'conveyor'; cargoId: string | null; currentTask: string | null; pendingTask: string | null; lastTask: string | null;
  waitingTask: string | null; snapshotTask: string | null; pendingTaskAgeSeconds: number; pendingPreviousTask: string | null;
  taskPulseQueue: string[]; upstreamLinks: UpstreamLink[]; downstreamLinks: DownstreamLink[]; externalPulls: ExternalPull[]; transitedTasks: string[];
  lastMovementDirection: number; selfDriveDirection: number; cargoDriveEngaged: boolean; lastSnapshotReceivedAt: number | null;
  cargoTravelOffset: number; handoffEntryOffset: number | null; entryHandoffPending: boolean;
  platformInboundCargo: boolean; platformInboundDirection: number; platformPlacedCargo: boolean;
};
export type HcliftSurface = { supportY: number; deckCenter: Vec3; targetLevel: number | null; arrived: boolean; workState: number | null; updatedAt: number };
export type DeckOccupancy = { shuttleId: string; phase: 'entering' | 'loaded'; shuttleStatus: number | null; shuttleFaulted: boolean; updatedAt: number };
export type HcliftState = DriverCommon & {
  kind: 'hclift'; liftOffset: number; liftTargetOffset: number | null; targetLevel: number | null;
  hasInitialLevel: boolean; workState: number | null; surface: HcliftSurface | null; occupancy: DeckOccupancy | null;
};
export type ShuttleState = DriverCommon & ForkCargoState & {
  kind: 'shuttle'; rootPosition: Vec3 | null; forkOffset: number; forkTargetOffset: number; forkCatchUp: boolean;
  lastStatus: number | null; forkPhase: 'idle' | 'extending' | 'retracting'; statusActionDone: boolean;
  lastTargetCellKey: string | null; lastTargetCellChangedAt: number | null; targetCellChangeIntervalMs: number | null;
  hcliftOccupancyId: string | null; lastHcliftLayer: number | null; hcliftExitDoneKey: string | null;
  hcliftLoadedSawMoving: boolean; hcliftExitFlashOutY: number | null; hcliftEntryStartPosition: Vec3 | null;
  hcliftExitStartPosition: Vec3 | null; hcliftDeckSupportYId: string | null; hcliftDeckSupportY: number | null; lastYFlashOffset: Vec3 | null;
};
export type RgvTransferMotion = { column: number; task: string; mode: 'fetch' | 'place'; velocity: number };
export type RgvStationState = {
  cargoId: string | null; onBoard: boolean; holdPosition: Vec3 | null; holdRotation: Quaternion | null;
  progress: number; lastCommand: number | null; lastMovementZ: number | null; transferMotion: RgvTransferMotion | null;
};
export type RgvState = DriverCommon & {
  kind: 'rgv'; rootPosition: Vec3 | null; travelTargetPosition: Vec3 | null; travelTargetColumn: number | null;
  front: RgvStationState; back: RgvStationState;
};
export type LiftStationState = {
  cargoId: string | null; onBoard: boolean; holdPosition: Vec3 | null; holdRotation: Quaternion | null;
  transferProgress: number; transferDirection: 1 | -1; transferActive: boolean; anchorPosition: Vec3 | null;
  taskAnnotationSeen: boolean; reachedOutgoing: boolean; outgoingDeviceId: string | null;
};
export type LiftState = DriverCommon & {
  kind: 'lift'; liftOffset: number; liftTargetOffset: number | null; targetKey: string | null; targetSide: 0 | 1 | null;
  targetLayer: number | null; targetDeviceId: string | null; arrivedTargetKey: string | null; workState: number | null;
  stations: [LiftStationState, LiftStationState]; outgoingHandoffCooldown: number; outgoingHandoffActive: boolean;
};
export type LogisticsDriverState = StackerState | ConveyorState | HcliftState | ShuttleState | RgvState | LiftState;
export type CargoRuntimeState = {
  kind: 'cargo'; cargoId: string; templateId: string; ownerDeviceId: string | null; ownerRole: 'front' | 'back' | 'single' | 'step1' | 'step2' | null;
  retained: boolean; awaitingFetch: boolean; ownershipOrder: string; hasPose: boolean; worldPose: NumericPose; lockedWorldRotation: Quaternion | null;
  /** 旧 resolveCargoHandoffPose 按实际执行帧积分；断流冻结的 RGV/lift 不由墙钟推进。 */
  handoff: { from: NumericPose; progress: number; durationSeconds: number } | null;
};
export type ClockState = { kind: 'clock'; phase: string; lastAt: number | null; timerId: string | null; topologyDirty: boolean };
export type AlarmRuleState = { kind: 'alarm'; trigger: 'device' | 'fire' | 'warehouse' | null;
  status: 'disabled' | 'waiting' | 'missing' | 'invalid' | 'matched' | 'unmatched' };
export type PassiveSubjectState = DriverCommon & {
  kind: 'passive'; role: 'alarm-telemetry'; lastReceiptAt: number | null; lastAppliedAt: number | null;
  lastDisposition: 'applied' | 'heartbeat' | 'duplicate' | 'out-of-order' | null;
};
export type UninstantiatedTelemetryState = {
  kind: 'uninstantiated'; identity: DeviceIdentity; telemetry: DeviceState['telemetry']; ordering: DeviceState['ordering'];
  lastDeviceId: string | null; generatorId: string | null; generation: string | null; retiredAt: number | null;
  lastReceiptAt: number; reason: string;
};
export type RawTelemetryState = {
  kind: 'raw-telemetry'; identity: DeviceIdentity; fields: JsonObject; deviceEpoch: string;
  sequence: string | null; sourceTimestamp: number | null; eventId: string | null; seenEventIds: string[];
  inputCursor: InputCursor; receivedAt: number;
  basis: { kind: 'baseline' | 'full'; sourceRevision: string; snapshotRevision: string; evidenceRef: string; inputCursor: InputCursor };
};
export type LogisticsAdapterValue = LogisticsDriverState | PassiveSubjectState | UninstantiatedTelemetryState | RawTelemetryState | CargoRuntimeState | ClockState | AlarmRuleState;

export function emptyForkCargo(): ForkCargoState {
  return { cargoId: null, bound: false, holdPosition: null, bindOffset: null, holdRotation: null, holdScaling: null,
    fetchRowId: null, placeTarget: null, pendingPlatformLocatorId: null };
}
export function emptyLiftStation(): LiftStationState {
  return { cargoId: null, onBoard: false, holdPosition: null, holdRotation: null, transferProgress: 0,
    transferDirection: 1, transferActive: false, anchorPosition: null, taskAnnotationSeen: false, reachedOutgoing: false, outgoingDeviceId: null };
}
export function wrapLogisticsState(value: LogisticsAdapterValue): VersionedAdapterState {
  return { adapterId: LOGISTICS_ADAPTER_ID, version: LOGISTICS_ADAPTER_VERSION, stateSchemaVersion: LOGISTICS_STATE_SCHEMA_VERSION,
    value: value as unknown as JsonObject };
}
/** 仅用于权威 birth 记录确认的新生命周期；存量基线必须提供真实 DriverState，禁止从最后 payload 补空。 */
export function createFreshLogisticsDriverState(spec: LogisticsDeviceSpec | PassiveSubjectSpec): VersionedAdapterState {
  const common: DriverCommon = { diagnostics: [], lastFrameAt: null, birthOrder: null };
  const stackerFork = (): StackerForkState => ({ ...emptyForkCargo(), offset: 0, targetOffset: 0,
    lastCommand: null, lastMovementZ: null, prevRawMovementZ: null, signalAction: null, signalExtended: false, signalCargoPresent: null });
  const rgvStation = (): RgvStationState => ({ cargoId: null, onBoard: false, holdPosition: null, holdRotation: null,
    progress: 0, lastCommand: null, lastMovementZ: null, transferMotion: null });
  switch (spec.kind) {
    case 'passive': return wrapLogisticsState({ ...common, kind: 'passive', role: 'alarm-telemetry', lastReceiptAt: null, lastAppliedAt: null, lastDisposition: null });
    case 'stacker': return wrapLogisticsState({ ...common, kind: 'stacker', rootPosition: null, liftOffset: 0, forkCatchUp: false,
      lastFrontCellKey: null, lastFrontCellChangedAt: null, frontCellChangeIntervalMs: null, front: stackerFork(), back: stackerFork() });
    case 'conveyor': return wrapLogisticsState({ ...common, kind: 'conveyor', cargoId: null, currentTask: null, pendingTask: null,
      lastTask: null, waitingTask: null, snapshotTask: null, pendingTaskAgeSeconds: 0, pendingPreviousTask: null, taskPulseQueue: [],
      upstreamLinks: [], downstreamLinks: [], externalPulls: [], transitedTasks: [], lastMovementDirection: 0, selfDriveDirection: 0,
      cargoDriveEngaged: false, lastSnapshotReceivedAt: null, cargoTravelOffset: 0, handoffEntryOffset: null, entryHandoffPending: false,
      platformInboundCargo: false, platformInboundDirection: 0, platformPlacedCargo: false });
    case 'hclift': return wrapLogisticsState({ ...common, kind: 'hclift', liftOffset: 0, liftTargetOffset: null,
      targetLevel: null, hasInitialLevel: false, workState: null, surface: null, occupancy: null });
    case 'shuttle': return wrapLogisticsState({ ...common, ...emptyForkCargo(), kind: 'shuttle', rootPosition: null,
      forkOffset: 0, forkTargetOffset: 0, forkCatchUp: false, lastStatus: null, forkPhase: 'idle', statusActionDone: false,
      lastTargetCellKey: null, lastTargetCellChangedAt: null, targetCellChangeIntervalMs: null, hcliftOccupancyId: null,
      lastHcliftLayer: null, hcliftExitDoneKey: null, hcliftLoadedSawMoving: false, hcliftExitFlashOutY: null,
      hcliftEntryStartPosition: null, hcliftExitStartPosition: null, hcliftDeckSupportYId: null, hcliftDeckSupportY: null, lastYFlashOffset: null });
    case 'rgv': return wrapLogisticsState({ ...common, kind: 'rgv', rootPosition: null, travelTargetPosition: null,
      travelTargetColumn: null, front: rgvStation(), back: rgvStation() });
    case 'lift': return wrapLogisticsState({ ...common, kind: 'lift', liftOffset: 0, liftTargetOffset: null,
      targetKey: null, targetSide: null, targetLayer: null, targetDeviceId: null, arrivedTargetKey: null, workState: null,
      stations: [emptyLiftStation(), emptyLiftStation()], outgoingHandoffCooldown: 0, outgoingHandoffActive: false });
  }
}
