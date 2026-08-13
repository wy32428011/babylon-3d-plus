import assert from 'node:assert/strict';
import test from 'node:test';

import { updateModelAssetCodeCommand } from '../../src/editor/commands/entityCommands';
import type { Entity } from '../../src/editor/model/Entity';
import type { SceneDocument } from '../../src/editor/model/SceneDocument';

function createShelfEntity(id: string, assetCode: string): Entity {
  return {
    id,
    name: id,
    visible: true,
    locked: false,
    parentId: null,
    childrenIds: [],
    components: {
      transform: {
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      },
      modelAsset: {
        assetCode,
        sourcePath: 'fixture.glb',
        sourceUrl: 'fixture.glb',
        lengthUnit: 'meter',
        unitScaleToMeters: 1,
      },
    },
  };
}

function createSlotEntity(id: string, assetId: string, hostEntityId: string | null): Entity {
  return {
    id,
    name: id,
    visible: true,
    locked: false,
    parentId: null,
    childrenIds: [],
    components: {
      transform: {
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      },
      locator: {
        assetId,
        storageDepth: 'near',
        length: 1,
        width: 1,
        height: 1,
        columns: 1,
        layers: 1,
        startColumn: 1,
        startLayer: 1,
        columnGap: 0,
        layerGap: 0,
        deviceAssetCode: '',
        rowNumber: 1,
        ...(hostEntityId ? { builtInBinding: { hostEntityId, originOffset: { x: 0, y: 0, z: 0 } } } : {}),
      },
    },
  };
}

function createScene(...entities: Entity[]): SceneDocument {
  return {
    name: 'Built-in Slot Asset Sync Test',
    entityIds: entities.map((entity) => entity.id),
    entities: Object.fromEntries(entities.map((entity) => [entity.id, entity])),
    selectedEntityId: entities[0]?.id ?? null,
  } as unknown as SceneDocument;
}

test('货架资产编号变更时内置货格编号随命令同步，undo 一并回滚', () => {
  const shelf = createShelfEntity('shelf', 'SHELF-OLD');
  const slot = createSlotEntity('slot', 'SHELF-OLD', 'shelf');
  const scene = createScene(shelf, slot);
  const command = updateModelAssetCodeCommand('shelf', 'SHELF-OLD', 'SHELF-NEW');

  const after = command.execute(scene);
  assert.equal(after.entities.shelf.components.modelAsset?.assetCode, 'SHELF-NEW');
  assert.equal(after.entities.slot.components.locator?.assetId, 'SHELF-NEW');

  const reverted = command.undo(after);
  assert.equal(reverted.entities.shelf.components.modelAsset?.assetCode, 'SHELF-OLD');
  assert.equal(reverted.entities.slot.components.locator?.assetId, 'SHELF-OLD');
});

test('无内置货格时仅更新货架自身编号', () => {
  const shelf = createShelfEntity('shelf', 'SHELF-OLD');
  const standalone = createSlotEntity('locator', 'LOC-1', null);
  const scene = createScene(shelf, standalone);
  const command = updateModelAssetCodeCommand('shelf', 'SHELF-OLD', 'SHELF-NEW');

  const after = command.execute(scene);
  assert.equal(after.entities.shelf.components.modelAsset?.assetCode, 'SHELF-NEW');
  assert.equal(after.entities.locator.components.locator?.assetId, 'LOC-1');
});

test('内置货格编号已与货架一致时不重写货格实体', () => {
  const shelf = createShelfEntity('shelf', 'SHELF-OLD');
  const slot = createSlotEntity('slot', 'SHELF-NEW', 'shelf');
  const scene = createScene(shelf, slot);
  const command = updateModelAssetCodeCommand('shelf', 'SHELF-OLD', 'SHELF-NEW');

  const after = command.execute(scene);
  assert.equal(after.entities.slot, slot, '货格编号已一致时应保持原实体引用');
});
