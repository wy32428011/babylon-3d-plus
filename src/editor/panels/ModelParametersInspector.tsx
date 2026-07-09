import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { ModelAssetComponent } from '../model/components';
import type {
  ModelParameterDefinition,
  ModelParameterValue,
  ModelParameterValues,
  ModelVector3ParameterDefinition,
} from '../model/modelParameters';
import {
  cloneModelParameterValues,
  createDefaultModelParameterValues,
  sanitizeModelParameterValue,
} from '../model/modelParameters';
import type { Vector3Data } from '../model/math';
import { useEditorStore } from '../store/editorStore';

type ModelParametersInspectorProps = {
  modelAsset: ModelAssetComponent;
  disabled?: boolean;
  compact?: boolean;
};

type DraftValues = Record<string, string>;

const axes: Array<keyof Vector3Data> = ['x', 'y', 'z'];

function isVector3Value(value: ModelParameterValue | undefined): value is Vector3Data {
  return typeof value === 'object' && value !== null && 'x' in value && 'y' in value && 'z' in value;
}

function getParameterValues(modelAsset: ModelAssetComponent): ModelParameterValues {
  if (!modelAsset.parameterConfig) return {};
  return modelAsset.parameterValues ?? createDefaultModelParameterValues(modelAsset.parameterConfig);
}

function formatValue(value: ModelParameterValue | undefined): string {
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return '';
}

function getVectorAxisValue(value: ModelParameterValue | undefined, axis: keyof Vector3Data): number {
  return isVector3Value(value) ? value[axis] : 0;
}

function getContinuousDraftKey(parameterKey: string, axis?: keyof Vector3Data): string {
  return axis ? `${parameterKey}.${axis}` : parameterKey;
}

