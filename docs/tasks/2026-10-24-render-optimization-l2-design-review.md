# L2 可靠失效边界与实现设计复核

日期：2026-10-24。范围：独立只读调查产品与测试；仅编写本报告及对应 JSON。基于当前未提交工作区，不假定上轮候选仍存在。

## 结论

**最终验收裁决：下文为设计调查和候选历史，不能作为L2或Q0达标证明。** same-pass memo审计候选因两轮受控负收益停止；随后F1/F2两个物化变体虽然差分行为一致，但真实工厂完整collector两次均更慢，主代理已决定完整撤回物化及相关诊断分支。没有获准推进Q1。最终实测和撤回范围见文末。

可以实施 L2，但不能再用 Geometry/Material 引用和宿主直接 name/parent 代表全部输入未变。推荐在受控 provider 的 **同一次收集 pass** 内保持原来的资源枚举、原始几何核对、节点路径和脚本/驱动读取，仅复用纯策略解析结果；纯宿主净成员往返由 Runtime 选择这个 pass。变化时在本次 pass 中完成正常解析，不再次调用 provider。L2 只允许省分类工作，`bindingsDirty` 及绑定/烘焙有效性检查继续保留。

这种基础能可靠发现上轮漏掉的 raw positions/indices 和祖先/同名兄弟变化，也能保留未知脚本回调在同轮修改后续来源的行为。它不会省掉原始字节扫描或目录遍历；必须如实报告审计总成本和 resolver 命中，最终收益由工厂实测决定。

独立预审计再决定是否 collect 会增加未知 getter/Proxy 探测以及失败后的重复回调风险，作为首版实现复杂度更大。若使用独立审计，必须有实际对象来源认证，不能把 `instanceof`、函数引用相同或 `Object.getPrototypeOf` 当作任意脚本对象纯度证明。

## 当前生产入口和状态合同

| 位置 | 当前行为 | L2 要求 |
| --- | --- | --- |
| `ModelAssetRuntimeController.ts:369-383` | suspend 调用 removeMesh；restore 只恢复本运行时主动移出的宿主 | 此处登记受控宿主及事件归属，不改变 add/remove、启用、拾取时序 |
| 同文件 `475-497` | 脚本生命周期前 restore，启动 render suppression，settle 后更新和解除 suppression | 不能把事务前后的 unknown 改成 pose/member |
| 同文件 `462-471` | 重新枚举模型网格及元数据后标记 `model-meshes-refresh-unknown` | 原次数、时序和 full 路径保留 |
| `SceneTriangleAndReadinessController.ts:511-533` | 同步转发原生 add/remove，过滤受控临时和 lightingDerived 网格 | 转发 mesh 实体和原因；未知网格继续 full；不改原观察者广播 |
| `SceneLightingRuntime.ts:201-223` | unknown 使 classification/bindings 都 dirty；现有生命周期方法只合并重复标记 | 单独追踪 pending member 集合及是否混入 non-member 原因 |
| 同文件 `480-503` | getSources、重复 key 校验、原子替换来源，revision 防重入 | 审计成功才能消费当代分类；失败不更新基线；重入保留新代 dirty |
| 同文件 `743-778` | 刷新分类后校验静态几何、布局、材质，更新角色 | L2 跳分类时仍执行本路径，禁止直接清除 bindingsDirty |
| `EnvironmentAndSkyboxController.ts:411-431` | 建立模型/变体/生成物/primitive/batch/ownership/environment，调用标准 collector | 仅该明确连接的 provider opt-in；默认 RuntimeOptions.getSources 保持 full |

Runtime 净成员判定只可作为选择审计 pass 的条件：已有成功基线、纯已登记宿主事件、当前成员状态回到基线、无 controller/pendingActivation/消费重入、无 unknown/classification/structure。scene.meshes 或来源顺序变化即使集合相同，也必须在 pass 中反映；不能只比较 Set。

## 完整分类输入清单

所有行均来自当前 `lightingClassificationRuntime.ts`。下列输入不是全部都有可靠通知，故仍需按原观察顺序消费。

