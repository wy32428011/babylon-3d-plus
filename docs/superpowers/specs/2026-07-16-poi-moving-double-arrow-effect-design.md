# POI 移动双箭头 EFF 设计

**日期：** 2026-07-16

## 目标

在现有 POI EFF 体系中新增第 16 个内置效果 `moving-double-arrow`，中文名称为“移动双箭头”。效果用于输送、管线、物流和设备动作方向提示，并延续统一 EFF 的创建、保存、复制、撤销、Inspector 和 Babylon 生命周期。

## 视觉规格

- 每个运动单元由两枚相邻的 `>` 折线箭头组成，整体视觉为 `>>`。
- 每枚折线箭头由两段窄发光 Box 组成，不依赖外部贴图或新 Shader。
- 多组双箭头沿实体本地 `+X` 从左向右循环移动，到边界后无缝回绕。
- 双箭头在路径两端渐隐，中间区域保持高亮，避免回绕跳变。
- 添加一条低透明度导向基线，使运动方向在箭头间隙中仍然清晰。
- 内部 Mesh 不可拾取，继续由 EFF 稳定透明拾取壳负责 Scene 选择和 Gizmo。
- 每组 `>>` 的折线段在创建时预合并为光晕、后随箭头、前导箭头 3 个动画 Mesh；默认 3 组共 9 个动画 Mesh，最大 6 组共 18 个，避免逐段 draw call 和逐帧更新膨胀。

## 参数映射

- `primaryColor`：前导箭头颜色。
- `secondaryColor`：后随箭头与导向基线颜色。
- `intensity`：自发光透明度和箭头线段尺度。
- `speed`：循环移动速度。
- `density`：同一范围内的双箭头组数，限制为 1–6 组。
- `Transform.position`：运动效果锚点。
- `Transform.rotation`：把本地 `+X` 转为业务运动方向。
- `Transform.scale`：整体路径长度、宽度和厚度。

## 数据和兼容

- 在 `PoiEffectKind` 与 `POI_EFFECT_KINDS` 追加稳定值 `moving-double-arrow`。
- 通过 `POI_EFFECT_DEFINITIONS` 自动进入 POI 库和 Inspector 类型选择器。
- 旧场景不受影响；新场景仍使用现有 `components.poiEffect` 结构，无需升级场景文件版本。
- 运行时继续使用一个 `onBeforeRenderObservable`，不新增独立观察者或 GlowLayer。

## 验收

- POI 库显示“移动双箭头”卡片，可点击和拖拽创建。
- Scene 中能明确看出成组 `>>` 沿一个方向连续移动。
- 修改颜色、速度、强度、密度和 Transform 后实时更新。
- 保存加载、复制阵列、显隐锁定与资源释放沿用现有 EFF 行为。
- 类型检查、生产构建、NullEngine smoke 和实际浏览器截图验证通过。
