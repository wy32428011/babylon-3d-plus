import type { ReactNode } from 'react';

export type LightingManagerIconName = 'cube' | 'layers' | 'motion' | 'warning' | 'check' | 'close' | 'search' | 'focus' | 'refresh' | 'folder' | 'rule' | 'arrow' | 'back' | 'up' | 'down' | 'plus';

/** 管理器使用同一组线性图标，避免把示意图中的装饰作为静态图片嵌入。 */
export function LightingManagerIcon({ name, size = 20 }: { name: LightingManagerIconName; size?: number }) {
  const shapes: Record<LightingManagerIconName, ReactNode> = {
    cube: <><path d="m12 2 9 5v10l-9 5-9-5V7z" /><path d="m3 7 9 5 9-5M12 12v10" /></>,
    layers: <><path d="m12 3 9 5-9 5-9-5zM3 12l9 5 9-5M3 16l9 5 9-5" /></>,
    motion: <path d="m6 3 14 9-14 9z" />,
    warning: <><path d="M12 3 2 21h20zM12 9v5" /><path d="M12 17h.01" /></>,
    check: <><circle cx="12" cy="12" r="9" /><path d="m8 12 3 3 5-6" /></>,
    close: <path d="m5 5 14 14M19 5 5 19" />,
    search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></>,
    focus: <><path d="M20 10c0 6-8 11-8 11S4 16 4 10a8 8 0 0 1 16 0Z" /><circle cx="12" cy="10" r="2.5" /></>,
    refresh: <><path d="M20 11a8 8 0 0 0-14-5L3 9M3 3v6h6M4 13a8 8 0 0 0 14 5l3-3M21 21v-6h-6" /></>,
    folder: <path d="M3 5h7l2 3h9v12H3z" />,
    rule: <><path d="M5 5h14M5 12h14M5 19h14" /><circle cx="9" cy="5" r="2" /><circle cx="15" cy="12" r="2" /><circle cx="9" cy="19" r="2" /></>,
    arrow: <path d="m9 5 7 7-7 7" />,
    back: <path d="m15 5-7 7 7 7" />,
    up: <path d="m5 14 7-7 7 7" />,
    down: <path d="m5 10 7 7 7-7" />,
    plus: <path d="M12 5v14M5 12h14" />,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{shapes[name]}</svg>;
}

export function LightingManagerBadge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'static' | 'dynamic' | 'warning' | 'neutral' | 'success' }) {
  return <span className={`lighting-manager-badge is-${tone}`}><span aria-hidden="true" />{children}</span>;
}

export function LightingManagerNumberField({ label, value, unit, min, max, step = 1, disabled, onChange }: {
  label: string; value: number; unit?: string; min: number; max: number; step?: number; disabled?: boolean; onChange: (value: number) => void;
}) {
  return <label className="lighting-manager-field"><span>{label}</span><span className="lighting-manager-number">
    <input aria-label={label} type="number" value={value} min={min} max={max} step={step} disabled={disabled}
      onChange={event => {
        if (!event.target.value.trim()) return;
        const next = Number(event.target.value);
        if (Number.isFinite(next)) onChange(Math.max(min, Math.min(max, next)));
      }} />{unit && <span>{unit}</span>}
  </span></label>;
}

export function LightingManagerColorField({ label, value, disabled, onChange }: {
  label: string; value: string; disabled?: boolean; onChange: (value: string) => void;
}) {
  return <label className="lighting-manager-field"><span>{label}</span><span className="lighting-manager-color">
    <input type="color" aria-label={label} value={value} disabled={disabled} onChange={event => onChange(event.target.value)} /><code>{value}</code>
  </span></label>;
}

export function LightingManagerToggle({ label, description, checked, disabled, onChange }: {
  label: string; description?: string; checked: boolean; disabled?: boolean; onChange: (value: boolean) => void;
}) {
  return <label className="lighting-manager-toggle"><input type="checkbox" checked={checked} disabled={disabled}
    onChange={event => onChange(event.target.checked)} /><span>{label}</span>{description && <small>{description}</small>}</label>;
}

export const formatLightingBytes = (value: number) => value >= 1048576 ? `${(value / 1048576).toFixed(1)} MiB`
  : value >= 1024 ? `${(value / 1024).toFixed(1)} KiB` : `${value} B`;

export const LIGHTING_MANAGER_PHASE_LABELS: Record<string, string> = {
  idle: '就绪', preparing: '准备中', baking: '烘焙中', applying: '应用中', error: '更新失败', cancelled: '已取消',
};
