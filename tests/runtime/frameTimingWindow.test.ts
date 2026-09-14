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
