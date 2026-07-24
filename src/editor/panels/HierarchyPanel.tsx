import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
  type UIEvent,
} from 'react';
import {
  calculateHierarchyVirtualWindow,
  getHierarchyScrollTopForIndex,
} from '../hierarchy/hierarchyVirtualization';
import type { Entity } from '../model/Entity';
import { getEntityArrayIdentifierError } from '../model/modelArray';
import { EntityArrayDialog, type EntityArrayDialogValue } from '../ui/EntityArrayDialog';
import { useEditorStore } from '../store/editorStore';

const HIERARCHY_DRAG_MIME_TYPE = 'application/x-babylon-editor-hierarchy-entities';
const CONTEXT_MENU_WIDTH = 188;
const CONTEXT_MENU_HEIGHT = 342;

type HierarchyRow = {
  entity: Entity;
  depth: number;
};

type HierarchyDragPayload = {
  ids: string[];
};

type HierarchyContextMenuState = {
  entityId: string;
  x: number;
  y: number;
};

type ArrayDialogState = EntityArrayDialogValue;

/** 判断实体名称是否命中当前搜索关键字。 */
function matchesSearch(entity: Entity, query: string): boolean {
  return entity.name.toLocaleLowerCase().includes(query);
}

/** 将场景实体整理为 Hierarchy 可渲染的根层级与文件夹子项。 */
function buildHierarchyRows(
  entityIds: string[],
  entities: Record<string, Entity>,
  searchText: string,
  collapsedFolderIds: Set<string>,
): HierarchyRow[] {
  const query = searchText.trim().toLocaleLowerCase();
  const rows: HierarchyRow[] = [];

  for (const entityId of entityIds) {
    const entity = entities[entityId];
    if (!entity || entity.parentId !== null) continue;

    if (!entity.isFolder) {
      if (!query || matchesSearch(entity, query)) rows.push({ entity, depth: 0 });
      continue;
    }

    const children = entity.childrenIds.map((childId) => entities[childId]).filter((child): child is Entity => Boolean(child));
    const folderMatches = !query || matchesSearch(entity, query);
    const visibleChildren = folderMatches ? children : children.filter((child) => matchesSearch(child, query));

    if (folderMatches || visibleChildren.length > 0) {
      rows.push({ entity, depth: 0 });
      if (!query && collapsedFolderIds.has(entity.id)) continue;
      for (const child of visibleChildren) {
        rows.push({ entity: child, depth: 1 });
      }
    }
  }

  return rows;
}

/** 从拖拽数据中读取 Hierarchy 实体 ID 列表。 */
function readHierarchyDragPayload(event: DragEvent<HTMLElement>): HierarchyDragPayload | null {
  try {
    const rawPayload = event.dataTransfer.getData(HIERARCHY_DRAG_MIME_TYPE);
    const payload: unknown = JSON.parse(rawPayload);

    if (typeof payload !== 'object' || payload === null || !Array.isArray((payload as HierarchyDragPayload).ids)) {
      return null;
    }

    const ids = (payload as HierarchyDragPayload).ids.filter((id): id is string => typeof id === 'string');
    return ids.length > 0 ? { ids } : null;
  } catch {
    return null;
  }
}

/** 右键菜单使用固定定位，并在窗口边缘自动内收，避免菜单被裁掉。 */
function getContextMenuPosition(clientX: number, clientY: number): { x: number; y: number } {
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const x = Math.min(clientX, Math.max(8, viewportWidth - CONTEXT_MENU_WIDTH - 8));
  const y = Math.min(clientY, Math.max(8, viewportHeight - CONTEXT_MENU_HEIGHT - 8));

  return { x, y };
}

/** 判断实体是否被自身或直属父文件夹锁定，用于菜单禁用态展示。 */
function isEntityEffectivelyLocked(entities: Record<string, Entity>, entity: Entity | null | undefined): boolean {
  if (!entity) return false;
  if (entity.locked) return true;
  if (!entity.parentId) return false;

  return entities[entity.parentId]?.locked === true;
}

type HierarchyPanelProps = {
  readOnly?: boolean;
};

