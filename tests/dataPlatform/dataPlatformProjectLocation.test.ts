import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { importIsolatedTypeScriptModules } from '../helpers/extensionlessTypeScriptTestBootstrap.ts';

const [{ resolveDataPlatformProjectLocation }, binding] = await importIsolatedTypeScriptModules<[
  typeof import('../../electron/ipc/dataPlatformProjectLocation'), typeof import('../../electron/ipc/dataPlatformBindingStore'),
]>(['electron/ipc/dataPlatformProjectLocation.ts', 'electron/ipc/dataPlatformBindingStore.ts']);
const current = 'http://192.168.18.100:8086';
const old = 'http://192.168.50.34:8086';
const id = '2071816469849280514';
async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'platform-location-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
function metadata(baseUrl = current, projectId = id) {
  return binding.createDataPlatformBinding({ baseUrl, projectId, projectName: '测试工程', editorProjectId: null,
    latestVersionId: null, latestVersionNumber: null, resourceRevision: '0', entryScenePath: null, syncedAt: new Date().toISOString() });
}
const scoped = (root: string) => path.join(root, 'Platforms', createHash('sha256').update(current).digest('hex'), 'Projects', id);
test('跨中台同 ID 选择独立目录且预检不写入文件', async t => {
  const root = await fixture(t); const legacy = path.join(root, 'Projects', id);
  await binding.writeDataPlatformBinding(legacy, metadata(old));
  const before = await fs.readFile(binding.getDataPlatformBindingPath(legacy));
  assert.deepEqual(await resolveDataPlatformProjectLocation({ workspaceRoot: root, baseUrl: current, projectId: id }), { projectRoot: scoped(root), legacy: false });
  await assert.rejects(fs.stat(path.join(root, 'Platforms')), { code: 'ENOENT' });
  assert.deepEqual(await fs.readFile(binding.getDataPlatformBindingPath(legacy)), before);
});
test('相同来源旧绑定继续使用，URL 规范化保持一致', async t => {
  const root = await fixture(t); const legacy = path.join(root, 'Projects', id);
  await binding.writeDataPlatformBinding(legacy, metadata());
  assert.deepEqual(await resolveDataPlatformProjectLocation({ workspaceRoot: root, baseUrl: current + '/?x=1#x', projectId: id }), { projectRoot: legacy, legacy: true });
});
test('独立来源绑定优先于同源旧目录', async t => {
  const root = await fixture(t);
  await binding.writeDataPlatformBinding(path.join(root, 'Projects', id), metadata());
  await binding.writeDataPlatformBinding(scoped(root), metadata());
  assert.equal((await resolveDataPlatformProjectLocation({ workspaceRoot: root, baseUrl: current, projectId: id })).projectRoot, scoped(root));
});
test('无绑定旧目录有文件时使用独立目录，保留文件', async t => {
  const root = await fixture(t); const legacy = path.join(root, 'Projects', id);
  await fs.mkdir(legacy, { recursive: true }); await fs.writeFile(path.join(legacy, 'saved.scene.json'), '{}');
  assert.equal((await resolveDataPlatformProjectLocation({ workspaceRoot: root, baseUrl: current, projectId: id })).projectRoot, scoped(root));
  assert.equal(await fs.readFile(path.join(legacy, 'saved.scene.json'), 'utf8'), '{}');
});
test('独立目录坏绑定和不同来源绑定均拒绝复用', async t => {
  const root = await fixture(t);
  await binding.writeDataPlatformBinding(scoped(root), metadata(old));
  await assert.rejects(resolveDataPlatformProjectLocation({ workspaceRoot: root, baseUrl: current, projectId: id }), /不一致/);
  await fs.writeFile(binding.getDataPlatformBindingPath(scoped(root)), 'bad');
  await assert.rejects(resolveDataPlatformProjectLocation({ workspaceRoot: root, baseUrl: current, projectId: id }), /绑定/);
});
test('独立目录无绑定但已有文件时拒绝覆盖', async t => {
  const root = await fixture(t); await fs.mkdir(scoped(root), { recursive: true });
  await fs.writeFile(path.join(scoped(root), 'saved.scene.json'), '{}');
  await assert.rejects(resolveDataPlatformProjectLocation({ workspaceRoot: root, baseUrl: current, projectId: id }), /未绑定/);
});
test('明确工程根要求合法同源绑定，不能使用工作区或共享缓存', async t => {
  const root = await fixture(t); const project = path.join(root, 'custom-project');
  await binding.writeDataPlatformBinding(project, metadata());
  assert.equal((await resolveDataPlatformProjectLocation({ workspaceRoot: root, baseUrl: current, projectId: id, preferredProjectRoot: project })).projectRoot, project);
  for (const preferredProjectRoot of [root, path.join(root, 'SharedResources'), path.join(root, 'unbound')]) {
    await assert.rejects(resolveDataPlatformProjectLocation({ workspaceRoot: root, baseUrl: current, projectId: id, preferredProjectRoot }));
  }
});
test('拒绝越界项目 ID 和相对工作区', async t => {
  const root = await fixture(t);
  for (const projectId of ['../1', '1/2', '0', '1\\2']) await assert.rejects(resolveDataPlatformProjectLocation({ workspaceRoot: root, baseUrl: current, projectId }));
  await assert.rejects(resolveDataPlatformProjectLocation({ workspaceRoot: '.', baseUrl: current, projectId: id }));
});
test('拒绝项目路径中的 junction 防止越界', async t => {
  const root = await fixture(t); const outside = await fixture(t);
  await fs.symlink(outside, path.join(root, 'Platforms'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(resolveDataPlatformProjectLocation({ workspaceRoot: root, baseUrl: current, projectId: id }), /链接/);
});
test('缺少 workspaceRoot 的来源目录绑定正确反推工作区', async t => {
  const root = await fixture(t);
  assert.equal(binding.resolveDataPlatformBindingWorkspaceRoot(scoped(root), metadata()), root);
});
test('全新工作区使用确定来源目录且不创建目录', async t => {
  const root = await fixture(t);
  assert.equal((await resolveDataPlatformProjectLocation({ workspaceRoot: root, baseUrl: current, projectId: id })).projectRoot, scoped(root));
  assert.deepEqual(await fs.readdir(root), []);
});
test('明确工程绑定来源不匹配时不改选其他目录', async t => {
  const root = await fixture(t); const preferredProjectRoot = path.join(root, 'selected');
  await binding.writeDataPlatformBinding(preferredProjectRoot, metadata(old));
  await assert.rejects(resolveDataPlatformProjectLocation({ workspaceRoot: root, baseUrl: current, projectId: id, preferredProjectRoot }), /不一致/);
});
test('独立目录绑定项目 ID 不匹配时拒绝复用', async t => {
  const root = await fixture(t);
  await binding.writeDataPlatformBinding(scoped(root), metadata(current, '123'));
  await assert.rejects(resolveDataPlatformProjectLocation({ workspaceRoot: root, baseUrl: current, projectId: id }), /项目不一致/);
});
test('绑定元数据目录 junction 不允许穿透', async t => {
  const root = await fixture(t); const outside = await fixture(t);
  await fs.mkdir(scoped(root), { recursive: true });
  await fs.symlink(outside, path.join(scoped(root), '.babylon-editor'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(resolveDataPlatformProjectLocation({ workspaceRoot: root, baseUrl: current, projectId: id }), /链接/);
});
test('工作区以下文件占用目录路径时明确失败', async t => {
  const root = await fixture(t); await fs.writeFile(path.join(root, 'Platforms'), 'saved');
  await assert.rejects(resolveDataPlatformProjectLocation({ workspaceRoot: root, baseUrl: current, projectId: id }), /不是目录/);
});
