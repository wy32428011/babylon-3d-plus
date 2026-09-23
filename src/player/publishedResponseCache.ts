export interface PublishedResponseCacheFile {
  path: string;
  size: number;
  sha256: string;
  contentType: string;
  storage: 'asset' | 'response';
}

export interface PublishedResponseCacheManifest {
  version: 1;
  cacheRevision: string;
  totalBytes: number;
  files: PublishedResponseCacheFile[];
}

export interface PublishedResponseCacheSession {
  available: boolean;
  reason?: string;
  ensure(file: PublishedResponseCacheFile): Promise<boolean>;
  has(file: PublishedResponseCacheFile): Promise<boolean>;
  dispose(): void;
}

const SETUP_TIMEOUT_MS = 15_000;
const RESOURCE_TIMEOUT_MS = 120_000;
type WorkerReply = { ok: boolean; reason?: string; code?: string };

function unavailable(reason: string): PublishedResponseCacheSession {
  return { available: false, reason, ensure: async () => false, has: async () => false, dispose() {} };
}

/** 在独立、不可变的发布目录安装响应缓存。调用方负责容量准入和预缓存并发。 */
export async function installPublishedResponseCache(
  baseUrl: string,
  manifest: PublishedResponseCacheManifest,
  signal?: AbortSignal,
): Promise<PublishedResponseCacheSession> {
  if (signal?.aborted) return unavailable('缓存安装已取消');
  if (typeof window === 'undefined' || !window.isSecureContext || !navigator.serviceWorker) return unavailable('当前环境不支持安全的 Service Worker 缓存');
  let base: URL;
  try { base = new URL(baseUrl, window.location.href); }
  catch { return unavailable('发布地址无效'); }
  if (base.origin !== window.location.origin || base.search || base.hash || !/\/digital-twin\/releases\/\d+\/\d+\/$/.test(base.pathname)) return unavailable('响应缓存仅支持同源不可变发布目录');
  const workerUrl = new URL('published-cache-worker.js', base).href;
  const sessionId = crypto.randomUUID();
  let worker: ServiceWorker | null = null;
  let disposed = false;
  let sequence = 0;
  const pending = new Set<() => void>();
  const notify = (message: Record<string, unknown>) => {
    try { worker?.postMessage({ protocol: 1, sessionId, ...message }); }
    catch { /* 已结束的 worker 无需再接收取消通知。 */ }
  };

  const send = (type: string, path?: string, timeout = RESOURCE_TIMEOUT_MS): Promise<WorkerReply> => {
    if (disposed || !worker || signal?.aborted) return Promise.resolve({ ok: false, reason: '缓存会话已关闭' });
    const requestId = String(++sequence);
    return new Promise(resolve => {
      const channel = new MessageChannel();
      let settled = false;
      const finish = (value: WorkerReply) => {
        if (settled) return;
        settled = true; clearTimeout(timer); pending.delete(cancel); channel.port1.close(); channel.port2.close(); resolve(value);
      };
      const cancel = () => {
        notify({ type: 'cancel', requestId });
        finish({ ok: false, reason: '缓存操作已取消或超时' });
      };
      const timer = setTimeout(cancel, timeout);
      pending.add(cancel);
      channel.port1.onmessage = event => finish(event.data?.ok === true ? { ok: true } : { ok: false, reason: event.data?.reason, code: event.data?.code });
      try { worker!.postMessage({ protocol: 1, type, sessionId, requestId, path, cacheRevision: manifest.cacheRevision }, [channel.port2]); }
      catch (error) { finish({ ok: false, reason: String(error) }); }
    });
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    signal?.removeEventListener('abort', dispose);
    for (const cancel of [...pending]) cancel();
    notify({ type: 'dispose' });
  };
  signal?.addEventListener('abort', dispose, { once: true });
  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
        error ? reject(error) : resolve();
      };
      const abort = () => finish(new Error('缓存安装已取消'));
      const timer = setTimeout(() => finish(new Error('缓存注册超时')), SETUP_TIMEOUT_MS);
      signal?.addEventListener('abort', abort, { once: true });
      navigator.serviceWorker.register(workerUrl, { scope: base.href, updateViaCache: 'none' }).then(() => finish(), error => finish(error));
    });
    if (disposed) return unavailable('缓存安装已取消');
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer); navigator.serviceWorker.removeEventListener('controllerchange', check); signal?.removeEventListener('abort', abort);
        error ? reject(error) : resolve();
      };
      const check = () => {
        const controller = navigator.serviceWorker.controller;
        if (controller?.scriptURL === workerUrl) { worker = controller; finish(); }
      };
      const abort = () => finish(new Error('缓存安装已取消'));
      const timer = setTimeout(() => finish(new Error('缓存控制器接管超时')), SETUP_TIMEOUT_MS);
      navigator.serviceWorker.addEventListener('controllerchange', check);
      signal?.addEventListener('abort', abort, { once: true });
      // 已激活不代表本页已接管；等待本页 controller，不能强制刷新旧页面。
      check();
    });
    const result = await send('configure', undefined, SETUP_TIMEOUT_MS);
    if (!result.ok) { dispose(); return unavailable(result.reason ?? '响应缓存初始化失败'); }
    const knownFiles = new Map(manifest.files.filter(file => file.storage === 'response').map(file => [file.path, file]));
    const accepts = (file: PublishedResponseCacheFile) => {
      const known = knownFiles.get(file.path);
      return known && known.size === file.size && known.sha256 === file.sha256 && file.storage === 'response';
    };
    let reconnecting: Promise<WorkerReply> | null = null;
    const resourceRequest = async (type: 'ensure' | 'has', file: PublishedResponseCacheFile) => {
      if (!accepts(file)) return false;
      const reply = await send(type, file.path);
      if (reply.code !== 'SESSION_MISSING') return reply.ok;
      // 浏览器会终止空闲 SW；持久内容仍在，只需重建该客户端会话，最多重试一次。
      if (!reconnecting) reconnecting = send('configure', undefined, SETUP_TIMEOUT_MS).finally(() => { reconnecting = null; });
      if (!(await reconnecting).ok) return false;
      return (await send(type, file.path)).ok;
    };
    return {
      available: true,
      ensure: file => resourceRequest('ensure', file),
      has: file => resourceRequest('has', file),
      dispose,
    };
  } catch (error) {
    dispose();
    return unavailable(error instanceof Error ? error.message : String(error));
  }
}
