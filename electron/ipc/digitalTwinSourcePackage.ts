import { ZipArchive } from 'archiver';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { SyncedImageAssetEntry } from '../types.js';
import { readUtf8File } from '../shared/strictUtf8.js';
import type { DeploymentCopyFile } from './deploymentExportFileSystem.js';
import type {
  DeploymentSkyboxCacheDependencies,
  DeploymentSkyboxCacheContext,
  DeploymentSkyboxValidationCache,
  ResolvedDeploymentSkyboxReference,
} from './deploymentSkyboxCache.js';
import type { SourceEnvironmentPackageIntegrity } from './digitalTwinSourceEnvironmentRelink.js';
import type { SourceResourcePlan, SourceResourceFile } from './digitalTwinSourceResourcePlan.js';

const require = createRequire(import.meta.url);
const runtimeExtension = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
type DeploymentExportFileSystemModule = typeof import('./deploymentExportFileSystem.js');
type DeploymentSkyboxCacheModule = typeof import('./deploymentSkyboxCache.js');
type DigitalTwinSourceEnvironmentRelinkModule = typeof import('./digitalTwinSourceEnvironmentRelink.js');
type SceneShadowBakeContractModule = typeof import('../shared/sceneShadowBakeContract.js');
const { captureSceneShadowBakeRelocation, getSceneShadowBakeSignatureContract } = require(`../shared/sceneShadowBakeContract${runtimeExtension}`) as SceneShadowBakeContractModule;
const { stripCadReferencesFromSceneFile } = require(`./sceneCadReferenceSanitizer${runtimeExtension}`) as typeof import('./sceneCadReferenceSanitizer.js');
const { createSourceResourcePlan } = require(`./digitalTwinSourceResourcePlan${runtimeExtension}`) as typeof import('./digitalTwinSourceResourcePlan.js');
const { copyDeploymentFiles } = require(`./deploymentExportFileSystem${runtimeExtension}`) as DeploymentExportFileSystemModule;
const {
  assertTrustedPathWithinRoot,
  prepareSourceSceneEnvironments,
} = require(`./digitalTwinSourceEnvironmentRelink${runtimeExtension}`) as DigitalTwinSourceEnvironmentRelinkModule;
const {
  createDataPlatformSkyboxIntegrityLabel,
  createDataPlatformSkyboxOrphanedWarning,
  createDeploymentSkyboxValidationCache,
  loadDeploymentSkyboxCacheContext,
  resolveDeploymentSkyboxReference,
} = require(`./deploymentSkyboxCache${runtimeExtension}`) as DeploymentSkyboxCacheModule;

const MAX_SCENE_FILES = 1_000;
const MAX_SCENE_BYTES = 64 * 1024 * 1024;
const MAX_SOURCE_FILES = 200_000;
const MAX_SOURCE_BYTES = 8 * 1024 * 1024 * 1024;
const PATH_KEYS = new Set(['sourcePath', 'packagePath', 'metadataPath', 'thumbnailPath', 'path']);
const URL_KEYS = new Set(['sourceUrl', 'thumbnailUrl', 'activeVariantUrl']);
const PATH_ARRAY_KEYS = new Set(['scriptPaths']);
const LOCAL_ASSET_URL_PREFIX = 'editor-asset://local/';
const STABLE_SKYBOX_PATH_FIELDS = new Set(['packagePath', 'sourcePath', 'sourceUrl']);

type PlainObject = Record<string, unknown>;

export type DigitalTwinSourceManifestInput = {
  projectId: string;
  projectName: string;
  editorProjectId: string | null;
  baseVersionId: string | null;
  resourceRevision: string;
};

export type BuildDigitalTwinSourcePackageOptions = {
  projectRoot: string;
  sharedResourcesRoot: string;
  /** 仅由主进程传入已配置工作区，兼容早期直接存于工作区 Assets 的同步资源。 */
  legacyWorkspaceRoot?: string;
  /** 仅对场景明确引用的外部 CAD 单文件授权，不扩展目录权限。 */
  isAuthorizedCadFile?: (filePath: string) => boolean;
  entrySceneFilePath: string;
  outputRoot: string;
  manifest: DigitalTwinSourceManifestInput;
  signal: AbortSignal;
  skipCadReferences?: boolean;
  /** 主进程校验过的运行时准备结果，只写入发布暂存包，不覆盖其它原场景。 */
  preparedSceneContents?: ReadonlyMap<string, string>;
  /** 数据中台图片引用判定与本地解析注入，避免打包模块直接依赖同步模块。 */
  isPlatformImageReference: (value: string) => boolean;
  findSyncedImageForReference: (editorRoots: readonly string[], reference: string) => Promise<SyncedImageAssetEntry | null>;
  /** 同一次发布在 SOURCE/DIST 间复用的严格索引上下文与完整校验 Promise。 */
  skyboxCacheContext?: DeploymentSkyboxCacheContext;
  skyboxValidationCache?: DeploymentSkyboxValidationCache;
  /** 仅供测试注入共享缓存边界与完整校验依赖。 */
  skyboxCacheDependencies?: Partial<DeploymentSkyboxCacheDependencies>;
  onProgress?: (detail: string, completedFiles: number, totalFiles: number) => void;
};

export type DigitalTwinSourcePackageResult = {
  filePath: string;
  fileName: string;
  fileSize: number;
  sha256: string;
  entryScenePath: string;
  entrySceneName: string;
  sceneCount: number;
  resourceFileCount: number;
  manifestJson: string;
  sceneContents: string[];
  warnings: string[];
  omittedResources: string[];
  /** SOURCE 已锁定的文件版本，DIST 必须按此校验复制结果。仅主进程内传递。 */
  resourceFiles: SourceResourceFile[];
  /** 完成受管资源定位后的入口快照；DIST 必须使用同一版本，而不是重新使用请求中的旧缓存路径。 */
  entrySceneContent: string;
};

type SceneSnapshot = {
  sourcePath: string;
  relativePath: string;
  content: string;
  portableContent: string;
  name: string;
  size: number;
  sha256: string;
  parsed: PlainObject;
};

type ResourceBundle = {
  sourcePath: string;
  destinationRelativePath: string;
  copyFile?: DeploymentCopyFile;
  integrityFiles?: readonly ResourceFileIntegrity[];
};

type ResourceFileIntegrity = {
  relativePath: string;
  expectedSize: number;
  expectedSha256: string;
  label: string;
};

/** 数据中台同步图片在源工程中的便携资源映射，reference 为场景内稳定引用。 */
type PlatformImageBundle = ResourceBundle & {
  reference: string;
};

type DataPlatformEnvironmentCachePath = {
  resourceId: string;
  revisionEndIndex: number;
};

