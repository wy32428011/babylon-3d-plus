import assert from 'node:assert/strict';
import test from 'node:test';
import { Matrix, MeshBuilder, NullEngine, Scene } from '@babylonjs/core';
import { copyMatrixRows, getMatrixUploadMetrics, uploadMatrixRanges } from '../../src/runtime/babylon/thinInstanceSparseUpdates.ts';

function matrices(count: number): Float32Array {
  const result = new Float32Array(count * 16);
  for (let i = 0; i < count; i++) Matrix.Translation(i, 0, 0).copyToArray(result, i * 16);
  return result;
}

test('稳定布局只收集变化行、合并相邻行，保持源与目标逐字节相同', () => {
  const before = matrices(128), next = before.slice();
  next[16 * 3 + 12] += 2; next[16 * 4 + 12] += 2; next[16 * 90 + 13] += 1;
  assert.deepEqual(copyMatrixRows(before, next, 128, true), [{ start: 3, count: 2 }, { start: 90, count: 1 }]);
  assert.deepEqual(before, next);
  assert.deepEqual(copyMatrixRows(before, next, 128, true), []);
});

test('零值符号变化仍上传；大范围变化、小缓冲和显式关闭沿用全量', () => {
  const before = matrices(128), next = before.slice(); next[1] = -0;
  assert.deepEqual(copyMatrixRows(before, next, 128, true), [{ start: 0, count: 1 }]);
  for (let i = 0; i < 40; i++) next[i * 16 + 12] += 10;
  assert.equal(copyMatrixRows(before, next, 128, true), undefined);
  assert.deepEqual(before, next);
  assert.equal(copyMatrixRows(matrices(4), matrices(4), 4, true), undefined);
  assert.equal(copyMatrixRows(before, next, 128, false), undefined);
});

test('可见前缀从完整源索引复制；范围过碎时回到全量', () => {
  const source = matrices(256), indexes = Uint32Array.from({ length: 128 }, (_, i) => i * 2);
  const visible = new Float32Array(128 * 16);
  copyMatrixRows(visible, source, 128, false, indexes);
  source[200 * 16 + 12] = 999;
  assert.deepEqual(copyMatrixRows(visible, source, 128, true, indexes), [{ start: 100, count: 1 }]);
  assert.equal(visible[100 * 16 + 12], 999);
  for (let i = 0; i < 9; i++) source[4 * i * 16 + 13] = 4;
  assert.equal(copyMatrixRows(visible, source, 128, true, indexes), undefined);
});

test('真实 SDK 数字重载使用实例单位，缓存失效且恢复监听仅归本 Mesh', () => {
  const engine = new NullEngine(), scene = new Scene(engine);
  const mesh = MeshBuilder.CreateBox('carrier', {}, scene);
  const data = matrices(128);
  mesh.thinInstanceSetBuffer('matrix', data, 16, false);
  const previous = mesh.thinInstanceGetWorldMatrices();
  assert.equal(previous[7].m[12], 7);
  const buffer = mesh._thinInstanceDataStorage.matrixBuffer!;
  const calls: Array<{ offset: number; data: number[] }> = [];
  buffer.updateDirectly = (values, offset) => { calls.push({ offset, data: Array.from(values as Float32Array) }); };
  const observers = engine.onContextRestoredObservable.observers.length;
  data[7 * 16 + 12] = 777;
  uploadMatrixRanges(mesh, [{ start: 7, count: 1 }], 128);
  assert.equal(calls[0].offset, 7 * 16);
  assert.equal(calls[0].data.length, 16);
  assert.equal(calls[0].data[12], 777);
  assert.equal(mesh.thinInstanceGetWorldMatrices()[7].m[12], 777);
  assert.equal(engine.onContextRestoredObservable.observers.length, observers + 1);
  uploadMatrixRanges(mesh, [], 128);
  assert.equal(calls.length, 1);
  engine.onContextRestoredObservable.notifyObservers(engine);
  assert.equal(calls[1].data.length, 128 * 16);
  assert.equal(calls[1].data[7 * 16 + 12], 777);
  assert.equal(getMatrixUploadMetrics(scene).uploadedBytes, 64);
  assert.equal(getMatrixUploadMetrics(scene).contextRestores, 1);
  mesh.dispose();
  assert.ok(engine.onContextRestoredObservable.observers.filter(item => !item._willBeUnregistered).length <= observers);
  scene.dispose(); engine.dispose();
});

test('上传前拒绝重叠和越界区间，不执行一部分上传', () => {
  const engine = new NullEngine(), scene = new Scene(engine), mesh = MeshBuilder.CreateBox('carrier', {}, scene);
  mesh.thinInstanceSetBuffer('matrix', matrices(128), 16, false);
  let calls = 0; mesh.thinInstancePartialBufferUpdate = () => { calls++; };
  assert.throws(() => uploadMatrixRanges(mesh, [{ start: 3, count: 2 }, { start: 4, count: 1 }], 128), /范围/);
  assert.equal(calls, 0);
  assert.throws(() => uploadMatrixRanges(mesh, [{ start: 128, count: 1 }], 128), /范围/);
  scene.dispose(); engine.dispose();
});
