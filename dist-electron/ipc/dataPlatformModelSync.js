import { BrowserWindow } from 'electron';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { encodeAssetUrl } from './assetRegistry.js';
import { getProjectAssetIndexPath, getProjectEnvironmentsRoot, getProjectModelsRoot, } from './projectAssetStore.js';
import { scanModelPackage, validateGlbModelFile } from './modelPackageScanner.js';
import { assertPathInside, DataPlatformRollbackError, downloadRemoteFile, requestDataPlatformJson, } from './dataPlatformTransfer.js';
const MODEL_QUERY_PATH = 'api/v1/models/query';
const ENVIRONMENT_MODEL_QUERY_PATH = 'api/v1/env-models/query';
const COMBO_MODEL_QUERY_PATH = 'api/v1/combo-models/query';
const MODEL_QUERY_PAGE_SIZE = 100;
const MAX_MODEL_QUERY_PAGES = 1_000;
const MAX_MODEL_RECORDS = 100_000;
const MAX_CONCURRENT_DOWNLOADS = 4;
const QUERY_TIMEOUT_MS = 20_000;
const FILE_DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
const MAX_MODEL_FILE_BYTES = 512 * 1024 * 1024;
const MAX_METADATA_FILE_BYTES = 10 * 1024 * 1024;
const MAX_SCRIPT_FILE_BYTES = 10 * 1024 * 1024;
const MAX_THUMBNAIL_FILE_BYTES = 20 * 1024 * 1024;
const MAX_SYNC_DOWNLOAD_BYTES = 8 * 1024 * 1024 * 1024;
const THUMBNAIL_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const MODEL_EXTENSIONS = new Set(['.glb', '.gltf']);
// Windows 杀毒或索引进程可能短暂持有模型文件且不共享删除权限，只对这类占用错误做有限退避。
const WINDOWS_RENAME_RETRY_DELAYS_MS = [50, 100, 200, 400, 800, 1_200, 1_600];
const WINDOWS_RENAME_RETRY_ERROR_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const MIME_THUMBNAIL_EXTENSIONS = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/webp': '.webp',
};
let activeModelSync = null;
let latestModelSyncProgress = null;
let lastModelSyncContext = null;
let modelSyncShuttingDown = false;
/** 启动全局模型同步；已有任务运行时直接复用，不创建并发覆盖任务。 */
export function startDataPlatformModelSync(baseUrl, editorRoot) {
    if (modelSyncShuttingDown)
        return false;
    if (activeModelSync)
        return true;
    const context = { baseUrl, editorRoot };
    lastModelSyncContext = context;
    const runId = randomUUID();
    const controller = new AbortController();
    const promise = runDataPlatformModelSync(runId, context, controller.signal)
        .catch((error) => {
        if (controller.signal.aborted && modelSyncShuttingDown)
            return;
        const message = toErrorMessage(error);
        updateModelSyncProgress({
            runId,
            phase: 'failed',
            completed: latestModelSyncProgress?.runId === runId ? latestModelSyncProgress.completed : 0,
            total: latestModelSyncProgress?.runId === runId ? latestModelSyncProgress.total : 0,
            message: '数据中台模型同步失败，已保留原模型库。',
            error: message,
        });
    })
        .finally(() => {
        if (activeModelSync?.runId === runId)
            activeModelSync = null;
    });
    activeModelSync = { runId, controller, promise };
    return true;
}
/** 失败后按最近一次 Base URL 与编辑器目录重新发起同步。 */
export function retryDataPlatformModelSync() {
    if (activeModelSync || !lastModelSyncContext || modelSyncShuttingDown)
        return false;
    return startDataPlatformModelSync(lastModelSyncContext.baseUrl, lastModelSyncContext.editorRoot);
}
/** 返回最近进度快照，供晚于任务启动挂载的 renderer 补读。 */
export function getLatestDataPlatformModelSyncProgress() {
    return latestModelSyncProgress ? { ...latestModelSyncProgress } : null;
}
/** 配置地址变化后清除失败任务的重试上下文，运行中的任务不受影响。 */
export function clearDataPlatformModelSyncRetryContext() {
    lastModelSyncContext = null;
}
/** 应用退出时取消并等待当前同步任务，避免 staging 残留或推广事务中断。 */
export async function disposeDataPlatformModelSync() {
    modelSyncShuttingDown = true;
    const active = activeModelSync;
    if (!active)
        return;
    active.controller.abort();
    await active.promise.catch(() => undefined);
}
async function runDataPlatformModelSync(runId, context, signal) {
    updateModelSyncProgress({
        runId,
        phase: 'querying',
        completed: 0,
        total: 0,
        message: '正在查询数据中台普通模型…',
        error: null,
    });
    const normalModels = await queryAllNormalModels(context.baseUrl, signal);
    updateModelSyncProgress({
        runId,
        phase: 'querying',
        completed: 0,
        total: 0,
        message: `已查询 ${normalModels.length} 个普通模型，正在查询环境模型…`,
        error: null,
    });
    const environmentModels = await queryAllEnvironmentModels(context.baseUrl, signal);
    updateModelSyncProgress({
        runId,
        phase: 'querying',
        completed: 0,
        total: 0,
        message: `已查询 ${environmentModels.length} 个环境模型，正在查询组合模型…`,
        error: null,
    });
    const comboModels = await queryAllComboModels(context.baseUrl, signal);
    const records = [...normalModels, ...environmentModels, ...comboModels];
    assertUniqueModelRecords(records);
    const stagingRoot = path.join(context.editorRoot, '.babylon-editor', `data-platform-model-sync-${runId}`);
    assertPathInside(context.editorRoot, stagingRoot, '模型同步暂存目录');
    await fs.rm(stagingRoot, { recursive: true, force: true });
    let preserveStaging = false;
    try {
        const prepared = await prepareDownloadPlan(stagingRoot, records);
        const jobs = createDownloadJobs(prepared);
        let completedDownloads = 0;
        let downloadedBytes = 0;
        const downloadProgressStep = Math.max(1, Math.ceil(jobs.length / 100));
        updateModelSyncProgress({
            runId,
            phase: 'downloading',
            completed: 0,
            total: jobs.length,
            message: `正在下载 ${records.length} 个模型资源包…`,
            error: null,
        });
        await runWithConcurrency(jobs, MAX_CONCURRENT_DOWNLOADS, async (job) => {
            const result = await downloadRemoteFile({
                baseUrl: context.baseUrl,
                remoteUrl: job.remoteUrl,
                destinationPath: job.destinationPath,
                maxBytes: maxBytesForDownloadKind(job.kind),
                signal,
                timeoutMs: FILE_DOWNLOAD_TIMEOUT_MS,
                context: `下载${job.label}`,
                onBytes: (bytes) => {
                    downloadedBytes += bytes;
                    if (downloadedBytes > MAX_SYNC_DOWNLOAD_BYTES) {
                        throw new Error('模型同步下载总量超过 8 GB 限制。');
                    }
                },
            });
            if (job.kind === 'thumbnail') {
                job.preparedPackage.thumbnailPath = await finalizeThumbnailPath(job.destinationPath, result.contentType, job.remoteUrl);
            }
            completedDownloads += 1;
            if (completedDownloads === jobs.length || completedDownloads % downloadProgressStep === 0) {
                updateModelSyncProgress({
                    runId,
                    phase: 'downloading',
                    completed: completedDownloads,
                    total: jobs.length,
                    message: `已下载 ${completedDownloads}/${jobs.length} 个模型文件。`,
                    error: null,
                });
            }
        });
        updateModelSyncProgress({
            runId,
            phase: 'validating',
            completed: completedDownloads,
            total: jobs.length,
            message: '正在校验模型扩展名、文件结构与资产包…',
            error: null,
        });
        const stagedAssets = await validatePreparedPackages(prepared, runId, signal);
        const finalAssets = stagedAssets.map((asset) => relocateAssetEntry(asset, stagingRoot, context.editorRoot));
        const finalIndex = { version: 2, assets: finalAssets };
        const stagedIndexPath = path.join(stagingRoot, '.babylon-editor', 'asset-index.json');
        await fs.mkdir(path.dirname(stagedIndexPath), { recursive: true });
        await fs.writeFile(stagedIndexPath, `${JSON.stringify(finalIndex, null, 2)}\n`, 'utf-8');
        updateModelSyncProgress({
            runId,
            phase: 'promoting',
            completed: completedDownloads,
            total: jobs.length,
            message: '正在原子替换全局模型库与资产索引…',
            error: null,
        });
        await promoteModelLibrary({
            editorRoot: context.editorRoot,
            stagingRoot,
            stagedModelsRoot: path.join(stagingRoot, 'Assets', 'Models'),
            stagedEnvironmentsRoot: path.join(stagingRoot, 'Assets', 'Environments'),
            stagedIndexPath,
            runId,
        });
        updateModelSyncProgress({
            runId,
            phase: 'completed',
            completed: jobs.length,
            total: jobs.length,
            message: `模型同步完成：普通 ${normalModels.length}、环境 ${environmentModels.length}、组合 ${comboModels.length}。`,
            error: null,
        });
    }
    catch (error) {
        preserveStaging = error instanceof DataPlatformRollbackError;
        throw error;
    }
    finally {
        if (!preserveStaging) {
            await fs.rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
        }
    }
}
async function queryAllNormalModels(baseUrl, signal) {
    const rawRecords = await queryAllPages(baseUrl, MODEL_QUERY_PATH, '普通模型', 'modelName', signal);
    return rawRecords.map((value, index) => normalizeNormalModelRecord(value, index));
}
async function queryAllEnvironmentModels(baseUrl, signal) {
    const rawRecords = await queryAllPages(baseUrl, ENVIRONMENT_MODEL_QUERY_PATH, '环境模型', 'modelName', signal);
    return rawRecords.map((value, index) => normalizeEnvironmentModelRecord(value, index));
}
async function queryAllComboModels(baseUrl, signal) {
    const rawRecords = await queryAllPages(baseUrl, COMBO_MODEL_QUERY_PATH, '组合模型', 'comboModelName', signal);
    return rawRecords.map((value, index) => normalizeComboModelRecord(value, index));
}
async function queryAllPages(baseUrl, endpointPath, label, nameField, signal) {
    const records = [];
    for (let pageNum = 1; pageNum <= MAX_MODEL_QUERY_PAGES; pageNum += 1) {
        const payload = await requestDataPlatformJson({
            baseUrl,
            endpointPath,
            body: {
                pageNum,
                pageSize: MODEL_QUERY_PAGE_SIZE,
                [nameField]: '',
                excludeIds: [],
            },
            signal,
            timeoutMs: QUERY_TIMEOUT_MS,
            context: `查询数据中台${label}`,
        });
        const page = normalizePagedResponse(payload, label);
        records.push(...page.records);
        if (records.length > MAX_MODEL_RECORDS) {
            throw new Error(`数据中台${label}数量超过 ${MAX_MODEL_RECORDS} 项限制。`);
        }
        if (page.records.length === 0 || page.records.length < MODEL_QUERY_PAGE_SIZE || records.length >= page.total) {
            return records;
        }
    }
    throw new Error(`数据中台${label}分页超过 ${MAX_MODEL_QUERY_PAGES} 页限制。`);
}
function normalizePagedResponse(value, label) {
    if (!isPlainObject(value))
        throw new Error(`数据中台${label}响应结构不正确。`);
    if (value.success !== true) {
        const message = normalizeOptionalString(value.message) ?? `数据中台${label}查询失败。`;
        throw new Error(message);
    }
    if (!isPlainObject(value.data) || !Array.isArray(value.data.records)) {
        throw new Error(`数据中台${label}响应缺少 data.records。`);
    }
    return {
        records: value.data.records,
        total: normalizeNonNegativeInteger(value.data.total, value.data.records.length),
    };
}
function normalizeNormalModelRecord(value, index) {
    const record = requireRecord(value, '普通模型', index);
    const id = normalizeRequiredId(record.id, '普通模型', index);
    const scripts = normalizeModelScripts(record, index);
    return {
        kind: 'model',
        id,
        name: normalizeOptionalString(record.modelName) ?? `模型-${id}`,
        fileName: normalizeOptionalString(record.fileName),
        fileUrl: normalizeRequiredUrl(record.fileUrl, '普通模型', index),
        metaFileUrl: normalizeOptionalString(record.metaFileUrl),
        thumbnailUrl: normalizeOptionalString(record.thumbnailUrl),
        scripts,
    };
}
function normalizeEnvironmentModelRecord(value, index) {
    const record = requireRecord(value, '环境模型', index);
    const id = normalizeRequiredId(record.id, '环境模型', index);
    return {
        kind: 'environment',
        id,
        name: normalizeOptionalString(record.modelName) ?? `环境-${id}`,
        fileName: normalizeOptionalString(record.fileName),
        fileUrl: normalizeRequiredUrl(record.fileUrl, '环境模型', index),
        thumbnailUrl: normalizeOptionalString(record.thumbnailUrl),
    };
}
function normalizeComboModelRecord(value, index) {
    const record = requireRecord(value, '组合模型', index);
    const id = normalizeRequiredId(record.id, '组合模型', index);
    return {
        kind: 'combo',
        id,
        name: normalizeOptionalString(record.comboModelName) ?? `组合-${id}`,
        fileName: normalizeOptionalString(record.fileName),
        fileUrl: normalizeRequiredUrl(record.fileUrl, '组合模型', index),
        thumbnailUrl: normalizeOptionalString(record.thumbnailUrl),
    };
}
function normalizeModelScripts(record, index) {
    const scripts = [];
    const seenUrls = new Set();
    const append = (fileName, fileUrl) => {
        const url = normalizeOptionalString(fileUrl);
        if (!url || seenUrls.has(url))
            return;
        seenUrls.add(url);
        scripts.push({ fileName: normalizeOptionalString(fileName), fileUrl: url });
    };
    if (Array.isArray(record.scriptFiles)) {
        for (const item of record.scriptFiles) {
            if (!isPlainObject(item))
                throw new Error(`数据中台普通模型第 ${index + 1} 项 scriptFiles 无效。`);
            append(item.fileName, item.fileUrl);
        }
    }
    // 新接口的 scriptFiles 为权威列表；仅在列表没有有效项时读取旧单脚本兼容字段。
    if (scripts.length === 0) {
        const legacyNames = splitLegacyScriptField(record.scriptFileName);
        const legacyUrls = splitLegacyScriptField(record.scriptFileUrl);
        if (legacyUrls.length > 1) {
            legacyUrls.forEach((url, legacyIndex) => append(legacyNames[legacyIndex] ?? null, url));
        }
        else {
            append(legacyNames[0] ?? record.scriptFileName, legacyUrls[0] ?? record.scriptFileUrl);
        }
    }
    return scripts;
}
function splitLegacyScriptField(value) {
    const normalized = normalizeOptionalString(value);
    return normalized
        ? normalized.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)
        : [];
}
async function prepareDownloadPlan(stagingRoot, records) {
    const modelsRoot = path.join(stagingRoot, 'Assets', 'Models');
    const environmentsRoot = path.join(stagingRoot, 'Assets', 'Environments');
    const comboRoot = path.join(modelsRoot, 'ComboModels');
    await Promise.all([
        fs.mkdir(modelsRoot, { recursive: true }),
        fs.mkdir(environmentsRoot, { recursive: true }),
        fs.mkdir(comboRoot, { recursive: true }),
    ]);
    return records.map((record) => {
        const prefix = record.kind === 'model' ? 'Model' : record.kind === 'environment' ? 'Env' : 'Combo';
        const directoryName = `${prefix}-${record.id}-${sanitizePathSegment(record.name)}`;
        const parentRoot = record.kind === 'environment' ? environmentsRoot : record.kind === 'combo' ? comboRoot : modelsRoot;
        const packagePath = path.join(parentRoot, directoryName);
        assertPathInside(stagingRoot, packagePath, '模型包暂存路径');
        const mainFileName = normalizeModelFileName(record.fileName, record.fileUrl, record.id);
        return {
            record,
            packagePath,
            mainFilePath: path.join(packagePath, mainFileName),
            metadataPath: path.join(packagePath, 'meta.json'),
            thumbnailPath: null,
        };
    });
}
function createDownloadJobs(packages) {
    const jobs = [];
    for (const prepared of packages) {
        const label = `${modelKindLabel(prepared.record.kind)}“${prepared.record.name}”`;
        jobs.push({
            label: `${label}主文件`,
            remoteUrl: prepared.record.fileUrl,
            destinationPath: prepared.mainFilePath,
            kind: 'model',
            preparedPackage: prepared,
        });
        if (prepared.record.kind === 'model' && prepared.record.metaFileUrl) {
            jobs.push({
                label: `${label} meta.json`,
                remoteUrl: prepared.record.metaFileUrl,
                destinationPath: prepared.metadataPath,
                kind: 'metadata',
                preparedPackage: prepared,
            });
        }
        if (prepared.record.kind === 'model') {
            const usedNames = new Set();
            prepared.record.scripts.forEach((script, index) => {
                const fileName = normalizeOptionalTypeScriptFileName(script.fileName, script.fileUrl, index, usedNames);
                if (!fileName)
                    return;
                jobs.push({
                    label: `${label}脚本 ${fileName}`,
                    remoteUrl: script.fileUrl,
                    destinationPath: path.join(prepared.packagePath, fileName),
                    kind: 'script',
                    preparedPackage: prepared,
                });
            });
        }
        if (prepared.record.thumbnailUrl) {
            const extension = thumbnailExtensionFromUrl(prepared.record.thumbnailUrl);
            jobs.push({
                label: `${label}缩略图`,
                remoteUrl: prepared.record.thumbnailUrl,
                destinationPath: path.join(prepared.packagePath, `thumbnail${extension ?? '.download'}`),
                kind: 'thumbnail',
                preparedPackage: prepared,
            });
        }
    }
    return jobs;
}
async function finalizeThumbnailPath(destinationPath, contentType, remoteUrl) {
    const currentExtension = path.extname(destinationPath).toLowerCase();
    if (THUMBNAIL_EXTENSIONS.has(currentExtension))
        return destinationPath;
    const inferredExtension = MIME_THUMBNAIL_EXTENSIONS[contentType] ?? thumbnailExtensionFromUrl(remoteUrl);
    if (!inferredExtension || !THUMBNAIL_EXTENSIONS.has(inferredExtension)) {
        throw new Error('数据中台缩略图扩展名或 Content-Type 不受支持。');
    }
    const finalPath = path.join(path.dirname(destinationPath), `thumbnail${inferredExtension}`);
    await fs.rename(destinationPath, finalPath);
    return finalPath;
}
async function validatePreparedPackages(packages, runId, signal) {
    const assets = [];
    for (const prepared of packages) {
        if (signal.aborted)
            throw new Error('数据中台任务已取消。');
        await normalizeLocalMetadata(prepared);
        await validateModelFile(prepared.mainFilePath);
        const scanResult = await scanModelPackage(prepared.packagePath);
        if (!scanResult.asset) {
            throw new Error(`${modelKindLabel(prepared.record.kind)}“${prepared.record.name}”校验失败：${scanResult.skipped?.reason ?? '无法扫描模型包。'}`);
        }
        assets.push({
            ...scanResult.asset,
            displayName: prepared.record.name,
            assetRevision: `${runId}-${prepared.record.kind}-${prepared.record.id}`,
            kind: 'model',
            libraryKind: prepared.record.kind === 'environment' ? 'environment' : 'model',
        });
    }
    return assets;
}
async function normalizeLocalMetadata(prepared) {
    let metadata = {};
    try {
        const content = await fs.readFile(prepared.metadataPath, 'utf-8');
        const parsed = JSON.parse(content);
        if (!isPlainObject(parsed))
            throw new Error('meta.json 根节点必须是对象。');
        metadata = parsed;
    }
    catch (error) {
        if (!isNodeError(error) || error.code !== 'ENOENT') {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`${modelKindLabel(prepared.record.kind)}“${prepared.record.name}” meta.json 无效：${message}`);
        }
    }
    if (metadata.lengthUnit === undefined || metadata.lengthUnit === null || metadata.lengthUnit === '') {
        metadata.lengthUnit = 'meter';
    }
    if (prepared.thumbnailPath) {
        metadata.thumbnail = path.basename(prepared.thumbnailPath);
    }
    await fs.writeFile(prepared.metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf-8');
}
async function validateModelFile(filePath) {
    const extension = path.extname(filePath).toLowerCase();
    if (!MODEL_EXTENSIONS.has(extension))
        throw new Error(`模型扩展名不受支持：${extension || '无扩展名'}`);
    if (extension === '.glb') {
        if (!(await validateGlbModelFile(filePath)))
            throw new Error(`GLB 文件结构无效或已损坏：${path.basename(filePath)}`);
        return;
    }
    try {
        const parsed = JSON.parse(await fs.readFile(filePath, 'utf-8'));
        if (!isPlainObject(parsed) || !isPlainObject(parsed.asset))
            throw new Error('缺少 glTF asset 节点。');
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`glTF 文件无效：${path.basename(filePath)}（${message}）`);
    }
}
function relocateAssetEntry(asset, stagingRoot, editorRoot) {
    const relocate = (value) => {
        if (!value)
            return undefined;
        const relative = path.relative(stagingRoot, value);
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
            throw new Error(`暂存资产路径无法迁移：${value}`);
        }
        return path.join(editorRoot, relative);
    };
    const finalPath = relocate(asset.path);
    if (!finalPath)
        throw new Error('暂存资产缺少主模型路径。');
    const finalScriptPaths = asset.scriptPaths?.map((item) => relocate(item)).filter((item) => Boolean(item));
    const finalThumbnailPath = relocate(asset.thumbnailPath);
    return {
        ...asset,
        id: finalPath,
        path: finalPath,
        sourceUrl: encodeAssetUrl(finalPath),
        packagePath: relocate(asset.packagePath),
        metadataPath: relocate(asset.metadataPath),
        thumbnailPath: finalThumbnailPath,
        thumbnailUrl: finalThumbnailPath ? encodeAssetUrl(finalThumbnailPath) : undefined,
        scriptPaths: finalScriptPaths,
        scriptAssets: finalScriptPaths?.map((scriptPath) => ({
            path: scriptPath,
            sourceUrl: encodeAssetUrl(scriptPath),
            name: path.basename(scriptPath),
        })),
    };
}
async function promoteModelLibrary(options) {
    const backupRoot = path.join(options.stagingRoot, 'rollback');
    const items = [
        {
            type: 'directory',
            target: getProjectModelsRoot(options.editorRoot),
            staged: options.stagedModelsRoot,
            backup: path.join(backupRoot, 'Models'),
        },
        {
            type: 'directory',
            target: getProjectEnvironmentsRoot(options.editorRoot),
            staged: options.stagedEnvironmentsRoot,
            backup: path.join(backupRoot, 'Environments'),
        },
        {
            type: 'file',
            target: getProjectAssetIndexPath(options.editorRoot),
            staged: options.stagedIndexPath,
            backup: path.join(backupRoot, 'asset-index.json'),
        },
    ];
    const states = items.map((item) => ({ item, previousMoved: false, stagedMoved: false }));
    await fs.mkdir(backupRoot, { recursive: true });
    try {
        for (const state of states) {
            assertPathInside(options.editorRoot, state.item.target, '全局模型推广目标');
            await fs.mkdir(path.dirname(state.item.target), { recursive: true });
            if (await pathExists(state.item.target)) {
                await fs.mkdir(path.dirname(state.item.backup), { recursive: true });
                await renamePathWithWindowsRetry(state.item.target, state.item.backup);
                state.previousMoved = true;
            }
            await renamePathWithWindowsRetry(state.item.staged, state.item.target);
            state.stagedMoved = true;
        }
    }
    catch (error) {
        const rollbackErrors = [];
        for (const state of [...states].reverse()) {
            try {
                if (state.stagedMoved && await pathExists(state.item.target)) {
                    await fs.rm(state.item.target, { recursive: state.item.type === 'directory', force: true });
                }
                if (state.previousMoved && await pathExists(state.item.backup)) {
                    await renamePathWithWindowsRetry(state.item.backup, state.item.target);
                }
            }
            catch (rollbackError) {
                rollbackErrors.push(toErrorMessage(rollbackError));
            }
        }
        const message = toErrorMessage(error);
        if (rollbackErrors.length > 0) {
            throw new DataPlatformRollbackError(`${message}；模型库回滚不完整：${rollbackErrors.join('；')}；已保留恢复目录：${backupRoot}`);
        }
        throw error;
    }
}
function updateModelSyncProgress(progress) {
    latestModelSyncProgress = { ...progress };
    for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) {
            window.webContents.send('data-platform:modelSyncProgress', progress);
        }
    }
}
async function runWithConcurrency(values, concurrency, worker) {
    let nextIndex = 0;
    let firstError = null;
    const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
        while (firstError === null && nextIndex < values.length) {
            const currentIndex = nextIndex;
            nextIndex += 1;
            try {
                await worker(values[currentIndex]);
            }
            catch (error) {
                if (firstError === null)
                    firstError = error;
            }
        }
    });
    await Promise.all(workers);
    if (firstError !== null)
        throw firstError;
}
function normalizeModelFileName(fileName, fileUrl, id) {
    const fromField = fileName ? sanitizeFileName(fileName) : '';
    const fromUrl = sanitizeFileName(fileNameFromUrl(fileUrl));
    const candidate = fromField || fromUrl || `model-${id}.glb`;
    const extension = path.extname(candidate).toLowerCase();
    if (!MODEL_EXTENSIONS.has(extension)) {
        throw new Error(`数据中台模型主文件扩展名不受支持：${candidate}`);
    }
    return candidate;
}
function normalizeOptionalTypeScriptFileName(fileName, fileUrl, index, usedNames) {
    const fromField = fileName ? sanitizeFileName(fileName) : '';
    const fromUrl = sanitizeFileName(fileNameFromUrl(fileUrl));
    const candidate = [fromField, fromUrl].find((value) => path.extname(value).toLowerCase() === '.ts');
    if (!candidate)
        return null;
    const base = path.parse(candidate).name || `script-${index + 1}`;
    let uniqueName = `${base}.ts`;
    let suffix = 2;
    while (usedNames.has(uniqueName.toLowerCase())) {
        uniqueName = `${base}-${suffix}.ts`;
        suffix += 1;
    }
    usedNames.add(uniqueName.toLowerCase());
    return uniqueName;
}
function thumbnailExtensionFromUrl(value) {
    try {
        const extension = path.extname(new URL(value, 'http://placeholder.invalid/').pathname).toLowerCase();
        return THUMBNAIL_EXTENSIONS.has(extension) ? extension : null;
    }
    catch {
        return null;
    }
}
function fileNameFromUrl(value) {
    try {
        return decodeURIComponent(path.posix.basename(new URL(value, 'http://placeholder.invalid/').pathname));
    }
    catch {
        return '';
    }
}
function sanitizeFileName(value) {
    const baseName = path.posix.basename(value.replace(/\\/g, '/'));
    const normalized = baseName
        .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
        .trim()
        .replace(/[. ]+$/g, '')
        .slice(0, 180);
    return avoidWindowsReservedName(normalized);
}
function sanitizePathSegment(value) {
    const normalized = value
        .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/[. ]+$/g, '')
        .slice(0, 80);
    return avoidWindowsReservedName(normalized || '未命名');
}
function avoidWindowsReservedName(value) {
    const stem = value.split('.', 1)[0]?.toUpperCase() ?? '';
    return /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem) ? `_${value}` : value;
}
function maxBytesForDownloadKind(kind) {
    if (kind === 'model')
        return MAX_MODEL_FILE_BYTES;
    if (kind === 'metadata')
        return MAX_METADATA_FILE_BYTES;
    if (kind === 'script')
        return MAX_SCRIPT_FILE_BYTES;
    return MAX_THUMBNAIL_FILE_BYTES;
}
function modelKindLabel(kind) {
    return kind === 'model' ? '普通模型' : kind === 'environment' ? '环境模型' : '组合模型';
}
function assertUniqueModelRecords(records) {
    const keys = new Set();
    for (const record of records) {
        const key = `${record.kind}:${record.id}`;
        if (keys.has(key))
            throw new Error(`数据中台${modelKindLabel(record.kind)}存在重复 ID：${record.id}`);
        keys.add(key);
    }
}
function requireRecord(value, label, index) {
    if (!isPlainObject(value))
        throw new Error(`数据中台${label}第 ${index + 1} 项不是对象。`);
    return value;
}
function normalizeRequiredId(value, label, index) {
    if (typeof value === 'string') {
        const normalized = value.trim();
        if (/^\d{1,64}$/.test(normalized))
            return normalized;
    }
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
        return String(value);
    }
    throw new Error(`数据中台${label}第 ${index + 1} 项 id 无效。`);
}
function normalizeRequiredUrl(value, label, index) {
    const normalized = normalizeOptionalString(value);
    if (!normalized)
        throw new Error(`数据中台${label}第 ${index + 1} 项 fileUrl 为空。`);
    return normalized;
}
function normalizeOptionalString(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}
function normalizeNonNegativeInteger(value, fallback) {
    const normalized = toFiniteNumber(value);
    return normalized === null || normalized < 0 ? fallback : Math.trunc(normalized);
}
function toFiniteNumber(value) {
    const normalized = typeof value === 'number'
        ? value
        : typeof value === 'string' && value.trim()
            ? Number(value)
            : Number.NaN;
    return Number.isFinite(normalized) ? normalized : null;
}
async function renamePathWithWindowsRetry(sourcePath, targetPath) {
    let retryIndex = 0;
    while (true) {
        try {
            await fs.rename(sourcePath, targetPath);
            return;
        }
        catch (error) {
            const retryDelayMs = WINDOWS_RENAME_RETRY_DELAYS_MS[retryIndex];
            if (process.platform !== 'win32'
                || retryDelayMs === undefined
                || !isNodeError(error)
                || typeof error.code !== 'string'
                || !WINDOWS_RENAME_RETRY_ERROR_CODES.has(error.code)) {
                throw error;
            }
            retryIndex += 1;
            await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        }
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
function toErrorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function isPlainObject(value) {
    return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}
function isNodeError(error) {
    return error instanceof Error && 'code' in error;
}
