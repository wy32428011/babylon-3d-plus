import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectPublishModelReferences } from '../shared/publishModelRecovery.js';
import { captureSceneShadowBakeRelocation } from '../shared/sceneShadowBakeContract.js';
import { encodeAssetUrl } from './assetRegistry.js';
import { createDataPlatformModelRuntimeRevision, readDataPlatformModelIndex, type DataPlatformModelIndex } from './dataPlatformModelIndex.js';
import { scanModelPackage, validateGlbModelFile } from './modelPackageScanner.js';

type JsonObject = Record<string, unknown>;
export type LocalSceneResourceKind = 'model' | 'combo' | 'environment' | 'skybox' | 'other';
export type LocalSceneResourceIssue = { resourceKind: LocalSceneResourceKind; resourceId?: string; sourcePath?: string; message: string };
export type MissingLocalSceneResource = {
  resourceKind: LocalSceneResourceKind; resourceId?: string; sourcePath: string;
  sourceValues: string[]; jsonPaths: string[]; expectedRevision?: string; packagePath?: string;
  required: boolean; reason: string;
};
export type RecoverLocalSceneResourcePathsOptions = {
  sceneContent: string; workspaceRoot: string; sceneFilePath?: string; projectRoot?: string | null;
  sourceKey?: string | null; signal?: AbortSignal; additionalMappings?: ReadonlyMap<string, string>;
  isOriginalPathAllowed?: (filePath: string) => boolean;
  /** 多阶段恢复由调用方针对原场景在最终提交前统一验证；中间副本保留原烘焙内容和签名。 */
  shadowBakeRelocation?: 'defer';
};
export type LocalSceneResourceRecoveryResult = {
  sceneContent: string; resolvedFiles: string[]; restoredReferenceCount: number;
  issues: LocalSceneResourceIssue[]; missing: MissingLocalSceneResource[];
};
type ResourceOwner = { value: JsonObject; kind: LocalSceneResourceKind; resourceId?: string; revision?: string; rootPath?: string };
type Reference = {
  owner: ResourceOwner; parent: JsonObject | unknown[]; key: string | number; jsonPath: string;
  value: string; sourcePath: string; suffix: string; url: boolean; directory: boolean; required: boolean; relative: boolean;
};
type Candidate = { file: string; root: string; sourceKey?: string };
type Resolution = { file?: string; isFile?: boolean; supportingFiles?: string[]; error?: string; sourceKey?: string };
const SHA256 = /^[a-f\d]{64}$/i;
const MAX_REFERENCES = 100_000;
const MAX_PACKAGE_FILES = 4096;
const PATH_KEYS = ['sourcePath', 'path', 'packagePath', 'metadataPath', 'thumbnailPath'] as const;
const URL_KEYS = ['sourceUrl', 'activeVariantUrl', 'thumbnailUrl'] as const;
const object = (value: unknown): JsonObject | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined;
const identityKey = (value: string) => path.resolve(value).toLowerCase();
const cancel = (signal?: AbortSignal) => { if (signal?.aborted) throw new Error('本地场景资源恢复已取消。'); };
const isInside = (root: string, target: string) => {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};

