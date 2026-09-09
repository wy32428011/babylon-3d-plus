import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { app } from 'electron';

const root = await mkdtemp(path.join(os.tmpdir(), 'publish-binding-recovery-'));
await mkdir(path.join(root, 'user-data'));
app.setPath('userData', path.join(root, 'user-data'));
app.disableHardwareAcceleration();

async function run() {
  const service = await import('../../dist-electron/ipc/dataPlatformProjectService.js');
  const assets = await import('../../dist-electron/ipc/projectAssetStore.js');
  const bindings = await import('../../dist-electron/ipc/dataPlatformBindingStore.js');
  const workspace = path.join(root, 'workspace');
  await mkdir(workspace);
  await assets.activateProjectRoot(workspace);
  bindings.clearCurrentDataPlatformBinding();
  const project = { id: '42', projectName: '发布重试工程', currentResourceRevision: '5',
    latestEditorProjectId: '100', latestEditorProjectVersionId: '200', latestEditorProjectVersionNumber: 3 };
  const baseUrl = 'http://127.0.0.1:8765';
  const prepared = await service.prepareDataPlatformProjectForPublish(project, baseUrl, workspace);
  const metadata = await bindings.updateDataPlatformBinding(prepared.projectRoot, '42', {
    latestVersionId: '201', latestVersionNumber: 4, resourceRevision: '6', entryScenePath: 'Scenes/saved.scene.json',
  });
  const bindingFile = bindings.getDataPlatformBindingPath(prepared.projectRoot);
  const before = await readFile(bindingFile, 'utf8');

  const repeated = await service.prepareDataPlatformProjectForPublish(project, baseUrl + '/', workspace);
  assert.deepEqual(repeated.binding, metadata, '重复绑定应复用磁盘元数据，不回退版本和入口场景');
  assert.equal(await readFile(bindingFile, 'utf8'), before, '幂等重试不重写已有绑定');

  bindings.clearCurrentDataPlatformBinding();
  await assets.activateProjectRoot(workspace);
  const reopened = await service.prepareDataPlatformProjectForPublish(project, baseUrl, workspace);
  assert.deepEqual(reopened.binding, metadata, '返回首页后重开本地场景仍能恢复磁盘绑定');
  assert.equal(assets.getCurrentProjectRoot(), prepared.projectRoot);
  assert.equal(assets.getSharedProjectAssetRoot(), path.join(workspace, 'SharedResources'));

  const retries = await Promise.all(Array.from({ length: 4 }, () => service.prepareDataPlatformProjectForPublish(project, baseUrl, workspace)));
  assert.ok(retries.every(result => result.binding.latestVersionId === '201'));
  assert.equal(await readFile(bindingFile, 'utf8'), before);

  bindings.clearCurrentDataPlatformBinding();
  await assets.activateProjectRoot(workspace);
  const competing = await Promise.allSettled([
    service.prepareDataPlatformProjectForPublish(project, baseUrl, workspace),
    service.prepareDataPlatformProjectForPublish({ ...project, id: '43' }, baseUrl, workspace),
  ]);
  assert.equal(competing[0].status, 'fulfilled');
  assert.equal(competing[1].status, 'rejected', '并发选择不同项目不得互相覆盖当前会话');
  const canceled = new AbortController(); canceled.abort();
  await assert.rejects(service.prepareDataPlatformProjectForPublish(project, baseUrl, workspace, baseUrl, canceled.signal), { name: 'AbortError' });
  assert.equal(await readFile(bindingFile, 'utf8'), before);

  const beforeRoot = assets.getCurrentProjectRoot();
  await assert.rejects(service.prepareDataPlatformProjectForPublish({ ...project, id: '43' }, baseUrl, workspace), /绑定.*项目|项目.*不一致/);
  await assert.rejects(service.prepareDataPlatformProjectForPublish(project, 'http://127.0.0.1:8766', workspace), /数据中台.*不一致|绑定.*来源/);
  assert.equal(assets.getCurrentProjectRoot(), beforeRoot);
  assert.deepEqual(bindings.getCurrentDataPlatformBinding().metadata, metadata);
  assert.equal(await readFile(bindingFile, 'utf8'), before);

  bindings.clearCurrentDataPlatformBinding();
  await assets.activateProjectRoot(workspace);
  await writeFile(bindingFile, '{invalid-json');
  await assert.rejects(service.prepareDataPlatformProjectForPublish(project, baseUrl, workspace), /读取.*绑定失败/);
  assert.equal(assets.getCurrentProjectRoot(), workspace, '失败不得提前切换当前项目');
  assert.equal(bindings.getCurrentDataPlatformBinding(), null);
  assert.equal(await readFile(bindingFile, 'utf8'), '{invalid-json');
  await writeFile(bindingFile, before);

  console.log('PASS: initial binding; idempotent retry; persisted binding restore; concurrent retry; project/source conflict isolation; corrupt binding preserves session');
  await service.disposeDataPlatformProjectTasks();
}

let exitCode = 0;
void app.whenReady().then(run).catch(error => { console.error(error); exitCode = 1; }).finally(async () => {
  const actual = path.resolve(root);
  assert.ok(actual.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(actual).startsWith('publish-binding-recovery-'));
  await rm(actual, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  app.exit(exitCode);
});
