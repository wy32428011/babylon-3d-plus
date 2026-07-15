# 模型阵列净间距修复实施计划

> **执行约定：** 当前会话直接实施；遵循现有 `SceneDocument + Zustand + SceneRuntime` 架构，不覆盖工作树中其他未提交改动。

**目标：** 修复模型阵列“间距看起来无效”的问题，使输入值表示相邻阵列组外包围盒之间的实际净距离。

**架构：** Hierarchy 只提交阵列请求；SceneView 使用 Babylon 运行时真实世界包围盒计算选区在目标轴上的尺寸，再由 store 生成可撤销副本。最终仍只把位置写入 `SceneDocument.transform`，不在 Babylon 侧维护额外阵列状态。

**技术栈：** React 19、Zustand、TypeScript、Babylon.js、Playwright CLI。

---

## 根因与验收标准

- 当前公式：`副本偏移 = spacingMeters * copyIndex`，输入值实际是实体根节点距离。
- Playwright 复现：1m 立方体输入 3m，首个副本 `position.x = 3`，边缘净距只有 2m。
- 修复公式：`副本偏移 = (选区在阵列轴上的世界包围盒尺寸 + spacingMeters) * copyIndex`。
- 单选与多选均按整个选区包围盒复制；正负六方向保持对称。
- 若运行时几何尚未准备好，不静默使用错误语义，取消本次阵列并写入可读日志。

## 任务 1：扩展运行时包围盒结果

**修改：** `src/runtime/babylon/SceneRuntime.ts`

- 在 `getEntitiesWorldBounds()` 现有中心点和半径之外返回 `sizeMeters`。
- 尺寸直接由合并后的世界 AABB `maximum - minimum` 得出，继续复用现有 Mesh/Locator/CAD/Model/Light 包围盒读取逻辑。

## 任务 2：建立阵列请求与解析闭环

**修改：** `src/editor/store/editorStore.ts`

- 用 `entityArrayRequest` 保存提交时的实体 ID、数量、方向和净间距，避免解析期间选区变化。
- `requestEntityArray()` 负责校验并发出请求。
- `resolveEntityArrayRequest()` 接收 SceneRuntime 计算的选区轴向尺寸，按“尺寸 + 净间距”生成副本并保持单条撤销历史。
- 新场景/加载场景时清空待处理阵列请求。

**修改：** `src/editor/panels/SceneViewPanel.tsx`

- 监听待处理阵列请求。
- 从 `SceneRuntime.getEntitiesWorldBounds()` 读取目标轴尺寸并回传 store。
- 包围盒不可用或真实模型几何尚未加载时传回失败状态，由 store 清理请求、记录日志且不生成错误位置的副本。

## 任务 3：更新阵列 UI 和文档

**修改：** `src/editor/panels/HierarchyPanel.tsx`

- 提交动作改为发起阵列请求。
- 输入标签明确为“阵列净间距(m)”，避免与根节点步长混淆。

**修改：** `README.md`

- 更新复制/阵列说明，明确间距按相邻模型或多选组世界包围盒边缘计算。
- 在最近完成中记录 2026-07-14 修复。

## 任务 4：验证

- Playwright：1m 立方体 `+X`、2 个副本、净间距 3m，首个副本应为 `X=4`，第二个为 `X=8`。
- Playwright：验证负方向至少一项，确保符号正确。
- 执行 `npm run typecheck`。
- 执行 `git diff --check --` 覆盖本次修改文件。
- 检查最终 diff，确认未覆盖现有 CAD、环境导入、安装包等无关改动。
