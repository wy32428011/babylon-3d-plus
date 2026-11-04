import type { HistoryStateCursor } from '../historyReplayContract';

export const TWIN_STATE_SCHEMA_VERSION = '1' as const;
export const TWIN_KERNEL_VERSION = 'state-kernel/1' as const;
export const TWIN_SCHEDULE_VERSION = 'input-boundary/1' as const;
export const DEVICE_TYPES = ['stacker', 'conveyor', 'hclift', 'shuttle', 'rgv', 'lift'] as const;
/** 同一截止时刻按此顺序执行；载货台先于多穿小车，外部拉货始终最后。 */
export const SCHEDULE_PHASES = [
  'topology', 'stacker', 'conveyor', 'hclift', 'shuttle', 'rgv', 'lift',
  'inventory', 'alarm', 'lifecycle', 'external-pull',
] as const;
export type DeviceType = (typeof DEVICE_TYPES)[number];
export type SchedulePhase = (typeof SCHEDULE_PHASES)[number];
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
/** 使用显式递归只读 JSON，避免对无限嵌套的 JsonValue 反复展开映射类型。 */
export type ReadonlyJsonValue = null | boolean | number | string | readonly ReadonlyJsonValue[] | { readonly [key: string]: ReadonlyJsonValue };
export type DeepReadonly<T> = [JsonValue] extends [T] ? [T] extends [JsonValue] ? ReadonlyJsonValue : ReadonlyStructure<T>
  : ReadonlyStructure<T>;
type ReadonlyStructure<T> = T extends (...args: never[]) => unknown ? T
  : T extends readonly unknown[] ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
  : T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;
export type Vec3 = [number, number, number];
/** 四元数为 [x,y,z,w]，归一化；长度、速度使用米和秒，时间使用 UTC 毫秒。 */
export type Quaternion = [number, number, number, number];
export type NumericPose = { position: Vec3; rotation: Quaternion; scale: Vec3 };
export type InputCursor = { captureDomainId: string; captureEpoch: string; offset: string };
export type StateCursor = HistoryStateCursor;
export type DeviceIdentity = { projectId: string; sourceId: string; deviceType: string; assetCode: string };
export type VersionManifest = {
  stateSchemaVersion: typeof TWIN_STATE_SCHEMA_VERSION;
  kernelVersion: typeof TWIN_KERNEL_VERSION;
  scheduleVersion: typeof TWIN_SCHEDULE_VERSION;
  projectId: string;
  publishedVersionId: string;
  sceneHash: string;
  modelManifestHash: string;
  scriptManifestHash: string;
  logicManifestHash: string;
  bindingRevision: string;
  sourceContractId: string;
  projectorVersion: string;
};
export type AdapterRequirement = {
  adapterId: string; version: string; stateSchemaVersion: string;
  deviceTypes: string[];
};
export type VersionedAdapterState = {
  adapterId: string; version: string; stateSchemaVersion: string; value: JsonObject;
};
export type LogicalAnchor = {
  id: string; parentAnchorId: string | null; channel: string | null; localPose: NumericPose;
};
export type LogicalModel = {
  id: string; revision: string; bounds: { min: Vec3; max: Vec3 };
  anchors: LogicalAnchor[];
  /** 几何导出阶段产生的数值参数，不包含脚本、Mesh 或运行时缓存。 */
  dimensions: { [key: string]: number };
};
export type LogicalDevice = {
  id: string; identity: DeviceIdentity; modelId: string; adapterId: string;
  basePose: NumericPose; ports: { id: string; anchorId: string }[]; parameters: JsonObject;
};
export type LogicalSlot = {
  id: string; locatorId: string; row: string; column: number; layer: number; depth: string;
  pose: NumericPose;
};
export type LogicalGenerator = {
  id: string; adapterId: string; modelId: string; deviceType: string | null;
  sourceId: string; ttlMs: number | null; parameters: JsonObject;
};
export type LogicManifest = {
  versions: VersionManifest;
  sources: { id: string; revision: string; required: boolean }[];
  requiredAdapters: AdapterRequirement[];
  businessScripts: { id: string; digest: string; adapterId: string }[];
  models: LogicalModel[];
  devices: LogicalDevice[];
  slots: LogicalSlot[];
  generators: LogicalGenerator[];
  links: { id: string; fromDeviceId: string; fromPortId: string; toDeviceId: string; toPortId: string; parameters: JsonObject }[];
};
export type TelemetryFrame = {
  fields: JsonObject; receivedAt: number; sourceTimestamp: number | null; sequence: string | null;
  deviceEpoch: string; eventId: string | null; inputCursor: InputCursor;
  currentLocationKey: string | null; targetLocationKey: string | null; hasTargetLocation: boolean;
  faulted: boolean; topic: string; payloadDeviceCode: string | null; spawnerCode: string | null; message: string;
};
export type DeviceState = {
  id: string; identity: DeviceIdentity; logicalDeviceId: string | null; modelId: string;
  basePose: NumericPose;
  attachment: { deviceId: string; anchorId: string; offset: NumericPose } | null;
  /** previous/current 不因重复无序号心跳前移；有效心跳独立保存。 */
  telemetry: { previous: TelemetryFrame | null; current: TelemetryFrame | null; effectiveHeartbeatAt: number | null };
  ordering: { deviceEpoch: string; lastSequence: string | null; lastEventId: string | null; lastInputCursor: InputCursor | null };
  dynamic: { generatorId: string; generation: string; bornAt: number; lastHeartbeatAt: number | null; expiresAt: number | null; expiryTimerId: string | null } | null;
  driverState: VersionedAdapterState;
};
export type CargoEndpoint = { kind: 'device'; deviceId: string; portId: string }
  | { kind: 'slot'; slotId: string };
