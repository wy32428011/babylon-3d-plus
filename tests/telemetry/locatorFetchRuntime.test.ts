import assert from 'node:assert/strict';
import test from 'node:test';

import { Color3, Material, Matrix, Mesh, MeshBuilder, NullEngine, Scene, StandardMaterial, TransformNode, Vector3 } from '@babylonjs/core';

import { LocatorFetchRuntime, type FetchContainerRecord } from '../../src/runtime/babylon/LocatorFetchRuntime';
import type { LocatorRuntimeEntry } from '../../src/runtime/babylon/SceneRuntime';
import type { LocatorComponent, ModelGeneratorComponent, ModelGeneratorTarget } from '../../src/editor/model/components';

function createRecord(column: number, layer: number, overrides: Partial<FetchContainerRecord> = {}): FetchContainerRecord {
  return {
    containerCode: `C_${column}_${layer}`,
    containerType: 'box',
    isEmpty: false,
    locType: '',
    row: '1',
    column,
    layer,
    tier: 0,
    stackingRow: '1',
    stackingColumn: column,
    stackingLayer: layer,
    ...overrides,
  };
}

const locatorEntry = { entityId: 'loc1' } as unknown as LocatorRuntimeEntry;
const locatorComponent = { rowNumber: 1, assetId: 'L1' } as unknown as LocatorComponent;

function findBatchMeshes(scene: Scene): Mesh[] {
  return scene.meshes.filter((mesh): mesh is Mesh => mesh instanceof Mesh && mesh.name.startsWith('fetch_batch_loc1_'));
}

test('内置立方体目标：批次几何底部中心锚定原点，实例矩阵即格口矩阵', async () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  try {
    const runtime = new LocatorFetchRuntime(scene, 'loc1');
    const cellMatrix = Matrix.Translation(10, 2, 5);
    await runtime.applyRecords(
      [createRecord(3, 2)],
      locatorEntry,
      locatorComponent,
      null,
      () => cellMatrix,
      () => Promise.reject(new Error('内置几何体目标不应走模型模板加载')),
    );

    const batchMeshes = findBatchMeshes(scene);
    assert.equal(batchMeshes.length, 1);
    const batchMesh = batchMeshes[0];
    const { minimum, maximum } = batchMesh.geometry!.extend;
    assert.ok(Math.abs(minimum.y) < 1e-6, `批次几何 y 最低必须为 0（底部贴原点），实际 ${minimum.y}`);
    assert.ok(Math.abs(maximum.y - 1) < 1e-6, `批次几何 y 最高必须为 1，实际 ${maximum.y}`);
    assert.ok(Math.abs((minimum.x + maximum.x) / 2) < 1e-6, '批次几何 x 必须居中于原点');
    assert.equal(batchMesh.thinInstanceCount, 1);
    const translation = batchMesh.thinInstanceGetWorldMatrices()[0].getTranslation();
    assert.ok(Vector3.Distance(translation, new Vector3(10, 2, 5)) < 1e-6,
      `实例平移必须即格口底面中心 (10,2,5)，实际 (${translation})`);
    runtime.dispose();
  } finally {
    scene.dispose();
    engine.dispose();
  }
});

test('isEmpty 空货位不渲染货物', async () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  try {
    const runtime = new LocatorFetchRuntime(scene, 'loc1');
    await runtime.applyRecords(
      [createRecord(1, 1), createRecord(2, 1, { isEmpty: true }), createRecord(3, 1, { isEmpty: true })],
      locatorEntry,
      locatorComponent,
      null,
      () => Matrix.Identity(),
      () => Promise.reject(new Error('内置几何体目标不应走模型模板加载')),
    );

    const batchMeshes = findBatchMeshes(scene);
    assert.equal(batchMeshes.length, 1);
    assert.equal(batchMeshes[0].thinInstanceCount, 1, '3 条记录中 2 条 isEmpty，只渲染 1 个实例');
    runtime.dispose();
  } finally {
    scene.dispose();
    engine.dispose();
  }
});

