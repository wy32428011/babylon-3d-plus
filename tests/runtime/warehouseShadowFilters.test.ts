import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import ts from 'typescript';

const root = new URL('../../', import.meta.url);
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && context.parentURL?.startsWith(root.href)) {
      const candidate = new URL(specifier, context.parentURL);
      if (!existsSync(candidate) && existsSync(new URL(`${candidate.href}.ts`))) {
        return next(`${candidate.href}.ts`, context);
      }
      if (!existsSync(candidate) && candidate.href.endsWith('.js') && existsSync(new URL(candidate.href.replace(/\.js$/, '.ts')))) {
        return next(candidate.href.replace(/\.js$/, '.ts'), context);
      }
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith(root.href) && url.endsWith('.ts') && !url.includes('/node_modules/')) {
      return {
        format: 'module',
        shortCircuit: true,
        source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
          compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
        }).outputText,
      };
    }
    return next(url, context);
  },
});

const { resolveAutomaticShadowRole } = await import('../../src/runtime/babylon/warehouseShadowFilters.ts');
const { SceneSsaoRuntime } = await import('../../src/runtime/babylon/SceneSsaoRuntime.ts');
const { SceneAppearanceRuntime } = await import('../../src/runtime/babylon/SceneAppearanceRuntime.ts');
const { MobileBlobShadowRuntime } = await import('../../src/runtime/babylon/MobileBlobShadowRuntime.ts');
const { normalizeSceneAppearanceConfig, normalizeSceneLightingConfig } = await import('../../electron/shared/sceneLightingConfig.ts');
hooks.deregister();

const { ArcRotateCamera, MeshBuilder, NullEngine, Scene, TransformNode, Vector3 } = await import('@babylonjs/core');

function makeSource(
  mesh: InstanceType<typeof MeshBuilder['CreateBox']> extends infer M ? M : never,
  overrides: {
    entityId?: string;
    ownerEntityId?: string;
    deviceType?: string;
    parentDynamic?: boolean;
    automaticShadowMobility?: 'static' | 'dynamic';
    entityLighting?: Record<string, unknown>;
    fieldSources?: Record<string, { kind: string; label: string; value: unknown }>;
    castShadows?: boolean;
    receiveShadows?: boolean;
  } = {},
) {
  const entityId = overrides.entityId ?? 'entity-1';
  const nodeKey = '$mesh';
  return {
    mesh,
    automaticShadowMobility: overrides.automaticShadowMobility ?? 'static',
    getWorldMatrix: () => mesh.computeWorldMatrix(true),
    entry: {
      key: `${entityId}/${nodeKey}`,
      entityId,
      nodeKey,
      name: mesh.name,
      mobility: 'static' as const,
      reason: 'test',
      castShadows: overrides.castShadows ?? true,
      receiveShadows: overrides.receiveShadows ?? true,
      bakeIndirect: true,
      parentDynamic: overrides.parentDynamic ?? false,
      deviceType: overrides.deviceType ?? 'model',
      ...(overrides.fieldSources ? { fieldSources: overrides.fieldSources } : {}),
      policyContext: {
        entityId,
        ...(overrides.ownerEntityId ? { ownerEntityId: overrides.ownerEntityId } : {}),
        nodeKey,
        partKey: nodeKey,
        automatic: { mobility: 'static' as const, reason: 'test' },
        ...(overrides.entityLighting ? { entityLighting: overrides.entityLighting } : {}),
      },
    },
  };
}

