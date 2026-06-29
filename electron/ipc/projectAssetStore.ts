import { app, dialog } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type {
  AssetEntry,
  ImportModelFolderSkippedEntry,
  ProjectAssetIndex,
  ProjectListAssetsResult,
} from '../types.js';
import { DEFAULT_MODEL_LENGTH_UNIT_INFO, normalizeModelLengthUnit } from '../modelUnits.js';
import {
  authorizeAssetFile,
  authorizeAssetRoot,
  encodeAssetUrl,
  normalizeFilePath,
} from './assetRegistry.js';
import { scanModelPackage } from './modelPackageScanner.js';

const PROJECT_METADATA_DIRECTORY = '.babylon-editor';
const PROJECT_ASSET_INDEX_FILE = 'asset-index.json';
const PROJECT_ASSETS_DIRECTORY = 'Assets';
const PROJECT_MODELS_DIRECTORY = 'Models';
const RECENT_PROJECT_FILE = 'recent-project.json';
const PROJECT_ASSET_INDEX_ERROR = '项目资产索引格式不正确。';

let currentProjectRoot: string | null = null;
let hasLoadedRecentProjectRoot = false;

type ImportModelPackagesIntoProjectResult = {
  assets: AssetEntry[];
  skipped: ImportModelFolderSkippedEntry[];
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}

function getRecentProjectFilePath(): string {
  return path.join(app.getPath('userData'), RECENT_PROJECT_FILE);
}

async function loadRecentProjectRoot(): Promise<string | null> {
  if (currentProjectRoot) return currentProjectRoot;
  if (hasLoadedRecentProjectRoot) return null;

  hasLoadedRecentProjectRoot = true;

  try {
    const content = await fs.readFile(getRecentProjectFilePath(), 'utf-8');
    const parsed = JSON.parse(content) as unknown;

    if (!isPlainObject(parsed) || typeof parsed.projectRoot !== 'string' || !parsed.projectRoot.trim()) {
      return null;
    }

    const recentProjectRoot = normalizeFilePath(parsed.projectRoot);
    setCurrentProjectRoot(recentProjectRoot);
    await ensureProjectDirectories(recentProjectRoot);
    authorizeAssetRoot(getProjectModelsRoot(recentProjectRoot));
    return recentProjectRoot;
  } catch {
    return null;
  }
}

async function persistCurrentProjectRoot(projectRoot: string): Promise<void> {
  await fs.mkdir(path.dirname(getRecentProjectFilePath()), { recursive: true });
  await fs.writeFile(getRecentProjectFilePath(), JSON.stringify({ projectRoot }, null, 2), 'utf-8');
}

function assertString(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error(PROJECT_ASSET_INDEX_ERROR);
  }

  return value;
}

function normalizeOptionalPath(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return normalizeFilePath(assertString(value));
}

function normalizeOptionalStringArray(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(PROJECT_ASSET_INDEX_ERROR);
  }

  return value.map((item) => normalizeFilePath(item));
}

function normalizeIndexedAsset(value: unknown): AssetEntry | null {
  const asset = isPlainObject(value) ? value : null;
  if (!asset) throw new Error(PROJECT_ASSET_INDEX_ERROR);

  if (asset.kind !== 'model') return null;

  const modelPath = normalizeFilePath(assertString(asset.path));
  const name = assertString(asset.name);
  const packagePath = normalizeOptionalPath(asset.packagePath);
  const metadataPath = normalizeOptionalPath(asset.metadataPath);
  const scriptPaths = normalizeOptionalStringArray(asset.scriptPaths);
  const unitInfo = normalizeModelLengthUnit(asset.lengthUnit) ?? DEFAULT_MODEL_LENGTH_UNIT_INFO;

  return {
    id: modelPath,
    name,
    path: modelPath,
    sourceUrl: encodeAssetUrl(modelPath),
    kind: 'model',
    packagePath,
    metadataPath,
    scriptPaths,
    displayName: typeof asset.displayName === 'string' ? asset.displayName : undefined,
    lengthUnit: unitInfo.lengthUnit,
    unitScaleToMeters: unitInfo.unitScaleToMeters,
  };
}

function normalizeProjectAssetIndex(value: unknown): ProjectAssetIndex {
  if (!isPlainObject(value) || value.version !== 1 || !Array.isArray(value.assets)) {
    throw new Error(PROJECT_ASSET_INDEX_ERROR);
  }

  return {
    version: 1,
    assets: value.assets.map(normalizeIndexedAsset).filter((asset): asset is AssetEntry => asset !== null),
  };
}

export function getCurrentProjectRoot(): string | null {
  return currentProjectRoot;
}

export function setCurrentProjectRoot(projectRoot: string): void {
  currentProjectRoot = normalizeFilePath(projectRoot);
}

export function getProjectModelsRoot(projectRoot: string): string {
  return path.join(normalizeFilePath(projectRoot), PROJECT_ASSETS_DIRECTORY, PROJECT_MODELS_DIRECTORY);
}

export function getProjectAssetIndexPath(projectRoot: string): string {
  return path.join(normalizeFilePath(projectRoot), PROJECT_METADATA_DIRECTORY, PROJECT_ASSET_INDEX_FILE);
}

