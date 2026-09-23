import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import ts from 'typescript';
import { NullEngine, Scene, TransformNode, ShaderMaterial, VertexBuffer, Vector3, MeshBuilder } from '@babylonjs/core';

const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && context.parentURL) {
      const candidate = new URL(specifier + '.ts', context.parentURL);
      if (existsSync(candidate)) return { url: candidate.href, shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.endsWith('.ts') && !url.includes('/node_modules/')) return { format: 'module', shortCircuit: true,
      source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText };
    return next(url, context);
  },
});
const { SpatialEffects } = await import('../../src/runtime/babylon/effects/SpatialEffects.ts');
const { ConfiguredLegacyEffects } = await import('../../src/runtime/babylon/effects/ConfiguredLegacyEffects.ts');
const { getSpatialEffectParameters } = await import('../../src/editor/model/spatialEffectParameters.ts');
const { LightWallFence } = await import('../../src/runtime/babylon/effects/LightWallFence.ts');
hooks.deregister();

function component(kind, parameters = {}, visual = {}) {
  return { effectKind: kind, enabled: true, primaryColor: '#00ffff', secondaryColor: '#ff3300', intensity: 1, speed: 1, density: 1,
    configuration: { version: 2, parameters },
    visual: { targetEntityId: null, radius: 5, height: 4, width: 0.2, opacity: 0.6, duration: 4, progress: 0, loop: true, axis: 'y', amount: 3,
      points: [{ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }], values: [10, 20], labels: ['A', 'B'], ...visual } };
}
function setup(t, c, resolve) {
  const engine = new NullEngine(), scene = new Scene(engine), root = new TransformNode('root', scene);
  const effect = new SpatialEffects('test', scene, root, c, resolve);
  t.after(() => { effect.dispose(); scene.dispose(); engine.dispose(); });
  return { effect, scene, root };
}
test('V2 反向米每秒箭头朝实际位移方向，间距限制箭头数量', t => {
  const c = component('flow-arrows', { flowDirection: 'reverse', speedMetersPerSecond: 2, arrowSpacing: 2, arrowLength: 1, arrowWidth: 0.4, maxMovers: 20 });
  const { effect } = setup(t, c);
  const arrows = effect.meshes.filter(m => m.metadata.effectRole === 'moving-arrow');
  assert.equal(arrows.length, 5);
  const arrow = arrows[1], before = arrow.position.clone(); effect.tick(0.1);
  assert.ok(Math.abs(arrow.position.x - before.x + 0.2) < 0.001);
  arrow.computeWorldMatrix(true);
  const forward = Vector3.TransformNormal(Vector3.Forward(), arrow.getWorldMatrix()).normalize();
  assert.ok(forward.x < -0.999);
});
test('数据柱实时值更新保留 Mesh 材质并按固定量程刷新高度', t => {
  const c = component('data-bars', { domainMode: 'fixed', domainMin: 0, domainMax: 100, showLabels: false });
  const { effect, scene } = setup(t, c); const before = [...effect.meshes], material = [...effect.materials];
  for (let i = 0; i < 30; i++) effect.update({ ...c, visual: { ...c.visual, values: [25, 75] } });
  assert.deepEqual(effect.meshes, before); assert.deepEqual(effect.materials, material);
  const bars = effect.meshes.filter(m => m.metadata.effectRole === 'data-bar');
  bars[0].computeWorldMatrix(true); bars[1].computeWorldMatrix(true);
  assert.ok(Math.abs(bars[0].getBoundingInfo().boundingBox.extendSizeWorld.y * 2 - 1) < 0.001);
  assert.ok(Math.abs(bars[1].getBoundingInfo().boundingBox.extendSizeWorld.y * 2 - 3) < 0.001);
  assert.equal(scene.meshes.length, before.length);
});
test('热力图数值刷新只更新颜色缓冲区', t => {
  const c = component('heatmap', { domainMode: 'fixed', domainMin: 0, domainMax: 100, influenceRadius: 2 });
  const { effect } = setup(t, c); const mesh = effect.meshes[0], initial = [...mesh.getVerticesData(VertexBuffer.ColorKind)];
  effect.update({ ...c, visual: { ...c.visual, values: [90, 90] } });
  assert.equal(effect.meshes[0], mesh); assert.notDeepEqual(mesh.getVerticesData(VertexBuffer.ColorKind), initial);
});
test('监控视锥使用独立水平垂直 FOV 与近远裁剪距离', t => {
  const { effect } = setup(t, component('camera-frustum', { horizontalFov: 90, verticalFov: 60, nearDistance: 1, farDistance: 10, yawDegrees: 0, pitchDegrees: 0, showEdges: false }));
  const mesh = effect.meshes.find(m => m.metadata.effectRole === 'camera-coverage');
  const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
  assert.equal(positions.length, 24);
  assert.ok(Math.abs(Math.max(...positions.filter((_,i) => i % 3 === 0)) - 10) < 0.001);
  assert.equal(Math.min(...positions.filter((_,i) => i % 3 === 2)), 1);
  assert.equal(Math.max(...positions.filter((_,i) => i % 3 === 2)), 10);
});
test('实际区域多边形保留区域身份并按实时值更新等级色', t => {
  const c = component('region-level', { regions: [{ id: 'west', name: '西区', value: 20, points: [{x:0,y:0,z:0},{x:6,y:0,z:0},{x:6,y:0,z:4},{x:0,y:0,z:4}] }], showLabels: false });
  const { effect } = setup(t, c); const mesh = effect.meshes.find(m => m.metadata.effectRole === 'region-polygon');
  assert.ok(mesh); assert.equal(mesh.metadata.regionId, 'west'); assert.equal(mesh.getTotalVertices(), 4);
  effect.update({ ...c, configuration: { ...c.configuration, parameters: { ...c.configuration.parameters, regions: [{ ...c.configuration.parameters.regions[0], value: 80 }] } } });
  assert.equal(effect.meshes.find(m => m.metadata.effectRole === 'region-polygon'), mesh);
  assert.equal(mesh.metadata.value, 80);
});
test('数据驱动进度不与内部时钟竞争，透明度零实时生效', t => {
  const c = component('path-reveal', { progressMode: 'data' }, { progress: 0.3 });
  const { effect } = setup(t, c); effect.tick(0.2);
  const shader = effect.materials.find(m => m instanceof ShaderMaterial);
  assert.equal(shader._floats.progress, 0.3);
  effect.update({ ...c, visual: { ...c.visual, progress: 0.8, opacity: 0 } });
  assert.equal(shader._floats.progress, 0.8); assert.equal(shader._floats.opacity, 0);
});
test('旧版特效专用运行时覆盖八种类型且销毁后无资源残留', t => {
  assert.equal(typeof ConfiguredLegacyEffects,'function');
  const engine=new NullEngine(),scene=new Scene(engine),root=new TransformNode('legacy-root',scene);void scene.defaultMaterial;
  t.after(()=>{scene.dispose();engine.dispose();});const baseline=scene.materials.length;
  for(const kind of ['alarm-pulse','warning-beacon','sparks','steam-leak','gas-leak','water-jet','cargo-target-frame','evacuation-route']) {
    const effect=new ConfiguredLegacyEffects(kind,scene,root,component(kind,{opacity:0.5,particleBudget:32}));
    assert.ok(effect.meshes.length>0);effect.tick(0.1);effect.update(component(kind,{opacity:0.2,particleBudget:32}));effect.dispose();
    assert.equal(scene.meshes.length,0,kind);assert.equal(scene.materials.length,baseline,kind);
  }
});
test('粒子数据参数原位改变发射率方向与零发射消散策略', t => {
  const c=component('smoke-plume',{particleBudget:64,emissionRate:10,particleLifetime:2,emissionDirection:{x:1,y:0,z:0},gravity:{x:0,y:-1,z:0},particleSize:0.25});
  const {effect}=setup(t,c),mesh=effect.meshes[0],shader=effect.materials[0];effect.tick(0.1);
  assert.equal(mesh.getTotalVertices(),256);assert.equal(shader._floats.size,0.25);
  effect.update({...c,configuration:{...c.configuration,parameters:{...c.configuration.parameters,emissionRate:0}}});
  assert.equal(effect.meshes[0],mesh);assert.equal(shader._floats.stoppedAt,0.1);assert.ok(shader._floats.emissionFraction>0);
  effect.update({...c,configuration:{...c.configuration,parameters:{...c.configuration.parameters,emissionRate:0,stopBehavior:'clear'}}});assert.equal(shader._floats.emissionFraction,0);
});
test('仅添加空配置不改变旧几何、uniform相位及资源预算', t => {
  const c=component('flow-arrows',{}),legacy={...c};delete legacy.configuration;
  const {effect}=setup(t,legacy);const before=effect.meshes.map(m=>[...m.getVerticesData(VertexBuffer.PositionKind)]);
  const resources=[...effect.meshes];effect.tick(0.1);const positions=effect.meshes.map(m=>m.position.clone());effect.update(c);
  assert.deepEqual(effect.meshes,resources);assert.deepEqual(effect.meshes.map(m=>[...m.getVerticesData(VertexBuffer.PositionKind)]),before);
  effect.meshes.forEach((m,i)=>assert.ok(m.position.equalsWithEpsilon(positions[i])));
});
test('区域与色带拒绝自交、重复身份、非法颜色和非有限值', () => {
  const definitions=getSpatialEffectParameters('region-level');const regions=definitions.find(d=>d.key==='regions'),levels=definitions.find(d=>d.key==='levels');
  const row={id:'A',name:'A',value:0,points:[{x:0,y:0,z:0},{x:2,y:0,z:0},{x:2,y:0,z:2},{x:0,y:0,z:2}]};
  assert.equal(regions.validate([row]),null);assert.ok(regions.validate([row,row]));assert.ok(regions.validate([{...row,points:[row.points[0],row.points[2],row.points[1],row.points[3]]}]));
  assert.ok(levels.validate([{value:Infinity,color:'#ff0000'}]));assert.ok(levels.validate([{value:0,color:'red'}]));assert.equal(levels.validate([{value:0,color:'#ff0000'}]),null);
});
test('定位框使用目标实际包围盒且运动后保留原有Mesh', t => {
  const engine=new NullEngine(),scene=new Scene(engine),root=new TransformNode('frame-root',scene),target=MeshBuilder.CreateBox('target',{width:4,height:2,depth:6},scene);
  const c=component('cargo-target-frame',{autoBounds:true,padding:0.2,cornerRatio:0.1},{targetEntityId:'target'});
  const effect=new ConfiguredLegacyEffects('frame',scene,root,c,id=>id==='target'?target:null);
  t.after(()=>{effect.dispose();scene.dispose();engine.dispose();});
  const frame=effect.meshes[0];assert.ok(frame.scaling.equalsWithEpsilon(new Vector3(4.4,2.4,6.4)));
  target.position.x=7;effect.tick(.1);assert.equal(effect.meshes[0],frame);assert.ok(Math.abs(frame.position.x-7)<.001);
});
test('连续数据点移动更新保持柱体资源并刷新空间位置', t => {
  const c=component('data-bars',{showLabels:false});const {effect}=setup(t,c),mesh=effect.meshes[0];
  effect.update({...c,visual:{...c.visual,points:[{x:8,y:3,z:4},c.visual.points[1]]}});
  assert.equal(effect.meshes[0],mesh);assert.equal(mesh.position.x,8);assert.equal(mesh.position.z,4);assert.ok(mesh.position.y>3);
});
test('米每秒调速和停流恢复保持当前位置，不按新周期跳帧', t => {
  const c=component('flow-arrows',{speedMetersPerSecond:2,arrowSpacing:2});const {effect}=setup(t,c);effect.tick(.2);
  const arrow=effect.meshes.find(m=>m.metadata.effectRole==='moving-arrow'),position=arrow.position.clone();
  const update=speed=>effect.update({...c,configuration:{...c.configuration,parameters:{...c.configuration.parameters,speedMetersPerSecond:speed}}});
  const shader=effect.materials.find(m=>m instanceof ShaderMaterial),phase=shader._floats.time;
  update(4);assert.equal(shader._floats.time,phase);assert.ok(arrow.position.equalsWithEpsilon(position));effect.tick(.1);assert.ok(Math.abs(arrow.position.x-position.x-.4)<.001);
  const paused=arrow.position.clone();update(0);effect.tick(.2);assert.ok(arrow.position.equalsWithEpsilon(paused));update(2);assert.ok(arrow.position.equalsWithEpsilon(paused));effect.tick(.1);assert.ok(Math.abs(arrow.position.x-paused.x-.2)<.001);
});
test('旧疏散路线无需visual字段也消费专用路线和出口参数', t => {
  const engine=new NullEngine(),scene=new Scene(engine),root=new TransformNode('route-root',scene);
  const c=component('evacuation-route',{routePoints:[{x:1,y:0,z:2},{x:8,y:0,z:2}],routeWidth:.4,exitSize:.3,flowDirection:'reverse'});delete c.visual;
  const effect=new ConfiguredLegacyEffects('route',scene,root,c);t.after(()=>{effect.dispose();scene.dispose();engine.dispose();});
  const exit=effect.meshes.find(m=>m.metadata.effectRole==='route-exit');assert.equal(exit.position.x,1);assert.equal(exit.position.z,2);
  const arrow=effect.meshes.find(m=>m.metadata.effectRole==='moving-arrow');const before=arrow.position.x;effect.tick(.1);assert.ok(arrow.position.x<before);
});
test('首次载入发射率为零的发射器不凭空出现历史粒子', t => {
  const {effect}=setup(t,component('flame',{emissionRate:0,particleBudget:32,stopBehavior:'drain'}));
  assert.equal(effect.materials[0]._floats.emissionFraction,0);
});
test('光墙专用配置原位改变底部标高、渐隐、光带与逆向流动', t => {
  const engine=new NullEngine(),scene=new Scene(engine),root=new TransformNode('wall-root',scene);
  const c={...component('light-wall-fence',{elevation:2,bandCount:7,fadeExponent:3,flowDirection:'reverse'}),lightWall:{height:4,opacity:.7,points:[{x:0,z:0},{x:5,z:0},{x:5,z:5},{x:0,z:5}]}};
  const wall=new LightWallFence('wall',scene,root,c);t.after(()=>{wall.mesh.dispose();wall.material.dispose();scene.dispose();engine.dispose();});
  const mesh=wall.mesh;assert.equal(mesh.position.y,2);assert.equal(wall.material._floats.bandCount,7);assert.equal(wall.material._floats.fadeExponent,3);
  wall.animate(.1);assert.ok(wall.material._floats.flowPhase<0);wall.update({...c,configuration:{...c.configuration,parameters:{...c.configuration.parameters,elevation:4}}});assert.equal(wall.mesh,mesh);assert.equal(mesh.position.y,4);
});