| 输入组 | 必须覆盖的事实 | 源位置 |
| --- | --- | --- |
| 来源目录与顺序 | models 有序 entityId/model；model.meshes 与 contentRoot 子网格的 Set 合并顺序；scene.meshes 成员和顺序；primitiveMeshes 有序键值；environment 有序 key/mesh；batches 去重顺序 | `435-453`、`570-601` |
| 身份和结构 | model.contentRoot、assetRevision、parameterSignature；相关 Geometry、Position buffer/layout、原始 positions/indices；资源中每一部分完整 nodeKey；环境实际 source revision/key/mesh；primitive partKey | `100-235`、`252-295`、`328-394` |
| 完整节点路径 | 从当前节点到 contentRoot 的各层 name/getClassName、parent、parent.getChildren 同名兄弟顺序；isShadowCaster 的祖先一直到全局根 | `lightingGeometry.ts:44-52`；`SceneShadowRuntime.ts:83-98,149-158` |
| 可参与性 | isDisposed、getTotalVertices、isShadowCaster、lightingDerived；未知 runtime mesh 的 isEnabled/editorLightMarker；modelArrayBatch、telemetryProxySource、render suppression | `480-485`、`587-601` |
| 归属 | sourceOwners 的 ownerEntityId/parentDynamic/deviceType；batchOwners 的 entityPrefix/owner/nativeCarrier；生成物 owner 输出 kind/member 顺序/metadata | `53-95`、`477-491`、`570-584` |
| 文档与祖先 | 当前 entity（document 优先，后 owner，再 model snapshot）、id、parentId 祖先链、components 的 lighting/modelAsset/telemetryBinding/deviceSpawner/manualRoamSpawn/autoPatrol/meshRenderer；父级自动 mobility 输入 | `397-421`、`455-470`、`487-491`；`lightingMobility.ts:18-34` |
| 真实模型配置 | resolvedModelAsset / entitySnapshot.components.modelAsset / entity.components.modelAsset 回退；当前 model.sourceUrl 与实际 sourcePath/dataPlatformModel；capabilities、telemetryBinding.deviceType | `404-421`、`489`、`539-551` |
| 运动证据 | getMotionTargets 本轮 moving/fixed/known；每来源重新构造 Set；assetHandle.animationGroups/targetedAnimations/target 的原迭代与读取次数；actualNode 完整祖先；skeleton/morph.numTargets | `495-520` |
| 脚本证据 | parameterScriptMetadata/animationScriptMetadata/scriptAssets；externalScriptRuntime 的存在及每来源 getDataDrivenConfigs().length；这些 getter/回调可改变后续来源事实 | `507-520`；`lightingClassificationScriptSemantics.test.ts` |
| 实例映射 | getLightingInstances 实际返回的有序 mesh/sourceMesh/entityId/sourceIndex；resolveBatchSource 结果；重复实体路径 ordinal；native thinInstanceCount、matrixData 足够长度决定可枚举 sourceIndex；adapter/batch 对象引用 | `481-485`、`570-584`；`lightingNativeInstances.ts:22-40` |
| 策略与显示 | normalize 后 policy 全部规则、目标、值、名称、nodeRules；entityLighting 中 inheritance、resourceIdentity、当前 nodeOverride；availableNodeKeys 完整目录；nodeKey/partKey/resourceIdentity/motionRole/automatic/parentDynamic/deviceType；actualNode.name || mesh.name | `438-451`、`533-566`；`sceneLightingPolicy.ts:182-200,290-373` |
| 环境 | document.sceneSettings.environment 的 active URL/variants/sourcePath/revision；environmentRuntime 实际 environmentSource 优先；environment surface key 列表 | `472-476`、`522-527`、`539-540` |

材质内容、UV/normal/tangent/color、矩阵不直接进入分类资源身份，但会影响绑定/几何和静态 GI 验证。保留 bindings 路径会继续读取它们；因此不能把上述分类审计当作“全部光照状态未变”的证明。

## 建议的同 pass 实现

