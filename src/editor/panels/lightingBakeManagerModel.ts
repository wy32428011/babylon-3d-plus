import {
  createLightingModelReference, createSceneLightingPolicyResolver, LIGHTING_POLICY_FIELDS, normalizeLightingPolicyNodeKey,
  type LightingModelReference, type LightingPolicyContext, type LightingPolicyField, type LightingPolicyValues,
  type ResolvedLightingPolicy, type SceneLightingPolicy,
} from '../../../electron/shared/sceneLightingPolicy.ts';
import { getSceneLightingBakeSignature, normalizeEntityLightingSettings, type EntityLightingSettings, type LightingClassificationEntry, type LightingNodeOverride } from '../../../electron/shared/sceneLightingBakeContract.ts';
import { isEntityEffectivelyLocked } from '../model/entityHierarchy';
import type { SceneDocument } from '../model/SceneDocument';
import { getSceneAppearanceConfig, getSceneLightingConfig, normalizeSceneAppearanceConfig, normalizeSceneLightingConfig, type SceneAppearanceConfig, type SceneLightingConfig } from '../../../electron/shared/sceneLightingConfig';
import { getSceneThemePreset, type SceneThemePresetId } from '../model/sceneTheme';
import { GLB_STANDARD_PREVIEW_PRESET_ID, createGlbStandardPreviewLightingConfig, createGlbStandardPreviewAppearanceConfig } from '../../../electron/shared/glbStandardPreview';

export type LightingManagerPresetId = SceneThemePresetId | typeof GLB_STANDARD_PREVIEW_PRESET_ID;

export type LightingManagerDraft = {
  baseScene: SceneDocument;
  sceneSessionId: string;
  lighting: SceneLightingConfig;
  appearance: SceneAppearanceConfig;
  entityLighting: Record<string, EntityLightingSettings | null>;
};
type PolicyEntry = LightingClassificationEntry & {
  policyContext?: LightingPolicyContext;
  ownerEntityId?: string;
  partKey?: string;
  automaticMobility?: 'static' | 'dynamic';
  automaticReason?: string;
  motionRole?: 'fixed' | 'moving' | 'unknown';
  deviceType?: string;
};
export type LightingManagerRow = {
  key: string;
  entityId: string;
  ownerEntityId: string;
  entityName: string;
  nodeKey: string;
  partKey: string;
  name: string;
  entry: PolicyEntry;
  context: LightingPolicyContext | null;
  effective: ResolvedLightingPolicy | null;
  previous: ResolvedLightingPolicy | null;
  changedFields: LightingPolicyField[];
  locked: boolean;
};
export type LightingManagerResourceOption = { key: string; name: string; reference: LightingModelReference; count: number };
export type LightingManagerSelection = { kind: 'entity'; entityId: string } | { kind: 'node'; key: string };
export type LightingManagerBulkValues = Record<LightingPolicyField, 'unchanged' | 'inherit' | 'auto' | 'static' | 'dynamic' | 'true' | 'false'>;
export const EMPTY_LIGHTING_BULK_VALUES: LightingManagerBulkValues = { mobility: 'unchanged', castShadows: 'unchanged', receiveShadows: 'unchanged', bakeIndirect: 'unchanged' };
export const LIGHTING_FIELD_LABELS: Record<LightingPolicyField, string> = {
  mobility: '动静分类', castShadows: '投射阴影', receiveShadows: '接收阴影', bakeIndirect: '参与间接光',
};
export function lightingDeviceTypeLabel(value: string): string {
  const labels: Record<string, string> = { environment: '场景环境', lift: '提升机', hclift: '换层提升机', rgv: 'RGV', shuttle: '穿梭车', stacker: '堆垛机', conveyor: '输送线' };
  return labels[value.toLowerCase()] ?? value;
}
export function getLightingManagerPolicy(value: unknown): SceneLightingPolicy {
  return normalizeSceneLightingConfig({ version: 2, policy: value }).policy ?? { version: 1, defaults: {}, rules: [] };
}

