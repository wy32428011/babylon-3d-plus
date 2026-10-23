import assert from 'node:assert/strict';
import test from 'node:test';

import { Matrix, MeshBuilder, Node, NullEngine, Scene, TransformNode, Vector3 } from '@babylonjs/core';

import { computeRootRelativeWorldMatrix, filterTopLevelMotionNodes, getMeshesWorldBottomCenter, getMeshWorldBounds } from '../../src/runtime/babylon/runtimeNodeGeometry';

test('getMeshWorldBounds 排除 thin instances 扩展，只返回 mesh 自身几何包围盒', () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  try {
    const mesh = MeshBuilder.CreateBox('box', { size: 2 }, scene);
    mesh.position.x = 10;
    // 远处挂一个实例：thinInstanceSetBuffer 会把 boundingInfo 重建为全部实例的并集（视锥剔除需要）。
    mesh.thinInstanceSetBuffer('matrix', new Float32Array(Matrix.Translation(1000, 0, 0).m), 16);
    assert.ok(mesh.thinInstanceCount > 0);

    const bounds = getMeshWorldBounds(mesh);
    assert.ok(bounds);
    assert.ok(
      Math.abs(bounds.minimum.x - 9) < 1e-6 && Math.abs(bounds.maximum.x - 11) < 1e-6,
      `包围盒必须只含 mesh 自身（[9, 11]），实际 [${bounds.minimum.x}, ${bounds.maximum.x}]`,
    );
  } finally {
    scene.dispose();
    engine.dispose();
  }
});

test('getMeshWorldBounds 对无 thin instances 的 mesh 保持原 boundingInfo 语义', () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  try {
    const mesh = MeshBuilder.CreateBox('box', { size: 2 }, scene);
    mesh.position.x = 10;
    const bounds = getMeshWorldBounds(mesh);
    assert.ok(bounds);
    assert.ok(Math.abs(bounds.minimum.x - 9) < 1e-6 && Math.abs(bounds.maximum.x - 11) < 1e-6);
  } finally {
    scene.dispose();
    engine.dispose();
  }
});

test('computeRootRelativeWorldMatrix 在双方均旋转时把源本地点映射到目标对应本地点', () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  try {
    const host = new TransformNode('host', scene);
    host.position = new Vector3(-0.01, 0, -7.24);
    host.rotation = new Vector3(0, -Math.PI / 2, 0);
    const proxy = new TransformNode('proxy', scene);
    proxy.position = new Vector3(-0.01, 0, -5.4);
    proxy.rotation = new Vector3(0, -Math.PI / 2, 0);

    const relative = computeRootRelativeWorldMatrix(host, proxy);
    assert.ok(relative);

    const localPoint = new Vector3(0, 0, 1);
    const hostWorldPoint = Vector3.TransformCoordinates(localPoint, host.getWorldMatrix());
    const mapped = Vector3.TransformCoordinates(hostWorldPoint, relative);
    const expected = Vector3.TransformCoordinates(localPoint, proxy.getWorldMatrix());
    assert.ok(
      Vector3.Distance(mapped, expected) < 1e-6,
      `映射结果必须命中代理对应本地点 (${expected})，实际 (${mapped})`,
    );
  } finally {
    scene.dispose();
    engine.dispose();
  }
});

test('getMeshesWorldBottomCenter 返回合并包围盒底部中心（x/z 中点、y 最低点）', () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  try {
    const box = MeshBuilder.CreateBox('box', { size: 2 }, scene);
    box.position = new Vector3(10, 5, -3);
    const bottomCenter = getMeshesWorldBottomCenter([box]);
    assert.ok(bottomCenter);
    assert.ok(Math.abs(bottomCenter.x - 10) < 1e-6, `x 应取包围盒中点 10，实际 ${bottomCenter.x}`);
    assert.ok(Math.abs(bottomCenter.y - 4) < 1e-6, `y 应取最低点 4，实际 ${bottomCenter.y}`);
    assert.ok(Math.abs(bottomCenter.z - (-3)) < 1e-6, `z 应取包围盒中点 -3，实际 ${bottomCenter.z}`);
  } finally {
    scene.dispose();
    engine.dispose();
  }
});

