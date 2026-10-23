import { createModelTypeIdentityFromAsset, matchesModelTypeReference, modelTypePathKey } from './modelTypeIdentity.ts';
import type { EntityLightingSettings, LightingMobility } from './sceneLightingBakeContract.ts';

export const LIGHTING_POLICY_FIELDS = ['mobility', 'castShadows', 'receiveShadows', 'bakeIndirect'] as const;
export type LightingPolicyField = typeof LIGHTING_POLICY_FIELDS[number];
export type LightingPolicyValues = Partial<Pick<EntityLightingSettings, LightingPolicyField>>;
export type LightingModelReference = Parameters<typeof matchesModelTypeReference>[1];
export type LightingPolicyModelSource = Parameters<typeof matchesModelTypeReference>[0] & { dataPlatformSourceKey?: unknown };
export type LightingMotionRole = 'fixed' | 'moving' | 'unknown';
export type LightingPolicyTarget =
  | { kind: 'all' }
  | { kind: 'resource'; model: LightingModelReference }
  | { kind: 'type'; deviceType: string }
  | { kind: 'group'; folderId: string };
export type LightingPolicyNodeTarget =
  | { kind: 'motion'; role: 'fixed' | 'moving' }
  | { kind: 'node'; nodeKey: string; resourceIdentity: string };
export type LightingPolicyNodeRule = {
  id: string;
  name?: string;
  enabled: boolean;
  target: LightingPolicyNodeTarget;
  values: LightingPolicyValues;
};
export type LightingPolicyRule = {
  id: string;
  name?: string;
  enabled: boolean;
  target: LightingPolicyTarget;
  values: LightingPolicyValues;
  nodeRules?: LightingPolicyNodeRule[];
};
export type SceneLightingPolicy = { version: 1; defaults: LightingPolicyValues; rules: LightingPolicyRule[] };
export type LightingPolicyEntity = { id?: string; parentId?: string | null; isFolder?: boolean; components?: unknown };
export type LightingPolicyContext = {
  entityId: string;
  ownerEntityId?: string;
  entity?: LightingPolicyEntity;
  entities?: Readonly<Record<string, unknown>>;
  modelAsset?: LightingPolicyModelSource;
  deviceType?: string;
  ancestorIds?: readonly string[];
  nodeKey?: string;
  /** 资源内稳定部件键；生成器的运行时 owner/member 前缀不参与部件绑定。 */
  partKey?: string;
  resourceIdentity?: string;
  motionRole?: LightingMotionRole;
  availableNodeKeys?: readonly string[];
  automatic: { mobility: 'static' | 'dynamic'; reason: string };
  parentDynamic?: boolean;
  /** 保留组件缺失和已有完整例外的区别；不得先为缺失组件补默认值。 */
  entityLighting?: unknown;
};
export type LightingPolicyFieldSource = {
  kind: 'automatic' | 'scene-default' | 'rule' | 'node-rule' | 'entity' | 'node-override' | 'ancestor';
  label: string;
  value: LightingMobility | boolean;
  ruleId?: string;
  nodeRuleId?: string;
  entityId?: string;
  nodeKey?: string;
};
export type LightingPolicyFieldSources = Record<LightingPolicyField, LightingPolicyFieldSource>;
export type LightingPolicyMismatch = {
  kind: 'resource-identity' | 'missing-node';
  ruleId?: string;
  nodeRuleId?: string;
  nodeKey: string;
  expectedResourceIdentity?: string;
  actualResourceIdentity?: string;
  message: string;
};
export type LightingPolicyConflict = {
  field: LightingPolicyField;
  requested: LightingMobility | boolean;
  effective: 'static' | 'dynamic' | boolean;
  reason: string;
  ruleId?: string;
  nodeRuleId?: string;
};
export type ResolvedLightingPolicy = {
  settings: { mobility: 'static' | 'dynamic'; castShadows: boolean; receiveShadows: boolean; bakeIndirect: boolean };
  fieldSources: LightingPolicyFieldSources;
  sourceLabel: string;
  matchedRuleIds: string[];
  mismatches: LightingPolicyMismatch[];
  conflicts: LightingPolicyConflict[];
  motionRole: LightingMotionRole;
  reason: string;
  parentDynamic: boolean;
  preservedExceptionFields: LightingPolicyField[];
};
export type LightingPolicyComparison = {
  rows: Array<{ entityId: string; ownerEntityId?: string; nodeKey?: string; before: ResolvedLightingPolicy; after: ResolvedLightingPolicy; changedFields: LightingPolicyField[] }>;
  affectedEntityCount: number;
  affectedNodeCount: number;
  preservedExceptionCount: number;
  mismatchCount: number;
  conflictCount: number;
};

