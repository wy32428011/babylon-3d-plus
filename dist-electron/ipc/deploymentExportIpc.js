import { ZipArchive } from 'archiver';
import { app, BrowserWindow, dialog, ipcMain, shell, } from 'electron';
import { randomUUID } from 'node:crypto';
import { createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertSafeDirectory, copyDeploymentFiles, createDeploymentExportAbortError, isDeploymentExportAbortError, isPathInsideOrEqual, lstatIfExists, resolveDeploymentDestination, scanSafeSourceRoot, throwIfDeploymentExportAborted, toDeploymentPath, } from './deploymentExportFileSystem.js';
import { createAssetManifestContent, prepareDeploymentExport, } from './deploymentExportScene.js';
const EXPORT_START_CHANNEL = 'deployment-export:start';
const EXPORT_CANCEL_CHANNEL = 'deployment-export:cancel';
const EXPORT_PROGRESS_CHANNEL = 'deployment-export:progress';
const EXPORT_REVEAL_CHANNEL = 'deployment-export:reveal';
const COPY_CONCURRENCY = 4;
const MAX_REQUEST_CONTENT_BYTES = 64 * 1024 * 1024;
const MAX_COMPLETED_EXPORTS_PER_RENDERER = 32;
const GENERATED_TEMPLATE_PATHS = new Set([
    'README.md',
    'runtime-config.json',
    'project/scene.json',
    'project/asset-manifest.json',
]);
const activeExports = new Map();
const completedExports = new Map();
const cleanupBoundSenderIds = new Set();
/** 注册 Web 部署工程导出、取消、进度和定位 IPC。 */
export function registerDeploymentExportIpc() {
    ipcMain.handle(EXPORT_START_CHANNEL, handleStartExport);
    ipcMain.handle(EXPORT_CANCEL_CHANNEL, handleCancelExport);
    ipcMain.handle(EXPORT_REVEAL_CHANNEL, handleRevealExport);
}
/** 中止所有未完成任务并移除 IPC handler，供应用退出时统一回收。 */
export function disposeAllDeploymentExportTasks() {
    for (const task of activeExports.values())
        task.controller.abort();
    activeExports.clear();
    completedExports.clear();
    cleanupBoundSenderIds.clear();
    ipcMain.removeHandler(EXPORT_START_CHANNEL);
    ipcMain.removeHandler(EXPORT_CANCEL_CHANNEL);
    ipcMain.removeHandler(EXPORT_REVEAL_CHANNEL);
}
/** 处理 renderer 发起的导出请求，并保证同一 webContents 同时只有一个任务。 */
async function handleStartExport(event, request) {
    const { sender, ownerWindow } = assertTrustedSender(event);
    const validatedRequest = validateDeploymentExportRequest(request);
    bindSenderCleanup(sender);
    if (activeExports.has(sender.id))
        throw new Error('当前窗口已有 Web 部署工程导出任务正在执行。');
    if (completedExports.get(sender.id)?.has(validatedRequest.requestId)) {
        throw new Error('requestId 已用于已完成的导出，请生成新的 requestId。');
    }
    const task = {
        requestId: validatedRequest.requestId,
        sender,
        controller: new AbortController(),
        stagingPath: null,
        temporaryZipPath: null,
    };
    activeExports.set(sender.id, task);
    try {
        return await runDeploymentExport(ownerWindow, task, validatedRequest);
    }
    finally {
        if (activeExports.get(sender.id) === task)
            activeExports.delete(sender.id);
    }
}
/** 取消当前 sender 中 requestId 对应的活动任务。 */
function handleCancelExport(event, request) {
    const { sender } = assertTrustedSender(event);
    const requestId = validateRequestIdRequest(request, '取消导出');
    const task = activeExports.get(sender.id);
    if (!task || task.requestId !== requestId)
        return false;
    task.controller.abort();
    return true;
}
/** 只允许当前 sender 按已完成 requestId 定位正式发布结果。 */
async function handleRevealExport(event, request) {
    const { sender } = assertTrustedSender(event);
    const requestId = validateRequestIdRequest(request, '定位导出结果');
    const completed = completedExports.get(sender.id)?.get(requestId);
    if (!completed)
        throw new Error('只能定位当前窗口中已经完成的导出 requestId。');
    const stat = await lstatIfExists(completed.outputPath);
    if (!stat)
        throw new Error('导出结果已被移动或删除。');
    if (stat.isSymbolicLink())
        throw new Error('导出结果已被替换为符号链接或 Junction，拒绝定位。');
    shell.showItemInFolder(completed.outputPath);
}
/** 执行预检、复制、元数据写入、压缩和正式发布的完整导出事务。 */
async function runDeploymentExport(ownerWindow, task, request) {
    const signal = task.controller.signal;
    const emitProgress = createProgressEmitter(task);
    let destination = null;
    let publishedPath = null;
    try {
        emitProgress('preflight', '正在校验导出请求…', 1);
        throwIfDeploymentExportAborted(signal);
        emitProgress('preflight', '请选择导出位置…', 3);
        destination = await selectExportDestination(ownerWindow, request, signal);
        if (!destination)
            return createCanceledResult(request);
        task.stagingPath = destination.stagingPath;
        task.temporaryZipPath = destination.temporaryZipPath;
        const forbiddenOutputPaths = [destination.finalPath, destination.stagingPath];
        if (destination.temporaryZipPath)
            forbiddenOutputPaths.push(destination.temporaryZipPath);
        emitProgress('preflight', '正在检查 Viewer 模板…', 6);
        const templateRoot = resolveViewerTemplateRoot();
        const templateFiles = await createTemplateCopyPlan(templateRoot, forbiddenOutputPaths, signal);
        const prepared = await prepareDeploymentExport(request.sceneContent, request.suggestedName, forbiddenOutputPaths, signal, (message) => emitProgress('preflight', message, 8));
        assertNoCopyPlanCollisions(templateFiles, prepared.assetFiles);
        throwIfDeploymentExportAborted(signal);
        await fs.mkdir(destination.stagingPath, { recursive: false });
        const totalFiles = templateFiles.length + prepared.assetFiles.length;
        const totalBytes = sumFileBytes([...templateFiles, ...prepared.assetFiles]);
        let copiedBaseFiles = 0;
        let copiedBaseBytes = 0;
        emitProgress('copy-template', '正在复制只读 Web Viewer…', 12, 0, totalFiles, 0, totalBytes);
        await copyDeploymentFiles(templateFiles, destination.stagingPath, COPY_CONCURRENCY, signal, (progress) => {
            emitCopyProgress(emitProgress, 'copy-template', '正在复制只读 Web Viewer…', progress, 12, 36, 0, 0, totalFiles, totalBytes);
        });
        copiedBaseFiles = templateFiles.length;
        copiedBaseBytes = sumFileBytes(templateFiles);
        emitProgress('copy-assets', '正在复制场景资源并计算 SHA-256…', 36, copiedBaseFiles, totalFiles, copiedBaseBytes, totalBytes);
        const copiedAssets = await copyDeploymentFiles(prepared.assetFiles, destination.stagingPath, COPY_CONCURRENCY, signal, (progress) => {
            emitCopyProgress(emitProgress, 'copy-assets', '正在复制场景资源并计算 SHA-256…', progress, 36, 78, copiedBaseFiles, copiedBaseBytes, totalFiles, totalBytes);
        });
        emitProgress('write-metadata', '正在生成场景、运行配置和资产清单…', 80, totalFiles, totalFiles, totalBytes, totalBytes);
        await writeGeneratedDeploymentFiles(destination.stagingPath, prepared, copiedAssets, signal);
        if (request.format === 'zip') {
            if (!destination.temporaryZipPath)
                throw new Error('ZIP 临时文件路径缺失。');
            emitProgress('archive', '正在生成 ZIP 压缩包…', 84, totalFiles, totalFiles, totalBytes, totalBytes);
            await archiveDeploymentDirectory(destination.stagingPath, destination.temporaryZipPath, path.basename(destination.finalPath, path.extname(destination.finalPath)), signal, (processed, total) => {
                const ratio = total > 0 ? processed / total : 0;
                emitProgress('archive', '正在生成 ZIP 压缩包…', 84 + ratio * 10, totalFiles, totalFiles, totalBytes, totalBytes);
            });
            emitProgress('publish', '正在发布 ZIP 文件…', 95, totalFiles, totalFiles, totalBytes, totalBytes);
            await publishZipFile(destination.temporaryZipPath, destination.finalPath, prepared.warnings);
            task.temporaryZipPath = null;
            publishedPath = destination.finalPath;
        }
        else {
            emitProgress('publish', '正在发布部署目录…', 95, totalFiles, totalFiles, totalBytes, totalBytes);
            throwIfDeploymentExportAborted(signal);
            await fs.rename(destination.stagingPath, destination.finalPath);
            task.stagingPath = null;
            publishedPath = destination.finalPath;
        }
        if (request.format === 'zip') {
            await cleanupOwnedPath(destination.stagingPath, destination.parentPath, '.web-export-staging-');
            task.stagingPath = null;
        }
        rememberCompletedExport(task.sender, {
            requestId: request.requestId,
            outputPath: publishedPath,
            format: request.format,
        });
        emitProgress('publish', 'Web 部署工程导出完成。', 100, totalFiles, totalFiles, totalBytes, totalBytes);
        return {
            requestId: request.requestId,
            canceled: false,
            format: request.format,
            outputPath: publishedPath,
            fileCount: templateFiles.length + copiedAssets.length + GENERATED_TEMPLATE_PATHS.size,
            totalBytes: calculatePublishedByteCount(templateFiles, prepared, copiedAssets),
            externalAssetCount: prepared.externalAssetCount,
            warnings: prepared.warnings,
        };
    }
    catch (error) {
        if (isDeploymentExportAbortError(error) || signal.aborted)
            return createCanceledResult(request);
        throw error;
    }
    finally {
        if (task.temporaryZipPath && destination) {
            await cleanupOwnedPath(task.temporaryZipPath, destination.parentPath, '.web-export-temp-').catch(logCleanupFailure);
        }
        if (task.stagingPath && destination) {
            await cleanupOwnedPath(task.stagingPath, destination.parentPath, '.web-export-staging-').catch(logCleanupFailure);
        }
        if (publishedPath && signal.aborted) {
            console.warn('[deployment-export] 导出在发布完成后收到取消信号，正式结果已保留。');
        }
    }
}
/** 校验 IPC sender 来自主窗口 main frame，并限制为当前开发或生产 renderer URL。 */
function assertTrustedSender(event) {
    const sender = event.sender;
    const ownerWindow = BrowserWindow.fromWebContents(sender);
    if (!ownerWindow || ownerWindow.isDestroyed() || sender.isDestroyed())
        throw new Error('导出请求 sender 无效。');
    if (!event.senderFrame || event.senderFrame !== sender.mainFrame)
        throw new Error('导出请求只能由主 frame 发起。');
    if (!isAllowedRendererUrl(sender.getURL()))
        throw new Error('导出请求来自未授权的 renderer URL。');
    return { sender, ownerWindow };
}
/** 判断 renderer URL 是否精确属于当前 Vite 入口或打包后的 dist/index.html。 */
function isAllowedRendererUrl(rendererUrl) {
    try {
        const url = new URL(rendererUrl);
        url.hash = '';
        url.search = '';
        const devServerUrl = process.env.VITE_DEV_SERVER_URL;
        if (devServerUrl) {
            const allowedDevUrl = new URL(devServerUrl);
            allowedDevUrl.hash = '';
            allowedDevUrl.search = '';
            return url.origin === allowedDevUrl.origin && url.pathname === allowedDevUrl.pathname;
        }
        const packagedRendererUrl = pathToFileURL(path.join(app.getAppPath(), 'dist', 'index.html'));
        return url.href === packagedRendererUrl.href;
    }
    catch {
        return false;
    }
}
/** 为 webContents 绑定一次销毁清理，窗口关闭时立即取消任务并清除 reveal 记录。 */
function bindSenderCleanup(sender) {
    if (cleanupBoundSenderIds.has(sender.id))
        return;
    cleanupBoundSenderIds.add(sender.id);
    sender.once('destroyed', () => {
        activeExports.get(sender.id)?.controller.abort();
        activeExports.delete(sender.id);
        completedExports.delete(sender.id);
        cleanupBoundSenderIds.delete(sender.id);
    });
}
/** 严格校验 requestId、名称、格式和场景内容。 */
function validateDeploymentExportRequest(request) {
    if (!isPlainObject(request))
        throw new Error('Web 部署工程导出请求格式不正确。');
    const requestId = validateRequestId(request.requestId);
    if (typeof request.suggestedName !== 'string')
        throw new Error('导出工程名称格式不正确。');
    const name = request.suggestedName.trim();
    if (!name || name.length > 128 || /[\u0000-\u001f]/.test(name))
        throw new Error('导出工程名称必须是 1 到 128 个有效字符。');
    if (request.format !== 'directory' && request.format !== 'zip')
        throw new Error('导出格式只支持 directory 或 zip。');
    if (typeof request.sceneContent !== 'string' || !request.sceneContent)
        throw new Error('导出场景内容不能为空。');
    if (Buffer.byteLength(request.sceneContent, 'utf8') > MAX_REQUEST_CONTENT_BYTES) {
        throw new Error(`导出场景内容超过 ${MAX_REQUEST_CONTENT_BYTES / 1024 / 1024} MiB 安全上限。`);
    }
    return { requestId, suggestedName: name, format: request.format, sceneContent: request.sceneContent };
}
/** 校验只包含 requestId 的取消或定位请求。 */
function validateRequestIdRequest(request, label) {
    if (!isPlainObject(request))
        throw new Error(`${label}请求格式不正确。`);
    return validateRequestId(request.requestId);
}
/** 将 requestId 限定为短 ASCII 标识，避免日志、Map 和路径上下文被污染。 */
function validateRequestId(value) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
        throw new Error('requestId 格式不正确。');
    }
    return value;
}
/** 根据格式打开系统目录或 ZIP 保存对话框，并生成同父目录 staging 路径。 */
async function selectExportDestination(ownerWindow, request, signal) {
    throwIfDeploymentExportAborted(signal);
    const safeName = createSafeExportFileName(request.suggestedName);
    if (request.format === 'directory') {
        const result = await dialog.showOpenDialog(ownerWindow, {
            title: '选择 Web 部署工程输出目录',
            buttonLabel: '选择目录',
            properties: ['openDirectory', 'createDirectory'],
        });
        throwIfDeploymentExportAborted(signal);
        const selectedParent = result.filePaths[0];
        if (result.canceled || !selectedParent)
            return null;
        const parentPath = await assertSafeDirectory(selectedParent, '导出目标父目录');
        const finalPath = await createUniqueDirectoryPath(parentPath, `${safeName}-web`);
        return createDestinationPaths(parentPath, finalPath, false);
    }
    const result = await dialog.showSaveDialog(ownerWindow, {
        title: '保存 Web 部署工程 ZIP',
        defaultPath: `${safeName}-web.zip`,
        filters: [{ name: 'ZIP 压缩包', extensions: ['zip'] }],
    });
    throwIfDeploymentExportAborted(signal);
    if (result.canceled || !result.filePath)
        return null;
    const finalPath = result.filePath.toLowerCase().endsWith('.zip') ? path.resolve(result.filePath) : path.resolve(`${result.filePath}.zip`);
    const parentPath = await assertSafeDirectory(path.dirname(finalPath), 'ZIP 目标父目录');
    const targetStat = await lstatIfExists(finalPath);
    if (targetStat?.isSymbolicLink())
        throw new Error('ZIP 目标不能是符号链接或 Junction。');
    if (targetStat?.isDirectory())
        throw new Error('ZIP 目标不能是目录。');
    return createDestinationPaths(parentPath, finalPath, true);
}
/** 为正式目标生成同父目录且带随机标记的 staging 与 ZIP 临时文件路径。 */
function createDestinationPaths(parentPath, finalPath, includeTemporaryZip) {
    const token = randomUUID();
    const baseName = path.basename(finalPath, path.extname(finalPath));
    return {
        parentPath,
        finalPath,
        stagingPath: path.join(parentPath, `.${baseName}.web-export-staging-${token}`),
        temporaryZipPath: includeTemporaryZip
            ? path.join(parentPath, `.${baseName}.web-export-temp-${token}.zip`)
            : null,
    };
}
/** 为目录模式选择不会覆盖既有结果的安全名称。 */
async function createUniqueDirectoryPath(parentPath, baseName) {
    for (let index = 0; index < 10_000; index += 1) {
        const suffix = index === 0 ? '' : `-${index + 1}`;
        const candidate = path.join(parentPath, `${baseName}${suffix}`);
        if (!(await lstatIfExists(candidate)))
            return candidate;
    }
    throw new Error('无法为导出目录分配唯一名称。');
}
/** 将用户工程名转换为兼容 Windows 的文件名片段。 */
function createSafeExportFileName(name) {
    let safeName = name
        .normalize('NFKC')
        .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
        .trim()
        .replace(/[. ]+$/g, '')
        .slice(0, 80);
    if (!safeName)
        safeName = 'scene';
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(safeName))
        safeName = `_${safeName}`;
    return safeName;
}
/** 按开发态和安装态约定解析只读 Viewer 模板目录。 */
function resolveViewerTemplateRoot() {
    return app.isPackaged
        ? path.join(process.resourcesPath, 'export-viewer')
        : path.join(app.getAppPath(), 'dist-viewer-template');
}
/** 安全扫描 Viewer 模板并排除由主进程重新生成的配置文件。 */
async function createTemplateCopyPlan(templateRoot, forbiddenOutputPaths, signal) {
    const templateFiles = await scanSafeSourceRoot(templateRoot, null, forbiddenOutputPaths, signal);
    const plans = [];
    for (const file of templateFiles) {
        const relativePath = toDeploymentPath(file.relativePath);
        if (GENERATED_TEMPLATE_PATHS.has(relativePath))
            continue;
        if (relativePath === 'project/assets' || relativePath.startsWith('project/assets/')) {
            throw new Error('Viewer 模板不能预置 project/assets 文件。');
        }
        plans.push({ ...file, destinationRelativePath: relativePath, kind: 'asset' });
    }
    return plans;
}
/** 在创建 staging 前检查模板与场景资产的目标路径不会碰撞。 */
function assertNoCopyPlanCollisions(templateFiles, assetFiles) {
    const destinations = new Set();
    for (const file of [...templateFiles, ...assetFiles]) {
        const key = toDeploymentPath(file.destinationRelativePath).toLowerCase();
        if (destinations.has(key))
            throw new Error(`导出文件目标冲突：${file.destinationRelativePath}`);
        destinations.add(key);
    }
}
/** 写入主进程生成的 runtime、scene、manifest 与部署 README。 */
async function writeGeneratedDeploymentFiles(stagingPath, prepared, copiedAssets, signal) {
    throwIfDeploymentExportAborted(signal);
    const files = [
        { relativePath: 'runtime-config.json', content: prepared.runtimeConfigContent },
        { relativePath: 'README.md', content: prepared.readmeContent },
        { relativePath: 'project/scene.json', content: prepared.sceneContent },
        { relativePath: 'project/asset-manifest.json', content: createAssetManifestContent(copiedAssets) },
    ];
    for (const file of files) {
        throwIfDeploymentExportAborted(signal);
        const destinationPath = resolveDeploymentDestination(stagingPath, file.relativePath);
        await fs.mkdir(path.dirname(destinationPath), { recursive: true });
        await fs.writeFile(destinationPath, file.content, { encoding: 'utf8', flag: 'wx' });
    }
}
/** 使用 archiver 把 staging 根内容流式写入同父目录临时 ZIP。 */
async function archiveDeploymentDirectory(stagingPath, temporaryZipPath, archiveRootName, signal, onProgress) {
    throwIfDeploymentExportAborted(signal);
    await new Promise((resolve, reject) => {
        const output = createWriteStream(temporaryZipPath, { flags: 'wx' });
        const archive = new ZipArchive({ zlib: { level: 9 } });
        let settled = false;
        /** 只结算一次 ZIP Promise，并解绑取消监听。 */
        const settle = (error) => {
            if (settled)
                return;
            settled = true;
            signal.removeEventListener('abort', handleAbort);
            if (error)
                reject(error);
            else
                resolve();
        };
        /** 取消压缩并销毁输出流，确保临时 ZIP 由 finally 清理。 */
        const handleAbort = () => {
            void archive.abort();
            output.destroy(createDeploymentExportAbortError());
            settle(createDeploymentExportAbortError());
        };
        signal.addEventListener('abort', handleAbort, { once: true });
        output.on('close', () => settle());
        output.on('error', (error) => settle(error));
        archive.on('error', (error) => settle(error));
        archive.on('warning', (error) => settle(error));
        archive.on('progress', (progress) => onProgress(progress.entries.processed, progress.entries.total));
        archive.pipe(output);
        archive.directory(stagingPath, archiveRootName);
        void archive.finalize().catch((error) => settle(error));
    });
    throwIfDeploymentExportAborted(signal);
}
/** 将完整临时 ZIP 发布到用户确认路径；覆盖时先备份旧文件并在失败时恢复。 */
async function publishZipFile(temporaryZipPath, finalPath, warnings) {
    const targetStat = await lstatIfExists(finalPath);
    if (!targetStat) {
        await fs.rename(temporaryZipPath, finalPath);
        return;
    }
    if (targetStat.isSymbolicLink() || !targetStat.isFile())
        throw new Error('ZIP 正式目标不是安全的普通文件。');
    const backupPath = `${finalPath}.web-export-backup-${randomUUID()}`;
    await fs.rename(finalPath, backupPath);
    try {
        await fs.rename(temporaryZipPath, finalPath);
    }
    catch (error) {
        await fs.rename(backupPath, finalPath).catch((restoreError) => {
            console.error('[deployment-export] ZIP 发布失败且旧文件恢复失败。', restoreError);
        });
        throw error;
    }
    try {
        await fs.rm(backupPath, { force: true });
    }
    catch (error) {
        warnings.push('ZIP 已发布，但旧文件备份未能自动删除。');
        console.warn('[deployment-export] 无法删除 ZIP 旧文件备份。', error);
    }
}
/** 只清理由本任务生成、位于预期父目录且名称含随机标记的路径。 */
async function cleanupOwnedPath(targetPath, expectedParent, marker) {
    const normalizedTarget = path.resolve(targetPath);
    const normalizedParent = path.resolve(expectedParent);
    if (path.dirname(normalizedTarget) !== normalizedParent || !path.basename(normalizedTarget).includes(marker)) {
        throw new Error('拒绝清理不属于当前导出任务的路径。');
    }
    if (!isPathInsideOrEqual(normalizedParent, normalizedTarget) || normalizedTarget === normalizedParent) {
        throw new Error('拒绝清理逃逸导出父目录的路径。');
    }
    const stat = await lstatIfExists(normalizedTarget);
    if (!stat)
        return;
    if (stat.isSymbolicLink())
        throw new Error('拒绝清理被替换为符号链接或 Junction 的任务路径。');
    await fs.rm(normalizedTarget, { recursive: stat.isDirectory(), force: true });
}
/** 保存有限数量的已完成结果，供 reveal API 按 requestId 查询。 */
function rememberCompletedExport(sender, completed) {
    let records = completedExports.get(sender.id);
    if (!records) {
        records = new Map();
        completedExports.set(sender.id, records);
    }
    records.set(completed.requestId, completed);
    while (records.size > MAX_COMPLETED_EXPORTS_PER_RENDERER) {
        const oldestRequestId = records.keys().next().value;
        if (!oldestRequestId)
            break;
        records.delete(oldestRequestId);
    }
}
/** 创建取消结果，确保未发布任务不会暴露 staging 路径。 */
function createCanceledResult(request) {
    return {
        requestId: request.requestId,
        canceled: true,
        format: request.format,
        outputPath: null,
        fileCount: 0,
        totalBytes: 0,
        externalAssetCount: 0,
        warnings: [],
    };
}
/** 创建受控进度发送器，只向仍存活且仍持有该任务的 renderer 广播。 */
function createProgressEmitter(task) {
    return (phase, message, percent, completedFiles = 0, totalFiles = 0, completedBytes = 0, totalBytes = 0) => {
        if (task.sender.isDestroyed() || activeExports.get(task.sender.id) !== task)
            return;
        const progress = {
            requestId: task.requestId,
            phase,
            detail: message,
            percent: Math.max(0, Math.min(100, Number.isFinite(percent) ? percent : 0)),
            completedFiles,
            totalFiles,
            copiedBytes: completedBytes,
            totalBytes,
        };
        task.sender.send(EXPORT_PROGRESS_CHANNEL, progress);
    };
}
/** 把某一复制阶段的局部进度映射到全局文件、字节和百分比。 */
function emitCopyProgress(emitProgress, phase, message, progress, startPercent, endPercent, baseFiles, baseBytes, totalFiles, totalBytes) {
    const ratio = progress.totalBytes > 0
        ? progress.completedBytes / progress.totalBytes
        : progress.totalFiles > 0
            ? progress.completedFiles / progress.totalFiles
            : 1;
    emitProgress(phase, message, startPercent + (endPercent - startPercent) * Math.max(0, Math.min(1, ratio)), baseFiles + progress.completedFiles, totalFiles, baseBytes + progress.completedBytes, totalBytes);
}
/** 安全累加复制计划中的文件字节数。 */
function sumFileBytes(files) {
    let total = 0;
    for (const file of files) {
        total += file.size;
        if (!Number.isSafeInteger(total))
            throw new Error('导出文件总大小超过安全范围。');
    }
    return total;
}
/** 计算部署目录未压缩字节数，包含 Viewer、场景资源和生成的 JSON/README。 */
function calculatePublishedByteCount(templateFiles, prepared, copiedAssets) {
    const manifestContent = createAssetManifestContent(copiedAssets);
    const generatedBytes = [
        prepared.readmeContent,
        prepared.runtimeConfigContent,
        prepared.sceneContent,
        manifestContent,
    ].reduce((sum, content) => sum + Buffer.byteLength(content, 'utf8'), 0);
    return sumFileBytes(templateFiles) + sumFileBytes(copiedAssets) + generatedBytes;
}
/** 记录清理失败但不覆盖原始导出异常。 */
function logCleanupFailure(error) {
    console.warn('[deployment-export] 任务临时路径清理失败。', error);
}
/** 将未知值收窄为普通对象。 */
function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
