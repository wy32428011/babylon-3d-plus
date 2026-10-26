import assert from 'node:assert/strict';
import test from 'node:test';
import { environmentGiBudgetErrors } from '../helpers/phase2GiBudget.mjs';

const limits = { maxObservedRendererHeapBytes: 20, maxCyclesPeakRssBytes: 40, maxWorkingDiskBytes: 10, maxTextureMiB: 1 };
test('GI资源预算逐项保留未知/越界，不用零内存或局部成功补成全通过', () => {
  assert.deepEqual(environmentGiBudgetErrors({ rendererHeapMaxObservedBytes: 10, cyclesPeakRssBytes: 30, workingDiskMaxObservedBytes: 5, atlasBytes: 100 }, limits, true), []);
  const unknown = environmentGiBudgetErrors({ rendererHeapMaxObservedBytes: null, cyclesPeakRssBytes: 0, workingDiskMaxObservedBytes: 5 }, limits, true);
  assert.equal(unknown.length, 2); assert.ok(unknown.every(error => error.includes('unavailable')));
  const over = environmentGiBudgetErrors({ rendererHeapMaxObservedBytes: 21, cyclesPeakRssBytes: 41, workingDiskMaxObservedBytes: 11, atlasBytes: 1048577 }, limits);
  assert.equal(over.length, 4); assert.ok(over.every(error => error.includes('exceeds')));
});
