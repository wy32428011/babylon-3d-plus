import { Node } from '@babylonjs/core/node.js';
import { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh.js';
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { InstancedMesh } from '@babylonjs/core/Meshes/instancedMesh.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import { Matrix, Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { Observable } from '@babylonjs/core/Misc/observable.js';
import { BoundingInfo } from '@babylonjs/core/Culling/boundingInfo.js';
import { BoundingBox } from '@babylonjs/core/Culling/boundingBox.js';
import type { Scene } from '@babylonjs/core/scene.js';
import type { Geometry } from '@babylonjs/core/Meshes/geometry.js';
import type { Material } from '@babylonjs/core/Materials/material.js';
import { hasTargetModelEffectSuspensionCallbacks, isTargetModelEffectSuspended, suspendTargetModelEffects } from '../effects/TargetModelEffects';
import { refreshDetachedSourceMeshes } from '../refreshDetachedInstanceSourceMaterials';
import type { LoadedModelRuntimeAssets } from './sceneRuntimeTypes';

type SharedAssets = Extract<LoadedModelRuntimeAssets, { kind: 'shared-instance' }>;
type Shape = { object: object; prototype: object | null; entries: Map<PropertyKey, PropertyDescriptor> };
function captureShape(object: object): Shape {
  return { object, prototype: Object.getPrototypeOf(object), entries: new Map(Reflect.ownKeys(object).map(key => [key, Object.getOwnPropertyDescriptor(object, key)!])) };
}
const shapes: Shape[] = [];
const visited = new Set<object>();
for (const type of [Node, TransformNode, AbstractMesh, Mesh, InstancedMesh, Matrix, Vector3, Quaternion, Observable, BoundingInfo, BoundingBox]) {
  for (let prototype: object | null = type.prototype; prototype && !visited.has(prototype); prototype = Object.getPrototypeOf(prototype)) {
    visited.add(prototype); shapes.push(captureShape(prototype));
  }
}
function standardLibrary(): boolean {
  return shapes.every(shape => Object.getPrototypeOf(shape.object) === shape.prototype && Reflect.ownKeys(shape.object).length === shape.entries.size
    && [...shape.entries].every(([key, before]) => {
      const next = Object.getOwnPropertyDescriptor(shape.object, key);
      return !!next && next.value === before.value && next.get === before.get && next.set === before.set
        && next.enumerable === before.enumerable && next.configurable === before.configurable && next.writable === before.writable;
    }));
}
const methods = ['getChildren', 'getDescendants', 'isDisposed', 'setEnabled', 'isEnabled', 'getPivotMatrix', 'setPivotMatrix', 'computeWorldMatrix'] as const;
const observers = ['onDisposeObservable', 'onEnabledStateChangedObservable', 'onAfterWorldMatrixUpdateObservable',
  'onBeforeRenderObservable', 'onAfterRenderObservable', 'onBeforeDrawObservable', 'onAfterDrawObservable', 'onMaterialChangedObservable'] as const;
const meshFields = ['isVisible', 'isPickable', 'layerMask', 'alphaIndex', 'renderingGroupId', 'renderOutline', 'outlineWidth', 'renderOverlay', 'overlayAlpha'] as const;
const sourceMethods = ['getClassName', 'getScene', 'getTotalVertices', 'getLODLevels', 'getBoundingInfo', 'getAnimationRanges', 'createInstance', 'clone'] as const;
const nodeAccessors = ['position', 'rotation', 'scaling', 'rotationQuaternion', 'parent', 'isWorldMatrixFrozen', 'billboardMode', 'infiniteDistance',
  'sourceMesh', 'skeleton', 'morphTargetManager', 'geometry', 'material', 'visibility', 'hasBoundingInfo', 'edgesRenderer', 'layerMask', 'onClonedObservable'] as const;
const vectorMethods = ['asArray', 'clone', 'copyFrom', 'copyFromFloats'] as const;
const matrixMethods = ['asArray', 'clone', 'copyFrom', 'copyToArray', 'isIdentity', 'invertToRef', 'markAsUpdated'] as const;

function inheritedApi(object: object, keys: readonly PropertyKey[]): boolean {
  return keys.every(key => !Object.hasOwn(object, key));
}
function dataProperties(object: object, keys: readonly PropertyKey[]): boolean {
  return keys.every(key => { const property = Object.getOwnPropertyDescriptor(object, key); return !property || 'value' in property; });
}
/** 只认证本池实际调用的公开API；先查覆盖再调用，拒绝分支不能执行未知getter/callback。 */
function standardMath(value: object | null, prototype: object, keys: readonly PropertyKey[]): boolean {
  return !!value && Object.getPrototypeOf(value) === prototype && inheritedApi(value, keys);
}
function standardVector(value: Vector3): boolean { return standardMath(value, Vector3.prototype, vectorMethods); }
function standardMatrix(value: Matrix): boolean { return standardMath(value, Matrix.prototype, matrixMethods); }
function unobserved<T>(observable: Observable<T>): boolean {
  return Object.getPrototypeOf(observable) === Observable.prototype && inheritedApi(observable, ['hasObservers']) && !observable.hasObservers();
}
type MeshState = {
  mesh: AbstractMesh; source: Mesh; geometry: Geometry | null; material: Material | null;
  fields: Map<typeof meshFields[number], unknown>; visibility: number; edges: AbstractMesh['edgesRenderer'];
};
type SourceNodeState = { node: TransformNode; parent: Node | null; children: Node[]; name: string; id: string; metadata: unknown;
  values: unknown[]; metadataCopied: boolean; geometry?: Geometry | null; material?: Material | null };
type NodeState = {
  node: TransformNode; children: Node[]; parent: Node | null; name: string; id: string; metadata: unknown;
  position: Vector3; rotation: Vector3; scaling: Vector3; quaternion: Quaternion | null; pivot: Matrix; postMultiply: boolean;
  positionObject: Vector3; rotationObject: Vector3; scalingObject: Vector3; enabled: boolean; billboard: number; infiniteDistance: boolean;
  mesh?: MeshState;
};
export type GeneratedCargoPoolEntry = {
  readonly generatorId: string; readonly key: string; readonly assets: SharedAssets;
  readonly nodes: readonly NodeState[]; readonly sourceNodes: readonly SourceNodeState[]; state: 'active' | 'idle' | 'taken' | 'disposed'; releases: Array<() => void>;
};
export type GeneratedCargoPoolOptions = { maxIdlePerKey?: number; maxIdleEntries?: number; maxIdleNodes?: number };

function count(value: number | undefined, fallback: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 0) throw new RangeError('货物池容量必须是有限非负整数。');
  return result;
}
function standardNode(node: Node, inspectObservers = true): node is TransformNode {
  const prototype = Object.getPrototypeOf(node);
  if (![TransformNode.prototype, Mesh.prototype, InstancedMesh.prototype].includes(prototype)) return false;
  for (const key of methods) if (Object.hasOwn(node, key)) return false;
  if (node.isDisposed()) return false;
  for (const key of ['name', 'id', 'metadata']) {
    const property = Object.getOwnPropertyDescriptor(node, key);
    if (!property || !('value' in property) || !property.writable) return false;
  }
  if (!inheritedApi(node, nodeAccessors) || !dataProperties(node, ['animations', 'actionManager', 'subMeshes', ...meshFields])) return false;
  const transform = node as TransformNode;
  if (transform.isWorldMatrixFrozen || transform.animations.length) return false;
  for (const key of inspectObservers ? observers : []) {
    const property = Object.getOwnPropertyDescriptor(node, key);
    if (property && !('value' in property)) return false;
    const observable = property?.value ?? Reflect.get(node, key);
    if (observable && !unobserved(observable)) return false;
  }
  const quaternion = transform.rotationQuaternion;
  return [transform.position, transform.rotation, transform.scaling].every(standardVector)
    && (quaternion == null || standardMath(quaternion, Quaternion.prototype, ['asArray', 'clone'])) && standardMatrix(transform.getPivotMatrix());
}
function sourceOf(mesh: AbstractMesh): Mesh | null {
  if (Object.hasOwn(mesh, 'sourceMesh')) return null;
  const source = mesh instanceof InstancedMesh ? mesh.sourceMesh : mesh instanceof Mesh ? mesh : null;
  if (!source || Object.getPrototypeOf(source) !== Mesh.prototype || !inheritedApi(source, ['isDisposed', ...sourceMethods, ...nodeAccessors])
    || !dataProperties(source, ['animations']) || source.isDisposed()
    || source.skeleton || source.morphTargetManager || source.animations.length || source.getLODLevels().length) return null;
  // 正常共享加载器只把无几何包装Mesh克隆；独立几何Mesh代表其它实例化/所有权路径。
  if (!(mesh instanceof InstancedMesh) && source.getTotalVertices() > 0) return null;
  return source;
}
/** 原生实例化会从模板重新复制这些输入。模板被其它所有者更新后只能新建，不能把旧池基线写回模板。 */
function sourceValues(node: TransformNode): unknown[] | null {
  const quaternion = node.rotationQuaternion;
  const values: unknown[] = [...node.position.asArray(), ...node.rotation.asArray(), ...node.scaling.asArray(),
    !!quaternion, ...(quaternion?.asArray() ?? []), ...node.getPivotMatrix().asArray(), node.infiniteDistance, node.billboardMode, node.isEnabled(false)];
  if (node instanceof Mesh) {
    values.push(node.visibility, Object.getOwnPropertyDescriptor(node, '_unIndexed')?.value);
    if (node.hasBoundingInfo) {
      const bounds = node.getBoundingInfo();
      if (!bounds || Object.getPrototypeOf(bounds) !== BoundingInfo.prototype || !inheritedApi(bounds, ['minimum', 'maximum'])
        || !dataProperties(bounds, ['boundingBox'])) return null;
      const box = bounds.boundingBox;
      if (!box || Object.getPrototypeOf(box) !== BoundingBox.prototype || !dataProperties(box, ['minimum', 'maximum'])
        || !standardVector(box.minimum) || !standardVector(box.maximum)) return null;
      values.push(...bounds.minimum.asArray(), ...bounds.maximum.asArray());
    }
    const parts = node.subMeshes;
    if (parts) {
      if (Object.getPrototypeOf(parts) !== Array.prototype || !inheritedApi(parts, ['flatMap', Symbol.iterator])) return null;
      for (let index = 0; index < parts.length; index++) {
        const part = Object.getOwnPropertyDescriptor(parts, index)?.value;
        if (!part || !['materialIndex', 'verticesStart', 'verticesCount', 'indexStart', 'indexCount'].every(key => {
          const property = Object.getOwnPropertyDescriptor(part, key); return !!property && 'value' in property;
        })) return null;
      }
    }
    values.push(...(node.subMeshes ?? []).flatMap(part => [part, part.materialIndex, part.verticesStart, part.verticesCount, part.indexStart, part.indexCount]));
  }
  return values;
}
function standardSource(node: Node, metadataCopied: boolean): node is TransformNode {
  if (!standardNode(node, false)) return false;
  if (!inheritedApi(node, sourceMethods)) return false;
  const cloned = node.onClonedObservable;
  if (!unobserved(cloned)) return false;
  const metadata = Object.getOwnPropertyDescriptor(node, 'metadata')!.value;
  // wrapper的原生clone可能读取metadata.clone/slice执行未知代码；不能额外探测opaque对象来认证。
  // 物理Mesh→InstancedMesh不复制metadata，仅按引用检测换代，不触发其Proxy/getter。
  return !metadataCopied || metadata == null;
}
function captureSourceNodes(nodes: readonly NodeState[], maxNodes: number): SourceNodeState[] | null {
  const roots = new Set<Node>(), sourceNodes: SourceNodeState[] = [], seen = new Set<Node>();
  const physicalSources = new Set(nodes.flatMap(state => state.mesh?.mesh instanceof InstancedMesh ? [state.mesh.source] : []));
  for (const state of nodes) {
    if (!state.mesh || state.mesh.source === state.mesh.mesh) continue;
    let root: Node = state.mesh.source; const parents = new Set<Node>();
    while (true) {
      if (![TransformNode.prototype, Mesh.prototype, InstancedMesh.prototype].includes(Object.getPrototypeOf(root))
        || Object.hasOwn(root, 'parent') || parents.has(root)) return null;
      const parent = root.parent; if (!parent) break;
      parents.add(root); root = parent;
    }
    roots.add(root);
  }
  const visit = (node: Node): boolean => {
    const metadataCopied = !physicalSources.has(node as Mesh);
    if (seen.has(node) || !standardSource(node, metadataCopied)) return false;
    seen.add(node); const children = node.getChildren(undefined, true);
    const values = sourceValues(node); if (!values) return false;
    sourceNodes.push({ node, parent: node.parent, children, name: node.name, id: node.id,
      metadata: Object.getOwnPropertyDescriptor(node, 'metadata')!.value, metadataCopied, values,
      ...(node instanceof Mesh ? { geometry: node.geometry, material: node.material } : {}) });
    return sourceNodes.length <= maxNodes && children.every(visit);
  };
  return [...roots].every(visit) ? sourceNodes : null;
}
function unchangedSources(states: readonly SourceNodeState[]): boolean {
  return states.every(state => {
    const node = state.node;
    if (!standardSource(node, state.metadataCopied) || node.parent !== state.parent || !sameOrder(node.getChildren(undefined, true), state.children)
      || node.name !== state.name || node.id !== state.id || Object.getOwnPropertyDescriptor(node, 'metadata')!.value !== state.metadata) return false;
    if (node instanceof Mesh && (node.geometry !== state.geometry || node.material !== state.material)) return false;
    const values = sourceValues(node);
    return !!values && values.length === state.values.length && values.every((value, index) => Object.is(value, state.values[index]));
  });
}
function sameOrder(actual: readonly Node[], expected: readonly Node[]): boolean {
  return actual.length === expected.length && actual.every((node, index) => node === expected[index]);
}

