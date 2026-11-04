import type { Entity } from '../model/Entity';
import type { ChartMarkerClickAction, ChartMarkerClickEvent } from '../model/components';
import { getChartMarkerClickEvents, parseChartMarkerSceneUrl, CHART_MARKER_SCENE_URL_MAX_LENGTH, CHART_MARKER_MAX_CLICK_EVENTS as MAX_EVENTS, CHART_MARKER_MAX_CLICK_ACTIONS as MAX_ACTIONS } from '../model/chartMarker';
import { useEditorStore } from '../store/editorStore';
import { SearchableSelect } from '../ui/SearchableSelect';
import { ChartMarkerThemeScreenSlot } from './ChartMarkerThemeScreenSlot';

const actionOptions = <>
  <option value="none">无</option>
  <option value="focus">对象聚焦</option>
  <option value="theme">主题展示</option>
  <option value="select">选中物体</option>
  <option value="refresh">刷新内容</option>
  <option value="scene-switch">场景切换</option>
</>;

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

  function changeActionType(eventIndex: number, actionIndex: number | null, type: string): void {
    const actions = events[eventIndex].actions;
    if (type === 'none') {
      if (actionIndex !== null) updateActions(eventIndex, actions.filter((_, index) => index !== actionIndex));
      return;
    }
    const current = actionIndex === null ? undefined : actions[actionIndex];
    let next: ChartMarkerClickAction;
    if (type === 'theme' || type === 'refresh') next = { type };
    else if (type === 'scene-switch') next = { type, url: '', target: 'same-window' };
    else if (type === 'focus' || type === 'select') {
      next = { type, targetEntityId: current?.type === 'focus' || current?.type === 'select' ? current.targetEntityId : entity.id };
    } else return;
    if (actionIndex === null) updateActions(eventIndex, [...actions, next]);
    else updateAction(eventIndex, actionIndex, next);
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
          {event.actions.length === 0 ? (
            <label className="inspector-row">
              <span>动作类型</span>
              <select aria-label={'点击事件 ' + (eventIndex + 1) + ' 动作类型'} value="none" onChange={(change) => changeActionType(eventIndex, null, change.target.value)}>
                {actionOptions}
              </select>
            </label>
          ) : null}
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
                  <select aria-label={label + ' 类型'} value={action.type} onChange={(change) => changeActionType(eventIndex, actionIndex, change.target.value)}>
                    {actionOptions}
                  </select>
                </label>
                {action.type === 'scene-switch' ? (
                  <>
                    <label className="inspector-row chart-marker-scene-url">
                      <span>场景发布地址</span>
                      <input type="url" aria-label={label + ' 场景发布地址'} value={action.url} maxLength={CHART_MARKER_SCENE_URL_MAX_LENGTH}
                        placeholder="https://..." onChange={(change) => updateAction(eventIndex, actionIndex, { ...action, url: change.target.value })} />
                    </label>
                    {!action.url.trim() ? <p className="muted">请输入完整的场景发布地址。</p> : !parseChartMarkerSceneUrl(action.url) ? <p className="chart-marker-error">请输入不含账号密码的完整 HTTP(S) 地址。</p> : null}
                    <label className="inspector-row">
                      <span>切换方式</span>
                      <select aria-label={label + ' 切换方式'} value={action.target} onChange={(change) => updateAction(eventIndex, actionIndex, { ...action, target: change.target.value === 'new-window' ? 'new-window' : 'same-window' })}>
                        <option value="same-window">本窗口</option>
                        <option value="new-window">新窗口</option>
                      </select>
                    </label>
                  </>
                ) : action.type === 'theme' ? (
                  <ChartMarkerThemeScreenSlot key={entity.id} label={label} disabled={disabled} screen={action.screen}
                    onChange={(screen) => updateAction(eventIndex, actionIndex, screen ? { type: 'theme', screen } : { type: 'theme' })} />
                ) : action.type === 'focus' || action.type === 'select' ? (
                  <>
                    <label className="inspector-row">
                      <span>目标对象</span>
                      <span className="chart-marker-target-control">
                        <SearchableSelect
                          ariaLabel={label + ' 目标对象'}
                          missingLabel={(value) => `目标已失效（${value}）`}
                          options={[{ value: '', label: '请选择目标对象' }, ...targets.map((target) => ({ value: target.id, label: `${target.name || target.id}（实体）` }))]}
                          value={action.targetEntityId}
                          onChange={(value) => updateAction(eventIndex, actionIndex, { ...action, targetEntityId: value })}
                        />
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
        <button type="button" aria-label="添加点击事件" disabled={events.length >= MAX_EVENTS} onClick={() => commit([...events, { type: 'left-click', actions: [] }])}>+ 添加事件</button>
        {events.length >= MAX_EVENTS ? <span className="muted">最多 {MAX_EVENTS} 个事件</span> : null}
      </div>
      <p className="muted">运行预览或 Viewer 中点击立标触发动作；网页和视频内容保持独立交互，环形网页或视频从上下边缘触发场景切换。</p>
    </fieldset>
  );
}
