import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { createServer } from 'vite';

const viteServer = await createServer({
  appType: 'custom', configFile: false, root: process.cwd(),
  server: { middlewareMode: true, hmr: false },
  optimizeDeps: { noDiscovery: true }, ssr: { noExternal: ['@linkiez/dxf-renew'] },
});
after(async () => { await viteServer.close(); });
const { createEmptySceneDocument, createModelEntity, createModelGeneratorEntity, createManualRoamSpawnEntity } =
  await viteServer.ssrLoadModule('/src/editor/model/SceneDocument.ts');
const { serializeScene, deserializeScene } = await viteServer.ssrLoadModule('/src/editor/project/SceneSerializer.ts');
const { sanitizeModelAssetTemplate } = await viteServer.ssrLoadModule('/src/editor/model/modelGenerator.ts');
const { createAlarmManagerEntity } = await viteServer.ssrLoadModule('/src/editor/model/alarmManager.ts');
(globalThis as typeof globalThis & { window?: object }).window ??= {};
const { useEditorStore } = await viteServer.ssrLoadModule('/src/editor/store/editorStore.ts');

const packageName = 'Model-10001-货架';
const localRoot = `D:/new-workspace/Projects/1/Assets/Models/${packageName}`;
const sharedRoot = `D:/new-workspace/SharedResources/Assets/Models/${packageName}`;
const url = (path: string) => `editor-asset://local/${encodeURIComponent(path)}`;
const script = (root: string) => ({ name: 'shelf.model.ts', path: `${root}/shelf.model.ts`, sourceUrl: url(`${root}/shelf.model.ts`) });
const snapshot = { contentSha256: 'a'.repeat(64) };
const sharedAsset = {
  id: 'shared-model', name: '货架', kind: 'model', libraryKind: 'model',
  path: `${sharedRoot}/shelf.glb`, sourceUrl: url(`${sharedRoot}/shelf.glb`),
  packagePath: sharedRoot, assetRevision: 'new-revision', scriptAssets: [script(sharedRoot)],
  parameterScriptMetadata: [{ version: 'new' }],
};

function fixture(marked = true) {
  const scene = createEmptySceneDocument('发布模型版本保护');
  const model = createModelEntity(`${localRoot}/shelf.glb`, url(`${localRoot}/shelf.glb`), '货架');
  model.components.modelAsset.scriptAssets = [script(localRoot)];
  model.components.modelAsset.parameterScriptMetadata = [{ version: 'local' }];
  if (marked) model.components.modelAsset.sourceSnapshot = snapshot;
  const generator = createModelGeneratorEntity();
  const { assetCode: _assetCode, ...template } = model.components.modelAsset;
  generator.components.modelGenerator.defaultTarget = {
    kind: 'model', assetId: 'local-model', displayName: '货架', packagePath: localRoot, modelAsset: template,
  };
  const avatar = createManualRoamSpawnEntity();
  avatar.components.manualRoamSpawn.avatar = {
    name: '货架人物', sourcePath: template.sourcePath, sourceUrl: template.sourceUrl,
    ...(marked ? { sourceSnapshot: snapshot } : {}),
  };
  for (const entity of [model, generator, avatar]) {
    scene.entityIds.push(entity.id);
    scene.entities[entity.id] = entity;
  }
  return { scene, model, generator, avatar };
}

test('模型、生成器和漫游模型的工程包内容指纹保存重开后完整保留', () => {
  const { scene, model, generator, avatar } = fixture();
  const restored = deserializeScene(serializeScene(scene));
  assert.deepEqual(restored.entities[model.id].components.modelAsset.sourceSnapshot, snapshot);
  assert.deepEqual(restored.entities[generator.id].components.modelGenerator.defaultTarget.modelAsset.sourceSnapshot, snapshot);
  assert.deepEqual(restored.entities[avatar.id].components.manualRoamSpawn.avatar.sourceSnapshot, snapshot);
});

