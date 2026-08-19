import type { FetchConfig } from '../editor/model/SceneDocument';
import type { DigitalTwinProjectRuntimeConfig } from './runtimeConfig';

type FetchDriveRuntime = {
  handleFetchDriveEvent(fetchConfig: FetchConfig): Promise<void>;
};

/**
 * 发布包内的地址作为初始值；数据中台设置了项目级地址时才实时覆盖。
 * 数字孪生 Viewer 不继承编辑器填写的 API Key；公开 DIST 包也会在生成时剥离该字段。
 */
export function resolvePublishedFetchConfig(
  publishedFetchConfig: FetchConfig,
  runtimeConfig: DigitalTwinProjectRuntimeConfig | null,
): FetchConfig {
  return {
    url: runtimeConfig?.apiBaseUrl ?? publishedFetchConfig.url,
    apiKey: '',
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
