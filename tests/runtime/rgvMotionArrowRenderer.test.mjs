import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConveyorArrowModules } from '../helpers/conveyorSurfaceArrowModules.mjs';

const [{ RgvMotionArrowRenderer, rgvMotionArrowKey }] = await loadConveyorArrowModules([
  'src/runtime/babylon/effects/RgvMotionArrowRenderer.ts',
]);
const { NullEngine, Scene, TransformNode, MeshBuilder, Vector3, Matrix, Constants } = await import('@babylonjs/core');

function fixture(t) {
  const engine = new NullEngine(), scene = new Scene(engine);
  void scene.defaultMaterial;
  const root = new TransformNode('root', scene), contentRoot = new TransformNode('content', scene);
  contentRoot.parent = root;
  const part = (name, size, position) => {
    const mesh = MeshBuilder.CreateBox(name, size, scene); mesh.parent = contentRoot;
    mesh.position.copyFromFloats(...position); return mesh;
  };
  const left = part('leftRail', { width: .12, height: .15, depth: 20 }, [-.8,.2,3]);
  const right = part('rightRail', { width: .12, height: .15, depth: 20 }, [.8,.2,3]);
  const front = part('frontDeck', { width: 1.5, height: .2, depth: .8 }, [0,.8,.7]);
  const back = part('backDeck', { width: 1.5, height: .2, depth: .8 }, [0,.8,-.7]);
  const body = part('body', { width: 1.6, height: .5, depth: 2.5 }, [0,.45,0]);
  const declarations = [{ fixedNodes: ['leftRail','rightRail'], cargo: { frontNodes: ['frontDeck'], backNodes: ['backDeck'] } }];
  const model = { root, contentRoot, meshes: [left,right,front,back,body], assetSignature: 'one', loadToken: 1,
    entitySnapshot: { components: { modelAsset: { unitScaleToMeters: 1 } } },
    externalScriptRuntime: { getDataDrivenConfigs: () => declarations } };
  const channel = () => ({ enabled: true, surfaceNode: '', surfaceOffset: .015, offsetAlong: 0,
    offsetAcross: 0, length: 0, width: 0, reverse: false, face: 'top' });
  const config = { enabled: true, style: 'moving-double-arrow', color: '#39d8ff', intensity: 1,
    opacity: .9, speed: .7, arrowLength: .45, arrowWidth: .38, spacing: .9,
    breathingEnabled: false, breathingPeriod: 1.8, breathingStrength: .7,
    channels: { travel: channel(), front: channel(), back: channel() } };
  const renderer = new RgvMotionArrowRenderer(scene);
  t.after(() => { renderer.dispose(); scene.dispose(); engine.dispose(); });
  return { scene, root, contentRoot, model, config, renderer, left, right, front, back, body, declarations, part };
}
const arrow = (h, channel) => h.scene.meshes.find(mesh => mesh.name === '__rgvMotionArrows_one_' + channel);
const point = (mesh, x = 0, z = 0) => Vector3.TransformCoordinates(new Vector3(x,0,z), mesh.computeWorldMatrix(true));
const near = (a,b) => assert.ok(Math.abs(a-b)<1e-5, `${a} != ${b}`);
const run = (h, channel, direction = 1, delta = .1, visible = true) => h.renderer.update('one',h.model,h.config,channel,direction,delta,visible);

test('行走在双轨正上方覆盖全长，禁止侧面、横向与纵向偏移缩短固定范围', t => {
  const h=fixture(t);
  Object.assign(h.config.channels.travel,{face:'side',offsetAcross:3,offsetAlong:2,length:1});
  assert.equal(run(h,'travel'),null);
  const mesh=arrow(h,'travel');
  near(point(mesh).x,0); near(point(mesh).y,.29); near(point(mesh).z,3);
  near(Vector3.Distance(point(mesh,.5),point(mesh,-.5)),20);
  near(point(mesh,.5).subtract(point(mesh,-.5)).normalize().z,1);
  assert.equal(mesh.metadata.rgvMotionArrow,true);
  assert.equal(mesh.isPickable,false); assert.equal(mesh.material.depthFunction,Constants.LEQUAL);
  assert.equal(mesh.material.disableDepthWrite,true);
  assert.equal(h.root.getChildMeshes().includes(mesh),false);
});

