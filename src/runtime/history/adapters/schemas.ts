import type { JsonSchema } from '../state/schema';
import { TWIN_STATE_JSON_SCHEMA } from '../state/schema';
import { DEVICE_TYPES } from '../state/types';

const ref = (key: string): JsonSchema => ({ $ref: '#/$defs/' + key });
const obj = (properties: Record<string, JsonSchema>): JsonSchema => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const arr = (items: JsonSchema): JsonSchema => ({ type: 'array', items });
const maybe = (schema: JsonSchema): JsonSchema => ({ oneOf: [{ type: 'null' }, schema] });
const text: JsonSchema = { type: 'string' }, id: JsonSchema = { type: 'string', minLength: 1, maxLength: 2048 };
const number: JsonSchema = { type: 'number' }, bool: JsonSchema = { type: 'boolean' };
const time: JsonSchema = { type: 'integer', minimum: 0, maximum: 8_640_000_000_000_000 };
const decimal: JsonSchema = { type: 'string', minLength: 1, maxLength: 256, pattern: '^(0|[1-9][0-9]*)$' };
const choice = (...values: readonly string[]): JsonSchema => ({ type: 'string', enum: values });
const literal = (value: string): JsonSchema => ({ const: value });
const vec = ref('vec3'), pose = ref('pose'), quat = ref('quaternion'), nullableVec = maybe(vec), nullableText = maybe(text);
const range = obj({ min: number, max: number }), bounds = obj({ min: vec, max: vec });
const defs = { ...TWIN_STATE_JSON_SCHEMA.$defs } as Record<string, JsonSchema>;
function document(value: JsonSchema): JsonSchema { return { ...value, $defs: defs }; }
const common = { diagnostics: arr(text), lastFrameAt: maybe(time), birthOrder: maybe(decimal) };
const place = obj({ locatorId: id, slotId: id, column: number, layer: number, supportPosition: vec, retainCargo: bool });
const fork = { cargoId: maybe(id), bound: bool, holdPosition: nullableVec, bindOffset: nullableVec, holdRotation: maybe(quat), holdScaling: nullableVec,
  fetchRowId: maybe(id), placeTarget: maybe(place), pendingPlatformLocatorId: maybe(id) };
const stackerFork = obj({ ...fork, offset: number, targetOffset: number, lastCommand: maybe(number), lastMovementZ: maybe(number), prevRawMovementZ: maybe(number),
  signalAction: maybe(choice('fetch', 'place')), signalExtended: bool, signalCargoPresent: maybe(bool) });
const rgvMotion = obj({ column: number, task: text, mode: choice('fetch', 'place'), velocity: number });
const rgvStation = obj({ cargoId: maybe(id), onBoard: bool, holdPosition: nullableVec, holdRotation: maybe(quat), progress: number,
  lastCommand: maybe(number), lastMovementZ: maybe(number), transferMotion: maybe(rgvMotion) });
const liftStation = obj({ cargoId: maybe(id), onBoard: bool, holdPosition: nullableVec, holdRotation: maybe(quat), transferProgress: number,
  transferDirection: { type: 'number', enum: [1, -1] }, transferActive: bool, anchorPosition: nullableVec,
  taskAnnotationSeen: bool, reachedOutgoing: bool, outgoingDeviceId: maybe(id) });
