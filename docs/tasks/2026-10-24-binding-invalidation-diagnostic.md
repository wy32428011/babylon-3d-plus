# 保持绘制顺序的绑定失效诊断

状态：诊断完成，未找到已证明严格等价且可安全消除的有效私有冗余，按用户要求停止。未形成或实施产品候选，不做ABBA。原产品、质量、脚本、MQTT及绘制顺序不改，关闭候选不重启，不进入Q2。

## 验收清单

- [x] 核冻结B、SDK9.12及原17工厂脚本；记录全部已知force/cache赋值和reset来源。
- [x] 在新副本用Vite transform插桩，不写共享node_modules或root产品；保留原读取/赋值/callback与短路顺序。
- [x] 两个消费者actual transform的137例语义oracle通过，六个错误变体RED；producer与真实sink另验，不合并冒充通过。
- [x] 写点、reset、onBind重入/异常与真实counter sink审查/离线oracle；失败与修正版本分别保存。
- [x] 真实工厂原MQTT诊断，记录实际计数包络、调用覆盖、unknown与来源；不作生产FPS/ABBA。
- [x] 将缓存键不匹配、private重复write提示与可删除冗余分别判定，不推成GL program或相邻draw切换。
- [x] 没有严格等价删除依据，停止并保留原实现，不实施产品改动。
- [x] 独立复算/输入完整性与资源收尾，报告交付。

## 插桩与口径

输出根：`output/render-optimization-binding-diagnostic-20261024/`。基线取final Q1 build5，1024源+853交付；额外两raw示例沿用已与冻结bundle匹配的输入。原产品源不改，诊断副本仅增加Vite配置、虚拟probe模块和transform工具。两次隔离renderer构建已准备，后一次仅使Symbol/BigInt未分类值的source匹配保持unknown，不改变消费表达式。

静态来源已核SDK5个force写、7个cache写、27个reset调用点，另宿主detached source helper直接force=true。实际构建记录45个转换模块、13个write、86个markDirty/markAsDirty/reset调用点、2个消费者、1个reset入口和1个frame计数；这些是静态插桩覆盖，不是运行次数。

_mustRebind保留原method直接调用，force读取一次且返回原值；Scene base在原点按effect→material→visibility短路读取。force数来自Push，另三项是实际Scene base比较；委托/重入可产生额外base调用，四者不无条件构成绑定总数分区。单base同参/同结果只记base-observed，不认证outer callee身份；无base/多base/不同结果均unknown，所有nonforce outer identity未认证。

writer只记录已求值LHS receiver/RHS以及成功语句后的write-attempt，不新增旧值getter。缓存setter可能重入或改值，最后观测写与consumer实际值不符就unknown；shadow同值且消费前多写仅提示，不是purity/删除证明。onBind位于cachedMaterial/visibility写后、cachedEffect/force清前，原重入/异常顺序保持。callsite使用block/try/finally标记，原this、参数与方法lookup不重读。

原模型脚本不插桩、不改写；SDK/宿主setter间接进入已覆盖方法可见，动态脚本或未覆盖直接写保持untracked。私有counter有额外内存/栈/时序开销，不能拿诊断FPS或该副本当业务/性能等价验收。计数包络在原回放窗口附近独立start/stop，实际时长单列，不伪作严格60秒。

## 假设与停止条件

优先验证：force是否只是初始化/必要恢复；effect/material/visibility是否主要是原绘制顺序的真实变化；reset是否有同一消费前shadow全null重复及来源；LED重复字段赋值是否被SDK相等guard吸收。宿主light/shadow/grid/effects已有guard，不预设无条件重复dirty。

任何setter、callback、旧引用、未知override、partial reset、Matrix/DrawWrapper身份或MQTT合同无法严格证明的删减均不提出实施。若剩余工作是必要绑定或仅可观察同值写，停止，不改排序、材质共享/冻结、precompile或已关闭内核求收益。

## 诊断工具的验证、反例及无效尝试

