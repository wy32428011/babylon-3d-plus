import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZipArchive } from 'archiver';
import { chromium, _electron } from 'playwright';

// 直接验证指定安装程序；所有项目、缓存和配置都留在独立临时目录，便于失败复查。
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceMode = process.argv.includes('--source');
const executablePath = sourceMode ? path.join(repoRoot, 'node_modules/electron/dist/electron.exe')
  : path.resolve(process.argv[2] ?? path.join(repoRoot, 'release/win-unpacked/ZENDING 3D EDITOR.exe'));
assert.ok(existsSync(executablePath), `找不到待测安装程序：${executablePath}`);
const root = await mkdtemp(path.join(tmpdir(), 'packaged-remote-scene-'));
const artifactRoot = path.join(repoRoot, 'artifacts', `packaged-remote-scene-${Date.now()}`);
await mkdir(artifactRoot, { recursive: true });
const historicalSourceKey = 'a'.repeat(64);
const projectId = '9000000000000000011';
const projectName = '安装态远端场景回归';
const requests = [];
const checks = [];
let mode = 'success';
let browser;
let electronApp;
let page;
let child;
let childExited = false;
const processOutput = [];

function glb(color) {
  const positions = new Float32Array([-1, 0, 0, 1, 0, 0, 0, 2, 0]);
  const json = Buffer.from(JSON.stringify({ asset: { version: '2.0' }, buffers: [{ byteLength: positions.byteLength }],
    bufferViews: [{ buffer: 0, byteLength: positions.byteLength }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [-1, 0, 0], max: [1, 2, 0] }],
    materials: [{ name: 'paint', doubleSided: true, emissiveFactor: color,
      pbrMetallicRoughness: { baseColorFactor: [...color, 1], metallicFactor: 0 } }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
    nodes: [{ name: 'Body', mesh: 0 }], scenes: [{ nodes: [0] }], scene: 0 }));
  const n = Math.ceil(json.length / 4) * 4;
  const result = Buffer.alloc(28 + n + positions.byteLength);
  result.write('glTF'); result.writeUInt32LE(2, 4); result.writeUInt32LE(result.length, 8);
  result.writeUInt32LE(n, 12); result.writeUInt32LE(0x4e4f534a, 16);
  result.fill(32, 20, 20 + n); json.copy(result, 20);
  result.writeUInt32LE(positions.byteLength, 20 + n); result.writeUInt32LE(0x004e4942, 24 + n);
  Buffer.from(positions.buffer).copy(result, 28 + n);
  return result;
}

const oldModel = glb([1, 0, 0]);
const latestModel = glb([0, 1, 0]);
const environmentModel = glb([0, 0, 1]);
const parameterConfig = (latest = false) => ({ schema: 'babylon-editor.model-parameters', version: 1,
  parameters: [{ key: 'width', label: '宽度', type: 'number', defaultValue: 9, min: 0, max: 10 },
    { key: 'enabled', label: '开关', type: 'boolean', defaultValue: true },
    { key: 'label', label: '文字', type: 'string', defaultValue: '默认值' },
    ...(latest ? [{ key: 'speed', label: '速度', type: 'number', defaultValue: 5 }] : [])],
  bindings: [{ target: { kind: 'node', name: 'Body' }, property: 'scaling', value: { vector3: [{ param: 'width' }, 1, 1] } }] });
const oldProjectRoot = 'C:/historical-machine/Projects/' + projectId;
const oldAssetUrl = value => 'editor-asset://local/' + encodeURIComponent(value);

