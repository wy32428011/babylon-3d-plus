import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createWriteStream, promises as fs } from 'node:fs';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { ZipArchive } from 'archiver';
import { app } from 'electron';

const root = process.env.ZENDING_WORKSPACE_OPEN_TEST_ROOT;
if (!root) throw new Error('请通过 workspaceProjectOpen.test.ts 运行隔离测试。');
const CURRENT_SCENE_VERSION = 7;
await mkdir(path.join(root, 'user-data'));
app.setPath('userData', path.join(root, 'user-data'));
app.disableHardwareAcceleration();

function unifiedSettings() {
  return {
    lighting: { version: 2,
      main: { source: 'managed', enabled: true, color: '#aabbcc', azimuthDegrees: 123, elevationDegrees: 28, intensity: 1.7 },
      fill: { intensity: .35, color: '#ffddaa', groundColor: '#152535' }, environmentIntensity: .7,
      disabledLightIds: ['future-light'], allowDayNightCycle: false,
      shadows: { enabled: false, quality: 'performance', darkness: .2, distanceMeters: 120, bias: .004, normalBias: .04 },
      bake: { enabled: false, quality: 'preview', atlasSize: 1024, texelsPerMeter: 8, probeSpacing: 6, maxTextureMiB: 64, cacheStaticShadows: true, dynamicShadows: true },
      policy: { version: 1, defaults: { castShadows: false }, rules: [] }, result: null, extension: { keep: 'v6-lighting' },
    },
    appearance: { version: 1, backgroundColor: '#123456', skyboxVisible: false, exposure: 1.25, contrast: 1.15,
      toneMappingEnabled: true, glowIntensity: .45, bloomEnabled: false, bloomWeight: .2,
      fogEnabled: true, fogColor: '#334455', fogStart: 120, fogEnd: 850 },
  };
}

function assertCurrentSceneFile(loaded) {
  assert.equal(loaded.version, CURRENT_SCENE_VERSION, '旧场景读取后按已声明的外层版本7合同迁移');
  assert.equal(loaded.scene.sceneSettings.lighting.version, 2);
  assert.equal(loaded.scene.sceneSettings.appearance.version, 1);
}

function assertLegacyScenePayload(loaded, expected) {
  assertCurrentSceneFile(loaded);
  // 旧文件新增统一照明与显示配置；原场景业务字段仍需逐项完全保留。
  const { sceneSettings: _migratedSettings, ...payload } = loaded.scene;
  assert.deepEqual(payload, expected);
}

async function createPackage(version, scene = { entities: {}, entityIds: [] }, assets = {}) {
  const archivePath = path.join(root, `v${version}.zip`);
  await new Promise((resolve, reject) => {
    const output = createWriteStream(archivePath);
    const archive = new ZipArchive();
    output.once('close', resolve);
    output.once('error', reject);
    archive.once('error', reject);
    archive.pipe(output);
    for (const directory of ['.babylon-editor/', 'Assets/Models/', 'Assets/Environments/']) {
      archive.append('', { name: directory });
    }
    for (const [name, content] of Object.entries(assets)) archive.append(content, { name });
    archive.append(JSON.stringify({ version, scene }), { name: 'Scenes/工厂.scene.json' });
    void archive.finalize().catch(reject);
  });
  return readFile(archivePath);
}

function renameError(code, label) {
  return Object.assign(new Error(`${code}: ${label}`), { code });
}

