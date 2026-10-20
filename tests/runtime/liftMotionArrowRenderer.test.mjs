import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConveyorArrowModules } from '../helpers/conveyorSurfaceArrowModules.mjs';

const [{ LiftMotionArrowRenderer, liftMotionArrowKey }, { createDefaultLiftMotionArrowsConfig }] = await loadConveyorArrowModules([
  'src/runtime/babylon/effects/LiftMotionArrowRenderer.ts', 'src/editor/model/liftMotionArrows.ts',
]);
const { NullEngine, Scene, TransformNode, MeshBuilder, Vector3, Matrix, Constants } = await import('@babylonjs/core');
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-5, `${actual} != ${expected}`);
const point = (mesh, x = 0, z = 0) => Vector3.TransformCoordinates(new Vector3(x, 0, z), mesh.computeWorldMatrix(true));

function fixture(t) {
  const engine = new NullEngine(), scene = new Scene(engine);
  void scene.defaultMaterial;
  const root = new TransformNode('root', scene), contentRoot = new TransformNode('content', scene);
  contentRoot.parent = root;
  const part = (name, size, position) => {
    const mesh = MeshBuilder.CreateBox(name, size, scene); mesh.parent = contentRoot;
    mesh.position.copyFromFloats(...position); return mesh;
  };
  const left = part('LiftColumnLeft', { width: .2, height: 6, depth: .3 }, [-1, 3, 0]);
  const right = part('LiftColumnRight', { width: .2, height: 6, depth: .3 }, [1, 3, 0]);
  const deck = part('lift_deck', { width: 2, height: .2, depth: 1.2 }, [0, 2, 0]);
  const base = part('base', { width: 2.4, height: .2, depth: 1.5 }, [0, -.1, 0]);
  const declarations = [{ motion: { lift: { nodes: ['lift_deck'], travelAxis: 'x' } }, cargo: { nodes: ['lift_deck'] } }];
  const model = { root, contentRoot, meshes: [left, right, deck, base], assetSignature: 'one', loadToken: 1,
    entitySnapshot: { components: { modelAsset: { unitScaleToMeters: 1 } } },
    externalScriptRuntime: { getDataDrivenConfigs: () => declarations } };
  const config = createDefaultLiftMotionArrowsConfig(); config.enabled = true;
  const renderer = new LiftMotionArrowRenderer(scene);
  const arrow = channel => scene.meshes.find(mesh => mesh.name === '__liftMotionArrows_one_' + channel);
  const update = (channel = 'lift', direction = 1, delta = .02, visible = true, axis) => renderer.update('one', model, config, channel, direction, delta, visible, axis);
  t.after(() => { renderer.dispose(); scene.dispose(); engine.dispose(); });
  return { scene, root, contentRoot, left, right, deck, base, declarations, model, config, renderer, arrow, update, part };
}

test('升降箭头贴在实际外侧立柱并覆盖全高，忽略历史长度与沿轴偏移', t => {
  const h = fixture(t); Object.assign(h.config.channels.lift, { face: 'top', length: 1, offsetAlong: 3, offsetAcross: 2 });
  assert.equal(h.update(), null);
  const mesh = h.arrow('lift');
  near(point(mesh).x, 1.115); near(point(mesh).y, 3); near(point(mesh).z, 0);
  near(Vector3.Distance(point(mesh, .5), point(mesh, -.5)), 6);
  near(point(mesh, .5).y, 6); near(point(mesh, -.5).y, 0);
  assert.equal(mesh.metadata.liftMotionArrow, true); assert.equal(mesh.metadata.editorOverlay, true); assert.equal(mesh.isPickable, false);
  assert.equal(mesh.material.depthFunction, Constants.LEQUAL); assert.equal(mesh.material.disableDepthWrite, true);
  assert.equal(h.root.getChildMeshes().includes(mesh), false);
});