function sourceScene() {
  const modelPath = oldProjectRoot + '/Assets/Models/Model-123-fixture/model.glb';
  const envPath = oldProjectRoot + '/Assets/Environments/Env-456-fixture/environment.glb';
  const entities = Object.fromEntries([1, 2].map(width => {
    const id = 'fixture-model-' + width;
    return [id, { id, name: '参数实例 ' + width, visible: true, locked: false, parentId: null, childrenIds: [],
      components: { transform: { position: { x: (width - 1) * 4, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
        modelAsset: { sourcePath: modelPath, sourceUrl: oldAssetUrl(modelPath), assetCode: 'DEVICE-' + width,
          lengthUnit: 'meter', unitScaleToMeters: 1, parameterConfig: parameterConfig(),
          parameterValues: { width, enabled: false, label: '' },
          dataPlatformModel: { sourceKey: historicalSourceKey, kind: 'model', resourceId: '123', modelPath: 'model.glb' } } } }];
  }));
  return { version: 5, units: { length: 'meter' }, scene: { id: 'fixture-scene', name: '远端权威场景', entities,
    entityIds: Object.keys(entities), selectedEntityId: null, mqttConfig: { enabled: false },
    sceneSettings: { camera: { viewDistance: 1000, savedPose: { alpha: -Math.PI / 2, beta: Math.PI / 2.4, radius: 16,
      target: { x: 0, y: 1, z: 0 } } }, environment: { packagePath: path.posix.dirname(envPath), lengthUnit: 'meter', unitScaleToMeters: 1,
      displayName: '历史来源环境', source: 'data-platform', resourceType: 'ENV_MODEL', dataPlatformResourceId: '456',
      dataPlatformSourceKey: historicalSourceKey, dataPlatformRevision: '1', placementMode: 'scene-base',
      transform: { position: { x: -4, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: 1 },
      visible: true, opacity: 0.75, activeVariantUrl: oldAssetUrl(envPath),
      variants: [{ name: 'environment', sourcePath: envPath, sourceUrl: oldAssetUrl(envPath) }] } } } };
}

async function buildSourceZip() {
  const target = path.join(root, 'fixture.source.zip');
  await new Promise((resolve, reject) => {
    const archive = new ZipArchive();
    const output = createWriteStream(target);
    output.once('close', resolve); output.once('error', reject); archive.once('error', reject);
    archive.pipe(output);
    archive.append(JSON.stringify(sourceScene()), { name: 'Scenes/fixture.scene.json' });
    archive.append(oldModel, { name: 'Assets/Models/Model-123-fixture/model.glb' });
    archive.append(JSON.stringify({ lengthUnit: 'meter', modelParameters: parameterConfig() }), { name: 'Assets/Models/Model-123-fixture/model.json' });
    archive.append(environmentModel, { name: 'Assets/Environments/Env-456-fixture/environment.glb' });
    archive.append('', { name: '.babylon-editor/' });
    void archive.finalize().catch(reject);
  });
  return readFile(target);
}

const sourceZip = await buildSourceZip();
const server = createServer(async (request, response) => {
  try {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const route = new URL(request.url, 'http://fixture').pathname;
    requests.push({ route, mode, body: raw ? JSON.parse(raw) : null });
    const json = data => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ success: true, data })); };
    const bytes = (data, type) => { response.setHeader('Content-Type', type); response.end(data); };
    const project = { id: projectId, projectName,
      latestEditorProjectId: '91', latestEditorProjectVersionId: '92', latestEditorProjectVersionNumber: 1,
      latestEditorProjectPackageUrl: '/source.zip', currentResourceRevision: '2' };
    if (route === '/api/v1/projects/query') return json({ records: [project], total: 1, pageNum: 1, pageSize: 12 });
    if (route === '/api/v1/projects/detail') return json(project);
    if (route === '/api/v1/digital-twin/projects/status') return json({ projectId, editorProjectId: '91', latestVersionId: '92',
      latestVersionNumber: 1, status: 'DRAFT', runtimeConfig: { projectId, runtimeEnabled: false, configJson: '{}' } });
    if (route === '/source.zip' || route === '/api/v1/editor/projects/91/versions/92/package/export') return bytes(sourceZip, 'application/zip');
    if (route === '/api/v1/env-models/sync-manifest/query') return json({ protocolVersion: '1', manifestRevision: '2', hasMore: false,
      nextCursorId: null, records: ['456', '457'].map(id => ({ id, modelName: id === '456' ? '历史来源环境' : '未绑定环境', fileStatus: 'GLB_READY', fileName: 'environment.glb',
        fileUrl: '/environment.glb', fileRevision: '2', runtimeRevision: '2', fileSha256: createHash('sha256').update(environmentModel).digest('hex'),
        fileSizeBytes: String(environmentModel.length), lengthUnit: 'meter' })) });
    if (route === '/environment.glb') {
      await new Promise(resolve => setTimeout(resolve, 500));
      return bytes(environmentModel, 'model/gltf-binary');
    }
    if (route === '/api/v1/models/query') return json({ pageNum: JSON.parse(raw).pageNum, pageSize: JSON.parse(raw).pageSize,
      total: 2, records: [{ id: '123', modelName: 'fixture', fileName: 'model.glb', fileUrl: '/latest.glb', metaFileUrl: '/latest.json', revision: '2' },
        { id: '789', modelName: '未绑定普通模型', fileName: 'unbound.glb', fileUrl: '/unbound.glb', revision: '2' }] });
    if (route === '/api/v1/combo-models/query') return json({ pageNum: JSON.parse(raw).pageNum, pageSize: JSON.parse(raw).pageSize,
      total: 1, records: [{ id: '790', comboModelName: '未绑定组合模型', fileName: 'combo.glb', fileUrl: '/unbound.glb', revision: '2' }] });
    if (route === '/unbound.glb') return bytes(latestModel, 'model/gltf-binary');
    if (route === '/api/v1/models/detail') {
      await new Promise(resolve => setTimeout(resolve, 350));
      if (mode === 'model-404') { response.writeHead(404); response.end('fixture model unavailable'); return; }
      return json({ id: '123', modelName: 'fixture', fileName: 'model.glb', fileUrl: '/latest.glb',
        metaFileUrl: '/latest.json', revision: '2' });
    }
    if (route === '/latest.glb') {
      await new Promise(resolve => setTimeout(resolve, 500));
      return bytes(latestModel, 'model/gltf-binary');
    }
    if (route === '/latest.json') return jsonMetadata(response);
    if (route === '/api/v1/digital-twin/runtime-config/detail') return json({ projectId, runtimeEnabled: false, configJson: '{}' });
    if (route.endsWith('/query')) return json({ records: [], total: 0, pageNum: 1, pageSize: 100 });
    response.writeHead(404); response.end('Unhandled fixture route: ' + route);
  } catch (error) { response.writeHead(500); response.end(String(error)); }
});
function jsonMetadata(response) {
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify({ lengthUnit: 'meter', modelParameters: parameterConfig(true) }));
}
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const baseUrl = 'http://127.0.0.1:' + server.address().port;
const expectedSourceKey = createHash('sha256').update(baseUrl).digest('hex');
const userData = path.join(root, 'user-data');
const workspaceRoot = path.join(userData, 'data-platform-workspace');
const localProjectRoot = path.join(workspaceRoot, 'Projects', projectId);
if (sourceMode) {
  // 开发启动默认使用仓库工作区；测试预设独立配置，禁止向真实工程写入夹具资源。
  await mkdir(userData, { recursive: true });
  await writeFile(path.join(userData, 'data-platform-config.json'), JSON.stringify({ version: 2, baseUrl: '', workspaceRoot }));
}

