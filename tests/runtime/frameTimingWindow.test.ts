import assert from 'node:assert/strict';
import test from 'node:test';
import { FrameTimingWindow } from '../../src/runtime/babylon/FrameTimingWindow.ts';

test('逐帧分位数保留长帧，不用秒级均值代替尾部', () => {
  const window = new FrameTimingWindow();
  let at = 0;
  window.record(at);
  for (const delta of [...Array(19).fill(16), 250]) window.record(at += delta);
  const report = window.createReport();
  assert.equal(report.intervalCount, 20);
  assert.equal(report.p50Ms, 16);
  assert.equal(report.p95Ms, 16);
  assert.equal(report.p99Ms, 250);
  assert.equal(report.over50MsCount, 1);
  assert.equal(report.over33MsCount, 1);
  assert.equal(report.measuredDurationMs, 554);
  assert.equal(report.effectiveFps, 20 * 1000 / 554);
});

test('时间窗口与容量均有界，容量截断单独披露且返回副本', () => {
  const window = new FrameTimingWindow({ maxIntervals: 3, historyWindowMs: 100 });
  for (const at of [0, 10, 30, 60, 100]) window.record(at);
  const report = window.createReport();
  assert.deepEqual(report.intervalsMs, [20, 30, 40]);
  assert.equal(report.capacityDroppedIntervals, 1);
  report.intervalsMs[0] = 999;
  assert.deepEqual(window.createReport().intervalsMs, [20, 30, 40]);
  window.record(210);
  assert.deepEqual(window.createReport().intervalsMs, [110]);
  assert.equal(window.createReport().p99Ms, 110);
});

test('暂停断开时间连续性而不制造后台长帧，重启会话清除旧样本', () => {
  const window = new FrameTimingWindow();
  window.record(0);
  window.record(16);
  window.breakContinuity();
  window.record(20_000);
  window.record(20_020);
  assert.deepEqual(window.createReport().intervalsMs, [16, 20]);
  window.reset();
  assert.equal(window.createReport().intervalCount, 0);
  assert.equal(window.createReport().effectiveFps, null);
  window.record(Number.NaN);
  window.record(1);
  window.record(11);
  assert.deepEqual(window.createReport().intervalsMs, [10]);
});

test('运行中复制报告按当前时间清理旧帧，停止后的无时间参数报告继续冻结', () => {
  const window = new FrameTimingWindow();
  window.record(0);
  window.record(16);
  window.breakContinuity();
  assert.equal(window.createReport().intervalCount, 1);
  assert.equal(window.createReport(70_000).intervalCount, 0);
});

test('墙钟窗计入尾部停顿，补齐后邻帧前不宣布尾延迟通过', () => {
  const window = new FrameTimingWindow();
  window.record(-10);
  window.beginWallClockWindow(0);
  window.record(10); window.record(20);
  window.endWallClockWindow(100);
  const incomplete = window.createWallClockReport()!;
  assert.equal(incomplete.completedFrames, 2);
  assert.equal(incomplete.wallClockDurationMs, 100);
  assert.equal(incomplete.effectiveFps, 20);
  assert.equal(incomplete.tailCensored, true);
  assert.equal(incomplete.trailingStallLowerBoundMs, 80);
  assert.equal(incomplete.measurementValid, false);
  assert.equal(incomplete.p99Ms, null);
  window.record(130);
  const completed = window.createWallClockReport()!;
  assert.equal(completed.measurementValid, true);
  assert.equal(completed.effectiveFps, 20);
  assert.equal(completed.completedFrames, 2, '窗外后邻帧不能增加墙钟窗帧数');
  assert.deepEqual(completed.frameTimestampsMs, [-10, 10, 20, 130]);
  assert.deepEqual(completed.intervalsMs, [20, 10, 110]);
  assert.equal(completed.p99Ms, 110, '跨窗长间隔保留完整长度');
  assert.equal(completed.frameBeforeStartMs, -10);
  assert.equal(completed.frameAtOrAfterEndMs, 130);
  assert.equal(window.createReport().effectiveFps, 3 * 1000 / 140, '旧completed interval口径保持兼容');
});

