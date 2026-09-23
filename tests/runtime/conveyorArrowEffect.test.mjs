import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { Constants, MeshBuilder, NullEngine, Ray, Scene, TransformNode, Vector3 } from '@babylonjs/core';
import ts from 'typescript';

const SOURCE_ROOT = new URL('../../src/', import.meta.url);
const PROJECT_ROOT = new URL('../../', import.meta.url);

// 内存转译避免依赖整库预构建，也不生成需要清理的临时文件或目录。
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && context.parentURL?.startsWith(PROJECT_ROOT.href)) {
      const candidate = new URL(specifier, context.parentURL);
      const typescriptCandidate = new URL(candidate.href.endsWith('.js') ? candidate.href.slice(0,-3) + '.ts' : `${candidate.href}.ts`);
      if (!existsSync(candidate) && existsSync(typescriptCandidate)) {
        return nextResolve(typescriptCandidate.href, context);
      }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith(PROJECT_ROOT.href) && url.endsWith('.ts')) {
      const source = ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
      }).outputText;
      return { format: 'module', source, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

let PoiEffectRuntime, ConveyorArrowEffect, ConveyorSurfaceArrowRenderer, createDefaultConveyorSurfaceArrowsConfig;
let sanitizePoiEffectComponent;
try {
  ({ ConveyorArrowEffect } = await import(new URL('runtime/babylon/effects/ConveyorArrowEffect.ts', SOURCE_ROOT).href));
  ({ ConveyorSurfaceArrowRenderer } = await import(new URL('runtime/babylon/effects/ConveyorSurfaceArrowRenderer.ts', SOURCE_ROOT).href));
  ({ createDefaultConveyorSurfaceArrowsConfig } = await import(new URL('editor/model/conveyorSurfaceArrows.ts', SOURCE_ROOT).href));
  ({ PoiEffectRuntime } = await import(new URL('runtime/babylon/effects/PoiEffectRuntime.ts', SOURCE_ROOT).href));
  ({ sanitizePoiEffectComponent } = await import(new URL('editor/model/poiEffect.ts', SOURCE_ROOT).href));
} finally {
  hooks.deregister();
}


const KINDS = ['conveyor-arrow-single', 'conveyor-arrow-chevron', 'conveyor-arrow-segmented', 'conveyor-arrow-ribbon', 'conveyor-arrow-double', 'conveyor-arrow-speed'];
function setup(t, kind = KINDS[0]) {
  const engine = new NullEngine(); const scene = new Scene(engine); void scene.defaultMaterial;
  const original = { meshes: scene.meshes.length, materials: scene.materials.length, nodes: scene.transformNodes.length, observers: scene.onBeforeRenderObservable.observers.length };
  const runtime = new PoiEffectRuntime(scene); let milliseconds = 0; runtime.now = () => milliseconds;
  const entity = { id: 'arrow-test', components: { poiEffect: sanitizePoiEffectComponent({ effectKind: kind, enabled: true, speed: 1 }), transform: { position: {x:0,y:0,z:0}, rotation: {x:0,y:0,z:0}, scale: {x:1,y:1,z:1} } } };
  const sync = (visible = true, pickable = true) => runtime.sync(entity, false, visible, pickable);
  const tick = (delta = 50) => { milliseconds += delta; scene.onBeforeRenderObservable.notifyObservers(scene); };
  t.after(() => { runtime.dispose(); scene.dispose(); engine.dispose(); }); sync();
  return { scene, runtime, entity, sync, tick, original };
}

test('六种箭头由单平面 shader 渲染，拾取和平面尺寸一致且保留遮挡', t => {
  for (const [index, kind] of KINDS.entries()) {
    const { scene, runtime, entity } = setup(t, kind); const mesh = runtime.getPickMesh(entity.id);
    assert.equal(mesh.name, 'arrow-test_conveyor_arrow'); assert.equal(mesh.getTotalVertices(), 4);
    assert.equal(mesh.material._floats.arrowStyle, index); assert.equal(mesh.material._floats.arrowCount, 5);
    assert.equal(mesh.material.disableDepthWrite, true); assert.equal(mesh.material.depthFunction, Constants.LEQUAL);
    mesh.computeWorldMatrix(true); const box = mesh.getBoundingInfo().boundingBox;
    assert.ok(Math.abs(box.maximumWorld.x - box.minimumWorld.x - 6) < 1e-6);
    assert.equal(mesh.metadata.editorEntityId, entity.id);
    const hit = scene.pickWithRay(new Ray(new Vector3(2.8, 3, 0), new Vector3(0, -1, 0)));
    assert.equal(hit.pickedMesh, mesh);
    assert.equal(scene.getMeshByName('arrow-test_poiEffectPickShell').isPickable, false);
  }
});

test('修改尺寸外观数量方向原位更新，速度零和隐藏暂停，恢复连续流动', t => {
  const { runtime, entity, sync, tick } = setup(t); const mesh = runtime.getPickMesh(entity.id); const material = mesh.material;
  tick(); tick(); const phase = material._floats.flowPhase; assert.ok(phase > 0);
  entity.components.poiEffect = { ...entity.components.poiEffect, primaryColor: '#ff0000', secondaryColor: '#00ff00', speed: 0, intensity: 2, conveyorArrow: { length: 8, width: 2, count: 9, opacity: 0.6, reverse: true } };
  sync(); assert.equal(runtime.getPickMesh(entity.id), mesh); assert.equal(mesh.material, material);
  assert.equal(material._floats.direction, -1); assert.equal(material._floats.arrowCount, 9); assert.equal(material._floats.arrowOpacity, .6);
  assert.deepEqual(material._colors3.arrowColor.asArray(), [1,0,0]); assert.deepEqual(mesh.scaling.asArray(), [8,1,2]);
  tick(); assert.equal(material._floats.flowPhase, phase);
  entity.components.poiEffect.speed = 2; sync(false); tick(); assert.equal(material._floats.flowPhase, phase); assert.equal(mesh.isPickable, false);
  sync(true, false); tick(); assert.ok(material._floats.flowPhase > phase); assert.equal(mesh.isPickable, false);
});

test('数量有界、禁用与类型切换释放资源，唯一帧观察者严格清理', t => {
  const { scene, runtime, entity, sync, original } = setup(t); const mesh = runtime.getPickMesh(entity.id);
  entity.components.poiEffect.conveyorArrow.count = 100000; sync(); assert.equal(mesh.material._floats.arrowCount, 32);
  assert.equal(scene.onBeforeRenderObservable.observers.length, original.observers + 1);
  entity.components.poiEffect.enabled = false; sync(); assert.equal(mesh.isDisposed(), true);
  assert.equal(scene.getMeshByName('arrow-test_poiEffectPickShell').isVisible, false);
  entity.components.poiEffect = sanitizePoiEffectComponent({ effectKind: KINDS[5] }); sync();
  assert.equal(runtime.getPickMesh(entity.id).material._floats.arrowStyle, 5);
  runtime.dispose(); scene.onBeforeRenderObservable.notifyObservers(scene);
  assert.equal(scene.meshes.length, original.meshes); assert.equal(scene.materials.length, original.materials); assert.equal(scene.transformNodes.length, original.nodes);
  assert.equal(scene.onBeforeRenderObservable.observers.filter(observer => !observer._willBeUnregistered).length, original.observers);
});

test('六种新样式复用输送面几何，正反方向与样式 uniform 切换保留资源', t => {
  const engine = new NullEngine(); const scene = new Scene(engine);
  const root = new TransformNode('conveyor-root', scene); const contentRoot = new TransformNode('conveyor-content', scene); contentRoot.parent = root;
  const belt = MeshBuilder.CreateBox('belt', {width:6,height:.4,depth:1.2}, scene); belt.parent = contentRoot;
  const model = { root, contentRoot, meshes:[belt], assetSignature:'one', parameterSignature:'', loadToken:1,
    entitySnapshot:{components:{modelAsset:{unitScaleToMeters:1,dataDrivenConfig:{device:{devType:'conveyor'},fixedNodes:[],cargo:{travel:{axis:'x',nodes:['belt']}}}}}} };
  const renderer = new ConveyorSurfaceArrowRenderer(scene); const config = createDefaultConveyorSurfaceArrowsConfig();
  t.after(() => { renderer.dispose(); scene.dispose(); engine.dispose(); });
  let mesh, material;
  for (const [index, style] of KINDS.entries()) {
    config.style = style;
    assert.equal(renderer.update('belt-one',model,config,index%2 ? -1 : 1,.05,true),null);
    mesh ??= scene.getMeshByName('__conveyorSurfaceArrows_belt-one'); material ??= mesh.material;
    assert.equal(scene.getMeshByName('__conveyorSurfaceArrows_belt-one'),mesh); assert.equal(mesh.material,material);
    assert.equal(material._floats.arrowStyle,index+4); assert.equal(material._floats.direction,index%2 ? -1 : 1);
  }
  config.speed = .7; config.style = 'conveyor-arrow-ribbon'; config.spacing = .9;
  renderer.update('phase-a',model,config,1,1.6,true);
  config.spacing = 2.4; renderer.update('phase-b',model,config,1,1.6,true);
  const phaseA = scene.getMeshByName('__conveyorSurfaceArrows_phase-a').material._floats.phase;
  const phaseB = scene.getMeshByName('__conveyorSurfaceArrows_phase-b').material._floats.phase;
  assert.ok(Math.abs(phaseA-.728)<1e-7); assert.equal(phaseA,phaseB);
  config.style = 'conveyor-direction'; config.spacing = .9; renderer.update('legacy-phase',model,config,1,1.6,true);
  assert.ok(Math.abs(scene.getMeshByName('__conveyorSurfaceArrows_legacy-phase').material._floats.phase-.22)<1e-7);
  assert.equal(scene.onBeforeRenderObservable.observers.length,0);
  assert.equal(mesh.isPickable,false);
  renderer.update('belt-one',model,config,0,.05,true); assert.equal(mesh.isEnabled(),false);
});

test('独立箭头的无效帧和长期帧保持有限相位，隐藏时不积累动画', t => {
  const { scene, entity } = setup(t);
  const root = new TransformNode('direct-root',scene);
  const arrow = new ConveyorArrowEffect('direct',scene,root,entity.components.poiEffect);
  t.after(() => arrow.dispose());
  arrow.tick(1000000000000); const phase = arrow.material._floats.flowPhase;
  assert.ok(phase >= 0 && phase < 1);
  for (const delta of [NaN, Infinity, -1, 0]) arrow.tick(delta);
  assert.equal(arrow.material._floats.flowPhase,phase);
  arrow.setActive(false); arrow.tick(1); assert.equal(arrow.material._floats.flowPhase,phase);
});
