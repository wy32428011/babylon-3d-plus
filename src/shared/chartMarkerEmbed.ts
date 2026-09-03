export const CHART_MARKER_REFRESH_EVENT = 'zending3d:refresh-chart-marker';

/** 大屏可反向嵌入孪生 Viewer；限制嵌套深度，阻止场景与大屏无限递归加载。 */
export function canEmbedChartMarkerScreen(frame: Window = window): boolean {
  let ancestor = frame;
  for (let depth = 0; depth < 4; depth += 1) {
    if (ancestor.parent === ancestor) return true;
    ancestor = ancestor.parent;
  }
  return false;
}
