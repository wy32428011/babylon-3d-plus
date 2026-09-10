import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createServer } from 'node:http';
import { registerHooks } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { after, test, type TestContext } from 'node:test';
import { importIsolatedTypeScriptModules } from '../helpers/extensionlessTypeScriptTestBootstrap.ts';

const shim = `export const app={getPath(){throw Error('unexpected profile access')}};export const dialog={};
export const BrowserWindow={getAllWindows:()=>[]};export const net={fetch:(...args)=>globalThis.fetch(...args)};`;
const hook = registerHooks({ resolve(specifier, context, next) { return specifier === 'electron'
  ? { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(shim)}` } : next(specifier, context); } });
let cleanup: (() => void) | undefined;
after(() => { hook.deregister(); cleanup?.(); });
const [recovery, registry, revisions] = await importIsolatedTypeScriptModules<[
  typeof import('../../electron/ipc/digitalTwinModelRecovery'), typeof import('../../electron/ipc/assetRegistry'),
  typeof import('../../electron/ipc/dataPlatformModelIndex'),
]>(['electron/ipc/digitalTwinModelRecovery.ts', 'electron/ipc/assetRegistry.ts', 'electron/ipc/dataPlatformModelIndex.ts'],
  { deferCleanup: remove => { cleanup = remove; } });

const glb = () => {
  const json = Buffer.from(JSON.stringify({ asset: { version: '2.0' }, meshes: [{ primitives: [{}] }], scenes: [{ nodes: [] }], scene: 0 }));
  const body = Buffer.alloc(Math.ceil(json.length / 4) * 4, 32); json.copy(body);
  const header = Buffer.alloc(20); header.write('glTF'); header.writeUInt32LE(2, 4);
  header.writeUInt32LE(20 + body.length, 8); header.writeUInt32LE(body.length, 12); header.writeUInt32LE(0x4e4f534a, 16);
  return Buffer.concat([header, body]);
};
async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'publish-model-package-'));
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, 'project'), sharedResourcesRoot = path.join(root, 'SharedResources');
  await fs.mkdir(projectRoot); await fs.mkdir(sharedResourcesRoot);
  registry.authorizeAssetRoot(projectRoot); registry.authorizeAssetRoot(sharedResourcesRoot);
  const writePackage = async (base: string) => {
    const packagePath = path.join(base, 'Assets/Models/Model-12-test'); await fs.mkdir(packagePath, { recursive: true });
    const sourcePath = path.join(packagePath, 'model.glb'), metadataPath = path.join(packagePath, 'meta.json');
    await fs.writeFile(sourcePath, glb()); await fs.writeFile(metadataPath, '{"lengthUnit":"meter"}');
    const hash = await revisions.createDataPlatformModelRuntimeRevision({ modelPath: sourcePath, metadataPath, scriptPaths: [] });
    return { sourcePath, sourceUrl: registry.encodeAssetUrl(sourcePath), packagePath, assetRevision: hash.runtimeRevision };
  };
  const signal = new AbortController().signal;
  return { root, scope: { projectRoot, sharedResourcesRoot }, writePackage, signal };
}
const scene = (asset: object, target?: object) => ({ version: 5, scene: { entities: {
  main: { components: { modelAsset: asset } },
  ...(target ? { generator: { components: { modelGenerator: { defaultTarget: { kind: 'model', ...target, modelAsset: { ...asset } }, rules: [] } } } } : {}),
} } });

test('同一可用主文件之外的旧生成器包目录被识别，并在不下载新版本的情况下返回完整同版替换', async t => {
  const f = await fixture(t), asset = await f.writePackage(f.scope.sharedResourcesRoot);
  const document = scene(asset, { packagePath: path.join(f.root, 'old-missing'), thumbnailUrl: registry.encodeAssetUrl(path.join(f.root, 'old.png')) });
  await assert.rejects(recovery.assertPublishSceneModelsReady(JSON.stringify(document), f.signal, f.scope), /缺失|恢复/);
  const result = await recovery.recoverPublishSceneModels(JSON.stringify(document), async () => ({ ...f.scope, baseUrl: 'http://127.0.0.1:1' }), f.signal, () => {});
  assert.equal(result.replacements.length, 1);
  assert.deepEqual(result.replacements[0].sourceUrls, [asset.sourceUrl]);
  assert.equal(result.replacements[0].asset.packagePath, asset.packagePath);
  assert.equal(result.replacements[0].asset.assetRevision, asset.assetRevision);
  assert.equal(result.replacements[0].asset.path, asset.sourcePath);
  assert.equal(result.replacements[0].asset.metadataPath, path.join(asset.packagePath, 'meta.json'));
});

test('当前受管模型没有缺失时不产生替换，跨工作区可读文件不能冒充 SOURCE 就绪', async t => {
  const f = await fixture(t), valid = await f.writePackage(f.scope.projectRoot);
  const content = JSON.stringify(scene(valid));
  await recovery.assertPublishSceneModelsReady(content, f.signal, f.scope);
  assert.deepEqual((await recovery.recoverPublishSceneModels(content, async () => ({ ...f.scope, baseUrl: 'http://127.0.0.1:1' }), f.signal, () => {})).replacements, []);
  const external = await f.writePackage(path.join(f.root, 'another-workspace'));
  registry.authorizeAssetFile(external.sourcePath);
  await assert.rejects(recovery.assertPublishSceneModelsReady(JSON.stringify(scene(external)), f.signal, f.scope), /缺失|恢复/);
});

test('SOURCE 的旧工作区兼容范围只包含 Assets，不能放行工作区其它目录', async t => {
  const f = await fixture(t), legacyWorkspaceRoot = path.join(f.root, 'legacy');
  const legacy = await f.writePackage(legacyWorkspaceRoot);
  const privateAsset = await f.writePackage(path.join(legacyWorkspaceRoot, '.private'));
  registry.authorizeAssetRoot(legacyWorkspaceRoot);
  const scope = { ...f.scope, legacyWorkspaceRoot };
  await recovery.assertPublishSceneModelsReady(JSON.stringify(scene(legacy)), f.signal, scope);
  const result = await recovery.recoverPublishSceneModels(JSON.stringify(scene(legacy)), async () => ({ ...scope, baseUrl: 'http://127.0.0.1:1' }), f.signal, () => {});
  assert.deepEqual(result.replacements, []);
  await assert.rejects(recovery.assertPublishSceneModelsReady(JSON.stringify(scene(privateAsset)), f.signal, scope), /缺失|恢复/);
});

test('跨工作区资源按稳定 ID 直接从中台补全到当前 shared，原文件不被改写', async t => {
  const f = await fixture(t), external = await f.writePackage(path.join(f.root, 'external'));
  registry.authorizeAssetFile(external.sourcePath);
  const bytes = glb(), requests: string[] = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk; const url = req.url ?? ''; requests.push(url);
    if (url === '/api/v1/models/detail') {
      assert.equal(JSON.parse(body).id, '12'); res.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' });
      res.end(JSON.stringify({ success: true, data: { id: '12', modelName: 'test', fileName: 'model.glb', fileUrl: '/model.glb', revision: '1' } }));
    } else if (url === '/model.glb') {
      res.writeHead(200, { 'Content-Type': 'model/gltf-binary', 'Content-Length': bytes.length, Connection: 'close' }); res.end(bytes);
    } else { res.writeHead(404); res.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const result = await recovery.recoverPublishSceneModels(JSON.stringify(scene(external)), async () => ({ ...f.scope,
    baseUrl: `http://127.0.0.1:${address.port}` }), f.signal, () => {});
  assert.equal(result.replacements.length, 1);
  assert.deepEqual(requests, ['/api/v1/models/detail', '/model.glb']);
  assert.ok(result.replacements[0].asset.path.startsWith(f.scope.sharedResourcesRoot + path.sep));
  assert.deepEqual(await fs.readFile(result.replacements[0].asset.path), bytes);
  assert.deepEqual(await fs.readFile(external.sourcePath), bytes);
});