export function createLightingManagerDraft(scene: SceneDocument, sceneSessionId: string): LightingManagerDraft {
  return { baseScene: scene, sceneSessionId, lighting: structuredClone(getSceneLightingConfig(scene)),
    appearance: structuredClone(getSceneAppearanceConfig(scene)), entityLighting: {} };
}

export function isLightingManagerDraftDirty(draft: LightingManagerDraft): boolean {
  const current = normalizeSceneLightingConfig(draft.lighting), original = getSceneLightingConfig(draft.baseScene);
  // 空规则与缺省规则语义相同；用户撤回新增规则后不应仍然被要求保存。
  return JSON.stringify({ ...current, policy: undefined }) !== JSON.stringify({ ...original, policy: undefined })
    || JSON.stringify(getLightingManagerPolicy(current.policy)) !== JSON.stringify(getLightingManagerPolicy(original.policy))
    || JSON.stringify(normalizeSceneAppearanceConfig(draft.appearance)) !== JSON.stringify(getSceneAppearanceConfig(draft.baseScene))
    || Object.entries(draft.entityLighting).some(([id, next]) => JSON.stringify(next ?? undefined) !== JSON.stringify(draft.baseScene.entities[id]?.components.lighting));
}

/** 旧主题只复用预设数据；光照和显示分别暂存，不调用旧主题动作或改变已保存结果。 */
export function applyLightingManagerPreset(draft: LightingManagerDraft, presetId: LightingManagerPresetId, target: 'lighting' | 'appearance'): LightingManagerDraft {
  // 标准预览需要同时对齐照明与显示；仍只创建草稿，由现有应用事务统一提交和撤销。
  if (presetId === GLB_STANDARD_PREVIEW_PRESET_ID) {
    const sceneLightIds = draft.baseScene.entityIds.filter(id => draft.baseScene.entities[id]?.components.light);
    return { ...draft, lighting: createGlbStandardPreviewLightingConfig(draft.lighting, sceneLightIds),
      appearance: createGlbStandardPreviewAppearanceConfig(draft.appearance) };
  }
  const { settings, shadows } = getSceneThemePreset(presetId);
  if (target === 'lighting') return { ...draft, lighting: { ...draft.lighting,
    main: { ...draft.lighting.main, source: 'managed', enabled: true, color: settings.mainColor, azimuthDegrees: shadows.sunAzimuthDegrees,
      elevationDegrees: shadows.sunElevationDegrees, intensity: shadows.sunIntensity },
    fill: { ...draft.lighting.fill, intensity: shadows.fillIntensity, color: settings.fillColor, groundColor: settings.groundColor },
    environmentIntensity: settings.environmentIntensity, shadows: { ...draft.lighting.shadows, darkness: shadows.darkness },
  } };
  return { ...draft, appearance: { ...draft.appearance, version: 1, backgroundColor: settings.backgroundColor, skyboxVisible: settings.skyboxVisible,
    exposure: settings.exposure, contrast: settings.contrast, toneMappingEnabled: true, glowIntensity: settings.glowIntensity,
    bloomEnabled: settings.bloomEnabled, bloomWeight: settings.bloomWeight, fogEnabled: settings.fogEnabled,
    fogColor: settings.fogColor, fogStart: settings.fogStart, fogEnd: settings.fogEnd,
  } };
}

export function getLightingManagerEntities(scene: SceneDocument) {
  return scene.entityIds.map(id => scene.entities[id]).filter(entity => entity && !entity.isFolder
    && (entity.components.meshRenderer || entity.components.modelAsset || entity.components.modelGenerator || entity.components.deviceSpawner));
}

