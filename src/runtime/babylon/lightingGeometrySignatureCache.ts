import { Buffer, VertexBuffer } from '@babylonjs/core/Buffers/buffer.js';
import { Geometry } from '@babylonjs/core/Meshes/geometry.js';
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { lightingContentHash } from '../../../electron/shared/sceneLightingBakeContract.ts';

type NumericTypedArray = Float32Array | Float64Array | Int8Array | Uint8Array | Uint8ClampedArray
  | Int16Array | Uint16Array | Int32Array | Uint32Array;
type NumericArray = number[] | NumericTypedArray;
type NumericConstructor = { new(buffer: ArrayBuffer): NumericTypedArray; readonly prototype: object };
type Snapshot = { bytes: Uint8Array; constructor: NumericConstructor; references: number };
type Value = Snapshot | unknown[] | null;
type Entry = { fields: Value[]; subMeshes: number[][]; snapshots: Set<Snapshot>; hash: string; released: boolean;
  disposeObserver: ReturnType<Mesh['onDisposeObservable']['addOnce']> };

/** 限制本缓存新增的活跃 CPU 快照；超额继续执行原始精确签名，不降低检查频率。 */
export const LIGHTING_GEOMETRY_SIGNATURE_CACHE_MAX_BYTES = 16 * 1024 * 1024;
const typedConstructors: NumericConstructor[] = [Float32Array, Float64Array, Int8Array, Uint8Array, Uint8ClampedArray,
  Int16Array, Uint16Array, Int32Array, Uint32Array];
const typedPrototypes = new Map(typedConstructors.map(constructor => [constructor.prototype, constructor]));
const arrayIterator = Array.prototype[Symbol.iterator];
const arrayMap = Array.prototype.map;
const typedIterator = Float32Array.prototype[Symbol.iterator];
const ByteArray = Uint8Array, DoubleArray = Float64Array;
const copyByteValues = Uint8Array.prototype.set;
const iteratorPrototype = Object.getPrototypeOf(new Float32Array()[Symbol.iterator]());
const iteratorNext = Object.getOwnPropertyDescriptor(iteratorPrototype, 'next')!;
const typedPrototype = Object.getPrototypeOf(Float32Array.prototype);
const metadataKeys = ['buffer', 'byteOffset', 'byteLength', 'length'] as const;
const typedMetadata = Object.fromEntries(metadataKeys.map(key => [key, Object.getOwnPropertyDescriptor(typedPrototype, key)!])) as Record<typeof metadataKeys[number], PropertyDescriptor>;
const standard = { meshVertices: Mesh.prototype.getVerticesData, meshIndices: Mesh.prototype.getIndices,
  geometryVertices: Geometry.prototype.getVerticesData, geometryIndices: Geometry.prototype.getIndices,
  geometryVertexBuffer: Geometry.prototype.getVertexBuffer, geometryReady: Geometry.prototype.isReady,
  vertexFloats: VertexBuffer.prototype.getFloatData, vertexData: VertexBuffer.prototype.getData, bufferData: Buffer.prototype.getData };
const kinds = [VertexBuffer.PositionKind, VertexBuffer.NormalKind, VertexBuffer.UVKind, VertexBuffer.UV2Kind,
  VertexBuffer.ColorKind, VertexBuffer.TangentKind];

function descriptor(object: object, key: PropertyKey): PropertyDescriptor | undefined {
  for (let current: object | null = object; current; current = Object.getPrototypeOf(current)) {
    const found = Object.getOwnPropertyDescriptor(current, key);
    if (found) return found;
  }
  return undefined;
}
function method(object: object, key: string, expected: unknown): boolean { return descriptor(object, key)?.value === expected; }
function ownValue(object: object, key: string): unknown { return Object.getOwnPropertyDescriptor(object, key)?.value; }

