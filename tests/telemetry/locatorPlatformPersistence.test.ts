import assert from 'node:assert/strict';
import test from 'node:test';

import type { Entity } from '../../src/editor/model/Entity';
import { createEmptySceneDocument } from '../../src/editor/model/SceneDocument';
import { deserializeScene, serializeScene } from '../../src/editor/project/SceneSerializer';

function locatorEntity(
  id: string,
  kind: 'layerChangePlatform' | undefined,
  startColumn: number | undefined,
): Entity {
  return {
    id,
    name: id,
    isFolder: false,
    parentId: null,
    childrenIds: [],
    components: {
      transform: {
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      },
      locator: {
        assetId: 'SHELF1',
        storageDepth: 'near',
        length: 0.5,
        width: 0.5,
        height: 0.5,
        columns: 1,
        layers: 4,
        ...(startColumn === undefined ? {} : { startColumn }),
        startLayer: 1,
        columnReversed: false,
        columnGap: 0,
        layerGap: 0,
        deviceAssetCode: '',
        aisleCode: '1',
        rowNumber: 1,
        builtInBinding: {
          hostEntityId: 'entity_host',
          rowIndex: 0,
          originOffset: { x: 0, y: 0, z: 0 },
          ...(kind ? { kind } : {}),
        },
      },
    },
  } as unknown as Entity;
}

test('换层站台起始列允许负值并随场景文件往返；普通货格仍从 0 起', () => {
  const scene = createEmptySceneDocument('换层站台起始列');
  const platformId = 'entity_platform';
  const platformDefaultId = 'entity_platform_default';
  const slotId = 'entity_slot';
  scene.entityIds.push(platformId, platformDefaultId, slotId);
  scene.entities[platformId] = locatorEntity(platformId, 'layerChangePlatform', -1);
  scene.entities[platformDefaultId] = locatorEntity(platformDefaultId, 'layerChangePlatform', undefined);
  scene.entities[slotId] = locatorEntity(slotId, undefined, -1);

  const restored = deserializeScene(serializeScene(scene));

  assert.equal(restored.entities[platformId].components.locator?.startColumn, -1, '换层站台的 -1 不得被夹成 0');
  assert.equal(restored.entities[platformDefaultId].components.locator?.startColumn, -1, '换层站台缺省起始列应为 -1');
  assert.equal(restored.entities[slotId].components.locator?.startColumn, 0, '普通货格负值仍应夹到 0');
});
