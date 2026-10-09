import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { NullEngine, Scene } from '@babylonjs/core';
import { withNewMaterialDirtyGuard } from '../../src/runtime/babylon/withNewMaterialDirtyGuard.ts';

test('Babylon 9.12.0 dirty 开关版本契约与嵌套失败恢复', () => {
  const version = JSON.parse(readFileSync(new URL('../../node_modules/@babylonjs/core/package.json', import.meta.url), 'utf8')).version;
  assert.equal(version, '9.12.0', 'Babylon 升级时必须重新验证内部开关契约');
  const engine = new NullEngine(), scene = new Scene(engine);
  let flushes = 0;
  scene.markAllMaterialsAsDirty = () => { flushes++; };
  try {
    assert.equal(typeof scene._forceBlockMaterialDirtyMechanism, 'function');
    for (const original of [false, true]) {
      scene._forceBlockMaterialDirtyMechanism(original);
      assert.throws(() => withNewMaterialDirtyGuard(scene, () => {
        assert.equal(scene.blockMaterialDirtyMechanism, true);
        withNewMaterialDirtyGuard(scene, () => assert.equal(scene.blockMaterialDirtyMechanism, true));
        assert.equal(scene.blockMaterialDirtyMechanism, true);
        throw new Error('clone failed');
      }), /clone failed/);
      assert.equal(scene.blockMaterialDirtyMechanism, original);
    }
    assert.equal(flushes, 0, '恢复开关不能刷新全场景材质');
  } finally { scene.dispose(); engine.dispose(); }
});
