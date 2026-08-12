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
import type { DeploymentSkyboxCacheContext, DeploymentSkyboxValidationCache } from './deploymentSkyboxCache.js';

const COPY_CONCURRENCY = 4;
const MAX_DIST_PACKAGE_BYTES = 2 * 1024 * 1024 * 1024;
const GENERATED_TEMPLATE_PATHS = new Set([
  'README.md',
  'runtime-config.json',
  'project/scene.json',
  'project/asset-manifest.json',
]);

export type BuildDigitalTwinDistPackageOptions = {
  projectId: string;
  publishName: string;
  sceneContent: string;
  outputRoot: string;
  signal: AbortSignal;
  skyboxCacheContext?: DeploymentSkyboxCacheContext;
  skyboxValidationCache?: DeploymentSkyboxValidationCache;
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
};

/** 静默生成供数据中台部署的自包含 Viewer ZIP，压缩包根目录直接包含 index.html。 */
export async function buildDigitalTwinDistPackage(
  options: BuildDigitalTwinDistPackageOptions,
): Promise<DigitalTwinDistPackageResult> {
  throwIfDeploymentExportAborted(options.signal);
  const outputRoot = path.resolve(options.outputRoot);
  await fs.mkdir(outputRoot, { recursive: true });
  const token = randomUUID();
  const stagingRoot = path.join(outputRoot, `.digital-twin-dist-staging-${token}`);
  const fileName = `digital-twin-dist-${options.projectId}.zip`;
  const archivePath = path.join(outputRoot, fileName);
  await fs.mkdir(stagingRoot, { recursive: false });

  try {
    options.onProgress?.('正在检查 Viewer 模板…', 3);
    const templateFiles = await createTemplateCopyPlan(resolveViewerTemplateRoot(), [stagingRoot, archivePath], options.signal);
    const prepared = await prepareDeploymentExport(
      options.sceneContent,
      options.publishName,
      [stagingRoot, archivePath],
      options.signal,
      (detail) => options.onProgress?.(detail, 8),
      {
        skipCadReferences: true,
        skyboxCacheContext: options.skyboxCacheContext,
        skyboxValidationCache: options.skyboxValidationCache,
      },
    );
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

    options.onProgress?.('正在生成项目级运行配置入口…', 80);
    await writeGeneratedFiles(stagingRoot, prepared, copiedAssets, options.projectId, options.signal);
    options.onProgress?.('正在压缩 dist ZIP…', 86);
    await archiveDirectoryContents(stagingRoot, archivePath, options.signal);
    const stat = await fs.stat(archivePath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_DIST_PACKAGE_BYTES) {
      throw new Error('dist ZIP 大小无效或超过 2 GB 限制。');
    }
    options.onProgress?.('dist ZIP 已生成。', 100);
    return {
      filePath: archivePath,
      fileName,
      fileSize: stat.size,
      sha256: await sha256File(archivePath, options.signal),
      fileCount: templateFiles.length + copiedAssets.length + GENERATED_TEMPLATE_PATHS.size,
      externalAssetCount: prepared.externalAssetCount,
      warnings: prepared.warnings,
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
): Promise<void> {
  throwIfDeploymentExportAborted(signal);
  const runtimeConfig = JSON.parse(prepared.runtimeConfigContent) as Record<string, unknown>;
  runtimeConfig.version = 2;
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
