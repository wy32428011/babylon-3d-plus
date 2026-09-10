import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { importIsolatedTypeScriptModules } from '../helpers/extensionlessTypeScriptTestBootstrap.ts';

const [{ planSceneModelUpdates, matchSceneModelUpdates, getSceneEnvironmentUpdateReference }, { includeSceneModelPackageVariants }] = await importIsolatedTypeScriptModules<[
  typeof import('../../electron/shared/sceneModelUpdatePlan'),
  typeof import('../../electron/ipc/sceneModelPackageVariants'),
]>(['electron/shared/sceneModelUpdatePlan.ts', 'electron/ipc/sceneModelPackageVariants.ts']);
const sourceKey = 'a'.repeat(64);
const url = (file = 'model.glb', kind = 'Model', root = 'project') =>
  `editor-asset://local/${encodeURIComponent(`C:/${root}/${kind}-123-test/${file}`)}`;
const model = (sourceUrl = url()) => ({ sourceUrl, sourcePath: 'old', parameterValues: { width: 0 } });
const scene = (assets: object[]) => ({ entities: Object.fromEntries(assets.map((asset, i) => [String(i), { components: { modelAsset: asset } }])) });

test('同一新版模型包按真实包内路径展开子模型，不以主文件冒充缺失子模型', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scene-variant-test-'));
  try {
    const packagePath = path.join(root, 'Model-123-test');
    await fs.mkdir(path.join(packagePath, 'parts'), { recursive: true });
    await fs.writeFile(path.join(packagePath, 'model.glb'), 'main');
    await fs.writeFile(path.join(packagePath, 'parts/a.glb'), 'part');
    const sourceUrl = (file: string) => `editor-asset://local/${encodeURIComponent(file)}`;
    const asset = { id: 'main', name: 'main', packagePath, path: path.join(packagePath, 'model.glb'),
      sourceUrl: sourceUrl(path.join(packagePath, 'model.glb')), kind: 'model' as const, libraryKind: 'model' as const, assetRevision: 'revision-2' };
    const plan = planSceneModelUpdates(scene([model(url('parts/a.glb'))]), sourceKey);
    const expanded = await includeSceneModelPackageVariants(plan[0], [asset], new AbortController().signal);
    const replacement = matchSceneModelUpdates(plan, expanded)[0].asset;
    assert.equal(replacement.path, path.join(packagePath, 'parts/a.glb'));
    assert.equal(replacement.assetRevision, 'revision-2');
    assert.equal(asset.path, path.join(packagePath, 'model.glb'));
    const missing = planSceneModelUpdates(scene([model(url('parts/missing.glb'))]), sourceKey);
    assert.throws(() => matchSceneModelUpdates(missing, expanded), /缺失|歧义/);
    await fs.mkdir(path.join(root, 'outside'));
    await fs.writeFile(path.join(root, 'outside/escape.glb'), 'outside');
    await fs.symlink(path.join(root, 'outside'), path.join(packagePath, 'link'), 'junction');
    const escaping = planSceneModelUpdates(scene([model(url('link/escape.glb'))]), sourceKey);
    await assert.rejects(includeSceneModelPackageVariants(escaping[0], [asset], new AbortController().signal), /包内/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('全部已存在快照也参与最新版查询，重复实例与点击绑定按资源去重', () => {
  const document = scene([model(), model(url('model.glb', 'Model', 'shared'))]);
  document.entities.binding = { components: { clickEventBinding: { deviceSlots: [{ deviceType: model() }] } } } as never;
  const before = structuredClone(document);
  const plan = planSceneModelUpdates(document, sourceKey);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].resourceId, '123');
  assert.equal(plan[0].sourceUrls.length, 2);
  assert.deepEqual(document, before);
});

test('普通模型与组合模型 ID 相同时分开同步，纯本地模型保留', () => {
  const plan = planSceneModelUpdates(scene([model(), model(url('model.glb', 'Combo')), model('editor-asset://local/C%3A%2Flocal.glb')]), sourceKey);
  assert.deepEqual(plan.map(p => p.kind), ['model', 'combo']);
});

test('拒绝跨来源；同资源多个包内变体按路径分别匹配', () => {
  assert.throws(() => planSceneModelUpdates(scene([{ ...model(), dataPlatformModel: {
    sourceKey: 'b'.repeat(64), kind: 'model', resourceId: '123', modelPath: 'model.glb',
  } }]), sourceKey), /来源/);
  const plan = planSceneModelUpdates(scene([model(), model(url('parts/another.glb'))]), sourceKey);
  assert.equal(plan.length, 1);
  const main = { sourceUrl: url() }, part = { sourceUrl: url('parts/another.glb') };
  assert.deepEqual(matchSceneModelUpdates(plan, [main, part]), [
    { sourceUrls: [url()], asset: main }, { sourceUrls: [part.sourceUrl], asset: part },
  ]);
});

test('当前中台场景允许明确重绑来源，但仍要求资源类型、ID 和包内引用一致', () => {
  const asset = { ...model(), dataPlatformModel: {
    sourceKey: 'b'.repeat(64), kind: 'model', resourceId: '123', modelPath: 'model.glb',
  } };
  assert.equal(planSceneModelUpdates(scene([asset]), sourceKey, { allowSourceRebind: true })[0].resourceId, '123');
  assert.throws(() => planSceneModelUpdates(scene([{ ...asset, dataPlatformModel: { ...asset.dataPlatformModel, resourceId: '456' } }]),
    sourceKey, { allowSourceRebind: true }), /身份.*引用/);
});

test('局部身份冲突保留该资源全部引用，其它资源仍可计划更新', () => {
  const issues: Array<{ resourceKind: string; resourceId?: string; message: string }> = [];
  const document = scene([model(), { ...model(url('parts/a.glb')), dataPlatformModel: {
    sourceKey, kind: 'model', resourceId: '999', modelPath: 'parts/a.glb',
  } }, model(url()), model(url().replace('123', '456'))]);
  const before = structuredClone(document);
  const plan = planSceneModelUpdates(document, sourceKey, { allowSourceRebind: true, onIssue: issue => issues.push(issue) });
  assert.deepEqual(plan.map(item => item.resourceId), ['456']);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].resourceId, '123');
  assert.match(issues[0].message, /身份/);
  assert.deepEqual(document, before);
});

