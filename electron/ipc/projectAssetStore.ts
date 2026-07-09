import { app, dialog } from 'electron';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type {
  AssetEntry,
  ImportModelFolderSkippedEntry,
  ProjectAssetIndex,
  ProjectListAssetsResult,
  RecentProjectEntry,
  RecentSceneEntry,
  RecentWorkspacesResult,
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
const RECENT_WORKSPACES_FILE = 'recent-workspaces.json';
const MAX_RECENT_WORKSPACE_ITEMS = 12;
const PROJECT_ASSET_INDEX_ERROR = '项目资产索引格式不正确。';

let currentProjectRoot: string | null = null;
let hasLoadedRecentProjectRoot = false;

type PersistedRecentProjectEntry = {
  projectRoot: string;
  lastOpenedAt: string;
  lastScenePath?: string;
};

type PersistedRecentSceneEntry = {
  filePath: string;
  lastOpenedAt: string;
  projectRoot?: string;
};

type RecentWorkspaceIndex = {
  version: 1;
  projects: PersistedRecentProjectEntry[];
  scenes: PersistedRecentSceneEntry[];
};

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

function getRecentWorkspacesFilePath(): string {
  return path.join(app.getPath('userData'), RECENT_WORKSPACES_FILE);
}

function createEmptyRecentWorkspaceIndex(): RecentWorkspaceIndex {
  return {
    version: 1,
    projects: [],
    scenes: [],
  };
}

function normalizeTimestamp(value: unknown): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    return new Date().toISOString();
  }

  return value;
}

function normalizeRecentProjectEntry(value: unknown): PersistedRecentProjectEntry | null {
  if (!isPlainObject(value) || typeof value.projectRoot !== 'string' || !value.projectRoot.trim()) {
    return null;
  }

  const projectRoot = normalizeFilePath(value.projectRoot);
  const lastScenePath = typeof value.lastScenePath === 'string' && value.lastScenePath.trim()
    ? normalizeFilePath(value.lastScenePath)
    : undefined;

  return {
    projectRoot,
    lastOpenedAt: normalizeTimestamp(value.lastOpenedAt),
    lastScenePath,
  };
}

function normalizeRecentSceneEntry(value: unknown): PersistedRecentSceneEntry | null {
  if (!isPlainObject(value) || typeof value.filePath !== 'string' || !value.filePath.trim()) {
    return null;
  }

  const filePath = normalizeFilePath(value.filePath);
  const projectRoot = typeof value.projectRoot === 'string' && value.projectRoot.trim()
    ? normalizeFilePath(value.projectRoot)
    : undefined;

  return {
    filePath,
    lastOpenedAt: normalizeTimestamp(value.lastOpenedAt),
    projectRoot,
  };
}

function normalizeRecentWorkspaceIndex(value: unknown): RecentWorkspaceIndex {
  if (!isPlainObject(value) || value.version !== 1) {
    return createEmptyRecentWorkspaceIndex();
  }

  return {
    version: 1,
    projects: Array.isArray(value.projects)
      ? value.projects.map(normalizeRecentProjectEntry).filter((entry): entry is PersistedRecentProjectEntry => entry !== null)
      : [],
    scenes: Array.isArray(value.scenes)
      ? value.scenes.map(normalizeRecentSceneEntry).filter((entry): entry is PersistedRecentSceneEntry => entry !== null)
      : [],
  };
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function isDirectoryPath(filePath: string): Promise<boolean> {
  try {
    return (await fs.stat(filePath)).isDirectory();
  } catch {
    return false;
  }
}

async function isFilePath(filePath: string): Promise<boolean> {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch {
    return false;
  }
}

async function readLegacyRecentProjectIndex(): Promise<RecentWorkspaceIndex> {
  try {
    const content = await fs.readFile(getRecentProjectFilePath(), 'utf-8');
    const parsed = JSON.parse(content) as unknown;
    if (!isPlainObject(parsed) || typeof parsed.projectRoot !== 'string' || !parsed.projectRoot.trim()) {
      return createEmptyRecentWorkspaceIndex();
    }

    return {
      version: 1,
      projects: [{
        projectRoot: normalizeFilePath(parsed.projectRoot),
        lastOpenedAt: new Date().toISOString(),
      }],
      scenes: [],
    };
  } catch {
    return createEmptyRecentWorkspaceIndex();
  }
}

async function readRecentWorkspaceIndex(): Promise<RecentWorkspaceIndex> {
  try {
    const content = await fs.readFile(getRecentWorkspacesFilePath(), 'utf-8');
    return normalizeRecentWorkspaceIndex(JSON.parse(content) as unknown);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return readLegacyRecentProjectIndex();
    }

    if (error instanceof SyntaxError) {
      return createEmptyRecentWorkspaceIndex();
    }

    throw error;
  }
}

