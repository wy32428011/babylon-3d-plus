import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import test, { after } from 'node:test';
import { createP4SsrTestModules } from '../helpers/p4SsrTestModules.mjs';
import { getRequiredEnvironmentResourceIds } from '../../electron/shared/sceneEnvironmentReferences.ts';
import { runInNewContext } from 'node:vm';
import { findMatchingEnvironmentResource } from '../../electron/shared/environmentResourceMatch.ts';
import { environmentForSyncRun } from '../../src/editor/assets/environmentSyncAuthority.ts';


// 真正执行资源 Slice、序列化及模型更新；只有 React 调度和 IPC 返回值由本用例控制。
const modules = await createP4SsrTestModules([
  '/src/editor/store/slices/dataPlatformAndPublishSlice.ts',
  '/src/editor/model/SceneDocument.ts',
  '/src/editor/project/SceneSerializer.ts',
  '/src/editor/assets/applySceneModelUpdates.ts',
  '/src/editor/assets/environmentAssets.ts',
  '/src/editor/model/modelParameters.ts',
]);
after(() => modules.close());
const { createDataPlatformAndPublishSlice } = await modules.ssrLoadModule('/src/editor/store/slices/dataPlatformAndPublishSlice.ts');
const { createEmptySceneDocument, createModelEntity } = await modules.ssrLoadModule('/src/editor/model/SceneDocument.ts');
const { serializeScene, deserializeScene } = await modules.ssrLoadModule('/src/editor/project/SceneSerializer.ts');
const { applyAvailableSceneModelUpdates } = await modules.ssrLoadModule('/src/editor/assets/applySceneModelUpdates.ts');
const { createEnvironmentFromAsset } = await modules.ssrLoadModule('/src/editor/assets/environmentAssets.ts');
const { normalizeModelParameterConfig } = await modules.ssrLoadModule('/src/editor/model/modelParameters.ts');

const panel = await readFile(new URL('../../src/editor/panels/ProjectPanel.tsx', import.meta.url), 'utf8');
const start = panel.indexOf("  useEffect(() => {\n    if (sceneResourcePolicy === 'preserve-snapshot') return;");
const end = panel.indexOf('\n\n  useEffect(', start + 1);
assert.ok(start >= 0 && end > start);
const effect = stripTypeScriptTypes(panel.slice(start, end));
const tick = () => new Promise(resolve => setImmediate(resolve));