// 仅替换本次隔离 Electron 进程的 fs.promises；真实解包、事务和落盘仍走产品入口。
// copyFaults 可选：匹配的“复制替代移动”同样注入失败，用于验证复制也失败时保留原始错误与恢复目录。
async function withRenameFaults(rules, action, copyFaults = []) {
  const originalRename = fs.rename, originalCp = fs.cp, originalCopyFile = fs.copyFile;
  fs.rename = async (source, destination) => {
    const rule = rules.find((candidate) => candidate.matches(String(source), String(destination)));
    if (rule) {
      rule.attempts = (rule.attempts ?? 0) + 1;
      const error = rule.errorAt(rule.attempts);
      if (error) throw error;
    }
    return originalRename.call(fs, source, destination);
  };
  const copyFault = (source, destination) => {
    const rule = copyFaults.find((candidate) => candidate.matches(String(source), String(destination)));
    if (!rule) return null;
    rule.attempts = (rule.attempts ?? 0) + 1;
    return rule.error;
  };
  fs.cp = async (source, destination, options) => {
    const error = copyFault(source, destination);
    if (error) throw error;
    return originalCp.call(fs, source, destination, options);
  };
  fs.copyFile = async (source, destination, mode) => {
    const error = copyFault(source, destination);
    if (error) throw error;
    return originalCopyFile.call(fs, source, destination, mode);
  };
  try {
    return await action();
  } finally {
    fs.rename = originalRename; fs.cp = originalCp; fs.copyFile = originalCopyFile;
  }
}