消费者实际transform先通过137例，完整真实sink补齐到142例。新增delegate先捕获base异常再重试的两个用例发现v1漏记失败入口，aggregate与event标签也存在保守性不一致；用户可见行为虽一致，归因审计为FAIL，原始失败和source-v1保留。

run-1在计数/回放窗口开始前经精确专属DevTools端口的CDP Browser.close关闭，harness保留passed=false及Target closed，app/broker收尾true，标INVALID_ABORTED_BEFORE_COUNTER_SAMPLING，不使用其数据。没有终止其他应用或全局Node进程。旧frozen app1不改，修复版使用独立diagnostic-app-2。

v2在sceneBegin入口即记录base进入，return/throw只补状态；aggregate和event复用相同资格判断。全部142例重跑GREEN，旧反例无跳过，六类错误变体仍RED；完整sink源码SHA为bee2e749ec49bf905be53ed75da873e0df717ca97e3fab1fd7219c1e9247efb0，root/app2/被测源一致。producer另以实际AST方法和super链验证98例、5个RED，覆盖reset partial写、LHS receiver、visibility getter、插件/onBind重入/异常和旧/新wrapper差异；frame仅prefix，不冒充完整Engine证明。

两类oracle及完整性分别见oracle/actual-probe-audit-v2.json、host-audit/producer-oracle/summary.json。45模块转换的原/输出SHA、13写点、27SDK+3产品reset及AST读写次数由独立审查复核；没有共享SDK文件写入。

## 有效run-2：first-winner计数

run-2 passed=true；原录制固定窗口60秒，probe实际包络61,316.5ms，二者分别保存。以下为操作计数，不是耗时、FPS或GL调用次数。

| 消费路径 | 次数 | 说明 |
|---|---:|---|
| PushMaterial检查入口 | 561,932 | 本诊断的Push scope，不冒称所有GPU draw |
| force首先触发 | 4 | 最后观测写均为DrawWrapper构造true |
| force为falsy、进入实际Scene base观察 | 561,928 | 每次均观察到同参数、同返回的单base调用 |
| Scene base：effect first | 166,261 | base比较数的29.5876% |
| Scene base：material first | 194,620 | 34.6343% |
| Scene base：visibility first | 0 | 只表示实际短路路径中无first-winner，不表示可见性从未变 |
| Scene base：hit | 201,047 | 35.7781% |

读取量为effect561,928→material395,667→visibility201,047，验证未补读被短路项。本轮无throw、上下文残留或mismatch；outer non-force callee身份561,928次仍全部unverified，不把base-observed升级成Native认证。仅在本轮已观测一对一操作的条件下，上述first-winner与hit可回到总检查数，通用delegate/reentry情形不可这样相加。

4次force消费来自constructor；force写总561,938次由_afterBind清false561,932次和构造true6次组成，已覆盖写点中未观测到同一已跟踪消费前重复force写。未绑定的两个构造写不能推断为永远无用。宿主force/dirty恢复路径本包络未形成force风暴，不外推启动、恢复或其他脚本场景。

effect miss166,261中165,666的最后观测写来自Push._afterBind:61、且consumer实际读到非null旧值；595来自reset。material miss194,620的最后观测写全部来自Material._afterBind:983，也均为非null。两者合计360,286，占360,885次truthy返回约99.834%。这证明实际比较的对象键不相等，不能进一步当成相邻draw切换、GL program切换、材质视觉值相等或可以绕过绑定。

## Reset来源与shadow提示

| 原始来源链 | reset次数 | shadow全null-before |
|---|---:|---:|
| Scene.render，scene.pure.js:4468 | 1,278 | 853 |
| _renderForCamera，scene.pure.js:4041 | 1,278 | 1,278 |
| PBR readiness，pbrBaseMaterial.pure.js:932 | 171 | 1 |
| backFaceCulling setter:85→markAsDirty:1229 | 2 | 2 |
| refreshDetachedInstanceSourceMaterials.ts:56 | 1 | 0 |
| Shader readiness，shaderMaterial.pure.js:754 | 1 | 0 |
| 合计 | 2,731 | 2,134 |

