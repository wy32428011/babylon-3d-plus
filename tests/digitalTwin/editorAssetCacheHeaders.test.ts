import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createEditorAssetEtag,
  resolveEditorAssetCacheControl,
  resolveEditorAssetProtocolResponse,
} from '../../electron/ipc/editorAssetCacheHeaders.ts';

test('环境与模型文件使用可协商缓存，源码或 JSON 仍禁止缓存', () => {
  assert.equal(
    resolveEditorAssetCacheControl('C:/project/Assets/Environments/factory/factory.glb'),
    'private, max-age=0, must-revalidate',
  );
  assert.equal(
    resolveEditorAssetCacheControl('C:/project/Assets/Models/box/box.gltf'),
    'private, max-age=0, must-revalidate',
  );
  assert.equal(
    resolveEditorAssetCacheControl('C:/project/Assets/Skyboxes/sky.hdr'),
    'private, max-age=0, must-revalidate',
  );
  assert.equal(
    resolveEditorAssetCacheControl('C:/project/Assets/Models/box/box.model.ts'),
    'no-store',
  );
});

test('ETag 命中时返回 304，文件替换后必须重新传输', () => {
  const etag = createEditorAssetEtag(20_385_852, 1_700_000_000_000);
  const cached = resolveEditorAssetProtocolResponse({
    filePath: 'C:/project/Assets/Environments/factory/factory.glb',
    size: 20_385_852,
    mtimeMs: 1_700_000_000_000,
    ifNoneMatch: etag,
  });
  assert.equal(cached.status, 304);
  assert.equal(cached.body, null);
  assert.equal(cached.headers.ETag, etag);

  const replaced = resolveEditorAssetProtocolResponse({
    filePath: 'C:/project/Assets/Environments/factory/factory.glb',
    size: 20_385_852,
    mtimeMs: 1_700_000_000_500,
    ifNoneMatch: etag,
  });
  assert.equal(replaced.status, 200);
  assert.equal(replaced.body, 'stream');
  assert.notEqual(replaced.headers.ETag, etag);
});
