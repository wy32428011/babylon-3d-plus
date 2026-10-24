# 当前 create 归因与两个内核候选执行记录

状态：已按门禁执行并停止。候选1语义否决，候选2未复现完整collector净收益；两项均未合入产品，真实ABBA未触发，Q2未进入。

用户授权：按上一轮方案顺序，先拆清当前 create 语句/分配热点，再按证据逐个验证私有未使用 claimed Set 惰性分配、精确字节比较展开；行为对照及完整 collector 净收益成立后才做真实 ABBA。质量、脚本、MQTT 不变，关闭路线不重启，不进入 Q2，无净收益停止。

## 验收清单

- [x] 当前产品/冻结B/原工厂输入核对，保留已有未提交修改。
- [x] 诊断副本由 final Q1 build5 的1024源码及853交付文件复制，原冻结目录不写。
- [x] 当前来源行级CPU和包括短命对象的分配归因，明确不作FPS比较。
- [x] 候选1行为oracle与错误变体RED；3个pre-import反例成立，候选停止，完整collector NOT_REACHED。
- [x] 候选2行为oracle、错误变体RED、完整collector交错计时；两组未复现稳定净收益，保留原实现并停止。
- [x] 执行ABBA门禁：没有候选通过，真实ABBA均为NOT_REACHED，没有把门禁未达记成通过。
- [x] 最终产品范围、回归/构建与输入完整性、任务资源清理、结论及剩余限制交付。

## 当前计划与证据

输出根目录：`output/render-optimization-create-kernels-20261024`。原分析报告 `2026-10-24-factory-main-thread-hotspots.md` 及全部旧失败证据只读。A基线仍含用户批准的L2；两候选独立评估，不复活同轮memo/物化/descriptor-only/路径缓存等已关闭方案。

诊断在独立 diagnostic-app 以相同源码生成 minify=false、sourcemap 的renderer，Electron和Viewer沿用冻结交付；CPU line ticks仅定位，HeapProfiler以32768字节平均采样间隔并包含Minor/Major已回收对象。不改heap参数、不强制GC、不改业务频率。候选oracle由独立分工在set-oracle/和byte-oracle/准备；第一阶段完成前不运行候选或性能试验。

首次诊断build因复制清单遗漏两个App raw示例JSON而失败（原日志保留）。两份补充输入已从当前文件读取、通过冻结B主bundle中AST字符串literal逐字匹配，SHA和来源记入baseline-source-manifest.json.additionalBuildInputs；不改示例内容，第二次构建exit0。两项补充也已纳入1026行运行前后fingerprint。这是诊断副本准备问题，不作产品失败或性能证据。

完整collector计时包含provider和wrapper，行为指纹/trace不放在计时段内；错误变体必须可红。任何getter/iterator/构造器/重入/异常/输出身份差异即否决。同一候选连续两次无净收益即停止，不靠削弱guard或新变体重试。正式运行前检查独占资源，禁止并行构建/测试/烘焙扰动。

## 第一阶段结果与候选1停止

当前source不变的非压缩CPU+allocation诊断已passed=true并正常关闭app/broker。create行级ticks共6121，组件复制代表位置1009（16.48%）、thin-instance递归展开代表位置726（11.86%）、moving/fixed Set构造360（5.88%）。这些是生成JS行级归属，不是逐TS语句精确ms；部分生成行跨多个TS位置。加权create self为8.726s，仅适用于本诊断，不与旧生产profile的7.917s拼接收益。

heap节点selfSize估计总17,013,131,248B、create子树10,422,311,892B；包括已回收对象，不能当retained/峰值内存。heap frame指向函数声明，不能分到claimed某一只Set；独立分组将create直接Set与resolver内Set分开。CPU与heap包络不同、探针影响以及source-map首段代表映射均保留为限制。证据current-create-attribution.json及attribution-audit/。

候选1旧模块自检18/18、三个错误变体全部RED；完整候选15/18一致，pre-import Proxy、子类和global Set getter三个场景失败。正常入口的静态初始化顺序不能认证任意pre-import realm，不放宽合同、不新增探测、不改skip，直接停止；Set性能计时和ABBA未达到。真实产品与冻结输入不变。

## 候选2语义门槛与完整collector准备