/** 构建可重新编辑的多场景源工程 ZIP，仅包含场景实际引用的资源包。 */
export async function buildDigitalTwinSourcePackage(
  options: BuildDigitalTwinSourcePackageOptions,
): Promise<DigitalTwinSourcePackageResult> {
  throwIfAborted(options.signal);
  const projectRoot = path.resolve(options.projectRoot);
  const sharedResourcesRoot = path.resolve(options.sharedResourcesRoot);
  const outputRoot = path.resolve(options.outputRoot);
  const legacyWorkspaceRoot = options.legacyWorkspaceRoot ? path.resolve(options.legacyWorkspaceRoot) : null;
  const entrySceneFilePath = path.resolve(options.entrySceneFilePath);
  assertPathInsideOrEqual(projectRoot, entrySceneFilePath, '入口场景');
  assertNoPathOverlap(outputRoot, projectRoot, '源工程输出目录与项目目录不能重叠。');
  assertNoPathOverlap(outputRoot, sharedResourcesRoot, '源工程输出目录与共享资源目录不能重叠。');
  if (legacyWorkspaceRoot) assertNoPathOverlap(outputRoot, path.join(legacyWorkspaceRoot, 'Assets'), '源工程输出目录与旧工作区资源目录不能重叠。');

  await fs.mkdir(outputRoot, { recursive: true });
  const token = randomUUID();
  const stagingRoot = path.join(outputRoot, `.digital-twin-source-staging-${token}`);
  const fileName = `digital-twin-source-${options.manifest.projectId}.zip`;
  const archivePath = path.join(outputRoot, fileName);
  await fs.mkdir(stagingRoot, { recursive: false });

  try {
    const skyboxCacheContext = options.skyboxCacheContext ?? await loadDeploymentSkyboxCacheContext(
      options.signal,
      options.skyboxCacheDependencies,
    );
    const scenesResult = await readSceneSnapshots(
      projectRoot,
      sharedResourcesRoot,
      entrySceneFilePath,
      options.signal,
      options.skipCadReferences === true,
      options.isPlatformImageReference,
      options.findSyncedImageForReference,
      options.preparedSceneContents,
    );
    const scenes = scenesResult.snapshots;
    const cadBundleMap = await prepareSourceSceneCadFiles(scenes.map(scene => scene.parsed),
      projectRoot, sharedResourcesRoot, legacyWorkspaceRoot, options.signal, options.isAuthorizedCadFile);
    const restoreRelocatedBakes = new Map(scenes.map(scene => [scene, captureSceneShadowBakeRelocation(scene.parsed.scene)]));
    const platformImageBundleMap = scenesResult.platformImageBundleMap;
    const entryScene = scenes.find((scene) => path.resolve(scene.sourcePath) === entrySceneFilePath);
    if (!entryScene) throw new Error('入口场景不在当前项目 Scenes 目录中。');
    const sourceEnvironmentPackages = await prepareSourceSceneEnvironments(
      scenes.map((scene) => scene.parsed),
      sharedResourcesRoot,
      options.signal,
    );

    const warnings: string[] = [];
    const omittedResources: string[] = [];
    const warnedOrphanedSkyboxIds = new Set<string>();
    const validationCache = options.skyboxValidationCache ?? createDeploymentSkyboxValidationCache();
    const stableSkyboxObjects = new WeakSet<object>();
    const stableSkyboxBundles = new Map<string, ResourceBundle>();
    for (const scene of scenes) {
      await prepareSourceSceneSkyboxes(
        scene.parsed,
        skyboxCacheContext,
        validationCache,
        stableSkyboxObjects,
        stableSkyboxBundles,
        warnings,
        warnedOrphanedSkyboxIds,
        options.signal,
        options.skyboxCacheDependencies,
      );
    }

    const candidates = collectResourceBundles(
      scenes.map((scene) => scene.parsed),
      projectRoot,
      sharedResourcesRoot,
      platformImageBundleMap,
      stableSkyboxObjects,
      stableSkyboxBundles,
      sourceEnvironmentPackages,
      warnings,
      omittedResources,
      legacyWorkspaceRoot,
      cadBundleMap,
    );
    await validateResourceBundleSourcePaths(candidates, projectRoot, sharedResourcesRoot, options.signal, legacyWorkspaceRoot);
    const resourcePlan = await createSourceResourcePlan(candidates, projectRoot, options.signal);
    const bundles = resourcePlan.bundles;
    for (const scene of scenes) {
      resourcePlan.validateModelReferences(scene.parsed, scene.relativePath);
      const portableScene = rewriteSceneToPortableAssets(scene.parsed, null, platformImageBundleMap, resourcePlan);
      const restoreBake = restoreRelocatedBakes.get(scene);
      if (isPlainObject(portableScene) && restoreBake) {
        // 内容指纹已确认版本；先逆向验证本次目标分配，再更新纯位置变化后的签名。
        const originalTargets = mapSceneReferenceStrings(portableScene, resourcePlan.originalReference) as PlainObject;
        restoreSnapshotAnnotations(scene.parsed, originalTargets);
        if (!restoreBake(originalTargets.scene)) throw new Error(`场景「${scene.name}」的资源版本在源工程准备过程中发生变化，无法保留有效烘焙；请更新资源并重新烘焙后发布。`);
        const settings = (portableScene.scene as PlainObject).sceneSettings as PlainObject;
        const shadows = settings.shadows as PlainObject;
        shadows.bake = { ...(shadows.bake as PlainObject), signature: getSceneShadowBakeSignatureContract(portableScene.scene) };
        const runtimeSettings = (scene.parsed.scene as PlainObject).sceneSettings as PlainObject;
        const runtimeShadows = runtimeSettings.shadows as PlainObject;
        runtimeShadows.bake = { ...(runtimeShadows.bake as PlainObject), signature: getSceneShadowBakeSignatureContract(scene.parsed.scene) };
      }
      scene.portableContent = `${JSON.stringify(portableScene, null, 2)}\n`;
    }
    const estimatedFiles = scenes.length + bundles.length + 1;
    options.onProgress?.('正在复制源工程场景…', 0, estimatedFiles);

    let completed = 0;
    let resourceFileCount = 0;
    let copiedBytes = 0;
    for (const scene of scenes) {
      throwIfAborted(options.signal);
      const destination = resolveInside(stagingRoot, scene.relativePath, '源工程场景目标');
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, scene.portableContent, { encoding: 'utf8', flag: 'wx' });
      completed += 1;
      options.onProgress?.(`已写入场景：${scene.relativePath}`, completed, estimatedFiles);
    }

    await Promise.all([
      fs.mkdir(path.join(stagingRoot, 'Assets', 'Models'), { recursive: true }),
      fs.mkdir(path.join(stagingRoot, 'Assets', 'Environments'), { recursive: true }),
      fs.mkdir(path.join(stagingRoot, 'Assets', 'Skyboxes'), { recursive: true }),
      fs.mkdir(path.join(stagingRoot, 'Assets', 'Images'), { recursive: true }),
      fs.mkdir(path.join(stagingRoot, '.babylon-editor'), { recursive: true }),
    ]);

    for (const bundle of bundles) {
      throwIfAborted(options.signal);
      if (bundle.copyFile) {
        if (resourceFileCount + 1 > MAX_SOURCE_FILES) {
          throw new Error(`源工程资源文件数量超过 ${MAX_SOURCE_FILES} 项限制。`);
        }
        if (copiedBytes + bundle.copyFile.size > MAX_SOURCE_BYTES) throw new Error('源工程资源总量超过 8 GB 安全上限。');
        await copyDeploymentFiles([bundle.copyFile], stagingRoot, 1, options.signal, () => undefined);
        resourceFileCount += 1;
        copiedBytes += bundle.copyFile.size;
      } else {
        const destination = resolveInside(stagingRoot, bundle.destinationRelativePath, '源工程资源目标');
        await copySafeResource(bundle.sourcePath, destination, options.signal, (bytes) => {
          if (resourceFileCount + 1 > MAX_SOURCE_FILES) {
            throw new Error(`源工程资源文件数量超过 ${MAX_SOURCE_FILES} 项限制。`);
          }
          if (copiedBytes + bytes > MAX_SOURCE_BYTES) throw new Error('源工程资源总量超过 8 GB 安全上限。');
          resourceFileCount += 1;
          copiedBytes += bytes;
        }, bundle.integrityFiles);
      }
      completed += 1;
      options.onProgress?.(`已复制资源：${bundle.destinationRelativePath}`, completed, estimatedFiles);
    }

    const manifestObject = {
      schema: 'zending.digital-twin-source',
      version: 1,
      ...options.manifest,
      entryScenePath: entryScene.relativePath,
      entrySceneName: entryScene.name,
      scenes: scenes.map((scene) => ({
        path: scene.relativePath,
        name: scene.name,
        size: Buffer.byteLength(scene.portableContent, 'utf8'),
        sha256: sha256Text(scene.portableContent),
      })),
      createdAt: new Date().toISOString(),
    };
    const manifestJson = JSON.stringify(manifestObject);
    await fs.writeFile(
      path.join(stagingRoot, '.babylon-editor', 'digital-twin-source-manifest.json'),
      `${JSON.stringify(manifestObject, null, 2)}\n`,
      { encoding: 'utf8', flag: 'wx' },
    );
    options.onProgress?.('正在压缩源工程 ZIP…', estimatedFiles, estimatedFiles);
    await archiveDirectoryContents(stagingRoot, archivePath, options.signal);
    const stat = await fs.stat(archivePath);
    if (!stat.isFile() || stat.size <= 0) {
      throw new Error('源工程 ZIP 大小无效。');
    }

    return {
      filePath: archivePath,
      fileName,
      fileSize: stat.size,
      sha256: await sha256File(archivePath, options.signal),
      entryScenePath: entryScene.relativePath,
      entrySceneName: entryScene.name,
      sceneCount: scenes.length,
      resourceFileCount,
      manifestJson,
      sceneContents: scenes.map((scene) => scene.portableContent),
      warnings,
      omittedResources,
      resourceFiles: resourcePlan.files,
      entrySceneContent: JSON.stringify(entryScene.parsed),
    };
  } catch (error) {
    await fs.rm(archivePath, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    await fs.rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function readSceneSnapshots(
  projectRoot: string,
  sharedResourcesRoot: string,
  entrySceneFilePath: string,
  signal: AbortSignal,
  skipCadReferences: boolean,
  isPlatformImageReference: (value: string) => boolean,
  findSyncedImageForReference: (editorRoots: readonly string[], reference: string) => Promise<SyncedImageAssetEntry | null>,
  preparedSceneContents?: ReadonlyMap<string, string>,
): Promise<{ snapshots: SceneSnapshot[]; platformImageBundleMap: ReadonlyMap<string, PlatformImageBundle> }> {
  const scenesRoot = path.join(projectRoot, 'Scenes');
  const scenePaths = await findSceneFiles(scenesRoot, signal);
  if (scenePaths.length === 0 || scenePaths.length > MAX_SCENE_FILES) {
    throw new Error(`源工程场景数量必须为 1 到 ${MAX_SCENE_FILES} 个。`);
  }
  if (!scenePaths.some((scenePath) => path.resolve(scenePath) === entrySceneFilePath)) {
    throw new Error('入口场景不在当前项目 Scenes 目录中。');
  }
  if (preparedSceneContents && (preparedSceneContents.size !== scenePaths.length
    || scenePaths.some(file => !preparedSceneContents.has(path.resolve(file))))) {
    throw new Error('SOURCE 场景集合在准备后发生变化，请重新准备发布。');
  }

  const snapshots: SceneSnapshot[] = [];
  for (const sourcePath of scenePaths) {
    throwIfAborted(signal);
    const stat = await fs.lstat(sourcePath);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`场景文件不是安全普通文件：${sourcePath}`);
    if (stat.size <= 0 || stat.size > MAX_SCENE_BYTES) throw new Error(`场景文件大小无效：${sourcePath}`);
    const content = preparedSceneContents?.get(path.resolve(sourcePath)) ?? await readUtf8File(sourcePath, '数字孪生 SOURCE 场景文件');
    if (Buffer.byteLength(content) > MAX_SCENE_BYTES) throw new Error(`准备后的场景文件大小无效：${sourcePath}`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(content) as unknown;
    } catch {
      throw new Error(`场景文件不是有效 JSON：${sourcePath}`);
    }
    if (!isPlainObject(parsed) || (parsed.version !== 1 && parsed.version !== 2 && parsed.version !== 3 && parsed.version !== 4 && parsed.version !== 5) || !isPlainObject(parsed.scene)) {
      throw new Error(`场景文件格式不受支持：${sourcePath}`);
    }
    const skippedCadCount = skipCadReferences ? stripCadReferencesFromSceneFile(parsed) : 0;
    const snapshotContent = skippedCadCount > 0 ? `${JSON.stringify(parsed, null, 2)}\n` : content;
    const relativeFromScenes = path.relative(scenesRoot, sourcePath);
    if (!relativeFromScenes || relativeFromScenes.startsWith('..') || path.isAbsolute(relativeFromScenes)) {
      throw new Error('场景文件路径逃逸 Scenes 目录。');
    }
    const relativePath = `Scenes/${toPortablePath(relativeFromScenes)}`;
    const sceneName = typeof parsed.scene.name === 'string' && parsed.scene.name.trim()
      ? parsed.scene.name.trim().slice(0, 128)
      : path.basename(sourcePath).replace(/\.scene\.json$/i, '');
    snapshots.push({
      sourcePath,
      relativePath,
      content: snapshotContent,
      portableContent: snapshotContent,
      name: sceneName,
      size: Buffer.byteLength(snapshotContent, 'utf8'),
      sha256: sha256Text(snapshotContent),
      parsed,
    });
  }
  snapshots.sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'en'));

  const platformImageBundleMap = await collectPlatformImageBundleMap(
    snapshots.map((snapshot) => snapshot.content),
    [projectRoot, sharedResourcesRoot],
    isPlatformImageReference,
    findSyncedImageForReference,
  );
  return { snapshots, platformImageBundleMap };
}

