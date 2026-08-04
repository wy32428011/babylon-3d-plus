import assert from 'node:assert/strict';
import test from 'node:test';
import { lstat, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  clearCurrentDataPlatformBinding,
  createDataPlatformBinding,
  getCurrentDataPlatformBinding,
  getDataPlatformBindingPath,
  readDataPlatformBinding,
  resolveDataPlatformProjectRoot,
  resolveDataPlatformSharedResourcesRoot,
  setCurrentDataPlatformBinding,
  updateDataPlatformBinding,
  writeDataPlatformBinding,
} from '../../electron/ipc/dataPlatformBindingStore.ts';

test('数据中台工作区按项目与共享资源隔离', () => {
  const root = path.join('C:', 'workspace');
  assert.equal(resolveDataPlatformProjectRoot(root, '2054201280000000001'), path.resolve(root, 'Projects', '2054201280000000001'));
  assert.equal(resolveDataPlatformSharedResourcesRoot(root), path.resolve(root, 'SharedResources'));
  assert.throws(() => resolveDataPlatformProjectRoot(root, '../escape'), /项目 ID/);
});

test('本地绑定元数据原子写入并按字符串保留 Long 精度', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'zending-binding-test-'));
  const projectRoot = resolveDataPlatformProjectRoot(workspace, '2054201280000000001');
  try {
    const binding = createDataPlatformBinding({
      baseUrl: 'https://twin.example.com/platform/',
      projectId: '2054201280000000001',
      projectName: '一号工程',
      editorProjectId: '2054201280000000002',
      latestVersionId: '2054201280000000003',
      latestVersionNumber: 7,
      resourceRevision: '9007199254740993',
      entryScenePath: 'Scenes/main.scene.json',
      syncedAt: '2026-08-01T08:00:00.000Z',
    });
    await writeDataPlatformBinding(projectRoot, binding);
    assert.deepEqual(await readDataPlatformBinding(projectRoot), binding);
    const persisted = JSON.parse(await readFile(getDataPlatformBindingPath(projectRoot), 'utf8'));
    assert.equal(persisted.resourceRevision, '9007199254740993');
    assert.equal(persisted.latestVersionId, '2054201280000000003');
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('定向更新发布项目绑定不会污染后来切换的当前项目', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'zending-binding-switch-'));
  const firstRoot = resolveDataPlatformProjectRoot(workspace, '101');
  const secondRoot = resolveDataPlatformProjectRoot(workspace, '202');
  const createBinding = (projectId: string, projectName: string) => createDataPlatformBinding({
    baseUrl: 'http://127.0.0.1:8086',
    projectId,
    projectName,
    editorProjectId: null,
    latestVersionId: null,
    latestVersionNumber: null,
    resourceRevision: '0',
    entryScenePath: 'Scenes/main.scene.json',
    syncedAt: '2026-08-01T08:00:00.000Z',
  });
  try {
    const first = createBinding('101', '项目 A');
    const second = createBinding('202', '项目 B');
    await writeDataPlatformBinding(firstRoot, first);
    await writeDataPlatformBinding(secondRoot, second);
    setCurrentDataPlatformBinding(secondRoot, second);

    await updateDataPlatformBinding(firstRoot, '101', {
      editorProjectId: '1001',
      latestVersionId: '1002',
      latestVersionNumber: 1,
      resourceRevision: '1',
    });

    const persistedFirst = await readDataPlatformBinding(firstRoot);
    assert.equal(persistedFirst?.latestVersionId, '1002');
    assert.equal(getCurrentDataPlatformBinding()?.metadata.projectId, '202');
    await assert.rejects(
      updateDataPlatformBinding(firstRoot, '202', { resourceRevision: '2' }),
      /不匹配/,
    );
  } finally {
    clearCurrentDataPlatformBinding();
    await rm(workspace, { recursive: true, force: true });
  }
});

test('绑定目标异常为目录时拒绝覆盖并保留原目录', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'zending-binding-directory-'));
  const projectRoot = resolveDataPlatformProjectRoot(workspace, '303');
  const binding = createDataPlatformBinding({
    baseUrl: 'http://127.0.0.1:8086',
    projectId: '303',
    projectName: '目录保护测试',
    editorProjectId: null,
    latestVersionId: null,
    latestVersionNumber: null,
    resourceRevision: '0',
    entryScenePath: 'Scenes/main.scene.json',
    syncedAt: '2026-08-01T08:00:00.000Z',
  });
  const bindingPath = getDataPlatformBindingPath(projectRoot);
  try {
    await mkdir(bindingPath, { recursive: true });
    await assert.rejects(writeDataPlatformBinding(projectRoot, binding), /目标路径不是安全普通文件/);
    assert.equal((await lstat(bindingPath)).isDirectory(), true);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('损坏或越界的本地绑定被拒绝', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'zending-binding-invalid-'));
  const projectRoot = resolveDataPlatformProjectRoot(workspace, '42');
  try {
    assert.throws(() => createDataPlatformBinding({
      baseUrl: 'http://127.0.0.1:8086',
      projectId: '42',
      projectName: '测试',
      editorProjectId: null,
      latestVersionId: null,
      latestVersionNumber: null,
      resourceRevision: '0',
      entryScenePath: '../escape.scene.json',
      syncedAt: '2026-08-01T08:00:00.000Z',
    }), /场景路径/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
