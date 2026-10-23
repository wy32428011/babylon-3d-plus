# P2-R0 计量校准与 B0 基线执行记录

日期：2026-10-22。状态：P2-R0 本地验收完成。计量修正、完整独立构建、8 段 B0、诊断 UI 和只读原生节点辅助核对均已归档；R1～R5 尚未实施，完整设备轨迹仍未验收。原始证据统一位于 `output/project-optimization-p2-r0-20261022/`。

## 验收清单

- [x] 缺失计数器保留null、真实0保留0；报告/HUD/Viewer与固定墙钟、跨窗间隔经过真实RED→GREEN校准。
- [x] 当前源、构建、输入与硬件配置留指纹；2分辨率×4状态各60秒，默认MotionBatching=false且旧钩子仍在。
- [x] 原始完成帧、primary/独立重算、消息窗、阶段trace及预算留存；独立审查无阻断。
- [x] 构建、类型、lint、定向测试/入口分类和Viewer诊断UI检查完成；既有失败单列。
- [x] aux 原生节点核对已实机执行并独立审查；记录非空对象、已有节点真实变化及断流后仍在移动的货物，不混入 8 段 B0。
- 后续验收边界：真实中台冷/暖链路、6 类设备完整轨迹、逐像素画质及真实显存峰值留在 R3/R5，本 R0 不代验。

## 改动与保护

生产改动仅6份diagnostics文件：`ScenePerformanceMonitor.ts`、`FrameTimingWindow.ts`、`editorPerformanceRunSession.ts`、`playerPerformanceDiagnostics.ts`、`ScenePerformanceHud.tsx`、`PlayerApp.tsx`。修复未采样计数器被当0及null格式化异常，增加显式固定墙钟窗口，保留原有报告/生命周期；不改参数脚本、SDK可观测动作语义、MQTT内容、设备频率或画质配置。Monitor6+Frame10+消费者及既有回归18，共34/34通过，RED/GREEN日志在 `metrics/`。

`inventory/final-integrity.json`：入场732份生产源中726份逐字节一致，仅上述6份改变，无新增/缺失/越界改动；public37/37不变。已验收GLB最终版本15份交付源同SHA纳入B0，不回退它们。旧场景、录制、116个资产225,756,283B指纹核对；源与重定位副本分别记录。旧历史摘要无入场前raw SHA的项目只保留现指纹与已知字段校对，不冒称整个旧output字节完全相同。没有处置用户原有 Editor/服务；PID122900 在收尾快照已不存在，不能推断退出来源。只关闭本轮自有进程。

## 冻结与验证

`freeze-manifest.json` 冻结1797源+826构建文件（56,242,137B）；最终独立build成功。首build与源复制重叠已排除、日志保留。SHA256：

- source：`cd41fa20001a3596d679acdb1edb836bdded088c83d7f6a72eedc117269849de`
- bundle：`abd26cb9547aaf15c3c74ad5064c180b253c27b44c9b10540160f1e5d5195e74`
- manifest：`25d7705f1064427df3bd512247dad2a1b7ac6f729e33dd7b87303754ffed5941`
- harness v2：`c32c9dac2dfae0ff13dcadabb6370d30fdf820a1db5adef941ca28cb6287ad87`

2623项逐项复核通过。源/构建可追溯，依赖使用只读共享node_modules解析junction，核对lock、选定package元数据和Node/Electron实际程序，**不是完整依赖离线archive**；两份tsbuildinfo为另记的增量编译缓存。Node22.22.0、Electron42.4.0、Babylon9.12.0、Vite8.0.16；Intel UHD630硬件WebGL2、DPR1、hardwareScalingLevel1，相机/画质/初始模型与环境三角数898984/712491一致。供电方案记录卓越性能，未测温度/实际频率，未清OS文件缓存，不把机器快照当作外部负载完全隔离证明。

