import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import {
  getClickEventModelResourceKey,
  getLocalModelPathSha256,
  getPortableLocalModelPathSha256,
  matchesClickEventModelIdentity,
  normalizeCompositionOriginModelIdentity,
  sha256Utf8Hex,
} from '../../electron/shared/clickEventModelIdentity.ts';

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

test('纯 JS SHA-256 与 node:crypto 一致，支持中文与长路径', () => {
  for (const input of [
    '',
    'd:/workspace/assets/models/conveyor/conveyor.glb',
    'c:/用户/中文路径/Model-123-堆垛机/主模型.glb',
    'a'.repeat(500),
  ]) {
    assert.equal(sha256Utf8Hex(input), createHash('sha256').update(input, 'utf8').digest('hex'), input);
  }
});

test('组合固定包 originModel 校验与点击事件匹配（中台、跨中台隔离、本地模型、DIST 导出）', () => {
  const sourceKeyA = 'a'.repeat(64);
  const sourceKeyB = 'b'.repeat(64);
  const validPlatform = normalizeCompositionOriginModelIdentity({
    dataPlatformModel: { sourceKey: sourceKeyA, kind: 'model', resourceId: '123', modelPath: 'parts/stacker.glb' },
    resourceKey: 'model:123:parts/stacker.glb',
  });
  assert.deepEqual(validPlatform, {
    dataPlatformModel: { sourceKey: sourceKeyA, kind: 'model', resourceId: '123', modelPath: 'parts/stacker.glb' },
    resourceKey: 'model:123:parts/stacker.glb',
  });
  assert.equal(normalizeCompositionOriginModelIdentity({}), null);
  assert.equal(normalizeCompositionOriginModelIdentity({
    dataPlatformModel: { sourceKey: sourceKeyA, kind: 'model', resourceId: '123', modelPath: 'a.glb' },
    resourceKey: 'model:999:a.glb',
  }), null);
  assert.equal(normalizeCompositionOriginModelIdentity({ localPathSha256: 'not-a-sha' }), null);

  const compUrl = url('D:/workspace/SharedResources/Assets/Compositions/comp-1/rev-1/models/0/stacker.glb');
  const libraryPlatformUrl = url('D:/workspace/SharedResources/Assets/Models/Model-123-堆垛机/parts/stacker.glb');
  const compPlatformAsset = { sourceUrl: compUrl, sourceSnapshot: { contentSha256: 'c'.repeat(64), composition: true, originModel: validPlatform } };
  assert.equal(matchesClickEventModelIdentity(compPlatformAsset, {
    sourceUrl: libraryPlatformUrl,
    dataPlatformModel: { sourceKey: sourceKeyA, kind: 'model', resourceId: '123', modelPath: 'parts/stacker.glb' },
  }), true);
  assert.equal(matchesClickEventModelIdentity(compPlatformAsset, {
    sourceUrl: libraryPlatformUrl,
    dataPlatformModel: { sourceKey: sourceKeyB, kind: 'model', resourceId: '123', modelPath: 'parts/stacker.glb' },
  }), false, '不同数据中台来源不得误匹配');

  const localLibraryUrl = url('D:/workspace/Projects/P1/Assets/Models/LocalConveyor/conveyor.glb');
  const otherLocalUrl = url('D:/workspace/Projects/P1/Assets/Models/OtherConveyor/conveyor.glb');
  const localSha = getLocalModelPathSha256(localLibraryUrl);
  assert.ok(localSha);
  const compLocalAsset = { sourceUrl: compUrl, sourceSnapshot: { contentSha256: 'd'.repeat(64), composition: true, originModel: { localPathSha256: localSha } } };
  assert.equal(matchesClickEventModelIdentity(compLocalAsset, { sourceUrl: localLibraryUrl }), true);
  assert.equal(matchesClickEventModelIdentity(compLocalAsset, { sourceUrl: otherLocalUrl }), false, '不同路径的同名本地模型不得误匹配');
  assert.equal(matchesClickEventModelIdentity(compLocalAsset, {
    sourceUrl: url('project/assets/models/LocalConveyor-abcdef/conveyor.glb'),
    localPathSha256: localSha,
  }), true, 'DIST 导出的本地槽位应通过 localPathSha256 命中同源组合副本');
  assert.equal(matchesClickEventModelIdentity(
    { sourceUrl: compUrl, sourceSnapshot: { contentSha256: 'e'.repeat(64), composition: true, originModel: { resourceKey: 'model:123:parts/stacker.glb' } } },
    { sourceUrl: url('project/assets/models/0-111111/stacker.glb'), resourceKey: 'model:123:parts/stacker.glb' },
  ), true, 'DIST 导出的旧版中台槽位应通过 resourceKey 命中其他组合副本');
});

