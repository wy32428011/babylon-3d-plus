# 全项目渲染、光照、烘焙与加载优化实施记录

日期：2026-10-24。依据：`docs/全项目渲染光照烘焙加载优化方案.md`。

## 目标与边界

按照方案的阶段依赖推进，先实施 Q0；Q0 的实现、回归与真实场景度量满足后，再进入 Q1。Q2、增强档和档位 B 保留各自的前置条件；B3 默认设备、LD3 就绪契约等需产品决策的项不擅自改默认值。整份方案尚未完成，以下分别记录实现与验收。

主路线保持画面、几何、资源身份、WebGL2/抗锯齿/stencil/GlowLayer/描边、DPR、模型脚本、设备算法和 MQTT 消费顺序与频率；不修改场景格式和 SOURCE/DIST 安全边界。不提交、推送、发布或生成安装包。初始工作区只有用户提供的方案文档未跟踪。

## 验收清单

| 项目 | 实现目标 | 检查与证据 | 状态 |
| --- | --- | --- | --- |
| L1 | 管理器关闭时 UI 不触发完整分类；打开立即刷新；Inspector 按选中实体读取缓存并标记过期 | hook/缓存及真实UI通过；关闭60.22秒UI收集0；工厂两轮UI收集均0 | 已实现、验收通过（本地范围） |
| L2 | 用户批准安全替代：保留全部观察/失效，实测分类耗时下降且行为一致 | 新policyContext构造ABBA累计-10.63%、每次-14.10%；9项语义回归、6姿态RGBA零差异 | 本地验收通过；旧负收益候选仍撤回 |
| B1 | 像素处理向量化；编码后差异不超过 1 LSB，记录统计 | 最终交付脚本1024²、4,194,304分量float/PNG差0；NaN/Inf兼容；真实Cycles集成通过 | 已实现、验收通过（CPU） |
| B2-探针 | CPU1024²批次、原瓦片/法线顺序；GPU显存自适应与缩批 | 最终CPU图集/探针差0；11条故障注入与统一Cycles通过；真实GPU用户同意暂缓 | 本地实现/回归通过；真实独显未验证 |
| LD8 | 并发上限 4，SHA/解码全成功后原子返回，失败/取消等待并释放所有任务 | 13项单元通过；硬件RGBA/flipY/context restore一致；40个Bitmap全部释放 | 已实现、验收通过（合成图集） |
| S1 | 静态阴影签名用数值/引用快照；保留同帧矩阵修正、透明裁剪和动态纹理语义 | 差分回归；2000网格微基准-36.41%；72次硬件阴影像素比较0差异 | 已实现、验收通过（限定范围） |
| 工程 | 交付脚本与源码一致，相关既有回归、类型/构建及入口检查通过 | 最终build/typecheck/lint/入口审计、相关回归通过；test:ci的2项旧失败已在HEAD复现 | 本轮相关检查通过；全局CI未绿 |
| Q0 阶段门槛 | 固定工厂、相机、分辨率、原录制 MQTT，ABBA 对照，采样无并行构建/测试 | 新L2独立ABBA审计112项通过；其余相关Q0检查通过；GPU硬件用户同意暂缓 | Q0本地通过，进入Q1；全局CI既有失败单列 |

## 后续阶段

- Q1：L3/L4（先影子模式）/L5/L6/L8/L9、B2-图集/B3/B6/B7、LD1/LD5/LD6/LD7、R1。Q0本地门槛已通过，开始逐项核对及实现；L4主路径仍依赖真实工厂30分钟零差异，其他项保持各自验收。
- Q2、档位 B、P3：按原方案逐项立项与验收，默认画质不变；尚未实施。
- 同一项连续两次无可复现收益则停止并保留原实现。构建或单元测试通过不能代替阶段性能门槛。

## 恢复点

- 基线：`output/render-optimization-20261024/baseline-app` 为本任务初始 HEAD 的独立源码快照，依赖链接现有 `node_modules`，记录见 `baseline-ref.json`。
- 独立模块记录：同日 `render-optimization-bake-q0`、`render-optimization-resources-q0`、`render-optimization-shadow-q0` 文档。

## L2 实施中止依据

独立审查在已登记宿主的成员缺席基线后，直接修改 positions/indices 原始返回数组，以及修改宿主祖先名称；三例都没有几何事件，候选净成员判断却仍返回 unchanged。现有完整 collect 通过原始数组比较与完整节点路径可发现这些变化。方案“几何/材质事件必能覆盖实质变化”的前提因此不成立。

已撤回 L2 全部产品改动，ModelAssetRuntimeController、SceneTriangleAndReadinessController 与任务初始 HEAD 一致，notifyMeshLifecycleChange 保持原实现。完整分类行为优先；禁止以只检查 Geometry/Material 引用和宿主自身 name/parent 作为跳过依据。复现及审查：output/render-optimization-20261024/l1-l2-review.json。Q0 整体尚未通过，Q1 不进入。

## 工厂 ABBA 实测

工厂370实体、116资源共225,756,283 bytes，Intel UHD630/ANGLE D3D11/WebGL2，2560×1440，同一近景相机、原MQTT录制t0、60秒固定墙钟；采样期间无本任务并行构建、测试或Blender烘焙。顺序A1/B1/B2/A2，四轮passed=true，场景/回放/工具及各自产物SHA前后均未漂移。数字为两轮均值（两样本中位数相同）；长任务按与60秒窗口的交集裁切。

