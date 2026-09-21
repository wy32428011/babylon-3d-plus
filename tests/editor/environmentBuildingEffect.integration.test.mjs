import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';

const temporaryRoot = await mkdtemp(path.resolve('node_modules/.environment-building-effect-test-'));
const previousWindow = globalThis.window;
globalThis.window ??= { addEventListener() {}, removeEventListener() {} };
const deadline = setTimeout(() => {
  console.error('数字孪生特效集成验证超时');
  process.exit(1);
}, 120_000);
let store;
let originalState;
after(async () => {
  clearTimeout(deadline);
  if (store && originalState) store.setState(originalState, true);
  if (previousWindow === undefined) delete globalThis.window;
  else globalThis.window = previousWindow;
  if (path.dirname(temporaryRoot) !== path.resolve('node_modules')
    || !path.basename(temporaryRoot).startsWith('.environment-building-effect-test-')) throw new Error('测试临时目录范围无效');
  await rm(temporaryRoot, { recursive: true, force: true });
});

// 单入口预构建使所有断言共享一个 Store，避免动态 SSR 加载停滞。
const entry = path.join(temporaryRoot, 'entry.mjs');
await writeFile(entry, [
  "export { useEditorStore } from '../../src/editor/store/editorStore.ts';",
  "export { createEmptySceneDocument, sanitizeSceneEnvironment } from '../../src/editor/model/SceneDocument.ts';",
  "export { createCommandHistory } from '../../src/editor/commands/CommandHistory.ts';",
  "export { serializeScene, deserializeScene } from '../../src/editor/project/SceneSerializer.ts';",
  "export { POI_EFFECT_KINDS, createDefaultPoiEffectComponent } from '../../src/editor/model/poiEffect.ts';",
  "export { DIGITAL_TWIN_EFFECT_DEFINITIONS, collectDigitalTwinEffectTargetIds } from '../../src/editor/model/digitalTwinEffect.ts';",
  "export { createEditModeModelThinInstancePlan, createPersistedModelThinInstanceScene } from '../../src/editor/model/editModeModelThinInstances.ts';",
  "export { createEnvironmentFromAsset } from '../../src/editor/assets/environmentAssets.ts';",
  "export { createPoiEffectLibraryItems } from '../../src/editor/assets/projectLibrary.ts';",
  "export { encodeBuiltInAssetDragPayload, decodeBuiltInAssetDragPayload } from '../../src/editor/assets/AssetDatabase.ts';",
].join('\n'));
await build({
  configFile: false, publicDir: false, logLevel: 'silent',
  ssr: { noExternal: ['@linkiez/dxf-renew', /^lodash\//] },
  build: { ssr: entry, outDir: path.join(temporaryRoot, 'ssr'),
    rolldownOptions: { output: { entryFileNames: 'modules.mjs' } } },
});
const {
  useEditorStore, createEmptySceneDocument, sanitizeSceneEnvironment, createCommandHistory, serializeScene, deserializeScene,
  createEnvironmentFromAsset, POI_EFFECT_KINDS, DIGITAL_TWIN_EFFECT_DEFINITIONS, createDefaultPoiEffectComponent, createPoiEffectLibraryItems,
  encodeBuiltInAssetDragPayload, decodeBuiltInAssetDragPayload, collectDigitalTwinEffectTargetIds,
  createEditModeModelThinInstancePlan, createPersistedModelThinInstanceScene,
} = await import(pathToFileURL(path.join(temporaryRoot, 'ssr/modules.mjs')).href);
store = useEditorStore;
originalState = store.getState();
beforeEach(() => {
  store.setState(originalState, true);
  store.setState({ scene: createEmptySceneDocument('数字孪生特效验收'), history: createCommandHistory(),
    runtimeMode: 'edit', hierarchySelectionIds: [], entityClipboard: null, logs: [] });
});

const ENVIRONMENT = '__scene_environment_model__';
const kinds = ['model-outline','model-edges','model-emissive','model-scan','height-gradient','hologram','xray','dissolve'];
function environment() {
  return sanitizeSceneEnvironment({packagePath:'C:/fixture/environment', activeVariantUrl:'editor-asset://local/factory.glb',
    variants:[{name:'默认预设',sourcePath:'C:/fixture/environment/factory.glb',sourceUrl:'editor-asset://local/factory.glb'}]});
}
test('八类建筑特效通过现有实体绑定环境模型，参数和绑定保存重开',()=>{
  store.getState().updateEnvironmentConfig(environment());
  for(const kind of kinds){
    store.getState().createPoiEffect(kind,undefined,ENVIRONMENT);
    const id=store.getState().scene.selectedEntityId;
    const effect=structuredClone(store.getState().scene.entities[id].components.poiEffect);
    assert.equal(effect.visual.targetEntityId,ENVIRONMENT);
    effect.speed=0;effect.visual.opacity=0;
    store.getState().updateSelectedPoiEffect(effect);
    effect.visual.opacity=1;
    const saved=store.getState().scene.entities[id].components.poiEffect;
    assert.equal(saved.visual.opacity,0);
    const reopened=deserializeScene(serializeScene(store.getState().scene));
    assert.deepEqual(reopened.entities[id].components.poiEffect,saved);
  }
});
test('拖入后的创建与绑定是一次撤销，普通特效原有创建流程不受影响',()=>{
  store.getState().updateEnvironmentConfig(environment());
  store.getState().createPoiEffect('model-scan',undefined,ENVIRONMENT);
  const id=store.getState().scene.selectedEntityId;
  store.getState().undo();assert.equal(store.getState().scene.entities[id],undefined);
  assert.ok(store.getState().scene.sceneSettings.environment);
  store.getState().redo();assert.equal(store.getState().scene.entities[id].components.poiEffect.visual.targetEntityId,ENVIRONMENT);
  store.getState().createPoiEffect('model-scan');
  assert.equal(store.getState().scene.entities[store.getState().scene.selectedEntityId].components.poiEffect.visual.targetEntityId,null);
});
test('环境清除、替换、撤销以及特效复制保留稳定环境绑定',()=>{
  store.getState().updateEnvironmentConfig(environment());
  store.getState().createPoiEffect('hologram',undefined,ENVIRONMENT);
  store.getState().copySelectedEntities();store.getState().pasteEntityClipboard();
  const copyId=store.getState().scene.selectedEntityId;
  store.getState().updateEnvironmentConfig(null);
  assert.equal(store.getState().scene.entities[copyId].components.poiEffect.visual.targetEntityId,ENVIRONMENT);
  store.getState().undo();assert.ok(store.getState().scene.sceneSettings.environment);
  const replacement=environment();replacement.displayName='新环境';store.getState().updateEnvironmentConfig(replacement);
  const reopened=deserializeScene(serializeScene(store.getState().scene));
  assert.equal(reopened.entities[copyId].components.poiEffect.visual.targetEntityId,ENVIRONMENT);
  assert.equal(reopened.sceneSettings.environment.displayName,'新环境');
});
test('预览模式拒绝添加环境特效，不创建意外实体',()=>{
  store.getState().updateEnvironmentConfig(environment());store.setState({runtimeMode:'preview'});
  store.getState().createPoiEffect('model-scan',undefined,ENVIRONMENT);
  assert.equal(store.getState().scene.entityIds.length,0);
});

