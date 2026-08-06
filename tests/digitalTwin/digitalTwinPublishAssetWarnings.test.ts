import assert from 'node:assert/strict';
import test from 'node:test';

import { createDigitalTwinPublishAssetWarningView } from '../../src/editor/deployment/digitalTwinPublishAssetWarnings.ts';

test('无资产编号问题时不要求发布确认', () => {
  assert.deepEqual(createDigitalTwinPublishAssetWarningView({
    generatedAssetCodes: [],
    duplicateAssetCodes: [],
  }), {
    requiresConfirmation: false,
    generatedCount: 0,
    duplicateCount: 0,
    detailLines: [],
    truncatedCount: 0,
  });
});

test('默认编号和重复编号生成有限明细并要求非阻断确认', () => {
  const view = createDigitalTwinPublishAssetWarningView({
    generatedAssetCodes: [
      { entityId: 'entity_1', entityName: '堆垛机', assetCode: 'Stacker-12345678' },
      { entityId: 'entity_2', entityName: '输送机', assetCode: 'Conveyor-87654321' },
    ],
    duplicateAssetCodes: [
      { assetCode: 'DUP', entityIds: ['a', 'b'], entityNames: ['设备 A', '设备 B'] },
    ],
  }, 2);

  assert.equal(view.requiresConfirmation, true);
  assert.equal(view.generatedCount, 2);
  assert.equal(view.duplicateCount, 1);
  assert.deepEqual(view.detailLines, [
    '默认编号：堆垛机（Stacker-12345678）',
    '默认编号：输送机（Conveyor-87654321）',
  ]);
  assert.equal(view.truncatedCount, 1);
});

test('重复编号明细限制实体名称数量，避免单个重复组生成无界文本', () => {
  const entityNames = Array.from({ length: 8 }, (_, index) => `设备 ${index + 1}`);
  const view = createDigitalTwinPublishAssetWarningView({
    generatedAssetCodes: [],
    duplicateAssetCodes: [
      {
        assetCode: 'DUP-LARGE',
        entityIds: entityNames.map((_, index) => `entity_${index + 1}`),
        entityNames,
      },
    ],
  }, 1);

  assert.deepEqual(view.detailLines, [
    '重复编号：DUP-LARGE（设备 1、设备 2、设备 3、设备 4、设备 5 等 8 个实体）',
  ]);
  assert.doesNotMatch(view.detailLines[0], /设备 6/);
  assert.equal(view.truncatedCount, 0);
});
