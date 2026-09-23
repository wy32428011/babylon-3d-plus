import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConveyorArrowModules } from '../helpers/conveyorSurfaceArrowModules.mjs';

const [{ StackerMotionArrowRenderer }, { createDefaultStackerMotionArrowsConfig }, { SURFACE_ARROW_FRAGMENT_SOURCE }] = await loadConveyorArrowModules([
  'src/runtime/babylon/effects/StackerMotionArrowRenderer.ts',
  'src/editor/model/stackerMotionArrows.ts',
  'src/runtime/babylon/effects/ConveyorSurfaceArrowRenderer.ts',
]);
const { NullEngine, Scene, TransformNode, MeshBuilder } = await import('@babylonjs/core');
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-5, `${actual} != ${expected}`);

function fixture(t) {
  const engine = new NullEngine(), scene = new Scene(engine);
  void scene.defaultMaterial;
  const root = new TransformNode('root', scene), contentRoot = new TransformNode('content', scene);
  contentRoot.parent = root;
  const part = (name, size, position) => {
    const mesh = MeshBuilder.CreateBox(name, size, scene);
    mesh.parent = contentRoot; mesh.position.copyFromFloats(...position);
    return mesh;
  };
  const base = part('base', { width: 1.3, height: .3, depth: 2 }, [0,.4,0]);
  const mast = part('mast', { width: .25, height: 5, depth: .25 }, [0,3,0]);
  const carrier = part('carrier', { width: 1.6, height: .6, depth: 1 }, [0,2,0]);
  const front = part('front-fork', { width: 1.6, height: .1, depth: .35 }, [0,2,-.4]);
  const back = part('back-fork', { width: 1.6, height: .1, depth: .35 }, [0,2,.4]);
  const rail = part('rail', { width: 1.5, height: .1, depth: 20 }, [0,0,0]);
  const model = { root, contentRoot, meshes: [base,mast,carrier,front,back,rail], assetSignature: 'one', loadToken: 1,
    entitySnapshot: { components: { modelAsset: { unitScaleToMeters: 1 } } },
    externalScriptRuntime: { getDataDrivenConfigs: () => [{ fixedNodes: ['rail'], motion: {
      travel: { nodes: ['base','mast','carrier','front-fork','back-fork'] },
      lift: { nodes: ['carrier','front-fork','back-fork'] },
      fork: { frontStageTwoNodes: ['front-fork'], backStageTwoNodes: ['back-fork'] },
    } }] },
  };
  const config = createDefaultStackerMotionArrowsConfig(); config.enabled = true;
  config.channels.lift.length = 5;
  const renderer = new StackerMotionArrowRenderer(scene);
  const update = (direction = 1, delta = .02) => {
    assert.equal(renderer.update('one', model, config, 'lift', direction, delta, true), null);
    return scene.meshes.find(mesh => mesh.name === '__stackerMotionArrows_one_lift');
  };
  t.after(() => { renderer.dispose(); scene.dispose(); engine.dispose(); });
  return { scene, config, model, renderer, carrier, front, back, update };
}

test('升降遮罩位于着色器方向和样式分支之前，共用输送线程序保持原样', t => {
  const h = fixture(t), mesh = h.update(), source = mesh.material.shaderPath.fragmentSource;
  assert.match(source, /uniform float liftGapEnabled;/);
  assert.match(source, /uniform float liftGapMin;/);
  assert.match(source, /uniform float liftGapMax;/);
  assert.match(source, /void main\(void\)\s*\{\s*if\s*\(liftGapEnabled > 0\.5 && vUV\.x >= liftGapMin && vUV\.x <= liftGapMax\) discard;/);
  assert.doesNotMatch(SURFACE_ARROW_FRAGMENT_SOURCE, /liftGap/);
  for (const name of ['liftGapEnabled', 'liftGapMin', 'liftGapMax']) assert.ok(mesh.material.options.uniforms.includes(name));
});

test('平台升降每帧更新缺口，方向反向保持遮挡位置和整条带相位连续', t => {
  const h = fixture(t), mesh = h.update(), material = mesh.material, first = { ...material._floats };
  assert.equal(first.liftGapEnabled, 1);
  near(first.liftGapMin, (1.7 - .03 - .5) / 5);
  near(first.liftGapMax, (2.3 + .03 - .5) / 5);
  const initialCounts = [h.scene.meshes.length, h.scene.materials.length, h.scene.onBeforeRenderObservable.observers.length];
  for (const part of [h.carrier,h.front,h.back]) part.position.y += 1;
  assert.equal(h.update(-1), mesh);
  const moved = { ...material._floats };
  near(moved.liftGapMin - first.liftGapMin, 1 / 5);
  near(moved.liftGapMax - first.liftGapMax, 1 / 5);
  assert.equal(moved.direction, -1);
  assert.ok(moved.phase > first.phase);
  h.config.channels.lift.reverse = true;
  h.update(-1);
  assert.equal(material._floats.direction, 1);
  near(material._floats.liftGapMin, moved.liftGapMin);
  near(material._floats.liftGapMax, moved.liftGapMax);
  assert.deepEqual([h.scene.meshes.length, h.scene.materials.length, h.scene.onBeforeRenderObservable.observers.length], initialCounts);
});

test('淡出期间仍更新平台缺口，重启使用当前位置，离开条带后清除旧遮罩', t => {
  const h = fixture(t), mesh = h.update(), material = mesh.material;
  const phase = material._floats.phase, min = material._floats.liftGapMin;
  for (const part of [h.carrier,h.front,h.back]) part.position.y += .5;
  h.update(0, .03);
  assert.equal(material._floats.phase, phase);
  near(material._floats.liftGapMin - min, .5 / 5);
  h.update(0, .2);
  assert.equal(mesh.isEnabled(), false);
  for (const part of [h.carrier,h.front,h.back]) part.position.y += .5;
  h.update(-1);
  assert.equal(mesh.isEnabled(), true);
  near(material._floats.liftGapMin - min, 1 / 5);
  for (const part of [h.carrier,h.front,h.back]) part.position.y += 20;
  h.update(-1);
  assert.equal(material._floats.liftGapEnabled, 0);
  near(material._floats.liftGapMin, 0);
  near(material._floats.liftGapMax, 0);
});

test('行走和前后叉的材质始终关闭升降遮罩', t => {
  const h = fixture(t); h.update();
  for (const channel of ['travel','frontFork','backFork']) {
    assert.equal(h.renderer.update('one', h.model, h.config, channel, 1, .02, true), null);
    const mesh = h.scene.meshes.find(item => item.name === '__stackerMotionArrows_one_' + channel);
    assert.equal(mesh.material._floats.liftGapEnabled, 0);
    assert.equal(mesh.material._floats.liftGapMin, 0);
    assert.equal(mesh.material._floats.liftGapMax, 0);
  }
});
