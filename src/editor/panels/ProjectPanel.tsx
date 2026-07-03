import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import {
  BUILT_IN_ASSET_DRAG_MIME_TYPE,
  encodeBuiltInAssetDragPayload,
  encodeModelAssetDragPayload,
  MODEL_ASSET_DRAG_MIME_TYPE,
  type AssetEntry,
} from '../assets/AssetDatabase';
import {
  BUILT_IN_MODEL_LIBRARY_ITEMS,
  PROJECT_LIBRARIES,
  createModelLibraryItems,
  getModelUnitTitle,
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

export function ProjectPanel() {
  const importModelAsset = useEditorStore((state) => state.importModelAsset);
  const createMesh = useEditorStore((state) => state.createMesh);
  const createLocator = useEditorStore((state) => state.createLocator);
  const createLight = useEditorStore((state) => state.createLight);
  const projectAssetFocusRequest = useEditorStore((state) => state.projectAssetFocusRequest);
  const consumeProjectAssetFocusRequest = useEditorStore((state) => state.consumeProjectAssetFocusRequest);
  const pushLog = useEditorStore((state) => state.pushLog);
  const resourceCardRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const [activeLibraryKey, setActiveLibraryKey] = useState<ProjectLibraryKey>('model');
  const [modelAssets, setModelAssets] = useState<AssetEntry[]>([]);
  const [focusedAssetId, setFocusedAssetId] = useState<string | null>(null);
  const [projectRoot, setProjectRoot] = useState<string | null>(null);
  const [hasImportedModelFolder, setHasImportedModelFolder] = useState(false);
  const [isImportingModelFolder, setIsImportingModelFolder] = useState(false);
  const [isLoadingProjectAssets, setIsLoadingProjectAssets] = useState(false);
  const [modelFolderStatus, setModelFolderStatus] = useState<ModelFolderStatus | null>(null);

  const activeLibrary = useMemo(
    () => PROJECT_LIBRARIES.find((library) => library.key === activeLibraryKey) ?? PROJECT_LIBRARIES[0],
    [activeLibraryKey],
  );

  const activeItems = useMemo(() => {
    if (activeLibrary.key === 'model') {
      return hasImportedModelFolder
        ? [...BUILT_IN_MODEL_LIBRARY_ITEMS, ...createModelLibraryItems(modelAssets)]
        : BUILT_IN_MODEL_LIBRARY_ITEMS;
    }

    return activeLibrary.items;
  }, [activeLibrary, hasImportedModelFolder, modelAssets]);

  useEffect(() => {
    let isMounted = true;

    async function loadProjectAssets(): Promise<void> {
      if (!window.editorApi?.listProjectAssets) return;

      setIsLoadingProjectAssets(true);

      try {
        const result = await window.editorApi.listProjectAssets();
        if (!isMounted) return;

        setProjectRoot(result.projectRoot);
        setModelAssets(result.assets);
        setHasImportedModelFolder(result.assets.length > 0);

        if (result.assets.length > 0) {
          pushLog(`已加载项目模型库：${result.assets.length} 个模型。`);
        }
      } catch (error) {
        if (!isMounted) return;
        const message = error instanceof Error ? error.message : String(error);
        pushLog(`加载项目模型库失败：${message}`);
      } finally {
        if (isMounted) setIsLoadingProjectAssets(false);
      }
    }

    void loadProjectAssets();

    return () => {
      isMounted = false;
    };
  }, [pushLog]);

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
  }, [activeLibraryKey, focusedAssetId, activeItems]);

  async function handleImportModelFolder(): Promise<void> {
    if (!window.editorApi?.importModelFolder) {
      const statusMessage = '导入模型文件夹需要 Electron 桌面环境，请使用 npm run dev:electron 启动编辑器。';
      setModelFolderStatus({ message: statusMessage, kind: 'error' });
      pushLog(statusMessage);
      return;
    }

    setIsImportingModelFolder(true);
    setModelFolderStatus({ message: '正在扫描模型文件夹...', kind: 'info' });

    try {
      const result = await window.editorApi.importModelFolder();

      if (result.canceled) {
        setModelFolderStatus(null);
        return;
      }

      setModelAssets(result.assets);
      setProjectRoot(result.projectRoot);
      setHasImportedModelFolder(result.assets.length > 0);

      const skippedSuffix = result.skipped.length > 0 ? `，跳过 ${result.skipped.length} 个目录` : '';
      const rootLabel = result.rootPath ?? '模型文件夹';
      const projectSuffix = result.projectRoot ? `，已写入项目：${result.projectRoot}` : '';
      const message = `模型文件夹已导入项目：${rootLabel}，发现 ${result.assets.length} 个模型${skippedSuffix}${projectSuffix}。`;
      setModelFolderStatus({ message, kind: 'info' });
      pushLog(message);

      if (result.assets.length === 0) {
        setModelFolderStatus({ message: '未发现可导入模型包。', kind: 'info' });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const statusMessage = `导入模型文件夹失败：${message}`;
      setModelFolderStatus({ message: statusMessage, kind: 'error' });
      pushLog(statusMessage);
    } finally {
      setIsImportingModelFolder(false);
    }
  }

  function handleResourceCardClick(item: ProjectLibraryItem): void {
    if (isBuiltInProjectLibraryItem(item)) {
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

    if (isImportedProjectLibraryItem(item)) {
      importModelAsset(item.asset);
    }
  }

  function handleResourceCardDragStart(event: DragEvent<HTMLButtonElement>, item: ProjectLibraryItem): void {
    if (isBuiltInProjectLibraryItem(item)) {
      event.dataTransfer.effectAllowed = 'copy';
      event.dataTransfer.setData(BUILT_IN_ASSET_DRAG_MIME_TYPE, encodeBuiltInAssetDragPayload(item.builtIn));
      event.dataTransfer.setData('text/plain', item.name);
      return;
    }

    if (isImportedProjectLibraryItem(item)) {
      event.dataTransfer.effectAllowed = 'copy';
      event.dataTransfer.setData(MODEL_ASSET_DRAG_MIME_TYPE, encodeModelAssetDragPayload(item.asset));
      event.dataTransfer.setData('text/plain', item.name);
      return;
    }

    event.preventDefault();
  }

  const isModelImportButtonDisabled = isImportingModelFolder || isLoadingProjectAssets;
  const modelImportButtonLabel = isLoadingProjectAssets
    ? '加载项目中...'
    : isImportingModelFolder
      ? '导入中...'
      : '导入模型文件夹';

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
              onClick={() => setActiveLibraryKey(library.key)}
              type="button"
            >
              {library.label}
            </button>
          );
        })}
      </nav>

      <div className="library-filter-row" aria-label={`${activeLibrary.label}筛选占位`}>
        <label className="library-filter-label" htmlFor="project-library-search">
          {activeLibrary.searchLabel}
        </label>
        <input
          className="library-filter-input"
          id="project-library-search"
          placeholder={activeLibrary.searchPlaceholder}
          readOnly
          type="text"
          value=""
        />
        {activeLibrary.key === 'model' ? (
          <button
            className="library-import-button"
            disabled={isModelImportButtonDisabled}
            onClick={() => void handleImportModelFolder()}
            type="button"
          >
            {modelImportButtonLabel}
          </button>
        ) : null}
      </div>

      <div className="resource-card-list" aria-label={`${activeLibrary.label}资源列表`}>
        {activeLibrary.key === 'model' && hasImportedModelFolder && activeItems.length === 0 ? (
          <p className="library-empty-state">未发现可导入模型包</p>
        ) : null}
        {activeItems.map((item) => {
          const isBuiltInItem = isBuiltInProjectLibraryItem(item);
          const isImportedModel = isImportedProjectLibraryItem(item);
          const isActionableItem = isBuiltInItem || isImportedModel;

          return (
            <ResourceCard
              disabled={!isActionableItem}
              draggable={isActionableItem}
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
                  : isImportedModel
                    ? `点击导入或拖拽到 Scene：${item.name}，${getModelUnitTitle(item.asset)}`
                    : '占位资源，功能后续接入'
              }
            />
          );
        })}
      </div>

      {activeLibrary.key === 'model' && modelFolderStatus ? (
        <p className={`library-status library-status-${modelFolderStatus.kind}`}>{modelFolderStatus.message}</p>
      ) : null}
      {activeLibrary.key === 'model' && projectRoot ? (
        <p className="library-status library-status-info">当前项目：{projectRoot}</p>
      ) : null}
    </section>
  );
}
