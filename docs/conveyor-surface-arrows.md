# 输送线表面箭头

输送线模型的数据驱动属性提供“表面箭头”，用于在输送面显示连续的扁平发光箭头。配置属于模型实例，方向和显示状态继承现有设备绑定。旧场景默认关闭此功能。

## 配置和预览

1. 选中 `deviceType=conveyor` 的模型，在“数据驱动”中确认数据源、设备编号和“轨迹方向”。行走轴以模型包 `cargo.travel.axis` 声明为准，轨迹方向应与行走轴匹配；匹配时同时校准货物和表面箭头的模型局部正向。轴不匹配时沿用旧货物驱动的轴正向回退。
2. 勾选“启用表面箭头”。模型默认使用输送面高度信息及输送节点范围；若自动识别受护栏、电机或立柱影响，在“输送面部件”中填写唯一节点名、完整路径或唯一尾部路径，按 Enter 或移开焦点应用。指定节点时沿该部件的局部顶面放置；节点不存在或名称有歧义时隐藏并提示。
3. 调整“表面上浮”使箭头略高于输送面。展开“覆盖范围与位置”，可设置长度、宽度、首尾留白及沿线/横向偏移。长宽为 `0` 时自动适配；所有尺寸以模型局部米计量，跟随模型变换及缩放。
4. 展开“箭头外观与动画”，调整颜色、透明度、箭头长宽、中心间距和视觉流速。中心间距至少比箭头长度大 `0.02` 米；速度 `0` 表示箭头静止显示，设备停止时仍会隐藏。视觉流速不表示设备实际速度。
5. 使用“正向”“反向”“停止”按钮检查放置效果。“结束预览”恢复为编辑状态不显示。切换模型、场景或运行模式、关闭箭头时，临时预览会结束。

参数更新沿用编辑器命令历史，可撤销、重做和复制。预览选择与诊断文字仅存在于当前会话，不进入场景或发布配置。“恢复模型默认绑定”会同时移除实例表面箭头配置，该操作可撤销。

## MQTT 状态规则

表面箭头继承该模型的 `sourceId + deviceType + assetCode`，无需再次订阅。方向沿用模型包 `cargo.travel.fields/actionMap` 与既有兼容映射；缺少自定义映射时使用默认 `movement_x`。

| 设备状态 | 箭头表现 |
| --- | --- |
| 有效新鲜数据，默认 `movement_x=1` | 显示并沿模型正向流动 |
| 有效新鲜数据，默认 `movement_x=2` | 显示并反向流动，箭头尖端同步反向 |
| 默认 `movement_x=0` | 隐藏 |
| 未收到数据、方向字段缺失或无法解析 | 隐藏并显示原因 |
| 超过绑定的 `staleAfterMs` | 隐藏，恢复有效数据后显示 |
| 故障、绑定停用或设备主键冲突 | 隐藏并显示原因 |

箭头只反映当前 MQTT 运动信号。货物在停止信号后继续完成交接或插值，不会让箭头继续运动。`mode` 字段沿用既有货物业务语义，不单独作为箭头运行开关。Inspector 的“箭头状态”可用于排查隐藏原因，原有遥测诊断仍提供设备匹配、方向字段和接收时间。

## 支持范围和兼容性

- 普通输送线、阵列中的遥测实例和设备产生器使用各自设备状态，几何位置跟随对应实例。
- 支持直线平面输送面，以及整体倾斜或明确指定的倾斜输送部件；弯道、折线和任意曲面不进行自动贴合，需要后续单独的路径能力。
- 箭头保持深度测试，货箱和模型部件可以遮挡箭头。装饰不参与拾取、模型测量、支撑面或相邻设备判断。
- 旧 YZJ 模型保留自带方向箭头。检测到已存在的方向箭头时优先保留原显示并提示诊断，避免叠加；本功能不会自动迁移旧模型的出料侧及平台动画语义。
- 配置随模型的 `telemetryBinding.surfaceArrows` 保存，复制后可独立修改。发布使用相同运行时规则；已部署的旧 Viewer 需要用新版编辑器重新构建并发布，已有发布不会自动升级。

## 验证

配置和会话测试：

```powershell
node --experimental-strip-types --test tests/telemetry/conveyorSurfaceArrowsConfig.test.ts tests/telemetry/conveyorSurfaceArrowSession.test.ts
```

真实编辑命令、撤销重做、复制独立、保存重开、旧场景及运行预览保护：

```powershell
node --test tests/editor/conveyorSurfaceArrows.integration.test.mjs
```

运行状态、表面几何及生命周期：

```powershell
node --test tests/telemetry/conveyorSurfaceArrowState.test.mjs tests/runtime/conveyorSurfaceArrowSystem.test.mjs tests/runtime/conveyorSurfaceArrowRenderer.test.mjs
```

实际编辑器属性操作、保存重开、参数改尺寸、部件选择、WebGL 遮挡以及本地 MQTT 正反停/故障/断流恢复：

```powershell
node scripts/smoke-conveyor-surface-arrows.mjs
```

上述 smoke 生成 `output/conveyor-surface-arrows/scene.scene.json`。完成构建后，验证真实 SOURCE 三场景与对应 DIST，再加载实际 DIST Viewer：

```powershell
npm run build
node node_modules/electron/cli.js tests/digitalTwin/conveyorSurfaceArrowPackages.integration.mjs
node scripts/smoke-conveyor-surface-arrow-viewer.mjs
```

结果和截图位于 `output/conveyor-surface-arrows/`。这些验证使用内置虚拟输送线与本地 MQTT fixture，不代表真实现场 Broker、业务模型或已部署 Viewer 已完成验收；已有部署需重新发布。
