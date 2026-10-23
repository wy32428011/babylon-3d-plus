import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { AssetContainer, FreeCamera, MeshBuilder, NullEngine, Quaternion, Scene, TransformNode, Vector3 } from '@babylonjs/core';
import ts from 'typescript';

const projectRoot = new URL('../../', import.meta.url);
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('@babylonjs/core/') && !specifier.endsWith('.js')) return next(specifier + '.js', context);
    if (specifier.startsWith('.') && context.parentURL?.startsWith(projectRoot.href)) {
      const url = new URL(specifier, context.parentURL);
      if (!existsSync(url) && existsSync(new URL(url.href.replace(/\.js$/, '') + '.ts'))) return next(url.href.replace(/\.js$/, '') + '.ts', context);
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith(projectRoot.href) && /\.(png|jpg|webp|bin)(\?.*)?$/.test(url)) return {
      format: 'module', shortCircuit: true, source: 'export default ' + JSON.stringify(url) + ';',
    };
    if (url.startsWith(projectRoot.href) && url.endsWith('.ts')) return {
      format: 'module', shortCircuit: true,
      source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
      }).outputText,
    };
    return next(url, context);
  },
});
const { TransformGizmoController } = await import('../../src/runtime/babylon/TransformGizmoController.ts');
const { createEmptySceneDocument, createMeshEntity } = await import('../../src/editor/model/SceneDocument.ts');
const { updateTransformCommand } = await import('../../src/editor/commands/entityCommands.ts');
const { createCommandHistory, executeCommand, undoCommand, redoCommand } = await import('../../src/editor/commands/CommandHistory.ts');
const { SceneEnvironmentRuntime } = await import('../../src/runtime/babylon/SceneEnvironmentRuntime.ts');
const { SceneRuntime } = await import('../../src/runtime/babylon/SceneRuntime.ts');
const { TransformPreviewStore, isTransformPreviewSessionValid } = await import('../../src/editor/store/transformPreviewStore.ts');
hooks.deregister();

function setup(t, overrides = {}) {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  new FreeCamera('camera', new Vector3(0, 5, -10), scene);
  const target = MeshBuilder.CreateBox('entity', { size: 1 }, scene);
  const previews = [], runtimePreviews = [], commits = [], cancellations = [];
  const controller = new TransformGizmoController(scene, {
    beginTransformDrag: () => true,
    cancelTransformDrag: (...args) => cancellations.push(args),
    previewTransform: (...args) => previews.push(args),
    previewRuntimeTransform: (...args) => runtimePreviews.push(args),
    commitTransform: (...args) => commits.push(args),
    previewEnvironmentTransform() {}, commitEnvironmentTransform() {},
    beginEntityArrayDrag: () => null,
    previewEntityArrayDrag() {}, completeEntityArrayDrag() {}, cancelEntityArrayDrag() {},
    ...overrides,
  });
  controller.attachToTarget(target, 'entity');
  t.after(() => { controller.dispose(); scene.dispose(); engine.dispose(); });
  return { controller, scene, target, previews, runtimePreviews, commits, cancellations };
}

test('1000 次单体节点预览在一秒内仅发布 59 次 Inspector 预览，dragEnd 只写一条可撤销命令', t => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const entity = createMeshEntity('box');
  entity.id = 'entity';
  const initial = { ...createEmptySceneDocument(), entityIds: ['entity'], entities: { entity } };
  let document = initial;
  let history = createCommandHistory();
  let commitCount = 0;
  const { controller, target, previews, runtimePreviews } = setup(t, {
    commitTransform(id, before, after) {
      commitCount++;
      ({ scene: document, history } = executeCommand(document, history, updateTransformCommand(id, before, after)));
    },
  });
  controller.beginDragSnapshot();
  for (now = 0; now < 1000; now++) {
    target.position.x = now / 10;
    controller.previewAttachedTransform();
    assert.equal(target.position.x, now / 10, '节点直接预览不等待 Inspector 发布');
  }
  assert.equal(previews.length, 59);
  assert.equal(runtimePreviews.length, 1000, '运行时保护快照每个指针事件更新，不随 Inspector 限频');
  assert.equal(document, initial, '整个拖拽过程保持场景文档身份不变');
  assert.equal(history.undoStack.length, 0);
  controller.commitActiveDrag();
  controller.commitActiveDrag();
  assert.equal(commitCount, 1);
  assert.equal(history.undoStack.length, 1);
  assert.equal(document.entities.entity.components.transform.position.x, 99.9);
  ({ scene: document, history } = undoCommand(document, history));
  assert.equal(document.entities.entity.components.transform.position.x, 0);
  ({ scene: document, history } = redoCommand(document, history));
  assert.equal(document.entities.entity.components.transform.position.x, 99.9);
});