/** 只保留标准静态导入资源；cargo/owner/ModelRuntimeEntry及其contentRoot始终按原生命周期新建/释放。 */
export class GeneratedCargoInstancePool {
  private enabled = true;
  private readonly idle: GeneratedCargoPoolEntry[] = [];
  private readonly owned = new WeakSet<GeneratedCargoPoolEntry>();
  private readonly limits: Required<GeneratedCargoPoolOptions>;
  private readonly counters = { hits: 0, misses: 0, retained: 0, rejected: 0, evicted: 0, resets: 0, resetMs: 0 };
  private readonly rejectionReasons = new Map<string, number>();

  constructor(private readonly scene: Scene, options: GeneratedCargoPoolOptions = {}) {
    this.limits = { maxIdlePerKey: count(options.maxIdlePerKey, 8), maxIdleEntries: count(options.maxIdleEntries, 32), maxIdleNodes: count(options.maxIdleNodes, 4096) };
  }

  getMetrics() {
    return { enabled: this.enabled, ...this.counters, idleEntries: this.idle.length,
      idleNodes: this.idle.reduce((sum, entry) => sum + entry.nodes.length, 0), rejectionReasons: Object.fromEntries(this.rejectionReasons) };
  }
  recordRejection(reason: string): void { this.reject(reason); }
  setEnabled(enabled: boolean): void { this.enabled = enabled; if (!enabled) this.clear(); }

