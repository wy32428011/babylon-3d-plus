# 阴影与光照烘焙优先级实施方案

日期：2026-10-27  
状态：**第一阶段 P0/P1 已实施（2026-10-28），优化候选默认关闭；实际结果见第 11 节。** P2/P3 未进入；未改场景、依赖、业务脚本或原资产。

## Context：目标与范围

本项目已有 Babylon 原生阴影、混合静态深度缓存、Cycles 离线烘焙与动态探针。用户希望在 Babylon 架构内按优先级形成可执行方案，而不是更换引擎或仅调整单个场景。

推荐继续采用：**原生直接光/阴影 + 离线间接漫反射与环境照明 + 静态 lightmap + 动态探针 + MaterialPluginBase**。主要目标分别为：减少阴影重复绘制、避免 GI 破坏绘制效率、缩短重复烘焙预处理、降低动态探针查询成本。不同目标分开衡量，不把打开/烘焙加速当成稳态 FPS 提升。

### 不可变边界

- 不修改 MQTT 消费、设备驱动、外置脚本、业务节点/实例身份、原模型和场景配置；不以整台设备静态化替代部件分类。
- 不默认改变阴影分辨率、级联数量、距离、过滤、光照强度、探针密度或贴图密度/编码/mip。
- 保持同帧真实失效、资源完整校验、取消/恢复与事务回滚；未知脚本、定制材质和不支持的状态沿原路径。
- 不升级 Babylon，不切 WebGPU，不新增烘焙器，不直接操作用户已打开的 Blender 场景。
- 保留工作区已有 Python 字节码与缓存改动，不清理、不覆盖。
- 不重启此前已停止的大型基准、跨硬件和历史收尾任务；仅处理实际实施项引入的具体风险。

## 1. 当前基础与本次不重复的工作

- 本地 Babylon 为 **9.12.0**。[EnvironmentAndSkyboxController.syncLightingPresentation](src/runtime/babylon/scene-runtime/EnvironmentAndSkyboxController.ts:209) 将当前光照接入 `hybrid`，不继续扩展旧 `mode: baked` 兼容分支。
- [HybridShadowCache](src/runtime/babylon/HybridShadowCache.ts:186) 已将静态和动态深度合并后交给原生过滤，已有数值签名、多灯共享扫描、分组与 context loss/restore。CSM 已开启稳定级联。
- [SceneLightingRuntime.prepareState](src/runtime/babylon/SceneLightingRuntime.ts:580) 当前为每个烘焙表面建立独立代理；[BakedLightingMaterialPlugin](src/runtime/babylon/BakedLightingMaterialPlugin.ts:13) 使用 `lightingBakeUV` 与逐 Mesh 绑定。烘焙不会自动消除实时直接光/阴影成本。
- [cycles_bake.py](electron/lighting-bake/cycles_bake.py:1690) 已有 numpy、二进制几何、世界尺度 UV、RGBM-gamma、有限 mip、探针批处理、完整产物检查点和设备回退。本方案不重新实现它们。
- [动态探针绑定](src/runtime/babylon/SceneLightingRuntime.ts:1000) 已有约 1 cm 移动门槛；[LightingProbeSampler](src/runtime/babylon/lightingProbes.ts:6) 已有空间桶、最多八个可见探针与六方向插值。不通过修改这些规则获取收益。
- 历史通用合批、材质/光照范围裁剪、探针临时分配优化曾出现语义反例或无稳定净收益；新工作不得原样重启或忽略原结论。

## 2. 优先级与推荐实施顺序

| 顺序 | 优先级 | 工作包 | 主要目标 | 改动等级 |
|---|---|---|---|---|
| 1 | P0 | 明确优化边界与最小可归因基线 | 防止重复造轮子和错误晋级 | 小 |
| 2 | P1 | 按灯/投影区域细化阴影缓存失效 | 减少无关静态阴影重绘 | 中高 |
| 3 | P1 | 受控静态环境 GI 代理分块保批 | 减少烘焙后的实际绘制提交 | 高 |
| 4 | P1 | UV/图集布局独立缓存 | 改灯后的重复烘焙免做相同预处理 | 中 |
| 5 | P2 | 探针遮挡候选空间索引 | 减少多动态设备的遮挡查询 | 中 |
| 6 | P2 | 可靠静态实例批次参与阴影缓存 | 避免纯静态 thin-instance 批次一直走动态 | 中高 |
| 7 | P2 | 重复几何的实例化 lightmap | 恢复更大范围的实例化绘制 | 高，涉及资源格式 |
| 8 | P3 | 按需原生画质/多灯扩展与 Shadowmask | 新能力，不是默认同画质优化 | 单独决策 |

