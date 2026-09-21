import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';

const temporaryRoot = await mkdtemp(path.resolve('node_modules/.light-wall-test-'));
const previousWindow = globalThis.window;
globalThis.window ??= { addEventListener() {}, removeEventListener() {} };
const deadline = setTimeout(() => {
  console.error('光墙围栏集成验证超时');
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
    || !path.basename(temporaryRoot).startsWith('.light-wall-test-')) throw new Error('测试临时目录范围无效');
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
  store.setState({ scene: createEmptySceneDocument('光墙围栏验收'), history: createCommandHistory(),
    runtimeMode: 'edit', hierarchySelectionIds: [], entityClipboard: null, logs: [] });
});

const concavePoints = [
  { x: -7, z: -5 }, { x: 7, z: -5 }, { x: 7, z: 0 },
  { x: 3, z: 0 }, { x: 3, z: 5 }, { x: -7, z: 5 },
];
function selectedEffect() {
  const state = store.getState();
  return state.scene.entities[state.scene.selectedEntityId].components.poiEffect;
}
function addWall() {
  store.getState().createPoiEffect('light-wall-fence', { x: 12, y: 0.4, z: -9 });
  return store.getState().scene.selectedEntityId;
}
function configuredWall(opacity = 0.6, speed = 1.7) {
  return { ...selectedEffect(), primaryColor: '#ff8040', speed,
    lightWall: { height: 4.5, opacity, points: structuredClone(concavePoints) } };
}

test('特效库登记和拖拽载荷可创建默认 10 × 8 米光墙围栏', () => {
  const cards = createPoiEffectLibraryItems();
  const walls = cards.filter(card => card.builtIn.effectKind === 'light-wall-fence');
  assert.equal(walls.length, 1);
  assert.equal(walls[0].name, '光墙围栏');
  const payload = decodeBuiltInAssetDragPayload(encodeBuiltInAssetDragPayload(walls[0].builtIn));
  assert.deepEqual(payload, { kind: 'poi-effect', effectKind: 'light-wall-fence' });
  store.getState().createPoiEffect(payload.effectKind, { x: 12, y: 0.4, z: -9 });
  const entity = store.getState().scene.entities[store.getState().scene.selectedEntityId];
  assert.equal(entity.name, '光墙围栏');
  assert.deepEqual(entity.components.transform.position, { x: 12, y: 0.4, z: -9 });
  assert.deepEqual(entity.components.poiEffect.lightWall, { height: 3, opacity: 0.75,
    points: [{ x: -5, z: -4 }, { x: 5, z: -4 }, { x: 5, z: 4 }, { x: -5, z: 4 }] });
  const entityId = entity.id;
  store.getState().undo();
  assert.equal(store.getState().scene.entities[entityId], undefined);
  store.getState().redo();
  assert.deepEqual(store.getState().scene.entities[entityId], entity);
});

test('颜色、高度、零透明度和零速度与凹轮廓一起支持撤销重做', () => {
  addWall();
  const before = structuredClone(selectedEffect());
  const requested = configuredWall(0, 0);
  store.getState().updateSelectedPoiEffect(requested, '更新光墙围栏');
  assert.deepEqual(selectedEffect(), requested);
  const after = structuredClone(selectedEffect());
  requested.lightWall.points[0].x = -100;
  assert.deepEqual(selectedEffect(), after, 'Store 不保留调用方的轮廓引用');
  store.getState().undo();
  assert.deepEqual(selectedEffect(), before);
  store.getState().redo();
  assert.deepEqual(selectedEffect(), after);
  const history = store.getState().history;
  store.getState().updateSelectedPoiEffect(structuredClone(after));
  assert.equal(store.getState().history, history, '相同配置不新增撤销记录');
});

test('复制粘贴拥有独立轮廓，编辑副本和撤销不影响源实体', () => {
  const originalId = addWall();
  store.getState().updateSelectedPoiEffect(configuredWall());
  const originalEffect = selectedEffect();
  store.getState().copySelectedEntities();
  store.getState().pasteEntityClipboard();
  const copyId = store.getState().scene.selectedEntityId;
  assert.notEqual(copyId, originalId);
  assert.deepEqual(selectedEffect(), originalEffect);
  assert.notEqual(selectedEffect().lightWall, originalEffect.lightWall);
  assert.notEqual(selectedEffect().lightWall.points, originalEffect.lightWall.points);
  assert.notEqual(selectedEffect().lightWall.points[0], originalEffect.lightWall.points[0]);
  const copyBefore = structuredClone(selectedEffect());
  store.getState().updateSelectedPoiEffect({ ...selectedEffect(),
    lightWall: { ...selectedEffect().lightWall, height: 8, points: selectedEffect().lightWall.points.map(p => ({ x: p.x * 2, z: p.z * 2 })) } });
  assert.deepEqual(store.getState().scene.entities[originalId].components.poiEffect, originalEffect);
  store.getState().undo();
  assert.deepEqual(store.getState().scene.entities[copyId].components.poiEffect, copyBefore);
  assert.deepEqual(store.getState().scene.entities[originalId].components.poiEffect, originalEffect);
});

