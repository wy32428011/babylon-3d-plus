import { SCENE_LENGTH_UNIT_SYMBOL } from '../model/sceneUnits';
import type { LocatorComponent } from '../model/components';
import { useEditorStore } from '../store/editorStore';

type LocatorInspectorProps = {
  component: LocatorComponent;
  disabled?: boolean;
};

type LocatorDimensionField = 'length' | 'width' | 'height' | 'columns' | 'layers' | 'startColumn' | 'columnGap' | 'layerGap';

type LocatorDimensionConfig = {
  key: LocatorDimensionField;
  label: string;
  min: number;
  max: number;
  step: number;
};

const locatorDimensionFields: readonly LocatorDimensionConfig[] = [
  { key: 'length', label: '长(m)', min: 0.01, max: Infinity, step: 0.1 },
  { key: 'width', label: '宽(m)', min: 0.01, max: Infinity, step: 0.1 },
  { key: 'height', label: '高(m)', min: 0.01, max: Infinity, step: 0.1 },
  { key: 'columns', label: '列数 (X)', min: 1, max: 100, step: 1 },
  { key: 'layers', label: '层数 (Y)', min: 1, max: 100, step: 1 },
  { key: 'columnGap', label: '列间隔(m)', min: 0, max: 10, step: 0.1 },
  { key: 'layerGap', label: '层间隔(m)', min: 0, max: 10, step: 0.1 },
  { key: 'startColumn', label: '起始列', min: 1, max: 999, step: 1 },
];

export function LocatorInspector({ component, disabled = false }: LocatorInspectorProps) {
  const updateSelectedLocator = useEditorStore((state) => state.updateSelectedLocator);

  function handleDimensionChange(field: LocatorDimensionField, rawValue: string) {
    if (rawValue === '') return;
    const nextValue = Number(rawValue);
    if (!Number.isFinite(nextValue)) return;
    updateSelectedLocator({ [field]: nextValue } as Partial<LocatorComponent>);
  }

  return (
    <fieldset className="transform-fieldset">
      <legend>虚拟定位线框</legend>
      <label className="inspector-row">
        <span>资产编号</span>
        <input
          maxLength={128}
          type="text"
          disabled={disabled}
          value={component.assetId}
          onChange={(event) => updateSelectedLocator({ assetId: event.target.value })}
        />
      </label>
      <label className="inspector-row">
        <span>关联设备</span>
        <input
          maxLength={128}
          type="text"
          disabled={disabled}
          value={component.deviceAssetCode}
          onChange={(event) => updateSelectedLocator({ deviceAssetCode: event.target.value })}
          placeholder="堆垛机资产编号"
        />
      </label>
      <label className="inspector-row">
        <span>排号 ({'to_z'})</span>
        <input
          type="number"
          disabled={disabled}
          min={1}
          max={99}
          step={1}
          value={component.rowNumber}
          onChange={(event) => {
            const value = Number(event.target.value);
            if (Number.isFinite(value) && value >= 1 && value <= 99) {
              updateSelectedLocator({ rowNumber: Math.round(value) });
            }
          }}
        />
      </label>
      <label className="inspector-row">
        <span>库位排深</span>
        <select
          disabled={disabled}
          value={component.storageDepth}
          onChange={(event) => updateSelectedLocator({ storageDepth: event.target.value === 'far' ? 'far' : 'near' })}
        >
          <option value="near">近排（一段货叉）</option>
          <option value="far">远排（二段货叉）</option>
        </select>
      </label>
      {locatorDimensionFields.map(({ key, label, min, max, step }) => (
        <label className="inspector-row" key={key}>
          <span>{label}</span>
          <input
            type="number"
            disabled={disabled}
            min={min}
            max={Number.isFinite(max) ? max : undefined}
            step={step}
            value={component[key]}
            onChange={(event) => handleDimensionChange(key, event.target.value)}
          />
        </label>
      ))}
    </fieldset>
  );
}
