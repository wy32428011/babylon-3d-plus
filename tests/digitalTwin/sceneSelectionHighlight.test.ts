import assert from 'node:assert/strict';
import test from 'node:test';
import { FreeCamera, MeshBuilder, NullEngine, Scene, ShaderStore, Vector3 } from '@babylonjs/core';

import {
  clearSceneSelectionHighlight,
  createSceneSelectionHighlightLayer,
  SCENE_SELECTION_GLOW_BLUR_PIXELS,
  SCENE_SELECTION_GLOW_COLOR_HEX,
  setSceneSelectionHighlightGroups,
} from '../../src/runtime/babylon/sceneSelectionHighlight.ts';

test('场景选择效果统一使用深红色、仅 5px 静态光晕和深度遮挡', () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const layer = createSceneSelectionHighlightLayer(scene);

  try {
    assert.equal(SCENE_SELECTION_GLOW_COLOR_HEX, '#8B0000');
    assert.equal(SCENE_SELECTION_GLOW_BLUR_PIXELS, 5);
    assert.equal(layer.color.toHexString(), SCENE_SELECTION_GLOW_COLOR_HEX);
    assert.equal(layer.blurPixels, SCENE_SELECTION_GLOW_BLUR_PIXELS);
    assert.equal(layer.useDepthOcclusion, true);
    assert.equal(layer.isAnimated, false);
    assert.equal(layer.affectsSurface, false);
  } finally {
    layer.dispose();
    scene.dispose();
    engine.dispose();
  }
});

test('场景选择效果按逻辑模型分组并在空选区释放深度渲染', () => {
  const calls: unknown[] = [];
  const layer = {
    setSelectionGroups: (groups: readonly (readonly unknown[])[]) => calls.push(groups),
    clearSelection: () => calls.push('clear'),
  };
  let disableDepthRendererCount = 0;
  const scene = {
    effectLayers: [],
    disableDepthRenderer: () => { disableDepthRendererCount += 1; },
  };
  const groups = [[{ id: 'mesh-a' }, { id: 'mesh-b' }], [{ id: 'mesh-c' }]] as const;

  setSceneSelectionHighlightGroups(layer as never, groups);
  assert.deepEqual(calls, [groups]);
  assert.equal(disableDepthRendererCount, 0);

  clearSceneSelectionHighlight(layer as never, scene as never);
  assert.deepEqual(calls, [groups, 'clear']);
  assert.equal(disableDepthRendererCount, 1);
});

test('多个选择层共享深度渲染器，最后一个选区清空后才释放', () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const modelMesh = MeshBuilder.CreateBox('model-selection', {}, scene);
  const skyboxMesh = MeshBuilder.CreateSphere('skybox-selection', {}, scene);
  const modelLayer = createSceneSelectionHighlightLayer(scene, 'model-selection-layer');
  const skyboxLayer = createSceneSelectionHighlightLayer(scene, 'skybox-selection-layer');
  const originalDisableDepthRenderer = scene.disableDepthRenderer.bind(scene);
  let disableDepthRendererCount = 0;
  scene.disableDepthRenderer = () => { disableDepthRendererCount += 1; };

  try {
    setSceneSelectionHighlightGroups(modelLayer, [[modelMesh]]);
    setSceneSelectionHighlightGroups(skyboxLayer, [[skyboxMesh]]);

    clearSceneSelectionHighlight(modelLayer, scene);
    assert.equal(disableDepthRendererCount, 0);

    clearSceneSelectionHighlight(skyboxLayer, scene);
    assert.equal(disableDepthRendererCount, 1);
  } finally {
    scene.disableDepthRenderer = originalDisableDepthRenderer;
    modelLayer.dispose();
    skyboxLayer.dispose();
    scene.dispose();
    engine.dispose();
  }
});

test('多部件逻辑模型共用同一个选择 ID，内部接缝不作为分组边界', () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const leftPart = MeshBuilder.CreateBox('logical-left', {}, scene);
  const rightPart = MeshBuilder.CreateBox('logical-right', {}, scene);
  const anotherModel = MeshBuilder.CreateBox('logical-other', {}, scene);
  const layer = createSceneSelectionHighlightLayer(scene);

  try {
    setSceneSelectionHighlightGroups(layer, [[leftPart, rightPart], [anotherModel]]);
    const selectionIds = (layer as unknown as {
      _thinEffectLayer: { _meshUniqueIdToSelectionId: number[] };
    })._thinEffectLayer._meshUniqueIdToSelectionId;
    assert.equal(selectionIds[leftPart.uniqueId], selectionIds[rightPart.uniqueId]);
    assert.notEqual(selectionIds[leftPart.uniqueId], selectionIds[anotherModel.uniqueId]);
  } finally {
    layer.dispose();
    scene.dispose();
    engine.dispose();
  }
});

