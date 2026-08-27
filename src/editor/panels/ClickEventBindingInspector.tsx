import { useState, type DragEvent, type ReactElement } from 'react';
import {
  decodeModelAssetDragPayload,
  MODEL_ASSET_DRAG_MIME_TYPE,
} from '../assets/AssetDatabase';
import type {
  ClickEventBindingComponent,
  ClickEventBindingDeviceSlot,
  ClickEventBindingEffect,
  ClickEventBindingEventType,
} from '../model/components';
import {
  CLICK_EVENT_BINDING_MAX_DEVICE_TYPES,
  createClickEventBindingDeviceTypeFromAsset,
} from '../model/clickEventBinding';
import { useEditorStore } from '../store/editorStore';
import { createId } from '../../shared/ids';

type ClickEventBindingInspectorProps = {
  component: ClickEventBindingComponent;
  disabled?: boolean;
};

const EFFECT_OPTIONS: readonly { value: ClickEventBindingEffect; label: string }[] = [
  { value: 'highlight', label: '高亮' },
  { value: 'focus', label: '聚焦动画' },
];

/** 判断拖拽事件是否包含模型库可用于设备类型槽位的载荷；内置基础网格没有模型包来源，不接受。 */
function hasDeviceTypePayload(event: DragEvent<HTMLElement>): boolean {
  return event.dataTransfer.types.includes(MODEL_ASSET_DRAG_MIME_TYPE);
}

/** 从模型库拖拽数据读取设备类型条目，只接受普通模型。 */
function readDeviceTypeFromDrop(event: DragEvent<HTMLElement>): ClickEventBindingDeviceSlot['deviceType'] {
  const modelPayload = event.dataTransfer.getData(MODEL_ASSET_DRAG_MIME_TYPE);
  const modelAsset = modelPayload ? decodeModelAssetDragPayload(modelPayload) : null;
  if (modelAsset?.libraryKind !== 'model') return null;
  return createClickEventBindingDeviceTypeFromAsset(modelAsset);
}