  /** 在原加载器新建资源后、任何业务metadata/父节点/特效写入前捕获，不枚举或序列化未知metadata内容。 */
  capture(generatorId: string, key: string, assets: LoadedModelRuntimeAssets): GeneratedCargoPoolEntry | null {
    if (!this.enabled) return null;
    if (assets.kind !== 'shared-instance' || assets.handle.kind !== 'shared-instance' || assets.handle.animationGroups.length || !standardLibrary()) {
      this.reject('non-static-resource'); return null;
    }
    const nodes: NodeState[] = [], seen = new Set<Node>();
    const visit = (node: Node): boolean => {
      if (seen.has(node) || !standardNode(node)) return false;
      seen.add(node);
      const children = node.getChildren(undefined, true);
      const metadata = Object.getOwnPropertyDescriptor(node, 'metadata')!.value;
      const state: NodeState = { node, children, parent: node.parent, name: node.name, id: node.id, metadata,
        position: node.position.clone(), rotation: node.rotation.clone(), scaling: node.scaling.clone(), quaternion: node.rotationQuaternion?.clone() ?? null,
        pivot: node.getPivotMatrix().clone(), postMultiply: Object.getOwnPropertyDescriptor(node, '_postMultiplyPivotMatrix')?.value === true,
        positionObject: node.position, rotationObject: node.rotation, scalingObject: node.scaling, enabled: node.isEnabled(false),
        billboard: node.billboardMode, infiniteDistance: node.infiniteDistance };
      if (node instanceof AbstractMesh) {
        const source = sourceOf(node);
        if (!source || node.actionManager || node.edgesRenderer || isTargetModelEffectSuspended(node) || hasTargetModelEffectSuspensionCallbacks(node)) return false;
        state.mesh = { mesh: node, source, geometry: source.geometry, material: source.material,
          fields: new Map(meshFields.map(field => [field, node[field]])), visibility: node.visibility, edges: node.edgesRenderer };
      }
      nodes.push(state);
      return nodes.length <= this.limits.maxIdleNodes && children.every(visit);
    };
    if (!assets.rootNodes.length || assets.rootNodes.some(root => Object.hasOwn(root, 'parent') || root.parent !== null) || !assets.rootNodes.every(visit)) {
      this.reject('unknown-node-ownership'); return null;
    }
    const sourceNodes = captureSourceNodes(nodes, this.limits.maxIdleNodes);
    if (!sourceNodes) { this.reject('unknown-source-clone-input'); return null; }
    const entry: GeneratedCargoPoolEntry = { generatorId, key, assets, nodes, sourceNodes, state: 'active', releases: [] };
    this.owned.add(entry); return entry;
  }