async function assertWindowsRenameRecovery(service, archiveByPath, baseUrl, workspace) {
  if (process.platform !== 'win32') {
    console.log('SKIP: Windows rename lock recovery (requires win32)');
    return;
  }
  const remoteAsset = path.join('Assets', 'Models', '远端资源.txt');
  const localAsset = path.join('Assets', 'Models', '本地保留资源.txt');
  let nextId = 80;
  async function fixture() {
    const id = String(nextId++);
    const packageUrl = `/rename-${id}.zip`;
    const scene = { entities: {}, entityIds: [], name: `远端工程 ${id}` };
    archiveByPath.set(packageUrl, await createPackage(6, scene, { 'Assets/Models/远端资源.txt': `远端资源 ${id}` }));
    const project = { id, projectName: `Windows 文件锁 ${id}`, latestEditorProjectId: '100',
      latestEditorProjectVersionId: `${id}0`, latestEditorProjectVersionNumber: 6,
      latestEditorProjectPackageUrl: packageUrl, currentResourceRevision: '0' };
    const opened = await service.openDataPlatformProject(project, baseUrl, workspace);
    const localContent = JSON.stringify({ version: CURRENT_SCENE_VERSION,
      scene: { ...scene, name: `未发布本地编辑 ${id}`, sceneSettings: unifiedSettings() } });
    await writeFile(opened.sceneFilePath, localContent);
    await writeFile(path.join(opened.projectRoot, localAsset), `本地资源 ${id}`);
    const bindingPath = path.join(opened.projectRoot, '.babylon-editor', 'data-platform-binding.json');
    const bindingContent = await readFile(bindingPath, 'utf8');
    return { id, project, opened, localContent, bindingPath, bindingContent,
      open: () => service.openDataPlatformProject(project, baseUrl, workspace),
      async assertPreserved() {
        assert.equal(await readFile(opened.sceneFilePath, 'utf8'), localContent);
        assert.equal(await readFile(path.join(opened.projectRoot, localAsset), 'utf8'), `本地资源 ${id}`);
        assert.equal(await readFile(bindingPath, 'utf8'), bindingContent);
      } };
  }
  const isStage = (source, destination) => source.includes(`${path.sep}extracted${path.sep}`)
    && destination.endsWith(path.join('materialize', 'staged', 'Assets'));
  const isBackup = (name) => (source, destination) => source.endsWith(path.sep + name)
    && destination.endsWith(path.join('materialize', 'backup', name));
  const isPromote = (name) => (source) => source.endsWith(path.join('materialize', 'staged', name));
  const isRollback = (name) => (source) => source.endsWith(path.join('materialize', 'backup', name));

  const staging = await fixture();
  const stageErrors = ['EPERM', 'EACCES', 'EBUSY'].map((code) => renameError(code, '解包 Assets 暂时占用'));
  const stageRule = { matches: isStage, errorAt: (attempt) => stageErrors[attempt - 1] };
  const stageResult = await withRenameFaults([stageRule], staging.open);
  assert.equal(stageRule.attempts, 4, '截图中的 Assets 移动应在临时文件锁释放后成功');
  assert.equal(stageResult.source, 'package');
  assert.equal(await readFile(path.join(stageResult.projectRoot, remoteAsset), 'utf8'), `远端资源 ${staging.id}`);
  assert.ok(stageResult.conflictCopyPath);
  assert.equal(await readFile(path.join(stageResult.conflictCopyPath, 'Scenes', '工厂.scene.json'), 'utf8'), staging.localContent);

  const promote = await fixture();
  const moveRules = ['Assets', 'Scenes', path.join('.babylon-editor', 'asset-index.json')].flatMap((name) => [
    { matches: isBackup(name), errorAt: (attempt) => attempt === 1 ? renameError('EPERM', `备份 ${name}`) : undefined },
    { matches: isPromote(name), errorAt: (attempt) => attempt === 1 ? renameError('EBUSY', `替换 ${name}`) : undefined },
  ]);
  const promoted = await withRenameFaults(moveRules, promote.open);
  for (const rule of moveRules) assert.equal(rule.attempts, 2, '目录及索引的备份、替换都应重试临时锁');
  assert.equal(promoted.source, 'package');
  assert.equal(await readFile(path.join(promoted.projectRoot, remoteAsset), 'utf8'), `远端资源 ${promote.id}`);
  assert.equal(await readFile(path.join(promoted.conflictCopyPath, localAsset), 'utf8'), `本地资源 ${promote.id}`);

  // 持续占用（如开发服务器文件监听）：重命名在有限预算后改用复制替代，工程仍能打开且临时目录被清理。
  const persistent = await fixture();
  const persistentRule = { matches: isStage, errorAt: () => renameError('EPERM', 'Assets 被持续监听占用') };
  const persistentResult = await withRenameFaults([persistentRule], persistent.open);
  assert.equal(persistentRule.attempts, 8, '持续文件锁在有限重试后改用复制');
  assert.equal(persistentResult.source, 'package');
  assert.equal(await readFile(path.join(persistentResult.projectRoot, remoteAsset), 'utf8'), `远端资源 ${persistent.id}`);
  assert.ok(!(await readdir(path.join(persistent.opened.projectRoot, '.babylon-editor')))
    .some((name) => name.startsWith('data-platform-open-')), '复制替代成功后清理临时工程目录');

  for (const [code, attempts, copyFails] of [['EIO', 1, false], ['EPERM', 8, true]]) {
    const failed = await fixture();
    const error = renameError(code, 'Assets 无法移入 staging');
    const rule = { matches: isStage, errorAt: () => error };
    const copyRule = { matches: isStage, error: renameError('ENOSPC', '复制替代空间不足') };
    await withRenameFaults([rule], async () => {
      await assert.rejects(failed.open(), (actual) => (copyFails ? actual.cause === error : actual === error), '保留原始 I/O 异常');
    }, copyFails ? [copyRule] : []);
    assert.equal(rule.attempts, attempts, code === 'EIO' ? '普通 I/O 错误不得重试也不得复制' : '持续文件锁必须在有限预算内结束');
    if (copyFails) assert.equal(copyRule.attempts, 1, '复制替代只尝试一次');
    await failed.assertPreserved();
    assert.ok(!(await readdir(path.join(failed.opened.projectRoot, '.babylon-editor')))
      .some((name) => name.startsWith('data-platform-open-')), '完整回滚后清理临时工程目录');
  }

  const rollback = await fixture();
  const promoteFailure = renameError('EIO', 'Scenes 替换失败');
  const promoteFailureRule = { matches: isPromote('Scenes'), errorAt: () => promoteFailure };
  const rollbackRules = ['Scenes', 'Assets'].map((name) => ({ matches: isRollback(name),
    errorAt: (attempt) => attempt === 1 ? renameError('EACCES', `回滚 ${name} 暂时占用`) : undefined }));
  await withRenameFaults([promoteFailureRule, ...rollbackRules], async () => {
    await assert.rejects(rollback.open(), (actual) => actual === promoteFailure);
  });
  assert.equal(promoteFailureRule.attempts, 1);
  for (const rule of rollbackRules) assert.equal(rule.attempts, 2);
  await rollback.assertPreserved();

  const cancelled = await fixture();
  let cancellationRequested = false;
  let cancellationTimer;
  const cancelPromote = { matches: isPromote('Scenes'), errorAt: () => {
    cancellationTimer = setTimeout(() => { cancellationRequested = service.cancelDataPlatformProjectLoading(); }, 10);
    return renameError('EPERM', '等待替换 Scenes 时取消');
  } };
  const cancelledRollback = { matches: isRollback('Scenes'),
    errorAt: (attempt) => attempt === 1 ? renameError('EBUSY', '取消后仍需恢复 Scenes') : undefined };
  try {
    await withRenameFaults([cancelPromote, cancelledRollback], async () => {
      await assert.rejects(cancelled.open(), (error) => error.name === 'AbortError');
    });
  } finally {
    clearTimeout(cancellationTimer);
  }
  assert.equal(cancellationRequested, true);
  assert.equal(cancelPromote.attempts, 1, '取消应打断打开事务的重试等待');
  assert.equal(cancelledRollback.attempts, 2, '取消不能阻止已移动旧工程的恢复');
  await cancelled.assertPreserved();

  const unrecoverable = await fixture();
  let retainedScenes;
  const persistentRollback = { matches: isRollback('Scenes'), errorAt: () => renameError('EPERM', '旧 Scenes 持续占用') };
  const originalMatches = persistentRollback.matches;
  persistentRollback.matches = (source, destination) => {
    if (!originalMatches(source, destination)) return false;
    retainedScenes = source;
    return true;
  };
  // 回滚的复制替代也失败时，才进入“回滚不完整、保留恢复目录”的路径。
  const rollbackCopyFault = { matches: (source) => source.endsWith(path.join('materialize', 'backup', 'Scenes')),
    error: renameError('EPERM', '旧 Scenes 复制同样被拒绝') };
  await withRenameFaults([
    { matches: isPromote('Scenes'), errorAt: () => renameError('EIO', '触发不可完整恢复的替换失败') }, persistentRollback,
  ], async () => {
    await assert.rejects(unrecoverable.open(), (error) => {
      assert.equal(error.name, 'DataPlatformRollbackError');
      assert.match(error.message, /回滚不完整.*已保留恢复目录/);
      assert.ok(error.message.includes(path.dirname(retainedScenes)), '错误必须给出实际保留的恢复目录');
      return true;
    });
  }, [rollbackCopyFault]);
  assert.equal(persistentRollback.attempts, 8, '回滚持续失败也必须有有限重试预算');
  assert.equal(rollbackCopyFault.attempts, 1, '回滚的复制替代只尝试一次');
  assert.equal(await readFile(path.join(retainedScenes, '工厂.scene.json'), 'utf8'), unrecoverable.localContent,
    '回滚失败后旧场景完整留在恢复目录，不得被 finally 清理');
  assert.equal(await readFile(path.join(unrecoverable.opened.projectRoot, localAsset), 'utf8'), `本地资源 ${unrecoverable.id}`,
    '可恢复的旧 Assets 仍应恢复');
  assert.equal(await readFile(unrecoverable.bindingPath, 'utf8'), unrecoverable.bindingContent);
  console.log('PASS: Windows staging/backup/promote/rollback lock retries, finite failure, original errors, cancellation and retained recovery data');
}

