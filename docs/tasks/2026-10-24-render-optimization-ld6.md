# Q1 / LD6 准备阶段着色器预编译

日期：2026-10-24。当前为默认关闭的候选，不能记作 LD6 已完成或性能收益。

## 原方案与验收

原方案要求在准备蒙版期间有界预编译货物模板、效果克隆常用变体、阴影深度、GI 插件材质；实际首次货物/报警帧尖峰下降，准备耗时增量另列。用户要求画质、脚本和 MQTT 行为不变。不能用 `programsReady`、单元测试或普通无阴影材质，替代真实接收阴影、GI/探针与报警变体的覆盖和收益。

| 要求 | 实现与证据 | 状态 |
| --- | --- | --- |
| 准备生命周期与进度 | SharedCache 预取成功后登记模板；Readiness 的 shaderWarmup 阶段位于原 firstFrameValidation 前；内部开关不写入场景或 UI | 候选已接，默认 off |
| 有界并发与取消 | 默认并发 2、上限 4；64 programs/64 containers；2 秒软预算；拥有的 16ms 轮询可取消；同步 driver 调用不可强制中断 | 33 项本地功能覆盖通过 |
| 自有资源释放 | 临时 SubMesh 不加入 mesh；只 reset 自有 draw cache，避免原生 dispose 的 splice(-1)；Effect 引用和原 Observable token 生命周期受控 | 真实 Native 单元控制通过 |
| 自定义输入/公开 hook | Standard/PBR 原生 API、实际 pluginManager 和固定内建配置、材质/网格/纹理/灯/ShadowGenerator 的公开调用前守卫；await 后重核输入 | 4 个具体 P2 已修；未知输入保守跳过 |
| 实际未来变体 | 当前仅模板实例路径；receiver flag、GI/探针代理、报警材质不等于模板路径 | 普通模板已核，完整变体未验；用户批准本轮保留原路径 |
| 净收益 | 需实际首次生成/报警尖峰和准备增量；同构建冻结输入与 ABBA，无并行测试/构建 | 未开始正式性能采样 |

## 已确认的 SDK 约束

- Babylon 9.12 的 `forceCompilation` 使用没有取消入口的自重排和材质全局 hot-swapping 状态，候选用自有有界轮询并在每次调用的 `finally` 恢复原值。
- `SubMesh(addToMesh=false)` 不在业务数组内，直接原生 `dispose()` 会删除业务最后一个 subMesh；这里只归还拥有的 draw cache。
- 内建 Standard/PBR 插件不是零个。真实字段为 `pluginManager`，只检查 `_pluginManager` 会漏掉自定义插件；固定内建 config/manager 引用及数组需要对照。
- ShadowGenerator 的 caster 深度准备不等于 color receiver 变体。实际接收阴影定义受 `receiveShadows` 控制；未来 GI 代理还会克隆并安装 `BakedLightingMaterialPlugin`，不能从模板准备成功推断命中。
- 有限公开 API 守卫不是任意 Proxy 反射、私有对象图或外部旧引用的普适等价证明。

## 证据与版本

- helper SHA：`bc90ae81619a8c9b7d24cae840dca9927c31c444e8d5b6c0c37e0726c91bd63b`。
- 33 项含子例回归：`output/render-optimization-q1-20261024/ld6-fixes/final-green.log`。19 顶层测试；ESLint 和有限目标 TypeScript 检查通过。
- root 独立审查：`output/render-optimization-q1-20261024/candidate-independent-review-final.json`，结论 `APPROVE_DEFAULT_OFF_ONLY`；不提前启用。
- build5 已包含候选 off 与原首帧检查；真实混合 GI DIST Viewer 已通过。这只证明默认路径组合运行，不能证明开启候选的覆盖或收益。
- 功能覆盖诊断单独记录于 `output/ld6-coverage/`，不与正式性能样本混用。

没有改样本数、分辨率、材质、脚本、MQTT 规则或消息顺序来获得收益；没有为了候选启动新 Blender 烘焙。未进入 Q2。

## 实际模板覆盖诊断收束

output/ld6-coverage/final-review.json绑定267执行模块和30输入不漂移；真实托盘普通管线两PBR实际Effect身份命中、first-cargo createEffect miss 2→0。两臂3,168,000 RGBA分量差0，真实拾取/完整分类归一后相同；root已打开代表PNG。此为功能覆盖计数，不是速度或净收益。

实际active InstancedMesh/source receiveShadows仍false，与classification true不同，两臂相同，故没有receiver=true覆盖；native depth readiness有命中，但baseline可见host已填同一depth cache，不能宣称该增益。GI组虽然原几何签名相同，完整照明签名不匹配，state=false/probe bindings0，明确BLOCKED；fallback像素差0不是有效GI证明。报警未触发。首失败及四臂raw全部保留，未新bake或改资源来求通过。

当前setEnabled(false)停止未来准备并取消pending，已完成bounded cache保留至source/Scene dispose；同Scene切off不能还原冷cache，正式A/B必须独立context/Engine。本次所有context/Chrome/server已finally关闭，无清理失败。root已请求用户选择两项新边界的收束方式，答复前继续defaultoff，不宣称整项完成。

## 用户批准的交付收束

用户已明确选择严格等价优先：保留原运行路径，候选defaultoff，记录缺口并交付其余Q1。当前候选不计入已验收优化/收益，不继续本项实现或性能采样。本项新边界选择已解决，不再重复询问；原局部证据、失败与限制保留。
