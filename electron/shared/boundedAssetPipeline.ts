type AssetPipelineOptions<TAsset, TDependency, TResult> = {
  assets: readonly TAsset[];
  dependencies: (asset: TAsset) => readonly TDependency[];
  transfer: (dependency: TDependency) => Promise<void>;
  validate: (asset: TAsset) => Promise<TResult>;
  transferConcurrency: number;
  validationConcurrency: number;
  maxActiveAssets: number;
  assertActive: () => void;
};

/**
 * 每个资产的依赖全部传输完成后立即校验；活动资产上限同时限制已下载待校验的积压。
 * 首个失败后停止派发，并等待所有在途写盘结束，由调用方统一提交或清理事务。
 */
export async function runBoundedAssetPipeline<TAsset, TDependency, TResult>(
  options: AssetPipelineOptions<TAsset, TDependency, TResult>,
): Promise<TResult[]> {
  for (const limit of [options.transferConcurrency, options.validationConcurrency, options.maxActiveAssets]) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('资产流水线并发上限必须是正整数。');
  }
  type State = {
    asset: TAsset; index: number; dependencies: readonly TDependency[];
    nextDependency: number; remaining: number; validating: boolean;
  };
  const active = new Set<State>();
  const running = new Set<Promise<void>>();
  const results: TResult[] = new Array(options.assets.length);
  let nextAsset = 0;
  let transfers = 0;
  let validations = 0;
  let failed = false;
  let firstError: unknown;
  const fail = (error: unknown) => {
    if (!failed) { failed = true; firstError = error; }
  };
  const launch = (work: () => Promise<void>) => {
    const pending = (async () => {
      try { await work(); } catch (error) { fail(error); }
    })();
    running.add(pending);
    void pending.then(() => running.delete(pending));
  };

  while (!failed) {
    try {
      options.assertActive();
      while (nextAsset < options.assets.length && active.size < options.maxActiveAssets) {
        const index = nextAsset++;
        const asset = options.assets[index];
        const dependencies = options.dependencies(asset);
        active.add({ asset, index, dependencies, nextDependency: 0, remaining: dependencies.length, validating: false });
      }
      for (const state of active) {
        while (state.nextDependency < state.dependencies.length && transfers < options.transferConcurrency) {
          const dependency = state.dependencies[state.nextDependency++];
          transfers += 1;
          launch(async () => {
            try {
              options.assertActive();
              await options.transfer(dependency);
              options.assertActive();
              state.remaining -= 1;
            } finally { transfers -= 1; }
          });
        }
        if (state.remaining === 0 && !state.validating && validations < options.validationConcurrency) {
          state.validating = true;
          validations += 1;
          launch(async () => {
            try {
              options.assertActive();
              const result = await options.validate(state.asset);
              options.assertActive();
              results[state.index] = result;
              active.delete(state);
            } finally { validations -= 1; }
          });
        }
      }
    } catch (error) { fail(error); }
    if (!running.size) break;
    await Promise.race(running);
  }
  // 下载器可能需要异步响应取消；清理暂存目录前必须等其释放文件句柄。
  await Promise.all(running);
  if (failed) throw firstError;
  options.assertActive();
  return results;
}