/** 非空合法资源用正式工厂构造，防止空场景同时丢字段仍得到相等结果。 */
function createPreservedLocalSnapshot() {
  const scene = createEmptySceneDocument('本地资源恢复');
  const url = (path: string) => 'editor-asset://local/' + encodeURIComponent(path);
  const parameterConfig = normalizeModelParameterConfig({
    schema: 'babylon-editor.model-parameters', version: 1,
    parameters: [
      { key: 'distance', label: '长度', type: 'number', defaultValue: 1, min: 0, max: 10 },
      { key: 'enabled', label: '启用', type: 'boolean', defaultValue: true },
      { key: 'label', label: '标签', type: 'string', defaultValue: '默认' },
    ], bindings: [],
  });
  assert.ok(parameterConfig, '非空快照必须使用合法参数配置');
  const modelPath = 'C:/snapshot/Assets/Models/Parameterized/model.glb';
  const scriptPath = 'C:/snapshot/Assets/Models/Parameterized/snapshot.parameters.ts';
  const model = createModelEntity(modelPath, url(modelPath), '本地参数模型',
    { lengthUnit: 'millimeter', unitScaleToMeters: 0.001 }, { x: 1, y: 2, z: 3 }, parameterConfig,
    [{ name: 'snapshot.parameters.ts', path: scriptPath, sourceUrl: url(scriptPath) }],
    undefined, undefined, 'LOCAL', 'model-local-v1');
  model.components.modelAsset.assetCode = 'LOCAL000317';
  model.components.modelAsset.parameterValues = { distance: 3.5, enabled: false, label: '000317' };
  scene.entities = { [model.id]: model };
  scene.entityIds = [model.id];
  scene.selectedEntityId = model.id;
  const packagePath = 'C:/snapshot/Assets/Environments/ENV-123';
  const environment = createEnvironmentFromAsset({
    id: 'environment-123', kind: 'model', libraryKind: 'environment', source: 'data-platform',
    name: 'warehouse.glb', displayName: '已打包环境', path: packagePath + '/warehouse.glb',
    sourceUrl: url(packagePath + '/warehouse.glb'), packagePath, assetRevision: '7', fileSizeBytes: 2048,
    lengthUnit: 'centimeter', dataPlatformResourceType: 'ENV_MODEL', dataPlatformResourceId: '123',
    dataPlatformSourceKey: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', dataPlatformRevision: '7',
  }, [
    { name: '日间', sourcePath: packagePath + '/warehouse.glb', sourceUrl: url(packagePath + '/warehouse.glb') },
    { name: '夜间', sourcePath: packagePath + '/warehouse-night.glb', sourceUrl: url(packagePath + '/warehouse-night.glb') },
  ]);
  assert.ok(environment, '非空快照必须使用合法包内环境');
  environment.transform = { position: { x: 8, y: 3, z: -12 }, rotation: { x: 0.1, y: 0.2, z: -0.3 }, scale: 1.5 };
  environment.visible = false;
  environment.opacity = 0.4;
  environment.activeVariantUrl = environment.variants[1].sourceUrl;
  scene.sceneSettings.environment = environment;
  // 本用例模拟已打开的正式场景，先经过实际读写归一化；资源字面量仍在测试中独立逐项校验。
  return deserializeScene(serializeScene(scene));
}

function fixture(withPreservedSnapshot = false) {
  const events: string[] = [];
  const updates: Array<{ before: unknown; replacements: unknown; sourceKey: string; result: { scene: unknown } }> = [];
  const transactions: Array<{ before: unknown; after: unknown; kind?: string }> = [];
  const requests: Array<{ mode: string; sceneContent: string }> = [];
  let resolve!: (value: unknown) => void;
  let reject!: (error: Error) => void;
  const sync = new Promise((done, fail) => { resolve = done; reject = fail; });
  let cleanup!: () => void;
  const preparing = { current: false };
  const mask = { value: false };
  const initialScene = withPreservedSnapshot ? createPreservedLocalSnapshot() : createEmptySceneDocument('本地资源恢复');
  const initialContent = serializeScene(initialScene);
  // Slice 的 set 接口在单位夹具中保留可观察状态对象；动作正文及 CAS/恢复门控使用真实实现。
  const state = Object.assign({ sceneSessionId: 'local', scene: initialScene,
    runtimeMode: 'edit', history: { undoStack: [], redoStack: [] }, logs: [] },
  createDataPlatformAndPublishSlice((operation: unknown) => {
    const next = typeof operation === 'function' ? operation(state) : operation;
    if (next && typeof next === 'object') {
      const patch = next as { latestSceneResourceTransaction?: { before: unknown; after: unknown; kind?: string } };
      if (patch.latestSceneResourceTransaction && patch.latestSceneResourceTransaction !== state.latestSceneResourceTransaction) {
        transactions.push(patch.latestSceneResourceTransaction);
        events.push(patch.latestSceneResourceTransaction.kind === 'local-recovery' ? 'recover-commit' : 'commit');
      }
      Object.assign(state, next);
    }
  }));
  state.sceneResourcePolicy = 'local-refresh';
  runInNewContext(effect, {
    Error,
    useEffect: (run: () => () => void) => { cleanup = run(); },
    sceneResourcePolicy: 'local-refresh', sceneSessionId: 'local', localResourceRetry: 0,
    localResourcePreparingRef: preparing, initialProjectAssetsLoadPromiseRef: { current: Promise.resolve() },
    setIsPreparingSceneResources: (value: boolean) => { mask.value = value; },
    useEditorStore: { getState: () => state },
    serializeScene, deserializeScene, getRequiredEnvironmentResourceIds,
    window: { editorApi: { prepareLocalSceneResources: (request: { mode: string; sceneContent: string }) => {
      requests.push(request);
      if (request.mode === 'local-latest') { events.push('sync-start'); return sync; }
      if (request.mode === 'local-recovery') {
        events.push('local-recovery');
        return Promise.resolve({ configured: true, sourceKey: 'current', modelAssets: [], environmentAssets: [],
          recoveredSceneContent: request.sceneContent, recoveredReferenceCount: 0, issues: [] });
      }
      throw new Error('夹具收到非预期资源模式：' + request.mode);
    } } },
    applyAvailableSceneModelUpdates: (before: unknown, replacements: unknown, sourceKey: string, environment: unknown) => {
      events.push('apply-models');
      const result = applyAvailableSceneModelUpdates(before, replacements, sourceKey, environment);
      updates.push({ before, replacements, sourceKey, result });
      return result;
    },
    reportSceneModelSyncProgress: (_session: string, progress: { phase: string }) => events.push(progress.phase),
    beginSceneModelAssetRefresh: () => events.push('refresh-start'),
    settleSceneModelAssetRefresh: () => events.push('refresh-settled'),
    allowScenePreparationEditing: (_session: string, allowed: boolean) => { assert.equal(allowed, false); },
    loadProjectAssets: () => { throw new Error('本轮本地恢复不得退回旧资源目录重关联入口'); },
    environmentPreparationStore: { clearError() {}, fail: (_session: string, error: string) => events.push(error) },
    pushLog() {}, requestEnvironmentApply() {}, crypto: { randomUUID: () => 'refresh-id' },
  });
  return { events, resolve, reject, cleanup, preparing, mask, state, updates, transactions, requests, initialScene, initialContent };
}