/** 只使用运行时提供的未覆盖分类事实求值；旧快照缺少事实时不伪造草稿效果。 */
export function buildLightingManagerRows(scene: SceneDocument, entries: readonly LightingClassificationEntry[], draft: LightingManagerDraft): LightingManagerRow[] {
  const beforePolicy = getLightingManagerPolicy(getSceneLightingConfig(scene).policy);
  const resolveBefore = createSceneLightingPolicyResolver(beforePolicy), resolveDraft = createSceneLightingPolicyResolver(draft.lighting.policy);
  const inventories = new Map<string, Set<string>>();
  for (const raw of entries) {
    const entry = raw as PolicyEntry, context = entry.policyContext;
    if (!context?.resourceIdentity || entry.unmatchedOverride) continue;
    const owner = Object.hasOwn(scene.entities, entry.entityId) ? entry.entityId : context.ownerEntityId ?? context.entityId;
    const key = JSON.stringify([owner, context.resourceIdentity]);
    const values = inventories.get(key) ?? new Set<string>(), nodeKey = context.partKey ?? context.nodeKey;
    if (nodeKey) values.add(normalizeLightingPolicyNodeKey(nodeKey));
    inventories.set(key, values);
  }
  // 在完整分类快照上汇集一次资源节点清单；筛选或翻页不能使现存节点被误报缺失。
  const availableNodes = new Map([...inventories].map(([key, nodes]) => [key, [...nodes]]));
  return entries.map(raw => {
    const entry = raw as PolicyEntry;
    const ownerEntityId = Object.hasOwn(scene.entities, entry.entityId) ? entry.entityId
      : entry.ownerEntityId ?? entry.policyContext?.ownerEntityId ?? entry.entityId;
    const entity = scene.entities[ownerEntityId];
    const provided: LightingPolicyContext | null = entry.policyContext ?? (entry.automaticMobility ? {
      entityId: entry.entityId, ownerEntityId, entity, entities: scene.entities,
      modelAsset: entity?.components.modelAsset, nodeKey: entry.nodeKey, partKey: entry.partKey,
      resourceIdentity: entry.resourceIdentity, motionRole: entry.motionRole, deviceType: entry.deviceType,
      parentDynamic: entry.parentDynamic, entityLighting: entity?.components.lighting,
      automatic: { mobility: entry.automaticMobility, reason: entry.automaticReason ?? entry.reason },
    } satisfies LightingPolicyContext : null);
    const original = provided ? { ...provided,
      ...(Object.hasOwn(scene.entities, entry.entityId) ? { ownerEntityId: entry.entityId } : {}),
      // 文档中的例外是权威值；删除后的显式 undefined 不能回退到尚未刷新的运行时快照。
      ...(entity ? { entity, entities: scene.entities, entityLighting: entity.components.lighting } : {}),
      availableNodeKeys: provided.availableNodeKeys
      ?? availableNodes.get(JSON.stringify([ownerEntityId, provided.resourceIdentity])) } : null;
    const context = original ? { ...original,
      ...(Object.hasOwn(draft.entityLighting, ownerEntityId) ? { entityLighting: draft.entityLighting[ownerEntityId] ?? undefined } : {}),
    } : null;
    const previous = original ? resolveBefore(original) : null;
    const effective = context ? resolveDraft(context) : null;
    return {
      key: entry.key, entityId: entry.entityId, ownerEntityId, entityName: ownerEntityId === '$environment' ? '场景环境' : entity?.name ?? entry.entityId,
      nodeKey: entry.nodeKey, partKey: entry.partKey ?? entry.policyContext?.partKey ?? entry.nodeKey, name: entry.name,
      entry, context, previous, effective,
      changedFields: previous && effective ? LIGHTING_POLICY_FIELDS.filter(field => previous.settings[field] !== effective.settings[field]) : [],
      locked: Boolean(entity && isEntityEffectivelyLocked(scene.entities, entity)),
    };
  });
}

