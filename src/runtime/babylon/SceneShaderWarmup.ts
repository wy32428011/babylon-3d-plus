import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { SubMesh } from '@babylonjs/core/Meshes/subMesh.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial.js';
import { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator.js';
import { CascadedShadowGenerator } from '@babylonjs/core/Lights/Shadows/cascadedShadowGenerator.js';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight.js';
import { PointLight } from '@babylonjs/core/Lights/pointLight.js';
import { SpotLight } from '@babylonjs/core/Lights/spotLight.js';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight.js';
import { Observable, type Observer } from '@babylonjs/core/Misc/observable.js';
import { MaterialPluginManager } from '@babylonjs/core/Materials/materialPluginManager.js';
import { DetailMapConfiguration } from '@babylonjs/core/Materials/material.detailMapConfiguration.js';
import { PBRBRDFConfiguration } from '@babylonjs/core/Materials/PBR/pbrBRDFConfiguration.js';
import { PBRClearCoatConfiguration } from '@babylonjs/core/Materials/PBR/pbrClearCoatConfiguration.js';
import { PBRIridescenceConfiguration } from '@babylonjs/core/Materials/PBR/pbrIridescenceConfiguration.js';
import { PBRAnisotropicConfiguration } from '@babylonjs/core/Materials/PBR/pbrAnisotropicConfiguration.js';
import { PBRSheenConfiguration } from '@babylonjs/core/Materials/PBR/pbrSheenConfiguration.js';
import { PBRSubSurfaceConfiguration } from '@babylonjs/core/Materials/PBR/pbrSubSurfaceConfiguration.js';
import { Texture } from '@babylonjs/core/Materials/Textures/texture.js';
import { CubeTexture } from '@babylonjs/core/Materials/Textures/cubeTexture.js';
import { RawTexture } from '@babylonjs/core/Materials/Textures/rawTexture.js';
import { RawCubeTexture } from '@babylonjs/core/Materials/Textures/rawCubeTexture.js';
import type { AssetContainer } from '@babylonjs/core/assetContainer.js';
import { Material } from '@babylonjs/core/Materials/material.js';
import { Scene } from '@babylonjs/core/scene.js';

type Options = { maxConcurrent?: number; maxPrograms?: number; maxWarmupMs?: number };
type Job = {
  mesh: Mesh;
  source: SubMesh;
  material: Material;
  instances: boolean;
  generator?: ShadowGenerator;
  facts: JobFacts;
};
type JobFacts = {
  geometry: Mesh['geometry'];
  renderPassId: number;
  sourceRange: unknown[];
  sceneLights: object[];
  meshLights: object[];
  generators: Array<[object, unknown]>;
  plugins: object[];
  receiveShadows: boolean;
  observable: Mesh['onDisposeObservable'];
};
const rangeKeys = [
  'materialIndex',
  'verticesStart',
  'verticesCount',
  'indexStart',
  'indexCount',
] as const;
const nativeReady = new Map<object, Material['isReadyForSubMesh']>([
  [StandardMaterial.prototype, StandardMaterial.prototype.isReadyForSubMesh],
  [PBRMaterial.prototype, PBRMaterial.prototype.isReadyForSubMesh],
]);
const nativeShadowReady = ShadowGenerator.prototype.isReady;
const nativeGetEngine = Scene.prototype.getEngine;
const texturePrototypes = [
  Texture.prototype,
  CubeTexture.prototype,
  RawTexture.prototype,
  RawCubeTexture.prototype,
];
const lightPrototypes = [DirectionalLight.prototype, PointLight.prototype, SpotLight.prototype];
const colorLightPrototypes = [...lightPrototypes, HemisphericLight.prototype];
const nativeLightGenerators = new Map(
  lightPrototypes.map((prototype) => [prototype, prototype.getShadowGenerator]),
);
const prototypeFacts: Array<{
  value: object;
  parent: object | null;
  fields: Map<PropertyKey, PropertyDescriptor>;
}> = [];
const visitedPrototypes = new Set<object>();
for (const type of [
  Mesh,
  SubMesh,
  Material,
  StandardMaterial,
  PBRMaterial,
  DirectionalLight,
  PointLight,
  SpotLight,
  HemisphericLight,
  ShadowGenerator,
  CascadedShadowGenerator,
  Observable,
  MaterialPluginManager,
  DetailMapConfiguration,
  PBRBRDFConfiguration,
  PBRClearCoatConfiguration,
  PBRIridescenceConfiguration,
  PBRAnisotropicConfiguration,
  PBRSheenConfiguration,
  PBRSubSurfaceConfiguration,
  Texture,
  CubeTexture,
  RawTexture,
  RawCubeTexture,
]) {
  for (
    let value: object | null = type.prototype;
    value && !visitedPrototypes.has(value);
    value = Object.getPrototypeOf(value)
  ) {
    visitedPrototypes.add(value);
    prototypeFacts.push({
      value,
      parent: Object.getPrototypeOf(value),
      fields: new Map(
        Reflect.ownKeys(value).map((key) => [key, Object.getOwnPropertyDescriptor(value, key)!]),
      ),
    });
  }
}
const prototypeApis = new Map<object, PropertyKey[]>();
function sdkApi(value: object, prototype: object, ignored: readonly PropertyKey[] = []): boolean {
  if (Object.getPrototypeOf(value) !== prototype) return false;
  let keys = prototypeApis.get(prototype);
  if (!keys) {
    keys = [];
    for (
      let current: object | null = prototype;
      current;
      current = Object.getPrototypeOf(current)
    ) {
      const fact = prototypeFacts.find((item) => item.value === current);
      if (!fact) return false;
      for (const [key, descriptor] of fact.fields) {
        if (typeof descriptor.value === 'function' || descriptor.get || descriptor.set)
          keys.push(key);
      }
    }
    prototypeApis.set(prototype, keys);
  }
  return keys.every((key) => ignored.includes(key) || !Object.hasOwn(value, key));
}
function ownData(value: object, key: PropertyKey): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}
type Subscription = { observable: Observable<unknown>; observer: Observer<unknown> };
const nativeAddOnce = Observable.prototype.addOnce;
const nativeRemove = Observable.prototype.remove;
function safeObservable(value: unknown): value is Observable<unknown> {
  if (!value || typeof value !== 'object' || !sdkApi(value, Observable.prototype)) return false;
  const callback = Object.getOwnPropertyDescriptor(value, '_onObserverAdded');
  if (callback && (!('value' in callback) || callback.value != null)) return false;
  const notified = ownData(value, '_hasNotified'),
    replay = ownData(value, 'notifyIfTriggered');
  return typeof notified === 'boolean' && typeof replay === 'boolean' && !(notified && replay);
}
function subscribe(value: unknown, callback: () => void): Subscription | null {
  if (!safeObservable(value)) return null;
  const observer = nativeAddOnce.call(value, callback);
  return observer ? { observable: value, observer } : null;
}
function unsubscribe(subscription: Subscription | null): void {
  if (!subscription) return;
  // 归还自己注册的token；公开Observable引用或remove被换也不能执行新hook或误清别人的对象。
  nativeRemove.call(subscription.observable, subscription.observer);
}
const meshDataKeys = [
  'material',
  'geometry',
  'skeleton',
  'morphTargetManager',
  'subMeshes',
  'onDisposeObservable',
] as const;
function meshDataAllowed(mesh: Mesh): boolean {
  return meshDataKeys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(mesh, key);
    return !descriptor || 'value' in descriptor;
  });
}
function sceneApi(scene: Scene): boolean {
  return (
    Object.getPrototypeOf(scene) === Scene.prototype &&
    !Object.hasOwn(scene, 'getEngine') &&
    Object.getOwnPropertyDescriptor(Scene.prototype, 'getEngine')?.value === nativeGetEngine
  );
}
function texturesAllowed(material: Material): boolean {
  for (const texture of material.getActiveTextures()) {
    const prototype = Object.getPrototypeOf(texture);
    if (!texturePrototypes.includes(prototype) || !sdkApi(texture, prototype)) return false;
  }
  return true;
}
const standardPlugins: Array<[string, object]> = [['detailMap', DetailMapConfiguration.prototype]];
const pbrPlugins: Array<[string, object]> = [
  ['brdf', PBRBRDFConfiguration.prototype],
  ['clearCoat', PBRClearCoatConfiguration.prototype],
  ['iridescence', PBRIridescenceConfiguration.prototype],
  ['anisotropy', PBRAnisotropicConfiguration.prototype],
  ['sheen', PBRSheenConfiguration.prototype],
  ['subSurface', PBRSubSurfaceConfiguration.prototype],
  ...standardPlugins,
];
/** 先以SDK内建config持有的引用确认manager；未知替换对象仍是opaque，不探测其执行器。 */
function builtinPluginFacts(material: Material): object[] | null {
  const expected =
    Object.getPrototypeOf(material) === StandardMaterial.prototype ? standardPlugins : pbrPlugins;
  const plugins: object[] = [];
  let manager: object | undefined;
  for (const [key, prototype] of expected) {
    const plugin = ownData(material, key);
    if (!plugin || typeof plugin !== 'object' || !sdkApi(plugin, prototype)) return null;
    const reference = ownData(plugin, '_pluginManager');
    if (!reference || typeof reference !== 'object' || (manager && manager !== reference))
      return null;
    manager = reference;
    plugins.push(plugin);
  }
  if (
    !manager ||
    ownData(material, 'pluginManager') !== manager ||
    !sdkApi(manager, MaterialPluginManager.prototype)
  )
    return null;
  for (const key of ['_plugins', '_activePlugins', '_activePluginsForExtraEvents']) {
    const list = ownData(manager, key);
    if (!Array.isArray(list) || Object.getPrototypeOf(list) !== Array.prototype) return null;
    const length = ownData(list, 'length');
    if (
      typeof length !== 'number' ||
      length > plugins.length ||
      (key === '_plugins' && length !== plugins.length)
    )
      return null;
    const seen = new Set();
    for (let index = 0; index < length; index++) {
      const plugin = ownData(list, index);
      if (!plugins.includes(plugin as object) || seen.has(plugin)) return null;
      seen.add(plugin);
    }
  }
  return [manager, ...plugins];
}
function nativeGenerator(value: unknown): value is ShadowGenerator {
  if (!value || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return (
    [ShadowGenerator.prototype, CascadedShadowGenerator.prototype].includes(prototype) &&
    sdkApi(value, prototype) &&
    ownData(value, 'customShaderOptions') == null
  );
}
/** 无receiveShadows的color路径不会调用getShadowGenerator；该覆盖仅阻止独立shadow准备。 */
function colorLightsAllowed(mesh: Mesh): boolean {
  for (const light of mesh.lightSources) {
    const prototype = Object.getPrototypeOf(light);
    if (
      !colorLightPrototypes.includes(prototype) ||
      !sdkApi(light, prototype, mesh.receiveShadows ? [] : ['getShadowGenerator'])
    )
      return false;
    if (mesh.receiveShadows && light.shadowEnabled) {
      const generator = light.getShadowGenerator();
      if (generator && !nativeGenerator(generator)) return false;
    }
  }
  return true;
}
function sameReferences(current: readonly unknown[], before: readonly unknown[]): boolean {
  return (
    current.length === before.length && current.every((value, index) => value === before[index])
  );
}
function generatorReferences(scene: Scene): Array<[object, unknown]> {
  const result: Array<[object, unknown]> = [];
  for (const light of scene.lights) {
    const prototype = Object.getPrototypeOf(light);
    if (nativeLightGenerators.has(prototype) && sdkApi(light, prototype))
      result.push([light, light.getShadowGenerator()]);
  }
  return result;
}
function nativeLibrary(): boolean {
  return prototypeFacts.every(
    (fact) =>
      Object.getPrototypeOf(fact.value) === fact.parent &&
      Reflect.ownKeys(fact.value).length === fact.fields.size &&
      [...fact.fields].every(([key, before]) => {
        const after = Object.getOwnPropertyDescriptor(fact.value, key);
        return (
          !!after &&
          after.value === before.value &&
          after.get === before.get &&
          after.set === before.set &&
          after.configurable === before.configurable &&
          after.enumerable === before.enumerable &&
          after.writable === before.writable
        );
      }),
  );
}
const nativeForceBlockDirty = Scene.prototype._forceBlockMaterialDirtyMechanism;
const nativeDirtyAccessor = Object.getOwnPropertyDescriptor(Scene.prototype, 'blockMaterialDirtyMechanism');

/** 复用原生API边界检查；仅供作者显式选择的同步、未绑定材质克隆，不用于批量修改场景材质。 */
export function canBatchDetachedMaterialInitialization(material: Material, scene: Scene): boolean {
  const prototype = Object.getPrototypeOf(material);
  if (!nativeLibrary() || !sceneApi(scene) || !nativeReady.has(prototype)
    || !sdkApi(material, prototype, ['pluginManager']) || !builtinPluginFacts(material)) return false;
  if (Object.values(Object.getOwnPropertyDescriptors(material)).some(descriptor => !('value' in descriptor))) return false;
  if (Object.hasOwn(scene, 'blockMaterialDirtyMechanism') || Object.hasOwn(scene, '_forceBlockMaterialDirtyMechanism')
    || Scene.prototype._forceBlockMaterialDirtyMechanism !== nativeForceBlockDirty) return false;
  const accessor = Object.getOwnPropertyDescriptor(Scene.prototype, 'blockMaterialDirtyMechanism');
  if (accessor?.get !== nativeDirtyAccessor?.get || accessor?.set !== nativeDirtyAccessor?.set) return false;
  for (const observable of [scene.onNewMaterialAddedObservable, scene.onNewTextureAddedObservable]) {
    if (!safeObservable(observable) || observable.hasObservers()) return false;
  }
  // Raw/Dynamic/自定义纹理可能在克隆时同步调用外部代码，保留原行为；普通glTF Texture走原生克隆。
  return material.getActiveTextures().every(texture => Object.getPrototypeOf(texture) === Texture.prototype
    && sdkApi(texture, Texture.prototype)
    && Object.values(Object.getOwnPropertyDescriptors(texture)).every(descriptor => 'value' in descriptor));
}

const abortReason = (signal: AbortSignal) =>
  signal.reason ?? new DOMException('着色器准备已取消。', 'AbortError');
function bounded(value: number | undefined, fallback: number, maximum: number): number {
  const result = value ?? fallback;
  if (!Number.isFinite(result) || result < 1 || result > maximum)
    throw new RangeError('着色器准备预算无效。');
  return result;
}
function yieldUntilNextFrame(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(abortReason(signal));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, 16);
    signal.addEventListener('abort', abort, { once: true });
  });
}
function waitForCaller(task: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return task;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(abortReason(signal));
    };
    signal.addEventListener('abort', abort, { once: true });
    task.then(
      () => {
        signal.removeEventListener('abort', abort);
        resolve();
      },
      (error) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

/** 只补预取货物模板的原生实例变体；活动GI/效果继续由原首帧就绪检查准备。 */
export class SceneShaderWarmup {
  private enabled = true;
  private readonly containers = new Set<AssetContainer>();
  private readonly retained = new Map<Mesh, SubMesh[]>();
  private readonly retainedObservers = new Map<Mesh, Subscription>();
  private readonly disposeObserver: Subscription | null;
  private controller = new AbortController();
  private readonly concurrency: number;
  private readonly maxPrograms: number;
  private readonly maxWarmupMs: number;
  private running: Promise<void> | null = null;
  private waiters = 0;
  private disposed = false;
  private readonly reasons = new Map<string, number>();
  private readonly counters = {
    runs: 0,
    attemptedPrograms: 0,
    programsReady: 0,
    timedOut: 0,
    failed: 0,
    cancelled: 0,
    notReadyChecks: 0,
    active: 0,
    peakActive: 0,
    totalMs: 0,
    lastError: null as string | null,
  };
  constructor(
    private readonly scene: Scene,
    options: Options = {},
  ) {
    this.concurrency = Math.floor(bounded(options.maxConcurrent, 2, 4));
    this.maxPrograms = Math.floor(bounded(options.maxPrograms, 64, 256));
    this.maxWarmupMs = bounded(options.maxWarmupMs, 2000, 10000);
    this.disposeObserver = subscribe(ownData(scene, 'onDisposeObservable'), () => this.dispose());
  }
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) {
      this.containers.clear();
      this.controller.abort();
    }
  }
  registerContainer(container: AssetContainer): void {
    if (this.disposed || !this.enabled) return;
    if (this.containers.size >= 64) {
      this.skip('container-budget');
      return;
    }
    this.containers.add(container);
  }
  getMetrics() {
    return {
      enabled: this.enabled,
      ...this.counters,
      pendingContainers: this.containers.size,
      retainedPrograms: [...this.retained.values()].reduce((n, items) => n + items.length, 0),
      skippedReasons: Object.fromEntries(this.reasons),
    };
  }
  prepare(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    if (this.disposed || !this.enabled) return Promise.resolve();
    if (this.running && this.controller.signal.aborted) {
      return waitForCaller(
        this.running.then(() => this.prepare(signal)),
        signal,
      );
    }
    if (!this.running) {
      this.controller = new AbortController();
      const task = this.run(this.controller.signal);
      this.running = task;
      this.waiters = 0;
      const clear = () => {
        if (this.running === task) {
          this.running = null;
          this.waiters = 0;
        }
      };
      void task.then(clear, clear);
    }
    const task = this.running,
      controller = this.controller;
    this.waiters++;
    return waitForCaller(task, signal).finally(() => {
      if (this.running === task && --this.waiters === 0) controller.abort();
    });
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.controller.abort();
    unsubscribe(this.disposeObserver);
    this.containers.clear();
    for (const mesh of [...this.retained.keys()]) this.release(mesh);
  }
  private skip(reason: string): void {
    this.reasons.set(reason, (this.reasons.get(reason) ?? 0) + 1);
  }
  private allowed(material: Material): boolean {
    if (!nativeLibrary()) {
      this.skip('custom-native-api');
      return false;
    }
    const expected = nativeReady.get(Object.getPrototypeOf(material));
    if (
      !expected ||
      !sdkApi(material, Object.getPrototypeOf(material), ['pluginManager']) ||
      material.isReadyForSubMesh !== expected
    ) {
      this.skip('custom-material');
      return false;
    }
    const swapping = Object.getOwnPropertyDescriptor(material, 'allowShaderHotSwapping');
    if (
      !swapping ||
      !('value' in swapping) ||
      typeof swapping.value !== 'boolean' ||
      !swapping.writable
    ) {
      this.skip('custom-material-hook');
      return false;
    }
    for (const name of ['onCompiled', 'onError', 'customShaderNameResolve']) {
      const descriptor = Object.getOwnPropertyDescriptor(material, name);
      if (descriptor && (!('value' in descriptor) || descriptor.value != null)) {
        this.skip('custom-material-hook');
        return false;
      }
    }
    const observable = Object.getOwnPropertyDescriptor(material, '_onEffectCreatedObservable');
    if (
      observable &&
      (!('value' in observable) ||
        (observable.value &&
          (Object.getPrototypeOf(observable.value) !== Observable.prototype ||
            Object.hasOwn(observable.value, 'hasObservers') ||
            observable.value.hasObservers())))
    ) {
      this.skip('custom-material-hook');
      return false;
    }
    // Standard/PBR都带SDK内建插件；只认证固定config身份，未知插件仍由原首帧准备。
    if (!builtinPluginFacts(material)) {
      this.skip('custom-material-plugin');
      return false;
    }
    if (!texturesAllowed(material)) {
      this.skip('custom-texture');
      return false;
    }
    if (
      ['shadowDepthWrapper', '_shadowDepthWrapper'].some((name) => {
        const d = Object.getOwnPropertyDescriptor(material, name);
        return d && !('value' in d);
      })
    ) {
      this.skip('custom-shadow-wrapper');
      return false;
    }
    if (material.shadowDepthWrapper) {
      this.skip('custom-shadow-wrapper');
      return false;
    }
    return true;
  }
  private collect(
    meshes: readonly unknown[],
    instances: boolean,
    jobs: Job[],
    seen: Set<SubMesh>,
  ): void {
    for (const item of meshes) {
      if (jobs.length >= this.maxPrograms) {
        this.skip('program-budget');
        continue;
      }
      if (!(item instanceof Mesh) || Object.getPrototypeOf(item) !== Mesh.prototype) continue;
      if (!sdkApi(item, Mesh.prototype)) {
        this.skip('custom-mesh');
        continue;
      }
      if (!meshDataAllowed(item) || !safeObservable(ownData(item, 'onDisposeObservable'))) {
        this.skip('custom-mesh');
        continue;
      }
      if (item.isDisposed() || !item.geometry || item.skeleton || item.morphTargetManager) continue;
      // 先认证原生单材质，避免SubMesh.getMaterial提前执行MultiMaterial或自定义getSubMaterial。
      const material =
        item.getMaterialForRenderPass(this.scene.getEngine().currentRenderPassId) ?? item.material;
      if (!material || !this.allowed(material)) continue;
      if (!colorLightsAllowed(item)) {
        this.skip('custom-light');
        continue;
      }
      for (const source of item.subMeshes ?? []) {
        if (seen.has(source)) continue;
        seen.add(source);
        if (!sdkApi(source, SubMesh.prototype)) {
          this.skip('custom-submesh');
          continue;
        }
        if (
          ['materialIndex', 'verticesStart', 'verticesCount', 'indexStart', 'indexCount'].some(
            (name) => {
              const d = Object.getOwnPropertyDescriptor(source, name);
              return !d || !('value' in d) || !Number.isFinite(d.value);
            },
          )
        ) {
          this.skip('custom-submesh');
          continue;
        }
        if (source.getRenderingMesh() !== item) {
          this.skip('custom-submesh');
          continue;
        }
        const facts: JobFacts = {
          geometry: item.geometry,
          renderPassId: this.scene.getEngine().currentRenderPassId,
          sourceRange: rangeKeys.map((key) => ownData(source, key)),
          sceneLights: [...this.scene.lights],
          meshLights: [...item.lightSources],
          generators: generatorReferences(this.scene),
          plugins: builtinPluginFacts(material)!,
          receiveShadows: item.receiveShadows,
          observable: item.onDisposeObservable,
        };
        jobs.push({ mesh: item, source, material, instances, facts });
        for (const light of this.scene.lights) {
          if (jobs.length >= this.maxPrograms) {
            this.skip('program-budget');
            break;
          }
          const getGenerator = nativeLightGenerators.get(Object.getPrototypeOf(light));
          if (
            !getGenerator ||
            !sdkApi(light, Object.getPrototypeOf(light)) ||
            light.getShadowGenerator !== getGenerator
          ) {
            this.skip('custom-light');
            continue;
          }
          const generator = light.getShadowGenerator();
          if (!nativeGenerator(generator) || generator.isReady !== nativeShadowReady) continue;
          jobs.push({ mesh: item, source, material, instances, generator, facts });
        }
      }
    }
  }
  /** 每个await之后重核已捕获的公开输入；不借调用新hook来确认它是否仍可准备。 */
  private current(job: Job): boolean {
    const { mesh, source, material, facts } = job;
    if (
      !nativeLibrary() ||
      !sceneApi(this.scene) ||
      !sdkApi(mesh, Mesh.prototype) ||
      !meshDataAllowed(mesh) ||
      !safeObservable(ownData(mesh, 'onDisposeObservable')) ||
      !sdkApi(source, SubMesh.prototype) ||
      !this.allowed(material) ||
      !colorLightsAllowed(mesh) ||
      (job.generator && !nativeGenerator(job.generator))
    )
      return false;
    if (
      mesh.isDisposed() ||
      mesh.geometry !== facts.geometry ||
      mesh.receiveShadows !== facts.receiveShadows ||
      this.scene.getEngine().currentRenderPassId !== facts.renderPassId ||
      (mesh.getMaterialForRenderPass(facts.renderPassId) ?? mesh.material) !== material ||
      source.getRenderingMesh() !== mesh ||
      !sameReferences(
        rangeKeys.map((key) => ownData(source, key)),
        facts.sourceRange,
      ) ||
      !sameReferences(this.scene.lights, facts.sceneLights) ||
      !sameReferences(mesh.lightSources, facts.meshLights) ||
      mesh.onDisposeObservable !== facts.observable ||
      !sameReferences(builtinPluginFacts(material) ?? [], facts.plugins)
    )
      return false;
    const generators = generatorReferences(this.scene);
    return (
      generators.length === facts.generators.length &&
      generators.every((pair, index) => sameReferences(pair, facts.generators[index]))
    );
  }
  private async run(signal: AbortSignal): Promise<void> {
    const started = performance.now(),
      deadline = started + this.maxWarmupMs;
    this.counters.runs++;
    if (!this.disposeObserver) {
      this.skip('custom-observable');
      this.containers.clear();
      return;
    }
    if (!sceneApi(this.scene)) {
      this.skip('custom-scene');
      this.containers.clear();
      return;
    }
    if (!nativeLibrary()) {
      this.skip('custom-native-api');
      this.containers.clear();
      return;
    }
    const jobs: Job[] = [],
      seen = new Set<SubMesh>(),
      added: Array<{ mesh: Mesh; sub: SubMesh }> = [];
    // 不创建业务实例，实际实例属性路径由useInstances显式指定。
    for (const container of this.containers) this.collect(container.meshes, true, jobs, seen);
    this.containers.clear();
    const available = Math.max(0, this.maxPrograms - this.getMetrics().retainedPrograms);
    for (let i = available; i < jobs.length; i++) this.skip('program-budget');
    jobs.length = Math.min(jobs.length, available);
    let cursor = 0;
    try {
      await Promise.all(
        Array.from({ length: Math.min(this.concurrency, jobs.length) }, async () => {
          while (cursor < jobs.length && !this.disposed && !signal.aborted) {
            const job = jobs[cursor++];
            if (performance.now() >= deadline) {
              this.skip('time-budget');
              continue;
            }
            const sub = await this.prepareJob(job, deadline, signal);
            if (sub) added.push({ mesh: job.mesh, sub });
          }
        }),
      );
    } finally {
      if (signal.aborted)
        for (const { mesh, sub } of added) {
          const items = this.retained.get(mesh),
            index = items?.indexOf(sub) ?? -1;
          if (items && index >= 0) {
            items.splice(index, 1);
            sub.resetDrawCache(undefined, true);
            if (!items.length) this.release(mesh);
          }
        }
      this.counters.totalMs += performance.now() - started;
    }
  }
  private async prepareJob(
    job: Job,
    deadline: number,
    signal: AbortSignal,
  ): Promise<SubMesh | undefined> {
    const { mesh, source, material } = job;
    if (!this.current(job)) {
      this.skip('stale-source');
      return;
    }
    if (mesh.isDisposed()) {
      this.skip('stale-source');
      return;
    }
    const temporary = new SubMesh(
      source.materialIndex,
      source.verticesStart,
      source.verticesCount,
      source.indexStart,
      source.indexCount,
      mesh,
      undefined,
      false,
      false,
    );
    this.counters.attemptedPrograms++;
    this.counters.active++;
    this.counters.peakActive = Math.max(this.counters.peakActive, this.counters.active);
    let retained = false;
    try {
      while (!this.disposed && !signal.aborted) {
        if (!this.current(job)) {
          this.skip('stale-source');
          return;
        }
        if (mesh.isDisposed()) break;
        const hotSwapping = material.allowShaderHotSwapping;
        let ready: boolean;
        try {
          material.allowShaderHotSwapping = false;
          if (temporary.materialDefines) temporary.materialDefines._renderId = -1;
          ready = job.generator
            ? job.generator.isReady(
                temporary,
                job.instances,
                material.needAlphaBlendingForMesh(mesh),
              )
            : material.isReadyForSubMesh(mesh, temporary, job.instances);
        } finally {
          material.allowShaderHotSwapping = hotSwapping;
        }
        if (ready) {
          this.counters.programsReady++;
          const entries = this.retained.get(mesh) ?? [];
          if (!this.retained.has(mesh)) {
            const subscription = subscribe(job.facts.observable, () => this.release(mesh));
            if (!subscription) {
              this.skip('custom-observable');
              return;
            }
            this.retained.set(mesh, entries);
            this.retainedObservers.set(mesh, subscription);
          }
          entries.push(temporary);
          retained = true;
          return temporary;
        }
        this.counters.notReadyChecks++;
        const effect = temporary.effect,
          error = effect?.getCompilationError();
        if (error && effect?.allFallbacksProcessed()) throw new Error(error);
        if (performance.now() >= deadline) {
          this.counters.timedOut++;
          return;
        }
        // 原forceCompilation使用无法取消的16ms自重排；自有轮询可在Scene销毁时排空。
        await yieldUntilNextFrame(signal);
      }
      this.counters.cancelled++;
    } catch (error) {
      if (signal.aborted) this.counters.cancelled++;
      else {
        this.counters.failed++;
        this.counters.lastError = String(error instanceof Error ? error.message : error).slice(
          0,
          500,
        );
      }
    } finally {
      this.counters.active--;
      // addToMesh=false时原SubMesh.dispose会splice(-1,1)误删业务最后一项，故只清理自有draw cache。
      if (!retained) temporary.resetDrawCache(undefined, true);
    }
  }
  private release(mesh: Mesh): void {
    const observer = this.retainedObservers.get(mesh);
    if (observer) unsubscribe(observer);
    this.retainedObservers.delete(mesh);
    const entries = this.retained.get(mesh);
    if (!entries) return;
    this.retained.delete(mesh);
    for (const sub of entries) sub.resetDrawCache(undefined, true);
  }
}
