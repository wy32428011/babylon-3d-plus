# Toolbar 图标化按钮设计规格

## 背景

当前 Toolbar 中的按钮直接显示中文文本，例如移动、旋转、缩放、局部、全局、创建半球光、删除、撤销、重做、保存场景、加载场景。用户希望将工具栏中的按钮换成图标形式显示，不在按钮内部显示中文，从而提升工具栏视觉密度和编辑器工具感。

## 已确认需求

- 仅图标化 Toolbar 中的 `button`。
- 按钮内部不显示中文文本。
- 保留非按钮标签文字：`吸附`、`位置 (m)`、`旋转`、`缩放` 和标题 `Babylon Unity-like Editor`。
- 保留按钮中文说明到 `title` 与 `aria-label`，用于悬停提示和无障碍访问。
- 不改变 W/E/R 快捷键、工具切换、吸附、半球光创建、删除、撤销、重做、保存、加载等功能。
- 不新增图标库依赖。

## 方案

采用无依赖 Unicode/SVG-lite 文本图标方案。每个按钮显示一个图标字符，中文标签只保留在 `title` 与 `aria-label` 中。

## 图标映射

| 功能 | 图标 | 说明 |
|---|---:|---|
| 移动 | `↔` | Transform translate 工具 |
| 旋转 | `⟳` | Transform rotate 工具 |
| 缩放 | `⛶` | Transform scale 工具 |
| 局部坐标 | `⌖` | Local transform space |
| 全局坐标 | `◎` | Global transform space |
| 创建半球光 | `◐` | 创建 Hemispheric Light |
| 删除 | `⌫` | 删除当前选中实体 |
| 撤销 | `↶` | Undo |
| 重做 | `↷` | Redo |
| 保存场景 | `💾` | 保存当前场景 |
| 加载场景 | `📂` | 加载场景 |

## 组件设计

在 `src/editor/ui/Toolbar.tsx` 中新增 `ToolbarIconButton` 小组件：

- 接收 `icon`、`label`、`active`、`disabled`、`onClick`。
- 使用 `label` 写入 `title` 和 `aria-label`。
- 按钮内部只渲染 `icon`。
- 图标包裹在 `span aria-hidden="true"` 中，避免读屏重复读取符号。
- active 状态继续使用现有 `.toolbar-button.active` 样式。

Toolbar 内所有按钮改用 `ToolbarIconButton`：

- 移动
- 旋转
- 缩放
- 局部
- 全局
- 创建半球光
- 删除
- 撤销
- 重做
- 保存场景
- 加载场景

## 样式设计

在 `src/styles/global.css` 中新增 `.toolbar-icon-button`：

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

目标：

- 统一按钮宽度。
- 让图标居中。
- 保持现有 toolbar 按钮边框、颜色、禁用态、active 态。

## 文档设计

更新 `README.md`：

- 说明 Toolbar 使用图标按钮，悬停可查看中文提示。
- “创建半球光”改为点击 Toolbar 半球光图标按钮。
- “切换 Gizmo”说明保留 W/E/R 快捷键，并说明图标按钮可切换移动/旋转/缩放。
- 最近完成新增 Toolbar 图标化记录。

## 验证计划

- 运行 `npm run typecheck`。
- 运行 `git diff --check`。
- 浏览器验证：
  - Toolbar 按钮内部不显示中文。
  - Toolbar 按钮 `title` / `aria-label` 保留中文。
  - `吸附`、`位置 (m)`、`旋转`、`缩放` 仍显示文字。
  - 点击移动、旋转、缩放图标能切换 active 状态。
  - 创建半球光图标按钮仍存在。
  - 保存、加载、删除、撤销、重做图标按钮仍存在。

## 成功标准

- Toolbar 按钮视觉上只显示图标，不显示中文按钮文本。
- 中文说明仍可通过 `title` 和 `aria-label` 获取。
- TypeScript 检查通过。
- README 与实际 Toolbar 行为一致。