test('取消、切工具、切坐标空间和换目标清理轻预览且不提交', t => {
  const { controller, target, scene, commits, cancellations, previews } = setup(t);
  const cancelActions = [
    () => controller.cancelActiveDrag(),
    () => controller.setTool('rotate'),
    () => controller.setTransformSpace('global'),
    () => controller.attachToTarget(new TransformNode('new-target', scene), 'other'),
  ];
  for (const cancel of cancelActions) {
    controller.attachToTarget(target, 'entity');
    controller.beginDragSnapshot();
    target.position.x = 8;
    controller.previewAttachedTransform();
    cancel();
    assert.equal(target.position.x, 0);
  }
  assert.equal(cancellations.length, 4);
  assert.equal(previews.length, 4, '取消不能通过文档 preview 回写 before');
  assert.equal(commits.length, 0);
});

test('目标删除、父节点变化和锁定失效都取消会话，迟到 dragEnd 无法提交', t => {
  let valid = true;
  const { controller, target, scene, commits, cancellations } = setup(t, { isTransformDragValid: () => valid });
  controller.beginDragSnapshot();
  target.parent = new TransformNode('new-parent', scene);
  controller.commitActiveDrag();
  controller.beginDragSnapshot();
  valid = false;
  controller.previewAttachedTransform();
  valid = true;
  controller.beginDragSnapshot();
  target.dispose();
  controller.previewAttachedTransform();
  controller.commitActiveDrag();
  assert.equal(cancellations.length, 3);
  assert.equal(commits.length, 0);
});

test('移动旋转缩放保留 Babylon local/world、四元数和吸附配置，并提交精确末帧', t => {
  const { controller, target, scene, commits } = setup(t);
  const parent = new TransformNode('parent', scene);
  parent.rotation.set(0.2, 0.5, -0.3);
  parent.scaling.set(2, 1.5, 0.7);
  target.parent = parent;
  controller.attachToTarget(target, 'entity');
  controller.setSnapSettings({ enabled: true, position: 0.5, rotationDegrees: 15, scale: 0.1 });
  assert.equal(controller.gizmoManager.gizmos.positionGizmo.snapDistance, 0.5);
  assert.equal(controller.gizmoManager.gizmos.rotationGizmo.snapDistance, Math.PI / 12);
  assert.equal(controller.gizmoManager.gizmos.scaleGizmo.snapDistance, 0.1);
  for (const [index, tool] of ['translate', 'rotate', 'scale'].entries()) {
    controller.setTool(tool);
    controller.setTransformSpace(index % 2 ? 'global' : 'local');
    controller.beginDragSnapshot();
    target.position.set(1 + index, 2, 3);
    target.rotationQuaternion = Quaternion.RotationYawPitchRoll(0.6, 0.2, -0.1);
    target.scaling.set(2, 3, 4);
    controller.previewAttachedTransform();
    target.position.x += 0.125;
    controller.commitActiveDrag();
    const after = commits.at(-1)[2];
    assert.equal(after.position.x, 1.125 + index);
    assert.deepEqual(after.scale, { x: 2, y: 3, z: 4 });
    assert.ok(Math.abs(after.rotation.y - 0.6) < 1e-6);
  }
  assert.equal(commits.length, 3);
});

test('会话被拒绝时不开始；未接入独立会话的旧调用保持原预览合同', t => {
  const rejected = setup(t, { beginTransformDrag: () => false });
  rejected.controller.beginDragSnapshot();
  rejected.controller.previewAttachedTransform();
  rejected.controller.commitActiveDrag();
  assert.equal(rejected.previews.length, 0);
  assert.equal(rejected.commits.length, 0);
  const legacy = setup(t, { beginTransformDrag: undefined });
  legacy.controller.beginDragSnapshot();
  for (let index = 0; index < 10; index++) legacy.controller.previewAttachedTransform();
  assert.equal(legacy.previews.length, 10);
});

test('取消回调恢复权威场景时，Controller 不再以旧快照覆盖恢复结果', t => {
  let target;
  const fixture = setup(t, { cancelTransformDrag() { target.position.x = 42; } });
  target = fixture.target;
  fixture.controller.beginDragSnapshot();
  target.position.x = 9;
  fixture.controller.cancelActiveDrag();
  assert.equal(target.position.x, 42);
});

