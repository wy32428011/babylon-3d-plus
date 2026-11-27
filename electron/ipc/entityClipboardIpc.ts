import { clipboard } from 'electron';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { collectEffectModelReferences } from '../shared/effectDeploymentReferences.js';
import { CURRENT_SCENE_FILE_VERSION } from '../shared/sceneFileVersion.js';
import {
  ENTITY_CLIPBOARD_FORMAT,
  parseEntityClipboardPayload,
  serializeEntityClipboardPayload,
  type ClipboardMissingResourceIssue,
  type CrossSceneEntityClipboardPayload,
  type ReadEntityClipboardResult,
  type WriteEntityClipboardRequest,
  type WriteEntityClipboardResult,
} from '../shared/entityClipboardTransfer.js';
import { collectSceneResourceReferences } from '../shared/sceneResourceTraversal.js';
import { authorizeAssetFile, decodeAssetUrl, encodeAssetUrl, normalizeFilePath } from './assetRegistry.js';
import { getCurrentDataPlatformBinding } from './dataPlatformBindingStore.js';
import { normalizeDataPlatformSourceUrl } from './dataPlatformEnvironmentContract.js';
import { createDataPlatformSourceKey } from './dataPlatformEnvironmentSync.js';
import { readDataPlatformConfig } from './dataPlatformIpc.js';
import { recoverLocalSceneResourcePaths } from './localSceneResourceRecovery.js';
import {
  getCurrentProjectRoot,
  getProjectModelsRoot,
  getSharedProjectAssetRoot,
  registerModelPackagesInProjectIndex,
  toSafePackageDirectoryName,
} from './projectAssetStore.js';
import { editorIpc } from './trustedEditorIpc.js';

const ALLOWED_CLIPBOARD_ASSET_EXTENSIONS = new Set([
  '.glb',
  '.gltf',
  '.bin',
  '.ts',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.gif',
  '.ktx2',
  '.dxf',
  '.json',
]);

const MAX_COPY_PACKAGE_ENTRIES = 4096;
const MAX_AUTHORIZE_PACKAGE_ENTRIES = 512;

