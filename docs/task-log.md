# 任务记录

## 2026-10-27 场景打开与 Viewer 显示 Git 交付

- 已合并远端 0.4.5 版本并恢复本地场景打开、相机与图表立标改动，无冲突。
- 本次按要求不运行测试或验证；Python 字节码缓存保留本地不提交。提交和推送结果见本次交付回复。

## 2026-10-27 图表立标背景图清晰度修复

- 透明矩形及环形内置立标在图片解码后按原图尺寸提高纹理分辨率，并限制新增纹理占用；保留逻辑尺寸与文字布局。

## 2026-10-27 本地场景打开提示修复

- 区分文件选择取消与场景加载、资源准备或打开请求失效的失败，并在首页显示失败原因。
- 对关闭烘焙且旧烘焙资产缺失或未授权的本地场景保留原结果和引用，不授权旧资产，提示恢复后重开或清除结果。用户提供的场景经只读预处理和反序列化诊断成功，未进行编辑器实际打开验证。

## 2026-10-27 相机深度精度与本地恢复 Git 交付

- 已合并远端 0.4.4 与输送线异步加载邻接修复，恢复本地相机深度补偿和场景恢复改动，无冲突。
- 按用户要求不运行测试或验证；Python 字节码缓存保留本地不提交。中文四项提交及推送结果见本次交付回复。

## 2026-10-27 Worker 与标准照明 Git 交付

- 已合并远端 0.4.3 与输送线交接修复，恢复本地 Worker、法线变换及标准照明改动，无冲突。
- 本次按要求不运行测试或验证；Python 字节码缓存保留本地不提交。中文编号提交及推送结果见本次交付回复。

## 2026-10-27 展会模型阵列性能只读分析

- 用户提供 12:00:11 报告：普通场景性能监控格式，无性能运行 mode/telemetry，frameTiming 为 null；60 条跨 674.478 秒，中间有多处约60秒间断、56条帧指标重复，不能当连续一分钟。GPU 帧耗时全部 null。
- 报告中 48 个阵列实体、9 个变体、16 个批次及 84 个批次 Mesh；受管矩阵上传计数全程不变。最后样本 1010 的估算活动顶点 23624/159471（约14.8%），仅为几何工作量估算，不代表 GPU 时间。
- 与前份报告会话、相机和总 mesh 不同，434/1809 Draw Call 不可对比；隔离 1010 参数变更仍只支持脚本处理重于批次路径的有限采样结论。需前台采集包含 mode=editor-performance-run、telemetry 与逐帧 frameTiming 的连续报告。

- 后续建立任务专属隔离副本，使用当前 Vite 源码、编辑态、应用层写入/外网/子进程防护，按既有 store 入口将 1010 源 width 从 0.8 改到 0.9，未保存副本场景；R4/R5 后目标与8组变体均观察到 ready。源场景 SHA 不变，170 个基线文件未被修改或删除；原目录另有并发新增/移除烘焙文件，不确定归属且未处理。
- 两次 profile 排除首个未细分长采样间隔后，参数同步链 inclusive 约 96.6/65.0ms，脚本 applyModelParameters 约 65.8/43.1ms，syncModelArrayBatch 约 14.7/10.7ms；采样低且嵌套不可相加，并非用户修改端到端延迟或优化收益。观察稳定 3356/2479ms 包含轮询与渲染。
- 副本路径重定位、未连接 MQTT、应用层而非 OS 硬隔离；源/副本静态烘焙状态均 stale，R5 一次本地漫游人物 GLB 请求 ERR_ABORTED 的最终影响未知，未证明实际画面等价。产物位于 output/cemat-array-isolation-r3-9aXxD4/；连续现场运行报告尚未收到。

- 用户提供 10:48:30 场景性能报告：Intel UHD 630、824×440；60 条样本跨 207.448 秒，含 57.012/59.989/34.517 秒缺口，44 条数据重复，不能视作连续一分钟。最后 12 个近连续样本 FPS 中位 33.35、GPU 帧计数器中位 26.37ms，非逐帧 P95 或稳定对照。
- scenePreparation 完成，UI 准备总计约 8.19 秒，其中模型同步约 7.68 秒、模型合批等待约 426ms；projectOpen trace cancelled、openId 不匹配且关键路径不完整，未得到有效 modelArrayBatch 分项。
- 报告中实例/变体/批次/批次实体/批次 Mesh 为 48/9/16/21/84，采样首尾不变；受管矩阵上传累计 3389 次、955968 字节同样无增量，不能据此断言没有其他矩阵上传或修改耗时。
- newgd-motor-optimized.model.ts 的同步 onStart 生命周期累计 14 次 695.3ms、最大 63.8ms；不能直接归因某次阵列创建或修改。待连续采样及针对实际参数修改的可归因诊断。

- 用户确认场景窗口已恢复，窗口读取接口仍退出码 4；Electron 无可用 CDP 监听，性能报告保存在页面内存。
- 10:44 本地时间对该 Electron 进程做 10.073 秒只读 OS 采样：renderer 累计 CPU 11.750 秒（约 1.166 逻辑核心）、GPU 子进程 CPU 7.906 秒（约 0.785 逻辑核心）；工作集分别约 593.8 / 1666.1 MiB，不是显存、GPU 利用率或阵列函数耗时。运行模式和交互状态未知。
- 初查时已请求用户复制现有性能报告；当时创建、修改和运行的阵列函数热点仍无法归因。

- 用户指定 2026cemat展会；当前项目场景文件 SHA-256 为 32ead8bcf68c0c308f70e2956e3945a8726503b72262aff8deca0472a92cd07b，共 99 个实体、48 个阵列副本和 9 个源。
- 1010 源加 16 个副本存在 9 组静态参数值，脚本参数变化时会重新处理生成节点、材质和内部 thinInstance；运行态变体数及耗时尚未测量。
- 初查时目标场景启用真实 MQTT；窗口自动化无法读取，既有旧构建/回放工具不能代表当前实际业务输入，尚未启动独立场景或采集实时 profile。
- 初查时创建、修改、运行三个阶段瓶颈仍待采样；历史 2026-10-26 场景哈希不同，历史 FPS 不作为当前结论。


## 2026-10-27 阵列几何法线逆转置修复

- 使用 Babylon Matrix.transpose() 的返回矩阵计算阵列几何法线；保留原有 clone、invert、transpose 调用顺序，切线与镜像翻面处理不变。
- 使用真实 TypeScript 函数和 Babylon 做无监听端口的内存定向核对：旋转、旋转加非均匀缩放、旋转加镜像各覆盖有索引和无索引，共六组；核对面法线、正交性、切线、手性、面顺序以及修复前后的方法调用顺序，六组均能检出旧法线与面方向不一致；奇异矩阵仍拒绝。
- 修复会按预期改变法线结果，以及脚本 hook 观察到的法线矩阵；覆写 transpose 而不遵守 Babylon 返回约定的脚本可能受到影响。未做实际 GPU 画面检查。


## 2026-10-27 模型阵列同步几何优化核查

- 用户要求保持同步时序及外部脚本行为；已核查重复法线/切线变换、方向统计和空间分片，未找到可证明保留现有全部可观察行为的优化，未修改产品源码。
- 模型脚本可访问 Babylon Vector、VertexData 和 TmpVectors；变换方法覆写及共享几何读取器可能观察原调用、临时状态和中间写入。
- 发现既有法线矩阵代码丢弃 Matrix.transpose() 返回值，实际沿用逆矩阵；本次保留当前视觉结果，不将其修复或当作逆转置等价基线。
- 未执行测试或性能测量；待明确可允许的脚本兼容边界后再选择实现方案。


## 2026-10-27 烘焙与阵列几何 Worker 继续优化

- 烘焙几何在受控预算下以独立快照进行单 primitive 后台压缩，按原顺序提交；取消终止 Worker，失败从同一快照回退，稀疏或特殊数组维持原路径。
- 阵列调用链同步完成参数、拾取与旧批次切换，现有资源阶段不能直接等待最终几何；暂停阵列修改，等待对就绪时机调整的选择。
- Worker 实际内存回收、运行时效果与性能未测量。


## 2026-10-27 编辑器 Worker 后台计算

- 模型包扫描按最多两项并发并保持原顺序；GLB 密度解析使用有界 Worker，保留缓存、文件变化复核和不可用回退，大文件采用独占准入。
- 烘焙纹理 GPU 读回保留在原线程，像素转换和 PNG 编码可在 Worker 执行；保留透明像素 RGB、原缓冲、预算检查、取消和原路径回退。
- 默认静态人物程序化步态按网格有界并发计算，结果按原顺序安装；失败或切换人物时取消并收束任务，超出估算预算退回原计算。估算不是实际内存硬上限。
- 阵列同步创建及烘焙几何借用 Babylon 缓冲区的迁移需要额外处理生命周期和内存，暂未改动；未测量加速、运行时效果或打包后 Worker。前端与 Electron 的无输出 TypeScript 检查通过。


## 2026-10-27 Viewer 状态层 Git 交付

- 已合并远端场景局部同步、撤销记录与运行时生命周期更新，恢复本地 Viewer 异常提示关闭及文档改动，无冲突。
- 本次按要求不运行测试或验证；Python 字节码缓存保留本地不提交。使用中文四项编号提交说明，推送结果见本次交付回复。

## 2026-10-26 忽略规则与远端同步 Git 交付

- 已合并远端烘焙有界传输与大场景稳定性更新；同名设计审阅文档的远端版本包含本地内容及补充说明，保留远端版本。
- 提交 `_staging` 忽略规则，Python 缓存保留本地；本次按要求不运行测试或验证，最终推送结果见交付回复。
## 2026-10-26 设计问题 D04：剩余控制器生命周期收拢

目标：沿现有依赖顺序逐领域迁移，使 `SceneRuntime.dispose()` 只协调停止、资源释放、共享缓存归还与文档清空；不修改业务渲染、脚本契约或其它设计问题。

- [x] 模型资产、参数变体、阵列的停止与分阶段释放移回所有者。
- [x] 网格/灯光、定位器、CAD、特效与巡检资源自行管理释放。
- [x] 环境、变换预览、选择、就绪统计、生成产物与文档完成生命周期入口和必要的迟到回调保护。
- [x] 总门面改为阶段协调；复用最小现有检查并验证浏览器里的重复销毁、迟到结果与异常继续清理，更新设计状态。

实现：门面不再逐项清空子控制器字段，使用 `runSceneRuntimeCleanup` 有序协调停止、临时态/GI归还、实体/产物释放和共享缓存最终释放。资源所有者内部幂等，并在移除索引/使代次失效后释放对象。模型参数绑定和世界包围盒两个辅助控制器没有独立的强引用资源池，不新增空 dispose；参数纹理由模型所有者归还。

实际检查：源码 TypeScript 检查 0 条诊断；筛选复用 `generatedCargoPool.integration` / `generatedEffectTargets` 的 5 项生命周期检查和 `lightingDraftPreviewController` 的 5 项草稿恢复检查，10/10 通过。浏览器 WebGL2、DOM canvas 上的真实 SceneRuntime 使用受控资产结果，确认停止后无统计通知、重复销毁、各受检索引与文档清空、预览/高亮释放、模型租约先于共享缓存、借用 batch 不二次释放、迟到模型/环境释放一次，以及单个材质释放异常不阻断其它清理。烘焙取消边界使用受控天空就绪状态和 IPC：预算等待被 AbortError 终止，cancel 调用一次，订阅归零，未开始捕获且最终不重同步 GI。未新增或修改测试，未运行完整构建。

检查限制与过程：初始浏览器输入误用灯光种类 `rect-area`，改为契约规定的 `rectArea`；原始 Babylon 模块构造的合成模板未满足真实加载器的实例副作用注册，未将该尝试记为实例渲染通过，改用受控 owned-container 结果核对控制器所有权。资源计数区分每份租约，普通模型与参数变体的不同句柄不能误算为同一句柄重复释放。默认天空尚在加载时烘焙准入正常拒绝，随后仅以受控就绪输入验证销毁取消边界；未执行真实烘焙或大场景视觉验收。Scene/Engine、临时预览服务和 launch 条目均已回收；未提交或推送。

## 2026-10-26 设计问题 D04：遥测预览生命周期收拢

本轮边界为遥测、Fetch 库存和动态设备产生器；保留已有 D01–D03 与烘焙改动，不一次性迁移全部控制器。

- [x] Fetch 控制器独立管理停表、请求取消/代际隔离、批次重置与最终释放。
- [x] 动态设备停止入口先退订再释放；遥测控制器独立管理帧回调、合批与四类箭头的生命周期。
- [x] 总门面按停止、清理临时态、释放资源的顺序协调；普通退出预览保留编辑态资源，最终销毁不触发编辑态加载重试。
- [x] 审阅本轮差异，针对退出/重入和迟到响应复用最小现有检查，更新设计文档与实际结果。

结果：`SceneTelemetryController` 不再直接清空 Fetch/动态设备控制器的集合；`SceneRuntime` 对本领域改为阶段调用，停止方法与最终释放均有重复调用门控。清理异常显式记录并继续独立资源的释放，保留日志回调 receiver。

实际检查：按源码类型检查 0 条诊断；现有 `generatedCargoPool.integration` 与 `generatedEffectTargets` 筛选的 5 项，以及 `deviceSpawnerRuntime` 9 项全部通过。浏览器 WebGL2 + 真实 SceneRuntime/Fetch 控制器、可控延迟响应验证了旧请求 abort、迟到响应不应用、旧 finally 不扣减新会话计数、退出保留可重用 Fetch 运行时、最终释放清空与重复销毁。DOM canvas 诊断另确认普通退出恢复编辑态，而最终销毁不调用编辑态恢复/预取重试；注入单个箭头清理异常后其它释放继续，日志 receiver 正确，Scene/Engine 成功释放。未新增或修改测试文件。

检查边界与过程：Babylon Observer 的数组移除是延迟执行，待事件循环推进后确认活动回调归零；首个 OffscreenCanvas 诊断在额外回收原生 Scene 输入系统时失败，已导航关闭该上下文并改用 DOM canvas 验证销毁完成。独立 Viewer 起始页因没有部署清单报启动错误，未以其作为完整应用验收；实际检查直接加载当前源码的运行时模块。临时 preview 服务与配置已回收。其他控制器的生命周期仍待逐个迁移；本轮未提交、推送或执行完整构建。

## 2026-10-26 设计问题 D03：撤销命令补丁化

- 新增 `src/editor/commands/scenePatch.ts`（`captureScenePatch` / `applyScenePatch` / `createSceneUndoRecorder`）；`createFolderCommand`、`deleteEntityCommand`、`updateSceneDocumentCommand`、`moveEntitiesToFolderCommand` 不再持有整份旧文档。补丁按实体字典位置精确还原键顺序（序列化与未保存判断依赖它）；保留键相对顺序被改变时回退为保留旧文档。
- 对照测试（仓库外临时脚本，已删除）：400 单步与 60×25 步命令链逐键逐顺序一致，撤销到初始后 `serializeScene` 输出相同；5 万实体保留 60 条命令堆占用 180 MB → 0.1 MB（合成数据）。类型检查 0 条诊断；相关集成测试 65 项通过，`builtInSlotAssetSync.test.ts` 因无扩展名导入无法在该运行方式下加载，`HEAD` 副本同样失败。
- 语义差异：撤销改为把补丁还原到当前场景，而非整体替换为旧文档；历史后进先出时一致，历史之外的场景变更不再被撤销一并抹掉。未做：事务内合并、字节预算、`() => after` 闭包仍保留文档。未提交。

## 2026-10-26 设计问题 D02 剩余部分：按设备类型预分组

- 新增 `src/runtime/babylon/telemetry/arrowModelViews.ts`：`buildArrowModelViews()` 单次遍历只为已启用的箭头系统生成各自相关的条目（条件与各系统内部过滤一致），`SceneTelemetryController` 的 `update*Arrows()` 改为接收该分组视图，无参调用时只为自己构建。
- 对照检查：真实四个箭头系统 + 记录型渲染器/诊断会话，编辑态与运行态下“全量列表”与“分组视图”两种输入的渲染器调用与诊断输出逐条一致（含类型与绑定类型不一致、未就绪、冲突入口）；27 个箭头相关测试文件 161 项通过；前端按源码类型检查 0 条诊断。4000 模型输入构建约 0.52 → 0.17 ms/帧（合成数据）。
- 未做并说明原因：跨帧按设备类型候选索引（失效点不全、同帧动态设备增删风险）；专用遥测驱动 `prepareFrameCandidates()` 对每种类型各遍历一次全部模型，属另一处重复遍历，未改动。未提交。

## 2026-10-26 设计问题 D01：局部路径扩展到多实体，命令侧描述不单独实现

- 实测引用比较找变化实体：3000/2 万/5 万实体分别约 0.06/1.1/3.5 ms，而命令执行时 `{...entities}` 复制实体字典分别约 1.3/11/31 ms；命令侧变更描述只能省前者，且需改 40 多个调用点并有描述过期风险，故不实现，在设计汇总 6.2 节记录该结论。
- 局部路径改为按变化实体集合（`MAX_LOCAL_CHANGE_ENTITY_COUNT = 64`）：`resolvePlanNeutralSceneChangeEntityIds` / `patchEditModeModelThinInstancePlanForPlanNeutralChanges`（覆盖表容量不足整体完整重建）、`SceneDocumentController.syncEntitiesLocally`（`SceneRuntime` 门面同名）；面板用 `useMemo` 以实体表引用为键识别，替换原单实体版本。
- 对照：300 步多实体（1–6 个）计划补丁与完整重建逐实体一致；NullEngine 下 150 步多实体局部同步（102 步为多实体）与完整同步状态一致；64/65 个实体上限、夹带显隐变更、未声明的变化实体、空列表均正确回退。类型检查 0 条诊断；`alarmManager`、`digitalTwinEffect`、`environmentBuildingEffect`、`modelParameterRestoration` 共 33 项与阴影测试 36 项通过。未提交。

## 2026-10-26 设计问题 D01：阴影路径增量化

- `SceneShadowRuntime`：`updateCatcherBounds()` 在接收面未启用（`!enabled || !catcherEnabled`，编辑器恒为 `catcherEnabled:false`）时只关闭接收面、不再遍历全部网格算包围盒，启用必经 `applySettings` 写设置后的强制网格同步，届时重算；`invalidateCachedShadow()` 在混合模式下只调用新增的 `HybridShadowMeshState.markStale()`，由缓存绑定阴影贴图前已有的 `refreshForFrame()` 每帧合并为一次静态网格签名检查（`syncSceneMeshes` 中紧随 `setMeshes` 的显式 `refresh()` 一并去掉，`setMeshes` 本就重置帧标记）；`applySettings` 在设置未变且接收面未启用时不再强制重登记全部网格，只做常规检测并标记过期，否则保持原强制同步。
- 对照与测试：两个 NullEngine 运行时（局部 vs 完整同步，200 步随机改位置/名称/灯光强度，含灯光）状态全部一致、144 步走局部路径。同场景 3000 图元 + 3 灯：局部同步 165 ms → 约 120 ms，完整同步 725 ms → 约 680 ms（合成数据，单次测量）。阴影与光照相关 8 个现有测试文件共 135 项中 134 项通过；失败的 `sceneLightingRuntime.test.mjs` 第 8 项（post-activation validation failure rolls back…）在未改动的 `HEAD` 导出副本上同样失败，属已有问题，未调查。前端按源码类型检查 0 条诊断。
- 限制：混合阴影每帧对静态网格的签名检查是该缓存的检测机制，未改为脏网格驱动；烘焙签名哈希仍线性。未提交。

## 2026-10-26 设计问题 D01：运行时局部同步

