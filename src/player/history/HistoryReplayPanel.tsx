import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { HistoryReplaySpeed, HistoryReplayUiStatus, HistoryTimeRange, HistoryTimelineEvent } from '../../runtime/history/historyReplayContract';
import { HistoryReplayControls } from './HistoryReplayControls';
import type { HistoryReadIdentity } from './historyReadContract';
import { HistoryReadSession, type HistorySessionSnapshot } from './HistoryReadSession';

const NO_RANGE: HistoryTimeRange = { from: 0, to: 0 };
const EMPTY_SNAPSHOT: HistorySessionSnapshot = { status: 'error', currentTime: null, pendingTime: null, cursor: null, coverage: null, error: null, readOnly: true };
const noopSubscribe = () => () => {};
const emptySnapshot = () => EMPTY_SNAPSHOT;
const EMPTY_EVENTS: HistoryTimelineEvent[] = [];

/** 宿主必须先取得可信包身份并提供真实渲染器；未就绪时不启动任何网络或旧驱动。 */
export function HistoryReplayPanel({ session, initialRange, resolveActiveIdentity, unavailableReason }: {
  session: HistoryReadSession | null;
  initialRange?: HistoryTimeRange | null;
  resolveActiveIdentity?: () => Promise<HistoryReadIdentity>;
  unavailableReason?: string;
}) {
  const snapshot = useSyncExternalStore(session?.subscribe ?? noopSubscribe, session?.getSnapshot ?? emptySnapshot, emptySnapshot);
  const [speed, setSpeed] = useState<HistoryReplaySpeed>(1);
  const [playing, setPlaying] = useState(false);
  const [events, setEvents] = useState<HistoryTimelineEvent[] | null>(null);
  const [eventError, setEventError] = useState<string | null>(null);
  const [eventAttempt, setEventAttempt] = useState(0);
  const [playbackMessage, setPlaybackMessage] = useState<string | null>(null);
  const [resolvingLive, setResolvingLive] = useState(false);
  const resumeAfterScrub = useRef(false);
  const operation = useRef(0);
  const range = snapshot.coverage?.range ?? initialRange ?? NO_RANGE;
  const coverage = snapshot.coverage;
  useEffect(() => () => { operation.current += 1; }, [session]);
  useEffect(() => {
    if (session && initialRange && session.getSnapshot().status === 'idle') void session.open(initialRange, initialRange.from);
  }, [session, initialRange]);

  useEffect(() => {
    setEvents(null); setEventError(null);
    if (!session || !coverage) return;
    const controller = new AbortController();
    void session.loadEvents(coverage.range, controller.signal).then(items => {
      if (!controller.signal.aborted) setEvents(items);
    }).catch(error => {
      if (!controller.signal.aborted) setEventError(`关键事件不可用：${error instanceof Error ? error.message : String(error)}`);
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
      const target = Math.min(coverage.range.to, coverage.queryableThrough, Math.floor(lastTime + (now - startedAt) * speed));
      if (target <= lastTime) { frame = requestAnimationFrame(tick); return; }
      void session.advanceTo(target).then(() => {
        if (cancelled) return;
        const next = session.getSnapshot();
        if (next.status !== 'paused' || next.currentTime === null) { setPlaying(false); return; }
        lastTime = next.currentTime; startedAt = performance.now();
        if (lastTime >= coverage.range.to || lastTime >= coverage.queryableThrough) { setPlaying(false); return; }
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
  const unavailable = !session ? unavailableReason ?? '历史查询服务、只读授权或场景恢复适配尚未就绪；已阻断旧实时驱动。'
    : !coverage && !initialRange ? '尚未取得有授权的历史时间范围。' : null;
  const status: HistoryReplayUiStatus = !session ? 'error' : resolvingLive ? 'returning-live'
    : snapshot.status === 'idle' ? 'loading'
      : snapshot.status === 'paused' && playing ? 'playing'
        : snapshot.status === 'paused' && snapshot.currentTime !== null && snapshot.currentTime >= range.to && range.to > range.from ? 'ended'
          : snapshot.status;
  const currentTime = snapshot.currentTime;
  const nextGap = coverage?.gaps.find(gap => gap.to > (currentTime ?? coverage.range.from) && gap.from <= coverage.range.to);
  const nextAvailable = nextGap && coverage && nextGap.to <= coverage.queryableThrough
    && !coverage.versionBoundaries.some(boundary => boundary.time > coverage.range.from && boundary.time <= nextGap.to)
    ? nextGap.to : null;
  return <HistoryReplayControls
    range={range} currentTime={currentTime} pendingTime={snapshot.pendingTime} status={status} speed={speed}
    sourceName={coverage?.sourceName ?? '服务尚未就绪'} versionLabel={coverage?.identity.publishedVersionId ?? null}
    sourceQuality={coverage?.sourceQuality ?? null} timeZone="UTC" events={events ?? EMPTY_EVENTS} eventsKnown={events !== null}
    gaps={coverage?.gaps ?? []} versionBoundaries={coverage?.versionBoundaries ?? []}
    errorMessage={snapshot.error ?? playbackMessage ?? eventError ?? (coverage && events === null ? '关键事件尚未加载，不能认为没有事件。' : null)}
    disabledReason={unavailable} showRetry={Boolean(eventError)} canReturnLive={Boolean(session && resolveActiveIdentity)} nextAvailableTime={nextAvailable}
    onPlayPause={() => {
      if (!session) return;
      if (playing) { operation.current += 1; setPlaying(false); session.pause(); return; }
      if (status === 'ended' && coverage) { resumeAfterScrub.current = true; seek(coverage.range.from); return; }
      setPlaying(true);
    }}
    onScrubStart={() => { resumeAfterScrub.current = playing; operation.current += 1; setPlaying(false); session?.pause(); }}
    onScrubCancel={() => { if (resumeAfterScrub.current) setPlaying(true); resumeAfterScrub.current = false; }}
    onSeek={seek} onSpeedChange={setSpeed} onRangeChange={rangeChange} onReturnLive={returnLive}
    onRetry={() => {
      if (!session) return;
      if (eventError && coverage) { setEventAttempt(value => value + 1); return; }
      if (coverage && currentTime !== null) seek(currentTime);
      else if (initialRange) rangeChange(initialRange);
    }}
  />;
}
