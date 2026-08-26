import {
  useEffect,
  useMemo,
  useState,
  type DragEvent,
  type FocusEvent,
  type KeyboardEvent,
  type ReactElement,
} from 'react';
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
  SCENE_ENVIRONMENT_OPACITY_MAX,
  SCENE_ENVIRONMENT_OPACITY_MIN,
  SCENE_ENVIRONMENT_SCALE_MAX,
  SCENE_ENVIRONMENT_SCALE_MIN,
  SCENE_SENSITIVITY_MAX,
  SCENE_SENSITIVITY_MIN,
  SCENE_SHADOW_BIAS_MAX,
  SCENE_SHADOW_BIAS_MIN,
  SCENE_SHADOW_CONCENTRATION_PERCENT_MAX,
  SCENE_SHADOW_CONCENTRATION_PERCENT_MIN,
  SCENE_SHADOW_DISTANCE_MAX,
  SCENE_SHADOW_DISTANCE_MIN,
  SCENE_SHADOW_FILL_INTENSITY_MAX,
  SCENE_SHADOW_FILL_INTENSITY_MIN,
  SCENE_SHADOW_IBL_INTENSITY_MAX_MAX,
  SCENE_SHADOW_IBL_INTENSITY_MAX_MIN,
  SCENE_SHADOW_NORMAL_BIAS_MAX,
  SCENE_SHADOW_NORMAL_BIAS_MIN,
  SCENE_SHADOW_QUALITIES,
  SCENE_SHADOW_SUN_AZIMUTH_MAX,
  SCENE_SHADOW_SUN_AZIMUTH_MIN,
  SCENE_SHADOW_SUN_ELEVATION_MAX,
  SCENE_SHADOW_SUN_ELEVATION_MIN,
  SCENE_SHADOW_SUN_INTENSITY_MAX,
  SCENE_SHADOW_SUN_INTENSITY_MIN,
  SCENE_SKYBOX_INTENSITY_MAX,
  SCENE_SKYBOX_INTENSITY_MIN,
  SCENE_SKYBOX_RESOLUTIONS,
  SCENE_SKYBOX_ROTATION_MAX,
  SCENE_SKYBOX_ROTATION_MIN,
  SCENE_SKYBOX_VIEW_DISTANCE_MIN,
  SCENE_VIEW_DISTANCE_MAX,
  SCENE_VIEW_DISTANCE_MIN,
  sceneShadowConcentrationPercentToDarkness,
  sceneShadowDarknessToConcentrationPercent,
  type SceneEnvironmentTransform,
  type SceneEnvironmentVariant,
  type SceneShadowQuality,
  type SceneShadowSettings,
  type SceneSkyboxResolution,
} from '../model/SceneDocument';
import {
  createModelLengthUnitInfo,
  formatModelLengthUnit,
  type ModelSourceLengthUnit,
} from '../model/sceneUnits';
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

type SceneShadowSliderKey = Extract<keyof SceneShadowSettings, 'sunAzimuthDegrees' | 'sunElevationDegrees' | 'sunIntensity' | 'distanceMeters' | 'bias' | 'normalBias' | 'fillIntensity' | 'iblIntensityMax'>;

