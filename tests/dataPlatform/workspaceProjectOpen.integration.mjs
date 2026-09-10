import assert from 'node:assert/strict';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { ZipArchive } from 'archiver';
import { app } from 'electron';

const root = process.env.ZENDING_WORKSPACE_OPEN_TEST_ROOT;
if (!root) throw new Error('请通过 workspaceProjectOpen.test.ts 运行隔离测试。');
await mkdir(path.join(root, 'user-data'));
app.setPath('userData', path.join(root, 'user-data'));
app.disableHardwareAcceleration();

async function createPackage(version, scene = { entities: {}, entityIds: [] }) {
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
    archive.append(JSON.stringify({ version, scene }), { name: 'Scenes/工厂.scene.json' });
    void archive.finalize().catch(reject);
  });
  return readFile(archivePath);
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
  const oldWorkspace = path.join(root, '原工作区');
  const newWorkspace = path.join(root, '新工作区');
  try {
    for (const version of [1, 2, 3, 4, 5]) {
      const oldModelPath = path.join(oldWorkspace, 'Projects', String(version), 'Assets', 'Models', '设备', 'model.glb');
      const scene = { entities: {}, entityIds: [], sourcePath: oldModelPath, sourceUrl: `editor-asset://local/${encodeURIComponent(oldModelPath)}` };
      archiveByPath.set(`/v${version}.zip`, await createPackage(version, scene));
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
      const markerPath = path.join(original.projectRoot, 'local-only.txt');
      await writeFile(markerPath, '保留本地未发布内容');

      const opened = await service.openDataPlatformProject(project, baseUrl, newWorkspace);
      assert.equal(opened.source, 'package', `切换工作区后 v${version}: ${opened.warning}`);
      assert.equal(opened.projectRoot, path.join(newWorkspace, 'Projects', project.id));
      assert.equal(opened.binding.workspaceRoot, newWorkspace);
      const loaded = JSON.parse(await readFile(opened.sceneFilePath, 'utf8'));
      assert.equal(loaded.version, version);
      assert.equal(loaded.scene.sourcePath, path.join(opened.projectRoot, 'Assets', 'Models', '设备', 'model.glb'));
      assert.equal(decodeURIComponent(new URL(loaded.scene.sourceUrl).pathname.slice(1)), loaded.scene.sourcePath);
      assert.equal(await readFile(original.sceneFilePath, 'utf8'), originalContent);
      assert.equal(await readFile(markerPath, 'utf8'), '保留本地未发布内容');
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
    assert.deepEqual(JSON.parse(newerContent).scene, newerScene);
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
    assert.deepEqual(JSON.parse(await readFile(rolledBack.sceneFilePath, 'utf8')).scene, olderScene);
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
    for (const [id, version, scene] of [['6', 6, {}], ['7', 5, []]]) {
      archiveByPath.set(`/${id}.zip`, await createPackage(version, scene));
      await assert.rejects(service.openDataPlatformProject({
        id, projectName: id, latestEditorProjectPackageUrl: `/${id}.zip`,
        latestEditorProjectId: '100', latestEditorProjectVersionId: id,
        latestEditorProjectVersionNumber: version, currentResourceRevision: '0',
      }, baseUrl, newWorkspace), /不是当前编辑器场景格式/);
    }
    console.log('PASS: v1-v5 remote authority, rollback SOURCE and binding, same-version failed-publish recovery, local backups, no fallback, remote empty and invalid package rejection');
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
