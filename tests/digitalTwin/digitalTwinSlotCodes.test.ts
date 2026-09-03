import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { createServer } from 'vite';

import type { Entity } from '../../src/editor/model/Entity.ts';
import type { SceneDocument } from '../../src/editor/model/SceneDocument.ts';
import type { LocatorComponent } from '../../src/editor/model/components.ts';

const viteServer = await createServer({
  appType: 'custom',
  configFile: false,
  root: process.cwd(),
  server: { middlewareMode: true, hmr: false },
  optimizeDeps: { noDiscovery: true },
});
const {
  buildDigitalTwinAssetIndex,
} = await viteServer.ssrLoadModule('/src/shared/digitalTwinAssetCodes.ts') as typeof import('../../src/shared/digitalTwinAssetCodes.ts');
const {
  buildDigitalTwinSlotIndex,
  findDigitalTwinFocusTarget,
  parseDigitalTwinSlotCoordinate,
} = await viteServer.ssrLoadModule('/src/shared/digitalTwinSlotCodes.ts') as typeof import('../../src/shared/digitalTwinSlotCodes.ts');
after(async () => {
  await viteServer.close();
});

function transform() {
  return {
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    scale: { x: 1, y: 1, z: 1 },
  };
}

function modelEntity(id: string, assetCode: string, options: { visible?: boolean } = {}): Entity {
  return {
    id,
    name: id,
    visible: options.visible ?? true,
    locked: false,
    parentId: null,
    childrenIds: [],
    components: {
      transform: transform(),
      modelAsset: {
        assetCode,
        sourcePath: `C:/models/${id}.glb`,
        sourceUrl: `editor-asset://local/${id}.glb`,
        lengthUnit: 'meter',
        unitScaleToMeters: 1,
      },
    },
  };
}

function locatorEntity(
  id: string,
  locator: Partial<LocatorComponent> & Pick<LocatorComponent, 'assetId' | 'rowNumber' | 'startColumn' | 'startLayer' | 'columns' | 'layers'>,
  options: { visible?: boolean; hostEntityId?: string } = {},
): Entity {
  return {
    id,
    name: id,
    visible: options.visible ?? true,
    locked: false,
    parentId: null,
    childrenIds: [],
    components: {
      transform: transform(),
      locator: {
        assetId: locator.assetId,
        storageDepth: 'near',
        length: 1,
        width: 1,
        height: 1,
        columns: locator.columns,
        layers: locator.layers,
        startColumn: locator.startColumn,
        startLayer: locator.startLayer,
        columnGap: 0,
        layerGap: 0,
        deviceAssetCode: '',
        rowNumber: locator.rowNumber,
        ...(options.hostEntityId
          ? { builtInBinding: { hostEntityId: options.hostEntityId, originOffset: { x: 0, y: 0, z: 0 } } }
          : {}),
      },
    },
  };
}

function sceneWith(...entities: Entity[]): SceneDocument {
  return {
    id: 'scene_slot_focus_fixture',
    name: 'slot focus fixture',
    entityIds: entities.map((entity) => entity.id),
    entities: Object.fromEntries(entities.map((entity) => [entity.id, entity])),
    selectedEntityId: null,
    mqttConfig: {} as SceneDocument['mqttConfig'],
    sceneSettings: {} as SceneDocument['sceneSettings'],
    fetchConfig: { url: '', apiKey: '' },
  };
}

function lookup(scene: SceneDocument, query: string) {
  return findDigitalTwinFocusTarget(buildDigitalTwinAssetIndex(scene), buildDigitalTwinSlotIndex(scene), query);
}

test('排-列-层坐标解析：排=rowNumber，列=to_x，层=to_y', () => {
  assert.deepEqual(parseDigitalTwinSlotCoordinate('1-5-3'), { row: 1, column: 5, layer: 3 });
  assert.deepEqual(parseDigitalTwinSlotCoordinate(' 3-2-1 '), { row: 3, column: 2, layer: 1 });
  assert.equal(parseDigitalTwinSlotCoordinate('1-5'), null);
  assert.equal(parseDigitalTwinSlotCoordinate('A-1-1'), null);
});

