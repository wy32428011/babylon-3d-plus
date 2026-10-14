export type CadReferenceLoadStatus = {
  entityId: string;
  sourceUrl: string;
  state: 'loading' | 'rendering' | 'ready' | 'error' | 'canceled';
  percent: number;
  detail: string;
};

const statuses = new Map<string, CadReferenceLoadStatus>();
const listeners = new Set<(status: CadReferenceLoadStatus) => void>();
const cancellations = new Map<string, () => void>();

/** CAD 加载状态只存在于当前编辑器会话，不写入场景或撤销历史。 */
export function publishCadReferenceLoadStatus(status: CadReferenceLoadStatus): void {
  statuses.set(status.entityId, status);
  for (const listener of listeners) listener(status);
}

export function getCadReferenceLoadStatus(entityId: string): CadReferenceLoadStatus | null {
  return statuses.get(entityId) ?? null;
}

export function subscribeCadReferenceLoadStatus(listener: (status: CadReferenceLoadStatus) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function registerCadReferenceLoadCancellation(entityId: string, cancel: () => void): () => void {
  cancellations.set(entityId, cancel);
  return () => { if (cancellations.get(entityId) === cancel) cancellations.delete(entityId); };
}

export function cancelCadReferenceLoad(entityId: string): void {
  cancellations.get(entityId)?.();
}

/** 删除或切换场景立即解除等待，避免后台标签页暂停渲染后任务悬挂。 */
export function forgetCadReferenceLoadStatus(entityId: string): void {
  const previous = statuses.get(entityId);
  publishCadReferenceLoadStatus({ entityId, sourceUrl: previous?.sourceUrl ?? '', state: 'canceled', percent: previous?.percent ?? 0, detail: 'CAD 加载已取消。' });
  statuses.delete(entityId);
  cancellations.delete(entityId);
}

function createCadAbortError(): Error {
  const error = new Error('CAD 加载已取消。');
  error.name = 'AbortError';
  return error;
}

/** 等待运行时完成包含 CAD 的真实渲染帧；创建 Mesh 本身不代表完成。 */
export function waitForCadReferenceReady(
  entityId: string,
  options: { signal?: AbortSignal; onProgress?: (status: CadReferenceLoadStatus) => void } = {},
): Promise<void> {
  if (options.signal?.aborted) return Promise.reject(createCadAbortError());
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      unsubscribe();
      options.signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve();
    };
    const abort = (): void => finish(createCadAbortError());
    const receive = (status: CadReferenceLoadStatus): void => {
      if (status.entityId !== entityId || settled) return;
      options.onProgress?.(status);
      if (status.state === 'ready') finish();
      else if (status.state === 'error') finish(new Error(status.detail));
      else if (status.state === 'canceled') finish(createCadAbortError());
    };
    const unsubscribe = subscribeCadReferenceLoadStatus(receive);
    options.signal?.addEventListener('abort', abort, { once: true });
    const current = statuses.get(entityId);
    if (options.signal?.aborted) abort();
    else if (current) receive(current);
  });
}

/** 多图加载优先展示活动任务；全部结束后保留失败信息，避免小图完成遮住大图。 */
export function selectCadReferenceRuntimeProgress(
  statuses: readonly CadReferenceLoadStatus[], preferredEntityId?: string,
): { status: CadReferenceLoadStatus; activeCount: number } | null {
  const active = statuses.filter(status => status.state === 'loading' || status.state === 'rendering');
  const status = active.find(status => status.entityId === preferredEntityId) ?? active[0]
    ?? statuses.find(status => status.state === 'error') ?? statuses.at(-1);
  return status ? { status, activeCount: active.length } : null;
}