test('升降缺口跟随真实台面，反向及淡出保持缺口位置和同一流动相位', t => {
  const h = fixture(t); h.update(); const mesh = h.arrow('lift'), material = mesh.material;
  assert.equal(material._floats.liftGapEnabled, 1);
  near(material._floats.liftGapMin, (1.9 - .03) / 6); near(material._floats.liftGapMax, (2.1 + .03) / 6);
  const phase = material._floats.phase;
  h.deck.position.y += 1; assert.equal(h.update('lift', -1), null);
  near(material._floats.liftGapMin, (2.9 - .03) / 6); assert.equal(material._floats.direction, -1);
  assert.ok(material._floats.phase > phase);
  const activePhase = material._floats.phase; h.deck.position.y += .5;
  h.update('lift', 0, .03); near(material._floats.phase, activePhase);
  near(material._floats.liftGapMin, (3.4 - .03) / 6);
  assert.match(material.shaderPath.fragmentSource, /void main\(void\)\s*\{\s*if\s*\(liftGapEnabled > 0\.5 && vUV\.x >= liftGapMin/);
});

test('共享台面按真实交接轴分成两个工位，箭头随台面升降而立柱保持固定', t => {
  const h = fixture(t), axis = { x: 0, y: 0, z: -1 };
  for (const channel of ['lift', 'front', 'back']) assert.equal(h.update(channel, 1, .02, true, axis), null);
  near(point(h.arrow('front')).z, .3); near(point(h.arrow('back')).z, -.3);
  near(Vector3.Distance(point(h.arrow('front'), .5), point(h.arrow('front'), -.5)), .54);
  near(point(h.arrow('front'), .5).subtract(point(h.arrow('front'), -.5)).normalize().z, -1);
  near(point(h.arrow('front')).y, 2.115);
  for (const channel of ['front', 'back']) assert.equal(h.arrow(channel).material._floats.liftGapEnabled, 0);
  h.deck.position.y += 1;
  for (const channel of ['lift', 'front', 'back']) h.update(channel, 1, .02, true, axis);
  near(point(h.arrow('lift')).y, 3); near(point(h.arrow('back')).y, 3.115);
});

test('共享台面斜向轴按矩形交段分半并给条带宽度留边，四个角都在真实台面内', t => {
  const h = fixture(t);
  for (const axis of [{ x: Math.SQRT1_2, y: 0, z: Math.SQRT1_2 }, { x: -.8, y: 0, z: .6 }]) {
    for (const width of [0, .8]) {
      for (const channel of ['front', 'back']) {
        h.config.channels[channel].width = width;
        assert.equal(h.update(channel, 1, .02, true, axis), null);
        const mesh = h.arrow(channel), center = point(mesh);
        assert.ok((center.x * axis.x + center.z * axis.z) * (channel === 'front' ? -1 : 1) > 0);
        for (const x of [-.5, .5]) for (const z of [-.5, .5]) {
          const corner = point(mesh, x, z);
          assert.ok(Math.abs(corner.x) <= 1 + 1e-6, `台面 X 越界 ${corner.x}`);
          assert.ok(Math.abs(corner.z) <= .6 + 1e-6, `台面 Z 越界 ${corner.z}`);
          near(corner.y, 2.115);
        }
      }
    }
  }
});

test('独立台面斜向自动长度和宽度适配真实矩形，显式长度与偏移保持用户配置', t => {
  const h = fixture(t), axis = { x: Math.SQRT1_2, y: 0, z: Math.SQRT1_2 };
  const front = h.part('privateFront', { width: .8, height: .1, depth: .5 }, [-.6, 2.2, 0]);
  h.model.meshes.push(front); h.declarations[0].cargo.frontNodes = ['privateFront'];
  assert.equal(h.update('front', 1, .02, true, axis), null);
  const mesh = h.arrow('front');
  near(point(mesh).x, -.6); near(point(mesh).z, 0);
  for (const x of [-.5, .5]) for (const z of [-.5, .5]) {
    const corner = point(mesh, x, z);
    assert.ok(corner.x >= -1 - 1e-6 && corner.x <= -.2 + 1e-6);
    assert.ok(Math.abs(corner.z) <= .25 + 1e-6);
    near(corner.y, 2.265);
  }
  Object.assign(h.config.channels.front, { length: 1.6, offsetAlong: .3, offsetAcross: .2 });
  assert.equal(h.update('front', 1, .02, true, axis), null);
  near(Vector3.Distance(point(mesh, .5), point(mesh, -.5)), 1.6);
  const across = Vector3.Cross(Vector3.Up(), new Vector3(axis.x, axis.y, axis.z));
  const expected = new Vector3(-.6, 2.265, 0).add(new Vector3(axis.x, axis.y, axis.z).scale(.3)).add(across.scale(.2));
  assert.ok(Vector3.Distance(point(mesh), expected) < 1e-5);
});

test('斜向运动的侧面条带投影到实际盒侧面，共享与独立台面均不悬空或越界', t => {
  const h = fixture(t), axis = { x: Math.SQRT1_2, y: 0, z: Math.SQRT1_2 };
  for (const channel of ['front', 'back']) {
    h.config.channels[channel].face = 'side';
    assert.equal(h.update(channel, 1, .02, true, axis), null);
    const mesh = h.arrow(channel);
    for (const x of [-.5, .5]) for (const z of [-.5, .5]) {
      const corner = point(mesh, x, z);
      assert.ok(Math.abs(corner.x) <= 1 + 1e-6);
      assert.ok(corner.y >= 1.9 - 1e-6 && corner.y <= 2.1 + 1e-6);
      near(corner.z, .615);
    }
    near(point(mesh, .5).subtract(point(mesh, -.5)).normalize().x, 1);
  }
  const front = h.part('privateFront', { width: .8, height: .1, depth: .5 }, [-.6, 2.2, 0]);
  h.model.meshes.push(front); h.declarations[0].cargo.frontNodes = ['privateFront']; h.model.loadToken++;
  assert.equal(h.update('front', 1, .02, true, axis), null);
  for (const x of [-.5, .5]) for (const z of [-.5, .5]) {
    const corner = point(h.arrow('front'), x, z);
    assert.ok(corner.x >= -1 - 1e-6 && corner.x <= -.2 + 1e-6);
    assert.ok(corner.y >= 2.15 - 1e-6 && corner.y <= 2.25 + 1e-6);
    near(corner.z, .265);
  }
});

test('独立工位声明优先于共享台面，手动挂点支持完整路径并诊断重名', t => {
  const h = fixture(t);
  const front = h.part('privateFront', { width: .8, height: .1, depth: .5 }, [-.6, 2.2, 0]);
  h.model.meshes.push(front); h.declarations[0].cargo.frontNodes = ['privateFront'];
  assert.equal(h.update('front'), null); near(point(h.arrow('front')).x, -.6);
  near(Vector3.Distance(point(h.arrow('front'), .5), point(h.arrow('front'), -.5)), .72);
  const branch = new TransformNode('branch', h.scene); branch.parent = h.contentRoot; front.clone('privateFront', branch);
  h.config.channels.front.surfaceNode = 'privateFront'; assert.match(h.update('front'), /不唯一/);
  h.config.channels.front.surfaceNode = 'branch/privateFront'; assert.equal(h.update('front'), null);
  h.config.channels.front.surfaceNode = 'missing'; assert.match(h.update('front'), /未找到/);
});

test('无语义名称的固定声明只选细长竖直柱，水平底座及随动件不进入范围', t => {
  const h = fixture(t); h.left.name = 'Box100'; h.right.name = 'Box101';
  h.declarations[0].fixedNodes = ['Box100', 'Box101', 'base'];
  assert.equal(h.update(), null); near(point(h.arrow('lift')).x, 1.115);
  near(Vector3.Distance(point(h.arrow('lift'), .5), point(h.arrow('lift'), -.5)), 6);
  h.declarations[0].fixedNodes = ['base', 'lift_deck']; h.model.loadToken++;
  assert.match(h.update(), /固定.*立柱/); assert.equal(h.arrow('lift').isEnabled(), false);
  h.config.channels.lift.surfaceNode = 'Box101'; assert.equal(h.update(), null);
  h.config.channels.lift.surfaceNode = 'lift_deck'; assert.match(h.update(), /固定立柱/);
});

test('缺少可信立柱和台面时诊断隐藏，不使用整机范围猜测', t => {
  const h = fixture(t); h.left.name = 'partA'; h.right.name = 'partB';
  assert.match(h.update(), /立柱/);
  h.config.channels.lift.surfaceNode = 'partB'; assert.equal(h.update(), null);
  h.declarations[0].cargo.nodes = ['missing']; h.model.loadToken++;
  assert.match(h.update(), /载货台/); assert.match(h.update('front'), /工位载货台/);
});

test('厘米预旋转、根节点镜像和阵列代理保留米配置及实际运动方向', t => {
  const h = fixture(t); h.contentRoot.scaling.setAll(.01); h.contentRoot.rotation.x = -Math.PI / 2;
  for (const mesh of h.model.meshes) {
    mesh.bakeTransformIntoVertices(Matrix.RotationX(Math.PI / 2).multiply(Matrix.Scaling(100, 100, 100)));
    mesh.position = Vector3.TransformCoordinates(mesh.position, Matrix.RotationX(Math.PI / 2)).scale(100);
  }
  h.root.position.set(3, 2, 5); h.root.rotation.set(.1, .6, 0); h.root.scaling.set(-1.2, .8, 1.4);
  assert.equal(h.update(), null);
  const expected = Vector3.TransformCoordinates(new Vector3(1.115, 3, 0), h.root.computeWorldMatrix(true));
  assert.ok(Vector3.Distance(point(h.arrow('lift')), expected) < 1e-5);
  const proxyRoot = new TransformNode('proxy', h.scene); proxyRoot.position.set(-5, 1, 4); proxyRoot.rotation.y = -.4;
  const proxy = { ...h.model, root: proxyRoot, telemetryProxySource: h.model };
  const worldAxis = Vector3.TransformNormal(Vector3.Forward(), proxyRoot.computeWorldMatrix(true)).normalize();
  assert.equal(h.renderer.update('one', proxy, h.config, 'front', 1, .02, true, worldAxis), null);
  const actual = point(h.arrow('front'), .5).subtract(point(h.arrow('front'), -.5)).normalize();
  assert.ok(actual.subtract(worldAxis).length() < 1e-5);
});

test('挂点隐藏释放或退化立即隐藏，停止淡出、禁用、删除不泄漏资源', t => {
  const h = fixture(t), counts = () => [h.scene.meshes.length, h.scene.materials.length, h.scene.transformNodes.length];
  const initial = counts(); assert.equal(h.update('lift', 0), null); assert.deepEqual(counts(), initial);
  h.update(); const mesh = h.arrow('lift'), phase = mesh.material._floats.phase;
  h.update('lift', 0, .06); near(mesh.material._floats.opacity, h.config.opacity * .5); near(mesh.material._floats.phase, phase);
  h.update('lift', 0, .06); assert.equal(mesh.isEnabled(), false);
  h.update('lift', -1); assert.equal(h.arrow('lift'), mesh);
  h.right.isVisible = false; assert.match(h.update(), /隐藏/); assert.equal(mesh.isEnabled(), false);
  h.right.isVisible = true; h.deck.setEnabled(false); assert.match(h.update(), /载货台/);
  h.deck.setEnabled(true); assert.equal(h.update(), null);
  h.root.scaling.x = 0; assert.match(h.update(), /退化/); h.root.scaling.x = 1;
  h.update('front'); h.renderer.retain(new Set([liftMotionArrowKey('one', 'front')])); assert.equal(h.arrow('lift'), undefined);
  h.config.channels.front.enabled = false; h.update('front'); assert.deepEqual(counts(), initial);
});

test('十种样式共用原有着色器且呼吸、反向及强度控制保持有效', t => {
  const h = fixture(t), styles = ['conveyor-direction', 'moving-double-arrow', 'pipeline-flow-arrows', 'flow-arrows',
    'conveyor-arrow-single', 'conveyor-arrow-chevron', 'conveyor-arrow-segmented', 'conveyor-arrow-ribbon', 'conveyor-arrow-double', 'conveyor-arrow-speed'];
  h.config.breathingEnabled = true; h.config.channels.front.reverse = true;
  for (const style of styles) {
    h.config.style = style; assert.equal(h.update('front', 1, .2), null);
    assert.equal(h.arrow('front').material._floats.direction, -1);
    assert.equal(h.arrow('front').material._floats.arrowStyle, styles.indexOf(style));
    assert.ok(h.arrow('front').material._floats.breathingFactor <= 1);
  }
  h.config.intensity = 0; h.update('front'); assert.equal(h.arrow('front').isEnabled(), false);
});
