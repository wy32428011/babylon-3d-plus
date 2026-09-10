import assert from 'node:assert/strict';
import { MeshBuilder, NullEngine, Scene, TransformNode } from '@babylonjs/core';
import { freezeEnvironmentTransforms } from '../src/runtime/babylon/environmentTransformPreparation.ts';
import { getModelTransformNodes } from '../src/runtime/babylon/runtimeNodeGeometry.ts';

// 确定性 Babylon NullEngine 夹具，只衡量加载准备的 CPU 工作，不代表业务场景 FPS 或 GPU 首帧。
const engine = new NullEngine();
const scene = new Scene(engine);
const report = { scope: 'null-engine-load-preparation-fixture', environment: {}, modelTraversal: {} };
const elapsed = (task) => { const start = performance.now(); task(); return performance.now() - start; };
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

try {
  const root = new TransformNode('environment', scene);
  const parents = [root];
  for (let depth = 1; depth < 24; depth++) {
    const node = new TransformNode(`environment-level-${depth}`, scene);
    node.parent = parents.at(-1);
    node.position.set(0.2, 0.1, -0.3);
    node.rotation.y = 0.02;
    parents.push(node);
  }
  const meshes = Array.from({ length: 1_200 }, (_, index) => {
    const mesh = MeshBuilder.CreateBox(`environment-part-${index}`, { size: 2 }, scene);
    mesh.parent = parents.at(-1);
    mesh.position.set(index % 40, 0, Math.floor(index / 40));
    return mesh;
  });
  const nodes = [root, ...meshes, ...parents.slice(1)];
  const expected = meshes.map(mesh => Array.from(mesh.computeWorldMatrix(true).m));
  const vertexCount = meshes.reduce((sum, mesh) => sum + mesh.getTotalVertices(), 0);
  let updates = 0;
  const observers = nodes.map(node => node.onAfterWorldMatrixUpdateObservable.add(() => { updates++; }));
  const legacyFreeze = () => {
    for (const node of nodes) { node.computeWorldMatrix(true); node.freezeWorldMatrix(); }
  };
  const runFreeze = (freeze) => {
    for (const node of nodes) node.unfreezeWorldMatrix();
    updates = 0;
    const durationMs = elapsed(freeze);
    return { durationMs, matrixUpdates: updates };
  };
  const baseline = [], optimized = [];
  const baselineMatrixUpdates = runFreeze(legacyFreeze).matrixUpdates;
  const optimizedMatrixUpdates = runFreeze(() => freezeEnvironmentTransforms(nodes)).matrixUpdates;
  nodes.forEach((node, index) => node.onAfterWorldMatrixUpdateObservable.remove(observers[index]));
  for (let sample = 0; sample < 5; sample++) {
    baseline.push(runFreeze(legacyFreeze));
    optimized.push(runFreeze(() => freezeEnvironmentTransforms(nodes)));
  }
  meshes.forEach((mesh, index) => assert.deepEqual(Array.from(mesh.getWorldMatrix().m), expected[index]));
  assert.equal(meshes.reduce((sum, mesh) => sum + mesh.getTotalVertices(), 0), vertexCount);
  assert.equal(optimizedMatrixUpdates, nodes.length);
  assert.ok(baselineMatrixUpdates > optimizedMatrixUpdates * 10);
  report.environment = {
    meshCount: meshes.length, transformDepth: parents.length, vertexCount,
    baselineMedianMs: median(baseline.map(item => item.durationMs)),
    optimizedMedianMs: median(optimized.map(item => item.durationMs)),
    baselineMatrixUpdates, optimizedMatrixUpdates,
    geometryAndWorldMatricesPreserved: true,
  };

  const models = Array.from({ length: 300 }, (_, index) => {
    const modelRoot = new TransformNode(`model-${index}`, scene);
    const contentRoot = new TransformNode(`content-${index}`, scene);
    contentRoot.parent = modelRoot;
    for (let part = 0; part < 6; part++) {
      const node = new TransformNode(`part-${part}`, scene);
      node.parent = contentRoot;
    }
    return { root: modelRoot, contentRoot, meshes: [] };
  });
  for (let index = 0; index < 10_000; index++) new TransformNode(`unrelated-${index}`, scene);
  const legacyNodes = (model) => [...new Set([
    model.contentRoot, ...model.root.getChildTransformNodes(false), ...model.meshes,
    ...scene.transformNodes, ...scene.meshes,
  ].filter(node => node !== model.root && node.isDescendantOf?.(model.root)))];
  for (const model of models) assert.deepEqual(getModelTransformNodes(model, scene), legacyNodes(model));
  const baselineQuery = [], optimizedQuery = [];
  for (let sample = 0; sample < 5; sample++) {
    baselineQuery.push(elapsed(() => models.forEach(legacyNodes)));
    optimizedQuery.push(elapsed(() => models.forEach(model => getModelTransformNodes(model, scene))));
  }
  report.modelTraversal = {
    queriedModelCount: models.length,
    sceneNodeCount: scene.transformNodes.length + scene.meshes.length,
    baselineMedianMs: median(baselineQuery), optimizedMedianMs: median(optimizedQuery),
    subtreeAndOrderPreserved: true,
  };
  console.log(JSON.stringify(report, null, 2));
} finally { scene.dispose(); engine.dispose(); }
