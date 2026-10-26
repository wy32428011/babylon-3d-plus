# 优化第二期全项推进与验收

用户续令：继续并完成所有优化。日期：2026-10-25。承接 `2026-10-25-optimization-phase2-continuation.md`，既有通过证据继续有效；不覆盖原始失败、不提交/推送或自动外部发布，保留原工程及入场未提交改动。

**最新收尾范围（用户明确确认）**：完成现有改动的最后构建和打包验证后交付，不再新增优化。最终收尾只检查当前代码、必要回归和既有样例的 SOURCE/DIST/Viewer；五冷五暖、N1/S2 新 ABBA、N3 推进、中型 ROI 与更多硬件/展会实验停止在已有证据状态，不能记作通过。用户另明确批准 B9 context restore 整屏 RGB 最大差≤1、alpha exact；自然 AA 与所有 Mip 文件/GPU 层字节仍 exact，旧 exact0 失败报告不追认。

## 完成标准与边界

每项分别记录实现、功能验证与性能验收；负收益候选按原规则停止，不用启用无收益实验凑完成。资产优化制作新修订并保留原件；画质选项为显式设置、默认关闭。用户提供的 Scenes 路径只有当前383实体场景；允许先验证非GI工厂副本，再做独立GI场景。缺历史冻结输入不能把它写成原370实体正式对照。涉及真实中台写入、Nginx部署或画质默认值变化时，先完成可审查结果再处理最终选择。

2026-10-25 用户补充：新中台地址为 `http://172.16.3.27:38087/`；旧关联大屏在新平台确实不存在，旧 MQTT 地址未连通，两项均明确允许忽略。本轮本地3D/静态验收排除这两项，保留原工程引用与配置；历史消息回放/连续运动性能不由此视为通过。用户另批准可选 `lighting.version=3`，旧无新codec场景保持v2。新codec必须完整产出/解码、严格版本拒绝，不能只加字段并静默丢弃result。

## 唯一验收清单

| 项 | 交付与可观察验收 | 实现/研究 | 验证 |
| --- | --- | --- | --- |
| E3/D3 初始化热点 | motor/shelf/LED 新修订或可归因的安全框架改进；原资产不改，行为oracle、真实打开对照 | motor/shelf两块无收益、LED Proxy合同反例，均按规则止损 | 原件保留，未采纳资产变体 |
| E3 大场景错误 | 找到超时与 editor-image 未知协议的实际URL/路径/授权链；修根因并实际Editor无错误 | 本地图片根因已修；远端两项获准排除 | 真实未知协议消失；完整新条件待验 |
| E3 完整打开链路 | 同一打开ID跨进程关键路径、并发/字节预算；冷暖各5次与30%目标 | POST只读守卫/配对工具已实现；跨进程七阶段trace未实现 | 前置64/64 POST通过；paired1启动工具失败，paired2 C1物理pin/声明来源矛盾FAIL，0有效样本，非30%达标证据 |
| E6 加载回归 | 修旧源码抽取与VM/AST夹具，保留原功能合同；加载专项全量通过 | 夹具已修 | 当前完整加载209/209、0skip通过（wave13） |
| E1 GPU | 真实场景与小场景60s GPU分布、disjoint与不可用原因，硬件/运行条件明确 | 查询注册/按需采样已实现 | RTX4060Ti两场60s通过；不等于历史Intel复测 |
| N1/N2 | 原工厂ABBA、getSources/长任务/帧分位数、动作/MQTT/像素一致性 | 已实现；当前383独立条件与严格ready/同帧工具已冻结 | 历史输入缺失；当前attempt1采样前工具失败，plan3的41纯测试通过，完整ABBA待跑 |
| N3 | 依据N1/N2剩余成本决定；若实施需依赖图、影子模式与full回退 | 待研究 | 前置未达 |
| E2 GI/Viewer/展会 | 中型真实GI、工厂Viewer、展会/硬件档位/实际GPU烘焙 | 小业务GI全链已过；完整环境案例止于固定UV超时 | 中型链路/展会仍有缺口；不冒充全GI通过 |
| E4 无损资产 | 普通包无损治理及accessor/节点/层级/纹理语义证明，模型库高模提示 | 存储去重/无量化meshopt显式模式及UI已实现 | 当前23包oracle、两类环境候选实际全RGBA零差，原件保留 |
| E5 S2/R9/R3/R5 | 阴影缓存ABBA、冻结覆盖审计、三宿主不透明画布、GPU拾取一致性/延迟 | R9/R5研究完成；R3已实现；S2待做 | R3实际三宿主通过，R5不适配语义未替换 |
| E5 B4/L7 | 零环境且无自发光的安全跳过/未知回退；探针减少分配逐位一致 | B4实现；L7反例止损 | B4真实六场逐值/PNG相同；L7保留原实现 |
| D4 显式画质选项 | R8/R2/R7/R6/S4/L10/B8/B9逐项设计/实现或有证据止损；默认不变 | R8/L10/B8已交付；B9核心已集成，有限LOD外沿packing完善中；其它有合同风险 | R8/L10/B8真实UI与Viewer/iframe通过；B9真实微oracle通过，完整业务待跑 |
| D6 GI代理合并 | GI实测证明必要后研究；网格身份边界单独验收 | 待研究 | 前置未达 |
| 工程/交付 | build/typecheck/lint、相关专项与真实入口；关闭候选清理决定/线上编码协商另列 | 部分通过 | 最终复核 |

