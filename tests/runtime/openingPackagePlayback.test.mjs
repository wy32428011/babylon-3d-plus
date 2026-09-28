import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';
import { Open } from 'unzipper';
import { buildOpeningPackages } from '../../scripts/build-opening-packages.mjs';
import { validateOpeningPackageDefinition, createOpeningPackageBinding } from '../../electron/shared/openingPackage.ts';

const temporaryRoot = await mkdtemp(path.resolve('node_modules/.opening-package-playback-'));
after(async () => {
  if (path.dirname(temporaryRoot) !== path.resolve('node_modules') || !path.basename(temporaryRoot).startsWith('.opening-package-playback-')) throw new Error('测试清理范围无效');
  await rm(temporaryRoot, { recursive: true, force: true });
});
const packages = await buildOpeningPackages(path.join(temporaryRoot, 'packages'));
const entry = path.join(temporaryRoot, 'entry.mjs');
await writeFile(entry, [
  "export { createOpeningVisualPlan } from '../../src/runtime/opening/createOpeningVisualPlan.ts';",
  "export { createDefaultSceneOpeningAnimation } from '../../src/editor/model/sceneOpeningAnimation.ts';",
  "export { GeographicOpeningRuntime } from '../../src/runtime/opening/GeographicOpeningRuntime.ts';",
  "export { OpeningPackageAssets } from '../../src/runtime/opening/openingPackageAssets.ts';",
  "export { installDeploymentAssetManifest, clearDeploymentAssetManifest } from '../../src/runtime/assets/editorAssetUrl.ts';",
].join('\n'));
await build({ configFile: false, publicDir: false, logLevel: 'silent',
  build: { ssr: entry, outDir: path.join(temporaryRoot, 'ssr'), rolldownOptions: { output: { entryFileNames: 'modules.mjs' } } } });
const { createOpeningVisualPlan, createDefaultSceneOpeningAnimation, GeographicOpeningRuntime, OpeningPackageAssets, installDeploymentAssetManifest, clearDeploymentAssetManifest } = await import(pathToFileURL(path.join(temporaryRoot, 'ssr/modules.mjs')).href);

test('两个真实ZIP均含完整声明式定义和素材，九段/三段独立通过协议', async () => {
  for (const pack of packages) {
    const archive = await Open.file(pack.zip);
    const json = async name => JSON.parse((await archive.files.find(file => file.path === name).buffer()).toString());
    const definition = validateOpeningPackageDefinition({ manifest: await json('manifest.json'), schema: await json('config.schema.json'),
      uiSchema: await json('ui.schema.json'), defaults: await json('defaults.json'), timeline: await json('timeline.json') });
    assert.equal(definition.timeline.stages.length, pack.stages);
    for (const asset of definition.manifest.assets) assert.ok(archive.files.some(file => file.path === asset.path));
    assert.equal(archive.files.some(file => /\.(?:js|ts|html)$/i.test(file.path)), false);
  }
});

test('发布包虚拟素材先命中部署清单再读取，保留实例替换资源映射', async () => {
  const previous = { window: globalThis.window, document: globalThis.document };
  globalThis.window = {}; globalThis.document = { baseURI: 'https://viewer/release/' };
  const manifest = `editor-asset://local/${encodeURIComponent('project/assets/openings/test/manifest.json')}`;
  const source = `editor-asset://local/${encodeURIComponent('project/assets/openings/test/assets/back.svg')}`;
  const replacement = `editor-asset://local/${encodeURIComponent('project/assets/opening-assets/replaced.png')}`;
  installDeploymentAssetManifest({ [source]: 'https://viewer/release/assets/hash.svg', [replacement]: 'https://viewer/release/assets/replaced.png' });
  const requests = [];
  const resolver = new OpeningPackageAssets(manifest, [{ id: 'a', path: 'assets/back.svg' }, { id: 'b', path: 'assets/old.svg', assetUrl: replacement }], {
    fetch: async url => { requests.push(url); return new Response('asset'); }, createObjectURL: () => 'blob:fixture', revokeObjectURL() {},
  });
  try {
    await resolver.url('a'); await resolver.url('b');
    assert.deepEqual(requests, ['https://viewer/release/assets/hash.svg', 'https://viewer/release/assets/replaced.png']);
  } finally {
    resolver.dispose(); clearDeploymentAssetManifest();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; }
  }
});