test('根节点固定而车体节点移动时，双工位随真实台面，轨道保持固定', t => {
  const h=fixture(t);
  for(const channel of ['travel','front','back']) assert.equal(run(h,channel),null);
  const before=Object.fromEntries(['travel','front','back'].map(channel=>[channel,point(arrow(h,channel))]));
  h.front.position.z+=4; h.back.position.z+=4; h.body.position.z+=4;
  for(const channel of ['travel','front','back']) run(h,channel);
  near(point(arrow(h,'travel')).z,before.travel.z);
  near(point(arrow(h,'front')).z,before.front.z+4);
  near(point(arrow(h,'back')).z,before.back.z+4);
  near(point(arrow(h,'front'),.5).subtract(point(arrow(h,'front'),-.5)).normalize().x,1);
  near(point(arrow(h,'back')).y,.915);
});

test('整机旋转缩放镜像后，轨顶中心和两工位运动方向保持模型轴语义', t => {
  const h=fixture(t); h.root.position.set(3,2,5);h.root.rotation.set(.1,.6,0);h.root.scaling.set(-1.2,.8,1.4);
  run(h,'travel');run(h,'front');
  const matrix=h.root.computeWorldMatrix(true);
  assert.ok(Vector3.Distance(point(arrow(h,'travel')),Vector3.TransformCoordinates(new Vector3(0,.29,3),matrix))<1e-5);
  const expected=Vector3.TransformNormal(Vector3.Right(),matrix).normalize();
  assert.ok(point(arrow(h,'front'),.5).subtract(point(arrow(h,'front'),-.5)).normalize().subtract(expected).length()<1e-5);
});

test('厘米预旋转和部件建模缩放不污染米配置，箭头仍位于模型局部上方', t => {
  const h=fixture(t);h.contentRoot.scaling.setAll(.01);h.contentRoot.rotation.x=-Math.PI/2;
  for(const mesh of h.model.meshes) {
    mesh.bakeTransformIntoVertices(Matrix.RotationX(Math.PI/2).multiply(Matrix.Scaling(100,100,100)));
    mesh.position=Vector3.TransformCoordinates(mesh.position,Matrix.RotationX(Math.PI/2)).scale(100);
  }
  h.config.channels.front.surfaceNode='frontDeck';h.config.channels.front.length=.8;
  assert.equal(run(h,'front'),null);assert.equal(run(h,'travel'),null);
  near(point(arrow(h,'front')).y,.915);
  near(Vector3.Distance(point(arrow(h,'front'),.5),point(arrow(h,'front'),-.5)),.8);
  near(point(arrow(h,'travel')).y,.29);near(point(arrow(h,'travel')).x,0);
});

test('轨道参数和台面缩放改变后重新测量范围，不逐帧读取顶点', t => {
  const h=fixture(t);run(h,'travel');run(h,'front');
  for(const mesh of h.model.meshes) mesh.getVerticesData=()=>{throw Error('逐帧读取顶点');};
  h.left.scaling.z=2;h.right.scaling.z=2;h.left.position.y+=.3;h.right.position.y+=.3;
  h.front.scaling.x=2;
  assert.equal(run(h,'travel'),null);assert.equal(run(h,'front'),null);
  near(Vector3.Distance(point(arrow(h,'travel'),.5),point(arrow(h,'travel'),-.5)),40);
  near(point(arrow(h,'travel')).y,.59);
  near(Vector3.Distance(point(arrow(h,'front'),.5),point(arrow(h,'front'),-.5)),2.7);
});

