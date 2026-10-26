import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as B from '@babylonjs/core';
import { createAssetRevision } from '../../scripts/lib/phase2AssetRevisions.mjs';
import { compileAsset } from '../../scripts/phase2-asset-revisions.mjs';

const source = `import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
export class ParametricModelRuntimeComponent {
  constructor(public node: any) {}
  private getModelNodes(): any[] {
    const scene = this.node.getScene?.();
    const nodes = [this.node, ...(scene?.transformNodes ?? []), ...(scene?.meshes ?? [])];
    return [...new Set(nodes.filter(candidate => candidate === this.node || candidate.isDescendantOf?.(this.node)))];
  }
  private getMeshComponents(mesh: any) {
    const positions=mesh.positions, indices=mesh.indices;
    const coordinateKeys: string[] = [];
    const vertexIndicesByKey = new Map<string, number[]>();
    for(let vertex=0;vertex<positions.length/3;vertex++) {
      const key=positions.slice(vertex*3,vertex*3+3).map((n:number)=>n.toFixed(5)).join(',');
      coordinateKeys[vertex]=key;
      const list=vertexIndicesByKey.get(key)??[];list.push(vertex);vertexIndicesByKey.set(key,list);
    }
    const parents = new Map<string, string>();
    const findRoot=(key:string):string=>{ const parent=parents.get(key);
      if(!parent){parents.set(key,key);return key;} if(parent===key)return key;
      const root=findRoot(parent);parents.set(key,root);return root; };
    const union=(a:string,b:string)=>{const left=findRoot(a),right=findRoot(b);if(left!==right)parents.set(right,left);};
    for(let index=0;index+2<indices.length;index+=3) {
      const a=coordinateKeys[indices[index]],b=coordinateKeys[indices[index+1]],c=coordinateKeys[indices[index+2]];
      if(a&&b&&c){union(a,b);union(b,c);}
    }
    const verticesByRoot = new Map<string, Set<number>>();
    vertexIndicesByKey.forEach((vertices,key)=>{
      const root=findRoot(key),list=verticesByRoot.get(root)??new Set<number>();
      vertices.forEach(vertex=>list.add(vertex));verticesByRoot.set(root,list);
    });
    return [...verticesByRoot.values()].map(vertices=>[...vertices].sort((a,b)=>a-b)).sort((a,b)=>a[0]-b[0]);
  }
}`;
const Runtime = variant => compileAsset(variant ? createAssetRevision(source, variant) : source).classes.ParametricModelRuntimeComponent;

test('节点候选保持scene原顺序和去重；创建/重挂接/销毁在下一次调用立即生效', () => {
  const engine=new B.NullEngine(),scene=new B.Scene(engine);
  try {
    const child=new B.TransformNode('child-created-first',scene),root=new B.TransformNode('root',scene);
    const outsider=new B.TransformNode('outside',scene),grandchild=new B.TransformNode('grandchild',scene);
    child.parent=root;grandchild.parent=child;
    const original=new (Runtime())(root),candidate=new (Runtime('nodes'))(root);
    assert.deepEqual(candidate.getModelNodes(),[root,child,grandchild]);
    assert.deepEqual(candidate.getModelNodes(),original.getModelNodes());
    outsider.parent=child;
    assert.deepEqual(candidate.getModelNodes(),[root,child,outsider,grandchild]);
    child.parent=null; outsider.parent=root;
    assert.deepEqual(candidate.getModelNodes(),[root,outsider]);
    const later=new B.TransformNode('later',scene);later.parent=outsider;
    assert.deepEqual(candidate.getModelNodes(),[root,outsider,later]);
    later.dispose();assert.deepEqual(candidate.getModelNodes(),original.getModelNodes());
  } finally {scene.dispose();engine.dispose();}
});