| 指标 | 基线A均值 | 候选B均值 | 变化 |
| --- | ---: | ---: | ---: |
| 有效FPS | 5.6917 | 6.2500 | +9.81% |
| P50帧间隔 | 79.75ms | 80.45ms | +0.88% |
| P95帧间隔 | 490.55ms | 463.45ms | -5.52% |
| P99帧间隔 | 769.30ms | 511.25ms | -33.54% |
| 长任务累计 | 54.476s | 53.654s | -1.51% |
| 实际完整getSources | 96 | 88.5 | -7.81% |
| 完整分类同步累计 | 31.836s | 28.594s | -10.19% |
| UI触发的完整分类 | 34.5 | 0 | -100% |

逐轮FPS为5.65/6.1667/6.3333/5.7333。四轮unknown refreshModelMeshes均66次，未降低脚本/MQTT频率。UI移除主动消费后部分失效改由帧内消费，所以总collect没有减少34.5次。分类耗时是getSources入口inclusive计时，包含来源列表准备及其子collect，可能保留跨窗口末尾的同步尾部；不能当作独占纯CPU耗时，也不能与嵌套计时相加。长任务累计仍接近54秒，主要卡顿未解决；不据此宣称全项目或现场稳定FPS改善。

输入文件与发送配置相同；正式计量采用从原录制t0启动的60秒renderer窗，renderer相对回放原点偏移A1/B1/B2/A2分别为3.254/46.273/34.055/72.518ms。源t0对齐后每轮publication/delivery/callback均1151条，顺序完整、无重复/缺口且pending0。正式窗口的计数会受偏移影响，B1正式窗尾有6条已投递但尚待callback，不能称为丢失或宣称正式窗尾全部消费；源对齐B1/B2比正式窗各多1帧。上表始终使用原正式renderer窗口，不混用源对齐FPS。

