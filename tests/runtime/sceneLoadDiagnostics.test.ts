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
