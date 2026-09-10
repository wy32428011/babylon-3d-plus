import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const source = (await readFile(new URL('../../src/editor/panels/ProjectPanel.tsx', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const start = source.indexOf("  useEffect(() => {\n    if (sceneResourcePolicy === 'preserve-snapshot') return;");
const end = source.indexOf('\n\n  useEffect(', start + 1);
assert.ok(start >= 0 && end > start);
const effect = stripTypeScriptTypes(source.slice(start, end));
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture() {
  let resolve!: (value: unknown) => void;
  let cleanup!: () => void;
  const pending = new Promise(done => { resolve = done; });
  const events: string[] = [];
  const state: any = {
    sceneSessionId: 'A', sceneSourceFilePath: 'E:/scenes/factory.scene.json', sceneResourcePolicy: 'local-refresh',
    sceneStartupResourceSessionId: 'A', sceneResourceIssues: [],
    scene: { id: 'factory', sceneSettings: { environment: null }, entities: { m: { id: 'm', parameter: 123 } } },
  };
  const original = state.scene;
  state.beginLocalSceneResourceRecovery = (session: string) => {
    if (session === state.sceneSessionId) state.sceneStartupResourceSessionId = session;
  };
  state.commitRecoveredLocalSceneResources = (session: string, before: unknown, after: unknown) => {
    if (session !== state.sceneSessionId || before !== state.scene) return false;
    events.push('commit'); state.scene = after; state.sceneStartupResourceSessionId = null; return true;
  };
  state.recordSceneResourceIssues = (_session: string, issues: string[]) => { state.sceneResourceIssues = issues; };
  state.commitLatestSceneResources = (session: string, before: unknown, after: unknown, issues: string[]) => {
    const committed = state.commitRecoveredLocalSceneResources(session, before, after);
    if (committed) state.sceneResourceIssues = issues;
    return committed;
  };
  state.setLocalSceneEnvironmentRecoveryChoice = (_session: string, choice: unknown) => {
    state.localSceneEnvironmentRecoveryChoice = choice;
    state.localSceneEnvironmentRecoveryAcceptance = null;
  };
  let requested: any;
  runInNewContext(effect, {
    Error, useEffect: (run: () => () => void) => { cleanup = run(); },
    sceneResourcePolicy: 'local-refresh', sceneSessionId: 'A', localResourceRetry: 0,
    localResourcePreparingRef: { current: false }, initialProjectAssetsLoadPromiseRef: { current: Promise.resolve() },
    setIsPreparingSceneResources() {}, useEditorStore: { getState: () => state },
    serializeScene: JSON.stringify, deserializeScene: JSON.parse,
    window: { editorApi: { prepareLocalSceneResources: (request: any) => {
      requested = request; events.push('query');
      return request.mode === 'local-recovery' ? Promise.resolve({ recoveredSceneContent: request.sceneContent, issues: [] }) : pending;
    } } },
    applyAvailableSceneModelUpdates: (scene: any, replacements: any[]) => ({
      scene: { ...scene, modelVersion: replacements[0]?.asset.assetRevision }, issues: [], updatedCount: replacements.length,
    }),
    getRequiredEnvironmentResourceIds: () => [],
    reportSceneModelSyncProgress: (_session: string, progress: any) => events.push(progress.phase),
    beginSceneModelAssetRefresh: () => events.push('refresh'), settleSceneModelAssetRefresh: () => events.push('settled'),
    allowScenePreparationEditing: (_session: string, allowed: boolean) => { if (allowed) events.push('editing-unlocked'); },
    environmentPreparationStore: { clearError() {}, fail: (_session: string, error: string) => events.push('error:' + error) },
    loadProjectAssets: () => { throw new Error('恢复期间禁止全库覆盖本地场景版本'); },
    pushLog() {}, requestEnvironmentApply() {}, crypto: { randomUUID: () => 'refresh' },
  });
  return { state, original, resolve, cleanup, events, request: () => requested };
}

test('本地恢复请求携带完整场景和源文件位置，未配置中台也能原子提交恢复结果', async () => {
  const f = fixture(); await tick();
  assert.equal(f.request().mode, 'local-latest');
  assert.equal(f.request().sceneFilePath, f.state.sceneSourceFilePath);
  assert.deepEqual(JSON.parse(f.request().sceneContent), f.original);
  const after = { ...f.original, recovered: true };
  f.resolve({ configured: false, recoveredSceneContent: JSON.stringify(after), recoveredReferenceCount: 2, issues: [] });
  await tick();
  assert.equal(f.state.scene.recovered, true);
  assert.equal(f.state.scene.entities.m.parameter, 123);
  assert.equal(f.state.sceneStartupResourceSessionId, null);
  assert.ok(f.events.includes('commit'));
  assert.ok(!f.events.includes('editing-unlocked'), '提交后仍等待实际首帧');
  f.cleanup();
});

test('资源缺失或歧义时不应用部分恢复文档，不释放旧路径的运行时门控', async () => {
  const f = fixture(); await tick();
  f.resolve({ configured: true, recoveredSceneContent: JSON.stringify({ partial: true }),
    issues: [{ resourceKind: 'skybox', resourceId: 'old.exr', message: '文件缺失，候选版本不一致' }] });
  await tick();
  assert.equal(f.state.scene, f.original);
  assert.equal(f.state.sceneStartupResourceSessionId, 'A');
  assert.ok(f.state.sceneResourceIssues.join('\n').includes('[skybox old.exr] 文件缺失'));
  assert.ok(f.events.includes('failed'));
  assert.ok(!f.events.includes('commit'));
  f.cleanup();
});

test('环境缺失返回的候选单独展示，未确认的第一次请求不携带替换授权', async () => {
  const f = fixture(); await tick();
  assert.equal(f.request().acceptEnvironmentRevision, undefined);
  const choice = { resourceId: 'env', availableRevision: '2', previousRevision: '1', sha256: 'a'.repeat(64) };
  f.resolve({ configured: false, recoveredSceneContent: JSON.stringify(f.original), environmentRecoveryChoice: choice,
    issues: [{ resourceKind: 'environment', message: '原版本不存在' }] });
  await tick();
  assert.equal(f.state.localSceneEnvironmentRecoveryChoice, choice);
  assert.equal(f.state.localSceneEnvironmentRecoveryAcceptance, null);
  assert.equal(f.state.scene, f.original);
});

test('本地打开先替换中台新版模型，再恢复其他依赖并一次提交，保留实例配置', async () => {
  const f = fixture(); await tick();
  assert.equal(f.request().mode, 'local-latest');
  f.resolve({ configured: true, sourceKey: 'current', modelAssets: [], environmentAssets: [],
    modelReplacements: [{ sourceUrls: ['old'], asset: { assetRevision: 'new' } }] });
  await tick();
  assert.equal(f.request().mode, 'local-recovery');
  assert.equal(JSON.parse(f.request().sceneContent).modelVersion, 'new');
  assert.equal(f.state.scene.modelVersion, 'new');
  assert.equal(f.state.scene.entities.m.parameter, 123);
  assert.equal(f.events.filter(item => item === 'commit').length, 1);
  assert.equal(f.state.sceneResourceIssues.length, 0);
  f.cleanup();
});

test('请求只携带用户已确认的精确环境版本授权', async () => {
  const f = fixture();
  const acceptance = { resourceId: 'env', fileRevision: '2', sha256: 'b'.repeat(64) };
  f.state.localSceneEnvironmentRecoveryAcceptance = acceptance;
  await tick(); assert.equal(f.request().acceptEnvironmentRevision, acceptance);
  f.resolve({ configured: false, recoveredSceneContent: JSON.stringify(f.original), issues: [] });
  await tick(); f.cleanup();
});

test('缺少完整恢复结果明确失败，不能把 configured=false 当成直接加载旧路径', async () => {
  const f = fixture(); await tick(); f.resolve({ configured: false }); await tick();
  assert.equal(f.state.scene, f.original);
  assert.equal(f.state.sceneStartupResourceSessionId, 'A');
  assert.ok(f.state.sceneResourceIssues.length > 0);
  f.cleanup();
});

test('恢复期间发生真实编辑或切换场景，旧返回不能覆盖内容或解除新门控', async () => {
  for (const switched of [false, true]) {
    const f = fixture(); await tick();
    const edited = { ...f.original, name: '用户修改' };
    f.state.scene = edited;
    if (switched) { f.state.sceneSessionId = 'B'; f.state.sceneStartupResourceSessionId = 'B'; }
    f.resolve({ configured: false, recoveredSceneContent: JSON.stringify(f.original), issues: [],
      environmentRecoveryChoice: { resourceId: 'old-environment' } });
    await tick();
    assert.equal(f.state.scene, edited);
    assert.equal(f.state.sceneStartupResourceSessionId, switched ? 'B' : 'A');
    assert.ok(!f.events.includes('commit'));
    assert.equal(f.state.localSceneEnvironmentRecoveryChoice, undefined, '旧文档的版本选择也不能污染当前场景');
    f.cleanup();
  }
});

test('取消恢复后迟到的结果不能提交', async () => {
  const f = fixture(); await tick(); f.cleanup();
  f.resolve({ configured: false, recoveredSceneContent: JSON.stringify({ replaced: true }), issues: [] });
  await tick(); assert.equal(f.state.scene, f.original); assert.ok(!f.events.includes('commit'));
});