async function findSceneFiles(root: string, signal: AbortSignal): Promise<string[]> {
  const rootStat = await fs.lstat(root).catch((error: unknown) => {
    if (isNodeError(error) && error.code === 'ENOENT') return null;
    throw error;
  });
  if (!rootStat) return [];
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error('项目 Scenes 路径不是安全目录。');
  const result: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    throwIfAborted(signal);
    const current = pending.pop()!;
    const entries = await fs.readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const entry of entries) {
      const candidate = path.join(current, entry.name);
      const stat = await fs.lstat(candidate);
      if (stat.isSymbolicLink()) throw new Error(`Scenes 目录包含符号链接或 Junction：${candidate}`);
      if (stat.isDirectory()) pending.push(candidate);
      else if (stat.isFile() && entry.name.toLowerCase().endsWith('.scene.json')) result.push(candidate);
      if (result.length > MAX_SCENE_FILES) throw new Error(`源工程场景数量超过 ${MAX_SCENE_FILES} 个。`);
    }
  }
  return result;
}

/** 收集场景内全部数据中台图片稳定引用，并解析为本地 Assets/Images 文件；缺失时阻止打包以保持包完整。 */
async function collectPlatformImageBundleMap(
  sceneContents: readonly string[],
  editorRoots: readonly string[],
  isPlatformImageReference: (value: string) => boolean,
  findSyncedImageForReference: (editorRoots: readonly string[], reference: string) => Promise<SyncedImageAssetEntry | null>,
): Promise<ReadonlyMap<string, PlatformImageBundle>> {
  const references = new Set<string>();
  const visit = (value: unknown): void => {
    if (typeof value === 'string') {
      if (isPlatformImageReference(value)) references.add(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (isPlainObject(value)) {
      for (const child of Object.values(value)) visit(child);
    }
  };
  for (const content of sceneContents) visit(JSON.parse(content) as unknown);

  const bundles = new Map<string, PlatformImageBundle>();
  for (const reference of [...references].sort()) {
    const entry = await findSyncedImageForReference(editorRoots, reference);
    if (!entry) {
      throw new Error(`场景引用的数据中台图片未同步到当前项目：${reference}`);
    }
    bundles.set(reference, {
      reference,
      sourcePath: entry.filePath,
      destinationRelativePath: `Assets/Images/${toPortablePath(entry.fileName)}`,
    });
  }
  return bundles;
}

/** 判断字符串是否为便携数据中台图片引用（editor-asset URL 或 Assets/Images 相对路径）。 */
function isPortableImageAssetReference(value: string): boolean {
  const normalized = value.trim().replace(/\\/g, '/');
  if (normalized.toLowerCase().startsWith('assets/images/')) return true;
  if (!normalized.startsWith(LOCAL_ASSET_URL_PREFIX)) return false;
  try {
    const decoded = decodeURIComponent(new URL(normalized).pathname.slice(1)).replace(/\\/g, '/');
    return decoded.toLowerCase().startsWith('assets/images/');
  } catch {
    return false;
  }
}

/** 按稳定 ID 解析 SOURCE 场景中的天空盒，并改写为源工程包内便携引用。 */
async function prepareSourceSceneSkyboxes(
  sceneFile: PlainObject,
  cacheContext: DeploymentSkyboxCacheContext,
  validationCache: DeploymentSkyboxValidationCache,
  stableSkyboxObjects: WeakSet<object>,
  stableSkyboxBundles: Map<string, ResourceBundle>,
  warnings: string[],
  warnedOrphanedSkyboxIds: Set<string>,
  signal: AbortSignal,
  dependencyOverrides: Partial<DeploymentSkyboxCacheDependencies> | undefined,
): Promise<void> {
  const scene = isPlainObject(sceneFile.scene) ? sceneFile.scene : null;
  if (!scene) return;
  const skyboxes: PlainObject[] = [];
  if (isPlainObject(scene.entities)) {
    for (const entity of Object.values(scene.entities)) {
      if (!isPlainObject(entity) || !isPlainObject(entity.components)) continue;
      if (isPlainObject(entity.components.skybox)) skyboxes.push(entity.components.skybox);
    }
  }
  if (isPlainObject(scene.sceneSettings) && isPlainObject(scene.sceneSettings.skybox)) {
    skyboxes.push(scene.sceneSettings.skybox);
  }

  for (const skybox of skyboxes) {
    const resolved = await resolveDeploymentSkyboxReference(
      skybox,
      cacheContext,
      validationCache,
      signal,
      dependencyOverrides,
    );
    if (!resolved) continue;
    rewriteSourceSkyboxReference(skybox, resolved);
    stableSkyboxObjects.add(skybox);
    registerStableSourceSkyboxBundle(stableSkyboxBundles, resolved);
    if (resolved.entry.status === 'orphaned' && !warnedOrphanedSkyboxIds.has(resolved.entry.resourceId)) {
      warnedOrphanedSkyboxIds.add(resolved.entry.resourceId);
      warnings.push(createDataPlatformSkyboxOrphanedWarning(resolved.entry));
    }
  }
}

function rewriteSourceSkyboxReference(
  skybox: PlainObject,
  resolved: ResolvedDeploymentSkyboxReference,
): void {
  const sourcePath = resolved.entry.relativePath;
  skybox.packagePath = path.posix.dirname(sourcePath);
  skybox.sourcePath = sourcePath;
  skybox.sourceUrl = `${LOCAL_ASSET_URL_PREFIX}${encodeURIComponent(sourcePath)}`;
}

function registerStableSourceSkyboxBundle(
  bundles: Map<string, ResourceBundle>,
  resolved: ResolvedDeploymentSkyboxReference,
): void {
  const destinationRelativePath = resolved.entry.relativePath;
  const key = destinationRelativePath.toLowerCase();
  const bundle: ResourceBundle = {
    sourcePath: resolved.sourcePath,
    destinationRelativePath,
    copyFile: {
      ...resolved.sourceFile,
      destinationRelativePath,
      kind: 'texture',
      expectedSize: resolved.entry.fileSizeBytes,
      expectedSha256: resolved.entry.sha256,
      integrityLabel: createDataPlatformSkyboxIntegrityLabel(resolved.entry),
    },
  };
  const existing = bundles.get(key);
  if (existing && path.resolve(existing.sourcePath) !== path.resolve(bundle.sourcePath)) {
    throw new Error(`源工程天空盒目标冲突：${destinationRelativePath}`);
  }
  bundles.set(key, bundle);
}

/** 历史 CAD 可以位于项目外；只接受明确授权的单个原图，不扫描它的父目录。 */
async function prepareSourceSceneCadFiles(
  sceneFiles: readonly PlainObject[],
  projectRoot: string,
  sharedResourcesRoot: string,
  legacyWorkspaceRoot: string | null,
  signal: AbortSignal,
  isAuthorizedCadFile?: (filePath: string) => boolean,
): Promise<ReadonlyMap<string, ResourceBundle>> {
  const references: PlainObject[] = [];
  let visited = 0;
  const visit = (value: unknown): void => {
    if (++visited > 1_000_000) throw new Error('场景结构过大，无法完成 CAD 资源扫描。');
    if (Array.isArray(value)) { for (const child of value) visit(child); return; }
    if (!isPlainObject(value)) return;
    for (const [key, child] of Object.entries(value)) {
      if (key === 'cadReference' && isPlainObject(child)) references.push(child);
      else visit(child);
    }
  };
  for (const scene of sceneFiles) visit(scene);
  const bundles = new Map<string, ResourceBundle>();
  for (const cad of references) {
    throwIfAborted(signal);
    const rawPath = typeof cad.sourcePath === 'string' ? cad.sourcePath.trim() : '';
    const rawUrl = typeof cad.sourceUrl === 'string' ? cad.sourceUrl.trim() : '';
    let urlPath = '';
    if (rawUrl.startsWith(LOCAL_ASSET_URL_PREFIX)) {
      try { urlPath = decodeURIComponent(new URL(rawUrl).pathname.slice(1)); }
      catch { throw new Error('CAD 原图的本地资源 URL 无效。'); }
    }
    const resolvePath = (value: string) => path.isAbsolute(value) ? path.resolve(value) : path.resolve(projectRoot, value);
    if (rawPath && urlPath && createPathKey(resolvePath(rawPath)) !== createPathKey(resolvePath(urlPath))) {
      throw new Error('CAD 原图路径与资源 URL 不一致，请重新导入原图后发布。');
    }
    if (!rawPath && !urlPath) throw new Error('CAD 原图缺少本地文件引用，请重新导入原图后发布。');
    const sourcePath = resolvePath(rawPath || urlPath);
    if (path.extname(sourcePath).toLowerCase() !== '.dxf') throw new Error('CAD 原图必须是 DXF 文件。');
    const stat = await fs.lstat(sourcePath).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`CAD 原图文件不存在：${sourcePath}。该文件不能通过数据中台模型同步恢复，请重新导入原图后发布。`);
      }
      throw error;
    });
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`CAD 原图不是安全普通文件：${sourcePath}`);
    const insideKnownRoot = isPathInsideOrEqual(projectRoot, sourcePath) || isPathInsideOrEqual(sharedResourcesRoot, sourcePath)
      || Boolean(legacyWorkspaceRoot && isPathInsideOrEqual(path.join(legacyWorkspaceRoot, 'Assets'), sourcePath));
    const insidePortableAssets = [projectRoot, sharedResourcesRoot, legacyWorkspaceRoot].some(root =>
      root !== null && isPathInsideOrEqual(path.join(root, 'Assets'), sourcePath));
    if (insidePortableAssets) continue;
    if (!insideKnownRoot && !isAuthorizedCadFile?.(sourcePath)) throw new Error(`CAD 原图未获得文件授权，请重新导入后发布：${sourcePath}`);
    await assertTrustedPathWithinRoot(path.parse(sourcePath).root, sourcePath, 'CAD 原图');
    const destinationRelativePath = `Assets/Cad/${path.basename(sourcePath)}`;
    const bundle: ResourceBundle = { sourcePath, destinationRelativePath, copyFile: {
      sourcePath, destinationRelativePath, relativePath: path.basename(sourcePath), size: stat.size, mtimeMs: stat.mtimeMs, kind: 'cad',
    } };
    if (rawPath) bundles.set(rawPath, bundle);
    if (rawUrl) bundles.set(rawUrl, bundle);
  }
  return bundles;
}

