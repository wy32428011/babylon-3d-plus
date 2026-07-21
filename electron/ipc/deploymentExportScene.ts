import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ProjectModelAssetEntry } from '../types.js';
import { decodeAssetUrl, isAuthorizedAssetFile, isPathInsideAuthorizedAssetRoot } from './assetRegistry.js';
import { getCurrentProjectRoot, readProjectAssetIndex } from './projectAssetStore.js';
import {
  assertSafeDirectory,
  isPathInsideOrEqual,
  lstatIfExists,
  scanSafeSourceRoot,
  throwIfDeploymentExportAborted,
  toDeploymentPath,
  toLocalPathKey,
  type DeploymentAssetKind,
  type DeploymentCopiedFile,
  type DeploymentCopyFile,
  type SafeSourceFile,
} from './deploymentExportFileSystem.js';

const EDITOR_ASSET_URL_PREFIX = 'editor-asset://local/';
const MAX_SCENE_CONTENT_BYTES = 64 * 1024 * 1024;
const MAX_GLTF_JSON_BYTES = 64 * 1024 * 1024;
const MODEL_EXTENSIONS = new Set(['.glb', '.gltf']);
const SCRIPT_EXTENSION = '.model.ts';
const SECRET_DEPLOYMENT_FILE_EXTENSIONS = new Set(['.pem', '.key', '.pfx', '.p12']);
const SECRET_DEPLOYMENT_FILE_NAMES = new Set([
  '.env',
  '.npmrc',
  '.yarnrc',
  '.netrc',
  'credentials.json',
  'secrets.json',
  'token.json',
  'id_rsa',
  'id_ed25519',
]);
const SECRET_DEPLOYMENT_DIRECTORY_NAMES = new Set(['.git', '.hg', '.svn']);
const NON_RUNTIME_DEPLOYMENT_FILE_EXTENSIONS = new Set([
  '.psd',
  '.blend',
  '.blend1',
  '.fbx',
  '.max',
  '.bak',
  '.log',
  '.tmp',
  '.old',
  '.orig',
  '.zip',
  '.7z',
  '.rar',
]);
const NON_RUNTIME_DEPLOYMENT_DIRECTORY_NAMES = new Set(['node_modules']);

type PlainObject = Record<string, unknown>;
type BundleCategory = 'models' | 'environments' | 'cad' | 'scripts';

type ResourceBundle = {
  key: string;
  category: BundleCategory;
  sourceRoot: string;
  copyCompleteDirectory: boolean;
  explicitRelativePaths: Set<string>;
  gltfDependencyCache: Map<string, Promise<string[]>>;
  destinationRoot: string;
};

type MutableModelReference = {
  asset: PlainObject;
  target?: PlainObject;
  packageOwner?: PlainObject;
};

type ResolvedModelReference = MutableModelReference & {
  sourcePath: string;
  bundle: ResourceBundle;
  scriptPaths: Array<{ script: PlainObject; sourcePath: string }>;
};

type MutableEnvironmentReference = {
  environment: PlainObject;
  variants: PlainObject[];
};

type ResolvedEnvironmentReference = MutableEnvironmentReference & {
  bundle: ResourceBundle;
  variantPaths: Array<{ variant: PlainObject; sourcePath: string; originalSourceUrl: string | null }>;
  originalActiveVariantUrl: string | null;
};

type MutableCadReference = { cad: PlainObject };

type ResolvedCadReference = MutableCadReference & {
  sourcePath: string;
  bundle: ResourceBundle;
};

type ProjectAssetContext = {
  projectRoot: string;
  projectRootRealPath: string;
  assets: ProjectModelAssetEntry[];
};

/** Web 部署导出预检与场景改写的完整结果。 */
export type PreparedDeploymentExport = {
  sceneContent: string;
  runtimeConfigContent: string;
  readmeContent: string;
  assetFiles: DeploymentCopyFile[];
  externalAssetCount: number;
  warnings: string[];
};

/** 资产清单的单条稳定记录。 */
export type DeploymentAssetManifestEntry = {
  logicalUrl: string;
  path: string;
  kind: DeploymentAssetKind;
  size: number;
  sha256: string;
};

/** 校验场景 v1、解析所有资源引用、预检文件并生成无本机路径的部署快照。 */
export async function prepareDeploymentExport(
  content: string,
  exportName: string,
  forbiddenOutputPaths: string[],
  signal: AbortSignal,
  onStatus: (message: string) => void,
): Promise<PreparedDeploymentExport> {
  throwIfDeploymentExportAborted(signal);
  onStatus('正在解析场景 v1…');
  const sceneFile = parseSceneFileV1(content);
  const scene = requirePlainObject(sceneFile.scene, '场景内容');
  const references = collectSceneReferences(scene);
  const warnings: string[] = [];
  const projectContext = await loadProjectAssetContext(signal, warnings);
  const bundles = new Map<string, ResourceBundle>();

  onStatus('正在解析模型、环境、CAD 与脚本资源…');
  const resolvedModels: ResolvedModelReference[] = [];
  for (const reference of references.models) {
    resolvedModels.push(await resolveModelReference(reference, projectContext, bundles, signal));
  }

  const resolvedEnvironments: ResolvedEnvironmentReference[] = [];
  for (const reference of references.environments) {
    resolvedEnvironments.push(await resolveEnvironmentReference(reference, projectContext, bundles, signal));
  }

  const resolvedCadReferences: ResolvedCadReference[] = [];
  for (const reference of references.cadReferences) {
    resolvedCadReferences.push(await resolveCadReference(reference, bundles, signal));
  }

  const externalAssetCount = [...bundles.values()].filter((bundle) => {
    return !projectContext || !isPathInsideOrEqual(projectContext.projectRoot, bundle.sourceRoot);
  }).length;

  onStatus('正在安全扫描资源包…');
  const { assetFiles, sourceUrlMap } = await createAssetCopyPlan(
    [...bundles.values()],
    forbiddenOutputPaths,
    signal,
    onStatus,
    warnings,
  );

  rewriteModelReferences(resolvedModels, sourceUrlMap);
  rewriteEnvironmentReferences(resolvedEnvironments, sourceUrlMap);
  rewriteCadReferences(resolvedCadReferences, sourceUrlMap);

  const originalMqttConfig = isPlainObject(scene.mqttConfig) ? scene.mqttConfig : {};
  scene.mqttConfig = createDisabledSceneMqttConfig();
  const runtimeMqttConfig = createRuntimeMqttConfig(originalMqttConfig, warnings);
  removeOptionalEditorOnlyUrls(scene);
  assertNoLocalMachinePaths(sceneFile);

  return {
    sceneContent: `${JSON.stringify(sceneFile, null, 2)}\n`,
    runtimeConfigContent: `${JSON.stringify(createRuntimeConfig(exportName, runtimeMqttConfig), null, 2)}\n`,
    readmeContent: createDeploymentReadme(exportName),
    assetFiles,
    externalAssetCount,
    warnings,
  };
}

