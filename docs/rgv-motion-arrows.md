# RGV 运动箭头

更新时间：2026-09-23。

RGV 的“数据驱动 → RGV 运动箭头”提供行走、前工位、后工位三路箭头。三路共用输送线的十种内置箭头样式，各路可以独立开关和预览。默认关闭，旧场景保持原有外观；主动启用后默认使用青蓝色移动双箭头，呼吸关闭。

## 放置方式

| 通道 | 位置和范围 | 跟随关系 |
| --- | --- | --- |
| 行走 | 双轨中心线正上方，轨顶加离面距离，覆盖固定轨道全长 | 固定在轨道上，不随车体行走；随场景实例整体变换 |
| 前工位 | 前台面，沿模型局部 X 输送 | 跟随真实前台面节点 |
| 后工位 | 后台面，沿模型局部 X 输送 | 跟随真实后台面节点 |

行走通道只提供轨道挂点、宽度、离面距离和方向反转。显示面固定为顶面，长度及纵向中心自动取完整轨道范围，横向偏移固定为零；历史或外部配置中的侧面、短长度、纵向及横向偏移会在归一化时恢复为这些约束。手动选择一条已声明的轨道仍合并完整双轨，不会把箭头移到侧边。车体经过时保留正常深度遮挡，不让箭头穿透车体。

前后工位可以分别调整挂点、顶面/侧面、长宽、沿运动及横向偏移、离面距离和方向反转。长宽为 0 时自动适配，尺寸使用模型局部米，场景实例的整体缩放继续生效，厘米导入倍率不会重复计算。方向反转只影响箭头显示，不改变设备动作。

## 模型准备与诊断

设备类型沿用当前专用驱动解析出的 `rgv`，不以模型显示名称重新猜测，也不会把已有 `shuttle` 自动改为 `rgv`。使用旧模型包时先核对实际设备绑定和模型运动声明。

固定轨道优先使用脚本的 `dataDriven.fixedNodes`，兼容旧模型的 A45/A46 导轨；声明同时包含 A37～A44 盖板时，优先真实导轨的顶部和全长。普通名称的轨道必须先被驱动声明为固定部件，仅填写箭头挂点不会改变驱动的移动节点集合。双轨中有一条隐藏或释放时，行走箭头隐藏，避免偏到剩余单轨。

前后工位优先使用 `dataDriven.cargo.frontNodes/backNodes`，其次识别明确的 front/back deck/platform 台面名称；仍无法确认时可填写唯一节点名、完整路径或唯一尾部路径。缺少台面、路径不唯一、选择到固定轨道、部件无几何或变换退化时，隐藏对应通道并显示原因，不使用整机包围盒猜测工位。挂点应是随车移动的实际台面。

## 动作与外观

行走方向取 RGV 驱动本帧沿局部 Z 的连续位移，不直接读取 `movement_x`。首帧、滚筒起转时的瞬时补对齐、越界约束纠偏不播放行走箭头。这里的实际运动是三维运行时执行结果，不代表现场连续位置测量。

前后工位分别在原有交接仲裁成功时锁定方向：`command=1/3` 取货、`command=2` 放货，再结合接驳设备位于工位的哪一侧决定局部 X 正反方向。`movement_z=1/2` 只表示滚筒运行，不能直接映射成左右方向。货物已交给输送线后，只要同次输送仍有效，箭头继续显示；停转、故障、无效动作或任务切换清除对应运动方向。

正常停止时冻结流动相位并约 120 ms 淡出。设备故障、数据过期、绑定冲突、模型隐藏或本帧无有效驱动结果时立即隐藏。恢复数据后消费新的有效驱动帧。三路沿用同一设备身份，不新增 MQTT 订阅，不改变列绑定、目标列优先级、货物交接或任务仲裁。

支持十种内置箭头样式。从特效库拖入样式框只改变当前 RGV 样式，不创建独立特效实体，也不覆盖挂点与其它外观。可调整颜色、发光强度、透明度、尺寸、间距、流动速度和呼吸。前四种样式速度为视觉米/秒，六种输送箭头预设速度为视觉倍率，均不等于现场设备速度。速度为 0 只停止视觉流动；强度或透明度为 0 不绘制箭头。

## 预览、保存与发布

每路的“正向”“反向”“停止”“结束预览”只控制箭头，不移动车体或货物。三路可同时预览，切换实体、场景、运行模式或关闭通道时清除预览。诊断与运动状态只在会话内存中保存。

持久配置位于 `telemetryBinding.rgvMotionArrows`，支持撤销重做、保存重开、复制后独立修改和 SOURCE/DIST。“恢复模型默认绑定”会清除该实例的箭头设置，可撤销。旧场景缺少配置、显式关闭或零值配置均保持对应语义。

编辑器运行预览与发布 Viewer 共用 `SceneRuntime`。已有部署需要使用包含该功能的新版编辑器重新构建 Viewer 并重新发布，仅保存本地场景不会升级旧发布包。

## 验证入口

```powershell
node scripts/telemetry-test.mjs rgvMotionState.test.ts rgvColumnHandoff.test.ts
node --experimental-strip-types --test tests/telemetry/rgvMotionArrowsConfig.test.ts tests/telemetry/rgvMotionArrowSession.test.ts tests/editor/rgvMotionArrows.integration.test.mjs
node --test tests/runtime/rgvMotionArrowRenderer.test.mjs tests/runtime/rgvMotionArrowSystem.test.mjs
node scripts/smoke-rgv-motion-arrows.mjs
npm run build
node node_modules/electron/cli.js tests/digitalTwin/rgvMotionArrowPackages.integration.mjs
node scripts/smoke-rgv-motion-arrow-viewer.mjs
```

编辑器 smoke 生成 `output/rgv-motion-arrows/scene.scene.json`，包测试基于它验证实际 SOURCE/DIST 的正常、关闭、旧场景和零值配置，Viewer smoke 使用对应解包产物。结果、截图与编辑器动画录制保存在同一输出目录，是否通过以本次实际运行结果为准。

上述验收使用自包含 RGV 模型与本地 MQTT 夹具，不代表已经验证业务模型、现场 Broker、已安装编辑器或线上 Viewer；这些环境需要重新发布后联调。
