import { app } from 'electron';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { encodeAssetUrl } from './assetRegistry.js';
import { activateProjectRoot, ensureProjectDirectories, getProjectAssetIndexPath, getProjectEnvironmentsRoot, getProjectModelsRoot, rememberRecentSceneFile, writeProjectAssetIndex, } from './projectAssetStore.js';
import { scanModelPackage } from './modelPackageScanner.js';
import { clearDataPlatformModelSyncRetryContext, disposeDataPlatformModelSync, getLatestDataPlatformModelSyncProgress, retryDataPlatformModelSync, startDataPlatformModelSync, } from './dataPlatformModelSync.js';
import { assertPathInside, DataPlatformRollbackError, downloadRemoteFile, extractZipSecurely, isPathInside, MAX_ARCHIVE_COMPRESSED_BYTES, } from './dataPlatformTransfer.js';
const PROJECT_DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const DATA_PLATFORM_WORKSPACE_DIRECTORY = 'data-platform-workspace';
const TEST_STORAGE_ROOT_ENV = 'ZENDING_EDITOR_STORAGE_ROOT';
const TEST_STORAGE_OVERRIDE_GUARD_ENV = 'ZENDING_ALLOW_STORAGE_ROOT_OVERRIDE';
const LOCAL_ASSET_URL_PREFIX = 'editor-asset://local/';
const SCENE_PATH_KEYS = new Set(['sourcePath', 'packagePath', 'metadataPath', 'thumbnailPath', 'path']);
const SCENE_URL_KEYS = new Set(['sourceUrl', 'thumbnailUrl', 'activeVariantUrl']);
const SCENE_PATH_ARRAY_KEYS = new Set(['scriptPaths']);
let dataPlatformProjectServiceShuttingDown = false;
const openTaskControllers = new Set();
const openTasks = new Set();
/** 返回数据中台项目工作区；安装态与只读程序目录分离，开发态保持仓库根目录行为。 */
export function getDataPlatformEditorRoot() {
    const override = process.env[TEST_STORAGE_ROOT_ENV]?.trim();
    const overrideEnabled = process.env[TEST_STORAGE_OVERRIDE_GUARD_ENV] === '1';
    if (override && overrideEnabled)
        return path.resolve(override);
    return app.isPackaged
        ? path.join(app.getPath('userData'), DATA_PLATFORM_WORKSPACE_DIRECTORY)
        : app.getAppPath();
}
/** 从可信项目缓存打开工程，renderer 只允许提交项目 ID。 */
export async function openDataPlatformProject(project, baseUrl) {
    if (dataPlatformProjectServiceShuttingDown) {
        throw new Error('应用正在退出，无法打开数据中台项目。');
    }
    const controller = new AbortController();
    openTaskControllers.add(controller);
    const task = openDataPlatformProjectInternal(project, baseUrl, controller.signal);
    openTasks.add(task);
    try {
        return await task;
    }
    finally {
        openTaskControllers.delete(controller);
        openTasks.delete(task);
    }
}
/** 暴露模型同步重试给 IPC。 */
export function retryLatestDataPlatformModelSync() {
    return retryDataPlatformModelSync();
}
/** 暴露最近模型同步进度给晚挂载的 renderer。 */
export function getCurrentDataPlatformModelSyncProgress() {
    return getLatestDataPlatformModelSyncProgress();
}
/** 数据中台配置变更后清除旧地址对应的重试上下文。 */
export function clearDataPlatformProjectServiceRetryContext() {
    clearDataPlatformModelSyncRetryContext();
}
/** 应用退出时取消并等待工程打开与模型同步任务。 */
export async function disposeDataPlatformProjectTasks() {
    dataPlatformProjectServiceShuttingDown = true;
    for (const controller of openTaskControllers)
        controller.abort();
    await Promise.allSettled([...openTasks]);
    await disposeDataPlatformModelSync();
}
async function openDataPlatformProjectInternal(project, baseUrl, signal) {
    const editorRoot = getDataPlatformEditorRoot();
    await ensureWritableEditorRoot(editorRoot);
    await ensureProjectDirectories(editorRoot);
    let source = 'generated';
    let warning = null;
    let sceneFilePath = null;
    if (project.latestEditorProjectPackageUrl) {
        const openRoot = path.join(editorRoot, '.babylon-editor', `data-platform-open-${randomUUID()}`);
        const archivePath = path.join(openRoot, 'project-package.zip');
        const extractRoot = path.join(openRoot, 'extracted');
        assertPathInside(editorRoot, openRoot, '工程包暂存目录');
        await fs.rm(openRoot, { recursive: true, force: true });
        let preserveOpenRoot = false;
        try {
            await fs.mkdir(openRoot, { recursive: true });
            await downloadRemoteFile({
                baseUrl,
                remoteUrl: project.latestEditorProjectPackageUrl,
                destinationPath: archivePath,
                maxBytes: MAX_ARCHIVE_COMPRESSED_BYTES,
                signal,
                timeoutMs: PROJECT_DOWNLOAD_TIMEOUT_MS,
                context: `下载项目“${project.projectName}”工程包`,
            });
            await extractZipSecurely(archivePath, extractRoot, signal);
            const detection = await detectCurrentProjectPackage(extractRoot);
            if (detection.kind === 'current') {
                const materialized = await materializeCurrentProjectPackage({
                    editorRoot,
                    packageRoot: detection.packageRoot,
                    sceneSourcePath: detection.sceneFilePath,
                    project,
                    openRoot,
                });
                source = 'package';
                sceneFilePath = materialized.sceneFilePath;
                warning = materialized.warning;
            }
            else {
                warning = `${detection.reason}，已在本地创建当前格式空项目。`;
            }
        }
        catch (error) {
            preserveOpenRoot = error instanceof DataPlatformRollbackError;
            throw error;
        }
        finally {
            if (!preserveOpenRoot) {
                await fs.rm(openRoot, { recursive: true, force: true }).catch(() => undefined);
            }
        }
    }
    else {
        warning = '该项目没有可用工程包，已在本地创建当前格式空项目。';
    }
    if (source === 'generated') {
        await ensureGeneratedProjectMetadata(editorRoot);
        await activateProjectRoot(editorRoot);
    }
    else if (sceneFilePath) {
        await activateProjectRoot(editorRoot, sceneFilePath);
        await rememberRecentSceneFile(sceneFilePath, editorRoot);
    }
    const modelSyncStarted = startDataPlatformModelSync(baseUrl, editorRoot);
    return {
        projectRoot: editorRoot,
        sceneFilePath,
        source,
        warning,
        modelSyncStarted,
    };
}
async function ensureWritableEditorRoot(editorRoot) {
    let stat;
    try {
        await fs.mkdir(editorRoot, { recursive: true }).catch((error) => {
            if (!isNodeError(error) || error.code !== 'EEXIST')
                throw error;
        });
        stat = await fs.stat(editorRoot);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`数据中台工作目录无法创建或访问：${editorRoot}（${message}）`);
    }
    if (!stat.isDirectory())
        throw new Error(`数据中台工作路径不是目录：${editorRoot}`);
    const probePath = path.join(editorRoot, `.zending-write-probe-${randomUUID()}`);
    assertPathInside(editorRoot, probePath, '写权限探测路径');
    let handle = null;
    try {
        handle = await fs.open(probePath, 'wx');
        await handle.writeFile('zending');
        await handle.sync();
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`数据中台工作目录不可写：${editorRoot}。请检查当前用户对该目录的读写权限后重试。（${message}）`);
    }
    finally {
        if (handle)
            await handle.close().catch(() => undefined);
        await fs.rm(probePath, { force: true }).catch(() => undefined);
    }
}
async function detectCurrentProjectPackage(extractRoot) {
    const rootCandidate = await inspectPackageCandidate(extractRoot);
    if (rootCandidate.kind === 'current')
        return rootCandidate;
    const entries = await fs.readdir(extractRoot, { withFileTypes: true });
    const wrapperDirectories = entries.filter((entry) => entry.isDirectory() && entry.name !== '__MACOSX');
    const nonWrapperEntries = entries.filter((entry) => {
        if (entry.name === '__MACOSX' || entry.name === '.DS_Store')
            return false;
        return !entry.isDirectory();
    });
    if (wrapperDirectories.length === 1 && nonWrapperEntries.length === 0) {
        const wrappedCandidate = await inspectPackageCandidate(path.join(extractRoot, wrapperDirectories[0].name));
        if (wrappedCandidate.kind === 'current')
            return wrappedCandidate;
        if (await containsLegacyProjectFile(path.join(extractRoot, wrapperDirectories[0].name))) {
            return { kind: 'incompatible', reason: '工程包属于旧版 project.bjseditor 格式' };
        }
        return wrappedCandidate;
    }
    if (await containsLegacyProjectFile(extractRoot)) {
        return { kind: 'incompatible', reason: '工程包属于旧版 project.bjseditor 格式' };
    }
    return rootCandidate;
}
async function inspectPackageCandidate(packageRoot) {
    const metadataRoot = path.join(packageRoot, '.babylon-editor');
    const modelsRoot = path.join(packageRoot, 'Assets', 'Models');
    const environmentsRoot = path.join(packageRoot, 'Assets', 'Environments');
    const missing = [];
    if (!(await isDirectory(metadataRoot)))
        missing.push('.babylon-editor/');
    if (!(await isDirectory(modelsRoot)))
        missing.push('Assets/Models/');
    if (!(await isDirectory(environmentsRoot)))
        missing.push('Assets/Environments/');
    if (missing.length > 0) {
        return { kind: 'incompatible', reason: `工程包缺少当前编辑器目录：${missing.join('、')}` };
    }
    const sceneFiles = await findSceneFiles(packageRoot);
    if (sceneFiles.length !== 1) {
        return { kind: 'incompatible', reason: `工程包必须且只能包含一个 .scene.json，当前发现 ${sceneFiles.length} 个` };
    }
    try {
        const parsed = JSON.parse(await fs.readFile(sceneFiles[0], 'utf-8'));
        if (!isPlainObject(parsed) || parsed.version !== 1 || !isPlainObject(parsed.scene)) {
            return { kind: 'incompatible', reason: '工程包中的场景文件不是当前编辑器场景格式' };
        }
    }
    catch {
        return { kind: 'incompatible', reason: '工程包中的场景文件不是有效 JSON' };
    }
    return { kind: 'current', packageRoot, sceneFilePath: sceneFiles[0] };
}
async function materializeCurrentProjectPackage(options) {
    const transactionRoot = path.join(options.openRoot, 'materialize');
    const stagedRoot = path.join(transactionRoot, 'staged');
    const backupRoot = path.join(transactionRoot, 'backup');
    const promotionItems = [];
    await fs.mkdir(stagedRoot, { recursive: true });
    await fs.mkdir(backupRoot, { recursive: true });
    const packageDirectories = await collectPackageDirectories(options.packageRoot);
    for (const packageDirectory of packageDirectories) {
        const relativePath = path.relative(options.packageRoot, packageDirectory);
        const targetPath = path.join(options.editorRoot, relativePath);
        const stagedPath = path.join(stagedRoot, relativePath);
        const backupPath = path.join(backupRoot, relativePath);
        assertPathInside(options.editorRoot, targetPath, '工程包资产目标');
        assertPathInside(transactionRoot, stagedPath, '工程包资产暂存路径');
        await fs.mkdir(path.dirname(stagedPath), { recursive: true });
        await fs.cp(packageDirectory, stagedPath, { recursive: true, errorOnExist: true, force: false });
        promotionItems.push(createPromotionItem('directory', targetPath, stagedPath, backupPath));
    }
    const sceneDirectory = path.join(options.editorRoot, 'Scenes', 'DataPlatform', String(options.project.id));
    const sceneFileName = sanitizeSceneFileName(path.basename(options.sceneSourcePath), options.project.id);
    const sceneTargetPath = path.join(sceneDirectory, sceneFileName);
    const sceneStagedPath = path.join(stagedRoot, 'Scenes', 'DataPlatform', String(options.project.id), sceneFileName);
    const sceneBackupPath = path.join(backupRoot, 'Scenes', 'DataPlatform', String(options.project.id), sceneFileName);
    assertPathInside(options.editorRoot, sceneTargetPath, '数据中台场景目标');
    const sceneContent = await rewriteSceneForEditorRoot(options.sceneSourcePath, options.editorRoot);
    await fs.mkdir(path.dirname(sceneStagedPath), { recursive: true });
    await fs.writeFile(sceneStagedPath, sceneContent, 'utf-8');
    promotionItems.push(createPromotionItem('file', sceneTargetPath, sceneStagedPath, sceneBackupPath));
    try {
        for (const item of promotionItems)
            await promoteItem(item);
        const rebuilt = await scanCurrentModelLibrary(options.editorRoot);
        const stagedIndexPath = path.join(stagedRoot, '.babylon-editor', 'asset-index.json');
        const indexTargetPath = getProjectAssetIndexPath(options.editorRoot);
        const indexBackupPath = path.join(backupRoot, '.babylon-editor', 'asset-index.json');
        await fs.mkdir(path.dirname(stagedIndexPath), { recursive: true });
        await fs.writeFile(stagedIndexPath, `${JSON.stringify({ version: 2, assets: rebuilt.assets }, null, 2)}\n`, 'utf-8');
        const indexItem = createPromotionItem('file', indexTargetPath, stagedIndexPath, indexBackupPath);
        promotionItems.push(indexItem);
        await promoteItem(indexItem);
        return {
            sceneFilePath: sceneTargetPath,
            warning: rebuilt.skipped.length > 0
                ? `工程已打开，但有 ${rebuilt.skipped.length} 个本地模型包未通过扫描：${rebuilt.skipped.slice(0, 3).join('；')}`
                : null,
        };
    }
    catch (error) {
        const rollbackErrors = await rollbackPromotionItems(promotionItems);
        const message = error instanceof Error ? error.message : String(error);
        if (rollbackErrors.length > 0) {
            throw new DataPlatformRollbackError(`${message}；工程写入回滚不完整：${rollbackErrors.join('；')}；已保留恢复目录：${backupRoot}`);
        }
        throw error;
    }
}
async function collectPackageDirectories(packageRoot) {
    const result = [];
    const modelsRoot = path.join(packageRoot, 'Assets', 'Models');
    const environmentsRoot = path.join(packageRoot, 'Assets', 'Environments');
    for (const entry of await fs.readdir(modelsRoot, { withFileTypes: true })) {
        if (!entry.isDirectory())
            continue;
        const entryPath = path.join(modelsRoot, entry.name);
        if (entry.name.toLowerCase() !== 'combomodels') {
            result.push(entryPath);
            continue;
        }
        for (const comboEntry of await fs.readdir(entryPath, { withFileTypes: true })) {
            if (comboEntry.isDirectory())
                result.push(path.join(entryPath, comboEntry.name));
        }
    }
    for (const entry of await fs.readdir(environmentsRoot, { withFileTypes: true })) {
        if (entry.isDirectory())
            result.push(path.join(environmentsRoot, entry.name));
    }
    return result;
}
async function rewriteSceneForEditorRoot(sceneSourcePath, editorRoot) {
    const parsed = JSON.parse(await fs.readFile(sceneSourcePath, 'utf-8'));
    const rewritten = rewriteSceneValue(parsed, null, editorRoot);
    return `${JSON.stringify(rewritten, null, 2)}\n`;
}
function rewriteSceneValue(value, key, editorRoot) {
    if (typeof value === 'string') {
        if (key && SCENE_URL_KEYS.has(key))
            return rewriteSceneAssetUrl(value, editorRoot);
        if (key && SCENE_PATH_KEYS.has(key))
            return rewriteSceneAssetPath(value, editorRoot) ?? value;
        return value;
    }
    if (Array.isArray(value)) {
        if (key && SCENE_PATH_ARRAY_KEYS.has(key)) {
            return value.map((item) => typeof item === 'string' ? rewriteSceneAssetPath(item, editorRoot) ?? item : item);
        }
        return value.map((item) => rewriteSceneValue(item, key, editorRoot));
    }
    if (!isPlainObject(value))
        return value;
    const rewritten = {};
    for (const [childKey, childValue] of Object.entries(value)) {
        rewritten[childKey] = rewriteSceneValue(childValue, childKey, editorRoot);
    }
    return rewritten;
}
function rewriteSceneAssetUrl(value, editorRoot) {
    if (!value.startsWith(LOCAL_ASSET_URL_PREFIX))
        return value;
    try {
        const decoded = decodeURIComponent(value.slice(LOCAL_ASSET_URL_PREFIX.length));
        const rewrittenPath = rewriteSceneAssetPath(decoded, editorRoot);
        return rewrittenPath ? encodeAssetUrl(rewrittenPath) : value;
    }
    catch {
        return value;
    }
}
function rewriteSceneAssetPath(value, editorRoot) {
    const normalized = value.trim().replace(/\\/g, '/');
    const match = normalized.match(/(?:^|\/)(Assets\/(?:Models|Environments)(?:\/.*|$))/i);
    if (!match)
        return null;
    const relativeAssetPath = path.posix.normalize(match[1]);
    if (!/^Assets\/(?:Models|Environments)(?:\/|$)/i.test(relativeAssetPath))
        return null;
    const targetPath = path.resolve(editorRoot, ...relativeAssetPath.split('/'));
    return isPathInside(editorRoot, targetPath) ? targetPath : null;
}
async function scanCurrentModelLibrary(editorRoot) {
    const assets = [];
    const skipped = [];
    const modelsRoot = getProjectModelsRoot(editorRoot);
    const environmentsRoot = getProjectEnvironmentsRoot(editorRoot);
    const candidates = [];
    for (const entry of await safeReadDirectories(modelsRoot)) {
        const entryPath = path.join(modelsRoot, entry);
        if (entry.toLowerCase() !== 'combomodels') {
            candidates.push({ packagePath: entryPath, libraryKind: 'model' });
            continue;
        }
        for (const comboEntry of await safeReadDirectories(entryPath)) {
            candidates.push({ packagePath: path.join(entryPath, comboEntry), libraryKind: 'model' });
        }
    }
    for (const entry of await safeReadDirectories(environmentsRoot)) {
        candidates.push({ packagePath: path.join(environmentsRoot, entry), libraryKind: 'environment' });
    }
    for (const candidate of candidates) {
        try {
            const result = await scanModelPackage(candidate.packagePath);
            if (result.asset) {
                assets.push({
                    ...result.asset,
                    assetRevision: `${Date.now().toString(36)}-${randomUUID()}`,
                    kind: 'model',
                    libraryKind: candidate.libraryKind,
                });
            }
            else if (result.skipped) {
                skipped.push(`${path.basename(candidate.packagePath)}：${result.skipped.reason}`);
            }
        }
        catch (error) {
            skipped.push(`${path.basename(candidate.packagePath)}：${error instanceof Error ? error.message : String(error)}`);
        }
    }
    return { assets, skipped };
}
async function ensureGeneratedProjectMetadata(editorRoot) {
    const indexPath = getProjectAssetIndexPath(editorRoot);
    if (await pathExists(indexPath))
        return;
    const rebuilt = await scanCurrentModelLibrary(editorRoot);
    await writeProjectAssetIndex(editorRoot, { version: 2, assets: rebuilt.assets });
}
function createPromotionItem(type, target, staged, backup) {
    return { type, target, staged, backup, previousMoved: false, stagedMoved: false };
}
async function promoteItem(item) {
    await fs.mkdir(path.dirname(item.target), { recursive: true });
    if (await pathExists(item.target)) {
        await fs.mkdir(path.dirname(item.backup), { recursive: true });
        await fs.rename(item.target, item.backup);
        item.previousMoved = true;
    }
    await fs.rename(item.staged, item.target);
    item.stagedMoved = true;
}
async function rollbackPromotionItems(items) {
    const errors = [];
    for (const item of [...items].reverse()) {
        try {
            if (item.stagedMoved && await pathExists(item.target)) {
                await fs.rm(item.target, { recursive: item.type === 'directory', force: true });
            }
            if (item.previousMoved && await pathExists(item.backup)) {
                await fs.mkdir(path.dirname(item.target), { recursive: true });
                await fs.rename(item.backup, item.target);
            }
        }
        catch (error) {
            errors.push(error instanceof Error ? error.message : String(error));
        }
    }
    return errors;
}
async function findSceneFiles(root) {
    const scenes = [];
    const queue = [root];
    while (queue.length > 0) {
        const current = queue.shift();
        if (!current)
            break;
        for (const entry of await fs.readdir(current, { withFileTypes: true })) {
            const entryPath = path.join(current, entry.name);
            if (entry.isDirectory()) {
                queue.push(entryPath);
            }
            else if (entry.isFile() && entry.name.toLowerCase().endsWith('.scene.json')) {
                scenes.push(entryPath);
            }
        }
    }
    return scenes;
}
async function containsLegacyProjectFile(root) {
    const queue = [root];
    while (queue.length > 0) {
        const current = queue.shift();
        if (!current)
            break;
        for (const entry of await fs.readdir(current, { withFileTypes: true })) {
            if (entry.name.toLowerCase() === 'project.bjseditor' && entry.isFile())
                return true;
            if (entry.isDirectory())
                queue.push(path.join(current, entry.name));
        }
    }
    return false;
}
async function safeReadDirectories(root) {
    try {
        const entries = await fs.readdir(root, { withFileTypes: true });
        return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    }
    catch (error) {
        if (isNodeError(error) && error.code === 'ENOENT')
            return [];
        throw error;
    }
}
function sanitizeSceneFileName(value, projectId) {
    let name = value
        .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
        .trim()
        .replace(/[. ]+$/g, '')
        .slice(0, 180);
    if (!name.toLowerCase().endsWith('.scene.json'))
        name = `data-platform-${projectId}.scene.json`;
    const stem = name.split('.', 1)[0]?.toUpperCase() ?? '';
    if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem))
        name = `_${name}`;
    return name || `data-platform-${projectId}.scene.json`;
}
async function isDirectory(targetPath) {
    try {
        return (await fs.stat(targetPath)).isDirectory();
    }
    catch {
        return false;
    }
}
async function pathExists(targetPath) {
    try {
        await fs.access(targetPath);
        return true;
    }
    catch {
        return false;
    }
}
function isPlainObject(value) {
    return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}
function isNodeError(error) {
    return error instanceof Error && 'code' in error;
}
