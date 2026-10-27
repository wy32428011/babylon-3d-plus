import { assertLightingRendererHeadroom, assertLightingWorkingBytes } from '../../../electron/shared/sceneLightingBakeResources.ts';
import { compactLightingGeometry, type CompactLightingGeometry, type LightingGeometryChannels } from './lightingGeometryCompact.ts';

let active = false;
const COMPACT_WORKER_TIMEOUT_MS = 5 * 60_000;

// 保存标准 TypedArray 元数据描述符；脚本替换实例或原型 getter 时保留原读取路径。
const typedArrayPrototype = Object.getPrototypeOf(Float32Array.prototype);
const metadataKeys = ['length', 'buffer', 'byteLength', 'byteOffset'] as const;
const standardMetadata = new Map(metadataKeys.map(key => [key, Object.getOwnPropertyDescriptor(typedArrayPrototype, key)]));
function stableChannel(value: ArrayLike<number> | undefined): boolean {
  if (!value || !ArrayBuffer.isView(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (!prototype || ![Float32Array.prototype, Float64Array.prototype, Uint8Array.prototype, Uint8ClampedArray.prototype,
    Uint16Array.prototype, Uint32Array.prototype, Int8Array.prototype, Int16Array.prototype, Int32Array.prototype].includes(prototype) ||
    Object.getPrototypeOf(prototype) !== typedArrayPrototype) return false;
  for (const key of metadataKeys) {
    const expected = standardMetadata.get(key);
    if (!expected || Object.prototype.hasOwnProperty.call(value, key) || Object.prototype.hasOwnProperty.call(prototype, key)) return false;
    const current = Object.getOwnPropertyDescriptor(typedArrayPrototype, key);
    if (!current || current.get !== expected.get || current.set !== expected.set || 'value' in current) return false;
  }
  // 检查描述符之后才读取 buffer，不能触发用户自定义 getter。
  return standardMetadata.get('buffer')!.get!.call(value) instanceof ArrayBuffer;
}

/** 快照保留在主线程供故障回退；不得转移仍由 Babylon 使用的源数组。 */
function snapshotGeometry(input: LightingGeometryChannels): LightingGeometryChannels {
  const copy = (source: ArrayLike<number>) => {
    const output = new Float64Array(source.length);
    for (let index = 0; index < source.length; index++) output[index] = source[index];
    return output;
  };
  const indices = new Uint32Array(input.indices.length);
  for (let index = 0; index < indices.length; index++) indices[index] = input.indices[index];
  return {
    indices, positions: copy(input.positions), normals: copy(input.normals),
    ...(input.uvs ? { uvs: copy(input.uvs) } : {}),
    ...(input.uvs2 ? { uvs2: copy(input.uvs2) } : {}),
    ...(input.colors ? { colors: copy(input.colors) } : {}),
    ...(input.tangents ? { tangents: copy(input.tangents) } : {}),
  };
}

/** 对单个 primitive 有界后台压缩，结果及回退均来自同一个不可变快照。 */
export async function compactLightingGeometryInWorker(input: LightingGeometryChannels, workingBytes: number,
  baselineBytes: number, signal?: AbortSignal): Promise<CompactLightingGeometry> {
  signal?.throwIfAborted();
  if (typeof Worker === 'undefined' || active || !stableChannel(input.indices) || !stableChannel(input.positions) ||
    !stableChannel(input.normals) || [input.uvs, input.uvs2, input.colors, input.tangents].some(value => value && !stableChannel(value))) {
    return compactLightingGeometry(input);
  }
  const snapshotBytes = input.indices.length * 4 +
    (input.positions.length + input.normals.length + (input.uvs?.length ?? 0) + (input.uvs2?.length ?? 0) +
      (input.colors?.length ?? 0) + (input.tangents?.length ?? 0)) * 8;
  // 稀疏 primitive 的完整源通道可能远超有效顶点；双快照（含结构化克隆）、后台压缩和失败回退同时计入准入。
  if (!Number.isSafeInteger(snapshotBytes) || snapshotBytes > baselineBytes) return compactLightingGeometry(input);
  try {
    assertLightingWorkingBytes(baselineBytes * 2 + snapshotBytes * 2, workingBytes, '烘焙几何后台压缩');
    assertLightingRendererHeadroom(baselineBytes * 2 + snapshotBytes * 2);
  } catch { return compactLightingGeometry(input); }
  active = true;
  let snapshot: LightingGeometryChannels | undefined;
  try {
    snapshot = snapshotGeometry(input);
    const frozen = snapshot;
    const result = await new Promise<CompactLightingGeometry>((resolve, reject) => {
      let worker: Worker | undefined, finished = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (error?: unknown, value?: CompactLightingGeometry) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        worker?.terminate();
        if (error !== undefined) reject(error); else resolve(value!);
      };
      const abort = () => finish(signal?.reason ?? new DOMException('烘焙几何压缩已取消。', 'AbortError'));
      try {
        worker = new Worker(new URL('./lightingGeometryCompact.worker.ts', import.meta.url), { type: 'module' });
        worker.onmessage = (event: MessageEvent<{ result?: CompactLightingGeometry; error?: string }>) => {
          const value = event.data?.result;
          if (event.data?.error !== undefined) { finish(new Error(event.data.error)); return; }
          if (!value || !(value.indices instanceof Uint32Array) || value.indices.length !== frozen.indices.length ||
            !(value.positions instanceof Float64Array) || value.positions.length % 3 !== 0 || !(value.normals instanceof Float64Array) ||
            value.normals.length !== value.positions.length) {
            finish(new Error('烘焙几何 Worker 返回了无效数据。')); return;
          }
          const vertices = value.positions.length / 3;
          for (const [field, width] of [['uvs', 2], ['uvs2', 2], ['colors', 4], ['tangents', 4]] as const) {
            if (frozen[field] && (!(value[field] instanceof Float64Array) || value[field]!.length !== vertices * width)) {
              finish(new Error('烘焙几何 Worker 返回了无效属性。')); return;
            }
          }
          finish(undefined, value);
        };
        worker.onerror = event => { event.preventDefault(); finish(new Error(event.message || '烘焙几何 Worker 执行失败。')); };
        worker.onmessageerror = () => finish(new Error('烘焙几何 Worker 数据传输失败。'));
        timer = setTimeout(() => finish(new Error('烘焙几何 Worker 超时。')), COMPACT_WORKER_TIMEOUT_MS);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) { abort(); return; }
        // 不转移快照：失败后必须从相同输入回退，不能重新读取已变化的场景数组。
        worker.postMessage(frozen);
      } catch (error) { finish(error); }
    });
    signal?.throwIfAborted();
    return result;
  } catch (error) {
    signal?.throwIfAborted();
    return compactLightingGeometry(snapshot ?? input);
  } finally {
    active = false;
  }
}
