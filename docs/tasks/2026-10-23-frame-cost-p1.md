# 第二轮场景帧开销优化

用户授权：先P0基线，再做关闭态完全旁路与光照分类内部去重；保留画质、动作、脚本与遥测频率；P2依据实测决定。用户已明确选择本地完整工厂场景，不能冒充附件展会场景或RTX5060。

## 验收清单

- [x] P0冻结源码/输入/相机/画质并隔离采样；按用户后续轮次约束收敛，CPU诊断改在P1第2轮留证。
- [x] 原生硬件WebGL、完整墙钟逐帧与长任务、实际MQTT时间线留证；P0近/远景，最终版本仅近景性能样本，边界已明示。
- [x] 默认OFF不安装观察器/候选/freeze包装、不扫纹理/复制候选；开启/关闭/异步冻结/第三方所有权/重入恢复通过。
- [x] 用户要求继续寻找替代后，分类内部采用纯URI编码值与策略私有默认模板复用；角色Set方案因负收益撤回，原同步脚本/读取语义保留。
- [x] TDD、独立审查、200项定向回归、TypeScript/Editor/Viewer构建、最终硬件六姿态像素对照完成。
- [x] 同冻结输入的近景P0/P1验证完成；最后FPS未提升，混合指标如实报告，卡顿未彻底解决；不推进缺少直接证据的矩阵类P2。

## 入场与执行记录

- HEAD c272715，工作区已有大量并发光照功能修改，均保留。冻结副本位于output/frame-cost-p1-20261023/baseline-app；生产文件复制后复核无漂移，仅cycles.integration.mjs测试在复制过程中有并发写，原冻结字节和差异均保留。
- 另一任务正在运行Blender/Cycles；先构建准备，性能采样等待其结束，不终止非本任务进程。
- 原harness的candidateProviderOwned/freezeEntryOwned门禁需要按baseline/optimized分别验证，否则OFF完全旁路会被旧测试误判；保留硬件/资源/时钟/数据/相机/就绪门槛。
- 实现代理在P0完成前仅只读准备，未改变生产代码。

## 等待与续办检查点

用户明确选择“等待当前烘焙结束再采样”。2026-10-23本地14时左右仍有多个后台Blender，闲置GUI不是阻塞项。P0正式窗口尚未开始；P1生产代码尚未修改。首次close-01在等待期间取消，清理已核查，无正式数据；记录在cancelled-before-sampling.json。

已就绪：baseline-app完整TS/Editor/Viewer构建通过（首次漏examples的失败保留，补齐8个examples后baseline-build-02通过）；preflight-02通过1673源文件/116资源；固定镜头、原录制、probe/墙钟/idle门禁校准通过。后续直接复用，不重建基线或覆盖任何旧输出。

续办顺序：

1. 先用harness/blender-idle.mjs的CIM规则只读确认没有后台烘焙；有则安静等待，不启动应用或新构建、不结束别的任务进程。空闲GUI允许保留，活跃GUI需再等待。
2. P0从baseline-close-02开始：node output/frame-cost-p1-20261023/harness/factory-r0.mjs --build-ready --artifact output/frame-cost-p1-20261023/baseline-app --artifact-manifest output/frame-cost-p1-20261023/baseline-manifest.json --mode motion --seconds 60 --camera saved-close --expected-hooks owned --wait-for-blender-idle --output output/frame-cost-p1-20261023/baseline-close-02 。各新输出不可复用。saved-close和overview固定远景各3段60秒；检查ready.png，不把远景自动称全景。禁止并行build/test/profile/其他GPU窗口；profile另独立60s，额外--profile --telemetry-timing，数据不算FPS验收（15s不足覆盖运动起点）。
3. P0采完再改生产，使用tdd-guide/code-reviewer：OFF任务只写MotionStaticBatchRuntime.ts、SceneTelemetryController.ts、motionStaticBatch.test.ts。保持非null实例，显式enabled/passive；OFF无observer/provider/freeze包装和纹理扫描；开启安装，关闭只撤销自己仍拥有的入口、先还原原件；旧wrapper只委托。pendingFreezes跨开关保留，OFF期间native ready异步冻结未结束不得建carrier，第三方替换不抢所有权。
4. 分类任务只写lightingClassificationRuntime.ts及新增lightingClassificationPassCache.test.ts（辅助helper可小型独立新增）。同一次collect每model复用moving/fixed/animationTargets的引用序列和Set，仍原顺序精确遍历、同轮变更即重建；getDataDrivenConfigs每source照常调用，不缓存最终分类或parent判断。animation.target旧成功判Node后读取两次需保持，未知getter/iterator与Set/Array原生方法覆盖保守旧路径。
5. 保留工作树并发光照/UV发布改动，不改dirty SceneLightingRuntime。将本轮小范围修改复制到基线副本的独立candidate-app，其他生产文件与baseline逐SHA相同；candidate构建、manifest、必要测试与审查通过后，运行同一harness的candidate，expected-hooks=bypassed，各视角3段60s，并适当交错回测冻结baseline降低时间漂移。使用compare-runs.mjs，先检查其实际参数。
6. 原场景画质/资源SHA、脚本/遥测频率/原生姿态、固定镜头与hardware保持，运行现有运动/光照/ownership回归与硬件像素比较。根据profile+P0/P1决定P2；无充分收益/证据则不扩展P2并说明。
7. 完成task-log/使用文档/必要test registry和inventory、变更与验证汇总、资源清理；给中文最终修改清单/前后指标和限制。用户已选择本地工厂，不冒充RTX5060展会报告。未获授权commit/push/外部发布。完成后关闭本聊天的续办heartbeat。

