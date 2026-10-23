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

const { SceneAppearanceRuntime } = await import('../../src/runtime/babylon/SceneAppearanceRuntime.ts');
hooks.deregister();
const { NullEngine, Scene, HemisphericLight, Vector3, ArcRotateCamera } = await import('@babylonjs/core');
const appearance = { version: 1, backgroundColor: '#123456', skyboxVisible: true, exposure: 1.3, contrast: 1.1,
  toneMappingEnabled: true, glowIntensity: 1, bloomEnabled: false, bloomWeight: .15,
  fogEnabled: false, fogColor: '#123456', fogStart: 100, fogEnd: 1000 };

test('纯外观连续更新不创建灯光或改变环境照明，释放恢复显示基线', t => {
  const engine = new NullEngine(), scene = new Scene(engine), runtime = new SceneAppearanceRuntime(scene);
  const fill = new HemisphericLight('EditorLight', Vector3.Up(), scene); fill.intensity = .83;
  scene.environmentIntensity = .91;
  const baseline = { background: scene.clearColor.asArray(), exposure: scene.imageProcessingConfiguration.exposure };
  t.after(() => { runtime.dispose(); scene.dispose(); engine.dispose(); });
  for (let i = 0; i < 10; i++) runtime.sync({ ...appearance, exposure: 1 + i / 10 });
  assert.equal(scene.imageProcessingConfiguration.exposure, 1.9);
  assert.equal(scene.lights.length, 1); assert.equal(fill.intensity, .83); assert.equal(scene.environmentIntensity, .91);
  runtime.dispose();
  assert.deepEqual(scene.clearColor.asArray(), baseline.background);
  assert.equal(scene.imageProcessingConfiguration.exposure, baseline.exposure);
});

test('外观泛光复用管线，切换相机解除旧相机绑定，关闭后释放观察者', async t => {
  const engine = new NullEngine(), scene = new Scene(engine), runtime = new SceneAppearanceRuntime(scene);
  const first = new ArcRotateCamera('first', 0, 1, 20, Vector3.Zero(), scene);
  const second = new ArcRotateCamera('second', 0, 1, 20, Vector3.Zero(), scene);
  scene.activeCamera = first;
  t.after(() => { runtime.dispose(); scene.dispose(); engine.dispose(); });
  const observers = scene.onBeforeRenderObservable.observers.length;
  runtime.sync({ ...appearance, bloomEnabled: true });
  const [pipeline] = scene.postProcessRenderPipelineManager.supportedPipelines;
  assert.ok(pipeline); assert.deepEqual(pipeline.cameras, [first]);
  runtime.sync({ ...appearance, bloomEnabled: true, bloomWeight: .4 });
  assert.equal(scene.postProcessRenderPipelineManager.supportedPipelines[0], pipeline); assert.equal(pipeline.bloomWeight, .4);
  scene.activeCamera = second; scene.onBeforeRenderObservable.notifyObservers(scene);
  assert.deepEqual(pipeline.cameras, [second]);
  runtime.sync(appearance);
  assert.equal(scene.postProcessRenderPipelineManager.supportedPipelines.length, 0);
  assert.equal(first._postProcesses.filter(Boolean).length, 0); assert.equal(second._postProcesses.filter(Boolean).length, 0);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(scene.onBeforeRenderObservable.observers.length, observers);
});
