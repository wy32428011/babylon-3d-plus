import assert from 'node:assert/strict';
import test from 'node:test';
import { isSupportedSceneFilePath } from '../../electron/ipc/sceneFilePath.ts';

test('最近场景兼容文件选择器已记录的普通 JSON 场景文件', () => {
  assert.equal(isSupportedSceneFilePath(String.raw`E:\公司文件\数字孪生\场景\工厂-local.json`), true);
  assert.equal(isSupportedSceneFilePath(String.raw`D:\project\Scenes\main.scene.json`), true);
  assert.equal(isSupportedSceneFilePath(String.raw`D:\project\Scenes\MAIN.JSON`), true);
});

test('最近场景拒绝非 JSON 文件和伪装后缀', () => {
  assert.equal(isSupportedSceneFilePath(String.raw`D:\project\Scenes\main.json.bak`), false);
  assert.equal(isSupportedSceneFilePath(String.raw`D:\project\Scenes\main.txt`), false);
});
