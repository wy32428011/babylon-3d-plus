# 测试分组与覆盖率口径

`npm test` 与 `test:ci` 顺序运行 core：升降动作箭头、digital-twin 单元组、构建分析、开发资源路径、TypeScript 构建恢复、模型参数表达式以及分组 runner 回归。每个原入口保持独立进程与自身并发设置；默认组不代表全仓测试。

`npm run test:integration` 运行 digital-twin 发布集成和升降动作箭头 SOURCE/DIST 场景，保留 Electron 编译前置与 Windows 进程隔离。`npm run test:smoke` 运行完整 scene-capacity 聚合及升降箭头实机路径，内部已有的 editor-performance 不重复安排。

既有入口及命令逐项冻结在 `scripts/test-entry-manifest.json`；P4 保留入场 79 项完整字段，追加 8 个治理/领域入口，共 87 项。`npm run test:entries` 检查名称、命令与分组有效性，遗漏为 0 才通过。清单保留 legacy、build-required、external、manual 分类及逐项原因；分类不是执行证据。真实窗口、安装包、GPU、外部环境和其他兼容入口按需单独运行，不计入 core 通过数。

P4 增加六个定向 Node 契约领域：

| npm 入口 | 原未确认文件数 | 运行方式 |
|---|---:|---|
| `test:contracts:editor` | 22 | 编辑命令、选择/分组、显隐、视口与 UI 数据契约 |
| `test:contracts:effects` | 42 | 图表立标、大屏、告警、特效绑定与材质恢复 |
| `test:contracts:motion` | 19 | MQTT IPC、输送线/RGV/堆垛机表面箭头及同帧驱动结果 |
| `test:contracts:observability` | 14 | 就绪、统计、诊断、帧时间窗口和验收条件 |
| `test:contracts:opening` | 34 | 开场包、分镜、模型入场、区域视角和生命周期 |
| `test:contracts:resources` | 29 | 资源同步/重关联、CAD、环境、发布缓存与项目文件；先 build:electron |

`npm run test:contracts` 顺序运行六领域；160 个原候选对应 159 个独立命令，model-asset-relink runner 与目标测试共用一次原入口。每个文件保留独立 Node 进程；使用 `--experimental-transform-types` 兼容参数属性等非纯擦除语法，原文件中的 Vite SSR/build、模块 hook 和临时 tsc 编译仍由原测试执行。`node scripts/p4-test-domains.mjs effects --list` 只枚举，不执行、不表示通过。失败/取消/超时沿用 test-groups 的真实退出码和本次进程树清理。

`scripts/test-entry-classification.json` 逐文件保留 P4 入场时的 301 项未确认候选：160 项 Node 契约、90 项浏览器/WebGL、30 项 Electron 集成、9 项真实资产要求、6 项性能、4 项 Blender、2 项元数据/治理工具。没有删除、归档或退役候选。每项记录原文件、分类/领域、独立命令、用途、运行前置、源码摘要和证据行。真实 CAD/GLB/EXR、包输出、外部服务、浏览器、Blender、GPU 或性能条件按原脚本要求单独满足；缺少条件、skip 或只枚举不能记为通过。

`node scripts/generate-test-inventory.mjs --json` 输出候选的静态入口集合、分类登记、命令/条件/证据；`--check` 检查 Markdown 漂移，也校验新增/缺失候选、重复登记、分类和领域、源码摘要及证据行。新候选已有明确 npm 入口时计为静态可达；否则必须补逐文件分类。已登记文件变化后先复核运行方式和前置，再更新摘要及证据；不能直接改摘要来掩盖行为改变。

清单同时报告“静态可达”“已分类但需定向执行”“未分类”三种维度；它们都不是执行通过数。fixture/helper 和已核对的治理工具保留在发现范围和独立表中，不计业务测试执行覆盖；原来的 manifest/test-groups 也保留，避免把工具当作遗漏测试。真实 WebGL/FPS、Electron IPC、外部服务与 Node/NullEngine/源码断言分别记录证据，实际通过结果以本次执行记录和日志为准。

