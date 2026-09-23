import { validateComposition } from '../shared/compositionValidation.js';
import { promises as fs, createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { CompositionDefinition, CompositionLibraryEntry, CompositionLibrarySummary, CompositionSaveRequest } from '../shared/compositionTypes.js';
import { authorizeAssetRoot, encodeAssetUrl, decodeAssetUrl, isAuthorizedAssetFile } from './assetRegistry.js';

type FileEntry = { path: string; size: number; sha256: string };
export type CompositionManifest = { schemaVersion: 1; definition: CompositionDefinition; files: FileEntry[] };
const ID = /^[a-zA-Z0-9-]{1,100}$/;
const PATH_KEYS = new Set(['sourcePath', 'sourceUrl', 'path', 'packagePath', 'metadataPath', 'thumbnailPath', 'thumbnailUrl']);
const locks = new Map<string, Promise<unknown>>();
const inflightLoads = new Map<string, Promise<CompositionLibraryEntry>>();
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export async function compositionHash(file: string) { const h = createHash('sha256'); for await (const chunk of createReadStream(file)) h.update(chunk); return h.digest('hex'); }
export function compositionRoot(root: string) { return path.join(root, 'Assets', 'Compositions'); }
function safe(root: string, relative: string) {
  if (!relative || relative.includes('\\') || relative.includes(':') || relative.split('/').some(p => !p || p === '.' || p === '..')) throw new Error('组合包路径无效。');
  const result = path.resolve(root, relative), rel = path.relative(root, result);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('组合包路径越界。');
  return result;
}
async function exclusive<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const previous = locks.get(root) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(operation); locks.set(root, next);
  try { return await next; } finally { if (locks.get(root) === next) locks.delete(root); }
}
export async function writeCompositionIndex(root: string, entries: CompositionLibraryEntry[]) {
  const dir = compositionRoot(root); await fs.mkdir(dir, { recursive: true });
  const temporary = path.join(dir, `index-${randomUUID()}.tmp`);
  await fs.writeFile(temporary, JSON.stringify(entries.map(({ definition: _definition, ...entry }) => entry)), 'utf8');
  await fs.rename(temporary, path.join(dir, 'index.json'));
}
export async function mutateCompositionIndex(root: string, update: (entries: CompositionLibraryEntry[]) => CompositionLibraryEntry[]): Promise<CompositionLibraryEntry[]> {
  return exclusive(root, async () => { const entries = update(await readCompositionIndex(root)); await writeCompositionIndex(root, entries); return entries; });
}
export async function readCompositionIndex(root: string): Promise<CompositionLibraryEntry[]> {
  try {
    const file = path.join(compositionRoot(root), 'index.json');
    if ((await fs.stat(file)).size > 10 * 1024 * 1024) throw new Error('组合库索引超过限制。');
    const entries = JSON.parse(await fs.readFile(file, 'utf8')) as CompositionLibraryEntry[];
    if (!Array.isArray(entries) || entries.length > 10000 || entries.some(e => !ID.test(e.id) || !ID.test(e.revision))) throw new Error('组合库索引无效。');
    for (const entry of entries) {
      const expected = path.resolve(compositionRoot(root), entry.id, entry.revision);
      if (path.resolve(entry.packagePath) !== expected) throw new Error('组合库索引资源目录越界。');
    }
    return entries;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}
function visitPaths(value: unknown, rewrite: (value: string) => string, field = ''): unknown {
  if (typeof value === 'string') return PATH_KEYS.has(field) || field === 'scriptPaths' || value.startsWith('editor-asset://') ? rewrite(value) : value;
  if (Array.isArray(value)) return value.map(v => visitPaths(v, rewrite, field));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k, visitPaths(v, rewrite, k)]));
  return value;
}
export async function materializeComposition(entry: CompositionLibraryEntry): Promise<CompositionLibraryEntry> {
  const manifestFile = path.join(entry.packagePath, 'composition.json');
  if ((await fs.stat(manifestFile)).size > 10 * 1024 * 1024) throw new Error('组合定义超过 10 MB。');
  const raw = await fs.readFile(manifestFile, 'utf8');
  if (digest(raw) !== entry.contentSha256) throw new Error(`组合“${entry.name}”定义校验失败。`);
  const manifest = JSON.parse(raw) as CompositionManifest;
  validateComposition(manifest.definition);
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files) || manifest.files.length > 100000) throw new Error('组合包版本或文件清单无效。');
  let bytes = 0;
  for (const f of manifest.files) {
    const file = safe(entry.packagePath, f.path), stat = await fs.lstat(file);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size !== f.size || (bytes += stat.size) > 8 * 1024 ** 3 || await compositionHash(file) !== f.sha256) throw new Error(`组合资源校验失败：${f.path}`);
  }
  authorizeAssetRoot(entry.packagePath);
  const definition = visitPaths(manifest.definition, value => value.startsWith('composition-file:') ? encodeAssetUrl(safe(entry.packagePath, value.slice(17))) : value.startsWith('composition-path:') ? safe(entry.packagePath, value.slice(17)) : value) as CompositionDefinition;
  // 固定包使用自身副本；原始中台身份仍保留在组合清单，普通模型最新同步不能替换它。
  for (const node of definition.nodes) {
    const asset = node.components.modelAsset as Record<string, unknown> | undefined;
    if (asset) { delete asset.dataPlatformModel; asset.sourceSnapshot = { contentSha256: entry.contentSha256, composition: true, compositionResource: { schemaVersion: 1, resourceType: 'ENV_MODEL', libraryId: entry.id, revision: entry.revision, resourceId: entry.resourceId, sourceKey: entry.sourceKey, packagePath: entry.packagePath } }; }
  }
  return { ...entry, definition, thumbnailUrl: manifest.files.some(f => f.path === 'thumbnail.png') ? encodeAssetUrl(path.join(entry.packagePath, 'thumbnail.png')) : undefined };
}
export async function listCompositionSummaries(root: string): Promise<CompositionLibrarySummary[]> {
  return (await readCompositionIndex(root)).map(({ definition: _definition, ...entry }) => ({ ...entry,
    thumbnailUrl: entry.thumbnailUrl ? encodeAssetUrl(path.join(entry.packagePath, 'thumbnail.png')) : undefined }));
}
export async function loadCompositionPackage(root: string, id: string, revision?: string) {
  let entry = (await readCompositionIndex(root)).find(e => e.id === id);
  if (!entry) throw new Error('组合卡片已不存在。');
  if (revision && revision !== entry.revision) {
    if (!ID.test(revision)) throw new Error('组合版本无效。');
    const directory = path.join(compositionRoot(root), id, revision);
    const previous = JSON.parse(await fs.readFile(path.join(directory, 'entry.json'), 'utf8')) as CompositionLibraryEntry;
    if (previous.id !== id || previous.revision !== revision || path.resolve(previous.packagePath) !== path.resolve(directory)) throw new Error('组合版本身份不一致。');
    entry = { ...previous, resourceId: previous.resourceId ?? entry.resourceId, sourceKey: previous.sourceKey ?? entry.sourceKey };
  }
  const key = entry.packagePath + ':' + entry.contentSha256;
  const running = inflightLoads.get(key); if (running) return running;
  const pending = materializeComposition(entry).finally(() => inflightLoads.delete(key));
  inflightLoads.set(key, pending); return pending;
}
export async function listCompositionPackages(root: string) {
  const result: CompositionLibraryEntry[] = [];
  for (const entry of await readCompositionIndex(root)) result.push(await materializeComposition(entry));
  return result;
}

