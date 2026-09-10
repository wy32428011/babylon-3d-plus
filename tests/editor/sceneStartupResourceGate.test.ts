import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
const storeSource = await readFile(new URL('../../src/editor/store/editorStore.ts', import.meta.url), 'utf8');
function storeFixture() {
  let state: any = { sceneSessionId: '', runtimeMode: 'edit', logs: [], history: {}, sceneResourceIssues: [] };
  let session = 0;
  const observed: any[] = [];
  const action = (name: string, next: string) => storeSource.slice(storeSource.indexOf(`  ${name}: (`, storeSource.indexOf('export const useEditorStore')),
    storeSource.indexOf(`  ${next}:`, storeSource.indexOf(`  ${name}: (`, storeSource.indexOf('export const useEditorStore'))));
  const loadStart = storeSource.indexOf('  loadScene: async (');
  const loadEnd = storeSource.indexOf('  loadSceneFromContent:', loadStart);
  const code = `({${action('finishLatestSceneResources', 'refreshModelInstancesFromAssets')}${storeSource.slice(loadStart, loadEnd)}})`;
  const actions = runInNewContext(stripTypeScriptTypes(code), {
    set: (update: any) => { const next = typeof update === 'function' ? update(state) : update; state = { ...state, ...next }; observed.push(state); },
    get: () => state, isRuntimePreviewState: () => false,
    createLoadedSceneState: (_state: any, scene: any) => ({ scene, sceneSessionId: `session-${++session}` }),
    window: { editorApi: {
      loadSceneFile: async () => ({ content: '{"sceneSettings":{}}', filePath: 'startup.scene.json', sceneOpenToken: 1 }),
      loadScene: async () => ({ content: '{"sceneSettings":{}}', filePath: 'dialog.scene.json', sceneOpenToken: 1 }),
      confirmSceneOpen: async () => true,
    } },
    deserializeScene: JSON.parse, syncDataPlatformImagesAfterLocalSceneLoad() {},
    updateSceneDocumentCommand: (_name: string, update: () => unknown) => update,
    executeCommand: (_before: unknown, history: unknown, update: () => unknown) => ({ scene: update(), history }),
    prependLog: (_logs: unknown, message: string) => [message],
    restoreFailedSceneResources: () => { throw new Error('本地恢复不能回滚失效的旧路径'); },
  });
  state = { ...state, ...actions };
  return { getState: () => state, setState: (next: any) => { state = { ...state, ...next }; }, observed,
    open: async (remote: boolean) => { await state.loadSceneFromFile('startup.scene.json', () => true, remote); return state; } };
}

test('中台 SOURCE 和本地文件写入文档时都原子关闭运行时启动门控并记录源文件位置', async () => {
  const f = storeFixture();
  const state = await f.open(true);
  assert.equal(f.observed[0].sceneStartupResourceSessionId, state.sceneSessionId);
  const local = await f.open(false);
  assert.equal(local.sceneStartupResourceSessionId, local.sceneSessionId);
  assert.equal(local.sceneSourceFilePath, 'startup.scene.json');
});

test('文件选择器入口也保存源文件位置并在写入文档的同一提交门控', async () => {
  const f = storeFixture();
  await f.getState().loadScene();
  assert.equal(f.getState().sceneSourceFilePath, 'dialog.scene.json');
  assert.equal(f.observed[0].sceneStartupResourceSessionId, f.getState().sceneSessionId);
  assert.equal(f.getState().sceneResourcePolicy, 'local-refresh');
});

test('本地恢复按会话和文档身份提交，保持历史，首帧完成前不清除问题', async () => {
  const f = storeFixture();
  const first = await f.open(false);
  const history = first.history;
  f.setState({ sceneResourceIssues: ['old path missing'] });
  const recovered = { ...first.scene, sourceUrl: 'editor-asset://current/model.glb' };
  assert.equal(first.commitRecoveredLocalSceneResources(first.sceneSessionId, first.scene, recovered), true);
  assert.equal(f.getState().sceneStartupResourceSessionId, null);
  assert.equal(f.getState().history, history);
  assert.equal(f.getState().latestSceneResourceTransaction.kind, 'local-recovery');
  assert.deepEqual(f.getState().sceneResourceIssues, ['old path missing']);
  first.finishLatestSceneResources(first.sceneSessionId, recovered);
  assert.equal(f.getState().latestSceneResourceTransaction, null);
  assert.equal(f.getState().sceneResourceIssues.length, 0);
});