- 新增 `SceneDocumentController.syncEntityLocally()`（`SceneRuntime` 门面同名转发）：要求组件集合不变、仅 transform/meshRenderer/light/camera/lighting/名称变化（`isEntityLocalSyncChange`），文档其余字段、其它实体与运行时已同步状态一致，无单体拖拽预览、非遥测预览、阵列身份模式与选区均不变，且目标实体运行时对象完整；否则返回 false 且不改运行时。路径内保留完整同步的顺序：`syncLighting`（含光照失效判断与阴影接收面重算）→ 实体同步 → 阵列批次、遥测代理、选区轮廓。`SceneViewPanel.tsx` 对计划无关的单实体变更先尝试局部同步，失败回退 `sync()`。
- 对照检查发现并修正：首版漏掉 `syncLighting` 导致阴影接收面尺寸与完整同步不一致。修正后用两个 NullEngine 运行时（图元与灯光实体，300 步随机改位置/名称/颜色/灯光强度，每步比较节点、网格与灯光状态）全部一致，300 步均走局部路径；改组件集合、改显隐、选区同时变化均正确回退。
- 实测 3000 个图元单实体改位置：完整同步约 114 ms，局部约 64 ms；剩余约 63 ms 为 `syncLighting`（烘焙签名约 28 ms、阴影设置约 35 ms）。合成数据，未测真实场景。
- 限制：对照测试未覆盖已加载的真实模型实体（NullEngine 下无模型资产，模型实体会因运行时对象不完整而回退）；模型路径复用与参数快路径相同的实体同步与阵列批次刷新，未单独验证。
- 前端按源码类型检查 0 条诊断；相关现有测试 `modelParameterRestoration`、`alarmManager`、`digitalTwinEffect`、`environmentBuildingEffect` 共 33 项通过。`runtimeVisibilityRoundTrip` 6 项失败，在未改动的 `HEAD` 源码导出副本上同样失败，属已有问题，未调查原因。未提交。

## 2026-10-26 设计问题 D01：合批计划局部补丁

- `editModeModelThinInstances.ts` 新增 `resolvePlanNeutralSceneChangeEntityId()`（判定单实体且仅 `transform`/`meshRenderer`/`light`/`camera`/`lighting`/名称变化，层级、显隐、锁定、组合及其余组件引用全部不变）与 `patchEditModeModelThinInstancePlanForPlanNeutralChange()`（沿用该实体在上一份计划中的原样/合批实例/解除合批形态，只替换这一个实体；覆盖累计 256 项回退完整重建）。`SceneViewPanel.tsx` 在参数变更之后接入，缓存方式与参数路径一致。
- 用仓库外临时脚本对照完整重建：509 步随机单实体编辑（含模型实例、源、报警独立目标、图元，中途跨过 256 覆盖上限）逐实体与分组计数全部一致；8 种应回退的变更（改模型资产、显隐、父级、子节点、合批关系、货格绑定、报警管理器、实体列表）均判为非中性。现有 3 个相关测试文件 26 项通过；前端按源码类型检查 0 条诊断。
- 未完成：运行时 `runtime.sync()` 仍是完整同步，计划局部化不改变其耗时；未测量真实场景收益。未提交。

## 2026-10-26 设计问题 D01：烘焙签名按实体复用序列化结果

- `sceneLightingBakeContract.ts`：`lightingContentHash` 的遍历抽成 `walkLightingContent`，新增 `getSceneLightingBakeSignatureCached()`（按实体快照对象缓存序列化片段；存在场景策略或继承策略的实体不缓存）。无缓存的 `getSceneLightingBakeSignature()` 行为不变。渲染端 `SceneLightingRuntime.sync()`、`LightingBakeManager`、`LightingBakeSettingsPanel` 改用缓存版；烘焙提交校验与 Electron 侧保持无缓存。
- 已用仓库外临时脚本对照原函数：四种配置（普通、sandbox、日夜周期、场景策略）下首次、命中、单实体编辑、环境切换、删除实体共 20 组输出全部一致；合成 20000 实体单次编辑后约 144 ms 降至约 58 ms。运行 4 个相关现有测试文件共 47 项全部通过，并用仓库外临时配置对源码做前端类型检查 0 条诊断。
- 注意：默认前端 `tsc -p tsconfig.json` 经项目引用读取已构建的 `dist-electron/*.d.ts`，在重新构建前会报新导出不存在；未重建 `dist-electron`。缓存按实体对象保存序列化文本，会增加与文档大小相当的内存占用，未量化。未提交。

## 2026-10-26 设计问题 D01 排查结论：暂停局部同步实现

- 核对后发现局部化运行时同步收益有限：面板侧 `createEditModeModelThinInstancePlan()` 对非参数变更仍全场景重建；`SceneLightingRuntime.sync()` 每次重算全场景 `getSceneLightingBakeSignature()`，局部路径同样必须调用。后者所在文件在烘焙稳定性整改的未提交改动内，未擅自修改。
- 本轮未新增代码，仅在设计汇总文档 D01 节补充“实施前补充发现”及调整后的实施顺序（先烘焙签名增量化与合批计划局部补丁，再做运行时局部同步）。未运行检查，未提交。

## 2026-10-26 设计问题 D01 第一步：完整同步内的单次分类遍历

- `SceneDocumentController.syncDocument()` 原先对 `entityIds` 做约 20 次独立遍历（各组件 ID 集合、四类箭头开关、`alarmManagerIds`、数据平台屏幕集合）；已合并为一次遍历，产物与判定条件不变。
- 未完成：命令侧变更描述、Store 累计修订、层级/组件增量索引及更多局部更新路径（文档 6.2 的 1–3、5、6）。完整同步仍随场景规模线性增长，只是常数变小；现有 `syncModelParameters` 快路径本身仍有一次引用比较扫描。局部编辑尚未真正绕开 `runtime.sync()`。
- 修正前一步 D02 的类型错误（`collectModels()` 返回 `Iterable`，无 `.map`）。已运行前端 `tsc -p tsconfig.json --noEmit`，0 条诊断；未运行测试或页面验证，未提交。

## 2026-10-26 设计问题第一阶段：D02 当帧模型视图、D03 撤销历史上限

- D02：`SceneTelemetryController` 每帧在至少一类运动箭头启用时只调用一次 `collectModels()` 并解析设备类型与可见性，四类箭头共享该只读视图；全部关闭时不收集，各 `update*Arrows()` 保留无参回退。运动计算与更新频率不变；按设备类型的候选索引尚未做。
- D03：`CommandHistory.executeCommand()` 增加 `MAX_UNDO_HISTORY_ENTRIES = 200` 条数上限并裁剪最旧命令；这不是内存字节上限，批量命令补丁化与交互事务内合并尚未做。已确认保存状态不依赖历史长度。
- D01、D04–D07 未开始。仅审阅 diff，未运行测试、类型检查或页面验证；未提交。

## 2026-10-26 输入校验修复 Git 交付

- 已拉取远端，无需额外合并；提交 TypedArray 输入校验修复及原任务记录。
- 本次不运行测试或验证；`_staging/` 与 Python 字节码缓存保留本地不提交。中文编号提交及推送结果见本次交付回复。

## 2026-10-26 修复烘焙 TypedArray 输入校验编译错误

- 核查最新提交 `dfee81f`，确认 `lightingBakeValidation.ts` 将 `ArrayBufferView` 直接读取 `length`、将 `ArrayLike<number>` 用于 `for...of`，导致 `TS2339` 和 `TS2488`。
- 输入校验明确排除 `DataView`，使用下标遍历普通数组或 TypedArray，保留长度及有限数值检查与零拷贝输入。
- 按现有前端、Electron TypeScript 配置执行不输出产物的类型检查：前端 0 条诊断，Electron 修复前 2 条、修复后 0 条。已审阅修改 diff；未运行测试、完整构建或启动验证，未提交或推送。

## 2026-10-26 烘焙 TypedArray 传输 Git 交付

- 已快进合并远端 0.4.2、资源修订审计和漫游碰撞相关更新，保留本地烘焙几何与传输改动，无冲突。
- 按用户要求不运行测试或验证；Python 字节码缓存保留本地不提交。中文编号提交及推送结果见本次交付回复。

## 2026-10-26 中台静态打开图片审计修复

- 图片审计从整个React界面逐项扫描改为唯一场景canvas的owner/runtime绑定，并交叉核验真实绘制canvas；保留只读descriptor、Proxy/getter拒绝、完整图片URL/修订/registry/API/物理文件SHA校验。补充有界并发、阶段进度、请求/总时限及清理时限。
- 已有图片审计16/16通过，未新增或修改测试。本轮未自行重建产品；启动指纹对应现存构建，其他任务的碰撞修复/构建保留。
- `output/babylon-optimization-20261026/static-audit-fix/open-3/result.json` 完整单次静态验收通过：打开202.31秒，76个引用文件匹配；18图片槽位/2张图片审计99.36秒完成，清理无错误，验证进程全部退出。两次前置失败仍保留，不合并成成功性能样本。
- MQTT与GI未执行，实验开关不变；完整五冷五暖及性能门槛仍待验收。本次未提交、推送、部署或覆盖原工程；细节见既有Babylon专项清单。

## 2026-10-26 手动漫游碰撞协调器注册修复

- 启动手动漫游后，`moveWithCollisions()` 触发尚未注册的 `Scene.CollisionCoordinatorFactory`，使 Scene View 报 `DefaultCollisionCoordinator needs to be imported`。
- 在公共 `babylonSideEffects.ts` 补充 `Collisions/collisionCoordinator.js` 副作用导入，让手动漫游使用的模块图提前注册默认碰撞协调器。
- 已对照本地 Babylon 实现并审阅变更；未运行测试、构建或真实页面验证，已运行实例是否加载修复尚未确认。
- 后续按用户要求重新执行 `npm run build`（包含 Viewer）和 `npm run build:electron`，均成功；启动 `dist/index.html` 正式构建，在最近场景 `2026cemat展会` 进入运行态并启用手动漫游。角色实际前进约 2.49 米，移动期间推进 51 帧，退出及重新启用均正常，页面异常与控制台 error 均为 0。
- 构建日志、坐标/状态记录及截图保存于 `output/manual-roam-recovery-20261026/`；编辑器保留运行。此次验证为本地正式构建，未发布或替换远端数字孪生产物。

## 2026-10-26 Babylon 加载渲染计划续作核查

- 对照用户指定计划及现有专项代码，更新 `docs/tasks/2026-10-26-babylon-load-render.md` 唯一清单，区分历史完成、条件停止和待验收。
- 补齐固定包SHA在模型重载及GLB/脚本请求中的一致性、声明模型脚本集合换代、所有模板入口的实际声明捕获、生成器/库位目标签名；新增打开前设置的共享Geometry同构建对照开关，保留原默认与已有lease。
- 现有定向检查42/42通过；开关变更后共享生命周期相关16/16通过（与前组重叠）。日志在 `output/babylon-optimization-20261026/continuation-contracts.log` 与 `continuation-sharing.log`；后续Editor/Electron/Viewer构建通过，未新增或修改测试。
- 用户选择原383实体工厂，并因无MQTT要求先做静态打开。当前同构建六轮A/B/C/C/B/A完整像素一致：原版中位72.50秒、材质候选60.45秒（−16.61%）、加准备门51.68秒（−28.71%）；见 `continuation-383/local-comparison.json`，不混算旧版本结果。
- 中台原工程单次最终就绪188.78秒，包含自动全库同步，源/逻辑投影一致并保存实际截图。后置图片CDP遍历长时间未完成，按静态范围收口关闭专用窗口；整套审计保留FAIL而非通过，任务进程已退出，用户原Editor/开发服务保留。详见专项记录与 `continuation-383/remote-open-stable/`。
- 完整中台五冷五暖、持续动作、完整GI/Viewer及默认晋级未完成，未宣称达到30%/15%。修正静态验收工具的生产迁移/内置ENV输入比较及自动同步后二次就绪判定。保留入场Conflicts与Python缓存改动，未提交或发布。

## 2026-10-26 烘焙路径与 MQTT 回退 Git 交付

- 已拉取远端，当前分支无需额外合并；提交烘焙短目录、旧任务兼容及 Viewer MQTT 地址回退改动和说明。
- 按用户要求不运行测试或验证；Python 字节码缓存保留本地，不纳入提交。推送结果见本次交付回复。

## 2026-10-26 发布后 MQTT 空地址回退修复

- Viewer 合并中台运行配置时，未配置 MQTT 地址则沿用发布包地址；有效中台地址仍优先，保留启用开关、订阅要求、项目停用与地址安全校验。
- 更新 MQTT 使用指南；按用户要求不运行测试，本次亦未构建或执行运行时验证，仅审阅修改内容与 diff。
- 源码修复完成；已有部署需重新构建 Viewer 并发布后生效，本次未发布、提交或推送。
## 2026-10-26 Babylon 加载与渲染专项（阶段交付，未整体验收）

- 实现实际源验证的只读Geometry/lease、thinInstance局部上传、显式原生材质初始化API和初始准备期分类候选；原工程及既有未提交改动保留。
- 电机独立修订真实BAAB本地打开观测中位71.54→59.02秒（−17.50%），四轮完整RGBA一致；准备门组合单次50.48秒，未正式验收，默认关闭。运行帧间隔≥15%和真实中台冷暖≥30%尚未达成。
- 构建、改动文件lint、定向检查及真实Editor保存重开/非GI导出/Viewer通过；光照专项保留入场已有的材质回滚失败。未提交、推送或覆盖原资产。
- 唯一清单、全部证据和限制：[Babylon专项](tasks/2026-10-26-babylon-load-render.md)；[使用与准入说明](babylon-model-runtime-optimization.md)。用户追加的一小时窗口已超出，不将本次阶段成果表述为全方案完成。

## 2026-10-26 编辑器场景加载 100% 后遮罩不退出

- 根因：天空 ENV 完成后的 `applyPreparedSkyboxEnvironment` 会替换场景对象，资源事务 `after` 仍指向旧对象；首帧通过后事务 CAS 拒绝结算，而准备状态进入 completed 并停止轮询，造成 100% 遮罩永久保留。
- 修复：实体天空和旧场景级天空的派生缓存写回，原子推进属于当前文档的 transaction/recovery `after`；保留原始快照、撤销历史、旧事务拒绝和真实首帧门控，不强行隐藏遮罩。
- 验证：浏览器编辑器使用真实内置 256 ENV 和内存资源事务，修复前复现 `completed=true`、100%、事务失配且遮罩保留；修复后同一链路事务正常清空、天空 ready、遮罩数量 0，缓存写回不改变历史。截图 `output/scene-loading-finish-20261026/editor-ready.jpg`。未运行测试套件或构建，未复跑用户真实 Electron 项目、修改用户场景文件或提交代码。
- 验证边界：浏览器无 Electron IPC，资源库有对应不可用提示；热更新重载曾出现 `LoadingScreen needs to be imported before`，未将其当作本次事务故障，也未扩展修复。组合库自动身份同步另有条件性事务失配路径，已单独标记待办，未混入本次修复。

## 2026-10-25–26 原生无限远天空盒与 ENV 全链路改造

- 实现已完成；唯一验收清单及完整证据/限制见 [方案 R1–R12 与实施结果](tasks/2026-10-25-native-skybox-migration-plan.md)。源资产与运行 ENV 分离、v7 兼容 1–6、编辑端单 GPU 队列、受控双 preload IPC、原生无限远运行时、交互/相机清理、GI 源捕获及所有保存/打开/发布/导出入口均已接线。
- 保留 HDR/EXR 原图与旧位姿数据；新增三档内置预生成 ENV，运行时只读取 ENV。SOURCE 携带原图与 ENV，DIST/独立目录/ZIP 只携带引用的 ENV；实际导出发现并修复了独立导出漏筛整个内置天空库的问题，也统一了模板能力门禁。
- 收尾修复：取消等待任务立即出队、commit 回调后再查取消、提交中即时取消主进程 token、按场景会话隔离共享准备、兼容受控 URL 原图路径、源 SHA 版本化读取、防 Junction 写出缓存根、会话租约与历史缓存回收。天空属性显示 ENV 状态、可操作重试及旧位置/尺寸失效说明；开发预构建覆盖转换器与 Worker，避免首次导入重载页面。
- 最终构建/类型检查、ESLint 与增量规范检查通过；天空盒定向 **52/52**、登记和版本兼容 **14/14**、清单生成及 `--check` 通过。此前完整 core 通过，后续仅重跑受影响路径。日志均在 `output/native-skybox-implementation-20261025/`。
- 真实 Electron（RTX 4060 Ti）验证导入、旋转/分辨率、缺原图保留旧天空、重试、保存重开及总加载结束；目录/ZIP 导出通过且无原图/未引用库。证据 `electron-ui-zkkdfg/result.json`、`saved-reopened.png`；page/console error 0。实际独立 Viewer 也已打开，记录 `published-preview.json`：运行中、无总蒙版、无 HDR/EXR 或天空转换 Worker 请求。
- 真实 WebGL（RTX 2070 SUPER）验证透视/正交、25 km 平移、GI 同源输入/签名、隐藏背景保留 IBL、A→B→A、失败保留、迟到释放及 context restore；`native-webgl.json`。六种 EXR 压缩离线生成/重载及提交取消通过；实际 Blender 环境节点仍使用原图/旋转/强度，`exr-fixtures-final/webgl-result.json`。最新 SOURCE/DIST 集成通过，`final-source-dist.log`。
- 画质 A/B 256/512 六方向及三种金属粗糙度最大通道差 1/255，低于预冻结误差门槛；三档十次 ENV ready 中位约 95/151/344ms，保留全部原始数据与条件，不声称工厂 FPS 收益或零上传成本。
- 综合回归不是全绿：入场已有两份 preload 的 `getProjectOpenTrace` 不一致、源码截取测试缺少诊断/光照 helper、材质回滚颜色断言、要求烘焙却无结果的资源夹具及 Cycles 探针重试断言失败。相关原像/日志保留，未关闭校验或扩展修复范围；未验证真实生产中台、完整工厂GI/FPS或峰值显存。
- 执行事故已恢复：临时基线 worktree 的共享依赖 Junction 清理误删 `node_modules`，已按 lockfile `npm ci` 恢复及重新准备 Electron，恢复后完成上述构建与实机验证，源码/用户工程未删除；教训已记入 `docs/lessons.md`。本任务验证服务已关闭；未提交、推送、对外发布或覆盖其它任务的未提交业务修改。

## 2026-10-25 原生无限远天空盒与 ENV 资源链路影响调查（仅方案）

- 目标：按用户要求找全原生无限远天空盒、编辑端 HDR/EXR→预过滤 `.env`、运行时仅消费产物的关联调整点，不实施业务代码。
- 交付：[修改方案与验收清单](tasks/2026-10-25-native-skybox-migration-plan.md)、[完整引用索引](tasks/2026-10-25-native-skybox-impact-index.md)。扫描 2031 个文本文件，319 个直接命中文件及 36 个调用链补充项；区分 85 个明确修改入口、8 个算法保留/迁移模块、1 个退役模块和关联回归/历史记录，不能将全部 355 项当作必须修改文件。
- 关键证据：当前层级树过滤天空盒；有限球体规则涉及 Gizmo、聚焦、相机距离及 Viewer 边界；双 preload、源/运行资源角色、SOURCE/DIST 与独立部署、GI 捕获/签名、内置单文件包及正交相机均纳入方案。
- 验证范围：静态搜索、关键调用链与已安装 Babylon 9.12 API 阅读，以及交付文档的路径/分类/覆盖检查；未运行应用、测试或构建，未转换原图、保存用户场景、提交或发布。现有未提交业务改动保持原状。
- 未完成：实现、真实 WebGL 画质/性能、旧场景视觉变化、EXR 离线格式覆盖、GI 等价性及全部发布回归；这些作为后续实施验收项，不声称已通过。

## 2026-10-24 Electron 开发启动与首次运行时下载

