# POI Moving Double Arrow EFF Implementation Plan

> **For agentic workers:** 按清单逐项实现并在最终交付前完成构建与视觉验证。

**Goal:** 新增可在 POI 库创建并在 Scene 中循环移动的 `>>` 双箭头 EFF。

**Architecture:** 复用统一 `PoiEffectComponent`、预设登记和 `PoiEffectRuntime` 单观察者动画；仅新增稳定 kind、预设项、双箭头 Mesh 构造与动画角色。

**Tech Stack:** TypeScript、React、Babylon.js、Vite、Playwright CLI。

- [x] 扩展 `PoiEffectKind`、`POI_EFFECT_KINDS` 和预设登记。
- [x] 在 `PoiEffectRuntime.createEffect()` 添加 `moving-double-arrow` 分支。
- [x] 用两组折线段构成单个 `>>`，并按 density 创建有限组数。
- [x] 新增 `double-arrow-flow` 动画角色，按 speed 移动并在边缘渐隐。
- [x] 更新 README 与 EFF 设计文档中的数量和列表。
- [x] 执行 typecheck、build、runtime smoke 和实际视觉截图验证。
- [x] 清理本任务启动的 Vite、浏览器和临时验证文件。

## 验证结果

- `npm run build`：通过（`tsc -b`、Vite production build、Electron TypeScript build）。
- NullEngine smoke：16 个预设、POI 卡片、默认 9/最大 18 个合并动画 Mesh、箭头朝本地 `+X`、动画位移和资源释放均通过。
- Playwright 视觉验证：POI 库卡片、Inspector 16 项选择器、Scene 实际渲染通过；固定顶视相机的两个动画帧 SHA-256 不同。
- 代码审查：无阻塞问题；原 49 Mesh 性能风险已通过每组预合并为 3 Mesh 处理。
