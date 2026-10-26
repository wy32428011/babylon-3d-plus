import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';
import { Scene } from '@babylonjs/core/scene.js';
import { CreatePlane } from '@babylonjs/core/Meshes/Builders/planeBuilder.js';
import '@babylonjs/core/Meshes/instancedMesh.js';
import '@babylonjs/core/Materials/standardMaterial.js';

// 只执行真实pure函数；不加载dist、Playwright、Editor或GPU。
const source = readFileSync(new URL('../helpers/phase2MipsGiAcceptance.mjs', import.meta.url), 'utf8');
const tree = ts.createSourceFile('helper.mjs', source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
const declaration = name => {
  const value = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(value, name); return value.getText(tree);
};
const load = (name, dependencies = {}) => new Function(...Object.keys(dependencies), 'return (' + declaration(name).replace(/^export\s+/, '') + ');')(...Object.values(dependencies));
const protocolNode = tree.statements.filter(ts.isVariableStatement).flatMap(node => [...node.declarationList.declarations]).find(node => node.name.getText(tree) === 'mipsContextRestoreProtocol');
assert.ok(protocolNode); const protocol = new Function('return (' + protocolNode.initializer.getText(tree) + ');')();
const compare = load('compareMipsRestoreRgba', { Buffer, mipsContextRestoreProtocol: protocol });
const copy = load('makeNativeRestoreControlDocument');
const summarize = load('summarizeNativeRestoreRgba', { compareMipsRestoreRgba: compare });
const assertState = load('assertNativeRestoreControlState', { assert });
const frame = values => ({ width: 2, height: 1, rgba: Buffer.from(values ?? [11, 22, 33, 255, 44, 55, 66, 255]) });

test('首次内存副本只关闭bake并清result；原场景/几何/相机/灯/环境及编码全部不变', () => {
  const original = { version: 1, scene: { entities: { plane: { material: 'PBR', position: [1, 2, 3] } }, sceneSettings: {
    camera: { alpha: -.85 }, environment: { intensity: .7 }, lighting: { version: 3, lights: ['unchanged'], bake: {
      enabled: true, cacheStaticShadows: true, dynamicShadows: true, lightmapMipLevels: 4, lightmapEncoding: 'rgbm-gamma' }, result: { surfaces: [{ key: 'owned' }], assets: ['unchanged'] } } } } };
  const bytes = JSON.stringify(original), value = copy(original), expected = structuredClone(original);
  expected.scene.sceneSettings.lighting.bake.enabled = false; expected.scene.sceneSettings.lighting.result = null;
  assert.deepEqual(value, expected); assert.equal(JSON.stringify(original), bytes);
  assert.ok(value !== original && value.scene.entities !== original.scene.entities);
  assert.throws(() => copy({ scene: { sceneSettings: { lighting: { bake: {}, result: null } } } }), /已保存/);
});

test('native诊断只报告完整逐byte差异；exact0也绝不成为B9 PASS', () => {
  const exact = summarize({ before0: frame(), before1: frame(), after: frame() });
  assert.equal(exact.status, 'DIAGNOSTIC_NATIVE_CONTROL_NOT_B9_PASS'); assert.equal(exact.functionalPass, false);
  assert.equal(exact.observation, 'NATIVE_RESTORE_EXACT_ZERO'); assert.equal(exact.differentPixels, 0); assert.equal(exact.bounds, null);
  const changed = summarize({ before0: frame(), before1: frame(), after: frame([11, 22, 33, 255, 45, 54, 66, 254]) });
  assert.equal(changed.observation, 'NATIVE_RESTORE_RGBA_DIFFERENCE'); assert.equal(changed.differentPixels, 1);
  assert.equal(changed.differentComponents, 3); assert.equal(changed.maxRgb, 1); assert.equal(changed.alphaPixels, 1);
  assert.deepEqual(changed.bounds, { minX: 1, minY: 0, maxX: 1, maxY: 0 }); assert.equal(changed.functionalPass, false);
});

test('AA本身不稳仍INCONCLUSIVE；buffer缺失或尺寸变化拒绝', () => {
  const value = summarize({ before0: frame(), before1: frame([12, 22, 33, 255, 44, 55, 66, 255]), after: frame() });
  assert.equal(value.observation, 'INCONCLUSIVE_NATURAL_AA_UNSTABLE'); assert.equal(value.aaStable, false);
  assert.throws(() => summarize({ before0: frame(), before1: frame(), after: { width: 2, height: 1, rgba: Buffer.alloc(1) } }), /完整RGBA/);
  assert.throws(() => summarize({ before0: frame(), before1: frame(), after: { width: 1, height: 2, rgba: frame().rgba } }), /尺寸/);
});

test('native资格门必须两材质实际新帧绘制且无GI plugin/defines/derived对象', () => {
  const state = { frameId: 100, ready: true, bakeEnabled: false, hasResult: false, contextLost: false, runtimeError: null,
    hudErrors: [], errors: [], derivedCount: 0, pluginCount: 0, targets: ['StandardMaterial', 'PBRMaterial'].map(materialClass => ({
      materialClass, ready: true, indices: 6, plugin: false, receipt: { frameId: 100, hasBakedDefine: false } })) };
  assertState(state, 99);
  for (const change of [value => { value.bakeEnabled = true; }, value => { value.hasResult = true; }, value => { value.pluginCount = 1; },
    value => { value.derivedCount = 1; }, value => { value.targets[1].receipt.hasBakedDefine = true; }, value => { value.targets[1].plugin = true; },
    value => { value.targets[1].receipt.frameId = 99; }, value => { value.targets[1].receipt = null; }]) {
    const dirty = structuredClone(state); change(dirty); assert.throws(() => assertState(dirty, 99));
  }
});

test('真实SDK Mesh map值与model InstancedMesh：仅其原生source draw owner安装并精确移除observer', () => {
  const engine = new NullEngine(), scene = new Scene(engine), standard = CreatePlane('standard', {}, scene), sourceMesh = CreatePlane('pbr-source', {}, scene), instance = sourceMesh.createInstance('pbr-instance');
  const fixture = { standardEntityId: 'standard-id', pbrEntityId: 'pbr-id' };
  const runtime = { scene, presentation: { meshes: new Map([[fixture.standardEntityId, standard]]) },
    assets: { models: new Map([[fixture.pbrEntityId, { meshes: [instance] }]]) }, getLightingBakeRuntimeError: () => null };
  const window = { phase2Mips: { runtime, store: { getState: () => ({ scene: { sceneSettings: { lighting: { bake: { enabled: false }, result: null } } } }) } } };
  const program = {}, shaders = [{ type: 35633 }, { type: 35632 }];
  engine._gl = { NO_ERROR: 0, CURRENT_PROGRAM: 35725, ACTIVE_UNIFORMS: 35718, SHADER_TYPE: 35663,
    SAMPLER_2D: 35678, SAMPLER_CUBE: 35680, SAMPLER_2D_SHADOW: 35682, SAMPLER_2D_ARRAY: 36289,
    TEXTURE_BINDING_2D: 32873, TEXTURE_BINDING_CUBE_MAP: 34068, TEXTURE_BINDING_2D_ARRAY: 35869,
    getError: () => 0, isContextLost: () => false, getParameter: () => program, getAttachedShaders: () => shaders,
    getShaderParameter: shader => shader.type, getShaderSource: () => 'void main(){}', getProgramParameter: () => 0 };
  // 此installedSDK夹具只验证实际类型/observer/batch归属；shader readiness仍须后续真实GPU门。
  scene.isReady = () => true; standard.isReady = () => true; instance.isReady = () => true;
  const sentinel = sourceMesh.onAfterRenderObservable.add(() => {}), count = sourceMesh.onAfterRenderObservable.observers.length;
  const install = load('installNativeRestoreControl', { window, document: { querySelectorAll: () => [] } });
  try {
    assert.equal(standard.getClassName(), 'Mesh'); assert.equal(instance.getClassName(), 'InstancedMesh'); assert.equal(instance.onAfterRenderObservable, undefined);
    assert.ok(instance.sourceMesh === sourceMesh && sourceMesh.instances.includes(instance));
    install({ fixture }); assert.equal(standard.onAfterRenderObservable.observers.length, 1); assert.equal(sourceMesh.onAfterRenderObservable.observers.length, count + 1);
    sourceMesh.subMeshes[0].setEffect({ defines: '', getPipelineContext: () => ({ program }), dispose() {} });
    const batch = sourceMesh._instanceDataStorage.dataStorageRenderPass.batchCache, subMeshId = sourceMesh.subMeshes[0]._id;
    const receipt = () => window.__phase2NativeRestoreControl.state().targets.find(row => row.id === instance.uniqueId).receipt;
    batch.visibleInstances[subMeshId] = []; sourceMesh.onAfterRenderObservable.notifyObservers(sourceMesh); assert.equal(receipt(), null);
    batch.visibleInstances[subMeshId] = [standard]; sourceMesh.onAfterRenderObservable.notifyObservers(sourceMesh); assert.equal(receipt(), null);
    batch.visibleInstances[subMeshId] = [instance]; sourceMesh.onAfterRenderObservable.notifyObservers(sourceMesh);
    assert.equal(receipt().instanceSourceId, sourceMesh.uniqueId); assert.equal(receipt().instanceBatchContainsTarget, true);
    // 原生active uniform枚举包含UBO成员与null location；这些项绝不能传给getUniform。
    const gl = engine._gl, uniformCalls = [], texture0 = 33984; let activeUnit = texture0 + 6;
    Object.assign(gl, { INVALID_INDEX: 4294967295, UNIFORM_BLOCK_INDEX: 35386, UNIFORM_BLOCK_BINDING: 35391, ACTIVE_TEXTURE: 34016, TEXTURE0: texture0,
      SAMPLER_2D: 35678, SAMPLER_CUBE: 35680, SAMPLER_2D_SHADOW: 35682, SAMPLER_2D_ARRAY: 36289,
      TEXTURE_BINDING_2D: 32873, TEXTURE_BINDING_CUBE_MAP: 34068, TEXTURE_BINDING_2D_ARRAY: 35869 });
    const infos = [{ name: 'Scene.viewProjection', type: 35676, size: 1 }, { name: 'inactiveValue', type: 5126, size: 1 }, { name: 'scalar', type: 5126, size: 1 },
      { name: 'maps[0]', type: gl.SAMPLER_2D, size: 2 }, { name: 'cube', type: gl.SAMPLER_CUBE, size: 1 }, { name: 'shadow', type: gl.SAMPLER_2D_SHADOW, size: 1 }, { name: 'arrayMap', type: gl.SAMPLER_2D_ARRAY, size: 1 }];
    const values = { scalar: .75, 'maps[0]': new Int32Array([1, 2]), cube: 3, shadow: 4, arrayMap: 5 }, textures = [1, 2, 3, 4, 5].map(unit => ({
      uniqueId: 900 + unit, width: 4, height: 4, _hardwareTexture: { underlyingResource: { unit } } })), oldCache = engine._internalTexturesCache;
    const location = name => ({ name, [Symbol.toStringTag]: 'WebGLUniformLocation' });
    Object.assign(gl, { getProgramParameter: () => infos.length, getActiveUniform: (_program, index) => infos[index],
      getActiveUniforms: (_program, indices, parameter) => { assert.equal(parameter, gl.UNIFORM_BLOCK_INDEX); assert.equal(indices.length, infos.length); return [0, -1, gl.INVALID_INDEX, -1, -1, -1, -1]; },
      getUniformLocation: (_program, name) => name.startsWith('Scene.') || name === 'inactiveValue' ? null : location(name),
      getActiveUniformBlockName: () => 'Scene', getActiveUniformBlockParameter: () => 2,
      getUniform: (_program, value) => { assert.equal(Object.prototype.toString.call(value), '[object WebGLUniformLocation]'); uniformCalls.push(value.name); return values[value.name]; },
      getParameter: parameter => parameter === gl.CURRENT_PROGRAM ? program : parameter === gl.ACTIVE_TEXTURE ? activeUnit : textures.find(value => value._hardwareTexture.underlyingResource.unit === activeUnit - texture0)?._hardwareTexture.underlyingResource,
      activeTexture: value => { activeUnit = value; } });
    engine._internalTexturesCache = textures;
    try { sourceMesh.onAfterRenderObservable.notifyObservers(sourceMesh);
      const uniforms = receipt().uniforms;
      assert.equal(uniforms[0].storage, 'uniform-block'); assert.equal(uniforms[0].blockName, 'Scene'); assert.equal(uniforms[0].binding, 2);
      assert.equal(uniforms[1].storage, 'inactive-null-location'); assert.deepEqual(uniformCalls, ['scalar', 'maps[0]', 'cube', 'shadow', 'arrayMap']);
      assert.deepEqual(uniforms[3].samplers.map(value => value.internalId), [901, 902]); assert.equal(activeUnit, texture0 + 6);
      for (const row of uniforms.slice(4)) assert.ok(row.samplers[0].bound && row.samplers[0].internalId >= 903);
      gl.getUniformLocation = (_program, name) => name === 'scalar' ? 7 : name.startsWith('Scene.') || name === 'inactiveValue' ? null : location(name);
      sourceMesh.onAfterRenderObservable.notifyObservers(sourceMesh);
      const error = window.__phase2NativeRestoreControl.state().errors.at(-1); assert.equal(error.uniformName, 'scalar'); assert.equal(error.locationType, '[object Number]');
      assert.equal(error.errorName, 'TypeError'); assert.equal(error.errorCode, null); assert.deepEqual(error.shaderStages, [35633, 35632]);
    } finally { engine._internalTexturesCache = oldCache; }
    window.__phase2NativeRestoreControl.dispose(); assert.equal(standard.onAfterRenderObservable.observers.filter(observer => !observer._willBeUnregistered).length, 0);
    assert.equal(sourceMesh.onAfterRenderObservable.observers.filter(observer => !observer._willBeUnregistered).length, count); assert.ok(sourceMesh.onAfterRenderObservable.observers.includes(sentinel));
  } finally { window.__phase2NativeRestoreControl?.dispose(); scene.dispose(); engine.dispose(); }
});

test('用户授权RGB1协议比较函数固定；普通B9安装/验证函数源码exact不变', () => {
  const expected = { compareMipsRestoreRgba: '38f648d913267abcb6860813ae8f85245074e5de582e7fab94c162294bfa1687',
    installMipsProbe: '482325974c5b6d52e6eddf78feee3aaf3c695c8b167b03cf300a7330511a3810',
    verifyMipsProbe: '3b6e57d7c053d83e0878309a2d2337be4806ca8a7c25926228f1e44543e807c8' };
  for (const [name, sha] of Object.entries(expected)) assert.equal(createHash('sha256').update(declaration(name)).digest('hex'), sha, name);
});

test('driver显式native独立分支不调用保存/烘焙/包或Viewer；首次加载内存副本而非先重开GI', () => {
  const driver = readFileSync(new URL('../../scripts/phase2-mips-business.mjs', import.meta.url), 'utf8');
  const parsed = ts.createSourceFile('driver.mjs', driver, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
  let branch;
  const visit = node => { if (ts.isIfStatement(node) && node.expression.getText(parsed) === 'options.nativeControl' && node.thenStatement.getText(parsed).includes('verifyNativeRestoreControl')) branch = node.thenStatement;
    ts.forEachChild(node, visit); }; visit(parsed); assert.ok(branch);
  const text = branch.getText(parsed); assert.doesNotMatch(text, /requestLightingBake|saveScene|saveReopenMipsResult|buildDigitalTwin|verifyMipsViewers|exerciseMipsUi/);
  assert.match(driver, /content: nativeContent \?\?/); assert.match(driver, /resume: Boolean\(options\.resumeReport && !options\.nativeControl\)/);
  assert.match(driver, /if \(options\.resumeReport && !options\.nativeControl\)/);
  assert.match(text, /DIAGNOSTIC_NATIVE_CONTROL_NOT_B9_PASS/); assert.match(text, /functionalPass = false/);
});
