import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createServer } from 'node:http';
import { registerHooks } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { after, test, type TestContext } from 'node:test';
import { importIsolatedTypeScriptModules } from '../helpers/extensionlessTypeScriptTestBootstrap.ts';

// 仅隔离 Electron 窗口外壳；恢复、索引、文件固定、HTTP 传输和环境校验仍走真实实现。
const electronShim = `export const app = { getPath() { throw new Error('fixture must not access user profile'); } };
export const dialog = {};
export const BrowserWindow = { getAllWindows: () => [] };
export const net = { fetch: (...args) => globalThis.fetch(...args) };`;
const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
  return specifier === 'electron' ? { url: `data:text/javascript,${encodeURIComponent(electronShim)}`, shortCircuit: true }
    : nextResolve(specifier, context);
} });
let cleanupModules: (() => void) | undefined;
after(() => { hooks.deregister(); cleanupModules?.(); });
const [{ recoverLocalSceneResourceTransaction }, { executeDataPlatformModelSync }, { readProjectAssetIndex }, { encodeAssetUrl }] =
  await importIsolatedTypeScriptModules<[
    typeof import('../../electron/ipc/localSceneRecoveryService'),
    typeof import('../../electron/ipc/dataPlatformModelIncrementalSync'),
    typeof import('../../electron/ipc/projectAssetStore'),
    typeof import('../../electron/ipc/assetRegistry'),
  ]>(['electron/ipc/localSceneRecoveryService.ts', 'electron/ipc/dataPlatformModelIncrementalSync.ts',
    'electron/ipc/projectAssetStore.ts', 'electron/ipc/assetRegistry.ts'], { deferCleanup: cleanup => { cleanupModules = cleanup; } });

function createGlb(marker = 1): Buffer {
  const json = Buffer.from(JSON.stringify({ asset: { version: '2.0' }, buffers: [{ byteLength: 36 }],
    bufferViews: [{ buffer: 0, byteLength: 36 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }], extras: { marker } }],
    nodes: [{ mesh: 0 }], scenes: [{ nodes: [0] }], scene: 0 }));
  const jsonSize = Math.ceil(json.length / 4) * 4;
  const bytes = Buffer.alloc(28 + jsonSize + 36);
  bytes.write('glTF'); bytes.writeUInt32LE(2, 4); bytes.writeUInt32LE(bytes.length, 8);
  bytes.writeUInt32LE(jsonSize, 12); bytes.writeUInt32LE(0x4e4f534a, 16);
  bytes.fill(0x20, 20, 20 + jsonSize); json.copy(bytes, 20);
  bytes.writeUInt32LE(36, 20 + jsonSize); bytes.writeUInt32LE(0x004e4942, 24 + jsonSize);
  Buffer.from(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer).copy(bytes, 28 + jsonSize);
  return bytes;
}
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const envelope = (asset?: Record<string, unknown>) => ({ version: 5, scene: { id: 'local-scene', name: '本地恢复测试',
  entityIds: asset ? ['model'] : [], entities: asset ? { model: { id: 'model', name: '模型',
    components: { modelAsset: asset, transform: { position: { x: 3, y: 4, z: 5 } } } } } : {},
  sceneSettings: { environment: null as Record<string, unknown> | null },
} });

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'local-scene-service-'));
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const workspaceRoot = path.join(root, 'workspace');
  await fs.mkdir(workspaceRoot);
  const write = async (relative: string, bytes: string | Buffer) => {
    const file = path.join(workspaceRoot, relative);
    await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, bytes); return file;
  };
  const run = (document: unknown, baseUrl = '', acceptEnvironmentRevision?: { resourceId: string; fileRevision: string; sha256: string }) =>
    recoverLocalSceneResourceTransaction({ request: { mode: 'local-recovery', sceneContent: JSON.stringify(document),
      sceneFilePath: path.join(workspaceRoot, 'scene.scene.json'), acceptEnvironmentRevision },
    baseUrl, workspaceRoot, projectRoot: null, signal: new AbortController().signal,
    isOriginalPathAllowed: file => {
      const relative = path.relative(root, path.resolve(file));
      return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    } });
  return { root, workspaceRoot, write, run };
}