`npm run test:coverage` 使用 Node 内置覆盖率，只观察 `src/runtime/babylon/modelParameterExpression.ts`，运行其真实表达式回归。该入口通过 Node strip-types 执行源码；临时 tsc 输出、Electron、浏览器和其他子进程不合并进百分比。覆盖率是观察指标，不能替代业务断言，也不是测试源码的完整类型检查。

runner 每项最多 10 分钟，顺序执行；失败、取消及超时立即停止并返回非零。取消会按已知子进程 PID 清理本次进程树，避免遗留 npm/Node/Electron 子进程。默认 core 在 Windows CI 执行；远端 CI 的结果需要提交后验证。

主 src 和 Electron 编译均开启 `noUnusedLocals`，主 src 保留 `noImplicitOverride` 与 `noFallthroughCasesInSwitch`。`npm run typecheck:quality` 继续对纯表达式模块及其类型依赖额外检查 `noUnusedParameters`；未把该参数规则扩展到全部模块。应用类型检查不等于所有测试源码均已类型检查。

真实外部 EXR 用例遵循原有可选输入契约：设置 `PUBLISH_SKYBOX_REAL_FILE` 为可访问的原始 EXR 后执行 `npm test`。本地验收使用同一原始文件并核对前后 SHA；未提供该业务输入的 CI 不应被描述为已经验证真实外部资源。

固定源码的 headless SSR 入口关闭 watcher 与 WebSocket；相机过渡和 string 参数测试使用实际 SSR build 后导入。它们不验证热更新，产品开发服务器的监听与HMR行为不受这些测试设施配置影响。

## 原生无限远天空与 ENV

- `npm run test:native-skybox`：契约、旧格式迁移、队列共享/取消/会话隔离、源/产物哈希、授权/Junction、缓存租约和运行时状态机。模拟 GPU 用例只证明状态机，不替代下述真实运行。
- `npm run test:native-skybox:webgl`：真实 Chrome/WebGL2 的 HDR→ENV、无限远平移、正交背景、IBL/GI 捕获、A→B→A、失败保留及 context restore。
- `npm run test:native-skybox:ui`：真实 Electron、隔离工程及 profile，操作导入/旋转/分辨率、原图故障与重试、保存重开，并通过真实 preload 导出目录和 ZIP。先 `npm run build:viewer`，入口自身会编译 Electron。
- `npm run test:native-skybox:viewer`：实际生产 Viewer 模板读取 ENV-only 场景，验证请求、交互与像素；先构建 Viewer，不向外部服务发布。
- `npm run test:native-skybox:quality`：同纹理源、分辨率和4096采样的编码A/B；亮暗天空及三种粗糙度金属，误差预算写在脚本内并保持不变。报告里的冷/热条件和首帧仅针对隔离夹具，不代表业务工厂收益。
- `npm run test:native-skybox:exr`：先由已安装 Blender 执行 `tests/fixtures/nativeSkyboxExr.py -- <全新项目内目录>`，再将 `SKYBOX_EXR_FIXTURES` 设为该目录；验证 NONE/RLE/ZIPS/ZIP/PIZ/PXR24 离线编译和提交取消。生成器另核对实际 Cycles 原图、强度与旋转节点，不冒充完整工厂烘焙。

浏览器类入口默认使用本机 Chrome，可通过 `SKYBOX_TEST_BROWSER`（独立 Viewer 为 `CHROME_PATH`）覆盖。可传 `SKYBOX_TEST_URL` 复用已有本机开发服务；未指定时各入口管理自己的临时服务，不关闭其它任务的服务。不要与性能采样、烘焙或其它 GPU 任务并发。历史章节中的入口数量是当时记录，当前登记以生成的 [测试清单](test-inventory.md) 为准。

P2-R0 追加独立入口 npm run test:optimization-p2-r0，覆盖真实 Babylon 计数器的缺失/实际零值、墙钟帧窗口及报告/UI 的空值传播；不纳入默认 core。当前清单在 P4 的 87 项基础上保留 GLB 任务新增 3 项及 R0 新增 1 项，共 91 项。Node/NullEngine 和 JSX 渲染校准不证明硬件 GPU 性能；B0 必须使用已冻结构建、输入和 harness 另行串行采样，细节见 docs/tasks/2026-10-22-project-optimization-p2-r0.md。
