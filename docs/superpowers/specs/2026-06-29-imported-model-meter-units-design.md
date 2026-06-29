# Imported Model Meter Units Design

## 背景

编辑器已建立米制场景底座：`1 editor/Babylon scene unit = 1 m`，并在场景文件中写入 `units.length = "meter"`。用户进一步要求导入模型的尺寸也以米为单位。当前模型导入链路会读取模型包中的 `.glb/.gltf` 与 `meta.json`，复制到项目 `Assets/Models`，并通过 `editor-asset://` 在 Babylon 运行时加载。当前导入时没有源单位换算，模型默认 `scale = 1`。

本设计将模型导入升级为：模型包通过 `meta.json.lengthUnit` 声明源模型单位，导入后自动换算到米制场景。

## 目标

- 导入模型最终在编辑器中满足 `1 scene unit = 1 m`。
- 支持模型包通过 `meta.json.lengthUnit` 声明源长度单位。
- 第一版支持 `meter/m`、`centimeter/cm`、`millimeter/mm`。
- 将源单位归一化并计算 `unitScaleToMeters`。
- 将模型单位信息从 Electron 扫描层持久化到项目资产索引，再写入场景模型组件。
- Babylon 运行时加载模型后自动叠加源单位到米的基准缩放。
- 旧模型包、旧资产索引、旧场景文件继续兼容，缺失单位时按米处理。

## 非目标

- 不支持 inch、foot、yard、kilometer 等单位。
- 不从 glTF 内部或模型尺寸特征自动推断单位。
- 不新增用户手动选择单位 UI。
- 不修改用户可见的 Transform.scale 语义；`scale = 1` 仍表示不额外缩放。
- 不修改基础 Cube/Sphere/Plane 的尺寸语义。

## 单位模型

新增模型源单位类型：

```ts
export type ModelSourceLengthUnit = 'meter' | 'centimeter' | 'millimeter';
```

支持输入别名：

| meta.json 值 | 归一化单位 | unitScaleToMeters |
| --- | --- | --- |
| `meter` | `meter` | `1` |
| `m` | `meter` | `1` |
| `centimeter` | `centimeter` | `0.01` |
| `cm` | `centimeter` | `0.01` |
| `millimeter` | `millimeter` | `0.001` |
| `mm` | `millimeter` | `0.001` |

建议放在现有 `src/editor/model/sceneUnits.ts` 中，保证场景单位和模型源单位共享同一套米制基础定义。Electron 主进程不能直接从 `src` 导入，因此需要在 `electron/modelUnits.ts` 中保留同名归一化逻辑，或创建可被 NodeNext 与 renderer 同时引用的 shared 模块。第一版为了最小侵入，可在 Electron 侧新增小模块，并通过类型检查保证常量一致。

## meta.json 约定

模型包可在 `meta.json` 顶层声明：

```json
{
  "lengthUnit": "centimeter"
}
```

也可用简写：

```json
{
  "lengthUnit": "cm"
}
```

处理规则：

- `meta.json` 不存在：按 `meter`。
- `meta.json` 解析失败：沿用当前策略继续导入，按 `meter`。
- `lengthUnit` 缺失：按 `meter`。
- `lengthUnit` 是支持值：归一化并记录换算系数。
- `lengthUnit` 存在但不是字符串或不受支持：跳过该模型包，避免尺寸误读。

## 数据结构

### AssetEntry

Electron、renderer、preload 类型中的 `AssetEntry` 增加：

```ts
lengthUnit?: ModelSourceLengthUnit;
unitScaleToMeters?: number;
```

`lengthUnit` 是归一化后的源单位，不保存别名。`unitScaleToMeters` 是源模型 1 单位换算成米的系数。

### ModelAssetComponent

场景模型组件增加：

```ts
lengthUnit: ModelSourceLengthUnit;
unitScaleToMeters: number;
```

旧场景文件兼容：

- 缺失 `lengthUnit` 时默认 `meter`。
- 缺失 `unitScaleToMeters` 时默认 `1`。
- 如果字段存在但不合法，拒绝加载场景。

## 数据流

1. `ProjectPanel` 调用 `window.editorApi.importModelFolder()`。
2. Electron `modelPackageScanner.ts` 扫描一级模型包并读取 `meta.json`。
3. 从 `meta.json.lengthUnit` 归一化出 `lengthUnit` 和 `unitScaleToMeters`。
4. 扫描出的 `AssetEntry` 携带单位信息。
5. `projectAssetStore.ts` 复制模型包到项目 `Assets/Models` 后重新扫描复制后的包，并将单位字段写入 `.babylon-editor/asset-index.json`。
6. `listProjectAssets()` 读取资产索引时保留单位字段。
7. Renderer `editorStore.importModelAsset()` 创建模型实体时，把单位字段传给 `createModelEntity()`。
8. `SceneDocument` 中的 `modelAsset` 组件保存单位字段。
9. `SceneRuntime.syncModelEntity()` 创建导入模型 root 节点。
10. 运行时应用 Transform 时，对模型 root 使用：

```ts
root.scaling = transform.scale * unitScaleToMeters;
```

基础 Mesh 和灯光仍使用原来的 `applyTransform()`，不叠加模型单位换算。

## Transform.scale 语义

用户在 Inspector 看到和编辑的 `scale` 仍然是编辑器层面的额外缩放比例：

- 源模型是米，`scale = 1` → 运行时缩放 `1`。
- 源模型是厘米，`scale = 1` → 运行时缩放 `0.01`。
- 源模型是毫米，`scale = 1` → 运行时缩放 `0.001`。
- 用户把厘米模型 `scale` 改为 `2` → 运行时缩放 `0.02`。

因此 `scale = 1` 始终表示“不额外缩放”，模型源单位换算是导入基准。

## UI 设计

### Project 模型卡片

模型卡片 title 可加入单位说明：

```text
导入模型：设备A，源单位：centimeter → m
```

无单位字段时显示默认米：

```text
导入模型：设备A，源单位：meter → m
```

### Inspector Model Asset

当选中导入模型实体时，Model Asset 区域显示：

- 模型路径
- `源单位：centimeter`
- `换算到米：×0.01`

如果是旧场景或缺失字段，经反序列化后应显示 `meter` 和 `×1`。

## 错误处理

- `meta.json` 解析失败：不阻塞导入，默认米。
- `lengthUnit` 缺失：默认米。
- `lengthUnit` 非字符串：跳过模型包。
- `lengthUnit` 不受支持：跳过模型包，并在 skipped reason 中说明不支持的值。
- `unitScaleToMeters` 非有限正数：资产索引读取时视为无效，回退或拒绝；场景文件读取时拒绝。
- 异步模型加载失败：沿用当前 `SceneRuntime` 清理 pending model 的逻辑。

## 文档更新

README 需要说明：

- 导入模型最终按米进入场景。
- `meta.json.lengthUnit` 支持 `meter/m`、`centimeter/cm`、`millimeter/mm`。
- 缺失或解析失败时默认 meter。
- 不支持单位会跳过模型包。
- `scale = 1` 表示不额外缩放，源单位换算仍自动生效。

## 验证策略

根据用户要求，不主动运行完整测试。实现后至少运行：

```bash
npm run typecheck
```

并静态核对：

- `cm` 换算为 `0.01`。
- `mm` 换算为 `0.001`。
- `m/meter` 换算为 `1`。
- 缺失单位默认 meter。
- unsupported unit 会进入 skipped。
- `ModelAssetComponent` 保存并反序列化单位字段。
- `SceneRuntime` 只对导入模型 root 叠加 `unitScaleToMeters`，不影响基础 Mesh。
