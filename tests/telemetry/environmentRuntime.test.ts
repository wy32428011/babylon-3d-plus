import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ArcRotateCamera,
  AssetContainer,
  MeshBuilder,
  NullEngine,
  Scene,
  StandardMaterial,
  Vector3,
} from '@babylonjs/core';

import { SceneEnvironmentRuntime } from '../../src/runtime/babylon/SceneEnvironmentRuntime';
import { focusArcRotateCameraOnBounds } from '../../src/runtime/babylon/createEngine';
import type { SceneEnvironmentSettings } from '../../src/editor/model/SceneDocument';

function createEnvironment(sourceUrl: string): SceneEnvironmentSettings {
  return {
    packagePath: 'C:/project/Assets/Environments/factory',
    lengthUnit: 'meter',
    unitScaleToMeters: 1,
    displayName: '测试厂区',
    fileSizeBytes: 1024,
    placementMode: 'scene-base',
    transform: {
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: 1,
    },
    visible: true,
    opacity: 1,
    activeVariantUrl: sourceUrl,
    variants: [{
      name: '默认预设',
      sourcePath: sourceUrl.replace('editor-asset://local/', 'C:/project/'),
      sourceUrl,
    }],
  };
}

function createBoxContainer(scene: Scene, name: string): AssetContainer {
  const container = new AssetContainer(scene);
  const mesh = MeshBuilder.CreateBox(name, { width: 10, height: 6, depth: 8 }, scene);
  mesh.position.set(20, 3, -4);
  const material = new StandardMaterial(`${name}-material`, scene);
  mesh.material = material;
  scene.removeMesh(mesh);
  scene.removeMaterial(material);
  container.meshes.push(mesh);
  container.materials.push(material);
  return container;
}

test('环境聚焦移动高差较大的 Target 时保持 ArcRotate 观察方向', () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const camera = new ArcRotateCamera('camera', Math.PI / 4, Math.PI * 0.43, 28, Vector3.Zero(), scene);
  const alpha = camera.alpha;
  const beta = camera.beta;

  try {
    focusArcRotateCameraOnBounds(camera, engine, {
      center: { x: 0, y: 2800, z: 0 },
      radiusMeters: 3700,
    }, Number.POSITIVE_INFINITY, false);
    assert.equal(camera.alpha, alpha);
    assert.equal(camera.beta, beta);
    assert.ok(camera.radius > 5000, '环境聚焦应按完整包围盒取景，不能应用 3m 上限');
    camera.getViewMatrix(true);
    assert.ok(camera.position.y > camera.target.y, '保持上方视角，不能翻到地面下方');
  } finally {
    scene.dispose();
    engine.dispose();
  }
});

test('环境运行时自动居中落地，并在候选加载失败时保留当前有效环境', async () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const sourceA = 'editor-asset://local/environment-a.glb';
  const sourceB = 'editor-asset://local/environment-b.glb';
  let rejectSourceB: (reason?: unknown) => void = () => {
    throw new Error('环境 B 的拒绝函数尚未初始化。');
  };
  const runtime = new SceneEnvironmentRuntime(scene, {
    resolveAssetUrl: (sourceUrl) => sourceUrl,
    loadAssetContainer: async (_rootUrl, fileName) => {
      if (fileName.includes('environment-a.glb')) return createBoxContainer(scene, 'environment-a');
      return new Promise<AssetContainer>((_resolve, reject) => {
        rejectSourceB = reject;
      });
    },
  });

  try {
    const appliedA = await runtime.apply(createEnvironment(sourceA), {
      requestId: 'request-a',
      autoAlign: true,
    });
    assert.deepEqual(appliedA.environment.transform.position, { x: -20, y: 0, z: 4 });
    const currentTarget = runtime.getGizmoTarget();
    assert.ok(currentTarget);
    assert.equal(appliedA.snapshot.phase, 'ready');
    assert.deepEqual(appliedA.snapshot.bounds?.sizeMeters, { x: 10, y: 6, z: 8 });

    const pendingB = runtime.apply(createEnvironment(sourceB), {
      requestId: 'request-b',
      autoAlign: true,
    });
    await Promise.resolve();
    assert.equal(runtime.getGizmoTarget(), currentTarget, '候选环境加载时旧环境必须继续作为当前环境');

    rejectSourceB(new Error('模拟环境加载失败'));
    await assert.rejects(pendingB, /模拟环境加载失败/);
    assert.equal(runtime.getGizmoTarget(), currentTarget, '加载失败后旧环境必须保持有效');
  } finally {
    runtime.dispose();
    scene.dispose();
    engine.dispose();
  }
});

