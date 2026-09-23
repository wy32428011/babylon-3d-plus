import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConveyorArrowModules } from '../helpers/conveyorSurfaceArrowModules.mjs';

const [{ StackerMotionArrowRenderer }, { createDefaultStackerMotionArrowsConfig }, surfaces] = await loadConveyorArrowModules([
  'src/runtime/babylon/effects/StackerMotionArrowRenderer.ts', 'src/editor/model/stackerMotionArrows.ts',
  'src/runtime/babylon/effects/StackerMotionArrowSurface.ts',
]);
const { NullEngine, Scene, TransformNode, MeshBuilder, Vector3, Constants, Matrix } = await import('@babylonjs/core');

function fixture(t) {
  const engine = new NullEngine(), scene = new Scene(engine);
  void scene.defaultMaterial;
  const root = new TransformNode('root', scene), contentRoot = new TransformNode('content', scene);
  contentRoot.parent = root;
  const part = (name, size, position) => { const mesh = MeshBuilder.CreateBox(name, size, scene); mesh.parent = contentRoot; mesh.position.copyFromFloats(...position); return mesh; };
  const base = part('base', { width: 1.3, height: .3, depth: 2 }, [0,.4,0]);
  const mast = part('mast', { width: .25, height: 5, depth: .25 }, [0,3,0]);
  const platform = part('platform', { width: 1.5, height: .3, depth: 1.5 }, [0,2,0]);
  const front = part('front-fork', { width: 1.6, height: .1, depth: .35 }, [0,2,-.4]);
  const back = part('back-fork', { width: 1.6, height: .1, depth: .35 }, [0,2,.4]);
  const rail = part('rail', { width: 1.5, height: .1, depth: 20 }, [0,0,0]);
  const model = { root, contentRoot, meshes: [base,mast,platform,front,back,rail], assetSignature: 'one', loadToken: 1,
    entitySnapshot: { components: { modelAsset: { unitScaleToMeters: 1 } } },
    externalScriptRuntime: { getDataDrivenConfigs: () => [{ fixedNodes: ['rail'], motion: {
      travel: { nodes: ['base','mast','platform','front-fork','back-fork'] }, lift: { nodes: ['platform','front-fork','back-fork'] },
      fork: { frontStageTwoNodes: ['front-fork'], backStageTwoNodes: ['back-fork'] },
    } }] },
  };
  const config = createDefaultStackerMotionArrowsConfig(); config.enabled = true;
  const renderer = new StackerMotionArrowRenderer(scene);
  t.after(() => { renderer.dispose(); scene.dispose(); engine.dispose(); });
  return { scene, root, model, config, renderer, base, mast, platform, rail, front, back };
}
const arrow = (scene, channel) => scene.meshes.find(mesh => mesh.name === '__stackerMotionArrows_one_' + channel);
const point = (mesh, x = 0, z = 0) => Vector3.TransformCoordinates(new Vector3(x,0,z), mesh.computeWorldMatrix(true));
const near = (actual, expected) => assert.ok(Math.abs(actual-expected)<1e-5, `${actual} != ${expected}`);

test('四路自动定位：行走覆盖固定轨道全长，升降沿y，双叉沿x', t => {
  const h = fixture(t);
  for (const channel of ['travel','lift','frontFork','backFork']) {
    assert.equal(h.renderer.update('one',h.model,h.config,channel,1,.1,true),null);
    assert.equal(arrow(h.scene,channel).material._floats.direction,1);
  }
  const travel = arrow(h.scene,'travel'), lift = arrow(h.scene,'lift');
  near(point(travel,.5).subtract(point(travel,-.5)).normalize().z,1);
  near(Vector3.Distance(point(travel,.5),point(travel,-.5)),20);
  near(point(lift,.5).subtract(point(lift,-.5)).normalize().y,1);
  near(point(arrow(h.scene,'frontFork'),.5).subtract(point(arrow(h.scene,'frontFork'),-.5)).normalize().x,1);
  assert.equal(travel.isPickable,false); assert.equal(travel.material.depthFunction,Constants.LEQUAL);
  assert.equal(h.root.getChildMeshes().includes(travel),false);
});

