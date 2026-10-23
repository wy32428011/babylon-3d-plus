# 项目专项优化 P2 执行记录

依据 [project-optimization-plan.md](../project-optimization-plan.md)，用户授权推进 P2.1–P2.4，保持画质、参数化脚本和设备动作逻辑，更新执行记录并给出验证结果。P1 及入场已有改动保留；未提交、未推送、未发布。入场 1,628 份文件的 SHA 与字节副本位于 output/project-optimization-p2-20261021/baseline.json 和 baseline/。

当前结论：已落地 P2 的编译缓存、增量同步流水线、动静合批和编辑预览优化，并完成所列本地功能验证；**P2 实施和整阶段验收均有未完成项**。固定结构合批在真实工厂的显式实验中生效，因实测回退默认保持关闭；缓存、流水线、矩阵与编辑预览优化正常启用，仍未达到 Draw Call <400、Active Mesh <1000；不能把组件调用减少或单次 FPS 波动表述为稳定帧率提升。真实中台冷/暖打开下降30%+及全部设备轨迹也未获本轮证据。

## 验收清单

- [x] 实际授权 TS 的内容/编译器版本持久缓存；坏缓存、过期、并发、取消和源文件变化有回归，独立进程暖命中不加载 compiler。
- [x] 参数宿主 FIFO 分帧调度，后台/无 rAF/取消均有明确收敛；保留全部 constructor/onStart 生命周期。
- [ ] 跨会话参数几何模板缓存；未用缓存替代任意脚本执行结果，单个同步 onStart 仍不能抢占，不能保证每个任务低于50ms。
- [x] 按包依赖有界下载/校验流水线，最终完整索引、二次确认及原子 promote/rollback 保持。
- [ ] 已知设备固定叶片thinInstance混合实例已实现并通过功能回归，但实机仅减少约5 draw且回退，未提升至默认路径；实验入口保留全部身份和失效保护，P2.3不认定交付达标。
- [x] 选择/拾取身份、光照角色、阴影列表及几何/材质/纹理变更回退集成；真实 GPU 上传当帧恢复原件。
- [x] 静态环境/批次矩阵受控冻结；Gizmo 运行时直接预览、Inspector轻预览、结束一次命令、取消及撤销/重做。
- [x] 最新 build、TypeScript、lint、test:ci 与 P2 专项；P2 **179/179**，lint **0 error/182存量warning**。
- [x] 真实生产 Editor 与独立 Edge Viewer WebGL2；16包与P1原阈值对照无新增失败。
- [x] 同资源/相机/硬件/DPR/录制，1440p与4K帧缓冲各完成4×60秒 OFF/ON/ON/OFF；结果与未达指标分开记录。
- [ ] Draw Call <400、Active Mesh <1000、两分辨率可复现稳定FPS收益、真实中台冷暖下降30%+。

## 最终实现

### P2.1 编译缓存与宿主调度

主进程 userData/model-script-cache 存储以实际 TS 内容 SHA、实际 TypeScript 包版本及预处理版本标识的产物。safeStorage 保护独立密钥，HMAC 认证缓存；内存128项/64MiB，磁盘256项/128MiB、闲置30天。每次命中仍读取授权原 TS 并严格检查UTF-8；保护不可用、坏缓存、版本变更均回到原编译路径。同内容在途工作共享，单个等待者取消不取消其他调用。

ModelInitializationScheduler 以 FIFO、6ms/最多4宿主执行，首片跨帧，保留后台及无 rAF fallback。跨进程暖缓存测试 compilerLoads=0、compilations=0、persistentHits=1。脚本本身未改；onStart单次同步工作仍不可抢占。既有GLB缓存和场景内参数变体继续保留，跨会话几何模板尚未实现。

### P2.2 包依赖流水线

模型增量同步每次run使用4下载/2校验/最多4活动包；一个包的全部依赖、可信原始size/SHA和缩略图落盘完成后才校验，其它包继续下载。全部校验成功后仍走原完整索引构造、元数据二次确认与原子推广/逆序回滚。首错或取消停止派发，排空已启动写入后清理；shutdown/恢复边界保持。真实127.0.0.1分段HTTP验证了重叠，不能替代真实中台打开计时。

