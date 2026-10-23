import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

/** 执行实际拆出的函数，依赖替身仅用于观察命令、事件清理和异步所有权。 */
function loadFunction(file: string, name: string, dependencies: Record<string, unknown> = {}) {
  const source = readFileSync(new URL('../../src/editor/panels/' + file, import.meta.url), 'utf8');
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declaration = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(declaration, '实际导出函数必须存在：' + name);
  const code = ts.transpileModule(declaration.getText(ast).replace(/^export /, '') + '; globalThis.result = ' + name + ';', {
    compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
  }).outputText;
  return runInNewContext(code + '; result;', { ...dependencies }) as (options: Record<string, unknown>) => Record<string, (...args: unknown[]) => unknown>;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

const settle = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

test('P3 快捷键保留加载门禁、F1 巡检捕获、输入框及按钮保护，并释放两个监听器', () => {
  const effects: Array<() => (() => void) | undefined> = [];
  const listeners: Array<{ name: string; callback: (event: Record<string, unknown>) => void; capture?: boolean }> = [];
  const removals: unknown[] = [];
  let loading = false, captures = 0, paused = 0, manual = 0, camera = 0, adjustment = true;
  class Element { closest(_selector: string) { return null; } }
  class HTMLElement extends Element { isContentEditable = false; }
  class HTMLInputElement extends HTMLElement {}
  class HTMLTextAreaElement extends HTMLElement {}
  class HTMLSelectElement extends HTMLElement {}
  const state = { runtimeMode: 'edit', scene: { selectedEntityId: 'route', entities: { route: { components: { autoPatrol: {} } } } }, requestAutoPatrolCapture: () => captures++ };
  const hook = loadFunction('scene-view/useSceneKeyboardShortcuts.ts', 'useSceneKeyboardShortcuts', {
    Element, HTMLElement, HTMLInputElement, HTMLTextAreaElement, HTMLSelectElement,
    useEffect: (effect: () => (() => void) | undefined) => effects.push(effect),
    useEditorStore: { getState: () => state }, isScenePreparationActive: () => loading,
    window: { addEventListener: (name: string, callback: (event: Record<string, unknown>) => void, capture?: boolean) => listeners.push({ name, callback, capture }),
      removeEventListener: (...args: unknown[]) => removals.push(args) },
  });
  hook({ pauseHistoryReplay: () => paused++, autoPatrolPlaybackRef: { current: { notifyManualInput: () => manual++, notifyCameraChangedWhilePaused: () => camera++ } },
    requestAutoPatrolCapture: state.requestAutoPatrolCapture, environmentAdjustmentActive: true, setEnvironmentAdjustmentActive: (value: boolean) => { adjustment = value; } });
  const cleanups = effects.map(effect => effect());
  assert.equal(listeners.length, 2);
  assert.equal(listeners[0].capture, true);
  let prevented = 0;
  const key = (patch: Record<string, unknown> = {}) => ({ key: 'F1', code: 'F1', target: null, repeat: false, ctrlKey: false, metaKey: false, altKey: false, preventDefault: () => prevented++, ...patch });
  listeners[0].callback(key()); assert.equal(captures, 1);
  listeners[0].callback(key({ repeat: true })); assert.equal(captures, 1);
  listeners[0].callback(key({ target: new HTMLInputElement() })); assert.equal(captures, 1);
  loading = true; listeners[0].callback(key()); assert.equal(captures, 1); assert.equal(prevented, 3);
  loading = false; listeners[0].callback(key({ key: 'w', code: 'KeyW' }));
  assert.deepEqual([paused, manual, camera], [1, 1, 1]);
  listeners[1].callback(key({ key: 'Escape' })); assert.equal(adjustment, false);
  cleanups.forEach(cleanup => cleanup?.());
  assert.equal(removals.length, 2);
});

function assetDropFixture() {
  const placement = { x: 4, y: 0, z: 8 }, clickSnapshotRef = { current: {} as unknown };
  const composition = deferred<unknown>(), placed: unknown[] = [], imported: unknown[] = [], logs: unknown[] = [];
  const state = { sceneSessionId: 'scene-a', scene: { entities: {} }, pushLog: (value: unknown) => logs.push(value) };
  const handler = loadFunction('scene-view/useSceneAssetDropHandler.ts', 'useSceneAssetDropHandler', {
    useEditorStore: { getState: () => state }, isScenePreparationActive: () => false,
    COMPOSITION_DRAG: 'composition', MODEL_ASSET_DRAG_MIME_TYPE: 'model', SKYBOX_ASSET_DRAG_MIME_TYPE: 'skybox', BUILT_IN_ASSET_DRAG_MIME_TYPE: 'builtin',
    SCENE_THEME_DRAG_MIME_TYPE: 'theme', DATA_PLATFORM_SCREEN_ASSET_DRAG_MIME_TYPE: 'screen',
    parseCompositionDragPayload: JSON.parse, window: { editorApi: { loadComposition: () => composition.promise } },
    placeComposition: (...args: unknown[]) => placed.push(args), decodeSkyboxAssetDragPayload: () => null,
    decodeModelAssetDragPayload: (raw: string) => raw ? JSON.parse(raw) : null, decodeBuiltInAssetDragPayload: () => null,
  });
  const options = { isRuntimePreview: false, runtimeRef: { current: { getGroundPointAtCanvasPoint: () => placement } }, clickSnapshotRef,
    sceneDocument: {}, importModelAsset: (...args: unknown[]) => imported.push(args) };
  const event = (payload: Record<string, string>) => ({ dataTransfer: { types: Object.keys(payload), getData: (kind: string) => payload[kind] ?? '' }, clientX: 10, clientY: 20, currentTarget: {}, preventDefault() {} });
  return { handler, options, event, composition, state, placed, imported, placement, clickSnapshotRef };
}

test('P3 组合拖放在异步完成后复核 scene session，切换场景后不向新场景放置旧组合', async () => {
  const f = assetDropFixture();
  f.handler(f.options).handleCanvasDrop(f.event({ composition: '{"id":"composition-a","revision":"1"}' }));
  assert.equal(f.clickSnapshotRef.current, null);
  f.state.sceneSessionId = 'scene-b'; f.composition.resolve({ id: 'composition-a' }); await settle();
  assert.deepEqual(f.placed, []);
});

test('P3 组合拖放与模型拖放保留原始资产、revision 和地面落点；预览态拒绝创建', async () => {
  const f = assetDropFixture();
  f.handler(f.options).handleCanvasDrop(f.event({ composition: '{"id":"composition-a","revision":"1"}' }));
  const entry = { id: 'composition-a', revision: '1' }; f.composition.resolve(entry); await settle();
  assert.equal((f.placed[0] as unknown[])[0], entry); assert.equal((f.placed[0] as unknown[])[1], f.placement);
  f.handler(f.options).handleCanvasDrop(f.event({ model: '{"libraryKind":"model","name":"model-a","parameterValues":{"speed":0}}' }));
  assert.equal((f.imported[0] as [{ parameterValues: { speed: number } }, unknown])[0].parameterValues.speed, 0); assert.equal((f.imported[0] as unknown[])[1], f.placement);
  f.handler({ ...f.options, isRuntimePreview: true }).handleCanvasDrop(f.event({ model: '{"libraryKind":"model"}' }));
  assert.equal(f.imported.length, 1);
});

test('P3 相机投影、方向、保存视角 effect 按原顺序注册，区域旧请求不会操作当前相机', () => {
  const effects: Array<() => void> = [], calls: unknown[] = [];
  const hook = loadFunction('scene-view/useSceneCameraTransition.ts', 'useSceneCameraTransition', {
    useEffect: (effect: () => void) => effects.push(effect), useEditorStore: { getState: () => ({ sceneSessionId: 'scene-b' }) }, isScenePreparationActive: () => false,
  });
  const pose = { position: { x: 1, y: 2, z: 3 } };
  hook({ cameraResetRequest: null, manualRoamSnapshot: { enabled: false }, viewportRef: { current: { setCameraProjection: (value: unknown) => calls.push(['projection', value]),
    setCameraOrientation: (value: unknown) => calls.push(['orientation', value]), getCameraPose: () => pose } }, cameraProjection: 'orthographic', cameraOrientation: 'top',
    cameraPoseSaveRequest: { id: 'save-a' }, consumeCameraPoseSaveRequest: (...args: unknown[]) => calls.push(['save', ...args]),
    regionViewRequest: { id: 'region-a', sceneSessionId: 'scene-a', kind: 'apply' }, manualRoamRef: { current: null }, stopOpening() {}, pauseHistoryReplay() {},
    autoPatrolPlaybackRef: { current: null }, consumeCameraResetRequest() {}, sceneDocument: { sceneSettings: { camera: {} } } });
  assert.equal(effects.length, 5); effects.forEach(effect => effect());
  assert.deepEqual(calls, [['projection', 'orthographic'], ['orientation', 'top'], ['save', 'save-a', pose]]);
});

test('P3 烘焙 cleanup 中止当前请求，异步旧结果不回写，退役 Runtime 不重新同步', async () => {
  const effects: Array<() => (() => void) | undefined> = [], result = deferred<unknown>(), writes: unknown[] = [], lighting: unknown[] = [];
  let signal: AbortSignal | undefined;
  const runtime = { bakeLighting: (_scene: unknown, requestSignal: AbortSignal) => { signal = requestSignal; return result.promise; }, syncLighting: (...args: unknown[]) => lighting.push(args) };
  const runtimeRef = { current: runtime as unknown }, state = { scene: {}, completeLightingBake: (...args: unknown[]) => writes.push(args), failLightingBake: (...args: unknown[]) => writes.push(args) };
  const hook = loadFunction('scene-view/useSceneLightingPreview.ts', 'useSceneLightingPreview', { AbortController,
    useEffect: (effect: () => (() => void) | undefined) => effects.push(effect), useEditorStore: { getState: () => state } });
  hook({ lightingBakeRequest: { id: 'bake-a' }, runtimeRef, isRuntimePreview: false, sceneSessionId: 'scene-a', sceneDocument: { sceneSettings: {}, entities: {} } });
  const cleanup = effects[0](); assert.ok(signal); assert.equal(signal.aborted, false);
  runtimeRef.current = {}; cleanup?.(); assert.equal(signal.aborted, true);
  result.resolve({ valid: true }); await settle();
  assert.deepEqual(writes, []); assert.deepEqual(lighting, []);
});