/** 所有函数只处理数据，不读取文件、场景引擎、全局 Store 或运行时节点。 */
type Obj = Record<string, unknown>;
const object = (value: unknown): Obj => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Obj : {};
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const safeKey = (key: string): boolean => !!key && !['__proto__', 'constructor', 'prototype'].includes(key);
const emptyPolicy = (): SceneLightingPolicy => ({ version: 1, defaults: {}, rules: [] });

export function normalizeLightingPolicyValues(value: unknown): LightingPolicyValues {
  const raw = object(value);
  return {
    ...(typeof raw.mobility === 'string' && ['auto', 'static', 'dynamic'].includes(raw.mobility) ? { mobility: raw.mobility as LightingMobility } : {}),
    ...(typeof raw.castShadows === 'boolean' ? { castShadows: raw.castShadows } : {}),
    ...(typeof raw.receiveShadows === 'boolean' ? { receiveShadows: raw.receiveShadows } : {}),
    ...(typeof raw.bakeIndirect === 'boolean' ? { bakeIndirect: raw.bakeIndirect } : {}),
  };
}
export function normalizeLightingPolicyInheritance(value: unknown): LightingPolicyField[] | undefined {
  return Array.isArray(value) ? LIGHTING_POLICY_FIELDS.filter(field => value.includes(field)) : undefined;
}
function normalizeReference(value: unknown): LightingModelReference | undefined {
  const raw = object(value), sourcePath = text(raw.sourcePath), sourceUrl = text(raw.sourceUrl);
  const identityRaw = raw.identity ?? raw.dataPlatformModel;
  let identity: NonNullable<LightingModelReference['identity']> | undefined;
  if (identityRaw !== undefined) {
    const item = object(identityRaw), sourceKey = text(item.sourceKey), resourceId = text(item.resourceId), modelPath = text(item.modelPath);
    if (!sourceKey || !resourceId || !modelPath || (item.kind !== 'model' && item.kind !== 'combo')) return undefined;
    identity = { sourceKey, kind: item.kind, resourceId, modelPath };
  }
  if (!identity && !sourcePath && !sourceUrl) return undefined;
  return { ...(sourcePath ? { sourcePath } : {}), ...(sourceUrl ? { sourceUrl } : {}), ...(identity ? { identity } : {}) };
}
export function createLightingModelReference(asset: LightingPolicyModelSource): LightingModelReference | undefined {
  const identity = asset.dataPlatformModel ?? createModelTypeIdentityFromAsset(asset);
  return normalizeReference({ sourcePath: asset.sourcePath, sourceUrl: asset.sourceUrl, ...(identity ? { identity } : {}) });
}
function normalizeTarget(value: unknown): LightingPolicyTarget | undefined {
  const raw = object(value);
  if (raw.kind === 'all') return { kind: 'all' };
  if (raw.kind === 'type' && text(raw.deviceType)) return { kind: 'type', deviceType: text(raw.deviceType) };
  if (raw.kind === 'group' && safeKey(text(raw.folderId))) return { kind: 'group', folderId: text(raw.folderId) };
  if (raw.kind === 'resource') {
    const model = normalizeReference(raw.model);
    if (model) return { kind: 'resource', model };
  }
  return undefined;
}
function normalizeNodeTarget(value: unknown): LightingPolicyNodeTarget | undefined {
  const raw = object(value);
  if (raw.kind === 'motion' && (raw.role === 'fixed' || raw.role === 'moving')) return { kind: 'motion', role: raw.role };
  const nodeKey = normalizeLightingPolicyNodeKey(text(raw.nodeKey)), resourceIdentity = text(raw.resourceIdentity);
  return raw.kind === 'node' && safeKey(nodeKey) && resourceIdentity
    ? { kind: 'node', nodeKey: normalizeLightingPolicyNodeKey(nodeKey), resourceIdentity } : undefined;
}
export function normalizeSceneLightingPolicy(value: unknown): SceneLightingPolicy | undefined {
  const raw = object(value);
  if (raw.version !== 1) return undefined;
  const rules: LightingPolicyRule[] = [], ids = new Set<string>();
  for (const entry of Array.isArray(raw.rules) ? raw.rules : []) {
    const item = object(entry), id = text(item.id), target = normalizeTarget(item.target);
    if (!safeKey(id) || ids.has(id) || !target) continue;
    ids.add(id);
    const nodeRules: LightingPolicyNodeRule[] = [], nodeIds = new Set<string>();
    for (const nodeEntry of Array.isArray(item.nodeRules) ? item.nodeRules : []) {
      const node = object(nodeEntry), nodeId = text(node.id), nodeTarget = normalizeNodeTarget(node.target);
      if (!safeKey(nodeId) || nodeIds.has(nodeId) || !nodeTarget) continue;
      nodeIds.add(nodeId);
      nodeRules.push({ id: nodeId, ...(text(node.name) ? { name: text(node.name) } : {}), enabled: node.enabled !== false,
        target: nodeTarget, values: normalizeLightingPolicyValues(node.values) });
    }
    rules.push({ id, ...(text(item.name) ? { name: text(item.name) } : {}), enabled: item.enabled !== false, target,
      values: normalizeLightingPolicyValues(item.values), ...(nodeRules.length ? { nodeRules } : {}) });
  }
  return { version: 1, defaults: normalizeLightingPolicyValues(raw.defaults), rules };
}
export function normalizeLightingPolicyNodeKey(key: string): string {
  return key.replace(/(?:\/(?:instance|thin):\d+)+$/, '');
}
function entityFor(context: LightingPolicyContext): LightingPolicyEntity {
  return context.entity ?? object(context.entities?.[context.ownerEntityId ?? context.entityId]) as LightingPolicyEntity;
}
export function matchesLightingPolicyTarget(target: LightingPolicyTarget, context: LightingPolicyContext): boolean {
  if (target.kind === 'all') return true;
  const entity = entityFor(context), components = object(entity.components);
  if (target.kind === 'resource') {
    const asset = context.modelAsset ?? object(components.modelAsset) as LightingPolicyModelSource;
    return matchesModelTypeReference(asset, target.model);
  }
  if (target.kind === 'type') {
    const deviceType = context.deviceType ?? text(object(components.telemetryBinding).deviceType);
    return !!deviceType && deviceType === target.deviceType;
  }
  if (context.ancestorIds?.includes(target.folderId)) return true;
  const visited = new Set<string>();
  for (let id = entity.parentId; id && !visited.has(id);) {
    visited.add(id);
    const parent = object(context.entities?.[id]);
    if (id === target.folderId && (parent.isFolder === true || !context.entities)) return true;
    id = typeof parent.parentId === 'string' ? parent.parentId : undefined;
  }
  return false;
}
type NodeDirectoryIndex = (keys: readonly string[]) => ReadonlySet<string>;
/** 仅属于一次编译/比较批次；同一目录在该批次内视为不可变快照，禁止跨草稿做全局缓存。 */
function createNodeDirectoryIndex(): NodeDirectoryIndex {
  const directories = new WeakMap<readonly string[], ReadonlySet<string>>();
  return keys => {
    let directory = directories.get(keys);
    if (!directory) {
      directory = new Set(keys.map(normalizeLightingPolicyNodeKey));
      directories.set(keys, directory);
    }
    return directory;
  };
}
function nodeMatches(target: LightingPolicyNodeTarget, context: LightingPolicyContext,
  mismatch: (value: LightingPolicyMismatch) => void, directoryIndex?: NodeDirectoryIndex): boolean {
  if (target.kind === 'motion') return context.motionRole === target.role;
  const currentKey = context.partKey ?? context.nodeKey;
  if (!currentKey && !context.availableNodeKeys) return false;
  if (target.resourceIdentity !== context.resourceIdentity) {
    mismatch({ kind: 'resource-identity', nodeKey: target.nodeKey, expectedResourceIdentity: target.resourceIdentity,
      ...(context.resourceIdentity ? { actualResourceIdentity: context.resourceIdentity } : {}), message: '资源修订或实际拓扑已变化，部件规则未应用。' });
    return false;
  }
  const directory = context.availableNodeKeys;
  const present = !directory || (directoryIndex ? directoryIndex(directory).has(target.nodeKey)
    : directory.some(key => normalizeLightingPolicyNodeKey(key) === target.nodeKey));
  if (!present) {
    mismatch({ kind: 'missing-node', nodeKey: target.nodeKey, message: '当前资源中不存在绑定的稳定部件，规则未应用。' });
    return false;
  }
  return !!currentKey && normalizeLightingPolicyNodeKey(currentKey) === target.nodeKey;
}
export function resolveSceneLightingPolicy(value: unknown, context: LightingPolicyContext): ResolvedLightingPolicy {
  return resolveNormalizedPolicy(normalizeSceneLightingPolicy(value) ?? emptyPolicy(), context);
}
type PolicyInitialState = {
  requested: { mobility: LightingMobility; castShadows: boolean; receiveShadows: boolean; bakeIndirect: boolean };
  fieldSources: LightingPolicyFieldSources;
};
const policyArrayPrototype = Array.prototype, policyObject = Object;
const policyMap = policyArrayPrototype.map, policyIterator = policyArrayPrototype[Symbol.iterator], policyFromEntries = Object.fromEntries;
const policyDescriptor = Object.getOwnPropertyDescriptor;
function canUsePolicyInitialTemplate(): boolean {
  // 只检查库自身原型；未知方法/访问器继续走原初始化，不增加业务对象的读取。
  const map = policyDescriptor(policyArrayPrototype, 'map'), iterator = policyDescriptor(policyArrayPrototype, Symbol.iterator);
  const entries = policyDescriptor(policyObject, 'fromEntries');
  return !!map && 'value' in map && map.value === policyMap
    && !!iterator && 'value' in iterator && iterator.value === policyIterator
    && !!entries && 'value' in entries && entries.value === policyFromEntries;
}
function createPolicyInitialState(): PolicyInitialState {
  const requested = { mobility: 'auto' as LightingMobility, castShadows: true, receiveShadows: true, bakeIndirect: true };
  const fieldSources = Object.fromEntries(LIGHTING_POLICY_FIELDS.map(field => [field,
    { kind: 'automatic', label: '自动分类', value: requested[field] }])) as LightingPolicyFieldSources;
  return { requested, fieldSources };
}
function createPolicyInitialTemplate(policy: SceneLightingPolicy): PolicyInitialState {
  const initial = createPolicyInitialState();
  for (const field of LIGHTING_POLICY_FIELDS) if (policy.defaults[field] !== undefined) {
    if (field === 'mobility') initial.requested.mobility = policy.defaults.mobility!;
    else initial.requested[field] = policy.defaults[field]!;
    initial.fieldSources[field] = { kind: 'scene-default', label: '场景默认', value: policy.defaults[field]! };
  }
  return initial;
}
function clonePolicyInitialState(template: PolicyInitialState): PolicyInitialState {
  // 字段来源属于目录行；只复用纯模板，返回值仍全部独立，避免行间修改产生新别名。
  return { requested: { ...template.requested }, fieldSources: {
    mobility: { ...template.fieldSources.mobility }, castShadows: { ...template.fieldSources.castShadows },
    receiveShadows: { ...template.fieldSources.receiveShadows }, bakeIndirect: { ...template.fieldSources.bakeIndirect },
  } };
}
function hasScalarPolicyDefaults(policy: SceneLightingPolicy): boolean {
  // 规范化访问器可能连续返回不同类型；模板只接收最终确认为标量的私有默认字段。
  const defaults = policy.defaults;
  return (defaults.mobility === undefined || defaults.mobility === 'auto' || defaults.mobility === 'static' || defaults.mobility === 'dynamic')
    && (defaults.castShadows === undefined || typeof defaults.castShadows === 'boolean')
    && (defaults.receiveShadows === undefined || typeof defaults.receiveShadows === 'boolean')
    && (defaults.bakeIndirect === undefined || typeof defaults.bakeIndirect === 'boolean');
}