function collectResourceBundles(
  sceneValues: readonly unknown[],
  projectRoot: string,
  sharedResourcesRoot: string,
  platformImageBundleMap: ReadonlyMap<string, PlatformImageBundle>,
  stableSkyboxObjects: WeakSet<object>,
  stableSkyboxBundles: ReadonlyMap<string, ResourceBundle>,
  sourceEnvironmentPackages: readonly SourceEnvironmentPackageIntegrity[],
  warnings: string[],
  omittedResources: string[],
  legacyWorkspaceRoot: string | null,
  cadBundleMap: ReadonlyMap<string, ResourceBundle>,
): ResourceBundle[] {
  const bundles = new Map<string, ResourceBundle>();
  const skippedRoots = new Set<string>();
  const warnSkippedResource = (sourceRoot: string): void => {
    const key = createPathKey(sourceRoot);
    if (skippedRoots.has(key)) return;
    skippedRoots.add(key);
    omittedResources.push(sourceRoot);
    warnings.push(`场景引用的资源不在当前项目或共享资源缓存内：${sourceRoot}；源工程包已跳过该资源，继续发布。重新打开源工程时可能需要重新导入该资源。`);
  };
  const sourceEnvironmentPackagesByPath = new Map(
    sourceEnvironmentPackages.map((item) => [createPathKey(item.sourcePath), item]),
  );
  const registerBundle = (bundle: ResourceBundle): void => {
    // 来源身份保留到内容校验完成，目标同名不意味着资源版本冲突。
    const key = `${createPathKey(bundle.sourcePath)}\n${normalizeResourceDestinationKey(bundle.destinationRelativePath)}`;
    const existing = bundles.get(key);
    if (!existing || bundle.copyFile || !existing.copyFile) bundles.set(key, bundle);
  };

  for (const cadBundle of cadBundleMap.values()) registerBundle(cadBundle);
  for (const platformBundle of platformImageBundleMap.values()) registerBundle(platformBundle);
  for (const skyboxBundle of stableSkyboxBundles.values()) registerBundle(skyboxBundle);

  let visited = 0;
  const visit = (value: unknown, fieldName: string | null = null): void => {
    visited += 1;
    if (visited > 1_000_000) throw new Error('场景结构过大，无法完成源工程资源扫描。');
    if (typeof value === 'string') {
      const platformBundle = cadBundleMap.get(value) ?? platformImageBundleMap.get(value);
      if (platformBundle) {
        registerBundle(platformBundle);
        return;
      }
      const isResourceReference = Boolean(
        fieldName
        && (PATH_KEYS.has(fieldName) || URL_KEYS.has(fieldName) || PATH_ARRAY_KEYS.has(fieldName)),
      );
      const isImageAssetReference = isPortableImageAssetReference(value);
      if (!isResourceReference && !isImageAssetReference && !value.startsWith(LOCAL_ASSET_URL_PREFIX)) return;
      const bundle = resolveResourceBundle(
        value,
        projectRoot,
        sharedResourcesRoot,
        sourceEnvironmentPackagesByPath,
        warnSkippedResource,
        value.startsWith(LOCAL_ASSET_URL_PREFIX) || Boolean(fieldName && fieldName !== 'path'),
        legacyWorkspaceRoot,
      );
      if (!bundle) return;
      registerBundle(bundle);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, fieldName);
      return;
    }
    if (isPlainObject(value)) {
      const stableSkybox = stableSkyboxObjects.has(value);
      for (const [childKey, child] of Object.entries(value)) {
        if (stableSkybox && STABLE_SKYBOX_PATH_FIELDS.has(childKey)) continue;
        visit(child, childKey);
      }
    }
  };

  for (const sceneValue of sceneValues) visit(sceneValue, null);
  return [...bundles.values()].sort((left, right) => left.destinationRelativePath.localeCompare(right.destinationRelativePath, 'en'));
}