// 从 React 当前 fiber 的只读 props / hook 快照检查实际场景，不向产品增加测试接口。
function readRenderedScene() {
  const rootNode = document.getElementById('root');
  const key = Object.keys(rootNode ?? {}).find(key => key.startsWith('__reactContainer$'));
  const first = rootNode?.[key];
  const stack = first ? [first.stateNode?.current ?? first] : [];
  const seen = new Set();
  const scenes = [];
  const inspect = value => {
    if (!value || typeof value !== 'object') return;
    const candidate = value.scene ?? value;
    if (candidate.id === 'fixture-scene' && candidate.entities && Array.isArray(candidate.entityIds)) scenes.push(candidate);
  };
  while (stack.length && seen.size < 30000) {
    const fiber = stack.pop(); if (!fiber || seen.has(fiber)) continue; seen.add(fiber);
    inspect(fiber.memoizedProps);
    for (const value of Object.values(fiber.memoizedProps ?? {})) inspect(value);
    let hook = fiber.memoizedState;
    for (let n = 0; hook && n < 300; n++, hook = hook.next) {
      inspect(hook.memoizedState); inspect(hook.memoizedState?.value); inspect(hook.memoizedState?.current);
    }
    stack.push(fiber.child, fiber.sibling);
  }
  return scenes[0] ? JSON.parse(JSON.stringify(scenes[0])) : null;
}

