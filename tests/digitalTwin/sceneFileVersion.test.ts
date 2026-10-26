import assert from 'node:assert/strict';
import test from 'node:test';
import { CURRENT_SCENE_FILE_VERSION, isSupportedSceneFileVersion } from '../../electron/shared/sceneFileVersion.ts';

test('场景格式统一接受历史版本 1–6 与当前版本 7', () => {
  assert.equal(CURRENT_SCENE_FILE_VERSION, 7);
  for (const version of [1, 2, 3, 4, 5, 6, 7]) assert.equal(isSupportedSceneFileVersion(version), true);
});

test('未知、非整数或非数字版本不能冒充当前场景格式', () => {
  for (const version of [0, -1, 8, 100, 1.5, NaN, Infinity, '7', '', true, null, undefined, {}, []]) {
    assert.equal(isSupportedSceneFileVersion(version), false, String(version));
  }
});
