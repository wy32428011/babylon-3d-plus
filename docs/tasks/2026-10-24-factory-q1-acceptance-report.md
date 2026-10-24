# 工厂项目业务一致性与最终 Q1 ABBA 性能对照报告

本报告日期为2026-10-24（Asia/Taipei）。本轮没有修改产品代码、原场景、原资源/脚本或原MQTT录制；仅增加验收工具与报告。没有进入Q2，已关闭候选保持关闭。

## 结论

1. **已完成真实Editor业务与四轮ABBA执行。** 两版本各两次运行、停止、回首页、重开循环；原任务交接、新任务正常运动/故障冻结/恢复、身份拾取及清理的已定义主业务门槛通过。
2. **本工厂未复现Q1新增稳态性能收益。** FPS两轮均值6.8583→6.8167（-0.61%），P95基本持平，P99方向混合。少量样本不足以证明统计非劣性、显著性或严格等价；没有把小幅下降写成确定回归，也没有抹去负向结果。卡顿仍在。
3. **输入及已捕获关键字段相符，但完整逐时刻/逐帧认证未建立。** 动态帧步长下的位姿差、角色缓存建立窗口和原始像素差均原样报告，没有以同源码或空缓存替代实测等价。
4. **工厂DIST/Viewer被原发布前置条件阻塞。** 真实最终版发布入口已执行并拒绝bake.enabled=true/result=null的输入；没有新ZIP或Viewer运行证据。用户已明确选择保留发布阻塞证据，本轮先交付Editor业务与ABBA；工厂DIST/Viewer成功路径延期，不启动全厂CPU烘焙，不改变模式或绕过校验。

## 版本、工厂与实际条件

| 项目 | 实际值 |
| --- | --- |
| A | 已通过Q0且含L2安全替代的candidate-1-app；不是旧的未含L2 baseline-app |
| B | 本轮final-q1-app，来自最终build5；完整1024源码/配置+853产物冻结 |
| A冻结文件 | 1010源码/配置+851产物；各轮前后校验通过 |
| 工厂 | 原version6、370实体、116资源/脚本文件、225756283 bytes；全部SHA保持 |
| 原录制 | 1334条、69.4789322秒、94个topic；正式窗口只取原t0起60秒，不加速、不移时、不预填 |
| 硬件 | Intel UHD630 / ANGLE D3D11 / WebGL2，DPR1 |
| 渲染条件 | 引擎buffer 2560×1440；固定saved-close镜头、FOV/viewport/AA/stencil/imageProcessing及效果层状态一致 |
| 截图条件 | 实际窗口1920×1080；不能把窗口或带窗口外黑边的element截图当作整个2560×1440 buffer的像素证明 |
| 照明 | 原shadows.performance、bake.enabled=true、result=null；没有已应用GI |
| 关闭项 | 动静合批false、L2 direct；A没有LD5/LD6 API（null），B明确false，不把API不存在伪写为false |
| 隔离 | A1→B1→B2→A2串行；21个工具冻结不漂移；本任务没有并行构建、测试、业务/PNG分析、发布、烘焙或profile |

A/B的原场景、资源、脚本及录制保持，只在各轮独立工程和userData中重定位本地路径及loopback MQTT endpoint。原工作区和冻结产物前后均未漂移。未清OS文件缓存，不能称完全冷磁盘缓存实验；隔离证据不等于完整OS外部负载遥测。

## 真实业务一致性

两臂各2个循环、每循环21项原检查通过，独立离线审计又从原始capture、实际broker记录和Node/renderer时钟复核关键门槛：

- 原task201实际经过1003→RGV1→1004，保持同一真实cargo root、owner、model、modelRoot/contentRoot及3个导入网格条目（其中含根条目）；无同task重复root，无readiness错误，使用原托盘生成器，没有fallback冒充。
- 原录制没有故障，因此另用原1003完整EPV模板、同类型新task900201，独立生成normal→fault→recover合法补充报文。原movement/mode/光电字段保持；其他宿主用原末状态，ts/seq严格递增。正式ABBA绝不使用这组补充输入。
- 新生任务前先通过原mode2/双无货输入实证1003无货，排除给旧货改task后在端点静止。首次模型ready后的尺寸clamp不作为正常运动的唯一证据；独立要求首次offset变化之后、实际故障被观察之前仍有新的位移。
- 四个循环故障期间，同一货物的offset及root缓存世界XYZ平移span均严格为0；恢复后再次有位移，root/owner不变。计划故障边界是1000ms，首次观察到已应用fault约1174–1268ms；没有把计划时间当精确应用时间。
- 货物最近几何拾取的owner/host metadata匹配；原场景未配置货物点击事件，正式事件查询仍为null。原数组设备使用公共实体包围盒与runtime拾取映射验证，没有虚构proxy.meshes列表。
- 停止后cargo/owner/generated meshes清零，重新打开同一复制项目、使用新broker原点回放后再次通过；新循环为新逻辑身份。
- 四循环原录制均1334次publication/1334次delivery，逐条index/topic/payload一致；每循环3条清空+24条新任务补充共27次publication/delivery，逐条与保存输入相符，failure为空。这不等于完整生产broker验收或所有脚本级消费频率的逐帧认证。

