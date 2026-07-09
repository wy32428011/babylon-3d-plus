import { useEffect, useMemo, useState, type DragEvent, type KeyboardEvent, type ReactElement } from 'react';
import {
  decodeModelAssetDragPayload,
  ENVIRONMENT_MODEL_ASSET_DRAG_MIME_TYPE,
  MODEL_ASSET_DRAG_MIME_TYPE,
  type AssetEntry,
} from '../assets/AssetDatabase';
import { loadEnvironmentFromAsset } from '../assets/environmentAssets';
import {
  createModelLibraryItems,
  getModelUnitTitle,
  isImportedProjectLibraryItem,
  type ProjectLibrary,
} from '../assets/projectLibrary';
import {
  SCENE_SENSITIVITY_MAX,
  SCENE_SENSITIVITY_MIN,
  SCENE_VIEW_DISTANCE_MAX,
  SCENE_VIEW_DISTANCE_MIN,
  type SceneEnvironmentVariant,
} from '../model/SceneDocument';
import { useEditorStore, type SceneSensitivitySettingKey } from '../store/editorStore';
import { ResourceCard } from '../ui/ResourceCard';

const ENVIRONMENT_LIBRARY: ProjectLibrary = {
  key: 'model',
  label: '环境模型',
  searchLabel: '环境模型',
  searchPlaceholder: '',
  items: [],
};

const SENSITIVITY_ROWS: Array<{ key: SceneSensitivitySettingKey; label: string }> = [
  { key: 'zoom', label: '缩放灵敏度' },
  { key: 'pan', label: '移动灵敏度' },
  { key: 'rotate', label: '旋转灵敏度' },
];

function parseFiniteNumber(rawValue: string): number | null {
  if (rawValue === '') return null;

  const nextValue = Number(rawValue);
  return Number.isFinite(nextValue) ? nextValue : null;
}

/** 判断拖拽事件是否包含可用于环境属性的模型资产载荷。 */
function hasEnvironmentAssetDragPayload(event: DragEvent<HTMLElement>): boolean {
  return (
    event.dataTransfer.types.includes(ENVIRONMENT_MODEL_ASSET_DRAG_MIME_TYPE) ||
    event.dataTransfer.types.includes(MODEL_ASSET_DRAG_MIME_TYPE)
  );
}

/** 读取环境属性 drop 使用的模型资产，环境库专用载荷优先于普通模型库载荷。 */
function readEnvironmentAssetFromDrop(event: DragEvent<HTMLElement>): AssetEntry | null {
  const rawEnvironmentPayload = event.dataTransfer.getData(ENVIRONMENT_MODEL_ASSET_DRAG_MIME_TYPE);
  const environmentAsset = decodeModelAssetDragPayload(rawEnvironmentPayload);
  if (environmentAsset) return environmentAsset;

  const rawModelPayload = event.dataTransfer.getData(MODEL_ASSET_DRAG_MIME_TYPE);
  return decodeModelAssetDragPayload(rawModelPayload);
}

