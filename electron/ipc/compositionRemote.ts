import { promises as fs, createWriteStream, openAsBlob } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { ZipArchive } from 'archiver';
import { createRequire } from 'node:module';
const unzipper = createRequire(import.meta.url)('unzipper') as { Open: { file(path: string): Promise<{ files: Array<{ path: string; type: string; externalFileAttributes: number; stream(): Readable }> }> } };
import type { CompositionLibraryEntry, CompositionLibrarySummary } from '../shared/compositionTypes.js';
import { compositionHash, compositionRoot, listCompositionSummaries, materializeComposition, readCompositionIndex, mutateCompositionIndex } from './compositionPackage.js';
import { normalizeDataPlatformSourceUrl } from './dataPlatformEnvironmentContract.js';

type RemoteEntry = { id: string; name: string; revision: string; manifestSha256: string; packageSha256: string; memberCount: number; updatedAt: string };
const active = new Map<string, Promise<CompositionLibrarySummary[]>>();
const controllers = new Set<AbortController>();
export function cancelCompositionSync() { for (const controller of controllers) controller.abort(new Error('组合同步已取消，本地内容保留。')); }
const MAX_BYTES = 8 * 1024 ** 3;
const idPattern = /^[A-Za-z0-9-]{1,100}$/;
async function json<T>(response: Response): Promise<T> {
  if (response.status === 404) { await response.body?.cancel(); throw new Error('当前数据中台未提供组合模型接口，请检查服务地址或升级中台。本地组合内容保留。'); }
  if (!response.body) throw new Error('中台组合接口返回空响应。');
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) { const result = await reader.read(); if (result.done) break; bytes += result.value.length;
      if (bytes > 2 * 1024 * 1024) throw new Error('组合接口响应超过 2 MB。'); chunks.push(result.value); }
  } catch (error) { await reader.cancel(); throw error; } finally { reader.releaseLock(); }
  let result: { success?: boolean; code?: string; message?: string; data: T };
  try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('中台组合接口未返回有效 JSON，请检查服务地址。'); }
  if (!response.ok || result.success !== true) throw new Error(`${result.code ?? response.status}：${result.message ?? '组合接口请求失败'}`);
  return result.data;
}
export async function zipCompositionPackage(entry: CompositionLibraryEntry, target: string, signal?: AbortSignal) {
  const manifest = JSON.parse(await fs.readFile(path.join(entry.packagePath, 'composition.json'), 'utf8')) as { files: Array<{path:string}> };
  const archive = new ZipArchive({ zlib: { level: 1 } }), output = createWriteStream(target);
  const completed = pipeline(archive, output, { signal });
  archive.file(path.join(entry.packagePath, 'composition.json'), { name: 'composition.json' });
  for (const file of manifest.files) archive.file(path.join(entry.packagePath, file.path), { name: file.path });
  await Promise.all([archive.finalize(), completed]);
}
export async function extractCompositionArchive(file: string, directory: string) {
  const zip = await unzipper.Open.file(file);
  if (zip.files.length > 100000) throw new Error('组合包文件过多。');
  const seen = new Set<string>(); let bytes = 0;
  for (const item of zip.files) {
    if (item.type === 'Directory') continue;
    const relative = item.path;
    if (!relative || relative.includes('\\') || relative.includes(':') || relative.split('/').some(p => !p || p === '.' || p === '..') || seen.has(relative.toLowerCase())) throw new Error('组合包路径无效或重复。');
    if ((((item as unknown as { externalFileAttributes: number }).externalFileAttributes >>> 16) & 0xf000) === 0xa000) throw new Error('组合包不能包含符号链接。');
    seen.add(relative.toLowerCase());
    const target = path.resolve(directory, relative), rel = path.relative(directory, target);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('组合包路径越界。');
    await fs.mkdir(path.dirname(target), { recursive: true });
    const limit = new Transform({ transform(chunk: Buffer, _encoding, callback) { bytes += chunk.length; callback(bytes > MAX_BYTES ? new Error('组合包超过大小限制。') : null, chunk); } });
    await pipeline(item.stream(), limit, createWriteStream(target, { flags: 'wx' }));
  }
}
export function syncCompositionLibrary(root: string, baseUrl: string, projectId?: string): Promise<CompositionLibrarySummary[]> {
  const key = `${root}:${baseUrl}`;
  const existing = active.get(key); if (existing) return existing;
  const controller = new AbortController(); controllers.add(controller);
  const task = synchronize(root, baseUrl, projectId, controller.signal).finally(() => { active.delete(key); controllers.delete(controller); }); active.set(key, task); return task;
}
async function pendingVersions(root: string, current: CompositionLibraryEntry): Promise<CompositionLibraryEntry[]> {
  const pending: CompositionLibraryEntry[] = [], seen = new Set<string>(); let entry = current;
  for (;;) {
    if (entry.syncStatus === 'synced' && entry.remoteRevision === entry.revision) break;
    if (seen.has(entry.revision) || seen.size >= 4096) throw new Error('组合历史版本链循环或超过同步上限。');
    seen.add(entry.revision); pending.unshift(entry);
    if (!entry.previousRevision || entry.previousRevision === current.remoteRevision) break;
    if (!idPattern.test(entry.previousRevision)) throw new Error('组合历史版本标识无效。');
    const file = path.join(compositionRoot(root), current.id, entry.previousRevision, 'entry.json');
    if ((await fs.stat(file)).size > 16 * 1024 * 1024) throw new Error('组合历史元数据超过限制。');
    const previous = JSON.parse(await fs.readFile(file, 'utf8')) as CompositionLibraryEntry;
    if (previous.id !== current.id || previous.revision !== entry.previousRevision || path.resolve(previous.packagePath) !== path.resolve(path.dirname(file))) throw new Error('组合历史版本身份不一致。');
    entry = previous;
  }
  return pending;
}
async function synchronize(root: string, baseUrl: string, projectId: string | undefined, signal: AbortSignal): Promise<CompositionLibrarySummary[]> {
  if (!baseUrl) throw new Error('请先配置数据中台地址，本地组合已保留。');
  const base = normalizeDataPlatformSourceUrl(baseUrl), sourceKey = createHash('sha256').update(base).digest('hex');
  const endpoint = `${base}/api/v1/env-models/compositions`;
  let entries = await mutateCompositionIndex(root, current => current.map(entry => entry.sourceKey ? entry : { ...entry, sourceKey }));
  for (const current of entries.filter(e => e.syncStatus !== 'synced' && e.sourceKey === sourceKey)) {
    let pending: CompositionLibraryEntry[];
    try { pending = await pendingVersions(root, current); }
    catch (error) {
      await mutateCompositionIndex(root, list => list.map(e => e.id === current.id ? { ...e, syncStatus: 'failed', syncError: error instanceof Error ? error.message : String(error) } : e));
      continue;
    }
    for (const entry of pending) {
    const temporary = path.join(compositionRoot(root), `${randomUUID()}.zip`);
    try {
      signal.throwIfAborted();
      await materializeComposition(entry); await zipCompositionPackage(entry, temporary, signal);
      const body = new FormData(); body.set('name', entry.name); body.set('operationId', entry.revision);
      const baseline = (await readCompositionIndex(root)).find(e => e.id === entry.id);
      if (baseline?.resourceId) { body.set('targetId', baseline.resourceId); if (baseline.remoteRevision) body.set('baseRevision', baseline.remoteRevision); }
      body.set('compositionFile', await openAsBlob(temporary, { type: 'application/zip' }), 'composition.zip');
      const remote = await json<RemoteEntry>(await fetch(`${endpoint}/save`, { method: 'POST', body, signal: AbortSignal.any([signal, AbortSignal.timeout(30 * 60_000)]) }));
      if (typeof remote.id !== 'string' || !/^[1-9]\d{0,19}$/.test(remote.id) || remote.revision !== entry.revision || remote.manifestSha256 !== entry.contentSha256) throw new Error('中台返回的组合身份或内容版本与上传快照不一致。');
      if (projectId) await json(await fetch(base + '/api/v1/env-models/projects/bind', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: remote.id, resourceIds: [projectId] }), signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]) }));
      const { definition: _definition, ...metadata } = entry;
      await fs.writeFile(path.join(entry.packagePath, 'entry.json'), JSON.stringify({ ...metadata, resourceId: remote.id, sourceKey, remoteRevision: remote.revision, syncStatus: 'synced', syncError: undefined }), 'utf8');
      // 网络提交期间有新本地版本时仅合并远端基线，不能把新修改标记为已同步。
      entries = await mutateCompositionIndex(root, latest => latest.map(e => e.id === entry.id ? { ...e, resourceId: remote.id, sourceKey, remoteRevision: remote.revision,
        syncStatus: e.revision === entry.revision ? 'synced' : 'pending', syncError: undefined } : e));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      entries = await mutateCompositionIndex(root, latest => latest.map(e => e.id === entry.id ? { ...e, syncStatus: message.includes('REVISION_CONFLICT') ? 'conflict' : 'failed', syncError: message } : e));
      break;
    } finally { await fs.rm(temporary, { force: true }); }
    }
  }
  let cursor = '0';
  for (let page = 0; page < 1000; page++) {
    signal.throwIfAborted();
    const remote = await json<RemoteEntry[]>(await fetch(`${endpoint}/query`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cursorId: cursor, pageSize: 100 }), signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]) }));
    if (!Array.isArray(remote) || remote.length > 100) throw new Error('组合清单格式无效。');
    for (const item of remote) {
      if (typeof item.id !== 'string' || !/^[1-9]\d{0,19}$/.test(item.id) || !idPattern.test(item.revision) || !/^[a-f0-9]{64}$/.test(item.manifestSha256) || !/^[a-f0-9]{64}$/.test(item.packageSha256)) throw new Error('组合远端身份无效。');
      entries = await readCompositionIndex(root);
      const existing = entries.find(e => e.resourceId === item.id && e.sourceKey === sourceKey);
      if (existing && (existing.syncStatus !== 'synced' || existing.remoteRevision === item.revision)) continue;
      const id = existing?.id ?? `remote-${sourceKey.slice(0,16)}-${item.id}`, revision = item.revision;
      const staging = path.join(compositionRoot(root), `.download-${randomUUID()}`), packagePath = path.join(compositionRoot(root), id, revision);
      const temporary = `${staging}.zip`;
      try {
        await fs.mkdir(staging, { recursive: true });
        const response = await fetch(`${endpoint}/${item.id}/versions/${encodeURIComponent(revision)}/package`, { signal: AbortSignal.any([signal, AbortSignal.timeout(30 * 60_000)]) });
        if (!response.ok || !response.body) throw new Error(`组合包下载失败：${response.status}`);
        let bytes = 0;
        await pipeline(Readable.fromWeb(response.body as never), new Transform({ transform(chunk: Buffer, _e, cb) { bytes += chunk.length; cb(bytes > MAX_BYTES ? new Error('组合包超过大小限制。') : null, chunk); } }), createWriteStream(temporary));
        if (await compositionHash(temporary) !== item.packageSha256) throw new Error('组合包 SHA-256 不匹配。');
        await extractCompositionArchive(temporary, staging);
        const entry = { id, revision, previousRevision: existing?.revision, name: item.name, updatedAt: item.updatedAt, packagePath: staging, contentSha256: item.manifestSha256,
          memberCount: item.memberCount, resourceId: item.id, remoteRevision: revision, sourceKey, syncStatus: 'synced' } as CompositionLibraryEntry;
        const materialized = await materializeComposition(entry);
        entry.thumbnailUrl = materialized.thumbnailUrl;
        await fs.mkdir(path.dirname(packagePath), { recursive: true });
        try { await fs.rename(staging, packagePath); } catch (error) { if (!['EEXIST','ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
        entry.packagePath = packagePath; await materializeComposition(entry);
        await fs.writeFile(path.join(packagePath, 'entry.json'), JSON.stringify(entry), 'utf8');
        await mutateCompositionIndex(root, latest => {
          const current = latest.find(e => e.id === id);
          return !current ? [...latest, entry] : current.syncStatus === 'synced' ? latest.map(e => e.id === id ? entry : e) : latest;
        });
      } finally { await fs.rm(temporary, { force: true }); await fs.rm(staging, { recursive: true, force: true }); }
    }
    if (remote.length < 100) break;
    const next = remote[remote.length - 1].id;
    if (BigInt(next) <= BigInt(cursor)) throw new Error('组合清单游标未前进。'); cursor = next;
  }
  return (await listCompositionSummaries(root)).filter(e => !e.sourceKey || e.sourceKey === sourceKey);
}

export { json as readCompositionResponse };
