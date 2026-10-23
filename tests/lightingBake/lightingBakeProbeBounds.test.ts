import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { planLightingProbeVolumes } from '../../electron/shared/sceneLightingProbeVolumes.ts';
const source = readFileSync(new URL('../../electron/lighting-bake/cycles_bake.py', import.meta.url), 'utf8');
test('提前探针规划使用原始物理输入，忽略UV临时世界缩放残留的对象包围盒', () => {
  const meshes = [
    { positions: [-0.5,-0.5,-0.5, 0.5,0.5,0.5], worldMatrix: [15,0,0,0, 0,0.3,0,0, 0,0,10,0, 0,-0.15,0,1] },
    { positions: [-0.5,0,-0.5, 0.5,0.05,0.5], worldMatrix: [0.22,0,0,0, 0,120,0,0, 0,0,0.35,0, 0,0,0,1] },
  ];
  const bounds = { min: [-7.5,-0.3,-5] as [number,number,number], max: [7.5,6,5] as [number,number,number] };
  const expected = planLightingProbeVolumes(undefined, 6, bounds);
  assert.equal(expected.count, 12);
  const script = `import ast,sys,json,math
from typing import Any
payload=json.load(sys.stdin);tree=ast.parse(payload['source']);names={'source_probe_bounds','probe_positions'}
module=ast.Module(body=[node for node in tree.body if isinstance(node,ast.FunctionDef) and node.name in names],type_ignores=[])
ns={'Any':Any,'Vector':list,'math':math,'vector':lambda value:[value[0],value[2],value[1]]}
exec(compile(module,'bounds-regression','exec'),ns)
class StaleObject:
 @property
 def bound_box(self): raise AssertionError('must not trust cached UV-scale bound_box')
bounds=ns['source_probe_bounds'](payload['meshes'])
positions=ns['probe_positions']([StaleObject()],6,None,bounds)
print(json.dumps({'bounds':bounds,'positions':[[point[0],point[2],point[1]] for point in positions]}))
`;
  const actual = spawnSync('python', ['-c', script], { input: JSON.stringify({ source, meshes }), encoding: 'utf8', windowsHide: true,
    env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' } });
  assert.equal(actual.status, 0, actual.stderr);
  const value = JSON.parse(actual.stdout);
  assert.deepEqual(value.bounds, bounds); assert.deepEqual(value.positions, expected.positions);
});
