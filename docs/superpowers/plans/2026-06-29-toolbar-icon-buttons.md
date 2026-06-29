# Toolbar Icon Buttons Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Toolbar 的按钮视觉改为纯图标显示，按钮内部不显示中文，同时通过 `title` 和 `aria-label` 保留中文说明。

**Architecture:** 在 `Toolbar.tsx` 中新增统一 `ToolbarIconButton` 小组件集中处理图标、active、disabled、title 与 aria-label；在 `global.css` 中新增图标按钮尺寸与居中样式；README 同步说明工具栏图标化入口。功能状态、store、快捷键和命令历史不变。

**Tech Stack:** React、TypeScript、CSS、Markdown。

---

## 文件结构与职责

- 修改：`src/editor/ui/Toolbar.tsx`
  - 新增 `ToolbarIconButton`。
  - 将所有 Toolbar button 改为图标按钮。
  - 保留非按钮文字标签。

- 修改：`src/styles/global.css`
  - 新增 `.toolbar-icon-button` 样式。

- 修改：`README.md`
  - 更新基础操作和最近完成记录。

## 执行任务

### Task 1: 将 Toolbar 按钮替换为图标按钮

**Files:**
- Modify: `src/editor/ui/Toolbar.tsx:8-130`

- [ ] **Step 1: 新增图标映射常量**

在 label 常量下方加入：

```ts
const TOOLBAR_ICONS = {
  translate: '↔',
  rotate: '⟳',
  scale: '⛶',
  local: '⌖',
  global: '◎',
  hemisphericLight: '◐',
  delete: '⌫',
  undo: '↶',
  redo: '↷',
  save: '💾',
  load: '📂',
} as const;
```

- [ ] **Step 2: 新增 ToolbarIconButton 组件**

在 `ToolbarProps` 后、`Toolbar` 前加入：

```tsx
type ToolbarIconButtonProps = {
  active?: boolean;
  disabled?: boolean;
  icon: string;
  label: string;
  onClick: () => void;
};

function ToolbarIconButton(props: ToolbarIconButtonProps) {
  return (
    <button
      aria-label={props.label}
      className={props.active ? 'toolbar-button toolbar-icon-button active' : 'toolbar-button toolbar-icon-button'}
      disabled={props.disabled}
      onClick={props.onClick}
      title={props.label}
      type="button"
    >
      <span aria-hidden="true">{props.icon}</span>
    </button>
  );
}
```

- [ ] **Step 3: 替换移动/旋转/缩放按钮**

将三个工具按钮替换为：

```tsx
<ToolbarIconButton
  active={props.transformTool === 'translate'}
  icon={TOOLBAR_ICONS.translate}
  label={TRANSFORM_TOOL_LABELS.translate}
  onClick={() => props.onSetTransformTool('translate')}
/>
<ToolbarIconButton
  active={props.transformTool === 'rotate'}
  icon={TOOLBAR_ICONS.rotate}
  label={TRANSFORM_TOOL_LABELS.rotate}
  onClick={() => props.onSetTransformTool('rotate')}
/>
<ToolbarIconButton
  active={props.transformTool === 'scale'}
  icon={TOOLBAR_ICONS.scale}
  label={TRANSFORM_TOOL_LABELS.scale}
  onClick={() => props.onSetTransformTool('scale')}
/>
```

- [ ] **Step 4: 替换局部/全局按钮**

将坐标空间两个按钮替换为：

```tsx
<ToolbarIconButton
  active={props.transformSpace === 'local'}
  icon={TOOLBAR_ICONS.local}
  label={TRANSFORM_SPACE_LABELS.local}
  onClick={() => props.onSetTransformSpace('local')}
/>
<ToolbarIconButton
  active={props.transformSpace === 'global'}
  icon={TOOLBAR_ICONS.global}
  label={TRANSFORM_SPACE_LABELS.global}
  onClick={() => props.onSetTransformSpace('global')}
/>
```

