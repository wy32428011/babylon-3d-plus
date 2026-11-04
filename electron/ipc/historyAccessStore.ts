import { app, safeStorage } from 'electron';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  validateHistoryAccessUpdate,
  validateHistoryProjectId,
  type HistoryAccessStatus,
  type HistoryAccessUpdate,
} from '../shared/historyServiceContract.js';

type ProtectedEntry = { origin: string; projectId: string; encrypted: string; updatedAt: string };
type ProtectedStore = { version: 1; entries: Record<string, ProtectedEntry> };
const MAX_STORE_BYTES = 4 * 1024 * 1024;
const MAX_ENTRIES = 512;
let storeQueue: Promise<void> = Promise.resolve();

/** 管理键不经明文 HTTP 离开本机，且绝不绑定到带用户信息或查询参数的地址。 */
export function historyManagementOrigin(baseUrl: string): string {
  let url: URL;
  try { url = new URL(baseUrl); } catch { throw new Error('历史服务的平台地址无效。'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase());
  if (url.username || url.password || url.search || url.hash
    || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) {
    throw new Error('历史管理访问需要 HTTPS；仅本机隔离环境允许 HTTP。');
  }
  return url.origin;
}

function encryptionAvailable(): boolean {
  return safeStorage.isEncryptionAvailable()
    && !(process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text');
}

function storePath(): string { return path.join(app.getPath('userData'), 'history-management-access.v1.json'); }
function entryKey(origin: string, projectId: string): string {
  return createHash('sha256').update(JSON.stringify([origin, projectId])).digest('hex');
}

async function readStore(): Promise<ProtectedStore> {
  const file = storePath();
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_STORE_BYTES) throw new Error('invalid-store');
    const parsed: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid-store');
    const input = parsed as Record<string, unknown>;
    if (input.version !== 1 || !input.entries || typeof input.entries !== 'object' || Array.isArray(input.entries)
      || Object.keys(input.entries).length > MAX_ENTRIES) throw new Error('invalid-store');
    const entries: Record<string, ProtectedEntry> = Object.create(null) as Record<string, ProtectedEntry>;
    for (const [key, raw] of Object.entries(input.entries)) {
      if (!/^[a-f0-9]{64}$/u.test(key) || !raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid-store');
      const entry = raw as Record<string, unknown>;
      if (typeof entry.origin !== 'string' || typeof entry.projectId !== 'string'
        || typeof entry.encrypted !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/u.test(entry.encrypted)
        || entry.encrypted.length > 32_000 || typeof entry.updatedAt !== 'string') throw new Error('invalid-store');
      if (historyManagementOrigin(entry.origin) !== entry.origin
        || entryKey(entry.origin, validateHistoryProjectId(entry.projectId)) !== key) throw new Error('invalid-store');
      entries[key] = { origin: entry.origin, projectId: entry.projectId, encrypted: entry.encrypted, updatedAt: entry.updatedAt };
    }
    return { version: 1, entries };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, entries: Object.create(null) as Record<string, ProtectedEntry> };
    throw new Error('历史管理凭据存储无法读取，请检查本机安全存储；未覆盖原文件。');
  }
}

async function writeStore(store: ProtectedStore): Promise<void> {
  const file = storePath();
  const content = JSON.stringify(store);
  if (Buffer.byteLength(content, 'utf8') > MAX_STORE_BYTES) throw new Error('历史管理凭据存储超过容量上限。');
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  let created = false;
  try {
    await fs.writeFile(temporary, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    created = true;
    await fs.rename(temporary, file);
    created = false;
  } finally {
    if (created) await fs.rm(temporary, { force: true });
  }
}

/** 队列只负责串行化读改写；操作错误仍返回给调用方，不转成保存成功。 */
function exclusive<T>(operation: () => Promise<T>): Promise<T> {
  const result = storeQueue.then(operation);
  storeQueue = result.then(() => undefined, () => undefined);
  return result;
}

export async function getHistoryAccessStatus(baseUrl: string, rawProjectId: unknown): Promise<HistoryAccessStatus> {
  const projectId = validateHistoryProjectId(rawProjectId);
  if (!baseUrl) return { configured: false, encryptionAvailable: encryptionAvailable(), platformOrigin: null, projectId };
  const origin = historyManagementOrigin(baseUrl);
  return exclusive(async () => {
    const store = await readStore();
    return { configured: Boolean(store.entries[entryKey(origin, projectId)]), encryptionAvailable: encryptionAvailable(), platformOrigin: origin, projectId };
  });
}

export async function updateHistoryAccess(baseUrl: string, input: unknown): Promise<HistoryAccessStatus> {
  const request: HistoryAccessUpdate = validateHistoryAccessUpdate(input);
  const origin = historyManagementOrigin(baseUrl);
  return exclusive(async () => {
    const store = await readStore();
    const key = entryKey(origin, request.projectId);
    if (request.operation === 'clear') {
      delete store.entries[key];
    } else {
      if (!encryptionAvailable()) throw new Error('当前操作系统没有安全加密能力，不能保存管理访问键。');
      if (!store.entries[key] && Object.keys(store.entries).length >= MAX_ENTRIES) throw new Error('已保存的历史管理凭据数量达到上限。');
      const encrypted = safeStorage.encryptString(request.secret!).toString('base64');
      store.entries[key] = { origin, projectId: request.projectId, encrypted, updatedAt: new Date().toISOString() };
    }
    await writeStore(store);
    return { configured: Boolean(store.entries[key]), encryptionAvailable: encryptionAvailable(), platformOrigin: origin, projectId: request.projectId };
  });
}

/** 仅在可信主进程内解密并用于固定平台接口；不得通过 IPC 返回此值。 */
export async function readHistoryManagementKey(baseUrl: string, rawProjectId: unknown): Promise<string | null> {
  const projectId = validateHistoryProjectId(rawProjectId);
  const origin = historyManagementOrigin(baseUrl);
  return exclusive(async () => {
    const entry = (await readStore()).entries[entryKey(origin, projectId)];
    if (!entry) return null;
    if (!encryptionAvailable()) throw new Error('当前环境不能解密已保存的历史管理凭据。');
    try {
      const secret = safeStorage.decryptString(Buffer.from(entry.encrypted, 'base64'));
      validateHistoryAccessUpdate({ projectId, operation: 'replace', secret });
      return secret;
    } catch {
      throw new Error('历史管理访问键无法解密，请重新配置；未返回任何密钥内容。');
    }
  });
}