typecheck、lint、test:entries91项无缺失、P4分类/质量守卫9/9通过。新增 `test-ci.log` 汇总798 PASS、0 FAIL、1条件SKIP（未提供真实外部EXR）；主任务记录进程exit0。监控器/消费者及最终范围独立审查approved/0阻断。追加observability聚合首项 `smoke-scene-load-diagnostics.mjs` 因Sandbox `fetch failed` 中止，在完整entry前像独立副本复现；不记通过，未改生产或断言压错。

## B0口径与结果

产品原ready门槛120000ms、harness原超时600000ms均不变；8段open→ready为80.036–85.657s。实际运行入口/订阅建立后无回放预热固定10s，窗口外完成预算扫描，再相邻派发原回放0与Renderer固定60s窗口。FPS=窗口(start,end]实际完成帧/真实墙钟60s；主表统一primary nearest-rank分位，包含首尾相邻帧完整间隔。旧 snapshot.fps / legacyEngineFps 保留为引擎兼容估计，不参与正式 FPS 验收；本轮调用显式墙钟 API 并以完成帧数独立重算。

| 状态 | 分辨率 | 完成帧 | FPS | P50/P95/P99 ms | 最大ms |
|---|---:|---:|---:|---|---:|
| 从未连接 | 1440p | 871 | 14.517 | 68.3 / 82.9 / 98.3 | 123.7 |
| 连接零速fixture | 1440p | 436 | 7.267 | 66.5 / 421.0 / 707.1 | 909.5 |
| 原始活动回放 | 1440p | 355 | 5.917 | 68.7 / 518.4 / 798.0 | 886.0 |
| 断流后 | 1440p | 875 | 14.583 | 67.5 / 85.0 / 100.7 | 205.2 |
| 从未连接 | 2160p | 507 | 8.450 | 118.4 / 132.3 / 141.3 | 162.6 |
| 连接零速fixture | 2160p | 300 | 5.000 | 117.3 / 525.5 / 719.6 | 829.0 |
| 原始活动回放 | 2160p | 270 | 4.500 | 117.7 / 536.1 / 801.0 | 923.8 |
| 断流后 | 2160p | 514 | 8.567 | 116.2 / 129.8 / 140.8 | 157.4 |

`baseline-summary.json/.md`独立从两套raw timestamps复算：8/8完成帧及FPS精确一致，observer分位差约≤0.1ms；measurementValid均true。functionalPass只覆盖本次采样/输入/产物/入口/连接，performancePass=null。单条件一次窗口，无重复/置信区间，不能把状态差异解释为某一热路径的已证因果。

| 状态 | 分辨率 | 约1Hz样本数 | CPU ms中位 | Draw/Active中位 | 窗内发布/投递 | 窗内活动投递 |
|---|---:|---:|---:|---|---|---:|
| 从未连接 | 1440p | 58 | 49.33 | 1317 / 1518 | 0 / 0 | 0 |
| 连接零速fixture | 1440p | 52 | 105.81 | 1317 / 1518 | 1133 / 1133 | 0 |
| 原始活动回放 | 1440p | 51 | 128.64 | 1319 / 1527 | 1141 / 1141 | 57 |
| 断流后 | 1440p | 59 | 50.35 | 1319 / 1527 | 0 / 0 | 0 |
| 从未连接 | 2160p | 57 | 55.50 | 1317 / 1518 | 0 / 0 | 0 |
| 连接零速fixture | 2160p | 51 | 119.88 | 1317 / 1518 | 1133 / 1133 | 0 |
| 原始活动回放 | 2160p | 49 | 140.64 | 1319 / 1527 | 1133 / 1133 | 57 |
| 断流后 | 2160p | 57 | 49.59 | 1319 / 1527 | 0 / 0 | 0 |

CPU/Draw/Active为afterRender约1Hz读数中位，CPU来自近期秒级计数器，非逐帧加权分布；GPU不可用=null/N/A。消息用Node/Renderer timeOrigins换算逐条筛选窗内，不使用包含窗后消息的broker总数。活动仅指非零movement/rpm字段。static/motion起点实际派发差分别20.143/65.669ms（1440p）、22.805/35.663ms（2160p），不是精确同时。原始回放15.538s首活动、21.259s首RGV；断流先25s活动前奏，再原2000ms stale+1000ms及缓存签名收敛，不注入假零速/强停。