test('本地场景等待本轮同步事务，再全量重关联；缓存未变化也不跳过', async () => {
  const f = fixture();
  await tick();
  assert.deepEqual(f.events, ['querying', 'sync-start']);
  assert.equal(f.state.sceneStartupResourceSessionId, 'local');
  assert.equal(f.transactions.length, 0, '本轮事务未返回前不得提交');
  f.resolve({ configured: true, modelAssets: [], modelReplacements: [], environmentAssets: [], sourceKey: 'current' });
  await tick();
  assert.deepEqual(f.events, ['querying', 'sync-start', 'completed', 'refresh-start', 'apply-models', 'local-recovery', 'commit', 'refresh-settled']);
  assert.equal(f.updates.length, 1);
  assert.equal(f.updates[0].before, f.initialScene);
  assert.deepEqual(f.updates[0].replacements, []);
  assert.equal(f.updates[0].sourceKey, 'current');
  assert.equal(f.updates[0].result.scene, f.initialScene, '目录未变化仍须走完整事务');
  assert.equal(f.transactions.length, 1);
  assert.equal(f.transactions[0].before, f.initialScene);
  assert.equal(f.transactions[0].after, f.state.scene);
  assert.equal(f.state.latestSceneResourceTransaction, f.transactions[0]);
  assert.equal(f.state.sceneStartupResourceSessionId, null);
  f.cleanup();
  assert.equal(f.preparing.current, false, '切换 SOURCE 后不能继续屏蔽其后台关联');
});

