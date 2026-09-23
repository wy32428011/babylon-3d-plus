/** 缓存只是加速能力；包括响应体和浏览器存储调用在内，初始化总预算不能阻挡普通首帧。 */
export async function withPublishedCacheSetupBudget<T>(parent: AbortSignal, setup: (signal: AbortSignal) => Promise<T>, timeoutMs = 15_000): Promise<T> {
  parent.throwIfAborted();
  const timeout = new AbortController();
  const signal = AbortSignal.any([parent, timeout.signal]);
  const timer = setTimeout(() => timeout.abort(new DOMException('发布缓存初始化超时，继续普通加载。', 'TimeoutError')), timeoutMs);
  try {
    return await new Promise<T>((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      // 有的浏览器 API 不接受 AbortSignal，竞争超时返回并消费其迟到结果/异常。
      Promise.resolve().then(() => setup(signal)).then(value => {
        signal.removeEventListener('abort', abort); resolve(value);
      }, error => { signal.removeEventListener('abort', abort); reject(error); });
    });
  } finally { clearTimeout(timer); }
}
