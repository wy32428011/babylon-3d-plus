import type { DragEventHandler } from 'react';
import {
  getResourceCardSubtitle,
  getResourceCardThumbnailUrl,
  type ProjectLibrary,
  type ProjectLibraryItem,
} from '../assets/projectLibrary';

type ResourceCardProps = {
  item: ProjectLibraryItem;
  library: ProjectLibrary;
  className?: string;
  disabled?: boolean;
  draggable?: boolean;
  focused?: boolean;
  title: string;
  onClick?: () => void;
  onDragStart?: DragEventHandler<HTMLButtonElement>;
  setButtonRef?: (node: HTMLButtonElement | null) => void;
};

/** 渲染资源库通用卡片，首页和 Project 面板共享同一套视觉结构。 */
export function ResourceCard({
  item,
  library,
  className,
  disabled = false,
  draggable = false,
  focused = false,
  title,
  onClick,
  onDragStart,
  setButtonRef,
}: ResourceCardProps) {
  const subtitle = getResourceCardSubtitle(item, library);
  const thumbnailUrl = getResourceCardThumbnailUrl(item);

  return (
    <button
      className={[
        className ?? 'resource-card',
        !disabled ? 'resource-card-clickable' : '',
        focused ? 'resource-card-focused' : '',
      ].filter(Boolean).join(' ')}
      disabled={disabled}
      draggable={draggable && !disabled}
      onClick={onClick}
      onDragStart={onDragStart}
      ref={setButtonRef}
      title={title}
      type="button"
    >
      <span className="resource-card-preview">
        {thumbnailUrl ? (
          <img alt="" className="resource-card-thumbnail" draggable={false} src={thumbnailUrl} />
        ) : (
          <ResourceIcon icon={item.icon} />
        )}
        {item.hasStatusBadge ? <span aria-hidden="true" className="resource-card-status-badge" /> : null}
      </span>
      <span className="resource-card-text">
        <strong className="resource-card-name">{item.name}</strong>
        <span className="resource-card-subtitle">{subtitle}</span>
      </span>
    </button>
  );
}

/** 渲染资源库轻量图标，占位逻辑与旧 Project 面板保持一致。 */
function ResourceIcon({ icon }: { icon: ProjectLibraryItem['icon'] }) {
  return <span className={`resource-card-icon resource-card-icon-${icon}`} aria-hidden="true" />;
}
