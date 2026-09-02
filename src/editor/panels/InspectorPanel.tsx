import { useEffect, useState, type KeyboardEvent } from 'react';
import { getBuiltInMeshMeterDescription } from '../model/builtInMeshGeometry';
import type { DataPlatformScreenRenderMode, LightKind, MeshKind } from '../model/components';
import type { Vector3Data } from '../model/math';
import { getLightEditorCapabilities, getLightTransformFieldLabel } from '../model/lightEditor';
import { formatCadReferenceUnitSummary } from '../cad/cadUnits';
import { SCENE_LENGTH_UNIT_SYMBOL, formatModelLengthUnit } from '../model/sceneUnits';
import {
  SCENE_SKYBOX_INTENSITY_MAX,
  SCENE_SKYBOX_INTENSITY_MIN,
  SCENE_SKYBOX_RESOLUTIONS,
  getSkyboxSphereDiameterMeters,
  SKYBOX_SPHERE_DIAMETER_METERS,
  SKYBOX_SPHERE_SCALE_MAX,
  SKYBOX_SPHERE_SCALE_MIN,
  type SceneSkyboxResolution,
} from '../model/SceneDocument';
import {
  isEntityEffectivelyLocked,
  resolveHierarchyGroupTransformSelection,
} from '../model/entityHierarchy';
import { containsManualRoamSpawnEntity } from '../model/manualRoamSpawn';
import { isSpecializedTelemetryDeviceType } from '../model/telemetryBinding';
import { findBuiltInSlotEntityId } from '../model/builtInSlotBinding';
import { useEditorStore } from '../store/editorStore';
import { ModelGeneratorInspector } from './ModelGeneratorInspector';
import { ClickEventBindingInspector } from './ClickEventBindingInspector';
import { LocatorInspector } from './LocatorInspector';
import { PoiEffectInspector } from './PoiEffectInspector';
import { ModelParametersInspector } from './ModelParametersInspector';
import { TelemetryBindingInspector, CargoGeneratorInspector } from './TelemetryBindingInspector';
import { SceneSettingsPanel } from './SceneSettingsPanel';
import { AutoPatrolInspector } from './AutoPatrolInspector';

type TransformField = 'position' | 'rotation' | 'scale';
const axes: Array<keyof Vector3Data> = ['x', 'y', 'z'];
const fields: TransformField[] = ['position', 'rotation', 'scale'];
const lightKinds: LightKind[] = ['hemispheric', 'directional', 'point'];
const RADIANS_TO_DEGREES = 180 / Math.PI;
const DEGREES_TO_RADIANS = Math.PI / 180;

/** 根据实体类型生成单位明确且符合灯光实际语义的 Inspector 标题。 */
function getTransformLegend(field: TransformField, meshKind?: MeshKind, lightKind?: LightKind): string {
  const label = lightKind ? getLightTransformFieldLabel(lightKind, field) : field;
  if (label === 'direction') return label;
  if (field === 'position') return `${label} (${SCENE_LENGTH_UNIT_SYMBOL})`;
  if (field === 'rotation') return `${label} (deg)`;
  if (field === 'scale' && meshKind === 'cube') return `size (${SCENE_LENGTH_UNIT_SYMBOL})`;

  return label;
}

/** 将 Babylon 内部弧度转换为 Inspector 面向用户的角度。 */
function radiansToDegrees(value: number): number {
  return value * RADIANS_TO_DEGREES;
}

/** 将 Inspector 输入的角度转换回 Babylon Transform 使用的弧度。 */
function degreesToRadians(value: number): number {
  return value * DEGREES_TO_RADIANS;
}

/** 限制角度显示的小数噪声，避免 Gizmo 回写后 Inspector 出现很长的小数。 */
function formatRotationDegrees(value: number): number {
  if (!Number.isFinite(value)) return 0;

  return Number(value.toFixed(3));
}

const MODEL_MEASUREMENT_FORMATTER = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 6 });