## 并行写域与采样规则

- root：大场景错误、GPU与运行时/编辑器集成、E4/E5后续路由、文档与package/清单；负责统一构建和整体验收。
- asset_startup：仅新资产修订工具/专属测试与output副本，不改Platforms/SharedResources原件。
- loading_regressions：六个既有加载失败测试及专属helper，不改产品。
- bake_safe_skip：Cycles Python与对应专项；L7需先报告写域。
- 定向单元可并行；GPU/正式打开对照/烘焙与重基准由root串行排程，期间停止构建、扫描、profile和其它任务浏览器。

## 当前证据与决定

入场：Electron普通权限和完整DIST集成已通过；完整build/lint/CI通过，P2 201+1可选skip。当前383实体场景诊断可读，但整体smoke因超时和图片协议失败；不作为打开性能通过。详见前一执行记录和 `output/electron-eacces-20261025/final-summary.json`。

### 第一批实际结果（后续实现/验收仍在进行）

- E6：六个旧测试实际基线12pass/28fail，修夹具后51/51；新图片加载合同又补了13/13定向回归，尚待最终完整加载入口复核。
- E3图片：修空baseUrl挡住本地缓存、无绑定读错根、缓存图片未恢复授权与脚本先启动的竞争；只授权Images目录内精确普通文件，防越界/junction。新场景发布先恢复缓存再提交，会话过期不污染；未知逻辑图明确报错，不交给浏览器伪成功。专用缓存/时序回归与脚本/监控合计30项通过。
- E1：干净子进程RED证明模块化入口停在AbstractEngine计时空实现；显式注册WebGL查询扩展后GREEN。GPU查询仅诊断可见/性能运行时启用，停用前残留样本不当新测量。实际RTX4060Ti、2560×1440，小场景60s/1800样本P50/P95=0.070656ms；当前383实体场景60.176s/346样本，GPU P50=57.458688/P95=61.639680/P99=66.544640ms，disjoint0。测量有效但大场景functionalPass=false（外部服务超时），不是原Intel工厂复测或FPS A/B。
- 大场景未知图片协议已消失；剩余错误均来自真实 `http://192.168.18.100:8087` 的大屏页面/缩略图。已异步询问有效服务地址，未替换原链接或隐藏网络失败。
- R9：实际大场景3913网格中904已冻结、3009未冻结；保守审计额外安全候选0，未约束外置脚本/实例/未知所有权等拒绝原因全部保留。审计不调用世界矩阵更新/lighting收集，不修改冻结。
- D3：motor/shelf的nodes/kernel/both固定候选通过12个CPU状态对照，但两块交错基准无可复现收益，STOP_RETAIN_ORIGINAL_ASSETS，原件与原工程不改；不再追加第三变体。
- E4严格存储子集：新增model-lossless，独立JSON/view/image/accessor逐引用SHA oracle；修负零序列化且保留原错误。真实23GLB：12更小/5无收益/6保守拒绝；拒绝项取原件后83,778,932→80,908,420B（−3.426%），环境55,684,996→52,869,028B（−5.057%）。原件SHA全保留，尚未自动应用；meshopt/逻辑去重/模型库提示另验。
- B4：最终真实Blender5.2.2 CPU六场景共1,572,864个float32分量与PNG SHA全零差异；唯一可证明零贡献场景2→1遍，其余保持2遍。25个保守拒绝边界通过。L7原地归一化存在Array.species返回类型反例，研究止损、保留原实现。
- 本机Blender每用户安装已补入自动发现，显式路径/系统路径优先级与旧junction行为保留；R3已提供默认不变的opaqueCanvas显式Viewer选项，等待三宿主真实验收。
- 当前R8已实现控制器14项、R9/R5共11项测试，合计25/25；R3与运行配置等合计31/31。Editor会话级checkbox与Viewer可选配置已接入R8，默认关闭、运动1.5倍缩放、静止500ms恢复，不降脚本/MQTT频率；实际运镜/恢复/像素与性能对照未完成。性能报告补实际buffer/缩放等级，避免混作同画质收益。
- R5：SDK GPU拾取缺distance/precise且异步，单坐标multiPick确有薄实例索引0丢失；研究阶段不直接替换现CPU选择链，未把无GPU契约测试当硬件拾取/点击延迟验收。
- build wave1/2/3通过；root新renderSurface与模型库提示等后续改动仍需最终统一构建。所有新证据位于 `output/phase2-completion-20261025/`；原失败与不可用状态保留。

