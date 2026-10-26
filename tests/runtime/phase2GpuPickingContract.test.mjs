import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GPUPicker } from '@babylonjs/core/Collisions/gpuPicker.js';

test('R5契约评估：GPU拾取是异步API，空列表也返回Promise而非同步命中', async () => {
  const picker = new GPUPicker();
  const result = picker.pickAsync(0, 0);
  assert.ok(result instanceof Promise);
  assert.equal(await result, null);
  picker.dispose();
});

test('R5兼容性反例：本地9.12单坐标multiPickAsync丢弃合法thinInstanceIndex=0', async () => {
  const mesh = { name: 'mock-result-mesh' };
  const picker = new GPUPicker();
  // 只隔离GPU readback，运行真实公开multiPickAsync分支；这不证明GPU渲染/拾取已验收。
  picker._pickableMeshes = [mesh];
  picker.pickAsync = async () => ({ mesh, thinInstanceIndex: 0 });
  const zero = await picker.multiPickAsync([{ x: 10, y: 20 }]);
  assert.equal(zero.meshes[0], mesh);
  assert.equal(zero.thinInstanceIndexes, undefined, '记录当前SDK的兼容性缺口，不把它当业务正确结果');
  picker.pickAsync = async () => ({ mesh, thinInstanceIndex: 1 });
  const one = await picker.multiPickAsync([{ x: 10, y: 20 }]);
  assert.deepEqual(one.thinInstanceIndexes, [1]);
  picker._pickableMeshes = [];
  picker.dispose();
});
