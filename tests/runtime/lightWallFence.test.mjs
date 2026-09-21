import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { Constants, MeshBuilder, NullEngine, Ray, Scene, Vector3 } from '@babylonjs/core';
import ts from 'typescript';

const SOURCE_ROOT = new URL('../../src/', import.meta.url);

// 内存转译避免依赖整库预构建，也不生成需要清理的临时文件或目录。
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && context.parentURL?.startsWith(SOURCE_ROOT.href)) {
      const candidate = new URL(specifier, context.parentURL);
      const typescriptCandidate = new URL(`${candidate.href}.ts`);
      if (!existsSync(candidate) && existsSync(typescriptCandidate)) {
        return nextResolve(typescriptCandidate.href, context);
      }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith(SOURCE_ROOT.href) && url.endsWith('.ts')) {
      const source = ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
      }).outputText;
      return { format: 'module', source, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

let PoiEffectRuntime;
let sanitizePoiEffectComponent;
try {
  ({ PoiEffectRuntime } = await import(new URL('runtime/babylon/effects/PoiEffectRuntime.ts', SOURCE_ROOT).href));
  ({ sanitizePoiEffectComponent } = await import(new URL('editor/model/poiEffect.ts', SOURCE_ROOT).href));
} finally {
  hooks.deregister();
}

function createHarness(t, overrides = {}) {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const originalObservers = [...scene.onBeforeRenderObservable.observers];
  const runtime = new PoiEffectRuntime(scene);
  let milliseconds = 0;
  // 固定动画时钟，不以真实等待时间判断零速和暂停行为。
  runtime.now = () => milliseconds;
  const entity = {
    id: 'light-wall-test',
    components: {
      poiEffect: sanitizePoiEffectComponent({
        effectKind: 'light-wall-fence', enabled: true, primaryColor: '#00ccff', speed: 1, ...overrides,
      }),
      transform: {
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      },
    },
  };
  const sync = (selected = false, visible = true, pickable = true) => runtime.sync(entity, selected, visible, pickable);
  const tick = (elapsed = 50) => {
    milliseconds += elapsed;
    scene.onBeforeRenderObservable.notifyObservers(scene);
  };
  t.after(() => {
    runtime.dispose();
    scene.dispose();
    engine.dispose();
  });
  sync();
  return { engine, scene, runtime, entity, originalObservers, sync, tick };
}

function pick(scene, origin, direction) {
  for (const mesh of scene.meshes) mesh.computeWorldMatrix(true);
  return scene.pickWithRay(
    new Ray(new Vector3(...origin), new Vector3(...direction)),
    mesh => mesh.isEnabled() && mesh.isVisible && mesh.isPickable,
  );
}

test('闭合光墙的四面可从内外拾取，中心保持穿透', t => {
  const { scene, runtime, entity } = createHarness(t);
  const mesh = runtime.getPickMesh(entity.id);
  assert.equal(mesh.getTotalVertices(), 16);
  assert.equal(mesh.getTotalIndices(), 24);
  const sides = [
    { origin: [0, 1, -10], direction: [0, 0, 1], inside: [0, 0, -1], point: [0, 1, -4] },
    { origin: [10, 1, 0], direction: [-1, 0, 0], inside: [1, 0, 0], point: [5, 1, 0] },
    { origin: [0, 1, 10], direction: [0, 0, -1], inside: [0, 0, 1], point: [0, 1, 4] },
    { origin: [-10, 1, 0], direction: [1, 0, 0], inside: [-1, 0, 0], point: [-5, 1, 0] },
  ];
  for (const side of sides) {
    const outsideHit = pick(scene, side.origin, side.direction);
    const insideHit = pick(scene, [0, 1, 0], side.inside);
    assert.equal(outsideHit.pickedMesh, mesh);
    assert.equal(insideHit.pickedMesh, mesh);
    assert.ok(Vector3.Distance(outsideHit.pickedPoint, new Vector3(...side.point)) < 0.00001);
  }
  assert.equal(pick(scene, [0, 10, 0], [0, -1, 0]).hit, false);
  assert.equal(mesh.metadata.editorEntityId, entity.id);
  assert.equal(mesh.material.backFaceCulling, false);
  assert.equal(mesh.material.disableDepthWrite, true);
  assert.equal(mesh.material.alphaMode, Constants.ALPHA_ADD);
});

test('颜色、透明度、亮度和流速原位更新，零速保持当前动画相位', t => {
  const { runtime, entity, sync, tick } = createHarness(t);
  const mesh = runtime.getPickMesh(entity.id);
  const material = mesh.material;
  tick();
  tick();
  const movingPhase = material._floats.flowPhase;
  assert.ok(movingPhase > 0);
  entity.components.poiEffect = {
    ...entity.components.poiEffect,
    primaryColor: '#ff0000', intensity: 1.5, speed: 0,
    lightWall: { ...entity.components.poiEffect.lightWall, opacity: 0 },
  };
  sync();
  assert.equal(runtime.getPickMesh(entity.id), mesh);
  assert.equal(mesh.material, material);
  assert.deepEqual(material._colors3.wallColor.asArray(), [1, 0, 0]);
  assert.equal(material._floats.wallOpacity, 0);
  assert.equal(material._floats.wallIntensity, 1.5);
  tick();
  tick(1000);
  assert.equal(material._floats.flowPhase, movingPhase);
  entity.components.poiEffect.speed = 2;
  sync();
  tick();
  assert.ok(material._floats.flowPhase > movingPhase);
  assert.equal(runtime.getPickMesh(entity.id), mesh);
});

test('隐藏暂停动画，关闭拾取生效，禁用围栏始终隐藏辅助壳', t => {
  const { scene, runtime, entity, sync, tick } = createHarness(t);
  const wall = runtime.getPickMesh(entity.id);
  const root = runtime.getGizmoTarget(entity.id);
  const shell = scene.getMeshByName(`${entity.id}_poiEffectPickShell`);
  tick();
  tick();
  const phase = wall.material._floats.flowPhase;
  sync(false, false, true);
  tick();
  assert.equal(root.isEnabled(), false);
  assert.equal(wall.isVisible, false);
  assert.equal(wall.isPickable, false);
  assert.equal(shell.isVisible, false);
  assert.equal(wall.material._floats.flowPhase, phase);
  sync(false, true, false);
  assert.equal(root.isEnabled(), true);
  assert.equal(wall.isVisible, true);
  assert.equal(wall.isPickable, false);
  assert.equal(shell.isVisible, false);
  entity.components.poiEffect.enabled = false;
  sync(false, true, false);
  assert.equal(wall.isDisposed(), true);
  assert.equal(shell.isVisible, false);
  assert.equal(shell.isPickable, false);
  sync(true, true, true);
  assert.equal(runtime.getPickMesh(entity.id), shell);
  assert.equal(shell.isVisible, false);
  assert.equal(shell.isPickable, false);
  assert.equal(root.isEnabled(), true);
  assert.equal(runtime.getGizmoTarget(entity.id), root);
  assert.equal(scene.meshes.some(mesh => mesh.name.startsWith(entity.id) && mesh.isVisible), false);
  assert.equal(pick(scene, [0, 10, 0], [0, -1, 0]).hit, false);
  entity.components.poiEffect.enabled = true;
  sync();
  assert.notEqual(runtime.getPickMesh(entity.id), wall);
  assert.equal(runtime.getGizmoTarget(entity.id), root);
  assert.equal(shell.isVisible, false);
});

test('包围盒和阵列使用围栏实际几何，并跟随实体变换', t => {
  const { runtime, entity, sync } = createHarness(t);
  entity.components.transform.position = { x: 10, y: 2, z: -3 };
  entity.components.transform.scale = { x: 2, y: 1.5, z: 3 };
  sync();
  const mesh = runtime.getPickMesh(entity.id);
  mesh.computeWorldMatrix(true);
  const box = mesh.getBoundingInfo().boundingBox;
  assert.deepEqual(box.minimumWorld.asArray(), [0, 2, -15]);
  assert.deepEqual(box.maximumWorld.asArray(), [20, 6.5, 9]);
  assert.deepEqual(runtime.getWorldBoundsMeshes(entity.id), [mesh]);
  const source = runtime.getEntityArraySource(entity.id);
  assert.equal(source.root, runtime.getGizmoTarget(entity.id));
  assert.deepEqual(source.geometryMeshes, [mesh]);
  assert.deepEqual(source.previewMeshes, [mesh]);
});

test('高度和轮廓更新重建旧资源，同时保持 Gizmo 根节点稳定', t => {
  const { scene, runtime, entity, sync } = createHarness(t);
  const root = runtime.getGizmoTarget(entity.id);
  const original = runtime.getPickMesh(entity.id);
  const originalMaterial = original.material;
  entity.components.poiEffect.lightWall = { ...entity.components.poiEffect.lightWall, height: 5 };
  sync();
  const taller = runtime.getPickMesh(entity.id);
  assert.notEqual(taller, original);
  assert.equal(original.isDisposed(), true);
  assert.equal(scene.materials.includes(originalMaterial), false);
  assert.equal(taller.getBoundingInfo().boundingBox.maximum.y, 5);
  assert.equal(runtime.getGizmoTarget(entity.id), root);
  entity.components.poiEffect.lightWall = {
    ...entity.components.poiEffect.lightWall,
    points: [{ x: -2, z: -1 }, { x: 2, z: -1 }, { x: 0, z: 2 }],
  };
  sync();
  const triangle = runtime.getPickMesh(entity.id);
  assert.equal(taller.isDisposed(), true);
  assert.equal(triangle.getTotalVertices(), 12);
  assert.equal(triangle.getTotalIndices(), 18);
  assert.equal(runtime.getGizmoTarget(entity.id), root);
  assert.equal(pick(scene, [-4, 1, 0], [1, 0, 0]).pickedMesh, triangle);
});

test('旧报警脉冲和移动双箭头与围栏互切时复用根节点并清理旧视觉资源', t => {
  const { scene, runtime, entity, sync, tick } = createHarness(t);
  const root = runtime.getGizmoTarget(entity.id);
  const shell = scene.getMeshByName(`${entity.id}_poiEffectPickShell`);
  let previousWall = runtime.getPickMesh(entity.id);
  for (const kind of ['alarm-pulse', 'moving-double-arrow']) {
    entity.components.poiEffect = sanitizePoiEffectComponent({ ...entity.components.poiEffect, effectKind: kind });
    sync(true);
    assert.equal(previousWall.isDisposed(), true);
    assert.equal(runtime.getGizmoTarget(entity.id), root);
    assert.equal(runtime.getPickMesh(entity.id), shell);
    assert.equal(shell.isVisible, true);
    const oldVisuals = runtime.getWorldBoundsMeshes(entity.id).filter(mesh => mesh !== shell);
    assert.ok(oldVisuals.length > 0);
    tick();
    tick();
    for (const mesh of oldVisuals) assert.ok(Number.isFinite(mesh.position.x));
    entity.components.poiEffect = sanitizePoiEffectComponent({ ...entity.components.poiEffect, effectKind: 'light-wall-fence' });
    sync();
    assert.ok(oldVisuals.every(mesh => mesh.isDisposed()));
    assert.equal(runtime.getGizmoTarget(entity.id), root);
    assert.equal(shell.isVisible, false);
    previousWall = runtime.getPickMesh(entity.id);
    assert.notEqual(previousWall, shell);
  }
});

test('删除实体和销毁运行时释放所有自有资源与观察者，不影响其他对象', async t => {
  const { scene, runtime, entity, originalObservers, sync } = createHarness(t);
  const unrelated = MeshBuilder.CreateBox('unrelated-scene-object', {}, scene);
  const sentinel = scene.onBeforeRenderObservable.add(() => {});
  const ownedName = object => object.name.startsWith(entity.id);
  const originalRoot = runtime.getGizmoTarget(entity.id);
  assert.equal(scene.onBeforeRenderObservable.observers.length, originalObservers.length + 2);
  runtime.disposeMissing(new Set());
  assert.equal(originalRoot.isDisposed(), true);
  assert.equal(runtime.has(entity.id), false);
  assert.equal(scene.meshes.some(ownedName), false);
  assert.equal(scene.materials.some(ownedName), false);
  assert.equal(scene.transformNodes.some(ownedName), false);
  assert.equal(unrelated.isDisposed(), false);
  sync();
  assert.equal(runtime.has(entity.id), true);
  runtime.dispose();
  // Babylon Observable.remove 延迟移出数组，等待该实现完成清理。
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(scene.meshes.some(ownedName), false);
  assert.equal(scene.materials.some(ownedName), false);
  assert.equal(scene.transformNodes.some(ownedName), false);
  assert.equal(unrelated.isDisposed(), false);
  assert.deepEqual(scene.onBeforeRenderObservable.observers, [...originalObservers, sentinel]);
});
