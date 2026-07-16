# Toolbar 俯视视角切换设计

**日期：** 2026-07-16

## 背景

编辑器已经支持在 Scene View 中导入锁定的 CAD/DXF 参考图，但当前只能依赖鼠标手动旋转 ArcRotateCamera。搭建二维 CAD 对应的设备、墙体和定位点时，用户需要快速回到从世界 Y 轴向下观察 XZ 地面的俯视视角。

## 目标

- 在顶部 Toolbar 增加一个可访问、带原生 Tooltip 的“俯视”图标按钮。
- 点击后以当前相机 target 为观察中心、保留当前 radius，仅切换为稳定俯视方位。
- 避免把 ArcRotateCamera 的 beta 设置到数学极点，防止上方向退化或视图翻转。
- 俯视属于临时视角操作，不修改场景文档、不覆盖已保存视角、不进入撤销/重做历史。
- 运行预览仍允许使用俯视，与现有“运行态允许相机操作”的约定一致。

## 方案比较

### 方案 A：通过 store 请求驱动 BabylonViewport（采用）

Toolbar 触发 Zustand 中的临时请求，SceneViewPanel 消费请求并调用 BabylonViewport 的 `setTopView()`。该方案复用当前相机保存、复位和场景聚焦的请求中转模式，Toolbar 不直接依赖 Babylon 实例。

- 优点：职责边界清晰，符合现有数据流。
- 优点：不污染持久化场景设置和撤销历史。
- 优点：后续增加前视、侧视时可沿用同一模式。
- 代价：需要同步修改 Toolbar、布局、store、SceneViewPanel 和 viewport 类型。

### 方案 B：Toolbar 派发全局 DOM 事件

改动文件较少，但事件名称和生命周期缺少类型约束，且绕过现有 store 数据流，不采用。

### 方案 C：把俯视位姿写入 `sceneSettings.camera.savedPose`

可以借用现有复位逻辑，但会覆盖用户保存的视角并改变场景持久化内容，不采用。

## 详细设计

1. `Toolbar` 新增 `onSetTopView` 属性，并复用 `ToolbarIconButton`；图标使用中文“俯”，标签使用“切换为俯视视角”。
2. `EditorLayout` 从 store 读取 `requestCameraTopView` 并传给 Toolbar。
3. `editorStore` 新增 `cameraTopViewRequest`、请求和消费动作；切换场景时清空待处理请求。
4. `SceneViewPanel` 监听请求，调用 `viewport.setTopView()` 后消费请求。
5. `createEngine` 为 `BabylonViewport` 增加 `setTopView()`：清除相机旋转/缩放/平移惯性，将 alpha 设为固定俯视朝向，将 beta 设为 ArcRotateCamera 的 `lowerBetaLimit`（默认 0.01），保留 target 与 radius。
6. 不新增 CSS，沿用现有 32px 图标按钮、`aria-label` 和 `title` 规范。

## 验收标准

- Toolbar 显示“俯”图标按钮，悬停提示“切换为俯视视角”。
- 任意旋转视角下点击按钮，画面切换到从上向下观察 XZ 地面的稳定俯视视角。
- 点击前后的观察中心和缩放距离保持不变，CAD 图纸不会跳离当前工作区。
- 快速旋转后立即点击俯视，残余惯性不会把视角继续带离俯视方向。
- 运行预览中按钮仍可用；场景保存内容和已保存相机位姿不因点击而改变。
- TypeScript 类型检查、生产构建和差异检查通过。