test('环境只在放置及渲染就绪后冻结，调整、参数比例更新和资源替换刷新矩阵并释放旧副本', async t => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const containers = [];
  let releaseReady;
  let enteredReady;
  const entered = new Promise(resolve => { enteredReady = resolve; });
  const ready = new Promise(resolve => { releaseReady = resolve; });
  let first = true;
  const runtime = new SceneEnvironmentRuntime(scene, {
    resolveAssetUrl: url => url,
    async loadAssetContainer() {
      const container = new AssetContainer(scene);
      const root = new TransformNode(`imported-${containers.length}`, scene);
      const mesh = MeshBuilder.CreateBox(`environment-${containers.length}`, {}, scene);
      mesh.position.x = 2;
      mesh.parent = root;
      root.freezeWorldMatrix();
      mesh.freezeWorldMatrix();
      scene.removeMesh(mesh);
      scene.removeTransformNode(root);
      container.meshes.push(mesh);
      container.transformNodes.push(root);
      containers.push(container);
      return container;
    },
    async waitForRenderReady() {
      if (!first) return;
      first = false;
      enteredReady();
      await ready;
    },
  });
  t.after(() => { runtime.dispose(); scene.dispose(); engine.dispose(); });
  const settings = {
    packagePath: 'C:/fixture/environment', lengthUnit: 'meter', unitScaleToMeters: 1,
    displayName: '测试环境', placementMode: 'scene-base', visible: true, opacity: 1,
    transform: { position: { x: 5, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: 1 },
    activeVariantUrl: 'editor-asset://local/factory.glb',
    variants: [{ name: '默认', sourcePath: 'C:/fixture/environment/factory.glb', sourceUrl: 'editor-asset://local/factory.glb' }],
  };
  const pending = runtime.apply(settings, { requestId: 'first', autoAlign: false });
  await entered;
  const leaf = containers[0].meshes[0];
  assert.equal(leaf.isWorldMatrixFrozen, false);
  assert.equal(containers[0].transformNodes[0].isWorldMatrixFrozen, false, '导入源的旧冻结标记已解除');
  releaseReady();
  await pending;
  assert.equal(leaf.isWorldMatrixFrozen, true);
  assert.equal(runtime.getGizmoTarget().isWorldMatrixFrozen, false);
  assert.equal(leaf.getWorldMatrix().getTranslation().x, 7);
  runtime.setAdjustmentActive(true);
  assert.equal(leaf.isWorldMatrixFrozen, false);
  const moved = { ...settings, transform: { ...settings.transform, position: { x: 15, y: 0, z: 0 } } };
  await runtime.apply(moved, { requestId: 'moved', autoAlign: false });
  assert.equal(leaf.isWorldMatrixFrozen, false);
  runtime.setAdjustmentActive(false);
  assert.equal(leaf.isWorldMatrixFrozen, true);
  assert.equal(leaf.getWorldMatrix().getTranslation().x, 17);
  containers[0].transformNodes[0].position.x += 3;
  runtime.sync(moved);
  assert.equal(leaf.getWorldMatrix().getTranslation().x, 20, '同配置显式重同步也刷新父链');
  assert.equal(runtime.getSnapshot().bounds.center.x, 20);
  await runtime.apply({ ...moved, lengthUnit: 'centimeter', unitScaleToMeters: 0.01 }, { requestId: 'rescale', autoAlign: false });
  assert.equal(leaf.isDisposed(), true);
  const replacement = containers[1].meshes[0];
  assert.ok(Math.abs(replacement.getWorldMatrix().getTranslation().x - 15.02) < 1e-5);
  assert.equal(replacement.isWorldMatrixFrozen, true);
  runtime.clear();
  assert.equal(replacement.isDisposed(), true);
});

function setupRuntimePreview(t) {
  const engine = new NullEngine(), scene = new Scene(engine);
  new FreeCamera('preview-camera', new Vector3(0, 5, -10), scene);
  const runtime = new SceneRuntime(scene);
  const entity = createMeshEntity('box');
  entity.id = 'entity';
  const document = { ...createEmptySceneDocument(), selectedEntityId: 'entity', entityIds: ['entity'], entities: { entity } };
  runtime.sync(document, ['entity'], { modelArrayIdentityMode: 'visual' });
  t.after(() => { runtime.endSingleTransformPreview(); runtime.dispose(); scene.dispose(); engine.dispose(); });
  return { scene, runtime, document, target: runtime.getGizmoTargetByEntityId('entity') };
}

