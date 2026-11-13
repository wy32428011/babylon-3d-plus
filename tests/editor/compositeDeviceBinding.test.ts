import test from 'node:test';
import assert from 'node:assert/strict';
import { importIsolatedTypeScriptModules } from '../helpers/extensionlessTypeScriptTestBootstrap.ts';

const [
  { createEmptySceneDocument, createModelEntity },
  { normalizeModelDataDrivenConfig },
  { getDevicePartDeclaration, reconcileCompositeDevices },
  { deserializeScene, serializeScene },
  { deleteEntitiesInScene },
  { applySceneModelUpdates },
] = (await importIsolatedTypeScriptModules([
  'src/editor/model/SceneDocument.ts',
  'src/editor/model/telemetryBinding.ts',
  'src/editor/model/devicePartBinding.ts',
  'src/editor/project/SceneSerializer.ts',
  'src/editor/store/slices/sceneHierarchyOperations.ts',
  'src/editor/assets/applySceneModelUpdates.ts',
])) as [
  typeof import('../../src/editor/model/SceneDocument'),
  typeof import('../../src/editor/model/telemetryBinding'),
  typeof import('../../src/editor/model/devicePartBinding'),
  typeof import('../../src/editor/project/SceneSerializer'),
  typeof import('../../src/editor/store/slices/sceneHierarchyOperations'),
  typeof import('../../src/editor/assets/applySceneModelUpdates'),
];

const subDevices = [
  {
    role: 'transfer',
    displayName: '移栽机构',
    device: { devType: 'conveyor' },
    cargo: {
      travel: {
        axis: 'x',
        nodes: ['EQ_YZJ'],
        fields: ['movement_x'],
        directionSource: 'task',
        forwardSign: 1,
      },
      lift: { field: 'movement_y', homeValue: 0, raisedValue: 1, loweringValue: 2 },
    },
    fixedNodes: [],
  },
];

function createCompositeScene() {
  const host = createModelEntity(
    'C:/models/roller-transfer.glb',
    'editor-asset://local/C%3A%5Cmodels%5Croller-transfer.glb',
    '4014',
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    {
      device: { devType: 'conveyor', defaultAssetCode: 'RollerTransfer01' },
      cargo: { travel: { axis: 'z', nodes: ['GD_4'] } },
      subDevices,
      fixedNodes: [],
    },
  );
  host.components.modelAsset!.assetCode = '4014';
  const scene = createEmptySceneDocument('复合设备升级测试');
  scene.entityIds = [host.id];
  scene.entities = { [host.id]: host };
  return { scene, host };
}

test('复合设备归一化保留角色声明，并拒绝重复 role', () => {
  const config = normalizeModelDataDrivenConfig({
    device: { devType: 'conveyor' },
    subDevices: [...subDevices, ...subDevices],
    fixedNodes: [],
  });
  assert.equal(config?.subDevices?.length, 1);
  assert.equal(config?.subDevices?.[0].role, 'transfer');
  assert.equal(config?.subDevices?.[0].cargo?.travel !== undefined, true);
  assert.equal(config?.subDevices?.[0].cargo?.lift !== undefined, true);
});

test('历史场景幂等升级：保留宿主，第二设备号留空且原输入不被修改', () => {
  const { scene, host } = createCompositeScene();
  const before = structuredClone(scene);
  const upgraded = reconcileCompositeDevices(scene);
  assert.deepEqual(scene, before, '打开时的迁移不得原地修改输入快照');
  assert.equal(upgraded.createdCount, 2);
  assert.equal(upgraded.scene.entities[host.id], upgraded.scene.entities[host.id]);
  assert.equal(upgraded.scene.entities[host.id].components.modelAsset?.assetCode, '4014');
  assert.deepEqual(
    upgraded.scene.entities[host.id].components.transform,
    host.components.transform,
  );

  const part = Object.values(upgraded.scene.entities).find(
    (entity) => entity.components.devicePartBinding,
  );
  assert.ok(part);
  assert.equal(part.components.devicePartBinding?.role, 'transfer');
  assert.equal(part.components.telemetryBinding?.assetCode, undefined);
  assert.equal(part.components.modelAsset, undefined);
  assert.equal(getDevicePartDeclaration(upgraded.scene, part)?.displayName, '移栽机构');
  assert.match(upgraded.warnings[0], /手动填写第二设备号/);

  const again = reconcileCompositeDevices(upgraded.scene);
  assert.equal(again.createdCount, 0);
  assert.equal(again.scene, upgraded.scene);
});