**推荐首个交付阶段只包含 P0 与三个 P1 工作包。** 每包独立完成、独立回退；P2 按剩余实际开销选择，P3 不与核心性能工作捆绑。UV 缓存与两个运行时工作包在技术上独立，若实施时优先解决烘焙等待，可提前它，不影响其它设计。

## 3. P0：复用现有基础，不先搭新框架

### 操作

1. 整理本轮实际可复用入口：`HybridShadowMeshState.refreshForFrame`、`HybridShadowNumericSignature`、`SceneShadowRuntime.getHybridMetrics`、`SceneLightingRuntime` 的候选/提交/释放事务、`BakeCheckpoint`、`createLightingBakeTask` 与 `validateAndPromote`。
2. 每个 P1 工作包设置独立的运行期诊断开关；首次实现保留旧路径，不向旧场景写入新默认配置。不要预先建设通用配置框架。
3. 复用 [lightingShadowCosts.ts](src/runtime/babylon/lightingShadowCosts.ts)、[ScenePerformanceMonitor.ts](src/runtime/babylon/ScenePerformanceMonitor.ts) 与 [任务 phaseMetrics](electron/shared/sceneLightingBakeTasks.ts)。仅缺少归因信息时补计数，详细统计仅在诊断开启时收集。
4. 在实际实施对应工作包时，记录一个最小、能触达目标路径的旧路径结果。没有 GI 的场景不能用于证明 GI 保批收益；静止镜头不能证明漫游时 CSM 缓存收益。

### 完成标准

可将新旧路径置于相同输入/相机/分辨率/画质下比较，且关闭候选可恢复原路径。无需新增常驻面板，不以一次全场性能调查作为实施前置。

## 4. P1：按灯/投影区域细化阴影缓存失效

### 当前问题

[renderStaticFace](src/runtime/babylon/HybridShadowCache.ts:343) 的签名包含共享 `state.revision`；单个静态物体变化可能连带使无关灯/面/级联失效。局部化不等于减少必要阴影或缩短距离。

### 实施步骤

1. **保留原检查，输出变更摘要。** `HybridShadowMeshState.refresh` 继续使用现有数值签名和每帧共享扫描；额外记录发生变化的 Mesh、原因、旧/新包围盒和旧/新静态身份。删除、隐藏、角色变化必须保留旧范围。
2. **第一版先按灯细化。** 给每个缓存维护其相关静态投射物依赖版本。多灯独立消费同一变化摘要，不能由第一盏灯读完即清空。基于实际投影和保守包围范围证明不相关时，才不失效；没有证明则仍使用全局版本。不得通过修改 `includedOnlyMeshes`/`excludedMeshes` 或通用 `canAffectMesh` 语义实现加速。
3. **随后先细化点光/聚光，再处理 CSM。** 依赖实际提交的静态 submesh 集合及当前投影；必须旧/新范围均证明不影响才保留缓存。方向光深度钳制、自动范围与级联投射范围未完整证明前，停留在逐灯失效；不得用主相机可见集、灯的 range 或接收者视锥替代投射体积。一个 face 失效后仍完整绘制该面静态深度，不做局部像素修补。
4. **保留完整投影签名。** 相机导致的 CSM 变换、方向光自动投影范围变化、灯位置/方向、bias、normalBias、过滤、clip plane、深度约定及上下文恢复仍使对应缓存失效。不能冻结过期投影。
5. **保守回退与释放。** 定制深度 shader、无法确认的 GPU 变形/几何写入、渲染组语义、未知投影或来源变更使用原全局失效。沿用现有 face 释放和 context 恢复；统计局部失效、全局回退与原因。

### 主要文件与复用点

