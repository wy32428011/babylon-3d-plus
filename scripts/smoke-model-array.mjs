import assert from 'node:assert/strict';
import {
  Color3,
  Matrix,
  MeshBuilder,
  NullEngine,
  ParticleSystem,
  Scene,
  StandardMaterial,
  TransformNode,
  Vector3,
} from '@babylonjs/core';
import { createServer } from 'vite';

const SSR_MODULE_LOAD_TIMEOUT_MS = 60_000;
const SOURCE_ENTITY_ID = 'model-array-source';

/** 在限定时间内加载 SceneRuntime，避免 Vite SSR 异常时 smoke 无限等待。 */
async function loadSceneRuntimeModule(server) {
  let timeoutId;
  try {
    return await Promise.race([
      server.ssrLoadModule('/src/runtime/babylon/SceneRuntime.ts'),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`Vite SSR 模型阵列模块加载超时（${SSR_MODULE_LOAD_TIMEOUT_MS}ms）。`));
        }, SSR_MODULE_LOAD_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

/** 比较 Babylon 浮点结果。 */
function assertClose(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) <= 1e-6, `${message}: ${actual} !== ${expected}`);
}

/** 比较节点位置。 */
function assertPosition(node, expected, message) {
  const position = node.position ?? node;
  assertClose(position.x, expected.x, `${message} X`);
  assertClose(position.y, expected.y, `${message} Y`);
  assertClose(position.z, expected.z, `${message} Z`);
}

/** 比较两个 Babylon 矩阵的全部元素。 */
function assertMatrixClose(actual, expected, message) {
  for (let index = 0; index < 16; index += 1) {
    assertClose(actual.m[index], expected.m[index], `${message} [${index}]`);
  }
}

/** 按 Babylon 的材质绑定规则计算 Mesh 当前有效正反面方向。 */
function readEffectiveSideOrientation(mesh) {
  const materialOrientation = mesh.material?.sideOrientation;
  let orientation = materialOrientation ?? mesh.sideOrientation;
  mesh.computeWorldMatrix(true);
  if (mesh.getWorldMatrix().determinant() < 0) orientation = orientation === 0 ? 1 : 0;
  return orientation;
}

/** 读取当前临时克隆池；非模型实体继续沿用节点克隆预览。 */
function readPreviewClones(runtime) {
  return runtime.entityArrayPreview?.clones ?? [];
}

/** 读取普通模型阵列的矩阵批次 Mesh。 */
function readPreviewMatrixMeshes(runtime) {
  return runtime.entityArrayPreview?.matrixPreview?.meshes ?? [];
}

/** 读取批次 Mesh 当前有效 thinInstance 的世界位置。 */
function readThinInstancePositions(mesh) {
  return mesh.thinInstanceGetWorldMatrices()
    .slice(0, mesh.thinInstanceCount)
    .map((matrix) => matrix.getTranslation());
}

/** 读取预览根节点自身及后代中的全部 Mesh，兼容内置 Mesh 直接作为克隆根节点。 */
function readPreviewMeshes(root) {
  const descendants = root.getChildMeshes(false);
  return typeof root.getTotalVertices === 'function' && root.getTotalVertices() > 0
    ? [root, ...descendants]
    : descendants;
}

let server;
let engine;
let scene;
let runtime;
let gizmoController;
let editorStore;
let editorStoreSnapshot;

