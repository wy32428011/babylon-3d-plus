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
const { createTechBlueNightTheme, TECH_BLUE_NIGHT_SHADOWS, SCENE_THEME_PRESETS } = await import('../../src/editor/model/sceneTheme.ts');
hooks.deregister();
const {NullEngine,Scene,HemisphericLight,Vector3,Color3,ArcRotateCamera}=await import('@babylonjs/core');
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

function displaySnapshot(scene, fill) {
  const image = scene.imageProcessingConfiguration;
  return {
    background: scene.clearColor.asArray(), environmentIntensity: scene.environmentIntensity,
    exposure: image.exposure, contrast: image.contrast, toneMappingEnabled: image.toneMappingEnabled,
    toneMappingType: image.toneMappingType, applyByPostProcess: image.applyByPostProcess,
    fillIntensity: fill.intensity, fillDiffuse: fill.diffuse.asArray(), fillGround: fill.groundColor.asArray(),
    fillSpecular: fill.specular.asArray(), fillPriority: fill.renderPriority,
  };
}

test('五套主题连续切换复用唯一主光，各项显示参数无残留且停用恢复完整基线', t => {
  const engine = new NullEngine(), scene = new Scene(engine);
  const fill = new HemisphericLight('EditorLight', Vector3.Up(), scene);
  fill.intensity = .83; fill.diffuse = Color3.FromHexString('#fedabc');
  fill.groundColor = Color3.FromHexString('#213244'); fill.specular = Color3.FromHexString('#abcdef'); fill.renderPriority = 17;
  scene.environmentIntensity = .91;
  scene.imageProcessingConfiguration.exposure = 1.18;
  scene.imageProcessingConfiguration.contrast = .92;
  const baseline = displaySnapshot(scene, fill);
  const runtime = new SceneThemeRuntime(scene);
  t.after(() => { runtime.dispose(); scene.dispose(); engine.dispose(); });
  let mainLight;
  for (let cycle = 0; cycle < 4; cycle++) for (const preset of SCENE_THEME_PRESETS) {
    const theme = preset.settings;
    runtime.sync(theme, preset.shadows);
    mainLight ??= runtime.mainLight;
    assert.equal(runtime.mainLight, mainLight);
    assert.equal(scene.lights.length, 2);
    assert.deepEqual(mainLight.diffuse.asArray(), Color3.FromHexString(theme.mainColor).asArray());
    assert.equal(mainLight.intensity, preset.shadows.sunIntensity);
    const azimuth = preset.shadows.sunAzimuthDegrees * Math.PI / 180;
    const elevation = preset.shadows.sunElevationDegrees * Math.PI / 180;
    assert.ok(Vector3.Distance(mainLight.direction, new Vector3(-Math.sin(azimuth) * Math.cos(elevation), -Math.sin(elevation), -Math.cos(azimuth) * Math.cos(elevation))) < 1e-6);
    assert.deepEqual(scene.clearColor.asArray().slice(0, 3), Color3.FromHexString(theme.backgroundColor).asArray());
    assert.equal(scene.imageProcessingConfiguration.exposure, theme.exposure);
    assert.equal(scene.imageProcessingConfiguration.contrast, theme.contrast);
    assert.equal(scene.environmentIntensity, theme.environmentIntensity);
    assert.equal(fill.intensity, preset.shadows.fillIntensity);
    assert.deepEqual(fill.diffuse.asArray(), Color3.FromHexString(theme.fillColor).asArray());
    assert.deepEqual(fill.groundColor.asArray(), Color3.FromHexString(theme.groundColor).asArray());
    assert.equal(scene.postProcessRenderPipelineManager.supportedPipelines.length, 0);
  }
  runtime.sync(null, TECH_BLUE_NIGHT_SHADOWS);
  assert.equal(mainLight.isDisposed(), true);
  assert.equal(scene.lights.length, 1);
  assert.deepEqual(displaySnapshot(scene, fill), baseline);
});

test('主题泛光复用管线，切换相机解除旧相机绑定，关闭和停用释放观察者', async t => {
  const engine = new NullEngine(), scene = new Scene(engine);
  const first = new ArcRotateCamera('first', 0, 1, 20, Vector3.Zero(), scene);
  const second = new ArcRotateCamera('second', 0, 1, 20, Vector3.Zero(), scene);
  scene.activeCamera = first;
  const runtime = new SceneThemeRuntime(scene);
  t.after(() => { runtime.dispose(); scene.dispose(); engine.dispose(); });
  const observers = scene.onBeforeRenderObservable.observers.length;
  const enabled = { ...createTechBlueNightTheme(), bloomEnabled: true };
  runtime.sync(enabled, TECH_BLUE_NIGHT_SHADOWS);
  const [pipeline] = scene.postProcessRenderPipelineManager.supportedPipelines;
  assert.ok(pipeline);
  assert.deepEqual(pipeline.cameras, [first]);
  runtime.sync({ ...enabled, bloomWeight: .4 }, TECH_BLUE_NIGHT_SHADOWS);
  assert.equal(scene.postProcessRenderPipelineManager.supportedPipelines[0], pipeline);
  assert.equal(pipeline.bloomWeight, .4);
  scene.activeCamera = second;
  scene.onBeforeRenderObservable.notifyObservers(scene);
  assert.deepEqual(pipeline.cameras, [second]);
  runtime.sync(SCENE_THEME_PRESETS[1].settings, SCENE_THEME_PRESETS[1].shadows);
  assert.equal(scene.postProcessRenderPipelineManager.supportedPipelines.length, 0);
  assert.equal(first._postProcesses.filter(Boolean).length, 0);
  assert.equal(second._postProcesses.filter(Boolean).length, 0);
  // Babylon 的 Observable.remove 在下一轮事件循环完成物理移除。
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(scene.onBeforeRenderObservable.observers.length, observers);
  runtime.sync(enabled, TECH_BLUE_NIGHT_SHADOWS);
  assert.equal(scene.postProcessRenderPipelineManager.supportedPipelines.length, 1);
  runtime.sync(null, TECH_BLUE_NIGHT_SHADOWS);
  assert.equal(scene.postProcessRenderPipelineManager.supportedPipelines.length, 0);
  // Babylon 的 Observable.remove 在下一轮事件循环完成物理移除。
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(scene.onBeforeRenderObservable.observers.length, observers);
});
