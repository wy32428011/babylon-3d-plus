import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const temporaryRoot = await mkdtemp(path.resolve('node_modules/.scene-opening-test-'));
const previousWindow = globalThis.window;
globalThis.window ??= { addEventListener() {}, removeEventListener() {} };
let store;
let originalState;
after(async () => {
  if (store && originalState) store.setState(originalState, true);
  if (previousWindow === undefined) delete globalThis.window;
  else globalThis.window = previousWindow;
  if (path.dirname(temporaryRoot) !== path.resolve('node_modules')
    || !path.basename(temporaryRoot).startsWith('.scene-opening-test-')) throw new Error('测试临时目录范围无效');
  await rm(temporaryRoot, { recursive: true, force: true });
});

const entry = path.join(temporaryRoot, 'entry.mjs');
await writeFile(entry, [
  "export { useEditorStore } from '../../src/editor/store/editorStore.ts';",
  "export { createEmptySceneDocument } from '../../src/editor/model/SceneDocument.ts';",
  "export { createCommandHistory } from '../../src/editor/commands/CommandHistory.ts';",
  "export { serializeScene, deserializeScene } from '../../src/editor/project/SceneSerializer.ts';",
  "export { SceneOpeningAnimationPanel } from '../../src/editor/panels/SceneOpeningAnimationPanel.tsx';",
  "export { createOpeningPackageBinding } from '../../src/shared/opening/openingPackage.ts';",
].join('\n'));
await build({
  configFile: false, publicDir: false, logLevel: 'silent',
  ssr: { noExternal: ['@linkiez/dxf-renew', /^lodash\//] },
  build: { ssr: entry, outDir: path.join(temporaryRoot, 'ssr'),
    rolldownOptions: { output: { entryFileNames: 'modules.mjs' } } },
});
const { useEditorStore, createEmptySceneDocument, createCommandHistory, serializeScene, deserializeScene, SceneOpeningAnimationPanel, createOpeningPackageBinding }
  = await import(pathToFileURL(path.join(temporaryRoot, 'ssr/modules.mjs')).href);
store = useEditorStore;
originalState = store.getState();
beforeEach(() => {
  store.setState(originalState, true);
  store.setState({ scene: createEmptySceneDocument('开场验收'), history: createCommandHistory(),
    runtimeMode: 'edit', sceneSessionId: 'opening-test-session', logs: [] });
});

test('插件绑定和各场景完整配置可保存回读，撤销只恢复开场且不污染同包实例', () => {
  const definition = {
    manifest: { formatVersion: 1, runtimeApiVersion: 1, id: 'test.brand', version: '1.0.0', name: '品牌开场', renderer: 'timeline', assets: [] },
    schema: { type: 'object', properties: { title: { type: 'string' }, shown: { type: 'boolean' } } },
    uiSchema: { groups: [{ title: '文案', fields: ['title', 'shown'] }] }, defaults: { title: '初始文案', shown: false },
    timeline: { stages: [{ id: 'brand', label: '品牌', durationSeconds: 0, titleKey: 'title', routes: [] }] },
  };
  const binding = createOpeningPackageBinding(definition, 'project/assets/openings/test/manifest.json', 'a'.repeat(64));
  const other = createOpeningPackageBinding(definition, binding.manifestUrl, binding.contentHash);
  store.getState().updateSceneOpeningAnimation({ template: 'package', package: binding, enabled: true });
  const original = structuredClone(store.getState().scene.sceneSettings.openingAnimation);
  const edited = structuredClone(binding);
  edited.config.values.title = '';
  edited.config.stages[0].routes = [{ id: 'route', name: '目的地', from: { x: 0, y: 0 }, to: { x: 1, y: 1 }, speed: 0, pulse: false }];
  store.getState().updateSceneOpeningAnimation({ package: edited });
  assert.deepEqual(deserializeScene(serializeScene(store.getState().scene)).sceneSettings.openingAnimation.package, edited);
  assert.equal(other.config.values.title, '初始文案');
  assert.deepEqual(other.config.stages[0].routes, []);
  const scene = store.getState().scene;
  store.setState({ scene: { ...scene, sceneSettings: { ...scene.sceneSettings, camera: { ...scene.sceneSettings.camera, viewDistance: 3210 } } } });
  store.getState().undo();
  assert.deepEqual(store.getState().scene.sceneSettings.openingAnimation, original);
  assert.equal(store.getState().scene.sceneSettings.camera.viewDistance, 3210);
  store.getState().redo();
  assert.deepEqual(store.getState().scene.sceneSettings.openingAnimation.package, edited);
  assert.equal(store.getState().scene.sceneSettings.camera.viewDistance, 3210);
});

test('开场更新可保存回读，撤销重做只恢复开场配置并保留后来修改的相机', () => {
  const before = store.getState().scene.sceneSettings.openingAnimation;
  store.getState().updateSceneOpeningAnimation({ enabled: true, title: '惠山数字孪生', allowSkip: false });
  const after = store.getState().scene.sceneSettings.openingAnimation;
  assert.equal(store.getState().history.undoStack.length, 1);
  assert.deepEqual(deserializeScene(serializeScene(store.getState().scene)).sceneSettings.openingAnimation, after);
  const scene = store.getState().scene;
  store.setState({ scene: { ...scene, sceneSettings: { ...scene.sceneSettings,
    camera: { ...scene.sceneSettings.camera, viewDistance: 2000 } } } });
  store.getState().undo();
  assert.deepEqual(store.getState().scene.sceneSettings.openingAnimation, before);
  assert.equal(store.getState().scene.sceneSettings.camera.viewDistance, 2000);
  store.getState().redo();
  assert.deepEqual(store.getState().scene.sceneSettings.openingAnimation, after);
  assert.equal(store.getState().scene.sceneSettings.camera.viewDistance, 2000);
});

test('旧场景缺少开场字段仍可回读且不开启，重复提交不堆叠历史，运行预览不能修改配置', () => {
  const file = JSON.parse(serializeScene(store.getState().scene));
  delete file.scene.sceneSettings.openingAnimation;
  assert.equal(deserializeScene(JSON.stringify(file)).sceneSettings.openingAnimation.enabled, false);
  store.getState().updateSceneOpeningAnimation({ enabled: false });
  assert.equal(store.getState().history.undoStack.length, 0);
  store.setState({ runtimeMode: 'preview' });
  store.getState().updateSceneOpeningAnimation({ enabled: true });
  assert.equal(store.getState().scene.sceneSettings.openingAnimation.enabled, false);
  assert.equal(store.getState().history.undoStack.length, 0);
});

test('预览与停止请求互相替换且旧请求、旧会话不能消费新请求；不修改保存相机和历史', () => {
  const scene = store.getState().scene;
  store.getState().requestOpeningAnimationPreview('play');
  const play = store.getState().openingAnimationPreviewRequest;
  assert.equal(play.action, 'play');
  assert.equal(play.sceneSessionId, 'opening-test-session');
  store.getState().requestOpeningAnimationPreview('stop');
  const stop = store.getState().openingAnimationPreviewRequest;
  store.getState().consumeOpeningAnimationPreviewRequest(play.requestId, play.sceneSessionId);
  assert.deepEqual(store.getState().openingAnimationPreviewRequest, stop);
  store.getState().consumeOpeningAnimationPreviewRequest(stop.requestId, 'old-session');
  assert.deepEqual(store.getState().openingAnimationPreviewRequest, stop);
  store.getState().consumeOpeningAnimationPreviewRequest(stop.requestId, stop.sceneSessionId);
  assert.equal(store.getState().openingAnimationPreviewRequest, null);
  assert.equal(store.getState().scene, scene);
  assert.equal(store.getState().history.undoStack.length, 0);
});

test('中国地区增改删与停留可以保存及撤销，全球飞线和关闭状态独立保留', () => {
  const before = store.getState().scene.sceneSettings.openingAnimation;
  const locations = [{ name: '新地区', longitude: 118.5, latitude: 32.5 }];
  store.getState().updateSceneOpeningAnimation({ chinaHoldSeconds: 12.5, chinaDestinations: locations });
  const after = store.getState().scene.sceneSettings.openingAnimation;
  assert.equal(after.enabled, false);
  assert.equal(after.chinaHoldSeconds, 12.5);
  assert.deepEqual(after.chinaDestinations, locations);
  assert.deepEqual(after.destinations, before.destinations);
  assert.deepEqual(deserializeScene(serializeScene(store.getState().scene)).sceneSettings.openingAnimation, after);
  store.getState().undo();
  assert.deepEqual(store.getState().scene.sceneSettings.openingAnimation, before);
  store.getState().redo();
  assert.deepEqual(store.getState().scene.sceneSettings.openingAnimation, after);
  store.getState().updateSceneOpeningAnimation({ chinaHoldSeconds: 0, chinaDestinations: [] });
  const cleared = deserializeScene(serializeScene(store.getState().scene)).sceneSettings.openingAnimation;
  assert.equal(cleared.chinaHoldSeconds, 0);
  assert.deepEqual(cleared.chinaDestinations, []);
  assert.deepEqual(cleared.destinations, before.destinations);
  store.getState().undo();
  assert.deepEqual(store.getState().scene.sceneSettings.openingAnimation, after);
});

test('旧开场场景缺中国字段回读默认地区和六秒，不改变原来开关与全球配置', () => {
  const file = JSON.parse(serializeScene(store.getState().scene));
  file.scene.sceneSettings.openingAnimation.enabled = true;
  file.scene.sceneSettings.openingAnimation.destinations = [];
  delete file.scene.sceneSettings.openingAnimation.chinaHoldSeconds;
  delete file.scene.sceneSettings.openingAnimation.chinaDestinations;
  const restored = deserializeScene(JSON.stringify(file)).sceneSettings.openingAnimation;
  assert.equal(restored.enabled, true);
  assert.equal(restored.chinaHoldSeconds, 6);
  assert.deepEqual(restored.chinaDestinations.map(location => location.name), ['四川', '上海', '杭州', '深圳', '安徽']);
  assert.deepEqual(restored.destinations, []);
});

test('配置面板显示62秒参考模板、两组UV点位和实际生效配置，保留折叠外壳', () => {
  const initial = renderToStaticMarkup(createElement(SceneOpeningAnimationPanel));
  const text = initial.replace(/<[^>]*>/g, '');
  assert.match(text, /参考动画总时长：62 秒/);
  assert.match(text, /全球飞线停留（秒）/);
  assert.match(text, /国内飞线停留（秒）/);
  assert.match(text, /全球参考点位（40）/);
  assert.match(text, /国内参考点位（34）/);
  assert.match(text, /全球起点 UV X/);
  assert.match(text, /国内起点 UV Y/);
  assert.match(text, /品牌与公司文案/);
  assert.match(initial, /collapsible-fieldset/);
  assert.doesNotMatch(initial, />目的地经度<|>中国停留（秒）</);
  assert.match(text, /科技呼吸效果/);
  assert.match(text, /呼吸强度（%）/);
  assert.match(text, /呼吸周期（秒）/);
});

test('参考配置完整保存重开与撤销重做，独立修改不回写旧地理档案和相机', () => {
  const before = store.getState().scene.sceneSettings.openingAnimation;
  const reference = { ...before.reference, brandName: '用户品牌', companyName: '测试公司',
    heroTitle: '从全球\n抵达项目', heroSubtitle: '', finaleTitle: '欢迎进入场景', quality: 'low', showUI: false,
    stageDurations: [9, 7, 0, 6, 4, 0, 6, 6, 8], worldOrigin: { x: 0, y: 0 },
    worldDestinations: [], chinaDestinations: [{ name: '自定义参考点', x: .42, y: .73 }] };
  store.getState().updateSceneOpeningAnimation({ reference });
  const after = store.getState().scene.sceneSettings.openingAnimation;
  assert.deepEqual(after.reference, reference);
  assert.equal(after.durationSeconds, before.durationSeconds);
  assert.equal(after.chinaHoldSeconds, before.chinaHoldSeconds);
  assert.deepEqual(after.chinaDestinations, before.chinaDestinations);
  assert.deepEqual(after.destinations, before.destinations);
  assert.deepEqual(deserializeScene(serializeScene(store.getState().scene)).sceneSettings.openingAnimation.reference, reference);
  store.getState().undo();
  assert.deepEqual(store.getState().scene.sceneSettings.openingAnimation, before);
  store.getState().redo();
  assert.deepEqual(store.getState().scene.sceneSettings.openingAnimation, after);
});

test('呼吸关闭和零强度保存重开与撤销重做一致，不影响时长或地区列表', () => {
  const before = store.getState().scene.sceneSettings.openingAnimation;
  store.getState().updateSceneOpeningAnimation({ breathingEnabled: false, breathingIntensity: 0, breathingPeriodSeconds: 8.5 });
  const changed = store.getState().scene.sceneSettings.openingAnimation;
  assert.equal(changed.breathingEnabled, false);
  assert.equal(changed.breathingIntensity, 0);
  assert.equal(changed.breathingPeriodSeconds, 8.5);
  assert.equal(changed.chinaHoldSeconds, before.chinaHoldSeconds);
  assert.equal(changed.durationSeconds, before.durationSeconds);
  assert.deepEqual(changed.destinations, before.destinations);
  assert.deepEqual(changed.chinaDestinations, before.chinaDestinations);
  assert.deepEqual(deserializeScene(serializeScene(store.getState().scene)).sceneSettings.openingAnimation, changed);
  store.getState().undo();
  assert.deepEqual(store.getState().scene.sceneSettings.openingAnimation, before);
  store.getState().redo();
  assert.deepEqual(store.getState().scene.sceneSettings.openingAnimation, changed);
  store.getState().updateSceneOpeningAnimation({ enabled: true, breathingEnabled: true });
  assert.equal(store.getState().scene.sceneSettings.openingAnimation.breathingIntensity, 0);
});

test('已开启的旧开场配置缺呼吸字段时重开补默认，原有零秒与空列表继续保留', () => {
  const file = JSON.parse(serializeScene(store.getState().scene));
  const opening = file.scene.sceneSettings.openingAnimation;
  opening.enabled = true;
  opening.chinaHoldSeconds = 0;
  opening.chinaDestinations = [];
  delete opening.breathingEnabled;
  delete opening.breathingIntensity;
  delete opening.breathingPeriodSeconds;
  const restored = deserializeScene(JSON.stringify(file)).sceneSettings.openingAnimation;
  assert.equal(restored.enabled, true);
  assert.equal(restored.breathingEnabled, true);
  assert.equal(restored.breathingIntensity, 0.65);
  assert.equal(restored.breathingPeriodSeconds, 4);
  assert.equal(restored.chinaHoldSeconds, 0);
  assert.deepEqual(restored.chinaDestinations, []);
});
