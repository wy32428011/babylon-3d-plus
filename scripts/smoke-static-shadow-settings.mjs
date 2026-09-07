import assert from 'node:assert/strict';
import { createServer } from 'vite';

const server = await createServer({ ssr: { noExternal: ['@linkiez/dxf-renew'] }, optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false }, appType: 'custom' });
try {
  const model = await server.ssrLoadModule('/src/editor/model/SceneDocument.ts');
  const bakeModule = await server.ssrLoadModule('/src/editor/model/sceneShadowBake.ts');
  const serializer = await server.ssrLoadModule('/src/editor/project/SceneSerializer.ts');
  const { getSceneShadowBakeSignature, sanitizeSceneShadowBake } = bakeModule;
  const scene = model.createEmptySceneDocument('静态阴影设置回归');
  scene.sceneSettings.environment = model.sanitizeSceneEnvironment({
    packagePath: 'C:/assets/environment', activeVariantUrl: 'editor-asset://local/environment/main.glb',
    variants: [{ name: 'main', sourcePath: 'C:/assets/environment/main.glb', sourceUrl: 'editor-asset://local/environment/main.glb' }],
  });
  const asset = { sourcePath: 'C:/assets/box.glb', sourceUrl: 'editor-asset://local/box.glb', assetRevision: '1', lengthUnit: 'm', unitScaleToMeters: 1 };
  for (let index = 0; index < 2; index += 1) {
    const entity = model.createModelEntity(asset.sourcePath, asset.sourceUrl, `模型${index}`);
    scene.entities[entity.id] = entity;
    scene.entityIds.push(entity.id);
  }
  const signature = getSceneShadowBakeSignature(scene);
  const bake = { version: 1, signature, createdAt: new Date().toISOString(), surfaces: [
    { key: 'surface', width: 1, height: 1, uvBounds: [0, 0, 1, 1], dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5i8AAAAASUVORK5CYII=' },
  ] };
  assert.equal(model.sanitizeSceneShadowSettings().mode, 'baked');
  assert.deepEqual(sanitizeSceneShadowBake(bake), bake);
  assert.equal(sanitizeSceneShadowBake({ ...bake, surfaces: [...bake.surfaces, ...bake.surfaces] }), null);
  assert.equal(sanitizeSceneShadowBake({ ...bake, surfaces: [{ ...bake.surfaces[0], width: 4097 }] }), null);
  assert.equal(sanitizeSceneShadowBake({ ...bake, surfaces: [{ ...bake.surfaces[0], uvBounds: [0, 0, 0, 1] }] }), null);
  scene.sceneSettings.shadows.bake = bake;
  const content = serializer.serializeScene(scene);
  assert.equal(getSceneShadowBakeSignature(JSON.parse(content).scene), signature, '序列化的合批关系不能使结果过期');
  const restored = serializer.deserializeScene(content);
  assert.deepEqual(restored.sceneSettings.shadows.bake, bake);
  assert.equal(getSceneShadowBakeSignature(restored), signature, '保存重开不能使结果过期');

  console.log('静态阴影快照与序列化回归通过。');
  const { useEditorStore } = await server.ssrLoadModule('/src/editor/store/editorStore.ts');
  scene.sceneSettings.shadows.bake = null;
  useEditorStore.setState({ scene, runtimeMode: 'edit', shadowBakeRequest: null, shadowBakeStatus: { phase: 'idle', message: null } });
  useEditorStore.getState().requestShadowBake();
  const request = useEditorStore.getState().shadowBakeRequest;
  assert.ok(request);
  useEditorStore.getState().completeShadowBake('other-request', bake);
  assert.equal(useEditorStore.getState().shadowBakeRequest.id, request.id);
  useEditorStore.getState().completeShadowBake(request.id, bake);
  assert.equal(useEditorStore.getState().shadowBakeRequest, null);
  assert.equal(useEditorStore.getState().shadowBakeStatus.phase, 'idle');
  useEditorStore.getState().undo();
  assert.equal(useEditorStore.getState().scene.sceneSettings.shadows.bake, null);
  useEditorStore.getState().requestShadowBake();
  const staleRequest = useEditorStore.getState().shadowBakeRequest;
  useEditorStore.getState().updateShadowSettings({ sunAzimuthDegrees: 100 });
  useEditorStore.getState().completeShadowBake(staleRequest.id, bake);
  assert.equal(useEditorStore.getState().shadowBakeRequest, null);
  assert.equal(useEditorStore.getState().scene.sceneSettings.shadows.bake, null, '取消请求的完成回调不得写入结果');
  useEditorStore.getState().requestShadowBake();
  const movedRequest = useEditorStore.getState().shadowBakeRequest;
  useEditorStore.setState((state) => ({ scene: { ...state.scene, sceneSettings: { ...state.scene.sceneSettings,
    environment: { ...state.scene.sceneSettings.environment, dataPlatformRevision: 'changed' } } } }));
  useEditorStore.getState().completeShadowBake(movedRequest.id, { ...bake, signature: movedRequest.signature });
  assert.equal(useEditorStore.getState().shadowBakeStatus.phase, 'error');
  useEditorStore.setState({ runtimeMode: 'preview' });
  useEditorStore.getState().requestShadowBake();
  assert.equal(useEditorStore.getState().shadowBakeRequest, null);
  console.log('静态阴影设置回归通过：快照校验、保存重开/合批、Store请求隔离、撤销和过期结果拒绝。');
} finally {
  await server.close();
}
