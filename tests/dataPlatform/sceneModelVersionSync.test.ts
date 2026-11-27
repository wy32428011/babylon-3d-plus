import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { importIsolatedTypeScriptModules } from '../helpers/extensionlessTypeScriptTestBootstrap.ts';

const [{ executeDataPlatformModelSync, syncSceneDataPlatformModelAssets, syncInspectionModelVersion, recoverDataPlatformModelAssets, createDataPlatformModelSourceKey,
  listRemoteInspectionModels, listRemoteInspectionModelVersions }, { createSourceResourcePlan }, { recoverLocalSceneResourcePaths },
  { assertInspectionModelSelfContained, parseInspectionMetadata }, { MODEL_METADATA_SCHEMA_VERSION }] = await importIsolatedTypeScriptModules<[
  typeof import('../../electron/ipc/dataPlatformModelIncrementalSync'),
  typeof import('../../electron/ipc/digitalTwinSourceResourcePlan'),
  typeof import('../../electron/ipc/localSceneResourceRecovery'),
  typeof import('../../electron/ipc/inspectionModelResource'),
  typeof import('../../electron/shared/modelMetaExtensions'),
]>(['electron/ipc/dataPlatformModelIncrementalSync.ts', 'electron/ipc/digitalTwinSourceResourcePlan.ts',
  'electron/ipc/localSceneResourceRecovery.ts', 'electron/ipc/inspectionModelResource.ts', 'electron/shared/modelMetaExtensions.ts']);

const baseUrl = 'https://example.com/platform';
const resources = [{ kind: 'model' as const, resourceId: '9007199254740993' }];

async function fixture(run: (context: Awaited<ReturnType<typeof createFixture>>) => Promise<void>) {
  const context = await createFixture();
  try { await run(context); } finally { await fs.rm(context.root, { recursive: true, force: true }); }
}

async function createFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scene-model-version-'));
  const context = {
    root, version: '1', thumbnailBytes: 'thumbnail-1', downloads: [] as string[], queries: 0,
    afterDownload: undefined as (() => void) | undefined,
    thumbnailContentType: 'application/octet-stream',
    record: {} as Record<string, unknown>,
    dependencies: {
      requestJson: async (options: { endpointPath: string; body?: unknown }) => {
        assert.ok(options.endpointPath.endsWith('/detail'));
        assert.equal((options.body as { id: string }).id, resources[0].resourceId);
        context.queries += 1;
        return { success: true, data: {
          id: resources[0].resourceId, modelName: '设备', comboModelName: '组合设备',
          fileName: 'model.gltf', fileUrl: '/model.gltf', revision: context.version,
          metaFileUrl: '/meta.json', scriptFiles: [{ fileName: 'behavior.ts', fileUrl: '/behavior.ts' }],
          ...context.record,
        } };
      },
      downloadFile: async (options: import('../../electron/ipc/dataPlatformTransfer').DownloadRemoteFileOptions) => {
        context.downloads.push(options.remoteUrl);
        const isThumbnail = options.remoteUrl === context.record.thumbnailUrl;
        const bytes = Buffer.from(options.remoteUrl.endsWith('.gltf')
          ? JSON.stringify({ asset: { version: '2.0' }, meshes: [{ primitives: [{}] }], extras: { revision: context.version } })
          : isThumbnail ? context.thumbnailBytes
            : options.remoteUrl.endsWith('.ts') ? 'export default {};' : JSON.stringify({ lengthUnit: 'm' }));
        await fs.mkdir(path.dirname(options.destinationPath), { recursive: true });
        await fs.writeFile(options.destinationPath, bytes);
        context.afterDownload?.();
        return { bytes: bytes.length, contentType: isThumbnail ? context.thumbnailContentType : 'application/octet-stream',
          finalUrl: options.remoteUrl, etag: null, resumedBytes: 0 };
      },
      readAssetIndex: async (editorRoot: string): Promise<import('../../electron/types').ProjectAssetIndex> => {
        try { return JSON.parse(await fs.readFile(path.join(editorRoot, '.babylon-editor/asset-index.json'), 'utf8')); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 2, assets: [] };
          throw error;
        }
      },
    },
  };
  return context;
}

test('场景模型同步固定模型与脚本版本，重复打开零下载，更新保留旧文件', async () => fixture(async (context) => {
  const options = { baseUrl, sharedResourcesRoot: context.root, resources, dependencies: context.dependencies };
  const [first] = await syncSceneDataPlatformModelAssets(options);
  assert.ok(first.path.includes('scene-model-versions'));
  assert.ok(first.path.includes('Model-' + resources[0].resourceId));
  assert.equal(first.dataPlatformSourceKey, createDataPlatformModelSourceKey(baseUrl));
  assert.equal(first.dataPlatformResourceId, resources[0].resourceId);
  assert.ok(first.scriptAssets?.[0].path.startsWith(first.packagePath!));
  const oldBytes = await fs.readFile(first.path);
  const downloads = context.downloads.length;
  assert.ok(downloads > 0);
  const [same] = await syncSceneDataPlatformModelAssets(options);
  assert.equal(same.path, first.path);
  assert.equal(context.downloads.length, downloads);
  context.version = '2';
  const [updated] = await syncSceneDataPlatformModelAssets(options);
  assert.notEqual(updated.path, first.path);
  assert.notEqual(updated.assetRevision, first.assetRevision);
  assert.deepEqual(await fs.readFile(first.path), oldBytes);
  await assert.rejects(fs.access(path.join(context.root, '.babylon-editor/asset-index.json')));
}));

