import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeDataPlatformSourceUrl,
  normalizeEnvironmentManifestResponse,
} from '../../electron/ipc/dataPlatformEnvironmentContract.ts';

const SHA = 'a'.repeat(64);

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