const SHADOW_SLIDER_ROWS: Array<{
  key: SceneShadowSliderKey;
  label: string;
  min: number;
  max: number;
  step: number;
  title: string;
}> = [
  { key: 'sunAzimuthDegrees', label: '太阳方位', min: SCENE_SHADOW_SUN_AZIMUTH_MIN, max: SCENE_SHADOW_SUN_AZIMUTH_MAX, step: 1, title: '自动太阳光方位角，0 为正北，顺时针增加' },
  { key: 'sunElevationDegrees', label: '太阳高度', min: SCENE_SHADOW_SUN_ELEVATION_MIN, max: SCENE_SHADOW_SUN_ELEVATION_MAX, step: 1, title: '自动太阳光高度角，数值越大光线越接近垂直' },
  { key: 'sunIntensity', label: '太阳强度', min: SCENE_SHADOW_SUN_INTENSITY_MIN, max: SCENE_SHADOW_SUN_INTENSITY_MAX, step: 0.05, title: '自动太阳光强度；场景中有可见方向光时由该灯光接管' },
  { key: 'distanceMeters', label: '阴影距离', min: SCENE_SHADOW_DISTANCE_MIN, max: SCENE_SHADOW_DISTANCE_MAX, step: 10, title: '主阴影覆盖距离，0 表示按相机自动计算' },
  { key: 'bias', label: '阴影偏移', min: SCENE_SHADOW_BIAS_MIN, max: SCENE_SHADOW_BIAS_MAX, step: 0.001, title: '减小阴影痤疮；过大时影子会脱离模型' },
  { key: 'normalBias', label: '法线偏移', min: SCENE_SHADOW_NORMAL_BIAS_MIN, max: SCENE_SHADOW_NORMAL_BIAS_MAX, step: 0.001, title: '按法线再偏移阴影，适合厂房尺度模型' },
  { key: 'fillIntensity', label: '补光强度', min: SCENE_SHADOW_FILL_INTENSITY_MIN, max: SCENE_SHADOW_FILL_INTENSITY_MAX, step: 0.05, title: '阴影开启时压低编辑器半球补光，让方向光阴影更清楚' },
  { key: 'iblIntensityMax', label: '环境上限', min: SCENE_SHADOW_IBL_INTENSITY_MAX_MIN, max: SCENE_SHADOW_IBL_INTENSITY_MAX_MAX, step: 0.05, title: '阴影开启时限制天空盒环境光强度上限' },
];

function parseFiniteNumber(rawValue: string): number | null {
  if (rawValue === '') return null;

  const nextValue = Number(rawValue);
  return Number.isFinite(nextValue) ? nextValue : null;
}

const RADIANS_TO_DEGREES = 180 / Math.PI;
const DEGREES_TO_RADIANS = Math.PI / 180;

function formatEnvironmentNumber(value: number): string {
  return Number(value.toFixed(4)).toString();
}

