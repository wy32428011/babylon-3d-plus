import type { AssetContainer, InstantiatedEntries } from '@babylonjs/core';
import type { ModelAssetComponent } from '../../editor/model/components';
import { cloneModelAssetContainer, estimateModelAssetContainerBytes, prepareModelAssetTemplate } from './cloneModelAssetContainer.ts';

/** 共享模型实例句柄；释放实例后会同步归还共享源资源引用。 */
export type SharedModelInstantiation = {
  entries: InstantiatedEntries;
  dispose: () => void;
};

type SharedModelSourceEntry = {
  promise: Promise<AssetContainer>;
  container: AssetContainer | null;
  referenceCount: number;
  disposed: boolean;
  estimatedBytes: number;
  idleOrder: number;
  controller: AbortController;
};

/**
 * 同一资源修订只解析一次；静态模型复用实例，参数/动画模型克隆独立工作容器。
 * 活动共享实例按引用持有源，空闲模板由条目数与内存预算淘汰，脚本生命周期仍由 SceneRuntime 管理。
 */
export class SharedModelAssetCache {
  private readonly maxIdleEntries: number;
  private readonly maxIdleBytes: number;
  private readonly entries = new Map<string, SharedModelSourceEntry>();
  private disposed = false;
  private hits = 0;
  private misses = 0;
  private instantiationCount = 0;
  private instantiationMs = 0;
  private ownedCloneCount = 0;
  private ownedCloneMs = 0;
  private idleOrder = 0;

  constructor(options: { maxIdleEntries?: number; maxIdleBytes?: number } = {}) {
    this.maxIdleEntries = Math.max(0, options.maxIdleEntries ?? 16);
    this.maxIdleBytes = Math.max(0, options.maxIdleBytes ?? 128 * 1024 * 1024);
    if (!Number.isInteger(this.maxIdleEntries) || !Number.isFinite(this.maxIdleBytes)) {
      throw new RangeError('模型模板缓存预算必须是有限非负数，条目数必须是整数。');
    }
  }

  getMetrics() {
    const idleEntries = [...this.entries.values()].filter(entry => entry.referenceCount === 0);
    return { hits: this.hits, misses: this.misses, entries: this.entries.size,
      instantiationCount: this.instantiationCount, instantiationMs: this.instantiationMs,
      ownedCloneCount: this.ownedCloneCount, ownedCloneMs: this.ownedCloneMs,
      idleEntries: idleEntries.length, idleBytes: idleEntries.reduce((bytes, entry) => bytes + entry.estimatedBytes, 0) };
  }

  /** 参数模型共享解析结果，但其工作容器和脚本可变资源按实例完全隔离。 */
  async acquireOwnedContainer(
    key: string,
    loader: (signal: AbortSignal) => Promise<AssetContainer>,
    signal?: AbortSignal,
  ): Promise<AssetContainer> {
    this.assertAvailable(signal);
    const entry = this.acquireEntry(key, loader);
    try {
      const source = await this.waitForSource(entry, signal);
      this.assertAvailable(signal);
      if (entry.disposed) throw new Error('模型解析模板已失效。');
      const startedAt = performance.now();
      const container = cloneModelAssetContainer(source);
      this.ownedCloneCount += 1;
      this.ownedCloneMs += performance.now() - startedAt;
      return container;
    } finally {
      this.releaseEntry(key, entry);
    }
  }

