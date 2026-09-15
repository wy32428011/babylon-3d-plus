import assert from 'node:assert/strict';
import test from 'node:test';

import { updateModelAssetCodeCommand } from '../../src/editor/commands/entityCommands';
import {
  deriveBuiltInSlotRowCountFromBinding,
  findBuiltInSlotEntities,
  findBuiltInSlotEntityId,
  normalizeBuiltInSlotBindingConfig,
  normalizeLocatorBuiltInBinding,
  patchBuiltInSlotDimensions,
  type BuiltInSlotBindingConfig,
} from '../../src/editor/model/builtInSlotBinding';
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

function createSlotEntity(
  id: string,
  assetId: string,
  hostEntityId: string | null,
  rowIndex = 0,
): Entity {
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
        columnReversed: false,
        columnGap: 0,
        layerGap: 0,
        deviceAssetCode: '',
        aisleCode: '',
        rowNumber: rowIndex + 1,
        ...(hostEntityId ? { builtInBinding: { hostEntityId, rowIndex, originOffset: { x: 0, y: 0, z: 0 } } } : {}),
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

test('多排内置货格的编号随货架同命令同步，undo 一并回滚', () => {
  const shelf = createShelfEntity('shelf', 'SHELF-OLD');
  const row1 = createSlotEntity('slot-1', 'SHELF-OLD', 'shelf', 0);
  const row2 = createSlotEntity('slot-2', 'SHELF-OLD', 'shelf', 1);
  const scene = createScene(shelf, row1, row2);
  const command = updateModelAssetCodeCommand('shelf', 'SHELF-OLD', 'SHELF-NEW');

  const after = command.execute(scene);
  assert.equal(after.entities['slot-1'].components.locator?.assetId, 'SHELF-NEW');
  assert.equal(after.entities['slot-2'].components.locator?.assetId, 'SHELF-NEW');

  const reverted = command.undo(after);
  assert.equal(reverted.entities['slot-1'].components.locator?.assetId, 'SHELF-OLD');
  assert.equal(reverted.entities['slot-2'].components.locator?.assetId, 'SHELF-OLD');
});

test('findBuiltInSlotEntities 按排索引升序返回，findBuiltInSlotEntityId 取首排', () => {
  const shelf = createShelfEntity('shelf', 'SHELF-1');
  const other = createShelfEntity('other-shelf', 'SHELF-2');
  // 场景顺序故意与排索引相反
  const row2 = createSlotEntity('slot-2', 'SHELF-1', 'shelf', 1);
  const row1 = createSlotEntity('slot-1', 'SHELF-1', 'shelf', 0);
  const foreign = createSlotEntity('foreign', 'SHELF-2', 'other-shelf', 0);
  const scene = createScene(shelf, other, row2, row1, foreign);

  assert.deepEqual(findBuiltInSlotEntities(scene, 'shelf').map((entity) => entity.id), ['slot-1', 'slot-2']);
  assert.equal(findBuiltInSlotEntityId(scene, 'shelf'), 'slot-1');
  assert.deepEqual(findBuiltInSlotEntities(scene, 'other-shelf').map((entity) => entity.id), ['foreign']);
  assert.deepEqual(findBuiltInSlotEntities(scene, 'missing'), []);
});

test('patchBuiltInSlotDimensions 把派生维度写入全部排', () => {
  const shelf = createShelfEntity('shelf', 'SHELF-1');
  shelf.components.modelAsset = {
    ...shelf.components.modelAsset!,
    builtInSlotBindingConfig: {
      enabledParam: 'enableBuiltInSlots',
      dimensionMapping: { columns: 'columnCount', layers: 'layerCount' },
    },
    parameterValues: { enableBuiltInSlots: true, columnCount: 7, layerCount: 3 },
  };
  const scene = createScene(
    shelf,
    createSlotEntity('slot-1', 'SHELF-1', 'shelf', 0),
    createSlotEntity('slot-2', 'SHELF-1', 'shelf', 1),
  );

  const patched = patchBuiltInSlotDimensions(scene, 'shelf');
  assert.equal(patched.entities['slot-1'].components.locator?.columns, 7);
  assert.equal(patched.entities['slot-1'].components.locator?.layers, 3);
  assert.equal(patched.entities['slot-2'].components.locator?.columns, 7);
  assert.equal(patched.entities['slot-2'].components.locator?.layers, 3);
  // 维度无变化时返回原 scene，避免无谓的重渲染
  assert.equal(patchBuiltInSlotDimensions(patched, 'shelf'), patched);
});

test('deriveBuiltInSlotRowCountFromBinding：未声明为 1 排，声明后只认 4 / 2', () => {
  const base: BuiltInSlotBindingConfig = { enabledParam: 'enableBuiltInSlots', dimensionMapping: {} };
  assert.equal(deriveBuiltInSlotRowCountFromBinding(base, { enableBuiltInSlots: true }), 1);

  const withRows: BuiltInSlotBindingConfig = { ...base, rowCountParam: 'builtInSlotRows' };
  assert.equal(deriveBuiltInSlotRowCountFromBinding(withRows, { builtInSlotRows: '2' }), 2);
  assert.equal(deriveBuiltInSlotRowCountFromBinding(withRows, { builtInSlotRows: 2 }), 2);
  assert.equal(deriveBuiltInSlotRowCountFromBinding(withRows, { builtInSlotRows: '4' }), 4);
  assert.equal(deriveBuiltInSlotRowCountFromBinding(withRows, { builtInSlotRows: 4 }), 4);
  // 空值与离群值一律按 2 排兜底
  assert.equal(deriveBuiltInSlotRowCountFromBinding(withRows, {}), 2);
  assert.equal(deriveBuiltInSlotRowCountFromBinding(withRows, { builtInSlotRows: '' }), 2);
  assert.equal(deriveBuiltInSlotRowCountFromBinding(withRows, { builtInSlotRows: 'oops' }), 2);
  assert.equal(deriveBuiltInSlotRowCountFromBinding(withRows, { builtInSlotRows: 3 }), 2);
  assert.equal(deriveBuiltInSlotRowCountFromBinding(withRows, undefined), 2);
});

test('normalizeBuiltInSlotBindingConfig 解析 rowCountParam，缺省不写入字段', () => {
  const declared = normalizeBuiltInSlotBindingConfig({
    enabledParam: 'enableBuiltInSlots',
    dimensionMapping: { columns: 'columnCount' },
    columnDirection: '-x',
    rowCountParam: ' builtInSlotRows ',
  });
  assert.deepEqual(declared, {
    enabledParam: 'enableBuiltInSlots',
    dimensionMapping: { columns: 'columnCount' },
    columnDirection: '-x',
    rowCountParam: 'builtInSlotRows',
  });

  const bare = normalizeBuiltInSlotBindingConfig({ enabledParam: 'enableBuiltInSlots' });
  assert.equal(bare && 'rowCountParam' in bare, false);
  assert.equal(normalizeBuiltInSlotBindingConfig({ enabledParam: '  ' }), undefined);
});

test('normalizeLocatorBuiltInBinding 保留排索引，非法值回退 0', () => {
  assert.deepEqual(
    normalizeLocatorBuiltInBinding({ hostEntityId: 'shelf', rowIndex: 3, originOffset: { x: 1, y: 2, z: 3 } }),
    { hostEntityId: 'shelf', rowIndex: 3, originOffset: { x: 1, y: 2, z: 3 } },
  );
  // 旧存档没有 rowIndex 字段 → 视为首排
  assert.deepEqual(
    normalizeLocatorBuiltInBinding({ hostEntityId: 'shelf', originOffset: { x: 0, y: 0, z: 0 } }),
    { hostEntityId: 'shelf', rowIndex: 0, originOffset: { x: 0, y: 0, z: 0 } },
  );
  for (const invalid of [-1, 1.5, 'two', null, Number.NaN]) {
    assert.equal(
      normalizeLocatorBuiltInBinding({ hostEntityId: 'shelf', rowIndex: invalid })?.rowIndex,
      0,
      `rowIndex=${String(invalid)} 应回退 0`,
    );
  }
});
