import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { DigitalTwinModelRecoveryResult, ProjectModelAssetEntry } from '../types.js';
import { readUtf8File } from '../shared/strictUtf8.js';
import { assertRecoveryPathInsideRoot } from '../shared/recoveryPathBoundary.js';
import { collectPublishModelReferences } from '../shared/publishModelRecovery.js';
import { getClickEventModelResourceKey } from '../shared/clickEventModelIdentity.js';
import { normalizeDataPlatformSourceUrl } from './dataPlatformEnvironmentContract.js';
import { collectDigitalTwinResourceIds, parseDataPlatformResourceKey, type DigitalTwinResourceKey } from './digitalTwinPublishProtocol.js';
import { DataPlatformHttpError, requestDataPlatformJson } from './dataPlatformTransfer.js';
import { syncSceneDataPlatformModelAssets } from './dataPlatformModelIncrementalSync.js';
import { authorizeAssetFile, decodeAssetUrl, isAuthorizedAssetFile, isPathInsideAuthorizedAssetRoot } from './assetRegistry.js';
import { scanModelPackage } from './modelPackageScanner.js';
import { createDataPlatformModelRuntimeRevision } from './dataPlatformModelIndex.js';
import { isPathInsideOrEqual } from './deploymentExportFileSystem.js';

const MAX_CONCURRENCY = 4;
const MAX_RESOURCE_IDS = 4096;
const MAX_MAPPING_BYTES = 1024 * 1024;
const ID = /^[1-9]\d{0,63}$/;
const REVISION = /^[a-f\d]{64}$/i;
type JsonObject = Record<string, unknown>;
const object = (value: unknown): value is JsonObject => !!value && typeof value === 'object' && !Array.isArray(value);
const resourceKey = (resource: DigitalTwinResourceKey) => `${resource.type}:${resource.id}`;
const labels = { MODEL: '普通模型', ENV_MODEL: '环境模型', COMBO_MODEL: '组合模型' } as const;
const endpoints = { MODEL: 'api/v1/models/detail', ENV_MODEL: 'api/v1/env-models/detail', COMBO_MODEL: 'api/v1/combo-models/detail' } as const;
const missingBusinessCode = (value: unknown): boolean => typeof value === 'string'
  && /^(MODEL|ENV_MODEL|COMBO_MODEL|RESOURCE)?_?NOT_FOUND$/.test(value.trim().toUpperCase());

export type PublishResourceIdentityIssue = DigitalTwinResourceKey & {
  reason: 'missing' | 'identity-mismatch' | 'query-failed' | 'revision-mismatch';
  message: string;
  entityNames: string[];
};

export class PublishResourceIdentityError extends Error {
  readonly code = 'PUBLISH_RESOURCE_IDENTITY_INVALID';
  readonly issues: readonly PublishResourceIdentityIssue[];
  constructor(issues: readonly PublishResourceIdentityIssue[], baseUrl: string) {
    super(`发布资源身份校验失败，目标中台：${baseUrl}\n${issues.map(issue =>
      `[${labels[issue.type]} ${issue.id}]${issue.entityNames.length ? ` ${issue.entityNames.join('、')}` : ''}：${issue.message}`).join('\n')}`);
    this.name = 'PublishResourceIdentityError';
    this.issues = issues;
  }
}

function resourcesIn(contents: readonly string[]): DigitalTwinResourceKey[] {
  const ids = collectDigitalTwinResourceIds(contents);
  const resources: DigitalTwinResourceKey[] = [
    ...ids.modelIds.map(id => ({ type: 'MODEL' as const, id })),
    ...ids.envModelIds.map(id => ({ type: 'ENV_MODEL' as const, id })),
    ...ids.comboModelIds.map(id => ({ type: 'COMBO_MODEL' as const, id })),
  ];
  if (resources.length > MAX_RESOURCE_IDS) throw new Error(`发布引用的独立资源超过 ${MAX_RESOURCE_IDS} 项，无法执行有界身份校验。`);
  if (resources.some(resource => !ID.test(resource.id))) throw new Error('发布场景含有无效的中台资源 ID。');
  return resources;
}

