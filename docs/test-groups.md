# 测试分组与覆盖率口径

`npm test` 与 `test:ci` 顺序运行 core：digital-twin 单元组、构建分析、开发资源路径、TypeScript 构建恢复、模型参数表达式以及分组 runner 回归。每个原入口保持独立进程与自身并发设置；默认组不代表全仓测试。

`npm run test:integration` 运行 digital-twin 发布集成，保留 Electron 编译前置与 Windows 进程隔离。`npm run test:smoke` 运行完整 scene-capacity 聚合，内部已有的 editor-performance 不重复安排。

既有入口及命令逐项冻结在 `scripts/test-entry-manifest.json`。`npm run test:entries` 检查名称、命令与分组有效性，遗漏为 0 才通过。清单保留 legacy、build-required、external、manual 分类及逐项原因；分类不是执行证据。真实窗口、安装包、GPU、外部环境和其他兼容入口按需单独运行，不计入 core 通过数。

`node scripts/generate-test-inventory.mjs --json` 输出每个候选的静态入口集合和未确认原因；`--check` 继续检查 Markdown 清单漂移。未知候选保留在清单中，不因新增分组消失，也不会自动 glob 执行。静态可达不代表通过，fixture/helper 不计执行覆盖。

`npm run test:coverage` 使用 Node 内置覆盖率，只观察 `src/runtime/babylon/modelParameterExpression.ts`，运行其真实表达式回归。该入口通过 Node strip-types 执行源码；临时 tsc 输出、Electron、浏览器和其他子进程不合并进百分比。覆盖率是观察指标，不能替代业务断言，也不是测试源码的完整类型检查。

runner 每项最多 10 分钟，顺序执行；失败、取消及超时立即停止并返回非零。取消会按已知子进程 PID 清理本次进程树，避免遗留 npm/Node/Electron 子进程。默认 core 在 Windows CI 执行；远端 CI 的结果需要提交后验证。

主src已开启 `noImplicitOverride` 与 `noFallthroughCasesInSwitch`；`npm run typecheck:quality` 另对新纯表达式模块及其类型依赖开启 unused 检查，未将旧模块一并强改。应用类型检查不等于所有测试源码均已类型检查。

真实外部 EXR 用例遵循原有可选输入契约：设置 `PUBLISH_SKYBOX_REAL_FILE` 为可访问的原始 EXR 后执行 `npm test`。本地验收使用同一原始文件并核对前后 SHA；未提供该业务输入的 CI 不应被描述为已经验证真实外部资源。

固定源码的 headless SSR 入口关闭 watcher 与 WebSocket；相机过渡和 string 参数测试使用实际 SSR build 后导入。它们不验证热更新，产品开发服务器的监听与HMR行为不受这些测试设施配置影响。