test('getMeshesWorldBottomCenter 合并多个 mesh 的包围盒，空数组返回 null', () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  try {
    assert.equal(getMeshesWorldBottomCenter([]), null);
    const boxA = MeshBuilder.CreateBox('a', { size: 1 }, scene);
    boxA.position = new Vector3(0, 0.5, 0); // y∈[0,1]
    const boxB = MeshBuilder.CreateBox('b', { size: 1 }, scene);
    boxB.position = new Vector3(4, 2.5, 0); // y∈[2,3]
    const bottomCenter = getMeshesWorldBottomCenter([boxA, boxB]);
    assert.ok(bottomCenter);
    assert.ok(Math.abs(bottomCenter.x - 2) < 1e-6, `合并 x 中点应为 2，实际 ${bottomCenter.x}`);
    assert.ok(Math.abs(bottomCenter.y - 0) < 1e-6, `合并 y 最低点应为 0，实际 ${bottomCenter.y}`);
  } finally {
    scene.dispose();
    engine.dispose();
  }
});

test('filterTopLevelMotionNodes 保持引用去重、输入顺序和跨层级父子过滤', () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  try {
    const root = new TransformNode('root', scene);
    const parent = new TransformNode('same-name', scene);
    parent.parent = root;
    const middle = new TransformNode('middle', scene);
    middle.parent = parent;
    const child = new TransformNode('child', scene);
    child.parent = middle;
    const sibling = new TransformNode('same-name', scene);
    sibling.parent = root;

    assert.deepEqual(filterTopLevelMotionNodes([]), []);
    assert.deepEqual(filterTopLevelMotionNodes([child, child]), [child]);
    assert.deepEqual(filterTopLevelMotionNodes([child, sibling, parent, sibling, child]), [sibling, parent]);
    assert.deepEqual(filterTopLevelMotionNodes([root, child, sibling, parent]), [root]);
  } finally {
    scene.dispose();
    engine.dispose();
  }
});

test('filterTopLevelMotionNodes 每次使用最新父级，重挂父级后仍只过滤当前后代', () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  try {
    const parent = new TransformNode('parent', scene);
    const child = new TransformNode('child', scene);
    const other = new TransformNode('other', scene);
    const nodes = [child, parent];
    child.parent = parent;
    assert.deepEqual(filterTopLevelMotionNodes(nodes), [parent]);
    child.parent = other;
    assert.deepEqual(filterTopLevelMotionNodes(nodes), [child, parent]);
    parent.parent = child;
    assert.deepEqual(filterTopLevelMotionNodes(nodes), [child]);
  } finally {
    scene.dispose();
    engine.dispose();
  }
});

test('filterTopLevelMotionNodes 保留节点自定义 isDescendantOf 的调用顺序和缺省方法语义', () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  try {
    const parent = new TransformNode('parent', scene);
    const child = new TransformNode('child', scene);
    child.parent = parent;
    const sibling = new TransformNode('sibling', scene);
    const calls: Node[] = [];
    child.isDescendantOf = (candidate: Node) => {
      calls.push(candidate);
      return candidate === sibling;
    };
    assert.deepEqual(filterTopLevelMotionNodes([parent, child, sibling]), [parent, sibling]);
    assert.deepEqual(calls, [parent, sibling]);

    Object.defineProperty(child, 'isDescendantOf', { configurable: true, value: undefined });
    assert.deepEqual(filterTopLevelMotionNodes([child, parent]), [child, parent]);
  } finally {
    scene.dispose();
    engine.dispose();
  }
});

