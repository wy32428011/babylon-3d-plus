import assert from 'node:assert/strict';
import path from 'node:path';
import {
  Color3,
  FreeCamera,
  Matrix,
  MeshBuilder,
  NullEngine,
  Scene,
  StandardMaterial,
  Vector3,
} from '@babylonjs/core';
import { createServer } from 'vite';
import {
  clearSceneSelectionHighlight,
  createSceneSelectionHighlightLayer,
  SCENE_SELECTION_GLOW_BLUR_PIXELS,
  SCENE_SELECTION_GLOW_COLOR_HEX,
  setSceneSelectionHighlightGroups,
} from '../src/runtime/babylon/sceneSelectionHighlight.ts';

const engine = new NullEngine({ renderWidth: 320, renderHeight: 180 });
const scene = new Scene(engine);
const camera = new FreeCamera('camera', new Vector3(0, 0, -6), scene);
camera.setTarget(Vector3.Zero());
scene.activeCamera = camera;

const material = new StandardMaterial('selection-highlight-material', scene);
const leftPart = MeshBuilder.CreateBox('selection-left', { width: 1, height: 1.5, depth: 1 }, scene);
leftPart.position.x = -0.5;
leftPart.material = material;
const rightPart = MeshBuilder.CreateBox('selection-right', { width: 1, height: 1.5, depth: 1 }, scene);
rightPart.position.x = 0.5;
rightPart.material = material;
const logicalModelGroup = [leftPart, rightPart];

const thinInstanceSource = MeshBuilder.CreateBox('selection-thin-source', { size: 0.5 }, scene);
thinInstanceSource.material = material;
thinInstanceSource.thinInstanceSetBuffer('matrix', new Float32Array([
  ...Matrix.Translation(-1.5, 0, 0).toArray(),
  ...Matrix.Translation(1.5, 0, 0).toArray(),
]), 16, false);

const fallbackLogs = [];
const highlightLayer = createSceneSelectionHighlightLayer(scene, undefined, (message) => fallbackLogs.push(message));

try {
  setSceneSelectionHighlightGroups(highlightLayer, [logicalModelGroup, [thinInstanceSource]]);
  thinInstanceSource.thinInstanceSetBuffer('instanceSelectionId', new Float32Array([2, 0]), 1, false);

  const readinessDeadline = Date.now() + 2_000;
  while (!highlightLayer.isLayerReady()) {
    if (Date.now() >= readinessDeadline) break;
    scene.render();
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  assert.equal(SCENE_SELECTION_GLOW_COLOR_HEX, '#8B0000');
  assert.equal(SCENE_SELECTION_GLOW_BLUR_PIXELS, 5);
  assert.equal(highlightLayer.color.toHexString(), SCENE_SELECTION_GLOW_COLOR_HEX);
  assert.equal(highlightLayer.blurPixels, SCENE_SELECTION_GLOW_BLUR_PIXELS);
  assert.equal(highlightLayer.useDepthOcclusion, true);
  assert.equal(highlightLayer.isLayerReady(), true, '选择光晕着色器必须在 Babylon 渲染循环中成功编译');
  assert.deepEqual(fallbackLogs, [], '正常环境不得触发光晕降级日志');
  assert.equal(highlightLayer.hasMesh(leftPart), true);
  assert.equal(highlightLayer.hasMesh(rightPart), true);
  assert.equal(highlightLayer.hasMesh(thinInstanceSource), true);
  assert.deepEqual(
    [...(thinInstanceSource._userThinInstanceBuffersStorage?.data?.instanceSelectionId ?? [])],
    [2, 0],
    '光晕合成必须允许 SceneRuntime 恢复 thinInstance 权威选择缓冲',
  );

  clearSceneSelectionHighlight(highlightLayer, scene);
  scene.render();
  assert.equal(highlightLayer.shouldRender(), false);

  console.log(JSON.stringify({
    ok: true,
    glowColor: SCENE_SELECTION_GLOW_COLOR_HEX,
    glowPixels: SCENE_SELECTION_GLOW_BLUR_PIXELS,
    logicalGroupMeshCount: logicalModelGroup.length,
    depthOcclusion: true,
  }, null, 2));
} finally {
  highlightLayer.dispose();
  scene.dispose();
  engine.dispose();
}

let viteServer;
try {
  viteServer = await createServer({
    configFile: false,
    root: process.cwd(),
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true },
    resolve: {
      alias: {
        '@linkiez/dxf-renew': path.join(process.cwd(), 'scripts', 'smoke-stubs', 'dxf-renew.mjs'),
      },
    },
  });
  const { SceneRuntime } = await viteServer.ssrLoadModule('/src/runtime/babylon/SceneRuntime.ts');
  const runtimeEngine = new NullEngine({ renderWidth: 320, renderHeight: 180 });
  const runtimeScene = new Scene(runtimeEngine);
  runtimeScene.activeCamera = new FreeCamera('runtime-camera', new Vector3(0, 0, -6), runtimeScene);
  const runtime = new SceneRuntime(runtimeScene);
  const primitive = MeshBuilder.CreateBox('primitive-selection', {}, runtimeScene);
  const primitiveMaterial = new StandardMaterial('primitive-selection-material', runtimeScene);
  primitive.material = primitiveMaterial;
  const meshRenderer = { materialColor: '#24557A' };

  try {
    runtime.meshes.set('primitive-selection', primitive);
    runtime.selectedEntityIds = new Set(['primitive-selection']);
    runtime.applyPrimitiveMeshAppearance(primitive, meshRenderer, true);
    runtime.rebuildModelSelectionOutline();

    assert.equal(
      runtime.modelSelectionOutlineLayer.hasMesh(primitive),
      true,
      '基础 Mesh 也必须进入统一深红选择光晕层',
    );
    assert.equal(
      primitiveMaterial.diffuseColor.toHexString(),
      Color3.FromHexString(meshRenderer.materialColor).toHexString(),
      '选中基础 Mesh 不得改写原表面颜色',
    );
    assert.equal(
      primitiveMaterial.emissiveColor.toHexString(),
      Color3.Black().toHexString(),
      '选中基础 Mesh 不得额外修改表面自发光',
    );


    const skyboxRuntime = runtime.skyboxRuntime;
    const skyboxMesh = MeshBuilder.CreateSphere('selection-skybox', {}, runtimeScene);
    skyboxRuntime.syncSelectionHighlight(skyboxMesh, true);
    assert.equal(
      skyboxRuntime.selectionHighlightLayer.hasMesh(skyboxMesh),
      true,
      '球形天空盒必须复用统一深红选择光晕层',
    );
    assert.equal(
      skyboxRuntime.selectionHighlightLayer.color.toHexString(),
      SCENE_SELECTION_GLOW_COLOR_HEX,
    );
    skyboxRuntime.syncSelectionHighlight(skyboxMesh, false);
    assert.equal(skyboxRuntime.selectionHighlightLayer.shouldRender(), false);
    skyboxMesh.dispose();
  } finally {
    runtime.meshes.clear();
    runtime.dispose();
    primitive.dispose();
    runtimeScene.dispose();
    runtimeEngine.dispose();
  }
} finally {
  await viteServer?.close();
}
