import { memo, useEffect, useEffectEvent, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent, SyntheticEvent } from 'react';
import type {
  HistoryCoverageGap,
  HistoryTimeRange,
  HistoryTimelineEvent,
  HistoryVersionBoundary,
} from '../../runtime/history/historyReplayContract';
import './historyReplayControls.css';

export type HistoryReplayTimelineProps = {
  range: HistoryTimeRange;
  /** 最后成功呈现的事实时间，不随拖动预览改变。时间单位均为 UTC 毫秒。 */
  currentTime: number | null;
  pendingTime?: number | null;
  timeZone: string;
  events: readonly HistoryTimelineEvent[];
  /** 未加载或查询失败时不能将空数组解释为没有事件。 */
  eventsKnown?: boolean;
  gaps: readonly HistoryCoverageGap[];
  versionBoundaries: readonly HistoryVersionBoundary[];
  disabled?: boolean;
  onScrubStart: () => void;
  /** 取消预览，不发起定位；宿主恢复拖动前的播放状态。 */
  onScrubCancel: () => void;
  /** 仅提交用户目标，覆盖完整性和跨版本校验由历史会话负责。 */
  onSeek: (time: number) => void;
};

const EVENT_SYMBOLS: Record<HistoryTimelineEvent['kind'], { symbol: string; label: string }> = {
  alarm: { symbol: '△', label: '告警' },
  transfer: { symbol: '◇', label: '货物交接' },
  stock: { symbol: '○', label: '库存变更' },
  lifecycle: { symbol: '□', label: '生命周期' },
  other: { symbol: '·', label: '其他事件' },
};
const SEEK_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End']);
const TICK_FRACTIONS = [0, 0.25, 0.5, 0.75, 1] as const;

function isTime(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000;
}

function position(time: number, range: HistoryTimeRange): number {
  return Math.max(0, Math.min(100, (time - range.from) / (range.to - range.from) * 100));
}

function gapAt(time: number, gaps: readonly HistoryCoverageGap[]): HistoryCoverageGap | undefined {
  return gaps.find((gap) => time >= gap.from && time < gap.to);
}

function stopSceneEvent(event: SyntheticEvent): void {
  event.stopPropagation();
}

type TimelineMarksProps = Pick<HistoryReplayTimelineProps, 'events' | 'gaps' | 'versionBoundaries' | 'disabled' | 'onSeek'> & {
  from: number;
  to: number;
  formatter: Intl.DateTimeFormat;
};

/** 概览标记不依赖播放游标，避免时钟更新或指针移动时重建整组事件节点。 */
const TimelineMarks = memo(function TimelineMarks({ from, to, events, gaps, versionBoundaries, disabled, formatter, onSeek }: TimelineMarksProps) {
  const range = { from, to };
  return (
    <>
      {gaps.map((gap, index) => (
        <span
          key={`${gap.from}:${gap.to}:${index}`}
          className="history-replay-gap"
          role="img"
          aria-label={`数据缺口：${formatter.format(gap.from)}至${formatter.format(gap.to)}，${gap.reason}`}
          style={{ left: `${position(gap.from, range)}%`, width: `${position(gap.to, range) - position(gap.from, range)}%` }}
        />
      ))}
      {versionBoundaries.map((boundary, index) => (
        <span
          key={`${boundary.time}:${index}`}
          className="history-replay-version-mark"
          role="img"
          aria-label={`版本边界：${formatter.format(boundary.time)}，${boundary.versionLabel}`}
          title={`${formatter.format(boundary.time)} · ${boundary.versionLabel}`}
          style={{ left: `${position(boundary.time, range)}%` }}
        >
          <span>{boundary.versionLabel}</span>
        </span>
      ))}
      <div className="history-replay-event-marks" aria-label="关键事件定位">
        {events.map((event) => {
          const kind = EVENT_SYMBOLS[event.kind];
          const label = `${kind.label}：${event.label}，${formatter.format(event.time)}`;
          return (
            <button
              key={event.id}
              type="button"
              className="history-replay-event-mark"
              data-kind={event.kind}
              style={{ left: `${position(event.time, range)}%` }}
              title={label}
              aria-label={`定位到${label}`}
              disabled={disabled}
              onClick={() => onSeek(event.time)}
            >
              <span aria-hidden="true">{kind.symbol}</span>
            </button>
          );
        })}
      </div>
    </>
  );
});