/** 格式化 Inspector 中的模型实际米制尺寸，保留最多 6 位小数。 */
function formatModelMeasurementMeters(value: number): string {
  return MODEL_MEASUREMENT_FORMATTER.format(Number.isFinite(value) ? Math.max(0, value) : 0);
}

type GroupSpatialAxisInputProps = {
  ariaLabel: string;
  disabled: boolean;
  step: string;
  value: number;
  onCommit?: (value: number) => void;
};

/** 群组 Transform 输入在 blur/Enter 时提交，避免受控值在运行时事务完成前回弹。 */
function GroupSpatialAxisInput(props: GroupSpatialAxisInputProps) {
  const [draft, setDraft] = useState(String(props.value));

  useEffect(() => {
    setDraft(String(props.value));
  }, [props.value]);

  function commit(): void {
    if (draft.trim() === '') {
      setDraft(String(props.value));
      return;
    }
    const value = Number(draft);
    if (!Number.isFinite(value)) {
      setDraft(String(props.value));
      return;
    }
    props.onCommit?.(value);
  }

  return (
    <input
      aria-label={props.ariaLabel}
      disabled={props.disabled}
      step={props.step}
      type="number"
      value={draft}
      onBlur={commit}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
        if (event.key === 'Escape') {
          event.preventDefault();
          setDraft(String(props.value));
        }
      }}
    />
  );
}

/** 根据 Transform 字段返回 Inspector 输入框显示值，rotation 单独从弧度转为角度。 */
function getTransformInputValue(field: TransformField, value: number): number {
  return field === 'rotation' ? formatRotationDegrees(radiansToDegrees(value)) : value;
}

/** 根据 Transform 字段返回合适步长，rotation 使用角度步长。 */
function getTransformInputStep(field: TransformField): string {
  return field === 'rotation' ? '1' : '0.1';
}

type InspectorPanelProps = {
  readOnly?: boolean;
};

