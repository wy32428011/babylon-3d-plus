import { useEffect, useState, type KeyboardEvent } from 'react';
import type { LightKind } from '../model/components';
import type { Vector3Data } from '../model/math';
import { SCENE_LENGTH_UNIT_SYMBOL, formatModelLengthUnit } from '../model/sceneUnits';
import { useEditorStore } from '../store/editorStore';

type TransformField = 'position' | 'rotation' | 'scale';

const axes: Array<keyof Vector3Data> = ['x', 'y', 'z'];
const fields: TransformField[] = ['position', 'rotation', 'scale'];
const lightKinds: LightKind[] = ['hemispheric', 'directional', 'point'];

function getTransformLegend(field: TransformField): string {
  if (field === 'position') return `${field} (${SCENE_LENGTH_UNIT_SYMBOL})`;

  return field;
}

export function InspectorPanel() {
  const scene = useEditorStore((state) => state.scene);
  const renameSelectedEntity = useEditorStore((state) => state.renameSelectedEntity);
  const updateSelectedTransform = useEditorStore((state) => state.updateSelectedTransform);
  const updateSelectedMaterialColor = useEditorStore((state) => state.updateSelectedMaterialColor);
  const updateSelectedLight = useEditorStore((state) => state.updateSelectedLight);
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

  if (!selectedEntity) {
    return (
      <section className="panel">
        <h2>Inspector</h2>
        <p className="muted">请选择一个对象。</p>
      </section>
    );
  }

  const transform = selectedEntity.components.transform;
  const meshRenderer = selectedEntity.components.meshRenderer;
  const light = selectedEntity.components.light;
  const modelAsset = selectedEntity.components.modelAsset;

  return (
    <section className="panel">
      <h2>Inspector</h2>
      <label className="inspector-row">
        <span>名称</span>
        <input
          type="text"
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
              value={meshRenderer.materialColor}
              onChange={(event) => updateSelectedMaterialColor(event.target.value)}
            />
          </label>
        </fieldset>
      ) : null}
      {light ? (
        <fieldset className="transform-fieldset">
          <legend>Light</legend>
          <label className="inspector-row">
            <span>类型</span>
            <select value={light.lightKind} onChange={(event) => updateSelectedLight({ lightKind: event.target.value as LightKind })}>
              {lightKinds.map((lightKind) => (
                <option key={lightKind} value={lightKind}>{lightKind}</option>
              ))}
            </select>
          </label>
          <label className="number-row">
            <span>强度</span>
            <input
              type="number"
              min="0"
              step="0.1"
              value={light.intensity}
              onChange={(event) => handleLightIntensityChange(event.target.value)}
            />
          </label>
        </fieldset>
      ) : null}
      {modelAsset ? (
        <fieldset className="transform-fieldset">
          <legend>Model Asset</legend>
          <p className="muted asset-path" title={modelAsset.sourcePath}>{modelAsset.sourcePath}</p>
          <p className="muted">源单位：{formatModelLengthUnit(modelAsset.lengthUnit)}</p>
          <p className="muted">换算到米：×{modelAsset.unitScaleToMeters}</p>
        </fieldset>
      ) : null}
    </section>
  );
}
