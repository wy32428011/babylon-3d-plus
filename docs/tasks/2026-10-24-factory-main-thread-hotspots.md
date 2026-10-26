# 工厂剩余主线程热点与严格等价优化方案

日期：2026-10-24。状态：分析交付，未实施产品优化，未进入 Q2。

## 目标、约束和本轮验收

用户要求针对 getSources 约 282ms、FPS 约 6.8 分析剩余主线程热点，提出实际收益可验的优化方案；画质、脚本和 MQTT 行为不变，已关闭候选不重启。此前用户批准的工厂 Viewer 延期保持有效。

- [x] 使用当前冻结 Q1 组合及现有工厂、原 MQTT 录制定位，避免引用旧候选作为当前版本。
- [x] 区分无 Profiler 正式 ABBA、当前 CPU 诊断和独立 GC 跟踪；明确包含关系、时间范围和证据边界。
- [x] 定位 collector 内部、collector 外渲染、业务脚本回调及 GC；核对源码与交付包身份。
- [x] 给出新候选的具体边界、语义风险、验证顺序和停止条件；未知收益不记为已实现收益。
- [x] 产品、原场景/资产/脚本和录制不变；专属诊断应用和 Broker 已关闭；未改变 heap 参数。
- [x] 独立复算 CPU 分类和 GC 区间，诊断代码按 code-reviewer 复核。
- [ ] 实施候选及证明新增收益：本轮为“先分析”，未实施、未验收。

## 结论

当前仍是多个大头叠加：完整来源收集、相机渲染、LED 自带逐帧回调。没有证据表明 HUD、框架 onUpdate 或 MQTT 分发是当前主要瓶颈。全量观察、同帧失效和脚本可观察行为限制了通过缓存、降频、合并和复用省掉工作的空间。

**本轮没有找到已证实可显著提帧的新实现。** 可以进入有界验证的新路线是“未使用私有原生空 Set 延迟分配”和“精确字节比较内核展开”，但收益上界有限，必须独立计时；不能据此承诺 getSources 大幅下降或 FPS 从 6.8 达到 20/30。

建议下一步先拆清当前 create 的大块 self 成本，再逐个验证这两个小候选。相机渲染继续作为有证据的第二调查对象；LED 热点如实保留，不通过更改外置脚本、降低刷新率或新缓存协议兑现收益。

## 版本和测量口径

正式性能沿用已交付的 `output/render-optimization-q1-factory-20261024/comparison.json`：A 是含用户批准 L2 的 accepted Q0；B 是 final Q1 build5。B 的正式均值为 FPS **6.816667**、P50 **80.55ms**、P95 **415.10ms**、P99 **469.60ms**，getSources **91 次/60s、25,729.15ms inclusive、282.737912ms/次**。A FPS 6.858333；组合新增 steady 收益未复现。

282.7ms 是每次收集的平均耗时，不能当作每帧固定成本。getSources 计时含内部准备及嵌套调用，不能与渲染计时直接相加为 CPU 利用率。

本轮在同一冻结 B 上分别运行一次 CPU profile 和一次 GC trace。保持 Intel UHD 630 / ANGLE D3D11 / WebGL2、2560×1440 buffer、DPR 1、原保存相机、370 实体、116 资源及原录制。原工厂 bake.enabled=true、result=null，没有已应用 GI；原资产未发现 KTX2/basisu。本轮不把未触发的 GI/纹理解码优化计入运动窗口收益。

CPU 原始包络 62,499.354ms，41,362 个样本的 timeDeltas 总权重 **62,498.954ms**，未分配尾部 0.4ms。表格按整份诊断包络归属，含启停及 finish 等窗外工作，没有严格裁切为 60 秒。诊断 FPS 6.9833 不作生产性能或 A/B 收益依据。

GC 另一次运行的主线程可见事件跨度 **60,955.035ms**；该次 FPS 同样不用于比较。两个运行的时间不能相加或拼接成 before/after。

当前 bundle `index-DHRc4psc.js` SHA256：`a457586607aecc693f01365d26242bc48098c7911b51c682c7444aaf8d0f95e6`；冻结 manifest SHA256：`cb832065d5fef6ace79667f2f5aacbdfb6db8d05fca9de5b05bd49305d452436`。14 份相关当前产品源码最终与冻结 manifest 完全一致。两次运行都记录原场景/录制/资产/交付输入前后不变。

