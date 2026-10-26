import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { decodeLightingLightmapMips } from '../../electron/shared/sceneLightingLightmapMips.ts';
import { LIGHTING_LIGHTMAP_MIP_RECIPE } from '../../electron/shared/sceneLightingTextureCodec.ts';

const program = String.raw`
import ast,base64,json,sys,shutil,math,numpy as np
from pathlib import Path
from array import array
source=Path(sys.argv[1]); fixture=json.loads(Path(sys.argv[2]).read_text(encoding='utf-8')); work=Path(sys.argv[3])
tree=ast.parse(source.read_text(encoding='utf-8')); old=ast.parse(fixture['nonreceiverSource']['predicate'])
get=lambda root,name:next(node for node in root.body if isinstance(node,ast.FunctionDef) and node.name==name)
assert ast.dump(get(tree,'can_skip_nonreceiver_lightmap_uv'),include_attributes=False)==ast.dump(get(old,'can_skip_nonreceiver_lightmap_uv'),include_attributes=False)
mesh=get(tree,'make_mesh'); guards=[node for node in ast.walk(mesh) if isinstance(node,ast.If) and isinstance(node.test,ast.UnaryOp) and isinstance(node.test.op,ast.Not) and isinstance(node.test.operand,ast.Call) and isinstance(node.test.operand.func,ast.Name) and node.test.operand.func.id=='can_skip_nonreceiver_lightmap_uv']
assert len(guards)==1
assert ast.dump(guards[0],include_attributes=False)==ast.dump(ast.parse(fixture['nonreceiverSource']['guard']).body[0],include_attributes=False)
calls=[node for node in ast.walk(mesh) if isinstance(node,ast.Call) and isinstance(node.func,ast.Attribute) and node.func.attr=='smart_project'];assert len(calls)==1 and calls[0] in list(ast.walk(guards[0]))
for name in ['lightmap_mips.py','rgbm_gamma_codec.py']:shutil.copyfile(source.with_name(name),work/name)
namespace={'Path':Path,'sys':sys,'__file__':str(work/'cycles_bake.py'),'_LIGHTMAP_MIP_MODULE':None}
exec(compile(ast.Module(body=[get(tree,'lightmap_mip_module')],type_ignores=[]),'actual-mip-loader','exec'),namespace)
before=sys.dont_write_bytecode;sys.dont_write_bytecode=False
module=namespace['lightmap_mip_module']();assert not sys.dont_write_bytecode
pixels=np.empty((32,32,4),dtype=np.float32);pixels[:]=[.1,.2,.3,1];original=pixels.copy()
meshes=[{'key':'fixed-chart','triangles':np.array([[0,1,2]],dtype=np.uint32),'bakeUvs':np.array([[[.261,.273],[.541,.282],[.28,.533]]],dtype=np.float32)}]
payload=module.prepare_lightmap_mips(pixels.reshape(-1),32,32,meshes,1,'rgbm-gamma',max_working_bytes=1024*1024,max_texture_bytes=5120)
assert np.array_equal(pixels,original) and not sys.dont_write_bytecode

# 只替换Blender的存储与世界Jacobian读取；实际metrics/pack函数和真实cert/producer不替换。
from types import SimpleNamespace
class Entry:
    def __init__(self,u,v):self.uv=(u,v)
    @property
    def uv(self):return self._uv
    @uv.setter
    def uv(self,value):self._uv=SimpleNamespace(x=float(np.float32(value[0])),y=float(np.float32(value[1])))
class Object(dict):
    def __init__(self,index):
        self.name='plane-'+str(index);self.data=SimpleNamespace(uv_layers={'LightmapUV':SimpleNamespace(data=[Entry(0,0),Entry(1,0),Entry(1,1),Entry(0,1)])},polygons=[0,1])
def execute(functions):
    namespace={'Any':object,'math':math,'lightmap_face_world_per_uv':lambda *_:11.7}
    for function in functions:exec(compile(ast.Module(body=[function],type_ignores=[]),'actual-pack','exec'),namespace)
    return namespace
packing=execute([get(tree,name) for name in ['lightmap_gutter','lightmap_metrics','pack_atlases']])
legacy=execute([ast.parse(fixture['noMipPackingSource']['functions'][name]).body[0] for name in ['lightmap_metrics','pack_atlases']])
old_objects=[Object(0),Object(1)];new_objects=[Object(0),Object(1)]
assert packing['lightmap_gutter']({})==4
assert [packing['lightmap_metrics'](obj,1) for obj in new_objects]==[legacy['lightmap_metrics'](obj,1) for obj in old_objects]
legacy['pack_atlases'](old_objects,128,1,128*128*4);packing['pack_atlases'](new_objects,128,1,128*128*4)
values=lambda objects:[[(entry.uv.x,entry.uv.y) for entry in obj.data.uv_layers['LightmapUV'].data] for obj in objects]
assert values(old_objects)==values(new_objects)
positive=[]
for levels in range(1,5):
    gutter=packing['lightmap_gutter']({'lightmapMipLevels':levels});assert gutter==math.ceil(1.5*(1<<levels))+2
    for count in [1,2]:
        objects=[Object(index) for index in range(count)]
        metrics=[packing['lightmap_metrics'](obj,1,gutter) for obj in objects]
        pages=packing['pack_atlases'](objects,128,1,128*128*4,gutter);assert len(pages)==1
        charts=[]
        for obj in objects:
            uv=np.array(values([obj])[0],dtype=np.float32)
            charts.append({'key':obj.name,'triangles':np.array([[0,1,2],[0,2,3]],dtype=np.uint32),'bakeUvs':uv[np.array([[0,1,2],[0,2,3]])]})
        certificate,owner=module.certify_lightmap_mip_charts(charts,128,128,levels,max_working_bytes=16*1024*1024)
        # 独立重算公式，核每个footprint在原分配box内；任意相位不依赖helper自己报成功。
        x=0
        for chart,metric in zip(certificate['charts'],metrics):
            width,height=metric[:2];lo=np.array(chart['bounds'][:2]);hi=np.array(chart['bounds'][2:])
            for level,footprint in enumerate(chart['footprints']):
                step=1<<level
                lower=[math.floor((float(value)-1)/step-.5)*step for value in lo]
                upper=[(math.floor((float(value)+1)/step-.5)+2)*step for value in hi]
                assert footprint==lower+upper
                assert x<=lower[0]<=upper[0]<=x+width and 0<=lower[1]<=upper[1]<=height
            x+=width
        linear=np.empty((128,128,4),dtype=np.float32);linear[:]=[.1,.2,.3,1]
        maximum=sum(max(1,128>>level)**2*4 for level in range(levels+1))
        actual=module.prepare_lightmap_mips(linear.reshape(-1),128,128,charts,levels,'rgbm-gamma',max_working_bytes=16*1024*1024,max_texture_bytes=maximum)
        assert actual['levelCount']==levels+1 and actual['textureBytes']==maximum
        positive.append({'additionalLevels':levels,'planes':count,'gutter':gutter,'textureBytes':maximum})
# 增加对象外沿留白不能掩盖同一对象内部两个chart重叠的footprint。
tight=[{'key':'tight-internal','triangles':np.array([[0,1,2],[3,4,5]],dtype=np.uint32),'bakeUvs':np.array([[[.261,.273],[.341,.282],[.28,.353]],[[.351,.273],[.431,.282],[.37,.353]]],dtype=np.float32)}]
try:module.certify_lightmap_mip_charts(tight,128,128,4,max_working_bytes=16*1024*1024)
except ValueError as error:assert '足印重叠' in str(error)
else:raise AssertionError('tight internal charts must reject')
assert not (work/'__pycache__').exists()
recipe=next(node.value.value for node in tree.body if isinstance(node,ast.Assign) and any(isinstance(target,ast.Name) and target.id=='LIGHTMAP_MIP_RECIPE' for target in node.targets))
sys.dont_write_bytecode=before
print(json.dumps({'predicateAstEqual':True,'uniqueSmartProjectGuard':True,'recipe':recipe,'noPycache':True,'payload':base64.b64encode(payload['data']).decode(),'encoding':payload['encoding'],'levelCount':payload['levelCount'],'textureBytes':payload['textureBytes'],'inputUnchanged':True,'legacyMetricsAndUvEqual':True,'positivePackingCases':positive,'internalChartOverlapRejected':True}))
`;

