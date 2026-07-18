# 大场景模型容量与渲染稳定性设计

日期：2026-07-17

## 背景

当场景内模型数量快速增长时，当前编辑器会出现明显卡顿，极端情况下 Scene View 可能全黑。代码基线表明：除 Shelf 外，同源模型仍按实体重复加载完整 `AssetContainer`；批量模型加载没有并发峰值控制；Scene View 没有把 WebGL 上下文丢失和运行期渲染异常转换为可见、可恢复状态；场景文档每次变化都会触发全量实体同步。

## 目标

- 不降低抗锯齿、纹理、材质、光照、后处理和几何精度。
- 提高同源重复模型可同时驻留的数量，降低 CPU、GPU 与显存重复开销。
- 限制批量导入时的瞬时解析和上传峰值，避免 WebGL 上下文因资源突发压力丢失。
- 保持每个实体独立的 Transform、显隐、锁定、拾取、Hierarchy 选择和 Gizmo 语义。
- 保持现有米制单位、场景 JSON、参数脚本、遥测和模型生成器语义兼容。
- Scene View 运行期异常必须可见；WebGL 自动恢复成功后应恢复正常显示。

## 非目标

- 不降低渲染分辨率或硬件缩放比例。
- 不引入 LOD、纹理压缩、贴图降采样或几何简化。
- 不关闭地面 Glow、模型高亮、实例描边或 POI 特效。
- 不切换 WebGPU，也不新增第三方依赖。
- 本轮不对会修改共享几何或共享材质的外置脚本模型强制实例化。

## 已证实约束

- `meta.json.lengthUnit` 仍是模型源单位唯一来源；单位换算只应用到 `contentRoot`，不得污染实体 `Transform.scale`。
- Stacker `appearanceColor` 等脚本依赖实例级材质隔离，不能被普通共享材质策略破坏。
- Shelf 已有经过验证的共享实例、参数脚本、选择描边和生命周期链路，必须保持兼容。
- Babylon.js 锁定版本为 `9.12.0`；`AssetContainer.instantiateModelsToScene` 会克隆节点、骨骼和动画组，并可共享源几何与材质。

## 方案

### 1. 安全共享实例策略

新增统一的模型实例化策略判定：

- `shelf-scripted`：沿用现有 Shelf 特判，即使存在 Shelf 参数脚本也允许共享源几何和材质。
- `static-shared`：模型不存在外置脚本、参数配置、参数脚本元数据和动画脚本元数据时，使用共享源 `AssetContainer` 创建实体实例。
- `owned-container`：其余模型继续独占容器，优先保证实例级几何、材质和脚本隔离。

同一 `sourceUrl + assetRevision + 策略` 只加载一份共享源容器。每个实体仍拥有独立 `root`、`contentRoot`、实例节点、动画组、metadata 和释放句柄。

### 2. 模型加载并发控制

增加无依赖的 `AssetLoadScheduler`，默认最多同时执行 4 个模型/环境 `LoadAssetContainerAsync`。同源共享请求仍由 `SharedModelAssetCache` 合并为一个真实加载任务。调度器销毁后拒绝未开始任务；已开始任务完成后由既有 load token 和资源句柄负责回收过期结果。

### 3. 场景增量同步

`SceneRuntime.sync` 继续完整计算实体有效显隐/锁定状态和删除集合，但只对以下实体执行完整 `syncEntity`：

- 新增实体；
- 实体对象引用发生变化；
- 运行时中尚未建立对应对象。

仅选择、父级显隐或锁定变化的未修改实体走展示层刷新，不重复执行模型参数、外置脚本、子 Mesh 收集和遥测基线重建。删除和场景切换仍使用完整回收路径。

### 4. WebGL 与渲染循环稳定性

- 保留抗锯齿与 stencil，关闭没有项目功能依赖的 `preserveDrawingBuffer`。
- 监听 Babylon Engine 的 context lost/restored observable。
- `scene.render()` 增加异常隔离；首次异常上报，后续成功帧上报恢复，避免每帧刷屏。
- Scene View 在上下文丢失或连续渲染异常期间显示可读遮罩；自动恢复后清除遮罩并记录 Console 日志。

### 5. 可观测性与文档

README 和独立文档说明：共享准入边界、并发预算、全黑恢复行为、不会降低的画质项、验证命令和剩余风险。

## 兼容性

- 不修改 `SceneDocument` 版本和场景 JSON 字段。
- 不修改模型包 `meta.json` 格式。
- 不修改编辑器实体 Transform、单位、参数值或资产编号语义。
- 非安全候选继续走原独占容器路径。
- 环境模型只接入并发调度，不参与普通模型共享实例。

## 验收标准

- 两个及以上同源静态模型只触发一次源容器加载，实体 Mesh 使用实例化路径且 Transform、选择、锁定、显隐相互隔离。
- 删除一个静态共享实例不释放共享源；删除最后一个实例时共享源只释放一次。
- Shelf 既有共享实例与高密度 thin instance 行为不回退。
- 任何时刻同时进行的资产加载任务不超过 4 个。
- 仅改变选择时，不再对全部模型重复运行参数/脚本/子 Mesh 收集链路。
- WebGL context lost 与 render error 会在 Scene View 显示明确提示；恢复后提示自动清除。
- `npm run typecheck`、`npm run build`、定向容量 smoke 和现有 Shelf 共享 smoke 通过。

## 风险与回退

- 若静态候选后续加入可变材质或几何脚本，模型资产签名会因脚本/参数元数据变化切回独占容器。
- 若实例化模型包含 Babylon 无法实例化的特殊节点，`instantiateModelsToScene` 会按引擎规则克隆对应节点；验收以实体隔离和资源回收为准。
- 增量同步若检测到未知运行时缺失，必须回退完整 `syncEntity`，不得留下半同步状态。
