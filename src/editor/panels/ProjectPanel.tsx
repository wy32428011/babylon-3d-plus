import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
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
  normalizeSkyboxSyncProgress,
  refreshCurrentSkyboxAfterProjectAssetsLoad,
  type SkyboxSyncProgress,
} from '../assets/skyboxAssets';
import { createImportedAssetIndexes, findImportedAssetForPackagePath } from '../assets/modelAssetRelink';
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
import { setSyncedImageAssets } from '../../assets/syncedImageAssets';
import { useEditorStore } from '../store/editorStore';
import { ResourceCard } from '../ui/ResourceCard';

type LibraryStatus = {
  message: string;
  kind: 'info' | 'error';
};

type ImportableProjectLibraryKey = 'model' | 'environment' | 'skybox';

type LibraryStatusMap = Record<ImportableProjectLibraryKey, LibraryStatus | null>;

type DataPlatformModelSyncProgress = {
  runId: string;
  phase: 'querying' | 'downloading' | 'validating' | 'promoting' | 'completed' | 'failed';
  completed: number;
  total: number;
  message: string;
  error: string | null;
};

type DataPlatformModelSyncApi = {
  onDataPlatformModelSyncProgress?: (listener: (progress: DataPlatformModelSyncProgress) => void) => () => void;
  retryDataPlatformModelSync?: () => Promise<boolean>;
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

type DataPlatformSkyboxSyncProgress = SkyboxSyncProgress;

type DataPlatformSkyboxSyncApi = {
  syncDataPlatformSkyboxes?: () => Promise<boolean>;
  retryDataPlatformSkyboxSync?: () => Promise<boolean>;
  onDataPlatformSkyboxSyncProgress?: (listener: (progress: DataPlatformSkyboxSyncProgress) => void) => () => void;
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

function createLocalSkyboxSyncProgress(
  runId: string,
  phase: 'querying' | 'failed',
  message: string,
  error: unknown = null,
): DataPlatformSkyboxSyncProgress {
  return normalizeSkyboxSyncProgress({
    runId,
    phase,
    completed: 0,
    total: 0,
    message,
    error: phase === 'failed' ? error ?? message : null,
  }).progress;
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
  const currentSkybox = useMemo(() => getSceneSkyboxSettings(sceneDocument), [sceneDocument]);
  const currentEnvironment = useEditorStore((state) => state.scene.sceneSettings.environment);
  const createMesh = useEditorStore((state) => state.createMesh);
  const createLocator = useEditorStore((state) => state.createLocator);
  const createLight = useEditorStore((state) => state.createLight);
  const createModelGenerator = useEditorStore((state) => state.createModelGenerator);
  const createAutoPatrol = useEditorStore((state) => state.createAutoPatrol);
  const createPoiEffect = useEditorStore((state) => state.createPoiEffect);
  const projectAssetFocusRequest = useEditorStore((state) => state.projectAssetFocusRequest);
  const consumeProjectAssetFocusRequest = useEditorStore((state) => state.consumeProjectAssetFocusRequest);
  const pushLog = useEditorStore((state) => state.pushLog);
  const resourceCardRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const currentSkyboxRef = useRef(currentSkybox);
  const currentEnvironmentRef = useRef(currentEnvironment);
  const projectAssetsLoadRequestRef = useRef(0);
  const componentMountedRef = useRef(true);
  const skyboxSyncStartInFlightRef = useRef(false);
  const skyboxSyncRetryInFlightRef = useRef(false);
  const skyboxSyncLocalRunCounterRef = useRef(0);
  const skyboxSyncCompletedDismissTimerRef = useRef<number | null>(null);
  const lastSceneRefreshSkyboxSyncRunIdRef = useRef<string | null>(null);
  const modelSyncCompletedDismissTimerRef = useRef<number | null>(null);
  const lastSceneRefreshModelSyncRunIdRef = useRef<string | null>(null);
  const imageSyncCompletedDismissTimerRef = useRef<number | null>(null);
  const lastSceneRefreshImageSyncRunIdRef = useRef<string | null>(null);
  const [activeLibraryKey, setActiveLibraryKey] = useState<ProjectLibraryKey>('model');
  const [libraryFilterText, setLibraryFilterText] = useState('');
  const [modelDeviceTypeFilter, setModelDeviceTypeFilter] = useState('');
  const [projectAssets, setProjectAssets] = useState<ProjectModelAssetEntry[]>([]);
  const [skyboxAssets, setSkyboxAssets] = useState<ProjectSkyboxAssetEntry[]>([]);
  const [orphanedSkyboxAssets, setOrphanedSkyboxAssets] = useState<ProjectSkyboxAssetEntry[]>([]);
  const [focusedAssetId, setFocusedAssetId] = useState<string | null>(null);
  const [projectRoot, setProjectRoot] = useState<string | null>(null);
  const [importingLibraryKey, setImportingLibraryKey] = useState<ImportableProjectLibraryKey | null>(null);
  const [isLoadingProjectAssets, setIsLoadingProjectAssets] = useState(false);
  const [libraryStatuses, setLibraryStatuses] = useState<LibraryStatusMap>({ model: null, environment: null, skybox: null });
  const [skyboxSyncProgress, setSkyboxSyncProgress] = useState<DataPlatformSkyboxSyncProgress | null>(null);
  const [isStartingSkyboxSync, setIsStartingSkyboxSync] = useState(false);
  const [isRetryingSkyboxSync, setIsRetryingSkyboxSync] = useState(false);
  const [modelSyncProgress, setModelSyncProgress] = useState<DataPlatformModelSyncProgress | null>(null);
  const [isRetryingModelSync, setIsRetryingModelSync] = useState(false);
  const [syncedImages, setSyncedImages] = useState<SyncedImageAssetEntry[]>([]);
  const [imageSyncProgress, setImageSyncProgress] = useState<DataPlatformImageSyncProgress | null>(null);
  const [isRetryingImageSync, setIsRetryingImageSync] = useState(false);

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

    if (activeLibrary.key === 'image') {
      return [
        ...createImageLibraryItems(),
        ...createSyncedImageLibraryItems(syncedImages),
      ];
    }

    return activeLibrary.items;
  }, [activeLibrary, environmentAssets, modelAssets, skyboxAssets, syncedImages]);

  const normalizedLibraryFilter = libraryFilterText.trim().toLowerCase();
  const hasActiveLibraryFilter = Boolean(normalizedLibraryFilter)
    || (activeLibrary.key === 'model' && Boolean(modelDeviceTypeFilter));
  const filteredItems = useMemo(() => {
    if (!hasActiveLibraryFilter) return activeItems;

    return activeItems.filter((item) => {
      const matchesName = !normalizedLibraryFilter
        || item.name.toLowerCase().includes(normalizedLibraryFilter)
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
  ): Promise<boolean> => {
    const environment = currentEnvironmentRef.current;
    if (!environment) return false;

    const environmentAssets = assets.filter((asset) => asset.libraryKind === 'environment');
    const matchedAsset = findImportedAssetForPackagePath(
      environment.packagePath,
      createImportedAssetIndexes(environmentAssets),
    );
    if (!matchedAsset || matchedAsset.libraryKind !== 'environment') return false;

    try {
      const environmentConfig = await loadEnvironmentFromAsset(matchedAsset, environment);
      if (!environmentConfig) {
        pushLog('环境模型资源已更新，但当前场景环境配置无效，未自动刷新。');
        return false;
      }

      const requestId = requestEnvironmentApply(environmentConfig, {
        autoAlign: false,
        focusAfterLoad: false,
        commandLabel: '刷新环境模型资源',
        successMessage: '环境模型资源已刷新，并保留当前摆放与显示设置。',
      });
      return requestId !== null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      pushLog(`环境模型资源已更新，但当前场景自动刷新失败：${message}`);
      return false;
    }
  }, [pushLog, requestEnvironmentApply]);

  useEffect(() => {
    componentMountedRef.current = true;
    return () => {
      componentMountedRef.current = false;
      skyboxSyncStartInFlightRef.current = false;
      skyboxSyncRetryInFlightRef.current = false;
    };
  }, []);

  useEffect(() => {
    currentSkyboxRef.current = currentSkybox;
  }, [currentSkybox]);

  useEffect(() => {
    currentEnvironmentRef.current = currentEnvironment;
  }, [currentEnvironment]);

  /** 用项目资源库中的稳定同名资产刷新当前天空盒路径，并保留场景级显示参数。 */
  const refreshCurrentSkyboxFromAssets = useCallback((
    assets: ProjectSkyboxAssetEntry[],
  ): boolean => {
    const activeSkybox = currentSkyboxRef.current;
    if (!activeSkybox) return false;
    const matchedAsset = findSkyboxAssetForSettings(activeSkybox, assets);
    if (!matchedAsset) return false;

    try {
      const refreshedSkybox = createSceneSkyboxFromAsset(matchedAsset, activeSkybox);
      if (JSON.stringify(refreshedSkybox) === JSON.stringify(activeSkybox)) return false;
      updateSkyboxConfig(refreshedSkybox);
      return true;
    } catch (error) {
      const message = formatSkyboxSyncError(error);
      pushLog(`天空盒资源已更新，但当前场景自动刷新失败：${message}`);
      return false;
    }
  }, [pushLog, updateSkyboxConfig]);

  const loadProjectAssets = useCallback(async (refreshSceneAssets = false): Promise<boolean> => {
    if (!window.editorApi?.listProjectAssets) return false;

    const requestId = projectAssetsLoadRequestRef.current + 1;
    projectAssetsLoadRequestRef.current = requestId;
    setIsLoadingProjectAssets(true);

    try {
      const result = await window.editorApi.listProjectAssets();
      if (requestId !== projectAssetsLoadRequestRef.current) return false;

      const loadedSkyboxes = result.skyboxes ?? [];
      setProjectRoot(result.projectRoot);
      setProjectAssets(result.assets);
      setSkyboxAssets(result.skyboxes ?? []);
      setOrphanedSkyboxAssets(result.orphanedSkyboxes ?? []);

      const totalAssetCount = result.assets.length + loadedSkyboxes.length;
      if (totalAssetCount > 0) {
        pushLog(`已加载项目资源库：${totalAssetCount} 个资产。`);
      }

      refreshCurrentSkyboxAfterProjectAssetsLoad(
        refreshSceneAssets,
        loadedSkyboxes,
        refreshCurrentSkyboxFromAssets,
      );
      if (refreshSceneAssets) {
        refreshModelInstancesFromAssets(result.assets.filter((asset) => asset.libraryKind === 'model'));
        await refreshCurrentEnvironmentFromAssets(result.assets);
      }
      return true;
    } catch (error) {
      if (requestId !== projectAssetsLoadRequestRef.current) return false;
      const message = formatSkyboxSyncError(error);
      pushLog(`加载项目资源库失败：${message}`);
      return false;
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

  useEffect(() => {
    void loadProjectAssets();
    void loadSyncedImages();
    return () => {
      projectAssetsLoadRequestRef.current += 1;
    };
  }, [loadProjectAssets, loadSyncedImages]);

  useEffect(() => {
    const dataPlatformModelSyncApi = getDataPlatformModelSyncApi();
    if (!dataPlatformModelSyncApi.onDataPlatformModelSyncProgress) return undefined;

    const clearCompletedDismissTimer = () => {
      if (modelSyncCompletedDismissTimerRef.current === null) return;
      window.clearTimeout(modelSyncCompletedDismissTimerRef.current);
      modelSyncCompletedDismissTimerRef.current = null;
    };
    const unsubscribe = dataPlatformModelSyncApi.onDataPlatformModelSyncProgress((progress) => {
      clearCompletedDismissTimer();
      setModelSyncProgress(progress);
      const phaseLabel = DATA_PLATFORM_MODEL_SYNC_PHASE_LABELS[progress.phase];
      const countLabel = progress.total > 0 ? `（${progress.completed}/${progress.total}）` : '';
      const detail = progress.error || progress.message;
      pushLog(`数据中台模型同步：${phaseLabel}${countLabel}${detail ? `：${detail}` : ''}`);

      if (progress.phase === 'completed') {
        const shouldRefreshSceneAssets = lastSceneRefreshModelSyncRunIdRef.current !== progress.runId;
        if (shouldRefreshSceneAssets) {
          lastSceneRefreshModelSyncRunIdRef.current = progress.runId;
          void loadProjectAssets(true).then((loaded) => {
            if (!loaded && lastSceneRefreshModelSyncRunIdRef.current === progress.runId) {
              lastSceneRefreshModelSyncRunIdRef.current = null;
            }
          });
        }
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
  }, [loadProjectAssets, pushLog]);

  useEffect(() => {
    const dataPlatformSkyboxSyncApi = getDataPlatformSkyboxSyncApi();
    if (!dataPlatformSkyboxSyncApi.onDataPlatformSkyboxSyncProgress) return undefined;

    let active = true;
    const clearCompletedDismissTimer = () => {
      if (skyboxSyncCompletedDismissTimerRef.current === null) return;
      window.clearTimeout(skyboxSyncCompletedDismissTimerRef.current);
      skyboxSyncCompletedDismissTimerRef.current = null;
    };
    const unsubscribe = dataPlatformSkyboxSyncApi.onDataPlatformSkyboxSyncProgress((progress) => {
      if (!active) return;
      clearCompletedDismissTimer();
      const { progress: normalizedProgress, shouldReloadProjectAssets } = normalizeSkyboxSyncProgress(progress);
      setSkyboxSyncProgress(normalizedProgress);
      const phaseLabel = DATA_PLATFORM_SKYBOX_SYNC_PHASE_LABELS[normalizedProgress.phase];
      const countLabel = formatSkyboxSyncProgressCount(normalizedProgress);
      const detail = normalizedProgress.error || normalizedProgress.message;
      pushLog(`数据中台天空盒同步：${phaseLabel}${countLabel ? `（${countLabel}）` : ''}${detail ? `：${detail}` : ''}`);

      if (shouldReloadProjectAssets) {
        const shouldRefreshSceneAssets = lastSceneRefreshSkyboxSyncRunIdRef.current !== normalizedProgress.runId;
        if (shouldRefreshSceneAssets) {
          lastSceneRefreshSkyboxSyncRunIdRef.current = normalizedProgress.runId;
          void loadProjectAssets(true).then((loaded) => {
            if (!active) return;
            if (!loaded && lastSceneRefreshSkyboxSyncRunIdRef.current === normalizedProgress.runId) {
              lastSceneRefreshSkyboxSyncRunIdRef.current = null;
            }
          });
        }
        skyboxSyncCompletedDismissTimerRef.current = window.setTimeout(() => {
          if (!active) return;
          skyboxSyncCompletedDismissTimerRef.current = null;
          setSkyboxSyncProgress((current) =>
            current?.runId === normalizedProgress.runId && current.phase === 'completed' ? null : current,
          );
        }, 2200);
      }
    });

    return () => {
      active = false;
      clearCompletedDismissTimer();
      unsubscribe();
    };
  }, [loadProjectAssets, pushLog]);

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
    if (
      props.readOnly
      || skyboxSyncStartInFlightRef.current
      || skyboxSyncRetryInFlightRef.current
      || isSkyboxSyncActive
    ) return;

    skyboxSyncLocalRunCounterRef.current += 1;
    const runId = `renderer-skybox-sync-${skyboxSyncLocalRunCounterRef.current}`;
    const dataPlatformSkyboxSyncApi = getDataPlatformSkyboxSyncApi();
    skyboxSyncStartInFlightRef.current = true;
    setIsStartingSkyboxSync(true);
    setSkyboxSyncProgress(createLocalSkyboxSyncProgress(runId, 'querying', '正在启动数据中台天空盒同步...'));

    try {
      if (!dataPlatformSkyboxSyncApi.syncDataPlatformSkyboxes) {
        const statusMessage = '同步数据中台天空盒需要 Electron 桌面环境。';
        if (componentMountedRef.current) {
          setSkyboxSyncProgress(createLocalSkyboxSyncProgress(runId, 'failed', statusMessage, statusMessage));
          pushLog(statusMessage);
        }
        return;
      }

      const started = await dataPlatformSkyboxSyncApi.syncDataPlatformSkyboxes();
      if (!componentMountedRef.current) return;
      if (!started) {
        const statusMessage = '数据中台天空盒同步未能启动，请检查数据中台连接配置。';
        setSkyboxSyncProgress(createLocalSkyboxSyncProgress(runId, 'failed', statusMessage, statusMessage));
        pushLog(statusMessage);
      }
    } catch (error) {
      if (!componentMountedRef.current) return;
      const message = formatSkyboxSyncError(error);
      const statusMessage = `启动数据中台天空盒同步失败：${message}`;
      setSkyboxSyncProgress(createLocalSkyboxSyncProgress(runId, 'failed', statusMessage, error));
      pushLog(statusMessage);
    } finally {
      skyboxSyncStartInFlightRef.current = false;
      if (componentMountedRef.current) setIsStartingSkyboxSync(false);
    }
  }

  async function handleRetryDataPlatformSkyboxSync(): Promise<void> {
    if (
      props.readOnly
      || !skyboxSyncProgress
      || skyboxSyncProgress.phase !== 'failed'
      || skyboxSyncStartInFlightRef.current
      || skyboxSyncRetryInFlightRef.current
      || isSkyboxSyncActive
    ) return;

    skyboxSyncLocalRunCounterRef.current += 1;
    const runId = `renderer-skybox-retry-${skyboxSyncLocalRunCounterRef.current}`;
    const dataPlatformSkyboxSyncApi = getDataPlatformSkyboxSyncApi();
    skyboxSyncRetryInFlightRef.current = true;
    setIsRetryingSkyboxSync(true);
    setSkyboxSyncProgress(createLocalSkyboxSyncProgress(runId, 'querying', '已提交重试，正在重新查询天空盒...'));

    try {
      if (!dataPlatformSkyboxSyncApi.retryDataPlatformSkyboxSync) {
        const statusMessage = '重试数据中台天空盒同步需要 Electron 桌面环境。';
        if (componentMountedRef.current) {
          setSkyboxSyncProgress(createLocalSkyboxSyncProgress(runId, 'failed', statusMessage, statusMessage));
          pushLog(statusMessage);
        }
        return;
      }

      const retryStarted = await dataPlatformSkyboxSyncApi.retryDataPlatformSkyboxSync();
      if (!componentMountedRef.current) return;
      if (!retryStarted) {
        const statusMessage = '当前没有可重试的天空盒同步任务。';
        setSkyboxSyncProgress(createLocalSkyboxSyncProgress(runId, 'failed', statusMessage, statusMessage));
        pushLog(statusMessage);
      }
    } catch (error) {
      if (!componentMountedRef.current) return;
      const message = formatSkyboxSyncError(error);
      const statusMessage = `重试数据中台天空盒同步失败：${message}`;
      setSkyboxSyncProgress(createLocalSkyboxSyncProgress(runId, 'failed', statusMessage, error));
      pushLog(statusMessage);
    } finally {
      skyboxSyncRetryInFlightRef.current = false;
      if (componentMountedRef.current) setIsRetryingSkyboxSync(false);
    }
  }

  function handleDismissDataPlatformSkyboxSyncFailure(): void {
    if (skyboxSyncProgress?.phase !== 'failed') return;
    setSkyboxSyncProgress(null);
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
      const refreshedCurrentEnvironment = await refreshCurrentEnvironmentFromAssets([result.importedAsset]);
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

    try {
      const environmentConfig = await loadEnvironmentFromAsset(asset);
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
      placeSkybox(createSceneSkyboxFromAsset(asset, currentSkyboxRef.current));
      pushLog(`球形天空盒已放置并选中：${asset.displayName}`);
    } catch (error) {
      const message = formatSkyboxSyncError(error);
      pushLog(`天空盒配置无效，未更新场景：${message}`);
    }
  }

  function handleResourceCardClick(item: ProjectLibraryItem): void {
    if (props.readOnly) return;

    if (isBuiltInProjectLibraryItem(item)) {
      if (item.builtIn.kind === 'auto-patrol') {
        createAutoPatrol();
        return;
      }

      if (item.builtIn.kind === 'model-generator') {
        createModelGenerator();
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
        {filteredItems.length === 0 && hasActiveLibraryFilter ? (
          <p className="library-empty-state">未找到符合当前筛选条件的资源</p>
        ) : null}
        {filteredItems.map((item) => {
          const isBuiltInItem = isBuiltInProjectLibraryItem(item);
          const isBuiltInImage = isBuiltInImageProjectLibraryItem(item);
          const isImportedAsset = isImportedProjectLibraryItem(item);
          const isEnvironmentLibrary = activeLibrary.key === 'environment';
          const isSyncedImage = isSyncedImageProjectLibraryItem(item);
          const isActionableItem = (!isEnvironmentLibrary && isBuiltInItem) || isBuiltInImage || isSyncedImage || isImportedAsset;

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
          <p>
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
              <button
                disabled={props.readOnly || isRetryingSkyboxSync}
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