function formatEnvironmentFileSize(fileSizeBytes: number | null | undefined): string {
  if (!fileSizeBytes || !Number.isFinite(fileSizeBytes)) return '未知';
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let value = fileSizeBytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function formatEnvironmentMeters(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const absolute = Math.abs(value);
  if (absolute >= 1000) return `${value.toFixed(0)} m`;
  if (absolute >= 10) return `${value.toFixed(1)} m`;
  return `${value.toFixed(2)} m`;
}

function getEnvironmentDisplayName(packagePath: string, displayName?: string): string {
  if (displayName?.trim()) return displayName.trim();
  const lastSegment = packagePath.replace(/\\/g, '/').split('/').filter(Boolean).at(-1);
  return lastSegment || '环境模型';
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
  const updateShadowSettings = useEditorStore((state) => state.updateShadowSettings);
  const updateEnvironmentConfig = useEditorStore((state) => state.updateEnvironmentConfig);
  const setDefaultCargoGenerator = useEditorStore((state) => state.setDefaultCargoGenerator);
  const requestEnvironmentApply = useEditorStore((state) => state.requestEnvironmentApply);
  const updateEnvironmentDisplay = useEditorStore((state) => state.updateEnvironmentDisplay);
  const setEnvironmentAdjustmentActive = useEditorStore((state) => state.setEnvironmentAdjustmentActive);
  const requestEnvironmentFocus = useEditorStore((state) => state.requestEnvironmentFocus);
  const convertLegacyEnvironmentToSceneBase = useEditorStore((state) => state.convertLegacyEnvironmentToSceneBase);
  const environmentApplyRequest = useEditorStore((state) => state.environmentApplyRequest);
  const environmentRuntimeSnapshot = useEditorStore((state) => state.environmentRuntimeSnapshot);
  const environmentAdjustmentActive = useEditorStore((state) => state.environmentAdjustmentActive);
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
  const shadows = scene.sceneSettings.shadows;
  const shadowConcentration = sceneShadowDarknessToConcentrationPercent(shadows.darkness);
  const skybox = getSceneSkyboxSettings(scene);
  const cargoGeneratorOptions = scene.entityIds
    .map((entityId) => scene.entities[entityId])
    .filter((entity) => entity?.components.modelGenerator)
    .map((entity) => ({ id: entity!.id, name: entity!.name }));
  const defaultCargoGeneratorId = scene.sceneSettings.defaultCargoGeneratorId;
  const defaultCargoGeneratorMissing = Boolean(
    defaultCargoGeneratorId && !cargoGeneratorOptions.some((option) => option.id === defaultCargoGeneratorId),
  );
  const minimumViewDistance = skybox ? SCENE_SKYBOX_VIEW_DISTANCE_MIN : SCENE_VIEW_DISTANCE_MIN;
  const presetVariant = environment?.variants[0] ?? null;
  const customVariants = environment?.variants.slice(1) ?? [];
  const environmentItems = useMemo(() => createModelLibraryItems(environmentAssets), [environmentAssets]);
  const skyboxItems = useMemo(() => createSkyboxLibraryItems(skyboxAssets), [skyboxAssets]);
  const environmentLoading = environmentApplyRequest !== null || environmentRuntimeSnapshot.phase === 'loading';
  const environmentBounds = environmentRuntimeSnapshot.bounds;
  const environmentStatistics = environmentRuntimeSnapshot.statistics;
  const environmentHasRuntime = Boolean(environmentBounds);

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

  function handleShadowConcentrationChange(rawValue: string): void {
    if (props.readOnly) return;
    const nextValue = parseFiniteNumber(rawValue);
    if (nextValue === null) return;
    updateShadowSettings({ darkness: sceneShadowConcentrationPercentToDarkness(nextValue) });
  }

  function handleShadowQualityChange(value: string): void {
    if (props.readOnly || !SCENE_SHADOW_QUALITIES.includes(value as SceneShadowQuality)) return;
    updateShadowSettings({ quality: value as SceneShadowQuality });
  }

  function handleShadowSliderChange(key: SceneShadowSliderKey, rawValue: string): void {
    if (props.readOnly) return;
    const nextValue = parseFiniteNumber(rawValue);
    if (nextValue === null) return;
    updateShadowSettings({ [key]: nextValue });
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

      const requestId = requestEnvironmentApply(environmentConfig, {
        autoAlign: true,
        focusAfterLoad: true,
        commandLabel: '应用环境模型',
        successMessage: `环境模型已应用：${getEnvironmentDisplayName(environmentConfig.packagePath, environmentConfig.displayName)}`,
      });
      if (!requestId) {
        setEnvironmentStatus('环境模型未能开始加载，请查看 Console 日志。');
        return;
      }
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

  /** Inspector 数字输入在回车或失焦时提交，一次编辑只生成一条撤销记录。 */
  function handleEnvironmentTransformBlur(
    event: FocusEvent<HTMLInputElement>,
    field: 'position' | 'rotation' | 'scale',
    axis?: 'x' | 'y' | 'z',
  ): void {
    if (props.readOnly || !environment || environment.placementMode !== 'scene-base') return;
    const value = parseFiniteNumber(event.currentTarget.value);
    if (value === null) {
      const currentValue = field === 'scale'
        ? environment.transform.scale
        : field === 'rotation' && axis
          ? environment.transform.rotation[axis] * RADIANS_TO_DEGREES
          : axis
            ? environment.transform.position[axis]
            : 0;
      event.currentTarget.value = formatEnvironmentNumber(currentValue);
      return;
    }

    let transform: SceneEnvironmentTransform;
    if (field === 'scale') {
      transform = { ...environment.transform, scale: value };
    } else if (axis) {
      const nextValue = field === 'rotation' ? value * DEGREES_TO_RADIANS : value;
      transform = {
        ...environment.transform,
        [field]: { ...environment.transform[field], [axis]: nextValue },
      };
    } else {
      return;
    }
    updateEnvironmentDisplay({ transform }, field === 'position'
      ? '更新环境位置'
      : field === 'rotation'
        ? '更新环境旋转'
        : '更新环境缩放');
  }

  function handleEnvironmentNumberKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'Enter') event.currentTarget.blur();
  }

  function handleEnvironmentUnitChange(rawValue: string): void {
    if (props.readOnly || !environment || environmentLoading || environmentAdjustmentActive) return;
    if (rawValue !== 'meter' && rawValue !== 'centimeter' && rawValue !== 'millimeter') return;
    const unitInfo = createModelLengthUnitInfo(rawValue as ModelSourceLengthUnit);
    requestEnvironmentApply(
      { ...environment, ...unitInfo },
      {
        autoAlign: true,
        focusAfterLoad: true,
        commandLabel: '更新环境源单位',
        successMessage: `环境源单位已更新为 ${formatModelLengthUnit(unitInfo.lengthUnit)}。`,
      },
    );
  }

  function handleResetEnvironmentPlacement(): void {
    if (props.readOnly || !environment || environment.placementMode !== 'scene-base') return;
    requestEnvironmentApply(environment, {
      autoAlign: true,
      focusAfterLoad: true,
      commandLabel: '重置环境摆放',
      successMessage: '环境模型已重新居中并落地。',
    });
  }

  function getEnvironmentRuntimeStatus(): { label: string; className: string } {
    switch (environmentRuntimeSnapshot.phase) {
      case 'loading':
        return { label: environmentRuntimeSnapshot.message || '环境模型正在加载...', className: 'loading' };
      case 'ready':
        return { label: '环境模型已就绪', className: 'ready' };
      case 'error':
        return { label: environmentRuntimeSnapshot.message || '环境模型加载失败', className: 'error' };
      default:
        return { label: environment ? '等待 Scene View 加载环境模型' : '未选择环境模型', className: 'idle' };
    }
  }

  function renderEffectButton(variant: SceneEnvironmentVariant, label: string): ReactElement {
    const active = environment?.activeVariantUrl === variant.sourceUrl;

    return (
      <button
        className={active ? 'scene-effect-card active' : 'scene-effect-card'}
        key={variant.sourceUrl}
        disabled={props.readOnly || environmentLoading || environmentAdjustmentActive}
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
            min={minimumViewDistance}
            max={SCENE_VIEW_DISTANCE_MAX}
            step="100"
            type="range"
            disabled={props.readOnly}
            value={scene.sceneSettings.camera.viewDistance}
            onChange={(event) => handleViewDistanceChange(event.target.value)}
          />
          <input
            min={minimumViewDistance}
            max={SCENE_VIEW_DISTANCE_MAX}
            step="100"
            type="number"
            disabled={props.readOnly}
            value={scene.sceneSettings.camera.viewDistance}
            onChange={(event) => handleViewDistanceChange(event.target.value)}
          />
        </label>
        {skybox ? (
          <p className="muted">10 km 天空盒要求可视距离至少为 {SCENE_SKYBOX_VIEW_DISTANCE_MIN} m。</p>
        ) : null}
      </fieldset>

      <fieldset className="transform-fieldset">
        <legend>相机运动幅度（统一标准）</legend>
        <p className="muted">
          保留原有右键拖拽旋转、中键拖拽移动、Ctrl+左键平移、左键短点击选择和滚轮缩放。以下数值只调整运动幅度。
        </p>
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
        <legend>阴影</legend>
        <label className="inspector-row environment-visible-row">
          <span>启用阴影</span>
          <input
            type="checkbox"
            disabled={props.readOnly}
            checked={shadows.enabled}
            onChange={(event) => updateShadowSettings({ enabled: event.target.checked })}
          />
        </label>
        <label className="inspector-row">
          <span>阴影质量</span>
          <select
            disabled={props.readOnly || !shadows.enabled}
            value={shadows.quality}
            onChange={(event) => handleShadowQualityChange(event.target.value)}
          >
            <option value="performance">性能（缓存地面）</option>
            <option value="balanced">均衡（缓存地面）</option>
            <option value="quality">高质量（实时）</option>
          </select>
        </label>
        <label className="scene-slider-row">
          <span>阴影浓度</span>
          <input
            min={SCENE_SHADOW_CONCENTRATION_PERCENT_MIN}
            max={SCENE_SHADOW_CONCENTRATION_PERCENT_MAX}
            step="1"
            type="range"
            disabled={props.readOnly || !shadows.enabled}
            value={shadowConcentration}
            onChange={(event) => handleShadowConcentrationChange(event.target.value)}
          />
          <input
            min={SCENE_SHADOW_CONCENTRATION_PERCENT_MIN}
            max={SCENE_SHADOW_CONCENTRATION_PERCENT_MAX}
            step="1"
            type="number"
            disabled={props.readOnly || !shadows.enabled}
            value={shadowConcentration}
            onChange={(event) => handleShadowConcentrationChange(event.target.value)}
          />
        </label>
        <label className="inspector-row environment-visible-row">
          <span>阴影地面</span>
          <input
            type="checkbox"
            disabled={props.readOnly || !shadows.enabled}
            checked={shadows.catcherEnabled}
            onChange={(event) => updateShadowSettings({ catcherEnabled: event.target.checked })}
          />
        </label>
        {SHADOW_SLIDER_ROWS.map((row) => (
          <label className="scene-slider-row" key={row.key} title={row.title}>
            <span>{row.label}</span>
            <input
              min={row.min}
              max={row.max}
              step={row.step}
              type="range"
              disabled={props.readOnly || !shadows.enabled}
              value={shadows[row.key]}
              onChange={(event) => handleShadowSliderChange(row.key, event.target.value)}
            />
            <input
              min={row.min}
              max={row.max}
              step={row.step}
              type="number"
              disabled={props.readOnly || !shadows.enabled}
              value={shadows[row.key]}
              onChange={(event) => handleShadowSliderChange(row.key, event.target.value)}
              title={row.title}
            />
          </label>
        ))}
        <p className="muted">默认性能/均衡档缓存一张阴影贴图：模型只投射，环境和阴影地面接收。高质量档才对全部模型做实时级联阴影。没有可见方向光时使用自动太阳光。</p>
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

      <fieldset className="transform-fieldset environment-inspector-fieldset">
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
            disabled={props.readOnly || environmentLoading || environmentAdjustmentActive}
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

        <div className={`environment-runtime-status environment-runtime-status-${getEnvironmentRuntimeStatus().className}`} role="status" aria-live="polite">
          {getEnvironmentRuntimeStatus().label}
        </div>

        {environment ? (
          <>
            <div className="environment-summary-card">
              <strong>{getEnvironmentDisplayName(environment.packagePath, environment.displayName)}</strong>
              <span>{environment.placementMode === 'scene-base' ? '场景底座' : '旧版左侧摆放'}</span>
              <span>换算：{formatModelLengthUnit(environment.lengthUnit)} → m（×{environment.unitScaleToMeters}）</span>
              <span>文件：{formatEnvironmentFileSize(environmentStatistics?.fileSizeBytes ?? environment.fileSizeBytes)}</span>
              {environmentBounds ? (
                <span>
                  世界尺寸：{formatEnvironmentMeters(environmentBounds.sizeMeters.x)} × {formatEnvironmentMeters(environmentBounds.sizeMeters.y)} × {formatEnvironmentMeters(environmentBounds.sizeMeters.z)}
                </span>
              ) : null}
            </div>

            <label className="inspector-row environment-unit-row">
              <span>源单位</span>
              <select
                disabled={props.readOnly || environmentLoading || environmentAdjustmentActive}
                onChange={(event) => handleEnvironmentUnitChange(event.target.value)}
                value={environment.lengthUnit}
              >
                <option value="meter">meter</option>
                <option value="centimeter">centimeter</option>
                <option value="millimeter">millimeter</option>
              </select>
            </label>

            {environment.placementMode === 'legacy-left' ? (
              <div className="environment-legacy-notice">
                <strong>旧版摆放</strong>
                <span>当前环境继续保持原点左侧 2 m 的兼容位置。转换后才会启用居中底座 Transform 与 Gizmo。</span>
                <button
                  disabled={props.readOnly || environmentLoading}
                  onClick={convertLegacyEnvironmentToSceneBase}
                  type="button"
                >
                  转换为场景底座
                </button>
              </div>
            ) : (
              <div className="environment-transform-editor">
                <span className="scene-effect-title">Transform</span>
                {(['x', 'y', 'z'] as const).map((axis) => (
                  <label className="environment-transform-row" key={`position-${axis}`}>
                    <span>位置 {axis.toUpperCase()}</span>
                    <input
                      defaultValue={formatEnvironmentNumber(environment.transform.position[axis])}
                      disabled={props.readOnly || environmentLoading || environmentAdjustmentActive}
                      key={`position-${axis}-${environment.transform.position[axis]}`}
                      onBlur={(event) => handleEnvironmentTransformBlur(event, 'position', axis)}
                      onKeyDown={handleEnvironmentNumberKeyDown}
                      step="0.1"
                      type="number"
                    />
                    <small>m</small>
                  </label>
                ))}
                {(['x', 'y', 'z'] as const).map((axis) => (
                  <label className="environment-transform-row" key={`rotation-${axis}`}>
                    <span>旋转 {axis.toUpperCase()}</span>
                    <input
                      defaultValue={formatEnvironmentNumber(environment.transform.rotation[axis] * RADIANS_TO_DEGREES)}
                      disabled={props.readOnly || environmentLoading || environmentAdjustmentActive}
                      key={`rotation-${axis}-${environment.transform.rotation[axis]}`}
                      onBlur={(event) => handleEnvironmentTransformBlur(event, 'rotation', axis)}
                      onKeyDown={handleEnvironmentNumberKeyDown}
                      step="1"
                      type="number"
                    />
                    <small>°</small>
                  </label>
                ))}
                <label className="environment-transform-row">
                  <span>统一缩放</span>
                  <input
                    defaultValue={formatEnvironmentNumber(environment.transform.scale)}
                    disabled={props.readOnly || environmentLoading || environmentAdjustmentActive}
                    key={`scale-${environment.transform.scale}`}
                    max={SCENE_ENVIRONMENT_SCALE_MAX}
                    min={SCENE_ENVIRONMENT_SCALE_MIN}
                    onBlur={(event) => handleEnvironmentTransformBlur(event, 'scale')}
                    onKeyDown={handleEnvironmentNumberKeyDown}
                    step="0.01"
                    type="number"
                  />
                  <small>×</small>
                </label>
              </div>
            )}

            <label className="inspector-row environment-visible-row">
              <span>显示</span>
              <input
                checked={environment.visible}
                disabled={props.readOnly || environmentLoading || environmentAdjustmentActive}
                onChange={(event) => updateEnvironmentDisplay({ visible: event.target.checked }, event.target.checked ? '显示环境模型' : '隐藏环境模型')}
                type="checkbox"
              />
            </label>
            <label className="environment-opacity-row">
              <span>透明度</span>
              <input
                disabled={props.readOnly || environmentLoading || environmentAdjustmentActive || !environment.visible}
                max={SCENE_ENVIRONMENT_OPACITY_MAX}
                min={SCENE_ENVIRONMENT_OPACITY_MIN}
                onChange={(event) => updateEnvironmentDisplay({ opacity: Number(event.target.value) }, '更新环境透明度')}
                step="0.01"
                type="range"
                value={environment.opacity}
              />
              <output>{Math.round(environment.opacity * 100)}%</output>
            </label>
            <div className="environment-display-presets">
              <button disabled={props.readOnly || environmentLoading || environmentAdjustmentActive} onClick={() => updateEnvironmentDisplay({ visible: true, opacity: 1 }, '环境正常显示')} type="button">正常</button>
              <button disabled={props.readOnly || environmentLoading || environmentAdjustmentActive} onClick={() => updateEnvironmentDisplay({ visible: true, opacity: 0.35 }, '环境幽灵显示')} type="button">半透明</button>
              <button disabled={props.readOnly || environmentLoading || environmentAdjustmentActive} onClick={() => updateEnvironmentDisplay({ visible: false }, '隐藏环境模型')} type="button">隐藏</button>
            </div>

            <div className="environment-action-grid">
              {environment.placementMode === 'scene-base' ? (
                <button
                  className={environmentAdjustmentActive ? 'active' : undefined}
                  disabled={props.readOnly || environmentLoading || !environment.visible || environment.opacity <= 0 || !environmentHasRuntime}
                  onClick={() => setEnvironmentAdjustmentActive(!environmentAdjustmentActive)}
                  type="button"
                >
                  {environmentAdjustmentActive ? '完成调整' : '场景中调整'}
                </button>
              ) : null}
              <button disabled={environmentLoading || environmentAdjustmentActive || !environmentHasRuntime} onClick={requestEnvironmentFocus} type="button">聚焦环境</button>
              {environment.placementMode === 'scene-base' ? (
                <button disabled={props.readOnly || environmentLoading || environmentAdjustmentActive} onClick={handleResetEnvironmentPlacement} type="button">重置摆放</button>
              ) : null}
              <button className="danger" disabled={props.readOnly} onClick={() => updateEnvironmentConfig(null)} type="button">清除环境</button>
            </div>

            {environmentStatistics ? (
              <details className="environment-statistics">
                <summary>模型统计</summary>
                <dl>
                  <div><dt>Mesh</dt><dd>{environmentStatistics.meshCount.toLocaleString()}</dd></div>
                  <div><dt>Primitive</dt><dd>{environmentStatistics.primitiveCount.toLocaleString()}</dd></div>
                  <div><dt>顶点</dt><dd>{environmentStatistics.vertexCount.toLocaleString()}</dd></div>
                  <div><dt>三角形</dt><dd>{environmentStatistics.triangleCount.toLocaleString()}</dd></div>
                  <div><dt>材质</dt><dd>{environmentStatistics.materialCount.toLocaleString()}</dd></div>
                  <div><dt>纹理</dt><dd>{environmentStatistics.textureCount.toLocaleString()}</dd></div>
                </dl>
              </details>
            ) : null}
          </>
        ) : (
          <p className="muted">从项目环境库选择厂房或周边地理环境 GLB，首次应用会自动居中并落地。</p>
        )}

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

      <fieldset className="transform-fieldset">
        <legend>货箱生成器</legend>
        <label className="inspector-row">
          <span>默认模板来源</span>
          <select
            disabled={props.readOnly}
            value={defaultCargoGeneratorId ?? '__none__'}
            onChange={(event) => setDefaultCargoGenerator(event.target.value !== '__none__' ? event.target.value : null)}
          >
            <option value="__none__">无（内置立方体）</option>
            {cargoGeneratorOptions.map((option) => (
              <option key={option.id} value={option.id}>{option.name}</option>
            ))}
          </select>
        </label>
        {defaultCargoGeneratorMissing ? (
          <p className="telemetry-runtime-error">默认模型生成器已被删除，未绑定的设备将回退内置立方体。</p>
        ) : null}
        <p className="muted">遥测设备与定位线框未单独绑定模型生成器时，统一使用此默认模板渲染货箱。</p>
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
