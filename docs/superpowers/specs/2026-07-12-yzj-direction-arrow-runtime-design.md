# YZJ 移动方向箭头设计

## 目标

为一体式顶升移载 YZJ 增加可配置的透明发光方向箭头。图片库提供内置“方向箭头（光晕）”卡片，可拖到模型 `texture` 参数；箭头显示在 `Ban.4` 顶面并随顶升、宽度、位置和 Conveyor 运行态一起运动。保持左侧固定、右侧单向伸长及 `YZJ.glb` 不变。

## 已确认产品决策

- 视觉采用单个青蓝色透明箭头，图片自身带柔和光晕。
- 本期只提供内置箭头图片，不加入磁盘图片导入或外部 URL。
- 编辑态按 `outfeedSide` 显示并持续呼吸发光。
- 运行预览/生产构建运行态由 MQTT `movement_x` 决定方向：`1` 或正值指向 `outfeedSide`，`2` 或负值指向其反方向。
- 运行态 `movement_x = 0`、无遥测或故障时隐藏；停止预览回到编辑态后重新按 `outfeedSide` 显示。
- 箭头只做运行时可视物，不写 `motionSourceNodeName`，不进入 SceneDocument/Hierarchy，不修改 GLB。

## 架构

1. 使用 `editor-image://builtin/direction-arrow-glow` 作为可序列化逻辑引用。图片资产模块通过 `new URL(..., import.meta.url)` 生成开发和生产构建 URL。
2. 图片库卡片使用专用拖拽 MIME；Inspector 的通用 `texture` 参数接收该载荷并保存逻辑引用。
3. 共享贴图解析器同时供声明式 `baseTexture` 和外置模型脚本参数注入使用；模型包相对贴图继续使用 `editor-asset` 与 `assetRevision`。
4. `ExternalModelScriptRuntime` 接收 `{ mode, telemetry }` 上下文。SceneRuntime 在编辑/运行切换和每帧 Conveyor 快照时更新上下文，停止预览时清空遥测。
5. YZJ 脚本在 `Ban.4` 局部顶面创建单个双面 Plane；透明、自发光、不可拾取、禁写深度，固定小幅呼吸。图片基准朝局部 X+，四侧 yaw 为 left=0、right=PI、front=PI/2、rear=-PI/2。

## 视觉与生命周期

- 箭头边长按 `Ban.4` 当前局部 X/Z 较短边的约 56% 计算，中心位于平台顶面上方约较短边的 1.2%，避免 z-fighting。
- alpha 在约 `0.55..0.92` 间变化，缩放在 `1..1.03` 间变化，周期约 `1.8s`。
- 参数变化前、脚本停止、模型卸载时必须释放观察器、Mesh、Material、Texture；图片加载失败只隐藏箭头并记录警告。
- 箭头 metadata 仅保留 `generatedByParametricRuntime` 与 `directionArrowVisual`。

## 验收

- 图片库显示真实透明箭头缩略图，可拖入 YZJ 的“方向箭头图片”属性并支持 undo/redo。
- 编辑态四个 `outfeedSide` 均正确旋转且持续呼吸。
- 运行态正向、反向、停止、无数据、故障五类状态符合已确认规则；箭头随 `Ban.4` 升降且不参与 GT.3 运动节点匹配。
- 开发 Vite、Electron/生产 Vite 构建均能加载同一内置图片；生产产物包含 hash 化 PNG。
- YZJ 四份脚本和三份 meta 字节一致，`YZJ.glb` SHA256 保持不变。