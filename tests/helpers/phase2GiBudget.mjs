/* global window */
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const known = value => Number.isFinite(value) && value > 0;
const maximum = (previous, values) => { const valid = values.filter(known); return valid.length ? Math.max(previous ?? 0, ...valid) : previous; };

export function environmentGiBudgetErrors(observed, limits, complete = false) {
  const result = [];
  for (const [field, limit] of [['rendererHeapMaxObservedBytes', limits.maxObservedRendererHeapBytes],
    ['cyclesPeakRssBytes', limits.maxCyclesPeakRssBytes], ['workingDiskMaxObservedBytes', limits.maxWorkingDiskBytes]]) {
    if (known(observed[field]) && observed[field] > limit) result.push(field + ' exceeds frozen limit');
    if (complete && !known(observed[field])) result.push(field + ' unavailable, cannot substitute zero');
  }
  if (observed.atlasBytes !== undefined && observed.atlasBytes > limits.maxTextureMiB * 1024 ** 2) result.push('atlasBytes exceeds frozen limit');
  return result;
}

async function workingBytes(root) {
  const pending = [root]; let bytes = 0;
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    assert.equal(entry.isSymbolicLink(), false, '预算计量不跟随任务目录中的链接');
    if (entry.isDirectory()) pending.push(file);
    else if (entry.isFile()) {
      try { bytes += (await fs.stat(file)).size; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    }
  }
  return bytes;
}

/** 定时观察只属于本次输出根/Editor/任务的内存，超限通过正式取消入口停止，不杀未知PID。 */
export function createEnvironmentGiBudgetMonitor({ output, limits, page, jobIds, onViolation }) {
  const observed = { rendererHeapMaxObservedBytes: null, cyclesPeakRssBytes: null, workingDiskMaxObservedBytes: null,
    basis: { renderer: 'performance.memory plus production captureMetrics, maximum observed', cycles: 'production task phaseMetrics Windows OS PeakWorkingSet',
      disk: 'sampled sum of logical file sizes under owned output; excludes shared Vite cache and browser temporary profile; not exact continuous disk peak' },
    samples: [], monitorErrors: [] };
  let timer, pending, violated = false;
  const sample = async () => {
    const disk = await workingBytes(output);
    observed.workingDiskMaxObservedBytes = maximum(observed.workingDiskMaxObservedBytes, [disk]);
    const current = page();
    if (current && !current.isClosed()) {
      const value = await current.evaluate(async () => ({
        capture: window.phase2Gi?.captureHeapMaxObservedBytes ?? null,
        current: performance.memory?.usedJSHeapSize ?? null,
        history: await window.editorApi.getLightingBakeHistory(),
      }));
      const ids = new Set(jobIds()), tasks = value.history.tasks.filter(task => ids.has(task.jobId));
      observed.rendererHeapMaxObservedBytes = maximum(observed.rendererHeapMaxObservedBytes,
        [value.capture, value.current, ...tasks.map(task => task.captureMetrics?.rendererHeapMaxObservedBytes)]);
      observed.cyclesPeakRssBytes = maximum(observed.cyclesPeakRssBytes,
        tasks.flatMap(task => (task.phaseMetrics ?? []).map(phase => phase.cyclesPeakRssBytes)));
    }
    observed.samples.push({ at: new Date().toISOString(), rendererHeap: observed.rendererHeapMaxObservedBytes, cyclesPeakRss: observed.cyclesPeakRssBytes, ownedDisk: disk });
    const errors = environmentGiBudgetErrors(observed, limits);
    if (errors.length && !violated) { violated = true; observed.violation = errors; await onViolation(errors); }
  };
  const safeSample = async () => { try { await sample(); } catch (error) { observed.monitorErrors.push(String(error)); } };
  return { observed,
    async start() { await safeSample(); timer = setInterval(() => { if (!pending) { pending = safeSample().finally(() => { pending = null; }); } }, 2000); },
    async markAtlas(bytes) { observed.atlasBytes = bytes; await safeSample(); },
    async stop() { clearInterval(timer); if (pending) await pending; await safeSample(); },
    assertComplete() { const errors = environmentGiBudgetErrors(observed, limits, true); assert.deepEqual(errors, [], '实际资源观察未满足冻结预算'); assert.deepEqual(observed.monitorErrors, [], '资源计量失败不得冒充通过'); },
  };
}
