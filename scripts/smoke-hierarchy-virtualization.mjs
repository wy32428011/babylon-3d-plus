import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'vite';

const MODULE_LOAD_TIMEOUT_MS = 30_000;
const PANEL_PATH = 'src/editor/panels/HierarchyPanel.tsx';
const CSS_PATH = 'src/styles/global.css';

/** 在限定时间内加载虚拟窗口模块，避免 Vite SSR 异常时 smoke 无限等待。 */
async function loadVirtualizationModule(server) {
  let timeoutId;
  try {
    return await Promise.race([
      server.ssrLoadModule('/src/editor/hierarchy/hierarchyVirtualization.ts'),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error('加载 Hierarchy 虚拟窗口模块超时'));
        }, MODULE_LOAD_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

/** 验证给定规模在全部典型滚动位置都只产生有界渲染窗口。 */
function verifyLargeListWindow(module, rowCount, viewportHeight) {
  const { HIERARCHY_ROW_HEIGHT, HIERARCHY_OVERSCAN_ROWS, calculateHierarchyVirtualWindow } = module;
  const totalHeight = rowCount * HIERARCHY_ROW_HEIGHT;
  const maxScrollTop = Math.max(0, totalHeight - viewportHeight);
  const maximumRenderedRowCount = Math.ceil(viewportHeight / HIERARCHY_ROW_HEIGHT)
    + HIERARCHY_OVERSCAN_ROWS * 2
    + 1;
  const scrollPositions = [
    0,
    1,
    HIERARCHY_ROW_HEIGHT - 1,
    HIERARCHY_ROW_HEIGHT,
    totalHeight * 0.25 + 7,
    totalHeight * 0.5 + 11,
    totalHeight * 0.75 + 17,
    Math.max(0, maxScrollTop - 1),
    maxScrollTop,
    totalHeight,
  ];

  let observedMaximum = 0;
  for (const requestedScrollTop of scrollPositions) {
    const window = calculateHierarchyVirtualWindow(rowCount, requestedScrollTop, viewportHeight);
    const visibleStartIndex = Math.floor(window.scrollTop / HIERARCHY_ROW_HEIGHT);
    const visibleEndIndex = Math.min(
      rowCount,
      Math.ceil((window.scrollTop + viewportHeight) / HIERARCHY_ROW_HEIGHT),
    );
    const expectedStartIndex = Math.max(0, visibleStartIndex - HIERARCHY_OVERSCAN_ROWS);
    const expectedEndIndex = Math.min(rowCount, visibleEndIndex + HIERARCHY_OVERSCAN_ROWS);
    const renderedRowCount = window.endIndex - window.startIndex;

    assert.equal(window.totalHeight, totalHeight, `${rowCount} 行的总滚动高度必须精确匹配固定行高`);
    assert.equal(window.startIndex, expectedStartIndex, `${rowCount} 行窗口顶部 overscan 错误`);
    assert.equal(window.endIndex, expectedEndIndex, `${rowCount} 行窗口底部 overscan 错误`);
    assert.equal(window.offsetTop, window.startIndex * HIERARCHY_ROW_HEIGHT, `${rowCount} 行窗口偏移错误`);
    assert.ok(window.startIndex >= 0 && window.endIndex <= rowCount, `${rowCount} 行窗口不得越界`);
    assert.ok(renderedRowCount <= maximumRenderedRowCount, `${rowCount} 行渲染数量失控：${renderedRowCount}`);
    observedMaximum = Math.max(observedMaximum, renderedRowCount);
  }

  return { rowCount, viewportHeight, maximumRenderedRowCount, observedMaximum, totalHeight };
}

let server;
try {
  server = await createServer({
    appType: 'custom',
    configFile: false,
    root: process.cwd(),
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true },
  });
  const module = await loadVirtualizationModule(server);
  const {
    HIERARCHY_OVERSCAN_ROWS,
    HIERARCHY_ROW_HEIGHT,
    calculateHierarchyVirtualWindow,
    getHierarchyScrollTopForIndex,
  } = module;

  assert.equal(HIERARCHY_ROW_HEIGHT, 24, 'Hierarchy 固定行高必须为 24px');
  assert.equal(HIERARCHY_OVERSCAN_ROWS, 20, 'Hierarchy 视口上下必须各 overscan 20 行');

  const largeListResults = [
    verifyLargeListWindow(module, 10_000, 480),
    verifyLargeListWindow(module, 50_000, 720),
  ];

  const emptyWindow = calculateHierarchyVirtualWindow(0, 100, 480);
  assert.deepEqual(
    emptyWindow,
    { startIndex: 0, endIndex: 0, offsetTop: 0, totalHeight: 0, scrollTop: 0 },
    '空列表不得渲染虚拟行',
  );

  const scrollDown = getHierarchyScrollTopForIndex(500, 10_000, 0, 240);
  assert.equal(scrollDown, 500 * HIERARCHY_ROW_HEIGHT + HIERARCHY_ROW_HEIGHT - 240, '下方目标行必须滚入视口');
  assert.equal(getHierarchyScrollTopForIndex(5, 10_000, 100, 240), 100, '已可见目标行不得改变滚动位置');
  assert.equal(getHierarchyScrollTopForIndex(2, 10_000, 240, 240), 2 * HIERARCHY_ROW_HEIGHT, '上方目标行必须滚入视口');
  assert.equal(
    getHierarchyScrollTopForIndex(49_999, 50_000, 0, 720),
    50_000 * HIERARCHY_ROW_HEIGHT - 720,
    '最后一行滚动位置必须受最大滚动高度约束',
  );

  const [panelSource, cssSource] = await Promise.all([
    readFile(PANEL_PATH, 'utf8'),
    readFile(CSS_PATH, 'utf8'),
  ]);
  assert.match(panelSource, /calculateHierarchyVirtualWindow\(rows\.length, scrollTop, viewportHeight\)/, '组件必须计算虚拟窗口');
  assert.match(panelSource, /rows\.slice\(virtualWindow\.startIndex, virtualWindow\.endIndex\)/, '组件必须仅截取虚拟窗口行');
  assert.match(panelSource, /virtualRows\.map\(/, '组件必须只渲染虚拟窗口行');
  assert.doesNotMatch(panelSource, /\{rows\.map\(/, '组件不得继续直接渲染全部 rows');
  assert.match(panelSource, /new Set\(hierarchySelectionIds\)/, '组件必须将 Hierarchy 选区转换为 Set');
  assert.match(panelSource, /hierarchySelectionIdSet\.has\(entity\.id\)/, '行选中判断必须使用 Set.has');
  assert.doesNotMatch(panelSource, /hierarchySelectionIds\.includes\(/, '选区判断不得退回 Array.includes');
  assert.match(panelSource, /virtualWindow\.startIndex \+ virtualRowIndex/, 'Shift 多选必须继续使用完整 rows 的绝对索引');
  assert.match(panelSource, /height: virtualWindow\.totalHeight/, '虚拟占位高度必须等于全部 rows 的总高度');
  assert.match(panelSource, /renamingEntityId \?\? selectedEntityId/, '重命名项和主要选中项必须作为滚动目标');
  assert.match(panelSource, /getHierarchyScrollTopForIndex\(/, '组件必须把视口外目标行滚动到可见位置');
  assert.match(panelSource, /new ResizeObserver\(/, '组件必须响应面板视口尺寸变化');
  assert.match(panelSource, /onScroll=\{handleListScroll\}/, '组件必须根据列表滚动更新虚拟窗口');
  assert.match(panelSource, /aria-label="全部展开"/, 'Hierarchy 工具栏必须提供全部展开按钮');
  assert.match(panelSource, /aria-label="全部收缩"/, 'Hierarchy 工具栏必须提供全部收缩按钮');
  assert.match(panelSource, /setCollapsedFolderIds\(new Set<string>\(\)\)/, '全部展开必须清空文件夹收缩集合');
  assert.match(panelSource, /setCollapsedFolderIds\(new Set\(folderIds\)\)/, '全部收缩必须覆盖当前全部文件夹');

  assert.match(cssSource, /\.hierarchy-virtual-spacer\s*\{[^}]*position:\s*relative;/s, 'CSS 必须提供总高度占位层');
  assert.match(cssSource, /\.hierarchy-virtual-window\s*\{[^}]*position:\s*absolute;/s, 'CSS 必须让窗口行脱离总高度布局');
  assert.match(cssSource, /\.entity-tree-row\s*\{[^}]*height:\s*24px;/s, 'Hierarchy 行高必须固定为 24px');

  console.log(JSON.stringify({
    ok: true,
    rowHeight: HIERARCHY_ROW_HEIGHT,
    overscanRowsPerSide: HIERARCHY_OVERSCAN_ROWS,
    largeListResults,
    staticChecks: {
      virtualWindowSlice: true,
      selectionSetLookup: true,
      absoluteShiftRangeIndex: true,
      selectedAndRenamingAutoScroll: true,
      fixedTotalHeight: true,
      expandAndCollapseAll: true,
    },
  }, null, 2));
} finally {
  await server?.close();
}