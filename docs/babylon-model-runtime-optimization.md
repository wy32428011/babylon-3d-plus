# Babylon 模型只读几何与稀疏矩阵更新

适用版本：Babylon.js 9.12.0 / WebGL2。现有无声明模型保持原有实例化/独占策略，不能用此功能跳过参数脚本或首帧门控。

## 只读 Geometry 新修订

带脚本模型原来会克隆独立 Geometry、材质、纹理包装与动画对象。新增路径允许经过明确声明的模型仅共享不可变 Geometry；节点、metadata、脚本实例、材质、纹理包装及动画目标仍独立。缓存模板由 lease 持有，直到最后一个共享副本释放；工作容器不拥有共享 Geometry 的销毁权。

### 准入条件

- `runtimeCapabilities.version` 为 `1`，Geometry 为 `shared-readonly`，存在有效资源修订。
- 声明同时存在于模型包 `meta.json.runtimeCapabilities` 和实际加载 glTF 的 `asset.extras.runtimeCapabilities`；两者必须相同。仅编辑 scene 字段不能开启共享。
- `configurationSha256` 与规范化后的模型单位、参数 schema、参数/动画脚本元数据和设备/货格配置一致。实例位置、`assetCode`、参数值和重定位路径不进入此签名；声明必须对所有允许的实例值成立。
- `scripts` 包含完整且唯一的脚本文件名与严格 UTF-8 文本 SHA-256（BOM 不参与）。运行时在执行脚本 factory 前校验，变更会明确报错并要求重导，不允许先污染共享 Geometry 再回退。
- 原生实例、内嵌 thinInstance、骨骼及 MorphTarget 等首版不准入，继续完整克隆。组合强制独占入口仍有更高优先级。

示例结构（摘要须由真实内容计算，不能复制占位值）：

```json
{
  "version": 1,
  "geometry": "shared-readonly",
  "materials": "owned",
  "configurationSha256": "真实配置的SHA-256",
  "scripts": { "readonly.model.ts": "真实脚本文本的SHA-256" }
}
```

`geometry: "owned"` 明确要求 Geometry 独占。带外置脚本或动画的模型材质仍保持独立，以保护参数修改、GI、报警和入场状态；无脚本、无动画的显式只读材质可按下述限定子集共享。未知版本/无源声明/配置不符均不启用新快路。

只读承诺涵盖全部生命周期、参数组合与运行动作，不能调用 `setVerticesData`、`updateVerticesData`、索引/UV/顶点颜色写入、几何烘入变换或在共享 Geometry 上安装实例顶点属性，也不能直接修改取得的数组/缓冲。作者声明不是安全沙箱，静态扫描与摘要匹配也不等于行为证明。

### 生成候选包

先核对模型实际行为，再从已保存的场景实体生成**全新目录**。工具不改原包，保留 GLB 原 BIN 块及其他几何语义，绑定选定场景中的规范化配置；拒绝 Junction/符号链接及包外脚本。重新导入候选包后必须检查实际准入和行为。

```bash
npm run declare:model-readonly -- --scene "场景文件.scene.json" --entity "实体ID" --output "全新候选包目录" --acknowledge-readonly-geometry
```

此开关是作者对模型的明确声明，不是自动认证。现有会修改顶点的 LED、电机等模型不能直接加标记。参数脚本、节点名称、几何和业务逻辑未因此被改写。

导入、资源更新、生成器、保存重开与导出保留声明；资源换版删除声明时不会残留旧优化配置。在其本来支持的场景格式内，旧客户端忽略该优化字段；本功能不提升场景文件版本。新资源修订仍可能使既有烘焙失效，必须走正常重烘焙，不能改签名或跳过发布门禁。诊断 `runtime.loading.modelCache` 新增 `sharedGeometryCloneCount` 和 `capabilityFallbackCount`，前者不表示端到端速度提升。

### 修订更新与同构建对照

