# 工厂 camera/render 主线程只读分析

状态：只读分析完成，未实施产品候选。用户要求先分析 active mesh 评估、矩阵同步、材质绑定和 GL 提交，给出有证据的新方案；本轮不改产品代码、画质、脚本或 MQTT，不重启两个内核及其他已关闭候选，不进入 Q2。

## 验收清单

- [x] 读取前轮停止结论、当前工作区及冻结 B 身份；复用仍有效的原始 profile，避免将诊断 build/FPS 当收益。
- [x] 将 camera/render 内四类操作按互斥口径拆分，并列出必要的嵌套 inclusive 视图与限制。
- [x] 对 active、matrix、material/GL 分别核实际 SDK 9.12 与产品调用、现有 fast path 和语义约束。
- [x] 核实新发现的项目 front-to-back 排序覆盖：实际组、距离值、基础材质序列与缓存相关状态；实际绑定失效次数仍缺测。
- [x] 对每个新方向区分已证事实、待证假设、不能严格等价的路线及后续门槛；不实施候选。
- [x] 独立审查分析脚本/关键结论，最终输入 SHA、任务资源和报告交付。

## 范围与计划

正式上下文沿用 `output/render-optimization-q1-factory-20261024/final-q1-app`（含批准的 L2 的最终 Q1 build5）；产品源当前仍与此前1024行冻结清单一致，最后再核。主要采样为 `output/render-optimization-factory-hotspots-20261024/current-profile-1/motion.cpuprofile`（生产压缩B、约62.5s包络），语句线索用 `output/render-optimization-create-kernels-20261024/current-create-diagnostic-1/motion.cpuprofile`（当前同源非压缩CPU+heap诊断）。两份分别分析，不拼接耗时、不比较FPS。

新输出目录：`output/render-optimization-camera-analysis-20261024/`。active/、matrix/、material-gl/由独立只读分工处理，root负责互斥分区与集成。允许输出诊断脚本/报告，不写src、SDK、场景/资产/原录制，不运行候选、构建、ABBA、烘焙或发布。

当前已证实：生产camera子树16.495541s，active inclusive4.318891s、PBR.bindForSubMesh4.412743s、computeWorldMatrix1.525776s为嵌套预算。GL native leaf成本与GPU执行时间分开，原GPU counter null不能解释成0。相机固定，camera矩阵自身成本很小，不能把camera子树全部算成相机矩阵。

排序新证据：SDK默认按材质分组，但`thinInstanceMatrixBuilder.ts:190-206`对interactive批次所在group设置frontToBackSortCompare；生产profile确有该比较器命中。SDK`RenderingGroup._RenderSorted`只在transparent=true时更新_distanceToCamera。需要实际state核实，不直接改回默认排序，也不以原注释的Early-Z意图当已测收益。

为此仅准备一个冻结B的隔离真实工厂状态捕获：沿用原harness，原录制20秒，窗口前后各读一次队列/比较器/材料与GPU能力状态，不包装render方法、不调用队列sort、不创建默认材质/DrawWrapper、不算世界矩阵、不写引擎flag。此运行仅诊断，不作正式FPS/ABBA或业务一致性验收；源/资产完整性与owned app/broker收尾沿用原门禁。

## 结论与建议

当前camera/render成本主要落在材质准备/绑定、mesh分发及active评估；实际相机view/projection同步很小，GL入口采样也不是硬件GPU时间。已有world缓存、材质ready缓存、UBO/VAO/texture/program缓存均不能当成待新增能力。

本轮找到了一个明确的既有排序问题：interactive阵列将group 0设为front-to-back，但捕获的opaque/alpha-test距离键全部为0，没有建立按空间距离排序的证据。不过基础材质连续段已经接近不同材质数，恢复材质排序的剩余空间有限，而且改变绘制回调顺序，不满足当前通用严格等价合同。因此不直接改排序，也不把整块PBR预算当成排序可省时间。

**目前没有已证明可直接实施且显著提帧的新产品补丁。最值得继续的有据路线是：保持现有绘制序列，对材质绑定的四种真实失效来源做精确归因，再只处理已证明的宿主私有冗余失效。** 当前还缺这一步的分支/调用统计，不能预先宣称重复失效成立或承诺收益。active/matrix的小预算内核及通用开关不作为下一轮主攻。

