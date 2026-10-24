# Q1 / LD5 共享实例货物池

日期：2026-10-24。当前状态为已获根代理确认写域后的实现与功能验收。B2/B7/LD1 静默窗口均已结束；仅运行普通 Node 功能回归，尚未启动 LD5 浏览器或性能计时。原 fixture、AssetRuntime、SharedModelAssetCache、driver 与脚本协议保持原实现。

## 原候选要求与验收（未完成项经用户批准保留原路径，不计收益）

- [x] 读取原方案 LD5、生成器/资源加载/真实共享句柄/点击/交接/特效/预览释放链及相关 lessons。
- [ ] 只池 `resolveModelAssetSharedInstancingPolicy(...).mode === 'shared-instance'` 的普通模型货物；实际动画组、骨骼、morph、独占容器与未知绑定均保守排除。
- [ ] 退池前及出池前验证完整图；重置标准变换、父链、名称、可见/拾取状态、材质引用和 metadata，无法恢复则原路径释放。
- [ ] 每件新货物仍创建新 cargo root、owner 逻辑 ID 和 ModelRuntimeEntry；交接期间保留同一 cargo/root/owner/mesh，不进出池。
- [ ] 配置换代/删除/预览退出/场景释放/开关关闭清空相应闲置资源；容量和节点预算有界，句柄恰好释放一次。
- [ ] 复用不依赖 onNewMeshAdded；退池和重新挂载显式通过既有 refreshModelMeshes/refreshModelGeneratorModelMeshes 发结构/光照 dirty。
- [ ] 单元和真实 SceneRuntime 集成覆盖准入、重置、失败与迟到加载；既有 generated-cargo-preload/交接测试不削弱。
- [ ] 真 WebGL、正式遥测入口固定轨迹逐帧 A/B：身份出生/转交/销毁、host/task/container、mesh world matrix、nodeKey/lighting role、可见性、点击及故障外观一致；独占模型隔离保持。
- [ ] 同一输入和冻结版本记录实际实例创建/clone/池 hit、复位与初始化成本、长任务窗口与累计时间；不能用 mock 或 clone 计数代替业务轨迹与性能。
- [ ] code-reviewer 审查及根代理阶段验收后才决定默认启用；两次不可复现净收益则按方案停止并保留原路径。

## 已核对的现有合同

| 所有者/入口 | 实际行为与设计含义 |
| --- | --- |
| modelGeneratorRuntime.ts | 仅按遥测快照解析目标；没有模型资源所有权，不应为了池化修改规则/消息顺序。 |
| GeneratedModelOutputController.loadModelGeneratorModelOutput | 每次创建 ModelRuntimeEntry/root/contentRoot，调用 assets loader；通过 owner map、loadToken、targetSignature、model 对象四重检查拒绝迟到结果。复用仍进入同一提交分支。 |
| ModelAssetRuntimeController.loadModelRuntimeAssets | shared 策略调用 SharedModelAssetCache.instantiate，命名函数确为 `sourceName => sourceName`。导入子树名称没有 cargo ID 前缀；每次 wrapper root/contentRoot 名称有新 owner ID。 |
| SharedModelAssetCache.instantiate | 返回 entries 与幂等 dispose；该闭包持有共享源引用。池保留句柄即继续持源，逐出必须调用原 dispose；不修改缓存计数或引用协议。实际 GLB animationGroups 非空时会克隆独立容器，但外层仍可返回 shared kind，因此单靠 policy/handle.kind 不足以准入。 |
| createModelAssetTemplateKey | 包含 SOURCE 固定快照 contentSha256/资源身份或 sourceUrl/revision；不能只用 targetSignature，避免错用同 URL 的快照、单位或策略。 |
| ensureGeneratedCargoOutputOwner | 新货物调用 createId，metadata 下发新 generatedUnitEntityId、generator/host/container；handoff 只更新同一 owner 的 host/container，不新建资源。 |
| SpecializedTelemetryRuntime + 各 driver | 跨设备交接从旧 map 拆除引用后移动同一 cargo，handoff/lockedWorldRotation/axialLengthCache 属于 cargo，不应进入模型资源池。 |
| readGeneratedUnitClickTarget | 点击身份来自 metadata 的逻辑 owner/generator/host，不依赖物理 mesh uniqueId。物理 ID 可复用，逻辑 ID 必须新建。 |
| createLightingNodeKey | 只用资源内 name、父链和同名兄弟顺序，锚在新 contentRoot；不依赖 Babylon uniqueId。必须恢复原始名称及完整有序层级。 |
| refreshModelGeneratorModelMeshes → refreshModelMeshes | 重收模型网格、修复实例缓冲、合并 metadata、invalidateModelStatistics，并调用 `lightingRuntime.markDirty('model-meshes-refresh-unknown')`。出池必须保留此完整原提交链。 |
| clearModelGeneratorLoadFailureCache | begin/end telemetry preview 均调用。可在本 Controller 的该生命周期入口清理闲置池，不需修改 SceneTelemetryController/SceneRuntime。配置变更和 disposeModelGenerator 可按 generatorId 清理。 |

