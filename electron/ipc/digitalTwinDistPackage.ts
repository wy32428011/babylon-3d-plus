import { ZipArchive } from 'archiver';
import { app } from 'electron';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';
import {
  copyDeploymentFiles,
  resolveDeploymentDestination,
  scanSafeSourceRoot,
  throwIfDeploymentExportAborted,
  toDeploymentPath,
  type DeploymentCopiedFile,
  type DeploymentCopyFile,
} from './deploymentExportFileSystem.js';
import { createAssetManifestContent, prepareDeploymentExport } from './deploymentExportScene.js';
import { precompressDeploymentFiles, type DeploymentPrecompressionResult } from './deploymentPrecompression.js';
import { writePrecompiledDeploymentScripts } from './deploymentPrecompiledScripts.js';
import { createDeploymentReleaseCacheManifest, RELEASE_CACHE_MANIFEST_PATH } from './deploymentReleaseCacheManifest.js';
import type { DeploymentSkyboxCacheContext, DeploymentSkyboxValidationCache } from './deploymentSkyboxCache.js';
import { bindSourceResourceIntegrity, type SourceResourceFile } from './digitalTwinSourceResourcePlan.js';
import { assertViewerCoreIntegrity, assertViewerTemplateSupportsScene, selectRuntimeTemplateFiles } from './viewerTemplateCapabilities.js';

const COPY_CONCURRENCY = 4;
const MAX_DIST_PACKAGE_BYTES = 2 * 1024 * 1024 * 1024;
const GENERATED_TEMPLATE_PATHS = new Set([
  'README.md',
  'runtime-config.json',
  'project/scene.json',
  'project/asset-manifest.json',
  RELEASE_CACHE_MANIFEST_PATH,
]);

export type BuildDigitalTwinDistPackageOptions = {
  projectId: string;
  publishName: string;
  sceneContent: string;
  outputRoot: string;
  signal: AbortSignal;
  skyboxCacheContext?: DeploymentSkyboxCacheContext;
  skyboxValidationCache?: DeploymentSkyboxValidationCache;
  sourceResourceFiles?: readonly SourceResourceFile[];
  /** 内部验收开关，默认生成可选传输侧车；不改变原文件或缓存清单。 */
  precompress?: boolean;
  /** 仅允许收紧原有 ZIP 上限，供近上限回退验证使用。 */
  maxPackageBytes?: number;
  onProgress?: (detail: string, percent: number) => void;
};

export type DigitalTwinDistPackageResult = {
  filePath: string;
  fileName: string;
  fileSize: number;
  sha256: string;
  fileCount: number;
  externalAssetCount: number;
  warnings: string[];
  precompression?: { generatedFiles: number; zipBudgetFallback: boolean; budget: DeploymentPrecompressionResult['budget'] };
};

