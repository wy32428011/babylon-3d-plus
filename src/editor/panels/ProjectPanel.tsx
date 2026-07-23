import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import {
  BUILT_IN_ASSET_DRAG_MIME_TYPE,
  ENVIRONMENT_MODEL_ASSET_DRAG_MIME_TYPE,
  IMAGE_ASSET_DRAG_MIME_TYPE,
  encodeBuiltInAssetDragPayload,
  encodeImageAssetDragPayload,
  encodeModelAssetDragPayload,
  MODEL_ASSET_DRAG_MIME_TYPE,
  type AssetEntry,
  type ModelAssetLibraryKind,
  type ProjectModelAssetEntry,
} from '../assets/AssetDatabase';
import { loadEnvironmentFromAsset } from '../assets/environmentAssets';
import {
  BUILT_IN_MODEL_LIBRARY_ITEMS,
  PROJECT_LIBRARIES,
  createModelLibraryItems,
  getModelUnitTitle,
  isBuiltInImageProjectLibraryItem,
  isBuiltInProjectLibraryItem,
  isImportedProjectLibraryItem,
  type ProjectLibraryItem,
  type ProjectLibraryKey,
} from '../assets/projectLibrary';
import { useEditorStore } from '../store/editorStore';
import { ResourceCard } from '../ui/ResourceCard';

type ModelFolderStatus = {
  message: string;
  kind: 'info' | 'error';
};

type ImportableProjectLibraryKey = Extract<ProjectLibraryKey, ModelAssetLibraryKind>;

type ModelFolderStatusMap = Record<ImportableProjectLibraryKey, ModelFolderStatus | null>;

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

type ProjectPanelProps = {
  readOnly?: boolean;
};

/** 归一化项目资产路径，供同包重导时跨 Windows 分隔符和大小写比较。 */
function normalizeProjectAssetPathForMatch(value: string | undefined): string {
  return (value ?? '').trim().replace(/\\/g, '/').replace(/\/+/g, '/').toLowerCase();
}