- 目标：解释 `缺少 270/270 个 Electron 产物`，恢复 `npm run dev:electron` 的正常启动，并让运行时准备/进程启动失败可见。
- 证据：当前 135 个 Electron 输入对应 270 个编译输出，全部存在；真实再次编译退出 0、`forced=false`。本地 Electron 42.4.0 的 `path.txt` 与 `dist/electron.exe` 缺失，官方包通过 `require('electron')` 按需准备运行时，旧启动器直接拼接路径且静默处理 spawn error。
- 范围：仅开发启动器、独立启动回归及相关文档/入口；保留现有 TypeScript 强制恢复机制、用户原有 5173 开发进程和未提交改动，不调整依赖版本。
- 验收清单：[x] 实际编译完整且后续增量；[x] 首次运行使用官方运行时解析入口；[x] 准备/启动失败退出非 0 并清理本次子进程；[x] 定向回归及真实窗口启动；[x] README 与独立回归入口同步。自动测试清单刷新被下述既有摘要漂移阻断，未修改登记摘要绕过检查。
- 修改：启动前通过 `createRequire(import.meta.url)('electron')` 获取官方可执行路径，保留首次按需下载和自定义运行时支持；子进程 `error` 显示命令及原因，并退出、回收本次子进程。实际调用官方入口已补齐 Electron 42.4.0 二进制，不修改依赖或用户既有 lockfile 改动。
- 验证：旧启动器的首次准备及安装失败两个隔离反例均 RED（静默失败后超时）；修复后的 `npm run test:dev-electron` 3/3，`npm run test:typescript-build` 11/11；启动器与新增测试定向 ESLint、Node 语法、package.json 格式、diff 检查通过。测试使用隔离假包验证错误路径，不能代替实机集成。
- 实机：官方运行时连接原 5173 服务，独立临时用户目录中主页→空白编辑器通过，preload API 存在，场景准备蒙版消失后 RTX 4060 Ti WebGL 可用，page/console error 均 0。首轮截图仍在准备阶段，未作为完成画面；最终证据 `output/electron-dev-startup-20261024/result-ready.json` 和 `editor-ready.png`。
- 完整入口：直接执行本项目 `npm run dev:electron`，自动选 5174，预热 524 个模块、Viewer 构建及 Electron 编译通过，真实 Windows 窗口显示完整主页。关闭本次验收窗口后命令退出 0、5174 与本次 Electron 进程已释放；用户原有 5173/PID 29400 保留。未保存/修改用户场景，未提交、推送或发布。
- 既有检查限制：`node scripts/generate-test-inventory.mjs` / `--check` 因 `scripts/smoke-published-cache.mjs` 源码与分类登记 SHA256 漂移失败，本次没有修改该文件或登记表；自动生成的 `docs/test-inventory.md` 未刷新，新增回归可通过 `npm run test:dev-electron` 直接执行。
- 清理限制：自动审批拦截两个本次临时用户目录的精确范围删除，返回 `blocked by policy`，无具体原因；没有换工具绕过。`result.json` / `result-ready.json` 中记录的两个 `zending-dev-runtime-smoke-*` 临时目录保留，测试窗口均已关闭。

## 2026-10-24 渲染与烘焙优化 Git 交付

- 已拉取远端，当前分支无需额外合并；提交现有渲染、加载、烘焙及相关文档用例改动，Python 字节码缓存保留本地不提交。
- 本次按用户要求不运行测试、构建或代码验证；历史结果与未验收边界保持不变，不以 Git 交付代替功能或性能验收。
- 使用中文标题及四项编号说明提交推送，最终结果以本次交付回复为准。

## 2026-10-23 光照失效与帧开销 Git 交付

- 已快进合并远端 0.4.1 版本和小车出梯等待修复，恢复本地光照失效及帧开销改动，无冲突。
- 本次按用户要求不运行测试、构建或代码验证；原结果中未证明稳定 FPS 收益和卡顿未彻底解决的边界保持不变。
- 使用中文标题及四项编号说明提交推送，最终结果以本次交付回复为准。

## 2026-10-23 光照管理增强 Git 交付

- 已快进合并远端小车进出提升机、载台高度和货箱跟随修复，恢复本地光照管理与烘焙增强改动，无冲突。
- 本次按用户要求不运行测试、构建或代码验证；保留原任务未完成验收及等待事项，不将提交推送视为验收通过。
- 使用中文标题及四项编号说明提交推送，最终结果以本次交付回复为准。

## 2026-10-23 第二轮场景P0/P1（等待烘焙完成）

- 用户确认本地完整工厂对照，要求先P0再实现关闭态完全旁路/光照分类去重，P2由实测决定。
- 已冻结入场生产、构建独立基线并通过资源/时钟/门禁校准；正式P0尚未开始，P1生产代码未修改。
- 用户明确选择等待另一任务Cycles完成；自有等待run已取消并清理，已建立同聊天5分钟续办，重负载未变时安静等待。
- 继续命令、范围及检查点见 [执行记录](tasks/2026-10-23-frame-cost-p1.md)。

## 2026-10-23 光照与烘焙管理器综合优化（当前实现交付，长验证已停止）

- 已接入预检、共享校验、摘要与诊断、分类/探针查询缓存、任务历史和安全清理、阴影成本、二进制输入、临时草稿预览、区域探针及GPU选择/回退；保持lighting v2/appearance v1，不提交推送发布。
- 最新typecheck通过；专项67通过/1条件SKIP/0失败；46个实际生产文件lint无错误告警，声明文件按配置忽略；diff检查与测试清单生成通过（unclassified=0）。此前小场景真实Electron/Cycles/独立Viewer闭环及构建记录保留，不能视为最后补丁已完成全部实机回归。
- 完整工厂821输入/870875三角面准确UV与排版通过，42图集/168MiB、264规划探针；用户要求快速结束后，已仅停止本任务Blender，41张候选保留但未正式提交，原D盘场景SHA不变。
- 完整工厂GI/FPS、最新版SOURCE/DIST回归、GPU显存容量预检及硬件GPU验证未完成，不宣称整体全部验收通过。具体代码、证据与停止边界见[执行记录](tasks/2026-10-23-lighting-manager-optimization.md)。

## 2026-10-23 动态货物模板预取 Git 交付

- 已拉取远端，当前分支无需额外合并；将本地生成器模板预取、就绪接线及相关文档和用例纳入提交。
- 本次按用户要求不运行测试、构建或代码验证；原实现阶段的验证记录及未验证边界保持不变。
- 使用中文标题及四项编号说明提交推送，最终结果以本次交付回复为准。

## 2026-10-23 动态货物模板启动预取（本地验收完成）

- 用户授权仅实现启动预取与预解码，复用既有模板缓存，保留画质、参数化脚本和动作逻辑，不提交或推送。
- 新增纯模板预取 lease 与生成器目标协调器；连接默认/规则/组合成员、加载进度、Editor/Viewer 首帧门控及配置/场景释放。组合阵列源继续独占 Geometry，但复用模板解析缓存。
- 专项42/42、设备交接122/122通过；准备/回调组38/39，旧Sandbox加载失败日志receiver断言已在修改前HEAD复现，单列保留。最终typecheck、Editor/Viewer build、定向lint和独立审查通过，观察者异常不会再覆盖模板句柄或阻断准备。
- Intel UHD630硬件WebGL：首次生成读取解码增量1→0，真实输送机交接身份/连续性/点击宿主及脚本动画隔离通过，固定首件与交接末态像素一致；初始夹具失败记录保留。测试资源已回收，脚本/驱动/public无修改，不宣称现场FPS、现场MQTT或导出DIST验收，不提交推送。
- 验收清单和后续结果见 [本轮执行记录](tasks/2026-10-23-generated-cargo-preload.md)。

## 2026-10-23 阵列与动画帧开销 Git 交付

- 已快进合并远端 0.4.0 版本及输送线排队、换层提升机互锁更新，恢复本地阵列负间距与动画帧开销优化，无冲突。
- 本次按用户要求不运行测试、构建或代码验证；历史验收记录不代表合并后版本已重新验证，原有未验证边界保留。
- 使用中文标题及四项编号说明提交推送，最终结果以本次交付回复为准。

## 2026-10-23 动画帧开销优化（本地验证完成）

- 已授权优先优化运动节点平方级过滤及阵列刷新后的重复光照几何摘要；画质、脚本、动作和遥测频率保持。
- 保留真实光照失效和异步新增网格事件，避免漏掉未知脚本的跨模型或原位修改；以精确缓存复用摘要。
- 相关回归198项通过，新增缓存覆盖率100%行/93.33%分支；TypeScript、Editor/Viewer构建和定向lint通过。硬件WebGL六姿态零像素差，既有编辑器MQTT/保存重开/取货/断流验证通过。
- 独立审查问题修复并复验；16MiB快照预算、精确原位检查和GC释放通过，19份保护文件SHA不变，无自有进程残留。原阵列测试解析缺口与现场450ms/FPS未验证边界保留，未提交推送/发布。
- 验收与证据见 [执行记录](tasks/2026-10-23-animation-frame-cost.md)。

## 2026-10-23 Git 同步交付

- 已快进合并远端设备交接与换层修复，恢复本地光照、性能治理、模块解耦及预览发布改动，无合并冲突。
- 本次按用户要求不运行测试、构建或代码验证；历史验收与未完成项维持原记录，不代表合并后版本已重新验收。
- 使用中文标题及四项编号说明提交推送，最终结果以本次交付回复为准。

## 2026-10-22 P2-R0 计量校准与 B0 基线（本地验收完成）

- 修复缺失/未采样 counter 假零和 null 格式化，新增真实 afterRender 固定墙钟窗口；生产仅 6 个诊断文件改变，726 个其他生产源与 public37份逐字节不变，画质/参数脚本/设备算法保持。未进入 R1，旧 OFF 钩子仍在。
- 完整冻结 1797 源+826构建文件，8×60秒硬件WebGL2/DPR1有效 B0；两套原始时间线帧数/FPS精确互核。动作 FPS 为1440p 5.917、2160p 4.500，原 ready/预热门槛保持；不作15%/30%收益结论。
- 定向34/34、typecheck/lint/build、入口91无缺失、P4分类9/9、CI798通过+1外部EXR条件SKIP；inventory零漂移。额外observability首项Sandbox fetch failed已在入场前像复现，单列未通过，未压错。
- Viewer真实UI自然unknown→有效样本、复制与关闭通过；原生节点另实例核对140根/3440节点，静态前后零变化、动作33已有节点变化。原stale后仍有1输送货物根移动/4节点仅缓存世界矩阵变化（2项父链关系未证），按原逻辑保留；缓存稳定不等于全场停止。
- 未来JS同条件110%、新增buffer64MiB、新纹理0及全局4下载/2校验/4包、256MiB pending/1GiB staging/512MiB独占source预算已冻结；JS采样下界、buffer快照、纹理/真显存未知边界保留，真实中台与6设备完整轨迹未验收。
- 旧历史与原始失败保留；完整源/构建/输入/harness指纹及自有进程结算已核对，无提交/推送/外部发布。详情见 [P2-R0执行记录](tasks/2026-10-22-project-optimization-p2-r0.md)。

## 2026-10-22 P2 方案重设计（仅文档完成，代码待授权实施）

- 按用户要求更新 `docs/project-optimization-plan.md`，保留已完成的编译缓存、FIFO 调度、包流水线、矩阵/Gizmo 能力与 P1/P3/P4 状态；原专项二设计和 P2 清单原文折叠保留，旧未通过项目不补勾，历史 P2 执行记录和采样摘要未改。
- 新增待执行 P2-R0～R5：冻结版本/计量、真正无机制 OFF、默认 CPU 热点、完整加载关键路径、受限几何聚合试点、整阶段默认版本验收。纠正总 Mesh/Active 口径，区分旧 OFF、无机制 OFF、同 build ON 及最终默认版本的收益。
- 明确未来目标与统计：持续动作两分辨率帧间隔 P50 各降至少 15%、有效 FPS 同向提高，尾延迟预定 5% 性能噪声带；真实中台冷/暖中位各降至少 30%，至少 5 次原始值与观测最慢保护。画质、脚本生命周期、参数/环境快照、MQTT 顺序和动作频率保持；原数据不作当前性能或收益承诺。
- 本轮仅编辑计划与本记录，做文档内容/链接/命令名称/历史字节与范围检查；未修改代码、测试、配置或运行 benchmark/build/功能测试。修订前副本及文档验证保存在 `output/project-optimization-p2-redesign-20261022/`；所有新阶段未开始实施，真实性能仍待后续验证。

## 2026-10-22 GLB 标准预览与默认环境照明（执行中）

- 用户确认实现预设与默认环境，普通/环境模型均支持，保留已有场景，并用展会 GLB 验证保存重开及本地发布。计划与验收见 `docs/tasks/2026-10-22-glb-standard-preview.md`，工作区基线见 `output/glb-standard-preview/baseline.json`。
- 已先取得合同、预设草稿与异步环境回归 RED；共享配置及 Sandbox 基线 helper 已实现，旧配置缺字段保持原有行为。后续运行时、真实 UI 和保存/发布验收执行中，尚未宣称完成。

## 2026-10-22 P4 类型安全与测试治理（本地验收完成）

- 实际入场18项未使用诊断清零，两个正式tsconfig启用noUnusedLocals；ESLint152→0 warning、0error，四项关键正确性规则error。保留getter/异常求值、Hooks门控、脚本/遥测/设备动作及画质。
- 301候选逐文件分类；160份Node契约接六领域159命令全部通过，87条manifest入口无缺失、inventory777文件/692候选/98入口零漂移；139项环境/人工候选未整体执行，另2项为辅助工具，不以分类代替通过。
- 最终build/typecheck/lint、CI、integration/smoke及六领域全部exit0；P4 9/9（含22项实际DOM）、巡检48/48、P2 179/179、P3 28/28、统一光照42/42。真实Electron Editor35项、loopback MQTT/保存重开、SOURCE/DIST四配置和独立Viewer通过；固定静态ROI318275像素changed/max0。
- SSR改真实模块图构建，原assert/门槛保留；旧夹具先用入场产品/既有文档独立证明后修正，原始失败及所有重试保留。独立审查无阻断，18关键源12同字节/6已审质量改动，116资源225756283bytes及场景/回放保持。
- 入场1667快照保留，范围diff与资源结算完成；用户原5173服务保留，无提交/推送/外部发布。CI既有1个外部EXR条件SKIP不计通过，构建大chunk提示及既有lastSecAverage监控warning保留（源码未改）；没有重测或声称工厂FPS提升，P2总验收未完成且合批缺省false。
- 详细命令、证据及限制见[P4执行记录](tasks/2026-10-22-project-optimization-p4.md)。

## 2026-10-22 P3 核心模块解耦（本地验收完成）

- 完成 Runtime 协调器/领域 Controller、六个 Zustand Slice、面板/薄实例子模块和 Electron 公共资源遍历。核心最大2449行，SceneRuntime由入场10909行降至725行；保留公共签名、234个Store键、命令历史、构造/帧/释放顺序。
- 最终build/typecheck/lint、test:ci、test:integration、test:smoke、test:lighting-unified全部exit0；P3专项28/28、P2回归179/179、统一光照42/42。lint 0error/152warning；79个既有manifest入口无缺失，inventory90入口零漂移。
- 实际生产Editor35项、SOURCE/DIST四配置、独立Viewer WebGL及loopback MQTT通过；静态视口318275像素changed/max均0。最后类型标注/新增文件EOF修正的JS等价及重建466份JS/CSS字节一致，实机证据对应最终运行版本。
- 修正Controller回调receiver、资源身份getter预检顺序、MQTT浏览器default导出兼容及原生TS类型导入；旧夹具按真实保存/渲染契约对齐，303条发布assert和1624条私有探针expected/message保留。发布测试的原生编译在Node隔离，Electron实际退出码仍严格传播，历史失败日志全部保留。
- 入场1556文件快照保留，18份关键源与116份资源225756283bytes、原场景SHA保持。P3范围125文件diff审计通过；入口已有buildTypeScript EOF空行未动。任务进程无残留，保留用户5173服务，没有终止不相关进程。
- P2整体性能目标仍未验收，动静合批缺省false；未进入P4，未重测工厂FPS或真实中台/现场服务，未提交、推送、外部发布。详细状态、证据及限制见[P3执行记录](tasks/2026-10-22-project-optimization-p3.md)。

## 2026-10-21 项目专项优化 P2（部分落地，整阶段未验收）

- 按 docs/project-optimization-plan.md 推进P2；完整清单、源码与失败/最终证据见 docs/tasks/2026-10-21-project-optimization-p2.md。入场1628文件SHA/字节副本保留，P1与其它存量未提交修改保留，未提交、推送或发布。
- 落地实际TS内容/编译器版本的HMAC持久转译缓存、FIFO分帧宿主初始化、按包有界下载/校验流水线、受控矩阵冻结、Gizmo运行时预览和结束一次命令。原授权/签名/版本/原子推广及回滚保留，参数脚本及动作算法未改。
- Profile定位重复几何canonical；缓存保持原算法和精确CPU检查。真实680环境surface因内部Hybrid包装持续cache miss，新增同Geometry/函数双弱键delegate登记；3消费者仅import+4登记，去除后与入场字节一致，回调body/receiver/顺序/异常/释放不变。相关26+17+98共141通过。
- 新动静合批保留业务原件/层级、照明/阴影/选择身份及公开GPU上传同帧归还；实机仍有负收益，motionStaticBatchingEnabled缺省false，实验API保留。新增默认/开启/关闭恢复回归，原6项继续显式开启，不绕功能断言。
- 最终build/typecheck/lint/test:ci通过，P2聚合179/179、0skip/cancel，lint0error/182存量warning。真实Gizmo30项、生产Editor/独立Edge Viewer及16包对照证据保留；16包12PASS/原4FAIL同数值，166PNG配对中142非时间动画逐字节一致；最后环境缓存由canonical等价回归及最终工厂GPU对照覆盖。
- Intel UHD630/D3D11/WebGL2、DPR1、同370实体/322模型实体/17GLB与原录制，两分辨率各OFF/ON/ON/OFF 4×60秒、每段1222消息。1440p默认OFF/实验ON中位FPS5.743/2.900（实验−49.50%）；4K4.324/2.676（实验−38.12%）。本地1440p应用冷/暖83.820/84.901秒，4K冷83.276秒，未清OS文件缓存，不替代真实中台30%或完整P1基线。
- 同源姿态/三角形保持，真实VertexBuffer.updateDirectly后source绘制1/旧carrier0，非DynamicTexture区域RGBA完全相同；固定截图原容差通过。计时后分桶910候选/729桶/706单例/728种几何内容，仅23共享桶覆盖204原件，当前镜头净少约5draw，不能删几何条件追指标。
- 跨会话参数几何模板、单同步onStart<50ms、P2.3默认收益、Draw<400/Active<1000、真实中台冷暖30%和所有设备轨迹100%仍未完成/未验收；P2.3及P2总验收不勾选，P3/P4未进入。原始失败与最终日志在 output/project-optimization-p2-20261021/，未改真实中台。

- 最终收口：inventory89入口零漂移、test:entries/diff通过；16关键源码SHA与116资源/225756283bytes、原场景字节保持，任务进程无残留且未终止不相关进程。最终仅去除SceneRuntime一空白行2空格，输出JS逐字节相同，复用已完成的179回归与GPU证据（whitespace-emit-proof.json）。

## 2026-10-21 项目专项优化 P1（本地完成）