准备代理只读方案在本聊天已有记录：p1_off_prepare、p1_classify_prepare；未开始实施。不要等待已结束代理，后续可重新spawn/followup。

续办heartbeat已创建：automationId=p0-p1，ACTIVE，每5分钟检查本聊天；只在空闲后继续授权任务，未变化时保持安静。完成后关闭该续办。

## 2026-10-23 16:38 P0入场与相机门禁修复

- 用户明确要求直接开始P0。后台Cycles已于16:25:21报错退出（exit4294967295，2h36m15.807s），没有完整结果；只剩闲置Blender GUI146056，不结束或修复另一任务。
- baseline-close-02通过60s正式采样：329frames/5.483333FPS/P95 512.4ms；Intel UHD630/WebGL2/2560×1440，原点差20.474ms，无资源/冻结文件变更。该数据保留为v1证据。
- baseline-overview-01在ready至run之间alpha/beta漂移（3.5578/1.1886→3.7473/1.3036），正式窗口虽稳定，但不满足固定预设的跨轮对照，排除主P0。close-03在加载期取消，正式窗口未开始；CIM查询确认该任务无Electron/Node残留。
- 暂停续采；在独立harness-v2修复显式原savedPose/清惯性/输入锁定，补initial-window-end相机一致门禁。旧harness和旧结果均保留，不覆盖。新输出采用baseline-v2-*；P1生产代码仍未修改。后续一律使用v2，不能用旧续办命令。

- 16:42 v2基础版已冻结，清单harness-v2-manifest.json；真实NullEngine固定相机校准、原capture时钟校准及语法通过。当前正式采样baseline-v2-overview-01，后续近远各3轮及独立profile均用harness-v2/factory-r0.mjs，参数其余与原相同。输出baseline-v2-close-01/02/03、baseline-v2-overview-01/02/03和baseline-v2-profile-close-01。

## 最新用户调整：P0结束，后续每版本最多3轮

- 用户明确指出采样过多、3次足够；收到时已有4轮v2正式完成（近景2、远景2）。后续重复P0与原计划独立CPU profile全部取消，正在加载的overview-03已停止，查询无本任务采样残留。已完成数据均保留，不为满足数量删除结果。
- 4轮input-audit全部通过；近景FPS中位5.941667、逐帧P95中位500ms，远景5.775、502.4ms。comparison.json暂存P0，后续汇总另存不覆盖。
- 现开始两项P1实施，off代理写MotionStaticBatchRuntime/SceneTelemetryController/motionStaticBatch.test及两处motionSelectionProxy异步启用等待；分类代理写lightingClassificationRuntime及新PassCache测试。根负责集成、独立审查、冻结candidate、构建与至多3轮P1对照（拟近景2、远景1）。不得重新执行旧每视角3轮计划。
- 单独CPU profile未采：遵从用户减少采样。P2需证据，不据未采profile推断推进；保留此验收边界。
- 独立harness审查发现viewport.toArray在当前API缺失及采样中activeCamera身份未逐帧校验的既有覆盖缺口；当前无换camera/viewport证据，不作失败数据宣告。后续硬件验证需直接读取viewport四数和activeCamera身份，报告此P0边界，不改正在使用的v2文件。

## 17:13 P1实现与审查检查点