## 当前主线程热点

每个 CPU 样本只归入下列一个分类，合计恰好回到总权重；相同函数的递归 inclusive 每样本只计一次。占比是采样时间归属，包含 idle 和未归属部分，不是主线程忙碌率或可移除比例。

| 分类 | 采样归属 | 占总权重 | 业务含义 |
|---|---:|---:|---|
| getSources | 22.980s | 36.77% | provider 准备、完整 collector、分类与身份检查 |
| camera / render | 16.496s | 26.39% | 活跃 mesh、世界矩阵、mesh/submesh、PBR 绑定与绘制提交 |
| LED 独立 beforeRender observer | 5.086s | 8.14% | 脚本内节点扫描、长度/矩阵计算、滚动与绘制 |
| refreshSources，排除 getSources | 2.330s | 3.73% | key 校验、entry 复制、实体索引与原子替换 |
| lighting bindings，排除 refreshSources | 1.100s | 1.76% | 阴影角色等后续绑定维护 |
| telemetry frame | 1.385s | 2.22% | 应用设备遥测与原驱动路径 |
| motion arrows | 0.625s | 1.00% | 原运动方向与箭头维护 |
| monitor.sample | 0.116s | 0.19% | 性能采样 |
| GC | 2.949s | 4.72% | CPU profile 内 GC 样本，不归因给单一分配点 |
| idle | 5.001s | 8.00% | 空闲样本 |
| program / 其他 | 4.433s | 7.09% | 未精细归属及其他调用 |

### getSources 内部

实际路径：`SceneLightingRuntime.refreshSources:483` → `EnvironmentAndSkyboxController.getSources:415` → `collectLightingRuntimeSources:425` → `create:479` → raw 身份/路径/动态脚本观察与 `resolveNormalizedPolicy`。

| 当前函数 | inclusive | self | 解释 |
|---|---:|---:|---|
| collector / Rge | 21.020s | 1.689s | 包含下面 create，不能相加 |
| 每来源 create / T | 18.075s | 7.917s | 最大剩余自身成本，尚不能仅凭 function 采样分摊到具体语句 |
| readLightingNodeKey / Yhe | 2.000s | 1.909s | 完整祖先路径和同名兄弟观察 |
| under / LH | 1.248s | 1.150s | 动态 ancestry 判断 |
| resolveNormalizedPolicy / une | 2.274s | 1.069s | 动态规则、字段与集合，不等于可省预算 |
| dataUnchanged / HH | 1.039s | 1.031s | 原始数据精确比较，包含准备和非内核路径 |
| clonePolicyInitialState / cne | 0.304s | — | 已有固定字段复制，非当前优先项 |

当前函数映射核对到冻结 bundle 和对应源码。历史非压缩行级采样属于较早版本，只可提示方向；不能用其中“某条 spread 占比”作为当前版本的语句级测量。

create 每来源仍需读取 motion/animation/脚本配置、祖先和 policyContext；完整路径及 raw 几何检查是已批准 L2 失效可靠性的组成部分。scene.meshes.includes 虽有重复遍历，但整轮 Set 会改变同轮目录观察时点。refreshSources 的复制、重复 key 拒绝、索引顺序和 revision 防重入也不能只按静态结果相等省略。

### collector 外的渲染与 LED

camera/render 中 `_evaluateActiveMeshes` self 1.812s、mesh.render self 1.588s、PBR.bindForSubMesh self 1.039s；真实工厂约 1317–1320 draw calls、1518–1528 active meshes、46 animations。它们证明渲染调用栈预算存在，未证明可以在当前合同下直接裁掉；CPU 采样不能分离原生 GL 等待与 GPU 执行，本轮没有独立 GPU 时间测量。保持材质、阴影、图层、透明顺序、动画、可见性、拾取及公开 Babylon API。

LED 的 `getModelNodes:1216` 在外置 `led.model.ts` 内部，逐次展开 `scene.transformNodes/scene.meshes` 并调用 isDescendantOf；`getScreenLengthMeters:1338`、`getMeterSpaceMatrices:1021` 接续矩阵/长度工作，`advanceScroll:1418` 和 `paintLedScreen:1433` 由独立 beforeRender 驱动。不能把它算入框架 onUpdate；宿主新增 getModelNodes 索引也不会自动替换脚本私有函数。节点/尺寸缓存、停绘和降频尚无严格等价依据，因此不列为可直接实施项。