function collectEntityNames(contents: readonly string[]): Map<string, string[]> {
  const names = new Map<string, Set<string>>();
  const add = (value: unknown, name: string) => {
    for (const resource of resourcesIn([JSON.stringify(value)])) {
      const key = resourceKey(resource), bucket = names.get(key) ?? new Set<string>();
      if (bucket.size < 8) bucket.add(name.replace(/\s+/g, ' ').slice(0, 160));
      names.set(key, bucket);
    }
  };
  for (const content of contents) {
    const parsed: unknown = JSON.parse(content);
    if (!object(parsed)) continue;
    const scene = object(parsed.scene) ? parsed.scene : parsed;
    if (object(scene.entities)) for (const [id, entity] of Object.entries(scene.entities)) {
      if (object(entity)) add(entity, typeof entity.name === 'string' && entity.name.trim() ? entity.name : id);
    }
    if (object(scene.sceneSettings)) add(scene.sceneSettings, `${typeof scene.name === 'string' ? scene.name : '场景'} / 场景设置`);
  }
  return new Map([...names].map(([key, value]) => [key, [...value]]));
}

async function bounded<T, U>(items: readonly T[], signal: AbortSignal, run: (item: T) => Promise<U>): Promise<U[]> {
  const result: U[] = new Array(items.length); let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENCY, items.length) }, async () => {
    for (;;) {
      signal.throwIfAborted(); const index = cursor++; if (index >= items.length) return;
      result[index] = await run(items[index]);
    }
  }));
  return result;
}

function responseId(value: unknown): string | null {
  if (typeof value === 'string' && ID.test(value.trim())) return value.trim();
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : null;
}

async function inspectIdentity(resource: DigitalTwinResourceKey, baseUrl: string, signal: AbortSignal, entityNames: string[] = []): Promise<{
  record?: JsonObject; issue?: PublishResourceIdentityIssue;
}> {
  const issue = (reason: PublishResourceIdentityIssue['reason'], message: string) => ({ issue: { ...resource, reason, message, entityNames } });
  let response: unknown;
  try {
    response = await requestDataPlatformJson({ baseUrl, endpointPath: endpoints[resource.type], body: { id: resource.id }, signal,
      timeoutMs: 20000, context: `查询发布资源 ${resource.type} ${resource.id}` });
  } catch (error) {
    signal.throwIfAborted();
    const message = error instanceof Error ? error.message : String(error);
    const missing = error instanceof DataPlatformHttpError && error.httpStatus < 500
      && ![401, 403, 408, 429].includes(error.httpStatus)
      && (missingBusinessCode(error.businessCode) || (!error.businessCode && [404, 410].includes(error.httpStatus)));
    return missing
      ? issue('missing', `目标中台未找到该资源或资源不可见：${message}`)
      : issue('query-failed', `身份查询失败，不能判定资源不存在：${message}`);
  }
  signal.throwIfAborted();
  if (!object(response)) return issue('query-failed', '中台详情响应格式无效，无法确认资源身份。');
  const code = response.code ?? response.errorCode ?? (object(response.error) ? response.error.code : undefined);
  const message = typeof response.message === 'string' ? response.message : '';
  const notFound = missingBusinessCode(code);
  if (response.success !== true) return notFound ? issue('missing', `目标中台不存在该资源${message ? `：${message}` : ''}`)
    : issue('query-failed', `中台拒绝身份查询${message ? `：${message}` : ''}`);
  if (response.data === null || response.data === undefined) return issue('missing', '目标中台不存在该资源，详情为空。');
  if (!object(response.data)) return issue('query-failed', '中台详情 data 格式无效。');
  const actual = responseId(response.data.id);
  if (actual !== resource.id) return issue('identity-mismatch', `中台响应 ID 与请求身份不匹配，请求 ${resource.id}，返回 ${actual ?? '无效 ID'}。`);
  return { record: response.data };
}

