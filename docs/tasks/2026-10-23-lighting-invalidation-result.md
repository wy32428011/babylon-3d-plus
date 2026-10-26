# 光照失效优化结果（2026-10-23）

## 结果与范围

本轮完成原因计数、类型化失效、受控 Mesh 生命周期重复标记合并、重入/异步消费保护及验证。主线程约 450 ms 的全量分类开销仍未解决，没有证据表明获得稳定 FPS 收益。没有推进 P2，没有提交、推送或发布。

工作区源码与独立候选构建的 11 个变更输入 SHA 一致；保留上一轮和其他任务已有改动。所有临时测试应用和 broker 均已正常关闭，只保留诊断目录。

## 修改清单

- `src/runtime/babylon/lightingInvalidation.ts`：默认关闭的有界原因计数；记录请求类别、入口、真实目录获取次数/时间、绑定刷新、重入、未知回退，以及 Mesh 请求合并结果。关闭态不取计时时钟，不扫描模型、不逐事件格式化日志。
- `src/runtime/babylon/SceneLightingRuntime.ts`：提供 `pose / bindings / classification / structure / unknown` 明确合同。pose 不触发目录重收集；bindings 只要求绑定校验；classification 重收集目录；structure 额外保证必要的绑定/代理重建；unknown 保持完整失效。原生运动矩阵、动态探针/阴影更新和静态 GI 失效检查继续执行。
- 同一 runtime 的 `notifyMeshLifecycleChange`：仅当分类和绑定都已 pending、无同步消费/异步快照事务、无激活且 runtime 有效时，合并重复标记。UI 已消费、重入、异步加载/验证/取消仍完整失效。没有跨帧缓存，也不自动把任意脚本归为纯位姿。
- `SceneTriangleAndReadinessController.ts`：原有 Mesh added/removed callback 原位置接入上述入口，保留原生广播、回调顺序、统计更新和派生对象过滤。
- `ModelAssetRuntimeController.ts`、`EnvironmentAndSkyboxController.ts`、`SceneTelemetryController.ts`：为未知模型刷新、环境快照、烘焙准备/捕获和运动批次变化标注稳定原因；未知刷新仍完整执行。
- 增加 `lightingInvalidation.test.ts`、`sceneMeshLightingInvalidation.test.ts`，扩展 `sceneLightingRuntime.test.mjs`；加入既有 `test:lighting-bake` 入口及 manifest。

原 no-op remove 纯度守卫实验已撤出生产：没有低成本的全局纯度证明，脚本宿主会直接降级，在实际工厂没有有效覆盖。原实验源码、失败记录和 18 项实验测试结果留在 `output/lighting-invalidation-20261023/noop-remove-experiment/`。`ModelArrayRuntimeController.ts` 与本轮冻结基线逐字一致；原生 add/remove 调用未被替换。

## 最多三次实机对照

实际使用 3/3 次，顺序为 A/B/A：冻结基线、候选、冻结基线复测。均使用同一完整本地工厂、原录制 t0、同消息文件和时间序列、同固定近景、2560×1440、Intel UHD 630 硬件 WebGL、同采样工具和 60 秒窗口。每次资源加载后确认 Blender 空闲并热身；窗口内无本任务测试或构建并行。没有启动 CPU profiler，避免混入额外诊断开销。

| 指标 | 基线 A1 | 候选 B | 基线 A2 复测 |
| --- | ---: | ---: | ---: |
| 60 秒完成帧 | 328 | 344 | 367 |
| 有效 FPS | 5.47 | 5.73 | 6.12 |
| 帧时间 P95 | 515.2 ms | 482.4 ms | 477.0 ms |
| 帧时间 P99 | 860.4 ms | 811.1 ms | 777.5 ms |
| 最长帧 | 958.5 ms | 918.3 ms | 819.8 ms |
| 长任务累计时长 | 54.737 s | 54.924 s | 54.572 s |
| 完整目录 `getSources` 次数 | 94 | 95 | 91 |
| 完整目录同步累计耗时 | 32.249 s | 31.325 s | 29.615 s |
| 最长单次完整目录获取 | 417.0 ms | 469.9 ms | 535.6 ms |