test('多材质模型目标：逐 mesh 建批不合并顶点，各自材质保留', async () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  try {
    const materialA = new StandardMaterial('matA', scene);
    materialA.diffuseColor = new Color3(1, 0, 0);
    const materialB = new StandardMaterial('matB', scene);
    materialB.diffuseColor = new Color3(0, 0, 1);
    const boxA = MeshBuilder.CreateBox('boxA', { size: 1 }, scene);
    boxA.position = new Vector3(5, 0.25, 0);
    boxA.material = materialA;
    const boxB = MeshBuilder.CreateBox('boxB', { size: 1 }, scene);
    boxB.position = new Vector3(-2, 1.5, 3);
    boxB.material = materialB;

    const modelTarget: ModelGeneratorTarget = {
      kind: 'model',
      assetId: 'asset1',
      displayName: 'M',
      modelAsset: { sourcePath: 'p', sourceUrl: 'u', assetRevision: null },
    } as unknown as ModelGeneratorTarget;
    const generatorComponent: ModelGeneratorComponent = { defaultTarget: modelTarget, rules: [] };

    const runtime = new LocatorFetchRuntime(scene, 'loc1');
    await runtime.applyRecords(
      [createRecord(1, 1)],
      locatorEntry,
      locatorComponent,
      generatorComponent,
      () => Matrix.Identity(),
      () => Promise.resolve({
        meshes: [boxA, boxB],
        dispose: () => { boxA.dispose(); boxB.dispose(); },
      }),
    );

    const batchMeshes = findBatchMeshes(scene);
    assert.equal(batchMeshes.length, 2, '每个模板 mesh 一个批次 mesh，不合并');
    const materials = batchMeshes.map((mesh) => mesh.material as StandardMaterial | null);
    assert.ok(materials[0] && materials[1], '每个批次 mesh 必须带材质');
    assert.notEqual(materials[0], materials[1], '两个批次材质不得共享');
    assert.ok(!materials.includes(materialA) && !materials.includes(materialB), '批次材质必须是克隆体');
    const colors = materials.map((material) => material!.diffuseColor.toHexString()).sort();
    assert.deepEqual(colors, ['#0000FF', '#FF0000'], '各 mesh 材质颜色必须各自保留');

    const xCenters = batchMeshes
      .map((mesh) => (mesh.geometry!.extend.minimum.x + mesh.geometry!.extend.maximum.x) / 2)
      .sort((a, b) => a - b);
    assert.ok(Math.abs(xCenters[0] - (-2)) < 1e-6, `boxB 顶点世界偏移必须保留（x 中心 -2），实际 ${xCenters[0]}`);
    assert.ok(Math.abs(xCenters[1] - 5) < 1e-6, `boxA 顶点世界偏移必须保留（x 中心 5），实际 ${xCenters[1]}`);
    runtime.dispose();
  } finally {
    scene.dispose();
    engine.dispose();
  }
});

test('GLB 镜像模板：批次 mesh 继承源 sideOrientation（CW），索引绕向已随镜像烘焙翻转', async () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  try {
    // 模拟 glTF loader 产物：__root__ 带 z=-1 镜像，mesh.sideOrientation 被设为 CW
    const glbRoot = new TransformNode('__root__', scene);
    glbRoot.scaling = new Vector3(1, 1, -1);
    const box = MeshBuilder.CreateBox('cargo', { size: 1 }, scene);
    box.parent = glbRoot;
    box.sideOrientation = Material.ClockWiseSideOrientation;
    box.material = new StandardMaterial('cargoMat', scene);
    const sourceIndices = [...box.geometry!.getIndices()!];

    const modelTarget: ModelGeneratorTarget = {
      kind: 'model',
      assetId: 'asset1',
      displayName: 'M',
      modelAsset: { sourcePath: 'p', sourceUrl: 'u', assetRevision: null },
    } as unknown as ModelGeneratorTarget;
    const generatorComponent: ModelGeneratorComponent = { defaultTarget: modelTarget, rules: [] };

    const runtime = new LocatorFetchRuntime(scene, 'loc1');
    await runtime.applyRecords(
      [createRecord(1, 1)],
      locatorEntry,
      locatorComponent,
      generatorComponent,
      () => Matrix.Identity(),
      () => Promise.resolve({
        meshes: [box],
        dispose: () => { box.dispose(); glbRoot.dispose(); },
      }),
    );

    const batchMeshes = findBatchMeshes(scene);
    assert.equal(batchMeshes.length, 1);
    // 烘焙时 VertexData.transform 对负行列式翻转索引绕向，批次 mesh 复制源 sideOrientation 与之抵消；
    // 缺了 sideOrientation 拷贝时镜像模板渲染内外面颠倒（GLB 货格阵列曾踩中）
    assert.equal(batchMeshes[0].sideOrientation, Material.ClockWiseSideOrientation);
    const batchIndices = [...batchMeshes[0].geometry!.getIndices()!];
    assert.equal(batchIndices.length, sourceIndices.length);
    for (let i = 0; i < sourceIndices.length; i += 3) {
      assert.equal(batchIndices[i], sourceIndices[i]);
      assert.equal(batchIndices[i + 1], sourceIndices[i + 2], `三角形 ${i / 3} 绕向必须翻转`);
      assert.equal(batchIndices[i + 2], sourceIndices[i + 1], `三角形 ${i / 3} 绕向必须翻转`);
    }
    runtime.dispose();
  } finally {
    scene.dispose();
    engine.dispose();
  }
});