export function getLightingManagerImpact(rows: readonly LightingManagerRow[]) {
  const changed = rows.filter(row => row.changedFields.length);
  const mismatches = new Set<string>(), conflicts = new Set<string>();
  for (const row of rows) {
    for (const issue of row.effective?.mismatches ?? []) mismatches.add(JSON.stringify([issue.ruleId, issue.nodeRuleId, issue.nodeKey, issue.message]));
    for (const issue of row.effective?.conflicts ?? []) conflicts.add(JSON.stringify([row.key, issue.field, issue.reason]));
    if (row.entry.unmatchedOverride) mismatches.add('legacy:' + row.key);
  }
  return {
    affectedEntityCount: new Set(changed.map(row => row.ownerEntityId)).size, affectedNodeCount: changed.length,
    preservedExceptionCount: new Set(rows.filter(row => (row.effective?.preservedExceptionFields.length ?? 0) > 0).map(row => row.ownerEntityId)).size,
    mismatchCount: mismatches.size, conflictCount: conflicts.size,
    pendingCount: rows.filter(row => !row.context && !row.entry.unmatchedOverride).length,
  };
}

export function lightingModelReferenceKey(reference: LightingModelReference): string {
  if (reference.identity) return JSON.stringify(reference.identity);
  return JSON.stringify([reference.sourceUrl ?? '', reference.sourcePath ?? '']);
}

export function getLightingManagerResources(rows: readonly LightingManagerRow[]): LightingManagerResourceOption[] {
  const resources = new Map<string, LightingManagerResourceOption & { entities: Set<string> }>();
  for (const row of rows) {
    if (!row.context?.modelAsset) continue;
    const reference = createLightingModelReference(row.context.modelAsset);
    if (!reference) continue;
    const key = lightingModelReferenceKey(reference), existing = resources.get(key);
    if (existing) { existing.entities.add(row.entityId); existing.count = existing.entities.size; continue; }
    const raw = String(reference.sourcePath ?? reference.sourceUrl ?? '');
    const segments = raw.replace(/\\/g, '/').split('/').filter(Boolean);
    const last = segments.at(-1) ?? row.entityName;
    const name = /^model\.(glb|gltf)$/i.test(last) ? segments.at(-2) ?? row.entityName : last.replace(/\.(glb|gltf)$/i, '');
    resources.set(key, { key, name, reference, count: 1, entities: new Set([row.entityId]) });
  }
  return [...resources.values()].map(({ entities: _entities, ...option }) => option).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
}

export function lightingSelectionKey(selection: LightingManagerSelection): string {
  return selection.kind === 'entity' ? 'entity:' + selection.entityId : 'node:' + selection.key;
}

function inheritedSettings(): EntityLightingSettings {
  return { mobility: 'auto', castShadows: true, receiveShadows: true, bakeIndirect: true, nodeOverrides: {}, inheritPolicy: [...LIGHTING_POLICY_FIELDS] };
}
function valuePatch(values: LightingManagerBulkValues): { values: LightingPolicyValues; inherited: LightingPolicyField[]; touched: LightingPolicyField[] } {
  const explicit: LightingPolicyValues = {}, inherited: LightingPolicyField[] = [], touched: LightingPolicyField[] = [];
  for (const field of LIGHTING_POLICY_FIELDS) {
    const value = values[field];
    if (value === 'unchanged') continue;
    touched.push(field);
    if (value === 'inherit') inherited.push(field);
    else if (field === 'mobility' && (value === 'auto' || value === 'static' || value === 'dynamic')) explicit.mobility = value;
    else if (field !== 'mobility') explicit[field] = value === 'true';
  }
  return { values: explicit, inherited, touched };
}