框架 updateRuntimeContext inclusive 51.975ms（0.083%）、array runtime 刷新 37.087ms（0.059%）、monitor.sample 115.708ms（0.185%）。UBO updateUniform inclusive 322.748ms（约 0.52%），不支持围绕它宣称明显提帧，更不应为此改全局矩阵比较语义。

### GC 独立跟踪

唯一 CrRendererMain 上，完整 X 型 GC 事件区间取并集 **2,851.967ms / 60,955.035ms = 4.679%**；不重复相加嵌套 scavenger、marking 或后台 worker。

- MinorGC：516 次，并集 2,486.711ms，P50 4.455ms、P95 8.053ms、最大 13.562ms。
- MajorGC：3 次，并集 69.271ms，最大 24.402ms。
- 增量 marking 210 次，247.887ms；上述 GC 全并集另含启动与辅助区间。

这支持“小对象分配压力确实存在”，不足以把约 415ms P95 主要归因于 GC，或把全局 GC 都归到 claimed Set。MinorGC 的 allocation failure 是事件原因，不等于应用 OOM 或内存泄漏。当前不推荐以扩大 heap、强制 GC 或改启动参数作为已验证解决方案。

跟踪未观察到 data-loss/overflow 标记，但 harness 未保存 tracingComplete 完成元数据，因此不声明 loss-free。harness 的结束事件/IO 读取缺少有界超时是诊断工具健壮性缺口；当前已正常结束，若将来复用，应先补齐该边界及完成元数据保存。

## 推荐的后续顺序

### A. 先拆清当前 create 的 self，避免再押错位置

这是下一步诊断，不是已实现优化。针对当前 B 的 7.917s self，保留可对应源码的行列信息，分别观察对象/字段构建、集合构建、路径调用和 provider 目录准备；必要时用独立诊断构建做行级采样或短分配采样。诊断构建和采样开销不计入正式收益，不更改生产配置。

只推进能够明确证明“私有未暴露计算/分配减少、完整观察和结果不变”的新点。不要将减少 getter/iterator/未知或有可观察副作用的构造器/Matrix 调用、重排读取或提前目录快照包装为纯内核优化。若热点仍落在必须保留的观察上，报告剩余预算，停止这一方向。

### B. 小候选：claimed 私有原生无参 Set 惰性分配

位置：`electron/shared/sceneLightingPolicy.ts:304-326`。空 rules 时这只 Set 未使用；nodeClaimed 本就在 rules loop 内，不多算一只；preserved 及 motion/fixed/animationTargets 不动。

在原构造点读取并保存 global Set；仅能证明与可信启动阶段 NativeSet 引用相同时延迟，未知/Proxy/子类/不可构造值保持原点 eager 构造与异常。首次使用前使用保存的构造器建 fresh 实例，has/add 保持动态 lookup、receiver、参数和顺序。不得读 rules.length 跳过 iterator，不复用已使用实例。可信捕获前提不能建立即放弃。

这与已停止的 Set 共享路线不同，但只可能省 une 的一小部分。1.069s self、2.274s inclusive 和全部 GC 都不能当成它的预期收益；新增分支也可能更慢。本轮未实现、未测收益。

### C. 小候选：精确字节比较内核展开

位置：`lightingClassificationRuntime.ts:150-168`；另一个 signature cache 内核只能独立评估，不捆绑修改。试 4/8 word 展开，仍以 a[i]→b[i]→比较的原顺序逐字读取，首次差异立即退出，保留所有 raw 扫描、类型/视图构造、余 word 和尾 byte，普通 array/Object.is 路径不变。异常构造器、Proxy 数值读取及异常边界必须对照；不能靠 XOR 汇总预读后续值。异常 length 情形保留旧循环。

整个 HH 仅 1.039s（约总采样 1.66%），比较内核只是其中部分。即使内核有明显相对加速，整厂收益也可能很小；不承诺 FPS。它优先级低于 A，最多作为小范围独立实验。

### D. 相机渲染的下一层调查

若 A/B/C 没有可复现收益，后续仅沿当前 26.39% 的实际堆栈继续做渲染 CPU 定位：区分 active mesh 评估、matrix 同步、材质绑定和原生 GL 提交，记录每帧/每类 mesh 的成本。只有发现可保留完整调用和公开行为的私有纯计算点，才形成新候选。

