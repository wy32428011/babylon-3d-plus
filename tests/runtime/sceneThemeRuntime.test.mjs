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

const { SceneThemeRuntime } = await import('../../src/runtime/babylon/SceneThemeRuntime.ts');
const { createTechBlueNightTheme, TECH_BLUE_NIGHT_SHADOWS } = await import('../../src/editor/model/sceneTheme.ts');
hooks.deregister();
const {NullEngine,Scene,HemisphericLight,Vector3}=await import('@babylonjs/core');
test('主题重用唯一主光和补光，停用完整释放并恢复显示',t=>{
 const engine=new NullEngine(),scene=new Scene(engine),fill=new HemisphericLight('EditorLight',Vector3.Up(),scene);fill.intensity=.8;
 const color=scene.clearColor.clone(),exposure=scene.imageProcessingConfiguration.exposure;
 const runtime=new SceneThemeRuntime(scene);t.after(()=>{runtime.dispose();scene.dispose();engine.dispose();});
 const theme=createTechBlueNightTheme();runtime.sync(theme,TECH_BLUE_NIGHT_SHADOWS);
 const light=runtime.mainLight; assert.ok(light);assert.equal(scene.lights.length,2);assert.equal(fill.intensity,.42);
 for(let i=0;i<10;i++) runtime.sync({...theme,exposure:1.3},TECH_BLUE_NIGHT_SHADOWS);
 assert.equal(runtime.mainLight,light);assert.equal(scene.lights.length,2);assert.equal(scene.imageProcessingConfiguration.exposure,1.3);
 runtime.sync(null,TECH_BLUE_NIGHT_SHADOWS);assert.equal(scene.lights.length,1);assert.equal(fill.intensity,.8);
 assert.deepEqual(scene.clearColor.asArray(),color.asArray());assert.equal(scene.imageProcessingConfiguration.exposure,exposure);
});
test('未应用主题的旧场景不会改变渲染配置',t=>{
 const engine=new NullEngine(),scene=new Scene(engine),runtime=new SceneThemeRuntime(scene);
 t.after(()=>{runtime.dispose();scene.dispose();engine.dispose();});
 scene.environmentIntensity=.77;runtime.sync(null,TECH_BLUE_NIGHT_SHADOWS);
 assert.equal(scene.environmentIntensity,.77);assert.equal(scene.lights.length,0);
});


test('多盏局部灯存在时仍优先保留主题主光和底光',t=>{
 const engine=new NullEngine(),scene=new Scene(engine),fill=new HemisphericLight('EditorLight',Vector3.Up(),scene);
 const runtime=new SceneThemeRuntime(scene);t.after(()=>{runtime.dispose();scene.dispose();engine.dispose();});
 for(let i=0;i<6;i++)new HemisphericLight('local'+i,Vector3.Up(),scene);
 runtime.sync(createTechBlueNightTheme(),TECH_BLUE_NIGHT_SHADOWS);
 assert.equal(scene.lights[0].name,runtime.mainLight.name);assert.equal(scene.lights[1].name,fill.name);
 runtime.sync(null,TECH_BLUE_NIGHT_SHADOWS);assert.equal(fill.renderPriority,0);
});