/** 渲染并编辑点击事件绑定；仅在运行预览态生效，命中的设备按勾选效果执行高亮与相机聚焦。 */
export function ClickEventBindingInspector({ component, disabled = false }: ClickEventBindingInspectorProps) {
  const updateSelectedClickEventBinding = useEditorStore((state) => state.updateSelectedClickEventBinding);
  const [activeDropZone, setActiveDropZone] = useState<string | null>(null);

  /** 提交完整不可变组件，由 Store 统一校验并写入撤销历史。 */
  function commitComponent(nextComponent: ClickEventBindingComponent, label: string): void {
    if (disabled) return;
    updateSelectedClickEventBinding(nextComponent, label);
  }

  /** 追加一个待配置空槽，由后续模型库拖放补齐。 */
  function addSlot(): void {
    if (component.deviceSlots.length >= CLICK_EVENT_BINDING_MAX_DEVICE_TYPES) return;
    const slot: ClickEventBindingDeviceSlot = {
      id: createId('click_event_slot'),
      deviceType: null,
    };
    commitComponent({ ...component, deviceSlots: [...component.deviceSlots, slot] }, '添加设备类型');
  }

  /** 删除指定设备类型槽位。 */
  function removeSlot(index: number): void {
    commitComponent(
      { ...component, deviceSlots: component.deviceSlots.filter((_, slotIndex) => slotIndex !== index) },
      '删除设备类型',
    );
  }

  /** 更新指定槽位的设备类型配置。 */
  function updateSlotDeviceType(index: number, deviceType: ClickEventBindingDeviceSlot['deviceType'], label: string): void {
    const deviceSlots = component.deviceSlots.map((slot, slotIndex) => (
      slotIndex === index ? { ...slot, deviceType } : slot
    ));
    commitComponent({ ...component, deviceSlots }, label);
  }

  /** 接收模型库拖放并填充对应槽位。 */
  function handleSlotDrop(event: DragEvent<HTMLDivElement>, index: number): void {
    if (disabled || !hasDeviceTypePayload(event)) return;
    event.preventDefault();
    event.stopPropagation();
    setActiveDropZone(null);

    const deviceType = readDeviceTypeFromDrop(event);
    if (deviceType) updateSlotDeviceType(index, deviceType, '配置设备类型');
  }

  /** 拖拽离开槽位整体时移除高亮，子节点之间移动不会误清理。 */
  function handleSlotDragLeave(event: DragEvent<HTMLDivElement>, dropZoneId: string): void {
    const relatedTarget = event.relatedTarget;
    if (relatedTarget instanceof Node && event.currentTarget.contains(relatedTarget)) return;
    if (activeDropZone === dropZoneId) setActiveDropZone(null);
  }

  /** 更新事件类型。 */
  function handleEventTypeChange(eventType: ClickEventBindingEventType): void {
    commitComponent({ ...component, eventType }, '更新事件类型');
  }

  /** 切换事件效果勾选状态。 */
  function toggleEffect(effect: ClickEventBindingEffect, checked: boolean): void {
    const effects = checked
      ? [...component.effects, effect]
      : component.effects.filter((item) => item !== effect);
    commitComponent({ ...component, effects }, '更新事件效果');
  }

  /** 渲染可接收模型库卡片的设备类型槽位。 */
  function renderDeviceSlot(slot: ClickEventBindingDeviceSlot, index: number): ReactElement {
    const dropZoneId = 'click-event-device-' + slot.id;
    const className = activeDropZone === dropZoneId
      ? 'model-generator-target-slot model-generator-target-slot-active'
      : 'model-generator-target-slot';
    const deviceType = slot.deviceType;

    return (
      <div className="click-event-binding-device-row" key={slot.id}>
        <div
          className={className}
          onDragEnter={(event) => {
            if (disabled || !hasDeviceTypePayload(event)) return;
            event.preventDefault();
            setActiveDropZone(dropZoneId);
          }}
          onDragLeave={(event) => handleSlotDragLeave(event, dropZoneId)}
          onDragOver={(event) => {
            if (disabled || !hasDeviceTypePayload(event)) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = 'copy';
            setActiveDropZone(dropZoneId);
          }}
          onDrop={(event) => handleSlotDrop(event, index)}
          title={deviceType ? deviceType.sourcePath : '从模型库拖入模型'}
        >
          {deviceType ? (
            <>
              <span className="model-generator-target-preview" aria-hidden="true">
                {deviceType.thumbnailUrl ? (
                  <img alt="" src={deviceType.thumbnailUrl} />
                ) : (
                  <span>Model</span>
                )}
              </span>
              <span className="model-generator-target-text">
                <strong>{deviceType.displayName}</strong>
                <small>{deviceType.sourcePath}</small>
              </span>
              <button
                aria-label={'清空设备类型 ' + deviceType.displayName}
                className="model-generator-clear-button"
                disabled={disabled}
                onClick={() => updateSlotDeviceType(index, null, '清空设备类型')}
                title="清空该单元"
                type="button"
              >
                ×
              </button>
            </>
          ) : (
            <span className="model-generator-target-empty">从模型库拖入模型</span>
          )}
        </div>
        <button
          aria-label={'删除设备类型 ' + (index + 1)}
          className="model-generator-clear-button"
          disabled={disabled}
          onClick={() => removeSlot(index)}
          title="删除该单元"
          type="button"
        >
          −
        </button>
      </div>
    );
  }

  return (
    <fieldset className="transform-fieldset model-generator-fieldset">
      <legend>点击事件绑定</legend>

      <p className="muted">仅在运行预览时生效；运行态点击列表中设备类型的任意实例时，对该设备执行勾选的效果。</p>

      <div className="model-generator-section-header">
        <span>设备类型</span>
        <button
          disabled={disabled || component.deviceSlots.length >= CLICK_EVENT_BINDING_MAX_DEVICE_TYPES}
          onClick={addSlot}
          title="添加设备类型"
          type="button"
        >
          +
        </button>
      </div>

      {component.deviceSlots.length === 0 ? (
        <p className="muted model-generator-empty-hint">暂无设备类型；点击 + 添加单元，再从模型库拖入模型。</p>
      ) : null}

      {component.deviceSlots.map((slot, index) => renderDeviceSlot(slot, index))}

      <div className="model-generator-section-header">
        <span>事件绑定</span>
      </div>

      <label className="inspector-row">
        <span>事件类型</span>
        <select
          disabled={disabled}
          value={component.eventType}
          onChange={(event) => handleEventTypeChange(event.target.value as ClickEventBindingEventType)}
        >
          <option value="click">点击</option>
          <option value="click-cell" disabled>点击单元（后续版本）</option>
        </select>
      </label>

      <div className="inspector-row">
        <span>事件效果</span>
        <span className="click-event-binding-effects">
          {EFFECT_OPTIONS.map((option) => (
            <label className="click-event-binding-effect-option" key={option.value}>
              <input
                checked={component.effects.includes(option.value)}
                disabled={disabled}
                onChange={(event) => toggleEffect(option.value, event.target.checked)}
                type="checkbox"
              />
              <span>{option.label}</span>
            </label>
          ))}
        </span>
      </div>
    </fieldset>
  );
}
