import { app, dialog } from 'electron';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { DEFAULT_MODEL_LENGTH_UNIT_INFO, normalizeModelLengthUnit } from '../modelUnits.js';
import { authorizeAssetFile, authorizeAssetRoot, encodeAssetUrl, normalizeFilePath, } from './assetRegistry.js';
import { scanModelPackage, validateGlbModelFile } from './modelPackageScanner.js';
const PROJECT_METADATA_DIRECTORY = '.babylon-editor';
const PROJECT_ASSET_INDEX_FILE = 'asset-index.json';
const PROJECT_ASSETS_DIRECTORY = 'Assets';
const PROJECT_MODELS_DIRECTORY = 'Models';
const PROJECT_ENVIRONMENTS_DIRECTORY = 'Environments';
const RECENT_PROJECT_FILE = 'recent-project.json';
const RECENT_WORKSPACES_FILE = 'recent-workspaces.json';
const MAX_RECENT_WORKSPACE_ITEMS = 12;
const PROJECT_ASSET_INDEX_ERROR = '项目资产索引格式不正确。';
let currentProjectRoot = null;
let hasLoadedRecentProjectRoot = false;
function isPlainObject(value) {
    return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}
function getRecentProjectFilePath() {
    return path.join(app.getPath('userData'), RECENT_PROJECT_FILE);
}
function getRecentWorkspacesFilePath() {
    return path.join(app.getPath('userData'), RECENT_WORKSPACES_FILE);
}
function createEmptyRecentWorkspaceIndex() {
    return {
        version: 1,
        projects: [],
        scenes: [],
    };
}
function normalizeTimestamp(value) {
    if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
        return new Date().toISOString();
    }
    return value;
}
function normalizeRecentProjectEntry(value) {
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
function normalizeRecentSceneEntry(value) {
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
function normalizeRecentWorkspaceIndex(value) {
    if (!isPlainObject(value) || value.version !== 1) {
        return createEmptyRecentWorkspaceIndex();
    }
    return {
        version: 1,
        projects: Array.isArray(value.projects)
            ? value.projects.map(normalizeRecentProjectEntry).filter((entry) => entry !== null)
            : [],
        scenes: Array.isArray(value.scenes)
            ? value.scenes.map(normalizeRecentSceneEntry).filter((entry) => entry !== null)
            : [],
    };
}
async function pathExists(filePath) {
    try {
        await fs.access(filePath);
        return true;
    }
    catch {
        return false;
    }
}
async function isDirectoryPath(filePath) {
    try {
        return (await fs.stat(filePath)).isDirectory();
    }
    catch {
        return false;
    }
}
async function isFilePath(filePath) {
    try {
        return (await fs.stat(filePath)).isFile();
    }
    catch {
        return false;
    }
}
async function readLegacyRecentProjectIndex() {
    try {
        const content = await fs.readFile(getRecentProjectFilePath(), 'utf-8');
        const parsed = JSON.parse(content);
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
    }
    catch {
        return createEmptyRecentWorkspaceIndex();
    }
}
async function readRecentWorkspaceIndex() {
    try {
        const content = await fs.readFile(getRecentWorkspacesFilePath(), 'utf-8');
        return normalizeRecentWorkspaceIndex(JSON.parse(content));
    }
    catch (error) {
        if (isNodeError(error) && error.code === 'ENOENT') {
            return readLegacyRecentProjectIndex();
        }
        if (error instanceof SyntaxError) {
            return createEmptyRecentWorkspaceIndex();
        }
        throw error;
    }
}
async function writeRecentWorkspaceIndex(index) {
    await fs.mkdir(path.dirname(getRecentWorkspacesFilePath()), { recursive: true });
    await fs.writeFile(getRecentWorkspacesFilePath(), `${JSON.stringify(index, null, 2)}\n`, 'utf-8');
}
function sortRecentEntries(entries) {
    return [...entries]
        .sort((left, right) => Date.parse(right.lastOpenedAt) - Date.parse(left.lastOpenedAt))
        .slice(0, MAX_RECENT_WORKSPACE_ITEMS);
}
function upsertRecentProject(index, projectRoot, lastScenePath) {
    const normalizedProjectRoot = normalizeFilePath(projectRoot);
    const existing = index.projects.find((entry) => entry.projectRoot === normalizedProjectRoot);
    const nextEntry = {
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
function upsertRecentScene(index, filePath, projectRoot) {
    const normalizedFilePath = normalizeFilePath(filePath);
    const existing = index.scenes.find((entry) => entry.filePath === normalizedFilePath);
    const normalizedProjectRoot = projectRoot ? normalizeFilePath(projectRoot) : existing?.projectRoot;
    const nextEntry = {
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
async function toRecentProjectEntry(entry) {
    const exists = await pathExists(entry.projectRoot);
    let assetCount = 0;
    if (exists) {
        try {
            assetCount = (await readProjectAssetIndex(entry.projectRoot)).assets.length;
        }
        catch {
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
async function toRecentSceneEntry(entry) {
    return {
        filePath: entry.filePath,
        displayName: path.basename(entry.filePath) || entry.filePath,
        lastOpenedAt: entry.lastOpenedAt,
        exists: await pathExists(entry.filePath),
        projectRoot: entry.projectRoot,
    };
}
async function loadRecentProjectRoot() {
    if (currentProjectRoot)
        return currentProjectRoot;
    if (hasLoadedRecentProjectRoot)
        return null;
    hasLoadedRecentProjectRoot = true;
    const recentWorkspaces = await readRecentWorkspaceIndex();
    for (const project of sortRecentEntries(recentWorkspaces.projects)) {
        if (!(await pathExists(project.projectRoot)))
            continue;
        setCurrentProjectRoot(project.projectRoot);
        await ensureProjectDirectories(project.projectRoot);
        authorizeProjectAssetRoots(project.projectRoot);
        return project.projectRoot;
    }
    return null;
}
async function persistCurrentProjectRoot(projectRoot) {
    await fs.mkdir(path.dirname(getRecentProjectFilePath()), { recursive: true });
    await fs.writeFile(getRecentProjectFilePath(), JSON.stringify({ projectRoot }, null, 2), 'utf-8');
}
function assertString(value) {
    if (typeof value !== 'string') {
        throw new Error(PROJECT_ASSET_INDEX_ERROR);
    }
    return value;
}
/** 校验项目资产库分类，避免 v2 索引写入未知目录类型。 */
function isModelAssetLibraryKind(value) {
    return value === 'model' || value === 'environment';
}
/** 读取索引分类：v1 缺省归普通模型，v2 必须显式合法。 */
function normalizeIndexedLibraryKind(asset, version) {
    if (version === 1 && asset.libraryKind === undefined) {
        return 'model';
    }
    if (!isModelAssetLibraryKind(asset.libraryKind)) {
        throw new Error(PROJECT_ASSET_INDEX_ERROR);
    }
    return asset.libraryKind;
}
function normalizeOptionalPath(value) {
    if (value === undefined)
        return undefined;
    return normalizeFilePath(assertString(value));
}
function normalizeOptionalTrimmedString(value) {
    if (value === undefined)
        return undefined;
    const trimmedValue = assertString(value).trim();
    return trimmedValue || undefined;
}
function normalizeOptionalStringArray(value) {
    if (value === undefined)
        return undefined;
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
        throw new Error(PROJECT_ASSET_INDEX_ERROR);
    }
    return value.map((item) => normalizeFilePath(item));
}
function normalizeOptionalScriptAssets(value) {
    if (value === undefined)
        return undefined;
    if (!Array.isArray(value))
        throw new Error(PROJECT_ASSET_INDEX_ERROR);
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
function normalizeOptionalMetadataArray(value) {
    return Array.isArray(value) ? value : undefined;
}
function createScriptAssetsFromPaths(scriptPaths) {
    if (!scriptPaths?.length)
        return undefined;
    return scriptPaths.map((scriptPath) => ({
        path: scriptPath,
        sourceUrl: encodeAssetUrl(scriptPath),
        name: path.basename(scriptPath),
    }));
}
/** 归一化项目索引中的模型资产，并补齐 sourceUrl、缩略图与脚本授权路径。 */
function normalizeIndexedAsset(value, version) {
    const asset = isPlainObject(value) ? value : null;
    if (!asset)
        throw new Error(PROJECT_ASSET_INDEX_ERROR);
    if (asset.kind !== 'model')
        return null;
    const libraryKind = normalizeIndexedLibraryKind(asset, version);
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
        libraryKind,
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
        dataDrivenConfig: isPlainObject(asset.dataDrivenConfig) ? asset.dataDrivenConfig : undefined,
    };
}
/** 读取兼容 v1/v2 索引；纯读取只返回内存结构，不主动改写磁盘文件。 */
function normalizeProjectAssetIndex(value) {
    if (!isPlainObject(value) || (value.version !== 1 && value.version !== 2) || !Array.isArray(value.assets)) {
        throw new Error(PROJECT_ASSET_INDEX_ERROR);
    }
    const version = value.version;
    return {
        version: 2,
        assets: value.assets
            .map((asset) => normalizeIndexedAsset(asset, version))
            .filter((asset) => asset !== null),
    };
}
export function getCurrentProjectRoot() {
    return currentProjectRoot;
}
export function setCurrentProjectRoot(projectRoot) {
    currentProjectRoot = normalizeFilePath(projectRoot);
}
/** 生成项目内模型包导入版本，用于同一路径被覆盖后通知 renderer 和运行时重载资源。 */
function createProjectAssetRevision() {
    return `${Date.now().toString(36)}-${randomUUID()}`;
}
export async function getRecentWorkspaces() {
    const index = await readRecentWorkspaceIndex();
    return {
        projects: await Promise.all(sortRecentEntries(index.projects).map(toRecentProjectEntry)),
        scenes: await Promise.all(sortRecentEntries(index.scenes).map(toRecentSceneEntry)),
    };
}
export async function rememberRecentProjectRoot(projectRoot, lastScenePath) {
    const index = await readRecentWorkspaceIndex();
    await writeRecentWorkspaceIndex(upsertRecentProject(index, projectRoot, lastScenePath));
}
export async function rememberRecentSceneFile(filePath, projectRoot = currentProjectRoot) {
    const index = await readRecentWorkspaceIndex();
    await writeRecentWorkspaceIndex(upsertRecentScene(index, filePath, projectRoot));
}
export async function assertRecentSceneFile(filePath) {
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
export async function removeRecentWorkspaceItem(kind, itemPath) {
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
export async function openRecentProject(projectRoot) {
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
    authorizeProjectAssetRoots(normalizedProjectRoot);
    await persistCurrentProjectRoot(normalizedProjectRoot);
    await rememberRecentProjectRoot(normalizedProjectRoot);
    return listProjectAssets();
}
export function getProjectModelsRoot(projectRoot) {
    return path.join(normalizeFilePath(projectRoot), PROJECT_ASSETS_DIRECTORY, PROJECT_MODELS_DIRECTORY);
}
/** 返回项目环境模型目录 Assets/Environments。 */
export function getProjectEnvironmentsRoot(projectRoot) {
    return path.join(normalizeFilePath(projectRoot), PROJECT_ASSETS_DIRECTORY, PROJECT_ENVIRONMENTS_DIRECTORY);
}
/** 根据资产库分类选择实际复制目标目录。 */
function getProjectAssetLibraryRoot(projectRoot, libraryKind) {
    return libraryKind === 'environment' ? getProjectEnvironmentsRoot(projectRoot) : getProjectModelsRoot(projectRoot);
}
/** 授权普通模型与环境模型两个项目资产目录。 */
function authorizeProjectAssetRoots(projectRoot) {
    authorizeAssetRoot(getProjectModelsRoot(projectRoot));
    authorizeAssetRoot(getProjectEnvironmentsRoot(projectRoot));
}
export function getProjectAssetIndexPath(projectRoot) {
    return path.join(normalizeFilePath(projectRoot), PROJECT_METADATA_DIRECTORY, PROJECT_ASSET_INDEX_FILE);
}
/** 确保项目元数据、普通模型与环境模型目录都已创建。 */
export async function ensureProjectDirectories(projectRoot) {
    const normalizedProjectRoot = normalizeFilePath(projectRoot);
    await fs.mkdir(path.join(normalizedProjectRoot, PROJECT_METADATA_DIRECTORY), { recursive: true });
    await fs.mkdir(getProjectModelsRoot(normalizedProjectRoot), { recursive: true });
    await fs.mkdir(getProjectEnvironmentsRoot(normalizedProjectRoot), { recursive: true });
}
/** 读取项目资产索引，兼容 v1 并返回 v2 内存结构，不在读取时写回。 */
export async function readProjectAssetIndex(projectRoot) {
    try {
        const content = await fs.readFile(getProjectAssetIndexPath(projectRoot), 'utf-8');
        return normalizeProjectAssetIndex(JSON.parse(content));
    }
    catch (error) {
        if (isNodeError(error) && error.code === 'ENOENT') {
            return { version: 2, assets: [] };
        }
        if (error instanceof SyntaxError) {
            throw new Error(PROJECT_ASSET_INDEX_ERROR);
        }
        throw error;
    }
}
/** 写入 v2 项目资产索引，调用方需传入已分类的项目模型资产。 */
export async function writeProjectAssetIndex(projectRoot, index) {
    const normalizedIndex = normalizeProjectAssetIndex(index);
    await ensureProjectDirectories(projectRoot);
    await fs.writeFile(getProjectAssetIndexPath(projectRoot), `${JSON.stringify(normalizedIndex, null, 2)}\n`, 'utf-8');
}
export function toSafePackageDirectoryName(name) {
    const safeName = name.replace(/[<>:"/\\|?*]/g, '_').trim().replace(/[. ]+$/g, '');
    return safeName || 'model-package';
}
export async function copyDirectory(source, target) {
    const normalizedSource = normalizeFilePath(source);
    const normalizedTarget = normalizeFilePath(target);
    if (normalizedSource === normalizedTarget)
        return;
    await fs.rm(normalizedTarget, { recursive: true, force: true });
    await fs.cp(normalizedSource, normalizedTarget, { recursive: true });
}
/** 比较两个本地路径是否指向同一位置；Windows 下忽略盘符和目录名大小写。 */
function isSameLocalPath(left, right) {
    const normalizedLeft = normalizeFilePath(left);
    const normalizedRight = normalizeFilePath(right);
    return process.platform === 'win32'
        ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
        : normalizedLeft === normalizedRight;
}
/**
 * 在正式环境包旁创建已校验的暂存副本。
 * 返回 null 表示源文件已经位于正式目标中，此时只更新索引版本，不移动文件。
 */
async function prepareEnvironmentPackageWithGlb(sourceFilePath, targetPackagePath) {
    const normalizedSourceFilePath = normalizeFilePath(sourceFilePath);
    const normalizedTargetPackagePath = normalizeFilePath(targetPackagePath);
    const targetFilePath = path.join(normalizedTargetPackagePath, path.basename(normalizedSourceFilePath));
    if (!(await validateGlbModelFile(normalizedSourceFilePath))) {
        throw new Error('环境 GLB 文件结构无效或已损坏。');
    }
    if (isSameLocalPath(normalizedSourceFilePath, targetFilePath)) {
        await fs.mkdir(normalizedTargetPackagePath, { recursive: true });
        return null;
    }
    const stagingPackagePath = `${normalizedTargetPackagePath}.import-${randomUUID()}`;
    const stagedFilePath = path.join(stagingPackagePath, path.basename(normalizedSourceFilePath));
    await fs.rm(stagingPackagePath, { recursive: true, force: true });
    try {
        await fs.mkdir(stagingPackagePath, { recursive: true });
        await fs.copyFile(normalizedSourceFilePath, stagedFilePath);
        if (!(await validateGlbModelFile(stagedFilePath))) {
            throw new Error('项目内环境 GLB 暂存副本校验失败。');
        }
        const stagedPackage = await scanModelPackage(stagingPackagePath);
        if (!stagedPackage.asset) {
            throw new Error(stagedPackage.skipped?.reason ?? '项目内环境 GLB 暂存扫描失败。');
        }
        return stagingPackagePath;
    }
    catch (error) {
        await fs.rm(stagingPackagePath, { recursive: true, force: true });
        throw error;
    }
}
export async function ensureCurrentProjectRootWithDialog() {
    const recentProjectRoot = await loadRecentProjectRoot();
    if (recentProjectRoot)
        return recentProjectRoot;
    return selectCurrentProjectRootWithDialog();
}
export async function selectCurrentProjectRootWithDialog() {
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
    authorizeProjectAssetRoots(selectedProjectRoot);
    await persistCurrentProjectRoot(selectedProjectRoot);
    await rememberRecentProjectRoot(selectedProjectRoot);
    return selectedProjectRoot;
}
export async function listProjectAssets() {
    const projectRoot = await loadRecentProjectRoot();
    if (!projectRoot) {
        return { projectRoot: null, assets: [] };
    }
    await ensureProjectDirectories(projectRoot);
    authorizeProjectAssetRoots(projectRoot);
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
/**
 * 将用户选择的单个环境 GLB 保存为项目内独立单文件包，并写入环境分库索引。
 * 旧环境模型包仍保留原有索引结构；只有同目标包或同资产路径的环境记录会被替换。
 */
export async function importEnvironmentModelFileIntoProject(sourceFilePath) {
    const projectRoot = await loadRecentProjectRoot();
    if (!projectRoot) {
        throw new Error('导入环境模型前需要先选择项目目录。');
    }
    const normalizedSourceFilePath = normalizeFilePath(sourceFilePath);
    if (path.extname(normalizedSourceFilePath).toLowerCase() !== '.glb') {
        throw new Error('环境模型仅支持直接导入 .glb 文件。');
    }
    if (!(await isFilePath(normalizedSourceFilePath))) {
        throw new Error('请选择有效的环境 GLB 文件。');
    }
    await ensureProjectDirectories(projectRoot);
    authorizeProjectAssetRoots(projectRoot);
    const packageDirectoryName = toSafePackageDirectoryName(path.parse(normalizedSourceFilePath).name);
    const targetPackagePath = path.join(getProjectEnvironmentsRoot(projectRoot), packageDirectoryName);
    const currentIndex = await readProjectAssetIndex(projectRoot);
    const stagingPackagePath = await prepareEnvironmentPackageWithGlb(normalizedSourceFilePath, targetPackagePath);
    const backupPackagePath = stagingPackagePath ? `${targetPackagePath}.backup-${randomUUID()}` : null;
    let previousPackageMoved = false;
    let stagedPackagePromoted = false;
    let indexWriteStarted = false;
    let importCommitted = false;
    try {
        if (stagingPackagePath && backupPackagePath) {
            await fs.rm(backupPackagePath, { recursive: true, force: true });
            if (await pathExists(targetPackagePath)) {
                await fs.rename(targetPackagePath, backupPackagePath);
                previousPackageMoved = true;
            }
            await fs.rename(stagingPackagePath, targetPackagePath);
            stagedPackagePromoted = true;
        }
        const copiedPackage = await scanModelPackage(targetPackagePath);
        if (!copiedPackage.asset) {
            throw new Error(copiedPackage.skipped?.reason ?? '项目内环境 GLB 扫描失败。');
        }
        const importedAsset = {
            ...copiedPackage.asset,
            assetRevision: createProjectAssetRevision(),
            kind: 'model',
            libraryKind: 'environment',
            // 单文件环境 GLB 按项目统一米制登记，避免历史目录中的单位元数据影响直接导入语义。
            lengthUnit: DEFAULT_MODEL_LENGTH_UNIT_INFO.lengthUnit,
            unitScaleToMeters: DEFAULT_MODEL_LENGTH_UNIT_INFO.unitScaleToMeters,
        };
        authorizeAssetFile(importedAsset.path);
        const projectAssets = [
            ...currentIndex.assets.filter((asset) => asset.libraryKind !== 'environment'
                || (asset.id !== importedAsset.id && asset.packagePath !== importedAsset.packagePath)),
            importedAsset,
        ];
        indexWriteStarted = true;
        await writeProjectAssetIndex(projectRoot, {
            version: 2,
            assets: projectAssets,
        });
        importCommitted = true;
        if (previousPackageMoved && backupPackagePath) {
            try {
                await fs.rm(backupPackagePath, { recursive: true, force: true });
            }
            catch {
                // 索引和正式包已经提交成功；备份清理失败不应把一次成功导入误报为失败。
            }
        }
        return { importedAsset, projectAssets };
    }
    catch (error) {
        const rollbackErrors = [];
        if (stagedPackagePromoted && await pathExists(targetPackagePath)) {
            try {
                await fs.rm(targetPackagePath, { recursive: true, force: true });
            }
            catch (rollbackError) {
                rollbackErrors.push(`移除失败的新环境包：${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
            }
        }
        if (previousPackageMoved && backupPackagePath && await pathExists(backupPackagePath)) {
            try {
                await fs.rename(backupPackagePath, targetPackagePath);
            }
            catch (rollbackError) {
                rollbackErrors.push(`恢复旧环境包：${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
            }
        }
        if (indexWriteStarted) {
            try {
                await writeProjectAssetIndex(projectRoot, currentIndex);
            }
            catch (rollbackError) {
                rollbackErrors.push(`恢复旧资产索引：${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
            }
        }
        if (rollbackErrors.length > 0) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`${message}；环境导入回滚不完整：${rollbackErrors.join('；')}`);
        }
        throw error;
    }
    finally {
        if (stagingPackagePath) {
            await fs.rm(stagingPackagePath, { recursive: true, force: true });
        }
        if (importCommitted && backupPackagePath) {
            try {
                await fs.rm(backupPackagePath, { recursive: true, force: true });
            }
            catch {
                // 已提交导入只保留孤立备份，不破坏正式包和索引的一致性。
            }
        }
    }
}
/** 将扫描到的模型包复制进指定项目资产库，并只替换目标库中的同名记录。 */
export async function importModelPackagesIntoProject(scannedAssets, libraryKind) {
    const projectRoot = await loadRecentProjectRoot();
    if (!projectRoot) {
        throw new Error('导入模型前需要先选择项目目录。');
    }
    await ensureProjectDirectories(projectRoot);
    authorizeProjectAssetRoots(projectRoot);
    const importedAssets = [];
    const skipped = [];
    const targetLibraryRoot = getProjectAssetLibraryRoot(projectRoot, libraryKind);
    for (const scannedAsset of scannedAssets) {
        if (!scannedAsset.packagePath) {
            skipped.push({ packagePath: scannedAsset.path, reason: '模型包路径缺失，无法复制到项目。' });
            continue;
        }
        const sourcePackagePath = normalizeFilePath(scannedAsset.packagePath);
        const packageDirectoryName = toSafePackageDirectoryName(path.basename(sourcePackagePath));
        const targetPackagePath = path.join(targetLibraryRoot, packageDirectoryName);
        try {
            await copyDirectory(sourcePackagePath, targetPackagePath);
            const copiedPackage = await scanModelPackage(targetPackagePath);
            if (copiedPackage.asset) {
                const importedAsset = {
                    ...copiedPackage.asset,
                    assetRevision: createProjectAssetRevision(),
                    kind: 'model',
                    libraryKind,
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
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            skipped.push({ packagePath: sourcePackagePath, reason: `复制到项目失败：${message}` });
        }
    }
    const currentIndex = await readProjectAssetIndex(projectRoot);
    const importedIds = new Set(importedAssets.map((asset) => asset.id));
    const importedPackagePaths = new Set(importedAssets.map((asset) => asset.packagePath).filter(Boolean));
    const preservedAssets = currentIndex.assets.filter((asset) => asset.libraryKind !== libraryKind
        || (!importedIds.has(asset.id) && (!asset.packagePath || !importedPackagePaths.has(asset.packagePath))));
    const projectAssets = [...preservedAssets, ...importedAssets];
    await writeProjectAssetIndex(projectRoot, {
        version: 2,
        assets: projectAssets,
    });
    return { importedAssets, projectAssets, skipped };
}
function isNodeError(error) {
    return error instanceof Error && 'code' in error;
}
