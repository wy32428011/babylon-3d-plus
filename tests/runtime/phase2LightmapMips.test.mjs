import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  encodeLightingLightmapMips, decodeLightingLightmapMips,
  validateLightingLightmapMipAsset, isLightingLightmapMipEncoding,
} from '../../electron/shared/sceneLightingLightmapMips.ts';

function fixture(baseEncoding = 'rgbm') {
  return encodeLightingLightmapMips({ baseEncoding, rgbmRange: 4, maxTextureBytes: 84,
    levels: [4, 2, 1].map((size, index) => ({ width: size, height: size,
      rgba: Uint8Array.from({ length: size * size * 4 }, (_, channel) => (channel + index * 37) % 256) })) });
}

test('有限容器明确编码、行向、各级尺寸/总RGBA，支持子视图且解码零拷贝', () => {
  for (const baseEncoding of ['rgbm', 'rgbm-gamma']) {
    const bytes = fixture(baseEncoding);
    const backing = new Uint8Array(bytes.length + 12); backing.set(bytes, 5);
    const view = backing.subarray(5, 5 + bytes.length);
    const decoded = decodeLightingLightmapMips(view, { maxTextureBytes: 84, expectedWidth: 4, expectedHeight: 4, expectedLevelCount: 3 });
    assert.equal(decoded.baseEncoding, baseEncoding);
    assert.equal(decoded.containerEncoding, baseEncoding === 'rgbm' ? 'rgbm-linear-mips-v1' : 'rgbm-gamma-mips-v1');
    assert.equal(decoded.totalTextureBytes, 84);
    assert.equal(decoded.rgbmRange, 4);
    assert.deepEqual(decoded.levels.map(level => [level.width, level.height, level.rgba.length]), [[4, 4, 64], [2, 2, 16], [1, 1, 4]]);
    assert.equal(decoded.levels[0].rgba.buffer, backing.buffer);
    assert.equal(decoded.levels[0].rgba.byteOffset, 5 + 64 + 3 * 16);
    for (const [index, level] of decoded.levels.entries()) assert.deepEqual([...level.rgba],
      Array.from({ length: level.rgba.length }, (_, channel) => (channel + index * 37) % 256));
  }
});

test('坏头、未知codec/行向、gap/重叠/尾部、budget和清单不一致全部拒绝', () => {
  const original = fixture();
  const bad = [
    bytes => { bytes[0] = 0; }, bytes => { bytes[8] = 2; }, bytes => { bytes[10] = 2; },
    bytes => { bytes[11] = 2; }, bytes => { bytes[28] = 0; }, bytes => { bytes[48] = 1; },
    bytes => { new DataView(bytes.buffer).setUint32(12, 64, true); },
    bytes => { new DataView(bytes.buffer).setUint32(16, 3, true); },
    bytes => { new DataView(bytes.buffer).setUint32(24, 1, true); },
    bytes => { new DataView(bytes.buffer).setFloat64(32, NaN, true); },
    bytes => { new DataView(bytes.buffer).setFloat64(32, .5, true); },
    bytes => { bytes[40]++; }, bytes => { bytes[44]--; },
    bytes => { bytes[64]++; }, bytes => { bytes[64 + 8]++; }, bytes => { bytes[64 + 12]--; },
    bytes => { bytes[80 + 8]--; }, bytes => { bytes[96 + 8]++; },
  ];
  for (const mutate of bad) { const bytes = original.slice(); mutate(bytes); assert.throws(() => decodeLightingLightmapMips(bytes, { maxTextureBytes: 84 }), /无效/); }
  assert.throws(() => decodeLightingLightmapMips(original.subarray(0, -1), { maxTextureBytes: 84 }), /长度/);
  assert.throws(() => decodeLightingLightmapMips(new Uint8Array([...original, 0]), { maxTextureBytes: 84 }), /长度/);
  assert.throws(() => decodeLightingLightmapMips(original, { maxTextureBytes: 83 }), /预算/);
  for (const expected of [{ expectedRange: 8 }, { expectedWidth: 8 }, { expectedHeight: 8 }, { expectedLevelCount: 2 }, { expectedEncoding: 'rgbm-gamma-mips-v1' }]) {
    assert.throws(() => decodeLightingLightmapMips(original, { maxTextureBytes: 84, ...expected }), /清单/);
  }
  assert.throws(() => encodeLightingLightmapMips({ baseEncoding: 'unknown', rgbmRange: 4,
    maxTextureBytes: 84, levels: [] }), /编码/);
});

