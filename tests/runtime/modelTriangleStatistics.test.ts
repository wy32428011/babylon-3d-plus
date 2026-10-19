import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AssetContainer,
  Material,
  Matrix,
  Mesh,
  MeshBuilder,
  MultiMaterial,
  NullEngine,
  Scene,
  StandardMaterial,
  SubMesh,
  TransformNode,
  Vector3,
  VertexBuffer,
} from '@babylonjs/core';
import { countModelMeshTriangles } from '../../src/runtime/babylon/modelTriangleStatistics.ts';

function withScene(run: (scene: Scene) => void): void {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  try { run(scene); } finally { scene.dispose(); engine.dispose(); }
}

test('普通三角网格只读取几何计数元数据，双面、隐藏与变换不改变12面立方体', () => {
  withScene((scene) => {
    const root = new TransformNode('hidden-entity-root', scene);
    root.setEnabled(false);
    const box = MeshBuilder.CreateBox('box', {}, scene);
    box.parent = root;
    box.isVisible = false;
    box.visibility = 0;
    box.position.set(1, 2, 3);
    box.scaling.set(2, 3, 4);
    box.material = new StandardMaterial('double-sided', scene);
    box.material.backFaceCulling = false;
    box.getIndices = () => { throw new Error('禁止读取完整索引'); };
    box.getVerticesData = () => { throw new Error('禁止读取完整顶点'); };
    assert.equal(countModelMeshTriangles(box), 12);
    box.getIndices = () => null;
    box.getVerticesData = () => null;
  });
});

test('无索引几何按顶点数计算，空网格与已释放网格为0', () => {
  withScene((scene) => {
    const mesh = new Mesh('unindexed', scene);
    mesh.setVerticesData(VertexBuffer.PositionKind, [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 0, 0, 1, 0]);
    mesh.isUnIndexed = true;
    assert.equal(countModelMeshTriangles(mesh), 2);
    assert.equal(countModelMeshTriangles(new Mesh('empty', scene)), 0);
    mesh.dispose();
    assert.equal(countModelMeshTriangles(mesh), 0);
  });
});

test('线与点拓扑不计面，线框材质仍统计底层三角面', () => {
  withScene((scene) => {
    const lines = MeshBuilder.CreateLines('lines', { points: [Vector3.Zero(), Vector3.One(), new Vector3(2, 0, 0)] }, scene);
    assert.equal(countModelMeshTriangles(lines), 0);
    const mesh = MeshBuilder.CreateBox('box', {}, scene);
    const material = new StandardMaterial('draw-mode', scene);
    mesh.material = material;
    for (const mode of [Material.PointFillMode, Material.PointListDrawMode, Material.LineListDrawMode, Material.LineLoopDrawMode, Material.LineStripDrawMode]) {
      material.fillMode = mode;
      assert.equal(countModelMeshTriangles(mesh), 0, `draw mode ${mode}`);
    }
    material.fillMode = Material.WireFrameFillMode;
    assert.equal(countModelMeshTriangles(mesh), 12);
  });
});

test('混合材质仅累计三角子网格，三角带与扇形按拓扑元数据换算', () => {
  withScene((scene) => {
    const mesh = MeshBuilder.CreateBox('mixed', {}, scene);
    const triangles = new StandardMaterial('triangles', scene);
    const lines = new StandardMaterial('lines', scene);
    lines.fillMode = Material.LineListDrawMode;
    const materials = new MultiMaterial('mixed-materials', scene);
    materials.subMaterials = [triangles, lines];
    mesh.material = materials;
    mesh.releaseSubMeshes();
    new SubMesh(0, 0, 24, 0, 18, mesh);
    new SubMesh(1, 0, 24, 18, 18, mesh);
    assert.equal(countModelMeshTriangles(mesh), 6);
    triangles.fillMode = Material.TriangleStripDrawMode;
    assert.equal(countModelMeshTriangles(mesh), 16);
    triangles.fillMode = Material.TriangleFanDrawMode;
    assert.equal(countModelMeshTriangles(mesh), 16);
  });
});

test('原生薄实例按已登记数量计数且不额外加源，常规实例单独统计一份', () => {
  withScene((scene) => {
    scene.getEngine().getCaps().instancedArrays = true;
    const source = MeshBuilder.CreateBox('thin-source', {}, scene);
    source.thinInstanceAdd([Matrix.Identity(), Matrix.Translation(1, 0, 0), Matrix.Translation(2, 0, 0)]);
    assert.equal(countModelMeshTriangles(source), 36, '动态扩容容量不可误当成实例总数');
    assert.equal(countModelMeshTriangles(source, { includeThinInstances: false }), 12);
    const normalSource = MeshBuilder.CreateBox('instance-source', {}, scene);
    const instance = normalSource.createInstance('instance');
    assert.equal(countModelMeshTriangles(instance), 12);
    assert.equal(countModelMeshTriangles(normalSource), 12, '源网格不重复累计常规实例');
  });
});