关键只读源：GeneratedModelOutputController.ts:219、272、667、721、776、889；SharedModelAssetCache.ts:106、302、335；ModelAssetRuntimeController.ts:236、265、refreshModelMeshes；types.ts:179；lightingGeometry.ts:createLightingNodeKey。

## 推荐资源边界

池仅保留退役 `LoadedModelRuntimeAssets` 的 shared handle、imported rootNodes 及其标准图基线，不复用 cargo、owner 或 ModelRuntimeEntry。下一件货物仍创建原有新 wrapper root/contentRoot、新 owner、新 ModelRuntimeEntry，新 telemetry/parameter/texture 容器和新逻辑 ID；只省掉 `instantiateModelsToScene` 与完整导入子树构建。

这样原异步回调捕获的旧 model 对象永远不成为新货物 model，既有 token/model 身份检查仍有效。退池时先撤回可识别特效、detach imported roots、保留 handle，随后把旧 wrapper 的 handle 移交为空并按原 dispose 释放 wrapper。出池仍以 Promise 进入原提交回调，不能绕过 owner/token/target/model 检查；未就绪/失败/迟到任务不进池，维持原 handle.dispose。

池键建议由 **generatorId + generator 当前配置代次 + createModelAssetTemplateKey + 现有 assetSignature** 组成。现有 assetSignature 覆盖 URL/revision/单位/scale/policy；模板 key 补 SOURCE 包 SHA。取用已有配置代次字符串，不再遍历外部输入制造新“不可变”缓存。配置改变立即清理旧 bucket。

本轮限普通 `kind:'model'` generated cargo。内置 mesh 没有 shared-instance 合同；组合成员含阵列强制独占及多资源释放树，应继续原路径。本轮不改组合、动态设备 spawner、AssetRuntime、SharedModelAssetCache、driver 或外置脚本协议。

## 准入与重置字段

首先要求 owner 为真实 generated cargo、asset policy shared、handle.kind shared、animationGroups 为空、加载完成、无 externalScriptRuntime/starting/error、无参数/纹理运行态；实际 geometry source 上有 skeleton/morph 时退 dispose。标准节点只接纳 Babylon 原生 TransformNode/Mesh/InstancedMesh，未知 subclass/自有覆盖访问器或方法、ActionManager/未知新增 observer/外部租约等不认证。

捕获应发生在首次 loadedAssets 创建后、业务 metadata/归一化/外观绑定前，保留 rootNodes 顺序和所有内部节点的有序子列表。不要只存总节点数或名称集合。