- [HybridShadowCache.ts](src/runtime/babylon/HybridShadowCache.ts)：`refresh`、`refreshForFrame`、`renderStaticFace`、`invalidate`、释放/恢复。
- [hybridShadowSignatures.ts](src/runtime/babylon/hybridShadowSignatures.ts)：复用现有比较，不另造字符串哈希体系。
- [SceneShadowRuntime.ts](src/runtime/babylon/SceneShadowRuntime.ts)：`registerMesh`、`syncSceneMeshes`、生成器更新与角色输入。
- [lightingShadowCosts.ts](src/runtime/babylon/lightingShadowCosts.ts)：仅补必要诊断字段。

### 完成标准与退出条件

- 投影与静态内容稳定时沿用缓存；仅动态设备运动不重新写入静态旧姿态。
- 改动只关联某灯的静态物体时，其它可证明不受影响的灯不因共享 revision 被迫重绘；删除/移出物体不会留下旧影。
- 相机、灯光及上下文变化仍正确刷新；画面与旧完整路径保持一致。
- 必须同时考虑依赖维护和缓存复制开销，不能只以命中率提高宣布净收益。无法证明局部性时允许仍全失效；该样本不承诺收益。

**第一版不同时解锁静态 thin instance。** 其来源版本与动态变形边界放在 P2，减少同一批次修改的归因风险。

## 5. P1：受控静态 GI 环境代理分块保批

### 首版范围与已核实的交互边界

**首版仅处理 `$environment` 的静态、不可拾取、不透明且无逐对象定制绘制副作用的表面。** 环境导入明确设置 `isPickable = false`（[SceneEnvironmentRuntime.ts:540](src/runtime/babylon/SceneEnvironmentRuntime.ts:540)），分类统一使用 `$environment`（[lightingClassificationRuntime.ts:613](src/runtime/babylon/lightingClassificationRuntime.ts:613)）；运行时若这些条件改变，应退回原代理。

当前 `getSelectionMeshes(entityId, originals)` 按单一逻辑来源映射；即使同属一个实体，跨来源节点合并也可能破坏局部选择过滤。因此业务模型和可交互表面继续原路径。**不改变已有 lightmap UV/资源格式，不要求重新烘焙，不修改拾取/高亮协议。**

### 实施步骤

1. **在创建 GPU 代理前规划兼容组。** 至少要求实际工作材质/图集/解码参数相同，顶点属性布局、直接受光集合、cast/receive、渲染组、层掩码、侧面/深度等状态兼容。透明、定制 shader、逐 Mesh 回调、骨骼/变形及未知来源回原代理。先完成逐 surface/primitive/tile 的完整覆盖校验，再分组，不能合并后丢失覆盖证据。
2. **先保持同变换的几何数值。** 首版优先相同世界变换组，精确拼接原属性与 `lightingBakeUV`。按表面的世界包围盒和顶点/索引/字节上限分块，不能直接用环境节点的平移作为空间位置；禁止全厂单块。不同变换的组暂沿原路径，不为扩大样本立即引入额外数值误差。
3. **保留完整成员映射。** 建立“渲染块 ↔ 全部 surface/source 成员”的运行时结构；保留每个源的 `staticWatch`、隐藏/恢复与精确身份，不能只记一个代表源。源对象仍留在原业务层级，渲染块继续独立于业务层级。灯光过滤或角色分歧时拆组/回退，不能靠 metadata 弥补实际绘制语义差异。
4. **复用材质绑定及原子事务。** 每块使用一个现有插件 binding，登记合法材质租约 targets；沿用 `prepareState / commitState / detachState / releaseState`。不原地改写可被旧 state 复用的资源数组；取消或候选失败只释放新资源，旧画面保留；清除/失效时恢复原源状态。
5. **不接管通用合批器。** 沿用 GI 现有 layerMask/hiddenInstances 及阴影角色接管。`MotionStaticBatchRuntime.sync` 遇到 GI result 会主动清批，不能删除该门禁来冒充兼容。绘制候选过滤只作为未来业务代理保批的参考，本版不必改它，也不先建立跨实体 faceId 拾取系统。

### 主要文件与复用点