/** 复制前校验资源包从项目/共享根到源路径的完整 realpath 链，阻止祖先 Junction 逃逸。 */
async function validateResourceBundleSourcePaths(
  bundles: readonly ResourceBundle[],
  projectRoot: string,
  sharedResourcesRoot: string,
  signal: AbortSignal,
  legacyWorkspaceRoot: string | null,
): Promise<void> {
  for (const bundle of bundles) {
    throwIfAborted(signal);
    if (bundle.copyFile) continue;
    const allowedRoot = isPathInsideOrEqual(projectRoot, bundle.sourcePath)
      ? projectRoot
      : isPathInsideOrEqual(sharedResourcesRoot, bundle.sourcePath)
        ? sharedResourcesRoot
        : legacyWorkspaceRoot && isPathInsideOrEqual(path.join(legacyWorkspaceRoot, 'Assets'), bundle.sourcePath)
          ? legacyWorkspaceRoot : null;
    if (!allowedRoot) throw new Error(`源工程资源不在允许目录内：${bundle.destinationRelativePath}`);
    await assertTrustedPathWithinRoot(
      allowedRoot,
      bundle.sourcePath,
      `源工程资源 ${bundle.destinationRelativePath}`,
    );
  }
}

function resolveResourceBundle(
  rawValue: string,
  projectRoot: string,
  sharedResourcesRoot: string,
  sourceEnvironmentPackagesByPath: ReadonlyMap<string, SourceEnvironmentPackageIntegrity>,
  warnSkippedResource: (sourceRoot: string) => void,
  reportUnsupportedReference: boolean,
  legacyWorkspaceRoot: string | null,
): ResourceBundle | null {
  let candidate = rawValue.trim();
  if (!candidate) return null;
  if (candidate.startsWith(LOCAL_ASSET_URL_PREFIX)) {
    try {
      const url = new URL(candidate);
      candidate = decodeURIComponent(url.pathname.slice(1));
    } catch {
      throw new Error('场景中的本地资源 URL 格式无效。');
    }
  }
  parseDataPlatformEnvironmentCachePath(candidate.replace(/\\/g, '/').split('/').filter(Boolean));
  if (!path.isAbsolute(candidate)) {
    const portable = candidate.replace(/\\/g, '/');
    if (!portable.toLowerCase().startsWith('assets/')) {
      if (rawValue.startsWith(LOCAL_ASSET_URL_PREFIX)) warnSkippedResource(candidate);
      return null;
    }
    candidate = path.resolve(projectRoot, ...portable.split('/'));
  }
  const normalized = path.resolve(candidate);
  const nativeSegments = normalized.slice(path.parse(normalized).root.length).split(path.sep).filter(Boolean);
  const environmentCachePath = parseDataPlatformEnvironmentCachePath(nativeSegments);
  if (environmentCachePath) {
    const sourceRoot = path.resolve(
      path.parse(normalized).root,
      ...nativeSegments.slice(0, environmentCachePath.revisionEndIndex),
    );
    if (!isPathInsideOrEqual(projectRoot, sourceRoot) && !isPathInsideOrEqual(sharedResourcesRoot, sourceRoot)) {
      warnSkippedResource(sourceRoot);
      return null;
    }
    const integrity = sourceEnvironmentPackagesByPath.get(createPathKey(sourceRoot));
    if (!integrity) {
      throw new Error(`场景引用的数据中台环境未通过当前共享缓存 Sidecar 校验：${rawValue}`);
    }
    return {
      sourcePath: path.join(sourceRoot, integrity.modelRelativePath),
      destinationRelativePath: `${createPortableEnvironmentPackagePath(environmentCachePath.resourceId)}/${integrity.modelRelativePath}`,
      integrityFiles: [{
        relativePath: integrity.modelRelativePath,
        expectedSize: integrity.expectedModelSize,
        expectedSha256: integrity.expectedModelSha256,
        label: integrity.integrityLabel,
      }],
    };
  }
  const segments = normalized.replace(/\\/g, '/').split('/').filter(Boolean);
  const assetsIndex = segments.findIndex((segment) => segment.toLowerCase() === 'assets');
  if (assetsIndex < 0 || assetsIndex + 1 >= segments.length) {
    if (reportUnsupportedReference) warnSkippedResource(normalized);
    return null;
  }

  const library = segments[assetsIndex + 1]?.toLowerCase();
  let bundleEnd = segments.length;
  if (library === 'models') {
    bundleEnd = segments[assetsIndex + 2]?.toLowerCase() === 'combomodels' ? assetsIndex + 4 : assetsIndex + 3;
  } else if (library === 'environments' || library === 'skyboxes') {
    bundleEnd = assetsIndex + 3;
  }
  if (bundleEnd > segments.length) { warnSkippedResource(normalized); return null; }

  const pathRoot = path.parse(normalized).root;
  const assetRelativeSegments = segments.slice(assetsIndex, bundleEnd);
  let sourceRoot: string;
  if (bundleEnd === segments.length && !['models', 'environments', 'skyboxes'].includes(library)) {
    sourceRoot = normalized;
  } else {
    const prefixSegments = normalized.slice(pathRoot.length).split(path.sep).filter(Boolean);
    const prefixAssetsIndex = prefixSegments.findIndex((segment) => segment.toLowerCase() === 'assets');
    sourceRoot = path.resolve(pathRoot, ...prefixSegments.slice(0, prefixAssetsIndex + (bundleEnd - assetsIndex)));
  }
  if (!isPathInsideOrEqual(projectRoot, sourceRoot) && !isPathInsideOrEqual(sharedResourcesRoot, sourceRoot)
    && !(legacyWorkspaceRoot && isPathInsideOrEqual(path.join(legacyWorkspaceRoot, 'Assets'), sourceRoot))) {
    warnSkippedResource(sourceRoot);
    return null;
  }
  return {
    sourcePath: sourceRoot,
    destinationRelativePath: assetRelativeSegments.join('/'),
  };
}

