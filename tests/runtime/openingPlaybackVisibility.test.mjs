import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';

const temporaryRoot = await mkdtemp(path.resolve('node_modules/.opening-visibility-test-'));
after(async () => {
  if (path.dirname(temporaryRoot) !== path.resolve('node_modules')
    || !path.basename(temporaryRoot).startsWith('.opening-visibility-test-')) throw new Error('测试临时目录范围无效');
  await rm(temporaryRoot, { recursive: true, force: true });
});
const entry = path.join(temporaryRoot, 'entry.mjs');
await writeFile(entry, [
  "export { createSceneOpeningPlayback } from '../../src/shared/opening/createSceneOpeningPlayback.ts';",
  "export { GeographicOpeningRuntime } from '../../src/runtime/opening/GeographicOpeningRuntime.ts';",
  "export { createDefaultSceneOpeningAnimation } from '../../src/editor/model/sceneOpeningAnimation.ts';",
].join('\n'));
await build({ configFile: false, publicDir: false, logLevel: 'silent',
  build: { ssr: entry, outDir: path.join(temporaryRoot, 'ssr'),
    rolldownOptions: { output: { entryFileNames: 'modules.mjs' } } } });
const { createSceneOpeningPlayback, GeographicOpeningRuntime, createDefaultSceneOpeningAnimation }
  = await import(pathToFileURL(path.join(temporaryRoot, 'ssr/modules.mjs')).href);

function fixture() {
  const keys = ['document', 'getComputedStyle', 'ResizeObserver', 'requestAnimationFrame', 'cancelAnimationFrame'];
  const originals = Object.fromEntries(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const document = Object.assign(new EventTarget(), { hidden: false });
  const canvas = Object.assign(new EventTarget(), { getBoundingClientRect: () => ({ width: 800, height: 600 }) });
  let hostVisible = true, visibilityListener;
  let starts = 0, paused = false, disposals = 0, subscriptions = 0, releases = 0;
  let owned = false, controlsEnabled = true;
  const savedMethods = {};
  const methods = {
    start() { starts++; }, pause() { paused = true; }, resume() { paused = false; }, dispose() { disposals++; },
  };
  for (const [key, value] of Object.entries(methods)) {
    savedMethods[key] = GeographicOpeningRuntime.prototype[key];
    GeographicOpeningRuntime.prototype[key] = value;
  }
  Object.assign(globalThis, {
    document, getComputedStyle: () => ({ visibility: 'visible' }), ResizeObserver: undefined,
    requestAnimationFrame: callback => { queueMicrotask(callback); return 1; }, cancelAnimationFrame() {},
  });
  const controller = createSceneOpeningPlayback({
    settings: { ...createDefaultSceneOpeningAnimation(), enabled: true },
    viewport: { scene: {}, engine: { getRenderingCanvas: () => canvas }, cancelCameraTransition() {},
      setCameraControlsEnabled: value => { controlsEnabled = value; } },
    runtime: { setOpeningCameraOwned: value => { owned = value; } },
    isHostVisible: () => hostVisible,
    subscribeToHostVisibility: listener => {
      subscriptions++; visibilityListener = listener;
      return () => { releases++; visibilityListener = undefined; };
    },
    beforeStart() {}, onActiveChange() {}, onProgress() {}, onTerminal() {},
    onError(error) { throw error; },
  });
  return {
    controller,
    state: () => ({ starts, paused, disposals, subscriptions, releases, owned, controlsEnabled }),
    host(visible) { hostVisible = visible; visibilityListener?.(); },
    page(visible) { document.hidden = !visible; document.dispatchEvent(new Event('visibilitychange')); },
    async cleanup() {
      controller.dispose(); await Promise.resolve();
      for (const [key, value] of Object.entries(savedMethods)) GeographicOpeningRuntime.prototype[key] = value;
      for (const key of keys) {
        if (originals[key]) Object.defineProperty(globalThis, key, originals[key]); else delete globalThis[key];
      }
    },
  };
}

test('开场播放中宿主隐藏会暂停，再可见后继续同一次播放', async () => {
  const f = fixture();
  try {
    await f.controller.start();
    assert.equal(f.state().starts, 1);
    f.host(false);
    assert.equal(f.state().paused, true, 'iframe 隐藏不能继续消耗开场时长');
    f.host(true);
    assert.equal(f.state().paused, false);
    assert.equal(f.state().starts, 1);
  } finally { await f.cleanup(); }
});

test('宿主与页面的可见条件同时满足才恢复，终态移除宿主订阅并释放相机', async () => {
  const f = fixture();
  try {
    await f.controller.start();
    f.host(false); f.page(false); f.host(true);
    assert.equal(f.state().paused, true, '宿主确认不能覆盖浏览器后台暂停');
    f.host(false); f.page(true);
    assert.equal(f.state().paused, true, '页面前台不能覆盖宿主隐藏');
    f.host(true);
    assert.equal(f.state().paused, false);
    f.controller.cancel(); await Promise.resolve();
    assert.deepEqual(f.state(), { starts: 1, paused: false, disposals: 1, subscriptions: 1,
      releases: 1, owned: false, controlsEnabled: true });
    f.host(false);
    assert.equal(f.state().paused, false, '已取消实例不能再次接收宿主状态');
  } finally { await f.cleanup(); }
});
