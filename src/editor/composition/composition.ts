import { validateComposition } from '../../../electron/shared/compositionValidation';
export { validateComposition } from '../../../electron/shared/compositionValidation';
import { Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import type { CompositionDefinition, CompositionInstance, CompositionTransform } from '../../../electron/shared/compositionTypes';
import type { Entity } from '../model/Entity';
import type { SceneDocument } from '../model/SceneDocument';

export const COMPOSITION_DRAG = 'application/x-zending-composition';
export const COMPOSITION_SELECTION_DRAG = 'application/x-zending-composition-selection';
export const MAX_COMPOSITION_NODES = 4096;
const identity = (): CompositionTransform => ({ position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } });
const uid = () => crypto.randomUUID();
const round = (x: number) => Math.round(x * 1e6) / 1e6;
const vec = (v: { x: number; y: number; z: number }) => ({ x: round(v.x), y: round(v.y), z: round(v.z) });
const vector = (v: {x:number;y:number;z:number}) => new Vector3(v.x,v.y,v.z);
const quaternion = (t: CompositionTransform) => Quaternion.FromEulerAngles(t.rotation.x,t.rotation.y,t.rotation.z);
const rotate = (v: Vector3, q: Quaternion) => v.applyRotationQuaternion(q);
// 根仅允许等比缩放，直接按 TRS 计算，避免大世界坐标经 Float32 矩阵丢失成员间的小距离。
function toLocal(t: CompositionTransform, frame: CompositionTransform): CompositionTransform {
  const inverse = quaternion(frame).conjugate();
  const result = { position: vec(rotate(vector(t.position).subtract(vector(frame.position)), inverse).scale(1 / frame.scale.x)),
    rotation: vec(inverse.multiply(quaternion(t)).normalize().toEulerAngles()), scale: vec(vector(t.scale).scale(1 / frame.scale.x)) };
  assertTransform(result); return result;
}
function toWorld(t: CompositionTransform, frame: CompositionTransform): CompositionTransform {
  const q = quaternion(frame);
  const result = { position: vec(rotate(vector(t.position).scale(frame.scale.x), q).add(vector(frame.position))),
    rotation: vec(q.multiply(quaternion(t)).normalize().toEulerAngles()), scale: vec(vector(t.scale).scale(frame.scale.x)) };
  assertTransform(result); return result;
}
function assertTransform(t: CompositionTransform) {
  if (!t || ![t.position, t.rotation, t.scale].every(v => v && [v.x, v.y, v.z].every(Number.isFinite))
    || [t.scale.x, t.scale.y, t.scale.z].some(v => Math.abs(v) < 1e-6)) throw new Error('组合变换无效或缩放为零。');
}
function assertFrame(t: CompositionTransform) {
  assertTransform(t);
  if (t.scale.x <= 0 || Math.abs(t.scale.x - t.scale.y) > 1e-6 || Math.abs(t.scale.x - t.scale.z) > 1e-6) throw new Error('组合整体仅支持正数等比缩放。');
}
export function normalizeCompositionInstance(value: unknown, frame?: CompositionTransform): CompositionInstance | undefined {
  if (value === undefined) return undefined;
  if (frame) assertFrame(frame);
  const v = value as CompositionInstance;
  if (!v || v.schemaVersion !== 1 || ![v.instanceId, v.libraryId, v.revision].every(s => typeof s === 'string' && s.length > 0 && s.length < 256)) throw new Error('组合实例信息无效。');
  for (const k of ['resourceId', 'sourceKey', 'packagePath', 'contentSha256'] as const) {
    if (v[k] !== undefined && (typeof v[k] !== 'string' || v[k]!.length > 4096)) throw new Error('组合来源信息无效。');
  }
  return { schemaVersion: 1, instanceId: v.instanceId, libraryId: v.libraryId, revision: v.revision,
    resourceId: v.resourceId, resourceType: 'ENV_MODEL', sourceKey: v.sourceKey, packagePath: v.packagePath, contentSha256: v.contentSha256 };
}


export function compositionDescendants(scene: SceneDocument, ids: readonly string[]): Entity[] {
  const result: Entity[] = [], visited = new Set<string>();
  const visit = (id: string, depth: number) => {
    if (depth > 64 || result.length >= MAX_COMPOSITION_NODES + 1) throw new Error('组合层级或数量超过限制。');
    if (visited.has(id)) return;
    const e = scene.entities[id]; if (!e) throw new Error('组合成员已不存在。');
    visited.add(id); result.push(e); for (const child of e.childrenIds) visit(child, depth + 1);
  };
  ids.forEach(id => visit(id, 0));
  for (const e of Object.values(scene.entities)) {
    if (e.components.locator?.builtInBinding && visited.has(e.components.locator.builtInBinding.hostEntityId)) visit(e.id, 0);
  }
  return result;
}

