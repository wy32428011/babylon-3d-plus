import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const compare = promisify(execFile);
const script = fileURLToPath(new URL('../../scripts/compare-extreme-scene-performance.mjs', import.meta.url));
const view = { width: 1440, height: 800, dpr: 1 };

function makeReport(samples) {
  return {
    passed: true,
    sourceUnchanged: true,
    lifecycleSoak: false,
    sourceSha256: 'source',
    inventorySha256: 'inventory',
    replaySha256: 'replay',
    seconds: 60,
    repeats: 3,
    profileEnabled: false,
    fullscreen4k: false,
    telemetryTimingEnabled: true,
    modes: ['motion'],
    initial: { ...view, camera: { alpha: 1 }, renderer: { renderer: 'fixture' } },
    runs: [1, 2, 3].map((repeat) => ({
      repeat,
      mode: 'motion',
      effectiveFps: repeat * 5,
      p95Ms: 90,
      p99Ms: 120,
      intervalCount: 500,
      measuredDurationMs: 59_000,
      samples: samples.map((sample) => ({ ...view, ...sample })),
    })),
  };
}

async function compareReports(t, before, after) {
  const directory = await mkdtemp(path.join(tmpdir(), 'zending-compare-performance-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const [first, second, result] = ['before.json', 'after.json', 'comparison.json'].map((name) =>
    path.join(directory, name),
  );
  await writeFile(first, JSON.stringify(before));
  await writeFile(second, JSON.stringify(after));
  await compare(process.execPath, [script, first, second, result]);
  return JSON.parse(await readFile(result, 'utf8'));
}

test('等画质比较兼容旧报告，CPU 的有效零和缺测均保留原语义', async (t) => {
  const before = makeReport([
    { cpuFrameMs: 0, gpuFrameMs: null },
    { cpuFrameMs: 3, gpuFrameMs: 20 },
    { cpuFrameMs: null, gpuFrameMs: 80 },
  ]);
  const after = makeReport([{ cpuFrameMs: null, gpuFrameMs: null }]);
  const { rows, conditionsMatched } = await compareReports(t, before, after);
  assert.equal(conditionsMatched, true);
  assert.equal(rows[0].before.fps, 10);
  assert.equal(rows[0].before.cpuFrameMs, 1.5);
  assert.equal(rows[0].before.gpuFrameMs, 50);
  assert.equal(rows[0].after.cpuFrameMs, null);
  assert.equal(rows[0].after.gpuFrameMs, null);
});

test('带 GPU 计数的比较每轮只统计新增有效查询，不重复读取或使用不可用样本', async (t) => {
  const sample = (gpuTimingStatus, gpuFrameSamples, gpuFrameMs) => ({
    gpuTimingStatus,
    gpuFrameSamples,
    gpuFrameMs,
  });
  const before = makeReport([
    sample('valid', 5, 9_999), // 第一条仅建立本轮计数基线。
    sample('valid', 6, 20),
    sample('valid', 6, 9_999),
    sample('disjoint', 7, 9_999),
    sample('valid', 7, 9_999),
    sample('valid', 8, 40),
    sample('valid', 1, 9_999), // 计数回退开启新代；这一条不当作新增查询。
    sample('valid', 2, 30),
    sample('valid', 3, 0), // 原生查询明确返回零仍是测量值，而非缺测。
  ]);
  const after = makeReport([
    sample('disabled', 0, null),
    sample('unsupported', 0, null),
    sample('pending', 0, null),
    sample('unavailable', 0, null),
    sample('valid', null, 10),
  ]);
  const { rows } = await compareReports(t, before, after);
  assert.equal(rows[0].before.gpuFrameMs, 25);
  assert.equal(rows[0].after.gpuFrameMs, null);
});

test('等画质入口拒绝硬件缩放诊断，即使报告其他字段都能配对', async (t) => {
  const before = makeReport([{}]);
  const after = { ...before, experiment: 'hardware-scaling-baab', equalImageQuality: false };
  await assert.rejects(compareReports(t, before, after), /不能用于等画质性能比较/);
});