/** 根据已复制文件的真实哈希生成部署资产清单。 */
export function createAssetManifestContent(copiedFiles: DeploymentCopiedFile[]): string {
  const assets: DeploymentAssetManifestEntry[] = copiedFiles
    .filter((file): file is DeploymentCopiedFile & { logicalUrl: string } => typeof file.logicalUrl === 'string')
    .map((file) => ({
      logicalUrl: file.logicalUrl,
      path: createManifestAssetPath(file.destinationRelativePath),
      kind: file.kind,
      size: file.size,
      sha256: file.sha256,
    }))
    .sort((left, right) => left.logicalUrl.localeCompare(right.logicalUrl, 'en'));

  return `${JSON.stringify({ version: 1, assets }, null, 2)}\n`;
}

/** 将 staging 内的部署资源路径转换为相对于 runtime-config assetBase 的清单路径。 */
function createManifestAssetPath(destinationRelativePath: string): string {
  const normalizedPath = toDeploymentPath(destinationRelativePath);
  const assetRootPrefix = 'project/assets/';
  if (!normalizedPath.startsWith(assetRootPrefix)) {
    throw new Error(`部署资源不在 project/assets 下：${normalizedPath}`);
  }
  return `./${normalizedPath.slice(assetRootPrefix.length)}`;
}

