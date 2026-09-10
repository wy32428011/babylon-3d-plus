import type { CubeMapInfo } from '@babylonjs/core/Misc/HighDynamicRange/panoramaToCubemap';

export const SKYBOX_CACHE_DATABASE = 'zending-skybox-decoded-v1';
export const SKYBOX_CACHE_MAX_BYTES = 128 * 1024 * 1024;
export const SKYBOX_CACHE_MAX_ENTRIES = 8;
export const SKYBOX_CUBE_FACES = ['front', 'back', 'left', 'right', 'up', 'down'] as const;
export type SkyboxCacheEntry = { key: string; byteLength: number; lastUsed: number; generation?: string };
type SkyboxCubeChecksums = Record<typeof SKYBOX_CUBE_FACES[number], string>;
type StoredSkyboxCube = { key: string; cube: CubeMapInfo; checksums: SkyboxCubeChecksums; generation: string };

export function validateSkyboxCacheEntry(value: unknown): value is SkyboxCacheEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as SkyboxCacheEntry;
  return typeof entry.key === 'string' && entry.key.length > 0
    && Number.isSafeInteger(entry.byteLength) && entry.byteLength >= 0
    && Number.isFinite(entry.lastUsed) && entry.lastUsed >= 0;
}

/** 元数据参与 LRU 计算，避免为了淘汰而把其它大纹理全部读进内存。 */
export function planSkyboxCacheWrite(entries: unknown[], next: SkyboxCacheEntry,
  maxEntries = SKYBOX_CACHE_MAX_ENTRIES, maxBytes = SKYBOX_CACHE_MAX_BYTES): { write: boolean; deleteKeys: string[] } {
  if (!validateSkyboxCacheEntry(next)) throw new Error('天空盒缓存元数据无效。');
  const deleteKeys = entries.filter(entry => !validateSkyboxCacheEntry(entry))
    .map(entry => entry && typeof entry === 'object' ? (entry as { key?: unknown }).key : null)
    .filter((key): key is string => typeof key === 'string');
  if (maxEntries < 1 || next.byteLength > maxBytes) return { write: false, deleteKeys };
  const candidates = entries.filter((entry): entry is SkyboxCacheEntry => validateSkyboxCacheEntry(entry) && entry.key !== next.key)
    .sort((a, b) => a.lastUsed - b.lastUsed);
  let bytes = candidates.reduce((total, entry) => total + entry.byteLength, next.byteLength);
  let count = candidates.length + 1;
  for (const entry of candidates) {
    if (count <= maxEntries && bytes <= maxBytes) break;
    deleteKeys.push(entry.key); bytes -= entry.byteLength; count--;
  }
  return { write: true, deleteKeys };
}

/** 与 Babylon 原算法完全相同的 Float32 线性 RGB 六面，不接受不完整缓存。 */
export function validateSkyboxCubeData(value: unknown, size: number): value is CubeMapInfo {
  if (!value || typeof value !== 'object') return false;
  const cube = value as CubeMapInfo;
  return cube.size === size && cube.type === 1 && cube.format === 4 && cube.gammaSpace === false
    && SKYBOX_CUBE_FACES.every(face => cube[face] instanceof Float32Array && cube[face]!.byteLength === size * size * 3 * 4);
}

export function getSkyboxCubeBytes(cube: CubeMapInfo): number {
  return SKYBOX_CUBE_FACES.reduce((bytes, face) => bytes + (cube[face]?.byteLength ?? 0), 0);
}

/** digest 必须在 IndexedDB 事务之外执行；只读六面精确字节，不改浮点值。 */
export async function hashSkyboxCubeFaces(cube: CubeMapInfo): Promise<SkyboxCubeChecksums> {
  if (!globalThis.crypto?.subtle) throw new Error('天空盒缓存校验需要 SHA-256 WebCrypto。');
  return Object.fromEntries(await Promise.all(SKYBOX_CUBE_FACES.map(async face => {
    const data = cube[face]!;
    const bytes = new Uint8Array(data.buffer as ArrayBuffer, data.byteOffset, data.byteLength);
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    return [face, Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('')];
  }))) as SkyboxCubeChecksums;
}

