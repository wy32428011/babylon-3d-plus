import type { RemoteDownloadProgress } from '../../../../electron/shared/remoteDownloadProgress';
import { type SkyboxSyncProgress } from '../../assets/skyboxAssets';
import { type DataPlatformChartAssetEntry } from '../../assets/dataPlatformChartLibrary';

export type DataPlatformModelSyncProgress = {
  download?: RemoteDownloadProgress;
  runId: string;
  phase: 'querying' | 'downloading' | 'validating' | 'promoting' | 'completed' | 'failed';
  completed: number;
  total: number;
  message: string;
  error: string | null;
  libraryChanged?: boolean;
  runtimeChangedResourceKeys?: string[];
  changedResourceIds?: string[];
  changedCount?: number;
};

export type DataPlatformModelSyncApi = {
  syncDataPlatformModels?: () => Promise<boolean>;
  onDataPlatformModelSyncProgress?: (listener: (progress: DataPlatformModelSyncProgress) => void) => () => void;
  retryDataPlatformModelSync?: () => Promise<boolean>;
};

export type DataPlatformEnvironmentSyncProgress = {
  download?: RemoteDownloadProgress;
  runId: string;
  contextKey: string;
  phase: 'querying' | 'downloading' | 'validating' | 'promoting' | 'completed' | 'failed';
  completed: number;
  total: number;
  message: string;
  error: string | null;
};

export type DataPlatformEnvironmentSyncApi = {
  syncDataPlatformEnvironments?: () => Promise<boolean>;
  onDataPlatformEnvironmentSyncProgress?: (listener: (progress: DataPlatformEnvironmentSyncProgress) => void) => () => void;
  retryDataPlatformEnvironmentSync?: () => Promise<boolean>;
};

export type DataPlatformImageSyncProgress = {
  runId: string;
  phase: 'querying' | 'downloading' | 'validating' | 'promoting' | 'completed' | 'failed';
  completed: number;
  total: number;
  message: string;
  error: string | null;
};

export type DataPlatformImageSyncApi = {
  syncDataPlatformImages?: () => Promise<boolean>;
  onDataPlatformImageSyncProgress?: (listener: (progress: DataPlatformImageSyncProgress) => void) => () => void;
  retryDataPlatformImageSync?: () => Promise<boolean>;
};

export type DataPlatformChartLibrarySnapshot = {
  contextKey: string | null;
  projectId: string | null;
  projectName: string | null;
  syncedAt: string | null;
  charts: DataPlatformChartAssetEntry[];
};

export type DataPlatformChartSyncProgress = {
  runId: string;
  contextKey: string;
  phase: 'querying' | 'parsing' | 'promoting' | 'completed' | 'failed';
  completed: number;
  total: number;
  message: string;
  error: string | null;
};

export type DataPlatformChartSyncApi = {
  listDataPlatformCharts?: () => Promise<DataPlatformChartLibrarySnapshot>;
  syncDataPlatformCharts?: () => Promise<boolean>;
  retryDataPlatformChartSync?: () => Promise<boolean>;
  onDataPlatformChartSyncProgress?: (listener: (progress: DataPlatformChartSyncProgress) => void) => () => void;
};

export type DataPlatformSkyboxSyncProgress = SkyboxSyncProgress;

export type DataPlatformSkyboxSyncApi = {
  syncDataPlatformSkyboxes?: () => Promise<boolean>;
  retryDataPlatformSkyboxSync?: () => Promise<boolean>;
  onDataPlatformSkyboxSyncProgress?: (listener: (progress: unknown) => void) => () => void;
};

export const DATA_PLATFORM_MODEL_SYNC_PHASE_LABELS: Record<DataPlatformModelSyncProgress['phase'], string> = {
  querying: '查询模型',
  downloading: '下载模型',
  validating: '校验模型',
  promoting: '写入资源库',
  completed: '同步完成',
  failed: '同步失败',
};

export function getDataPlatformModelSyncApi(): DataPlatformModelSyncApi {
  return (window.editorApi ?? {}) as DataPlatformModelSyncApi;
}

export const DATA_PLATFORM_ENVIRONMENT_SYNC_PHASE_LABELS: Record<DataPlatformEnvironmentSyncProgress['phase'], string> = {
  querying: '查询环境模型',
  downloading: '下载环境模型',
  validating: '校验环境模型',
  promoting: '写入环境缓存',
  completed: '环境同步完成',
  failed: '环境同步失败',
};

export function getDataPlatformEnvironmentSyncApi(): DataPlatformEnvironmentSyncApi {
  return (window.editorApi ?? {}) as DataPlatformEnvironmentSyncApi;
}

export const DATA_PLATFORM_IMAGE_SYNC_PHASE_LABELS: Record<DataPlatformImageSyncProgress['phase'], string> = {
  querying: '查询图片',
  downloading: '下载图片',
  validating: '校验图片',
  promoting: '写入图片库',
  completed: '同步完成',
  failed: '同步失败',
};

export function getDataPlatformImageSyncApi(): DataPlatformImageSyncApi {
  return (window.editorApi ?? {}) as DataPlatformImageSyncApi;
}

export const DATA_PLATFORM_CHART_SYNC_PHASE_LABELS: Record<DataPlatformChartSyncProgress['phase'], string> = {
  querying: '查询项目大屏',
  parsing: '整理大屏资源',
  promoting: '写入大屏资源',
  completed: '大屏同步完成',
  failed: '大屏同步失败',
};

export function getDataPlatformChartSyncApi(): DataPlatformChartSyncApi {
  return (window.editorApi ?? {}) as DataPlatformChartSyncApi;
}

export const DATA_PLATFORM_SKYBOX_SYNC_PHASE_LABELS: Record<DataPlatformSkyboxSyncProgress['phase'], string> = {
  querying: '查询天空盒',
  downloading: '下载天空盒',
  validating: '校验天空盒',
  promoting: '写入天空盒库',
  completed: '同步完成',
  failed: '同步失败',
};

export function getDataPlatformSkyboxSyncApi(): DataPlatformSkyboxSyncApi {
  return (window.editorApi ?? {}) as DataPlatformSkyboxSyncApi;
}
