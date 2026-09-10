import { useEffect, useRef, useState, type ReactNode } from 'react';
import styles from './LibrarySyncNotice.module.css';

type Props = { runId: string; phase: string; label: string; children: ReactNode };

/** 隐藏提示不清除任务状态；同轮进度不重弹，新的失败允许再次提醒。 */
export function LibrarySyncNotice({ runId, phase, label, children }: Props) {
  const noticeKey = `${runId}:${phase === 'failed' ? 'failed' : 'progress'}`;
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const noticeRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setHovered(noticeRef.current?.matches(':hover') ?? false);
    setFocused(noticeRef.current?.contains(document.activeElement) ?? false);
  }, [noticeKey]);
  useEffect(() => {
    if (phase !== 'completed' || hovered || focused || dismissedKey === noticeKey) return;
    const timer = window.setTimeout(() => setDismissedKey(noticeKey), 3000);
    return () => window.clearTimeout(timer);
  }, [phase, noticeKey, dismissedKey, hovered, focused]);
  if (dismissedKey === noticeKey) return null;
  return <div className={`library-sync-status library-sync-status-${phase} ${styles.notice}`}
    ref={noticeRef} role="status" aria-live="polite" aria-label={label}
    onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
    onFocus={() => setFocused(true)} onBlur={event => {
      if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
    }}>
    <button type="button" className={styles.close} aria-label={`关闭${label}提示`} title="关闭提示"
      onClick={() => setDismissedKey(noticeKey)}>×</button>
    {children}
  </div>;
}