/** 集中例外只改被选中的实体/节点；保留其他节点和旧例外的原有语义。 */
export function stageLightingManagerExceptions(draft: LightingManagerDraft, rows: readonly LightingManagerRow[],
  selections: readonly LightingManagerSelection[], values: LightingManagerBulkValues, reset = false):
  { ok: true; entityLighting: LightingManagerDraft['entityLighting'] } | { ok: false; message: string } {
  const next = { ...draft.entityLighting }, byKey = new Map(rows.map(row => [row.key, row]));
  const patch = valuePatch(values);
  for (const selection of selections) {
    const row = selection.kind === 'node' ? byKey.get(selection.key) : undefined;
    if (selection.kind === 'node' && row && !Object.hasOwn(draft.baseScene.entities, row.entityId)) {
      return { ok: false, message: row.entityId === '$environment'
        ? '环境部件请使用模型资源或类型规则。' : '生成部件请使用模型资源或类型规则。' };
    }
    // owner 只用于显示和目录继承；临时 cargo 的节点路径不能变成宿主的持久化例外。
    const id = selection.kind === 'entity' ? selection.entityId : row?.entityId;
    const entity = id ? draft.baseScene.entities[id] : null;
    if (!id || !entity) return { ok: false, message: '环境或尚未落盘的部件请通过分类规则设置，不能写入对象例外。' };
    if (entity.isFolder) return { ok: false, message: '场景分组请使用分类规则设置。' };
    if (isEntityEffectivelyLocked(draft.baseScene.entities, entity)) return { ok: false, message: `「${entity.name}」已锁定，请先解锁。` };
    const current = Object.hasOwn(next, id) ? next[id] : entity.components.lighting;
    if (selection.kind === 'entity') {
      const settings = current ? normalizeEntityLightingSettings(current) : inheritedSettings();
      const inherited = new Set(settings.inheritPolicy ?? []);
      for (const field of patch.touched) if (patch.inherited.includes(field)) inherited.add(field); else inherited.delete(field);
      next[id] = reset ? null : { ...settings, ...patch.values, inheritPolicy: [...inherited] };
      continue;
    }
    if (!row) return { ok: false, message: '所选部件已经变化，请重新选择。' };
    if (!reset && values.mobility === 'static' && row.entry.parentDynamic) return { ok: false, message: `「${row.name}」受动态祖先带动，不能标为静态。` };
    const settings = current ? normalizeEntityLightingSettings(current) : inheritedSettings();
    const nodeOverrides = { ...settings.nodeOverrides };
    if (reset) delete nodeOverrides[row.nodeKey];
    else {
      const identity = row.context?.resourceIdentity ?? row.entry.resourceIdentity;
      if (settings.resourceIdentity && identity && settings.resourceIdentity !== identity && Object.keys(nodeOverrides).length) {
        return { ok: false, message: '所选对象已有不同资源身份的部件例外，请先处理失配，或改用资源分类规则。' };
      }
      const original = nodeOverrides[row.nodeKey];
      // 旧节点 auto 表示继承对象，新增显式自动语义不能顺带改变未编辑的字段。
      const inherited = new Set<LightingPolicyField>(original?.inheritPolicy
        ?? LIGHTING_POLICY_FIELDS.filter(field => !original || original[field] === undefined || (field === 'mobility' && original.mobility === 'auto')));
      for (const field of patch.touched) if (patch.inherited.includes(field)) inherited.add(field); else inherited.delete(field);
      const node: LightingNodeOverride = original ? { ...original } : { mobility: 'auto' };
      nodeOverrides[row.nodeKey] = { ...node, ...patch.values, inheritPolicy: [...inherited] };
      if (identity) settings.resourceIdentity = identity;
    }
    next[id] = { ...settings, nodeOverrides };
  }
  return { ok: true, entityLighting: next };
}


export type LightingManagerChangeSummary = {
  categories: string[];
  rulesChanged: boolean;
  exceptionsChanged: boolean;
  giInputChanged: boolean;
  giApplicationChanged: boolean;
  giMessage: string;
};