test('模型资产编号优先于同形货格坐标', () => {
  const scene = sceneWith(
    modelEntity('entity_model', '1-5-3'),
    locatorEntity('entity_locator', { assetId: 'SHELF', rowNumber: 1, startColumn: 1, startLayer: 1, columns: 10, layers: 5 }),
  );
  assert.deepEqual(lookup(scene, '1-5-3'), {
    status: 'found',
    assetCode: '1-5-3',
    entityId: 'entity_model',
  });
});

test('覆盖范围内的排-列-层命中货格，内置货格同号仍优先命中宿主模型', () => {
  const scene = sceneWith(
    modelEntity('entity_shelf', 'SHELF-01'),
    locatorEntity(
      'entity_builtin',
      { assetId: 'SHELF-01', rowNumber: 1, startColumn: 1, startLayer: 1, columns: 10, layers: 5 },
      { hostEntityId: 'entity_shelf' },
    ),
  );
  assert.deepEqual(lookup(scene, '1-5-3'), {
    status: 'found',
    assetCode: '1-5-3',
    entityId: 'entity_builtin',
    slot: { row: 1, column: 5, layer: 3 },
  });
  assert.deepEqual(lookup(scene, 'SHELF-01'), {
    status: 'found',
    assetCode: 'SHELF-01',
    entityId: 'entity_shelf',
  });
});

test('多个覆盖同一格子的货格返回 ambiguous', () => {
  const scene = sceneWith(
    locatorEntity('entity_a', { assetId: 'A', rowNumber: 1, startColumn: 1, startLayer: 1, columns: 6, layers: 4 }),
    locatorEntity('entity_b', { assetId: 'B', rowNumber: 1, startColumn: 4, startLayer: 2, columns: 4, layers: 3 }),
  );
  assert.deepEqual(lookup(scene, '1-5-3'), {
    status: 'ambiguous',
    assetCode: '1-5-3',
    entityIds: ['entity_a', 'entity_b'],
  });
});

test('内置货格宿主隐藏或货格实体隐藏返回 not-visible', () => {
  const hiddenHost = sceneWith(
    modelEntity('entity_shelf', 'SHELF-01', { visible: false }),
    locatorEntity(
      'entity_builtin',
      { assetId: 'SHELF-01', rowNumber: 1, startColumn: 1, startLayer: 1, columns: 10, layers: 5 },
      { hostEntityId: 'entity_shelf' },
    ),
  );
  assert.deepEqual(lookup(hiddenHost, '1-5-3'), {
    status: 'not-visible',
    assetCode: '1-5-3',
    entityId: 'entity_builtin',
  });

  const hiddenLocator = sceneWith(
    locatorEntity(
      'entity_locator',
      { assetId: 'LOC', rowNumber: 1, startColumn: 1, startLayer: 1, columns: 10, layers: 5 },
      { visible: false },
    ),
  );
  assert.deepEqual(lookup(hiddenLocator, '1-5-3'), {
    status: 'not-visible',
    assetCode: '1-5-3',
    entityId: 'entity_locator',
  });
});

test('虚拟货格资产编号定位单格坐标或多格整体', () => {
  const scene = sceneWith(
    locatorEntity('entity_single', { assetId: 'SLOT-A', rowNumber: 2, startColumn: 4, startLayer: 6, columns: 1, layers: 1 }),
    locatorEntity('entity_grid', { assetId: 'GRID-A', rowNumber: 3, startColumn: 1, startLayer: 1, columns: 4, layers: 2 }),
  );
  assert.deepEqual(lookup(scene, 'SLOT-A'), {
    status: 'found',
    assetCode: 'SLOT-A',
    entityId: 'entity_single',
    slot: { row: 2, column: 4, layer: 6 },
  });
  assert.deepEqual(lookup(scene, 'GRID-A'), { status: 'found', assetCode: 'GRID-A', entityId: 'entity_grid' });
});

test('3-2-1 按排-列-层解释，不会按旧 MQTT 列-层-排误命中', () => {
  const scene = sceneWith(
    locatorEntity('entity_locator', { assetId: 'LOC', rowNumber: 1, startColumn: 1, startLayer: 1, columns: 4, layers: 3 }),
  );
  assert.deepEqual(lookup(scene, '3-2-1'), { status: 'not-found', assetCode: '3-2-1' });
  assert.deepEqual(lookup(scene, '1-3-2'), {
    status: 'found',
    assetCode: '1-3-2',
    entityId: 'entity_locator',
    slot: { row: 1, column: 3, layer: 2 },
  });
});

