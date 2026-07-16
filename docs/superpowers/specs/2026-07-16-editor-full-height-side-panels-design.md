# 编辑器三栏贯通布局设计规格

## 背景

当前编辑器根布局分成 Toolbar、三栏工作区和全宽底部资源库三行。因为 `ProjectPanel` 位于三栏工作区之外，底部模型库会横跨左侧 Hierarchy、中间 Scene 和右侧 Inspector 的总宽度，左右面板也会在模型库上方提前结束。

本次目标是调整为 Unity-like 的三栏贯通结构：左侧模型树和右侧属性面板从 Toolbar 下方一直延伸到窗口底部，中间列上方为 Scene 画布，下方为 Project 模型库与 Console 入口，Project 宽度始终与 Scene 画布列一致。

## 已确认需求

- 左侧 Hierarchy/模型树延伸至编辑器底部。
- 右侧 Inspector/属性面板延伸至编辑器底部。
- Project/模型库只占中间列宽度，与 Scene 画布等宽。
- Console 继续作为 Project 区域底部的 30px 收纳入口，完整日志仍使用弹窗。
- 保留现有左右栏宽度、Project 高度和 `1024×640` 自适应边界。
- 不新增拖拽分隔条、布局持久化、窗口监听或场景状态。
- 不修改 Hierarchy、Inspector、Project、Scene 或 Console 的业务数据流。

## 方案比较

### 方案 A：Project 下沉到中间列（推荐）

保留 `.workspace` 三列结构，把 `bottomWorkspace` 移入 `.centerColumn`，并让中间列使用“Scene + Project”两行。`.editorShell` 从三行改为“Toolbar + workspace”两行。

优点：

- DOM 与视觉结构一致，左右栏天然贯通到底部。
- Project 天然继承中间列宽度，不需要计算左右栏宽度。
- 只修改 `EditorLayout.tsx` 和 `EditorLayout.module.css`，不影响面板内部实现。
- 继续复用现有 `clamp()` 高度和三列响应式宽度。

### 方案 B：根节点改为 Grid Areas

把 Toolbar、Hierarchy、Scene、Inspector、Project 全部提升为 `.editorShell` 直接子节点，并使用命名网格区域。

该方案视觉表达直接，但需要重排更多 JSX 结构和样式选择器，改动面大于本次需求。

### 方案 C：使用 `display: contents` 或 `subgrid`

保留现有 DOM，通过 `display: contents` 或 CSS Subgrid 让嵌套元素参与根网格。

该方案依赖更隐式的布局行为，调试和后续维护成本更高，不适合作为当前 MVP 的最小修复。

## 推荐设计

采用方案 A。

### `EditorLayout.tsx`

- `.workspace` 仍包含左、中、右三列。
- `.leftColumn` 继续承载 `HierarchyPanel`。
- `.rightColumn` 继续承载 `InspectorPanel`。
- `.centerColumn` 同时承载：
  1. `SceneViewPanel`
  2. `.bottomWorkspace`，其中包含 `ProjectPanel` 和 `ConsolePanel`
- 删除只为全宽底栏存在的 `.bottomBar` 包装层。

### `EditorLayout.module.css`

`.editorShell`：

```css
grid-template-rows: 48px minmax(0, 1fr);
```

`.workspace` 保持现有三列：

```css
grid-template-columns:
  clamp(180px, 22vw, 260px)
  minmax(360px, 1fr)
  clamp(220px, 26vw, 320px);
```

`.centerColumn` 改为两行：

```css
grid-template-rows: minmax(0, 1fr) clamp(300px, 38vh, 460px);
```

`.bottomWorkspace` 保持 Project + Console 的两行结构，并增加顶部分隔线和 `overflow: hidden`，确保内容只在资源库内部滚动。

## 滚动与尺寸边界

- Hierarchy：面板本身高度为 100%，实体列表继续内部纵向滚动。
- Inspector：面板本身高度为 100%，表单继续内部纵向滚动。
- Scene：使用中间列剩余高度，Babylon canvas 继续填满容器。
- Project：高度继续为 `300px–460px` 自适应，卡片区按宽度换行并纵向滚动。
- Console：继续占 Project 区域底部 30px，不横跨左右栏。
- 小于约 `1024×640` 时继续沿用当前“尽量收缩但不保证舒适”的边界，不新增额外媒体查询。

## 文档更新

README 需要明确：

- Hierarchy 与 Inspector 贯通到窗口底部。
- Project/Console 仅位于 Scene 下方并与画布等宽。
- Project 高度和现有响应式、内部滚动策略保持不变。

## 验证计划

1. `npm run typecheck`：确认 JSX 和 CSS Module 引用无类型问题。
2. `npm run build`：确认 renderer 与 Electron 生产构建成功。
3. Playwright CLI 在浏览器开发页检查布局几何：
   - Hierarchy 底边与 workspace 底边一致。
   - Inspector 底边与 workspace 底边一致。
   - Project 左右边界与 Scene 左右边界一致。
   - Console 入口宽度与 Project 一致。
4. `git diff --check`：确认无空白错误。
5. 清理本次启动的 Vite 与 Playwright 浏览器进程。

## 成功标准

- Toolbar 下方只有一个三列工作区。
- 左侧模型树、右侧属性面板均延伸至窗口底部。
- Scene 与 Project 垂直排列在同一中间列中，左右边界一致。
- Project/Console 不再覆盖左右侧栏下方区域。
- 面板内部滚动、运行预览只读边界和场景业务逻辑保持不变。
