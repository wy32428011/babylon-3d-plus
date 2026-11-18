import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { NullEngine, Scene, TransformNode, Vector3 } from '@babylonjs/core';
import {
  createInspectionAssemblyController,
  type InspectionAssemblyGroup,
} from '../../src/inspection/inspectionAssembly.ts';
import { toDetailParts } from '../../src/inspection/inspectionParts.ts';

function fixture(t: TestContext) {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const root = new TransformNode('model', scene);
  t.after(() => {
    scene.dispose();
    engine.dispose();
  });
  return { scene, root };
}

function child(parent: TransformNode, name: string, x = 0, y = 0, z = 0) {
  const node = new TransformNode(name, parent.getScene());
  node.parent = parent;
  node.position.set(x, y, z);
  return node;
}

function world(node: TransformNode) {
  return node.computeWorldMatrix(true).getTranslation();
}

function close(actual: Vector3, expected: Vector3, message = '') {
  assert.ok(
    Vector3.Distance(actual, expected) < 1e-5,
    `${message}: expected ${expected.asArray()}, got ${actual.asArray()}`,
  );
}

const offset = (x: number, y = 0, z = 0) => ({ x, y, z });

test('part list follows its parent hierarchy regardless of manifest order', () => {
  const part = (partKey: string, parentPartKey?: string) => ({
    partKey, name: partKey, nodePath: partKey, ...(parentPartKey ? { parentPartKey } : {}),
    axis: offset(1), distanceMeters: 0, fixed: false,
  });
  const parts = [part('motor', 'drive'), part('base'), part('shaft', 'motor'),
    part('drive'), part('foot', 'base')];
  assert.deepEqual(toDetailParts(parts), [
    { partKey: 'base', name: 'base', depth: 0 },
    { partKey: 'foot', name: 'foot', depth: 1 },
    { partKey: 'drive', name: 'drive', depth: 0 },
    { partKey: 'motor', name: 'motor', depth: 1 },
    { partKey: 'shaft', name: 'shaft', depth: 2 },
  ]);
  assert.throws(() => toDetailParts([part('orphan', 'missing')]), /父零件不存在/);
  assert.throws(() => toDetailParts([part('a', 'b'), part('b', 'a')]), /存在循环/);
  assert.throws(() => toDetailParts([part('a'), part('a')]), /零件标识重复/);
});

test('progress is absolute from the captured pose, including repeats, reset and disposal', (t) => {
  const { root } = fixture(t);
  const first = child(root, 'first', 2, -3, 4);
  const second = child(root, 'second', -1, 6, 2);
  let changes = 0;
  const displacement = offset(4, -2, 6);
  const controller = createInspectionAssemblyController({
    root,
    groups: [{ id: 'assembly', nodes: [first, second], worldOffset: displacement }],
    onChange: () => {
      changes += 1;
    },
  });
  displacement.x = 999; // Input is captured; later caller mutations do not change the motion.
  controller.setPercent(100);
  close(first.position, new Vector3(6, -5, 10));
  close(second.position, new Vector3(3, 4, 8));
  controller.setPercent(50);
  close(first.position, new Vector3(4, -4, 7));
  controller.setPercent(50);
  close(first.position, new Vector3(4, -4, 7));
  assert.equal(changes, 2);
  assert.equal(controller.percent, 50);
  controller.reset();
  close(first.position, new Vector3(2, -3, 4));
  close(second.position, new Vector3(-1, 6, 2));
  assert.equal(controller.percent, 0);
  controller.setPercent(25);
  controller.dispose();
  controller.dispose();
  close(first.position, new Vector3(2, -3, 4));
  assert.equal(changes, 5);
  assert.throws(() => controller.setPercent(1), /disposed/);
  assert.throws(() => controller.reset(), /disposed/);
});

