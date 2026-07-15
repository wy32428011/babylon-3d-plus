# Box 模型米制参数化脚本实施计划

**Goal:** 为 `F:\3d-models\models\box` 增加以米输入的长、宽、高参数化脚本，并同步当前项目资产副本。

**Architecture:** 源 GLB 按厘米声明并在内容根节点换算到米；脚本参数按米输入，以默认 `0.32 m × 0.18 m × 0.18 m` 为比例基线调整内容根节点，不污染实体 Transform。

**Tech Stack:** TypeScript、Babylon.js 外置模型脚本、JSON 模型元数据、Electron 模型包扫描器、Markdown。

---

### Task 1: 建立 Box 脚本和元数据

**Files:**
- Create: `F:\3d-models\models\box\box.model.ts`
- Create: `F:\3d-models\models\box\meta.json`

- [x] 声明长度、宽度、高度三个米制参数。
- [x] 保存厘米到米后的内容根缩放与归一化位置基线。
- [x] 按 X=宽、Y=高、Z=长应用绝对比例缩放，并同比补偿 position 保持底部中心锚定。
- [x] 非法尺寸回退默认值，停止时恢复基线。
- [x] 每个类和方法使用中文注释。

### Task 2: 同步当前项目资产副本

**Files:**
- Create: `F:\3d-models\models\Assets\Models\box\box.model.ts`
- Create: `F:\3d-models\models\Assets\Models\box\meta.json`

- [x] 把源包脚本和元数据复制到当前项目资产副本。
- [x] 校验两侧文件 SHA-256 完全一致。

### Task 3: 刷新当前项目资产索引

**Files:**
- Modify: `F:\3d-models\models\.babylon-editor\asset-index.json`

- [x] 只替换 `Assets/Models/box` 的旧索引快照。
- [x] 写入脚本资产、参数元数据、`centimeter / 0.01` 与新 `assetRevision`。
- [x] 保留其它模型和环境资产记录不变。

### Task 4: 更新文档

**Files:**
- Modify: `F:\3d-babylon-editor\README.md`

- [x] 说明 Box 原始 GLB 为厘米坐标，Inspector 参数全部以米输入。
- [x] 记录默认尺寸、轴向映射、索引刷新和源包/资产副本同步要求。
- [x] 追加 2026-07-15 完成记录。

### Task 5: 最小工程验证

- [x] 转译 `box.model.ts` 并检查诊断。
- [x] 构建 Electron 扫描器并扫描两个 Box 包。
- [x] 校验默认尺寸和自定义尺寸的脚本缩放结果。
- [x] 运行 `npm run typecheck`。
- [x] 运行 `npm run build`。
- [x] 对目标仓库文件运行 `git diff --check`。
- [x] 清理本任务临时文件和子代理。

## 完成验证记录

- 外置脚本转译与生命周期校验：通过；默认 `scaling=(0.01,0.01,0.01)`，自定义 2x/1.5x/2x 后为 `(0.02,0.015,0.02)`，缩放与 position 同比补偿后底部中心保持 `(0,0,0)`，非法参数和 `onStop()` 均恢复基线。
- 模型包扫描：源包与 `Assets/Models/box` 副本均识别为 `Box 纸箱`、`centimeter / 0.01`、`box.model.ts` 和 `length/width/height` 三个米制参数。
- 文件一致性：`box.model.ts` SHA-256 为 `469f1d43bc91dd17e8117025c6676bb06ab6914a90e69150277f711c52ad96b0`；`meta.json` 为 `74996498915e7b91d7899e973deef394910ed887503da2d1cb4b061487799b38`；源包与资产副本一致。
- 项目资产索引：只刷新 Box 条目并生成 `assetRevision=mrkyh3k2-698f4479-03a2-47db-97f9-313ba57f642b`；资产总数保持 14，其它条目语义哈希保持 `157bdb7be10be3c68841bdf0b7efdcfaed589e42fccd4822887303f65cadeb63`。
- `npm run typecheck`：通过。
- `npm run build`：通过；renderer、CAD Worker 与 Electron TypeScript 均成功，仅保留既有大 chunk 警告。
- `git diff --check`：通过；仅输出工作区既有 LF/CRLF 转换提示，无空白错误。
- 多智能体复审：初审发现极端尺寸底部偏移 P2；修正 scaling/position 同比补偿后复审通过，未发现 P0/P1/P2。
- 资源清理：已关闭本任务子代理，删除 `output/box-inspection` 和全部 `.tmp-*` / 索引临时文件，未终止无关 Node、Chrome 或 Electron 进程。