/** 全局参数不能套用部件规则的影响计数；GI 过期判断始终复用正式输入合同。 */
export function getLightingManagerChangeSummary(draft: LightingManagerDraft): LightingManagerChangeSummary {
  const before = getSceneLightingConfig(draft.baseScene), after = normalizeSceneLightingConfig(draft.lighting);
  const different = (left: unknown, right: unknown) => JSON.stringify(left) !== JSON.stringify(right);
  const appearanceChanged = different(normalizeSceneAppearanceConfig(draft.appearance), getSceneAppearanceConfig(draft.baseScene));
  const physical = (value: SceneLightingConfig) => ({ main: value.main, fill: value.fill, environment: value.environment,
    environmentIntensity: value.environmentIntensity, disabledLightIds: value.disabledLightIds, allowDayNightCycle: value.allowDayNightCycle });
  const physicalChanged = different(physical(before), physical(after));
  const calculation = (value: SceneLightingConfig) => ({ quality: value.bake.quality, atlasSize: value.bake.atlasSize,
    texelsPerMeter: value.bake.texelsPerMeter, probeSpacing: value.bake.probeSpacing, device: value.bake.device, probeVolumes: value.bake.probeVolumes, maxTextureMiB: value.bake.maxTextureMiB });
  const calculationChanged = different(calculation(before), calculation(after));
  const rulesChanged = different(getLightingManagerPolicy(before.policy), getLightingManagerPolicy(after.policy));
  const exceptionsChanged = Object.entries(draft.entityLighting).some(([id, value]) => different(value ?? undefined, draft.baseScene.entities[id]?.components.lighting));
  const shadowsChanged = different(before.shadows, after.shadows)
    || before.bake.cacheStaticShadows !== after.bake.cacheStaticShadows || before.bake.dynamicShadows !== after.bake.dynamicShadows;
  const giApplicationChanged = before.bake.enabled !== after.bake.enabled;
  let giInputChanged = false;
  if (physicalChanged || calculationChanged || rulesChanged || exceptionsChanged) {
    const entities = { ...draft.baseScene.entities };
    for (const [id, lighting] of Object.entries(draft.entityLighting)) {
      const entity = entities[id];
      if (!entity) continue;
      const components = { ...entity.components };
      if (lighting) components.lighting = lighting; else delete components.lighting;
      entities[id] = { ...entity, components };
    }
    const proposed = { ...draft.baseScene, entities, sceneSettings: { ...draft.baseScene.sceneSettings, lighting: after } };
    giInputChanged = getSceneLightingBakeSignature(proposed) !== getSceneLightingBakeSignature(draft.baseScene);
  }
  const categories = [appearanceChanged && '显示效果', physicalChanged && '物理照明', calculationChanged && '烘焙计算',
    rulesChanged && '分类规则', exceptionsChanged && '对象例外', shadowsChanged && '实时阴影', giApplicationChanged && '间接光应用']
    .filter((value): value is string => Boolean(value));
  const giMessage = giInputChanged ? (before.result ? '应用后已有 GI 将过期，需要重新烘焙。' : 'GI 输入将更新，应用后可进行烘焙。')
    : giApplicationChanged ? (after.bake.enabled ? '启用 GI 应用；已有结果仍需通过有效性检查。' : '暂停应用 GI，已有烘焙资产继续保留。')
      : 'GI 输入保持不变；已有结果的有效性不受这些更改影响。';
  return { categories, rulesChanged, exceptionsChanged, giInputChanged, giApplicationChanged, giMessage };
}

export type LightingManagerDiagnostic = {
  id: string;
  kind: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  entityId?: string;
  entityName?: string;
  ownerEntityId?: string;
  nodeKey?: string;
  runtimeNodeKey?: string;
  ruleId?: string;
  nodeRuleId?: string;
  assetId?: string;
  expectedResourceIdentity?: string;
  actualResourceIdentity?: string;
  locatable?: boolean;
  action?: 'retry-assets' | 'retry-preflight';
};

