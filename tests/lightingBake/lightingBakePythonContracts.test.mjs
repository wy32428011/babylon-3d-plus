import assert from 'node:assert/strict'; import { test } from 'node:test'; import { readFileSync } from 'node:fs'; import { spawnSync } from 'node:child_process';
const source = readFileSync(new URL('../../electron/lighting-bake/cycles_bake.py',import.meta.url),'utf8');
function check(script) { const result=spawnSync('python',['-c',script],{input:source,encoding:'utf8',windowsHide:true,env:{...process.env,PYTHONUTF8:'1',PYTHONIOENCODING:'utf-8'}}); assert.equal(result.status,0,result.stderr || result.stdout); }
test('Python 二进制附件保留数值并拒绝越界，GPU错误分类仅允许显存/设备失败回退',()=>check(`import ast,sys,math,tempfile,struct
from pathlib import Path
from array import array
source=sys.stdin.read(); tree=ast.parse(source)
names={"load_binary_geometry","source_path","is_gpu_memory_error"}
module=ast.Module(body=[node for node in tree.body if isinstance(node,ast.FunctionDef) and node.name in names],type_ignores=[])
ns={"Path":Path,"array":array,"math":math,"_binary_sys":sys}; exec(compile(module,"cycles-test","exec"),ns)
assert ns["is_gpu_memory_error"](RuntimeError("CUDA out of memory"))
assert not ns["is_gpu_memory_error"](ValueError("invalid UV input"))
with tempfile.TemporaryDirectory() as directory:
 root=Path(directory); raw=b"BLGEO001"+struct.pack("<3d",-0.0,5e-324,1.2345678901234567); (root/"input.bin").write_bytes(raw)
 mesh={"geometryBinary":{"version":1,"file":"input.bin","byteLength":len(raw),"attributes":{"positions":{"type":"float64","byteOffset":8,"length":3}}}}
 ns["load_binary_geometry"](mesh,root); assert list(mesh["positions"])==[-0.0,5e-324,1.2345678901234567]
 bad={"geometryBinary":{"version":1,"file":"input.bin","byteLength":len(raw),"attributes":{"positions":{"type":"float64","byteOffset":8,"length":4}}}}
 try: ns["load_binary_geometry"](bad,root)
 except ValueError: pass
 else: raise AssertionError("must reject truncated geometry")
`));
test('Python探针上限失败发生在任何图集烘焙前',()=>check(`import ast,sys,json,tempfile,argparse,time
from pathlib import Path
from types import SimpleNamespace
source=sys.stdin.read(); tree=ast.parse(source); main=next(node for node in tree.body if isinstance(node,ast.FunctionDef) and node.name=="main")
class ProbeLimit(Exception): pass
def refuse(*args): raise ProbeLimit()
def no_bake(*args): raise AssertionError("bake must not start")
with tempfile.TemporaryDirectory() as directory:
 file=Path(directory)/"input.json"; file.write_text(json.dumps({"meshes":[{"receiver":True}],"settings":{"quality":"preview","atlasSize":1024,"texelsPerMeter":8,"maxTextureMiB":16,"probeSpacing":0.1},"lights":[],"environment":{}}))
 sys.argv=["blender","--","--input",str(file)]
 scene=SimpleNamespace(render=SimpleNamespace(),cycles=SimpleNamespace())
 bpy=SimpleNamespace(context=SimpleNamespace(scene=scene,view_layer=SimpleNamespace(update=lambda:None)),ops=SimpleNamespace(object=SimpleNamespace(select_all=lambda **kw:None,delete=lambda **kw:None)))
 ns={"argparse":argparse,"sys":sys,"Path":Path,"json":json,"time":time,"bpy":bpy,"load_binary_geometry":lambda *a:None,"source_probe_bounds":lambda *a:{"min":[0,0,0],"max":[1,1,1]},"configure_bake_device":lambda *a:None,"prepare_meshes":lambda *a:([{"receiver":True}],[{"input_index":0}]),"setup_lights":lambda *a:[],"pack_atlases":lambda *a:[[1]],"probe_positions":refuse,"bake_irradiance":no_bake}
 exec(compile(ast.Module(body=[main],type_ignores=[]),"cycles-test","exec"),ns)
 try: ns["main"]()
 except ProbeLimit: pass
 else: raise AssertionError("probe limit missing")
`));

test('独立 Python 的内存采样可用时为真实正数，不可用时为 null',()=>check(`import ast,sys
source=sys.stdin.read(); tree=ast.parse(source); node=next(node for node in tree.body if isinstance(node,ast.FunctionDef) and node.name=="process_peak_memory_bytes")
ns={"sys":sys}; exec(compile(ast.Module(body=[node],type_ignores=[]),"memory-test","exec"),ns)
value=ns["process_peak_memory_bytes"](); assert value is None or isinstance(value,int) and value>0
`));

test('设备选择保持CPU默认，GPU不可用和配置失败明确回退且不写用户偏好',()=>check(`import ast,sys,json,io,contextlib
from types import SimpleNamespace
source=sys.stdin.read();tree=ast.parse(source);node=next(node for node in tree.body if isinstance(node,ast.FunctionDef) and node.name=='configure_bake_device')
cycles=SimpleNamespace(device='CPU');bpy=SimpleNamespace(context=SimpleNamespace(scene=SimpleNamespace(cycles=cycles),preferences=SimpleNamespace(addons={})))
ns={'bpy':bpy,'json':json,'discover_bake_devices':lambda:[]};exec(compile(ast.Module(body=[node],type_ignores=[]),'device-test','exec'),ns)
def select(mode):
 output=io.StringIO()
 with contextlib.redirect_stdout(output): ns['configure_bake_device'](mode)
 return json.loads(output.getvalue().strip().split(' ',1)[1])
assert select('cpu')['actual']=='CPU'
missing=select('gpu');assert missing['actual']=='CPU' and missing['fallbackReason']
ns['discover_bake_devices']=lambda:[{'id':'g','name':'GPU','backend':'CUDA','type':'GPU'}]
def refuse(): raise RuntimeError('driver unavailable')
bpy.context.preferences.addons={'cycles':SimpleNamespace(preferences=SimpleNamespace(refresh_devices=refuse))}
failed=select('auto');assert failed['actual']=='CPU' and failed['fallbackReason']
`));