export function openSkyboxDecodedCache(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('当前环境不支持 IndexedDB。')); return; }
    let settled = false;
    const request = indexedDB.open(SKYBOX_CACHE_DATABASE, 1);
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true; clearTimeout(timer); reject(error);
    };
    const timer = setTimeout(() => fail(new Error('天空盒缓存打开等待超时。')), 2_000);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains('metadata')) database.createObjectStore('metadata', { keyPath: 'key' });
      if (!database.objectStoreNames.contains('cubemaps')) database.createObjectStore('cubemaps', { keyPath: 'key' });
    };
    request.onerror = () => fail(request.error ?? new Error('无法打开天空盒缓存。'));
    request.onblocked = () => fail(new Error('天空盒缓存被其它页面占用。'));
    request.onsuccess = () => {
      if (settled) { request.result.close(); return; }
      settled = true; clearTimeout(timer);
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
  });
}

export async function readSkyboxDecodedCache(database: IDBDatabase, key: string, size: number): Promise<CubeMapInfo | null> {
  const snapshot = await new Promise<{ record?: StoredSkyboxCube; metadata?: SkyboxCacheEntry }>((resolve, reject) => {
    const transaction = database.transaction(['metadata', 'cubemaps'], 'readonly');
    const dataRequest = transaction.objectStore('cubemaps').get(key);
    const metadataRequest = transaction.objectStore('metadata').get(key);
    transaction.oncomplete = () => resolve({ record: dataRequest.result, metadata: metadataRequest.result });
    transaction.onabort = () => reject(transaction.error ?? new Error('天空盒缓存读取事务中止。'));
    transaction.onerror = () => reject(transaction.error ?? new Error('天空盒缓存读取失败。'));
  });
  const record = snapshot.record;
  let valid = Boolean(record && validateSkyboxCubeData(record.cube, size)
    && typeof record.generation === 'string' && record.generation.length > 0
    && validateSkyboxCacheEntry(snapshot.metadata) && snapshot.metadata.generation === record.generation
    && snapshot.metadata.byteLength === getSkyboxCubeBytes(record.cube)
    && SKYBOX_CUBE_FACES.every(face => typeof record.checksums?.[face] === 'string' && /^[a-f0-9]{64}$/.test(record.checksums[face])));
  if (valid && record) {
    const checksums = await hashSkyboxCubeFaces(record.cube);
    valid = SKYBOX_CUBE_FACES.every(face => checksums[face] === record.checksums[face]);
  }
  // 校验时其它 Worker 可以完成同 key 重算；只更新/删除读到的那一代记录。
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(['metadata', 'cubemaps'], 'readwrite');
    const metadata = transaction.objectStore('metadata');
    const cubemaps = transaction.objectStore('cubemaps');
    const request = metadata.get(key);
    request.onsuccess = () => {
      if (request.result?.generation !== snapshot.metadata?.generation) return;
      if (valid && snapshot.metadata) metadata.put({ ...snapshot.metadata, lastUsed: Date.now() });
      else { cubemaps.delete(key); metadata.delete(key); }
    };
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error('天空盒缓存校验事务中止。'));
    transaction.onerror = () => reject(transaction.error ?? new Error('天空盒缓存校验失败。'));
  });
  return valid && record ? record.cube : null;
}

/** 元数据、数据与淘汰在同一个事务内提交；Worker 被取消时不会留下半份记录。 */
export async function writeSkyboxDecodedCache(database: IDBDatabase, key: string, cube: CubeMapInfo,
  maxEntries = SKYBOX_CACHE_MAX_ENTRIES, maxBytes = SKYBOX_CACHE_MAX_BYTES): Promise<boolean> {
  if (!validateSkyboxCubeData(cube, cube.size)) throw new Error('天空盒缓存数据不完整。');
  const next = { key, byteLength: getSkyboxCubeBytes(cube), lastUsed: Date.now() };
  if (next.byteLength > maxBytes || maxEntries < 1) return false;
  const checksums = await hashSkyboxCubeFaces(cube);
  const generation = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(['metadata', 'cubemaps'], 'readwrite');
    const metadata = transaction.objectStore('metadata');
    const cubemaps = transaction.objectStore('cubemaps');
    const request = metadata.getAll();
    let written = false;
    request.onsuccess = () => {
      const plan = planSkyboxCacheWrite(request.result, next, maxEntries, maxBytes);
      for (const oldKey of plan.deleteKeys) { metadata.delete(oldKey); cubemaps.delete(oldKey); }
      if (!plan.write) return;
      metadata.put({ ...next, generation }); cubemaps.put({ key, cube, checksums, generation } satisfies StoredSkyboxCube); written = true;
    };
    transaction.oncomplete = () => resolve(written);
    transaction.onabort = () => reject(transaction.error ?? new Error('天空盒缓存写入事务中止。'));
    transaction.onerror = () => reject(transaction.error ?? new Error('天空盒缓存写入失败。'));
  });
}
