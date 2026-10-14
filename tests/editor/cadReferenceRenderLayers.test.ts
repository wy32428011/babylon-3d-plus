import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeCadReferenceRenderLayers } from '../../src/editor/cad/cadReferenceRenderLayers.ts';
function matrices(x: number): Float32Array { return new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,x,0.01,0,1]); }
function fixture() {
  const positions = new Float32Array([0,0,0,1,0,1]), counts = new Uint32Array([2]);
  return ['A','B'].map((name, i) => ({ name, positions, polylinePointCounts: counts, instanceMatrices: matrices(i * 10), instanceCount: 1, entityCount: 1, polylineCount: 1, pointCount: 2, isChunk: true, geometryKey: 'block:0:0' }));
}
test('不同显示组的实例不能覆盖：同一原型批次合并全部矩阵并保留统计', () => {
  const source = fixture(), result = mergeCadReferenceRenderLayers(source);
  assert.equal(result.length, 1);
  assert.equal(result[0].instanceCount, 2);
  assert.deepEqual([result[0].instanceMatrices![12], result[0].instanceMatrices![28]], [0,10]);
  assert.equal(result[0].positions, source[0].positions);
  assert.equal(result[0].polylinePointCounts, source[0].polylinePointCounts);
  assert.equal(result[0].polylineCount, 2); assert.equal(result[0].pointCount, 4);
});
test('同一原型跨几何批次复用合并矩阵，普通精确路径保持原结果', () => {
  const source=fixture(); const more=source.map(layer => ({ ...layer, geometryKey: 'block:0:1', positions: layer.positions.slice() }));
  const result=mergeCadReferenceRenderLayers([...source,...more]);
  assert.equal(result.length,2); assert.equal(result[0].instanceMatrices,result[1].instanceMatrices);
  const ordinary={...source[0],isChunk:false,geometryKey:undefined};
  assert.equal(mergeCadReferenceRenderLayers([ordinary])[0],ordinary);
});
