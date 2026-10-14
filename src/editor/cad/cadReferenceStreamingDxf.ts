import type { CadReferenceBounds, CadReferenceLayerStat } from '../model/components';
import {
  CAD_REFERENCE_GRID_Y_OFFSET_METERS,
  CAD_REFERENCE_MAX_ABSOLUTE_COORDINATE,
  CAD_REFERENCE_MAX_INSERT_ARRAY_INSTANCES,
  CAD_REFERENCE_MAX_INSERT_DEPTH,
  convertDxfEntityToPolylines,
  readDxfEntityLayerName,
  type CadReferenceGeometryLayer,
  type CadReferenceParseResult,
  type CadReferencePoint2D,
  type DxfEntityRecord,
  type DxfInsertEntityRecord,
} from './cadReference';
import {
  CAD_REFERENCE_MAX_BATCH_POINTS,
  CAD_REFERENCE_MAX_BATCH_POLYLINES,
  CAD_REFERENCE_MAX_GEOMETRY_BYTES,
} from './cadReferenceGeometryPolicy';
import { parseScannedDxfEntity, type DxfGroupPair } from './cadReferenceLargeDxf';
import { createCadDxfStreamDecoder } from './cadTextEncoding';
import { createLegacyCadReferenceUnitInfo, resolveDxfUnitInfo } from './cadUnits';

type Affine2D = readonly [number, number, number, number, number, number];
type Bounds2D = { minX: number; minY: number; maxX: number; maxY: number };
type BlockHeader = { name: string; x: number; y: number; index: number };
type BatchPlan = {
  physicalPoints: number;
  physicalPolylines: number;
  entityCount: number;
  polylineCount: number;
  pointCount: number;
};
type GeometryDescriptor = {
  key: string;
  name: string;
  bounds: Bounds2D | null;
  batches: BatchPlan[];
  uses: Map<string, Affine2D[]>;
  chunks: Array<{ positions: Float32Array; counts: Uint32Array }>;
  writeBatch: number;
  writePoints: number;
  writePolylines: number;
};
type BlockDescriptor = BlockHeader & { geometry: GeometryDescriptor; inserts: DxfInsertEntityRecord[] };
type ScanCallbacks = {
  block(header: BlockHeader): void;
  entity(entity: DxfEntityRecord, owner: BlockHeader | null): void;
};
type Fingerprint = { bytes: number; hashes: number[]; headers: string[] };
export type CadReferenceDxfStreamOptions = {
  unitScaleToMeters?: number;
  signal?: AbortSignal;
  maxGeometryBytes?: number;
  onProgress?: (progress: { percent: number; detail: string }) => void;
};

const IDENTITY: Affine2D = [1, 0, 0, 1, 0, 0];
// 当前实体是唯一会短暂使用普通对象的部分；明确拒绝异常超长记录，防止中间对象无界增长。
const MAX_LINE_CHARACTERS = 1024 * 1024;
const MAX_ENTITY_GROUPS = 262_144;
const MAX_ENTITY_CHARACTERS = 16 * 1024 * 1024;
const MAX_ENTITY_POINTS = 1_000_000;
const HASH_WINDOW_BYTES = 1024 * 1024;
const MAX_INPUT_CHUNK_BYTES = 1024 * 1024;
const MESH_OVERHEAD_BYTES = 4096;
const SUPPORTED_TYPES = new Set(['LINE', 'ARC', 'CIRCLE', 'ELLIPSE', 'SPLINE', 'LWPOLYLINE', 'POLYLINE',
  'HATCH', 'SOLID', 'TRACE', '3DFACE', 'LEADER', 'INSERT']);

