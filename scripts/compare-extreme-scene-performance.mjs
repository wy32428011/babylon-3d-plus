import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const [beforePath, afterPath, outputPath] = process.argv.slice(2);
assert.ok(beforePath && afterPath && outputPath,
  '用法：node scripts/compare-extreme-scene-performance.mjs <原版 result.json> <优化版 result.json> <对比.json>');
const [before, after] = await Promise.all([beforePath, afterPath].map(async file => JSON.parse(await readFile(file, 'utf8'))));
for (const report of [before, after]) {
  assert.equal(report.passed, true, '失败或未完成的报告不能计入配对结果');
  assert.equal(report.sourceUnchanged, true);
  assert.equal(report.lifecycleSoak, false, '生命周期浸泡不能当作稳定帧率');
  assert.ok(report.seconds >= 60 && report.repeats >= 3);
  assert.equal(report.runs.length, report.modes.length * report.repeats);
}
for (const key of ['sourceSha256', 'inventorySha256', 'replaySha256', 'seconds', 'repeats',
  'profileEnabled', 'fullscreen4k', 'telemetryTimingEnabled']) {
  assert.deepEqual(before[key], after[key], `配对条件不一致：${key}`);
}
assert.deepEqual(before.modes, after.modes);
assert.deepEqual(before.initial.renderer, after.initial.renderer);
for (const key of ['width', 'height', 'dpr', 'camera']) assert.deepEqual(before.initial[key], after.initial[key], `初始视图不一致：${key}`);
const median = values => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const rows = before.modes.map(mode => {
  const groups = [before, after].map(report => report.runs.filter(run => run.mode === mode));
  for (let index = 0; index < groups[0].length; index += 1) {
    const a = groups[0][index], b = groups[1][index];
    assert.equal(a.repeat, b.repeat);
    for (const run of [a, b]) {
      assert.ok(run.measuredDurationMs >= 55_000, '实际连续帧不足 55 秒');
      assert.ok(run.samples.length > 0);
      for (const sample of run.samples) {
        for (const key of ['width', 'height', 'dpr']) assert.equal(sample[key], before.initial[key], `采样条件变化：${mode}/${key}`);
      }
    }
  }
  const stats = groups.map(runs => ({
    fps: median(runs.map(run => run.effectiveFps)),
    p95Ms: median(runs.map(run => run.p95Ms)),
    p99Ms: median(runs.map(run => run.p99Ms)),
    cpuFrameMs: median(runs.flatMap(run => run.samples.map(sample => sample.cpuFrameMs).filter(Number.isFinite))),
    gpuFrameMs: median(runs.flatMap(run => run.samples.map(sample => sample.gpuFrameMs).filter(Number.isFinite))),
    runs: runs.map(run => ({ repeat: run.repeat, fps: run.effectiveFps, p95Ms: run.p95Ms,
      intervalCount: run.intervalCount, measuredDurationMs: run.measuredDurationMs })),
  }));
  return { mode, before: stats[0], after: stats[1], fpsChangePercent: (stats[1].fps / stats[0].fps - 1) * 100,
    p95ReductionPercent: (1 - stats[1].p95Ms / stats[0].p95Ms) * 100 };
});
const comparison = { conditionsMatched: true, conditionScope: 'recorded-inputs-and-view-settings',
  unmeasuredConditions: ['concurrent-system-load', 'power-and-thermal-state'],
  before: path.resolve(beforePath), after: path.resolve(afterPath),
  renderer: before.initial.renderer, width: before.initial.width, height: before.initial.height, dpr: before.initial.dpr,
  sourceSha256: before.sourceSha256, inventorySha256: before.inventorySha256, replaySha256: before.replaySha256,
  semantics: 'FPS 为三轮有效 FPS 中位数；P95/P99 为三轮逐帧分位数的中位数，不能当作合并总体分位数。CPU/GPU 来自 1 Hz 计数器，空数据保持 null。',
  rows };
await writeFile(outputPath, JSON.stringify(comparison, null, 2));
console.log(JSON.stringify({ conditionsMatched: true, rows: rows.map(({ mode, before, after, fpsChangePercent }) => (
  { mode, beforeFps: before.fps, afterFps: after.fps, fpsChangePercent, beforeP95: before.p95Ms, afterP95: after.p95Ms }
)) }, null, 2));
