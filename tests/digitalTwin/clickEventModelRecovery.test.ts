import assert from 'node:assert/strict';
import test from 'node:test';
import { importIsolatedTypeScriptModules } from '../helpers/extensionlessTypeScriptTestBootstrap.ts';
const [{ planPublishModelRecovery }] = await importIsolatedTypeScriptModules<[
  typeof import('../../electron/shared/publishModelRecovery'),
]>(['electron/shared/publishModelRecovery.ts']);

const url = (root: string, id = '12') => `editor-asset://local/${encodeURIComponent(`${root}/Model-${id}-双立柱堆垛机/model.glb`)}`;
const model = (sourceUrl: string) => ({ sourceUrl, sourcePath: decodeURIComponent(sourceUrl.slice('editor-asset://local/'.length)) });
const scene = (models: object[], devices: object[]) => ({ entities: Object.fromEntries([
  ...models.map((asset, index) => [`model-${index}`, { components: { modelAsset: asset } }]),
  ['binding', { components: { clickEventBinding: { deviceSlots: devices.map((deviceType, index) => ({ id: `${index}`, deviceType })) } } }],
]) });

test('已有工程快照时不下载共享库引用，也不增加实例', async () => {
  const document = scene([model(url('project'))], [model(url('shared'))]);
  assert.deepEqual(await planPublishModelRecovery(document, async () => true), []);
});

test('仅有绑定的缺失模型必须加入拉取计划，同一资源去重', async () => {
  const document = scene([], [model(url('shared')), model(url('old'))]);
  const plan = await planPublishModelRecovery(document, async () => true);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].resourceId, '12');
  assert.deepEqual(plan[0].sourceUrls, [url('shared'), url('old')]);
});

test('已有实例的文件丢失时恢复资源，包含生成器和报警模型', async () => {
  const document = scene([model(url('project'))], [model(url('shared'))]);
  Object.assign(document.entities, {
    generator: { components: { modelGenerator: { defaultTarget: { kind: 'model', modelAsset: model(url('project', '13')) }, rules: [] } } },
    alarm: { components: { alarmManager: { appearanceModel: { kind: 'model', modelAsset: model(url('project', '14')) }, targets: [] } } },
  });
  assert.deepEqual((await planPublishModelRecovery(document, async () => false)).map((entry) => entry.resourceId), ['12', '13', '14']);
});

test('非中台缺失模型不按名称猜测，非法 URL 不进入远程恢复', async () => {
  await assert.rejects(planPublishModelRecovery(scene([], [model('editor-asset://local/C%3A%2Fmanual.glb')]), async () => false), /无法识别数据中台模型/);
  await assert.rejects(planPublishModelRecovery(scene([], [{ sourceUrl: 'https://example.com/Model-12/model.glb' }]), async () => true), /无法识别数据中台模型/);
});

test('报警筛选模板不能代替真实可点击模型', async () => {
  const document = scene([], [model(url('shared'))]);
  Object.assign(document.entities, { alarm: { components: { alarmManager: { targets: [{ model: { kind: 'model', modelAsset: model(url('shared')) } }] } } } });
  assert.equal((await planPublishModelRecovery(document, async () => true)).length, 1);
});

test('同一模型包的不同文件不能静默合并为同一主模型', async () => {
  const first = model(url('shared'));
  const second = model(url('shared').replace('model.glb', 'variant.glb'));
  await assert.rejects(planPublishModelRecovery(scene([first, second], []), async () => false), /多个不同包内模型/);
});

test('同一健康 sourceUrl 的生成器包目录缺失仍进入计划，不复用普通实体的可用性缓存', async () => {
  const asset = model(url('project'));
  const document = scene([asset], []);
  (document.entities as any).generator = { components: { modelGenerator: {
    defaultTarget: { kind: 'model', packagePath: 'D:/old/missing', modelAsset: { ...asset } }, rules: [],
  } } };
  const checked: unknown[] = [];
  const plan = await planPublishModelRecovery(document, async (_asset, reference) => {
    checked.push(reference?.target); return reference?.target?.packagePath !== 'D:/old/missing';
  });
  assert.equal(checked.length, 2);
  assert.equal(plan.length, 1); assert.equal(plan[0].resourceId, '12');
  assert.deepEqual(plan[0].sourceUrls, [asset.sourceUrl]);
});