- OFF首轮106核心+7运行时集成回归通过、行覆盖95.24%/分支88.17%，eslint通过。独立审查发现onBatchAdded或创建载体同步回调关闭后旧sync可继续写入，p1_off_prepare正在TDD补生命周期代次保护，最终版本尚不能封存。
- 分类首轮稳定48来源Role Sets144→3、完整结果SHA不变，原分类/策略29回归通过。根审查要求内部数组不新增slice/push/iterator脚本调用，并修target第二次getter改Set.add的求值次序，p1_classify_prepare正在最终回归。
- 根已将新PassCache测试登记package.json与scripts/test-entry-manifest.json，保留并发改动；test:entries通过。testGroups+p4Inventory组合9/10，失败是既有registry项数337而测试写死301；冻结基线同样330而301，非本轮引入，不扩大修复。
- baseline-built-manifest.json另存P0后1673输入+840构建SHA；candidate-app干净底本已复制且一致。freeze-candidate.mjs prepare尚未执行，务必待两代理最终签名及审查后只overlay3个生产路径，再在candidate cwd npm.cmd run build到新log，再seal。
- 硬件fixture/runner已写output/frame-cost-p1-20261023/visual，仅读各artifact源码；尚未build/运行。候选build后执行node visual/runner.mjs --output output/frame-cost-p1-20261023/visual/run-01，6姿态RGBA/分类/drawcalls/脚本配置getter严格比对，检测真正activeCamera与viewport。
- P0汇总已保存p0-summary.json、baseline-comparison.json（原comparison.json移动到此前者）；4份input-audit.json均通过。后续最多3次P1正式采样：near2/far1，不重开P0/profile，不覆盖旧输出。

- 分类最终生产SHA b2a0310ab3cd8da42cb186eec06c14ed2eac7fa351f957588265e66aff1385db；新增17专项通过。根整合旧Runtime/Review/Policy+新PassCache四文件最终34/34通过（p1-classify-integration-final.log，90.657s），无需再重复这一组。当前候选还未overlay；根等待OFF重入修复最终版本和独立review结论。

## 17:32 候选封存与完整构建

- OFF重入修复后最终核心112/112、selection7/7通过。MotionStaticBatchRuntime最终SHA为8cd484cb28ead1f19d7151b7abbc2950d833d2395cb68eab6f879843fbc7dc73，Controller为120eabf8f01fe2b8363975231869ae13f220fbab0219de6e3fe8902516b08b74。
- 分类has污染修复后最终38/38通过；最终SHA为6bdebc265ce1b81fc1c2da1605e5d1328e90a3bff1e9f58bd53f1792fc14733e，取代前述中间版本。未知has暴露后本轮不再复用；透明Set构造Proxy验证原生has稳定48来源3份集合，完整分类SHA保持。
- 独立审查两个已知缺陷最终均关闭，no-unresolved-findings。prepare已仅覆盖3个生产文件，其他1670输入一致；candidate-app中完整npm.cmd run build退出0，candidate-build-01.log保留，TypeScript/Editor/Viewer均完成。
- 实验API边界：setMotionStaticBatchingEnabled(true)改在微任务边界启用，正常下一render前就绪；同一同步调用栈手动scene.render时仍完整绘制原件。OFF期间原生ready/freeze待办未结算时保守等待既有sync，无新增timer/observer，不改变业务脚本或遥测tick频率。

- candidate seal已成功：candidate-manifest.json包含1673输入+840bundle，baselineUnchanged=true。根工作区typecheck退出0；最终目标lint生产及原有测试无错，新PassCache测试6处any随后清零，转译JS前后22,820bytes完全一致，38项最终行为证据仍适用。
- 画面run-01因fixture局部document遮蔽浏览器document而启动失败，尚无姿态采样，自己的browser/server已退出；visual代理已修fixture为sceneDocument并加操作超时，正在run-02，根须等待其结束后再开P1最多3轮。失败记录保留。

## 最新状态17:54：P1回退诊断，正式额度只余1轮