async function buildPackage(definition: CompositionDefinition, dir: string, thumbnail?: string, preview?: Uint8Array, packageHints: Array<{path:string;packagePath?:string}> = []): Promise<string> {
  validateComposition(definition);
  if (definition?.schemaVersion !== 1 || !Array.isArray(definition.nodes) || definition.nodes.length > 4096 || JSON.stringify(definition).length > 10 * 1024 * 1024) throw new Error('组合定义无效或超过限制。');
  const folders = new Map<string, string>();
  const packageRoots: string[] = [];
  const contains = (root: string, file: string) => { const relative = path.relative(root, file); return !relative.startsWith('..') && !path.isAbsolute(relative); };
  for (const node of definition.nodes) {
    const asset = node.components.modelAsset as { sourcePath?: string } | undefined;
    if (!asset?.sourcePath || !path.isAbsolute(asset.sourcePath)) continue;
    const file = path.resolve(asset.sourcePath);
    const hint = packageHints.find(h => path.relative(path.resolve(h.path), file) === '');
    let selected = path.dirname(file);
    if (hint?.packagePath && contains(path.resolve(hint.packagePath), file)) selected = path.resolve(hint.packagePath);
    else {
      let candidate = selected;
      for (let depth = 0; depth < 8 && isAuthorizedAssetFile(candidate) && path.basename(candidate).toLowerCase() !== 'assets'; depth++) {
        try { if ((await fs.stat(path.join(candidate, 'meta.json'))).isFile()) { selected = candidate; break; } }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
        const parent = path.dirname(candidate); if (parent === candidate) break; candidate = parent;
      }
    }
    if (!isAuthorizedAssetFile(selected)) throw new Error('组合模型包目录未授权。');
    if (!packageRoots.includes(selected)) packageRoots.push(selected);
  }
  packageRoots.sort((a,b) => b.length - a.length);
  const folderFor = (file: string) => packageRoots.find(root => contains(root, path.resolve(file))) ?? path.dirname(path.resolve(file));
  visitPaths(definition, value => {
    if (value.startsWith('editor-asset://')) value = decodeAssetUrl(value);
    if (path.isAbsolute(value)) {
      if (!isAuthorizedAssetFile(value)) throw new Error('组合包含未授权资源。');
      const folder = folderFor(value); if (!folders.has(folder)) folders.set(folder, `models/${folders.size}`);
    } else if (value && !value.startsWith('data:')) throw new Error('组合资源必须先下载到本地。');
    return value;
  });
  const files: FileEntry[] = []; let bytes = 0;
  const copy = async (source: string, relative: string, depth: number): Promise<void> => {
    if (depth > 32 || files.length >= 100000) throw new Error('组合包文件层级或数量超过限制。');
    const st = await fs.lstat(source);
    if (!isAuthorizedAssetFile(await fs.realpath(source))) throw new Error('组合资源真实路径未授权。');
    if (st.isSymbolicLink()) throw new Error('组合资源不能包含符号链接。');
    if (st.isDirectory()) {
      for (const child of await fs.readdir(source)) await copy(path.join(source, child), `${relative}/${child}`, depth + 1);
    } else if (st.isFile()) {
      if (!isAuthorizedAssetFile(source)) throw new Error('组合包包含未授权文件。');
      if ((bytes += st.size) > 8 * 1024 ** 3) throw new Error('组合包超过 8 GB。');
      const target = safe(dir, relative); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.copyFile(source, target);
      const after = await fs.stat(source);
      if (after.size !== st.size || after.mtimeMs !== st.mtimeMs) throw new Error('保存期间模型文件发生变化，请重试。');
      files.push({ path: relative, size: st.size, sha256: await compositionHash(target) });
    } else throw new Error('组合包包含不支持的文件。');
  };
  for (const [folder, relative] of folders) {
    const relativeTarget = path.relative(folder, dir);
    if (!relativeTarget || (!relativeTarget.startsWith('..') && !path.isAbsolute(relativeTarget))) throw new Error('组合资源目录不能包含目标目录。');
    await copy(folder, relative, 0);
  }
  const portable = visitPaths(definition, value => {
    const url = value.startsWith('editor-asset://'), file = url ? decodeAssetUrl(value) : value;
    if (!path.isAbsolute(file)) return value;
    const folder = folderFor(file);
    const relative = folders.get(folder);
    if (!relative) throw new Error('组合资源未纳入清单。');
    return `${url ? 'composition-file:' : 'composition-path:'}${relative}/${path.relative(folder, file).split(path.sep).join('/')}`;
  }) as CompositionDefinition;
  if (thumbnail) {
    if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(thumbnail) || thumbnail.length > 4 * 1024 * 1024) throw new Error('组合缩略图无效。');
    const data = Buffer.from(thumbnail.split(',')[1], 'base64'); await fs.writeFile(path.join(dir, 'thumbnail.png'), data);
    files.push({ path: 'thumbnail.png', size: data.length, sha256: createHash('sha256').update(data).digest('hex') });
  }
  if (preview) {
    const bytes = Buffer.from(preview);
    if (bytes.length < 20 || bytes.length > 64 * 1024 * 1024 || bytes.readUInt32LE(0) !== 0x46546c67 || bytes.readUInt32LE(8) !== bytes.length) throw new Error('组合预览 GLB 无效。');
    await fs.writeFile(path.join(dir, 'preview.glb'), bytes);
    files.push({ path: 'preview.glb', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  const manifest = JSON.stringify({ schemaVersion: 1, definition: portable, files: files.sort((a,b) => a.path.localeCompare(b.path)) } satisfies CompositionManifest);
  await fs.writeFile(path.join(dir, 'composition.json'), manifest, 'utf8'); return digest(manifest);
}
export async function saveCompositionPackage(root: string, request: CompositionSaveRequest, sourceKey?: string, packageHints: Array<{path:string;packagePath?:string}> = []): Promise<CompositionLibraryEntry> {
  return exclusive(root, async () => {
    const entries = await readCompositionIndex(root), previous = request.targetId ? entries.find(e => e.id === request.targetId) : undefined;
    if (request.targetId && (!previous || previous.revision !== request.expectedRevision)) throw new Error('组合版本已变化或卡片已删除，请刷新后重试。');
    const id = previous?.id ?? randomUUID(), revision = randomUUID();
    const dir = path.join(compositionRoot(root), id, revision); await fs.mkdir(dir, { recursive: true });
    try {
    const definition = structuredClone(request.definition); if (previous) definition.name = previous.name;
    for (const node of definition.nodes) {
      const asset = node.components.modelAsset as Record<string, unknown> | undefined;
      if (asset) delete asset.sourceSnapshot;
    }
    const contentSha256 = await buildPackage(definition, dir, request.thumbnailDataUrl, request.previewGlb, packageHints);
    const entry: CompositionLibraryEntry = { ...previous, id, revision, previousRevision: previous?.revision, sourceKey: previous?.sourceKey ?? sourceKey, name: definition.name, definition, memberCount: definition.nodes.filter(n => !n.isFolder && (n.components.modelAsset || n.components.meshRenderer)).length, packagePath: dir,
      contentSha256, thumbnailUrl: request.thumbnailDataUrl ? encodeAssetUrl(path.join(dir, 'thumbnail.png')) : undefined, updatedAt: new Date().toISOString(), syncStatus: 'pending', syncError: undefined };
    const materialized = await materializeComposition(entry);
    // 先校验不可变版本，再切换库索引；失败不会破坏上一版。
    const { definition: _definition, ...metadata } = entry;
    await fs.writeFile(path.join(dir, 'entry.json'), JSON.stringify(metadata), 'utf8');
    await writeCompositionIndex(root, previous ? entries.map(e => e.id === id ? entry : e) : [...entries, entry]);
    return materialized;
    } catch (error) {
      const relative = path.relative(path.resolve(compositionRoot(root)), path.resolve(dir));
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('组合临时目录越界。');
      await fs.rm(dir, { recursive: true, force: true });
      throw error;
    }
  });
}
export async function restoreCompositionPackage(root: string, id: string, expectedRevision: string): Promise<CompositionLibraryEntry> {
  if (!ID.test(id)) throw new Error('组合 ID 无效。');
  const current = (await readCompositionIndex(root)).find(e => e.id === id);
  if (!current || current.revision !== expectedRevision) throw new Error('组合版本已变化。');
  const revisions: CompositionLibraryEntry[] = [];
  for (const rev of await fs.readdir(path.join(compositionRoot(root), id))) {
    if (!ID.test(rev) || rev === current.revision) continue;
    try { revisions.push(JSON.parse(await fs.readFile(path.join(compositionRoot(root), id, rev, 'entry.json'), 'utf8'))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  const previous = current.previousRevision ? revisions.find(e => e.revision === current.previousRevision) : revisions.filter(e => e.updatedAt <= current.updatedAt).sort((a,b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  if (!previous) throw new Error('没有可恢复的上一版本。');
  const restored = await materializeComposition(previous);
  const manifest = JSON.parse(await fs.readFile(path.join(previous.packagePath, 'composition.json'), 'utf8')) as CompositionManifest;
  const thumbnailDataUrl = restored.thumbnailUrl ? 'data:image/png;base64,' + (await fs.readFile(path.join(previous.packagePath, 'thumbnail.png'))).toString('base64') : undefined;
  const previewGlb = manifest.files.some(f => f.path === 'preview.glb') ? await fs.readFile(path.join(previous.packagePath, 'preview.glb')) : undefined;
  return saveCompositionPackage(root, { targetId: id, expectedRevision, definition: restored.definition, thumbnailDataUrl, previewGlb });
}