const downstream: Record<string, JsonSchema> = { subscriberId: id, task: id, hops: { type: 'integer', minimum: 0 }, direction: number };
const states = [
  obj({ ...common, kind: literal('stacker'), rootPosition: nullableVec, liftOffset: number, forkCatchUp: bool,
    lastFrontCellKey: nullableText, lastFrontCellChangedAt: maybe(time), frontCellChangeIntervalMs: maybe(time), front: stackerFork, back: stackerFork }),
  obj({ ...common, kind: literal('conveyor'), cargoId: maybe(id), currentTask: nullableText, pendingTask: nullableText, lastTask: nullableText,
    waitingTask: nullableText, snapshotTask: nullableText, pendingTaskAgeSeconds: number, pendingPreviousTask: nullableText,
    taskPulseQueue: arr(id), upstreamLinks: arr(obj({ deviceId: id, task: id, holderDeviceId: id, hops: { type: 'integer', minimum: 0 }, direction: number })),
    downstreamLinks: arr(obj(downstream)), externalPulls: arr(obj({ ...downstream, holderDeviceId: id })), transitedTasks: arr(id),
    lastMovementDirection: number, selfDriveDirection: number, cargoDriveEngaged: bool, lastSnapshotReceivedAt: maybe(time), cargoTravelOffset: number,
    handoffEntryOffset: maybe(number), entryHandoffPending: bool, platformInboundCargo: bool, platformInboundDirection: number, platformPlacedCargo: bool }),
  obj({ ...common, kind: literal('hclift'), liftOffset: number, liftTargetOffset: maybe(number), targetLevel: maybe(number), hasInitialLevel: bool, workState: maybe(number),
    surface: maybe(obj({ supportY: number, deckCenter: vec, targetLevel: maybe(number), arrived: bool, workState: maybe(number), updatedAt: time })),
    occupancy: maybe(obj({ shuttleId: id, phase: choice('entering', 'loaded'), shuttleStatus: maybe(number), shuttleFaulted: bool, updatedAt: time })) }),
  obj({ ...common, ...fork, kind: literal('shuttle'), rootPosition: nullableVec, forkOffset: number, forkTargetOffset: number, forkCatchUp: bool,
    lastStatus: maybe(number), forkPhase: choice('idle', 'extending', 'retracting'), statusActionDone: bool,
    lastTargetCellKey: nullableText, lastTargetCellChangedAt: maybe(time), targetCellChangeIntervalMs: maybe(time), hcliftOccupancyId: maybe(id),
    lastHcliftLayer: maybe(number), hcliftExitDoneKey: nullableText, hcliftLoadedSawMoving: bool, hcliftExitFlashOutY: maybe(number),
    hcliftEntryStartPosition: nullableVec, hcliftExitStartPosition: nullableVec, hcliftDeckSupportYId: maybe(id), hcliftDeckSupportY: maybe(number), lastYFlashOffset: nullableVec }),
  obj({ ...common, kind: literal('rgv'), rootPosition: nullableVec, travelTargetPosition: nullableVec, travelTargetColumn: maybe(number), front: rgvStation, back: rgvStation }),
  obj({ ...common, kind: literal('lift'), liftOffset: number, liftTargetOffset: maybe(number), targetKey: nullableText, targetSide: maybe({ type: 'number', enum: [0, 1] }),
    targetLayer: maybe(number), targetDeviceId: maybe(id), arrivedTargetKey: nullableText, workState: maybe(number),
    stations: { type: 'array', items: liftStation, minItems: 2, maxItems: 2 }, outgoingHandoffCooldown: number, outgoingHandoffActive: bool }),
  obj({ ...common, kind: literal('passive'), role: literal('alarm-telemetry'), lastReceiptAt: maybe(time), lastAppliedAt: maybe(time),
    lastDisposition: maybe(choice('applied', 'heartbeat', 'duplicate', 'out-of-order')) }),
  obj({ kind: literal('raw-telemetry'), identity: ref('identity'), fields: { type: 'object', additionalProperties: ref('json') },
    deviceEpoch: id, sequence: maybe(decimal), sourceTimestamp: maybe(time), eventId: maybe(id),
    seenEventIds: { type: 'array', maxItems: 4096, items: id }, inputCursor: ref('inputCursor'), receivedAt: time,
    basis: obj({ kind: choice('baseline', 'full'), sourceRevision: id, snapshotRevision: id, evidenceRef: id, inputCursor: ref('inputCursor') }) }),
  obj({ kind: literal('uninstantiated'), identity: ref('identity'), telemetry: defs.devices.properties!.telemetry,
    ordering: defs.devices.properties!.ordering, lastDeviceId: maybe(id), generatorId: maybe(id), generation: maybe(decimal),
    retiredAt: maybe(time), lastReceiptAt: time, reason: id }),
  obj({ kind: literal('cargo'), cargoId: id, templateId: id, ownerDeviceId: maybe(id), ownerRole: maybe(choice('front', 'back', 'single', 'step1', 'step2')),
    retained: bool, awaitingFetch: bool, ownershipOrder: decimal, hasPose: bool, worldPose: pose, lockedWorldRotation: maybe(quat),
    handoff: maybe(obj({ from: pose, progress: { type: 'number', minimum: 0, maximum: 1 }, durationSeconds: { type: 'number', minimum: 0.05 } })) }),
  obj({ kind: literal('clock'), phase: id, lastAt: maybe(time), timerId: maybe(id), topologyDirty: bool }),
  obj({ kind: literal('alarm'), trigger: maybe(choice('device', 'fire', 'warehouse')), status: choice('disabled', 'waiting', 'missing', 'invalid', 'matched', 'unmatched') }),
];
export const LOGISTICS_STATE_VALUE_SCHEMA = document({ oneOf: states });

