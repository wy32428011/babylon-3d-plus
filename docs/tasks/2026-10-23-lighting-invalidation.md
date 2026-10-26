# 光照来源重复失效优化

用户授权实施：先失效原因计数与最小回归，优先隔离阵列宿主临时增删事件，区分纯位姿、分类和结构变化。画质、动画、脚本行为及遥测频率不变；未知情况完整失效。本轮实机场景采样总计最多3次，不是每视角3次，失败/诊断也占预算；已完成3/3次（baseline-01、candidate-01、baseline-02全部通过），不再追加。

## 验收与顺序

- [x] 冻结本轮原有源码、依赖、构建及原工厂输入；原因计数默认关闭，开启时低开销且不调用额外业务getter。
- [x] RED复现重复remove通知、异步add、分类查询与绑定刷新相互独立、刷新期间重入失效。
- [x] 仅对有可靠来源证据的事件分流；用户原生广播、脚本回调、driver与MQTT频率保持，未知observer/函数/脚本/结构走full。
- [x] 纯pose不重新collect但保留每帧动态绑定/探针/阴影和静态GI失效；分类、绑定校验、结构强制重建有明确版本与消费边界。
- [x] 定向回归、独立审查、构建与真实硬件画面对照通过，再使用最多3次工厂60秒采样。
- [x] 交付修改清单、前后计数与帧指标、未解决问题；不把子流程或NullEngine收益当现场FPS。

## 入场

- HEAD da8956a；保留上一轮全部未提交改动。上一轮最终FPS5.8167，相对其基线5.9417无稳定提升；不能继承其撤回候选CPU占比作为本轮最终事实。
- 本轮输出output/lighting-invalidation-20261023；baseline-app从当前工作区复制1691源码/输入文件和852构建文件，baseline-manifest.json记录SHA；drift为空。明确排除本轮新增helper/test；node_modules为原依赖junction。原构建来自前轮已验证的完整workspace build。
- 0次实机场景采样；未启用旧已删除的automation。采样必须由根代理统一启动，无并行测试/构建/GPU负载。

## 当前工作分工

- p1_classify_prepare：SceneLightingRuntime.ts、lightingInvalidation.ts、新计数/回归测试及已有sceneLightingRuntime测试。API为notifyChange(kind, reason)、markDirty(reason='unknown')；kind包括pose/bindings/classification/structure/unknown。诊断setInvalidationDiagnosticsEnabled/resetInvalidationDiagnostics/getInvalidationDiagnostics，默认关闭。
- p0_harness：ModelAssetRuntimeController、ModelArrayRuntimeController、SceneTriangleAndReadinessController、arrayHostLightingEvents helper及新回归。先实现可证明的同步native remove返回-1分流，保留广播；真实remove与所有异步add完整失效，不用无法可靠归属的同mesh异步ticket。
- p0_review：新harness，继承固定原点/硬件/输入门禁，修复实际activeCamera身份和数字viewport观测；先设计公平计数，不自行启动应用/构建/实机采样。
- root：整合、其它调用者原因标签、冻结候选、必要注册/文档、审查、构建、硬件验证及三次采样预算。

## 已知边界

- 普通driver写position及现有thin实例矩阵commit本身不显式markDirty；不能新增无谓全局通知。
- refreshModelMeshes无条件markDirty和宿主scene add/remove是已确认入口。native remove即使index=-1仍通知；native add通过SetImmediate延后，foreign add同mesh交错没有原生token，不能猜归属。
- 未知脚本可能修改其他模型；只看当前meshref或矩阵不足以判pose。保留未知脚本完整路径，先量化可优化路径覆盖率。
- getDataDrivenConfigs及Node.parent/name等可被覆盖，减少collect会减少其中读取；仅能对经过可靠纯度/来源证明的路径减少内部工作。
- 当前sourceRevision并非完整catalog版本，sync原来不递增。UI读取分类不得吞掉绑定dirty；采集中再次失效不能被末尾清除。
- 结构引用替换与仅绑定校验必须区分；不能假定旧layoutKey会捕获Geometry/skeleton/morph的全部替换。

## 安全边界收敛