- 主要改 [SceneLightingRuntime.ts](src/runtime/babylon/SceneLightingRuntime.ts) 的静态代理规划、成员管理、灯光/阴影策略和资源生命周期；动态记录与业务选择原路径保持。
- 拟新增 GI 专用 helper，例如 `src/runtime/babylon/lightingStaticGiBatch.ts`，负责资格、属性拼接和 bounds 分块。
- [thinInstanceStaticGeometry.ts](src/runtime/babylon/thinInstanceStaticGeometry.ts:59) 的预算/分块思路可复用；它的通用属性白名单不含 `lightingBakeUV`，不能直接套用合并函数。已有 `transformVertexDataPreservingNormals` 可供后续不同变换阶段参考，但不据此扩大首版范围。
- [BakedLightingMaterialPlugin.ts](src/runtime/babylon/BakedLightingMaterialPlugin.ts) 原绑定可直接复用，首版原则上不改 shader。场景文件、snapshot/artifact、二进制几何和拾取协议均不改。

### 完成标准与回退

- GI 开关、失效恢复、灯光过滤、取消均完整；主渲染和阴影不双绘、不漏绘。
- 环境仍不可拾取，业务实体的点击/框选/描边/定位完全沿原路径；既有 source/primitive/tile 覆盖校验不放宽。
- 实际绘制提交下降，新增合并缓冲和维护成本有界；先规划后构建，避免先把所有 surface 上传再额外复制整套几何。
- 同材质、同 atlas、同兼容变换的实际分布决定收益。可安全合并的组太少或无净收益时保持原代理，不扩大为全业务拾取重构来凑合批数量。

## 6. P1：UV 与图集布局独立缓存

### 当前问题

`BakeCheckpoint` 的完整指纹包括照明输入、设备与脚本，适合恢复同任务产物；但 [main](electron/lighting-bake/cycles_bake.py:1712) 在恢复图集前仍执行 `prepare_meshes` 和 `pack_atlases`。改灯后允许 UV 命中，不意味着允许旧光照图命中。

### 实施步骤

1. **分离预处理与光照结果，首版采用整包恢复。** 保持 `partition_receiver`、`repair_lightmap_uvs`、`lightmap_metrics` 和 `pack_atlases` 算法不变。首版保存一个任务级、全有或全无的 UV/布局包：切片几何与属性映射、逐 loop UV、有序图集成员和布局，明确阶段为已排版，防止恢复时二次修正绕序或二次应用 atlas 变换。暂不实现跨模型局部缓存框架。
2. **显式构造独立 key。** 覆盖输入几何/索引/法线及实际属性、面/材质槽映射、来源身份与顺序、完整世界变换、receiver/切片参数、密度、展开/修复/布局算法、atlas 尺寸、padding/mip recipe、格式与 Blender 版本。首版保守包含完整变换，未来再证明可排除平移/旋转。不要拿完整 GI fingerprint 删除若干灯光字段充当新 key，也不要误带含灯光的场景总签名。当前材质仍按当前输入重建，缓存身份映射经核对后绑定本次 `input_index`。
3. **在昂贵预处理前恢复。** 进入 `prepare_meshes` 前尝试读取，保留必要输入几何 I/O。命中后重建必要 Blender 数据块并恢复缓存 UV/布局，跳过重复分片计算、展开、修复和排版；任何恢复失败只清理由此次恢复创建的半成品，再回到原流程。
4. **严格限定同工程和已完成任务。** 第一版只读取由 `tasksRoot / taskDirectory / readRecord` 校验的当前工程任务根直接子目录，最多最近 20 个候选；仅 `completed`、非活动且无存活引擎的任务可复用新缓存。活动、取消、失败、中断任务不作为新预处理缓存来源。固定缓存文件名必须是普通文件，并验证格式、长度/偏移、数量、SHA 与资源预算；拒绝链接、越界和清单任意路径，不读取 `.blend`/pickle/旧任务脚本。将通过校验的数据归入当前任务，不长期借用可能被清理的旧文件。
5. **保持校验、原子写和预算。** 命中仍验证身份、拓扑/loop、UV 可逆性、密度、图集预算和 mip chart。新包放在任务目录顶层：现有 `inspectFiles` 拒绝子目录，清理也拒绝未知文件，因此应精确增加固定清单、载荷与 `.tmp` 文件白名单，不能泛化放行。先提交载荷，最后原子提交清单；取消不发布半成品。大小计入 staging，并设置单包内存和项目磁盘预算，超限只跳过可选缓存，不降低质量、不自动删除历史。具体额度复用既有资源预算后确定，不凭空指定。损坏、缺失、版本不符或被清理均为 cache miss；当前权威输入/preflight 本身无效仍按原流程报错，不能吞掉真实失败。
6. **保留光照完整指纹及交付格式。** 原 `BakeCheckpoint` 对 atlas/probes 的输入、灯光、材质、引擎/设备等校验不弱化；改灯只能命中预处理，光照必须重新求解。新缓存不进入 `Assets/LightingBakes` 正式清单或 SOURCE/DIST。任务内部 CPU/GPU 回退仍遵循现有规则，不因预处理命中复用错误光照。
7. **沿用任务记录。** 在现有阶段耗时/消息中呈现 UV/布局命中与重算原因；不新建缓存管理面板。首次无缓存、恢复/校验耗时和实际 Cycles 求解耗时分开报告。