export type CompositionCapture = { definition: CompositionDefinition; frame: CompositionTransform; sourceIds: string[]; rootId?: string; warnings: string[] };

/** 模板不保存世界摆放和设备状态；原场景的业务绑定保持原样。 */
export function captureComposition(scene: SceneDocument, selected: readonly string[], name: string, anchor?: { x: number; y: number; z: number }): CompositionCapture {
  const existingRoot = selected.length === 1 && scene.entities[selected[0]]?.composition ? scene.entities[selected[0]] : undefined;
  const sources = compositionDescendants(scene, selected).filter(e => e.id !== existingRoot?.id);
  const sourceIds = sources.map(e => e.id), sourceSet = new Set(sourceIds);
  for (const e of sources) {
    let p: Entity | undefined = e;
    while (p) { if (p.locked) throw new Error(`组合包含锁定对象：${p.name}`); p = p.parentId ? scene.entities[p.parentId] : undefined; }
  }
  const leaves = sources.filter(e => !e.isFolder);
  const frame = structuredClone(existingRoot?.components.transform ?? { ...identity(), position: anchor ?? {
    x: (Math.min(...leaves.map(e => e.components.transform.position.x)) + Math.max(...leaves.map(e => e.components.transform.position.x))) / 2,
    y: Math.min(...leaves.map(e => e.components.transform.position.y)),
    z: (Math.min(...leaves.map(e => e.components.transform.position.z)) + Math.max(...leaves.map(e => e.components.transform.position.z))) / 2,
  } });
  assertFrame(frame);
  const warnings: string[] = [];
  const ids = new Map(sources.map(e => [e.id, e.compositionNodeId ?? e.id]));
  const nodes = sources.map(e => {
    const components = structuredClone(e.components);
    const supported = new Set(['transform', 'modelAsset', 'meshRenderer', 'locator', 'modelArrayInstance']);
    for (const key of Object.keys(components)) if (!supported.has(key)) {
      warnings.push(`${e.name}：${key} 为场景配置，复用后需重新配置。`);
      delete (components as unknown as Record<string, unknown>)[key];
    }
    components.transform = e.isFolder ? identity() : toLocal(components.transform, frame);
    if (components.modelAsset) {
      components.modelAsset.assetCode = '';
      delete components.modelAsset.sourceSnapshot;
      if (components.modelAsset.dataDrivenConfig?.device) delete components.modelAsset.dataDrivenConfig.device.defaultAssetCode;
    }
    if (components.modelArrayInstance) {
      const mapped = ids.get(components.modelArrayInstance.sourceEntityId);
      if (mapped) components.modelArrayInstance.sourceEntityId = mapped;
      else delete components.modelArrayInstance;
    }
    if (components.locator) {
      components.locator.assetId = ''; components.locator.deviceAssetCode = ''; components.locator.aisleCode = '';
      delete components.locator.fetchDrive;
      const binding = components.locator.builtInBinding;
      if (binding && ids.has(binding.hostEntityId)) binding.hostEntityId = ids.get(binding.hostEntityId)!;
      else throw new Error(`附属货格“${e.name}”缺少组合内宿主。`);
    }
    return { id: ids.get(e.id)!, name: e.name, isFolder: !!e.isFolder, visible: e.visible !== false, locked: false,
      parentId: e.parentId && sourceSet.has(e.parentId) ? ids.get(e.parentId)! : null,
      childrenIds: e.childrenIds.filter(id => sourceSet.has(id)).map(id => ids.get(id)!), components };
  });
  const definition: CompositionDefinition = { schemaVersion: 1, name: name.trim(), nodes };
  validateComposition(definition);
  return { definition, frame, sourceIds, rootId: existingRoot?.id, warnings: [...new Set(warnings)] };
}