export function ProjectPanel(props: ProjectPanelProps) {
  const importModelAsset = useEditorStore((state) => state.importModelAsset);
  const refreshModelInstancesFromAssets = useEditorStore((state) => state.refreshModelInstancesFromAssets);
  const updateEnvironmentConfig = useEditorStore((state) => state.updateEnvironmentConfig);
  const currentEnvironmentPackagePath = useEditorStore((state) => state.scene.sceneSettings.environment?.packagePath);
  const createMesh = useEditorStore((state) => state.createMesh);
  const createLocator = useEditorStore((state) => state.createLocator);
  const createLight = useEditorStore((state) => state.createLight);
  const createModelGenerator = useEditorStore((state) => state.createModelGenerator);
  const createPoiEffect = useEditorStore((state) => state.createPoiEffect);
  const projectAssetFocusRequest = useEditorStore((state) => state.projectAssetFocusRequest);
  const consumeProjectAssetFocusRequest = useEditorStore((state) => state.consumeProjectAssetFocusRequest);
  const pushLog = useEditorStore((state) => state.pushLog);
  const resourceCardRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const projectAssetsLoadRequestRef = useRef(0);
  const modelSyncCompletedDismissTimerRef = useRef<number | null>(null);
  const [activeLibraryKey, setActiveLibraryKey] = useState<ProjectLibraryKey>('model');
  const [libraryFilterText, setLibraryFilterText] = useState('');
  const [projectAssets, setProjectAssets] = useState<ProjectModelAssetEntry[]>([]);
  const [focusedAssetId, setFocusedAssetId] = useState<string | null>(null);
  const [projectRoot, setProjectRoot] = useState<string | null>(null);
  const [importingLibraryKey, setImportingLibraryKey] = useState<ImportableProjectLibraryKey | null>(null);
  const [isLoadingProjectAssets, setIsLoadingProjectAssets] = useState(false);
  const [modelFolderStatuses, setModelFolderStatuses] = useState<ModelFolderStatusMap>({ model: null, environment: null });
  const [modelSyncProgress, setModelSyncProgress] = useState<DataPlatformModelSyncProgress | null>(null);
  const [isRetryingModelSync, setIsRetryingModelSync] = useState(false);

  const modelAssets = useMemo(
    () => projectAssets.filter((asset) => asset.libraryKind === 'model'),
    [projectAssets],
  );
  const environmentAssets = useMemo(
    () => projectAssets.filter((asset) => asset.libraryKind === 'environment'),
    [projectAssets],
  );

  const activeLibrary = useMemo(
    () => PROJECT_LIBRARIES.find((library) => library.key === activeLibraryKey) ?? PROJECT_LIBRARIES[0],
    [activeLibraryKey],
  );

  const activeItems = useMemo(() => {
    if (activeLibrary.key === 'model') {
      return [...createModelLibraryItems(modelAssets), ...BUILT_IN_MODEL_LIBRARY_ITEMS];
    }

    if (activeLibrary.key === 'environment') {
      return createModelLibraryItems(environmentAssets);
    }

    return activeLibrary.items;
  }, [activeLibrary, environmentAssets, modelAssets]);

  const normalizedLibraryFilter = libraryFilterText.trim().toLowerCase();
  const filteredItems = useMemo(() => {
    if (!normalizedLibraryFilter) return activeItems;
    return activeItems.filter((item) => item.name.toLowerCase().includes(normalizedLibraryFilter));
  }, [activeItems, normalizedLibraryFilter]);

  const activeImportLibraryKey: ImportableProjectLibraryKey | null =
    activeLibrary.key === 'model' || activeLibrary.key === 'environment' ? activeLibrary.key : null;
  const isImportingModelFolder = importingLibraryKey !== null;
  const modelFolderStatus = activeImportLibraryKey ? modelFolderStatuses[activeImportLibraryKey] : null;

  /** 按分库存储导入状态，避免切换模型库和环境库时复用上一页文案。 */
  function setLibraryStatus(libraryKind: ImportableProjectLibraryKey, status: ModelFolderStatus | null): void {
    setModelFolderStatuses((current) => ({ ...current, [libraryKind]: status }));
  }

  const loadProjectAssets = useCallback(async (): Promise<void> => {
    if (!window.editorApi?.listProjectAssets) return;

    const requestId = projectAssetsLoadRequestRef.current + 1;
    projectAssetsLoadRequestRef.current = requestId;
    setIsLoadingProjectAssets(true);

    try {
      const result = await window.editorApi.listProjectAssets();
      if (requestId !== projectAssetsLoadRequestRef.current) return;

      setProjectRoot(result.projectRoot);
      setProjectAssets(result.assets);

      if (result.assets.length > 0) {
        pushLog(`已加载项目资源库：${result.assets.length} 个资产。`);
      }
    } catch (error) {
      if (requestId !== projectAssetsLoadRequestRef.current) return;
      const message = error instanceof Error ? error.message : String(error);
      pushLog(`加载项目资源库失败：${message}`);
    } finally {
      if (requestId === projectAssetsLoadRequestRef.current) {
        setIsLoadingProjectAssets(false);
      }
    }
  }, [pushLog]);

  useEffect(() => {
    void loadProjectAssets();
    return () => {
      projectAssetsLoadRequestRef.current += 1;
    };
  }, [loadProjectAssets]);

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
        void loadProjectAssets();
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

  /** 当前场景正在使用同一环境包时，用新 assetRevision 自动重建环境配置并触发运行时重载。 */
  async function refreshCurrentEnvironmentAfterImport(asset: ProjectModelAssetEntry): Promise<boolean> {
    const currentPackageKey = normalizeProjectAssetPathForMatch(currentEnvironmentPackagePath);
    const importedPackageKey = normalizeProjectAssetPathForMatch(asset.packagePath);
    if (!currentPackageKey || currentPackageKey !== importedPackageKey) return false;

    try {
      const environmentConfig = await loadEnvironmentFromAsset(asset);
      if (!environmentConfig) {
        pushLog('环境 GLB 已重导，但当前场景环境配置无效，未自动刷新。');
        return false;
      }

      updateEnvironmentConfig(environmentConfig);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      pushLog(`环境 GLB 已重导，但当前场景自动刷新失败：${message}`);
      return false;
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
      const refreshedCurrentEnvironment = await refreshCurrentEnvironmentAfterImport(result.importedAsset);
      const displayName = result.importedAsset.displayName?.trim()
        || result.importedAsset.name.replace(/\.glb$/i, '');
      const projectSuffix = result.projectRoot ? `，已写入项目：${result.projectRoot}` : '';
      const refreshSuffix = refreshedCurrentEnvironment ? '，已刷新当前场景环境模型' : '';
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

  /** 根据当前资源库选择普通模型文件夹或环境 GLB 的专用导入入口。 */
  function handleImportActiveLibrary(): void {
    if (activeImportLibraryKey === 'environment') {
      void handleImportEnvironmentModelFile();
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

      updateEnvironmentConfig(environmentConfig);
      const displayName = asset.displayName?.trim() || asset.name.replace(/\.(gltf|glb)$/i, '');
      pushLog(`环境模型已应用：${displayName}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      pushLog(`环境模型读取失败：${message}`);
    }
  }

  function handleResourceCardClick(item: ProjectLibraryItem): void {
    if (props.readOnly) return;

    if (isBuiltInProjectLibraryItem(item)) {
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

    if (isImportedProjectLibraryItem(item)) {
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

    if (isImportedProjectLibraryItem(item)) {
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

  const isModelImportButtonDisabled = props.readOnly || isImportingModelFolder || isLoadingProjectAssets;
  const supportsProjectModelImport = activeLibrary.key === 'model' || activeLibrary.key === 'environment';
  const importTargetLabel = activeLibrary.key === 'environment' ? '环境模型' : '模型';
  const modelImportButtonLabel = isLoadingProjectAssets
    ? '加载项目中...'
    : isImportingModelFolder
      ? '导入中...'
      : activeLibrary.key === 'environment'
        ? '导入环境 GLB'
        : `导入${importTargetLabel}文件夹`;
  const modelSyncPhaseLabel = modelSyncProgress
    ? DATA_PLATFORM_MODEL_SYNC_PHASE_LABELS[modelSyncProgress.phase]
    : null;
  const modelSyncCountLabel = modelSyncProgress
    ? `${modelSyncProgress.completed}/${modelSyncProgress.total}`
    : null;
  const modelSyncMessage = modelSyncProgress?.error || modelSyncProgress?.message || '等待模型同步进度...';

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
        {supportsProjectModelImport && projectRoot ? (
          <span className="library-project-root" title={projectRoot}>当前项目：{projectRoot}</span>
        ) : null}
        {supportsProjectModelImport ? (
          <button
            className="library-import-button"
            disabled={isModelImportButtonDisabled}
            onClick={handleImportActiveLibrary}
            type="button"
          >
            {modelImportButtonLabel}
          </button>
        ) : null}
      </div>

      <div className="resource-card-list" aria-label={`${activeLibrary.label}资源列表`}>
        {activeLibrary.key === 'model' && modelAssets.length === 0 ? (
          <p className="library-empty-state">尚未导入普通模型包</p>
        ) : null}
        {activeLibrary.key === 'environment' && environmentAssets.length === 0 ? (
          <p className="library-empty-state">请先导入环境 GLB 文件</p>
        ) : null}
        {filteredItems.length === 0 && normalizedLibraryFilter ? (
          <p className="library-empty-state">未找到名称匹配“{libraryFilterText.trim()}”的资源</p>
        ) : null}
        {filteredItems.map((item) => {
          const isBuiltInItem = isBuiltInProjectLibraryItem(item);
          const isBuiltInImage = isBuiltInImageProjectLibraryItem(item);
          const isImportedModel = isImportedProjectLibraryItem(item);
          const isEnvironmentLibrary = activeLibrary.key === 'environment';
          const isActionableItem = (!isEnvironmentLibrary && isBuiltInItem) || isBuiltInImage || isImportedModel;

          return (
            <ResourceCard
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
                  : isBuiltInImage
                    ? `拖拽到模型 texture 属性：${item.name}`
                    : isImportedModel
                      ? isEnvironmentLibrary
                        ? `点击应用或拖拽到环境属性：${item.name}，${getModelUnitTitle(item.asset)}`
                        : `点击导入或拖拽到 Scene：${item.name}，${getModelUnitTitle(item.asset)}`
                      : '占位资源，功能后续接入'
              }
            />
          );
        })}
      </div>

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

      {supportsProjectModelImport && modelFolderStatus ? (
        <p className={`library-status library-status-${modelFolderStatus.kind}`}>{modelFolderStatus.message}</p>
      ) : null}
    </section>
  );
}
