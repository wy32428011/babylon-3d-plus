import { useEffect, useMemo, useState, type DragEvent, type KeyboardEvent, type ReactElement } from 'react';
import {
  decodeModelAssetDragPayload,
  decodeSkyboxAssetDragPayload,
  ENVIRONMENT_MODEL_ASSET_DRAG_MIME_TYPE,
  SKYBOX_ASSET_DRAG_MIME_TYPE,
  type ProjectModelAssetEntry,
  type ProjectSkyboxAssetEntry,
} from '../assets/AssetDatabase';
import { loadEnvironmentFromAsset } from '../assets/environmentAssets';
import { createSceneSkyboxFromAsset } from '../assets/skyboxAssets';
import {
  createModelLibraryItems,
  createSkyboxLibraryItems,
  getModelUnitTitle,
  isImportedProjectLibraryItem,
  type ProjectLibrary,
} from '../assets/projectLibrary';
import {
  getSceneSkyboxSettings,
  SCENE_SENSITIVITY_MAX,
  SCENE_SENSITIVITY_MIN,
  SCENE_SKYBOX_INTENSITY_MAX,
  SCENE_SKYBOX_INTENSITY_MIN,
  SCENE_SKYBOX_RESOLUTIONS,
  SCENE_SKYBOX_ROTATION_MAX,
  SCENE_SKYBOX_ROTATION_MIN,
  SCENE_VIEW_DISTANCE_MAX,
  SCENE_VIEW_DISTANCE_MIN,
  type SceneEnvironmentVariant,
  type SceneSkyboxResolution,
} from '../model/SceneDocument';
import { formatModelLengthUnit } from '../model/sceneUnits';
import { useEditorStore, type SceneSensitivitySettingKey } from '../store/editorStore';
import { ResourceCard } from '../ui/ResourceCard';

const ENVIRONMENT_LIBRARY: ProjectLibrary = {
  key: 'environment',
  label: '环境模型',
  searchLabel: '环境模型',
  searchPlaceholder: '',
  items: [],
};

const SKYBOX_LIBRARY: ProjectLibrary = {
  key: 'skybox',
  label: '天空盒',
  searchLabel: '天空盒',
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
  return event.dataTransfer.types.includes(ENVIRONMENT_MODEL_ASSET_DRAG_MIME_TYPE);
}

/** 读取环境属性 drop 使用的环境模型资产，并严格校验环境分库。 */
function readEnvironmentAssetFromDrop(event: DragEvent<HTMLElement>): ProjectModelAssetEntry | null {
  const rawEnvironmentPayload = event.dataTransfer.getData(ENVIRONMENT_MODEL_ASSET_DRAG_MIME_TYPE);
  const environmentAsset = decodeModelAssetDragPayload(rawEnvironmentPayload);
  return environmentAsset?.libraryKind === 'environment' ? environmentAsset : null;
}

function hasSkyboxAssetDragPayload(event: DragEvent<HTMLElement>): boolean {
  return event.dataTransfer.types.includes(SKYBOX_ASSET_DRAG_MIME_TYPE);
}

function readSkyboxAssetFromDrop(event: DragEvent<HTMLElement>): ProjectSkyboxAssetEntry | null {
  return decodeSkyboxAssetDragPayload(event.dataTransfer.getData(SKYBOX_ASSET_DRAG_MIME_TYPE));
}

function getSkyboxDisplayName(sourcePath: string): string {
  const fileName = sourcePath.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) ?? sourcePath;
  return fileName.replace(/\.(hdr|exr)$/i, '');
}

type SceneSettingsPanelProps = {
  readOnly?: boolean;
};