1. `SceneLightingRuntime` 跟踪纯成员 pending 和已经成功消费的基线；只给登记 provider 发送可选 `audit` 请求。unknown、文档同步、结构变更、未知 mesh、重入及异步事务一律正常 full。
2. producer 的目录准备仍执行一次。collector 所有原枚举、原始数据检查、路径、motion/script、动画等继续在原位置执行，避免审计失败后再重读这些有副作用输入。
3. memo 仅放在 `resolvePolicy` 的纯数据边界。当前 `matchedIndices` 原计算仍执行；标准策略是 normalize 函数新建的纯 scalar 图，但 context 的 `entityLighting`、`dataPlatformModel` 和 entity 仍可能含未知对象，不能仅因 policy 已 normalize 就认证它们。
4. 只使用 collector 已捕获的自有 scalar/array 数据构建精确 memo 键。键应包含规范化 policy、规则匹配序列、entityId/ownerEntityId/entity.id/parentId、完整祖先列表、actualAsset 各字段、deviceType、node/part/资源身份、motionRole、automatic mobility/reason、parentDynamic、entityLighting 与 inheritPolicy/override、完整 availableNodeKeys。不要只依赖内容 hash；纯数据可使用无歧义 canonical 字符串，未知值走 full。
5. `sceneLightingPolicy.ts:329-330` 说明 Runtime 显式 own `entityLighting`（包括 undefined）会阻止旧组件回退，但 resolver 仍会读 entityFor、entity.id，非 all target 仍可能读 entity.components/parentId。这些额外事实和读取副作用不能漏掉。无法认证时本来源照常 resolver。
6. memo 内结果与公开对象隔离。`getClassification` 和当前浅复制会暴露 entry 内 fieldSources/policyContext 等嵌套引用；不能用曾返回给消费者的对象作为不可变缓存。首版可仍创建来源/entry，只复用私有纯解析结果并复制可变子结构；若复用旧 sources 数组，必须额外证明旧输出未被调用方改变。
7. raw geometry 与完整 path 每轮仍核对。`modelIdentity`、`primitiveIdentity`、`environmentIdentity` 已含精确 raw snapshot，不应建立第二份几何副本。可把其结果作为当前分类事实，保持现有 fallback 和生命周期释放；不要把它们的 callback revision 简化为权威版本。
8. 仅成功完成重复 key 校验且 revision 未漂移时提交新基线/memo 世代；异常保留 dirty，不能提交部分输出。新代失效不能被本次 audit 清掉。

这不是 Q1 按模型增量分类或分片调度：所有真实输入仍在一次原子 pass 中消费。可消除的是纯策略解析和可证明未变的结果构建成本。若在工厂里不能形成可复现收益，不能把 memo 命中率当作 Q0 性能验收。

## 标准 runtime 和 driver 的纯度边界

- `ExternalModelScriptRuntime.ts:68-99` 的 canonical `getDataDrivenConfigs` 只返回构造时创建的数组，方法本身纯读。可在 constructor 建私有 WeakMap provenance，先以对象身份查询；未知 runtime（含 Proxy）在任何额外 descriptor/prototype 探测前直接 full。
- canonical 方法返回非空数组仍不能证明 driver 纯：各 dataDriven 项来自任意脚本，嵌套 getter/Proxy/iterator 可有副作用。空 configs 是最小安全独立审计子集；非空需要 ingestion 时可信 plain-data provenance，或使用推荐同 pass，不多读一次。
- `SpecializedTelemetryRuntime.ts:67-74` 默认门面只选择 driver。Stacker `1416-1452,1495-1504,1560-1603`、Shuttle `1538-1595`、RGV `328-357`、Lift `294-295`、Hclift `316-317` 的目标解析会深入配置或节点方法，canonical 门面身份并不涵盖所有输入。
- RGV 的光照入口 `rgvDriver.ts:58-59` 明确传 `reportIssues=false`，不会在光照扫描中重复记录无轨道诊断；不能把普通运动调用默认 `reportIssues=true` 用作替代审计。
- JavaScript 没有通用无副作用 Proxy 识别。对未知对象调用 `Object.getOwnPropertyDescriptor`、`Object.getPrototypeOf`、`Object.isFrozen` 也可能产生新 trap；事后“检测是否普通对象”不是行为等价的完整证明。

