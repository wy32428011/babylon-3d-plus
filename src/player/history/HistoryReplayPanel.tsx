import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { HistoryReplaySpeed, HistoryReplayUiStatus, HistoryTimeRange, HistoryTimelineEvent } from '../../runtime/history/historyReplayContract';
import { HistoryReplayControls } from './HistoryReplayControls';
import type { HistoryCoverageResponse, HistoryReadIdentity } from './historyReadContract';
import { HistoryReadServiceError } from './historyReadClient';
import { HistoryReadSession, isRenewableHistorySessionError, type HistorySessionSnapshot } from './HistoryReadSession';

const NO_RANGE: HistoryTimeRange = { from: 0, to: 0 };
const EMPTY_SNAPSHOT: HistorySessionSnapshot = { status: 'error', currentTime: null, pendingTime: null, blockedTime: null, cursor: null, coverage: null, error: null, mode: null, publishedVersionId: null, canAdvance: false, readOnly: true };
const noopSubscribe = () => () => {};
const emptySnapshot = () => EMPTY_SNAPSHOT;
const EMPTY_EVENTS: HistoryTimelineEvent[] = [];
// 查询服务的页数/字节是会话总预算，不能按显示刷新率发起网络窗口。
const PLAYBACK_QUERY_INTERVAL_MS = 500;

function firstAvailableAtOrAfter(coverage: HistoryCoverageResponse, start: number): number | null {
  let target = start;
  for (const gap of [...coverage.gaps].sort((a, b) => a.from - b.from || a.to - b.to)) {
    if (gap.from > target) break;
    if (target < gap.to) target = gap.to;
  }
  if (target < coverage.range.from || target > coverage.range.to || target > coverage.queryableThrough
    || coverage.versionBoundaries.some(boundary => boundary.time > coverage.range.from && boundary.time <= target)) return null;
  return target;
}

function eventRanges(coverage: HistoryCoverageResponse): HistoryTimeRange[] {
  const { from, to } = coverage.range;
  let end = Math.min(to, coverage.queryableThrough);
  for (const boundary of coverage.versionBoundaries) {
    if (boundary.time > from && boundary.time < end) end = boundary.time;
  }
  const ranges: HistoryTimeRange[] = [];
  let cursor = from;
  for (const gap of [...coverage.gaps].sort((a, b) => a.from - b.from || a.to - b.to)) {
    if (gap.to <= cursor) continue;
    if (gap.from >= end) break;
    if (gap.from > cursor) ranges.push({ from: cursor, to: Math.min(gap.from, end) });
    cursor = Math.max(cursor, gap.to);
    if (cursor >= end) break;
  }
  if (cursor < end) ranges.push({ from: cursor, to: end });
  if (ranges.length > 64) throw new Error('可查询事件区间超过会话预算，请缩小范围。');
  return ranges;
}