### 第二批里程碑（实现与验收继续分开）

- R3/R8真实入口：Editor会话checkbox默认关闭，运动缩放1→1.5→1，恢复后全RGBA零差；完整DIST的Viewer/iframe六组合通过，包含opaqueCanvas默认/启用及父页面DPR2→1。发现并修复display bridge覆盖自适应缩放的问题；两种GPU分别记录，不混合性能。
- L10：显式泛光MSAA选项默认不新增旧键；实际Editor与完整DIST Viewer/iframe核得物理4samples，关闭/撤销/重开关闭与基线完整RGBA零差；启用改变4972个像素，明确属于画质选项。GPU稳态成本尚未做ABBA。
- E4模型库提示：共享纯数学/有界GLB JSON读取、缓存与既有索引兼容已接入；真实导入/悬停/保存通过，高密度显示提示、普通模型无提示，原文件与保存场景SHA保持。严格存储候选仍在output，未替换原件；候选GPU像素验证及meshopt无量化路线待做。
- 独立业务GI小样：真实Store→CPU Cycles→应用→保存→SOURCE/DIST成功，10receivers/656tri，只计小型功能；包搬迁按实际重签规则分别核有效签名及所有资产SHA，真实Viewer通过。旧字面签名相等的错误oracle失败记录保留。
- 完整环境GI：原环境全部798receivers/866611tri/585probes。第一轮显式预检后再次capture触发2GiB前端堆守卫，正常取消且未进Cycles；保留失败。另立fresh process的正常“直接开始”路径，不额外调用预检，输入/设置/硬预算不变，当前已进入真实Blender UV处理；这不等于修复前轮重复捕获内存问题。
- B8/B9兼容研究：真实旧API六测试/十变体证明，仅增加新encoding会成功但result=null，不能用作兼容门；嵌套lighting v3在旧打开/保存入口明确拒绝。现已获用户批准，开始受控实施；外层SceneFileVersion仍6。新codec和mip尚未交付。
- 新二期Node专项74/74、build wave5通过；完整加载/CI/lint与后续codec改动需最终统一复核。新UI/烘焙/服务工具的入口登记和证据摘要仍需收尾。