表中均为正式 renderer 窗口指标，未混用源 t0 重裁窗口。源原点重裁及消息排队/延迟保存在各 `input-audit.json`；三轮输入审计全部通过，镜头/画质/消息文件/工具 SHA 均一致。实际 renderer 调度仍受卡顿影响，原始更新频率配置没有改变。嵌套的 refreshBindings、refreshSources、getSources 耗时不能相加。

候选 FPS 处于两次基线的 5.47～6.12 范围内；长任务总时长基本不变，故不能将 A1→B 的单次差异宣称为稳定优化收益。

## 失效原因与已确认收益

三轮共同失效请求均为 4,157 次。候选分解为：

- 66 次 `model-meshes-refresh-unknown`，保持完整失效。
- 2,040 次 `scene-mesh-removed`，发生在阵列宿主 suspend scope。
- 2,051 次 `scene-mesh-added`。这些延后通知没有同步 producer scope，不把它们全部猜作某一次临时恢复。
- 4,091 次 Mesh 请求中，4,047 次重复标记被合并，44 次保持 full；加上 66 次未知模型刷新，共 110 次推进分类/绑定失效代次。

减少的是重复 mark/revision 工作，原生事件请求数没有减少。基线的 dirty 布尔状态本来已合并大量请求，所以实际完整目录次数没有下降。候选 95 次完整目录中，58 次由帧内消费、37 次由 UI 分类查询消费；UI 的 400 ms 定时检查未变。

仅位置变化本身不要求全量分类。现有设备 driver 的逐帧 position/矩阵更新继续原路径；当遥测上下文变化触发脚本时，脚本可能同时改变名称、父子关系、显隐、材质、Geometry、骨骼、其他模型或分类输入。当前 `refreshModelMeshes` 无法证明它只改位姿，因此仍 full。restore/suspend 的真实事件和延后 add 会在不同消费点再次置 dirty，这是本轮尚未减少的工作。

## 验证

- consumer：57/57；原因诊断：5/5；readiness/controller 联接：7/7；关联分类/源缓存/薄实例/阴影：66/66；合计 135 项通过。
- RED 证明新行为在修改前缺失；未知 provider、脚本和 entry getter 的前后对照调用次数一致。重入、UI 消费不吞绑定、异步取消后仍在 await、结构替换及静态 GI 失效均有覆盖。
- 独立只读审查无阻塞项；定向 ESLint 通过。
- 独立候选 `npm run build` exit 0，包含 TypeScript/Electron、Editor 与 Viewer 构建；1694 输入和 852 构建产物已冻结，三次实机后均未漂移。
- 硬件 WebGL 功能 fixture 实际实例化两版 `SceneLightingRuntime` 和 readiness，经过真实 collect、6 个姿态/事件阶段：像素差 0，完整分类、目录获取次数、脚本配置/角色读取次数、广播顺序和 drawcalls 一致。可见运动改变 7,810 像素，阴影开关改变 630 像素，证明不是空画面或关闭阴影的对照。此项不测 FPS、不重放工厂，不占三次实机场景采样。
- 测试入口审计 96 项保留、0 缺失；`git diff --check` 通过。此前 `p4TestInventory` 硬编码清单数量的失败保留，未扩范围修改。

## 未解决问题和验证边界

1. 全量分类仍每次数百毫秒，60 秒内约 30～32 秒同步时间，主要卡顿未消除。本轮未启用跨帧分类缓存，也未推进 P2。
2. 任意脚本的纯位姿自动识别，以及真实宿主临时 add/remove 的完整隔离，尚未实现。后续必须先取得可信的变更范围和异步事件归属；没有证据的情况继续 full，不能用只比较当前模型 Mesh 引用或位置来跳过全局分类。
3. 本地工厂替代原展会场景，GPU 为 Intel UHD 630；结果不代表原 RTX 5060 展会现场。工厂没有已应用的 baked GI 结果；实际 GI 快照路径有专项运行时测试，本轮硬件画面对照不等于现场烘焙 GI 验收。
4. 使用录制 MQTT 回放，已验证原始输入与调度入口未改；没有宣称完成现场 broker、全部外部脚本或发布版 Viewer 的现场验收。

完整证据：`output/lighting-invalidation-20261023/final-verification.json`、`comparison.json`、三份 `result.json`/`input-audit.json`、`independent-review.json`、`candidate-manifest.json`、`visual/run-01/result.json`。采样额度已用尽，不再追加。