async function run() {
  const service = await import('../../dist-electron/ipc/dataPlatformProjectService.js');
  const archiveByPath = new Map();
  let downloads = 0;
  const server = createServer((request, response) => {
    request.resume();
    if (request.url === '/failed.zip') { response.writeHead(503); response.end('unavailable'); return; }
    const archive = archiveByPath.get(request.url);
    if (archive) {
      downloads += 1;
      response.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': archive.length });
      response.end(archive);
    } else {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ success: true, data: { records: [], total: 0 } }));
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const sourceKey = createHash('sha256').update(baseUrl).digest('hex');
  const oldWorkspace = path.join(root, '原工作区');
  const newWorkspace = path.join(root, '新工作区');
  try {
    for (const version of [1, 2, 3, 4, 5, 6, 7]) {
      const oldModelPath = path.join(oldWorkspace, 'Projects', String(version), 'Assets', 'Models', '设备', 'model.glb');
      const scene = { entities: {}, entityIds: [], sourcePath: oldModelPath, sourceUrl: `editor-asset://local/${encodeURIComponent(oldModelPath)}`,
        ...(version >= 6 ? { sceneSettings: unifiedSettings(), extension: { keep: 'v6-scene' } } : {}) };
      const originalSource = JSON.stringify({ version, scene });
      const sourcePackage = await createPackage(version, scene);
      archiveByPath.set(`/v${version}.zip`, sourcePackage);
      const project = {
        id: String(version), projectName: `工作区工程 v${version}`,
        latestEditorProjectId: '100', latestEditorProjectVersionId: String(version),
        latestEditorProjectVersionNumber: version, latestEditorProjectPackageUrl: `/v${version}.zip`,
        currentResourceRevision: '0',
      };
      const original = await service.openDataPlatformProject(project, baseUrl, oldWorkspace);
      assert.equal(original.source, 'package', `v${version}: ${original.warning}`);
      assert.ok(original.sceneFilePath);
      const originalContent = await readFile(original.sceneFilePath, 'utf8');
      assertCurrentSceneFile(JSON.parse(originalContent));
      const markerPath = path.join(original.projectRoot, 'local-only.txt');
      await writeFile(markerPath, '保留本地未发布内容');

      const opened = await service.openDataPlatformProject(project, baseUrl, newWorkspace);
      assert.equal(opened.source, 'package', `切换工作区后 v${version}: ${opened.warning}`);
      assert.equal(opened.projectRoot, path.join(newWorkspace, 'Platforms', sourceKey, 'Projects', project.id));
      assert.equal(opened.binding.workspaceRoot, newWorkspace);
      const loaded = JSON.parse(await readFile(opened.sceneFilePath, 'utf8'));
      assertCurrentSceneFile(loaded);
      if (version >= 6) {
        assert.deepEqual(loaded.scene.sceneSettings, scene.sceneSettings, 'v6真实工程打开不能忽略或重置统一照明和显示字段');
        assert.deepEqual(loaded.scene.extension, scene.extension);
      }
      assert.equal(loaded.scene.sourcePath, path.join(opened.projectRoot, 'Assets', 'Models', '设备', 'model.glb'));
      assert.equal(decodeURIComponent(new URL(loaded.scene.sourceUrl).pathname.slice(1)), loaded.scene.sourcePath);
      assert.equal(await readFile(original.sceneFilePath, 'utf8'), originalContent);
      assert.equal(await readFile(markerPath, 'utf8'), '保留本地未发布内容');
      assert.deepEqual(await readFile(path.join(root, `v${version}.zip`)), sourcePackage, '打开工程不得改写远端SOURCE原始包');
      assert.equal(JSON.stringify({ version, scene }), originalSource);
      const failedPublishScene = JSON.parse(originalContent);
      failedPublishScene.scene.name = '发布失败留下的本地修改';
      await writeFile(original.sceneFilePath, JSON.stringify(failedPublishScene));
      const localDraft = path.join(original.projectRoot, 'Scenes', '未发布草稿.scene.json');
      await writeFile(localDraft, JSON.stringify(failedPublishScene));
      const localAsset = path.join(original.projectRoot, 'Assets', 'Models', '未发布资源.txt');
      await writeFile(localAsset, 'local-asset');
      const downloadsBeforeReuse = downloads;
      const reused = await service.openDataPlatformProject(project, baseUrl, oldWorkspace);
      assert.equal(reused.source, 'package', '中台入口必须重新获取远端工程，不能复用发布失败的本地修改');
      assert.equal(downloads, downloadsBeforeReuse + 1);
      assert.equal(await readFile(reused.sceneFilePath, 'utf8'), originalContent);
      assert.deepEqual(await readdir(path.join(reused.projectRoot, 'Scenes')), ['工厂.scene.json']);
      assert.ok(reused.conflictCopyPath, '不同于远端的本地内容须保留副本');
      assert.equal(JSON.parse(await readFile(path.join(reused.conflictCopyPath, 'Scenes', '工厂.scene.json'), 'utf8')).scene.name, failedPublishScene.scene.name);
      assert.equal(await readFile(path.join(reused.conflictCopyPath, 'Assets', 'Models', '未发布资源.txt'), 'utf8'), 'local-asset');
      const unchanged = await service.openDataPlatformProject(project, baseUrl, oldWorkspace);
      assert.equal(unchanged.source, 'package');
      assert.equal(unchanged.conflictCopyPath, null, '本地内容完全等于远端时不重复备份');

      await writeFile(reused.sceneFilePath, JSON.stringify(failedPublishScene));
      await assert.rejects(service.openDataPlatformProject({ ...project, latestEditorProjectPackageUrl: '/failed.zip' }, baseUrl, oldWorkspace), /503/);
      assert.equal(JSON.parse(await readFile(reused.sceneFilePath, 'utf8')).scene.name, failedPublishScene.scene.name, '远端失败时保留本地文件但不得成功回退');
      await assert.rejects(service.openDataPlatformProject({ ...project, latestEditorProjectPackageUrl: null }, baseUrl, oldWorkspace), /工程版本.*工程包/);
      assert.equal(JSON.parse(await readFile(reused.sceneFilePath, 'utf8')).scene.name, failedPublishScene.scene.name, '已存在远端版本却缺少包 URL 时禁止空场景覆盖');
      const empty = await service.openDataPlatformProject({ ...project, latestEditorProjectId: null, latestEditorProjectVersionId: null,
        latestEditorProjectVersionNumber: null, latestEditorProjectPackageUrl: null }, baseUrl, oldWorkspace);
      assert.equal(empty.source, 'generated');
      assert.equal(empty.sceneFilePath, null);
      assert.deepEqual(await readdir(path.join(empty.projectRoot, 'Scenes')), []);
      assert.ok(empty.conflictCopyPath, '远端无工程时仍保留旧本地内容');
    }
    const rollbackProject = {
      id: '8', projectName: '发布中心回滚工程', latestEditorProjectId: '100',
      latestEditorProjectVersionId: '300', latestEditorProjectVersionNumber: 3,
      latestEditorProjectPackageUrl: '/rollback-v3.zip', currentResourceRevision: '0',
    };
    const newerScene = { entities: {}, entityIds: [], name: '后一次发布的场景' };
    const olderScene = { entities: {}, entityIds: [], name: '发布中心选中的回滚场景' };
    archiveByPath.set('/rollback-v3.zip', await createPackage(5, newerScene));
    archiveByPath.set('/rollback-v2.zip', await createPackage(5, olderScene));
    const newer = await service.openDataPlatformProject(rollbackProject, baseUrl, oldWorkspace);
    const newerContent = await readFile(newer.sceneFilePath, 'utf8');
    assertLegacyScenePayload(JSON.parse(newerContent), newerScene);
    const newerAsset = path.join('Assets', 'Models', '新版工作区资源.txt');
    await writeFile(path.join(newer.projectRoot, newerAsset), '新版资源应随冲突副本保留');
    const downloadsBeforeRollback = downloads;
    const rolledBack = await service.openDataPlatformProject({ ...rollbackProject,
      latestEditorProjectVersionId: '200', latestEditorProjectVersionNumber: 2,
      latestEditorProjectPackageUrl: '/rollback-v2.zip',
    }, baseUrl, oldWorkspace);
    assert.equal(rolledBack.projectRoot, newer.projectRoot, '回滚必须替换同一项目工作区');
    assert.equal(rolledBack.source, 'package');
    assert.equal(downloads, downloadsBeforeRollback + 1, '回滚版本号更小时仍须下载远端 SOURCE');
    assertLegacyScenePayload(JSON.parse(await readFile(rolledBack.sceneFilePath, 'utf8')), olderScene);
    assert.equal(rolledBack.binding.latestVersionId, '200');
    assert.equal(rolledBack.binding.latestVersionNumber, 2);
    const persistedBinding = JSON.parse(await readFile(path.join(rolledBack.projectRoot,
      '.babylon-editor', 'data-platform-binding.json'), 'utf8'));
    assert.equal(persistedBinding.latestVersionId, '200', '后续发布使用的持久化基线也必须是回滚版本');
    assert.equal(persistedBinding.latestVersionNumber, 2);
    assert.ok(rolledBack.conflictCopyPath, '回滚前本地新版工程必须保留副本');
    assert.equal(await readFile(path.join(rolledBack.conflictCopyPath, 'Scenes', '工厂.scene.json'), 'utf8'), newerContent);
    assert.equal(await readFile(path.join(rolledBack.conflictCopyPath, newerAsset), 'utf8'), '新版资源应随冲突副本保留');
    assert.ok(!(await readdir(path.join(rolledBack.projectRoot, 'Assets', 'Models'))).includes('新版工作区资源.txt'));
    for (const [id, version, scene] of [['70', 8, { entities: {}, entityIds: [] }], ['71', 6, []]]) {
      archiveByPath.set(`/seed-${id}.zip`, await createPackage(6, { entities: {}, entityIds: [], sceneSettings: unifiedSettings() }));
      const seeded = await service.openDataPlatformProject({
        id, projectName: id, latestEditorProjectPackageUrl: `/seed-${id}.zip`,
        latestEditorProjectId: '100', latestEditorProjectVersionId: `${id}0`,
        latestEditorProjectVersionNumber: 6, currentResourceRevision: '0',
      }, baseUrl, newWorkspace);
      assert.equal(seeded.source, 'package');
      assert.equal(seeded.projectRoot, path.join(newWorkspace, 'Platforms', sourceKey, 'Projects', id));
      archiveByPath.set(`/${id}.zip`, await createPackage(version, scene));
      const localRoot = seeded.projectRoot;
      const localScenePath = seeded.sceneFilePath;
      assert.ok(localScenePath);
      const localAssetPath = path.join(localRoot, 'Assets', 'Models', '本地资源.txt');
      const localContent = JSON.stringify({ version: CURRENT_SCENE_VERSION, scene: { name: '拒绝无效包时必须保留的编辑', entities: {}, entityIds: [], sceneSettings: unifiedSettings() } });
      await mkdir(path.dirname(localScenePath), { recursive: true });
      await mkdir(path.dirname(localAssetPath), { recursive: true });
      await writeFile(localScenePath, localContent);
      await writeFile(localAssetPath, '不能被未来版本或损坏场景覆盖');
      await assert.rejects(service.openDataPlatformProject({
        id, projectName: id, latestEditorProjectPackageUrl: `/${id}.zip`,
        latestEditorProjectId: '100', latestEditorProjectVersionId: id,
        latestEditorProjectVersionNumber: version, currentResourceRevision: '0',
      }, baseUrl, newWorkspace), /不是当前编辑器场景格式/);
      assert.equal(await readFile(localScenePath, 'utf8'), localContent);
      assert.equal(await readFile(localAssetPath, 'utf8'), '不能被未来版本或损坏场景覆盖');
      assert.deepEqual(await readdir(path.dirname(localScenePath)), ['工厂.scene.json']);
    }
    await assertWindowsRenameRecovery(service, archiveByPath, baseUrl, newWorkspace);
    console.log('PASS: v1-v7 SOURCE open and canonical v7 output, unified lighting preservation, raw package immutability, path relocation, rollback binding, local backups, no fallback, remote empty, future v8 and invalid scene rejection without overwrite');
  } finally {
    await service.disposeDataPlatformProjectTasks();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

app.whenReady().then(run).then(() => app.exit(0), (error) => {
  console.error(error);
  app.exit(1);
});