test('旧模板保持62秒；包实例各自的时长与标题独立，修改不污染模板', () => {
  const settings = createDefaultSceneOpeningAnimation();
  assert.equal(createOpeningVisualPlan(settings, false).frameAt(20).totalDurationSeconds, 62);
  const binding = createOpeningPackageBinding(packages[1].definition, 'https://host/opening/manifest.json', 'a'.repeat(64));
  const other = structuredClone(binding);
  binding.config.stages[0].durationSeconds = 10;
  binding.config.values.brandTitle = '场景甲';
  const plan = createOpeningVisualPlan({ ...settings, enabled: true, template: 'package', package: binding }, false);
  assert.equal(plan.frameAt(8).stageId, 'brand');
  assert.equal(plan.frameAt(10).stageId, 'network');
  assert.equal(plan.frameAt(20).totalDurationSeconds, 21);
  assert.equal(other.config.stages[0].durationSeconds, 4);
  assert.equal(packages[1].definition.timeline.stages[0].durationSeconds, 4);
});

test('参考包允许两个业务段为零并沿用精确的参考镜头轴', () => {
  const binding = createOpeningPackageBinding(packages[0].definition, 'https://host/opening/manifest.json', 'b'.repeat(64));
  binding.config.stages[2].durationSeconds = 0;
  binding.config.stages[5].durationSeconds = 0;
  const plan = createOpeningVisualPlan({ ...createDefaultSceneOpeningAnimation(), template: 'package', package: binding }, false);
  assert.equal(plan.frameAt(16).referenceSeconds, 22.8);
  assert.equal(plan.frameAt(26).referenceSeconds, 40.2);
  assert.equal(plan.frameAt(46).phase, 'complete');
});

test('未知渲染器和缺失包不会静默播放错误模板，减少动态定位最终非零段', () => {
  const settings = { ...createDefaultSceneOpeningAnimation(), template: 'package' };
  assert.throws(() => createOpeningVisualPlan(settings, false), /未选择/);
  const binding = createOpeningPackageBinding(packages[1].definition, 'https://host/opening/manifest.json', 'c'.repeat(64));
  binding.definition.manifest.renderer = 'external-js';
  assert.throws(() => createOpeningVisualPlan({ ...settings, package: binding }, false), /渲染器/);
  binding.definition.manifest.renderer = 'timeline';
  binding.config.stages[2].durationSeconds = .5;
  const plan = createOpeningVisualPlan({ ...settings, package: binding }, true);
  assert.equal(plan.frameAt(plan.reducedStartSeconds).stageId, 'arrival');
});

test('宿主隐藏期间重播或用户继续不能推进时钟，恢复可见保留主动暂停，隐藏跳过立即释放', async () => {
  const previous = { document: globalThis.document, HTMLElement: globalThis.HTMLElement, performance: globalThis.performance };
  class Element { style = {}; isConnected = true; appendChild() {} contains() { return false; } remove() {} }
  globalThis.HTMLElement = Element;
  globalThis.document = { activeElement: null, createElement: () => new Element() };
  let clock = 0;
  globalThis.performance = { now: () => clock };
  const callbacks = new Set();
  const observable = { add(callback) { callbacks.add(callback); return callback; }, remove(callback) { callbacks.delete(callback); } };
  const scene = { getEngine: () => ({ getRenderingCanvas: () => ({ parentElement: new Element() }) }),
    onAfterRenderObservable: observable, onDisposeObservable: { add: () => null, remove() {} } };
  let controls, completes = 0, disposes = 0;
  const runtime = new GeographicOpeningRuntime({ scene, settings: { ...createDefaultSceneOpeningAnimation(), enabled: true },
    onComplete: () => completes++, onError: error => { throw error; } });
  runtime.plan = { ...runtime.plan, createVisual(_container, next) { controls = next; return { ready: Promise.resolve(), renderAt() {}, resize() {}, dispose() { disposes++; } }; } };
  const frame = () => { clock += 100; for (const callback of callbacks) callback(); };
  try {
    runtime.start(); await Promise.resolve();
    runtime.pause(); controls.onRestart(); controls.onPauseToggle(); frame();
    assert.equal(runtime.getSnapshot().elapsedSeconds, 0);
    assert.equal(runtime.getSnapshot().isPaused, true);
    runtime.resume(); frame(); assert.equal(runtime.getSnapshot().elapsedSeconds, .1);
    controls.onPauseToggle(); runtime.pause(); runtime.resume(); frame();
    assert.equal(runtime.getSnapshot().elapsedSeconds, .1);
    assert.equal(runtime.getSnapshot().isPaused, true);
    runtime.pause(); runtime.skip();
    assert.equal(completes, 1); assert.equal(disposes, 1); assert.equal(callbacks.size, 0);
  } finally {
    runtime.dispose();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; }
  }
});