对照文件：output/render-optimization-20261024/comparison.json；逐轮runs/*/result.json和mqtt-raw.json；输入后处理与独立审计见同目录input-audit.json、comparison-review.json。四个专属app与broker均正常关闭，诊断工程/userData保留。

## 分项证据与边界

- L1：ui/l1-ui-result.json。真实层级选择切换、待刷新提示、开关管理器及错误诊断更新通过，pageerror/consoleErrors为空。dirty/错误由测试夹具注入，不代替真实故障诊断。
- B1/B2：output/render-optimization-bake-q0。最终fmax脚本兼容旧NaN归零和正Inf报错，有限图集float与PNG差0。4096探针CPU旧/组合两轮12.325→8.585s、15.583→8.350s；maxAbs0.02000027、归一化RMS0.119149%，满足预设≤0.03和≤2%。4096性能证据来自fmax修复前的有限等价实现，最终脚本另复核有限/非有限像素与真实小图集；不把不同源码SHA混作完全同一轮。
- LD8：output/playwright/lighting-resources-q0/result.json。真实WebGL合成8图集、每HTTP固定100ms延迟，串行image中位1223.8ms、默认4并发Bitmap425.7ms（-65.2%）。仅支持该队列/网络夹具；不是实际业务GI加载或线上Viewer验收。
- S1：output/render-optimization/s1-static-signatures-benchmark.json。2000静态网格、7轮交错对照，无覆盖率插桩时11.3400→7.2107ms/帧（-36.41%）；只代表NullEngine状态refresh成本。真实硬件默认56次与alpha/opaque补充16次阴影比较均0像素差，静态命中与DynamicTexture逐帧刷新保留。
- 工厂未应用GI，不能从工厂FPS推断GI加载、代理Draw Call或显存改善。GPU帧时不可用时保持null。未进行展会RTX5060、现场MQTT、已安装软件、线上Viewer或独立显卡Cycles验收。

## 首批五项工程验证（续作前）

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| npm run build / typecheck / lint | exit0，包含最终TypeScript、Editor、Viewer | candidate-build-final.log / typecheck.log / lint.log |
| npm run test:lighting-bake | 215/215 | test-lighting-bake-final.log |
| npm run test:lighting-manager | 78/78 | test-lighting-manager.log |
| npm run test:lighting-optimization | 80/80，含真实PNG清单，无skip | test-lighting-optimization-final.log |
| npm run test:lighting-unified | 42/42 | test-lighting-unified.log |
| npm run test:optimization-p2 | 201通过，1个可选基准skip；该基准另已测量 | test-optimization-p2.log |
| npm run test:entries | exit0 | test-entries.log |
| 最终build后node tests/lightingBake/cycles.integration.mjs | exit0，实际交付Python、UV、探针、取消/超时、资源保存校验 | cycles-integration.log |
| smoke:baked-lighting-material / smoke:hybrid-shadows | 真实硬件WebGL通过 | baked-material-smoke.log / S1子任务记录 |
| npm run test:ci | 708通过、2失败、1skip；2项同样在初始HEAD复现 | test-ci.log / preexisting-ci-failures.json |
| 最终源码/交付脚本与采样候选 | 1008产品输入字节SHA一致；2个撤回文件恢复初始CRLF，规范化内容与采样候选一致；Python两份SHA相同；diff-check通过 | final-integrity.json |

两项既有CI失败为playerAutoPatrolStartup.test.ts:7和playerStatusOverlayControls.test.ts:122，对应Viewer开场契约。根/HEAD/独立baseline相关源码与测试规范化SHA一致，未扩范围修改。首轮并发回归中旧PNG测试假设只允许一次读取，已按新并发契约分别验证并发1/4时最多初始批次读取、失败后不派发下一批且零纹理创建；最终80项全通过，保留原失败日志。

最终Python SHA256：c88604c0d3290a535cefaa3b971a81c6e4512f86fed03d185c283dd198876c20。未提交、推送、发布、生成安装包或更改用户默认画质。

## 首批交付时的缺口（续作前）

1. 整份方案未完成，Q0也未完整完成：L2已撤回；B2的GPU显存自适应/缩批重试未做，当前仅既有整任务CPU回退。
2. L2需要先建立可信的几何及完整节点路径写入版本协议，覆盖原始positions/indices原地写入和祖先/同名兄弟变化；在此之前保留原完整收集，不能重新启用只比较引用的快路径。
3. Q1/Q2/增强档/档位B/P3均未实施。Q1进入前仍须满足原方案阶段门槛，L4亦须独立影子模式30分钟零差异。B3默认设备、LD3就绪契约保留待决策状态。

## 续作启动：L2可靠失效与B2 GPU（2026-10-24）

用户要求继续完成剩余项，先解决L2可靠失效、补B2 GPU自适应/缩批，再完成Q0后推进Q1；原画质/脚本/MQTT契约继续有效。保留上轮所有未提交改动。当前续作尚在实施，不能把上方历史最终记录视为本次验收。

- L2第一候选：同collector pass观察输入并memo纯policy，不增加脚本回调。helper逻辑11项通过，但两轮完整row微测为显著负收益（400行1.044→13.707ms、2000行3.542→73.082ms），按停止规则不以该候选默认发布；候选已完整移出产品，保存在rejected-same-pass-memo目录；保持原完整失效路径。证据在l2-design-review.md及output/render-optimization-l2-20261024。
- B2 GPU软件实现及CPU回归已由限定任务完成，root尚待独立审查、入口登记及组合验收。真实Blender只有CPU；GPU恢复路径为明确标注的失败注入，未宣称真实独显验证。
- 下一步：定位保留五项版本的实际分类CPU热点，采用能覆盖raw数组/完整nodeKey且有可复现收益的L2路径；保留unknown等full边界。Q0仍未通过，Q1不提前激活。

### 续作本地检查与诊断（尚非Q0通过）

- 用户确认暂时没有真实独显环境，先完成本地实现与回归；本轮GPU硬件恢复/峰值留作明确未验证项。B2最终脚本源/交付SHA为2810faf1ceef84543da3d64dac8ee830e2f7e9a3803bd22c44e0b22213390a51，11条注入路径和旧marker合同通过；CPU图集4,194,304分量、探针73,728值均差0。共享Cycles入口已登记新增GPU检查。
- 保留五项版本CPU profile：collector inclusive25.060s/62.478s，最终create自耗10.868s（混合来源准备与row构造，不能全部归因spread），policy3.013s、完整nodeKey2.733s；canonical hash没有样本，不据此继续优化hash。profile仅用于归因，不作为FPS对照。
- 新候选仅替换最终source/entry构造；完整raw几何、节点路径、策略/脚本观察及unknown失效均保留。独立审查无当前P1/P2；10项新回归通过。新helper包括4个私有settings字段的完整key/descriptor核对，未来扩字段、symbol、重排或访问器走原spread分支。
- 新候选构造微测7轮交错：400行0.8216→0.3989ms、2000行4.1317→2.1736ms、10000行22.9221→14.1039ms。仅构造成本，不能称作完整collector、FPS或L2抵消达标。实际工厂与画面验证待完成。
- 本轮最终build和lint通过；test:lighting-bake为225通过，新增helper最终独立10项通过。冻结产品输入见output/render-optimization-l2-20261024/candidate-manifest.json；Q0仍未通过，Q1尚未进入。

- B2最终统一交付入口 `node tests/lightingBake/cycles.integration.mjs` exit0，包含新增GPU预算/11路径检查、真实CPU生成、取消/超时、失败旧结果保护、薄面UV和图集完整性。日志output/render-optimization-b2-gpu/cycles-integration-final.log，临时完整工程C:/Users/WY/AppData/Local/Temp/babylon-cycles-integration-2ButoC。
- 第一个物化候选实际工厂诊断：42856行、4次热身、7轮交错完整getSources，legacy中位274.2ms、direct298.2ms（+8.75%）；7对entry/key/world完全一致。该候选没有通过收益验收，之前构造微测不能推翻此结论。最后变体保留原生settings spread、移除逐行属性守卫，仍待实际collector复核；若再次无收益按文档撤回。

### 本轮最终裁决与回退（2026-10-24）

第二个物化候选在相同工厂中，完整getSources中位255.4→273.8ms（+7.20%），仍是负收益；7对完整entries/keys/world与第一轮同样相等。两个候选均42856来源，四次热身、7轮交错，未连接MQTT且没有本任务并行构建/测试/Blender。仅用于collector诊断，不是正式FPS或回放ABBA。候选间的基线数字不同，因此只分别作同一轮内对照，不跨app混合比较。

按照原方案8节“同一项连续两次没有可复现收益时停止，记录结果并保留原实现”，物化helper、collector direct/legacy分支、environment诊断开关、新增聚焦测试及其package/manifest登记已完整撤回，源码与before快照逐字节一致；memo候选同样已撤出。归档在rejected-materialization-v2及冻结candidate-app/candidate-v2-app；没有运行待定visual或新增ABBA，不把未做的画面对照称为通过。

先前提交的“完整检查、以分类耗时下降验收”选择属于有条件替代；当前耗时下降条件没有成立，无论是否认可该方向，都不能据此宣称L2通过或提前进入Q1。Q0阶段未完成的阻断仍为L2；B2本地软件与回归已完成，GPU硬件按用户明确答复暂缓。下一步若继续原L2，需要把全局纯数据图来源认证、精确原始数据/完整节点目录审计和私有基线作为跨入口设计，未知脚本/getter/Proxy直接full，并先证明实际工厂有非零命中窗口；不能仅登记pending宿主或把full改名audit。

回退后最终build（含TypeScript、Editor、Viewer）exit0；test:entries exit0；最终lint exit0；完整lighting-bake回归215/215通过、0失败/取消/跳过。最终产品输入相对上轮保留五项的1010个文件，仅cycles_bake.py有功能变化；两个controller只有冻结版LF与工作区CRLF差异且内容相同。最终source/交付Python均2810faf1...a51。证据delivered-integrity.json。

最终续作验证汇总：output/render-optimization-l2-20261024/verification.json。回退后build/typecheck、lint、test:entries与test:lighting-bake（215/215）均exit0；B2最终统一Cycles入口exit0。本轮未重跑完整test:ci；上轮708通过/2个Viewer既有失败/1skip的独立HEAD复现证据仍保留，不能称全局CI全绿。两个collector专属app/broker均已关闭、Blender任务均退出；未启动待定visual服务。没有提交、推送、发布或生成安装包。

## 用户确认的L2安全替代口径（2026-10-24后续）

用户明确同意：“完整分类次数可保持不变，以实测分类耗时下降且行为一致验收”，满足Q0其余条件后再进入Q1。该同意不恢复先前两轮负收益的物化候选，也不表示Q0已经通过；GPU真实独显验证继续按先前答复暂缓。

本阶段验收清单：保留每轮原始几何/完整节点目录/全部脚本、配置getter及回调观察；分类结果、资源身份、顺序、角色、延迟世界矩阵和异常行为一致；未知输入继续原路径；先用完整collector交错计时证明可复现收益，再做硬件画面/固定MQTT回放对照；类型、构建和受影响回归通过。继续保持画质/脚本/MQTT合同，不提交推送发布。旧memo/物化路线保持停止，仅依据profile选择不同边界的新实验。

下一步优先补来源准备细归因，独立评估descriptor-only枚举；不提前启动Q1。证据目录output/render-optimization-l2-approved-20261024。

### 新口径下的首个实验边界

独立非压缩构建CPU行级profile已完成，输入/产物不漂移，专属app/broker关闭；仅作定位，不能与正式minified FPS比较。create的7504个self位置ticks中，policyContext固定字段对象构建区域2663（35.49%），model components复制871（11.61%），最终row区域760（10.13%），roleSets区域300（4.00%）；这些是行级采样归属，不是独占耗时或可实现收益。证据line-profile-summary.json。

矩阵descriptor-only方向已否决：省略Matrix构造还会改变Babylon全局update seed和precision tracking，不能为小上界操控引擎私有状态。选中不同于已撤回row物化的新边界：只把policyContext开头owner字段可选spread改为两个固定字段literal，truthy仍两次读取owner，false一次且不创建own owner键，后续祖先/deviceType/规则输入保持顺序；不改最终row、components复制、几何/节点目录/未知脚本路径。不新增逐行反射守卫。保留原literal legacy内部A/B路径；收益仍待实际collector验证。

### 新候选完整collector与正式回放门槛

同一冻结candidate-1（collector53d8b267...）两次真实工厂完整getSources诊断均42856来源，15对完整fingerprint在内存中比较相同。第1轮7对/4组热身，中位267.7→265.0ms（-1.01%），含全部样本均值300.93→275.10ms（-8.58%）；第2轮12组热身/8对平衡次序，标准中位269.5→255.35ms（-5.25%），含全部样本均值295.85→305.20ms（+3.16%）。不丢弃420.3/504.7ms等长样本，也不把fingerprint自身分配后的影响归因为产品GC。

第2轮raw工具沿用7项的上中位索引，偶数样本的raw medianMs不是标准median；原数据不改，context-assembly-collector-comparison.json明确保留reportedMedian并用两中间数平均复算。仅典型调用下降还不足以证明整体净收益，Q0未通过。下一门槛为固定原MQTT60s A/B/B/A：A使用本阶段保留五项+B2的baseline-app，B使用candidate-1-app，直接验证这一个上下文构建变化在真实运动中包含暂停的累计getSources、每次均值、P95/P99和长任务；不能用旧五项组合收益掩盖本项负收益，不继续改源码追逐本次样本。

六姿态Intel UHD630/D3D11/WebGL2确定性硬件visual已通过：RGBA全部0差异，fullentries/顺序/world/角色/getter/回调/native事件/drawcalls一致，运动7810像素、阴影切换630像素有效。独立代理与主代理均打开代表画面确认非空；该夹具不加载GI，不测FPS，不替代工厂/MQTT。浏览器、服务和端口55737已释放。完整回归收尾后再正式采样，不并行测试或构建。


## Q0本地验收通过与Q1启动（最终有效检查点）

用户明确批准L2安全替代，且同意暂缓真实独显测试。新增policyContext构造保留完整原始几何、完整节点路径、全部getter/脚本与异常观察；没有恢复不可靠的净成员抵消，也没有重启已停止的memo/row物化路线。

本阶段A为保留五项Q0+B2的冻结baseline，B仅增加新上下文构造。原工厂370实体、116资源、Intel UHD630/D3D11/WebGL2、2560×1440、原MQTT t0、60秒A1/B1/B2/A2，采样时没有本任务并行构建、测试或烘焙。两轮组均值：FPS6.1333→6.7583（+10.19%）；inclusive getSources29.46685→26.33455秒（-10.63%），每轮per-call均值的算术平均338.835→291.043ms（-14.10%）；P95为477.2→428.55ms（-10.19%），P99为535.25→468.95ms（-12.39%）。完整分类次数87→90.5（+4.02%），P50为78.15→79.95ms（+2.30%），均如实保留。长任务53.9365→53.5759秒（-0.67%），卡顿问题仍在。

帧分位数采用result.independent的afterRender时间线；getSources是入口inclusive，含来源准备及子collector，可能含跨窗口末尾的同步尾部，不作独占CPU或与子计时相加。长任务取正式60秒窗口交集。源t0对齐的publication/delivery/callback各轮均1151、顺序0..1150、无缺口/重复、pending0；正式renderer窗因起点及初始回调边界数量不同，不能说正式窗也各1151。四轮refreshModelMeshes均66、UI完整分类均0。

本阶段硬件六姿态原始RGBA零差异，完整entries/顺序/world/角色/getter/回调/native事件/drawcalls一致。最终build（含TypeScript、Editor、Viewer）、lint、入口审计通过；lighting-bake224/224、manager78/78、unified42/42；optimization79通过+1可选真实清单skip，该分支另用本轮真实Cycles清单补跑5/5通过。B2脚本源/交付SHA2810faf1...a51保持不变，复用同SHA的统一Cycles与11条故障注入证据。两项初始HEAD已复现的Viewer CI失败继续单列，未宣称全局CI全绿。

独立ABBA审计112项全部通过。最终冻结1010产品输入及851产物字节校验一致（见verification.json）；Q0本地验收成立，进入Q1。真实独显显存/OOM、展会/现场、已安装或线上Viewer未验收。旧阶段首批五项百分比与本阶段不累加。此前“Q0未通过”的章节是对应历史候选状态，由本检查点更新。

证据：output/render-optimization-l2-approved-20261024/{comparison.json,abba-independent-review.json,verification.json}，逐轮runs/*、visual/context-assembly-hardware-1。原始数据与冻结目录保留不覆盖。专属app/broker/浏览器/服务均关闭，无提交、推送或发布。

### Q1执行与验收清单（随最终检查刷新）

| 范围 | 结果要求及验证 | 当前状态 |
| --- | --- | --- |
| L3/L4/L5/L6/L9 | 严格保持全部观察、完整失效、同帧合同和像素；冲突路线保留原实现 | 用户已批准收束；无这些路线的新产品变更 |
| L8 | 灯光范围剪枝不得改变脚本可观察的公开API、灯选择及像素 | 实际Native API反例已确认；按严格等价优先保留原实现，未宣称实现/收益 |
| B2图集 | 两次无可复现净收益停止，保留原实现 | 两次实际ABBA均较慢，实验已完整撤回；不恢复 |
| B3 | 仅新建场景auto；旧缺省CPU和明确选择保持 | 产品、迁移/序列化、真实管理器控件及最终组合回归通过 |
| B6/B7 | 精确属性索引/编码、旧格式兼容、SHA与原子发布；真实CPU/硬件/服务与混合DIST Viewer | 实现及分项证据、build5最终Cycles/新ZIP Viewer及真实PNG补齐通过；独显/现场未验 |
| LD1 | 本地KTX2 worker与保守fallback；实际采样画面、缓存、长任务和加载耗时 | 36单元、HTTP/file解码、3并发worker及静默ABBA2通过；ready较慢约2ms如实保留 |
| LD5 | shared-instance复用在真实货物轨迹、身份、交接、光照与性能上达标后才启用 | 用户批准保留原路径；候选off，62项局部功能通过；实际托盘0hit及旧引用语义差记录，不计收益 |
| LD6 | 货物、报警、阴影、GI变体预编译有界，实际首次尖峰下降且记录准备成本 | 用户批准保留原路径；候选off，33项局部功能通过；模板实际命中但完整变体/净收益未验，不计收益 |
| LD7 | BIN/JSON/JS/WASM等br/gz只改传输；原清单与SHA保持 | 16单元、实际HTTP20协商、原Viewer缓存smoke及build5最终真实ZIP通过 |
| R1 | 能力基准/cache/取消/诊断可读，默认画质不自动改变 | 本机T0真实浏览器/管理器及最终组合回归通过；T1/T2未校准 |

按已确认的范围与B3仅新建默认auto选择执行；不以构建通过替代真实行为或性能门槛。独显测试已获同意暂缓，现场与组合性能边界保留。

### Q1早期里程碑（历史检查点，以最终交付为准）

- B6：完整属性精确字节索引焊接已实现。真实CPU七面4,194,304个PNG分量零差异、所有角点逐字节一致，32格平面JSON339198→78808bytes；硬件属性shader/15次有效pick/bounds一致，真实服务到保存/SOURCE/DIST九资产版本与SHA保持。独立审查18个冻结文件通过；最终统一工程回归仍需对当前组合版本完成。细节见B6记录。
- B3：用户明确选择仅新建场景默认auto。实际新建factory只显式补device，旧normalizer/Data/Python缺省仍CPU；v1–6缺字段及全部显式设备导入、预设/签名/序列化和真实完整管理器操作均通过。实际入口先legacy迁移，因此没有额外改SceneSerializer。两产品文件已冻结，待组合构建/入口登记。
- LD7：本仓库预压缩已实现，15个单测及真实22文件/27条目ZIP、16个响应编码/decoded SHA和冷热缓存检查通过。独立审查修复了漏计目录条目与长名临时组件两P2，最终产品/compiled/report SHA匹配，无open P1/P2。真实Nginx模板/重载/线上均未做，仅补现有部署文档；原文指定Babylon/Draco/KTX smoke待结合LD1完成。
- LD1：本地URL前置修复、经典worker、缓存内委托及保守自定义输入fallback已实现候选。19个NullEngine/FakeWorker/真实parser回归与8个单缺陷红见证已交付；HTTP生产安装顺序、有效彩色grid和透明度控制、冷热缓存、worker启动失败恢复及真实Electron file解码已通过。仍待最终独立审查、工程回归和长任务/加载耗时门槛，不称LD1全部完成。
- B2图集：首轮256小页真实ABBA虽然6→2次bpy调用，但atlas阶段1351.45→1644.46ms（+21.68%），不达标。2048生产页边界第二次复核正在跑，并记录native逐对象调用；没有凭次数宣布收益。若再次不达标，按规则完整撤回图集合批，保留B6/Q0。计时期间所有本任务构建、测试和浏览器暂停。
- L9：硬件反例已否定普遍radius-only线性等价假设，重复控制0差而等强度重叠合并有29536像素变化、max249。root及独立审查均打开前后图确认，保留产品原图层；此结果不否定未来受限场景可合并，但不允许默默改变当前画面。
- L3/L4：真实配置getter/未知脚本、跨来源used优先级、raw几何和完整节点路径仍缺可靠生产协议；尚未启用主路径或启动空覆盖的30分钟影子测试。只读设计与真实probe边界见Q1分类设计记录。L5/L6/L8/LD5/LD6/R1及B7等仍需逐项实施/验收。

本轮首次组合build（TypeScript/Editor/Viewer）及LD7两次增量electron编译通过，随后LD1/B3仍有变更，因此这些不能冒充最终组合build。全局两项既有Viewer CI失败的边界继续保留。所有测试/失败/源快照保存在output/render-optimization-q1-20261024；没有提交、推送、外部发布或安装器生成。

## Q1根代理组合检查点：LD1/LD7/B7/B3

- 用户确认B3只让新建场景默认auto；既有缺省CPU和明确选择保留，4项serializer/迁移回归与真实UI既有证据有效。
- LD1受控正式ABBA2与独立复算通过：主线程加载窗长任务71.90→1.25ms，ready193.35→195.35ms（较慢约2ms），不外推FPS/整场景首帧。原smoke组合6通过；真实三Worker并发18像素对照零差；36unit全绿。完整file Viewer仍为既有不支持边界。
- LD7补BIN侧车：16unit、20HTTP协商/MIME/SHA及冷热发布缓存通过；不改原清单、SHA和预算。实际最终混合格式DIST ZIP/Viewer正在验收。
- B7作者9产品冻结与独立审查无open P1/P2，本地CPU/硬件逐值零差既有证据成立；根代理已将五组B7测试注册lighting-bake入口，旧Cycles主集成改为按asset encoding解码，不强行JSON.parse新BIN。
- build-3-b7-ld5 full build exit0；该版尚未包含LD5后续effectcallback准入修复，不能称LD5最终验收。LD5当前11unit与真实语义检查有进展，前轮hit缺1仍保留未定位边界，待独立集成/最终trace与独立静默计时。
- L9广泛同半径合层像素不等价，未启用；L3/L4/L5完整观察/失效协议与L6同帧合同冲突已提出用户选择。答复前不降低标准、不改这些产品路径；LD6/R1及其它独立安全工作继续。Q1尚未宣告完成，Q2未进入。

## 用户确认的严格等价收束范围（最新有效）

用户已明确选择“保持严格等价，冲突项保留原实现，完成其余Q1”。L3/L4/L5的观察与完整失效协议、L6同帧失效与1秒延迟冲突、L9同半径合层像素差均保留证据并不启用；这是已批准的范围调整，后续不重复询问这几项。Q1其余L8、B2图集、B3、B6/B7、LD1/LD5/LD6/LD7、R1仍逐项收束；B2图集两次实际无收益已按原停止规则撤回。Q2门槛不因此自动满足。

B7实际CPU→真实ZIP→内置Viewer混合2BIN+1JSON已通过，原资源逐值/像素与SHA边界见dist-viewer-acceptance/run-1792811086710-62b17b68；该ZIP是build3。另用完整HEAD对照确认快速缓存同key启动旧Promise回写错误，最小operation guard已3项GREEN，下一次统一build后重打/复验，不能把旧ZIP称新guard版。R1真实本机T0冷/热cache、取消换代与manager控件通过并获独立review；旧L1 fake runtime适配新纯getter后定向重跑。LD5 public API guard新版Pool a612…已61项GREEN，真实业务资产与正式净收益未验；LD6准备候选当前默认off，4个具体P2正TDD修复，未作收益或完成声明。

## 最终组合冻结与候选保守收束（build5）

build-4与build-5均已实际exit0（TypeScript、Editor、Electron、Viewer）。build5补入Controller的货物池默认off；LD6也继续默认off，两个内部A/B候选不作为已交付优化收益。默认货物连续两轮真实创建/释放已通过定向回归；首次原计划RED作业在TypeScript依赖加载完之前产品已改变，实际通过，因此标记INVALID_RED，不把它冒充失败基线。

真实业务塑料托盘GLB（3321744 bytes，SHA9b2a61d844ddc8942b91fea77a3b162ac53bc523f324dae48aa260bdf925ad8c）A/B各12轮，B零hit/12拒绝。精确原因是两个原生TransformNode wrapper的copied metadata来自Babylon AddPointerMetadata分配的{}；GLB无extras也不能跳过原生clone对slice/clone的观察，现有unknown-source-clone-input fallback保留。唯一Native诊断在同步记录源事实后render/dispose阶段有postProcessManager页面错误，整体FAIL原样保留；不能将它写成整个功能通过。详见ld5-prep/source-clone-analysis，未修改业务GLB或metadata来凑资格。

L8以真实Babylon9.12 NullEngine/Scene/PointLight/2Mesh证明：即使FALLOFF_STANDARD、range1而far距离99.9134，脚本式getScene().getLightByName(...).canAffectMesh(far)在include裁剪前后true→false，空列表恢复true且数组身份已变。该原生API反例无需GPU就足以推翻普适脚本严格等价；没有把它说成完整MQTT或像素测试。按用户最新严格等价优先选择，保留原灯光实现与两份用户列表。细节见L8专项记录。

root独立复核LD5公共调用守卫与LD6四个P2修复及启动operation guard，8输入SHA见candidate-independent-review-final.json。LD5/LD6仅APPROVE_DEFAULT_OFF_ONLY：真实业务覆盖/收益、完整shader变体及任意外部旧引用仍是实质缺口。不得以局部单测、合成box命中或“programReady”数量替代这些验收。

src/dist Blender脚本最终SHA同为a6b9cc8a6c473ac446f3f470daefc1abd3ddc00cc6485e0df4320bf9cbf9b0f1。build5之后冻结产品，Node组合回归、实际Cycles和复用真实已烘焙场景的新ZIP/Viewer功能检查分工运行；不是性能窗口。没有重复烘焙、复用旧ZIP冒充新构建或进入Q2。

## 最终本地Node回归与build5 Viewer

九条命令均exit0：lighting-bake246/246、lighting-manager82/82、lighting-optimization79pass+1optional skip、local-decoders36/36、deployment-precompression16/16、generated-cargo-pool62/62、gpu-capability-profile15/15、shader-warmup33/33及test:entries106retained/0missing。合计570项=569pass+1skip，非全局CI统计。真实PNG可选分支待本轮正式Cycles快照补跑。日志/前后SHA见final-regression-20261024/summary.json。

lighting-bake运行期漂移仅package/manifest新入口及smoke三globalThis修正；precompression期间package/manifest补Node transform flag；均不在被测产品链，src/electron产品全程不漂移，原差异如实保留。shader最初命令缺transform flag由独立源码审查发现，未运行坏命令，不虚称RED；修后33/33通过。最终受影响ESLint第二轮exit0，第一轮smoke no-undef三错日志保留。root和独立review分别完成候选、启动guard及最后小改动审查，无默认启用未验收候选。

build5新DIST/Viewer已PASS：新ZIP16636389B、SHAa8274eb7620a491e5f581473dda96bf0938bca040295b1a27899ff7664c98a20、750文件480侧车；2BIN+1JSON/3GI实际shader/pick/原URLgzip全部通过，startup错误DOM全程空。root打开图确认，与旧合格图字节相同。300输入前后匹配；无新bake/旧ZIP复用，localhost后端模拟边界仍明确。专属browser/server关闭。

LD5旧引用witness直接绑定既有真实Native/SharedCache/Pool断言：disabled oldMesh disposed=true且第二物理不同；enabled旧物理未dispose且被第二出生复用并可拾取。普通JS旧引用无需observer，故metadata认证也不能解决普适身份等价。LD6实际普通模板两个PBR Effect命中、miss2→0，仅功能计数；receiver实际false、GI照明签名不符state=false、报警未测。详见output/ld6-coverage/final-review.json。两项保持off，root已请求用户选择新边界收束方式；不能把局部GREEN称完整LD5/LD6验收。

## 用户批准的LD5/LD6最终收束

用户选择严格等价优先，LD5/LD6保留原路径，记录缺口并交付其余Q1。Controller两候选默认off保持；不继续扩物理复用协议、不为未覆盖shader变体新bake或跑性能，不把实验局部GREEN计作已验收优化。此决定更新此前“等待用户选择”的状态；旧失败、scope矩阵与内部A/B候选仅保留供审查。

其余Q1按本地实现和回归交付。原文阶段门槛中的工厂/展会组合FPS、GI显存及现场/独显验证没有由三实体Viewer或分项计时替代；本轮不宣称全项目现场性能验收，不推进Q2。Q0的工厂回放与LD1/B7的分项收益分别保留，百分比不叠加。最后实际Cycles发现旧UV测试强制展开存储布局，按B6索引后的逐角点合同修正并强化为IEEE64逐位比较；产品不变，4/4共线及31/31细面定向通过，完整Cycles待最后重跑。

## 本地最终交付检查点

按用户批准的范围完成本地交付，Q0验收及可严格等价的Q1改动/回归成立；冲突项、两轮负收益路线与候选默认关闭均不计入优化收益。最新结果见output/render-optimization-q1-20261024/final-delivery.json。

- build5 full exit0；受影响ESLint第二轮exit0；git diff --check exit0（仅仓库LF/CRLF提示）。
- 九条命令exit0，标准570项569pass+1optional skip；实际Cycles新快照将该真实PNG分支单独补跑5/5、skip0，manifest/PNG SHA前后一致。没有把重复执行的4个基础PNG用例当新增独立覆盖。
- 完整真实Blender5.2.2/Cycles retry exit0，所有产品及检查输入无漂移；旧UV raw数组断言FAIL单独保留，修正按索引还原原角点并强化IEEE64，独立Python审查通过。src/dist最终Python均a6b9cc8a…，没有产品改动求绿。
- build5真实新ZIP/Viewer输入最终重核300份全部一致，实际GI/混合几何/拾取/像素与启动错误恢复已通过；候选继续off。
- 实际独显、T1/T2、工厂/展会Q1组合FPS/显存及现场仍未验收，分项收益不外推、不叠加，不进入Q2。未提交、推送、打安装器或外部部署。

最终补核lighting-unified42/42、exit0，未触发重复构建/浏览器；各已完成子任务清单已按实际证据勾选，独显/线上及用户批准保留项保持明确未验/不计收益。该42项单列，不把重叠用例累加成新的独立覆盖。此前9条命令及真实Cycles/PNG/Viewer证据继续有效。

最后统计更新：补入最终lighting-unified42/42后，共10条定向命令全部exit0，TAP612项=611pass+1标准真实PNG分支skip；该分支已用本轮新Cycles产物5/5补齐。此为各命令TAP计数，不是全仓CI或互不重叠的独立用例数。最终完整汇总final-regression-20261024/final-summary.json；专属Node/Blender/浏览器/服务均已收束。

### 2026-10-24 工厂Q1业务与最终ABBA报告交付

本轮仅增加验收工具/文档，产品代码、原场景116资源/脚本与原录制未改；关闭候选保持关闭，未进入Q2。A=accepted Q0含L2，B=冻结final Q1。两臂各2业务循环、每轮21项主业务检查通过，task201三host同root/owner/模型lineage；fresh900201实际故障冻结/恢复、拾取与stop/reopen通过。完整逐时刻姿态、全生命周期每帧角色及全buffer pixel0未建立，raw差异保留。

正式A1/B1/B2/A2各60s全部有效，独立119项复算通过。FPS6.8583→6.8167(-0.6075%)，P95 414.65→415.10ms(+0.1085%)，P99 478.20→469.60ms(-1.7984%)；未复现新增steady收益，不宣称统计非劣性或卡顿解决。source-t0各1151 pub/delivery/callback完整/pending0，正式窗边界计数另列。原Logo在两Editor版均解析失败但PNG本地存在，非本轮新增，未扩修。真实发布入口因原bake.enabled=true/result=null拒绝，Viewer成功路径未达到；已发范围选择，未CPU烘焙/切模式/绕过。

主报告docs/tasks/2026-10-24-factory-q1-acceptance-report.md；完整数据output/render-optimization-q1-factory-20261024/{comparison.json,final-acceptance-summary.json,analysis/,performance-audit/,runs/}。所有实际app/broker/发布子进程已收束，精确任务进程查询无残留；旧失败保留，无提交、推送或外部部署。

### 2026-10-24 工厂验收交付范围最终确认

用户明确选择保留真实发布阻塞证据，先交付Editor业务与ABBA。已同步主报告、验收清单和机读总摘要，将Viewer从待选择改为用户批准延期；保留原发布门禁失败与NOT_REACHED，不计成功，不启动全厂CPU烘焙、不切模式或绕过、不进入Q2。原业务/性能数据与独立审计文件未改，也不因范围确认重跑已完成检查。