/** 只查询三类资源详情，不修改场景、不下载、不绑定，也不按名称寻找替代资源。 */
export async function assertPublishResourceIdentities(sceneContents: readonly string[], baseUrl: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const resources = resourcesIn(sceneContents);
  if (!resources.length) return;
  const targetBaseUrl = normalizeDataPlatformSourceUrl(baseUrl), names = collectEntityNames(sceneContents);
  const inspected = await bounded(resources, signal, resource => inspectIdentity(resource, targetBaseUrl, signal, names.get(resourceKey(resource))));
  const issues = inspected.flatMap(result => result.issue ? [result.issue] : []);
  if (issues.length) throw new PublishResourceIdentityError(issues, targetBaseUrl);
}

export type PublishResourceMappingEntry = {
  targetBaseUrl: string; kind: 'model' | 'combo'; sourceId: string; sourceRevision: string;
  targetId: string; targetRevision: string; sourceBaseUrl?: string;
};
export type PublishModelIdentityContext = {
  baseUrl: string; workspaceRoot: string; sharedResourcesRoot: string; projectRoot?: string;
};
const mappingKey = (entry: Pick<PublishResourceMappingEntry, 'targetBaseUrl' | 'kind' | 'sourceId' | 'sourceRevision'>) =>
  JSON.stringify([entry.targetBaseUrl, entry.kind, entry.sourceId, entry.sourceRevision]);

async function readMappings(workspaceRoot: string, signal: AbortSignal): Promise<PublishResourceMappingEntry[]> {
  const file = path.join(workspaceRoot, '.babylon-editor', 'publish-resource-mappings.json');
  signal.throwIfAborted();
  try {
    await assertRecoveryPathInsideRoot(workspaceRoot, file);
    const info = await fs.lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_MAPPING_BYTES) throw new Error('映射必须为不超过 1 MiB 的普通文件。');
    const value: unknown = JSON.parse(await readUtf8File(file, '发布资源映射'));
    signal.throwIfAborted();
    if (!object(value) || value.version !== 1 || !Array.isArray(value.entries) || value.entries.length > MAX_RESOURCE_IDS
      || Object.keys(value).some(key => key !== 'version' && key !== 'entries')) throw new Error('映射文件 schema 无效。');
    const allowed = new Set(['targetBaseUrl', 'kind', 'sourceId', 'sourceRevision', 'targetId', 'targetRevision', 'sourceBaseUrl']);
    const entries = new Map<string, PublishResourceMappingEntry>();
    for (const item of value.entries) {
      if (!object(item) || Object.keys(item).some(key => !allowed.has(key)) || (item.kind !== 'model' && item.kind !== 'combo')
        || typeof item.targetBaseUrl !== 'string' || typeof item.sourceId !== 'string' || !ID.test(item.sourceId)
        || typeof item.targetId !== 'string' || !ID.test(item.targetId)
        || typeof item.sourceRevision !== 'string' || !REVISION.test(item.sourceRevision)
        || typeof item.targetRevision !== 'string' || !REVISION.test(item.targetRevision)
        || ('sourceBaseUrl' in item && typeof item.sourceBaseUrl !== 'string')) throw new Error('映射条目字段、资源 ID 或内容修订无效。');
      const entry: PublishResourceMappingEntry = { targetBaseUrl: normalizeDataPlatformSourceUrl(item.targetBaseUrl), kind: item.kind,
        sourceId: item.sourceId, sourceRevision: item.sourceRevision.toLowerCase(), targetId: item.targetId, targetRevision: item.targetRevision.toLowerCase(),
        ...(typeof item.sourceBaseUrl === 'string' ? { sourceBaseUrl: normalizeDataPlatformSourceUrl(item.sourceBaseUrl) } : {}) };
      const key = mappingKey(entry), previous = entries.get(key);
      if (previous && JSON.stringify(previous) !== JSON.stringify(entry)) throw new Error(`映射条目重复冲突：${entry.kind} ${entry.sourceId} @ ${entry.sourceRevision}。`);
      entries.set(key, entry);
    }
    return [...entries.values()];
  } catch (error) {
    signal.throwIfAborted();
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new Error(`发布资源映射不可用：${error instanceof Error ? error.message : String(error)}`);
  }
}

