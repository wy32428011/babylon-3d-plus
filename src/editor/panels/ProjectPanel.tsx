import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import {
  beginSceneModelAssetRefresh,
  beginScenePreparation,
  settleSceneModelAssetRefresh,
  skipSceneModelSync,
} from '../loading/scenePreparationProgress';
import {
  BUILT_IN_ASSET_DRAG_MIME_TYPE,
  ENVIRONMENT_MODEL_ASSET_DRAG_MIME_TYPE,
  IMAGE_ASSET_DRAG_MIME_TYPE,
  SKYBOX_ASSET_DRAG_MIME_TYPE,
  encodeBuiltInAssetDragPayload,
  encodeImageAssetDragPayload,
  encodeModelAssetDragPayload,
  encodeSkyboxAssetDragPayload,
  MODEL_ASSET_DRAG_MIME_TYPE,
  type AssetEntry,
  type ProjectModelAssetEntry,
  type ProjectSkyboxAssetEntry,
} from '../assets/AssetDatabase';
import { loadEnvironmentFromAsset } from '../assets/environmentAssets';
import { getSceneSkyboxSettings } from '../model/SceneDocument';
import {
  createSceneSkyboxFromAsset,
  findOrphanedSkyboxForSettings,
  findSkyboxAssetForSettings,
  formatSkyboxSyncError,
  formatSkyboxSyncProgressCount,
  refreshCurrentSkyboxAfterProjectAssetsLoad,
  type SkyboxSyncProgress,
} from '../assets/skyboxAssets';
import {
  createSkyboxSyncController,
  type SkyboxSyncApplyResult,
  type SkyboxSyncController,
  type SkyboxSyncControllerState,
} from '../assets/skyboxSyncController';
import { createImportedAssetIndexes, findImportedAssetForPackagePath } from '../assets/modelAssetRelink';
import {
  filterProjectModelsForSyncRefresh,
  shouldRefreshProjectModelsAfterSync,
} from '../assets/modelSyncRefreshPolicy';
import {
  BUILT_IN_MODEL_LIBRARY_ITEMS,
  PROJECT_LIBRARIES,
  createImageLibraryItems,
  createModelLibraryItems,
  createSkyboxLibraryItems,
  createSyncedImageLibraryItems,
  getModelUnitTitle,
  isBuiltInImageProjectLibraryItem,
  isBuiltInProjectLibraryItem,
  isImportedProjectLibraryItem,
  isSyncedImageProjectLibraryItem,
  type ProjectLibraryItem,
  type ProjectLibraryKey,
} from '../assets/projectLibrary';
import {
  createModelDeviceTypeOptions,
  matchesModelDeviceType,
} from '../assets/modelLibraryDeviceTypeFilter';
import {
  createDataPlatformChartLibraryItems,
  isDataPlatformChartLibraryItem,
  matchesDataPlatformChartLibrarySearch,
  type DataPlatformChartAssetEntry,
} from '../assets/dataPlatformChartLibrary';
import { setSyncedImageAssets } from '../../assets/syncedImageAssets';
import { useEditorStore } from '../store/editorStore';
import { ResourceCard } from '../ui/ResourceCard';

type LibraryStatus = {
  message: string;
  kind: 'info' | 'error';
};

type ImportableProjectLibraryKey = 'model' | 'environment' | 'skybox';

type LibraryStatusMap = Record<ImportableProjectLibraryKey, LibraryStatus | null>;

type ProjectAssetsLoadResult =
  | { ok: true; skyboxes: ProjectSkyboxAssetEntry[] }
  | { ok: false; error: string };

type ProjectAssetsLoadOptions = {
  refreshModels?: boolean;
  modelResourceKeys?: readonly string[] | null;
  refreshEnvironment?: boolean;
  refreshSkybox?: boolean;
};

