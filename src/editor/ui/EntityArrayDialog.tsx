import { useEffect } from 'react';
import { ARRAY_ASSET_NUMBER_MAX_LENGTH, getArrayAssetNumberRuleError } from '../model/arrayAssetNumbering';
import { getEntityArrayParameterError, MODEL_ARRAY_COPY_COUNT_MAX } from '../model/modelArray';
import type { EntityArrayDirection } from '../store/editorStore';

export type EntityArrayDialogValue = {
  copyCount: number;
  direction: EntityArrayDirection;
  spacingMeters: number;
  assetNumberRule: string;
};

type EntityArrayDialogProps = {
  value: EntityArrayDialogValue;
  assetNumberedSourceCount: number;
  validationError?: string | null;
  directionLabel?: string;
  readOnly?: boolean;
  onChange: (value: EntityArrayDialogValue) => void;
  onCancel: () => void;
  onConfirm: () => void;
};

/** Hierarchy 菜单和 Shift+Gizmo 阵列共用的参数弹框。 */
export function EntityArrayDialog(props: EntityArrayDialogProps) {
  const parameterError = getEntityArrayParameterError(props.value.copyCount, props.value.spacingMeters);
  const ruleError = getArrayAssetNumberRuleError(props.value.assetNumberRule);
  const hasUnavailableAssetNumberRule = Boolean(
    props.value.assetNumberRule.trim() && props.assetNumberedSourceCount !== 1,
  );
  const canEditAssetNumberRule = !props.readOnly && props.assetNumberedSourceCount === 1;
  const error = parameterError
    ?? ruleError
    ?? (hasUnavailableAssetNumberRule ? '自定义资产编号规则仅支持一个带资产编号的源对象。' : null)
    ?? props.validationError
    ?? null;

  useEffect(() => {
    function handleWindowKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      props.onCancel();
    }

    window.addEventListener('keydown', handleWindowKeyDown);
    return () => window.removeEventListener('keydown', handleWindowKeyDown);
  }, [props.onCancel]);

  return (
    <div
      className="hierarchy-array-dialog-backdrop"
      onMouseDown={props.onCancel}
      role="presentation"
    >
      <div
        aria-label="模型阵列"
        aria-modal="true"
        className="hierarchy-array-dialog"
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
      >
        <h3>模型阵列</h3>
        <label className="hierarchy-array-dialog-row">
          <span>副本数量</span>
          <input
            autoFocus
            min={1}
            max={MODEL_ARRAY_COPY_COUNT_MAX}
            onChange={(event) => props.onChange({ ...props.value, copyCount: Number(event.target.value) })}
            disabled={props.readOnly}
            type="number"
            value={props.value.copyCount}
          />
        </label>
        <label className="hierarchy-array-dialog-row">
          <span>方向</span>
          {props.directionLabel ? (
            <input aria-label="阵列方向" readOnly type="text" value={props.directionLabel} />
          ) : (
            <select
              disabled={props.readOnly}
              onChange={(event) => props.onChange({
                ...props.value,
                direction: event.target.value as EntityArrayDirection,
              })}
              value={props.value.direction}
            >
              <option value="x">+X</option>
              <option value="-x">-X</option>
              <option value="y">+Y</option>
              <option value="-y">-Y</option>
              <option value="z">+Z</option>
              <option value="-z">-Z</option>
            </select>
          )}
        </label>
        <label className="hierarchy-array-dialog-row">
          <span>阵列净间距(m)</span>
          <input
            min={0}
            onChange={(event) => props.onChange({ ...props.value, spacingMeters: Number(event.target.value) })}
            disabled={props.readOnly}
            step={0.1}
            type="number"
            value={props.value.spacingMeters}
          />
        </label>
        <label className="hierarchy-array-dialog-row">
          <span>资产编号规则</span>
          <input
            aria-describedby="hierarchy-array-number-rule-help"
            aria-invalid={Boolean(error)}
            disabled={!canEditAssetNumberRule}
            maxLength={ARRAY_ASSET_NUMBER_MAX_LENGTH}
            onChange={(event) => props.onChange({ ...props.value, assetNumberRule: event.target.value })}
            placeholder="${1}-1-1"
            type="text"
            value={props.value.assetNumberRule}
          />
        </label>
        {props.assetNumberedSourceCount === 1 ? (
          <p className="hierarchy-array-dialog-hint" id="hierarchy-array-number-rule-help">
            可选；规则只影响新副本资产编号。名称末尾数字递增，无数字时追加序号，不添加“副本”。
          </p>
        ) : (
          <p className="hierarchy-array-dialog-hint" id="hierarchy-array-number-rule-help">
            {props.assetNumberedSourceCount === 0
              ? '当前选区没有资产编号字段，将只执行空间阵列。'
              : '多个带编号对象将按各自原编号递增，不能使用同一自定义规则。'}
          </p>
        )}
        {error ? <p className="hierarchy-array-dialog-error">{error}</p> : null}
        <div className="hierarchy-array-dialog-actions">
          <button onClick={props.onCancel} type="button">取消</button>
          <button
            className="primary"
            disabled={Boolean(props.readOnly || error)}
            onClick={props.onConfirm}
            type="button"
          >
            确认
          </button>
        </div>
      </div>
    </div>
  );
}
