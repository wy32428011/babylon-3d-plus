import { useState, type DragEvent, type ReactElement } from 'react';
import {
  decodeModelAssetDragPayload,
  MODEL_ASSET_DRAG_MIME_TYPE,
} from '../assets/AssetDatabase';
import {
  DATA_PLATFORM_SCREEN_ASSET_DRAG_MIME_TYPE,
  decodeDataPlatformScreenDragPayload,
} from '../assets/dataPlatformScreenDrag';
import type {
  ClickEventBindingComponent,
  ClickEventBindingDeviceSlot,
  ClickEventBindingEffect,
  ClickEventBindingEvent,
  ClickEventBindingEventType,
} from '../model/components';
import {
  CLICK_EVENT_BINDING_MAX_DEVICE_TYPES,
  CLICK_EVENT_BINDING_MAX_EVENTS,
  createClickEventBindingDeviceTypeFromAsset,
  createClickEventBindingEvent,
} from '../model/clickEventBinding';
import { useEditorStore } from '../store/editorStore';
import { createId } from '../../shared/ids';

type ClickEventBindingInspectorProps = {
  component: ClickEventBindingComponent;
  disabled?: boolean;
};

const EFFECT_OPTIONS: readonly { value: ClickEventBindingEffect; label: string }[] = [
  { value: 'highlight', label: '高亮选中' },
  { value: 'focus', label: '聚焦动画' },
  { value: 'show-chart', label: '展示图表' },
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

/** 判断拖拽事件是否包含图表库可用于 show-chart 效果参数的载荷。 */
function hasChartPayload(event: DragEvent<HTMLElement>): boolean {
  return event.dataTransfer.types.includes(DATA_PLATFORM_SCREEN_ASSET_DRAG_MIME_TYPE);
}

/** 从图表库拖拽数据读取图表条目，只接受大屏类型。 */
function readChartFromDrop(event: DragEvent<HTMLElement>): ClickEventBindingEvent['chart'] | null {
  const payload = event.dataTransfer.getData(DATA_PLATFORM_SCREEN_ASSET_DRAG_MIME_TYPE);
  const chartEntry = payload ? decodeDataPlatformScreenDragPayload(payload) : null;
  if (!chartEntry) return null;
  return {
    id: chartEntry.id,
    name: chartEntry.name,
    ...(chartEntry.thumbnailUrl ? { thumbnailUrl: chartEntry.thumbnailUrl } : {}),
  };
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

  /** 追加一条事件（默认点击 + 高亮）。 */
  function addBindingEvent(): void {
    if (component.events.length >= CLICK_EVENT_BINDING_MAX_EVENTS) return;
    commitComponent({ ...component, events: [...component.events, createClickEventBindingEvent()] }, '添加事件');
  }

  /** 删除整条事件。 */
  function removeBindingEvent(eventIndex: number): void {
    commitComponent(
      { ...component, events: component.events.filter((_, index) => index !== eventIndex) },
      '删除事件',
    );
  }

  /** 更新指定事件，label 进入撤销历史。 */
  function updateBindingEvent(eventIndex: number, nextEvent: ClickEventBindingEvent, label: string): void {
    const events = component.events.map((item, index) => (index === eventIndex ? nextEvent : item));
    commitComponent({ ...component, events }, label);
  }

  /** 为事件追加一个尚未启用的效果类型。 */
  function addEffect(eventIndex: number): void {
    const bindingEvent = component.events[eventIndex];
    if (!bindingEvent) return;
    const nextEffect = EFFECT_OPTIONS.find((option) => !bindingEvent.effects.includes(option.value));
    if (!nextEffect) return;
    updateBindingEvent(eventIndex, { ...bindingEvent, effects: [...bindingEvent.effects, nextEffect.value] }, '添加事件效果');
  }

  /** 删除事件中的一条效果；移除 show-chart 时同步清空其图表参数。 */
  function removeEffect(eventIndex: number, effectIndex: number): void {
    const bindingEvent = component.events[eventIndex];
    if (!bindingEvent) return;
    const nextEvent: ClickEventBindingEvent = {
      ...bindingEvent,
      effects: bindingEvent.effects.filter((_, index) => index !== effectIndex),
    };
    if (!nextEvent.effects.includes('show-chart')) delete nextEvent.chart;
    updateBindingEvent(eventIndex, nextEvent, '删除事件效果');
  }

  /** 更新事件中的效果类型；show-chart 被改走时同步清空图表参数。 */
  function changeEffect(eventIndex: number, effectIndex: number, nextEffect: ClickEventBindingEffect): void {
    const bindingEvent = component.events[eventIndex];
    if (!bindingEvent) return;
    const nextEvent: ClickEventBindingEvent = {
      ...bindingEvent,
      effects: bindingEvent.effects.map((item, index) => (index === effectIndex ? nextEffect : item)),
    };
    if (!nextEvent.effects.includes('show-chart')) delete nextEvent.chart;
    updateBindingEvent(eventIndex, nextEvent, '更新事件效果');
  }

  /** 配置或清空 show-chart 效果的图表参数。 */
  function updateEventChart(eventIndex: number, chart: ClickEventBindingEvent['chart'] | null, label: string): void {
    const bindingEvent = component.events[eventIndex];
    if (!bindingEvent) return;
    const nextEvent: ClickEventBindingEvent = { ...bindingEvent };
    if (chart) {
      nextEvent.chart = chart;
    } else {
      delete nextEvent.chart;
    }
    updateBindingEvent(eventIndex, nextEvent, label);
  }

  /** 接收图表库拖放并填充 show-chart 图表参数。 */
  function handleChartDrop(event: DragEvent<HTMLDivElement>, eventIndex: number): void {
    if (disabled || !hasChartPayload(event)) return;
    event.preventDefault();
    event.stopPropagation();
    setActiveDropZone(null);

    const chart = readChartFromDrop(event);
    if (chart) updateEventChart(eventIndex, chart, '配置展示图表');
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
                <small>项目模型</small>
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

  /** 渲染 show-chart 效果的图表参数槽位，可接收图表库大屏卡片拖放。 */
  function renderChartSlot(bindingEvent: ClickEventBindingEvent, eventIndex: number): ReactElement {
    const dropZoneId = 'click-event-chart-' + bindingEvent.id;
    const className = activeDropZone === dropZoneId
      ? 'model-generator-target-slot model-generator-target-slot-active'
      : 'model-generator-target-slot';
    const chart = bindingEvent.chart;

    return (
      <div
        className={className}
        onDragEnter={(event) => {
          if (disabled || !hasChartPayload(event)) return;
          event.preventDefault();
          setActiveDropZone(dropZoneId);
        }}
        onDragLeave={(event) => handleSlotDragLeave(event, dropZoneId)}
        onDragOver={(event) => {
          if (disabled || !hasChartPayload(event)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'copy';
          setActiveDropZone(dropZoneId);
        }}
        onDrop={(event) => handleChartDrop(event, eventIndex)}
        title={chart ? '图表id：' + chart.id : '从图表库拖入大屏'}
      >
        {chart ? (
          <>
            <span className="model-generator-target-preview" aria-hidden="true">
              {chart.thumbnailUrl ? (
                <img alt="" src={chart.thumbnailUrl} />
              ) : (
                <span>Chart</span>
              )}
            </span>
            <span className="model-generator-target-text">
              <strong>{chart.name}</strong>
              <small>数据中台大屏</small>
            </span>
            <button
              aria-label={'清空展示图表 ' + chart.name}
              className="model-generator-clear-button"
              disabled={disabled}
              onClick={() => updateEventChart(eventIndex, null, '清空展示图表')}
              title="清空展示图表"
              type="button"
            >
              ×
            </button>
          </>
        ) : (
          <span className="model-generator-target-empty">从图表库拖入大屏</span>
        )}
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
        <span>事件列表</span>
        <button
          disabled={disabled || component.events.length >= CLICK_EVENT_BINDING_MAX_EVENTS}
          onClick={addBindingEvent}
          title="添加事件"
          type="button"
        >
          +
        </button>
      </div>

      {component.events.length === 0 ? (
        <p className="muted model-generator-empty-hint">暂无事件；点击 + 添加事件。</p>
      ) : null}

      {component.events.map((bindingEvent, eventIndex) => (
        <div className="click-event-binding-event-card" key={bindingEvent.id}>
          <div className="model-generator-section-header">
            <span>事件 {eventIndex + 1}</span>
            <button
              aria-label={'删除事件 ' + (eventIndex + 1)}
              className="model-generator-clear-button"
              disabled={disabled}
              onClick={() => removeBindingEvent(eventIndex)}
              title="删除该事件"
              type="button"
            >
              −
            </button>
          </div>

          <label className="inspector-row">
            <span>事件类型</span>
            <select
              disabled={disabled}
              value={bindingEvent.eventType}
              onChange={(event) => updateBindingEvent(
                eventIndex,
                { ...bindingEvent, eventType: event.target.value as ClickEventBindingEventType },
                '更新事件类型',
              )}
            >
              <option value="click">点击</option>
              <option value="click-cell">点击单元</option>
            </select>
          </label>

          <div className="inspector-row">
            <span>事件效果</span>
          </div>

          {bindingEvent.effects.map((effect, effectIndex) => (
            <div className="click-event-binding-effect-row" key={effect}>
              <select
                aria-label={'事件 ' + (eventIndex + 1) + ' 效果 ' + (effectIndex + 1)}
                disabled={disabled}
                value={effect}
                onChange={(changeEvent) => changeEffect(
                  eventIndex,
                  effectIndex,
                  changeEvent.target.value as ClickEventBindingEffect,
                )}
              >
                {EFFECT_OPTIONS.map((option) => (
                  <option
                    disabled={option.value !== effect && bindingEvent.effects.includes(option.value)}
                    key={option.value}
                    value={option.value}
                  >
                    {option.label}
                  </option>
                ))}
              </select>
              <button
                aria-label={'删除效果 ' + (EFFECT_OPTIONS.find((option) => option.value === effect)?.label ?? effect)}
                className="model-generator-clear-button"
                disabled={disabled}
                onClick={() => removeEffect(eventIndex, effectIndex)}
                title="删除该效果"
                type="button"
              >
                ×
              </button>
            </div>
          ))}

          {bindingEvent.effects.includes('show-chart') ? (
            <>
              <div className="inspector-row">
                <span>图表参数</span>
              </div>
              {renderChartSlot(bindingEvent, eventIndex)}
            </>
          ) : null}

          <button
            className="click-event-binding-add-effect"
            disabled={disabled || bindingEvent.effects.length >= EFFECT_OPTIONS.length}
            onClick={() => addEffect(eventIndex)}
            type="button"
          >
            + 添加效果
          </button>
        </div>
      ))}
    </fieldset>
  );
}