test('后台同步只返回同 ID 共享新版时仍保留本地模型、脚本和生成器完整快照', () => {
  const { scene, model, generator, avatar } = fixture();
  useEditorStore.getState().loadSceneFromContent(serializeScene(scene), 'snapshot-background');
  const before = structuredClone(useEditorStore.getState().scene);
  assert.equal(useEditorStore.getState().refreshModelInstancesFromAssets([sharedAsset], { preserveResolvedSnapshots: true }), 0);
  for (const entity of [model, generator, avatar]) {
    assert.deepEqual(useEditorStore.getState().scene.entities[entity.id], before.entities[entity.id]);
  }
});

test('显式更新资源整体替换模型与脚本并解除工程包快照固定', () => {
  const { scene, model, generator, avatar } = fixture();
  useEditorStore.getState().loadSceneFromContent(serializeScene(scene), 'snapshot-explicit');
  assert.equal(useEditorStore.getState().refreshModelInstancesFromAssets([sharedAsset]), 3);
  const updated = useEditorStore.getState().scene;
  for (const asset of [updated.entities[model.id].components.modelAsset,
    updated.entities[generator.id].components.modelGenerator.defaultTarget.modelAsset]) {
    assert.equal(asset.sourcePath, sharedAsset.path);
    assert.deepEqual(asset.scriptAssets, sharedAsset.scriptAssets);
    assert.deepEqual(asset.parameterScriptMetadata, sharedAsset.parameterScriptMetadata);
    assert.equal(asset.sourceSnapshot, undefined);
  }
  assert.equal(updated.entities[avatar.id].components.manualRoamSpawn.avatar.sourceSnapshot, undefined);
});

test('未带指纹的历史场景继续使用原有后台重新关联规则', () => {
  const { scene, model } = fixture(false);
  useEditorStore.getState().loadSceneFromContent(serializeScene(scene), 'snapshot-legacy');
  assert.equal(useEditorStore.getState().refreshModelInstancesFromAssets([sharedAsset], { preserveResolvedSnapshots: true }), 3);
  assert.equal(useEditorStore.getState().scene.entities[model.id].components.modelAsset.sourcePath, sharedAsset.path);
});

test('报警外观和槽位模型保存后也保留固定版本，显式同步整体解除固定', () => {
  const { scene, generator } = fixture();
  const alarm = createAlarmManagerEntity({ x: 0, y: 0, z: 0 });
  const target = generator.components.modelGenerator.defaultTarget;
  alarm.components.alarmManager.appearanceModel = structuredClone(target);
  alarm.components.alarmManager.targets = [{ id: 'slot', model: structuredClone(target), entityId: '' }];
  scene.entityIds.push(alarm.id);
  scene.entities[alarm.id] = alarm;
  useEditorStore.getState().loadSceneFromContent(serializeScene(scene), 'snapshot-alarm');
  const before = structuredClone(useEditorStore.getState().scene.entities[alarm.id]);
  assert.deepEqual(before.components.alarmManager.appearanceModel.modelAsset.sourceSnapshot, snapshot);
  assert.deepEqual(before.components.alarmManager.targets[0].model.modelAsset.sourceSnapshot, snapshot);
  assert.equal(useEditorStore.getState().refreshModelInstancesFromAssets([sharedAsset], { preserveResolvedSnapshots: true }), 0);
  assert.deepEqual(useEditorStore.getState().scene.entities[alarm.id], before);
  assert.equal(useEditorStore.getState().refreshModelInstancesFromAssets([sharedAsset]), 5);
  const updated = useEditorStore.getState().scene.entities[alarm.id].components.alarmManager;
  for (const target of [updated.appearanceModel, updated.targets[0].model]) {
    assert.equal(target.modelAsset.sourcePath, sharedAsset.path);
    assert.deepEqual(target.modelAsset.scriptAssets, sharedAsset.scriptAssets);
    assert.equal(target.modelAsset.sourceSnapshot, undefined);
  }
});