/** 两遍有界扫描：首遍只保留统计/引用，次遍直接填充可达原型的紧凑批次。 */
export async function parseCadReferenceDxfStream(
  openSource: () => Promise<Response>,
  options: CadReferenceDxfStreamOptions = {},
): Promise<CadReferenceParseResult> {
  const maxBytes = options.maxGeometryBytes ?? CAD_REFERENCE_MAX_GEOMETRY_BYTES;
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) throw new Error('CAD 几何内存预算必须是正的有限字节数。');
  const header: Record<string, number> = {};
  const blocks = new Map<string, BlockDescriptor>();
  const root = new Map<string, GeometryDescriptor>();
  const rootInserts: DxfInsertEntityRecord[] = [];
  let metadataBytes = 0;
  const reserveMetadata = (bytes: number) => {
    metadataBytes += bytes;
    enforceBudget(metadataBytes, maxBytes);
  };
  const first = await scanSource(openSource, options, 0, header, {
    block(info) {
      reserveMetadata(1024 + info.name.length * 2);
      blocks.set(info.name, { ...info, geometry: createDescriptor(`block:${info.index}`, '__BLOCK__'), inserts: [] });
    },
    entity(entity, owner) {
      if (entity.type === 'INSERT') {
        reserveMetadata(512 + (String(entity.layer ?? '').length + String((entity as DxfInsertEntityRecord).block ?? '').length) * 2);
        (owner ? blocks.get(owner.name)!.inserts : rootInserts).push(entity as DxfInsertEntityRecord);
        return;
      }
      const name = readDxfEntityLayerName(entity);
      const descriptor = owner ? blocks.get(owner.name)!.geometry : root.get(name) ?? createDescriptor(`root:${name}`, name);
      if (!owner && !root.has(name)) {
        reserveMetadata(512 + name.length * 2);
        root.set(name, descriptor);
      }
      consumeEntity(entity, owner ?? { x: 0, y: 0 }, (points, firstPolyline) => {
        for (const point of points) descriptor.bounds = expandBounds(descriptor.bounds, point.x, point.y);
        planPolyline(descriptor, points.length, firstPolyline, reserveMetadata);
      });
    },
  });

  const detected = resolveDxfUnitInfo(header);
  const unit = options.unitScaleToMeters === undefined || options.unitScaleToMeters === detected.unitScaleToMeters
    ? detected : createLegacyCadReferenceUnitInfo(options.unitScaleToMeters);
  collectUses(blocks, rootInserts, options.signal, reserveMetadata);
  const descriptors = [...root.values(), ...[...blocks.values()].filter((block) => block.geometry.uses.size > 0).map((block) => block.geometry)]
    .filter((descriptor) => descriptor.batches.length > 0);
  const drawingBounds = calculateBounds(root, descriptors);
  const center = { x: (drawingBounds.minX + drawingBounds.maxX) / 2, y: (drawingBounds.minY + drawingBounds.maxY) / 2 };
  const estimatedMemoryBytes = estimateMemory(descriptors, metadataBytes);
  enforceBudget(estimatedMemoryBytes, maxBytes);
  options.onProgress?.({ percent: 45, detail: `扫描完成，预计几何内存 ${(estimatedMemoryBytes / 1024 ** 2).toFixed(1)} MiB；生成线稿` });
  throwIfAborted(options.signal);

  await scanSource(openSource, options, 1, {}, {
    block() {},
    entity(entity, owner) {
      if (entity.type === 'INSERT') return;
      const descriptor = owner ? blocks.get(owner.name)?.geometry : root.get(readDxfEntityLayerName(entity));
      if (!descriptor || (owner && (blocks.get(owner.name)?.index !== owner.index || descriptor.uses.size === 0))) return;
      consumeEntity(entity, owner ?? { x: 0, y: 0 }, (points) => {
        writePolyline(descriptor, points, owner ? { x: 0, y: 0 } : center, unit.unitScaleToMeters, !owner);
      });
    },
  }, first);
  const layers = packLayers(descriptors, center, unit.unitScaleToMeters, root, options.signal);
  const summary = summarizeLayers(layers);
  options.onProgress?.({ percent: 90, detail: `线稿生成完成：${summary.polylineCount.toLocaleString()} 条折线` });
  return { ...unit, ...summary, bounds: createBounds(drawingBounds, unit.unitScaleToMeters), layers,
    budgetLimited: false, estimatedMemoryBytes };
}