### 主要文件与复用点

- [cycles_bake.py](electron/lighting-bake/cycles_bake.py)：`make_mesh`、`prepare_meshes`、`pack_atlases`、`lightmap_layout_signature`、`BakeCheckpoint`、`main`。
- [lightingBakeService.ts](electron/ipc/lightingBakeService.ts)：准备/启动、缓存文件暂存与既有 `validateAndPromote`；不绕过正式结果校验。
- [lightingBakeTaskHistory.ts](electron/ipc/lightingBakeTaskHistory.ts)：任务目录归属、文件白名单、大小及清理边界。
- [sceneLightingBakeTasks.ts](electron/shared/sceneLightingBakeTasks.ts)：仅在确需结构化信息时添加向后兼容的可选诊断，不改变场景/烘焙资产格式。

### 完成标准

- 首次完整流程正常；同几何只改灯时，可复用 UV/布局而明确重算 GI。
- 几何、相关缩放/镜像、展开参数或 mip 配方变化时正确 miss；缓存和无缓存产生相同 UV/布局/几何内容。
- 取消、缓存损坏、历史任务清理、CPU/GPU 求解回退均不破坏现有结果。
- 只报告预处理阶段减少的工作和总等待变化，不承诺 Cycles 路径追踪本身因此加速。

## 7. P2：有条件进入的三个工作包

### 7.1 动态探针遮挡候选空间索引

**进入条件：** GI 已正常运行，剩余 CPU 开销确实来自多设备探针的遮挡查询，而非分类或业务脚本。

- 为 `LightingProbeOcclusionQuery` 增加保守的 Mesh 级 AABB 空间索引，先筛掉不可能相交的遮挡物，最后仍用现有 `mesh.intersects` 判定。
- 第一版只优化当前同步更新边界内可证明稳定的来源；使用已经采集的矩阵/几何快照。资格来自受控登记，不能先调用未知 getter 探测。只要存在无法证明无副作用的 getter、脚本或自定义检测回调，首版整次查询沿原线扫，避免混合快路径改变观察顺序；候选按原 source 顺序进入精确检测。不能未经约束把临时缓存改成整场生命周期缓存。
- 保持射线 epsilon、接收者自身排除、原候选顺序、八探针上限、权重、`number[] | null` 返回形式、1 cm 阈值不变。
- 后续只有权威版本覆盖变换/几何/可见性时，才允许跨帧复用；GI 失效/释放与索引同时回收。

主要文件：[lightingProbeOcclusion.ts](src/runtime/babylon/lightingProbeOcclusion.ts)、[SceneLightingRuntime.ts](src/runtime/babylon/SceneLightingRuntime.ts:1000)；[lightingProbes.ts](src/runtime/babylon/lightingProbes.ts) 原插值原则不改。

完成标准：候选包围盒/三角形检查减少，探针选择和系数与原路径一致，跨墙/跨楼板/镜像缩放不漏遮挡；建索引成本无净收益则不启用。

### 7.2 可靠静态实例批次参与阴影缓存