const part = obj({ anchorId: id, channel: id, worldToParent: { type: 'array', items: number, minItems: 9, maxItems: 9 },
  travel: bool, lift: bool, frontFork: number, backFork: number, shuttleFork: number });
const base: Record<string, JsonSchema> = { deviceId: id, deviceType: id, modelId: id, sourceId: id, assetCode: id, executionOrder: { type: 'integer', minimum: 0 },
  basePosition: vec, basePose: pose, worldBounds: bounds, travelAxis: vec, upAxis: vec, forkAxis: vec, staleAfterMs: time,
  motionParts: arr(part), cargoTemplateId: maybe(id), cargoGeneratorId: maybe(id), cargoPorts: obj({ front: maybe(id), back: maybe(id), single: maybe(id) }) };
const forkSpec = obj({ anchor: vec, centerHome: vec, stroke: number });
const targetSpec = obj({ entityId: id, deviceId: maybe(id), pose });
const layer = obj({ layer: number, targets: arr(targetSpec) });
const deviceSpecs = [
  obj({ ...base, kind: literal('stacker'), targetReference: vec, travelLimits: maybe(range), liftLimits: range,
    travelSpeed: number, liftSpeed: number, forkSpeed: number, cargoGapY: number, rpmToMetersPerSecond: number, forks: obj({ front: forkSpec, back: forkSpec }) }),
  obj({ ...base, kind: literal('conveyor'), center: vec, span: number, surfaceLift: number, forwardSign: { type: 'number', enum: [1, -1] },
    movementFields: arr(id), actionMap: { type: 'object', additionalProperties: number }, cargoSpeed: number,
    frontHasGoodsField: id, backHasGoodsField: id, cargoAutoDispose: bool, cargoOriginDevice: bool,
    probeNeighbors: obj({ forward: maybe(id), reverse: maybe(id) }), perpendicularEnds: obj({ positive: maybe(number), negative: maybe(number) }), platformLocatorId: maybe(id) }),
  obj({ ...base, kind: literal('hclift'), aisleCode: text, liftSpeed: number, liftLimits: range, deckCenterBase: vec, deckTopBase: number, platformLocatorId: id }),
  obj({ ...base, kind: literal('shuttle'), aisleCode: text, targetReference: vec, travelLimits: maybe(range), travelSpeed: number, forkSpeed: number,
    deckTravelSpeed: number, forkStroke: number, forkCenterHome: vec, forkAnchor: vec, cargoBaseHomeY: number, travelBodyHome: obj({ center: vec, axisMin: number, axisMax: number }) }),
  obj({ ...base, kind: literal('rgv'), travelSpeed: number, travelLimits: maybe(range), columns: arr(obj({ column: number, targets: arr(targetSpec) })),
    stations: obj({ front: obj({ anchor: vec, bounds }), back: obj({ anchor: vec, bounds }) }) }),
  obj({ ...base, kind: literal('lift'), liftSpeed: number, liftLimits: range, deckTopBase: number, deckCenterBase: vec, cargoAxis: maybe(vec),
    stationOffset: number, incomingLayers: arr(layer), outgoingLayers: arr(layer) }),
];
const passive = obj({ kind: literal('passive'), role: literal('alarm-telemetry'), deviceId: id, deviceType: id, modelId: id, sourceId: id,
  assetCode: id, executionOrder: { type: 'integer', minimum: 0 }, basePose: pose, staleAfterMs: time });
const locator = obj({ id, kind: choice('storage', 'platform', 'layer-change'), deviceAssetCode: text, aisleCode: text, row: number,
  depth: choice('near', 'far'), startColumn: number, startLayer: number, columns: { type: 'integer', minimum: 1 }, layers: { type: 'integer', minimum: 1 }, columnReversed: bool,
  cells: arr(obj({ slotId: id, column: number, layer: number, pose })), rootPose: pose, platformTrackEndWorld: maybe(vec), retainCargo: bool, hostDeviceId: maybe(id),
  fetchSourceId: maybe(id), fetchRow: maybe(id), cargoGeneratorId: maybe(id), cargoTemplateId: maybe(id) });
