# 后续优化阶段实施与验收记录

日期：2026-10-14。工作区基线为 master / 830f788，保留 S1 的全部未提交改动。用户授权按顺序执行 S2、S3、S4、S5 和 T；不提交、不推送，不触发线上发布或 Git 历史维护。

## 当前检查点

| 阶段 | 当前状态 | 证据与边界 |
|---|---|---|
| S1 | 本地完成，远端 CI 待验证 | 631 项单元和完整容量聚合通过，详见 [S1 记录](optimization-s1-validation.md) |
| S2 | 已完成（本地基线） | 两入口报告、Editor 3冷/10暖/9窗口、Viewer 3冷/10暖/6窗口及iframe通过，输入与画布条件固定 |
| S3 | 已完成（本地） | 开发路径、缺失产物自愈和编译去重已验证；deep import实测不采纳 |
| S4 | 已完成（测量与决策） | 三状态真实profile通过；无满足兼容/收益条件的局部候选，保留原运行时 |
| S5 | 已完成（本地） | 纯表达式职责提取；23项窄组、SOURCE/DIST与最终Editor/Viewer回归；无新增状态/循环依赖；最终9窗口通过既定保护门槛 |
| T | 已完成（本地门禁） | 70旧细分入口0遗漏；core/integration/smoke、局部覆盖率及渐进类型规则；默认组不是全仓；284未确认候选仍显式保留，远端CI未跑 |

## S2：分析和真实基线

新增 scripts/build-analysis.mjs、scripts/build-analysis-plugin.ts，分别为 Editor 和 Viewer 生成模块 treemap、最终文件体积/gzip、静态初始 JS 闭包、动态 chunk 与构建子阶段记录。普通构建不启用报告 hooks，分析报告位于产物目录之外；测试 2/2 通过。

构建基线：output/bundle-analysis/2026-10-14T09-54-46-379Z/。

| 指标 | Editor | Viewer |
|---|---:|---:|
| JS 原始字节 | 14,134,140 | 13,295,192 |
| JS gzip 字节 | 3,580,686 | 3,358,414 |
| 静态首批 JS 原始字节 | 10,576,550 | 9,737,602 |
| 静态首批 JS gzip 字节 | 2,582,672 | 2,360,413 |
| 分析构建进程耗时 | 8.072 s | 8.156 s |

耗时包含分析和压缩计算，不能当成正常构建性能；首批指标不包含 CSS、图像、模型和运行时请求。Viewer 能力清单的 119 个签名文件及 10 个开场素材已核对 size/SHA-256，报告未进入签名包。

真实输入来自既有工厂 SOURCE 工程包：370 个实体，archive hash 核对成功，107 个解包条目，77 个资源按原 Viewer manifest 校验；只在 output 内建立工程副本，原资源不变。通过实际项目选择 IPC 建立授权并使用原服务地址配置；没有修改资源校验来适配基线。

历史 Viewer 场景直接重定位、缺项目上下文和缺服务地址的试跑均失败，保留记录，不计有效性能样本。有效试跑确认 Intel UHD Graphics 630 / ANGLE D3D11 / WebGL 2，DPR 1；Editor 实际 Canvas 为 824×440，记录窗口与 Canvas，不与旧 4K 结果混比。

scripts/smoke-extreme-scene-performance.mjs 增加测试专用 project-root 与 warm-opens，资源失败即时拒绝；采样补充 draw calls 和有界 LongTasks（溢出显式记录）。cold 定义为独立 Electron/userData，warm 为同一 Electron/userData 的 renderer reload；不清空 OS 文件缓存。真实 MQTT 只向本机 Broker 回放。

本轮全部原始日志、输入校验、场景副本、检查点及浏览器报告位于 output/optimization-all-2026-10-14/，不纳入提交。完整统计在采样结束后补入本记录。

## 已核对的候选和决策

S3 的单文件 deep import 实验只在 output 隔离配置中变换 sceneSelectionHighlight，不修改主源码。首批 gzip 2,582,672 → 2,582,634 字节，仅减少 38 字节；总 gzip 减少 45 字节，初始/总 chunk 数未变。ExternalModelScriptRuntime 向模型脚本提供完整 Babylon namespace，不能按静态引用擅自裁剪。结论为不采纳该候选，证据位于 output/s3-build-investigation/。