test('resolveAutomaticShadowRole 在无过滤可选项时保持全自动原有语义，开启过滤后按仓储规则分层', t => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  t.after(() => {
    scene.dispose();
    engine.dispose();
  });

  const envMesh = MeshBuilder.CreateGround('floor', { width: 20, height: 20 }, scene);
  envMesh.metadata = { editorEnvironmentMesh: true };
  const rackMesh = MeshBuilder.CreateBox('rack', { size: 3 }, scene);
  const boltMesh = MeshBuilder.CreateBox('bolt', { size: 0.3 }, scene);
  const cargoMesh = MeshBuilder.CreateBox('cargo', { size: 1.2 }, scene);
  cargoMesh.metadata = { generatedCargo: true };
  const spawnedAgvMesh = MeshBuilder.CreateBox('agv', { size: 0.6 }, scene);
  spawnedAgvMesh.metadata = { deviceSpawnerSpawned: true };
  const roofMesh = MeshBuilder.CreateBox('roof', { size: 10 }, scene);

  const envSource = makeSource(envMesh, { entityId: '$environment', deviceType: 'environment' });
  const rackSource = makeSource(rackMesh, { entityId: 'rack-1', deviceType: 'model' });
  const boltSource = makeSource(boltMesh, { entityId: 'bolt-1', deviceType: 'model' });
  const cargoSource = makeSource(cargoMesh, {
    entityId: 'cargo-out-1',
    ownerEntityId: 'gen-1',
    parentDynamic: true,
    automaticShadowMobility: 'dynamic',
    deviceType: 'model',
  });
  const agvSource = makeSource(spawnedAgvMesh, {
    entityId: 'spawner/agv01',
    ownerEntityId: 'spawner-1',
    parentDynamic: false,
    automaticShadowMobility: 'dynamic',
    deviceType: 'agv_latent',
  });
  const roofSource = makeSource(roofMesh, {
    entityId: 'roof-1',
    castShadows: false,
    fieldSources: {
      mobility: { kind: 'automatic', label: '自动', value: 'static' },
      castShadows: { kind: 'entity', label: '对象例外', value: false },
      receiveShadows: { kind: 'automatic', label: '自动', value: true },
      bakeIndirect: { kind: 'automatic', label: '自动', value: true },
    },
    entityLighting: {
      mobility: 'auto',
      castShadows: false,
      receiveShadows: true,
      bakeIndirect: true,
      nodeOverrides: {},
      inheritPolicy: ['mobility', 'receiveShadows', 'bakeIndirect'],
    },
  });

  const baseShadows = normalizeSceneLightingConfig({ shadows: { managementMode: 'automatic' } }).shadows;
  for (const s of [envSource, rackSource, boltSource, cargoSource, agvSource, roofSource]) {
    const role = resolveAutomaticShadowRole(s as never, baseShadows);
    assert.equal(role.castShadows, true);
    assert.equal(role.receiveShadows, true);
  }

  const warehouseShadows = normalizeSceneLightingConfig({
    shadows: {
      managementMode: 'automatic',
      receiverScope: 'ground-only',
      skipSmallCastersMeters: 0.8,
      skipGeneratedCargoCasters: true,
      respectEntityShadowOverrides: true,
    },
  }).shadows;

  assert.deepEqual(resolveAutomaticShadowRole(envSource as never, warehouseShadows), {
    mobility: 'static',
    castShadows: true,
    receiveShadows: true,
  });
  assert.deepEqual(resolveAutomaticShadowRole(rackSource as never, warehouseShadows), {
    mobility: 'static',
    castShadows: true,
    receiveShadows: false,
  });
  assert.deepEqual(resolveAutomaticShadowRole(boltSource as never, warehouseShadows), {
    mobility: 'static',
    castShadows: false,
    receiveShadows: false,
  });
  assert.deepEqual(resolveAutomaticShadowRole(cargoSource as never, warehouseShadows), {
    mobility: 'dynamic',
    castShadows: false,
    receiveShadows: false,
  });
  assert.deepEqual(resolveAutomaticShadowRole(agvSource as never, warehouseShadows), {
    mobility: 'dynamic',
    castShadows: true,
    receiveShadows: false,
  });
  assert.deepEqual(resolveAutomaticShadowRole(roofSource as never, warehouseShadows), {
    mobility: 'static',
    castShadows: false,
    receiveShadows: false,
  });
});

