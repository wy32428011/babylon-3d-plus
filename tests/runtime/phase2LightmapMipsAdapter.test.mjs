import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
import { encodeLightingLightmapMips, decodeLightingLightmapMips } from '../../electron/shared/sceneLightingLightmapMips.ts';

const file = new URL('../../src/runtime/babylon/lightingLightmapMipTexture.ts', import.meta.url);
const text = await readFile(file, 'utf8');
const ast = ts.createSourceFile(file.pathname, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const declaration = ast.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === 'createLightingLightmapMipTexture');
assert.ok(declaration);
const functionJs = ts.transpileModule(declaration.getText(ast).replace(/^export\s+/, ''), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;

function setup({ failLod, precision = 23, version = 2 } = {}) {
  const calls = [], textures = [], internals = [];
  const parameters = new Map([[1, 4], [2, true], [3, 9]]);
  const gl = { UNPACK_ALIGNMENT: 1, UNPACK_PREMULTIPLY_ALPHA_WEBGL: 2, UNPACK_COLORSPACE_CONVERSION_WEBGL: 3,
    FRAGMENT_SHADER: 4, HIGH_FLOAT: 5, TEXTURE_2D: 6, TEXTURE_BASE_LEVEL: 7, TEXTURE_MAX_LEVEL: 8,
    TEXTURE_MIN_LOD: 10, TEXTURE_MAX_LOD: 11, NONE: 0, NO_ERROR: 0,
    getShaderPrecisionFormat: () => ({ precision }), getParameter: key => parameters.get(key),
    pixelStorei: (key, value) => { parameters.set(key, value); calls.push(['pixelStore', key, value]); },
    texParameteri: (...args) => calls.push(['parameter', ...args]), texParameterf: (...args) => calls.push(['parameter', ...args]), getError: () => 0 };
  const engine = { webGLVersion: version, _gl: gl, getCaps: () => ({ maxTextureSize: 8192 }),
    createRawTexture: (...args) => {
      calls.push(['create', ...args]);
      const internal = { isReady: true, _bufferView: null, onRebuildCallback: null, dispose() { this.disposed = true; } };
      internals.push(internal); return internal;
    },
    _bindTextureDirectly: (...args) => calls.push(['bind', ...args]),
    _uploadDataToTextureDirectly: (internal, rgba, face, lod) => {
      assert.equal(internal.isReady, false, '完整链上传前不得提交就绪');
      calls.push(['upload', internal, rgba, face, lod]);
      if (lod === failLod) throw new Error('injected upload failure');
    },
    updateTextureSamplingMode: (...args) => calls.push(['sampler', ...args]),
  };
  class RawTexture {
    constructor(data, width, height, format, scene, generate, invert, sampling, type, creation, srgb) {
      this.internal = engine.createRawTexture(data, width, height, format, generate, invert, sampling, null, type, creation, srgb);
      this.disposers = []; this.onDisposeObservable = { addOnce: callback => this.disposers.push(callback) }; textures.push(this);
    }
    getInternalTexture() { return this.internal; }
    dispose() { if (!this.disposed) { this.disposed = true; this.internal.dispose(); this.disposers.forEach(callback => callback()); } }
  }
  const Texture = { TRILINEAR_SAMPLINGMODE: 3, BILINEAR_SAMPLINGMODE: 2, CLAMP_ADDRESSMODE: 0 };
  const Constants = { TEXTUREFORMAT_RGBA: 5, TEXTURETYPE_UNSIGNED_BYTE: 0 };
  // 使用真实函数AST，替换的仅是GPU外部依赖；这些测试不声称证明实际WebGL行为。
  const create = new Function('RawTexture', 'Texture', 'Constants', `${functionJs}\nreturn createLightingLightmapMipTexture;`)(RawTexture, Texture, Constants);
  const scene = { getEngine: () => engine };
  const bytes = encodeLightingLightmapMips({ baseEncoding: 'rgbm', rgbmRange: 1, maxTextureBytes: 84,
    levels: [4, 2, 1].map((size, lod) => ({ width: size, height: size, rgba: new Uint8Array(size * size * 4).fill(30 + lod) })) });
  const decoded = decodeLightingLightmapMips(bytes, { maxTextureBytes: 84 });
  return { create, scene, decoded, calls, parameters, textures, internals, gl };
}

test('adapter命令层按真实LOD上传全部视图，限制sampler并恢复unpack状态', () => {
  const harness = setup();
  const texture = harness.create(harness.scene, harness.decoded, { maxTextureBytes: 84 });
  assert.equal(texture.gammaSpace, false); assert.equal(texture.hasAlpha, false);
  assert.equal(texture.anisotropicFilteringLevel, 1);
  const uploads = harness.calls.filter(call => call[0] === 'upload');
  assert.deepEqual(uploads.map(call => call[4]), [0, 1, 2]);
  uploads.forEach((call, index) => assert.equal(call[2], harness.decoded.levels[index].rgba));
  assert.equal(texture.internal.generateMipMaps, false); assert.equal(texture.internal.useMipMaps, true);
  assert.equal(texture.internal.isReady, true);
  assert.ok(harness.calls.some(call => call[0] === 'parameter' && call[2] === harness.gl.TEXTURE_MAX_LEVEL && call[3] === 2));
  assert.ok(harness.calls.some(call => call[0] === 'parameter' && call[2] === harness.gl.TEXTURE_MAX_LOD && call[3] === 2));
  assert.ok(harness.calls.some(call => call[0] === 'sampler' && call[1] === 3 && call[3] === false));
  assert.deepEqual([...harness.parameters], [[1, 4], [2, true], [3, 9]]);
  harness.calls.filter(call => call[0] === 'create').forEach(call => assert.equal(call[5], false, '不调用GPU生成mip'));
  texture.dispose(); assert.equal(texture.internal.onRebuildCallback, null);
});

test('rebuild同步重放所有级，释放后不再重建；失败代理释放且保持未就绪', () => {
  const harness = setup();
  const errors = [];
  const texture = harness.create(harness.scene, harness.decoded, { maxTextureBytes: 84, onRestoreError: error => errors.push(error.message) });
  const rebuild = texture.internal.onRebuildCallback;
  const result = rebuild(texture.internal);
  assert.equal(result.isAsync, false); assert.equal(result.isReady, true);
  assert.deepEqual(harness.calls.filter(call => call[0] === 'upload' && call[1] === result.proxy).map(call => call[4]), [0, 1, 2]);
  texture.dispose();
  const allocations = harness.internals.length;
  assert.throws(() => rebuild(texture.internal), /释放/);
  assert.equal(harness.internals.length, allocations);
  assert.equal(texture.internal.isReady, false);
  assert.equal(errors.length, 1);
  const failed = setup({ failLod: 1 });
  assert.throws(() => failed.create(failed.scene, failed.decoded, { maxTextureBytes: 84 }), /injected/);
  assert.equal(failed.textures[0].disposed, true);
  assert.equal(failed.internals[0].isReady, false);
  assert.deepEqual([...failed.parameters], [[1, 4], [2, true], [3, 9]]);
});

test('不支持后端/precision/预算/预取消在GPU分配前拒绝', () => {
  for (const options of [{ version: 1 }, { precision: 16 }]) {
    const harness = setup(options);
    assert.throws(() => harness.create(harness.scene, harness.decoded, { maxTextureBytes: 84 }), /WebGL2|highp/);
    assert.equal(harness.internals.length, 0);
  }
  const harness = setup();
  assert.throws(() => harness.create(harness.scene, harness.decoded, { maxTextureBytes: 83 }), /预算/);
  const controller = new AbortController(); controller.abort(new Error('cancel fixture'));
  assert.throws(() => harness.create(harness.scene, harness.decoded, { maxTextureBytes: 84, signal: controller.signal }), /cancel fixture/);
  assert.equal(harness.internals.length, 0);
});