## 1. 当前生产profile的互斥预算

分母为整份生产压缩B的62,498.954ms加权样本；camera路径用祖先含_processSubCameras筛选，16,495.541ms/11,055样本，占全profile26.3933%。没有严格裁切60秒，不与帧数直接相除，也不与另一份非压缩CPU+heap诊断做速度A/B。

先按渲染阶段分区：active评估4.318891s（camera内26.18%）、RenderingManager队列11.546898s（70.00%）、camera setup及其余0.629752s（3.82%）。

下面是同一批样本的另一种操作视图，优先级为GL leaf→matrix/bounds→material→active余量→其余；每个样本只归一类，合计仍为16.495541s。两种视图不能相加。

| 操作视图 | 加权归属 | camera内占比 | 解释 |
|---|---:|---:|---|
| 材质准备/绑定，扣除matrix/GL | 5.501955s | 33.35% | PBR ready、defines、bind及后代 |
| mesh分发、排序及其他 | 4.823421s | 29.24% | mesh/render、队列、状态准备等余量 |
| active评估余量 | 3.383265s | 20.51% | 已扣除matrix、material、GL |
| matrix/bounds同步，扣除GL | 1.658220s | 10.05% | 世界/父链同步、bounds和camera矩阵相关命名链 |
| 原生GL入口leaf | 1.128680s | 6.84% | 仅占全profile1.8059%，不等于GPU执行时间 |

独立DFS+整数微秒算法复算与root结果逐项一致。recursive同源函数每样本仅计一次；原始非压缩profile的-13微秒delta保留，且它在camera之外。分析器、分区定义、全部函数表见render-profile-breakdown.json，独立审计见material-gl/root-profile-audit.json。

## 2. 四个区域的证据与边界

### Active mesh

实际链为scene.render→_processSubCameras→_renderForCamera→_evaluateActiveMeshes→_activeMesh→_evaluateSubMesh→RenderingManager.dispatch。active inclusive4.318891s、self1.811799s；_evaluateSubMesh inclusive仅0.405807s。

active内computeWorldMatrix0.870574s、frustum0.345322s、thin bounds0.228369s均是嵌套，不能再加。无LOD时getLOD、单submesh forcePush、原生world dirty/renderId缓存已有。项目阵列updateFrustumCulling只有6.187ms，已做相机矩阵不变且cullingDirty=false快退；thin carrier已有doNotSyncBoundingInfo。当前motion candidate/freeze hooks关闭，保持关闭。

非压缩行级采样中currentLOD那一生成行占active self ticks32.31%，但包含字段与activeCamera读取，不能称为纯Map.get成本。提前剔除offscreen/invisible会跳过原本先执行的ready、world、intersection动作、LOD和preActivate等观察；全局freeze或候选列表缓存不符合现有合同。整个frustum inclusive只约全profile0.553%，不值得据此承诺提帧。

### 矩阵同步

camera路径内computeWorldMatrix inclusive1.525776s；矩阵及bounds的操作互斥桶1.658220s。矩阵分工按更广命名集合分析的全profileview/projection self仅12.187ms，不能把camera/render总树当成camera矩阵消耗。collector与LED的force world/inverse在camera外另列，不挪入本区域。

Babylon实际实现已有dirty、renderId和isSynchronized捷径；frameId与renderId不是一一对应，RT/camera与层级bounds查询还会推进renderId。同renderId内父级/脚本再次变更仍须正确同步。force分支可能更新父链、bounds、childUpdateId、Matrix updateFlag/seed和observable；已冻结且未dirty时又优先快退。因此不能按矩阵数值相同省force，也不能按frameId缓存world/inverse。现场快照已有744个frozen world matrix，未新增冻结。

### 材质准备与绑定

PBR.bindForSubMesh inclusive4.412743s/self1.039376s，isReadyForSubMesh inclusive1.480478s。绑定后代分散在UBO.setTexture0.471341s、BindIBLParameters0.416468s、mesh.transferToEffect0.359578s、BindLights0.341662s、updateUniform0.318592s、BindTextureMatrix0.310537s；inclusive存在包含关系。