/** 身份参与去重；相同错误文字出现在不同对象上时仍分别可定位。 */
export function buildLightingManagerDiagnostics(rows: readonly LightingManagerRow[], extra: readonly LightingManagerDiagnostic[] = []): LightingManagerDiagnostic[] {
  const diagnostics = new Map(extra.map(issue => [issue.id, issue]));
  const add = (row: LightingManagerRow, value: Omit<LightingManagerDiagnostic, 'id'>) => {
    const diagnostic = { entityId: row.entityId, ownerEntityId: row.ownerEntityId, entityName: row.entityName, runtimeNodeKey: row.nodeKey,
      locatable: !row.entry.unmatchedOverride, ...value };
    const id = JSON.stringify([diagnostic.entityId, diagnostic.kind, diagnostic.ruleId, diagnostic.nodeRuleId, diagnostic.nodeKey, diagnostic.message]);
    diagnostics.set(id, { ...diagnostic, id });
  };
  for (const row of rows) {
    for (const issue of row.effective?.mismatches ?? []) add(row, { ...issue, severity: 'warning',
      ...(issue.kind === 'resource-identity' ? { locatable: false } : {}) });
    for (const issue of row.effective?.conflicts ?? []) add(row, { kind: 'policy-conflict', severity: 'warning', message: issue.reason,
      nodeKey: row.nodeKey, ruleId: issue.ruleId, nodeRuleId: issue.nodeRuleId });
    if (row.entry.unmatchedOverride) add(row, { kind: 'legacy-override', severity: 'warning', nodeKey: row.nodeKey,
      message: '「' + row.entityName + ' / ' + row.name + '」的旧部件例外未匹配当前资源。' });
  }
  return [...diagnostics.values()];
}

/** 只缓存当前管理器会话；照明、曝光、预算等编辑不触发全体部件规则解析。 */
export function createLightingManagerRowsSelector() {
  let previous: { scene: SceneDocument; entries: readonly LightingClassificationEntry[]; policy: SceneLightingConfig['policy'];
    exceptions: LightingManagerDraft['entityLighting']; rows: LightingManagerRow[] } | undefined;
  return (draft: LightingManagerDraft, entries: readonly LightingClassificationEntry[]) => {
    if (previous?.scene === draft.baseScene && previous.entries === entries && previous.policy === draft.lighting.policy
      && previous.exceptions === draft.entityLighting) return previous.rows;
    const rows = buildLightingManagerRows(draft.baseScene, entries, draft);
    previous = { scene: draft.baseScene, entries, policy: draft.lighting.policy, exceptions: draft.entityLighting, rows };
    return rows;
  };
}


/** 目录计数一次汇集，按宿主去重；不为每个分组重复扫描全部部件。 */
export function getLightingManagerScopeCounts(scene: SceneDocument, rows: readonly LightingManagerRow[]): Map<string, number> {
  const scopes = new Map<string, Set<string>>();
  const add = (scope: string, owner: string) => { const owners = scopes.get(scope) ?? new Set<string>(); owners.add(owner); scopes.set(scope, owners); };
  for (const row of rows) {
    const owner = row.ownerEntityId;
    if (row.entry.unmatchedOverride || row.effective?.mismatches.length || row.effective?.conflicts.length) add('issues', owner);
    if (row.effective?.preservedExceptionFields.length) add('exceptions', owner);
    if (row.context?.deviceType) add('type:' + row.context.deviceType, owner);
    const ancestors = new Set(row.context?.ancestorIds ?? []);
    const visited = new Set<string>();
    for (let id = scene.entities[owner]?.parentId; id && !visited.has(id); id = scene.entities[id]?.parentId) { ancestors.add(id); visited.add(id); }
    for (const id of ancestors) add('group:' + id, owner);
  }
  return new Map([...scopes].map(([scope, owners]) => [scope, owners.size]));
}

/** 隐藏页保留组件与本地状态，暂停父级快照或其它页草稿触发的计算。 */
export function areLightingManagerPagePropsEqual<T extends { active?: boolean }>(previous: T, next: T): boolean {
  return next.active === false || Object.keys(next).every(key => previous[key as keyof T] === next[key as keyof T]);
}