test('跨工程本地模型 portablePathSha256 与旧版缺 originModel 解组成员高熵 assetRevision 对齐', () => {
  const compUrl = url('D:/workspace/SharedResources/Assets/Compositions/comp-2/rev-2/models/0/conveyor.glb');
  const projectAUrl = url('D:/workspace/Projects/ProjectA/Assets/Models/Line/conveyor.glb');
  const projectBUrl = url('E:/other/Projects/ProjectB/Assets/Models/Line/conveyor.glb');
  const portableSha = getPortableLocalModelPathSha256(projectAUrl);
  assert.ok(portableSha);
  assert.equal(portableSha, getPortableLocalModelPathSha256(projectBUrl));

  // 场景 1 组合保存在 ProjectA，场景 2 在 ProjectB 解组后绑定本地模型库同相对路径模型。
  const compPortableAsset = {
    sourceUrl: compUrl,
    sourceSnapshot: {
      contentSha256: 'f'.repeat(64),
      composition: true,
      originModel: {
        localPathSha256: getLocalModelPathSha256(projectAUrl)!,
        portablePathSha256: portableSha,
      },
    },
  };
  assert.equal(matchesClickEventModelIdentity(compPortableAsset, { sourceUrl: projectBUrl }), true);
  assert.equal(matchesClickEventModelIdentity(compPortableAsset, {
    sourceUrl: url('project/assets/models/Line-123456/conveyor.glb'),
    portablePathSha256: portableSha,
  }), true, 'DIST 导出的本地槽位应通过 portablePathSha256 命中跨工程同源组合副本');

  // 旧版已解组组合固定包成员缺少 originModel 时，允许按高熵内容修订对齐，但拒绝低熵版本字符串与非组合成员误匹配。
  const shaRevision = '1234567890abcdef'.repeat(4);
  const uuidRevision = 'm8x1k2-123e4567-e89b-12d3-a456-426614174000';
  const legacyCompMemberSha = {
    sourceUrl: compUrl,
    assetRevision: shaRevision,
    sourceSnapshot: { contentSha256: '9'.repeat(64), composition: true },
  };
  const legacyCompMemberUuid = {
    sourceUrl: compUrl,
    assetRevision: uuidRevision,
    sourceSnapshot: { contentSha256: '8'.repeat(64), composition: true },
  };
  const legacyCompMemberWeak = {
    sourceUrl: compUrl,
    assetRevision: 'v1',
    sourceSnapshot: { contentSha256: '7'.repeat(64), composition: true },
  };
  assert.equal(matchesClickEventModelIdentity(legacyCompMemberSha, {
    sourceUrl: url('D:/workspace/SharedResources/Assets/Models/Model-88/conveyor.glb'),
    assetRevision: shaRevision,
  }), true);
  assert.equal(matchesClickEventModelIdentity(legacyCompMemberUuid, {
    sourceUrl: projectBUrl,
    assetRevision: uuidRevision,
  }), true);
  assert.equal(matchesClickEventModelIdentity(legacyCompMemberWeak, {
    sourceUrl: projectBUrl,
    assetRevision: 'v1',
  }), false, '低熵 revision 不得用于点击事件兜底匹配');
  assert.equal(matchesClickEventModelIdentity(
    { sourceUrl: url('D:/workspace/Projects/P1/Assets/Models/A/a.glb'), assetRevision: shaRevision },
    { sourceUrl: url('D:/workspace/Projects/P1/Assets/Models/B/b.glb'), assetRevision: shaRevision },
  ), false, '非组合固定包普通模型不得仅凭 assetRevision 跨路径误匹配');
});
