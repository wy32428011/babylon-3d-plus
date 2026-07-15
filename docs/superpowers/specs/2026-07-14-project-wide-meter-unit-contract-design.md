# 项目全链路米制单位契约设计

## 背景

项目已经建立 `1 scene unit = 1 m` 的场景底座，普通模型包通过 `lengthUnit + unitScaleToMeters` 转换到米，CAD 几何也会在解析阶段乘以单位系数。然而全链路审计发现两个实质缺口：

1. 环境模型从资产条目转换为 `SceneEnvironmentSettings` 时丢失单位信息，`SceneRuntime.syncEnvironment()` 也没有应用 `unitScaleToMeters`。历史环境模型包若声明厘米或毫米，会被错误地按米渲染。
2. CAD 只识别 `$INSUNITS` 的少量代码（英寸、英尺、毫米、厘米、米、千米），其余合法 DXF 单位会静默回退为毫米；无单位图纸也没有记录判定来源。

此外，内置 Cube、Sphere、Plane 的几何数值事实上已经是米，但只有 Box 的尺寸语义被集中声明，Sphere/Plane 仍散落硬编码。

## 目标

- 项目内部唯一长度存储/运行单位保持为米：`1 scene unit = 1 m`。
- 内置模型、普通导入模型、模型生成器输出、环境模型和 CAD 图纸最终都以米进入 Babylon 场景。
- 普通模型与环境模型保留源单位元数据，运行时只在内容根节点应用一次源单位到米的基准缩放。
- CAD 完整识别 DXF `$INSUNITS` 0–24，并在未声明单位时参考 `$MEASUREMENT`；最终几何坐标仍直接换算为米。
- 单位判定来源可在 Inspector/日志中追溯，避免静默误缩放。
- 旧场景继续按米兼容加载，不提升场景文件版本。

## 非目标

- 不提供全局 m/cm/mm 显示单位切换。
- 不改变 `Transform.position` 的米制语义。
- 不改变 `Transform.scale` 的无量纲语义；Box 的 `size (m)` 仍是 1 米基准几何上的 UI 映射。
- 不自动修改外部 GLB/GLTF/DXF 文件内容。
- 不新增 OBJ 导入能力；当前正式模型包入口仍只支持 GLB/GLTF。
- 不新增导入向导或阻塞式单位确认弹窗。

## 方案比较

### 方案一：所有源文件强制按米解释

实现最少，但毫米/厘米模型和英制 CAD 会出现数量级错误，不可采用。

### 方案二：把单位缩放写进实体 Transform.scale

能让运行时尺寸正确，但会污染用户缩放、Gizmo、复制/阵列和旧场景语义，容易发生重复缩放，不可采用。

### 方案三：米制场景 + 导入边界换算（采用）

场景 Transform 始终保持米制；普通模型、环境模型分别在独立内容根节点应用 `unitScaleToMeters`；CAD 在解析阶段把坐标直接换算为米。源单位信息只作为审计元数据，不进入用户 Transform。

## 架构设计

### 1. 内置模型

扩展 `src/editor/model/builtInMeshGeometry.ts`，集中定义：

- Cube：`1 m × 1 m × 1 m`
- Sphere：基准直径 `1 m`
- Plane：`2 m × 2 m`

`SceneRuntime.createMesh()` 与模型生成器的内置 Mesh 输出共用这些常量，避免同一几何在不同路径出现尺寸漂移。资源卡片与 Inspector 说明使用同一格式化函数。

### 2. 普通模型与模型生成器

继续使用现有 `ModelAssetTemplate.lengthUnit + unitScaleToMeters` 契约：

- 实体根节点保存用户 Transform。
- 内容根节点只保存源单位到米的基准缩放。
- 模型生成器的导入模型目标复用相同模板与运行时缩放。

导入/刷新边界不直接信任外部 `unitScaleToMeters`，而是根据归一化后的 `lengthUnit` 重新得到标准换算系数，避免载荷字段不匹配造成错误缩放。

### 3. 环境模型

`SceneEnvironmentSettings` 增加：

```ts
lengthUnit: ModelSourceLengthUnit;
unitScaleToMeters: number;
```

数据流：

1. `createEnvironmentFromAsset()` 从环境资产读取并规范化单位。
2. `sanitizeSceneEnvironment()` 验证并保存单位；旧数据缺失时默认 `meter / 1`。
3. `SceneSerializer` 保存单位字段，加载旧场景时补齐默认米。
4. `SceneRuntime.syncEnvironment()` 把单位缩放应用在环境根节点上，并把 `sourceUrl + unitScaleToMeters` 作为运行时签名。
5. 缩放后再计算世界包围盒和左侧落地偏移，确保环境定位使用米制尺寸。

直接导入的环境 GLB 仍登记为 `meter / 1`，符合 glTF 的米制线性距离约定；历史环境模型包若携带 cm/mm 元数据则可以正确换算。

### 4. CAD/DXF

新增独立 `src/editor/cad/cadUnits.ts`：

- 完整维护 `$INSUNITS` 0–24 到米的映射。
- `$INSUNITS` 为 0、缺失或未知时读取 `$MEASUREMENT`：英制按 inch，公制按 millimeter。
- 两者都无法判断时保留工业图纸兼容策略：按 millimeter 兜底，但明确标记为 fallback。
- 返回结构化结果：

```ts
{
  sourceUnitCode: number | null;
  sourceUnitName: string;
  unitScaleToMeters: number;
  detection: 'insunits' | 'measurement' | 'fallback';
}
```

`CadReferenceParseResult` 与 `CadReferenceComponent` 保存上述审计字段。普通解析、大文件扫描、Worker、缓存和运行时重解析全部复用同一单位解析器。Inspector 与导入日志展示“源单位 -> 米”和判定来源。

### 5. 兼容性

- 顶层场景文件仍为 `version: 1`、`units.length = "meter"`。
- 旧环境配置缺少单位字段时补齐 `meter / 1`。
- 旧 CAD 组件缺少单位审计字段时，根据既有 `unitScaleToMeters` 生成 `legacy` 兼容说明，不改变已有几何尺寸。
- 普通模型既有 `lengthUnit + unitScaleToMeters` 严格校验保持不变。

## 错误处理

- 不支持或不匹配的模型单位载荷不进入运行时错误缩放；导入边界回到标准单位映射。
- CAD 单位未知不会阻断导入，但必须记录“未声明单位，按毫米兜底”。
- 非有限或非正数单位系数在场景加载时拒绝。
- 环境单位变化即使 URL 不变也必须触发运行时重建。

## 验收标准

- Cube/Sphere/Plane 的运行时创建与模型生成器输出使用同一米制常量。
- 普通模型、模型生成器导入模型和环境模型的 cm/mm 元数据都只在内容根节点应用一次缩放。
- 环境模型旧场景默认 `meter / 1`，新场景保存单位字段。
- CAD `$INSUNITS` 1–24 均有正确米制系数；0/缺失按 `$MEASUREMENT` 或明确 fallback 处理。
- 普通 CAD 与大文件 CAD 得到一致的单位结果。
- Inspector/日志能辨识模型或 CAD 的源单位与换算到米的结果。
- `npm run typecheck`、单位 smoke、`npm run build`、`git diff --check` 通过。
