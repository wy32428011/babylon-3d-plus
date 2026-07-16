# Scene Camera Drag Ignore Model Picking Implementation Plan

> **For agentic workers:** 按清单完成最小改动、文档同步、交叉审查和运行态验证。

**Goal:** 相机视角只要发生拖拽变化，就不再被鼠标下方模型的点击拾取抢占。

**Architecture:** 在 `SceneViewPanel` 的 pointer 会话中记录相机位姿，并在 pointer move 事件结束后的微任务中读取 Babylon 已累计的相机输入、锁存 `cameraDragged`；pointer up 以该标记优先、位姿变化兜底。模型拾取、Gizmo 和 Runtime 保持原结构。

**Tech Stack:** TypeScript、React、Babylon.js、Vite、Playwright CLI。

- [x] 在 `SceneViewPanel.tsx` 增加相机位姿与待处理输入判定工具，并补齐中文注释。
- [x] pointer down 保存会话快照，pointer move 锁存相机拖拽，pointer up 在拾取前完成双重判定。
- [x] 保留现有 4 px 点击容差、Gizmo 避让和空白清选语义。
- [x] 更新 README 与本设计文档，说明视角拖拽优先于模型拾取。
- [x] 执行 typecheck、build、git diff 检查和 Playwright 行为验证。
- [x] 由独立代理交叉审查，并清理本任务启动的 Vite、Playwright 浏览器及命令进程。

## 验证结果

- `npm run typecheck`：通过。
- `npm run build`：通过；覆盖 TypeScript project build、Vite production build 与 Electron TypeScript build，仅保留既有大 chunk 警告。
- Playwright 行为验证：空白点击清选成功；同帧 `3 px` 微拖拽不选中模型；拖出后回到原坐标仍不选中模型；纯单击模型正常选中。
- 独立代码审查：首轮发现同帧位姿未刷新与净位移回零两个阻塞项；改为微任务读取 Babylon pending input 并锁存 `cameraDragged` 后，复审结论 `LGTM`。
- `git diff --check`：通过。