现有产物上的一次增量编译测量为 tsc -b 29.311 s、紧接 tsc -p tsconfig.node.json 2.765 s。后者存在重复启动/检查成本，但尚不足以宣称已得到稳定收益，也未据此删除独立入口的编译保证。

### Editor 当前版本的有效基线

3 次独立打开、10 次同进程暖加载和三种状态各 3×30 秒窗口全部通过。3 个进程的 inventory SHA-256 相同；DPR 1、实际 Canvas 824×440、Intel UHD 630 / ANGLE D3D11。

冷打开至资源就绪中位数 59.70 s；暖打开中位数 54.20 s。这里的冷热均按前述进程/用户目录定义，OS 缓存未清。

| 状态 | 三轮 FPS 中位数 | 三轮逐帧 P95 中位数 ms |
|---|---:|---:|
| edit | 20.78 | 59.20 |
| static | 18.54 | 65.80 |
| motion | 18.63 | 69.00 |

运动输入窗口实际通过本机 Broker 投递 645 条录制消息、0 失败，记录逐帧区间、LongTasks、CPU/GPU 和 JS heap；不是仅打开界面后估算。原始结果：output/optimization-all-2026-10-14/s2-editor-baseline/，汇总 s2-editor-summary.json。Viewer 的独立基线结果见下节。

### Viewer 当前版本的有效基线

3次cold context、10次同context暖导航及silent/motion各3×30秒通过，iframe完整就绪与截图通过，0页面/资源错误。Canvas 1440×900、DPR1、硬件renderer。Cold中位数 81.52s，warm中位数 59.19s；HTTP缓存因安全拦截禁用，warm仅表示同context和IndexedDB复用。

静止FPS中位数 21.84 / P95 56.10ms；运动输入 20.75 / P95 58.20ms。Viewer和Editor画布不同，不横向归因。