test('纯本地健康 GLB 不依赖损坏共享索引，保持参数与原文档', async t => {
  const f = await fixture(t);
  const file = await f.write('Assets/local.glb', createGlb());
  await f.write('SharedResources/.babylon-editor/data-platform-model-index.json', '{broken');
  await f.write('SharedResources/.babylon-editor/asset-index.json', '{broken');
  const document = envelope({ sourcePath: file, sourceUrl: encodeAssetUrl(file),
    parameterValues: { path: file, sourcePath: file, sourceUrl: encodeAssetUrl(file), speed: 0, enabled: false } });
  const before = JSON.stringify(document);
  const result = await f.run(document);
  assert.equal(result.configured, false);
  assert.deepEqual(result.issues, []);
  assert.deepEqual(JSON.parse(result.recoveredSceneContent!), document);
  assert.equal(JSON.stringify(document), before);
  assert.ok(result.resolvedFiles.includes(file));
});

test('真实共享包索引固定到 scene-model-versions，资源同文参数和 URL 文本均保持不变', async t => {
  const f = await fixture(t);
  const editorRoot = path.join(f.workspaceRoot, 'SharedResources');
  const bytes = createGlb(7);
  const downloads: string[] = [];
  await executeDataPlatformModelSync({ baseUrl: 'http://127.0.0.1:1/fixture', editorRoot, dependencies: {
    requestJson: async options => ({ success: true, data: { records: options.endpointPath.includes('combo-models') ? [] : [
      { id: '301', modelName: '固定版本模型', fileName: 'model.glb', fileUrl: '/files/model.glb', revision: '1' },
    ], total: options.endpointPath.includes('combo-models') ? 0 : 1, pageNum: 1, pageSize: 100 } }),
    downloadFile: async options => {
      downloads.push(options.remoteUrl); assert.equal(options.remoteUrl, '/files/model.glb');
      await fs.mkdir(path.dirname(options.destinationPath), { recursive: true });
      await fs.writeFile(options.destinationPath, bytes); options.onBytes?.(bytes.length);
      return { bytes: bytes.length, contentType: 'model/gltf-binary', finalUrl: options.remoteUrl, etag: '"fixture"', resumedBytes: 0 };
    },
    readAssetIndex: readProjectAssetIndex,
  } });
  assert.equal(downloads.length, 1);
  const indexed = (await readProjectAssetIndex(editorRoot)).assets.find(asset =>
    path.basename(asset.packagePath ?? '').startsWith('Model-301-'));
  assert.ok(indexed?.assetRevision && indexed.packagePath);
  const parameters = { path: indexed.path, sourcePath: indexed.path, sourceUrl: indexed.sourceUrl,
    text: indexed.sourceUrl, nested: { path: indexed.path }, speed: 12 };
  const document = envelope({ sourcePath: indexed.path, sourceUrl: indexed.sourceUrl,
    assetRevision: indexed.assetRevision, parameterValues: structuredClone(parameters) });
  const scene: any = document.scene;
  scene.entityIds.push('url-only');
  scene.entities['url-only'] = { id: 'url-only', components: { modelAsset: {
    sourceUrl: `${indexed.sourceUrl}?resource=1#mesh`, assetRevision: indexed.assetRevision, parameterValues: structuredClone(parameters),
  } } };
  scene.notes = { path: indexed.path, sourcePath: indexed.path, text: indexed.sourceUrl };
  const before = JSON.stringify(document);
  const result = await f.run(document);
  assert.deepEqual(result.issues, [], JSON.stringify(result.issues));
  const recovered = JSON.parse(result.recoveredSceneContent!).scene;
  const asset = recovered.entities.model.components.modelAsset;
  assert.match(asset.sourcePath.replace(/\\/g, '/'), /\/\.babylon-editor\/scene-model-versions\//);
  assert.equal(asset.assetRevision, indexed.assetRevision);
  assert.deepEqual(await fs.readFile(asset.sourcePath), bytes);
  assert.deepEqual(asset.parameterValues, parameters);
  const urlOnly = recovered.entities['url-only'].components.modelAsset;
  assert.equal(urlOnly.sourcePath, undefined);
  assert.equal(urlOnly.sourceUrl, `${encodeAssetUrl(asset.sourcePath)}?resource=1#mesh`);
  assert.deepEqual(urlOnly.parameterValues, parameters);
  assert.deepEqual(recovered.notes, scene.notes);
  assert.equal(JSON.stringify(document), before);
  assert.ok(result.resolvedFiles.includes(asset.sourcePath));
});

async function environmentServer(t: TestContext) {
  const bytes = createGlb(2);
  const record = { id: '101', modelName: '当前中台厂房', fileStatus: 'GLB_READY', fileName: 'model.glb',
    fileSizeBytes: String(bytes.length), fileSha256: sha256(bytes), fileRevision: '2', runtimeRevision: '22',
    lengthUnit: 'meter', downloadUrl: '/files/environment.glb?fileRevision=2', updatedAt: '2026-09-09T00:00:00.000Z' };
  const requests: string[] = []; let downloads = 0;
  const server = createServer(async (req, res) => {
    try {
      let body = ''; for await (const chunk of req) body += chunk.toString();
      const url = req.url ?? ''; requests.push(url);
      const json = (data: unknown) => { res.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' });
        res.end(JSON.stringify({ success: true, data })); };
      if (url === '/api/v1/env-models/detail') {
        assert.equal(JSON.parse(body).id, '101'); json(record); return;
      }
      if (url === '/api/v1/env-models/sync-manifest/query') {
        json({ protocolVersion: '1', manifestRevision: '1', nextCursorId: null, hasMore: false, records: [record] }); return;
      }
      if (url === record.downloadUrl) {
        downloads += 1; res.writeHead(200, { 'Content-Type': 'model/gltf-binary', 'Content-Length': bytes.length, Connection: 'close' });
        res.end(bytes); return;
      }
      res.writeHead(404); res.end('Unexpected fixture request');
    } catch (error) { res.writeHead(500); res.end(String(error)); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  return { baseUrl: `http://127.0.0.1:${address.port}`, record, bytes, requests, downloads: () => downloads };
}

function createMissingEnvironmentDocument(root: string, fileSizeBytes: number) {
  const oldPackage = path.join(root, 'missing', '.babylon-editor', 'data-platform-cache', 'environments', 'a'.repeat(64), '101', '1');
  const oldFile = path.join(oldPackage, 'model.glb');
  const document = envelope();
  document.scene.sceneSettings.environment = { source: 'data-platform', dataPlatformResourceId: '101',
    dataPlatformSourceKey: 'a'.repeat(64), dataPlatformRevision: '11', fileSizeBytes,
    packagePath: oldPackage, activeVariantUrl: encodeAssetUrl(oldFile),
    variants: [{ name: '原厂房', sourcePath: oldFile, sourceUrl: encodeAssetUrl(oldFile) }],
    lengthUnit: 'meter', unitScaleToMeters: 1, displayName: '原厂房', visible: true, opacity: 0.4,
    transform: { position: { x: 1, y: 2, z: 3 }, rotation: { x: 0, y: 12, z: 0 }, scale: { x: 1, y: 1, z: 1 } } };
  return document;
}

test('环境旧版本缺失时只返回可审阅选择，精确接受才真实下载，过期版本或摘要拒绝', async t => {
  const f = await fixture(t), remote = await environmentServer(t);
  await fs.mkdir(path.join(f.workspaceRoot, 'SharedResources'));
  const document = createMissingEnvironmentDocument(f.root, remote.bytes.length);
  const before = JSON.stringify(document);
  const pending = await f.run(document, remote.baseUrl);
  assert.equal(remote.downloads(), 0);
  assert.equal(remote.requests.filter(url => url.includes('sync-manifest')).length, 0);
  assert.deepEqual(JSON.parse(pending.recoveredSceneContent!), document);
  assert.ok(pending.issues?.some(issue => issue.resourceKind === 'environment'));
  assert.equal(pending.environmentRecoveryChoice?.previousRevision, '1');
  assert.equal(pending.environmentRecoveryChoice?.availableRevision, '2');
  assert.equal(pending.environmentRecoveryChoice?.sha256, remote.record.fileSha256);
  for (const accept of [
    { resourceId: '999', fileRevision: '2', sha256: remote.record.fileSha256 },
    { resourceId: '101', fileRevision: '3', sha256: remote.record.fileSha256 },
    { resourceId: '101', fileRevision: '2', sha256: 'b'.repeat(64) },
  ]) {
    const stale = await f.run(document, remote.baseUrl, accept);
    assert.ok(stale.issues?.some(issue => /已确认.*变化/.test(issue.message)), JSON.stringify(stale.issues));
    assert.equal(remote.downloads(), 0);
    assert.deepEqual(JSON.parse(stale.recoveredSceneContent!), document);
  }
  const accepted = await f.run(document, remote.baseUrl,
    { resourceId: '101', fileRevision: '2', sha256: remote.record.fileSha256 });
  assert.deepEqual(accepted.issues, [], JSON.stringify(accepted.issues));
  assert.equal(remote.downloads(), 1);
  assert.ok(remote.requests.includes('/api/v1/env-models/sync-manifest/query'));
  const environment = JSON.parse(accepted.recoveredSceneContent!).scene.sceneSettings.environment;
  assert.deepEqual(await fs.readFile(environment.variants[0].sourcePath), remote.bytes);
  assert.equal(environment.dataPlatformRevision, '22');
  assert.equal(environment.opacity, 0.4);
  assert.deepEqual(environment.transform, document.scene.sceneSettings.environment!.transform);
  assert.equal(JSON.stringify(document), before);
});

test('新的空工作区在明确接受环境版本后安全创建共享目录并完成恢复', async t => {
  const f = await fixture(t), remote = await environmentServer(t);
  await assert.rejects(fs.stat(path.join(f.workspaceRoot, 'SharedResources')), { code: 'ENOENT' });
  const document = createMissingEnvironmentDocument(f.root, remote.bytes.length);
  const result = await f.run(document, remote.baseUrl,
    { resourceId: '101', fileRevision: '2', sha256: remote.record.fileSha256 });
  assert.deepEqual(result.issues, [], JSON.stringify(result.issues));
  assert.equal(remote.downloads(), 1);
  const file = JSON.parse(result.recoveredSceneContent!).scene.sceneSettings.environment.variants[0].sourcePath;
  assert.ok(path.relative(path.join(f.workspaceRoot, 'SharedResources'), file).startsWith('.babylon-editor'));
  assert.deepEqual(await fs.readFile(file), remote.bytes);
});

test('损坏 editor-asset URL 在事务结果中结构化报告，不抛出 URIError', async t => {
  const f = await fixture(t);
  for (const sourceUrl of ['editor-asset://local/%zz', 'editor-asset://local/%E0%A4%A']) {
    const document = envelope({ sourceUrl, parameterValues: { sourceUrl } });
    const result = await f.run(document);
    assert.ok(result.issues?.some(issue => /URL|安全|路径/.test(issue.message)), JSON.stringify(result.issues));
    assert.deepEqual(JSON.parse(result.recoveredSceneContent!), document);
  }
});