test('底盘和前后叉各自跟随真实节点，旋转/缩放/镜像下方向和位姿保持', t => {
  const h=fixture(t);
  h.root.rotation.y=.6; h.root.scaling.set(-1.2,.8,1.4); h.root.position.set(3,2,5);
  for(const channel of ['travel','frontFork','backFork']) h.renderer.update('one',h.model,h.config,channel,1,.1,true);
  const before=point(arrow(h.scene,'frontFork')), back=point(arrow(h.scene,'backFork'));
  h.front.position.x += .7; h.front.position.y += .4;
  h.renderer.update('one',h.model,h.config,'frontFork',-1,.1,true);
  h.renderer.update('one',h.model,h.config,'backFork',0,.1,true);
  const expected=Vector3.TransformNormal(new Vector3(.7,.4,0),h.root.computeWorldMatrix(true));
  assert.ok(point(arrow(h.scene,'frontFork')).subtract(before).subtract(expected).length()<1e-5);
  assert.ok(point(arrow(h.scene,'backFork')).subtract(back).length()<1e-5);
  assert.equal(arrow(h.scene,'frontFork').material._floats.direction,-1);
});

test('显式挂点路径支持消歧，丢失节点隐藏且诊断，不退回整机', t => {
  const h=fixture(t); h.config.channels.frontFork.surfaceNode='front-fork';
  h.renderer.update('one',h.model,h.config,'frontFork',1,0,true);
  h.config.channels.frontFork.surfaceNode='missing';
  assert.match(h.renderer.update('one',h.model,h.config,'frontFork',1,0,true),/未找到/);
  assert.equal(arrow(h.scene,'frontFork').isEnabled(),false);
  const branch=new TransformNode('branch',h.scene); branch.parent=h.model.contentRoot;
  h.front.clone('front-fork',branch); h.config.channels.frontFork.surfaceNode='front-fork';
  assert.match(h.renderer.update('one',h.model,h.config,'frontFork',1,0,true),/不唯一/);
  h.config.channels.frontFork.surfaceNode='branch/front-fork';
  assert.equal(h.renderer.update('one',h.model,h.config,'frontFork',1,0,true),null);
});

test('未预览不分配资源；停机冻结相位淡出、异常立即隐藏，重启复用并完整释放', t => {
  const h=fixture(t), count=()=>[h.scene.meshes.length,h.scene.materials.length,h.scene.transformNodes.length];
  const initial=count();
  h.renderer.update('one',h.model,h.config,'travel',0,.1,true);
  assert.deepEqual(count(),initial);
  h.renderer.update('one',h.model,h.config,'travel',1,.1,true);
  const mesh=arrow(h.scene,'travel'), phase=mesh.material._floats.phase;
  h.renderer.update('one',h.model,h.config,'travel',0,.05,true);
  assert.equal(mesh.material._floats.phase,phase);
  h.renderer.update('one',h.model,h.config,'travel',0,.2,true);
  assert.equal(mesh.isEnabled(),false);
  h.renderer.update('one',h.model,h.config,'travel',-1,.1,true);
  assert.equal(arrow(h.scene,'travel'),mesh);
  h.renderer.update('one',h.model,h.config,'travel',1,.01,false);
  assert.equal(mesh.isEnabled(),false);
  h.renderer.retain(new Set()); assert.deepEqual(count(),initial);
});

test('导入毫米模型挂点按局部米配置，挂点旋转后箭头保持沿真实运动方向', t => {
  const h=fixture(t);
  h.model.entitySnapshot.components.modelAsset.unitScaleToMeters=.001;
  h.model.contentRoot.scaling.setAll(.001);
  for(const mesh of h.model.contentRoot.getChildMeshes()) { mesh.bakeTransformIntoVertices(Matrix.Scaling(1000,1000,1000)); mesh.position.scaleInPlace(1000); }
  h.front.rotation.y=Math.PI;
  h.config.channels.frontFork.surfaceNode='front-fork'; h.config.channels.frontFork.length=.8;
  h.renderer.update('one',h.model,h.config,'frontFork',1,.1,true);
  const mesh=arrow(h.scene,'frontFork');
  near(Vector3.Distance(point(mesh,.5),point(mesh,-.5)),.8);
  near(point(mesh,.5).subtract(point(mesh,-.5)).normalize().x,1);
  near(point(mesh).y,2.065);
});