Material:85和:1229是同两次调用，不重复累加；setter已有相等guard。Scene.render与camera两处清理间存在动画、动作、stage及公开observer，不能以本次shadow没变跳过任一边界。PBR/Shader准备成功换effect和detached恢复本身有明确合同，保留。

scope为所有被插桩Scene：token5/6497/6498各426次render entry，合计1278。raw未给Scene角色映射，也未按Scene拆reset桶，不能把这些全称为主工厂Scene冗余或把1278当主场景完成帧。

另有cachedVisibility同值且未被本探针consumer读到的写入提示360,288次，cachedMaterial5,538次，以及reset三字段各2,134次；这些只是已求值RHS和最后观测write的shadow。其他SDK getter/脚本可读取，setter可重入或观察，未证明“没有任何消费者”或可删。

## 严格等价判定与停止

独立pure VM反例使用真实Scene.resetCachedMaterial方法：两臂都保留两次公共reset调用且最终三个值均null；原方法产生6次自定义setter日志，第二次shadow-null便跳私有三写的变体只有3次。五条断言通过，证明仅凭shadow全null不足以删除私有写，即使公共调用数量和最终数值相同。

第一处render清理后，onBeforeAnimations/action/动画等观察者可读cache；camera清理前也可能有其他合法绑定/回调。真实effect/material不同键需要按原SDK执行绑定。将这些路径整体跳过、减少公共回调/字段观察、按当前样本新增不完整协议，均不符合本轮严格合同。未找到已证明可安全移除且能解释主线程大头的私有冗余，因此按用户要求停止此方向，不形成产品补丁，不进入候选性能或ABBA。

这不是对所有未来场景“绝对不存在任何优化”的证明；它是对当前工厂、已知路径和明确保真边界的停止结论。没有以放宽合同换收益，也没有重启排序、内核、合批、冻结或预编译路线。

## 独立审查与证据边界

- oracle/runtime-count-audit.json：71项独立检查及root15项守恒复核均通过。
- sdk-audit/runtime-provenance-review.json及reset-shadow-counterexample.json：9项来源/配对复核和5条witness断言通过。
- 所有aggregate计数完整；event记录仅前5000条，917,817条省略，占完整事件约0.542%，不得据前缀外推全窗口逐材质分布。labels仅当前scene.materials/meshes/effects，会漏离场源、已释放或override对象。
- last observed successful assignment记录的是已求值写入尝试；自定义setter或未覆盖直接写可改变实际结果。consumer值不匹配保留unknown。前后Shadow提示只覆盖两个已插桩consumer，不是所有API读者。
- 真实producer bookkeeping的全场景普适性不由98例passive-stub oracle包办；有效App运行、上下文守恒、来源审查与原始数据分别留证，不宣称任意反射/调用栈不可观察的诊断透明性。

## 产品、MQTT与资源收尾

全部1024产品源码/配置最终SHA与冻结B一致，31份SDK/相关源也一致，依赖锁未变。原场景/录制/116资源前后不变，run-2的artifact/harness校验通过；motion、cargoPool、shaderWarmup均false，lightingContextAssembly保持direct。run-1失败与原冻结副本保留。

原录制source-t0的60秒窗口为1151计划/发布/交付/renderer callbacks，连续无缺口、pending0；原renderer固定窗为1142发布/交付、1146callbacks、pending0，窗口边界分别保留，不混合口径。原始payload、顺序与输入审计通过，不代表逐时刻姿态/完整像素或线上Broker验收。

两个专属App/broker均已关闭，最终精确任务路径进程0。未改产品、SDK、场景/脚本、绘制顺序或MQTT处理，没有新烘焙、提交、推送、发布或Q2；没有新产品FPS收益结论，插桩诊断FPS不与原正式6.8比较。

关键原始证据位于output/render-optimization-binding-diagnostic-20261024：run-2/{binding-probe,result,input-audit,mqtt-raw}.json、binding-analysis.json、oracle/、sdk-audit/、host-audit/producer-oracle/和final-integrity.json。
