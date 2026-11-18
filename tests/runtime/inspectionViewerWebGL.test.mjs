import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

// 独立运行：node --test tests/runtime/inspectionViewerWebGL.test.mjs
// 只替换 Babylon 边界；被测逻辑来自实际 TypeScript 模块，不创建 WebGL 上下文。
const source = readFileSync(new globalThis.URL('../../src/inspection/inspectionViewer.ts', import.meta.url), 'utf8');
const javascript = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

function observable() {
  const observers = new Set();
  return {
    add(callback) { const observer = { callback }; observers.add(observer); return observer; },
    remove(observer) { observers.delete(observer); },
    emit(value) { for (const observer of [...observers]) observer.callback(value); },
    get size() { return observers.size; },
  };
}

function harness(settings = {}) {
  const calls = { engineDisposals: 0, viewerDisposals: 0, stops: 0, suspensions: 0, detaches: 0 };
  const renderer = { unmasked: settings.renderer ?? 'ANGLE (Intel, Intel UHD Graphics)', masked: 'WebGL Renderer' };
  const gl = {
    RENDERER: 1,
    getExtension() { return settings.noDebugInfo ? null : { UNMASKED_RENDERER_WEBGL: 2 }; },
    getParameter(parameter) { return parameter === 2 ? renderer.unmasked : renderer.masked; },
  };
  const canvas = { getContext() { return settings.noContext ? null : gl; } };
  const engine = {
    onContextRestoredObservable: observable(),
    getGlInfo() { return { renderer: 'stale hardware renderer' }; },
    dispose() { calls.engineDisposals++; if (settings.engineDisposeThrows) throw new Error('engine dispose failed'); },
    stopRenderLoop() { calls.stops++; if (settings.stopThrows) throw new Error('stop failed'); },
  };
  const scene = {
    getEngine() { return engine; },
    onPointerObservable: observable(),
    onPrePointerObservable: observable(),
  };
  const details = {
    scene,
    camera: { detachControl() { calls.detaches++; } },
    get model() { return null; },
    suspendRendering() { calls.suspensions++; return { dispose() { throw new Error('unexpected resume'); } }; },
    markSceneMutated() {},
  };
  class Viewer {
    constructor(_engine, options) {
      calls.viewerConstructed = true;
      this.onModelChanged = observable();
      if (settings.viewerThrows) throw new Error('viewer constructor failed');
      if (!settings.missingDetails) options.onInitialized(details);
    }
    _selectAnimation() {}
    dispose() { calls.viewerDisposals++; if (settings.viewerDisposeThrows) throw new Error('viewer dispose failed'); }
    loadModel() { return settings.loadModel?.() ?? Promise.resolve(); }
  }
  const viewerModule = {
    Viewer,
    async CreateViewerForCanvas(_canvas, options) {
      calls.options = options;
      if (settings.factoryThrowsBeforeViewer) throw new Error('engine creation failed');
      const viewer = new options.viewerClass(engine, options);
      if (settings.factoryThrowsAfterViewer) throw new Error('factory setup failed');
      const disposeViewer = viewer.dispose.bind(viewer);
      viewer.dispose = () => { disposeViewer(); engine.dispose(); };
      if (settings.abortBeforeReturn) settings.abortBeforeReturn();
      return viewer;
    },
  };
  const imports = new Map([
    ['@babylonjs/viewer', viewerModule],
    ['@babylonjs/core/Events/pointerEvents.js', { PointerEventTypes: { POINTERTAP: 1, POINTERDOUBLETAP: 2 } }],
    ['@babylonjs/core/Maths/math.vector.js', { Vector3: class {} }],
    ['@babylonjs/core/Culling/ray.js', {}],
    ['@babylonjs/core/Meshes/instancedMesh.js', {}],
    ['@babylonjs/core/Rendering/boundingBoxRenderer.js', {}],
  ]);
  const module = { exports: {} };
  runInNewContext(javascript, {
    module,
    exports: module.exports,
    require(id) {
      assert.ok(imports.has(id), `unexpected module ${id}`);
      return imports.get(id);
    },
    console: { error() { calls.loggedErrors = (calls.loggedErrors ?? 0) + 1; } },
    DOMException: globalThis.DOMException,
  });
  return { create: module.exports.createInspectionViewer, calls, canvas, engine, renderer };
}

test('显式请求高性能硬件 WebGL 并在销毁时移除恢复观察器', async () => {
  const h = harness();
  const controller = await h.create(h.canvas);
  assert.equal(h.calls.options.engine, 'WebGL');
  assert.equal(h.calls.options.powerPreference, 'high-performance');
  assert.equal(h.calls.options.failIfMajorPerformanceCaveat, true);
  assert.equal(h.engine.onContextRestoredObservable.size, 1);
  await controller.dispose();
  assert.equal(h.engine.onContextRestoredObservable.size, 0);
  assert.equal(h.calls.viewerDisposals, 1);
  assert.equal(h.calls.engineDisposals, 1);
});

test('未知和常见软件 renderer 在 Viewer 构造前被拒绝并释放引擎', async () => {
  for (const renderer of [
    '', ' Unknown ', 'unknown renderer', 'SwiftShader', 'llvmpipe', 'LAVAPIPE', 'SoftPipe',
    'Software Adapter', 'software rasterizer', 'software renderer', 'Microsoft Basic Render Driver', 'ANGLE WARP',
  ]) {
    const h = harness({ renderer });
    if (!renderer) h.renderer.masked = '';
    await assert.rejects(h.create(h.canvas), /无法启动设备详情.*(?:无法识别|软件 WebGL)/);
    assert.equal(h.calls.engineDisposals, 1, renderer);
    assert.equal(h.calls.viewerConstructed, undefined, renderer);
  }
  const h = harness({ noContext: true });
  await assert.rejects(h.create(h.canvas), /无法识别 WebGL renderer/);
  assert.equal(h.calls.engineDisposals, 1);
});