**依赖：** 先完成逐灯缓存失效，不与其第一版同时改分类。

- 在 `HybridShadowMeshState.setMeshes` 的保守分类之外，增加仅面向受控批次的资格分支。
- 必须全部成员静态，且矩阵、数量/重排、可见性、几何和参与遮挡的材质具有完整、可靠的版本来源；任一成员动态或存在骨骼/变形则沿原动态路径。
- 不把 `getLightingRevision` 仅存在或数值暂时不变当作完整承诺；公开 GPU 缓冲写入无法覆盖时继续动态。
- 保持源对象与 batch 身份；分类切换使旧静态缓存正确失效。

主要文件：[HybridShadowCache.ts](src/runtime/babylon/HybridShadowCache.ts)、[lightingNativeInstances.ts](src/runtime/babylon/lightingNativeInstances.ts) 及实际提供权威实例版本的现有批次实现；不对所有 thin instance 一刀切。

完成标准：受控纯静态实例可命中缓存；增删/重排/运动/变形立即走正确新状态；未知实例行为完全沿原路径。

### 7.3 重复几何的实例化 lightmap

**依赖：** P1 的 GI 成员/资源所有权管理与 UV 预处理缓存；业务实例的选择映射仍需在本阶段单独设计，完成格式设计后再实施。

- 按真实几何与展开条件复用 UV 布局，不按模型名称认定几何一致；每个位置的实例仍独立求解光照。
- 图集按实例区域排布，插件增加实例 `lightmapScaleOffset` 属性，同源几何/兼容材质/同图集页形成实例批次。
- 先支持严格可复用的变换组；非均匀缩放不是简单“一律不能共享 UV”，但必须重新证明密度与展开条件，不满足则独立代理。
- 新增有版本的可选实例布局元数据，保留旧逐表面资源读取；同时覆盖捕获、产物校验、资源绑定、SOURCE/DIST 和 Viewer 能力协商，不能只改 shader。
- 原实例索引、拾取、高亮、阴影角色和取消释放必须保持，禁止把不同位置的烘焙照明直接共享。

代表文件：[sceneLightingBakeContract.ts](electron/shared/sceneLightingBakeContract.ts)、[sceneLightingBakeArtifacts.ts](electron/shared/sceneLightingBakeArtifacts.ts)、[cycles_bake.py](electron/lighting-bake/cycles_bake.py)、[SceneLightingRuntime.ts](src/runtime/babylon/SceneLightingRuntime.ts)、[BakedLightingMaterialPlugin.ts](src/runtime/babylon/BakedLightingMaterialPlugin.ts)。发布复制/校验入口只按新格式的必要依赖追踪，不做无关重构。

## 8. P3：新能力单独决策，不作为 P1 的依赖

| 能力 | 推荐切入点 | 限制与进入条件 |
|---|---|---|
| PCSS | 现有 ShadowGenerator/CSM 的显式高画质选项 | 比 PCF 更贵；单独确认附件/缓存复制兼容，旧默认不变。 |
| ShadowDepthWrapper | 有实际顶点变形/溶解裁剪需求的特定材质 | 普通 PBR 不替换；定制深度变化无法可靠追踪时按动态绘制。 |
| ClusteredLightContainer | 大量不投影点光/聚光辅灯 | 按 9.12 `IsLightSupported` 分流，投影灯/不兼容衰减或纹理沿原路径，不强改灯参数。 |
| SSAO2 | 可选接触感增强 | 不替代投影或 GI，防止烘焙遮蔽重复压暗。 |
| Shadowmask | 固定混合灯的静态遮挡离线化 | 单独定义逐灯通道、动静接收组合、失效与发布兼容；动态接收物仍需静态遮挡，不能简单相乘已过滤阴影。 |

IBL Shadows / RSM GI 暂不作为工业运动场景生产主线：前者重体素化昂贵，后者存在间接传播漏光与额外运行时成本。只有明确的静态展示或小场景预览需求才评估。WebGPU 与依赖升级同样单独设计，不把现有私有 WebGL2 深度复制、有限 mip 上传和 GLSL 注入当成自动兼容。

## 9. 最小验证与交付方式

