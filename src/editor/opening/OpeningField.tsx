import { useEffect, useRef, useState, type KeyboardEvent } from 'react';

export function openingColorInputValue(value: string): string {
  return value.replace(/^#([\da-f])([\da-f])([\da-f])$/i, '#$1$1$2$2$3$3').slice(0, 7);
}

/** 输入过程保留草稿，失焦时只产生一次场景命令，便于撤销。 */
export function OpeningField({ label, value, disabled = false, min, max, maxLength, multiline = false, required = false, onCommit }: {
  label: string; value: string | number; disabled?: boolean; min?: number; max?: number;
  maxLength?: number; multiline?: boolean; required?: boolean; onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  const cancelled = useRef(false);
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    if (disabled || cancelled.current) { cancelled.current = false; setDraft(String(value)); return; }
    if (typeof value === 'number') {
      const parsed = draft.trim() ? Number(draft) : Number.NaN;
      const resolved = Number.isFinite(parsed) ? Math.max(min ?? -Infinity, Math.min(max ?? Infinity, parsed)) : value;
      setDraft(String(resolved));
      if (resolved !== value) onCommit(String(resolved));
    } else {
      const resolved = required ? draft.trim() || value : draft;
      setDraft(resolved);
      if (resolved !== value) onCommit(resolved);
    }
  };
  const keyDown = (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && (!multiline || event.ctrlKey)) { event.preventDefault(); event.currentTarget.blur(); }
    if (event.key === 'Escape') { event.preventDefault(); cancelled.current = true; setDraft(String(value)); event.currentTarget.blur(); }
  };
  return <label className="inspector-row">
    <span>{label}</span>
    {multiline ? <textarea aria-label={label} value={draft} disabled={disabled} rows={2} maxLength={maxLength}
      onChange={event => setDraft(event.target.value)} onBlur={commit} onKeyDown={keyDown} />
      : <input aria-label={label} type={typeof value === 'number' ? 'number' : 'text'} value={draft} disabled={disabled}
        min={min} max={max} step={typeof value === 'number' ? 'any' : undefined} maxLength={maxLength}
        onChange={event => setDraft(event.target.value)} onBlur={commit} onKeyDown={keyDown} />}
  </label>;
}