export function ModelParametersInspector({ modelAsset, disabled = false, compact = false }: ModelParametersInspectorProps) {
  const updateSelectedModelParameterValue = useEditorStore((state) => state.updateSelectedModelParameterValue);
  const previewSelectedModelParameterValue = useEditorStore((state) => state.previewSelectedModelParameterValue);
  const commitSelectedModelParameterValues = useEditorStore((state) => state.commitSelectedModelParameterValues);
  const [draftValues, setDraftValues] = useState<DraftValues>({});
  const beforeEditValuesRef = useRef<ModelParameterValues | null>(null);

  const config = modelAsset.parameterConfig;
  const values = getParameterValues(modelAsset);

  useEffect(() => {
    setDraftValues({});
    beforeEditValuesRef.current = null;
  }, [modelAsset.sourcePath, config]);

  if (!config) {
    return <p className="muted">该模型没有参数化配置。</p>;
  }

  function beginContinuousEdit() {
    if (!beforeEditValuesRef.current) {
      beforeEditValuesRef.current = cloneModelParameterValues(values);
    }
  }

  function commitContinuousEdit() {
    const before = beforeEditValuesRef.current;
    if (!before) return;

    beforeEditValuesRef.current = null;
    setDraftValues({});
    commitSelectedModelParameterValues(before, cloneModelParameterValues(values));
  }

  function cancelContinuousEdit() {
    const before = beforeEditValuesRef.current;
    if (!before) return;

    beforeEditValuesRef.current = null;
    setDraftValues({});
    for (const [key, value] of Object.entries(before)) {
      previewSelectedModelParameterValue(key, value);
    }
  }

  function handleContinuousKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') {
      event.currentTarget.blur();
      return;
    }

    if (event.key === 'Escape') {
      cancelContinuousEdit();
      event.currentTarget.blur();
    }
  }

  function previewValue(definition: ModelParameterDefinition, rawValue: unknown) {
    beginContinuousEdit();
    previewSelectedModelParameterValue(definition.key, sanitizeModelParameterValue(definition, rawValue));
  }

  function renderNumberParameter(definition: ModelParameterDefinition & { type: 'number' }) {
    const draftKey = getContinuousDraftKey(definition.key);
    const currentValue = values[definition.key];
    const draft = draftValues[draftKey] ?? formatValue(currentValue);

    return (
      <label className="number-row" key={definition.key}>
        <span>{definition.label}</span>
        <input
          type="number"
          disabled={disabled}
          min={definition.min}
          max={definition.max}
          step={definition.step ?? 0.1}
          value={draft}
          onBlur={commitContinuousEdit}
          onChange={(event) => {
            const rawValue = event.target.value;
            setDraftValues((drafts) => ({ ...drafts, [draftKey]: rawValue }));
            if (rawValue === '') return;

            const nextValue = Number(rawValue);
            if (Number.isFinite(nextValue)) previewValue(definition, nextValue);
          }}
          onFocus={beginContinuousEdit}
          onKeyDown={handleContinuousKeyDown}
        />
      </label>
    );
  }

  function renderColorParameter(definition: ModelParameterDefinition & { type: 'color' }) {
    return (
      <label className="inspector-row" key={definition.key}>
        <span>{definition.label}</span>
        <input
          type="color"
          disabled={disabled}
          value={formatValue(values[definition.key])}
          onBlur={commitContinuousEdit}
          onChange={(event) => previewValue(definition, event.target.value)}
          onFocus={beginContinuousEdit}
          onKeyDown={handleContinuousKeyDown}
        />
      </label>
    );
  }

  function renderBooleanParameter(definition: ModelParameterDefinition & { type: 'boolean' }) {
    return (
      <label className="inspector-row" key={definition.key}>
        <span>{definition.label}</span>
        <input
          type="checkbox"
          disabled={disabled}
          checked={values[definition.key] === true}
          onChange={(event) => updateSelectedModelParameterValue(definition.key, event.target.checked)}
        />
      </label>
    );
  }

  function renderEnumParameter(definition: ModelParameterDefinition & { type: 'enum' }) {
    return (
      <label className="inspector-row" key={definition.key}>
        <span>{definition.label}</span>
        <select
          disabled={disabled}
          value={formatValue(values[definition.key])}
          onChange={(event) => updateSelectedModelParameterValue(definition.key, event.target.value)}
        >
          {definition.options.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      </label>
    );
  }

  function renderVector3Parameter(definition: ModelVector3ParameterDefinition) {
    const currentValue = values[definition.key];
    const fieldsetClassName = compact
      ? 'transform-fieldset model-parameter-vector model-parameter-vector-compact'
      : 'transform-fieldset model-parameter-vector';

    return (
      <fieldset className={fieldsetClassName} key={definition.key}>
        <legend>{definition.label}{definition.unit ? ` (${definition.unit})` : ''}</legend>
        {axes.map((axis) => {
          const draftKey = getContinuousDraftKey(definition.key, axis);
          const draft = draftValues[draftKey] ?? String(getVectorAxisValue(currentValue, axis));

          return (
            <label className="number-row" key={draftKey}>
              <span>{axis.toUpperCase()}</span>
              <input
                type="number"
                disabled={disabled}
                min={definition.min}
                max={definition.max}
                step={definition.step ?? 0.1}
                value={draft}
                onBlur={commitContinuousEdit}
                onChange={(event) => {
                  const rawValue = event.target.value;
                  setDraftValues((drafts) => ({ ...drafts, [draftKey]: rawValue }));
                  if (rawValue === '') return;

                  const nextAxisValue = Number(rawValue);
                  if (!Number.isFinite(nextAxisValue)) return;

                  const vectorValue: Vector3Data = isVector3Value(currentValue)
                    ? { ...currentValue, [axis]: nextAxisValue }
                    : { ...definition.defaultValue, [axis]: nextAxisValue };
                  previewValue(definition, vectorValue);
                }}
                onFocus={beginContinuousEdit}
                onKeyDown={handleContinuousKeyDown}
              />
            </label>
          );
        })}
      </fieldset>
    );
  }

  function renderTextureParameter(definition: ModelParameterDefinition & { type: 'texture' }) {
    if (definition.options?.length) {
      return (
        <label className="inspector-row" key={definition.key}>
          <span>{definition.label}</span>
          <select
            disabled={disabled}
            value={formatValue(values[definition.key])}
            onChange={(event) => updateSelectedModelParameterValue(definition.key, event.target.value)}
          >
            {definition.options.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
      );
    }

    return (
      <label className="inspector-row" key={definition.key}>
        <span>{definition.label}</span>
        <input
          type="text"
          disabled={disabled}
          value={formatValue(values[definition.key])}
          onChange={(event) => updateSelectedModelParameterValue(definition.key, event.target.value)}
        />
      </label>
    );
  }

  function renderParameter(definition: ModelParameterDefinition) {
    if (definition.type === 'number') return renderNumberParameter(definition);
    if (definition.type === 'color') return renderColorParameter(definition);
    if (definition.type === 'boolean') return renderBooleanParameter(definition);
    if (definition.type === 'enum') return renderEnumParameter(definition);
    if (definition.type === 'vector3') return renderVector3Parameter(definition);
    return renderTextureParameter(definition);
  }

  return (
    <fieldset className={compact ? 'transform-fieldset model-parameters-fieldset model-parameters-fieldset-compact' : 'transform-fieldset model-parameters-fieldset'}>
      <legend>模型参数</legend>
      {config.parameters.map(renderParameter)}
    </fieldset>
  );
}
