import type { FetchConfig } from '../editor/model/SceneDocument';
import type { DigitalTwinProjectRuntimeConfig } from './runtimeConfig';

type FetchDriveRuntime = {
  handleFetchDriveEvent(fetchConfig: FetchConfig): Promise<void>;
};

/**
 * 发布包内的地址作为初始值；数据中台设置了项目级地址时才实时覆盖。
 * 数字孪生 Viewer 不继承编辑器填写的 API Key；公开 DIST 包也会在生成时剥离该字段。
 * 定时同步间隔沿用发布包内的场景配置（逐字段枚举，避免将来新增字段被动下发）。
 */
export function resolvePublishedFetchConfig(
  publishedFetchConfig: FetchConfig,
  runtimeConfig: DigitalTwinProjectRuntimeConfig | null,
): FetchConfig {
  return {
    url: runtimeConfig?.apiBaseUrl ?? publishedFetchConfig.url,
    apiKey: '',
    syncIntervalSeconds: publishedFetchConfig.syncIntervalSeconds,
  };
}

/** 在运行态已就绪后执行一次发布场景的 Fetch 数据同步。 */
export function startPublishedFetchDrive(
  runtime: FetchDriveRuntime,
  fetchConfig: FetchConfig,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return runtime.handleFetchDriveEvent(fetchConfig);
}
