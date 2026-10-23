/** 取消只结束当前调用的等待，底层资源事务仍由其自身的版本/取消机制负责恢复。 */
export function awaitLightingTaskStep<T>(step: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return step;
  if (signal.aborted) {
    // 调用参数在进入本函数前就已启动，取消也必须接住该步骤的迟到拒绝。
    void step.catch(() => undefined);
    return Promise.reject(signal.reason ?? new Error('光照烘焙已取消。'));
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => { cleanup(); reject(signal.reason ?? new Error('光照烘焙已取消。')); };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    step.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    if (signal.aborted) abort();
  });
}
