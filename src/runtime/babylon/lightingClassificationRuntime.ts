import { getSceneLightingConfig } from '../../../electron/shared/sceneLightingConfig.ts';
import { VertexBuffer } from '@babylonjs/core/Buffers/buffer.js';
import { Matrix } from '@babylonjs/core/Maths/math.vector.js';
import { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh.js';
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { Geometry } from '@babylonjs/core/Meshes/geometry.js';
import { InstancedMesh } from '@babylonjs/core/Meshes/instancedMesh.js';
import { Node } from '@babylonjs/core/node.js';
import type { Scene } from '@babylonjs/core';
import type { LightingClassificationEntry } from '../../../electron/shared/sceneLightingBakeContract.ts';
import { lightingContentHash } from '../../../electron/shared/sceneLightingBakeContract.ts';
import { createSceneLightingPolicyResolver, matchesLightingPolicyTarget, normalizeLightingPolicyNodeKey, normalizeSceneLightingPolicy,
  type LightingPolicyContext, type LightingMotionRole, type ResolvedLightingPolicy } from '../../../electron/shared/sceneLightingPolicy.ts';
import type { SceneDocument } from '../../editor/model/SceneDocument';
import type { Entity } from '../../editor/model/Entity';
import type { ModelAssetComponent } from '../../editor/model/components';
import { classifyEntityMobility } from '../../editor/model/lightingMobility.ts';
import type { EntityArrayThinInstanceBatch } from './EntityArrayThinInstanceBatch';
import type { GeneratedOutputOwnerRuntimeEntry, ModelRuntimeEntry } from './SceneRuntime';
import { createLightingNodeKey } from './lightingGeometry.ts';
import { isShadowCaster } from './SceneShadowRuntime.ts';
import { getNativeLightingInstances, type LightingInstanceBatch } from './lightingNativeInstances.ts';
import { subscribeLightingGeometryUpdates } from './lightingGeometryUpdates.ts';

export type LightingRuntimeSource = {
  mesh: AbstractMesh;
  entry: LightingClassificationEntry;
  getWorldMatrix: () => Matrix | null;
  instance?: { batch: LightingInstanceBatch; mesh: AbstractMesh; sourceIndex: number };
};
type MotionTargets = { moving: Node[]; fixed: Node[]; known: boolean };
export type LightingSourceOwner = { ownerEntityId?: string; parentDynamic?: boolean; deviceType?: string };
export type LightingBatchOwner = { entityPrefix: string; owner: LightingSourceOwner; nativeCarrier?: boolean };
export type LightingClassificationContext = {
  scene: Scene;
  document: SceneDocument;
  models: Iterable<[string, ModelRuntimeEntry]>;
  primitiveMeshes: ReadonlyMap<string, AbstractMesh>;
  environment: Array<{ key: string; mesh: AbstractMesh }>;
  batches: Iterable<EntityArrayThinInstanceBatch>;
  /** 跨设备批次共享渲染载体，但光照身份/节点规则仍从各业务实体自己的源节点解析。 */
  resolveBatchSource?: (batch: EntityArrayThinInstanceBatch, entityId: string, defaultSourceMesh: AbstractMesh) => AbstractMesh;
  /** 原件保留在场景供脚本查询，实际绘制由混合批次接管。 */
  isModelMeshRenderSuppressed?: (mesh: AbstractMesh) => boolean;
  sourceOwners?: ReadonlyMap<string, LightingSourceOwner>;
  batchOwners?: ReadonlyMap<EntityArrayThinInstanceBatch, LightingBatchOwner>;
  /** 使用环境运行时实际载入的变体，不把待加载的新文档 URL 当成当前来源。 */
  environmentSource?: { sourceUrl: string; sourcePath?: string; assetRevision?: string | null } | null;
  getMotionTargets: (model: ModelRuntimeEntry) => MotionTargets;
  readEntityId: (mesh: AbstractMesh) => string | null;
};

/** 将实际生成产物接入同一目录；组合局部 nodeId 必须加 owner 前缀以区分多个货物实例。 */
export function appendGeneratedLightingSources(
  document: SceneDocument,
  owners: Iterable<[string, GeneratedOutputOwnerRuntimeEntry]>,
  target: {
    models: Array<[string, ModelRuntimeEntry]>;
    primitiveMeshes: Map<string, AbstractMesh>;
    batches: Set<EntityArrayThinInstanceBatch>;
    sourceOwners: Map<string, LightingSourceOwner>;
    batchOwners: Map<EntityArrayThinInstanceBatch, LightingBatchOwner>;
  },
): void {
  for (const [key, owner] of owners) {
    const ownerEntityId = [owner.editorEntityId, owner.entityId, owner.metadata.hostEntityId, owner.metadata.generatorEntityId]
      .find((id): id is string => typeof id === 'string' && Boolean(document.entities[id]));
    const ownership: LightingSourceOwner = {
      ...(ownerEntityId ? { ownerEntityId } : {}),
      // 自动货物根由真实设备驱动移动；资源静态规则不能抵消这层父级运动。
      parentDynamic: owner.metadata.generatedCargo === true || owner.metadata.modelGeneratorCargo === true,
    };
    target.sourceOwners.set(key, ownership);
    if (owner.output?.kind === 'model') target.models.push([key, owner.output.model]);
    else if (owner.output?.kind === 'mesh') {
      target.primitiveMeshes.set(key, owner.output.mesh);
      target.sourceOwners.set(key, { ...ownership, deviceType: `mesh:${owner.output.target.meshKind}` });
    }
    else if (owner.output?.kind === 'composition') {
      const prefix = `${key}/composition:`;
      for (const member of owner.output.members) {
        const memberKey = prefix + encodeURIComponent(member.nodeId);
        target.sourceOwners.set(memberKey, ownership);
        if (member.model) target.models.push([memberKey, member.model]);
        if (member.mesh) target.primitiveMeshes.set(memberKey, member.mesh);
        if (member.arrayBatch) {
          target.batches.add(member.arrayBatch);
          target.batchOwners.set(member.arrayBatch, { entityPrefix: prefix, owner: ownership, nativeCarrier: true });
        }
      }
    }
  }
}

function under(node: Node, ancestors: ReadonlySet<Node>): boolean {
  for (let current: Node | null = node; current; current = current.parent) if (ancestors.has(current)) return true;
  return false;
}
function resourceMeshes(model: ModelRuntimeEntry): AbstractMesh[] {
  return [...new Set([...model.meshes, ...model.contentRoot.getChildMeshes(false)])]
    .filter(mesh => !mesh.isDisposed() && mesh.getTotalVertices() > 0 && isShadowCaster(mesh) && !mesh.metadata?.lightingDerived);
}

type DataSnapshot = { kind: 'array'; values: unknown[] } | { kind: 'bytes'; values: Uint8Array; type: string } | { kind: 'none' };
type GeometryRevision = { revision: number; references: number; subscription: ReturnType<typeof subscribeLightingGeometryUpdates> };
const geometryRevisions = new WeakMap<Geometry, GeometryRevision>();

/** Geometry 的唯一回调可被外部覆盖；保留旧回调，不为抢回所有权反复包装。 */
function watchGeometry(geometry: Geometry) {
  let state = geometryRevisions.get(geometry);
  if (!state) {
    const created = { revision: 0, references: 0 } as GeometryRevision;
    created.subscription = subscribeLightingGeometryUpdates(geometry, (_value, kind) => {
      if (kind === undefined || kind === VertexBuffer.PositionKind) created.revision++;
    });
    geometryRevisions.set(geometry, created); state = created;
  }
  const shared = state; shared.references++;
  let released = false;
  return {
    read: () => ({ revision: shared.revision, trusted: shared.subscription.isCurrent() }),
    release: () => {
      if (released) return; released = true;
      if (--shared.references > 0) return;
      shared.subscription.release();
      geometryRevisions.delete(geometry);
    },
  };
}

function bytesOf(value: unknown): Uint8Array | null {
  return ArrayBuffer.isView(value) ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    : value instanceof ArrayBuffer ? new Uint8Array(value) : null;
}
// glTF 的多个独立 Geometry 会共享同一个 CPU 数据视图。弱值池仅复用仍由身份记录持有的不可变快照，
// 不因源资产仍在缓存而额外保留已释放身份的字节副本；普通数组继续保持原有 slice 语义。
const sharedDataSnapshots = new WeakMap<object, WeakRef<DataSnapshot>>();
function snapshotData(value: unknown): DataSnapshot {
  if (Array.isArray(value)) return { kind: 'array', values: value.slice() };
  const bytes = bytesOf(value);
  if (!bytes) return { kind: 'none' };
  const source = value as object, previous = sharedDataSnapshots.get(source)?.deref();
  // 同一引用也可能已被原地改写；每次复用仍逐字节核对，不能覆盖其他 Geometry 保留的旧快照。
  if (previous && dataUnchanged(value, previous)) return previous;
  const snapshot: DataSnapshot = { kind: 'bytes', values: bytes.slice(), type: Object.prototype.toString.call(value) };
  sharedDataSnapshots.set(source, new WeakRef(snapshot));
  return snapshot;
}
/** 精确比较原 CPU 数据，覆盖不触发 Geometry 通知的 index 更新和 raw 数组原地改写；不重新逐数字 JSON 编码。 */
function dataUnchanged(value: unknown, snapshot: DataSnapshot): boolean {
  if (snapshot.kind === 'array') {
    if (!Array.isArray(value) || value.length !== snapshot.values.length) return false;
    for (let i = 0; i < value.length; i++) if (!Object.is(value[i], snapshot.values[i])) return false;
    return true;
  }
  const bytes = bytesOf(value);
  if (snapshot.kind === 'none') return !bytes && !Array.isArray(value);
  if (!bytes || bytes.length !== snapshot.values.length || Object.prototype.toString.call(value) !== snapshot.type) return false;
  // 常见 Float32/Uint16 数据按四字节比较，仍保持逐位精确，尾部再逐字节检查。
  let i = 0;
  if (bytes.byteOffset % 4 === 0) {
    const length = Math.floor(bytes.length / 4), a = new Uint32Array(bytes.buffer, bytes.byteOffset, length);
    const b = new Uint32Array(snapshot.values.buffer, snapshot.values.byteOffset, length);
    for (; i < length; i++) if (a[i] !== b[i]) return false;
    i *= 4;
  }
  for (; i < bytes.length; i++) if (bytes[i] !== snapshot.values[i]) return false;
  return true;
}

type GeometryIdentityRecord = {
  watch: ReturnType<typeof watchGeometry>; revision: number;
  buffer: ReturnType<Geometry['getVertexBuffer']>; layout: string;
  positions: DataSnapshot; indices: DataSnapshot;
};
type ModelIdentityState = {
  root: ModelRuntimeEntry['contentRoot']; revision: ModelRuntimeEntry['assetRevision']; parameters: string;
  parts: Array<{ mesh: AbstractMesh; geometry: Geometry | null; key: string }>;
  geometries: Map<Geometry, GeometryIdentityRecord>; identity: string; release: () => void;
};
const modelIdentities = new WeakMap<ModelRuntimeEntry, ModelIdentityState>();

function createModelIdentityState(model: ModelRuntimeEntry): ModelIdentityState {
  const state: ModelIdentityState = { root: model.contentRoot, revision: model.assetRevision, parameters: model.parameterSignature,
    parts: [], geometries: new Map(), identity: '', release: () => undefined };
  const observer = model.contentRoot.onDisposeObservable.addOnce(() => {
    state.release(); if (modelIdentities.get(model) === state) modelIdentities.delete(model);
  });
  state.release = () => {
    state.root.onDisposeObservable.remove(observer);
    for (const item of state.geometries.values()) item.watch.release();
    state.geometries.clear(); state.parts = []; state.identity = '';
  };
  modelIdentities.set(model, state);
  return state;
}

function modelIdentity(model: ModelRuntimeEntry): string {
  const meshes = resourceMeshes(model);
  let state = modelIdentities.get(model);
  if (state && state.root !== model.contentRoot) { state.release(); state = undefined; }
  state ??= createModelIdentityState(model);
  const parts = meshes.map(mesh => ({ mesh, geometry: mesh.geometry, key: createLightingNodeKey(mesh, model.contentRoot) }));
  let unchanged = !!state.identity && state.revision === model.assetRevision && state.parameters === model.parameterSignature
    && parts.length === state.parts.length && parts.every((part, i) => part.mesh === state.parts[i].mesh
      && part.geometry === state.parts[i].geometry && part.key === state.parts[i].key);
  const visited = new Set<Geometry>();
  const updates: Array<{ record: GeometryIdentityRecord; data: unknown; indices: unknown; revision: number; buffer: GeometryIdentityRecord['buffer']; layout: string }> = [];
  for (const part of parts) {
    const geometry = part.geometry;
    if (!geometry) { unchanged = false; continue; }
    if (visited.has(geometry)) continue; visited.add(geometry);
    let record = state.geometries.get(geometry);
    if (!record) {
      record = { watch: watchGeometry(geometry), revision: -1, buffer: null, layout: '', positions: { kind: 'none' }, indices: { kind: 'none' } };
      state.geometries.set(geometry, record);
    }
    const observed = record.watch.read(), buffer = geometry.getVertexBuffer(VertexBuffer.PositionKind);
    const data = buffer?.getData(), indices = geometry.getIndices();
    const layout = buffer ? [buffer.byteStride, buffer.byteOffset, buffer.type, buffer.normalized, buffer.getSize()].join('/') : '';
    const valid = observed.trusted && observed.revision === record.revision && buffer === record.buffer && layout === record.layout
      && dataUnchanged(data, record.positions) && dataUnchanged(indices, record.indices);
    if (!valid) { unchanged = false; updates.push({ record, data, indices, revision: observed.revision, buffer, layout }); }
  }
  for (const [geometry, record] of state.geometries) if (!visited.has(geometry)) { record.watch.release(); state.geometries.delete(geometry); }
  if (unchanged) return state.identity;
  // 身份来自实际几何及修订，工程迁移、SOURCE 下载和发布增加快照字段不改变节点覆盖。
  const identity = lightingContentHash([model.assetRevision, meshes.map(mesh => ({
    node: createLightingNodeKey(mesh, model.contentRoot),
    positions: mesh.getVerticesData(VertexBuffer.PositionKind) ?? [],
    indices: mesh.getIndices() ?? [],
  }))]);
  for (const item of updates) Object.assign(item.record, { revision: item.revision, buffer: item.buffer, layout: item.layout,
    positions: snapshotData(item.data), indices: snapshotData(item.indices) });
  state.revision = model.assetRevision; state.parameters = model.parameterSignature; state.parts = parts; state.identity = identity;
  return identity;
}

type PrimitiveIdentityState = GeometryIdentityRecord & {
  geometry: Geometry; scene: Scene; gpuBuffer: ReturnType<VertexBuffer['getBuffer']>;
  indexBuffer: ReturnType<Geometry['getIndexBuffer']>; identities: Map<string, string>; release: () => void;
};
type PrimitiveIdentityPass = { state: PrimitiveIdentityState; previous: ReadonlyMap<string, string> };
const primitiveIdentities = new WeakMap<AbstractMesh, PrimitiveIdentityState>();
const standardMeshVertices = Mesh.prototype.getVerticesData, standardMeshIndices = Mesh.prototype.getIndices;
const standardGeometryVertices = Geometry.prototype.getVerticesData, standardGeometryIndices = Geometry.prototype.getIndices;

function createPrimitiveIdentityState(mesh: Mesh, geometry: Geometry): PrimitiveIdentityState {
  const state: PrimitiveIdentityState = { geometry, scene: mesh.getScene(), watch: watchGeometry(geometry),
    revision: -1, buffer: null, layout: '', gpuBuffer: null, indexBuffer: null,
    positions: { kind: 'none' }, indices: { kind: 'none' }, identities: new Map(), release: () => undefined };
  const observer = mesh.onDisposeObservable.addOnce(() => state.release());
  state.release = () => {
    mesh.onDisposeObservable.remove(observer); state.watch.release(); state.identities.clear();
    if (primitiveIdentities.get(mesh) === state) primitiveIdentities.delete(mesh);
  };
  primitiveIdentities.set(mesh, state);
  return state;
}

/** 非模型carrier也会承载大量逻辑实例；每轮只核对一次原数据，不缓存各实例的最终策略。 */
function primitiveIdentity(mesh: AbstractMesh, partKey: string,
  checked: Map<AbstractMesh, PrimitiveIdentityPass | null>): string {
  let pass = checked.get(mesh);
  if (!checked.has(mesh)) {
    let state = primitiveIdentities.get(mesh);
    const geometry = mesh.geometry;
    // 只有已知委托关系才能用Geometry数据校验缓存；自定义读取器逐调用保持原合同。
    if (!(mesh instanceof Mesh) || !geometry || mesh.getVerticesData !== standardMeshVertices || mesh.getIndices !== standardMeshIndices
      || geometry.getVerticesData !== standardGeometryVertices || geometry.getIndices !== standardGeometryIndices) {
      state?.release(); checked.set(mesh, null);
    } else {
      if (state && (state.geometry !== geometry || state.scene !== mesh.getScene())) { state.release(); state = undefined; }
      state ??= createPrimitiveIdentityState(mesh, geometry);
      const observed = state.watch.read(), buffer = geometry.getVertexBuffer(VertexBuffer.PositionKind);
      const data = buffer?.getData(), indices = geometry.getIndices();
      const gpuBuffer = buffer?.getBuffer() ?? null, indexBuffer = geometry.getIndexBuffer();
      const layout = buffer ? [geometry.getTotalVertices(), buffer.byteStride, buffer.byteOffset,
        buffer.type, buffer.normalized, buffer.getSize()].join('/') : '';
      const valid = observed.trusted && observed.revision === state.revision && buffer === state.buffer
        && gpuBuffer === state.gpuBuffer && indexBuffer === state.indexBuffer && layout === state.layout
        && dataUnchanged(data, state.positions) && dataUnchanged(indices, state.indices);
      const previous = valid ? state.identities : new Map<string, string>();
      if (!valid) Object.assign(state, { revision: observed.revision, buffer, layout, gpuBuffer, indexBuffer,
        positions: snapshotData(data), indices: snapshotData(indices) });
      // 新目录只保留本轮仍存活的partKey；旧目录仅在本次同步调用栈中复用，失败/重试也不会累计过期key。
      state.identities = new Map();
      pass = { state, previous }; checked.set(mesh, pass);
    }
  }
  if (!pass) return lightingContentHash([partKey, mesh.getVerticesData(VertexBuffer.PositionKind) ?? [], mesh.getIndices() ?? []]);
  const known = pass.state.identities.get(partKey) ?? pass.previous.get(partKey);
  const identity = known ?? lightingContentHash([partKey, mesh.getVerticesData(VertexBuffer.PositionKind) ?? [], mesh.getIndices() ?? []]);
  pass.state.identities.set(partKey, identity);
  return identity;
}

type EnvironmentPart = { mesh: AbstractMesh; key: string; geometry: Geometry };
type EnvironmentGeometryRecord = GeometryIdentityRecord & {
  gpuBuffer: ReturnType<VertexBuffer['getBuffer']>; indexBuffer: ReturnType<Geometry['getIndexBuffer']>;
};
type EnvironmentIdentityState = {
  revision: unknown; parts: EnvironmentPart[]; identity: string;
  geometries: Map<Geometry, EnvironmentGeometryRecord>;
  meshes: Map<AbstractMesh, ReturnType<AbstractMesh['onDisposeObservable']['addOnce']>>;
  release: () => void;
};
const environmentIdentities = new WeakMap<Scene, EnvironmentIdentityState>();
const standardInstanceVertices = InstancedMesh.prototype.getVerticesData, standardInstanceIndices = InstancedMesh.prototype.getIndices;
const standardEnvironmentMap = Array.prototype.map;

function createEnvironmentIdentityState(scene: Scene): EnvironmentIdentityState {
  const state: EnvironmentIdentityState = { revision: undefined, parts: [], identity: '', geometries: new Map(), meshes: new Map(), release: () => undefined };
  const observer = scene.onDisposeObservable.addOnce(() => state.release());
  let released = false;
  state.release = () => {
    if (released) return; released = true;
    scene.onDisposeObservable.remove(observer);
    for (const [mesh, token] of state.meshes) mesh.onDisposeObservable.remove(token);
    for (const record of state.geometries.values()) record.watch.release();
    state.meshes.clear(); state.geometries.clear(); state.parts = []; state.identity = '';
    if (environmentIdentities.get(scene) === state) environmentIdentities.delete(scene);
  };
  environmentIdentities.set(scene, state);
  return state;
}

/** 原生InstancedMesh仅委托可信源Mesh；未知读取器不能用Geometry快照代替其实际返回值。 */
function standardEnvironmentMesh(mesh: AbstractMesh): boolean {
  const geometry = mesh.geometry;
  if (!geometry || geometry.getVerticesData !== standardGeometryVertices || geometry.getIndices !== standardGeometryIndices) return false;
  if (mesh instanceof Mesh) return mesh.getVerticesData === standardMeshVertices && mesh.getIndices === standardMeshIndices;
  if (!(mesh instanceof InstancedMesh) || mesh.getVerticesData !== standardInstanceVertices || mesh.getIndices !== standardInstanceIndices) return false;
  const source = mesh.sourceMesh;
  return source.geometry === geometry && source.getVerticesData === standardMeshVertices && source.getIndices === standardMeshIndices;
}

/** 只保存当前Scene的最后一组完整环境身份；目录包装可变，顺序、key、真实数据仍逐轮精确核对。 */
function environmentIdentity(context: LightingClassificationContext, revision: unknown): string {
  const { scene, environment } = context;
  const original = () => lightingContentHash([revision, environment.map(surface => [
    surface.key, surface.mesh.getVerticesData(VertexBuffer.PositionKind) ?? [], surface.mesh.getIndices() ?? [],
  ])]);
  let state = environmentIdentities.get(scene);
  // 真实目录使用普通数据项；带访问器或自定义map时继续执行原表达式，不推断其副作用或返回值。
  const primitiveRevision = revision === null || ['undefined', 'string', 'number', 'boolean'].includes(typeof revision);
  let standard = primitiveRevision && Array.isArray(environment) && Object.getPrototypeOf(environment) === Array.prototype;
  if (standard) {
    const map = Object.getOwnPropertyDescriptor(environment, 'map') ?? Object.getOwnPropertyDescriptor(Array.prototype, 'map');
    standard = !!map && 'value' in map && map.value === standardEnvironmentMap;
  }
  for (let i = 0; standard && i < environment.length; i++) {
    const item = Object.getOwnPropertyDescriptor(environment, String(i));
    if (!item || !('value' in item) || !item.value || typeof item.value !== 'object') { standard = false; break; }
    const mesh = Object.getOwnPropertyDescriptor(item.value, 'mesh'), key = Object.getOwnPropertyDescriptor(item.value, 'key');
    standard = !!mesh && 'value' in mesh && !!key && 'value' in key && typeof key.value === 'string' && standardEnvironmentMesh(mesh.value);
  }
  if (!standard) { state?.release(); return original(); }
  state ??= createEnvironmentIdentityState(scene);
  const parts = environment.map(surface => ({ mesh: surface.mesh, key: surface.key, geometry: surface.mesh.geometry! }));
  let unchanged = !!state.identity && Object.is(state.revision, revision) && parts.length === state.parts.length
    && parts.every((part, i) => part.mesh === state.parts[i].mesh && part.key === state.parts[i].key && part.geometry === state.parts[i].geometry);
  const visited = new Set<Geometry>(), meshes = new Set<AbstractMesh>();
  const changed: Array<{ record: EnvironmentGeometryRecord; data: unknown; indices: unknown; revision: number;
    buffer: EnvironmentGeometryRecord['buffer']; gpuBuffer: EnvironmentGeometryRecord['gpuBuffer'];
    indexBuffer: EnvironmentGeometryRecord['indexBuffer']; layout: string }> = [];
  for (const part of parts) {
    meshes.add(part.mesh);
    if (!state.meshes.has(part.mesh)) state.meshes.set(part.mesh, part.mesh.onDisposeObservable.addOnce(() => state!.release()));
    if (visited.has(part.geometry)) continue; visited.add(part.geometry);
    let record = state.geometries.get(part.geometry);
    if (!record) {
      record = { watch: watchGeometry(part.geometry), revision: -1, buffer: null, gpuBuffer: null, indexBuffer: null,
        layout: '', positions: { kind: 'none' }, indices: { kind: 'none' } };
      state.geometries.set(part.geometry, record);
    }
    const observed = record.watch.read(), buffer = part.geometry.getVertexBuffer(VertexBuffer.PositionKind);
    const data = buffer?.getData(), indices = part.geometry.getIndices();
    const gpuBuffer = buffer?.getBuffer() ?? null, indexBuffer = part.geometry.getIndexBuffer();
    const layout = buffer ? [part.geometry.getTotalVertices(), buffer.byteStride, buffer.byteOffset,
      buffer.type, buffer.normalized, buffer.getSize()].join('/') : '';
    const valid = observed.trusted && observed.revision === record.revision && buffer === record.buffer
      && gpuBuffer === record.gpuBuffer && indexBuffer === record.indexBuffer && layout === record.layout
      && dataUnchanged(data, record.positions) && dataUnchanged(indices, record.indices);
    if (!valid) { unchanged = false; changed.push({ record, data, indices, revision: observed.revision, buffer, gpuBuffer, indexBuffer, layout }); }
  }
  for (const [mesh, token] of state.meshes) if (!meshes.has(mesh)) { mesh.onDisposeObservable.remove(token); state.meshes.delete(mesh); }
  for (const [geometry, record] of state.geometries) if (!visited.has(geometry)) { record.watch.release(); state.geometries.delete(geometry); }
  if (unchanged) return state.identity;
  const identity = original();
  for (const item of changed) Object.assign(item.record, { revision: item.revision, buffer: item.buffer, gpuBuffer: item.gpuBuffer,
    indexBuffer: item.indexBuffer, layout: item.layout, positions: snapshotData(item.data), indices: snapshotData(item.indices) });
  state.revision = revision; state.parts = parts; state.identity = identity;
  return identity;
}

function ancestorIds(document: SceneDocument, entity: Entity | undefined): string[] {
  const visited = new Set<string>();
  for (let id = entity?.parentId; id && !visited.has(id); id = document.entities[id]?.parentId ?? null) {
    visited.add(id);
  }
  return [...visited];
}
function resolvedModelAsset(model: ModelRuntimeEntry | undefined, entity: Entity | undefined): Partial<ModelAssetComponent> | undefined {
  const asset = model?.resolvedModelAsset ?? model?.entitySnapshot?.components.modelAsset ?? entity?.components.modelAsset;
  if (!model?.sourceUrl || (asset && model.sourceUrl === asset.sourceUrl)) return asset;
  // 读取旧模型仍在显示时的真实 URL，禁止把新文档的另一个路径作为该资源的别名。
  return { sourceUrl: model.sourceUrl, sourcePath: model.sourceUrl };
}
function automaticEntity(entity: Entity): Entity {
  return { ...entity, components: { ...entity.components, lighting: undefined } };
}
function deviceType(model: ModelRuntimeEntry | undefined, entity: Entity | undefined, asset: Partial<ModelAssetComponent> | undefined, mesh: AbstractMesh): string {
  const declared = asset?.dataDrivenConfig?.device?.devType ?? model?.telemetryBinding?.deviceType
    ?? (!model ? entity?.components.telemetryBinding?.deviceType : undefined);
  if (declared) return declared;
  if (model?.stackerCapable) return 'stacker';
  if (model?.conveyorCapable) return 'conveyor';
  if (model?.rgvCapable) return 'rgv';
  if (model?.liftCapable) return 'lift';
  return model ? 'model' : `mesh:${entity?.components.meshRenderer?.meshKind ?? mesh.metadata?.editorMeshKind ?? 'mesh'}`;
}

/** 使用真实驱动解析目标；分类只生成读取模型的视图，不改动作、父子链或业务变换。 */
export function collectLightingRuntimeSources(context: LightingClassificationContext): LightingRuntimeSource[] {
  const { document, scene } = context;
  if (!context.environment.length) environmentIdentities.get(scene)?.release();
  const output: LightingRuntimeSource[] = [];
  const used = new Set<AbstractMesh>(), modelsByMesh = new Map<AbstractMesh, { model: ModelRuntimeEntry; entityId: string }>();
  const motionCache = new Map<ModelRuntimeEntry, MotionTargets>();
  const identityCache = new Map<ModelRuntimeEntry, string>();
  const primitiveIdentityCache = new Map<AbstractMesh, PrimitiveIdentityPass | null>();
  const nodeKeysCache = new Map<ModelRuntimeEntry, string[]>();
  const parentDynamicCache = new Map<string, boolean>();
  const models = [...context.models];
  const modelsByEntity = new Map(models);
  const policy = normalizeSceneLightingPolicy(getSceneLightingConfig(document).policy) ?? { version: 1 as const, defaults: {}, rules: [] };
  const policyScopes = new Map<string, (context: LightingPolicyContext) => ResolvedLightingPolicy>();
  const resolvePolicy = (input: LightingPolicyContext): ResolvedLightingPolicy => {
    // 此次目录收集中的规则快照固定；只按实际匹配规则序列复用 resolver，避免每个薄实例遍历完整参数元数据。
    // 节点、资源修订、实体例外仍由 resolver 对当前 input 逐项解析，不缓存最终分类结果。
    const matchedIndices = policy.rules.flatMap((rule, index) => matchesLightingPolicyTarget(rule.target, input) ? [index] : []);
    const scopeKey = matchedIndices.join(',');
    let resolve = policyScopes.get(scopeKey);
    if (!resolve) {
      resolve = createSceneLightingPolicyResolver({ ...policy, rules: matchedIndices.map(index => policy.rules[index]) });
      policyScopes.set(scopeKey, resolve);
    }
    return resolve(input);
  };
  for (const [entityId, model] of models) {
    for (const mesh of new Set([...model.meshes, ...model.contentRoot.getChildMeshes(false)])) modelsByMesh.set(mesh, { model, entityId });
  }
  const parentIsDynamic = (entity: Entity | undefined): boolean => {
    if (!entity) return false;
    if (!parentDynamicCache.has(entity.id)) {
      const dynamic = ancestorIds(document, entity).some(id => {
        const parent = document.entities[id];
        if (!parent) return false;
        const parentLighting = parent.components.lighting;
        const inheritedMobility = Array.isArray(parentLighting?.inheritPolicy) && parentLighting.inheritPolicy.includes('mobility');
        // 场景默认只控制分类，不能据此认定普通 folder 的变换会运动并压过子对象例外。
        return classifyEntityMobility({ components: { ...parent.components,
          modelAsset: resolvedModelAsset(modelsByEntity.get(id), parent),
          lighting: inheritedMobility ? { ...parentLighting, mobility: 'auto' } : parentLighting } }).mobility === 'dynamic';
      });
      parentDynamicCache.set(entity.id, dynamic);
    }
    return parentDynamicCache.get(entity.id)!;
  };
  const environment = document.sceneSettings.environment;
  const environmentUrl = context.environmentSource?.sourceUrl ?? environment?.activeVariantUrl;
  const environmentVariant = environment?.variants?.find(variant => variant.sourceUrl === environmentUrl);
  const environmentNodeKeys = context.environment.map(surface => surface.key);
  let currentEnvironmentIdentity: string | undefined;
  const create = (mesh: AbstractMesh, entityId: string, nodeKey: string, model?: ModelRuntimeEntry,
    actualNode: Node = mesh, instance?: LightingRuntimeSource['instance'], ownership = context.sourceOwners?.get(entityId),
    partKey = normalizeLightingPolicyNodeKey(nodeKey)) => {
    if (mesh.isDisposed() || !mesh.getTotalVertices() || !isShadowCaster(mesh) || mesh.metadata?.lightingDerived) return;
    if (!instance && mesh instanceof Mesh && mesh.thinInstanceCount > 0) {
      const batch = getNativeLightingInstances(mesh, entityId);
      for (const item of batch.getLightingInstances()) create(mesh, entityId, `${nodeKey}/thin:${item.sourceIndex}`, model, actualNode,
        { batch, mesh, sourceIndex: item.sourceIndex }, ownership, partKey);
      return;
    }
    const entity = document.entities[entityId] ?? (ownership?.ownerEntityId ? document.entities[ownership.ownerEntityId] : undefined)
      ?? model?.entitySnapshot ?? undefined;
    const asset = model ? resolvedModelAsset(model, entity) : undefined;
    let parentDynamic = ownership?.parentDynamic === true || parentIsDynamic(entity);
    let automatic = entity ? classifyEntityMobility(automaticEntity(entity)) : { mobility: 'dynamic' as const, reason: '运行时生成对象。' };
    let motionRole: LightingMotionRole = 'unknown';
    let identity = model ? identityCache.get(model) : undefined;
    if (model && !identity) { identity = modelIdentity(model); identityCache.set(model, identity); }
    if (model) {
      let motion = motionCache.get(model);
      if (!motion) { motion = context.getMotionTargets(model); motionCache.set(model, motion); }
      const moving = new Set(motion.moving), fixed = new Set(motion.fixed);
      const animationTargets = new Set<Node>();
      for (const group of model.assetHandle?.animationGroups ?? []) {
        for (const animation of group.targetedAnimations) if (animation.target instanceof Node) animationTargets.add(animation.target);
      }
      const animated = under(actualNode, animationTargets) || Boolean(mesh.skeleton || mesh.morphTargetManager?.numTargets);
      const movingByDriver = under(actualNode, moving);
      parentDynamic ||= Boolean(actualNode.parent && (under(actualNode.parent, moving) || under(actualNode.parent, animationTargets)));
      const fixedByDriver = under(actualNode, fixed) && !movingByDriver;
      const classificationEntity = { components: { ...model.entitySnapshot?.components, ...entity?.components, modelAsset: asset, lighting: undefined } };
      const parameterOnly = Boolean(asset?.parameterScriptMetadata?.length && !asset.animationScriptMetadata?.length
        && !entity?.components.telemetryBinding && !asset.dataDrivenConfig);
      const configuredScripts = model.externalScriptRuntime?.getDataDrivenConfigs?.().length ?? 0;
      const unknownScripts = Boolean(asset?.animationScriptMetadata?.length)
        || (!parameterOnly && Boolean(model.externalScriptRuntime) && (asset?.scriptAssets?.length ?? 1) > configuredScripts);
      automatic = classifyEntityMobility(classificationEntity, {
        parentDynamic, hasGeometryAnimation: animated,
        ...(motion.known && !animated && !unknownScripts ? { resolvedMobility: movingByDriver ? 'dynamic' as const : 'static' as const,
          reason: movingByDriver ? '实际设备驱动的运动目标。' : fixedByDriver ? '实际设备驱动确认的固定轨道。' : '设备驱动未移动该结构部件。' } : {}),
        parameterGeometryOnly: parameterOnly,
        hasUnknownScriptMotion: unknownScripts,
      });
      motionRole = movingByDriver || animated ? 'moving' : motion.known && !unknownScripts ? 'fixed' : 'unknown';
    }
    if (entityId === '$environment') {
      automatic = { mobility: 'static', reason: '场景环境结构。' };
      motionRole = 'fixed';
      currentEnvironmentIdentity ??= environmentIdentity(context,
        context.environmentSource ? context.environmentSource.assetRevision : environment?.dataPlatformRevision);
      identity = currentEnvironmentIdentity;
    } else if (!model) {
      identity = primitiveIdentity(mesh, partKey, primitiveIdentityCache);
      if (automatic.mobility === 'static') motionRole = 'fixed';
    }
    if (parentDynamic) motionRole = 'moving';
    let availableNodeKeys = model ? nodeKeysCache.get(model) : undefined;
    if (model && !availableNodeKeys) {
      availableNodeKeys = resourceMeshes(model).map(candidate => createLightingNodeKey(candidate, model.contentRoot));
      nodeKeysCache.set(model, availableNodeKeys);
    }
    // 内置几何显式使用空资源引用，避免 resolver 把设备宿主的模型当成生成物来源。
    const actualAsset = entityId === '$environment'
      ? environmentUrl ? { sourceUrl: environmentUrl, sourcePath: context.environmentSource?.sourcePath ?? environmentVariant?.sourcePath ?? environmentUrl } : {}
      : asset ? { sourceUrl: asset.sourceUrl, sourcePath: asset.sourcePath, ...(asset.dataPlatformModel ? { dataPlatformModel: asset.dataPlatformModel } : {}) } : {};
    // 当前逻辑实体明确缺少组件即代表继承，不能再回退成渲染宿主的旧例外。
    const ownerLighting = entity ? entity.components.lighting : model?.entitySnapshot?.components.lighting;
    const entityLighting = ownerLighting ? { ...ownerLighting,
      nodeOverrides: ownerLighting.nodeOverrides?.[nodeKey] ? { [nodeKey]: ownerLighting.nodeOverrides[nodeKey] } : {} } : undefined;
    const policyContext: LightingPolicyContext = {
      entityId, ...(ownership?.ownerEntityId ? { ownerEntityId: ownership.ownerEntityId } : {}),
      ancestorIds: ancestorIds(document, entity), modelAsset: actualAsset,
      deviceType: ownership?.deviceType ?? (entityId === '$environment' ? 'environment' : deviceType(model, ownership ? undefined : entity, asset, mesh)),
      nodeKey, partKey, resourceIdentity: identity, motionRole, automatic, parentDynamic,
      entityLighting,
    };
    const effective = resolvePolicy({ ...policyContext, entity,
      availableNodeKeys: availableNodeKeys ?? (entityId === '$environment' ? environmentNodeKeys : [partKey]) });
    const key = `${entityId}/${nodeKey}`;
    output.push({
      mesh, entry: { key, entityId, nodeKey, name: actualNode.name || mesh.name, ...effective.settings, reason: effective.reason,
        parentDynamic: effective.parentDynamic, ...(identity ? { resourceIdentity: identity } : {}),
        automaticMobility: automatic.mobility, automaticReason: automatic.reason, motionRole: effective.motionRole,
        deviceType: policyContext.deviceType, fieldSources: effective.fieldSources, sourceLabel: effective.sourceLabel,
        matchedRuleIds: effective.matchedRuleIds, policyMismatches: effective.mismatches, policyConflicts: effective.conflicts,
        policyContext, ...(effective.mismatches.some(item => !item.ruleId) ? { unmatchedOverride: true } : {}) },
      getWorldMatrix: instance
        ? () => instance.batch.getLightingInstanceWorldMatrix(instance.mesh, instance.sourceIndex)
        : () => mesh.computeWorldMatrix(true),
      ...(instance ? { instance } : {}),
    });
    used.add(mesh);
  };
  for (const batch of new Set(context.batches)) {
    const occurrence = new Map<string, number>();
    const batchOwner = context.batchOwners?.get(batch);
    for (const item of batch.getLightingInstances()) {
      const resolvedSource = context.resolveBatchSource?.(batch, item.entityId, item.sourceMesh) ?? item.sourceMesh;
      used.add(resolvedSource);
      const owner = modelsByMesh.get(resolvedSource);
      const path = owner ? createLightingNodeKey(resolvedSource, owner.model.contentRoot) : encodeURIComponent(resolvedSource.name);
      const entityId = batchOwner ? batchOwner.entityPrefix + encodeURIComponent(item.entityId) : item.entityId;
      const identity = `${entityId}/${path}`, ordinal = occurrence.get(identity) ?? 0;
      occurrence.set(identity, ordinal + 1);
      const nodeKey = `${path}/instance:${ordinal}`;
      const adapter = batchOwner?.nativeCarrier ? getNativeLightingInstances(item.mesh, entityId) : batch;
      create(item.mesh, entityId, nodeKey, owner?.model, resolvedSource,
        { batch: adapter, mesh: item.mesh, sourceIndex: item.sourceIndex }, batchOwner?.owner ?? context.sourceOwners?.get(entityId), path);
    }
  }
  for (const [entityId, model] of models) {
    if (model.modelArrayBatch || model.telemetryProxySource) continue;
    for (const mesh of new Set([...model.meshes, ...model.contentRoot.getChildMeshes(false)])) {
      if (used.has(mesh) || context.isModelMeshRenderSuppressed?.(mesh) || !scene.meshes.includes(mesh)) continue;
      create(mesh, entityId, createLightingNodeKey(mesh, model.contentRoot), model);
    }
  }
  for (const [entityId, mesh] of context.primitiveMeshes) if (!used.has(mesh)) create(mesh, entityId, '$mesh');
  for (const surface of context.environment) if (!used.has(surface.mesh)) create(surface.mesh, '$environment', surface.key);
  for (const mesh of scene.meshes) {
    if (used.has(mesh) || !mesh.isEnabled() || mesh.metadata?.lightingDerived || mesh.metadata?.editorLightMarker) continue;
    const entityId = context.readEntityId(mesh);
    // 没有业务身份的辅助网格不因开启混合光照自动进入物理场景。
    if (entityId && document.entities[entityId] && !document.entities[entityId].components.modelAsset) create(mesh, entityId, `runtime:${mesh.name}`);
  }
  return output;
}