### P2.3 动静渲染、身份和失效

所有固定原 Mesh 始终保留在 scene.meshes 和原业务父子链中，仅通过公开 getActiveMeshCandidates 委托过滤主绘制候选；LED每帧节点查询继续看到原件。源几何/材质、GPU纹理身份、旗标、局部层级、动作角色及未知晚期回调均检查。实际覆盖5个公开GPU buffer上传入口：命中受管源DataBuffer时先归还，再执行原上传；保留 receiver、参数、返回、异常、共享通知及隐式ARRAY_BUFFER绑定。外部接管API后不抢回；WebGPU storage/compute可变源仍保守拒绝。

纹理只排除本机Babylon实际序列化证实的3个导出字段（base64String、internalTextureUniqueId、internalTextureLabel）；实际嵌套InternalTexture身份进入group key并监视指针。Gamma、UV、LOD、采样和其它live渲染字段仍检查，未知字段回退；序列化finally恢复所有实际纹理name/url，metadata别名不修改源对象。

加载期等待正常模型全部初始化后才建批，避免逐个ready触发全量重建。同一次build共享实际Material捕获，同一次校验遍历共享读取，下一个provider/RTT/mutation边界重新读取。8part实测serialize8→1、目标getter16→1；不跨边界降低检查频率。

照明批次逐实体回查真实源节点。ShadowRuntime仅新增原件caster排除、静态caster缓存失效与受控target目录；质量参数/算法未改。原生薄实例来源不再逐行强制刷新整组边界。model及非model身份保留原canonical算法，以Geometry通知、buffer/layout及精确CPU数据快照校验失效；非model原输入仍为 [partKey, positions, indices]。32 logical实例×3 collect的96条输出与原算法一致，位置读取32→1。精确数组比较仍为线性，未声称整体查询O(1)。

### P2.4 编辑预览与矩阵

安全环境叶片及批次载体冻结世界矩阵，变换/资源更新前解冻刷新。单体Gizmo每事件更新实际运行时，Inspector独立轻预览限频，拖拽不写持久文档/历史，结束一次命令；失效/取消恢复权威文档。commit/cancel继续使用现有编辑态thinInstance plan。实际生产UI30项通过，含真实鼠标、末帧、Esc、一次命令、Inspector、撤销/重做及虚拟阵列；见 gizmo-production/result.json。

## 最终验证

- build-safe-default-final.log、ci-safe-default-final.log、lint-safe-default-final.log：exit0；TypeScript正式npm run typecheck及build均通过。
- 收口：inventory零漂移（89登记入口）、test:entries通过、定向git diff --check及新增源码空白检查通过。16份受保护源码SHA、116资源/225756283bytes及原场景字节均保持；进程归属核对无残留，未终止不相关进程。最后只去除SceneRuntime一空白行的两空格，TypeScript输出JS逐字节相同，见whitespace-emit-proof.json，故复用此前构建/179回归/GPU执行证据。
- p2-safe-default-final.log：179/179，无skip/cancel；包含controller98项、lightingSourceCaching26项、真实Runtime选择/照明代理/动画门禁与默认开关7项。另既有classification/review/policy17项独立通过，不计入179重复累计。
- production-profile-fixes/result.json：生产Editor脚本实际启动4次、预转译协议命中；独立Edge Viewer使用Intel UHD630/ANGLE D3D11/WebGL2、1440×900/DPR1，无pageerror，新包不请求renderer TypeScript或禁用的MQTT bundle。
- model-array-visual-profile-fixes.json、p1-p2-visual-profile-fixes-comparison.json：16包12通过，box、GD、RGV、Shelf原4失败仍同项目同数值；166张完整配对，142张非时间动画逐字节一致。24张LED/YZJ中22张随时间不同，最大容差像素比例约0.287854%。
- 最终工厂原始result.json：真实370实体，显式实验23批/204逻辑抑制原件，模型898984、环境712491三角形不变。同源姿态OFF/ON，动态纹理真实投影区域0.3227%单列；其余3674505像素2点不同，最大通道差17，>24差异0。真实guidaoshang.1在beforeRender调用VertexBuffer.updateDirectly，source绘制1、旧carrier绘制0；回退/原绘制的非动态区域RGBA差异0。可变证明及来源draw拆分在全部计时窗口后进行；早期factory-profile-feature5秒仅功能证据。