export function SceneSettingsPanel() {
  const scene = useEditorStore((state) => state.scene);
  const renameScene = useEditorStore((state) => state.renameScene);
  const resetSceneToBlank = useEditorStore((state) => state.resetSceneToBlank);
  const importCadReference = useEditorStore((state) => state.importCadReference);
  const requestCameraReset = useEditorStore((state) => state.requestCameraReset);
  const requestCameraPoseSave = useEditorStore((state) => state.requestCameraPoseSave);
  const setCameraViewDistance = useEditorStore((state) => state.setCameraViewDistance);
  const updateSensitivitySetting = useEditorStore((state) => state.updateSensitivitySetting);
  const updateEnvironmentConfig = useEditorStore((state) => state.updateEnvironmentConfig);
  const setEnvironmentActiveVariant = useEditorStore((state) => state.setEnvironmentActiveVariant);
  const [sceneNameDraft, setSceneNameDraft] = useState(scene.name);
  const [modelAssets, setModelAssets] = useState<AssetEntry[]>([]);
  const [environmentDialogOpen, setEnvironmentDialogOpen] = useState(false);
  const [environmentStatus, setEnvironmentStatus] = useState<string | null>(null);
  const [environmentDropActive, setEnvironmentDropActive] = useState(false);

  const environment = scene.sceneSettings.environment;
  const presetVariant = environment?.variants[0] ?? null;
  const customVariants = environment?.variants.slice(1) ?? [];
  const modelItems = useMemo(() => createModelLibraryItems(modelAssets), [modelAssets]);

  useEffect(() => {
    setSceneNameDraft(scene.name);
  }, [scene.name]);

  useEffect(() => {
    if (!environmentDialogOpen) return;

    let mounted = true;

    async function loadProjectModels(): Promise<void> {
      if (!window.editorApi?.listProjectAssets) {
        setEnvironmentStatus('当前环境未提供项目模型库。');
        return;
      }

      setEnvironmentStatus('正在加载项目模型库...');

      try {
        const result = await window.editorApi.listProjectAssets();
        if (!mounted) return;

        const assets = result.assets.filter((asset) => asset.kind === 'model');
        setModelAssets(assets);
        setEnvironmentStatus(assets.length > 0 ? null : '项目模型库为空，请先在底部模型库导入模型文件夹。');
      } catch (error) {
        if (!mounted) return;
        const message = error instanceof Error ? error.message : String(error);
        setEnvironmentStatus(`加载项目模型库失败：${message}`);
      }
    }

    void loadProjectModels();

    return () => {
      mounted = false;
    };
  }, [environmentDialogOpen]);

  function commitSceneName(): void {
    renameScene(sceneNameDraft);
  }

  function handleSceneNameKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key !== 'Enter') return;
    event.currentTarget.blur();
  }

  function handleResetScene(): void {
    if (!window.confirm('确定要初始化场景吗？未保存内容将丢失。')) return;
    resetSceneToBlank();
  }

  function handleViewDistanceChange(rawValue: string): void {
    const nextValue = parseFiniteNumber(rawValue);
    if (nextValue === null) return;
    setCameraViewDistance(nextValue);
  }

  function handleSensitivityChange(key: SceneSensitivitySettingKey, rawValue: string): void {
    const nextValue = parseFiniteNumber(rawValue);
    if (nextValue === null) return;
    updateSensitivitySetting(key, nextValue);
  }

  async function handleSelectEnvironmentAsset(asset: AssetEntry): Promise<void> {
    try {
      const environmentConfig = await loadEnvironmentFromAsset(asset);
      if (!environmentConfig) {
        setEnvironmentStatus('环境模型配置无效，未更新场景环境。');
        return;
      }

      updateEnvironmentConfig(environmentConfig);
      setEnvironmentDialogOpen(false);
      setEnvironmentStatus(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setEnvironmentStatus(`环境模型读取失败：${message}`);
    }
  }

  /** 允许模型库和环境库模型卡片在环境预览区触发 drop。 */
  function handleEnvironmentDragOver(event: DragEvent<HTMLButtonElement>): void {
    if (!hasEnvironmentAssetDragPayload(event)) return;

    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    setEnvironmentDropActive(true);
  }

  /** 拖拽离开环境预览区时移除高亮，避免悬停态残留。 */
  function handleEnvironmentDragLeave(event: DragEvent<HTMLButtonElement>): void {
    const relatedTarget = event.relatedTarget;
    if (relatedTarget instanceof Node && event.currentTarget.contains(relatedTarget)) return;

    setEnvironmentDropActive(false);
  }

  /** 在环境预览区释放模型卡片时应用为场景环境，不创建场景实体。 */
  function handleEnvironmentDrop(event: DragEvent<HTMLButtonElement>): void {
    const asset = readEnvironmentAssetFromDrop(event);
    if (!asset) return;

    event.preventDefault();
    event.stopPropagation();
    setEnvironmentDropActive(false);
    void handleSelectEnvironmentAsset(asset);
  }

  function renderEffectButton(variant: SceneEnvironmentVariant, label: string): ReactElement {
    const active = environment?.activeVariantUrl === variant.sourceUrl;

    return (
      <button
        className={active ? 'scene-effect-card active' : 'scene-effect-card'}
        key={variant.sourceUrl}
        onClick={() => setEnvironmentActiveVariant(variant.sourceUrl)}
        title={variant.sourcePath}
        type="button"
      >
        <span className="scene-effect-name">{label}</span>
        <span aria-hidden="true" className="scene-effect-icon" />
      </button>
    );
  }

  return (
    <section className="panel scene-settings-panel">
      <h2>Inspector</h2>
      <fieldset className="transform-fieldset">
        <legend>场景</legend>
        <label className="inspector-row">
          <span>场景名称</span>
          <input
            type="text"
            value={sceneNameDraft}
            onBlur={commitSceneName}
            onChange={(event) => setSceneNameDraft(event.target.value)}
            onKeyDown={handleSceneNameKeyDown}
          />
        </label>
        <div className="scene-settings-button-row">
          <button type="button" onClick={handleResetScene}>场景初始化</button>
          <button type="button" onClick={() => void importCadReference()}>导入CAD</button>
        </div>
      </fieldset>

      <fieldset className="transform-fieldset">
        <legend>相机</legend>
        <div className="scene-settings-button-row">
          <button type="button" onClick={requestCameraReset}>复位视角</button>
          <button type="button" onClick={requestCameraPoseSave}>保存当前视角</button>
        </div>
        <label className="scene-slider-row">
          <span>可视距离</span>
          <input
            min={SCENE_VIEW_DISTANCE_MIN}
            max={SCENE_VIEW_DISTANCE_MAX}
            step="100"
            type="range"
            value={scene.sceneSettings.camera.viewDistance}
            onChange={(event) => handleViewDistanceChange(event.target.value)}
          />
          <input
            min={SCENE_VIEW_DISTANCE_MIN}
            max={SCENE_VIEW_DISTANCE_MAX}
            step="100"
            type="number"
            value={scene.sceneSettings.camera.viewDistance}
            onChange={(event) => handleViewDistanceChange(event.target.value)}
          />
        </label>
      </fieldset>

      <fieldset className="transform-fieldset">
        <legend>编辑器设置</legend>
        {SENSITIVITY_ROWS.map((row) => (
          <label className="scene-slider-row" key={row.key}>
            <span>{row.label}</span>
            <input
              min={SCENE_SENSITIVITY_MIN}
              max={SCENE_SENSITIVITY_MAX}
              step="1"
              type="range"
              value={scene.sceneSettings.sensitivity[row.key]}
              onChange={(event) => handleSensitivityChange(row.key, event.target.value)}
            />
            <input
              min={SCENE_SENSITIVITY_MIN}
              max={SCENE_SENSITIVITY_MAX}
              step="1"
              type="number"
              value={scene.sceneSettings.sensitivity[row.key]}
              onChange={(event) => handleSensitivityChange(row.key, event.target.value)}
            />
          </label>
        ))}
      </fieldset>

      <fieldset className="transform-fieldset">
        <legend>环境属性</legend>
        <label className="environment-preview-row">
          <span>环境模型</span>
          <button
            className={environmentDropActive ? 'environment-preview-button environment-preview-button-drop-active' : 'environment-preview-button'}
            onDragEnter={handleEnvironmentDragOver}
            onDragLeave={handleEnvironmentDragLeave}
            onDragOver={handleEnvironmentDragOver}
            onDrop={handleEnvironmentDrop}
            onClick={() => setEnvironmentDialogOpen(true)}
            title="选择或拖入环境模型"
            type="button"
          >
            {environment?.thumbnailUrl ? (
              <img alt="" src={environment.thumbnailUrl} />
            ) : (
              <span className="environment-preview-placeholder" aria-hidden="true" />
            )}
          </button>
        </label>
        {environment ? (
          <button className="environment-clear-button" type="button" onClick={() => updateEnvironmentConfig(null)}>
            清除环境模型
          </button>
        ) : null}
        <div className="scene-effect-section">
          <span className="scene-effect-title">预设效果</span>
          <div className="scene-effect-list">
            {presetVariant ? renderEffectButton(presetVariant, '默认预设') : <p className="muted">未选择环境模型</p>}
          </div>
        </div>
        <div className="scene-effect-section">
          <span className="scene-effect-title">自定义效果</span>
          <div className="scene-effect-list">
            {customVariants.length > 0
              ? customVariants.map((variant) => renderEffectButton(variant, variant.name))
              : <p className="muted">暂无自定义效果</p>}
          </div>
        </div>
      </fieldset>

      {environmentDialogOpen ? (
        <div
          className="environment-dialog-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setEnvironmentDialogOpen(false);
          }}
        >
          <div className="environment-dialog" role="dialog" aria-label="选择环境模型">
            <div className="environment-dialog-header">
              <h3>选择环境模型</h3>
              <button type="button" onClick={() => setEnvironmentDialogOpen(false)}>关闭</button>
            </div>
            <div className="environment-dialog-list">
              {modelItems.map((item) => {
                if (!isImportedProjectLibraryItem(item)) return null;

                return (
                  <ResourceCard
                    className="environment-resource-card"
                    draggable={false}
                    item={item}
                    key={item.id}
                    library={ENVIRONMENT_LIBRARY}
                    onClick={() => void handleSelectEnvironmentAsset(item.asset)}
                    title={`选择环境模型：${item.name}，${getModelUnitTitle(item.asset)}`}
                  />
                );
              })}
              {environmentStatus ? <p className="environment-dialog-status">{environmentStatus}</p> : null}
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