test('configured parent owns its branch, including when the model root is configured', (t) => {
  const { root } = fixture(t);
  const part = child(root, 'part', 1, 0, 0);
  const nested = child(part, 'nested', 2, 0, 0);
  const rootStart = world(root);
  const partStart = world(part);
  const nestedStart = world(nested);
  const controller = createInspectionAssemblyController({
    root,
    groups: [
      { id: 'child first', nodes: [part], worldOffset: offset(30) },
      { id: 'nested', nodes: [nested], worldOffset: offset(60) },
      { id: 'root', nodes: [root], worldOffset: offset(5) },
    ],
  });
  controller.setPercent(100);
  close(world(root).subtract(rootStart), new Vector3(5, 0, 0));
  close(world(part).subtract(partStart), new Vector3(5, 0, 0));
  close(world(nested).subtract(nestedStart), new Vector3(5, 0, 0));
  close(part.position, new Vector3(1, 0, 0));
  close(nested.position, new Vector3(2, 0, 0));
  controller.dispose();
  close(world(nested), nestedStart);
});

test('a fixed ancestor fixes its entire configured branch, while other groups move', (t) => {
  const { root } = fixture(t);
  const fixed = child(root, 'fixed');
  const descendant = child(fixed, 'descendant', 2);
  const fixedGrandchild = child(descendant, 'fixed grandchild', 1);
  const moving = child(root, 'moving');
  const start = world(descendant);
  const controller = createInspectionAssemblyController({
    root,
    groups: [
      { id: 'suppressed', nodes: [descendant], worldOffset: offset(20) },
      { id: 'fixed', nodes: [fixed], fixed: true },
      { id: 'fixed grandchild', nodes: [fixedGrandchild], fixed: true },
      { id: 'moving', nodes: [moving], worldOffset: offset(3) },
    ],
  });
  controller.setPercent(100);
  close(world(descendant), start);
  close(moving.position, new Vector3(3, 0, 0));
  controller.dispose();

  const fixedRoot = createInspectionAssemblyController({
    root,
    groups: [
      { id: 'root', nodes: [root], fixed: true },
      { id: 'moving', nodes: [moving], worldOffset: offset(3) },
    ],
  });
  fixedRoot.setPercent(100);
  close(moving.position, Vector3.Zero());
  fixedRoot.dispose();
});

test('fixed descendant under a movable group is rejected without taking ownership', (t) => {
  const { root } = fixture(t);
  const parent = child(root, 'parent');
  const fixed = child(parent, 'fixed');
  assert.throws(
    () =>
      createInspectionAssemblyController({
        root,
        groups: [
          { id: 'parent', nodes: [parent], worldOffset: offset(2) },
          { id: 'fixed', nodes: [fixed], fixed: true },
        ],
      }),
    /fixed.*movable/i,
  );
  const controller = createInspectionAssemblyController({
    root,
    groups: [{ id: 'parent', nodes: [parent], worldOffset: offset(2) }],
  });
  controller.setPercent(100);
  close(world(fixed), new Vector3(2, 0, 0));
  controller.dispose();
});

test('world displacement survives rotated, nonuniform and negative parent scaling', (t) => {
  const { root } = fixture(t);
  root.position.set(5, -1, 8);
  root.rotation.set(0.3, -0.4, 0.7);
  root.scaling.set(-2, 3, 0.5);
  const parent = child(root, 'parent', 1, 2, -3);
  parent.rotation.set(-0.4, 0.6, 0.2);
  parent.scaling.set(1.5, 0.75, 2);
  const part = child(parent, 'part', 3, -1, 2);
  const reference = child(parent, 'reference', 3, -1, 2);
  const vector = new Vector3(4, -3, 7);
  const controller = createInspectionAssemblyController({
    root,
    groups: [{ id: 'part', nodes: [part], worldOffset: vector }],
  });
  for (const percent of [100, 35, 100, 0]) {
    controller.setPercent(percent);
    close(
      world(part).subtract(world(reference)),
      vector.scale(percent / 100),
      `progress ${percent}`,
    );
  }
  // Conversion is recomputed when an unowned parent changes its orientation or scale.
  parent.rotation.y += 0.8;
  parent.scaling.x = 0.4;
  controller.setPercent(100);
  close(world(part).subtract(world(reference)), vector);
  controller.dispose();
  close(part.position, new Vector3(3, -1, 2));
});

