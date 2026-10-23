import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';

const temporary = await mkdtemp(path.resolve('node_modules/.lighting-controller-'));
const entry = path.join(temporary, 'entry.mjs');
await writeFile(entry, [
  "export { EnvironmentAndSkyboxController } from '../../src/runtime/babylon/scene-runtime/EnvironmentAndSkyboxController.ts';",
  "export { normalizeSceneLightingConfig, normalizeSceneAppearanceConfig } from '../../electron/shared/sceneLightingConfig.ts';",
].join('\n'));
await build({ configFile: false, publicDir: false, logLevel: 'silent',
  build: { ssr: entry, outDir: path.join(temporary, 'dist'), rolldownOptions: { output: { entryFileNames: 'entry.mjs' } } } });
const { EnvironmentAndSkyboxController, normalizeSceneLightingConfig, normalizeSceneAppearanceConfig }
  = await import(pathToFileURL(path.join(temporary, 'dist/entry.mjs')).href);
after(async () => {
  assert.equal(path.dirname(temporary), path.resolve('node_modules'));
  assert.match(path.basename(temporary), /^\.lighting-controller-/);
  await rm(temporary, { recursive: true, force: true });
});
function fixture(sync = () => Promise.resolve()) {
  const events = [], lighting = normalizeSceneLightingConfig(), appearance = normalizeSceneAppearanceConfig();
  const document = { sceneSettings: { lighting, appearance }, entities: {} };
  const controller = Object.create(EnvironmentAndSkyboxController.prototype);
  Object.assign(controller, { draftPreviewGeneration: 0, appearanceSignature: '', skyboxLightingSignature: '',
    context: { pushLog() {} }, dependencies: { document: { shadowDocument: document, isEntityVisible: () => true },
      effects: { poiEffectRuntime: { isDayNightCycleActive: () => false, setGlobalLightingControl() {}, setAppearance() {} } }, presentation: { lights: new Map() } },
    lightingRuntime: { setTemporaryLightingPreview: (active, suppressed) => events.push({ active, suppressed }) },
    lightRigRuntime: { sync: value => events.push({ intensity: value.main.intensity }), mainLight: null },
    appearanceRuntime: { sync: value => events.push({ exposure: value.exposure }) },
    shadowRuntime: { setManagedLight() {}, applySettings() {} },
    skyboxRuntime: { setLightingOverrides() {}, getReadiness: () => ({ phase: 'ready' }) },
    environmentRuntime: { syncLighting: sync },
  });
  return { controller, events, document, lighting, appearance };
}
test('恢复预览等待真实环境同步后才归还GI，并保留实际文档', async () => {
  let resolve;
  const f = fixture(() => new Promise(r => { resolve = r; }));
  const pending = f.controller.setLightingDraftPreview(null);
  await Promise.resolve();
  assert.equal(f.events.some(event => event.active === false), false);
  assert.equal(f.controller.dependencies.document.shadowDocument, f.document);
  resolve(); await pending;
  assert.deepEqual(f.events.at(-1), { active: false, suppressed: false });
});
test('恢复失败向调用方报告，并归还正常失效验证', async () => {
  const f = fixture(() => Promise.reject(new Error('环境资源损坏')));
  await assert.rejects(f.controller.setLightingDraftPreview(null), /环境资源损坏/);
  assert.deepEqual(f.events.at(-1), { active: false, suppressed: false });
});
test('纯曝光草稿不暂停真实灯光失效检查，也不修改原场景', async () => {
  const f = fixture();
  await f.controller.setLightingDraftPreview({ lighting: f.lighting, appearance: { ...f.appearance, exposure: 1.4 }, suppressIndirect: false });
  assert.deepEqual(f.events[0], { active: false, suppressed: false });
  assert.equal(f.events.some(event => event.exposure === 1.4), true);
  assert.equal(f.controller.dependencies.document.shadowDocument, f.document);
  assert.notEqual(f.document.sceneSettings.appearance.exposure, 1.4);
});
test('同步恢复错误也必须归还临时GI标记', async () => {
  const f = fixture();
  f.controller.appearanceRuntime.sync = () => { throw new Error('显示同步失败'); };
  await assert.rejects(f.controller.setLightingDraftPreview(null), /显示同步失败/);
  assert.deepEqual(f.events.at(-1), { active: false, suppressed: false });
});
test('环境加载最终失败不能被报告成预览恢复成功', async () => {
  const f = fixture();
  f.controller.skyboxRuntime.getReadiness = () => ({ phase: 'error', message: '原环境读取失败' });
  await assert.rejects(f.controller.setLightingDraftPreview(null), /原环境读取失败/);
  assert.deepEqual(f.events.at(-1), { active: false, suppressed: false });
});
test('手动预检重新读取后提交的环境源，不沿用先前分类缓存', async () => {
  const f = fixture(), previousWindow = globalThis.window;
  let refreshed = false;
  Object.assign(f.controller.dependencies, { readiness: { activeModelLoadProgress: new Map() }, assets: { models: new Map() } });
  f.controller.environmentRuntime.getSnapshot = () => ({ phase: 'ready' });
  f.controller.lightingRuntime.whenReady = () => Promise.resolve();
  f.controller.lightingRuntime.markDirty = () => { refreshed = true; };
  f.controller.lightingRuntime.captureBakeInput = async () => {
    assert.equal(refreshed, true, '模型ready和文档引用不变时仍须刷新实际源目录');
    return { version: 1, meshes: [], signature: 'physical', settings: {}, lights: [], environment: {} };
  };
  globalThis.window = { editorApi: { preflightLightingBake: async () => ({ signature: 'physical', issues: [] }) } };
  try { assert.equal((await f.controller.preflightLightingBake(f.document)).signature, 'physical'); }
  finally { if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow; }
});
