import assert from 'node:assert/strict'; import { test } from 'node:test'; import { readFileSync } from 'node:fs'; import { spawnSync } from 'node:child_process';
import { planLightingProbeVolumes } from '../../electron/shared/sceneLightingProbeVolumes.ts';
const source=readFileSync(new URL('../../electron/lighting-bake/cycles_bake.py',import.meta.url),'utf8');
test('区域探针跨 Python/TypeScript 位置、重叠去重和细体积边界保持一致',()=>{
 const volumes=[{id:'a',name:'负坐标',enabled:true,min:[-2,-1,-2] as [number,number,number],max:[2,1,2] as [number,number,number]},{id:'b',name:'重叠',enabled:true,min:[-2,-1,-2] as [number,number,number],max:[2,1,2] as [number,number,number]},{id:'thin',name:'薄层',enabled:true,min:[0,4,0] as [number,number,number],max:[1,4.01,1] as [number,number,number]}];
 const expected=planLightingProbeVolumes(volumes,1,{min:[0,0,0],max:[1,1,1]});
 const script=`import ast,sys,json,math
payload=json.load(sys.stdin); tree=ast.parse(payload['source']); node=next(node for node in tree.body if isinstance(node,ast.FunctionDef) and node.name=='probe_positions')
ns={'Any':object,'Vector':list,'math':math,'vector':lambda v:[v[0],v[2],v[1]]};exec(compile(ast.Module(body=[node],type_ignores=[]),'regions-test','exec'),ns)
positions=ns['probe_positions']([],1,payload['volumes']);print(json.dumps([[p[0],p[2],p[1]] for p in positions]))
`;
 const actual=spawnSync('python',['-c',script],{input:JSON.stringify({source,volumes}),encoding:'utf8',windowsHide:true,env:{...process.env,PYTHONUTF8:'1',PYTHONIOENCODING:'utf-8'}});
 assert.equal(actual.status,0,actual.stderr); assert.deepEqual(JSON.parse(actual.stdout),expected.positions);
});