function createDescriptor(key: string, name: string): GeometryDescriptor {
  return { key, name, bounds: null, batches: [], uses: new Map(), chunks: [], writeBatch: 0, writePoints: 0, writePolylines: 0 };
}

/** 完整保留长线，在续段开头重复一个衔接点；逻辑统计只计原始点和折线。 */
function visitPolylineSegments(
  pointCount: number,
  current: () => { points: number; polylines: number },
  nextBatch: () => void,
  append: (start: number, count: number) => void,
): void {
  let start = 0;
  while (start < pointCount - 1) {
    const used = current();
    if (CAD_REFERENCE_MAX_BATCH_POINTS - used.points < 2 || used.polylines >= CAD_REFERENCE_MAX_BATCH_POLYLINES) {
      nextBatch();
      continue;
    }
    const count = Math.min(pointCount - start, CAD_REFERENCE_MAX_BATCH_POINTS - used.points);
    append(start, count);
    if (start + count === pointCount) return;
    start += count - 1;
  }
}

function planPolyline(descriptor: GeometryDescriptor, count: number, firstPolyline: boolean, reserve: (bytes: number) => void): void {
  const newBatch = () => {
    reserve(256);
    descriptor.batches.push({ physicalPoints: 0, physicalPolylines: 0, entityCount: 0, polylineCount: 0, pointCount: 0 });
  };
  if (descriptor.batches.length === 0) newBatch();
  visitPolylineSegments(count, () => {
    const batch = descriptor.batches[descriptor.batches.length - 1];
    return { points: batch.physicalPoints, polylines: batch.physicalPolylines };
  }, newBatch, (start, points) => {
    const batch = descriptor.batches[descriptor.batches.length - 1];
    batch.physicalPoints += points;
    batch.physicalPolylines += 1;
    batch.pointCount += points - (start === 0 ? 0 : 1);
    if (start === 0) {
      batch.polylineCount += 1;
      if (firstPolyline) batch.entityCount += 1;
    }
  });
}

function writePolyline(descriptor: GeometryDescriptor, points: CadReferencePoint2D[], center: CadReferencePoint2D, scale: number, root: boolean): void {
  visitPolylineSegments(points.length,
    () => ({ points: descriptor.writePoints, polylines: descriptor.writePolylines }),
    () => { descriptor.writeBatch += 1; descriptor.writePoints = 0; descriptor.writePolylines = 0; },
    (start, count) => {
      const batch = descriptor.batches[descriptor.writeBatch];
      if (!batch || descriptor.writePoints + count > batch.physicalPoints || descriptor.writePolylines >= batch.physicalPolylines) {
        throw new Error('CAD 两遍扫描的几何统计不一致，文件可能已变化。');
      }
      const chunk = descriptor.chunks[descriptor.writeBatch] ?? {
        positions: new Float32Array(batch.physicalPoints * 3), counts: new Uint32Array(batch.physicalPolylines),
      };
      descriptor.chunks[descriptor.writeBatch] = chunk;
      chunk.counts[descriptor.writePolylines++] = count;
      for (let index = start; index < start + count; index += 1) {
        const offset = descriptor.writePoints++ * 3;
        chunk.positions[offset] = (points[index].x - center.x) * scale;
        chunk.positions[offset + 1] = root ? CAD_REFERENCE_GRID_Y_OFFSET_METERS : 0;
        chunk.positions[offset + 2] = (points[index].y - center.y) * scale;
      }
    });
}

function consumeEntity(entity: DxfEntityRecord, base: CadReferencePoint2D,
  callback: (points: CadReferencePoint2D[], firstPolyline: boolean) => void): void {
  enforceEntityExpansion(entity);
  let contributed = false;
  for (const raw of convertDxfEntityToPolylines(entity, base)) {
    if (raw.length > MAX_ENTITY_POINTS) throw new Error('CAD 单实体离散点数超过安全上限。');
    const points = raw.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y)
      && Math.abs(point.x) <= CAD_REFERENCE_MAX_ABSOLUTE_COORDINATE && Math.abs(point.y) <= CAD_REFERENCE_MAX_ABSOLUTE_COORDINATE);
    if (points.length < 2) continue;
    callback(points, !contributed);
    contributed = true;
  }
}