try {
  server = await createServer({
    configFile: false,
    root: process.cwd(),
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true },
    // dxf-renew 的 ESM 发布物省略了相对导入扩展名，交给 Vite 转换后再加载 SceneRuntime。
    ssr: { noExternal: ['@linkiez/dxf-renew'] },
  });

  const { SceneRuntime } = await loadSceneRuntimeModule(server);
  const { EntityArrayThinInstanceBatch } = await server.ssrLoadModule(
    '/src/runtime/babylon/EntityArrayThinInstanceBatch.ts',
  );
  const { TransformGizmoController } = await server.ssrLoadModule(
    '/src/runtime/babylon/TransformGizmoController.ts',
  );
  const { useEditorStore } = await server.ssrLoadModule('/src/editor/store/editorStore.ts');
  const { isShiftEntityArraySupported } = await server.ssrLoadModule('/src/editor/model/modelArray.ts');
  const { deserializeScene, serializeScene } = await server.ssrLoadModule('/src/editor/project/SceneSerializer.ts');
  const {
    createCadReferenceEntity,
    createEmptySceneDocument,
    createFolderEntity,
    createLightEntity,
    createLocatorEntity,
    createMeshEntity,
    createModelEntity,
    createModelGeneratorEntity,
    createPoiEffectEntity,
  } = await server.ssrLoadModule('/src/editor/model/SceneDocument.ts');
  editorStore = useEditorStore;
  editorStoreSnapshot = useEditorStore.getState();
  engine = new NullEngine();
  scene = new Scene(engine);
  runtime = new SceneRuntime(scene);

  const root = new TransformNode('source-root', scene);
  root.position.copyFromFloats(10, 2, -5);
  root.rotation.y = Math.PI / 2;
  root.scaling.copyFromFloats(2, 3, 4);
  root.metadata = { editorEntityId: SOURCE_ENTITY_ID, keepSource: true };

  const contentRoot = new TransformNode('source-content', scene);
  contentRoot.parent = root;
  contentRoot.metadata = { editorEntityId: SOURCE_ENTITY_ID };

  const sourceMesh = MeshBuilder.CreateBox(
    'source-box',
    { width: 2, height: 4, depth: 6 },
    scene,
  );
  sourceMesh.parent = contentRoot;
  sourceMesh.isPickable = true;
  sourceMesh.metadata = { editorEntityId: SOURCE_ENTITY_ID, keepSource: true };
  const sourceMaterial = new StandardMaterial('source-material', scene);
  sourceMaterial.diffuseColor = new Color3(0.2, 0.5, 0.8);
  sourceMesh.material = sourceMaterial;
  const sourceGeometry = sourceMesh.geometry;

  root.computeWorldMatrix(true);
  contentRoot.computeWorldMatrix(true);
  sourceMesh.computeWorldMatrix(true);

  // 这些方法只依赖普通模型条目的根节点、内容根、加载句柄与测量就绪标记。
  runtime.models.set(SOURCE_ENTITY_ID, {
    root,
    contentRoot,
    assetHandle: {
      kind: 'shared-instance',
      animationGroups: [],
      dispose: () => undefined,
    },
    meshes: [sourceMesh],
    modelArrayBatch: null,
    modelArraySourceSignature: '',
    modelArrayFailureSignature: '',
    highlighted: false,
    highlightedMeshes: new Set(),
    measurementReady: true,
  });

  const worldXGeometry = runtime.getEntityArrayGeometry(SOURCE_ENTITY_ID, { x: 1, y: 0, z: 0 });
  assert.ok(worldXGeometry, '旋转、非均匀缩放模型必须能测量世界 X 投影跨度');
  assertClose(worldXGeometry.spanMeters, 24, '世界 X 应投影到缩放后的模型 Z 尺寸');

  const localXDirection = root.getDirection(Vector3.Right()).normalize();
  const localXGeometry = runtime.getEntityArrayGeometry(SOURCE_ENTITY_ID, localXDirection);
  assert.ok(localXGeometry, '必须能沿模型局部 X 的世界方向测量跨度');
  assertClose(localXGeometry.spanMeters, 4, '局部 X 跨度必须包含非均匀缩放');
  assert.equal(
    runtime.getEntityArrayGeometry(SOURCE_ENTITY_ID, { x: 0, y: 0, z: 0 }),
    null,
    '零方向必须被拒绝',
  );

  assert.equal(
    runtime.updateEntityArrayPreview(SOURCE_ENTITY_ID, { x: 1, y: 0, z: 0 }, 3, 0),
    true,
    '必须创建零间距临时阵列',
  );
  const firstMatrixMeshes = [...readPreviewMatrixMeshes(runtime)];
  assert.equal(readPreviewClones(runtime).length, 0, '共享模型预览不得按副本递归克隆节点树');
  assert.equal(firstMatrixMeshes.length, 1, '单 Mesh 模型只应创建一个矩阵批次 Mesh');
  assert.equal(firstMatrixMeshes[0].thinInstanceCount, 3, '矩阵批次实例数应等于新增副本数');
  const firstMatrixPositions = readThinInstancePositions(firstMatrixMeshes[0]);
  assertPosition(firstMatrixPositions[0], { x: 34, y: 2, z: -5 }, '零间距第一个矩阵副本');
  assertPosition(firstMatrixPositions[1], { x: 58, y: 2, z: -5 }, '零间距第二个矩阵副本');
  assertPosition(firstMatrixPositions[2], { x: 82, y: 2, z: -5 }, '零间距第三个矩阵副本');
  assert.notEqual(firstMatrixMeshes[0].geometry, sourceGeometry, '矩阵批次必须隔离 Geometry，避免共享 world0-world3 缓冲互相覆盖');
  assert.equal(firstMatrixMeshes[0].getTotalVertices(), sourceMesh.getTotalVertices(), '隔离 Geometry 后必须保留全部顶点');
  assert.equal(firstMatrixMeshes[0].material, sourceMaterial, '矩阵批次应共享源模型材质');
  assert.equal(firstMatrixMeshes[0].isPickable, false, '矩阵批次不得参与拾取');
  assert.equal(firstMatrixMeshes[0].metadata, null, '矩阵批次不得保留实体 metadata');

  const firstMatrixBuffer = runtime.entityArrayPreview?.matrixPreview?.batches?.[0]?.matrixBuffer;
  assert.equal(
    runtime.updateEntityArrayPreview(SOURCE_ENTITY_ID, { x: 1, y: 0, z: 0 }, 3, 2),
    true,
    '副本数量不变时必须原位更新净间距矩阵',
  );
  assert.equal(runtime.entityArrayPreview?.matrixPreview?.meshes?.[0], firstMatrixMeshes[0], '净间距变化必须复用矩阵批次 Mesh');
  const updatedMatrixBuffer = runtime.entityArrayPreview?.matrixPreview?.batches?.[0]?.matrixBuffer;
  assert.equal(updatedMatrixBuffer, firstMatrixBuffer, '副本数量不变时必须复用 Float32Array 矩阵缓冲');
  assertClose(updatedMatrixBuffer[12], 36, '2 米净间距第一个矩阵副本 X');
  assertClose(updatedMatrixBuffer[28], 62, '2 米净间距第二个矩阵副本 X');
  assertClose(updatedMatrixBuffer[44], 88, '2 米净间距第三个矩阵副本 X');

  assert.equal(
    runtime.updateEntityArrayPreview(SOURCE_ENTITY_ID, { x: 1, y: 0, z: 0 }, 1, 2),
    true,
    '修改数量和间距必须更新矩阵预览',
  );
  const reducedMatrixMeshes = [...readPreviewMatrixMeshes(runtime)];
  assert.equal(reducedMatrixMeshes.length, 1, '减少数量不得重建矩阵批次数量');
  assert.equal(reducedMatrixMeshes[0], firstMatrixMeshes[0], '减少数量必须复用矩阵批次 Mesh');
  assert.equal(reducedMatrixMeshes[0].thinInstanceCount, 1, '减少数量必须收缩有效矩阵实例数');
  assertPosition(
    readThinInstancePositions(reducedMatrixMeshes[0])[0],
    { x: 36, y: 2, z: -5 },
    '2 米净间距第一个矩阵副本',
  );

  assert.equal(
    runtime.updateEntityArrayPreview(SOURCE_ENTITY_ID, { x: -1, y: 0, z: 0 }, 2, 2),
    true,
    '负方向必须复用矩阵批次并更新排列',
  );
  const negativeMatrixMeshes = [...readPreviewMatrixMeshes(runtime)];
  assert.equal(negativeMatrixMeshes[0], reducedMatrixMeshes[0], '方向变化不应重建矩阵批次 Mesh');
  assert.equal(negativeMatrixMeshes[0].thinInstanceCount, 2, '增加数量必须补足有效矩阵实例');
  const negativeMatrixPositions = readThinInstancePositions(negativeMatrixMeshes[0]);
  assertPosition(negativeMatrixPositions[0], { x: -16, y: 2, z: -5 }, '负方向第一个矩阵副本');
  assertPosition(negativeMatrixPositions[1], { x: -42, y: 2, z: -5 }, '负方向第二个矩阵副本');

  runtime.clearEntityArrayPreview();
  assert.equal(readPreviewMatrixMeshes(runtime).length, 0, '清理后不得保留矩阵批次');
  assert.ok(negativeMatrixMeshes.every((mesh) => mesh.isDisposed()), '清理必须释放全部矩阵批次 Mesh');
  assert.equal(root.isDisposed(), false, '清理不得释放源模型根节点');
  assert.equal(sourceMesh.isDisposed(), false, '清理不得释放源模型网格');
  assert.equal(sourceMesh.geometry, sourceGeometry, '清理不得释放源模型共享几何');
  assert.equal(sourceMesh.material, sourceMaterial, '清理不得释放源模型共享材质');
  assert.equal(sourceMesh.isPickable, true, '清理不得修改源模型拾取能力');
  assert.deepEqual(
    sourceMesh.metadata,
    { editorEntityId: SOURCE_ENTITY_ID, keepSource: true },
    '清理不得修改源模型 metadata',
  );

  const sourceModelRuntime = runtime.models.get(SOURCE_ENTITY_ID);
  sourceModelRuntime.assetHandle.kind = 'owned-container';
  assert.equal(
    runtime.updateEntityArrayPreview(SOURCE_ENTITY_ID, { x: 1, y: 0, z: 0 }, 1, 0),
    true,
    '带脚本或独占材质的模型预览也必须使用最终视觉快照矩阵',
  );
  assert.equal(readPreviewMatrixMeshes(runtime).length, 1, '所有模型预览都必须使用固定矩阵批次');
  assert.equal(readPreviewClones(runtime).length, 0, '独占模型不得退回逐副本节点克隆');
  runtime.clearEntityArrayPreview();
  sourceModelRuntime.assetHandle.kind = 'shared-instance';

  // 源模型自身已使用 thinInstance 时，阵列矩阵必须展开组合而不是退回节点克隆。
  const nestedThinMatrices = [Matrix.Identity(), Matrix.Translation(1, 0, 0)];
  const nestedThinBuffer = new Float32Array(nestedThinMatrices.length * 16);
  nestedThinMatrices.forEach((matrix, index) => matrix.copyToArray(nestedThinBuffer, index * 16));
  sourceMesh.thinInstanceSetBuffer('matrix', nestedThinBuffer, 16, true);
  sourceMesh.thinInstanceRefreshBoundingInfo(true);
  const nestedGeometry = runtime.getEntityArrayGeometry(SOURCE_ENTITY_ID, { x: 1, y: 0, z: 0 });
  assert.ok(nestedGeometry, '已有 thinInstance 的模型必须仍可计算阵列跨度');
  assert.equal(
    runtime.updateEntityArrayPreview(SOURCE_ENTITY_ID, { x: 1, y: 0, z: 0 }, 2, 0),
    true,
    '已有 thinInstance 的模型必须使用组合矩阵创建阵列预览',
  );
  const nestedPreviewMesh = readPreviewMatrixMeshes(runtime)[0];
  assert.equal(readPreviewClones(runtime).length, 0, '已有 thinInstance 的模型不得退回递归克隆');
  assert.equal(nestedPreviewMesh.thinInstanceCount, 4, '两个源矩阵乘两个阵列副本应生成四个组合矩阵');
  const sourceWorldMatrix = sourceMesh.getWorldMatrix().clone();
  const expectedNestedBaseMatrices = nestedThinMatrices.map((matrix) => matrix.multiply(sourceWorldMatrix));
  const nestedPreviewPositions = readThinInstancePositions(nestedPreviewMesh);
  for (let copyIndex = 1; copyIndex <= 2; copyIndex += 1) {
    for (let sourceIndex = 0; sourceIndex < expectedNestedBaseMatrices.length; sourceIndex += 1) {
      const expectedBase = expectedNestedBaseMatrices[sourceIndex].getTranslation();
      const expectedOffset = nestedGeometry.spanMeters * copyIndex;
      assertPosition(
        nestedPreviewPositions[(copyIndex - 1) * expectedNestedBaseMatrices.length + sourceIndex],
        { x: expectedBase.x + expectedOffset, y: expectedBase.y, z: expectedBase.z },
        `组合矩阵副本 ${copyIndex}-${sourceIndex + 1}`,
      );
    }
  }
  runtime.clearEntityArrayPreview();
  sourceMesh.thinInstanceSetBuffer('matrix', null);
  sourceMesh.refreshBoundingInfo();

  // Babylon 的 thinInstance world0-world3 缓冲属于 Geometry；同几何克隆必须隔离，否则后写矩阵会覆盖前一批次。
  const sharedGeometrySource = MeshBuilder.CreateBox('entity-array-shared-geometry-source', { size: 1 }, scene);
  sharedGeometrySource.position.x = -2;
  const sharedGeometryClone = sharedGeometrySource.clone('entity-array-shared-geometry-clone', null, true);
  sharedGeometryClone.position.x = 4;
  sharedGeometrySource.computeWorldMatrix(true);
  sharedGeometryClone.computeWorldMatrix(true);
  const sharedSourceGeometry = sharedGeometrySource.geometry;
  const sharedGeometryBatch = EntityArrayThinInstanceBatch.create(
    'shared-geometry-source',
    [sharedGeometrySource, sharedGeometryClone],
  );
  assert.ok(sharedGeometryBatch, '同 Geometry 的多个源 Mesh 必须可以创建独立矩阵批次');
  assert.equal(sharedGeometryBatch.updateOffsets([{ x: 10, y: 0, z: 0 }]), true, '同 Geometry 批次必须一次写入全部矩阵');
  assert.equal(sharedGeometryBatch.meshes.length, 2, '不同源 Transform 必须保留两个逻辑批次');
  assert.notEqual(sharedGeometryBatch.meshes[0].geometry, sharedSourceGeometry, '首个批次不得污染源 Geometry 的 world 缓冲');
  assert.notEqual(sharedGeometryBatch.meshes[1].geometry, sharedSourceGeometry, '后续批次不得污染源 Geometry 的 world 缓冲');
  assert.notEqual(sharedGeometryBatch.meshes[0].geometry, sharedGeometryBatch.meshes[1].geometry, '同 Geometry 的不同矩阵批次必须隔离 world 缓冲');
  assert.equal(sharedGeometrySource.getVertexBuffer('world0') ?? null, null, '创建批次不得给源 Geometry 注入 thinInstance world 缓冲');
  assertPosition(readThinInstancePositions(sharedGeometryBatch.meshes[0])[0], { x: 8, y: 0, z: 0 }, '首个共享 Geometry 批次位置');
  assertPosition(readThinInstancePositions(sharedGeometryBatch.meshes[1])[0], { x: 14, y: 0, z: 0 }, '第二个共享 Geometry 批次位置');
  sharedGeometryBatch.dispose();
  assert.equal(sharedGeometrySource.geometry, sharedSourceGeometry, '释放批次后源 Geometry 必须保持有效');
  sharedGeometryClone.dispose(false, false);
  sharedGeometrySource.dispose(false, false);
  // GLB 左右手坐标转换会产生负 determinant：批次 Mesh 必须承载镜像，避免材质方向和双面光照改变。
  const mirroredMesh = MeshBuilder.CreateCylinder(
    'entity-array-mirrored-source',
    { height: 2, diameter: 1, tessellation: 12 },
    scene,
  );
  mirroredMesh.position.copyFromFloats(-3, 1, 2);
  mirroredMesh.scaling.copyFromFloats(-1, 2, 1);
  mirroredMesh.useVertexColors = false;
  mirroredMesh.hasVertexAlpha = true;
  const mirroredMaterial = new StandardMaterial('entity-array-mirrored-material', scene);
  mirroredMaterial.diffuseColor = new Color3(0.35, 0.55, 0.75);
  mirroredMaterial.backFaceCulling = false;
  mirroredMaterial.twoSidedLighting = true;
  mirroredMesh.material = mirroredMaterial;
  mirroredMaterial.sideOrientation = 0;
  mirroredMesh.computeWorldMatrix(true);
  const mirroredSourceWorld = mirroredMesh.getWorldMatrix().clone();
  const mirroredBatch = EntityArrayThinInstanceBatch.create('mirrored-source', [mirroredMesh]);
  assert.ok(mirroredBatch, '负 determinant 模型必须可以创建 thinInstance 批次');
  assert.equal(
    mirroredBatch.updateOffsets([{ x: 4, y: 0, z: 0 }]),
    true,
    '负 determinant 模型必须一次提交完整矩阵阵列',
  );
  const mirroredBatchMesh = mirroredBatch.meshes[0];
  const mirroredThinMatrix = mirroredBatchMesh.thinInstanceGetWorldMatrices()[0];
  mirroredBatchMesh.computeWorldMatrix(true);
  const mirroredFinalWorld = mirroredThinMatrix.multiply(mirroredBatchMesh.getWorldMatrix());
  const expectedMirroredWorld = mirroredSourceWorld.clone();
  expectedMirroredWorld.m[12] += 4;
  assertMatrixClose(mirroredFinalWorld, expectedMirroredWorld, '方向载体不得改变最终世界矩阵');
  assert.ok(mirroredBatchMesh.getWorldMatrix().determinant() < 0, '负方向必须由批次 Mesh 世界矩阵承载');
  assert.ok(mirroredThinMatrix.determinant() > 0, '负方向批次内的 thinInstance 矩阵必须归一为正 determinant');
  assert.equal(
    readEffectiveSideOrientation(mirroredBatchMesh),
    readEffectiveSideOrientation(mirroredMesh),
    '批次 Mesh 的材质正反面方向必须与源模型一致',
  );
  assert.equal(mirroredBatchMesh.material, mirroredMaterial, '负方向批次必须继续共享源材质');
  assert.equal(mirroredMaterial.sideOrientation, 0, '创建方向批次不得改写共享材质的显式 sideOrientation');
  assert.equal(mirroredBatchMesh.hasVertexAlpha, mirroredMesh.hasVertexAlpha, '批次必须保留顶点 alpha 标记');
  assert.equal(mirroredBatchMesh.useVertexColors, mirroredMesh.useVertexColors, '批次必须保留顶点颜色标记');
  mirroredBatch.dispose();
  mirroredMesh.dispose(false, false);
  mirroredMaterial.dispose();

  // 正式模型阵列：SceneDocument 保留 1000 个独立模型实体，运行时仍只维护一个源模型和固定批次 Mesh。
  const formalArrayEntity = {
    id: SOURCE_ENTITY_ID,
    name: 'Formal Array Source',
    visible: true,
    locked: false,
    parentId: null,
    childrenIds: [],
    components: {
      transform: {
        position: { x: 10, y: 2, z: -5 },
        rotation: { x: 0, y: Math.PI / 2, z: 0 },
        scale: { x: 2, y: 3, z: 4 },
      },
      modelAsset: {
        sourcePath: 'formal.glb',
        sourceUrl: 'formal.glb',
        assetCode: 'FORMAL0000',
        lengthUnit: 'meter',
        unitScaleToMeters: 1,
      },
    },
  };
  const formalArrayInstances = Array.from({ length: 1000 }, (_, index) => ({
    ...formalArrayEntity,
    id: `formal-array-entity-${index + 1}`,
    name: `Formal Array ${index + 1}`,
    components: {
      ...formalArrayEntity.components,
      transform: {
        position: { x: 11 + index, y: 2, z: -5 },
        rotation: { x: 0, y: Math.PI / 2, z: 0 },
        scale: { x: 2, y: 3, z: 4 },
      },
      modelAsset: {
        ...formalArrayEntity.components.modelAsset,
        assetCode: `FORMAL${String(index + 1).padStart(4, '0')}`,
      },
      modelArrayInstance: { sourceEntityId: SOURCE_ENTITY_ID },
    },
  }));
  const sourceModelEntry = runtime.models.get(SOURCE_ENTITY_ID);
  const meshCountBeforeFormalArray = scene.meshes.length;
  runtime.entityStates.set(SOURCE_ENTITY_ID, { visible: true, locked: false });
  for (const instance of formalArrayInstances) {
    runtime.entityStates.set(instance.id, { visible: true, locked: false });
    runtime.modelArrayInstanceEntities.set(instance.id, instance);
  }
  runtime.syncModelArrayBatch(formalArrayEntity, sourceModelEntry);
  const formalBatch = sourceModelEntry.modelArrayBatch;
  const formalBatchMeshes = [...(formalBatch?.meshes ?? [])];
  assert.equal(runtime.models.size, 1, '1000 个独立阵列实体不得创建逐副本 ModelRuntimeEntry');
  assert.equal(runtime.modelArrayInstanceEntities.size, 1000, '运行时必须保留 1000 个逻辑模型实体映射');
  assert.equal(formalBatchMeshes.length, 1, '单 Mesh 正式阵列只应增加一个批次 Mesh');
  assert.equal(scene.meshes.length, meshCountBeforeFormalArray + 1, '正式阵列 Mesh 节点数不得随 1000 个模型增长');
  assert.equal(formalBatchMeshes[0].thinInstanceCount, 1000, '正式阵列必须一次写入 1000 个 thinInstance');
  assert.notEqual(formalBatchMeshes[0].geometry, sourceGeometry, '正式阵列必须使用独立 Geometry 承载 thinInstance 缓冲');
  assert.equal(formalBatchMeshes[0].getTotalVertices(), sourceMesh.getTotalVertices(), '正式阵列独立 Geometry 必须保留源顶点');
  assert.equal(formalBatchMeshes[0].material, sourceMaterial, '正式阵列必须共享源材质');
  assert.equal(formalBatchMeshes[0].metadata?.modelArraySourceEntityId, SOURCE_ENTITY_ID, '批次必须记录共享源模型');
  assert.equal(
    runtime.readEntityIdFromMesh(formalBatchMeshes[0], 0),
    formalArrayInstances[0].id,
    '第一个 thinInstance 必须映射到第一个逻辑模型',
  );
  assert.equal(
    runtime.readEntityIdFromMesh(formalBatchMeshes[0], 999),
    formalArrayInstances[999].id,
    '最后一个 thinInstance 必须映射到最后一个逻辑模型',
  );
  assert.equal(formalBatchMeshes[0].isPickable, true, '存在未锁定实例时批次必须允许拾取');
  const formalPositions = readThinInstancePositions(formalBatchMeshes[0]);
  assertPosition(formalPositions[0], { x: 11, y: 2, z: -5 }, '正式阵列第一个矩阵实例');
  assertPosition(formalPositions[999], { x: 1010, y: 2, z: -5 }, '正式阵列最后一个矩阵实例');

  const formalMatrixBuffer = formalBatch?.batches?.[0]?.matrixBuffer;
  const movedFirstInstance = {
    ...formalArrayInstances[0],
    components: {
      ...formalArrayInstances[0].components,
      transform: {
        ...formalArrayInstances[0].components.transform,
        position: { x: 123, y: 4, z: 6 },
      },
    },
  };
  formalArrayInstances[0] = movedFirstInstance;
  runtime.modelArrayInstanceEntities.set(movedFirstInstance.id, movedFirstInstance);
  runtime.syncModelArrayBatch(formalArrayEntity, sourceModelEntry);
  assert.equal(sourceModelEntry.modelArrayBatch, formalBatch, '移动单个逻辑模型时必须复用正式矩阵批次');
  assert.equal(formalBatch?.batches?.[0]?.matrixBuffer, formalMatrixBuffer, '同数量更新必须复用连续 Float32Array');
  assertClose(formalMatrixBuffer[12], 123, '移动后第一个阵列矩阵 X');
  assertClose(formalMatrixBuffer[13], 4, '移动后第一个阵列矩阵 Y');
  assertClose(formalMatrixBuffer[14], 6, '移动后第一个阵列矩阵 Z');
  assertClose(formalMatrixBuffer[999 * 16 + 12], 1010, '移动单个模型不得影响最后一个阵列矩阵');
  const instanceGizmoTarget = runtime.getGizmoTargetByEntityId(movedFirstInstance.id);
  assertPosition(instanceGizmoTarget, { x: 123, y: 4, z: 6 }, '矩阵实例 Gizmo 代理必须使用自身 Transform');
  const movedInstanceGeometry = runtime.getEntityArrayGeometry(movedFirstInstance.id, { x: 1, y: 0, z: 0 });
  assertClose(movedInstanceGeometry?.spanMeters, 24, '矩阵实例必须可继续按自身姿态参与阵列测量');
  assert.equal(
    runtime.updateEntityArrayPreview(movedFirstInstance.id, { x: 1, y: 0, z: 0 }, 1, 0),
    true,
    '矩阵实例必须可继续创建 thinInstance 阵列预览',
  );
  const instancePreviewPosition = readThinInstancePositions(readPreviewMatrixMeshes(runtime)[0])[0];
  assertPosition(instancePreviewPosition, { x: 147, y: 4, z: 6 }, '矩阵实例预览必须从自身位置继续阵列');
  runtime.clearEntityArrayPreview();

  root.position.x = 15;
  root.computeWorldMatrix(true);
  contentRoot.computeWorldMatrix(true);
  sourceMesh.computeWorldMatrix(true);
  runtime.syncModelArrayBatch(formalArrayEntity, sourceModelEntry);
  assertClose(formalMatrixBuffer[12], 123, '源模型移动不得拖动独立阵列实体');
  assertClose(formalMatrixBuffer[999 * 16 + 12], 1010, '源模型移动不得改变其他独立实体');
  runtime.entityStates.set(SOURCE_ENTITY_ID, { visible: false, locked: false });
  runtime.applyModelInteractivity(sourceModelEntry, SOURCE_ENTITY_ID);
  runtime.syncModelArrayBatch(formalArrayEntity, sourceModelEntry);
  assert.equal(formalBatchMeshes[0].isEnabled(), true, '隐藏源模型不得隐藏独立阵列实体');
  runtime.entityStates.set(SOURCE_ENTITY_ID, { visible: true, locked: false });
  runtime.applyModelInteractivity(sourceModelEntry, SOURCE_ENTITY_ID);

  runtime.entityStates.set(movedFirstInstance.id, { visible: false, locked: false });
  runtime.syncModelArrayBatch(formalArrayEntity, sourceModelEntry);
  assert.equal(formalBatchMeshes[0].thinInstanceCount, 999, '隐藏单个逻辑模型必须只移除一个有效矩阵');
  assert.equal(
    runtime.readEntityIdFromMesh(formalBatchMeshes[0], 0),
    formalArrayInstances[1].id,
    '隐藏首项后拾取索引必须重新映射到下一可见逻辑模型',
  );

  for (const instance of formalArrayInstances) {
    runtime.entityStates.set(instance.id, { visible: true, locked: true });
  }
  runtime.syncModelArrayBatch(formalArrayEntity, sourceModelEntry);
  assert.equal(formalBatchMeshes[0].isPickable, false, '全部逻辑模型锁定后批次必须禁用拾取');
  for (const instance of formalArrayInstances) {
    runtime.entityStates.set(instance.id, { visible: true, locked: false });
  }
  runtime.syncModelArrayBatch(formalArrayEntity, sourceModelEntry);

  runtime.selectedEntityIds = new Set([formalArrayInstances[5].id]);
  runtime.rebuildSharedModelSelectionOutline();
  const selectionBuffer = formalBatch?.batches?.[0]?.selectionBuffer;
  assert.equal(selectionBuffer?.filter((value) => value > 0).length, 1, '独立选中只能标记一个 thinInstance');
  assert.ok(selectionBuffer?.[5] > 0, '选择缓冲必须标记目标逻辑模型索引');

  // 同一源 Mesh 同时存在正负缩放时必须固定拆成两个方向批次，且拾取/选择仍映射到各自逻辑实体。
  const mirroredFormalInstance = {
    ...formalArrayInstances[5],
    components: {
      ...formalArrayInstances[5].components,
      transform: {
        ...formalArrayInstances[5].components.transform,
        scale: { ...formalArrayInstances[5].components.transform.scale, x: -2 },
      },
    },
  };
  formalArrayInstances[5] = mirroredFormalInstance;
  runtime.modelArrayInstanceEntities.set(mirroredFormalInstance.id, mirroredFormalInstance);
  runtime.syncModelArrayBatch(formalArrayEntity, sourceModelEntry);
  const orientationMeshes = formalBatch.meshes.filter((mesh) => mesh.thinInstanceCount > 0);
  assert.equal(orientationMeshes.length, 2, '正负 determinant 混合时每个源 Mesh 只允许两个固定方向批次');
  const negativeOrientationMesh = orientationMeshes.find((mesh) => (
    mesh.computeWorldMatrix(true).determinant() < 0
  ));
  const positiveOrientationMesh = orientationMeshes.find((mesh) => mesh.getWorldMatrix().determinant() > 0);
  assert.ok(negativeOrientationMesh && positiveOrientationMesh, '混合方向批次必须分别承载正负 Mesh determinant');
  assert.equal(negativeOrientationMesh.thinInstanceCount, 1, '单个负缩放逻辑模型只应进入负方向批次');
  assert.equal(positiveOrientationMesh.thinInstanceCount, 999, '其余逻辑模型必须继续合并在正方向批次');
  assert.ok(
    negativeOrientationMesh.thinInstanceGetWorldMatrices()[0].determinant() > 0,
    '负方向批次的局部 thinInstance determinant 必须保持为正',
  );
  assert.equal(
    runtime.readEntityIdFromMesh(negativeOrientationMesh, 0),
    mirroredFormalInstance.id,
    '负方向 thinInstanceIndex 必须映射回自己的逻辑模型',
  );
  runtime.selectedEntityIds = new Set([mirroredFormalInstance.id]);
  runtime.rebuildSharedModelSelectionOutline();
  const negativeOrientationBatch = formalBatch.batches.find((batch) => batch.mesh === negativeOrientationMesh);
  const positiveOrientationBatch = formalBatch.batches.find((batch) => batch.mesh === positiveOrientationMesh);
  assert.ok(negativeOrientationBatch?.selectionBuffer?.[0] > 0, '负方向逻辑模型必须可独立描边');
  assert.equal(
    positiveOrientationBatch?.selectionBuffer?.filter((value) => value > 0).length,
    0,
    '选中负方向逻辑模型不得污染正方向批次',
  );

  const restoredFormalInstance = {
    ...mirroredFormalInstance,
    components: {
      ...mirroredFormalInstance.components,
      transform: {
        ...mirroredFormalInstance.components.transform,
        scale: { ...mirroredFormalInstance.components.transform.scale, x: 2 },
      },
    },
  };
  formalArrayInstances[5] = restoredFormalInstance;
  runtime.modelArrayInstanceEntities.set(restoredFormalInstance.id, restoredFormalInstance);
  runtime.syncModelArrayBatch(formalArrayEntity, sourceModelEntry);
  assert.equal(negativeOrientationMesh.thinInstanceCount, 0, '恢复正缩放后负方向固定批次必须停用');
  assert.equal(formalBatch.meshes[0].thinInstanceCount, 1000, '恢复正缩放后全部逻辑模型必须重新合并');
  assert.equal(
    runtime.readEntityIdFromMesh(formalBatch.meshes[0], 5),
    restoredFormalInstance.id,
    '方向批次合并后拾取索引必须恢复正确映射',
  );
  // 批次拥有隔离 Geometry 后，参数脚本改写顶点时必须按新的渲染签名重建并复制最新数据。
  const originalSourcePositions = sourceMesh.getVerticesData('position');
  const updatedSourcePositions = originalSourcePositions.map((value, index) => (
    index % 3 === 0 ? value * 1.25 : value
  ));
  sourceMesh.setVerticesData('position', updatedSourcePositions, true);
  runtime.syncModelArrayBatchForEntities(formalArrayEntity, sourceModelEntry, formalArrayInstances, [], {
    sourceEntityId: SOURCE_ENTITY_ID,
    namePrefix: '__modelArrayThinInstance',
    renderSignature: 'geometry-update-2',
  });
  const rebuiltFormalBatch = sourceModelEntry.modelArrayBatch;
  assert.ok(rebuiltFormalBatch && rebuiltFormalBatch !== formalBatch, '参数脚本顶点变化必须重建隔离 Geometry 批次');
  assert.ok(formalBatch.meshes.every((mesh) => mesh.isDisposed()), '重建参数批次必须释放旧 Geometry 和全部方向批次');
  assert.deepEqual(
    Array.from(rebuiltFormalBatch.meshes[0].getVerticesData('position')),
    Array.from(updatedSourcePositions),
    '重建后的批次 Geometry 必须复制参数脚本最新顶点',
  );
  sourceMesh.setVerticesData('position', originalSourcePositions, true);
  sourceMesh.refreshBoundingInfo();

  runtime.selectedEntityIds = new Set();
  const allFormalBatchMeshes = [...rebuiltFormalBatch.meshes];

  for (const instance of formalArrayInstances) {
    runtime.modelArrayInstanceEntities.delete(instance.id);
    runtime.entityStates.delete(instance.id);
  }
  runtime.syncModelArrayBatch(formalArrayEntity, sourceModelEntry);
  assert.equal(sourceModelEntry.modelArrayBatch, null, '删除全部逻辑实体必须释放正式矩阵批次');
  assert.ok(allFormalBatchMeshes.every((mesh) => mesh.isDisposed()), '正式矩阵批次释放必须覆盖全部方向批次 Mesh');
  assert.equal(sourceMesh.isDisposed(), false, '释放正式阵列不得释放源 Mesh');
  assert.equal(sourceMesh.geometry, sourceGeometry, '释放正式阵列不得释放源几何');
  assert.equal(sourceMesh.material, sourceMaterial, '释放正式阵列不得释放源材质');
  runtime.selectedEntityIds = new Set();
  root.position.x = 10;
  root.computeWorldMatrix(true);

  // 内置 Mesh：旋转与非均匀缩放后的世界/局部投影、负方向和源释放生命周期。
  const primitiveEntityId = 'entity-array-primitive';
  const primitiveMesh = MeshBuilder.CreateBox(
    'entity-array-primitive-box',
    { width: 2, height: 4, depth: 6 },
    scene,
  );
  primitiveMesh.position.copyFromFloats(-4, 1, 6);
  primitiveMesh.rotation.y = Math.PI / 2;
  primitiveMesh.scaling.copyFromFloats(1, 2, 3);
  primitiveMesh.isPickable = true;
  primitiveMesh.metadata = { editorEntityId: primitiveEntityId };
  primitiveMesh.computeWorldMatrix(true);
  runtime.meshes.set(primitiveEntityId, primitiveMesh);

  const primitiveWorldGeometry = runtime.getEntityArrayGeometry(primitiveEntityId, { x: 1, y: 0, z: 0 });
  assert.ok(primitiveWorldGeometry, '内置 Mesh 必须支持世界轴阵列测量');
  assertClose(primitiveWorldGeometry.spanMeters, 18, '内置 Mesh 世界 X 跨度必须包含旋转和非均匀缩放');
  const primitiveLocalX = primitiveMesh.getDirection(Vector3.Right()).normalize();
  const primitiveLocalGeometry = runtime.getEntityArrayGeometry(primitiveEntityId, primitiveLocalX);
  assert.ok(primitiveLocalGeometry, '内置 Mesh 必须支持局部轴阵列测量');
  assertClose(primitiveLocalGeometry.spanMeters, 2, '内置 Mesh 局部 X 跨度必须正确');
  const primitiveNegativeGeometry = runtime.getEntityArrayGeometry(
    primitiveEntityId,
    primitiveLocalX.scale(-1),
  );
  assertClose(primitiveNegativeGeometry.spanMeters, 2, '内置 Mesh 正负方向跨度必须一致');
  assert.equal(
    runtime.updateEntityArrayPreview(primitiveEntityId, { x: 1, y: 0, z: 0 }, 1, 0),
    true,
    '内置 Mesh 必须创建临时预览',
  );
  const primitivePreview = readPreviewClones(runtime)[0];
  assertPosition(primitivePreview, { x: 14, y: 1, z: 6 }, '内置 Mesh 零间距副本');
  assert.ok(readPreviewMeshes(primitivePreview).every((mesh) => !mesh.isPickable), '内置 Mesh 预览不得参与拾取');
  assert.ok(readPreviewMeshes(primitivePreview).every((mesh) => mesh.metadata === null), '内置 Mesh 预览不得保留实体 metadata');
  runtime.disposeMesh(primitiveEntityId, primitiveMesh);
  assert.equal(readPreviewClones(runtime).length, 0, '源 Mesh 释放时必须立即清理阵列预览');
  assert.equal(primitivePreview.isDisposed(), true, '源 Mesh 释放必须销毁临时副本');

  // 虚拟定位线框：多个盒体共同参与投影，临时层级共享源材质但不可拾取。
  const locatorEntityId = 'entity-array-locator';
  const locatorRoot = new TransformNode('entity-array-locator-root', scene);
  locatorRoot.position.copyFromFloats(2, 0, 10);
  locatorRoot.rotation.y = Math.PI / 2;
  const locatorMaterial = new StandardMaterial('entity-array-locator-material', scene);
  const locatorBoxes = [-2, 2].map((x, index) => {
    const box = MeshBuilder.CreateBox(`entity-array-locator-box-${index}`, { size: 2 }, scene);
    box.parent = locatorRoot;
    box.position.x = x;
    box.material = locatorMaterial;
    box.isPickable = true;
    box.metadata = { editorEntityId: locatorEntityId };
    return box;
  });
  locatorRoot.computeWorldMatrix(true);
  locatorBoxes.forEach((box) => box.computeWorldMatrix(true));
  runtime.locators.set(locatorEntityId, {
    root: locatorRoot,
    boxes: locatorBoxes,
    material: locatorMaterial,
    assetId: 'LOC9',
    signature: 'fixture',
    columns: 2,
    layers: 1,
    startColumn: 1,
    deviceAssetCode: '',
    rowNumber: 1,
    storageDepth: 'near',
  });
  const locatorLocalX = locatorRoot.getDirection(Vector3.Right()).normalize();
  const locatorGeometry = runtime.getEntityArrayGeometry(locatorEntityId, locatorLocalX);
  assert.ok(locatorGeometry, '定位线框必须支持局部轴阵列测量');
  assertClose(locatorGeometry.spanMeters, 6, '定位线框跨度必须汇总全部盒体');
  assert.equal(
    runtime.updateEntityArrayPreview(locatorEntityId, locatorLocalX, 1, 1),
    true,
    '定位线框必须创建临时预览',
  );
  const locatorPreview = readPreviewClones(runtime)[0];
  assertPosition(
    locatorPreview,
    {
      x: locatorRoot.position.x + locatorLocalX.x * 7,
      y: locatorRoot.position.y + locatorLocalX.y * 7,
      z: locatorRoot.position.z + locatorLocalX.z * 7,
    },
    '定位线框间距副本',
  );
  assert.equal(locatorPreview.getChildMeshes(false).length, 2, '定位线框预览必须保留全部盒体');
  assert.ok(locatorPreview.getChildMeshes(false).every((mesh) => !mesh.isPickable && mesh.metadata === null));
  runtime.clearEntityArrayPreview();

  // CAD：加载完成前阻止阵列，完成后按线稿世界包围盒支持正负局部轴。
  const cadEntityId = 'entity-array-cad';
  const cadRoot = new TransformNode('entity-array-cad-root', scene);
  cadRoot.position.copyFromFloats(5, 0, 5);
  cadRoot.rotation.y = Math.PI / 2;
  cadRoot.scaling.copyFromFloats(2, 1, 1);
  const cadLine = MeshBuilder.CreateLines(
    'entity-array-cad-line',
    { points: [new Vector3(-2, 0, 0), new Vector3(2, 0, 0), new Vector3(2, 1, 0)] },
    scene,
  );
  cadLine.parent = cadRoot;
  cadLine.computeWorldMatrix(true);
  const cadRuntimeEntry = {
    sourceUrl: 'fixture.dxf',
    unitScaleToMeters: 1,
    root: cadRoot,
    lineMeshes: [cadLine],
    highlighted: false,
    loadToken: 1,
    lineColor: '#ffffff',
    opacity: 1,
    geometryReady: false,
    cancelLoad: null,
  };
  runtime.cadReferences.set(cadEntityId, cadRuntimeEntry);
  const cadLocalX = cadRoot.getDirection(Vector3.Right()).normalize();
  assert.equal(
    runtime.getEntityArrayGeometry(cadEntityId, cadLocalX),
    null,
    'CAD 几何加载完成前必须阻止阵列',
  );
  cadRuntimeEntry.geometryReady = true;
  const cadGeometry = runtime.getEntityArrayGeometry(cadEntityId, cadLocalX);
  assert.ok(cadGeometry, 'CAD 加载完成后必须支持局部轴阵列');
  assertClose(cadGeometry.spanMeters, 8, 'CAD 局部 X 跨度必须包含根节点缩放');
  assert.equal(
    runtime.updateEntityArrayPreview(cadEntityId, cadLocalX.scale(-1), 2, 1),
    true,
    'CAD 必须支持负方向预览',
  );
  const cadPreviewPool = [...readPreviewClones(runtime)];
  assertPosition(
    cadPreviewPool[0],
    {
      x: cadRoot.position.x - cadLocalX.x * 9,
      y: cadRoot.position.y - cadLocalX.y * 9,
      z: cadRoot.position.z - cadLocalX.z * 9,
    },
    'CAD 负方向第一个副本',
  );
  assert.ok(cadPreviewPool.every((clone) => clone.getChildMeshes(false).every((mesh) => !mesh.isPickable)));
  runtime.clearEntityArrayPreview();

  // 纯粒子 POI：测量效果范围，但预览只创建半透明范围代理，不复制粒子系统。
  const poiEntity = createPoiEffectEntity('smoke', { x: 1, y: 0, z: -3 });
  const poiRoot = new TransformNode(`${poiEntity.id}_poiEffectRoot`, scene);
  poiRoot.position.copyFromFloats(1, 0, -3);
  const poiPickMesh = MeshBuilder.CreateBox(`${poiEntity.id}_pick`, { size: 1.8 }, scene);
  const poiPickMaterial = new StandardMaterial(`${poiEntity.id}_pick_material`, scene);
  poiPickMaterial.alpha = 0.025;
  poiPickMesh.parent = poiRoot;
  poiPickMesh.material = poiPickMaterial;
  poiPickMesh.visibility = 0.025;
  poiPickMesh.metadata = { editorEntityId: poiEntity.id };
  const poiBoundsProxy = MeshBuilder.CreateBox(
    `${poiEntity.id}_smoke_bounds`,
    { width: 2.2, height: 3.5, depth: 2.2 },
    scene,
  );
  poiBoundsProxy.parent = poiRoot;
  poiBoundsProxy.position.y = 1.5;
  poiBoundsProxy.visibility = 0;
  poiBoundsProxy.isVisible = true;
  poiBoundsProxy.isPickable = false;
  poiBoundsProxy.metadata = { effectBoundsProxy: true };
  const sourceParticleSystem = new ParticleSystem(`${poiEntity.id}_particles`, 16, scene);
  runtime.poiEffectRuntime.entries.set(poiEntity.id, {
    root: poiRoot,
    pickMesh: poiPickMesh,
    pickMaterial: poiPickMaterial,
    signature: 'smoke-fixture',
    resources: {
      meshes: [poiBoundsProxy],
      materials: [],
      particleSystems: [sourceParticleSystem],
      textures: [],
    },
    visible: true,
    pickable: true,
    selected: false,
    seed: 1,
    particlesActive: false,
  });
  poiRoot.computeWorldMatrix(true);
  poiBoundsProxy.computeWorldMatrix(true);
  const poiParticleSystemCount = scene.particleSystems.length;
  const poiGeometry = runtime.getEntityArrayGeometry(poiEntity.id, { x: 1, y: 0, z: 0 });
  assert.ok(poiGeometry, '纯粒子 POI 必须使用效果范围参与阵列测量');
  assertClose(poiGeometry.spanMeters, 2.2, '烟雾 POI 世界 X 范围必须使用粒子范围代理');
  assert.equal(
    runtime.updateEntityArrayPreview(poiEntity.id, { x: -1, y: 0, z: 0 }, 2, 0.3),
    true,
    '纯粒子 POI 必须创建轻量静态预览',
  );
  const poiPreviewPool = [...readPreviewClones(runtime)];
  assert.equal(scene.particleSystems.length, poiParticleSystemCount, 'POI 临时预览不得复制粒子系统');
  assert.equal(poiPreviewPool.length, 2, 'POI 临时预览数量必须匹配副本数量');
  assertPosition(poiPreviewPool[0], { x: -1.5, y: 0, z: -3 }, 'POI 范围代理第一个副本');
  for (const clone of poiPreviewPool) {
    const previewMeshes = clone.getChildMeshes(false);
    assert.equal(previewMeshes.length, 1, '纯粒子 POI 每个副本只保留一个范围代理');
    assert.ok(previewMeshes.every((mesh) => !mesh.isPickable && mesh.metadata === null));
    assert.ok(previewMeshes.every((mesh) => mesh.visibility === 1));
    assert.ok(previewMeshes.every((mesh) => Math.abs(mesh.material.alpha - 0.18) <= 1e-6));
  }
  runtime.clearEntityArrayPreview();
  assert.equal(scene.particleSystems.length, poiParticleSystemCount, '清理 POI 预览不得影响源粒子系统');

  const gizmoEvents = {
    previews: [],
    completions: [],
    cancellations: 0,
    transformPreviews: [],
    transformCommits: [],
  };
  gizmoController = new TransformGizmoController(scene, {
    previewTransform: (entityId, transform) => gizmoEvents.transformPreviews.push({ entityId, transform }),
    commitTransform: (entityId, before, after) => gizmoEvents.transformCommits.push({ entityId, before, after }),
    beginEntityArrayDrag: (context) => runtime.getEntityArrayGeometry(context.entityId, context.positiveDirection),
    previewEntityArrayDrag: (update) => gizmoEvents.previews.push(update),
    completeEntityArrayDrag: (update) => gizmoEvents.completions.push(update),
    cancelEntityArrayDrag: () => { gizmoEvents.cancellations += 1; },
  });
  gizmoController.setSnapSettings({
    enabled: true,
    position: 0.5,
    rotationDegrees: 15,
    scale: 0.1,
  });
  gizmoController.attachToTarget(root, SOURCE_ENTITY_ID);

  const xAxisDrag = gizmoController.gizmoManager.gizmos.positionGizmo.xGizmo.dragBehavior;
  const localPositiveX = root.getDirection(Vector3.Right()).normalize();
  const sourcePositionBeforeArray = root.position.clone();
  xAxisDrag.onDragStartObservable.notifyObservers({ pointerInfo: { event: { shiftKey: true } } });
  assert.ok(gizmoController.entityArrayDragSession, 'Shift 开始后必须建立代理拖拽会话');
  assert.notEqual(
    gizmoController.entityArrayDragSession.proxyTarget,
    root,
    'Shift 阵列必须把 Gizmo 绑定到独立代理节点',
  );
  assertClose(
    gizmoController.gizmoManager.gizmos.positionGizmo.snapDistance,
    0,
    'Shift 阵列期间必须临时关闭位置吸附',
  );
  xAxisDrag.onDragObservable.notifyObservers({ delta: localPositiveX.scale(2.1) });
  xAxisDrag.onDragEndObservable.notifyObservers({});
  assert.equal(gizmoEvents.previews.at(-1)?.copyCount, 1, '局部轴半跨度以上拖动必须预览一个副本');
  assert.equal(gizmoEvents.completions.at(-1)?.copyCount, 1, '鼠标松开必须完成当前副本数量');
  assert.equal(gizmoEvents.transformCommits.length, 0, 'Shift 阵列不得提交 Transform 历史');
  assert.ok(root.position.equalsWithEpsilon(sourcePositionBeforeArray), 'Shift 阵列不得移动源模型');
  assertClose(
    gizmoController.gizmoManager.gizmos.positionGizmo.snapDistance,
    0.5,
    'Shift 阵列结束后必须恢复位置吸附',
  );

  xAxisDrag.onDragStartObservable.notifyObservers({ pointerInfo: { event: { shiftKey: true } } });
  xAxisDrag.onDragObservable.notifyObservers({ delta: localPositiveX.scale(-6.1) });
  xAxisDrag.onDragEndObservable.notifyObservers({});
  const negativeCompletion = gizmoEvents.completions.at(-1);
  assert.equal(negativeCompletion.copyCount, 2, '负方向拖动必须使用绝对副本数量');
  assert.ok(
    Vector3.Dot(
      new Vector3(
        negativeCompletion.direction.x,
        negativeCompletion.direction.y,
        negativeCompletion.direction.z,
      ),
      localPositiveX,
    ) < 0,
    '负方向拖动必须回传反向世界单位向量',
  );

  const completedBeforeCancel = gizmoEvents.completions.length;
  xAxisDrag.onDragStartObservable.notifyObservers({ pointerInfo: { event: { shiftKey: true } } });
  xAxisDrag.onDragObservable.notifyObservers({ delta: localPositiveX.scale(5) });
  gizmoController.cancelActiveDrag();
  assert.equal(gizmoEvents.cancellations, 1, '主动取消必须通知上层清理预览');
  assert.equal(gizmoEvents.completions.length, completedBeforeCancel, '主动取消不得误提交阵列');
  assert.ok(root.position.equalsWithEpsilon(sourcePositionBeforeArray), '取消阵列后源模型必须保持原位');

  xAxisDrag.onDragStartObservable.notifyObservers({ pointerInfo: { event: { shiftKey: false } } });
  root.position.x += 1;
  xAxisDrag.onDragObservable.notifyObservers({ delta: new Vector3(1, 0, 0) });
  xAxisDrag.onDragEndObservable.notifyObservers({});
  assert.equal(gizmoEvents.transformPreviews.length, 1, '普通 Gizmo 拖动必须继续预览 Transform');
  assert.equal(gizmoEvents.transformCommits.length, 1, '普通 Gizmo 拖动必须继续提交一次 Transform');

  const positionBeforeTransformCancel = root.position.clone();
  const commitsBeforeTransformCancel = gizmoEvents.transformCommits.length;
  xAxisDrag.onDragStartObservable.notifyObservers({ pointerInfo: { event: { shiftKey: false } } });
  root.position.z += 3;
  xAxisDrag.onDragObservable.notifyObservers({ delta: new Vector3(0, 0, 3) });
  gizmoController.cancelActiveDrag();
  assert.ok(
    root.position.equalsWithEpsilon(positionBeforeTransformCancel),
    'pointercancel/失焦路径必须回滚普通 Transform',
  );
  assert.equal(
    gizmoEvents.transformCommits.length,
    commitsBeforeTransformCancel,
    '取消普通 Transform 不得提交历史',
  );

  const positionBeforeDispose = root.position.clone();
  const commitsBeforeDispose = gizmoEvents.transformCommits.length;
  xAxisDrag.onDragStartObservable.notifyObservers({ pointerInfo: { event: { shiftKey: false } } });
  root.position.y += 2;
  xAxisDrag.onDragObservable.notifyObservers({ delta: new Vector3(0, 2, 0) });
  gizmoController.dispose();
  gizmoController = null;
  assert.ok(root.position.equalsWithEpsilon(positionBeforeDispose), '控制器销毁必须回滚普通 Transform');
  assert.equal(gizmoEvents.transformCommits.length, commitsBeforeDispose, '控制器销毁不得误提交 Transform');

  const arrayFolder = createFolderEntity('Array Folder');
  const arraySource = createModelEntity(
    'fixture.glb',
    'editor-asset://local/fixture.glb',
    '测试 1001',
    { lengthUnit: 'meter', unitScaleToMeters: 1 },
    { x: 5, y: 1, z: 2 },
  );
  arraySource.parentId = arrayFolder.id;
  arraySource.components.modelAsset.assetCode = 'DEV009';
  arrayFolder.childrenIds = [arraySource.id];
  const conflictEntity = createModelEntity(
    'conflict.glb',
    'conflict.glb',
    '测试 1002',
    { lengthUnit: 'meter', unitScaleToMeters: 1 },
  );
  conflictEntity.components.modelAsset.assetCode = 'OTHER';
  const storeScene = createEmptySceneDocument('Model Array Store Smoke');
  storeScene.entityIds = [arrayFolder.id, arraySource.id, conflictEntity.id];
  storeScene.entities = {
    [arrayFolder.id]: arrayFolder,
    [arraySource.id]: arraySource,
    [conflictEntity.id]: conflictEntity,
  };
  storeScene.selectedEntityId = arraySource.id;
  useEditorStore.setState({
    scene: storeScene,
    runtimeMode: 'edit',
    history: { undoStack: [], redoStack: [] },
    hierarchySelectionIds: [arraySource.id],
    entityArrayRequest: null,
  });

  const conflictResult = useEditorStore.getState().commitResolvedEntityArray({
    sourceIds: [arraySource.id],
    copyCount: 2,
    directionVector: { x: -1, y: 0, z: 0 },
    selectionSpanMeters: 2,
    spacingMeters: 0.5,
    assetNumberRule: '',
  });
  assert.equal(conflictResult.ok, false, '确认时必须再次原子阻止名称冲突');
  assert.match(conflictResult.error, /测试 1002/, '冲突错误必须包含具体占用值');
  assert.equal(useEditorStore.getState().history.undoStack.length, 0, '冲突提交不得写入历史');

  const conflictFreeScene = useEditorStore.getState().scene;
  const { [conflictEntity.id]: _removedConflict, ...conflictFreeEntities } = conflictFreeScene.entities;
  useEditorStore.setState({
    scene: {
      ...conflictFreeScene,
      entityIds: conflictFreeScene.entityIds.filter((entityId) => entityId !== conflictEntity.id),
      entities: conflictFreeEntities,
    },
  });

  const commitResult = useEditorStore.getState().commitResolvedEntityArray({
    sourceIds: [arraySource.id],
    copyCount: 1000,
    directionVector: { x: -1, y: 0, z: 0 },
    selectionSpanMeters: 2,
    spacingMeters: 0.5,
    assetNumberRule: '',
  });
  assert.equal(commitResult.ok, true, '无冲突时必须正式提交模型矩阵阵列');
  assert.equal(commitResult.duplicatedIds.length, 0, '纯模型阵列不得混入非模型副本 ID');
  assert.equal(commitResult.modelArrayItemIds.length, 1000, '模型阵列必须返回全部独立矩阵实体 ID');
  assert.equal(commitResult.createdCount, 1000, '正式提交数量必须包含全部独立模型实体');
  const modelArrayItemIds = commitResult.modelArrayItemIds;

  let committedState = useEditorStore.getState();
  const committedSource = committedState.scene.entities[arraySource.id];
  const committedInstances = modelArrayItemIds.map((entityId) => committedState.scene.entities[entityId]);
  assert.equal(committedInstances.length, 1000, '场景必须持久化全部 1000 个独立模型实体');
  assert.ok(committedInstances.every(Boolean), '提交结果中的每个矩阵实例 ID 都必须对应真实 Scene Entity');
  assert.ok(
    committedInstances.every((entity) => entity.components.modelArrayInstance?.sourceEntityId === arraySource.id),
    '每个阵列实体必须直接引用同一个源模型',
  );
  assert.deepEqual(committedInstances.slice(0, 2).map((entity) => entity.name), ['测试 1002', '测试 1003']);
  assert.equal(committedInstances.at(-1)?.name, '测试 2001', '第 1000 个逻辑实体名称必须连续递增');
  assert.deepEqual(
    [
      committedInstances[0]?.components.modelAsset?.assetCode,
      committedInstances.at(-1)?.components.modelAsset?.assetCode,
    ],
    ['DEV010', 'DEV1009'],
    '阵列实体资产编号必须按源资产编号递增',
  );
  assert.deepEqual(
    [
      committedInstances[0]?.components.transform.position,
      committedInstances.at(-1)?.components.transform.position,
    ],
    [
      { x: 2.5, y: 1, z: 2 },
      { x: -2495, y: 1, z: 2 },
    ],
    '正式矩阵阵列必须把每个世界偏移写入独立实体 Transform',
  );
  assert.deepEqual(
    committedSource.components.transform.position,
    { x: 5, y: 1, z: 2 },
    '矩阵阵列不得移动源模型',
  );
  assert.equal(committedSource.components.modelArray, undefined, '新阵列不得继续写入隐藏 modelArray.items');
  assert.equal(committedState.scene.entityIds.length, 1002, '1000 级模型阵列必须向 SceneDocument 增加 1000 个实体');
  assert.deepEqual(
    committedState.scene.entityIds.slice(0, 2),
    [arrayFolder.id, arraySource.id],
    '原有场景实体顺序必须保持',
  );
  assert.deepEqual(
    committedState.scene.entityIds.slice(2),
    modelArrayItemIds,
    '全部阵列模型必须进入 Scene Entity 有序列表',
  );
  assert.deepEqual(
    committedState.scene.entities[arrayFolder.id].childrenIds,
    [arraySource.id, ...modelArrayItemIds],
    '父文件夹必须登记全部独立阵列模型',
  );
  assert.equal(committedState.scene.selectedEntityId, arraySource.id, '确认后必须保持源模型选中');
  assert.equal(committedState.history.undoStack.length, 1, '整组阵列必须只写入一条撤销历史');

  committedState.undo();
  let undoneState = useEditorStore.getState();
  assert.ok(modelArrayItemIds.every((entityId) => !undoneState.scene.entities[entityId]), '撤销必须移除整组模型实体');
  assert.deepEqual(undoneState.scene.entities[arrayFolder.id].childrenIds, [arraySource.id]);

  undoneState.redo();
  const redoneState = useEditorStore.getState();
  const redoneInstances = modelArrayItemIds.map((entityId) => redoneState.scene.entities[entityId]);
  assert.ok(redoneInstances.every(Boolean), '重做必须恢复相同矩阵阵列实体 ID');
  assert.deepEqual(
    [
      [redoneInstances[0]?.name, redoneInstances[0]?.components.modelAsset?.assetCode],
      [redoneInstances.at(-1)?.name, redoneInstances.at(-1)?.components.modelAsset?.assetCode],
    ],
    [['测试 1002', 'DEV010'], ['测试 2001', 'DEV1009']],
    '重做必须恢复相同名称和编号',
  );

  const serializedArrayScene = serializeScene(redoneState.scene);
  const restoredArrayScene = deserializeScene(serializedArrayScene);
  assert.deepEqual(restoredArrayScene.entityIds, redoneState.scene.entityIds, '保存并重新加载必须恢复全部独立实体 ID');
  assert.deepEqual(
    restoredArrayScene.entities[modelArrayItemIds[0]].components,
    redoneInstances[0].components,
    '保存并重新加载场景必须完整恢复矩阵实例组件',
  );
  const invalidSourceSceneFile = JSON.parse(serializedArrayScene);
  invalidSourceSceneFile.scene.entities[modelArrayItemIds[0]].components.modelArrayInstance.sourceEntityId = modelArrayItemIds[0];
  assert.throws(
    () => deserializeScene(JSON.stringify(invalidSourceSceneFile)),
    /场景文件格式不受支持/,
    '反序列化必须拒绝矩阵实例自引用',
  );

  const repeatedConflict = useEditorStore.getState().commitResolvedEntityArray({
    sourceIds: [arraySource.id],
    copyCount: 1,
    directionVector: { x: -1, y: 0, z: 0 },
    selectionSpanMeters: 2,
    spacingMeters: 0.5,
    assetNumberRule: '',
  });
  assert.equal(repeatedConflict.ok, false, '再次阵列必须检测已有独立实体的名称或编号冲突');
  assert.match(repeatedConflict.error, /测试 1002|DEV010/);

  useEditorStore.setState((state) => ({
    scene: { ...state.scene, selectedEntityId: arraySource.id },
    hierarchySelectionIds: [arraySource.id],
  }));
  useEditorStore.getState().deleteSelectedEntity();
  const sourceDeletedState = useEditorStore.getState();
  const promotedSourceId = modelArrayItemIds[0];
  assert.equal(sourceDeletedState.scene.entities[arraySource.id], undefined, '删除源模型必须只删除该实体');
  assert.equal(
    sourceDeletedState.scene.entities[promotedSourceId].components.modelArrayInstance,
    undefined,
    '删除源模型后必须提升第一个剩余实例为新源',
  );
  assert.ok(
    modelArrayItemIds.slice(1).every((entityId) => (
      sourceDeletedState.scene.entities[entityId].components.modelArrayInstance?.sourceEntityId === promotedSourceId
    )),
    '其余实例必须重绑到提升后的新源模型',
  );
  sourceDeletedState.undo();
  assert.ok(useEditorStore.getState().scene.entities[arraySource.id], '撤销删除必须恢复原源模型');

  // 旧版隐藏 modelArray.items 在加载时必须迁移成独立 Scene Entity。
  const legacySceneFile = JSON.parse(serializeScene({
    ...undoneState.scene,
    entityIds: [arrayFolder.id, arraySource.id],
    entities: {
      [arrayFolder.id]: { ...arrayFolder, childrenIds: [arraySource.id] },
      [arraySource.id]: {
        ...arraySource,
        components: {
          ...arraySource.components,
          modelArray: {
            items: [{
              id: 'legacy-model-array-item',
              name: 'Legacy Array Model',
              assetCode: 'DEV777',
              offset: { x: 3, y: 0, z: 0 },
            }],
          },
        },
      },
    },
  }));
  const migratedLegacyScene = deserializeScene(JSON.stringify(legacySceneFile));
  assert.ok(migratedLegacyScene.entities['legacy-model-array-item'], '旧隐藏阵列项必须迁移为真实实体');
  assert.equal(
    migratedLegacyScene.entities['legacy-model-array-item'].components.modelArrayInstance?.sourceEntityId,
    arraySource.id,
    '迁移实体必须引用原源模型',
  );
  assert.equal(migratedLegacyScene.entities[arraySource.id].components.modelArray, undefined, '迁移后源实体必须移除旧隐藏项');
  assert.ok(
    migratedLegacyScene.entities[arrayFolder.id].childrenIds.includes('legacy-model-array-item'),
    '迁移实体必须进入原父文件夹',
  );

  /** 用单个源对象重置 Store，并执行一次正式阵列。 */
  function commitSingleSourceArray(source, label, copyCount = 2) {
    const singleSourceScene = createEmptySceneDocument(label);
    singleSourceScene.entityIds = [source.id];
    singleSourceScene.entities = { [source.id]: source };
    singleSourceScene.selectedEntityId = source.id;
    useEditorStore.setState({
      scene: singleSourceScene,
      runtimeMode: 'edit',
      history: { undoStack: [], redoStack: [] },
      hierarchySelectionIds: [source.id],
      entityArrayRequest: null,
    });
    return useEditorStore.getState().commitResolvedEntityArray({
      sourceIds: [source.id],
      copyCount,
      directionVector: { x: 1, y: 0, z: 0 },
      selectionSpanMeters: 1,
      spacingMeters: 0,
      assetNumberRule: '',
    });
  }

  const locatorArraySource = createLocatorEntity({ x: 0, y: 0, z: 0 });
  locatorArraySource.name = 'Locator Fixture';
  locatorArraySource.components.locator.assetId = 'LOC009';
  const locatorCommit = commitSingleSourceArray(locatorArraySource, 'Locator Array Store Smoke');
  assert.equal(locatorCommit.ok, true, '定位线框必须复用正式阵列提交');
  const locatorCommittedState = useEditorStore.getState();
  const locatorCopies = locatorCommit.duplicatedIds.map((entityId) => locatorCommittedState.scene.entities[entityId]);
  assert.deepEqual(
    locatorCopies.map((entity) => entity.components.locator.assetId),
    ['LOC010', 'LOC011'],
    '定位线框副本必须递增 locator.assetId',
  );
  assert.deepEqual(
    locatorCopies.map((entity) => entity.name),
    ['Locator Fixture1', 'Locator Fixture2'],
    '定位线框名称必须按源名称递增且不添加“副本”',
  );

  const meshArraySource = createMeshEntity('cube');
  meshArraySource.name = 'Mesh Fixture';
  const meshCommit = commitSingleSourceArray(meshArraySource, 'Mesh Array Store Smoke');
  assert.equal(meshCommit.ok, true, '内置 Mesh 必须复用正式阵列提交');
  const meshCommittedState = useEditorStore.getState();
  const meshCopies = meshCommit.duplicatedIds.map((entityId) => meshCommittedState.scene.entities[entityId]);
  assert.deepEqual(meshCopies.map((entity) => entity.name), ['Mesh Fixture1', 'Mesh Fixture2']);
  assert.ok(meshCopies.every((entity) => entity.components.meshRenderer?.meshKind === 'cube'));

  const mixedModelSource = createModelEntity(
    'mixed.glb',
    'editor-asset://local/mixed.glb',
    'Mixed Model',
    { lengthUnit: 'meter', unitScaleToMeters: 1 },
  );
  mixedModelSource.components.modelAsset.assetCode = 'MIX009';
  const mixedMeshSource = createMeshEntity('sphere');
  mixedMeshSource.name = 'Mixed Mesh';
  const mixedScene = createEmptySceneDocument('Mixed Model Array Store Smoke');
  mixedScene.entityIds = [mixedModelSource.id, mixedMeshSource.id];
  mixedScene.entities = {
    [mixedModelSource.id]: mixedModelSource,
    [mixedMeshSource.id]: mixedMeshSource,
  };
  mixedScene.selectedEntityId = mixedModelSource.id;
  useEditorStore.setState({
    scene: mixedScene,
    runtimeMode: 'edit',
    history: { undoStack: [], redoStack: [] },
    hierarchySelectionIds: [mixedModelSource.id, mixedMeshSource.id],
    entityArrayRequest: null,
  });
  const mixedCommit = useEditorStore.getState().commitResolvedEntityArray({
    sourceIds: [mixedModelSource.id, mixedMeshSource.id],
    copyCount: 1,
    directionVector: { x: 0, y: 0, z: 1 },
    selectionSpanMeters: 2,
    spacingMeters: 0.5,
    assetNumberRule: '',
  });
  assert.equal(mixedCommit.ok, true, '模型与非模型混合选区必须在同一原子命令中提交');
  assert.equal(mixedCommit.modelArrayItemIds.length, 1, '混合阵列中的模型只生成一个独立矩阵实体');
  assert.equal(mixedCommit.duplicatedIds.length, 1, '混合阵列中的非模型仍生成一个普通实体');
  const mixedCommittedState = useEditorStore.getState();
  assert.equal(
    mixedCommittedState.scene.entities[mixedCommit.modelArrayItemIds[0]]?.components.modelArrayInstance?.sourceEntityId,
    mixedModelSource.id,
    '混合阵列模型必须作为真实实体引用源模型',
  );
  assert.ok(
    mixedCommittedState.scene.entities[mixedCommit.duplicatedIds[0]]?.components.meshRenderer,
    '混合阵列必须保留非模型实体复制语义',
  );
  mixedCommittedState.undo();
  const mixedUndoneState = useEditorStore.getState();
  assert.equal(mixedUndoneState.scene.entities[mixedCommit.modelArrayItemIds[0]], undefined);
  assert.equal(mixedUndoneState.scene.entities[mixedCommit.duplicatedIds[0]], undefined);

  const cadArraySource = createCadReferenceEntity(
    'fixture.dxf',
    'fixture.dxf',
    'CAD Fixture',
    {
      sourceFileSizeBytes: 32,
      importMode: 'exact',
      sourceUnitCode: 6,
      sourceUnitName: '米',
      unitDetection: 'insunits',
      unitScaleToMeters: 1,
      originMode: 'center',
      lineColor: '#ffffff',
      opacity: 1,
      layerStats: [],
      bounds: {
        min: { x: -1, y: 0, z: 0 },
        max: { x: 1, y: 1, z: 0 },
        size: { x: 2, y: 1, z: 0 },
        center: { x: 0, y: 0.5, z: 0 },
      },
      polylineCount: 1,
      pointCount: 2,
    },
  );
  cadArraySource.locked = false;
  const cadCommit = commitSingleSourceArray(cadArraySource, 'CAD Array Store Smoke');
  assert.equal(cadCommit.ok, true, 'CAD 必须复用正式阵列提交');
  const cadCommittedState = useEditorStore.getState();
  assert.ok(cadCommit.duplicatedIds.every((entityId) => (
    cadCommittedState.scene.entities[entityId].components.cadReference?.sourceUrl === 'fixture.dxf'
  )));
  assert.deepEqual(
    cadCommit.duplicatedIds.map((entityId) => cadCommittedState.scene.entities[entityId].name),
    ['CAD Fixture1', 'CAD Fixture2'],
  );

  const poiArraySource = createPoiEffectEntity('smoke');
  poiArraySource.name = 'POI Fixture';
  const poiCommit = commitSingleSourceArray(poiArraySource, 'POI Array Store Smoke');
  assert.equal(poiCommit.ok, true, 'POI 必须复用正式阵列提交');
  const poiCommittedState = useEditorStore.getState();
  const poiCopies = poiCommit.duplicatedIds.map((entityId) => poiCommittedState.scene.entities[entityId]);
  assert.deepEqual(poiCopies.map((entity) => entity.name), ['POI Fixture1', 'POI Fixture2']);
  assert.deepEqual(
    poiCopies.map((entity) => entity.components.poiEffect),
    [poiArraySource.components.poiEffect, poiArraySource.components.poiEffect],
    'POI 正式副本必须保留完整粒子和动画组件参数',
  );

  const excludedFolder = createFolderEntity('Excluded Folder');
  const excludedLight = createLightEntity('point');
  const excludedGenerator = createModelGeneratorEntity();
  assert.equal(isShiftEntityArraySupported(excludedFolder), false, '文件夹不得触发 Shift 阵列');
  assert.equal(isShiftEntityArraySupported(excludedLight), false, '灯光不得触发 Shift 阵列');
  assert.equal(isShiftEntityArraySupported(excludedGenerator), false, '模型生成器不得触发 Shift 阵列');
  assert.ok(
    [arraySource, locatorArraySource, meshArraySource, cadArraySource, poiArraySource]
      .every(isShiftEntityArraySupported),
    '五类可阵列实体必须全部通过 Shift 支持判定',
  );

  const lockedMesh = createMeshEntity('sphere');
  lockedMesh.locked = true;
  const lockedCommit = commitSingleSourceArray(lockedMesh, 'Locked Array Store Smoke', 1);
  assert.equal(lockedCommit.ok, false, '锁定源对象必须在原子提交阶段被阻止');

  const folderCommit = commitSingleSourceArray(excludedFolder, 'Folder Array Store Smoke', 1);
  assert.equal(folderCommit.ok, false, '文件夹必须在原子提交阶段被阻止');

  const generatorCommit = commitSingleSourceArray(excludedGenerator, 'Generator Array Store Smoke', 1);
  assert.equal(generatorCommit.ok, false, '模型生成器必须在原子提交阶段被阻止');

  const missingScene = createEmptySceneDocument('Missing Array Store Smoke');
  useEditorStore.setState({
    scene: missingScene,
    runtimeMode: 'edit',
    history: { undoStack: [], redoStack: [] },
    hierarchySelectionIds: [],
    entityArrayRequest: null,
  });
  const missingCommit = useEditorStore.getState().commitResolvedEntityArray({
    sourceIds: ['missing-entity'],
    copyCount: 1,
    directionVector: { x: 1, y: 0, z: 0 },
    selectionSpanMeters: 1,
    spacingMeters: 0,
    assetNumberRule: '',
  });
  assert.equal(missingCommit.ok, false, '失效源对象必须在原子提交阶段被阻止');

  console.log(JSON.stringify({
    ok: true,
    modelArray: {
      rotatedNonUniformWorldSpan: worldXGeometry.spanMeters,
      rotatedNonUniformLocalSpan: localXGeometry.spanMeters,
      zeroSpacingPreview: true,
      spacingAndDirectionUpdate: true,
      matrixBatchReuse: true,
      nestedThinInstanceComposition: true,
      sharedGeometryBuffersIsolated: true,
      parameterGeometryRefresh: true,
      mirroredMaterialOrientationPreserved: true,
      mixedDeterminantBatchesPreservePickingAndSelection: true,
      persistentThinInstanceBatch: true,
      independentEntityTransforms: true,
      allModelPreviewUsesMatrix: true,
      thinInstancePickingMapsLogicalEntity: true,
      independentSelectionMask: true,
      sourceResourcesPreserved: true,
      shiftGizmoProxyKeepsSourceStable: true,
      negativeAxisAndCancelLifecycle: true,
      normalTransformDragPreserved: true,
      pointerCancelAndDisposeDoNotCommit: true,
      atomicConflictAndUndoRedo: true,
      supportedRuntimeSources: ['model', 'mesh', 'locator', 'cad-reference', 'poi'],
      poiParticlePreviewUsesBoundsProxy: true,
      typeSpecificIdentityRules: true,
      unsupportedAndInvalidSourcesBlocked: true,
    },
  }, null, 2));
} finally {
  // synthetic 模型条目没有完整 ModelRuntimeEntry 字段，先从私有映射移除，再释放真实 Runtime 资源。
  gizmoController?.dispose();
  if (editorStore && editorStoreSnapshot) editorStore.setState(editorStoreSnapshot, true);
  runtime?.models?.delete(SOURCE_ENTITY_ID);
  runtime?.dispose();
  scene?.dispose();
  engine?.dispose();
  await server?.close();
}
