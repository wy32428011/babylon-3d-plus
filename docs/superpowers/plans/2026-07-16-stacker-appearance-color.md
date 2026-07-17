# Stacker 模型外观颜色参数化实施计划

**Goal:** 为 Stacker 外置参数化脚本增加实例隔离、可持久化、可实时更新的模型外观颜色参数。

**Architecture:** 使用 `appearanceColor = #ffffff` 作为带纹理 PBR 材质的默认乘色；运行脚本按原材质为每个 Stacker 实例克隆一次并复用，参数变化后更新克隆颜色，停止时恢复原材质并释放克隆。

**Tech Stack:** TypeScript、Babylon.js PBRMaterial、JSON 模型元数据、Vite/Node 烟雾验证、Markdown。

---

### Task 1: 建立颜色回归验证

**Files:**
- Modify: `F:\3d-babylon-editor\scripts\smoke-model-parameter-meters.mjs`

- [x] 为 Stacker 规格增加 `appearanceColor` 自定义值和颜色参数契约。
- [x] 校验 `parameterScripts` 默认值与 `modelParameters.type = color`。
- [x] 校验默认白色、自定义颜色、非法颜色回退、重复更新复用材质、停止后恢复原材质和释放克隆。
- [x] 在同一 Scene 中创建两个共享同一组原材质的 Stacker，校验不同颜色、单侧二次换色和停止单侧实例都不会影响另一实例。
- [x] 在旧实现上过滤运行 Stacker smoke，确认因缺少颜色参数而失败。

### Task 2: 实现 Stacker 外观颜色参数化

**Files:**
- Modify: `F:\3d-models\models\Stacker\stacker.model.ts`
- Modify: `F:\3d-models\models\Stacker\meta.json`

- [x] 参数组件增加 `appearanceColor` 并更新参数说明。
- [x] 默认值增加 `#ffffff`，非法颜色回退默认值。
- [x] 快照保存原材质，运行实例按原材质克隆并复用专属材质。
- [x] 在全部几何参数应用后设置 PBR `albedoColor`，兼容 `diffuseColor`。
- [x] 停止时恢复原材质并释放克隆材质，不强制释放共享纹理。
- [x] 每个新增方法和关键生命周期使用中文注释。
- [x] 更新参数脚本字段、值包装和 `modelParameters` 颜色定义。

### Task 3: 同步模型包副本与可视夹具

**Files:**
- Modify: `F:\3d-models\models\Assets\Models\Stacker\stacker.model.ts`
- Modify: `F:\3d-models\models\Assets\Models\Stacker\meta.json`
- Modify: `F:\3d-babylon-editor\output\playwright\stacker-assets\stacker.model.ts`
- Modify: `F:\3d-babylon-editor\output\playwright\stacker-assets\stacker.model.txt`
- Modify: `F:\3d-babylon-editor\output\playwright\stacker-assets\meta.json`

- [x] 将源包脚本和元数据逐字节复制到当前项目副本。
- [x] 将同一内容同步到可视夹具 TS/TXT/meta。
- [x] 校验全部对应文件 SHA-256 一致。

### Task 4: 刷新演示场景与资产索引

**Files:**
- Modify: `F:\3d-babylon-editor\examples\scenes\stacker-mqtt-demo.scene.json`
- Modify: `F:\3d-models\models\.babylon-editor\asset-index.json`
- Modify: `F:\3d-babylon-editor\scripts\refresh-model-asset-index.mjs`

- [x] 运行 `npm run demo:stacker:scene`，从真实模型包重新生成场景参数元数据。
- [x] 为资产刷新脚本增加 `BABYLON_MODEL_FILTER`，避免无关模型版本被刷新。
- [x] 使用 `$env:BABYLON_MODEL_FILTER='Stacker'; npm run refresh:model-assets` 刷新 Stacker 资产快照和 `assetRevision`。
- [x] 对比刷新前后索引，确认其它 13 个资产条目完全不变。

### Task 5: 更新说明文档

**Files:**
- Modify: `F:\3d-babylon-editor\README.md`
- Create: `F:\3d-babylon-editor\docs\superpowers\specs\2026-07-16-stacker-appearance-color-design.md`
- Create: `F:\3d-babylon-editor\docs\superpowers\plans\2026-07-16-stacker-appearance-color.md`

- [x] 在 Stacker 参数化章节说明颜色参数、默认值、格式、实例隔离和同步边界。
- [x] 明确当前 13 个 PBRMaterial 的支持范围，并记录未来 MultiMaterial 需要扩展 `subMaterials`。
- [x] 在“最近完成”中记录 2026-07-16 的交付。
- [x] 补充本计划的验证证据。

### Task 6: 最小工程验证与交叉复审

- [x] 运行 `$env:BABYLON_MODEL_FILTER='Stacker'; npm run smoke:model-parameters`。
- [x] 运行 `npm run typecheck`。
- [x] 运行 `npm run build`。
- [x] 运行 `git diff --check` 并审阅工作区与外部源包 diff。
- [x] 由独立子代理复审材质生命周期、元数据一致性和文档完整性。
- [x] 关闭子代理并确认没有本任务遗留的 Node、Vite、Chrome 或 shell 进程。

## 完成验证记录

- TDD RED：旧 Stacker 包运行过滤 smoke 时按预期失败，错误为 `Stacker.appearanceColor 缺少 modelParameters 定义`。
- Stacker 目标 smoke：通过；真实 `Stacker.glb` 在默认、旋转、非均匀缩放、旋转叠加缩放四组场景下保持原有几何回归，同时验证默认 `#ffffff`、自定义 `#3366ff`、非法颜色回退、材质克隆复用、停止恢复/释放，以及共享原材质的双实例颜色隔离。
- 外置脚本转译：由目标 smoke 使用真实外置脚本运行链路完成，未出现 TypeScript 转译或生命周期错误。
- 文件一致性：`stacker.model.ts` SHA-256 为 `4774E47F619B93E0CE0267708566622057D0C6BD4FDE33B794C8A24186F60F61`；`meta.json` 为 `79A71ABF339825B719EAF96950E6D1E19B21D5B2A396E5BC9BAF6EAF3BE15CF9`；源包、`Assets/Models/Stacker` 和可视夹具逐字节一致。
- 演示场景：语义对比确认除 Stacker 的 `parameterScriptMetadata`、`animationScriptMetadata` 和 `parameterConfig` 外，其它场景内容未变化；新增颜色参数并同步当前米制标签与单位元数据。
- 项目资产索引：资产总数保持 `14`，其它 13 个条目逐项不变；Stacker 新 `assetRevision` 为 `mrnp1egd-7b1d738e-059e-4a51-ae50-e0865d591b12`，颜色参数已进入索引快照。
- `npm run typecheck`：通过。
- `npm run build`：通过；renderer、Vite 与 Electron TypeScript 均成功，仅保留既有的 Vite 大 chunk 警告。
- `git diff --check`：通过；只输出工作区既有的 LF/CRLF 转换提示，无空白错误。
- 多智能体复审：未发现 P0/P1；提出的非法颜色和双实例 P2 覆盖已补齐，MultiMaterial 作为未来模型升级边界已写入规格与 README。
- 资源清理：已关闭全部子代理，删除 `C:\tmp\stacker-appearance-color-before` 和所有 `.tmp-*` 文件；未发现本任务遗留的 smoke/refresh Node 进程。