async function writeRecentWorkspaceIndex(index: RecentWorkspaceIndex): Promise<void> {
  await fs.mkdir(path.dirname(getRecentWorkspacesFilePath()), { recursive: true });
  await fs.writeFile(getRecentWorkspacesFilePath(), `${JSON.stringify(index, null, 2)}\n`, 'utf-8');
}

function sortRecentEntries<T extends { lastOpenedAt: string }>(entries: T[]): T[] {
  return [...entries]
    .sort((left, right) => Date.parse(right.lastOpenedAt) - Date.parse(left.lastOpenedAt))
    .slice(0, MAX_RECENT_WORKSPACE_ITEMS);
}

function upsertRecentProject(
  index: RecentWorkspaceIndex,
  projectRoot: string,
  lastScenePath?: string,
): RecentWorkspaceIndex {
  const normalizedProjectRoot = normalizeFilePath(projectRoot);
  const existing = index.projects.find((entry) => entry.projectRoot === normalizedProjectRoot);
  const nextEntry: PersistedRecentProjectEntry = {
    projectRoot: normalizedProjectRoot,
    lastOpenedAt: new Date().toISOString(),
    lastScenePath: lastScenePath ? normalizeFilePath(lastScenePath) : existing?.lastScenePath,
  };

  return {
    version: 1,
    projects: sortRecentEntries([
      nextEntry,
      ...index.projects.filter((entry) => entry.projectRoot !== normalizedProjectRoot),
    ]),
    scenes: index.scenes,
  };
}

function upsertRecentScene(
  index: RecentWorkspaceIndex,
  filePath: string,
  projectRoot?: string | null,
): RecentWorkspaceIndex {
  const normalizedFilePath = normalizeFilePath(filePath);
  const existing = index.scenes.find((entry) => entry.filePath === normalizedFilePath);
  const normalizedProjectRoot = projectRoot ? normalizeFilePath(projectRoot) : existing?.projectRoot;
  const nextEntry: PersistedRecentSceneEntry = {
    filePath: normalizedFilePath,
    lastOpenedAt: new Date().toISOString(),
    projectRoot: normalizedProjectRoot,
  };

  return {
    version: 1,
    projects: normalizedProjectRoot
      ? upsertRecentProject(index, normalizedProjectRoot, normalizedFilePath).projects
      : index.projects,
    scenes: sortRecentEntries([
      nextEntry,
      ...index.scenes.filter((entry) => entry.filePath !== normalizedFilePath),
    ]),
  };
}

async function toRecentProjectEntry(entry: PersistedRecentProjectEntry): Promise<RecentProjectEntry> {
  const exists = await pathExists(entry.projectRoot);
  let assetCount = 0;

  if (exists) {
    try {
      assetCount = (await readProjectAssetIndex(entry.projectRoot)).assets.length;
    } catch {
      assetCount = 0;
    }
  }

  return {
    projectRoot: entry.projectRoot,
    displayName: path.basename(entry.projectRoot) || entry.projectRoot,
    lastOpenedAt: entry.lastOpenedAt,
    exists,
    assetCount,
    lastScenePath: entry.lastScenePath,
  };
}

async function toRecentSceneEntry(entry: PersistedRecentSceneEntry): Promise<RecentSceneEntry> {
  return {
    filePath: entry.filePath,
    displayName: path.basename(entry.filePath) || entry.filePath,
    lastOpenedAt: entry.lastOpenedAt,
    exists: await pathExists(entry.filePath),
    projectRoot: entry.projectRoot,
  };
}

