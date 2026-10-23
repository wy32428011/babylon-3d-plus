import assert from 'node:assert/strict'; import { test } from 'node:test';
import { encodeLightingBakeTransport, decodeLightingBakeTransport } from '../../electron/shared/sceneLightingBakeBinary.ts';
import type { LightingBakeInput } from '../../electron/shared/sceneLightingBakeContract.ts';
const fixture = (): LightingBakeInput => ({ version: 1, jobId:'binary', signature:'s', sceneName:'数值', settings:{} as LightingBakeInput['settings'], lights:[], environment:{color:[1,1,1],intensity:1}, meshes:[{ key:'m',entityId:'e',nodeKey:'n',name:'网格',positions:[-0,Number.MIN_VALUE,1.2345678901234567,1,0,0,0,0,1],normals:[0,1,0,0,1,0,0,1,0],indices:[0,1,2],uvs:[0,0,1,0,0,1],uvs2:[0.1,0.2,0.3,0.4,0.5,0.6],colors:Array(12).fill(0.4),tangents:Array(12).fill(0.7),worldMatrix:Array(16).fill(0),material:{} as LightingBakeInput['meshes'][0]['material']}] });
test('二进制传输保留 Float64 原值、Uint32 索引与全部属性，元数据无巨型数组', () => {
 const input=fixture(), transport=encodeLightingBakeTransport(input); assert.equal(transport.version,2); assert.equal(transport.input.meshes[0].positions,undefined);
 assert.deepEqual(decodeLightingBakeTransport(transport),input); assert.equal(transport.geometry.length,1); assert.ok(transport.geometry[0].bytes instanceof ArrayBuffer);
 assert.deepEqual(input,fixture());
});
test('二进制版本、截断、偏移越界与重复映射被拒绝', () => {
 const t=encodeLightingBakeTransport(fixture()); assert.throws(()=>decodeLightingBakeTransport({...t,version:3}));
 const mesh={...t.geometry[0],bytes:t.geometry[0].bytes.slice(0,12)}; assert.throws(()=>decodeLightingBakeTransport({...t,geometry:[mesh]}),/二进制/);
 assert.throws(()=>decodeLightingBakeTransport({...t,geometry:[t.geometry[0],t.geometry[0]]}),/二进制/);
});
