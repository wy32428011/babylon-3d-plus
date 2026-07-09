import { useEffect, useMemo, useState, type KeyboardEvent, type ReactElement } from 'react';
import type { AssetEntry } from '../assets/AssetDatabase';
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
  sanitizeSceneEnvironment,
  type SceneEnvironmentSettings,
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

function createFallbackVariant(asset: AssetEntry): SceneEnvironmentVariant {
  return {
    name: asset.displayName?.trim() || asset.name.replace(/\.(gltf|glb)$/i, '') || '默认预设',
    sourcePath: asset.path,
    sourceUrl: asset.sourceUrl,
  };
}

function createEnvironmentFromAsset(asset: AssetEntry, variants: SceneEnvironmentVariant[]): SceneEnvironmentSettings | null {
  const safeVariants = variants.length > 0 ? variants : [createFallbackVariant(asset)];

  return sanitizeSceneEnvironment({
    packagePath: asset.packagePath ?? asset.path,
    thumbnailUrl: asset.thumbnailUrl,
    activeVariantUrl: safeVariants[0].sourceUrl,
    variants: safeVariants,
  });
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
    let variants: SceneEnvironmentVariant[] = [createFallbackVariant(asset)];

    try {
      if (asset.packagePath && window.editorApi?.listModelPackageVariants) {
        const result = await window.editorApi.listModelPackageVariants({ packagePath: asset.packagePath });
        if (result.length > 0) {
          variants = result.map((variant) => ({
            name: variant.name,
            sourcePath: variant.path,
            sourceUrl: variant.sourceUrl,
          }));
        }
      }

      const environmentConfig = createEnvironmentFromAsset(asset, variants);
      updateEnvironmentConfig(environmentConfig);
      setEnvironmentDialogOpen(false);
      setEnvironmentStatus(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setEnvironmentStatus(`环境模型读取失败：${message}`);
    }
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
            className="environment-preview-button"
            onClick={() => setEnvironmentDialogOpen(true)}
            title="选择环境模型"
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