function sourceIdentity(asset: JsonObject): { kind: 'model' | 'combo'; id: string } | null {
  const fromUrl = getClickEventModelResourceKey(asset.sourceUrl)?.split(':');
  const pathId = fromUrl ? { kind: fromUrl[0] as 'model' | 'combo', id: fromUrl[1] }
    : typeof asset.sourcePath === 'string' ? parseDataPlatformResourceKey(asset.sourcePath) : null;
  const inferred = pathId && ('kind' in pathId ? pathId : pathId.type === 'ENV_MODEL' ? null
    : { kind: pathId.type === 'MODEL' ? 'model' as const : 'combo' as const, id: pathId.id });
  const explicit = asset.dataPlatformModel;
  if (!object(explicit)) return inferred;
  if ((explicit.kind !== 'model' && explicit.kind !== 'combo') || typeof explicit.resourceId !== 'string' || !ID.test(explicit.resourceId)) {
    throw new Error('场景模型的显式资源身份无效，不能应用持久映射。');
  }
  if (inferred && (inferred.kind !== explicit.kind || inferred.id !== explicit.resourceId)) throw new Error('场景模型路径与显式资源身份冲突，不能应用持久映射。');
  return { kind: explicit.kind, id: explicit.resourceId };
}

/** 原文件缺失时可使用明确映射；可读原包存在时必须验证真实内容，防止陈旧修订字段掩盖本地编辑。 */
async function assertReadableSourceRevision(asset: JsonObject, entry: PublishResourceMappingEntry,
  context: PublishModelIdentityContext, signal: AbortSignal): Promise<void> {
  const candidates = new Set<string>();
  if (typeof asset.sourceUrl === 'string' && asset.sourceUrl.startsWith('editor-asset://local/')) {
    try { candidates.add(decodeAssetUrl(asset.sourceUrl)); } catch { /* 无可读取路径时仍由明确映射恢复。 */ }
  }
  if (typeof asset.sourcePath === 'string' && path.isAbsolute(asset.sourcePath)) candidates.add(path.resolve(asset.sourcePath));
  for (const file of candidates) {
    signal.throwIfAborted();
    if (!isAuthorizedAssetFile(file) && !isPathInsideAuthorizedAssetRoot(file)) continue;
    let info;
    try { info = await fs.lstat(file); } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) continue;
      throw error;
    }
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`原模型 ${entry.sourceId} 不是可校验的普通文件，已停止身份映射。`);
    let packageRoot = path.dirname(file);
    const pattern = new RegExp(`^${entry.kind}-${entry.sourceId}(?:-|$)`, 'i');
    for (let depth = 0; !pattern.test(path.basename(packageRoot)); depth++) {
      const parent = path.dirname(packageRoot);
      if (depth >= 16 || parent === packageRoot) { packageRoot = path.dirname(file); break; }
      packageRoot = parent;
    }
    const root = [context.projectRoot, context.sharedResourcesRoot, path.join(context.workspaceRoot, 'Assets')]
      .find(candidate => candidate && isPathInsideOrEqual(candidate, packageRoot))
      ?? (isPathInsideAuthorizedAssetRoot(packageRoot) ? packageRoot : undefined);
    if (!root) throw new Error(`原模型 ${entry.sourceId} 的完整包读取范围未授权，不能验证 sourceRevision。`);
    await assertRecoveryPathInsideRoot(root, packageRoot);
    const entries = await fs.readdir(packageRoot, { withFileTypes: true });
    if (entries.some(item => item.isSymbolicLink())) throw new Error(`原模型 ${entry.sourceId} 包含链接，不能验证 sourceRevision。`);
    const scanned = (await scanModelPackage(packageRoot)).asset;
    if (!scanned?.metadataPath || path.resolve(scanned.path).toLowerCase() !== path.resolve(file).toLowerCase()) {
      throw new Error(`原模型 ${entry.sourceId} 缺少可唯一确认的主文件或元数据，不能验证 sourceRevision。`);
    }
    for (const packageFile of [scanned.path, scanned.metadataPath, ...(scanned.scriptPaths ?? []), ...(scanned.thumbnailPath ? [scanned.thumbnailPath] : [])]) {
      await assertRecoveryPathInsideRoot(packageRoot, packageFile);
    }
    const actual = await createDataPlatformModelRuntimeRevision({ modelPath: scanned.path, metadataPath: scanned.metadataPath,
      scriptPaths: scanned.scriptPaths ?? [], thumbnailPath: scanned.thumbnailPath ?? null });
    signal.throwIfAborted();
    if (actual.runtimeRevision !== entry.sourceRevision) throw new Error(`原模型 ${entry.sourceId} 的当前包内容修订与 sourceRevision 不一致，已停止身份映射并保留本地文件。`);
  }
}

