import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { normalizeDataPlatformBaseUrl } from './dataPlatformBindingStore.js';
import { encodeAssetUrl } from './assetRegistry.js';
import { validateSkyboxSourceFile } from './skyboxAssetStore.js';
import { assertRecoveryPathInsideRoot } from '../shared/recoveryPathBoundary.js';
import { requestDataPlatformJson } from './dataPlatformTransfer.js';
import { assertUniqueSkyboxRecords, normalizeSkyboxQueryResponse, type DataPlatformSkyboxRecord } from './dataPlatformSkyboxContract.js';
import { readDataPlatformSkyboxIndex } from './dataPlatformSkyboxIndex.js';
import { resolveDeploymentSkyboxReference } from './deploymentSkyboxCache.js';

type Skybox = Record<string, unknown>;
export type PublishSkyboxRecoveryOptions = {
  skybox: Skybox;
  baseUrl: string;
  sharedResourcesRoot: string;
  signal: AbortSignal;
  isAuthorizedLocalFile: (filePath: string) => boolean;
  dependencies?: {
    queryRecords?: (baseUrl: string, signal: AbortSignal) => Promise<DataPlatformSkyboxRecord[]>;
    syncSkyboxes?: (baseUrl: string, sharedResourcesRoot: string, signal: AbortSignal) => Promise<void>;
  };
};

/** 发布前将已授权外部天空盒固定到受管副本；缺失资源只按稳定身份向对应中台恢复。 */
export async function recoverPublishSkyboxReference(options: PublishSkyboxRecoveryOptions): Promise<{
  skybox: Skybox; sourcePath: string; recovered: boolean;
}> {
  const { skybox, signal } = options;
  signal.throwIfAborted();
  const baseUrl = normalizeDataPlatformBaseUrl(options.baseUrl);
  if (!path.isAbsolute(options.sharedResourcesRoot)) throw new Error('天空盒恢复缓存必须是绝对路径。');
  const sharedRoot = path.resolve(options.sharedResourcesRoot);
  const sourcePath = readSourcePath(skybox);
  const explicitId = skybox.dataPlatformResourceId;
  if (explicitId !== undefined && (typeof explicitId !== 'string' || !/^[1-9]\d{0,63}$/.test(explicitId))) throw new Error('天空盒资源 ID 无效。');
  const pathId = /(?:^|[\\/])Skybox-([1-9]\d{0,63})(?:[\\/]|$)/.exec(sourcePath ?? '')?.[1];
  if (explicitId && pathId && explicitId !== pathId) throw new Error('天空盒资源 ID 与原路径身份不一致。');
  let resourceId = typeof explicitId === 'string' ? explicitId : pathId;
  const expectedHash = typeof skybox.assetRevision === 'string' && /^[a-f\d]{64}$/i.test(skybox.assetRevision)
    ? skybox.assetRevision.toLowerCase() : null;
  let local: { hash: string; format: 'hdr' | 'exr'; size: number } | null = null;
  try {
    if (!sourcePath) throw Object.assign(new Error('天空盒使用远程资源引用。'), { code: 'ENOENT' });
    const stat = await fs.lstat(sourcePath);
    if (!options.isAuthorizedLocalFile(sourcePath)) throw new Error('原天空盒文件尚未授权，无法导入发布工程。');
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('原天空盒不是安全普通文件。');
    await assertNoSourceLinks(sourcePath);
    if (!options.isAuthorizedLocalFile(await fs.realpath(sourcePath))) throw new Error('原天空盒真实文件尚未授权。');
    const inspection = await validateSkyboxSourceFile(sourcePath);
    if (skybox.format !== inspection.format) throw new Error('原天空盒格式与场景声明不一致。');
    const hash = await hashFile(sourcePath, signal);
    if (expectedHash && hash !== expectedHash) throw new Error('原天空盒内容与场景 SHA-256 版本不一致。');
    local = { hash, format: inspection.format, size: inspection.fileSizeBytes };
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
  }
  if (local && sourcePath && !resourceId) {
    const sourceKey = createHash('sha256').update(baseUrl).digest('hex');
    const packagePath = path.join(sharedRoot, '.babylon-editor', 'publish-skyboxes', sourceKey, local.hash, 'Assets', 'Skyboxes', 'Imported');
    await assertRecoveryPathInsideRoot(sharedRoot, packagePath);
    await fs.mkdir(packagePath, { recursive: true });
    await assertRecoveryPathInsideRoot(sharedRoot, packagePath);
    const target = path.join(packagePath, `skybox.${local.format}`);
    await assertRecoveryPathInsideRoot(sharedRoot, target);
    if (path.resolve(sourcePath) === path.resolve(target)) return result(skybox, target, local.hash);
    const temporary = path.join(packagePath, `.skybox-${randomUUID()}.${local.format}`);
    try {
      await fs.copyFile(sourcePath, temporary, fs.constants.COPYFILE_EXCL);
      signal.throwIfAborted();
      const copied = await validateSkyboxSourceFile(temporary);
      if (copied.fileSizeBytes !== local.size || await hashFile(temporary, signal) !== local.hash) throw new Error('天空盒在导入期间发生变化，请重试。');
      try { await fs.copyFile(temporary, target, fs.constants.COPYFILE_EXCL); }
      catch (error) { if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error; }
      const targetStat = await fs.lstat(target);
      if (!targetStat.isFile() || targetStat.isSymbolicLink() || await hashFile(target, signal) !== local.hash) throw new Error('受管天空盒缓存内容冲突。');
      return result(skybox, target, local.hash);
    } finally { await fs.rm(temporary, { force: true }); }
  }
  if (!resourceId && !expectedHash) throw new Error('天空盒文件缺失且缺少稳定资源 ID 或 SHA-256，无法确定对应中台资源；请重新选择原天空盒。');
  const records = await (options.dependencies?.queryRecords ?? querySkyboxes)(baseUrl, signal);
  assertUniqueSkyboxRecords(records);
  const candidates = resourceId ? records.filter(record => record.id === resourceId) : records.filter(record => record.sha256 === expectedHash);
  if (candidates.length !== 1) throw new Error('无法唯一确定对应中台天空盒资源。');
  const record = candidates[0];
  if (record.format !== skybox.format) throw new Error('中台天空盒格式与场景不一致。');
  const requiredHash = local?.hash ?? expectedHash;
  if (requiredHash && record.sha256 !== requiredHash) throw new Error('中台天空盒版本与场景原内容不一致，无法自动替换。');
  resourceId = record.id;
  const patched = { ...skybox, dataPlatformResourceId: resourceId };
  const existingIndex = await readDataPlatformSkyboxIndex(sharedRoot);
  const existing = existingIndex.entries.find(item => item.resourceId === resourceId);
  if (existing?.sha256 === record.sha256 && existing.format === record.format) {
    try {
      const resolved = await resolveDeploymentSkyboxReference(patched, {
        dataPlatformSkyboxRoot: sharedRoot, dataPlatformSkyboxesById: new Map([[resourceId, existing]]),
      }, new Map(), signal);
      if (resolved) return result(skybox, resolved.sourcePath, existing.sha256, resourceId);
    } catch {
      signal.throwIfAborted();
      // 不可信缓存尝试正规同步；同步后的二次完整校验仍会明确报告无法修复的内容问题。
    }
  }
  await (options.dependencies?.syncSkyboxes ?? syncSkyboxes)(baseUrl, sharedRoot, signal);
  const index = await readDataPlatformSkyboxIndex(sharedRoot);
  const entry = index.entries.find(item => item.resourceId === resourceId);
  if (!entry || entry.sha256 !== record.sha256) throw new Error('天空盒同步结果与已确认版本不一致。');
  const resolved = await resolveDeploymentSkyboxReference(patched, {
    dataPlatformSkyboxRoot: sharedRoot, dataPlatformSkyboxesById: new Map([[resourceId, entry]]),
  }, new Map(), signal);
  if (!resolved) throw new Error('天空盒同步后未能完整校验。');
  return result(skybox, resolved.sourcePath, entry.sha256, resourceId);
}

