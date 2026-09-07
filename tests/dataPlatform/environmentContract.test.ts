import assert from 'node:assert/strict';
import test from 'node:test';
import { importIsolatedTypeScriptModules } from '../helpers/extensionlessTypeScriptTestBootstrap.ts';
const [{
  normalizeDataPlatformSourceUrl,
  normalizeEnvironmentManifestResponse,
}] = await importIsolatedTypeScriptModules<[typeof import('../../electron/ipc/dataPlatformEnvironmentContract')]>(
  ['electron/ipc/dataPlatformEnvironmentContract.ts'],
);

const SHA = 'a'.repeat(64);

test('按需清单跳过未引用坏资源，同时严格检查必需环境', () => {
  const item = { id: '1', modelName: '当前环境', fileStatus: 'GLB_READY', fileName: 'scene.glb',
    fileSizeBytes: '805306368', fileSha256: SHA, lengthUnit: 'meter', fileRevision: '1', runtimeRevision: '1', downloadUrl: '/scene.glb' };
  const manifest = { success: true, data: { protocolVersion: '1', manifestRevision: '1',
    records: [item, { ...item, id: '2', fileSizeBytes: '4294967296' }], nextCursorId: null, hasMore: false } };
  const required = normalizeEnvironmentManifestResponse(manifest, new Set(['1']));
  assert.deepEqual(required.records.map((entry) => entry.id), ['1']);
  assert.equal(required.records[0].fileSizeBytes, 768 * 1024 * 1024);
  assert.throws(() => normalizeEnvironmentManifestResponse(manifest, new Set(['2'])));
  assert.throws(() => normalizeEnvironmentManifestResponse(manifest));
});

test('环境模型清单严格保留 Long 字符串并解析 GLB_READY', () => {
  const result = normalizeEnvironmentManifestResponse({
    success: true,
    data: {
      protocolVersion: '1',
      manifestRevision: '9007199254740993',
      records: [{
        id: '9007199254740995',
        modelName: '厂区环境',
        fileStatus: 'GLB_READY',
        fileName: 'factory.glb',
        fileSizeBytes: '128',
        fileSha256: SHA,
        lengthUnit: 'meter',
        fileRevision: '12',
        runtimeRevision: '13',
        downloadUrl: '/api/v1/env-models/9007199254740995/file?fileRevision=12',
        updatedAt: '2026-08-12T09:00:00+08:00',
      }],
      nextCursorId: null,
      hasMore: false,
    },
  });
  assert.equal(result.manifestRevision, '9007199254740993');
  assert.equal(result.records[0].id, '9007199254740995');
  assert.equal(result.records[0].fileSizeBytes, 128);
});

test('清单拒绝 GLB_READY 缺少摘要及非法数字类型', () => {
  assert.throws(() => normalizeEnvironmentManifestResponse({
    success: true,
    data: {
      protocolVersion: '1', manifestRevision: '1', nextCursorId: null, hasMore: false,
      records: [{ id: '1', modelName: 'x', fileStatus: 'GLB_READY', fileName: 'x.glb', fileSizeBytes: '1', lengthUnit: 'meter', fileRevision: '1', runtimeRevision: '1', downloadUrl: '/x' }],
    },
  }), /缺少下载、修订、摘要或大小/);
  assert.throws(() => normalizeEnvironmentManifestResponse({
    success: true,
    data: { protocolVersion: '1', manifestRevision: 1, records: [], nextCursorId: null, hasMore: false },
  }), /十进制字符串/);
});

test('sourceKey 输入规范化删除默认端口并保留部署路径', () => {
  assert.equal(normalizeDataPlatformSourceUrl('HTTPS://Example.COM:443/platform/'), 'https://example.com/platform');
  assert.throws(() => normalizeDataPlatformSourceUrl('https://user:pass@example.com/'), /凭据/);
  assert.throws(() => normalizeDataPlatformSourceUrl('https://example.com/?tenant=1'), /query/);
});