export function HierarchyPanel(props: HierarchyPanelProps) {
  const scene = useEditorStore((state) => state.scene);
  const sceneName = useEditorStore((state) => state.scene.name);
  const entityIds = useEditorStore((state) => state.scene.entityIds);
  const entities = useEditorStore((state) => state.scene.entities);
  const selectedEntityId = useEditorStore((state) => state.scene.selectedEntityId);
  const hierarchySelectionIds = useEditorStore((state) => state.hierarchySelectionIds);
  const createFolder = useEditorStore((state) => state.createFolder);
  const selectHierarchyEntities = useEditorStore((state) => state.selectHierarchyEntities);
  const moveEntitiesToFolder = useEditorStore((state) => state.moveEntitiesToFolder);
  const toggleEntityVisible = useEditorStore((state) => state.toggleEntityVisible);
  const toggleEntityLocked = useEditorStore((state) => state.toggleEntityLocked);
  const entityClipboard = useEditorStore((state) => state.entityClipboard);
  const hideSelectedEntities = useEditorStore((state) => state.hideSelectedEntities);
  const lockSelectedEntities = useEditorStore((state) => state.lockSelectedEntities);
  const copySelectedEntities = useEditorStore((state) => state.copySelectedEntities);
  const pasteEntityClipboard = useEditorStore((state) => state.pasteEntityClipboard);
  const requestEntityArray = useEditorStore((state) => state.requestEntityArray);
  const groupSelectedEntities = useEditorStore((state) => state.groupSelectedEntities);
  const ungroupSelectedEntities = useEditorStore((state) => state.ungroupSelectedEntities);
  const requestSceneFocusForSelection = useEditorStore((state) => state.requestSceneFocusForSelection);
  const requestProjectAssetFocusForEntity = useEditorStore((state) => state.requestProjectAssetFocusForEntity);
  const renameSelectedEntity = useEditorStore((state) => state.renameSelectedEntity);
  const deleteSelectedEntity = useEditorStore((state) => state.deleteSelectedEntity);
  const [searchText, setSearchText] = useState('');
  const [collapsedFolderIds, setCollapsedFolderIds] = useState<Set<string>>(() => new Set());
  const [lastClickedIndex, setLastClickedIndex] = useState<number | null>(null);
  const [contextMenu, setContextMenu] = useState<HierarchyContextMenuState | null>(null);
  const [renamingEntityId, setRenamingEntityId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [arrayDialog, setArrayDialog] = useState<ArrayDialogState | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const rows = useMemo(
    () => buildHierarchyRows(entityIds, entities, searchText, collapsedFolderIds),
    [entityIds, entities, searchText, collapsedFolderIds],
  );
  const hierarchySelectionIdSet = useMemo(() => new Set(hierarchySelectionIds), [hierarchySelectionIds]);
  const rowIndexByEntityId = useMemo(() => {
    const indexByEntityId = new Map<string, number>();
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
      indexByEntityId.set(rows[rowIndex].entity.id, rowIndex);
    }
    return indexByEntityId;
  }, [rows]);
  const virtualWindow = useMemo(
    () => calculateHierarchyVirtualWindow(rows.length, scrollTop, viewportHeight),
    [rows.length, scrollTop, viewportHeight],
  );
  const virtualRows = useMemo(
    () => rows.slice(virtualWindow.startIndex, virtualWindow.endIndex),
    [rows, virtualWindow.endIndex, virtualWindow.startIndex],
  );

  const contextEntity = contextMenu ? entities[contextMenu.entityId] ?? null : null;
  const activeSelectionIds = useMemo(
    () => hierarchySelectionIds.filter((entityId) => Boolean(entities[entityId])),
    [hierarchySelectionIds, entities],
  );
  const activeSelectionEntities = activeSelectionIds.map((entityId) => entities[entityId]).filter((entity): entity is Entity => Boolean(entity));
  const hasSelection = activeSelectionIds.length > 0;
  const canMutateSelection = !props.readOnly && activeSelectionEntities.some((entity) => !isEntityEffectivelyLocked(entities, entity));
  const canMutateRuntimeSelection = activeSelectionEntities.some(
    (entity) => !props.readOnly && !entity.isFolder && !isEntityEffectivelyLocked(entities, entity),
  );
  const canRenameSelection = activeSelectionIds.length === 1 && canMutateSelection;
  const canLibraryFocus = Boolean(contextEntity?.components.modelAsset);
  const canPaste = !props.readOnly && Boolean(entityClipboard && entityClipboard.entries.length > 0);
  const canUngroup = !props.readOnly && activeSelectionEntities.some((entity) => entity.isFolder || Boolean(entity.parentId));
  const arraySourceEntities = activeSelectionEntities.filter(
    (entity) => !entity.isFolder && !isEntityEffectivelyLocked(entities, entity),
  );
  const assetNumberedArraySourceCount = arraySourceEntities.filter(
    (entity) => Boolean(entity.components.modelAsset || entity.components.locator),
  ).length;
  const arrayValidationError = arrayDialog
    ? getEntityArrayIdentifierError(
        scene,
        arraySourceEntities.map((entity) => entity.id),
        arrayDialog.copyCount,
        arrayDialog.assetNumberRule,
      )
    : null;

  /** 执行菜单动作后统一收起菜单，保持右键菜单只响应一次命令。 */
  function runContextMenuAction(action: () => void): void {
    action();
    setContextMenu(null);
  }

  /** 根据右键所在行推导粘贴目标：文件夹内粘贴，普通对象贴到同级。 */
  function getContextPasteFolderId(): string | null {
    if (!contextEntity) return null;
    if (contextEntity.isFolder) return contextEntity.id;
    return contextEntity.parentId;
  }

  /** 打开模型阵列弹窗，确认后由 SceneRuntime 解析选区包围盒再执行可撤销阵列命令。 */
  function openArrayDialog(): void {
    if (props.readOnly) return;
    setArrayDialog({ copyCount: 3, direction: 'x', spacingMeters: 1, assetNumberRule: '' });
    setContextMenu(null);
  }

  /** 提交行内重命名，空名称由 store 侧继续过滤。 */
  function commitRename(): void {
    if (props.readOnly) return;
    if (!renamingEntityId) return;
    renameSelectedEntity(renameDraft);
    setRenamingEntityId(null);
    setRenameDraft('');
  }

  /** 取消当前行内重命名，不写入命令历史。 */
  function cancelRename(): void {
    setRenamingEntityId(null);
    setRenameDraft('');
  }

  /** 重命名输入框只拦截提交/取消快捷键，避免影响全局快捷键。 */
  function handleRenameKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      commitRename();
      return;
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      cancelRename();
    }
  }

  /** 提交线性模型阵列参数。 */
  function submitArrayDialog(): void {
    if (props.readOnly) return;
    if (!arrayDialog) return;
    requestEntityArray(
      arrayDialog.copyCount,
      arrayDialog.direction,
      arrayDialog.spacingMeters,
      arrayDialog.assetNumberRule,
    );
    setArrayDialog(null);
  }

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const observedList = list;

    /** 同步面板可用高度；布局拖拽和窗口缩放都可能改变虚拟视口。 */
    function updateViewportSize(): void {
      setViewportHeight((current) => (current === observedList.clientHeight ? current : observedList.clientHeight));
      setScrollTop((current) => (current === observedList.scrollTop ? current : observedList.scrollTop));
    }

    updateViewportSize();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', updateViewportSize);
      return () => window.removeEventListener('resize', updateViewportSize);
    }

    const resizeObserver = new ResizeObserver(updateViewportSize);
    resizeObserver.observe(observedList);
    return () => resizeObserver.disconnect();
  }, []);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list || Math.abs(list.scrollTop - virtualWindow.scrollTop) < 0.5) return;

    // 搜索或折叠导致总行数缩小时，将原滚动位置收回新的合法范围。
    list.scrollTop = virtualWindow.scrollTop;
    setScrollTop(virtualWindow.scrollTop);
  }, [virtualWindow.scrollTop, virtualWindow.totalHeight]);

  useLayoutEffect(() => {
    const targetEntityId = renamingEntityId ?? selectedEntityId;
    if (!targetEntityId || viewportHeight <= 0) return;

    const targetRowIndex = rowIndexByEntityId.get(targetEntityId);
    const list = listRef.current;
    if (targetRowIndex === undefined || !list) return;

    const nextScrollTop = getHierarchyScrollTopForIndex(
      targetRowIndex,
      rows.length,
      list.scrollTop,
      viewportHeight,
    );
    if (Math.abs(nextScrollTop - list.scrollTop) < 0.5) return;

    list.scrollTop = nextScrollTop;
    setScrollTop(nextScrollTop);
  }, [renamingEntityId, rowIndexByEntityId, rows.length, selectedEntityId, viewportHeight]);

  useEffect(() => {
    if (!contextMenu) return;

    /** 点击菜单外侧或窗口尺寸变化时收起临时浮层。 */
    function closeFloatingUi(): void {
      setContextMenu(null);
    }

    /** Escape 取消当前上下文菜单。 */
    function handleWindowKeyDown(event: globalThis.KeyboardEvent): void {
      if (event.key !== 'Escape') return;
      setContextMenu(null);
    }

    window.addEventListener('resize', closeFloatingUi);
    window.addEventListener('scroll', closeFloatingUi, true);
    window.addEventListener('keydown', handleWindowKeyDown);
    document.addEventListener('mousedown', closeFloatingUi);

    return () => {
      window.removeEventListener('resize', closeFloatingUi);
      window.removeEventListener('scroll', closeFloatingUi, true);
      window.removeEventListener('keydown', handleWindowKeyDown);
      document.removeEventListener('mousedown', closeFloatingUi);
    };
  }, [contextMenu]);

  /** 滚动时只更新虚拟窗口，不改变选区或树结构。 */
  function handleListScroll(event: UIEvent<HTMLDivElement>): void {
    const nextScrollTop = event.currentTarget.scrollTop;
    setScrollTop((current) => (current === nextScrollTop ? current : nextScrollTop));
  }

  /** 根据普通点击、Ctrl/Cmd 点击与 Shift 点击更新 Hierarchy 多选。 */
  function handleRowClick(event: MouseEvent<HTMLDivElement>, row: HierarchyRow, rowIndex: number): void {
    const entityId = row.entity.id;

    if (event.shiftKey && lastClickedIndex !== null) {
      const start = Math.min(lastClickedIndex, rowIndex);
      const end = Math.max(lastClickedIndex, rowIndex);
      const rangeIds = rows.slice(start, end + 1).map(({ entity }) => entity.id);
      selectHierarchyEntities(rangeIds, entityId);
      return;
    }

    if (event.ctrlKey || event.metaKey) {
      const nextIds = hierarchySelectionIdSet.has(entityId)
        ? hierarchySelectionIds.filter((selectedId) => selectedId !== entityId)
        : [...hierarchySelectionIds, entityId];
      const nextSelectionIdSet = new Set(nextIds);
      selectHierarchyEntities(nextIds, nextSelectionIdSet.has(entityId) ? entityId : nextIds[0] ?? null);
      setLastClickedIndex(rowIndex);
      return;
    }

    selectHierarchyEntities([entityId], entityId);
    setLastClickedIndex(rowIndex);
  }

  /** 右键未落在当前选区时先切换为单选，落在选区内则保留多选集合。 */
  function handleRowContextMenu(event: MouseEvent<HTMLDivElement>, row: HierarchyRow, rowIndex: number): void {
    event.preventDefault();
    event.stopPropagation();

    const entityId = row.entity.id;
    if (!hierarchySelectionIdSet.has(entityId)) {
      selectHierarchyEntities([entityId], entityId);
      setLastClickedIndex(rowIndex);
    }

    setContextMenu({
      entityId,
      ...getContextMenuPosition(event.clientX, event.clientY),
    });
  }

  /** 展开或折叠文件夹，仅影响左侧模型树显示。 */
  function handleFolderToggle(event: MouseEvent<HTMLButtonElement>, folderId: string): void {
    event.stopPropagation();
    setCollapsedFolderIds((current) => {
      const next = new Set(current);
      if (next.has(folderId)) {
        next.delete(folderId);
      } else {
        next.add(folderId);
      }
      return next;
    });
  }

  /** 开始拖拽时携带当前多选中的普通实体，文件夹自身不参与分组移动。 */
  function handleRowDragStart(event: DragEvent<HTMLDivElement>, entity: Entity): void {
    if (entity.isFolder) {
      event.preventDefault();
      return;
    }

    const ids = (hierarchySelectionIdSet.has(entity.id) ? hierarchySelectionIds : [entity.id])
      .filter((entityId) => {
        const selectedEntity = entities[entityId];
        return Boolean(selectedEntity && !selectedEntity.isFolder);
      });

    if (ids.length === 0) {
      event.preventDefault();
      return;
    }

    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData(HIERARCHY_DRAG_MIME_TYPE, JSON.stringify({ ids }));
    event.dataTransfer.setData('text/plain', ids.map((entityId) => entities[entityId]?.name).filter(Boolean).join(', '));
  }

  /** 文件夹或根层级接收 Hierarchy 实体拖入。 */
  function handleDrop(event: DragEvent<HTMLDivElement>, folderId: string | null): void {
    const payload = readHierarchyDragPayload(event);
    if (!payload) return;

    event.preventDefault();
    event.stopPropagation();
    moveEntitiesToFolder(payload.ids, folderId);
  }

  /** 仅当拖拽数据来自 Hierarchy 时允许 drop。 */
  function handleDragOver(event: DragEvent<HTMLDivElement>): void {
    if (!event.dataTransfer.types.includes(HIERARCHY_DRAG_MIME_TYPE)) return;

    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }

  /** 切换显示状态时阻止行点击选中被重复触发。 */
  function handleVisibleClick(event: MouseEvent<HTMLButtonElement>, entityId: string): void {
    event.stopPropagation();
    toggleEntityVisible(entityId);
  }

  /** 切换锁定状态时阻止行点击选中被重复触发。 */
  function handleLockedClick(event: MouseEvent<HTMLButtonElement>, entityId: string): void {
    event.stopPropagation();
    toggleEntityLocked(entityId);
  }

  return (
    <section className="panel hierarchy-panel">
      <div className="hierarchy-scene-title">{sceneName}</div>
      <div className="hierarchy-tab-label">模型树</div>
      <div className="hierarchy-toolbar">
        <label className="hierarchy-search-box">
          <span className="hierarchy-search-icon" aria-hidden="true">⌕</span>
          <input
            aria-label="搜索模型树对象"
            className="hierarchy-search-input"
            placeholder="请输入关键字搜索..."
            type="search"
            value={searchText}
            onChange={(event) => setSearchText(event.target.value)}
          />
        </label>
        <button className="hierarchy-new-folder-button" disabled={props.readOnly} onClick={createFolder} type="button">
          + 新建
        </button>
      </div>
      {entityIds.length === 0 ? <p className="muted">点击顶部工具栏创建对象。</p> : null}
      <div
        className="entity-list"
        onDragOver={props.readOnly ? undefined : handleDragOver}
        onDrop={props.readOnly ? undefined : (event) => handleDrop(event, null)}
        onScroll={handleListScroll}
        ref={listRef}
      >
        {rows.length === 0 && entityIds.length > 0 ? <p className="muted">没有匹配对象。</p> : null}
        {rows.length > 0 ? (
          <div className="hierarchy-virtual-spacer" style={{ height: virtualWindow.totalHeight }}>
            <div
              className="hierarchy-virtual-window"
              style={{ transform: `translateY(${virtualWindow.offsetTop}px)` }}
            >
              {virtualRows.map((row, virtualRowIndex) => {
                const rowIndex = virtualWindow.startIndex + virtualRowIndex;
                const entity = row.entity;
                const isFolder = entity.isFolder === true;
                const isSelected = hierarchySelectionIdSet.has(entity.id);
                const isPrimarySelected = entity.id === selectedEntityId;
                const isVisible = entity.visible !== false;
                const isLocked = entity.locked === true;
                const isCollapsed = isFolder && collapsedFolderIds.has(entity.id) && !searchText.trim();
                const rowClassName = [
                  'entity-tree-row',
                  isSelected ? 'selected' : '',
                  isPrimarySelected ? 'primary-selected' : '',
                  isFolder ? 'folder' : '',
                  !isVisible ? 'hidden' : '',
                  isLocked ? 'locked' : '',
                ].filter(Boolean).join(' ');

                return (
                  <div
                    className={rowClassName}
                    draggable={!props.readOnly && !isFolder}
                    key={entity.id}
                    onClick={(event) => handleRowClick(event, row, rowIndex)}
                    onContextMenu={(event) => handleRowContextMenu(event, row, rowIndex)}
                    onDragOver={!props.readOnly && isFolder ? handleDragOver : undefined}
                    onDragStart={props.readOnly ? undefined : (event) => handleRowDragStart(event, entity)}
                    onDrop={!props.readOnly && isFolder ? (event) => handleDrop(event, entity.id) : undefined}
                    style={{ '--entity-depth': row.depth } as CSSProperties}
                    title={entity.name}
                  >
                    <button
                      aria-label={isVisible ? `隐藏 ${entity.name}` : `显示 ${entity.name}`}
                      className="entity-state-button"
                      disabled={props.readOnly}
                      onClick={(event) => handleVisibleClick(event, entity.id)}
                      title={isVisible ? '隐藏' : '显示'}
                      type="button"
                    >
                      <span
                        className={isVisible ? 'entity-eye-icon' : 'entity-eye-icon entity-eye-icon-hidden'}
                        aria-hidden="true"
                      />
                    </button>
                    <button
                      aria-label={isLocked ? `解锁 ${entity.name}` : `锁定 ${entity.name}`}
                      className="entity-state-button"
                      disabled={props.readOnly}
                      onClick={(event) => handleLockedClick(event, entity.id)}
                      title={isLocked ? '解锁' : '锁定'}
                      type="button"
                    >
                      <span
                        className={isLocked ? 'entity-lock-icon locked' : 'entity-lock-icon'}
                        aria-hidden="true"
                      />
                    </button>
                    <span className="entity-tree-indent" aria-hidden="true" />
                    <button
                      aria-label={isFolder ? (isCollapsed ? `展开 ${entity.name}` : `折叠 ${entity.name}`) : undefined}
                      className={isFolder ? 'entity-tree-toggle' : 'entity-tree-toggle entity-tree-toggle-placeholder'}
                      disabled={!isFolder}
                      onClick={isFolder ? (event) => handleFolderToggle(event, entity.id) : undefined}
                      tabIndex={isFolder ? 0 : -1}
                      title={isFolder ? (isCollapsed ? '展开' : '折叠') : undefined}
                      type="button"
                    >
                      {isFolder ? (isCollapsed ? '▶' : '▼') : ''}
                    </button>
                    <span
                      className={isFolder ? 'entity-type-icon entity-type-folder' : 'entity-type-icon entity-type-object'}
                      aria-hidden="true"
                    >
                      {isFolder ? '▦' : '◎'}
                    </span>
                    {renamingEntityId === entity.id ? (
                      <input
                        autoFocus
                        className="entity-tree-rename-input"
                        disabled={props.readOnly}
                        onBlur={commitRename}
                        onChange={(event) => setRenameDraft(event.target.value)}
                        onClick={(event) => event.stopPropagation()}
                        onKeyDown={handleRenameKeyDown}
                        onMouseDown={(event) => event.stopPropagation()}
                        value={renameDraft}
                      />
                    ) : (
                      <span className="entity-tree-name">{entity.name}</span>
                    )}
                    {isFolder ? <span className="entity-folder-count">{entity.childrenIds.length}</span> : null}
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}
      </div>
      {contextMenu && contextEntity ? (
        <div
          className="hierarchy-context-menu"
          onContextMenu={(event) => event.preventDefault()}
          onMouseDown={(event) => event.stopPropagation()}
          role="menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <div className="hierarchy-context-menu-title">
            {activeSelectionIds.length > 1 ? `已选 ${activeSelectionIds.length} 个对象` : contextEntity.name}
          </div>
          <div className="hierarchy-context-menu-separator" />
          <button
            className="hierarchy-context-menu-item"
            disabled={!hasSelection}
            onClick={() => runContextMenuAction(requestSceneFocusForSelection)}
            role="menuitem"
            type="button"
          >
            <span>场景聚焦</span>
            <kbd>F</kbd>
          </button>
          <button
            className="hierarchy-context-menu-item"
            disabled={!canLibraryFocus}
            onClick={() => runContextMenuAction(() => requestProjectAssetFocusForEntity(contextEntity.id))}
            role="menuitem"
            type="button"
          >
            <span>库聚焦</span>
          </button>
          <div className="hierarchy-context-menu-separator" />
          <button
            className="hierarchy-context-menu-item"
            disabled={!canMutateSelection}
            onClick={() => runContextMenuAction(hideSelectedEntities)}
            role="menuitem"
            type="button"
          >
            <span>隐藏对象</span>
            <kbd>H</kbd>
          </button>
          <button
            className="hierarchy-context-menu-item"
            disabled={props.readOnly || !hasSelection}
            onClick={() => runContextMenuAction(copySelectedEntities)}
            role="menuitem"
            type="button"
          >
            <span>复制</span>
            <kbd>Ctrl+C</kbd>
          </button>
          <button
            className="hierarchy-context-menu-item"
            disabled={!canPaste}
            onClick={() => runContextMenuAction(() => pasteEntityClipboard(getContextPasteFolderId()))}
            role="menuitem"
            type="button"
          >
            <span>粘贴</span>
            <kbd>Ctrl+V</kbd>
          </button>
          <button
            className="hierarchy-context-menu-item"
            disabled={!canMutateRuntimeSelection}
            onClick={openArrayDialog}
            role="menuitem"
            type="button"
          >
            <span>模型阵列</span>
          </button>
          <button
            className="hierarchy-context-menu-item"
            disabled={!canMutateSelection}
            onClick={() => runContextMenuAction(lockSelectedEntities)}
            role="menuitem"
            type="button"
          >
            <span>锁定对象</span>
            <kbd>Ctrl+K</kbd>
          </button>
          <div className="hierarchy-context-menu-separator" />
          <button
            className="hierarchy-context-menu-item"
            disabled={!canRenameSelection}
            onClick={() => runContextMenuAction(() => {
              setRenamingEntityId(contextEntity.id);
              setRenameDraft(contextEntity.name);
            })}
            role="menuitem"
            type="button"
          >
            <span>重命名</span>
          </button>
          <button
            className="hierarchy-context-menu-item"
            disabled={!canMutateSelection}
            onClick={() => runContextMenuAction(deleteSelectedEntity)}
            role="menuitem"
            type="button"
          >
            <span>删除</span>
            <kbd>Delete</kbd>
          </button>
          <button
            className="hierarchy-context-menu-item"
            disabled={!canMutateRuntimeSelection}
            onClick={() => runContextMenuAction(groupSelectedEntities)}
            role="menuitem"
            type="button"
          >
            <span>群组对象</span>
            <kbd>Ctrl+G</kbd>
          </button>
          <button
            className="hierarchy-context-menu-item"
            disabled={!canUngroup}
            onClick={() => runContextMenuAction(ungroupSelectedEntities)}
            role="menuitem"
            type="button"
          >
            <span>解组对象</span>
            <kbd>Shift+G</kbd>
          </button>
        </div>
      ) : null}
      {arrayDialog ? (
        <EntityArrayDialog
          assetNumberedSourceCount={assetNumberedArraySourceCount}
          onCancel={() => setArrayDialog(null)}
          onChange={setArrayDialog}
          onConfirm={submitArrayDialog}
          readOnly={props.readOnly}
          validationError={arrayValidationError}
          value={arrayDialog}
        />
      ) : null}
    </section>
  );
}