test('SceneSsaoRuntime 与 SceneAppearanceRuntime 在 NullEngine 安全降级且不泄漏观察者', t => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  new ArcRotateCamera('cam', 0, 1, 20, Vector3.Zero(), scene);
  const ssao = new SceneSsaoRuntime(scene);
  const appearanceRuntime = new SceneAppearanceRuntime(scene);
  t.after(() => {
    ssao.dispose();
    appearanceRuntime.dispose();
    scene.dispose();
    engine.dispose();
  });

  const baseObservers = scene.onBeforeRenderObservable.observers.length;
  ssao.sync('balanced');
  assert.deepEqual(ssao.getState(), {
    requested: true,
    active: false,
    mode: 'balanced',
    reason: 'unsupported-hardware',
  });
  assert.equal(scene.onBeforeRenderObservable.observers.length, baseObservers);

  ssao.sync('off');
  assert.deepEqual(ssao.getState(), {
    requested: false,
    active: false,
    mode: 'off',
    reason: 'disabled',
  });

  const appearance = normalizeSceneAppearanceConfig({ ssaoMode: 'high' });
  appearanceRuntime.sync(appearance);
  assert.equal(appearanceRuntime.getSsaoState().requested, true);
  assert.equal(appearanceRuntime.getSsaoState().active, false);
  assert.equal(scene.onBeforeRenderObservable.observers.length, baseObservers);
});

test('MobileBlobShadowRuntime 仅跟踪移动设备并在关闭或释放后彻底清理资源', t => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const runtime = new MobileBlobShadowRuntime(scene);
  t.after(() => {
    runtime.dispose();
    scene.dispose();
    engine.dispose();
  });

  const agvRoot = new TransformNode('agv-root', scene);
  agvRoot.position.set(2, 0, 4);
  const agvMesh = MeshBuilder.CreateBox('agv-body', { width: 1.2, height: 0.4, depth: 1.8 }, scene);
  agvMesh.parent = agvRoot;
  agvMesh.position.y = 0.2;

  const rackRoot = new TransformNode('rack-root', scene);
  const rackMesh = MeshBuilder.CreateBox('rack-body', { size: 2 }, scene);
  rackMesh.parent = rackRoot;

  const models = [
    {
      root: agvRoot,
      contentRoot: agvRoot,
      meshes: [agvMesh],
      rgvCapable: false,
      stackerCapable: false,
      telemetryBinding: { deviceType: 'agv' },
      entitySnapshot: null,
    },
    {
      root: rackRoot,
      contentRoot: rackRoot,
      meshes: [rackMesh],
      rgvCapable: false,
      stackerCapable: false,
      telemetryBinding: null,
      entitySnapshot: null,
    },
  ];

  const initialObservers = scene.onBeforeRenderObservable.observers.length;
  const initialMeshes = scene.meshes.length;

  runtime.sync(false, () => models as never);
  assert.equal(runtime.getActiveBlobCount(), 0);
  assert.equal(scene.onBeforeRenderObservable.observers.length, initialObservers);
  assert.equal(scene.meshes.length, initialMeshes);

  runtime.sync(true, () => models as never);
  assert.equal(runtime.getActiveBlobCount(), 1);
  assert.equal(scene.meshes.length, initialMeshes + 1);
  const blobMesh = scene.meshes.find(mesh => mesh.name === '__MobileBlobShadow');
  assert.ok(blobMesh);
  assert.equal(blobMesh.isPickable, false);
  assert.equal(blobMesh.receiveShadows, false);
  assert.equal(blobMesh.metadata?.editorShadowCatcher, true);
  assert.ok(Math.abs(blobMesh.position.x - 2) < 1e-4);
  assert.ok(Math.abs(blobMesh.position.z - 4) < 1e-4);

  agvRoot.position.set(9, 0, -3);
  scene.onBeforeRenderObservable.notifyObservers(scene);
  assert.ok(Math.abs(blobMesh.position.x - 9) < 1e-4);
  assert.ok(Math.abs(blobMesh.position.z - (-3)) < 1e-4);

  agvRoot.setEnabled(false);
  scene.onBeforeRenderObservable.notifyObservers(scene);
  assert.equal(runtime.getActiveBlobCount(), 0);

  runtime.sync(false, () => models as never);
  assert.equal(scene.meshes.length, initialMeshes);
  assert.equal(scene.onBeforeRenderObservable.observers.length, initialObservers);
});