test('后续权威环境取消活动候选后释放迟到的 AssetContainer', async () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const sourceA = 'editor-asset://local/environment-current.glb';
  const sourceB = 'editor-asset://local/environment-candidate.glb';
  let resolveCandidate: (container: AssetContainer) => void = () => {
    throw new Error('候选环境尚未开始加载。');
  };
  let markCandidateStarted: () => void = () => undefined;
  const candidateStarted = new Promise<void>((resolve) => {
    markCandidateStarted = resolve;
  });
  const runtime = new SceneEnvironmentRuntime(scene, {
    resolveAssetUrl: (sourceUrl) => sourceUrl,
    loadAssetContainer: async (_rootUrl, fileName) => {
      if (fileName.includes('environment-current.glb')) return createBoxContainer(scene, 'environment-current');
      return new Promise<AssetContainer>((resolve) => {
        resolveCandidate = resolve;
        markCandidateStarted();
      });
    },
  });

  try {
    const appliedCurrent = await runtime.apply(createEnvironment(sourceA), {
      requestId: 'request-current',
      autoAlign: true,
    });
    const currentTarget = runtime.getGizmoTarget();
    assert.ok(currentTarget);

    const pendingCandidate = runtime.apply(createEnvironment(sourceB), {
      requestId: 'request-candidate',
      autoAlign: true,
    });
    await candidateStarted;
    await runtime.apply(appliedCurrent.environment, { requestId: null, autoAlign: false });

    const candidateContainer = createBoxContainer(scene, 'environment-candidate');
    const candidateMesh = candidateContainer.meshes[0];
    resolveCandidate(candidateContainer);
    await assert.rejects(
      pendingCandidate,
      (error: unknown) => error instanceof Error && error.name === 'AbortError',
    );
    assert.equal(candidateMesh.isDisposed(), true, '迟到的候选 Mesh 必须随 AssetContainer 一并释放');
    assert.equal(runtime.getGizmoTarget(), currentTarget, '取消候选不能替换当前有效环境');
  } finally {
    runtime.dispose();
    scene.dispose();
    engine.dispose();
  }
});

test('旧版左侧环境修改显示属性后保持兼容摆放偏移', async () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const sourceUrl = 'editor-asset://local/legacy-environment.glb';
  const runtime = new SceneEnvironmentRuntime(scene, {
    resolveAssetUrl: (sourceUrl) => sourceUrl,
    loadAssetContainer: async () => createBoxContainer(scene, 'legacy-environment'),
  });

  try {
    const legacyEnvironment = {
      ...createEnvironment(sourceUrl),
      placementMode: 'legacy-left' as const,
    };
    await runtime.apply(legacyEnvironment, { requestId: null, autoAlign: false });
    const target = scene.getTransformNodeByName('EnvironmentRoot_1');
    assert.ok(target);
    assert.deepEqual(
      { x: target.position.x, y: target.position.y, z: target.position.z },
      { x: -27, y: 0, z: 4 },
    );

    await runtime.apply({ ...legacyEnvironment, opacity: 0.4 }, { requestId: null, autoAlign: false });
    assert.deepEqual(
      { x: target.position.x, y: target.position.y, z: target.position.z },
      { x: -27, y: 0, z: 4 },
    );
  } finally {
    runtime.dispose();
    scene.dispose();
    engine.dispose();
  }
});

test('同一环境的透明度和显隐更新不重新加载资源，并进入无深度写入的幽灵显示', async () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const sourceUrl = 'editor-asset://local/environment.glb';
  let loadCount = 0;
  const runtime = new SceneEnvironmentRuntime(scene, {
    resolveAssetUrl: (sourceUrl) => sourceUrl,
    loadAssetContainer: async () => {
      loadCount += 1;
      return createBoxContainer(scene, 'environment');
    },
  });

  try {
    const initial = await runtime.apply(createEnvironment(sourceUrl), {
      requestId: 'request-initial',
      autoAlign: true,
    });
    const target = runtime.getGizmoTarget();
    assert.ok(target);
    const material = scene.getMaterialByName('environment-material') as StandardMaterial;
    assert.ok(material);

    const ghostResult = await runtime.apply({ ...initial.environment, opacity: 0.25 }, {
      requestId: null,
      autoAlign: false,
    });
    assert.equal(loadCount, 1);
    assert.equal(runtime.getGizmoTarget(), target);
    assert.equal(ghostResult.snapshot.bounds, initial.snapshot.bounds, '纯显示更新不应重复扫描环境包围盒');
    assert.equal(ghostResult.snapshot.statistics, initial.snapshot.statistics, '纯显示更新不应重复统计环境几何');
    assert.equal(material.alpha, 0.25);
    assert.equal(material.disableDepthWrite, true);

    await runtime.apply({ ...initial.environment, opacity: 0 }, {
      requestId: null,
      autoAlign: false,
    });
    runtime.setAdjustmentActive(true);
    await runtime.apply({ ...initial.environment, opacity: 0.25 }, {
      requestId: null,
      autoAlign: false,
    });
    assert.equal(
      scene.getMeshByName('__environmentAdjustmentBounds'),
      null,
      '完全透明时的调整请求不能在重新显示后潜伏生效',
    );

    await runtime.apply({ ...initial.environment, visible: false }, {
      requestId: null,
      autoAlign: false,
    });
    assert.equal(target.isEnabled(), false);
  } finally {
    runtime.dispose();
    scene.dispose();
    engine.dispose();
  }
});