export function InspectorPanel(props: InspectorPanelProps) {
  const scene = useEditorStore((state) => state.scene);
  const hierarchySelectionIds = useEditorStore((state) => state.hierarchySelectionIds);
  const selectedModelMeasurement = useEditorStore((state) => state.selectedModelMeasurement);
  const selectedGroupSpatialInfo = useEditorStore((state) => state.selectedGroupSpatialInfo);
  const requestSelectedGroupTransform = useEditorStore((state) => state.requestSelectedGroupTransform);
  const renameSelectedEntity = useEditorStore((state) => state.renameSelectedEntity);
  const updateSelectedTransform = useEditorStore((state) => state.updateSelectedTransform);
  const updateSelectedMaterialColor = useEditorStore((state) => state.updateSelectedMaterialColor);
  const updateSelectedDataPlatformScreen = useEditorStore((state) => state.updateSelectedDataPlatformScreen);
  const updateSelectedSkybox = useEditorStore((state) => state.updateSelectedSkybox);
  const updateSelectedCadReference = useEditorStore((state) => state.updateSelectedCadReference);
  const updateSelectedLight = useEditorStore((state) => state.updateSelectedLight);
  const updateSelectedModelAssetCode = useEditorStore((state) => state.updateSelectedModelAssetCode);
  const updateSelectedTelemetryBinding = useEditorStore((state) => state.updateSelectedTelemetryBinding);
  const restoreSelectedTelemetryBindingDefault = useEditorStore((state) => state.restoreSelectedTelemetryBindingDefault);
  const requestRevealHierarchyEntity = useEditorStore((state) => state.requestRevealHierarchyEntity);
  const selectedEntity = scene.selectedEntityId ? scene.entities[scene.selectedEntityId] : null;
  const groupSelection = resolveHierarchyGroupTransformSelection(scene, hierarchySelectionIds);
  const groupContainsManualRoamSpawn = groupSelection.status === 'ready'
    && containsManualRoamSpawnEntity(scene, groupSelection.entityIds);
  const groupSpatialInfo = groupSelection.groupId && selectedGroupSpatialInfo?.groupId === groupSelection.groupId
    ? selectedGroupSpatialInfo
    : null;
  const modelMeasurement = selectedEntity && selectedModelMeasurement?.entityId === selectedEntity.id
    ? selectedModelMeasurement
    : null;
  const [nameDraft, setNameDraft] = useState('');

  useEffect(() => {
    setNameDraft(selectedEntity?.name ?? '');
  }, [selectedEntity?.id, selectedEntity?.name]);

  function handleNameBlur() {
    renameSelectedEntity(nameDraft);
  }

  function handleNameKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== 'Enter') return;

    event.currentTarget.blur();
  }

  function handleGroupTransformCommit(
    field: 'position' | 'rotation',
    axis: keyof Vector3Data,
    value: number,
  ): void {
    requestSelectedGroupTransform(field, axis, field === 'rotation' ? degreesToRadians(value) : value);
  }

  function handleTransformChange(field: TransformField, axis: keyof Vector3Data, rawValue: string) {
    if (rawValue === '') return;

    const nextValue = Number(rawValue);
    if (!Number.isFinite(nextValue)) return;

    updateSelectedTransform(field, axis, field === 'rotation' ? degreesToRadians(nextValue) : nextValue);
  }

  function handleLightIntensityChange(rawValue: string) {
    if (rawValue === '') return;

    const intensity = Number(rawValue);
    if (!Number.isFinite(intensity)) return;

    updateSelectedLight({ intensity });
  }

  function handleSkyboxIntensityChange(rawValue: string) {
    if (rawValue === '') return;
    const intensity = Number(rawValue);
    if (!Number.isFinite(intensity)) return;
    updateSelectedSkybox({ intensity });
  }

  function handleSkyboxResolutionChange(rawValue: string) {
    const resolution = Number(rawValue) as SceneSkyboxResolution;
    if (!SCENE_SKYBOX_RESOLUTIONS.includes(resolution)) return;
    updateSelectedSkybox({ resolution });
  }

  function handleSkyboxScaleChange(rawValue: string) {
    if (rawValue === '') return;
    const scale = Number(rawValue);
    if (!Number.isFinite(scale)) return;
    updateSelectedTransform('scale', 'x', scale);
  }

  function handleCadReferenceOpacityChange(rawValue: string) {
    if (rawValue === '') return;

    const opacity = Number(rawValue);
    if (!Number.isFinite(opacity)) return;

    updateSelectedCadReference({ opacity });
  }

  function formatCadReferenceMeters(value: number): string {
    if (!Number.isFinite(value)) return `0 ${SCENE_LENGTH_UNIT_SYMBOL}`;
    return `${value.toFixed(3)} ${SCENE_LENGTH_UNIT_SYMBOL}`;
  }

  if (!selectedEntity) {
    return <SceneSettingsPanel readOnly={props.readOnly} />;
  }

  const isFolder = selectedEntity.isFolder === true;
  const isLocked = isEntityEffectivelyLocked(scene.entities, selectedEntity) || props.readOnly === true;

  if (groupSelection.groupId) {
    const isSingleFolder = groupSelection.selectionIds.length === 1 && isFolder;
    return (
      <section className="panel inspector-panel">
        <h2>Inspector</h2>
        {isSingleFolder ? (
          <label className="inspector-row">
            <span>名称</span>
            <input
              type="text"
              disabled={isLocked}
              value={nameDraft}
              onBlur={handleNameBlur}
              onChange={(event) => setNameDraft(event.target.value)}
              onKeyDown={handleNameKeyDown}
            />
          </label>
        ) : null}
        <fieldset className="transform-fieldset">
          <legend>{isSingleFolder ? '群组文件夹' : '群组选择'}</legend>
          <p className="muted">选中项目：{groupSelection.selectionIds.length}</p>
          <p className="muted">参与空间计算：{groupSelection.entityIds.length}</p>
          {isSingleFolder ? <p className="muted">直属项目：{selectedEntity.childrenIds.length}</p> : null}
          {groupSelection.status === 'blocked' ? (
            <p className="muted">群组包含锁定对象，空间信息仍可查看，但不能整体变换。</p>
          ) : null}
        </fieldset>
        {groupSpatialInfo?.status === 'ready' ? (
          <fieldset className="transform-fieldset group-spatial-transform-fieldset">
            <legend>空间信息</legend>
            <div className="group-spatial-transform-row">
              <span>位置</span>
              {axes.map((axis) => (
                <label className="group-spatial-axis" key={`group-position-${axis}`}>
                  <span>{axis.toUpperCase()}</span>
                  <GroupSpatialAxisInput
                    ariaLabel={`群组位置 ${axis.toUpperCase()}`}
                    disabled={props.readOnly === true || groupSelection.status !== 'ready'}
                    step="0.1"
                    value={Number(groupSpatialInfo.center[axis].toFixed(6))}
                    onCommit={(value) => handleGroupTransformCommit('position', axis, value)}
                  />
                </label>
              ))}
            </div>
            <div className="group-spatial-transform-row">
              <span>旋转</span>
              {axes.map((axis) => (
                <label className="group-spatial-axis" key={`group-rotation-${axis}`}>
                  <span>{axis.toUpperCase()}</span>
                  <GroupSpatialAxisInput
                    ariaLabel={`群组旋转 ${axis.toUpperCase()}`}
                    disabled={
                      props.readOnly === true
                      || groupSelection.status !== 'ready'
                      || (groupContainsManualRoamSpawn && axis !== 'y')
                    }
                    step="1"
                    value={formatRotationDegrees(radiansToDegrees(groupSpatialInfo.rotation[axis]))}
                    onCommit={(value) => handleGroupTransformCommit('rotation', axis, value)}
                  />
                </label>
              ))}
            </div>
            <div className="group-spatial-transform-row">
              <span>缩放</span>
              {axes.map((axis) => (
                <label className="group-spatial-axis" key={`group-scale-${axis}`}>
                  <span>{axis.toUpperCase()}</span>
                  <GroupSpatialAxisInput
                    ariaLabel={`群组缩放 ${axis.toUpperCase()}`}
                    disabled
                    step="0.1"
                    value={1}
                  />
                </label>
              ))}
            </div>
            <p className="muted">位置为世界包围盒中心；旋转以首个参与对象为参考并绕群组中心执行。群组缩放暂不支持。</p>
          </fieldset>
        ) : groupSelection.status === 'empty' || groupSpatialInfo?.status === 'unavailable' ? (
          <fieldset className="transform-fieldset">
            <legend>空间信息</legend>
            <p className="muted">群组中暂无可计算空间范围的对象。</p>
          </fieldset>
        ) : (
          <fieldset className="transform-fieldset">
            <legend>空间信息</legend>
            <p className="muted">正在计算群组世界包围盒…</p>
          </fieldset>
        )}
      </section>
    );
  }

  if (isFolder) {
    return (
      <section className="panel">
        <h2>Inspector</h2>
        <p className="muted">当前文件夹选区尚未完成空间信息解析。</p>
      </section>
    );
  }

  const transform = selectedEntity.components.transform;
  const meshRenderer = selectedEntity.components.meshRenderer;
  const dataPlatformScreen = selectedEntity.components.dataPlatformScreen;
  const skybox = selectedEntity.components.skybox;
  const locator = selectedEntity.components.locator;
  const cadReference = selectedEntity.components.cadReference;
  const light = selectedEntity.components.light;
  const modelAsset = selectedEntity.components.modelAsset;
  const modelGenerator = selectedEntity.components.modelGenerator;
  const clickEventBinding = selectedEntity.components.clickEventBinding;
  const poiEffect = selectedEntity.components.poiEffect;
  const autoPatrol = selectedEntity.components.autoPatrol;
  const manualRoamSpawn = selectedEntity.components.manualRoamSpawn;
  const isCompactModelInspector = Boolean(
    modelAsset || meshRenderer || skybox || modelGenerator || clickEventBinding || poiEffect || autoPatrol || manualRoamSpawn || locator,
  );
  const isBuiltInBound = Boolean(locator?.builtInBinding);
  const builtInSlotEntityId = modelAsset ? findBuiltInSlotEntityId(scene, selectedEntity.id) : null;
  const transformDisabled = isLocked || isBuiltInBound;
  const transformFields: readonly TransformField[] = light
    ? getLightEditorCapabilities(light.lightKind).transformFields
    : skybox || autoPatrol || manualRoamSpawn
      ? fields.filter((field) => field !== 'scale')
      : fields;

  return (
    <section className={isCompactModelInspector ? 'panel inspector-panel inspector-panel-compact-model' : 'panel inspector-panel'}>
      <h2>{modelGenerator ? '模型生成器' : clickEventBinding ? '点击事件绑定' : poiEffect ? 'EFF 特效' : autoPatrol ? '自动巡检' : manualRoamSpawn ? '手动漫游' : 'Inspector'}</h2>
      <label className="inspector-row">
        <span>{poiEffect ? '特效名称' : modelGenerator || clickEventBinding || autoPatrol ? 'POI名称' : '名称'}</span>
        <input
          type="text"
          disabled={isLocked}
          value={nameDraft}
          onBlur={handleNameBlur}
          onChange={(event) => setNameDraft(event.target.value)}
          onKeyDown={handleNameKeyDown}
        />
      </label>
      {transformFields.map((field) => (
        <fieldset className="transform-fieldset transform-axis-fieldset" key={field}>
          <legend>{getTransformLegend(field, meshRenderer?.meshKind, light?.lightKind)}</legend>
          {axes.map((axis) => (
            <label className="number-row" key={`${field}-${axis}`}>
              <span>{axis.toUpperCase()}</span>
              <input
                type="number"
                disabled={transformDisabled || Boolean(manualRoamSpawn && field === 'rotation' && axis !== 'y')}
                step={getTransformInputStep(field)}
                value={getTransformInputValue(field, transform[field][axis])}
                onChange={(event) => handleTransformChange(field, axis, event.target.value)}
              />
            </label>
          ))}
          {isBuiltInBound && field === 'position' ? <p className="muted">位置由货架驱动，解绑后可编辑。</p> : null}
        </fieldset>
      ))}
      {manualRoamSpawn ? (
        <fieldset className="transform-fieldset" aria-label="手动漫游初始位置提示">
          <legend>初始姿态</legend>
          <p className="muted">位置表示人物脚底的世界坐标，旋转 Y 表示开始漫游时的水平朝向。</p>
        </fieldset>
      ) : null}
      {modelGenerator ? (
        <fieldset className="transform-fieldset" aria-label="模型生成器标记提示">
          <legend>重要提示</legend>
          <p className="muted model-generator-global-note">
            注意：此标记位置仅用于编辑模型生成器配置，不影响任何自动生成模型的位置。
          </p>
        </fieldset>
      ) : null}
      {modelGenerator ? (
        <ModelGeneratorInspector component={modelGenerator} disabled={isLocked} />
      ) : null}
      {clickEventBinding ? (
        <fieldset className="transform-fieldset" aria-label="点击事件绑定标记提示">
          <legend>重要提示</legend>
          <p className="muted model-generator-global-note">
            注意：此标记位置仅用于编辑绑定配置，运行态在全场范围内按设备类型匹配点击命中。
          </p>
        </fieldset>
      ) : null}
      {clickEventBinding ? (
        <ClickEventBindingInspector component={clickEventBinding} disabled={isLocked} />
      ) : null}
      {poiEffect ? (
        <PoiEffectInspector component={poiEffect} disabled={isLocked} />
      ) : null}
      {autoPatrol ? (
        <AutoPatrolInspector
          component={autoPatrol}
          disabled={isLocked}
          entityId={selectedEntity.id}
          transform={transform}
        />
      ) : null}
      {meshRenderer ? (
        <fieldset className="transform-fieldset">
          <legend>Mesh Renderer</legend>
          <label className="inspector-row">
            <span>颜色</span>
            <input
              type="color"
              disabled={isLocked}
              value={meshRenderer.materialColor}
              onChange={(event) => updateSelectedMaterialColor(event.target.value)}
            />
          </label>
          <p className="muted">{getBuiltInMeshMeterDescription(meshRenderer.meshKind)}</p>
        </fieldset>
      ) : null}
      {dataPlatformScreen ? (
        <fieldset className="transform-fieldset">
          <legend>数据中台大屏</legend>
          <label className="inspector-row">
            <span>显示模式</span>
            <select
              disabled={isLocked}
              value={dataPlatformScreen.renderMode}
              onChange={(event) => updateSelectedDataPlatformScreen({
                renderMode: event.target.value as DataPlatformScreenRenderMode,
              })}
            >
              <option value="iframe">iframe Overlay（交互）</option>
              <option value="texture">纹理截图（遮挡/失败降级）</option>
            </select>
          </label>
          <p className="muted">iframe 适合交互；纹理模式适合跨域限制或三维对象遮挡较强的场景。</p>
        </fieldset>
      ) : null}
      {skybox ? (
        <fieldset className="transform-fieldset">
          <legend>球形天空盒</legend>
          <p className="muted asset-path" title={skybox.sourcePath}>{skybox.sourcePath}</p>
          <p className="muted">格式：{skybox.format.toUpperCase()} · 基础直径：{SKYBOX_SPHERE_DIAMETER_METERS} m</p>
          <label className="number-row">
            <span>尺寸倍率</span>
            <input
              disabled={isLocked}
              max={SKYBOX_SPHERE_SCALE_MAX}
              min={SKYBOX_SPHERE_SCALE_MIN}
              step="0.1"
              type="number"
              value={transform.scale.x}
              onChange={(event) => handleSkyboxScaleChange(event.target.value)}
            />
          </label>
          <p className="muted">
            实际直径：{MODEL_MEASUREMENT_FORMATTER.format(getSkyboxSphereDiameterMeters(transform.scale))} m
          </p>
          <label className="number-row">
            <span>环境强度</span>
            <input
              disabled={isLocked}
              max={SCENE_SKYBOX_INTENSITY_MAX}
              min={SCENE_SKYBOX_INTENSITY_MIN}
              step="0.1"
              type="number"
              value={skybox.intensity}
              onChange={(event) => handleSkyboxIntensityChange(event.target.value)}
            />
          </label>
          <label className="inspector-row">
            <span>纹理分辨率</span>
            <select
              disabled={isLocked}
              value={skybox.resolution}
              onChange={(event) => handleSkyboxResolutionChange(event.target.value)}
            >
              {SCENE_SKYBOX_RESOLUTIONS.map((resolution) => (
                <option key={resolution} value={resolution}>{resolution} × {resolution}</option>
              ))}
            </select>
          </label>
          <p className="muted">使用 position 移动球心，rotation Y 旋转环境；尺寸倍率始终等比缩放球体。</p>
        </fieldset>
      ) : null}
      {locator ? (
        <LocatorInspector component={locator} disabled={isLocked} />
      ) : null}
      {cadReference ? (
        <fieldset className="transform-fieldset">
          <legend>CAD参考图</legend>
          <p className="muted asset-path" title={cadReference.sourcePath}>{cadReference.sourcePath}</p>
          <label className="inspector-row">
            <span>线色</span>
            <input
              type="color"
              disabled={isLocked}
              value={cadReference.lineColor}
              onChange={(event) => updateSelectedCadReference({ lineColor: event.target.value })}
            />
          </label>
          <label className="number-row">
            <span>透明度</span>
            <input
              type="number"
              disabled={isLocked}
              min="0"
              max="1"
              step="0.05"
              value={cadReference.opacity}
              onChange={(event) => handleCadReferenceOpacityChange(event.target.value)}
            />
          </label>
          <p className="muted">源单位：{formatCadReferenceUnitSummary(cadReference)}</p>
          <p className="muted">
            尺寸：X {formatCadReferenceMeters(cadReference.bounds.size.x)} / Z {formatCadReferenceMeters(cadReference.bounds.size.z)}
          </p>
          <p className="muted">
            图层：{cadReference.layerStats.length}，折线：{cadReference.polylineCount}，点：{cadReference.pointCount}
          </p>
        </fieldset>
      ) : null}
      {light ? (
        <fieldset className="transform-fieldset">
          <legend>Light</legend>
          <label className="inspector-row">
            <span>类型</span>
            <select
              value={light.lightKind}
              disabled={isLocked}
              onChange={(event) => updateSelectedLight({ lightKind: event.target.value as LightKind })}
            >
              {lightKinds.map((lightKind) => (
                <option key={lightKind} value={lightKind}>{lightKind}</option>
              ))}
            </select>
          </label>
          <label className="number-row">
            <span>强度</span>
            <input
              type="number"
              disabled={isLocked}
              min="0"
              step="0.1"
              value={light.intensity}
              onChange={(event) => handleLightIntensityChange(event.target.value)}
            />
          </label>
        </fieldset>
      ) : null}
      {modelAsset ? (
        <>
          <fieldset className="transform-fieldset">
            <legend>Model Asset</legend>
            <label className="inspector-row">
              <span>资产编号</span>
              <input
                maxLength={128}
                type="text"
                disabled={isLocked}
                value={modelAsset.assetCode}
                onChange={(event) => updateSelectedModelAssetCode(event.target.value)}
              />
            </label>
            <div className="model-asset-meta">
              <p className="muted asset-path" title={modelAsset.sourcePath}>{modelAsset.sourcePath}</p>
              <p className="muted">源单位：{formatModelLengthUnit(modelAsset.lengthUnit)}</p>
              <p className="muted">换算到米：×{modelAsset.unitScaleToMeters}</p>
              <div aria-live="polite" className="model-measurement">
                <p className="muted">实际尺寸 (m)</p>
                {modelMeasurement?.status === 'ready' ? (
                  <>
                    <p className="muted">X：{formatModelMeasurementMeters(modelMeasurement.sizeMeters.x)}</p>
                    <p className="muted">Y：{formatModelMeasurementMeters(modelMeasurement.sizeMeters.y)}</p>
                    <p className="muted">Z：{formatModelMeasurementMeters(modelMeasurement.sizeMeters.z)}</p>
                  </>
                ) : modelMeasurement?.status === 'unavailable' ? (
                  <p className="muted">暂无可测量几何。</p>
                ) : (
                  <p className="muted">正在计算模型几何尺寸…</p>
                )}
              </div>
            </div>
            {builtInSlotEntityId ? (
              <label className="inspector-row">
                <span>内置货格</span>
                <button
                  type="button"
                  disabled={isLocked}
                  onClick={() => requestRevealHierarchyEntity(builtInSlotEntityId)}
                >
                  跳转定位
                </button>
              </label>
            ) : null}
          </fieldset>
          {isSpecializedTelemetryDeviceType(modelAsset.dataDrivenConfig?.device.devType) ? (
            <>
              <TelemetryBindingInspector
                entityId={selectedEntity.id}
                binding={selectedEntity.components.telemetryBinding}
                dataDrivenConfig={modelAsset.dataDrivenConfig ?? null}
                disabled={isLocked}
                modelAssetCode={modelAsset.assetCode}
                onChange={updateSelectedTelemetryBinding}
                onRestoreDefault={restoreSelectedTelemetryBindingDefault}
              />
              <CargoGeneratorInspector
                binding={selectedEntity.components.telemetryBinding}
                modelDevType={modelAsset.dataDrivenConfig?.device.devType}
                disabled={isLocked}
                onChange={updateSelectedTelemetryBinding}
              />
            </>
          ) : null}
          <ModelParametersInspector modelAsset={modelAsset} disabled={isLocked} compact={isCompactModelInspector} />
        </>
      ) : null}
    </section>
  );
}