type DataPlatformModelSyncProgress = {
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

type DataPlatformModelSyncApi = {
  onDataPlatformModelSyncProgress?: (listener: (progress: DataPlatformModelSyncProgress) => void) => () => void;
  retryDataPlatformModelSync?: () => Promise<boolean>;
};

type DataPlatformEnvironmentSyncProgress = {
  runId: string;
  contextKey: string;
  phase: 'querying' | 'downloading' | 'validating' | 'promoting' | 'completed' | 'failed';
  completed: number;
  total: number;
  message: string;
  error: string | null;
};

type DataPlatformEnvironmentSyncApi = {
  onDataPlatformEnvironmentSyncProgress?: (listener: (progress: DataPlatformEnvironmentSyncProgress) => void) => () => void;
  retryDataPlatformEnvironmentSync?: () => Promise<boolean>;
};

type DataPlatformImageSyncProgress = {
  runId: string;
  phase: 'querying' | 'downloading' | 'validating' | 'promoting' | 'completed' | 'failed';
  completed: number;
  total: number;
  message: string;
  error: string | null;
};

type DataPlatformImageSyncApi = {
  syncDataPlatformImages?: () => Promise<boolean>;
  onDataPlatformImageSyncProgress?: (listener: (progress: DataPlatformImageSyncProgress) => void) => () => void;
  retryDataPlatformImageSync?: () => Promise<boolean>;
};

type DataPlatformChartLibrarySnapshot = {
  contextKey: string | null;
  projectId: string | null;
  projectName: string | null;
  syncedAt: string | null;
  charts: DataPlatformChartAssetEntry[];
};

type DataPlatformChartSyncProgress = {
  runId: string;
  contextKey: string;
  phase: 'querying' | 'parsing' | 'promoting' | 'completed' | 'failed';
  completed: number;
  total: number;
  message: string;
  error: string | null;
};

type DataPlatformChartSyncApi = {
  listDataPlatformCharts?: () => Promise<DataPlatformChartLibrarySnapshot>;
  syncDataPlatformCharts?: () => Promise<boolean>;
  retryDataPlatformChartSync?: () => Promise<boolean>;
  onDataPlatformChartSyncProgress?: (listener: (progress: DataPlatformChartSyncProgress) => void) => () => void;
};

type DataPlatformSkyboxSyncProgress = SkyboxSyncProgress;

type DataPlatformSkyboxSyncApi = {
  syncDataPlatformSkyboxes?: () => Promise<boolean>;
  retryDataPlatformSkyboxSync?: () => Promise<boolean>;
  onDataPlatformSkyboxSyncProgress?: (listener: (progress: unknown) => void) => () => void;
};

const DATA_PLATFORM_MODEL_SYNC_PHASE_LABELS: Record<DataPlatformModelSyncProgress['phase'], string> = {
  querying: '查询模型',
  downloading: '下载模型',
  validating: '校验模型',
  promoting: '写入资源库',
  completed: '同步完成',
  failed: '同步失败',
};

function getDataPlatformModelSyncApi(): DataPlatformModelSyncApi {
  return (window.editorApi ?? {}) as DataPlatformModelSyncApi;
}

const DATA_PLATFORM_ENVIRONMENT_SYNC_PHASE_LABELS: Record<DataPlatformEnvironmentSyncProgress['phase'], string> = {
  querying: '查询环境模型',
  downloading: '下载环境模型',
  validating: '校验环境模型',
  promoting: '写入环境缓存',
  completed: '环境同步完成',
  failed: '环境同步失败',
};

function getDataPlatformEnvironmentSyncApi(): DataPlatformEnvironmentSyncApi {
  return (window.editorApi ?? {}) as DataPlatformEnvironmentSyncApi;
}

const DATA_PLATFORM_IMAGE_SYNC_PHASE_LABELS: Record<DataPlatformImageSyncProgress['phase'], string> = {
  querying: '查询图片',
  downloading: '下载图片',
  validating: '校验图片',
  promoting: '写入图片库',
  completed: '同步完成',
  failed: '同步失败',
};

function getDataPlatformImageSyncApi(): DataPlatformImageSyncApi {
  return (window.editorApi ?? {}) as DataPlatformImageSyncApi;
}

const DATA_PLATFORM_CHART_SYNC_PHASE_LABELS: Record<DataPlatformChartSyncProgress['phase'], string> = {
  querying: '查询项目大屏',
  parsing: '整理大屏资源',
  promoting: '写入大屏资源',
  completed: '大屏同步完成',
  failed: '大屏同步失败',
};

function getDataPlatformChartSyncApi(): DataPlatformChartSyncApi {
  return (window.editorApi ?? {}) as DataPlatformChartSyncApi;
}

const DATA_PLATFORM_SKYBOX_SYNC_PHASE_LABELS: Record<DataPlatformSkyboxSyncProgress['phase'], string> = {
  querying: '查询天空盒',
  downloading: '下载天空盒',
  validating: '校验天空盒',
  promoting: '写入天空盒库',
  completed: '同步完成',
  failed: '同步失败',
};

function getDataPlatformSkyboxSyncApi(): DataPlatformSkyboxSyncApi {
  return (window.editorApi ?? {}) as DataPlatformSkyboxSyncApi;
}

type ProjectPanelProps = {
  readOnly?: boolean;
};

export function ProjectPanel(props: ProjectPanelProps) {
  const importModelAsset = useEditorStore((state) => state.importModelAsset);
  const refreshModelInstancesFromAssets = useEditorStore((state) => state.refreshModelInstancesFromAssets);
  const requestEnvironmentApply = useEditorStore((state) => state.requestEnvironmentApply);
  const updateSkyboxConfig = useEditorStore((state) => state.updateSkyboxConfig);
  const placeSkybox = useEditorStore((state) => state.placeSkybox);
  const sceneDocument = useEditorStore((state) => state.scene);
  const sceneSessionId = useEditorStore((state) => state.sceneSessionId);
  const currentSkybox = useMemo(() => getSceneSkyboxSettings(sceneDocument), [sceneDocument]);
  const createMesh = useEditorStore((state) => state.createMesh);
  const createLocator = useEditorStore((state) => state.createLocator);
  const createLight = useEditorStore((state) => state.createLight);
  const createModelGenerator = useEditorStore((state) => state.createModelGenerator);
  const createAutoPatrol = useEditorStore((state) => state.createAutoPatrol);
  const createManualRoamSpawn = useEditorStore((state) => state.createManualRoamSpawn);
  const createPoiEffect = useEditorStore((state) => state.createPoiEffect);
  const createClickEventBinding = useEditorStore((state) => state.createClickEventBinding);
  const projectAssetFocusRequest = useEditorStore((state) => state.projectAssetFocusRequest);
  const consumeProjectAssetFocusRequest = useEditorStore((state) => state.consumeProjectAssetFocusRequest);
  const pushLog = useEditorStore((state) => state.pushLog);
  const resourceCardRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const projectAssetsLoadRequestRef = useRef(0);
  const sceneSessionIdRef = useRef(sceneSessionId);
  sceneSessionIdRef.current = sceneSessionId;
  const skyboxSyncControllerRef = useRef<SkyboxSyncController | null>(null);
  const modelSyncCompletedDismissTimerRef = useRef<number | null>(null);
  const lastSceneRefreshModelSyncRunIdRef = useRef<string | null>(null);
  const environmentSyncCompletedDismissTimerRef = useRef<number | null>(null);
  const lastSceneRefreshEnvironmentSyncRunIdRef = useRef<string | null>(null);
  const imageSyncCompletedDismissTimerRef = useRef<number | null>(null);
  const lastSceneRefreshImageSyncRunIdRef = useRef<string | null>(null);
  const chartLibraryLoadRequestRef = useRef(0);
  const chartSyncContextKeyRef = useRef<string | null>(null);
  const autoChartSyncContextKeyRef = useRef<string | null>(null);
  const chartSyncCompletedDismissTimerRef = useRef<number | null>(null);
  const lastChartSyncReloadRunIdRef = useRef<string | null>(null);
  const initialProjectAssetsLoadPromiseRef = useRef<Promise<ProjectAssetsLoadResult> | null>(null);
  const waitForInitialProjectAssetsLoad = useCallback(async (
    expectedSceneSessionId: string,
  ): Promise<boolean> => {
    const initialLoadPromise = initialProjectAssetsLoadPromiseRef.current;
    await initialLoadPromise;
    return initialProjectAssetsLoadPromiseRef.current === initialLoadPromise
      && sceneSessionIdRef.current === expectedSceneSessionId;
  }, []);
  const [activeLibraryKey, setActiveLibraryKey] = useState<ProjectLibraryKey>('model');
  const [libraryFilterText, setLibraryFilterText] = useState('');
  const [modelDeviceTypeFilter, setModelDeviceTypeFilter] = useState('');
  const [projectAssets, setProjectAssets] = useState<ProjectModelAssetEntry[]>([]);
  const [skyboxAssets, setSkyboxAssets] = useState<ProjectSkyboxAssetEntry[]>([]);
  const [orphanedSkyboxAssets, setOrphanedSkyboxAssets] = useState<ProjectSkyboxAssetEntry[]>([]);
  const [focusedAssetId, setFocusedAssetId] = useState<string | null>(null);
  const [projectRoot, setProjectRoot] = useState<string | null>(null);
  const [skyboxSyncContextBinding, setSkyboxSyncContextBinding] = useState(() => ({
    sceneSessionId,
    key: null as string | null,
  }));
  const skyboxSyncContextKey = skyboxSyncContextBinding.sceneSessionId === sceneSessionId
    ? skyboxSyncContextBinding.key
    : null;
  const chartSyncContextKey = skyboxSyncContextKey;
  chartSyncContextKeyRef.current = chartSyncContextKey;
  const [importingLibraryKey, setImportingLibraryKey] = useState<ImportableProjectLibraryKey | null>(null);
  const [isLoadingProjectAssets, setIsLoadingProjectAssets] = useState(false);
  const [libraryStatuses, setLibraryStatuses] = useState<LibraryStatusMap>({ model: null, environment: null, skybox: null });
  const [skyboxSyncState, setSkyboxSyncState] = useState<SkyboxSyncControllerState>({
    progress: null,
    starting: false,
    retrying: false,
    reloadingAssets: false,
    pendingRunId: null,
    reloadError: null,
  });
  const [modelSyncProgress, setModelSyncProgress] = useState<DataPlatformModelSyncProgress | null>(null);
  const [isRetryingModelSync, setIsRetryingModelSync] = useState(false);
  const [environmentSyncProgress, setEnvironmentSyncProgress] = useState<DataPlatformEnvironmentSyncProgress | null>(null);
  const [isRetryingEnvironmentSync, setIsRetryingEnvironmentSync] = useState(false);
  const [syncedImages, setSyncedImages] = useState<SyncedImageAssetEntry[]>([]);
  const [imageSyncProgress, setImageSyncProgress] = useState<DataPlatformImageSyncProgress | null>(null);
  const [isRetryingImageSync, setIsRetryingImageSync] = useState(false);
  const [syncedCharts, setSyncedCharts] = useState<DataPlatformChartAssetEntry[]>([]);
  const [isLoadingSyncedCharts, setIsLoadingSyncedCharts] = useState(false);
  const [chartSyncProgress, setChartSyncProgress] = useState<DataPlatformChartSyncProgress | null>(null);
  const [isStartingChartSync, setIsStartingChartSync] = useState(false);
  const [isRetryingChartSync, setIsRetryingChartSync] = useState(false);

  const modelAssets = useMemo(
    () => projectAssets.filter((asset) => asset.libraryKind === 'model'),
    [projectAssets],
  );
  const environmentAssets = useMemo(
    () => projectAssets.filter((asset) => asset.libraryKind === 'environment'),
    [projectAssets],
  );
  const orphanedCurrentSkybox = useMemo(
    () => currentSkybox
      ? findOrphanedSkyboxForSettings(currentSkybox, orphanedSkyboxAssets)
      : null,
    [currentSkybox, orphanedSkyboxAssets],
  );
  const skyboxSyncProgress = skyboxSyncState.progress;
  const isStartingSkyboxSync = skyboxSyncState.starting;
  const isRetryingSkyboxSync = skyboxSyncState.retrying;
  const isReloadingSkyboxAssets = skyboxSyncState.reloadingAssets;
  const skyboxSyncReloadError = skyboxSyncState.reloadError;
  const isSkyboxSyncActive = skyboxSyncProgress !== null
    && skyboxSyncProgress.phase !== 'completed'
    && skyboxSyncProgress.phase !== 'failed';
  const modelDeviceTypes = useMemo(
    () => createModelDeviceTypeOptions(modelAssets),
    [modelAssets],
  );

  const activeLibrary = useMemo(
    () => PROJECT_LIBRARIES.find((library) => library.key === activeLibraryKey) ?? PROJECT_LIBRARIES[0],
    [activeLibraryKey],
  );

  useEffect(() => {
    if (!modelDeviceTypeFilter) return;
    if (activeLibrary.key === 'model' && !modelDeviceTypes.includes(modelDeviceTypeFilter)) {
      setModelDeviceTypeFilter('');
    }
  }, [activeLibrary.key, modelDeviceTypeFilter, modelDeviceTypes]);

  const activeItems = useMemo(() => {
    if (activeLibrary.key === 'model') {
      return [
        ...createModelLibraryItems(modelAssets),
        ...BUILT_IN_MODEL_LIBRARY_ITEMS,
      ];
    }

    if (activeLibrary.key === 'environment') {
      return createModelLibraryItems(environmentAssets);
    }

    if (activeLibrary.key === 'skybox') {
      return createSkyboxLibraryItems(skyboxAssets);
    }

    if (activeLibrary.key === 'chart') {
      return createDataPlatformChartLibraryItems(syncedCharts);
    }

    if (activeLibrary.key === 'image') {
      return [
        ...createImageLibraryItems(),
        ...createSyncedImageLibraryItems(syncedImages),
      ];
    }

    return activeLibrary.items;
  }, [activeLibrary, environmentAssets, modelAssets, skyboxAssets, syncedCharts, syncedImages]);

  const normalizedLibraryFilter = libraryFilterText.trim().toLowerCase();
  const hasActiveLibraryFilter = Boolean(normalizedLibraryFilter)
    || (activeLibrary.key === 'model' && Boolean(modelDeviceTypeFilter));
  const filteredItems = useMemo(() => {
    if (!hasActiveLibraryFilter) return activeItems;

    return activeItems.filter((item) => {
      const matchesName = !normalizedLibraryFilter
        || (isDataPlatformChartLibraryItem(item)
          ? matchesDataPlatformChartLibrarySearch(item, normalizedLibraryFilter)
          : item.name.toLowerCase().includes(normalizedLibraryFilter))
        || (isSyncedImageProjectLibraryItem(item)
          && `${item.syncedImage.iconKey} ${item.syncedImage.category ?? ''}`
            .toLowerCase()
            .includes(normalizedLibraryFilter));
      if (!matchesName) return false;

      return activeLibrary.key !== 'model'
        || matchesModelDeviceType(item, modelDeviceTypeFilter);
    });
  }, [
    activeItems,
    activeLibrary.key,
    hasActiveLibraryFilter,
    modelDeviceTypeFilter,
    normalizedLibraryFilter,
  ]);

  const activeImportLibraryKey: ImportableProjectLibraryKey | null =
    activeLibrary.key === 'model' || activeLibrary.key === 'environment' || activeLibrary.key === 'skybox'
      ? activeLibrary.key
      : null;
  const isImportingAsset = importingLibraryKey !== null;
  const libraryStatus = activeImportLibraryKey ? libraryStatuses[activeImportLibraryKey] : null;

  /** 按分库存储导入状态，避免切换模型库和环境库时复用上一页文案。 */
  function setLibraryStatus(libraryKind: ImportableProjectLibraryKey, status: LibraryStatus | null): void {
    setLibraryStatuses((current) => ({ ...current, [libraryKind]: status }));
  }

  /** 当前场景引用同一环境包或同一数据中台环境 ID 时，用新版本配置触发 Babylon 重载。 */
  const refreshCurrentEnvironmentFromAssets = useCallback(async (
    assets: ProjectModelAssetEntry[],
    expectedSceneSessionId = sceneSessionIdRef.current,
  ): Promise<boolean> => {
    const refreshStartState = useEditorStore.getState();
    if (refreshStartState.sceneSessionId !== expectedSceneSessionId) return false;
    const environment = refreshStartState.scene.sceneSettings.environment;
    if (!environment) return false;
    const expectedEnvironmentState = {
      environment,
      applyRequestId: refreshStartState.environmentApplyRequest?.id ?? null,
    };
    if (expectedEnvironmentState.applyRequestId) return false;

    const environmentAssets = assets.filter((asset) => asset.libraryKind === 'environment');
    const matchedAsset = findImportedAssetForPackagePath(
      environment.packagePath,
      createImportedAssetIndexes(environmentAssets),
      environment.source === 'data-platform'
        ? {
          sourceKey: environment.dataPlatformSourceKey,
          resourceId: environment.dataPlatformResourceId,
          revision: environment.dataPlatformRevision,
        }
        : undefined,
    );
    if (!matchedAsset || matchedAsset.libraryKind !== 'environment') return false;

    try {
      const environmentConfig = await loadEnvironmentFromAsset(matchedAsset, environment);
      if (sceneSessionIdRef.current !== expectedSceneSessionId) return false;
      if (!environmentConfig) {
        pushLog('环境模型资源已更新，但当前场景环境配置无效，未自动刷新。');
        return false;
      }

      if (environment.source === 'data-platform') {
        const requestId = requestEnvironmentApply(environment, {
          autoAlign: false,
          focusAfterLoad: false,
          commandLabel: '刷新环境模型资源',
          successMessage: '环境模型运行缓存已刷新，并保留场景绑定身份与显示设置。',
          persistSceneChange: false,
          runtimeEnvironment: environmentConfig,
          expectedSceneSessionId,
          expectedEnvironmentState,
        });
        return requestId !== null;
      }

      const requestId = requestEnvironmentApply(environmentConfig, {
        autoAlign: false,
        focusAfterLoad: false,
        commandLabel: '刷新环境模型资源',
        successMessage: '环境模型资源已刷新，并保留当前摆放与显示设置。',
        runtimeEnvironment: environmentConfig,
        expectedSceneSessionId,
        expectedEnvironmentState,
      });
      return requestId !== null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      pushLog(`环境模型资源已更新，但当前场景自动刷新失败：${message}`);
      return false;
    }
  }, [pushLog, requestEnvironmentApply]);

  /** 按当前场景身份用稳定 ID 重关联天空盒；只有命令实际生效或配置已相同时才消费同步完成。 */
  const relinkCurrentSkyboxFromAssets = useCallback((
    assets: ProjectSkyboxAssetEntry[],
    expectedSceneId: string,
  ): SkyboxSyncApplyResult => {
    const beforeState = useEditorStore.getState();
    if (beforeState.scene.id !== expectedSceneId) return 'blocked';
    const activeSkybox = getSceneSkyboxSettings(beforeState.scene);
    if (!activeSkybox) return 'not-found';
    const matchedAsset = findSkyboxAssetForSettings(activeSkybox, assets);
    if (!matchedAsset) return 'not-found';

    try {
      const refreshedSkybox = createSceneSkyboxFromAsset(matchedAsset, activeSkybox);
      if (JSON.stringify(refreshedSkybox) === JSON.stringify(activeSkybox)) return 'unchanged';
      updateSkyboxConfig(refreshedSkybox);
      const afterState = useEditorStore.getState();
      if (afterState.scene.id !== expectedSceneId) return 'blocked';
      const appliedSkybox = getSceneSkyboxSettings(afterState.scene);
      return JSON.stringify(appliedSkybox) === JSON.stringify(refreshedSkybox) ? 'applied' : 'blocked';
    } catch (error) {
      const message = formatSkyboxSyncError(error);
      pushLog(`天空盒资源已更新，但当前场景自动刷新失败：${message}`);
      return 'blocked';
    }
  }, [pushLog, updateSkyboxConfig]);

  /** 导入和显式资源刷新仍沿用既有命令路径，并只把实际修改计为刷新成功。 */
  const refreshCurrentSkyboxFromAssets = useCallback((
    assets: ProjectSkyboxAssetEntry[],
  ): boolean => relinkCurrentSkyboxFromAssets(
    assets,
    useEditorStore.getState().scene.id,
  ) === 'applied', [relinkCurrentSkyboxFromAssets]);

  const loadProjectAssets = useCallback(async (
    options: ProjectAssetsLoadOptions = {},
  ): Promise<ProjectAssetsLoadResult> => {
    if (!window.editorApi?.listProjectAssets) {
      return { ok: false, error: '加载项目资源库需要 Electron 桌面环境。' };
    }

    const requestId = projectAssetsLoadRequestRef.current + 1;
    const requestSceneSessionId = sceneSessionIdRef.current;
    projectAssetsLoadRequestRef.current = requestId;
    setIsLoadingProjectAssets(true);

    try {
      const result = await window.editorApi.listProjectAssets();
      if (requestId !== projectAssetsLoadRequestRef.current) {
        return { ok: false, error: '项目资源库加载请求已被较新的请求取代。' };
      }

      const loadedSkyboxes = result.skyboxes ?? [];
      setProjectRoot(result.projectRoot);
      setSkyboxSyncContextBinding({
        sceneSessionId: requestSceneSessionId,
        key: result.skyboxSyncContextKey ?? null,
      });
      setProjectAssets(result.assets);
      setSkyboxAssets(result.skyboxes ?? []);
      setOrphanedSkyboxAssets(result.orphanedSkyboxes ?? []);

      const totalAssetCount = result.assets.length + loadedSkyboxes.length;
      if (totalAssetCount > 0) {
        pushLog(`已加载项目资源库：${totalAssetCount} 个资产。`);
      }

      refreshCurrentSkyboxAfterProjectAssetsLoad(
        options.refreshSkybox === true,
        loadedSkyboxes,
        refreshCurrentSkyboxFromAssets,
      );
      if (options.refreshModels) {
        const modelAssets = result.assets.filter((asset) => asset.libraryKind === 'model');
        const assetsToRefresh = filterProjectModelsForSyncRefresh(
          modelAssets,
          options.modelResourceKeys === undefined ? null : options.modelResourceKeys,
        );
        if (assetsToRefresh.length > 0) refreshModelInstancesFromAssets(assetsToRefresh);
      }
      if (options.refreshEnvironment) {
        await refreshCurrentEnvironmentFromAssets(result.assets, requestSceneSessionId);
      }
      return { ok: true, skyboxes: loadedSkyboxes };
    } catch (error) {
      if (requestId !== projectAssetsLoadRequestRef.current) {
        return { ok: false, error: '项目资源库加载请求已被较新的请求取代。' };
      }
      const message = formatSkyboxSyncError(error);
      pushLog(`加载项目资源库失败：${message}`);
      return { ok: false, error: message };
    } finally {
      if (requestId === projectAssetsLoadRequestRef.current) {
        setIsLoadingProjectAssets(false);
      }
    }
  }, [pushLog, refreshCurrentEnvironmentFromAssets, refreshCurrentSkyboxFromAssets, refreshModelInstancesFromAssets]);

  /** 从主进程本地图片索引加载同步图片并登记，供图片库展示与拖拽校验使用。 */
  const loadSyncedImages = useCallback(async (): Promise<boolean> => {
    if (!window.editorApi?.listSyncedImages) return false;
    try {
      const images = await window.editorApi.listSyncedImages();
      setSyncedImageAssets(images);
      setSyncedImages(images);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      pushLog(`加载数据中台图片库失败：${message}`);
      return false;
    }
  }, [pushLog]);

  /** 只接受当前场景和绑定上下文的大屏快照，避免项目切换后的迟到结果污染列表。 */
  const loadDataPlatformCharts = useCallback(async (
    expectedSceneSessionId: string,
    expectedContextKey: string,
  ): Promise<boolean> => {
    const api = getDataPlatformChartSyncApi();
    if (!api.listDataPlatformCharts) return false;

    const requestId = chartLibraryLoadRequestRef.current + 1;
    chartLibraryLoadRequestRef.current = requestId;
    setIsLoadingSyncedCharts(true);
    try {
      const snapshot = await api.listDataPlatformCharts();
      if (
        requestId !== chartLibraryLoadRequestRef.current
        || sceneSessionIdRef.current !== expectedSceneSessionId
        || chartSyncContextKeyRef.current !== expectedContextKey
      ) return false;
      if (snapshot.contextKey !== expectedContextKey || snapshot.projectId === null) {
        pushLog('加载数据中台大屏资源失败：返回结果与当前绑定项目不匹配。');
        return false;
      }
      setSyncedCharts(snapshot.charts);
      return true;
    } catch (error) {
      if (
        requestId !== chartLibraryLoadRequestRef.current
        || sceneSessionIdRef.current !== expectedSceneSessionId
        || chartSyncContextKeyRef.current !== expectedContextKey
      ) return false;
      const message = error instanceof Error ? error.message : String(error);
      pushLog(`加载数据中台大屏资源失败：${message}`);
      return false;
    } finally {
      if (requestId === chartLibraryLoadRequestRef.current) setIsLoadingSyncedCharts(false);
    }
  }, [pushLog]);

  useEffect(() => {
    let active = true;
    beginScenePreparation(sceneSessionId);
    skipSceneModelSync(sceneSessionId, null);
    lastSceneRefreshModelSyncRunIdRef.current = null;
    lastSceneRefreshEnvironmentSyncRunIdRef.current = null;
    lastChartSyncReloadRunIdRef.current = null;
    chartLibraryLoadRequestRef.current += 1;
    chartSyncContextKeyRef.current = null;
    autoChartSyncContextKeyRef.current = null;
    setIsLoadingProjectAssets(false);
    setProjectRoot(null);
    setSkyboxSyncContextBinding({ sceneSessionId, key: null });
    setProjectAssets([]);
    setSkyboxAssets([]);
    setOrphanedSkyboxAssets([]);
    setSyncedCharts([]);
    setIsLoadingSyncedCharts(false);
    setChartSyncProgress(null);
    setIsStartingChartSync(false);
    setIsRetryingChartSync(false);
    const refreshStartupEnvironment = useEditorStore.getState().environmentStartupRelinkSessionId === sceneSessionId;
    const refreshId = crypto.randomUUID();
    beginSceneModelAssetRefresh(sceneSessionId, refreshId);
    const initialLoadPromise = loadProjectAssets({
      refreshModels: true,
      refreshEnvironment: refreshStartupEnvironment,
      refreshSkybox: true,
    });
    initialProjectAssetsLoadPromiseRef.current = initialLoadPromise;
    void initialLoadPromise.then((initialLoad) => {
      if (!active || sceneSessionIdRef.current !== sceneSessionId) return;
      settleSceneModelAssetRefresh(
        sceneSessionId,
        initialLoad.ok ? null : `本地模型资源关联失败：${initialLoad.error}`,
        refreshId,
      );
    });
    void loadSyncedImages();
    return () => {
      active = false;
      if (initialProjectAssetsLoadPromiseRef.current === initialLoadPromise) {
        initialProjectAssetsLoadPromiseRef.current = null;
      }
      projectAssetsLoadRequestRef.current += 1;
    };
  }, [loadProjectAssets, loadSyncedImages, sceneSessionId]);

  useEffect(() => {
    const expectedContextKey = chartSyncContextKey;
    chartLibraryLoadRequestRef.current += 1;
    lastChartSyncReloadRunIdRef.current = null;
    setSyncedCharts([]);
    setIsLoadingSyncedCharts(false);
    setChartSyncProgress(null);
    setIsStartingChartSync(false);
    setIsRetryingChartSync(false);
    if (!expectedContextKey) autoChartSyncContextKeyRef.current = null;
    if (!expectedContextKey) return;
    void loadDataPlatformCharts(sceneSessionId, expectedContextKey);
    if (props.readOnly || autoChartSyncContextKeyRef.current === expectedContextKey) return;
    autoChartSyncContextKeyRef.current = expectedContextKey;
    const api = getDataPlatformChartSyncApi();
    if (!api.syncDataPlatformCharts) return;
    void api.syncDataPlatformCharts().catch((error: unknown) => {
      if (
        sceneSessionIdRef.current !== sceneSessionId
        || chartSyncContextKeyRef.current !== expectedContextKey
      ) return;
      const message = error instanceof Error ? error.message : String(error);
      pushLog(`自动同步数据中台大屏失败：${message}`);
    });
  }, [chartSyncContextKey, loadDataPlatformCharts, props.readOnly, pushLog, sceneSessionId]);

  useEffect(() => {
    const dataPlatformModelSyncApi = getDataPlatformModelSyncApi();
    if (!dataPlatformModelSyncApi.onDataPlatformModelSyncProgress) return undefined;

    const clearCompletedDismissTimer = () => {
      if (modelSyncCompletedDismissTimerRef.current === null) return;
      window.clearTimeout(modelSyncCompletedDismissTimerRef.current);
      modelSyncCompletedDismissTimerRef.current = null;
    };

    const refreshSceneModelsForSyncRun = (
      progress: DataPlatformModelSyncProgress,
      progressSceneSessionId: string,
    ): void => {
      const runId = progress.runId;
      if (lastSceneRefreshModelSyncRunIdRef.current === runId) return;
      lastSceneRefreshModelSyncRunIdRef.current = runId;
      void (async () => {
        const initialLoadPromise = initialProjectAssetsLoadPromiseRef.current;
        await initialLoadPromise;
        if (
          initialProjectAssetsLoadPromiseRef.current !== initialLoadPromise
          || sceneSessionIdRef.current !== progressSceneSessionId
          || lastSceneRefreshModelSyncRunIdRef.current !== runId
        ) return;
        const runtimeChangedResourceKeys = progress.runtimeChangedResourceKeys ?? null;
        const loaded = await loadProjectAssets({
          refreshModels: runtimeChangedResourceKeys === null || runtimeChangedResourceKeys.length > 0,
          modelResourceKeys: runtimeChangedResourceKeys,
        });
        if (!loaded.ok && lastSceneRefreshModelSyncRunIdRef.current === runId) {
          lastSceneRefreshModelSyncRunIdRef.current = null;
        }
      })();
    };

    const unsubscribe = dataPlatformModelSyncApi.onDataPlatformModelSyncProgress((progress) => {
      clearCompletedDismissTimer();
      setModelSyncProgress(progress);
      const progressSceneSessionId = sceneSessionIdRef.current;
      const phaseLabel = DATA_PLATFORM_MODEL_SYNC_PHASE_LABELS[progress.phase];
      const countLabel = progress.total > 0 ? `（${progress.completed}/${progress.total}）` : '';
      const detail = progress.error || progress.message;
      pushLog(`数据中台模型同步：${phaseLabel}${countLabel}${detail ? `：${detail}` : ''}`);

      if (
        progress.phase === 'completed'
        && shouldRefreshProjectModelsAfterSync(progress)
      ) {
        refreshSceneModelsForSyncRun(progress, progressSceneSessionId);
      }
      if (progress.phase === 'completed') {
        modelSyncCompletedDismissTimerRef.current = window.setTimeout(() => {
          modelSyncCompletedDismissTimerRef.current = null;
          setModelSyncProgress((current) =>
            current?.runId === progress.runId && current.phase === 'completed' ? null : current,
          );
        }, 2200);
      }
    });

    return () => {
      clearCompletedDismissTimer();
      unsubscribe();
    };
  }, [loadProjectAssets, pushLog, sceneSessionId]);

  useEffect(() => {
    const controller = createSkyboxSyncController({
      startSync: async () => {
        const api = getDataPlatformSkyboxSyncApi();
        if (!api.syncDataPlatformSkyboxes) {
          throw new Error('同步数据中台天空盒需要 Electron 桌面环境。');
        }
        return api.syncDataPlatformSkyboxes();
      },
      retrySync: async () => {
        const api = getDataPlatformSkyboxSyncApi();
        if (!api.retryDataPlatformSkyboxSync) {
          throw new Error('重试数据中台天空盒同步需要 Electron 桌面环境。');
        }
        return api.retryDataPlatformSkyboxSync();
      },
      reloadAssets: async () => {
        const reloadSceneSessionId = sceneSessionIdRef.current;
        if (!await waitForInitialProjectAssetsLoad(reloadSceneSessionId)) {
          throw new Error('场景已切换，已取消天空盒资源重载。');
        }
        const result = await loadProjectAssets();
        if (!result.ok) throw new Error(result.error);
        return result.skyboxes;
      },
      applyAssets: (assets, sceneId) => relinkCurrentSkyboxFromAssets(assets, sceneId),
      onStateChange: setSkyboxSyncState,
      onProgressLog: (progress) => {
        const phaseLabel = DATA_PLATFORM_SKYBOX_SYNC_PHASE_LABELS[progress.phase];
        const countLabel = formatSkyboxSyncProgressCount(progress);
        const detail = progress.error || progress.message;
        pushLog(`数据中台天空盒同步：${phaseLabel}${countLabel ? `（${countLabel}）` : ''}${detail ? `：${detail}` : ''}`);
      },
      schedule: (callback, delayMs) => window.setTimeout(callback, delayMs),
      cancelSchedule: (handle) => window.clearTimeout(handle as number),
      progressThrottleMs: 225,
    });
    skyboxSyncControllerRef.current = controller;
    controller.setContext({
      readOnly: Boolean(props.readOnly),
      sceneId: sceneDocument.id,
      contextKey: sceneSessionId,
      syncContextKey: skyboxSyncContextKey,
    });

    const dataPlatformSkyboxSyncApi = getDataPlatformSkyboxSyncApi();
    const unsubscribe = dataPlatformSkyboxSyncApi.onDataPlatformSkyboxSyncProgress?.((progress) => {
      controller.receiveProgress(progress);
    });

    return () => {
      unsubscribe?.();
      controller.dispose();
      if (skyboxSyncControllerRef.current === controller) skyboxSyncControllerRef.current = null;
    };
  }, [
    loadProjectAssets,
    pushLog,
    relinkCurrentSkyboxFromAssets,
    sceneSessionId,
    skyboxSyncContextKey,
    waitForInitialProjectAssetsLoad,
  ]);

  useEffect(() => {
    skyboxSyncControllerRef.current?.setContext({
      readOnly: Boolean(props.readOnly),
      sceneId: sceneDocument.id,
      contextKey: sceneSessionId,
      syncContextKey: skyboxSyncContextKey,
    });
  }, [props.readOnly, sceneDocument.id, sceneSessionId, skyboxSyncContextKey]);

  useEffect(() => {
    const environmentSyncApi = getDataPlatformEnvironmentSyncApi();
    if (!environmentSyncApi.onDataPlatformEnvironmentSyncProgress) return undefined;
    const clearCompletedTimer = () => {
      if (environmentSyncCompletedDismissTimerRef.current === null) return;
      window.clearTimeout(environmentSyncCompletedDismissTimerRef.current);
      environmentSyncCompletedDismissTimerRef.current = null;
    };
    const unsubscribe = environmentSyncApi.onDataPlatformEnvironmentSyncProgress((progress) => {
      clearCompletedTimer();
      setEnvironmentSyncProgress(progress);
      const label = DATA_PLATFORM_ENVIRONMENT_SYNC_PHASE_LABELS[progress.phase];
      pushLog(`数据中台环境模型同步：${label}${progress.total > 0 ? `（${progress.completed}/${progress.total}）` : ''}${progress.error || progress.message ? `：${progress.error || progress.message}` : ''}`);
      if (progress.phase === 'completed') {
        const progressSceneSessionId = sceneSessionIdRef.current;
        if (lastSceneRefreshEnvironmentSyncRunIdRef.current !== progress.runId) {
          lastSceneRefreshEnvironmentSyncRunIdRef.current = progress.runId;
          void (async () => {
            if (
              !await waitForInitialProjectAssetsLoad(progressSceneSessionId)
              || lastSceneRefreshEnvironmentSyncRunIdRef.current !== progress.runId
            ) return;
            const loaded = await loadProjectAssets({ refreshEnvironment: true });
            if (!loaded.ok && lastSceneRefreshEnvironmentSyncRunIdRef.current === progress.runId) {
              lastSceneRefreshEnvironmentSyncRunIdRef.current = null;
            }
            const currentState = useEditorStore.getState();
            if (
              loaded.ok
              && sceneSessionIdRef.current === progressSceneSessionId
              && currentState.environmentStartupRelinkSessionId === progressSceneSessionId
              && !currentState.environmentApplyRequest
            ) {
              pushLog('环境模型同步已完成，但未找到当前场景引用的资源；已阻止加载旧机器缓存路径。');
            }
          })();
        }
        environmentSyncCompletedDismissTimerRef.current = window.setTimeout(() => {
          environmentSyncCompletedDismissTimerRef.current = null;
          setEnvironmentSyncProgress((current) => current?.runId === progress.runId && current.phase === 'completed' ? null : current);
        }, 2200);
      }
    });
    return () => {
      clearCompletedTimer();
      unsubscribe();
    };
  }, [loadProjectAssets, pushLog, waitForInitialProjectAssetsLoad]);

  useEffect(() => {
    const dataPlatformImageSyncApi = getDataPlatformImageSyncApi();
    if (!dataPlatformImageSyncApi.onDataPlatformImageSyncProgress) return undefined;

    const clearCompletedDismissTimer = () => {
      if (imageSyncCompletedDismissTimerRef.current === null) return;
      window.clearTimeout(imageSyncCompletedDismissTimerRef.current);
      imageSyncCompletedDismissTimerRef.current = null;
    };
    const unsubscribe = dataPlatformImageSyncApi.onDataPlatformImageSyncProgress((progress) => {
      clearCompletedDismissTimer();
      setImageSyncProgress(progress);
      const phaseLabel = DATA_PLATFORM_IMAGE_SYNC_PHASE_LABELS[progress.phase];
      const countLabel = progress.total > 0 ? `（${progress.completed}/${progress.total}）` : '';
      const detail = progress.error || progress.message;
      pushLog(`数据中台图片同步：${phaseLabel}${countLabel}${detail ? `：${detail}` : ''}`);

      if (progress.phase === 'completed') {
        const shouldRefreshImages = lastSceneRefreshImageSyncRunIdRef.current !== progress.runId;
        if (shouldRefreshImages) {
          lastSceneRefreshImageSyncRunIdRef.current = progress.runId;
          void loadSyncedImages();
        }
        imageSyncCompletedDismissTimerRef.current = window.setTimeout(() => {
          imageSyncCompletedDismissTimerRef.current = null;
          setImageSyncProgress((current) =>
            current?.runId === progress.runId && current.phase === 'completed' ? null : current,
          );
        }, 2200);
      }
    });

    return () => {
      clearCompletedDismissTimer();
      unsubscribe();
    };
  }, [loadSyncedImages, pushLog]);

  useEffect(() => {
    const api = getDataPlatformChartSyncApi();
    if (!api.onDataPlatformChartSyncProgress) return undefined;

    const clearCompletedDismissTimer = () => {
      if (chartSyncCompletedDismissTimerRef.current === null) return;
      window.clearTimeout(chartSyncCompletedDismissTimerRef.current);
      chartSyncCompletedDismissTimerRef.current = null;
    };
    const unsubscribe = api.onDataPlatformChartSyncProgress((progress) => {
      if (!chartSyncContextKeyRef.current || progress.contextKey !== chartSyncContextKeyRef.current) return;
      clearCompletedDismissTimer();
      setChartSyncProgress(progress);
      const phaseLabel = DATA_PLATFORM_CHART_SYNC_PHASE_LABELS[progress.phase];
      const countLabel = progress.total > 0 ? `（${progress.completed}/${progress.total}）` : '';
      const detail = progress.error || progress.message;
      pushLog(`数据中台大屏同步：${phaseLabel}${countLabel}${detail ? `：${detail}` : ''}`);

      if (progress.phase === 'completed') {
        const expectedSceneSessionId = sceneSessionIdRef.current;
        const expectedContextKey = progress.contextKey;
        if (lastChartSyncReloadRunIdRef.current !== progress.runId) {
          lastChartSyncReloadRunIdRef.current = progress.runId;
          void loadDataPlatformCharts(expectedSceneSessionId, expectedContextKey);
        }
        chartSyncCompletedDismissTimerRef.current = window.setTimeout(() => {
          chartSyncCompletedDismissTimerRef.current = null;
          setChartSyncProgress((current) =>
            current?.runId === progress.runId && current.phase === 'completed' ? null : current,
          );
        }, 2200);
      }
    });

    return () => {
      clearCompletedDismissTimer();
      unsubscribe();
    };
  }, [chartSyncContextKey, loadDataPlatformCharts, pushLog]);

  useEffect(() => {
    if (!projectAssetFocusRequest) return;

    const matchedAsset = modelAssets.find((asset) =>
      asset.sourceUrl === projectAssetFocusRequest.sourceUrl ||
      asset.path === projectAssetFocusRequest.sourcePath,
    );

    if (!matchedAsset) {
      pushLog(`库聚焦失败：未找到 ${projectAssetFocusRequest.entityName} 对应的模型卡片。`);
      consumeProjectAssetFocusRequest(projectAssetFocusRequest.id);
      return;
    }

    setActiveLibraryKey('model');
    setLibraryFilterText('');
    setModelDeviceTypeFilter('');
    setFocusedAssetId(matchedAsset.id);
    pushLog(`库聚焦到模型卡片：${matchedAsset.displayName ?? matchedAsset.name}`);
    consumeProjectAssetFocusRequest(projectAssetFocusRequest.id);
  }, [consumeProjectAssetFocusRequest, modelAssets, projectAssetFocusRequest, pushLog]);

  useEffect(() => {
    if (!focusedAssetId || activeLibraryKey !== 'model') return;

    const card = resourceCardRefs.current.get(focusedAssetId);
    if (!card) return;

    card.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    const timeoutId = window.setTimeout(() => setFocusedAssetId(null), 1800);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [activeLibraryKey, focusedAssetId, filteredItems]);

  async function handleSyncDataPlatformSkyboxes(): Promise<void> {
    if (props.readOnly) return;
    await skyboxSyncControllerRef.current?.start();
  }

  async function handleRetryDataPlatformSkyboxSync(): Promise<void> {
    if (props.readOnly) return;
    await skyboxSyncControllerRef.current?.retry();
  }

  async function handleReloadSkyboxAssets(): Promise<void> {
    await skyboxSyncControllerRef.current?.retryAssetReload();
  }

  function handleDismissDataPlatformSkyboxSyncFailure(): void {
    skyboxSyncControllerRef.current?.dismissFailure();
  }

  function handleDismissDataPlatformModelSyncFailure(): void {
    if (modelSyncProgress?.phase !== 'failed') return;
    setIsRetryingModelSync(false);
    setModelSyncProgress(null);
  }

  async function handleRetryDataPlatformModelSync(): Promise<void> {
    if (!modelSyncProgress || modelSyncProgress.phase !== 'failed') return;

    const dataPlatformModelSyncApi = getDataPlatformModelSyncApi();
    if (!dataPlatformModelSyncApi.retryDataPlatformModelSync) {
      pushLog('重试数据中台模型同步需要 Electron 桌面环境。');
      return;
    }

    setIsRetryingModelSync(true);
    try {
      const retryStarted = await dataPlatformModelSyncApi.retryDataPlatformModelSync();
      setModelSyncProgress({
        ...modelSyncProgress,
        phase: retryStarted ? 'querying' : 'failed',
        message: retryStarted ? '已提交重试，正在重新查询模型...' : '当前没有可重试的模型同步任务。',
        error: retryStarted ? null : '当前没有可重试的模型同步任务。',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setModelSyncProgress({ ...modelSyncProgress, error: message });
      pushLog(`重试数据中台模型同步失败：${message}`);
    } finally {
      setIsRetryingModelSync(false);
    }
  }

  function handleDismissDataPlatformEnvironmentSyncFailure(): void {
    if (environmentSyncProgress?.phase !== 'failed') return;
    setEnvironmentSyncProgress(null);
  }

  async function handleRetryDataPlatformEnvironmentSync(): Promise<void> {
    if (!environmentSyncProgress || environmentSyncProgress.phase !== 'failed') return;
    const api = getDataPlatformEnvironmentSyncApi();
    if (!api.retryDataPlatformEnvironmentSync) return;
    setIsRetryingEnvironmentSync(true);
    try {
      const started = await api.retryDataPlatformEnvironmentSync();
      if (started) setEnvironmentSyncProgress({ ...environmentSyncProgress, phase: 'querying', error: null, message: '正在重试环境模型同步…' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setEnvironmentSyncProgress({ ...environmentSyncProgress, error: message });
    } finally {
      setIsRetryingEnvironmentSync(false);
    }
  }


  async function handleSyncDataPlatformImages(): Promise<void> {
    if (props.readOnly) return;
    const dataPlatformImageSyncApi = getDataPlatformImageSyncApi();
    if (!dataPlatformImageSyncApi.syncDataPlatformImages) {
      const statusMessage = '从数据中台同步图片需要 Electron 桌面环境，请使用 npm run dev:electron 启动编辑器。';
      pushLog(statusMessage);
      return;
    }
    try {
      const started = await dataPlatformImageSyncApi.syncDataPlatformImages();
      if (!started) {
        pushLog('数据中台图片同步未能启动，请检查数据中台连接配置。');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      pushLog(`启动数据中台图片同步失败：${message}`);
    }
  }

  async function handleRetryDataPlatformImageSync(): Promise<void> {
    if (!imageSyncProgress || imageSyncProgress.phase !== 'failed') return;

    const dataPlatformImageSyncApi = getDataPlatformImageSyncApi();
    if (!dataPlatformImageSyncApi.retryDataPlatformImageSync) {
      pushLog('重试数据中台图片同步需要 Electron 桌面环境。');
      return;
    }

    setIsRetryingImageSync(true);
    try {
      const retryStarted = await dataPlatformImageSyncApi.retryDataPlatformImageSync();
      setImageSyncProgress({
        ...imageSyncProgress,
        phase: retryStarted ? 'querying' : 'failed',
        message: retryStarted ? '已提交重试，正在重新查询图片...' : '当前没有可重试的图片同步任务。',
        error: retryStarted ? null : '当前没有可重试的图片同步任务。',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setImageSyncProgress({ ...imageSyncProgress, error: message });
      pushLog(`重试数据中台图片同步失败：${message}`);
    } finally {
      setIsRetryingImageSync(false);
    }
  }

  function handleDismissDataPlatformImageSyncFailure(): void {
    if (imageSyncProgress?.phase !== 'failed') return;
    setIsRetryingImageSync(false);
    setImageSyncProgress(null);
  }

  async function handleSyncDataPlatformCharts(): Promise<void> {
    const expectedSceneSessionId = sceneSessionIdRef.current;
    const expectedContextKey = chartSyncContextKeyRef.current;
    if (props.readOnly || !expectedContextKey) return;
    const api = getDataPlatformChartSyncApi();
    if (!api.syncDataPlatformCharts) {
      pushLog('同步数据中台大屏需要 Electron 桌面环境。');
      return;
    }

    setIsStartingChartSync(true);
    try {
      const started = await api.syncDataPlatformCharts();
      if (
        sceneSessionIdRef.current !== expectedSceneSessionId
        || chartSyncContextKeyRef.current !== expectedContextKey
      ) return;
      if (!started) pushLog('数据中台大屏同步未能启动，请确认当前工程已绑定数据中台项目。');
    } catch (error) {
      if (
        sceneSessionIdRef.current !== expectedSceneSessionId
        || chartSyncContextKeyRef.current !== expectedContextKey
      ) return;
      const message = error instanceof Error ? error.message : String(error);
      pushLog(`启动数据中台大屏同步失败：${message}`);
    } finally {
      if (
        sceneSessionIdRef.current === expectedSceneSessionId
        && chartSyncContextKeyRef.current === expectedContextKey
      ) setIsStartingChartSync(false);
    }
  }

  async function handleRetryDataPlatformChartSync(): Promise<void> {
    const expectedSceneSessionId = sceneSessionIdRef.current;
    const expectedContextKey = chartSyncContextKeyRef.current;
    if (
      props.readOnly
      || chartSyncProgress?.phase !== 'failed'
      || chartSyncProgress.contextKey !== expectedContextKey
    ) return;
    const api = getDataPlatformChartSyncApi();
    if (!api.retryDataPlatformChartSync) {
      pushLog('重试数据中台大屏同步需要 Electron 桌面环境。');
      return;
    }

    setIsRetryingChartSync(true);
    try {
      const retryStarted = await api.retryDataPlatformChartSync();
      if (
        sceneSessionIdRef.current !== expectedSceneSessionId
        || chartSyncContextKeyRef.current !== expectedContextKey
      ) return;
      setChartSyncProgress({
        ...chartSyncProgress,
        phase: retryStarted ? 'querying' : 'failed',
        message: retryStarted ? '已提交重试，正在重新查询项目大屏...' : '当前没有可重试的大屏同步任务。',
        error: retryStarted ? null : '当前没有可重试的大屏同步任务。',
      });
    } catch (error) {
      if (
        sceneSessionIdRef.current !== expectedSceneSessionId
        || chartSyncContextKeyRef.current !== expectedContextKey
      ) return;
      const message = error instanceof Error ? error.message : String(error);
      setChartSyncProgress({ ...chartSyncProgress, error: message });
      pushLog(`重试数据中台大屏同步失败：${message}`);
    } finally {
      if (
        sceneSessionIdRef.current === expectedSceneSessionId
        && chartSyncContextKeyRef.current === expectedContextKey
      ) setIsRetryingChartSync(false);
    }
  }

  function handleDismissDataPlatformChartSyncFailure(): void {
    if (chartSyncProgress?.phase !== 'failed') return;
    setIsRetryingChartSync(false);
    setChartSyncProgress(null);
  }

  async function handleImportModelFolder(): Promise<void> {
    if (props.readOnly) return;
    if (activeImportLibraryKey !== 'model') return;

    const libraryKind = 'model';
    const assetKindLabel = '模型';

    if (!window.editorApi?.importModelFolder) {
      const statusMessage = '导入模型文件夹需要 Electron 桌面环境，请使用 npm run dev:electron 启动编辑器。';
      setLibraryStatus(libraryKind, { message: statusMessage, kind: 'error' });
      pushLog(statusMessage);
      return;
    }

    setImportingLibraryKey(libraryKind);
    setLibraryStatus(libraryKind, { message: `正在扫描${assetKindLabel}文件夹...`, kind: 'info' });

    try {
      const result = await window.editorApi.importModelFolder({ libraryKind: 'model' });

      if (result.canceled) {
        setLibraryStatus(libraryKind, null);
        return;
      }

      setProjectAssets(result.projectAssets);
      setProjectRoot(result.projectRoot);
      const refreshedCount = libraryKind === 'model'
        ? refreshModelInstancesFromAssets(result.importedAssets)
        : 0;

      const skippedSuffix = result.skipped.length > 0 ? `，跳过 ${result.skipped.length} 个目录` : '';
      const rootLabel = result.rootPath ?? `${assetKindLabel}文件夹`;
      const projectSuffix = result.projectRoot ? `，已写入项目：${result.projectRoot}` : '';
      const refreshSuffix = refreshedCount > 0 ? `，已刷新 ${refreshedCount} 个场景模型实例` : '';
      const message = `${assetKindLabel}文件夹已导入项目：${rootLabel}，发现 ${result.importedAssets.length} 个模型${skippedSuffix}${projectSuffix}${refreshSuffix}。`;
      setLibraryStatus(libraryKind, { message, kind: 'info' });
      pushLog(message);

      if (result.importedAssets.length === 0) {
        setLibraryStatus(libraryKind, { message: `未发现可导入${assetKindLabel}包。`, kind: 'info' });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const statusMessage = `导入${assetKindLabel}文件夹失败：${message}`;
      setLibraryStatus(libraryKind, { message: statusMessage, kind: 'error' });
      pushLog(statusMessage);
    } finally {
      setImportingLibraryKey(null);
    }
  }

  /** 直接选择单个 GLB 导入环境库，主进程负责复制为项目内独立环境包。 */
  async function handleImportEnvironmentModelFile(): Promise<void> {
    if (props.readOnly) return;
    if (activeImportLibraryKey !== 'environment') return;

    const libraryKind = 'environment';
    if (!window.editorApi?.importEnvironmentModelFile) {
      const statusMessage = '导入环境 GLB 需要 Electron 桌面环境，请使用 npm run dev:electron 启动编辑器。';
      setLibraryStatus(libraryKind, { message: statusMessage, kind: 'error' });
      pushLog(statusMessage);
      return;
    }

    setImportingLibraryKey(libraryKind);
    setLibraryStatus(libraryKind, { message: '正在导入环境 GLB...', kind: 'info' });
    const importSceneSessionId = sceneSessionIdRef.current;

    try {
      const result = await window.editorApi.importEnvironmentModelFile();
      if (result.canceled) {
        setLibraryStatus(libraryKind, null);
        return;
      }

      if (!result.importedAsset) {
        throw new Error('主进程未返回有效的环境资产。');
      }

      setProjectAssets(result.projectAssets);
      setProjectRoot(result.projectRoot);
      const refreshedCurrentEnvironment = await refreshCurrentEnvironmentFromAssets(
        [result.importedAsset],
        importSceneSessionId,
      );
      const displayName = result.importedAsset.displayName?.trim()
        || result.importedAsset.name.replace(/\.glb$/i, '');
      const projectSuffix = result.projectRoot ? `，已写入项目：${result.projectRoot}` : '';
      const refreshSuffix = refreshedCurrentEnvironment ? '，已开始刷新当前场景环境模型' : '';
      const message = `环境 GLB 已导入：${displayName}${projectSuffix}${refreshSuffix}。`;
      setLibraryStatus(libraryKind, { message, kind: 'info' });
      pushLog(message);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const statusMessage = `导入环境 GLB 失败：${message}`;
      setLibraryStatus(libraryKind, { message: statusMessage, kind: 'error' });
      pushLog(statusMessage);
    } finally {
      setImportingLibraryKey(null);
    }
  }

  /** 直接选择单个 HDR/EXR 导入天空盒库，同名资源由主进程原子替换。 */
  async function handleImportSkyboxFile(): Promise<void> {
    if (props.readOnly || activeImportLibraryKey !== 'skybox') return;
    const libraryKind = 'skybox';
    if (!window.editorApi?.importSkyboxFile) {
      const statusMessage = '导入天空盒需要 Electron 桌面环境，请使用 npm run dev:electron 启动编辑器。';
      setLibraryStatus(libraryKind, { message: statusMessage, kind: 'error' });
      pushLog(statusMessage);
      return;
    }

    setImportingLibraryKey(libraryKind);
    setLibraryStatus(libraryKind, { message: '正在导入 HDR/EXR 天空盒...', kind: 'info' });
    try {
      const result = await window.editorApi.importSkyboxFile();
      if (result.canceled) {
        setLibraryStatus(libraryKind, null);
        return;
      }
      if (!result.importedAsset) throw new Error('主进程未返回有效的天空盒资产。');

      setSkyboxAssets(result.skyboxes ?? []);
      setOrphanedSkyboxAssets(result.orphanedSkyboxes ?? []);
      setProjectRoot(result.projectRoot);
      const refreshedCurrentSkybox = refreshCurrentSkyboxFromAssets([result.importedAsset]);
      const projectSuffix = result.projectRoot ? `，已写入项目：${result.projectRoot}` : '';
      const refreshSuffix = refreshedCurrentSkybox ? '，已刷新当前场景天空盒' : '';
      const message = `天空盒已导入：${result.importedAsset.displayName}（${result.importedAsset.format.toUpperCase()}）${projectSuffix}${refreshSuffix}。`;
      setLibraryStatus(libraryKind, { message, kind: 'info' });
      pushLog(message);
    } catch (error) {
      const message = formatSkyboxSyncError(error);
      const statusMessage = `导入天空盒失败：${message}`;
      setLibraryStatus(libraryKind, { message: statusMessage, kind: 'error' });
      pushLog(statusMessage);
    } finally {
      setImportingLibraryKey(null);
    }
  }

  /** 根据当前资源库选择对应的模型、环境 GLB 或天空盒导入入口。 */
  function handleImportActiveLibrary(): void {
    if (activeImportLibraryKey === 'environment') {
      void handleImportEnvironmentModelFile();
      return;
    }
    if (activeImportLibraryKey === 'skybox') {
      void handleImportSkyboxFile();
      return;
    }

    void handleImportModelFolder();
  }

  /** 从环境库把项目模型应用为场景环境，不创建 Hierarchy 实体。 */
  async function handleEnvironmentAssetApply(asset: AssetEntry): Promise<void> {
    if (props.readOnly) return;
    if (asset.libraryKind !== 'environment') return;
    const expectedSceneSessionId = sceneSessionIdRef.current;

    try {
      const environmentConfig = await loadEnvironmentFromAsset(asset);
      if (sceneSessionIdRef.current !== expectedSceneSessionId) return;
      if (!environmentConfig) {
        pushLog('环境模型配置无效，未更新场景环境。');
        return;
      }

      const displayName = asset.displayName?.trim() || asset.name.replace(/\.(gltf|glb)$/i, '');
      const requestId = requestEnvironmentApply(environmentConfig, {
        autoAlign: true,
        focusAfterLoad: true,
        commandLabel: '应用环境模型',
        successMessage: `环境模型已应用：${displayName}`,
        runtimeEnvironment: environmentConfig,
        expectedSceneSessionId,
      });
      if (!requestId) pushLog('环境模型未能开始加载，请查看 Scene View 状态。');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      pushLog(`环境模型读取失败：${message}`);
    }
  }

  /** 从资源库创建或更新唯一球形天空盒实体，并保留当前显示参数。 */
  function handleSkyboxAssetApply(asset: ProjectSkyboxAssetEntry): void {
    if (props.readOnly) return;
    try {
      placeSkybox(createSceneSkyboxFromAsset(asset, currentSkybox));
      pushLog(`球形天空盒已放置并选中：${asset.displayName}`);
    } catch (error) {
      const message = formatSkyboxSyncError(error);
      pushLog(`天空盒配置无效，未更新场景：${message}`);
    }
  }

  function handleResourceCardClick(item: ProjectLibraryItem): void {
    if (props.readOnly) return;
    if (isDataPlatformChartLibraryItem(item)) return;

    if (isBuiltInProjectLibraryItem(item)) {
      if (item.builtIn.kind === 'auto-patrol') {
        createAutoPatrol();
        return;
      }

      if (item.builtIn.kind === 'manual-roam-spawn') {
        createManualRoamSpawn();
        return;
      }

      if (item.builtIn.kind === 'model-generator') {
        createModelGenerator();
        return;
      }

      if (item.builtIn.kind === 'click-event-binding') {
        createClickEventBinding();
        return;
      }

      if (item.builtIn.kind === 'poi-effect') {
        createPoiEffect(item.builtIn.effectKind);
        return;
      }

      if (item.builtIn.kind === 'mesh') {
        createMesh(item.builtIn.meshKind);
        return;
      }

      if (item.builtIn.kind === 'locator') {
        createLocator();
        return;
      }

      createLight(item.builtIn.lightKind);
      return;
    }

    if (isBuiltInImageProjectLibraryItem(item)) return;

    if (isSyncedImageProjectLibraryItem(item)) return;

    if (isImportedProjectLibraryItem(item)) {
      if (item.asset.kind === 'skybox') {
        handleSkyboxAssetApply(item.asset);
        return;
      }

      if (activeLibrary.key === 'environment') {
        if (item.asset.kind !== 'model' || item.asset.libraryKind !== 'environment') return;
        void handleEnvironmentAssetApply(item.asset);
        return;
      }

      if (item.asset.kind !== 'model' || item.asset.libraryKind !== 'model') return;
      importModelAsset(item.asset);
    }
  }

  function handleResourceCardDragStart(event: DragEvent<HTMLButtonElement>, item: ProjectLibraryItem): void {
    if (props.readOnly) {
      event.preventDefault();
      return;
    }

    if (isDataPlatformChartLibraryItem(item)) {
      event.preventDefault();
      return;
    }

    if (isBuiltInProjectLibraryItem(item)) {
      event.dataTransfer.effectAllowed = 'copy';
      event.dataTransfer.setData(BUILT_IN_ASSET_DRAG_MIME_TYPE, encodeBuiltInAssetDragPayload(item.builtIn));
      event.dataTransfer.setData('text/plain', item.name);
      return;
    }

    if (isBuiltInImageProjectLibraryItem(item)) {
      event.dataTransfer.effectAllowed = 'copy';
      event.dataTransfer.setData(IMAGE_ASSET_DRAG_MIME_TYPE, encodeImageAssetDragPayload(item.imageAsset));
      event.dataTransfer.setData('text/plain', item.name);
      return;
    }

    if (isSyncedImageProjectLibraryItem(item)) {
      event.dataTransfer.effectAllowed = 'copy';
      event.dataTransfer.setData(
        IMAGE_ASSET_DRAG_MIME_TYPE,
        encodeImageAssetDragPayload({
          id: item.syncedImage.id,
          name: item.syncedImage.name,
          reference: item.syncedImage.reference,
          sourceUrl: item.syncedImage.sourceUrl,
        }),
      );
      event.dataTransfer.setData('text/plain', item.name);
      return;
    }

    if (isImportedProjectLibraryItem(item)) {
      if (item.asset.kind === 'skybox') {
        event.dataTransfer.effectAllowed = 'copy';
        event.dataTransfer.setData(SKYBOX_ASSET_DRAG_MIME_TYPE, encodeSkyboxAssetDragPayload(item.asset));
        event.dataTransfer.setData('text/plain', item.name);
        return;
      }

      if (item.asset.kind !== 'model') {
        event.preventDefault();
        return;
      }
      if (activeLibrary.key === 'environment' && item.asset.libraryKind !== 'environment') {
        event.preventDefault();
        return;
      }
      if (activeLibrary.key === 'model' && item.asset.libraryKind !== 'model') {
        event.preventDefault();
        return;
      }

      const projectAsset = item.asset as ProjectModelAssetEntry;
      const mimeType = projectAsset.libraryKind === 'environment'
        ? ENVIRONMENT_MODEL_ASSET_DRAG_MIME_TYPE
        : MODEL_ASSET_DRAG_MIME_TYPE;

      event.dataTransfer.effectAllowed = 'copy';
      event.dataTransfer.setData(mimeType, encodeModelAssetDragPayload(projectAsset));
      event.dataTransfer.setData('text/plain', item.name);
      return;
    }

    event.preventDefault();
  }

  const isImportButtonDisabled = props.readOnly || isImportingAsset || isLoadingProjectAssets;
  const supportsProjectImport = activeLibrary.key === 'model'
    || activeLibrary.key === 'environment'
    || activeLibrary.key === 'skybox';
  const importButtonLabel = isLoadingProjectAssets
    ? '加载项目中...'
    : isImportingAsset
      ? '导入中...'
      : activeLibrary.key === 'environment'
        ? '导入环境 GLB'
        : activeLibrary.key === 'skybox'
          ? '导入 HDR/EXR'
          : '导入模型文件夹';
  const skyboxSyncPhaseLabel = skyboxSyncProgress
    ? DATA_PLATFORM_SKYBOX_SYNC_PHASE_LABELS[skyboxSyncProgress.phase]
    : null;
  const skyboxSyncCountLabel = skyboxSyncProgress
    ? formatSkyboxSyncProgressCount(skyboxSyncProgress)
    : null;
  const skyboxSyncMessage = skyboxSyncProgress?.error
    || skyboxSyncProgress?.message
    || '等待天空盒同步进度...';
  const modelSyncPhaseLabel = modelSyncProgress
    ? DATA_PLATFORM_MODEL_SYNC_PHASE_LABELS[modelSyncProgress.phase]
    : null;
  const modelSyncCountLabel = modelSyncProgress
    ? `${modelSyncProgress.completed}/${modelSyncProgress.total}`
    : null;
  const modelSyncMessage = modelSyncProgress?.error || modelSyncProgress?.message || '等待模型同步进度...';
  const environmentSyncPhaseLabel = environmentSyncProgress
    ? DATA_PLATFORM_ENVIRONMENT_SYNC_PHASE_LABELS[environmentSyncProgress.phase]
    : null;
  const environmentSyncCountLabel = environmentSyncProgress
    ? `${environmentSyncProgress.completed}/${environmentSyncProgress.total}`
    : null;
  const environmentSyncMessage = environmentSyncProgress?.error || environmentSyncProgress?.message || '等待环境模型同步进度...';
  const imageSyncPhaseLabel = imageSyncProgress
    ? DATA_PLATFORM_IMAGE_SYNC_PHASE_LABELS[imageSyncProgress.phase]
    : null;
  const imageSyncCountLabel = imageSyncProgress
    ? `${imageSyncProgress.completed}/${imageSyncProgress.total}`
    : null;
  const imageSyncMessage = imageSyncProgress?.error || imageSyncProgress?.message || '等待图片同步进度...';
  const isImageSyncActive = imageSyncProgress !== null
    && imageSyncProgress.phase !== 'completed'
    && imageSyncProgress.phase !== 'failed';
  const chartSyncPhaseLabel = chartSyncProgress
    ? DATA_PLATFORM_CHART_SYNC_PHASE_LABELS[chartSyncProgress.phase]
    : null;
  const chartSyncCountLabel = chartSyncProgress && chartSyncProgress.total > 0
    ? `${chartSyncProgress.completed}/${chartSyncProgress.total}`
    : null;
  const chartSyncMessage = chartSyncProgress?.error || chartSyncProgress?.message || '等待大屏同步进度...';
  const isChartSyncActive = chartSyncProgress !== null
    && chartSyncProgress.phase !== 'completed'
    && chartSyncProgress.phase !== 'failed';

  return (
    <section className="panel project-library" aria-label="Project 资源库">
      <nav className="library-tabs" aria-label="资源库分类">
        {PROJECT_LIBRARIES.map((library) => {
          const isActive = library.key === activeLibrary.key;

          return (
            <button
              aria-pressed={isActive}
              className={isActive ? 'library-tab active' : 'library-tab'}
              key={library.key}
              onClick={() => {
                setActiveLibraryKey(library.key);
                setLibraryFilterText('');
                setModelDeviceTypeFilter('');
              }}
              type="button"
            >
              {library.label}
            </button>
          );
        })}
      </nav>

      <div className="library-filter-row" aria-label={`${activeLibrary.label}筛选`}>
        <label className="library-filter-label" htmlFor="project-library-search">
          {activeLibrary.searchLabel}
        </label>
        <input
          className="library-filter-input"
          id="project-library-search"
          onChange={(event) => setLibraryFilterText(event.target.value)}
          placeholder={activeLibrary.searchPlaceholder}
          type="text"
          value={libraryFilterText}
        />
        {activeLibrary.key === 'model' ? (
          <>
            <label className="library-filter-label" htmlFor="project-library-model-type">
              模型类型
            </label>
            <select
              className="library-filter-select"
              id="project-library-model-type"
              onChange={(event) => setModelDeviceTypeFilter(event.target.value)}
              value={modelDeviceTypeFilter}
            >
              <option value="">全部类型</option>
              {modelDeviceTypes.map((deviceType) => (
                <option key={deviceType} value={deviceType}>{deviceType}</option>
              ))}
            </select>
          </>
        ) : null}
        {supportsProjectImport ? (
          libraryStatus ? (
            <span className={`library-project-root library-status-${libraryStatus.kind}`} title={libraryStatus.message}>
              {libraryStatus.message}
            </span>
          ) : projectRoot ? (
            <span className="library-project-root" title={projectRoot}>当前项目：{projectRoot}</span>
          ) : null
        ) : null}
        {supportsProjectImport ? (
          <button
            className="library-import-button"
            disabled={isImportButtonDisabled}
            onClick={handleImportActiveLibrary}
            type="button"
          >
            {importButtonLabel}
          </button>
        ) : null}
        {activeLibrary.key === 'skybox' ? (
          <button
            className="library-import-button"
            disabled={props.readOnly || isStartingSkyboxSync || isSkyboxSyncActive || isRetryingSkyboxSync}
            onClick={() => void handleSyncDataPlatformSkyboxes()}
            type="button"
          >
            {isStartingSkyboxSync ? '启动同步...' : isSkyboxSyncActive ? '同步中...' : '同步数据中台天空盒'}
          </button>
        ) : null}
        {activeLibrary.key === 'chart' ? (
          <button
            className="library-import-button"
            disabled={props.readOnly || !chartSyncContextKey || isStartingChartSync || isChartSyncActive || isRetryingChartSync}
            onClick={() => void handleSyncDataPlatformCharts()}
            type="button"
          >
            {isStartingChartSync ? '启动同步...' : isChartSyncActive ? '同步中...' : '同步数据中台大屏'}
          </button>
        ) : null}
        {activeLibrary.key === 'image' ? (
          <button
            className="library-import-button"
            disabled={isImageSyncActive || isRetryingImageSync}
            onClick={() => void handleSyncDataPlatformImages()}
            type="button"
          >
            {isImageSyncActive ? '同步中...' : '从数据中台同步'}
          </button>
        ) : null}
      </div>

      <div
        className="resource-card-list"
        aria-label={`${activeLibrary.label}资源列表`}
        onWheel={(e) => {
          e.currentTarget.scrollLeft += e.deltaY;
        }}
      >
        {activeLibrary.key === 'model' && modelAssets.length === 0 ? (
          <p className="library-empty-state">尚未导入普通模型包</p>
        ) : null}
        {activeLibrary.key === 'environment' && environmentAssets.length === 0 ? (
          <p className="library-empty-state">请先导入环境 GLB 文件</p>
        ) : null}
        {activeLibrary.key === 'skybox' && skyboxAssets.length === 0 ? (
          <p className="library-empty-state">请先导入 HDR 或 EXR 天空盒</p>
        ) : null}
        {activeLibrary.key === 'chart' && !chartSyncContextKey ? (
          <p className="library-empty-state">当前工程未绑定数据中台项目</p>
        ) : null}
        {activeLibrary.key === 'chart' && chartSyncContextKey && isLoadingSyncedCharts && syncedCharts.length === 0 ? (
          <p className="library-empty-state">正在加载当前绑定项目的大屏...</p>
        ) : null}
        {activeLibrary.key === 'chart' && chartSyncContextKey && !isLoadingSyncedCharts && syncedCharts.length === 0 && !hasActiveLibraryFilter ? (
          <p className="library-empty-state">当前绑定项目暂无可同步的大屏</p>
        ) : null}
        {activeItems.length > 0 && filteredItems.length === 0 && hasActiveLibraryFilter ? (
          <p className="library-empty-state">未找到符合当前筛选条件的资源</p>
        ) : null}
        {filteredItems.map((item) => {
          const isBuiltInItem = isBuiltInProjectLibraryItem(item);
          const isBuiltInImage = isBuiltInImageProjectLibraryItem(item);
          const isImportedAsset = isImportedProjectLibraryItem(item);
          const isEnvironmentLibrary = activeLibrary.key === 'environment';
          const isSyncedImage = isSyncedImageProjectLibraryItem(item);
          const isSyncedChart = isDataPlatformChartLibraryItem(item);
          const isActionableItem = !isSyncedChart
            && ((!isEnvironmentLibrary && isBuiltInItem) || isBuiltInImage || isSyncedImage || isImportedAsset);

          return (
            <ResourceCard
              className={isImportedAsset && item.asset.kind === 'skybox' ? 'skybox-resource-card' : undefined}
              disabled={props.readOnly || !isActionableItem}
              draggable={!props.readOnly && isActionableItem}
              focused={item.id === focusedAssetId}
              item={item}
              key={item.id}
              library={activeLibrary}
              onClick={() => handleResourceCardClick(item)}
              onDragStart={(event) => handleResourceCardDragStart(event, item)}
              setButtonRef={(node) => {
                if (node) {
                  resourceCardRefs.current.set(item.id, node);
                } else {
                  resourceCardRefs.current.delete(item.id);
                }
              }}
              title={
                isBuiltInItem
                  ? `点击创建或拖拽到 Scene：${item.name}`
                  : isSyncedChart
                    ? `同步自数据中台的大屏：${item.name}`
                  : isBuiltInImage || isSyncedImage
                    ? `拖拽到模型 texture 属性：${item.name}`
                    : isImportedAsset
                      ? item.asset.kind === 'skybox'
                        ? `点击放置球形天空盒或拖拽到 Scene：${item.name}（${item.asset.format.toUpperCase()}）`
                        : isEnvironmentLibrary
                          ? `点击应用或拖拽到环境属性：${item.name}，${getModelUnitTitle(item.asset)}`
                          : `点击导入或拖拽到 Scene：${item.name}，${getModelUnitTitle(item.asset)}`
                      : '占位资源，功能后续接入'
              }
            />
          );
        })}
      </div>

      {activeLibrary.key === 'skybox' && orphanedCurrentSkybox ? (
        <div className="library-sync-status library-sync-status-warning" role="status" aria-live="polite">
          <div className="library-sync-status-heading">
            <strong>资源已从数据中台删除</strong>
          </div>
          <p title={`天空盒“${orphanedCurrentSkybox.displayName}”（数据中台资源 ID：${orphanedCurrentSkybox.dataPlatformResourceId}）已从数据中台删除。当前场景继续使用本地兼容缓存，但不能用于新场景；现有场景显示不受影响，重新选择天空盒时需使用仍在资源库中的资源。`}>
            天空盒“{orphanedCurrentSkybox.displayName}”（数据中台资源 ID：{orphanedCurrentSkybox.dataPlatformResourceId}）已从数据中台删除。
            当前场景继续使用本地兼容缓存，但不能用于新场景；现有场景显示不受影响，重新选择天空盒时需使用仍在资源库中的资源。
          </p>
        </div>
      ) : null}

      {activeLibrary.key === 'skybox' && skyboxSyncProgress ? (
        <div className={`library-sync-status library-sync-status-${skyboxSyncProgress.phase}`} role="status" aria-live="polite">
          <div className="library-sync-status-heading">
            <strong>{skyboxSyncPhaseLabel}</strong>
            {skyboxSyncCountLabel ? <span>{skyboxSyncCountLabel}</span> : null}
          </div>
          <p>{skyboxSyncMessage}</p>
          {skyboxSyncProgress.phase === 'failed' ? (
            <div className="library-sync-status-actions">
              {skyboxSyncReloadError ? (
                <button
                  disabled={isReloadingSkyboxAssets}
                  onClick={() => void handleReloadSkyboxAssets()}
                  type="button"
                >
                  {isReloadingSkyboxAssets ? '重新加载中...' : '重新加载资源库'}
                </button>
              ) : null}
              <button
                disabled={props.readOnly || isRetryingSkyboxSync || isReloadingSkyboxAssets}
                onClick={() => void handleRetryDataPlatformSkyboxSync()}
                type="button"
              >
                {isRetryingSkyboxSync ? '重试中...' : '重试同步'}
              </button>
              <button
                aria-label="关闭天空盒同步失败提示"
                className="library-sync-status-close-button"
                onClick={handleDismissDataPlatformSkyboxSyncFailure}
                type="button"
              >
                关闭
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      {activeLibrary.key === 'chart' && chartSyncProgress ? (
        <div className={`library-sync-status library-sync-status-${chartSyncProgress.phase}`} role="status" aria-live="polite">
          <div className="library-sync-status-heading">
            <strong>{chartSyncPhaseLabel}</strong>
            {chartSyncCountLabel ? <span>{chartSyncCountLabel}</span> : null}
          </div>
          <p>{chartSyncMessage}</p>
          {chartSyncProgress.phase === 'failed' ? (
            <div className="library-sync-status-actions">
              <button
                disabled={props.readOnly || !chartSyncContextKey || isRetryingChartSync}
                onClick={() => void handleRetryDataPlatformChartSync()}
                type="button"
              >
                {isRetryingChartSync ? '重试中...' : '重试大屏同步'}
              </button>
              <button
                aria-label="关闭大屏同步失败提示"
                className="library-sync-status-close-button"
                onClick={handleDismissDataPlatformChartSyncFailure}
                type="button"
              >
                关闭
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      {environmentSyncProgress ? (
        <div className={`library-sync-status library-sync-status-${environmentSyncProgress.phase}`} role="status" aria-live="polite">
          <div className="library-sync-status-heading">
            <strong>{environmentSyncPhaseLabel}</strong>
            {environmentSyncCountLabel ? <span>{environmentSyncCountLabel}</span> : null}
          </div>
          <p>{environmentSyncMessage}</p>
          {environmentSyncProgress.phase === 'failed' ? (
            <div className="library-sync-status-actions">
              <button disabled={isRetryingEnvironmentSync} onClick={() => void handleRetryDataPlatformEnvironmentSync()} type="button">
                {isRetryingEnvironmentSync ? '重试中...' : '重试环境同步'}
              </button>
              <button aria-label="关闭环境模型同步失败提示" className="library-sync-status-close-button" onClick={handleDismissDataPlatformEnvironmentSyncFailure} type="button">
                关闭
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      {modelSyncProgress ? (
        <div className={`library-sync-status library-sync-status-${modelSyncProgress.phase}`} role="status" aria-live="polite">
          <div className="library-sync-status-heading">
            <strong>{modelSyncPhaseLabel}</strong>
            {modelSyncCountLabel ? <span>{modelSyncCountLabel}</span> : null}
          </div>
          <p>{modelSyncMessage}</p>
          {modelSyncProgress.phase === 'failed' ? (
            <div className="library-sync-status-actions">
              <button
                disabled={isRetryingModelSync}
                onClick={() => void handleRetryDataPlatformModelSync()}
                type="button"
              >
                {isRetryingModelSync ? '重试中...' : '重试同步'}
              </button>
              <button
                aria-label="关闭同步失败提示"
                className="library-sync-status-close-button"
                onClick={handleDismissDataPlatformModelSyncFailure}
                type="button"
              >
                关闭
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      {imageSyncProgress ? (
        <div className={`library-sync-status library-sync-status-${imageSyncProgress.phase}`} role="status" aria-live="polite">
          <div className="library-sync-status-heading">
            <strong>{imageSyncPhaseLabel}</strong>
            {imageSyncCountLabel ? <span>{imageSyncCountLabel}</span> : null}
          </div>
          <p>{imageSyncMessage}</p>
          {imageSyncProgress.phase === 'failed' ? (
            <div className="library-sync-status-actions">
              <button
                disabled={isRetryingImageSync}
                onClick={() => void handleRetryDataPlatformImageSync()}
                type="button"
              >
                {isRetryingImageSync ? '重试中...' : '重试同步'}
              </button>
              <button
                aria-label="关闭同步失败提示"
                className="library-sync-status-close-button"
                onClick={handleDismissDataPlatformImageSyncFailure}
                type="button"
              >
                关闭
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

    </section>
  );
}