| 字段 | 可恢复标准操作与拒绝边界 |
| --- | --- |
| name、id、父链、同名顺序 | 导入子树恢复源命名基线；wrapper 每次新建。内部 ordered child identities、祖先链、rootNodes 内容不一致/新增或丢失节点，直接退 dispose，不静默修复任意图。内部 Node.id 与资源基线对照；新逻辑身份仅写新 owner metadata。 |
| position/rotation/quaternion/scaling、pivot、billboard | 标准 TransformNode API 恢复局部基线；新 contentRoot 再按原逻辑单位换算和 normalizeModelContentOrigin。不能复用上一 cargo 世界矩阵或 locked rotation。 |
| enabled/isVisible/isPickable/layerMask/renderingGroup/alphaIndex/outline/edges | 恢复标准基线，闲置顶层 setEnabled(false)、isPickable=false；未知边缘 renderer 或外部视觉所有权未释放则退 dispose。出池后再执行原 presentation。 |
| geometry/sourceMesh/material | 校验真实源及 geometry/material 对象身份仍为准入基线，不能把共享源本体改回旧数值。替换、dispose、未知材质覆盖或未知资源所有权直接退 dispose；不擅自销毁其他控制器的材质。 |
| metadata | 恢复 loader 资源基线后再由原 refresh 下发新 owner/generator/host/container/generatedUnitEntityId；旧 editorEntityId、effect proxy、fault、旧 logical ID 不可遗留。未知 metadata 类型/访问器不能通过 JSON 深拷贝伪造成功。 |
| callbacks/observers/actionManager | 不能把旧业务闭包绑定带给新逻辑货物。未知绑定拒绝池化；仅凭“资产没有 scriptAssets”不能宣称全场脚本不碰节点。 |

每次退池和出池都重新核对所有权与图，不把上次合格当作永久纯度结论。闲置期间外部修改可导致取用时逐出。重置中异常必须释放该 entry 并记录拒绝原因，不能留下部分启用的图或吞掉原业务异常。

## 特效、选择与光照

已有 `isTargetModelEffectSuspended(mesh)` / `suspendTargetModelEffects(mesh)` 可协调普通模型特效：暂停回调会撤回 proxy、恢复材质/transform，idle 期间持有本池租约；出池/逐出释放自己的租约。进入前已被报警/入场或未知租约占用则保守退 dispose。AlarmColorOverrides 自己持有 Tint/proxy Map，不能只给 mesh 赋回材质后假定其所有者已解绑。

`selection.applyModelSelection(model,false)` **只改 highlighted 布尔**，不清真实选择 pass。旧 owner 仍在 selected/local/external highlight 集合时保守退 dispose，避免物理 mesh 被旧 pass 引用后在新货物上闪现。可在本 Controller 的现有 Dependencies.selection Pick 中增加对已有集合的只读访问，不改选择控制器。

退池 detach 后通过已有 `assets.refreshModelMeshes(model,{})` 重收空列表，明确通知结构/光照 dirty；出池保留原 `refreshModelGeneratorModelMeshes → normalize → parameters → scripts → presentation` 顺序。前者不是靠“没有新 mesh add 事件也大概能更新”，而是调用已有明确 dirty 接口。真集成要监听 dirty/刷新后 role，覆盖同物理 mesh 的旧 owner → idle → 新 owner。

对重新启用的离场 shared source，可调用已有 `refreshDetachedSourceMeshes(scene, importedMeshes)`，刷新其 lightSources/draw wrapper，不把模板注册回 scene，也不改变材质/冻结状态。硬件对照须覆盖池闲置时灯光/IBL变化后的复用。

## 容量与所有权状态

建议内部默认上限：每个 generator/asset bucket 最多 8 个闲置实例，全局最多 32 个，闲置节点总数最多 4096；单 entry 超节点预算直接不留。均为内部可收紧参数，不写场景、不加 UI。多上限按真实数量同时约束，逐出旧闲置项并调用原 handle.dispose。

状态只有 active → idle → active / disposed；每次 checkout 从 bucket 移除后才交给新 model，不能同一 entry 同时被两个 owner 持有。handle 全生命周期只归一个 active model 或一个 idle pool entry；逐出/禁用/代次清理只释放本池持有 entry，active 资源仍按原生命周期终止。预览退出、generator 配置换代/删除和 SceneRuntime.dispose 现有路径均须实测池归零。

内部 A/B 开关仅在 Controller 暴露，关闭立即 drain idle，active cargo 按旧释放。指标至少包括 hits/misses/retained/rejected/evicted/idleEntries/idleNodes/resetMs；原 SharedModelAssetCache instantiationCount 与 modelClone 阶段保持真实计量，不伪造为 0 或把 reset 成本漏掉。