test('墙钟窗独立保存采样原始时间，不受旧滚动窗口prune影响', () => {
  const window = new FrameTimingWindow({ maxIntervals: 5, historyWindowMs: 20 });
  window.record(-10); window.beginWallClockWindow(0);
  window.record(10); window.record(30); window.endWallClockWindow(50); window.record(75);
  assert.deepEqual(window.createReport(75).intervalsMs, [45]);
  const report = window.createWallClockReport()!;
  assert.deepEqual(report.frameTimestampsMs, [-10, 10, 30, 75]);
  assert.deepEqual(report.intervalsMs, [20, 20, 45]);
  assert.equal(report.effectiveFps, 40);
  assert.equal(report.measurementValid, true);
  report.frameTimestampsMs[0] = -999;
  assert.equal(window.createWallClockReport()!.frameBeforeStartMs, -10);
});

test('墙钟窗无帧或缺前邻时显式失败，不制造0ms尾分位', () => {
  const empty = new FrameTimingWindow();
  empty.beginWallClockWindow(0); empty.endWallClockWindow(100);
  const report = empty.createWallClockReport()!;
  assert.equal(report.completedFrames, 0);
  assert.equal(report.effectiveFps, 0);
  assert.equal(report.trailingStallLowerBoundMs, 100);
  assert.equal(report.measurementValid, false);
  assert.equal(report.p50Ms, null);
  assert.ok(report.invalidReasons.includes('no-completed-frames'));
  const noHead = new FrameTimingWindow();
  noHead.beginWallClockWindow(0); noHead.record(10); noHead.endWallClockWindow(60); noHead.record(80);
  assert.equal(noHead.createWallClockReport()!.headCensored, true);
  assert.equal(noHead.createWallClockReport()!.measurementValid, false);
});

test('墙钟窗容量截断与连续性损坏不能用少量剩余帧伪造通过', () => {
  const limited = new FrameTimingWindow({ maxIntervals: 2 });
  limited.record(-10); limited.beginWallClockWindow(0);
  for (const at of [10, 20, 30, 40, 50]) limited.record(at);
  limited.endWallClockWindow(60); limited.record(70);
  const truncated = limited.createWallClockReport()!;
  assert.ok(truncated.capacityDroppedFrames > 0);
  assert.equal(truncated.measurementValid, false);
  assert.equal(truncated.effectiveFps, null);
  assert.equal(truncated.p95Ms, null);
  const hidden = new FrameTimingWindow();
  hidden.record(-10); hidden.beginWallClockWindow(0); hidden.record(10); hidden.breakContinuity();
  hidden.record(50); hidden.endWallClockWindow(60); hidden.record(70);
  assert.equal(hidden.createWallClockReport()!.continuityBreaks, 1);
  assert.equal(hidden.createWallClockReport()!.measurementValid, false);
  assert.deepEqual(hidden.createReport().intervalsMs, [20, 20], '原断流后的interval语义不变');
});

test('墙钟窗边界与冻结规则明确，原始记录不因重复读取改变', () => {
  const window = new FrameTimingWindow();
  assert.equal(window.createWallClockReport(), null);
  window.record(10);
  assert.throws(() => window.beginWallClockWindow(5), RangeError);
  assert.throws(() => window.beginWallClockWindow(Number.NaN), RangeError);
  window.beginWallClockWindow(10); window.record(20); window.endWallClockWindow(20);
  const report = window.createWallClockReport()!;
  assert.equal(report.completedFrames, 1, '窗口采用(start,end]，排除已有起点帧');
  assert.equal(report.measurementValid, true);
  assert.equal(report.effectiveFps, 100);
  window.endWallClockWindow(20);
  assert.throws(() => window.endWallClockWindow(21), RangeError);
  window.record(30);
  assert.deepEqual(window.createWallClockReport(), report, '闭窗已有完整边界后不再扩窗');
  window.reset();
  assert.equal(window.createWallClockReport(), null);
});

test('墙钟窗非法或倒退时间单独披露，不能修成正常连续帧', () => {
  const window = new FrameTimingWindow();
  window.record(-10); window.beginWallClockWindow(0); window.record(10);
  window.record(Number.NaN); window.record(20); window.record(19);
  window.endWallClockWindow(40); window.record(50);
  const report = window.createWallClockReport()!;
  assert.equal(report.invalidTimestampCount, 2);
  assert.equal(report.measurementValid, false);
  assert.equal(report.effectiveFps, null);
  assert.equal(report.p99Ms, null);
});