- [ ] **Step 5: 替换剩余操作按钮**

将底部六个操作按钮替换为：

```tsx
<ToolbarIconButton icon={TOOLBAR_ICONS.hemisphericLight} label="创建半球光" onClick={props.onCreateHemisphericLight} />
<ToolbarIconButton disabled={!props.canDelete} icon={TOOLBAR_ICONS.delete} label="删除" onClick={props.onDeleteSelectedEntity} />
<ToolbarIconButton disabled={!props.canUndo} icon={TOOLBAR_ICONS.undo} label="撤销" onClick={props.onUndo} />
<ToolbarIconButton disabled={!props.canRedo} icon={TOOLBAR_ICONS.redo} label="重做" onClick={props.onRedo} />
<ToolbarIconButton icon={TOOLBAR_ICONS.save} label="保存场景" onClick={props.onSaveScene} />
<ToolbarIconButton icon={TOOLBAR_ICONS.load} label="加载场景" onClick={props.onLoadScene} />
```

### Task 2: 添加图标按钮样式

**Files:**
- Modify: `src/styles/global.css:69-90`

- [ ] **Step 1: 新增 `.toolbar-icon-button` 样式**

在 `.toolbar button` 后加入：

```css
.toolbar-icon-button {
  display: inline-grid;
  place-items: center;
  width: 32px;
  min-width: 32px;
  padding: 0;
  font-size: 16px;
  line-height: 1;
}
```

Expected: `.toolbar-button.active` 继续能作用于图标按钮。

### Task 3: 更新 README 并验证

**Files:**
- Modify: `README.md:64-122`

- [ ] **Step 1: 更新基础操作文字**

将：

```markdown
- 创建半球光：点击顶部工具栏的 `创建半球光`。
```

改为：

```markdown
- 创建半球光：点击顶部工具栏的半球光图标按钮；工具栏按钮以图标显示，悬停可查看中文提示。
```

将：

```markdown
- 切换 Gizmo：点击 `移动`、`旋转`、`缩放`，或使用 W/E/R 快捷键。
```

改为：

```markdown
- 切换 Gizmo：点击顶部工具栏的移动、旋转、缩放图标按钮，或使用 W/E/R 快捷键。
```

- [ ] **Step 2: 更新最近完成**

在最近完成顶部插入：

```markdown
- 2026-06-29：Toolbar 按钮切换为纯图标显示，并通过悬停提示和无障碍标签保留中文说明。
```

- [ ] **Step 3: 运行类型检查**

Run:

```bash
npm run typecheck
```

Expected: `tsc -b` 通过，退出码为 0。

- [ ] **Step 4: 运行 diff 检查**

Run:

```bash
git diff --check -- src/editor/ui/Toolbar.tsx src/styles/global.css README.md docs/superpowers/specs/2026-06-29-toolbar-icon-buttons-design.md docs/superpowers/plans/2026-06-29-toolbar-icon-buttons.md
```

Expected: 不出现 whitespace error；Windows 行尾提示不视为失败。

- [ ] **Step 5: 浏览器验证**

启动 Vite 并检查：

- Toolbar button textContent 不包含中文按钮文本。
- Toolbar button 的 `aria-label` 包含移动、旋转、缩放、局部、全局、创建半球光、删除、撤销、重做、保存场景、加载场景。
- Toolbar 页面可见文本仍包含吸附、位置 (m)、旋转、缩放。
- 点击旋转/缩放/移动图标可以切换 active 状态。

## 自审记录

- 规格覆盖：覆盖按钮纯图标显示、中文 title/aria-label 保留、非按钮标签保留、README 更新和验证。
- 占位扫描：没有占位符。
- 类型一致性：`ToolbarIconButton` props 与使用位置一致；图标 key 与功能名称一致。
- 提交策略：当前会话未收到显式 git commit 请求，因此不包含提交步骤。