export function instantiateComposition(definition: CompositionDefinition, position: { x: number; y: number; z: number }, source?: Omit<CompositionInstance, 'schemaVersion' | 'instanceId'>) {
  validateComposition(definition);
  const ids = new Map(definition.nodes.map(n => [n.id, uid()])), rootId = uid();
  const frame = { ...identity(), position: { ...position } }; assertFrame(frame);
  const entities: Entity[] = definition.nodes.map(n => {
    const e = structuredClone(n) as Entity, id = ids.get(n.id)!;
    e.id = id; e.compositionNodeId = n.id; e.parentId = n.parentId ? ids.get(n.parentId)! : rootId;
    e.childrenIds = n.childrenIds.map(id => ids.get(id)!);
    e.components.transform = e.isFolder ? identity() : toWorld(e.components.transform, frame);
    if (e.components.modelAsset) e.components.modelAsset.assetCode = `model_${id.replaceAll('-', '')}`;
    if (e.components.modelArrayInstance) e.components.modelArrayInstance.sourceEntityId = ids.get(e.components.modelArrayInstance.sourceEntityId)!;
    if (e.components.locator?.builtInBinding) {
      e.components.locator.builtInBinding.hostEntityId = ids.get(e.components.locator.builtInBinding.hostEntityId)!;
      e.components.locator.assetId = `model_${e.components.locator.builtInBinding.hostEntityId.replaceAll('-', '')}`;
    }
    return e;
  });
  const root: Entity = { id: rootId, name: definition.name, isFolder: true, visible: true, locked: false, parentId: null,
    childrenIds: entities.filter(e => e.parentId === rootId).map(e => e.id), components: { transform: frame },
    composition: { schemaVersion: 1, instanceId: uid(), libraryId: source?.libraryId ?? 'local', revision: source?.revision ?? '1', ...source } };
  return { root, entities };
}

export function groupComposition(scene: SceneDocument, capture: CompositionCapture, source: Omit<CompositionInstance, 'schemaVersion' | 'instanceId'>): SceneDocument {
  const ids = new Set(capture.sourceIds), rootId = capture.rootId ?? uid();
  const roots = capture.sourceIds.filter(id => !ids.has(scene.entities[id].parentId ?? ''));
  const entities = { ...scene.entities };
  for (const id of capture.sourceIds) {
    const e = entities[id]; entities[id] = { ...e, compositionNodeId: e.compositionNodeId ?? e.id,
      parentId: roots.includes(id) ? rootId : e.parentId };
  }
  for (const e of Object.values(entities)) if (!ids.has(e.id) && e.id !== rootId && e.childrenIds.some(id => ids.has(id))) {
    entities[e.id] = { ...e, childrenIds: e.childrenIds.filter(id => !ids.has(id)) };
  }
  const oldRoot = entities[rootId];
  entities[rootId] = { id: rootId, name: oldRoot?.name ?? capture.definition.name, isFolder: true, visible: oldRoot?.visible ?? true, locked: false,
    parentId: oldRoot?.parentId ?? null, childrenIds: roots, components: { transform: capture.frame },
    composition: { schemaVersion: 1, instanceId: oldRoot?.composition?.instanceId ?? uid(), ...source } };
  return { ...scene, entities, entityIds: scene.entityIds.includes(rootId) ? scene.entityIds : [...scene.entityIds, rootId], selectedEntityId: rootId };
}

export function transformComposition(scene: SceneDocument, id: string, after: CompositionTransform): SceneDocument {
  const root = scene.entities[id]; if (!root?.composition) throw new Error('请选择组合模型。');
  assertFrame(after);
  const entities = { ...scene.entities };
  for (const e of compositionDescendants(scene, [id])) {
    if (e.locked) throw new Error('组合含锁定成员，无法整体变换。');
    if (!e.isFolder || e.composition) entities[e.id] = { ...e, components: { ...e.components, transform: toWorld(toLocal(e.components.transform, root.components.transform), after) } };
  }
  entities[id] = { ...entities[id], components: { ...entities[id].components, transform: structuredClone(after) } };
  return { ...scene, entities };
}

export function findCompositionRoot(scene: SceneDocument, entityId: string): string | null {
  let current: Entity | undefined = scene.entities[entityId], root: string | null = null;
  for (let depth = 0; current && depth < 65; depth++) {
    if (current.composition) root = current.id;
    current = current.parentId ? scene.entities[current.parentId] : undefined;
  }
  return root;
}

/** 普通群组 Gizmo 提交后同步组合基准，避免再次存库时写入整体世界位移。 */
export function updateCompositionFrames(before: SceneDocument, after: SceneDocument, changedIds: readonly string[]): SceneDocument {
  const changed = new Set(changedIds), entities = { ...after.entities };
  for (const root of Object.values(before.entities)) {
    if (!root.composition) continue;
    const leaves = compositionDescendants(before, [root.id]).filter(e => !e.isFolder);
    if (!leaves.length || leaves.some(e => !changed.has(e.id))) continue;
    const first = leaves[0], next = after.entities[first.id]; if (!next) continue;
    const beforeTransform = first.components.transform, afterTransform = next.components.transform;
    const rotation = quaternion(afterTransform).multiply(quaternion(beforeTransform).conjugate()).normalize();
    const ratio = afterTransform.scale.x / beforeTransform.scale.x;
    const frame = root.components.transform;
    const transformed = { position: vec(rotate(vector(frame.position).subtract(vector(beforeTransform.position)).scale(ratio), rotation).add(vector(afterTransform.position))),
      rotation: vec(rotation.multiply(quaternion(frame)).normalize().toEulerAngles()), scale: vec(vector(frame.scale).scale(ratio)) };
    entities[root.id] = { ...entities[root.id], components: { ...entities[root.id].components,
      transform: transformed } };
  }
  return { ...after, entities };
}

