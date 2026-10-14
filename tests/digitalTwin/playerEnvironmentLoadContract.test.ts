import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
import { evaluateSourceExpression } from '../helpers/playerContractTestHelpers.ts';

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

test('环境模型首帧完成后才替换旧环境、发布 ready 并结算进度，失败保留旧环境', { timeout: 10_000 }, async () => {
  assert.match(runtimeSource, /waitForRenderReady: \(signal\) => this\.waitForEnvironmentRenderReady\(signal\)/);
  assert.match(runtimeSource, /return this\.loadDiagnostics\.measureAsync\('environmentRenderReady', \(\) => waitForSceneRenderReady\(this\.scene, loadSignal\)\)/);
  const loadAndSwap = evaluateSourceExpression(environmentRuntimeSource,
    node => ts.isMethodDeclaration(node) && node.name.getText() === 'loadAndSwap', {
      splitAssetUrl: (url: string) => ({ rootUrl: '', fileName: url }),
      createAbortError: () => Object.assign(new Error('cancelled'), { name: 'AbortError' }),
    });
  for (const outcome of ['ready', 'failed', 'superseded']) {
    const calls: unknown[] = [];
    const previous = { name: 'previous' }, candidate = { name: 'candidate' };
    const container = { dispose: () => calls.push('container-dispose') };
    const environment = { activeVariantUrl: 'factory.glb' };
    const signal = new AbortController().signal;
    const renderGate = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const context = {
      current: previous, loadSequence: 1,
      options: {
        resolveAssetUrl: (url: string) => url,
        loadAssetContainer: async () => container,
        waitForRenderReady: (received: AbortSignal) => {
          assert.equal(received, signal);
          calls.push('render-wait'); entered.resolve(); return renderGate.promise;
        },
        onAssetContainerSettled: (received: unknown) => {
          assert.equal(received, container); calls.push('settled');
        },
      },
      createCandidateEntry: () => candidate,
      resolveCandidatePlacement: () => environment,
      applyEntryPresentation: () => {}, collectEntryBounds: () => null,
      collectStatistics: () => null, freezeEntry: () => {},
      applyLatestShadowPresentation: async () => {},
      withBuildingEffectMutation: (mutate: () => void) => mutate(),
      disposeEntry: (entry: unknown) => calls.push(entry === previous ? 'previous-dispose' : 'candidate-dispose'),
      applyEntryEnabledState: (entry: unknown) => { assert.equal(entry, candidate); calls.push('candidate-enable'); },
      refreshAdjustmentBounds: () => {},
      createReadySnapshot: (entry: unknown, requestId: string) => {
        assert.equal(entry, candidate); assert.equal(requestId, 'request-1');
        return { phase: 'ready', requestId };
      },
      emitSnapshot: (snapshot: unknown) => calls.push(snapshot),
    };
    const result = loadAndSwap.call(context, environment, { requestId: 'request-1', autoAlign: false }, 1, signal);
    await Promise.race([entered.promise, result.then(() => assert.fail('尚未进入首帧等待即完成加载'))]);
    assert.equal(context.current, previous, '首帧等待期间必须保留旧环境');
    assert.deepEqual(calls, ['render-wait'], '等待期间不能 ready 或结算');
    if (outcome === 'failed') renderGate.reject(new Error('render failed'));
    else {
      if (outcome === 'superseded') context.loadSequence = 2;
      renderGate.resolve();
    }
    if (outcome === 'ready') {
      const resolved = await result;
      assert.equal(context.current, candidate);
      assert.equal(resolved.environment, environment);
      assert.deepEqual(calls, ['render-wait', 'previous-dispose', 'candidate-enable',
        { phase: 'ready', requestId: 'request-1' }, 'settled']);
    } else {
      await assert.rejects(result, outcome === 'failed' ? /render failed/ : { name: 'AbortError' });
      assert.equal(context.current, previous);
      assert.deepEqual(calls, ['render-wait', 'candidate-dispose', 'settled']);
    }
  }
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
