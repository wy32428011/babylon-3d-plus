import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import electron from 'electron';
import unzipper from 'unzipper';

const { app } = electron;
const output = path.resolve('output/multi-effect-binding');
await mkdir(output, { recursive: true });
const temporary = await mkdtemp(path.join(output, 'packages-'));
app.setPath('userData', path.join(temporary, 'user-data'));
app.getAppPath = () => process.cwd();
const controller = new AbortController();
async function cleanup() {
  const root = await realpath(output), target = await realpath(temporary), relative = path.relative(root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !path.basename(target).startsWith('packages-')) throw new Error('测试清理路径校验失败');
  await rm(target, { recursive: true, force: true });
}
const deadline = setTimeout(() => {
  controller.abort(); console.error('多模型特效绑定发布验证超时');
  void cleanup().finally(() => app.exit(1));
}, 120000);

async function run() {
  let code = 1;
  try {
    const { buildDigitalTwinSourcePackage } = await import('../../dist-electron/ipc/digitalTwinSourcePackage.js');
    const { buildDigitalTwinDistPackage } = await import('../../dist-electron/ipc/digitalTwinDistPackage.js');
    const { authorizeAssetFile } = await import('../../dist-electron/ipc/assetRegistry.js');
    const { matchesModelTypeReference } = await import('../../dist-electron/shared/modelTypeIdentity.js');
    // 复用已存在的验收素材，新增绑定不需要额外生成或下载模型。
    const original = JSON.parse(await readFile('output/effect-configuration/scene.scene.json', 'utf8'));
    const editorFixture = JSON.parse(await readFile('output/effect-configuration/editor-binding.scene.json', 'utf8'));
    const sampleEffect = Object.values(original.scene.entities).find(entity => entity.components.poiEffect?.effectKind === 'model-outline');
    const sampleModel = Object.values(editorFixture.scene.entities).find(entity => entity.components.modelAsset);
    assert.ok(sampleEffect && sampleModel, '需要已有特效配置和编辑器验证素材');
    const projectRoot = path.join(temporary, 'project'), modelPath = path.join(projectRoot, 'Assets', 'Models', 'shared-device.glb');
    await mkdir(path.dirname(modelPath), { recursive: true });
    await copyFile('output/effect-configuration/device.glb', modelPath); authorizeAssetFile(modelPath);
    const modelAsset = { ...structuredClone(sampleModel.components.modelAsset), sourcePath: modelPath, sourceUrl: 'editor-asset://local/' + encodeURIComponent(modelPath) };
    delete modelAsset.dataPlatformModel;
    const models = ['model-a', 'model-b'].map((id, index) => ({ ...structuredClone(sampleModel), id, parentId: null, children: [],
      components: { ...structuredClone(sampleModel.components), modelAsset: { ...structuredClone(modelAsset), assetCode: index ? '000318' : '000317' } } }));
    const otherPath = path.join(path.dirname(modelPath), 'other-type.glb');
    await copyFile(modelPath, otherPath); authorizeAssetFile(otherPath);
    const otherModel = { ...structuredClone(models[0]), id: 'model-c', name: '不同类型模型', components: { ...structuredClone(models[0].components),
      modelAsset: { ...structuredClone(modelAsset), sourcePath: otherPath, sourceUrl: 'editor-asset://local/' + encodeURIComponent(otherPath), assetCode: '000319' } } };
    for (const [index, model] of [...models, otherModel].entries()) {
      model.components.transform.position = { x: (index - 1) * 6, y: 0, z: 0 };
      model.components.transform.scale = { x: .4, y: .4, z: .4 };
      delete model.components.telemetryBinding; delete model.components.modelAsset.dataDrivenConfig;
    }
    const makeEffect = (id, mode) => {
      const entity = { ...structuredClone(sampleEffect), id, parentId: null, children: [] };
      const effect = entity.components.poiEffect, target = effect.configuration.target;
      effect.configuration.parameters = {}; effect.configuration.data.mode = 'none'; effect.configuration.data.mappings = []; effect.configuration.data.trigger.enabled = false;
      Object.assign(target, { mode: mode === 'type-all' ? 'model' : 'entity', entityId: mode === 'type-all' ? null : models[0].id,
        model: mode === 'type-all' ? { name: '共享设备类型', sourcePath: modelAsset.sourcePath, sourceUrl: modelAsset.sourceUrl } : null,
        sourceId: '', deviceType: '', assetCode: '', selection: mode === 'legacy-single' ? 'single' : 'all', maxTargets: 64,
        anchor: 'origin', nodePath: '', offset: { x: 0, y: 0, z: 0 } });
      delete target.entityIds;
      if (mode === 'explicit-multiple') target.entityIds = models.map(model => model.id);
      effect.visual.targetEntityId = target.entityId;
      return entity;
    };
    const effects = [makeEffect('multi-entity-effect', 'explicit-multiple'), makeEffect('type-all-effect', 'type-all'), makeEffect('legacy-single-effect', 'legacy-single')];
    const entities = [...models, otherModel, ...effects];
    const document = { ...original, scene: { ...original.scene, selectedEntityId: null,
      entities: Object.fromEntries(entities.map(entity => [entity.id, entity])), entityIds: entities.map(entity => entity.id), rootIds: entities.map(entity => entity.id) } };
    const sceneFile = path.join(projectRoot, 'Scenes', 'main.scene.json'), content = JSON.stringify(document);
    await mkdir(path.dirname(sceneFile), { recursive: true }); await writeFile(sceneFile, content, 'utf8');
    const source = await buildDigitalTwinSourcePackage({ projectRoot, sharedResourcesRoot: path.join(temporary, 'shared'), entrySceneFilePath: sceneFile,
      outputRoot: path.join(temporary, 'source'), signal: controller.signal,
      manifest: { projectId: '123', projectName: '多模型特效绑定验证', editorProjectId: null, baseVersionId: null, resourceRevision: '1' },
      isPlatformImageReference: () => false, findSyncedImageForReference: async () => null, skyboxCacheDependencies: { getSharedProjectSkyboxRoot: () => null } });
    const dist = await buildDigitalTwinDistPackage({ projectId: '123', publishName: '多模型特效绑定验证', sceneContent: source.entrySceneContent,
      sourceResourceFiles: source.resourceFiles, outputRoot: path.join(temporary, 'dist'), signal: controller.signal });
    const sourceZip = await unzipper.Open.file(source.filePath), distZip = await unzipper.Open.file(dist.filePath);
    const readScene = async (archive, name) => {
      const entry = archive.files.find(file => file.path.replace(/\\/g, '/') === name); assert.ok(entry, name);
      return JSON.parse((await entry.buffer()).toString('utf8'));
    };
    const sourceScene = await readScene(sourceZip, 'Scenes/main.scene.json'), distScene = await readScene(distZip, 'project/scene.json');
    for (const scene of [sourceScene.scene, distScene.scene]) {
      const target = id => scene.entities[id].components.poiEffect.configuration.target;
      assert.deepEqual(target('multi-entity-effect').entityIds, ['model-a', 'model-b']);
      assert.equal(target('multi-entity-effect').entityId, 'model-a'); assert.equal(target('multi-entity-effect').selection, 'all');
      assert.equal(target('type-all-effect').selection, 'all'); assert.equal(target('type-all-effect').entityId, null);
      assert.equal(target('legacy-single-effect').entityId, 'model-a'); assert.equal(target('legacy-single-effect').selection, 'single');
      assert.equal(Object.hasOwn(target('legacy-single-effect'), 'entityIds'), false, '旧单目标不自动变成多目标');
      for (const model of models) assert.equal(matchesModelTypeReference(scene.entities[model.id].components.modelAsset, target('type-all-effect').model), true);
      assert.equal(matchesModelTypeReference(scene.entities[otherModel.id].components.modelAsset, target('type-all-effect').model), false, '不同资源不能被同类型绑定选中');
      for (const effect of effects) assert.equal(scene.entities[effect.id].components.poiEffect.configuration.data.assetCode, '000317');
    }
    assert.equal(source.resourceFiles.filter(file => /\.glb$/i.test(file.sourcePath)).length, 2, 'SOURCE 两种类型共两份实际资源');
    const distModelPaths = models.map(model => distScene.scene.entities[model.id].components.modelAsset.sourcePath);
    assert.equal(new Set(distModelPaths).size, 1, 'DIST 同类型模型引用同一份资源');
    assert.ok(distModelPaths[0].startsWith('editor-asset://local/'));
    const resourcePath = decodeURIComponent(distModelPaths[0].slice('editor-asset://local/'.length)).replace(/\\/g, '/');
    assert.equal(distZip.files.filter(file => file.path.replace(/\\/g, '/') === resourcePath).length, 1, 'DIST 同类型模型只打包一份实际资源');
    assert.equal(await readFile(sceneFile, 'utf8'), content, '发布不能改写源场景');
    const viewerRoot = path.join(output, 'viewer');
    for (const entry of distZip.files) {
      const destination = path.resolve(viewerRoot, entry.path), relative = path.relative(viewerRoot, destination);
      assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
      if (entry.type === 'Directory') await mkdir(destination, { recursive: true });
      else { await mkdir(path.dirname(destination), { recursive: true }); await writeFile(destination, await entry.buffer()); }
    }
    const report = { ok: true, effects: 3, sceneModels: 3, modelTypes: 2, sharedTypeResourceCopies: 1,
      checks: ['SOURCE-multiple-entity-ids', 'DIST-multiple-entity-ids', 'type-all-shared-reference', 'legacy-single-preserved', 'string-asset-code', 'resource-deduplication', 'source-not-mutated'] };
    await writeFile(path.join(output, 'packages-result.json'), JSON.stringify(report, null, 2), 'utf8');
    console.log(JSON.stringify(report, null, 2)); code = 0;
  } catch (error) { console.error(error); }
  finally { clearTimeout(deadline); try { await cleanup(); } catch (error) { console.error(error); code = 1; } app.exit(code); }
}
app.whenReady().then(run).catch(error => { console.error(error); app.exit(1); });