/** 宿主必须先取得可信包身份并提供真实渲染器；未就绪时不启动任何网络或旧驱动。 */
export function HistoryReplayPanel({ session, initialRange, resolveActiveIdentity, unavailableReason, onUnavailableRetry }: {
  session: HistoryReadSession | null;
  initialRange?: HistoryTimeRange | null;
  resolveActiveIdentity?: () => Promise<HistoryReadIdentity>;
  unavailableReason?: string;
  onUnavailableRetry?: () => void;
}) {
  const snapshot = useSyncExternalStore(session?.subscribe ?? noopSubscribe, session?.getSnapshot ?? emptySnapshot, emptySnapshot);
  const [speed, setSpeed] = useState<HistoryReplaySpeed>(1);
  const [playing, setPlaying] = useState(false);
  const [eventResult, setEventResult] = useState<{ coverage: HistoryCoverageResponse; items: HistoryTimelineEvent[]; complete: boolean } | null>(null);
  const [eventError, setEventError] = useState<{ message: string; renew: boolean } | null>(null);
  const [eventAttempt, setEventAttempt] = useState(0);
  const [playbackMessage, setPlaybackMessage] = useState<string | null>(null);
  const [resolvingLive, setResolvingLive] = useState(false);
  const resumeAfterScrub = useRef(false);
  const operation = useRef(0);
  const range = snapshot.coverage?.range ?? initialRange ?? NO_RANGE;
  const coverage = snapshot.coverage;
  const events = eventResult && eventResult.coverage === coverage ? eventResult.items : null;
  useEffect(() => () => { operation.current += 1; }, [session]);
  useEffect(() => {
    if (session && initialRange && session.getSnapshot().status === 'idle') void session.open(initialRange, initialRange.from);
  }, [session, initialRange]);

  useEffect(() => {
    setEventResult(null); setEventError(null);
    if (!session || !coverage) return;
    const controller = new AbortController();
    const load = async () => {
      const ranges = eventRanges(coverage), items: HistoryTimelineEvent[] = [];
      for (const range of ranges) {
        items.push(...await session.loadEvents(range, controller.signal));
        if (items.length > 20_000) throw new Error('历史事件概览超过预算。');
      }
      return { coverage, items, complete: ranges.length === 1 && ranges[0].from === coverage.range.from && ranges[0].to === coverage.range.to };
    };
    void load().then(result => {
      if (!controller.signal.aborted) setEventResult(result);
    }).catch(error => {
      if (!controller.signal.aborted) {
        const rangeExpired = error instanceof HistoryReadServiceError && error.code === 'CURSOR_EXPIRED';
        setEventError({ message: rangeExpired ? '关键事件超出索引保留范围，请调整时间范围。'
          : `关键事件不可用：${error instanceof Error ? error.message : String(error)}`,
        renew: !rangeExpired && isRenewableHistorySessionError(error) });
      }
    });
    return () => controller.abort();
  }, [session, coverage, eventAttempt]);

  useEffect(() => {
    if (!playing || !session || !coverage || snapshot.currentTime === null) return;
    let cancelled = false, frame = 0;
    let lastTime = snapshot.currentTime, startedAt = performance.now();
    const tick = (now: number) => {
      if (cancelled) return;
      if (lastTime >= coverage.queryableThrough && lastTime < coverage.range.to) {
        setPlaybackMessage('已到可查询水位，不能将本地时钟当作历史事实。'); setPlaying(false); return;
      }
      if (now - startedAt < PLAYBACK_QUERY_INTERVAL_MS) { frame = requestAnimationFrame(tick); return; }
      const target = Math.min(coverage.range.to, coverage.queryableThrough, Math.floor(lastTime + (now - startedAt) * speed));
      if (target <= lastTime) { frame = requestAnimationFrame(tick); return; }
      void session.advanceTo(target).then(() => {
        if (cancelled) return;
        const next = session.getSnapshot();
        if (next.status !== 'paused' || next.currentTime === null) { setPlaying(false); return; }
        lastTime = next.currentTime; startedAt = performance.now();
        if (lastTime >= coverage.range.to || lastTime >= coverage.queryableThrough) {
          if (lastTime < coverage.range.to && lastTime >= coverage.queryableThrough) setPlaybackMessage('已到可查询水位，不能将本地时钟当作历史事实。');
          setPlaying(false); return;
        }
        frame = requestAnimationFrame(tick);
      });
    };
    frame = requestAnimationFrame(tick);
    return () => { cancelled = true; cancelAnimationFrame(frame); };
    // 事实时间由会话提交；不随每次通知重启虚拟时钟。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, session, coverage, speed]);

  const seek = useCallback((target: number) => {
    if (!session || !coverage) return;
    const shouldResume = playing || resumeAfterScrub.current;
    resumeAfterScrub.current = false; setPlaying(false); setPlaybackMessage(null);
    const current = ++operation.current;
    void session.seek(target).then(() => {
      if (current === operation.current && shouldResume && session.getSnapshot().status === 'paused') setPlaying(true);
    });
  }, [session, coverage, playing]);
  const rangeChange = (next: HistoryTimeRange) => {
    if (!session) return;
    operation.current += 1; setPlaying(false); setPlaybackMessage(null); resumeAfterScrub.current = false;
    void session.open(next, next.from);
  };
  const returnLive = () => {
    if (!session || !resolveActiveIdentity) return;
    const current = ++operation.current; setPlaying(false); session.pause(); setResolvingLive(true);
    void resolveActiveIdentity().then(identity => {
      if (current === operation.current) return session.returnLive(identity);
      return undefined;
    }).catch(error => {
      if (current === operation.current) setPlaybackMessage(`返回实时前无法确定有效版本：${error instanceof Error ? error.message : String(error)}`);
    }).finally(() => { if (current === operation.current) setResolvingLive(false); });
  };
  const unavailable = !session ? unavailableReason ?? '历史查询服务、只读授权或场景恢复适配尚未就绪；已阻断旧实时驱动。' : null;
  const awaitingRange = Boolean(session && snapshot.status === 'idle' && !initialRange);
  const status: HistoryReplayUiStatus = !session ? 'error' : resolvingLive ? 'returning-live'
    : snapshot.status === 'idle' ? awaitingRange ? 'empty' : 'loading'
      : snapshot.status === 'paused' && playing ? 'playing'
        : snapshot.status === 'paused' && snapshot.currentTime !== null && snapshot.currentTime >= range.to && range.to > range.from ? 'ended'
          : snapshot.status;
  const currentTime = snapshot.currentTime;
  const gapCursor = snapshot.blockedTime ?? currentTime ?? coverage?.range.from ?? 0;
  const nextGap = coverage && [...coverage.gaps].sort((a, b) => a.from - b.from || a.to - b.to)
    .find(gap => gap.to > gapCursor && gap.from <= coverage.range.to);
  const nextAvailable = nextGap && coverage ? firstAvailableAtOrAfter(coverage, nextGap.to) : null;
  return <HistoryReplayControls
    range={range} currentTime={currentTime} pendingTime={snapshot.pendingTime} status={status} speed={speed}
    sourceName={snapshot.mode === 'live' ? '当前实时投影' : coverage?.sourceName ?? '服务尚未就绪'}
    versionLabel={snapshot.publishedVersionId}
    sourceQuality={coverage?.sourceQuality ?? null} timeZone="UTC" events={events ?? EMPTY_EVENTS}
    eventsKnown={events !== null && eventResult?.complete === true}
    gaps={coverage?.gaps ?? []} versionBoundaries={coverage?.versionBoundaries ?? []}
    errorMessage={snapshot.error ?? playbackMessage ?? eventError?.message ?? (coverage && events === null ? '关键事件尚未加载，不能认为没有事件。'
      : events !== null && eventResult?.complete === false ? '关键事件仅显示可查询区间，缺口或其他版本的事件不可用。' : null)}
    disabledReason={unavailable} showRetry={Boolean(eventError || (!session && onUnavailableRetry))}
    retryWhenDisabled={Boolean(!session && onUnavailableRetry)}
    canReturnLive={Boolean(session && resolveActiveIdentity
      && (snapshot.mode !== 'live' || snapshot.status === 'error' || snapshot.status === 'gap'))}
    canAdvance={snapshot.canAdvance} canSeekHistory={snapshot.mode === 'history'}
    liveMode={snapshot.mode === 'live'} awaitingRange={awaitingRange} nextAvailableTime={nextAvailable}
    onPlayPause={() => {
      if (!session) return;
      if (playing) { operation.current += 1; setPlaying(false); session.pause(); return; }
      if (status === 'ended' && coverage) {
        const target = firstAvailableAtOrAfter(coverage, coverage.range.from);
        if (target === null) { setPlaybackMessage('当前范围没有可用的兼容起点，请调整时间范围。'); return; }
        resumeAfterScrub.current = true; seek(target); return;
      }
      setPlaying(true);
    }}
    onScrubStart={() => { resumeAfterScrub.current = playing; operation.current += 1; setPlaying(false); session?.pause(); }}
    onScrubCancel={() => { if (resumeAfterScrub.current && session?.getSnapshot().canAdvance) setPlaying(true); resumeAfterScrub.current = false; }}
    onSeek={seek} onSpeedChange={setSpeed} onRangeChange={rangeChange} onReturnLive={returnLive}
    onRetry={() => {
      if (!session) { onUnavailableRetry?.(); return; }
      if (eventError && !eventError.renew && coverage && snapshot.status !== 'error') { setEventAttempt(value => value + 1); return; }
      if (coverage) {
        const target = currentTime !== null && currentTime >= coverage.range.from && currentTime <= coverage.range.to
          ? currentTime : coverage.range.from;
        operation.current += 1; setPlaying(false); setPlaybackMessage(null); resumeAfterScrub.current = false;
        void session.open(coverage.range, target);
      } else if (initialRange) rangeChange(initialRange);
    }}
  />;
}
