import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';

const temporaryRoot = await mkdtemp(path.resolve('node_modules/.lighting-bake-test-'));
const previousWindow = globalThis.window;
globalThis.window ??= { addEventListener() {}, removeEventListener() {} };
const deadline = setTimeout(() => {
  console.error('光照烘焙集成验证超时');
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
    || !path.basename(temporaryRoot).startsWith('.lighting-bake-test-')) throw new Error('测试临时目录范围无效');
  await rm(temporaryRoot, { recursive: true, force: true });
});

// 共用一次预构建和同一 Store，验证真实编辑命令及持久化链路。
const entry = path.join(temporaryRoot, 'entry.mjs');
await writeFile(entry, [
  "export { useEditorStore } from '../../src/editor/store/editorStore.ts';",
  "export { getSceneLightingBakeSignature } from '../../electron/shared/sceneLightingBakeContract.ts';",
  "export { preparePublishLightingBake } from '../../src/editor/deployment/preparePublishScene.ts';",
  "export { createEmptySceneDocument } from '../../src/editor/model/SceneDocument.ts';",
  "export { createCommandHistory } from '../../src/editor/commands/CommandHistory.ts';",
  "export { resolveLightingNodeSettings } from '../../src/editor/model/lightingMobility.ts';",
  "export { serializeScene, deserializeScene } from '../../src/editor/project/SceneSerializer.ts';",
  "export { encodeBuiltInAssetDragPayload, decodeBuiltInAssetDragPayload } from '../../src/editor/assets/AssetDatabase.ts';",
].join('\n'));
await build({
  configFile: false, publicDir: false, logLevel: 'silent',
  ssr: { noExternal: ['@linkiez/dxf-renew', /^lodash\//] },
  build: {
    ssr: entry, outDir: path.join(temporaryRoot, 'ssr'),
    rolldownOptions: { output: { entryFileNames: 'modules.mjs' } },
  },
});
const {
  useEditorStore, createEmptySceneDocument, createCommandHistory, getSceneLightingBakeSignature, preparePublishLightingBake,
  serializeScene, deserializeScene, resolveLightingNodeSettings,
  encodeBuiltInAssetDragPayload, decodeBuiltInAssetDragPayload,
} = await import(pathToFileURL(path.join(temporaryRoot, 'ssr/modules.mjs')).href);
store = useEditorStore;
originalState = store.getState();
beforeEach(() => {
  store.setState(originalState, true);
  store.setState({
    scene: createEmptySceneDocument('光照烘焙验收'), history: createCommandHistory(),
    runtimeMode: 'edit', hierarchySelectionIds: [], entityClipboard: null, logs: [],
  });
});


function addMesh() { store.getState().createMesh('cube'); return store.getState().scene.selectedEntityId; }

test('分类、颜色覆盖与对比显示是会话状态，不写文档或撤销历史', () => {
  const id=addMesh(); const before=serializeScene(store.getState().scene); const length=store.getState().history.undoStack.length;
  const entries=[{key:id+'/root',entityId:id,nodeKey:'root',name:'模型',mobility:'static',reason:'固定几何',castShadows:true,receiveShadows:true,bakeIndirect:true,parentDynamic:false}];
  store.getState().setLightingClassification(entries);
  store.getState().setLightingDebugVisible(true);
  store.getState().setLightingComparisonEnabled(true);
  store.getState().focusLightingNode(id,'root');
  assert.equal(serializeScene(store.getState().scene),before);
  assert.equal(store.getState().history.undoStack.length,length);
  assert.deepEqual(store.getState().lightingClassification,entries);
  assert.equal(store.getState().lightingNodeFocusRequest.nodeKey,'root');
});

test('批量动静标记产生一次可撤销编辑，保存重开保留节点覆盖', () => {
  const first=addMesh(),second=addMesh(); const start=store.getState().history.undoStack.length;
  store.getState().updateEntityLightingSettings([first,second],{mobility:'dynamic',castShadows:false});
  assert.equal(store.getState().history.undoStack.length,start+1);
  for(const id of [first,second]) assert.equal(store.getState().scene.entities[id].components.lighting.mobility,'dynamic');
  store.getState().undo();
  for(const id of [first,second]) assert.equal(store.getState().scene.entities[id].components.lighting,undefined);
  store.getState().redo();
  store.getState().updateLightingNodeOverride(first,'root/rail',{mobility:'static',receiveShadows:false});
  const scene=store.getState().scene,restored=deserializeScene(serializeScene(scene));
  assert.deepEqual(restored.entities[first].components.lighting,scene.entities[first].components.lighting);
  assert.equal(restored.entities[first].components.lighting.nodeOverrides['root/rail'].mobility,'static');
});

test('部件阴影三项可显式覆盖、逐项继承和恢复默认，保存及撤销保留规则', () => {
  const id=addMesh(), nodeKey='root/rail';
  const readSettings=()=>store.getState().scene.entities[id].components.lighting;
  const resolve=()=>resolveLightingNodeSettings(readSettings(),nodeKey,{mobility:'static',reason:'固定部件'},false);
  store.getState().updateEntityLightingSettings([id],{castShadows:false,receiveShadows:true,bakeIndirect:false});
  assert.deepEqual([resolve().castShadows,resolve().receiveShadows,resolve().bakeIndirect],[false,true,false]);
  store.getState().updateLightingNodeOverride(id,nodeKey,{mobility:'static',castShadows:true,receiveShadows:false,bakeIndirect:true});
  assert.deepEqual([resolve().castShadows,resolve().receiveShadows,resolve().bakeIndirect],[true,false,true]);

  // 继承使用缺省字段，不能把当时的对象值固化成新的显式规则。
  for (const key of ['castShadows','receiveShadows','bakeIndirect']) {
    store.getState().updateLightingNodeOverride(id,nodeKey,{[key]:undefined});
    assert.equal(Object.hasOwn(readSettings().nodeOverrides[nodeKey],key),false);
    assert.equal(readSettings().nodeOverrides[nodeKey].mobility,'static');
  }
  assert.deepEqual([resolve().castShadows,resolve().receiveShadows,resolve().bakeIndirect],[false,true,false]);
  store.getState().updateEntityLightingSettings([id],{castShadows:true,receiveShadows:false,bakeIndirect:true});
  assert.deepEqual([resolve().castShadows,resolve().receiveShadows,resolve().bakeIndirect],[true,false,true]);
  const restored=deserializeScene(serializeScene(store.getState().scene));
  assert.deepEqual(restored.entities[id].components.lighting.nodeOverrides[nodeKey],{mobility:'static'});

  store.getState().updateLightingNodeOverride(id,nodeKey,{castShadows:false,receiveShadows:true,bakeIndirect:false});
  const beforeReset=structuredClone(readSettings().nodeOverrides[nodeKey]);
  store.getState().updateLightingNodeOverride(id,nodeKey,null);
  assert.equal(Object.hasOwn(readSettings().nodeOverrides,nodeKey),false);
  store.getState().undo();
  assert.deepEqual(readSettings().nodeOverrides[nodeKey],beforeReset);
  store.getState().redo();
  assert.equal(Object.hasOwn(readSettings().nodeOverrides,nodeKey),false);
});

test('部件阴影覆盖与恢复默认尊重对象锁定和运行预览', () => {
  const id=addMesh(), nodeKey='root/rail';
  store.getState().updateLightingNodeOverride(id,nodeKey,{mobility:'dynamic',castShadows:false});
  const scene=store.getState().scene;
  store.setState({scene:{...scene,entities:{...scene.entities,[id]:{...scene.entities[id],locked:true}}}});
  const before=serializeScene(store.getState().scene);
  store.getState().updateLightingNodeOverride(id,nodeKey,{receiveShadows:false,bakeIndirect:false});
  store.getState().updateLightingNodeOverride(id,nodeKey,null);
  assert.equal(serializeScene(store.getState().scene),before);
  store.setState({scene,runtimeMode:'preview'});
  const previewBefore=serializeScene(store.getState().scene);
  store.getState().updateLightingNodeOverride(id,nodeKey,{receiveShadows:false,bakeIndirect:false});
  store.getState().updateLightingNodeOverride(id,nodeKey,null);
  assert.equal(serializeScene(store.getState().scene),previewBefore);
});

test('取消烘焙不清除已有结果，迟到完成不能覆盖新状态', () => {
  addMesh(); const result=store.getState().scene.sceneSettings.lighting.result;
  store.getState().requestLightingBake(); const request=store.getState().lightingBakeRequest;
  assert.ok(request?.id);
  store.getState().cancelLightingBake();
  assert.equal(store.getState().lightingBakeRequest,null);
  assert.equal(store.getState().lightingBakeStatus.phase,'cancelled');
  store.getState().completeLightingBake(request.id,{});
  assert.equal(store.getState().scene.sceneSettings.lighting.result,result);
  assert.equal(store.getState().lightingBakeStatus.phase,'cancelled');
});

test('运行预览禁止编辑和启动烘焙，锁定对象不被批量覆盖', () => {
  const first=addMesh(),second=addMesh();
  const scene=store.getState().scene;
  store.setState({scene:{...scene,entities:{...scene.entities,[second]:{...scene.entities[second],locked:true}}}});
  store.getState().updateEntityLightingSettings([first,second],{mobility:'static'});
  assert.equal(store.getState().scene.entities[first].components.lighting.mobility,'static');
  assert.equal(store.getState().scene.entities[second].components.lighting,undefined);
  store.setState({runtimeMode:'preview'}); const before=serializeScene(store.getState().scene);
  store.getState().updateEntityLightingSettings([first],{mobility:'dynamic'});
  store.getState().requestLightingBake();
  assert.equal(serializeScene(store.getState().scene),before);
  assert.equal(store.getState().lightingBakeRequest,null);
});

test('新光照配置随场景持久化，旧场景转换到唯一新方案', () => {
  const scene=store.getState().scene;
  assert.ok(scene.sceneSettings.lighting.bake);
  const file=JSON.parse(serializeScene(scene));
  delete file.scene.sceneSettings.lighting; delete file.scene.sceneSettings.appearance;
  file.scene.sceneSettings.shadows={mode:'baked',enabled:true};
  const restored=deserializeScene(JSON.stringify(file));
  assert.equal(restored.sceneSettings.lighting.version,2);
  assert.deepEqual(restored.sceneSettings.lighting.bake,scene.sceneSettings.lighting.bake);
  assert.equal(Object.hasOwn(restored.sceneSettings,'shadows'),false);
  assert.equal(JSON.parse(serializeScene(restored)).scene.sceneSettings.lighting.version,2);
});

test('全局运行预览在烘焙进行时返回明确阻止原因', () => {
  addMesh(); store.getState().requestLightingBake();
  const readiness=store.getState().startRuntimePreview();
  assert.equal(readiness.ok,false); assert.equal(readiness.code,'lighting-bake-active');
  assert.equal(store.getState().runtimeMode,'edit');
});

function snapshotFor(scene) {
  const id=scene.selectedEntityId;
  return {version:1,signature:getSceneLightingBakeSignature(scene),createdAt:'2026-10-20T00:00:00.000Z',engineVersion:'fixture',
    assets:[{id:'g',kind:'geometry',url:'assets/lighting/geometry.json',byteLength:100},{id:'l',kind:'lightmap',url:'assets/lighting/map.png',byteLength:200},{id:'p',kind:'probes',url:'assets/lighting/probes.json',byteLength:80}],
    surfaces:[{key:id+'/root',entityId:id,nodeKey:'root',geometryAssetId:'g',lightmapAssetId:'l'}],probeAssetId:'p',
    statistics:{meshCount:1,triangleCount:12,atlasCount:1,probeCount:1,textureBytes:200,durationMs:100}};
}

test('运行时光照错误可幂等同步，恢复后不遗留错误也不写场景历史', () => {
  addMesh();
  const scene=store.getState().scene, history=store.getState().history;
  store.getState().setLightingBakeRuntimeError('静态结果已过期');
  assert.deepEqual(store.getState().lightingBakeStatus,{phase:'error',message:'静态结果已过期',source:'runtime'});
  const errorState=store.getState();
  store.getState().setLightingBakeRuntimeError('静态结果已过期');
  assert.equal(store.getState(),errorState);
  store.getState().setLightingBakeRuntimeError(null);
  assert.deepEqual(store.getState().lightingBakeStatus,{phase:'idle',message:null});
  const readyState=store.getState();
  store.getState().setLightingBakeRuntimeError(null);
  assert.equal(store.getState(),readyState);
  assert.equal(store.getState().scene,scene);
  assert.equal(store.getState().history,history);
});

test('运行时光照错误同步不覆盖进行中任务，也不清除真实任务失败', () => {
  addMesh(); store.getState().requestLightingBake();
  const preparing=store.getState();
  store.getState().setLightingBakeRuntimeError('旧结果失效');
  store.getState().setLightingBakeRuntimeError(null);
  assert.equal(store.getState(),preparing);
  store.getState().failLightingBake(preparing.lightingBakeRequest.id,'真实引擎失败');
  const failed=store.getState();
  assert.deepEqual(failed.lightingBakeStatus,{phase:'error',message:'真实引擎失败'});
  store.getState().setLightingBakeRuntimeError('旧结果失效');
  assert.equal(store.getState(),failed);
  assert.equal(store.getState().lightingBakeStatus.source,failed.lightingBakeStatus.source);
  store.getState().setLightingBakeRuntimeError(null);
  assert.equal(store.getState(),failed);
  assert.equal(store.getState().lightingBakeStatus.source,failed.lightingBakeStatus.source);
  assert.equal(store.getState().lightingBakeStatus.message,'真实引擎失败');
});

test('运行时光照错误随质量撤销恢复而清除，清除结果撤销后保留原资源', () => {
  addMesh(); store.getState().requestLightingBake();
  const snapshot=snapshotFor(store.getState().scene);
  store.getState().completeLightingBake(store.getState().lightingBakeRequest.id,snapshot);
  store.getState().updateLightingBakeSettings({quality:'high'});
  assert.notEqual(getSceneLightingBakeSignature(store.getState().scene),snapshot.signature);
  store.getState().setLightingBakeRuntimeError('静态结果已过期');
  store.getState().undo();
  assert.equal(getSceneLightingBakeSignature(store.getState().scene),snapshot.signature);
  store.getState().setLightingBakeRuntimeError(null);
  assert.equal(store.getState().lightingBakeStatus.phase,'idle');
  store.getState().clearLightingBake();
  assert.equal(store.getState().scene.sceneSettings.lighting.result,null);
  store.getState().undo();
  store.getState().setLightingBakeRuntimeError(null);
  assert.deepEqual(store.getState().scene.sceneSettings.lighting.result,snapshot);
  assert.equal(store.getState().lightingBakeStatus.phase,'idle');
});

test('有效结果原子保存并可撤销，重新烘焙失败或过期不破坏上次结果', () => {
  addMesh(); store.getState().requestLightingBake(); const request=store.getState().lightingBakeRequest;
  const snapshot=snapshotFor(store.getState().scene);
  store.getState().completeLightingBake(request.id,snapshot);
  assert.deepEqual(store.getState().scene.sceneSettings.lighting.result,snapshot);
  const restored=deserializeScene(serializeScene(store.getState().scene));
  assert.deepEqual(restored.sceneSettings.lighting.result,snapshot);
  store.getState().requestLightingBake();
  store.getState().failLightingBake(store.getState().lightingBakeRequest.id,'显存不足');
  assert.deepEqual(store.getState().scene.sceneSettings.lighting.result,snapshot);
  store.getState().requestLightingBake(); const stale=store.getState().lightingBakeRequest;
  const scene=store.getState().scene;
  store.setState({scene:{...scene,sceneSettings:{...scene.sceneSettings,lighting:{...scene.sceneSettings.lighting,bake:{...scene.sceneSettings.lighting.bake,quality:'high'}}}}});
  store.getState().completeLightingBake(stale.id,snapshot);
  assert.equal(store.getState().lightingBakeStatus.phase,'error');
  assert.deepEqual(store.getState().scene.sceneSettings.lighting.result,snapshot);
  store.getState().clearLightingBake(); assert.equal(store.getState().scene.sceneSettings.lighting.result,null);
  store.getState().undo(); assert.deepEqual(store.getState().scene.sceneSettings.lighting.result,snapshot);
});

test('节点覆盖绑定资源身份；禁止静态子节点抵消动态祖先且可删除失配项', () => {
  const id=addMesh(); const entry={key:id+'/root',entityId:id,nodeKey:'root',name:'root',mobility:'dynamic',reason:'运动',castShadows:true,receiveShadows:true,bakeIndirect:true,parentDynamic:true,resourceIdentity:'v1'};
  store.getState().setLightingClassification([entry]);
  store.getState().updateLightingNodeOverride(id,'root',{mobility:'static'});
  assert.equal(store.getState().scene.entities[id].components.lighting,undefined);
  store.getState().setLightingClassification([{...entry,parentDynamic:false}]);
  store.getState().updateLightingNodeOverride(id,'root',{mobility:'static'});
  assert.equal(store.getState().scene.entities[id].components.lighting.resourceIdentity,'v1');
  store.getState().setLightingClassification([{...entry,parentDynamic:false,resourceIdentity:'v2'}]);
  store.getState().updateLightingNodeOverride(id,'root',{mobility:'dynamic'});
  assert.equal(store.getState().scene.entities[id].components.lighting.resourceIdentity,'v1');
  store.getState().updateLightingNodeOverride(id,'root',null);
  store.getState().updateLightingNodeOverride(id,'root',{mobility:'dynamic'});
  assert.equal(store.getState().scene.entities[id].components.lighting.resourceIdentity,'v2');
});


test('混合模式发布等待新烘焙完成，不创建旧静态阴影任务', async () => {
  addMesh();
  const publishing=preparePublishLightingBake(() => {});
  const request=store.getState().lightingBakeRequest;
  assert.ok(request?.id); assert.equal(store.getState().requestShadowBake,undefined);
  store.getState().completeLightingBake(request.id,snapshotFor(store.getState().scene));
  await publishing;
});

test('取消发布会中止自己启动的GI任务并保留旧结果', async () => {
  addMesh();
  let checks=0;
  await assert.rejects(preparePublishLightingBake(() => { if(++checks>2) throw new Error('发布取消'); }), /发布取消/);
  assert.equal(store.getState().lightingBakeRequest,null);
  assert.equal(store.getState().lightingBakeStatus.phase,'cancelled');
});


test('唯一GI任务不能重复启动，准备及应用阶段均保持互斥', () => {
  addMesh(); store.getState().requestLightingBake();
  const request=store.getState().lightingBakeRequest;
  store.getState().requestLightingBake();
  assert.equal(store.getState().lightingBakeRequest.id,request.id);
  assert.equal(store.getState().requestShadowBake,undefined);
  store.getState().cancelLightingBake();
  store.setState({lightingBakeStatus:{phase:'applying',message:null}});
  store.getState().requestLightingBake();
  assert.equal(store.getState().lightingBakeRequest,null);
});

test('全部显式动态场景可直接发布且手动点击不启动无意义的GI任务', async () => {
  const id=addMesh(); store.getState().updateEntityLightingSettings([id],{mobility:'dynamic'});
 
  await preparePublishLightingBake(() => {});
  assert.equal(store.getState().lightingBakeRequest,null);
  assert.equal(store.getState().requestShadowBake,undefined);
  assert.equal(store.getState().scene.sceneSettings.lighting.result,null);
  store.getState().requestLightingBake();
  assert.equal(store.getState().lightingBakeRequest,null);
  assert.equal(store.getState().lightingBakeStatus.phase,'idle');
  assert.match(store.getState().lightingBakeStatus.message,/无需烘焙/);
});


test('复制静态实体使旧GI过期，撤销重做仍保留独立资产引用与对象设置', () => {
  const id=addMesh(); store.getState().updateEntityLightingSettings([id],{mobility:'static'});
  store.getState().requestLightingBake(); const request=store.getState().lightingBakeRequest;
  const baked=snapshotFor(store.getState().scene); store.getState().completeLightingBake(request.id,baked);
  store.getState().copySelectedEntities(); store.getState().pasteEntityClipboard();
  const copied=store.getState().scene;
  assert.equal(copied.entityIds.length,2);
  assert.deepEqual(copied.entities[copied.selectedEntityId].components.lighting,copied.entities[id].components.lighting);
  assert.notEqual(getSceneLightingBakeSignature(copied),baked.signature);
  assert.deepEqual(copied.sceneSettings.lighting.result.assets,baked.assets);
  store.getState().undo();
  assert.equal(getSceneLightingBakeSignature(store.getState().scene),baked.signature);
  store.getState().redo();
  assert.deepEqual(store.getState().scene.sceneSettings.lighting.result.assets,baked.assets);
  assert.notEqual(getSceneLightingBakeSignature(store.getState().scene),baked.signature);
});
