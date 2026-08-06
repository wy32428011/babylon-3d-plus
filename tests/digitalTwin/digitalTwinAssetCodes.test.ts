import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { createServer } from 'vite';

import type { Entity } from '../../src/editor/model/Entity.ts';
import type { SceneDocument } from '../../src/editor/model/SceneDocument.ts';
const viteServer = await createServer({
  appType: 'custom',
  configFile: false,
  root: process.cwd(),
  server: { middlewareMode: true, hmr: false },
  optimizeDeps: { noDiscovery: true },
});
const {
  analyzeDigitalTwinAssetCodes,
  buildDigitalTwinAssetIndex,
  findDigitalTwinAsset,
  isLikelyGeneratedAssetCode,
} = await viteServer.ssrLoadModule('/src/shared/digitalTwinAssetCodes.ts') as typeof import('../../src/shared/digitalTwinAssetCodes.ts');
after(async () => {
  await viteServer.close();
});

function modelEntity(
  id: string,
  assetCode: string,
  options: { parentId?: string | null; visible?: boolean; name?: string } = {},
): Entity {
  return {
    id,
    name: options.name ?? id,
    visible: options.visible ?? true,
    locked: false,
    parentId: options.parentId ?? null,
    childrenIds: [],
    components: {
      transform: {
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      },
      modelAsset: {
        assetCode,
        sourcePath: `C:/models/${id}.glb`,
        sourceUrl: `editor-asset://local/${id}.glb`,
        lengthUnit: 'm',
        unitScaleToMeters: 1,
      },
    },
  };
}

function folderEntity(id: string, visible: boolean, childrenIds: string[]): Entity {
  return {
    id,
    name: id,
    isFolder: true,
    visible,
    locked: false,
    parentId: null,
    childrenIds,
    components: {
      transform: {
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      },
    },
  };
}

function sceneWith(...entities: Entity[]): SceneDocument {
  return {
    id: 'scene_asset_focus_fixture',
    name: 'asset focus fixture',
    entityIds: entities.map((entity) => entity.id),
    entities: Object.fromEntries(entities.map((entity) => [entity.id, entity])),
    selectedEntityId: null,
    mqttConfig: {} as SceneDocument['mqttConfig'],
    sceneSettings: {} as SceneDocument['sceneSettings'],
    fetchConfig: { url: '', apiKey: '' },
  };
}

test('资产索引只按 modelAsset.assetCode 精确且区分大小写匹配并保留前导零', () => {
  const scene = sceneWith(
    modelEntity('entity_upper', 'DDJ2', { name: '名称不是搜索字段' }),
    modelEntity('entity_lower', 'ddj2'),
    modelEntity('entity_zero', '001005'),
  );
  const index = buildDigitalTwinAssetIndex(scene);

  assert.deepEqual(findDigitalTwinAsset(index, 'DDJ2'), { status: 'found', assetCode: 'DDJ2', entityId: 'entity_upper' });
  assert.deepEqual(findDigitalTwinAsset(index, 'ddj2'), { status: 'found', assetCode: 'ddj2', entityId: 'entity_lower' });
  assert.deepEqual(findDigitalTwinAsset(index, '001005'), { status: 'found', assetCode: '001005', entityId: 'entity_zero' });
  assert.deepEqual(findDigitalTwinAsset(index, '名称不是搜索字段'), { status: 'not-found', assetCode: '名称不是搜索字段' });
});

test('重复编号返回 ambiguous 而不是静默选择第一个实体', () => {
  const index = buildDigitalTwinAssetIndex(sceneWith(
    modelEntity('entity_a', 'DUPLICATE'),
    modelEntity('entity_b', 'DUPLICATE'),
  ));

  assert.deepEqual(findDigitalTwinAsset(index, 'DUPLICATE'), {
    status: 'ambiguous',
    assetCode: 'DUPLICATE',
    entityIds: ['entity_a', 'entity_b'],
  });
});

test('实体或父级隐藏时返回 not-visible', () => {
  const hiddenChild = modelEntity('entity_hidden_child', 'HIDDEN_BY_PARENT', { parentId: 'folder_hidden' });
  const hiddenSelf = modelEntity('entity_hidden_self', 'HIDDEN_SELF', { visible: false });
  const folder = folderEntity('folder_hidden', false, [hiddenChild.id]);
  const index = buildDigitalTwinAssetIndex(sceneWith(folder, hiddenChild, hiddenSelf));

  assert.deepEqual(findDigitalTwinAsset(index, 'HIDDEN_BY_PARENT'), {
    status: 'not-visible',
    assetCode: 'HIDDEN_BY_PARENT',
    entityId: hiddenChild.id,
  });
  assert.deepEqual(findDigitalTwinAsset(index, 'HIDDEN_SELF'), {
    status: 'not-visible',
    assetCode: 'HIDDEN_SELF',
    entityId: hiddenSelf.id,
  });
});

test('输入会 trim，但空值和仅有名称的实体不会进入匹配', () => {
  const model = modelEntity('entity_trim', '  ASSET-01  ');
  const plain = folderEntity('folder_plain', true, []);
  plain.name = 'ASSET-02';
  const index = buildDigitalTwinAssetIndex(sceneWith(model, plain));

  assert.deepEqual(findDigitalTwinAsset(index, '  ASSET-01  '), { status: 'found', assetCode: 'ASSET-01', entityId: model.id });
  assert.deepEqual(findDigitalTwinAsset(index, '   '), { status: 'invalid', assetCode: '' });
  assert.deepEqual(findDigitalTwinAsset(index, 'ASSET-02'), { status: 'not-found', assetCode: 'ASSET-02' });
});

test('发布诊断识别默认自动编号和区分大小写的重复编号', () => {
  const generated = modelEntity('entity_2b9866fc-b095-45b8-8a3c-769742b2bed9', 'Stacker01-2B9866FC', { name: 'DDJ2' });
  const duplicateA = modelEntity('entity_dup_a', 'DUP');
  const duplicateB = modelEntity('entity_dup_b', 'DUP');
  const distinctCase = modelEntity('entity_dup_lower', 'dup');
  const diagnostics = analyzeDigitalTwinAssetCodes(sceneWith(generated, duplicateA, duplicateB, distinctCase));

  assert.equal(isLikelyGeneratedAssetCode(generated.id, 'Stacker01-2B9866FC'), true);
  assert.equal(isLikelyGeneratedAssetCode(generated.id, 'DDJ2'), false);
  assert.deepEqual(diagnostics.generatedAssetCodes, [{
    entityId: generated.id,
    entityName: 'DDJ2',
    assetCode: 'Stacker01-2B9866FC',
  }]);
  assert.deepEqual(diagnostics.duplicateAssetCodes, [{
    assetCode: 'DUP',
    entityIds: ['entity_dup_a', 'entity_dup_b'],
    entityNames: ['entity_dup_a', 'entity_dup_b'],
  }]);
});
