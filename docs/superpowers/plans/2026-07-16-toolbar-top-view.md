# Toolbar Top View Implementation Plan

> **For agentic workers:** 按清单完成最小改动、文档同步、交叉审查和运行态验证。

**Goal:** 在顶部工具栏提供稳定的俯视视角切换，方便依据地面 CAD/DXF 参考图搭建场景。

**Architecture:** 复用现有 Zustand 临时请求链路：Toolbar 只发出请求，SceneViewPanel 持有 BabylonViewport 并消费请求，createEngine 负责 ArcRotateCamera 的安全俯视参数和惯性清理。操作不进入场景持久化或撤销历史。

**Tech Stack:** TypeScript、React、Zustand、Babylon.js、Vite、Electron。

- [x] 在 `createEngine.ts` 增加稳定俯视相机方法，保留 target/radius 并清除输入惯性。
- [x] 在 `editorStore.ts` 增加俯视请求状态、请求动作、消费动作与场景切换清理。
- [x] 在 `SceneViewPanel.tsx` 消费俯视请求并调用 BabylonViewport。
- [x] 在 `EditorLayout.tsx` 和 `Toolbar.tsx` 接通按钮回调，复用图标按钮与 Tooltip 规范。
- [x] 更新 README 和设计文档，说明 CAD 建模俯视操作及运行态语义。
- [x] 执行 typecheck、build、git diff 检查和最小运行态验证。
- [x] 由独立代理交叉审查，并清理本任务启动的相关进程。

## 验证结果

- `npm run typecheck`：通过。
- `npm run build`：通过；覆盖 TypeScript project build、Vite production build 与 Electron TypeScript build，仅保留既有大 chunk 警告。
- Playwright 可访问性快照：Toolbar 出现可用按钮 `切换为俯视视角`，图标为 `俯`；点击后 Console 最新日志为 `已切换为俯视视角。`。
- Babylon 运行态断言：相机从 `alpha=1.2 / beta=1.1 / radius=42 / target=(4,2,-3)` 切换到 `alpha=-π/2 / beta=0.01`，radius 与 target 保持不变，旋转、平移和缩放惯性及累计输入全部归零。
- 独立代码审查：结论 `LGTM / APPROVE`，无 Critical 或 Important 项；README 标点与计划状态两个 Minor 项已修正。
- 资源回收：Playwright 会话列表为空，Vite 验证端口 `4173` 已释放，一次性辅助脚本已删除。
