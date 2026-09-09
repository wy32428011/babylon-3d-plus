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

function fixture(failMerge = false) {
  let preparing = false;
  let resolve!: (value: unknown) => void, cleanup!: () => void;
  const promise = new Promise(done => { resolve = done; });
  const events: string[] = [];
  const state: any = { sceneSessionId: 'A', scene: { sceneSettings: { environment: null } } };
  const original = state.scene;
  state.commitLatestSceneResources = (_session: string, before: unknown, after: unknown) => {
    if (state.scene !== before) return false;
    events.push('commit'); state.scene = after; return true;
  };
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
    applySceneModelUpdates: () => { if (failMerge) throw new Error('参数冲突'); return { scene: { sceneSettings: { environment: null }, updated: true } }; },
    environmentPreparationStore: { clearError() {}, fail: (_session: string, error: string) => events.push('error:' + error) },
    loadProjectAssets: () => { throw new Error('禁止按全库候选覆盖场景'); },
    loadEnvironmentFromAsset() {}, pushLog() {}, requestEnvironmentApply() {}, crypto: { randomUUID: () => 'refresh' },
  });
  return { resolve, cleanup, state, original, events, request: () => requested, preparing: () => preparing };
}
const result = { configured: true, sourceKey: 'source', modelReplacements: [], modelAssets: [], environmentAssets: [] };

test('SOURCE 打开携带完整场景，先查询后原子合并，再交给渲染就绪门控', async () => {
  const f = fixture(); await tick();
  assert.equal(f.preparing(), true);
  assert.equal(f.request().mode, 'data-platform-latest'); assert.equal(f.state.scene, f.original);
  f.resolve(result); await tick();
  assert.deepEqual(f.events, ['querying', 'query', 'completed', 'refresh', 'commit', 'settled']);
  assert.equal(f.preparing(), false, '包括无变化重同步在内，资源准备结束必须解除按钮禁用'); f.cleanup();
});
test('参数冲突或查询期间用户编辑都保留原文档且不解除就绪门控', async () => {
  const f = fixture(true); await tick(); f.resolve(result); await tick();
  assert.equal(f.preparing(), false);
  assert.equal(f.state.scene, f.original); assert.ok(f.events.includes('error:参数冲突')); assert.ok(!f.events.includes('settled')); f.cleanup();
  const changed = fixture(); await tick(); const edited = { sceneSettings: { environment: null }, userEdit: true };
  changed.state.scene = edited; changed.resolve(result); await tick();
  assert.equal(changed.state.scene, edited); assert.ok(!changed.events.includes('commit')); changed.cleanup();
});
test('取消或切到 B 后，A 的返回值不能提交或解除 B 的蒙版', async () => {
  const f = fixture(); await tick(); f.cleanup(); f.state.sceneSessionId = 'B'; f.resolve(result); await tick();
  assert.equal(f.preparing(), false);
  assert.deepEqual(f.events, ['querying', 'query']); assert.equal(f.state.scene, f.original);
});