归一只处理明确的随机对象标识、owner UUID及复制路径，保留别名关系；不删除材质值、可见性、局部变换、角色或resourceIdentity。已捕获结构、材质、局部变换、世界矩阵线性部和非空角色值差异0。数组proxy的physicalMeshes=[]是原实际表示，不等于直接逐mesh检查了全370实体。

**严格边界：** 900201新生时A每轮1次、B每轮2次cached-lighting stale/角色暂空，之后建立相同2行角色，故完整生命周期逐帧角色等同未建立。宿主首/末已加载观察也不是同墙钟终态；1004末观察X差约+0.09393m/+0.04425m，RGV末观察Z也有差异，完整值未屏蔽。这些不能单独判为回归，亦不能写成逐时刻轨迹相等。

ready原始窗口图A/A重跑361/2073600像素不同，A/B463/2073600不同；没有mask或自选阈值。差异含性能HUD及三个厂内红字区域，A/A也在相同区域变化。原led.model.ts确有按engine deltaTime、125px/s推进的滚动显示，未同步两app脚本时钟；这支持保留动态相位口径，但未逐像素追溯所有调用链，不把所有差异一概归因，更不称pixel0。

## 正式ABBA性能

| 指标 | accepted Q0 A两轮均值 | 最终Q1 B两轮均值 | B/A变化 |
| --- | ---: | ---: | ---: |
| FPS | 6.858 | 6.817 | -0.61% |
| P50 帧间隔（ms） | 80.35 | 80.55 | +0.25% |
| P95 帧间隔（ms） | 414.65 | 415.10 | +0.11% |
| P99 帧间隔（ms） | 478.20 | 469.60 | -1.80% |
| 已保留长任务与窗口交集（s） | 53.023 | 53.113 | +0.17% |
| getSources inclusive（s） | 25.537 | 25.729 | +0.75% |
| 每次 getSources 均值（ms） | 282.179 | 282.738 | +0.20% |
| getSources 次数 | 90.5 | 91.0 | +0.55% |
| 模型刷新次数 | 66 | 66 | 0.00% |
| UI 全量分类次数 | 0 | 0 | 两臂均0 |

| 轮次 | FPS | P95 ms | P99 ms | 保留长任务交集 s | getSources inclusive s |
| --- | ---: | ---: | ---: | ---: | ---: |
| A1 | 6.9167 | 409.2 | 476.3 | 52.6296 | 25.4129 |
| B1 | 6.7833 | 420.2 | 488.3 | 53.2174 | 25.9390 |
| B2 | 6.8500 | 410.0 | 450.9 | 53.0080 | 25.5193 |
| A2 | 6.8000 | 420.1 | 480.1 | 53.4162 | 25.6614 |

打开操作至资源准备遮罩消失的墙钟均值为A **89.280s**、B **88.697s**（-0.65%）。它不含app bootstrap、选工程和随后运行/热身，不是TTI，也不证明缓存命中收益。两轮分位数取算术均值，不是把两轮帧合池后重新求分位。

FPS从afterRender完成帧时间线在固定(start,end]独立计数；帧间隔分位采用含首尾窗外邻帧的完整相邻间隔。getSources是实入口inclusive聚合，包含来源准备与嵌套collector，可能含跨窗末尾同步尾部；没有单次调用日志可独立重新加总。长任务仅对采集器保留的、起点在正式窗内的区间精确裁切，跨窗头task未捕获。它们不等于独占CPU或完整主线程忙碌时间，也不能彼此相加。