export type CargoHost = CargoEndpoint | { kind: 'transfer'; transferId: string };
export type CargoState = {
  id: string; containerCode: string | null; taskId: string | null;
  origin: { sourceId: string; inputCursor: InputCursor; generatorId: string | null; generation: string | null };
  host: CargoHost | null; localPose: NumericPose;
  /** 交接的展示插值追踪当前逻辑宿主，不在 samplePose 中改变宿主。 */
  handoff: { fromWorld: NumericPose; startedAt: number; endsAt: number } | null;
  createdAt: number; destroyedAt: number | null; destroyReason: string | null;
};
export type SlotState = { id: string; cargoId: string | null; inventoryRevision: string | null };
export type TransferState = {
  id: string; cargoId: string; from: CargoEndpoint; to: CargoEndpoint;
  phase: 'pending' | 'in-flight' | 'complete' | 'cancelled';
  startedAt: number; completedAt: number | null; pose: NumericPose; state: VersionedAdapterState;
};
export type MotionState = {
  id: string; deviceId: string; channel: string; startedAt: number; endsAt: number;
  /** 根/部件轨迹是相对基准位姿的数值变换；部件以 anchor.channel 关联。 */
  from: NumericPose; to: NumericPose; interpolation: 'linear-slerp';
};
export type FetchRequestState = {
  id: string; attemptId: string; sourceId: string; sourceRevision: string; sourceContractId: string;
  operationEpoch: string; generation: string; scope: 'full' | 'rows';
  rows: { row: string; generation: string }[]; issuedAt: number; completedAt: number | null;
  status: 'pending' | 'succeeded' | 'failed' | 'superseded'; responseRef: string | null; failure: string | null;
};
export type FetchRowState = {
  id: string; sourceId: string; row: string; operationEpoch: string;
  latestGeneration: string; latestRequestId: string | null;
  appliedRequestId: string | null; inventoryRevision: string | null;
  transientSuppressedSlotIds: string[]; persistentSuppressedSlotIds: string[];
  pendingSettlement: { cargoId: string; slotId: string; deviceId: string | null; requestId: string | null }[];
};
export type AlarmState = {
  id: string; deviceId: string; ruleId: string;
  /** 点位缺失不等于 null；只保留实际收到过的值及各自时间。 */
  retained: { property: string; value: JsonValue; receivedAt: number; inputCursor: InputCursor }[];
  active: boolean; activatedAt: number | null; clearedAt: number | null; evaluatedAt: number | null;
  edge: 'unknown' | 'active' | 'inactive'; state: VersionedAdapterState;
};
export type TimerState = {
  id: string; adapterId: string; adapterVersion: string; timerType: string;
  dueAt: number; phase: SchedulePhase; ordinal: string;
  deviceId: string | null; cargoId: string | null; payload: JsonObject;
};
export type CounterState = { id: string; value: string };
export type SourceState = {
  id: string; sourceRevision: string; sourceEpoch: string; lastSequence: string | null;
  lastInputCursor: InputCursor; recentEvents: { eventId: string; offset: string }[];
};
/** 共享载货台、占位、输送线脉冲队列及受控脚本状态放在版本化记录，不存闭包。 */
export type AdapterStateRecord = { id: string; deviceIds: string[]; cargoIds: string[]; state: VersionedAdapterState };
export type StateTableRecords = {
  devices: DeviceState; cargo: CargoState; slots: SlotState; transfers: TransferState;
  motions: MotionState; fetchRequests: FetchRequestState; fetchRows: FetchRowState;
  alarms: AlarmState; timers: TimerState; counters: CounterState; sources: SourceState; adapterStates: AdapterStateRecord;
};
export const STATE_TABLES = [
  'devices', 'cargo', 'slots', 'transfers', 'motions', 'fetchRequests', 'fetchRows',
  'alarms', 'timers', 'counters', 'sources', 'adapterStates',
] as const satisfies readonly (keyof StateTableRecords)[];
export type StateTable = keyof StateTableRecords;
export type AnyStateRecord = StateTableRecords[StateTable];
export type StateTablesDTO = { [K in StateTable]: StateTableRecords[K][] };
export const BASELINE_DOMAINS = ['telemetry', 'drivers', 'dynamic-devices', 'cargo', 'inventory', 'fetch', 'alarms', 'timers', 'generators', 'scripts'] as const;
export type BaselineProof = {
  id: string; snapshotRevision: string; asOf: number; complete: boolean;
  domains: { [K in (typeof BASELINE_DOMAINS)[number]]: boolean };
  sourceBoundaries: {
    sourceId: string; sourceRevision: string; sourceEpoch: string; snapshotRevision: string;
    incrementalAfter: string; evidenceRef: string;
  }[];
  alignment: { status: 'aligned' | 'unproven'; method: 'atomic-source' | 'reconciled-vector'; evidenceRef: string | null };
  inputCursor: InputCursor;
};
export type Continuity = { status: 'complete'; since: number; reason: null }
  | { status: 'gap'; since: number; reason: string };
