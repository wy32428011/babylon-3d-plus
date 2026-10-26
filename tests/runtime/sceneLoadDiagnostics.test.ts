import assert from 'node:assert/strict';
import test from 'node:test';
import { SceneLoadDiagnostics } from '../../src/runtime/babylon/SceneLoadDiagnostics.ts';

test('加载诊断按阶段累计并仅保留最慢资源，报告不包含 URL 凭据', async () => {
  let now = 0;
  const diagnostics = new SceneLoadDiagnostics(() => now);
  for (let index = 0; index < 30; index += 1) {
    await diagnostics.measureAsync('assetReadDecode', async () => { now += index; },
      `https://user:secret@example.com/private/model-${index}.glb?token=secret`);
  }
  const snapshot = diagnostics.snapshot();
  assert.equal(snapshot.stages.assetReadDecode.count, 30);
  assert.equal(snapshot.stages.assetReadDecode.totalMs, 435);
  assert.equal(snapshot.slowestAssets.length, 12);
  assert.equal(snapshot.slowestAssets[0].fileName, 'model-29.glb');
  assert.equal(JSON.stringify(snapshot).includes('secret'), false);
  snapshot.slowestAssets.length = 0;
  assert.equal(diagnostics.snapshot().slowestAssets.length, 12);
});

test('失败与同步初始化均记录耗时且保留异常', async () => {
  let now = 0;
  const diagnostics = new SceneLoadDiagnostics(() => now);
  await assert.rejects(diagnostics.measureAsync('assetReadDecode', async () => {
    now += 7;
    throw new Error('load failed');
  }, 'model.glb'), /load failed/);
  assert.equal(diagnostics.measure('modelInitialize', () => { now += 3; return 42; }), 42);
  const snapshot = diagnostics.snapshot();
  assert.equal(snapshot.stages.assetReadDecode.failedCount, 1);
  assert.equal(snapshot.stages.assetReadDecode.totalMs, 7);
  assert.equal(snapshot.stages.modelInitialize.totalMs, 3);
});

test('editor-asset编码的本地路径也只保留文件名，在途任务完成后移除', async () => {
  const diagnostics = new SceneLoadDiagnostics();
  let finish!: () => void;
  const pending = diagnostics.measureAsync('environmentReadDecode', () => new Promise<void>((resolve) => { finish = resolve; }),
    'D%3A%5Cprivate%5Cproject%5Cfactory.glb?secret=token');
  assert.equal(diagnostics.snapshot().active[0].fileName, 'factory.glb');
  finish();
  await pending;
  assert.equal(diagnostics.snapshot().active.length, 0);
  assert.equal(diagnostics.snapshot().slowestAssets[0].fileName, 'factory.glb');
  diagnostics.record('assetReadDecode', 100, false, 'https://demo-user:demo-password@example.test');
  assert.equal(diagnostics.snapshot().slowestAssets[0].fileName, 'asset');
  assert.equal(JSON.stringify(diagnostics.snapshot()).includes('demo-password'), false);
});

test('同步与异步阶段保留资源和实体关联，活动数量及快照相互独立', async () => {
  let now = 0;
  const diagnostics = new SceneLoadDiagnostics(() => now);
  let finish!: () => void;
  const context = { resource: 'https://u:secret@example.test/private/LED.glb?token=secret', entityId: 'LED1' };
  const pending = diagnostics.measureAsync('entrancePrepare', () => new Promise<void>(resolve => { finish = resolve; }), context);
  now = 5;
  const active = diagnostics.snapshot();
  assert.equal(active.stages.entrancePrepare.activeCount, 1);
  assert.equal(active.active[0].entityId, 'LED1');
  assert.equal(active.active[0].fileName, 'LED.glb');
  diagnostics.measure('modelClone', () => { now += 2; }, context);
  finish(); await pending;
  assert.equal(diagnostics.snapshot().stages.entrancePrepare.activeCount, 0);
  assert.equal(diagnostics.snapshot().slowestAssets[0].entityId, 'LED1');
  assert.equal(diagnostics.snapshot().stages.modelClone.totalMs, 2);
  assert.equal(JSON.stringify(diagnostics.snapshot()).includes('secret'), false);
  active.stages.entrancePrepare.activeCount = 200;
  assert.equal(diagnostics.snapshot().stages.entrancePrepare.activeCount, 0);
});

test('脚本同步阶段按完整资源身份汇总 Top20，保持失败、脱敏及快照独立', () => {
  const diagnostics = new SceneLoadDiagnostics();
  for (let index = 0; index < 25; index++) {
    const resource = `https://user:secret@example.test/private/${index}/same.model.ts?token=secret`;
    diagnostics.record('scriptConstructor', index, false, { resource, entityId: 'entity-' + index });
    diagnostics.record('scriptOnStart', index * 2, index === 24, { resource, entityId: 'entity-' + index });
    diagnostics.record('scriptOnStart', 1, false, { resource, entityId: 'another-instance' });
  }
  // 整体等待可能与同步区间嵌套，不能把它加入同步资源排名。
  diagnostics.record('scriptInitialize', 9999, false, 'unrelated.glb');
  const snapshot = diagnostics.snapshot(), scripts = snapshot.scriptInitialization;
  assert.equal(scripts.trackedResources, 25, '同名脚本位于不同来源时不能错误合并');
  assert.equal(scripts.topResources.length, 20);
  assert.equal(scripts.rankingComplete, true);
  assert.equal(scripts.droppedTimingRecords, 0);
  const first = scripts.topResources[0];
  assert.equal(first.fileName, 'same.model.ts');
  assert.equal(first.totalMs, 73);
  assert.equal(first.phases.scriptConstructor.count, 1);
  assert.equal(first.phases.scriptOnStart.count, 2);
  assert.equal(first.phases.scriptOnStart.failedCount, 1);
  assert.equal(first.phases.scriptOnStart.totalMs, 49);
  assert.equal(snapshot.stages.scriptInitialize.totalMs, 9999);
  for (const secret of ['secret', 'private', 'example.test', 'another-instance']) {
    assert.equal(JSON.stringify(scripts).includes(secret), false);
  }
  first.phases.scriptOnStart.totalMs = 999;
  scripts.topResources.length = 0;
  assert.equal(diagnostics.snapshot().scriptInitialization.topResources[0].phases.scriptOnStart.totalMs, 49);
});

test('脚本资源聚合达到上限后显式报告不完整，已有资源仍可更新且全局计数不丢', () => {
  const diagnostics = new SceneLoadDiagnostics();
  const limit = diagnostics.snapshot().scriptInitialization.resourceLimit;
  for (let index = 0; index <= limit; index++) diagnostics.record('scriptConstructor', 1, false, `model-${index}.ts`);
  diagnostics.record('scriptOnStart', 10, false, 'model-0.ts');
  const snapshot = diagnostics.snapshot(), scripts = snapshot.scriptInitialization;
  assert.equal(scripts.trackedResources, limit);
  assert.equal(scripts.rankingComplete, false);
  assert.equal(scripts.droppedTimingRecords, 1);
  assert.equal(scripts.topResources[0].fileName, 'model-0.ts');
  assert.equal(scripts.topResources[0].totalMs, 11);
  assert.equal(snapshot.stages.scriptConstructor.count, limit + 1);
});