type ScrubSession = {
  kind: 'pointer' | 'keyboard';
  pointerId?: number;
  element: HTMLDivElement;
  target: number;
  keys: Set<string>;
};

/** 受控时间轴：本地只保存交互目标，真实时间和定位结果始终由父层提供。 */
export const HistoryReplayTimeline = memo(function HistoryReplayTimeline({
  range, currentTime, pendingTime = null, timeZone, events, eventsKnown = true, gaps, versionBoundaries,
  disabled = false, onScrubStart, onScrubCancel, onSeek,
}: HistoryReplayTimelineProps) {
  const hintId = useId();
  const session = useRef<ScrubSession | null>(null);
  const [draftTime, setDraftTime] = useState<number | null>(null);
  const [hoverTime, setHoverTime] = useState<number | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const validRange = isTime(range.from) && isTime(range.to) && range.to > range.from;
  const formats = useMemo(() => {
    try {
      return {
        full: new Intl.DateTimeFormat('zh-CN', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'shortOffset' }),
        tick: new Intl.DateTimeFormat('zh-CN', { timeZone, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }),
        date: new Intl.DateTimeFormat('zh-CN', { timeZone, month: '2-digit', day: '2-digit' }),
      };
    } catch {
      return null;
    }
  }, [timeZone]);
  const unavailable = disabled || !validRange || !formats;
  const visibleEvents = useMemo(() => events.filter((event) => isTime(event.time) && event.time >= range.from && event.time <= range.to).sort((a, b) => a.time - b.time), [events, range.from, range.to]);
  const visibleGaps = useMemo(() => gaps.filter((gap) => isTime(gap.from) && isTime(gap.to) && gap.to > gap.from && gap.to > range.from && gap.from < range.to), [gaps, range.from, range.to]);
  const visibleBoundaries = useMemo(() => versionBoundaries.filter((boundary) => isTime(boundary.time) && boundary.time >= range.from && boundary.time <= range.to), [versionBoundaries, range.from, range.to]);
  const ticks = useMemo(() => validRange && formats ? TICK_FRACTIONS.map((fraction) => {
    const time = Math.round(range.from + (range.to - range.from) * fraction);
    return { time, text: formats.tick.format(time), date: formats.date.format(time) };
  }) : [], [range.from, range.to, validRange, formats]);
  const format = (time: number) => formats?.full.format(time) ?? '时区不可用';
  const factInRange = isTime(currentTime) && currentTime >= range.from && currentTime <= range.to;
  const targetTime = draftTime ?? (isTime(pendingTime) ? pendingTime : null);
  const targetGap = targetTime === null ? undefined : gapAt(targetTime, visibleGaps);
  const hoverGap = hoverTime === null ? undefined : gapAt(hoverTime, visibleGaps);
  const sliderTime = validRange ? Math.max(range.from, Math.min(range.to, targetTime ?? (isTime(currentTime) ? currentTime : range.from))) : 0;
  const factText = isTime(currentTime) ? `当前已呈现 ${format(currentTime)}` : '尚未呈现历史画面';
  const previewText = targetTime !== null
    ? `${draftTime !== null ? '拖动目标' : '定位目标'} ${format(targetTime)}${targetGap ? ` · 数据缺口：${targetGap.reason}，不可定位，不会自动跳过` : draftTime !== null ? ' · 松开后定位，Esc 取消' : ' · 等待呈现，当前事实时间不变'}`
    : '拖动时间轴定位；方向键按秒，Shift 按 10 秒，Page Up / Down 按分钟，Home / End 到边界，Esc 取消。';

  function releaseSession(): ScrubSession | null {
    const previous = session.current;
    session.current = null;
    if (previous?.pointerId !== undefined && previous.element.hasPointerCapture(previous.pointerId)) {
      previous.element.releasePointerCapture(previous.pointerId);
    }
    return previous;
  }

  function cancelScrub(): void {
    const previous = releaseSession();
    setDraftTime(null);
    setHoverTime(null);
    if (previous) onScrubCancel();
  }

  // 范围/时区变更、禁用和卸载均取消未提交交互，不遗留全局事件或暂停状态。
  const cancelForLifecycle = useEffectEvent(cancelScrub);
  useEffect(() => () => cancelForLifecycle(), [range.from, range.to, timeZone, unavailable]);

  function pointerTime(event: PointerEvent<HTMLDivElement>): number {
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = rect.width > 0 ? Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) : 0;
    return Math.round(range.from + ratio * (range.to - range.from));
  }

  function commitScrub(time: number): void {
    if (!releaseSession()) return;
    setDraftTime(null);
    setHoverTime(null);
    // 不在控件内将缺口目标改写为下一可用时间，服务端校验结果由父层显式展示。
    onSeek(time);
  }

  function handlePointerDown(event: PointerEvent<HTMLDivElement>): void {
    event.stopPropagation();
    if (unavailable || event.button !== 0 || !event.isPrimary || session.current) return;
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    const target = pointerTime(event);
    session.current = { kind: 'pointer', pointerId: event.pointerId, element: event.currentTarget, target, keys: new Set() };
    setDraftTime(target);
    setHoverTime(null);
    onScrubStart();
  }

  function handlePointerMove(event: PointerEvent<HTMLDivElement>): void {
    event.stopPropagation();
    if (!validRange || !formats) return;
    const active = session.current;
    if (active?.kind === 'pointer' && active.pointerId === event.pointerId) {
      active.target = pointerTime(event);
      setDraftTime(active.target);
    } else if (!active && event.pointerType !== 'touch') {
      setHoverTime(pointerTime(event));
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      cancelScrub();
      return;
    }
    if (event.key === 'Enter' && session.current?.kind === 'keyboard') {
      event.preventDefault();
      commitScrub(session.current.target);
      return;
    }
    if (unavailable || !SEEK_KEYS.has(event.key) || session.current?.kind === 'pointer') return;
    event.preventDefault();
    if (!session.current) {
      session.current = { kind: 'keyboard', element: event.currentTarget, target: sliderTime, keys: new Set() };
      onScrubStart();
    }
    const active = session.current;
    const step = event.shiftKey ? 10_000 : 1_000;
    const delta = event.key === 'PageUp' ? 60_000 : event.key === 'PageDown' ? -60_000
      : event.key === 'ArrowRight' || event.key === 'ArrowUp' ? step : -step;
    const next = event.key === 'Home' ? range.from : event.key === 'End' ? range.to : active.target + delta;
    active.target = Math.max(range.from, Math.min(range.to, next));
    active.keys.add(event.key);
    setDraftTime(active.target);
  }

  return (
    <div className="history-replay-timeline"
      onPointerDown={stopSceneEvent} onPointerUp={stopSceneEvent} onPointerMove={stopSceneEvent} onPointerCancel={stopSceneEvent}
      onMouseDown={stopSceneEvent} onMouseUp={stopSceneEvent} onMouseMove={stopSceneEvent}
      onTouchStart={stopSceneEvent} onTouchMove={stopSceneEvent} onTouchEnd={stopSceneEvent} onTouchCancel={stopSceneEvent}
      onClick={stopSceneEvent} onDoubleClick={stopSceneEvent} onContextMenu={stopSceneEvent}
      onWheel={stopSceneEvent} onKeyDown={stopSceneEvent} onKeyUp={stopSceneEvent}
    >
      <p id={hintId} className="history-replay-preview" data-warning={Boolean(targetGap)}>{previewText}</p>
      <div className="history-replay-chart">
        {validRange && formats ? <TimelineMarks from={range.from} to={range.to} events={visibleEvents} gaps={visibleGaps} versionBoundaries={visibleBoundaries} disabled={Boolean(unavailable)} formatter={formats.full} onSeek={onSeek} /> : null}
        <div
          className="history-replay-track"
          role="slider"
          tabIndex={unavailable ? -1 : 0}
          aria-label="历史回放定位时间"
          aria-orientation="horizontal"
          aria-disabled={Boolean(unavailable)}
          aria-valuemin={0}
          aria-valuemax={validRange ? 10_000 : 0}
          aria-valuenow={validRange ? Math.round(position(sliderTime, range) * 100) : 0}
          aria-valuetext={`${factText}${targetTime !== null ? `；${previewText}` : ''}`}
          aria-describedby={hintId}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerLeave={() => setHoverTime(null)}
          onPointerUp={(event) => {
            event.stopPropagation();
            if (session.current?.kind === 'pointer' && session.current.pointerId === event.pointerId) commitScrub(pointerTime(event));
          }}
          onPointerCancel={(event) => { if (session.current?.pointerId === event.pointerId) cancelScrub(); }}
          onLostPointerCapture={(event) => { if (session.current?.pointerId === event.pointerId) cancelScrub(); }}
          onKeyDown={handleKeyDown}
          onKeyUp={(event) => {
            event.stopPropagation();
            const active = session.current;
            if (active?.kind !== 'keyboard' || !active.keys.delete(event.key)) return;
            event.preventDefault();
            if (active.keys.size === 0) commitScrub(active.target);
          }}
          onBlur={cancelScrub}
        >
          <span className="history-replay-rail" aria-hidden="true"><span style={{ width: `${factInRange ? position(currentTime, range) : 0}%` }} /></span>
          {factInRange ? <span className="history-replay-fact-cursor" aria-hidden="true" style={{ left: `${position(currentTime, range)}%` }} /> : null}
          {targetTime !== null && validRange ? <span className="history-replay-target-cursor" aria-hidden="true" style={{ left: `${position(targetTime, range)}%` }} /> : null}
          {hoverTime !== null && validRange ? (
            <>
              <span className="history-replay-hover-cursor" aria-hidden="true" style={{ left: `${position(hoverTime, range)}%` }} />
              <span className="history-replay-hover" aria-hidden="true">
                {format(hoverTime)}{hoverGap ? <span>数据缺口：{hoverGap.reason}</span> : null}
              </span>
            </>
          ) : null}
        </div>
        <div className="history-replay-ticks" aria-hidden="true">
          {ticks.map((tick, index) => <span key={index} style={{ left: `${TICK_FRACTIONS[index] * 100}%` }} title={format(tick.time)}>{range.to - range.from >= 86_400_000 ? <span>{tick.date}</span> : null}{tick.text}</span>)}
        </div>
      </div>
      <details className="history-replay-details" onToggle={(event) => setDetailsOpen(event.currentTarget.open)}>
        <summary>事件与覆盖详情（{eventsKnown ? `${visibleEvents.length} 个事件` : '事件未完整获取'}，{visibleGaps.length} 处缺口，{visibleBoundaries.length} 个版本边界）</summary>
        {detailsOpen && formats ? (
          <ul>
            {visibleEvents.map((event) => <li key={event.id}><button type="button" disabled={Boolean(unavailable)} onClick={() => onSeek(event.time)}><span aria-hidden="true">{EVENT_SYMBOLS[event.kind].symbol}</span> {format(event.time)} · {EVENT_SYMBOLS[event.kind].label} · {event.label}</button></li>)}
            {visibleGaps.map((gap, index) => <li key={`gap:${index}`}>数据缺口：{format(gap.from)} 至 {format(gap.to)} · {gap.reason}</li>)}
            {visibleBoundaries.map((boundary, index) => <li key={`version:${index}`}>版本边界：{format(boundary.time)} · {boundary.versionLabel}</li>)}
            {!eventsKnown ? <li>关键事件未完整获取；已显示的结果仅覆盖可读取区间，不能据此判断其他区间没有事件。</li> : null}
            {eventsKnown && visibleEvents.length + visibleGaps.length + visibleBoundaries.length === 0 ? <li>该范围内没有返回事件或覆盖标记；不代表已证明历史完整。</li> : null}
          </ul>
        ) : null}
      </details>
    </div>
  );
});