export type StateMetadata = {
  projectionId: string; cursor: StateCursor; inputCursor: InputCursor; logicalTime: number;
  baseline: BaselineProof; continuity: Continuity;
};
/** DTO 只有数组和普通 JSON；Map、索引及事务缓冲都不属于序列化合同。 */
export type TwinStateDTO = { versions: VersionManifest; logic: LogicManifest; metadata: StateMetadata; tables: StateTablesDTO };
export type TwinBaseline = { format: 'twin-baseline/1'; state: TwinStateDTO };
export type ContentChecksum = { algorithm: 'sha256'; value: string };
export type TwinCheckpoint = { format: 'twin-checkpoint/1'; committed: true; state: TwinStateDTO; checksum: ContentChecksum };
export type StateChange = {
  [K in StateTable]: { op: 'put'; table: K; record: StateTableRecords[K] } | { op: 'remove'; table: K; id: string }
}[StateTable];
export type StateFact = {
  entityId: string; details: JsonObject;
} & (
  | { kind: 'alarm'; action: 'alarm-activated' | 'alarm-cleared' | 'alarm-observed-active' | 'alarm-observed-inactive' | 'alarm-state-unknown' }
  | { kind: 'transfer'; action: 'transfer-started' | 'transfer-phase-changed' | 'transfer-completed' | 'transfer-cancelled' | 'cargo-host-changed' }
  | { kind: 'stock'; action: 'slot-occupied' | 'slot-cleared' | 'slot-changed' | 'inventory-revision-changed' }
  | { kind: 'lifecycle'; action: 'cargo-created' | 'cargo-destroyed' | 'device-born' | 'device-retired' }
);
export type AtomicStateRevision = {
  revision: string; logicalTime: number; inputCursor: InputCursor;
  cause: { kind: 'input' | 'timer' | 'advance' | 'gap'; id: string };
  continuity: Continuity; changes: StateChange[];
  /** 按真实事务写入顺序保存的业务边沿；缺省表示旧批次不能证明完整事件覆盖。 */
  facts?: StateFact[];
};
export type StateChangeBatch = {
  format: 'twin-changes/1'; committed: true; versions: VersionManifest;
  projectionId: string; fromRevision: string; toRevision: string;
  throughTime: number; inputCursor: InputCursor; revisions: AtomicStateRevision[]; checksum: ContentChecksum;
};
type InputEnvelope = {
  schemaVersion: '1'; id: string; projectionId: string; versions: VersionManifest;
  cursor: InputCursor; logicalTime: number;
};
export type AdapterInput = InputEnvelope & {
  kind: 'adapter'; adapterId: string; adapterVersion: string; eventType: string;
  sourceId: string; sourceEpoch: string; sourceEventId: string | null; sourceSequence: string | null;
  payload: JsonObject;
};
export type AdvanceInput = InputEnvelope & { kind: 'advance' };
/** 已规范化的原子事实，不是原始 MQTT/Fetch 解析器或旧物流规则的替代品。 */
export type CanonicalInput = InputEnvelope & { kind: 'canonical'; semantics: 'canonical-state/1'; changes: StateChange[] };
export type GapInput = InputEnvelope & { kind: 'gap'; reason: string };
export type KernelInput = AdapterInput | AdvanceInput | CanonicalInput | GapInput;
export type KernelMode = 'projector' | 'canonical-follower';
export type StateReadView = {
  readonly metadata: DeepReadonly<StateMetadata>;
  readonly logic: DeepReadonly<LogicManifest>;
  get<K extends StateTable>(table: K, id: string): DeepReadonly<StateTableRecords[K]> | undefined;
  values<K extends StateTable>(table: K): Iterable<DeepReadonly<StateTableRecords[K]>>;
};
export type StateTransactionPort = StateReadView & {
  readonly logicalTime: number;
  readonly inputCursor: DeepReadonly<InputCursor>;
  put<K extends StateTable>(table: K, record: StateTableRecords[K]): void;
  remove(table: StateTable, id: string): void;
  allocateId(namespace: string): string;
};
