import assert from 'node:assert/strict';
import test from 'node:test';

import {
  Matrix,
  MeshBuilder,
  NullEngine,
  Quaternion,
  Scene,
  Vector3,
} from '@babylonjs/core';
import {
  combineManualRoamCollisionBoundsResolvers,
  createManualRoamCompactMeshCollisionBoundsResolver,
  createManualRoamModelArrayCollisionBoundsResolver,
  createManualRoamThinInstanceCollisionBoundsResolver,
  isManualRoamModelArrayThinInstanceMesh,
  selectNearestCandidates,
} from '../../src/runtime/roam/manualRoamCollisionBounds.ts';

test('模型阵列碰撞查询只返回人物邻域内可见且几何就绪的实体', () => {
  const entities = {
    near: {
      id: 'near',
      name: 'near',
      parentId: null,
      isFolder: false,
      visible: true,
      locked: false,
      components: {
        transform: { position: { x: 2, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
        modelArrayInstance: { sourceEntityId: 'source' },
      },
    },
    hidden: {
      id: 'hidden',
      name: 'hidden',
      parentId: null,
      isFolder: false,
      visible: false,
      locked: false,
      components: {
        transform: { position: { x: 1, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
        modelArrayInstance: { sourceEntityId: 'source' },
      },
    },
    notReady: {
      id: 'notReady',
      name: 'notReady',
      parentId: null,
      isFolder: false,
      visible: true,
      locked: false,
      components: {
        transform: { position: { x: 3, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
        modelArrayInstance: { sourceEntityId: 'source' },
      },
    },
  } as const;
  const resolver = createManualRoamModelArrayCollisionBoundsResolver({
    getSceneDocument: () => ({ entities, entityIds: ['near', 'hidden', 'notReady'] }) as never,
    getRuntime: () => ({
      getEntitiesWorldBounds: ([entityId]) => entityId === 'near'
        ? {
          center: { x: 2, y: 1, z: 0 },
          sizeMeters: { x: 2, y: 2, z: 2 },
          geometryReady: true,
          resolvedEntityCount: 1,
        }
        : {
          center: { x: 3, y: 1, z: 0 },
          sizeMeters: { x: 2, y: 2, z: 2 },
          geometryReady: false,
          resolvedEntityCount: 0,
        },
    }),
  });

  assert.deepEqual(resolver({ x: 0, y: 1, z: 0 }, 4), [{
    id: 'near',
    minimum: { x: 1, y: 0, z: -1 },
    maximum: { x: 3, y: 2, z: 1 },
  }]);
});

test('候选预筛使用有界最大堆并稳定返回最近实体', () => {
  const candidates = Array.from({ length: 100 }, (_, index) => ({
    entityId: `entity-${String(index).padStart(3, '0')}`,
    position: { x: index, y: 0, z: 0 },
  }));

  assert.deepEqual(
    selectNearestCandidates(candidates, { x: 10.2, y: 0, z: 0 }, 100, 3).map(({ entityId }) => entityId),
    ['entity-010', 'entity-011', 'entity-009'],
  );
});

test('模型阵列的源实体也进入碰撞候选，避免批次首实例失去碰撞', () => {
  const source = {
    id: 'source',
    name: 'source',
    parentId: null,
    isFolder: false,
    visible: true,
    locked: false,
    components: {
      transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
    },
  } as const;
  const instance = {
    ...source,
    id: 'instance',
    name: 'instance',
    components: {
      ...source.components,
      transform: { ...source.components.transform, position: { x: 4, y: 0, z: 0 } },
      modelArrayInstance: { sourceEntityId: 'source' },
    },
  } as const;
  const resolver = createManualRoamModelArrayCollisionBoundsResolver({
    getSceneDocument: () => ({ entities: { source, instance }, entityIds: ['source', 'instance'] }) as never,
    getRuntime: () => ({
      getEntitiesWorldBounds: ([entityId]) => ({
        center: { x: entityId === 'source' ? 0 : 4, y: 1, z: 0 },
        sizeMeters: { x: 2, y: 2, z: 2 },
        geometryReady: true,
        resolvedEntityCount: 1,
      }),
    }),
  });

  assert.deepEqual(
    resolver({ x: 0, y: 1, z: 0 }, 8).map(({ id }) => id),
    ['source', 'instance'],
  );
});

test('非模型阵列 thin instance 按实例矩阵和 Mesh 世界矩阵生成邻域 AABB', () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const mesh = MeshBuilder.CreateBox('gpu-instanced-wall', { size: 2 }, scene);
  mesh.position.x = 10;
  mesh.thinInstanceSetBuffer('matrix', new Float32Array(Matrix.Compose(
    new Vector3(2, 1, 0.5),
    Quaternion.Identity(),
    new Vector3(5, 1, 0),
  ).m), 16, true);
  mesh.computeWorldMatrix(true);

  const resolver = createManualRoamThinInstanceCollisionBoundsResolver({
    getMeshes: () => scene.meshes,
  });

  assert.deepEqual(resolver({ x: 15, y: 1, z: 0 }, 4), [{
    id: `thin:${mesh.uniqueId}:0`,
    minimum: { x: 13, y: 0, z: -0.5 },
    maximum: { x: 17, y: 2, z: 0.5 },
  }]);
  assert.deepEqual(resolver({ x: 0, y: 0, z: 0 }, 2), []);

  scene.dispose();
  engine.dispose();
});

test('thin instance 对偏心几何和旋转矩阵生成正确世界 AABB', () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const mesh = MeshBuilder.CreateBox('offset-rotated-instance', { size: 2 }, scene);
  mesh.bakeTransformIntoVertices(Matrix.Translation(2, 1, 0));
  mesh.thinInstanceSetBuffer('matrix', new Float32Array(Matrix.Compose(
    Vector3.One(),
    Quaternion.RotationAxis(Vector3.Up(), Math.PI / 2),
    new Vector3(10, 0, 5),
  ).m), 16, true);

  const resolver = createManualRoamThinInstanceCollisionBoundsResolver({
    getMeshes: () => scene.meshes,
  });
  const [bounds] = resolver({ x: 10, y: 1, z: 3 }, 3);
  assert.ok(bounds);
  assert.equal(bounds.id, `thin:${mesh.uniqueId}:0`);
  assert.deepEqual(
    [bounds.minimum.x, bounds.minimum.y, bounds.maximum.x, bounds.maximum.y, bounds.maximum.z],
    [9, 0, 11, 2, 4],
  );
  assert.ok(Math.abs(bounds.minimum.z - 2) < 1e-12);

  scene.dispose();
  engine.dispose();
});

test('模型阵列 thin instance 可由实体级代理独占，避免重复创建逐 primitive 代理', () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const mesh = MeshBuilder.CreateBox('__modelArrayThinInstance_0', { size: 1 }, scene);
  mesh.metadata = { modelArraySourceEntityId: 'source' };
  mesh.thinInstanceSetBuffer('matrix', new Float32Array(Matrix.Identity().m), 16, true);

  assert.equal(isManualRoamModelArrayThinInstanceMesh(mesh), true);
  const resolver = createManualRoamThinInstanceCollisionBoundsResolver({
    getMeshes: () => scene.meshes,
    excludeMesh: isManualRoamModelArrayThinInstanceMesh,
  });
  assert.deepEqual(resolver({ x: 0, y: 0, z: 0 }, 4), []);

  scene.dispose();
  engine.dispose();
});

test('紧凑高模按世界 AABB 进入邻域代理，厂区级地面不走实心盒子', () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const machine = MeshBuilder.CreateSphere('compact-machine', { diameter: 2, segments: 48 }, scene);
  machine.position.x = 3;
  machine.computeWorldMatrix(true);
  const floor = MeshBuilder.CreateGround('factory-floor', {
    width: 80,
    height: 80,
    subdivisions: 64,
  }, scene);
  floor.computeWorldMatrix(true);
  const resolver = createManualRoamCompactMeshCollisionBoundsResolver({
    getMeshes: () => scene.meshes,
  });

  const nearby = resolver({ x: 0, y: 1, z: 0 }, 8);
  assert.equal(nearby.length, 1);
  assert.equal(nearby[0].id, `mesh:${machine.uniqueId}`);
  assert.deepEqual(resolver({ x: 40, y: 1, z: 40 }, 4), []);
  assert.ok(floor.getBoundingInfo().boundingBox.maximumWorld.x - floor.getBoundingInfo().boundingBox.minimumWorld.x > 8);

  scene.dispose();
  engine.dispose();
});

test('CAD LinesMesh thin instance 不进入实体碰撞扫描', () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const mesh = MeshBuilder.CreateLines('cad-reference-lines', {
    points: [Vector3.Zero(), new Vector3(10, 0, 0)],
  }, scene);
  mesh.thinInstanceSetBuffer('matrix', new Float32Array(Matrix.Identity().m), 16, true);

  const resolver = createManualRoamThinInstanceCollisionBoundsResolver({
    getMeshes: () => scene.meshes,
  });
  assert.deepEqual(resolver({ x: 0, y: 0, z: 0 }, 24), []);

  scene.dispose();
  engine.dispose();
});

test('thin instance 矩阵缓冲原地更新后使用最新数据，不读取 Babylon 旧 worldMatrices 缓存', () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const mesh = MeshBuilder.CreateBox('dynamic-thin-instance', { size: 1 }, scene);
  const matrixData = new Float32Array(Matrix.Translation(1, 0.5, 0).m);
  mesh.thinInstanceSetBuffer('matrix', matrixData, 16, false);
  mesh.thinInstanceGetWorldMatrices();
  Matrix.Translation(8, 0.5, 0).copyToArray(matrixData, 0);
  mesh.thinInstanceBufferUpdated('matrix');
  mesh.thinInstanceRefreshBoundingInfo(true);

  const resolver = createManualRoamThinInstanceCollisionBoundsResolver({
    getMeshes: () => scene.meshes,
  });
  assert.deepEqual(resolver({ x: 8, y: 0.5, z: 0 }, 2), [{
    id: `thin:${mesh.uniqueId}:0`,
    minimum: { x: 7.5, y: 0, z: -0.5 },
    maximum: { x: 8.5, y: 1, z: 0.5 },
  }]);
  assert.deepEqual(resolver({ x: 1, y: 0.5, z: 0 }, 1), []);

  scene.dispose();
  engine.dispose();
});

