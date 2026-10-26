# L8严格等价可行性与验收评估

日期：2026-10-24。只读任务；没有改产品、SDK、测试或全局登记，没有运行tests/build/Chrome/Blender。仅源码阅读及本文件、output/render-optimization-q1-20261024/l8/feasibility-review.json。L3/L4/L5/L6/L9保留原实现，不在本项恢复或实施。

## 结论

**原方案的includedOnlyMeshes范围裁剪，不能在当前公开Light策略和无限制脚本合同下证明全局严格等价。L8未实施，保留原路。** 确实存在非零受光slot减少且数学上不改直接光的静态正例，但必须附带闭世界/无外部观察、无promotion和shader-key预算等条件；当前项目没有能证明这些条件的准入合同，不能把全部fallback/零覆盖包装成实现。

一个不依赖GPU测量的公开合同反例：原本无用户过滤、几何位于硬range外时，SDK的light.canAffectMesh(mesh)仍为true；L8若通过原生include/exclude真正剔除该mesh，该调用就变false。真实模型脚本可用node.getScene().getLightByName(...).canAffectMesh(childMesh)分支驱动位置或输出。即使像素贡献原为零，也已经改变允许的脚本行为。仅改私有lightSources同样暴露于公开mesh.lightSources。因此这不是靠多截图可消除的严格脚本等价缺口。

## 已确认的实际调用链

| 所属源 | 证据与影响 |
| --- | --- |
| SceneMeshPresentationController.ts:142–174、207–224 | 实体point/spot在创建时显式FALLOFF_STANDARD，range随组件同步；外部脚本与GLB灯不能据此一概认定同衰减。 |
| SceneLightRigRuntime.ts:33–54 | fill优先级90、managed main优先级100；SDK还按shadowEnabled与renderPriority排序，不能只按文档插入顺序推定前4盏。 |
| EnvironmentAndSkyboxController.ts:175；SceneShadowRuntime.ts:798–828 | 实际统一使用hybrid；PBR/Standard cap会扩大到enabled且intensity>0的scene灯数，不固定为4。仍存在下面的hybrid截断反例。 |
| SDK materialHelper.functions.js:428–432、581–633 | BindLights和PrepareDefines都按mesh.lightSources前k绑定；集合缩短会重排slot及改变LIGHTCOUNT/各类LIGHTi定义。 |
| SDK light.js:375–391、603–634 | canAffectMesh只看include/exclude/层掩码，不看range；includedOnlyMeshes=[]表示不限制，不能表达空受光集合。setter挂钩push/splice并全scene resync，改变meshSources会标LightDirty。 |
| SDK instancedMesh.pure.js:59–64 | 原生实例的lightSources直接来自source._lightSources。按一个实例的世界球改变source受光会误伤其它位置实例；thin实例同样共享mesh受光列表。 |
| SceneLightingRuntime.ts:937–1018 | 当前GI运行时已拥有“原用户策略+owned proxy additions”的合成/实时编辑/恢复协议；另一个include writer会被当新用户修改，不能独立抢写同数组。 |
| ExternalModelScriptRuntime.ts:181–184；SDK Node.getScene | 脚本接收真实Node且能访问Scene/Light，公开数组、canAffectMesh、lightSources和Light.serialize的变化可直接观察；不等于只有像素变化才算脚本差异。 |

已有tests/lightingBake/sceneLightingRuntime.test.mjs:330–354明确要求native point过滤继承源/proxy、用户push/replace实时生效，清理后仍保留最新用户策略。tests/runtime/localLightShadows.test.ts:23–69要求冻结材质在新增/移除/切换灯后实际SHADOW定义正确，不能以保持冻结/不dirty来掩盖应有编译。

## 衰减、slots和shader预算

SDK pbrDirectLightingFalloffFunctions.js:4–9：STANDARD为max(0,1-distance/range)，GLTF为反平方乘具有range硬零区的平滑系数；PHYSICAL为1/maxEps(distanceSquared)，不读range，不存在硬截止。PHYSICAL spot角衰减也是指数形式（26–28），不能按外锥假设零。Light.FALLOFF_DEFAULT还须看实际material的衰减定义。Light与PBR材质的falloff常量编号不同，不能混用数字。

必要的“无promotion”条件可精确写为：对每个实际submaterial，A为原有序lightSources、k为实际cap、D为可证明零贡献的候选，要求first_k(A去掉D)不引入任何原first_k(A)以外灯，且存活灯相对次序保持。n<=k是一个充分的无promotion特例，但不是当前全部路径的事实。删除原前缀零贡献灯后让第5盏增亮，是画质变更，不能称修正后的等价。

实际hybrid仍能截断：顺序main、fill、far-positive、enabled-zero-intensity、near-positive。SceneShadowRuntime正强度计数为4，cap仍4；SDK meshSources不排除零强度灯，原绑定前4。删除far会推广near，改变原像素。此为源码推导的待跑硬件反例，尚未称实际复现。