test('没有可信挂点时隐藏诊断，不使用整机范围，手动唯一路径可校准', t => {
  const h=fixture(t);h.declarations[0].cargo={};h.front.name='partA';h.back.name='partB';
  assert.match(run(h,'front'),/前.*台面/);
  assert.equal(arrow(h,'front').isEnabled(),false);
  h.config.channels.front.surfaceNode='partA';assert.equal(run(h,'front'),null);
  const branch=new TransformNode('branch',h.scene);branch.parent=h.contentRoot;h.front.clone('partA',branch);
  h.config.channels.front.surfaceNode='branch/partA';assert.equal(run(h,'front'),null);
  h.config.channels.front.surfaceNode='partA';assert.match(run(h,'front'),/不唯一/);
  h.config.channels.front.surfaceNode='missing';assert.match(run(h,'front'),/未找到/);
});

test('轨道或工位节点隐藏后立即隐藏箭头，重新显示时恢复', t => {
  const h=fixture(t);run(h,'travel');run(h,'front');
  h.left.setEnabled(false);h.right.setEnabled(false);h.front.isVisible=false;
  assert.match(run(h,'travel'),/几何|隐藏/);assert.match(run(h,'front'),/几何|隐藏/);
  assert.equal(arrow(h,'travel').isEnabled(),false);assert.equal(arrow(h,'front').isEnabled(),false);
  h.left.setEnabled(true);h.right.setEnabled(true);h.front.isVisible=true;
  assert.equal(run(h,'travel'),null);assert.equal(run(h,'front'),null);
});

test('单侧轨道暂时失效时隐藏行走箭头，不把双轨中心跳到另一侧', t => {
  const h=fixture(t);run(h,'travel');h.left.setEnabled(false);
  assert.match(run(h,'travel'),/固定轨道|隐藏/);assert.equal(arrow(h,'travel').isEnabled(),false);
  h.left.setEnabled(true);assert.equal(run(h,'travel'),null);near(point(arrow(h,'travel')).x,0);
});

test('工位侧面手动范围偏移与呼吸外观可独立校准', t => {
  const h=fixture(t);
  Object.assign(h.config.channels.front,{face:'side',length:.8,width:.15,offsetAlong:.2,offsetAcross:.1});
  h.config.breathingEnabled=true;h.config.style='conveyor-arrow-chevron';
  assert.equal(run(h,'front',1,.45),null);
  const mesh=arrow(h,'front');near(point(mesh).x,.2);near(point(mesh).y,.9);near(point(mesh).z,1.115);
  near(Vector3.Distance(point(mesh,.5),point(mesh,-.5)),.8);
  near(Vector3.Distance(point(mesh,0,.5),point(mesh,0,-.5)),.15);
  assert.ok(mesh.material._floats.breathingFactor<1);assert.equal(mesh.material._floats.arrowStyle,5);
});

test('固定声明错误不猜测车体；旧 A45/A46 双轨排除更高更长盖板', t => {
  const h=fixture(t);h.left.name='A45';h.right.name='A46';h.declarations[0].fixedNodes=[];
  const cap=h.part('A37',{width:3,height:1,depth:30},[0,1,3]);h.model.meshes.push(cap);
  assert.equal(run(h,'travel'),null);near(point(arrow(h,'travel')).y,.29);
  near(Vector3.Distance(point(arrow(h,'travel'),.5),point(arrow(h,'travel'),-.5)),20);
  h.declarations[0].fixedNodes=['not-found'];h.model.loadToken++;
  assert.match(run(h,'travel'),/固定轨道/);
});

test('手动行走挂点选择单轨仍沿双轨中心全长，移动部件不能充当固定轨道', t => {
  const h=fixture(t);h.config.channels.travel.surfaceNode='leftRail';
  assert.equal(run(h,'travel'),null);near(point(arrow(h,'travel')).x,0);
  near(Vector3.Distance(point(arrow(h,'travel'),.5),point(arrow(h,'travel'),-.5)),20);
  h.config.channels.travel.surfaceNode='body';assert.match(run(h,'travel'),/固定轨道/);
  h.config.channels.front.surfaceNode='leftRail';assert.match(run(h,'front'),/台面|固定轨道/);
});

