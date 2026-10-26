import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeGpuTimerProbe } from '../../scripts/probe-gpu-timer.mjs';

const base = { webgl2: true, renderer: 'ANGLE test', extension: true, timestampBits: 0, frames: 10, samples: [], disjointDiscarded: 0, pendingAtEnd: 0, error: null };

test('没有 WebGL2 或没有扩展时判定不可用，且不输出 0 的时间统计', () => {
  const noContext = summarizeGpuTimerProbe({ ...base, webgl2: false, extension: false });
  assert.equal(noContext.usable, false);
  assert.match(noContext.verdict, /WebGL2/);
  const noExtension = summarizeGpuTimerProbe({ ...base, extension: false });
  assert.equal(noExtension.usable, false);
  assert.match(noExtension.verdict, /EXT_disjoint_timer_query_webgl2/);
  for (const summary of [noContext, noExtension]) {
    assert.equal(summary.p50Ms, null);
    assert.equal(summary.maxMs, null);
  }
});

test('扩展存在但样本全部被 disjoint 丢弃时保持不可用并保留丢弃计数', () => {
  const summary = summarizeGpuTimerProbe({ ...base, disjointDiscarded: 7 });
  assert.equal(summary.usable, false);
  assert.equal(summary.disjointDiscarded, 7);
  assert.equal(summary.sampleCount, 0);
  assert.equal(summary.minMs, null);
});

test('有效样本按 nearest-rank 计算分位数，不修改输入顺序', () => {
  const samples = [5, 1, 4, 2, 3, 10, 9, 8, 7, 6];
  const summary = summarizeGpuTimerProbe({ ...base, samples });
  assert.equal(summary.usable, true);
  assert.equal(summary.sampleCount, 10);
  assert.equal(summary.minMs, 1);
  assert.equal(summary.p50Ms, 5);
  assert.equal(summary.p95Ms, 10);
  assert.equal(summary.maxMs, 10);
  assert.deepEqual(samples, [5, 1, 4, 2, 3, 10, 9, 8, 7, 6]);
});