/** 只恢复明确资源字段；先校验全部候选，再一次性改写内存副本，不写场景文件或共享缓存。 */
export async function recoverLocalSceneResourcePaths(options: RecoverLocalSceneResourcePathsOptions): Promise<LocalSceneResourceRecoveryResult> {
  cancel(options.signal);
  const parsed: unknown = JSON.parse(options.sceneContent);
  const document = object(object(parsed)?.scene) ?? object(parsed);
  if (!document || !object(document.entities)) throw new Error('本地场景缺少有效 entities 对象。');
  const restoreBake = options.shadowBakeRelocation === 'defer' ? null : captureSceneShadowBakeRelocation(document);
  const references = collectReferences(document, options.sceneFilePath);
  if (references.length > MAX_REFERENCES) throw new Error('本地场景资源引用数量超过 100000 项限制。');
  const groups = new Map<string, Reference[]>();
  for (const reference of references) {
    // 同文件在不同资源身份下引用时分别验证；磁盘校验与版本计算仍共享缓存。
    const key = JSON.stringify([reference.sourcePath.toLowerCase(), reference.owner.kind, reference.owner.resourceId,
      reference.owner.revision, reference.owner.value.dataPlatformModel, reference.owner.value.fileSizeBytes, reference.directory]);
    const group = groups.get(key) ?? []; group.push(reference); groups.set(key, group);
  }
  const resolver = new ResourceResolver(options);
  const resolutions = new Map<Reference[], Resolution>();
  const queue = [...groups.values()]; let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
    for (;;) {
      cancel(options.signal); const group = queue[cursor++]; if (!group) return;
      resolutions.set(group, await resolver.resolve(group[0]));
    }
  }));
  cancel(options.signal);
  const resolvedFiles = new Set<string>(), issues: LocalSceneResourceIssue[] = [], missing: MissingLocalSceneResource[] = [];
  let restoredReferenceCount = 0;
  for (const group of queue) {
    const result = resolutions.get(group)!; const first = group[0];
    if (!result.file) {
      const reason = result.error ?? '原资源不存在，当前工作区中没有可验证的对应文件。';
      issues.push({ resourceKind: first.owner.kind, resourceId: first.owner.resourceId, sourcePath: first.sourcePath, message: reason });
      missing.push({ resourceKind: first.owner.kind, resourceId: first.owner.resourceId, sourcePath: first.sourcePath,
        sourceValues: [...new Set(group.map(item => item.value))], jsonPaths: group.map(item => item.jsonPath),
        expectedRevision: /\/scene-model-versions\/[a-f\d]{64}\/([a-f\d]{64})(?:\/|$)/i.exec(first.sourcePath.replace(/\\/g, '/'))?.[1].toLowerCase()
          ?? first.owner.revision,
        packagePath: first.owner.rootPath, required: group.some(item => item.required), reason });
      continue;
    }
    if (result.isFile) resolvedFiles.add(result.file);
    for (const file of result.supportingFiles ?? []) resolvedFiles.add(file);
    for (const reference of group) {
      // 原文件可用时保留原序列化值及 URL，不产生仅因斜杠形式改变的场景变更。
      if (!reference.relative && identityKey(reference.sourcePath) === identityKey(result.file)) continue;
      (reference.parent as JsonObject)[reference.key] = reference.url ? `${encodeAssetUrl(result.file)}${reference.suffix}` : result.file;
      restoredReferenceCount += 1;
      const identity = object(reference.owner.value.dataPlatformModel);
      if (result.sourceKey && identity) identity.sourceKey = result.sourceKey;
    }
  }
  if (restoreBake && !restoreBake(document)) throw new Error('本地资源恢复改变了已烘焙阴影的资源身份，已停止提交恢复结果。');
  return { sceneContent: restoredReferenceCount ? JSON.stringify(parsed) : options.sceneContent,
    resolvedFiles: [...resolvedFiles], restoredReferenceCount, issues, missing };
}

