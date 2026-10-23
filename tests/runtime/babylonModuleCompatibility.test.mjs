import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const namespacePath = new URL('../../src/runtime/babylon/babylonScriptRuntimeNamespace.ts', import.meta.url);
const namespaceSource = await readFile(namespacePath, 'utf8');
const moduleUrl = source => `data:text/javascript,${encodeURIComponent(source)}`;
const resolveBabylonImports = source => source.replace(/(["'])(@babylonjs\/[^"']+)\1/g,
  (_match, _quote, specifier) => JSON.stringify(import.meta.resolve(specifier)));

/** 直接执行真实模块；仅把包路径改为绝对 URL，使临时内存模块使用同一份已安装依赖。 */
async function loadRealNamespace() {
  const sideEffects = await readFile(new URL('../../src/runtime/babylon/babylonSideEffects.ts', import.meta.url), 'utf8');
  const source = namespaceSource.replace("'./babylonSideEffects.js'", JSON.stringify(moduleUrl(resolveBabylonImports(sideEffects))));
  const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  return import(moduleUrl(resolveBabylonImports(output)));
}

/** 隔离网络加载器，只用于验证选择、在途共享与失败重试；真实符号另行通过完整依赖验证。 */
function namespaceFixture(loader) {
  const ast = ts.createSourceFile('babylonScriptRuntimeNamespace.ts', namespaceSource, ts.ScriptTarget.Latest, true);
  const statements = ast.statements.filter(node => !ts.isImportDeclaration(node)
    && !(ts.isVariableStatement(node) && node.declarationList.declarations.some(item => item.name.getText(ast) === 'BabylonCore')));
  const source = statements.map(node => node.getText(ast).replace(/^export /, '')).join('\n')
    .replace("import('@babylonjs/core/index.js')", 'loadFullBabylonNamespace()');
  const output = ts.transpileModule(source + '\n({ resolveBabylonScriptRuntimeNamespace });',
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  const common = { Vector3: class Vector3 {}, TransformNode: class TransformNode {}, ParticleSystem: class ParticleSystem {} };
  return { ...runInNewContext(output, { BabylonCore: common, loadFullBabylonNamespace: loader }), common };
}

test('常用根路径、深层路径和类型导入均不加载完整 Babylon namespace', async () => {
  let requests = 0;
  const fixture = namespaceFixture(async () => { requests += 1; return {}; });
  for (const source of [
    'import { Vector3, TransformNode as Root } from "@babylonjs/core";',
    'import { Vector3 } from "@babylonjs/core/Maths/math.vector";',
    'import type { FreeCamera } from "@babylonjs/core";',
    'import { visibleAsNumber } from "babylonjs-editor-tools";',
    'import { type FreeCamera, Vector3 } from "@babylonjs/core";',
    'export default class RuntimeComponent {}',
  ]) assert.equal(await fixture.resolveBabylonScriptRuntimeNamespace(source), fixture.common);
  assert.equal(requests, 0);
});

test('完整 namespace 并发共享加载，未知命名导入失败后可以再次加载', async () => {
  let requests = 0;
  let release;
  const complete = { FreeCamera: class FreeCamera {}, AnimationEvent: class AnimationEvent {} };
  const fixture = namespaceFixture(() => {
    requests += 1;
    if (requests === 1) return Promise.reject(new Error('临时加载失败'));
    return new Promise(resolve => { release = resolve; });
  });
  await assert.rejects(fixture.resolveBabylonScriptRuntimeNamespace('import { FreeCamera } from "@babylonjs/core";'), /临时加载失败/);
  const pending = [
    fixture.resolveBabylonScriptRuntimeNamespace('import * as BABYLON from "@babylonjs/core";'),
    fixture.resolveBabylonScriptRuntimeNamespace('import { AnimationEvent as Event } from "@babylonjs/core/Animations/animationEvent";'),
  ];
  assert.equal(requests, 2);
  release(complete);
  const results = await Promise.all(pending);
  assert.equal(results[0], complete);
  assert.equal(results[1], complete);
  assert.equal(await fixture.resolveBabylonScriptRuntimeNamespace('import * as Core from "@babylonjs/core";'), complete);
  assert.equal(requests, 2);
});

test('ParticleSystem 命名导入始终加载完整 namespace 以保留额外原型注册', async () => {
  let requests = 0;
  const complete = { ParticleSystem: class ParticleSystem {} };
  const fixture = namespaceFixture(async () => { requests += 1; return complete; });
  assert.equal(await fixture.resolveBabylonScriptRuntimeNamespace('import { ParticleSystem as Particles } from "@babylonjs/core/Particles/particleSystem";'), complete);
  assert.equal(requests, 1);
});

test('真实已安装 Babylon 模块保留 FreeCamera、AnimationEvent 及完整 namespace 导出', async () => {
  const { BabylonCore, resolveBabylonScriptRuntimeNamespace } = await loadRealNamespace();
  const common = await resolveBabylonScriptRuntimeNamespace('import { Vector3 } from "@babylonjs/core/Maths/math.vector";');
  assert.equal(common, BabylonCore);
  assert.equal(typeof common.Vector3, 'function');
  const named = await resolveBabylonScriptRuntimeNamespace('import { FreeCamera, AnimationEvent } from "@babylonjs/core";');
  const complete = await import('@babylonjs/core/index.js');
  assert.equal(named, complete);
  assert.equal(typeof named.FreeCamera, 'function');
  assert.equal(typeof named.AnimationEvent, 'function');
  const event = new named.AnimationEvent(3, () => {}, false);
  assert.equal(event.frame, 3);
  assert.equal(await resolveBabylonScriptRuntimeNamespace('import * as BABYLON from "@babylonjs/core";'), complete);
  assert.deepEqual(Object.keys(named).sort(), Object.keys(complete).sort());
});

test('真实 glTF2 loader 注册覆盖安装包全部原有扩展', async () => {
  const { registeredGLTFExtensions } = await import('@babylonjs/loaders/glTF/2.0/glTFLoaderExtensionRegistry.js');
  const source = await readFile(new URL('../../src/runtime/babylon/babylonGltfLoader.ts', import.meta.url), 'utf8');
  await import(moduleUrl(resolveBabylonImports(source)));
  const candidateRegistrations = new Map(registeredGLTFExtensions);
  const candidateExtensions = [...candidateRegistrations.keys()].sort();
  const { GLTFLoader } = await import('@babylonjs/loaders/glTF/2.0/glTFLoader.js');
  const { GLTFFileLoader } = await import('@babylonjs/loaders/glTF/glTFFileLoader.js');
  const { NullEngine } = await import('@babylonjs/core/Engines/nullEngine.js');
  const { Scene } = await import('@babylonjs/core/scene.js');
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const loader = new GLTFLoader(new GLTFFileLoader());
  loader._babylonScene = scene;
  loader._gltf = { asset: { version: '2.0' }, extensionsUsed: candidateExtensions, nodes: [] };
  try {
    const pending = [...candidateRegistrations].map(([name, registration]) => {
      const instance = registration.factory(loader);
      assert.equal(typeof instance?.then, 'function', `${name} 必须按需异步加载`);
      return instance.then(extension => {
        assert.equal(extension.name, name);
        extension.dispose?.();
      });
    });
    await Promise.all(pending);
  } finally {
    loader.dispose();
    scene.dispose();
    engine.dispose();
  }
  await import('@babylonjs/loaders/glTF/2.0/index.js');
  assert.deepEqual(candidateExtensions, [...registeredGLTFExtensions.keys()].sort());
  for (const extension of ['KHR_materials_coat', 'KHR_materials_fuzz', 'KHR_materials_volume_scatter', 'MSFT_minecraftMesh', 'MSFT_audio_emitter', 'KHR_interactivity']) {
    assert.ok(candidateExtensions.includes(extension), extension);
  }
  const { SceneLoader } = await import('@babylonjs/core/Loading/sceneLoader.js');
  assert.equal(SceneLoader.IsPluginForExtensionAvailable('.glb'), true);
  assert.equal(SceneLoader.IsPluginForExtensionAvailable('.gltf'), true);
});

test('官方 loader 按实际 glTF 材质声明加载普通 PBR 和 OpenPBR adapter', async () => {
  const source = await readFile(new URL('../../src/runtime/babylon/babylonGltfLoader.ts', import.meta.url), 'utf8');
  await import(moduleUrl(resolveBabylonImports(source)));
  const { GLTFLoader } = await import('@babylonjs/loaders/glTF/2.0/glTFLoader.js');
  const { GLTFFileLoader } = await import('@babylonjs/loaders/glTF/glTFFileLoader.js');
  const { NullEngine } = await import('@babylonjs/core/Engines/nullEngine.js');
  const { Scene } = await import('@babylonjs/core/scene.js');
  for (const { useOpenPBR, explicitOpenPBR, expected } of [
    { useOpenPBR: false, explicitOpenPBR: false, expected: 'PBRMaterial' },
    { useOpenPBR: false, explicitOpenPBR: true, expected: 'OpenPBRMaterial' },
    { useOpenPBR: true, explicitOpenPBR: false, expected: 'OpenPBRMaterial' },
  ]) {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const parent = new GLTFFileLoader();
    parent.useOpenPBR = useOpenPBR;
    parent.loadAllMaterials = true;
    const loader = new GLTFLoader(parent);
    try {
      const complete = parent.whenCompleteAsync();
      await loader.loadAsync(scene, { json: {
        asset: { version: '2.0' }, scenes: [{ nodes: [] }], scene: 0, nodes: [],
        extensionsUsed: explicitOpenPBR ? ['KHR_materials_openpbr'] : [],
        materials: [{ name: 'compatibility-material', ...(explicitOpenPBR ? { extensions: { KHR_materials_openpbr: {} } } : {}) }],
      } }, '');
      await complete;
      assert.equal(scene.materials.find(material => material.name === 'compatibility-material')?.getClassName(), expected);
    } finally {
      loader.dispose();
      parent.dispose();
      scene.dispose();
      engine.dispose();
    }
  }
});

test('普通 glTF1 包仍可扫描，实际 FileLoader 保留 v1/v2 版本选择和旧扩展', async () => {
  const electronRoot = new URL('../../electron/', import.meta.url);
  const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL?.startsWith(electronRoot.href)) {
      const target = new URL(specifier, context.parentURL);
      const source = new URL(target.href.slice(0, -3) + '.ts');
      if (source.href.startsWith(electronRoot.href) && !existsSync(target) && existsSync(source)) return nextResolve(source.href, context);
    }
    return nextResolve(specifier, context);
  } });
  let scanModelPackage;
  try {
    ({ scanModelPackage } = await import('../../electron/ipc/modelPackageScanner.ts'));
  } finally {
    hooks.deregister();
  }
  const root = await mkdtemp(path.join(os.tmpdir(), 'babylon-gltf1-compatibility-'));
  const filename = path.join(root, 'main.gltf');
  const gltf = { asset: { version: '1.0' }, scene: 'main', scenes: { main: { nodes: [] } }, nodes: {} };
  try {
    await writeFile(filename, JSON.stringify(gltf), 'utf8');
    const scanned = await scanModelPackage(root);
    assert.ok(scanned.asset, '普通模型导入未收紧 glTF 1.0 能力');
    assert.equal(scanned.asset.path, filename);
    assert.equal(scanned.asset.kind, 'model');
    const source = await readFile(new URL('../../src/runtime/babylon/babylonGltfLoader.ts', import.meta.url), 'utf8');
    await import(moduleUrl(resolveBabylonImports(source)));
    const { GLTFFileLoader } = await import('@babylonjs/loaders/glTF/glTFFileLoader.js');
    const { GLTFLoader: GLTF1Loader } = await import('@babylonjs/loaders/glTF/1.0/glTFLoader.js');
    const { GLTFLoader: GLTF2Loader } = await import('@babylonjs/loaders/glTF/2.0/glTFLoader.js');
    const parent = new GLTFFileLoader();
    const legacy = parent._getLoader({ json: gltf });
    const current = parent._getLoader({ json: { asset: { version: '2.0' } } });
    try {
      assert.ok(legacy instanceof GLTF1Loader);
      assert.ok(current instanceof GLTF2Loader);
      assert.ok(GLTF1Loader.Extensions.KHR_binary_glTF);
      assert.ok(GLTF1Loader.Extensions.KHR_materials_common);
    } finally {
      legacy.dispose(); current.dispose(); parent.dispose();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