- 按 `docs/project-optimization-plan.md` 推进并勾选 P1.1–P1.3；执行及验收记录为 `docs/tasks/2026-10-21-project-optimization.md`，入场工作树 SHA 和副本在 `output/project-optimization-20261021/`，保留此前未提交改动。
- 完成同名 JS 守卫、Babylon 深层/兼容惰性 namespace、原 glTF1 和 glTF2 全扩展、Node 预转译与校验 sidecar、MQTT/重型弹窗/DXF 按需加载及 shader 合并。源码 TS 不改写，SOURCE/DIST 原字节与资源签名边界保留。
- 当前 Editor/Viewer initial JS 5,280,709 / 4,295,252 bytes，相对文档基线下降 50.1% / 55.9%；入口 3.77 / 3.70 MB，DXF 和两个 shader chunk 均 deferred。全量 JS 14.66 / 13.69 MB，首屏收益不代表安装包同比缩小。
- 最终完整构建、类型检查、`test:ci`、`analyze` 通过；P1 专项 84/84；lint 0 error、182 warning；inventory 零漂移、78 个登记入口零缺失。修复旧 SOURCE/阴影 fixture 及真实打开授权竞态，保留 19/27/16 项相关断言；普通本地自动远端同步误报另有 7 项回归。
- 最终实际 Editor 完整打开、三个 lazy 弹窗及独立 Edge Viewer 联合 PASS；Intel UHD630 / ANGLE D3D11 / WebGL2，Viewer 1440×900/DPR1，同脚本双实体仅一份 sidecar、无 renderer TypeScript/MQTT 请求、无页面错误。较早只等待脚本 marker 和两个 harness 失败记录保留，以最终 `production/result.json` 为准。
- 16 包视觉预转译/原 TS 均 12 PASS、4 FAIL，完整 Babylon 注册对照复现同四项且 22 PNG 字节相同；未改门槛。其余 19 张 LED/YZJ 时间动画差异保留，未宣称全部像素一致。四项当前运行时/阈值问题进入 P2 复核，不能称本轮引入或 Git HEAD 历史缺陷。
- P2–P4 尚待后续实施；未测工厂 FPS/冷暖打开收益或真实中台/现场 MQTT/安装包，未提交、推送或发布。10 个受保护关键文件入场 SHA 不变；旧窗口需重启加载本地主进程更新。原 `tests/buildTypeScript.test.mjs` 的 EOF 空白提示仍保留，未扩大清理。

## 2026-10-21 场景格式 v6 打开与发布兼容（完成）

- 用户反馈打开场景 67% 处报 `data-platform:prepareLocalSceneResources` / `场景模型更新格式无效。`；既有合法夹具仅改为 version 6，在真实 Electron 精确复现。
- 修复五处遗漏版本门禁；编辑器、资源授权/恢复、工程包、SOURCE/DIST 和发布准备共用 `sceneFileVersion`，只接受数字 1–6。光照打开/保存预处理新增未知版本验证，不能将 7 或字符串版本洗成 6。
- 完整类型/Editor/Viewer 构建通过；15 份生产文件 ESLint 0 错误、25 警告，只读代码审查无 P1/P2。31 项版本/本地恢复/光照资产测试、32 项发布测试通过；实际 Electron 本地资源同步 30 项检查、SOURCE 工程包 v1–6/未来版本/原文件保护回归通过。
- 统一光照入口回归 42/42 通过（含与 31 项组重叠的两项版本测试，不重复累计）；清单检查和 diff 检查通过。既有测试只按已确认迁移/来源隔离合同更新旧预期，业务字段仍严格比较。
- 实际配置本地接口后，首页打开 v6 与工具栏打开 v5 分别进入新场景会话、资源准备 100%、真实模型首帧；两次 local-latest 均携带 6、configured=true、models=1，HTTP 详情和 GLB 下载实际执行，原场景字节保持。Intel UHD 630 实际渲染，页面与控制台错误为 0。
- 计划和证据索引见 `docs/tasks/2026-10-21-scene-format-v6-compat.md`、`output/scene-open-v6/`；任务应用/本地服务已退出，保留工程及截图。主进程需用户重启旧窗口后生效，未关闭用户实例，也未对原用户场景/真实中台作验收。保留所有前序未提交修改，没有修改用户场景、上传或 Git 操作。

## 2026-10-21 统一材质与光照烘焙（完成）

- 用户确认以新材质/间接光烘焙与动静混合阴影为主，移除旧控制、主题光照接管和旧太阳阴影烘焙，保留实时照明、动作、材质与旧场景迁移/保存发布兼容。
- 最后入口复核的两处 Skybox 强度控件已改为统一值摘要和管理器入口，真实 HDR 对象/场景属性两分支及原有 UI 共 10 项复验通过，实际强度不受旧资源字段覆盖。
- 计划及十项验收见 `docs/tasks/2026-10-21-unified-lighting.md`；基线、root 主要文件副本及八个保护文件 SHA 已记录在 `output/lighting-unified/`，不覆盖前两轮未提交改动。
- 已完成唯一 `lighting v2` 与独立 `appearance v1`；旧五组字段只读迁移，新保存外层格式升 6，新版兼容读取 1–6，避免旧编辑器忽略新光照配置。首次覆盖旧文件产生原字节哈希命名备份，旧 v1 GI 明确过期待重烘焙。
- 旧太阳阴影生成/贴图应用、旧主题光照运行时、旧 Store 写入口和发布分支已删除；管理器统一场景照明与显示效果，光照/显示预设只暂存草稿。主光生命周期独立阴影，曝光等纯显示调整不使 GI 过期；昼夜能力使用显式选项并保留迁移前有效状态。
- 主任务四组回归 34+60+138+33，共 265 项通过、无失败/取消/跳过；最后 Skybox UI 修正后完整 TypeScript/Editor/Viewer 构建通过；79 文件 ESLint 0 错误、132 警告。新登记环境 6 项已包含在 33 项组内，不重复累计；代理重叠检查未另加总。
- 实际 Electron 15 项、正式独立 Edge Viewer 6 项全部通过；Cycles 实际生成 9 表面、1 图集、12 探针、4 MiB，真实本地 MQTT 升降不破坏静态 GI。实际曝光 1.35 生效且 GI 签名/shader 保持；阴影关闭时灯光保持。
- 实际 IPC 保存的迁移备份与原场景 SHA 完全相同；保存重开及全部 11 个导出 GI 资产读取、规则 shader 生效通过。五态清除/撤销恢复通过，GI 数量 9/0/9/0/9，源文件不变；页面、未恢复网络和 GPU/shader 错误为 0。
- 统一证据为 `output/lighting-unified/delivery-summary.json`、四组测试日志、`build-final-skybox.log`、`eslint-final.json`、`electron/{electron-result.json,viewer-result.json}`、`state-result.json`、`ui/electron-result.json`。77 个入口无缺失，8 个保护文件 SHA 与本轮基线一致，diff 检查通过，指南/README/inventory 已更新。
- 首次状态脚本仍检查已删除任务为 null 的历史失败已保留，按新字段不存在合同修正并重跑通过。并行旧名清理时的新环境回归已恢复到 canonical 新文件名并验证，未丢弃新行为覆盖。
- 未执行生产上传/部署、Git 提交推送、安装包、现场 Broker 或真实中台验收；本轮未重新做完整工厂 GI/FPS。测试应用/浏览器/子进程/动态端口已释放，保留测试工程、备份及实际效果截图；十项验收和完整边界见任务记录。

## 2026-10-21 集中式光照与烘焙管理器（完成）

- 用户确认按集中管理方案和三张 UI 图执行；当前场景内统一管理全局参数、复用规则、对象/部件例外和任务资源，保留前一轮全部未提交混合光照改动。
- 计划与验收清单见 `docs/tasks/2026-10-20-lighting-manager.md`；基线及动作/渲染/引擎保护文件摘要已存 `output/lighting-manager/baseline.json`。
- 完成四页签集中管理器及摘要入口，支持场景默认、资源/类型/分组规则、固定/运动/稳定部件策略、影响预览、搜索筛选、批量例外和恢复继承；旧配置保留，同资源现有/新增实例自动继承。临时生成部件只经集中规则配置，避免把例外误写到宿主。
- 草稿统一应用、一次撤销，带场景会话/文档版本及锁定保护；真实视口快照不新建 Scene，关闭释放采样，已有后台任务继续。SOURCE/DIST 按实际资源身份迁移规则，保留扩展字段，不重签已过期 GI。
- 本轮最终回归 56/56 管理器、135/135 混合光照、10/10 构建检查，合计 201 项通过；完整 TypeScript/Editor/Viewer 构建通过，39 文件 ESLint 0 错误、74 警告。修复增量产物残留 TS 导入的启动错误，真实 Node 加载和扩展回归通过。
- 最新实际 Electron 完成规则、复制继承、批量例外/撤销、草稿及键盘保护、1024/1280/1440/1586 视口、取消重试、保存重开及本地 MQTT。Cycles 实际生成 9 表面、1 图集、12 探针、4 MiB；静态阴影绘制 48→48，GI 随运动保持有效。
- 正式导出独立 Edge Viewer PASS：全部 11 个光照资产实际读取；两台无逐模型例外的同资源实例按集中规则关闭固定部件接收阴影，实际 shader 定义一致，其他资源仍开启。页面、未恢复网络、GPU/shader 错误为 0。
- 五态 UI PASS：可用→已过期→撤销可用→清除未烘焙→撤销可用，实际 GI 数量 9/0/9/0/9，源场景 SHA 不变。证据为 `output/lighting-manager/{manager-tests.log,lighting-regression.log,build-tests.log,build-final.log,eslint-final.json,state-result.json}` 与 `electron/{electron-result.json,viewer-result.json}`。
- 3 个入口与 manifest 精确一致，8 个动作/材质/阴影/引擎保护文件 SHA 与本轮基线一致，diff 空白检查通过。参考图布局与实际最终截图已复核；早期验收脚本失败记录保留，最终结果来自重新完整运行。
- 使用说明已更新 `docs/hybrid-lighting.md` 与 README；九项验收及验证边界见计划。本轮没有重新测完整工厂 GI/FPS，也未验证真实中台、现场 Broker、安装包或生产环境；未上传、发布或提交推送。任务应用/浏览器/动态端口与 bootstrap 已释放，保留报告和测试工程。

## 2026-10-20 材质烘焙与动静混合阴影（完成）

- 完成本地实现与授权范围验收；保留现有编辑器外壳及旧 baked/realtime，hybrid 显式启用。使用说明 `docs/hybrid-lighting.md`，原计划八项验收及分层证据见 `docs/tasks/2026-10-20-hybrid-lighting.md`。
- 场景“光照与烘焙”、对象“烘焙与阴影”支持实际驱动分类、稳定子节点覆盖、批量设置、分类轮廓/部件定位、进度取消、运动和前后对比。动态图形正常运动保留静态 GI；静态输入变化使结果过期，撤销及清除恢复已实机验证。
- 本机 Blender 5.2.2 CPU Cycles 实际生成独立 UV、间接光图集与探针；运行时保留直接光、源材质和反射。单大网格按世界尺度分片跨页，实际 128 px/m 夹具得到 23 片、19 图集、76 MiB，64 MiB 预算明确拒绝；不自动降密度凑预算。
- 阴影先合并静态/动态深度再过滤，方向/点/聚光覆盖四种遮挡关系。最新多渲染组 12 构型、84 状态与原生完整实时像素差为 0；正常缓存稳态不重绘静态，定制组间清深度保留正确实时回退。
- 保存/另存为、复制、撤销重做、工程迁移、SOURCE/DIST 与恢复均接入独立资产及摘要校验。取消、迟到完成、资源失配、超时和应用失败保留旧结果，不把过期输入重新签为有效。
- 实际 Electron 完成取消重试、生成应用、本地 MQTT 升降和保存重开；最新正式导出 Viewer 三态 PASS，23 个 GI 表面、43 个资产实际读取、shader/颜色与升降回落稳定。44 次初始化 ERR_ABORTED 全部恢复，未恢复网络失败、页面及 GPU 错误为 0。独立五态 UI 及两次撤销恢复 PASS，原文件未变。
- 正式工厂 A/B/B/A PASS：383 实体、3913 网格、840×567 画布、Intel UHD630 硬件 WebGL2，真实前台固定相机与同受光材质。四段平均 123.7242/117.7079/115.8829/124.3513 ms，P95 139.7/145.2/141.0/143.0 ms；两段混合静态绘制均 18→18，各命中 720 次，798 静态/2812 动态/3 CSM，缓存 192 MiB。原工厂 SHA 不变；本轮平均帧时间下降约 5.8%，P95 无一致改善，整场仍约 8–9 FPS。
- Windows GPU 进程 Shared A/B 为 3,271,839,744/3,224,662,016 bytes，Committed 为 3,586,396,160/3,689,488,384 bytes，包含进程全部资源，不能当作单场景 VRAM。工厂对照关闭 GI、隔离远程业务网络，仅放行固定版本 Draco 技术依赖，不证明完整工厂 GI 或生产服务联调。
- 最终 `npm run test:lighting-bake`：23 文件、135/135、无失败/取消/跳过、退出码 0；96 个相关文件 ESLint 0 错误、91 警告；完整 TypeScript/Editor/Viewer 构建与真实 Cycles 集成通过。新测试入口与 manifest 精确一致；既有 test:manual-roam 命令漂移未扩大修复范围。
- 最新证据为 `output/lighting-bake/{unit-delivery.log,eslint-delivery.json,build-final.log,cycles-final.log}`、`reopen/viewer-result.json`、`state-result.json` 和 `factory-only/factory-performance.json`。原 main/reopen 总报告的历史 FAIL 保留，引用已完成子阶段及独立最终报告，不改写历史。
- 未执行真实中台上传、生产发布、安装包/现场环境验收或 Git 提交推送。测试应用、浏览器、回放和动态端口服务已关闭；保留用于复核的报告和临时工程。以下同主题追加小节是实施阶段历史，最终状态以本节与最终验收记录为准。
- 收尾删除本次生成的 `electron/lighting-bake/__pycache__/cycles_bake.cpython-313.pyc` 被自动审批拒绝，理由仅为 `blocked by policy`；未改用其他删除方式，该未跟踪缓存文件保留。只读核对确认无本次 Electron/浏览器进程及根目录 smoke bootstrap 残留。

## 2026-10-20 提升机运动箭头 Git 交付

- 已快进合并远端货格留存货物开关、直角接驳中心线落点相关更新，恢复本地提升机运动箭头改动，无冲突。
- 本次按用户要求不运行测试、构建或代码验证；原实现阶段记录不代表对合并后版本重新验证。
- 使用中文标题及四项编号说明提交推送，最终结果以本次交付回复为准。

## 2026-10-20 Git 同步交付

- 已拉取并快进合并远端设备驱动更新，保留本地 Overlay 与巡检辅助标记优化，无合并冲突。
- 本次按用户要求不运行测试、构建或代码验证；下方原实现阶段的验证记录不代表对合并后版本重新验证。
- 使用中文标题和四项编号说明提交推送，最终结果以本次交付回复为准。

## 2026-10-19 按性能指南检测与外围优化

- 需求：按照 `babylon-perf-guide.md` 检测优化，保证参数化脚本和动作逻辑不变。用户选择复用现有大场景。
- 范围：仅优化 `DataPlatformScreenOverlay` 的同帧投影/临时对象/DOM 样式，以及 `EditorAutoPatrolRuntime` 的编辑辅助标记缩放和矩阵失效检查；不改画质、资源、消息顺序或动作频率。
- 计划与完整章节核对：`docs/tasks/2026-10-19-babylon-perf-guide.md`、`docs/babylon-perf-guide-audit.md`。
- 已验证：前后完整构建成功；新增定向测试 7/7；Electron 硬件 WebGL 正反向检查；36 屏生产 WebGL A/B/B/A，三视角截图全部一致，点击/尺寸/隐藏恢复/卸载通过；36 个受保护文件 SHA-256 全部一致。
- 已测收益：120 屏投影 DOMRect 240→2、稳定样式写 720→0；501 个巡检编辑标记静止 300 帧的缩放写入与世界矩阵更新 150300→0。36 屏相机移动时 Overlay 平均耗时 3.917→1.787 ms，两版约 60 FPS。
- 限制：旧 Vite SSR 入口部分导入超时，未完成断言不算通过。工厂首次优化版采样与 ESLint 重叠，已作废该轮性能数据并单独重采；完整加载和 iframe 功能检查成功。
- 最终回归：遮挡与跨域点击 12 项、透明标牌 9 项、巡检编辑真实操作 7 项均通过且无页面错误。巡检覆盖新增/覆盖、不同高度、聚焦和保存重开相机恢复。
- 工厂有效对照：相同场景/资源/视角/回放，1440×900、DPR 1、Intel UHD 630；单轮 15 秒静止 21.27→21.79 FPS，动作 18.42→18.74 FPS，后者均接收 290 条回放消息。P95 分别 57.2→54.2 ms、66.9→67.3 ms；单轮结果不支持稳定整场 FPS 提升或达到30/60 FPS的承诺。
- 当前状态：本轮检测、两项外围优化与针对性验收完成；全部记录见 `docs/babylon-perf-guide-audit.md`，证据保存在 `output/playwright/perf-guide-20261019/`。已释放本任务应用、浏览器和本机回放服务；未安装、发布、提交或推送。

## 2026-10-19 场景模型面数统计

- 目标：按已确认示意图，在场景属性“场景”分组的名称后加入模型总面数与可展开明细。
- 范围：普通/内置/组合模型、完整逻辑实例、环境、实际生成货箱；包含隐藏实体，排除编辑辅助、天空盒与线点；不随相机裁剪变化。
- 实施：运行时按业务登记计算并缓存有效几何，非持久化快照传递到面板；明确 loading/error，避免部分结果冒充总数。
- 验收清单：
  - [x] 12 面立方体、10 个立方体 120 面及阵列/变体计数正确，无宿主重算。
  - [x] 隐藏实体/父组、移动相机/裁剪后总数稳定；参数/环境/货箱/删除撤销自动更新。
  - [x] 三角形拓扑与线点/辅助排除正确；加载/错误/切换场景无误导性旧值。
  - [x] 按示意图实现总数与明细，实际浏览器操作验证、窄面板无溢出。
  - [x] 统计不影响 dirty/undo/序列化；定向测试、类型检查与相关文档完成。
- 当前状态：原实现阶段验收记录见下；2026-10-19 已合并远端更新，进入 Git 提交推送流程。本次交付按用户要求不运行测试、构建或代码验证；推送结果以本次交付回复为准。

### 修改与验证

- 面板：新增 SceneModelStatisticsPanel 与样式，在场景名称后挂载；说明与明细支持键盘，整数支持选择复制，加载/失败不展示部分总数。
- 数据：EditorStore 增加非持久化快照，SceneViewPanel按运行时与场景会话校验写回，同ID重开也主动发布首份结果。
- 计数：新增三角拓扑助手，SceneRuntime按逻辑实例、参数变体、生成物、Fetch实际货物和环境汇总；事件驱动缓存/微任务合并，不注册逐帧计数。环境与Fetch统一口径；特效代理使用源Mesh唯一ID避免重名误配。
- 文档：README说明入口与口径；docs/lessons.md记录全量与裁剪、同ID新会话快照两项经验。
- 新增回归：UI 4、状态 3、几何/环境 7、Fetch 6、核心运行时 11，共31项通过；相关既有加载就绪9、模型特效21、Fetch7项通过。
- 主线程组合命令：node --experimental-strip-types --test --test-concurrency=1 tests/runtime/modelTriangleStatistics.test.ts tests/runtime/locatorFetchTriangleStatistics.test.ts tests/editor/sceneModelStatisticsState.test.ts tests/editor/sceneModelStatisticsPanel.test.mjs tests/runtime/sceneModelReadinessError.test.ts（29/29通过）；核心运行时最终11/11由并行实现代理执行后冻结代码。
- 最终 npm run typecheck 通过；相关生产文件 ESLint 0错误、45条警告，与HEAD基线四个既有大文件警告数一致，新增文件无警告；git diff --check 通过。Impeccable新UI检测返回[]。
- 真实浏览器：Edge硬件WebGL2，Intel UHD630/ANGLE，现有真实SceneViewPanel/SceneSettingsPanel fixture，19项检查，pageErrors=[]。验证48/120立方体、隐藏与相机不变、删除撤销、合法本地场景文件阵列10+环境1=11、同ID/空场景重开、缺失模型失败与删除恢复、异步加载占位与完成更新、100立方体+环境1=1201、精确数字选择、键盘说明与明细、320px外侧面板无横向溢出。
- 证据：output/playwright/scene-model-statistics/result.json、implemented-panel.png、implemented-scene.png、narrow-320.png；模型字节为已知单三角面glTF，通过测试本地资源路由供真实加载器读取。
- 验证边界：本地源码、真实浏览器WebGL与NullEngine回归；未重打安装包，未验证已安装版本或现场远程资源。无本轮必要功能遗留。

