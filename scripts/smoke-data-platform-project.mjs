import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZipArchive } from 'archiver';
import { _electron as electron } from 'playwright';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const workspaceRoot = path.resolve(__dirname, '..');
const pngBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const VALID_PROJECT_ID = '2054201280000000001';
const GLOBAL_MODEL_ID = '2058110298388180993';
const PLAIN_MODEL_ID = '2071961332827041794';
const ENVIRONMENT_MODEL_ID = '2058110298000000001';
const COMBO_MODEL_ID = '2058110298000000002';

async function holdWindowsFileWithoutDeleteSharing(filePath) {
  if (process.platform !== 'win32') {
    return {
      completion: Promise.resolve(),
      release: () => undefined,
    };
  }

  const powershellPath = path.join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  const escapedPath = filePath.replace(/'/g, "''");
  const command = `$stream = [System.IO.File]::Open('${escapedPath}', [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read); try { [Console]::Out.WriteLine('LOCKED'); [Console]::Out.Flush(); [Console]::In.ReadLine() | Out-Null } finally { $stream.Dispose() }`;
  const child = spawn(powershellPath, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  await new Promise((resolve, reject) => {
    let stdout = '';
    const timeout = setTimeout(() => {
      cleanup();
      child.kill();
      reject(new Error(`等待 Windows 文件锁就绪超时：${filePath}`));
    }, 5000);
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout.off('data', onData);
      child.off('error', onError);
      child.off('exit', onExit);
    };
    const onData = (chunk) => {
      stdout += chunk;
      if (!stdout.includes('LOCKED')) return;
      cleanup();
      resolve();
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code) => {
      cleanup();
      reject(new Error(`Windows 文件锁进程提前退出（${code}）：${stderr.trim()}`));
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', onData);
    child.once('error', onError);
    child.once('exit', onExit);
  });

  let released = false;
  return {
    completion: new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Windows 文件锁进程失败（${code}）：${stderr.trim()}`));
      });
    }),
    release: () => {
      if (released) return;
      released = true;
      child.stdin.end('RELEASE\n');
    },
  };
}

function createMinimalGlb() {
  const jsonSource = JSON.stringify({ asset: { version: '2.0', generator: 'data-platform-smoke' }, scenes: [{ nodes: [] }], scene: 0 });
  const jsonBytes = Buffer.from(jsonSource, 'utf8');
  const paddedLength = Math.ceil(jsonBytes.length / 4) * 4;
  const jsonChunk = Buffer.alloc(paddedLength, 0x20);
  jsonBytes.copy(jsonChunk);
  const totalLength = 12 + 8 + jsonChunk.length;
  const result = Buffer.alloc(totalLength);
  result.write('glTF', 0, 4, 'ascii');
  result.writeUInt32LE(2, 4);
  result.writeUInt32LE(totalLength, 8);
  result.writeUInt32LE(jsonChunk.length, 12);
  result.writeUInt32LE(0x4e4f534a, 16);
  jsonChunk.copy(result, 20);
  return result;
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

async function createMaliciousZip(archivePath) {
  const safeRoot = await mkdtemp(path.join(tmpdir(), 'zending-malicious-source-'));
  try {
    await mkdir(path.join(safeRoot, 'aa'), { recursive: true });
    await writeFile(path.join(safeRoot, 'aa', 'escape.txt'), 'escape', 'utf8');
    await createZipFromDirectory(safeRoot, archivePath);
    const bytes = await readFile(archivePath);
    const safeName = Buffer.from('aa/escape.txt', 'utf8');
    const maliciousName = Buffer.from('../escape.txt', 'utf8');
    assert.equal(safeName.length, maliciousName.length);
    let replacements = 0;
    for (let offset = 0; offset <= bytes.length - safeName.length; offset += 1) {
      if (bytes.subarray(offset, offset + safeName.length).equals(safeName)) {
        maliciousName.copy(bytes, offset);
        replacements += 1;
      }
    }
    assert.ok(replacements >= 2, '未能同时修改 ZIP 本地头和中央目录路径');
    await writeFile(archivePath, bytes);
  } finally {
    await rm(safeRoot, { recursive: true, force: true });
  }
}

async function createSymlinkZip(archivePath) {
  await mkdir(path.dirname(archivePath), { recursive: true });
  await new Promise((resolve, reject) => {
    const output = createWriteStream(archivePath);
    const archive = new ZipArchive({ zlib: { level: 9 } });
    output.once('close', resolve);
    output.once('error', reject);
    archive.once('error', reject);
    archive.pipe(output);
    archive.symlink('linked-project', 'target-project');
    void archive.finalize();
  });
}

async function createSceneFixture() {
  const source = JSON.parse(await readFile(path.join(workspaceRoot, 'examples', 'scenes', 'generic-mqtt-motion-demo.scene.json'), 'utf8'));
  const sourceEntity = structuredClone(source.scene.entities[source.scene.entityIds[0]]);
  const entityId = 'entity_data_platform_smoke';
  const oldModelPath = 'D:\\old-editor\\Assets\\Models\\PackageModel\\PackageModel.glb';
  const oldScriptPath = 'D:\\old-editor\\Assets\\Models\\PackageModel\\package.model.ts';
  sourceEntity.id = entityId;
  sourceEntity.name = '数据中台工程包模型';
  sourceEntity.parentId = null;
  sourceEntity.childrenIds = [];
  sourceEntity.components.modelAsset.sourcePath = oldModelPath;
  sourceEntity.components.modelAsset.sourceUrl = `editor-asset://local/${encodeURIComponent(oldModelPath)}`;
  sourceEntity.components.modelAsset.scriptAssets = [{
    path: oldScriptPath,
    sourceUrl: `editor-asset://local/${encodeURIComponent(oldScriptPath)}`,
    name: 'package.model.ts',
  }];

  source.scene.id = 'scene_data_platform_smoke';
  source.scene.name = '数据中台工程包场景';
  source.scene.entityIds = [entityId];
  source.scene.entities = { [entityId]: sourceEntity };
  source.scene.selectedEntityId = null;
  if (source.scene.sceneSettings) source.scene.sceneSettings.environment = null;
  return `${JSON.stringify(source, null, 2)}\n`;
}

async function createFixtures(root) {
  const currentRoot = path.join(root, 'current');
  await mkdir(path.join(currentRoot, '.babylon-editor'), { recursive: true });
  await mkdir(path.join(currentRoot, 'Assets', 'Models', 'PackageModel'), { recursive: true });
  await mkdir(path.join(currentRoot, 'Assets', 'Environments', 'PackageEnv'), { recursive: true });
  await mkdir(path.join(currentRoot, 'Scenes'), { recursive: true });
  await writeFile(path.join(currentRoot, '.babylon-editor', 'asset-index.json'), JSON.stringify({
    version: 2,
    assets: [{ path: 'D:\\stale\\PackageModel.glb', kind: 'model', libraryKind: 'model' }],
  }));
  await writeFile(path.join(currentRoot, 'Assets', 'Models', 'PackageModel', 'PackageModel.glb'), createMinimalGlb());
  await writeFile(path.join(currentRoot, 'Assets', 'Models', 'PackageModel', 'package.model.ts'), 'export const dataDriven = {};\n');
  await writeFile(path.join(currentRoot, 'Assets', 'Models', 'PackageModel', 'thumb.png'), pngBytes);
  await writeFile(path.join(currentRoot, 'Assets', 'Models', 'PackageModel', 'meta.json'), JSON.stringify({ lengthUnit: 'meter', thumbnail: 'thumb.png' }));
  await writeFile(path.join(currentRoot, 'Assets', 'Environments', 'PackageEnv', 'PackageEnv.glb'), createMinimalGlb());
  await writeFile(path.join(currentRoot, 'Assets', 'Environments', 'PackageEnv', 'meta.json'), JSON.stringify({ lengthUnit: 'meter' }));
  await writeFile(path.join(currentRoot, 'Scenes', 'remote.scene.json'), await createSceneFixture());

  const oldRoot = path.join(root, 'old');
  await mkdir(oldRoot, { recursive: true });
  await writeFile(path.join(oldRoot, 'project.bjseditor'), '{}', 'utf8');

  const incompatibleRoot = path.join(root, 'incompatible');
  await mkdir(path.join(incompatibleRoot, '.babylon-editor'), { recursive: true });
  await mkdir(path.join(incompatibleRoot, 'Assets', 'Models'), { recursive: true });
  await mkdir(path.join(incompatibleRoot, 'Assets', 'Environments'), { recursive: true });

  const currentZip = path.join(root, 'current.zip');
  const oldZip = path.join(root, 'old.zip');
  const incompatibleZip = path.join(root, 'incompatible.zip');
  const maliciousZip = path.join(root, 'malicious.zip');
  const corruptZip = path.join(root, 'corrupt.zip');
  const symlinkZip = path.join(root, 'symlink.zip');
  await createZipFromDirectory(currentRoot, currentZip, 'wrapped-current');
  await createZipFromDirectory(oldRoot, oldZip, 'legacy-wrapper');
  await createZipFromDirectory(incompatibleRoot, incompatibleZip, 'incompatible-wrapper');
  await createMaliciousZip(maliciousZip);
  await createSymlinkZip(symlinkZip);
  await writeFile(corruptZip, Buffer.from('not-a-zip'));

  const modelFiles = new Map([
    ['global.glb', createMinimalGlb()],
    ['global-meta.json', Buffer.from(JSON.stringify({ lengthUnit: 'meter', thumbnail: 'remote-name.png' }))],
    ['global-runtime.ts', Buffer.from('export const dataDriven = { device: { defaultAssetCode: "GLOBAL" } };\n')],
    ['global-thumbnail.png', pngBytes],
    ['plain.glb', createMinimalGlb()],
    ['environment.glb', createMinimalGlb()],
    ['environment-thumbnail.png', pngBytes],
    ['combo.glb', createMinimalGlb()],
    ['combo-thumbnail.png', pngBytes],
  ]);

  return {
    archives: new Map([
      ['current.zip', await readFile(currentZip)],
      ['old.zip', await readFile(oldZip)],
      ['incompatible.zip', await readFile(incompatibleZip)],
      ['malicious.zip', await readFile(maliciousZip)],
      ['corrupt.zip', await readFile(corruptZip)],
      ['symlink.zip', await readFile(symlinkZip)],
    ]),
    modelFiles,
  };
}

function createProject(id, projectName, packageName = null, sortIndex = Number(id)) {
  const normalizedId = String(id);
  return {
    id: normalizedId,
    projectName,
    sceneCount: 1,
    screenCount: 2,
    modelCount: 3,
    envModelCount: 1,
    comboModelCount: 1,
    poiCount: 0,
    chartCount: 0,
    themeCount: 0,
    latestEditorProjectId: packageName ? `${normalizedId}01` : null,
    latestEditorProjectVersionId: packageName ? `${normalizedId}02` : null,
    latestEditorProjectVersionNumber: packageName ? 1 : null,
    latestEditorProjectName: packageName ? `${projectName} Editor` : null,
    latestEditorProjectPackageUrl: packageName ? `files/${packageName}` : null,
    latestEditorProjectPackageFileName: packageName,
    updatedAt: `2026-07-${String(10 + sortIndex).padStart(2, '0')}T08:00:00Z`,
  };
}

async function startMockServer(fixtures) {
  const requests = [];
  const projects = [
    createProject(VALID_PROJECT_ID, '有效工程包项目', 'current.zip', 1),
    createProject('2', '无工程包项目', null, 2),
    createProject('3', '旧工程包项目', 'old.zip', 3),
    createProject('4', '缺少场景项目', 'incompatible.zip', 4),
    createProject('5', '恶意路径项目', 'malicious.zip', 5),
    createProject('6', '损坏工程包项目', 'corrupt.zip', 6),
    createProject('7', '下载失败项目', 'missing.zip', 7),
    createProject('8', '符号链接工程包项目', 'symlink.zip', 8),
  ];
  let failNextModelFile = false;
  let activeModelFileDownloads = 0;
  let maxActiveModelFileDownloads = 0;

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const bodyText = Buffer.concat(chunks).toString('utf8');
    const body = bodyText ? JSON.parse(bodyText) : null;
    requests.push({ method: request.method, path: url.pathname, body });

    const sendJson = (payload, status = 200) => {
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(payload));
    };

    if (request.method === 'POST' && url.pathname === '/platform/api/v1/projects/query') {
      const projectName = typeof body?.projectName === 'string' ? body.projectName : '';
      const records = projectName ? projects.filter((item) => item.projectName.includes(projectName)) : projects;
      sendJson({ success: true, data: { records, total: records.length, pageNum: 1, pageSize: 12 } });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/platform/api/v1/models/query') {
      sendJson({ success: true, data: { records: body?.pageNum === 1 ? [{
        id: GLOBAL_MODEL_ID,
        modelName: '全局普通模型',
        thumbnailUrl: 'files/global-thumbnail.png',
        fileName: 'global.glb',
        fileUrl: 'files/global.glb',
        metaFileName: 'meta.json',
        metaFileUrl: 'files/global-meta.json',
        scriptFileName: 'legacy-one.ts\nlegacy-two.ts',
        scriptFileUrl: 'files/legacy-one.ts\nfiles/legacy-two.ts',
        scriptFiles: [
          { fileName: 'global-runtime.ts', fileUrl: 'files/global-runtime.ts', sortOrder: 1 },
          { fileName: 'ignore.js', fileUrl: 'files/not-a-typescript-file.js', sortOrder: 2 },
        ],
      }, {
        id: PLAIN_MODEL_ID,
        modelName: '无脚本普通模型',
        fileName: 'plain.glb',
        fileUrl: 'files/plain.glb',
        scriptFileName: null,
        scriptFileUrl: null,
        scriptFiles: [],
      }] : [], total: 2, pageNum: body?.pageNum ?? 1, pageSize: 100 } });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/platform/api/v1/env-models/query') {
      sendJson({ success: true, data: { records: body?.pageNum === 1 ? [{
        id: ENVIRONMENT_MODEL_ID,
        modelName: '全局环境模型',
        thumbnailUrl: 'files/environment-thumbnail.png',
        fileName: 'environment.glb',
        fileUrl: 'files/environment.glb',
      }] : [], total: 1, pageNum: body?.pageNum ?? 1, pageSize: 100 } });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/platform/api/v1/combo-models/query') {
      sendJson({ success: true, data: { records: body?.pageNum === 1 ? [{
        id: COMBO_MODEL_ID,
        comboModelName: '全局组合模型',
        thumbnailUrl: 'files/combo-thumbnail.png',
        fileName: 'combo.glb',
        fileUrl: 'files/combo.glb',
      }] : [], total: 1, pageNum: body?.pageNum ?? 1, pageSize: 100 } });
      return;
    }

    const filePrefix = '/platform/files/';
    if (request.method === 'GET' && url.pathname.startsWith(filePrefix)) {
      const fileName = decodeURIComponent(url.pathname.slice(filePrefix.length));
      if (fileName === 'global.glb' && failNextModelFile) {
        failNextModelFile = false;
        sendJson({ success: false, message: 'injected model download failure' }, 500);
        return;
      }
      const bytes = fixtures.archives.get(fileName) ?? fixtures.modelFiles.get(fileName);
      if (!bytes) {
        sendJson({ success: false, message: 'fixture missing' }, 500);
        return;
      }
      const isModelFileDownload = fixtures.modelFiles.has(fileName);
      if (isModelFileDownload) {
        activeModelFileDownloads += 1;
        maxActiveModelFileDownloads = Math.max(maxActiveModelFileDownloads, activeModelFileDownloads);
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      try {
        const contentType = fileName.endsWith('.zip') ? 'application/zip'
          : fileName.endsWith('.json') ? 'application/json'
            : fileName.endsWith('.ts') ? 'text/plain'
              : fileName.endsWith('.png') ? 'image/png'
                : 'model/gltf-binary';
        response.writeHead(200, { 'content-type': contentType, 'content-length': String(bytes.length) });
        response.end(bytes);
      } finally {
        if (isModelFileDownload) activeModelFileDownloads -= 1;
      }
      return;
    }

    sendJson({ success: false, message: 'not found' }, 404);
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
    failNextModelDownload: () => {
      failNextModelFile = true;
    },
    getMaxConcurrentModelDownloads: () => maxActiveModelFileDownloads,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

async function launchEditor(storageRoot, userDataRoot) {
  const env = {
    ...process.env,
    OPEN_DEVTOOLS: 'false',
    VITE_DEV_SERVER_URL: '',
    ZENDING_ALLOW_STORAGE_ROOT_OVERRIDE: '1',
    ZENDING_EDITOR_STORAGE_ROOT: storageRoot,
  };
  const app = await electron.launch({
    args: [workspaceRoot, `--user-data-dir=${userDataRoot}`],
    cwd: workspaceRoot,
    env,
  });
  const window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');
  await window.locator('#root').waitFor({ state: 'attached' });
  return { app, window };
}

async function configureAndList(window, baseUrl) {
  return window.evaluate(async (value) => {
    const saved = await window.editorApi.saveDataPlatformConfig({ baseUrl: value });
    const list = await window.editorApi.listDataPlatformProjects({ projectName: '' });
    return { saved, list };
  }, baseUrl);
}

async function openAndWaitForSync(window, projectId) {
  return window.evaluate(async (id) => {
    const openResult = await window.editorApi.openDataPlatformProject({ projectId: id });
    const events = [];
    const finalProgress = await new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        unsubscribe();
        reject(new Error('等待模型同步完成超时'));
      }, 20000);
      const unsubscribe = window.editorApi.onDataPlatformModelSyncProgress((progress) => {
        events.push(progress);
        if (progress.phase === 'completed' || progress.phase === 'failed') {
          window.clearTimeout(timeout);
          unsubscribe();
          resolve(progress);
        }
      });
    });
    return { openResult, finalProgress, events };
  }, projectId);
}

