# 导入模型参数化配置设计规格

## 背景

用户希望导入模型后，编辑器可以读取模型包中的参数化配置；当选中该模型实体时，Inspector 展示可配置参数；用户修改参数后，Scene View 中的模型外观能根据参数实时变化。

当前工作区已经具备一条参数化模型链路：Electron 扫描 `meta.json.modelParameters`，renderer 归一化配置，导入模型实体保存 `parameterConfig` 与 `parameterValues`，Inspector 展示“模型参数”，SceneRuntime 根据参数绑定实时更新 Babylon 节点、网格和材质。本文将该能力固化为当前 MVP 的规格，避免后续使用和扩展产生歧义。

## 目标

- 沿用 `meta.json.modelParameters` 作为模型包参数化配置入口。
- 选中带参数配置的导入模型后，在 Inspector 展示“模型参数”区域。
- 修改参数后，通过场景文档驱动 Babylon 运行时实时改变模型外观。
- 参数值支持撤销/重做，并随场景保存/加载保留。
- 配置解析、表达式执行和贴图路径均采用白名单策略，不执行任意脚本。

## 非目标

- 不执行 `.model.ts` 或 `meta.json` 中的脚本逻辑。
- 不支持远程 URL、绝对路径、`data:` 或 `../` 贴图路径。
- 不做贴图文件选择器、参数搜索、复杂分组/折叠 UI。
- 不绑定动画、骨骼、粒子系统或任意 Babylon 属性。
- 不引入新的外部表单或 schema 依赖。

## 配置格式

模型包的 `meta.json` 可以包含：

```json
{
  "displayName": "参数化设备",
  "lengthUnit": "meter",
  "modelParameters": {
    "schema": "babylon-editor.model-parameters",
    "version": 1,
    "parameters": [],
    "bindings": [],
    "rules": []
  }
}
```

只接受：

- `schema === "babylon-editor.model-parameters"`
- `version === 1`
- `parameters` 为数组
- `bindings` 为数组
- `rules` 可选，存在时为数组

数量限制：

- `parameters.length <= 64`
- `bindings.length <= 256`
- `rules.length <= 128`

不合法配置不会阻止模型导入；该模型将按普通导入模型处理。

## 参数类型

### number

用于尺寸、透明度、强度、偏移等数值。

```json
{
  "key": "height",
  "label": "高度",
  "type": "number",
  "defaultValue": 2,
  "min": 0.5,
  "max": 10,
  "step": 0.1,
  "unit": "m"
}
```

Inspector 使用 number input；输入时实时预览，blur 或 Enter 后提交撤销历史。

### color

用于基础色或自发光色。

```json
{
  "key": "bodyColor",
  "label": "主体颜色",
  "type": "color",
  "defaultValue": "#2f80ed"
}
```

Inspector 使用 color input；颜色变化实时预览，结束编辑后提交撤销历史。

### boolean

用于显隐或开关状态。

```json
{
  "key": "showPanel",
  "label": "显示面板",
  "type": "boolean",
  "defaultValue": true
}
```

Inspector 使用 checkbox；点击后立即提交撤销历史。

### enum

用于规格、状态或模式切换。

```json
{
  "key": "mode",
  "label": "模式",
  "type": "enum",
  "defaultValue": "normal",
  "options": [
    { "value": "normal", "label": "正常" },
    { "value": "warning", "label": "告警" }
  ]
}
```

Inspector 使用 select；切换后立即提交撤销历史。

### vector3

用于位置、旋转、缩放或三轴偏移。

```json
{
  "key": "panelOffset",
  "label": "面板偏移",
  "type": "vector3",
  "defaultValue": { "x": 0, "y": 1, "z": 0 },
  "step": 0.1,
  "unit": "m"
}
```

Inspector 展示 X/Y/Z 三个 number input；修改任一轴时实时预览，blur 或 Enter 后提交撤销历史。

### texture

用于材质贴图切换。

```json
{
  "key": "screenTexture",
  "label": "屏幕贴图",
  "type": "texture",
  "defaultValue": "textures/screen-a.png",
  "options": [
    { "value": "textures/screen-a.png", "label": "屏幕 A" },
    { "value": "textures/screen-b.png", "label": "屏幕 B" }
  ],
  "allowedExtensions": [".png", ".jpg", ".jpeg", ".webp"]
}
```

有 `options` 时 Inspector 使用 select；无 `options` 时使用文本输入。贴图路径必须是模型包内安全相对路径。

## 绑定能力

`bindings` 将参数值应用到 Babylon 运行时目标。

### target

支持三类目标：

```json
{ "kind": "node", "name": "RootNode" }
{ "kind": "mesh", "name": "BodyMesh" }
{ "kind": "material", "name": "BodyMaterial" }
```

### property

支持属性：

- `visible`
- `position`
- `rotation`
- `scaling`
- `baseColor`
- `emissiveColor`
- `alpha`
- `baseTexture`

语义：