- no-op remove 全局纯度方案已撤出生产：脚本宿主在资格检查前即拒绝，未连接provider，实际工厂覆盖为0；不增加全场descriptor扫描。实验源码、18项测试与失败记录归档保留。
- 采用consumer notifyMeshLifecycleChange的O(1)重复请求合并：仅已有完整catalog+bindings pending且不在任何消费/异步snapshot操作时省重复revision；native add/remove、广播、回调时序、未知getSources/getter实际调用次数保持。重入、UI已消费、异步激活及未知条件完整失效。
- 该合并只减少重复标记，不能宣称减少collect或解决卡顿。实际restore/add/remove及脚本refreshModelMeshes继续完整分类。通过前后同条件原因计数确认瓶颈份额，不引入不安全跨帧缓存。
- 原因标签覆盖bake-preflight、bake-capture、environment-snapshot、motion-batch-layout、model-meshes-refresh-unknown、scene-mesh-added/removed。诊断默认OFF，正式比较由同份任务内harness采集，不增加业务getter。

- 2026-10-23T12:57:38Z 已启动本轮第1/3次实机：baseline-01，冻结harness v2清单（invalidation capture SHA7385c69c…），预检2543源码/构建文件、116输入通过。采样期间所有子代理暂停CPU测试/构建/GPU，仅编辑/只读。

## 候选冻结与验证

- 基线baseline-01通过：328帧/60s=5.4667FPS，P95 515.2ms，P99 860.4ms；4157次mark，94次真实getSources，累计32248.5ms，最大417ms。请求来源：refreshModelMeshes66，suspend2040，延后/无同步scope2051。真实目录消费frame58、UI query36；嵌套耗时不可相加。input-audit通过，原始报文及各时钟证据保留。
- 最终consumer57/57、诊断5/5、readiness联接7/7、关联分类/源缓存/薄实例/阴影66/66，共135项通过；独立审查无阻塞项。已有全局inventory硬编码计数旧失败保留，未扩范围修复。
- candidate-app已按11个明确文件从baseline叠加（包括5个既有生产文件、1个新helper及测试/入口），独立npm run build exit0，1694输入与852产物已seal；基线完整性及源码SHA核对通过。仅测试EOF空行修正的旧prepare记录保留。
- 硬件确定性画面对照run-01正在执行，不测FPS、不重放工厂，正式工厂预算仍1/3。

- 硬件visual/run-01通过：真实Intel UHD630/D3D11/WebGL2；实际SceneLightingRuntime与readiness参与，6姿态像素差0，完整分类/真实目录/脚本getter/事件顺序及drawcalls一致；可见运动7810像素，阴影开关630像素差。非FPS测试，不占工厂预算。
- 2026-10-23T13:08:13Z 第2/3次工厂采样candidate-01已启动；此前确认无Blender或已知测试/构建负载。预检2546artifact文件、116输入通过。第三次仅在本轮结果需要复核时使用。

- candidate-01通过：344帧/60s=5.7333FPS，P95 482.4ms，P99 811.1ms；共同请求总数仍4157=66模型unknown+4091mesh事件，后者4047 coalesced+44 full。getSources95次（frame58/UI37）/31325ms/最大469.9ms，不能宣称减少collect。输入审计通过，source-t0 FPS5.75；正式窗口与源原点窗口各自保留，不混用计数。
- 为辨别首对约4.9%FPS差异是否普通波动，2026-10-23T13:12:15Z已启动最后第3/3次baseline-02，A/B/A；若该轮异常不重跑，保留失败。主要分类瓶颈尚未解决，不推进P2或新增缓存/降低任何更新频率。

## 最终交付

- A/B/A三轮全部通过，冻结基线FPS5.4667/6.1167，候选5.7333；不能确认稳定FPS收益。三轮真实getSources为94/95/91次，约450ms分类卡顿仍在。
- 候选共同请求仍4157，Mesh事件4091中合并4047次、full44次，另有66次未知模型刷新full。此收益只属mark/revision合并，不是减少collect。
- 135项定向回归、独立审查、候选完整构建、硬件六姿态pixelDiff0、三份输入审计、跨版本镜头/画质/工具SHA、最终源码一致性均通过；入口审计96保留/0缺失，diff --check通过。
- 未实现任意脚本纯位姿自动识别或临时异步add的完整隔离；未知路径full。主卡顿未解决，不推进P2。三份测试app与broker已正常关闭，无其他任务进程被终止。
- 结果报告：docs/tasks/2026-10-23-lighting-invalidation-result.md；机器证据：output/lighting-invalidation-20261023/final-verification.json。已停止实机采样；本轮没有automation需要关闭，无commit/push/publish。
