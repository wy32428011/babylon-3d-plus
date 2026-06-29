# Gizmo 坐标空间与吸附规格

## 背景

Transform Gizmo 已支持 Move、Rotate、Scale 三种工具，并可通过 Scene View 点击选中对象。本阶段继续补齐编辑器中高频使用的坐标空间与吸附能力，让用户可以在局部坐标、世界坐标和固定步长拖拽之间快速切换。

## 本次目标

- Toolbar 提供 Local / Global 分段切换。
- Toolbar 提供 Snap 开关。
- Toolbar 提供位置、旋转角度、缩放三类吸附步长输入。
- `TransformGizmoController` 使用 Babylon `coordinatesMode` 切换坐标空间。
- `TransformGizmoController` 使用 Babylon `snapDistance` 应用位置、旋转、缩放吸附。
- 吸附关闭时保留用户设置的步长，但向 Gizmo 写入 0，保持自由拖拽。

## 默认值

- 默认坐标空间：`local`，保持既有 Babylon Gizmo 行为。
- 默认吸附状态：关闭。
- 默认位置吸附：`0.5` Babylon unit。
- 默认旋转吸附：`15` 度，写入 Babylon 时转换为弧度。
- 默认缩放吸附：`0.1`，并启用 `incrementalSnap`。

## 数据流

1. `editorStore` 持有 `transformSpace` 与 `snapSettings`。
2. `Toolbar` 读取状态并调用 `setTransformSpace()`、`setSnapEnabled()`、`updateSnapSetting()`。
3. `SceneViewPanel` 订阅状态变化，并调用 `TransformGizmoController.setTransformSpace()` 与 `setSnapSettings()`。
4. `TransformGizmoController` 将编辑器状态映射到 Babylon Gizmo API。
5. 拖拽提交仍沿用实体明确的 `commitEntityTransform()`，不会改变 Undo/Redo 语义。

## 非目标

- 不实现吸附快捷键。
- 不实现网格可视化吸附提示。
- 不实现 Frame Selected。
- 不实现多选变换。
- 不改变场景文件格式；坐标空间与吸附设置目前属于编辑器会话状态。

## 验证标准

- Local / Global 按钮高亮状态互斥，并能切换 Gizmo 坐标轴朝向。
- Snap 开关打开后，Move 按位置步长吸附，Rotate 按角度步长吸附，Scale 按缩放步长吸附。
- Snap 关闭后，三类 Gizmo 恢复自由拖拽。
- 修改吸附步长后无需重建场景或重新选择对象即可生效。
- 拖拽结束仍只写入一条 Undo/Redo 命令。