LongTasks保存观察到的条目；浏览器首次回调的droppedEntriesCount对应performance entry buffer的累计丢弃，不能直接当成30秒窗口内观察者漏采数量。参考 [W3C Performance Timeline](https://www.w3.org/TR/performance-timeline/)。不把该值加到窗口计数，也不以LongTasks条数作完整总量承诺。逐帧帧间隔和有效性检查独立保存。

## S3：构建和开发路径

开发资产路径优先显式进程变量，其次 `.env.local` 中的 `STACKER_MODEL_LIBRARY_ROOT`；历史 `F:/3d-models` 存在时保留兼容，否则回退 workspace。变量不暴露给客户端。3/3 测试和实际 HTTP 允许文件200、越界404、坏编码400通过。

缺失产物实验发现 TypeScript 6 composite 增量缓存的边界：在保留 tsconfig.node.tsbuildinfo、移走 dist-electron 后，`tsc -b` 报 TS6305；单独 `tsc -p tsconfig.node.json` 返回0却没有恢复产物；`tsc -b tsconfig.node.json --force` 才恢复。实验只在S1隔离快照执行，旧产物在 snapshot/output/optimization-compile-backup 可恢复。不能把原末尾的重复 -p 当成完整性保证；正在实现枚举预期产物、缺失时强制重建的最小编排。

S3最终实现采用 TS 公开 API 枚举全部204个预期Electron产物，任一缺失或非文件则本次 `-b --force`，完整则普通增量构建。正常build去除末尾重复编译，standalone和typecheck复用同一保证。真实临时项目3/3测试通过，覆盖旧行为复现、单声明与整目录恢复、输入更新、renderer类型错误及配置/参数失败。

3轮交替构建（Node直接执行旧/新流程；同机暖OS/依赖缓存，未启用分析）：旧42.67–44.75s、中位42.70s；新39.27–42.42s、中位40.38s。观察到中位约5.4%缩短，但样本小且有波动，不承诺稳定收益。编译输入与正常浏览器包契约未改，未声称加载/FPS提升。最终Viewer 109入口+10开场文件的size/SHA均匹配。日志 `s3-build-comparison.json`。

## S4：真实热点诊断和候选决定

同一SOURCE场景、同一硬件Canvas，edit/static/motion各15s CPU profile、React commit探针及细分遥测采样均通过，0页面/资源错误，截图与cpuprofile已保存。每个窗口16次React提交。V8采样驻留（并非OS CPU cycles）集中于render、活动网格求值、材质绑定，以及外部模型脚本getModelNodes/isDescendantOf。CPU/GPU周期采样和遥测阶段保留在 s4-profile/result.json；摘要 s4-decision.json 与 cpu-summary.json。

本轮不采纳新增RAF、全局冻结/降频、模型脚本遍历缓存和再增遥测缓存：没有已证明且满足动态业务契约的安全局部边界。保留原画质、DPR、动画频率、驱动和脚本。诊断轮启用profiler/React hook并额外reload，cold标diagnosticOnly，不能与S2无探针FPS直接配对，不声称FPS提升。未改运动/交接/报警/点击算法，未将本地录制回放当成现场端到端验收。

## S5：纯表达式职责提取

SceneRuntime保留3个private薄委托，原evaluateModelExpression/evaluateBooleanExpression/isVector3Value移到69行纯模块。仅两个type imports，无新增运行时依赖、状态或循环。11项契约先运行原方法再运行新模块，规范化确定性比较证明方法体一致。最终窄组23/23，0fail/skip/cancel；SOURCE/DIST真实Electron发布和绑定恢复集成退出0。日志 s5-focused.log、logs/s5-source-dist-integration.log。

既有string参数测试在首次Vite8 ssrLoadModule停住，15秒独立诊断确认；原组合运行保留被终止失败。仅将该test加载设施改为已有SSR build+临时目录import方式，保留3子测试全部断言，最终父子4项通过。没有改变产品参数语义。

## T：入口和渐进规则

70个既有细分入口及命令被冻结并审计，0遗漏；test:ci有意改为npm test→core。默认core仅包含digitalTwin与本轮工具/表达式/runner组，integration为现有SOURCE/DIST集成，smoke为现有完整容量聚合。其它legacy/manual/external仍保留独立入口，不计为本轮执行通过。覆盖率仅新纯表达式模块观察：11/11、line100%、branch97.87%、function100%，不合并临时tsc/Electron/浏览器。

主src开启noImplicitOverride/noFallthroughCasesInSwitch，先诊断9个override缺失再仅补对应标记；新模块及其类型依赖用独立tsconfig.quality开启noUnusedLocals/noUnusedParameters，exit0。全仓旧unused项不在本次范围，测试TS范围与应用类型检查分开说明。

最终回归初轮曾在tsconfig写入期间并发运行Vite SSR：日志明确changed tsconfig→reload→transport disconnected，容量超时exit1，core受影响挂起后按已核对PID终止；这些不计通过。已冻结配置重新执行core与容量。独立审阅还指出runner父失败而后代继续运行的清理缺口，正在补真实后代回归，完成前T不标验收通过。

### 最终SSR设施修复边界

冻结配置重跑仍出现首次模块加载停滞，故初轮配置重载只解释一部分失败，不能作为完整根因。独立单变量实验：ws:false与独立cache均不能解决轻模块停滞，watch:null可立即完成；重SceneRuntime在关闭watch/ws后28.148s真实加载通过（未增加60s烟测限额）。当前根目录watcher内部停滞机制未完全定位。仅对已执行core/容量中的固定源码headless SSR setup关闭watch与不需要的ws；实际开发/浏览器热更新配置未改。

assetFocus的全Babylon noExternal开发SSR链仍长时间无法完成，改为已有SSR build+独立临时目录import设施，保留noExternal及全部真实断言，包含createEngine的动态加载入口，不将加载表达式替换计为业务逻辑变更。其余core出现的InteractionController/ParentOrigins也按同一headless setup规则修复。此前失败/人为终止及一次EXR缺环境变量产生的skip都保留日志，不算验收通过；最终core明确注入同一原始EXR输入后重新完整执行。

## 最终验收检查点


本轮按 S2 → S3 → S4 → S5 → T 完成本地实施及必要回归，保留全部既有改动，未提交、未推送、未发布。完整过程、失败及边界见[分阶段验收记录](C:/temp/babylon-3d-plus/docs/optimization-stages-validation.md)；机器汇总为 [final-summary.json](C:/temp/babylon-3d-plus/output/optimization-all-2026-10-14/final-summary.json)。

- S2：两入口 bundle/module/chunk/gzip 报告；Editor 与 Viewer 各3冷/10暖，分别9/6个稳态窗口；真实 WebGL、MQTT本机录制回放、CPU/GPU/heap/LongTasks。追加三状态 React 提交计数和CPU诊断，不将带探针轮与普通基线直接混比。
- S3：显式环境变量优先、.env.local定向读取、历史目录存在时兼容/缺失回退workspace；路径200/404/400真实验证。枚举全部204个Electron产物，缺失时强制重建、正常增量；standalone/typecheck不丢保证，正常build不再末尾重复编译。
- S3耗时：三轮旧流程中位42.70s，新40.38s，观察到约5.4%缩短；样本小，不承诺稳定收益。deep import首批gzip只减38字节，未采纳。最终分析补齐811个tracked/非忽略新增构建输入身份，并在全部写入完成后统计产物。
- S4：热点包括渲染、活动网格、材质绑定及外部模型脚本遍历；没有证据支持安全的新调度/冻结/缓存边界，保留原实现。AVIF、全局冻结、降频和驱动改写继续为条件项。
- S5：69行纯表达式模块，Runtime保留3个薄委托。机械比对原实现一致；缺参、除零、类型、向量身份、布尔空集合、求值顺序和异常隔离均保留；不拆scene/history原子更新。
- T：70个旧细分入口及命令0遗漏；test:ci转发npm test→core。默认core657/657、0fail/skip/cancel；integration保留Electron编译前置，smoke保留完整容量聚合。runner真实父失败/后代存活回归5/5，失败/取消/超时有界终止本次进程树。

最终验证：

| 验证 | 结果 |
|---|---|
| 核心组 | 657/657，0失败/跳过/取消；其中原digitalTwin单元631/631 |
| 参数/恢复窄组 | 23/23；与core存在交集，不相加冒充独立总数 |
| SOURCE/DIST与绑定恢复集成 | 真实Electron执行退出0 |
| 完整容量聚合 | 6个脚本完整退出0 |
| 正常build、Editor/Viewer分析 | 全部退出0；三个输出完整；Viewer109入口+10开场素材size/SHA匹配 |
| 类型与lint | 完整build类型阶段、局部unused检查通过；lint0error/181原有warning |
| 格式/清单/入口兼容/差异检查 | 通过；清单660候选文件、592测试候选、68支持文件，308静态可达、284未确认、CI静态可达94 |
| 覆盖率 | 仅纯表达式模块：line100%、branch97.87%、function100%；不合并临时tsc/Electron/浏览器 |
| 最终真实Editor | 新bundle，三状态各3×30秒、同inventory/相机/824×440 Canvas/DPR1；通过事先固定的FPS/P95保护门槛 |
| 最终真实Viewer | 新bundle、完整就绪、静止/运动及iframe通过；缩短功能轮不冒充完整新性能基线 |
| 保留验证 | Git index字节不变，原文件无丢失；81个受保护文件及原始EXR哈希不变 |

最终Editor三轮FPS中位数：edit 20.53，static 18.40，motion 18.67；逐帧P95中位数：edit 60.40ms，static 66.70ms，motion 66.10ms。这里证明保护指标未越界，不声称FPS已提升；暖加载抽测1次，不能替代S2的10次基线。

追加Viewer同流程短轮对照：silent FPS 18.86→19.67，P95 66.10→66.00ms；motion FPS 17.87→18.46，P95 72.10→68.00ms。每状态仅1个15秒窗口；两版输入/采样流程一致，按预先沿用的5%门槛判断，不能据此宣称稳定FPS提升。

失败及剩余边界：

1. SSR初轮受到tsconfig重载及headless watcher影响；仅关闭固定源码测试所不需的watch/ws，特殊相机/字符串测试改实际SSR build导入。10测试438处assert调用与HEAD完全一致，没有增加超时或跳过。此前失败/终止日志保留。
2. 曾出现一次开场包rename EPERM；独立7/7及最终完整组通过，未确认占用来源，未以产品重试掩盖。
3. 远端CI、安装包/安装器、真实Broker/平台部署及现场端到端验收未执行；默认core不代表全仓测试。当前共103个npm scripts，保留细分入口是兼容决定。
4. S1隔离目录 C:/Users/WY/AppData/Local/Temp/babylon-s1-TWFwRN 仍保留用于恢复和验收；此前递归清理被自动审批策略拒绝，未绕过。所有本轮测试服务/窗口与自建测试进程已结束。
