# 工厂场景框架性能分析与优化（2026-10-27）

目标：以此前 14 FPS 的工厂优化副本为基线，定位 CPU、GPU 与阴影的实际成本，并仅针对确认的瓶颈优化框架。保留基线画质、设备身份及业务逻辑，不覆盖场景或模型。

- [x] 检查工作区、运行环境与可复用诊断，保留既有改动。
- [x] 同条件采集前台基线、GPU 查询、CPU profile 和阴影工作量；将实验诊断与正式画质分开。
- [ ] 根据证据实施可保证原行为的框架优化；必要时保守回退。
- [ ] 针对变更风险进行最小必要对照，记录收益、业务与画质验证以及未解决项。

## 已采集的证据

- 以此前 14 FPS 对应的优化场景为源（SHA256 `51c8c7edbb5b0f6315c4327446fd3703980261b53bd9b0856f4775e804a62444`），原场景不改。隔离副本只重定位项目内资源路径；101 个资产逐项 SHA 一致。RTX 4060 Ti / WebGL2 / 1960×948 / scaling 1 / 默认静止视角、balanced/hybrid 阴影，HUD 打开，未接真实 MQTT。
- 前台 60 秒 826 帧、13.7667 FPS，P50/P95/P99 帧间隔 72.4/77.6/79.9 ms；GPU 414 个独立完成查询、无 disjoint，P50/P95 37.41/39.74 ms。Babylon 采样平均 render 30.62 ms、active-mesh evaluation 9.65 ms、约 3200 DC。GPU 和 CPU 区间不可相加；frameTimeCounter 不是 CPU 独占时间。
- 独立 20 秒阴影审计记录 276 个 face、345000 次 draw，约 1250/face；276 次动态渲染、276 次静态缓存命中、0 次静态重绘/失效。这是 shadow draw/cache 计数，非独立 GPU 时间。
- 独立 20 秒 CPU profile 中 `_evaluateActiveMeshes` self 约 1.18 秒、mesh `render` 1.15 秒、PBR `bindForSubMesh` 0.83 秒、方向光自动阴影投影合计约 1.20 秒。profile self 为采样权重，inclusive 调用栈不能相加。`getModelNodes` 热点追溯到外置 LED 脚本，不是框架的同名方法。
- 临时启用既有合批（15 秒）仅接管 235 个部件，3126 DC，4.53 FPS，GPU P50 37.43 ms，active evaluation 均值 75.68 ms；比基线明显退化，不启用默认值。临时关闭阴影（15 秒）为 19.33 FPS、1950 DC、GPU P50 26.30 ms；改变画面，仅用来判断阴影负担，不作为优化方案或正式 ABBA 收益。两个实验结束均恢复原状态。
- 单自然帧阴影调用归属 1250/1250 次 draw，全部为动态；其中 481 次来自 13 台 `multi-shuttle.model.ts` 设备的 37 个对应运动部件，1144 次可映射到单一实体，106 次 thin instance 未能归属。其余主要包括 fmh 162、stacker 147、newshelf 104、fsh 100、新辊道 81 次；不以名称判静态。
- 13 台穿梭车同源 GLB、同参数；逐实体有界采集后 37 组共 481 个对象可读取的 CPU 侧顶点、索引、布局及选定材质字段哈希在组内一致，活跃纹理共用 InternalTexture、采集的采样状态一致。材质插件未完全覆盖、无 GPU 像素读回、跨帧且无真实设备运动；不证明动态状态持续一致。
- 首次一次性采集 481 对象时页面关闭，未取得 renderer-gone 原因，不推断 OOM；逐实体限制字节后采集完成。所有专属进程已退出，源和副本 SHA 未变。原大屏服务超时和无真实 MQTT 保持原样。

证据：`output/factory-framework-analysis-20261027/` 内 `baseline/report.json`、`baseline/cpu-summary.json`、`candidate-diagnostic/report.json`、`shadow-objects/report.json`、`shuttle-equivalence-bounded/report.json` 与 `group-hashes.json`。首轮失败保留在 `shuttle-equivalence/report.json`。

## 未完成与必要边界

