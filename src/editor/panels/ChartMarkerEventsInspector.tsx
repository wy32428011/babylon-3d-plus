import type { Entity } from '../model/Entity';
import type { ChartMarkerClickAction, ChartMarkerClickEvent } from '../model/components';
import { getChartMarkerClickEvents, CHART_MARKER_MAX_CLICK_EVENTS as MAX_EVENTS, CHART_MARKER_MAX_CLICK_ACTIONS as MAX_ACTIONS } from '../model/chartMarker';
import { useEditorStore } from '../store/editorStore';
import { ChartMarkerThemeScreenSlot } from './ChartMarkerThemeScreenSlot';

export function ChartMarkerEventsInspector({ entity, disabled }: { entity: Entity; disabled: boolean }) {
  const entities = useEditorStore((state) => state.scene.entities);
  const update = useEditorStore((state) => state.updateChartMarker);
  const events = getChartMarkerClickEvents(entity.components.chartMarker ?? {}, entity.id);
  const targets = Object.values(entities).filter((item) => !item.isFolder);
  const targetIds = new Set(targets.map((target) => target.id));

  function commit(next: ChartMarkerClickEvent[]): void {
    if (!disabled) update(entity.id, { clickEvents: next, clickAction: 'none' });
  }

  function updateActions(eventIndex: number, actions: ChartMarkerClickAction[]): void {
    commit(events.map((event, index) => index === eventIndex ? { ...event, actions } : event));
  }

  function updateAction(eventIndex: number, actionIndex: number, next: ChartMarkerClickAction): void {
    updateActions(eventIndex, events[eventIndex].actions.map((action, index) => index === actionIndex ? next : action));
  }

  return (
    <fieldset className="transform-fieldset chart-marker-fieldset chart-marker-events" disabled={disabled}>
      <legend>点击事件</legend>
      <div className="chart-marker-list-heading">事件列表</div>
      {events.length === 0 ? <p className="muted">暂无点击事件，点击“添加事件”进行配置。</p> : null}
      {events.map((event, eventIndex) => (
        <div className="chart-marker-event" key={eventIndex} role="group" aria-label={'点击事件 ' + (eventIndex + 1)}>
          <div className="chart-marker-event-heading">
            <span>事件 {eventIndex + 1}</span>
            <button type="button" aria-label={'删除点击事件 ' + (eventIndex + 1)} onClick={() => commit(events.filter((_, index) => index !== eventIndex))}>− 删除事件</button>
          </div>
          <label className="inspector-row">
            <span>事件类型</span>
            <select aria-label={'点击事件 ' + (eventIndex + 1) + ' 类型'} defaultValue={event.type}>
              <option value="left-click">鼠标左键点击</option>
            </select>
          </label>
          <div className="chart-marker-list-heading">动作</div>
          {event.actions.length === 0 ? <p className="muted">暂无动作。</p> : null}
          {event.actions.map((action, actionIndex) => {
            const label = '点击事件 ' + (eventIndex + 1) + ' 动作 ' + (actionIndex + 1);
            const missingTarget = (action.type === 'focus' || action.type === 'select') && action.targetEntityId !== '' && !targetIds.has(action.targetEntityId);
            return (
              <div className="chart-marker-event-action" key={actionIndex} role="group" aria-label={label}>
                <div className="chart-marker-event-heading">
                  <span>动作 {actionIndex + 1}</span>
                  <button type="button" aria-label={'删除' + label} onClick={() => updateActions(eventIndex, event.actions.filter((_, index) => index !== actionIndex))}>−</button>
                </div>
                <label className="inspector-row">
                  <span>动作类型</span>
                  <select aria-label={label + ' 类型'} value={action.type} onChange={(change) => {
                    const type = change.target.value as ChartMarkerClickAction['type'];
                    if (type === 'theme' || type === 'refresh') {
                      updateAction(eventIndex, actionIndex, { type });
                    } else {
                      updateAction(eventIndex, actionIndex, {
                        type,
                        targetEntityId: action.type === 'focus' || action.type === 'select' ? action.targetEntityId : entity.id,
                      });
                    }
                  }}>
                    <option value="focus">对象聚焦</option>
                    <option value="theme">主题展示</option>
                    <option value="select">选中物体</option>
                    <option value="refresh">刷新内容</option>
                  </select>
                </label>
                {action.type === 'theme' ? (
                  <ChartMarkerThemeScreenSlot key={entity.id} label={label} disabled={disabled} screen={action.screen}
                    onChange={(screen) => updateAction(eventIndex, actionIndex, screen ? { type: 'theme', screen } : { type: 'theme' })} />
                ) : action.type === 'focus' || action.type === 'select' ? (
                  <>
                    <label className="inspector-row">
                      <span>目标对象</span>
                      <span className="chart-marker-target-control">
                        <select aria-label={label + ' 目标对象'} value={action.targetEntityId} onChange={(change) => updateAction(eventIndex, actionIndex, { ...action, targetEntityId: change.target.value })}>
                          <option value="">请选择目标对象</option>
                          {missingTarget ? <option value={action.targetEntityId}>目标已失效（{action.targetEntityId}）</option> : null}
                          {targets.map((target) => <option key={target.id} value={target.id}>{target.name || target.id}（实体）</option>)}
                        </select>
                        <button type="button" title="清空目标对象" aria-label={'清空' + label + ' 目标对象'} disabled={!action.targetEntityId} onClick={() => updateAction(eventIndex, actionIndex, { ...action, targetEntityId: '' })}>×</button>
                      </span>
                    </label>
                    {missingTarget ? <p className="chart-marker-error">目标对象已删除或不可用，请重新选择。</p> : !action.targetEntityId ? <p className="muted">请选择目标对象，未设置目标时跳过此动作。</p> : null}
                  </>
                ) : null}
              </div>
            );
          })}
          <div className="chart-marker-actions">
            <button type="button" aria-label={'点击事件 ' + (eventIndex + 1) + ' 添加动作'} disabled={event.actions.length >= MAX_ACTIONS} onClick={() => updateActions(eventIndex, [...event.actions, { type: 'focus', targetEntityId: entity.id }])}>+ 添加动作</button>
            {event.actions.length >= MAX_ACTIONS ? <span className="muted">最多 {MAX_ACTIONS} 个动作</span> : null}
          </div>
        </div>
      ))}
      <div className="chart-marker-actions">
        <button type="button" aria-label="添加点击事件" disabled={events.length >= MAX_EVENTS} onClick={() => commit([...events, { type: 'left-click', actions: [{ type: 'focus', targetEntityId: entity.id }] }])}>+ 添加事件</button>
        {events.length >= MAX_EVENTS ? <span className="muted">最多 {MAX_EVENTS} 个事件</span> : null}
      </div>
      <p className="muted">运行预览或 Viewer 中，左键点击内置面板或“执行事件”按钮，按列表顺序执行动作。</p>
    </fieldset>
  );
}
