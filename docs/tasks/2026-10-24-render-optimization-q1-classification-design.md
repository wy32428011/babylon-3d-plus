# Q1 分类：L3 消费者需求与 L4 影子增量的只读评估

日期：2026-10-24。范围：读取原方案、当前源码和调用链；不实施产品变更。Q0已由主代理在本地范围接受，L2采用用户同意的安全替代口径：full次数可不变，但实际分类耗时下降且行为一致。这个认可不等于L3/L4已完成。

依据：`docs/全项目渲染光照烘焙加载优化方案.md:98-121`。L3原目标是无阴影、无已应用GI、manager关闭且无烘焙/预检时不收集，消费者出现立即补收集；L4要求先影子比较、真实工厂30分钟零差异，再考虑增量为主。已撤回的same-pass memo及F1/F2物化路线保持撤回，不在本评估中重新启用。

## 当前触发与消费者图

| 入口/模块 | 当前行为 | L3需要保留的合同 |
| --- | --- | --- |
| `SceneLightingRuntime.sync:164-197` | document-sync标脏；bake关闭、无有效result、失效快照等分支同步refreshSources | 仅给tick加gate不能达到无消费者零收集；sync分支也需要明确需求判断 |
| `tick:799-841` → `refreshBindingsForSources:743-778` | dirty/bindingsDirty时收集，再做GI校验、角色/代理更新 | 不清掉未消费dirty/revision；GI state、controller、pendingActivation不是空闲 |
| `getClassification:238` | 同步query，强制消费dirty | 显式查询必须即时读取；不能把旧classification当作新结果 |
| `useSceneLightingPreview:185-209` | manager打开时立即query，之后每400ms；Inspector只peek | Runtime目前没有manager lease；不能根据最近一次query猜测持续需求 |
| `setPreview:272-279`、`focusNode:291-309` | 直接收集；debug overlay和定位读取分类/world | debug和定位是实际消费者，即使manager关闭也不能停 |
| `captureBakeInput:312-327`、`applySnapshot:330-408` | 捕获前后、加载和验证期间多次强制收集 | 保留同步及跨await事务的完整校验和revision防重入 |
| `EnvironmentAndSkyboxController.preflightLightingBake:228-239` | 明确markDirty并capture | 预检是强制需求；不能因为尚未进入后台bake而门控 |
| `updateShadowRoles:910-933` | 启停冲突实例代理、隐藏层与instance mask，再设置角色 | 关闭最后一个消费者前要恢复旧代理/mask，不能只停止tick |
| `onBindingsChanged` → `ScenePickingAndSelectionController:562+` | 重建selection，读取getSelectionMeshes，不反向触发分类 | 保留代理生命周期副作用及selection恢复 |
| error/diagnostic polling | manager关闭仍每400ms读错误 | 延迟分类还会延迟duplicate key、未知getter异常等错误发现，需要明确合同，不能忽略 |

完整getSources仅由`EnvironmentAndSkyboxController.initializeLightingRuntime:413-438`连接：依次准备models、参数变体、生成设备/产物、primitive、batch/ownership和环境，调用同一collector。`syncLightingPresentation:175`强制使用hybrid阴影模式，因此L3的主要图形开关是shadows.enabled，而不是推断一个非hybrid模式。

## L3能独立推进什么

可以独立建立需求状态机：manager lease、debug、显式query/focus、capture/preflight/snapshot事务、已有GI state和shadow consumer。无需求时保留dirty和revision；任一需求出现时同步补完整收集；退出需求时先处理代理/层/mask的恢复。Inspector peek仍返回缓存和stale，不暗中消费。

但不能从“分类结果当前无人看”推出“分类过程没有外部观察”。完整collect会执行脚本配置读取、真实motion provider、节点/数组getter和iterator。若严格保留这些业务观察次数、顺序与异常，不能无条件跳过它们。

具体生产边界：

- 明确可认证的最小范围是官方provider且来源目录真正为空：无model/变体/生成物/batch/primitive/环境及相关scene mesh，也无待恢复代理/事务。这里不存在源getter或脚本读取，可延迟分类；收益有限，不能冒充一般有模型场景的L3验收。
- 对有来源场景，当前没有完整的生产端纯度/写入协议。标准runtime方法身份并不足够：`ExternalModelScriptRuntime.ts:167-168`直接保留`compiledScript.dataDriven`原引用；标准RGV driver在`353-357`会经canonical getDataDrivenConfigs深入读取fixedNodes配置。脚本导出的getter/Proxy仍可能产生可观察行为。
- 仅没有外置runtime也不足以认证整个scene：其它脚本可以访问场景节点，节点方法/属性和provider目录仍可能被改写。要扩大范围，需要来源创建时provenance、可达写入边界和未知行为fallback，不能在消费时对未知图追加一轮“是否纯”的探测。
- `getError`是持续显示的输出。若采用延迟错误发现，应将其列为明确行为取舍；若不允许，则通用零收集目标还受到这一合同约束。

结论：需求接线可独立安全实现；现有合同不足以证明任意populated无阴影/无GI场景都能停收集。不能把所有生产provider一概标为unknown后仍宣称L3完成，也不能为得到零收集削弱getter/脚本约束。

## 几何缓存基线疑问：排除依据与实际功能probe

主代理提出：延迟首次fullcollect会不会改变lightingGeometrySignatureCache基线，从而让开启阴影后的automatic mobility与旧版不同？

