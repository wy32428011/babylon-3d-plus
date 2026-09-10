import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createServer } from 'node:http';
import { registerHooks } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import { after, test, type TestContext } from 'node:test';
import { importIsolatedTypeScriptModules } from '../helpers/extensionlessTypeScriptTestBootstrap.ts';

const shim = `export const app={getPath(){throw Error('profile access forbidden')}};export const dialog={};
export const BrowserWindow={getAllWindows:()=>[]};export const net={fetch:(...args)=>globalThis.fetch(...args)};`;
const hooks = registerHooks({ resolve(specifier, context, next) { return specifier === 'electron'
  ? { url: `data:text/javascript,${encodeURIComponent(shim)}`, shortCircuit: true } : next(specifier, context); } });
let cleanup: (() => void) | undefined;
after(() => { hooks.deregister(); cleanup?.(); });
const [identity, sync, registry, ordinaryRecovery] = await importIsolatedTypeScriptModules<[
  typeof import('../../electron/ipc/digitalTwinPublishResourceIdentity'), typeof import('../../electron/ipc/dataPlatformModelIncrementalSync'),
  typeof import('../../electron/ipc/assetRegistry'), typeof import('../../electron/ipc/digitalTwinModelRecovery'),
]>(['electron/ipc/digitalTwinPublishResourceIdentity.ts', 'electron/ipc/dataPlatformModelIncrementalSync.ts',
  'electron/ipc/assetRegistry.ts', 'electron/ipc/digitalTwinModelRecovery.ts'],
  { deferCleanup: remove => { cleanup = remove; } });

const revision = 'a'.repeat(64);
const model = (id: string, kind = 'model', sourceRevision = revision) => ({
  sourcePath: `C:/old/Assets/Models/${kind === 'combo' ? 'Combo' : 'Model'}-${id}-模型/model.glb`,
  sourceUrl: `editor-asset://local/${encodeURIComponent(`C:/old/Assets/Models/${kind === 'combo' ? 'Combo' : 'Model'}-${id}-模型/model.glb`)}`,
  assetRevision: sourceRevision, parameterValues: { height: 6, disabled: false },
});
const content = (items: Array<{ id: string; name?: string; kind?: string; sourceRevision?: string }>) => JSON.stringify({ version: 5,
  scene: { name: '测试工厂', entities: Object.fromEntries(items.map((item, index) => [`e${index}`, { name: item.name ?? `设备${item.id}`,
    components: { modelAsset: model(item.id, item.kind, item.sourceRevision) } }])) } });
