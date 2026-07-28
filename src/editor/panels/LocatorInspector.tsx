import { SCENE_LENGTH_UNIT_SYMBOL } from '../model/sceneUnits';
import type { LocatorComponent } from '../model/components';
import { useEditorStore } from '../store/editorStore';
type LocatorInspectorProps = {
  component: LocatorComponent;
  disabled?: boolean;
};

type LocatorDimensionField = 'length' | 'width' | 'height' | 'columns' | 'layers' | 'columnGap' | 'layerGap';

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
];

export function LocatorInspector({ component, disabled = false }: LocatorInspectorProps) {
  const updateSelectedLocator = useEditorStore((state) => state.updateSelectedLocator);
  const scene = useEditorStore((state) => state.scene);

  const generatorOptions = scene.entityIds
    .map((entityId) => scene.entities[entityId])
    .filter((entity) => entity?.components.modelGenerator)
    .map((entity) => ({ id: entity.id, name: entity.name }));
  const fetchDrive = component.fetchDrive;
  const cargoGeneratorMissing = Boolean(
    fetchDrive?.cargoGeneratorId && !generatorOptions.some((option) => option.id === fetchDrive.cargoGeneratorId),
  );

  function handleDimensionChange(field: LocatorDimensionField, rawValue: string) {
    if (rawValue === '') return;
    const nextValue = Number(rawValue);
    if (!Number.isFinite(nextValue)) return;
    updateSelectedLocator({ [field]: nextValue } as Partial<LocatorComponent>);
  }

  /** 提交完整 fetchDrive 对象，由 Store 统一清洗并写入撤销历史。 */
  function updateFetchDrive(enabled: boolean, cargoGeneratorId: string | undefined) {
    updateSelectedLocator({
      fetchDrive: {
        enabled,
        ...(cargoGeneratorId ? { cargoGeneratorId } : {}),
      },
    });
  }

  return (
    <>
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
      <label className="inspector-row">
        <span>起始列</span>
        <input
          type="number"
          disabled={disabled}
          min={1}
          max={999}
          step={1}
          value={component.startColumn}
          onChange={(event) => {
            const value = Number(event.target.value);
            if (Number.isFinite(value) && value >= 1 && value <= 999) {
              updateSelectedLocator({ startColumn: Math.round(value) });
            }
          }}
        />
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
    <fieldset className="transform-fieldset">
      <legend>Fetch 数据驱动</legend>
      <p className="muted">运行预览时按排号从 Fetch 接口拉取库存并渲染到本线框库位；排号、起始列使用上方已有配置。</p>
      <label className="inspector-row">
        <span>启用</span>
        <input
          type="checkbox"
          disabled={disabled}
          checked={fetchDrive?.enabled === true}
          onChange={(event) => updateFetchDrive(event.target.checked, fetchDrive?.cargoGeneratorId)}
        />
      </label>
      <label className="inspector-row">
        <span>货箱生成器</span>
        <select
          disabled={disabled}
          value={fetchDrive?.cargoGeneratorId || '__none__'}
          onChange={(event) => updateFetchDrive(fetchDrive?.enabled === true, event.target.value !== '__none__' ? event.target.value : undefined)}
        >
          <option value="__none__">未绑定（内置立方体）</option>
          {generatorOptions.map((option) => (
            <option key={option.id} value={option.id}>{option.name}</option>
          ))}
        </select>
      </label>
      {cargoGeneratorMissing ? <p className="telemetry-runtime-error">绑定的模型生成器已被删除，运行时将回退内置立方体。</p> : null}
    </fieldset>
    </>
  );
}
