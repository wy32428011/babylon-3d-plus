# 虚拟输送线（Virtual Conveyor）设计文档

## 背景

复杂复合模型常承载多个上报设备（单模型多输送段），需要灵活的拆分手段。虚拟输送线是一种编辑器内置模型：长方形平面，从资源库一键放入 3D 场景，运行时行为与真实 conveyor 完全一致（MQTT 刷货→货物平面内移动→与相邻设备交接），在 Inspector 可配 assetCode、cargoOriginDevice、trajectoryDirection 等全部现有 conveyor 绑定项。

## 方案选型

### 方案 A：内置分发模型包（选定）

随编辑器分发一个极简 conveyor 模型包，首次放置时自动导入项目 `Assets/Models`。运行时/driver 零改动，参数化、绑定 UI、发布导出全复用现有链路。

可行性依据（均已代码验证）：

- `conveyorCapable` 由 `isConveyorModelAsset` 按 assetCode 名称签名判定（specializedModelAssets.ts:21-36），assetCode 含 "conveyor" 即命中 → driver 零改动可用。
- dataDriven 缺失不报错：速度默认 0.3、movement_x、actionMap 均内置兜底（specializedModelAssets.ts:163-225）；surfaceY 缺省回退包围盒顶面（conveyorDriver.ts:1159-1162）；行程回退整机包围盒（:1138-1143）；货物兜底内置 Box（SceneRuntime.ts:4682-4706）。
- Inspector 绑定 UI 门控要求 modelAsset + `dataDrivenConfig.device.devType` 为 specialized（InspectorPanel.tsx:602,648；editorStore.ts:4960-4961）→ 模型包带 .model.ts 声明 devType='conveyor' 即解锁全部绑定 UI（assetCode 覆盖框 TelemetryBindingInspector.tsx:352）。
- 参数化热更新走 parameterConfig/parameterValues + `applyModelAssetParameters`（SceneRuntime.ts:6278-6299）。

### 方案 B：meshRenderer 真内置（未选）

扩展 meshRenderer 新增 belt 类型，放开 collectModels / conveyorCapable / Inspector 门控。不污染项目资产，但需改 8-12 个运行时核心文件（collectModels 需为 meshRenderer 合成 ModelRuntimeEntry，缺 assetHandle/contentRoot 宿主是最大难点），回归风险高。

## 模型包构成

目录 `public/builtin-model-packages/virtual-conveyor/`：

| 文件 | 说明 |
|---|---|
| `virtual-conveyor.glb` | 1×0.05×1 m 扁平长方体，单 mesh 命名 `VCConveyorBelt`（命中 conveyorDriver.ts:1141 兜底正则），一次性脚本生成后提交二进制 |
| `meta.json` | `lengthUnit:"meter"`；`dataDriven:{device:{devType:"conveyor",defaultAssetCode:"VirtualConveyor"},cargo:{travel:{axis:"x",speed:0.3,nodes:[]}}}`；`modelParameters` 声明 length/width/color 三参数 |
| `virtual-conveyor.model.ts` | 参数化脚本：onStart 快照基线 → onUpdate 签名变化时 restoreBaseNodes + 重放（scaleNode 锚定底面拉至 length×0.05×width + 材质乘 color），另写 `contentRoot.metadata.conveyorSurfaceY=0.05` 使货物精确落板顶 |

**可调参数**：length（x 向长度）、width（z 向宽度）、color（材质颜色）。厚度固定 0.05m。

## 分发与自动导入链路

```
内置资源库卡片「虚拟输送线」
  → 点击/拖拽 → ensureVirtualConveyorAsset()
    → projectAssets 按 packagePath 后缀 virtual-conveyor 查重
    → 缺失：IPC assets:importBuiltinModelPackage
        → 定位内置源目录（打包: process.resourcesPath；dev-electron: public/ 回退）
        → scanModelPackage(sourceDir)（modelPackageScanner.ts:610）
        → importModelPackagesIntoProject([entry],'model')（projectAssetStore.ts:1104，同名整包替换）
        → listProjectAssets 刷新
  → importModelAsset(asset, position)（editorStore.ts:3886，撤销重做免费）
```

- 分发：模板放 `public/builtin-model-packages/`，vite dev 直接经 URL 访问；package.json `build.extraResources` 追加打包复制，打包模式经 `process.resourcesPath` 读取。
- 浏览器 dev 模式（无 editorApi）：卡片点击降级为控制台提示需 Electron 环境（与现有模型库行为一致）。
- 导入异常：捕获并提示手动导入模型包，不阻断编辑器。

## assetCode 约定

- `defaultAssetCode: "VirtualConveyor"`（含 "conveyor"，签名必中）。
- 创建实体时 SceneDocument.ts:1396-1399 自动生成含 "conveyor" 的唯一 assetCode 与默认 telemetryBinding。
- 拆分场景下，用户在 Inspector 绑定区把 assetCode 覆盖为真实设备编号（TelemetryBindingInspector.tsx:352），deviceType 只读为 conveyor。

## 与真实 conveyor 的行为差异

| 维度 | 真实 conveyor | 虚拟输送线 |
|---|---|---|
| dataDriven 脚本 | 模型包声明 travel nodes/surfaceOffset 等 | 仅声明 devType/travel.axis/speed，nodes 留空 |
| 行程测量 | 行程节点包围盒 | 整机包围盒兜底（conveyorDriver.ts:1138-1143），随 length 参数缩放 |
| 支撑面 | conveyorSurfaceY 或包围盒顶面 | 脚本写死 0.05（板顶） |
| 货物模板 | cargoGeneratorId/场景默认生成器 | 同一套规则链，无命中兜底内置 Box |
| 本体动画 | 无（仅货物平移） | 同 |

## 升级与维护

- 编辑器升级后包内容更新：`importModelPackagesIntoProject` 同名整包替换（projectAssetStore.ts:1132），重新放置即更新；已建实体经 `refreshModelInstancesFromAssets`（editorStore.ts:3920）刷新。首版不做自动刷新。
- 修改本包 = 修改 conveyor 设备行为，须先同步 `docs/device-runtime-drive-guide.md`。

## 验证矩阵

1. 放置→自动导入→资源库出现该包→Inspector 绑定区解锁（devType=conveyor 识别）
2. 参数 length/width/color 热更新，货物轨迹随长度变化
3. 设 assetCode + cargoOriginDevice，MQTT 刷货端到端
4. 与真实 conveyor 相邻交接（探测邻居纯包围盒判定）
5. 撤销/重做、保存重开场景、发布导出包含该包
6. `npm run typecheck` + 相关测试