test('环境候选只展示，不会默认生成替换授权；明确点击后授权仅对应当前会话和候选', async () => {
  const f = storeFixture(); const first = await f.open(false);
  const choice = { resourceId: 'env', displayName: '厂房', previousRevision: '1', availableRevision: '2',
    previousSize: 10, availableSize: 20, sha256: 'a'.repeat(64) };
  first.setLocalSceneEnvironmentRecoveryChoice(first.sceneSessionId, choice);
  assert.equal(f.getState().localSceneEnvironmentRecoveryChoice, choice);
  assert.equal(f.getState().localSceneEnvironmentRecoveryAcceptance, null);
  assert.equal(first.acceptLocalSceneEnvironmentRecoveryChoice(first.sceneSessionId, { ...choice }), false);
  assert.equal(first.acceptLocalSceneEnvironmentRecoveryChoice('old-session', choice), false);
  assert.equal(first.acceptLocalSceneEnvironmentRecoveryChoice(first.sceneSessionId, choice), true);
  assert.equal(f.getState().localSceneEnvironmentRecoveryAcceptance.fileRevision, '2');
  assert.equal(f.getState().localSceneEnvironmentRecoveryAcceptance.sha256, choice.sha256);
  first.setLocalSceneEnvironmentRecoveryChoice(first.sceneSessionId, null);
  assert.equal(f.getState().localSceneEnvironmentRecoveryAcceptance.fileRevision, '2', '其它依赖失败不撤销已确认的精确版本');
  const newChoice = { ...choice, availableRevision: '3' };
  first.setLocalSceneEnvironmentRecoveryChoice(first.sceneSessionId, newChoice);
  assert.equal(f.getState().localSceneEnvironmentRecoveryAcceptance, null, '候选改变必须重新确认');
  const second = await f.open(false);
  assert.equal(first.acceptLocalSceneEnvironmentRecoveryChoice(first.sceneSessionId, newChoice), false);
  first.setLocalSceneEnvironmentRecoveryChoice(first.sceneSessionId, choice);
  assert.equal(f.getState().sceneSessionId, second.sceneSessionId);
});

test('本地恢复渲染失败不还原旧路径，重试只建立本会话门控', async () => {
  const f = storeFixture();
  const first = await f.open(false);
  const recovered = { ...first.scene, sourceUrl: 'editor-asset://current/model.glb' };
  first.commitRecoveredLocalSceneResources(first.sceneSessionId, first.scene, recovered);
  first.finishLatestSceneResources(first.sceneSessionId, recovered, '模型解码失败', { entityIds: ['model'] });
  assert.equal(f.getState().scene, recovered);
  assert.equal(f.getState().sceneResourceIssues.at(-1), '模型解码失败');
  assert.equal(f.getState().latestSceneResourceTransaction, null);
  first.beginLocalSceneResourceRecovery(first.sceneSessionId);
  assert.equal(f.getState().sceneStartupResourceSessionId, first.sceneSessionId);
  const second = await f.open(false);
  second.beginLocalSceneResourceRecovery(first.sceneSessionId);
  assert.equal(f.getState().sceneStartupResourceSessionId, second.sceneSessionId);
  assert.equal(second.commitRecoveredLocalSceneResources(first.sceneSessionId, first.scene, recovered), false);
  const edited = { ...second.scene, edited: true };
  f.setState({ scene: edited });
  assert.equal(second.commitRecoveredLocalSceneResources(second.sceneSessionId, second.scene, recovered), false);
  assert.equal(f.getState().scene, edited);
});

test('最新资源提交只启动一次；用户真实编辑仍使旧提交失败', async () => {
  const useEditorStore = storeFixture();
  const state = await useEditorStore.open(true);
  const afterScene = { ...state.scene, name: '最新资源已关联' };
  assert.equal(state.commitLatestSceneResources(state.sceneSessionId, state.scene, afterScene), true);
  assert.equal(useEditorStore.getState().sceneStartupResourceSessionId, null);
  const edited = { ...afterScene, name: '用户编辑' };
  useEditorStore.setState({ scene: edited });
  assert.equal(state.commitLatestSceneResources(state.sceneSessionId, afterScene, state.scene), false);
  assert.equal(useEditorStore.getState().scene, edited);
});

test('查询失败释放本轮初始门控，旧会话不能释放新场景，显式重试不重建门控', async () => {
  const useEditorStore = storeFixture();
  const first = await useEditorStore.open(true);
  const second = await useEditorStore.open(true);
  second.finishSceneStartupResourcePreparation(first.sceneSessionId);
  assert.equal(useEditorStore.getState().sceneStartupResourceSessionId, second.sceneSessionId);
  second.finishSceneStartupResourcePreparation(second.sceneSessionId);
  assert.equal(useEditorStore.getState().sceneStartupResourceSessionId, null);
  assert.equal(useEditorStore.getState().scene, second.scene);
  second.finishSceneStartupResourcePreparation(second.sceneSessionId);
  assert.equal(useEditorStore.getState().sceneStartupResourceSessionId, null);
});

