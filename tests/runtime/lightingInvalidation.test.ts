import assert from 'node:assert/strict';
import test from 'node:test';
import { LightingInvalidationDiagnostics } from '../../src/runtime/babylon/lightingInvalidation.ts';

test('诊断默认关闭且关闭态不读取时钟，开关不影响原计数历史', () => {
  let reads = 0;
  const value = new LightingInvalidationDiagnostics(() => ++reads);
  assert.equal(value.beginCollection(), null); value.mark('pose', 'move'); value.endCollection('frame', null);
  assert.equal(reads, 0); assert.equal(value.snapshot().marks.total, 0);
  value.setEnabled(true); value.mark('pose', 'move'); const start = value.beginCollection(); value.endCollection('frame', start);
  assert.equal(reads, 2); assert.equal(value.snapshot().collections.count, 1);
  value.setEnabled(false); value.mark('unknown', 'late'); assert.equal(value.beginCollection(), null);
  assert.equal(reads, 2); assert.equal(value.snapshot().marks.total, 1);
});

test('原因、入口、跳过、降级及重入分别累计，快照不共享内部对象', () => {
  let now = 10;
  const value = new LightingInvalidationDiagnostics(() => now); value.setEnabled(true);
  value.mark('unknown', '__proto__'); value.mark('classification', 'script'); value.mark('pose', 'move');
  const start = value.beginCollection(); now = 16; value.endCollection('query', start);
  value.bindingRefresh('frame', true); value.skip('cleanClassification'); value.reentrant('bindings');
  const result = value.snapshot();
  assert.equal(result.collections.totalMs, 6); assert.equal(result.collections.maxMs, 6);
  assert.equal(result.collections.byEntry.query, 1); assert.equal(result.bindings.forcedRebuilds, 1);
  assert.equal(result.skipped.pose, 1); assert.equal(result.fallbacks.unknown, 1); assert.equal(result.reentrant.bindings, 1);
  assert.equal(Object.getPrototypeOf(result.marks.byReason), Object.prototype); assert.equal(result.marks.byReason.__proto__, 1);
  Reflect.set(result.marks.byReason, 'script', 999); Reflect.set(result.collections.byEntry, 'query', 999);
  assert.equal(value.snapshot().marks.byReason.script, 1); assert.equal(value.snapshot().collections.byEntry.query, 1);
});

test('原因目录有界，重置保留启用状态且清空全部计数和计时', () => {
  const value = new LightingInvalidationDiagnostics(); value.setEnabled(true);
  for (let i = 0; i < 80; i++) value.mark('bindings', 'reason-' + i);
  assert.equal(Object.keys(value.snapshot().marks.byReason).length, 64);
  assert.equal(value.snapshot().marks.overflowReasons, 16);
  value.reset(); assert.equal(value.snapshot().enabled, true); assert.equal(value.snapshot().marks.total, 0);
  value.mark('structure', 'new'); assert.equal(value.snapshot().marks.byKind.structure, 1);
});

test('生产端跳过或降级决策只计数，不混入变更marks且快照无共享', () => {
  const value = new LightingInvalidationDiagnostics(); value.setEnabled(true);
  value.decision('same-input', true); value.decision('unknown-script', false);
  const first = value.snapshot(); assert.equal(first.marks.total, 0);
  assert.equal(first.decisions.skipped, 1); assert.equal(first.decisions.fallbacks, 1);
  Reflect.set(first.decisions.byReason['same-input'], 'skipped', 99);
  assert.equal(value.snapshot().decisions.byReason['same-input'].skipped, 1);
  value.reset(); assert.equal(value.snapshot().decisions.skipped, 0);
});

test('受控mesh请求单独记录合并标记数，不虚报减少collect且重置和快照隔离', () => {
  const value = new LightingInvalidationDiagnostics();
  value.meshLifecycle('disabled', true); assert.equal(value.snapshot().meshLifecycle.requests, 0);
  value.setEnabled(true); value.meshLifecycle('scene-mesh-added', false); value.meshLifecycle('scene-mesh-added', true);
  const result = value.snapshot();
  assert.deepEqual(result.meshLifecycle, { requests: 2, coalescedMarks: 1, fullRequests: 1 });
  assert.equal(result.marks.total, 0); assert.equal(result.collections.count, 0);
  assert.deepEqual(result.decisions.byReason['scene-mesh-added'], { skipped: 1, fallbacks: 1 });
  Reflect.set(result.meshLifecycle, 'requests', 99); assert.equal(value.snapshot().meshLifecycle.requests, 2);
  value.reset(); assert.deepEqual(value.snapshot().meshLifecycle, { requests: 0, coalescedMarks: 0, fullRequests: 0 });
});

