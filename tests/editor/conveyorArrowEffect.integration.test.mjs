import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';

const temporaryRoot = await mkdtemp(path.resolve('node_modules/.conveyor-arrow-test-'));
const previousWindow = globalThis.window;
globalThis.window ??= { addEventListener() {}, removeEventListener() {} };
const deadline = setTimeout(() => {
  console.error('输送箭头集成验证超时');
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
    || !path.basename(temporaryRoot).startsWith('.conveyor-arrow-test-')) throw new Error('测试临时目录范围无效');
  await rm(temporaryRoot, { recursive: true, force: true });
});

// 单入口预构建使所有断言共享一个 Store，避免动态 SSR 加载停滞。
const entry = path.join(temporaryRoot, 'entry.mjs');
await writeFile(entry, [
  "export { useEditorStore } from '../../src/editor/store/editorStore.ts';",
  "export { createEmptySceneDocument } from '../../src/editor/model/SceneDocument.ts';",
  "export { createCommandHistory } from '../../src/editor/commands/CommandHistory.ts';",
  "export { serializeScene, deserializeScene } from '../../src/editor/project/SceneSerializer.ts';",
  "export { POI_EFFECT_KINDS, createDefaultPoiEffectComponent } from '../../src/editor/model/poiEffect.ts';",
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
  useEditorStore, createEmptySceneDocument, createCommandHistory, serializeScene, deserializeScene,
  POI_EFFECT_KINDS, createDefaultPoiEffectComponent, createPoiEffectLibraryItems,
  encodeBuiltInAssetDragPayload, decodeBuiltInAssetDragPayload,
} = await import(pathToFileURL(path.join(temporaryRoot, 'ssr/modules.mjs')).href);
store = useEditorStore;
originalState = store.getState();
beforeEach(() => {
  store.setState(originalState, true);
  store.setState({ scene: createEmptySceneDocument('输送箭头验收'), history: createCommandHistory(),
    runtimeMode: 'edit', hierarchySelectionIds: [], entityClipboard: null, logs: [] });
});


const kinds = ['conveyor-arrow-single','conveyor-arrow-chevron','conveyor-arrow-segmented','conveyor-arrow-ribbon','conveyor-arrow-double','conveyor-arrow-speed'];
function current() { const s=store.getState().scene; return s.entities[s.selectedEntityId].components.poiEffect; }
test('六种箭头有独立库卡片、缩略图与可恢复的创建命令', () => {
  const cards=createPoiEffectLibraryItems();
  const thumbnails = new Set();
  for(const kind of kinds) {
    const card=cards.find(c=>c.builtIn?.effectKind===kind);
    assert.ok(card,kind); assert.ok(card.thumbnailUrl?.startsWith('data:image/svg+xml,')); thumbnails.add(card.thumbnailUrl);
    const payload=decodeBuiltInAssetDragPayload(encodeBuiltInAssetDragPayload(card.builtIn));
    store.getState().createPoiEffect(payload.effectKind,{x:2,y:1,z:3});
    const id=store.getState().scene.selectedEntityId;
    assert.equal(current().effectKind,kind); assert.ok(current().conveyorArrow.length>0);
    store.getState().undo(); assert.equal(store.getState().scene.entities[id],undefined);
    store.getState().redo(); assert.equal(current().effectKind,kind);
  }
  assert.equal(thumbnails.size,6);
});
test('六种箭头参数支持撤销、复制独立性及保存重开，零速零透明度不丢失', () => {
  for(const kind of kinds) {
    store.getState().createPoiEffect(kind); const id=store.getState().scene.selectedEntityId;
    const initial=structuredClone(current());
    const updated={...initial,primaryColor:'#ff8040',secondaryColor:'#ffeedd',speed:0,intensity:1.7,conveyorArrow:{length:12,width:2.4,opacity:0,count:7,reverse:true}};
    store.getState().updateSelectedPoiEffect(updated); assert.deepEqual(current(),updated);
    updated.conveyorArrow.width=99; assert.equal(current().conveyorArrow.width,2.4);
    store.getState().undo(); assert.deepEqual(current(),initial); store.getState().redo();
    const expected=structuredClone(current());
    store.getState().copySelectedEntities();store.getState().pasteEntityClipboard();
    assert.deepEqual(current(),expected); assert.notEqual(current().conveyorArrow,store.getState().scene.entities[id].components.poiEffect.conveyorArrow);
    store.getState().updateSelectedPoiEffect({...current(),conveyorArrow:{...current().conveyorArrow,opacity:0.8}});
    assert.deepEqual(store.getState().scene.entities[id].components.poiEffect,expected);
    const saved=serializeScene(store.getState().scene); const loaded=deserializeScene(saved);
    assert.deepEqual(loaded.entities[id].components.poiEffect,expected);
    assert.equal(store.getState().loadSceneFromContent(saved,'箭头重开'),true);
    assert.deepEqual(store.getState().scene.entities[id].components.poiEffect,expected);
  }
});
test('缺省新配置可恢复，数值夹紧，非法存档字段被拒绝', () => {
  store.getState().createPoiEffect(kinds[0]); const id=store.getState().scene.selectedEntityId;
  store.getState().updateSelectedPoiEffect({...current(),speed:-5,conveyorArrow:{length:-1,width:Infinity,opacity:2,count:99.8,reverse:true}});
  assert.deepEqual(current().conveyorArrow,{length:0.1,width:1.4,opacity:1,count:32,reverse:true}); assert.equal(current().speed,0);
  const saved=JSON.parse(serializeScene(store.getState().scene));
  for(const invalid of [{length:null},{width:'2'},{count:1.5},{reverse:'true'},{opacity:null}]) {
    const copy=structuredClone(saved);Object.assign(copy.scene.entities[id].components.poiEffect.conveyorArrow,invalid);
    assert.throws(()=>deserializeScene(JSON.stringify(copy)),/场景/);
  }
  delete saved.scene.entities[id].components.poiEffect.conveyorArrow;
  assert.deepEqual(deserializeScene(JSON.stringify(saved)).entities[id].components.poiEffect.conveyorArrow,createDefaultPoiEffectComponent(kinds[0]).conveyorArrow);
});
