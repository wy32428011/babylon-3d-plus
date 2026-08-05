import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DirectionalLight,
  HemisphericLight,
  MeshBuilder,
  NullEngine,
  PointLight,
  Scene,
  TransformNode,
  Vector3,
} from '@babylonjs/core';

import { SceneShadowRuntime } from '../../src/runtime/babylon/SceneShadowRuntime.ts';

function createRuntimeFixture(): { engine: NullEngine; scene: Scene; runtime: SceneShadowRuntime } {
  const engine = new NullEngine({ renderWidth: 640, renderHeight: 360 });
  const scene = new Scene(engine);
  const runtime = new SceneShadowRuntime(scene);
  return { engine, scene, runtime };
}

function disposeRuntimeFixture(fixture: ReturnType<typeof createRuntimeFixture>): void {
  fixture.runtime.dispose();
  fixture.scene.dispose();
  fixture.engine.dispose();
}

for (const lightKind of ['directional', 'point'] as const) {
  test(`${lightKind} 光会为已有 Mesh 创建阴影投射和接收链路`, () => {
    const fixture = createRuntimeFixture();
    try {
      const ground = MeshBuilder.CreateGround('Ground', { width: 8, height: 8 }, fixture.scene);
      const cube = MeshBuilder.CreateBox('Cube', { size: 1 }, fixture.scene);
      cube.position.y = 0.5;
      const light = lightKind === 'directional'
        ? new DirectionalLight('Directional', new Vector3(0, -1, 0), fixture.scene)
        : new PointLight('Point', new Vector3(0, 4, 0), fixture.scene);

      fixture.runtime.syncLight(light.name, light);

      const shadowGenerator = light.getShadowGenerator();
      assert.ok(shadowGenerator, '支持阴影的场景灯光必须创建 ShadowGenerator');
      const renderList = shadowGenerator.getShadowMap()?.renderList ?? [];
      for (const mesh of [ground, cube]) {
        assert.equal(mesh.receiveShadows, true, `${mesh.name} 必须接收阴影`);
        assert.ok(renderList.includes(mesh), `${mesh.name} 必须加入阴影投射列表`);
      }
    } finally {
      disposeRuntimeFixture(fixture);
    }
  });
}

test('灯光创建后异步加入场景的 Mesh 也会自动参与阴影', () => {
  const fixture = createRuntimeFixture();
  try {
    const light = new DirectionalLight('Directional', new Vector3(0, -1, 0), fixture.scene);
    fixture.runtime.syncLight(light.name, light);
    const shadowGenerator = light.getShadowGenerator();
    assert.ok(shadowGenerator);

    const lateMesh = MeshBuilder.CreateBox('AsyncLoadedMesh', { size: 1 }, fixture.scene);
    fixture.scene.onBeforeRenderObservable.notifyObservers(fixture.scene);
    assert.equal(lateMesh.receiveShadows, true);
    assert.ok(shadowGenerator.getShadowMap()?.renderList?.includes(lateMesh));
  } finally {
    disposeRuntimeFixture(fixture);
  }
});

test('编辑器网格和天空盒不会污染阴影贴图', () => {
  const fixture = createRuntimeFixture();
  try {
    const editorGrid = MeshBuilder.CreateGround('EditorGroundGrid', { width: 8, height: 8 }, fixture.scene);
    const skybox = MeshBuilder.CreateSphere('Skybox', { diameter: 100 }, fixture.scene);
    skybox.metadata = { editorSkyboxSphere: true };
    const light = new DirectionalLight('Directional', new Vector3(0, -1, 0), fixture.scene);

    fixture.runtime.syncLight(light.name, light);

    const renderList = light.getShadowGenerator()?.getShadowMap()?.renderList ?? [];
    assert.equal(editorGrid.receiveShadows, false);
    assert.equal(skybox.receiveShadows, false);
    assert.equal(renderList.includes(editorGrid), false);
    assert.equal(renderList.includes(skybox), false);
  } finally {
    disposeRuntimeFixture(fixture);
  }
});

test('编辑辅助 Mesh 不会产生实心假阴影', () => {
  const fixture = createRuntimeFixture();
  try {
    const helperMeshes = [
      'entity_locatorRoot',
      'entity_modelGeneratorMarkerRoot',
      'entity_poiEffectRoot',
    ].map((rootName, index) => {
      const root = new TransformNode(rootName, fixture.scene);
      const mesh = MeshBuilder.CreateBox(`EditorHelper_${index}`, { size: 1 }, fixture.scene);
      mesh.parent = root;
      return mesh;
    });
    const light = new DirectionalLight('Directional', new Vector3(0, -1, 0), fixture.scene);

    fixture.runtime.syncLight(light.name, light);

    const renderList = light.getShadowGenerator()?.getShadowMap()?.renderList ?? [];
    for (const mesh of helperMeshes) {
      assert.equal(mesh.receiveShadows, false);
      assert.equal(renderList.includes(mesh), false);
    }
  } finally {
    disposeRuntimeFixture(fixture);
  }
});

test('半球光保持环境补光，不创建 Babylon 不支持的阴影生成器', () => {
  const fixture = createRuntimeFixture();
  try {
    const light = new HemisphericLight('Hemispheric', new Vector3(0, 1, 0), fixture.scene);
    fixture.runtime.syncLight(light.name, light);
    assert.equal(light.getShadowGenerator(), null);
  } finally {
    disposeRuntimeFixture(fixture);
  }
});

test('删除灯光时会同步释放对应阴影生成器', () => {
  const fixture = createRuntimeFixture();
  try {
    const light = new DirectionalLight('Directional', new Vector3(0, -1, 0), fixture.scene);
    fixture.runtime.syncLight('entity-light', light);
    assert.ok(light.getShadowGenerator());

    fixture.runtime.removeLight('entity-light');
    assert.equal(light.getShadowGenerator(), null);
  } finally {
    disposeRuntimeFixture(fixture);
  }
});