test('current主py UV合同及NoMip逐值保持；真实pack/cert/producer单chart与两plane的Mip1..4', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'phase2-mip-wiring-'));
  t.after(async () => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.match(path.basename(root), /^phase2-mip-wiring-/); await fs.rm(root, { recursive: true, force: true }); });
  const result = spawnSync(process.env.PHASE2_PYTHON ?? 'python', ['-E', '-c', program,
    fileURLToPath(new URL('../../electron/lighting-bake/cycles_bake.py', import.meta.url)),
    fileURLToPath(new URL('./fixtures/phase2MipProducerContract.json', import.meta.url)), root],
  { encoding: 'utf8', timeout: 10000, windowsHide: true, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout); assert.equal(report.recipe, LIGHTING_LIGHTMAP_MIP_RECIPE); assert.equal(report.noPycache, true); assert.equal(report.inputUnchanged, true);
  assert.equal(report.legacyMetricsAndUvEqual, true); assert.equal(report.internalChartOverlapRejected, true);
  assert.equal(report.positivePackingCases.length, 8);
  t.diagnostic(JSON.stringify({ positivePackingCases: report.positivePackingCases, legacyMetricsAndUvEqual: true, internalChartOverlapRejected: true }));
  const decoded = decodeLightingLightmapMips(Buffer.from(report.payload, 'base64'), { maxTextureBytes: 5120, expectedWidth: 32, expectedHeight: 32, expectedLevelCount: 2, expectedEncoding: 'rgbm-gamma-mips-v1' });
  assert.equal(decoded.totalTextureBytes, 5120); assert.equal(decoded.levels[0].rgba.length, 4096); assert.equal(decoded.levels[1].rgba.length, 1024);
});