## 必须覆盖的反例与验收

1. 已挂起宿主 raw positions 和 indices 分别原地改写，不调用任何 Geometry API，随后重复 remove；新身份必须与 full 一致。
2. 保持直接 parent/name/Geometry 不变，改祖先 name/parent、同名兄弟先后顺序；路径、可用节点目录、规则失配与 full 一致。
3. 改与当前 pending mesh 无直接关联的其他来源 geometry、metadata、ownership、文档祖先或 policy；消费时仍发现变化，不能只审计 pending mesh。
4. 原生 add/remove 往返、重复 remove、异步 add 的通知顺序、未登记 mesh、真正净成员变化、scene.meshes 同集合重排；只有可证明等价的受控往返可 reuse。
5. `getDataDrivenConfigs` 同轮修改 moving/fixed/动画目标/parent、unknown getter/iterator/Set 接管、Proxy traps、抛错；次数、顺序、this、iterator close 和原错误保持。
6. 审计 pass 中回调再次 markDirty、查询、切换文档或开始/取消资源事务；revision guards 保持，异常后的下一次仍 full/dirty。
7. 改材料、UV/normal、subMeshes、world matrix；即使分类 reuse，bindings 与 GI 过期检查仍生效；硬件阴影/角色逐帧对照不能出现差异。
8. 调用方修改公开 classification 嵌套字段之后再次消费；私有 memo 不受污染，原来正常 collect 会修复的内容仍被修复。
9. 工厂 60 s ABBA 同输入，不改变 unknown refresh/script/MQTT 次数；分别统计 lifecycle full、audit、resolver miss/hit、审计 inclusive 时间和长任务，不隐藏审计成本。

## 设计阶段独立检查

执行：`node --experimental-transform-types --test tests/runtime/lightingClassificationScriptSemantics.test.ts tests/runtime/lightingClassificationRuntime.test.ts tests/runtime/lightingClassificationReview.test.ts`。

结果：exit 0；24 项通过、0 失败、0 skip，26.17 s。覆盖当前 full 路径及其脚本/Proxy/异常行为，是实施后的回归合同；未实施 L2，因此不能据此宣称新方案通过或取得收益。上轮 raw-array/祖先漏失效反例来自已读取的 `output/render-optimization-20261024/l1-l2-review.json`，本次没有把历史候选重新启用。

设计调查阶段产品与测试文件零修改。未启动服务、发布、提交或推送。

## 后续受托helper实现与两轮性能否决证据

按主代理新增授权，在限定写域实施了 `src/runtime/babylon/lightingSourceAudit.ts` 与 `tests/runtime/lightingSourceAudit.test.ts`。根代理负责collector/provider/Runtime接线，本helper不启用Q1按模型增量或分片。

API包含 `registerLightingSourceAuditPolicy`、`registerLightingSourceAuditContext`、`LightingSourceAudit.begin/reset`、pass的 `resolve/finish`。登记只写私有WeakSet，不读取传入对象；调用者必须紧随标准normalizer和collector创建的原始对象登记。未知policy/context在任何额外探测前fallback。仅无规则且entityLighting为null/undefined时memo；复杂策略/例外或intrinsic接管使整pass不能复用。memo最多256个pure key；full模式逐来源compute且每key只克隆一次私有结果；reset解除旧source与memo引用。旧公开自产容器仅用descriptor校验，旧getter不调用；mesh/batch/dataPlatformModel/entity等业务对象仅比较opaque引用。