test('本地同来源同 ID 的环境升级提交新修订与路径，保存与实际显示一致', async () => {
  const callbackStart = panel.indexOf('  const refreshCurrentEnvironmentFromAssets = useCallback(');
  const callbackEnd = panel.indexOf('\n  /** 按当前场景身份', callbackStart);
  assert.ok(callbackStart >= 0 && callbackEnd > callbackStart);
  const environment = { source: 'data-platform', dataPlatformSourceKey: 'current', dataPlatformResourceId: '123',
    dataPlatformRevision: '1', displayName: '园区', packagePath: 'old-path', activeVariantUrl: 'old-url',
    transform: { position: { x: 5, y: 0, z: 7 } }, visible: false, opacity: 0.4 };
  const next = { ...environment, dataPlatformRevision: '2', packagePath: 'new-path', activeVariantUrl: 'new-url' };
  const asset = { kind: 'model', libraryKind: 'environment', name: 'model.glb', displayName: '园区',
    dataPlatformResourceId: '123', dataPlatformSourceKey: 'current', dataPlatformRevision: '2' };
  let applied: any;
  const refresh = runInNewContext(stripTypeScriptTypes(`${panel.slice(callbackStart, callbackEnd)}\nrefreshCurrentEnvironmentFromAssets;`), {
    useCallback: (callback: unknown) => callback,
    useEditorStore: { getState: () => ({ sceneSessionId: 'local', scene: { sceneSettings: { environment } } }) },
    sceneSessionIdRef: { current: 'local' }, lastSceneRefreshEnvironmentSyncRunIdRef: { current: null },
    getRequiredEnvironmentResourceIds: () => ['123'], findMatchingEnvironmentResource, environmentForSyncRun,
    loadEnvironmentFromAsset: async () => next,
    requestEnvironmentApply: (value: unknown, options: unknown) => { applied = { value, options }; return 'request'; },
    pushLog() {}, environmentPreparationStore: { fail() {} },
  });
  assert.equal(await refresh([asset], 'local', 'current', undefined, [], true), true);
  assert.equal(applied.value, next);
  assert.equal(applied.options.persistSceneChange, true);
  assert.equal(applied.value.transform, environment.transform);
  assert.equal(applied.value.visible, false);
  assert.equal(applied.value.opacity, 0.4);
});

test('旧会话同步迟到完成不能应用到新场景或解除蒙版', async () => {
  const f = fixture();
  await tick();
  assert.equal(f.preparing.current, true);
  f.cleanup();
  assert.equal(f.preparing.current, false);
  f.state.sceneSessionId = 'new';
  f.state.beginLocalSceneResourceRecovery('new');
  f.preparing.current = true;
  f.mask.value = true;
  f.resolve({ configured: true });
  await tick();
  assert.deepEqual(f.events, ['querying', 'sync-start']);
  assert.equal(f.transactions.length, 0);
  assert.equal(f.state.sceneStartupResourceSessionId, 'new');
  assert.equal(f.preparing.current, true);
  assert.equal(f.mask.value, true, '旧事务结束不得解除新会话蒙版');
});