const glb = () => {
  const json = Buffer.from(JSON.stringify({ asset: { version: '2.0' }, meshes: [{ primitives: [{}] }] }));
  const body = Buffer.alloc(Math.ceil(json.length / 4) * 4, 32); json.copy(body);
  const header = Buffer.alloc(20); header.write('glTF'); header.writeUInt32LE(2, 4); header.writeUInt32LE(body.length + 20, 8);
  header.writeUInt32LE(body.length, 12); header.writeUInt32LE(0x4e4f534a, 16); return Buffer.concat([header, body]);
};

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'publish-resource-identity-'));
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const records = new Map<string, any>();
  const calls: Array<{ kind: string; id?: string; path: string }> = [];
  let active = 0, peak = 0;
  const bytes = glb();
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const url = req.url ?? '';
    if (url === '/model.glb') { calls.push({ kind: 'file', path: url }); res.writeHead(200, { 'Content-Type': 'model/gltf-binary', 'Content-Length': bytes.length }); res.end(bytes); return; }
    if (url === '/model.ts') { calls.push({ kind: 'file', path: url }); res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('export default class OriginalModel {}'); return; }
    const kind = url.includes('/combo-models/') ? 'combo' : url.includes('/env-models/') ? 'environment' : 'model';
    const id = JSON.parse(body).id; calls.push({ kind, id, path: url }); active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 15)); active--;
    const value = records.get(`${kind}:${id}`);
    if (value?.httpStatus) { res.writeHead(value.httpStatus, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ code: value.code, message: value.message })); return; }
    res.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' });
    res.end(JSON.stringify(value ?? { success: true, data: { id, modelName: `模型${id}`, fileName: 'model.glb', fileUrl: '/model.glb', revision: '1' } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const context = { baseUrl, workspaceRoot: root, sharedResourcesRoot: path.join(root, 'SharedResources'), projectRoot: path.join(root, 'project') };
  await fs.mkdir(context.sharedResourcesRoot); await fs.mkdir(context.projectRoot);
  const writeMappings = async (entries: unknown[]) => {
    const directory = path.join(root, '.babylon-editor'); await fs.mkdir(directory, { recursive: true });
    const file = path.join(directory, 'publish-resource-mappings.json');
    await fs.writeFile(file, JSON.stringify({ version: 1, entries })); return file;
  };
  return { root, context, baseUrl, records, calls, bytes, peak: () => peak, writeMappings,
    entry: (overrides: object = {}) => ({ targetBaseUrl: `${baseUrl}/`, sourceBaseUrl: 'http://old.example:8086', kind: 'model',
      sourceId: '11', sourceRevision: revision, targetId: '101', targetRevision: revision, ...overrides }) };
}

test('三类身份分开查询、跨场景去重并限制为四并发，全过程无模型下载', async t => {
  const f = await fixture(t); const normal = content(Array.from({ length: 8 }, (_, index) => ({ id: String(index + 11) })));
  const extra = JSON.stringify({ version: 5, scene: { entities: { combo: { name: '组合设备', components: { modelAsset: model('11', 'combo') } } },
    sceneSettings: { environment: { source: 'data-platform', resourceType: 'ENV_MODEL', dataPlatformResourceId: '11' } } } });
  await identity.assertPublishResourceIdentities([normal, normal, extra], `${f.baseUrl}/`, new AbortController().signal);
  assert.equal(f.calls.length, 10); assert.equal(f.peak(), 4);
  assert.ok(f.calls.some(call => call.kind === 'combo' && call.id === '11'));
  assert.ok(f.calls.some(call => call.kind === 'environment' && call.id === '11'));
  assert.ok(!f.calls.some(call => call.kind === 'file'));
});

test('汇总真正缺失与实体名称，网络异常和响应身份错配单独诊断', async t => {
  const f = await fixture(t);
  f.records.set('model:11', { success: false, code: 'MODEL_NOT_FOUND', message: '模型不存在' });
  f.records.set('model:12', { httpStatus: 503, message: 'service unavailable' });
  f.records.set('combo:13', { success: true, data: { id: '999' } });
  await assert.rejects(identity.assertPublishResourceIdentities([content([
    { id: '11', name: '新能源货架' }, { id: '12', name: '输送线' }, { id: '13', kind: 'combo', name: '组合站台' },
  ])], f.baseUrl, new AbortController().signal), error => {
    assert.match(String(error), /11.*新能源货架|新能源货架.*11/);
    assert.match(String(error), /不存在|未找到/); assert.match(String(error), /503/);
    assert.match(String(error), /身份.*不匹配|ID.*不匹配/); assert.match(String(error), /组合站台/);
    return true;
  });
  assert.equal(f.calls.length, 3);
});

test('HTTP400业务MODEL_NOT_FOUND准确判缺失，同样中文提示的权限或网络错误不能误判', async t => {
  const f = await fixture(t);
  f.records.set('model:11', { httpStatus: 400, code: 'MODEL_NOT_FOUND', message: '模型不存在' });
  f.records.set('model:12', { httpStatus: 403, code: 'FORBIDDEN', message: '模型不存在' });
  f.records.set('model:13', { httpStatus: 503, code: 'SERVICE_UNAVAILABLE', message: '模型不存在' });
  f.records.set('model:14', { success: false, code: 'FORBIDDEN', message: '模型不存在' });
  await assert.rejects(identity.assertPublishResourceIdentities([content([{ id: '11' }, { id: '12' }, { id: '13' }, { id: '14' }])],
    f.baseUrl, new AbortController().signal), (error: any) => {
    const reasons = new Map(error.issues.map((issue: any) => [issue.id, issue.reason]));
    assert.equal(reasons.get('11'), 'missing');
    for (const id of ['12', '13', '14']) assert.equal(reasons.get(id), 'query-failed');
    return true;
  });
});

test('映射文件缺失或sourceRevision不匹配时不按ID或同名推断，不发目标查询', async t => {
  const f = await fixture(t), sceneContent = content([{ id: '11', name: '与目标同名' }]);
  assert.deepEqual(await identity.resolvePublishModelIdentityReplacements(sceneContent, f.context, new AbortController().signal), { replacements: [] });
  await f.writeMappings([f.entry({ sourceRevision: 'b'.repeat(64) })]);
  assert.deepEqual(await identity.resolvePublishModelIdentityReplacements(sceneContent, f.context, new AbortController().signal), { replacements: [] });
  assert.deepEqual(await identity.resolvePublishModelIdentityReplacements(content([{ id: '11', sourceRevision: 'timestamp' }]), f.context, new AbortController().signal), { replacements: [] });
  assert.equal(f.calls.length, 0);
  await f.writeMappings([f.entry({ targetBaseUrl: 'http://another.example:8086' })]);
  assert.deepEqual(await identity.resolvePublishModelIdentityReplacements(sceneContent, f.context, new AbortController().signal), { replacements: [] });
  assert.equal(f.calls.length, 0);
});

test('映射严格校验未知字段、冲突重复及非法ID，不能静默接受坏配置', async t => {
  const f = await fixture(t);
  for (const entries of [ [f.entry({ extra: true })], [f.entry(), f.entry({ targetId: '102' })], [f.entry({ targetId: '../101' })] ]) {
    await f.writeMappings(entries);
    await assert.rejects(identity.resolvePublishModelIdentityReplacements(content([{ id: '11' }]), f.context, new AbortController().signal), /映射/);
  }
  assert.equal(f.calls.length, 0);
});

test('精确映射验证目标身份及下载内容版本后返回替换，不改输入场景或映射文件', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.root, 'seed'));
  const [seed] = await sync.syncSceneDataPlatformModelAssets({ baseUrl: f.baseUrl, sharedResourcesRoot: path.join(f.root, 'seed'),
    resources: [{ kind: 'model', resourceId: '101' }], signal: new AbortController().signal });
  assert.ok(seed.assetRevision);
  const mapFile = await f.writeMappings([f.entry({ targetRevision: seed.assetRevision })]);
  const before = await fs.readFile(mapFile, 'utf8'); f.calls.length = 0;
  const sceneContent = content([{ id: '11', name: '新能源货架' }, { id: '11', name: '副本' }]);
  const result = await identity.resolvePublishModelIdentityReplacements(sceneContent, f.context, new AbortController().signal);
  assert.equal(result.replacements.length, 1); assert.equal(result.replacements[0].sourceUrls.length, 1);
  assert.equal(result.replacements[0].asset.dataPlatformResourceId, '101');
  assert.equal(result.replacements[0].asset.assetRevision, seed.assetRevision);
  assert.deepEqual(await fs.readFile(result.replacements[0].asset.path), f.bytes);
  assert.ok(f.calls.every(call => !call.id || call.id === '101'));
  assert.equal(f.calls.filter(call => call.kind === 'file').length, 1);
  assert.equal(await fs.readFile(mapFile, 'utf8'), before);
  assert.equal(JSON.parse(sceneContent).scene.entities.e0.components.modelAsset.parameterValues.height, 6);
  const asset = result.replacements[0].asset;
  for (const file of [asset.path, asset.metadataPath, ...(asset.scriptPaths ?? []), asset.thumbnailPath]) {
    if (file) assert.ok(registry.isAuthorizedAssetFile(file), `身份恢复后的文件必须登记运行时读取权限：${file}`);
  }
  const mappedContent = JSON.stringify({ version: 5, scene: { entities: { mapped: { name: '迁移后模型', components: {
    modelAsset: { sourcePath: asset.path, sourceUrl: asset.sourceUrl, assetRevision: asset.assetRevision,
      packagePath: asset.packagePath, metadataPath: asset.metadataPath, scriptAssets: asset.scriptAssets, scriptPaths: asset.scriptPaths },
  } } } } });
  const beforeOrdinary = f.calls.length;
  await ordinaryRecovery.assertPublishSceneModelsReady(mappedContent, new AbortController().signal, f.context);
  assert.deepEqual(await ordinaryRecovery.recoverPublishSceneModels(mappedContent, async () => f.context,
    new AbortController().signal, () => {}), { replacements: [] });
  assert.equal(f.calls.length, beforeOrdinary, '后续常规模型恢复不得因缺少授权再次下载已校验的映射包');
});