function enforceEntityExpansion(entity: DxfEntityRecord): void {
  const record = entity as unknown as Record<string, unknown>;
  if (entity.type === 'ARC' || entity.type === 'ELLIPSE') {
    // 原转换器通过逐圈增加 endAngle 正规化；异常角度会使它停滞或分配过多点，必须提前拒绝。
    const start = readNumber(record.startAngle, 0);
    const end = readNumber(record.endAngle, Math.PI * 2);
    const angleLimit = (MAX_ENTITY_POINTS - 1) * Math.PI / 36;
    if (Math.abs(start) > angleLimit || Math.abs(end) > angleLimit || end - start > angleLimit) {
      throw new Error('CAD 单实体角度或离散点数超过安全上限。');
    }
  }
  if (entity.type === 'SPLINE') {
    const controls = Array.isArray(record.controlPoints) ? record.controlPoints.length : 0;
    const knots = Array.isArray(record.knots) ? record.knots.length : 0;
    const degree = Math.max(1, Math.floor(readNumber(record.degree, 1)));
    const segments = Math.min(96, Math.max(8, (controls - 1) * 3));
    if (degree < controls && knots >= controls + degree + 1 && (segments + 1) * (degree * degree + controls) > 16_000_000) {
      throw new Error('CAD 单实体样条计算量超过安全上限。');
    }
  }
  let points = 0;
  const countVertices = (vertices: unknown) => {
    if (!Array.isArray(vertices)) return;
    for (const vertex of vertices) {
      const bulge = typeof vertex === 'object' && vertex !== null ? (vertex as { bulge?: number }).bulge : 0;
      points += bulge ? 73 : 1;
    }
  };
  countVertices(record.vertices);
  if (entity.type === 'HATCH') {
    const loops = (record.boundary as { loops?: Array<{ entities?: Array<{ points?: unknown }> }> } | undefined)?.loops;
    for (const loop of loops ?? []) for (const boundary of loop.entities ?? []) countVertices(boundary.points);
  }
  if (points > MAX_ENTITY_POINTS) throw new Error('CAD 单实体离散点数超过安全上限。');
}

/** CPU 位置/计数、GPU 顶点/索引及索引生成缓冲区逐批核算；矩阵 CPU 共享、GPU 每网格独立。 */
function estimateMemory(descriptors: GeometryDescriptor[], metadataBytes: number): number {
  let bytes = metadataBytes;
  for (const descriptor of descriptors) {
    const groupCount = descriptor.uses.size || 1;
    const instances = [...descriptor.uses.values()].reduce((sum, transforms) => sum + transforms.length, 0);
    bytes += instances * 64;
    // 多显示组渲染时合并矩阵，额外 CPU 缓冲区跨原型批次共享。
    if (groupCount > 1) bytes += instances * 64;
    for (const batch of descriptor.batches) {
      bytes += batch.physicalPoints * 24 + batch.physicalPolylines * 4;
      bytes += (batch.physicalPoints - batch.physicalPolylines) * 8;
      bytes += groupCount * MESH_OVERHEAD_BYTES + instances * 64;
    }
  }
  return bytes;
}

function enforceBudget(bytes: number, maxBytes: number): void {
  if (bytes > maxBytes || !Number.isSafeInteger(bytes)) {
    throw new Error(`CAD 几何内存预算不足：预计 ${(bytes / 1024 ** 2).toFixed(1)} MiB，安全预算 ${(maxBytes / 1024 ** 2).toFixed(1)} MiB；未截断图纸。`);
  }
}