test('all 160 groups move and restore; no legacy 128-group truncation', (t) => {
  const { root } = fixture(t);
  const parts = Array.from({ length: 160 }, (_, index) => child(root, `part-${index}`, index));
  const groups = parts.map((node, index) => ({
    id: `group-${index}`,
    nodes: [node],
    worldOffset: offset(index + 1, 2, -3),
  }));
  const controller = createInspectionAssemblyController({ root, groups });
  controller.setPercent(100);
  for (const [index, node] of parts.entries()) {
    close(node.position, new Vector3(index * 2 + 1, 2, -3), `group ${index}`);
  }
  controller.reset();
  for (const [index, node] of parts.entries()) close(node.position, new Vector3(index, 0, 0));
  controller.dispose();
});

test('invalid groups, duplicate IDs and repeated node identities fail explicitly', (t) => {
  const { scene, root } = fixture(t);
  const part = child(root, 'part');
  const outside = new TransformNode('outside', scene);
  const good = { id: 'ok', nodes: [part], worldOffset: offset(1) };
  const cases: { groups: InspectionAssemblyGroup[]; error: RegExp }[] = [
    { groups: [], error: /at least one group/ },
    { groups: [{ ...good, id: ' ' }], error: /group id/ },
    { groups: [good, { ...good, id: ' ok ' }], error: /duplicate.*id/i },
    { groups: [good, { ...good, id: 'other' }], error: /duplicate.*node/i },
    { groups: [{ ...good, nodes: [part, part] }], error: /duplicate.*node/i },
    { groups: [{ ...good, nodes: [] }], error: /at least one node/ },
    { groups: [{ ...good, nodes: [outside] }], error: /outside.*root/ },
    { groups: [{ ...good, worldOffset: offset(NaN) }], error: /finite.*worldOffset/ },
    { groups: [{ ...good, fixed: true, worldOffset: null as never }], error: /worldOffset/ },
    { groups: [{ ...good, fixed: 'yes' as never }], error: /fixed.*boolean/ },
    { groups: [{ id: 'missing', nodes: [part] }], error: /worldOffset/ },
  ];
  for (const { groups, error } of cases) {
    assert.throws(() => createInspectionAssemblyController({ root, groups }), error);
    close(part.position, Vector3.Zero());
  }
  const controller = createInspectionAssemblyController({ root, groups: [good] });
  for (const invalid of [-1, 101, NaN, Infinity, '50']) {
    assert.throws(() => controller.setPercent(invalid as number), /between 0 and 100/);
    assert.equal(controller.percent, 0);
    close(part.position, Vector3.Zero());
  }
  controller.dispose();
});

test('singular parent matrices are rejected, and failed updates never partially move groups', (t) => {
  const { root } = fixture(t);
  const normal = child(root, 'normal', 1);
  const scaled = child(root, 'scaled');
  const part = child(scaled, 'part', 2);
  const groups = [
    { id: 'normal', nodes: [normal], worldOffset: offset(4) },
    { id: 'scaled', nodes: [part], worldOffset: offset(2) },
  ];
  scaled.scaling.x = 0;
  assert.throws(() => createInspectionAssemblyController({ root, groups }), /singular/);
  scaled.scaling.x = 1;
  const controller = createInspectionAssemblyController({ root, groups });
  controller.setPercent(50);
  close(normal.position, new Vector3(3, 0, 0));
  close(part.position, new Vector3(3, 0, 0));
  scaled.scaling.x = 0;
  assert.throws(() => controller.setPercent(100), /singular/);
  assert.equal(controller.percent, 50);
  close(normal.position, new Vector3(3, 0, 0));
  close(part.position, new Vector3(3, 0, 0));
  controller.reset(); // A return to the local baseline does not require an inverse matrix.
  close(normal.position, new Vector3(1, 0, 0));
  close(part.position, new Vector3(2, 0, 0));
  controller.dispose();
});