test('锁定和运行预览禁止修改配置及历史', () => {
  const id = addWall();
  const requested = configuredWall();
  store.getState().toggleEntityLocked(id);
  let scene = store.getState().scene;
  let history = store.getState().history;
  store.getState().updateSelectedPoiEffect(requested);
  assert.equal(store.getState().scene, scene);
  assert.equal(store.getState().history, history);
  store.getState().toggleEntityLocked(id);
  store.setState({ runtimeMode: 'preview' });
  scene = store.getState().scene;
  history = store.getState().history;
  store.getState().updateSelectedPoiEffect(requested);
  store.getState().createPoiEffect('light-wall-fence');
  store.getState().undo();
  store.getState().redo();
  assert.equal(store.getState().scene, scene);
  assert.equal(store.getState().history, history);
});

test('保存和重新打开保留全部光墙参数，生成双包验收场景', async () => {
  const id = addWall();
  store.getState().updateSelectedPoiEffect(configuredWall());
  store.getState().updateSelectedTransform('rotation', 'y', Math.PI / 5);
  store.getState().updateSelectedTransform('scale', 'x', 1.2);
  const expected = { ...structuredClone(store.getState().scene.entities[id]), isFolder: false };
  const content = serializeScene(store.getState().scene);
  assert.deepEqual(deserializeScene(content).entities[id], expected);
  assert.equal(store.getState().loadSceneFromContent(content, '光墙围栏重新打开'), true);
  assert.deepEqual(store.getState().scene.entities[id], expected);
  assert.equal(store.getState().hasUnsavedChanges(), false);
  const output = path.resolve('output/light-wall-fence');
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, 'scene.scene.json'), content, 'utf8');
  store.getState().selectEntity(id);
  store.getState().updateSelectedPoiEffect(configuredWall(0, 0));
  const zeroContent = serializeScene(store.getState().scene);
  assert.equal(deserializeScene(zeroContent).entities[id].components.poiEffect.lightWall.opacity, 0);
  assert.equal(deserializeScene(zeroContent).entities[id].components.poiEffect.speed, 0);
});

test('读取场景拒绝自交、退化、超限、缺字段和非法坐标轮廓', () => {
  addWall();
  const valid = JSON.parse(serializeScene(store.getState().scene));
  const invalidPoints = [
    [{ x: 0, z: 0 }, { x: 4, z: 4 }, { x: 0, z: 4 }, { x: 4, z: 0 }],
    [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }],
    [{ x: 0, z: 0 }, { x: 0, z: 0 }, { x: 2, z: 2 }],
    [{ x: 0, z: 0 }, { x: 100001, z: 0 }, { x: 0, z: 4 }],
    [{ x: 0, z: 0 }, { x: null, z: 0 }, { x: 0, z: 4 }],
    [{ x: 0, z: 0 }, { x: '4', z: 0 }, { x: 0, z: 4 }],
    Array.from({ length: 129 }, (_, i) => ({ x: Math.cos(i), z: Math.sin(i) })),
    [], null, undefined,
  ];
  for (const points of invalidPoints) {
    const changed = structuredClone(valid);
    const effect = Object.values(changed.scene.entities).find(entity => entity.components.poiEffect).components.poiEffect;
    effect.lightWall.points = points;
    assert.throws(() => deserializeScene(JSON.stringify(changed)), /场景/);
  }
});

test('缺省 lightWall 配置兼容默认矩形，16 种既有效果保持配置和序列化行为', () => {
  addWall();
  const valid = JSON.parse(serializeScene(store.getState().scene));
  const id = store.getState().scene.selectedEntityId;
  delete valid.scene.entities[id].components.poiEffect.lightWall;
  assert.deepEqual(deserializeScene(JSON.stringify(valid)).entities[id].components.poiEffect.lightWall,
    createDefaultPoiEffectComponent('light-wall-fence').lightWall);
  const legacyKinds = ['alarm-pulse', 'warning-beacon', 'locator-beam', 'radar-scan', 'fire', 'smoke', 'sparks',
    'steam-leak', 'gas-leak', 'water-jet', 'pipeline-flow-particles', 'pipeline-flow-arrows', 'moving-double-arrow',
    'cargo-target-frame', 'conveyor-direction', 'evacuation-route'];
  assert.deepEqual(POI_EFFECT_KINDS.filter(kind => kind !== 'light-wall-fence'), legacyKinds);
  const created = legacyKinds.map(kind => {
    store.getState().createPoiEffect(kind);
    const entityId = store.getState().scene.selectedEntityId;
    assert.deepEqual(selectedEffect(), createDefaultPoiEffectComponent(kind));
    assert.equal(Object.hasOwn(selectedEffect(), 'lightWall'), false);
    store.getState().updateSelectedPoiEffect({ ...selectedEffect(), speed: 0 });
    assert.equal(selectedEffect().speed, 0.1, '旧效果最小速度保持 0.1');
    return [entityId, structuredClone(selectedEffect())];
  });
  const reopened = deserializeScene(serializeScene(store.getState().scene));
  for (const [entityId, effect] of created) assert.deepEqual(reopened.entities[entityId].components.poiEffect, effect);
});