## 2026-10-20 提升机与换层提升机运动箭头

- 需求：编辑器运行和发布场景沿用现有运动箭头逻辑。验收清单见 docs/tasks/2026-10-20-lift-motion-arrows.md，六项均完成。
- 配置与交互：lift 三路（升降/前工位/后工位）、hclift 单路升降；十样式及拖放、颜色/动画/挂点/独立编辑预览，统一 telemetryBinding.liftMotionArrows 保存、复制、撤销重做和 SOURCE/DIST 序列化。缺省关闭、显式零值保留、预览仅当前会话。
- 运行：驱动后发布 WeakMap 同帧实际位移；工位沿已有真实输送轴，排除首帧/初层吸附/补齐/约束纠偏。升降固定柱全高度并动态避让载货台，工位跟随台面；共享台面沿安全交段分半，斜向宽度和自动长度留在台面范围内。正常停机120ms淡出，故障/work_state=10/过期/冲突/缺帧/隐藏即时关闭，删除和切换释放。
- 复核修复：摘要不得主动调用有副作用的业务轴解析器，改为仅读已建立缓存并覆盖层模型晚就绪；急停增加独立门控；补斜向台面四角/侧面回归。未改参数化脚本或原有 MQTT/动作规则。
- 定向回归：配置/会话/编辑store 15/15；原及新驱动/摘要先33/33，旁路修复后受影响lift+摘要27/27（hclift7项证据仍有效），最终驱动合计34项；Renderer12/12；System6/6。合计67项有效回归，testGroups机制另5/5。npm run build（含TypeScript、编辑器与Viewer）、npm run build:electron通过；修改源文件ESLint 0错误，既有SceneRuntime29、liftDriver2条警告；git diff --check和新增文件UTF-8检查通过。
- 真实编辑器：Microsoft Edge/Intel UHD630/ANGLE硬件WebGL2，四通道正反预览/动画/停止、保存重开、窄视口、两类MQTT上下行、立柱固定与动态缺口、急停断流通过；MQTT task101/102由真实conveyor依次生成两箱并取入后/前工位，两路箭头direction1且实物ID独立，停预览货物清理通过，errors=[]。
- 发布：实际Electron SOURCE/DIST各4场景（main/legacy/disabled/zero）保留配置、两模型与脚本、重开、源文件不变；最终源码build后重新解包的DIST Viewer验证两类升降、动画、故障/急停/断流、前后工位真实MQTT取货及旧/关/零值场景，errors=[]，硬件WebGL2。
- 证据：output/lift-motion-arrows/{editor-result,packages-result,viewer-result}.json、build.log、eslint.json，mqtt-up-gap-moved.png、mqtt-front-pickup.png、viewer-up.png、viewer-front-pickup.png。使用说明 docs/lift-motion-arrows.md，README已加入入口。
- 既有问题与边界：test:entries因HEAD原有test:manual-roam入口与scripts/test-entry-manifest.json漂移失败，当前命令与HEAD一致，未扩大修复。现场Broker/实际业务模型包/已安装版本/线上部署未验收；未提交推送Git。本轮必要功能无遗留，任务浏览器与动态端口服务均已关闭。

### 2026-10-20 混合光照取消重试回归

- 取消等待渲染就绪或后台结果时立即释放当前调用；后台保留进程清理占用，重试预约等待清理完成，预约也受所有权、取消及窗口生命期约束。
- 聚焦回归 9/9 通过，含错误所有者拒绝、取消后立即重试、取消等待中的重试、窗口关闭与迟到结果。真实 Electron 操作验证仍在执行，完整验收尚未完成。

### 2026-10-20 混合光照实机闭环与追加缺陷验证

- Intel UHD 630 硬件 WebGL 的真实 Electron 中，完成 UI 取消/立即重试、Cycles 生成应用、本地 MQTT 升降、静态阴影缓存保持、保存重开。证据位于 output/lighting-bake/electron-result.json；该轮尚未包含后续签名与材质修正，不作为最终版本全部验收。
- 实际序列化回归证实 undefined 属性会导致保存后 GI 误过期，已按 JSON 语义修正摘要；6 项合同回归通过。两处折叠区和子部件继承/覆盖 UI 已补齐，真实操作验收待最新 smoke。
- 实机发现立柱 GI 采样为零及 Hemi 高光丢失，正在修复；应用最后阶段取消的 GPU 回滚风险也正在加入事务测试。当前不宣称完成。

### 2026-10-20 跨页与实例标记验收修正

- 22文件聚合已完成：123/123通过、无取消/跳过，完整日志output/lighting-bake/unit-final.log。随后新增实例绘制隔离修复仍需按影响复验，不能只引用先前聚合代表最后版本。
- 单大表面切分已保面积和原属性；独立审查进一步发现原面积估算会降低真实texels/m，继续改为按真实UV度量与世界尺度分配，超页继续切分。600m²真实平面最低密度已达到配置16px/m。
- 七表面高密度夹具按实际128px/m需要19页、76MiB，原64MiB明确失败；最终实机夹具预算改128MiB，保留64MiB拒绝用例，不降低纹理密度。此前9页结果不是有效密度证据。
- Viewer预检已通过真实导出、资产摘要、独立硬件WebGL及MQTT升降/回落；初始化过时请求被取消但同URL成功读取，报告保留原取消记录并独立拒绝未恢复失败。最终跨页Viewer验收尚在执行。
- 未烘焙时原生实例/逻辑阵列接收标记被聚合或原生getter忽略，已实机复现；正在按需隔离绘制，保持统一族批处理，并验证首次GI切换与取消恢复。

## 2026-10-22 GLB 标准预览与默认环境照明

- 已确认范围：普通/环境模型共用“GLB 标准预览”，新场景默认增加内置离线 IBL，旧场景配置保留；实际 GLB 保存重开与 SOURCE/DIST 本地发布。清单见 `docs/tasks/2026-10-22-glb-standard-preview.md`。
- 实施：增加可选环境来源/旋转，预设同时暂存照明与外观并统一撤销；离线资源及许可随 Editor/Viewer 打包；签名与捕获区分照明源和天空背景。新建保留基础对象所需的原主光/补光，显式预设才建立纯 IBL 基线。
- 实机修复：离场实例源漏收全场景标脏及旧灯光释放，冻结环境还会跳过 ready 检查；现在按实际源去重，恢复原生检查状态并保留编译资源。小型真实 GPU 的像素、冻结与资源复用验证通过。
- 崩溃修复：共享TypedArray快照避免按Geometry重复分配；堆采样进一步确认约3.48GB由Babylon静态clone保留的Vector3位置数组造成，现逐clone及时释放，源/几何/材质/包围盒及形变模型不变。实际预设草稿阶段主堆约3.67GB→260MB，旧崩溃的应用/撤销/再次应用闭环通过。
- 最终验收：两入口保存重开、正式SOURCE解压重开、正式DIST及独立硬件WebGL2离线Viewer均通过；各2673网格/226材质完整，四阶段画面各自一致。跨入口相对模型中心的相机、材质、像素通过，亮度差0.006503、直方图L1为0.000449。
- 验证：定向105项通过（32预设/运行时、42统一光照、28身份缓存、3原环境缓存）；GPU像素和资源复用通过，最终完整构建成功、相关lint 0错误，2条测试prefer-const警告保留；测试清单0未分类。最终报告 `output/glb-standard-preview/1792655462707-d3cf6608/result.json`、汇总 `final-acceptance.json`，证据来源链及原失败均保留。
- 边界：工作区目录rename出现EPERM后，最终在独立本地目录正式导出，交付副本各279文件逐个SHA核对后离线验收；发布器文件锁处理未修改。首次环境冷应用约111秒、再次约11秒，未优化该摘要计算或承诺FPS；现有性能计数警告未扩大修复。未重打安装包或验证已安装/线上版本。
- 原始 GLB 不改写；不提交、不推送、不上线。本轮必要功能无遗留，任务应用/浏览器及服务已释放，产物与诊断记录保留在 `output/glb-standard-preview/`。

## 2026-10-23 发布场景返回开场动画

- 已确认：右上角低存在感回转图标（12px / 1px线宽 / .28透明度 / 28px透明热区），悬停或聚焦提亮并提示；点击从头重播，结束自动进入持续运行的场景。
- 验收清单：[x] 可反复返回且防快速重复启动；[x] 首次模型入场与重播收尾分开；[x] 已挂载面板仅视觉隐藏；[x] 内嵌每轮重新确认可见；[x] 实际DIST两轮循环与异常/禁用场景；[x] 桌面/窄视口实际样式与键盘；[x] 构建、审查和文档最终核验。
- 实施：PlayerApp 为每轮创建独立开场协调器并隔离迟到回调，保留三维运行时和订阅；GeographicOpeningBridge 清除上轮可见状态；新增独立 OpeningReplayButton。
- 自动回归：新增宿主重复播放测试先失败（旧可见缓存被误用）后通过；桥接/协调器/可见性25项、包配置/环境快照等13项共38项通过。typecheck、build:viewer、build:electron通过；功能源码和新smoke脚本ESLint通过，diff检查通过；测试分类和清单补登记后检查通过，0未分类。
- 发布与实机：实际Electron SOURCE/DIST普通两包及棱光环境包通过；Chrome155/Intel UHD630硬件WebGL2验证三类开场各三轮（两轮跳过、一次completed，campus从零完整自然播放，其他寻帧至末尾），双触发仅一实例，场景/相机实例及帧持续、静止相机不重置、无额外scene/GLB读取；1600×900及390×844入口尺寸/透明度、悬停/键盘提示、Enter播放和还焦通过。内嵌同session两轮隐藏等待/暂停/恢复及completed/skipped通过，真实宿主命令打开的自动巡检面板保留DOM与折叠状态。无开场正常就绪且无入口；既有smoke的素材404退出与业务恢复通过。
- 验收修正：旧发布夹具因新默认烘焙未生成被正确拦截，仅将两处开场夹具明确设为不启用烘焙，未改产品校验。巡检自动在third-person/orbit切换，半径5.4626→15属于既有业务行为，已按控制器独立依据修正测试固定距离假设；参考包窄屏按既有CSS隐藏文字跳过入口，测试沿用Esc。两次原始失败报告/日志保留。
- 证据：output/playwright/opening-replay/result-all-renderers.json（三类型完整矩阵）、result.json（追加业务面板与内嵌）、smoke.log、smoke-panel.log、packages*.log、typecheck.log、build-viewer.log、existing-failure-visibility.log及常态/悬停/键盘/窄屏PNG。源码见PlayerApp、OpeningReplayButton与GeographicOpeningBridge，使用说明见docs/opening-packages.md。
- 既有诊断：两份导出夹具原有no-unsafe-finally lint报错与清理逻辑保留；构建有既有大chunk提示，本地夹具出现发布缓存partial控制台提示；正常重播未捕获异常0、console.error0、开场警告0、资源关闭错误0。该边界不等于全部既有lint已通过。
- 边界：仅本地实际发布包和本地宿主/API夹具，未验证线上大屏、现场MQTT或已安装版；需使用新Viewer重新发布后生效。保留工作区其他改动，不提交、不推送、不上线；本任务浏览器、导出进程和临时HTTP服务已关闭，必要功能无遗留。


## 2026-10-23 阵列净间距支持负数

- 需求与验收：右键菜单及 Shift 拖轴的共用弹框允许有限负净间距；普通对象与组合模型的请求、预览和提交保留符号；沿用“跨度 + 净间距”的步长，覆盖正、零和反向步长，保存重开和撤销重做保留坐标。
- 实施：解除输入最小值、共用参数校验、请求净间距清洗、普通/组合预览及矩阵批次的非负限制；保留数量、有限数和提交溢出校验。更新 README 与组合模型说明。
- 回归：修改前已复现界面拒绝、请求改为 0、预览负数钳制三个失败；修复后 model-array 20/20、弹框 1/1、普通/组合请求到保存及历史回归已通过。运行时矩阵、实际浏览器和 typecheck 仍在执行，最终结果补记于本条。
- 边界：保留原工作区的光照与性能改动；不提交、不推送、不发布。

### 阵列负净间距验收补记

- [x] 普通/组合弹框允许负有限数，NaN 与正负 Infinity 仍被共享校验拒绝，副本数量范围仍为 1–1000。
- [x] 正、零、反向步长的请求/提交/序列化/历史链路通过；NullEngine 预览 6/6 通过，含普通克隆与组合 thinInstance。
- [x] 首轮实际 Chrome 浏览器 15 项检查通过、pageErrors=[]：六方向原正间距、正反 X 负间距、普通立方体/导入输送机/组合保存重开、撤销重做、取消清理、真实鼠标 Shift 拖轴后负间距预览与确认。证据 output/playwright/composition-array/result.json、shift-negative-spacing-preview.png。夹具旧 shadows 字段导致的原始启动失败保留在同目录 failure.json。
- [x] 代码审查无阻断项；生产文件及新增断言 UTF-8 检查通过。针对性 ESLint 的夹具就绪断言已改为安全的空值默认写法，最终复验正在执行；原有 any 和 prefer-const 警告不扩大修改。
- [ ] 全量 npm run typecheck：被本任务开始前已有的光照改动阻断，src/runtime/babylon/lightingRuntimeCapture.ts:2 的 VertexBuffer 未使用（TS6133）。该文件不属于本任务，未修改。未运行完整 build，不把构建描述为通过。

- 最终复验：修正夹具就绪检查后，真实 Chrome 浏览器 15 项再次全部通过、errors=[]，截图已人工检查负数 -0.5 与可用确认按钮；针对性 ESLint 退出 0（0 错误、2 条既有警告），git diff --check 通过。本任务源码和验收记录完成；全量类型检查仍以上述无关光照文件 TS6133 为限制，未构建安装包或验证已安装版本。浏览器和临时动态端口服务均由脚本正常关闭。

## 2026-10-23 发布光照 UV 错误与交付脚本同步

- 用户报告 `lighting-bake:start` / `Object-10 有正面积三角面未获得有效光照 UV`。真实 Blender 5.2.2 使用旧 dist-electron 脚本与四面夹具复现相同错误；入场源码已包含共线面浮点误判与正面积细面 UV 塌缩修复，但交付副本未更新。本次保留并复用已有算法，重新构建 Electron，最终源码/交付脚本 SHA256 一致。
- 常规 Cycles 集成入口新增对实际交付 Python 的共线/细面回归；旧副本 RED，更新后 GREEN，全部 4/4、31/31 面与源属性保留，最低实际密度均不低于目标 4 px/m，破坏真实正面积面 UV 仍被拒绝。取消断言基于独立原生 fs.readFile 复现兼容 AbortError/ABORT_ERR，保留正式资产不变检查；未扩大生产取消改动。
- 验证：真实 Cycles 集成（生成、取消、超时、预算、逐面图集与跨页密度）退出 0；定向 21 项通过；build:electron、typecheck、定向 ESLint、Node/Python 语法、测试入口清单、diff 检查及独立审查通过。证据 `output/lighting-uv-publish-fix/`；清单 `docs/tasks/2026-10-23-publish-lightmap-uv.md`。
- 同期已有完整工厂 UV 扫描最终通过，821 输入 / 870875 原始三角面完成展开与打包（42 图集、4 px/m）；仅作 UV 阶段补充证据，不宣称完整工厂烘焙、Viewer 或发布验收。
- 边界：未找到用户此次 Object-10 的原任务输入，未对原业务场景实际发布；未操作用户原工程、未重打安装包、未提交推送或上线。开发产物已同步，已安装版需更新包含修复的安装包。保留全部其他未提交改动；本轮任务子进程已自然退出，无后台遗留。

## 2026-10-23 本机 Blender 烘焙引擎配置

- 已确认 UI 方案：管理器“总览与烘焙 → 烘焙参数”提供配置入口，部署导出与数据中台发布提供同一配置窗口；仅当前系统用户、所有工程共用，不进入场景或发布包。清单见 `docs/tasks/2026-10-23-lighting-engine-configuration.md`。
- 实施：新增指定路径精确检测、原生文件选择、版本/设备刷新、配置来源显示、原子保存/移除手动路径；保留未知字段、拒绝覆盖损坏 JSON 与检测期间的外部修改；保存与烘焙全生命周期互斥。保存后保留发布表单，原有发布校验继续执行。
- 当前验证：新配置/窗口/发布检查聚焦 22/22 通过；相关 backend/preflight 27/27 通过；完整 typecheck、最终 build:electron、Editor 与 Viewer 构建、17 文件定向 ESLint 均退出 0；构建保留既有大 chunk 提示。配置模块行覆盖率 100%、分支 89.36%，引擎子进程异常/超时以夹具验证；真实 Electron/Blender/本地发布验收正在执行，结果后续补记。
- 边界：测试使用隔离 userData 和临时工程，未修改用户真实 AppData 或原业务场景，未远端发布、未打安装包、未提交推送；既有脏改动保留。

### 本机引擎配置最终验收

- 真实Electron/Blender 5.2.2 CPU最终PASS：本机配置选择/精确检测/安全保存、错误保留、重开及整个进程重启读回、恢复自动查找全部通过。原生dialog高度已从auto修为fit-content，桌面紧凑与390px无溢出实际通过。
- 两个真实发布窗口的配置入口均实际操作：Esc及保存保留部署工程名/ZIP、中台发布名称/备注/Origin；无项目绑定的中台确认发布禁用，未向真实中台提交。
- 实际Cycles7表面/12探针、正式保存、UI本地DIST导出296文件完成；独立Edge硬件WebGL2 Viewer读取全部9份光照资产及摘要、MQTT升降/回落、静态GI稳定通过。Viewer无未恢复网络/GPU/shader或页面错误；编辑端8条通用ERR_FILE_NOT_FOUND记录保留，未进一步归因。
- 最终报告 `output/lighting-engine-configuration/1792742592897-0b434bf7/result.json`，Viewer报告及截图位于其 `viewer-1792742718962-50260825/`。本次8个Electron PID和两个服务端口均已退出，bootstrap移除、cleanupErrors为空。
- 原始失败保留：首轮Windows子进程环境隔离未成立；第二轮仓库output目录最后rename出现EPERM。最终UI导出改用本次专属临时目录，未改发布器，后续独立Viewer正式导出也通过。全量清单生成仍被既有旧smoke分类摘要漂移阻断；本次新增npm入口与manifest一致，未替其他任务更新摘要。已安装版本仍需新安装包，未重打包或更新安装版。

## 2026-10-23 场景帧开销第二轮 P0/P1

- 用户选择完整本地工厂对照，等待的后台Cycles已错误退出；未结束其他任务进程。P0固定近/远景共4轮完成时用户要求3次足够，立即取消后续及独立CPU profile；已完成证据保留，后续P1最多3轮。近景FPS中位5.9417/P95帧间隔500ms，远景5.775/502.4ms；每轮原录制60秒1151消息无缺口。工厂Intel UHD630不代表RTX5060展会。
- P1新增默认OFF生命周期旁路及单collect角色Set复用；分类48来源144→3份集合、完整结果一致，最终34项回归通过。OFF首轮106+7回归通过，独立审查发现批次回调同步关闭的重入边界，正在补回归修复；此时未声明全部完成。
- 原构建/源冻结保留，candidate仅从baseline复制，尚待最终三文件overlay/构建/硬件画面及最多3轮对照。test:entries通过；既有测试目录项数301硬断言在冻结基线330和当前337均失效，保留失败，不扩大改动。详见docs/tasks/2026-10-23-frame-cost-p1.md和output/frame-cost-p1-20261023。

### 场景帧开销第二轮最终交付