test('手填第二设备号后保存重开保留绑定，反序列化不重复创建', () => {
  const { scene } = createCompositeScene();
  const upgraded = reconcileCompositeDevices(scene).scene;
  const part = Object.values(upgraded.entities).find(
    (entity) => entity.components.devicePartBinding,
  )!;
  part.components.telemetryBinding!.assetCode = '4018';

  const reopened = deserializeScene(serializeScene(upgraded));
  const parts = Object.values(reopened.entities).filter(
    (entity) => entity.components.devicePartBinding,
  );
  assert.equal(parts.length, 1);
  assert.equal(parts[0].components.telemetryBinding?.assetCode, '4018');
  const folder = Object.values(reopened.entities).find(
    (entity) => entity.components.compositeDevice,
  );
  assert.ok(folder?.isFolder);
  assert.ok(folder.childrenIds.includes(parts[0].id));
});

test('删除宿主时一并删除逻辑子设备与复合分组', () => {
  const { scene, host } = createCompositeScene();
  const upgraded = reconcileCompositeDevices(scene).scene;
  const deleted = deleteEntitiesInScene(upgraded, [host.id]);
  assert.equal(deleted.entities[host.id], undefined);
  assert.equal(
    Object.values(deleted.entities).some((entity) => entity.components.devicePartBinding),
    false,
  );
  assert.equal(
    Object.values(deleted.entities).some((entity) => entity.components.compositeDevice),
    false,
  );
});

test('模型同步事务应用新版 subDevices 后自动补建逻辑节点并保留主绑定', () => {
  const { scene, host } = createCompositeScene();
  const oldSourceUrl = `editor-asset://local/${encodeURIComponent('C:/old/Model-123-roller/roller.glb')}`;
  const newSourceUrl = `editor-asset://local/${encodeURIComponent('C:/new/Model-123-roller/roller.glb')}`;
  Object.assign(host.components.modelAsset!, {
    sourcePath: 'C:/old/Model-123-roller/roller.glb',
    sourceUrl: oldSourceUrl,
    assetRevision: 'old',
  });
  delete host.components.modelAsset!.dataDrivenConfig!.subDevices;

  const result = applySceneModelUpdates(
    scene,
    [
      {
        sourceUrls: [oldSourceUrl],
        asset: {
          id: 'new-roller',
          kind: 'model',
          libraryKind: 'model',
          name: '辊筒移载',
          path: 'C:/new/Model-123-roller/roller.glb',
          sourceUrl: newSourceUrl,
          packagePath: 'C:/new/Model-123-roller',
          assetRevision: 'new',
          lengthUnit: 'meter',
          dataDrivenConfig: {
            device: { devType: 'conveyor', defaultAssetCode: 'RollerTransfer01' },
            cargo: { travel: { axis: 'z', nodes: ['GD_4'] } },
            subDevices,
            fixedNodes: [],
          },
        },
      },
    ],
    'a'.repeat(64),
  );

  const part = Object.values(result.scene.entities).find(
    (entity) => entity.components.devicePartBinding,
  );
  assert.ok(part);
  assert.equal(part.components.telemetryBinding?.assetCode, undefined);
  assert.equal(result.scene.entities[host.id].components.modelAsset?.assetCode, '4014');
  assert.equal(result.scene.entities[host.id].components.telemetryBinding?.deviceType, 'conveyor');
  assert.ok(result.warnings.some((warning) => warning.includes('手动填写第二设备号')));
});
