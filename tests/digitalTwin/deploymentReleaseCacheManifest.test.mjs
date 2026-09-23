import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, open, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createDeploymentReleaseCacheManifest,
  toReleaseCacheManifestUrlPath,
} from '../../dist-electron/ipc/deploymentReleaseCacheManifest.js';

const REVISION = '12345678-1234-4234-8234-123456789abc';

async function withFiles(files, run) {
  const root = await mkdtemp(path.join(tmpdir(), 'zending-release-manifest-'));
  try {
    for (const [relativePath, content] of Object.entries(files)) {
      const target = path.join(root, relativePath);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content);
    }
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('清单完整覆盖实际文件字节，保留确定顺序并按存储归属分类', async () => {
  const files = {
    'index.html': '<!doctype html><title>Viewer</title>',
    'assets/main.js': 'export const ready = true;',
    'assets/main.css': 'body { margin: 0; }',
    'decoders/decoder.wasm': Buffer.from([0, 97, 115, 109]),
    'fonts/viewer.woff2': Buffer.from([1, 2, 3]),
    'project/scene.json': '{"scene":{}}',
    'project/asset-manifest.json': '{"version":1,"assets":[]}',
    'project/assets/模型 #1%.glb': Buffer.from([4, 5, 6]),
    'project/assets/zero.bin': Buffer.alloc(0),
    'project/other.json': '{}',
  };
  await withFiles(files, async (root) => {
    const manifest = await createDeploymentReleaseCacheManifest(root, REVISION, new AbortController().signal);
    assert.equal(manifest.version, 1);
    assert.equal(manifest.cacheRevision, REVISION);
    assert.equal(manifest.totalBytes, Object.values(files).reduce((sum, value) => sum + Buffer.byteLength(value), 0));
    assert.equal(manifest.files.length, Object.keys(files).length);
    assert.deepEqual(manifest, await createDeploymentReleaseCacheManifest(root, REVISION, new AbortController().signal));
    for (const entry of manifest.files) {
      const relativePath = decodeURIComponent(entry.path);
      const bytes = Buffer.from(files[relativePath]);
      assert.equal(entry.size, bytes.length);
      assert.equal(entry.sha256, createHash('sha256').update(bytes).digest('hex'));
      assert.equal(entry.storage, ['project/scene.json', 'project/asset-manifest.json'].includes(relativePath)
        || relativePath.startsWith('project/assets/') ? 'asset' : 'response');
      assert.equal(new URL(entry.path, 'https://example.test/releases/1/').search, '');
      assert.equal(new URL(entry.path, 'https://example.test/releases/1/').hash, '');
    }
    const contentTypes = Object.fromEntries(manifest.files.map((entry) => [entry.path, entry.contentType]));
    assert.equal(contentTypes['index.html'], 'text/html; charset=utf-8');
    assert.equal(contentTypes['assets/main.js'], 'text/javascript; charset=utf-8');
    assert.equal(contentTypes['assets/main.css'], 'text/css; charset=utf-8');
    assert.equal(contentTypes['decoders/decoder.wasm'], 'application/wasm');
    assert.equal(contentTypes['fonts/viewer.woff2'], 'font/woff2');
  });
});

test('排除根级实时配置、说明、清单与 worker，保留同名嵌套资源', async () => {
  await withFiles({
    'runtime-config.json': 'live', 'README.md': 'help', 'README.txt': 'help',
    'release-cache-manifest.json': 'old', 'published-cache-worker.js': 'worker',
    'assets/runtime-config.json': 'static', 'assets/published-cache-worker.js': 'static',
    'project/assets/README.md': 'asset metadata',
  }, async (root) => {
    const manifest = await createDeploymentReleaseCacheManifest(root, REVISION, new AbortController().signal);
    assert.deepEqual(manifest.files.map((entry) => entry.path).sort(), [
      'assets/published-cache-worker.js', 'assets/runtime-config.json', 'project/assets/README.md',
    ]);
  });
});

test('相对路径逐段编码并拒绝绝对路径、空段、反斜杠及路径逃逸', () => {
  assert.equal(toReleaseCacheManifestUrlPath('assets/模型 #1%.glb'), `assets/${encodeURIComponent('模型 #1%.glb')}`);
  for (const unsafe of ['', '/asset.glb', '../asset.glb', 'assets/../a', './a', 'assets//a', 'assets/', 'a\\b', 'C:/a', 'a\u0000b']) {
    assert.throws(() => toReleaseCacheManifestUrlPath(unsafe), /路径/);
  }
});

test('拒绝无效版本标识', async () => {
  await withFiles({ 'index.html': 'viewer' }, async (root) => {
    for (const revision of [undefined, null, '', 'bad/revision', ' revision ', 'x'.repeat(129)]) {
      await assert.rejects(createDeploymentReleaseCacheManifest(root, revision, new AbortController().signal), /版本/);
    }
  });
});

test('拒绝 staging 根以及嵌套目录中的符号链接或 Junction', async () => {
  await withFiles({ 'safe/index.html': 'viewer', 'external/secret.txt': 'outside' }, async (root) => {
    await symlink(path.join(root, 'external'), path.join(root, 'safe', 'linked'), 'junction');
    await assert.rejects(createDeploymentReleaseCacheManifest(path.join(root, 'safe'), REVISION, new AbortController().signal), /符号链接|Junction/);
    await assert.rejects(createDeploymentReleaseCacheManifest(path.join(root, 'safe', 'linked'), REVISION, new AbortController().signal), /符号链接|Junction/);
  });
});

test('取消预检与流式哈希立即终止，不能返回完整清单', async () => {
  await withFiles({ 'large.bin': '' }, async (root) => {
    const handle = await open(path.join(root, 'large.bin'), 'r+');
    await handle.truncate(256 * 1024 * 1024);
    await handle.close();
    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    await assert.rejects(createDeploymentReleaseCacheManifest(root, REVISION, alreadyAborted.signal), { name: 'AbortError' });
    const controller = new AbortController();
    const pending = createDeploymentReleaseCacheManifest(root, REVISION, controller.signal);
    const timer = setTimeout(() => controller.abort(), 20);
    try {
      await assert.rejects(pending, { name: 'AbortError' });
    } finally {
      clearTimeout(timer);
    }
  });
});