/** 未知读取器保留原始逐调用语义，不根据 Geometry 内部字段猜测它返回的数据。 */
function standardReaders(mesh: Mesh): boolean {
  if (!method(mesh, 'getVerticesData', standard.meshVertices) || !method(mesh, 'getIndices', standard.meshIndices)) return false;
  const subMeshes = ownValue(mesh, 'subMeshes');
  if (!Array.isArray(subMeshes) || Object.getPrototypeOf(subMeshes) !== Array.prototype || !method(subMeshes, 'map', arrayMap)) return false;
  const geometry = ownValue(mesh, '_geometry');
  if (!(geometry instanceof Geometry) || Object.getPrototypeOf(geometry) !== Geometry.prototype
    || !method(geometry, 'getVerticesData', standard.geometryVertices)
    || !method(geometry, 'getIndices', standard.geometryIndices)
    || !method(geometry, 'getVertexBuffer', standard.geometryVertexBuffer)
    || !method(geometry, 'isReady', standard.geometryReady)
    || ownValue(mesh, '_userInstancedBuffersStorage')) return false;
  const buffers = ownValue(geometry, '_vertexBuffers');
  if (!buffers || typeof buffers !== 'object') return false;
  for (const kind of kinds) {
    const property = Object.getOwnPropertyDescriptor(buffers, kind);
    if (property && !('value' in property)) return false;
    const vertex = property?.value;
    if (!vertex) continue;
    if (Object.getPrototypeOf(vertex) !== VertexBuffer.prototype
      || !method(vertex, 'getFloatData', standard.vertexFloats)
      || !method(vertex, 'getData', standard.vertexData)) return false;
    const buffer = ownValue(vertex, '_buffer');
    if (!(buffer instanceof Buffer) || Object.getPrototypeOf(buffer) !== Buffer.prototype || !method(buffer, 'getData', standard.bufferData)) return false;
  }
  return true;
}

function typedConstructor(value: unknown): NumericConstructor | null {
  if (!ArrayBuffer.isView(value) || value instanceof DataView) return null;
  const constructor = typedPrototypes.get(Object.getPrototypeOf(value));
  if (!constructor || descriptor(value, Symbol.iterator)?.value !== typedIterator || !standardIteratorNext()) return null;
  // 自定义 view 元数据或 SharedArrayBuffer 不具备这里需要的稳定同步读取边界。
  for (const key of metadataKeys) {
    const actual = descriptor(value, key), expected = typedMetadata[key];
    if (!actual || actual.get !== expected.get || actual.set !== expected.set || 'value' in actual) return null;
  }
  return viewBuffer(value) instanceof ArrayBuffer ? constructor : null;
}
function standardIteratorNext(): boolean {
  const current = Object.getOwnPropertyDescriptor(iteratorPrototype, 'next');
  return !!current && current.value === iteratorNext.value && current.get === iteratorNext.get && current.set === iteratorNext.set;
}
// 缓存自有数据始终用捕获的内建 getter，不能让后来的脚本原型覆盖影响快照清理或读取。
function viewBuffer(value: ArrayBufferView): ArrayBuffer { return typedMetadata.buffer.get!.call(value) as ArrayBuffer; }
function viewOffset(value: ArrayBufferView): number { return typedMetadata.byteOffset.get!.call(value) as number; }
function viewBytes(value: ArrayBufferView): number { return typedMetadata.byteLength.get!.call(value) as number; }
function viewLength(value: ArrayBufferView): number { return typedMetadata.length.get!.call(value) as number; }
function equalBytes(value: Uint8Array, snapshot: Uint8Array): boolean {
  const lengthBytes = viewBytes(value);
  if (lengthBytes !== viewBytes(snapshot)) return false;
  let offset = 0;
  if (viewOffset(value) % 4 === 0) {
    const length = Math.floor(lengthBytes / 4);
    const before = new Uint32Array(viewBuffer(snapshot), viewOffset(snapshot), length), after = new Uint32Array(viewBuffer(value), viewOffset(value), length);
    for (; offset < length; offset++) if (before[offset] !== after[offset]) return false;
    offset *= 4;
  }
  for (; offset < lengthBytes; offset++) if (value[offset] !== snapshot[offset]) return false;
  return true;
}
function numbers(snapshot: Snapshot): NumericTypedArray { return new snapshot.constructor(viewBuffer(snapshot.bytes)); }
function copyNumbers(values: NumericTypedArray, end = viewLength(values)): number[] {
  const copy: number[] = [];
  for (let index = 0; index < end; index++) copy.push(values[index]);
  return copy;
}
function canonical(value: Value): unknown[] | null { return value && 'bytes' in value ? copyNumbers(numbers(value)) : value; }
function snapshotBytes(raw: Uint8Array | null, copied: number[] | null): Uint8Array {
  if (raw) {
    const bytes = new ByteArray(viewBytes(raw));
    copyByteValues.call(bytes, raw);
    return bytes;
  }
  const values = new DoubleArray(copied!.length);
  for (let index = 0; index < copied!.length; index++) values[index] = copied![index];
  return new ByteArray(viewBuffer(values));
}