test('ZIP STORE结构门只接受实读匹配的新lightmap bin；SHA另由读资产入口核对', () => {
  const bytes = fixture();
  const asset = { kind: 'lightmap', encoding: 'rgbm-linear-mips-v1', url: 'Assets/LightingBakes/new/atlas.bin',
    byteLength: bytes.length, rgbmRange: 4, width: 4, height: 4, levelCount: 3, textureBytes: 84 };
  assert.equal(validateLightingLightmapMipAsset(asset, bytes, 84).totalTextureBytes, 84);
  for (const patch of [{ kind: 'geometry' }, { encoding: 'binary-v1' }, { encoding: undefined }, { width: undefined },
    { levelCount: 4 }, { textureBytes: 64 }, { byteLength: bytes.length - 1 }, { rgbmRange: 8 },
    { url: 'atlas.png' }, { url: 'atlas.bin?unknown' }, { url: 'atlas.bin#unknown' }]) {
    assert.throws(() => validateLightingLightmapMipAsset({ ...asset, ...patch }, bytes, 84), /无效/);
  }
  assert.equal(isLightingLightmapMipEncoding('rgbm'), false);
  assert.equal(isLightingLightmapMipEncoding('rgbm-gamma'), false);
});

test('浏览器没有SharedArrayBuffer全局仍正常，存在真实SAB时明确拒绝', () => {
  const moduleUrl = new URL('../../electron/shared/sceneLightingLightmapMips.ts', import.meta.url).href;
  const script = `delete globalThis.SharedArrayBuffer; const m=await import(${JSON.stringify(moduleUrl)});
    const rgba=n=>new Uint8Array(n*n*4); const bytes=m.encodeLightingLightmapMips({baseEncoding:'rgbm',rgbmRange:1,maxTextureBytes:20,levels:[{width:2,height:2,rgba:rgba(2)},{width:1,height:1,rgba:rgba(1)}]});
    const d=m.decodeLightingLightmapMips(bytes,{maxTextureBytes:20}); if(d.levels[0].rgba.buffer!==bytes.buffer)throw Error('not zero copy');`;
  const result = spawnSync(process.execPath, ['--experimental-transform-types', '--input-type=module', '-e', script], { encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  if (typeof SharedArrayBuffer !== 'undefined') {
    const bytes = fixture(), shared = new Uint8Array(new SharedArrayBuffer(bytes.length)); shared.set(bytes);
    assert.throws(() => decodeLightingLightmapMips(shared, { maxTextureBytes: 84 }), /共享/);
  }
});

const python = String.raw`
import importlib.util,json,sys,base64,numpy as np
spec=importlib.util.spec_from_file_location('mips',sys.argv[1]); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
def mesh(key,x0,y0,x1,y1,size=64):
    uv=np.array([[[x0,y0],[x1,y0],[x1,y1]],[[x0,y0],[x1,y1],[x0,y1]]],dtype=np.float32)/size
    return {'key':key,'triangles':np.array([[0,1,2],[0,2,3]],dtype=np.uint32),'bakeUvs':uv}
rgba=np.zeros((64,64,4),dtype=np.float32); rgba[:,:,3]=1
for y in range(64):
    for x in range(64): rgba[y,x,:3]=[x/64,y/64,(x+y)/128]
original=rgba.copy(); meshes=[mesh('two-charts-in-distinct-objects',8,8,16,16),mesh('normal',40,40,48,48)]
cert,owner=m.certify_lightmap_mip_charts(meshes,64,64,1,max_working_bytes=2_000_000)
padded=m.pad_linear_lightmap(rgba.reshape(-1),cert,owner).reshape(64,64,4)
assert np.array_equal(rgba,original)
assert np.array_equal(padded[owner>=0],rgba[owner>=0])
assert len(cert['charts'])==2
# 单个object中两个不连通UV岛仍为两个chart，不能按object合并。
one={'key':'one-object','triangles':np.array([[0,1,2],[0,2,3],[4,5,6],[4,6,7]],dtype=np.uint32),'bakeUvs':np.concatenate([meshes[0]['bakeUvs'],meshes[1]['bakeUvs']])}
one_cert,_=m.certify_lightmap_mip_charts([one],64,64,1,max_working_bytes=2_000_000); assert len(one_cert['charts'])==2
# 最近距离/等距序与暴力独立oracle逐像素一致（不是直接复算EDT实现）。
mask=np.zeros((7,9),dtype=bool); mask[1,1]=True; mask[1,7]=True; mask[5,4]=True
observed=m._nearest_seed_ids(mask); seeds=np.flatnonzero(mask)
expected=np.empty_like(observed)
for y in range(7):
    for x in range(9): expected[y,x]=min(seeds,key=lambda i:((i//9-y)**2+(i%9-x)**2,int(i)))
assert np.array_equal(observed,expected)
# 全黑种子有效，资格与颜色无关；非黑的空白区不能自行升级为有效覆盖。
black=np.zeros_like(rgba); black[:,:,3]=1
assert np.all(m.pad_linear_lightmap(black.reshape(-1),cert,owner).reshape(-1,4)[:,:3]==0)
# 线性oracle：2x2不同能量的均值；编码RGBA平均是错误变体。
small=np.array([[[0,1,4,1],[1,2,8,1]],[[3,4,16,1],[4,5,32,1]]],dtype=np.float32)
assert np.array_equal(m.linear_mip_levels(small,2,2,1)[1][0,0],[2,3,15,1])
failures=[]
bad=[([mesh('edge',0,8,8,16)],1),([mesh('a',8,8,16,16),mesh('b',18,8,26,16)],1),([mesh('too-high',8,8,16,16)],4),([mesh('tiny',8.01,8.01,8.1,8.1)],1)]
for data,lod in bad:
    try: m.certify_lightmap_mip_charts(data,64,64,lod,max_working_bytes=2_000_000)
    except ValueError: failures.append(True)
    else: raise AssertionError('bad chart accepted')
for altered in [np.full_like(rgba,np.nan),np.full_like(rgba,-1)]:
    try: m.pad_linear_lightmap(altered.reshape(-1),cert,owner)
    except ValueError: failures.append(True)
    else: raise AssertionError('bad pixels accepted')
try: m.certify_lightmap_mip_charts(meshes,64,64,1,max_working_bytes=1)
except ValueError: failures.append(True)
cases=[]
for encoding in ['rgbm','rgbm-gamma']:
    result=m.prepare_lightmap_mips(rgba.reshape(-1),64,64,meshes,1,encoding,max_working_bytes=2_000_000,max_texture_bytes=20480)
    cases.append({key:(base64.b64encode(value).decode() if key=='data' else value) for key,value in result.items() if key!='certificate'})
known=np.array([0,.5,1,np.nextafter(np.float32(.5),np.float32(0))],dtype=np.float32)
quantized=m.quantize_blender_rgba8(known).tolist()
png=None
if len(sys.argv)>2:
    from pathlib import Path
    path=Path(sys.argv[2]); source=np.frombuffer((path/'quantization-input-f32.bin').read_bytes(),dtype='<f4')
    actual=np.frombuffer((path/'quantization-bottom-first-u8.bin').read_bytes(),dtype=np.uint8)
    assert np.array_equal(m.quantize_blender_rgba8(source),actual); png=len(actual)
print(json.dumps({'cases':cases,'failures':len(failures),'charts':len(cert['charts']),'seeds':[c['seedCount'] for c in cert['charts']], 'quantized':quantized,'pngChannels':png}))
`;

test('独立Python真实chart/线性padding/EDT/量化与TS容器互通，正反例均保留', () => {
  const args = ['-c', python, fileURLToPath(new URL('../../electron/lighting-bake/lightmap_mips.py', import.meta.url))];
  if (process.env.PHASE2_MIP_PNG_ORACLE) args.push(process.env.PHASE2_MIP_PNG_ORACLE);
  const result = spawnSync(process.env.PHASE2_PYTHON ?? 'python', args, { encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  const observed = JSON.parse(result.stdout);
  assert.equal(observed.charts, 2);
  assert.deepEqual(observed.seeds, [64, 64]);
  assert.equal(observed.failures, 7);
  assert.deepEqual(observed.quantized, [0, 128, 255, 127]);
  if (process.env.PHASE2_MIP_PNG_ORACLE) assert.equal(observed.pngChannels, 8192);
  for (const result of observed.cases) {
    const bytes = Buffer.from(result.data, 'base64');
    const decoded = validateLightingLightmapMipAsset({ kind: 'lightmap', url: 'Assets/LightingBakes/new/atlas.bin',
      ...result, byteLength: bytes.length }, bytes, 20480);
    assert.equal(decoded.width, 64); assert.equal(decoded.height, 64); assert.equal(decoded.levelCount, 2);
    assert.equal(decoded.totalTextureBytes, 20480);
    assert.equal(decoded.rgbmRange, 1);
    assert.ok(decoded.levels.every(level => level.rgba.length === level.width * level.height * 4));
    const reference = linear => {
      const q = linear.map(value => decoded.baseEncoding === 'rgbm-gamma' ? Math.sqrt(value) : value);
      const multiplier = Math.max(1 / 255, Math.ceil(Math.max(...q) * 255) / 255);
      return [...q.map(value => Math.fround(value / multiplier)), Math.fround(multiplier)]
        .map(value => Math.floor(Math.fround(Math.fround(value * 255) + .5)));
    };
    const read = (level, x, y) => [...decoded.levels[level].rgba.subarray((y * decoded.levels[level].width + x) * 4,
      (y * decoded.levels[level].width + x + 1) * 4)];
    // 独立标量oracle来自原线性种子；位置明确为bottom-first，不能靠上下翻转碰巧过绿。
    assert.deepEqual(read(0, 8, 8), reference([8 / 64, 8 / 64, 16 / 128]));
    assert.deepEqual(read(1, 4, 4), reference([8.5 / 64, 8.5 / 64, 17 / 128]));
    const wrongEncodedAverage = [0, 1, 2, 3].map(channel => Math.round(
      (read(0, 8, 8)[channel] + read(0, 9, 8)[channel] + read(0, 8, 9)[channel] + read(0, 9, 9)[channel]) / 4));
    assert.notDeepEqual(wrongEncodedAverage, read(1, 4, 4), '错误变体：平均RGBM必须与线性生成产物不同');
  }
});