function collectUses(blocks: Map<string, BlockDescriptor>, inserts: DxfInsertEntityRecord[], signal: AbortSignal | undefined,
  reserve: (bytes: number) => void): void {
  type State = { inserts: DxfInsertEntityRecord[]; base: CadReferencePoint2D; transform: Affine2D; layer: string | null; path: string[]; depth: number };
  const stack: State[] = [{ inserts, base: { x: 0, y: 0 }, transform: IDENTITY, layer: null, path: [], depth: 0 }];
  while (stack.length > 0) {
    throwIfAborted(signal);
    const state = stack.pop()!;
    for (const insert of state.inserts) {
      const name = typeof insert.block === 'string' ? insert.block : '';
      const block = blocks.get(name);
      if (!block || state.depth >= CAD_REFERENCE_MAX_INSERT_DEPTH || state.path.includes(name)) continue;
      const layer = state.layer ?? readDxfEntityLayerName(insert);
      for (const local of insertTransforms(insert, state.base)) {
        const transform = multiplyAffine(state.transform, local);
        if (block.geometry.batches.length > 0) {
          reserve(128);
          const uses = block.geometry.uses.get(layer) ?? [];
          uses.push(transform);
          block.geometry.uses.set(layer, uses);
        }
        if (block.inserts.length > 0) {
          // 引用展开也纳入同一预算，防止层层阵列在几何分配前耗尽内存。
          reserve(128 + (state.path.length + 1) * 8);
          stack.push({ inserts: block.inserts, base: block, transform, layer, path: [...state.path, name], depth: state.depth + 1 });
        }
      }
    }
  }
}

function insertTransforms(insert: DxfInsertEntityRecord, base: CadReferencePoint2D): Affine2D[] {
  const rows = Math.max(1, Math.floor(readNumber(insert.rowCount, 1)));
  const columns = Math.max(1, Math.floor(readNumber(insert.columnCount, 1)));
  const total = rows * columns;
  if (total > CAD_REFERENCE_MAX_INSERT_ARRAY_INSTANCES) throw new Error(`INSERT 阵列包含 ${total} 个实例，超过单阵列安全上限 ${CAD_REFERENCE_MAX_INSERT_ARRAY_INSTANCES}。`);
  const rotation = readNumber(insert.rotation, 0) / 180 * Math.PI;
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const result: Affine2D[] = [];
  for (let row = 0; row < rows; row += 1) for (let column = 0; column < columns; column += 1) {
    const rowSpacing = readNumber(insert.rowSpacing, 0) * row;
    const columnSpacing = readNumber(insert.columnSpacing, 0) * column;
    let transform: Affine2D = [cos * readNumber(insert.scaleX, 1), sin * readNumber(insert.scaleX, 1),
      -sin * readNumber(insert.scaleY, 1), cos * readNumber(insert.scaleY, 1),
      readNumber(insert.x, 0) - base.x - sin * rowSpacing + cos * columnSpacing,
      readNumber(insert.y, 0) - base.y + cos * rowSpacing + sin * columnSpacing];
    if (readNumber(insert.extrusionZ, 1) === -1) transform = [-transform[0], transform[1], -transform[2], transform[3], -transform[4], transform[5]];
    result.push(transform);
  }
  return result;
}

function multiplyAffine(parent: Affine2D, child: Affine2D): Affine2D {
  return [parent[0] * child[0] + parent[2] * child[1], parent[1] * child[0] + parent[3] * child[1],
    parent[0] * child[2] + parent[2] * child[3], parent[1] * child[2] + parent[3] * child[3],
    parent[0] * child[4] + parent[2] * child[5] + parent[4], parent[1] * child[4] + parent[3] * child[5] + parent[5]];
}

function calculateBounds(root: Map<string, GeometryDescriptor>, descriptors: GeometryDescriptor[]): Bounds2D {
  let bounds: Bounds2D | null = null;
  for (const descriptor of root.values()) bounds = mergeBounds(bounds, descriptor.bounds);
  for (const descriptor of descriptors) {
    if (!descriptor.bounds) continue;
    const local = descriptor.bounds;
    for (const uses of descriptor.uses.values()) for (const transform of uses) {
      for (const x of [local.minX, local.maxX]) for (const y of [local.minY, local.maxY]) {
        bounds = expandBounds(bounds, transform[0] * x + transform[2] * y + transform[4], transform[1] * x + transform[3] * y + transform[5]);
      }
    }
  }
  if (!bounds) throw new Error('DXF 中没有可显示的线稿图元。');
  return bounds;
}

