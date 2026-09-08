import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'vite';

const server = await createServer({ ssr: { noExternal: ['@linkiez/dxf-renew'] },
  optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false }, appType: 'custom' });
try {
  const model = await server.ssrLoadModule('/src/editor/model/SceneDocument.ts');
  const { getSceneShadowBakeSignature } = await server.ssrLoadModule('/src/editor/model/sceneShadowBake.ts');
  const { useEditorStore } = await server.ssrLoadModule('/src/editor/store/editorStore.ts');
  const scene = model.createEmptySceneDocument('发布场景快照保留');
  const path = 'C:/workspace/Assets/Models/Model-123-device/model.glb';
  const sourceUrl = `editor-asset://local/${encodeURIComponent(path)}`;
  const entity = model.createModelEntity(path, sourceUrl, '设备');
  entity.components.modelAsset = { ...entity.components.modelAsset, assetRevision: 'published-revision',
    parameterConfig: { schema: 'babylon-editor.model-parameters', version: 1, parameters: [], bindings: [] },
    parameterValues: { customWidth: 12 }, scriptAssets: [{ name: 'custom.model.ts', path: `${path}.ts`, sourceUrl: `${sourceUrl}.ts` }],
    parameterScriptMetadata: [{ className: 'PublishedComponent', properties: { width: 12 } }],
  };
  scene.entities[entity.id] = entity;
  scene.entityIds.push(entity.id);
  const signature = getSceneShadowBakeSignature(scene);
  scene.sceneSettings.shadows.bake = { version: 1, signature, createdAt: new Date().toISOString(), surfaces: [] };
  const imported = { id: 'asset', name: 'model.glb', kind: 'model', libraryKind: 'model', path, sourceUrl,
    packagePath: 'C:/workspace/Assets/Models/Model-123-device', assetRevision: 'new-scan-revision', lengthUnit: 'meter' };
  useEditorStore.setState({ scene, runtimeMode: 'edit' });
  assert.equal(useEditorStore.getState().refreshModelInstancesFromAssets([imported], { preserveResolvedSnapshots: true }), 0);
  assert.equal(useEditorStore.getState().scene, scene, '首次打开同路径资源必须保留完整文档对象');
  assert.equal(getSceneShadowBakeSignature(useEditorStore.getState().scene), signature);
  assert.equal(useEditorStore.getState().scene.entities[entity.id].components.modelAsset.parameterValues.customWidth, 12);

  assert.equal(useEditorStore.getState().refreshModelInstancesFromAssets([imported]), 1);
  assert.equal(useEditorStore.getState().scene.entities[entity.id].components.modelAsset.assetRevision, 'new-scan-revision');
  assert.notEqual(getSceneShadowBakeSignature(useEditorStore.getState().scene), signature, '显式或真实同步更新必须使旧烘焙过期');

  useEditorStore.setState({ scene });
  const relocated = { ...imported, path: path.replace('C:/workspace', 'D:/restored'),
    packagePath: imported.packagePath.replace('C:/workspace', 'D:/restored'),
    sourceUrl: `editor-asset://local/${encodeURIComponent(path.replace('C:/workspace', 'D:/restored'))}` };
  assert.equal(useEditorStore.getState().refreshModelInstancesFromAssets([relocated], { preserveResolvedSnapshots: true }), 1);
  assert.equal(useEditorStore.getState().scene.entities[entity.id].components.modelAsset.sourcePath, relocated.path,
    '首次打开旧机器路径仍必须自动重关联');

  const panel = await readFile(new URL('../src/editor/panels/ProjectPanel.tsx', import.meta.url), 'utf8');
  assert.match(panel, /initialLoadPromise = loadProjectAssets\(\{\s*refreshModels: true,\s*preserveResolvedSnapshots: true,\s*preservePackagedEnvironment: true/);
  assert.match(panel, /runtimeEnvironment: environment, expectedSceneSessionId, expectedEnvironmentState/);
  assert.match(panel, /environmentSyncRunId: progress\.runId,\s*preservePackagedEnvironment: true/);
  assert.match(panel, /refreshModels: runtimeChangedResourceKeys === null \|\| runtimeChangedResourceKeys.length > 0,\s*preserveResolvedSnapshots: true/);
  assert.match(panel, /preservePackagedSnapshot && packagedSkyboxesRef.current.some/);
  assert.match(panel, /applyAssets: \(assets, sceneId\) => relinkCurrentSkyboxFromAssets\(assets, sceneId, preservePackagedSkyboxRef.current\)/);
  assert.match(panel, /handleSyncDataPlatformSkyboxes\(\): Promise<void> \{\s*if \(props.readOnly\) return;\s*preservePackagedSkyboxRef.current = false/);
  console.log('发布场景首次打开：完整模型元数据与烘焙签名保留、异路径恢复、真实更新失效、包内环境保护回归通过。');
} finally {
  await server.close();
}