/** 等一拍宏任务：suppressCell 触发的重放是 fire-and-forget，避免与后续断言竞争。 */
const flushReplay = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const rejectTemplateLoad = () => Promise.reject(new Error('内置几何体目标不应走模型模板加载'));

test('服务端确认该格已空后解除抑制：该格后续入库重新可见', async () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  try {
    const runtime = new LocatorFetchRuntime(scene, 'loc1');
    await runtime.applyRecords(
      [createRecord(3, 2)], locatorEntry, locatorComponent, null, () => Matrix.Identity(), rejectTemplateLoad,
    );

    runtime.suppressCell(3, 2);
    await flushReplay();
    assert.equal(findBatchMeshes(scene).length, 0, '设备接管该格口期间不渲染 fetch 货物');

    // 服务端确认该格已空（本排无该格记录）→ 视为交接完成，解除抑制
    await runtime.applyRecords(
      [], locatorEntry, locatorComponent, null, () => Matrix.Identity(), rejectTemplateLoad,
      { releaseAbsentSuppressedCells: true },
    );
    await runtime.applyRecords(
      [createRecord(3, 2)], locatorEntry, locatorComponent, null, () => Matrix.Identity(), rejectTemplateLoad,
      { releaseAbsentSuppressedCells: true },
    );

    const batchMeshes = findBatchMeshes(scene);
    assert.equal(batchMeshes.length, 1);
    assert.equal(batchMeshes[0].thinInstanceCount, 1, '解除抑制后该格新入库货物必须重新渲染');
    runtime.dispose();
  } finally {
    scene.dispose();
    engine.dispose();
  }
});

test('该排仍有待清算保留货箱时，服务端空数据不解除抑制', async () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  try {
    const runtime = new LocatorFetchRuntime(scene, 'loc1');
    await runtime.applyRecords(
      [createRecord(3, 2)], locatorEntry, locatorComponent, null, () => Matrix.Identity(), rejectTemplateLoad,
    );

    runtime.suppressCell(3, 2);
    await flushReplay();

    // 放货完成瞬间：本排存在保留货箱、单排同步未回，服务端此刻的空数据不可信
    await runtime.applyRecords(
      [], locatorEntry, locatorComponent, null, () => Matrix.Identity(), rejectTemplateLoad,
      { releaseAbsentSuppressedCells: false },
    );
    await runtime.applyRecords(
      [createRecord(3, 2)], locatorEntry, locatorComponent, null, () => Matrix.Identity(), rejectTemplateLoad,
      { releaseAbsentSuppressedCells: false },
    );

    assert.equal(findBatchMeshes(scene).length, 0, '待清算期间解除抑制会与保留货箱双显');
    runtime.dispose();
  } finally {
    scene.dispose();
    engine.dispose();
  }
});

test('抑制时的重放沿用旧数据，不会按“本排无记录”误解除抑制', async () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  try {
    const runtime = new LocatorFetchRuntime(scene, 'loc1');
    // 旧数据：本排没有任何记录
    await runtime.applyRecords(
      [], locatorEntry, locatorComponent, null, () => Matrix.Identity(), rejectTemplateLoad,
    );

    runtime.suppressCell(3, 2);
    await flushReplay();

    // 若重放错误地按“无记录即解除”判定，此处会渲染出接手期间的货物
    await runtime.applyRecords(
      [createRecord(3, 2)], locatorEntry, locatorComponent, null, () => Matrix.Identity(), rejectTemplateLoad,
      { releaseAbsentSuppressedCells: true },
    );

    assert.equal(findBatchMeshes(scene).length, 0, '重放不得解除抑制');
    runtime.dispose();
  } finally {
    scene.dispose();
    engine.dispose();
  }
});
