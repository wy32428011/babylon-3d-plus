import assert from 'node:assert/strict';
import test from 'node:test';
import { removeOptionalEditorOnlyUrls } from '../../electron/ipc/deploymentSceneSanitizer.ts';

test('部署场景清理所有编辑器专用缩略图', () => {
  const sceneFile = {
    scene: {
      sceneSettings: {
        environment: { thumbnailUrl: 'editor-only-environment-thumbnail' },
      },
      entities: {
        model: {
          components: {
            modelGenerator: {
              defaultTarget: { thumbnailUrl: 'editor-only-model-thumbnail' },
            },
          },
        },
      },
    },
  };

  removeOptionalEditorOnlyUrls(sceneFile);

  assert.equal('thumbnailUrl' in sceneFile.scene.sceneSettings.environment, false);
  assert.equal('thumbnailUrl' in sceneFile.scene.entities.model.components.modelGenerator.defaultTarget, false);
});

test('部署场景清理会递归处理数组中的编辑器缩略图', () => {
  const sceneFile = {
    assets: [
      { thumbnailUrl: 'editor-only-1' },
      { thumbnailUrl: 'editor-only-2' },
    ],
  };

  removeOptionalEditorOnlyUrls(sceneFile);

  assert.deepEqual(sceneFile, { assets: [{}, {}] });
});