8段捕获poses均空，physicalPoseVerified=null。零速fixture前后scalar签名有接收时间与null→0初始化变化，不能据此证明全场静止；motion观测到stacker liftOffset等标量变化，不能代替6类真实节点完整轨迹。断流缓存签名连续3次1s观察及窗口前后稳定，结论限定为已有缓存状态。该缺证状态在原 B0 报告中原样保留；下文新增原生节点辅助核对，单独链接，不回填原 8 段。

## 数字预算、UI与历史失败

`r0-resource-budget.json/.md`在candidate前冻结未来准入：JS采样峰值上限为各条件B0×110%，通常728,200,000B，唯1440p活动为686,400,000B；该1Hz峰值只是下界。新增受管buffer全场景≤67,108,864B（64MiB），同条件已知总量cap为B0前后max+该额度：静止108,922,360B、活动108,939,896B、断流108,939,768B；新增纹理额度0B，含义是未来禁止新增，非现有纹理零占用。现有buffer最大快照41,831,032B不是真实峰值，texture/VRAM bytes仍未知。未来需完整分配生命周期计量，不能以释放抵扣新增额度。

R3全链路共享预算：download4、validation2、active packages4、pending268,435,456B、临时盘1,073,741,824B；>256MiB的可信package在全drain后独占、source≤536,870,912B且完整临时盘估计≤1GiB，未知/超限不准入。现有初始化6ms/4hosts及compiler memory64MiB/disk128MiB不改；未验收中台实际并发/磁盘峰值。

Viewer r2 `viewer-ui-l5A4Xo/result.json` PASS：真实非空场景564vertices、UHD630硬件WebGL2自然观测unknown，正式copy/stop控件工作、page/console error与request failure均0。r1的live-binding探针失败及日志保留，未以修改业务消错。此UI证据不等于真实发布/安装版Viewer或动作全验收。

首factory v1在ready91.869s后被“MQTT未启用，无法进入运行预览”门禁拒绝，未产生计时窗口；finally访问已关闭app.process又抛错，原始抛错unknown，stop等待timeout仅推断。截图/日志及失败说明留原目录。v2改为MQTT启用+经验证拒绝连接的loopback9，无broker/消息；缓存自有process、先保存首错、安全清理。v1/v2源快照分开封存，正式重跑使用-r2目录，不覆盖首败。

本轮未执行R1，默认OFF仍有旧observer/钩子成本；无15%运行收益或30%中台收益结果。保留原始证据、保护边界和已有缺口，本执行记录已归档，下一阶段为 R1，尚未执行。

## 原生节点辅助核对与更正

正式 8 段的旧探针只识别 driver state 的直接 Node 属性，得到空 poses。原先把零条姿态变化描述成“姿态相同”不成立，已明确更正；原始结果与缺证标志保持。额外核对采用同一冻结构建、资产和原 ready 门槛，单独运行 2560×1440 实例，没有调用正式 FPS 窗口，不作为第九段 B0。

独立 Broker 先发送原 cadence 的 15 秒零速前缀，再原样从原点播放动作录制，按原录制相对 20/30/45/60 秒名义时点采样，随后关闭 Broker；实际派发和读取延迟留在原始记录。原 payload、主题、顺序和相对时间逐项核对；读取 model.root、已有后代和 native TransformNode 的本地向量与 worldMatrixFromCache，不调用角色 getter、世界矩阵计算、顶点读取、驱动 setter 或 GPU 上传。标量签名单独归档。