test('固定声明和自动工位声明精确匹配，不把同名前缀的其它部件合并进来', t => {
  const h=fixture(t);
  const unrelated=h.part('leftRail_extra',{width:8,height:8,depth:80},[8,8,8]);h.model.meshes.push(unrelated);
  assert.equal(run(h,'travel'),null);near(point(arrow(h,'travel')).x,0);
  near(Vector3.Distance(point(arrow(h,'travel'),.5),point(arrow(h,'travel'),-.5)),20);
});

test('正常停机120ms淡出并冻结相位，异常立即隐藏，重新运行复用资源', t => {
  const h=fixture(t), count=()=>[h.scene.meshes.length,h.scene.materials.length,h.scene.transformNodes.length];
  const initial=count();run(h,'travel',0);assert.deepEqual(count(),initial);
  run(h,'travel');const mesh=arrow(h,'travel'),phase=mesh.material._floats.phase;
  run(h,'travel',0,.06);near(mesh.material._floats.opacity,.45);near(mesh.material._floats.phase,phase);
  run(h,'travel',0,.06);assert.equal(mesh.isEnabled(),false);
  run(h,'travel',-1);assert.equal(arrow(h,'travel'),mesh);assert.equal(mesh.material._floats.direction,-1);
  run(h,'travel',1,.01,false);assert.equal(mesh.isEnabled(),false);
  h.renderer.retain(new Set());assert.deepEqual(count(),initial);
});

test('独立通道方向反转与强度关闭，禁用释放单路而保留另一路', t => {
  const h=fixture(t);h.config.channels.back.reverse=true;
  run(h,'front');run(h,'back');
  assert.equal(arrow(h,'front').material._floats.direction,1);assert.equal(arrow(h,'back').material._floats.direction,-1);
  h.config.intensity=0;run(h,'front');assert.equal(arrow(h,'front').isEnabled(),false);
  h.config.intensity=1;h.config.channels.front.enabled=false;run(h,'front');assert.equal(arrow(h,'front'),undefined);
  assert.ok(arrow(h,'back'));h.renderer.retain(new Set([rgvMotionArrowKey('one','back')]));assert.ok(arrow(h,'back'));
  h.config.enabled=false;run(h,'back');assert.equal(arrow(h,'back'),undefined);
});

test('模型重载重新绑定新台面，挂点释放和退化矩阵立即诊断隐藏', t => {
  const h=fixture(t);run(h,'front');h.front.dispose();
  assert.match(run(h,'front'),/几何|释放/);assert.equal(arrow(h,'front').isEnabled(),false);
  const newFront=h.part('frontDeck',{width:2,height:.3,depth:1},[0,1,2]);
  h.model.meshes=h.model.meshes.filter(m=>m!==h.front).concat(newFront);h.model.loadToken++;
  assert.equal(run(h,'front'),null);near(point(arrow(h,'front')).y,1.165);
  h.root.scaling.x=0;assert.match(run(h,'front'),/退化/);assert.equal(arrow(h,'front').isEnabled(),false);
});

test('阵列代理映射自身根变换，宿主根隐藏不影响局部挂点可见性', t => {
  const h=fixture(t);h.root.position.set(20,2,3);h.root.setEnabled(false);
  const proxyRoot=new TransformNode('proxy',h.scene);proxyRoot.position.set(-5,1,4);proxyRoot.rotation.y=.4;
  const proxy={...h.model,root:proxyRoot,telemetryProxySource:h.model};
  assert.equal(h.renderer.update('one',proxy,h.config,'travel',1,.1,true),null);
  const expected=Vector3.TransformCoordinates(new Vector3(0,.29,3),proxyRoot.computeWorldMatrix(true));
  assert.ok(Vector3.Distance(point(arrow(h,'travel')),expected)<1e-5);
});