/**
 * 每次仍按原顺序读取实际属性并精确核对 CPU 数据，只省掉未变数据的 Array.from 和逐数字 canonical 编码。
 * Mesh 为弱键，dispose/GC 释放计数；共享数据视图复用不可变快照，不能因原位修改污染其他宿主基线。
 */
export class LightingGeometrySignatureCache {
  private readonly entries = new WeakMap<Mesh, Entry>();
  private readonly disposedMeshes = new WeakSet<Mesh>();
  private readonly overBudgetGeometries = new WeakMap<Mesh, Geometry>();
  private readonly sharedArrays = new WeakMap<object, WeakRef<Snapshot>>();
  private readonly sharedViews = new WeakMap<ArrayBuffer, Map<string, WeakRef<Snapshot>>>();
  private readonly finalizer = new FinalizationRegistry<Entry>(entry => this.releaseEntry(entry));
  private retainedBytes = 0;
  private readonly budget: number;

  constructor(maxBytes = LIGHTING_GEOMETRY_SIGNATURE_CACHE_MAX_BYTES) {
    this.budget = Number.isFinite(maxBytes) ? Math.max(0, Math.min(LIGHTING_GEOMETRY_SIGNATURE_CACHE_MAX_BYTES, Math.floor(maxBytes))) : 0;
  }

  /** 只报告本实例持有的快照字节，弱池中的已释放值不计入活跃保留量。 */
  getMetrics(): { retainedSnapshotBytes: number; budgetBytes: number } {
    return { retainedSnapshotBytes: this.retainedBytes, budgetBytes: this.budget };
  }