- 首P1 candidate-close-01（冻结candidate-app，分类6bdebc版）功能门禁通过但FPS4.433低于P0近景5.85–6.033；P50=64.2ms改善，P95=659.1/P99=1222.8ms回退。立即停止正在加载的candidate-overview-01，无第二段正式窗口；不交付为优化成功。
- 按用户最多3轮，已将第2轮改为60s CPU诊断candidate-profile-close-01，完成且app退出，profile自身FPS不参与对比。总计已用2轮，最终修正验证只剩1轮，不得再扩展。
- CPU诊断实际profile62.544s：lighting.refreshSources/getSources/collect为主要路径，frame tick和UI getClassification均触发；under父链新检查为热点。原始motion.cpuprofile与profile-summary.json已保存；汇总不得把同栈inclusive与self混加。
- 公平隔离NullEngine微基准：48浅1.607→1.829ms、48深1.727→2.564ms、384浅20.830→20.354ms、384深25.383→29.618ms；旧候选资格检查有负收益。首个共享Geometry微基准被交叉hooks污染，已标shared-fixture-invalid并保留，不引用其收益结论。
- p1_classify_prepare正在实施最小修正：shared trust状态，under每ancestor一次protohas检查并用原.has表达式；unknown ctor/adder暴露前永久false，去掉重复post/own/prototype/WeakSet/bound调用。需四组公平基准净收益、最终38回归和lint，再新SHA封存。OFF最终版本不变。
- candidate-app-02干净底本从baseline另复制，clone-report使用candidate-02-clone-report.json；旧candidate-app及旧结果原样保留。prepare/seal必须用新candidate路径、candidate-02-prepare-record.json、candidate-02-manifest.json及candidate-build-02.log，不能覆盖旧记录。
- 后续完整build02，针对最终分类改动重做硬件fixture（使用--candidate新路径、visual/run-04新目录），全部GPU/构建结束后，仅最后1次近景60s正式采样。依据真实结果决定交付，不宣称未测收益；本轮P2矩阵优化尚未推进。

## 用户新决定：继续研究替代分类去重，末轮暂保留

- 用户已明确选择继续研究其他分类去重方案，不批准本轮暂缓。因此不能仅交付OFF便宣布任务完成。
- Set缓存及最小trust均已否决；分类生产恢复baseline44ecc，新增测试改名lightingClassificationScriptSemantics.test.ts保留20项语义，原专属3Set承诺用例移至失败证据。恢复后37/37通过。根package.json与test-entry-manifest已改为新测试路径。被否决源码/完整旧测试实际保存output/rejected-classification-proposed.ts、output/rejected-classification-PassCache.test.ts，均保留。
- p1_classify_prepare实现替代A：electron/shared/sceneLightingPolicy.ts的默认模板纯数据准备复用，新tests/digitalTwin/sceneLightingPolicyTemplate.test.ts；不碰Node/脚本读取。
- p0_harness实现替代B：lightingGeometry.ts的纯native URI字符串编码本collect缓存，通过lightingClassificationRuntime.ts传入；原parent/name/getChildren/filter/indexOf读取不变，新节点键测试待代理报告路径。
- p0_review正在写p1-alternative-microbench.mjs，不执行：baseline/policy-only/encoder-only/combined四版本从baseline树+显式文件覆盖加载，query隔离local模块，独立Geometry；48/384×2/12、ASCII/混合标签8case，9轮交错8collect，entry JSON/回调次数门禁。必须等待两实现代理功能测试结束后根才启动纯CPU基准。
- 正式场景已用2轮（首坏FPS+CPU诊断），最后1轮不得用于试错；替代方案完整collect有净收益且回归/build/画面通过后才使用。candidate-app-02为干净底本未prepare。后续prepare白名单需根据最终采用方案调整（原脚本限定3个src路径，可能需允许明确policy helper或>3路径）；不得带入并发改动。

## 最终完成状态

- 最终交付为5文件：OFF生命周期/控制器、lightingGeometry/lightingClassificationRuntime的纯URI编码pass、sceneLightingPolicy的默认模板。旧Set方案与精简trust方案均不在最终生产代码。
- candidate-app-02与工作区完整build退出0，最终typecheck退出0；最终核心112+选择集成7+光照/几何/策略整合81=200回归通过。所有新增测试入口已登记；范围lint无错无警告。
- visual/run-04六姿态RGBA零差异，drawcalls/完整分类/脚本读取频率一致，实际阴影和运动可见。final-close-01最终60秒349帧、5.8167FPS，P95 477.9ms、P99 772.2ms、长任务累计54016ms；对照近景中位5.9417FPS/P95 500ms/P99 739.5ms/58076ms。最终原录制60秒1151消息完整，回调延迟P95 1128.7ms。
- 不得描述为整场景FPS稳定提升或卡顿已解决。按用户3轮上限，P1首失败候选+诊断+最终验证已全部用完，无更多采样。P2矩阵优化未推进，建议后续从光照目录刷新范围和触发原因入手，尚未实施。
- 最终报告docs/tasks/2026-10-23-frame-cost-p1-result.md，机器记录output/frame-cost-p1-20261023/final-verification.json；历史失败、原始trace/profile均保留。已确认本任务应用/采样/画面对照无进程残留，不提交推送或外部发布。

- 续办automation p0-p1已通过应用工具删除，deleteStatus=deleted；停止后续自动采样。最终结果报告已请求在Codex面板打开（queued）。
