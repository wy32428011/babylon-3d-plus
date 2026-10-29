import type { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import type { Scene } from '@babylonjs/core/scene.js';

export type MatrixUploadRange = { start: number; count: number };
type UploadMetrics = { fullUploads: number; partialUploads: number; skippedUploads: number; uploadedBytes: number; contextRestores: number };
const states = new WeakMap<Scene, { enabled: boolean; metrics: UploadMetrics }>();
const restoreRegistered = new WeakSet<Mesh>();

function stateFor(scene: Scene) {
  let state = states.get(scene);
  if (!state) {
    state = { enabled: false, metrics: { fullUploads: 0, partialUploads: 0, skippedUploads: 0, uploadedBytes: 0, contextRestores: 0 } };
    states.set(scene, state);
  }
  return state;
}

/** 场景会话级实验开关；功能及净收益验收前不改变产品默认值。 */
export function setSparseMatrixUploadsEnabled(scene: Scene, enabled: boolean): void { stateFor(scene).enabled = enabled; }
export function sparseMatrixUploadsEnabled(scene: Scene): boolean { return states.get(scene)?.enabled ?? false; }
export function getMatrixUploadMetrics(scene: Scene): Readonly<UploadMetrics & { enabled: boolean }> {
  const state = stateFor(scene);
  return { enabled: state.enabled, ...state.metrics };
}

/**
 * 在既有矩阵复制中收集变化行，不额外保存整个缓冲镜像。undefined 表示走原全量上传，空数组表示无需上传。
 * 阈值属于实验策略：至少64行、至多8段且不超过1/4的行变化；验收前保持关闭。
 */
export function copyMatrixRows(target: Float32Array, source: Float32Array, count: number,
  compare: boolean, sourceIndexes?: Uint32Array): MatrixUploadRange[] | undefined {
  if (!Number.isInteger(count) || count < 0 || count * 16 > target.length
    || (!sourceIndexes && count * 16 > source.length) || (sourceIndexes && count > sourceIndexes.length)) {
    throw new RangeError('实例矩阵复制范围无效。');
  }
  let ranges: MatrixUploadRange[] | undefined = compare && count >= 64 && target.buffer !== source.buffer ? [] : undefined;
  if (!ranges && !sourceIndexes) {
    target.set(source.subarray(0, count * 16));
    return undefined;
  }
  let changed = 0;
  const targetBits = ranges ? new Uint32Array(target.buffer, target.byteOffset, target.length) : null;
  const sourceBits = ranges ? new Uint32Array(source.buffer, source.byteOffset, source.length) : null;
  for (let row = 0; row < count; row++) {
    const from = (sourceIndexes ? sourceIndexes[row] : row) * 16;
    const to = row * 16;
    if (from + 16 > source.length) throw new RangeError('实例源矩阵索引越界。');
    if (ranges && targetBits && sourceBits) {
      let different = false;
      for (let component = 0; component < 16; component++) {
        if (targetBits[to + component] !== sourceBits[from + component]) { different = true; break; }
      }
      if (different) {
        const last = ranges[ranges.length - 1];
        if (last && last.start + last.count === row) last.count++;
        else ranges.push({ start: row, count: 1 });
        if (++changed > count / 4 || ranges.length > 8) ranges = undefined;
      }
    }
    target.set(source.subarray(from, from + 16), to);
  }
  return ranges;
}

/** 已知脏行由权威变换增量产生，不依赖实验性的全缓冲比较开关；碎片过多时仍合并为一次全量上传。 */
export function matrixUploadRangesForRows(rows: readonly number[], count: number): MatrixUploadRange[] | undefined {
  const ranges: MatrixUploadRange[] = [];
  let previous = -1;
  for (const row of rows) {
    if (!Number.isInteger(row) || row <= previous || row >= count) throw new RangeError('实例矩阵脏行范围无效。');
    const last = ranges[ranges.length - 1];
    if (last && last.start + last.count === row) last.count++;
    else ranges.push({ start: row, count: 1 });
    previous = row;
  }
  return ranges.length > 8 || rows.length > count / 4 ? undefined : ranges;
}

/** 9.12 的 updateDirectly 会丢弃 Buffer 的恢复镜像，恢复后从 thinInstance 权威矩阵重新上传。 */
function registerMatrixRestore(mesh: Mesh): void {
  if (restoreRegistered.has(mesh)) return;
  restoreRegistered.add(mesh);
  const engine = mesh.getEngine();
  const observer = engine.onContextRestoredObservable.add(() => {
    if (mesh.isDisposed()) return;
    mesh.thinInstanceBufferUpdated('matrix');
    stateFor(mesh.getScene()).metrics.contextRestores++;
  });
  mesh.onDisposeObservable.addOnce(() => { engine.onContextRestoredObservable.remove(observer); });
}

/** 调用方须已更新原矩阵数组；数字重载的 offset/count 均为实例数，不是 float/byte 偏移。 */
export function uploadMatrixRanges(mesh: Mesh, ranges: readonly MatrixUploadRange[] | undefined, count: number): void {
  const metrics = stateFor(mesh.getScene()).metrics;
  if (!ranges) {
    if (sparseMatrixUploadsEnabled(mesh.getScene())) registerMatrixRestore(mesh);
    if (restoreRegistered.has(mesh)) mesh._thinInstanceDataStorage.worldMatrices = null;
    mesh.thinInstanceBufferUpdated('matrix');
    metrics.fullUploads++; metrics.uploadedBytes += count * 64;
    return;
  }
  if (ranges.length === 0) { metrics.skippedUploads++; return; }
  let end = 0;
  for (const range of ranges) {
    if (!Number.isInteger(range.start) || !Number.isInteger(range.count) || range.start < end || range.count <= 0 || range.start + range.count > count) {
      throw new RangeError('实例矩阵局部上传范围无效。');
    }
    end = range.start + range.count;
  }
  registerMatrixRestore(mesh);
  // 与 thinInstanceSetBuffer 的失效行为一致；避免 SDK 已缓存的世界矩阵仍指向上次数据。
  mesh._thinInstanceDataStorage.worldMatrices = null;
  for (const range of ranges) {
    mesh.thinInstancePartialBufferUpdate('matrix', range.count, range.start);
    metrics.partialUploads++; metrics.uploadedBytes += range.count * 64;
  }
}

export function recordMatrixAllocation(mesh: Mesh, bytes: number): void {
  const metrics = stateFor(mesh.getScene()).metrics;
  metrics.fullUploads++; metrics.uploadedBytes += bytes;
}