TDD已先执行缺少helper时的RED（`ERR_MODULE_NOT_FOUND`），随后GREEN。最终命令 `node --experimental-transform-types --experimental-test-coverage --test tests/runtime/lightingSourceAudit.test.ts`：11/11通过、0失败/skip，helper的行100%、分支94.12%、函数100%。涵盖来源身份/完整路径变化、重排、instance索引变化、公开array/source/entry/context/fieldSources getter污染、旧reader替换、两来源及私有memo引用隔离、未知Proxy零额外trap、复杂策略/例外fallback、全局Set与策略字段目录接管、256上限、reset/默认值切换、异常和旧pass世代。

但当前实现 **不能作为已取得收益的默认优化交付**。两轮受控微基准都比较实际collector风格完整来源构造、标准已编译resolver和helper整pass（含finish），每档400/2000来源、4轮warmup、7轮交错；仅未添加两边相同的真实几何/目录开销，不是业务场景性能验收。

| 实现 | 来源 | 原full resolver+row | 审计含finish | 比值 |
| --- | ---: | ---: | ---: | ---: |
| 首版完整新旧descriptor tree | 400 | 1.150ms | 22.836ms | 19.86倍 |
| 首版完整新旧descriptor tree | 2000 | 2.937ms | 112.179ms | 38.19倍 |
| 减少fresh tree分配及改纯clone之后 | 400 | 1.044ms | 13.707ms | 13.13倍 |
| 减少fresh tree分配及改纯clone之后 | 2000 | 3.542ms | 73.082ms | 20.63倍 |

负收益的原因是：默认无规则resolver原已非常便宜，每行完整intrinsic校验以及公开旧输出的可靠descriptor审计远超所省工作。第二版已避免为fresh输出重复建立整棵snapshot，但仍没有收益。不能把减少resolver调用数、旧sources引用命中率或通过测试当成性能验收。按原方案连续两次无可复现收益的停止规则，不继续无依据削弱guard；建议将此候选保持实验/影子，或由主代理以实际collector完整同步耗时提供新的相反证据后再决定默认接线。当前Q0性能门槛未由本helper满足。

## 最终补充：物化F1/F2真实工厂均负收益，停止并撤回

后续CPU诊断发现真实collector累计25.060s，其中create self10.868s；据此另试不缓存、不跳回调的最终条目物化。F1使用settings形状检查及固定四字段展开，F2恢复原生settings spread、只移除可选identity/unmatched/instance的临时spread。两者的400/2000/10000来源受控物化微基准均显示局部节省，但该结果没有通过真实完整collector验证，不能外推。

主代理分别在同一工厂加载后的真实renderer内执行完整getSources；每次42,856来源、4轮预热、7轮交错对照，计时包括wrapper和完整collector，结果fingerprint不在计时内。两次均为独立诊断，没有现场MQTT或FPS验收主张；两次全部7对的完整entry字段、world与来源顺序均一致。

| 候选 | legacy中位 | direct中位 | 实际变化 | 结论 |
| --- | ---: | ---: | ---: | --- |
| F1：形状守卫+固定settings复制 | 274.2ms | 298.2ms | **+8.75%耗时** | 无收益，未通过 |
| F2：恢复原生settings spread | 255.4ms | 273.8ms | **+7.20%耗时** | 无收益，未通过 |

已独立读取核对的原始证据：`output/render-optimization-l2-20261024/collector-factory-1/collector-benchmark.json`、`collector-factory-2/collector-benchmark.json`；两份rows均42856、checks均7且全部equal=true。候选实现/微基准/聚焦测试是候选历史，不是当前默认交付的性能证据。

依照方案连续两次无可复现收益的停止规则，主代理决定完整撤回物化helper、collector direct/legacy分支、environment诊断开关和测试入口，保留历史证据及原先五项、最终B2工作。旧same-pass memo此前也已从产品撤回并归档于`output/render-optimization-l2-20261024/rejected-same-pass-memo`。本代理只补充本记录，不操作产品恢复。

**L2未完成，Q0整体未通过；不能据此进入Q1。** 两次行为差分一致仅证明所覆盖路径等价，无法抵消完整collector更慢的事实。未继续第三物化变体，未启动本轮硬件visual、额外ABBA、浏览器或服务器；此前准备的visual runner未运行。