test('controllers for different models remain isolated and overlapping branches are rejected', (t) => {
  const { root } = fixture(t);
  const modelA = child(root, 'model A');
  const modelB = child(root, 'model B');
  const partA = child(modelA, 'A', 1);
  const partB = child(modelB, 'B', 10);
  const a = createInspectionAssemblyController({
    root: modelA,
    groups: [{ id: 'A', nodes: [partA], worldOffset: offset(3) }],
  });
  const b = createInspectionAssemblyController({
    root: modelB,
    groups: [{ id: 'B', nodes: [partB], worldOffset: offset(-4) }],
  });
  a.setPercent(100);
  b.setPercent(100);
  assert.throws(
    () =>
      createInspectionAssemblyController({
        root: modelA,
        groups: [{ id: 'ancestor', nodes: [modelA], worldOffset: offset(2) }],
      }),
    /already owned/,
  );
  assert.throws(
    () =>
      createInspectionAssemblyController({
        root: modelA,
        groups: [{ id: 'same', nodes: [partA], worldOffset: offset(2) }],
      }),
    /already owned/,
  );
  a.dispose();
  close(partA.position, new Vector3(1, 0, 0));
  close(partB.position, new Vector3(6, 0, 0));
  assert.equal(b.percent, 100);
  const replacement = createInspectionAssemblyController({
    root: modelA,
    groups: [{ id: 'ancestor', nodes: [modelA], worldOffset: offset(2) }],
  });
  replacement.dispose();
  b.dispose();
  close(partB.position, new Vector3(10, 0, 0));
});

test('reparented and disposed nodes fail safely; disposal releases the original ownership path', (t) => {
  const { root } = fixture(t);
  const parent = child(root, 'parent');
  const other = child(root, 'other');
  const part = child(parent, 'part', 2);
  const controller = createInspectionAssemblyController({
    root,
    groups: [{ id: 'part', nodes: [part], worldOffset: offset(4) }],
  });
  controller.setPercent(100);
  part.parent = other;
  assert.throws(() => controller.setPercent(50), /hierarchy changed/);
  controller.dispose();
  close(part.position, new Vector3(2, 0, 0));
  const replacement = createInspectionAssemblyController({
    root,
    groups: [{ id: 'parent', nodes: [parent], worldOffset: offset(1) }],
  });
  replacement.dispose();

  const disposed = createInspectionAssemblyController({
    root,
    groups: [{ id: 'part', nodes: [part], worldOffset: offset(1) }],
  });
  part.dispose();
  assert.throws(() => disposed.setPercent(20), /disposed/);
  assert.doesNotThrow(() => disposed.dispose());
  const last = createInspectionAssemblyController({
    root,
    groups: [{ id: 'other', nodes: [other], worldOffset: offset(1) }],
  });
  last.dispose();
});

test('non-finite baseline and frozen motion targets are rejected', (t) => {
  const { root } = fixture(t);
  const part = child(root, 'part');
  const groups = [{ id: 'part', nodes: [part], worldOffset: offset(1) }];
  part.position.x = Infinity;
  assert.throws(() => createInspectionAssemblyController({ root, groups }), /non-finite baseline/);
  part.position.x = 0;
  part.scaling.y = NaN;
  assert.throws(() => createInspectionAssemblyController({ root, groups }), /non-finite transform/);
  part.scaling.y = 1;
  part.freezeWorldMatrix();
  assert.throws(() => createInspectionAssemblyController({ root, groups }), /frozen/);
  part.unfreezeWorldMatrix();
  const descendant = child(part, 'frozen descendant');
  descendant.freezeWorldMatrix();
  assert.throws(
    () => createInspectionAssemblyController({ root, groups }),
    /frozen descendant.*frozen/,
  );
  descendant.unfreezeWorldMatrix();
  const controller = createInspectionAssemblyController({ root, groups });
  controller.dispose();
});