test('阵列代理映射宿主几何到自身位姿且源隐藏不吞掉箭头，退化矩阵隐藏', t => {
  const h=fixture(t);
  h.root.position.set(20,3,8);h.root.rotation.y=.5;h.root.setEnabled(false);
  const proxyRoot=new TransformNode('proxy',h.scene);proxyRoot.position.set(-5,1,3);proxyRoot.rotation.y=-.4;
  const proxy={...h.model,root:proxyRoot,telemetryProxySource:h.model};
  assert.equal(h.renderer.update('one',proxy,h.config,'travel',1,.1,true),null);
  const expected=Vector3.TransformCoordinates(new Vector3(0,.065,0),proxyRoot.computeWorldMatrix(true));
  assert.ok(Vector3.Distance(point(arrow(h.scene,'travel')),expected)<1e-5);
  proxyRoot.scaling.x=0;
  assert.match(h.renderer.update('one',proxy,h.config,'travel',1,.1,true),/退化/);
  assert.equal(arrow(h.scene,'travel').isEnabled(),false);
});

test('自动识别缺少独立后叉时明确诊断，资源重载后重建挂点缓存', t => {
  const h=fixture(t);h.back.dispose();h.model.meshes=h.model.meshes.filter(m=>m!==h.back);
  assert.match(h.renderer.update('one',h.model,h.config,'backFork',1,.1,true),/后叉/);
  h.model.externalScriptRuntime={getDataDrivenConfigs:()=>[{motion:{fork:{backStageTwoNodes:['front-fork']}}}]};
  h.model.loadToken++;
  assert.equal(h.renderer.update('one',h.model,h.config,'backFork',1,.1,true),null);
  h.config.channels.backFork.reverse=true;
  h.renderer.update('one',h.model,h.config,'backFork',1,.1,true);
  assert.equal(arrow(h.scene,'backFork').material._floats.direction,-1);
});

test('显式挂点绕90度建模时升降竖直面和行走侧面仍沿实际运动轴', t => {
  const h=fixture(t);
  h.mast.scaling.set(20,.05,1);h.mast.rotation.z=Math.PI/2;
  h.config.channels.lift.surfaceNode='mast';
  assert.equal(h.renderer.update('one',h.model,h.config,'lift',1,.1,true),null);
  near(point(arrow(h.scene,'lift'),.5).subtract(point(arrow(h.scene,'lift'),-.5)).normalize().y,1);
  h.base.rotation.y=Math.PI/2;h.config.channels.travel.surfaceNode='base';h.config.channels.travel.face='side';
  assert.equal(h.renderer.update('one',h.model,h.config,'travel',1,.1,true),null);
  near(point(arrow(h.scene,'travel'),.5).subtract(point(arrow(h.scene,'travel'),-.5)).normalize().z,1);
});

test('GLB部件用非均匀缩放建模时配置米不重复放大，但保留模型实例整体缩放', t => {
  const h=fixture(t);
  h.model.contentRoot.scaling.setAll(.04);
  h.mast.scaling.set(7,130,7);h.mast.position.scaleInPlace(25);
  h.root.scaling.set(2,3,4);
  h.config.channels.lift.surfaceNode='mast';h.config.channels.lift.length=5.5;h.config.channels.lift.width=.3;
  assert.equal(h.renderer.update('one',h.model,h.config,'lift',1,.1,true),null);
  const mesh=arrow(h.scene,'lift');
  near(Vector3.Distance(point(mesh,.5),point(mesh,-.5)),16.5);
  near(Vector3.Distance(point(mesh,0,.5),point(mesh,0,-.5)),1.2);
  near(point(mesh).x,(.25 * 7 * .04 / 2 + .015) * 2);
});

test('独立发光强度调制颜色不改透明度，零强度立即隐藏且恢复复用材质', t => {
  const h=fixture(t);h.config.color='#4080ff';h.config.intensity=2;h.config.opacity=.6;
  h.renderer.update('one',h.model,h.config,'travel',1,.1,true);
  const mesh=arrow(h.scene,'travel'),material=mesh.material;
  near(material._colors3.arrowColor.b,2);near(material._floats.opacity,.6);
  h.config.intensity=0;h.renderer.update('one',h.model,h.config,'travel',1,.1,true);
  assert.equal(mesh.isEnabled(),false);
  h.config.intensity=1;h.renderer.update('one',h.model,h.config,'travel',1,.1,true);
  assert.equal(mesh.isEnabled(),true);assert.equal(mesh.material,material);near(material._colors3.arrowColor.b,1);
});

test('旧底盘挂点、短长度和沿轴偏移不截短或移动全轨箭头，机体行走轨道箭头不平移', t => {
  const h=fixture(t);
  Object.assign(h.config.channels.travel,{surfaceNode:'base',length:2.2,offsetAlong:3});
  h.renderer.update('one',h.model,h.config,'travel',1,.1,true);
  const mesh=arrow(h.scene,'travel'), before=point(mesh);
  near(point(mesh,-.5).z,-10);near(point(mesh,.5).z,10);
  h.base.position.z=5;h.mast.position.z=5;
  h.renderer.update('one',h.model,h.config,'travel',-1,.1,true);
  assert.ok(point(mesh).subtract(before).length()<1e-5);
  near(mesh.material._floats.stripLength,20);
});

