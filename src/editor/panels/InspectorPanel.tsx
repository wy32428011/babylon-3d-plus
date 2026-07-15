import { useEffect, useState, type KeyboardEvent } from 'react';
import { getBuiltInMeshMeterDescription } from '../model/builtInMeshGeometry';
import type { LightKind, MeshKind } from '../model/components';
import type { Vector3Data } from '../model/math';
import { formatCadReferenceUnitSummary } from '../cad/cadUnits';
import { SCENE_LENGTH_UNIT_SYMBOL, formatModelLengthUnit } from '../model/sceneUnits';
import { useEditorStore } from '../store/editorStore';
import { ModelGeneratorInspector } from './ModelGeneratorInspector';
import { ModelParametersInspector } from './ModelParametersInspector';
import { TelemetryBindingInspector } from './TelemetryBindingInspector';
import { SceneSettingsPanel } from './SceneSettingsPanel';

type TransformField = 'position' | 'rotation' | 'scale';
type LocatorDimensionField = 'length' | 'width' | 'height';

const axes: Array<keyof Vector3Data> = ['x', 'y', 'z'];
const fields: TransformField[] = ['position', 'rotation', 'scale'];
const lightKinds: LightKind[] = ['hemispheric', 'directional', 'point'];
const RADIANS_TO_DEGREES = 180 / Math.PI;
const DEGREES_TO_RADIANS = Math.PI / 180;
const locatorDimensionFields: Array<{ key: LocatorDimensionField; label: string }> = [
  { key: 'length', label: '长(X)' },
  { key: 'width', label: '宽(Z)' },
  { key: 'height', label: '高(Y)' },
];

