import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  normalizeLightingLightmapEncoding, getRequestedLightingLightmapEncoding,
  getLightingLightmapBaseEncoding, assertLightingLightmapVersion, isLightingLightmapRecipeCompatible,
} from '../../electron/shared/sceneLightingTextureCodec.ts';

test('缺省线性不补键；请求编码只允许已实现的两项，asset只允许缺省或真实gamma', () => {
  assert.equal(normalizeLightingLightmapEncoding(undefined), undefined);
  assert.equal(getRequestedLightingLightmapEncoding(undefined), 'rgbm');
  for (const value of ['rgbm', 'rgbm-gamma']) assert.equal(normalizeLightingLightmapEncoding(value), value);
  assert.equal(getLightingLightmapBaseEncoding(undefined), 'rgbm');
  assert.equal(getLightingLightmapBaseEncoding('rgbm-gamma'), 'rgbm-gamma');
  assert.equal(getLightingLightmapBaseEncoding('rgbm-linear-mips-v1'), 'rgbm');
  assert.equal(getLightingLightmapBaseEncoding('rgbm-gamma-mips-v1'), 'rgbm-gamma');
  for (const value of [null, false, 0, '', 'RGBM', 'rgbm-linear-mips-v2', 'rgbm-gamma-mips-v2', {}, []]) {
    assert.throws(() => normalizeLightingLightmapEncoding(value), /编码不受支持/);
    assert.throws(() => getLightingLightmapBaseEncoding(value), /编码不受支持/);
  }
  assert.throws(() => getLightingLightmapBaseEncoding('rgbm'), /资产编码不受支持/);
});

test('v2不能装载gamma参数或资产；recipe匹配独立于物理签名且不能忽略混合图集', () => {
  assert.doesNotThrow(() => assertLightingLightmapVersion(2, undefined, [undefined]));
  assert.doesNotThrow(() => assertLightingLightmapVersion(2, 'rgbm', [undefined]));
  assert.throws(() => assertLightingLightmapVersion(2, 'rgbm-gamma'), /版本 3/);
  assert.throws(() => assertLightingLightmapVersion(2, undefined, ['rgbm-gamma']), /版本 3/);
  assert.doesNotThrow(() => assertLightingLightmapVersion(3, 'rgbm-gamma', ['rgbm-gamma']));
  const old = [{ kind: 'geometry', encoding: 'binary-v1' }, { kind: 'lightmap' }];
  const gamma = [{ kind: 'lightmap', encoding: 'rgbm-gamma' }];
  assert.equal(isLightingLightmapRecipeCompatible(undefined, old), true);
  assert.equal(isLightingLightmapRecipeCompatible('rgbm-gamma', old), false);
  assert.equal(isLightingLightmapRecipeCompatible('rgbm-gamma', gamma), true);
  assert.equal(isLightingLightmapRecipeCompatible(undefined, gamma), false);
  assert.equal(isLightingLightmapRecipeCompatible('rgbm-gamma', [...old, ...gamma]), false);
  assert.throws(() => isLightingLightmapRecipeCompatible(undefined, [{ kind: 'lightmap', encoding: 'unknown' }]), /不受支持/);
});

