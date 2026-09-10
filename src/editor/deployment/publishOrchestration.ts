/** 一次用户操作包含多个独立上传尝试；仅资源修订冲突可以自动重新对齐。 */
export async function publishWithResourceRetry<Result extends { status: string; errorCode: string | null }>(options: {
  createRequestId: () => string;
  assertCurrent: () => void;
  prepare: (requestId: string) => Promise<string>;
  publish: (requestId: string, sceneContent: string) => Promise<Result>;
}): Promise<{ result: Result; sceneContent: string }> {
  for (let attempt = 0; ; attempt++) {
    options.assertCurrent();
    const requestId = options.createRequestId();
    try {
      const sceneContent = await options.prepare(requestId);
      options.assertCurrent();
      const result = await options.publish(requestId, sceneContent);
      // 上传已经成功时必须保留服务端真实结果；调用方按会话身份决定是否回写编辑器。
      if (result.status !== 'conflict' || !isResourceConflict(result.errorCode) || attempt >= 2) {
        return { result, sceneContent };
      }
    } catch (error) {
      if (attempt >= 2 || !isResourceConflict(error)) throw error;
    }
  }
}

function isResourceConflict(error: unknown): boolean {
  const detail = typeof error === 'string' ? error : error instanceof Error ? error.message : '';
  return /\bDIGITAL_TWIN_RESOURCE_(?:REVISION|SNAPSHOT)_CONFLICT\b/.test(detail);
}

/** 恢复发生在一次已就绪同步之后，必须先重开首帧门控，再提交新的文档。 */
export function commitPublishRecovery(options: {
  beginRefresh: () => void;
  commit: () => boolean;
  settleRefresh: (error: string | null) => void;
}): void {
  options.beginRefresh();
  let failure: string | null = null;
  try {
    if (!options.commit()) throw new Error('恢复发布模型未能提交，已保留当前场景。');
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    options.settleRefresh(failure);
  }
}

/** 有界等待渲染/烘焙完成，每次检查都会验证取消与场景身份。 */
export async function waitForPublishCondition(options: {
  assertCurrent: () => void;
  ready: () => boolean;
  timeoutMs?: number;
  wait?: () => Promise<void>;
}): Promise<void> {
  const startedAt = performance.now();
  for (;;) {
    options.assertCurrent();
    if (options.ready()) return;
    if (performance.now() - startedAt >= (options.timeoutMs ?? 180_000)) throw new Error('等待场景资源或静态阴影就绪超时，请检查具体资源后重试。');
    await (options.wait?.() ?? new Promise<void>(resolve => setTimeout(resolve, 100)));
  }
}