test('thin instance 碰撞上限使用稳定距离排序保留最近实例', () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const mesh = MeshBuilder.CreateBox('ranked-thin-instances', { size: 1 }, scene);
  const positions = [5, 2, 4, 1, 3];
  const matrices = new Float32Array(positions.length * 16);
  positions.forEach((x, index) => Matrix.Translation(x, 0.5, 0).copyToArray(matrices, index * 16));
  mesh.thinInstanceSetBuffer('matrix', matrices, 16, true);

  const resolver = createManualRoamThinInstanceCollisionBoundsResolver({
    getMeshes: () => scene.meshes,
    maxColliders: 3,
  });
  assert.deepEqual(
    resolver({ x: 0, y: 0.5, z: 0 }, 10).map(({ id }) => id),
    [`thin:${mesh.uniqueId}:3`, `thin:${mesh.uniqueId}:1`, `thin:${mesh.uniqueId}:4`],
  );

  scene.dispose();
  engine.dispose();
});

test('远处 thin instance 批次通过聚合包围盒跳过逐实例矩阵解析', () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const mesh = MeshBuilder.CreateBox('far-thin-instance-batch', { size: 1 }, scene);
  const matrices = new Float32Array(256 * 16);
  for (let index = 0; index < 256; index += 1) {
    Matrix.Translation(10_000 + index, 0.5, 0).copyToArray(matrices, index * 16);
  }
  mesh.thinInstanceSetBuffer('matrix', matrices, 16, true);
  const storage = mesh._thinInstanceDataStorage;
  const originalMatrixData = storage.matrixData;
  storage.matrixData = new Proxy(matrices, {
    get() {
      throw new Error('远处批次不应读取逐实例矩阵');
    },
  }) as unknown as Float32Array;

  const resolver = createManualRoamThinInstanceCollisionBoundsResolver({
    getMeshes: () => scene.meshes,
  });
  assert.deepEqual(resolver({ x: 0, y: 0, z: 0 }, 24), []);

  storage.matrixData = originalMatrixData;
  scene.dispose();
  engine.dispose();
});