  /** 获取共享源容器并创建一个独立实体实例。 */
  async instantiate(
    key: string,
    loader: (signal: AbortSignal) => Promise<AssetContainer>,
    nameFunction: (sourceName: string) => string,
    signal?: AbortSignal,
  ): Promise<SharedModelInstantiation> {
    this.assertAvailable(signal);

    const entry = this.acquireEntry(key, loader);
    try {
      const container = await this.waitForSource(entry, signal);
      this.assertAvailable(signal);
      if (this.disposed || entry.disposed || this.entries.get(key) !== entry) {
        throw new Error('共享模型源资源在实例创建前已失效。');
      }

      const startedAt = performance.now();
      // 即使组件没有脚本元数据，GLB 仍可能自带动画；动画目标必须指向独立资源。
      const animatedContainer = container.animationGroups.length > 0 ? cloneModelAssetContainer(container) : null;
      if (animatedContainer) {
        for (const root of animatedContainer.rootNodes) {
          for (const node of [root, ...root.getDescendants()]) node.name = nameFunction(node.name);
        }
        for (const group of animatedContainer.animationGroups) group.name = nameFunction(group.name);
        for (const skeleton of animatedContainer.skeletons) skeleton.name = nameFunction(skeleton.name);
        animatedContainer.addAllToScene();
      }
      const instantiatedEntries: InstantiatedEntries = animatedContainer ? {
        rootNodes: animatedContainer.rootNodes,
        skeletons: animatedContainer.skeletons,
        animationGroups: animatedContainer.animationGroups,
        dispose: () => animatedContainer.dispose(),
      } : container.instantiateModelsToScene(nameFunction, false, { doNotInstantiate: false });
      this.instantiationCount += 1;
      this.instantiationMs += performance.now() - startedAt;
      let instanceDisposed = false;

      return {
        entries: instantiatedEntries,
        dispose: () => {
          if (instanceDisposed) return;
          instanceDisposed = true;
          try {
            instantiatedEntries.dispose();
          } finally {
            this.releaseEntry(key, entry);
          }
        },
      };
    } catch (error) {
      this.releaseEntry(key, entry);
      throw error;
    }
  }

  /** 释放缓存入口；活动实例持有的源资源延迟到最后一次引用归还后再释放。 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    for (const entry of this.entries.values()) {
      if (!entry.container || entry.referenceCount === 0) {
        this.disposeSourceEntry(entry);
      }
    }
    this.entries.clear();
  }

  /** 获取或创建指定资源键的共享源条目，并增加一次活动引用。 */
  private acquireEntry(key: string, loader: (signal: AbortSignal) => Promise<AssetContainer>): SharedModelSourceEntry {
    const cached = this.entries.get(key);
    if (cached && !cached.disposed) {
      this.hits += 1;
      cached.referenceCount += 1;
      return cached;
    }

    this.misses += 1;
    const entry: SharedModelSourceEntry = {
      promise: Promise.resolve(null as unknown as AssetContainer),
      container: null,
      referenceCount: 1,
      disposed: false,
      estimatedBytes: 0,
      idleOrder: 0,
      controller: new AbortController(),
    };
    // 延后调用避免同步抛错/重入发生在 Map 注册前；同资源的并发调用共享同一任务。
    entry.promise = Promise.resolve().then(() => loader(entry.controller.signal))
      .then((container) => {
        if (this.disposed || entry.disposed) {
          container.dispose();
          throw new Error('共享模型源资源加载完成时缓存已释放。');
        }
        entry.container = container;
        prepareModelAssetTemplate(container);
        entry.estimatedBytes = estimateModelAssetContainerBytes(container);
        if (entry.referenceCount === 0) this.trimIdleEntries();
        return container;
      })
      .catch((error) => {
        if (this.entries.get(key) === entry) {
          this.entries.delete(key);
        }
        throw error;
      });
    this.entries.set(key, entry);
    return entry;
  }

  /** 归还活动引用；未完成且无人等待的任务失效，完成模板受空闲预算限制。 */
  private releaseEntry(key: string, entry: SharedModelSourceEntry): void {
    if (entry.referenceCount > 0) {
      entry.referenceCount -= 1;
    }
    if (entry.referenceCount > 0 || entry.disposed) return;

    if (this.disposed || !entry.container || this.entries.get(key) !== entry) {
      if (this.entries.get(key) === entry) this.entries.delete(key);
      this.disposeSourceEntry(entry);
    } else {
      entry.idleOrder = ++this.idleOrder;
      this.trimIdleEntries();
    }
  }

  private trimIdleEntries(): void {
    const idle = [...this.entries].filter(([, entry]) => entry.referenceCount === 0)
      .sort((a, b) => a[1].idleOrder - b[1].idleOrder);
    let bytes = idle.reduce((total, [, entry]) => total + entry.estimatedBytes, 0);
    let count = idle.length;
    for (const [key, entry] of idle) {
      if (count <= this.maxIdleEntries && bytes <= this.maxIdleBytes) break;
      this.entries.delete(key);
      this.disposeSourceEntry(entry);
      count -= 1;
      bytes -= entry.estimatedBytes;
    }
  }