function rewriteSceneToPortableAssets(
  value: unknown,
  key: string | null = null,
  platformImageBundleMap: ReadonlyMap<string, PlatformImageBundle> = new Map(),
  resourcePlan?: SourceResourcePlan,
): unknown {
  if (typeof value === 'string') {
    const isReference = value.startsWith(LOCAL_ASSET_URL_PREFIX)
      || Boolean(key && (PATH_KEYS.has(key) || URL_KEYS.has(key) || PATH_ARRAY_KEYS.has(key)))
      || isPortableImageAssetReference(value);
    if (!isReference) return value;
    const platformBundle = platformImageBundleMap.get(value);
    if (platformBundle) {
      const target = resourcePlan?.reference(platformBundle.sourcePath)?.destination ?? platformBundle.destinationRelativePath;
      return `${LOCAL_ASSET_URL_PREFIX}${encodeURIComponent(target)}`;
    }
    const planned = resourcePlan?.reference(value);
    if (planned) {
      // 受管环境沿用便携 SOURCE 不携带缓存查询修订的契约；普通模型 URL 保留查询和片段。
      const suffix = /^Assets\/Environments\//i.test(planned.destination) && !planned.bundle.isDirectory ? '' : planned.suffix;
      return value.startsWith(LOCAL_ASSET_URL_PREFIX) || Boolean(key && URL_KEYS.has(key)) || isPortableImageAssetReference(value)
        ? `${LOCAL_ASSET_URL_PREFIX}${encodeURIComponent(planned.destination)}${suffix}` : planned.destination;
    }
    const portablePath = toPortableAssetReference(value);
    if (!portablePath) return value;
    const isImageAssetPortablePath = portablePath.toLowerCase().startsWith('assets/images/');
    if (key && URL_KEYS.has(key)) return `${LOCAL_ASSET_URL_PREFIX}${encodeURIComponent(portablePath)}`;
    if (isImageAssetPortablePath) return `${LOCAL_ASSET_URL_PREFIX}${encodeURIComponent(portablePath)}`;
    if (key && PATH_KEYS.has(key)) return portablePath;
    return value;
  }
  if (Array.isArray(value)) {
    if (key && PATH_ARRAY_KEYS.has(key)) {
      return value.map((item) => rewriteSceneToPortableAssets(item, key, platformImageBundleMap, resourcePlan));
    }
    return value.map((item) => rewriteSceneToPortableAssets(item, key, platformImageBundleMap, resourcePlan));
  }
  if (!isPlainObject(value)) return value;
  const rewritten = Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [
    childKey,
    rewriteSceneToPortableAssets(childValue, childKey, platformImageBundleMap, resourcePlan),
  ]));
  const model = typeof value.sourcePath === 'string' ? resourcePlan?.reference(value.sourcePath) : null;
  if (model && /^Assets\/Models\//i.test(model.destination) && /\.(glb|gltf)$/i.test(model.destination)) {
    rewritten.sourceSnapshot = { contentSha256: model.bundle.contentSha256 };
  }
  return rewritten;
}