只在成员变化时写不能证明shader预算不涨：每次变化仍触发LightDirty，改变LIGHTCOUNT、slot类型/falloff/shadow/sampler定义。静态范围分区也可能把原一个define-key分裂成多个。必要门槛是全部目标key已在原baseline自然存在或能证明新key集合不大于原集合，并分别记录实际GPU compile与material重准备次数；不能把GPU cache hit当CPU重准备不存在。动态按移动阈值更新还会在跨界时漏一帧，无有限运动上界/严格同帧失效合同不能使用近似阈值。

range必须是实际shader有效的有限正硬截止，不包括MAX_VALUE/Infinity/上传后有效无限哨兵。静态bounds还须涵盖所有实际顶点及浮点误差，不能忽略骨骼、morph、顶点位移、同source实例分布或边界舍入。ShadowOnly、非默认lightmapMode、Node/Custom/未知plugin等路径不能仅由直接光attenuation为零推出最终输出零；SDK lightFragment.js:5、328–357另有不经该衰减的输出分支。

## 非零但尚不可交付的有限正例

可用三块静态普通Mesh、Hemi+有限STANDARD point、cap>=总灯数，均无脚本/外部观察、无GI/特殊shader/变形/实例。near网格仍用2灯；far网格在硬范围外拟从2灯变1灯；另一个原本由用户策略排除point的网格已自然提供同一material的1灯shader key。这样候选far网格确有一个已绑定零贡献slot被省去，且全场1/2灯keys在baseline已经存在，不是零覆盖伪正例。

这个例子只说明渲染层正例存在。native include改动依旧可被脚本观察，项目没有sealed light policy或“不可能有外部读取/写入”的能力合同。扫描脚本文本未出现lights/include不能证明动态别名/Node.getScene不可达。不能因此宣称实际全项目可启用子集，更不能绕开用户的严格脚本条件。

## 最小真实硬件A/B计划（尚未运行）

1. 先在裸SDK复现cap4/5灯promotion负例和PBR physical距离外非零；再用实际SceneRuntime复核上述hybrid-zero-intensity反例。候选必须保持原像素，不许以推广近灯作为成功。
2. 验证空受光集合：所有mesh范围外时，[]仍会全受光；记录实际canAffect/bound slots/defines，而非目标集合长度。只有0候选或全部fallback，标未覆盖，不报收益。
3. 在真实ExternalModelScriptRuntime中记录公开include/exclude数组身份/内容、canAffectMesh和mesh.lightSources；再沿已有GI snapshot真实fixture做source/proxy、实时push/replace、comparison/clear。任何观测或用户策略变更即失败。
4. 两个同source原生实例分别在范围内外，加thin组与移动/瞬移/父链更新、finite/NaN/无穷哨兵、spot锥边界。无法给完整cohort联合边界与同帧更新的路径明确跳过，不逐实例改共有灯列表。
5. 负例通过后才跑上述非零静态正例。固定硬件WebGL2、viewport、camera、质量与源SHA，原路A/候选B最终RGBA逐字节相同；script/MQTT顺序和数据相同。记录removed-bound-slots、affected mesh数量/比例，不能用fallback0当覆盖。
6. 冷启动及固定动态序列同时记录define key全集、GPU program compile次数、material prepare重建次数与编译耗时；新key/编译/重准备上涨均须如实报告，不能只挑稳态零编译。语义与compile门槛后才另行协调性能ABBA；不与LD5/Blender/其它GPU计时并行。

本轮未编写或启动harness。若原生列表方案仍需保持当前无限制脚本可观察合同，第三步必有结构性冲突，建议在花硬件预算前就保持原实现。renderer内部保留slots/公开策略而跳过零直接光计算属于另一条shader路线，不应冒充原L8已完成，也未在此建议直接实施。

## 现有样本覆盖与下一步

实读factory fixture be3baf77d67aa2f0ccdd995bd4bea5d048575f3828c6a5c5a7405e1709dbb014：370实体、322模型资产实体、318带scriptAssets；唯一实体灯为hemi，实体point/spot为0。此文档不能提供L8非零覆盖收益验收；并不证明加载GLB或脚本运行时没有创建局部灯，后者需根批准的实际运行时inventory。

本轮产物为可行性证据和未来验收设计，非产品实现。根需据严格合同决定L8是否列为未实施并继续保留原路；如继续，只先授权隔离证伪/观察实验，不先维护全局include列表。全部源SHA与结构化细项见output/render-optimization-q1-20261024/l8/feasibility-review.json。

## 实际Native API反例（2026-10-24）

一次Node真实NullEngine功能witness已PASS：FALLOFF_STANDARD/range1，far最近距离99.9134，公开脚本式canAffectMesh读取true→false→true；near一直true。裁剪改变用户include数组引用；[]不是空集合而是不限制，恢复原引用也会再次触发SDK数组方法包装。原exclude及用户原数组内容未改变。EngineStore0→1→0、全部scene资源归零，无清理错误。证据在output/render-optimization-q1-20261024/l8/native-api-witness-{result,evidence}.json，命令node output/render-optimization-q1-20261024/l8/native-api-witness.mjs。

它只证明真实公开API可观察合同差异，不证明完整外置脚本/MQTT、渲染、GPU变体或性能。结合用户最新“保持严格等价，冲突项保留原实现”的优先选择，本轮保留原灯光实现，无L8裁剪产品改动，不计作已实现或收益。