SDK已有same-renderId ready、frozen ready、mustRebind的force/effect/material/visibility比较，以及UBO、texture、program和buffer缓存。真实快照Material UBO全部开启，checkReadyOnEveryCall全部false，214个material已frozen；不需要“第一次打开UBO/ready缓存”。WebGL2 Mesh普通uniform是SDKforceNoUniformBuffer的刻意路径，不能强开Mesh UBO改变shader布局。公开插件HardBind、material/mesh bind observer和原字段读取不能因缓存而跳过。

### GL入口

可见native leaf较大项为bindVertexArray407.437ms、uniformMatrix4fv220.098ms、bindBufferBase160.726ms；drawElements66.894ms、drawElementsInstanced39.362ms、drawArrays26.457ms。它们仅是CPU栈归属；异步GPU压力也可能不出现在这些栈里，不能据此排除GPU瓶颈或把draw数量换算成可省时间。

现场确认supportsUniformBuffers=true、disableUniformBuffers=false、disableVertexArrayObjects=false、VAO可用。timerQuery扩展存在，但canUseTimestampForTimerQuery=false且原GPU counter仍缺有效值；不能把扩展存在、timestamp能力或null当成GPU时间0。当前不使用gl.finish、no-op draw或降低画质来制造收益。

## 3. 排序状态实测：问题成立，但不支持直接改排序

冻结B实际打开原工厂，使用原MQTT录制20秒，窗口前后各一份状态。两份都是group 0；opaque/alpha-test比较器确为frontToBackSortCompare，透明仍为defaultTransparentSortCompare。group 2保持SDK默认且队列为空。

| 捕获点 | opaque行数 | opaque距离键全0 | 基础材质种数 | 基础材质连续段 | alpha-test全0 | transparent非零 |
|---|---:|---:|---:|---:|---:|---:|
| 原录制前 | 1282 | 1282/1282 | 771 | 801 | 10/10 | 25/25 |
| 20秒原录制后 | 1284 | 1284/1284 | 773 | 803 | 10/10 | 25/25 |

这两个捕获点的backing length等于队列length，SDK可直接排序backing数组。全零键与原生稳定sort支持“不产生空间距离重排”的推断；不是完整逐draw trace，也不外推所有时刻。基础材质读取未解析render-pass override/defaultMaterial，当前pass DrawWrapper effect相邻变化369/371也不是实际bind miss次数。

即使纯算术地按这些基础材质ID聚合，801→771或803→773最多少30段，约3.7%；不能将其套用为少3.7% CPU或少同样比例GL调用，更不能认领全部5.50s。不同材质身份本身仍多，合并材质会改变脚本持有的对象和后续改材质行为，本轮不采用。

离线使用本地SDK两个真实比较器构造了最小顺序反例：两个距离均0、材质ID20/10的submesh，frontToBack保持first→second，Painter变为second→first。若分别有onBeforeRender观察者，事件序列即可不同。该文件只证明排序数据顺序可变，没有创建Engine/Scene，没有执行真实observer或像素测试。它足以否决“不透明所以重排必然严格等价”的通用前提；共面像素、深度相等、GPU overdraw仍另有验证要求。

## 4. 有证据的新方案：保持绘制顺序，定位绑定失效的真实来源

建议仅推进一个有边界的诊断/候选形成流程，不直接启用任何产品开关：