test('节点方法或parent定制时回退原扫描，getter与故意副作用不被快路径吃掉', () => {
  for(const customization of ['method','getter','parent']) {
    const engine=new B.NullEngine(),scene=new B.Scene(engine);
    let customized;
    try {
      const root=new B.TransformNode('root',scene),outside=new B.TransformNode('outside',scene);
      customized=outside;
      const original=new (Runtime())(root),candidate=new (Runtime('nodes'))(root);
      let calls=0;
      if(customization==='method') outside.isDescendantOf=ancestor=>{calls++;return ancestor===root;};
      else if(customization==='getter') Object.defineProperty(outside,'isDescendantOf',{configurable:true,get(){calls++;return ancestor=>ancestor===root;}});
      else Object.defineProperty(outside,'parent',{configurable:true,get(){calls++;return root;}});
      calls=0;const before=original.getModelNodes(),count=calls;
      calls=0;const after=candidate.getModelNodes();
      assert.deepEqual(after,before);assert.equal(calls,count,customization+'有意副作用次数');
    } finally { if(customized){delete customized.parent;delete customized.isDescendantOf;}scene.dispose();engine.dispose();}
  }
});

test('未知节点与自定义方法异常保留原异常对象，候选不吞错', () => {
  const error=new Error('original-node-error');
  const root={getScene:()=>({transformNodes:[{isDescendantOf(){throw error;}}],meshes:[]})};
  for(const variant of [null,'nodes']) assert.throws(()=>new (Runtime(variant))(root).getModelNodes(),actual=>actual===error);
});

/** 与候选不同的邻接图/BFS oracle：先按原五位小数焊接，再求无向连通集。 */
function graphOracle(positions,indices) {
  const keys=Array.from({length:positions.length/3},(_,index)=>positions.slice(index*3,index*3+3).map(value=>value.toFixed(5)).join(','));
  const graph=new Map(keys.map(key=>[key,new Set()]));
  for(let index=0;index+2<indices.length;index+=3) {
    const triangle=indices.slice(index,index+3).map(vertex=>keys[vertex]);
    if(triangle.some(key=>!key))continue;
    for(const a of triangle)for(const b of triangle)graph.get(a).add(b);
  }
  const seen=new Set(),groups=[];
  for(const key of graph.keys()) {
    if(seen.has(key))continue;
    const connected=new Set(),pending=[key];
    while(pending.length){const next=pending.pop();if(seen.has(next))continue;seen.add(next);connected.add(next);pending.push(...graph.get(next));}
    groups.push(keys.map((key,index)=>connected.has(key)?index:null).filter(index=>index!==null));
  }
  return groups.sort((a,b)=>a[0]-b[0]);
}

test('整数连通内核通过固定随机图/BFS oracle，保留五位焊接与无效三角形规则', () => {
  const original=new (Runtime())(null),kernel=new (Runtime('kernel'))(null),combined=new (Runtime('both'))(null);
  let seed=0x5a17c0de;
  const random=()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return (seed>>>0)/2**32;};
  for(let round=0;round<32;round++) {
    const positions=Array.from({length:72},()=>Math.floor(random()*12)/10);
    positions.splice(0,9,0,-0,Infinity,0,0,Infinity,NaN,0,1);
    const indices=Array.from({length:60},()=>Math.floor(random()*28));
    const expected=graphOracle(positions,indices);
    assert.deepEqual(original.getMeshComponents({positions,indices}),expected);
    assert.deepEqual(kernel.getMeshComponents({positions,indices}),expected);
    assert.deepEqual(combined.getMeshComponents({positions,indices}),expected);
  }
});

test('转换器拒绝未知变体和漂移内核，不猜测替换其它代码', () => {
  assert.throws(()=>createAssetRevision(source,'other'),/未知/);
  assert.throws(()=>createAssetRevision(source.replace('const parents = new Map<string, string>();','const originalParents = new Map();'),'kernel'),/漂移/);
  assert.equal(createAssetRevision(source,'nodes').includes('private getMeshComponents'),true);
});
