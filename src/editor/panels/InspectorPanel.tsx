import { useEffect, useState, type KeyboardEvent } from 'react';
import type { LightKind } from '../model/components';
import type { Vector3Data } from '../model/math';
import { SCENE_LENGTH_UNIT_SYMBOL, formatModelLengthUnit } from '../model/sceneUnits';
import { useEditorStore } from '../store/editorStore';
import { ModelParametersInspector } from './ModelParametersInspector';
import { SceneSettingsPanel } from './SceneSettingsPanel';

type TransformField = 'position' | 'rotation' | 'scale';
type LocatorDimensionField = 'length' | 'width' | 'height';

const axes: Array<keyof Vector3Data> = ['x', 'y', 'z'];
const fields: TransformField[] = ['position', 'rotation', 'scale'];
const lightKinds: LightKind[] = ['hemispheric', 'directional', 'point'];
const locatorDimensionFields: Array<{ key: LocatorDimensionField; label: string }> = [
  { key: 'length', label: '长(X)' },
  { key: 'width', label: '宽(Z)' },
  { key: 'height', label: '高(Y)' },
];

function getTransformLegend(field: TransformField): string {
  if (field === 'position') return `${field} (${SCENE_LENGTH_UNIT_SYMBOL})`;

  return field;
}

export function InspectorPanel() {
  const scene = useEditorStore((state) => state.scene);
  const renameSelectedEntity = useEditorStore((state) => state.renameSelectedEntity);
  const updateSelectedTransform = useEditorStore((state) => state.updateSelectedTransform);
  const updateSelectedMaterialColor = useEditorStore((state) => state.updateSelectedMaterialColor);
  const updateSelectedLocator = useEditorStore((state) => state.updateSelectedLocator);
  const updateSelectedCadReference = useEditorStore((state) => state.updateSelectedCadReference);
  const updateSelectedLight = useEditorStore((state) => state.updateSelectedLight);
  const updateSelectedModelAssetCode = useEditorStore((state) => state.updateSelectedModelAssetCode);
  const selectedEntity = scene.selectedEntityId ? scene.entities[scene.selectedEntityId] : null;
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

    updateSelectedTransform(field, axis, nextValue);
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
    return <SceneSettingsPanel />;
  }

  const parentEntity = selectedEntity.parentId ? scene.entities[selectedEntity.parentId] : null;
  const isFolder = selectedEntity.isFolder === true;
  const isLocked = selectedEntity.locked === true || parentEntity?.locked === true;

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
      {fields.map((field) => (
        <fieldset className="transform-fieldset" key={field}>
          <legend>{getTransformLegend(field)}</legend>
          {axes.map((axis) => (
            <label className="number-row" key={`${field}-${axis}`}>
              <span>{axis.toUpperCase()}</span>
              <input
                type="number"
                disabled={isLocked}
                step="0.1"
                value={transform[field][axis]}
                onChange={(event) => handleTransformChange(field, axis, event.target.value)}
              />
            </label>
          ))}
        </fieldset>
      ))}
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
          <p className="muted">换算到米：×{cadReference.unitScaleToMeters}</p>
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
            <p className="muted asset-path" title={modelAsset.sourcePath}>{modelAsset.sourcePath}</p>
            <p className="muted">源单位：{formatModelLengthUnit(modelAsset.lengthUnit)}</p>
            <p className="muted">换算到米：×{modelAsset.unitScaleToMeters}</p>
          </fieldset>
          <ModelParametersInspector modelAsset={modelAsset} disabled={isLocked} />
        </>
      ) : null}
    </section>
  );
}
