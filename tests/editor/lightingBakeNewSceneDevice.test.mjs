import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';

const temporary = await mkdtemp(path.resolve('node_modules/.lighting-new-device-test-'));
after(async () => {
  if (path.dirname(temporary) !== path.resolve('node_modules') || !path.basename(temporary).startsWith('.lighting-new-device-test-')) throw new Error('测试目录越界');
  await rm(temporary, { recursive: true, force: true });
});
const entry = path.join(temporary, 'entry.mjs');
await writeFile(entry, [
  "export { createEmptySceneDocument, createDefaultSceneSettings } from '../../src/editor/model/SceneDocument.ts';",
  "export { serializeScene, deserializeScene } from '../../src/editor/project/SceneSerializer.ts';",
  "export { normalizeSceneLightingConfig, migrateSceneLightingDocument } from '../../electron/shared/sceneLightingConfig.ts';",
  "export { getSceneLightingBakeSignature } from '../../electron/shared/sceneLightingBakeContract.ts';",
  "export { createGlbStandardPreviewLightingConfig } from '../../electron/shared/glbStandardPreview.ts';",
  "export { createLightingManagerDraft, applyLightingManagerPreset } from '../../src/editor/panels/lightingBakeManagerModel.ts';",
  "import { createElement } from 'react'; import { renderToStaticMarkup } from 'react-dom/server';",
  "import { LightingBakeManagerOverview } from '../../src/editor/panels/LightingBakeManagerOverview.tsx';",
  "export const renderOverview = props => renderToStaticMarkup(createElement(LightingBakeManagerOverview, props));",
].join('\n'));
await build({ configFile: false, publicDir: false, logLevel: 'silent',
  build: { ssr: entry, outDir: path.join(temporary, 'ssr'), rolldownOptions: { output: { entryFileNames: 'modules.mjs' } } } });
const api = await import(pathToFileURL(path.join(temporary, 'ssr/modules.mjs')).href);
const effectiveDevice = lighting => lighting.bake.device ?? 'cpu';

test('仅新建factory明确写auto；质量参数不变且新文档serialize/normalize保留', () => {
  const scene = api.createEmptySceneDocument('B3 新场景');
  const legacy = api.normalizeSceneLightingConfig(undefined);
  assert.equal(scene.sceneSettings.lighting.bake.device, 'auto');
  assert.equal(api.createDefaultSceneSettings().lighting.bake.device, 'auto');
  const { device: _device, ...remaining } = scene.sceneSettings.lighting.bake;
  assert.deepEqual(remaining, legacy.bake);
  assert.equal(Object.hasOwn(legacy.bake, 'device'), false);
  const reopened = api.deserializeScene(api.serializeScene(scene));
  assert.deepEqual(reopened.sceneSettings.lighting.bake, scene.sceneSettings.lighting.bake);
});

test('v1–6旧文档缺settings/lighting/device仍CPU，不在规范化或另存中补auto', () => {
  const envelope = JSON.parse(api.serializeScene(api.createEmptySceneDocument('legacy')));
  for (const version of [1, 2, 3, 4, 5, 6]) for (const missing of ['settings', 'lighting', 'device']) {
    const old = structuredClone(envelope); old.version = version;
    if (missing === 'settings') delete old.scene.sceneSettings;
    else if (missing === 'lighting') delete old.scene.sceneSettings.lighting;
    else delete old.scene.sceneSettings.lighting.bake.device;
    const input = JSON.stringify(old), loaded = api.deserializeScene(input);
    assert.equal(effectiveDevice(loaded.sceneSettings.lighting), 'cpu', version + ':' + missing);
    assert.equal(Object.hasOwn(loaded.sceneSettings.lighting.bake, 'device'), false);
    const normalized = api.migrateSceneLightingDocument(loaded);
    const saved = JSON.parse(api.serializeScene(normalized));
    assert.equal(Object.hasOwn(saved.scene.sceneSettings.lighting.bake, 'device'), false);
    assert.equal(api.deserializeScene(JSON.stringify(saved)).sceneSettings.lighting.bake.device, undefined);
    assert.equal(JSON.stringify(old), input, '加载不改输入');
  }
});

test('显式cpu/gpu/auto经旧版本导入/预设/保存保持；设备不进入GI输入签名', () => {
  const envelope = JSON.parse(api.serializeScene(api.createEmptySceneDocument('explicit')));
  for (const version of [1, 2, 3, 4, 5, 6]) for (const device of ['cpu', 'gpu', 'auto']) {
    const old = structuredClone(envelope); old.version = version; old.scene.sceneSettings.lighting.bake.device = device;
    const loaded = api.deserializeScene(JSON.stringify(old));
    assert.equal(loaded.sceneSettings.lighting.bake.device, device);
    assert.equal(api.deserializeScene(api.serializeScene(loaded)).sceneSettings.lighting.bake.device, device);
    assert.equal(api.createGlbStandardPreviewLightingConfig(loaded.sceneSettings.lighting).bake.device, device);
    for (const preset of ['industrial-daylight', 'glb-standard-preview']) {
      const draft = api.applyLightingManagerPreset(api.createLightingManagerDraft(loaded, 'b3'), preset, 'lighting');
      assert.equal(draft.lighting.bake.device, device);
    }
    const signature = api.getSceneLightingBakeSignature(loaded);
    for (const next of ['cpu', 'gpu', 'auto']) {
      const changed = structuredClone(loaded); changed.sceneSettings.lighting.bake.device = next;
      assert.equal(api.getSceneLightingBakeSignature(changed), signature);
    }
  }
  const legacy = api.normalizeSceneLightingConfig(undefined);
  assert.equal(api.createGlbStandardPreviewLightingConfig(legacy).bake.device, undefined);
});

test('管理器新auto/旧缺省CPU选择正确，标签只说明新场景默认', () => {
  const scene = api.createEmptySceneDocument('B3 UI');
  const noop = () => {};
  const props = lighting => ({ scene, lighting, appearance: scene.sceneSettings.appearance, result: null, resultLabel: '未烘焙',
    disabled: false, dirty: false, previewDraftActive: false, previewDraftSuppressed: false, previewDraftRules: false, preflightBusy: false,
    engineStatus: null, engineStatusLoading: false, preview: null, debug: false, comparison: false, motionPreview: false, busy: false,
    onRefreshDevices: noop, onConfigureEngine: noop, onPreviewDraft: noop, onCheck: noop, onLightingChange: noop, onAppearanceChange: noop,
    onPreset: noop, onDebug: noop, onComparison: noop, onMotion: noop, onRefresh: noop });
  const current = api.renderOverview(props(scene.sceneSettings.lighting));
  assert.match(current, /value="auto" selected=""[^>]*>[^<]*新场景默认/);
  assert.doesNotMatch(current, /CPU（默认）/);
  const old = api.renderOverview(props(api.normalizeSceneLightingConfig(undefined)));
  assert.match(old, /value="cpu" selected=""/);
});
