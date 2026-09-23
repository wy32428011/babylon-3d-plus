# 输送方向箭头特效

特效库新增六种带预览缩略图的箭头，采用程序化发光材质，无需导入图片或外部纹理。

| 库卡片 | 稳定类型 | 外观 |
| --- | --- | --- |
| 单一直线箭头 | `conveyor-arrow-single` | 长直线箭身和单个箭头，尾部渐隐。 |
| 连续箭头流向 | `conveyor-arrow-chevron` | 连续折箭头沿输送方向循环流动。 |
| 分段式箭头 | `conveyor-arrow-segmented` | 分段矩形箭身和末端箭头。 |
| 宽幅带式箭头 | `conveyor-arrow-ribbon` | 宽幅光带，带网格纹理和明亮边缘。 |
| 双列前进箭头 | `conveyor-arrow-double` | 两条平行的箭头通道。 |
| 高速流动箭头 | `conveyor-arrow-speed` | 多条不同相位的流线与末端箭头。 |

## 独立特效

1. 在特效库搜索“箭头”，将卡片拖入场景；也可双击卡片创建。
2. 新箭头默认铺在实体局部 X/Z 平面，朝 +X 方向，底面略高于实体锚点。用位置将它摆到输送面上，用 Y 轴旋转调整朝向，倾斜设备可同时调整 X/Z 旋转。
3. 设置主颜色、辅助颜色、强度、速度、长度、宽度和不透明度。“反向”同时翻转箭头方向与流动方向。
4. 连续、分段和双列样式支持“箭头/分段数量”（1–32）。单一直线、宽幅和高速样式使用固定轮廓。
5. 速度为 0 时保持当前动画相位；不透明度为 0 时完全透明。隐藏实体暂停动画，取消“启用特效”释放视觉资源。

长度、宽度以局部米计，范围 0.1–10000；Transform 缩放会继续影响世界尺寸。不透明度 0–1，速度 0–5，强度 0.1–3。实际亮度受场景曝光和背景影响；输送面被货物遮挡时箭头也会被遮挡。

属性修改、创建、复制、删除均沿用编辑器既有撤销/重做流程，复制品保留独立参数。参数保存在 `poiEffect.conveyorArrow`，旧特效配置与类型保持兼容。新箭头缺少该字段时使用对应样式默认值。

## 用作设备表面箭头

六种卡片也可以拖入输送线模型“数据驱动 → 表面箭头”的样式框，或从“箭头样式”下拉框选择。这里使用模型实例的表面范围、颜色、呼吸和方向绑定；连续、分段、双列按目标间距均匀排列，最多 32 个，其余三款使用固定轮廓。新六款的速度为视觉倍率，整体长度使用覆盖长度，横向范围使用箭头宽度。拖放只切换样式，不复制独立特效的尺寸参数，也不创建场景实体。方向继续由设备数据或临时预览控制，详情见[输送线表面箭头](conveyor-surface-arrows.md)。

## 保存与发布

普通场景保存重开及 SOURCE/DIST 均保留箭头类型、外观参数与方向；编辑器和 Viewer 共用运行时。已部署的旧 Viewer 需要使用新版编辑器重新构建、发布并重新加载。

本地验收命令：

```powershell
node --experimental-strip-types --test tests/editor/conveyorArrowEffect.test.ts
node --test tests/editor/conveyorArrowEffect.integration.test.mjs tests/runtime/conveyorArrowEffect.test.mjs tests/editor/conveyorSurfaceArrowDrag.test.mjs
node scripts/smoke-conveyor-arrow-effects.mjs
node scripts/smoke-conveyor-arrow-effect-surfaces.mjs
npm run build
node node_modules/electron/cli.js tests/digitalTwin/conveyorArrowEffectsPackages.integration.mjs
node scripts/smoke-conveyor-arrow-effects-viewer.mjs
```

本地 fixture 和发布包检查用于验证配置与渲染链路，不代表已部署到业务项目或完成真实 MQTT 点位验收。
