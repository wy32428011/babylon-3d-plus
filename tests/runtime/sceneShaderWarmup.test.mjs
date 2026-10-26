import assert from 'node:assert/strict';
import test from 'node:test';
import { AssetContainer } from '@babylonjs/core/assetContainer.js';
import { FreeCamera } from '@babylonjs/core/Cameras/freeCamera.js';
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder.js';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';
import { RawTexture } from '@babylonjs/core/Materials/Textures/rawTexture.js';
import { Scene } from '@babylonjs/core/scene.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial.js';
import { MaterialPluginBase } from '@babylonjs/core/Materials/materialPluginBase.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { Constants } from '@babylonjs/core/Engines/constants.js';
import { PointLight } from '@babylonjs/core/Lights/pointLight.js';
import { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator.js';
import { Observable } from '@babylonjs/core/Misc/observable.js';
import '@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent.js';
import { SceneShaderWarmup } from '../../src/runtime/babylon/SceneShaderWarmup.ts';

function fixture(count = 1, blocked = false) {
  const engine = new NullEngine(),
    scene = new Scene(engine);
  new FreeCamera('camera', new Vector3(0, 0, -5), scene);
  const container = new AssetContainer(scene),
    material = new StandardMaterial('material', scene);
  if (blocked) {
    const texture = new RawTexture(
      new Uint8Array([255, 255, 255, 255]),
      1,
      1,
      Constants.TEXTUREFORMAT_RGBA,
      scene,
      false,
      false,
    );
    texture.isBlocking = true;
    texture.getInternalTexture().isReady = false;
    material.diffuseTexture = texture;
  }
  for (let i = 0; i < count; i++) {
    const mesh = CreateBox('source-' + i, {}, scene);
    mesh.material = material;
    container.meshes.push(mesh);
  }
  return {
    engine,
    scene,
    container,
    material,
    close() {
      scene.dispose();
      engine.dispose();
    },
  };
}
test('原生待加载纹理的编译有限超时，不留下forceCompilation轮询或材质状态变化', async () => {
  const f = fixture(1, true),
    warmup = new SceneShaderWarmup(f.scene, { maxWarmupMs: 30, maxPrograms: 4 });
  const mesh = f.container.meshes[0],
    subMeshes = [...mesh.subMeshes],
    hot = f.material.allowShaderHotSwapping;
  try {
    warmup.registerContainer(f.container);
    await warmup.prepare();
    assert.equal(warmup.getMetrics().timedOut, 1);
    assert.equal(warmup.getMetrics().active, 0);
    assert.equal(f.material.allowShaderHotSwapping, hot);
    assert.deepEqual(mesh.subMeshes, subMeshes);
  } finally {
    warmup.dispose();
    f.close();
  }
});
test('未知材质编译回调不提前执行，普通路径数据与subMesh身份保持', async () => {
  const f = fixture(),
    warmup = new SceneShaderWarmup(f.scene);
  let calls = 0;
  f.material.onCompiled = () => calls++;
  const before = f.container.meshes[0].subMeshes;
  try {
    warmup.registerContainer(f.container);
    await warmup.prepare();
    assert.equal(calls, 0);
    assert.equal(warmup.getMetrics().attemptedPrograms, 0);
    assert.ok(warmup.getMetrics().skippedReasons['custom-material-hook'] > 0);
    assert.equal(f.container.meshes[0].subMeshes, before);
  } finally {
    warmup.dispose();
    f.close();
  }
});
test('程序数量有硬上限，空Mesh包装可用，准备不生成货物/业务克隆', async () => {
  const f = fixture(5, true),
    warmup = new SceneShaderWarmup(f.scene, { maxPrograms: 2, maxWarmupMs: 25 });
  f.container.meshes.unshift(new Mesh('empty-root', f.scene));
  const meshes = [...f.scene.meshes];
  try {
    warmup.registerContainer(f.container);
    await warmup.prepare();
    const m = warmup.getMetrics();
    assert.equal(m.attemptedPrograms, 2);
    assert.ok(m.skippedReasons['program-budget'] >= 3);
    assert.deepEqual(f.scene.meshes, meshes);
    assert.equal(m.active, 0);
  } finally {
    warmup.dispose();
    f.close();
  }
});
test('单个等待取消不挂起其他等待，Scene销毁立即收束自有轮询', async () => {
  const f = fixture(1, true),
    warmup = new SceneShaderWarmup(f.scene, { maxWarmupMs: 1000 }),
    abort = new AbortController();
  warmup.registerContainer(f.container);
  const survivor = warmup.prepare(),
    cancelled = warmup.prepare(abort.signal);
  const sentinel = new Error('owned cancel');
  abort.abort(sentinel);
  await assert.rejects(cancelled, (e) => e === sentinel);
  f.scene.dispose();
  await survivor;
  assert.equal(warmup.getMetrics().active, 0);
  assert.equal(warmup.getMetrics().retainedPrograms, 0);
  warmup.dispose();
  f.engine.dispose();
});
test('关闭对照保留原加载路径，不触发编译；销毁/重复释放幂等', async () => {
  const f = fixture(1, true),
    warmup = new SceneShaderWarmup(f.scene);
  warmup.setEnabled(false);
  warmup.registerContainer(f.container);
  await warmup.prepare();
  assert.equal(warmup.getMetrics().attemptedPrograms, 0);
  warmup.dispose();
  warmup.dispose();
  f.close();
});
test('未知mesh/light方法、材质getter及插件Proxy只退原路径，不增加观察', async () => {
  const f = fixture(3, true),
    warmup = new SceneShaderWarmup(f.scene, { maxWarmupMs: 20 });
  let calls = 0;
  const light = new PointLight('custom-light', Vector3.Zero(), f.scene);
  light.getShadowGenerator = () => {
    calls++;
    throw Error('unknown light');
  };
  f.container.meshes[0].isDisposed = () => {
    calls++;
    throw Error('unknown mesh');
  };
  const getterMaterial = new StandardMaterial('getter', f.scene);
  Object.defineProperty(getterMaterial, 'onCompiled', {
    configurable: true,
    get() {
      calls++;
      throw Error('unknown getter');
    },
  });
  f.container.meshes[1].material = getterMaterial;
  const proxyMaterial = new StandardMaterial('proxy', f.scene);
  const originalManager = proxyMaterial.pluginManager;
  proxyMaterial.pluginManager = new Proxy(
    {},
    {
      get() {
        calls++;
        throw Error('unknown plugin');
      },
    },
  );
  f.container.meshes[2].material = proxyMaterial;
  try {
    warmup.registerContainer(f.container);
    await warmup.prepare();
    assert.equal(calls, 0);
    assert.equal(warmup.getMetrics().attemptedPrograms, 0);
  } finally {
    delete f.container.meshes[0].isDisposed;
    delete getterMaterial.onCompiled;
    proxyMaterial.pluginManager = originalManager;
    warmup.dispose();
    f.close();
  }
});
test('有效原生材质遇到未知light执行器时不调用它，仍正常有限准备', async () => {
  const f = fixture(1, true),
    warmup = new SceneShaderWarmup(f.scene, { maxWarmupMs: 25 });
  let calls = 0;
  const light = new PointLight('custom-light', Vector3.Zero(), f.scene);
  light.getShadowGenerator = () => {
    calls++;
    throw Error('unknown light');
  };
  try {
    warmup.registerContainer(f.container);
    await warmup.prepare();
    assert.equal(calls, 0);
    assert.equal(warmup.getMetrics().attemptedPrograms, 1);
    assert.ok(warmup.getMetrics().skippedReasons['custom-light'] > 0);
  } finally {
    delete light.getShadowGenerator;
    warmup.dispose();
    f.close();
  }
});
test('原生prototype新增访问器时只fallback，不先调用未知getter来认证', async () => {
  const f = fixture(),
    warmup = new SceneShaderWarmup(f.scene),
    before = Object.getOwnPropertyDescriptor(StandardMaterial.prototype, 'isReadyForSubMesh');
  let calls = 0;
  Object.defineProperty(StandardMaterial.prototype, 'isReadyForSubMesh', {
    configurable: true,
    get() {
      calls++;
      throw Error('unknown prototype getter');
    },
  });
  try {
    warmup.registerContainer(f.container);
    await warmup.prepare();
    assert.equal(calls, 0);
    assert.equal(warmup.getMetrics().attemptedPrograms, 0);
    assert.ok(warmup.getMetrics().skippedReasons['custom-native-api'] > 0);
  } finally {
    Object.defineProperty(StandardMaterial.prototype, 'isReadyForSubMesh', before);
    warmup.dispose();
    f.close();
  }
});

test('最后一个等待者取消后立即停止自有轮询，不等整个预算耗尽', async () => {
  const f = fixture(1, true),
    warmup = new SceneShaderWarmup(f.scene, { maxWarmupMs: 1000 }),
    abort = new AbortController();
  try {
    warmup.registerContainer(f.container);
    const pending = warmup.prepare(abort.signal);
    abort.abort(new Error('last owner cancelled'));
    await assert.rejects(pending, /last owner cancelled/);
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(warmup.getMetrics().active, 0);
    assert.equal(warmup.getMetrics().retainedPrograms, 0);
  } finally {
    warmup.dispose();
    f.close();
  }
});

const activeObservers = (observable) =>
  observable.observers.filter((observer) => !observer._willBeUnregistered).length;
function unknownMethod(object, key, accessor = false) {
  const original = Object.getOwnPropertyDescriptor(object, key);
  const sentinel = new Error('unknown-' + key);
  let calls = 0;
  const callback = () => {
    calls++;
    throw sentinel;
  };
  Object.defineProperty(
    object,
    key,
    accessor
      ? { configurable: true, get: callback }
      : { configurable: true, writable: true, value: callback },
  );
  return {
    calls: () => calls,
    sentinel,
    restore() {
      if (original) Object.defineProperty(object, key, original);
      else delete object[key];
    },
  };
}

test('真实MaterialPluginBase的未知执行器退原路径，不提前调用plugin', async () => {
  const f = fixture(),
    warmup = new SceneShaderWarmup(f.scene);
  let calls = 0;
  class ForeignPlugin extends MaterialPluginBase {
    constructor(material) {
      super(material, 'foreign', 200, {}, true, true);
    }
    getUniforms() {
      calls++;
      throw new Error('foreign-uniforms');
    }
  }
  new ForeignPlugin(f.material);
  calls = 0;
  try {
    warmup.registerContainer(f.container);
    await warmup.prepare();
    assert.equal(calls, 0);
    assert.equal(warmup.getMetrics().attemptedPrograms, 0);
  } finally {
    warmup.dispose();
    f.close();
  }
});

test('native准备实际调用的material mesh light公开hook在调用前拒绝', async (t) => {
  for (const [name, locate] of [
    ['buildUniformLayout', (f) => [f.material, 'buildUniformLayout']],
    ['isVerticesDataPresent', (f) => [f.container.meshes[0], 'isVerticesDataPresent']],
    [
      'prepareLightSpecificDefines',
      (f) => [new PointLight('light', Vector3.Zero(), f.scene), 'prepareLightSpecificDefines'],
    ],
    ['scene getEngine', (f) => [f.scene, 'getEngine']],
    [
      'texture isReadyOrNotBlocking',
      (f) => {
        const texture = new RawTexture(
          new Uint8Array([255, 255, 255, 255]),
          1,
          1,
          Constants.TEXTUREFORMAT_RGBA,
          f.scene,
          false,
          false,
        );
        f.material.diffuseTexture = texture;
        return [texture, 'isReadyOrNotBlocking'];
      },
    ],
  ])
    await t.test(name, async () => {
      const f = fixture(),
        warmup = new SceneShaderWarmup(f.scene),
        hook = unknownMethod(...locate(f), true);
      try {
        warmup.registerContainer(f.container);
        await warmup.prepare();
        assert.equal(hook.calls(), 0);
        assert.equal(warmup.getMetrics().attemptedPrograms, 0);
      } finally {
        hook.restore();
        warmup.dispose();
        f.close();
      }
    });
});

test('跨await后generator公开执行器变化退原路径而不调用新hook', async () => {
  const f = fixture(1, true),
    warmup = new SceneShaderWarmup(f.scene, { maxWarmupMs: 1000 });
  const light = new PointLight('shadow', Vector3.Zero(), f.scene),
    generator = new ShadowGenerator(128, light);
  let hook;
  try {
    warmup.registerContainer(f.container);
    const pending = warmup.prepare();
    assert.ok(warmup.getMetrics().active > 0, '确实已进入原生pending准备');
    hook = unknownMethod(generator, 'isReady', true);
    await pending;
    assert.equal(hook.calls(), 0);
    assert.equal(warmup.getMetrics().active, 0);
  } finally {
    hook?.restore();
    warmup.dispose();
    generator.dispose();
    f.close();
  }
});

test('真实native Standard与PBR成功实例变体保留Effect，释放自有引用不损坏业务SubMesh', async (t) => {
  for (const kind of ['standard', 'pbr'])
    await t.test(kind, async () => {
      const f = fixture(),
        warmup = new SceneShaderWarmup(f.scene, { maxWarmupMs: 1000 });
      if (kind === 'pbr') {
        const pbr = new PBRMaterial('pbr', f.scene);
        f.container.meshes[0].material = pbr;
        f.material = pbr;
      }
      const mesh = f.container.meshes[0],
        sub = mesh.subMeshes[0],
        before = [...mesh.subMeshes];
      try {
        warmup.registerContainer(f.container);
        await warmup.prepare();
        assert.equal(warmup.getMetrics().programsReady, 1, '成功路径不能被全部plugin拒绝掩盖');
        assert.equal(warmup.getMetrics().retainedPrograms, 1);
        assert.equal(f.material.isReadyForSubMesh(mesh, sub, true), true);
        const effect = sub.effect;
        assert.ok(effect);
        assert.equal(effect._isDisposed, false);
        const references = effect._refCount;
        assert.ok(references >= 2, '业务与准备持有同一native cache Effect引用');
        warmup.dispose();
        assert.equal(effect._refCount, references - 1);
        assert.equal(effect._isDisposed, false);
        assert.deepEqual(mesh.subMeshes, before);
        assert.equal(sub.effect, effect);
      } finally {
        warmup.dispose();
        f.close();
      }
    });
});

test('成功准备后的手动dispose在原Observable移除observer，即使公开引用被替换', async () => {
  const f = fixture(),
    sceneObservable = f.scene.onDisposeObservable,
    sceneBefore = activeObservers(sceneObservable);
  const warmup = new SceneShaderWarmup(f.scene, { maxWarmupMs: 1000 }),
    mesh = f.container.meshes[0];
  const meshObservable = mesh.onDisposeObservable,
    meshBefore = activeObservers(meshObservable);
  try {
    warmup.registerContainer(f.container);
    await warmup.prepare();
    assert.equal(warmup.getMetrics().programsReady, 1);
    assert.equal(activeObservers(meshObservable), meshBefore + 1);
    mesh.onDisposeObservable = new Observable();
    f.scene.onDisposeObservable = new Observable();
    warmup.dispose();
    assert.equal(activeObservers(meshObservable), meshBefore);
    assert.equal(activeObservers(sceneObservable), sceneBefore);
    assert.equal(warmup.getMetrics().retainedPrograms, 0);
  } finally {
    mesh.onDisposeObservable = meshObservable;
    f.scene.onDisposeObservable = sceneObservable;
    warmup.dispose();
    f.close();
  }
});

test('准备注册不调用Observable自有addOnce或原生registration callback', async (t) => {
  for (const kind of ['own-add', 'own-remove', 'registration'])
    await t.test(kind, async () => {
      const f = fixture(),
        warmup = new SceneShaderWarmup(f.scene, { maxWarmupMs: 1000 });
      const observable = f.container.meshes[0].onDisposeObservable;
      let calls = 0,
        hook;
      if (kind === 'own-add' || kind === 'own-remove')
        hook = unknownMethod(observable, kind === 'own-add' ? 'addOnce' : 'remove', true);
      else
        observable._onObserverAdded = () => {
          calls++;
          throw new Error('registration-callback');
        };
      try {
        warmup.registerContainer(f.container);
        await warmup.prepare();
        assert.equal(hook?.calls() ?? calls, 0);
        assert.equal(warmup.getMetrics().retainedPrograms, 0);
      } finally {
        hook?.restore();
        delete observable._onObserverAdded;
        warmup.dispose();
        f.close();
      }
    });
});

test('native shadow与color成功准备后source销毁同步归还全部自有Effect引用', async () => {
  const f = fixture(),
    warmup = new SceneShaderWarmup(f.scene, { maxWarmupMs: 1000 });
  const light = new PointLight('native-shadow', Vector3.Zero(), f.scene),
    generator = new ShadowGenerator(128, light);
  const mesh = f.container.meshes[0],
    before = [...mesh.subMeshes];
  try {
    warmup.registerContainer(f.container);
    await warmup.prepare();
    assert.equal(warmup.getMetrics().programsReady, 2, '实际color及nativeShadow变体均准备成功');
    assert.equal(warmup.getMetrics().retainedPrograms, 2);
    assert.deepEqual(mesh.subMeshes, before);
    const effects = Object.values(f.engine._compiledEffects);
    assert.equal(effects.length, 2);
    const references = effects.map((effect) => effect._refCount);
    mesh.dispose();
    assert.equal(warmup.getMetrics().retainedPrograms, 0);
    for (const [index, effect] of effects.entries()) {
      assert.equal(effect._refCount, references[index] - 1);
      assert.equal(effect._isDisposed, true);
    }
  } finally {
    warmup.dispose();
    generator.dispose();
    f.close();
  }
});

test('最后caller取消后的立即新caller等待旧run清理并能准备同一真实容器', async () => {
  const f = fixture(1, true),
    warmup = new SceneShaderWarmup(f.scene, { maxWarmupMs: 1000 });
  const abort = new AbortController(),
    sentinel = new Error('old-run-cancel');
  try {
    warmup.registerContainer(f.container);
    const old = warmup.prepare(abort.signal);
    abort.abort(sentinel);
    await assert.rejects(old, (error) => error === sentinel);
    f.material.diffuseTexture.getInternalTexture().isReady = true;
    warmup.registerContainer(f.container);
    await warmup.prepare();
    assert.equal(warmup.getMetrics().runs, 2);
    assert.equal(warmup.getMetrics().programsReady, 1);
    assert.equal(warmup.getMetrics().active, 0);
    assert.equal(warmup.getMetrics().retainedPrograms, 1);
  } finally {
    warmup.dispose();
    f.close();
  }
});

test('跨await后source公开geometry material range或真实manager换代不保留旧job', async (t) => {
  for (const kind of ['geometry', 'material', 'range', 'manager'])
    await t.test(kind, async () => {
      const f = fixture(1, true),
        warmup = new SceneShaderWarmup(f.scene, { maxWarmupMs: 1000 });
      const mesh = f.container.meshes[0],
        originalManager = f.material.pluginManager;
      let calls = 0;
      try {
        warmup.registerContainer(f.container);
        const pending = warmup.prepare();
        assert.equal(warmup.getMetrics().active, 1);
        if (kind === 'geometry') mesh.geometry.copy('new-geometry').applyToMesh(mesh);
        if (kind === 'material') mesh.material = new StandardMaterial('new-material', f.scene);
        if (kind === 'range') mesh.subMeshes[0].indexCount -= 3;
        if (kind === 'manager')
          f.material.pluginManager = new Proxy(
            {},
            {
              get() {
                calls++;
                throw new Error('new-manager');
              },
            },
          );
        await pending;
        assert.equal(calls, 0);
        assert.equal(warmup.getMetrics().programsReady, 0);
        assert.equal(warmup.getMetrics().retainedPrograms, 0);
        assert.equal(warmup.getMetrics().active, 0);
      } finally {
        f.material.pluginManager = originalManager;
        warmup.dispose();
        f.close();
      }
    });
});

test('Scene registration callback不被构造器新增调用，后换own remove也不接管清理', async () => {
  const f = fixture(),
    sceneObservable = f.scene.onDisposeObservable;
  let calls = 0;
  sceneObservable._onObserverAdded = () => {
    calls++;
    throw new Error('scene-registration');
  };
  let warmup;
  try {
    warmup = new SceneShaderWarmup(f.scene);
    warmup.registerContainer(f.container);
    await warmup.prepare();
    assert.equal(calls, 0);
    assert.equal(warmup.getMetrics().attemptedPrograms, 0);
  } finally {
    delete sceneObservable._onObserverAdded;
    warmup?.dispose();
    f.close();
  }
  const g = fixture(),
    second = new SceneShaderWarmup(g.scene, { maxWarmupMs: 1000 });
  let hook;
  try {
    second.registerContainer(g.container);
    await second.prepare();
    assert.equal(second.getMetrics().programsReady, 1);
    hook = unknownMethod(g.container.meshes[0].onDisposeObservable, 'remove', true);
    second.dispose();
    assert.equal(hook.calls(), 0);
    assert.equal(second.getMetrics().retainedPrograms, 0);
  } finally {
    hook?.restore();
    second.dispose();
    g.close();
  }
});