test('LOD仅计主模型且不随相机切换，效果代理与明确编辑辅助排除', () => {
  withScene((scene) => {
    const source = MeshBuilder.CreateBox('main', {}, scene);
    const lod = MeshBuilder.CreatePlane('lod', {}, scene);
    source.addLODLevel(10, lod);
    assert.equal(countModelMeshTriangles(source), 12);
    assert.equal(countModelMeshTriangles(lod), 0);
    for (const metadata of [
      { digitalTwinEffectProxy: true }, { effectBoundsProxy: true }, { effectRole: 'arrow' },
      { editorGroundGrid: true }, { editorOverlay: true }, { editorSkyboxSphere: true },
      { editorShadowCatcher: true }, { editorAutoPatrolMarker: true }, { editorManualRoamSpawn: true },
      { editorChartMarker: true },
    ]) {
      source.metadata = metadata;
      assert.equal(countModelMeshTriangles(source), 0, JSON.stringify(metadata));
    }
    source.metadata = { editorEnvironmentMesh: true };
    assert.equal(countModelMeshTriangles(source), 12);
  });
});

test('环境运行时快照复用同一口径，隐藏环境保留总量并排除线点与备用LOD', async () => {
  const { existsSync, readFileSync } = await import('node:fs');
  const { registerHooks } = await import('node:module');
  const ts = await import('typescript');
  const projectRoot = new URL('../../', import.meta.url);
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      if (specifier.startsWith('@babylonjs/core/') && !specifier.endsWith('.js')) return next(`${specifier}.js`, context);
      if (specifier.startsWith('lodash/') && !specifier.endsWith('.js')) return next(`${specifier}.js`, context);
      if (specifier.startsWith('.') && context.parentURL?.startsWith(projectRoot.href)) {
        const url = new URL(specifier, context.parentURL);
        const sourceUrl = new URL(url.href.replace(/\.js$/, '') + '.ts');
        if (!existsSync(url) && existsSync(sourceUrl)) return next(sourceUrl.href, context);
      }
      return next(specifier, context);
    },
    load(url, context, next) {
      if (url.startsWith(projectRoot.href) && /\.(png|jpg|webp|bin)(\?.*)?$/.test(url)) {
        return { format: 'module', shortCircuit: true, source: `export default ${JSON.stringify(url)};` };
      }
      if (url.startsWith(projectRoot.href) && url.endsWith('.ts')) {
        return { format: 'module', shortCircuit: true, source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
          compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
        }).outputText };
      }
      return next(url, context);
    },
  });
  let SceneEnvironmentRuntime;
  try { ({ SceneEnvironmentRuntime } = await import('../../src/runtime/babylon/SceneEnvironmentRuntime.ts')); }
  finally { hooks.deregister(); }

  const engine = new NullEngine();
  const scene = new Scene(engine);
  try {
    const container = new AssetContainer(scene);
    const thin = MeshBuilder.CreateBox('thin', {}, scene);
    thin.thinInstanceSetBuffer('matrix', new Float32Array([
      ...Matrix.Identity().asArray(), ...Matrix.Translation(2, 0, 0).asArray(), ...Matrix.Translation(4, 0, 0).asArray(),
    ]), 16);
    const main = MeshBuilder.CreateBox('main', {}, scene);
    const lod = MeshBuilder.CreatePlane('lod', {}, scene);
    main.addLODLevel(10, lod);
    const point = MeshBuilder.CreateBox('point', {}, scene);
    point.material = new StandardMaterial('point-material', scene);
    point.material.fillMode = Material.PointListDrawMode;
    const line = MeshBuilder.CreateLines('line', { points: [Vector3.Zero(), Vector3.One(), new Vector3(2, 0, 0)] }, scene);
    container.meshes.push(thin, main, main.createInstance('instance'), lod, point, line);
    const runtime = new SceneEnvironmentRuntime(scene, {
      resolveAssetUrl: (value: string) => value,
      loadAssetContainer: async () => container,
    });
    const sourceUrl = 'editor-asset://local/statistics.glb';
    const result = await runtime.apply({
      packagePath: 'C:/environment', lengthUnit: 'meter', unitScaleToMeters: 1,
      placementMode: 'scene-base', displayName: '环境', activeVariantUrl: sourceUrl,
      variants: [{ name: '默认', sourcePath: 'C:/environment/statistics.glb', sourceUrl }],
      visible: false, opacity: 0,
      transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: 1 },
    }, { requestId: null, autoAlign: false });
    assert.equal(result.snapshot.phase, 'ready');
    assert.equal(result.snapshot.statistics?.triangleCount, 60);
  } finally { scene.dispose(); engine.dispose(); }
});