  /** 成功后所有权由当前model移交本池；拒绝时仍由原调用方按旧路径dispose。 */
  put(entry: GeneratedCargoPoolEntry, parent: TransformNode): boolean {
    if (!this.enabled || !this.owned.has(entry) || entry.state !== 'active') return this.reject('inactive-or-disabled');
    if (entry.nodes.some(state => state.mesh && (isTargetModelEffectSuspended(state.mesh.mesh) || hasTargetModelEffectSuspensionCallbacks(state.mesh.mesh)))) return this.reject('external-effect-lease-or-callback');
    const releases: Array<() => void> = [];
    try {
      for (const state of entry.nodes) if (state.mesh) releases.push(suspendTargetModelEffects(state.mesh.mesh));
      if (!this.valid(entry, parent)) { releases.forEach(release => release()); return this.reject('graph-or-resource-changed'); }
      const started = performance.now();
      for (const root of entry.assets.rootNodes) root.parent = null;
      this.reset(entry);
      for (const root of entry.assets.rootNodes) root.setEnabled(false);
      for (const state of entry.nodes) if (state.mesh) state.mesh.mesh.isPickable = false;
      entry.releases = releases; entry.state = 'idle'; this.idle.push(entry);
      this.counters.retained++; this.counters.resets++; this.counters.resetMs += performance.now() - started;
      this.trim(); return true;
    } catch (error) {
      releases.forEach(release => release());
      this.reject('reset-error');
      // 已进入idle后只由本池回收；不允许调用方再持有一份已移交的句柄。
      if (entry.state === 'idle') { this.remove(entry); this.disposeEntry(entry); throw error; }
      throw error;
    }
  }