async function waitEditor() {
  await Promise.race([
    page.locator('canvas.scene-canvas').waitFor({ state: 'visible', timeout: 90000 }),
    page.locator('.home-status-error').waitFor({ state: 'visible', timeout: 90000 })
      .then(async () => { throw new Error(await page.locator('.home-status-error').innerText()); }),
  ]);
  await page.waitForFunction(() => !document.querySelector('.home-page') && !Array.from(document.querySelectorAll('button'))
    .some(button => button.textContent.includes('取消加载并返回首页')), undefined, { timeout: 90000 });
  await page.waitForFunction(readRenderedScene, undefined, { timeout: 15000 });
}

async function openProject() {
  await page.evaluate(() => {
    window.__loadingObserver?.disconnect();
    window.__loadingTransitions = [];
    const sample = () => {
      const visible = Boolean(document.querySelector('[data-scene-preparation-phase]'));
      const events = window.__loadingTransitions;
      if (events.at(-1)?.visible !== visible) events.push({ visible, at: performance.now() });
    };
    window.__loadingObserver = new MutationObserver(sample);
    window.__loadingObserver.observe(document.body, { subtree: true, attributes: true, childList: true });
    sample();
  });
  await page.locator('.home-data-platform-card').filter({ hasText: projectName }).getByRole('button', { name: '打开', exact: true }).click();
  await waitEditor();
  if (mode === 'success') {
    await page.waitForFunction(`(${readRenderedScene.toString()})()?.entities['fixture-model-1']?.components.modelAsset.parameterValues.speed === 5`,
      undefined, { timeout: 90000 });
    await page.locator('aside[aria-label="场景资源状态"]').waitFor({ state: 'hidden', timeout: 90000 });
  } else {
    await page.getByText('场景已打开，部分资源需要处理', { exact: true }).waitFor({ state: 'visible', timeout: 90000 });
  }
  await waitRenderedModel(mode === 'success' ? 'green' : 'red');
  const transitions = await page.evaluate(() => window.__loadingTransitions);
  assert.equal(transitions.filter(event => event.visible).length, 1, '一次打开的加载蒙版只能连续出现一次');
  checks.push({ name: 'continuous-loading-' + mode, passed: true, transitions });
}

/** 以实际 canvas 截图像素确认新/旧模型已渲染，避免状态更新先于首帧和加载蒙版。 */
async function waitRenderedModel(color) {
  const deadline = Date.now() + 90000;
  let pixels = 0;
  while (Date.now() < deadline) {
    const screenshot = await page.locator('canvas.scene-canvas').screenshot();
    pixels = await page.evaluate(async ({ encoded, color }) => {
      const data = Uint8Array.from(atob(encoded), value => value.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([data], { type: 'image/png' }));
      const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
      const context = canvas.getContext('2d'); context.drawImage(bitmap, 0, 0); bitmap.close();
      const bytes = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let count = 0;
      for (let i = 0; i < bytes.length; i += 4) {
        if (color === 'green' ? bytes[i + 1] > 150 && bytes[i] < 80 && bytes[i + 2] < 80
          : bytes[i] > 150 && bytes[i + 1] < 80 && bytes[i + 2] < 80) count++;
      }
      return count;
    }, { encoded: screenshot.toString('base64'), color });
    if (pixels > 200) return pixels;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`实际模型首帧未显示：${color} pixels=${pixels}`);
}