- 用户要求继续研究后，已撤回无净收益的角色Set缓存，最终保留OFF完全旁路、分类纯URI编码值复用及policy默认模板复用。公平四版本8组微基准完整结果/回调一致，组合在384来源用例中位耗时下降约4%–21%，仅代表分类子流程。
- 最终200项定向回归通过，候选及当前工作区TypeScript/Editor/Viewer完整构建通过；新测试入口登记、范围lint/diff通过。最终硬件六姿态RGBA零差异，阴影/运动/分类/脚本配置getter次数一致。
- 遵从3轮上限：P1首回退候选、CPU诊断、最终验证，未追加。最终近景5.8167FPS对P0两轮中位5.9417FPS，P95 500→477.9ms，P99 739.5→772.2ms，长任务累计58076→54016ms；无稳定FPS提升证据，卡顿未彻底解决。原60s1151条MQTT发布/交付/回调完整，未降频。
- 不推进本轮矩阵P2；诊断优先指向光照目录刷新/分类。原Set候选/共享Geometry无效基准/夹具失败保留，原测试目录301硬断言漂移不扩大修复。报告docs/tasks/2026-10-23-frame-cost-p1-result.md；仅本地工厂Intel UHD630，非RTX5060展会/现场/已安装Viewer验收。未提交推送或发布。

## 2026-10-23 光照失效原因与安全合并

- 按授权完成默认OFF原因诊断、pose/bindings/classification/structure/unknown消费合同、受控Mesh事件已pending标记合并、分类/绑定重入与异步snapshot保护。未知脚本与refreshModelMeshes继续full；原生增删广播、脚本/遥测/UI定时周期保持。撤出零实际覆盖率的纯度守卫实验并保留证据。
- 验证：135项定向回归通过、独立审查无阻塞、独立候选完整build通过、6姿态真实WebGL像素差0；同条件工厂A/B/A严格3次均通过，FPS5.47/5.73/6.12。候选合并4047次重复标记，但真实getSources95次，未确认稳定FPS收益，主要约450ms分类卡顿未解决，不推进P2。
- 记录与边界见[结果报告](tasks/2026-10-23-lighting-invalidation-result.md)；冻结源码/构建、失败实验、原始回放和审计保留于output/lighting-invalidation-20261023。测试app/broker均关闭，未提交推送或发布，保留全部既有并发改动。

## 2026-10-24 全项目渲染光照烘焙加载优化 Q0 首批

- 按方案阶段推进，保留L1按需UI分类、B1 NumPy像素处理、B2探针1024²批次、LD8四并发/Bitmap加载、S1阴影数值签名。画质、外置脚本、设备算法及MQTT频率未改；未提交推送发布或生成安装包。
- L2候选因原始positions/indices写入和祖先nodeKey变化没有可靠事件的反例撤回，原full失效保持；新增相关GI回归及lessons。Q0未完整通过，不进入Q1，B2 GPU自适应/缩批仍是缺口。
- 最终相关回归215+78+80+42项全通过，P2 201通过/1可选基准skip（另已测量）；类型/build/lint/入口、真实Cycles交付/取消超时、硬件阴影/材质/Bitmap context restore及60秒真实UI通过。完整CI的2项Viewer旧失败在初始HEAD独立复现，未扩大修复。
- 工厂固定60秒ABBA四轮有效：A均5.6917FPS、B均6.25（+9.81%），P95 -5.52%、P99 -33.54%、分类累计31.836→28.594秒；UI collect34.5→0，unknown刷新四轮均66。长任务累计仅-1.51%，主要卡顿未解决。仅本地工厂Intel UHD630，不代表展会独显、现场或线上Viewer。
- 详细清单、输入/产物SHA、原始证据、五项子流程收益与下一步见[实施记录](tasks/2026-10-24-render-optimization.md)及output/render-optimization-20261024。所有本任务app/broker/浏览器/Blender进程已结束，诊断记录保留。

## 2026-10-24 Q0续作：B2 GPU本地完成，L2仍在验收

- B2补齐实际GPU设备显存匹配/保守计划、确认OOM后1024→512→256→128图像与容量缩批；最低失败才发旧CPU回退标记，非OOM设备故障保留旧回退，其他错误原样失败。灯光和临时数据块finally恢复；失败当前批次不覆盖正式探针。默认设备/采样/脚本/MQTT不变。
- 最终源/交付Python SHA2810faf1...a51一致；11条真实Blender数据块故障注入及旧marker合同、CPU图集4,194,304分量差0/探针73,728值差0，统一Cycles入口exit0；用户确认暂时没有独显，先完成本地实现与回归，硬件恢复与显存峰值未验证。文档docs/hybrid-lighting.md同步。
- L2不可靠净成员跳过继续保留原full；同pass memo两次负收益已撤出。只改条目构造的新候选微测虽正，实际42856行完整collector反而274.2→298.2ms，已拒绝收益结论；正在验证最后更小变体，不提前激活Q1。详见原实施记录及output/render-optimization-l2-20261024。

- 续作最终L2裁决：两次完整collector诊断分别+8.75%/+7.20%（行为差分相同），按方案停止并彻底撤回物化/内部诊断/入口，保留原full；不运行未达标候选的visual/ABBA，不进入Q1。回退后TypeScript/Editor/Viewer构建、lint及入口检查通过，完整光照烘焙回归215/215、0失败/取消/跳过；B2最终统一Cycles入口通过。B2是本轮唯一新增产品功能，其他首批五项保留；回退与1010文件输入审计见delivered-integrity.json。

## 2026-10-24 用户确认L2安全替代口径后的续作

- 用户明确同意full分类次数可不变，以实际分类耗时下降且行为一致验收；Q0其余满足后才进Q1。两轮旧物化候选继续撤回，真实GPU按前次答复暂缓。
- 独立非压缩行级CPU诊断完成，仅定位不作FPS比较；policyContext固定字段构建占create self ticks35.49%，非整个collector比例。Matrix descriptor-only因全局seed/tracking副作用否决。
- 新实验只展开policyContext可选owner字段为两个固定literal，保留所有读取/失效/结果行为；先实际collector语义差分与错误变体RED，再真实完整收集计时。尚未达到Q0门槛，不提前进Q1。记录在原实施记录及output/render-optimization-l2-approved-20261024。


- 2026-10-24 渲染优化Q0本地验收：用户批准L2完整检查安全替代。新policyContext ABBA累计分类-10.63%、per-call-14.10%、FPS+10.19%，完整分类次数+4.02%、P50+2.30%及长任务仅-0.67%如实保留。硬件六姿态零像素差异、源对齐MQTT1151完整；独立审计112项通过；build/lint/entries、lighting-bake224、manager78、unified42通过，optimization79+1skip另补真实PNG分支5通过。B2同SHA统一Cycles/11注入有效。真实GPU按用户答复暂缓、2项旧Viewer CI失败单列。进入Q1逐项核对，L4仍须30分钟影子零差异；证据见output/render-optimization-l2-approved-20261024/verification.json及docs/tasks/2026-10-24-render-optimization.md。

- 2026-10-24 全项目优化Q1组合：B3遵用户选择仅新场景auto；B7冻结独立审查通过，最终DIST/Viewer正在收束。LD1 36unit、真实三Worker/像素、正式ABBA2和原发布缓存smoke组合6通过（阻塞下降，ready约慢2ms）；LD7补BIN侧车16unit+20HTTP检查通过，原清单/SHA/预算保持。完整build3通过，但LD5新callback准入修复仍需重构建/最终集成。L3/L4/L5/L6/L9冲突路线未降级验收，Q1未全完成，详见本任务记录。

- 2026-10-24 用户确认Q1严格等价收束：L3/L4/L5/L6/L9保留原实现与证据，完成其余条目；B7最终混合实际ZIP/Viewer通过，另最小修复HEAD已有快速缓存启动竞态待统一新build复验。R1本机T0+缓存+manager真UI通过独立审查；LD5净收益与LD6候选仍待验收。

### 2026-10-24 Q1严格等价与build5组合冻结

- 用户批准L3/L4/L5/L6/L9冲突路线保留原实现；L8真实SDK公开API反例也按严格等价优先保留，原文方案不修改。
- 实际业务托盘LD5零命中由原生wrapper copied metadata被保守guard拒绝；未清空metadata或放松检查。Controller补默认off并新增真实两轮原生生命周期回归。LD6也保持defaultoff，33项局部修复通过但完整变体/收益尚未验。
- build4/build5 full均exit0，最终源/交付Python SHA a6b9cc8a…相同。root独立审查记录8输入与默认off边界；统一Node、Cycles、新ZIP/Viewer正在最终功能验收，不作并行性能结论。Q1尚非全项完成，Q2未进入；无提交推送外部发布。

### 2026-10-24 Q1最终Node与新DIST Viewer

- build5组合新ZIP/Viewer通过：2BIN+1JSON、3GI实际shader、拾取、br/gzip/SHA及启动旧错误清除，代表PNG已实际打开。复用真实bake但重新打ZIP；无新bake/旧ZIP冒充/生产发布。
- 九条最终命令exit0；570项569pass+1optional skip，entries106/0missing；受影响ESLint修三处smoke browser global后exit0。真实Cycles与真实PNG分支正在收尾。
- LD5旧引用构成严格语义反例；LD6仅模板effect覆盖成立，receiver/GI/probe/alarm及净收益缺口明确。两候选保持defaultoff，已就新边界请求用户选择。Q2未进入。

### 2026-10-24 用户批准LD5/LD6保留原路径

两个候选继续defaultoff，不计入验收收益；其余Q1按本地实现/回归交付，原现场/组合GPU性能边界保留，不进入Q2。实际Cycles旧UV展开布局断言已按B6逐角点IEEE64合同修正并定向通过，未改变产品或容差；完整实际Cycles及真实PNG补跑收尾。

### 2026-10-24 本地最终交付完成

按用户调整范围交付：build5/受影响lint/入口审计/570项定向回归及真实Cycles通过；真实PNG分支补跑5/5，旧失败保留。最终Viewer冻结输入全部重核一致，专属资源清理由各实际runner记录。详见总任务最终检查点及output/render-optimization-q1-20261024/final-delivery.json；候选off、硬件/现场边界及Q2门槛保留。

最终补核lighting-unified42/42通过，已同步各子任务真实完成清单；不重复运行已通过组，不对未完成或用户批准保留项假勾通过。

最后统计更新：补入最终lighting-unified42/42后，共10条定向命令全部exit0，TAP612项=611pass+1标准真实PNG分支skip；该分支已用本轮新Cycles产物5/5补齐。此为各命令TAP计数，不是全仓CI或互不重叠的独立用例数。最终完整汇总final-regression-20261024/final-summary.json；专属Node/Blender/浏览器/服务均已收束。

### 2026-10-24 工厂Q1组合验收启动

用户授权使用现有工厂完成真实业务流程与最终组合ABBA，维持质量/脚本/MQTT、候选关闭且不进Q2。A明确为已含L2的candidate-1-app，B为最终Q1组合；业务与正式计时分开，原录制缺少货物/报警活跃状态须另核实际配置和合法受控功能报文。验收清单见docs/tasks/2026-10-24-factory-q1-acceptance.md，原证据只读，新结果写独立目录。

### 2026-10-24 工厂Q1业务与最终ABBA报告交付

本轮仅增加验收工具/文档，产品代码、原场景116资源/脚本与原录制未改；关闭候选保持关闭，未进入Q2。A=accepted Q0含L2，B=冻结final Q1。两臂各2业务循环、每轮21项主业务检查通过，task201三host同root/owner/模型lineage；fresh900201实际故障冻结/恢复、拾取与stop/reopen通过。完整逐时刻姿态、全生命周期每帧角色及全buffer pixel0未建立，raw差异保留。

正式A1/B1/B2/A2各60s全部有效，独立119项复算通过。FPS6.8583→6.8167(-0.6075%)，P95 414.65→415.10ms(+0.1085%)，P99 478.20→469.60ms(-1.7984%)；未复现新增steady收益，不宣称统计非劣性或卡顿解决。source-t0各1151 pub/delivery/callback完整/pending0，正式窗边界计数另列。原Logo在两Editor版均解析失败但PNG本地存在，非本轮新增，未扩修。真实发布入口因原bake.enabled=true/result=null拒绝，Viewer成功路径未达到；已发范围选择，未CPU烘焙/切模式/绕过。

主报告docs/tasks/2026-10-24-factory-q1-acceptance-report.md；完整数据output/render-optimization-q1-factory-20261024/{comparison.json,final-acceptance-summary.json,analysis/,performance-audit/,runs/}。所有实际app/broker/发布子进程已收束，精确任务进程查询无残留；旧失败保留，无提交、推送或外部部署。

### 2026-10-24 工厂验收交付范围最终确认

用户明确选择保留真实发布阻塞证据，先交付Editor业务与ABBA。已同步主报告、验收清单和机读总摘要，将Viewer从待选择改为用户批准延期；保留原发布门禁失败与NOT_REACHED，不计成功，不启动全厂CPU烘焙、不切模式或绕过、不进入Q2。原业务/性能数据与独立审计文件未改，也不因范围确认重跑已完成检查。

### 2026-10-24 工厂剩余主线程热点分析

按用户“先分析”要求，在当前冻结final Q1上分别完成CPU profile和GC trace，未实施产品优化。原正式B仍为getSources约282.738ms/次、91次/60s、FPS6.8167；诊断包络不作新ABBA。互斥CPU归属：getSources36.77%、camera/render26.39%、LED独立observer8.14%，HUD/telemetry不是主要预算；create self约7.917s仍需当前版本行级拆分。GC主线程60.955s观察跨度内并集2.852s，Minor516次/2.487s、Major3次/69.271ms；嵌套不相加，缺completion元数据不称loss-free。

新增方案限定为先定位create，再分别小范围验证未使用claimed原生空Set惰性分配、精确字节比较展开；两个候选均未实现/未验收益，不承诺显著提帧。已关闭候选及用户脚本保持原路径，不进入Q2。独立CPU/GC复算和诊断代码审查完成，14产品源码SHA与冻结manifest一致；两次app/broker关闭，精确任务目录进程0。报告docs/tasks/2026-10-24-factory-main-thread-hotspots.md，原始证据output/render-optimization-factory-hotspots-20261024；不因只读分析重跑构建、全套回归或发布。

### 2026-10-24 当前create归因与内核候选执行启动

用户明确授权按顺序执行。新输出目录render-optimization-create-kernels-20261024，先复制冻结B并做仅诊断的非压缩行级CPU+短命对象allocation采样，两个oracle独立准备且不提前跑候选。首个副本build漏两raw示例JSON已保留失败，并通过冻结B主bundle literal核实原文后补入副本，第二次构建中。产品/原资产未修改，关闭候选和Q2边界不变；后续行为/完整collector门槛及停止规则见docs/tasks/2026-10-24-create-kernel-execution.md。

### 2026-10-24 create归因及两内核候选止损交付

当前冻结B的行级CPU与含已回收对象的heap采样完成并独立复算；create6121 line ticks、self8.726s，代表组件copy16.48%、thin展开11.86%，不把诊断或多TS映射当生产精确耗时。候选1旧oracle18/18、3个错误变体RED，实际候选3个pre-import行为反例失败，停止且不跑性能。候选2guarded4实际源码231/231、naive4四反例RED；真实完整provider/getSources两组各7对、14对内容/引用一致，中位数278.1→281.8ms(+1.3305%)与273.4→269.5ms(-1.4265%)，均值方向也相反、较快7/14，无可复现净收益，停止保留原实现。没有第三变体或真实ABBA，后者为门槛未达NOT_REACHED。

全部1024冻结B源码/配置最终SHA一致，原场景/录制/116资源未变；产品未加入实验代码，旧候选保持关闭，Q2未进入。两app及broker正常关闭、精确任务进程0。诊断和probe构建exit0、独立静态/数据审查无HIGH/CRITICAL；未以5s断连前静止窗或带profile FPS宣称收益。完整结论docs/tasks/2026-10-24-create-kernel-execution.md，证据output/render-optimization-create-kernels-20261024；未提交推送或发布。

### 2026-10-24 camera/render只读分析启动

按用户要求转向active评估、矩阵、材质绑定和GL，两个内核与所有旧关闭路线保持停止，不改产品、不进Q2。复用当前B生产与同源非压缩原始profile，三路只读SDK/产品分析与root互斥分区独立开展。发现项目interactive批次覆盖SDK默认材质排序为frontToBack，而SDK仅透明队列更新distance；准备冻结B独立20s原录制状态快照核实实际组/距离/材质，不改排序、不作FPS收益。计划及门槛见docs/tasks/2026-10-24-camera-render-analysis.md。

### 2026-10-24 camera/render只读分析交付

已独立复算camera16.495541s互斥操作：material ready/bind扣matrix/GL5.501955s、dispatch/sort余量4.823421s、active余量3.383265s、matrix/bounds1.658220s、nativeGL1.128680s；不是GPU时间或可省预算。SDK与现场UBO/VAO/ready缓存已有，camera view/projection本身约12ms。20s冻结B原MQTT状态诊断passed：group0确为frontToBack，opaque1282/1284及alpha10距离键全0；基础材质771/773种、连续段801/803，简单材质分组理论仅再少30段且会改公开遍历顺序，不直接修排序。真实mustRebind分支仍未测，下一步方案限定保持绘制序列做force/effect/material/visibility第一触发原因归因，确认私有冗余后才形成候选。

1024产品源码/配置与依赖锁最终全同，原场景/录制/116资产未改，app/broker正常关闭、精确任务进程0；未产品构建、未候选/ABBA/烘焙/发布，关闭路线和Q2边界保持。快照force字段初版读错得到null，已修正工具并封存20份实际脚本SHA，不重写raw或当成零次重绑，修正版未追加硬件运行。独立profile/state/SDK审查及限制见docs/tasks/2026-10-24-camera-render-analysis.md与output/render-optimization-camera-analysis-20261024。

### 2026-10-24 保持绘制顺序的绑定来源诊断启动

用户继续授权隔离诊断force/effect/material/visibility，未授权产品优化。新输出binding-diagnostic目录，静态核SDK5 force+7 cache写及宿主1 force写，虚拟Vite transform只改独立构建，不写node_modules/src或排序/脚本/MQTT。消费者实际转换137例语义GREEN、六类错误变体RED；producer/reset与真实counter另验。计数保留first-winner原短路、未知callee/委托边界和最后write提示，不把相等写直接当可删冗余。计划/门槛见docs/tasks/2026-10-24-binding-invalidation-diagnostic.md。

### 2026-10-24 绑定失效来源实测与严格等价止损

完整sink新增caught-base-throw反例发现v1漏计入口及事件误标；run-1在计数窗口前关闭标INVALID，旧失败/副本保留。v2入口即计并统一资格，真实sink142例+producer98例及RED通过后，用新app2完成有效原工厂60s诊断。probe61.3165s内Push561932、force-first4全初始化；base effect166261/material194620/visibility0/hit201047，无throw/mismatch。原非null对象键不匹配占truthy约99.834%，不冒称GL program/相邻draw可省。

reset2731来源清楚，shadow-all-null2134且混合3 Scene各426 render entry；真实SDK VM反例保留公共2调用和最终null，但跳第二次private写会使setter日志6→3，严格合同不成立。未找到可安全移除的有效私有冗余，按用户要求停止，无产品候选/ABBA/Q2，旧关闭路线不重启。独立71计数/9来源检查及5 witness断言通过。

产品1024行、SDK相关31源与依赖锁全同，原场景/录制/116资产不变；source-t0 MQTT1151发布/交付/callback完整无缺口pending0。两app/broker已关闭、任务进程0；诊断FPS不作收益。主报告docs/tasks/2026-10-24-binding-invalidation-diagnostic.md，证据output/render-optimization-binding-diagnostic-20261024。


### 2026-10-26 数字孪生发布烘焙目录过长修复

截图中的 lighting-bake:start 在 mkdtemp 阶段因深层中台工程路径叠加完整任务 ID 失败。任务目录改为固定长度 SHA-256 摘要加 mkdtemp 随机后缀，记录保留完整 jobId，历史读取/日志/清理兼容新旧命名；正式资源及 .pending 候选目录改为 96 位随机名称，避免保存产物继续叠加长任务 ID。更新光照指南；仅审阅源码和差异，未运行测试或构建，未执行真实烘焙/发布，未提交或推送。
## 2026-10-24 优化进度盘点与第二期方案（仅文档）

