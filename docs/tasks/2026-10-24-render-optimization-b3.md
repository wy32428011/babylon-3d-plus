# Q1 B3：仅新建场景默认自动选择计算设备

用户明确选择“仅新建场景默认自动”。旧场景缺省仍有效 CPU，既有显式 cpu/gpu/auto 保持，默认质量/采样/seed 和 GI 输入签名不变；本轮独显执行对比暂缓。

验收：

- [x] 新建 `createDefaultEditorLightingConfig → DEFAULT_SCENE_SETTINGS → createDefaultSceneSettings → createEmptySceneDocument` 明确写 `bake.device='auto'`。
- [x] 旧 v1–6 文档缺整组 settings、缺 lighting、缺 device 经实际导入、迁移、保存和重新导入，均保持缺省 CPU，不补 auto。
- [x] 旧 v1–6 中明确 cpu/gpu/auto 的18种组合保持；GLB 标准预览/照明预设继续保留设备选择。
- [x] 新文档 serialize/normalize roundtrip 保留 auto；更改 device 不改变 GI 输入签名。全部其它 bake 默认设置与旧 normalizer 完全相同。
- [x] CPU 标签去掉泛称“默认”；自动选项明确标注“新场景默认”。Chrome 中实际管理器/Store 新建、旧文档载入、显式 GPU 载入、用户选 auto、应用配置和保存序列化通过。
- [x] 聚焦 RED→GREEN、既有 GLB 默认合同和限定 lint/diff 检查通过。
- [x] 根build5 full与manager82/82、bake246/246及相关定向回归通过；不宣称全仓CI或独显验收。
- [ ] 真实独显烘焙耗时/画面和设备选择由用户暂缓，不能把 UI 选择通过当成独显实测。

产品仅两处：

1. `electron/shared/glbStandardPreview.ts:createDefaultEditorLightingConfig` 从旧 normalizer 创建隔离 lighting 对象，仅新建 factory 的 bake 副本增加 device auto。其 IBL、主光、补光、其它默认均保留。
2. `src/editor/panels/LightingBakeManagerOverview.tsx` 标签改为 `CPU`、`自动选择可用设备（新场景默认）`。控件仍使用 `bake.device ?? 'cpu'`，旧缺省在 UI 中继续显示 CPU。

没有修改 `sceneLightingBakeData.ts` 的 legacy 默认/normalizer，没有修改 Python 缺省 CPU 或设备回退。没有改变预设函数。

兼容入口核查：`SceneSerializer.deserializeScene:169` 先调用共享 `migrateSceneLightingDocument`，后者先补 legacy lighting/settings，才进入编辑设置归一化。因此旧文档缺整组 settings 也不会直接使用新建 auto。聚焦测试通过实际 v1–6 入口验证后，确认无需修改 SceneSerializer，避免只根据其孤立的 undefined 分支增加无效修补。

既有 `tests/digitalTwin/glbStandardPreview.test.ts` 原合同“只新增 IBL，其它默认全同”已根据本次用户明确决定调整：device 必须 auto，移除这一字段后全部默认仍与旧 normalizer 深比较相等；IBL、主补光和新对象隔离断言保留，没有删除检查。

证据位于 `output/render-optimization-q1-20261024/b3/`：

- `red.log`：新建仍未写 auto、旧标签仍称 CPU 默认，两项先失败；旧文档和显式选择/预设原合同先通过。
- `green.log`：`node --test tests/editor/lightingBakeNewSceneDevice.test.mjs`，4/4通过。实际调用 createEmptySceneDocument、SceneSerializer、共享迁移/normalizer、签名和预设函数；覆盖18种缺省形态与18种明确设备组合。
- `glb-preview.log`：既有 shared GLB 默认/预设合同5/5通过。
- `ui/report.json`：实际 Chrome 挂载完整生产 LightingBakeManager，使用真实 editorStore 的 resetSceneToBlank/openLightingManager/loadSceneFromContent/应用配置，以及真实 SceneSerializer。新建选择 auto、旧无字段选择 CPU 且保存仍省略、显式 GPU 载入保持 GPU、用户选择 auto 后应用并重读为 auto；page errors=0。
- `ui/new-auto.png`、`ui/old-cpu.png`：真实管理器截图，已打开图像目视确认新选项及布局可见。此浏览器宿主没有 Electron 引擎配置能力，页面对此有现有提示；未发起烘焙任务，不宣称设备发现或实际 GPU 执行。
- `product-freeze-sha256.json`：产品及核心合同冻结哈希。shared factory 为 `8026c07e3f687dd45794e5f22112957e97401a1c4c9515a9d67b0606c26e8455`；UI 为 `c90139bd1f4fa69c93fafbd53142705cd1868fffad984d92fc705c075a9aa859`。

UI 夹具初期的开发宿主依赖问题已修正：关闭对历史 output HTML 的全树依赖发现，仅显式预处理 React/JSX/ReactDOM/Zustand，并将 pageerror 转为立即失败；最终报告来自修正后的完整成功运行。没有为此改变产品配置。专属 Vite/Chrome 已退出。

测试登记建议：默认编辑器检查增加 `tests/editor/lightingBakeNewSceneDevice.test.mjs`；Chrome UI 验证入口为 `node tests/editor/lightingBakeNewSceneDevice.ui.mjs`。该 UI 验证直接使用生产组件、Store 和序列化流程，无需完整应用构建，默认关闭真实烘焙。

本次未改变几何、画质、样本、seed、脚本、MQTT、scene file version 或 SOURCE/DIST 安全规则。没有提交、推送、发布或打包安装器。
