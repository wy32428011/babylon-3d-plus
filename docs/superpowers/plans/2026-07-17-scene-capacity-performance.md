# 大场景模型容量与渲染稳定性实施计划

日期：2026-07-17

## 步骤

1. 固化模型共享准入策略，保留 Shelf 特殊兼容路径。
2. 新增资产加载并发调度器，并接入普通模型、共享源模型和环境模型加载。
3. 将 SceneRuntime 全量重操作改为实体引用驱动的增量同步，单独处理选择/显隐/锁定展示刷新。
4. 关闭 `preserveDrawingBuffer`，增加 context lost/restored 与 render error/recovered 状态回调。
5. 在 SceneViewPanel 显示运行期渲染异常并在恢复后自动清除。
6. 新增轻量容量 smoke，覆盖静态共享候选、引用计数和加载并发上限。
7. 运行现有 Shelf 共享 smoke，确认参数脚本、选择描边和 thin instance 不回退。
8. 更新 README 与性能说明文档。
9. 执行 typecheck、build、git diff 检查和交叉代码复核。
10. 清理本次启动的 Vite、Node、浏览器和子代理残留进程。

## 验证顺序

1. `npm run smoke:scene-capacity`
2. `npm run smoke:shelf-instancing`
3. `npm run typecheck`
4. `npm run build`
5. `git diff --check`

若任一步失败，停止下游验证，修复后从最小失败项重新开始。