固定 SOURCE 包的 `sourceSnapshot.contentSha256` 优先于普通 `assetRevision`，同时用于模板身份、模型重载及 GLB/脚本请求版本。普通模型与参数变体在声明或脚本集合变更时先重建资源再准入；生成器目标签名也保留固定快照、声明和相关配置。模板在所有加载入口都记录实际 glTF 声明，因此独占消费者先加载不会导致后续共享消费者丢失准入信息。

同构建对照使用 `SceneRuntime.setReadonlyGeometrySharingEnabled(false)` 强制后续候选 Geometry 独占；传 `true` 恢复现有的几何声明准入策略，仍须通过源、配置和结构验证。应在打开场景前设置，并在独立 Scene 中比较。该开关不写场景文件、不控制下述材质共享、不追溯改变已有实例的所有权；已有共享 lease 仍在实例释放时归还。诊断字段 `runtime.loading.modelCache.readonlyGeometrySharingEnabled` 表示当前开关，累计命中计数不随切换清零。

## 无脚本模型的只读材质共享

运行时消费经过同一源/配置验证的 `materials: "shared-readonly"`，但仅接纳空脚本集合、没有脚本元数据及任何节点/材质/纹理动画的模型。框架声明式 `bindings` 和全部 `rules.set` 中的材质目标从创建时就保持独占，不等待规则首次触发后再拆分；可写 MultiMaterial 子树独占，包含可写子材质的父容器也克隆。

其余实际被模型引用、由源容器持有的 Standard/PBR/MultiMaterial 才共享。节点和 metadata 仍独立，Geometry 继续服从自己的声明；共享材质及纹理包装不进入工作容器的释放清单，源 lease 保护最后一个消费者，源材质登记随模板生命周期维护。旧包及任何未知/脚本路径仍沿用原策略，不自动给资源加声明。

例如，仅用声明式参数调整节点位置/缩放、`geometry: "owned"`、`materials: "shared-readonly"` 且摘要一致的无动画模型，过去会完整克隆，现可保持节点/Geometry 独立而共用只读材质；两个材质中只被参数写入的一个仍独占。这不等于任意脚本模型通用材质共享，也不引入跨 GI/入场恢复链的晚期 COW。`runtime.loading.modelCache.sharedMaterialCloneCount` 只累计实际共享的工作容器，不代表 Draw Call 或 FPS 收益。上面的候选包命令仍以只读几何声明为准，不能把它当作材质行为的自动认证。

## thinInstance 稀疏上传实验

项目既有空间分片与视锥裁剪不变。新路径在实例布局、可见顺序和缓冲不变时，在矩阵复制中记录变化行并合并相邻区间，使用 Babylon 数字重载 `thinInstancePartialBufferUpdate`（offset/count 为实例单位）。

- 实例数量、方向、分片、可见布局或缓冲改变仍完整提交。
- CPU 完整源矩阵、可见矩阵、实体索引、选择、边界和光照 revision 保持一致。
- 处理 SDK 世界矩阵缓存，并在 context restore 后从权威 CPU 数据重新上传；监听随 Mesh 销毁释放。
- 当前实验阈值：至少 64 行、最多 8 段、变化不超过总行数的 1/4；大量变化退回全量。
- 默认关闭。内部 A/B 入口为 `SceneRuntime.setSparseMatrixUploadsEnabled(boolean)`，只影响当前 Scene，不写场景文件或用户配置。净收益未验收前不默认启用。

`runtime.loading.matrixUploads` 提供开关状态、全量/局部/跳过次数、受管矩阵上传字节和恢复次数。这些是本模块的累计计数，不是全部 GPU 流量或真实显存；应按采样前后取差值。

### 已知变换增量

正式阵列另有不依赖上述实验开关的增量路径：保持完整可见布局、无需空间重分片且实体顺序与方向分组不变时，保存数值 Transform 快照，仅重算变化实体的矩阵行，并按已知脏区间上传。源相对矩阵、Geometry、缓冲所有权和索引布局仍逐项核对；裁剪/重排、资源变化或大量变换变化时回退原全量事务。该路径复用既有上下文恢复机制，不修改场景配置，也不删除实例或降低几何精度。