function packLayers(descriptors: GeometryDescriptor[], center: CadReferencePoint2D, scale: number,
  root: Map<string, GeometryDescriptor>, signal: AbortSignal | undefined): CadReferenceGeometryLayer[] {
  const layers: CadReferenceGeometryLayer[] = [];
  for (const descriptor of descriptors) {
    throwIfAborted(signal);
    if (descriptor.chunks.length !== descriptor.batches.length) throw new Error('CAD 两遍扫描的几何统计不一致，文件可能已变化。');
    const matricesByLayer = new Map<string, Float32Array>();
    for (const [name, transforms] of descriptor.uses) {
      const matrices = new Float32Array(transforms.length * 16);
      transforms.forEach((transform, index) => {
        matrices.set([transform[0], 0, transform[1], 0, 0, 1, 0, 0, transform[2], 0, transform[3], 0,
          (transform[4] - center.x) * scale, CAD_REFERENCE_GRID_Y_OFFSET_METERS, (transform[5] - center.y) * scale, 1], index * 16);
      });
      matricesByLayer.set(name, matrices);
    }
    const groups = root.get(descriptor.name) === descriptor ? [[descriptor.name, undefined] as const] : [...matricesByLayer.entries()];
    descriptor.chunks.forEach((chunk, index) => {
      const batch = descriptor.batches[index];
      for (const [name, matrices] of groups) {
        const instances = matrices ? matrices.length / 16 : 1;
        layers.push({ name, positions: chunk.positions, polylinePointCounts: chunk.counts, geometryKey: `${descriptor.key}:${index}`, isChunk: true,
          ...(matrices ? { instanceMatrices: matrices, instanceCount: instances } : {}),
          entityCount: batch.entityCount * instances, polylineCount: batch.polylineCount * instances, pointCount: batch.pointCount * instances });
      }
    });
  }
  return layers;
}

function summarizeLayers(layers: CadReferenceGeometryLayer[]): { layerStats: CadReferenceLayerStat[]; polylineCount: number; pointCount: number } {
  const stats = new Map<string, CadReferenceLayerStat>();
  let polylineCount = 0;
  let pointCount = 0;
  for (const layer of layers) {
    const stat = stats.get(layer.name) ?? { name: layer.name, entityCount: 0, polylineCount: 0, pointCount: 0 };
    stat.entityCount += layer.entityCount;
    stat.polylineCount += layer.polylineCount;
    stat.pointCount += layer.pointCount;
    stats.set(layer.name, stat);
    polylineCount += layer.polylineCount;
    pointCount += layer.pointCount;
  }
  return { layerStats: [...stats.values()], polylineCount, pointCount };
}

function createBounds(bounds: Bounds2D, scale: number): CadReferenceBounds {
  const x = (bounds.maxX - bounds.minX) * scale / 2;
  const z = (bounds.maxY - bounds.minY) * scale / 2;
  return { min: { x: -x, y: CAD_REFERENCE_GRID_Y_OFFSET_METERS, z: -z }, max: { x, y: CAD_REFERENCE_GRID_Y_OFFSET_METERS, z },
    size: { x: x * 2, y: 0, z: z * 2 }, center: { x: 0, y: CAD_REFERENCE_GRID_Y_OFFSET_METERS, z: 0 } };
}

function expandBounds(bounds: Bounds2D | null, x: number, y: number): Bounds2D {
  if (!bounds) return { minX: x, minY: y, maxX: x, maxY: y };
  bounds.minX = Math.min(bounds.minX, x); bounds.maxX = Math.max(bounds.maxX, x);
  bounds.minY = Math.min(bounds.minY, y); bounds.maxY = Math.max(bounds.maxY, y);
  return bounds;
}

function mergeBounds(left: Bounds2D | null, right: Bounds2D | null): Bounds2D | null {
  if (!right) return left;
  if (!left) return { ...right };
  expandBounds(left, right.minX, right.minY); expandBounds(left, right.maxX, right.maxY);
  return left;
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException('CAD 导入已取消。', 'AbortError');
}