  private assertAvailable(signal?: AbortSignal): void {
    if (signal?.aborted) throw new DOMException('模型实例加载已取消。', 'AbortError');
    if (this.disposed) throw new Error('共享模型资源缓存已释放。');
  }

  /** 取消仅结束当前等待者；其它同源请求仍共享一次解析。 */
  private waitForSource(entry: SharedModelSourceEntry, signal?: AbortSignal): Promise<AssetContainer> {
    if (!signal) return entry.promise;
    return new Promise((resolve, reject) => {
      const abort = () => { cleanup(); reject(new DOMException('模型实例加载已取消。', 'AbortError')); };
      const cleanup = () => signal.removeEventListener('abort', abort);
      signal.addEventListener('abort', abort, { once: true });
      entry.promise.then(container => { cleanup(); resolve(container); }, error => { cleanup(); reject(error); });
      if (signal.aborted) abort();
    });
  }

  /** 幂等释放单个共享源条目。 */
  private disposeSourceEntry(entry: SharedModelSourceEntry): void {
    if (entry.disposed) return;
    entry.disposed = true;
    entry.controller.abort();
    entry.container?.dispose();
    entry.container = null;
  }
}

export function createModelAssetTemplateKey(modelAsset: ModelAssetComponent): string {
  const identity = modelAsset.dataPlatformModel;
  // 完整包 SHA 优先保证 SOURCE 固定快照不与后台最新修订混淆。无修订资源按 URL 隔离。
  const revision = modelAsset.sourceSnapshot?.contentSha256 ?? modelAsset.assetRevision;
  return identity && revision
    ? JSON.stringify([identity.sourceKey, identity.kind, identity.resourceId, identity.modelPath, revision])
    : JSON.stringify([modelAsset.sourceUrl, revision ?? null]);
}

/** 模型共享实例的最终准入模式；shared-instance 复用源容器，owned-container 独占容器和脚本生命周期。 */
export type ModelAssetSharedInstancingMode = 'shared-instance' | 'owned-container';

/** 模型共享策略判定原因，用于 smoke 和后续接入方精确解释准入边界。 */
export type ModelAssetSharedInstancingReason =
  | 'plain-static-model'
  | 'script-assets'
  | 'parameter-config'
  | 'parameter-script-metadata'
  | 'animation-script-metadata';

/** 模型共享策略快照结果，只表达准入结论，不触碰运行时场景或外部资源。 */
export type ModelAssetSharedInstancingPolicy = {
  mode: ModelAssetSharedInstancingMode;
  reason: ModelAssetSharedInstancingReason;
};

/**
 * 基于 ModelAssetComponent 快照判定模型是否可安全进入共享实例路径。
 * 携带脚本或参数元数据的模型必须独占容器：脚本可能改写几何（如 Shelf 的顶点拉伸），
 * 共享实例会把改写扩散到全部同源实例。
 */
export function resolveModelAssetSharedInstancingPolicy(
  modelAsset: ModelAssetComponent,
): ModelAssetSharedInstancingPolicy {
  const blockingReason = findOwnedContainerReason(modelAsset);
  if (blockingReason) {
    return { mode: 'owned-container', reason: blockingReason };
  }

  return { mode: 'shared-instance', reason: 'plain-static-model' };
}

/** 判断模型策略是否允许共享实例，便于调用方不重复理解 reason 枚举。 */
export function shouldUseSharedModelInstantiation(modelAsset: ModelAssetComponent): boolean {
  return resolveModelAssetSharedInstancingPolicy(modelAsset).mode === 'shared-instance';
}

/** 找出普通模型必须独占容器的第一个动态能力字段；只读取资产组件快照。 */
function findOwnedContainerReason(modelAsset: ModelAssetComponent): ModelAssetSharedInstancingReason | null {
  if (hasArrayEntries(modelAsset.scriptAssets)) return 'script-assets';
  if (modelAsset.parameterConfig != null) return 'parameter-config';
  if (hasArrayEntries(modelAsset.parameterScriptMetadata)) return 'parameter-script-metadata';
  if (hasArrayEntries(modelAsset.animationScriptMetadata)) return 'animation-script-metadata';
  return null;
}

/** 判断快照数组字段是否真实携带条目；空数组等同于未启用该动态能力。 */
function hasArrayEntries(value: readonly unknown[] | undefined | null): boolean {
  return Array.isArray(value) && value.length > 0;
}
