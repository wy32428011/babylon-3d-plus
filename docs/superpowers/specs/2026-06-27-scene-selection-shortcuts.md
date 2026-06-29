# Scene 视图选中与工具快捷键规格

## 背景

Transform Gizmo MVP 已经支持通过 Hierarchy 选择实体，并在 Scene View 中显示 Move、Rotate、Scale 三种操控器。当前缺口是用户仍需要回到 Hierarchy 或 Toolbar 完成常见编辑操作，Scene View 缺少直接点选对象和快捷切换工具的编辑器手感。

## 本次目标

- 在 Scene View 画布中单击可编辑 Mesh 时，选中其对应实体。
- 在 Scene View 画布空白处单击时，清空当前选择并隐藏 Gizmo。
- 拖拽旋转视角或拖拽 Gizmo 时，不触发误选中。
- 在非输入控件聚焦时，支持 W/E/R 快捷键切换 Move、Rotate、Scale。
- 快捷键与 Toolbar 按钮共用 `setTransformTool`，不引入第二套工具状态。

## 非目标

- 不实现多选、框选或层级批量选择。
- 不实现局部/全局坐标切换。
- 不实现网格、角度或缩放吸附。
- 不实现 Frame Selected 或编辑器命令面板。
- 不改变 SceneDocument 的持久化结构。

## 数据流

1. `SceneRuntime` 为运行时 Mesh 写入 `metadata.editorEntityId`。
2. `SceneViewPanel` 记录左键按下位置，并在短距离释放时调用运行时拾取。
3. `SceneRuntime.pickEntityIdAtCanvasPoint()` 将客户端坐标转换为画布坐标，只拾取带有有效编辑器实体 ID 的 Mesh。
4. `SceneViewPanel` 调用 store 的 `selectEntity()` 更新 `SceneDocument.selectedEntityId`。
5. 现有 scene sync effect 根据新的 `selectedEntityId` 重新高亮 Mesh 并 attach/detach Gizmo。
6. `EditorLayout` 监听全局 keydown，过滤输入控件和 Ctrl/Meta/Alt 组合键，再把 W/E/R 映射到已有工具状态。

## 验证标准

- 单击 Cube/Sphere/Plane 可切换选中对象。
- 单击空白区域可清空选择，Inspector 显示未选中状态，Gizmo 隐藏。
- 拖拽视角时不因 pointerup 误触发选择。
- 在 Inspector 数值输入框中输入 W/E/R 不切换工具。
- 页面其他区域按 W/E/R 可切换 Move、Rotate、Scale，Toolbar 高亮同步变化。