test('当前版本 ID 变化且文件地址相同时重新下载，旧接口按最大版本序号只取一版', async () => fixture(async context => {
  const options = { baseUrl, sharedResourcesRoot: context.root, resources, dependencies: context.dependencies };
  const version = (versionId: string, versionNumber: number, fileUrl: string) => ({
    versionId, versionNumber, fileName: 'model.gltf', fileUrl, metaFileUrl: '/current.json', scriptFiles: [],
  });
  const first = version('9007199254740993', 8, '/current.gltf');
  const second = version('9007199254740994', 9, '/current.gltf');
  const older = version('1', 1, '/historical.gltf');
  context.record = { revision: 'same', currentVersionId: first.versionId, versions: [first, older] };
  const [before] = await syncSceneDataPlatformModelAssets(options);
  assert.deepEqual(context.downloads.toSorted(), ['/current.gltf', '/current.json']);
  assert.equal(before.scriptPaths?.length ?? 0, 0, '新版空脚本清单应清除旧脚本');
  context.downloads.length = 0;
  context.version = '2';
  context.record = { revision: 'same', currentVersionId: second.versionId, versions: [first, second, older] };
  const [after] = await syncSceneDataPlatformModelAssets(options);
  assert.notEqual(after.assetRevision, before.assetRevision);
  assert.deepEqual(context.downloads.toSorted(), ['/current.gltf', '/current.json']);
  context.downloads.length = 0;
  delete context.record.currentVersionId;
  const [legacy] = await syncSceneDataPlatformModelAssets(options);
  assert.equal(legacy.path, after.path);
  assert.deepEqual(context.downloads, []);
}));

test('服务端快照摘要强制校验同URL原始文件，拒绝旧字节并在新字节到达后统一后续缓存', async () => fixture(async context => {
  const options = { baseUrl, sharedResourcesRoot: context.root, resources, dependencies: context.dependencies };
  const [old] = await syncSceneDataPlatformModelAssets(options);
  const digest = value => createHash('sha256').update(value).digest('hex');
  const currentModel = JSON.stringify({ asset: { version: '2.0' }, meshes: [{ primitives: [{}] }], extras: { revision: '2' } });
  const expectedFiles = [
    { role: 'model', fileUrl: '/model.gltf', bytes: currentModel },
    { role: 'metadata', fileUrl: '/meta.json', bytes: JSON.stringify({ lengthUnit: 'm' }) },
    { role: 'script', fileUrl: '/behavior.ts', bytes: 'export default {};' },
  ].map(file => ({ kind: 'model' as const, resourceId: resources[0].resourceId, role: file.role,
    fileUrl: file.fileUrl, sha256: digest(file.bytes), size: String(Buffer.byteLength(file.bytes)) }));
  await assert.rejects(syncSceneDataPlatformModelAssets({ ...options, expectedFiles }), /快照.*摘要|快照.*大小/);
  // 详情revision和URL完全没变，但远端实际字节从旧版切到了新版。
  context.version = '2'; context.record.revision = '1';
  const [updated] = await syncSceneDataPlatformModelAssets({ ...options, expectedFiles });
  assert.notEqual(updated.assetRevision, old.assetRevision);
  assert.equal(await fs.readFile(updated.path, 'utf8'), currentModel);
  const downloadCount = context.downloads.length;
  const [ordinary] = await syncSceneDataPlatformModelAssets(options);
  assert.equal(ordinary.assetRevision, updated.assetRevision, '后续renderer普通同步不能再次使用同描述的旧共享包');
  assert.equal(context.downloads.length, downloadCount);
}));

