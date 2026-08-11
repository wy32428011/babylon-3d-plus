import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZipArchive } from 'archiver';
import { _electron as electron } from 'playwright';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const workspaceRoot = path.resolve(__dirname, '..');
const PROJECT_ID = '2054201280000000001';
const SKYBOX_ID = '2054201280000000401';
const PROJECT_NAME = '数据中台天空盒 Smoke 项目';
const SKYBOX_NAME = '中台晨曦';
const SCENE_FILE_NAME = 'skybox-smoke.scene.json';
const SKYBOX_RELATIVE_PATH = `Assets/Skyboxes/DataPlatform/Skybox-${SKYBOX_ID}/skybox.hdr`;
const INITIAL_TRANSFORM = {
  position: { x: 12.5, y: -3.25, z: 8.75 },
  rotation: { x: 0.125, y: Math.PI / 3, z: -0.25 },
  scale: { x: 2.5, y: 2.5, z: 2.5 },
};
const INITIAL_INTENSITY = 1.75;
const INITIAL_RESOLUTION = 1024;

function logStage(message) {
  console.info(`[data-platform-skybox-smoke] ${message}`);
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function withTimeout(promise, timeoutMs, message) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function createHdrFixture(comment, baseValue) {
  const header = Buffer.from(`#?RADIANCE\nCOMMENT=${comment}\nFORMAT=32-bit_rle_rgbe\n\n-Y 1 +X 8\n`, 'ascii');
  const scanline = [Buffer.from([2, 2, 0, 8])];
  for (let channel = 0; channel < 4; channel += 1) {
    scanline.push(Buffer.from([8]), Buffer.alloc(8, baseValue + channel));
  }
  return Buffer.concat([header, ...scanline]);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function createZipFromDirectory(sourceRoot, archivePath, wrapperName = '') {
  await mkdir(path.dirname(archivePath), { recursive: true });
  await new Promise((resolve, reject) => {
    const output = createWriteStream(archivePath);
    const archive = new ZipArchive({ zlib: { level: 9 } });
    output.once('close', resolve);
    output.once('error', reject);
    archive.once('error', reject);
    archive.pipe(output);
    archive.directory(sourceRoot, wrapperName || false);
    void archive.finalize();
  });
}

function createProjectRecord(packageFileName) {
  return {
    id: PROJECT_ID,
    projectName: PROJECT_NAME,
    sceneCount: 1,
    screenCount: 0,
    modelCount: 0,
    envModelCount: 0,
    comboModelCount: 0,
    poiCount: 0,
    chartCount: 0,
    themeCount: 0,
    latestEditorProjectId: `${PROJECT_ID}01`,
    latestEditorProjectVersionId: `${PROJECT_ID}02`,
    latestEditorProjectVersionNumber: 1,
    latestEditorProjectName: `${PROJECT_NAME} Editor`,
    latestEditorProjectPackageUrl: `files/${packageFileName}`,
    latestEditorProjectPackageFileName: packageFileName,
    updatedAt: '2026-08-11T08:00:00Z',
  };
}

async function createProjectPackage(fixtureRoot, storageRoot, initialSha256) {
  const source = JSON.parse(await readFile(
    path.join(workspaceRoot, 'examples', 'scenes', 'stacker-mqtt-demo.scene.json'),
    'utf8',
  ));
  const sharedResourcesRoot = path.join(storageRoot, 'SharedResources');
  const skyboxPath = path.join(sharedResourcesRoot, ...SKYBOX_RELATIVE_PATH.split('/'));
  const skyboxPackagePath = path.dirname(skyboxPath);
  const skyboxEntityId = 'entity_data_platform_skybox_smoke';

  source.version = 3;
  source.units = { length: 'meter' };
  source.scene.id = 'scene_data_platform_skybox_smoke';
  source.scene.name = '数据中台天空盒同步 Smoke 场景';
  source.scene.entityIds = [skyboxEntityId];
  source.scene.entities = {
    [skyboxEntityId]: {
      id: skyboxEntityId,
      name: '天空盒 中台晨曦',
      visible: true,
      locked: false,
      parentId: null,
      childrenIds: [],
      components: {
        transform: structuredClone(INITIAL_TRANSFORM),
        skybox: {
          packagePath: skyboxPackagePath,
          sourcePath: skyboxPath,
          sourceUrl: `editor-asset://local/${encodeURIComponent(skyboxPath)}`,
          assetRevision: initialSha256,
          dataPlatformResourceId: SKYBOX_ID,
          format: 'hdr',
          intensity: INITIAL_INTENSITY,
          resolution: INITIAL_RESOLUTION,
        },
      },
    },
  };
  source.scene.selectedEntityId = null;
  source.scene.mqttConfig = {
    ...source.scene.mqttConfig,
    enabled: false,
    simulatorEnabled: false,
  };
  source.scene.sceneSettings = {
    camera: {
      savedPose: null,
      viewDistance: 12000,
    },
    sensitivity: { zoom: 10, pan: 10, rotate: 10 },
    environment: null,
    skybox: null,
  };

  const packageRoot = path.join(fixtureRoot, 'project-package');
  await mkdir(path.join(packageRoot, '.babylon-editor'), { recursive: true });
  await mkdir(path.join(packageRoot, 'Assets', 'Models'), { recursive: true });
  await mkdir(path.join(packageRoot, 'Assets', 'Environments'), { recursive: true });
  await mkdir(path.join(packageRoot, 'Scenes'), { recursive: true });
  await writeFile(
    path.join(packageRoot, '.babylon-editor', 'asset-index.json'),
    `${JSON.stringify({ version: 2, assets: [] }, null, 2)}\n`,
    'utf8',
  );
  await writeFile(
    path.join(packageRoot, 'Scenes', SCENE_FILE_NAME),
    `${JSON.stringify(source, null, 2)}\n`,
    'utf8',
  );

  const archivePath = path.join(fixtureRoot, 'skybox-project.zip');
  await createZipFromDirectory(packageRoot, archivePath, 'wrapped-project');
  return {
    archiveBytes: await readFile(archivePath),
    sceneRelativePath: path.join('Scenes', SCENE_FILE_NAME),
    skyboxPath,
  };
}

async function startMockServer({ archiveBytes, initialBytes }) {
  const requests = [];
  const firstSkyboxQueryStarted = createDeferred();
  const releaseFirstSkyboxQuery = createDeferred();
  let firstQuery = true;
  let firstQueryResponseSent = false;
  let queryCount = 0;
  let downloadCount = 0;
  let remote = {
    bytes: initialBytes,
    revision: '1',
    advertisedSha256: sha256(initialBytes),
    updatedAt: '2026-08-11T08:00:00Z',
  };

  const handleRequest = async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const bodyText = Buffer.concat(chunks).toString('utf8');
    let body = null;
    if (bodyText) {
      try {
        body = JSON.parse(bodyText);
      } catch {
        body = bodyText;
      }
    }
    requests.push({ method: request.method, path: url.pathname, body });

    const sendJson = (payload, status = 200) => {
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(payload));
    };

    if (request.method === 'POST' && url.pathname === '/platform/api/v1/projects/query') {
      sendJson({
        success: true,
        data: {
          records: [createProjectRecord('skybox-project.zip')],
          total: 1,
          pageNum: 1,
          pageSize: 12,
        },
      });
      return;
    }

    if (request.method === 'POST' && [
      '/platform/api/v1/models/query',
      '/platform/api/v1/env-models/query',
      '/platform/api/v1/combo-models/query',
    ].includes(url.pathname)) {
      sendJson({
        success: true,
        data: {
          records: [],
          total: 0,
          pageNum: body?.pageNum ?? 1,
          pageSize: body?.pageSize ?? 100,
        },
      });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/platform/api/v1/skyboxes/query') {
      queryCount += 1;
      if (firstQuery) {
        firstQuery = false;
        firstSkyboxQueryStarted.resolve();
        await delay(1000);
        await releaseFirstSkyboxQuery.promise;
        firstQueryResponseSent = true;
      }
      const records = remote ? [{
        id: SKYBOX_ID,
        skyboxName: SKYBOX_NAME,
        fileName: 'skybox.hdr',
        fileUrl: 'files/skybox.hdr',
        fileSize: String(remote.bytes.length),
        fileSha256: remote.advertisedSha256,
        fileFormat: 'HDR',
        revision: remote.revision,
        updatedAt: remote.updatedAt,
      }] : [];
      sendJson({
        success: true,
        data: {
          records,
          total: String(records.length),
          pageNum: String(body?.pageNum ?? 1),
          pageSize: String(body?.pageSize ?? 100),
        },
      });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/platform/files/skybox-project.zip') {
      response.writeHead(200, {
        'content-type': 'application/zip',
        'content-length': String(archiveBytes.length),
      });
      response.end(archiveBytes);
      return;
    }

    if (request.method === 'GET' && url.pathname === '/platform/files/skybox.hdr') {
      if (!remote) {
        sendJson({ success: false, message: 'skybox deleted' }, 404);
        return;
      }
      downloadCount += 1;
      response.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': String(remote.bytes.length),
      });
      response.end(remote.bytes);
      return;
    }

    sendJson({ success: false, message: 'not found' }, 404);
  };

  const server = createServer((request, response) => {
    void handleRequest(request, response).catch((error) => {
      const normalizedError = error instanceof Error ? error : new Error(String(error));
      logStage(`mock server request failed: ${normalizedError.message}`);
      try {
        if (!response.headersSent) {
          response.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
          response.end(JSON.stringify({ success: false, message: 'mock server request failed' }));
        } else if (!response.writableEnded) {
          response.destroy(normalizedError);
        }
      } catch {
        response.destroy(normalizedError);
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  return {
    baseUrl: `http://127.0.0.1:${address.port}/platform`,
    requests,
    waitForFirstSkyboxQuery: () => withTimeout(
      firstSkyboxQueryStarted.promise,
      15_000,
      '等待首个天空盒查询开始超时',
    ),
    releaseFirstSkyboxQuery: () => releaseFirstSkyboxQuery.resolve(),
    hasSentFirstSkyboxQueryResponse: () => firstQueryResponseSent,
    getQueryCount: () => queryCount,
    getDownloadCount: () => downloadCount,
    setRemote: (bytes, revision, advertisedSha256 = sha256(bytes)) => {
      remote = {
        bytes,
        revision,
        advertisedSha256,
        updatedAt: `2026-08-11T08:00:0${Math.min(Number(revision), 9)}Z`,
      };
    },
    deleteRemote: () => {
      remote = null;
    },
    close: async () => {
      releaseFirstSkyboxQuery.resolve();
      server.closeAllConnections?.();
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

async function writeDataPlatformConfig(userDataRoot, baseUrl, storageRoot) {
  await mkdir(userDataRoot, { recursive: true });
  await writeFile(
    path.join(userDataRoot, 'data-platform-config.json'),
    `${JSON.stringify({ version: 2, baseUrl, workspaceRoot: storageRoot }, null, 2)}\n`,
    'utf8',
  );
}

async function launchEditor(userDataRoot) {
  const env = {
    ...process.env,
    OPEN_DEVTOOLS: 'false',
    VITE_DEV_SERVER_URL: '',
  };
  delete env.ZENDING_ALLOW_STORAGE_ROOT_OVERRIDE;
  delete env.ZENDING_EDITOR_STORAGE_ROOT;

  const app = await electron.launch({
    args: [workspaceRoot, `--user-data-dir=${userDataRoot}`],
    cwd: workspaceRoot,
    env,
  });
  try {
    const window = await app.firstWindow();
    window.on('console', (message) => logStage(`renderer console ${message.type()}: ${message.text()}`));
    window.on('pageerror', (error) => logStage(`renderer pageerror: ${error.message}`));
    await window.waitForLoadState('domcontentloaded');
    await window.locator('#root').waitFor({ state: 'attached' });
    await window.waitForFunction(() => (
      typeof window.editorApi?.onDataPlatformSkyboxSyncProgress === 'function'
    ), undefined, { timeout: 15_000 });
    window.on('dialog', (dialog) => void dialog.dismiss());
    return { app, window };
  } catch (error) {
    logStage(`Electron 启动失败：${error instanceof Error ? error.message : String(error)}`);
    try {
      await closeLaunchedEditor({ app });
    } catch (closeError) {
      throw new AggregateError([error, closeError], 'Electron 启动失败且清理进程失败');
    }
    throw error;
  }
}

function hasChildExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

async function forceCloseChildProcess(child, timeoutMs) {
  if (hasChildExited(child)) return;

  await new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      child.off('exit', onExit);
      child.off('error', onError);
    };
    const onExit = () => {
      cleanup();
      resolve();
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`等待 Electron 进程 ${child.pid ?? 'unknown'} 强制退出超时`));
    }, timeoutMs);

    child.once('exit', onExit);
    child.once('error', onError);
    try {
      const killAccepted = child.kill('SIGKILL');
      if (!killAccepted) {
        cleanup();
        if (hasChildExited(child)) {
          resolve();
        } else {
          reject(new Error(`无法终止 Electron 进程 ${child.pid ?? 'unknown'}`));
        }
      }
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

async function closeLaunchedEditor(launched) {
  try {
    await withTimeout(launched.app.close(), 10_000, '等待 Electron 正常退出超时');
  } catch (closeError) {
    try {
      await forceCloseChildProcess(launched.app.process(), 5_000);
    } catch (terminateError) {
      throw new AggregateError(
        [closeError, terminateError],
        'Electron 正常退出及定向强制退出均失败',
      );
    }
  }
}

async function installSkyboxProgressCollector(window) {
  await window.evaluate(() => {
    window.__dataPlatformSkyboxSmokeEvents = [];
    window.__dataPlatformSkyboxSmokeUnsubscribe?.();
    window.__dataPlatformSkyboxSmokeUnsubscribe = window.editorApi.onDataPlatformSkyboxSyncProgress((progress) => {
      window.__dataPlatformSkyboxSmokeEvents.push(progress);
    });
  });
}

async function resetSkyboxProgressEvents(window) {
  await window.evaluate(() => {
    window.__dataPlatformSkyboxSmokeEvents = [];
  });
}

async function waitForSkyboxTerminalProgress(window, timeoutMs = 30_000) {
  await window.waitForFunction(() => (
    (window.__dataPlatformSkyboxSmokeEvents ?? []).some(
      (progress) => progress.phase === 'completed' || progress.phase === 'failed',
    )
  ), undefined, { timeout: timeoutMs });

  return window.evaluate(() => {
    const events = window.__dataPlatformSkyboxSmokeEvents ?? [];
    const finalProgress = [...events].reverse().find(
      (progress) => progress.phase === 'completed' || progress.phase === 'failed',
    ) ?? null;
    return { events, finalProgress };
  });
}

async function runManualSkyboxSync(window) {
  await resetSkyboxProgressEvents(window);
  const button = window.getByRole('button', { name: '同步数据中台天空盒', exact: true });
  await button.waitFor({ state: 'visible' });
  await button.click();
  return waitForSkyboxTerminalProgress(window);
}

async function retrySkyboxSync(window) {
  await resetSkyboxProgressEvents(window);
  const button = window.getByRole('button', { name: '重试同步', exact: true });
  await button.waitFor({ state: 'visible' });
  await button.click();
  return waitForSkyboxTerminalProgress(window);
}

function findSerializedSkybox(sceneFile) {
  for (const entityId of sceneFile.scene.entityIds ?? []) {
    const entity = sceneFile.scene.entities?.[entityId];
    if (entity?.components?.skybox) return { entityId, entity };
  }
  return null;
}

async function readSerializedSkybox(sceneFilePath) {
  const sceneFile = JSON.parse(await readFile(sceneFilePath, 'utf8'));
  const result = findSerializedSkybox(sceneFile);
  assert.ok(result, `场景文件缺少天空盒实体：${sceneFilePath}`);
  return result;
}

async function waitForSerializedSkyboxRevision(sceneFilePath, expectedRevision, timeoutMs = 10_000) {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const result = await readSerializedSkybox(sceneFilePath);
      if (result.entity.components.skybox.assetRevision === expectedRevision) return result;
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(`等待场景保存天空盒 revision=${expectedRevision} 超时${lastError ? `：${lastError}` : ''}`);
}

function assertNumberClose(actual, expected, label, epsilon = 1e-9) {
  assert.equal(typeof actual, 'number', `${label} 必须是 number`);
  assert.ok(Math.abs(actual - expected) <= epsilon, `${label} 不一致：${actual} !== ${expected}`);
}

function assertTransformPreserved(actual) {
  for (const field of ['position', 'rotation', 'scale']) {
    for (const axis of ['x', 'y', 'z']) {
      assertNumberClose(actual[field][axis], INITIAL_TRANSFORM[field][axis], `Transform.${field}.${axis}`);
    }
  }
}

async function saveSceneAndWaitForRevision(window, sceneFilePath, expectedRevision) {
  await window.getByRole('button', { name: '保存场景', exact: true }).click();
  return waitForSerializedSkyboxRevision(sceneFilePath, expectedRevision);
}

async function assertSceneBecameDirty(app, window, baseUrl) {
  await window.evaluate(() => {
    window.__dataPlatformSkyboxSmokeConfirmMessages = [];
    window.__dataPlatformSkyboxSmokeOriginalConfirm = window.confirm;
    window.confirm = (message) => {
      window.__dataPlatformSkyboxSmokeConfirmMessages.push(String(message));
      return false;
    };
  });

  const deepLink = `zending3d://open-project?projectId=${encodeURIComponent(PROJECT_ID)}&baseUrl=${encodeURIComponent(baseUrl)}`;
  await app.evaluate(({ app }, value) => {
    app.emit('second-instance', {}, [value], '', {});
  }, deepLink);

  try {
    await window.waitForFunction(() => (
      (window.__dataPlatformSkyboxSmokeConfirmMessages ?? []).length > 0
    ), undefined, { timeout: 10_000 });
    const messages = await window.evaluate(() => window.__dataPlatformSkyboxSmokeConfirmMessages ?? []);
    assert.match(messages[0], /当前场景有未保存修改/);
  } finally {
    await window.evaluate(() => {
      if (window.__dataPlatformSkyboxSmokeOriginalConfirm) {
        window.confirm = window.__dataPlatformSkyboxSmokeOriginalConfirm;
      }
      delete window.__dataPlatformSkyboxSmokeOriginalConfirm;
    });
  }
}

async function waitForUndoState(window, enabled) {
  await window.waitForFunction((shouldEnable) => {
    const button = document.querySelector('button[aria-label="撤销 (Ctrl+Z)"]');
    return button instanceof HTMLButtonElement && button.disabled !== shouldEnable;
  }, enabled, { timeout: 10_000 });
}

async function captureCleanupFailure(cleanupErrors, label, cleanup) {
  try {
    await cleanup();
  } catch (error) {
    cleanupErrors.push({ label, error });
  }
}

function formatCleanupFailures(cleanupErrors) {
  return cleanupErrors.map(({ label, error }) => (
    `${label}: ${error instanceof Error ? error.message : String(error)}`
  )).join('; ');
}

async function run() {
  let fixtureRoot = null;
  let storageRoot = null;
  let userDataRoot = null;
  let mock;
  let launched;
  let runError = null;

  try {
    fixtureRoot = await mkdtemp(path.join(tmpdir(), 'zending-data-platform-skybox-fixtures-'));
    storageRoot = await mkdtemp(path.join(tmpdir(), 'zending-data-platform-skybox-storage-'));
    userDataRoot = await mkdtemp(path.join(tmpdir(), 'zending-data-platform-skybox-userdata-'));
    const initialBytes = createHdrFixture('initial', 32);
    const replacementBytes = createHdrFixture('replacement', 48);
    const recoveredBytes = createHdrFixture('recovered', 80);
    const initialSha256 = sha256(initialBytes);
    const replacementSha256 = sha256(replacementBytes);
    const recoveredSha256 = sha256(recoveredBytes);
    const sharedResourcesRoot = path.join(storageRoot, 'SharedResources');
    const projectRoot = path.join(storageRoot, 'Projects', PROJECT_ID);
    const sceneFilePath = path.join(projectRoot, 'Scenes', SCENE_FILE_NAME);
    const indexPath = path.join(sharedResourcesRoot, '.babylon-editor', 'data-platform-skybox-index.json');
    const cachedSkyboxPath = path.join(sharedResourcesRoot, ...SKYBOX_RELATIVE_PATH.split('/'));
    logStage('创建项目与天空盒夹具');
    const projectPackage = await createProjectPackage(fixtureRoot, storageRoot, initialSha256);
    assert.equal(projectPackage.skyboxPath, cachedSkyboxPath);
    mock = await startMockServer({ archiveBytes: projectPackage.archiveBytes, initialBytes });
    logStage(`本地数据中台已启动：${mock.baseUrl}`);
    await writeDataPlatformConfig(userDataRoot, mock.baseUrl, storageRoot);
    logStage('启动 Electron');
    launched = await launchEditor(userDataRoot);
    logStage('Electron preload bridge 已就绪');
    await installSkyboxProgressCollector(launched.window);
    logStage('天空盒进度订阅已安装');

    const projectCard = launched.window.locator('.home-data-platform-card', { hasText: PROJECT_NAME });
    await projectCard.waitFor({ state: 'visible', timeout: 20_000 });
    logStage('打开数据中台项目');
    await projectCard.getByRole('button', { name: '打开', exact: true }).click();
    await mock.waitForFirstSkyboxQuery();

    let openedBeforeSkyboxQueryResponse = false;
    try {
      await launched.window.locator('.project-library').waitFor({ state: 'visible', timeout: 15_000 });
      openedBeforeSkyboxQueryResponse = !mock.hasSentFirstSkyboxQueryResponse();
      logStage('编辑器已在首个天空盒查询响应前进入');
    } finally {
      mock.releaseFirstSkyboxQuery();
    }
    assert.equal(
      openedBeforeSkyboxQueryResponse,
      true,
      '数据中台项目打开被延迟至少 1 秒的天空盒查询阻塞。',
    );

    logStage('等待首次自动天空盒同步');
    const firstSync = await waitForSkyboxTerminalProgress(launched.window);
    assert.equal(firstSync.finalProgress?.phase, 'completed', firstSync.finalProgress?.error ?? firstSync.finalProgress?.message);
    assert.ok(firstSync.events.some((progress) => progress.phase === 'querying'));
    assert.ok(firstSync.events.some((progress) => progress.phase === 'downloading'));
    assert.ok(firstSync.events.some((progress) => progress.phase === 'validating'));
    assert.ok(firstSync.events.some((progress) => progress.phase === 'promoting'));
    assert.equal(mock.getDownloadCount(), 1);

    await launched.window.locator('.project-library .library-tab', { hasText: '天空盒' }).click();
    const skyboxCard = launched.window.locator('.skybox-resource-card', { hasText: SKYBOX_NAME });
    await skyboxCard.waitFor({ state: 'visible', timeout: 20_000 });
    assert.match((await skyboxCard.textContent()) ?? '', /数据中台/);

    const firstIndex = JSON.parse(await readFile(indexPath, 'utf8'));
    assert.equal(firstIndex.version, 1);
    assert.equal(firstIndex.entries.length, 1);
    assert.equal(firstIndex.entries[0].resourceId, SKYBOX_ID);
    assert.equal(firstIndex.entries[0].revision, '1');
    assert.equal(firstIndex.entries[0].sha256, initialSha256);
    assert.equal(firstIndex.entries[0].status, 'active');
    assert.deepEqual(await readFile(cachedSkyboxPath), initialBytes);

    logStage('验证第二次零下载同步');
    const downloadsBeforeNoop = mock.getDownloadCount();
    const noopSync = await runManualSkyboxSync(launched.window);
    assert.equal(noopSync.finalProgress?.phase, 'completed', noopSync.finalProgress?.error ?? noopSync.finalProgress?.message);
    assert.match(noopSync.finalProgress?.message ?? '', /本次下载 0 项/);
    assert.equal(mock.getDownloadCount(), downloadsBeforeNoop);

    logStage('验证同 stable ID 替换、dirty 与 undo');
    mock.setRemote(replacementBytes, '2');
    const replacementSync = await runManualSkyboxSync(launched.window);
    assert.equal(
      replacementSync.finalProgress?.phase,
      'completed',
      replacementSync.finalProgress?.error ?? replacementSync.finalProgress?.message,
    );
    assert.equal(mock.getDownloadCount(), downloadsBeforeNoop + 1);
    await waitForUndoState(launched.window, true);
    await assertSceneBecameDirty(launched.app, launched.window, mock.baseUrl);

    const replacedSaved = await saveSceneAndWaitForRevision(launched.window, sceneFilePath, replacementSha256);
    assert.equal(replacedSaved.entity.components.skybox.dataPlatformResourceId, SKYBOX_ID);
    assert.equal(replacedSaved.entity.components.skybox.intensity, INITIAL_INTENSITY);
    assert.equal(replacedSaved.entity.components.skybox.resolution, INITIAL_RESOLUTION);
    assertTransformPreserved(replacedSaved.entity.components.transform);

    await launched.window.getByRole('button', { name: '撤销 (Ctrl+Z)', exact: true }).click();
    const undoneSaved = await saveSceneAndWaitForRevision(launched.window, sceneFilePath, initialSha256);
    assert.equal(undoneSaved.entity.components.skybox.dataPlatformResourceId, SKYBOX_ID);
    assert.equal(undoneSaved.entity.components.skybox.intensity, INITIAL_INTENSITY);
    assert.equal(undoneSaved.entity.components.skybox.resolution, INITIAL_RESOLUTION);
    assertTransformPreserved(undoneSaved.entity.components.transform);

    const redoButton = launched.window.getByRole('button', { name: '重做', exact: true });
    await redoButton.waitFor({ state: 'visible' });
    assert.equal(await redoButton.isEnabled(), true, '天空盒替换撤销后未产生可用重做记录。');
    await redoButton.click();
    const redoneSaved = await saveSceneAndWaitForRevision(launched.window, sceneFilePath, replacementSha256);
    assert.equal(redoneSaved.entity.components.skybox.dataPlatformResourceId, SKYBOX_ID);
    assertTransformPreserved(redoneSaved.entity.components.transform);

    logStage('验证远端删除与 orphaned 兼容缓存');
    mock.deleteRemote();
    const downloadsBeforeDelete = mock.getDownloadCount();
    const deleteSync = await runManualSkyboxSync(launched.window);
    assert.equal(deleteSync.finalProgress?.phase, 'completed', deleteSync.finalProgress?.error ?? deleteSync.finalProgress?.message);
    assert.equal(mock.getDownloadCount(), downloadsBeforeDelete);
    await skyboxCard.waitFor({ state: 'detached', timeout: 10_000 });
    const orphanedWarning = launched.window.locator('.library-sync-status-warning');
    await orphanedWarning.waitFor({ state: 'visible', timeout: 10_000 });
    assert.match((await orphanedWarning.textContent()) ?? '', /资源已从数据中台删除/);
    assert.match((await orphanedWarning.textContent()) ?? '', new RegExp(SKYBOX_ID));
    await launched.window.locator('.entity-tree-row', { hasText: '天空盒 中台晨曦' }).waitFor({ state: 'visible' });
    await stat(cachedSkyboxPath);
    assert.deepEqual(await readFile(cachedSkyboxPath), replacementBytes);
    const orphanedIndexText = await readFile(indexPath, 'utf8');
    const orphanedIndex = JSON.parse(orphanedIndexText);
    assert.equal(orphanedIndex.entries[0].status, 'orphaned');
    assert.equal(orphanedIndex.entries[0].sha256, replacementSha256);

    logStage('验证错误 SHA 回滚与重试');
    mock.setRemote(recoveredBytes, '3', '0'.repeat(64));
    const downloadsBeforeBadSha = mock.getDownloadCount();
    const badShaSync = await runManualSkyboxSync(launched.window);
    assert.equal(badShaSync.finalProgress?.phase, 'failed');
    assert.match(badShaSync.finalProgress?.error ?? '', /SHA-256/);
    assert.equal(mock.getDownloadCount(), downloadsBeforeBadSha + 1);
    const failedStatus = launched.window.locator('.library-sync-status-failed');
    await failedStatus.waitFor({ state: 'visible', timeout: 10_000 });
    await failedStatus.getByRole('button', { name: '重试同步', exact: true }).waitFor({ state: 'visible' });
    assert.equal(await readFile(indexPath, 'utf8'), orphanedIndexText, '错误 SHA 同步修改了旧索引。');
    assert.deepEqual(await readFile(cachedSkyboxPath), replacementBytes, '错误 SHA 同步覆盖了旧缓存。');

    mock.setRemote(recoveredBytes, '3', recoveredSha256);
    const retrySync = await retrySkyboxSync(launched.window);
    assert.equal(retrySync.finalProgress?.phase, 'completed', retrySync.finalProgress?.error ?? retrySync.finalProgress?.message);
    assert.equal(mock.getDownloadCount(), downloadsBeforeBadSha + 2);
    await skyboxCard.waitFor({ state: 'visible', timeout: 10_000 });
    await orphanedWarning.waitFor({ state: 'detached', timeout: 10_000 });
    const recoveredIndex = JSON.parse(await readFile(indexPath, 'utf8'));
    assert.equal(recoveredIndex.entries[0].status, 'active');
    assert.equal(recoveredIndex.entries[0].revision, '3');
    assert.equal(recoveredIndex.entries[0].sha256, recoveredSha256);
    assert.deepEqual(await readFile(cachedSkyboxPath), recoveredBytes);
    assert.ok(mock.getQueryCount() >= 6);

    console.log(JSON.stringify({
      status: 'PASS',
      requests: mock.requests.length,
      skyboxQueries: mock.getQueryCount(),
      skyboxDownloads: mock.getDownloadCount(),
      verified: [
        'project-open-not-blocked-by-one-second-skybox-query',
        'first-sync-card-download-count-and-index',
        'second-sync-zero-download',
        'stable-id-replacement-preserves-parameters-and-transform',
        'replacement-marks-scene-dirty-and-is-undoable',
        'remote-delete-hides-card-and-keeps-orphaned-cache',
        'bad-sha-preserves-old-library-and-shows-retry',
        'retry-recovers-active-skybox-library',
      ],
    }, null, 2));
  } catch (error) {
    runError = error;
    throw error;
  } finally {
    logStage('清理本次 Smoke 资源');
    const cleanupErrors = [];
    mock?.releaseFirstSkyboxQuery();

    if (launched) {
      await launched.window.evaluate(() => {
        window.__dataPlatformSkyboxSmokeUnsubscribe?.();
        delete window.__dataPlatformSkyboxSmokeUnsubscribe;
        delete window.__dataPlatformSkyboxSmokeEvents;
        delete window.__dataPlatformSkyboxSmokeConfirmMessages;
      }).catch(() => undefined);
      await captureCleanupFailure(cleanupErrors, 'Electron', () => closeLaunchedEditor(launched));
    }
    if (mock) {
      await captureCleanupFailure(cleanupErrors, 'mock server', () => mock.close());
    }

    await Promise.all([
      ['fixtureRoot', fixtureRoot],
      ['storageRoot', storageRoot],
      ['userDataRoot', userDataRoot],
    ].filter(([, target]) => target !== null).map(([label, target]) => (
      captureCleanupFailure(cleanupErrors, label, () => rm(target, {
        recursive: true,
        force: true,
        maxRetries: 8,
        retryDelay: 200,
      }))
    )));

    if (cleanupErrors.length > 0) {
      const details = formatCleanupFailures(cleanupErrors);
      if (runError) {
        console.error(`[data-platform-skybox-smoke] cleanup failed after primary error: ${details}`);
      } else {
        throw new AggregateError(
          cleanupErrors.map(({ error }) => error),
          `Smoke 清理失败：${details}`,
        );
      }
    }
  }
}

run().catch((error) => {
  console.error(`[data-platform-skybox-smoke] ${error instanceof Error ? error.stack : String(error)}`);
  process.exitCode = 1;
});