新增安全默认回归验证正式SceneRuntime默认0批、不抑制原件；显式开启形成批次，再关闭恢复原件对象/父级/材料/候选。原有6项选择/照明/动画门禁测试仍显式开启运行；没有通过关闭功能绕过断言。

## 工厂完整采样

最终工作区版本motionStaticBatchingEnabled缺省false，普通入口保留原绘制；此处CLI显式启用实验后按OFF/ON/ON/OFF采样，原始报告同时保存默认状态快照（1440p默认groups=0、未新增运动合批；默认初始draw=1325/active=1526），实验ON不代表默认产品表现。

同一370实体场景、322模型实体/17种实际GLB，固定原资产116文件/225756283bytes；录制1334条、69.48秒、94topics（92 conveyor、1 stacker、1 rgv），CLI识别105个适用绑定。每段完整采样均1222消息，不能扩称所有设备/全部取放货轨迹100%现场验收。脚本、六类Driver、createEngine及原资源的SHA保护见 delivery-integrity.json、final-resource-integrity.json。

硬件Intel UHD630，真实WebGL2/D3D11、DPR1；物理屏2560×1440。4K为3840×2160真实帧缓冲、完整PNG，未称物理4K屏。窗口visible/focused且关闭background throttling；计时期间无本任务构建、测试、其它测试浏览器或CPU profile。GPU帧时间不可用，不能推导GPU耗时。

| 帧缓冲 | 默认路径OFF两段中位FPS | 实验ON两段中位FPS | 汇总差 | 采样执行 |
| --- | ---: | ---: | ---: | --- |
| 2560×1440 | 5.7428 | 2.9003 | -49.50% | 4×60秒完成 |
| 3840×2160 | 4.3238 | 2.6756 | -38.12% | 4×60秒完成 |

各段独立FPS/CPU帧时间/Draw Call/Active Mesh及消息数、画面和计时后来源拆分见 final-factory-summary.json 与各目录result.json。median只汇总两个样本，不等于统计显著或可复现提升；须看各段一致性。1440p冷/暖为83.820/84.901秒；本地新Electron/userData与同进程renderer reload，未清OS文件缓存。冻结P1未能在原门禁内就绪，因此这不是完整P1 FPS或真实中台30%基线比较。

## 复验入口

在仓库根运行下列命令。它只操作工程副本和独立临时userData，正常产品入口不启用实验；4K将输出目录另起并改为3840×2160，保持DPR1和相同回放。不要与构建、其它测试、浏览器profile并行采样。

```powershell
node output/project-optimization-p2-20261021/factory-abba.mjs --scene output/project-optimization-p2-20261021/fixture-project/Scenes/p2-factory370.scene.json --workspace output/project-optimization-p2-20261021/fixture-project --project-root output/project-optimization-p2-20261021/fixture-project --output output/project-optimization-p2-20261021/recheck-1440p --replay output/project-optimization-p2-20261021/real-mqtt-replay.json --modes motion --seconds 60 --repeats 4 --warm-opens 1 --no-timing --fullscreen --render-width 2560 --render-height 1440 --require-motion-batch --draw-composition --mutable-proof
```

## 问题处理与未完成项

原16包harness曾只等基础批次，提前把未初始化variant计入相机边界，造成8项新增假失败；同GPU开关逐字节对照定位后，等待所有variant measurementReady且非starting，保留原阈值。Vite旧优化依赖504轮次、加载85%超时、纹理派生字段拒绝、无实际groups的轮次均保留为失败/诊断证据，不充当FPS收益。