// Python 向量实现与独立 JS 标量定义逐项比较；固定小输入，不启动 Blender、GPU 或 bake。
const python = String.raw`
import importlib.util,json,sys,numpy as np
spec=importlib.util.spec_from_file_location('phase2_gamma_codec',sys.argv[1])
module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
vectors=json.loads(sys.stdin.read()); reports=[]
for case in vectors:
    pixels=np.array(case['pixels'],dtype=np.float32); original=pixels.copy()
    scale,encoded=module.encode_rgbm_gamma_pixels(pixels)
    assert np.array_equal(pixels,original)
    quantized=np.rint(np.clip(encoded,0,1)*255).astype(np.uint8)
    reports.append({'range':scale,'encoded':encoded.tolist(),'bytes':quantized.tolist()})
failures=[]
for raw in [[],[1,2,3],['bad']]:
    try: module.encode_rgbm_gamma_pixels(np.array(raw))
    except (ValueError,TypeError): failures.append(True)
for value in [float('nan'),float('inf'),float('-inf')]:
    try: module.encode_rgbm_gamma_pixels(np.array([value,0,0,1],dtype=np.float32))
    except ValueError: failures.append(True)
fixed_range,fixed_encoded=module.encode_rgbm_gamma_pixels(np.array([1,4,.25,1],dtype=np.float32),fixed_range=16)
for value in [True,0,.5,3,float('nan'),float('inf'),'4']:
    try: module.encode_rgbm_gamma_pixels(np.array([1,4,.25,1],dtype=np.float32),fixed_range=value)
    except ValueError: failures.append(True)
print(json.dumps({'cases':reports,'failures':failures,'fixed':{'range':fixed_range,'encoded':fixed_encoded.tolist()},'numpy':np.__version__}))
`;
const vectors = [
  { name: 'black', pixels: [0, 0, 0, 1] },
  { name: 'known-R4', pixels: [1, 4, .25, 1] },
  { name: 'dark-gradient', pixels: [0, .000001, .000004, 1, .000016, .000064, .000256, 1, .001024, .004096, .016384, 1] },
  { name: 'range-boundary', pixels: [1, .25, 0, 1, 1.000001, .5, .125, 1] },
  { name: 'HDR', pixels: [65536, 1024, .0001, 1, 4, 16, 256, 1] },
  { name: 'negative-clamp', pixels: [-2, .5, 1, 1] },
  { name: 'ceil-boundary', pixels: [Math.fround((64 / 255) ** 2), Math.fround((128 / 255) ** 2), 1, 1] },
];
function scalarReference(pixels) {
  const values = [...new Float32Array(pixels)];
  let range = 1;
  for (let index = 0; index < values.length; index++) if (index % 4 !== 3) range = Math.max(range, Math.ceil(Math.max(values[index], 0)));
  const encoded = [];
  for (let index = 0; index < values.length; index += 4) {
    const q = values.slice(index, index + 3).map(value => Math.sqrt(Math.max(0, value) / range));
    const multiplier = Math.max(1 / 255, Math.ceil(Math.max(...q) * 255) / 255);
    encoded.push(...q.map(value => Math.fround(value / multiplier)), Math.fround(multiplier));
  }
  return { range, encoded };
}

test('真实独立Python编码器匹配固定标量oracle，黑/暗/HDR/边界不改输入且拒坏值', () => {
  const result = spawnSync(process.env.PHASE2_PYTHON ?? 'python', ['-c', python,
    fileURLToPath(new URL('../../electron/lighting-bake/rgbm_gamma_codec.py', import.meta.url))], {
    input: JSON.stringify(vectors), encoding: 'utf8', timeout: 10000, windowsHide: true,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  const observed = JSON.parse(result.stdout);
  assert.equal(observed.failures.length, 13);
  assert.equal(observed.fixed.range, 16);
  for (const [index, expected] of [1, 4, .25].entries()) assert.ok(Math.abs((observed.fixed.encoded[index] * observed.fixed.encoded[3]) ** 2 * 16 - expected) < 1e-6);
  for (const [index, vector] of vectors.entries()) {
    const expected = scalarReference(vector.pixels), actual = observed.cases[index];
    assert.equal(actual.range, expected.range, vector.name);
    assert.deepEqual(actual.encoded, expected.encoded, vector.name);
    assert.ok(actual.bytes.every(value => value >= 0 && value <= 255));
  }
  const known = observed.cases[1];
  assert.equal(known.range, 4);
  assert.deepEqual(known.encoded, [.5, 1, .25, 1]);
  assert.deepEqual(known.encoded.slice(0, 3).map(value => (value * known.encoded[3]) ** 2 * known.range), [1, 4, .25]);
  assert.notEqual((known.encoded[0] * known.encoded[3] * known.range) ** 2, 1, 'R在平方内会解码成错误能量');
});

test('旧线性编码函数主体与默认save_rgbm路径保留，新helper只接显式gamma分支', async () => {
  const source = await readFile(new URL('../../electron/lighting-bake/cycles_bake.py', import.meta.url), 'utf8');
  assert.match(source, /encoding: str = "rgbm"/);
  assert.match(source, /elif encoding == "rgbm":\s+dynamic_range, encoded = encode_rgbm_pixels\(pixels\)/);
  assert.match(source, /encoding == "rgbm-gamma"[\s\S]*rgbm_gamma_codec\.py/);
});
