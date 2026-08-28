import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AutoPatrolInspectionReplayController,
  type AutoPatrolInspectionReplayCamera,
  type AutoPatrolInspectionReplaySnapshot,
} from '../../runtime/patrol/AutoPatrolInspectionReplayController';
import type {
  AutoPatrolInspectionRecord,
  AutoPatrolInspectionRecordStore,
} from '../../runtime/patrol/AutoPatrolInspectionRecordStore';
import type { AutoPatrolHistoryAction, AutoPatrolHistoryState } from './AutoPatrolControls';

type UseAutoPatrolInspectionHistoryOptions = {
  recordStore: AutoPatrolInspectionRecordStore | null;
  scopeId?: string;
  applyCamera: (camera: AutoPatrolInspectionReplayCamera) => void;
  onReplayStart?: () => void;
  onError?: (message: string) => void;
};

type UseAutoPatrolInspectionHistoryResult = {
  history: AutoPatrolHistoryState | undefined;
  handleHistoryAction: (action: AutoPatrolHistoryAction, payload?: string | number) => void;
  pauseReplay: () => void;
};

const IDLE_REPLAY_SNAPSHOT: AutoPatrolInspectionReplaySnapshot = {
  phase: 'idle',
  taskId: null,
  elapsedMs: 0,
  durationMs: 0,
  playbackRate: 1,
  activeEventId: null,
  activeScreenshot: null,
};

/** Editor 与 Viewer 共用的历史列表、回放控制器和异步状态接线。 */
export function useAutoPatrolInspectionHistory(
  options: UseAutoPatrolInspectionHistoryOptions,
): UseAutoPatrolInspectionHistoryResult {
  const replayRef = useRef<AutoPatrolInspectionReplayController | null>(null);
  const refreshGenerationRef = useRef(0);
  const selectedRecordRef = useRef<AutoPatrolInspectionRecord | null>(null);
  const [records, setRecords] = useState<AutoPatrolInspectionRecord[]>([]);
  const [selectedRecord, setSelectedRecord] = useState<AutoPatrolInspectionRecord | null>(null);
  const [replay, setReplay] = useState<AutoPatrolInspectionReplaySnapshot>(IDLE_REPLAY_SNAPSHOT);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    const store = options.recordStore;
    if (!store) return;
    const generation = ++refreshGenerationRef.current;
    setLoading(true);
    setError(null);
    try {
      const nextRecords = await store.listRecords();
      if (generation !== refreshGenerationRef.current) return;
      setRecords(nextRecords);
      const current = selectedRecordRef.current;
      const nextSelectedRecord = current
        ? nextRecords.find((record) => record.taskId === current.taskId) ?? null
        : null;
      selectedRecordRef.current = nextSelectedRecord;
      setSelectedRecord(nextSelectedRecord);

      const controller = replayRef.current;
      const replaySnapshot = controller?.getSnapshot();
      if (controller && nextSelectedRecord && replaySnapshot?.taskId === nextSelectedRecord.taskId) {
        const wasPlaying = replaySnapshot.phase === 'playing';
        const result = controller.load(nextSelectedRecord);
        if (result.ok) {
          controller.setPlaybackRate(replaySnapshot.playbackRate);
          controller.seek(Math.min(replaySnapshot.elapsedMs, controller.getSnapshot().durationMs));
          if (wasPlaying) controller.play();
        }
      }
    } catch (reason) {
      if (generation !== refreshGenerationRef.current) return;
      const message = `读取巡检历史失败：${getErrorMessage(reason)}`;
      setError(message);
      options.onError?.(message);
    } finally {
      if (generation === refreshGenerationRef.current) setLoading(false);
    }
  }, [options.onError, options.recordStore]);

  useEffect(() => {
    refreshGenerationRef.current += 1;
    replayRef.current?.dispose();
    replayRef.current = null;
    setRecords([]);
    selectedRecordRef.current = null;
    setSelectedRecord(null);
    setReplay(IDLE_REPLAY_SNAPSHOT);
    setError(null);
    setLoading(false);
    if (!options.recordStore) return;
    if (options.scopeId) options.recordStore.setScope(options.scopeId);

    const controller = new AutoPatrolInspectionReplayController({
      now: readReplayTimestampMs,
      subscribeFrame: subscribeReplayFrame,
      applyCamera: options.applyCamera,
    });
    replayRef.current = controller;
    const unsubscribe = controller.subscribe(() => setReplay(controller.getSnapshot()));
    void refresh();
    return () => {
      refreshGenerationRef.current += 1;
      unsubscribe();
      controller.dispose();
      if (replayRef.current === controller) replayRef.current = null;
    };
  }, [options.applyCamera, options.recordStore, options.scopeId, refresh]);

  const pauseReplay = useCallback((): void => {
    replayRef.current?.pause();
  }, []);

  const handleHistoryAction = useCallback((
    action: AutoPatrolHistoryAction,
    payload?: string | number,
  ): void => {
    const controller = replayRef.current;
    if (action === 'refresh') {
      void refresh();
      return;
    }
    if (!controller) return;
    let result: { ok: true } | { ok: false; error: string } | null = null;
    switch (action) {
      case 'select-record': {
        const taskId = typeof payload === 'string' ? payload : '';
        const record = records.find((candidate) => candidate.taskId === taskId) ?? null;
        if (!record) {
          result = { ok: false, error: '巡检历史记录不存在。' };
          break;
        }
        options.onReplayStart?.();
        result = controller.load(record);
        if (result.ok) {
          selectedRecordRef.current = record;
          setSelectedRecord(record);
        }
        break;
      }
      case 'play':
        options.onReplayStart?.();
        result = controller.play();
        break;
      case 'pause':
        result = controller.pause();
        break;
      case 'seek':
        options.onReplayStart?.();
        result = controller.seek(typeof payload === 'number' ? payload : Number.NaN);
        break;
      case 'set-rate':
        result = controller.setPlaybackRate(typeof payload === 'number' ? payload as 0.5 | 1 | 2 | 4 : 1);
        break;
      case 'jump-to-event':
        options.onReplayStart?.();
        result = controller.jumpToEvent(typeof payload === 'string' ? payload : '');
        break;
    }
    if (result && !result.ok) {
      setError(result.error);
      options.onError?.(result.error);
    } else if (result) {
      setError(null);
    }
  }, [options, records, refresh]);

  return {
    history: options.recordStore ? { records, selectedRecord, replay, loading, error } : undefined,
    handleHistoryAction,
    pauseReplay,
  };
}

function readReplayTimestampMs(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now();
}

function subscribeReplayFrame(callback: () => void): () => void {
  if (typeof requestAnimationFrame === 'function' && typeof cancelAnimationFrame === 'function') {
    let frameId = 0;
    let active = true;
    const tick = (): void => {
      if (!active) return;
      callback();
      frameId = requestAnimationFrame(tick);
    };
    frameId = requestAnimationFrame(tick);
    return () => {
      active = false;
      cancelAnimationFrame(frameId);
    };
  }
  const timer = setInterval(callback, 16);
  return () => clearInterval(timer);
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