1. **在独立诊断副本中统计原绑定链的第一触发原因。** 按原短路顺序记录_drawWrapper._forceRebindOnNextCall、cachedEffect变化、cachedMaterial变化、cachedVisibility变化；保留原this、方法覆盖、读取次数/次序、返回和异常。不为“完整原因位图”额外读取已被短路跳过的getter。记录真正解析到的pass/material/effect/visibility与调用序列，覆盖opaque/alpha/transparent，但不排序、不合并、不跳bind。未知override单列unknown，不能按原生猜测。
2. **只在异常高的force/dirty来源上继续定位。** 区分真实材质/效果/可见性变化与同一消费前重复private invalidation。当前宿主light policy和shadow同步已见相等guard，不能预设它们每draw无条件标脏。保存生产者调用位置/原始状态与消费点，未捕获的脚本直接写入保持unknown。
3. **候选范围限定为已证明的私有冗余计算/失效。** 所有材质、mesh、geometry、DrawWrapper身份、draw序列、参数、公开回调、getter/iterator、Matrix seed与脚本/MQTT继续原样。不得整块跳PBR.bind、freeze未知材质、共享材质、改变GLSL/UBO后端、改render group，或以新增协议限制原脚本。
4. **若绑定trace证实失效主要来自真实材质/effect/visibility变化，或无法证明private失效可合并，就停止这条路线。** 当前771/773只是基础材质种数，不替代实际pass绑定归因。不改排序求收益，也不将未测root cause写成优化完成。此门槛防止对正常必要工作添加更昂贵的guard。
5. **候选出现后才做行为oracle及完整render链计时。** 先有会失败的错误变体和原SDK/产品对照，核draw调用序列/参数、world/bounds与全部公开observer；再测真实工厂完整camera/render链。只有收益超出同臂重复波动且重复同向，才进入独占硬件无Profiler ABBA，视觉用确定性姿态/时间的完整buffer对照单独验，MQTT按source-t0核数量/顺序/缺口/pending。任何实质行为或像素差异否决，同一候选连续两次无净收益停止。

以上步骤未实施。当前缺少实际mustRebind第一原因计数、force/dirty生产者轨迹、完整逐draw材料/效果/visibility以及有效GPU时间；本轮状态快照不能替代这些证据。此方案属于当前工厂render残余分析的延续，Q2仍未进入。

## 5. 交付与限制

所有1024份原冻结B产品源码/配置最终SHA一致，changed=[]；package-lock与installed lock也匹配，SDK9.12未改。真实诊断passed=true，原场景/录制/116资源、artifact与harness前后不变，专属app/broker正常关闭，最终精确任务进程0。没有产品构建、候选性能、正式ABBA、新烘焙、提交、推送或发布；两个内核及其他关闭路线保持停止。

可复核文件位于`output/render-optimization-camera-analysis-20261024/`：

- `render-profile-breakdown.json` / `analyze-render-profile.mjs`：互斥分区和嵌套函数表；`material-gl/root-profile-audit.json`独立整数微秒复算。
- `active/active-mesh-analysis.{md,json}`、`matrix/`、`material-gl/material-gl-analysis.{md,json}`：SDK/source-map对照、调用链、现有快路径与语义边界。
- `render-state-1/{render-state,result}.json`、`render-state-analysis.json`：实际20s诊断前后快照与统计，不作FPS或完整业务一致性验收。
- `sorting-order-witness.{mjs,json}`：普通JS数据上的SDK比较器顺序反例，非真实渲染/像素验收。
- `final-integrity.json`：1024源码、依赖锁和诊断输入/资源收尾。

诊断窗口不是正式60秒性能基线，其FPS不用于比较。本轮只交付分析和有门槛的新路线，没有新产品性能收益声明。

独立state审查另发现snapshot初版读了不存在的`w._forceRebind`，正确字段为`_forceRebindOnNextCall`；原始forceRebind全部null/unavailable，未解释成false/0，也不能当成已取得mustRebind统计。当前工具该字段已修正并语法/源码审查，未为此追加硬件运行，修正版运行验证仍未做。已实际执行的20份harness脚本逐字节存入executed-harness/，其相关SHA与result记录一致；原始数据、失败/缺测和统计未改写。已有distance/材质/UBO结果不依赖这一字段。root互斥分析与state统计均已独立复算，见material-gl/root-profile-audit.json及active/state-audit.json。

## 6. 后续用户授权的绑定归因已完成

后续执行见[绑定失效诊断与停止结论](2026-10-24-binding-invalidation-diagnostic.md)。有效probe包络61.3165s内Push检查561932次，force-first4次全为wrapper初始化；base-first effect166261、material194620、visibility0、hit201047。真实不同非null缓存键占truthy返回约99.834%，未发现force风暴。2731 reset中2134为shadow全null提示，混合三个Scene；实际SDK方法的setter观察反例否决基于shadow-null直接跳私有写。没有形成严格等价的有效优化，已按用户要求停止，不改产品或推进Q2；原分析阶段的缺测由该后续报告补充，原始快照不回填。