每轮模型刷新66次，UI全量分类0。两臂已经都含获准L2，因此不能把上一阶段L2相对更旧版本的收益再次算作本轮Q1增量。getSources仍约282.7ms/次、累计约25.7s，当前分类与长任务卡顿没有被本轮Q1解决。

源t0 60秒各轮publication/delivery/callback均1151，顺序0..1150，无缺口/重复，pending0。正式renderer窗publication/delivery各1133、callback1150；原因是正式窗较原点晚约28–55ms，部分入窗前投递在窗内才回调，不能把边界差额叫丢消息。尾部截图/关闭期间的raw总数不混进正式统计。

本工厂20个GLB的JSON图像/扩展及库存未发现KTX2/basisu，亦无已应用GI；Editor稳态不触发DIST传输压缩、新烘焙几何格式或新建场景默认。不能用分项KTX/二进制/压缩百分比外推或叠加成这个工厂的FPS收益。每臂只有2轮且方向混合，**性能测量有效，但未证明新增可复现稳态收益或统计非劣性**。

## 加载与首货观测的补充口径

同App回首页重开到第二轮原回放开始，A103.704s、B102.547s；包含固定10s热身和准备，缺少cache-hit/0decode证据，不称缓存命中启动。已有数据能观察Broker本地delivery到匹配host/task/root首个真实model-ready保存观察的时差：原首货task331两轮A958.389/925.700ms、B1164.240/853.733ms；fresh900201为A153.420/125.512ms、B131.807/137.089ms。task201是原331已ready root的逻辑复用，不是首个GLB加载。

这些指标没有renderer receive或最终presentation标记，受帧观察粒度影响，不能称设备到可见延迟、单次clone/decode CPU、首货可见帧尖峰或TTI。原始依据另存startup-first-cargo-audit；不为填表把缺测值编成0。

## 发布与环境问题

当前原工厂bake.enabled=true而result=null。真实冻结B的buildDigitalTwinDistPackage→prepareDeploymentExport明确拒绝：“混合光照尚未完成材质与间接光烘焙，请先开始烘焙。” accepted Q0和Q1的共享合同对原输入给出同一错误，属于原输入前置条件，不是本轮新增门禁。没有切模式、降低参数或伪造结果；无工厂新ZIP、无实际Viewer初始化/回放证据，用户已确认本轮保留该阻塞、先交付Editor业务与ABBA，工厂Viewer延期；成功路径不计作已验收。

Editor两臂每轮有15条unknown-scheme错误和3个堆垛机/12个排号明确Logo Warn，都是editor-image://platform/zdznheng解析失败。PNG实际本地存在且SHA相同，不能写物理文件不存在；旧日志没有requestfailed URL，不能声称逐请求已配对。原脚本onError会隐藏Logo，这是两臂共有既有降级，本轮未扩修，不作为平台Logo或现场画质验收通过。外部Fetch、远端图表与生产MQTT未验证。

发布attempt1为工具子进程环境问题（native134），unset ELECTRON_RUN_AS_NODE后进入compiled JS，仅证本机规避；attempt2被额外计划预检查拒绝；attempt3确实先走真实发布入口并触发上述门禁。三次原始失败和清理记录均保留，不算Viewer成功。

## 复核、证据及收束

独立性能审计119项校验通过、0完整性问题；业务与像素审计另由独立分析复算。正式源数据、比较文件和历史失败保留，所有实际app、broker和发布子进程均已关闭，精确任务进程查询无残留。隔离证据支持本任务串行，不声称排除了所有OS外部负载。没有提交、推送、外部发布或进入Q2。

- 本机主证据目录：output/render-optimization-q1-factory-20261024/
- 比较数据：comparison.json；正式顺序/命令/PID：formal-ledger.json。
- 业务：analysis/business-report.md、business-comparison.json、mqtt-input-audit.json、startup-first-cargo-audit.md。
- 性能：performance-audit/independent-audit.md、independent-audit.json、source-sha256.json。
- 原始4轮：runs/A1、B1、B2、A2中的result.json、mqtt-raw.json、input-audit.json。
- 发布门禁：viewer-tools/runs/attempt-3/package-error.json与package.log；两版本合同：preflight/publish-precondition-comparison.json。
- 图像：analysis/pixels/report.md；原图与差图仅为证据，不用动态区差异替代严格全帧认证。

原A-attempt-1两循环因测试工具错误假设proxy.meshes非空而FAIL，保留但不计入修正工具后的成功；其原回放前ready图仅作为同Q0版本A/A图像控制。
