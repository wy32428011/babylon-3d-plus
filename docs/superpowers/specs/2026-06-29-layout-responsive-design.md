# 布局自适应设计规格

## 背景

当前编辑器采用 Unity-like 五面板布局，包含 Toolbar、Hierarchy、Scene、Console、Inspector 与 Project。现有布局在多个位置使用固定尺寸：全局 `body` 设置 `min-width: 1180px` 与 `min-height: 720px`，主布局列宽固定为 `260px / 1fr / 320px`，底部 Project 固定为 `260px`。当窗口小于这些固定边界时，应用整体会被裁切，无法根据窗口尺寸自然收缩。

本次目标是让布局根据窗口大小自动自适应，在不引入拖拽分隔条、不隐藏面板、不新增复杂 React 状态的前提下，让五面板在较小窗口中仍保持可见和基本可用。

## 已确认需求

- 自适应策略选择：保持五面板都可见。
- 最小适配目标：`1024×640`。
- 本次不实现拖拽调整面板大小。
- 本次不实现面板折叠或自动隐藏。
- 主窗口不应依赖固定 `1180×720` 才能完整显示。
- 溢出应优先发生在对应面板内部，而不是撑开或裁切整个应用。

## 推荐方案

采用 CSS 弹性轨道方案。

核心做法是用 `clamp()`、`minmax()` 和面板内部滚动替代固定尺寸：

- 主布局继续使用 CSS Grid。
- React 组件结构保持不变。
- 左栏、右栏、底部 Project、Console 在窗口变化时按上下限弹性调整。
- Scene 面板占据剩余空间。
- Toolbar、Project 页签与资源卡片列表通过横向滚动承接内容溢出。

该方案改动面小，符合当前 MVP 的稳定性要求，也为后续响应式密度模式或拖拽分隔条保留升级空间。

## 架构边界

### `EditorLayout.tsx`

`EditorLayout.tsx` 继续只负责组合编辑器区域：

- `Toolbar`
- `HierarchyPanel`
- `SceneViewPanel`
- `ConsolePanel`
- `InspectorPanel`
- `ProjectPanel`

本次不在该组件中新增布局状态，不新增拖拽逻辑，不新增窗口尺寸监听逻辑。

### `EditorLayout.module.css`

该文件负责主布局轨道的自适应：

- `.editorShell` 继续占满 `100vw × 100vh`。
- 顶部 Toolbar 保持固定高度。
- 中间 workspace 使用剩余高度。
- 底部 Project 从固定高度改为弹性高度。
- 左右栏从固定宽度改为带上下限的弹性宽度。
- Console 从固定高度改为带上下限的弹性高度。

### `global.css`

该文件负责通用溢出边界：

- 移除 `body` 的固定最小宽高。
- 保留窗口级 `overflow: hidden`。
- 为面板、Toolbar、Project 页签、Project 资源列表补充必要的内部滚动策略。
- 避免子元素通过固定宽高反向撑爆父级 Grid。

### `SceneViewPanel.tsx`

当前 Scene View 已在窗口变化时调用 Babylon `engine.resize()`。本次保持该机制，不主动加入 `ResizeObserver`。

如果后续加入拖拽分隔条、折叠面板，或发现非窗口变化导致 Scene 容器尺寸变化但 Babylon 画面不同步，再补充 `ResizeObserver`。

## 样式设计

### 主窗口

`.editorShell` 使用如下思路：

```css
grid-template-rows: 48px minmax(0, 1fr) clamp(180px, 28vh, 260px);
width: 100vw;
height: 100vh;
min-width: 0;
min-height: 0;
```

含义：

- Toolbar 固定 `48px`。
- workspace 使用剩余高度。
- Project 在 `180px` 到 `260px` 之间随窗口高度变化。

### 中间工作区

`.workspace` 使用如下思路：

```css
grid-template-columns:
  clamp(180px, 22vw, 260px)
  minmax(360px, 1fr)
  clamp(220px, 26vw, 320px);
```

含义：

- Hierarchy 在 `180px` 到 `260px` 之间变化。
- Scene 列至少保留 `360px`，并占据剩余空间。
- Inspector 在 `220px` 到 `320px` 之间变化。

在 `1024px` 宽度下，该组合仍能保持三列存在，并让 Scene 拥有基本可用空间。

### Scene 与 Console

`.centerColumn` 使用如下思路：

```css
grid-template-rows: minmax(0, 1fr) clamp(96px, 18vh, 150px);
```

含义：

- Scene 占据中心列剩余高度。
- Console 在 `96px` 到 `150px` 之间变化。

### Toolbar

Toolbar 保持单行，不随窗口变窄而换行。小窗口下通过横向滚动访问按钮。

需要补充：

```css
min-width: 0;
overflow-x: auto;
overflow-y: hidden;
```

### 面板

`.panel` 与 `.scene-panel` 继续保持内部滚动，同时补充 `min-width: 0` 和 `min-height: 0`，避免 Grid 子项默认最小内容尺寸撑开布局。

### Project 资源库

Project 面板高度变为弹性后，需要确保内部区域不反向撑高：

- `.project-library` 保持 `overflow: hidden`。
- `.library-tabs` 增加横向滚动。
- `.resource-card-list` 继续横向滚动。
- 资源卡片尺寸本次不缩小，避免扩大视觉改动范围。

## 溢出策略

整体策略是：窗口级不滚动，面板级滚动。

- Toolbar：横向滚动。
- Hierarchy：面板内部纵向滚动。
- Inspector：面板内部纵向滚动。
- Console：日志列表区域随面板内部滚动。
- Project 页签：横向滚动。
- Project 资源卡片：横向滚动。
- Scene：随剩余空间缩放，不用滚动承接画布。

## 错误与边界

本次没有新增运行时状态、异步流程或数据结构，因此不新增 React Error Boundary。

边界说明：

- `1024×640` 是本次最小适配目标。
- 小于 `1024×640` 时布局会继续尽量收缩，但不保证所有内容舒适可读。
- 如果 Electron 主窗口设置了更大的最小尺寸，则 CSS 自适应会在该窗口最小尺寸以上生效。
- 本次不承诺拖拽分隔条、面板折叠或响应式字体密度模式。

## 验证计划

本次不运行耗时测试套件，采用轻量验证：

1. 检查 CSS 语法与 TypeScript 编译边界，确保没有引入组件类型变化。
2. 在约 `1365×768` 和 `1024×640` 两种窗口尺寸下观察布局。
3. 确认 Toolbar、Hierarchy、Scene、Console、Inspector、Project 都可见。
4. 确认 Project 页签和资源卡片在小窗口下通过内部横向滚动承接溢出。
5. 确认 Scene 画布在窗口变化后没有明显拉伸、黑边或渲染尺寸不同步。
6. 更新 README，明确本次交付的是自动响应式适配，不包含拖拽分隔条和面板折叠。

## 成功标准

在 `1024×640` 窗口下：

- Toolbar 可访问。
- Hierarchy、Scene、Inspector、Console、Project 均在视口内可见。
- 主应用不再依赖 `body` 固定 `1180×720` 才能显示完整。
- 面板内容溢出由面板内部滚动承接。
- Scene 区域占据中心剩余空间，并能随窗口变化调整 Babylon 渲染尺寸。
- README 与实际功能范围一致。