### 第三批里程碑

- E4：严格存储去重候选（环境−5.057%）与无量化meshopt候选（环境−12.32%）分别在实际Editor/RTX4060Ti、1920×1080通过8,294,400B完整RGBA零差，16,256色。meshopt23包合计83,778,932→76,174,032B，16更小/1无收益/6保守拒绝；产品0.20与固定0.23双decoder逐view/accessor/image/结构SHA相等。显式CLI模式和新旧回归21pass+1原CLI缺工具skip；原资产未替换。加载阶段单次计时只作观察，不宣称稳健加速。
- 环境GI direct-start最终在600000ms截止时仍UV1366/1517，未进入成功的atlas/probe/提交，FAIL保持。单capture范围不变；renderer观察1.802GB、Cycles日志峰2.230GB、own disk观察559.6MB均未超硬预算；已确认owned PID全部退出。task.json仍旧baking快照，未宣称cancelled最终写盘已验。
- 根因调查明确几何走真实binary，材质PNG才有base64；不能把主进程复用binary误说成二次全量重编码。新增内部可选纹理URL字典，仅renderer显式启用，恢复原URL后继续完整校验/授权/预算，默认encoder与旧请求不变。冻结旧decoder边界/坏字典/完整数值回归通过；小Node V8序列化143336→20584B，不等于Electron wire或实际峰值收益。根代理/图片部分迁移合并兼容、Viewer原DPR容差补验，定向19/19。
- B8：真实编码helper、v3严格合同、recipe不匹配过期、主py/service/loader/PBR与Standard、管理器/undo、Viewer能力门已实现；16个定向测试通过，新旧客户端同v2对象默认normalize/完整serialize字节一致。完整build wave6通过。真实UI→Cycles→保存重开→SOURCE/DIST→Viewer/iframe正在独立小业务案例执行。
- B9微oracle：实际8192个PNG通道符合float32乘255加0.5后floor，np.rint/float64式不符合；PNG top-first/Blender bottom-first。真实EXTEND margin3的角点仍黑，是不能直接generateMipmap的实际反例。正在实现独立线性同UV-chart补边、逐级足印认证与受限LOD；旧默认不改，尚未交付。
- 正在准备当前383实体、无MQTT且移除单一失联screen组件的独立ABBA。所有原工程配置保留；新口径/硬件/分辨率与历史370实体、Intel及原录制分开，功能不确定不记performancePass。

### 后续严格复核与进行中修复

- B8 case6的真实UI、CPU烘焙、Gamma PNG、task completed/平面目录、IPC字典、SOURCE/DIST资产运输已通过，但原helper仅检查瞬时ready，脚本PASS被截图/同包严格复核推翻：`b8-gamma-viewer-review-1`为FAIL。实际无取景/强制矩阵调用仍复现材质472 `_entrance`→原116触发GI invalid；矩阵/显隐/几何完全相同，最终ready=true但runtimeError非空、GI maps=0。原PASS报告保留，Viewer完整验收以严格复核为准。
- 修复正按受控双侧材质租约、真实可见GI代理入场映射和显式GI插件传递推进，保留原/临时材质两侧业务delta与未知替换失效，不关闭入场或清失效latch。独立原6条RED与后续9条GREEN均保留，动态非proxy混合场景还有新增边界在核，不据静态单元宣称完整Viewer通过。
- 非receiver UV候选已通过9例真实CPU Blender A/A与A/B：每组2,359,296个irradiance float32分量、396个probe分量，以及完整PNG/receiver几何/probe JSON全部逐bit/byte零差；6种可判定材质2→1次smart_project，3种未知/缺省仍2→2。只在output冻结，产品尚未接线。ROI拟保留原环境全部798/866611作为遮挡/反弹，只选择33源节点/24498tri接收；未绑定实际resourceIdentity，尚不可执行，不替代完整环境超时失败。
- LED精确节点快路17个native/getter/重挂接等夹具相同，但Proxy descriptor trap顺序确实不同；STOP_CONTRACT_COUNTEREXAMPLE，未计时/未采用，原LED SHA保留。该Node测试通过只表示反例与止损规则通过。
- 本阶段入口清单统计931候选、未分类0；新增显式Python/Blender/GPU手动前置和原始失败保留。后续新测试/源变更仍须最终复核，不以清单登记冒充执行。