test('旋转/镜像/非均匀缩放下全轨端点跟随轨道；上导轨不抬高底部箭头', t => {
  const h=fixture(t);
  const upper=h.rail.clone('upper-rail',h.model.contentRoot);upper.position.y=8;upper.scaling.z=.6;
  const declared=h.model.externalScriptRuntime.getDataDrivenConfigs()[0];declared.fixedNodes.push('upper-rail');
  h.model.externalScriptRuntime={getDataDrivenConfigs:()=>[declared]};
  h.root.rotation.y=.7;h.root.scaling.set(-1.3,.8,2);h.root.position.set(5,1,-3);
  h.renderer.update('one',h.model,h.config,'travel',1,.1,true);
  const mesh=arrow(h.scene,'travel'),matrix=h.root.computeWorldMatrix(true);
  for(const sign of [-1,1]) {
    const expected=Vector3.TransformCoordinates(new Vector3(0,.065,sign*10),matrix);
    assert.ok(point(mesh,sign*.5).subtract(expected).length()<1e-5);
  }
});

test('升降避让平台实际高度，缺口随平台移动并在反向或变换后保持几何区段', t => {
  const h=fixture(t), config=h.config.channels.lift;
  config.length=5;config.surfaceNode='mast';
  const surface=surfaces.createStackerArrowSurface(h.model,'lift',config,'test',h.scene);
  const placement=()=>surfaces.resolveStackerArrowPlacement(surface,h.model,'lift',config);
  const first=placement();assert.equal(typeof first,'object');assert.ok(first.liftGap,'需要载货台避让区段');
  near(first.liftGap.min,(1.85-.03-.5)/5);near(first.liftGap.max,(2.15+.03-.5)/5);
  h.platform.position.y+=1;
  const moved=placement();near(moved.liftGap.min-first.liftGap.min,.2);near(moved.liftGap.max-first.liftGap.max,.2);
  h.root.rotation.y=.6;h.root.scaling.set(-1.4,2,.7);
  const transformed=placement();near(transformed.liftGap.min,moved.liftGap.min);near(transformed.liftGap.max,moved.liftGap.max);
  h.platform.position.y=20;assert.equal(placement().liftGap,undefined);
});

test('轨道或平台缺失时诊断隐藏，不回退为底盘短箭头或穿台整条箭头', t => {
  const h=fixture(t);h.rail.dispose();
  assert.match(h.renderer.update('one',h.model,h.config,'travel',1,.1,true),/轨道/);
  h.platform.dispose();
  assert.match(h.renderer.update('one',h.model,h.config,'lift',1,.1,true),/载货台/);
});

test('声明分段轨道合并全长，旧局部或已失效挂点不能截短和阻断固定轨道', t => {
  const h=fixture(t),second=h.rail.clone('rail-second',h.model.contentRoot);second.position.z=20;
  const declaration=h.model.externalScriptRuntime.getDataDrivenConfigs()[0];declaration.fixedNodes.push('rail-second');
  h.model.externalScriptRuntime={getDataDrivenConfigs:()=>[declaration]};
  for(const selector of ['rail','old-base-removed']) {
    h.config.channels.travel.surfaceNode=selector;
    assert.equal(h.renderer.update('one',h.model,h.config,'travel',1,.1,true),null);
    near(point(arrow(h.scene,'travel'),-.5).z,-10);near(point(arrow(h.scene,'travel'),.5).z,30);
  }
});

test('声明轨道父容器时只用下轨几何，不因父节点含上轨而抬高整条箭头', t => {
  const h=fixture(t),group=new TransformNode('track-root',h.scene);group.parent=h.model.contentRoot;h.rail.parent=group;
  const upper=h.rail.clone('upper-rail',group);upper.position.y=8;
  const declaration=h.model.externalScriptRuntime.getDataDrivenConfigs()[0];declaration.fixedNodes=['track-root'];
  h.model.externalScriptRuntime={getDataDrivenConfigs:()=>[declaration]};
  assert.equal(h.renderer.update('one',h.model,h.config,'travel',1,.1,true),null);
  near(point(arrow(h.scene,'travel')).y,.065);near(arrow(h.scene,'travel').material._floats.stripLength,20);
});