async function loadRecentProjectRoot(): Promise<string | null> {
  if (currentProjectRoot) return currentProjectRoot;
  if (hasLoadedRecentProjectRoot) return null;

  hasLoadedRecentProjectRoot = true;

  const recentWorkspaces = await readRecentWorkspaceIndex();
  for (const project of sortRecentEntries(recentWorkspaces.projects)) {
    if (!(await pathExists(project.projectRoot))) continue;

    setCurrentProjectRoot(project.projectRoot);
    await ensureProjectDirectories(project.projectRoot);
    authorizeAssetRoot(getProjectModelsRoot(project.projectRoot));
    return project.projectRoot;
  }

  return null;
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

function normalizeOptionalTrimmedString(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const trimmedValue = assertString(value).trim();
  return trimmedValue || undefined;
}

function normalizeOptionalStringArray(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(PROJECT_ASSET_INDEX_ERROR);
  }

  return value.map((item) => normalizeFilePath(item));
}

function normalizeOptionalScriptAssets(value: unknown): NonNullable<AssetEntry['scriptAssets']> | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(PROJECT_ASSET_INDEX_ERROR);

  return value.map((item) => {
    if (!isPlainObject(item) || typeof item.path !== 'string') {
      throw new Error(PROJECT_ASSET_INDEX_ERROR);
    }

    const scriptPath = normalizeFilePath(item.path);
    return {
      path: scriptPath,
      sourceUrl: encodeAssetUrl(scriptPath),
      name: typeof item.name === 'string' && item.name.trim() ? item.name : path.basename(scriptPath),
    };
  });
}

function normalizeOptionalMetadataArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function createScriptAssetsFromPaths(scriptPaths: string[] | undefined): NonNullable<AssetEntry['scriptAssets']> | undefined {
  if (!scriptPaths?.length) return undefined;

  return scriptPaths.map((scriptPath) => ({
    path: scriptPath,
    sourceUrl: encodeAssetUrl(scriptPath),
    name: path.basename(scriptPath),
  }));
}