### 当前最新实测（覆盖前述阶段性缺口的状态）

- B8与入场互操作已在wave11新模板完成真实收尾：`b8-gamma-viewer-fixed-4/report.json`为PASS。原case6已烘焙资产/场景/包保持，fixed3正式重打SOURCE/DIST后仅修工具读取SDK真实fragmentSourceCode getter，用同包复验。独立与iframe均实际看见青色dissolve，10 GI代理同时rendered/GI+Entrance+Gamma shader、进度推进、indirect=1；2332绑定/interrupted0，完成后全释放并连续10×200ms ready=true/runtimeError=null/HUD空。root亦查看实际播放/完成图像，非仅采瞬时ready。
- 两类实际根因均有RED与修复证据：静态clone恢复误失效；合法薄carrier显示材质引起proxy-source raw identity重绑。共享Geometry受控dtEntranceInstance安装也有独立RED，现仅同步精确ticket豁免该自有通知，原callback与业务/重入位置/索引/未知写仍失效。核心11条+薄批5条GREEN、原Entrance20条通过，wide build wave11通过；旧失败和脚本假阳性报告全部保留。
- B9开始接入现有shared/UI/service/loader/Python/plugin；独立容器/实际WebGL0..4级+恢复已过，尚无全B9业务包通过。N1正式ABBA窗口期间冻结三个绑定源和全部构建，只写未执行源码，结束后才补Runtime与单元。
- E3实际POST-only前置2完成64/64元数据查询、两轮一致，SOURCE版本110/资源revision231已声明冻结，未做GET或字节SHA验证。前置1分页200→实际100失败经后台明确clamp合同修正后重建新证据，失败1保留；图片客户端同类漏页根因正在修。正式C1/W1…C5/W5尚未执行。
- 当前383/无MQTT/Editor编辑态/1920×1080的独立N1/N2 ABBA已启动，先等A1自然ready，未改两个旧click pin或Fetch配置；尚无可报告性能结论。

### E6：关闭候选保留决定

本轮保留既有内部实验实现与原回归，不删除未获明确移除指令的代码，也不自动开启。生产调用点已经核对：

| 既有候选 | 当前实际关闭点/内部入口 | 保留原因与缺口 |
| --- | --- | --- |
| LD5货物对象池 | `GeneratedModelOutputController`构造后显式`generatedCargoInstancePool.setEnabled(false)`；内部`setGeneratedCargoPoolingEnabled` | 真实托盘0命中且旧引用语义未等价，不能计收益；保留故障/释放回归供将来独立研究 |
| LD6准备着色器 | `ModelAssetRuntimeController`构造后`shaderWarmup.setEnabled(false)`；`SceneRuntime.setPreparationShaderWarmupEnabled` | 尚未覆盖所有receiver/GI/报警变体，单项净收益未验收 |
| 动静合批 | `SceneTelemetryController.motionStaticBatchingEnabled=false`传入构造；`SceneRuntime.setMotionStaticBatchingEnabled` | 正式性能/身份等价未过，不入场景或Viewer默认配置 |

