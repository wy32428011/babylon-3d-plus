import assert from 'node:assert/strict';
import test from 'node:test';

import { decodeSkyboxAssetDragPayload } from '../../src/editor/assets/AssetDatabase';

const SHA256 = 'a'.repeat(64);
const RESOURCE_ID = '2052912068767571969';

function createLegacyPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: String.raw`C:\Project\Assets\Skyboxes\local\local.hdr`,
    name: 'local.hdr',
    displayName: 'local',
    path: String.raw`C:\Project\Assets\Skyboxes\local\local.hdr`,
    sourceUrl: 'editor-asset://local/C%3A%5CProject%5CAssets%5CSkyboxes%5Clocal%5Clocal.hdr',
    assetRevision: 'local-revision',
    packagePath: String.raw`C:\Project\Assets\Skyboxes\local`,
    kind: 'skybox',
    libraryKind: 'skybox',
    format: 'hdr',
    fileSizeBytes: 1024,
    ...overrides,
  };
}

function createRemotePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return createLegacyPayload({
    id: `data-platform-skybox:${RESOURCE_ID}`,
    name: 'skybox.hdr',
    displayName: '数据中台天空盒',
    assetRevision: SHA256,
    source: 'data-platform',
    availability: 'active',
    dataPlatformResourceId: RESOURCE_ID,
    dataPlatformRevision: '9999999999999999999',
    fileSha256: SHA256,
    ...overrides,
  });
}

test('旧天空盒拖拽 payload 归一化为 project/active', () => {
  const decoded = decodeSkyboxAssetDragPayload(JSON.stringify(createLegacyPayload()));
  assert.equal(decoded?.source, 'project');
  assert.equal(decoded?.availability, 'active');
});

test('Object.prototype 污染不能补充 source/availability 或远端元数据', () => {
  const oldPayload = JSON.stringify(createLegacyPayload());
  const remoteWithoutMetadata = createRemotePayload();
  delete remoteWithoutMetadata.dataPlatformResourceId;
  delete remoteWithoutMetadata.dataPlatformRevision;
  delete remoteWithoutMetadata.fileSha256;
  const remotePayload = JSON.stringify(remoteWithoutMetadata);

  Object.defineProperties(Object.prototype, {
    source: { configurable: true, value: 'data-platform' },
    availability: { configurable: true, value: 'orphaned' },
    dataPlatformResourceId: { configurable: true, value: RESOURCE_ID },
    dataPlatformRevision: { configurable: true, value: '1' },
    fileSha256: { configurable: true, value: SHA256 },
  });
  try {
    const decodedOld = decodeSkyboxAssetDragPayload(oldPayload);
    assert.equal(decodedOld?.source, 'project');
    assert.equal(decodedOld?.availability, 'active');
    assert.equal(decodeSkyboxAssetDragPayload(remotePayload), null);
  } finally {
    for (const key of ['source', 'availability', 'dataPlatformResourceId', 'dataPlatformRevision', 'fileSha256']) {
      delete (Object.prototype as Record<string, unknown>)[key];
    }
  }
});

test('orphaned 天空盒拖拽 payload 一律拒绝', () => {
  assert.equal(
    decodeSkyboxAssetDragPayload(JSON.stringify(createRemotePayload({ availability: 'orphaned' }))),
    null,
  );
});

test('数据中台 payload 缺少 ID、revision 或 SHA 时拒绝', () => {
  for (const key of ['dataPlatformResourceId', 'dataPlatformRevision', 'fileSha256'] as const) {
    const payload = createRemotePayload();
    delete payload[key];
    assert.equal(decodeSkyboxAssetDragPayload(JSON.stringify(payload)), null, key);
  }
});

test('完整 active 数据中台 payload 接受并保持 Long 字符串', () => {
  const decoded = decodeSkyboxAssetDragPayload(JSON.stringify(createRemotePayload()));
  assert.equal(decoded?.source, 'data-platform');
  assert.equal(decoded?.availability, 'active');
  assert.equal(decoded?.dataPlatformResourceId, RESOURCE_ID);
  assert.equal(decoded?.dataPlatformRevision, '9999999999999999999');
  assert.equal(decoded?.fileSha256, SHA256);
});

test('非法或 null source/availability 拒绝', () => {
  for (const overrides of [
    { source: 'remote' },
    { source: null },
    { availability: 'disabled' },
    { availability: null },
  ]) {
    assert.equal(
      decodeSkyboxAssetDragPayload(JSON.stringify(createRemotePayload(overrides))),
      null,
      JSON.stringify(overrides),
    );
  }
});

test('原型 getter 不会在天空盒 payload 解码时执行', () => {
  const payload = createRemotePayload();
  delete payload.dataPlatformResourceId;
  const rawPayload = JSON.stringify(payload);
  let getterCalls = 0;
  Object.defineProperty(Object.prototype, 'dataPlatformResourceId', {
    configurable: true,
    get() {
      getterCalls += 1;
      return RESOURCE_ID;
    },
  });
  try {
    assert.equal(decodeSkyboxAssetDragPayload(rawPayload), null);
    assert.equal(getterCalls, 0);
  } finally {
    delete (Object.prototype as Record<string, unknown>).dataPlatformResourceId;
  }
});
