import assert from 'node:assert/strict';
import test from 'node:test';
import { getClickEventModelResourceKey } from '../../electron/shared/clickEventModelIdentity.ts';

const url = (path: string): string => `editor-asset://local/${encodeURIComponent(path)}`;

test('点击模型身份保留资源类别、资源 ID 和包内文件路径，忽略目录位置与快照后缀', () => {
  for (const path of [
    'D:\\shared\\Model-123-设备\\parts\\主模型.glb',
    'E:/project/Model-123-重命名__zsrc-abcdef/parts/主模型.glb',
    'project/assets/models/Model-123-设备-0123456789/parts/主模型.glb',
  ]) assert.equal(getClickEventModelResourceKey(url(path)), 'model:123:parts/主模型.glb');
  assert.equal(getClickEventModelResourceKey(url('D:/Combo-123-设备/parts/主模型.glb')), 'combo:123:parts/主模型.glb');
  assert.equal(getClickEventModelResourceKey(`${url('D:/Model-123-设备/parts/主模型.glb')}?assetRevision=new#mesh`), 'model:123:parts/主模型.glb');
});

test('普通本地模型、外部 URL、坏编码和非模型路径没有中台模型身份', () => {
  for (const value of [
    null, '', 'https://example.com/Model-123-设备/model.glb', 'file:///D:/Model-123-设备/model.glb',
    'editor-asset://local/%ZZ/Model-123-设备/model.glb',
    url('D:/Model-123-设备/../model.glb'), url('D:/Model-123-设备/./model.glb'),
    url('D:/LocalPackage/model.glb'), url('D:/Model-0-设备/model.glb'),
    url('D:/Model-123-设备/model.ts'), url('D:/Env-123-设备/model.glb'),
  ]) assert.equal(getClickEventModelResourceKey(value), null, String(value));
});