类自身的构造缺省为true不代表产品已启用，关闭结论以上述实际controller构造调用链为准。入口保留与功能/性能通过分别记录。

## 最新接续检查点（仍未完成总验收）

- 主工程无commit/push/外部部署。原383 scene仍SHA `0e537958…75015`；用户已批准仅对冷暖验收使用新平台已解析修订，新resolved完整字节SHA `991fc503…489ee`，不冒充370/Intel/历史MQTT。
- E3最新输入为 `e3-current-baseline-4/baseline.json`（`b6286189…a504`），原SOURCE版本110/资源revision231、原zip SHA `203a60ac…ba4b0`；71个typed引用文件及18个活跃纹理槽/2张图单独冻结。source/logo/binding等字段没有删除；先前pair3离线完整source/live零差，开场包15个文件已纳入。
- 主P0工具由root修改：显式`--resolved-baseline`、原SOURCE实时schema指针派生、完整dist静态文件fingerprint（排除pycache）、原生window/PID与JS heap/CDP读回、复制诊断后恢复HUD/clipboard。旧五冷五暖均因验证工具/输入门停于C1，0有效样本，原失败保留；最新含图片基线尚未实跑。
- 活跃图helper `sceneOpenLogicalImages.mjs`当前`0ba888b1…36e0`，CDP使用原生DOM命令取得root、own-data/Proxy/getter严格门不关；16纯合同通过。hidden/noGPU micro2内层真实DOM/Map/bridge/2rawbytes通过，外层因不存在的WebPreferences字段保持FAIL；只能证明协议形状，不能当真实18槽或GPU成功。
- P1 Main/API26、Editor46与Runtime57定向检查通过；跨批发现lifetime失败计数误当本open，已以captured-scope计数窄修（Runtime60、UI23检查通过）。9runtime源/9Editor源与可选API已冻结，统一build16通过，build17用于最后计数修复；真实Home同ID七阶段/一次assets深诊断还未执行。发布cache的network/rawCache细分未接，不显示伪0ms。
- B9 Gamma4级、线性1级均已真实CPU生产/保存重开/GPU全链、各级byte与sampler/context restore通过；严格全屏新门的resume5有5981个PBR平面像素仅RGB1/alpha0差，仍保持FAIL。正在做不启GI的独立native control以判适用边界，不能据肉眼相同或事后调阈值追绿。control1/2分别因InstancedMesh observer、UBO null location工具错误未形成合格对照，普通三函数未变。
- B9 Source/DIST loose GLB根目录误收与外置buffer/image闭包已窄修，5产品文件+13回归/strict/lint通过；完整性门保持。待build17后同已存Gamma/linear重新包/Viewer/iframe，不需要再Cycles。普通/native工具冻结SHA以最新收据为准。
- N1原GPU-only world0问题已按同帧COPY_READ_BUFFER读取修复，56纯合同和actual micro3/128MiB+4拒绝通过；完整当前383 ABBA仍未重跑。S2独立mode已实施，66合同通过；plan2未运行，65,536records/128MiB metadata预注册、per-frame成本门、仅跨A/B RGB≤1/alpha0，其余/自然AA exact；原N1默认56合同与protocol保持。
- ROI `gi-receiver-roi-prepare-1/roi-preparation.json`已离线准备，bake=false/resultnull，原env798/866611与灯保持、33/24498目标未绑定。后续实际observe→bind→重开validate→Store唯一fresh capture→CPU→SOURCE/DIST→Viewer仍全部未跑；原fullenv固定10min UV失败保留。
- 后续必须完成：build17与真实B9/native结论、P1真实Home、E3新五对、N1/N3判断和S2四臂、ROI中型全链、最终CI/lint/loading/lighting/phase2/P2/P4/清单。新tests/commands登记进行中，inventory尚未刷新，不能拿先前932条统计作当前最终结论。原两条被自动审核拒绝清理的旧npm junction继续保留，不绕过删除。