test('非法受管引用不能退回按名称或其他模型猜测', () => {
  assert.throws(() => planSceneModelUpdates(scene([model('editor-asset://local/Model-123-test%2F..%2Fmodel.glb')]), sourceKey), /身份|引用/);
});

test('间接模板参与同步，包内子模型不能替换为新主模型', () => {
  const document = { entities: { generator: { components: { modelGenerator: { defaultTarget: { kind: 'model', modelAsset: model(url('parts/a.glb')) } } } } } };
  const plan = planSceneModelUpdates(document, sourceKey);
  assert.equal(plan.length, 1);
  assert.throws(() => matchSceneModelUpdates(plan, [{ path: 'new', sourceUrl: url(), kind: 'model', libraryKind: 'model' }]), /包内|变体/);
});

test('明确单一主模型改名后，所有旧 URL 得到同一个新资源', () => {
  const plan = planSceneModelUpdates(scene([model()]), sourceKey);
  const asset = { path: 'new', sourceUrl: url('renamed.glb'), kind: 'model', libraryKind: 'model' };
  assert.deepEqual(matchSceneModelUpdates(plan, [asset]), [{ sourceUrls: [url()], asset }]);
});

test('旧中台环境必须有唯一身份，明确 Env-ID 路径可恢复，本地环境不替换', () => {
  const document = (environment: unknown) => ({ sceneSettings: { environment } });
  assert.throws(() => getSceneEnvironmentUpdateReference(document({ source: 'data-platform', packagePath: 'C:/old/unknown' })), /身份/);
  assert.deepEqual(getSceneEnvironmentUpdateReference(document({ packagePath: 'C:/Assets/Environments/Env-123-campus' })), { resourceId: '123' });
  assert.equal(getSceneEnvironmentUpdateReference(document({ packagePath: 'C:/local/scene.glb' })), undefined);
});


test('未绑定主动同步要求来源身份，缺失身份阻止整个资源组，同源身份可更新', () => {
  const identified = { ...model(), dataPlatformModel: { sourceKey, kind: 'model', resourceId: '123', modelPath: 'model.glb' } };
  const issues: Array<{ resourceId?: string }> = [];
  assert.deepEqual(planSceneModelUpdates(scene([identified, model(url('model.glb', 'Model', 'unidentified'))]), sourceKey,
    { requireSourceIdentity: true, onIssue: issue => issues.push(issue) }), []);
  assert.equal(issues[0].resourceId, '123');
  assert.equal(planSceneModelUpdates(scene([identified]), sourceKey, { requireSourceIdentity: true }).length, 1);
  assert.equal(planSceneModelUpdates(scene([model()]), sourceKey).length, 1, '已绑定旧场景兼容逻辑不变');
});


test('未绑定点击设备可复用同URL明确身份，但不同URL或冲突身份不能推断同源', () => {
  const identified = { ...model(), dataPlatformModel: { sourceKey, kind: 'model', resourceId: '123', modelPath: 'model.glb' } };
  const document = (device: object, extra: object[] = []) => ({ ...scene([identified, ...extra]),
    entities: { ...scene([identified, ...extra]).entities,
      click: { components: { clickEventBinding: { deviceSlots: [{ deviceType: device }] } } } } });
  assert.equal(planSceneModelUpdates(document(model()), sourceKey, { requireSourceIdentity: true }).length, 1);
  assert.throws(() => planSceneModelUpdates(document(model(url('model.glb', 'Model', 'different'))), sourceKey,
    { requireSourceIdentity: true }), /来源身份/);
  assert.throws(() => planSceneModelUpdates(document(model(), [{ ...identified,
    dataPlatformModel: { ...identified.dataPlatformModel, sourceKey: 'b'.repeat(64) } }]), sourceKey,
    { requireSourceIdentity: true }), /来源/);
  const conflicts: Array<{ resourceId?: string }> = [];
  assert.deepEqual(planSceneModelUpdates(document(model(), [{ ...identified,
    dataPlatformModel: { ...identified.dataPlatformModel, resourceId: '456' } }]), sourceKey,
    { requireSourceIdentity: true, onIssue: issue => conflicts.push(issue) }), []);
  assert.equal(conflicts[0].resourceId, '123');
});


test('千个同URL实例复用来源证明并去重，末尾冲突仍阻止整个资源组', () => {
  const identified = { ...model(), dataPlatformModel: { sourceKey, kind: 'model', resourceId: '123', modelPath: 'model.glb' } };
  const repeated = Array.from({ length: 1000 }, () => structuredClone(identified));
  const plan = planSceneModelUpdates(scene([...repeated, model()]), sourceKey, { requireSourceIdentity: true });
  assert.equal(plan.length, 1);
  assert.deepEqual(plan[0].sourceUrls, [identified.sourceUrl]);
  const issues: Array<{ resourceId?: string }> = [];
  assert.deepEqual(planSceneModelUpdates(scene([...repeated, { ...identified,
    dataPlatformModel: { ...identified.dataPlatformModel, sourceKey: 'b'.repeat(64) } }, model()]), sourceKey,
    { requireSourceIdentity: true, onIssue: issue => issues.push(issue) }), []);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].resourceId, '123');
});