async function retryAndWaitForSync(window) {
  return window.evaluate(async () => {
    const retryStarted = await window.editorApi.retryDataPlatformModelSync();
    if (!retryStarted) throw new Error('模型同步重试未启动');
    const events = [];
    const finalProgress = await new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        unsubscribe();
        reject(new Error('等待模型同步重试完成超时'));
      }, 20000);
      const unsubscribe = window.editorApi.onDataPlatformModelSyncProgress((progress) => {
        events.push(progress);
        if (progress.phase === 'promoting' && typeof window.__releaseDataPlatformSmokeFileLock === 'function') {
          void window.__releaseDataPlatformSmokeFileLock();
        }
        if (progress.phase === 'completed' || progress.phase === 'failed') {
          window.clearTimeout(timeout);
          unsubscribe();
          resolve(progress);
        }
      });
    });
    return { retryStarted, finalProgress, events };
  });
}

async function expectOpenFailure(window, projectId, expectedText) {
  const message = await window.evaluate(async ({ id, expected }) => {
    try {
      await window.editorApi.openDataPlatformProject({ projectId: id });
      return null;
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      if (!text.includes(expected)) throw error;
      return text;
    }
  }, { id: projectId, expected: expectedText });
  assert.ok(message?.includes(expectedText));
}

async function inspectResourceStrip(window, exerciseHorizontalScroll = false) {
  return window.evaluate((shouldExerciseHorizontalScroll) => {
    const list = document.querySelector('.project-library .resource-card-list');
    if (!(list instanceof HTMLElement)) throw new Error('未找到资源卡片列表');

    const cards = [...list.querySelectorAll('.resource-card')].filter((node) => node instanceof HTMLElement);
    const style = window.getComputedStyle(list);
    const listRect = list.getBoundingClientRect();
    const cardRects = cards.map((card) => card.getBoundingClientRect());
    const cardTops = cardRects.map((rect) => rect.top);
    const originalScrollLeft = list.scrollLeft;
    const originalScrollTop = list.scrollTop;
    let maximumScrollLeft = 0;
    let focusedScrollLeft = 0;
    let lastCardInsideViewport = cards.length === 0;

    list.scrollLeft = 0;
    if (shouldExerciseHorizontalScroll && cards.length > 0) {
      list.scrollLeft = list.scrollWidth;
      maximumScrollLeft = list.scrollLeft;
      list.scrollLeft = 0;
      cards.at(-1)?.scrollIntoView({ behavior: 'auto', block: 'nearest', inline: 'center' });
      focusedScrollLeft = list.scrollLeft;
      const lastCardRect = cards.at(-1)?.getBoundingClientRect();
      lastCardInsideViewport = Boolean(
        lastCardRect && lastCardRect.left >= listRect.left - 1 && lastCardRect.right <= listRect.right + 1,
      );
    }

    list.scrollTop = 100;
    const attemptedScrollTop = list.scrollTop;
    list.scrollLeft = originalScrollLeft;
    list.scrollTop = originalScrollTop;

    const listClientBottom = listRect.top + list.clientHeight;
    const topSpread = cardTops.length > 0 ? Math.max(...cardTops) - Math.min(...cardTops) : 0;
    const cardsFullyVisible = cardRects.every(
      (rect) => rect.top >= listRect.top - 1 && rect.bottom <= listClientBottom + 1,
    );
    const maxCardBottom = cardRects.length > 0 ? Math.max(...cardRects.map((rect) => rect.bottom)) : listRect.top;
    const panel = list.closest('.project-library');
    const bottomWorkspace = panel?.parentElement;
    const scenePanel = document.querySelector('.scene-panel');

    return {
      bottomWorkspaceHeight: bottomWorkspace?.getBoundingClientRect().height ?? 0,
      cardBottomGap: listClientBottom - maxCardBottom,
      cardCount: cards.length,
      cardHeights: cardRects.map((rect) => rect.height),
      cardsFullyVisible,
      clientHeight: list.clientHeight,
      clientWidth: list.clientWidth,
      flexWrap: style.flexWrap,
      focusedScrollLeft,
      height: style.height,
      lastCardInsideViewport,
      listHeight: listRect.height,
      maximumScrollLeft,
      minHeight: style.minHeight,
      panelHeight: panel?.getBoundingClientRect().height ?? 0,
      scenePanelHeight: scenePanel?.getBoundingClientRect().height ?? 0,
      overflowX: style.overflowX,
      overflowY: style.overflowY,
      scrollHeight: list.scrollHeight,
      scrollWidth: list.scrollWidth,
      attemptedScrollTop,
      topSpread,
    };
  }, exerciseHorizontalScroll);
}