function normalizeIndexedAsset(value: unknown): AssetEntry | null {
  const asset = isPlainObject(value) ? value : null;
  if (!asset) throw new Error(PROJECT_ASSET_INDEX_ERROR);

  if (asset.kind !== 'model') return null;

  const modelPath = normalizeFilePath(assertString(asset.path));
  const name = assertString(asset.name);
  const assetRevision = normalizeOptionalTrimmedString(asset.assetRevision);
  const packagePath = normalizeOptionalPath(asset.packagePath);
  const metadataPath = normalizeOptionalPath(asset.metadataPath);
  const thumbnailPath = normalizeOptionalPath(asset.thumbnailPath);
  const defaultAssetCode = normalizeOptionalTrimmedString(asset.defaultAssetCode);
  const scriptPaths = normalizeOptionalStringArray(asset.scriptPaths);
  const scriptAssets = normalizeOptionalScriptAssets(asset.scriptAssets) ?? createScriptAssetsFromPaths(scriptPaths);
  const unitInfo = normalizeModelLengthUnit(asset.lengthUnit) ?? DEFAULT_MODEL_LENGTH_UNIT_INFO;

  return {
    id: modelPath,
    name,
    path: modelPath,
    sourceUrl: encodeAssetUrl(modelPath),
    assetRevision,
    kind: 'model',
    packagePath,
    metadataPath,
    thumbnailPath,
    thumbnailUrl: thumbnailPath ? encodeAssetUrl(thumbnailPath) : undefined,
    scriptPaths,
    scriptAssets,
    parameterScriptMetadata: normalizeOptionalMetadataArray(asset.parameterScriptMetadata),
    animationScriptMetadata: normalizeOptionalMetadataArray(asset.animationScriptMetadata),
    defaultAssetCode,
    displayName: typeof asset.displayName === 'string' ? asset.displayName : undefined,
    lengthUnit: unitInfo.lengthUnit,
    unitScaleToMeters: unitInfo.unitScaleToMeters,
    parameterConfig: isPlainObject(asset.parameterConfig) ? asset.parameterConfig : undefined,
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

/** 生成项目内模型包导入版本，用于同一路径被覆盖后通知 renderer 和运行时重载资源。 */
function createProjectAssetRevision(): string {
  return `${Date.now().toString(36)}-${randomUUID()}`;
}

export async function getRecentWorkspaces(): Promise<RecentWorkspacesResult> {
  const index = await readRecentWorkspaceIndex();

  return {
    projects: await Promise.all(sortRecentEntries(index.projects).map(toRecentProjectEntry)),
    scenes: await Promise.all(sortRecentEntries(index.scenes).map(toRecentSceneEntry)),
  };
}

export async function rememberRecentProjectRoot(projectRoot: string, lastScenePath?: string): Promise<void> {
  const index = await readRecentWorkspaceIndex();
  await writeRecentWorkspaceIndex(upsertRecentProject(index, projectRoot, lastScenePath));
}

export async function rememberRecentSceneFile(filePath: string, projectRoot = currentProjectRoot): Promise<void> {
  const index = await readRecentWorkspaceIndex();
  await writeRecentWorkspaceIndex(upsertRecentScene(index, filePath, projectRoot));
}

export async function assertRecentSceneFile(filePath: string): Promise<string> {
  const normalizedFilePath = normalizeFilePath(filePath);
  const index = await readRecentWorkspaceIndex();
  const isKnownRecentScene = index.scenes.some((entry) => entry.filePath === normalizedFilePath);

  if (!isKnownRecentScene) {
    throw new Error('只能打开最近记录中的场景文件。');
  }

  if (!(await isFilePath(normalizedFilePath))) {
    throw new Error('最近场景文件不存在或不是文件。');
  }

  return normalizedFilePath;
}

export async function removeRecentWorkspaceItem(kind: 'project' | 'scene', itemPath: string): Promise<void> {
  const normalizedPath = normalizeFilePath(itemPath);
  const index = await readRecentWorkspaceIndex();

  await writeRecentWorkspaceIndex({
    version: 1,
    projects: kind === 'project'
      ? index.projects.filter((entry) => entry.projectRoot !== normalizedPath)
      : index.projects,
    scenes: kind === 'scene'
      ? index.scenes.filter((entry) => entry.filePath !== normalizedPath)
      : index.scenes,
  });
}

export async function openRecentProject(projectRoot: string): Promise<ProjectListAssetsResult> {
  const normalizedProjectRoot = normalizeFilePath(projectRoot);
  const index = await readRecentWorkspaceIndex();
  const isKnownRecentProject = index.projects.some((entry) => entry.projectRoot === normalizedProjectRoot);

  if (!isKnownRecentProject) {
    throw new Error('只能打开最近记录中的项目目录。');
  }

  if (!(await isDirectoryPath(normalizedProjectRoot))) {
    throw new Error('最近项目路径不存在或不是目录。');
  }

  setCurrentProjectRoot(normalizedProjectRoot);
  await ensureProjectDirectories(normalizedProjectRoot);
  authorizeAssetRoot(getProjectModelsRoot(normalizedProjectRoot));
  await persistCurrentProjectRoot(normalizedProjectRoot);
  await rememberRecentProjectRoot(normalizedProjectRoot);

  return listProjectAssets();
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

  return selectCurrentProjectRootWithDialog();
}

export async function selectCurrentProjectRootWithDialog(): Promise<string | null> {
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
  await rememberRecentProjectRoot(selectedProjectRoot);

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
    if (asset.thumbnailPath) {
      authorizeAssetFile(asset.thumbnailPath);
    }

    for (const scriptAsset of asset.scriptAssets ?? []) {
      authorizeAssetFile(scriptAsset.path);
    }
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
        const importedAsset: AssetEntry = {
          ...copiedPackage.asset,
          assetRevision: createProjectAssetRevision(),
        };
        importedAssets.push(importedAsset);
        authorizeAssetFile(importedAsset.path);
        if (importedAsset.thumbnailPath) {
          authorizeAssetFile(importedAsset.thumbnailPath);
        }

        for (const scriptAsset of importedAsset.scriptAssets ?? []) {
          authorizeAssetFile(scriptAsset.path);
        }
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