## 已确认不重叠写域

1. `src/runtime/babylon/scene-runtime/GeneratedModelOutputController.ts`：仅模型货物 load/commit/dispose、配置/预览清理、内部开关/指标，扩展现有 Pick；不改 rules、driver、spawner。
2. 新 `src/runtime/babylon/scene-runtime/GeneratedCargoInstancePool.ts`：标准图基线、所有权、guard/reset、容量/清理；不形成通用资源缓存框架。
3. 新 `tests/runtime/generatedCargoPool.test.mjs`、`tests/runtime/generatedCargoPool.integration.test.mjs`、`tests/runtime/generatedCargoPool.webgl.mjs`、`tests/fixtures/generatedCargoPool.harness.ts`，保留既有 tests/fixtures 不改。
4. 本任务记录及 `output/render-optimization-q1-20261024/ld5/`。package/全局入口/task-log 由根登记。

## 证据与开放边界

现有 generatedCargoPreload.harness 的真实 conveyor 流程已断言：转交同一个 cargo/root/owner/mesh，宿主与 metadata 更新、真实屏幕拾取、固定 50ms 轨迹连续；参数、几何、材质、动画目标隔离；cleanup 无 cargo/owner/标记 mesh。新的池测试应沿同一正式入口扩展，不能拿交接 unit 中 `disposeGeneratedCargo:()=>undefined` 的 mock 证明资源池安全。

生产轨迹验收还需根提供/统一安排同一实际场景与 MQTT replay；本设计没有运行该场景。新 helper 的 mock/unit 只能证明局部状态机。真正旧版 A/B 要对齐输入消息、固定每帧时间与相机，区分首次填池成本和稳态复用；实际 clone 接近 0 之外，还要累计 clone+reset+init 与裁切长任务，记录异常暂停，不只选最好样本。

严格的普适脚本等价仍有边界：任意外部脚本可通过 Babylon 场景取得旧物理 mesh 引用，并在其被新货物复用后继续写入；shared policy 不足以证明没有这种别名。当前没有“外部引用已全部归还”的公共能力，不能宣称通过简单快照就证明任意外部脚本安全。候选只认证标准静态图、排除能识别的外部绑定/租约/变形与资源替换，并以真实业务回放检验适用场景；若根要求保留这种任意旧引用的完全语义，需要更强的显式资源隔离/归还合同，或该资产继续原 dispose，不擅改脚本协议以获取池收益。

## 实现进度与本地证据

- 新 GeneratedCargoInstancePool 已建立真实 shared handle 的 active/idle/taken/disposed 所有权与 8/32/4096 容量限制；每次退池/checkout/激活重新核对原型、完整有序图、源 geometry/material、未知 callback/租约与模型动态状态。
- Controller 已接内部 A/B 开关和真实池指标；每件新货物仍创建原 owner/model/contentRoot，原四项迟到检查和 refresh→normalize→parameters→scripts→presentation 顺序保留。迟到或失败提交不进入池，归还本池自己的租约并调用原句柄释放。
- 原 contentRoot 正常 dispose 仍是 ModelIdentity scope 释放入口：lightingClassificationRuntime 的 createModelIdentityState 在 contentRoot.onDispose.addOnce 释放 geometry watches、geometries/rawParts 和 modelIdentities。空 refresh 发 dirty，但不单独宣称已释放分类 scope。
- 2026-10-24 初版 helper 实施前测试因 helper 缺失产生真实 RED；修复两项测试原生 API 前提后 7/7 GREEN。makeGeometryUnique 对已唯一源不会换对象，改用 Geometry.copy.applyToMesh 强制真实替换；InstancedMesh 无 onBeforeRenderObservable，未知订阅用实际 onDisposeObservable。原生 createInstance 不承诺源 metadata 复制，以实际新实例基线作预期。
- 既有 generatedCargoPreload.integration.test.mjs 6/6 GREEN；初版 eslint helper/Controller/unit 0 errors/0 warnings。后续源码变化需刷新受影响验证。
- 新 SceneRuntime 集成及分类 observer/snapshot 多轮证据由根/l2 独立维护；硬件逐帧轨迹、长任务与 clone/reset/init 实测仍未完成，未作性能结论。