test('场景选择效果只执行一次 5px 外侧光晕合成', async () => {
  const engine = new NullEngine({ renderWidth: 320, renderHeight: 180 });
  const scene = new Scene(engine);
  scene.activeCamera = new FreeCamera('selection-highlight-camera', new Vector3(0, 0, -4), scene);
  const layer = createSceneSelectionHighlightLayer(scene);
  const readinessDeadline = Date.now() + 2_000;

  try {
    while (!layer.isLayerReady() && Date.now() < readinessDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(layer.isLayerReady(), true);

    const originalDrawElementsType = engine.drawElementsType.bind(engine);
    let composeDrawCount = 0;
    engine.drawElementsType = (...args) => {
      composeDrawCount += 1;
      originalDrawElementsType(...args);
    };

    layer.render();
    assert.equal(composeDrawCount, 1, '选中效果只应绘制一次外侧光晕，不再叠加实线主描边');

    const mergeEffects = (layer as unknown as {
      _thinEffectLayer: { _mergeDrawWrapper: Array<{ effect: { _fragmentSourceCode?: string } }> };
    })._thinEffectLayer._mergeDrawWrapper;
    assert.equal(mergeEffects.length, 1, 'ThinSelectionOutlineLayer 只应保留一个光晕合成 pass');
    assert.equal(
      mergeEffects.every(({ effect }) => effect._fragmentSourceCode?.includes('fragment:sceneSelectionHighlight')),
      true,
      '唯一合成 pass 必须使用带深度遮挡的深红光晕 Shader',
    );
    const glslSource = ShaderStore.ShadersStore['sceneSelectionHighlightPixelShader'] ?? '';
    const wgslSource = ShaderStore.ShadersStoreWGSL['sceneSelectionHighlightPixelShader'] ?? '';
    for (const shaderSource of [glslSource, wgslSource]) {
      assert.equal(shaderSource.includes('outlineThickness'), false, '正常 Shader 不得再包含主描边宽度');
      assert.equal(shaderSource.includes('selectionPass'), false, '正常 Shader 不得再包含主描边/光晕双 pass 分支');
    }
  } finally {
    layer.dispose();
    scene.dispose();
    engine.dispose();
  }
});

test('光晕 Shader 失败时降级为单次深红细描边并只记录一次诊断', async () => {
  const engine = new NullEngine({ renderWidth: 320, renderHeight: 180 });
  const scene = new Scene(engine);
  scene.activeCamera = new FreeCamera('selection-fallback-camera', new Vector3(0, 0, -4), scene);
  const mesh = MeshBuilder.CreateBox('selection-fallback-mesh', {}, scene);
  const fallbackLogs: string[] = [];
  const layer = createSceneSelectionHighlightLayer(scene, 'selection-fallback-layer', (message) => {
    fallbackLogs.push(message);
  });
  const internalLayer = layer as unknown as {
    activateBuiltInOutlineFallback: (message: string) => void;
    _thinEffectLayer: {
      _mergeDrawWrapper: Array<{ effect: { _fragmentSourceCode?: string } }>;
    };
  };
  const readinessDeadline = Date.now() + 2_000;

  try {
    setSceneSelectionHighlightGroups(layer, [[mesh]]);
    internalLayer.activateBuiltInOutlineFallback('fallback-diagnostic');
    internalLayer.activateBuiltInOutlineFallback('duplicate-diagnostic');

    while (!layer.isLayerReady() && Date.now() < readinessDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(layer.isLayerReady(), true);
    assert.deepEqual(fallbackLogs, ['fallback-diagnostic']);
    assert.equal(layer.outlineColor.toHexString(), SCENE_SELECTION_GLOW_COLOR_HEX);
    assert.equal(layer.outlineThickness, 1);

    const originalDrawElementsType = engine.drawElementsType.bind(engine);
    let composeDrawCount = 0;
    engine.drawElementsType = (...args) => {
      composeDrawCount += 1;
      originalDrawElementsType(...args);
    };

    layer.render();
    assert.equal(composeDrawCount, 1);
    assert.equal(internalLayer._thinEffectLayer._mergeDrawWrapper.length, 1);
    assert.equal(
      internalLayer._thinEffectLayer._mergeDrawWrapper[0]?.effect._fragmentSourceCode?.includes('fragment:selectionOutline'),
      true,
    );
  } finally {
    layer.dispose();
    scene.dispose();
    engine.dispose();
  }
});