test('空查询和超长查询仍走模型校验返回 invalid', () => {
  const scene = sceneWith(
    locatorEntity('entity_locator', { assetId: 'LOC', rowNumber: 1, startColumn: 1, startLayer: 1, columns: 4, layers: 3 }),
  );
  assert.deepEqual(lookup(scene, '   '), { status: 'invalid', assetCode: '' });
  assert.deepEqual(lookup(scene, '1'.repeat(129)), { status: 'invalid', assetCode: '1'.repeat(129) });
});

test('虚拟货格资产编号优先于同形排-列-层，保留前导零', () => {
  const scene = sceneWith(
    locatorEntity('entity_numbered', { assetId: '01-05-03', rowNumber: 2, startColumn: 4, startLayer: 6, columns: 1, layers: 1 }),
    locatorEntity('entity_coordinate', { assetId: 'GRID-A', rowNumber: 1, startColumn: 1, startLayer: 1, columns: 10, layers: 5 }),
  );
  assert.deepEqual(lookup(scene, '01-05-03'), {
    status: 'found', assetCode: '01-05-03', entityId: 'entity_numbered',
    slot: { row: 2, column: 4, layer: 6 },
  });
  assert.deepEqual(lookup(scene, '1-5-3'), {
    status: 'found', assetCode: '1-5-3', entityId: 'entity_coordinate',
    slot: { row: 1, column: 5, layer: 3 },
  });
});

test('虚拟货格资产编号 trim 后精确匹配，保留大小写和前导零', () => {
  const scene = sceneWith(
    locatorEntity('entity_numbered', { assetId: '  Slot-001  ', rowNumber: 2, startColumn: 4, startLayer: 6, columns: 2, layers: 1 }),
  );
  assert.deepEqual(lookup(scene, ' Slot-001 '), {
    status: 'found', assetCode: 'Slot-001', entityId: 'entity_numbered',
  });
  assert.deepEqual(lookup(scene, 'slot-001'), { status: 'not-found', assetCode: 'slot-001' });
  assert.deepEqual(lookup(scene, 'Slot-1'), { status: 'not-found', assetCode: 'Slot-1' });
});

test('资产编号命中的隐藏货格或重复货格不能回退到同形坐标', () => {
  const coordinateLocator = locatorEntity('entity_coordinate', {
    assetId: 'GRID-A', rowNumber: 1, startColumn: 1, startLayer: 1, columns: 10, layers: 5,
  });
  const hiddenLocator = locatorEntity('entity_hidden', {
    assetId: '1-5-3', rowNumber: 2, startColumn: 1, startLayer: 1, columns: 2, layers: 1,
  }, { visible: false });
  assert.deepEqual(lookup(sceneWith(hiddenLocator, coordinateLocator), '1-5-3'), {
    status: 'not-visible', assetCode: '1-5-3', entityId: 'entity_hidden',
  });
  const duplicateLocator = locatorEntity('entity_duplicate', {
    assetId: '1-5-3', rowNumber: 3, startColumn: 1, startLayer: 1, columns: 1, layers: 1,
  });
  assert.deepEqual(lookup(sceneWith(hiddenLocator, duplicateLocator, coordinateLocator), '1-5-3'), {
    status: 'ambiguous', assetCode: '1-5-3', entityIds: ['entity_hidden', 'entity_duplicate'],
  });
});

test('内置货格不同于宿主编号时按自身资产编号查找，并继承宿主隐藏状态', () => {
  for (const visible of [true, false]) {
    const scene = sceneWith(
      modelEntity('entity_shelf', 'SHELF-01', { visible }),
      locatorEntity('entity_builtin', {
        assetId: 'SLOT-001', rowNumber: 1, startColumn: 1, startLayer: 1, columns: 2, layers: 1,
      }, { hostEntityId: 'entity_shelf' }),
    );
    assert.deepEqual(lookup(scene, 'SLOT-001'), {
      status: visible ? 'found' : 'not-visible', assetCode: 'SLOT-001', entityId: 'entity_builtin',
    });
  }
});