以下保留实施约束；本轮实际执行结果见第 11 节。

### 执行原则

先审查改动与 diff。只有为解决当前改动的具体风险、或预览工具要求时执行最小现有检查；本方案不默认新增/修改测试，不要求全量 CI、全套 smoke、全厂烘焙或完整性能活动。相关现有检查覆盖不到的行为需披露，不把未跑写成通过。

| 实施项 | 需解决的具体风险 | 可复用的最小检查入口 |
|---|---|---|
| 阴影局部失效 | 旧影残留、屏外投射物丢失、投影/恢复错误 | `tests/runtime/hybridShadows.test.ts`、`hybridShadowSignatures.test.ts` 中相关部分；涉及恢复再用 `phase2HybridShadowContextLoss.test.mjs`，像素疑问用现有 hybrid shadow 场景。 |
| 环境 GI 保批 | 双绘/漏绘、环境变得可选、材质/取消恢复 | `tests/lightingBake/sceneLightingRuntime.test.mjs` 中相关事务/灯光/覆盖检查；实际预览核对环境不可选、GI 开关/失效及实际绘制数。不为环境首版扩大到全部阵列回归。 |
| UV 缓存 | 错 key 命中、缓存损坏、取消污染、错误布局 | 既有烘焙恢复/任务资源检查；UV 数据有效性不能由 TS 静态检查证明时，用最小现有隔离 Cycles 输入比较一次冷/暖与改灯/改几何。 |
| 探针索引 | 遮挡结果/插值改变，未知来源副作用 | `tests/runtime/lightingProbeOcclusion.test.ts`、`lightingProbes.test.ts` 的相关部分。 |
| 静态实例缓存 | 缓冲更新/重排后阴影仍冻结 | 现有 native-instance/hybrid 入口；仅实际涉及 GPU 写入或恢复时补相应最小运行路径。 |
| 实例化 lightmap 格式 | 旧文件不兼容、导出后实例身份或资源丢失 | 相关资源合同检查与一个最小 SOURCE/DIST/Viewer 往返；不扩大到所有旧场景。 |

渲染可见改动使用现有运行入口，预览服务由 `preview_*` 管理并复用健康实例；只针对本次风险检查日志、交互和画面，结束后释放任务自有资源。Electron/Cycles 路径使用现有隔离流程，不借用用户 Blender 会话。P1 不改正式资产格式，因此不为它们无条件安排完整发布回归。

### 默认晋级与止损

- 必须保持既有业务与画面合同；指标减少但出现实体错误、阴影遗漏、假缓存命中或资源泄漏时，不晋级。
- 只在实际目标场景中确认净收益后调整程序默认路径；未经确认的候选保持关闭，旧场景设置不变。关闭或止损的候选必须标为“未获得优化收益”，不能当成成功性能交付。
- 以单项可归因结果判断，记录缓存维护/批次检查/索引构建等新增成本；不承诺固定 FPS 百分比。无净收益或适用集合过小则收束该项，不降低保护条件。
- 交付只报告实际修改、实际检查、开关/回退和剩余限制；文档更新沿用项目现有光照/烘焙说明，不另建重复验证文档。

## 10. 唯一执行清单

P0/P1 已按本次“执行方案”授权实施，P2/P3 仍按进入条件保留，未自动扩展。

- [x] P0：复用边界、原路径开关与最小可归因基线。
- [x] P1：逐灯/面阴影局部失效，点光/聚光可启用；方向光/级联保持全局回退。
- [x] P1：受控静态环境 GI 分块保批，不改业务选择协议，保持资源事务。
- [x] P1：UV/布局独立缓存，光照完整指纹不变。
- [ ] P2（条件满足后）：探针遮挡空间索引。
- [ ] P2（条件满足后）：可靠静态实例阴影缓存。
- [ ] P2（独立格式设计后）：重复几何实例化 lightmap。

**第一阶段完成定义：**三个 P1 工作包的授权改动、必要兼容处理、原路径回退与实际检查结果已交付；不以完成全部 P2/P3、历史大型基准或跨硬件研究作为第一阶段完成的前提。

## 11. 第一阶段实施记录（2026-10-28）

### 已交付实现