真实加载profile 128.392秒定位非model canonical几何hash self约14.6秒及重复材质监视相关约18秒，分别由精确缓存和同遍历共享削减；没有改动作算法/检查频率/加载超时。随后完整MQTT profile确认环境整包canonical在每次来源刷新重新编码：OFF/ON诊断分别约19.855/8.996秒。新增按Scene弱键单last缓存，保留原[revision, ordered surfaces(key,positions,indices)]表达式，每轮精确检查实际数据/type/布局；object revision、accessor目录及未知读取器回原路径。21项完整缓存回归及17项既有分类/策略通过；90,711数值×4轮的编码362,844→90,711，暖轮额外0；没有降低检查频率。正式重测前一轮1440p汇总+0.45%但不一致、4K−30.11%的原始失败仍保留在factory-final-1440p/和factory-final-4k/，不能用新轮覆盖历史。第一次整组缓存后真实1440p冷/暖98.691/93.348秒，仍没有明显收益；随后计时后只读GPU探针确认680环境surface（522Mesh/158InstancedMesh）均为原生reader，顶层全部是Hybrid Shadow内部回调，导致严格top相等的trusted判定一直拒绝缓存。真实Hybrid红测复现额外216次编码。新增同Geometry与函数双弱键固定delegate登记，未知/循环/跨Geometry/冲突仍失效，不改原函数体或调用/异常/释放顺序；3消费者仅4处登记，去除登记后与入场版逐字节相等。完整缓存26+原分类/策略17+motion98共141通过，最后正式整场景结果以上表为准。完整过程索引保留在 task-record-history.md、factory-loading-profile/profile-top.json、motion-*-report.json、non-model-cache-*。早期P2 readiness副本曾误沿用P1文件名，故不引用被覆盖的p1-factory-readiness.json；冻结P1证据用独立p1-stack-diagnostic与baseline-app provenance。

4K全部计时结束后按原有五个key分量诊断：910候选形成729桶，706单例、23个共享桶覆盖204原件；geometryContent728种、nodePath148、materialSchema11、actualTextureIdentity9、presentation2。假设去掉几何内容条件会把805行放入共享桶，但那会合并不同几何，不能作为合法优化。实际key已按数值内容而非Geometry对象ID分组，因此makeGeometryUnique的对象身份不是该差距的主因。后续要研究不同固定几何的合法聚合及每子部件身份/照明/显隐映射，不能删除几何条件或安全检查来追指标。该诊断在FPS窗口后重建布局，恢复原开关状态，raw报告motionGroupAnalysis保留计数。

剩余P2工作必须保留：

1. 当前固定结构合批覆盖有限且未获性能收益，默认关闭，1440p实际就绪Draw1320/Active1522未达到<400/<1000；计时后模型973→965原件draw，另3次motion batch，收益不足，不能直接外推204原件全部在当前相机可见。
2. 稳态FPS须有各段一致的复现证据；2560×1440 OFF 5.832/5.654、ON 2.813/2.988，汇总-49.50%；3840×2160 OFF 4.341/4.306、ON 2.707/2.644，汇总-38.12%。采样门禁完成不表示性能通过；未达到可复现提升的指标时，保留未验收状态。
3. 真实中台冷/暖30%+没有可用同条件基线；本地副本与模拟HTTP不是该验收。
4. 跨会话参数几何模板、单同步onStart<50ms及所有设备轨迹100%并未完成；不通过跳过脚本/减少消息或动作频率解决。

最后环境缓存变更不改脚本、primitive/model hash或画面算法，16包与生产Viewer先前证据的受影响边界由原canonical等价回归和本节最终工厂GPU对照补充；没有把重复组件计数当FPS。

不进入P3/P4，不将P2.3及P2总验收勾选；没有提交、推送或发布。所有本任务临时应用/回放服务在脚本finally清理，最终进程归属核对另存 cleanup-final.json。