### 语义验收与保留失败（非性能）

- semantics-3：Intel UHD630 / WebGL2 / 1100×720，真实GLB加载和正式telemetry store + conveyor driver；A/B各12轮，每臂516个50ms逐时刻样本，birth/handoff/fault/recover/mode2销货的位姿、geometry/material、nodeKey/role、点击身份归一后完全一致。first与transfer两张PNG逐字节相同；已目视检查真实青蓝货物与输送机渲染。
- A实际SharedCache实例创建12次；B创建1次、命中11次、拒绝0、reset23次，退出preview后cargo/mesh/owner/idle全零。参数/动画/材质独占隔离通过。自建Chrome/Vite已finally关闭。该轮允许与构建并行，仅说明功能，不宣称耗时或长任务收益。
- semantics-1为验收脚本字段冲突：旧renderer对象的version被getGlInfo字符串覆盖。新fixture改独立webGLVersion后确认2；原失败结果保留。
- semantics-2得到hits10而预期11，但runner在写B raw前断言，缺B retained/rejected/evicted/逐轮clone分布；无法确定原因，不以semantics-3通过消除该现象。hit-shortfall-audit.json保持UNRESOLVED_PRIOR_HIT_SHORTFALL。新版先写每臂raw，增加逐cycle birth/retire指标；确定性active重叠测试只证明合法miss机制，不声称解释该历史失败。
- 自审callback所有权P2：原suspendTargetModelEffects先增加WeakMap计数再调用registered callback，throw时不返回release。真实sentinel RED后获根批准新增纯hasTargetModelEffectSuspensionCallbacks查询；capture/put/valid有注册绑定直接退原dispose，不调用callback。11项unit GREEN，验证纯查询无mesh getter且不改变原suspend回调1次/原异常对象。TargetModelEffects原函数实现未改。
- canonical source name/transform变化可能让池baseline过时，正在由l2用disabled真实新实例对照证明；未关闭该正确性缺口，未进入性能计时。

### 最新功能修复与冻结（11:00）

- l2独立source name/position差分证实旧池baseline可过时，已增加canonical source父链和完整有序图、native clone输入的对照；变化退原loader，不修改共享源。wrapper clone的metadata非null直接保守排除，physical Mesh→InstancedMesh的metadata只保留opaque引用，不探测其prototype/clone/slice，实际Proxy traps=0。
- GLB常见空Mesh wrapper未初始化subMeshes，旧sourceValues产生真实TypeError RED；改空列表等价读取。Controller在可选capture前先持有原handle，使capture与后续初始化throw均能原catch释放。新15unit GREEN；l2 20/20 GREEN覆盖flat/TransformNode/empty-Mesh、capture/post-init异常收束。
- semantics-5-empty-mesh-fix在874/65d源上PASS：A/B各516逐时刻、两PNG SHA一致，12→1次真实实例创建与11hit，24个逐cycle checkpoint/臂，无拒绝，退出preview清零。root普通suite并行，耗时和longtask仍不作收益结论。自建Chrome/Vite全部finally关闭。
- 已有own-method guard顺序P2：先调用isDisposed再拒绝own覆盖会额外执行callback，真实sentinel RED；现在先拒绝覆盖，canonical source也先检查own isDisposed。16unit GREEN，等待l2最终disabled/enabled退役callback次数差分与完整回归。仅封闭该已确认调用点，不扩任意私有字段审计。
- 当前产品freeze：Pool a6ea671c6c8885e41ba8e581ad4760c4e37f33432836736ed61b26f91f02719c；Controller 65d8e8f5a18f28cf168fb469dfcb39cd07adb1334c3f6dbc478068f6be356c6e；TargetModelEffects a548286a18ca94c85f225e1b543a0898a2110f3bcbd79f4e686f3815fc79f6f5。
- 定向mutant上一有效报告为15GREEN+6EXPECTED_RED，各为目标断言1次失败。source-inputs第一次因断言格式化巨大Scene而确认本任务PID后停止，INVALID日志已保留；将nullable检查转Boolean只避免巨大diff，不降低条件。最终16项版需刷新report。