function result(skybox: Skybox, sourcePath: string, hash: string, resourceId?: string) {
  const next = { ...skybox, sourcePath, packagePath: path.dirname(sourcePath), sourceUrl: encodeAssetUrl(sourcePath), assetRevision: hash,
    ...(resourceId ? { dataPlatformResourceId: resourceId } : {}) };
  return { skybox: next, sourcePath,
    recovered: ['sourcePath', 'packagePath', 'sourceUrl', 'assetRevision', 'dataPlatformResourceId'].some(key => skybox[key] !== (next as Skybox)[key]) };
}
function readSourcePath(skybox: Skybox): string | null {
  let source = typeof skybox.sourcePath === 'string' ? skybox.sourcePath : '';
  if (/^https?:\/\//i.test(source)) return null;
  if (!source && typeof skybox.sourceUrl === 'string') {
    const url = new URL(skybox.sourceUrl);
    if (url.protocol === 'editor-asset:' && url.hostname === 'local') source = decodeURIComponent(url.pathname.slice(1));
  }
  if (!source) return null;
  if (!path.isAbsolute(source)) throw new Error('天空盒原始资源路径无效。');
  return path.resolve(source);
}
async function assertNoSourceLinks(file: string): Promise<void> {
  let current = file;
  for (;;) {
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) throw new Error('原天空盒路径包含符号链接或 junction，无法安全导入。');
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}
async function hashFile(file: string, signal: AbortSignal): Promise<string> {
  const hash = createHash('sha256'); const stream = createReadStream(file);
  try { for await (const chunk of stream) { signal.throwIfAborted(); hash.update(chunk); } }
  finally { stream.destroy(); }
  signal.throwIfAborted(); return hash.digest('hex');
}
async function syncSkyboxes(baseUrl: string, editorRoot: string, signal: AbortSignal): Promise<void> {
  const { executeDataPlatformSkyboxSync } = await import('./dataPlatformSkyboxSync.js');
  await executeDataPlatformSkyboxSync({ baseUrl, editorRoot, signal, contextKey: null });
}
async function querySkyboxes(baseUrl: string, signal: AbortSignal): Promise<DataPlatformSkyboxRecord[]> {
  const records: DataPlatformSkyboxRecord[] = []; let total: number | null = null;
  for (let pageNum = 1; pageNum <= 1_000; pageNum++) {
    signal.throwIfAborted();
    const page = normalizeSkyboxQueryResponse(await requestDataPlatformJson({ baseUrl, endpointPath: 'api/v1/skyboxes/query',
      body: { pageNum, pageSize: 100, skyboxName: '' }, signal, timeoutMs: 20_000, context: '恢复发布天空盒' }));
    if (page.pageNum !== pageNum || page.pageSize !== 100 || (total !== null && total !== page.total)) throw new Error('天空盒分页信息在恢复期间发生变化。');
    total = page.total; records.push(...page.records);
    if (records.length > total) throw new Error('天空盒分页记录超过声明总量。');
    if (records.length === total) return records;
    if (!page.records.length) break;
  }
  throw new Error('天空盒查询未能返回完整清单。');
}
