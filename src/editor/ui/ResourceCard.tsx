import type { DragEventHandler } from 'react';
import {
  getResourceCardSubtitle,
  getResourceCardThumbnailUrl,
  type ProjectLibrary,
  type ProjectLibraryItem,
} from '../assets/projectLibrary';
import styles from './ResourceCard.module.css';

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
  const density = 'asset' in item && item.asset.kind === 'model' ? item.asset.sourceModelDensity : undefined;
  const densityDetails = density ? [
    density.triangles === null ? '源模型面数未知。' : `源 GLB JSON 估计 ${density.triangles.toLocaleString('zh-CN')} 个三角面。`,
    ...density.findings.slice(0, 3).map(finding => `「${finding.mesh}」${finding.triangles.toLocaleString('zh-CN')} 面，尺寸 ${finding.sizeMeters.map(size => Number(size.toPrecision(3))).join(' × ')} m：${finding.reasons.map(reason => reason === 'small-high-poly' ? '小尺寸高面数' : '面密度过高').join('、')}。`),
    ...density.unknownReasons,
  ].join('\n') : undefined;
  const description = [item.description, densityDetails].filter(Boolean).join('\n') || undefined;
  const highDensity = Boolean(density?.findings.length);

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
      title={description ? `${title}\n${description}` : title}
      aria-description={description}
      type="button"
    >
      <span className={`resource-card-preview ${styles.preview}`}>
        {thumbnailUrl ? (
          <img alt="" className="resource-card-thumbnail" draggable={false} src={thumbnailUrl} />
        ) : (
          <ResourceIcon icon={item.icon} />
        )}
        {item.hasStatusBadge ? <span aria-hidden="true" className="resource-card-status-badge" /> : null}
        {highDensity ? <span className={styles.densityBadge}>源模型高密度</span> : null}
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