async function run() {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'zending-data-platform-fixtures-'));
  const storageRoot = await mkdtemp(path.join(tmpdir(), 'zending-data-platform-storage-'));
  const userDataRoot = await mkdtemp(path.join(tmpdir(), 'zending-data-platform-userdata-'));
  const unwritableUserDataRoot = await mkdtemp(path.join(tmpdir(), 'zending-data-platform-userdata-unwritable-'));
  const unwritableRoot = path.join(fixtureRoot, 'not-a-directory');
  let mock;
  let launched;
  let unwritableLaunched;

  try {
    const fixtures = await createFixtures(fixtureRoot);
    await writeFile(unwritableRoot, 'file blocks directory usage', 'utf8');
    mock = await startMockServer(fixtures);
    launched = await launchEditor(storageRoot, userDataRoot);

    const configured = await configureAndList(launched.window, `${mock.baseUrl}/`);
    assert.equal(configured.saved.baseUrl, mock.baseUrl);
    assert.equal(configured.list.records.length, 8);
    assert.deepEqual(configured.list.records.map((item) => item.id), ['8', '7', '6', '5', '4', '3', '2', VALID_PROJECT_ID]);
    assert.ok(configured.list.records.every((item) => typeof item.id === 'string'));

    const searched = await launched.window.evaluate(() => window.editorApi.listDataPlatformProjects({ projectName: '旧' }));
    assert.deepEqual(searched.records.map((item) => item.id), ['3']);
    await expectOpenFailure(launched.window, VALID_PROJECT_ID, '最近一次数据中台列表');
    await launched.window.evaluate(() => window.editorApi.listDataPlatformProjects({ projectName: '' }));

    await launched.app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setSize(1180, 720);
    });
    await launched.window.waitForTimeout(150);
    await launched.window.getByRole('button', { name: '数据中台配置' }).click();
    const minWindowLayout = await launched.window.evaluate(() => {
      const dialog = document.querySelector('.home-config-dialog')?.getBoundingClientRect();
      return {
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        canScrollX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        dialogInsideViewport: Boolean(dialog && dialog.left >= 0 && dialog.top >= 0 && dialog.right <= window.innerWidth && dialog.bottom <= window.innerHeight),
      };
    });
    assert.equal(minWindowLayout.canScrollX, false);
    assert.equal(minWindowLayout.dialogInsideViewport, true);
    await launched.window.getByRole('dialog').getByRole('button', { name: '取消' }).click();
    await launched.app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setSize(1440, 900);
    });

    const valid = await openAndWaitForSync(launched.window, VALID_PROJECT_ID);
    assert.equal(valid.openResult.source, 'package');
    assert.ok(valid.openResult.sceneFilePath?.endsWith('.scene.json'));
    assert.equal(valid.finalProgress.phase, 'completed', valid.finalProgress.error ?? valid.finalProgress.message);
    assert.ok(valid.events.some((item) => item.phase === 'downloading'));
    assert.ok(valid.events.some((item) => item.phase === 'validating'));
    assert.ok(valid.events.some((item) => item.phase === 'promoting'));

    const loadedScene = await launched.window.evaluate(async (filePath) => window.editorApi.loadSceneFile({ filePath }), valid.openResult.sceneFilePath);
    assert.equal(loadedScene.canceled, false);
    const loadedSceneDocument = JSON.parse(loadedScene.content);
    const loadedModelPath = loadedSceneDocument.scene.entities.entity_data_platform_smoke.components.modelAsset.sourcePath;
    assert.equal(loadedModelPath, path.join(storageRoot, 'Assets', 'Models', 'PackageModel', 'PackageModel.glb'));
    assert.ok(!loadedModelPath.includes('old-editor'));

    const assets = await launched.window.evaluate(() => window.editorApi.listProjectAssets());
    assert.equal(assets.projectRoot, storageRoot);
    assert.equal(assets.assets.length, 4);
    assert.equal(assets.assets.filter((item) => item.libraryKind === 'model').length, 3);
    assert.equal(assets.assets.filter((item) => item.libraryKind === 'environment').length, 1);
    assert.ok(assets.assets.every((item) => item.path.startsWith(storageRoot)));
    assert.ok(assets.assets.some((item) => item.packagePath.includes(path.join('Assets', 'Models', 'ComboModels', `Combo-${COMBO_MODEL_ID}-`))));
    assert.equal(
      await readFile(path.join(storageRoot, 'Assets', 'Models', `Model-${GLOBAL_MODEL_ID}-全局普通模型`, 'global-runtime.ts'), 'utf8'),
      'export const dataDriven = { device: { defaultAssetCode: "GLOBAL" } };\n',
    );
    const noScriptFiles = await readdir(path.join(storageRoot, 'Assets', 'Models', `Model-${PLAIN_MODEL_ID}-无脚本普通模型`));
    assert.ok(noScriptFiles.every((fileName) => !fileName.toLowerCase().endsWith('.ts')));
    assert.ok(!mock.requests.some((item) => item.path.endsWith('/not-a-typescript-file.js')));
    assert.ok(!mock.requests.some((item) => item.path.includes('legacy-one.ts')));

    await launched.window.reload();
    await launched.window.waitForLoadState('domcontentloaded');
    await launched.window.locator('#root').waitFor({ state: 'attached' });
    await launched.window.locator('.home-data-platform-card').filter({ hasText: '有效工程包项目' }).waitFor({ state: 'visible' });
    await launched.window.evaluate(() => {
      window.__dataPlatformSmokeProgressEvents = [];
      window.__dataPlatformSmokeProgressUnsubscribe?.();
      window.__dataPlatformSmokeProgressUnsubscribe = window.editorApi.onDataPlatformModelSyncProgress((progress) => {
        window.__dataPlatformSmokeProgressEvents.push(progress);
      });
    });
    const validProjectCard = launched.window.locator('.home-data-platform-card').filter({ hasText: '有效工程包项目' });
    await validProjectCard.getByRole('button', { name: '打开' }).click();
    await launched.window.locator('.project-library').waitFor({ state: 'visible', timeout: 20000 });
    await launched.window.waitForFunction(() => {
      const events = window.__dataPlatformSmokeProgressEvents ?? [];
      const queryingEvent = events.find((item) => item.phase === 'querying');
      return Boolean(queryingEvent && events.some(
        (item) => item.runId === queryingEvent.runId && (item.phase === 'completed' || item.phase === 'failed'),
      ));
    }, undefined, { timeout: 20000 });
    const uiSyncProgress = await launched.window.evaluate(() => {
      const events = window.__dataPlatformSmokeProgressEvents ?? [];
      const queryingEvent = events.find((item) => item.phase === 'querying');
      const finalProgress = queryingEvent
        ? events.find((item) => item.runId === queryingEvent.runId && (item.phase === 'completed' || item.phase === 'failed'))
        : null;
      window.__dataPlatformSmokeProgressUnsubscribe?.();
      delete window.__dataPlatformSmokeProgressUnsubscribe;
      delete window.__dataPlatformSmokeProgressEvents;
      return finalProgress;
    });
    assert.equal(uiSyncProgress?.phase, 'completed', uiSyncProgress?.error ?? uiSyncProgress?.message);
    await launched.window.locator('.library-sync-status-completed').waitFor({ state: 'detached', timeout: 5000 });
    await launched.window.locator('.resource-card-name', { hasText: '全局普通模型' }).waitFor({ state: 'visible' });
    const visibleModelCards = await launched.window.evaluate(() => {
      const list = document.querySelector('.project-library .resource-card-list');
      const names = [...document.querySelectorAll('.project-library .resource-card-name')].map((node) => node.textContent?.trim() ?? '');
      const importedName = '全局普通模型';
      const importedNameNode = [...document.querySelectorAll('.project-library .resource-card-name')]
        .find((node) => node.textContent?.trim() === importedName);
      const card = importedNameNode?.closest('.resource-card');
      if (!(list instanceof HTMLElement) || !(card instanceof HTMLElement) || !(importedNameNode instanceof HTMLElement)) {
        return { names, firstName: names[0] ?? null, importedVisible: false, importedNameVisible: false };
      }
      const listRect = list.getBoundingClientRect();
      const cardRect = card.getBoundingClientRect();
      const nameRect = importedNameNode.getBoundingClientRect();
      return {
        names,
        firstName: names[0] ?? null,
        importedVisible: cardRect.bottom > listRect.top && cardRect.top < listRect.bottom,
        importedNameVisible: nameRect.bottom > listRect.top && nameRect.top < listRect.bottom,
      };
    });
    assert.equal(visibleModelCards.firstName, '全局普通模型');
    assert.equal(visibleModelCards.importedVisible, true);
    assert.equal(visibleModelCards.importedNameVisible, true);
    assert.ok(visibleModelCards.names.includes('无脚本普通模型'));
    assert.ok(visibleModelCards.names.includes('全局组合模型'));

    const libraryTabs = launched.window.locator('.project-library .library-tab');
    const libraryTabCount = await libraryTabs.count();
    assert.ok(libraryTabCount >= 2, '资源库页签数量不足，无法验证共享布局');
    for (let index = 0; index < libraryTabCount; index += 1) {
      await libraryTabs.nth(index).click();
      const tabLayout = await inspectResourceStrip(launched.window);
      assert.equal(tabLayout.flexWrap, 'nowrap');
      assert.equal(tabLayout.overflowX, 'auto');
      assert.equal(tabLayout.overflowY, 'hidden');
      assert.equal(tabLayout.height, '190px');
      assert.equal(tabLayout.minHeight, '190px');
      assert.ok(tabLayout.scrollHeight <= tabLayout.clientHeight + 1, '资源库仍存在纵向溢出');
      assert.equal(tabLayout.attemptedScrollTop, 0, '资源库仍可纵向滚动');
    }

    await launched.window.getByRole('button', { name: '模型库', exact: true }).click();
    const layoutAt1440 = await inspectResourceStrip(launched.window, true);
    assert.ok(layoutAt1440.cardCount >= 4);
    assert.ok(layoutAt1440.cardHeights.every((height) => Math.abs(height - 160) <= 1));
    assert.ok(layoutAt1440.topSpread <= 1, '模型卡片发生换行');
    assert.equal(layoutAt1440.cardsFullyVisible, true, '1440×900 下模型卡片未完整显示');
    assert.ok(layoutAt1440.cardBottomGap >= 0 && layoutAt1440.cardBottomGap <= 12, '横向滚动条未紧贴模型卡片');
    assert.ok(layoutAt1440.bottomWorkspaceHeight <= 330, '正常状态底部资源区仍然过高');
    assert.ok(layoutAt1440.scenePanelHeight >= 240, '正常状态 Scene 区域高度不足');
    assert.ok(layoutAt1440.scrollWidth > layoutAt1440.clientWidth, '模型卡片数量不足以触发横向滚动');
    assert.ok(layoutAt1440.maximumScrollLeft > 0, '横向滚动条无法滚动');
    assert.ok(layoutAt1440.focusedScrollLeft > 0, '卡片聚焦未触发横向滚动');
    assert.equal(layoutAt1440.lastCardInsideViewport, true);

    const visualOutputRoot = path.join(workspaceRoot, 'output', 'data-platform-visual');
    await mkdir(visualOutputRoot, { recursive: true });
    await launched.window.screenshot({
      path: path.join(visualOutputRoot, '07-horizontal-resource-library.png'),
    });

    await launched.app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setSize(1180, 720);
    });
    await launched.window.waitForTimeout(150);
    const layoutAt1180 = await inspectResourceStrip(launched.window, true);
    assert.ok(layoutAt1180.topSpread <= 1, '1180×720 下模型卡片发生换行');
    assert.equal(layoutAt1180.cardsFullyVisible, true, '1180×720 下模型卡片未完整显示');
    assert.ok(layoutAt1180.cardBottomGap >= 0 && layoutAt1180.cardBottomGap <= 12);
    assert.ok(layoutAt1180.bottomWorkspaceHeight <= 330, '1180×720 下正常资源区仍然过高');
    assert.ok(layoutAt1180.scenePanelHeight >= 180, '1180×720 下 Scene 区域高度不足');
    assert.ok(layoutAt1180.scrollWidth > layoutAt1180.clientWidth);
    assert.ok(layoutAt1180.maximumScrollLeft > 0);
    assert.ok(layoutAt1180.focusedScrollLeft > 0);
    assert.equal(layoutAt1180.lastCardInsideViewport, true);
    assert.ok(layoutAt1180.scrollHeight <= layoutAt1180.clientHeight + 1);
    assert.equal(layoutAt1180.attemptedScrollTop, 0);

    const beforeRetryFailureIndex = await readFile(path.join(storageRoot, '.babylon-editor', 'asset-index.json'), 'utf8');
    mock.failNextModelDownload();
    const noPackage = await openAndWaitForSync(launched.window, '2');
    assert.equal(noPackage.openResult.source, 'generated');
    assert.equal(noPackage.openResult.sceneFilePath, null);
    assert.match(noPackage.openResult.warning, /没有可用工程包/);
    assert.equal(noPackage.finalProgress.phase, 'failed');
    assert.match(noPackage.finalProgress.error, /injected model download failure|HTTP 500/);
    const failedSyncStatus = launched.window.locator('.library-sync-status-failed');
    await failedSyncStatus.waitFor({ state: 'visible' });
    const failureLayout = await inspectResourceStrip(launched.window);
    assert.equal(failureLayout.cardsFullyVisible, true, '同步失败提示展开时模型卡片被裁切');
    assert.ok(failureLayout.topSpread <= 1);
    assert.ok(failureLayout.scrollHeight <= failureLayout.clientHeight + 1);
    assert.ok(
      failureLayout.bottomWorkspaceHeight >= layoutAt1180.bottomWorkspaceHeight + 50,
      '同步失败提示出现后底部资源区未按内容增高',
    );
    assert.ok(failureLayout.bottomWorkspaceHeight <= 430, '同步失败状态底部资源区高度异常');
    const failureStatusFit = await launched.window.evaluate(() => {
      const panel = document.querySelector('.project-library')?.getBoundingClientRect();
      const status = document.querySelector('.library-sync-status-failed')?.getBoundingClientRect();
      const closeButton = document.querySelector('.library-sync-status-close-button')?.getBoundingClientRect();
      return {
        closeButtonInsidePanel: Boolean(
          panel && closeButton && closeButton.left >= panel.left && closeButton.right <= panel.right
            && closeButton.top >= panel.top && closeButton.bottom <= panel.bottom,
        ),
        statusInsidePanel: Boolean(
          panel && status && status.left >= panel.left && status.right <= panel.right
            && status.top >= panel.top && status.bottom <= panel.bottom,
        ),
        pageCanScrollY: document.documentElement.scrollHeight > document.documentElement.clientHeight,
      };
    });
    assert.equal(failureStatusFit.statusInsidePanel, true, '同步失败提示超出 Project 面板');
    assert.equal(failureStatusFit.closeButtonInsidePanel, true, '关闭按钮超出 Project 面板');
    assert.equal(failureStatusFit.pageCanScrollY, false);
    await failedSyncStatus.getByRole('button', { name: '关闭同步失败提示' }).click();
    await failedSyncStatus.waitFor({ state: 'detached' });
    assert.equal(await launched.window.locator('.library-sync-status-failed').count(), 0);
    const restoredCompactLayout = await inspectResourceStrip(launched.window);
    assert.ok(
      Math.abs(restoredCompactLayout.bottomWorkspaceHeight - layoutAt1180.bottomWorkspaceHeight) <= 1,
      '同步提示关闭后底部资源区未恢复紧凑高度',
    );
    assert.equal(await readFile(path.join(storageRoot, '.babylon-editor', 'asset-index.json'), 'utf8'), beforeRetryFailureIndex);
    const lockedModelPath = path.join(
      storageRoot,
      'Assets',
      'Models',
      `Model-${GLOBAL_MODEL_ID}-全局普通模型`,
      'global.glb',
    );
    await stat(lockedModelPath);
    const modelFileLock = await holdWindowsFileWithoutDeleteSharing(lockedModelPath);
    await launched.window.exposeFunction('__releaseDataPlatformSmokeFileLock', async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      modelFileLock.release();
    });
    let retried;
    try {
      retried = await retryAndWaitForSync(launched.window);
    } finally {
      modelFileLock.release();
      await modelFileLock.completion;
    }
    assert.equal(retried.finalProgress.phase, 'completed', retried.finalProgress.error ?? retried.finalProgress.message);

    const oldPackage = await openAndWaitForSync(launched.window, '3');
    assert.equal(oldPackage.openResult.source, 'generated');
    assert.match(oldPackage.openResult.warning, /project\.bjseditor/);
    assert.equal(oldPackage.finalProgress.phase, 'completed');

    const incompatible = await openAndWaitForSync(launched.window, '4');
    assert.equal(incompatible.openResult.source, 'generated');
    assert.match(incompatible.openResult.warning, /只能包含一个 \.scene\.json|当前发现 0 个/);
    assert.equal(incompatible.finalProgress.phase, 'completed');

    const indexPath = path.join(storageRoot, '.babylon-editor', 'asset-index.json');
    const beforeFailureIndex = await readFile(indexPath, 'utf8');
    await expectOpenFailure(launched.window, '5', '越界路径');
    await expectOpenFailure(launched.window, '6', 'ZIP 损坏');
    await expectOpenFailure(launched.window, '7', 'HTTP 500');
    await expectOpenFailure(launched.window, '8', '符号链接');
    assert.equal(await readFile(indexPath, 'utf8'), beforeFailureIndex);
    await assert.rejects(stat(path.join(storageRoot, 'escape.txt')));

    const projectRequest = mock.requests.find((item) => item.path === '/platform/api/v1/projects/query');
    assert.equal(projectRequest?.method, 'POST');
    assert.deepEqual(projectRequest?.body, { pageNum: 1, pageSize: 12, projectName: '' });
    for (const endpoint of ['/platform/api/v1/models/query', '/platform/api/v1/env-models/query', '/platform/api/v1/combo-models/query']) {
      const request = mock.requests.find((item) => item.path === endpoint);
      assert.equal(request?.method, 'POST');
      assert.equal(request?.body?.pageNum, 1);
      assert.equal(request?.body?.pageSize, 100);
    }
    assert.ok(mock.getMaxConcurrentModelDownloads() >= 2, '模型文件下载未形成并发');
    assert.ok(mock.getMaxConcurrentModelDownloads() <= 4, '模型文件下载并发超过 4');

    await launched.app.close();
    launched = null;

    unwritableLaunched = await launchEditor(unwritableRoot, unwritableUserDataRoot);
    await configureAndList(unwritableLaunched.window, mock.baseUrl);
    await expectOpenFailure(unwritableLaunched.window, '2', '不是目录');

    console.log(JSON.stringify({
      status: 'PASS',
      storageRoot,
      requests: mock.requests.length,
      verified: [
        'server-side-project-search-and-trusted-cache',
        'lossless-string-business-identifiers',
        'structured-script-list-overrides-legacy-fields',
        '1180x720-dialog-fit',
        'valid-current-package',
        'scene-path-relocation',
        'no-package-fallback',
        'legacy-package-fallback',
        'incompatible-package-fallback',
        'normal-environment-combo-sync',
        'optional-any-ts-script-download',
        'synced-model-cards-visible-first',
        'single-row-horizontal-resource-library',
        'compact-content-sized-resource-workspace',
        '1180x720-complete-resource-cards',
        'horizontal-card-focus-scroll',
        'sync-status-auto-expand-and-collapse',
        'sync-failure-layout-fit',
        'sync-failure-dismiss-button',
        'max-four-concurrent-downloads',
        'progress-phases',
        'sync-failure-preserves-old-library-and-retry',
        'windows-transient-model-directory-lock-retry',
        'zip-slip-rejection',
        'symlink-rejection',
        'corrupt-and-http-failure-preserve-index',
        'unwritable-root-rejection',
      ],
    }, null, 2));
  } finally {
    if (unwritableLaunched) await unwritableLaunched.app.close().catch(() => undefined);
    if (launched) await launched.app.close().catch(() => undefined);
    if (mock) await mock.close().catch(() => undefined);
    await rm(fixtureRoot, { recursive: true, force: true });
    await rm(storageRoot, { recursive: true, force: true });
    await rm(userDataRoot, { recursive: true, force: true });
    await rm(unwritableUserDataRoot, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(`[data-platform-smoke] ${error instanceof Error ? error.stack : String(error)}`);
  process.exitCode = 1;
});