test('目标不存在或服务端广告的内容版本变化时阻止下载', async t => {
  const f = await fixture(t); await f.writeMappings([f.entry()]);
  f.records.set('model:101', { success: false, code: 'MODEL_NOT_FOUND', message: '目标模型不存在' });
  await assert.rejects(identity.resolvePublishModelIdentityReplacements(content([{ id: '11' }]), f.context, new AbortController().signal), /101.*不存在|不存在.*101/);
  f.records.set('model:101', { success: true, data: { id: '101', runtimeRevision: 'b'.repeat(64) } });
  await assert.rejects(identity.resolvePublishModelIdentityReplacements(content([{ id: '11' }]), f.context, new AbortController().signal), /版本|修订/);
  assert.ok(!f.calls.some(call => call.kind === 'file'));
});

test('同URL整组替换不能顺带修改没有精确sourceRevision的实例', async t => {
  const f = await fixture(t); await f.writeMappings([f.entry()]);
  await assert.rejects(identity.resolvePublishModelIdentityReplacements(content([
    { id: '11' }, { id: '11', sourceRevision: 'unknown' },
  ]), f.context, new AbortController().signal), /同一模型 URL|来源修订|sourceRevision/);
  assert.equal(f.calls.length, 0);
});

test('目标未广告内容指纹时仍验证下载后的实际修订，失配不返回可应用结果', async t => {
  const f = await fixture(t); await f.writeMappings([f.entry({ targetRevision: 'f'.repeat(64) })]);
  await assert.rejects(identity.resolvePublishModelIdentityReplacements(content([{ id: '11' }]), f.context, new AbortController().signal), /下载后的内容修订/);
  assert.equal(f.calls.filter(call => call.kind === 'file').length, 1);
});

