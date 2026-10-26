import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { Engine, Scene, FreeCamera, Vector3, HemisphericLight, MeshBuilder } from '@babylonjs/core';
import { LightingBakeManager } from '../../src/editor/panels/LightingBakeManager';
import { useSceneLightingPreview } from '../../src/editor/panels/scene-view/useSceneLightingPreview';
import { useEditorStore } from '../../src/editor/store/editorStore';
import { SceneRuntime } from '../../src/runtime/babylon/SceneRuntime';
import { ScenePerformanceMonitor } from '../../src/runtime/babylon/ScenePerformanceMonitor';
import { prepareGpuCapabilityProfile, getGpuCapabilityProfile, type GpuCapabilityEnvironment } from '../../src/runtime/babylon/gpuCapabilityProfile';
import type { BabylonViewport } from '../../src/runtime/babylon/createEngine';

const boot = { stage: 'modules-loaded' }; (window as unknown as { gpuProfileBoot: typeof boot }).gpuProfileBoot = boot;
const counts = { contexts: 0, deleted: 0, lost: 0 };
function diagnosticCanvas() {
  counts.contexts++; const canvas = document.createElement('canvas'), native = canvas.getContext.bind(canvas);
  canvas.getContext = ((kind: string, options?: unknown) => {
    const gl = native(kind as 'webgl2', options) as WebGL2RenderingContext | null;
    if (!gl) return gl;
    for (const method of ['deleteShader', 'deleteProgram', 'deleteTexture', 'deleteFramebuffer'] as const) {
      const original = gl[method].bind(gl) as (value: unknown) => void;
      Object.defineProperty(gl, method, { value: (value: unknown) => { counts.deleted++; original(value); } });
    }
    const extension = gl.getExtension.bind(gl);
    gl.getExtension = ((name: string) => { const result = extension(name);
      if (name === 'WEBGL_lose_context' && result) return { loseContext() { counts.lost++; (result as WEBGL_lose_context).loseContext(); } };
      return result;
    }) as typeof gl.getExtension;
    return gl;
  }) as typeof canvas.getContext;
  return canvas;
}
const environment: GpuCapabilityEnvironment = { createCanvas: diagnosticCanvas };
function host() {
  const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
  canvas.style.cssText = 'position:fixed;bottom:0;left:0;width:320px;height:180px'; document.body.append(canvas);
  const engine = new Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true });
  const scene = new Scene(engine); const camera = new FreeCamera('profile-host-camera', new Vector3(0, 2, -5), scene); camera.setTarget(Vector3.Zero());
  new HemisphericLight('profile-host-light', Vector3.Up(), scene); MeshBuilder.CreateBox('profile-host-box', {}, scene);
  return { engine, scene, canvas, dispose() { engine.stopRenderLoop(); scene.dispose(); engine.dispose(); canvas.remove(); } };
}
useEditorStore.getState().resetSceneToBlank();
const main = host(), before = { settings: JSON.stringify(useEditorStore.getState().scene.sceneSettings), scale: main.engine.getHardwareScalingLevel() };
boot.stage = 'probe-start';
const cold = await prepareGpuCapabilityProfile(main.engine, undefined, environment);
boot.stage = 'probe-complete';
const runtime = new SceneRuntime(main.scene); runtime.sync(useEditorStore.getState().scene);
main.engine.runRenderLoop(() => main.scene.render());
await runtime.waitForInitialRenderReady(); boot.stage = 'runtime-ready';
const monitor = new ScenePerformanceMonitor(main.engine, main.scene, { getRuntimeMetrics: () => runtime.getPerformanceMetrics(),
  getEditThinInstancePlanMetrics: () => ({ planCount: 0, lastDurationMs: 0, maxDurationMs: 0, entityCount: 0, groupCount: 0, thinInstanceEntityCount: 0 }), collectDetailedGpuWorkloads: false });
