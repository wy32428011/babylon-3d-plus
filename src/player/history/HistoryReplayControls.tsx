import { memo, useCallback, useId, useMemo, useRef, useState } from 'react';
import type { CSSProperties, FormEvent, SyntheticEvent } from 'react';
import { HISTORY_REPLAY_SPEEDS } from '../../runtime/history/historyReplayContract';
import type {
  HistoryCoverageGap,
  HistoryReplaySpeed,
  HistoryReplayUiStatus,
  HistoryTimeRange,
  HistoryTimelineEvent,
  HistoryVersionBoundary,
} from '../../runtime/history/historyReplayContract';
import { HistoryReplayTimeline } from './HistoryReplayTimeline';
import './historyReplayControls.css';

export type HistoryReplayControlsProps = {
  range: HistoryTimeRange;
  /** 最后成功呈现的 UTC 毫秒时间；首次加载前为 null。 */
  currentTime: number | null;
  /** 尚未提交到画面的定位目标，不能用它替换 currentTime。 */
  pendingTime?: number | null;
  status: HistoryReplayUiStatus;
  speed: HistoryReplaySpeed;
  sourceName: string;
  versionLabel: string | null;
  /** Intl.DateTimeFormat 支持的时区，例如 Asia/Shanghai；不使用浏览器本地时区替代。 */
  timeZone: string;
  events: readonly HistoryTimelineEvent[];
  eventsKnown?: boolean;
  gaps: readonly HistoryCoverageGap[];
  versionBoundaries: readonly HistoryVersionBoundary[];
  sourceQuality?: string | null;
  errorMessage?: string | null;
  showRetry?: boolean;
  /** 阻断入口可重新加载，但不能启用回放或时间轴。 */
  retryWhenDisabled?: boolean;
  disabledReason?: string | null;
  /** 尚无可信实时版本/续传能力时禁止把失败伪装成返回实时。 */
  canReturnLive?: boolean;
  /** 实时续传或尚无新会话全态时，不允许将旧画面当作可推进的历史。 */
  canAdvance?: boolean;
  canSeekHistory?: boolean;
  liveMode?: boolean;
  awaitingRange?: boolean;
  nextAvailableTime?: number | null;
  onPlayPause: () => void;
  /** 宿主暂停逻辑时钟并记住此前播放状态。 */
  onScrubStart: () => void;
  /** 未提交的指针/键盘交互取消后，宿主恢复此前播放状态。 */
  onScrubCancel: () => void;
  /** 宿主校验覆盖与版本，仅最新定位成功后更新事实时间并恢复先前播放状态。 */
  onSeek: (time: number) => void;
  onSpeedChange: (speed: HistoryReplaySpeed) => void;
  onRangeChange: (range: HistoryTimeRange) => void;
  /** 宿主完成实时全态握手后才退出历史模式；控件不会提前隐藏历史标识。 */
  onReturnLive: () => void;
  onRetry: () => void;
  className?: string;
  style?: CSSProperties;
};

const STATUS_LABELS: Record<HistoryReplayUiStatus, string> = {
  live: '实时模式', loading: '加载历史中', paused: '已暂停', playing: '播放中',
  seeking: '正在定位', buffering: '缓冲中', ended: '已结束', gap: '数据缺口',
  error: '加载失败', empty: '无历史数据', 'returning-live': '正在返回实时',
};