### 有界 public API 守卫补修（11:17）

- root 将 Pool、unit、integration 及本记录写域转交 l2，原 owner 已停止相关写入。先以真实 SceneRuntime 的 disabled/enabled 首次 checkout 建立 RED：disabled `getLODLevels` trace 为 `[]`，旧 enabled 多一次调用。原因是 `sourceOf` 在后续 `standardSource` 拒绝 own 方法前先执行该方法。
- 只沿现有实际调用点补前置守卫：Node/父图方法；source 的 `getLODLevels/getTotalVertices/getBoundingInfo` 及公开访问器；Vector3/Quaternion 的 `clone/asArray/copyFrom/copyFromFloats`；公开 pivot Matrix 的 `clone/copyToArray/copyFrom/isIdentity/invertToRef/markAsUpdated`；Observable 的 `hasObservers`；BoundingInfo/BoundingBox 的公开 min/max 读链及 source subMesh 五个已读取字段。未知 own 方法或访问器在新增调用前退原资源路径，不执行其 getter/callback。
- 新21个真实对象子例先在旧源抛出对应 sentinel RED；修复后两文件33顶层/61含子项全GREEN，包含原16 unit与21 integration。12轮真实分类/签名后仍为11 hits/1 instantiate，scope observer和缓存字节有界。最终 eslint 0 errors/0 warnings。证据：`output/ld5-integration/public-api-{review.json,final-green.log,final-eslint.log,final-sha-check.json,pool-delta.diff}`。
- 新冻结 Pool SHA `a61202b9c78604622d2eca250106ebe13c973d316c8dca92059a16139e04bc13`，Controller `65d8...56c6e`、Effects `a548...9f6f5` 未改；unit SHA `16c96b67...94fbabc`、integration SHA `1cc86514...312fc55`，五项 before/after 一致。
- 本轮不扩大为任意私有字段图审计；未证明未知 Proxy Node/数学容器的反射 trap 零增量，未证明任意外部旧 mesh 别名或全局 monkeypatch 的普适等价。opaque source metadata 的 Proxy 差分仍通过。`refreshDetachedSourceMeshes` 的内部 resync/light/defines 闭包未冒充已穷尽审计。
- 新增守卫后的精确 SHA 硬件 nonzero hit、代码独立审查及性能收益仍由 root 收束；旧874硬件证据不冒充本版，不把clone次数或NullEngine功能通过称作性能验收。

## 真实业务拒绝与默认值收束（build5）

最终a612 Pool对真实塑料托盘12轮功能B臂为0hit/12miss/12reject，全部unknown-source-clone-input，原raw与checkpoint已保存。两个wrapper仅因metadataCopied=true且metadata非null被拒，实际由Babylon AddPointerMetadata创建空对象；没有JSON extras。真实clone会观察metadata.slice/clone，因此不能清空或放宽guard。唯一源诊断在同步记录后render/dispose出现postProcessManager页面错误，整体FAIL保留，事实及限制见output/render-optimization-q1-20261024/ld5-prep/source-clone-analysis.{json,md}。

严格业务等价和净收益未验收，Controller现显式默认off，仅内部A/B启用。默认两次出生/退役实际新建两个不同mesh且均dispose，instantiationCount2、hit/retained/idle0；定向GREEN，不虚称RED（误排初次作业标记INVALID_RED）。Pool本体a612不变，Controller及新增测试的新SHA见candidate-independent-review-final.json，build5已包含。旧874合成GLB语义、61项功能和新默认路径证据分别保留，不能合并成实际业务性能验收。

## 用户批准的交付收束

用户已明确选择严格等价优先：保留原运行路径，候选defaultoff，记录缺口并交付其余Q1。当前候选不计入已验收优化/收益，不继续本项实现或性能采样。本项新边界选择已解决，不再重复询问；原局部证据、失败与限制保留。
