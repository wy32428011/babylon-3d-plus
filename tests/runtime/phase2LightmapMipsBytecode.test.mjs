import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// 普通Python-E仅验证显式scoped guard；真实Blender嵌入解释器仍需后续全链独立验证。
const python = String.raw`
import importlib.util,json,pathlib,shutil,sys,tempfile,numpy as np
source=pathlib.Path(sys.argv[1]).resolve(); original_flag=sys.dont_write_bytecode
assert sys.flags.ignore_environment==1
assert original_flag is False
def run(root,name,previous,broken):
    folder=root/name; folder.mkdir()
    shutil.copy2(source/'lightmap_mips.py',folder/'lightmap_mips.py')
    gamma=(source/'rgbm_gamma_codec.py').read_text(encoding='utf-8')
    if broken: gamma="import sys\nassert sys.dont_write_bytecode is True\nraise RuntimeError('controlled gamma import failure')\n"
    (folder/'rgbm_gamma_codec.py').write_text(gamma,encoding='utf-8')
    spec=importlib.util.spec_from_file_location('isolated_'+name,folder/'lightmap_mips.py')
    module=importlib.util.module_from_spec(spec)
    # producer本身的导入guard属于未来主py接线，此测试只负责让受测内部导入前目录保持干净。
    sys.dont_write_bytecode=True
    try: spec.loader.exec_module(module)
    finally: sys.dont_write_bytecode=previous
    uv=np.array([[[8,8],[16,8],[16,16]],[[8,8],[16,16],[8,16]]],dtype=np.float32)/64
    meshes=[{'key':'isolated-quad','triangles':np.array([[0,1,2],[0,2,3]],dtype=np.uint32),'bakeUvs':uv}]
    pixels=np.ones(64*64*4,dtype=np.float32)
    failed=False
    try:
        result=module.prepare_lightmap_mips(pixels,64,64,meshes,1,'rgbm-gamma',max_working_bytes=2_000_000,max_texture_bytes=20480)
        assert result['encoding']=='rgbm-gamma-mips-v1' and result['levelCount']==2
    except RuntimeError as error:
        assert broken and str(error)=='controlled gamma import failure'; failed=True
    assert failed==broken
    assert sys.dont_write_bytecode is previous
    files=sorted(str(path.relative_to(folder)) for path in folder.rglob('*'))
    assert files==['lightmap_mips.py','rgbm_gamma_codec.py'],files
    return {'case':name,'previous':previous,'restored':sys.dont_write_bytecode,'controlledError':failed,'files':files}
reports=[]
try:
    with tempfile.TemporaryDirectory(prefix='phase2-mip-bytecode-') as temporary:
        root=pathlib.Path(temporary).resolve()
        assert root.is_relative_to(pathlib.Path(tempfile.gettempdir()).resolve())
        for previous in [False,True]:
            reports.append(run(root,'success-'+str(previous),previous,False))
            reports.append(run(root,'failure-'+str(previous),previous,True))
finally: sys.dont_write_bytecode=original_flag
print(json.dumps({'ignoreEnvironment':sys.flags.ignore_environment,'startupDontWrite':original_flag,'finalDontWrite':sys.dont_write_bytecode,'cases':reports}))
`;

test('普通python -E实际Gamma嵌套导入不写pycache，成功/抛错均恢复False或True原flag', () => {
  const result = spawnSync(process.env.PHASE2_PYTHON ?? 'python', ['-E', '-c', python,
    fileURLToPath(new URL('../../electron/lighting-bake/', import.meta.url))], {
    encoding: 'utf8', timeout: 10000, windowsHide: true, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  const observed = JSON.parse(result.stdout);
  assert.equal(observed.ignoreEnvironment, 1);
  assert.equal(observed.startupDontWrite, false);
  assert.equal(observed.finalDontWrite, false);
  assert.equal(observed.cases.length, 4);
  for (const actual of observed.cases) {
    assert.equal(actual.previous, actual.restored);
    assert.equal(actual.controlledError, actual.case.startsWith('failure-'));
    assert.deepEqual(actual.files, ['lightmap_mips.py', 'rgbm_gamma_codec.py']);
  }
});