const runtimeRef = { current: runtime }, viewportRef = { current: { engine: main.engine, scene: main.scene } as BabylonViewport };
const sessionRef = { current: useEditorStore.getState().sceneSessionId };
function App() {
  const state = useEditorStore();
  useSceneLightingPreview({ lightingBakeRequest: state.lightingBakeRequest, runtimeRef, viewportRef, statisticsSceneSessionRef: sessionRef,
    isRuntimePreview: false, sceneSessionId: state.sceneSessionId, lightingDebugVisible: state.lightingDebugVisible,
    lightingComparisonEnabled: state.lightingComparisonEnabled, lightingNodeFocusRequest: state.lightingNodeFocusRequest,
    lightingManagerOpen: state.lightingManagerOpen, lightingManagerPreviewRequest: state.lightingManagerPreviewRequest, sceneDocument: state.scene });
  return createElement(LightingBakeManager);
}
const mount = document.createElement('div'); document.body.append(mount); const react = createRoot(mount); react.render(createElement(App));
useEditorStore.getState().openLightingManager();
const api = {
  ready: true, cold, before, counts, store: useEditorStore,
  snapshot() { return { counts: { ...counts }, settings: JSON.stringify(useEditorStore.getState().scene.sceneSettings), scale: main.engine.getHardwareScalingLevel(),
    profile: runtime.getGpuCapabilityProfile(), storeProfile: useEditorStore.getState().lightingGpuCapabilityProfile, diagnostic: JSON.parse(monitor.createReport()), renderer: main.engine.getGlInfo() }; },
  invalidate() { main.engine.onContextRestoredObservable.notifyObservers(main.engine); return runtime.getGpuCapabilityProfile(); },
  async unavailable() { return prepareGpuCapabilityProfile(main.engine, undefined, { ...environment, storage: null, createCanvas: () => null }); },
  async recover() { return prepareGpuCapabilityProfile(main.engine, undefined, environment); },
  async hot() { const value = host(), secondary = new SceneRuntime(value.scene); try {
    secondary.sync(useEditorStore.getState().scene); value.engine.runRenderLoop(() => value.scene.render());
    await secondary.waitForInitialRenderReady();
    return { profile: secondary.getGpuCapabilityProfile(), loading: secondary.getPerformanceMetrics().loading, counts: { ...counts } };
  } finally { secondary.dispose(); value.dispose(); } },
  async cancel() { const value = host(), controller = new AbortController(), reason = new Error('profile-browser-cancel'); const start = { ...counts }; try {
    try { await prepareGpuCapabilityProfile(value.engine, controller.signal, { ...environment, storage: null, yieldFrame: async () => { controller.abort(reason); } }); throw new Error('取消未生效'); }
    catch (error) { if (error !== reason) throw error; }
    value.scene.render(); return { sameReason: true, profile: getGpuCapabilityProfile(value.engine), start, counts: { ...counts }, hostAlive: !value.engine.isDisposed };
  } finally { value.dispose(); } },
  async ownerRollover() { const value = host(), controller = new AbortController(), reason = new Error('old-browser-scene'); const start = { ...counts };
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); let first = true;
    const env = { ...environment, storage: null, yieldFrame: async () => { if (first) { first = false; await gate; } } };
    try { const owner = prepareGpuCapabilityProfile(value.engine, controller.signal, env), waiter = prepareGpuCapabilityProfile(value.engine, undefined, env);
      controller.abort(reason); release(); let matched = false; try { await owner; } catch (error) { matched = error === reason; }
      const profile = await waiter; value.scene.render(); return { sameOwnerReason: matched, profile, start, counts: { ...counts }, hostAlive: !value.engine.isDisposed };
    } finally { value.dispose(); } },
  dispose() { react.unmount(); monitor.dispose(); runtime.dispose(); main.dispose(); mount.remove(); },
};
boot.stage = 'ready';
(window as unknown as { gpuProfileHarness: typeof api }).gpuProfileHarness = api;
