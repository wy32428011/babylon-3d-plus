import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import ts from 'typescript';

const root = new URL('../../src/', import.meta.url);
const electronRoot = new URL('../../electron/', import.meta.url);
const isSource = url => url?.startsWith(root.href) || url?.startsWith(electronRoot.href);
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && isSource(context.parentURL)) {
      const candidate = new URL(specifier, context.parentURL);
      const source = new URL(candidate.href.replace(/\.js$/, '') + '.ts');
      if (!existsSync(candidate) && existsSync(source)) return next(source.href, context);
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (isSource(url) && /\.(png|svg|jpg|webp)$/.test(url)) return { format: 'module', shortCircuit: true, source: `export default ${JSON.stringify(url)}` };
    if (isSource(url) && url.endsWith('.ts')) return { format: 'module', shortCircuit: true, source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText };
    return next(url, context);
  },
});
const { PoiEffectRuntime } = await import('../../src/runtime/babylon/effects/PoiEffectRuntime.ts');
const { createDefaultPoiEffectComponent } = await import('../../src/editor/model/poiEffect.ts');
hooks.deregister();
const {NullEngine,Scene,StandardMaterial}=await import('@babylonjs/core');
function setup(t,kind){
  const engine=new NullEngine(),scene=new Scene(engine); void scene.defaultMaterial;
  const baseline={meshes:scene.meshes.length,materials:scene.materials.length};
  const runtime=new PoiEffectRuntime(scene);
  let clock=0;runtime.now=()=>clock;
  const entity={id:'effect',components:{transform:{position:{x:0,y:0,z:0},rotation:{x:0,y:0,z:0},scale:{x:1,y:1,z:1}},poiEffect:createDefaultPoiEffectComponent(kind)}};
  const sync=()=>runtime.sync(entity,false,true,true);
  const tick=()=>{clock+=100;scene.onBeforeRenderObservable.notifyObservers(scene);};
  t.after(()=>{runtime.dispose();scene.dispose();engine.dispose();});
  return{engine,scene,runtime,entity,sync,tick,baseline};
}
test('通过编辑同步将速度改0时不重建空间效果，也不跳回路径起点',t=>{
  const h=setup(t,'flow-arrows');h.sync();h.tick();h.tick();h.tick();
  const arrows=h.scene.meshes.filter(m=>m.metadata?.effectRole==='moving-arrow');assert.ok(arrows.length);
  const previous=arrows.map(m=>m.position.asArray());
  h.entity.components.poiEffect.speed=0;h.sync();h.tick();h.tick();
  assert.deepEqual(arrows.map(m=>m.position.asArray()),previous);
  assert.ok(arrows.every(m=>!m.isDisposed()));
  h.entity.components.poiEffect.speed=2;h.sync();h.tick();
  assert.notDeepEqual(arrows.map(m=>m.position.asArray()),previous);
});
test('零透明度不会被旧特效透明度下限覆盖，删除新效果释放所有自有资源',t=>{
  const h=setup(t,'data-bars');h.entity.components.poiEffect.visual.opacity=0;h.sync();
  const bars=h.scene.meshes.filter(m=>m.metadata?.effectRole==='data-bar');assert.ok(bars.length);
  assert.ok(bars.every(m=>m.material instanceof StandardMaterial && m.material.alpha===0));
  h.runtime.disposeMissing(new Set());
  assert.equal(h.scene.meshes.length,h.baseline.meshes);
  assert.equal(h.scene.materials.length,h.baseline.materials);
});