/** 解析并严格确认顶层场景文件为 version=1。 */
function parseSceneFileV1(content: string): PlainObject {
  if (typeof content !== 'string' || content.length === 0) throw new Error('导出场景内容不能为空。');
  if (Buffer.byteLength(content, 'utf8') > MAX_SCENE_CONTENT_BYTES) {
    throw new Error(`导出场景内容超过 ${MAX_SCENE_CONTENT_BYTES / 1024 / 1024} MiB 安全上限。`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch {
    throw new Error('导出场景不是有效 JSON。');
  }

  const sceneFile = requirePlainObject(parsed, '场景文件');
  if (sceneFile.version !== 1 || !isPlainObject(sceneFile.scene)) {
    throw new Error('仅支持导出 version=1 的场景文件。');
  }
  return sceneFile;
}

/** 从场景实体和场景设置中收集所有需要重写的资源引用。 */
function collectSceneReferences(scene: PlainObject): {
  models: MutableModelReference[];
  environments: MutableEnvironmentReference[];
  cadReferences: MutableCadReference[];
} {
  const entities = requirePlainObject(scene.entities, 'scene.entities');
  const models: MutableModelReference[] = [];
  const cadReferences: MutableCadReference[] = [];

  for (const [entityId, entityValue] of Object.entries(entities)) {
    const entity = requirePlainObject(entityValue, `实体 ${entityId}`);
    const components = requirePlainObject(entity.components, `实体 ${entityId} components`);
    if (components.modelAsset !== undefined) {
      models.push({ asset: requirePlainObject(components.modelAsset, `实体 ${entityId} modelAsset`) });
    }
    if (components.modelGenerator !== undefined) {
      collectModelGeneratorReferences(requirePlainObject(components.modelGenerator, `实体 ${entityId} modelGenerator`), models, entityId);
    }
    if (components.cadReference !== undefined) {
      cadReferences.push({ cad: requirePlainObject(components.cadReference, `实体 ${entityId} cadReference`) });
    }
  }

  const environments: MutableEnvironmentReference[] = [];
  if (scene.sceneSettings !== undefined) {
    const sceneSettings = requirePlainObject(scene.sceneSettings, 'scene.sceneSettings');
    if (sceneSettings.environment !== null && sceneSettings.environment !== undefined) {
      const environment = requirePlainObject(sceneSettings.environment, 'scene.sceneSettings.environment');
      const variants = requireObjectArray(environment.variants, '环境 variants');
      if (variants.length === 0) throw new Error('环境配置至少需要一个变体。');
      environments.push({ environment, variants });
    }
  }
  return { models, environments, cadReferences };
}

/** 收集模型生成器默认目标和每条规则中的 model 目标。 */
function collectModelGeneratorReferences(generator: PlainObject, models: MutableModelReference[], entityId: string): void {
  collectModelGeneratorTarget(generator.defaultTarget, generator, models, `实体 ${entityId} 默认生成目标`);
  if (generator.rules === undefined) return;
  const rules = requireObjectArray(generator.rules, `实体 ${entityId} modelGenerator.rules`);
  for (const [index, rule] of rules.entries()) {
    collectModelGeneratorTarget(rule.target, rule, models, `实体 ${entityId} 生成规则 ${index + 1}`);
  }
}

/** 校验单个模型生成器目标，并把导入模型目标加入资源收集列表。 */
function collectModelGeneratorTarget(value: unknown, packageOwner: PlainObject, models: MutableModelReference[], label: string): void {
  if (value === null || value === undefined) return;
  const target = requirePlainObject(value, label);
  if (target.kind === 'mesh') return;
  if (target.kind !== 'model') throw new Error(`${label}类型不受支持。`);
  models.push({
    asset: requirePlainObject(target.modelAsset, `${label} modelAsset`),
    target,
    packageOwner: target.packagePath !== undefined ? target : packageOwner,
  });
}

/** 加载当前项目资产索引；项目根失效时降级为外部资源解析并给出警告。 */
async function loadProjectAssetContext(signal: AbortSignal, warnings: string[]): Promise<ProjectAssetContext | null> {
  throwIfDeploymentExportAborted(signal);
  const projectRoot = getCurrentProjectRoot();
  if (!projectRoot) return null;
  const rootStat = await lstatIfExists(projectRoot);
  if (!rootStat) {
    warnings.push('当前项目目录已不存在，导出将按外部资源引用解析。');
    return null;
  }
  const projectRootRealPath = await assertSafeDirectory(projectRoot, '当前项目目录');
  const index = await readProjectAssetIndex(projectRoot);
  return { projectRoot: path.resolve(projectRoot), projectRootRealPath, assets: index.assets };
}

/** 解析单个普通模型或模型生成器模板，并登记模型包与外置脚本。 */
async function resolveModelReference(
  reference: MutableModelReference,
  projectContext: ProjectAssetContext | null,
  bundles: Map<string, ResourceBundle>,
  signal: AbortSignal,
): Promise<ResolvedModelReference> {
  throwIfDeploymentExportAborted(signal);
  const sourcePath = resolveLocalAssetPath(reference.asset.sourcePath, reference.asset.sourceUrl, '模型资源');
  assertModelFileExtension(sourcePath, '模型资源');
  const packagePathHint = readOptionalLocalPath(reference.target?.packagePath ?? reference.packageOwner?.packagePath, '模型包路径');
  const indexedAsset = findProjectAsset(projectContext?.assets ?? [], sourcePath, packagePathHint, 'model');
  if (!indexedAsset) assertAuthorizedDeploymentSourceFile(sourcePath, '模型资源');
  const bundle = await resolveModelBundle(sourcePath, packagePathHint, indexedAsset, projectContext, bundles, signal);

  await addModelFileAndDependencies(bundle, sourcePath, signal);
  const scriptPaths: Array<{ script: PlainObject; sourcePath: string }> = [];
  if (reference.asset.scriptAssets !== undefined) {
    const scripts = requireObjectArray(reference.asset.scriptAssets, 'modelAsset.scriptAssets');
    for (const script of scripts) {
      const scriptPath = resolveLocalAssetPath(script.path, script.sourceUrl, '模型脚本');
      if (!scriptPath.toLowerCase().endsWith(SCRIPT_EXTENSION)) {
        throw new Error('模型脚本必须使用 .model.ts 扩展名。');
      }
      const scriptBundle = isPathInsideOrEqual(bundle.sourceRoot, scriptPath)
        ? bundle
        : getOrCreateBundle(bundles, 'scripts', path.dirname(scriptPath), false);
      if (!scriptBundle.copyCompleteDirectory) assertAuthorizedDeploymentSourceFile(scriptPath, '模型脚本');
      addExplicitFileToBundle(scriptBundle, scriptPath);
      scriptPaths.push({ script, sourcePath: scriptPath });
    }
  }
  return { ...reference, sourcePath, bundle, scriptPaths };
}

/** 根据项目索引、显式 packagePath 或相邻 meta.json 选择模型包根。 */
async function resolveModelBundle(
  sourcePath: string,
  packagePathHint: string | null,
  indexedAsset: ProjectModelAssetEntry | null,
  projectContext: ProjectAssetContext | null,
  bundles: Map<string, ResourceBundle>,
  signal: AbortSignal,
): Promise<ResourceBundle> {
  throwIfDeploymentExportAborted(signal);
  if (indexedAsset?.packagePath) {
    await assertProjectPackageInsideRoot(indexedAsset.packagePath, projectContext);
    return getOrCreateBundle(bundles, 'models', indexedAsset.packagePath, true);
  }

  if (packagePathHint) {
    if (!isPathInsideOrEqual(packagePathHint, sourcePath)) throw new Error('模型文件不在场景声明的 packagePath 内。');
    if (await isTrustedCompletePackageRoot(packagePathHint)) {
      return getOrCreateBundle(bundles, 'models', packagePathHint, true);
    }
  }

  const sourceDirectory = path.dirname(sourcePath);
  return getOrCreateBundle(bundles, 'models', sourceDirectory, await isTrustedCompletePackageRoot(sourceDirectory));
}

/** 解析环境包、环境变体和 activeVariantUrl。 */
async function resolveEnvironmentReference(
  reference: MutableEnvironmentReference,
  projectContext: ProjectAssetContext | null,
  bundles: Map<string, ResourceBundle>,
  signal: AbortSignal,
): Promise<ResolvedEnvironmentReference> {
  throwIfDeploymentExportAborted(signal);
  const packagePathHint = readOptionalLocalPath(reference.environment.packagePath, '环境包路径');
  const firstVariantPath = resolveLocalAssetPath(reference.variants[0]?.sourcePath, reference.variants[0]?.sourceUrl, '环境变体');
  const indexedAsset = findProjectAsset(projectContext?.assets ?? [], firstVariantPath, packagePathHint, 'environment');
  if (!indexedAsset) assertAuthorizedDeploymentSourceFile(firstVariantPath, '环境变体');

  let packageRoot: string;
  let copyCompleteDirectory: boolean;
  if (indexedAsset?.packagePath) {
    await assertProjectPackageInsideRoot(indexedAsset.packagePath, projectContext);
    packageRoot = indexedAsset.packagePath;
    copyCompleteDirectory = true;
  } else if (packagePathHint && isPathInsideOrEqual(packagePathHint, firstVariantPath) && await isTrustedCompletePackageRoot(packagePathHint)) {
    packageRoot = packagePathHint;
    copyCompleteDirectory = true;
  } else {
    packageRoot = path.dirname(firstVariantPath);
    copyCompleteDirectory = await isTrustedCompletePackageRoot(packageRoot);
  }

  const bundle = getOrCreateBundle(bundles, 'environments', packageRoot, copyCompleteDirectory);
  const variantPaths: ResolvedEnvironmentReference['variantPaths'] = [];
  for (const variant of reference.variants) {
    const sourcePath = resolveLocalAssetPath(variant.sourcePath, variant.sourceUrl, '环境变体');
    assertModelFileExtension(sourcePath, '环境变体');
    if (!indexedAsset && !bundle.copyCompleteDirectory) assertAuthorizedDeploymentSourceFile(sourcePath, '环境变体');
    if (!isPathInsideOrEqual(bundle.sourceRoot, sourcePath)) throw new Error('环境变体路径逃逸环境包根目录。');
    await addModelFileAndDependencies(bundle, sourcePath, signal);
    variantPaths.push({
      variant,
      sourcePath,
      originalSourceUrl: typeof variant.sourceUrl === 'string' ? variant.sourceUrl : null,
    });
  }

  return {
    ...reference,
    bundle,
    variantPaths,
    originalActiveVariantUrl: typeof reference.environment.activeVariantUrl === 'string'
      ? reference.environment.activeVariantUrl
      : null,
  };
}

/** 解析单个 CAD 文件，并按明确文件模式登记。 */
async function resolveCadReference(
  reference: MutableCadReference,
  bundles: Map<string, ResourceBundle>,
  signal: AbortSignal,
): Promise<ResolvedCadReference> {
  throwIfDeploymentExportAborted(signal);
  const sourcePath = resolveLocalAssetPath(reference.cad.sourcePath, reference.cad.sourceUrl, 'CAD 资源');
  assertAuthorizedDeploymentSourceFile(sourcePath, 'CAD 资源');
  const bundle = getOrCreateBundle(bundles, 'cad', path.dirname(sourcePath), false);
  addExplicitFileToBundle(bundle, sourcePath);
  return { ...reference, sourcePath, bundle };
}

/** 为 glTF/GLB 模型登记主文件；同一 glTF 在单次导出中最多解析一次依赖。 */
async function addModelFileAndDependencies(bundle: ResourceBundle, sourcePath: string, signal: AbortSignal): Promise<void> {
  if (!isPathInsideOrEqual(bundle.sourceRoot, sourcePath)) throw new Error('模型文件路径逃逸模型包根目录。');
  addExplicitFileToBundle(bundle, sourcePath);
  if (path.extname(sourcePath).toLowerCase() !== '.gltf') return;

  const sourceKey = toLocalPathKey(sourcePath);
  let dependencyPromise = bundle.gltfDependencyCache.get(sourceKey);
  if (!dependencyPromise) {
    dependencyPromise = readGltfDependencies(sourcePath, bundle.sourceRoot, signal);
    bundle.gltfDependencyCache.set(sourceKey, dependencyPromise);
  }

  try {
    for (const dependencyPath of await dependencyPromise) addExplicitFileToBundle(bundle, dependencyPath);
  } catch (error) {
    if (bundle.gltfDependencyCache.get(sourceKey) === dependencyPromise) bundle.gltfDependencyCache.delete(sourceKey);
    throw error;
  }
}

/** 安全读取 glTF JSON 中的本地 URI，并拒绝远程依赖与包根逃逸。 */
async function readGltfDependencies(gltfPath: string, packageRoot: string, signal: AbortSignal): Promise<string[]> {
  throwIfDeploymentExportAborted(signal);
  const stat = await fs.lstat(gltfPath);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('glTF 主文件不是安全的普通文件。');
  if (stat.size > MAX_GLTF_JSON_BYTES) throw new Error('glTF JSON 超过安全解析上限。');

  let document: unknown;
  try {
    document = JSON.parse(await fs.readFile(gltfPath, 'utf8')) as unknown;
  } catch {
    throw new Error('glTF JSON 无法解析。');
  }

  const gltf = requirePlainObject(document, 'glTF 文档');
  const uris: string[] = [];
  collectUriValues(gltf.buffers, uris, 'glTF buffers');
  collectUriValues(gltf.images, uris, 'glTF images');
  const dependencies = new Set<string>();

  for (const uri of uris) {
    throwIfDeploymentExportAborted(signal);
    if (/^data:/i.test(uri)) continue;
    if (/^[a-z][a-z\d+.-]*:/i.test(uri) || uri.startsWith('//')) {
      throw new Error('glTF 包含无法离线导出的远程资源 URI。');
    }

    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(uri.split(/[?#]/, 1)[0] ?? '');
    } catch {
      throw new Error('glTF 资源 URI 编码不正确。');
    }

    if (!decodedPath || path.isAbsolute(decodedPath) || path.win32.isAbsolute(decodedPath)) {
      throw new Error('glTF 资源 URI 不是安全相对路径。');
    }
    const dependencyPath = path.resolve(path.dirname(gltfPath), decodedPath);
    if (!isPathInsideOrEqual(packageRoot, dependencyPath)) throw new Error('glTF 资源 URI 逃逸模型包根目录。');
    dependencies.add(dependencyPath);
  }
  return [...dependencies];
}

/** 从 glTF buffers/images 数组中收集非空 uri 字段。 */
function collectUriValues(value: unknown, target: string[], label: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) throw new Error(`${label} 格式不正确。`);
  for (const entry of value) {
    if (!isPlainObject(entry) || entry.uri === undefined) continue;
    if (typeof entry.uri !== 'string' || !entry.uri) throw new Error(`${label} URI 格式不正确。`);
    target.push(entry.uri);
  }
}

/** 建立或复用同一类别、同一资源根对应的复制包。 */
function getOrCreateBundle(
  bundles: Map<string, ResourceBundle>,
  category: BundleCategory,
  sourceRoot: string,
  copyCompleteDirectory: boolean,
): ResourceBundle {
  const normalizedRoot = path.resolve(sourceRoot);
  const key = `${category}:${toLocalPathKey(normalizedRoot)}`;
  const existing = bundles.get(key);
  if (existing) {
    if (copyCompleteDirectory) existing.copyCompleteDirectory = true;
    return existing;
  }

  const hash = createHash('sha256').update(key).digest('hex').slice(0, 10);
  const baseName = createSafePathSegment(path.basename(normalizedRoot) || category.slice(0, -1));
  const bundle: ResourceBundle = {
    key,
    category,
    sourceRoot: normalizedRoot,
    copyCompleteDirectory,
    explicitRelativePaths: new Set<string>(),
    gltfDependencyCache: new Map<string, Promise<string[]>>(),
    destinationRoot: `project/assets/${category}/${baseName}-${hash}`,
  };
  bundles.set(key, bundle);
  return bundle;
}

/** 把明确资源文件登记到包内，并拒绝绝对路径或父目录逃逸。 */
function addExplicitFileToBundle(bundle: ResourceBundle, sourcePath: string): void {
  const normalizedSourcePath = path.resolve(sourcePath);
  const relativePath = path.relative(bundle.sourceRoot, normalizedSourcePath);
  if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new Error('明确资源文件不在选定资源根目录内。');
  }
  bundle.explicitRelativePaths.add(relativePath);
}

/** 扫描全部资源包并生成去重、无目标冲突的复制计划和虚拟 URL 映射。 */
async function createAssetCopyPlan(
  bundles: ResourceBundle[],
  forbiddenOutputPaths: string[],
  signal: AbortSignal,
  onStatus: (message: string) => void,
  warnings: string[],
): Promise<{ assetFiles: DeploymentCopyFile[]; sourceUrlMap: Map<string, string> }> {
  const assetFiles: DeploymentCopyFile[] = [];
  const sourceUrlMap = new Map<string, string>();
  const destinationKeys = new Set<string>();

  for (const [index, bundle] of bundles.entries()) {
    throwIfDeploymentExportAborted(signal);
    onStatus(`正在扫描资源包 ${index + 1}/${bundles.length}…`);
    const files = await scanSafeSourceRoot(
      bundle.sourceRoot,
      bundle.copyCompleteDirectory ? null : bundle.explicitRelativePaths,
      forbiddenOutputPaths,
      signal,
    );
    auditDeploymentPackageFiles(bundle, files, warnings);

    for (const file of files) {
      const destinationRelativePath = `${bundle.destinationRoot}/${file.relativePath}`;
      const destinationKey = destinationRelativePath.toLowerCase();
      if (destinationKeys.has(destinationKey)) throw new Error(`导出资源目标冲突：${destinationRelativePath}`);
      destinationKeys.add(destinationKey);

      const logicalUrl = createVirtualAssetUrl(destinationRelativePath);
      assetFiles.push({
        ...file,
        destinationRelativePath,
        logicalUrl,
        kind: inferAssetKind(bundle.category, file.relativePath),
      });
      sourceUrlMap.set(toLocalPathKey(file.sourcePath), logicalUrl);
      const lexicalSourcePath = path.resolve(bundle.sourceRoot, ...file.relativePath.split('/'));
      sourceUrlMap.set(toLocalPathKey(lexicalSourcePath), logicalUrl);
    }
  }

  assetFiles.sort((left, right) => left.destinationRelativePath.localeCompare(right.destinationRelativePath, 'en'));
  return { assetFiles, sourceUrlMap };
}

/** 审计完整模型/环境包：明确秘密文件阻断导出，非运行时文件仅给出聚合警告。 */
function auditDeploymentPackageFiles(bundle: ResourceBundle, files: SafeSourceFile[], warnings: string[]): void {
  if (!bundle.copyCompleteDirectory || (bundle.category !== 'models' && bundle.category !== 'environments')) return;

  const secretFile = files.find((file) => isExplicitSecretDeploymentFile(file.relativePath));
  if (secretFile) {
    const packageLabel = bundle.category === 'models' ? '模型' : '环境';
    throw new Error(`完整复制的${packageLabel}包包含疑似凭据或版本控制文件：${toDeploymentPath(secretFile.relativePath)}。请移出或清理后重新导出。`);
  }

  let nonRuntimeFileCount = 0;
  const examples: string[] = [];
  for (const file of files) {
    if (!isKnownNonRuntimeDeploymentFile(file.relativePath)) continue;
    nonRuntimeFileCount += 1;
    if (examples.length < 8) examples.push(toDeploymentPath(file.relativePath));
  }

  if (nonRuntimeFileCount > 0) {
    const packageLabel = bundle.category === 'models' ? '模型' : '环境';
    const omittedCount = nonRuntimeFileCount - examples.length;
    const omittedText = omittedCount > 0 ? `，另有 ${omittedCount} 个` : '';
    warnings.push(`完整复制的${packageLabel}包包含 ${nonRuntimeFileCount} 个可能非运行时文件：${examples.join('、')}${omittedText}。这些文件已按完整包规则保留，请确认部署体积和公开内容。`);
  }
}

/** 判断相对路径是否命中高置信度秘密文件或版本控制目录。 */
function isExplicitSecretDeploymentFile(relativePath: string): boolean {
  const normalizedPath = toDeploymentPath(relativePath).toLowerCase();
  const pathSegments = normalizedPath.split('/').filter(Boolean);
  const fileName = pathSegments[pathSegments.length - 1] ?? '';
  if (pathSegments.some((segment) => SECRET_DEPLOYMENT_DIRECTORY_NAMES.has(segment))) return true;
  if (SECRET_DEPLOYMENT_FILE_NAMES.has(fileName) || fileName.startsWith('.env.')) return true;
  if (/^service-account.*\.json$/i.test(fileName)) return true;
  return SECRET_DEPLOYMENT_FILE_EXTENSIONS.has(path.posix.extname(fileName));
}

/** 判断相对路径是否属于常见设计源文件、备份、日志或依赖目录。 */
function isKnownNonRuntimeDeploymentFile(relativePath: string): boolean {
  const normalizedPath = toDeploymentPath(relativePath).toLowerCase();
  const pathSegments = normalizedPath.split('/').filter(Boolean);
  if (pathSegments.some((segment) => NON_RUNTIME_DEPLOYMENT_DIRECTORY_NAMES.has(segment))) return true;
  const fileName = pathSegments[pathSegments.length - 1] ?? '';
  return NON_RUNTIME_DEPLOYMENT_FILE_EXTENSIONS.has(path.posix.extname(fileName));
}

/** 将普通模型、生成器目标及脚本路径改写为部署虚拟 URL。 */
function rewriteModelReferences(references: ResolvedModelReference[], sourceUrlMap: Map<string, string>): void {
  for (const reference of references) {
    const modelUrl = requireMappedUrl(sourceUrlMap, reference.sourcePath, '模型资源');
    reference.asset.sourcePath = modelUrl;
    reference.asset.sourceUrl = modelUrl;

    if (reference.target) {
      reference.target.assetId = `deployment:${createHash('sha256').update(modelUrl).digest('hex').slice(0, 24)}`;
      reference.target.packagePath = createVirtualDirectoryUrl(reference.bundle.destinationRoot);
      delete reference.target.thumbnailUrl;
    }
    if (reference.packageOwner && reference.packageOwner !== reference.target && reference.packageOwner.packagePath !== undefined) {
      reference.packageOwner.packagePath = createVirtualDirectoryUrl(reference.bundle.destinationRoot);
    }

    for (const { script, sourcePath } of reference.scriptPaths) {
      const scriptUrl = requireMappedUrl(sourceUrlMap, sourcePath, '模型脚本');
      script.path = scriptUrl;
      script.sourceUrl = scriptUrl;
    }
  }
}

/** 将环境 packagePath、变体 URL 和 activeVariantUrl 改写为部署虚拟 URL。 */
function rewriteEnvironmentReferences(references: ResolvedEnvironmentReference[], sourceUrlMap: Map<string, string>): void {
  for (const reference of references) {
    reference.environment.packagePath = createVirtualDirectoryUrl(reference.bundle.destinationRoot);
    delete reference.environment.thumbnailUrl;

    let activeVariantUrl: string | null = null;
    for (const { variant, sourcePath, originalSourceUrl } of reference.variantPaths) {
      const variantUrl = requireMappedUrl(sourceUrlMap, sourcePath, '环境变体');
      if (reference.originalActiveVariantUrl && (
        reference.originalActiveVariantUrl === originalSourceUrl
        || localReferenceMatches(reference.originalActiveVariantUrl, sourcePath)
      )) {
        activeVariantUrl = variantUrl;
      }
      variant.sourcePath = variantUrl;
      variant.sourceUrl = variantUrl;
    }

    reference.environment.activeVariantUrl = activeVariantUrl
      ?? requireMappedUrl(sourceUrlMap, reference.variantPaths[0]?.sourcePath ?? '', '环境默认变体');
  }
}

/** 将 CAD sourcePath/sourceUrl 改写为部署虚拟 URL。 */
function rewriteCadReferences(references: ResolvedCadReference[], sourceUrlMap: Map<string, string>): void {
  for (const reference of references) {
    const cadUrl = requireMappedUrl(sourceUrlMap, reference.sourcePath, 'CAD 资源');
    reference.cad.sourcePath = cadUrl;
    reference.cad.sourceUrl = cadUrl;
  }
}

/** 从映射表取得资源虚拟 URL；遗漏表示预检与场景引用不一致。 */
function requireMappedUrl(sourceUrlMap: Map<string, string>, sourcePath: string, label: string): string {
  const logicalUrl = sourceUrlMap.get(toLocalPathKey(sourcePath));
  if (!logicalUrl) throw new Error(`${label}未进入导出资源清单。`);
  return logicalUrl;
}

/** 判断旧 activeVariantUrl 是否指向给定本地文件。 */
function localReferenceMatches(reference: string, sourcePath: string): boolean {
  try {
    return toLocalPathKey(resolveLocalAssetPath(undefined, reference, '环境活动变体')) === toLocalPathKey(sourcePath);
  } catch {
    return false;
  }
}

/** 使用项目索引中的 packagePath 或模型路径匹配当前引用。 */
function findProjectAsset(
  assets: ProjectModelAssetEntry[],
  sourcePath: string,
  packagePathHint: string | null,
  libraryKind: ProjectModelAssetEntry['libraryKind'],
): ProjectModelAssetEntry | null {
  const sourceKey = toLocalPathKey(sourcePath);
  const packageKey = packagePathHint ? toLocalPathKey(packagePathHint) : null;
  const candidates = assets.filter((asset) => {
    if (asset.libraryKind !== libraryKind) return false;
    if (packageKey && asset.packagePath && toLocalPathKey(asset.packagePath) === packageKey) return true;
    if (toLocalPathKey(asset.path) === sourceKey) return true;
    return Boolean(asset.packagePath && isPathInsideOrEqual(asset.packagePath, sourcePath));
  });
  candidates.sort((left, right) => (right.packagePath?.length ?? 0) - (left.packagePath?.length ?? 0));
  return candidates[0] ?? null;
}

/** 校验项目索引中的包 realpath 仍位于当前项目根目录内。 */
async function assertProjectPackageInsideRoot(packagePath: string, projectContext: ProjectAssetContext | null): Promise<void> {
  if (!projectContext) throw new Error('项目资产索引上下文缺失。');
  if (!isPathInsideOrEqual(projectContext.projectRoot, packagePath)) throw new Error('项目资产包路径逃逸当前项目目录。');
  const packageRealPath = await assertSafeDirectory(packagePath, '项目资产包');
  if (!isPathInsideOrEqual(projectContext.projectRootRealPath, packageRealPath)) {
    throw new Error('项目资产包 realpath 逃逸当前项目目录。');
  }
}

/** 校验资源文件已通过项目索引之外的当前会话资产授权。 */
function assertAuthorizedDeploymentSourceFile(filePath: string, label: string): void {
  if (!isAuthorizedAssetFile(filePath)) throw new Error(`${label}未经过当前会话的资产选择或项目授权，已拒绝读取。`);
}

/** 只有用户授权过的目录或带相邻 meta.json 的包根才允许完整复制。 */
async function isTrustedCompletePackageRoot(directoryPath: string): Promise<boolean> {
  return isPathInsideAuthorizedAssetRoot(directoryPath) || await hasAdjacentPackageMetadata(directoryPath);
}

/** 检查目录旁是否存在普通 meta.json，以决定是否可安全复制完整外部包。 */
async function hasAdjacentPackageMetadata(directoryPath: string): Promise<boolean> {
  const metadataPath = path.join(directoryPath, 'meta.json');
  const stat = await lstatIfExists(metadataPath);
  if (!stat) return false;
  if (stat.isSymbolicLink()) throw new Error('模型包 meta.json 不能是符号链接或 Junction。');
  if (!stat.isFile()) throw new Error('模型包 meta.json 不是普通文件。');
  return true;
}

/** 优先从 sourcePath、其次从 sourceUrl 解出受支持的本地绝对路径。 */
function resolveLocalAssetPath(sourcePathValue: unknown, sourceUrlValue: unknown, label: string): string {
  const sourcePath = typeof sourcePathValue === 'string' ? sourcePathValue.trim() : '';
  if (sourcePath) {
    if (sourcePath.startsWith(EDITOR_ASSET_URL_PREFIX)) return decodeAssetUrl(sourcePath);
    if (path.isAbsolute(sourcePath) || path.win32.isAbsolute(sourcePath)) return path.resolve(sourcePath);
  }
  const sourceUrl = typeof sourceUrlValue === 'string' ? sourceUrlValue.trim() : '';
  if (sourceUrl.startsWith(EDITOR_ASSET_URL_PREFIX)) return decodeAssetUrl(sourceUrl);
  throw new Error(`${label}缺少可解析的本地绝对路径。`);
}

/** 读取可选 packagePath；存在时必须能够解析为本地绝对路径。 */
function readOptionalLocalPath(value: unknown, label: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new Error(`${label}格式不正确。`);
  return resolveLocalAssetPath(value, undefined, label);
}

/** 限定当前部署模型资源为 GLB 或 glTF。 */
function assertModelFileExtension(filePath: string, label: string): void {
  if (!MODEL_EXTENSIONS.has(path.extname(filePath).toLowerCase())) throw new Error(`${label}必须是 .glb 或 .gltf 文件。`);
}

/** 根据资源类别和扩展名生成资产清单 kind。 */
function inferAssetKind(category: BundleCategory, relativePath: string): DeploymentAssetKind {
  const lowerPath = relativePath.toLowerCase();
  const extension = path.extname(lowerPath);
  if (lowerPath.endsWith(SCRIPT_EXTENSION) || ['.ts', '.js', '.mjs', '.cjs'].includes(extension)) return 'script';
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.dds', '.ktx', '.ktx2', '.hdr', '.env', '.exr'].includes(extension)) return 'texture';
  if (['.bin', '.wasm'].includes(extension)) return 'buffer';
  if (extension === '.json') return 'metadata';
  if (extension === '.dxf' || category === 'cad') return 'cad';
  if (MODEL_EXTENSIONS.has(extension)) return category === 'environments' ? 'environment' : 'model';
  return 'asset';
}

/** 为清单文件生成不含本机路径的 editor-asset 虚拟 URL。 */
function createVirtualAssetUrl(destinationRelativePath: string): string {
  return `${EDITOR_ASSET_URL_PREFIX}${encodeURIComponent(toDeploymentPath(destinationRelativePath))}`;
}

/** 为模型包目录生成带尾斜杠的 editor-asset 虚拟 URL。 */
function createVirtualDirectoryUrl(destinationRoot: string): string {
  return `${EDITOR_ASSET_URL_PREFIX}${encodeURIComponent(`${toDeploymentPath(destinationRoot)}/`)}`;
}

/** 生成兼容 Windows 文件名规则的稳定目录片段。 */
function createSafePathSegment(value: string): string {
  const normalized = value
    .normalize('NFKC')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .trim()
    .replace(/[. ]+$/g, '')
    .slice(0, 64);
  return normalized || 'asset';
}

/** 从原场景生成默认关闭的浏览器 MQTT 配置，并拒绝不安全地址。 */
function createRuntimeMqttConfig(source: PlainObject, warnings: string[]): PlainObject {
  const address = readBoundedString(source.address, 2048);
  const safeAddress = address && isSafeBrowserMqttAddress(address) ? address : '';
  const subscriptions = sanitizeMqttSubscriptions(source.subscriptions);
  const requestedEnabled = source.enabled === true;
  const enabled = requestedEnabled && Boolean(safeAddress) && subscriptions.length > 0;
  if (address && !safeAddress) warnings.push('原场景 MQTT 地址不适合浏览器部署，runtime-config 已清空地址并保持禁用。');
  if (requestedEnabled && !enabled && safeAddress) warnings.push('原场景 MQTT 已启用但缺少有效订阅，runtime-config 已保持禁用。');

  const simulatorScenario = typeof source.simulatorScenario === 'string' && ['cycle', 'target', 'movement', 'fault', 'generic'].includes(source.simulatorScenario)
    ? source.simulatorScenario
    : 'cycle';
  const sourceInterval = typeof source.simulatorIntervalMs === 'number' ? source.simulatorIntervalMs : Number.NaN;
  const simulatorIntervalMs = Number.isInteger(sourceInterval) && sourceInterval >= 100 ? sourceInterval : 500;

  return {
    enabled,
    ip: readBoundedString(source.ip, 256),
    address: safeAddress,
    topic: readBoundedString(source.topic, 2048),
    subscriptions,
    simulatorEnabled: false,
    simulatorAssetCode: readBoundedString(source.simulatorAssetCode, 128),
    simulatorScenario,
    simulatorIntervalMs,
  };
}

/** 生成 scene.json 内完全禁用且不携带连接地址的 MQTT 占位配置。 */
function createDisabledSceneMqttConfig(): PlainObject {
  return {
    enabled: false,
    ip: '',
    address: '',
    topic: '',
    subscriptions: [],
    simulatorEnabled: false,
    simulatorAssetCode: '',
    simulatorScenario: 'cycle',
    simulatorIntervalMs: 500,
  };
}

/** 生成 Viewer 根目录 runtime-config.json。 */
function createRuntimeConfig(exportName: string, mqtt: PlainObject): PlainObject {
  return {
    version: 1,
    page: {
      title: exportName,
      loadingText: '场景加载中...',
      backgroundColor: '#141414',
    },
    paths: {
      scene: './project/scene.json',
      assetManifest: './project/asset-manifest.json',
      assetBase: './project/assets/',
    },
    viewer: {
      showGrid: false,
      allowCameraControl: true,
      showStatusOverlay: true,
    },
    mqtt,
  };
}

/** 只保留安全的 MQTT 订阅字段，避免把任意对象原样写入部署配置。 */
function sanitizeMqttSubscriptions(value: unknown): PlainObject[] {
  if (!Array.isArray(value)) return [];
  const subscriptions: PlainObject[] = [];
  for (const entry of value.slice(0, 32)) {
    if (!isPlainObject(entry)) continue;
    const topic = readBoundedString(entry.topic, 512);
    if (!topic) continue;
    const adapter = sanitizeMqttAdapter(entry.adapter) ?? { kind: 'epv' };
    const subscription: PlainObject = { topic, qos: entry.qos === 1 ? 1 : 0, adapter };
    subscriptions.push(subscription);
  }
  return subscriptions;
}

/** 只复制 epv/json-path 适配器的公开配置字段。 */
function sanitizeMqttAdapter(value: unknown): PlainObject | null {
  if (!isPlainObject(value)) return null;
  if (value.kind === 'epv') {
    const sourceId = readBoundedString(value.sourceId, 128);
    const deviceType = readBoundedString(value.deviceType, 128);
    return { kind: 'epv', ...(sourceId ? { sourceId } : {}), ...(deviceType ? { deviceType } : {}) };
  }
  if (value.kind !== 'json-path') return null;

  const fields: Record<string, string> = {};
  if (isPlainObject(value.fields)) {
    for (const [key, fieldPath] of Object.entries(value.fields).slice(0, 128)) {
      if (typeof fieldPath === 'string' && key.length <= 128 && fieldPath.length <= 256) fields[key] = fieldPath;
    }
  }

  const sourceId = readBoundedString(value.sourceId, 256);
  const deviceTypePath = readBoundedString(value.deviceTypePath, 256);
  const assetCodePath = readBoundedString(value.assetCodePath, 256);
  const timestampPath = readBoundedString(value.timestampPath, 256);
  const sequencePath = readBoundedString(value.sequencePath, 256);
  return {
    kind: 'json-path',
    ...(sourceId ? { sourceId } : {}),
    ...(deviceTypePath ? { deviceTypePath } : {}),
    ...(assetCodePath ? { assetCodePath } : {}),
    ...(timestampPath ? { timestampPath } : {}),
    ...(sequencePath ? { sequencePath } : {}),
    fields,
  };
}

/** 只允许不带账号密码和敏感 query 的 ws/wss MQTT 地址。 */
function isSafeBrowserMqttAddress(address: string): boolean {
  try {
    const url = new URL(address);
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') return false;
    if (url.username || url.password) return false;
    const sensitiveKeys = new Set(['token', 'access_token', 'password', 'username', 'secret', 'apikey', 'api_key']);
    return [...url.searchParams.keys()].every((key) => !sensitiveKeys.has(key.toLowerCase()));
  } catch {
    return false;
  }
}

/** 删除仅供编辑器资产面板使用的缩略图 URL，避免残留本机路径。 */
function removeOptionalEditorOnlyUrls(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) removeOptionalEditorOnlyUrls(item);
    return;
  }
  if (!isPlainObject(value)) return;
  delete value.thumbnailUrl;
  for (const child of Object.values(value)) removeOptionalEditorOnlyUrls(child);
}

