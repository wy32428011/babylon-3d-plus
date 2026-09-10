import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../../src/editor/panels/ProjectPanel.tsx', import.meta.url), 'utf8');
const start = source.indexOf("  useEffect(() => {\n    if (sceneResourcePolicy === 'preserve-snapshot') return;");
const end = source.indexOf('\n\n  useEffect(', start + 1);
assert.ok(start >= 0 && end > start);
const effect = stripTypeScriptTypes(source.slice(start, end));
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(failMerge = false, initialEnvironment: unknown = null) {
  let preparing = false;
  let resolve!: (value: unknown) => void, cleanup!: () => void;
  const promise = new Promise(done => { resolve = done; });
  const events: string[] = [];
  const state: any = { sceneSessionId: 'A', sceneStartupResourceSessionId: 'A', environmentStartupRelinkSessionId: 'A',
    scene: { sceneSettings: { environment: initialEnvironment } } };
  state.finishSceneStartupResourcePreparation = (sessionId: string) => {
    if (state.sceneStartupResourceSessionId === sessionId) state.sceneStartupResourceSessionId = null;
  };
  const original = state.scene;
  state.commitLatestSceneResources = (_session: string, before: unknown, after: unknown, issues: string[]) => {
    if (state.scene !== before) return false;
    events.push('commit'); state.scene = after; state.committedIssues = issues; return true;
  };
  state.recordSceneResourceIssues = (_session: string, issues: string[]) => { state.issues = issues; };
  state.finishLatestSceneResources = (_session: string, _scene: unknown, error?: string) => { state.issues = error ? [error] : []; events.push('finish'); };
  let requested: any;
  runInNewContext(effect, {
    Error, useEffect: (run: () => () => void) => { cleanup = run(); },
    sceneResourcePolicy: 'data-platform-refresh', sceneSessionId: 'A', localResourceRetry: 0,
    localResourcePreparingRef: { current: false }, initialProjectAssetsLoadPromiseRef: { current: Promise.resolve() },
    setIsPreparingSceneResources(value: boolean) { preparing = value; },
    useEditorStore: { getState: () => state }, serializeScene: JSON.stringify,
    window: { editorApi: { prepareLocalSceneResources: (request: unknown) => { requested = request; events.push('query'); return promise; } } },
    getSceneEnvironmentUpdateReference: () => undefined, getRequiredEnvironmentResourceIds: () => [],
    reportSceneModelSyncProgress: (_session: string, progress: any) => events.push(progress.phase),
    beginSceneModelAssetRefresh: () => events.push('refresh'), settleSceneModelAssetRefresh: () => events.push('settled'),
    applyAvailableSceneModelUpdates: (_before: unknown, _replacements: unknown, _source: string, environment: unknown) => {
      if (failMerge) throw new Error('参数冲突'); return { scene: { sceneSettings: { environment }, updated: true }, issues: [] };
    },
    allowScenePreparationEditing(_session: string, allowed: boolean) { if (allowed) events.push('editing-unlocked'); },
    settleSceneRuntimeWithWarning: () => events.push('editable-warning'),
    environmentPreparationStore: { clearError() {}, fail: (_session: string, error: string) => events.push('error:' + error) },
    loadProjectAssets: () => { throw new Error('禁止按全库候选覆盖场景'); },
    loadEnvironmentFromAsset() {}, pushLog() {}, requestEnvironmentApply() { events.push('environment-start'); }, crypto: { randomUUID: () => 'refresh' },
  });
  return { resolve, cleanup, state, original, events, request: () => requested, preparing: () => preparing };
}
const result = { configured: true, sourceKey: 'source', modelReplacements: [], modelAssets: [], environmentAssets: [] };

test('纯本地环境原样保留，不因缺少远端环境返回值制造发布阻断', async () => {
  const f = fixture();
  const environment = { source: 'local', sourceUrl: 'editor-asset://local/local.glb', opacity: .4 };
  f.state.scene.sceneSettings.environment = environment;
  await tick(); f.resolve(result); await tick();
  assert.equal(f.state.scene.sceneSettings.environment, environment);
  assert.equal(f.state.committedIssues.length, 0);
  assert.ok(!f.events.includes('editable-warning'));
  f.cleanup();
});