export type TargetClipboardResourceContext = {
  projectRoot: string | null;
  workspaceRoot: string;
  sharedResourcesRoot: string | null;
  dataPlatformBaseUrl: string | null;
  dataPlatformProjectId: string | null;
  authorizeFile: (filePath: string) => void;
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pathKey(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isSamePath(left: string, right: string): boolean {
  return pathKey(left) === pathKey(right);
}

function isPathInsideRoot(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function isSafeClipboardAssetExtension(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.d.ts')) return false;
  return ALLOWED_CLIPBOARD_ASSET_EXTENSIONS.has(path.extname(lower));
}

async function computeFileSha256(filePath: string): Promise<string> {
  const content = await fs.readFile(filePath);
  return createHash('sha256').update(content).digest('hex');
}

async function resolveSafeRealDirectory(dirPath: string): Promise<string | null> {
  try {
    const resolved = path.resolve(dirPath);
    const [realPath, stat] = await Promise.all([fs.realpath(resolved), fs.lstat(resolved)]);
    if (!isSamePath(realPath, resolved) || stat.isSymbolicLink() || !stat.isDirectory()) return null;
    return realPath;
  } catch {
    return null;
  }
}

async function resolveSafeRealFile(filePath: string): Promise<string | null> {
  try {
    const resolved = path.resolve(filePath);
    const [realPath, stat] = await Promise.all([fs.realpath(resolved), fs.lstat(resolved)]);
    if (!isSamePath(realPath, resolved) || stat.isSymbolicLink() || !stat.isFile()) return null;
    return realPath;
  } catch {
    return null;
  }
}

/** 递归安全复制模型包目录：拒绝任何符号链接，且限制最大条目数。 */
async function copyValidatedDirectory(
  sourceRoot: string,
  targetRoot: string,
  state = { count: 0 },
): Promise<void> {
  const entries = await fs.readdir(sourceRoot, { withFileTypes: true });
  await fs.mkdir(targetRoot, { recursive: true });
  for (const entry of entries) {
    state.count += 1;
    if (state.count > MAX_COPY_PACKAGE_ENTRIES) {
      throw new Error(`模型包文件数量超过 ${MAX_COPY_PACKAGE_ENTRIES} 个限制。`);
    }
    if (entry.isSymbolicLink()) {
      throw new Error(`模型包包含不受支持的符号链接：${entry.name}`);
    }
    const sourceEntry = path.join(sourceRoot, entry.name);
    const targetEntry = path.join(targetRoot, entry.name);
    if (entry.isDirectory()) {
      await copyValidatedDirectory(sourceEntry, targetEntry, state);
    } else if (entry.isFile()) {
      await fs.copyFile(sourceEntry, targetEntry);
    }
  }
}

type InferredModelPackageInfo = {
  packageDir: string;
  isComboModel: boolean;
  packageName: string;
};

type CopyCrossProjectResult = {
  copiedModelPackageDirs: Set<string>;
  localizedSourcePathKeys: Set<string>;
};

function tryNormalizeBaseUrl(value: string | null): string | null {
  if (!value || !value.trim()) return null;
  try {
    return normalizeDataPlatformSourceUrl(value);
  } catch {
    return value.trim().replace(/\/+$/, '').toLowerCase();
  }
}

function tryResolveSourcePathKey(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  if (/^editor-asset:/i.test(value)) {
    try {
      return pathKey(decodeAssetUrl(value));
    } catch {
      return null;
    }
  }
  return path.isAbsolute(value) ? pathKey(value) : null;
}

/** 从文件路径直接推断所属 `Assets/Models/(ComboModels/)?<pkgDir>` 目录，不依赖源项目根目录。 */
export function inferLocalModelPackageInfo(filePath: string): InferredModelPackageInfo | null {
  const resolved = path.resolve(filePath);
  const normalized = resolved.replace(/\\/g, '/');
  const match = /^(.*\/Assets\/Models\/)(ComboModels\/)?([^/]+)(?:\/|$)/i.exec(normalized);
  if (!match) return null;
  const modelsPrefix = match[1];
  const comboSegment = match[2] ?? '';
  const packageName = match[3];
  if (!packageName || packageName === '.' || packageName === '..') return null;
  if (!comboSegment && packageName.toLowerCase() === 'combomodels') return null;
  return {
    packageDir: path.resolve(modelsPrefix + comboSegment + packageName),
    isComboModel: Boolean(comboSegment),
    packageName,
  };
}

/** 收集待拷贝源文件路径、原始序列化值及其所属实体名，用于跨项目路径映射。 */
function collectEntitySourcePaths(payload: CrossSceneEntityClipboardPayload): {
  paths: Set<string>;
  entityNameBySourcePath: Map<string, string>;
  rawValuesBySourceKey: Map<string, Set<string>>;
} {
  const paths = new Set<string>();
  const entityNameBySourcePath = new Map<string, string>();
  const rawValuesBySourceKey = new Map<string, Set<string>>();
  const recordPath = (value: unknown, entityName: string): void => {
    if (typeof value !== 'string' || !value.trim()) return;
    let resolved: string | null = null;
    if (/^editor-asset:/i.test(value)) {
      try {
        resolved = decodeAssetUrl(value);
      } catch {
        return;
      }
    } else if (path.isAbsolute(value)) {
      resolved = path.resolve(value);
    }
    if (!resolved) return;
    paths.add(resolved);
    const resolvedKey = pathKey(resolved);
    if (!entityNameBySourcePath.has(resolvedKey)) {
      entityNameBySourcePath.set(resolvedKey, entityName);
    }
    let rawSet = rawValuesBySourceKey.get(resolvedKey);
    if (!rawSet) {
      rawSet = new Set<string>();
      rawValuesBySourceKey.set(resolvedKey, rawSet);
    }
    rawSet.add(value);
  };

  for (const entry of payload.entries) {
    for (const entity of entry.entities) {
      const entityName = typeof entity.name === 'string' && entity.name.trim()
        ? entity.name.trim()
        : String(entity.id);
      const components = isPlainRecord(entity.components) ? entity.components : null;
      if (!components) continue;
      const singleEntityScene = { entities: { [String(entity.id)]: entity } };
      const refs = collectSceneResourceReferences(singleEntityScene, 'tolerant');
      for (const model of refs.models) {
        recordPath(model.asset.sourcePath, entityName);
        recordPath(model.asset.sourceUrl, entityName);
        recordPath(model.asset.packagePath, entityName);
        recordPath(model.asset.metadataPath, entityName);
        recordPath(model.asset.metaPath, entityName);
        recordPath(model.asset.metaUrl, entityName);
        recordPath(model.asset.thumbnailPath, entityName);
        recordPath(model.asset.thumbnailUrl, entityName);
        recordPath(model.target?.packagePath, entityName);
        recordPath(model.packageOwner?.packagePath, entityName);
        if (Array.isArray(model.asset.scriptPaths)) {
          for (const scriptPath of model.asset.scriptPaths) {
            recordPath(scriptPath, entityName);
          }
        }
        if (Array.isArray(model.asset.scriptAssets)) {
          for (const script of model.asset.scriptAssets) {
            if (isPlainRecord(script)) {
              recordPath(script.path, entityName);
              recordPath(script.sourceUrl, entityName);
            }
          }
        }
        if (Array.isArray(model.asset.variants)) {
          for (const variant of model.asset.variants) {
            if (isPlainRecord(variant)) {
              recordPath(variant.sourcePath, entityName);
              recordPath(variant.sourceUrl, entityName);
              recordPath(variant.url, entityName);
            }
          }
        }
      }
      for (const inspection of refs.inspections) {
        recordPath(inspection.model.sourcePath, entityName);
        recordPath(inspection.model.sourceUrl, entityName);
        recordPath(inspection.model.metaPath, entityName);
        recordPath(inspection.model.metaUrl, entityName);
      }
      for (const binding of refs.clickEventBindings) {
        recordPath(binding.deviceType.sourcePath, entityName);
        recordPath(binding.deviceType.sourceUrl, entityName);
        recordPath(binding.deviceType.thumbnailPath, entityName);
        recordPath(binding.deviceType.thumbnailUrl, entityName);
      }
      for (const cad of refs.cadReferences) {
        recordPath(cad.cad.sourcePath, entityName);
        recordPath(cad.cad.sourceUrl, entityName);
      }
      for (const effectModel of collectEffectModelReferences(singleEntityScene)) {
        recordPath(effectModel.sourcePath, entityName);
        recordPath(effectModel.sourceUrl, entityName);
      }
    }
  }
  return { paths, entityNameBySourcePath, rawValuesBySourceKey };
}

function recordMappedFileValues(
  sourceFile: string,
  mappedFile: string,
  rawValuesBySourceKey: ReadonlyMap<string, ReadonlySet<string>>,
  additionalMappings: Map<string, string>,
): void {
  const encodedTarget = encodeAssetUrl(mappedFile);
  additionalMappings.set(sourceFile, mappedFile);
  additionalMappings.set(encodeAssetUrl(sourceFile), encodedTarget);
  const forwardSource = sourceFile.replace(/\\/g, '/');
  if (forwardSource !== sourceFile) additionalMappings.set(forwardSource, mappedFile);
  for (const rawValue of rawValuesBySourceKey.get(pathKey(sourceFile)) ?? []) {
    if (/^editor-asset:/i.test(rawValue)) {
      additionalMappings.set(rawValue, encodedTarget);
      try {
        const parsed = new URL(rawValue);
        const decodedRaw = decodeURIComponent(parsed.pathname.slice(1));
        if (decodedRaw) additionalMappings.set(decodedRaw, mappedFile);
      } catch {
        // 忽略无效编码 URL
      }
    } else {
      additionalMappings.set(rawValue, mappedFile);
    }
  }
}

function findMappedTargetFile(
  value: unknown,
  additionalMappings: ReadonlyMap<string, string>,
): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  let mapped = additionalMappings.get(value);
  if (!mapped) {
    if (/^editor-asset:/i.test(value)) {
      try {
        const decoded = decodeAssetUrl(value);
        mapped = additionalMappings.get(decoded) ?? additionalMappings.get(encodeAssetUrl(decoded));
      } catch {
        mapped = undefined;
      }
    } else if (path.isAbsolute(value)) {
      mapped = additionalMappings.get(path.resolve(value));
    }
  }
  if (!mapped) return null;
  if (/^editor-asset:/i.test(mapped)) {
    try {
      return decodeAssetUrl(mapped);
    } catch {
      return null;
    }
  }
  return path.resolve(mapped);
}

/** 跨项目复制模型包（含 ComboModels 与独立 GLB）及 CAD 文件到目标项目目录并生成映射。 */
async function copyCrossProjectLocalPackages(
  targetProjectRoot: string | null,
  sharedResourcesRoot: string | null,
  isDifferentDataPlatformServer: boolean,
  sourcePaths: ReadonlySet<string>,
  rawValuesBySourceKey: ReadonlyMap<string, ReadonlySet<string>>,
  additionalMappings: Map<string, string>,
  warnings: string[],
): Promise<CopyCrossProjectResult> {
  const copiedModelPackageDirs = new Set<string>();
  const localizedSourcePathKeys = new Set<string>();
  if (!targetProjectRoot) {
    return { copiedModelPackageDirs, localizedSourcePathKeys };
  }

  const activeSharedRoots = !isDifferentDataPlatformServer && sharedResourcesRoot
    ? [sharedResourcesRoot]
    : [];

  const copiedPackageTargetBySourceDir = new Map<string, string>();
  const copiedPackageLabels = new Set<string>();
  const pendingPackageDirMappings: Array<{ rawPath: string; sourceDirKey: string }> = [];
  const targetModelsRoot = getProjectModelsRoot(targetProjectRoot);

  for (const sourceFile of sourcePaths) {
    if (isPathInsideRoot(targetProjectRoot, sourceFile)) continue;
    if (activeSharedRoots.some((root) => isPathInsideRoot(root, sourceFile))) continue;

    const packageInfo = inferLocalModelPackageInfo(sourceFile);
    if (packageInfo) {
      const realSourcePackageDir = await resolveSafeRealDirectory(packageInfo.packageDir);
      if (!realSourcePackageDir) continue;

      // packagePath 本身指向包根目录（无扩展名），先登记并在复制完成后统一写入映射，避免受遍历顺序影响。
      if (isSamePath(sourceFile, realSourcePackageDir)) {
        pendingPackageDirMappings.push({ rawPath: sourceFile, sourceDirKey: pathKey(realSourcePackageDir) });
        continue;
      }

      if (!isSafeClipboardAssetExtension(sourceFile)) continue;
      const realSourceFile = await resolveSafeRealFile(sourceFile);
      if (!realSourceFile) continue;

      const sourceDirKey = pathKey(realSourcePackageDir);
      let targetPackageDir = copiedPackageTargetBySourceDir.get(sourceDirKey);
      if (!targetPackageDir) {
        const targetLibraryDir = packageInfo.isComboModel
          ? path.join(targetModelsRoot, 'ComboModels')
          : targetModelsRoot;
        await fs.mkdir(targetLibraryDir, { recursive: true });

        const baseSafeName = toSafePackageDirectoryName(packageInfo.packageName);
        const targetBaseName = isDifferentDataPlatformServer && /^(?:model|combo|env|skybox)-\d+(?:-|$)/i.test(baseSafeName)
          ? `imported-${baseSafeName}`
          : baseSafeName;
        const sourceContentSha = await computeFileSha256(realSourceFile);
        const relFile = path.relative(realSourcePackageDir, realSourceFile);
        const tryReuseOrCreatePackageDir = async (dirPath: string): Promise<string | null> => {
          const realDir = await resolveSafeRealDirectory(dirPath);
          if (!realDir) {
            await copyValidatedDirectory(realSourcePackageDir, dirPath);
            return dirPath;
          }
          const existingFile = await resolveSafeRealFile(path.join(realDir, relFile));
          if (existingFile && (await computeFileSha256(existingFile)) === sourceContentSha) {
            return realDir;
          }
          return null;
        };

        targetPackageDir = await tryReuseOrCreatePackageDir(path.join(targetLibraryDir, targetBaseName)) ?? undefined;
        if (!targetPackageDir) {
          const dirHash = createHash('sha256').update(realSourcePackageDir).digest('hex').slice(0, 8);
          targetPackageDir = await tryReuseOrCreatePackageDir(
            path.join(targetLibraryDir, `${targetBaseName}-copied-${dirHash}`),
          ) ?? undefined;
        }
        if (!targetPackageDir) {
          targetPackageDir = await tryReuseOrCreatePackageDir(
            path.join(targetLibraryDir, `${targetBaseName}-copied-${sourceContentSha.slice(0, 8)}`),
          ) ?? undefined;
        }
        if (!targetPackageDir) {
          const uniqueHash = createHash('sha256')
            .update(`${realSourcePackageDir}:${sourceContentSha}`)
            .digest('hex')
            .slice(0, 12);
          const fallbackDir = path.join(targetLibraryDir, `${targetBaseName}-copied-${uniqueHash}`);
          if (!(await resolveSafeRealDirectory(fallbackDir))) {
            await copyValidatedDirectory(realSourcePackageDir, fallbackDir);
          }
          targetPackageDir = fallbackDir;
        }

        copiedPackageTargetBySourceDir.set(sourceDirKey, targetPackageDir);
        copiedModelPackageDirs.add(targetPackageDir);
        copiedPackageLabels.add(
          packageInfo.isComboModel ? `ComboModels/${path.basename(targetPackageDir)}` : path.basename(targetPackageDir),
        );
        additionalMappings.set(realSourcePackageDir, targetPackageDir);
        additionalMappings.set(packageInfo.packageDir, targetPackageDir);
      }

      const mappedFile = path.join(targetPackageDir, path.relative(realSourcePackageDir, realSourceFile));
      recordMappedFileValues(sourceFile, mappedFile, rawValuesBySourceKey, additionalMappings);
      localizedSourcePathKeys.add(pathKey(sourceFile));
      continue;
    }

    if (!isSafeClipboardAssetExtension(sourceFile)) continue;
    const ext = path.extname(sourceFile).toLowerCase();

    if (ext === '.glb') {
      const realSourceFile = await resolveSafeRealFile(sourceFile);
      if (!realSourceFile) continue;

      await fs.mkdir(targetModelsRoot, { recursive: true });
      const baseName = path.basename(realSourceFile);
      const safeStem = toSafePackageDirectoryName(path.basename(baseName, ext));
      const sourceContentSha = await computeFileSha256(realSourceFile);
      const dirHash = createHash('sha256').update(path.dirname(realSourceFile)).digest('hex').slice(0, 8);

      const tryReuseOrCreateStandaloneDir = async (dirPath: string): Promise<string | null> => {
        const targetFile = path.join(dirPath, baseName);
        const realDir = await resolveSafeRealDirectory(dirPath);
        if (!realDir) {
          await fs.mkdir(dirPath, { recursive: true });
          await fs.copyFile(realSourceFile, targetFile);
          return dirPath;
        }
        const existingFile = await resolveSafeRealFile(path.join(realDir, baseName));
        if (existingFile && (await computeFileSha256(existingFile)) === sourceContentSha) {
          return realDir;
        }
        return null;
      };

      let targetPkgDir = await tryReuseOrCreateStandaloneDir(
        path.join(targetModelsRoot, `${safeStem}-copied-${dirHash}`),
      );
      if (!targetPkgDir) {
        targetPkgDir = await tryReuseOrCreateStandaloneDir(
          path.join(targetModelsRoot, `${safeStem}-copied-${sourceContentSha.slice(0, 8)}`),
        );
      }
      if (!targetPkgDir) {
        const uniqueHash = createHash('sha256')
          .update(`${realSourceFile}:${sourceContentSha}`)
          .digest('hex')
          .slice(0, 12);
        const fallbackDir = path.join(targetModelsRoot, `${safeStem}-copied-${uniqueHash}`);
        if (!(await resolveSafeRealDirectory(fallbackDir))) {
          await fs.mkdir(fallbackDir, { recursive: true });
        }
        const fallbackFile = path.join(fallbackDir, baseName);
        if (!(await resolveSafeRealFile(fallbackFile))) {
          await fs.copyFile(realSourceFile, fallbackFile);
        }
        targetPkgDir = fallbackDir;
      }

      const targetGlbFile = path.join(targetPkgDir, baseName);
      copiedModelPackageDirs.add(targetPkgDir);
      copiedPackageLabels.add(path.basename(targetPkgDir));
      localizedSourcePathKeys.add(pathKey(sourceFile));
      recordMappedFileValues(sourceFile, targetGlbFile, rawValuesBySourceKey, additionalMappings);
      continue;
    }

    // CAD 参考图跨项目复制（不依赖 sourceContext.projectRoot）
    if (ext === '.dxf') {
      const realSourceFile = await resolveSafeRealFile(sourceFile);
      if (!realSourceFile) continue;
      const targetCadRoot = path.join(path.resolve(targetProjectRoot), 'Assets', 'Cad');
      await fs.mkdir(targetCadRoot, { recursive: true });
      const baseName = path.basename(realSourceFile);
      const sourceContentSha = await computeFileSha256(realSourceFile);
      const tryReuseOrCopyCadFile = async (candidateFile: string): Promise<string | null> => {
        const existingCadReal = await resolveSafeRealFile(candidateFile);
        if (!existingCadReal) {
          await fs.copyFile(realSourceFile, candidateFile);
          return candidateFile;
        }
        if ((await computeFileSha256(existingCadReal)) === sourceContentSha) {
          return existingCadReal;
        }
        return null;
      };

      const stem = path.basename(baseName, ext);
      let targetCadFile = await tryReuseOrCopyCadFile(path.join(targetCadRoot, baseName));
      if (!targetCadFile) {
        const pathHash = createHash('sha256').update(realSourceFile).digest('hex').slice(0, 8);
        targetCadFile = await tryReuseOrCopyCadFile(path.join(targetCadRoot, `${stem}-copied-${pathHash}${ext}`));
      }
      if (!targetCadFile) {
        const fallbackCadFile = path.join(targetCadRoot, `${stem}-copied-${sourceContentSha.slice(0, 8)}${ext}`);
        if (!(await resolveSafeRealFile(fallbackCadFile))) {
          await fs.copyFile(realSourceFile, fallbackCadFile);
        }
        targetCadFile = fallbackCadFile;
      }
      localizedSourcePathKeys.add(pathKey(sourceFile));
      recordMappedFileValues(sourceFile, targetCadFile, rawValuesBySourceKey, additionalMappings);
    }
  }

  for (const pending of pendingPackageDirMappings) {
    const mappedPkg = copiedPackageTargetBySourceDir.get(pending.sourceDirKey);
    if (!mappedPkg) continue;
    additionalMappings.set(pending.rawPath, mappedPkg);
    additionalMappings.set(encodeAssetUrl(pending.rawPath), encodeAssetUrl(mappedPkg));
    for (const rawValue of rawValuesBySourceKey.get(pathKey(pending.rawPath)) ?? []) {
      additionalMappings.set(rawValue, /^editor-asset:/i.test(rawValue) ? encodeAssetUrl(mappedPkg) : mappedPkg);
    }
  }

  for (const pkgLabel of copiedPackageLabels) {
    warnings.push(`已将跨项目模型包「${pkgLabel}」复制到当前项目 Assets/Models。`);
  }

  return { copiedModelPackageDirs, localizedSourcePathKeys };
}

function stripForeignDataPlatformBindings(
  payload: CrossSceneEntityClipboardPayload,
  localizedSourcePathKeys: ReadonlySet<string>,
): void {
  if (localizedSourcePathKeys.size === 0) return;
  const isLocalized = (obj: Record<string, unknown>): boolean => {
    const pKey = tryResolveSourcePathKey(obj.sourcePath);
    if (pKey && localizedSourcePathKeys.has(pKey)) return true;
    const uKey = tryResolveSourcePathKey(obj.sourceUrl);
    return Boolean(uKey && localizedSourcePathKeys.has(uKey));
  };

  for (const entry of payload.entries) {
    for (const entity of entry.entities) {
      const singleEntityScene = { entities: { [String(entity.id)]: entity } };
      const refs = collectSceneResourceReferences(singleEntityScene, 'tolerant');
      for (const model of refs.models) {
        if (isLocalized(model.asset)) {
          delete model.asset.dataPlatformModel;
          delete model.asset.sourceSnapshot;
        }
      }
      for (const binding of refs.clickEventBindings) {
        if (isLocalized(binding.deviceType)) {
          delete binding.deviceType.dataPlatformModel;
        }
      }
      for (const effectModel of collectEffectModelReferences(singleEntityScene)) {
        if (isLocalized(effectModel)) {
          delete effectModel.identity;
        }
      }
    }
  }
}

/** 授权已校验模型包内的安全贴图、脚本和辅助文件，确保参数化贴图可正常加载。 */
async function authorizeSiblingPackageAssets(
  resolvedFile: string,
  authorizeFile: (filePath: string) => void,
): Promise<void> {
  const normalized = path.resolve(resolvedFile).replace(/\\/g, '/');
  const match = /^(.*\/Assets\/Models\/(?:ComboModels\/)?[^/]+)(?:\/|$)/i.exec(normalized);
  if (!match) return;
  const packageRoot = path.resolve(match[1]);
  const realRoot = await resolveSafeRealDirectory(packageRoot);
  if (!realRoot) return;

  const queue: Array<{ dir: string; depth: number }> = [{ dir: realRoot, depth: 0 }];
  let seen = 0;
  while (queue.length > 0) {
    const current = queue.shift()!;
    const entries = await fs.readdir(current.dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      seen += 1;
      if (seen > MAX_AUTHORIZE_PACKAGE_ENTRIES) return;
      if (entry.isSymbolicLink()) continue;
      const entryPath = path.join(current.dir, entry.name);
      if (entry.isDirectory()) {
        if (current.depth < 3) queue.push({ dir: entryPath, depth: current.depth + 1 });
      } else if (entry.isFile() && isSafeClipboardAssetExtension(entryPath)) {
        authorizeFile(entryPath);
      }
    }
  }
}

/**
 * 为目标编辑器上下文准备跨场景剪贴板载荷：
 * 1. 同项目或同数据中台共享库：校验真实文件与模型结构后自动授权 `editor-asset://` 读取；
 * 2. 不同工作区/本地项目：尝试按共享库匹配或将源模型包安全复制到目标项目 `Assets/Models`；
 * 3. 缺失或非法文件：不予授权并在 `missingResources` / `warnings` 中明确报告。
 */
export async function prepareCrossSceneClipboardForTarget(
  payload: CrossSceneEntityClipboardPayload,
  context: TargetClipboardResourceContext,
): Promise<ReadEntityClipboardResult> {
  const cloned = parseEntityClipboardPayload(JSON.stringify(payload));
  if (!cloned) {
    return {
      available: false,
      payload: null,
      warnings: ['系统剪贴板中的实体数据格式无效。'],
      missingResources: [],
      projectAssetsUpdated: false,
    };
  }

  const warnings: string[] = [];
  const missingResources: ClipboardMissingResourceIssue[] = [];
  const { paths: sourcePaths, entityNameBySourcePath, rawValuesBySourceKey } = collectEntitySourcePaths(cloned);
  const additionalMappings = new Map<string, string>();

  const normalizedSourceBaseUrl = tryNormalizeBaseUrl(cloned.sourceContext.dataPlatformBaseUrl);
  const normalizedTargetBaseUrl = tryNormalizeBaseUrl(context.dataPlatformBaseUrl);
  const isDifferentDataPlatformServer = Boolean(
    normalizedSourceBaseUrl && normalizedTargetBaseUrl && normalizedSourceBaseUrl !== normalizedTargetBaseUrl,
  );

  let copyResult: CopyCrossProjectResult = {
    copiedModelPackageDirs: new Set(),
    localizedSourcePathKeys: new Set(),
  };

  try {
    copyResult = await copyCrossProjectLocalPackages(
      context.projectRoot,
      context.sharedResourcesRoot,
      isDifferentDataPlatformServer,
      sourcePaths,
      rawValuesBySourceKey,
      additionalMappings,
      warnings,
    );
  } catch (error) {
    warnings.push(`跨项目复制模型包时出错：${error instanceof Error ? error.message : String(error)}`);
  }

  if (isDifferentDataPlatformServer) {
    if (copyResult.localizedSourcePathKeys.size > 0) {
      stripForeignDataPlatformBindings(cloned, copyResult.localizedSourcePathKeys);
      warnings.push('剪贴板模型来自不同的数据中台服务，已将其本地化复制到当前项目 Assets/Models 并移除原中台绑定，请检查模型版本与大屏绑定。');
    } else {
      warnings.push('剪贴板模型来自不同的数据中台服务，请检查模型版本与大屏绑定。');
    }
  }

  const allEntities: Record<string, Record<string, unknown>> = {};
  const entityIds: string[] = [];
  for (const entry of cloned.entries) {
    for (const entity of entry.entities) {
      const id = String(entity.id);
      allEntities[id] = entity;
      entityIds.push(id);
    }
  }

  const minimalSceneEnvelope = JSON.stringify({
    version: CURRENT_SCENE_FILE_VERSION,
    scene: {
      entities: allEntities,
      entityIds,
      sceneSettings: { lighting: { version: 2 } },
    },
  });

  const sourceKey = context.dataPlatformBaseUrl
    ? createDataPlatformSourceKey(context.dataPlatformBaseUrl)
    : null;
  const managedRoots = [
    context.projectRoot,
    context.sharedResourcesRoot,
  ].filter((root): root is string => Boolean(root));

  const mappedSourceKeys = new Set<string>();
  for (const key of additionalMappings.keys()) {
    if (!/^editor-asset:/i.test(key)) mappedSourceKeys.add(pathKey(key));
  }

  const recovery = await recoverLocalSceneResourcePaths({
    sceneContent: minimalSceneEnvelope,
    workspaceRoot: context.workspaceRoot,
    projectRoot: context.projectRoot,
    sourceKey,
    additionalMappings,
    isOriginalPathAllowed: (filePath) =>
      !mappedSourceKeys.has(pathKey(filePath)) && isSafeClipboardAssetExtension(filePath),
  });

  const recoveredEnvelope = JSON.parse(recovery.sceneContent) as {
    scene: { entities: Record<string, Record<string, unknown>> };
  };

  for (const effectModel of collectEffectModelReferences(recoveredEnvelope)) {
    const mappedFile =
      findMappedTargetFile(effectModel.sourcePath, additionalMappings)
      ?? findMappedTargetFile(effectModel.sourceUrl, additionalMappings);
    if (!mappedFile) continue;
    if (typeof effectModel.sourcePath === 'string') {
      effectModel.sourcePath = mappedFile;
    }
    if (typeof effectModel.sourceUrl === 'string') {
      effectModel.sourceUrl = encodeAssetUrl(mappedFile);
    }
  }

  for (const entry of cloned.entries) {
    entry.entities = entry.entities.map((entity) => recoveredEnvelope.scene.entities[String(entity.id)] ?? entity);
  }

  let hasExternalProjectReference = false;
  for (const resolvedFile of recovery.resolvedFiles) {
    if (!isSafeClipboardAssetExtension(resolvedFile)) {
      warnings.push(`已跳过不受支持类型的剪贴板资源：${path.basename(resolvedFile)}`);
      continue;
    }
    context.authorizeFile(resolvedFile);
    await authorizeSiblingPackageAssets(resolvedFile, context.authorizeFile);
    if (context.projectRoot && !managedRoots.some((root) => isPathInsideRoot(root, resolvedFile))) {
      hasExternalProjectReference = true;
    }
  }

  if (hasExternalProjectReference) {
    warnings.push('部分粘贴模型仍引用当前项目目录外的文件，保存或发布前建议导入当前项目。');
  }

  let projectAssetsUpdated = false;
  if (context.projectRoot && copyResult.copiedModelPackageDirs.size > 0) {
    try {
      const registeredCount = await registerModelPackagesInProjectIndex(
        context.projectRoot,
        [...copyResult.copiedModelPackageDirs],
      );
      projectAssetsUpdated = registeredCount > 0;
    } catch (error) {
      warnings.push(`登记跨项目模型到项目资产库失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  for (const issue of recovery.issues) {
    const sourcePath = issue.sourcePath ?? '';
    const entityName = (sourcePath && entityNameBySourcePath.get(pathKey(sourcePath))) || '未知对象';
    missingResources.push({
      entityName,
      sourcePath,
      reason: issue.message,
    });
  }
  if (missingResources.length > 0) {
    warnings.push(`有 ${missingResources.length} 项模型或脚本资源缺失/校验失败，对应对象可能无法正常显示。`);
  }

  return {
    available: true,
    payload: cloned,
    warnings,
    missingResources,
    projectAssetsUpdated,
  };
}

function validateWriteEntityClipboardRequest(request: WriteEntityClipboardRequest): CrossSceneEntityClipboardPayload {
  if (!isPlainRecord(request) || !isPlainRecord(request.payload)) {
    throw new Error('写入实体剪贴板请求格式不正确。');
  }
  const parsed = parseEntityClipboardPayload(JSON.stringify(request.payload));
  if (!parsed) {
    throw new Error('跨场景剪贴板载荷格式无效。');
  }
  return parsed;
}

/** 注册跨场景/跨编辑器系统剪贴板受控 IPC。 */
export function registerEntityClipboardIpc(): void {
  editorIpc.handle('clipboard:writeEntities', async (_event, request: WriteEntityClipboardRequest): Promise<WriteEntityClipboardResult> => {
    const validated = validateWriteEntityClipboardRequest(request);
    const binding = getCurrentDataPlatformBinding();
    const config = await readDataPlatformConfig().catch(() => null);
    const enriched: CrossSceneEntityClipboardPayload = {
      ...validated,
      sourceContext: {
        ...validated.sourceContext,
        projectRoot: getCurrentProjectRoot() ?? validated.sourceContext.projectRoot,
        dataPlatformBaseUrl: binding?.metadata.baseUrl ?? (config?.baseUrl || null) ?? validated.sourceContext.dataPlatformBaseUrl,
        dataPlatformProjectId: binding?.metadata.projectId ?? validated.sourceContext.dataPlatformProjectId,
      },
    };
    const buffer = serializeEntityClipboardPayload(enriched);
    clipboard.writeBuffer(ENTITY_CLIPBOARD_FORMAT, buffer);
    return { ok: true, byteLength: buffer.byteLength };
  });

  editorIpc.handle('clipboard:hasEntities', (): boolean => {
    return clipboard.has(ENTITY_CLIPBOARD_FORMAT);
  });

  editorIpc.handle('clipboard:readEntities', async (): Promise<ReadEntityClipboardResult> => {
    if (!clipboard.has(ENTITY_CLIPBOARD_FORMAT)) {
      return { available: false, payload: null, warnings: [], missingResources: [], projectAssetsUpdated: false };
    }
    const raw = clipboard.readBuffer(ENTITY_CLIPBOARD_FORMAT);
    const parsed = parseEntityClipboardPayload(raw);
    if (!parsed) {
      return {
        available: false,
        payload: null,
        warnings: ['系统剪贴板中的实体数据已损坏或版本不兼容。'],
        missingResources: [],
        projectAssetsUpdated: false,
      };
    }

    const config = await readDataPlatformConfig();
    const binding = getCurrentDataPlatformBinding();
    return prepareCrossSceneClipboardForTarget(parsed, {
      projectRoot: getCurrentProjectRoot(),
      workspaceRoot: config.workspaceRoot,
      sharedResourcesRoot: getSharedProjectAssetRoot(),
      dataPlatformBaseUrl: binding?.metadata.baseUrl ?? (config.baseUrl || null),
      dataPlatformProjectId: binding?.metadata.projectId ?? null,
      authorizeFile: (filePath) => authorizeAssetFile(normalizeFilePath(filePath)),
    });
  });
}
