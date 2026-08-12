import assert from 'node:assert/strict';
import path from 'node:path';
import {
  Camera,
  FreeCamera,
  Matrix,
  MeshBuilder,
  NullEngine,
  Scene,
  TransformNode,
  Vector3,
} from '@babylonjs/core';
import { createServer } from 'vite';

const MODULE_LOAD_TIMEOUT_MS = 180_000;
const VIEWPORT_SIZE = 512;
const ORTHO_HALF_SIZE = 10;

/** 在限定时间内通过 Vite SSR 载入 SceneRuntime。 */
async function loadSceneRuntimeModule(server) {
  let timeoutId;
  try {
    return await Promise.race([
      server.ssrLoadModule('/src/runtime/babylon/SceneRuntime.ts'),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error('加载 SceneRuntime.ts 超时')), MODULE_LOAD_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

/** 创建与编辑器正视图等价的正交测试场景，避免透视误差干扰边界断言。 */
function createRuntimeFixture(SceneRuntime, name) {
  const engine = new NullEngine({ renderWidth: VIEWPORT_SIZE, renderHeight: VIEWPORT_SIZE });
  const scene = new Scene(engine);
  const camera = new FreeCamera(`${name}-camera`, new Vector3(0, 0, -20), scene);
  camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
  camera.orthoLeft = -ORTHO_HALF_SIZE;
  camera.orthoRight = ORTHO_HALF_SIZE;
  camera.orthoTop = ORTHO_HALF_SIZE;
  camera.orthoBottom = -ORTHO_HALF_SIZE;
  camera.setTarget(Vector3.Zero());
  scene.activeCamera = camera;
  const runtime = new SceneRuntime(scene);
  const canvas = {
    getBoundingClientRect: () => ({
      left: 0,
      top: 0,
      right: VIEWPORT_SIZE,
      bottom: VIEWPORT_SIZE,
      width: VIEWPORT_SIZE,
      height: VIEWPORT_SIZE,
    }),
  };
  return { engine, scene, runtime, canvas };
}

/** 把正交相机中的世界 XY 坐标换算为画布客户端坐标。 */
function toCanvasPoint(x, y) {
  return {
    x: ((x + ORTHO_HALF_SIZE) / (ORTHO_HALF_SIZE * 2)) * VIEWPORT_SIZE,
    y: ((ORTHO_HALF_SIZE - y) / (ORTHO_HALF_SIZE * 2)) * VIEWPORT_SIZE,
  };
}

/** 注册只包含拾取所需字段的导入模型运行时。 */
function registerModel(runtime, entityId, root, contentRoot, meshes, state = { visible: true, locked: false }) {
  runtime.models.set(entityId, {
    entitySnapshot: { id: entityId },
    root,
    contentRoot,
    meshes,
    modelArrayBatch: null,
    highlighted: false,
  });
  runtime.entityStates.set(entityId, state);
  runtime.syncedEntities.set(entityId, {
    id: entityId,
    name: entityId,
    isFolder: false,
    parentId: null,
    childrenIds: [],
    visible: true,
    locked: state.locked,
    components: {
      transform: {
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      },
      modelAsset: {},
    },
  });
}

/** 让场景 Mesh 具备编辑器模型实体元数据。 */
function markEntityMeshes(meshes, entityId) {
  for (const mesh of meshes) {
    mesh.metadata = { ...(mesh.metadata ?? {}), editorEntityId: entityId };
    mesh.isPickable = true;
  }
}

/** 断言指定位置没有真实三角面命中，确保用例确实覆盖扩大后的模型范围。 */
function assertNoExactGeometryHit(scene, point, message) {
  const hits = scene.multiPick(point.x, point.y, (mesh) => Boolean(mesh.metadata?.editorEntityId)) ?? [];
  assert.equal(hits.length, 0, message);
}

function disposeFixture(fixture) {
  fixture.scene.dispose();
  fixture.engine.dispose();
}

/** Shelf 层列由 thin instance 扩展后，货格中心应可选中，范围外必须保持不可选。 */
function verifyShelfLayerColumnPicking(SceneRuntime) {
  const fixture = createRuntimeFixture(SceneRuntime, 'shelf-layer-column');
  try {
    const root = new TransformNode('shelf-root', fixture.scene);
    const contentRoot = new TransformNode('shelf-content', fixture.scene);
    contentRoot.parent = root;

    const post = MeshBuilder.CreateBox('shelf-generated-post', { width: 0.12, height: 0.8, depth: 0.12 }, fixture.scene);
    post.parent = contentRoot;
    const matrices = new Float32Array(4 * 16);
    [
      new Vector3(-3, -2, 0),
      new Vector3(3, -2, 0),
      new Vector3(-3, 2, 0),
      new Vector3(3, 2, 0),
    ].forEach((offset, index) => Matrix.Translation(offset.x, offset.y, offset.z).copyToArray(matrices, index * 16));
    post.thinInstanceSetBuffer('matrix', matrices, 16, true);
    post.thinInstanceEnablePicking = true;
    post.thinInstanceRefreshBoundingInfo(true);
    markEntityMeshes([post], 'shelf-layer-column');
    registerModel(fixture.runtime, 'shelf-layer-column', root, contentRoot, [post]);
    fixture.scene.render();

    const center = toCanvasPoint(0, 0);
    assertNoExactGeometryHit(fixture.scene, center, 'Shelf 货格中心必须是无三角面的真实空隙');
    assert.equal(
      fixture.runtime.pickEntityIdAtCanvasPoint(center.x, center.y, fixture.canvas),
      'shelf-layer-column',
      'Shelf 设置层数和列数后，模型显示范围内的货格中心必须可选中',
    );

    const outside = toCanvasPoint(3.07, 0);
    assert.equal(
      fixture.runtime.pickEntityIdAtCanvasPoint(outside.x, outside.y, fixture.canvas),
      null,
      'Shelf 扩大拾取范围不得越过参数化模型当前可见边界',
    );
  } finally {
    disposeFixture(fixture);
  }
}

/** 多穿货架运行态生成节点即使不在初始 meshes 列表中，也必须参与整体显示范围拾取。 */
function verifyMultiwearingGeneratedPicking(SceneRuntime) {
  const fixture = createRuntimeFixture(SceneRuntime, 'multiwearing');
  try {
    const root = new TransformNode('multiwearing-root', fixture.scene);
    const contentRoot = new TransformNode('multiwearing-content', fixture.scene);
    contentRoot.parent = root;

    const leftRack = MeshBuilder.CreateBox('multiwearing-generated-left', { width: 0.2, height: 5, depth: 1.5 }, fixture.scene);
    const rightRack = MeshBuilder.CreateBox('multiwearing-generated-right', { width: 0.2, height: 5, depth: 1.5 }, fixture.scene);
    const hiddenSource = MeshBuilder.CreateBox('multiwearing-hidden-source', { size: 1 }, fixture.scene);
    leftRack.parent = contentRoot;
    rightRack.parent = contentRoot;
    hiddenSource.parent = contentRoot;
    leftRack.position.x = -4;
    rightRack.position.x = 4;
    hiddenSource.position.x = 8;
    hiddenSource.isVisible = false;
    markEntityMeshes([leftRack, rightRack, hiddenSource], 'multiwearing');
    // 参数脚本创建的当前子节点必须参与范围计算，已隐藏的源节点则不得扩大显示边界。
    registerModel(fixture.runtime, 'multiwearing', root, contentRoot, []);
    fixture.scene.render();

    const aisleCenter = toCanvasPoint(0, 0);
    assertNoExactGeometryHit(fixture.scene, aisleCenter, '多穿货架过道中心必须是无三角面的真实空隙');
    assert.equal(
      fixture.runtime.pickEntityIdAtCanvasPoint(aisleCenter.x, aisleCenter.y, fixture.canvas),
      'multiwearing',
      '多穿货架运行态生成件之间的模型显示区域必须可选中',
    );

    const outside = toCanvasPoint(4.11, 0);
    assert.equal(
      fixture.runtime.pickEntityIdAtCanvasPoint(outside.x, outside.y, fixture.canvas),
      null,
      '多穿货架扩大拾取范围不得越过最外侧可见结构',
    );
    const hiddenSourcePoint = toCanvasPoint(8, 0);
    assert.equal(
      fixture.runtime.pickEntityIdAtCanvasPoint(hiddenSourcePoint.x, hiddenSourcePoint.y, fixture.canvas),
      null,
      '参数脚本隐藏的源 Mesh 不得继续扩大模型拾取范围',
    );
  } finally {
    disposeFixture(fixture);
  }
}

/** 使用模型局部有向范围，避免旋转后退化为世界 AABB 而选中显示区域外的角落。 */
function verifyRotatedModelBounds(SceneRuntime) {
  const fixture = createRuntimeFixture(SceneRuntime, 'rotated-frame');
  try {
    const root = new TransformNode('rotated-frame-root', fixture.scene);
    root.rotation.z = Math.PI / 4;
    const contentRoot = new TransformNode('rotated-frame-content', fixture.scene);
    contentRoot.parent = root;

    const left = MeshBuilder.CreateBox('frame-left', { width: 0.1, height: 2, depth: 0.2 }, fixture.scene);
    const right = MeshBuilder.CreateBox('frame-right', { width: 0.1, height: 2, depth: 0.2 }, fixture.scene);
    const top = MeshBuilder.CreateBox('frame-top', { width: 6, height: 0.1, depth: 0.2 }, fixture.scene);
    const bottom = MeshBuilder.CreateBox('frame-bottom', { width: 6, height: 0.1, depth: 0.2 }, fixture.scene);
    for (const mesh of [left, right, top, bottom]) mesh.parent = contentRoot;
    left.position.x = -3;
    right.position.x = 3;
    top.position.y = 1;
    bottom.position.y = -1;
    markEntityMeshes([left, right, top, bottom], 'rotated-frame');
    registerModel(fixture.runtime, 'rotated-frame', root, contentRoot, [left, right, top, bottom]);
    fixture.scene.render();

    const center = toCanvasPoint(0, 0);
    assertNoExactGeometryHit(fixture.scene, center, '旋转框架中心必须是无三角面的真实空隙');
    assert.equal(
      fixture.runtime.pickEntityIdAtCanvasPoint(center.x, center.y, fixture.canvas),
      'rotated-frame',
      '旋转模型的局部显示范围内部必须可选中',
    );

    const worldAabbOnlyCorner = toCanvasPoint(2.7, 2.7);
    assert.equal(
      fixture.runtime.pickEntityIdAtCanvasPoint(worldAabbOnlyCorner.x, worldAabbOnlyCorner.y, fixture.canvas),
      null,
      '旋转模型不得使用放大的世界 AABB 命中模型显示区域外角落',
    );
  } finally {
    disposeFixture(fixture);
  }
}

/** 运行态只读拾取允许 locked 模型，同时普通编辑拾取继续遵守 authoring lock。 */
function verifyRuntimeLockedModelPicking(SceneRuntime) {
  const fixture = createRuntimeFixture(SceneRuntime, 'runtime-locked-model');
  try {
    const root = new TransformNode('runtime-locked-root', fixture.scene);
    const contentRoot = new TransformNode('runtime-locked-content', fixture.scene);
    contentRoot.parent = root;
    const box = MeshBuilder.CreateBox('runtime-locked-box', { size: 2 }, fixture.scene);
    box.parent = contentRoot;
    markEntityMeshes([box], 'runtime-locked-model');
    box.isPickable = false;
    registerModel(
      fixture.runtime,
      'runtime-locked-model',
      root,
      contentRoot,
      [box],
      { visible: true, locked: true },
    );
    fixture.scene.render();

    const center = toCanvasPoint(0, 0);
    assert.equal(
      fixture.runtime.pickEntityIdAtCanvasPoint(center.x, center.y, fixture.canvas),
      null,
      '普通编辑拾取必须继续拒绝 locked 模型',
    );
    assert.equal(
      fixture.runtime.pickRuntimeModelEntityIdAtCanvasPoint(center.x, center.y, fixture.canvas),
      'runtime-locked-model',
      '运行预览与 Viewer 的只读拾取必须允许 locked 模型',
    );
  } finally {
    disposeFixture(fixture);
  }
}
/** 真实可见几何命中优先，前方货架扩展范围不能抢走后方模型。 */
function verifyExactGeometryPriority(SceneRuntime) {
  const fixture = createRuntimeFixture(SceneRuntime, 'exact-priority');
  try {
    const shelfRoot = new TransformNode('priority-shelf-root', fixture.scene);
    const shelfContent = new TransformNode('priority-shelf-content', fixture.scene);
    shelfContent.parent = shelfRoot;
    const left = MeshBuilder.CreateBox('priority-left', { width: 0.1, height: 4, depth: 0.2 }, fixture.scene);
    const right = MeshBuilder.CreateBox('priority-right', { width: 0.1, height: 4, depth: 0.2 }, fixture.scene);
    left.parent = shelfContent;
    right.parent = shelfContent;
    left.position.x = -2;
    right.position.x = 2;
    markEntityMeshes([left, right], 'priority-shelf');
    registerModel(fixture.runtime, 'priority-shelf', shelfRoot, shelfContent, [left, right]);

    const behindRoot = new TransformNode('behind-root', fixture.scene);
    const behindContent = new TransformNode('behind-content', fixture.scene);
    behindContent.parent = behindRoot;
    behindRoot.position.z = 2;
    const behindBox = MeshBuilder.CreateBox('behind-box', { size: 1 }, fixture.scene);
    behindBox.parent = behindContent;
    markEntityMeshes([behindBox], 'behind-model');
    registerModel(fixture.runtime, 'behind-model', behindRoot, behindContent, [behindBox]);
    fixture.scene.render();

    const center = toCanvasPoint(0, 0);
    assert.equal(
      fixture.runtime.pickEntityIdAtCanvasPoint(center.x, center.y, fixture.canvas),
      'behind-model',
      '货架空隙后方存在真实可见模型时必须保持真实几何命中优先',
    );
  } finally {
    disposeFixture(fixture);
  }
}

let server;
try {
  server = await createServer({
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
  const { SceneRuntime } = await loadSceneRuntimeModule(server);

  verifyShelfLayerColumnPicking(SceneRuntime);
  verifyMultiwearingGeneratedPicking(SceneRuntime);
  verifyRotatedModelBounds(SceneRuntime);
  verifyRuntimeLockedModelPicking(SceneRuntime);
  verifyExactGeometryPriority(SceneRuntime);

  console.log('模型拾取范围 smoke 通过');
} finally {
  await server?.close();
}
