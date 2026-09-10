import assert from 'node:assert/strict';
import test from 'node:test';
import { runSceneModelSyncTransaction, shouldValidateSceneModelResources, acquireSceneModelPublishOperation, getSceneModelPublishSession } from '../../src/editor/assets/sceneModelSyncTransaction.ts';

test('发布占用覆盖多轮准备，旧释放函数不能解除新发布占用', () => {
  const release = acquireSceneModelPublishOperation('A');
  assert.equal(getSceneModelPublishSession(), 'A');
  assert.throws(() => acquireSceneModelPublishOperation('B'), /发布/);
  release();
  const releaseNext = acquireSceneModelPublishOperation('B');
  release();
  assert.equal(getSceneModelPublishSession(), 'B');
  releaseNext();
  assert.equal(getSceneModelPublishSession(), null);
});

function fixture() {
  let snapshot = { sceneSessionId: 'A', scene: { value: 1 } as any };
  const requests: Array<{ value: number; syncLibrary: boolean }> = [];
  const commits: any[] = [];
  const options = {
    sceneSessionId: 'A', syncLibrary: true, getSnapshot: () => snapshot,
    prepare: async (scene: any, syncLibrary: boolean) => {
      requests.push({ value: scene.value, syncLibrary });
      return { configured: true, sourceKey: 'source', modelAssets: [], environmentAssets: [], modelReplacements: [] };
    },
    apply: async (scene: any) => ({ scene: { ...scene, updated: true }, updatedCount: 1, issues: [] as string[] }),
    commit: (before: any, after: any, issues: string[]) => {
      assert.equal(before, snapshot.scene);
      commits.push({ before, after, issues }); snapshot = { ...snapshot, scene: after }; return true;
    },
  };
  return { options, requests, commits, replace: (value: number) => { snapshot = { ...snapshot, scene: { value } }; },
    switchScene: () => { snapshot = { ...snapshot, sceneSessionId: 'B' }; } };
}

test('主动同步准备成功后只提交一次，单独返回模型库问题', async () => {
  const f = fixture();
  const prepare = f.options.prepare;
  f.options.prepare = async (...args) => ({ ...await prepare(...args), libraryErrors: ['未引用模型下载失败'] });
  const result = await runSceneModelSyncTransaction(f.options);
  assert.equal(result?.updatedCount, 1);
  assert.deepEqual(result?.libraryErrors, ['未引用模型下载失败']);
  assert.equal(f.commits.length, 1); assert.deepEqual(f.commits[0].issues, []);
});

test('下载期间修改参数时重新校验最新文档，完整模型库只同步一次', async () => {
  const f = fixture(); const prepare = f.options.prepare;
  f.options.prepare = async (...args) => {
    const result = await prepare(...args); if (f.requests.length === 1) f.replace(9); return result;
  };
  await runSceneModelSyncTransaction(f.options);
  assert.deepEqual(f.requests, [{ value: 1, syncLibrary: true }, { value: 9, syncLibrary: false }]);
  assert.equal(f.commits[0].after.value, 9); assert.equal(f.commits.length, 1);
});

test('异步环境准备期间编辑同样重新校验，不覆盖后来的编辑', async () => {
  const f = fixture(); let applied = 0; const apply = f.options.apply;
  f.options.apply = async scene => { if (++applied === 1) f.replace(7); return apply(scene); };
  await runSceneModelSyncTransaction(f.options);
  assert.equal(f.commits[0].after.value, 7);
});

test('连续编辑达到重试上限保留最新场景，不能无限重试或提交旧值', async () => {
  const f = fixture(); const prepare = f.options.prepare;
  f.options.prepare = async (...args) => { const result = await prepare(...args); f.replace(f.requests.length + 1); return result; };
  await assert.rejects(runSceneModelSyncTransaction(f.options), /场景持续发生变化/);
  assert.equal(f.requests.length, 2); assert.equal(f.commits.length, 0);
});

test('查询与应用期间切换会话均丢弃结果', async () => {
  for (const phase of ['prepare', 'apply'] as const) {
    const f = fixture(); const original = f.options[phase];
    (f.options as any)[phase] = async (...args: any[]) => { f.switchScene(); return (original as any)(...args); };
    assert.equal(await runSceneModelSyncTransaction(f.options), null);
    assert.equal(f.commits.length, 0);
  }
});

test('未配置或准备失败不能伪装为已更新，提交拒绝不能覆盖场景', async () => {
  const f = fixture();
  f.options.prepare = async () => ({ configured: false, sourceKey: null as any, modelAssets: [], environmentAssets: [], modelReplacements: [] });
  await assert.rejects(runSceneModelSyncTransaction(f.options), /数据中台/);
  assert.equal(f.commits.length, 0);
  const g = fixture(); g.options.commit = () => false;
  await assert.rejects(runSceneModelSyncTransaction(g.options), /无法提交/);
});

test('快照场景的主动更新及失败恢复同样检查运行时错误，旧事务不认领新文档', () => {
  const scene = {} as any, other = {} as any;
  const state = { sceneResourcePolicy: 'preserve-snapshot', latestSceneResourceTransaction: null as any,
    latestSceneResourceRecovery: null as any };
  assert.equal(shouldValidateSceneModelResources(state, scene), false);
  state.latestSceneResourceTransaction = { after: scene };
  assert.equal(shouldValidateSceneModelResources(state, scene), true);
  assert.equal(shouldValidateSceneModelResources(state, other), false);
  state.latestSceneResourceTransaction = null; state.latestSceneResourceRecovery = { after: scene };
  assert.equal(shouldValidateSceneModelResources(state, scene), true);
  assert.equal(shouldValidateSceneModelResources({ ...state, sceneResourcePolicy: 'local-refresh' }, other), true);
});