const script = obj({ id, digest: { type: 'string', minLength: 64, maxLength: 64, pattern: '^[0-9a-f]{64}$' }, profile: choice(...DEVICE_TYPES, 'storage', 'cargo', 'passive') });
export const LOGISTICS_MANIFEST_SCHEMA = document(obj({ format: literal('warehouse-logistics-manifest/1'), owner: obj({ kind: choice('device', 'generator'), id }),
  fixedStepMs: { type: 'integer', minimum: 1, maximum: 1000 }, frameAnchorAt: time,
  devices: arr({ oneOf: deviceSpecs }), passiveSubjects: arr(passive), locators: arr(locator),
  cargoTemplates: arr(obj({ id, generatorId: maybe(id), targetSignature: id, bounds })),
  cargoGenerators: arr(obj({ generatorId: id, defaultTemplateId: maybe(id), rules: arr(obj({ attributeName: text, attributeValue: text, templateId: maybe(id) })) })),
  dynamicGenerators: arr(obj({ generatorId: id, spawnerCode: id, sourceId: id, deviceType: id, modelId: id,
    template: { oneOf: [...deviceSpecs, passive] }, timeoutMs: maybe(time), ttlMs: maybe(time) })),
  fetchSources: arr(obj({ sourceId: id, rowKeys: arr(id), syncIntervalMs: time })),
  alarmRules: arr(obj({ id, managerId: id, targetEntityId: id, deviceId: id, enabled: bool, telemetryEnabled: bool,
    listenProperty: choice('RUNNING STATE', 'CUSTOM PROPERTY'), runningState: choice('offline', 'idle', 'running', 'alarm'),
    customProperty: text, customValue: text, warehouseAlarm: bool, staleAfterMs: time })), scripts: arr(script) }));

const inventoryRecord: JsonSchema = { type: 'object', properties: { row: text, column: number, layer: number, isEmpty: bool, containerCode: text, containerType: text },
  required: ['row', 'column', 'layer', 'isEmpty', 'containerCode', 'containerType'], additionalProperties: ref('json') };
export const LOGISTICS_EVENT_SCHEMAS: Readonly<Record<string, JsonSchema>> = {
  telemetry: document(obj({ deviceId: maybe(id), identity: ref('identity'), frame: ref('telemetry') })),
  'telemetry-batch': document(obj({ records: { type: 'array', minItems: 1, maxItems: 4096, items: obj({
    identity: ref('identity'), mode: choice('full', 'delta'), fields: { type: 'object', additionalProperties: ref('json') },
    receivedAt: time, sourceTimestamp: maybe(time), sequence: maybe(decimal), deviceEpoch: id, eventId: maybe(id),
    inputCursor: ref('inputCursor'), topic: text, payloadDeviceCode: maybe(id), spawnerCode: maybe(id),
  }) } })),
  activate: document(obj({})),
  'fetch-request': document(obj({ sourceId: id, operationEpoch: id, scope: choice('full', 'rows'), rows: arr(id) })),
  'fetch-result': document(obj({ requestId: id, attemptId: id, operationEpoch: id, outcome: choice('succeeded', 'failed'), responseRef: maybe(id),
    failure: nullableText, inventoryRevision: maybe(id), records: arr(inventoryRecord) })),
  'fetch-retry': document(obj({ requestId: id })),
  'fetch-reset': document(obj({ sourceId: id, operationEpoch: id })),
  'dynamic-birth': document(obj({ generatorId: id, identity: ref('identity'), frame: ref('telemetry') })),
  'dynamic-remove': document(obj({ deviceId: id, reason: id })),
};
export const LOGISTICS_TIMER_SCHEMAS: Readonly<Record<string, JsonSchema>> = {
  step: document(obj({ phase: choice('topology', ...DEVICE_TYPES, 'external-pull') })),
  'alarm-evaluate': document(obj({})),
  'fetch-poll': document(obj({ sourceId: id })),
  expire: document(obj({ deviceId: id, generation: decimal })),
};
