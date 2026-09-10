import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const playerSource = await readFile(new URL('../../src/player/PlayerApp.tsx', import.meta.url), 'utf8');
const runtimeSource = await readFile(new URL('../../src/runtime/babylon/SceneRuntime.ts', import.meta.url), 'utf8');
const environmentRuntimeSource = await readFile(
  new URL('../../src/runtime/babylon/SceneEnvironmentRuntime.ts', import.meta.url),
  'utf8',
);
const decoderSource = await readFile(
  new URL('../../src/runtime/babylon/localDecoderConfiguration.ts', import.meta.url),
  'utf8',
);
const engineSource = await readFile(new URL('../../src/runtime/babylon/createEngine.ts', import.meta.url), 'utf8');
const mainSource = await readFile(new URL('../../electron/main.ts', import.meta.url), 'utf8');

test('发布 Viewer 并行加载环境模型，但首次加载进度仍等待环境结算', () => {
  assert.match(
    playerSource,
    /void runtime\.applyEnvironment\(environment, \{ requestId: null, autoAlign: false \}\)/,
  );
  assert.doesNotMatch(
    playerSource,
    /await runtime\.applyEnvironment\(/,
  );
  assert.match(
    runtimeSource,
    /loadEnvironmentAssetContainer\([\s\S]*?beginModelLoadProgressUnit\(fileName\)[\s\S]*?environmentLoadScheduler\.run\([\s\S]*?environmentLoadProgressUnits\.set\(container, loadSequence\)/,
  );
});

test('环境模型进入首个可渲染帧后才允许结算首次加载进度', () => {
  const renderReadyWait = environmentRuntimeSource.indexOf('await this.options.waitForRenderReady?.(signal)');
  const readySnapshot = environmentRuntimeSource.indexOf(
    'const snapshot = this.createReadySnapshot(this.current, applyOptions.requestId)',
    renderReadyWait,
  );
  const progressSettled = environmentRuntimeSource.indexOf(
    'this.options.onAssetContainerSettled?.(container)',
    readySnapshot,
  );

  assert.match(
    runtimeSource,
    /waitForRenderReady: \(signal\) => this\.waitForEnvironmentRenderReady\(signal\)/,
  );
  assert.match(runtimeSource, /return this\.loadDiagnostics\.measureAsync\('environmentRenderReady', \(\) => waitForSceneRenderReady\(this\.scene, loadSignal\)\)/);
  assert.ok(renderReadyWait >= 0, '环境模型提交前必须等待首个可渲染帧');
  assert.ok(readySnapshot > renderReadyWait, '首帧完成前不能发布 ready 快照');
  assert.ok(progressSettled > readySnapshot, '发布 ready 后才能结算环境进度单元');
});

test('环境 GLB 走独立调度器和会话级源容器缓存，不再挤占设备模型并发窗口', () => {
  assert.match(runtimeSource, /environmentLoadScheduler = new AssetLoadScheduler\(1\)/);
  assert.match(runtimeSource, /environmentAssetCache = new EnvironmentAssetContainerCache/);
  assert.match(runtimeSource, /loadEnvironmentAssetContainer\(/);
  assert.match(runtimeSource, /this\.environmentLoadScheduler\.run\(/);
  assert.match(
    runtimeSource,
    /loadAssetContainer: \(rootUrl, fileName, signal\) => \{\s*return this\.loadEnvironmentAssetContainer\(rootUrl, fileName, signal\);/,
  );
});

test('视口创建后预热 Draco WASM，避免打开带环境场景时才编译解码器', () => {
  assert.match(decoderSource, /export function warmupLocalBabylonDecoders/);
  assert.match(decoderSource, /DracoCompression\.Default\.whenReadyAsync\(\)/);
  assert.match(engineSource, /warmupLocalBabylonDecoders\(\)/);
});

test('editor-asset 协议对 GLB 等静态资源启用 ETag 协商缓存', () => {
  assert.match(mainSource, /resolveEditorAssetProtocolResponse/);
  assert.match(mainSource, /If-None-Match/);
  assert.doesNotMatch(
    mainSource,
    /return new Response\(body, \{\s*headers: \{\s*'Cache-Control': 'no-store'/,
  );
});
