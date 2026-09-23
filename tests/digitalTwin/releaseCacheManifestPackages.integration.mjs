import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { app } from 'electron';
import unzipper from 'unzipper';

const root = await mkdtemp(path.join(tmpdir(), 'zending-release-cache-package-'));
await mkdir(path.join(root, 'user-data'));
app.setPath('userData', path.join(root, 'user-data'));
const originalGetAppPath = app.getAppPath;
app.getAppPath = () => root;

async function readArchive(filePath) {
  const archive = await unzipper.Open.file(filePath);
  return new Map(await Promise.all(archive.files.filter((entry) => entry.type === 'File')
    .map(async (entry) => [entry.path.replaceAll('\\', '/'), await entry.buffer()])));
}

async function run() {
  const templateRoot = path.join(root, 'dist-viewer-template');
  const templateFiles = {
    'index.html': '<!doctype html><script type="module" src="./assets/main.js"></script>',
    'assets/main.js': 'console.log("fixture viewer");',
    'assets/main.css': 'body{margin:0}',
    'decoders/draco.wasm': Buffer.from([0, 97, 115, 109]),
    'icons/工厂 #1.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
    'published-cache-worker.js': 'self.addEventListener("fetch",()=>{});',
    'release-cache-manifest.json': 'must be replaced',
    'runtime-config.json': 'must be replaced',
    'README.md': 'must be replaced',
  };
  for (const [relativePath, content] of Object.entries(templateFiles)) {
    await mkdir(path.dirname(path.join(templateRoot, relativePath)), { recursive: true });
    await writeFile(path.join(templateRoot, relativePath), content);
  }
  const { buildDigitalTwinDistPackage } = await import('../../dist-electron/ipc/digitalTwinDistPackage.js');
  const sceneContent = JSON.stringify({ version: 3, scene: {
    id: 'release-cache-scene', name: '缓存打包验证', entityIds: [], entities: {}, selectedEntityId: null,
    sceneSettings: { camera: { savedPose: null, viewDistance: 5000 }, environment: null },
  } });
  const options = { projectId: '123', publishName: '缓存打包验证', sceneContent, signal: new AbortController().signal };
  const first = await buildDigitalTwinDistPackage({ ...options, outputRoot: path.join(root, 'first') });
  const entries = await readArchive(first.filePath);
  const runtime = JSON.parse(entries.get('runtime-config.json').toString());
  const manifest = JSON.parse(entries.get('release-cache-manifest.json').toString());
  assert.equal(runtime.cacheManifest, 'release-cache-manifest.json');
  assert.equal(manifest.cacheRevision, runtime.cacheRevision);
  assert.equal(manifest.version, 1);
  assert.equal(first.fileCount, entries.size);
  const excluded = new Set(['README.md', 'runtime-config.json', 'release-cache-manifest.json', 'published-cache-worker.js']);
  assert.deepEqual(manifest.files.map((entry) => decodeURIComponent(entry.path)).sort(),
    [...entries.keys()].filter((entry) => !excluded.has(entry)).sort());
  let totalBytes = 0;
  for (const entry of manifest.files) {
    const bytes = entries.get(decodeURIComponent(entry.path));
    assert.equal(entry.size, bytes.length);
    assert.equal(entry.sha256, createHash('sha256').update(bytes).digest('hex'));
    totalBytes += bytes.length;
  }
  assert.equal(manifest.totalBytes, totalBytes);
  assert.ok(entries.has('published-cache-worker.js'), 'worker 保留在 ZIP 中但不纳入清单');
  const assetManifest = JSON.parse(entries.get('project/asset-manifest.json').toString());
  assert.equal(assetManifest.version, 1, '原资产清单版本保持兼容');
  assert.ok(Array.isArray(assetManifest.assets), '原资产清单 assets 保持兼容');
  const second = await buildDigitalTwinDistPackage({ ...options, outputRoot: path.join(root, 'second') });
  const secondEntries = await readArchive(second.filePath);
  const secondManifest = JSON.parse(secondEntries.get('release-cache-manifest.json').toString());
  assert.notEqual(secondManifest.cacheRevision, manifest.cacheRevision, '每次发布产生独立缓存版本');
  assert.deepEqual(secondManifest.files, manifest.files, '相同静态内容保持相同字节描述');
  const controller = new AbortController();
  const cancelledRoot = path.join(root, 'cancelled');
  await assert.rejects(buildDigitalTwinDistPackage({ ...options, outputRoot: cancelledRoot, signal: controller.signal,
    onProgress: (_detail, percent) => { if (percent === 83) controller.abort(); },
  }), { name: 'AbortError' });
  assert.deepEqual(await readdir(cancelledRoot), [], '取消后 ZIP 和 staging 全部回收');
  console.log(JSON.stringify({ status: 'PASS', files: first.fileCount, cachedFiles: manifest.files.length,
    checks: ['zip-complete-file-hashes', 'runtime-revision-consistent', 'control-files-excluded',
      'legacy-asset-manifest', 'new-publication-revision', 'cancel-cleanup'] }));
}

async function finish(code) {
  app.getAppPath = originalGetAppPath;
  const resolved = path.resolve(root);
  if (path.dirname(resolved) !== path.resolve(tmpdir()) || !path.basename(resolved).startsWith('zending-release-cache-package-')) {
    throw new Error('拒绝清理测试临时目录之外的路径。');
  }
  await rm(resolved, { recursive: true, force: true });
  app.exit(code);
}

app.whenReady().then(run).then(() => finish(0), async (error) => { console.error(error); await finish(1); });