- `visible`：控制 mesh 或 node 显隐。
- `position`：设置 TransformNode 位置。
- `rotation`：设置 TransformNode 欧拉旋转。
- `scaling`：设置 TransformNode 缩放。
- `baseColor`：设置 StandardMaterial diffuseColor 或 PBRMaterial albedoColor。
- `emissiveColor`：设置材质自发光颜色。
- `alpha`：设置材质透明度，并 clamp 到 `0-1`。
- `baseTexture`：设置 StandardMaterial diffuseTexture 或 PBRMaterial albedoTexture。

目标不存在、属性不支持或值类型不匹配时跳过该 binding，不影响其他 binding。

## 表达式 DSL

`value` 支持：

- 常量：`1`、`"#ff0000"`、`true`
- 参数引用：`{ "param": "height" }`
- 三轴表达式：`{ "vector3": [1, { "param": "height" }, 1] }`
- 运算表达式：`add`、`sub`、`mul`、`div`、`min`、`max`、`clamp`、`lerp`、`eq`、`neq`、`gt`、`gte`、`lt`、`lte`、`and`、`or`、`not`、`if`

示例：

```json
{
  "target": { "kind": "mesh", "name": "Body" },
  "property": "scaling",
  "value": {
    "vector3": [1, { "param": "height" }, 1]
  }
}
```

表达式递归深度和节点数量必须受限，避免异常配置造成运行时性能问题。

## rules 条件逻辑

`rules` 根据参数条件追加外观设置。

```json
{
  "when": {
    "op": "eq",
    "args": [{ "param": "mode" }, "warning"]
  },
  "set": [
    {
      "target": { "kind": "material", "name": "BodyMaterial" },
      "property": "emissiveColor",
      "value": "#ff3300"
    }
  ]
}
```

运行顺序：

1. 每次应用参数前恢复目标 baseline。
2. 执行基础 `bindings`。
3. 按顺序执行 `when` 为 true 的 `rules.set`。

该顺序避免参数多次变化时产生累积脏状态。

## 数据流

```txt
meta.json.modelParameters
        ↓
Electron modelPackageScanner
        ↓
AssetEntry.parameterConfig
        ↓
createModelEntity()
        ↓
modelAsset.parameterConfig + parameterValues
        ↓
Inspector / ModelParametersInspector
        ↓
editorStore preview / commit
        ↓
SceneRuntime.applyModelParameters()
        ↓
Babylon 节点 / 网格 / 材质实时变化
```

## 持久化

导入模型实体保存：

- `modelAsset.parameterConfig`：从模型包读取并归一化后的参数配置快照。
- `modelAsset.parameterValues`：当前模型实例的参数值。

保存场景时同时保存配置快照和值。加载场景时：

- 配置合法：归一化配置和值。
- 值缺失：使用默认值。
- 值不合法：sanitize 为合法值。
- 配置缺失：按普通模型兼容加载。

## Inspector 交互

选中导入模型后：

- 始终显示 Model Asset 信息。
- 若存在 `parameterConfig`，显示“模型参数”。
- 若不存在参数配置，可以不显示参数表单或显示“该模型没有参数化配置”。

提交策略：

- number/color/vector3：实时 preview，编辑结束合并为一条撤销命令。
- boolean/enum/texture select：立即提交一条撤销命令。
- texture 文本输入：当前可立即提交；后续如体验不佳再改为 blur 提交。

## 安全边界

- 不执行任意 JavaScript。
- 不动态 import 模型包脚本。
- target kind、binding property、表达式 op 全部白名单。
- texture 只允许 `.png`、`.jpg`、`.jpeg`、`.webp` 安全相对路径。
- 拒绝绝对路径、网络 URL、`data:`、反斜杠逃逸和 `../`。
- 配置异常时降级为普通模型，不阻止模型导入。

## 错误处理

- 导入阶段配置不合法：忽略 `parameterConfig`，模型仍可导入。
- 场景加载阶段配置不合法：按普通模型加载。
- 场景加载阶段参数值不合法：使用默认值或 sanitize 后的值。
- Runtime 找不到目标：跳过该 binding。
- Runtime 值类型不匹配：跳过该 binding。
- 贴图加载失败：不应用该贴图，不影响其他参数。

## 验证计划

根据项目偏好，不默认运行完整测试套件。推荐验证：

```bash
npm run typecheck
```

```bash
git diff --check -- src electron README.md docs/superpowers/specs/2026-06-30-imported-model-parameters-design.md
```

静态核对关键词：

- `modelParameters`
- `parameterConfig`
- `parameterValues`
- `ModelParametersInspector`
- `applyModelParameters`

可选手工验证：

1. 准备带 `meta.json.modelParameters` 的模型包。
2. 导入模型文件夹。
3. 点击模型卡片导入场景。
4. 选中模型实体。
5. Inspector 显示“模型参数”。
6. 修改颜色、尺寸、显隐、贴图等参数。
7. Scene View 中模型外观实时变化。
8. 保存并重新加载场景后参数值保留。

## 成功标准

- 带合法 `modelParameters` 的模型包导入后，实体拥有 `parameterConfig` 与默认 `parameterValues`。
- 选中模型后 Inspector 展示参数控件。
- 修改参数后 Scene View 模型外观实时变化。
- 参数修改可撤销/重做。
- 场景保存/加载保留参数配置和值。
- 不合法配置不会导致导入、Inspector 或 SceneRuntime 崩溃。
- README 与实际能力一致。
