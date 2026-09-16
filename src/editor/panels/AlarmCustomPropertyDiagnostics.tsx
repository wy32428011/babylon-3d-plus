import { useEffect, useMemo, useState } from 'react';
import { getAlarmCustomPropertyDiagnostic, resolveAlarmDeviceBinding, resolveAlarmTargets, type AlarmCustomPropertyStatus, type AlarmManagerComponent } from '../model/alarmManager';
import { useEditorStore } from '../store/editorStore';
import { deviceTelemetryStore } from '../../runtime/mqtt/deviceTelemetry';

const PAGE_SIZE = 10;
const STATUS_TEXT: Record<AlarmCustomPropertyStatus, string> = {
  disabled: '设备绑定已禁用', unbound: '未绑定：缺少资产编号或设备类型', unconfigured: '请填写火警属性 p',
  waiting: '等待设备数据', stale: '数据已过期，不能确认是否恢复', missing: '本帧未找到该属性或 v 缺失',
  invalid: 'v 类型不支持，请使用数值、字符串或布尔值', matched: '自定义条件命中', unmatched: '自定义条件未命中',
};

function formatValue(value: unknown): string {
  if (value === undefined) return '—';
  if (value === null) return 'null';
  if (Array.isArray(value)) return '数组（不支持）';
  if (typeof value === 'object') return '对象（不支持）';
  if (typeof value === 'string') return JSON.stringify(value.length > 160 ? value.slice(0, 160) + '…' : value);
  return String(value);
}

/** 诊断仅保存在组件内；分页且仅展开运行时刷新，避免高频 MQTT 重绘整个 Inspector。 */
export function AlarmCustomPropertyDiagnostics({ config }: { config: AlarmManagerComponent }) {
  const scene = useEditorStore(state => state.scene);
  const sessionId = useEditorStore(state => state.sceneSessionId);
  const running = useEditorStore(state => state.runtimeMode === 'preview');
  const targets = useMemo(() => resolveAlarmTargets(scene, config), [scene, config]);
  const [open, setOpen] = useState(true);
  const [page, setPage] = useState(0);
  const [now, setNow] = useState(Date.now);
  const pages = Math.max(1, Math.ceil(targets.length / PAGE_SIZE));
  const currentPage = Math.min(page, pages - 1);
  useEffect(() => setPage(0), [sessionId, config.targets, config.targetType]);
  useEffect(() => {
    setNow(Date.now());
    if (!open || !running || targets.length === 0) return;
    // 即使没有新消息也需要更新超时状态，不能只订阅消息到达事件。
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [open, running, sessionId, targets.length]);

  return <details className="alarm-property-diagnostics" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>MQTT 点位诊断（{targets.length} 台设备）</summary>
    {open ? <>
      <p className="muted">{running ? '当前值只读，不会改写触发值。这里只显示数据条件；报警效果还取决于目标可见性。' : '进入运行预览后查看实时值；编辑态仍可手动填写 p 和触发值。'}</p>
      {targets.length === 0 ? <p className="muted">暂无可监控设备，请在目标槽位选择模型或场景设备。</p> : null}
      {targets.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE).map(target => {
        const binding = resolveAlarmDeviceBinding(target);
        const snapshot = running && binding.assetCode && binding.deviceType
          ? deviceTelemetryStore.getSnapshot(binding.assetCode, binding.deviceType, binding.sourceId) : null;
        const diagnostic = getAlarmCustomPropertyDiagnostic(config, target, snapshot, now);
        return <section className="alarm-property-device" key={target.id} aria-label={'设备诊断：' + target.name}>
          <strong>{target.name}</strong>
          <div className="muted">资产编号：{binding.assetCode || '未配置'} · 设备类型：{binding.deviceType || '未配置'} · 数据源：{binding.sourceId}</div>
          <div>属性 p：<code>{config.customProperty || '未配置'}</code></div>
          <div>当前 v：<code>{formatValue(diagnostic.value)}</code> · 触发值：<code>{formatValue(config.customValue)}</code></div>
          <div data-alarm-property-status={diagnostic.status}>{STATUS_TEXT[diagnostic.status]}</div>
          {diagnostic.trigger ? <div>报警条件：{diagnostic.trigger === 'warehouse' ? '仓库告警优先' : '火警'}</div> : null}
          <div className="muted">最后接收：{snapshot ? new Date(snapshot.receivedAt).toLocaleString() : '—'}</div>
        </section>;
      })}
      {pages > 1 ? <div className="alarm-property-pagination">
        <button type="button" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>上一页</button>
        <span>{currentPage + 1} / {pages}</span>
        <button type="button" disabled={currentPage + 1 >= pages} onClick={() => setPage(currentPage + 1)}>下一页</button>
      </div> : null}
      <p className="muted">按整帧消息判断。点位缺失或数据过期时不保持报警效果，但不代表设备已确认恢复；增量上报需保证每帧携带火警点位。</p>
    </> : null}
  </details>;
}
