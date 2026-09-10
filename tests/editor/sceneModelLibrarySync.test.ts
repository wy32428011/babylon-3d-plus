import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const source = await readFile(new URL('../../src/editor/panels/ProjectPanel.tsx', import.meta.url), 'utf8');
const start = source.indexOf('  const startModelLibrarySync = useCallback(');
const end = source.indexOf('\n\n  useEffect(', start);

function fixture(ready = true) {
  assert.ok(start >= 0 && end > start, '模型库应有独立的全量同步入口');
  const calls: string[] = [];
  const session = { current: 'A' };
  const scope: any = {
    useCallback: (fn: unknown) => fn, props: {}, pushLog: (message: string) => calls.push(message),
    sceneSessionIdRef: session, localResourcePreparingRef: { current: false },
    startingLibrarySyncSessionRef: { current: null },
    getScenePreparationSnapshot: () => ({ sceneSessionId: session.current, completed: ready }),
    isScenePreparationSettled: (state: any) => state.completed,
    getDataPlatformModelSyncApi: () => ({ syncDataPlatformModels: async (...args: unknown[]) => {
      assert.equal(args.length, 0); calls.push('all-models'); return true;
    } }),
    getDataPlatformEnvironmentSyncApi: () => ({ syncDataPlatformEnvironments: async (...args: unknown[]) => {
      assert.equal(args.length, 0, '全库同步不能携带场景 requiredResourceIds 过滤'); calls.push('all-environments'); return true;
    } }),
    setIsStartingLibrarySync: (value: boolean) => calls.push(`starting:${value}`),
    setLibraryStatuses: () => calls.push('status'),
  };
  runInNewContext(stripTypeScriptTypes(source.slice(start, end)) + '\nglobalThis.start = startModelLibrarySync;', scope);
  return { calls, scope, session, run: () => scope.start() };
}

test('全库同步调用普通/组合与环境全量入口，不改当前场景', async () => {
  const f = fixture(); await f.run();
  assert.ok(f.calls.includes('all-models'));
  assert.ok(f.calls.includes('all-environments'));
});

test('场景必需资源未就绪时不启动后台全库任务', async () => {
  const f = fixture(false); await f.run();
  assert.deepEqual(f.calls, []);
});

test('启动中重复点击不会重复提交全库任务', async () => {
  const f = fixture();
  await Promise.all([f.run(), f.run()]);
  assert.equal(f.calls.filter(x => x === 'all-models').length, 1);
});

test('上一轮库启动仍在退出时推迟自动同步，结束后继续补齐全库', () => {
  const effectStart = source.indexOf('  useEffect(() => {\n    if (isPreparingSceneResources && autoLibrarySyncSessionRef.current');
  const effectEnd = source.indexOf('\n\n  useEffect(', effectStart + 1);
  assert.ok(effectStart >= 0 && effectEnd > effectStart);
  const calls: boolean[] = [];
  const scope: any = { useEffect: (run: () => void) => run(),
    isPreparingSceneResources: false, isStartingLibrarySync: true,
    autoLibrarySyncSessionRef: { current: null }, sceneSessionId: 'A',
    preparation: { sceneSessionId: 'A', completed: true },
    isScenePreparationSettled: (state: any) => state.completed,
    latestSceneResourceTransaction: null, props: {},
    startModelLibrarySync: (automatic: boolean) => calls.push(automatic),
    setModelSyncProgress() {}, setEnvironmentSyncProgress() {},
  };
  const effect = stripTypeScriptTypes(source.slice(effectStart, effectEnd));
  runInNewContext(effect, scope);
  assert.deepEqual(calls, []);
  assert.equal(scope.autoLibrarySyncSessionRef.current, null);
  scope.isStartingLibrarySync = false;
  runInNewContext(effect, scope);
  runInNewContext(effect, scope);
  assert.deepEqual(calls, [true]);
});

test('本地恢复与远端场景全库终态只刷新卡片，即使首帧未完成也不替换场景版本', async () => {
  const refreshStart = source.indexOf('    const refreshSceneModelsForSyncRun = (');
  const refreshEnd = source.indexOf("\n    let lastLogKey = '';", refreshStart);
  assert.ok(refreshStart >= 0 && refreshEnd > refreshStart);
  for (const sceneResourcePolicy of ['local-refresh', 'data-platform-refresh']) {
  const loads: any[] = [];
  const scope: any = {
    useEditorStore: { getState: () => ({ sceneResourcePolicy }) },
    getScenePreparationSnapshot: () => ({ completed: false }),
    isScenePreparationSettled: (state: any) => state.completed,
    lastSceneRefreshModelSyncRunIdRef: { current: null },
    initialProjectAssetsLoadPromiseRef: { current: Promise.resolve() },
    sceneSessionIdRef: { current: 'A' },
    loadProjectAssets: async (options: any) => { loads.push(options); return { ok: true }; },
  };
  runInNewContext(stripTypeScriptTypes(source.slice(refreshStart, refreshEnd))
    + '\nglobalThis.refresh = refreshSceneModelsForSyncRun;', scope);
  scope.refresh({ runId: 'library-run', phase: 'completed', libraryChanged: false, runtimeChangedResourceKeys: ['model:789'] }, 'A');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(loads.length, 1);
  assert.equal(loads[0].refreshModels, false);
  scope.refresh({ runId: 'old-run', phase: 'completed' }, 'old-session');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(loads.length, 1, '旧会话完成不能刷新新场景的库');
  }
});

test('本地打开的初始目录扫描不改模型、环境和天空盒，完整恢复事务负责提交', () => {
  const initialStart = source.indexOf('    const initialLoadPromise = loadProjectAssets({');
  const initialEnd = source.indexOf('    });', initialStart) + '    });'.length;
  assert.ok(initialStart >= 0 && initialEnd > initialStart);
  let options: any;
  runInNewContext(source.slice(initialStart, initialEnd), {
    sceneResourcePolicy: 'local-refresh', refreshStartupEnvironment: true,
    loadProjectAssets(value: unknown) { options = value; },
  });
  assert.equal(options.refreshModels, false);
  assert.equal(options.refreshEnvironment, false);
  assert.equal(options.refreshSkybox, false);
});
