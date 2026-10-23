import type {
  ModelAssetComponent,
  ModelGeneratorComponent,
  ModelGeneratorTarget,
} from '../../editor/model/components.ts';

type AssetLease = { dispose(): void };
type PreloadTarget = Exclude<ModelGeneratorTarget, { kind: 'mesh' }>;
type PreparationStatus = 'pending' | 'ready' | 'failed';

export type ModelGeneratorAssetPreloaderDependencies = {
  preload(modelAsset: ModelAssetComponent, signal: AbortSignal): Promise<AssetLease>;
  getAssetKey(modelAsset: ModelAssetComponent): string;
  loadCompositionModels(target: Extract<ModelGeneratorTarget, { kind: 'composition' }>): Promise<readonly ModelAssetComponent[]>;
  onError(error: unknown, target: ModelGeneratorTarget): void;
  onChange?(): void;
};

export type ModelGeneratorAssetPreloaderMetrics = {
  /** 当前有效配置中尚未完成的组合解析与资产预取作业数。 */
  pendingCount: number;
  /** 当前持有的资产引用数；不同生成器分别持有一个引用。 */
  readyAssetCount: number;
  failedCount: number;
};

type TargetPreparation = { target: PreloadTarget; status: PreparationStatus };
type AssetPreparation = {
  modelAsset: ModelAssetComponent;
  target: PreloadTarget;
  status: PreparationStatus;
  lease?: AssetLease;
};
type GeneratorPreparation = {
  signature: string;
  controller: AbortController;
  targets: TargetPreparation[];
  assets: Map<string, AssetPreparation>;
};
type ReadyWaiter = { resolve(): void; detachAbort(): void };

/**
 * 只预取生成器可能使用的资产并持有引用，不创建货物、执行脚本或改变默认回退。
 * 配置换代只保留当前代次的工作；底层缓存仍负责不同生成器间的资源共享。
 */
export class ModelGeneratorAssetPreloader {
  private readonly dependencies: ModelGeneratorAssetPreloaderDependencies;
  private readonly generators = new Map<string, GeneratorPreparation>();
  private readonly waiters = new Set<ReadyWaiter>();
  private disposed = false;

  constructor(dependencies: ModelGeneratorAssetPreloaderDependencies) {
    this.dependencies = dependencies;
  }

  /** 同一生成器的签名不变时，复用已完成、进行中和失败的准备结果。 */
  sync(generatorId: string, component: ModelGeneratorComponent, signature: string): void {
    if (this.disposed) return;
    const previous = this.generators.get(generatorId);
    if (previous?.signature === signature) return;

    const preparation: GeneratorPreparation = {
      signature,
      controller: new AbortController(),
      targets: this.collectTargets(component).map((target) => ({ target, status: 'pending' })),
      assets: new Map(),
    };
    // 先替换当前代次，防止旧作业取消时把新配置误判为已就绪。
    this.generators.set(generatorId, preparation);
    if (previous) this.releaseGenerator(previous);
    for (const target of preparation.targets) void this.prepareTarget(generatorId, preparation, target);
    this.notifyChange();
  }

  /** 删除生成器并归还其全部引用；未完成作业的晚到结果不会重新进入缓存持有表。 */
  remove(generatorId: string): void {
    const preparation = this.generators.get(generatorId);
    if (!preparation) return;
    this.generators.delete(generatorId);
    this.releaseGenerator(preparation);
    this.notifyChange();
  }

  /** 仅重试失败的组合解析和资产预取，保留成功引用与尚未完成的作业。 */
  retryFailed(): void {
    if (this.disposed) return;
    for (const [generatorId, preparation] of this.generators) {
      const targets = preparation.targets.filter((target) => target.status === 'failed');
      const assets = [...preparation.assets.values()].filter((asset) => asset.status === 'failed');
      for (const target of targets) target.status = 'pending';
      for (const asset of assets) asset.status = 'pending';
      for (const target of targets) void this.prepareTarget(generatorId, preparation, target);
      for (const asset of assets) void this.preloadAsset(generatorId, preparation, asset);
    }
    this.notifyChange();
  }