test('固定高模查询全部历史版本，原始文件摘要与完整包摘要分别校验并隔离缓存', async () => fixture(async context => {
  const ordinary = { baseUrl, sharedResourcesRoot: context.root, resources, dependencies: context.dependencies };
  const [v1] = await syncSceneDataPlatformModelAssets(ordinary);
  const signal = new AbortController().signal;
  const plan = await createSourceResourcePlan([{ sourcePath: v1.packagePath!, destinationRelativePath: 'Assets/Models/Pump' }], context.root, signal);
  const contentSha256 = plan.bundles[0].contentSha256;
  const digest = (bytes: string) => createHash('sha256').update(bytes).digest('hex');
  const modelBytes = JSON.stringify({ asset: { version: '2.0' }, meshes: [{ primitives: [{}] }], extras: { revision: '1' } });
  const expectedFiles = [
    { role: 'model', fileUrl: '/model.gltf', bytes: modelBytes },
    { role: 'metadata', fileUrl: '/meta.json', bytes: JSON.stringify({ lengthUnit: 'm' }) },
    { role: 'script', fileUrl: '/behavior.ts', bytes: 'export default {};' },
  ].map(file => ({ kind: 'model' as const, resourceId: resources[0].resourceId, role: file.role,
    fileUrl: file.fileUrl, sha256: digest(file.bytes), size: String(Buffer.byteLength(file.bytes)) }));
  const originalQuery = context.dependencies.requestJson;
  const dependencies = { ...context.dependencies, requestJson: async options => {
    if (!options.endpointPath.endsWith('/versions/query')) return originalQuery(options);
    assert.match(options.endpointPath, /9007199254740993\/versions\/query$/);
    return { success: true, data: Array.from({ length: 7 }, (_, index) => ({
      versionId: String(7 - index), fileName: 'model.gltf', fileUrl: '/model.gltf', metaFileUrl: '/meta.json',
      scriptFiles: [{ fileName: 'behavior.ts', fileUrl: '/behavior.ts' }],
    })) };
  } };
  const options = { baseUrl, sharedResourcesRoot: context.root, sourceKey: createDataPlatformModelSourceKey(baseUrl),
    modelId: resources[0].resourceId, versionId: '1', contentSha256, expectedFiles, dependencies };
  const { contentSha256: expectedDigest, ...firstOptions } = options;
  const first = await syncInspectionModelVersion(firstOptions);
  assert.equal(first.contentSha256, expectedDigest, '首次绑定的完整包摘要必须由下载内容计算');
  assert.ok(first.path.includes(expectedDigest), '缓存身份必须包含实际内容摘要');
  const fixed = await syncInspectionModelVersion(options);
  assert.equal(fixed.path, first.path);
  assert.match(fixed.path.replace(/\\/g, '/'), /inspection-model-versions\/.*\/9007199254740993\/1\//);
  assert.notEqual(fixed.path, v1.path);
  assert.equal(await fs.readFile(fixed.path, 'utf8'), modelBytes);
  context.version = '2';
  const [v2] = await syncSceneDataPlatformModelAssets(ordinary);
  assert.notEqual(v2.path, fixed.path);
  assert.equal(await fs.readFile(fixed.path, 'utf8'), modelBytes);
  context.version = '1';
  await assert.rejects(syncInspectionModelVersion({ ...options, versionId: '8' }), /不存在唯一指定/);
  await assert.rejects(syncInspectionModelVersion({ ...options, contentSha256: 'f'.repeat(64) }), /完整资源包内容摘要/);
  const wrong = expectedFiles.map((file, index) => index ? file : { ...file, sha256: '0'.repeat(64) });
  await assert.rejects(syncInspectionModelVersion({ ...options, expectedFiles: wrong }), /摘要|大小/);
  const externalModel = JSON.stringify({ asset: { version: '2.0' }, buffers: [{ uri: 'external.bin', byteLength: 1 }] });
  const externalFiles = expectedFiles.map(file => file.role === 'model'
    ? { ...file, sha256: digest(externalModel), size: String(Buffer.byteLength(externalModel)) } : file);
  const externalDependencies = { ...dependencies, downloadFile: async fileOptions => {
    if (!fileOptions.remoteUrl.endsWith('.gltf')) return dependencies.downloadFile(fileOptions);
    await fs.mkdir(path.dirname(fileOptions.destinationPath), { recursive: true });
    await fs.writeFile(fileOptions.destinationPath, externalModel);
    return { bytes: Buffer.byteLength(externalModel), contentType: 'model/gltf+json', finalUrl: fileOptions.remoteUrl, etag: null, resumedBytes: 0 };
  } };
  await assert.rejects(syncInspectionModelVersion({ ...firstOptions, expectedFiles: externalFiles, dependencies: externalDependencies }), /自包含模型/);
}));

test('巡检模型完整分页和版本清单保持 Long 字符串身份', async () => {
  const requests: number[] = [];
  const dependencies = { requestJson: async ({ endpointPath, body }: { endpointPath: string; body: { pageNum: number } }) => {
    if (endpointPath.endsWith('/versions/query')) return { success: true, data: Array.from({ length: 7 }, (_, i) => ({
      versionId: String(9007199254740993n + BigInt(i)), versionNumber: i + 1,
    })) };
    requests.push(body.pageNum);
    const start = (body.pageNum - 1) * 100;
    return { success: true, data: { pageNum: body.pageNum, pageSize: 100, total: 101,
      records: Array.from({ length: Math.min(100, 101 - start) }, (_, i) => ({ id: String(start + i + 1), modelName: `模型${start + i + 1}` })) } };
  } };
  const models = await listRemoteInspectionModels({ baseUrl, dependencies });
  assert.equal(models.length, 101);
  assert.deepEqual(requests, [1, 2]);
  const versions = await listRemoteInspectionModelVersions({ baseUrl, modelId: resources[0].resourceId, dependencies });
  assert.equal(versions.length, 7);
  assert.equal(versions[0].versionId, '9007199254740993');
  assert.equal(versions[6].label, '版本 7');
  await assert.rejects(listRemoteInspectionModelVersions({ baseUrl, modelId: '01', dependencies }), /模型 ID 无效/);
  await assert.rejects(listRemoteInspectionModelVersions({ baseUrl, modelId: '1', dependencies: {
    requestJson: async () => ({ success: true, data: [{ versionId: 9007199254740992 }] }),
  } }), /版本 ID/);
});

test('巡检元数据只接受结构有效的零件与适用配置', () => {
  const part = { partKey: 'root', name: '主机', nodePath: '.', axis: { x: 0, y: 1, z: 0 }, distanceMeters: 0.5, fixed: false };
  assert.deepEqual(parseInspectionMetadata({ lengthUnit: 'm' }), {});
  assert.deepEqual(parseInspectionMetadata({ inspection: { schemaVersion: 1, parts: [part],
    configuration: { id: 'cfg', parameters: { width: 2, enabled: true, position: { x: 1, y: 2, z: 3 } } } } }),
  { parts: [part], configuration: { id: 'cfg', parameters: { width: 2, enabled: true, position: { x: 1, y: 2, z: 3 } } } });
  assert.throws(() => parseInspectionMetadata({ inspection: { schemaVersion: 2, parts: [part] } }), /schemaVersion/);
  assert.throws(() => parseInspectionMetadata({ inspection: { schemaVersion: 1, parts: [part, part] } }), /重复/);
  assert.throws(() => parseInspectionMetadata({ inspection: { schemaVersion: 1, parts: [{ ...part, parentPartKey: 'root' }] } }), /循环/);
  assert.throws(() => parseInspectionMetadata({ inspection: { schemaVersion: 1, parts: [{ ...part, nodePath: 'a/../b' }] } }), /节点路径/);
  assert.throws(() => parseInspectionMetadata({ inspection: { schemaVersion: 1, parts: [{ ...part, axis: { x: 0, y: 0, z: 0 } }] } }), /不能为零/);
  assert.throws(() => parseInspectionMetadata({ inspection: { schemaVersion: 1, parts: [part],
    configuration: { id: 'cfg', parameters: { width: Infinity } } } }), /必须是对象/);
});

test('巡检模型拒绝未受快照保护的外部 glTF 缓冲区与纹理', async () => fixture(async context => {
  const model = path.join(context.root, 'model.gltf'), signal = new AbortController().signal;
  await fs.writeFile(model, JSON.stringify({ asset: { version: '2.0' }, images: [{ uri: 'data:image/png;base64,AQ==' }] }));
  await assertInspectionModelSelfContained(model, context.root, signal);
  await fs.writeFile(path.join(context.root, 'model.bin'), Buffer.from([1]));
  await fs.writeFile(model, JSON.stringify({ asset: { version: '2.0' }, buffers: [{ uri: 'model.bin', byteLength: 1 }] }));
  await assert.rejects(assertInspectionModelSelfContained(model, context.root, signal), /不支持外部缓冲区或纹理/);
  await fs.writeFile(model, JSON.stringify({ asset: { version: '2.0' }, images: [{ uri: 'https://example.com/image.png' }] }));
  await assert.rejects(assertInspectionModelSelfContained(model, context.root, signal), /无法验证为自包含模型/);
}));

test('本地恢复校验高模完整包并拒绝损坏或用最新模型回退', async () => fixture(async context => {
  const workspaceRoot = path.join(context.root, 'workspace'), sourceKey = createDataPlatformModelSourceKey(baseUrl);
  const relative = ['SharedResources', '.babylon-editor', 'inspection-model-versions', sourceKey,
    resources[0].resourceId, '1', 'package', 'Assets', 'Models', `Model-${resources[0].resourceId}-Pump`];
  const packageRoot = path.join(workspaceRoot, ...relative);
  await fs.mkdir(packageRoot, { recursive: true });
  const main = path.join(packageRoot, 'model.gltf'), meta = path.join(packageRoot, 'meta.json');
  await fs.writeFile(main, JSON.stringify({ asset: { version: '2.0' }, meshes: [] }));
  await fs.writeFile(meta, '{"lengthUnit":"m"}');
  const plan = await createSourceResourcePlan([{ sourcePath: packageRoot, destinationRelativePath: 'Assets/Models/Pump' }], workspaceRoot, new AbortController().signal);
  const oldRoot = 'Z:/previous/' + relative.join('/');
  const url = (file: string) => 'editor-asset://local/' + encodeURIComponent(file);
  const model = { dataPlatformModel: { sourceKey, kind: 'model', resourceId: resources[0].resourceId, modelPath: 'model.gltf' },
    versionId: '1', contentSha256: plan.bundles[0].contentSha256, sourcePath: oldRoot + '/model.gltf', sourceUrl: url(oldRoot + '/model.gltf'),
    metaPath: oldRoot + '/meta.json', metaUrl: url(oldRoot + '/meta.json'), unitScaleToMeters: 1 };
  const document = { scene: { entities: { pump: { components: { modelAsset: { inspection: { schemaVersion: 1, model } } } } } } };
  const options = { sceneContent: JSON.stringify(document), workspaceRoot, sourceKey };
  const recovered = await recoverLocalSceneResourcePaths(options);
  const fixed = JSON.parse(recovered.sceneContent).scene.entities.pump.components.modelAsset.inspection.model;
  assert.equal(fixed.sourcePath, main);
  assert.equal(fixed.metaPath, meta);
  assert.equal(fixed.metaUrl, url(meta));
  assert.ok(recovered.resolvedFiles.includes(meta));
  await fs.writeFile(meta, '{"lengthUnit":"cm"}');
  const corrupt = await recoverLocalSceneResourcePaths(options);
  assert.equal(corrupt.restoredReferenceCount, 0);
  assert.ok(corrupt.issues.some(issue => /摘要不一致/.test(issue.message)));
}));

test('场景模型同步前后修订变化时拒绝提交且保留旧固定版本', async () => fixture(async (context) => {
  const options = { baseUrl, sharedResourcesRoot: context.root, resources, dependencies: context.dependencies };
  const [first] = await syncSceneDataPlatformModelAssets(options);
  const bytes = await fs.readFile(first.path);
  context.version = '2';
  context.afterDownload = () => { context.version = '3'; };
  await assert.rejects(syncSceneDataPlatformModelAssets(options), /同步期间.*变化/);
  assert.deepEqual(await fs.readFile(first.path), bytes);
}));

test('场景模型同步按来源隔离，去重引用且拒绝取消和错误 ID', async () => fixture(async (context) => {
  const options = { baseUrl, sharedResourcesRoot: context.root, resources: [...resources, ...resources], dependencies: context.dependencies };
  const first = await syncSceneDataPlatformModelAssets(options);
  assert.equal(first.length, 1);
  const second = await syncSceneDataPlatformModelAssets({ ...options, baseUrl: 'https://other.example.com' });
  assert.notEqual(second[0].path, first[0].path);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(syncSceneDataPlatformModelAssets({ ...options, signal: controller.signal }), /取消/);
  context.record.id = '2';
  await assert.rejects(syncSceneDataPlatformModelAssets(options), /ID/);
}));

test('场景组合模型同步保持 Combo 资源标识', async () => fixture(async (context) => {
  const [asset] = await syncSceneDataPlatformModelAssets({
    baseUrl, sharedResourcesRoot: context.root, dependencies: context.dependencies,
    resources: [{ ...resources[0], kind: 'combo' }],
  });
  assert.ok(asset.path.includes('Combo-' + resources[0].resourceId));
}));

test('缺少远端版本时重新下载确认内容，内容未变复用固定路径', async () => fixture(async (context) => {
  context.record.revision = undefined;
  const options = { baseUrl, sharedResourcesRoot: context.root, resources, dependencies: context.dependencies };
  const [first] = await syncSceneDataPlatformModelAssets(options);
  const count = context.downloads.length;
  const [second] = await syncSceneDataPlatformModelAssets(options);
  assert.ok(context.downloads.length > count);
  assert.equal(first.path, second.path);
}));

test('模型下载中取消不返回资产，重试可继续且没有暂存目录遗留', async () => fixture(async (context) => {
  const controller = new AbortController();
  context.afterDownload = () => controller.abort();
  const options = { baseUrl, sharedResourcesRoot: context.root, resources, dependencies: context.dependencies };
  await assert.rejects(syncSceneDataPlatformModelAssets({ ...options, signal: controller.signal }), /取消/);
  context.afterDownload = undefined;
  const [asset] = await syncSceneDataPlatformModelAssets(options);
  assert.ok(await fs.stat(asset.path));
  const files = await fs.readdir(context.root, { recursive: true });
  assert.equal(files.some((file) => file.includes('.pending-')), false);
}));

test('固定版本被外部修改时拒绝返回伪造版本，也不覆盖已存在的文件', async () => fixture(async (context) => {
  const options = { baseUrl, sharedResourcesRoot: context.root, resources, dependencies: context.dependencies };
  const [asset] = await syncSceneDataPlatformModelAssets(options);
  await fs.writeFile(asset.path, 'tampered');
  await assert.rejects(syncSceneDataPlatformModelAssets(options), /内容与版本不一致/);
  assert.equal(await fs.readFile(asset.path, 'utf8'), 'tampered');
}));

test('模型内容相同但主文件改名时分别保留两个可加载的固定包', async () => fixture(async (context) => {
  const options = { baseUrl, sharedResourcesRoot: context.root, resources, dependencies: context.dependencies };
  const [first] = await syncSceneDataPlatformModelAssets(options);
  context.record.fileName = 'renamed.gltf';
  const [second] = await syncSceneDataPlatformModelAssets(options);
  assert.equal(first.assetRevision, second.assetRevision);
  assert.notEqual(first.path, second.path);
  assert.equal(path.basename(second.path), 'renamed.gltf');
  assert.deepEqual(await fs.readFile(first.path), await fs.readFile(second.path));
}));

test('空引用不查询，非法资源 ID 和超量输入拒绝执行', async () => fixture(async (context) => {
  const options = { baseUrl, sharedResourcesRoot: context.root, resources, dependencies: context.dependencies };
  assert.deepEqual(await syncSceneDataPlatformModelAssets({ ...options, resources: [] }), []);
  assert.equal(context.queries, 0);
  await assert.rejects(syncSceneDataPlatformModelAssets({ ...options, resources: [{ kind: 'model', resourceId: '../bad' }] }), /id 无效/);
  await assert.rejects(syncSceneDataPlatformModelAssets({ ...options, resources: Array(1001).fill(resources[0]) }), /1000/);
}));

test('仅缩略图改扩展名或内容时使用完整新副本，运行时修订和旧文件保持不变', async () => fixture(async (context) => {
  const options = { baseUrl, sharedResourcesRoot: context.root, resources, dependencies: context.dependencies };
  const [withoutThumbnail] = await syncSceneDataPlatformModelAssets(options);
  assert.equal(withoutThumbnail.thumbnailUrl, undefined);
  context.downloads.length = 0;
  context.record.thumbnailUrl = '/api/v1/files/cover';
  context.record.thumbnailRevision = 'thumb-1';
  context.thumbnailContentType = 'image/gif';
  const [first] = await syncSceneDataPlatformModelAssets(options);
  assert.deepEqual(context.downloads, ['/api/v1/files/cover'], '给已有模型补封面只下载图片');
  assert.equal(first.assetRevision, withoutThumbnail.assetRevision);
  assert.ok(first.thumbnailUrl?.startsWith('editor-asset://'));
  assert.equal(path.extname(first.thumbnailPath!), '.gif');
  context.downloads.length = 0;
  context.record.thumbnailUrl = '/thumbnail.jpg';
  context.record.thumbnailRevision = 'thumb-2';
  context.thumbnailContentType = 'image/jpeg';
  context.thumbnailBytes = 'thumbnail-2';
  const [second] = await syncSceneDataPlatformModelAssets(options);
  assert.deepEqual(context.downloads, ['/thumbnail.jpg']);
  assert.equal(first.assetRevision, second.assetRevision);
  assert.notEqual(first.packagePath, second.packagePath);
  assert.equal(path.extname(second.thumbnailPath!), '.jpg');
  assert.equal(await fs.readFile(first.thumbnailPath!, 'utf8'), 'thumbnail-1');
  assert.equal(await fs.readFile(second.thumbnailPath!, 'utf8'), 'thumbnail-2');
  context.record.thumbnailRevision = 'thumb-3';
  context.thumbnailBytes = 'thumbnail-3';
  const [third] = await syncSceneDataPlatformModelAssets(options);
  assert.equal(second.assetRevision, third.assetRevision);
  assert.notEqual(second.packagePath, third.packagePath);
  assert.equal(await fs.readFile(second.thumbnailPath!, 'utf8'), 'thumbnail-2');
  assert.equal(await fs.readFile(third.thumbnailPath!, 'utf8'), 'thumbnail-3');
  const downloads = context.downloads.length;
  const [same] = await syncSceneDataPlatformModelAssets(options);
  assert.equal(same.path, third.path);
  assert.equal(context.downloads.length, downloads);
  context.record.thumbnailUrl = null;
  const [removed] = await syncSceneDataPlatformModelAssets(options);
  assert.equal(removed.thumbnailUrl, undefined);
  assert.equal(removed.assetRevision, third.assetRevision);
  assert.equal(context.downloads.length, downloads, '中台移除缩略图无需下载文件');
}));

test('固定缩略图缺失或被修改时不返回不完整的资产描述', async () => fixture(async (context) => {
  context.record.thumbnailUrl = '/thumbnail.png';
  context.record.thumbnailRevision = 'thumb-1';
  const options = { baseUrl, sharedResourcesRoot: context.root, resources, dependencies: context.dependencies };
  const [asset] = await syncSceneDataPlatformModelAssets(options);
  await fs.rm(asset.thumbnailPath!);
  await assert.rejects(syncSceneDataPlatformModelAssets(options), /文件不完整/);
  await fs.writeFile(asset.thumbnailPath!, 'tampered');
  await assert.rejects(syncSceneDataPlatformModelAssets(options), /内容与版本不一致/);
}));


test('共享库同步后定向更新复用同修订包，远端模型和元数据变化仍重新下载', async () => fixture(async context => {
  const options = { baseUrl, sharedResourcesRoot: context.root, resources, dependencies: context.dependencies };
  await recoverDataPlatformModelAssets(options);
  const downloaded = context.downloads.length;
  const [first] = await syncSceneDataPlatformModelAssets(options);
  assert.equal(context.downloads.length, downloaded, '共享包已校验同版时不得再次下载');
  context.version = '2';
  const [second] = await syncSceneDataPlatformModelAssets(options);
  assert.ok(context.downloads.length > downloaded, '远端版本变化必须下载');
  assert.notEqual(first.assetRevision, second.assetRevision);
  context.record.metaFileUrl = '/changed-meta.json';
  const count = context.downloads.length;
  await syncSceneDataPlatformModelAssets(options);
  assert.ok(context.downloads.length > count, '元数据描述变化不能复用旧共享包');
}));


test('共享缓存复用期间远端描述变化拒绝返回旧版，损坏共享包不能绕过修订校验', async () => fixture(async context => {
  const options = { baseUrl, sharedResourcesRoot: context.root, resources, dependencies: context.dependencies };
  const [cached] = await recoverDataPlatformModelAssets(options);
  const requestJson = context.dependencies.requestJson;
  let calls = 0;
  context.dependencies.requestJson = async args => {
    if (++calls === 2) context.record.metaFileUrl = '/changed.json';
    return requestJson(args);
  };
  await assert.rejects(syncSceneDataPlatformModelAssets(options), /同步期间.*变化/);
  context.dependencies.requestJson = requestJson;
  delete context.record.metaFileUrl;
  await fs.writeFile(cached.path, 'tampered');
  await assert.rejects(syncSceneDataPlatformModelAssets(options), /内容与版本不一致/);
}));

function createMinimalSyncGlb(marker = 1): Buffer {
  const json = Buffer.from(JSON.stringify({
    asset: { version: '2.0' },
    buffers: [{ byteLength: 4 }],
    meshes: [{ primitives: [{}], extras: { marker } }],
  }), 'utf8');
  const jsonChunk = Buffer.alloc(Math.ceil(json.length / 4) * 4, 0x20);
  json.copy(jsonChunk);
  const binChunk = Buffer.alloc(4, marker);
  const body = Buffer.alloc(8 + jsonChunk.length + 8 + binChunk.length);
  body.writeUInt32LE(jsonChunk.length, 0);
  body.writeUInt32LE(0x4e4f534a, 4);
  jsonChunk.copy(body, 8);
  const binOffset = 8 + jsonChunk.length;
  body.writeUInt32LE(binChunk.length, binOffset);
  body.writeUInt32LE(0x004e4942, binOffset + 4);
  binChunk.copy(body, binOffset + 8);
  const header = Buffer.alloc(12);
  header.write('glTF', 0, 'ascii');
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(header.length + body.length, 8);
  return Buffer.concat([header, body]);
}

function createFullSyncFixtureHarness() {
  const modelId = '9007199254740995';
  const downloads: string[] = [];
  const state = {
    currentVersionId: '101',
    glbMarker: 1,
    metaObject: {
      lengthUnit: 'meter',
      dataDriven: { device: { devType: 'agv', defaultAssetCode: 'AGV-' } },
      customDocking: { offset: 1.25, tags: ['A', 'B'] },
      customFlag: true,
    } as Record<string, unknown>,
    scriptText: 'export default class CustomRuntime { onStart() {} }\n',
    metaFileUrl: '/files/meta-v1.json',
    fileUrl: '/files/device-v1.glb',
    scriptFileUrl: '/files/behavior-v1.ts',
  };
  const dependencies = {
    requestJson: async (options: { endpointPath: string; body?: unknown }) => {
      if (options.endpointPath.includes('combo-models')) {
        return { success: true, data: { records: [], total: 0, pageNum: 1, pageSize: 100 } };
      }
      const record = {
        id: modelId,
        modelName: '全链路设备',
        modelPurpose: 'SCENE',
        deviceType: 'agv',
        fileName: 'device.glb',
        fileUrl: state.fileUrl,
        metaFileUrl: state.metaFileUrl,
        currentVersionId: state.currentVersionId,
        scriptFiles: [{ fileName: 'behavior.ts', fileUrl: state.scriptFileUrl, sortOrder: 1 }],
      };
      if (options.endpointPath.endsWith('/detail')) {
        return { success: true, data: record };
      }
      const pageNum = (options.body as { pageNum?: number })?.pageNum ?? 1;
      return {
        success: true,
        data: { records: pageNum === 1 ? [record] : [], total: 1, pageNum, pageSize: 100 },
      };
    },
    downloadFile: async (options: import('../../electron/ipc/dataPlatformTransfer').DownloadRemoteFileOptions) => {
      downloads.push(options.remoteUrl);
      const bytes = options.remoteUrl === state.fileUrl
        ? createMinimalSyncGlb(state.glbMarker)
        : options.remoteUrl === state.metaFileUrl
          ? Buffer.from(JSON.stringify(state.metaObject), 'utf8')
          : Buffer.from(state.scriptText, 'utf8');
      await fs.mkdir(path.dirname(options.destinationPath), { recursive: true });
      await fs.writeFile(options.destinationPath, bytes);
      options.onBytes?.(bytes.byteLength);
      return { bytes: bytes.byteLength, contentType: 'application/octet-stream', finalUrl: options.remoteUrl, etag: null, resumedBytes: 0 };
    },
    readAssetIndex: async (editorRoot: string): Promise<import('../../electron/types').ProjectAssetIndex> => {
      try {
        return JSON.parse(await fs.readFile(path.join(editorRoot, '.babylon-editor', 'asset-index.json'), 'utf8'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 2, assets: [] };
        throw error;
      }
    },
  };
  return { modelId, downloads, state, dependencies };
}

test('全库增量同步提取、更新和删除与 dataDriven 平级的 meta.json 扩展字段并响应脚本与模型修改', async () => fixture(async (context) => {
  const harness = createFullSyncFixtureHarness();
  const assetIndexPath = path.join(context.root, '.babylon-editor', 'asset-index.json');
  const key = `model:${harness.modelId}`;

  const first = await executeDataPlatformModelSync({ baseUrl, editorRoot: context.root, dependencies: harness.dependencies });
  assert.equal(first.libraryChanged, true);
  assert.deepEqual(first.runtimeChangedResourceKeys, [key]);
  const firstAsset = JSON.parse(await fs.readFile(assetIndexPath, 'utf8')).assets[0];
  assert.equal(firstAsset.metadataSchemaVersion, MODEL_METADATA_SCHEMA_VERSION);
  assert.deepEqual(firstAsset.metaExtensions, { customDocking: { offset: 1.25, tags: ['A', 'B'] }, customFlag: true });
  assert.equal(Object.hasOwn(firstAsset.metaExtensions, 'dataDriven'), false);

  // 更新 meta 扩展字段并同步修改脚本内容，应重新同步并推进 assetRevision
  harness.state.currentVersionId = '102';
  harness.state.metaFileUrl = '/files/meta-v2.json';
  harness.state.scriptFileUrl = '/files/behavior-v2.ts';
  harness.state.metaObject = {
    lengthUnit: 'meter',
    dataDriven: { device: { devType: 'agv', defaultAssetCode: 'AGV-' } },
    customDocking: { offset: 2.5, tags: ['A', 'B'] },
    newSibling: 'hi',
  };
  harness.state.scriptText = 'export default class CustomRuntime { onStart() { /* v2 */ } }\n';
  const second = await executeDataPlatformModelSync({ baseUrl, editorRoot: context.root, dependencies: harness.dependencies });
  assert.equal(second.libraryChanged, true);
  assert.deepEqual(second.runtimeChangedResourceKeys, [key]);
  const secondAsset = JSON.parse(await fs.readFile(assetIndexPath, 'utf8')).assets[0];
  assert.notEqual(secondAsset.assetRevision, firstAsset.assetRevision);
  assert.deepEqual(secondAsset.metaExtensions, { customDocking: { offset: 2.5, tags: ['A', 'B'] }, newSibling: 'hi' });

  // 修改主模型 GLB 字节并移除全部扩展字段，应触发同步更新并清除旧扩展字段
  harness.state.currentVersionId = '103';
  harness.state.fileUrl = '/files/device-v3.glb';
  harness.state.metaFileUrl = '/files/meta-v3.json';
  harness.state.glbMarker = 9;
  harness.state.metaObject = {
    lengthUnit: 'meter',
    dataDriven: { device: { devType: 'agv', defaultAssetCode: 'AGV-' } },
  };
  const third = await executeDataPlatformModelSync({ baseUrl, editorRoot: context.root, dependencies: harness.dependencies });
  assert.equal(third.libraryChanged, true);
  assert.deepEqual(third.runtimeChangedResourceKeys, [key]);
  const thirdAsset = JSON.parse(await fs.readFile(assetIndexPath, 'utf8')).assets[0];
  assert.notEqual(thirdAsset.assetRevision, secondAsset.assetRevision);
  assert.equal(thirdAsset.metaExtensions, undefined);
}));

test('旧版无 metadataSchemaVersion 缓存免下载本地重扫扩展字段，本地磁盘被修改时重新下载恢复', async () => fixture(async (context) => {
  const harness = createFullSyncFixtureHarness();
  const assetIndexPath = path.join(context.root, '.babylon-editor', 'asset-index.json');
  const key = `model:${harness.modelId}`;

  await executeDataPlatformModelSync({ baseUrl, editorRoot: context.root, dependencies: harness.dependencies });
  const initialIndex = JSON.parse(await fs.readFile(assetIndexPath, 'utf8'));
  const legacyAsset = { ...initialIndex.assets[0] };
  delete legacyAsset.metadataSchemaVersion;
  delete legacyAsset.metaExtensions;
  await fs.writeFile(assetIndexPath, `${JSON.stringify({ version: 2, assets: [legacyAsset] }, null, 2)}\n`, 'utf8');

  harness.downloads.length = 0;
  const rescanned = await executeDataPlatformModelSync({ baseUrl, editorRoot: context.root, dependencies: harness.dependencies });
  assert.deepEqual(harness.downloads, [], '旧 schema 索引升级应本地重扫而不重复下载远端模型');
  assert.equal(rescanned.libraryChanged, true);
  assert.deepEqual(rescanned.runtimeChangedResourceKeys, [key]);
  const upgradedAsset = JSON.parse(await fs.readFile(assetIndexPath, 'utf8')).assets[0];
  assert.equal(upgradedAsset.metadataSchemaVersion, MODEL_METADATA_SCHEMA_VERSION);
  assert.deepEqual(upgradedAsset.metaExtensions, { customDocking: { offset: 1.25, tags: ['A', 'B'] }, customFlag: true });

  // 已升级到最新 schema 后再次同步，零下载且无变化
  harness.downloads.length = 0;
  const idle = await executeDataPlatformModelSync({ baseUrl, editorRoot: context.root, dependencies: harness.dependencies });
  assert.deepEqual(harness.downloads, []);
  assert.equal(idle.libraryChanged, false);
  assert.deepEqual(idle.runtimeChangedResourceKeys, []);

  // 篡改本地磁盘缓存中的 meta.json，即使远端版本指纹未变也能检出并重新下载恢复
  await fs.writeFile(upgradedAsset.metadataPath, JSON.stringify({ lengthUnit: 'meter', tampered: true }), 'utf8');
  const repaired = await executeDataPlatformModelSync({ baseUrl, editorRoot: context.root, dependencies: harness.dependencies });
  assert.ok(harness.downloads.length > 0, '本地缓存与 runtimeRevision 不一致时必须重新下载');
  assert.equal(repaired.libraryChanged, true);
  assert.deepEqual(repaired.runtimeChangedResourceKeys, [key]);
  const restoredMeta = JSON.parse(await fs.readFile(upgradedAsset.metadataPath, 'utf8')) as Record<string, unknown>;
  assert.equal(restoredMeta.tampered, undefined);
  assert.deepEqual(restoredMeta.customDocking, { offset: 1.25, tags: ['A', 'B'] });
}));

test('syncSceneDataPlatformModelAssets 走共享固定路径命中老 schema 缓存时重扫返回扩展字段且不改写共享索引', async () => fixture(async (context) => {
  const harness = createFullSyncFixtureHarness();
  const assetIndexPath = path.join(context.root, '.babylon-editor', 'asset-index.json');
  await executeDataPlatformModelSync({ baseUrl, editorRoot: context.root, dependencies: harness.dependencies });
  const initialIndex = JSON.parse(await fs.readFile(assetIndexPath, 'utf8'));
  const legacyAsset = { ...initialIndex.assets[0] };
  delete legacyAsset.metadataSchemaVersion;
  delete legacyAsset.metaExtensions;
  const legacyJson = `${JSON.stringify({ version: 2, assets: [legacyAsset] }, null, 2)}\n`;
  await fs.writeFile(assetIndexPath, legacyJson, 'utf8');

  harness.downloads.length = 0;
  const [pinned] = await syncSceneDataPlatformModelAssets({
    baseUrl,
    sharedResourcesRoot: context.root,
    resources: [{ kind: 'model', resourceId: harness.modelId }],
    libraryModelFilesOnly: true,
    dependencies: harness.dependencies,
  });
  assert.deepEqual(harness.downloads, []);
  assert.equal(pinned.metadataSchemaVersion, MODEL_METADATA_SCHEMA_VERSION);
  assert.deepEqual(pinned.metaExtensions, { customDocking: { offset: 1.25, tags: ['A', 'B'] }, customFlag: true });
  assert.equal(await fs.readFile(assetIndexPath, 'utf8'), legacyJson, '共享库索引不得被场景固定路径悄悄改写');
}));