/** 只应用经用户持久记录、来源内容指纹精确匹配的身份映射；目标包下载后再次验证内容修订。 */
export async function resolvePublishModelIdentityReplacements(sceneContent: string, context: PublishModelIdentityContext,
  signal: AbortSignal, onProgress: (message: string) => void = () => {}): Promise<DigitalTwinModelRecoveryResult> {
  signal.throwIfAborted();
  if (typeof sceneContent !== 'string' || Buffer.byteLength(sceneContent, 'utf8') > 64 * 1024 * 1024) throw new Error('发布身份恢复场景内容无效或超过 64 MiB。');
  const parsed: unknown = JSON.parse(sceneContent);
  if (!object(parsed) || typeof parsed.version !== 'number' || ![1, 2, 3, 4, 5].includes(parsed.version) || !object(parsed.scene)) throw new Error('发布身份恢复场景格式无效。');
  const baseUrl = normalizeDataPlatformSourceUrl(context.baseUrl);
  const entries = await readMappings(path.resolve(context.workspaceRoot), signal);
  if (!entries.length) return { replacements: [] };
  const index = new Map(entries.map(entry => [mappingKey(entry), entry]));
  const references = collectPublishModelReferences(parsed.scene);
  const allAssets = [...references.models.map(reference => reference.asset), ...references.devices];
  const matches = new Map<string, { entry: PublishResourceMappingEntry; sourceUrls: Set<string> }>();
  const byUrl = new Map<string, string>();
  for (const asset of allAssets) {
    const source = sourceIdentity(asset);
    if (!source || typeof asset.assetRevision !== 'string' || !REVISION.test(asset.assetRevision)) continue;
    const entry = index.get(mappingKey({ targetBaseUrl: baseUrl, kind: source.kind, sourceId: source.id, sourceRevision: asset.assetRevision.toLowerCase() }));
    if (!entry) continue;
    if (typeof asset.sourceUrl !== 'string' || !asset.sourceUrl) throw new Error('映射来源缺少有效的模型 URL，不能安全回写。');
    const key = mappingKey(entry), previousKey = byUrl.get(asset.sourceUrl);
    if (previousKey && previousKey !== key) throw new Error('同一模型 URL 对应多个冲突的映射修订，已停止恢复。');
    byUrl.set(asset.sourceUrl, key);
    const matched = matches.get(key) ?? { entry, sourceUrls: new Set<string>() };
    matched.sourceUrls.add(asset.sourceUrl); matches.set(key, matched);
  }
  if (!matches.size) return { replacements: [] };
  // 既有 DTO 按 URL 整组回写，不能让同 URL 的无版本实例顺带获得 ID-only 映射。
  for (const asset of allAssets) {
    const key = typeof asset.sourceUrl === 'string' ? byUrl.get(asset.sourceUrl) : undefined;
    if (!key) continue;
    if (typeof asset.assetRevision !== 'string' || asset.assetRevision.toLowerCase() !== matches.get(key)!.entry.sourceRevision) {
      throw new Error('同一模型 URL 包含未匹配 sourceRevision 的引用，已停止整组身份映射。');
    }
  }
  const sourcesToVerify = new Map<string, { asset: JsonObject; entry: PublishResourceMappingEntry }>();
  for (const asset of allAssets) {
    const key = typeof asset.sourceUrl === 'string' ? byUrl.get(asset.sourceUrl) : undefined;
    if (!key) continue;
    const entry = matches.get(key)!.entry;
    sourcesToVerify.set(JSON.stringify([asset.sourceUrl, asset.sourcePath, entry.sourceRevision]), { asset, entry });
  }
  await bounded([...sourcesToVerify.values()], signal, ({ asset, entry }) => assertReadableSourceRevision(asset, entry, context, signal));
  const targets = new Map<string, PublishResourceMappingEntry>();
  for (const { entry } of matches.values()) {
    const key = `${entry.kind}:${entry.targetId}`, previous = targets.get(key);
    if (previous && previous.targetRevision !== entry.targetRevision) throw new Error(`映射目标 ${entry.targetId} 同时要求不同内容修订，已停止恢复。`);
    targets.set(key, entry);
  }
  const checked = await bounded([...targets.values()], signal, async entry => {
    const resource: DigitalTwinResourceKey = { type: entry.kind === 'model' ? 'MODEL' : 'COMBO_MODEL', id: entry.targetId };
    const result = await inspectIdentity(resource, baseUrl, signal, [`映射来源 ${entry.sourceId}`]);
    if (!result.issue && typeof result.record?.runtimeRevision === 'string' && REVISION.test(result.record.runtimeRevision)
      && result.record.runtimeRevision.toLowerCase() !== entry.targetRevision) {
      return { issue: { ...resource, reason: 'revision-mismatch' as const, entityNames: [`映射来源 ${entry.sourceId}`],
        message: '目标模型内容版本已变化，与持久映射的 targetRevision 不一致。' } };
    }
    return result;
  });
  const issues = checked.flatMap(result => result.issue ? [result.issue] : []);
  if (issues.length) throw new PublishResourceIdentityError(issues, baseUrl);
  await assertRecoveryPathInsideRoot(context.workspaceRoot, context.sharedResourcesRoot);
  const downloaded = await bounded([...targets.entries()], signal, async ([key, entry]): Promise<[string, ProjectModelAssetEntry]> => {
    onProgress(`正在验证身份映射 ${entry.kind} ${entry.sourceId} → ${entry.targetId} 并获取固定版本…`);
    const [asset] = await syncSceneDataPlatformModelAssets({ baseUrl, sharedResourcesRoot: context.sharedResourcesRoot,
      resources: [{ kind: entry.kind, resourceId: entry.targetId }], signal, onProgress });
    signal.throwIfAborted();
    if (!asset || asset.dataPlatformResourceId !== entry.targetId || !getClickEventModelResourceKey(asset.sourceUrl)?.startsWith(`${entry.kind}:${entry.targetId}:`)) {
      throw new Error(`映射目标 ${entry.targetId} 下载后的资源身份不匹配，已停止发布。`);
    }
    if (asset.assetRevision?.toLowerCase() !== entry.targetRevision) throw new Error(`映射目标 ${entry.targetId} 下载后的内容修订与 targetRevision 不一致，已停止发布。`);
    const files = [...new Set([asset.path, asset.metadataPath, asset.thumbnailPath, ...(asset.scriptPaths ?? []),
      ...(asset.scriptAssets ?? []).map(script => script.path)].filter((file): file is string => typeof file === 'string' && !!file))];
    for (const file of files) await assertRecoveryPathInsideRoot(context.sharedResourcesRoot, file);
    signal.throwIfAborted();
    for (const file of files) authorizeAssetFile(file);
    return [key, asset];
  });
  const assets = new Map(downloaded);
  return { replacements: [...matches.values()].map(({ entry, sourceUrls }) => ({ sourceUrls: [...sourceUrls], asset: assets.get(`${entry.kind}:${entry.targetId}`)! })) };
}
