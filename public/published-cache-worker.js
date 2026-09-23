/* 发布目录独立作用域；只保存清单中的 response，模型原文仍由 IDB 管理。 */
const RESPONSE_CACHE_PREFIX = 'zending-published-response:v1:';
const scopeUrl = new URL(self.registration.scope);
const cachePrefix = RESPONSE_CACHE_PREFIX + encodeURIComponent(scopeUrl.href) + ':';
const metadataUrl = new URL('.published-response-metadata', scopeUrl).href;
const excludedPaths = /^(?:runtime-config\.json|release-cache-manifest\.json|published-cache-worker\.js|\.published-response-metadata|README[^/]*|api(?:\/|$))/i;
let configuration = null;
let restorePromise;
const sessions = new Map();
const operations = new Map();
const downloads = new Map();

// SHA-256 只保留一个 64 字节分组，避免大型 avatar/decoder 响应整体转为 ArrayBuffer。
const shaConstants = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
function createSha256() {
  const state = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const block = new Uint8Array(64);
  const words = new Uint32Array(64);
  let used = 0;
  let length = 0;
  const rotate = (value, bits) => (value >>> bits) | (value << (32 - bits));
  function compress(input, offset) {
    for (let i = 0; i < 16; i++) {
      const at = offset + i * 4;
      words[i] = (input[at] << 24) | (input[at + 1] << 16) | (input[at + 2] << 8) | input[at + 3];
    }
    for (let i = 16; i < 64; i++) {
      const a = words[i - 15], b = words[i - 2];
      words[i] = words[i - 16] + (rotate(a, 7) ^ rotate(a, 18) ^ (a >>> 3)) + words[i - 7] + (rotate(b, 17) ^ rotate(b, 19) ^ (b >>> 10));
    }
    let [a, b, c, d, e, f, g, h] = state;
    for (let i = 0; i < 64; i++) {
      const first = (h + (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) + ((e & f) ^ (~e & g)) + shaConstants[i] + words[i]) >>> 0;
      const second = ((rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      h = g; g = f; f = e; e = (d + first) >>> 0; d = c; c = b; b = a; a = (first + second) >>> 0;
    }
    const values = [a, b, c, d, e, f, g, h];
    for (let i = 0; i < 8; i++) state[i] += values[i];
  }
  return {
    update(input) {
      length += input.byteLength;
      let offset = 0;
      while (offset < input.byteLength) {
        if (!used && input.byteLength - offset >= 64) { compress(input, offset); offset += 64; continue; }
        const count = Math.min(64 - used, input.byteLength - offset);
        block.set(input.subarray(offset, offset + count), used); used += count; offset += count;
        if (used === 64) { compress(block, 0); used = 0; }
      }
    },
    finish() {
      block[used++] = 0x80;
      if (used > 56) { block.fill(0, used); compress(block, 0); used = 0; }
      block.fill(0, used, 56);
      const view = new DataView(block.buffer);
      view.setUint32(56, Math.floor(length / 0x20000000)); view.setUint32(60, (length * 8) >>> 0);
      compress(block, 0);
      return { size: length, hash: Array.from(state, value => value.toString(16).padStart(8, '0')).join('') };
    },
  };
}
async function hashResponse(response, maximumBytes = Infinity) {
  const hash = createSha256();
  const reader = response.body?.getReader();
  if (reader) {
    let received = 0;
    try {
      for (;;) {
        const chunk = await reader.read(); if (chunk.done) break;
        received += chunk.value.byteLength;
        if (received > maximumBytes) throw new Error('发布响应大小超出清单');
        hash.update(chunk.value);
      }
    } catch (error) { await reader.cancel(error).catch(() => {}); throw error; }
    finally { reader.releaseLock(); }
  }
  return hash.finish();
}

function validReleaseScope() {
  return /\/digital-twin\/releases\/\d+\/\d+\/$/.test(scopeUrl.pathname);
}
function parseManifest(value) {
  if (!value || value.version !== 1 || typeof value.cacheRevision !== 'string' || !value.cacheRevision.trim() || !Number.isSafeInteger(value.totalBytes) || value.totalBytes < 0 || !Array.isArray(value.files)) throw new Error('发布缓存清单无效');
  const files = new Map();
  const paths = new Set();
  let bytes = 0;
  for (const file of value.files) {
    if (!file || typeof file.path !== 'string' || !file.path || /[\\?#\x00-\x20]/.test(file.path) || file.path.startsWith('/') || !Number.isSafeInteger(file.size) || file.size < 0 || !/^[a-f0-9]{64}$/i.test(file.sha256) || typeof file.contentType !== 'string' || !['asset', 'response'].includes(file.storage)) throw new Error('发布缓存条目无效');
    const segments = file.path.split('/').map(part => decodeURIComponent(part));
    if (segments.some(part => !part || part === '.' || part === '..' || /[\\/\x00-\x1f\x7f]/.test(part))) throw new Error('发布缓存路径越界');
    const decoded = segments.join('/');
    const url = new URL(file.path, scopeUrl);
    if (url.origin !== scopeUrl.origin || !url.pathname.startsWith(scopeUrl.pathname) || paths.has(url.href) || excludedPaths.test(decoded)) throw new Error('发布缓存路径不允许');
    if (file.storage === 'response' && /^project\/(?:assets\/|scene\.json$|asset-manifest\.json$)/.test(decoded)) throw new Error('模型资源不能重复保存至响应缓存');
    paths.add(url.href); bytes += file.size;
    if (!Number.isSafeInteger(bytes)) throw new Error('发布缓存容量无效');
    if (file.storage === 'response') files.set(url.href, { ...file, sha256: file.sha256.toLowerCase(), url: url.href });
  }
  if (bytes !== value.totalBytes) throw new Error('发布缓存清单容量不一致');
  return { manifest: value, files, name: cachePrefix + encodeURIComponent(value.cacheRevision) };
}
async function restore() {
  if (configuration) return configuration;
  if (!restorePromise) restorePromise = (async () => {
    if (!validReleaseScope()) return null;
    try {
      const names = (await caches.keys()).filter(name => name.startsWith(cachePrefix));
      if (names.length !== 1) return null;
      const metadata = await (await caches.open(names[0])).match(metadataUrl);
      if (!metadata) return null;
      const parsed = parseManifest(await metadata.json());
      if (parsed.name !== names[0]) return null;
      configuration = parsed;
    } catch { /* 缓存不可读时走网络；不能使 Viewer 启动失败。 */ }
    return configuration;
  })();
  return restorePromise;
}
async function configure(revision) {
  if (!validReleaseScope()) throw new Error('仅支持不可变发布目录');
  const existing = await restore();
  if (existing) {
    if (existing.manifest.cacheRevision !== revision) throw new Error('不可变发布目录版本不一致');
    return existing;
  }
  // 清单始终从服务器读取，私有元数据只用于 SW 重启后恢复路由，不拦截公开清单请求。
  const response = await fetch(new URL('release-cache-manifest.json', scopeUrl).href, { cache: 'no-store', credentials: 'same-origin', redirect: 'error' });
  if (!response.ok) throw new Error('无法读取发布缓存清单');
  const parsed = parseManifest(await response.json());
  if (parsed.manifest.cacheRevision !== revision) throw new Error('发布版本不一致');
  await (await caches.open(parsed.name)).put(metadataUrl, Response.json(parsed.manifest));
  configuration = parsed;
  return parsed;
}
async function cachedResponse(file) {
  const job = downloads.get(file.url);
  if (job) await job.done;
  let cache;
  try {
    cache = await caches.open(configuration.name);
    const response = await cache.match(file.url);
    if (!response) return null;
    const actual = await hashResponse(response, file.size);
    // 校验流读完后重新打开缓存响应，不保留一个未消费的 clone 分支堆积整文件。
    if (response.status === 200 && actual.size === file.size && actual.hash === file.sha256) return await cache.match(file.url) ?? null;
    await cache.delete(file.url);
  } catch {
    // 包括超出声明大小的损坏缓存；清除失败也不能阻断网络回退。
    if (cache) await cache.delete(file.url).catch(() => {});
  }
  return null;
}
async function saveResponse(file, response) {
  if (response.status !== 200 || response.type === 'opaque' || response.redirected) return false;
  const cache = await caches.open(configuration.name);
  const copy = response.clone();
  // 并行消费两条流，避免先完整读一条而把另一条 tee 分支堆积在内存。
  const writeResponse = cache.put(file.url, copy).catch(error => {
    if (copy.body && !copy.body.locked) void copy.body.cancel().catch(() => {});
    throw error;
  });
  const [hash, write] = await Promise.allSettled([hashResponse(response, file.size), writeResponse]);
  const valid = hash.status === 'fulfilled' && hash.value.size === file.size && hash.value.hash === file.sha256 && write.status === 'fulfilled';
  if (!valid) await cache.delete(file.url).catch(() => {});
  return valid;
}
function startDownload(file, consumer, deliver) {
  let job = downloads.get(file.url);
  if (job) { job.consumers.add(consumer); return job; }
  const controller = new AbortController();
  let resolveDelivery;
  let rejectDelivery;
  const delivery = deliver ? new Promise((resolve, reject) => { resolveDelivery = resolve; rejectDelivery = reject; }) : null;
  job = { consumers: new Set([consumer]), controller, delivery, done: null };
  downloads.set(file.url, job);
  job.done = (async () => {
    let response;
    try {
      response = await fetch(file.url, { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal });
      if (response.status === 200 && response.body) {
        let received = 0;
        // 在分流之前限制字节，缓存写入、SHA 校验和原生读取都不能越过清单声明的上限。
        const body = response.body.pipeThrough(new TransformStream({ transform(chunk, stream) {
          received += chunk.byteLength;
          if (received > file.size) {
            const error = new Error('发布响应大小超出清单');
            controller.abort(error); throw error;
          }
          stream.enqueue(chunk);
        } }), { signal: controller.signal });
        response = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
      }
      if (resolveDelivery) resolveDelivery(response.clone());
      return await saveResponse(file, response);
    } catch (error) { if (rejectDelivery) rejectDelivery(error); return false; }
    finally {
      if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {});
      if (downloads.get(file.url) === job) downloads.delete(file.url);
    }
  })();
  return job;
}
function dropConsumers(prefix, exact = false) {
  for (const [key, operation] of operations) if (exact ? key === prefix : key.startsWith(prefix)) operation.cancelled = true;
  for (const job of downloads.values()) {
    for (const consumer of job.consumers) if (exact ? consumer === prefix : consumer.startsWith(prefix)) job.consumers.delete(consumer);
    if (!job.consumers.size) job.controller.abort();
  }
}
function sessionKey(event, data) { return event.source.id + ':' + data.sessionId + ':'; }
async function handleMessage(event) {
  const data = event.data;
  const reply = value => event.ports[0]?.postMessage(value);
  let operationKey;
  try {
    if (data?.protocol !== 1 || typeof data.sessionId !== 'string' || !data.sessionId || !event.source?.id) return;
    const clientUrl = new URL(event.source.url);
    if (clientUrl.origin !== scopeUrl.origin || !clientUrl.pathname.startsWith(scopeUrl.pathname)) return;
    const key = sessionKey(event, data);
    if (data.type === 'dispose') { sessions.delete(key); dropConsumers(key); reply({ ok: true }); return; }
    if (data.type === 'cancel') { dropConsumers(key + data.requestId, true); reply({ ok: true }); return; }
    if (typeof data.requestId !== 'string' || !data.requestId) { reply({ ok: false }); return; }
    operationKey = key + data.requestId;
    const operation = { cancelled: false };
    operations.set(operationKey, operation);
    if (data.type === 'configure') {
      await configure(data.cacheRevision);
      if (self.clients.matchAll) {
        const live = new Set((await self.clients.matchAll({ type: 'window', includeUncontrolled: true })).map(client => client.id));
        for (const [stale, clientId] of sessions) if (!live.has(clientId)) { sessions.delete(stale); dropConsumers(stale); }
      }
      if (operation.cancelled) { reply({ ok: false }); return; }
      sessions.set(key, event.source.id); reply({ ok: true }); return;
    }
    if (!sessions.has(key) || !configuration || data.cacheRevision !== configuration.manifest.cacheRevision) { reply({ ok: false, code: 'SESSION_MISSING', reason: '缓存会话未就绪' }); return; }
    const file = configuration.files.get(new URL(data.path, scopeUrl).href);
    if (!file || data.path !== file.path || !['has', 'ensure'].includes(data.type)) { reply({ ok: false, reason: '资源不在响应清单中' }); return; }
    if (data.type === 'ensure') downloads.get(file.url)?.consumers.add(key + data.requestId);
    if (await cachedResponse(file)) { reply({ ok: sessions.has(key) && !operation.cancelled }); return; }
    if (!sessions.has(key) || operation.cancelled) { reply({ ok: false }); return; }
    if (data.type === 'has') { reply({ ok: false }); return; }
    const job = startDownload(file, key + data.requestId, false);
    const ok = await job.done;
    reply({ ok: ok && sessions.has(key) && !operation.cancelled, ...(ok ? {} : { reason: '下载、校验或存储失败' }) });
  } catch (error) { reply({ ok: false, reason: error instanceof Error ? error.message : String(error) }); }
  finally { if (operationKey) operations.delete(operationKey); }
}
function rangeResponse(response, range, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match || (!match[1] && !match[2])) return null;
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] ? (match[2] ? Math.min(size - 1, Number(match[2])) : size - 1) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) return new Response(null, { status: 416, headers: { 'Content-Range': 'bytes */' + size } });
  const reader = response.body.getReader();
  let offset = 0;
  const body = new ReadableStream({
    async pull(stream) {
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) { stream.close(); return; }
          const previous = offset; offset += chunk.value.length;
          if (offset > start) stream.enqueue(chunk.value.subarray(Math.max(0, start - previous), Math.min(chunk.value.length, end + 1 - previous)));
          if (offset > end) { stream.close(); await reader.cancel(); return; }
          if (offset > start) return;
        }
      } catch (error) { stream.error(error); }
    },
    cancel(reason) { return reader.cancel(reason); },
  });
  const headers = new Headers(response.headers);
  headers.set('Content-Range', `bytes ${start}-${end}/${size}`); headers.set('Content-Length', String(end - start + 1)); headers.set('Accept-Ranges', 'bytes'); headers.delete('Content-Encoding');
  return new Response(body, { status: 206, headers });
}
function requestedFile(request) {
  const url = new URL(request.url);
  if (url.origin !== scopeUrl.origin || !url.pathname.startsWith(scopeUrl.pathname)) return null;
  const isIndex = url.pathname === scopeUrl.pathname || url.pathname === scopeUrl.pathname + 'index.html';
  if (url.search && !isIndex) return null;
  return configuration.files.get(isIndex ? new URL('index.html', scopeUrl).href : url.href) ?? null;
}
async function handleFetch(event) {
  await restore();
  const file = configuration && requestedFile(event.request);
  if (!file) return fetch(event.request);
  // 浏览器读取也持有下载引用，后台预热取消时不能中止另一个页面正在用的请求。
  downloads.get(file.url)?.consumers.add('fetch:' + event.clientId);
  const cached = await cachedResponse(file);
  const range = event.request.headers.get('Range');
  if (cached) return range ? rangeResponse(cached, range, file.size) ?? fetch(event.request) : cached;
  if (range) return fetch(event.request);
  const existing = downloads.get(file.url);
  if (existing) {
    existing.consumers.add('fetch:' + event.clientId);
    if (await existing.done) return await cachedResponse(file) ?? fetch(event.request);
    return fetch(event.request);
  }
  const job = startDownload(file, 'fetch:' + event.clientId, true);
  event.waitUntil(job.done);
  return job.delivery;
}
self.addEventListener('install', event => {
  // Chrome 自动导航预载会在 SW 尚未启动时额外下载 HTML；显式路由至 fetch-event 关闭该推测请求。
  // 下载仍由 Viewer 的有界后台队列驱动，安装不预热整包。旧浏览器继续使用常规 fetch 事件。
  if (typeof event.addRoutes === 'function') event.waitUntil(event.addRoutes({ condition: { urlPattern: new URLPattern({}) }, source: 'fetch-event' }));
});
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('message', event => event.waitUntil(handleMessage(event)));
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET' || event.request.headers.has('Authorization') || event.request.cache === 'no-store') return;
  const url = new URL(event.request.url);
  if (url.origin !== scopeUrl.origin || !url.pathname.startsWith(scopeUrl.pathname)) return;
  let path;
  try { path = decodeURIComponent(url.pathname.slice(scopeUrl.pathname.length)); }
  catch { return; }
  if (excludedPaths.test(path)) return;
  if (configuration && !requestedFile(event.request)) return;
  event.respondWith(handleFetch(event));
});