- 阴影新增 `hybridShadowInvalidation.ts`：512 条共享环形变化记录，保存旧/新范围，各 face 独立游标；光源/投影或不可靠输入仍按原路径失效。`SceneShadowRuntime.setCacheInvalidationMode` 可切换，默认 `global`。
- GI 新增 `lightingStaticGiBatch.ts`：只拼接相邻、同变换且同光照状态的原生 Mesh 环境表面，保留现有 bake UV、原三角顺序、成员映射和事务。源仍逐一监视；绘制候选收集前再次检查资格，失配时恢复独立代理。`GroundMesh` 等非原生 Mesh 子类及业务对象不进入候选。
- `lightingOptimizationSettings.ts` 和 `SceneRuntime` 统一提供运行期开关/诊断。URL 和本机显式键均可启用，默认旧路径；无场景格式或画质默认值变更。
- UV 新增 `lightingBakePreprocessCache.ts`、`preprocess_cache.py`，在昂贵预处理前恢复任务级 packed 包。TS 先完成目录/预算/凭据校验，Python 再核对实际输入/算法/Blender、loop/绕序、密度和原 mip 预算；坏包回原路径。使用 `LIGHTING_BAKE_PREPROCESS_CACHE=1`，默认关闭。
- README 与混合光照指南已补启用、回退和限制；未增加产品 UI、修改测试、执行提交或推送。入场 pyc/缓存改动保留。

### 实际结果与限制

- **GI WebGL2 定向夹具（RTX 2070 SUPER）：**16 个符合资格的环境表面，从 16 个代理/16 次绘制变为 1 个代理/1 次绘制；800×512 读回全部 RGBA 差异为 0。改变一个表面的拾取资格后恢复 16 个代理；改变灯光 include 过滤后同样回退，等待原生材质 ready 后与关闭合批的路径 RGBA 差异为 0。PBR 原生配置插件资格也已读回确认。
- **阴影 WebGL2 定向夹具：**双聚光灯中只移动左侧投射物，左灯静态绘制累计 1→2，右灯仍为 1；移动和删除后的图像与 `global` 策略 RGBA 差异为 0。点光六面案例中，移动后每灯仅新增 1 面静态绘制、5 面保留，移动/删除的 RGBA 差异同样为 0。
- **独立 factory Blender 小夹具：**镜像/非均匀变换后 6 个切片暖缓存命中，导出几何与 UV SHA 和冷路径一致；只改灯使 GI 指纹变化且重新求解；改几何 miss，取消任务不进入候选。任务历史现有 Node 检查 6 项通过。最后的额度互斥/入口闸门和引用释放做了差异审阅，未重复整套 Blender 流程。
- **既有运行时检查：**阴影选择集 12/12 通过（几何回调调整后的相关 2 项也通过）；GI 运行时 69/70 通过。唯一失败为 `post-activation validation failure rolls back original live resources without reading them again` 的动态颜色回滚断言；同依赖环境只读加载 HEAD 的 `SceneLightingRuntime.ts`，同一断言也失败，未借本任务修复。日志：`output/lighting-optimization-p1/runtime-node.log` 与 `runtime-baseline-failure.log`。
- **实际编辑器入口：**两个 URL 开关均被真实 `SceneRuntime` 读为启用，创建立方体后 Scene ready、当前光照错误为空。Browser 面板因会话不在可见窗口中暂停自动帧，检查时手动驱动了该任务预览实例的渲染帧；这不是 FPS 样本。
- 预览夹具首次使用了未注册的旧 VertexData builder 入口，已改为复用现有 MeshBuilder；首次灯光过滤像素差来自未等新 shader ready 的采样，后续按真实 ready 边界重查为 0。没有修改产品光照公式规避差异。
- 未运行全量构建、全量 CI、全厂烘焙、正式业务 FPS 或跨硬件对照，未验证真实 GPU 烘焙回退；P2/P3 未实施。以上局部结果不代表整厂净收益，因此三项候选均未默认晋级。

启用与回退说明见[混合光照指南](../hybrid-lighting.md#第一阶段优化候选默认关闭)。本轮诊断预览文件保存在 `output/lighting-optimization-p1/`，不进入产品或发布资产。