test('filterTopLevelMotionNodes 保留原生节点通过祖先自定义方法判断后代的行为', () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  try {
    const customAncestor = new TransformNode('custom-ancestor', scene);
    const child = new TransformNode('child', scene);
    child.parent = customAncestor;
    const foreign = new TransformNode('foreign', scene);
    const calls: Node[] = [];
    customAncestor.isDescendantOf = (candidate: Node) => {
      calls.push(candidate);
      return candidate === foreign;
    };
    assert.deepEqual(filterTopLevelMotionNodes([child, foreign]), [foreign]);
    assert.deepEqual(calls, [foreign]);
    // 原生判断先检查直接父级引用，再调用该父级的方法。
    calls.length = 0;
    assert.deepEqual(filterTopLevelMotionNodes([child, customAncestor]), [customAncestor]);
    assert.deepEqual(calls, [child]);
  } finally {
    scene.dispose();
    engine.dispose();
  }
});

test('filterTopLevelMotionNodes 不额外求值脚本方法访问器，并兼容祖先方法的副作用顺序', () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  try {
    const parent = new TransformNode('parent', scene);
    const child = new TransformNode('child', scene);
    child.parent = parent;
    const foreign = new TransformNode('foreign', scene);
    let accessorReads = 0;
    Object.defineProperty(child, 'isDescendantOf', {
      configurable: true,
      get() {
        accessorReads += 1;
        return (candidate: Node) => candidate === foreign;
      },
    });
    assert.deepEqual(filterTopLevelMotionNodes([parent, child, foreign]), [parent, foreign]);
    assert.equal(accessorReads, 2);
    delete (child as Partial<TransformNode>).isDescendantOf;

    const calls: Node[] = [];
    parent.isDescendantOf = (candidate: Node) => {
      calls.push(candidate);
      return candidate === foreign;
    };
    assert.deepEqual(filterTopLevelMotionNodes([foreign, child, parent]), [foreign]);
    assert.deepEqual(calls, [foreign, foreign]);
  } finally {
    scene.dispose();
    engine.dispose();
  }
});

test('filterTopLevelMotionNodes 保留自定义 parent 访问器的次数与原异常', () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const parent = new TransformNode('parent', scene);
  const child = new TransformNode('child', scene);
  child.parent = parent;
  let reads = 0;
  try {
    Object.defineProperty(child, 'parent', { configurable: true, get() { reads += 1; return parent; } });
    assert.deepEqual(filterTopLevelMotionNodes([child, parent]), [parent]);
    assert.equal(reads, 2, '原生后代判断命中直接父级前会读取两次自定义访问器');
    reads = 0;
    Object.defineProperty(child, 'parent', { configurable: true, get() { reads += 1; return reads === 1 ? parent : null; } });
    assert.throws(() => filterTopLevelMotionNodes([child, parent]), TypeError);
    assert.equal(reads, 3, '父级在同一次后代判断中改变时保留原异常及求值顺序');
  } finally {
    delete (child as Partial<TransformNode>).parent;
    scene.dispose(); engine.dispose();
  }
});

test('filterTopLevelMotionNodes 保留原生 parent 下自定义 _parentNode 访问器的异常', () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const parent = new TransformNode('parent', scene);
  const child = new TransformNode('child', scene);
  child.parent = parent;
  const descriptor = Object.getOwnPropertyDescriptor(child, '_parentNode')!;
  let reads = 0;
  try {
    Object.defineProperty(child, '_parentNode', { configurable: true, get() { reads += 1; return reads === 1 ? parent : null; } });
    assert.throws(() => filterTopLevelMotionNodes([child, parent]), TypeError);
    assert.equal(reads, 3);
  } finally {
    Object.defineProperty(child, '_parentNode', descriptor);
    scene.dispose(); engine.dispose();
  }
});