/** 整轮复用策略与节点目录快照；策略或目录原地编辑后须重新创建，避免跨草稿读取陈旧结果。 */
export function createSceneLightingPolicyResolver(value: unknown): (context: LightingPolicyContext) => ResolvedLightingPolicy {
  const policy = normalizeSceneLightingPolicy(value) ?? emptyPolicy(), directoryIndex = createNodeDirectoryIndex();
  const initial = canUsePolicyInitialTemplate() && hasScalarPolicyDefaults(policy) ? createPolicyInitialTemplate(policy) : undefined;
  return context => resolveNormalizedPolicy(policy, context, directoryIndex, initial);
}
function resolveNormalizedPolicy(policy: SceneLightingPolicy, context: LightingPolicyContext, directoryIndex?: NodeDirectoryIndex,
  initial?: PolicyInitialState): ResolvedLightingPolicy {
  const useTemplate = initial && canUsePolicyInitialTemplate();
  const { requested, fieldSources } = useTemplate ? clonePolicyInitialState(initial) : createPolicyInitialState();
  const matchedRuleIds: string[] = [], mismatches: LightingPolicyMismatch[] = [], conflicts: LightingPolicyConflict[] = [];
  const preserved = new Set<LightingPolicyField>();
  const assign = (field: LightingPolicyField, fieldValue: LightingMobility | boolean, source: LightingPolicyFieldSource) => {
    if (field === 'mobility') requested.mobility = fieldValue as LightingMobility;
    else requested[field] = fieldValue as boolean;
    fieldSources[field] = { ...source, value: fieldValue };
  };
  if (!useTemplate) for (const field of LIGHTING_POLICY_FIELDS) if (policy.defaults[field] !== undefined) {
    assign(field, policy.defaults[field]!, { kind: 'scene-default', label: '场景默认', value: policy.defaults[field]! });
  }
  const claimed = new Set<LightingPolicyField>();
  for (const rule of policy.rules) {
    if (!rule.enabled || !matchesLightingPolicyTarget(rule.target, context)) continue;
    matchedRuleIds.push(rule.id);
    const candidates = { ...rule.values }, candidateSources: Partial<LightingPolicyFieldSources> = {};
    const ruleLabel = `规则「${rule.name ?? rule.id}」`;
    for (const field of LIGHTING_POLICY_FIELDS) if (candidates[field] !== undefined) {
      candidateSources[field] = { kind: 'rule', label: ruleLabel, ruleId: rule.id, value: candidates[field]! };
    }
    const nodeClaimed = new Set<LightingPolicyField>();
    for (const node of rule.nodeRules ?? []) {
      if (!node.enabled || !Object.keys(node.values).length || !nodeMatches(node.target, context,
        issue => mismatches.push({ ...issue, ruleId: rule.id, nodeRuleId: node.id }), directoryIndex)) continue;
      for (const field of LIGHTING_POLICY_FIELDS) if (!nodeClaimed.has(field) && node.values[field] !== undefined) {
        nodeClaimed.add(field);
        if (field === 'mobility') candidates.mobility = node.values.mobility;
        else candidates[field] = node.values[field];
        candidateSources[field] = { kind: 'node-rule', label: `${ruleLabel} / 部件「${node.name ?? node.id}」`,
          ruleId: rule.id, nodeRuleId: node.id, value: node.values[field]! };
      }
    }
    for (const field of LIGHTING_POLICY_FIELDS) if (!claimed.has(field) && candidates[field] !== undefined) {
      claimed.add(field); assign(field, candidates[field]!, candidateSources[field]!);
    }
  }
  // 草稿恢复继承会显式传 undefined/null；仅缺省属性才回退实体组件，不能让旧快照中的例外复活。
  const entity = entityFor(context), rawLighting = Object.hasOwn(context, 'entityLighting') ? context.entityLighting : object(entity.components).lighting;
  if (rawLighting !== null && typeof rawLighting === 'object' && !Array.isArray(rawLighting)) {
    const lighting = object(rawLighting), values = normalizeLightingPolicyValues(lighting);
    const inherited = new Set(normalizeLightingPolicyInheritance(lighting.inheritPolicy) ?? []);
    const entityId = context.ownerEntityId ?? entity.id ?? context.entityId;
    for (const field of LIGHTING_POLICY_FIELDS) if (!inherited.has(field)) {
      const fieldValue = values[field] ?? (field === 'mobility' ? 'auto' : true);
      assign(field, fieldValue, { kind: 'entity', label: '已有对象例外', entityId, value: fieldValue });
      preserved.add(field);
    }
    const overrides = object(lighting.nodeOverrides), nodeKey = context.nodeKey;
    const node = nodeKey && safeKey(nodeKey) && Object.hasOwn(overrides, nodeKey) ? object(overrides[nodeKey]) : null;
    if (node) {
      const identity = text(lighting.resourceIdentity);
      if (identity && identity !== context.resourceIdentity) {
        mismatches.push({ kind: 'resource-identity', nodeKey: nodeKey!, expectedResourceIdentity: identity,
          ...(context.resourceIdentity ? { actualResourceIdentity: context.resourceIdentity } : {}), message: '已有部件例外与当前资源身份失配，未应用。' });
      } else {
        const nodeValues = normalizeLightingPolicyValues(node), inherit = normalizeLightingPolicyInheritance(node.inheritPolicy);
        for (const field of LIGHTING_POLICY_FIELDS) {
          const fieldValue = nodeValues[field];
          if (fieldValue === undefined || inherit?.includes(field) || (field === 'mobility' && fieldValue === 'auto' && inherit === undefined)) continue;
          assign(field, fieldValue, { kind: 'node-override', label: '已有部件例外', entityId, nodeKey, value: fieldValue });
          preserved.add(field);
        }
      }
    }
  }
  const mobility = requested.mobility === 'auto' ? context.automatic.mobility : requested.mobility;
  const settings = { ...requested, mobility };
  let reason = requested.mobility === 'auto' ? context.automatic.reason
    : `${fieldSources.mobility.label}：${mobility === 'static' ? '静态' : '动态'}。`;
  if (context.parentDynamic) {
    const previous = fieldSources.mobility;
    if (requested.mobility === 'static') conflicts.push({ field: 'mobility', requested: 'static', effective: 'dynamic',
      reason: '动态祖先会改变当前部件的世界姿态，静态设置不能抵消该约束。',
      ...(previous.ruleId ? { ruleId: previous.ruleId } : {}), ...(previous.nodeRuleId ? { nodeRuleId: previous.nodeRuleId } : {}) });
    settings.mobility = 'dynamic'; reason = '动态祖先带动当前部件，静态设置不能抵消祖先运动。';
    fieldSources.mobility = { kind: 'ancestor', label: '动态祖先约束', value: 'dynamic' };
  }
  const labels = [...new Set(LIGHTING_POLICY_FIELDS.map(field => fieldSources[field].label))];
  return { settings, fieldSources, sourceLabel: labels.length === 1 ? labels[0] : `混合来源：${labels.join('、')}`,
    matchedRuleIds, mismatches, conflicts, motionRole: context.motionRole === 'fixed' || context.motionRole === 'moving' ? context.motionRole : 'unknown',
    reason, parentDynamic: Boolean(context.parentDynamic), preservedExceptionFields: LIGHTING_POLICY_FIELDS.filter(field => preserved.has(field)) };
}
export function compareSceneLightingPolicies(before: unknown, after: unknown, contexts: readonly LightingPolicyContext[]): LightingPolicyComparison {
  const beforePolicy = normalizeSceneLightingPolicy(before) ?? emptyPolicy(), afterPolicy = normalizeSceneLightingPolicy(after) ?? emptyPolicy();
  const directoryIndex = createNodeDirectoryIndex();
  const affectedEntities = new Set<string>(), affectedNodes = new Set<string>(), preservedEntities = new Set<string>();
  const mismatches = new Set<string>(), conflicts = new Set<string>();
  // 运行时每行只保留当前部件；完整预览在此合并一次，避免大模型的节点清单被逐行复制。
  const inventoryKey = (context: LightingPolicyContext) => JSON.stringify([context.ownerEntityId ?? context.entityId, context.resourceIdentity]);
  const inventories = new Map<string, Set<string>>();
  for (const context of contexts) {
    const key = context.partKey ?? context.nodeKey;
    if (!key || !context.resourceIdentity) continue;
    const id = inventoryKey(context), inventory = inventories.get(id) ?? new Set<string>();
    inventory.add(normalizeLightingPolicyNodeKey(key));
    inventories.set(id, inventory);
  }
  const nodeKeys = new Map([...inventories].map(([id, keys]) => [id, [...keys]]));
  const rows = contexts.map(context => {
    const availableNodeKeys = context.availableNodeKeys ?? nodeKeys.get(inventoryKey(context));
    const completeContext = availableNodeKeys ? { ...context, availableNodeKeys } : context;
    const current = resolveNormalizedPolicy(beforePolicy, completeContext, directoryIndex);
    const next = resolveNormalizedPolicy(afterPolicy, completeContext, directoryIndex);
    const changedFields = LIGHTING_POLICY_FIELDS.filter(field => current.settings[field] !== next.settings[field]);
    const entity = context.ownerEntityId ?? context.entityId, node = `${entity}\0${context.nodeKey ?? ''}`;
    if (changedFields.length) { affectedEntities.add(entity); affectedNodes.add(node); }
    if (next.preservedExceptionFields.length) preservedEntities.add(entity);
    for (const issue of next.mismatches) mismatches.add(JSON.stringify([entity, issue.kind, issue.ruleId, issue.nodeRuleId, issue.nodeKey]));
    for (const issue of next.conflicts) conflicts.add(JSON.stringify([node, issue.field, issue.ruleId, issue.nodeRuleId]));
    return { entityId: context.entityId, ...(context.ownerEntityId ? { ownerEntityId: context.ownerEntityId } : {}),
      ...(context.nodeKey ? { nodeKey: context.nodeKey } : {}), before: current, after: next, changedFields };
  });
  return { rows, affectedEntityCount: affectedEntities.size, affectedNodeCount: affectedNodes.size, preservedExceptionCount: preservedEntities.size,
    mismatchCount: mismatches.size, conflictCount: conflicts.size };
}
function targetSignature(target: LightingPolicyTarget): unknown {
  if (target.kind !== 'resource') return target;
  if (target.model.identity) return { kind: 'resource', identity: { ...target.model.identity, modelPath: modelTypePathKey(target.model.identity.modelPath) } };
  return { kind: 'resource', paths: [...new Set([modelTypePathKey(target.model.sourcePath), modelTypePathKey(target.model.sourceUrl)].filter(Boolean))].sort() };
}
export function getLightingPolicySignatureValue(value: unknown): unknown | undefined {
  const policy = normalizeSceneLightingPolicy(value);
  if (!policy) return undefined;
  const defaults: LightingPolicyValues = {};
  for (const field of LIGHTING_POLICY_FIELDS) {
    const v = policy.defaults[field];
    if (v === undefined || v === (field === 'mobility' ? 'auto' : true)) continue;
    if (field === 'mobility') defaults.mobility = v as LightingMobility; else defaults[field] = v as boolean;
  }
  const rules = policy.rules.filter(rule => rule.enabled).flatMap(rule => {
    const nodeRules = (rule.nodeRules ?? []).filter(node => node.enabled && Object.keys(node.values).length)
      .map(node => ({ target: node.target, values: node.values }));
    if (!Object.keys(rule.values).length && !nodeRules.length) return [];
    return [{ target: targetSignature(rule.target), values: rule.values, ...(nodeRules.length ? { nodeRules } : {}) }];
  });
  return Object.keys(defaults).length || rules.length ? { version: 1, defaults, rules } : undefined;
}