test('无调试扩展时读取当前标准 renderer', async () => {
  const h = harness({ noDebugInfo: true });
  h.renderer.masked = 'ANGLE (NVIDIA GeForce)';
  const controller = await h.create(h.canvas);
  await controller.dispose();
  const software = harness({ noDebugInfo: true });
  software.renderer.masked = 'software renderer';
  await assert.rejects(software.create(software.canvas), /软件 WebGL/);
});

test('Viewer 构造及工厂后续初始化失败时清理已创建资源', async () => {
  const constructing = harness({ viewerThrows: true });
  await assert.rejects(constructing.create(constructing.canvas), /viewer constructor failed/);
  assert.equal(constructing.calls.engineDisposals, 1);
  const setup = harness({ factoryThrowsAfterViewer: true });
  await assert.rejects(setup.create(setup.canvas), /factory setup failed/);
  assert.equal(setup.calls.viewerDisposals, 1);
  assert.equal(setup.calls.engineDisposals, 1);
  const cleanupFailure = harness({ factoryThrowsAfterViewer: true, viewerDisposeThrows: true });
  await assert.rejects(cleanupFailure.create(cleanupFailure.canvas), /factory setup failed/);
  assert.equal(cleanupFailure.calls.viewerDisposals, 1);
  assert.equal(cleanupFailure.calls.engineDisposals, 1);
  assert.equal(cleanupFailure.calls.loggedErrors, 1);
  const missing = harness({ missingDetails: true });
  await assert.rejects(missing.create(missing.canvas), /未提供场景/);
  assert.equal(missing.calls.viewerDisposals, 1);
  assert.equal(missing.calls.engineDisposals, 1);
  const before = harness({ factoryThrowsBeforeViewer: true });
  await assert.rejects(before.create(before.canvas), /无法启动设备详情.*engine creation failed/);
});

test('恢复为软件或未知 renderer 时停止渲染并只报告一次', async () => {
  for (const newRenderer of ['SwiftShader', 'Unknown renderer']) {
    const h = harness();
    const faults = [];
    const controller = await h.create(h.canvas, { onFaulted(error) { faults.push(error); } });
    h.engine.onContextRestoredObservable.emit();
    assert.equal(faults.length, 0);
    h.renderer.unmasked = newRenderer;
    h.engine.onContextRestoredObservable.emit();
    h.engine.onContextRestoredObservable.emit();
    assert.equal(faults.length, 1);
    assert.match(faults[0].message, /上下文恢复失败/);
    assert.equal(h.calls.stops, 1);
    assert.equal(h.calls.suspensions, 1);
    assert.equal(h.calls.detaches, 1);
    assert.throws(() => controller.loadModel('asset.glb', { parts: [] }), /上下文恢复失败/);
    await controller.dispose();
    h.calls.options.onFaulted(new Error('late context lost'));
    h.engine.onContextRestoredObservable.emit();
    assert.equal(faults.length, 1);
  }
});

test('停止环节出错仍执行其他停用步骤并报告恢复故障', async () => {
  const h = harness({ stopThrows: true });
  const faults = [];
  const controller = await h.create(h.canvas, { onFaulted(error) { faults.push(error); } });
  h.renderer.unmasked = 'SwiftShader';
  h.engine.onContextRestoredObservable.emit();
  assert.equal(h.calls.stops, 1);
  assert.equal(h.calls.suspensions, 1);
  assert.equal(h.calls.detaches, 1);
  assert.equal(h.calls.loggedErrors, 1);
  assert.equal(faults.length, 1);
  await controller.dispose();
});

test('创建完成后的 AbortSignal 不阻断后续故障通知', async () => {
  const abort = new globalThis.AbortController();
  const h = harness();
  const faults = [];
  const controller = await h.create(h.canvas, { signal: abort.signal, onFaulted(error) { faults.push(error); } });
  abort.abort();
  h.calls.options.onFaulted(new Error('context lost'));
  assert.equal(faults.length, 1);
  await controller.dispose();
});

test('加载中恢复失败时保持恢复错误并等待关闭', async () => {
  let finish;
  const h = harness({ loadModel: () => new Promise((resolve) => { finish = resolve; }) });
  const faults = [];
  const controller = await h.create(h.canvas, { onFaulted(error) { faults.push(error); } });
  const loading = controller.loadModel('asset.glb', { parts: [] });
  await Promise.resolve();
  h.renderer.unmasked = 'WARP';
  h.engine.onContextRestoredObservable.emit();
  finish();
  await assert.rejects(loading, /上下文恢复失败/);
  assert.equal(faults.length, 1);
  await controller.dispose();
});

test('创建期间取消时释放工厂完整包装的资源', async () => {
  const abort = new globalThis.AbortController();
  const h = harness({ abortBeforeReturn: () => abort.abort() });
  await assert.rejects(h.create(h.canvas, { signal: abort.signal }), { name: 'AbortError' });
  assert.equal(h.calls.viewerDisposals, 1);
  assert.equal(h.calls.engineDisposals, 1);
});