function isTime(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000;
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  return `${String(Math.floor(seconds / 3_600)).padStart(2, '0')}:${String(Math.floor(seconds % 3_600 / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function stopSceneEvent(event: SyntheticEvent): void {
  event.stopPropagation();
}

type IconName = 'history' | 'play' | 'pause' | 'left' | 'right' | 'calendar' | 'chevron' | 'live';
const ICON_PATHS: Record<IconName, string> = {
  history: 'M3 11a9 9 0 1 1 3 7M3 5v6h6M12 7v6l4 2',
  play: 'm8 5 11 7-11 7Z', pause: 'M8 5v14M16 5v14',
  left: 'm14 6-6 6 6 6', right: 'm10 6 6 6-6 6',
  calendar: 'M4 5h16v16H4ZM8 3v4M16 3v4M4 10h16', chevron: 'm7 10 5 5 5-5',
  live: 'M7.7 7.7a6 6 0 0 0 0 8.6M16.3 7.7a6 6 0 0 1 0 8.6M4.9 4.9a10 10 0 0 0 0 14.2M19.1 4.9a10 10 0 0 1 0 14.2M12 11v2',
};
function ReplayIcon({ name }: { name: IconName }) {
  return <svg className="history-replay-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d={ICON_PATHS[name]} fill={name === 'play' ? 'currentColor' : 'none'} /></svg>;
}

function inputValue(time: number, formatter: Intl.DateTimeFormat): string {
  if (!isTime(time)) return '';
  const values: Record<string, string> = {};
  for (const part of formatter.formatToParts(time)) values[part.type] = part.value;
  return `${values.year.padStart(4, '0')}-${values.month}-${values.day}T${values.hour}:${values.minute}:${values.second}`;
}

function wallTime(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/u.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute, second = '00'] = match;
  const parts = [year, month, day, hour, minute, second].map(Number);
  const date = new Date(0);
  date.setUTCFullYear(parts[0], parts[1] - 1, parts[2]);
  date.setUTCHours(parts[3], parts[4], parts[5], 0);
  if (date.getUTCFullYear() !== parts[0] || date.getUTCMonth() !== parts[1] - 1 || date.getUTCDate() !== parts[2]
    || date.getUTCHours() !== parts[3] || date.getUTCMinutes() !== parts[4] || date.getUTCSeconds() !== parts[5]) return null;
  return date.getTime();
}

/** datetime-local 没有时区语义，必须按显示时区反解；夏令时跳空/重复不能静默偏移。 */
function parseInput(value: string, formatter: Intl.DateTimeFormat, original: number): number {
  const wall = wallTime(value);
  if (wall === null) throw new Error('请输入有效的日期和时间。');
  const canonical = value.length === 16 ? `${value}:00` : value;
  // 未修改的边界保留原始毫秒及原有夏令时偏移，不因打开表单而改写范围。
  if (isTime(original) && inputValue(original, formatter) === canonical) return original;
  const offsets = new Set<number>();
  for (let hours = -48; hours <= 48; hours += 6) {
    const probe = wall + hours * 3_600_000;
    if (!isTime(probe)) continue;
    const projected = wallTime(inputValue(probe, formatter));
    if (projected !== null) offsets.add(projected - probe);
  }
  const matches = [...offsets].map((offset) => wall - offset).filter((candidate) => isTime(candidate) && inputValue(candidate, formatter) === canonical);
  if (matches.length === 0) throw new Error('该时区不存在这个时刻，或超出支持的时间范围，请重新选择。');
  if (matches.length > 1) throw new Error('该时刻因夏令时回拨出现两次，请选择过渡区间之外的边界，再通过时间轴精确定位。');
  return matches[0];
}

type RangeEditorProps = {
  range: HistoryTimeRange;
  timeZone: string;
  formatter: Intl.DateTimeFormat;
  disabled: boolean;
  onApply: (range: HistoryTimeRange) => void;
  onCancel: () => void;
};

const RangeEditor = memo(function RangeEditor({ range, timeZone, formatter, disabled, onApply, onCancel }: RangeEditorProps) {
  const id = useId();
  const [from, setFrom] = useState(() => range.to > range.from ? inputValue(range.from, formatter) : '');
  const [to, setTo] = useState(() => range.to > range.from ? inputValue(range.to, formatter) : '');
  const [error, setError] = useState<string | null>(null);

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (disabled) return;
    let next: HistoryTimeRange;
    try {
      next = { from: parseInput(from, formatter, range.from), to: parseInput(to, formatter, range.to) };
      if (next.to <= next.from) throw new Error('结束时间必须晚于开始时间。');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '时间范围无效。');
      return;
    }
    setError(null);
    onApply(next);
  }

  return (
    <form className="history-replay-range-editor" aria-label="选择回放时间范围" onSubmit={submit} onKeyDown={(event) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onCancel(); }
    }}>
      <p id={`${id}-help`}>时区 {timeZone}。仅在应用后切换范围，输入草稿不改变当前回放。</p>
      <div className="history-replay-range-fields">
        <label htmlFor={`${id}-from`}>开始时间<input autoFocus id={`${id}-from`} type="datetime-local" step="1" required value={from} disabled={disabled} aria-describedby={`${id}-help${error ? ` ${id}-error` : ''}`} aria-invalid={Boolean(error)} onChange={(event) => { setFrom(event.target.value); setError(null); }} /></label>
        <label htmlFor={`${id}-to`}>结束时间<input id={`${id}-to`} type="datetime-local" step="1" required value={to} disabled={disabled} aria-describedby={`${id}-help${error ? ` ${id}-error` : ''}`} aria-invalid={Boolean(error)} onChange={(event) => { setTo(event.target.value); setError(null); }} /></label>
      </div>
      {error ? <p id={`${id}-error`} className="history-replay-field-error" role="alert">{error}</p> : null}
      <div className="history-replay-range-actions"><button type="button" onClick={onCancel}>取消</button><button className="history-replay-primary" type="submit" disabled={disabled}>应用范围</button></div>
    </form>
  );
});

/** 独立受控播放面板；不订阅业务数据、不推进时钟、不更改来源或场景版本。 */
export const HistoryReplayControls = memo(function HistoryReplayControls({
  range, currentTime, pendingTime = null, status, speed, sourceName, versionLabel, timeZone,
  events, eventsKnown = true, gaps, versionBoundaries, sourceQuality, errorMessage, showRetry = false, retryWhenDisabled = false, disabledReason,
  canReturnLive = true, canAdvance = true, canSeekHistory = true, liveMode = false, awaitingRange = false, nextAvailableTime,
  onPlayPause, onScrubStart, onScrubCancel, onSeek, onSpeedChange, onRangeChange,
  onReturnLive, onRetry, className, style,
}: HistoryReplayControlsProps) {
  const id = useId();
  const rangeButton = useRef<HTMLButtonElement>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [rangeEditing, setRangeEditing] = useState(false);
  const [scrubbing, setScrubbing] = useState(false);
  const validRange = isTime(range.from) && isTime(range.to) && range.to > range.from;
  const formats = useMemo(() => {
    try {
      const common: Intl.DateTimeFormatOptions = { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' };
      return {
        full: new Intl.DateTimeFormat('zh-CN', { ...common, timeZoneName: 'shortOffset' }),
        clock: new Intl.DateTimeFormat('zh-CN', { timeZone, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }),
        input: new Intl.DateTimeFormat('en-CA-u-ca-iso8601-nu-latn', common),
      };
    } catch {
      return null;
    }
  }, [timeZone]);
  const format = (time: number) => formats?.full.format(time) ?? '时区不可用';
  const invalidReason = disabledReason || (!formats ? `无法识别显示时区 ${timeZone || '（未提供）'}，未使用本机时区替代。` : null);
  const returningLive = status === 'returning-live';
  const isPlaying = status === 'playing' || status === 'buffering' && !liveMode;
  const statusLabel = awaitingRange ? '待选择范围' : STATUS_LABELS[status];
  const canChangeRange = !invalidReason && !returningLive;
  const canSeek = canSeekHistory && validRange && !invalidReason && !['live', 'loading', 'empty', 'returning-live'].includes(status);
  const canPlay = canAdvance && validRange && isTime(currentTime) && !invalidReason && !scrubbing && ['paused', 'playing', 'buffering', 'ended'].includes(status);
  const navigationTime = isTime(pendingTime) ? pendingTime : isTime(currentTime) ? currentTime : range.from;
  const sortedEvents = useMemo(() => events.filter((event) => isTime(event.time) && event.time >= range.from && event.time <= range.to).sort((a, b) => a.time - b.time), [events, range.from, range.to]);
  let previousEvent: HistoryTimelineEvent | undefined;
  let nextEvent: HistoryTimelineEvent | undefined;
  for (const event of sortedEvents) {
    if (event.time < navigationTime) previousEvent = event;
    else if (event.time > navigationTime) { nextEvent = event; break; }
  }
  const nextIsAvailable = isTime(nextAvailableTime) && nextAvailableTime >= range.from && nextAvailableTime <= range.to
    && !gaps.some((gap) => nextAvailableTime >= gap.from && nextAvailableTime < gap.to);
  const factInRange = isTime(currentTime) && currentTime >= range.from && currentTime <= range.to;
  const timeText = isTime(currentTime) && formats ? formats.clock.format(currentTime) : '--:--:--';
  const dateText = isTime(currentTime) && formats ? inputValue(currentTime, formats.input).slice(0, 10) : '尚未呈现';
  const rangeText = validRange && formats ? `${inputValue(range.from, formats.input).replace('T', ' ')} — ${inputValue(range.to, formats.input).replace('T', ' ')}` : '选择回放时间范围';
  const playLabel = isPlaying ? '暂停' : status === 'ended' ? '重新播放' : '播放';
  const banner = invalidReason || errorMessage
    || (awaitingRange ? '请选择回放时间范围，尚未读取历史。' : null)
    || (liveMode ? status === 'buffering' ? '实时投影正在同步，选择时间范围可载入历史。' : '当前处于实时模式。选择时间范围后载入历史。' : null)
    || (!validRange ? '请选择有效的回放时间范围。' : null) || ({
    live: '当前处于实时模式。选择时间范围后载入历史。',
    loading: '正在读取历史范围和初始状态，尚未完成呈现。',
    seeking: '正在恢复目标时刻，当前已呈现时间保持不变。',
    buffering: '历史数据正在缓冲，暂未达到所选播放倍速。',
    ended: '已到达所选范围末尾，仍保持历史只读模式。',
    gap: '该段没有完整历史，保留最后有效画面，不自动跨越缺口。',
    error: '历史加载或恢复失败，保留有效状态。请重试或调整时间范围。',
    empty: '当前范围内没有可回放历史，请调整时间范围。',
    'returning-live': '正在同步实时全态，完成前仍保持历史只读模式。',
    paused: '', playing: '',
  } satisfies Record<HistoryReplayUiStatus, string>)[status];

  const handleScrubStart = useCallback(() => { setScrubbing(true); onScrubStart(); }, [onScrubStart]);
  const handleScrubCancel = useCallback(() => { setScrubbing(false); onScrubCancel(); }, [onScrubCancel]);
  const handleSeek = useCallback((time: number) => {
    setScrubbing(false);
    onSeek(time);
  }, [onSeek]);
  const closeRange = useCallback(() => { setRangeEditing(false); rangeButton.current?.focus({ preventScroll: true }); }, []);
  const applyRange = useCallback((next: HistoryTimeRange) => { setRangeEditing(false); onRangeChange(next); rangeButton.current?.focus({ preventScroll: true }); }, [onRangeChange]);
  const openRange = () => { setCollapsed(false); setRangeEditing(true); };

  return (
    <section
      className={`history-replay-controls${className ? ` ${className}` : ''}`}
      style={style}
      data-collapsed={collapsed}
      data-status={status}
      aria-label="时光回溯播放器"
      onPointerDown={stopSceneEvent} onPointerUp={stopSceneEvent} onPointerMove={stopSceneEvent} onPointerCancel={stopSceneEvent}
      onMouseDown={stopSceneEvent} onMouseUp={stopSceneEvent} onMouseMove={stopSceneEvent}
      onTouchStart={stopSceneEvent} onTouchMove={stopSceneEvent} onTouchEnd={stopSceneEvent} onTouchCancel={stopSceneEvent}
      onClick={stopSceneEvent} onDoubleClick={stopSceneEvent} onContextMenu={stopSceneEvent}
      onWheel={stopSceneEvent} onKeyDown={stopSceneEvent} onKeyUp={stopSceneEvent}
    >
      <header className="history-replay-header">
        <h2 className="history-replay-title"><ReplayIcon name="history" />时光回溯</h2>
        {!collapsed ? <button ref={rangeButton} type="button" className="history-replay-range-button" aria-expanded={rangeEditing} aria-controls={`${id}-range`} disabled={!canChangeRange} onClick={() => setRangeEditing((open) => !open)} title={`${rangeText} · ${timeZone}`}><ReplayIcon name="calendar" /><span>{rangeText}</span><ReplayIcon name="chevron" /></button> : null}
        {collapsed ? (
          <>
            <span className="history-replay-compact-time" title={isTime(currentTime) ? format(currentTime) : '尚未呈现历史画面'}><span>{liveMode ? '实时' : '历史'} · {dateText}</span><span>{timeText} · {timeZone}</span></span>
            <span className="history-replay-state" data-status={status} role="status">{statusLabel}</span>
            <button type="button" className="history-replay-compact-play" onClick={onPlayPause} disabled={!canPlay} aria-label={playLabel}>{playLabel}</button>
            <button type="button" className="history-replay-return" onClick={onReturnLive} disabled={returningLive || status === 'live' || !canReturnLive}>{returningLive ? '返回中…' : '返回实时'}</button>
          </>
        ) : null}
        <button type="button" className="history-replay-collapse" aria-expanded={!collapsed} aria-controls={collapsed ? undefined : `${id}-body`} onClick={() => { setCollapsed((value) => !value); setRangeEditing(false); }}>{collapsed ? '展开' : '收起'}<ReplayIcon name="chevron" /></button>
      </header>
      {!collapsed ? (
        <>
          <div id={`${id}-body`} className="history-replay-body">
            <div id={`${id}-range`}>
              {rangeEditing && formats ? <RangeEditor key={`${range.from}:${range.to}:${timeZone}`} range={range} timeZone={timeZone} formatter={formats.input} disabled={!canChangeRange} onApply={applyRange} onCancel={closeRange} /> : null}
            </div>
            <div className="history-replay-current-row">
              <span className="history-replay-clock-label">当前已呈现<span>{dateText}</span></span>
              <time className="history-replay-clock" dateTime={isTime(currentTime) ? new Date(currentTime).toISOString() : undefined}>{timeText}</time>
              <span className="history-replay-timezone">{timeZone || '时区未提供'}</span>
              <span className="history-replay-state" data-status={status} role="status">{statusLabel}</span>
              <dl className="history-replay-meta"><div><dt>数据源</dt><dd title={sourceName}>{sourceName || '未提供来源'}</dd></div><div><dt>{liveMode ? '当前版本' : '历史版本'}</dt><dd title={versionLabel ?? undefined}>{versionLabel ?? '尚未确定'}</dd></div></dl>
            </div>
            <HistoryReplayTimeline range={range} currentTime={currentTime} pendingTime={pendingTime} timeZone={timeZone} events={events} eventsKnown={eventsKnown} gaps={gaps} versionBoundaries={versionBoundaries} disabled={!canSeek} onScrubStart={handleScrubStart} onScrubCancel={handleScrubCancel} onSeek={handleSeek} />
            {banner ? (
              <div className="history-replay-status-line" data-error={Boolean(errorMessage || invalidReason || status === 'error')} role={errorMessage || invalidReason || status === 'error' ? 'alert' : 'status'}>
                <span>{banner}</span>
                {(status === 'error' || showRetry) && (!invalidReason || retryWhenDisabled) ? <button type="button" onClick={onRetry}>重试</button> : null}
                {status === 'gap' && nextIsAvailable && canSeek ? <button type="button" onClick={() => handleSeek(nextAvailableTime)} title={format(nextAvailableTime)}>跳至下一可用时刻</button> : null}
                {(status === 'empty' || status === 'error' || status === 'gap' && !nextIsAvailable) && canChangeRange ? <button type="button" onClick={openRange}>调整时间范围</button> : null}
              </div>
            ) : null}
          </div>
          <footer className="history-replay-footer">
            <div className="history-replay-transport" role="group" aria-label="回放操作">
              <button type="button" className="history-replay-jump" disabled={!canSeek || scrubbing || navigationTime <= range.from} aria-label="后退 10 秒" title="后退 10 秒" onClick={() => handleSeek(Math.max(range.from, navigationTime - 10_000))}><ReplayIcon name="left" />10s</button>
              <button type="button" className="history-replay-primary history-replay-play" disabled={!canPlay} onClick={onPlayPause} aria-label={playLabel}><ReplayIcon name={isPlaying ? 'pause' : 'play'} />{playLabel}</button>
              <button type="button" className="history-replay-jump" disabled={!canSeek || scrubbing || navigationTime >= range.to} aria-label="前进 10 秒" title="前进 10 秒" onClick={() => handleSeek(Math.min(range.to, navigationTime + 10_000))}>10s<ReplayIcon name="right" /></button>
              <label className="history-replay-speed">倍速<select value={speed} aria-label="回放倍速" disabled={Boolean(invalidReason) || returningLive || scrubbing || liveMode || status === 'live'} onChange={(event) => onSpeedChange(Number(event.target.value) as HistoryReplaySpeed)}>{HISTORY_REPLAY_SPEEDS.map((rate) => <option key={rate} value={rate}>{rate}×</option>)}</select></label>
              <span className="history-replay-elapsed" aria-label={`已播 ${factInRange ? formatDuration(currentTime - range.from) : '尚未呈现'}，总时长 ${validRange ? formatDuration(range.to - range.from) : '未知'}`}><b>{factInRange ? formatDuration(currentTime - range.from) : '--:--:--'}</b> / {validRange ? formatDuration(range.to - range.from) : '--:--:--'}</span>
              <button type="button" className="history-replay-event-nav" disabled={!canSeek || scrubbing || !previousEvent} title={previousEvent ? `${previousEvent.label} · ${format(previousEvent.time)}` : eventsKnown ? '没有上一关键事件' : '关键事件未完整获取'} onClick={() => { if (previousEvent) handleSeek(previousEvent.time); }} aria-label="上一关键事件">上一事件</button>
              <button type="button" className="history-replay-event-nav" disabled={!canSeek || scrubbing || !nextEvent} title={nextEvent ? `${nextEvent.label} · ${format(nextEvent.time)}` : eventsKnown ? '没有下一关键事件' : '关键事件未完整获取'} onClick={() => { if (nextEvent) handleSeek(nextEvent.time); }} aria-label="下一关键事件">下一事件</button>
              <button type="button" className="history-replay-return" onClick={onReturnLive} disabled={returningLive || status === 'live' || !canReturnLive}><ReplayIcon name="live" />{returningLive ? '正在返回实时…' : '返回实时'}</button>
            </div>
            <div className="history-replay-legend" aria-label="时间轴图例">
              <span><i className="history-replay-alarm-key" aria-hidden="true">△</i>告警</span><span><i aria-hidden="true">◇</i>货物交接</span><span><i aria-hidden="true">○</i>库存变更</span><span><i aria-hidden="true">□</i>生命周期</span><span><i aria-hidden="true">·</i>其他事件</span><span><i className="history-replay-gap-key" aria-hidden="true" />数据缺口</span><span><i className="history-replay-version-key" aria-hidden="true" />版本边界</span>
              {sourceQuality ? <span className="history-replay-quality">来源质量：{sourceQuality}</span> : null}
              <span className="history-replay-readonly">{liveMode ? '实时投影 · 只读' : '只读回放 · 暂停不锁相机'}</span>
            </div>
          </footer>
        </>
      ) : null}
    </section>
  );
});