test('明确中台环境缺失仍保留局部问题，纯本地环境也不吞主进程返回的问题', async () => {
  for (const source of ['data-platform', 'local']) {
    const f = fixture();
    f.state.scene.sceneSettings.environment = { source, sourceUrl: 'saved.glb' };
    await tick();
    f.resolve(source === 'data-platform' ? result : { ...result, issues: [{ resourceKind: 'model', resourceId: '123', message: '缺少文件' }] });
    await tick();
    assert.ok(f.state.committedIssues.length > 0);
    assert.ok(!f.events.includes('editable-warning'), '局部同步失败仍需等待成功组与原快照首帧');
    f.cleanup();
  }
});

test('SOURCE 打开携带完整场景，先查询后原子合并，再交给渲染就绪门控', async () => {
  const f = fixture(); await tick();
  assert.equal(f.preparing(), true);
  assert.equal(f.request().mode, 'data-platform-latest'); assert.equal(f.state.scene, f.original);
  f.resolve(result); await tick();
  assert.deepEqual(f.events, ['querying', 'query', 'completed', 'refresh', 'commit', 'settled']);
  assert.equal(f.preparing(), false, '包括无变化重同步在内，资源准备结束必须解除按钮禁用'); f.cleanup();
});

test('SOURCE 查询与提交之间加载门控连续保持，不会先隐藏再出现', async () => {
  const f = fixture(); await tick();
  assert.ok(!f.events.includes('editing-unlocked'));
  f.resolve(result); await tick();
  assert.ok(!f.events.includes('editing-unlocked'));
  f.cleanup();
});
test('最新引用确认前不初始化 SOURCE 环境，避免同一厂房完整加载两次', async () => {
  const environment = { source: 'local', activeVariantUrl: 'source-factory.glb' };
  const f = fixture(false, environment); await tick();
  assert.ok(!f.events.includes('environment-start'));
  f.resolve(result); await tick();
  assert.ok(!f.events.includes('environment-start'));
  assert.equal(f.state.scene.sceneSettings.environment, environment);
  f.cleanup();
});
test('资源查询异常后释放初始运行时门控，保留原始快照交给真实首帧校验', async () => {
  const f = fixture(); await tick(); f.resolve({ configured: false }); await tick();
  assert.equal(f.state.sceneStartupResourceSessionId, null);
  assert.equal(f.state.scene, f.original);
  assert.ok(f.state.issues.length > 0);
  assert.ok(!f.events.includes('editable-warning'));
  f.cleanup();
});
test('参数冲突保留原文档并带警告进入编辑，查询期间编辑不会被覆盖', async () => {
  const f = fixture(true); await tick(); f.resolve(result); await tick();
  assert.equal(f.preparing(), false);
  assert.equal(f.state.scene, f.original); assert.ok(f.events.includes('error:参数冲突'));
  assert.ok(!f.events.includes('editable-warning')); assert.equal(f.state.issues.join('\n'), '参数冲突'); f.cleanup();
  const changed = fixture(); await tick(); const edited = { sceneSettings: { environment: null }, userEdit: true };
  changed.state.scene = edited; changed.resolve(result); await tick();
  assert.equal(changed.state.scene, edited); assert.ok(!changed.events.includes('commit')); changed.cleanup();
});
test('取消或切到 B 后，A 的返回值不能提交或解除 B 的蒙版', async () => {
  const f = fixture(); await tick(); f.cleanup(); f.state.sceneSessionId = 'B'; f.resolve(result); await tick();
  assert.equal(f.preparing(), false);
  assert.deepEqual(f.events, ['querying', 'query']); assert.equal(f.state.scene, f.original);
});

test('已知局部资源失败保留成功组和问题身份，等待运行时后才结束加载', async () => {
  const f = fixture(); await tick();
  f.resolve({ ...result, issues: [{ resourceKind: 'model', resourceId: '123', message: '下载失败' }] });
  await tick();
  assert.ok(f.events.includes('commit'));
  assert.ok(!f.events.includes('finish'));
  assert.ok(!f.events.includes('editable-warning'));
  assert.equal(f.state.committedIssues[0], '[model 123] 下载失败');
  f.cleanup();
});