  /** 命中后仍保持隐藏，原提交分支挂到新contentRoot后再activate，避免在模板原点闪现。 */
  take(generatorId: string, key: string): GeneratedCargoPoolEntry | null {
    if (!this.enabled) return null;
    for (let index = this.idle.length - 1; index >= 0; index--) {
      const entry = this.idle[index];
      if (entry.generatorId !== generatorId || entry.key !== key) continue;
      this.idle.splice(index, 1);
      if (!this.valid(entry, null)) { this.counters.evicted++; this.disposeEntry(entry); continue; }
      entry.state = 'taken'; this.counters.hits++; return entry;
    }
    this.counters.misses++; return null;
  }

  activate(entry: GeneratedCargoPoolEntry, parent: TransformNode): void {
    if (!this.owned.has(entry) || (entry.state !== 'active' && entry.state !== 'taken')) throw new Error('货物池资源所有权状态无效。');
    if (!this.valid(entry, parent)) throw new Error('货物池挂载父节点或资源状态与新model不一致。');
    if (entry.state === 'taken') {
      const started = performance.now(); this.reset(entry);
      refreshDetachedSourceMeshes(this.scene, entry.nodes.flatMap(state => state.mesh ? [state.mesh.mesh] : []));
      for (const state of entry.nodes) state.node.computeWorldMatrix(true);
      entry.releases.forEach(release => release()); entry.releases = []; entry.state = 'active';
      this.counters.resets++; this.counters.resetMs += performance.now() - started;
    }
  }

  /** 迟到/失败checkout与正常拒绝退池共用原句柄释放，先归还本池自己的effect租约。 */
  discard(entry: GeneratedCargoPoolEntry): void {
    if (!this.owned.has(entry)) throw new Error('不能释放其它所有者的货物资源。');
    this.remove(entry); this.disposeEntry(entry);
  }