test('真实 Runtime 同步保持 Controller 尚未发布的末帧，Inspector 仍可限频', t => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const { scene, runtime, document, target } = setupRuntimePreview(t);
  const previewStore = new TransformPreviewStore();
  const state = { sceneSessionId: 'runtime-session', scene: document, runtimeMode: 'edit' };
  let session;
  const controller = new TransformGizmoController(scene, {
    beginTransformDrag(entityId) {
      const before = document.entities[entityId].components.transform;
      if (!runtime.beginSingleTransformPreview(entityId, before)) return false;
      session = previewStore.begin(state.sceneSessionId, document, entityId, before);
      return true;
    },
    isTransformDragValid: () => Boolean(session && isTransformPreviewSessionValid(session, state)),
    previewRuntimeTransform(entityId, after) { runtime.updateSingleTransformPreview(entityId, after); },
    previewTransform(_entityId, after) { previewStore.publish(session, after); },
    commitTransform() {},
    cancelTransformDrag() { runtime.endSingleTransformPreview(); previewStore.clear(session); },
    previewEnvironmentTransform() {}, commitEnvironmentTransform() {}, beginEntityArrayDrag: () => null,
    previewEntityArrayDrag() {}, completeEntityArrayDrag() {}, cancelEntityArrayDrag() {},
  });
  t.after(() => controller.dispose());
  controller.attachToTarget(target, 'entity');
  controller.beginDragSnapshot();
  target.position.x = 1;
  controller.previewAttachedTransform();
  assert.equal(previewStore.getSnapshot().transform.position.x, 1);
  now = 1;
  target.position.x = 2;
  controller.previewAttachedTransform();
  assert.equal(previewStore.getSnapshot().transform.position.x, 1, 'Inspector 发布仍受 60Hz 限制');
  runtime.sync({ ...document, name: 'unrelated rename' }, ['entity'], { modelArrayIdentityMode: 'visual' });
  assert.equal(target.position.x, 2, '无关文档同步不得把 Babylon 未发布末帧回弹到旧预览');
  assert.equal(document.entities.entity.components.transform.position.x, 0);
});

test('真实 Runtime 自身派生的连续预览视图允许 after1 到 after2，持久输入保持原样', t => {
  const { runtime, document } = setupRuntimePreview(t);
  const before = document.entities.entity.components.transform;
  assert.equal(runtime.beginSingleTransformPreview('entity', before), true);
  const firstTransform = { ...before, position: { ...before.position, x: 1 } };
  runtime.updateSingleTransformPreview('entity', firstTransform);
  runtime.sync(document, ['entity'], { modelArrayIdentityMode: 'visual' });
  const firstView = runtime.document.shadowDocument;
  assert.equal(firstView.entities.entity.components.transform.position.x, 1);
  const secondTransform = { ...before, position: { ...before.position, x: 2 } };
  runtime.updateSingleTransformPreview('entity', secondTransform);
  runtime.sync(firstView, ['entity'], { modelArrayIdentityMode: 'visual' });
  const secondView = runtime.document.shadowDocument;
  assert.equal(secondView.entities.entity.components.transform.position.x, 2);
  assert.equal(document.entities.entity.components.transform.position.x, 0);
});

test('实际Runtime只接纳内建同步新observer，已有与后来脚本回调都保持保守门禁', t => {
  const { runtime, scene } = setupRuntimePreview(t);
  runtime.registerHostSceneObservers();
  assert.equal(runtime.telemetry.areMotionObserversControlled(), true);
  const early = scene.onBeforeRenderObservable.add(() => scene.getMeshByName('box'));
  assert.equal(runtime.telemetry.areMotionObserversControlled(), true, '渲染候选过滤保留早期脚本可查询原件');
  const unknown = scene.onBeforeDrawPhaseObservable.add(() => scene.getMeshByName('box'));
  assert.equal(runtime.telemetry.areMotionObserversControlled(), false);
  const known = runtime.withControlledSceneObservers(() => scene.onAfterDrawPhaseObservable.add(() => undefined));
  assert.equal(runtime.telemetry.areMotionObserversControlled(), false, '受控构造不能顺带接纳此前脚本observer');
  runtime.registerHostSceneObservers();
  assert.equal(runtime.telemetry.areMotionObserversControlled(), false, '宿主登记只执行一次');
  scene.onBeforeDrawPhaseObservable.remove(unknown);
  assert.equal(runtime.telemetry.areMotionObserversControlled(), true);
  const later = scene.onAfterActiveMeshesEvaluationObservable.add(() => scene.meshes.length);
  assert.equal(runtime.telemetry.areMotionObserversControlled(), false);
  scene.onAfterActiveMeshesEvaluationObservable.remove(later);
  scene.onBeforeRenderObservable.remove(early);
  scene.onAfterDrawPhaseObservable.remove(known);
  assert.equal(runtime.telemetry.areMotionObserversControlled(), true);
});
