import assert from 'node:assert/strict';
import test from 'node:test';
import { parsePublishedReleaseManifest } from '../../src/player/publishedReleaseManifest.ts';

const base = 'https://viewer.test/digital-twin/releases/123/4/';
const file = { path: 'project/assets/model.glb', size: 12, sha256: 'a'.repeat(64), contentType: 'model/gltf-binary', storage: 'asset' };
const manifest = (files: unknown[] = [file]) => ({ version: 1, cacheRevision: 'release-4', totalBytes: 12, files });

test('完整清单绑定本次发布，兼容编码路径并保留两类存储归属', () => {
  const result = parsePublishedReleaseManifest(manifest([{ ...file, path: 'project/assets/%E6%A8%A1%E5%9E%8B.glb' }]), base, 'release-4');
  assert.equal(result.files[0].url, base + 'project/assets/%E6%A8%A1%E5%9E%8B.glb');
  assert.equal(result.totalBytes, 12);
  assert.throws(() => parsePublishedReleaseManifest(manifest(), base, 'release-5'), /版本/);
});

test('越界、控制文件、重复路径、伪装归属和错误大小拒绝进入完整缓存', () => {
  for (const path of ['../model.glb', 'https://evil.test/a', '/model.glb', 'project/%2e%2e/secret', 'project/a%2fb', 'a\\b', 'a?token=1', 'runtime-config.json', 'published-cache-worker.js']) {
    assert.throws(() => parsePublishedReleaseManifest(manifest([{ ...file, path }]), base, 'release-4'), undefined, path);
  }
  assert.throws(() => parsePublishedReleaseManifest(manifest([file, file]), base, 'release-4'), /重复/);
  assert.throws(() => parsePublishedReleaseManifest(manifest([{ ...file, storage: 'response' }]), base, 'release-4'), /归属/);
  assert.throws(() => parsePublishedReleaseManifest({ ...manifest(), totalBytes: 13 }, base, 'release-4'), /大小/);
});