/** 同步 tokenizer 每块处理所有 group；每次异步读取不产生逐 group Promise。 */
class StreamingScanner {
  private tail = '';
  private code: number | null = null;
  private section = '';
  private sectionPending = false;
  private variable = '';
  private blockHeader: BlockHeader | null = null;
  private blockStarted = false;
  private blockIndex = 0;
  private type = '';
  private groups: DxfGroupPair[] = [];
  private entityCharacters = 0;

  constructor(private readonly header: Record<string, number>, private readonly callbacks: ScanCallbacks) {}

  push(text: string, final = false): void {
    let start = 0;
    while (start < text.length) {
      const newline = text.indexOf('\n', start);
      if (newline < 0) break;
      const end = newline > start && text.charCodeAt(newline - 1) === 13 ? newline - 1 : newline;
      const part = text.slice(start, end);
      if (this.tail.length + part.length > MAX_LINE_CHARACTERS) throw new Error('CAD 文本行长度超过安全上限。');
      const line = this.tail ? this.tail + part : part;
      this.tail = '';
      this.line(line);
      start = newline + 1;
    }
    this.tail += text.slice(start);
    if (this.tail.length > MAX_LINE_CHARACTERS) throw new Error('CAD 文本行长度超过安全上限。');
    if (final) {
      if (this.tail.length > 0) this.line(this.tail.replace(/\r$/, ''));
      this.tail = '';
      if (this.code !== null) throw new Error('CAD/DXF 组码记录不完整。');
      this.flushEntity();
    }
  }

  private line(line: string): void {
    if (this.code === null) {
      if (!line.trim()) return;
      this.code = Number.parseInt(line, 10);
      if (!Number.isFinite(this.code)) throw new Error('CAD/DXF 包含无效组码。');
    } else {
      const code = this.code;
      this.code = null;
      this.group(code, line.trim());
    }
  }

  private group(code: number, value: string): void {
    if (code === 0) {
      if (this.type === 'POLYLINE' && (value === 'VERTEX' || value === 'SEQEND')) {
        this.append(code, value);
        if (value === 'SEQEND') this.flushEntity();
        return;
      }
      this.flushEntity();
      if (this.blockHeader && !this.blockStarted) {
        this.callbacks.block(this.blockHeader);
        this.blockStarted = true;
      }
      if (value === 'SECTION') { this.sectionPending = true; this.section = ''; return; }
      if (value === 'ENDSEC') { this.section = ''; this.blockHeader = null; return; }
      if (this.section === 'BLOCKS' && value === 'BLOCK') {
        this.blockHeader = { name: '', x: 0, y: 0, index: this.blockIndex++ };
        this.blockStarted = false;
        return;
      }
      if (value === 'ENDBLK') { this.blockHeader = null; return; }
      if ((this.section === 'ENTITIES' || (this.section === 'BLOCKS' && this.blockHeader)) && SUPPORTED_TYPES.has(value)) this.type = value;
      return;
    }
    if (this.sectionPending && code === 2) { this.section = value; this.sectionPending = false; return; }
    if (this.section === 'HEADER') {
      if (code === 9) this.variable = value.replace(/^\$/, '').toUpperCase();
      else if ((this.variable === 'INSUNITS' || this.variable === 'MEASUREMENT') && Number.isFinite(Number(value))) {
        this.header[this.variable] = Number(value); this.variable = '';
      }
      return;
    }
    if (this.blockHeader && !this.blockStarted) {
      if (code === 2 || code === 3) this.blockHeader.name = value || this.blockHeader.name;
      if (code === 10) this.blockHeader.x = Number(value) || 0;
      if (code === 20) this.blockHeader.y = Number(value) || 0;
      return;
    }
    if (this.type) this.append(code, value);
  }

  private append(code: number, value: string): void {
    if (this.groups.length >= MAX_ENTITY_GROUPS) throw new Error('CAD 单实体组码数量超过安全上限。');
    this.entityCharacters += value.length;
    if (this.entityCharacters > MAX_ENTITY_CHARACTERS) throw new Error('CAD 单实体文本长度超过安全上限。');
    this.groups.push({ code, value });
  }