/** 根据 Transform 字段和基础网格类型生成单位明确的 Inspector 标题。 */
function getTransformLegend(field: TransformField, meshKind?: MeshKind): string {
  if (field === 'position') return `${field} (${SCENE_LENGTH_UNIT_SYMBOL})`;
  if (field === 'rotation') return `${field} (deg)`;
  if (field === 'scale' && meshKind === 'cube') return `size (${SCENE_LENGTH_UNIT_SYMBOL})`;

  return field;
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
  const selectedModelMeasurement = useEditorStore((state) => state.selectedModelMeasurement);
  const renameSelectedEntity = useEditorStore((state) => state.renameSelectedEntity);
  const updateSelectedTransform = useEditorStore((state) => state.updateSelectedTransform);
  const updateSelectedMaterialColor = useEditorStore((state) => state.updateSelectedMaterialColor);
  const updateSelectedLocator = useEditorStore((state) => state.updateSelectedLocator);
  const updateSelectedCadReference = useEditorStore((state) => state.updateSelectedCadReference);
  const updateSelectedLight = useEditorStore((state) => state.updateSelectedLight);
  const updateSelectedModelAssetCode = useEditorStore((state) => state.updateSelectedModelAssetCode);
  const updateSelectedTelemetryBinding = useEditorStore((state) => state.updateSelectedTelemetryBinding);
  const restoreSelectedTelemetryBindingDefault = useEditorStore((state) => state.restoreSelectedTelemetryBindingDefault);
  const selectedEntity = scene.selectedEntityId ? scene.entities[scene.selectedEntityId] : null;
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

  function handleLocatorDimensionChange(field: LocatorDimensionField, rawValue: string) {
    if (rawValue === '') return;

    const nextValue = Number(rawValue);
    if (!Number.isFinite(nextValue)) return;

    if (field === 'length') updateSelectedLocator({ length: nextValue });
    if (field === 'width') updateSelectedLocator({ width: nextValue });
    if (field === 'height') updateSelectedLocator({ height: nextValue });
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

  const parentEntity = selectedEntity.parentId ? scene.entities[selectedEntity.parentId] : null;
  const isFolder = selectedEntity.isFolder === true;
  const isLocked = selectedEntity.locked === true || parentEntity?.locked === true || props.readOnly === true;

  if (isFolder) {
    return (
      <section className="panel">
        <h2>Inspector</h2>
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
        <fieldset className="transform-fieldset">
          <legend>文件夹</legend>
          <p className="muted">包含对象：{selectedEntity.childrenIds.length}</p>
          <p className="muted">仅用于 Hierarchy 分组，不参与场景变换。</p>
        </fieldset>
      </section>
    );
  }

  const transform = selectedEntity.components.transform;
  const meshRenderer = selectedEntity.components.meshRenderer;
  const locator = selectedEntity.components.locator;
  const cadReference = selectedEntity.components.cadReference;
  const light = selectedEntity.components.light;
  const modelAsset = selectedEntity.components.modelAsset;
  const modelGenerator = selectedEntity.components.modelGenerator;
  const isCompactModelInspector = Boolean(modelAsset || meshRenderer || modelGenerator);

  return (
    <section className={isCompactModelInspector ? 'panel inspector-panel inspector-panel-compact-model' : 'panel inspector-panel'}>
      <h2>{modelGenerator ? '模型生成器' : 'Inspector'}</h2>
      <label className="inspector-row">
        <span>{modelGenerator ? 'POI名称' : '名称'}</span>
        <input
          type="text"
          disabled={isLocked}
          value={nameDraft}
          onBlur={handleNameBlur}
          onChange={(event) => setNameDraft(event.target.value)}
          onKeyDown={handleNameKeyDown}
        />
      </label>
      {fields.map((field) => (
        <fieldset className="transform-fieldset transform-axis-fieldset" key={field}>
          <legend>{getTransformLegend(field, meshRenderer?.meshKind)}</legend>
          {axes.map((axis) => (
            <label className="number-row" key={`${field}-${axis}`}>
              <span>{axis.toUpperCase()}</span>
              <input
                type="number"
                disabled={isLocked}
                step={getTransformInputStep(field)}
                value={getTransformInputValue(field, transform[field][axis])}
                onChange={(event) => handleTransformChange(field, axis, event.target.value)}
              />
            </label>
          ))}
        </fieldset>
      ))}
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
      {locator ? (
        <fieldset className="transform-fieldset">
          <legend>虚拟定位线框</legend>
          <label className="inspector-row">
            <span>资产编号</span>
            <input
              maxLength={128}
              type="text"
              disabled={isLocked}
              value={locator.assetId}
              onChange={(event) => updateSelectedLocator({ assetId: event.target.value })}
            />
          </label>
          <label className="inspector-row">
            <span>库位排深</span>
            <select
              disabled={isLocked}
              value={locator.storageDepth}
              onChange={(event) => updateSelectedLocator({ storageDepth: event.target.value === 'far' ? 'far' : 'near' })}
            >
              <option value="near">近排（一段货叉）</option>
              <option value="far">远排（二段货叉）</option>
            </select>
          </label>
          <p className="muted">库位号建议使用“排-列-层”，例如 1-1-1、1-2-1。</p>
          {locatorDimensionFields.map(({ key, label }) => (
            <label className="number-row" key={key}>
              <span>{label}</span>
              <input
                type="number"
                disabled={isLocked}
                min="0.01"
                step="0.1"
                value={locator[key]}
                onChange={(event) => handleLocatorDimensionChange(key, event.target.value)}
              />
            </label>
          ))}
          <p className="muted">单位：{SCENE_LENGTH_UNIT_SYMBOL}</p>
        </fieldset>
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
          </fieldset>
          <TelemetryBindingInspector
            entityId={selectedEntity.id}
            binding={selectedEntity.components.telemetryBinding}
            defaultChannels={modelAsset.dataDrivenConfig?.motion ?? {}}
            disabled={isLocked}
            modelAssetCode={modelAsset.assetCode}
            onChange={updateSelectedTelemetryBinding}
            onRestoreDefault={restoreSelectedTelemetryBindingDefault}
          />
          <ModelParametersInspector modelAsset={modelAsset} disabled={isLocked} compact={isCompactModelInspector} />
        </>
      ) : null}
    </section>
  );
}