function mapSceneReferenceStrings(value: unknown, transform: (value: string) => string): unknown {
  if (typeof value === 'string') return transform(value);
  if (Array.isArray(value)) return value.map(item => mapSceneReferenceStrings(item, transform));
  if (isPlainObject(value)) return Object.fromEntries(Object.entries(value).map(([name, child]) => [name, mapSceneReferenceStrings(child, transform)]));
  return value;
}

/** 新增快照身份不改变几何；验证烘焙时只还原本轮添加的身份字段，其余内容仍严格比较。 */
function restoreSnapshotAnnotations(original: unknown, rewritten: unknown): void {
  if (!original || typeof original !== 'object' || !rewritten || typeof rewritten !== 'object') return;
  const source = original as PlainObject;
  const target = rewritten as PlainObject;
  if (target.sourceSnapshot !== undefined) {
    if (source.sourceSnapshot === undefined) delete target.sourceSnapshot;
    else target.sourceSnapshot = source.sourceSnapshot;
  }
  for (const [name, child] of Object.entries(source)) restoreSnapshotAnnotations(child, target[name]);
}

function toPortableAssetReference(value: string): string | null {
  let normalized = value.trim();
  if (normalized.startsWith(LOCAL_ASSET_URL_PREFIX)) {
    try {
      normalized = decodeURIComponent(new URL(normalized).pathname.slice(1));
    } catch {
      throw new Error('场景中的本地资源 URL 格式无效。');
    }
  }
  normalized = normalized.replace(/\\/g, '/');
  const segments = normalized.split('/').filter(Boolean);
  const environmentCachePath = parseDataPlatformEnvironmentCachePath(segments);
  if (environmentCachePath) {
    const packagePath = createPortableEnvironmentPackagePath(environmentCachePath.resourceId);
    const relativePath = segments.slice(environmentCachePath.revisionEndIndex).join('/');
    return relativePath ? `${packagePath}/${relativePath}` : packagePath;
  }
  const match = /(?:^|\/)(Assets\/(?:Models|Environments|Skyboxes|Cad|Images)(?:\/.*|$))/i.exec(normalized);
  return match ? path.posix.normalize(match[1]) : null;
}

