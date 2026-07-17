# Stacker 模型外观颜色参数化设计

## 背景

`F:\3d-models\models\Stacker\stacker.model.ts` 已负责堆垛机尺寸、货叉、载货台和运行初始位置的参数化，但当前没有模型外观颜色参数。当前 `Stacker.glb` 包含 13 个有效 Mesh，运行时均加载为带纹理的 `PBRMaterial`，基础 `albedoColor` 为白色；因此使用白色作为默认乘色可以保持现有贴图外观不变。

编辑器已经原生支持 `meta.json.modelParameters` 的 `color` 类型、`#RRGGBB` 校验、颜色选择器、实时参数注入、场景保存/加载和撤销/重做。本次不修改编辑器核心颜色控件，只完善 Stacker 模型包脚本与元数据。

## 目标

- 新增 `appearanceColor` 参数，Inspector 标签为“模型外观颜色”。
- 默认值为 `#ffffff`，保持旧场景和未配置模型的视觉结果不变。
- 参数修改后实时对 Stacker 全部可见模型 Mesh 应用颜色乘色，同时保留原贴图、透明裁剪和法线贴图。
- 多个 Stacker 实例可以使用不同颜色，不允许共享材质被串改。
- 参数反复修改时复用当前实例的克隆材质，不重复创建无上限材质对象。
- 脚本停止或实例销毁时恢复原材质并释放克隆材质。
- 同步源模型包、当前项目 `Assets/Models/Stacker` 副本、Playwright 可视夹具和演示场景元数据。

## 非目标

- 不增加分部件颜色、渐变、透明度、贴图替换或主题系统。
- 不修改 `Stacker.glb`、原始纹理或现有几何参数语义。
- 不重构编辑器全局材质系统。
- 不支持 CSS 颜色名、RGB/HSL 或 `#RGB`；颜色格式与编辑器现有 `#RRGGBB` 契约保持一致。
- 不为当前无 `MultiMaterial` 的 Stacker 资产引入通用多材质树框架。

## 方案比较

### 方案 A：直接修改导入材质

改动最少，但如果 Babylon 资产实例共享材质，会造成多个 Stacker 实例串色；停止脚本时还需要逐字段恢复材质状态。该方案不采用。

### 方案 B：每个运行实例克隆并复用材质

按原材质引用建立克隆映射，全部 Mesh 复用对应克隆；颜色变化只更新克隆的 `albedoColor`，停止时恢复原材质并释放克隆。该方案隔离实例、保留纹理且生命周期清晰，作为本次推荐方案。

### 方案 C：统一替换为新建纯色 StandardMaterial

实现直观，但会丢失 Stacker 原有贴图、法线和透明裁剪信息，视觉退化明显。该方案不采用。

## 参数契约

- 字段键：`appearanceColor`
- Inspector 标签：`模型外观颜色`
- 参数脚本字段类型：`string`
- 模型参数类型：`color`
- 默认值：`#ffffff`
- 合法格式：`^#[0-9a-fA-F]{6}$`
- 非法值：回退 `#ffffff`，不得中断模型脚本生命周期。
- 旧数据：缺少字段时由脚本 `DEFAULT_VALUES` 和元数据默认值补齐。

## 运行时设计

### 1. 基线快照

`NodeSnapshot` 在现有位置、缩放、旋转、启用状态和顶点快照之外，保存 Mesh 的原始 `material` 引用。每次参数重算前，`restoreBaseNodes()` 恢复原材质，保证几何克隆始终从原始材质基线创建。

### 2. 材质克隆映射

`ParametricModelRuntimeComponent` 持有 `Map<原材质, 克隆材质>`：

- 首次遇到原材质时调用 `clone()` 创建当前实例专属材质。
- 后续参数变化继续复用同一克隆，不重复创建材质。
- 同一原材质被多个 Mesh 使用时，这些 Mesh 复用同一克隆。
- 无材质或不支持 `clone()` 的节点保持原状，不阻断其它 Mesh 参数化。

### 3. 颜色应用顺序

`applyAppearanceColor(values)` 放在尺寸、货叉、载货台、阵列和初始停靠等全部几何处理之后执行。这样运行时新生成的 Mesh 也会被纳入当前模型子树并获得相同颜色。

Stacker 当前材质均为 `PBRMaterial`，主要写入 `albedoColor`；为兼容未来替换为 `StandardMaterial` 的模型包，若材质暴露 `diffuseColor` 也同步写入。颜色仅作为材质乘色，不替换纹理。

### 4. 停止与释放

停止顺序固定为：

1. 释放参数脚本生成节点。
2. 恢复原节点的变换、顶点、启用状态和原材质。
3. 释放当前实例创建的克隆材质。
4. 清空材质映射和参数签名。

材质释放不强制释放共享纹理，避免克隆材质销毁时误伤原模型贴图。

## 元数据与持久化

`meta.json` 同步更新：

- `parameterScripts[].fields` 增加 `appearanceColor` 字段。
- `parameterScripts[].values` 增加颜色默认值包装。
- `modelParameters.parameters` 增加 `type = "color"` 定义。
- 参数说明文案补充模型外观颜色能力。

编辑器现有场景文档会把颜色写入 `modelAsset.parameterValues`，并同步到运行节点 `metadata.scripts[].values` 和脚本实例属性；无需新增场景字段。

## 文件同步

以下文件必须在完成后逐字节一致：

- `F:\3d-models\models\Stacker\stacker.model.ts`
- `F:\3d-models\models\Assets\Models\Stacker\stacker.model.ts`
- `F:\3d-models\models\Stacker\meta.json`
- `F:\3d-models\models\Assets\Models\Stacker\meta.json`
- `F:\3d-babylon-editor\output\playwright\stacker-assets\stacker.model.ts`
- `F:\3d-babylon-editor\output\playwright\stacker-assets\stacker.model.txt`
- `F:\3d-babylon-editor\output\playwright\stacker-assets\meta.json`

演示场景 `examples/scenes/stacker-mqtt-demo.scene.json` 通过现有生成脚本重新读取源包元数据，避免手工维护缓存字段。

## 文档

更新根 `README.md` 的 Stacker 参数化说明，记录：

- 参数名称、默认值与支持格式。
- 白色默认值保持原贴图外观。
- 颜色变化只修改实例专属克隆材质，不影响其它 Stacker。
- 源包、副本、可视夹具和资产索引同步要求。

## 验证

按最小工程验证执行：

- 先扩展 `scripts/smoke-model-parameter-meters.mjs`，让缺少颜色参数的旧实现明确失败。
- 过滤运行 Stacker 烟雾场景，验证元数据类型、默认白色、自定义颜色、非法颜色回退、重复更新材质复用、停止后原材质恢复与克隆释放。
- 在同一 Scene 中创建两个共享同一组原材质的 Stacker 实例，验证不同颜色、单侧二次换色和停止其中一个实例都不会影响另一个实例。
- 转译外置脚本并加载真实 `Stacker.glb`。
- 校验源包、副本和可视夹具 SHA-256 一致。
- 重新生成 Stacker 演示场景并刷新资产索引 `assetRevision`。
- 运行 `npm run typecheck`、`npm run build` 和 `git diff --check`。
