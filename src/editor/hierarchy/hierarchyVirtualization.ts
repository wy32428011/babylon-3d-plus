export const HIERARCHY_ROW_HEIGHT = 24;
export const HIERARCHY_OVERSCAN_ROWS = 20;

export type HierarchyVirtualWindow = {
  startIndex: number;
  endIndex: number;
  offsetTop: number;
  totalHeight: number;
  scrollTop: number;
};

/** 将未知滚动数值约束为可用于像素和数组索引计算的非负有限数。 */
function normalizeNonNegativeNumber(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

/**
 * 按固定 24px 行高计算 Hierarchy 可视窗口，并在视口上下各保留 20 行缓冲。
 * endIndex 为开区间，便于直接传给 Array.prototype.slice。
 */
export function calculateHierarchyVirtualWindow(
  rowCount: number,
  scrollTop: number,
  viewportHeight: number,
): HierarchyVirtualWindow {
  const normalizedRowCount = Math.max(0, Math.floor(normalizeNonNegativeNumber(rowCount)));
  const normalizedViewportHeight = normalizeNonNegativeNumber(viewportHeight);
  const totalHeight = normalizedRowCount * HIERARCHY_ROW_HEIGHT;
  const maxScrollTop = Math.max(0, totalHeight - normalizedViewportHeight);
  const normalizedScrollTop = Math.min(normalizeNonNegativeNumber(scrollTop), maxScrollTop);

  if (normalizedRowCount === 0 || normalizedViewportHeight === 0) {
    return {
      startIndex: 0,
      endIndex: 0,
      offsetTop: 0,
      totalHeight,
      scrollTop: normalizedScrollTop,
    };
  }

  const visibleStartIndex = Math.min(
    normalizedRowCount,
    Math.floor(normalizedScrollTop / HIERARCHY_ROW_HEIGHT),
  );
  const visibleEndIndex = Math.min(
    normalizedRowCount,
    Math.ceil((normalizedScrollTop + normalizedViewportHeight) / HIERARCHY_ROW_HEIGHT),
  );
  const startIndex = Math.max(0, visibleStartIndex - HIERARCHY_OVERSCAN_ROWS);
  const endIndex = Math.min(normalizedRowCount, visibleEndIndex + HIERARCHY_OVERSCAN_ROWS);

  return {
    startIndex,
    endIndex,
    offsetTop: startIndex * HIERARCHY_ROW_HEIGHT,
    totalHeight,
    scrollTop: normalizedScrollTop,
  };
}

/** 计算让目标行完整进入视口所需的最小滚动量；已可见时保持当前位置。 */
export function getHierarchyScrollTopForIndex(
  rowIndex: number,
  rowCount: number,
  scrollTop: number,
  viewportHeight: number,
): number {
  const normalizedRowCount = Math.max(0, Math.floor(normalizeNonNegativeNumber(rowCount)));
  const normalizedViewportHeight = normalizeNonNegativeNumber(viewportHeight);
  const totalHeight = normalizedRowCount * HIERARCHY_ROW_HEIGHT;
  const maxScrollTop = Math.max(0, totalHeight - normalizedViewportHeight);
  const normalizedScrollTop = Math.min(normalizeNonNegativeNumber(scrollTop), maxScrollTop);

  if (normalizedRowCount === 0 || normalizedViewportHeight === 0 || !Number.isFinite(rowIndex)) {
    return normalizedScrollTop;
  }

  const normalizedRowIndex = Math.min(normalizedRowCount - 1, Math.max(0, Math.floor(rowIndex)));
  const rowTop = normalizedRowIndex * HIERARCHY_ROW_HEIGHT;
  const rowBottom = rowTop + HIERARCHY_ROW_HEIGHT;

  if (rowTop < normalizedScrollTop) return rowTop;
  if (rowBottom > normalizedScrollTop + normalizedViewportHeight) {
    return Math.min(maxScrollTop, Math.max(0, rowBottom - normalizedViewportHeight));
  }

  return normalizedScrollTop;
}