本轮没有可直接交付的 render 改动，不以全局 freeze、merge/LOD、改变透明排序、压缩画质、减少阴影/Glow 或抑制脚本 observer 来替代。该调查属于当前工厂残余热点分析的延续，不代表进入 Q2。

## 每个未来候选的验收门槛

1. 冻结当前 B 为行为 oracle。先建立错误变体会失败的语义对照，覆盖 entries 全字段/存在性/顺序/身份/roles/world 闭包、同帧失效；覆盖动态 getter、iterator、Proxy、构造器、has/add、回调重入和异常对象/顺序。raw 首中末变化、尾 byte、祖先/同名兄弟、无事件变更及 Matrix seed/tracking 继续覆盖。
2. 再做真实完整 collector 交错 A/B 计时，包含 provider、wrapper、collector 全链。fingerprint、行为 trace 和 profile 放在计时外；不以微基准、分配数或命中率替代净耗时。逐候选独立，原有失败不得覆盖。
3. 只有完整 collector 收益超出同臂重复波动、重复同向，才进入无 Profiler、同条件、独占硬件的 60 秒 ABBA。方案建议效果目标为 getSources 至少下降 5%（约 14ms/次）；这是筛选目标，不是收益预测。未达目标如实记小收益，不宣称解决长帧。
4. 正式同时核 FPS、P50/P95/P99、getSources 每次/累计/次数、长任务、draw/active；将模型和 MQTT 的 source-t0 对齐，核数量/顺序/缺口/重复/pending 与原驱动行为。固定姿态、确定性 LED/时间条件比较画质，不靠掩膜放宽验收。
5. 行为任何实质差异即否决。同一候选连续两次无可复现完整净收益即停止；不通过削弱 guard、改名或第三变体继续消耗。只有通过全部要求才并入组合版本，之后组合 ABBA，不累加分项百分比。

以上属于后续方案，本轮没有运行候选、完整 collector 候选计时或新 ABBA；没有新增收益结论。当前 profile/trace 仅能证明定位，不建立新业务一致性或现场验收。

## 保持关闭的路线

- same-pass policy/source memo、F1/F2 row 物化、旧 descriptor 审计及两轮负收益路线。
- descriptor-only instance 枚举：改变 Matrix 构造与全局 seed/tracking，已有否决证据。
- moving/fixed/animationTargets 共享、路径/兄弟目录缓存、scene.meshes 整轮 Set 等已判定会改变观察的方案。
- L3/L4/L5/L6 原冲突路线、L8/L9 原灯光/Glow 路线；按用户严格等价决定保留原实现。
- LD5/LD6 保持 off；B2 图集缩批负收益路线保持撤回。
- 不 coalesce/drop MQTT、不改频率/顺序、不停业务脚本/箭头/LED，不进入 Q2。

## 可复核证据

- 正式性能及业务：[原工厂 Q1 验收报告](2026-10-24-factory-q1-acceptance-report.md)。
- 当前 CPU 原始数据：`output/render-optimization-factory-hotspots-20261024/current-profile-1/{motion.cpuprofile,result.json}`。
- CPU 互斥复算与源码映射：`output/render-optimization-factory-hotspots-20261024/analysis/cpu/independent-cpu-audit.{json,md}`。
- Collector 语义边界和新候选：`output/render-optimization-factory-hotspots-20261024/analysis/collector/collector-analysis.{json,md}`。
- GC 原始 trace / 复算：`output/render-optimization-factory-hotspots-20261024/gc-trace-1/gc-trace.json`、`gc-analysis.json`、`analyze-gc.mjs`。
- 产品源码最终身份：`output/render-optimization-factory-hotspots-20261024/final-source-integrity.json`，14/14 一致。

两次诊断均 passed=true，artifact/sourceScene/sourceReplay/harness 与 source workspace 输入无漂移、assetChanges=[]。专属 app 与 Broker 正常关闭，最终按精确本任务目录查询进程为 0；没有全局 kill、提交、推送或外部部署。

独立审查确认互斥分类可回总权重、11 份映射源码与冻结包一致；GC 使用另一种区间合并算法复算相同，诊断分析代码无阻断问题。主报告经 collector 语义边界审查，无关闭路线重启或收益夸大；非阻断的构造器措辞已限定为未知/可观察副作用场景。