- 新增 `docs/全项目优化方案-第二期.md`：盘点第一期 Q0（本地验收通过）、Q1（严格等价收束：B3/B6/B7/LD1/LD7/R1 交付，L3–L6/L8/L9/B2图集保留原实现，LD5/LD6 候选关闭）及四项止损诊断；以工厂预算（getSources 约56ms/帧、render约40ms、LED约12ms）推算严格等价合同下已见顶。提出无需决策的 E1–E6（真实 GPU TIME_ELAPSED 计时、GI/Viewer/展会验证补齐、打开链路、无损资产治理、剩余严格等价 Q2、CI 收尾）与需决策的 D1–D6（观察次数契约、脚本能力声明、LED 资产新修订与扫描器、档位B画质选项、工厂 Viewer 路径、GI 代理合并），附路线图、决策清单与关闭路线。第一期方案与 project-optimization-plan.md 增加链接。
- 验证：仅文档；引用数字均取自既有任务记录，未重新测量、构建或测试。上限推算为量级估计，非收益承诺。未提交、推送或发布。

## 2026-10-24 D1 获批：N1/N2 分类收集减量

- 用户批准 D1（框架读取脚本配置的次数/时机不属于契约）。在 SceneLightingRuntime 实现 N1（无分类消费者时帧内不收集，保留 dirty/revision，消费者出现或显式查询时完整补收集）与 N2（无 GI 状态时的合并窗口 max(250ms, 3×上次耗时)；有 GI 状态/异步事务/结构待办/待应用 GI 结果时不合并）。lightingInvalidation 诊断新增 noConsumer/coalesced 两个跳过计数。
- 测试：新增 5 项用例；既有运行时夹具显式 classificationCoalesceMinMs=0 以保留“每帧立即消费”语义。test:lighting-bake 251/251、manager 82/82、unified 42/42、optimization 79+1 可选跳过，typecheck 与相关 ESLint 通过。
- 未验证：没有做工厂 ABBA，FPS/长任务收益未知；N3（按模型增量缓存）未开始。未提交、推送或发布。

## 2026-10-25 中台工程打开 Windows EPERM 与失败重试修复

- 工程物化、备份、替换及回滚补齐 Windows `EPERM/EACCES/EBUSY` 有限退避（最多八次、等待合计 4.35 秒），保留同盘移动、原始错误及恢复目录；打开等待可取消，回滚不受取消阻断。
- 修复首次下载/物化失败后空初始化目录阻止再次打开：只读识别已知空目录骨架；任何文件、未知目录或链接继续拒绝，来源/项目绑定及旧目录规则不变。原截图项目只读目录预检已通过，未修改其目录或内容。
- 验证：Electron 构建、typecheck、两个源文件 ESLint、相关 diff 检查通过；五个定向测试文件最终 32/32 通过、0 跳过，含真实 Electron 文件锁错误注入、取消/完整和不完整回滚、用户内容保留以及 Windows junction 边界。日志 `output/project-open-windows-rename-20261025/focused-tests.log`；详细清单 `docs/tasks/2026-10-25-project-open-windows-rename.md`。
- 未完成的实机验收：旧编辑器 PID90420 仍运行，Windows 拒绝本会话停止该进程，常规关闭未生效；用户明确选择“先交付修复，我稍后重启”，故不宣称真实中台项目已打开。保留旧实例与已有未提交优化改动，无后端修改、提交、推送或发布。

## 2026-10-25 中台工程打开 EPERM 根因：开发服务器文件监听

- 现象：重启后仍报 `rename extracted/Assets -> materialize/staged/Assets` EPERM。根因：数据中台工作区 `Platforms/` 位于仓库内，`npm run dev:electron` 的 Vite（chokidar 在 Windows 逐目录 fs.watch）监听了它；被监听目录在监听期间重命名必然 EPERM，4.35 秒重试无效。Node 最小复现：监听子目录时 EPERM、关闭监听后成功；真实 Vite 对照：Platforms 下目录重命名成功，仍被监听的对照目录 EPERM。
- 修复：vite.config.ts 的 watch.ignored 增加 `Platforms/**`、`SharedResources/**`、`**/.babylon-editor/**`（同时覆盖模型/环境/天空盒同步的原子替换）。dataPlatformProjectService 的移动在占用重试耗尽后，仅对“源在本次暂存区且目标不存在”的三处（extracted→staged、staged→目标、回滚 backup→目标）改为复制替代并尽力删除源；原用户目录移入备份仍只用 rename；复制失败删除不完整目标，cause 保留原重命名错误。
- 验证：build:electron、typecheck、相关 ESLint 通过；五个定向测试文件 32/32（新增持续占用改复制成功、复制也失败保留原错误、回滚复制失败进入恢复目录路径）；更新源码形态断言为“rename 优先、复制仅作耗尽后回退且不覆盖已有目标”。未在真实中台项目上实机打开；需重启 npm run dev:electron 使 Vite 新配置生效。

## 2026-10-25 第二期 E4：GLB 面数密度报告

- 新增 scripts/report-model-density.mjs（只读，只解析 GLB JSON 块，支持 Draco/meshopt 压缩模型，沿节点层级计算世界尺寸）与 5 项单元回归；登记 npm 入口 report:model-density / test:model-density-report，测试清单与入口检查通过。
- 本机中台项目实测：23 个 GLB 合计约 90.2 万三角面，环境模型 model.glb 占 96.1%（53.1 MB、未压缩）；未发现小尺寸高面数网格。GLB 传输压缩实测 gzip 80%/brotli 76%（环境模型），合计 79.9→62.7 MB（brotli）。LD7 扩展到 .glb 与环境模型几何压缩列为待确认候选，未实施。
- 同时刷新 workspaceProjectOpen.integration.mjs 的分类登记证据（EPERM 修复后导入行合并）。未修改产品运行时代码，未提交、推送或发布。

## 2026-10-25 优化第二期续作：CI 收束、GLB 运输及默认窗口验证

- 核对并刷新第二期进度：D1 已批准、N1/N2 已实现但未做工厂 ABBA；N3 未开始。保留既有 GLB 侧车草稿，补有效几何的 ZIP/HTTP/缓存验收，不把入场代码重复算作本轮新实现。
- 修复受支持 Node 22.16 下天空盒顶层同步 require 提前读取 ESM 导出的 TDZ；静态 `.ts` 依赖由已有构建器重写为 `.js`。天空盒旧夹具按已有内置资产、工程隔离路径和物化目录合同修正，新增两种真实导入顺序回归。专项 157/157，完整 CI 816 pass / 0 fail / 1 外部 EXR 条件 skip；完整 build 与 lint exit0。
- GLB 单元 17/17：真实 ZIP 归档、完整 SHA/字节还原、实际 Babylon loader（NullEngine）验已知几何；Chrome 28 项 HTTP 原 URL/MIME/编码检查与冷/暖/换版/回旧版均通过。HTTP 的 GLB 解码为元数据检查，未冒充 GPU 加载。完整 Electron DIST 集成因本机 spawn EACCES 两次未能启动，明确未验收。
- N1/N2 默认 250ms 窗口补结构变化、阴影代理关闭恢复与 GI 异步事务三项回归，运行时 67/67。只读扫描 SharedResources/Platforms 的 53 个脚本文件，未改资产脚本。
- 本机真实环境 GLB 副本经生产 helper：55,684,996B → gzip44,655,990B（−19.81%）/br42,736,051B（−23.25%）；解压完整 SHA 相同，原文件未变，单次约2.32s。仅为本地传输字节与单次处理数据，不代表打开耗时或 FPS 改善。二期整体未验收，线上服务未部署，原工厂冻结输入缺失及 Electron 启动限制保留。
- 更新发布缓存使用文档、三项测试分类摘要与生成清单；入口/清单检查通过。详细清单及所有证据见 `docs/tasks/2026-10-25-optimization-phase2-continuation.md`。无提交、推送或外部发布。

## 2026-10-25 Electron EACCES 修复、完整 DIST 与 E3 初始化诊断

- 原生Process.Start将Node EACCES还原为Win32740：当前用户对精确开发Electron路径设置了 `~ RUNASADMIN `。备份到 `output/electron-eacces-20261025/compatibility-backup.json` 后只移除此值，普通spawn版本v42.4.0/exit0；运行时75文件与校验缓存一致，未重装/升级、提权、改ACL或系统策略。
- 完整DIST packager集成在最终构建下PASS：25文件/30 ZIP条目/11侧车，清单SHA/MIME、有效GLB/真实loader、ZIP预算回退、已有侧车与3种取消清理均通过；原EACCES失败日志保留。此为受控夹具的完整打包入口，不冒称工厂发布或线上部署。
- E3新增constructor/onStart同步attempt计时与失败数，并按资源聚合Top20（512资源上限、超限显式不完整）；保留原整体异步等待、顺序/receiver/getter/异常和Promise不等待语义，诊断sink失败隔离。生命周期16/16、聚合6/6，完整build/lint/CI通过（CI816+1外部EXR条件skip）。
- 真实Editor离线小夹具PASS并操作复制诊断。当前383实体场景自然就绪并读回156次初始化/16资源：onStart累计19.779s，motor81次14.980s（75.7%）；原场景未变。大场景整体smoke因连接超时/未知图片协议保留FAIL，不输出有效打开耗时或FPS收益。
- 扩大加载专项暴露旧strip-only入口与旧源码抽取/VM夹具漂移；修入口transform后168pass/28fail，残留静态归因到未改文件，未实跑HEAD、未放宽或删除断言。正式冷暖、跨进程trace、工厂ABBA与线上服务仍未验收；证据和后续优先级见既有续作记录。
- 最终P2回归201pass+1可选基准skip、P4清单9/9、入口missing0/清单unclassified0；精确HKCU管理员标记仍不存在，任务Editor/packager进程已释放。机读最终报告 `output/electron-eacces-20261025/final-summary.json`，旧摘要归档保留；没有提交、推送或外部部署。

## 2026-10-25 二期全项推进（进行中）

- 用户要求继续并完成所有优化，建立唯一清单 `docs/tasks/2026-10-25-optimization-phase2-completion.md`。原冻结输入/原MQTT、工厂Viewer路径、失联外部大屏有效地址已异步询问，独立工作继续；不放宽原验收或外部发布边界。
- 已修本地图片缓存根/离线读取/授权与提交时序，原unknown scheme错误消失；剩余大场景网络错误来自真实192.168.18.100:8087。GPU N/A定位为模块化入口缺WebGL query注册，实际小/大场景各60s计量已得有效样本，GPU查询按诊断开关启用。
- 已完成B4真实Cycles零差异与安全单遍；加载旧测试夹具已恢复，E4严格无损副本23包验证完成，D3资产候选无收益止损原件保留。R9审计/R5评估完成研究阶段；R3/R8显式选项实现及后续真实验收进行中。每项源码/证据/未验证边界均记录在唯一清单，不宣称二期总验收已完成。

- 用户补充范围：当前383实体原路径、新中台172.16.3.27:38087、先非GI副本再独立GI；缺失大屏与旧MQTT明确允许忽略，原配置保留。另批准可选lighting v3，旧场景v2不变。
- E4已交付显式model-lossless/model-meshopt-lossless与模型库密度提示；当前23包严格存储/无量化meshopt oracle及环境候选真实Editor完整8,294,400B RGBA均零差，原件SHA不变。meshopt全包−9.08%、环境−12.32%，不把单次读取阶段计时当稳健加速。旧安装隔离tree的两条junction因自动审批blocked by policy保留，未进入或换方式删除；实际工具链在无junction的新目录。
- R3/R8/L10实际Editor/DIST Viewer/iframe通过；内部纹理URL字典仅去重IPC重复URL，保留二进制几何/完整校验/旧默认，定向兼容19/19。修图片部分迁移时两根清单合并及Viewer原DPR容差，原失败日志保留。
- B8新增可选真实gamma编码/v3版本门、recipe过期提示与UI/后端/loader/shader/Viewer能力完整接线；16项合同通过、build wave6通过，真实小业务全链仍在验。B9实际Blender微oracle发现np.rint及margin3角点假设错误，按实际float32量化与独立同chart线性padding实施，尚未宣称完成。
- 小型业务GI已有SOURCE/DIST/真实Viewer成功证据；完整环境GI固定10min结束仍UV，按原预算正常取消并关闭owned进程，未完成大环境GI。task.json旧baking快照与进程已收束分别记录，不伪造最终cancelled写盘或总验收。
- B8最终严格复核已通过：wave11完整包在独立Viewer和iframe实际播放入场溶解，GI/Gamma与入场shader同时生效；完成后连续2秒ready且runtimeError/HUD为空。原case6脚本瞬时PASS被截图推翻的报告保留，最终依据fixed-4。双侧材质租约、薄carrier身份及受控几何ticket有独立RED→GREEN回归。
- wave12完整构建通过，包含B9首轮核心接线、非receiver UV精确candidate2判定与图片分页修复。图片201条/3页及失败保留旧索引回归8/8；B9实际业务与新Mip外沿packing仍待验证。N1当前383新条件plan3严格ready/同帧冻结41纯测试通过，历史工厂条件未恢复，完整ABBA未跑。
- E3只读前置2的64次POST及两轮一致性通过；正式paired-1在任何Home打开/下载前因测试bootstrap在ready后导入主入口而失败，0有效样本。主PID77624及3个后代按CreationDate确认全部退出，无强制终止；保留原失败，正修测试时序。不能将其写成冷暖性能或30%目标通过。
- 新Mip packing-v2的G(k)=ceil(1.5*2^k)+2已接入metrics/partition/oversize/pack，8个实际pack→cert→producer纯正例通过，内部tight chart仍拒。最终主py8ff0cd…8a8a5复制到专属output后，以冻结旧版d105ee…59089做9例真实Blender CPU A/A与A/B：像素、源UV/TBN、几何、探针逐bit/byte全同，PASS；主源码不导入产生缓存。当前完整加载专项再次209/209、0skip通过（scene-loading-final-wave13.log）。不把这些合同/默认分支结果写成B9实际业务或性能通过。
- wave13完整Editor/Viewer/Electron构建通过。E3 bootstrap时序修复后paired2实际C1遮罩136322ms，但后续严格冻结检查发现物理pin源4688与声明AA45矛盾而FAIL；0有效样本，不补其余9次，不据遮罩时间宣称natural-ready/加速通过。原scene、下载物化scene/live投影与守卫收据保留，正核具体引用/字节/是否重绑定。main102000与已观测后代按身份全退出、exit0；CPU工作集/输出预算在该观察范围内，renderer performance.memory的isolate归属仍须核，不能由19.3MB观测当完整heap峰值保证。
- E3后续精确审计澄清：原scene与物化SOURCE的owner一致，live正常data-platform-latest刷新330个sourceKey并更新两个资源修订（影响3个多穿相关实体+1个HCTS）；此前pin断言使用原AA45规则冻结新4688 live，不能把它概括成live自身owner/path矛盾。用户已明确批准以新平台解析的当前修订建立新基线，历史370口径仍未复现。`e3-current-baseline-2`独立冻结原SOURCE/解析live及56份实际引用文件SHA，schema/可逆投影预检通过；只读协议新增显式双基线和precise-main-target heap/OS PID证据，原默认严格口径保持，新五冷五暖尚未运行。
- B9真实生产1atlas/12probes/PBR+Standard成功后，重开揭示本地恢复器只接受PNG/JSON；按kind/codec精确补B7/B9 bin，旧格式/未知/越界保留，14项含实际已存scene恢复通过。wave14构建通过；普通resume已核所有5层实际GPU字节/绑定/像素，但恢复后GL1282未过。一次显式原生调用诊断定位HybridShadowCache在恢复后delete旧世代FBO/RBO，诊断不计功能PASS；窄修世代生命周期7/7、原hybridShadows9/9、strict/lint通过，待wave15普通无包装复验。
- N1 attempt4严格天空盒门误看旧settings空值，现按实体HDR精确源与SHA冻结，独立RED→GREEN及43纯测试通过；attempt5真实strict-ready与预热通过，但preAA0遇CPU镜像为空的薄实例world0，未采60s、原失败保留且owned进程均退出。新同步GPU原缓冲读取保持同帧/128MiB上限/恢复COPY_READ绑定，56纯合同与实际micro三点/原生超限探针通过，后续完整ABBA仍未运行。
- P1同openId跨进程trace新增3个有界纯helper和2份测试，17/17、strict/lint通过；记录器区分独立时钟、phase union/task sum与IPC包络，不轮询、不持有Mesh/URL等大对象。现开始可选API/main阶段1–4接线，Home/Store/runtime七阶段尚未接通，不把helper通过写成真实打开trace通过。
- wave15构建通过；B9普通无GL包装的Gamma最高4级与线性最低1级均实际完成生产、保存重开、完整各LOD GPU字节、真实sampler/新帧绑定、context restore与连续稳定门。负例旧UV岛足印重叠按原规则拒绝，旧Gamma结果/场景/全部资产SHA不变。真实DIST继而被Source完整性门拦住：loose GLB的DIST fallback把整个Models当包，SOURCE只收单文件；正在窄修收集一致性，并用真实外置PNG GLB回归避免explicit-only引入漏依赖，未放宽完整性门。
- E3新基线paired3的C1遮罩125870ms、未豁免错误0、观察预算内，但SOURCE/逻辑冻结仍因typed换根枚举遗漏而FAIL，0有效样本。差异仅开场package.manifestUrl和defaultTarget/deviceSlot的物理路径assetId别名；原始值/源ID/版本/参数未变。owned101784及观测后代已退出，旧失败保留。仅对真实schema与同owner物理别名补齐可逆投影，并补开场包局部文件闭包；下次必须先离线重放该原始失败zero差，不能泛忽略assetId或重跑GUI碰运气。
- P1 main/API同ID、owner只读门、四await阶段与固定M1/M2包络26/26、strict/lint通过，原caller/错误/取消不变；renderer实际点击/提交/资源与runtime阶段接线继续。中型ROI已离线复制原env与所有灯、bake=false且未绑定，原scene/env/plan全SHA保持；未运行Editor身份观察或烘焙。
- 调度复核发现completed代理只收到消息而未真正触发renderer后续执行，先前“接线中”状态不准确，已明确纠正并拆分Editor与runtime非重叠写域。runtime/cache半批现已实际完成9源+2tests：57/57（原47+新10）、完整SceneRuntime依赖strict/lint/diffcheck通过，证据`artifacts/phase2-project-open-trace-runtime/verification.json`。同ID精确queue/read/clone/init/batch/ready、共享producer/wait/link与异步captured scope已接；发布asset-cache网络/原始缓存细分未接，不伪0ms。Editor/Home半批待实际集成，尚无真实七阶段通过。
- 冷暖前追加只读输入审计确认18个活跃纹理参数槽（15 platform logo+3 builtin logo）对应2张图，原71file未覆盖其字节；图库updatedAt及无SHA的index不能替代校验。现准备只读actual脚本注入URL→当前cache/bundled bytes的独立冻结，原scene/raw/resolved字段仍不删改，不追认旧cohort输入完整。

## 2026-10-26 2026cemat展会低FPS原因排查（仅诊断）

- 用户指定中台 `http://172.16.3.27:38087` 与 `2026cemat展会`。使用独立用户配置的实际Electron开发实例、既有Vite5173及原场景，未保存场景、修改产品代码、重新烘焙或发布。
- 已复现RTX4060Ti约15.6FPS/CPU60.8ms/1809DC。10.85s CPU profile中sync路径约6.62s，签名walk自身约4.24s；3.5s失效诊断56次document-sync，无结构变化。
- 根因：旧烘焙签名不匹配，tick在无state且result存在时反复sync；sync重新标记bindingsDirty，失效分支只refreshSources，形成下一帧重试循环。每次重复场景签名及939项光照分类；result存在又绕过分类合并窗口。
- 824x440同视角短时隔离：原15.60FPS；仅诊断阻断同一失效sync后58.29FPS（阴影/DC保持）；再关阴影60FPS/435DC。恢复原函数后dirty已被消费，须恢复原dirty重试状态才重新复现15.33FPS；不把这一状态差异隐藏为简单A/B。
- 原文件保存签名ecb8bae89fd86c64、当前代码计算4db0bc7d121c08a9、打开后e0e1654870977a04。只能确认旧结果不匹配，未追溯历史编辑/烘焙操作。原场景SHA一致，诊断进程已关闭。5s对照不代表全屏/发布Viewer性能验收。
- 原始报告、cpuprofile、临时对照及签名证据：`output/cemat-fps-diagnosis-20261026/`。本次排查完成，正式修复尚未实施。

