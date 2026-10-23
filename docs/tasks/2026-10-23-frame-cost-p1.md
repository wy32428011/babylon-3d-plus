# 第二轮场景帧开销优化

用户授权：先P0基线，再做关闭态完全旁路与光照分类内部去重；保留画质、动作、脚本与遥测频率；P2依据实测决定。用户已明确选择本地完整工厂场景，不能冒充附件展会场景或RTX5060。

## 验收清单

- [ ] P0冻结代码/依赖路径/输入资源/场景/MQTT录制/相机/画质，并在无本任务构建测试和无其他重负载时独立采样。
- [ ] 原生硬件WebGL、完整墙钟帧统计/长任务/分阶段/原始时间线与真实数据输入留证；近景全景固定。
- [ ] 默认OFF不安装观察器/候选/freeze包装、不扫材质/复制候选；开启/关闭/异步冻结/第三方所有权与原件恢复保持。
- [ ] 分类同调用复用稳定集合，未知getter/iterator及同步突变仍原顺序生效，不跨帧，不缓存脚本回调。
- [ ] TDD回归、独立审查、TypeScript/Editor/Viewer构建和硬件画面/动作对照完成。
- [ ] 同冻结输入的P0→P1固定视角对照完成，基于调用栈和实际收益决定P2；现场边界明确。

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
