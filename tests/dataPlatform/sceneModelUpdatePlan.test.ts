import assert from 'node:assert/strict';
import test from 'node:test';
import { importIsolatedTypeScriptModules } from '../helpers/extensionlessTypeScriptTestBootstrap.ts';

const [{ planSceneModelUpdates, matchSceneModelUpdates, getSceneEnvironmentUpdateReference }] = await importIsolatedTypeScriptModules<[
  typeof import('../../electron/shared/sceneModelUpdatePlan'),
]>(['electron/shared/sceneModelUpdatePlan.ts']);
const sourceKey = 'a'.repeat(64);
const url = (file = 'model.glb', kind = 'Model', root = 'project') =>
  `editor-asset://local/${encodeURIComponent(`C:/${root}/${kind}-123-test/${file}`)}`;
const model = (sourceUrl = url()) => ({ sourceUrl, sourcePath: 'old', parameterValues: { width: 0 } });
const scene = (assets: object[]) => ({ entities: Object.fromEntries(assets.map((asset, i) => [String(i), { components: { modelAsset: asset } }])) });

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

test('拒绝跨来源与同资源多个包内变体，避免错误替换', () => {
  assert.throws(() => planSceneModelUpdates(scene([{ ...model(), dataPlatformModel: {
    sourceKey: 'b'.repeat(64), kind: 'model', resourceId: '123', modelPath: 'model.glb',
  } }]), sourceKey), /来源/);
  assert.throws(() => planSceneModelUpdates(scene([model(), model(url('parts/another.glb'))]), sourceKey), /多个|变体/);
});

test('当前中台场景允许明确重绑来源，但仍要求资源类型、ID 和包内引用一致', () => {
  const asset = { ...model(), dataPlatformModel: {
    sourceKey: 'b'.repeat(64), kind: 'model', resourceId: '123', modelPath: 'model.glb',
  } };
  assert.equal(planSceneModelUpdates(scene([asset]), sourceKey, { allowSourceRebind: true })[0].resourceId, '123');
  assert.throws(() => planSceneModelUpdates(scene([{ ...asset, dataPlatformModel: { ...asset.dataPlatformModel, resourceId: '456' } }]),
    sourceKey, { allowSourceRebind: true }), /身份.*引用/);
});

test('局部身份或变体冲突保留该资源全部引用，其它资源仍可计划更新', () => {
  const issues: Array<{ resourceKind: string; resourceId?: string; message: string }> = [];
  const document = scene([model(), model(url('parts/a.glb')), model(url()), model(url().replace('123', '456'))]);
  const before = structuredClone(document);
  const plan = planSceneModelUpdates(document, sourceKey, { allowSourceRebind: true, onIssue: issue => issues.push(issue) });
  assert.deepEqual(plan.map(item => item.resourceId), ['456']);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].resourceId, '123');
  assert.match(issues[0].message, /变体/);
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
