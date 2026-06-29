import { useEffect, useMemo, useState, type DragEvent } from 'react';
import {
  encodeModelAssetDragPayload,
  MODEL_ASSET_DRAG_MIME_TYPE,
  type AssetEntry,
} from '../assets/AssetDatabase';
import { DEFAULT_MODEL_LENGTH_UNIT_INFO, formatModelLengthUnit } from '../model/sceneUnits';
import { useEditorStore } from '../store/editorStore';

type ProjectLibraryKey = 'model' | 'poi' | 'theme' | 'composition' | 'environment' | 'chart' | 'image';

type ProjectLibraryItem = {
  id: string;
  name: string;
  icon: string;
  asset?: AssetEntry;
};

type ProjectLibrary = {
  key: ProjectLibraryKey;
  label: string;
  searchLabel: string;
  searchPlaceholder: string;
  items: ProjectLibraryItem[];
};

type ModelFolderStatus = {
  message: string;
  kind: 'info' | 'error';
};

const PROJECT_LIBRARIES: ProjectLibrary[] = [
  {
    key: 'model',
    label: '模型库',
    searchLabel: '模型名称',
    searchPlaceholder: '请输入模型名称...',
    items: [
      { id: 'model-trigger', name: '事件触发器', icon: 'cube' },
      { id: 'model-sender', name: '发送器', icon: 'cube' },
      { id: 'model-receiver', name: '回收器', icon: 'cube' },
      { id: 'model-generator', name: '模型产生器', icon: 'ring' },
    ],
  },
  {
    key: 'poi',
    label: 'POI库',
    searchLabel: 'POI名称',
    searchPlaceholder: '请输入POI名称...',
    items: [
      { id: 'poi-chart-marker', name: '图表立标', icon: 'marker' },
      { id: 'poi-panel', name: '图表面板', icon: 'panel' },
      { id: 'poi-alarm', name: '报警管理器', icon: 'cube' },
      { id: 'poi-roam', name: '手动漫游', icon: 'person' },
    ],
  },
  {
    key: 'theme',
    label: '主题库',
    searchLabel: '主题名称',
    searchPlaceholder: '请输入主题名称...',
    items: [
      { id: 'theme-tech-blue', name: '科技蓝主题', icon: 'panel' },
      { id: 'theme-dark-city', name: '暗色城市', icon: 'ring' },
      { id: 'theme-energy', name: '能源监控', icon: 'marker' },
      { id: 'theme-command', name: '指挥中心', icon: 'panel' },
    ],
  },
  {
    key: 'composition',
    label: '组合库',
    searchLabel: '组合名称',
    searchPlaceholder: '请输入组合名称...',
    items: [
      { id: 'composition-device', name: '设备组合', icon: 'cube' },
      { id: 'composition-dashboard', name: '看板组合', icon: 'panel' },
      { id: 'composition-alarm', name: '告警组合', icon: 'marker' },
      { id: 'composition-scene', name: '场景组合', icon: 'ring' },
    ],
  },
  {
    key: 'environment',
    label: '环境库',
    searchLabel: '环境名称',
    searchPlaceholder: '请输入环境名称...',
    items: [
      { id: 'environment-sky', name: '天空环境', icon: 'ring' },
      { id: 'environment-ground', name: '地面环境', icon: 'marker' },
      { id: 'environment-light', name: '灯光环境', icon: 'panel' },
      { id: 'environment-weather', name: '天气环境', icon: 'cube' },
    ],
  },
  {
    key: 'chart',
    label: '图表库',
    searchLabel: '图表名称',
    searchPlaceholder: '请输入图表名称...',
    items: [
      { id: 'chart-board', name: '图表面板', icon: 'panel' },
      { id: 'chart-column', name: '柱状图', icon: 'marker' },
      { id: 'chart-line', name: '折线图', icon: 'panel' },
      { id: 'chart-ring', name: '环形图', icon: 'ring' },
    ],
  },
  {
    key: 'image',
    label: '图片库',
    searchLabel: '图片名称',
    searchPlaceholder: '请输入图片名称...',
    items: [
      { id: 'image-bg', name: '背景图片', icon: 'panel' },
      { id: 'image-icon', name: '图标贴图', icon: 'cube' },
      { id: 'image-mask', name: '遮罩图片', icon: 'ring' },
      { id: 'image-texture', name: '材质贴图', icon: 'marker' },
    ],
  },
];

function createModelLibraryItems(modelAssets: AssetEntry[]): ProjectLibraryItem[] {
  return modelAssets.map((asset) => ({
    id: asset.id,
    name: asset.displayName?.trim() || asset.name.replace(/\.(gltf|glb)$/i, ''),
    icon: 'cube',
    asset,
  }));
}

function ResourceIcon({ icon }: { icon: ProjectLibraryItem['icon'] }) {
  return <span className={`resource-card-icon resource-card-icon-${icon}`} aria-hidden="true" />;
}

function getModelUnitTitle(asset: AssetEntry): string {
  const lengthUnit = asset.lengthUnit ?? DEFAULT_MODEL_LENGTH_UNIT_INFO.lengthUnit;
  return `源单位：${formatModelLengthUnit(lengthUnit)} → m`;
}

export function ProjectPanel() {
  const importModelAsset = useEditorStore((state) => state.importModelAsset);
  const pushLog = useEditorStore((state) => state.pushLog);
  const [activeLibraryKey, setActiveLibraryKey] = useState<ProjectLibraryKey>('model');
  const [modelAssets, setModelAssets] = useState<AssetEntry[]>([]);
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
      return hasImportedModelFolder ? createModelLibraryItems(modelAssets) : activeLibrary.items;
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
    if (!item.asset) return;
    importModelAsset(item.asset);
  }

  function handleResourceCardDragStart(event: DragEvent<HTMLButtonElement>, item: ProjectLibraryItem): void {
    if (!item.asset) {
      event.preventDefault();
      return;
    }

    event.dataTransfer.effectAllowed = 'copy';
    event.dataTransfer.setData(MODEL_ASSET_DRAG_MIME_TYPE, encodeModelAssetDragPayload(item.asset));
    event.dataTransfer.setData('text/plain', item.name);
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
          const isImportedModel = Boolean(item.asset);

          return (
            <button
              className={isImportedModel ? 'resource-card resource-card-clickable' : 'resource-card'}
              disabled={!isImportedModel}
              draggable={isImportedModel}
              key={item.id}
              onClick={() => handleResourceCardClick(item)}
              onDragStart={(event) => handleResourceCardDragStart(event, item)}
              title={
                isImportedModel && item.asset
                  ? `点击导入或拖拽到 Scene：${item.name}，${getModelUnitTitle(item.asset)}`
                  : '占位资源，功能后续接入'
              }
              type="button"
            >
              <span className="resource-card-preview">
                <ResourceIcon icon={item.icon} />
              </span>
              <strong className="resource-card-name">{item.name}</strong>
            </button>
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
