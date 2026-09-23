import assert from 'node:assert/strict';
import test from 'node:test';
import {
  collectDigitalTwinResourceIds,
  createPendingChunkIndexes,
  parseDataPlatformResourceKey,
} from '../../electron/ipc/digitalTwinPublishProtocol.ts';

test('从模型、环境、组合模型及生成器引用中提取数据中台资源 ID', () => {
  const scene = JSON.stringify({
    version: 3,
    scene: {
      entities: {
        a: { components: { modelAsset: { sourcePath: 'C:/cache/Assets/Models/Model-101-Pump/main.glb' } } },
        b: { components: { modelAsset: { sourceUrl: 'editor-asset://local/C%3A%5Ccache%5CAssets%5CModels%5CComboModels%5CCombo-303-Line%5Cmain.glb' } } },
        c: { components: { modelGenerator: { defaultTarget: { kind: 'model', packagePath: 'C:/cache/Assets/Models/Model-202-Box' }, rules: [] } } },
      },
      sceneSettings: {
        environment: { packagePath: 'C:/cache/Assets/Environments/Env-404-Factory' },
      },
      metadata: {
        description: '普通说明文字 C:/cache/Assets/Models/Model-999-NotReferenced/main.glb 不应被识别为资源引用',
      },
    },
  });
  assert.deepEqual(collectDigitalTwinResourceIds([scene]), {
    modelIds: ['101', '202'],
    envModelIds: ['404'],
    comboModelIds: ['303'],
  });
});

test('资源键只接受稳定数据中台目录命名', () => {
  assert.deepEqual(parseDataPlatformResourceKey('D:/Assets/Models/Model-12-Pump/main.glb'), { type: 'MODEL', id: '12' });
  assert.deepEqual(parseDataPlatformResourceKey('D:/Assets/Models/ComboModels/Combo-34-Line'), { type: 'COMBO_MODEL', id: '34' });
  assert.deepEqual(parseDataPlatformResourceKey('D:/Assets/Environments/Env-56-Factory'), { type: 'ENV_MODEL', id: '56' });
  assert.equal(parseDataPlatformResourceKey('D:/Assets/Models/MyModel/main.glb'), null);
});

test('断点分片规划跳过已上传分片并保持有界索引', () => {
  assert.deepEqual(createPendingChunkIndexes(35, 10, [1, 3, 99, -1, 1]), [0, 2]);
  assert.deepEqual(createPendingChunkIndexes(0, 10, []), []);
  assert.throws(() => createPendingChunkIndexes(10, 0, []), /分片大小/);
});


test('结构化数据中台环境模型身份直接进入发布资源 ID', () => {
  const ids = collectDigitalTwinResourceIds([JSON.stringify({
    version: 3,
    scene: {
      sceneSettings: {
        environment: {
          source: 'data-platform',
          resourceType: 'ENV_MODEL',
          dataPlatformResourceId: '9007199254740993',
          dataPlatformSourceKey: 'a'.repeat(64),
          dataPlatformRevision: '7',
        },
      },
    },
  })]);
  assert.deepEqual(ids.envModelIds, ['9007199254740993']);
});

test('组合根和解组成员按相同固定版本去重，并提交内容摘要', () => {
  const identity={schemaVersion:1,libraryId:'library',revision:'version-1',resourceId:'2053001280000000001',resourceType:'ENV_MODEL',packagePath:'Assets/Compositions/library/version-1'};
  const contentSha256='a'.repeat(64);
  const scene={entities:{root:{isFolder:true,composition:{...identity,instanceId:'instance',contentSha256}},member:{components:{modelAsset:{sourceSnapshot:{contentSha256,composition:true,compositionResource:identity}}}}}};
  const result=collectDigitalTwinResourceIds([JSON.stringify({version:5,scene})]);
  assert.deepEqual(result.compositionVersions,[{id:identity.resourceId,revision:identity.revision,contentSha256}]);
  assert.deepEqual(result.envModelIds,[]);
});

test('组合发布拒绝未同步身份和同版本不同摘要', () => {
  const composition={schemaVersion:1,instanceId:'instance',libraryId:'library',revision:'version-1',contentSha256:'a'.repeat(64)};
  assert.throws(()=>collectDigitalTwinResourceIds([JSON.stringify({scene:{entities:{root:{isFolder:true,composition}}}})]),/尚未同步/);
  const first={isFolder:true,composition:{...composition,resourceId:'1'}};
  const second={isFolder:true,composition:{...first.composition,contentSha256:'b'.repeat(64)}};
  assert.throws(()=>collectDigitalTwinResourceIds([JSON.stringify({scene:{entities:{first,second}}})]),/摘要不一致/);
});