test('可读原包的脚本被本地修改但sourceRevision未刷新时，拒绝覆盖且不查询目标', async t => {
  const f = await fixture(t);
  f.records.set('model:11', { success: true, data: { id: '11', modelName: '原模型', fileName: 'model.glb', fileUrl: '/model.glb',
    scriptFileName: 'model.ts', scriptFileUrl: '/model.ts', revision: '1' } });
  const [source] = await sync.syncSceneDataPlatformModelAssets({ baseUrl: f.baseUrl, sharedResourcesRoot: f.context.sharedResourcesRoot,
    resources: [{ kind: 'model', resourceId: '11' }], signal: new AbortController().signal });
  assert.ok(source.assetRevision && source.scriptPaths?.length);
  registry.authorizeAssetRoot(source.packagePath!);
  await f.writeMappings([f.entry({ sourceRevision: source.assetRevision })]);
  const sourceScene = JSON.parse(content([{ id: '11', sourceRevision: source.assetRevision }]));
  Object.assign(sourceScene.scene.entities.e0.components.modelAsset, { sourcePath: source.path, sourceUrl: source.sourceUrl,
    scriptAssets: source.scriptAssets });
  await fs.writeFile(source.scriptPaths![0], 'export default class LocallyChangedModel {}');
  f.calls.length = 0;
  await assert.rejects(identity.resolvePublishModelIdentityReplacements(JSON.stringify(sourceScene), f.context,
    new AbortController().signal), /原模型|来源模型|sourceRevision/);
  assert.equal(f.calls.length, 0);
  assert.equal(await fs.readFile(source.scriptPaths![0], 'utf8'), 'export default class LocallyChangedModel {}');
});

test('取消先于查询生效，不能伪装为模型不存在', async t => {
  const f = await fixture(t); const controller = new AbortController(); controller.abort();
  await assert.rejects(identity.assertPublishResourceIdentities([content([{ id: '11' }])], f.baseUrl, controller.signal), /abort|取消/i);
  assert.equal(f.calls.length, 0);
});
