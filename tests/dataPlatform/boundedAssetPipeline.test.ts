import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { runBoundedAssetPipeline } from '../../electron/shared/boundedAssetPipeline.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test('按包依赖校验与其他包下载重叠，并限制待校验活动包数量', async () => {
  const events: string[] = [];
  const transferA2 = deferred(), transferB = deferred(), validatingA = deferred();
  const aStarted = deferred(), bStarted = deferred();
  const pending = runBoundedAssetPipeline({
    assets: ['a', 'b', 'c'],
    dependencies: asset => asset === 'a' ? ['a1', 'a2'] : [asset],
    transferConcurrency: 2, validationConcurrency: 1, maxActiveAssets: 2,
    assertActive() {},
    async transfer(dependency) {
      events.push('transfer:' + dependency);
      if (dependency === 'a2') await transferA2.promise;
      if (dependency === 'b') { bStarted.resolve(); await transferB.promise; }
      events.push('downloaded:' + dependency);
    },
    async validate(asset) {
      events.push('validate:' + asset);
      if (asset === 'a') { aStarted.resolve(); await validatingA.promise; }
      return asset.toUpperCase();
    },
  });
  try {
    await bStarted.promise;
    assert.ok(!events.includes('validate:a'), '任一依赖未完成时不能校验包');
    transferA2.resolve();
    await aStarted.promise;
    assert.ok(!events.includes('downloaded:b'), 'a 的校验必须先于 b 的完整下载');
    assert.ok(!events.includes('transfer:c'), '两个活动包占满后不能继续积压第三包');
    validatingA.resolve();
    transferB.resolve();
    assert.deepEqual(await pending, ['A', 'B', 'C'], '输出顺序必须与输入一致');
  } finally {
    transferA2.resolve(); transferB.resolve(); validatingA.resolve();
    await pending;
  }
});

test('传输、校验和活动包分别有界且单包多文件仍可并发', async () => {
  let transfers = 0, validations = 0, peakTransfers = 0, peakValidations = 0, peakAssets = 0;
  const active = new Set<number>();
  const results = await runBoundedAssetPipeline({
    assets: Array.from({ length: 12 }, (_, index) => index),
    dependencies: asset => Array.from({ length: 3 }, (_, file) => ({ asset, file })),
    transferConcurrency: 4, validationConcurrency: 2, maxActiveAssets: 4,
    assertActive() {},
    async transfer({ asset }) {
      active.add(asset); peakAssets = Math.max(peakAssets, active.size);
      peakTransfers = Math.max(peakTransfers, ++transfers);
      await delay(2); transfers -= 1;
    },
    async validate(asset) {
      peakValidations = Math.max(peakValidations, ++validations);
      await delay(8); validations -= 1; active.delete(asset); return asset;
    },
  });
  assert.deepEqual(results, Array.from({ length: 12 }, (_, index) => index));
  assert.equal(peakTransfers, 4);
  assert.equal(peakValidations, 2);
  assert.ok(peakAssets <= 4);
});

for (const stage of ['transfer', 'validate'] as const) {
  test(`${stage} 失败停止派发并排空其他在途写盘后才拒绝`, async () => {
    const blocked = deferred(), otherStarted = deferred(), failed = deferred();
    const events: string[] = [];
    const pending = runBoundedAssetPipeline({
      assets: ['bad', 'other', 'later'], dependencies: asset => [asset],
      transferConcurrency: 2, validationConcurrency: 2, maxActiveAssets: 2,
      assertActive() {},
      async transfer(asset) {
        events.push('transfer:' + asset);
        if (asset === 'other') { otherStarted.resolve(); await blocked.promise; events.push('drained'); }
        if (asset === 'bad' && stage === 'transfer') { await otherStarted.promise; failed.resolve(); throw new Error('传输失败'); }
      },
      async validate(asset) {
        events.push('validate:' + asset);
        if (asset === 'bad') { failed.resolve(); throw new Error('校验失败'); }
        return asset;
      },
    });
    let settled = false;
    const outcome = pending.then(() => null, error => error).finally(() => { settled = true; });
    try {
      await failed.promise; await delay(5);
      assert.equal(settled, false);
      assert.ok(!events.includes('transfer:later'));
      blocked.resolve();
      assert.match(String(await outcome), /失败/);
      assert.ok(events.includes('drained'));
      assert.ok(!events.includes('validate:other'));
    } finally { blocked.resolve(); await outcome; }
  });
}

test('取消后等待当前下载释放，拒绝校验和派发迟到包', async () => {
  const controller = new AbortController(), blocked = deferred(), started = deferred();
  const events: string[] = [];
  const pending = runBoundedAssetPipeline({
    assets: ['a', 'b'], dependencies: asset => [asset],
    transferConcurrency: 1, validationConcurrency: 1, maxActiveAssets: 1,
    assertActive() { if (controller.signal.aborted) throw new Error('同步已取消'); },
    async transfer(asset) { events.push(asset); started.resolve(); await blocked.promise; },
    async validate(asset) { events.push('validate'); return asset; },
  });
  const outcome = pending.then(() => null, error => error);
  await started.promise; controller.abort(); blocked.resolve();
  assert.match(String(await outcome), /取消/);
  assert.deepEqual(events, ['a']);
});

test('空集合与无文件依赖保持完整结果，非法并发上限被拒绝', async () => {
  const options = { dependencies: () => [], transfer: async () => {}, validate: async (value: number) => value,
    transferConcurrency: 1, validationConcurrency: 1, maxActiveAssets: 1, assertActive() {} };
  assert.deepEqual(await runBoundedAssetPipeline({ ...options, assets: [] }), []);
  assert.deepEqual(await runBoundedAssetPipeline({ ...options, assets: [1, 2] }), [1, 2]);
  await assert.rejects(runBoundedAssetPipeline({ ...options, assets: [1], transferConcurrency: 0 }), /正整数/);
});