调用链排除依据：

1. `lightingGeometrySignatureCache`由`lightingRuntimeCapture.ts:48`的getLightingGeometrySignature调用，不直接参与automatic mobility。
2. 完整collector的modelIdentity/primitiveIdentity使用另一套精确raw snapshot；几何引用、callback revision不能代替实际数组比较。
3. 无GI state时，refreshBindingsForSources的751分支直接更新阴影角色，不执行763行的geometrySignature校验。
4. `lightingMobility.ts:18-34`使用配置、父级/动画/驱动/脚本证据，不读取GeometrySignatureCache的历史基线。

本代理实际执行了一次不写文件的Node/NullEngine功能probe（`node --experimental-transform-types --input-type=module -e ...`，本会话exec记录，进程exit0）。它使用真实collectLightingRuntimeSources、getLightingGeometrySignature、标准MeshBuilder/TransformNode及原配置normalizer；不是mock hash。

方法：创建三套同构场景，校准初始资源身份；warm路径先collect并调用getLightingGeometrySignature建立基线；cold路径不先收集。两路径施加相同未通知raw修改后再collect，比较全entry及geometrySignature。另做祖先改名案例。model motion证据固定为已知静态，且设置旧resourceIdentity的node override。

| 案例 | 实际结果 |
| --- | --- |
| raw positions和indices原地修改 | 全entry相同、geometrySignature相同；automatic/effective均static；两路径resourceIdentity均变化；旧override均unmatched=true |
| 祖先name改为renamed | 全entry相同、geometrySignature相同；automatic/effective均static；节点键均renamed[0]/part[0]；身份均变化 |
| 外部观察计数 | warm motion provider调用2次，cold为1次；缓存内容等价不能消除L3观察频率变化问题 |

**证据保存边界：**该probe的命令、stdout及exit状态只在本会话工具记录中，没有将原始脚本、JSON或完整raw另存为仓库文件。当时任务要求只读、先勿编辑，因此本记录是事后整理的方法和观察值，不伪装成已存在的可下载raw证据。需要长期可复跑回归时，应在获准实现L3后将同一场景转为测试；本次没有重跑或补造raw文件。

这足以排除上述纯数据场景的特定因果链，不证明任意未知脚本、provider缓存或getter下都等价。真正问题仍是被跳过的观察及副作用，不是该hash缓存的冷/热起点。

## L4影子增量的协议阻碍

1. **单元并不独立。** collector先建全局modelsByMesh，batch优先占用used；随后影响model、primitive、environment及fallback scene mesh是否收录。batch可解析到另一个模型的源节点。需要依赖图、全局优先级和顺序，不能仅缓存后concat。
2. motion/identity/node-directory缓存目前属于整轮。相同model对象出现在多个逻辑单元时，不能因拆单元增加provider调用。
3. loadToken、Geometry/Material引用与事件计数不覆盖raw数组、完整祖先和同名兄弟变化。motion结果引用既可能每次新建，也可能被原地修改，不能作为可靠revision。
4. 脚本默认能访问其它模型。仅失效宿主和子孙不充分；无法证明写域时必须整场full。
5. **不能执行两遍外部观察做影子。** full+incremental各读一次未知脚本/getter，会改变次数、状态甚至full参考结果。第二遍被丢弃也不能恢复观察合同。
6. 可行边界是full原路径只观察一次，在原读取时点捕获可重放的自有事实，增量候选只消费纯事实。不能在full之后遍历外部图“补拍快照”；那仍是第二次观察。未满足capture协议的单元保持full fallback。
7. 公开classification有可变嵌套引用。内部单元cache不能拿已发布fieldSources/policyContext等对象作为不可变基线；也不能靠高成本全图descriptor审计掩盖这个问题。
8. 比较应包括key/entry全字段、字段存在性、source mesh/batch/sourceIndex及全局顺序。world比较不能再调用一次未知matrix reader；需复用消费者已有一次观察或限制到已证明纯读的reader。
9. 10秒周期对账不能补救不完整失效协议，因为它允许窗口内陈旧；原始数据与路径仍要可靠审计或有权威写入版本。

30分钟门槛必须同时报告：实际shadow reuse次数、eligible单元/来源覆盖、fallback数及原因、外部观察次数与full一致、重复键/重入/异常路径。全部fallback的零差异不能称为L4验收；30分钟观察一致也不能取代协议证明。

## 建议的可变红回归

- L3空闲连续unknown/native失效后dirty/revision保留；开启阴影首帧完整角色与full一致；关闭时恢复layer、instance mask、代理与selection。
- manager/debug/focus/query/capture/preflight/snapshot任何需求都强制读取；Inspector peek仅stale缓存；sync和setPreview初始调用不绕过门控定义。
- 有副作用的实际配置getter/未知provider，其顺序、次数及原异常对象不变；明确纯空目录才验证零收集。
- L4同轮getDataDrivenConfigs修改moving/fixed、动画目标、父级或其它模型时，影子总计仍只有原一次观察。
- 无通知raw positions/indices、祖先改名、同名兄弟重排、ownership及batch顺序、共享源跨单元影响。
- 全局duplicate key、重入失效、跨await事务和公开classification污染；候选不能吞错或覆盖新代dirty。

本记录没有实施L3/L4，没有运行30分钟影子或任何Q1性能验收。下一步应先确定有意义的可认证范围和单次观察capture协议，再实现一项可归因候选。
