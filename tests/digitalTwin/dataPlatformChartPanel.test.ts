import ts from 'typescript';
import path from 'node:path';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';


/** 只沿面板实际导入且使用的 P3 子模块读取，避免把孤立测试文本当成产品入口。 */
function readConnectedPanelSource(entry: string): string {
  const visited = new Set<string>();
  const parts: string[] = [];
  function visit(file: string): void {
    const absolute = path.resolve(file);
    if (visited.has(absolute)) return;
    visited.add(absolute);
    const source = readFileSync(absolute, 'utf8');
    parts.push(source);
    const ast = ts.createSourceFile(absolute, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const body = ast.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText(ast)).join('\n');
    for (const statement of ast.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const specifier = statement.moduleSpecifier.text;
      if (!specifier.startsWith('.')) continue;
      const resolved = path.resolve(path.dirname(absolute), specifier);
      if (!/[\\/]panels[\\/](?:scene-view|project-library)[\\/]/.test(resolved)) continue;
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) for (const binding of bindings.elements) {
        assert.match(body, new RegExp('\\b' + binding.name.text + '\\b'), '子模块导出必须在真实调用面板中使用');
      }
      visit(resolved + (path.extname(resolved) ? '' : existsSync(resolved + '.tsx') ? '.tsx' : '.ts'));
    }
  }
  visit(entry);
  return parts.join('\n');
}

const PROJECT_PANEL_PATH = 'src/editor/panels/ProjectPanel.tsx';
const SCENE_VIEW_PANEL_PATH = 'src/editor/panels/SceneViewPanel.tsx';

test('图表库只展示当前绑定项目大屏并支持名称和编码筛选', () => {
  const source = readConnectedPanelSource(PROJECT_PANEL_PATH);

  assert.ok(source.includes("from '../assets/dataPlatformChartLibrary'"));
  assert.ok(source.includes("if (activeLibrary.key === 'chart')"));
  assert.ok(source.includes('createDataPlatformChartLibraryItems(syncedCharts)'));
  assert.ok(source.includes('matchesDataPlatformChartLibrarySearch(item, normalizedLibraryFilter)'));
  assert.ok(source.includes('当前工程未绑定数据中台项目'));
  assert.ok(source.includes('当前绑定项目暂无可同步的大屏'));
});

test('图表同步 API、手动同步和失败重试均受当前绑定上下文约束', () => {
  const source = readConnectedPanelSource(PROJECT_PANEL_PATH);

  assert.ok(source.includes('listDataPlatformCharts?: () => Promise<DataPlatformChartLibrarySnapshot>'));
  assert.ok(source.includes('syncDataPlatformCharts?: () => Promise<boolean>'));
  assert.ok(source.includes('retryDataPlatformChartSync?: () => Promise<boolean>'));
  assert.ok(source.includes('onDataPlatformChartSyncProgress?:'));
  assert.ok(source.includes('disabled={props.readOnly || !chartSyncContextKey'));
  assert.ok(source.includes('同步数据中台大屏'));
  assert.ok(source.includes('重试大屏同步'));
});

test('绑定项目加载后自动同步图表，未绑定时不触发同步请求', () => {
  const source = readConnectedPanelSource(PROJECT_PANEL_PATH);

  assert.ok(source.includes('if (!expectedContextKey) return'));
  assert.ok(source.includes('autoChartSyncContextKeyRef.current === expectedContextKey'));
  assert.ok(source.includes('void api.syncDataPlatformCharts()'));
});

test('场景切换清空旧图表且迟到结果和进度不能覆盖新项目', () => {
  const source = readConnectedPanelSource(PROJECT_PANEL_PATH);

  assert.ok(source.includes('chartLibraryLoadRequestRef.current += 1'));
  assert.ok(source.includes('setSyncedCharts([])'));
  assert.ok(source.includes('sceneSessionIdRef.current !== expectedSceneSessionId'));
  assert.ok(source.includes('chartSyncContextKeyRef.current !== expectedContextKey'));
  assert.ok(source.includes('progress.contextKey !== chartSyncContextKeyRef.current'));
});

test('同步大屏只拖入图表立标，不直接创建实体或覆盖相机视窗', () => {
  const projectSource = readConnectedPanelSource(PROJECT_PANEL_PATH);
  const sceneSource = readConnectedPanelSource(SCENE_VIEW_PANEL_PATH);

  assert.ok(projectSource.includes('createDataPlatformChartLibraryItems(syncedCharts)'));
  assert.ok(projectSource.includes('matchesDataPlatformChartLibrarySearch(item, normalizedLibraryFilter)'));
  assert.ok(projectSource.includes('数据中台同步大屏：${item.name}'));
  assert.ok(projectSource.includes('const isActionableItem ='));
  assert.equal(projectSource.includes('DATA_PLATFORM_SCREEN_ASSET_DRAG_MIME_TYPE'), true);
  assert.equal(projectSource.includes('setViewportDataPlatformScreen'), false);
  assert.equal(sceneSource.includes('DATA_PLATFORM_SCREEN_ASSET_DRAG_MIME_TYPE'), true);
  assert.equal(sceneSource.includes('decodeDataPlatformScreenDragPayload'), true);
  assert.ok(sceneSource.includes('bindChartMarkerScreen(entityId, source)'));
  assert.equal(sceneSource.includes('setViewportDataPlatformScreen'), false);
});
