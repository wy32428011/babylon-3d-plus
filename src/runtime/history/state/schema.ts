import { BASELINE_DOMAINS, SCHEDULE_PHASES, STATE_TABLES } from './types';
import { canonicalStringify, freezeData, requireState, TwinStateError } from './safeJson';
import type { StateBudgets } from './safeJson';

/** 可直接 JSON.stringify 后交给 Java/Node 的 Draft 2020-12 schema；不含可执行转换。 */
export type JsonSchema = {
  readonly $schema?: string; readonly $id?: string; readonly $ref?: string;
  readonly $defs?: Readonly<Record<string, JsonSchema>>;
  readonly description?: string;
  readonly type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';
  readonly const?: unknown; readonly enum?: readonly unknown[];
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean | JsonSchema;
  readonly items?: JsonSchema; readonly minItems?: number; readonly maxItems?: number;
  readonly minLength?: number; readonly maxLength?: number; readonly pattern?: string;
  readonly minimum?: number; readonly maximum?: number;
  readonly oneOf?: readonly JsonSchema[];
};
const ref = (name: string): JsonSchema => ({ $ref: `#/$defs/${name}` });
const object = (properties: Record<string, JsonSchema>): JsonSchema => ({
  type: 'object', properties, required: Object.keys(properties), additionalProperties: false,
});
const list = (items: JsonSchema): JsonSchema => ({ type: 'array', items });
const nullable = (schema: JsonSchema): JsonSchema => ({ oneOf: [{ type: 'null' }, schema] });
const literal = (value: unknown): JsonSchema => ({ const: value });
const choice = (...values: readonly string[]): JsonSchema => ({ type: 'string', enum: values });
const text: JsonSchema = { type: 'string' };
const id: JsonSchema = { type: 'string', minLength: 1, maxLength: 2048 };
const decimal: JsonSchema = { type: 'string', minLength: 1, maxLength: 256, pattern: '^(0|[1-9][0-9]*)$' };
const number: JsonSchema = { type: 'number' };
const time: JsonSchema = { type: 'integer', minimum: 0, maximum: 8_640_000_000_000_000 };
const integer: JsonSchema = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const bool: JsonSchema = { type: 'boolean' };
const jsonObject: JsonSchema = { type: 'object', additionalProperties: ref('json') };
const pose = ref('pose'), cursor = ref('inputCursor'), state = ref('adapterState');
const endpoint = ref('endpoint');
const defs: Record<string, JsonSchema> = {
  json: { oneOf: [text, number, bool, { type: 'null' }, list(ref('json')), jsonObject] },
  vec3: { type: 'array', items: number, minItems: 3, maxItems: 3 },
  quaternion: { type: 'array', items: number, minItems: 4, maxItems: 4 },
  pose: object({ position: ref('vec3'), rotation: ref('quaternion'), scale: ref('vec3') }),
  inputCursor: object({ captureDomainId: id, captureEpoch: id, offset: decimal }),
  stateCursor: object({ projectionId: id, stateRevision: decimal }),
  identity: object({ projectId: id, sourceId: id, deviceType: id, assetCode: id }),
  versions: object({
    stateSchemaVersion: literal('1'), kernelVersion: literal('state-kernel/1'), scheduleVersion: literal('input-boundary/1'),
    projectId: id, publishedVersionId: id, sceneHash: id, modelManifestHash: id, scriptManifestHash: id,
    logicManifestHash: id, bindingRevision: id, sourceContractId: id, projectorVersion: id,
  }),
  adapterRequirement: object({ adapterId: id, version: id, stateSchemaVersion: id, deviceTypes: list(id) }),
  adapterState: object({ adapterId: id, version: id, stateSchemaVersion: id, value: jsonObject }),
  model: object({
    id, revision: id, bounds: object({ min: ref('vec3'), max: ref('vec3') }),
    anchors: list(object({ id, parentAnchorId: nullable(id), channel: nullable(id), localPose: pose })),
    dimensions: { type: 'object', additionalProperties: number },
  }),
  logicalDevice: object({ id, identity: ref('identity'), modelId: id, adapterId: id, basePose: pose,
    ports: list(object({ id, anchorId: id })), parameters: jsonObject }),
  logicalSlot: object({ id, locatorId: id, row: id, column: integer, layer: integer, depth: id, pose }),
  generator: object({ id, adapterId: id, modelId: id, deviceType: nullable(id),
    sourceId: id, ttlMs: nullable(time), parameters: jsonObject }),
  logic: object({
    versions: ref('versions'), sources: list(object({ id, revision: id, required: bool })),
    requiredAdapters: list(ref('adapterRequirement')),
    businessScripts: list(object({ id, digest: id, adapterId: id })), models: list(ref('model')),
    devices: list(ref('logicalDevice')), slots: list(ref('logicalSlot')), generators: list(ref('generator')),
    links: list(object({ id, fromDeviceId: id, fromPortId: id, toDeviceId: id, toPortId: id, parameters: jsonObject })),
  }),
  telemetry: object({
    fields: jsonObject, receivedAt: time, sourceTimestamp: nullable(time), sequence: nullable(decimal), deviceEpoch: id,
    eventId: nullable(id), inputCursor: cursor, currentLocationKey: nullable(id), targetLocationKey: nullable(id),
    hasTargetLocation: bool, faulted: bool, topic: text, payloadDeviceCode: nullable(id), spawnerCode: nullable(id), message: text,
  }),
  devices: object({
    id, identity: ref('identity'), logicalDeviceId: nullable(id), modelId: id, basePose: pose,
    attachment: nullable(object({ deviceId: id, anchorId: id, offset: pose })),
    telemetry: object({ previous: nullable(ref('telemetry')), current: nullable(ref('telemetry')), effectiveHeartbeatAt: nullable(time) }),
    ordering: object({ deviceEpoch: id, lastSequence: nullable(decimal), lastEventId: nullable(id), lastInputCursor: nullable(cursor) }),
    dynamic: nullable(object({ generatorId: id, generation: decimal, bornAt: time, lastHeartbeatAt: nullable(time),
      expiresAt: nullable(time), expiryTimerId: nullable(id) })), driverState: state,
  }),
  endpoint: { oneOf: [object({ kind: literal('device'), deviceId: id, portId: id }), object({ kind: literal('slot'), slotId: id })] },
  host: { oneOf: [endpoint, object({ kind: literal('transfer'), transferId: id })] },
  cargo: object({
    id, containerCode: nullable(id), taskId: nullable(id),
    origin: object({ sourceId: id, inputCursor: cursor, generatorId: nullable(id), generation: nullable(decimal) }),
    host: nullable(ref('host')), localPose: pose,
    handoff: nullable(object({ fromWorld: pose, startedAt: time, endsAt: time })),
    createdAt: time, destroyedAt: nullable(time), destroyReason: nullable(id),
  }),
  slots: object({ id, cargoId: nullable(id), inventoryRevision: nullable(id) }),
  transfers: object({ id, cargoId: id, from: endpoint, to: endpoint,
    phase: choice('pending', 'in-flight', 'complete', 'cancelled'), startedAt: time,
    completedAt: nullable(time), pose, state }),
  motions: object({ id, deviceId: id, channel: id, startedAt: time, endsAt: time, from: pose, to: pose, interpolation: literal('linear-slerp') }),
  fetchRequests: object({ id, attemptId: id, sourceId: id, sourceRevision: id, sourceContractId: id,
    operationEpoch: id, generation: decimal, scope: choice('full', 'rows'), rows: list(object({ row: id, generation: decimal })),
    issuedAt: time, completedAt: nullable(time), status: choice('pending', 'succeeded', 'failed', 'superseded'),
    responseRef: nullable(id), failure: nullable(text) }),
  fetchRows: object({ id, sourceId: id, row: id, operationEpoch: id, latestGeneration: decimal,
    latestRequestId: nullable(id), appliedRequestId: nullable(id), inventoryRevision: nullable(id),
    transientSuppressedSlotIds: list(id), persistentSuppressedSlotIds: list(id),
    pendingSettlement: list(object({ cargoId: id, slotId: id, deviceId: nullable(id), requestId: nullable(id) })) }),
  alarms: object({ id, deviceId: id, ruleId: id,
    retained: list(object({ property: id, value: ref('json'), receivedAt: time, inputCursor: cursor })),
    active: bool, activatedAt: nullable(time), clearedAt: nullable(time), evaluatedAt: nullable(time),
    edge: choice('unknown', 'active', 'inactive'), state }),
  timers: object({ id, adapterId: id, adapterVersion: id, timerType: id, dueAt: time, phase: choice(...SCHEDULE_PHASES),
    ordinal: decimal, deviceId: nullable(id), cargoId: nullable(id), payload: jsonObject }),
  counters: object({ id, value: decimal }),
  sources: object({ id, sourceRevision: id, sourceEpoch: id, lastSequence: nullable(decimal), lastInputCursor: cursor,
    recentEvents: list(object({ eventId: id, offset: decimal })) }),
  adapterStates: object({ id, deviceIds: list(id), cargoIds: list(id), state }),
  baselineProof: object({ id, snapshotRevision: id, asOf: time, complete: bool,
    domains: object(Object.fromEntries(BASELINE_DOMAINS.map(domain => [domain, bool]))),
    sourceBoundaries: list(object({ sourceId: id, sourceRevision: id, sourceEpoch: id, snapshotRevision: id,
      incrementalAfter: decimal, evidenceRef: id })),
    alignment: object({ status: choice('aligned', 'unproven'), method: choice('atomic-source', 'reconciled-vector'), evidenceRef: nullable(id) }),
    inputCursor: cursor }),
  continuity: { oneOf: [object({ status: literal('complete'), since: time, reason: { type: 'null' } }),
    object({ status: literal('gap'), since: time, reason: id })] },
  metadata: object({ projectionId: id, cursor: ref('stateCursor'), inputCursor: cursor, logicalTime: time,
    baseline: ref('baselineProof'), continuity: ref('continuity') }),
  tables: object(Object.fromEntries(STATE_TABLES.map(table => [table, list(ref(table))]))),
  twinState: object({ versions: ref('versions'), logic: ref('logic'), metadata: ref('metadata'), tables: ref('tables') }),
  checksum: object({ algorithm: literal('sha256'), value: { type: 'string', minLength: 64, maxLength: 64, pattern: '^[0-9a-f]{64}$' } }),
  change: { oneOf: STATE_TABLES.flatMap(table => [object({ op: literal('put'), table: literal(table), record: ref(table) }),
    object({ op: literal('remove'), table: literal(table), id })]) },
  revision: object({ revision: decimal, logicalTime: time, inputCursor: cursor,
    cause: object({ kind: choice('input', 'timer', 'advance', 'gap'), id }), continuity: ref('continuity'), changes: list(ref('change')) }),
};
const envelope = { schemaVersion: literal('1'), id, projectionId: id, versions: ref('versions'), cursor, logicalTime: time };
defs.input = { oneOf: [
  object({ ...envelope, kind: literal('adapter'), adapterId: id, adapterVersion: id, eventType: id, sourceId: id,
    sourceEpoch: id, sourceEventId: nullable(id), sourceSequence: nullable(decimal), payload: jsonObject }),
  object({ ...envelope, kind: literal('advance') }),
  object({ ...envelope, kind: literal('canonical'), semantics: literal('canonical-state/1'), changes: list(ref('change')) }),
  object({ ...envelope, kind: literal('gap'), reason: id }),
] };
function document(name: string, body: JsonSchema): JsonSchema {
  return freezeData({ $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `urn:babylon-3d-plus:history:${name}:1`, ...body, $defs: defs });
}
export const TWIN_STATE_JSON_SCHEMA = document('state', ref('twinState'));
export const TWIN_BASELINE_JSON_SCHEMA = document('baseline', object({ format: literal('twin-baseline/1'), state: ref('twinState') }));
export const TWIN_CHECKPOINT_JSON_SCHEMA = document('checkpoint', object({ format: literal('twin-checkpoint/1'), committed: literal(true), state: ref('twinState'), checksum: ref('checksum') }));
export const TWIN_CHANGE_BATCH_JSON_SCHEMA = document('changes', object({ format: literal('twin-changes/1'), committed: literal(true),
  versions: ref('versions'), projectionId: id, fromRevision: decimal, toRevision: decimal, throughTime: time,
  inputCursor: cursor, revisions: list(ref('revision')), checksum: ref('checksum') }));