| 核对项 | 实测结果与适用范围 |
|---|---|
| 静态前后 | 140 个模型根、3,440 个可比已有节点；本地姿态和缓存世界矩阵变化均为 0。staticEnd 读取稍跨原点进入原录制首段零速期，时钟与报文前后界保留，只证明这些离散快照。 |
| 动作 20/30/45/60 秒 | 各有 33 个已有节点变化，其中 27 个本地姿态变化、32 个缓存世界矩阵变化；新增 16/17 个节点另外列出，不靠新增 cargo 判定已有节点运动。 |
| 堆垛机实物节点示例 | entity_2b9866fc-b095-45b8-8a3c-769742b2bed9 的 huocha.9 本地 y 从 0 到 0.19111017327518542，缓存世界位置也变化；native 单位不额外换算。 |
| 原超时后的追加观察 | 等待原 staleAfterMs=2000，并额外间隔 3 秒观察；3,457 个可比节点中仍有 5 个变化，只有 1 个为本地姿态变化，另 4 个仅有缓存世界矩阵变化，其中 2 个确认是该货物后代，2 个祖先链有缺口，不能统一归因为继承。 |
| 继续移动的对象 | conveyor_cargo_root_1003_cargo 本地 x 从 -10.983186638733182 到 -10.143742561340332；另 4 个节点仅有缓存世界矩阵变化，其中 2 个后代关系已确认，另 2 个关系未证。未发假零速、未强停、未改原动作逻辑，不能报告“全场断流后停止”。 |

aux passed=true 只表示核对输入、非空对象、已有节点实际动作变化和留证/清理通过；postStaleNativePoseUnchanged=false 已保留。缓存世界矩阵可能滞后，本地与缓存变化分别报告；本轮不把离散节点观测外推为 6 类设备的全轨迹、故障/交接等 100% 验收。

- [原生节点结果](../../output/project-optimization-p2-r0-20261022/aux-native-state-check/runs/2026-10-22T10-22-35.571Z-native-state-check/result.json) 与 [变化细单](../../output/project-optimization-p2-r0-20261022/aux-native-state-check/runs/2026-10-22T10-22-35.571Z-native-state-check/native-node-changes.json)。
- [只读探针独立审查](../../output/project-optimization-p2-r0-20261022/inventory/native-state-probe-review.json)，原 8 段 [B0 汇总](../../output/project-optimization-p2-r0-20261022/baseline-summary.md) 不改。

## 复核入口与收尾

- 定向回归：`npm run test:optimization-p2-r0`；登记与漂移：`npm run test:entries`、`node scripts/generate-test-inventory.mjs --check`。
- 重用冻结 B0 示例：`node output/project-optimization-p2-r0-20261022/harness/factory-r0.mjs --build-ready --artifact output/project-optimization-p2-r0-20261022/frozen-app --mode motion --seconds 60 --render-width 2560 --render-height 1440 --output output/project-optimization-p2-r0-20261022/runs/new-unique-run`。必须使用新目录，正式采样仍串行且不并行构建/测试/profile。
- [完整冻结清单](../../output/project-optimization-p2-r0-20261022/freeze-manifest.json)、[B0 JSON](../../output/project-optimization-p2-r0-20261022/baseline-summary.json)、[资源预算](../../output/project-optimization-p2-r0-20261022/r0-resource-budget.md)、[最终完整性](../../output/project-optimization-p2-r0-20261022/inventory/final-integrity.json)、[计量 warning 核对](../../output/project-optimization-p2-r0-20261022/inventory/metrics-warning-check.json)。
- 原 P2 历史负收益、失败、旧完成项及原始输入保持；未提交、推送或外部发布。冻结 app 保持只读，最终文档更新位于共享源码目录，冻结副本仍保留采样时版本。
- 回退依据是 entry 快照及各 diagnostics 前像，只能按当前相关差异定向恢复，不覆盖工作区既有/其他任务修改；本轮没有执行回退。

原生快照独立复算与 CI/aux 后收尾见 [原生节点结果审查](../../output/project-optimization-p2-r0-20261022/inventory/native-state-result-review.json) 与 [最终源/进程结算](../../output/project-optimization-p2-r0-20261022/inventory/final-closeout-source-process.json)。全部 9 个采样/辅助实例 owner PID 已退出，未处置用户或其他任务进程。