function collectReferences(document: JsonObject, sceneFilePath?: string): Reference[] {
  const result: Reference[] = [], owners = new Set<JsonObject>();
  const paths = new WeakMap<object, string>();
  const index = (value: unknown, location: string) => {
    if (!value || typeof value !== 'object') return;
    paths.set(value, location);
    for (const [key, child] of Object.entries(value)) if (child && typeof child === 'object') index(child, `${location}.${key}`);
  };
  index(document, 'scene');
  const add = (value: JsonObject, kind: LocalSceneResourceKind) => {
    if (owners.has(value)) return; owners.add(value);
    const source = [value.sourcePath, value.sourceUrl, value.packagePath, value.activeVariantUrl].find(item => typeof item === 'string') as string | undefined;
    const identity = object(value.dataPlatformModel);
    const inferred = source ? inferResourceIdentity(decodeLocalReference(source)?.file ?? source) : undefined;
    const owner: ResourceOwner = { value, kind: identity?.kind === 'combo' ? 'combo' : inferred?.kind ?? kind,
      resourceId: stringValue(identity?.resourceId) ?? stringValue(value.dataPlatformResourceId) ?? inferred?.resourceId,
      revision: stringValue(value.assetRevision) ?? stringValue(value.dataPlatformRevision), rootPath: stringValue(value.packagePath) };
    const addField = (parent: JsonObject | unknown[], key: string | number, directory = false) => {
      const value = (parent as JsonObject)[key]; if (typeof value !== 'string') return;
      const decoded = decodeLocalReference(value); if (!decoded) return;
      let sourcePath = decoded.file;
      const relative = !path.isAbsolute(sourcePath) && !path.win32.isAbsolute(sourcePath);
      const hasParentTraversal = sourcePath.replace(/\\/g, '/').split('/').includes('..');
      if (!hasParentTraversal && !sourcePath.includes('\0') && relative) {
        if (!/^(?:\.\/)?Assets\//i.test(sourcePath.replace(/\\/g, '/')) || !sceneFilePath) return;
        sourcePath = path.resolve(path.dirname(sceneFilePath), sourcePath);
      }
      result.push({ owner, parent, key, jsonPath: `${paths.get(parent) ?? paths.get(owner.value)}.${key}`, value,
        sourcePath, suffix: decoded.suffix, url: decoded.url, directory, relative,
        required: key !== 'thumbnailPath' && key !== 'thumbnailUrl' });
    };
    const addFields = (target: JsonObject, packageDirectory = true) => {
      for (const key of PATH_KEYS) addField(target, key, key === 'packagePath' && packageDirectory);
      for (const key of URL_KEYS) addField(target, key);
      if (Array.isArray(target.scriptPaths)) target.scriptPaths.forEach((_, key) => addField(target.scriptPaths as unknown[], key));
      if (Array.isArray(target.scriptAssets)) for (const script of target.scriptAssets) { const asset = object(script); if (asset) addFields(asset, false); }
    };
    addFields(value);
    if (Array.isArray(value.variants)) for (const variant of value.variants) { const asset = object(variant); if (asset) addFields(asset, false); }
  };
  const collected = collectPublishModelReferences(document);
  for (const { asset } of collected.models) add(asset, 'model');
  for (const asset of collected.devices) add(asset, 'model');
  const environment = object(object(document.sceneSettings)?.environment); if (environment) add(environment, 'environment');
  for (const entity of Object.values(object(document.entities) ?? {})) {
    const components = object(object(entity)?.components);
    for (const [key, kind] of [['skybox', 'skybox'], ['cadReference', 'other'], ['imageAsset', 'other']] as const) {
      const value = object(components?.[key]); if (value) add(value, kind);
    }
  }
  return result;
}

function stringValue(value: unknown): string | undefined { return typeof value === 'string' && value.trim() ? value : undefined; }
function decodeLocalReference(value: string): { file: string; suffix: string; url: boolean } | undefined {
  if (/^editor-asset:/i.test(value)) {
    try {
      const url = new URL(value);
      if (url.hostname !== 'local' || url.username || url.password || url.port || url.pathname.length < 2) throw new Error('资产 URL 无效');
      return { file: decodeURIComponent(url.pathname.slice(1)), suffix: url.search + url.hash, url: true };
    }
    catch { return { file: '\0无效资产 URL', suffix: '', url: true }; }
  }
  if (/^file:/i.test(value)) {
    try { const url = new URL(value); return { file: fileURLToPath(url), suffix: url.search + url.hash, url: true }; }
    catch { return { file: '\0无效文件 URL', suffix: '', url: true }; }
  }
  if (/^[a-z][a-z\d+.-]*:/i.test(value) && !/^[a-z]:[\\/]/i.test(value)) return undefined;
  if (/^(?:[a-z]:[\\/]|\/|\\|(?:\.\/)?Assets[\\/])/i.test(value)) return { file: value, suffix: '', url: false };
  return undefined;
}
function inferResourceIdentity(file: string): { kind: LocalSceneResourceKind; resourceId: string } | undefined {
  const normalized = file.replace(/\\/g, '/');
  const match = /(?:^|\/)(Model|Combo|Env|Skybox)-(\d{1,64})(?:-|\/|$)/i.exec(normalized);
  if (match) return { kind: ({ model: 'model', combo: 'combo', env: 'environment', skybox: 'skybox' } as const)[match[1].toLowerCase() as 'model'], resourceId: match[2] };
  const environment = /\/data-platform-cache\/environments\/[^/]+\/(\d{1,64})\//i.exec(normalized);
  return environment ? { kind: 'environment', resourceId: environment[1] } : undefined;
}

class ResourceResolver {
  private readonly files = new Map<string, Promise<{ real: string; isFile: boolean; size: number }>>();
  private readonly models = new Map<string, Promise<void>>();
  private readonly versions = new Map<string, Promise<{ layout: string; files: string[] }>>();
  private readonly hashes = new Map<string, Promise<string>>();
  private readonly gltfFiles = new Map<string, Promise<string[]>>();
  private sharedIndex?: Promise<DataPlatformModelIndex | null>;
  private readonly workspace: string;
  private readonly project: string | null;
  constructor(private readonly options: RecoverLocalSceneResourcePathsOptions) {
    this.workspace = path.resolve(options.workspaceRoot);
    this.project = options.projectRoot ? path.resolve(options.projectRoot) : null;
  }

  async resolve(reference: Reference): Promise<Resolution> {
    cancel(this.options.signal);
    try { this.validateSource(reference); } catch (error) { return { error: message(error) }; }
    const original = path.resolve(reference.sourcePath);
    const failures: string[] = [];
    if (!this.options.isOriginalPathAllowed || this.options.isOriginalPathAllowed(original)) {
      try { return await this.validateCandidate(reference, { file: original, root: this.originalBoundary(original) }); }
      catch (error) { if (!isMissing(error)) failures.push(message(error)); }
    }
    const candidates = this.candidates(reference);
    const valid = new Map<string, Resolution>();
    for (const candidate of candidates) {
      cancel(this.options.signal);
      try { const result = await this.validateCandidate(reference, candidate); valid.set(identityKey(result.file!), result); }
      catch (error) { if (!isMissing(error)) failures.push(message(error)); }
    }
    if (valid.size === 1) return [...valid.values()][0];
    if (valid.size > 1) return { error: '当前工作区和项目目录存在多个有效候选，资源位置有歧义，未自动替换。' };
    if (!this.options.additionalMappings?.has(reference.sourcePath) && !this.options.additionalMappings?.has(reference.value)) {
      try {
        const indexed = await this.indexedCandidate(reference);
        if (indexed) return await this.validateCandidate(reference, indexed);
      } catch (error) { if (!isMissing(error)) failures.push(message(error)); }
    }
    return { error: failures[0] ?? '原资源不存在或未获读取授权，当前工作区中没有可验证的对应文件。' };
  }

  private validateSource(reference: Reference): void {
    const normalized = reference.sourcePath.replace(/\\/g, '/');
    if (/[\x00-\x1f]/.test(normalized) || normalized.split('/').some(part => part === '..' || part === '.')) throw new Error('资源路径包含不安全的路径穿越或控制字符。');
    const inferred = inferResourceIdentity(normalized);
    if (inferred && reference.owner.resourceId && (inferred.resourceId !== reference.owner.resourceId || inferred.kind !== reference.owner.kind)) throw new Error('资源身份与文件路径中的类型或 ID 不一致。');
    const identity = object(reference.owner.value.dataPlatformModel);
    if (inferred && identity?.kind && identity.kind !== inferred.kind) throw new Error('资源身份声明的类型与文件路径不一致。');
    const pinned = /\/scene-model-versions\/([a-f\d]{64})\/([a-f\d]{64})\//i.exec(normalized);
    if (pinned && reference.owner.revision && SHA256.test(reference.owner.revision) && reference.owner.revision.toLowerCase() !== pinned[2].toLowerCase()) throw new Error('场景模型资源版本与固定缓存目录指纹不一致。');
    const sourceKey = identity?.sourceKey;
    if (pinned && typeof sourceKey === 'string' && sourceKey.toLowerCase() !== pinned[1].toLowerCase()) throw new Error('场景模型来源身份与固定缓存路径不一致。');
  }

  private originalBoundary(file: string): string {
    if (isInside(this.workspace, file)) return this.workspace;
    if (this.project && isInside(this.project, file)) return this.project;
    const normalized = file.replace(/\\/g, '/');
    const anchor = /\/(?:Platforms\/[a-f\d]{64}\/Projects\/[^/]+|Projects\/[^/]+|SharedResources)(?:\/|$)/i.exec(normalized);
    return anchor ? path.resolve(normalized.slice(0, anchor.index + anchor[0].length)) : path.dirname(file);
  }

  private candidates(reference: Reference): Candidate[] {
    const result: Candidate[] = [], seen = new Set<string>();
    const add = (file: string, root: string, sourceKey?: string) => {
      const resolved = path.resolve(file), key = identityKey(resolved);
      if (isInside(root, resolved) && !seen.has(key)) { seen.add(key); result.push({ file: resolved, root, sourceKey }); }
    };
    const mapped = this.options.additionalMappings?.get(reference.sourcePath)
      ?? this.options.additionalMappings?.get(reference.value);
    if (mapped) {
      const decoded = decodeLocalReference(mapped)?.file ?? mapped;
      const root = [this.workspace, this.project].find(root => root && isInside(root, path.resolve(decoded)));
      if (root) add(decoded, root);
      else return [{ file: path.resolve(decoded), root: this.workspace }];
      return result;
    }
    const normalized = reference.sourcePath.replace(/\\/g, '/');
    const anchor = /(?:^|\/)((?:Platforms\/[a-f\d]{64}\/Projects\/[^/]+|Projects\/[^/]+|SharedResources)(?:\/.*|$))/i.exec(normalized);
    if (anchor) {
      add(path.join(this.workspace, ...anchor[1].split('/')), this.workspace);
      if (this.options.sourceKey && SHA256.test(this.options.sourceKey)) {
        const migrated = anchor[1].replace(/(\.babylon-editor\/scene-model-versions\/)[a-f\d]{64}(\/[a-f\d]{64}\/)/i, `$1${this.options.sourceKey}$2`);
        if (migrated !== anchor[1]) add(path.join(this.workspace, ...migrated.split('/')), this.workspace);
      }
    }
    if (this.project) {
      const assets = /(?:^|\/)(Assets\/(?:Models|Environments|Skyboxes|Cad|Images)(?:\/.*|$))/i.exec(normalized);
      // 固定版本共享包只能按完整版本结构恢复，不能退回项目内同名的可变包。
      if (assets && !/\/(?:SharedResources|scene-model-versions)\//i.test(normalized)) add(path.join(this.project, ...assets[1].split('/')), this.project);
    }
    return result;
  }

  private async indexedCandidate(reference: Reference): Promise<Candidate | undefined> {
    const normalized = reference.sourcePath.replace(/\\/g, '/');
    const pinned = /\/scene-model-versions\/[a-f\d]{64}\/([a-f\d]{64})\/Assets\/Models\/(?:ComboModels\/)?(?:Model|Combo)-\d+(?:-[^/]+)?(?:\/(.*))?$/i.exec(normalized);
    if (pinned && reference.owner.resourceId && this.options.sourceKey) {
      const index = await this.readSharedIndex();
      const entry = index?.entries.find(entry => entry.kind === reference.owner.kind && entry.resourceId === reference.owner.resourceId && entry.runtimeRevision === pinned[1].toLowerCase());
      if (entry) return { file: path.join(this.workspace, 'SharedResources', entry.packageRelativePath, pinned[2] ?? ''), root: this.workspace, sourceKey: index!.sourceKey };
    }
    return undefined;
  }

  private readSharedIndex(): Promise<DataPlatformModelIndex | null> {
    if (!this.sharedIndex) this.sharedIndex = (async () => {
      const sharedRoot = path.join(this.workspace, 'SharedResources');
      try {
        await this.requireFile(this.workspace, path.join(sharedRoot, '.babylon-editor', 'data-platform-model-index.json'), false);
        const index = await readDataPlatformModelIndex(sharedRoot);
        return index.sourceKey === this.options.sourceKey ? index : null;
      } catch (error) {
        if (isMissing(error)) return null;
        throw error;
      }
    })();
    return this.sharedIndex;
  }

  private async requireFile(root: string, file: string, directory: boolean): Promise<{ real: string; isFile: boolean; size: number }> {
    const key = JSON.stringify([identityKey(root), identityKey(file), directory]);
    let cached = this.files.get(key);
    if (!cached) {
      cached = (async () => {
        if (!isInside(root, file)) throw new Error('候选资源路径不安全：超出当前工作区或项目目录。');
        const [realRoot, realFile, stat] = await Promise.all([fs.realpath(root), fs.realpath(file), fs.lstat(file)]);
        if (!isInside(realRoot, realFile) || stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) throw new Error('候选资源不安全：符号链接越界或不是预期的普通文件/目录。');
        if (!directory && stat.size === 0) throw new Error('候选资源文件为空。');
        return { real: realFile, isFile: stat.isFile(), size: stat.size };
      })(); this.files.set(key, cached);
    }
    return cached;
  }

  private async validateCandidate(reference: Reference, candidate: Candidate): Promise<Resolution> {
    const identity = inferResourceIdentity(candidate.file);
    if (identity && reference.owner.resourceId && (identity.resourceId !== reference.owner.resourceId || identity.kind !== reference.owner.kind)) throw new Error('候选资源身份与原场景类型或 ID 不一致。');
    const stat = await this.requireFile(candidate.root, candidate.file, reference.directory);
    cancel(this.options.signal);
    const normalized = candidate.file.replace(/\\/g, '/');
    const pinned = /\/scene-model-versions\/([a-f\d]{64})\/([a-f\d]{64})\/(Assets\/Models\/(?:ComboModels\/)?(?:Model|Combo)-\d+(?:-[^/]+)?)(?:\/(.*))?$/i.exec(normalized);
    const oldPinned = /\/scene-model-versions\/[a-f\d]{64}\/([a-f\d]{64})\/Assets\/Models\/(?:ComboModels\/)?(?:Model|Combo)-\d+(?:-[^/]+)?(?:\/|$)/i.exec(reference.sourcePath.replace(/\\/g, '/'));
    if (pinned || oldPinned) {
      const packageMatch = /^(.*\/Assets\/Models\/(?:ComboModels\/)?(?:Model|Combo)-\d+(?:-[^/]+)?)(?:\/(.*))?$/i.exec(normalized);
      const packageRoot = packageMatch ? path.resolve(packageMatch[1]) : reference.directory ? candidate.file : path.dirname(candidate.file);
      const verified = await this.verifyPinnedPackage(packageRoot, oldPinned?.[1] ?? pinned![2], candidate.root);
      // runtimeRevision 包含主模型、元数据与脚本；不让额外变体借用主模型的指纹。
      if (stat.isFile && reference.required && !verified.files.some(file => identityKey(file) === identityKey(candidate.file))) throw new Error('候选文件不是固定版本指纹覆盖的模型或脚本。');
      const layout = /-([a-f\d]{12})(?:\/|$)/i.exec(reference.sourcePath.replace(/\\/g, '/'));
      if (!reference.required && layout && layout[1].toLowerCase() !== verified.layout) throw new Error('候选缩略图与原固定包布局版本不同。');
    }
    const extension = path.extname(candidate.file).toLowerCase();
    const supportingFiles = stat.isFile && extension === '.gltf' ? await this.verifyGltf(candidate.file, stat.size) : [];
    if (stat.isFile && extension === '.glb') {
      let checked = this.models.get(stat.real);
      if (!checked) { checked = validateGlbModelFile(candidate.file).then(ok => { if (!ok) throw new Error('候选 GLB 模型文件结构无效。'); }); this.models.set(stat.real, checked); }
      await checked;
    }
    if (stat.isFile && reference.owner.kind === 'skybox' && reference.required) await this.verifySkyboxHeader(candidate.file, extension);
    if (stat.isFile && reference.owner.kind === 'environment' && reference.required && extension === '.glb'
      && typeof reference.owner.value.fileSizeBytes === 'number' && reference.owner.value.fileSizeBytes > 0
      && reference.owner.value.fileSizeBytes !== stat.size) throw new Error('候选环境模型文件大小与原场景版本不一致。');
    if (stat.isFile && reference.owner.kind === 'skybox' && reference.owner.revision && SHA256.test(reference.owner.revision) && reference.required) {
      if (await this.hash(stat.real) !== reference.owner.revision.toLowerCase()) throw new Error('候选天空盒内容与场景记录的 SHA-256 版本不一致。');
    }
    cancel(this.options.signal);
    return { file: candidate.file, isFile: stat.isFile, supportingFiles, sourceKey: pinned?.[1] ?? candidate.sourceKey };
  }

  private verifyPinnedPackage(packageRoot: string, expectedRevision: string, boundary: string): Promise<{ layout: string; files: string[] }> {
    const key = `${identityKey(packageRoot)}\0${expectedRevision}`;
    let result = this.versions.get(key);
    if (!result) {
      result = (async () => {
        await this.requireFile(boundary, packageRoot, true);
        const entries = await fs.readdir(packageRoot, { withFileTypes: true });
        if (entries.length > MAX_PACKAGE_FILES) throw new Error('模型版本包文件数量超出限制。');
        if (entries.some(entry => entry.isSymbolicLink())) throw new Error('模型版本包不能包含符号链接。');
        const scan = await scanModelPackage(packageRoot), asset = scan.asset;
        if (!asset?.metadataPath) throw new Error('模型版本包缺少可验证的主模型或元数据。');
        for (const file of [asset.path, asset.metadataPath, ...(asset.scriptPaths ?? []), ...(asset.thumbnailPath ? [asset.thumbnailPath] : [])]) await this.requireFile(packageRoot, file, false);
        const revision = await createDataPlatformModelRuntimeRevision({ modelPath: asset.path, metadataPath: asset.metadataPath,
          scriptPaths: asset.scriptPaths ?? [], thumbnailPath: asset.thumbnailPath });
        if (revision.runtimeRevision !== expectedRevision.toLowerCase()) throw new Error('候选模型包内容与场景固定版本不一致。');
        // 新版固定包的布局指纹包含缩略图，避免只校验主模型就接受已被改写的资源。
        const layout = createHash('sha256').update(JSON.stringify({ mainFile: path.basename(asset.path),
          thumbnailPath: asset.thumbnailPath ? path.relative(packageRoot, asset.thumbnailPath).replace(/\\/g, '/') : null,
          thumbnailRevision: revision.thumbnailRevision })).digest('hex').slice(0, 12);
        cancel(this.options.signal);
        return { layout, files: [asset.path, asset.metadataPath, ...(asset.scriptPaths ?? [])] };
      })(); this.versions.set(key, result);
    }
    return result;
  }

  private async verifySkyboxHeader(file: string, extension: string): Promise<void> {
    if (extension !== '.exr' && extension !== '.hdr') return;
    const handle = await fs.open(file, 'r');
    try {
      const header = Buffer.alloc(16); const { bytesRead } = await handle.read(header, 0, header.length, 0);
      if (extension === '.exr' && (bytesRead < 8 || header.readUInt32LE(0) !== 0x01312f76)) throw new Error('候选 EXR 天空盒文件格式无效。');
      if (extension === '.hdr' && !/^#\?(?:RADIANCE|RGBE)/.test(header.toString('ascii'))) throw new Error('候选 HDR 天空盒文件格式无效。');
    } finally { await handle.close(); }
  }

  private verifyGltf(file: string, size: number): Promise<string[]> {
    let result = this.gltfFiles.get(file);
    if (!result) {
      result = (async () => {
        if (size > 64 * 1024 * 1024) throw new Error('glTF JSON 超过 64 MiB 限制。');
        const document = object(JSON.parse(await fs.readFile(file, { encoding: 'utf8', signal: this.options.signal })));
        if (!document || object(document.asset)?.version !== '2.0') throw new Error('候选 glTF 文件格式无效。');
        const root = path.dirname(file), dependencies = new Set<string>();
        for (const key of ['buffers', 'images']) for (const entry of Array.isArray(document[key]) ? document[key] : []) {
          const uri = object(entry)?.uri;
          if (typeof uri !== 'string' || /^data:/i.test(uri)) continue;
          let decoded: string; try { decoded = decodeURIComponent(uri); } catch { throw new Error(`glTF 依赖 URI 不安全：${uri}`); }
          if (!decoded || /[\\\x00-\x1f?#]/.test(decoded) || /^(?:[a-z][a-z\d+.-]*:|\/)/i.test(decoded)
            || decoded.split('/').some(part => part === '..')) throw new Error(`glTF 依赖 URI 不安全：${uri}`);
          const dependency = path.resolve(root, decoded);
          try { await this.requireFile(root, dependency, false); }
          catch (error) { throw new Error(`glTF 依赖文件不可用（${uri}）：${message(error)}`); }
          dependencies.add(dependency);
        }
        return [...dependencies];
      })(); this.gltfFiles.set(file, result);
    }
    return result;
  }

  private hash(file: string): Promise<string> {
    let result = this.hashes.get(file);
    if (!result) {
      result = (async () => {
        const hash = createHash('sha256');
        for await (const chunk of createReadStream(file, { signal: this.options.signal })) { cancel(this.options.signal); hash.update(chunk); }
        return hash.digest('hex');
      })(); this.hashes.set(file, result);
    }
    return result;
  }
}
function isMissing(error: unknown): boolean { return error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR'); }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