/** 显式采用库版本：保留整体位姿及兼容成员的实例身份，内部布局按模板重建。 */
export function planCompositionUpgrade(scene: SceneDocument, rootId: string, definition: CompositionDefinition,
  source: Omit<CompositionInstance, 'schemaVersion' | 'instanceId'>) {
  const oldRoot = scene.entities[rootId]; if (!oldRoot?.composition) throw new Error('请选择组合模型。');
  const oldMembers = compositionDescendants(scene, [rootId]).filter(e => e.id !== rootId);
  if (oldRoot.locked || oldMembers.some(e => e.locked)) throw new Error('组合含锁定成员，不能更新。');
  const memberIds = new Set(oldMembers.map(e => e.id));
  if (Object.values(scene.entities).some(e => !memberIds.has(e.id) && memberIds.has(e.components.modelArrayInstance?.sourceEntityId ?? ''))) throw new Error('组合成员存在组外阵列引用，请通过重新拖入组合创建独立实例。');
  const created = instantiateComposition(definition, oldRoot.components.transform.position, source);
  const oldByNode = new Map(oldMembers.map(e => [e.compositionNodeId ?? e.id, e]));
  const remap = new Map<string,string>([[created.root.id, rootId]]), retained = new Map<string,Entity>();
  for (const entity of created.entities) {
    const old = oldByNode.get(entity.compositionNodeId!);
    const compatible = old && !!old.isFolder === !!entity.isFolder
      && !!old.components.modelAsset === !!entity.components.modelAsset
      && old.components.modelAsset?.dataDrivenConfig?.device?.devType === entity.components.modelAsset?.dataDrivenConfig?.device?.devType;
    if (compatible) { remap.set(entity.id, old.id); retained.set(entity.id, old); }
    else remap.set(entity.id, entity.id);
  }
  const newMembers = created.entities.map(entity => {
    const old = retained.get(entity.id), components = structuredClone(entity.components);
    if (!entity.isFolder) components.transform = toWorld(toLocal(components.transform, created.root.components.transform), oldRoot.components.transform);
    if (old?.components.modelAsset && components.modelAsset) components.modelAsset.assetCode = old.components.modelAsset.assetCode;
    if (old?.components.telemetryBinding) components.telemetryBinding = structuredClone(old.components.telemetryBinding);
    if (old?.components.clickEventBinding) components.clickEventBinding = structuredClone(old.components.clickEventBinding);
    if (components.modelArrayInstance) components.modelArrayInstance.sourceEntityId = remap.get(components.modelArrayInstance.sourceEntityId)!;
    if (components.locator?.builtInBinding) {
      components.locator.builtInBinding.hostEntityId = remap.get(components.locator.builtInBinding.hostEntityId)!;
      if (old?.components.locator) {
        components.locator.deviceAssetCode = old.components.locator.deviceAssetCode;
        components.locator.aisleCode = old.components.locator.aisleCode;
      }
    }
    return { ...entity, id: remap.get(entity.id)!, parentId: remap.get(entity.parentId!)!, childrenIds: entity.childrenIds.map(id => remap.get(id)!), components };
  });
  const newById = new Map(newMembers.map(e => [e.id, e]));
  for (const entity of newMembers) if (entity.components.locator?.builtInBinding) {
    const host = newById.get(entity.components.locator.builtInBinding.hostEntityId);
    if (host?.components.modelAsset) entity.components.locator.assetId = host.components.modelAsset.assetCode;
  }
  const root: Entity = { ...oldRoot, childrenIds: created.root.childrenIds.map(id => remap.get(id)!),
    composition: { ...created.root.composition!, instanceId: oldRoot.composition.instanceId } };
  const oldIds = new Set([rootId, ...oldMembers.map(e => e.id)]), replacement = [root,...newMembers];
  const entities = Object.fromEntries(Object.entries(scene.entities).filter(([id]) => !oldIds.has(id)));
  replacement.forEach(entity => { entities[entity.id] = entity; });
  const after: SceneDocument = { ...scene, entities, entityIds: scene.entityIds.flatMap(id => id === rootId ? replacement.map(e => e.id) : oldIds.has(id) ? [] : [id]), selectedEntityId: rootId };
  return { scene: after, added: newMembers.filter(e => !oldIds.has(e.id)).map(e => e.name),
    removed: oldMembers.filter(e => !newById.has(e.id)).map(e => e.name), retained: retained.size };
}