const panel = (await readFile(new URL('../../src/editor/panels/SceneViewPanel.tsx', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
function extractEffect(marker: string): string {
  const start = panel.indexOf('  useEffect(() => {', panel.indexOf(marker));
  const end = panel.indexOf('\n\n', panel.indexOf('  ]);', start));
  assert.ok(start >= 0 && end > start);
  return stripTypeScriptTypes(panel.slice(start, end));
}

test('97 个旧 SOURCE 模型不会在资源确认前触发 runtime.sync，释放后只提交最终模型', () => {
  const effect = extractEffect('参数值变化走单实体同步');
  for (const deferred of [true, false]) {
    const synced: unknown[] = [];
    const document = { entities: {}, entityIds: [] };
    runInNewContext(effect, {
      useEffect: (run: () => void) => run(), runtimeRef: { current: { sync: (scene: unknown) => synced.push(scene) } },
      gizmoRef: { current: { cancelActiveGroupDrag() {} } }, isRuntimePreview: false, runtimeModeRef: { current: 'edit' },
      sceneStartupResourceSessionId: deferred ? 'A' : null, sceneSessionId: 'A', sceneRuntimeStartupDeferred: deferred,
      modelParameterSyncEntityId: null, editRuntimeSceneDocument: document,
      useEditorStore: { getState: () => ({ hierarchySelectionIds: [] }) },
      attachCurrentSelectionGizmo() {}, publishSelectedInspectorSpatialInfo() {}, selectedEntityIdRef: { current: null },
    });
    assert.equal(synced.length, deferred ? 0 : 1);
    if (!deferred) assert.equal(synced[0], document);
  }
});

test('天空盒仍在加载时即使 98 个模型均就绪也不能完成，失败必须保留问题并退出轮询', () => {
  const start = panel.indexOf('      const skyboxReadiness = runtime.getSkyboxReadiness();');
  const end = panel.indexOf('      let settledModels = 0;', start);
  assert.ok(start >= 0 && end > start, '当前天空盒必须参与首帧门控');
  const gate = panel.slice(start, end);
  for (const phase of ['loading', 'error', 'ready', 'idle']) {
    const events: string[] = [];
    runInNewContext(`(() => {${gate}; events.push('continue');})()`, {
      runtime: { getSkyboxReadiness: () => ({ phase, message: 'EXR 解析失败', sourceUrl: 'current.exr' }) },
      sceneSessionId: 'A', sceneDocument: {}, currentEditor: {
        recordSceneResourceIssues: () => events.push('issue'), finishLatestSceneResources: () => events.push('finish-error'),
      },
      environmentPreparationStore: { fail: () => events.push('problem') },
      settleSceneRuntimeWithWarning: () => events.push('failed'), stopReadinessPolling: () => events.push('stop'),
      resetRenderWait: () => events.push('reset'), events,
    });
    assert.equal(events.includes('failed'), phase === 'error');
    assert.equal(events.includes('issue'), phase === 'error');
    assert.equal(events.includes('continue'), phase !== 'error');
  }
  const condition = panel.match(/const readyNow = ([\s\S]*?);/)?.[1];
  assert.ok(condition);
  for (const phase of ['loading', 'ready', 'idle']) {
    const ready = runInNewContext(condition, { settledModels: 98, totalSceneModels: 98,
      batchedEntities: 12, expectedBatchedEntities: 12, skyboxReadiness: { phase } });
    assert.equal(ready, phase !== 'loading');
  }
});

test('确认资源前天空盒与环境都不启动，释放门控后在同一设置同步中各启动一次', () => {
  const effect = extractEffect("  useEffect(() => {\n    const viewport = viewportRef.current;\n    const runtime = runtimeRef.current;\n    if (!viewport || !runtime) return;\n\n    viewport.setViewDistance");
  for (const deferred of [true, false]) {
    const events: string[] = [];
    runInNewContext(effect, {
      useEffect: (run: () => void) => run(),
      viewportRef: { current: { setViewDistance() {}, setSensitivity() {} } },
      runtimeRef: { current: { syncShadows() {}, syncSkybox: () => events.push('skybox'), syncEnvironment: () => events.push('environment') } },
      sceneDocument: { sceneSettings: { camera: {} } }, sceneRuntimeStartupDeferred: deferred,
      environmentApplyRequest: null, environmentAdjustmentActive: false, environmentRuntimeOverride: null,
      environmentStartupRelinkSessionId: null, sceneSessionId: 'A', resolveEnvironmentRuntimeSettings: () => null,
    });
    assert.deepEqual(events, deferred ? [] : ['skybox', 'environment']);
  }
});

const projectPanel = (await readFile(new URL('../../src/editor/panels/ProjectPanel.tsx', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
test('同来源同修订天空盒每轮资源准备完成后只重试一次，普通场景变化和轮询不重复重试', () => {
  const start = panel.indexOf('      const skyboxResourceRefreshKey = ');
  const end = panel.indexOf('      const skyboxReadiness = runtime.getSkyboxReadiness();', start);
  assert.ok(start >= 0 && end > start, '显式资源同步必须可以重试同来源的失败天空盒');
  const source = stripTypeScriptTypes(`(() => {${panel.slice(start, end)}})()`);
  const skyboxResourceRetryKeyRef = { current: null };
  const failedResourceRetrySessionRef = { current: null };
  const calls: string[] = [];
  const modelRetries: string[] = [];
  const preparationState = { assetRefreshId: 'refresh-1', modelSyncRunId: 'sync-1' };
  const context = { sceneSessionId: 'scene-A', preparationState, skyboxResourceRetryKeyRef, failedResourceRetrySessionRef,
    editRuntimeSceneDocument: {}, currentEditor: { hierarchySelectionIds: [] },
    useEditorStore: { getState: () => ({ sceneResourcePolicy: 'preserve-snapshot' }) },
    runtime: { retryFailedSceneResources: () => modelRetries.push(preparationState.assetRefreshId),
      retrySkyboxLoading: () => calls.push(`${preparationState.modelSyncRunId}/${preparationState.assetRefreshId}`) } };
  runInNewContext(source, context);
  runInNewContext(source, context);
  assert.deepEqual(calls, ['sync-1/refresh-1']);
  assert.deepEqual(modelRetries, [], '首次打开不能重试尚在首次加载的模型');
  preparationState.assetRefreshId = 'refresh-2';
  runInNewContext(source, context);
  runInNewContext(source, context);
  assert.deepEqual(calls, ['sync-1/refresh-1', 'sync-1/refresh-2']);
  assert.deepEqual(modelRetries, ['refresh-2'], '同场景的新恢复轮次只重试失败项一次');
  preparationState.modelSyncRunId = 'sync-2';
  runInNewContext(source, context);
  assert.equal(calls.length, 3);
  context.sceneSessionId = 'scene-B';
  runInNewContext(source, context);
  assert.equal(calls.length, 4, '新会话的首次资源准备不能复用 A 的重试记录');
  assert.equal(modelRetries.length, 2, '切到新会话不重试 A 的旧失败');
});

test('后台天空盒同步在最新资源事务期间保留待应用，初始目录关联可以在查询前落定', () => {
  const start = projectPanel.indexOf('  const relinkCurrentSkyboxFromAssets = useCallback((');
  const ending = '  }, [pushLog, updateSkyboxConfig]);';
  const end = projectPanel.indexOf(ending, start) + ending.length;
  assert.ok(start >= 0 && end > start);
  const source = stripTypeScriptTypes(projectPanel.slice(start, end));
  let state: any = { scene: { id: 'scene', skybox: { sourceUrl: 'old.exr' } }, latestSceneResourceTransaction: null };
  const localResourcePreparingRef = { current: true };
  const relink = runInNewContext(`${source}; relinkCurrentSkyboxFromAssets`, {
    useCallback: (fn: unknown) => fn, useEditorStore: { getState: () => state }, localResourcePreparingRef,
    getSceneSkyboxSettings: (scene: any) => scene.skybox, findSkyboxAssetForSettings: (_skybox: unknown, assets: unknown[]) => assets[0],
    createSceneSkyboxFromAsset: (asset: unknown) => asset, updateSkyboxConfig: (skybox: unknown) => { state.scene = { ...state.scene, skybox }; },
    pushLog() {}, formatSkyboxSyncError: String, packagedSkyboxesRef: { current: [] },
  });
  const before = state.scene;
  assert.equal(relink([{ sourceUrl: 'latest.exr' }], 'scene'), 'blocked');
  assert.equal(state.scene, before);
  assert.equal(relink([{ sourceUrl: 'latest.exr' }], 'scene', false, true), 'applied');
  localResourcePreparingRef.current = false;
  state.latestSceneResourceTransaction = {};
  assert.equal(relink([{ sourceUrl: 'newest.exr' }], 'scene'), 'blocked');
  state.latestSceneResourceTransaction = null;
  assert.equal(relink([{ sourceUrl: 'newest.exr' }], 'scene'), 'applied');
  state.sceneResourcePolicy = 'local-refresh';
  const recovered = state.scene;
  assert.equal(relink([{ sourceUrl: 'newer.exr' }], 'scene'), 'unchanged');
  assert.equal(relink([{ sourceUrl: 'newer.exr' }], 'scene', false, true), 'unchanged');
  assert.equal(state.scene, recovered, '本地场景目录扫描和后台同步不能重新升级恢复后的天空盒');
});