test('同步失败显示原因且不宣布完成；未配置中台继续保留本地快照', async () => {
  const failed = fixture();
  await tick();
  failed.reject(new Error('环境模型 SHA-256 校验失败'));
  await tick();
  assert.deepEqual(failed.events, ['querying', 'sync-start', '环境模型 SHA-256 校验失败', 'failed', 'refresh-start', 'refresh-settled']);
  assert.equal(failed.events.includes('completed'), false);
  assert.deepEqual(failed.state.sceneResourceIssues, ['环境模型 SHA-256 校验失败']);
  assert.equal(failed.state.scene, failed.initialScene);
  assert.equal(failed.state.sceneStartupResourceSessionId, 'local');
  failed.cleanup();
  const local = fixture(true);
  await tick();
  // 主进程 local-latest 在无中台地址时返回正式本地恢复信封，而不是缺少场景内容的旧结果。
  // 初始 canonical 与恢复 state 分别核对独立字面量，整体相等不能掩盖两端同时丢资源。
  const assertPreservedSnapshot = (document: typeof local.state.scene) => {
    assert.equal(document.entityIds.length, 1);
    const model = document.entities[document.entityIds[0]];
    const asset = model.components.modelAsset;
    assert.equal(model.name, '本地参数模型');
    assert.equal(asset.assetCode, 'LOCAL000317');
    assert.equal(asset.sourcePath, 'C:/snapshot/Assets/Models/Parameterized/model.glb');
    assert.equal(asset.sourceUrl, 'editor-asset://local/C%3A%2Fsnapshot%2FAssets%2FModels%2FParameterized%2Fmodel.glb');
    assert.equal(asset.assetRevision, 'model-local-v1');
    assert.equal(asset.lengthUnit, 'millimeter');
    assert.equal(asset.unitScaleToMeters, 0.001);
    assert.equal(asset.parameterConfig.schema, 'babylon-editor.model-parameters');
    assert.equal(asset.parameterConfig.version, 1);
    assert.deepEqual(asset.parameterConfig.parameters.map((parameter: { key: string; type: string }) => ({ key: parameter.key, type: parameter.type })),
      [{ key: 'distance', type: 'number' }, { key: 'enabled', type: 'boolean' }, { key: 'label', type: 'string' }]);
    assert.deepEqual(asset.parameterValues, { distance: 3.5, enabled: false, label: '000317' });
    assert.deepEqual(asset.scriptAssets, [{ name: 'snapshot.parameters.ts',
      path: 'C:/snapshot/Assets/Models/Parameterized/snapshot.parameters.ts',
      sourceUrl: 'editor-asset://local/C%3A%2Fsnapshot%2FAssets%2FModels%2FParameterized%2Fsnapshot.parameters.ts' }]);
    assert.deepEqual(model.components.transform.position, { x: 1, y: 2, z: 3 });
    const environment = document.sceneSettings.environment;
    assert.equal(environment.packagePath, 'C:/snapshot/Assets/Environments/ENV-123');
    assert.equal(environment.displayName, '已打包环境');
    assert.equal(environment.fileSizeBytes, 2048);
    assert.equal(environment.lengthUnit, 'centimeter');
    assert.equal(environment.unitScaleToMeters, 0.01);
    assert.deepEqual([environment.source, environment.resourceType, environment.dataPlatformResourceId, environment.dataPlatformSourceKey, environment.dataPlatformRevision],
      ['data-platform', 'ENV_MODEL', '123', '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', '7']);
    assert.equal(environment.placementMode, 'scene-base');
    assert.deepEqual(environment.transform, { position: { x: 8, y: 3, z: -12 }, rotation: { x: 0.1, y: 0.2, z: -0.3 }, scale: 1.5 });
    assert.equal(environment.visible, false);
    assert.equal(environment.opacity, 0.4);
    assert.deepEqual(environment.variants, [
      { name: '日间', sourcePath: 'C:/snapshot/Assets/Environments/ENV-123/warehouse.glb',
        sourceUrl: 'editor-asset://local/C%3A%2Fsnapshot%2FAssets%2FEnvironments%2FENV-123%2Fwarehouse.glb?assetRevision=7' },
      { name: '夜间', sourcePath: 'C:/snapshot/Assets/Environments/ENV-123/warehouse-night.glb',
        sourceUrl: 'editor-asset://local/C%3A%2Fsnapshot%2FAssets%2FEnvironments%2FENV-123%2Fwarehouse-night.glb?assetRevision=7' },
    ]);
    assert.equal(environment.activeVariantUrl, 'editor-asset://local/C%3A%2Fsnapshot%2FAssets%2FEnvironments%2FENV-123%2Fwarehouse-night.glb?assetRevision=7');
  };
  assertPreservedSnapshot(JSON.parse(local.initialContent).scene);
  local.resolve({ configured: false, sourceKey: null, modelAssets: [], environmentAssets: [],
    recoveredSceneContent: local.initialContent, recoveredReferenceCount: 0, issues: [] });
  await tick();
  assertPreservedSnapshot(local.state.scene);
  assert.equal(serializeScene(local.state.scene), local.initialContent, '未配置中台保留本地场景快照');
  assert.equal(local.transactions.length, 1);
  assert.equal(local.transactions[0].kind, 'local-recovery');
  assert.equal(local.state.history.undoStack.length, 0, '依赖恢复不制造可撤销的资源降级');
  assert.deepEqual(local.requests.map(request => request.mode), ['local-latest']);
  assert.equal(local.events.at(-1), 'refresh-settled');
  local.cleanup();
});