function assertInstances(scene, latest) {
  assert.equal(scene.entityIds.length, 2);
  for (const width of [1, 2]) {
    const entity = scene.entities['fixture-model-' + width];
    assert.equal(entity.components.modelAsset.assetCode, 'DEVICE-' + width);
    assert.deepEqual(entity.components.modelAsset.parameterValues, { width, enabled: false, label: '', ...(latest ? { speed: 5 } : {}) });
    assert.equal(entity.components.transform.position.x, (width - 1) * 4);
  }
  assert.equal(scene.sceneSettings.environment.opacity, 0.75);
}

async function returnHome() {
  await page.locator('.toolbar-home-button').click();
  await page.locator('.home-page').waitFor({ state: 'visible' });
}

async function main() {
  if (sourceMode) {
    electronApp = await _electron.launch({ executablePath, args: [repoRoot, `--user-data-dir=${userData}`], cwd: repoRoot,
      env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' } });
    // 仅替代隔离测试的系统文件选择器，后续仍走产品 scene:save 的序列化、写盘和最近记录。
    await electronApp.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath });
    }, path.join(localProjectRoot, 'Scenes', 'fixture.scene.json'));
    page = await electronApp.firstWindow();
  } else {
  const portServer = createServer();
  await new Promise(resolve => portServer.listen(0, '127.0.0.1', resolve));
  const debugPort = portServer.address().port;
  await new Promise(resolve => portServer.close(resolve));
  child = spawn(executablePath, [...(sourceMode ? [repoRoot] : []), `--remote-debugging-port=${debugPort}`, `--user-data-dir=${userData}`], {
    cwd: path.dirname(executablePath), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1', ELECTRON_ENABLE_STACK_DUMPING: '1' } });
  child.stdout.on('data', chunk => processOutput.push(String(chunk)));
  child.stderr.on('data', chunk => processOutput.push(String(chunk)));
  child.once('exit', () => { childExited = true; });
  let endpoint;
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    assert.ok(!childExited, '安装程序在 CDP 就绪前退出');
    try { const result = await fetch(`http://127.0.0.1:${debugPort}/json/version`); if (result.ok) { endpoint = (await result.json()).webSocketDebuggerUrl; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.ok(endpoint, '安装程序 CDP 启动超时');
  browser = await chromium.connectOverCDP(endpoint);
  page = browser.contexts()[0].pages().find(page => page.url().startsWith('file://')) ?? await browser.contexts()[0].waitForEvent('page');
  }
  page.setDefaultTimeout(15000);
  page.on('dialog', dialog => { processOutput.push('DIALOG: ' + dialog.message() + '\n'); return dialog.accept(); });
  page.on('pageerror', error => processOutput.push('PAGEERROR: ' + error.stack + '\n'));
  await page.locator('.home-page').waitFor({ state: 'visible', timeout: 45000 });
  const config = await page.evaluate(() => window.editorApi.getDataPlatformConfig());
  assert.equal(path.resolve(config.workspaceRoot), path.resolve(workspaceRoot), '必须先确认 userData 和业务工作区完全隔离');
  await page.getByRole('button', { name: '数据中台配置', exact: true }).click();
  await page.getByRole('dialog').getByRole('textbox').fill(baseUrl);
  await page.getByRole('button', { name: '保存并刷新', exact: true }).click();
  await openProject();
  let scene = await page.evaluate(readRenderedScene);
  assertInstances(scene, true);
  assert.equal(scene.sceneSettings.environment.dataPlatformSourceKey, expectedSourceKey);
  assert.equal(scene.entities['fixture-model-1'].components.modelAsset.dataPlatformModel.sourceKey, expectedSourceKey);
  assert.ok(!await page.getByText('场景环境模型来源与当前项目不一致', { exact: false }).count());
  const gl = await page.locator('canvas.scene-canvas').evaluate(canvas => {
    const context = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    return { width: canvas.width, height: canvas.height, renderer: context?.getParameter(context.RENDERER) };
  });
  assert.ok(gl.width > 300 && gl.height > 150 && gl.renderer);
  await page.screenshot({ path: path.join(artifactRoot, '01-rebound-latest.png') });
  checks.push({ name: 'historical-source-rebound-latest', passed: true, gl, scene });

  await page.getByText('未绑定普通模型', { exact: true }).waitFor({ state: 'visible', timeout: 45000 });
  await page.getByText('未绑定组合模型', { exact: true }).waitFor({ state: 'visible', timeout: 45000 });
  assertInstances(await page.evaluate(readRenderedScene), true);
  await page.getByRole('button', { name: '环境库', exact: true }).click();
  await page.getByText('未绑定环境', { exact: true }).waitFor({ state: 'visible', timeout: 45000 });
  const syncNotice = page.getByRole('status', { name: '环境模型同步', exact: true });
  await page.getByRole('button', { name: '同步模型库', exact: true }).click();
  await syncNotice.waitFor({ state: 'visible' });
  await syncNotice.hover();
  await syncNotice.getByText('环境同步完成', { exact: true }).waitFor();
  await page.screenshot({ path: path.join(artifactRoot, '01c-environment-notice-close.png') });
  await syncNotice.getByRole('button', { name: '关闭环境模型同步提示' }).click();
  await syncNotice.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '同步模型库', exact: true }).click();
  await syncNotice.waitFor({ state: 'visible' });
  await page.mouse.move(400, 250);
  await syncNotice.waitFor({ state: 'hidden', timeout: 10000 });
  checks.push({ name: 'library-notice-close-new-run-auto-dismiss', passed: true });
  await page.getByRole('button', { name: '模型库', exact: true }).click();
  await page.screenshot({ path: path.join(artifactRoot, '01b-full-library.png') });
  assert.equal((await page.evaluate(() => window.__loadingTransitions)).filter(event => event.visible).length, 1,
    '后台全库同步不应重新弹出场景加载蒙版');
  checks.push({ name: 'unbound-model-combo-environment-full-library', passed: true });

  await returnHome();
  const localScenePath = path.join(localProjectRoot, 'Scenes', 'fixture.scene.json');
  const draft = JSON.parse(await readFile(localScenePath, 'utf8'));
  draft.scene.name = '本地未发布修改';
  draft.scene.entities['fixture-model-1'].components.modelAsset.parameterValues.width = 7;
  await writeFile(localScenePath, JSON.stringify(draft));
  await openProject();
  scene = await page.evaluate(readRenderedScene);
  assert.equal(scene.name, '远端权威场景'); assertInstances(scene, true);
  const backupMatches = [];
  async function findBackup(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await findBackup(target);
      else if (entry.name === 'fixture.scene.json' && target !== localScenePath) {
        const data = JSON.parse(await readFile(target, 'utf8'));
        if (data.scene?.name === '本地未发布修改' && data.scene.entities['fixture-model-1'].components.modelAsset.parameterValues.width === 7) backupMatches.push(target);
      }
    }
  }
  await findBackup(workspaceRoot);
  assert.ok(backupMatches.length, '远端覆盖前应保存含本地参数修改的备份');
  checks.push({ name: 'remote-overwrites-local-with-backup', passed: true, backupMatches });
  await page.screenshot({ path: path.join(artifactRoot, '02-remote-overwrite.png') });

  await returnHome(); mode = 'model-404'; await openProject();
  scene = await page.evaluate(readRenderedScene);
  assertInstances(scene, false);
  assert.equal(scene.sceneSettings.environment.dataPlatformSourceKey, expectedSourceKey, '模型失败不得阻止独立环境同步');
  const issues = page.locator('aside[aria-label="场景资源状态"]');
  await issues.waitFor({ state: 'visible' });
  await issues.locator('summary').click();
  assert.ok((await issues.innerText()).includes('123'));
  await issues.getByRole('button', { name: '重新同步场景资源', exact: true }).waitFor({ state: 'visible' });
  await page.screenshot({ path: path.join(artifactRoot, '03-source-fallback-editable.png') });
  checks.push({ name: 'model-404-source-fallback-editable', passed: true, scene, issues: await issues.innerText() });
  await issues.getByRole('button', { name: '关闭场景资源提示' }).click();
  await issues.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '查看场景资源问题' }).click();
  await issues.waitFor({ state: 'visible' });
  assertInstances(await page.evaluate(readRenderedScene), false);
  checks.push({ name: 'resource-notice-dismiss-and-reopen', passed: true });
  mode = 'success'; await issues.getByRole('button', { name: '重新同步场景资源', exact: true }).click();
  await issues.waitFor({ state: 'hidden', timeout: 90000 });
  await waitRenderedModel('green');
  scene = await page.evaluate(readRenderedScene); assertInstances(scene, true);
  checks.push({ name: 'retry-latest-preserves-parameters', passed: true });
  await page.screenshot({ path: path.join(artifactRoot, '04-retry-success.png') });

  if (!sourceMode) return;
  await page.getByText('未绑定普通模型', { exact: true }).click();
  await page.waitForFunction(`(${readRenderedScene.toString()})()?.entityIds.length === 3`);
  await page.getByRole('button', { name: '保存场景', exact: true }).click();
  const saveDeadline = Date.now() + 10000;
  let saved;
  while (Date.now() < saveDeadline) {
    saved = JSON.parse(await readFile(localScenePath, 'utf8'));
    if (saved.scene?.entityIds.length === 3) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(saved.scene.entityIds.length, 3, '未绑定模型放入场景后应可正常保存');
  await returnHome();
  await page.locator('.home-recent-card').filter({ hasText: 'fixture.scene.json' })
    .getByRole('button', { name: '打开', exact: true }).click();
  await waitEditor();
  scene = await page.evaluate(readRenderedScene);
  assert.equal(scene.entityIds.length, 3, '从本地重开保存的场景必须保留新放入的模型');
  assert.ok(scene.entityIds.some(id => scene.entities[id].name.includes('未绑定普通模型')));
  await waitRenderedModel('green');
  await page.screenshot({ path: path.join(artifactRoot, '05-unbound-model-save-reopen.png') });
  checks.push({ name: 'unbound-model-add-save-local-reopen', passed: true });
}

let error;
try { await main(); } catch (cause) {
  error = cause instanceof Error ? cause.stack : String(cause);
  if (page) await page.screenshot({ path: path.join(artifactRoot, 'failure.png') }).catch(() => undefined);
} finally {
  await writeFile(path.join(artifactRoot, 'result.json'), JSON.stringify({ passed: !error, executablePath, root, artifactRoot,
    checks, requests, error }, null, 2));
  await writeFile(path.join(artifactRoot, 'electron.log'), processOutput.join(''));
  if (browser) await browser.close();
  if (electronApp) await electronApp.close();
  // 只清理本脚本启动且尚未退出的进程树；隔离数据保留用于复核，避免递归删除误伤。
  if (child?.pid && !childExited) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
console.log(JSON.stringify({ passed: !error, artifactRoot, root, checks: checks.map(check => check.name), error }, null, 2));
if (error) process.exitCode = 1;
