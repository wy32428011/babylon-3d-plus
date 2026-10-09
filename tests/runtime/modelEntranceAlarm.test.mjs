import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { MeshBuilder, NullEngine, Scene, StandardMaterial, TransformNode } from '@babylonjs/core';
import ts from 'typescript';

const root = new URL('../../src/', import.meta.url);
const projectRoot = new URL('../../', import.meta.url);
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('@babylonjs/core/') && !specifier.endsWith('.js')) return next(specifier+'.js',context);
    if (specifier.startsWith('.') && context.parentURL?.startsWith(projectRoot.href)) {
      const url=new URL(specifier,context.parentURL);
      if (!existsSync(url) && existsSync(new URL(url.href.replace(/\.js$/,'')+'.ts'))) return next(url.href.replace(/\.js$/,'')+'.ts',context);
    }
    return next(specifier,context);
  },
  load(url,context,next) {
    if(url.startsWith(root.href)&&/\.(png|jpg|webp)$/.test(url)) return {format:'module',shortCircuit:true,source:'export default '+JSON.stringify(url)+';'};
    if((url.startsWith(root.href)||url.startsWith(new URL('electron/',projectRoot).href))&&url.endsWith('.ts')) return {format:'module',shortCircuit:true,source:ts.transpileModule(readFileSync(new URL(url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText};
    return next(url,context);
  },
});
let ModelEntranceRuntime, AlarmColorOverrides, normalize;
try {
  ({ModelEntranceRuntime}=await import(new URL('runtime/babylon/ModelEntranceRuntime.ts',root).href));
  ({AlarmColorOverrides}=await import(new URL('runtime/babylon/AlarmManagerRuntime.ts',root).href));
  ({normalizeSceneModelEntranceSettings:normalize}=await import(new URL('editor/model/sceneModelEntrance.ts',root).href));
} finally { hooks.deregister(); }

test('报警在捕获材质前中断入场，清除报警恢复真原材质；活动报警不被新入场覆盖', async t => {
  const engine=new NullEngine(), scene=new Scene(engine), node=new TransformNode('device',scene);
  const mesh=MeshBuilder.CreateBox('body',{},scene);mesh.parent=node;
  const original=new StandardMaterial('original',scene);mesh.material=original;
  const runtime=new ModelEntranceRuntime(scene), alarms=new AlarmColorOverrides();
  t.after(()=>{runtime.dispose();alarms.clear();scene.dispose();engine.dispose();});
  const targets=[{id:'device',node}], settings=normalize({enabled:true,effect:'scan'});
  await runtime.prepare(settings,targets);runtime.start();runtime.tick(.2);
  const entranceMaterial=mesh.material;assert.notEqual(entranceMaterial,original);
  alarms.apply(new Map([[mesh,'#ff0000']]));
  const alarmMaterial=mesh.material;assert.notEqual(alarmMaterial,entranceMaterial);
  assert.equal(scene.materials.includes(entranceMaterial),false,'报警必须先释放入场克隆');
  runtime.cancel();assert.equal(mesh.material,alarmMaterial,'入场取消不能覆盖报警');
  await runtime.prepare(settings,targets);assert.equal(mesh.material,alarmMaterial,'活动报警不被重入场接管');
  runtime.cancel();alarms.clear();assert.equal(mesh.material,original,'报警清除必须恢复真正的原材质');
});