function parseDataPlatformEnvironmentCachePath(
  segments: readonly string[],
): DataPlatformEnvironmentCachePath | null {
  const cacheStartIndex = segments.findIndex((segment, index) => (
    segment.toLowerCase() === '.babylon-editor'
    && segments[index + 1]?.toLowerCase() === 'data-platform-cache'
    && segments[index + 2]?.toLowerCase() === 'environments'
  ));
  if (cacheStartIndex < 0) return null;
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    throw new Error('场景中的数据中台环境缓存引用包含不安全路径片段。');
  }

  const sourceKey = segments[cacheStartIndex + 3] ?? '';
  const resourceId = segments[cacheStartIndex + 4] ?? '';
  const fileRevision = segments[cacheStartIndex + 5] ?? '';
  if (!/^[0-9a-f]{64}$/i.test(sourceKey) || !/^[1-9]\d{0,63}$/.test(resourceId) || !/^[1-9]\d{0,63}$/.test(fileRevision)) {
    throw new Error('场景中的数据中台环境缓存引用身份格式无效。');
  }
  return { resourceId, revisionEndIndex: cacheStartIndex + 6 };
}

function createPortableEnvironmentPackagePath(resourceId: string): string {
  return `Assets/Environments/Env-${resourceId}`;
}

function normalizeResourceDestinationKey(value: string): string {
  return path.posix.normalize(value.replace(/\\/g, '/')).replace(/^\.\//, '').replace(/\/$/, '').toLowerCase();
}

async function copySafeResource(
  sourcePath: string,
  destinationPath: string,
  signal: AbortSignal,
  onBytes: (bytes: number) => void,
  integrityFiles: readonly ResourceFileIntegrity[] = [],
): Promise<void> {
  const pendingIntegrityFiles = new Map<string, ResourceFileIntegrity>();
  for (const integrity of integrityFiles) {
    const normalized = path.posix.normalize(integrity.relativePath.replace(/\\/g, '/'));
    if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../') || path.posix.isAbsolute(normalized)) {
      throw new Error(`${integrity.label}完整性校验路径无效。`);
    }
    pendingIntegrityFiles.set(createPortablePathKey(normalized), integrity);
  }
  const copyFile = async (
    source: string,
    destination: string,
    sourceStat: { size: number },
    relativePath: string,
  ): Promise<void> => {
    const integrityKey = createPortablePathKey(relativePath);
    const integrity = pendingIntegrityFiles.get(integrityKey);
    if (!integrity) throw new Error(`源工程资源清单形成后出现新增或重复文件：${relativePath}`);
    if (integrity && sourceStat.size !== integrity.expectedSize) {
      throw new Error(`${integrity.label}缓存文件大小与 Sidecar 索引不一致。`);
    }
    onBytes(sourceStat.size);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(source, destination);
    if (!integrity) return;
    const copiedStat = await fs.lstat(destination);
    if (copiedStat.isSymbolicLink() || !copiedStat.isFile() || copiedStat.size !== integrity.expectedSize) {
      throw new Error(`${integrity.label}复制文件大小与 Sidecar 索引不一致。`);
    }
    const copiedSha256 = await sha256File(destination, signal);
    if (copiedSha256 !== integrity.expectedSha256) {
      throw new Error(`${integrity.label}复制文件 SHA-256 与 Sidecar 索引不一致。`);
    }
    pendingIntegrityFiles.delete(integrityKey);
  };

  const sourceStat = await fs.lstat(sourcePath);
  if (sourceStat.isSymbolicLink()) throw new Error(`资源路径不能是符号链接或 Junction：${sourcePath}`);
  if (sourceStat.isFile()) {
    await copyFile(sourcePath, destinationPath, sourceStat, path.basename(sourcePath));
    if (pendingIntegrityFiles.size > 0) throw new Error('资源包缺少 Sidecar 要求的完整性校验文件。');
    return;
  }
  if (!sourceStat.isDirectory()) throw new Error(`资源路径不是普通文件或目录：${sourcePath}`);

  const pending: Array<{ source: string; destination: string }> = [{ source: sourcePath, destination: destinationPath }];
  while (pending.length > 0) {
    throwIfAborted(signal);
    const current = pending.pop()!;
    await fs.mkdir(current.destination, { recursive: true });
    const entries = await fs.readdir(current.source, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const entry of entries) {
      const source = path.join(current.source, entry.name);
      const destination = path.join(current.destination, entry.name);
      const stat = await fs.lstat(source);
      if (stat.isSymbolicLink()) throw new Error(`资源包包含符号链接或 Junction：${source}`);
      if (stat.isDirectory()) pending.push({ source, destination });
      else if (stat.isFile()) {
        await copyFile(source, destination, stat, toPortablePath(path.relative(sourcePath, source)));
      } else {
        throw new Error(`资源包包含不支持的特殊文件：${source}`);
      }
    }
  }
  if (pendingIntegrityFiles.size > 0) throw new Error('资源包缺少 Sidecar 要求的完整性校验文件。');
  return;
}

async function archiveDirectoryContents(stagingRoot: string, archivePath: string, signal: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(archivePath, { flags: 'wx' });
    const archive = new ZipArchive({ zlib: { level: 9 } });
    let settled = false;
    const settle = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve();
    };
    const abort = (): void => {
      void archive.abort();
      output.destroy(new Error('数字孪生源工程打包已取消。'));
      settle(new Error('数字孪生源工程打包已取消。'));
    };
    signal.addEventListener('abort', abort, { once: true });
    output.once('close', () => settle());
    output.once('error', settle);
    archive.once('error', settle);
    archive.once('warning', settle);
    archive.pipe(output);
    archive.directory(stagingRoot, false);
    void archive.finalize().catch(settle);
  });
  throwIfAborted(signal);
}

async function sha256File(filePath: string, signal: AbortSignal): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(filePath);
  for await (const chunk of stream) {
    throwIfAborted(signal);
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

function sha256Text(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function resolveInside(root: string, relativePath: string, label: string): string {
  const destination = path.resolve(root, ...relativePath.replace(/\\/g, '/').split('/'));
  if (!isPathInsideOrEqual(root, destination) || destination === path.resolve(root)) throw new Error(`${label}越界。`);
  return destination;
}

function assertPathInsideOrEqual(root: string, candidate: string, label: string): void {
  if (!isPathInsideOrEqual(root, candidate)) throw new Error(`${label}不在允许目录内。`);
}

function isPathInsideOrEqual(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function createPathKey(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function createPortablePathKey(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function assertNoPathOverlap(left: string, right: string, message: string): void {
  if (isPathInsideOrEqual(left, right) || isPathInsideOrEqual(right, left)) throw new Error(message);
}

function toPortablePath(value: string): string {
  return value.replace(/\\/g, '/');
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    const error = new Error('数字孪生源工程打包已取消。');
    error.name = 'AbortError';
    throw error;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && typeof (value as NodeJS.ErrnoException).code === 'string';
}
