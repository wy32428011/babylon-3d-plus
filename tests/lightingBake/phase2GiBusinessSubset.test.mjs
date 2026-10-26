import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { prepareBusinessGiSubset } from './phase2GiBusinessSubset.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.resolve('output', '.phase2-gi-prepare-test-'));
  t.after(async () => { assert.equal(path.dirname(root), path.resolve('output')); assert.ok(path.basename(root).startsWith('.phase2-gi-prepare-test-')); await fs.rm(root, { recursive: true, force: true }); });
  const project = path.join(root, 'original'), scenes = path.join(project, 'Scenes'), model = path.join(project, 'Assets', 'Models', '真实模型');
  await fs.mkdir(scenes, { recursive: true }); await fs.mkdir(model, { recursive: true });
  const modelPath = path.join(model, 'model.glb'), scriptPath = path.join(model, 'model.model.ts');
  await fs.writeFile(modelPath, 'unit transport bytes, not GI fixture'); await fs.writeFile(scriptPath, 'original script bytes');
  const entity = id => ({ id, parentId: 'folder', childrenIds: [], components: { transform: { position: { x: 4, y: 2, z: -7 } },
    modelAsset: { sourcePath: modelPath, sourceUrl: 'editor-asset://local/' + encodeURIComponent(modelPath),
      scriptAssets: [{ path: scriptPath, sourceUrl: 'editor-asset://local/' + encodeURIComponent(scriptPath), name: 'model.model.ts' }], parameterValues: { width: 10 } } } });
  const document = { version: 6, scene: { id: 'source', name: '原工程', entityIds: ['folder', 'selected', 'unselected'],
    entities: { folder: { id: 'folder', parentId: null, childrenIds: ['selected', 'unselected'], components: {} }, selected: entity('selected'), unselected: entity('unselected') },
    mqttConfig: { enabled: true }, fetchConfig: { url: 'https://example.test/api', apiKey: 'not copied to live service' },
    sceneSettings: { environment: { sourcePath: modelPath }, lighting: { version: 2, main: { intensity: 1.5 }, bake: { enabled: false, quality: 'standard' }, result: { stale: true } } } } };
  const sourceScene = path.join(scenes, 'original.scene.json'), content = JSON.stringify(document); await fs.writeFile(sourceScene, content);
  return { root, project, model, modelPath, scriptPath, sourceScene, content, output: path.join(root, 'prepared') };
}

test('真实业务子场景准备保留模型/参数/父变换及资产字节，不触碰原工程且不称已烘焙', async t => {
  const f = await fixture(t);
  const result = await prepareBusinessGiSubset({ sourceScene: f.sourceScene, output: f.output, entityIds: ['selected'], environment: 'omit', previewBudget: true });
  assert.equal(result.status, 'PREPARED_NOT_BAKED'); assert.equal(result.conditions.sizeClass, 'unverified until real renderer preflight');
  assert.equal(result.copiedAssets.length, 2); assert.equal(result.modelEntityCount, 1);
  const scene = JSON.parse(await fs.readFile(result.scenePath, 'utf8')).scene;
  assert.deepEqual(scene.entityIds, ['folder', 'selected']); assert.deepEqual(scene.entities.folder.childrenIds, ['selected']);
  assert.equal(scene.entities.selected.parentId, 'folder');
  assert.deepEqual(scene.entities.selected.components.transform.position, { x: 4, y: 2, z: -7 });
  assert.deepEqual(scene.entities.selected.components.modelAsset.parameterValues, { width: 10 });
  assert.equal(scene.sceneSettings.lighting.main.intensity, 1.5);
  assert.equal(scene.sceneSettings.environment, null); assert.equal(scene.sceneSettings.lighting.result, null);
  assert.equal(scene.sceneSettings.lighting.bake.enabled, true); assert.equal(scene.mqttConfig.enabled, false);
  assert.equal(scene.entities.selected.components.modelAsset.sourcePath, path.join(f.output, 'Assets', 'Models', '真实模型', 'model.glb'));
  assert.equal(await fs.readFile(scene.entities.selected.components.modelAsset.scriptAssets[0].path, 'utf8'), 'original script bytes');
  assert.equal(await fs.readFile(f.sourceScene, 'utf8'), f.content);
  assert.equal(await fs.readFile(f.scriptPath, 'utf8'), 'original script bytes');
  await assert.rejects(prepareBusinessGiSubset({ sourceScene: f.sourceScene, output: f.output, entityIds: ['selected'], environment: 'omit' }), /拒绝覆盖/);
});

test('GI副本准备拒绝未知根、非模型根、含链接资产与原工程内写入', async t => {
  const f = await fixture(t);
  const options = { sourceScene: f.sourceScene, output: f.output, entityIds: ['selected'], environment: 'keep' };
  await assert.rejects(prepareBusinessGiSubset({ ...options, entityIds: ['folder'] }), /真实模型实体/);
  await assert.rejects(prepareBusinessGiSubset({ ...options, environment: undefined }), /明确选择/);
  await assert.rejects(prepareBusinessGiSubset({ ...options, output: path.join(f.project, 'new-copy') }), /原工程/);
  if (process.platform === 'win32') {
    await fs.symlink(f.model, path.join(f.project, 'Assets', 'linked'), 'junction');
    await assert.rejects(prepareBusinessGiSubset(options), /不跟随原资产链接/);
    const report = JSON.parse(await fs.readFile(path.join(f.output, 'phase2-gi-preparation.json'), 'utf8'));
    assert.equal(report.status, 'FAIL'); assert.equal(await fs.readFile(f.sourceScene, 'utf8'), f.content);
  }
});
