import { createConnectedLimbMask, createProceduralStrideTargets, type ProceduralLimbSelection,
  type ProceduralStrideTargetOptions, type ProceduralStrideTargets } from './proceduralAvatarAnimation';

export type ProceduralWorkerRequest = {
  positions: Float64Array; indices: Float64Array; normals: Float64Array | null; tangents: Float64Array | null;
  selection: ProceduralLimbSelection; options: ProceduralStrideTargetOptions;
};
export type ProceduralWorkerResponse = { result: ProceduralStrideTargets | null } | { error: string };

// 包括快照、顶点输出、并查集及 JS 分组结构的保守估算；不是进程内存硬上限。
export const MAX_PROCEDURAL_WORKER_ESTIMATED_BYTES = 32 * 1024 * 1024;
export function estimateProceduralStrideWorkingBytes(
  positions: ArrayLike<number>, indices: ArrayLike<number>, normals: ArrayLike<number> | null,
  tangents: ArrayLike<number> | null,
): number {
  const vertices = Math.floor(positions.length / 3);
  const snapshotBytes = (positions.length + indices.length + (normals?.length ?? 0) + (tangents?.length ?? 0)) * 8;
  const outputBytes = (positions.length + (normals?.length ?? 0) + (tangents ? vertices * 3 : 0)) * 3 * 4;
  // JS Map/数组的真实开销随引擎而变化，按每顶点 512 字节预留并查集及最碎片化分组。
  return snapshotBytes + outputBytes + vertices * 512 + indices.length * 16;
}

export async function calculateProceduralStride(
  positions: ArrayLike<number>, indices: ArrayLike<number>, normals: ArrayLike<number> | null,
  tangents: ArrayLike<number> | null, selection: ProceduralLimbSelection,
  options: ProceduralStrideTargetOptions, signal?: AbortSignal,
): Promise<ProceduralStrideTargets | null> {
  signal?.throwIfAborted();
  const fallback = () => createProceduralStrideTargets(positions, {
    ...options, normals, tangents, limbMask: createConnectedLimbMask(positions, indices, selection),
  });
  const estimatedBytes = estimateProceduralStrideWorkingBytes(positions, indices, normals, tangents);
  if (typeof Worker === 'undefined' || estimatedBytes > MAX_PROCEDURAL_WORKER_ESTIMATED_BYTES) return fallback();
  try {
    const worker = new Worker(new URL('./proceduralAvatarStride.worker.ts', import.meta.url), { type: 'module' });
    try {
      const request: ProceduralWorkerRequest = {
        positions: Float64Array.from(positions), indices: Float64Array.from(indices),
        normals: normals ? Float64Array.from(normals) : null,
        tangents: tangents ? Float64Array.from(tangents) : null, selection, options,
      };
      return await new Promise<ProceduralStrideTargets | null>((resolve, reject) => {
        let done = false;
        const finish = (error?: unknown, result?: ProceduralStrideTargets | null) => {
          if (done) return;
          done = true;
          signal?.removeEventListener('abort', abort);
          worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null;
          if (error !== undefined) reject(error); else resolve(result ?? null);
        };
        const abort = () => finish(signal?.reason ?? new DOMException('人物步态生成已取消。', 'AbortError'));
        worker.onmessage = (event: MessageEvent<ProceduralWorkerResponse>) => {
          if ('error' in event.data) finish(new Error(event.data.error)); else finish(undefined, event.data.result);
        };
        worker.onerror = event => finish(new Error(event.message || '人物步态 Worker 失败。'));
        worker.onmessageerror = () => finish(new Error('人物步态 Worker 返回数据失败。'));
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) { abort(); return; }
        const transfers: Transferable[] = [];
        for (const data of [request.positions, request.indices, request.normals, request.tangents]) {
          if (!data) continue;
          if (!(data.buffer instanceof ArrayBuffer)) { finish(new Error('人物步态快照缓冲区不可转移。')); return; }
          transfers.push(data.buffer);
        }
        try { worker.postMessage(request, transfers); } catch (error) { finish(error); }
      });
    } finally { worker.terminate(); }
  } catch (error) {
    signal?.throwIfAborted();
    // Worker 不可用时恢复原有算法，不将后台初始化失败当作人物加载失败。
    console.warn('人物步态后台计算不可用，使用原有计算方式。', error);
    return fallback();
  }
}
