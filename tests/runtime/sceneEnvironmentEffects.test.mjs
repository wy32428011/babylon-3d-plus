import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import ts from 'typescript';

const root = new URL('../../src/', import.meta.url);
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && context.parentURL?.startsWith(root.href)) {
      const candidate = new URL(specifier, context.parentURL);
      if (!existsSync(candidate) && existsSync(new URL(candidate.href + '.ts'))) return next(candidate.href + '.ts', context);
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith(root.href) && url.endsWith('.ts')) return { format: 'module', shortCircuit: true, source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText };
    return next(url, context);
  },
});
const { SceneEnvironmentEffects } = await import('../../src/runtime/babylon/effects/SceneEnvironmentEffects.ts');
const { createDefaultPoiEffectComponent } = await import('../../src/editor/model/poiEffect.ts');
hooks.deregister();
const { NullEngine, Scene, ArcRotateCamera, Vector3, MeshBuilder, HemisphericLight } = await import('@babylonjs/core');
function setup(t) {
  const engine = new NullEngine(); const scene = new Scene(engine);
  const camera = new ArcRotateCamera('camera', 1, 1, 20, Vector3.Zero(), scene);
  const target = MeshBuilder.CreateBox('target', {}, scene);
  let runtime = false;
  const effects = new SceneEnvironmentEffects(scene, id => id === 'target' ? target : null, () => runtime);
  t.after(() => { effects.dispose(); scene.dispose(); engine.dispose(); });
  return { scene, camera, target, effects, start: () => { runtime = true; } };
}
test('雾和昼夜关闭后恢复原始灯光，单实例优先且零透明度关闭雾', t => {
  const { scene, effects } = setup(t);
  const light = new HemisphericLight('light', Vector3.Up(), scene); light.intensity = 1.7;
  const day = createDefaultPoiEffectComponent('day-night'); day.visual.progress = 1;
  const fog = createDefaultPoiEffectComponent('environment-fog');
  effects.sync('day', day, true); effects.sync('fog', fog, true); effects.tick(0.1);
  assert.ok(light.intensity < 0.2); assert.equal(scene.fogMode, Scene.FOGMODE_LINEAR);
  fog.visual.opacity = 0; effects.tick(0.1); assert.equal(scene.fogMode, Scene.FOGMODE_NONE);
  effects.sync('day', day, false); effects.disposeMissing(new Set()); effects.tick(0);
  assert.equal(light.intensity, 1.7); assert.equal(scene.environmentIntensity, 1);
  assert.equal(scene.fogMode, Scene.FOGMODE_NONE);
});
test('目标跟随只在运行时生效，移动目标后镜头跟随，关闭后恢复', t => {
  const { effects, camera, target, start } = setup(t);
  const pose = { alpha:camera.alpha,beta:camera.beta,radius:camera.radius,target:camera.target.clone() };
  const config = createDefaultPoiEffectComponent('target-follow'); config.visual.targetEntityId = 'target';
  effects.sync('follow', config, true); effects.tick(.1); assert.equal(camera.radius,20);
  start(); target.position.x = 10; effects.tick(.1); assert.equal(camera.target.x,10);
  target.position.x = 20; effects.tick(.1); assert.ok(camera.target.x > 10);
  effects.sync('follow',config,false); effects.tick(.1);
  assert.equal(camera.radius,pose.radius); assert.deepEqual(camera.target.asArray(),pose.target.asArray());
});
test('用户调整或其他镜头控制器接管后，不再被跟随覆盖', t => {
  const { effects,camera,start,target } = setup(t); start();
  const config = createDefaultPoiEffectComponent('target-follow'); config.visual.targetEntityId='target';
  effects.sync('f',config,true); effects.tick(.1);
  camera.setTarget(new Vector3(30,0,0)); camera.alpha = 2.5; target.position.x=100;
  effects.tick(.1); assert.equal(camera.target.x,30); assert.equal(camera.alpha,2.5);
  effects.disposeMissing(new Set()); effects.tick(.1); assert.equal(camera.target.x,30);
});

test('昼夜效果激活期间编辑灯光，关闭后保留新配置', t => {
  const {scene,effects}=setup(t);
  const light = new HemisphericLight('editable-light',Vector3.Up(),scene);
  const config=createDefaultPoiEffectComponent('day-night');config.visual.progress=1;
  effects.sync('day',config,true);effects.tick(.1);
  light.intensity=2;scene.environmentIntensity=.6;
  effects.tick(.1);
  assert.ok(Math.abs(light.intensity-.16)<.000001);
  effects.sync('day',config,false);effects.tick(.1);
  assert.equal(light.intensity,2);assert.equal(scene.environmentIntensity,.6);
});