/** 递归确认 scene.json 中不存在 Windows、UNC、file:// 或绝对 editor-asset 本机路径。 */
function assertNoLocalMachinePaths(value: unknown, location = '$', seen = { count: 0 }): void {
  seen.count += 1;
  if (seen.count > 1_000_000) throw new Error('场景结构过大，无法完成本机路径审计。');

  if (typeof value === 'string') {
    if (/^[a-zA-Z]:[\\/]/.test(value) || /^\\\\/.test(value) || /^file:\/\//i.test(value)) {
      throw new Error(`部署场景仍包含本机路径：${location}`);
    }
    if (value.startsWith(EDITOR_ASSET_URL_PREFIX)) {
      const parsed = new URL(value);
      const decoded = decodeURIComponent(parsed.pathname.slice(1));
      if (path.win32.isAbsolute(decoded) || /^\\\\/.test(decoded)) {
        throw new Error(`部署场景仍包含绝对 editor-asset 路径：${location}`);
      }
    }
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoLocalMachinePaths(item, `${location}[${index}]`, seen));
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, child] of Object.entries(value)) assertNoLocalMachinePaths(child, `${location}.${key}`, seen);
  }
}

/** 生成部署包内 README，说明运行方式与安全边界。 */
function createDeploymentReadme(exportName: string): string {
  return `# ${exportName}\n\n此目录是 ZENDING 3D EDITOR 导出的只读 Web 部署工程。\n\n## 使用方式\n\n1. 将整个目录部署到支持静态文件的 HTTP/HTTPS 服务器。\n2. 不要直接双击 index.html；浏览器需要通过 HTTP/HTTPS 加载模型、脚本和 Worker。\n3. 页面、资源路径和 MQTT 配置位于 runtime-config.json，修改后刷新页面即可生效。\n4. MQTT 是否启用取自安全清理后的场景配置；本地模拟器默认关闭，地址必须使用 ws:// 或 wss://，且配置中不得包含账号、密码或长期 Token。\n\n## 目录说明\n\n- index.html / assets：只读 Web Viewer。\n- runtime-config.json：部署期可修改配置。\n- project/scene.json：已移除本机路径的运行时场景。\n- project/asset-manifest.json：资源 URL、相对路径、大小和 SHA-256。\n- project/assets：模型、环境、CAD、脚本与贴图资源。\n\n带 .model.ts 外置脚本的工程需要部署站点 CSP 允许可信脚本运行链路所需的 unsafe-eval。\n`;
}

/** 读取长度受限的字符串字段。 */
function readBoundedString(value: unknown, maxLength: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

/** 将未知值收窄为普通 JSON 对象。 */
function isPlainObject(value: unknown): value is PlainObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 要求指定值为普通对象，否则抛出带上下文的导出错误。 */
function requirePlainObject(value: unknown, label: string): PlainObject {
  if (!isPlainObject(value)) throw new Error(`${label}格式不正确。`);
  return value;
}

/** 要求指定值为普通对象数组。 */
function requireObjectArray(value: unknown, label: string): PlainObject[] {
  if (!Array.isArray(value)) throw new Error(`${label}格式不正确。`);
  return value.map((item, index) => requirePlainObject(item, `${label}[${index}]`));
}