export const TWIN_INPUT_JSON_SCHEMA = document('input', ref('input'));
export function recordSchema(table: string): JsonSchema { return { $ref: `#/$defs/${table}`, $defs: defs }; }

const supported = new Set(['$schema', '$id', '$ref', '$defs', 'description', 'type', 'const', 'enum', 'properties',
  'required', 'additionalProperties', 'items', 'minItems', 'maxItems', 'minLength', 'maxLength', 'pattern', 'minimum', 'maximum', 'oneOf']);
/** 适配器只可使用可移植的此子集；不静默忽略关键字，不加载远程 schema。 */
export function assertSupportedSchema(schema: JsonSchema, depth = 0): void {
  requireState(depth <= 48 && schema && typeof schema === 'object' && !Array.isArray(schema), 'ADAPTER_SCHEMA', '适配器 schema 不合法。');
  for (const key of Object.keys(schema)) requireState(supported.has(key), 'ADAPTER_SCHEMA', `不支持的 schema 关键字 ${key}。`);
  if (schema.$ref !== undefined) requireState(/^#\/\$defs\/[A-Za-z0-9_-]+$/u.test(schema.$ref), 'ADAPTER_SCHEMA', '仅支持本地 $defs 引用。');
  if (schema.type !== undefined) requireState(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(schema.type), 'ADAPTER_SCHEMA', '不支持的 schema 类型。');
  if (schema.pattern !== undefined) requireState(['^(0|[1-9][0-9]*)$', '^[0-9a-f]{64}$'].includes(schema.pattern), 'ADAPTER_SCHEMA', '不接受任意正则表达式；复杂校验放入受控适配器。');
  for (const key of ['minItems', 'maxItems', 'minLength', 'maxLength'] as const) {
    if (schema[key] !== undefined) requireState(Number.isSafeInteger(schema[key]) && schema[key]! >= 0, 'ADAPTER_SCHEMA', 'schema 长度上限不合法。');
  }
  for (const key of ['minimum', 'maximum'] as const) if (schema[key] !== undefined) requireState(Number.isFinite(schema[key]), 'ADAPTER_SCHEMA', 'schema 数值边界不合法。');
  if (schema.required) requireState(Array.isArray(schema.required) && schema.required.every(key => typeof key === 'string'), 'ADAPTER_SCHEMA', 'schema required 不合法。');
  if (schema.enum) requireState(Array.isArray(schema.enum) && schema.enum.length > 0, 'ADAPTER_SCHEMA', 'schema enum 不合法。');
  for (const child of [...Object.values(schema.$defs ?? {}), ...Object.values(schema.properties ?? {}), ...(schema.oneOf ?? [])]) assertSupportedSchema(child, depth + 1);
  if (schema.items) assertSupportedSchema(schema.items, depth + 1);
  if (typeof schema.additionalProperties === 'object') assertSupportedSchema(schema.additionalProperties, depth + 1);
  else if (schema.additionalProperties !== undefined) requireState(typeof schema.additionalProperties === 'boolean', 'ADAPTER_SCHEMA', 'schema additionalProperties 不合法。');
}
/** 数据先经过 copySafeJson；此函数不调用 getter 或 coercion，失败不会修改数据。 */
export function validateJsonSchema(value: unknown, schema: JsonSchema, budget: Readonly<StateBudgets>, label = '$'): void {
  let work = 0;
  const validate = (item: unknown, rule: JsonSchema, path: string, depth: number): void => {
    work += 1;
    requireState(depth <= budget.maxDepth * 4 && work <= budget.maxNodes * 64, 'BUDGET', 'schema 求值超过预算。');
    const fail = (condition: unknown, reason: string): void => requireState(condition, 'SCHEMA', `${path}: ${reason}`);
    if (rule.$ref) {
      const key = rule.$ref.slice('#/$defs/'.length), target = schema.$defs?.[key];
      fail(rule.$ref.startsWith('#/$defs/') && target, 'schema 引用缺失。');
      validate(item, target!, path, depth + 1); return;
    }
    if (Object.prototype.hasOwnProperty.call(rule, 'const')) fail(canonicalStringify(item) === canonicalStringify(rule.const), '固定值不匹配。');
    if (rule.enum) fail(rule.enum.some(candidate => canonicalStringify(candidate) === canonicalStringify(item)), '枚举值不受支持。');
    if (rule.oneOf) {
      let matches = 0;
      for (const candidate of rule.oneOf) {
        try { validate(item, candidate, path, depth + 1); matches += 1; }
        catch (error) { if (!(error instanceof TwinStateError) || error.code !== 'SCHEMA') throw error; }
      }
      fail(matches === 1, '必须匹配且仅匹配一个已知结构。');
    }
    if (!rule.type) return;
    switch (rule.type) {
      case 'null': fail(item === null, '必须为 null。'); break;
      case 'boolean': fail(typeof item === 'boolean', '必须是布尔值。'); break;
      case 'number': case 'integer': {
        fail(typeof item === 'number' && Number.isFinite(item) && (rule.type !== 'integer' || Number.isSafeInteger(item)), '必须是有效数值。');
        fail(rule.minimum === undefined || (item as number) >= rule.minimum, '数值低于下限。');
        fail(rule.maximum === undefined || (item as number) <= rule.maximum, '数值高于上限。'); break;
      }
      case 'string': {
        fail(typeof item === 'string', '必须是字符串。'); const textValue = item as string;
        fail(rule.minLength === undefined || textValue.length >= rule.minLength, '字符串过短。');
        fail(rule.maxLength === undefined || textValue.length <= rule.maxLength, '字符串过长。');
        if (rule.pattern) fail(new RegExp(rule.pattern, 'u').test(textValue), '字符串格式不合法。'); break;
      }
      case 'array': {
        fail(Array.isArray(item), '必须显式提供数组。'); const values = item as unknown[];
        fail(rule.minItems === undefined || values.length >= rule.minItems, '数组过短。');
        fail(rule.maxItems === undefined || values.length <= rule.maxItems, '数组过长。');
        if (rule.items) values.forEach((child, i) => validate(child, rule.items!, `${path}[${i}]`, depth + 1)); break;
      }
      case 'object': {
        fail(item !== null && typeof item === 'object' && !Array.isArray(item), '必须是对象。');
        const obj = item as Record<string, unknown>;
        for (const key of rule.required ?? []) fail(Object.prototype.hasOwnProperty.call(obj, key), `缺少必需字段 ${key}。`);
        for (const [key, child] of Object.entries(obj)) {
          const childRule = rule.properties && Object.prototype.hasOwnProperty.call(rule.properties, key) ? rule.properties[key] : undefined;
          if (childRule) validate(child, childRule, `${path}.${key}`, depth + 1);
          else if (typeof rule.additionalProperties === 'object') validate(child, rule.additionalProperties, `${path}.${key}`, depth + 1);
          else fail(rule.additionalProperties !== false, `未知字段 ${key}。`);
        }
        break;
      }
    }
  };
  validate(value, schema, label, 0);
}