  getHash(mesh: Mesh): string {
    const geometry = ownValue(mesh, '_geometry');
    if (!standardIteratorNext() || !standardReaders(mesh) || this.disposedMeshes.has(mesh) || ownValue(mesh, '_isDisposed') === true
      || this.overBudgetGeometries.get(mesh) === geometry) {
      this.discard(mesh);
      return this.originalHash(mesh);
    }
    const previous = this.entries.get(mesh), retained = new Set<Snapshot>(), fields: Value[] = [];
    const reservation = { exceeded: false };
    let cacheable = true, unchanged = !!previous && !previous.released;
    const read = (data: unknown): Value => {
      const index = fields.length, before = previous?.fields[index];
      let value: Value = null;
      if (data !== null) {
        const constructor = typedConstructor(data);
        let copied: unknown[] | null = null;
        let snapshot: Snapshot | null = null;
        if (!constructor) {
          const standardArray = Array.isArray(data) && Object.getPrototypeOf(data) === Array.prototype
            && descriptor(data, Symbol.iterator)?.value === arrayIterator;
          if (standardArray && before && 'bytes' in before && before.constructor === Float64Array) {
            const baseline = numbers(before), baselineLength = viewLength(baseline);
            let offset = 0;
            // 使用原生 iterator 的相同逐元素读取，保留数组 accessor 的次数和顺序；相同前缀直接借用不可变基线。
            for (const item of data) {
              if (!copied && (offset >= baselineLength || typeof item !== 'number' || !Object.is(item, baseline[offset]))) copied = copyNumbers(baseline, offset);
              copied?.push(item); offset++;
            }
            if (!copied && offset === baselineLength) snapshot = this.retain(before, retained, reservation);
            else copied ??= copyNumbers(baseline, offset);
          } else copied = Array.from(data as ArrayLike<unknown>);
          if (!standardArray || copied?.some(item => typeof item !== 'number')) cacheable = false;
        }
        snapshot ??= cacheable ? this.snapshot(data as NumericArray, copied as number[] | null, constructor,
          before && 'bytes' in before ? before : null, retained, reservation) : null;
        if (snapshot) value = snapshot;
        else { value = copied ?? Array.from(data as ArrayLike<unknown>); cacheable = false; }
      }
      fields.push(value); unchanged &&= value === before;
      return value;
    };
    let committed = false;
    try {
      // 调用及异常顺序必须与原表达式一致，任何数据都在读取后立即固定，避免后续 iterator 改写前面的属性。
      const values = (kind: string) => { const data = mesh.getVerticesData(kind); return read(data ? data : null); };
      const positions = values(VertexBuffer.PositionKind), normals = values(VertexBuffer.NormalKind);
      const indices = read(mesh.getIndices() ?? []), uvs = values(VertexBuffer.UVKind), uvs2 = values(VertexBuffer.UV2Kind);
      const colors = mesh.useVertexColors ? values(VertexBuffer.ColorKind) : read(null), tangents = values(VertexBuffer.TangentKind);
      const subMeshes = mesh.subMeshes.map(part => [part.materialIndex, part.indexStart, part.indexCount]);
      cacheable &&= subMeshes.every(part => part.every(value => typeof value === 'number'));
      unchanged &&= !!previous && subMeshes.length === previous.subMeshes.length && subMeshes.every((part, i) =>
        part.every((value, j) => Object.is(value, previous.subMeshes[i][j])));
      if (unchanged && cacheable) return previous!.hash;
      const hash = lightingContentHash({ positions: canonical(positions), normals: canonical(normals), indices: canonical(indices),
        uvs: canonical(uvs), uvs2: canonical(uvs2), colors: canonical(colors), tangents: canonical(tangents), subMeshes });
      if (cacheable) {
        if (previous && !previous.released) {
          for (const snapshot of previous.snapshots) this.release(snapshot);
          previous.fields = fields; previous.subMeshes = subMeshes; previous.snapshots = retained; previous.hash = hash;
        } else {
          const entry: Entry = { fields, subMeshes, snapshots: retained, hash, released: false, disposeObserver: null };
          this.entries.set(mesh, entry);
          this.finalizer.register(mesh, entry, entry);
          entry.disposeObserver = mesh.onDisposeObservable.addOnce(this.disposeListener(entry));
        }
        committed = true;
      } else {
        this.discard(mesh);
        // 同一 Geometry 已超过预算时直接保留原路径，避免每次 dirty 都分配部分大快照后再放弃。
        if (reservation.exceeded && geometry instanceof Geometry) this.overBudgetGeometries.set(mesh, geometry);
      }
      return hash;
    } finally { if (!committed) for (const snapshot of retained) this.release(snapshot); }
  }

