import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { importIsolatedTypeScriptModules } from '../helpers/extensionlessTypeScriptTestBootstrap.ts';

const [{
  assertTrustedEnvironmentPath,
  buildDataPlatformEnvironmentPlan,
  ensureTrustedEnvironmentDirectory,
  getDataPlatformEnvironmentRelativePath,
  listIndexedDataPlatformEnvironments,
}] = await importIsolatedTypeScriptModules<[
  typeof import('../../electron/ipc/dataPlatformEnvironmentIndex'),
]>(['electron/ipc/dataPlatformEnvironmentIndex.ts']);

const SOURCE_KEY = 'b'.repeat(64);
const SHA = 'a'.repeat(64);
const SYNCED_AT = '2026-08-12T01:00:00.000Z';

function readyRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: '1', displayName: '厂区环境', fileStatus: 'GLB_READY' as const,
    fileName: 'factory.glb', fileUrl: '/api/v1/env-models/1/file?fileRevision=2',
    fileSizeBytes: 128, fileSha256: SHA, lengthUnit: 'meter' as const,
    fileRevision: '2', runtimeRevision: '3', updatedAt: SYNCED_AT, warning: null,
    ...overrides,
  };
}

test('环境模型缓存路径按 sourceKey、资源 ID 和文件修订隔离', () => {
  assert.equal(
    getDataPlatformEnvironmentRelativePath(SOURCE_KEY, '9007199254740993', '7'),
    `.babylon-editor/data-platform-cache/environments/${SOURCE_KEY}/9007199254740993/7/model.glb`,
  );
});

test('相同摘要和现存文件不重复下载，runtimeRevision 与单位变化仍更新索引', () => {
  const relativePath = getDataPlatformEnvironmentRelativePath(SOURCE_KEY, '1', '2');
  const current = {
    version: 1 as const, protocolVersion: '1', sourceKey: SOURCE_KEY, manifestRevision: '4',
    entries: [{
      sourceKey: SOURCE_KEY, resourceId: '1', displayName: '旧名称', relativePath,
      fileName: 'factory.glb', fileSizeBytes: 128, fileSha256: SHA, fileRevision: '2', runtimeRevision: '2',
      lengthUnit: 'centimeter' as const, status: 'active' as const, syncedAt: SYNCED_AT,
      lastUsedAt: SYNCED_AT, warning: null,
    }],
  };
  const plan = buildDataPlatformEnvironmentPlan({
    sourceKey: SOURCE_KEY, protocolVersion: '1', manifestRevision: '5',
    records: [readyRecord()], current, existingPaths: new Set([relativePath]), syncedAt: SYNCED_AT,
  });
  assert.equal(plan.downloads.length, 0);
  assert.equal(plan.nextIndex.entries[0].runtimeRevision, '3');
  assert.equal(plan.nextIndex.entries[0].lengthUnit, 'meter');
  assert.deepEqual(plan.changedResourceIds, ['1']);
});

test('远端异常保留旧缓存为 stale，完整清单缺失项标记 deleted', () => {
  const relative1 = getDataPlatformEnvironmentRelativePath(SOURCE_KEY, '1', '2');
  const relative2 = getDataPlatformEnvironmentRelativePath(SOURCE_KEY, '2', '1');
  const base = {
    sourceKey: SOURCE_KEY, displayName: '环境', fileName: 'x.glb', fileSizeBytes: 128, fileSha256: SHA,
    fileRevision: '1', runtimeRevision: '1', lengthUnit: 'meter' as const, status: 'active' as const,
    syncedAt: SYNCED_AT, lastUsedAt: SYNCED_AT, warning: null,
  };
  const current = { version: 1 as const, protocolVersion: '1', sourceKey: SOURCE_KEY, manifestRevision: '1', entries: [
    { ...base, resourceId: '1', relativePath: relative1, fileRevision: '2' },
    { ...base, resourceId: '2', relativePath: relative2 },
  ] };
  const plan = buildDataPlatformEnvironmentPlan({
    sourceKey: SOURCE_KEY, protocolVersion: '1', manifestRevision: '2',
    records: [{ ...readyRecord({ id: '1' }), fileStatus: 'INVALID_FILE', fileName: null, fileUrl: null, fileSizeBytes: null, fileSha256: null, fileRevision: null, runtimeRevision: null }],
    current, existingPaths: new Set([relative1, relative2]), syncedAt: SYNCED_AT,
  });
  assert.equal(plan.nextIndex.entries.find((entry) => entry.resourceId === '1')?.status, 'stale');
  assert.equal(plan.nextIndex.entries.find((entry) => entry.resourceId === '2')?.status, 'deleted');
  assert.deepEqual(plan.deletedResourceIds, ['2']);
});


test('环境缓存路径拒绝目录符号链接或 Windows junction', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'environment-path-guard-'));
  const workspace = path.join(root, 'workspace');
  const outside = path.join(root, 'outside');
  await mkdir(path.join(workspace, '.babylon-editor'), { recursive: true });
  await mkdir(outside, { recursive: true });
  const linkPath = path.join(workspace, '.babylon-editor', 'data-platform-cache');
  try {
    await symlink(outside, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String(error.code) : '';
    if (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP') {
      t.skip(`当前环境无创建链接权限：${code}`);
      await rm(root, { recursive: true, force: true });
      return;
    }
    throw error;
  }
  try {
    const target = path.join(linkPath, 'environments', SOURCE_KEY);
    await assert.rejects(
      ensureTrustedEnvironmentDirectory(workspace, target, '测试环境缓存目录'),
      /符号链接|junction|reparse/i,
    );
    await assert.rejects(
      assertTrustedEnvironmentPath(workspace, path.join(target, 'model.glb'), '测试环境缓存文件'),
      /符号链接|junction|reparse/i,
    );
    const relativePath = getDataPlatformEnvironmentRelativePath(SOURCE_KEY, '1', '2');
    const listed = await listIndexedDataPlatformEnvironments(workspace, {
      version: 1,
      protocolVersion: '1',
      sourceKey: SOURCE_KEY,
      manifestRevision: '1',
      entries: [{
        sourceKey: SOURCE_KEY,
        resourceId: '1',
        displayName: '越界环境',
        relativePath,
        fileName: 'model.glb',
        fileSizeBytes: 128,
        fileSha256: SHA,
        fileRevision: '2',
        runtimeRevision: '3',
        lengthUnit: 'meter',
        status: 'active',
        syncedAt: SYNCED_AT,
        lastUsedAt: SYNCED_AT,
        warning: null,
      }],
    });
    assert.equal(listed.assets.length, 0);
    assert.match(listed.errors[0] ?? '', /符号链接|junction|reparse/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