export async function ensureProjectDirectories(projectRoot: string): Promise<void> {
  const normalizedProjectRoot = normalizeFilePath(projectRoot);
  await fs.mkdir(path.join(normalizedProjectRoot, PROJECT_METADATA_DIRECTORY), { recursive: true });
  await fs.mkdir(getProjectModelsRoot(normalizedProjectRoot), { recursive: true });
}

export async function readProjectAssetIndex(projectRoot: string): Promise<ProjectAssetIndex> {
  try {
    const content = await fs.readFile(getProjectAssetIndexPath(projectRoot), 'utf-8');
    return normalizeProjectAssetIndex(JSON.parse(content) as unknown);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return { version: 1, assets: [] };
    }

    if (error instanceof SyntaxError) {
      throw new Error(PROJECT_ASSET_INDEX_ERROR);
    }

    throw error;
  }
}

export async function writeProjectAssetIndex(projectRoot: string, index: ProjectAssetIndex): Promise<void> {
  await ensureProjectDirectories(projectRoot);
  await fs.writeFile(getProjectAssetIndexPath(projectRoot), `${JSON.stringify(index, null, 2)}\n`, 'utf-8');
}

export function toSafePackageDirectoryName(name: string): string {
  const safeName = name.replace(/[<>:"/\\|?*]/g, '_').trim().replace(/[. ]+$/g, '');
  return safeName || 'model-package';
}

export async function copyDirectory(source: string, target: string): Promise<void> {
  const normalizedSource = normalizeFilePath(source);
  const normalizedTarget = normalizeFilePath(target);

  if (normalizedSource === normalizedTarget) return;

  await fs.rm(normalizedTarget, { recursive: true, force: true });
  await fs.cp(normalizedSource, normalizedTarget, { recursive: true });
}

export async function ensureCurrentProjectRootWithDialog(): Promise<string | null> {
  const recentProjectRoot = await loadRecentProjectRoot();
  if (recentProjectRoot) return recentProjectRoot;

  const result = await dialog.showOpenDialog({
    title: '选择项目目录',
    properties: ['openDirectory', 'createDirectory'],
  });

  const [projectRoot] = result.filePaths;

  if (result.canceled || !projectRoot) {
    return null;
  }

  const selectedProjectRoot = normalizeFilePath(projectRoot);
  setCurrentProjectRoot(selectedProjectRoot);
  await ensureProjectDirectories(selectedProjectRoot);
  authorizeAssetRoot(getProjectModelsRoot(selectedProjectRoot));
  await persistCurrentProjectRoot(selectedProjectRoot);

  return selectedProjectRoot;
}

export async function listProjectAssets(): Promise<ProjectListAssetsResult> {
  const projectRoot = await loadRecentProjectRoot();

  if (!projectRoot) {
    return { projectRoot: null, assets: [] };
  }

  await ensureProjectDirectories(projectRoot);
  authorizeAssetRoot(getProjectModelsRoot(projectRoot));

  const index = await readProjectAssetIndex(projectRoot);
  for (const asset of index.assets) {
    authorizeAssetFile(asset.path);
  }

  return { projectRoot, assets: index.assets };
}

export async function importModelPackagesIntoProject(
  scannedAssets: AssetEntry[],
): Promise<ImportModelPackagesIntoProjectResult> {
  const projectRoot = await loadRecentProjectRoot();

  if (!projectRoot) {
    throw new Error('导入模型前需要先选择项目目录。');
  }

  await ensureProjectDirectories(projectRoot);
  authorizeAssetRoot(getProjectModelsRoot(projectRoot));

  const importedAssets: AssetEntry[] = [];
  const skipped: ImportModelFolderSkippedEntry[] = [];

  for (const scannedAsset of scannedAssets) {
    if (!scannedAsset.packagePath) {
      skipped.push({ packagePath: scannedAsset.path, reason: '模型包路径缺失，无法复制到项目。' });
      continue;
    }

    const sourcePackagePath = normalizeFilePath(scannedAsset.packagePath);
    const packageDirectoryName = toSafePackageDirectoryName(path.basename(sourcePackagePath));
    const targetPackagePath = path.join(getProjectModelsRoot(projectRoot), packageDirectoryName);

    try {
      await copyDirectory(sourcePackagePath, targetPackagePath);
      const copiedPackage = await scanModelPackage(targetPackagePath);

      if (copiedPackage.asset) {
        importedAssets.push(copiedPackage.asset);
        authorizeAssetFile(copiedPackage.asset.path);
      }

      if (copiedPackage.skipped) {
        skipped.push(copiedPackage.skipped);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      skipped.push({ packagePath: sourcePackagePath, reason: `复制到项目失败：${message}` });
    }
  }

  const currentIndex = await readProjectAssetIndex(projectRoot);
  const importedIds = new Set(importedAssets.map((asset) => asset.id));
  const importedPackagePaths = new Set(importedAssets.map((asset) => asset.packagePath).filter(Boolean));
  const preservedAssets = currentIndex.assets.filter(
    (asset) => !importedIds.has(asset.id) && (!asset.packagePath || !importedPackagePaths.has(asset.packagePath)),
  );

  await writeProjectAssetIndex(projectRoot, {
    version: 1,
    assets: [...preservedAssets, ...importedAssets],
  });

  return { assets: importedAssets, skipped };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