  /** 等待当前有效配置完成；失败属于已完成，调用方取消仅取消自身等待。 */
  waitForReady(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException('准备等待已取消', 'AbortError'));
    if (this.getMetrics().pendingCount === 0) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        this.waiters.delete(waiter);
        waiter.detachAbort();
        reject(signal?.reason ?? new DOMException('准备等待已取消', 'AbortError'));
      };
      const waiter: ReadyWaiter = {
        resolve,
        detachAbort: () => signal?.removeEventListener('abort', onAbort),
      };
      this.waiters.add(waiter);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  getMetrics(): ModelGeneratorAssetPreloaderMetrics {
    const metrics = { pendingCount: 0, readyAssetCount: 0, failedCount: 0 };
    for (const preparation of this.generators.values()) {
      for (const target of preparation.targets) {
        if (target.status === 'pending') metrics.pendingCount += 1;
        if (target.status === 'failed') metrics.failedCount += 1;
      }
      for (const asset of preparation.assets.values()) {
        if (asset.status === 'pending') metrics.pendingCount += 1;
        if (asset.status === 'ready') metrics.readyAssetCount += 1;
        if (asset.status === 'failed') metrics.failedCount += 1;
      }
    }
    return metrics;
  }

  /** 取消并归还全部生成器引用，同时结束所有当前就绪等待。 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const preparations = [...this.generators.values()];
    this.generators.clear();
    for (const preparation of preparations) this.releaseGenerator(preparation);
    this.notifyChange();
  }

  private collectTargets(component: ModelGeneratorComponent): PreloadTarget[] {
    const targets: PreloadTarget[] = [];
    const compositions = new Set<string>();
    for (const target of [component.defaultTarget, ...component.rules.map((rule) => rule.target)]) {
      if (!target || target.kind === 'mesh') continue;
      if (target.kind === 'composition') {
        const key = JSON.stringify([target.libraryId, target.revision]);
        if (compositions.has(key)) continue;
        compositions.add(key);
      }
      targets.push(target);
    }
    return targets;
  }

  private async prepareTarget(
    generatorId: string,
    preparation: GeneratorPreparation,
    targetPreparation: TargetPreparation,
  ): Promise<void> {
    const { target } = targetPreparation;
    try {
      const assets = target.kind === 'model'
        ? [{ assetCode: '__cargo_preload__', ...target.modelAsset }]
        : await this.dependencies.loadCompositionModels(target);
      if (!this.isCurrent(generatorId, preparation)) return;
      for (const modelAsset of assets) this.enqueueAsset(generatorId, preparation, modelAsset, target);
      targetPreparation.status = 'ready';
    } catch (error) {
      if (!this.isCurrent(generatorId, preparation)) return;
      targetPreparation.status = 'failed';
      this.reportError(error, target);
    } finally {
      if (this.isCurrent(generatorId, preparation)) this.notifyChange();
    }
  }

  private enqueueAsset(
    generatorId: string,
    preparation: GeneratorPreparation,
    modelAsset: ModelAssetComponent,
    target: PreloadTarget,
  ): void {
    const key = this.dependencies.getAssetKey(modelAsset);
    if (preparation.assets.has(key)) return;
    const asset: AssetPreparation = { modelAsset, target, status: 'pending' };
    preparation.assets.set(key, asset);
    void this.preloadAsset(generatorId, preparation, asset);
  }

  private async preloadAsset(
    generatorId: string,
    preparation: GeneratorPreparation,
    asset: AssetPreparation,
  ): Promise<void> {
    try {
      const lease = await this.dependencies.preload(asset.modelAsset, preparation.controller.signal);
      if (!this.isCurrent(generatorId, preparation)) {
        lease.dispose();
        return;
      }
      asset.lease = lease;
      asset.status = 'ready';
    } catch (error) {
      if (!this.isCurrent(generatorId, preparation)) return;
      asset.status = 'failed';
      this.reportError(error, asset.target);
    } finally {
      if (this.isCurrent(generatorId, preparation)) this.notifyChange();
    }
  }

  private isCurrent(generatorId: string, preparation: GeneratorPreparation): boolean {
    return this.generators.get(generatorId) === preparation && !preparation.controller.signal.aborted;
  }

  private releaseGenerator(preparation: GeneratorPreparation): void {
    preparation.controller.abort();
    for (const asset of preparation.assets.values()) {
      asset.lease?.dispose();
      asset.lease = undefined;
    }
    preparation.assets.clear();
  }

  private notifyChange(): void {
    try {
      this.dependencies.onChange?.();
    } catch (error) {
      // 进度订阅只观察状态，不能把已完成的准备作业变成失败或阻止等待结算。
      console.warn('[Scene load] 货物预取进度观察者失败。', error);
    }
    // 观察者可能同步切换生成器配置；必须在回调结束后重新检查当前有效工作。
    if (this.getMetrics().pendingCount > 0) return;
    for (const waiter of this.waiters) {
      waiter.detachAbort();
      waiter.resolve();
    }
    this.waiters.clear();
  }

  private reportError(error: unknown, target: PreloadTarget): void {
    try {
      this.dependencies.onError(error, target);
    } catch (observerError) {
      // 错误日志订阅失败仍只记录一次，保留原始预取失败状态并避免后台未处理拒绝。
      console.warn('[Scene load] 货物预取错误观察者失败。', observerError);
    }
  }
}