## 2026-10-26 修复展会场景的失效烘焙逐帧重试

- 用户授权修复重复校验，要求保留过期提示、正确失效判断与原画质，并用2026cemat展会验证FPS。
- `SceneLightingRuntime.sync`的关闭/失效/已失效快照分支改走现有`refreshBindingsForSources`，完成分类及绑定待办；沿用revision保护回调重入，不直接清空dirty。复用本次documentSignature，消除一次sync内重复哈希。签名、recipe、几何、材质、真实光照与异步提交校验均保留，未调整画质。
- 既有定向回归9/9通过，覆盖静态姿态失效、动态几何与恢复、分类/绑定重入和已应用GI即时校验。未新增测试。真实场景新失效通知触发恰好1次document-sync，随后pending全false；临时文档主光变化改变签名，恢复原文档签名与过期提示均一致。
- 实际Electron/Vite5173重新打开原场景，读回已加载修复代码，无运行时方法替换：824×440同保存视角20秒1169帧、58.4088FPS、CPU均16.3964ms、GPU均11.7904ms、帧间隔P95=19.5ms；1809DC、2048×2048三级高质量阴影保持，20秒分类收集0次、pending全false。此前同尺寸原状态5秒15.6046FPS/CPU60.7882ms；窗口时长不同，不冒称严格基准或发布版验收。
- 原场景SHA保持，未保存/烘焙/发布，任务诊断实例已关闭。证据`output/cemat-fps-fix-20261026/summary.json`、`fps-824x440.json`、`invalidation-check.json`、`regression.log`及截图；同步更新混合光照指南。源码修复与本地开发入口实测完成，未做发行包构建或外部部署。

## 2026-10-26 正式编辑器与Viewer重建（Viewer兼容选择待确认）

- 用户要求重建编辑器/Viewer，以2026cemat展会验证且不降低画质、不发布中台；后续已明确同意只读取线上v20原DIST并本地替换Viewer，保持场景资产。
- `npm run build`及补齐异步几何/资源失败重试后的最终build均exit0。产物为dist、dist-electron、dist-viewer-template。sync异步失败只在当前operation/key与source/binding revision一致且没有有效/待激活状态时完成本代绑定待办；新变更仍保留。相关旧加载恢复/异步变更/真失配回归7/7通过。
- 最终file://正式编辑器实际打开原场景20秒58.7077FPS、CPU16.4782ms、1809DC，824×440、原高质量2048三级阴影保持；过期错误保留、分类收集0。原scene SHA仍1f407994…8dcf，诊断进程已关闭。
- 本地正常DIST导出按原规则拒绝过期烘焙，未绕过。已通过只读GET导出线上v20（versionId2114548950415089666）的原始DIST，31,649,582B；平台返回的192.168.50.34:8080静态地址不可达，使用172.16.3.27:38087已验证下载接口。无prepare/上传/commit/部署请求。
- 原v20在本地Chrome/RTX4060Ti运行12.7373FPS、CPU77.0314ms、20s重复document-sync256次，错误为几何/姿态与烘焙不一致。直接换新Viewer保留project全字节后被旧HDR无ENV的兼容门阻断；真实失败证据保留，未关天空/改画质/冒称通过。
- 已向用户提出二选一，当前尚无回复：推荐只回补v20原Viewer内相同修复，保留旧天空实现与场景资产；或在独立副本转换天空资源以验证最新Viewer。未执行依赖该选择的后续操作。当前只完成构建及正式编辑器验收，发布场景最终验收未完成。
- 全部证据及原始zip在`output/cemat-production-fix-20261026/`，断点`progress.json`。本次Chrome和loopback4570已关闭，临时数据及失败产物保留。主工程无commit/push/中台发布。

## 2026-10-26 v20 Viewer兼容回补完成（不发布中台）

- 用户明确选择“仅回补原Viewer，保持原画面”。以已冻结v20原包为基础，仅替换其一个sync方法，等价回补源码中的绑定待办收束、单次签名计算和有revision保护的异步失败收束；保留旧天空/材质/渲染实现。
- 回补脚本`output/cemat-production-fix-20261026/backport-v20.cjs`严格绑定原程序SHA与唯一方法形状；语法解析通过。更新程序及对应br/gz、runtime-config缓存版本、release-cache-manifest共5文件；其余848文件相同，122个project文件全字节不变。压缩侧车解压等于程序；缓存清单327条全SHA/大小校验。
- 实际本地Chrome/RTX4060Ti、同保存相机/824×440各20s：原12.7373FPS/CPU77.0314ms/P95=86.4ms；回补59.9952FPS/CPU11.5808ms/P95=18ms。1863DC、2048×2048三级quality阴影、原HDR512天空保持。稳态document-sync0、分类0；新失效通知仅同步1次并消费pending，几何/姿态失配提示仍在。
- 原v20 GPU计时器不可用，不补造GPU数据。局部/favicon.ico404及加载期缓存ERR_ABORTED原始观察保存在network-observations；实际模型全部就绪，未把旧烘焙失配标成有效或另起烘焙。
- 交付`2026cemat-v20-viewer-fps-fixed.zip`，31,664,779B；853文件归档读回与已验目录逐字节一致。SHA和完整结果见同目录summary.json及.sha256。最新通用dist/dist-electron/dist-viewer-template与正式编辑器58.7077FPS验收均保留；新模板直接替换旧HDR的失败记录也保留。
- 原工程scene SHA保持，未上传/部署/commit/push。任务浏览器及loopback5087已关闭；进度已更新COMPLETE_LOCAL_ONLY。

## 2026-10-26 烘焙性能与大场景稳定性只读评估

- 交付 `docs/数字孪生编辑器烘焙性能与大场景稳定性评估.md`，README 增加索引；用户确认故障阶段为“点击预检或开始后，尚未明显进入计算”。
- 按当前捕获、IPC、Cycles、材质和结果应用链路区分画质、生成耗时与稳态性能；未将静态阴影缓存或历史局部优化计作 GI 帧率收益。确认预检先完整捕获、逐 primitive 属性复制、二进制解码恢复数组等当前风险。
- 复核既有完整环境报告：历史约 2.13 GiB 前端堆观察值触发检查脚本 2 GiB 限额并正常取消，不能当作用户本次 OOM 崩溃；直接开始的历史完整环境运行仍超出 10 分钟检查期限，保留 FAIL。当前已有纹理 URL 字典与 GPU 探针缩批等保护，文档按现状记录。
- 处理建议覆盖轻量准入、有界捕获/传输、分阶段预算、后端恢复、加载峰值及独立收益测量；均为建议，未改业务代码。按文档任务边界只检查内容及差异，未运行测试、构建、烘焙或浏览器验证；用户本次事故的退出原因和精确分配归因仍待证据。


## 2026-10-26 烘焙稳定性整改与工厂准入验证

- 用户授权按评估方案整改并指定工厂。实现轻量预检、捕获前任务记录、逐primitive紧凑捕获、4MiB确认分块与文件暂存、分阶段预算、取消收敛、完整阶段恢复和按字节加载；CTS/TS双preload均接通，保留旧接口及原画质/身份/数值合同。未改原工程、未提交/发布。
- TypeScript编译与54项相关检查通过；另一组102通过/1跳过/1回滚颜色断言失败，替换HEAD运行时代码仍复现。最终加载检查13/13通过。真实七表面恢复9资产SHA一致；正式Electron23表面完成捕获、Cycles及实际应用，无validationErrors。
- 完整工厂383实体/3913渲染网格，原standard/2048/32texels/4m/256MiB配置；轻量预检8.66秒，821静态表面/870875三角/219源纹理，27081探针超过4096，明确拒绝且窗口仍响应。原文件SHA不变，无rendererGone/pageErrors；工厂全程烘焙和FPS收益未完成，需先明确探针覆盖配置。
- 更新混合光照指南、原评估文档第9节与 `docs/tasks/2026-10-26-lighting-bake-stability.md`。证据位于 `output/lighting-bake-stability-20261026/`，失败尝试也保留；复用工具的遗留ABBA标签已在结果清单说明并校正，不充当性能证据。临时服务/进程/入口已退出清理，当前生产窗口和安装版未更新。


## 2026-10-27 Sandbox 照明的阴影与天空盒

- GLB 标准环境使用统一主光时，开启阴影会启用主光，强度为 0 时恢复默认值；主光仍可单独调整。
- 标准预览保留天空盒显示状态；场景天空盒可单独作为背景，环境照明继续使用 Sandbox 资源。更新管理器提示与使用文档。
- 实际隔离 Electron 编辑器中应用 Sandbox 预设，开启阴影后统一主光启用（强度 1.05）；天空盒关闭再开启后实际显示，环境纹理对象与强度 1 不变，WebGL 2 / Intel UHD 630。旧夹具运行时钩子未捕获当前实例，按画布定位后继续完成。
- 独立 WebGL 对照中四组静态/动态阴影关闭投射后分别有 622、319、366、247 像素变亮；天空隐藏、显示和更换时模型中心 60×60 区域 RGB 零差异、背景变化，环境纹理对象不变。证据见 output/sandbox-verification-20261027/ 和 output/playwright/sandbox-{shadow-validation,sky-verification}-20261027/；未验证用户实际工程。

## 2026-10-27 修复大场景本地资源恢复阻塞

- 本地场景资源恢复移除单独的 64 MiB 场景内容上限，与前一阶段同步行为保持一致；继续校验非空、场景格式、版本和资源路径。
- 截图中的调用传入序列化场景字符串，错误指向超过该限制；未取得用户场景的实际字节数，未运行测试或实际打开验证。

## 2026-10-27 编辑器模型墙面条纹修复

- 对照 Babylon Sandbox 与用户 GLB：WALL 和 Rectangle2133409842 的实际三角面有约 3 × 2 m 重叠，间隔约 1–3 微米；编辑器近裁剪距离过小时更容易出现深度条纹。
- 编辑器轨道视口增加有界近裁剪精度补偿；正交、Viewer 和漫游沿用原规则。保留原矩阵精度，避免改变旧烘焙的严格几何签名。
- 使用实际 createBabylonViewport 和原 GLB 的隔离墙面定向验证：radius 20 m 时补偿启用 near 0.2 m、关闭 near 0.02 m；启用和恢复后目标区域无条纹，关闭时复现。未验证完整业务场景；近裁剪面内物体仍会被裁剪，完全共面几何仍可能冲突。

## 2026-10-27 发布 Viewer 墙面条纹修复

- 发布 Viewer 入口补齐 depthPrecisionCompensation，与已修复的编辑器采用相同近裁剪精度补偿；显示精度与 allowCameraControl 解耦，禁止视角交互的页面同样生效，鼠标权限保持原规则。
- 人物漫游接管时关闭补偿，退出后恢复；正交投影、矩阵精度及既有烘焙签名保持不变。同步相机规则文档。
- 已审查源码与差异，未运行测试、构建或线上验证；已发布页面需使用重建后的 Viewer 模板重新发布才能生效。保留工作区其他任务改动。
## 2026-10-27 工厂首批场景级性能优化

- 用户授权按方案优化，设备行为与业务逻辑不变。生成原工程 `Scenes/中鼎智能-工厂-性能优化.scene.json`，不覆盖原场景，不改通用运行时代码、资产或脚本，不提交/发布。
- 核对新辊道参数脚本及实际运行时后，为81台设备的729个普通固定叶部件建立绑定resourceIdentity的静态节点覆盖；内部薄实例、独立运动货物和其它设备保持原规则。阴影显式改balanced，120m距离和动态阴影保持；承认阴影精度降低，不称画质无损。
- 原文档移除上述新增光照覆盖、恢复原阴影档位后逐值一致；MQTT/Fetch、设备编号、脚本参数、资源、层级、变换及货物/站台配置不变。原场景SHA为4dd76f7c…df480，副本51c8c7ed…2444；原辊道脚本SHA保持422bb6d6…60d2。
- 实际Web Editor/RTX2070SUPER/1000×607同视角：缓存稳定后DC为原6009、仅固定分类5700、交付配置3200；阴影贴图与缓存估算192→24MiB。三组3913 Mesh、2323 active mesh、主视图估算1,682,469三角保持，729覆盖命中、身份失配0、三维资源就绪、运行资源错误为空。
- 预览后台动画帧不可靠，使用原Engine渲染回调显式推进完成画面与绘制验证；不以人工推进帧或原始计时宣称正常FPS、CPU/GPU收益或30FPS达标。未运行测试/构建/真实MQTT回放；原关联大屏外部超时保留。
- 既有动静合批候选仅减少148DC且诊断出现CPU成本上升，未证明净收益，保持关闭。证据与截图位于 `output/factory-fps-optimization-20261027/`，完整说明见 `docs/tasks/2026-10-27-factory-fps-optimization.md`。诊断ENV由原HDR、原1024尺寸及现有配方生成；交付场景仍保留原天空引用。

## 2026-10-27 优化工厂正常前台 FPS 实测

- 用户明确要求运行优化场景测实际FPS。当前正式构建早于最近源码，已重建TypeScript及renderer，均成功；未运行测试或继续修改优化配置。
- 首次Electron启动遇到当前路径RUNASADMIN兼容设置并超时；通过任务自身调试通道关闭专属残留进程。未改注册表或权限，复制同SHA Electron运行时后以普通权限成功启动。首轮失败记录保留。
- 实际原生Electron、RTX4060Ti/ANGLE D3D11/WebGL2，最大化窗口、DPR1、1960×948实际渲染表面，默认相机静止编辑模式。资源全部就绪并预热10秒后，正常渲染循环60.000秒完成857帧：平均14.2833FPS，每秒14～15帧；帧间隔P50=69.8ms、P95=73.4ms、P99=75.5ms、最大78.4ms。
- 全程visible/focused、窗口未最小化、相机与尺寸不变，前后邻帧齐全、连续性中断0、measurementValid=true。没有人工推进帧、改渲染循环或关闭后台节流。729静态节点覆盖生效、DC3200、阴影预算24MiB；页面脚本错误0，原大屏服务超时保留。
- 当前仍未达到30FPS；本次未做同条件原版对照或真实MQTT运动回放，不计算相对于历史12FPS的提升比例。优化场景源SHA不变，专属窗口/临时场景/用户目录/运行时副本已清理。证据为 `output/factory-fps-optimization-20261027/foreground-fps-2/report.json` 与 `editor.png`。

## 2026-10-27 工厂框架瓶颈定位

- 以原优化副本和相同画质隔离采集：RTX 4060 Ti、1960×948、前台60秒13.77 FPS，GPU P50 37.41ms；阴影约1250 DC/帧，静态缓存276次均命中，方向光投影及active mesh为CPU采样热点。正式基线、profile和阴影归属见 `output/factory-framework-analysis-20261027/`。
- 现有合批隔离诊断退化到4.53 FPS，维持关闭；临时禁阴影对照19.33 FPS仅用于定位，已恢复，不作为无损优化。1250次动态阴影draw中481次来自13台穿梭车运动部件；37组顶点索引及选定材质字段运行态比对一致，但插件、真实运动和同帧阴影未证明。
- 首次全量运行态比对时页面关闭，未取得renderer退出原因；随后逐实体有界读取成功。源场景及隔离副本SHA未变，专属进程退出。当前未修改产品代码或宣称提帧；真实设备运动输入、动态载体与像素/拾取对照仍未完成。详见 `docs/tasks/2026-10-27-factory-framework-bottleneck.md`。

## 2026-10-27 工厂动态阴影隔离验证

- 用户确认没有真实MQTT录制，使用仅在隔离实例内生效的合成locator和原穿梭车驱动进行走行、伸叉、急停；输入与真实现场设备配置和消息时序不同，不作为现场回放验收。
- 隔离原型在保留原投影列表时，将481次动态阴影绘制替换为37个13实例draw。首版漏复制无索引属性而少画36个载体，已识别并保留失败；修正后确认全部37个载体实际绘制。一次12秒静止短窗原型GPU中位35.67→32.90ms、FPS 14.52→14.88，未完成正式ABBA，不能认定稳定收益。
- 合成运动中吸附、走行和伸叉阶段各一次接管快照的源世界矩阵与实例组合结果逐分量一致；生成货物改变场景网格和阴影列表，实验守卫回退原列表。目标阴影可见性与画质对照仍不可判定；近视角一次出现20360像素差，增加原生负控后差异未复现且受自然画面波动影响，原因未知。
- 合成接收面负控移除原caster后画面仍零差，未证明阴影可见；脚本在计算负控结果前已采B帧，B仅作原始记录。没有改产品代码或开启实验默认值，不宣称完成无损优化或FPS提升。隔离过程、失败与结果见 `output/factory-framework-analysis-20261027/` 下 `shadow-carrier-*` 记录及既有任务文件。

## 2026-10-27 通用渲染框架优化定位

- 原始工厂 quality/hybrid 前台阴影审计：3 个级联各约 1353 次 shadow draw/帧，静态缓存 648 次命中、0 次重绘或失效；见 `output/live-gpu-diagnostics/shadow-audit-2026-10-27T02-50-01-386Z/report.json`。历史原始场景前台基线为 11.783 FPS。
- 独立普通阴影和使用项目混合缓存的三级 CSM/PCF 微场景，索引/非索引、移动与材质失配回退均获得有效负控和一致画面；CSM 深度为每层隔两 texel 的抽样，不等于完整贴图验收，未覆盖复杂材质或真实设备。未修改产品代码、未完成 FPS 改善；保留任务记录、原始构建快照与后续对照工具，见 `docs/tasks/2026-10-27-general-rendering-optimization.md`。

## 2026-10-27 通用阴影合批续查

- 原工厂隔离 A1：RTX 4060 Ti、1960×948、高质量 3×2048，60 秒 11.2 FPS、6009 DC、GPU P50 57.90 ms；未得到候选构建，未进行正式构建 ABBA。
- 不同 Standard/PBR 材质的受控 CSM 实验稳定态负控与回退一致，但首轮 clipPlane 变化发生未解释的画面差异，不能证明变更当帧等价。原厂 12 对独立几何 GPU 缓冲读取瞬间相同，每对同步比较 3.8～4.6 ms；记录隔离窗口既有 GL errors，不声称持续安全。
- 自动分组隔离研究接管 14 组/64 对象，6009→5859 DC，但四个 12 秒 A/B/B/A 窗口为 11.42/8.83/8.58/11.33 FPS；低分配精确比较变体为 11.42/9.75/9.75/11.17 FPS，仍退化。两份均不追踪全部原生 GPU 写入、未证明工厂画质/业务等价，不引入产品。证据和限制见 `docs/tasks/2026-10-27-general-rendering-optimization.md`。

## 2026-10-27 阴影变更追踪与材质逐帧定位

- 受控 WebGL2 实验证实，订阅前保存的原生 `gl.bufferSubData` 可改变 GPU 内容而不触发现有引擎上传监听；不证明原工厂实际使用该路径，但不能据现有 hook 声称无盲区。
- 旧 clip 画面差异复现并对应主材质不带/带 CLIPPLANE effect 的实际 draw 切换；预编译干预及同编号逐帧原生/回退对照支持受控场景解释，未证明所有场景当帧等价。
- 工厂分层实验识别自定义阴影列表令后两级联失去默认渲染准备复用；保留默认列表的队列替换候选因材质身份和队列条件零覆盖。实际 FPS 未改善，未修改产品代码或场景；细节和证据见 `docs/tasks/2026-10-27-general-rendering-optimization.md`。