  private snapshot(data: NumericArray, copied: number[] | null, constructor: NumericConstructor | null,
    previous: Snapshot | null, retained: Set<Snapshot>, reservation: { exceeded: boolean }): Snapshot | null {
    const raw = constructor ? new Uint8Array(viewBuffer(data as NumericTypedArray), viewOffset(data as NumericTypedArray), viewBytes(data as NumericTypedArray)) : null;
    const type = constructor ?? Float64Array;
    const equal = (snapshot: Snapshot) => {
      if (snapshot.constructor !== type) return false;
      if (raw) return equalBytes(raw, snapshot.bytes);
      if (viewBytes(snapshot.bytes) !== copied!.length * 8) return false;
      const before = numbers(snapshot);
      return copied!.every((value, i) => Object.is(value, before[i]));
    };
    let pool: Map<string, WeakRef<Snapshot>> | undefined, key = '';
    if (raw) {
      pool = this.sharedViews.get(viewBuffer(raw));
      key = `${typedConstructors.indexOf(type)}/${viewOffset(raw)}/${viewBytes(raw)}`;
    }
    let snapshot = previous && equal(previous) ? previous : undefined;
    if (!snapshot) {
      const shared = raw ? pool?.get(key)?.deref() : this.sharedArrays.get(data)?.deref();
      if (shared && equal(shared)) snapshot = shared;
    }
    const bytes = raw ? viewBytes(raw) : copied!.length * 8;
    if (!snapshot) {
      if (this.retainedBytes + bytes > this.budget) { reservation.exceeded = true; return null; }
      snapshot = { bytes: snapshotBytes(raw, copied), constructor: type, references: 0 };
      if (raw) {
        if (!pool) { pool = new Map(); this.sharedViews.set(viewBuffer(raw), pool); }
        if (pool.size >= 64 && !pool.has(key)) pool.delete(pool.keys().next().value!);
        pool.set(key, new WeakRef(snapshot));
      } else this.sharedArrays.set(data, new WeakRef(snapshot));
    }
    return this.retain(snapshot, retained, reservation);
  }

  private retain(snapshot: Snapshot, retained: Set<Snapshot>, reservation: { exceeded: boolean }): Snapshot | null {
    if (!retained.has(snapshot)) {
      if (!snapshot.references && this.retainedBytes + viewBytes(snapshot.bytes) > this.budget) { reservation.exceeded = true; return null; }
      if (!snapshot.references++) this.retainedBytes += viewBytes(snapshot.bytes);
      retained.add(snapshot);
    }
    return snapshot;
  }
  private release(snapshot: Snapshot): void { if (--snapshot.references === 0) this.retainedBytes -= viewBytes(snapshot.bytes); }
  private disposeListener(entry: Entry): (node: import('@babylonjs/core/node.js').Node) => void {
    // 独立闭包工厂不能共享 getHash 中捕获 mesh 的环境，否则 FinalizationRegistry 会间接保住宿主。
    return node => { this.disposedMeshes.add(node as Mesh); this.releaseEntry(entry); };
  }
  private releaseEntry(entry: Entry): void {
    if (entry.released) return;
    entry.released = true;
    for (const snapshot of entry.snapshots) this.release(snapshot);
    entry.snapshots.clear(); entry.fields = []; entry.subMeshes = [];
    entry.disposeObserver = null;
    this.finalizer.unregister(entry);
  }
  private discard(mesh: Mesh): void {
    const entry = this.entries.get(mesh);
    if (entry) { mesh.onDisposeObservable.remove(entry.disposeObserver); this.releaseEntry(entry); }
    this.entries.delete(mesh);
  }
  private originalHash(mesh: Mesh): string {
    const values = (kind: string) => { const data = mesh.getVerticesData(kind); return data ? Array.from(data) : null; };
    return lightingContentHash({ positions: values(VertexBuffer.PositionKind), normals: values(VertexBuffer.NormalKind),
      indices: Array.from(mesh.getIndices() ?? []), uvs: values(VertexBuffer.UVKind), uvs2: values(VertexBuffer.UV2Kind),
      colors: mesh.useVertexColors ? values(VertexBuffer.ColorKind) : null, tangents: values(VertexBuffer.TangentKind),
      subMeshes: mesh.subMeshes.map(part => [part.materialIndex, part.indexStart, part.indexCount]) });
  }
}

export const lightingGeometrySignatureCache = new LightingGeometrySignatureCache();
