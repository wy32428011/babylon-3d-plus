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

`geometry: "owned"` 明确要求独占。当前实现**不共享材质**；即使声明材质只读，仍保留隔离以保护 GI、报警和入场插件。未知版本/无源声明/配置不符均不启用新快路。

只读承诺涵盖全部生命周期、参数组合与运行动作，不能调用 `setVerticesData`、`updateVerticesData`、索引/UV/顶点颜色写入、几何烘入变换或在共享 Geometry 上安装实例顶点属性，也不能直接修改取得的数组/缓冲。作者声明不是安全沙箱，静态扫描与摘要匹配也不等于行为证明。

### 生成候选包

先核对模型实际行为，再从已保存的场景实体生成**全新目录**。工具不改原包，保留 GLB 原 BIN 块及其他几何语义，绑定选定场景中的规范化配置；拒绝 Junction/符号链接及包外脚本。重新导入候选包后必须检查实际准入和行为。

```bash
npm run declare:model-readonly -- --scene "场景文件.scene.json" --entity "实体ID" --output "全新候选包目录" --acknowledge-readonly-geometry
```

此开关是作者对模型的明确声明，不是自动认证。现有会修改顶点的 LED、电机等模型不能直接加标记。参数脚本、节点名称、几何和业务逻辑未因此被改写。

导入、资源更新、生成器、保存重开与导出保留声明；资源换版删除声明时不会残留旧优化配置。在其本来支持的场景格式内，旧客户端忽略该优化字段；本功能不提升场景文件版本。新资源修订仍可能使既有烘焙失效，必须走正常重烘焙，不能改签名或跳过发布门禁。诊断 `runtime.loading.modelCache` 新增 `sharedGeometryCloneCount` 和 `capabilityFallbackCount`，前者不表示端到端速度提升。

## thinInstance 稀疏上传实验

项目既有空间分片与视锥裁剪不变。新路径在实例布局、可见顺序和缓冲不变时，在矩阵复制中记录变化行并合并相邻区间，使用 Babylon 数字重载 `thinInstancePartialBufferUpdate`（offset/count 为实例单位）。

- 实例数量、方向、分片、可见布局或缓冲改变仍完整提交。
- CPU 完整源矩阵、可见矩阵、实体索引、选择、边界和光照 revision 保持一致。
- 处理 SDK 世界矩阵缓存，并在 context restore 后从权威 CPU 数据重新上传；监听随 Mesh 销毁释放。
- 当前实验阈值：至少 64 行、最多 8 段、变化不超过总行数的 1/4；大量变化退回全量。
- 默认关闭。内部 A/B 入口为 `SceneRuntime.setSparseMatrixUploadsEnabled(boolean)`，只影响当前 Scene，不写场景文件或用户配置。净收益未验收前不默认启用。

`runtime.loading.matrixUploads` 提供开关状态、全量/局部/跳过次数、受管矩阵上传字节和恢复次数。这些是本模块的累计计数，不是全部 GPU 流量或真实显存；应按采样前后取差值。

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

组合候选单次本地打开约50.48秒，完整RGBA与对照一致，但尚未完成配对与冷暖多次验收，因此不默认启用。

## 当前结果与边界

本轮实现、实机检查和未完成工作统一记录在 [执行清单](tasks/2026-10-26-babylon-load-render.md)。不要将少量矩阵上传、单次克隆计时或 NullEngine 检查当成工厂 FPS / 完整打开收益。