还没有可在真实设备运动中证明无损的框架优化，因此未修改产品代码、阴影档位或模型脚本，不能声称 FPS 提升。候选为保留原业务模型和拾取对象、仅在阴影目标使用派生动态 thin-instance 载体；须精确检查几何、材质、纹理、投影角色和每帧每部件世界矩阵，在未知变化或不支持路径同帧回退原 caster，并覆盖编辑、删除、显隐、多灯、RTT、插件与混合阴影缓存。现有静态合批明确排除 moving 节点，不能简单放宽门禁。

Babylon `RenderTargetTexture.getCustomRenderList` 可为实际绘制提供不同于投影计算的列表，但它也会在 readiness 阶段调用，不能假设每帧仅调用一次。当前 `SceneShadowRuntime.syncSceneMeshes` 会把场景中新载体自动注册到原阴影列表；`setRenderSuppressedMeshes` 又会将原 caster 从该列表移除。方向光自动投影根据原列表逐个计算世界包围盒；直接用批次载体的聚合包围盒替代可能改变投影范围和画质。必须先协调原投影列表、每个阴影目标的实际列表与 `HybridShadowCache` 的动态/静态分组，不能直接替换列表。

仓库已有隔离 MQTT 回放和阴影像素对照组件，但当前发现的录制为空；旧完整回放文件不在当前工作区，旧像素协议针对其他场景且静止无 MQTT。用户确认暂时没有真实录制，继续以隔离、可重复的受控运动输入检查穿梭车姿态、阴影与拾取，明确真实 MQTT 现场回放尚未验证；不能将静止数据、受控运动或其他场景报告冒充真实录制验收。

## 无真实录制后的隔离尝试

- 仅在隔离窗口以 `getCustomRenderList` 试用 37 个 shadow-only 薄实例载体，保留原投影列表。首版因未复制 36 个非索引网格的 `isUnIndexed` 只实际绘制 1 个载体，前次画面一致无效；修正后 37 个载体每个实际绘制 13 实例，阴影 draw 1250→806。该尝试未改产品代码或场景。
- 12 秒短窗中强制重算变体为 14.20→13.85 FPS、GPU 中位 36.24→34.26 ms；按现有 `HybridShadowCache` 的同步状态检查读取矩阵后，另一次短窗为 14.52→14.88 FPS、GPU 中位 35.67→32.90 ms。两次均非正式 ABBA，不能据此宣称稳定收益。分别见 `shadow-carrier-perf/report.json`、`shadow-carrier-synchronized/report.json`。
- 用临时合成 locator 和现有驱动施加走行、伸叉、急停；吸附、走行、伸叉三个接管帧共 481 个部件的源世界矩阵与载体/实例矩阵组合逐分量一致。伸叉触发货物网格变化后守卫回退原阴影列表，停止阶段没有载体接管。该输入不能代表真实现场消息或完整业务验收，报告为 `INCOMPLETE`。
- 针对 XC01 的四个近视角 A/A、B/B 均无差异，但载体与移除目标载体的画面相同，未能证明载体阴影可见；视角 0 原版与载体版有 20360 像素差异、最大分量差 13，原因未确定。诊断为 `INCONCLUSIVE`，未继续交错性能采样，不能宣称画质等价。原场景、列表和临时映射均恢复。见 `shadow-carrier-visible/report.json`。
- 同视角增加原生负控 A→移除原 caster→A→载体 B→移除载体→B→A：投影矩阵、相机、481 个源世界矩阵相同；原生 481 draw、移除 0、载体 37 draw×13 实例。A/A 自然变化 125 像素，A2/B 176 像素，A/O 148 像素，处于相近波动量级；此前 20360 像素差异未复现、原因未知。不能判定目标阴影是否可见、是否漏影，也不能认定画质等价。见 `shadow-carrier-negative-control/report.json`。
- 隔离窗口中再加入不投射阴影的临时接收面，固定相机、投影及 481 个源矩阵。A/A 像素差为 0，但原生移除 481 个 caster 前后像素差也为 0；虽 37 载体实际绘制且 A/B 像素相同，负控没有证明可观察到车体阴影，依然 `INCONCLUSIVE`。本次脚本先采集 A/O/B 全部帧，再计算像素差，未按预期先确认负控再采 B；B 只保留为原始记录，不作验证结论。接收面已销毁、原列表和回调恢复，见 `shadow-carrier-receiver-control/report.json`。它是合成接收面，不是工厂实际画面验收。