export function SceneSettingsPanel(props: SceneSettingsPanelProps) {
  const scene = useEditorStore((state) => state.scene);
  const renameScene = useEditorStore((state) => state.renameScene);
  const resetSceneToBlank = useEditorStore((state) => state.resetSceneToBlank);
  const importCadReference = useEditorStore((state) => state.importCadReference);
  const requestCameraReset = useEditorStore((state) => state.requestCameraReset);
  const requestCameraPoseSave = useEditorStore((state) => state.requestCameraPoseSave);
  const setCameraViewDistance = useEditorStore((state) => state.setCameraViewDistance);
  const updateSensitivitySetting = useEditorStore((state) => state.updateSensitivitySetting);
  const updateEnvironmentConfig = useEditorStore((state) => state.updateEnvironmentConfig);
  const updateSkyboxConfig = useEditorStore((state) => state.updateSkyboxConfig);
  const setEnvironmentActiveVariant = useEditorStore((state) => state.setEnvironmentActiveVariant);
  const [sceneNameDraft, setSceneNameDraft] = useState(scene.name);
  const [environmentAssets, setEnvironmentAssets] = useState<ProjectModelAssetEntry[]>([]);
  const [environmentDialogOpen, setEnvironmentDialogOpen] = useState(false);
  const [environmentStatus, setEnvironmentStatus] = useState<string | null>(null);
  const [environmentDropActive, setEnvironmentDropActive] = useState(false);
  const [skyboxAssets, setSkyboxAssets] = useState<ProjectSkyboxAssetEntry[]>([]);
  const [skyboxDialogOpen, setSkyboxDialogOpen] = useState(false);
  const [skyboxStatus, setSkyboxStatus] = useState<string | null>(null);
  const [skyboxDropActive, setSkyboxDropActive] = useState(false);

  const environment = scene.sceneSettings.environment;
  const skybox = getSceneSkyboxSettings(scene);
  const presetVariant = environment?.variants[0] ?? null;
  const customVariants = environment?.variants.slice(1) ?? [];
  const environmentItems = useMemo(() => createModelLibraryItems(environmentAssets), [environmentAssets]);
  const skyboxItems = useMemo(() => createSkyboxLibraryItems(skyboxAssets), [skyboxAssets]);

  useEffect(() => {
    setSceneNameDraft(scene.name);
  }, [scene.name]);

  useEffect(() => {
    if (!environmentDialogOpen) return;

    let mounted = true;

    async function loadProjectModels(): Promise<void> {
      if (!window.editorApi?.listProjectAssets) {
        setEnvironmentStatus('当前环境未提供项目环境模型库。');
        return;
      }

      setEnvironmentStatus('正在加载项目环境模型库...');

      try {
        const result = await window.editorApi.listProjectAssets();
        if (!mounted) return;

        const assets = result.assets.filter((asset) => asset.kind === 'model' && asset.libraryKind === 'environment');
        setEnvironmentAssets(assets);
        setEnvironmentStatus(assets.length > 0 ? null : '环境库为空，请先在底部环境库导入环境 GLB 文件。');
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

  useEffect(() => {
    if (!skyboxDialogOpen) return;
    let mounted = true;

    async function loadProjectSkyboxes(): Promise<void> {
      if (!window.editorApi?.listProjectAssets) {
        setSkyboxStatus('当前环境未提供项目天空盒库。');
        return;
      }
      setSkyboxStatus('正在加载项目天空盒库...');
      try {
        const result = await window.editorApi.listProjectAssets();
        if (!mounted) return;
        const assets = result.skyboxes ?? [];
        setSkyboxAssets(assets);
        setSkyboxStatus(assets.length > 0 ? null : '天空盒库为空，请先在底部天空盒库导入 HDR 或 EXR 文件。');
      } catch (error) {
        if (!mounted) return;
        const message = error instanceof Error ? error.message : String(error);
        setSkyboxStatus(`加载项目天空盒库失败：${message}`);
      }
    }

    void loadProjectSkyboxes();
    return () => {
      mounted = false;
    };
  }, [skyboxDialogOpen]);

  function commitSceneName(): void {
    if (props.readOnly) return;
    renameScene(sceneNameDraft);
  }

  function handleSceneNameKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key !== 'Enter') return;
    event.currentTarget.blur();
  }

  function handleResetScene(): void {
    if (props.readOnly) return;
    if (!window.confirm('确定要初始化场景吗？未保存内容将丢失。')) return;
    resetSceneToBlank();
  }

  function handleViewDistanceChange(rawValue: string): void {
    if (props.readOnly) return;
    const nextValue = parseFiniteNumber(rawValue);
    if (nextValue === null) return;
    setCameraViewDistance(nextValue);
  }

  function handleSensitivityChange(key: SceneSensitivitySettingKey, rawValue: string): void {
    if (props.readOnly) return;
    const nextValue = parseFiniteNumber(rawValue);
    if (nextValue === null) return;
    updateSensitivitySetting(key, nextValue);
  }

  async function handleSelectEnvironmentAsset(asset: ProjectModelAssetEntry): Promise<void> {
    if (props.readOnly) return;
    if (asset.libraryKind !== 'environment') return;

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

  /** 仅允许环境库模型卡片在整条环境模型属性行触发 drop。 */
  function handleEnvironmentDragOver(event: DragEvent<HTMLLabelElement>): void {
    if (props.readOnly) return;
    if (!hasEnvironmentAssetDragPayload(event)) return;

    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    setEnvironmentDropActive(true);
  }

  /** 拖拽离开环境模型属性行时移除高亮，避免子元素切换造成悬停态残留。 */
  function handleEnvironmentDragLeave(event: DragEvent<HTMLLabelElement>): void {
    const relatedTarget = event.relatedTarget;
    if (relatedTarget instanceof Node && event.currentTarget.contains(relatedTarget)) return;

    setEnvironmentDropActive(false);
  }

  /** 在环境模型属性行释放卡片时应用为场景环境，不创建场景实体。 */
  function handleEnvironmentDrop(event: DragEvent<HTMLLabelElement>): void {
    if (props.readOnly) return;
    if (!hasEnvironmentAssetDragPayload(event)) return;

    event.preventDefault();
    event.stopPropagation();
    setEnvironmentDropActive(false);

    const asset = readEnvironmentAssetFromDrop(event);
    if (!asset) return;
    void handleSelectEnvironmentAsset(asset);
  }

  function handleSelectSkyboxAsset(asset: ProjectSkyboxAssetEntry): void {
    if (props.readOnly) return;
    try {
      updateSkyboxConfig(createSceneSkyboxFromAsset(asset, skybox));
      setSkyboxDialogOpen(false);
      setSkyboxStatus(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSkyboxStatus(`天空盒配置无效：${message}`);
    }
  }

  function handleSkyboxDragOver(event: DragEvent<HTMLLabelElement>): void {
    if (props.readOnly || !hasSkyboxAssetDragPayload(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    setSkyboxDropActive(true);
  }

  function handleSkyboxDragLeave(event: DragEvent<HTMLLabelElement>): void {
    const relatedTarget = event.relatedTarget;
    if (relatedTarget instanceof Node && event.currentTarget.contains(relatedTarget)) return;
    setSkyboxDropActive(false);
  }

  function handleSkyboxDrop(event: DragEvent<HTMLLabelElement>): void {
    if (props.readOnly || !hasSkyboxAssetDragPayload(event)) return;
    event.preventDefault();
    event.stopPropagation();
    setSkyboxDropActive(false);
    const asset = readSkyboxAssetFromDrop(event);
    if (asset) handleSelectSkyboxAsset(asset);
  }

  function updateSkyboxNumber(
    key: 'rotationDegrees' | 'intensity',
    rawValue: string,
  ): void {
    if (props.readOnly || !skybox) return;
    const value = parseFiniteNumber(rawValue);
    if (value === null) return;
    updateSkyboxConfig({ ...skybox, [key]: value });
  }

  function updateSkyboxResolution(rawValue: string): void {
    if (props.readOnly || !skybox) return;
    const resolution = Number(rawValue) as SceneSkyboxResolution;
    if (!SCENE_SKYBOX_RESOLUTIONS.includes(resolution)) return;
    updateSkyboxConfig({ ...skybox, resolution });
  }

  function renderEffectButton(variant: SceneEnvironmentVariant, label: string): ReactElement {
    const active = environment?.activeVariantUrl === variant.sourceUrl;

    return (
      <button
        className={active ? 'scene-effect-card active' : 'scene-effect-card'}
        key={variant.sourceUrl}
        disabled={props.readOnly}
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
            disabled={props.readOnly}
            value={sceneNameDraft}
            onBlur={commitSceneName}
            onChange={(event) => setSceneNameDraft(event.target.value)}
            onKeyDown={handleSceneNameKeyDown}
          />
        </label>
        <div className="scene-settings-button-row">
          <button type="button" disabled={props.readOnly} onClick={handleResetScene}>场景初始化</button>
          <button type="button" disabled={props.readOnly} onClick={() => void importCadReference()}>导入CAD</button>
        </div>
      </fieldset>

      <fieldset className="transform-fieldset">
        <legend>相机</legend>
        <div className="scene-settings-button-row">
          <button type="button" onClick={requestCameraReset}>复位视角</button>
          <button type="button" disabled={props.readOnly} onClick={requestCameraPoseSave}>保存当前视角</button>
        </div>
        <label className="scene-slider-row">
          <span>可视距离</span>
          <input
            min={SCENE_VIEW_DISTANCE_MIN}
            max={SCENE_VIEW_DISTANCE_MAX}
            step="100"
            type="range"
            disabled={props.readOnly}
            value={scene.sceneSettings.camera.viewDistance}
            onChange={(event) => handleViewDistanceChange(event.target.value)}
          />
          <input
            min={SCENE_VIEW_DISTANCE_MIN}
            max={SCENE_VIEW_DISTANCE_MAX}
            step="100"
            type="number"
            disabled={props.readOnly}
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
              disabled={props.readOnly}
              value={scene.sceneSettings.sensitivity[row.key]}
              onChange={(event) => handleSensitivityChange(row.key, event.target.value)}
            />
            <input
              min={SCENE_SENSITIVITY_MIN}
              max={SCENE_SENSITIVITY_MAX}
              step="1"
              type="number"
              disabled={props.readOnly}
              value={scene.sceneSettings.sensitivity[row.key]}
              onChange={(event) => handleSensitivityChange(row.key, event.target.value)}
            />
          </label>
        ))}
      </fieldset>

      <fieldset className="transform-fieldset">
        <legend>球形天空盒</legend>
        <label
          className={skyboxDropActive ? 'environment-preview-row environment-preview-row-drop-active' : 'environment-preview-row'}
          onDragEnter={handleSkyboxDragOver}
          onDragLeave={handleSkyboxDragLeave}
          onDragOver={handleSkyboxDragOver}
          onDrop={handleSkyboxDrop}
        >
          <span>天空盒资源</span>
          <button
            className={skyboxDropActive
              ? 'environment-preview-button skybox-preview-button environment-preview-button-drop-active'
              : 'environment-preview-button skybox-preview-button'}
            onClick={() => setSkyboxDialogOpen(true)}
            disabled={props.readOnly}
            title="选择或拖入 HDR/EXR 球形天空盒"
            type="button"
          >
            {skybox ? (
              <span className="skybox-preview-content">
                <strong>{skybox.format.toUpperCase()}</strong>
                <small>{getSkyboxDisplayName(skybox.sourcePath)}</small>
              </span>
            ) : (
              <span className="environment-preview-placeholder" aria-hidden="true" />
            )}
          </button>
        </label>
        {skybox ? (
          <>
            <p className="muted">{getSkyboxDisplayName(skybox.sourcePath)} · {skybox.format.toUpperCase()}</p>
            <button
              className="environment-clear-button"
              type="button"
              disabled={props.readOnly}
              onClick={() => updateSkyboxConfig(null)}
            >
              清除天空盒
            </button>
            <label className="scene-slider-row">
              <span>水平旋转</span>
              <input
                min={SCENE_SKYBOX_ROTATION_MIN}
                max={SCENE_SKYBOX_ROTATION_MAX}
                step="1"
                type="range"
                disabled={props.readOnly}
                value={skybox.rotationDegrees}
                onChange={(event) => updateSkyboxNumber('rotationDegrees', event.target.value)}
              />
              <input
                min={SCENE_SKYBOX_ROTATION_MIN}
                max={SCENE_SKYBOX_ROTATION_MAX}
                step="1"
                type="number"
                disabled={props.readOnly}
                value={skybox.rotationDegrees}
                onChange={(event) => updateSkyboxNumber('rotationDegrees', event.target.value)}
                title="天空盒水平旋转角度（度）"
              />
            </label>
            <label className="scene-slider-row">
              <span>环境强度</span>
              <input
                min={SCENE_SKYBOX_INTENSITY_MIN}
                max={SCENE_SKYBOX_INTENSITY_MAX}
                step="0.1"
                type="range"
                disabled={props.readOnly}
                value={skybox.intensity}
                onChange={(event) => updateSkyboxNumber('intensity', event.target.value)}
              />
              <input
                min={SCENE_SKYBOX_INTENSITY_MIN}
                max={SCENE_SKYBOX_INTENSITY_MAX}
                step="0.1"
                type="number"
                disabled={props.readOnly}
                value={skybox.intensity}
                onChange={(event) => updateSkyboxNumber('intensity', event.target.value)}
              />
            </label>
            <label className="inspector-row skybox-resolution-row">
              <span>立方体分辨率</span>
              <select
                disabled={props.readOnly}
                value={skybox.resolution}
                onChange={(event) => updateSkyboxResolution(event.target.value)}
              >
                {SCENE_SKYBOX_RESOLUTIONS.map((resolution) => (
                  <option key={resolution} value={resolution}>{resolution} × {resolution}</option>
                ))}
              </select>
            </label>
          </>
        ) : (
          <p className="muted">未放置球形天空盒，场景保持原有背景和环境反射。</p>
        )}
      </fieldset>

      <fieldset className="transform-fieldset">
        <legend>环境属性</legend>
        <label
          className={environmentDropActive ? 'environment-preview-row environment-preview-row-drop-active' : 'environment-preview-row'}
          onDragEnter={handleEnvironmentDragOver}
          onDragLeave={handleEnvironmentDragLeave}
          onDragOver={handleEnvironmentDragOver}
          onDrop={handleEnvironmentDrop}
        >
          <span>环境模型</span>
          <button
            className={environmentDropActive ? 'environment-preview-button environment-preview-button-drop-active' : 'environment-preview-button'}
            onClick={() => setEnvironmentDialogOpen(true)}
            disabled={props.readOnly}
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
          <p className="muted">
            源单位：{formatModelLengthUnit(environment.lengthUnit)} → m（×{environment.unitScaleToMeters}）
          </p>
        ) : null}
        {environment ? (
          <button className="environment-clear-button" type="button" disabled={props.readOnly} onClick={() => updateEnvironmentConfig(null)}>
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

      {skyboxDialogOpen ? (
        <div
          className="environment-dialog-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setSkyboxDialogOpen(false);
          }}
        >
          <div className="environment-dialog" role="dialog" aria-label="选择天空盒">
            <div className="environment-dialog-header">
              <h3>选择天空盒</h3>
              <button type="button" onClick={() => setSkyboxDialogOpen(false)}>关闭</button>
            </div>
            <div className="environment-dialog-list">
              {skyboxItems.map((item) => {
                if (!isImportedProjectLibraryItem(item) || item.asset.kind !== 'skybox') return null;
                return (
                  <ResourceCard
                    className="environment-resource-card skybox-resource-card"
                    disabled={props.readOnly}
                    draggable={false}
                    item={item}
                    key={item.id}
                    library={SKYBOX_LIBRARY}
                    onClick={() => handleSelectSkyboxAsset(item.asset as ProjectSkyboxAssetEntry)}
                    title={`选择天空盒：${item.name}（${item.asset.format.toUpperCase()}）`}
                  />
                );
              })}
              {skyboxStatus ? <p className="environment-dialog-status">{skyboxStatus}</p> : null}
            </div>
          </div>
        </div>
      ) : null}

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
              {environmentItems.map((item) => {
                if (!isImportedProjectLibraryItem(item)) return null;
                if (item.asset.kind !== 'model' || item.asset.libraryKind !== 'environment') return null;
                const environmentAsset = item.asset as ProjectModelAssetEntry;

                return (
                  <ResourceCard
                    className="environment-resource-card"
                    disabled={props.readOnly}
                    draggable={false}
                    item={item}
                    key={item.id}
                    library={ENVIRONMENT_LIBRARY}
                    onClick={() => void handleSelectEnvironmentAsset(environmentAsset)}
                    title={`选择环境模型：${item.name}，${getModelUnitTitle(environmentAsset)}`}
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