naive4负控制为FAIL_ORACLE（4个差异、旧expected失败0）；guarded4为PASS_ORACLE（231例、0差异），从完整实际候选source提取再测仍231例0差异。只采用4-word一个正候选，没有启动8-word变体。完整候选SHA44e4ac19c77e1f46a7d242bbd304afc35387d55fa46a94b93062040240fd373b，仅输出目录，不写产品。

正常minified byte-probe-app已构建并冻结（1026 source、853 bundle）；只加入共用选择器与baseline/candidate两个精确内核，真实getSources/provider不替换。完整collector筛选在不连接MQTT的真实工厂中进行，两组各7对交错测量、指纹及Mesh/instance引用在计时外核对；两组在同一已热身renderer，非两次独立App或正式ABBA。真实运动/MQTT ABBA仍须筛选净收益通过后才运行。

## 候选2完整collector结果与停止

`byte-full-collector-1/result.json` passed=true，profile=false；原场景/录制/116资源、probe artifact和harness前后均未漂移。末次返回42,856条来源，14对完整entry/字段存在性/顺序/world及Mesh/instance引用对照全部一致。没有以纯kernel微测代替真实provider+wrapper+collector。

| 筛选组 | baseline中位数 | candidate中位数 | 中位数变化 | baseline均值 | candidate均值 | 均值变化 | candidate较快配对 |
|---|---:|---:|---:|---:|---:|---:|---:|
| 1 | 278.1ms | 281.8ms | +1.3305% | 306.9857ms | 277.6714ms | -9.5491% | 3/7 |
| 2 | 273.4ms | 269.5ms | -1.4265% | 304.1571ms | 306.8286ms | +0.8783% | 4/7 |

两个中位数方向相反，均值方向也相反；合计7/14配对较快。组1有baseline494.4ms，组2有baseline520.9ms及candidate545.3ms等长样本，全部保留，没有删除或无跟踪依据地归因GC。计时外fingerprint的分配仍可能影响后续GC，两个组也不等于两个独立app；因此不能把组1的均值下降单独宣称为生产净收益。

按照既定门槛，未复现超出同臂波动且重复同向的完整净收益，guarded4停止并保留原实现；不扩8-word/其他新变体，不追加硬件轮次。两候选都未达到真实ABBA门槛，正式运动/MQTT ABBA为NOT_REACHED，而非通过或漏跑。原正式Q1的6.8167 FPS/约282.738ms每次收集继续是既有证据，本轮没有新FPS收益结论。继承的5秒never-connected固定窗只作收尾，其12.2 FPS与CPU+Heap诊断的6.05 FPS均不得与原60秒运动窗口比较。

## 最终验证和交付边界

- 全部1024份冻结B产品源码/配置与当前workspace最终逐字节SHA一致，changed=[]：`final-product-integrity.json`。没有产品改动需要撤回，候选仅保留在输出实验目录，root未加入选择器或开关。
- 正常非压缩诊断build与正常压缩probe build均exit0；oracle运行和源码提取对照、独立CPU/heap/性能复算见原始文件。没有重跑与未修改产品无关的全套回归、安装器或发布。
- 两个真实app均正常退出，专属broker已关闭；最终精确本轮路径进程查询0。没有全局kill、提交、推送、外部部署或新烘焙；关闭候选保持关闭，Q2未进入。
- 当前CPU/heap位置口径已独立复核。10个生成行、1314ticks包含多个TS候选，不能唯一映成TS语句；heap frame是函数位置。heap.samples.size与node.selfSize相差7,415,016B，原始差异保留，不强制对齐。详细限制见attribution-audit/report.md。
- 本轮诊断wrapper正常路径完整收尾。其异常CPU/heap停止状态未分别跟踪的P2仅影响失败时部分allocation证据保存，当前成功结果不受影响；该工具仅为本轮隔离诊断，不宣称生产可复用工具成熟度。
- 静态code-reviewer审查无HIGH/CRITICAL；byte loop、实际probe调用链及计时/恢复边界已独立核对，性能结果独立复算另存perf-audit.json。

关键证据：`current-create-attribution.json`、`attribution-audit/`、`set-oracle/semantic-review.json`、`byte-oracle/{naive4-red,guarded4-result,guarded4-actual-source}.json`、`byte-full-collector-1/{collector-benchmark,result}.json`、`final-product-integrity.json`。全部位于`output/render-optimization-create-kernels-20261024/`。
