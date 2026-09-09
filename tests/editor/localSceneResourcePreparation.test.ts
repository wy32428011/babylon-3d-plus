import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { findMatchingEnvironmentResource } from '../../electron/shared/environmentResourceMatch.ts';
import { environmentForSyncRun } from '../../src/editor/assets/environmentSyncAuthority.ts';

const panel = await readFile(new URL('../../src/editor/panels/ProjectPanel.tsx', import.meta.url), 'utf8');
const start = panel.indexOf("  useEffect(() => {\n    if (sceneResourcePolicy === 'preserve-snapshot') return;");
const end = panel.indexOf('\n\n  useEffect(', start + 1);
assert.ok(start >= 0 && end > start);
const effect = stripTypeScriptTypes(panel.slice(start, end));
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture() {
  const events: string[] = [];
  let resolve!: (value: unknown) => void;
  let reject!: (error: Error) => void;
  const sync = new Promise((done, fail) => { resolve = done; reject = fail; });
  let cleanup!: () => void;
  let refreshOptions: any;
  const preparing = { current: false };
  const state = { sceneSessionId: 'local', scene: { sceneSettings: { environment: null } } };
  runInNewContext(effect, {
    Error,
    useEffect: (run: () => () => void) => { cleanup = run(); },
    sceneResourcePolicy: 'local-refresh', sceneSessionId: 'local', localResourceRetry: 0,
    localResourcePreparingRef: preparing, initialProjectAssetsLoadPromiseRef: { current: Promise.resolve() },
    setIsPreparingSceneResources() {},
    useEditorStore: { getState: () => state },
    window: { editorApi: { prepareLocalSceneResources: () => { events.push('sync-start'); return sync; } } },
    getRequiredEnvironmentResourceIds: () => [],
    reportSceneModelSyncProgress: (_session: string, progress: { phase: string }) => events.push(progress.phase),
    beginSceneModelAssetRefresh: () => events.push('refresh-start'),
    settleSceneModelAssetRefresh: () => events.push('refresh-settled'),
    loadProjectAssets: async (options: unknown) => { refreshOptions = options; events.push('refresh'); return { ok: true }; },
    environmentPreparationStore: { clearError() {}, fail: (_session: string, error: string) => events.push(error) },
    pushLog() {}, requestEnvironmentApply() {}, crypto: { randomUUID: () => 'refresh-id' },
  });
  return { events, resolve, reject, cleanup, preparing, state, options: () => refreshOptions };
}

test('本地场景等待本轮同步事务，再全量重关联；缓存未变化也不跳过', async () => {
  const f = fixture();
  await tick();
  assert.deepEqual(f.events, ['querying', 'sync-start']);
  f.resolve({ configured: true, modelAssets: [], environmentAssets: [], sourceKey: 'current' });
  await tick();
  assert.deepEqual(f.events, ['querying', 'sync-start', 'completed', 'refresh-start', 'refresh', 'refresh-settled']);
  assert.equal(f.options().refreshModels, true);
  assert.equal(f.options().refreshEnvironment, true);
  assert.equal(f.options().modelResourceKeys, null);
  assert.equal(f.options().preserveResolvedSnapshots, false);
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
  f.resolve({ configured: true });
  await tick();
  assert.deepEqual(f.events, ['querying', 'sync-start']);
});

test('同步失败显示原因且不宣布完成；未配置中台继续保留本地快照', async () => {
  const failed = fixture();
  await tick();
  failed.reject(new Error('环境模型 SHA-256 校验失败'));
  await tick();
  assert.deepEqual(failed.events, ['querying', 'sync-start', '环境模型 SHA-256 校验失败']);
  failed.cleanup();
  const local = fixture();
  await tick();
  local.resolve({ configured: false, modelAssets: [], environmentAssets: [] });
  await tick();
  assert.equal(local.options().preserveResolvedSnapshots, true);
  assert.equal(local.options().preservePackagedEnvironment, true);
  assert.equal(local.events.at(-1), 'refresh-settled');
  local.cleanup();
});
