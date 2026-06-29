# Transform Gizmo MVP 设计规格

## 背景

当前 Babylon Electron Unity-like Editor MVP 已具备基础场景编辑闭环：创建 Cube/Sphere/Plane、Hierarchy 选择、Inspector Transform 编辑、Babylon Scene View 同步、Undo/Redo、场景保存/加载、Assets 目录扫描与 README 文档。

当前主要缺口是 Scene View 只能展示对象，Transform 编辑仍依赖 Inspector 数值输入，缺少 Unity-like 的可视化拖拽操控体验。本阶段目标是在不引入 glTF 导入、Prefab、Play Mode 或完整工具系统的前提下，实现一个可用、可撤销、与现有数据模型一致的 Transform Gizmo MVP。

## 目标

实现 Scene View 中的三模式 Transform Gizmo：

- Move / Translate：移动选中对象。
- Rotate：旋转选中对象。
- Scale：缩放选中对象。
- Toolbar 可切换当前 Transform 工具。
- 选中实体存在可渲染 mesh 时，Scene View 显示对应 gizmo。
- 拖拽过程中实时预览对象变换，并同步 Inspector 数值。
- 拖拽结束时只写入一条 Undo/Redo 命令。
- Undo/Redo 能撤销/恢复整个拖拽操作。

## 非目标

本阶段不实现：

- Scene View 点击 mesh 选择对象。
- 多选和群组变换。
- 局部/全局坐标切换。
- 网格吸附、角度吸附、缩放吸附。
- 快捷键 W/E/R。
- Gizmo 样式深度定制。
- glTF/GLB 导入与实例化。
- Prefab/GUID/完整 AssetDatabase。
- Play Mode 或脚本组件。

## 推荐方案

采用 Babylon.js gizmo 能力实现 Move / Rotate / Scale 三模式，并通过现有 `SceneDocument`、Zustand store 与 command history 管理编辑状态。

核心原则：

1. `SceneDocument` 仍是编辑状态唯一来源。
2. Babylon mesh 是 runtime 显示对象，不作为持久化源。
3. 拖拽中允许 preview 更新 scene，但不进入 command history。
4. 拖拽结束后通过 command 提交整组 Transform。
5. Inspector 数值编辑仍沿用现有单轴 command 行为。

## 架构设计

### Store 扩展

在 `src/editor/store/editorStore.ts` 增加：

- `transformTool: 'translate' | 'rotate' | 'scale'`
- `setTransformTool(tool)`
- `previewSelectedTransform(transform)`
- `commitSelectedTransform(before, after)`

其中：

- `previewSelectedTransform` 只更新当前选中实体的 Transform，不修改 `history`，不清空 `redoStack`。
- `commitSelectedTransform` 使用 command history 写入一条整组 Transform 更新命令。
- 如果 before/after 完全相同，则不创建 command、不写日志。
- 所有 Transform 写入仍必须保持 finite number 防护，不允许 NaN/Infinity 进入 scene。

### Command 扩展

复用或扩展 `src/editor/commands/entityCommands.ts` 中的 `updateTransformCommand(entityId, before, after)`。

要求：

- 支持整组 Transform 更新。
- before/after 必须是 plain data clone，避免引用污染 Undo/Redo。
- entity 不存在时安全 no-op。

### SceneRuntime 扩展

在 `src/runtime/babylon/SceneRuntime.ts` 增加 mesh 查询能力：

- `getMeshByEntityId(entityId: string): Mesh | null`

可选增加：

- mesh metadata 中保留 `editorEntityId`，便于后续 Scene View 点击选中扩展。

本阶段只需要根据 selected entity 找 mesh，不实现点击选中。

### TransformGizmoController

新增 `src/runtime/babylon/TransformGizmoController.ts`。

职责：

- 创建 Babylon gizmo manager 或具体 position/rotation/scale gizmo。
- 根据当前 `transformTool` 启用对应 gizmo。
- 根据当前选中 mesh attach/detach gizmo。
- drag start 记录 before transform。
- drag 过程中读取 mesh transform，转换为 plain `TransformComponent`，调用 preview。
- drag end 读取 after transform，调用 commit。
- dispose 时释放 gizmo 资源和观察者。

### SceneViewPanel 接线

修改 `src/editor/panels/SceneViewPanel.tsx`：

- 初始化 `TransformGizmoController`。
- 订阅 `scene`、`selectedEntityId`、`transformTool`。
- scene 同步后，根据 selected entity 获取 mesh 并 attach gizmo。
- 将 preview/commit callbacks 传给 gizmo controller。
- cleanup 时 dispose runtime、gizmo controller、engine 与 resize listener。

### Toolbar 接线

修改 `src/editor/ui/Toolbar.tsx` 与 `src/editor/layout/EditorLayout.tsx`：

- 增加 Move / Rotate / Scale 按钮。
- 当前工具高亮。
- 点击按钮调用 `setTransformTool`。
- 不改变 Undo/Redo、Save/Load 现有行为。

## 数据流

1. 用户在 Hierarchy 中选择实体。
2. `SceneRuntime.sync(scene)` 创建/更新对应 mesh。
3. `SceneViewPanel` 根据 `selectedEntityId` 找到 mesh。
4. `TransformGizmoController` attach 到 selected mesh。
5. 用户拖拽 gizmo：
   - drag start：记录 before transform。
   - drag：mesh transform → plain Transform → `previewSelectedTransform`。
   - React store 更新后 Inspector 和 SceneRuntime 同步显示。
   - drag end：mesh transform → plain Transform → `commitSelectedTransform(before, after)`。
6. Undo/Redo 调用现有 command history 撤销/恢复整组 Transform。

## 错误处理与边界

- 无选中实体时 detach gizmo。
- 选中实体无 meshRenderer 或 mesh 不存在时 detach gizmo。
- Transform 中出现非 finite 数值时拒绝 preview/commit。
- before/after 相同则不创建 history。
- React StrictMode 下 mount/unmount/mount 不应泄漏 gizmo observer 或 Babylon 资源。

## 验证标准

至少验证：

1. `npm run typecheck` 通过。
2. `npm run build` 通过。
3. 创建 Cube 后选中，Scene View 显示 translate gizmo。
4. 切换 Rotate / Scale，gizmo 模式变化。
5. 拖拽 Move gizmo 后，Inspector position 更新。
6. 拖拽 Rotate gizmo 后，Inspector rotation 更新。
7. 拖拽 Scale gizmo 后，Inspector scale 更新。
8. 每次拖拽结束后 Undo 只撤销一次完整拖拽，不需要连续多次 Undo。
9. Redo 恢复拖拽后的 Transform。
10. 保存场景后加载，Transform 值保持。
11. 无选中对象时 gizmo 消失。
12. 切换选择对象时 gizmo attach 到新对象。

## 风险

- Babylon gizmo drag event 频率较高，preview 必须避免写 history。
- React state 同步与 Babylon mesh transform 同步可能形成循环，需要避免 commit/preview 导致 transform 抖动。
- Rotation 使用 Babylon Euler rotation，后续若引入 quaternion 需要重新设计。
- Scale 可能被拖到接近 0 或负值，本阶段先允许 Babylon 默认行为；后续可加 min scale 限制。

## 后续扩展

- Scene View 点击选中 mesh。
- W/E/R 快捷键。
- 局部/全局坐标切换。
- 网格/角度/缩放吸附。
- 多选变换。
- Frame Selected。
- 与 glTF 导入对象、Prefab instance 的 transform 编辑集成。