阵列单体拖拽优先沿受控局部同步更新目标及关联批次；预览令牌、权威文档、取消和提交继续隔离，未知外部修改仍走完整同步。此优化减少矩阵构造及上传，不等于整个处理过程达到 O(变化实体数)，也不构成实机场景 FPS 提升保证。`matrixUploads.enabled` 仍仅表示稀疏比较实验开关，因此关闭时也可能记录到已知变换增量产生的局部上传。


## 模型脚本的原生材质初始化入口

启动采样发现模型脚本内部反复 `PBRMaterial.clone()` 时，新材质的属性赋值会多次扫描全场 SubMesh。项目运行时现提供显式扩展，复用已有的同步新材质 dirty 保护；它不是 Babylon 官方导出，也不需要安装额外 npm 包：

```typescript
import { cloneDetachedModelMaterial } from "zending-3d-runtime";

const copy = typeof cloneDetachedModelMaterial === "function"
  ? cloneDetachedModelMaterial(material, material.clone, cloneName)
  : material.clone(cloneName);
```

- 第二个参数先取得原 `clone` 方法，随后才求值名称表达式，保留成员调用的访问器顺序和 receiver。
- 只有未定制的原生 PBR/Standard、原生插件/普通 Texture、未改写的 SDK 以及无新建材质/纹理监听的场景允许保护；不合格时调用已取得的原方法。
- 只包围一次同步克隆，不冻结现有材质、不共享材质、不关闭整个 `onStart` 的 dirty 传播，也不改变材质/几何算法。
- 原有模型脚本不自动改写。新修订须保留上述旧宿主回退；固定 SOURCE 模型必须按实际新完整包重新计算内容 pin，不能删除或伪造 pin。
- `SceneRuntime.getDetachedMaterialCloneMetrics()` 返回已知原生调用的优化/回退计数；自定义 clone 直接原路执行，不为统计额外读取未知对象。

当前电机候选仅替换三处克隆调用，保留原件；可采用范围与收益以执行记录的真实对照为准，不自动替换生产工程。

## 初始准备期分类候选

`SceneRuntime.setPreparationClassificationEnabled(true)` 是内部 A/B 开关，**默认关闭**，不写场景文件。编辑器还必须提供真实加载蒙版门，且存在资产解码/脚本初始化工作；运行预览不进入此路径。已有 GI、异步激活、结构待办、分类预览及阴影代理均保留原流程。首次实际渲染就绪检查之前同步补齐分类与阴影绑定，同一会话随后恢复原更新时序；新场景会话重新建立门。

续作同构建六轮A/B/C/C/B/A静态对照中，原版中位72.50秒、材质候选60.45秒、组合候选51.68秒，完整RGBA一致。组合相对原版下降28.71%，尚未完成真实中台五冷五暖与持续动作验收，因此不默认启用；输入范围与明细见执行清单。

## 当前结果与边界

中台静态打开脚本 `scripts/smoke-real-project-loading.mjs` 使用 `captureSceneOpenLogicalImages` 的 `runtimeBinding: 'scene-canvas'`：从唯一场景视口的React owner定位活动运行时，核验其engine绘制canvas身份，再检查实际图片注入与文件字节。绑定缺失或不唯一直接失败，不回退扫描图库，也不关闭Proxy/getter保护。

图片审计在正式打开计时结束后执行。`logical-images/progress.json` 记录阶段、进度、请求数与耗时；`receipt.json` 保存最终结果和清理错误。单请求20秒、审计180秒、每项清理5秒上限。`PASS_ACTUAL_INPUT_IMAGE_BYTES_ONLY` 仅证明输入映射与字节一致，不等于GPU纹理像素正确；完整静态打开状态与性能配对状态仍分别判断。

本轮实现、实机检查和未完成工作统一记录在 [执行清单](tasks/2026-10-26-babylon-load-render.md)。不要将少量矩阵上传、单次克隆计时或 NullEngine 检查当成工厂 FPS / 完整打开收益。