test('组合解析器按距离筛选并去重，避免模型阵列结果挤占更近的普通 thin instance', () => {
  const resolver = combineManualRoamCollisionBoundsResolvers([
    () => [
      { id: 'far', minimum: { x: 8, y: 0, z: 0 }, maximum: { x: 9, y: 1, z: 1 } },
      { id: 'duplicate', minimum: { x: 4, y: 0, z: 0 }, maximum: { x: 5, y: 1, z: 1 } },
    ],
    () => [
      { id: 'near', minimum: { x: 1, y: 0, z: 0 }, maximum: { x: 2, y: 1, z: 1 } },
      { id: 'duplicate', minimum: { x: 3, y: 0, z: 0 }, maximum: { x: 4, y: 1, z: 1 } },
    ],
  ], 2);

  assert.deepEqual(
    resolver({ x: 0, y: 0.5, z: 0.5 }, 10).map(({ id }) => id),
    ['near', 'duplicate'],
  );
});

test('大型阵列实例的轴心在预筛半径外时，包围盒边缘仍能进入碰撞候选', () => {
  const source = {
    id: 'source',
    name: 'source',
    parentId: null,
    isFolder: false,
    visible: false,
    locked: false,
    components: {
      transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
    },
  } as const;
  const instance = {
    ...source,
    id: 'large-instance',
    name: 'large-instance',
    visible: true,
    components: {
      ...source.components,
      transform: { ...source.components.transform, position: { x: 100, y: 0, z: 0 }, scale: { x: 100, y: 1, z: 100 } },
      modelArrayInstance: { sourceEntityId: 'source' },
    },
  } as const;
  const resolver = createManualRoamModelArrayCollisionBoundsResolver({
    getSceneDocument: () => ({ entities: { source, 'large-instance': instance }, entityIds: ['source', 'large-instance'] }) as never,
    getRuntime: () => ({
      getEntitiesWorldBounds: ([entityId]) => entityId === 'source'
        ? {
          center: { x: 0, y: 1, z: 0 },
          sizeMeters: { x: 2, y: 2, z: 2 },
          radiusMeters: Math.sqrt(3),
          geometryReady: true,
          resolvedEntityCount: 1,
        }
        : {
          center: { x: 100, y: 1, z: 0 },
          sizeMeters: { x: 200, y: 2, z: 200 },
          radiusMeters: Math.sqrt(20_001),
          geometryReady: true,
          resolvedEntityCount: 1,
        },
    }),
    centerPrefilterMarginMeters: 0,
  });

  assert.deepEqual(resolver({ x: 0, y: 1, z: 0 }, 5).map(({ id }) => id), ['large-instance']);
});