test('filterTopLevelMotionNodes 保留后来覆盖原生 parent getter 的调用顺序', () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const parent = new TransformNode('parent', scene);
  const first = new TransformNode('first', scene);
  const second = new TransformNode('second', scene);
  first.parent = parent; second.parent = parent;
  const descriptor = Object.getOwnPropertyDescriptor(Node.prototype, 'parent')!;
  const reads: string[] = [];
  try {
    Object.defineProperty(Node.prototype, 'parent', { ...descriptor, get(this: Node) {
      reads.push(this.name); return descriptor.get!.call(this);
    } });
    assert.deepEqual(filterTopLevelMotionNodes([first, second]), [first, second]);
    assert.deepEqual(reads, ['first', 'first', 'first', 'parent', 'second', 'second', 'second', 'parent']);
  } finally {
    Object.defineProperty(Node.prototype, 'parent', descriptor);
    scene.dispose(); engine.dispose();
  }
});

test('filterTopLevelMotionNodes 保留后来覆盖原生 isDescendantOf 的调用顺序', () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const parent = new TransformNode('parent', scene);
  const child = new TransformNode('child', scene);
  child.parent = parent;
  const original = Node.prototype.isDescendantOf;
  const calls: Array<[Node, Node]> = [];
  try {
    Node.prototype.isDescendantOf = function (candidate) { calls.push([this, candidate]); return false; };
    assert.deepEqual(filterTopLevelMotionNodes([child, parent]), [child, parent]);
    assert.deepEqual(calls, [[child, parent], [parent, child]]);
  } finally {
    Node.prototype.isDescendantOf = original;
    scene.dispose(); engine.dispose();
  }
});

test('filterTopLevelMotionNodes 环形父级链仍按原候选判断短路而不永久循环', () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const first = new TransformNode('first', scene);
  const second = new TransformNode('second', scene);
  const firstParent = Object.getOwnPropertyDescriptor(first, '_parentNode')!;
  const secondParent = Object.getOwnPropertyDescriptor(second, '_parentNode')!;
  const originalHas = Set.prototype.has;
  let checks = 0;
  try {
    // 不经过会递归同步 enabled 的 setter，模拟脚本失败后残留的循环引用。
    Object.defineProperty(first, '_parentNode', { ...firstParent, value: second });
    Object.defineProperty(second, '_parentNode', { ...secondParent, value: first });
    Set.prototype.has = function (value) {
      // 让旧快路径以可诊断失败退出，避免回归测试本身卡死主线程。
      if (++checks > 20) throw new Error('循环祖先扫描超过安全预算');
      return originalHas.call(this, value);
    };
    let result: TransformNode[];
    try { result = filterTopLevelMotionNodes([first, second]); }
    finally { Set.prototype.has = originalHas; }
    assert.deepEqual(result, []);
  } finally {
    Set.prototype.has = originalHas;
    Object.defineProperty(first, '_parentNode', firstParent);
    Object.defineProperty(second, '_parentNode', secondParent);
    scene.dispose(); engine.dispose();
  }
});

test('filterTopLevelMotionNodes 大量原生同级节点不执行平方级候选判断', () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  try {
    const parent = new TransformNode('parent', scene);
    const nodes = Array.from({ length: 512 }, (_, index) => {
      const node = new TransformNode('part-' + index, scene);
      node.parent = parent;
      return node;
    });
    const originalSome = Array.prototype.some;
    let candidateChecks = 0;
    let result: TransformNode[];
    try {
      Array.prototype.some = function (callback, thisArg) {
        return originalSome.call(this, (value, index, array) => {
          candidateChecks += 1;
          return callback.call(thisArg, value, index, array);
        });
      };
      result = filterTopLevelMotionNodes(nodes);
    } finally { Array.prototype.some = originalSome; }
    assert.deepEqual(result, nodes);
    assert.ok(candidateChecks <= nodes.length * 4, '同级节点不应为每一对候选调用后代判断，实际检查 ' + candidateChecks + ' 次');
  } finally {
    scene.dispose();
    engine.dispose();
  }
});