/** 静默生成供数据中台部署的自包含 Viewer ZIP，压缩包根目录直接包含 index.html。 */
export async function buildDigitalTwinDistPackage(
  options: BuildDigitalTwinDistPackageOptions,
): Promise<DigitalTwinDistPackageResult> {
  throwIfDeploymentExportAborted(options.signal);
  const maxPackageBytes = options.maxPackageBytes ?? MAX_DIST_PACKAGE_BYTES;
  if (!Number.isSafeInteger(maxPackageBytes) || maxPackageBytes <= 0 || maxPackageBytes > MAX_DIST_PACKAGE_BYTES) {
    throw new Error('dist ZIP 验收预算无效；不能扩大原有 2 GB 限制。');
  }
  const outputRoot = path.resolve(options.outputRoot);
  await fs.mkdir(outputRoot, { recursive: true });
  const token = randomUUID();
  const stagingRoot = path.join(outputRoot, `.digital-twin-dist-staging-${token}`);
  const fileName = `digital-twin-dist-${options.projectId}.zip`;
  const archivePath = path.join(outputRoot, fileName);
  await fs.mkdir(stagingRoot, { recursive: false });

  try {
    options.onProgress?.('正在检查 Viewer 模板…', 3);
    let templateFiles = await createTemplateCopyPlan(resolveViewerTemplateRoot(), [stagingRoot, archivePath], options.signal);
    await assertViewerCoreIntegrity(templateFiles, options.signal);
    const prepared = await prepareDeploymentExport(
      options.sceneContent,
      options.publishName,
      [stagingRoot, archivePath],
      options.signal,
      (detail) => options.onProgress?.(detail, 8),
      {
        skipCadReferences: true,
        validateOpeningViewer: content => assertViewerTemplateSupportsScene(content, templateFiles, options.signal),
        skyboxCacheContext: options.skyboxCacheContext,
        skyboxValidationCache: options.skyboxValidationCache,
      },
    );
    templateFiles = await selectRuntimeTemplateFiles(templateFiles, options.signal);
    if (options.sourceResourceFiles) prepared.assetFiles = bindSourceResourceIntegrity(prepared.assetFiles, options.sourceResourceFiles);
    assertNoCopyPlanCollisions(templateFiles, prepared.assetFiles);

    options.onProgress?.('正在复制 Viewer 模板…', 12);
    await copyDeploymentFiles(templateFiles, stagingRoot, COPY_CONCURRENCY, options.signal, (progress) => {
      const ratio = progress.totalBytes > 0 ? progress.completedBytes / progress.totalBytes : 1;
      options.onProgress?.('正在复制 Viewer 模板…', 12 + ratio * 22);
    });

    options.onProgress?.('正在复制场景资源并计算哈希…', 36);
    const copiedAssets = await copyDeploymentFiles(
      prepared.assetFiles,
      stagingRoot,
      COPY_CONCURRENCY,
      options.signal,
      (progress) => {
        const ratio = progress.totalBytes > 0 ? progress.completedBytes / progress.totalBytes : 1;
        options.onProgress?.('正在复制场景资源并计算哈希…', 36 + ratio * 42);
      },
    );

    copiedAssets.push(...await writePrecompiledDeploymentScripts(stagingRoot, prepared.precompiledScripts, copiedAssets, options.signal));
    options.onProgress?.('正在生成项目级运行配置入口…', 80);
    const cacheRevision = await writeGeneratedFiles(stagingRoot, prepared, copiedAssets, options.projectId, options.signal);
    options.onProgress?.('正在生成发布资源缓存清单…', 83);
    const cacheManifest = await createDeploymentReleaseCacheManifest(stagingRoot, cacheRevision, options.signal);
    await fs.writeFile(resolveDeploymentDestination(stagingRoot, RELEASE_CACHE_MANIFEST_PATH),
      `${JSON.stringify(cacheManifest, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', signal: options.signal });
    let precompression: DeploymentPrecompressionResult | undefined;
    if (options.precompress !== false) {
      options.onProgress?.('正在生成可选传输压缩文件…', 84);
      precompression = await precompressDeploymentFiles(stagingRoot, cacheManifest, options.signal, {
        onProgress: progress => options.onProgress?.('正在生成可选传输压缩文件…',
          progress.phase === 'compressing' ? 84 + progress.completed / Math.max(1, progress.total) : 85),
      });
      prepared.warnings.push(...precompression.diagnostics);
    }
    options.onProgress?.('正在压缩 dist ZIP…', 86);
    await archiveDirectoryContents(stagingRoot, archivePath, options.signal);
    let stat = await fs.stat(archivePath);
    let zipBudgetFallback = false;
    if (stat.size > maxPackageBytes && precompression?.files.length) {
      // ZIP 自身有条目元数据开销；可选侧车不得使原本可发布的包越过既有上传上限。
      for (const file of precompression.files) {
        throwIfDeploymentExportAborted(options.signal);
        await fs.rm(resolveDeploymentDestination(stagingRoot, file.path));
      }
      await fs.rm(archivePath);
      throwIfDeploymentExportAborted(options.signal);
      options.onProgress?.('传输压缩文件触及 ZIP 上限，正在回退原包…', 90);
      await archiveDirectoryContents(stagingRoot, archivePath, options.signal);
      stat = await fs.stat(archivePath);
      zipBudgetFallback = true;
      precompression.budget.finalBytes = precompression.budget.originalBytes;
      precompression.budget.finalFiles = precompression.budget.originalFiles;
      precompression.budget.finalEntries = precompression.budget.originalEntries;
      prepared.warnings.push('可选传输侧车触及 ZIP 大小预算，已回退原包；原文件与缓存清单未改动。');
    }
    if (!stat.isFile() || stat.size <= 0 || stat.size > maxPackageBytes) {
      throw new Error('dist ZIP 大小无效或超过 2 GB 限制。');
    }
    options.onProgress?.('dist ZIP 已生成。', 100);
    return {
      filePath: archivePath,
      fileName,
      fileSize: stat.size,
      sha256: await sha256File(archivePath, options.signal),
      fileCount: templateFiles.length + copiedAssets.length + GENERATED_TEMPLATE_PATHS.size
        + (zipBudgetFallback ? 0 : precompression?.files.length ?? 0),
      externalAssetCount: prepared.externalAssetCount,
      warnings: prepared.warnings,
      ...(precompression ? { precompression: { generatedFiles: zipBudgetFallback ? 0 : precompression.files.length,
        zipBudgetFallback, budget: precompression.budget } } : {}),
    };
  } catch (error) {
    await fs.rm(archivePath, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    await fs.rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

function resolveViewerTemplateRoot(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'export-viewer')
    : path.join(app.getAppPath(), 'dist-viewer-template');
}

async function createTemplateCopyPlan(
  templateRoot: string,
  forbiddenOutputPaths: string[],
  signal: AbortSignal,
): Promise<DeploymentCopyFile[]> {
  const templateFiles = await scanSafeSourceRoot(templateRoot, null, forbiddenOutputPaths, signal);
  const plans: DeploymentCopyFile[] = [];
  for (const file of templateFiles) {
    const relativePath = toDeploymentPath(file.relativePath);
    if (GENERATED_TEMPLATE_PATHS.has(relativePath)) continue;
    if (relativePath === 'project/assets' || relativePath.startsWith('project/assets/')) {
      throw new Error('Viewer 模板不能预置 project/assets 文件。');
    }
    plans.push({ ...file, destinationRelativePath: relativePath, kind: 'asset' });
  }
  return plans;
}

function assertNoCopyPlanCollisions(templateFiles: DeploymentCopyFile[], assetFiles: DeploymentCopyFile[]): void {
  const destinations = new Set<string>();
  for (const file of [...templateFiles, ...assetFiles]) {
    const key = toDeploymentPath(file.destinationRelativePath).toLowerCase();
    if (destinations.has(key)) throw new Error(`dist 文件目标冲突：${file.destinationRelativePath}`);
    destinations.add(key);
  }
}

async function writeGeneratedFiles(
  stagingRoot: string,
  prepared: Awaited<ReturnType<typeof prepareDeploymentExport>>,
  copiedAssets: DeploymentCopiedFile[],
  projectId: string,
  signal: AbortSignal,
): Promise<string> {
  throwIfDeploymentExportAborted(signal);
  const runtimeConfig = JSON.parse(prepared.runtimeConfigContent) as Record<string, unknown>;
  runtimeConfig.version = 2;
  runtimeConfig.cacheManifest = RELEASE_CACHE_MANIFEST_PATH;
  runtimeConfig.digitalTwin = {
    projectId,
    runtimeConfigEndpoint: '/api/v1/digital-twin/runtime-config/detail',
  };
  const files = [
    { relativePath: 'runtime-config.json', content: `${JSON.stringify(runtimeConfig, null, 2)}\n` },
    { relativePath: 'README.md', content: prepared.readmeContent },
    { relativePath: 'project/scene.json', content: prepared.sceneContent },
    { relativePath: 'project/asset-manifest.json', content: createAssetManifestContent(copiedAssets) },
  ];
  for (const file of files) {
    throwIfDeploymentExportAborted(signal);
    const destination = resolveDeploymentDestination(stagingRoot, file.relativePath);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, file.content, { encoding: 'utf8', flag: 'wx' });
  }
  if (typeof runtimeConfig.cacheRevision !== 'string') throw new Error('发布运行配置缺少缓存版本标识。');
  return runtimeConfig.cacheRevision;
}

async function archiveDirectoryContents(stagingRoot: string, archivePath: string, signal: AbortSignal): Promise<void> {
  throwIfDeploymentExportAborted(signal);
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
      output.destroy(new Error('数字孪生 dist 打包已取消。'));
      settle(new Error('数字孪生 dist 打包已取消。'));
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
  throwIfDeploymentExportAborted(signal);
}

async function sha256File(filePath: string, signal: AbortSignal): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(filePath);
  for await (const chunk of stream) {
    throwIfDeploymentExportAborted(signal);
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}
