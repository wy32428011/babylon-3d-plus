import assert from 'node:assert/strict';
import test from 'node:test';
import { stripCadReferencesFromSceneFile } from '../../electron/ipc/sceneCadReferenceSanitizer.ts';
import { getSceneLightingBakeSignature } from '../../electron/shared/sceneLightingBakeContract.ts';
import { normalizeSceneAppearanceConfig, normalizeSceneLightingConfig } from '../../electron/shared/sceneLightingConfig.ts';

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

test('仅移除CAD参考时迁移有效GI签名，混合真实模型的CAD实体不重新签名', () => {
  const create = () => {
    const scene: any = { entities: { cad: { components: { transform: { x: 1 }, cadReference: { sourcePath: 'layout.dxf' } } },
      model: { components: { meshRenderer: { meshKind: 'cube' } } } }, sceneSettings: {
      lighting: normalizeSceneLightingConfig({ version: 2 }), appearance: normalizeSceneAppearanceConfig({}) } };
    scene.sceneSettings.lighting.result = { version: 1, signature: getSceneLightingBakeSignature(scene), createdAt: '2026-10-20T00:00:00Z', engineVersion: 'test',
      assets: [{ id: 'g', kind: 'geometry', url: 'Assets/LightingBakes/job/g.json', byteLength: 1 },
        { id: 'l', kind: 'lightmap', url: 'Assets/LightingBakes/job/l.png', byteLength: 1 },
        { id: 'p', kind: 'probes', url: 'Assets/LightingBakes/job/p.json', byteLength: 1 }],
      surfaces: [{ key: 'model/root', entityId: 'model', nodeKey: 'root', geometryAssetId: 'g', lightmapAssetId: 'l' }], probeAssetId: 'p',
      statistics: { meshCount: 1, triangleCount: 1, atlasCount: 1, probeCount: 1, textureBytes: 1, durationMs: 1 } };
    return { version: 5, scene };
  };
  const reference = create();
  stripCadReferencesFromSceneFile(reference);
  assert.equal(reference.scene.sceneSettings.lighting.result.signature, getSceneLightingBakeSignature(reference.scene));
  const mixed = create();
  mixed.scene.entities.cad.components.meshRenderer = { meshKind: 'cube' };
  mixed.scene.sceneSettings.lighting.result.signature = getSceneLightingBakeSignature(mixed.scene);
  const before = mixed.scene.sceneSettings.lighting.result.signature;
  stripCadReferencesFromSceneFile(mixed);
  assert.equal(mixed.scene.sceneSettings.lighting.result.signature, before);
  assert.notEqual(before, getSceneLightingBakeSignature(mixed.scene));
});