  clearGenerator(generatorId: string): void { this.clearMatching(entry => entry.generatorId === generatorId); }
  clear(): void { this.clearMatching(() => true); }

  private valid(entry: GeneratedCargoPoolEntry, parent: TransformNode | null): boolean {
    if (!standardLibrary() || entry.assets.handle.animationGroups.length || !unchangedSources(entry.sourceNodes)) return false;
    if (parent && (Object.getPrototypeOf(parent) !== TransformNode.prototype || !inheritedApi(parent, ['getChildren', 'getDescendants'])
      || !sameOrder(parent.getChildren(undefined, true), entry.assets.rootNodes))) return false;
    const roots = new Set(entry.assets.rootNodes);
    for (const state of entry.nodes) {
      const node = state.node;
      if (!standardNode(node) || node.position !== state.positionObject || node.rotation !== state.rotationObject || node.scaling !== state.scalingObject
        || node.parent !== (roots.has(node) ? parent : state.parent) || !sameOrder(node.getChildren(undefined, true), state.children)) return false;
      if ((entry.state === 'idle' || entry.state === 'taken') && Object.getOwnPropertyDescriptor(node, 'metadata')!.value !== state.metadata) return false;
      if (state.mesh) {
        const { mesh, source, geometry, material } = state.mesh;
        if (hasTargetModelEffectSuspensionCallbacks(mesh) || sourceOf(mesh) !== source || source.geometry !== geometry || source.material !== material || mesh.actionManager || mesh.edgesRenderer !== state.mesh.edges
          || mesh.layerMask !== state.mesh.fields.get('layerMask') || (mesh instanceof InstancedMesh && mesh.visibility !== state.mesh.visibility)) return false;
      }
    }
    return true;
  }

  private reset(entry: GeneratedCargoPoolEntry): void {
    for (const state of entry.nodes) {
      const node = state.node;
      node.name = state.name; node.id = state.id; node.metadata = state.metadata;
      node.position.copyFrom(state.position); node.rotation.copyFrom(state.rotation); node.scaling.copyFrom(state.scaling);
      node.rotationQuaternion = state.quaternion?.clone() ?? null; node.setPivotMatrix(state.pivot, state.postMultiply);
      node.billboardMode = state.billboard; node.infiniteDistance = state.infiniteDistance; node.setEnabled(state.enabled);
      if (state.mesh) {
        for (const [key, value] of state.mesh.fields) {
          if (key === 'renderingGroupId' && state.mesh.mesh instanceof InstancedMesh) continue;
          Reflect.set(state.mesh.mesh, key, value);
        }
        if (!(state.mesh.mesh instanceof InstancedMesh)) state.mesh.mesh.visibility = state.mesh.visibility;
      }
    }
  }
  private reject(reason: string): false {
    this.counters.rejected++; this.rejectionReasons.set(reason, (this.rejectionReasons.get(reason) ?? 0) + 1); return false;
  }
  private remove(entry: GeneratedCargoPoolEntry): void { const index = this.idle.indexOf(entry); if (index !== -1) this.idle.splice(index, 1); }
  private trim(): void {
    const perKey = (entry: GeneratedCargoPoolEntry) => this.idle.filter(other => other.generatorId === entry.generatorId && other.key === entry.key).length;
    while (this.idle.length > this.limits.maxIdleEntries || this.getMetrics().idleNodes > this.limits.maxIdleNodes
      || this.idle.some(entry => perKey(entry) > this.limits.maxIdlePerKey)) {
      const overfull = this.idle.find(entry => perKey(entry) > this.limits.maxIdlePerKey);
      const entry = overfull ?? this.idle[0]; this.remove(entry); this.counters.evicted++; this.disposeEntry(entry);
    }
  }
  private clearMatching(matches: (entry: GeneratedCargoPoolEntry) => boolean): void {
    const selected = this.idle.filter(matches), errors: unknown[] = [];
    for (const entry of selected) { this.remove(entry); try { this.disposeEntry(entry); } catch (error) { errors.push(error); } }
    if (errors.length) throw new AggregateError(errors, '货物池清理未完整成功。');
  }
  private disposeEntry(entry: GeneratedCargoPoolEntry): void {
    if (entry.state === 'disposed') return;
    entry.state = 'disposed'; entry.releases.forEach(release => release()); entry.releases = [];
    entry.assets.handle.dispose();
  }
}