  private flushEntity(): void {
    if (!this.type) return;
    const entity = parseScannedDxfEntity(this.type, this.groups);
    if (entity) this.callbacks.entity(entity, this.blockHeader);
    this.type = '';
    this.groups = [];
    this.entityCharacters = 0;
  }
}

/** 固定字节窗口校验不依赖 HTTP chunk 边界；未知 Content-Length 同样流式读取。 */
async function scanSource(openSource: () => Promise<Response>, options: CadReferenceDxfStreamOptions, pass: 0 | 1,
  header: Record<string, number>, callbacks: ScanCallbacks, expected?: Fingerprint): Promise<Fingerprint> {
  throwIfAborted(options.signal);
  const response = await openSource();
  const headers = ['content-length', 'etag', 'last-modified'].map((name) => response.headers.get(name) ?? '');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('CAD 文件没有可读取的字节流。');
  const abort = () => { void reader.cancel().catch(() => {}); };
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    throwIfAborted(options.signal);
    if (!response.ok) throw new Error(`CAD 文件读取失败（HTTP ${response.status}）。`);
    if (expected && headers.some((value, index) => value !== expected.headers[index])) throw new Error('CAD 两遍读取的文件头发生变化，无法保证图纸一致。');
    const scanner = new StreamingScanner(header, callbacks);
    const decoder = createCadDxfStreamDecoder();
    const hashes: number[] = [];
    let bytes = 0;
    let hash = 2166136261;
    let inWindow = 0;
    let lastProgress = 0;
    const total = Number(headers[0]) || 0;
    const finishWindow = () => {
      const value = hash >>> 0;
      if (expected && expected.hashes[hashes.length] !== value) throw new Error('CAD 两遍读取的文件内容发生变化，无法保证图纸一致。');
      hashes.push(value); hash = 2166136261; inWindow = 0;
    };
    options.onProgress?.({ percent: pass === 0 ? 0 : 45, detail: pass === 0 ? '扫描 DXF 图元、块引用与包围盒' : '生成 DXF 分块线稿' });
    throwIfAborted(options.signal);
    for (;;) {
      const item = await reader.read();
      throwIfAborted(options.signal);
      if (item.done) break;
      const chunk = item.value;
      for (let offset = 0; offset < chunk.byteLength; offset += MAX_INPUT_CHUNK_BYTES) {
        const part = chunk.subarray(offset, Math.min(offset + MAX_INPUT_CHUNK_BYTES, chunk.byteLength));
        for (let index = 0; index < part.byteLength; index += 1) {
          hash = Math.imul(hash ^ part[index], 16777619);
          inWindow += 1;
          if (inWindow === HASH_WINDOW_BYTES) finishWindow();
        }
        bytes += part.byteLength;
        scanner.push(decoder.decode(part));
        if (Date.now() - lastProgress >= 250) {
          const fraction = total > 0 ? Math.min(1, bytes / total) : 0;
          options.onProgress?.({ percent: (pass === 0 ? 0 : 45) + fraction * 45,
            detail: `${pass === 0 ? '扫描 DXF' : '生成线稿'}：已读取 ${(bytes / 1024 ** 2).toFixed(1)} MiB${total ? ` / ${(total / 1024 ** 2).toFixed(1)} MiB` : ''}` });
          lastProgress = Date.now();
          throwIfAborted(options.signal);
        }
      }
    }
    if (inWindow > 0) finishWindow();
    if (expected && (bytes !== expected.bytes || hashes.length !== expected.hashes.length)) throw new Error('CAD 两遍读取的文件长度发生变化，无法保证图纸一致。');
    if (total > 0 && total !== bytes) throw new Error('CAD 文件字节流不完整，实际长度与 Content-Length 不一致。');
    scanner.push(decoder.decode(undefined, true), true);
    return { bytes, hashes, headers };
  } catch (error) {
    await reader.cancel().catch(() => {});
    throwIfAborted(options.signal);
    throw error;
  } finally {
    options.signal?.removeEventListener('abort', abort);
    reader.releaseLock();
  }
}
