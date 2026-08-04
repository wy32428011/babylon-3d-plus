import assert from 'node:assert/strict';
import test from 'node:test';
import { stripCadReferencesFromSceneFile } from '../../electron/ipc/sceneCadReferenceSanitizer.ts';

test('数字孪生发布快照剔除 CAD 组件并保留同一实体的其它组件', () => {
  const sceneFile = {
    version: 3,
    scene: {
      entityIds: ['cad', 'model'],
      entities: {
        cad: {
          components: {
            transform: { position: { x: 0, y: 0, z: 0 } },
            cadReference: {
              sourcePath: 'C:\\missing\\layout.dxf',
              sourceUrl: 'editor-asset://local/C%3A%5Cmissing%5Clayout.dxf',
            },
          },
        },
        model: {
          components: {
            modelAsset: { sourcePath: 'D:\\assets\\model.glb' },
          },
        },
      },
    },
  };

  const removedCount = stripCadReferencesFromSceneFile(sceneFile);

  assert.equal(removedCount, 1);
  assert.deepEqual(sceneFile.scene.entityIds, ['cad', 'model']);
  assert.deepEqual(sceneFile.scene.entities.cad.components, {
    transform: { position: { x: 0, y: 0, z: 0 } },
  });
  assert.deepEqual(sceneFile.scene.entities.model.components.modelAsset, {
    sourcePath: 'D:\\assets\\model.glb',
  });
});

test('数字孪生发布快照会剔除全部 CAD 组件', () => {
  const sceneFile = {
    version: 3,
    scene: {
      entities: {
        first: { components: { cadReference: { sourcePath: 'C:\\missing\\first.dxf' } } },
        second: { components: { cadReference: { sourcePath: 'C:\\missing\\second.dxf' } } },
      },
    },
  };

  assert.equal(stripCadReferencesFromSceneFile(sceneFile), 2);
  assert.deepEqual(sceneFile.scene.entities.first.components, {});
  assert.deepEqual(sceneFile.scene.entities.second.components, {});
});

test('没有 CAD 组件的场景保持不变', () => {
  const sceneFile = { version: 3, scene: { entities: {} } };
  const snapshot = JSON.stringify(sceneFile);

  assert.equal(stripCadReferencesFromSceneFile(sceneFile), 0);
  assert.equal(JSON.stringify(sceneFile), snapshot);
});