test('显式刷新同路径同内容资源仍解除固定标记，之后允许正常同步', () => {
  const { scene, model, avatar } = fixture();
  const localAsset = {
    ...sharedAsset, path: model.components.modelAsset.sourcePath, sourceUrl: model.components.modelAsset.sourceUrl,
    packagePath: localRoot, assetRevision: undefined, scriptAssets: model.components.modelAsset.scriptAssets,
    parameterScriptMetadata: model.components.modelAsset.parameterScriptMetadata,
  };
  useEditorStore.getState().loadSceneFromContent(serializeScene(scene), 'snapshot-same-path');
  assert.equal(useEditorStore.getState().refreshModelInstancesFromAssets([localAsset]), 3);
  assert.equal(useEditorStore.getState().scene.entities[model.id].components.modelAsset.sourceSnapshot, undefined);
  assert.equal(useEditorStore.getState().scene.entities[avatar.id].components.manualRoamSpawn.avatar.sourceSnapshot, undefined);
  assert.equal(useEditorStore.getState().refreshModelInstancesFromAssets([sharedAsset], { preserveResolvedSnapshots: true }), 3);
});

test('非法工程包指纹拒绝进入模型模板或保存场景', () => {
  const { scene, model } = fixture();
  model.components.modelAsset.sourceSnapshot = { contentSha256: '../not-a-digest' };
  assert.throws(() => deserializeScene(serializeScene(scene)), /场景文件格式不受支持/);
  assert.equal(sanitizeModelAssetTemplate(model.components.modelAsset), null);
});

test('本地打开同步当前中台候选，覆盖模型和间接引用快照并保留实例身份与摆放', async () => {
  const { scene, model, generator, avatar } = fixture();
  model.components.transform.position = { x: 3, y: 4, z: 5 };
  model.components.modelAsset.assetCode = 'LOCAL-DEVICE';
  const content = serializeScene(scene);
  const previousApi = (globalThis as any).window.editorApi;
  (globalThis as any).window.editorApi = {
    loadScene: async () => ({ canceled: false, content, sceneOpenToken: 1 }),
    loadSceneFile: async () => ({ canceled: false, content, sceneOpenToken: 1 }),
    confirmSceneOpen: async () => true,
  };
  try {
    for (const open of [() => useEditorStore.getState().loadScene(), () => useEditorStore.getState().loadSceneFromFile('local.scene.json')]) {
      assert.equal(await open(), true);
      assert.equal(useEditorStore.getState().sceneResourcePolicy, 'local-refresh');
      // 对应本地初始化单次统一 refresh，即使缓存本轮没有变化也应用全部当前中台候选。
      assert.equal(useEditorStore.getState().refreshModelInstancesFromAssets([sharedAsset], { preserveResolvedSnapshots: false }), 3);
      const updated = useEditorStore.getState().scene;
      assert.equal(updated.entities[model.id].components.modelAsset.sourcePath, sharedAsset.path);
      assert.equal(updated.entities[generator.id].components.modelGenerator.defaultTarget.modelAsset.sourcePath, sharedAsset.path);
      assert.equal(updated.entities[avatar.id].components.manualRoamSpawn.avatar.sourcePath, sharedAsset.path);
      assert.equal(updated.entities[model.id].components.modelAsset.assetCode, 'LOCAL-DEVICE');
      assert.deepEqual(updated.entities[model.id].components.transform.position, { x: 3, y: 4, z: 5 });
      assert.equal(updated.entities[model.id].components.modelAsset.sourceSnapshot, undefined);
      assert.deepEqual(updated.entities[model.id].components.modelAsset.scriptAssets, sharedAsset.scriptAssets);
      assert.equal(JSON.stringify(JSON.parse(serializeScene(updated))).includes('sceneResourcePolicy'), false);
    }
    await useEditorStore.getState().loadSceneFromFile('source.scene.json', undefined, true);
    assert.equal(useEditorStore.getState().sceneResourcePolicy, 'data-platform-refresh');
    assert.equal(useEditorStore.getState().refreshModelInstancesFromAssets([sharedAsset], { preserveResolvedSnapshots: true }), 0);
    useEditorStore.getState().resetSceneToBlank();
    assert.equal(useEditorStore.getState().sceneResourcePolicy, 'preserve-snapshot');
  } finally { (globalThis as any).window.editorApi = previousApi; }
});
